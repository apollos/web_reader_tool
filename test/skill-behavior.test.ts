import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideFallback,
  mayClaimFullOriginal,
  mayUseSearchAsOriginal,
  shouldRetry,
  type FetchOutcome,
} from "../src/fallback-policy.js";

const okFetch: FetchOutcome = {
  requestedUrl: "https://example.com/article/1",
  ok: true,
  httpStatus: 200,
  finalUrl: "https://example.com/article/1",
  title: "完整文章",
  text: "这是一段足够长的静态正文，连续可理解，没有折叠也没有截断标记，可以直接分析。".repeat(4),
};

describe("Skill fallback policy (design §20.3)", () => {
  it("does not call the CLI when a static article fetch succeeds", () => {
    const d = decideFallback({ userRequestedBrowser: false, fetch: okFetch });
    expect(d.callCli).toBe(false);
  });

  it("calls the CLI once conceptually when web_fetch returns 403", () => {
    const d = decideFallback({
      userRequestedBrowser: false,
      fetch: { ...okFetch, ok: false, httpStatus: 403, error: "Forbidden" },
    });
    expect(d.callCli).toBe(true);
    expect(d.reason).toMatch(/403|Forbidden/);
  });

  it("calls the CLI for an HTTP 200 JS shell", () => {
    const d = decideFallback({
      userRequestedBrowser: false,
      fetch: { ...okFetch, text: "", hasJsShellHint: true },
    });
    expect(d.callCli).toBe(true);
    expect(d.reason).toBe("js_shell");
  });

  it("does not call the CLI just to double-check a complete fetch", () => {
    const d = decideFallback({ userRequestedBrowser: false, fetch: okFetch });
    expect(d.callCli).toBe(false);
    expect(d.skipWebFetch).toBe(false);
  });

  it("forbids claiming a full original on browser_partial", () => {
    expect(mayClaimFullOriginal("browser_partial")).toBe(false);
    expect(mayClaimFullOriginal("browser_verified")).toBe(true);
  });

  it("forbids using a search snippet as the original on captcha", () => {
    expect(mayUseSearchAsOriginal()).toBe(false);
    expect(mayClaimFullOriginal("captcha")).toBe(false);
  });

  it("allows a direct CLI call when the user asked for the browser", () => {
    const d = decideFallback({ userRequestedBrowser: true, fetch: null });
    expect(d.callCli).toBe(true);
    expect(d.skipWebFetch).toBe(true);
    expect(d.reason).toBe("user_requested");
  });

  it("allows at most one transient retry", () => {
    expect(shouldRetry("navigation_failed", 0)).toBe(true);
    expect(shouldRetry("browser_unavailable", 0)).toBe(true);
    expect(shouldRetry("navigation_failed", 1)).toBe(false);
    expect(shouldRetry("captcha", 0)).toBe(false);
    expect(shouldRetry("unsafe_url", 0)).toBe(false);
  });

  it("the skill mandates web_fetch first, honest blockage reporting and browser cleanup", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const skill = fs.readFileSync(
      path.join(here, "..", "skill", "verified-web-reader", "SKILL.md"),
      "utf8",
    );
    // Passive fallback: native web_fetch always comes first.
    expect(skill).toContain("web_fetch");
    expect(skill).toMatch(/首先调用 OpenClaw 原生 `web_fetch`/);
    // Cleanup is unconditional: close the tab, then always stop the browser.
    expect(skill).toMatch(/一律停止浏览器/);
    expect(skill).toMatch(/browser stop/);
    // Honesty rules: no bypassing walls, no impersonating the original.
    expect(skill).toMatch(/不得.*绕过/s);
    expect(skill).toMatch(/搜索摘要|转载/);
    // The built-in browser scheme must not instruct shell-interpolated CLI calls.
    expect(skill).not.toMatch(/verified-browser-read read .*--url/);
  });
});
