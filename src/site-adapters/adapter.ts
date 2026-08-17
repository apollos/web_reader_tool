/**
 * Site adapter interface (design §12). Adapters are pure static data + URL
 * logic; DOM work is always done by the fixed page script, parameterised
 * with the adapter's ExtractParams (data only, never code).
 */

import type { ExtractParams, TargetHint } from "../types.js";
import type { PatternRule } from "../blockers.js";

export interface SiteAdapter {
  name: string;
  /** Whether this adapter handles the given URL. */
  match(url: URL): boolean;
  /** Content id (article id / answer id) parsed from the URL, if any. */
  contentIdFromUrl(url: URL): string | null;
  /** Hosts the final URL is allowed to land on (canonical redirects). */
  allowedFinalHosts(url: URL): string[];
  /**
   * Whether the final URL still points at the same target content.
   * Called after host check has already passed.
   */
  verifyFinalUrl(requested: URL, finalUrl: URL): boolean;
  /** DOM extraction parameters for the fixed page script. */
  extractParams(url: URL, hint: TargetHint | null): ExtractParams;
  /** Additional site-specific blocker patterns. */
  blockerRules?: PatternRule[];
}

export function hostMatches(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a.toLowerCase());
}
