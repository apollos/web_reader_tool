import { describe, expect, it } from "vitest";
import {
  endsTruncated,
  normalizeText,
  verifyCompleteness,
  verifyIdentity,
} from "../src/page-verifier.js";
import type { PageExtractResult } from "../src/types.js";

function read(overrides: Partial<PageExtractResult> = {}): PageExtractResult {
  const text =
    "这是一篇完整的文章正文。它有足够的长度来通过最小长度检查，" +
    "并且以一个自然的句号结束。这里再补充一些内容，让它超过两百个字符。" +
    "文章讨论了一个具体的问题，给出了论据，并且在结尾做了总结。" +
    "以上就是全部内容，感谢阅读。";
  return {
    url: "https://example.com/article/123",
    found: true,
    selectorDescription: "article",
    matchedContentId: true,
    title: "示例标题",
    author: "示例作者",
    text,
    textChars: text.length,
    visibleExpandControls: 0,
    hitMaxChars: false,
    ...overrides,
  };
}

describe("normalizeText", () => {
  it("removes zero-width chars and collapses whitespace", () => {
    expect(normalizeText("a\u200b b\u00a0 c\r\n\n\n\nd")).toBe("a b c\n\nd");
  });
});

describe("endsTruncated", () => {
  it("flags ellipsis and expand-control residue", () => {
    expect(endsTruncated("正文被截断了...").truncated).toBe(true);
    expect(endsTruncated("正文被截断了…").truncated).toBe(true);
    expect(endsTruncated("部分内容 阅读全文").truncated).toBe(true);
    expect(endsTruncated("请登录后继续查看").truncated).toBe(true);
  });

  it("accepts a natural ending", () => {
    expect(endsTruncated("这是完整的结尾。").truncated).toBe(false);
  });
});

describe("verifyCompleteness", () => {
  const base = {
    requireComplete: true,
    minContentChars: 100,
    expandsClicked: 0,
  };

  it("returns complete for two identical stable reads", () => {
    const a = read();
    const r = verifyCompleteness({ ...base, readA: a, readB: read() });
    expect(r.completeness).toBe("complete");
  });

  it("returns partial when reads differ", () => {
    const r = verifyCompleteness({
      ...base,
      readA: read({ text: "第一次读取的内容。", textChars: 9 }),
      readB: read(),
    });
    expect(r.completeness).toBe("partial");
  });

  it("returns partial when expand controls remain visible", () => {
    const a = read({ visibleExpandControls: 1 });
    const r = verifyCompleteness({ ...base, readA: a, readB: a });
    expect(r.completeness).toBe("partial");
  });

  it("returns partial when the extraction cap was hit", () => {
    const a = read({ hitMaxChars: true });
    const r = verifyCompleteness({ ...base, readA: a, readB: a });
    expect(r.completeness).toBe("partial");
  });

  it("returns partial when page navigated between reads", () => {
    const r = verifyCompleteness({
      ...base,
      readA: read({ url: "https://example.com/article/123" }),
      readB: read({ url: "https://example.com/other" }),
    });
    expect(r.completeness).toBe("partial");
  });

  it("returns partial for truncated endings", () => {
    const a = read({ text: read().text + " 展开全文" });
    const r = verifyCompleteness({ ...base, readA: a, readB: a });
    expect(r.completeness).toBe("partial");
  });

  it("returns unknown when content is below the length threshold", () => {
    const a = read({ text: "很短的正文。", textChars: 6 });
    const r = verifyCompleteness({ ...base, readA: a, readB: a });
    expect(r.completeness).toBe("unknown");
  });

  it("returns none when nothing was extracted", () => {
    const a = read({ text: "", textChars: 0 });
    const r = verifyCompleteness({ ...base, readA: a, readB: a });
    expect(r.completeness).toBe("none");
  });

  it("never maps partial/unknown to complete", () => {
    const partial = verifyCompleteness({
      ...base,
      readA: read({ visibleExpandControls: 2 }),
      readB: read({ visibleExpandControls: 2 }),
    });
    expect(partial.completeness).not.toBe("complete");
  });

  it("does not weaken browser_verified semantics when requireComplete is false", () => {
    const a = read({ text: "这段内容稳定而且足够长但是突然停止".repeat(10) });
    const r = verifyCompleteness({ ...base, requireComplete: false, readA: a, readB: a });
    expect(r.completeness).toBe("unknown");
  });
});

describe("verifyIdentity", () => {
  const base = {
    adapterName: "generic",
    targetContentId: "123",
    requireContentIdMatch: true,
    finalUrlOk: true,
  };

  it("passes when content id matched and hints align", () => {
    const r = verifyIdentity({
      ...base,
      hint: { title: "示例标题", author: "示例作者", content_id: "123", keywords: ["总结"] },
      read: read(),
    });
    expect(r.ok).toBe(true);
  });

  it("fails when target content id is not in the container", () => {
    const r = verifyIdentity({ ...base, hint: null, read: read({ matchedContentId: false }) });
    expect(r.ok).toBe(false);
  });

  it("tolerates missing DOM id when the adapter does not require it (generic)", () => {
    const r = verifyIdentity({
      ...base,
      requireContentIdMatch: false,
      hint: null,
      read: read({ matchedContentId: false }),
    });
    expect(r.ok).toBe(true);
  });

  it("fails when the final url does not match the target", () => {
    const r = verifyIdentity({ ...base, finalUrlOk: false, hint: null, read: read() });
    expect(r.ok).toBe(false);
  });

  it("fails when a keyword hint is missing from the content", () => {
    const r = verifyIdentity({
      ...base,
      hint: { title: null, author: null, content_id: null, keywords: ["不存在的关键词"] },
      read: read(),
    });
    expect(r.ok).toBe(false);
  });

  it("does not accept title or author hints merely because they occur in body text", () => {
    const r = verifyIdentity({
      ...base,
      hint: { title: "正文里的旧标题", author: "正文提及的作者", content_id: null, keywords: [] },
      read: read({ text: `${read().text} 正文里的旧标题 正文提及的作者` }),
    });
    expect(r.ok).toBe(false);
  });
});
