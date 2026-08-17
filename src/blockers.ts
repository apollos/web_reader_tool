/**
 * Blocker detection: login walls, captcha / human verification, paywalls,
 * error pages and homepage redirects. Purely heuristic pattern matching on
 * page title + a bounded text sample; deterministic, no code from the page
 * is ever executed here.
 */

import type { PageProbeResult } from "./types.js";

export type BlockerType =
  | "login_required"
  | "captcha"
  | "paywall"
  | "error_page"
  | "homepage_redirect";

export interface BlockerDetection {
  type: BlockerType;
  evidence: string;
}

interface PatternRule {
  type: BlockerType;
  pattern: RegExp;
  /** If true the pattern only counts when matched in the title. */
  titleOnly?: boolean;
}

const RULES: PatternRule[] = [
  // Captcha / anti-bot interstitials — checked first: many of them also
  // contain the word "登录" and would otherwise be misclassified.
  { type: "captcha", pattern: /请输入验证码|请完成(安全)?验证|拖动滑块|滑动验证|人机验证|安全验证/i },
  { type: "captcha", pattern: /系统(检测|监测)到(您|你)的?(账号|网络|访问)(存在)?异常/i },
  { type: "captcha", pattern: /checking your browser|verify you are (a )?human|are you a robot/i },
  { type: "captcha", pattern: /cloudflare|cf-challenge|ddos protection|just a moment/i, titleOnly: true },
  { type: "captcha", pattern: /captcha/i },

  // Login walls.
  { type: "login_required", pattern: /请先登录|登录后(即可|才能|继续|查看|阅读)|扫码登录/i },
  { type: "login_required", pattern: /sign in to continue|log ?in to (view|continue|read)|please sign in/i },
  { type: "login_required", pattern: /^(登录|登入|sign in|log ?in)([\s|·—–-]|$)/i, titleOnly: true },

  // Paywalls / member-only content.
  { type: "paywall", pattern: /付费(内容|阅读|文章|专栏)|开通(会员|vip)(后)?(继续|阅读|查看)?|订阅后(阅读|查看)|仅(对)?(会员|订阅用户)/i },
  { type: "paywall", pattern: /subscribe to (read|continue)|subscribers only|premium content|paywall/i },

  // Error pages — mostly meaningful in the title.
  { type: "error_page", pattern: /404|页面不存在|页面未找到|你(访问|要找)的页面(不存在|已删除)|page not found|not found/i, titleOnly: true },
  { type: "error_page", pattern: /500 internal server error|service unavailable|502 bad gateway/i, titleOnly: true },
  { type: "error_page", pattern: /访问的页面不存在|内容(已被删除|不存在或已被删除)/i },

  // JS-required shells that survived a real browser (or were never hydrated).
  { type: "error_page", pattern: /please enable javascript|enable javascript to (continue|view)|需要启用\s*javascript|请(先)?(开启|启用)\s*javascript/i },
];

/** Bound how much of the page text participates in heuristics. */
const TEXT_SAMPLE_LIMIT = 2500;

export function detectBlocker(
  probe: PageProbeResult,
  extraRules: PatternRule[] = [],
): BlockerDetection | null {
  const title = probe.title ?? "";
  const text = (probe.textSample ?? "").slice(0, TEXT_SAMPLE_LIMIT);

  for (const rule of [...extraRules, ...RULES]) {
    if (rule.titleOnly) {
      const m = title.match(rule.pattern);
      if (m) return { type: rule.type, evidence: `title: ${m[0]}` };
    } else {
      const m = title.match(rule.pattern) ?? text.match(rule.pattern);
      if (m) return { type: rule.type, evidence: m[0] };
    }
  }
  return null;
}

/**
 * A concrete article/answer was requested but the browser landed on the
 * site root — typical for anti-bot redirects (design §7.2).
 */
export function detectHomepageRedirect(requested: URL, finalUrl: URL): BlockerDetection | null {
  const requestedPath = requested.pathname.replace(/\/+$/, "");
  const finalPath = finalUrl.pathname.replace(/\/+$/, "");
  if (requestedPath !== "" && finalPath === "" && finalUrl.search === "") {
    return {
      type: "homepage_redirect",
      evidence: `requested ${requestedPath} but landed on site root`,
    };
  }
  return null;
}

export type { PatternRule };
