/**
 * SSRF protection (design §16.1):
 * - http/https only, no embedded credentials, no control characters;
 * - reject localhost, .local/.localhost, loopback, private, link-local,
 *   CGNAT, multicast, reserved ranges and cloud metadata addresses;
 * - DNS resolution: every resolved address must be public;
 * - the same check is re-applied to the final URL after browser navigation.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

export interface UrlSafetyOptions {
  /** Skip DNS resolution (used in unit tests / for the final-URL host equality check). */
  resolveDns?: boolean;
}

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
  url?: URL;
}

/** Control chars, whitespace and backticks. `$` / quotes are allowed: CLI uses argv arrays. */
const UNSAFE_URL_CHARS = /[\u0000-\u001f\u007f`\\\s]/;

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 doc
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51) return true; // 198.51.100/24 doc
  if (a === 203 && b === 0) return true; // 203.0.113/24 doc
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const words = parseIPv6Words(ip);
  if (!words) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // Unspecified, loopback, IPv4-compatible and IPv4-mapped space.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0) {
    if (w5 === 0 || w5 === 0xffff) {
      const v4 = `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
      return w5 === 0 ? true : isPrivateIPv4(v4);
    }
  }
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w0 & 0xffc0) === 0xfec0) return true; // deprecated site-local
  if ((w0 & 0xff00) === 0xff00) return true; // multicast
  if (w0 === 0x0064 && w1 === 0xff9b) return true; // NAT64 well-known/local-use
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true; // discard-only
  if (w0 === 0x2001 && w1 < 0x0200) return true; // IETF special-purpose /23
  if (w0 === 0x2001 && w1 === 0x0db8) return true; // documentation
  if (w0 === 0x2002) return true; // 6to4 can embed private IPv4
  return false;
}

function parseIPv6Words(raw: string): [number, number, number, number, number, number, number, number] | null {
  let input = raw.toLowerCase();
  const zone = input.indexOf("%");
  if (zone !== -1) input = input.slice(0, zone);
  const dotted = input.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split(".").map((v) => Number.parseInt(v, 10));
    if (octets.length !== 4 || octets.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return null;
    const a = octets as [number, number, number, number];
    input =
      input.slice(0, -dotted.length) +
      `${((a[0] << 8) | a[1]).toString(16)}:${((a[2] << 8) | a[3]).toString(16)}`;
  }
  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = input.split("::") as [string, string | undefined];
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((rightRaw === undefined && missing !== 0) || missing < 0) return null;
  const all = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (all.length !== 8 || all.some((v) => !/^[0-9a-f]{1,4}$/.test(v))) return null;
  return all.map((v) => Number.parseInt(v, 16)) as [number, number, number, number, number, number, number, number];
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/** RFC1918 / ULA only — not link-local, CGNAT, or documentation ranges. */
export function isTunnelablePrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return false;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isTunnelablePrivateAddress(mapped[1]);
    return lower.startsWith("fc") || lower.startsWith("fd");
  }
  return false;
}

function isForbiddenHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "" || h === "localhost") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal" || h.endsWith(".internal")) return true;
  return false;
}

export async function checkUrlSafety(
  raw: string,
  options: UrlSafetyOptions = {},
): Promise<UrlSafetyResult> {
  const { resolveDns = true } = options;

  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "empty url" };
  }
  if (raw.length > 4096) {
    return { ok: false, reason: "url too long" };
  }
  if (UNSAFE_URL_CHARS.test(raw)) {
    return { ok: false, reason: "url contains control, whitespace or backtick characters" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "url is not parseable" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "url must not embed credentials" };
  }

  // Strip IPv6 brackets for address classification.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isForbiddenHostname(hostname)) {
    return { ok: false, reason: `hostname ${hostname} is forbidden` };
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      return { ok: false, reason: `ip address ${hostname} is not public` };
    }
    return { ok: true, url };
  }

  if (resolveDns) {
    let addrs: { address: string }[];
    try {
      addrs = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      return { ok: false, reason: `dns resolution failed for ${hostname}` };
    }
    if (addrs.length === 0) {
      return { ok: false, reason: `dns returned no addresses for ${hostname}` };
    }
    for (const { address } of addrs) {
      if (isPrivateAddress(address)) {
        return { ok: false, reason: `hostname ${hostname} resolves to non-public address` };
      }
    }
  }

  return { ok: true, url };
}

export function pathHasExactSegment(pathname: string, segment: string): boolean {
  if (!segment) return false;
  return pathname.split("/").filter((s) => s.length > 0).includes(segment);
}

export function pathHasConsecutiveSegments(pathname: string, segments: string[]): boolean {
  if (segments.length === 0) return false;
  const parts = pathname.split("/").filter((s) => s.length > 0);
  for (let i = 0; i <= parts.length - segments.length; i++) {
    if (segments.every((s, j) => parts[i + j] === s)) return true;
  }
  return false;
}

export function searchHasExactValue(url: URL, value: string): boolean {
  if (!value) return false;
  for (const v of url.searchParams.values()) {
    if (v === value) return true;
  }
  return false;
}

function isLoopbackIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  return parts.length === 4 && parts[0] === 127;
}

function isLoopbackAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isLoopbackIPv4(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isLoopbackIPv4(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex?.[1] && mappedHex[2]) {
      const hi = Number.parseInt(mappedHex[1], 16);
      return hi >> 8 === 127;
    }
  }
  return false;
}

function isMetadataAddress(ip: string): boolean {
  return ip === "169.254.169.254" || ip.toLowerCase() === "::ffff:169.254.169.254";
}

/**
 * CDP / control-plane endpoints (design §10.2): loopback, RFC1918/ULA private,
 * or localhost — never a public address or cloud metadata.
 */
export async function checkControlPlaneEndpoint(
  raw: string,
  options: UrlSafetyOptions = {},
): Promise<UrlSafetyResult> {
  const { resolveDns = true } = options;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "empty control-plane url" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "control-plane url is not parseable" };
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    return { ok: false, reason: `control-plane scheme ${url.protocol} not allowed` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "control-plane url must not embed credentials" };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: true, url };
  }
  if (hostname === "metadata.google.internal" || hostname.endsWith(".internal")) {
    return { ok: false, reason: `control-plane host ${hostname} is forbidden` };
  }

  if (net.isIP(hostname)) {
    if (isMetadataAddress(hostname)) {
      return { ok: false, reason: "control-plane url must not target cloud metadata" };
    }
    if (isLoopbackAddress(hostname) || isTunnelablePrivateAddress(hostname)) {
      return { ok: true, url };
    }
    return { ok: false, reason: `control-plane ip ${hostname} is not loopback or private` };
  }

  if (resolveDns) {
    let addrs: { address: string }[];
    try {
      addrs = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      return { ok: false, reason: `dns resolution failed for ${hostname}` };
    }
    if (addrs.length === 0) {
      return { ok: false, reason: `dns returned no addresses for ${hostname}` };
    }
    for (const { address } of addrs) {
      if (isMetadataAddress(address)) {
        return { ok: false, reason: `control-plane host ${hostname} resolves to metadata` };
      }
      if (!isLoopbackAddress(address) && !isTunnelablePrivateAddress(address)) {
        return { ok: false, reason: `control-plane host ${hostname} resolves to a public address` };
      }
    }
  }

  return { ok: true, url };
}
