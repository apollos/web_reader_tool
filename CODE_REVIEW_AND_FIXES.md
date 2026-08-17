# verified-web-reader 2.1.0：代码审查与修复记录

## 结论

已按 `PASSIVE_VERIFIED_WEB_READER_DESIGN.md` 对 CLI、OpenClaw Skill、两种浏览器
后端、页面抽取、身份/完整性验证、临时分块和生命周期管理进行逐项审查并修改。
代码级需求已经覆盖；类型检查、构建、静态检查和 109 个自动化用例通过。

当前执行环境未安装 `openclaw`，因此无法在这里完成目标主机上的真实浏览器
smoke test。项目提供 `scripts/acceptance-smoke.sh`，用于部署后验证真实浏览器、
标签页关闭、进程退出及监听端口不变。

## 已修复问题

| 级别 | 原问题 | 修复 |
|---|---|---|
| 严重 | Skill 把 URL/JSON 插入 shell 命令，外层 `sh -lc` 可触发命令注入 | Skill 使用固定 `{baseDir}` 命令，不可信 JSON 仅经 exec 独立 `env` 字段传入；新增 `--input-env` / `--run-id-env` |
| 严重 | 原始 CDP 在请求发出后才检查最终 URL，重定向可触达私网 | 导航前启用 `Fetch.requestPaused`；每个 HTTP(S) 请求经 URL、DNS 与地址范围检查后才 `continueRequest` |
| 高 | generic 适配器只看同 host，错误文章也可能标记为已验证 | 无内容 ID 时要求规范路径及有效 query 一致；外部 hint 必须由 DOM 证据匹配 |
| 高 | OpenClaw 打开标签页后若就绪等待失败，标签页泄漏 | `openTab` 内部失败清理；每个标签页增加唯一稳定 label，即使 CLI 输出无法解析也能关闭 |
| 高 | 并发读取同一 managed profile 时，一个任务可能停止另一个任务的浏览器 | 增加跨进程 profile 互斥锁、有限等待、陈旧锁恢复、长任务活性刷新及所有路径释放 |
| 高 | `require_complete=false` 可把疑似截断内容升级为 `browser_verified` | `browser_verified` 始终要求身份通过且正文完整；该参数不再降低“完整原文”的语义 |
| 中 | CDP 把图片/脚本等子资源误算成重定向 | 只按 frame 统计 `Document` 请求，子资源不计入重定向上限 |
| 中 | 优先使用易失的原始 `targetId` | 优先 `suggestedTargetId`、`tabId`/label，仅兼容性回退原始 ID |
| 中 | “立即登录”等导航文字会误判整页为登录墙 | 收紧阻断规则，要求更强的页面级登录证据 |
| 中 | 标题/作者 hint 在正文中出现即可通过 | 标题只匹配抽取标题，作者只匹配抽取作者 |
| 中 | UTF-16 分块可能拆断 emoji 等代理对 | 增加 Unicode 安全分块，首块从实际存储文件读取 |
| 中 | 页面脚本可能先抽取整页再截断，内存上限不实 | 抽取过程按字符上限提前停止；配置项增加硬上界 |
| 低 | 图片语义完全丢失 | 正文保留非空 `img[alt]`，输出为 `[图片：…]` |
| 低 | URL 片段、签名参数和诊断文本可能泄露敏感信息 | 扩充查询参数/fragment 脱敏并限制审计文本长度 |

## 需求覆盖

| 设计要求 | 实现状态 |
|---|---|
| 正常读取成功不触发自定义 CLI | 由 Skill 硬规则和行为测试覆盖 |
| 仅失败或用户明确要求时浏览器 fallback | 已覆盖 |
| 一次性进程、无 MCP/HTTP server/daemon/listener | 已覆盖并经静态扫描；目标机脚本检查监听端口和残留进程 |
| OpenClaw managed browser 生命周期所有权 | 已覆盖：原有实例不停止，本次启动实例按配置停止 |
| 成功和异常均关闭任务标签页 | 已覆盖，包括 `openTab` 内部失败 |
| CDP 后端不管理远端浏览器生命周期 | 已覆盖 |
| SSRF、重定向、控制面端点安全 | 已覆盖；OpenClaw 后端依赖其默认严格浏览器 SSRF 策略，CDP 后端使用请求闸门 |
| 目标页面身份和正文完整性 fail-closed | 已覆盖 |
| 登录/验证码/付费墙不绕过、不误报全文 | 已覆盖 |
| 有限滚动/展开、稳定双读、资源上限 | 已覆盖 |
| 长正文临时分块、权限、TTL、容量、显式清理 | 已覆盖 |
| stdout 单 JSON、stderr 诊断、业务状态退出码 | 已覆盖 |
| Skill `{baseDir}` 可移植路径和固定 shell 命令 | 已覆盖 |

## 验证记录

在交付前执行：

```text
TypeScript typecheck: passed
Production build: passed
Vitest: 12 files, 109 tests passed
Shell syntax check: passed
Static forbidden-pattern/secret scan: passed
Unsafe URL CLI smoke: passed
```

部署到 OpenClaw 主机后还应执行：

```bash
scripts/acceptance-smoke.sh "https://你的公开测试页面"
```

并确认 OpenClaw 配置未开启
`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`。如部署环境需要更强 SSRF 保证，
应在主机出口层阻止私网、链路本地和云元数据地址，而不是只依赖浏览器拦截。
