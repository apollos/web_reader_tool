#!/usr/bin/env node
/**
 * verified-browser-read — one-shot passive browser fallback CLI (design §9).
 *
 * Subcommands:
 *   read      perform one browser read and print a single JSON result
 *   chunk     read one temporary chunk of a long content handle
 *   cleanup   delete temporary data of a run (or all expired runs)
 *   doctor    manual environment check; never part of the normal flow
 *
 * Exit codes (design §9.4):
 *   0   handled business status (including captcha/login/partial/etc.)
 *   64  invalid input
 *   70  internal failure that prevented a structured result
 *
 * stdout carries exactly one JSON document; all logs go to stderr.
 * The process handles a single task and exits — no server, no listener,
 * no interactive mode, no background work.
 */

import fs from "node:fs";
import { runDoctor, runRead } from "./browser-runner.js";
import { loadConfig } from "./config.js";
import { initLogger, log } from "./log.js";
import { TempChunkStore } from "./temp-chunk-store.js";
import type { FallbackReason, ReadInput, TargetHint } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
export const EXIT_INTERNAL = 70;

const USAGE = `Usage:
  verified-browser-read read [--input-env <name> | --input <json> | --input-file <path> | --stdin | --url <url> [options]]
  verified-browser-read chunk (--run-id <uuid> | --run-id-env <name>) --index <n>
  verified-browser-read cleanup (--run-id <uuid> | --run-id-env <name> | --expired)
  verified-browser-read doctor

read options (only used together with --url):
  --fallback-type <type>      e.g. http_403, js_shell, truncated, user_requested
  --fallback-detail <text>
  --content-id <id>
  --title-hint <text>
  --author-hint <text>
  --keyword <text>            repeatable
  --no-require-complete
  --max-wait-ms <n>
`;

export class UsageError extends Error {}

interface ParsedArgs {
  command: string;
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set(["--stdin", "--no-require-complete", "--expired", "--help"]);
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_JSON_INPUT_CHARS = 65_536;

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError("missing subcommand");
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg || !arg.startsWith("--")) throw new UsageError(`unexpected argument: ${arg}`);
    if (BOOLEAN_FLAGS.has(arg)) {
      booleans.add(arg);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`flag ${arg} requires a value`);
    i++;
    const list = flags.get(arg) ?? [];
    list.push(value);
    flags.set(arg, list);
  }
  return { command, flags, booleans };
}

function single(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.flags.get(name);
  if (!values) return undefined;
  if (values.length > 1) throw new UsageError(`flag ${name} given more than once`);
  return values[0];
}

function valueOrEnvironment(parsed: ParsedArgs, valueFlag: string, envFlag: string): string | undefined {
  const value = single(parsed, valueFlag);
  const envName = single(parsed, envFlag);
  if (value !== undefined && envName !== undefined) {
    throw new UsageError(`choose only one of ${valueFlag} or ${envFlag}`);
  }
  if (envName === undefined) return value;
  if (!ENV_NAME_RE.test(envName)) throw new UsageError(`${envFlag} must name a safe environment variable`);
  const fromEnv = process.env[envName];
  if (fromEnv === undefined || fromEnv === "") throw new UsageError(`environment variable ${envName} is empty`);
  return fromEnv;
}

