# verified-web-reader 代码 Review 与修改说明

版本：2.1.0  
审查依据：`PASSIVE_VERIFIED_WEB_READER_DESIGN.md`

## 1. Review 结论

原项目的整体方向是正确的：它被设计成 OpenClaw 原生 `web_fetch` 失败后的
一次性浏览器兜底工具，而不是 MCP Server、HTTP 服务或常驻浏览器服务。

但原实现存在若干会影响安全性和结果可信度的问题，其中最重要的是：

1. Skill 把用户 URL 和 JSON 放进 Shell 命令，存在外层命令注入风险；
2. 原始 CDP 后端在请求发生后才检查最终 URL，不能可靠阻止重定向 SSRF；
3. generic 适配器可能把同一网站上的错误文章判定为目标文章；
4. 部分异常路径可能遗留浏览器标签页；
5. 两个并发任务可能互相启动、停止同一个 managed browser profile；
6. `require_complete=false` 会削弱 `browser_verified` 的“完整原文”语义；
7. 登录入口文字、标题和作者提示存在误判可能；
8. Unicode 分块、资源限制、敏感日志脱敏等边界处理不完整。

上述代码级问题已经修复。修改后的实现满足设计文档中“被动调用、真实浏览器
验证、fail-closed、一次性退出、无后台服务”的核心要求。

当前环境没有安装 OpenClaw，因此最终结论应表述为：**代码级功能和自动化测试
已经完成，目标 OpenClaw 主机上的真实浏览器验收仍需执行。**

## 2. 主要修改思路

### 2.1 保持真正的被动式 fallback

- 正常网页必须先使用 OpenClaw 原生 `web_fetch`；
- 只有 401/403/429、反爬、JS 空壳、正文截断、错页，或用户明确要求浏览器时
  才运行 CLI；
- CLI 每次只处理一个 URL，完成后退出；
- 不增加 MCP Server、HTTP Server、监听端口、守护进程、定时清理或浏览器预热；
- `doctor` 只供安装验收和人工排障，不进入正常读取流程。

### 2.2 把“不可信数据”彻底移出 Shell 命令

OpenClaw exec 的命令最终由 Shell 执行，因此仅仅在 CLI 内使用 `execFile` 还不够。
修改后的 Skill 使用固定命令：

```text
"{baseDir}/scripts/verified-browser-read" read --input-env VWR_READ_INPUT_JSON
```

URL、标题、作者、关键词和失败详情全部通过 exec 工具的独立 `env` 字段传入，
不再拼接到命令字符串。长正文的 `content_handle` 也通过 `--run-id-env` 传递。

### 2.3 SSRF 必须在请求发生前拦截

- 输入 URL 在启动浏览器前执行协议、凭据、主机、IP 范围和 DNS 检查；
- 原始 CDP 后端在 `Page.navigate` 前启用 `Fetch.requestPaused`；
- 每个 HTTP(S) 请求通过安全检查后才执行 `Fetch.continueRequest`；
- 只统计 `Document` 请求的重定向，不把图片、脚本等子资源误算成重定向；
- 最终 URL 再次检查，并要求 host 与站点适配器允许范围一致；
- CDP 控制面只允许回环、RFC1918 私网或 ULA 地址，拒绝公网和云元数据地址。

OpenClaw managed backend 依赖 OpenClaw 默认的严格浏览器 SSRF 策略。部署时不得
开启 `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`。浏览器请求拦截并不是
主机防火墙，高安全环境仍建议在出口网络层阻断私网、链路本地和元数据地址。

### 2.4 页面身份和完整性采用 fail-closed

`browser_verified` 现在必须同时满足：

- 最终 URL 符合站点适配器规则；
- 目标内容 ID、标题、作者等身份信息在正确 DOM 字段中匹配；
- 两次稳定读取一致；
- 没有残留展开控件、明显截断、长度触顶或半句话结尾；
- 正文达到最低可信长度。

generic 适配器在没有内容 ID 时，会要求规范化后的路径和有效查询参数匹配，
不再因为“同一个 host”就认为是同一篇文章。标题提示只匹配抽取标题，作者提示
只匹配抽取作者，不能仅因为相关文字出现在正文里就通过。

`require_complete=false` 只表示调用方可以接受 partial 结果，不会把疑似截断内容
升级为 `browser_verified`。

### 2.5 浏览器生命周期按所有权管理

- profile 原本已经运行：只复用，任务结束时绝不停止；
- profile 由本次任务启动：结束后按配置停止；
- 每次任务创建独立标签页，成功和异常路径都关闭；
- OpenClaw 标签页使用唯一 label，并优先使用 `suggestedTargetId`、稳定 `tabId`；
- 即使命令输出无法解析，也能使用 label 找到并关闭任务标签页；
- 同一 managed profile 使用跨进程互斥锁，避免并发任务互相停止浏览器；
- 长任务持续刷新锁的活性时间，异常退出后才由后续任务清理陈旧锁。

### 2.6 正文提取和临时分块保持有界

