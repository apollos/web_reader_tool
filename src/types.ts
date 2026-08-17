/**
 * Shared types for the verified-browser-read one-shot CLI.
 * Output contract follows PASSIVE_VERIFIED_WEB_READER_DESIGN.md §14.
 */

export const SCHEMA_VERSION = "1.0";

export type ReadStatus =
  | "browser_verified"
  | "browser_partial"
  | "login_required"
  | "captcha"
  | "paywall"
  | "page_mismatch"
  | "content_not_found"
  | "browser_unavailable"
  | "navigation_failed"
  | "unsafe_url"
  | "internal_error";

export type Completeness = "complete" | "partial" | "unknown" | "none";

export interface FallbackReason {
  type: string;
  detail?: string;
}

export interface TargetHint {
  title?: string | null;
  author?: string | null;
  content_id?: string | null;
  keywords?: string[];
}

export interface ReadInput {
  url: string;
  fallback_reason?: FallbackReason | null;
  target_hint?: TargetHint | null;
  require_complete?: boolean;
  max_wait_ms?: number;
}

export interface Evidence {
  opening: string;
  ending: string;
  target_content_id: string | null;
  target_selector: string | null;
  expanded: boolean;
  length_before_expand: number;
  length_after_expand: number;
  stable_reads: number;
  visible_expand_controls: number;
  identity_checks: string[];
  completeness_checks: string[];
}

export interface BrowserLifecycle {
  was_running_before: boolean | null;
  started_by_this_run: boolean;
  tab_closed: boolean | null;
  browser_stopped: boolean;
}

export interface ReadResult {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  status: ReadStatus;
  requested_url: string;
  final_url: string | null;
  fallback_reason: FallbackReason | null;
  title: string | null;
  author: string | null;
  page_identity_verified: boolean;
  content_completeness: Completeness;
  content_chars: number;
  content: string | null;
  content_handle?: string;
  chunk_count?: number;
  expires_at?: string;
  evidence: Evidence | null;
  browser_lifecycle: BrowserLifecycle;
  warnings: string[];
}

/** Parameters passed (as JSON data, never as code) to the fixed page script. */
export interface PageScriptParams {
  action: "probe" | "extract" | "expand" | "scroll";
  targetContentId?: string | null;
  containerSelectors?: string[];
  /** Substring that a link inside the target container must contain, e.g. "/answer/123". */
  containerIdHref?: string | null;
  contentSelectors?: string[];
  excludeSelectors?: string[];
  expandSelectors?: string[];
  expandTexts?: string[];
  titleSelectors?: string[];
  authorSelectors?: string[];
  maxChars?: number;
  genericFallback?: boolean;
  /** If true, the target container must carry the content id (site adapters). */
  requireContentIdMatch?: boolean;
  maxExpandClicks?: number;
  scrollStep?: number;
}

export interface PageProbeResult {
  url: string;
  title: string;
  readyState: string;
  textSample: string;
}

export interface PageExtractResult {
  url: string;
  found: boolean;
  selectorDescription: string | null;
  matchedContentId: boolean;
  title: string | null;
  author: string | null;
  text: string;
  textChars: number;
  visibleExpandControls: number;
  hitMaxChars: boolean;
}

export interface PageExpandResult {
  clicked: number;
  remaining: number;
}

export interface PageScrollResult {
  height: number;
  atBottom: boolean;
}

/** Extraction parameters produced by a site adapter (pure data). */
export interface ExtractParams {
  targetContentId: string | null;
  containerSelectors: string[];
  containerIdHref: string | null;
  contentSelectors: string[];
  excludeSelectors: string[];
  expandSelectors: string[];
  expandTexts: string[];
  titleSelectors: string[];
  authorSelectors: string[];
  genericFallback: boolean;
  /**
   * Whether the content id must be provably present in the target DOM
   * container. Site adapters with known DOM structure (zhihu) set this;
   * the generic adapter relies on final-URL verification instead.
   */
  requireContentIdMatch: boolean;
}
