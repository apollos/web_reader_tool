/**
 * Temporary chunk store for very long content (design §13).
 *
 * - Directory: $XDG_RUNTIME_DIR/openclaw-vwr/<run_id>/ or
 *   /tmp/openclaw-vwr-<uid>/<run_id>/
 * - Permissions: 0700 dirs, 0600 files.
 * - run_id is a random UUID; user input can never choose paths.
 * - No daemon: expired directories are swept opportunistically on each CLI
 *   start and can be removed explicitly via the `cleanup` subcommand.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactUrl } from "./log.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChunkManifest {
  run_id: string;
  url: string;
  created_at: string;
  expires_at: string;
  chunk_count: number;
  chunk_chars: number;
  content_chars: number;
}

export interface StoreResult {
  chunkCount: number;
  expiresAt: string;
}

/** Split without separating a UTF-16 surrogate pair across files. */
export function splitUnicodeSafe(content: string, chunkChars: number): string[] {
  const size = Math.max(1, chunkChars);
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + size);
    if (
      end < content.length &&
      end > start &&
      content.charCodeAt(end - 1) >= 0xd800 &&
      content.charCodeAt(end - 1) <= 0xdbff &&
      content.charCodeAt(end) >= 0xdc00 &&
      content.charCodeAt(end) <= 0xdfff
    ) {
      end--;
    }
    if (end === start) end = Math.min(content.length, start + 2);
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks.length > 0 ? chunks : [""];
}

export interface ChunkReadResult {
  runId: string;
  index: number;
  chunkCount: number;
  expiresAt: string;
  content: string;
}

export class TempChunkStore {
  constructor(
    private readonly ttlMs: number,
    private readonly baseOverride?: string,
    private readonly maxBytes: number = 8 * 1024 * 1024,
  ) {}

  baseDir(): string {
    if (this.baseOverride) return this.baseOverride;
    const xdg = process.env["XDG_RUNTIME_DIR"];
    if (xdg && xdg !== "") return path.join(xdg, "openclaw-vwr");
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    return path.join(os.tmpdir(), `openclaw-vwr-${uid}`);
  }

  private runDir(runId: string): string {
    if (!UUID_RE.test(runId)) {
      throw new Error("run id must be a UUID");
    }
    return path.join(this.baseDir(), runId);
  }

  store(runId: string, url: string, content: string, chunkChars: number): StoreResult {
    const dir = this.runDir(runId);
    const base = this.baseDir();
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.chmodSync(base, 0o700);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);

    const safeChunk = Math.max(1, chunkChars);
    const incomingBytes = Buffer.byteLength(content, "utf8");
    if (incomingBytes > this.maxBytes) {
      throw new Error(`content exceeds max temp size (${this.maxBytes} bytes)`);
    }
    const existing = this.totalBytes();
    if (existing + incomingBytes > this.maxBytes) {
      throw new Error(`temp store would exceed max size (${this.maxBytes} bytes)`);
    }

    const chunks = splitUnicodeSafe(content, safeChunk);
    const chunkCount = chunks.length;
    for (let i = 0; i < chunkCount; i++) {
      fs.writeFileSync(path.join(dir, `chunk-${i}.txt`), chunks[i] ?? "", { mode: 0o600 });
    }

    const now = Date.now();
    const manifest: ChunkManifest = {
      run_id: runId,
      url: redactUrl(url),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
      chunk_count: chunkCount,
      chunk_chars: safeChunk,
      content_chars: content.length,
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    return { chunkCount, expiresAt: manifest.expires_at };
  }

  readChunk(runId: string, index: number): ChunkReadResult {
    const dir = this.runDir(runId);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`no stored content for run ${runId} (expired or cleaned up)`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ChunkManifest;
    if (Date.now() > Date.parse(manifest.expires_at)) {
      this.cleanup(runId);
      throw new Error(`stored content for run ${runId} has expired`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= manifest.chunk_count) {
      throw new Error(
        `chunk index ${index} out of range (0..${manifest.chunk_count - 1})`,
      );
    }
    const content = fs.readFileSync(path.join(dir, `chunk-${index}.txt`), "utf8");
    return {
      runId,
      index,
      chunkCount: manifest.chunk_count,
      expiresAt: manifest.expires_at,
      content,
    };
  }

  cleanup(runId: string): boolean {
    const dir = this.runDir(runId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  private totalBytes(): number {
    const base = this.baseDir();
    if (!fs.existsSync(base)) return 0;
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          try {
            total += fs.statSync(full).size;
          } catch {
            /* ignore unreadable files */
          }
        }
      }
    };
    walk(base);
    return total;
  }

  /** Remove expired run directories. Called opportunistically, never by a daemon. */
  sweepExpired(now: number = Date.now()): number {
    const base = this.baseDir();
    if (!fs.existsSync(base)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(base)) {
      if (!UUID_RE.test(entry)) continue;
      const dir = path.join(base, entry);
      let expired = false;
      const manifestPath = path.join(dir, "manifest.json");
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ChunkManifest;
        expired = now > Date.parse(manifest.expires_at);
      } catch {
        // Unreadable/incomplete run dir: fall back to mtime.
        try {
          expired = now - fs.statSync(dir).mtimeMs > this.ttlMs;
        } catch {
          expired = false;
        }
      }
      if (expired) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}
