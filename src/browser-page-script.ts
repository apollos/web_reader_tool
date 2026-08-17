/**
 * The fixed page script (design §16.2/§16.3).
 *
 * Security properties:
 * - `pageScript` is a static, self-contained function serialised with
 *   Function.prototype.toString(); the model never generates page code;
 * - user/adapter data reaches the page exclusively as a JSON-serialised
 *   argument (buildPageExpression), never via string-concatenated code;
 * - the script only performs fixed actions: probe, extract, expand, scroll.
 *
 * The function must stay self-contained: no imports, no closure captures.
 */

import type {
  PageExpandResult,
  PageExtractResult,
  PageProbeResult,
  PageScriptParams,
  PageScrollResult,
} from "./types.js";

export type PageScriptResult =
  | PageProbeResult
  | PageExtractResult
  | PageExpandResult
  | PageScrollResult;

export function pageScript(params: PageScriptParams): PageScriptResult {
  var doc = document;

  function isVisible(el: Element): boolean {
    var he = el as HTMLElement;
    if (he.hidden) return false;
    try {
      var view = doc.defaultView;
      if (view && view.getComputedStyle) {
        var style = view.getComputedStyle(he);
        if (style && (style.display === "none" || style.visibility === "hidden")) {
          return false;
        }
      }
    } catch (e) {
      /* keep going with structural checks only */
    }
    if (typeof he.getClientRects === "function") {
      // In a real browser a zero-rect element is not interactable. jsdom
      // always reports zero rects, so only trust this when layout exists.
      if (he.offsetParent === null && he.getClientRects().length === 0) {
        var body = doc.body;
        if (body && typeof body.getBoundingClientRect === "function") {
          var rect = body.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) return false;
        }
      }
    }
    return true;
  }

  function queryAll(root: ParentNode, selector: string): Element[] {
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch (e) {
      return [];
    }
  }

  function textOf(el: Element | null): string {
    if (!el) return "";
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function firstText(selectors: string[] | undefined, root: ParentNode): string | null {
    if (!selectors) return null;
    for (var i = 0; i < selectors.length; i++) {
      var sel = selectors[i];
      if (!sel) continue;
      var els = queryAll(root, sel);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!el) continue;
        var t = textOf(el);
        if (t) return t;
      }
    }
    return null;
  }

  function attrValueMatchesId(value: string, id: string): boolean {
    if (value === id) return true;
    try {
      var obj = JSON.parse(value);
      if (obj && typeof obj === "object") {
        if (String(obj.itemId) === id) return true;
        if (String(obj.id) === id) return true;
      }
    } catch (e) {
      /* not JSON */
    }
    return false;
  }

  function hrefMatchesTarget(href: string, idHref: string, id: string): boolean {
    var path = href;
    var query = "";
    var q = href.indexOf("?");
    if (q !== -1) {
      path = href.slice(0, q);
      query = href.slice(q + 1);
    }
    var hash = path.indexOf("#");
    if (hash !== -1) path = path.slice(0, hash);
    var segs = path.split("/").filter(function (s) { return s.length > 0; });
    var want = idHref.replace(/^\//, "").split("/").filter(function (s) { return s.length > 0; });
    if (want.length > 0) {
      for (var i = 0; i <= segs.length - want.length; i++) {
        var ok = true;
        for (var j = 0; j < want.length; j++) {
          if (segs[i + j] !== want[j]) {
            ok = false;
            break;
          }
        }
        if (ok) return true;
      }
    }
    if (query) {
      var pairs = query.split("&");
      for (var p = 0; p < pairs.length; p++) {
        var kv = (pairs[p] || "").split("=");
        var val = decodeURIComponent((kv[1] || "").replace(/\+/g, " "));
        if (val === id) return true;
      }
    }
    return false;
  }

  function containerMatchesId(el: Element, id: string | null, idHref: string | null): boolean {
    if (!id) return true;
    var name = el.getAttribute("name");
    if (name === id) return true;
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      if (attr && attr.name.indexOf("data-") === 0 && attrValueMatchesId(attr.value, id)) {
        return true;
      }
    }
    if (idHref) {
      var links = queryAll(el, "a[href]");
      for (var k = 0; k < links.length; k++) {
        var link = links[k];
        if (!link) continue;
        var href = link.getAttribute("href") || "";
        if (hrefMatchesTarget(href, idHref, id)) return true;
      }
    }
    return false;
  }

  function findContainer(): { el: Element | null; desc: string | null; idMatched: boolean } {
    var id = params.targetContentId || null;
    var idHref = params.containerIdHref || null;
    var selectors = params.containerSelectors || [];

    // Pass 1: selector match that also carries the target content id.
    for (var i = 0; i < selectors.length; i++) {
      var sel = selectors[i];
      if (!sel) continue;
      var candidates = queryAll(doc, sel);
      for (var j = 0; j < candidates.length; j++) {
        var cand = candidates[j];
        if (cand && containerMatchesId(cand, id, idHref)) {
          return { el: cand, desc: sel, idMatched: !!id };
        }
      }
    }
    // Pass 2: id not required in the DOM (or none requested) → first
    // selector hit is acceptable; matchedContentId stays false and the
    // verifier decides based on the adapter's requirements.
    if (!id || !params.requireContentIdMatch) {
      for (var m = 0; m < selectors.length; m++) {
        var sel2 = selectors[m];
        if (!sel2) continue;
        var hit = doc.querySelector(sel2);
        if (hit) return { el: hit, desc: sel2, idMatched: false };
      }
    }
    if (id && params.requireContentIdMatch) {
      return { el: null, desc: null, idMatched: false };
    }
    // Pass 3: generic density fallback.
    if (params.genericFallback) {
      var blocks = queryAll(doc, "article, main, section, div");
      var best: Element | null = null;
      var bestScore = 0;
      for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b];
        if (!block) continue;
        var textLen = (block.textContent || "").length;
        if (textLen < 200) continue;
        var linkLen = 0;
        var links = queryAll(block, "a");
        for (var l = 0; l < links.length; l++) {
          var lk = links[l];
          if (lk) linkLen += (lk.textContent || "").length;
        }
        var childBlocks = queryAll(block, "article, main, section, div").length;
        var score = textLen - linkLen * 2 - childBlocks * 10;
        if (score > bestScore) {
          bestScore = score;
          best = block;
        }
      }
      if (best) return { el: best, desc: "generic-density-fallback", idMatched: false };
    }
    return { el: null, desc: null, idMatched: false };
  }

  function expandControlsIn(container: Element): HTMLElement[] {
    var out: HTMLElement[] = [];
    var seen: Element[] = [];
    var selectors = params.expandSelectors || [];
    for (var i = 0; i < selectors.length; i++) {
      var sel = selectors[i];
      if (!sel) continue;
      var els = queryAll(container, sel);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (el && seen.indexOf(el) === -1 && isVisible(el)) {
          seen.push(el);
          out.push(el as HTMLElement);
        }
      }
    }
    var texts = params.expandTexts || [];
    if (texts.length > 0) {
      var clickables = queryAll(container, "button, a, [role=button]");
      for (var c = 0; c < clickables.length; c++) {
        var cl = clickables[c];
        if (!cl || seen.indexOf(cl) !== -1 || !isVisible(cl)) continue;
        var t = textOf(cl);
        if (!t || t.length > 20) continue;
        for (var x = 0; x < texts.length; x++) {
          var want = texts[x];
          if (want && t.toLowerCase().indexOf(want.toLowerCase()) !== -1) {
            seen.push(cl);
            out.push(cl as HTMLElement);
            break;
          }
        }
      }
    }
    return out;
  }

  function extractText(container: Element, maxChars: number): { text: string; hitMax: boolean } {
    var clone = container.cloneNode(true) as Element;
    var excludes = (params.excludeSelectors || []).concat([
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
    ]);
    for (var i = 0; i < excludes.length; i++) {
      var sel = excludes[i];
      if (!sel) continue;
      var doomed = queryAll(clone, sel);
      for (var j = 0; j < doomed.length; j++) {
        var d = doomed[j];
        if (d && d.parentNode) d.parentNode.removeChild(d);
      }
    }

    var scope: Element = clone;
    var contentSelectors = params.contentSelectors || [];
    for (var s = 0; s < contentSelectors.length; s++) {
      var csel = contentSelectors[s];
      if (!csel) continue;
      var inner = clone.querySelector(csel);
      if (inner) {
        scope = inner;
        break;
      }
    }

    var parts: string[] = [];
    var accumulated = 0;
    var blocks = queryAll(
      scope,
      "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, figcaption, img[alt]",
    );
    for (var k = 0; k < blocks.length; k++) {
      var blk = blocks[k];
      if (!blk) continue;
      // Skip blocks nested inside an already-collected block (e.g. li > p).
      var nested = false;
      if (blk.tagName.toLowerCase() !== "img") {
        var parent = blk.parentElement;
        while (parent && parent !== scope) {
          if (blocks.indexOf(parent) !== -1) {
            nested = true;
            break;
          }
          parent = parent.parentElement;
        }
      }
      if (nested) continue;
      var rawText = blk.tagName.toLowerCase() === "img"
        ? "[图片：" + (blk.getAttribute("alt") || "") + "]"
        : blk.textContent || "";
      var txt = rawText.replace(/[ \t\u00a0]+/g, " ").trim();
      if (txt) {
        parts.push(txt);
        accumulated += txt.length + 2;
        if (accumulated > maxChars) {
          return { text: parts.join("\n\n").slice(0, maxChars), hitMax: true };
        }
      }
    }
    var text = parts.join("\n\n");
    if (text.length < 100) {
      var fallback = (scope.textContent || "").replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      return { text: fallback.slice(0, maxChars), hitMax: fallback.length > maxChars };
    }
    return { text: text, hitMax: false };
  }

  if (params.action === "probe") {
    var bodyText = doc.body ? (doc.body as HTMLElement).innerText || doc.body.textContent || "" : "";
    var probe: PageProbeResult = {
      url: String(location.href),
      title: String(doc.title || ""),
      readyState: String(doc.readyState),
      textSample: bodyText.replace(/\s+/g, " ").slice(0, 3000),
    };
    return probe;
  }

  if (params.action === "scroll") {
    var step = params.scrollStep ?? 1200;
    var el = doc.scrollingElement || doc.documentElement;
    var before = el ? el.scrollTop : 0;
    window.scrollBy(0, step);
    var after = el ? el.scrollTop : 0;
    var height = el ? el.scrollHeight : 0;
    var viewport = window.innerHeight || 0;
    var result: PageScrollResult = {
      height: height,
      atBottom: after === before || after + viewport >= height - 4,
    };
    return result;
  }

  var located = findContainer();

  if (params.action === "expand") {
    if (!located.el) {
      var noop: PageExpandResult = { clicked: 0, remaining: 0 };
      return noop;
    }
    var controls = expandControlsIn(located.el);
    var maxClicks = params.maxExpandClicks ?? 3;
    var clicked = 0;
    for (var i2 = 0; i2 < controls.length && clicked < maxClicks; i2++) {
      var ctl = controls[i2];
      if (!ctl) continue;
      try {
        ctl.click();
        clicked++;
      } catch (e) {
        /* control may have detached after a previous click */
      }
    }
    var remainingControls = expandControlsIn(located.el);
    var expandResult: PageExpandResult = { clicked: clicked, remaining: remainingControls.length };
    return expandResult;
  }

  // action === "extract"
  var maxChars = params.maxChars ?? 300000;
  if (!located.el) {
    var missing: PageExtractResult = {
      url: String(location.href),
      found: false,
      selectorDescription: null,
      matchedContentId: false,
      title: firstText(params.titleSelectors, doc) || String(doc.title || "") || null,
      author: null,
      text: "",
      textChars: 0,
      visibleExpandControls: 0,
      hitMaxChars: false,
    };
    return missing;
  }

  var extractedText = extractText(located.el, maxChars);
  var text = extractedText.text;
  var extract: PageExtractResult = {
    url: String(location.href),
    found: true,
    selectorDescription: located.desc,
    matchedContentId: located.idMatched,
    title: firstText(params.titleSelectors, doc) || String(doc.title || "") || null,
    author: firstText(params.authorSelectors, located.el) || firstText(params.authorSelectors, doc),
    text: text,
    textChars: text.length,
    visibleExpandControls: expandControlsIn(located.el).length,
    hitMaxChars: extractedText.hitMax,
  };
  return extract;
}

/**
 * Build the JS expression evaluated in the page. The function body is fixed;
 * params travel as a JSON literal — this is the only injection point and it
 * is always serialised, so URLs/hints containing quotes stay inert data.
 */
export function buildPageExpression(params: PageScriptParams): string {
  return `(${pageScript.toString()})(${JSON.stringify(params)})`;
}
