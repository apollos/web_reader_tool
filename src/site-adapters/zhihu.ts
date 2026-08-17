/**
 * Zhihu answer adapter (design §12.2).
 *
 * Handles zhihu.com/question/<question_id>/answer/<answer_id>:
 * - the target container must correspond to <answer_id> (multiple answers
 *   and multiple identical "阅读全文" buttons may exist on one page);
 * - expand controls are only clicked inside the target answer container;
 * - content is bounded to the rich-text body, excluding actions/comments.
 */

import type { ExtractParams, TargetHint } from "../types.js";
import type { PatternRule } from "../blockers.js";
import { pathHasConsecutiveSegments, pathHasExactSegment, searchHasExactValue } from "../url-safety.js";
import type { SiteAdapter } from "./adapter.js";

const ANSWER_PATH = /^\/question\/(\d+)\/answer\/(\d+)\/?$/;

export function parseZhihuAnswerUrl(
  url: URL,
): { questionId: string; answerId: string } | null {
  const host = url.hostname.toLowerCase();
  if (host !== "zhihu.com" && host !== "www.zhihu.com") return null;
  const m = url.pathname.match(ANSWER_PATH);
  if (!m || !m[1] || !m[2]) return null;
  return { questionId: m[1], answerId: m[2] };
}

const ZHIHU_BLOCKER_RULES: PatternRule[] = [
  { type: "captcha", pattern: /系统监测到您的网络环境存在异常|异常流量|unhuman/i },
  { type: "login_required", pattern: /登录后(你可以|查看|继续)|SignFlow/i },
];

export const zhihuAdapter: SiteAdapter = {
  name: "zhihu-answer",

  match(url: URL): boolean {
    return parseZhihuAnswerUrl(url) !== null;
  },

  contentIdFromUrl(url: URL): string | null {
    return parseZhihuAnswerUrl(url)?.answerId ?? null;
  },

  allowedFinalHosts(): string[] {
    return ["zhihu.com", "www.zhihu.com"];
  },

  verifyFinalUrl(requested: URL, finalUrl: URL): boolean {
    const target = parseZhihuAnswerUrl(requested);
    if (!target) return false;
    const final = parseZhihuAnswerUrl(finalUrl);
    if (final) {
      return (
        final.questionId === target.questionId && final.answerId === target.answerId
      );
    }
    // Zhihu sometimes rewrites to /question/<qid> with the answer inline;
    // accept only when the answer id is still visible in the URL.
    return (
      pathHasConsecutiveSegments(finalUrl.pathname, ["question", target.questionId]) &&
      (pathHasExactSegment(finalUrl.pathname, target.answerId) ||
        searchHasExactValue(finalUrl, target.answerId))
    );
  },

  extractParams(url: URL, hint: TargetHint | null): ExtractParams {
    const target = parseZhihuAnswerUrl(url);
    const answerId = target?.answerId ?? hint?.content_id ?? null;
    return {
      targetContentId: answerId,
      containerSelectors: answerId
        ? [
            `div.AnswerItem[name="${answerId}"]`,
            `.AnswerItem[name="${answerId}"]`,
            `[data-zop*="${answerId}"]`,
            ".QuestionAnswer-content .AnswerItem",
            ".AnswerItem",
          ]
        : [".QuestionAnswer-content .AnswerItem", ".AnswerItem"],
      containerIdHref: answerId ? `/answer/${answerId}` : null,
      contentSelectors: [".RichContent-inner .RichText", ".RichContent-inner", ".RichText"],
      excludeSelectors: [
        ".ContentItem-actions",
        ".RichContent-actions",
        ".Reward",
        ".Comments-container",
        ".CommentsV2",
        ".MoreAnswers",
        ".Recommendations-Main",
        ".ContentItem-time ~ .ContentItem-actions",
        ".AnswerCard ~ *",
      ],
      expandSelectors: [".ContentItem-expandButton", "button.ContentItem-more"],
      expandTexts: ["阅读全文", "展开阅读全文", "显示全部"],
      titleSelectors: [".QuestionHeader-title", "h1.QuestionHeader-title", "h1"],
      authorSelectors: [".AuthorInfo-name .UserLink-link", ".AuthorInfo-name"],
      genericFallback: false,
      requireContentIdMatch: answerId !== null,
    };
  },

  blockerRules: ZHIHU_BLOCKER_RULES,
};
