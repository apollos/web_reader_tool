/**
 * Page identity & content completeness verification (design §11).
 * Fail-closed: whenever a check cannot be proven, the result degrades to
 * partial/unknown — never to complete/verified.
 */

import type { Completeness, PageExtractResult, TargetHint } from "./types.js";

export interface VerifyIdentityInput {
  adapterName: string;
  targetContentId: string | null;
  /** Whether the adapter demands the content id to be visible in the DOM container. */
  requireContentIdMatch: boolean;
  hint: TargetHint | null;
  read: PageExtractResult;
  finalUrlOk: boolean;
}

export interface VerifyIdentityResult {
  ok: boolean;
  checks: string[];
  failures: string[];
}

export interface VerifyCompletenessInput {
  readA: PageExtractResult;
  readB: PageExtractResult;
  requireComplete: boolean;
  minContentChars: number;
  expandsClicked: number;
}

export interface VerifyCompletenessResult {
  completeness: Completeness;
  checks: string[];
  failures: string[];
}

/** Normalise whitespace / invisible characters before comparison (§11.2). */
export function normalizeText(text: string): string {
  return text
    .replace(/[\u200b\u200c\u200d\ufeff\u2060]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TRUNCATION_ENDINGS: RegExp[] = [
  /(\.\.\.|…)\s*$/,
  /(阅读全文|展开全文|展开阅读全文|显示全部|查看全文)\s*$/,
  /(登录后(继续|查看|阅读).{0,6})$/,
  /(read more|show more|continue reading)\s*$/i,
];

/** Characters that plausibly end a finished sentence / article. */
const NATURAL_ENDING = /[。．.!！?？”"』」)）\]】…:：;；~～\d]$|[a-zA-Z]{2}$/;

export function endsTruncated(text: string): { truncated: boolean; reason?: string } {
  const t = text.trimEnd();
  if (t.length === 0) return { truncated: true, reason: "empty text" };
  for (const re of TRUNCATION_ENDINGS) {
    const m = t.match(re);
    if (m) return { truncated: true, reason: `ends with truncation marker: ${m[0].trim()}` };
  }
  return { truncated: false };
}

/** Weaker signal: text just stops mid-sentence. Only used when require_complete. */
export function endsMidSentence(text: string): boolean {
  const t = text.trimEnd();
  if (t.length === 0) return true;
  const lastLine = t.split("\n").pop() ?? "";
  if (lastLine.trim().length === 0) return false;
  return !NATURAL_ENDING.test(lastLine.trim());
}

export function verifyIdentity(input: VerifyIdentityInput): VerifyIdentityResult {
  const checks: string[] = [];
  const failures: string[] = [];
  const { read, hint, targetContentId } = input;

  if (input.finalUrlOk) checks.push("final url matches target");
  else failures.push("final url does not match target");

  if (targetContentId) {
    if (read.matchedContentId) {
      checks.push(`content id ${targetContentId} found in container`);
    } else if (input.requireContentIdMatch) {
      failures.push(`content id ${targetContentId} not found in target container`);
    } else {
      checks.push(`content id ${targetContentId} verified via final url only`);
    }
  }

  const haystack = `${read.title ?? ""}\n${read.author ?? ""}\n${read.text}`.toLowerCase();

  if (hint?.title) {
    const want = hint.title.toLowerCase().trim();
    if (want && (read.title ?? "").toLowerCase().includes(want)) {
      checks.push("title hint matched");
    } else if (want) {
      failures.push(`title hint "${hint.title}" not found in page title`);
    }
  }

  if (hint?.author) {
    const want = hint.author.toLowerCase().trim();
    if (want && (read.author ?? "").toLowerCase().includes(want)) checks.push("author hint matched");
    else if (want) failures.push(`author hint "${hint.author}" not found in author field`);
  }

  if (hint?.keywords && hint.keywords.length > 0) {
    const missing = hint.keywords.filter(
      (k) => k.trim() !== "" && !haystack.includes(k.toLowerCase()),
    );
    if (missing.length === 0) checks.push(`all ${hint.keywords.length} keywords matched`);
    else failures.push(`keywords not found: ${missing.join(", ")}`);
  }

  return { ok: failures.length === 0, checks, failures };
}

export function verifyCompleteness(input: VerifyCompletenessInput): VerifyCompletenessResult {
  const checks: string[] = [];
  const failures: string[] = [];
  const { readA, readB, requireComplete, minContentChars } = input;

  const textA = normalizeText(readA.text);
  const textB = normalizeText(readB.text);

  if (!readB.found || textB.length === 0) {
    return {
      completeness: "none",
      checks,
      failures: ["no content extracted from target container"],
    };
  }

  const stable = textA === textB;
  if (stable) checks.push("two consecutive reads are identical");
  else failures.push(`reads differ (${textA.length} vs ${textB.length} chars)`);

  if (readB.visibleExpandControls === 0) checks.push("no visible expand controls remain");
  else failures.push(`${readB.visibleExpandControls} expand control(s) still visible`);

  if (!readB.hitMaxChars) checks.push("content below extraction limit");
  else failures.push("content hit the extraction length limit");

  if (readA.url === readB.url) checks.push("page did not navigate between reads");
  else failures.push("page navigated away during extraction");

  const trunc = endsTruncated(textB);
  if (!trunc.truncated) checks.push("ending carries no truncation marker");
  else failures.push(trunc.reason ?? "ending looks truncated");

  const longEnough = textB.length >= minContentChars;
  if (longEnough) checks.push(`content length ${textB.length} >= ${minContentChars}`);

  // Hard partial signals: visible controls, truncation markers, cap hit,
  // instability or mid-extraction navigation.
  if (
    readB.visibleExpandControls > 0 ||
    trunc.truncated ||
    readB.hitMaxChars ||
    !stable ||
    readA.url !== readB.url
  ) {
    return { completeness: "partial", checks, failures };
  }

  if (!longEnough) {
    failures.push(`content length ${textB.length} below threshold ${minContentChars}`);
    return { completeness: "unknown", checks, failures };
  }

  if (endsMidSentence(textB)) {
    failures.push("content appears to stop mid-sentence; completeness unproven");
    return { completeness: "unknown", checks, failures };
  }

  if (!requireComplete) checks.push("caller did not require full content; full checks still passed");

  return { completeness: "complete", checks, failures };
}