export function buildReadInput(parsed: ParsedArgs, stdinText: string | null): ReadInput {
  const inputJson = single(parsed, "--input");
  const inputFile = single(parsed, "--input-file");
  const inputEnv = single(parsed, "--input-env");
  const url = single(parsed, "--url");
  const sources = [inputJson, inputFile, inputEnv, url, parsed.booleans.has("--stdin") ? "y" : undefined]
    .filter((v) => v !== undefined).length;
  if (sources === 0) throw new UsageError("read requires --input, --input-file, --stdin or --url");
  if (sources > 1) throw new UsageError("choose exactly one input source");

  let raw: unknown;
  if (inputJson !== undefined) {
    raw = parseJsonInput(inputJson);
  } else if (inputEnv !== undefined) {
    if (!ENV_NAME_RE.test(inputEnv)) throw new UsageError("--input-env must name a safe environment variable");
    const value = process.env[inputEnv];
    if (value === undefined || value === "") throw new UsageError(`environment variable ${inputEnv} is empty`);
    raw = parseJsonInput(value);
  } else if (inputFile !== undefined) {
    let text: string;
    try {
      text = fs.readFileSync(inputFile, "utf8");
    } catch (e) {
      throw new UsageError(`cannot read input file: ${(e as Error).message}`);
    }
    raw = parseJsonInput(text);
  } else if (parsed.booleans.has("--stdin")) {
    if (stdinText === null) throw new UsageError("no data on stdin");
    raw = parseJsonInput(stdinText);
  } else {
    const hint: TargetHint = {
      title: single(parsed, "--title-hint") ?? null,
      author: single(parsed, "--author-hint") ?? null,
      content_id: single(parsed, "--content-id") ?? null,
      keywords: parsed.flags.get("--keyword") ?? [],
    };
    const fallbackType = single(parsed, "--fallback-type");
    const fallback: FallbackReason | null = fallbackType
      ? { type: fallbackType, detail: single(parsed, "--fallback-detail") ?? undefined }
      : null;
    const maxWaitRaw = single(parsed, "--max-wait-ms");
    if (maxWaitRaw !== undefined && !/^\d+$/.test(maxWaitRaw)) {
      throw new UsageError("--max-wait-ms must be an integer");
    }
    raw = {
      url,
      fallback_reason: fallback,
      target_hint: hint,
      require_complete: !parsed.booleans.has("--no-require-complete"),
      ...(maxWaitRaw !== undefined ? { max_wait_ms: Number.parseInt(maxWaitRaw, 10) } : {}),
    };
  }

  return validateReadInput(raw);
}

function parseJsonInput(text: string): unknown {
  if (text.length > MAX_JSON_INPUT_CHARS) throw new UsageError("JSON input is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError("input is not valid JSON");
  }
}

