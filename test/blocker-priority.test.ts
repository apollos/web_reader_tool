/**
 * Blocker patterns must not veto a fully verified read (design §11/§14.3):
 * many sites overlay a login modal while the complete target content is in
 * the DOM. The blocker verdict only applies when verification fails.
 */
import { describe, expect, it } from "vitest";
import type { BrowserClient, TabHandle } from "../src/browser-client.js";
import { runRead } from "../src/browser-runner.js";
import { loadConfig } from "../src/config.js";
import { checkUrlSafety } from "../src/url-safety.js";
import type { PageExtractResult, PageProbeResult } from "../src/types.js";

const ARTICLE =
  "这是目标文章的完整正文，虽然页面上悬浮着一个登录弹窗，但正文本身完整地存在于页面中。" +
  "这里补充更多内容让它超过最低可信长度，并以自然的句号结尾。全文完。";

const LOGIN_SAMPLE = "请先登录 登录后即可查看更多内容 " + ARTICLE;

class ModalClient implements BrowserClient {
  readonly kind = "openclaw" as const;
  readonly canManageLifecycle = true;
  private calls = 0;
  constructor(private readonly extractOverrides: Partial<PageExtractResult> = {}) {}
  async status() {
    return { running: true };
  }
  async start() {}
  async stop() {}
  async openTab(): Promise<TabHandle> {
    return { id: "tab-1" };
  }
  async evaluate<T>(): Promise<T> {
    this.calls++;
    if (this.calls === 1) {
      const probe: PageProbeResult = {
        url: "https://example.com/article/123",
        title: "目标文章标题",
        readyState: "complete",
        textSample: LOGIN_SAMPLE,
      };
      return probe as T;
    }
    const extract: PageExtractResult = {
      url: "https://example.com/article/123",
      found: true,
      selectorDescription: "article",
      matchedContentId: false,
      title: "目标文章标题",
      author: "作者",
      text: ARTICLE,
      textChars: ARTICLE.length,
      visibleExpandControls: 0,
      hitMaxChars: false,
      ...this.extractOverrides,
    };
    return extract as T;
  }
  async closeTab() {}
  async dispose() {}
}

function config() {
  return loadConfig({
    VWR_MAX_SCROLLS: "0",
    VWR_MAX_EXPANDS: "0",
    VWR_STABLE_READ_INTERVAL_MS: "0",
    VWR_MIN_CONTENT_CHARS: "50",
  });
}

const deps = {
  sleep: async () => {},
  checkUrl: (raw: string) => checkUrlSafety(raw, { resolveDns: false }),
};

describe("blocker priority vs verified content", () => {
  it("returns browser_verified when full content is present despite a login modal", async () => {
    const result = await runRead(
      { url: "https://example.com/article/123" },
      config(),
      { createClient: () => new ModalClient(), ...deps },
    );
    expect(result.status).toBe("browser_verified");
    expect(result.content).toContain("全文完");
    expect(result.warnings.join("\n")).toMatch(/blocker pattern present.*login_required/);
  });

  it("returns login_required when the container cannot be found", async () => {
    const result = await runRead(
      { url: "https://example.com/article/123" },
      config(),
      {
        createClient: () =>
          new ModalClient({ found: false, text: "", textChars: 0 }),
        ...deps,
      },
    );
    expect(result.status).toBe("login_required");
    expect(result.content).toBeNull();
  });

  it("returns login_required instead of browser_partial when content is incomplete", async () => {
    const result = await runRead(
      { url: "https://example.com/article/123" },
      config(),
      {
        createClient: () => new ModalClient({ visibleExpandControls: 1 }),
        ...deps,
      },
    );
    expect(result.status).toBe("login_required");
    expect(result.content).toBeNull();
    expect(result.content_completeness).toBe("partial");
  });
});
