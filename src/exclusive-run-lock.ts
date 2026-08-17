/**
 * Cross-process lock for a managed OpenClaw browser profile.
 *
 * Multiple one-shot CLI processes can otherwise race: both observe a stopped
 * profile, both start it, and one stops it while the other still reads. The
 * lock is an atomic directory, has bounded waiting, and removes stale owners
 * without any daemon or polling service.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class ExclusiveRunLock {
  private readonly token = randomUUID();
  private held = false;
  private readonly lockDir: string;

  constructor(baseDir: string, profile: string, private readonly staleMs: number) {
    const name = createHash("sha256").update(profile).digest("hex").slice(0, 24);
    this.lockDir = path.join(baseDir, "locks", `${name}.lock`);
  }

  async acquire(waitMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
    const parent = path.dirname(this.lockDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
    const deadline = Date.now() + waitMs;

    for (;;) {
      try {
        fs.mkdirSync(this.lockDir, { mode: 0o700 });
        fs.writeFileSync(
          path.join(this.lockDir, "owner.json"),
          JSON.stringify({ token: this.token, pid: process.pid, created_at: new Date().toISOString() }),
          { mode: 0o600 },
        );
        this.held = true;
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
      }

      try {
        const age = Date.now() - fs.statSync(this.lockDir).mtimeMs;
        if (age > this.staleMs) {
          fs.rmSync(this.lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) return false;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  /** Refresh an active owner's mtime so a long but healthy read is not stolen. */
  refresh(): void {
    if (!this.held) return;
    try {
      const owner = JSON.parse(
        fs.readFileSync(path.join(this.lockDir, "owner.json"), "utf8"),
      ) as { token?: string };
      if (owner.token !== this.token) {
        this.held = false;
        throw new Error("browser profile lock ownership changed");
      }
      const now = new Date();
      fs.utimesSync(this.lockDir, now, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.held = false;
      throw error;
    }
  }

  release(): void {
    if (!this.held) return;
    try {
      const owner = JSON.parse(
        fs.readFileSync(path.join(this.lockDir, "owner.json"), "utf8"),
      ) as { token?: string };
      if (owner.token === this.token) fs.rmSync(this.lockDir, { recursive: true, force: true });
    } finally {
      this.held = false;
    }
  }
}
