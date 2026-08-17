import { describe, expect, it } from "vitest";
import {
  checkControlPlaneEndpoint,
  checkUrlSafety,
  isPrivateIPv4,
  isPrivateIPv6,
  pathHasExactSegment,
} from "../src/url-safety.js";

const noDns = { resolveDns: false };

describe("checkUrlSafety", () => {
  it("accepts a normal public https url", async () => {
    const r = await checkUrlSafety("https://example.com/article/123", noDns);
    expect(r.ok).toBe(true);
  });

  it("rejects non-http(s) schemes", async () => {
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)"]) {
      const r = await checkUrlSafety(url, noDns);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects embedded credentials", async () => {
    const r = await checkUrlSafety("https://user:pass@example.com/a", noDns);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/credentials/);
  });

  it("rejects localhost and .local/.internal hostnames", async () => {
    for (const url of [
      "http://localhost/admin",
      "http://foo.localhost/x",
      "http://printer.local/x",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      const r = await checkUrlSafety(url, noDns);
      expect(r.ok, url).toBe(false);
    }
  });

  it("rejects loopback, private, link-local and metadata IPs", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://10.1.2.3/x",
      "http://172.16.0.9/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/x",
      "http://0.0.0.0/x",
      "http://[::1]/x",
      "http://[fd00::1]/x",
      "http://[fe80::1]/x",
      "http://[::ffff:10.0.0.1]/x",
    ]) {
      const r = await checkUrlSafety(url, noDns);
      expect(r.ok, url).toBe(false);
    }
  });

  it("rejects backticks, control chars and whitespace but allows $ in queries", async () => {
    for (const url of [
      "https://example.com/a`b",
      "https://example.com/a\nb",
      "https://example.com/a b",
    ]) {
      const r = await checkUrlSafety(url, noDns);
      expect(r.ok, JSON.stringify(url)).toBe(false);
    }
    expect((await checkUrlSafety("https://example.com/search?q=$100", noDns)).ok).toBe(true);
    expect((await checkUrlSafety("https://example.com/a'b", noDns)).ok).toBe(true);
  });

  it("rejects empty and oversized urls", async () => {
    expect((await checkUrlSafety("", noDns)).ok).toBe(false);
    expect((await checkUrlSafety(`https://example.com/${"a".repeat(5000)}`, noDns)).ok).toBe(false);
  });
});

describe("ip range classification", () => {
  it("classifies IPv4 ranges", () => {
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("1.2.3.4")).toBe(false);
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("192.0.2.1")).toBe(true);
    expect(isPrivateIPv4("198.18.0.1")).toBe(true);
    expect(isPrivateIPv4("224.0.0.1")).toBe(true);
    expect(isPrivateIPv4("255.255.255.255")).toBe(true);
  });

  it("classifies IPv6 ranges", () => {
    expect(isPrivateIPv6("2600:1f18::1")).toBe(false);
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("ff02::1")).toBe(true);
    expect(isPrivateIPv6("2001:db8::1")).toBe(true);
    expect(isPrivateIPv6("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("pathHasExactSegment", () => {
  it("does not treat 123 as a prefix of 12345", () => {
    expect(pathHasExactSegment("/article/12345", "123")).toBe(false);
    expect(pathHasExactSegment("/article/123", "123")).toBe(true);
  });
});

describe("checkControlPlaneEndpoint", () => {
  it("allows loopback and RFC1918 CDP urls", async () => {
    expect((await checkControlPlaneEndpoint("http://127.0.0.1:9222")).ok).toBe(true);
    expect((await checkControlPlaneEndpoint("http://192.168.1.8:9222")).ok).toBe(true);
    expect((await checkControlPlaneEndpoint("ws://127.0.0.1:9222/devtools/page/1")).ok).toBe(true);
    expect((await checkControlPlaneEndpoint("http://localhost:9222", noDns)).ok).toBe(true);
  });

  it("rejects public, metadata and credentialed CDP urls", async () => {
    expect((await checkControlPlaneEndpoint("http://8.8.8.8:9222")).ok).toBe(false);
    expect((await checkControlPlaneEndpoint("http://169.254.169.254:80")).ok).toBe(false);
    expect((await checkControlPlaneEndpoint("http://user:pass@127.0.0.1:9222")).ok).toBe(false);
  });
});
