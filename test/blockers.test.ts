import { describe, expect, it } from "vitest";
import { detectBlocker, detectHomepageRedirect } from "../src/blockers.js";
import type { PageProbeResult } from "../src/types.js";

function probe(overrides: Partial<PageProbeResult>): PageProbeResult {
  return {
    url: "https://example.com/article/1",
    title: "普通文章标题",
    readyState: "complete",
    textSample: "这是一段普通的正文内容，讲述了一个完整的故事。",
    ...overrides,
  };
}

describe("detectBlocker", () => {
  it("returns null on a normal article page", () => {
    expect(detectBlocker(probe({}))).toBeNull();
  });

  it("does not mistake a navigation-bar login button for a login wall", () => {
    expect(
      detectBlocker(
        probe({ textSample: "首页 立即登录 注册 这是公开文章的完整正文内容。".repeat(20) }),
      ),
    ).toBeNull();
  });

  it("detects login walls", () => {
    const r = detectBlocker(probe({ textSample: "请先登录后查看完整内容" }));
    expect(r?.type).toBe("login_required");
  });

  it("detects captcha / anti-bot interstitials", () => {
    for (const text of [
      "请完成安全验证后继续访问",
      "系统检测到您的网络存在异常,请输入验证码",
      "Checking your browser before accessing example.com",
    ]) {
      const r = detectBlocker(probe({ textSample: text }));
      expect(r?.type, text).toBe("captcha");
    }
  });

  it("prefers captcha over login when both patterns appear", () => {
    const r = detectBlocker(
      probe({ textSample: "系统检测到您的账号存在异常，请输入验证码或登录后重试" }),
    );
    expect(r?.type).toBe("captcha");
  });

  it("detects paywalls", () => {
    const r = detectBlocker(probe({ textSample: "本文为付费内容，开通会员后继续阅读" }));
    expect(r?.type).toBe("paywall");
  });

  it("detects leftover JS-required shells", () => {
    const r = detectBlocker(probe({ textSample: "Please enable JavaScript to continue" }));
    expect(r?.type).toBe("error_page");
  });

  it("detects error pages via title", () => {
    const r = detectBlocker(probe({ title: "404 - 页面不存在" }));
    expect(r?.type).toBe("error_page");
  });

  it("applies site-specific extra rules first", () => {
    const r = detectBlocker(probe({ textSample: "系统监测到您的网络环境存在异常" }), [
      { type: "captcha", pattern: /网络环境存在异常/ },
    ]);
    expect(r?.type).toBe("captcha");
  });
});

describe("detectHomepageRedirect", () => {
  it("flags article request landing on site root", () => {
    const r = detectHomepageRedirect(
      new URL("https://example.com/article/123"),
      new URL("https://example.com/"),
    );
    expect(r?.type).toBe("homepage_redirect");
  });

  it("does not flag a normal article url", () => {
    const r = detectHomepageRedirect(
      new URL("https://example.com/article/123"),
      new URL("https://example.com/article/123"),
    );
    expect(r).toBeNull();
  });
});
