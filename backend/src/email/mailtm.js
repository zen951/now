/**
 * Mail.tm disposable email provider.
 *
 * Uses the public REST API directly instead of the mailjs npm wrapper.
 * Account creation and message polling are handled with the standard
 * Authorization: Bearer <token> flow used by Mail.tm.
 */
import logger from "../logger.js";
import { generatePassword, generateUsername } from "../parsing/generators.js";
import { makeApi } from "../http/apiClient.js";
import { makeGetReader, createProviderMethods } from "./base.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_URL = "https://api.mail.tm";
const BASE_URL = "https://mail.tm/en/";
const TAG = "MailTm";
const api = makeApi(API_URL);

// ── Helpers ───────────────────────────────────────────────────────────────────

const flatten = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(" ");
  if (typeof value === "object")
    return Object.values(value).map(flatten).filter(Boolean).join(" ");
  return String(value);
};

const extractItems = (payload) => {
  if (Array.isArray(payload)) return payload;
  const hydraMember =
    payload?.["hydra:member"] ??
    payload?.member ??
    payload?.messages ??
    payload?.results ??
    [];
  return Array.isArray(hydraMember) ? hydraMember : [];
};

function buildReader(credentials) {
  const token = credentials?.token;

  return {
    async fetchMessages() {
      const data = await api("/messages", { token });
      const messages = extractItems(data);

      return messages.map((message, index) => ({
        id: message?.id ?? message?.["@id"] ?? String(index),
        preview: [
          flatten(message?.from),
          flatten(message?.to),
          message?.subject ?? "",
          message?.intro ?? "",
          message?.text ?? "",
          message?.html ?? "",
        ]
          .join(" ")
          .trim(),
      }));
    },

    async readMessage(id) {
      const message = await api(`/messages/${encodeURIComponent(id)}`, {
        token,
      });
      return [
        message?.text,
        message?.html,
        message?.body,
        message?.intro,
        message?.subject,
      ]
        .map(flatten)
        .filter(Boolean)
        .join("\n");
    },
  };
}

const getReader = makeGetReader("_mailtmCredentials", TAG, buildReader);

// ── Provider ──────────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "mailtm",
    name: "Mail.tm",
    url: BASE_URL,
    description: "Mail.tm direct API (not via @cemalgnlts/mailjs)",
    apiOnly: true,
  },

  async createEmail(store) {
    logger.info(`[${TAG}] Fetching Mail.tm domains...`);
    const domainsPayload = await api("/domains");
    const domains = extractItems(domainsPayload)
      .map((item) => item?.domain ?? item)
      .filter(Boolean);

    const domain =
      domains[Math.floor(Math.random() * domains.length)] ?? "uberip.com";

    const username = generateUsername();
    const password = generatePassword();
    const address = `${username}@${domain}`;

    logger.info(`[${TAG}] Creating mailbox for ${address}...`);
    await api("/accounts", {
      method: "POST",
      body: { address, password },
    });

    const auth = await api("/token", {
      method: "POST",
      body: { address, password },
    });
    const token = auth?.token;

    if (!token) {
      throw new Error(`[${TAG}] Account created but no token was returned.`);
    }

    store._mailtmCredentials = { address, token };
    logger.info(`[${TAG}] Email ready: ${address}`);
    return address;
  },

  ...createProviderMethods(TAG, getReader, { pollDelay: 1000, readDelay: 300 }),
};
