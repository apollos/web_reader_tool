/**
 * Generic adapter (design §12.1): container priority article > main >
 * [role=main] > text-density fallback (implemented inside the fixed page
 * script). Navigation, comments, recommendations and footers are excluded.
 */

import type { ExtractParams, TargetHint } from "../types.js";
import { pathHasExactSegment, searchHasExactValue } from "../url-safety.js";
import type { SiteAdapter } from "./adapter.js";

/** Last purely numeric path segment with >= 3 digits, e.g. /article/12345. */
export function genericContentIdFromUrl(url: URL): string | null {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg && /^\d{3,}$/.test(seg)) return seg;
  }
  return null;
}

const TRACKING_QUERY_KEYS = /^(utm_.+|fbclid|gclid|ref|referrer|source)$/i;

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_QUERY_KEYS.test(key))
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export const genericAdapter: SiteAdapter = {
  name: "generic",

  match(): boolean {
    return true;
  },

  contentIdFromUrl(url: URL): string | null {
    return genericContentIdFromUrl(url);
  },

  allowedFinalHosts(url: URL): string[] {
    const host = url.hostname.toLowerCase();
    const hosts = [host];
    // Allow the common www <-> apex canonicalisation, nothing broader.
    if (host.startsWith("www.")) hosts.push(host.slice(4));
    else hosts.push(`www.${host}`);
    return hosts;
  },

  verifyFinalUrl(requested: URL, finalUrl: URL): boolean {
    const id = genericContentIdFromUrl(requested);
    if (id) {
      return pathHasExactSegment(finalUrl.pathname, id) || searchHasExactValue(finalUrl, id);
    }
    return (
      canonicalPath(requested.pathname) === canonicalPath(finalUrl.pathname) &&
      canonicalQuery(requested) === canonicalQuery(finalUrl)
    );
  },

  extractParams(url: URL, hint: TargetHint | null): ExtractParams {
    const urlContentId = genericContentIdFromUrl(url);
    const contentId = hint?.content_id ?? urlContentId;
    return {
      targetContentId: contentId,
      containerSelectors: ["article", "main", "[role=main]"],
      containerIdHref: null,
      contentSelectors: [],
      excludeSelectors: [
        "nav",
        "header",
        "footer",
        "aside",
        "form",
        "[role=navigation]",
        "[role=complementary]",
        "[class*=comment]",
        "[id*=comment]",
        "[class*=recommend]",
        "[class*=related]",
        "[class*=sidebar]",
        "[class*=share]",
        "[class*=login]",
        "[class*=subscribe]",
      ],
      expandSelectors: [],
      expandTexts: ["阅读全文", "展开全文", "展开阅读全文", "查看全文", "展开", "read more", "show more"],
      titleSelectors: ["h1", "article h1", "header h1"],
      authorSelectors: [
        "[rel=author]",
        "[class*=author-name]",
        "[class*=AuthorName]",
        "[itemprop=author]",
        "[class*=byline]",
      ],
      genericFallback: true,
      // Generic sites rarely carry the id inside the container; identity is
      // enforced through final-URL verification instead (verifyFinalUrl).
      requireContentIdMatch: contentId !== null && urlContentId === null,
    };
  },
};