- 页面脚本在抽取过程中按字符上限停止，而不是先读取整页后再截断；
- 展开次数、滚动次数、等待时间、命令超时、正文长度和临时文件总量均有硬上限；
- 图片的非空 `alt` 以 `[图片：说明]` 形式保留；
- 长正文以 0700 目录和 0600 文件临时存储，并设置 TTL；
- Unicode 分块不会拆断 emoji 等 UTF-16 代理对；
- 清理由后续调用顺带执行或由当前任务显式执行，不增加清理守护进程。

## 3. 关键问题与修改结果

| 级别 | Review 发现 | 修改结果 |
|---|---|---|
| 严重 | Skill Shell 命令注入 | 固定 `{baseDir}` 命令，用户 JSON 仅经独立 env 传递 |
| 严重 | CDP 重定向 SSRF | `Fetch.requestPaused` 请求前校验并阻断 |
| 高 | 同 host 错误文章误报成功 | 路径、query、内容 ID 和 DOM 身份联合验证 |
| 高 | 打开标签页后的异常路径泄漏 | 内外两层 finally 清理，增加唯一稳定 label |
| 高 | managed profile 并发启停冲突 | 跨进程锁、有限等待、活性刷新和陈旧锁恢复 |
| 高 | partial 内容可能升级为 verified | `browser_verified` 永远要求身份正确且完整性为 complete |
| 中 | CDP 子资源被算作重定向 | 只统计 Document 导航 |
| 中 | 易失 `targetId` 优先级过高 | 优先 suggestedTargetId、tabId 和 label |
| 中 | 登录入口文字造成误判 | 收紧登录墙检测规则 |
| 中 | 标题/作者在正文中出现即可匹配 | 只对相应结构化字段进行匹配 |
| 中 | emoji 可能被跨分块拆断 | Unicode 安全分块 |
| 中 | 配置值可以造成失控资源占用 | 所有关键时间、次数、容量和长度增加硬边界 |
| 低 | 图片说明丢失 | 保留 `img[alt]` 描述 |
| 低 | URL fragment、签名参数或诊断文本泄漏 | 扩大脱敏范围并限制审计文本长度 |

## 4. 功能需求覆盖情况

| 设计需求 | Review 结果 |
|---|---|
| 普通读取成功时不调用浏览器 CLI | 已由 Skill 硬规则及行为测试覆盖 |
| 仅失败或用户明确要求时 fallback | 已覆盖 |
| 一次性进程，无 Server、daemon、listener | 已覆盖并完成静态检查 |
| OpenClaw 与 CDP 两种浏览器后端 | 已实现 |
| 正确管理浏览器和标签页生命周期 | 已实现并测试成功/异常路径 |
| SSRF、重定向和控制面地址防护 | 已实现 |
| 页面身份和正文完整性验证 | 已实现，默认 fail-closed |
| 登录、验证码、付费墙不绕过 | 已实现 |
| 目标容器内展开、有限滚动、稳定双读 | 已实现 |
| 长正文分块、权限、TTL 和清理 | 已实现 |
| stdout 单一 JSON、stderr 日志、明确退出码 | 已实现 |
| Skill 使用 `{baseDir}`，不依赖当前目录 | 已实现 |
| 不把搜索摘要或模型记忆冒充原文 | 已写入 Skill 强制规则 |

## 5. 测试和验证结果

```text
TypeScript typecheck：通过
生产构建：通过
Vitest：12 个测试文件，109 个测试全部通过
Shell 脚本语法：通过
禁止模式和敏感凭据静态扫描：通过
unsafe URL CLI smoke test：通过
ZIP 完整性检查：通过
```

测试覆盖 URL/SSRF、控制面限制、命令参数安全、Skill fallback 行为、站点适配器、
错页回归、页面完整性、阻断识别、浏览器生命周期、并发锁、Unicode 分块、临时
文件权限和敏感信息脱敏。

## 6. 部署和后续建议

### 必须执行的目标机验收

解压、安装依赖并构建后运行：

```bash
npm install
npm run build
scripts/acceptance-smoke.sh "https://你的公开测试页面"
```

验收脚本会检查：

- `doctor` 结果；
- 真实浏览器读取是否产生允许的结构化状态；
- 任务标签页是否确认关闭；
- CLI 是否退出且没有残留进程；
- 执行前后的 TCP 监听端口是否一致。

还需人工确认：

1. OpenClaw 未开启 `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`；
2. 使用独立的 `verified-reader` profile，而不是个人登录浏览器；
3. 没有为本工具增加 systemd、PM2、Docker restart、cron 或 MCP 注册；
4. 使用实际会触发反爬的页面验证 fallback，而不只测试 `example.com`；
5. 站点 DOM 改版后，优先增加专用 adapter 和固定 HTML 回归夹具；
6. 高安全部署增加主机出口 ACL 或策略代理，浏览器拦截只作为应用层防线。

## 7. 参考

- [OpenClaw Browser CLI：稳定 tab handle](https://docs.openclaw.ai/cli/browser)
- [OpenClaw Browser 安全与 SSRF 策略](https://docs.openclaw.ai/gateway/security)
- [OpenClaw Skill 的 `{baseDir}` 使用方式](https://docs.openclaw.ai/tools/skills)
- [OpenClaw exec 的 Shell 行为](https://docs.openclaw.ai/tools/exec)
