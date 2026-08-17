import type { SiteAdapter } from "./adapter.js";
import { genericAdapter } from "./generic.js";
import { zhihuAdapter } from "./zhihu.js";

/** Specific adapters first, generic algorithm as the fallback (design §12). */
const ADAPTERS: SiteAdapter[] = [zhihuAdapter, genericAdapter];

export function selectAdapter(url: URL): SiteAdapter {
  for (const adapter of ADAPTERS) {
    if (adapter.match(url)) return adapter;
  }
  return genericAdapter;
}

export { genericAdapter } from "./generic.js";
export { zhihuAdapter, parseZhihuAnswerUrl } from "./zhihu.js";
export type { SiteAdapter } from "./adapter.js";
export { hostMatches } from "./adapter.js";
