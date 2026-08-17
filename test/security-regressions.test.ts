import { describe, expect, it } from "vitest";
import type { BrowserClient, TabHandle } from "../src/browser-client.js";
import { runRead } from "../src/browser-runner.js";
import { loadConfig } from "../src/config.js";
import { checkUrlSafety } from "../src/url-safety.js";
import type { PageExtractResult, PageProbeResult } from "../src/types.js";

const text = "这是另一个页面的稳定正文内容，拥有足够长度但并不是用户请求的文章。".repeat(20) + "结束。";

class WrongPageClient implements BrowserClient {
  readonly kind = "openclaw" as const;
  readonly canManageLifecycle = true;
  private calls = 0;
  async status() { return { running: true }; }
  async start() {}
  async stop() {}
  async openTab(): Promise<TabHandle> { return { id: "stable-tab" }; }
  async evaluate<T>(): Promise<T> {
    this.calls++;
    if (this.calls === 1) {
      return {
        url: "https://example.com/article/other",
        title: "另一个页面",
        readyState: "complete",
        textSample: text,
      } satisfies PageProbeResult as T;
    }
    return {
      url: "https://example.com/article/other",
      found: true,
      selectorDescription: "article",
      matchedContentId: false,
      title: "另一个页面",
      author: "其他作者",
      text,
      textChars: text.length,
      visibleExpandControls: 0,
      hitMaxChars: false,
    } satisfies PageExtractResult as T;
  }
  async closeTab() {}
  async dispose() {}
}

describe("security and identity regressions", () => {
  it("never marks a different same-host article as browser_verified", async () => {
    const config = loadConfig({
      VWR_MAX_SCROLLS: "0",
      VWR_MAX_EXPANDS: "0",
      VWR_STABLE_READ_INTERVAL_MS: "0",
      VWR_MIN_CONTENT_CHARS: "50",
    });
    const result = await runRead(
      { url: "https://example.com/article/original" },
      config,
      {
        createClient: () => new WrongPageClient(),
        sleep: async () => {},
        checkUrl: (raw) => checkUrlSafety(raw, { resolveDns: false }),
      },
    );
    expect(result.status).toBe("page_mismatch");
    expect(result.page_identity_verified).toBe(false);
    expect(result.content).toBeNull();
  });
});
