/**
 * One-shot browser read orchestrator (design §8.2).
 *
 * Lifecycle rules (design §10):
 * - browser is checked/started only after the fallback path is entered;
 * - if this run started the browser, it may stop it afterwards
 *   (VWR_STOP_BROWSER_IF_STARTED, default on); a browser that was already
 *   running is reused and never stopped;
 * - the task tab is always closed in `finally`, on success and failure.
 */

import { randomUUID } from "node:crypto";
import {
  BrowserUnavailableError,
  NavigationError,
  UnsafeNavigationError,
  createBrowserClient,
  type BrowserClient,
  type TabHandle,
} from "./browser-client.js";
import { buildPageExpression } from "./browser-page-script.js";
import { detectBlocker, detectHomepageRedirect, type BlockerType } from "./blockers.js";
import type { Config } from "./config.js";
import { ExclusiveRunLock } from "./exclusive-run-lock.js";
import { log, redactUrl, sanitizeAuditText } from "./log.js";
import { normalizeText, verifyCompleteness, verifyIdentity } from "./page-verifier.js";
import { hostMatches, selectAdapter } from "./site-adapters/index.js";
import { TempChunkStore } from "./temp-chunk-store.js";
import type {
  BrowserLifecycle,
  Evidence,
  PageExpandResult,
  PageExtractResult,
  PageProbeResult,
  PageScrollResult,
  ReadInput,
  ReadResult,
  ReadStatus,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { checkUrlSafety } from "./url-safety.js";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error: unknown): string {
  return sanitizeAuditText(error instanceof Error ? error.message : String(error));
}

export interface RunReadDeps {
  createClient?: (config: Config) => BrowserClient;
  store?: TempChunkStore;
  sleep?: (ms: number) => Promise<void>;
  checkUrl?: typeof checkUrlSafety;
}

const BLOCKER_STATUS: Record<BlockerType, ReadStatus> = {
  login_required: "login_required",
  captcha: "captcha",
  paywall: "paywall",
  error_page: "page_mismatch",
  homepage_redirect: "page_mismatch",
};

