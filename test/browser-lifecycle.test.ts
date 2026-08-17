import { describe, expect, it } from "vitest";
import {
  BrowserUnavailableError,
  NavigationError,
  type BrowserClient,
  type BrowserStatus,
  type TabHandle,
} from "../src/browser-client.js";
import { runRead } from "../src/browser-runner.js";
import { loadConfig } from "../src/config.js";
import { checkUrlSafety } from "../src/url-safety.js";
import type { PageExtractResult, PageProbeResult, PageScrollResult } from "../src/types.js";

const ARTICLE =
  "这是一篇完整的文章正文。它有足够的长度来通过最小长度检查，" +
  "并且以一个自然的句号结束。这里再补充一些内容，让它超过两百个字符。" +
  "文章讨论了一个具体的问题，给出了论据，并且在结尾做了总结。" +
  "以上就是全部内容，感谢阅读。";

function extract(overrides: Partial<PageExtractResult> = {}): PageExtractResult {
  return {
    url: "https://example.com/article/123",
    found: true,
    selectorDescription: "article",
    matchedContentId: false,
    title: "示例标题",
    author: "示例作者",
    text: ARTICLE,
    textChars: ARTICLE.length,
    visibleExpandControls: 0,
    hitMaxChars: false,
    ...overrides,
  };
}

class MockClient implements BrowserClient {
  readonly kind = "openclaw" as const;
  canManageLifecycle = true;
  starts = 0;
  stops = 0;
  opens = 0;
  closes = 0;
  evaluates = 0;
  statusResult: BrowserStatus = { running: false };
  throwOnEvaluate: Error | null = null;
  throwOnOpen: Error | null = null;
  private tab: TabHandle | null = null;

  async status(): Promise<BrowserStatus> {
    return this.statusResult;
  }
  async start(): Promise<void> {
    this.starts++;
  }
  async stop(): Promise<void> {
    this.stops++;
  }
  async openTab(): Promise<TabHandle> {
    this.opens++;
    if (this.throwOnOpen) throw this.throwOnOpen;
    this.tab = { id: "tab-1" };
    return this.tab;
  }
  async evaluate<T>(): Promise<T> {
    this.evaluates++;
    if (this.throwOnEvaluate) throw this.throwOnEvaluate;
    if (this.evaluates === 1) {
      const probe: PageProbeResult = {
        url: "https://example.com/article/123",
        title: "示例标题",
        readyState: "complete",
        textSample: ARTICLE,
      };
      return probe as T;
    }
    if (this.evaluates % 3 === 0) {
      const scroll: PageScrollResult = { height: 1000, atBottom: true };
      return scroll as T;
    }
    return extract() as T;
  }
  async closeTab(): Promise<void> {
    this.closes++;
    this.tab = null;
  }
  async dispose(): Promise<void> {}
}

function testConfig() {
  return loadConfig({
    VWR_STABLE_READ_INTERVAL_MS: "0",
    VWR_MAX_SCROLLS: "1",
    VWR_MAX_EXPANDS: "0",
    VWR_MIN_CONTENT_CHARS: "50",
  });
}

const deps = {
  sleep: async () => {},
  checkUrl: (raw: string) => checkUrlSafety(raw, { resolveDns: false }),
};

