/**
 * Configuration via environment variables. All values have passive-friendly
 * defaults: nothing here enables listeners, daemons or polling.
 */

export type BrowserBackend = "openclaw" | "cdp";

export interface Config {
  backend: BrowserBackend;
  /** OpenClaw executable used with execFile (argv arrays, never a shell). */
  openclawBin: string;
  /** Dedicated browser profile, isolated from the user's personal browser. */
  browserProfile: string;
  /** CDP HTTP endpoint. Must stay on loopback / private tunnel (design §10.2). */
  cdpUrl: string;
  stopBrowserIfStarted: boolean;
  keepBrowserTab: boolean;
  inlineContentChars: number;
  chunkChars: number;
  maxContentChars: number;
  defaultMaxWaitMs: number;
  browserCommandTimeoutMs: number;
  maxScrolls: number;
  maxExpandClicks: number;
  stableReadIntervalMs: number;
  minContentChars: number;
  ttlMs: number;
  maxTempBytes: number;
  maxRedirects: number;
  profileLockWaitMs: number;
  profileLockStaleMs: number;
  logLevel: "error" | "warn" | "info" | "debug";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string, fb: string): string => {
    const v = env[name];
    return v !== undefined && v !== "" ? v : fb;
  };
  const getInt = (name: string, fb: number): number => {
    const v = env[name];
    if (v === undefined || v === "") return fb;
    if (!/^\d+$/.test(v)) return fb;
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : fb;
  };
  const getBool = (name: string, fb: boolean): boolean => {
    const v = env[name];
    if (v === undefined || v === "") return fb;
    return v === "1" || v.toLowerCase() === "true";
  };
  const clampInt = (name: string, fb: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, getInt(name, fb)));

  const backendRaw = get("VWR_BROWSER_BACKEND", "openclaw");
  if (backendRaw !== "openclaw" && backendRaw !== "cdp") {
    throw new Error("VWR_BROWSER_BACKEND must be openclaw or cdp");
  }
  const backend: BrowserBackend = backendRaw;
  const logRaw = get("VWR_LOG_LEVEL", "warn");
  const logLevel =
    logRaw === "error" || logRaw === "info" || logRaw === "debug" ? logRaw : "warn";

  return {
    backend,
    openclawBin: get("VWR_OPENCLAW_BIN", "openclaw"),
    browserProfile: get("VWR_BROWSER_PROFILE", "verified-reader"),
    cdpUrl: get("VWR_CDP_URL", "http://127.0.0.1:9222"),
    stopBrowserIfStarted: getBool("VWR_STOP_BROWSER_IF_STARTED", true),
    keepBrowserTab: getBool("VWR_KEEP_BROWSER_TAB", false),
    inlineContentChars: clampInt("VWR_INLINE_CONTENT_CHARS", 6000, 1, 100_000),
    chunkChars: clampInt("VWR_CHUNK_CHARS", 6000, 1, 100_000),
    maxContentChars: clampInt("VWR_MAX_CONTENT_CHARS", 300_000, 1, 1_000_000),
    defaultMaxWaitMs: clampInt("VWR_MAX_WAIT_MS", 25_000, 1_000, 120_000),
    browserCommandTimeoutMs: clampInt("VWR_BROWSER_CMD_TIMEOUT_MS", 30_000, 1_000, 120_000),
    maxScrolls: clampInt("VWR_MAX_SCROLLS", 8, 0, 100),
    maxExpandClicks: clampInt("VWR_MAX_EXPANDS", 5, 0, 20),
    stableReadIntervalMs: clampInt("VWR_STABLE_READ_INTERVAL_MS", 1200, 0, 10_000),
    minContentChars: clampInt("VWR_MIN_CONTENT_CHARS", 200, 1, 100_000),
    ttlMs: clampInt("VWR_TTL_MINUTES", 15, 1, 1440) * 60_000,
    maxTempBytes: clampInt("VWR_MAX_TEMP_BYTES", 8 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxRedirects: clampInt("VWR_MAX_REDIRECTS", 5, 0, 20),
    profileLockWaitMs: clampInt("VWR_PROFILE_LOCK_WAIT_MS", 30_000, 1_000, 120_000),
    profileLockStaleMs: clampInt("VWR_PROFILE_LOCK_STALE_MS", 300_000, 300_000, 3_600_000),
    logLevel,
  };
}
