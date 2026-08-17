import { describe, expect, it } from "vitest";
import {
  BrowserUnavailableError,
  NavigationError,
  OpenClawClient,
  UnsafeNavigationError,
  classifyOpenclawError,
  assertSafeBrowserRequest,
  openclawArgs,
  parseJsonFromOutput,
  processPausedRequest,
  selectOpenClawTabReference,
} from "../src/browser-client.js";
import { buildPageExpression, pageScript } from "../src/browser-page-script.js";
import { loadConfig } from "../src/config.js";

describe("openclaw argv construction (no shell, design §16.2)", () => {
  it("builds pure argv arrays for every subcommand", () => {
    const profile = "verified-reader";
    for (const args of [
      openclawArgs.status(profile),
      openclawArgs.start(profile),
      openclawArgs.stop(profile),
      openclawArgs.open(profile, "https://example.com/a"),
      openclawArgs.focus(profile, "tab-1"),
      openclawArgs.evaluate(profile, "() => document.readyState", "tab-1"),
      openclawArgs.close(profile, "tab-1"),
    ]) {
      expect(Array.isArray(args)).toBe(true);
      for (const a of args) expect(typeof a).toBe("string");
    }
  });

  it("passes --target-id to evaluate", () => {
    const args = openclawArgs.evaluate("verified-reader", "() => 1", "tab-xyz");
    expect(args).toContain("--target-id");
    expect(args).toContain("tab-xyz");
    expect(args).toContain("--fn");
  });

  it("classifies evaluate/open failures as navigation unless the gateway is down", () => {
    const evalErr = classifyOpenclawError(
      ["browser", "evaluate"],
      new Error("page crashed"),
    );
    expect(evalErr).toBeInstanceOf(NavigationError);
    const gwErr = classifyOpenclawError(
      ["browser", "evaluate"],
      new Error("GatewayTransportError: gateway closed (1006"),
    );
    expect(gwErr).toBeInstanceOf(BrowserUnavailableError);
    expect(
      classifyOpenclawError(["browser", "evaluate"], new Error("gateway closed (1000 normal closure)")),
    ).toBeInstanceOf(BrowserUnavailableError);
    const startErr = classifyOpenclawError(["browser", "start"], new Error("nope"));
    expect(startErr).toBeInstanceOf(BrowserUnavailableError);
  });

  it("keeps a hostile url as one opaque argv element", () => {
    const evil = "https://example.com/$(rm -rf /);'`\"";
    const args = openclawArgs.open("p", evil, "vwr-safe-label");
    expect(args).toContain(evil);
    // The URL is never split or interpolated into another argument.
    expect(args.filter((a) => a.includes("rm -rf"))).toEqual([evil]);
    expect(args).toContain("--label");
    expect(args).toContain("vwr-safe-label");
  });

  it("prefers OpenClaw stable tab handles over the volatile raw target id", () => {
    expect(
      selectOpenClawTabReference({
        suggestedTargetId: "stable",
        tabId: "tab-1",
        targetId: "raw-target",
      }),
    ).toBe("stable");
    expect(selectOpenClawTabReference({ tabId: "tab-1", targetId: "raw-target" })).toBe("tab-1");
  });

  it("rejects an unsafe browser request before it may be continued", async () => {
    await expect(
      assertSafeBrowserRequest("http://169.254.169.254/latest/meta-data", async () => ({
        ok: false,
        reason: "metadata address",
      })),
    ).rejects.toThrow(/before network access/);
    await expect(
      assertSafeBrowserRequest("file:///etc/passwd"),
    ).rejects.toThrow(/scheme file:/);
  });
});