describe("browser lifecycle (design §20.2)", () => {
  it("starts a stopped browser and stops it afterwards", async () => {
    const mock = new MockClient();
    mock.statusResult = { running: false };
    const result = await runRead(
      { url: "https://example.com/article/123" },
      testConfig(),
      { createClient: () => mock, ...deps },
    );
    expect(mock.starts).toBe(1);
    expect(mock.stops).toBe(1);
    expect(mock.closes).toBe(1);
    expect(result.browser_lifecycle.started_by_this_run).toBe(true);
    expect(result.browser_lifecycle.was_running_before).toBe(false);
    expect(result.browser_lifecycle.browser_stopped).toBe(true);
    expect(result.browser_lifecycle.tab_closed).toBe(true);
  });

  it("reuses an already-running browser and does not stop it", async () => {
    const mock = new MockClient();
    mock.statusResult = { running: true };
    const result = await runRead(
      { url: "https://example.com/article/123" },
      testConfig(),
      { createClient: () => mock, ...deps },
    );
    expect(mock.starts).toBe(0);
    expect(mock.stops).toBe(0);
    expect(mock.closes).toBe(1);
    expect(result.browser_lifecycle.started_by_this_run).toBe(false);
    expect(result.browser_lifecycle.was_running_before).toBe(true);
    expect(result.browser_lifecycle.browser_stopped).toBe(false);
  });

  it("does not start or stop when status is unknown", async () => {
    const mock = new MockClient();
    mock.statusResult = { running: null, detail: "gateway flake" };
    const result = await runRead(
      { url: "https://example.com/article/123" },
      testConfig(),
      { createClient: () => mock, ...deps },
    );
    expect(result.status).toBe("browser_unavailable");
    expect(mock.starts).toBe(0);
    expect(mock.stops).toBe(0);
    expect(mock.opens).toBe(0);
    expect(result.browser_lifecycle.started_by_this_run).toBe(false);
  });

  it("force-stops an externally started browser when VWR_FORCE_STOP_BROWSER=1", async () => {
    const mock = new MockClient();
    mock.statusResult = { running: true };
    const config = loadConfig({
      VWR_STABLE_READ_INTERVAL_MS: "0",
      VWR_MAX_SCROLLS: "1",
      VWR_MAX_EXPANDS: "0",
      VWR_MIN_CONTENT_CHARS: "50",
      VWR_FORCE_STOP_BROWSER: "1",
    });
    const result = await runRead(
      { url: "https://example.com/article/123" },
      config,
      { createClient: () => mock, ...deps },
    );
    expect(mock.starts).toBe(0);
    expect(mock.stops).toBe(1);
    expect(result.browser_lifecycle.was_running_before).toBe(true);
    expect(result.browser_lifecycle.started_by_this_run).toBe(false);
    expect(result.browser_lifecycle.browser_stopped).toBe(true);
  });

  it("never force-stops when the browser status is unknown", async () => {
    const mock = new MockClient();
    mock.statusResult = { running: null, detail: "gateway flake" };
    const config = loadConfig({
      VWR_STABLE_READ_INTERVAL_MS: "0",
      VWR_MIN_CONTENT_CHARS: "50",
      VWR_FORCE_STOP_BROWSER: "1",
    });
    const result = await runRead(
      { url: "https://example.com/article/123" },
      config,
      { createClient: () => mock, ...deps },
    );
    expect(result.status).toBe("browser_unavailable");
    expect(mock.stops).toBe(0);
    expect(result.browser_lifecycle.browser_stopped).toBe(false);
  });

  it("closes the tab when extraction throws", async () => {
    const mock = new MockClient();
    mock.statusResult = { running: true };
    mock.throwOnEvaluate = new NavigationError("page script failed");
    const result = await runRead(
      { url: "https://example.com/article/123" },
      testConfig(),
      { createClient: () => mock, ...deps },
    );
    expect(result.status).toBe("navigation_failed");
    expect(mock.closes).toBe(1);
    expect(result.browser_lifecycle.tab_closed).toBe(true);
    expect(mock.stops).toBe(0);
  });

  it("returns browser_unavailable on CDP disconnect without retrying forever", async () => {
    const mock = new MockClient();
    mock.canManageLifecycle = false;
    mock.statusResult = { running: false, detail: "cdp gone" };
    const result = await runRead(
      { url: "https://example.com/article/123" },
      testConfig(),
      { createClient: () => mock, ...deps },
    );
    expect(result.status).toBe("browser_unavailable");
    expect(mock.starts).toBe(0);
    expect(mock.opens).toBe(0);
  });

  it("still closes the tab if open succeeded and later evaluate is unavailable", async () => {
    const mock = new MockClient();
    mock.statusResult = { running: true };
    mock.throwOnEvaluate = new BrowserUnavailableError("cdp connection for tab is gone");
    const result = await runRead(
      { url: "https://example.com/article/123" },
      testConfig(),
      { createClient: () => mock, ...deps },
    );
    expect(result.status).toBe("browser_unavailable");
    expect(mock.closes).toBe(1);
  });
});
