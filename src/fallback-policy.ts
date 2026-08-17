/**
 * Executable Skill fallback rules (design §7 / §15 / §20.3).
 * The CLI never calls this; it exists so the Skill decision table can be
 * unit-tested with mocked web_fetch outcomes.
 */

import type { ReadStatus } from "./types.js";

export interface FetchOutcome {
  requestedUrl: string;
  ok: boolean;
  httpStatus?: number;
  error?: string;
  finalUrl?: string;
  title?: string;
  text?: string;
  hasJsShellHint?: boolean;
  hasExpandHint?: boolean;
  truncated?: boolean;
  contentIdMissing?: boolean;
  identityMismatch?: boolean;
  clientRendered?: boolean;
}

export interface FallbackDecision {
  callCli: boolean;
  skipWebFetch: boolean;
  reason: string | null;
}

const HARD_HTTP = new Set([401, 403, 407, 429, 451]);

export function decideFallback(input: {
  userRequestedBrowser: boolean;
  fetch: FetchOutcome | null;
}): FallbackDecision {
  if (input.userRequestedBrowser) {
    return { callCli: true, skipWebFetch: true, reason: "user_requested" };
  }
  const fetch = input.fetch;
  if (!fetch) {
    return { callCli: false, skipWebFetch: false, reason: null };
  }
  if (!fetch.ok || (fetch.httpStatus !== undefined && HARD_HTTP.has(fetch.httpStatus))) {
    return { callCli: true, skipWebFetch: false, reason: fetch.error ?? `http_${fetch.httpStatus}` };
  }
  if (fetch.httpStatus !== undefined && fetch.httpStatus >= 400) {
    return { callCli: true, skipWebFetch: false, reason: `http_${fetch.httpStatus}` };
  }
  if (fetch.hasJsShellHint) {
    return { callCli: true, skipWebFetch: false, reason: "js_shell" };
  }
  if (fetch.truncated || fetch.hasExpandHint) {
    return { callCli: true, skipWebFetch: false, reason: "truncated" };
  }
  if (fetch.contentIdMissing || fetch.identityMismatch) {
    return { callCli: true, skipWebFetch: false, reason: "content_mismatch" };
  }
  if (fetch.clientRendered) {
    return { callCli: true, skipWebFetch: false, reason: "client_rendered" };
  }
  const text = fetch.text ?? "";
  if (text.trim().length < 80) {
    return { callCli: true, skipWebFetch: false, reason: "too_short" };
  }
  return { callCli: false, skipWebFetch: false, reason: null };
}

export function shouldRetry(status: ReadStatus, attempt: number): boolean {
  if (attempt >= 1) return false;
  return status === "navigation_failed" || status === "browser_unavailable";
}

export function mayClaimFullOriginal(status: ReadStatus): boolean {
  return status === "browser_verified";
}

export function mayUseSearchAsOriginal(): boolean {
  return false;
}
