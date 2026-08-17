/**
 * Minimal stderr logger. stdout is reserved exclusively for the single
 * structured JSON result (design §19.1). Never logs full content, cookies
 * or unredacted URLs.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

let currentLevel: LogLevel = "warn";
let currentRunId = "-";

export function initLogger(level: LogLevel, runId: string): void {
  currentLevel = level;
  currentRunId = runId;
}

function emit(level: LogLevel, msg: string): void {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  process.stderr.write(
    `[vwr] ${new Date().toISOString()} ${level} run=${currentRunId} ${msg}\n`,
  );
}

export const log = {
  error: (msg: string) => emit("error", msg),
  warn: (msg: string) => emit("warn", msg),
  info: (msg: string) => emit("info", msg),
  debug: (msg: string) => emit("debug", msg),
};

const SENSITIVE_QUERY_KEYS =
  /^(token|key|secret|auth|authorization|signature|sig|share_code|session|cookie|passwd|password|access_token|api_key|credential|x-amz-credential|x-amz-signature)$/i;
const SENSITIVE_PREFIX = /^utm_/i;

/** Redact sensitive query parameter values while keeping URL shape readable. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let changed = false;
    for (const [k] of u.searchParams) {
      if (SENSITIVE_QUERY_KEYS.test(k) || SENSITIVE_PREFIX.test(k)) {
        u.searchParams.set(k, "REDACTED");
        changed = true;
      }
    }
    void changed;
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    if (u.hash) u.hash = "#REDACTED";
    return u.toString();
  } catch {
    return "<unparseable-url>";
  }
}

/** Redact URLs and bound audit text before echoing it in structured output. */
export function sanitizeAuditText(raw: string, maxChars = 1000): string {
  const withoutControls = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const redacted = withoutControls.replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactUrl(url));
  return redacted.slice(0, maxChars);
}
