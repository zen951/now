/**
 * Lux IPTV — free 24-hour trial through the site's Tawk.to chat widget.
 *
 * The public site does not expose a trial form. Its widget registers a visitor
 * with Tawk, submits the pre-chat email, and the Lux support bot sends the
 * trial credentials by email.
 *
 * Uses wreq-js (Rust/BoringSSL) to impersonate Chrome's TLS + HTTP/2
 * fingerprint, bypassing Cloudflare's JA3/JA4 bot detection that blocks
 * plain Node.js fetch on cloud/serverless deployments.
 */
import { buildResult, computeExpiresAt } from "../../parsing/generators.js";
import { createJar, cookieStr } from "../../http/cookieClient.js";
import { fetch as wreqFetch, WebSocket as WreqWebSocket } from "wreq-js";
import { randomBytes } from "node:crypto";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── HTTP: Chrome-fingerprinted POST via wreq-js ───────────────────────────────

async function tawkPost(url, jar, body) {
  const res = await wreqFetch(url, {
    method: "POST",
    browser: "chrome_124",
    os: "windows",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, */*;q=0.8",
      Cookie: cookieStr(jar),
      Origin: new URL(PAGE_URL).origin,
      Referer: PAGE_URL,
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    body: JSON.stringify(body),
    timeout: 30_000,
  });

  // Harvest cookies
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  const text = await res.text();
  try {
    return { data: JSON.parse(text), status: res.status };
  } catch {
    return { data: {}, status: res.status, raw: text.slice(0, 200) };
  }
}

// ── WebSocket: Chrome-fingerprinted via wreq-js ───────────────────────────────

function makeWsUrl(session) {
  return `wss://${session.vss}/s/?k=${session.sk}&cver=4&pop=false&asver=0&tkn=${encodeURIComponent(session.tkn)}&transport=websocket`;
}

function makeWsOptions(session) {
  return {
    browser: "chrome_124",
    os: "windows",
    headers: {
      Origin: new URL(PAGE_URL).origin,
      Referer: PAGE_URL,
      Cookie: cookieStr(session.jar),
    },
  };
}

function socketService(session, service, route, payload) {
  return new Promise((resolve, reject) => {
    const socket = new WreqWebSocket(
      makeWsUrl(session),
      makeWsOptions(session),
    );

    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`[${TAG}] Tawk socket request timed out.`));
    }, 30_000);

    socket.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `[${TAG}] Tawk socket connection failed: ${errorDetail(event.message ?? event)}`,
        ),
      );
    });

    socket.addEventListener("message", (event) => {
      const text =
        typeof event.data === "string"
          ? event.data
          : (event.data?.toString?.() ?? "");
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
      if (frame.p?.[0]) {
        reject(
          new Error(
            `[${TAG}] Tawk ${route} rejected: ${errorDetail(frame.p[0])}`,
          ),
        );
        return;
      }
      const result = frame.p?.[1];
      if (result?.ok === false)
        reject(
          new Error(
            `[${TAG}] Tawk ${route} rejected: ${errorDetail(result.error)}`,
          ),
        );
      else resolve(result);
    });

    socket.addEventListener("open", () => {
      // Tawk uses socket.io wire framing: message type "4" prefix
      socket.send(
        `4${JSON.stringify({ c: "service", cb: 1, p: [service, route, payload] })}`,
      );
    });
  });
}

function endChat(session) {
  return new Promise((resolve, reject) => {
    const socket = new WreqWebSocket(
      makeWsUrl(session),
      makeWsOptions(session),
    );

    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`[${TAG}] Tawk end-chat request timed out.`));
    }, 30_000);

    socket.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `[${TAG}] Tawk end-chat failed: ${errorDetail(event.message ?? event)}`,
        ),
      );
    });

    socket.addEventListener("open", () => {
      // Tawk uses socket.io wire framing: message type "4" prefix
      socket.send(`4${JSON.stringify({ c: "endChat", cb: 1, p: [] })}`);
    });

    socket.addEventListener("message", (event) => {
      const text =
        typeof event.data === "string"
          ? event.data
          : (event.data?.toString?.() ?? "");
      if (!text.startsWith("4")) return;
      let frame;
      try {
        frame = JSON.parse(text.slice(1));
      } catch {
        return;
      }
      if (frame.c !== "__callback__" || frame.cb !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (frame.p?.[0])
        reject(
          new Error(
            `[${TAG}] Tawk end-chat rejected: ${errorDetail(frame.p[0])}`,
          ),
        );
      else resolve(frame.p?.[1] ?? null);
    });
  });
}

// ── Session management ────────────────────────────────────────────────────────

async function startSession() {
  const jar = createJar();
  const { data, status, raw } = await tawkPost(SESSION_URL, jar, {
    p: PROPERTY_ID,
    w: WIDGET_ID,
    platform: "desktop",
    tzo: new Date().getTimezoneOffset(),
    url: PAGE_URL,
    uik: createVisitorKey(),
    consent: false,
    wss: "min",
    uv: 3,
  });

  if (data?.ok === false)
    throw new Error(
      `[${TAG}] Tawk session rejected (HTTP ${status}): ${errorDetail(data.error)}`,
    );

  const session = data?.data;
  if (!session?.sk || !session?.vid || !session?.n)
    throw new Error(
      `[${TAG}] Tawk session was not created (HTTP ${status}). ` +
        `Response: ${raw ?? JSON.stringify(data).slice(0, 300)}`,
    );

  return { ...session, jar };
}

async function startFreshSession() {
  const previousSession = await startSession();
  await endChat(previousSession);
  const session = await startSession();
  if (!session.n)
    throw new Error(
      `[${TAG}] Tawk did not return a conversation for the new visitor.`,
    );
  return session;
}

async function submitChat(session, email) {
  await socketService(session, "visitor-chat", PRECHAT_URL, {
    email: email.trim(),
  });
  await socketService(session, "visitor-chat", MESSAGE_URL, {
    message: email.trim(),
  });
}

// ── Service export ────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "luxiptv",
    name: `${TAG} [Local Host]`,
    description: `${TRIAL_HOURS} Hours`,
  },

  async execute({
    provider,
    credentialStore,
    email,
    inboxSeenIds = new Set(),
    log = () => {},
  }) {
    log(`[${TAG}] 💬 Starting Tawk chat for ${email}...`);
    const session = await startFreshSession();
    await submitChat(session, email);
    log(
      `[${TAG}] ✅ Trial request submitted. 📩 Waiting for credentials email...`,
    );

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
      log(`[${TAG}] ⚠️ No M3U links found in confirmation email.`, "warn");

    return buildResult({
      playlists,
      trialHours: TRIAL_HOURS,
      duration: `${TRIAL_HOURS} Hours`,
      expiresAt: computeExpiresAt(TRIAL_HOURS * 3_600_000, {
        timeZone: "Asia/Jerusalem",
      }),
      serviceName: TAG,
    });
  },
};
