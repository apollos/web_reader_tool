# 输出契约（status-contract）

对应设计文档第 9、13、14 节。stdout 只有一份 JSON；退出码：
0 = 已产出业务结果（无论成功失败），64 = 输入无效，70 = 内部故障。

## read 输入结构

```json
{
  "url": "https://example.com/article/123",
  "fallback_reason": { "type": "http_403", "detail": "web_fetch returned 403 Forbidden" },
  "target_hint": {
    "title": null,
    "author": null,
    "content_id": "123",
    "keywords": []
  },
  "require_complete": true,
  "max_wait_ms": 25000
}
```

`fallback_reason` 仅用于审计，CLI 不信任它；URL 与页面内容都会重新验证。

## 状态枚举

| status | 允许声称已读完整原文 | 含义 |
|---|---:|---|
| browser_verified | 是 | 页面身份和完整正文均已验证 |
| browser_partial | 否 | 得到候选正文，但不完整或不稳定 |
| login_required | 否 | 需要登录 |
| captcha | 否 | 验证码或人机验证 |
| paywall | 否 | 付费墙或订阅限制 |
| page_mismatch | 否 | 最终页面不是目标页面 |
| content_not_found | 否 | 页面打开但未找到目标正文 |
| browser_unavailable | 否 | 浏览器、CLI 或 CDP 不可达 |
| navigation_failed | 否 | 导航、等待或页面控制失败 |
| unsafe_url | 否 | URL 被安全策略拒绝 |
| internal_error | 否 | 未分类内部故障 |

一致性保证：`browser_verified` 当且仅当 `page_identity_verified=true` 且
`content_completeness="complete"`。

## 输出字段

顶层：`schema_version`、`run_id`、`status`、`requested_url`（已脱敏）、
`final_url`（已脱敏）、`fallback_reason`、`title`、`author`、
`page_identity_verified`、`content_completeness`
（complete/partial/unknown/none）、`content_chars`、`content`、
`evidence`、`browser_lifecycle`、`warnings`。

`evidence`：正文开头/结尾片段、目标内容 ID、命中的选择器、是否点击展开、
展开前后长度、稳定读取次数、剩余可见展开控件数、身份与完整性检查明细。

`browser_lifecycle`：`was_running_before`、`started_by_this_run`、
`tab_closed`、`browser_stopped`。`tab_closed=false` 时一定伴随 warning。

## 长正文分块

正文超过内联上限（默认 6000 字符）时，`content` 只含第 0 块，同时返回：

```json
{
  "content_handle": "<run_id UUID>",
  "chunk_count": 7,
  "expires_at": "2026-08-16T16:00:00.000Z"
}
```

读取其余分块（index 从 0 到 chunk_count-1）：

```bash
verified-browser-read chunk --run-id-env VWR_CONTENT_HANDLE --index 1
```

必须读完所需全部分块后才能声称"总结了全文"。完成后清理：

```bash
verified-browser-read cleanup --run-id-env VWR_CONTENT_HANDLE
```

分块存放在 `$XDG_RUNTIME_DIR/openclaw-vwr/<run_id>/` 或
`/tmp/openclaw-vwr-<uid>/<run_id>/`，权限 0700/0600，默认 15 分钟过期，
过期数据由下一次 CLI 调用顺带清理（无后台任务）。
