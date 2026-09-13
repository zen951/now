/**
 * apiClient.js
 *
 * Generic JSON API fetch helper for REST-API-based email providers.
 *
 * Exports:
 *   makeApi(baseUrl, defaultOpts?) — returns a fetch helper bound to baseUrl
 */

const DEFAULT_UA =
  "Mozilla/5.0 (compatible; Node.js; +https://nodejs.org/)";

// Fetches a JSON endpoint. Injects a token when provided,
// throws on non-2xx, and returns null on 204 No Content.
async function apiFetch(baseUrl, path, opts = {}) {
  const {
    method = "GET",
    token = null,
    body = null,
    errorDetail = null,
  } = opts;

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": DEFAULT_UA,
    "Accept": "application/json, */*",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Cache-Control": "no-cache",
    "Origin": "https://api.mail.tm",
    "Referer": "https://api.mail.tm/",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const fullUrl = `${baseUrl}${path}`;
  console.log(`[apiClient] ${method} ${fullUrl}`);
  
  const res = await fetch(fullUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    timeout: 10000,
  });

  if (!res.ok) {
    // Try to extract a human-readable error message from the response body.
    let detail = "";
    try {
      const j = await res.json();
      detail = errorDetail?.(j) ?? j.message ?? JSON.stringify(j);
    } catch (_) {}
    const errorMsg = `[apiClient] ${method} ${baseUrl}${path} → ${res.status}${detail ? `: ${detail}` : ""}`;
    console.error("API Error Details:", { status: res.status, detail });
    throw new Error(errorMsg);
  }

  return res.status === 204 ? null : res.json();
}

// Returns a fetch helper pre-bound to baseUrl.
// defaultOpts sets call-wide defaults (e.g. a custom errorDetail for Hydra responses).
export function makeApi(baseUrl, defaultOpts = {}) {
  return (path, callOpts) =>
    apiFetch(baseUrl, path, { ...defaultOpts, ...callOpts });
}