export async function runRead(
  input: ReadInput,
  config: Config,
  deps: RunReadDeps = {},
): Promise<ReadResult> {
  const runId = randomUUID();
  const sleep = deps.sleep ?? defaultSleep;
  // Shared by reference with every result object, so warnings appended in
  // `finally` (tab close failures etc.) are always part of the final JSON.
  const warnings: string[] = [];
  const lifecycle: BrowserLifecycle = {
    was_running_before: null,
    started_by_this_run: false,
    tab_closed: null,
    browser_stopped: false,
  };
  const store = deps.store ?? new TempChunkStore(config.ttlMs, undefined, config.maxTempBytes);
  const safeFallback = input.fallback_reason
    ? {
        type: input.fallback_reason.type.slice(0, 64),
        ...(input.fallback_reason.detail
          ? { detail: sanitizeAuditText(input.fallback_reason.detail) }
          : {}),
      }
    : null;

  // Opportunistic sweep of expired chunk dirs from earlier runs (§13.3).
  try {
    const swept = store.sweepExpired();
    if (swept > 0) log.info(`swept ${swept} expired chunk dir(s)`);
  } catch (e) {
    log.warn(`chunk sweep failed: ${safeError(e)}`);
  }

  const base = (status: ReadStatus, extra: Partial<Omit<ReadResult, "warnings">> = {}): ReadResult => ({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    status,
    requested_url: redactUrl(input.url),
    final_url: null,
    fallback_reason: safeFallback,
    title: null,
    author: null,
    page_identity_verified: false,
    content_completeness: "none",
    content_chars: 0,
    content: null,
    evidence: null,
    browser_lifecycle: lifecycle,
    ...extra,
    warnings,
  });

  // --- 1. URL safety (SSRF) -------------------------------------------------
  const checkUrl = deps.checkUrl ?? checkUrlSafety;
  const safety = await checkUrl(input.url);
  if (!safety.ok || !safety.url) {
    warnings.push(`url rejected: ${safety.reason ?? "unknown"}`);
    return base("unsafe_url");
  }
  const requestedUrl = safety.url;
  const adapter = selectAdapter(requestedUrl);
  const hint = input.target_hint ?? null;
  const params = adapter.extractParams(requestedUrl, hint);
  const maxWaitMs = Math.min(input.max_wait_ms ?? config.defaultMaxWaitMs, 120_000);
  const requireComplete = input.require_complete !== false;
  log.info(`adapter=${adapter.name} url=${redactUrl(input.url)}`);

  // --- 2. Browser lifecycle -------------------------------------------------
  const client: BrowserClient = (deps.createClient ?? createBrowserClient)(config);
  let tab: TabHandle | null = null;
  const profileLock =
    config.backend === "openclaw"
      ? new ExclusiveRunLock(store.baseDir(), config.browserProfile, config.profileLockStaleMs)
      : null;
  const refreshProfileLock = (): void => profileLock?.refresh();

  try {
    if (profileLock) {
      const acquired = await profileLock.acquire(config.profileLockWaitMs, sleep);
      if (!acquired) {
        warnings.push("another verified browser read is using this browser profile");
        return base("browser_unavailable");
      }
    }
    refreshProfileLock();
    const browserStatus = await client.status();
    refreshProfileLock();
    lifecycle.was_running_before = browserStatus.running;
    if (browserStatus.running === null) {
      warnings.push(
        `browser status unknown; refusing to start or stop: ${sanitizeAuditText(browserStatus.detail ?? "no detail")}`,
      );
      return base("browser_unavailable");
    }
    if (!browserStatus.running) {
      if (!client.canManageLifecycle) {
        warnings.push(`cdp endpoint not reachable: ${sanitizeAuditText(browserStatus.detail ?? "no detail")}`);
        return base("browser_unavailable");
      }
      log.info("browser not running; starting dedicated profile");
      try {
        refreshProfileLock();
        await client.start();
        refreshProfileLock();
        lifecycle.started_by_this_run = true;
      } catch (e) {
        warnings.push(`browser start failed: ${safeError(e)}`);
        return base("browser_unavailable");
      }
    }

    // --- 3. Open tab & navigate --------------------------------------------
    try {
      refreshProfileLock();
      tab = await client.openTab(requestedUrl.toString(), maxWaitMs);
      refreshProfileLock();
    } catch (e) {
      warnings.push(`navigation failed: ${safeError(e)}`);
      return base(
        e instanceof UnsafeNavigationError
          ? "unsafe_url"
          : e instanceof BrowserUnavailableError
            ? "browser_unavailable"
            : "navigation_failed",
      );
    }

    const evaluate = async <T,>(
      action: Parameters<typeof buildPageExpression>[0],
    ): Promise<T> => {
      refreshProfileLock();
      const value = await client.evaluate<T>(tab as TabHandle, buildPageExpression(action));
      refreshProfileLock();
      return value;
    };

    // --- 4. Final URL re-validation (redirects re-checked, §16.1) ----------
    const probe = await evaluate<PageProbeResult>({ action: "probe" });
    let finalUrl: URL;
    try {
      finalUrl = new URL(probe.url);
    } catch {
      warnings.push("browser reported an unparseable final url");
      return base("navigation_failed");
    }
    const finalRedacted = redactUrl(finalUrl.toString());
    const finalSafety = await checkUrl(finalUrl.toString());
    if (!finalSafety.ok) {
      warnings.push(`final url rejected: ${finalSafety.reason ?? "unknown"}`);
      return base("unsafe_url", { final_url: finalRedacted });
    }
    if (!hostMatches(finalUrl.hostname, adapter.allowedFinalHosts(requestedUrl))) {
      warnings.push(`final host ${finalUrl.hostname} not allowed for target`);
      return base("page_mismatch", { final_url: finalRedacted });
    }

    // --- 5. Blockers ---------------------------------------------------------
    const homepage = detectHomepageRedirect(requestedUrl, finalUrl);
    const blocker = homepage ?? detectBlocker(probe, adapter.blockerRules ?? []);
    if (blocker) {
      warnings.push(`blocker detected (${blocker.type}): ${blocker.evidence}`);
      return base(BLOCKER_STATUS[blocker.type], {
        final_url: finalRedacted,
        title: probe.title || null,
      });
    }

    const finalUrlOk = adapter.verifyFinalUrl(requestedUrl, finalUrl);

    // --- 6. Locate target container -----------------------------------------
    const extractParams = {
      action: "extract" as const,
      ...params,
      maxChars: config.maxContentChars,
    };
    let read = await evaluate<PageExtractResult>(extractParams);
    if (!read.found) {
      warnings.push("target content container not found on page");
      return base("content_not_found", { final_url: finalRedacted, title: read.title });
    }
    const lengthBeforeExpand = read.textChars;

    // --- 7. Expand controls, only inside the target container ---------------
    let expandsClicked = 0;
    let expandRounds = 0;
    while (read.visibleExpandControls > 0 && expandsClicked < config.maxExpandClicks) {
      expandRounds++;
      if (expandRounds > config.maxExpandClicks) break;
      const expanded = await evaluate<PageExpandResult>({
        action: "expand",
        ...params,
        maxExpandClicks: config.maxExpandClicks - expandsClicked,
      });
      expandsClicked += expanded.clicked;
      if (expanded.clicked === 0) break;
      await sleep(600);
      read = await evaluate<PageExtractResult>(extractParams);
    }

    // --- 8. Bounded scrolling for lazy content ------------------------------
    let lastLength = read.textChars;
    for (let i = 0; i < config.maxScrolls; i++) {
      const scroll = await evaluate<PageScrollResult>({ action: "scroll", scrollStep: 1400 });
      await sleep(400);
      const after = await evaluate<PageExtractResult>(extractParams);
      const grew = after.textChars > lastLength;
      lastLength = after.textChars;
      read = after;
      if (scroll.atBottom && !grew) break;
    }

    // --- 9. Two stable reads -------------------------------------------------
    const readA = read;
    await sleep(config.stableReadIntervalMs);
    const readB = await evaluate<PageExtractResult>(extractParams);

    // --- 10. Verification ----------------------------------------------------
    const identity = verifyIdentity({
      adapterName: adapter.name,
      targetContentId: params.targetContentId,
      requireContentIdMatch: params.requireContentIdMatch,
      hint,
      read: readB,
      finalUrlOk,
    });
    const completeness = verifyCompleteness({
      readA,
      readB,
      requireComplete,
      minContentChars: config.minContentChars,
      expandsClicked,
    });

    const stableReads = normalizeText(readA.text) === normalizeText(readB.text) ? 2 : 1;
    const evidence: Evidence = {
      opening: readB.text.slice(0, 160),
      ending: readB.text.slice(-160),
      target_content_id: params.targetContentId,
      target_selector: readB.selectorDescription,
      expanded: expandsClicked > 0,
      length_before_expand: lengthBeforeExpand,
      length_after_expand: readB.textChars,
      stable_reads: stableReads,
      visible_expand_controls: readB.visibleExpandControls,
      identity_checks: [...identity.checks, ...identity.failures.map((f) => `FAIL: ${f}`)],
      completeness_checks: [
        ...completeness.checks,
        ...completeness.failures.map((f) => `FAIL: ${f}`),
      ],
    };

    // §14.3 consistency: browser_verified requires identity ok AND complete.
    let status: ReadStatus;
    if (!identity.ok) {
      status = "page_mismatch";
    } else if (completeness.completeness === "none") {
      status = "content_not_found";
    } else if (completeness.completeness === "complete") {
      status = "browser_verified";
    } else {
      status = "browser_partial";
    }

    // --- 11. Content delivery: inline or chunked -----------------------------
    const content = readB.text;
    let inline: string | null = status === "page_mismatch" ? null : content;
    let chunkInfo: { content_handle: string; chunk_count: number; expires_at: string } | null =
      null;
    if (inline !== null && content.length > config.inlineContentChars) {
      const stored = store.store(runId, input.url, content, config.chunkChars);
      inline = store.readChunk(runId, 0).content;
      chunkInfo = {
        content_handle: runId,
        chunk_count: stored.chunkCount,
        expires_at: stored.expiresAt,
      };
    }

    return base(status, {
      final_url: finalRedacted,
      title: readB.title,
      author: readB.author,
      page_identity_verified: identity.ok,
      content_completeness: completeness.completeness,
      content_chars: content.length,
      content: inline,
      ...(chunkInfo ?? {}),
      evidence,
    });
  } catch (e) {
    if (e instanceof UnsafeNavigationError) {
      warnings.push(safeError(e));
      return base("unsafe_url");
    }
    if (e instanceof BrowserUnavailableError) {
      warnings.push(safeError(e));
      return base("browser_unavailable");
    }
    if (e instanceof NavigationError) {
      warnings.push(safeError(e));
      return base("navigation_failed");
    }
    log.error(`internal error: ${sanitizeAuditText((e as Error).stack ?? safeError(e), 2000)}`);
    warnings.push(`internal error: ${safeError(e)}`);
    return base("internal_error");
  } finally {
    // --- 12. Cleanup: tab, browser ownership, connections (§8.2/§10) --------
    if (tab) {
      if (config.keepBrowserTab) {
        lifecycle.tab_closed = false;
        warnings.push("task tab kept open by VWR_KEEP_BROWSER_TAB=1");
      } else {
        try {
          await client.closeTab(tab);
          lifecycle.tab_closed = true;
        } catch (e) {
          lifecycle.tab_closed = false;
          warnings.push(`failed to close task tab: ${safeError(e)}`);
        }
      }
    }
    if (
      lifecycle.started_by_this_run &&
      config.stopBrowserIfStarted &&
      client.canManageLifecycle
    ) {
      try {
        refreshProfileLock();
        await client.stop();
        refreshProfileLock();
        lifecycle.browser_stopped = true;
      } catch (e) {
        warnings.push(`failed to stop browser profile: ${safeError(e)}`);
      }
    }
    try {
      await client.dispose();
    } catch (e) {
      warnings.push(`failed to dispose browser client: ${safeError(e)}`);
    }
    try {
      profileLock?.release();
    } catch (e) {
      warnings.push(`failed to release browser profile lock: ${safeError(e)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* doctor: manual diagnostics only (§19.2). Never part of the normal flow.    */
/* -------------------------------------------------------------------------- */

export interface DoctorReport {
  schema_version: typeof SCHEMA_VERSION;
  node_version: string;
  backend: string;
  browser_profile: string;
  cdp_url: string | null;
  browser_running: boolean | null;
  browser_detail: string | null;
  temp_dir: string;
  temp_dir_writable: boolean;
  ok: boolean;
}

export async function runDoctor(config: Config): Promise<DoctorReport> {
  const client = createBrowserClient(config);
  const store = new TempChunkStore(config.ttlMs, undefined, config.maxTempBytes);
  let writable = false;
  try {
    const fs = await import("node:fs");
    fs.mkdirSync(store.baseDir(), { recursive: true, mode: 0o700 });
    fs.accessSync(store.baseDir(), fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  const status = await client.status();
  await client.dispose();
  return {
    schema_version: SCHEMA_VERSION,
    node_version: process.version,
    backend: config.backend,
    browser_profile: config.browserProfile,
    cdp_url: config.backend === "cdp" ? config.cdpUrl : null,
    browser_running: status.running,
    browser_detail: status.detail ?? null,
    temp_dir: store.baseDir(),
    temp_dir_writable: writable,
    ok: writable && status.running !== null && (status.running || config.backend === "openclaw"),
  };
}