describe("processPausedRequest (CDP fetch guard)", () => {
  function makeIo(check: (raw: string) => Promise<{ ok: boolean; reason?: string; url?: URL }>) {
    const continued: string[] = [];
    const failed: string[] = [];
    return {
      continued,
      failed,
      io: {
        maxRedirects: 2,
        documentRequestsByFrame: new Map<string, number>(),
        continueRequest: async (id: string) => {
          continued.push(id);
        },
        failRequest: async (id: string) => {
          failed.push(id);
        },
        check: check as never,
      },
    };
  }

  const unsafeCheck = async () => ({ ok: false, reason: "dns resolution failed" });
  const safeCheck = async (raw: string) => ({ ok: true, url: new URL(raw) });

  it("blocks an unsafe subresource without failing the task", async () => {
    const { io, continued, failed } = makeIo(unsafeCheck);
    const error = await processPausedRequest(
      {
        requestId: "r1",
        resourceType: "Image",
        request: { url: "http://dead-ad-domain.example/pixel.gif" },
      },
      io,
    );
    expect(error).toBeNull();
    expect(failed).toEqual(["r1"]);
    expect(continued).toEqual([]);
  });

  it("fails the task when the blocked request is the document navigation", async () => {
    const { io, failed } = makeIo(unsafeCheck);
    const error = await processPausedRequest(
      {
        requestId: "r1",
        resourceType: "Document",
        request: { url: "http://169.254.169.254/latest/meta-data" },
      },
      io,
    );
    expect(error).toBeInstanceOf(UnsafeNavigationError);
    expect(failed).toEqual(["r1"]);
  });

  it("continues a safe document request", async () => {
    const { io, continued } = makeIo(safeCheck);
    const error = await processPausedRequest(
      {
        requestId: "r1",
        frameId: "f1",
        resourceType: "Document",
        request: { url: "https://example.com/article/1" },
      },
      io,
    );
    expect(error).toBeNull();
    expect(continued).toEqual(["r1"]);
  });

  it("enforces the document redirect limit per frame", async () => {
    const { io, failed } = makeIo(safeCheck);
    let lastError: Error | null = null;
    for (let i = 0; i < 4; i++) {
      lastError = await processPausedRequest(
        {
          requestId: `r${i}`,
          frameId: "f1",
          resourceType: "Document",
          request: { url: `https://example.com/hop/${i}` },
        },
        io,
      );
    }
    expect(lastError).toBeInstanceOf(NavigationError);
    expect(lastError?.message).toMatch(/too many document redirects/);
    expect(failed).toEqual(["r3"]);
  });
});

describe("OpenClawClient.openTab cleanup on open failure", () => {
  it("closes the labelled tab when the open command itself fails", async () => {
    const config = loadConfig({});
    const client = new OpenClawClient(config);
    const calls: string[][] = [];
    (client as unknown as {
      run: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
    }).run = async (args: string[]) => {
      calls.push(args);
      if (args[1] === "open") {
        throw new NavigationError("openclaw browser open failed: command timed out");
      }
      return { stdout: "{}", stderr: "" };
    };

    await expect(client.openTab("https://example.com/a", 1000)).rejects.toThrow(/timed out/);

    const closeCall = calls.find((args) => args[1] === "close");
    expect(closeCall).toBeDefined();
    // The close uses the unique vwr- label generated before open.
    expect(closeCall?.[2]).toMatch(/^vwr-/);
  });
});

describe("page expression building (fixed script, JSON-only params)", () => {
  it("serialises params as a JSON literal", () => {
    const expr = buildPageExpression({
      action: "extract",
      targetContentId: `123"; alert(1); //`,
      containerSelectors: ["article"],
    });
    // The hostile value must appear JSON-escaped, not as raw code.
    expect(expr).toContain('123\\"; alert(1); //');
    expect(expr).not.toContain('123"; alert(1); //');
    expect(expr.startsWith(`(${pageScript.toString()})(`)).toBe(true);
  });

  it("the page script source contains no eval or Function constructor", () => {
    const src = pageScript.toString();
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new\s+Function/);
  });
});

describe("parseJsonFromOutput", () => {
  it("parses clean json", () => {
    expect(parseJsonFromOutput('{"running":true}')).toEqual({ running: true });
  });

  it("parses the last json line from mixed output", () => {
    const out = 'starting browser...\nsome log\n{"targetId":"abc"}\n';
    expect(parseJsonFromOutput(out)).toEqual({ targetId: "abc" });
  });

  it("returns null for non-json output", () => {
    expect(parseJsonFromOutput("plain text only")).toBeNull();
  });
});
