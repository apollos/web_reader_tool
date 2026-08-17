/**
 * Browser clients (design §10).
 *
 * Two backends:
 * - "openclaw": drives the OpenClaw managed browser via the `openclaw browser`
 *   CLI. Every invocation uses execFile with an argv array — never a shell —
 *   so user URLs cannot inject commands (design §16.2).
 * - "cdp": connects to an existing Chrome DevTools Protocol endpoint
 *   (loopback / SSH tunnel only per design §10.2). This backend never starts
 *   or stops the browser; if the endpoint is unreachable the task fails with
 *   browser_unavailable instead of retrying forever.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Config } from "./config.js";
import { log, sanitizeAuditText } from "./log.js";
import { checkControlPlaneEndpoint, checkUrlSafety } from "./url-safety.js";

export class BrowserUnavailableError extends Error {}
export class NavigationError extends Error {}
export class UnsafeNavigationError extends NavigationError {}

export interface TabHandle {
  id: string;
  wsUrl?: string;
}

export interface BrowserStatus {
  /** null = status could not be determined; must not start or stop. */
  running: boolean | null;
  detail?: string;
}

export interface BrowserClient {
  readonly kind: "openclaw" | "cdp";
  /** True if this backend is able to start/stop the browser itself. */
  readonly canManageLifecycle: boolean;
  status(): Promise<BrowserStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Open a fresh tab and navigate it. If this throws after creation, it must close the tab itself. */
  openTab(url: string, maxWaitMs: number): Promise<TabHandle>;
  /** Evaluate a fixed expression in the tab, returning its JSON value. */
  evaluate<T>(tab: TabHandle, expression: string): Promise<T>;
  closeTab(tab: TabHandle): Promise<void>;
  dispose(): Promise<void>;
}

export function createBrowserClient(config: Config): BrowserClient {
  return config.backend === "cdp" ? new CdpClient(config) : new OpenClawClient(config);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract the last JSON object/array found in mixed CLI output. */
export function parseJsonFromOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to line scan */
  }
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* OpenClaw managed browser backend                                           */
/* -------------------------------------------------------------------------- */

/**
 * Argv builders matching `openclaw browser` (verified against OpenClaw
 * 2026.7.1-2): `open`/`close`/`focus` take positional tab/url arguments,
 * `evaluate` takes a function source via --fn and runs against the focused
 * tab. Exported for unit tests, which assert that commands are argv arrays
 * and that user URLs stay single opaque arguments.
 */
