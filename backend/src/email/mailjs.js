/**
 * Mailjs disposable email provider.
 *
 * Mailjs is a JavaScript wrapper around the Mail.tm API. It creates and
 * authenticates an account, then exposes the inbox through the same reader
 * contract used by the other API-based providers.
 */
import Mailjs from "@cemalgnlts/mailjs";
import logger from "../logger.js";
import { makeGetReader, createProviderMethods } from "./base.js";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = "https://mail.tm";
const TAG = "Mailjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Unwrap a Mailjs result and surface API failures consistently.
const unwrap = (response, operation) => {
  if (!response?.status)
    throw new Error(
      `[${TAG}] ${operation} failed: ${response?.message ?? "Unknown error"}`,
    );
  return response.data ?? {};
};

const toText = (value) =>
  Array.isArray(value)
    ? value.join("\n")
    : value && typeof value === "object"
      ? Object.values(value).join("\n")
      : String(value ?? "");

// Mailjs wraps Mail.tm responses as { status, data }; normalize message
// collections because different API versions may return an array or Hydra data.
function buildReader(mailjs) {
  return {
    async fetchMessages() {
      const data = unwrap(await mailjs.getMessages(1), "Fetching messages");
      const messages = Array.isArray(data)
        ? data
        : (data["hydra:member"] ?? data.messages ?? []);

      return (Array.isArray(messages) ? messages : []).map(
        ({ id, from, to, subject, intro, text, message }) => ({
          id,
          preview: [
            from?.name ?? "",
            from?.address ?? "",
            to?.name ?? "",
            to?.address ?? "",
            subject ?? "",
            intro ?? "",
            text ?? "",
            message ?? "",
          ]
            .join(" ")
            .trim(),
        }),
      );
    },

    async readMessage(id) {
      const message = unwrap(
        await mailjs.getMessage(id),
        `Reading message ${id}`,
      );
      return [
        message.text,
        message.html,
        message.message,
        message.body,
        message.subject,
      ]
        .map(toText)
        .filter(Boolean)
        .join("\n");
    },
  };
}

const getReader = makeGetReader("_mailjsClient", TAG, buildReader);

// ── Provider ──────────────────────────────────────────────────────────────────

export default {
  meta: {
    id: "mailjs",
    name: "Mailjs",
    url: BASE_URL,
    description: "@mail.tm via @cemalgnlts/mailjs",
    apiOnly: true,
  },

  async createEmail(store) {
    logger.info(`[${TAG}] Creating a temporary Mail.tm account...`);
    const mailjs = new Mailjs();
    const account = unwrap(
      await mailjs.createOneAccount(),
      "Creating temporary account",
    );

    if (!account.username)
      throw new Error(`[${TAG}] Account response did not include an address.`);

    store._mailjsClient = mailjs;
    logger.info(`[${TAG}] Email ready: ${account.username}`);
    return account.username;
  },

  ...createProviderMethods(TAG, getReader, { pollDelay: 1000, readDelay: 300 }),
};
