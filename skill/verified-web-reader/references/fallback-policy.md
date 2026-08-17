# 兜底触发策略（细则）

本文件是 SKILL.md 硬规则第 3 条的完整版，对应设计文档第 7 节。

## 普通读取成功条件（全部满足才算成功，成功时禁止调用 CLI）

1. 请求没有返回网络错误或 4xx/5xx 状态。
2. 最终 URL 与目标页面一致，或属于可解释的规范化跳转（如 www 与裸域互换）。
3. 页面标题、文章 ID、回答 ID、作者或用户提供的关键词与目标一致。
4. 返回内容包含连续、可理解的正文，而不是导航、推荐或评论列表。
5. 没有登录、验证码、付费墙、"请启用 JavaScript" 等阻断提示。
6. 没有明显的折叠、截断或"阅读全文"残留。
7. 用户要求"完整阅读"时，有足够依据判断正文完整。

成功时：不调用 CLI、不运行浏览器 status、不启动 Chrome、不产生本项目日志。

## 硬失败（必须进入浏览器兜底）

- HTTP 401、403、407、429、451；
- 连接超时、TLS 错误、连接被重置；
- 明确的 `Forbidden`、`Access Denied`、`Request blocked`；
- 返回要求启用 JavaScript 的壳页面；
- 请求具体文章，却跳转到网站首页、登录页或验证页；
- web_fetch 明确报告无法获取正文。

建议的 fallback_reason.type：`http_403`、`http_429`、`network_error`、
`js_shell`、`homepage_redirect`、`fetch_failed`。

## 软失败（HTTP 正常也需要兜底）

- 正文短于站点或任务的合理阈值；
- 内容以省略号、半句话或截断标识结束；
- 页面存在"阅读全文""展开全文""登录后查看全文"；
- 返回内容主要是导航、页脚、评论或推荐列表；
- URL 中有文章/回答 ID，但正文无法找到对应 ID；
- 标题、作者或关键句与目标不匹配；
- 页面明显依赖客户端渲染；
- 用户要求核对原文，而普通读取无法证明完整性。

建议的 fallback_reason.type：`truncated`、`content_mismatch`、
`client_rendered`、`verification_needed`。

## 允许直接调用（跳过 web_fetch）的例外

- 用户明确说"用浏览器打开""必须通过真实浏览器核对"
  （fallback_reason.type = `user_requested`）；
- 用户要求检查登录后的页面，且已明确授权使用指定浏览器会话；
- 当前任务就是诊断浏览器适配器或浏览器链路本身。

## 禁止触发的场景

- 普通读取已经获得完整静态正文；
- 只是想找更多背景资料；
- 搜索摘要已经足够回答与原文无关的问题；
- 没有任何失败证据，只是"觉得浏览器可能更准确"；
- 为预热、健康检查或性能监控而调用。

## 重试规则

- 每个 URL 最多一次正常读取 + 一次暂态重试；
- 仅当 status 为 `navigation_failed` 或 `browser_unavailable` 且原因疑似
  暂态（超时、连接中断）时允许重试；
- `unsafe_url`、`page_mismatch`、`login_required`、`captcha`、`paywall`
  重试没有意义，禁止重试。
