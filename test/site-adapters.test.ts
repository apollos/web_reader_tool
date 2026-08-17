import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { pageScript } from "../src/browser-page-script.js";
import { genericAdapter, genericContentIdFromUrl } from "../src/site-adapters/generic.js";
import { parseZhihuAnswerUrl, zhihuAdapter } from "../src/site-adapters/zhihu.js";
import { selectAdapter } from "../src/site-adapters/index.js";
import type { PageExpandResult, PageExtractResult } from "../src/types.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(TEST_DIR, "fixtures", "zhihu-answer.html"), "utf8");

const ZHIHU_URL = "https://www.zhihu.com/question/999/answer/222";

function withDom(html: string, url: string): () => void {
  const dom = new JSDOM(html, { url });
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g["document"], location: g["location"], window: g["window"] };
  g["document"] = dom.window.document;
  g["location"] = dom.window.location;
  g["window"] = dom.window;
  return () => {
    g["document"] = saved.document;
    g["location"] = saved.location;
    g["window"] = saved.window;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("adapter selection", () => {
  it("routes zhihu answer urls to the zhihu adapter", () => {
    expect(selectAdapter(new URL(ZHIHU_URL)).name).toBe("zhihu-answer");
  });

  it("routes everything else to generic", () => {
    expect(selectAdapter(new URL("https://example.com/article/1")).name).toBe("generic");
    expect(selectAdapter(new URL("https://www.zhihu.com/question/999")).name).toBe("generic");
  });
});

describe("zhihu url parsing", () => {
  it("extracts question and answer ids", () => {
    expect(parseZhihuAnswerUrl(new URL(ZHIHU_URL))).toEqual({
      questionId: "999",
      answerId: "222",
    });
  });

  it("rejects non-answer or non-zhihu urls", () => {
    expect(parseZhihuAnswerUrl(new URL("https://www.zhihu.com/question/999"))).toBeNull();
    expect(parseZhihuAnswerUrl(new URL("https://evil.com/question/1/answer/2"))).toBeNull();
  });

  it("verifies final urls against the target answer", () => {
    const requested = new URL(ZHIHU_URL);
    expect(zhihuAdapter.verifyFinalUrl(requested, new URL(ZHIHU_URL))).toBe(true);
    expect(
      zhihuAdapter.verifyFinalUrl(requested, new URL("https://www.zhihu.com/question/999/answer/111")),
    ).toBe(false);
    expect(zhihuAdapter.verifyFinalUrl(requested, new URL("https://www.zhihu.com/"))).toBe(false);
    expect(
      zhihuAdapter.verifyFinalUrl(
        requested,
        new URL("https://www.zhihu.com/question/999/answer/2222"),
      ),
    ).toBe(false);
  });
});

describe("zhihu extraction on fixture (multi-answer page)", () => {
  function params(action: "extract" | "expand") {
    const p = zhihuAdapter.extractParams(new URL(ZHIHU_URL), null);
    return { action, ...p, maxChars: 100_000, maxExpandClicks: 3 } as const;
  }

  it("selects the container of answer 222, not the first answer on the page", () => {
    restore = withDom(FIXTURE, ZHIHU_URL);
    const result = pageScript(params("extract")) as PageExtractResult;
    expect(result.found).toBe(true);
    expect(result.matchedContentId).toBe(true);
    expect(result.text).toContain("目标回答的前半部分");
    expect(result.text).not.toContain("另一个回答");
    expect(result.author).toBe("目标作者");
    expect(result.title).toContain("如何评价示例问题");
  });

  it("excludes actions and comments from the extracted text", () => {
    restore = withDom(FIXTURE, ZHIHU_URL);
    const result = pageScript(params("extract")) as PageExtractResult;
    expect(result.text).not.toContain("热评第一条");
    expect(result.text).not.toContain("赞同 999");
    expect(result.text).not.toContain("更多回答推荐");
  });

  it("does not treat answer 22 as a match for answer 222", () => {
    restore = withDom(FIXTURE, "https://www.zhihu.com/question/999/answer/22");
    const p = zhihuAdapter.extractParams(
      new URL("https://www.zhihu.com/question/999/answer/22"),
      null,
    );
    const result = pageScript({ action: "extract", ...p, maxChars: 100_000 }) as PageExtractResult;
    expect(result.found).toBe(false);
  });

  it("returns found=false when the requested answer id is absent from the page", () => {
    restore = withDom(FIXTURE, "https://www.zhihu.com/question/999/answer/333");
    const p = zhihuAdapter.extractParams(
      new URL("https://www.zhihu.com/question/999/answer/333"),
      null,
    );
    const result = pageScript({ action: "extract", ...p, maxChars: 100_000 }) as PageExtractResult;
    expect(result.found).toBe(false);
    expect(result.matchedContentId).toBe(false);
  });

  it("reports the visible expand control of the target answer", () => {
    restore = withDom(FIXTURE, ZHIHU_URL);
    const result = pageScript(params("extract")) as PageExtractResult;
    expect(result.visibleExpandControls).toBe(1);
  });

  it("clicks 阅读全文 only inside the target container (regression: duplicate buttons)", () => {
    restore = withDom(FIXTURE, ZHIHU_URL);
    const doc = (globalThis as Record<string, unknown>)["document"] as Document;

    let clicked111 = 0;
    let clicked222 = 0;
    const btn111 = doc.getElementById("expand-111") as HTMLButtonElement;
    const btn222 = doc.getElementById("expand-222") as HTMLButtonElement;
    btn111.addEventListener("click", () => {
      clicked111++;
    });
    btn222.addEventListener("click", () => {
      clicked222++;
      const p = doc.getElementById("target-collapsed") as HTMLElement;
      p.textContent =
        "这是目标回答的前半部分内容，讲述了问题的背景和作者的基本观点。" +
        "这是展开后才能看到的后半部分，包含了详细的论证过程和最终结论。全文完。";
      btn222.remove();
    });

    const expand = pageScript(params("expand")) as PageExpandResult;
    expect(expand.clicked).toBe(1);
    expect(clicked222).toBe(1);
    expect(clicked111).toBe(0);
    expect(expand.remaining).toBe(0);

    const after = pageScript(params("extract")) as PageExtractResult;
    expect(after.text).toContain("后半部分");
    expect(after.text).toContain("全文完");
    expect(after.visibleExpandControls).toBe(0);
  });
});

describe("generic adapter", () => {
  it("extracts trailing numeric content ids from urls", () => {
    expect(genericContentIdFromUrl(new URL("https://e.com/article/12345"))).toBe("12345");
    expect(genericContentIdFromUrl(new URL("https://e.com/p/9876/comments"))).toBe("9876");
    expect(genericContentIdFromUrl(new URL("https://e.com/about"))).toBeNull();
  });

  it("requires an exact path segment for content ids", () => {
    const requested = new URL("https://example.com/article/123");
    expect(genericAdapter.verifyFinalUrl(requested, new URL("https://example.com/article/123"))).toBe(
      true,
    );
    expect(
      genericAdapter.verifyFinalUrl(requested, new URL("https://example.com/article/12345")),
    ).toBe(false);
  });

  it("rejects a same-host redirect to a different non-numeric article path", () => {
    expect(
      genericAdapter.verifyFinalUrl(
        new URL("https://example.com/article/original"),
        new URL("https://example.com/article/other"),
      ),
    ).toBe(false);
  });

  it("allows www <-> apex canonicalisation only", () => {
    const hosts = genericAdapter.allowedFinalHosts(new URL("https://www.example.com/a"));
    expect(hosts).toContain("www.example.com");
    expect(hosts).toContain("example.com");
    expect(hosts).toHaveLength(2);
  });

  it("extracts article content and skips nav/comments", () => {
    const html = `<!DOCTYPE html><html><head><title>测试文章</title></head><body>
      <nav>首页 分类 关于</nav>
      <article>
        <h1>测试文章标题</h1>
        <p>${"这是文章的正文段落，内容足够长以便通过密度检查。".repeat(5)}
          <img src="diagram.png" alt="文章结构示意图">
        </p>
        <p>这是第二个段落，文章在这里自然结束。</p>
        <div class="comment-list"><p>评论：写得不错</p></div>
      </article>
      <footer>版权信息</footer>
    </body></html>`;
    restore = withDom(html, "https://example.com/article/123");
    const p = genericAdapter.extractParams(new URL("https://example.com/article/123"), null);
    const result = pageScript({ action: "extract", ...p, maxChars: 100_000 }) as PageExtractResult;
    expect(result.found).toBe(true);
    expect(result.text).toContain("正文段落");
    expect(result.text).toContain("[图片：文章结构示意图]");
    expect(result.text).toContain("自然结束");
    expect(result.text).not.toContain("评论：写得不错");
    expect(result.text).not.toContain("首页 分类");
  });
});
