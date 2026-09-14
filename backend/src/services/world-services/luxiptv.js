/**
 * Lux IPTV — free 24-hour trial through the site's Tawk.to chat widget.
 *
 * The public site does not expose a trial form. Its widget registers a visitor
 * with Tawk, submits the pre-chat email, and the Lux support bot sends the
 * trial credentials by email.
 */
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { createJar, cookieStr, jsonPost } from "../../http/cookieClient.js";
import { buildResult } from "../../parsing/generators.js";

const PROPERTY_ID = "64ac15e694cf5d49dc62ab13";
const WIDGET_ID = "1h503b42e";
const PAGE_URL = "https://lux-iptv.tv/";
const SESSION_URL = "https://va.tawk.to/v1/session/start";
const PRECHAT_URL = "https://va.tawk.to/v1/visitor/prechat-form";
const MESSAGE_URL = "https://va.tawk.to/v1/message/visitor";
const TAG = "Lux IPTV";
const TRIAL_HOURS = 24;
const IDEMPOTENCY_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";
const SOCKET_OPTIONS = {
  Origin: new URL(PAGE_URL).origin,
  Referer: PAGE_URL,
  "User-Agent": "Mozilla/5.0",
};

function createVisitorKey() {
  const bytes = randomBytes(21);
  return [...bytes]
    .map((byte) => IDEMPOTENCY_ALPHABET[byte % IDEMPOTENCY_ALPHABET.length])
    .join("");
}

function errorDetail(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    if (typeof error.code === "string") return error.code;
    return JSON.stringify(error);
  }
  return String(error ?? "unknown error");
}

function sendSocketFrame(session, frame, label) {
  const url = `wss://${session.vss}/s/?k=${session.sk}&cver=4&pop=false&asver=0&tkn=${encodeURIComponent(session.tkn)}&transport=websocket`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { ...SOCKET_OPTIONS, Cookie: cookieStr(session.jar) },
    });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`[${TAG}] ${label} timed out.`));
    }, 30_000);

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`[${TAG}] ${label} failed: ${errorDetail(error)}`));
    });
    socket.on("message", (data) => {
      const text = data.toString();
      if (!text.startsWith("4")) return;
      let frame;
      try {
        frame = JSON.parse(text.slice(1));
      } catch {
        return;
      }
      if (frame.c !== "__callback__") return;
      clearTimeout(timeout);
      socket.close();
      if (frame.p?.[0])
        return reject(
          new Error(`[${TAG}] ${label} rejected: ${errorDetail(frame.p[0])}`),
        );
      const result = frame.p?.[1];
      if (result?.ok === false)
        return reject(
          new Error(`[${TAG}] ${label} rejected: ${errorDetail(result.error)}`),
        );
      resolve(result);
    });
    socket.on("open", () => socket.send(`4${JSON.stringify(frame)}`));
  });
}

function socketService(session, service, route, payload) {
  return sendSocketFrame(
    session,
    { c: "service", cb: 1, p: [service, route, payload] },
    `Tawk ${route}`,
  );
}

function endChat(session) {
  return sendSocketFrame(
    session,
    { c: "endChat", cb: 1, p: [] },
    "Tawk end-chat",
  );
}

async function startSession() {
  const jar = createJar();
  const data = await jsonPost(
    SESSION_URL,
    jar,
    {
      p: PROPERTY_ID,
      w: WIDGET_ID,
      platform: "desktop",
      tzo: new Date().getTimezoneOffset(),
      url: PAGE_URL,
      // Without a stored UUID, Tawk uses uik to issue a new visitor identity.
      // A new key prevents the session from inheriting an older transcript.
      uik: createVisitorKey(),
      consent: false,
      wss: "min",
      uv: 3,
    },
    {
      referer: PAGE_URL,
      origin: "https://lux-iptv.tv",
      throwOnError: false,
      timeout: 30_000,
    },
  );

  if (data?.ok === false)
    throw new Error(
      `[${TAG}] Tawk session rejected: ${errorDetail(data.error)}`,
    );

  const session = data?.data;
  if (!session?.sk || !session?.vid || !session?.n)
    throw new Error(`[${TAG}] Tawk session was not created.`);
  return { ...session, jar };
}

async function startFreshSession() {
  const oldSession = await startSession();
  await endChat(oldSession);
  return startSession();
}

async function submitChat(session, email) {
  const address = email.trim();
  await socketService(session, "visitor-chat", PRECHAT_URL, { email: address });
  await socketService(session, "visitor-chat", MESSAGE_URL, {
    message: address,
  });
}

export default {
  meta: {
    id: "luxiptv",
    name: TAG,
    description: `${TRIAL_HOURS} Hours`,
  },

  async execute({
    provider,
    credentialStore,
    email,
    inboxSeenIds = new Set(),
    log = () => {},
  }) {
    log(`[${TAG}] Starting Tawk chat for ${email}...`);
    const session = await startFreshSession();
    await submitChat(session, email);
    log(`[${TAG}] Trial request submitted. Waiting for credentials email...`);

    let playlists;
    try {
      playlists = await provider.waitForEmailAndExtractPlaylists(
        credentialStore,
        {
          filterText: "lux",
          seenIds: new Set(inboxSeenIds),
          timeout: 180_000,
        },
      );
    } finally {
      await endChat(session);
    }

    if (!playlists.allM3uLinks.length)
      log(`[${TAG}] No M3U links found in confirmation email.`, "warn");

    return buildResult({
      playlists,
      trialHours: TRIAL_HOURS,
      serviceName: TAG,
    });
  },
};
