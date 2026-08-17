import { describe, expect, it } from "vitest";
import { UsageError, buildReadInput, parseArgs, validateReadInput } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses subcommand with value flags and boolean flags", () => {
    const p = parseArgs(["read", "--url", "https://e.com/a", "--keyword", "k1", "--keyword", "k2", "--no-require-complete"]);
    expect(p.command).toBe("read");
    expect(p.flags.get("--url")).toEqual(["https://e.com/a"]);
    expect(p.flags.get("--keyword")).toEqual(["k1", "k2"]);
    expect(p.booleans.has("--no-require-complete")).toBe(true);
  });

  it("rejects missing subcommand and dangling flags", () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(["read", "--url"])).toThrow(/requires a value/);
    expect(() => parseArgs(["read", "positional"])).toThrow(/unexpected argument/);
  });
});

describe("buildReadInput", () => {
  it("builds input from --url with hint flags", () => {
    const p = parseArgs([
      "read",
      "--url", "https://e.com/article/9",
      "--fallback-type", "http_403",
      "--fallback-detail", "web_fetch returned 403",
      "--content-id", "9",
      "--keyword", "关键词",
    ]);
    const input = buildReadInput(p, null);
    expect(input.url).toBe("https://e.com/article/9");
    expect(input.fallback_reason).toEqual({ type: "http_403", detail: "web_fetch returned 403" });
    expect(input.target_hint?.content_id).toBe("9");
    expect(input.target_hint?.keywords).toEqual(["关键词"]);
    expect(input.require_complete).toBe(true);
  });

  it("builds input from --input json", () => {
    const json = JSON.stringify({
      url: "https://e.com/a",
      fallback_reason: { type: "js_shell" },
      target_hint: { content_id: 123, keywords: ["x"] },
      require_complete: false,
      max_wait_ms: 10000,
    });
    const p = parseArgs(["read", "--input", json]);
    const input = buildReadInput(p, null);
    expect(input.url).toBe("https://e.com/a");
    expect(input.target_hint?.content_id).toBe("123");
    expect(input.require_complete).toBe(false);
    expect(input.max_wait_ms).toBe(10000);
  });

  it("reads JSON input from a separately supplied environment variable", () => {
    process.env["VWR_TEST_INPUT"] = JSON.stringify({ url: "https://e.com/safe" });
    try {
      const input = buildReadInput(parseArgs(["read", "--input-env", "VWR_TEST_INPUT"]), null);
      expect(input.url).toBe("https://e.com/safe");
    } finally {
      delete process.env["VWR_TEST_INPUT"];
    }
  });

  it("requires exactly one input source", () => {
    expect(() => buildReadInput(parseArgs(["read"]), null)).toThrow(/requires/);
    expect(() =>
      buildReadInput(parseArgs(["read", "--url", "https://e.com", "--input", "{}"]), null),
    ).toThrow(/exactly one/);
  });

  it("rejects malformed json input", () => {
    expect(() => buildReadInput(parseArgs(["read", "--input", "{not json"]), null)).toThrow(
      /valid JSON/,
    );
  });
});

describe("validateReadInput", () => {
  it("requires a url string", () => {
    expect(() => validateReadInput({})).toThrow(/url/);
    expect(() => validateReadInput({ url: 42 })).toThrow(/url/);
    expect(() => validateReadInput("https://e.com")).toThrow(/object/);
    expect(() => validateReadInput(null)).toThrow(/object/);
  });

  it("validates fallback_reason shape", () => {
    expect(() => validateReadInput({ url: "https://e.com", fallback_reason: "http_403" })).toThrow(
      /fallback_reason/,
    );
    expect(() => validateReadInput({ url: "https://e.com", fallback_reason: {} })).toThrow(
      /fallback_reason/,
    );
  });

  it("validates max_wait_ms bounds", () => {
    expect(() => validateReadInput({ url: "https://e.com", max_wait_ms: 50 })).toThrow(
      /max_wait_ms/,
    );
    expect(() => validateReadInput({ url: "https://e.com", max_wait_ms: 999_999 })).toThrow(
      /max_wait_ms/,
    );
    expect(validateReadInput({ url: "https://e.com", max_wait_ms: 20_000 }).max_wait_ms).toBe(
      20_000,
    );
  });

  it("validates keyword array type", () => {
    expect(() =>
      validateReadInput({ url: "https://e.com", target_hint: { keywords: [1, 2] } }),
    ).toThrow(/keywords/);
  });
});
