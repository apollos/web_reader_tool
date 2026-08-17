import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempChunkStore } from "../src/temp-chunk-store.js";

const TTL = 15 * 60_000;

describe("TempChunkStore", () => {
  let baseDir: string;
  let store: TempChunkStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "vwr-test-"));
    store = new TempChunkStore(TTL, baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("stores, reads back and cleans up chunks", () => {
    const runId = randomUUID();
    const content = "x".repeat(2500);
    const { chunkCount, expiresAt } = store.store(runId, "https://example.com/a", content, 1000);
    expect(chunkCount).toBe(3);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    expect(store.readChunk(runId, 0).content).toBe("x".repeat(1000));
    expect(store.readChunk(runId, 2).content).toBe("x".repeat(500));

    expect(store.cleanup(runId)).toBe(true);
    expect(() => store.readChunk(runId, 0)).toThrow(/expired or cleaned up/);
  });

  it("applies 0700/0600 permissions", () => {
    const runId = randomUUID();
    store.store(runId, "https://example.com/a", "hello", 1000);
    const dir = path.join(baseDir, runId);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "chunk-0.txt")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
  });

  it("redacts sensitive query params in the manifest", () => {
    const runId = randomUUID();
    store.store(runId, "https://example.com/a?token=SECRET123&x=1", "hello", 1000);
    const manifest = fs.readFileSync(path.join(baseDir, runId, "manifest.json"), "utf8");
    expect(manifest).not.toContain("SECRET123");
    expect(manifest).toContain("token=REDACTED");
  });

  it("rejects non-UUID run ids (no path traversal)", () => {
    expect(() => store.readChunk("../../etc", 0)).toThrow(/UUID/);
    expect(() => store.cleanup("..%2f..")).toThrow(/UUID/);
    expect(() => store.store("../evil", "https://e.com", "x", 100)).toThrow(/UUID/);
  });

  it("rejects out-of-range chunk indexes", () => {
    const runId = randomUUID();
    store.store(runId, "https://example.com/a", "hello", 1000);
    expect(() => store.readChunk(runId, 5)).toThrow(/out of range/);
    expect(() => store.readChunk(runId, -1)).toThrow(/out of range/);
  });

  it("sweeps expired run dirs but keeps fresh ones", () => {
    const fresh = randomUUID();
    const stale = randomUUID();
    store.store(fresh, "https://example.com/a", "fresh", 1000);
    store.store(stale, "https://example.com/b", "stale", 1000);

    // Age the stale manifest beyond its TTL.
    const manifestPath = path.join(baseDir, stale, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.expires_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const removed = store.sweepExpired();
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(baseDir, fresh))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, stale))).toBe(false);
  });

  it("expired content refuses to be read and is removed", () => {
    const runId = randomUUID();
    store.store(runId, "https://example.com/a", "hello", 1000);
    const manifestPath = path.join(baseDir, runId, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.expires_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => store.readChunk(runId, 0)).toThrow(/expired/);
    expect(fs.existsSync(path.join(baseDir, runId))).toBe(false);
  });

  it("rejects content that exceeds the max temp size", () => {
    const tiny = new TempChunkStore(TTL, baseDir, 32);
    expect(() => tiny.store(randomUUID(), "https://example.com/a", "x".repeat(200), 50)).toThrow(
      /max temp size/,
    );
  });

  it("does not split UTF-16 surrogate pairs across chunks", () => {
    const runId = randomUUID();
    const original = "A💡B";
    const stored = store.store(runId, "https://example.com/a", original, 2);
    const joined = Array.from(
      { length: stored.chunkCount },
      (_, index) => store.readChunk(runId, index).content,
    ).join("");
    expect(joined).toBe(original);
  });
});