export function validateReadInput(raw: unknown): ReadInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError("read input must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["url"] !== "string" || obj["url"] === "") {
    throw new UsageError("read input requires a non-empty string field: url");
  }
  const input: ReadInput = { url: obj["url"] };

  const fb = obj["fallback_reason"];
  if (fb !== undefined && fb !== null) {
    if (typeof fb !== "object" || typeof (fb as Record<string, unknown>)["type"] !== "string") {
      throw new UsageError("fallback_reason must be an object with a string type");
    }
    const fbo = fb as Record<string, unknown>;
    const type = fbo["type"] as string;
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(type)) {
      throw new UsageError("fallback_reason.type contains invalid characters");
    }
    input.fallback_reason = {
      type,
      ...(typeof fbo["detail"] === "string" ? { detail: fbo["detail"].slice(0, 4000) } : {}),
    };
  }

  const hint = obj["target_hint"];
  if (hint !== undefined && hint !== null) {
    if (typeof hint !== "object" || Array.isArray(hint)) {
      throw new UsageError("target_hint must be an object");
    }
    const h = hint as Record<string, unknown>;
    const keywords = h["keywords"];
    if (
      keywords !== undefined &&
      (!Array.isArray(keywords) || keywords.some((k) => typeof k !== "string"))
    ) {
      throw new UsageError("target_hint.keywords must be an array of strings");
    }
    input.target_hint = {
      title: typeof h["title"] === "string" ? h["title"].slice(0, 500) : null,
      author: typeof h["author"] === "string" ? h["author"].slice(0, 500) : null,
      content_id:
        typeof h["content_id"] === "string"
          ? h["content_id"].slice(0, 200)
          : typeof h["content_id"] === "number"
            ? String(h["content_id"])
            : null,
      keywords: ((keywords as string[] | undefined) ?? []).slice(0, 20).map((k) => k.slice(0, 200)),
    };
  }

  if (obj["require_complete"] !== undefined) {
    if (typeof obj["require_complete"] !== "boolean") {
      throw new UsageError("require_complete must be a boolean");
    }
    input.require_complete = obj["require_complete"];
  }

  if (obj["max_wait_ms"] !== undefined) {
    const n = obj["max_wait_ms"];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1000 || n > 120_000) {
      throw new UsageError("max_wait_ms must be a number between 1000 and 120000");
    }
    input.max_wait_ms = n;
  }

  return input;
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? text : null;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const config = loadConfig();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.booleans.has("--help") || parsed.command === "help") {
    process.stderr.write(USAGE);
    return EXIT_OK;
  }

  initLogger(config.logLevel, "cli");

  try {
    switch (parsed.command) {
      case "read": {
        const stdinText = parsed.booleans.has("--stdin") ? await readStdin() : null;
        let input: ReadInput;
        try {
          input = buildReadInput(parsed, stdinText);
        } catch (e) {
          if (e instanceof UsageError) {
            process.stderr.write(`error: ${e.message}\n\n${USAGE}`);
            return EXIT_USAGE;
          }
          throw e;
        }
        const result = await runRead(input, config);
        printJson(result);
        return EXIT_OK;
      }

      case "chunk": {
        const runId = valueOrEnvironment(parsed, "--run-id", "--run-id-env");
        const indexRaw = single(parsed, "--index");
        if (!runId || indexRaw === undefined) {
          process.stderr.write(`error: chunk requires --run-id and --index\n\n${USAGE}`);
          return EXIT_USAGE;
        }
        if (!/^\d+$/.test(indexRaw)) {
          process.stderr.write("error: --index must be a non-negative integer\n");
          return EXIT_USAGE;
        }
        const index = Number.parseInt(indexRaw, 10);
        const store = new TempChunkStore(config.ttlMs);
        try {
          const chunk = store.readChunk(runId, index);
          printJson({
            schema_version: SCHEMA_VERSION,
            run_id: chunk.runId,
            index: chunk.index,
            chunk_count: chunk.chunkCount,
            expires_at: chunk.expiresAt,
            content: chunk.content,
          });
          return EXIT_OK;
        } catch (e) {
          printJson({
            schema_version: SCHEMA_VERSION,
            run_id: runId,
            index,
            error: (e as Error).message,
          });
          return EXIT_OK;
        }
      }

      case "cleanup": {
        const runId = valueOrEnvironment(parsed, "--run-id", "--run-id-env");
        const expired = parsed.booleans.has("--expired");
        if ((runId === undefined) === !expired) {
          process.stderr.write(`error: cleanup requires exactly one of --run-id or --expired\n\n${USAGE}`);
          return EXIT_USAGE;
        }
        const store = new TempChunkStore(config.ttlMs);
        if (runId !== undefined) {
          let removed = false;
          try {
            removed = store.cleanup(runId);
          } catch (e) {
            process.stderr.write(`error: ${(e as Error).message}\n`);
            return EXIT_USAGE;
          }
          printJson({ schema_version: SCHEMA_VERSION, run_id: runId, removed });
        } else {
          const removed = store.sweepExpired();
          printJson({ schema_version: SCHEMA_VERSION, expired_removed: removed });
        }
        return EXIT_OK;
      }

      case "doctor": {
        const report = await runDoctor(config);
        printJson(report);
        return EXIT_OK;
      }

      default:
        process.stderr.write(`error: unknown subcommand "${parsed.command}"\n\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (e) {
    // Anything that escapes here means we could not produce a structured
    // business result (design §9.4 → exit 70).
    log.error(`fatal: ${(e as Error).stack ?? (e as Error).message}`);
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    return EXIT_INTERNAL;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith("cli.js");
if (isDirectRun && !process.env["VWR_CLI_UNDER_TEST"]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`fatal: ${(e as Error).message}\n`);
      process.exit(EXIT_INTERNAL);
    },
  );
}