const GATEWAY_DOWN = /gateway|ECONNREFUSED|ENOENT|not running|closed \((1000|1006)|handshake timeout|timed? ?out/i;

/** Map execFile failures to the design status they should produce. */
export function classifyOpenclawError(args: string[], error: Error): Error {
  const sub = args[1] ?? "";
  const msg = `openclaw ${args[0]} ${sub} failed: ${error.message}`;
  if (sub === "status" || sub === "start" || sub === "stop") {
    return new BrowserUnavailableError(msg);
  }
  if (GATEWAY_DOWN.test(error.message)) {
    return new BrowserUnavailableError(msg);
  }
  if (sub === "open" || sub === "evaluate" || sub === "close" || sub === "focus") {
    return new NavigationError(msg);
  }
  return new BrowserUnavailableError(msg);
}

export const openclawArgs = {
  status: (profile: string): string[] => ["browser", "status", "--browser-profile", profile, "--json"],
  start: (profile: string): string[] => ["browser", "start", "--browser-profile", profile],
  stop: (profile: string): string[] => ["browser", "stop", "--browser-profile", profile],
  open: (profile: string, url: string, label?: string): string[] => [
    "browser", "open", url,
    ...(label ? ["--label", label] : []),
    "--browser-profile", profile, "--json",
  ],
  focus: (profile: string, tabRef: string): string[] => [
    "browser", "focus", tabRef, "--browser-profile", profile, "--json",
  ],
  evaluate: (profile: string, fnSource: string, targetId: string): string[] => [
    "browser", "evaluate", "--fn", fnSource, "--target-id", targetId,
    "--browser-profile", profile, "--json",
  ],
  close: (profile: string, tabRef: string): string[] => [
    "browser", "close", tabRef, "--browser-profile", profile, "--json",
  ],
};

export function selectOpenClawTabReference(parsed: {
  suggestedTargetId?: string;
  targetId?: string;
  tabId?: string;
  id?: string;
  ref?: string;
} | null): string | undefined {
  return parsed?.suggestedTargetId ?? parsed?.tabId ?? parsed?.id ?? parsed?.ref ?? parsed?.targetId;
}

export class OpenClawClient implements BrowserClient {
  readonly kind = "openclaw" as const;
  readonly canManageLifecycle = true;

  constructor(private readonly config: Config) {}

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.config.openclawBin,
        args,
        {
          timeout: this.config.browserCommandTimeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(classifyOpenclawError(args, error));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }

  async status(): Promise<BrowserStatus> {
    try {
      const { stdout } = await this.run(openclawArgs.status(this.config.browserProfile));
      const parsed = parseJsonFromOutput(stdout) as { running?: boolean } | null;
      if (parsed && typeof parsed.running === "boolean") {
        return { running: parsed.running };
      }
      return {
        running: null,
        detail: "status output did not include a boolean running field",
      };
    } catch (e) {
      return { running: null, detail: (e as Error).message };
    }
  }

  async start(): Promise<void> {
    await this.run(openclawArgs.start(this.config.browserProfile));
  }

  async stop(): Promise<void> {
    await this.run(openclawArgs.stop(this.config.browserProfile));
  }

  async openTab(url: string, maxWaitMs: number): Promise<TabHandle> {
    // A unique label is a stable close/focus handle even if mixed CLI output
    // cannot be parsed after OpenClaw has already created the tab.
    const label = `vwr-${randomUUID()}`;
    let stdout: string;
    try {
      ({ stdout } = await this.run(openclawArgs.open(this.config.browserProfile, url, label)));
    } catch (error) {
      // The open command can time out or exit non-zero after the tab was
      // already created; close it by label so it never leaks.
      try {
        await this.closeTab({ id: label });
      } catch {
        /* the tab most likely was never created */
      }
      throw error;
    }
    const parsed = parseJsonFromOutput(stdout) as
      | { suggestedTargetId?: string; targetId?: string; tabId?: string; id?: string; ref?: string }
      | null;
    // Prefer OpenClaw's stable handle. Raw targetId can be replaced during
    // anti-bot redirects or cross-process navigation.
    const id = selectOpenClawTabReference(parsed) ?? label;
    const tab: TabHandle = { id };
    try {
      await this.waitForReady(tab, maxWaitMs);
      return tab;
    } catch (error) {
      try {
        await this.closeTab(tab);
      } catch (closeError) {
        log.warn(`failed to close tab after open failure: ${sanitizeAuditText((closeError as Error).message)}`);
      }
      throw error;
    }
  }

  private async waitForReady(tab: TabHandle, maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      try {
        const state = await this.evaluate<string>(tab, "document.readyState");
        if (state === "interactive" || state === "complete") return;
      } catch (error) {
        if (error instanceof BrowserUnavailableError) throw error;
        /* page may still be navigating */
      }
      if (Date.now() >= deadline) {
        throw new NavigationError(`page did not become ready within ${maxWaitMs}ms`);
      }
      await sleep(500);
    }
  }

  async evaluate<T>(tab: TabHandle, expression: string): Promise<T> {
    const fnSource = `() => (${expression})`;
    const { stdout } = await this.run(
      openclawArgs.evaluate(this.config.browserProfile, fnSource, tab.id),
    );
    const parsed = parseJsonFromOutput(stdout);
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if ("value" in obj) return obj["value"] as T;
      if ("result" in obj) return obj["result"] as T;
    }
    return parsed as T;
  }

  async closeTab(tab: TabHandle): Promise<void> {
    await this.run(openclawArgs.close(this.config.browserProfile, tab.id));
  }

  async dispose(): Promise<void> {
    /* no persistent resources */
  }
}

/* -------------------------------------------------------------------------- */
/* Remote CDP backend                                                         */
/* -------------------------------------------------------------------------- */

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl?: string;
}

class CdpConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private events: Array<{ method: string; params: unknown }> = [];
  private guardTasks = new Set<Promise<void>>();
  private guardError: Error | null = null;
  private documentRequestsByFrame = new Map<string, number>();
  private requestGuardEnabled = false;

  private constructor(private readonly ws: WebSocket) {}

  static async connect(wsUrl: string, timeoutMs: number): Promise<CdpConnection> {
    const safe = await checkControlPlaneEndpoint(wsUrl);
    if (!safe.ok) {
      throw new BrowserUnavailableError(`cdp websocket rejected: ${safe.reason ?? "unsafe"}`);
    }
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new BrowserUnavailableError("cdp websocket connect timeout"));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(new BrowserUnavailableError(`cdp websocket error: ${err.message}`));
      });
    });
    const conn = new CdpConnection(ws);
    ws.on("message", (data) => conn.onMessage(String(data)));
    ws.on("error", (err) => log.warn(`cdp socket error: ${sanitizeAuditText(err.message)}`));
    ws.on("close", () => conn.onClose());
    return conn;
  }

  enableSafeRequestGuard(maxRedirects: number): void {
    this.requestGuardEnabled = true;
    this.documentRequestsByFrame.clear();
    this.guardError = null;
    this.maxRedirects = maxRedirects;
  }

  private maxRedirects = 5;

  private onClose(): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(new BrowserUnavailableError("cdp websocket closed"));
    }
    this.pending.clear();
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "cdp command error"));
      else waiter.resolve(msg.result);
    } else if (msg.method) {
      this.events.push({ method: msg.method, params: msg.params });
      if (this.events.length > 500) this.events.shift();
      if (msg.method === "Fetch.requestPaused" && this.requestGuardEnabled) {
        const task = this.handlePausedRequest(msg.params as {
          requestId?: string;
          frameId?: string;
          resourceType?: string;
          request?: { url?: string };
        });
        this.guardTasks.add(task);
        void task.finally(() => this.guardTasks.delete(task));
      }
    }
  }

  private async handlePausedRequest(params: PausedRequestParams): Promise<void> {
    const error = await processPausedRequest(params, {
      maxRedirects: this.maxRedirects,
      documentRequestsByFrame: this.documentRequestsByFrame,
      continueRequest: async (requestId) => {
        await this.send("Fetch.continueRequest", { requestId });
      },
      failRequest: async (requestId) => {
        await this.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      },
    });
    if (error && !this.guardError) this.guardError = error;
  }

  async waitForRequestGuards(): Promise<void> {
    while (this.guardTasks.size > 0) {
      await Promise.allSettled([...this.guardTasks]);
    }
    if (this.guardError) throw this.guardError;
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserUnavailableError("cdp websocket is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp command ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sawEvent(method: string): boolean {
    return this.events.some((e) => e.method === method);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export interface PausedRequestParams {
  requestId?: string;
  frameId?: string;
  resourceType?: string;
  request?: { url?: string };
}

export interface PausedRequestIo {
  maxRedirects: number;
  documentRequestsByFrame: Map<string, number>;
  continueRequest: (requestId: string) => Promise<void>;
  failRequest: (requestId: string) => Promise<void>;
  check?: typeof checkUrlSafety;
}

/**
 * Decide the fate of one paused CDP request. Returns the error that should
 * fail the whole task, or null.
 *
 * Only a blocked *navigation* (resourceType Document) fails the task. Unsafe
 * or unresolvable subresources are blocked with failRequest but never abort
 * the read: real pages routinely reference dead third-party domains or
 * private-network trackers, and blocking them is enough.
 */
export async function processPausedRequest(
  params: PausedRequestParams,
  io: PausedRequestIo,
): Promise<Error | null> {
  const requestId = params.requestId;
  if (!requestId) return null;
  const rawUrl = params.request?.url ?? "";
  const isDocument = params.resourceType === "Document";

  try {
    await assertSafeBrowserRequest(rawUrl, io.check ?? checkUrlSafety);
    if (isDocument) {
      const frame = params.frameId ?? "unknown";
      const count = (io.documentRequestsByFrame.get(frame) ?? 0) + 1;
      io.documentRequestsByFrame.set(frame, count);
      if (count - 1 > io.maxRedirects) {
        throw new NavigationError(
          `too many document redirects (${count - 1} > ${io.maxRedirects})`,
        );
      }
    }
    await io.continueRequest(requestId);
    return null;
  } catch (error) {
    try {
      await io.failRequest(requestId);
    } catch {
      /* the target may already be closing */
    }
    if (isDocument) return error as Error;
    log.warn(`blocked subresource request: ${sanitizeAuditText((error as Error).message)}`);
    return null;
  }
}

export async function assertSafeBrowserRequest(
  rawUrl: string,
  check: typeof checkUrlSafety = checkUrlSafety,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeNavigationError("browser request url is not parseable");
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const safe = await check(rawUrl);
    if (!safe.ok) {
      throw new UnsafeNavigationError(
        `browser request rejected before network access: ${safe.reason ?? "unsafe url"}`,
      );
    }
    return;
  }
  if (!["about:", "data:", "blob:"].includes(parsed.protocol)) {
    throw new UnsafeNavigationError(`browser request scheme ${parsed.protocol} is not allowed`);
  }
}

export class CdpClient implements BrowserClient {
  readonly kind = "cdp" as const;
  readonly canManageLifecycle = false;
  private connections = new Map<string, CdpConnection>();

  constructor(private readonly config: Config) {}

  private async assertControlPlane(url: string): Promise<void> {
    const check = await checkControlPlaneEndpoint(url);
    if (!check.ok) {
      throw new BrowserUnavailableError(`cdp endpoint rejected: ${check.reason ?? "unsafe"}`);
    }
  }

  private async http(path: string, method: "GET" | "PUT" = "GET"): Promise<unknown> {
    await this.assertControlPlane(this.config.cdpUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.browserCommandTimeoutMs);
    try {
      const res = await fetch(`${this.config.cdpUrl.replace(/\/$/, "")}${path}`, {
        method,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new BrowserUnavailableError(`cdp http ${path} returned ${res.status}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e instanceof BrowserUnavailableError) throw e;
      throw new BrowserUnavailableError(`cdp endpoint unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<BrowserStatus> {
    try {
      await this.http("/json/version");
      return { running: true };
    } catch (e) {
      return { running: false, detail: (e as Error).message };
    }
  }

  async start(): Promise<void> {
    throw new BrowserUnavailableError(
      "cdp backend cannot start a remote browser; the endpoint must already be running",
    );
  }

  async stop(): Promise<void> {
    /* Remote browser lifecycle is owned by external infrastructure (§10.2). */
  }

  async openTab(url: string, maxWaitMs: number): Promise<TabHandle> {
    // Open a blank target first so redirects can be observed and re-checked.
    let target: CdpTarget | null = null;
    try {
      target = (await this.http("/json/new?about:blank", "PUT")) as CdpTarget;
    } catch (error) {
      // Old CDP implementations accepted GET here. Do not retry arbitrary
      // failures: the first call may already have created an untracked tab.
      if (!/returned (404|405)\b/.test((error as Error).message)) throw error;
      target = (await this.http("/json/new?about:blank", "GET")) as CdpTarget;
    }
    if (!target?.id) {
      throw new NavigationError("cdp /json/new did not return a debuggable target");
    }
    const tab: TabHandle = { id: target.id, wsUrl: target.webSocketDebuggerUrl };
    if (!target.webSocketDebuggerUrl) {
      try { await this.closeTab(tab); } catch { /* best effort */ }
      throw new NavigationError("cdp /json/new did not return a websocket url");
    }
    try {
      const conn = await CdpConnection.connect(
        target.webSocketDebuggerUrl,
        this.config.browserCommandTimeoutMs,
      );
      this.connections.set(tab.id, conn);
      await conn.send("Page.enable");
      await conn.send("Network.enable");
      await conn.send("Runtime.enable");
      conn.enableSafeRequestGuard(this.config.maxRedirects);
      await conn.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      let navigation: { errorText?: string };
      try {
        navigation = (await conn.send("Page.navigate", { url })) as { errorText?: string };
      } catch (error) {
        // Prefer the deterministic security reason recorded by the paused
        // request guard over a secondary generic navigation failure.
        await conn.waitForRequestGuards();
        throw error;
      }
      await conn.waitForRequestGuards();
      if (navigation.errorText) throw new NavigationError(`navigation failed: ${navigation.errorText}`);

      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        await conn.waitForRequestGuards();
        try {
          const state = await this.evaluate<{ readyState: string; url: string }>(
            tab,
            "({ readyState: document.readyState, url: location.href })",
          );
          if (
            state.url !== "about:blank" &&
            (state.readyState === "interactive" || state.readyState === "complete")
          ) {
            await conn.waitForRequestGuards();
            return tab;
          }
        } catch (error) {
          if (error instanceof UnsafeNavigationError) throw error;
          if (error instanceof BrowserUnavailableError) throw error;
          /* still navigating */
        }
        if (Date.now() >= deadline) {
          throw new NavigationError(`page did not become ready within ${maxWaitMs}ms`);
        }
        await sleep(500);
      }
    } catch (error) {
      try {
        await this.closeTab(tab);
      } catch (closeError) {
        log.warn(`failed to close CDP tab after open failure: ${sanitizeAuditText((closeError as Error).message)}`);
      }
      throw error;
    }
  }

  async evaluate<T>(tab: TabHandle, expression: string): Promise<T> {
    const conn = this.connections.get(tab.id);
    if (!conn) throw new BrowserUnavailableError("cdp connection for tab is gone");
    const result = (await conn.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "page script threw";
      throw new NavigationError(`evaluate failed: ${desc.slice(0, 300)}`);
    }
    return result.result?.value as T;
  }

  async closeTab(tab: TabHandle): Promise<void> {
    const conn = this.connections.get(tab.id);
    if (conn) {
      conn.close();
      this.connections.delete(tab.id);
    }
    await this.http(`/json/close/${tab.id}`);
  }

  async dispose(): Promise<void> {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
  }
}
