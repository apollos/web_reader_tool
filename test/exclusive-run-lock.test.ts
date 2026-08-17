import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExclusiveRunLock } from "../src/exclusive-run-lock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ExclusiveRunLock", () => {
  it("serializes access to one managed browser profile", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vwr-lock-"));
    dirs.push(base);
    const first = new ExclusiveRunLock(base, "verified-reader", 60_000);
    const second = new ExclusiveRunLock(base, "verified-reader", 60_000);
    expect(await first.acquire(50, async () => {})).toBe(true);
    expect(await second.acquire(1, async () => {})).toBe(false);
    first.release();
    expect(await second.acquire(50, async () => {})).toBe(true);
    second.release();
  });

  it("refreshes the lock so a healthy long read is not treated as stale", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vwr-lock-refresh-"));
    const lock = new ExclusiveRunLock(root, "profile", 20);
    try {
      expect(await lock.acquire(10, async () => {})).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 15));
      lock.refresh();
      const contender = new ExclusiveRunLock(root, "profile", 20);
      expect(await contender.acquire(1, async () => {})).toBe(false);
    } finally {
      lock.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
