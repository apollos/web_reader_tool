import { describe, expect, it } from "vitest";
import { redactUrl, sanitizeAuditText } from "../src/log.js";

describe("URL and audit redaction", () => {
  it("redacts sensitive query values and fragments", () => {
    const redacted = redactUrl(
      "https://example.com/a?x-amz-signature=secret&normal=ok#private-fragment",
    );
    expect(redacted).toContain("x-amz-signature=REDACTED");
    expect(redacted).toContain("normal=ok");
    expect(redacted).toContain("#REDACTED");
    expect(redacted).not.toContain("private-fragment");
  });

  it("redacts URLs embedded in fallback diagnostics", () => {
    const text = sanitizeAuditText(
      "web_fetch failed for https://example.com/a?token=secret-value with 403",
    );
    expect(text).toContain("token=REDACTED");
    expect(text).not.toContain("secret-value");
  });
});
