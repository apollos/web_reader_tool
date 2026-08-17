# verified-web-reader 2.1.0

OpenClaw 的**被动式浏览器兜底读取工具**。正常网页读取继续使用 OpenClaw 原生
`web_fetch`；只有普通读取失败（403、反爬虫、JS 空壳、截断、错页），或用户明确
要求用真实浏览器核对时，Skill 才调用一次性 CLI `verified-browser-read`，通过
真实浏览器打开页面、验证页面身份与正文完整性，输出结构化 JSON 后立即退出。

设计文档：`PASSIVE_VERIFIED_WEB_READER_DESIGN.md`。

## 被动式保证

- 不注册 MCP Server，不启动 HTTP Server，不监听任何端口；
- 不通过 systemd / PM2 / Supervisor / Docker restart 常驻；
- CLI 被调用时启动，单任务完成后退出，无后台进程、无定时任务；
- 只有进入兜底路径才检查、启动或连接浏览器；
- 长正文使用短期临时分块文件（默认 15 分钟过期），过期数据由下一次调用
  顺带清理，没有清理守护进程。

## 构建

```bash
npm install
npm run build      # 产出 dist/cli.js
npm test           # vitest 单元测试
```

要求 Node.js >= 18.17。

## CLI 用法

```bash
# 人工调试：执行一次浏览器读取（stdout 输出一份 JSON）
node dist/cli.js read --url "https://example.com/article/123" \
  --fallback-type http_403 --content-id 123

# OpenClaw Skill：整份 JSON 必须经 exec 工具的独立 env 字段传入
node dist/cli.js read --input-env VWR_READ_INPUT_JSON

# 长正文分块 / 清理
node dist/cli.js chunk --run-id <uuid> --index 1
node dist/cli.js cleanup --run-id <uuid>
node dist/cli.js cleanup --expired

# 仅供安装验收与人工排障（不得进入正常读取流程）
node dist/cli.js doctor
```

退出码：`0` 已产出结构化业务结果（包括验证码、登录墙、部分读取等，具体看
JSON 的 `status` 字段）；`64` 输入无效；`70` 无法生成结构化结果的内部故障。

状态枚举与输出字段见 `skill/verified-web-reader/references/status-contract.md`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `VWR_BROWSER_BACKEND` | `openclaw` | `openclaw`（同机托管浏览器）或 `cdp`（远程 CDP） |
| `VWR_OPENCLAW_BIN` | `openclaw` | OpenClaw 可执行文件（execFile argv 调用，不经过 shell） |
| `VWR_BROWSER_PROFILE` | `verified-reader` | 专用浏览器 profile，与个人浏览器隔离 |
| `VWR_CDP_URL` | `http://127.0.0.1:9222` | CDP HTTP 端点；只允许回环/私网/SSH 隧道 |
| `VWR_STOP_BROWSER_IF_STARTED` | `1` | 浏览器由本次任务启动时，任务结束后停止该 profile |
| `VWR_KEEP_BROWSER_TAB` | `0` | 调试用；保留任务标签页（会产生 warning） |
| `VWR_INLINE_CONTENT_CHARS` | `6000` | 超过此长度的正文走临时分块 |
| `VWR_CHUNK_CHARS` | `6000` | 单个分块字符数 |
| `VWR_MAX_CONTENT_CHARS` | `300000` | 正文提取上限（触顶视为不完整） |
| `VWR_MAX_WAIT_MS` | `25000` | 页面就绪等待上限 |
| `VWR_BROWSER_CMD_TIMEOUT_MS` | `30000` | 单次浏览器控制命令超时 |
| `VWR_MAX_SCROLLS` / `VWR_MAX_EXPANDS` | `8` / `5` | 滚动与展开次数上限 |
| `VWR_MAX_REDIRECTS` | `5` | CDP 文档导航的最大重定向次数 |
| `VWR_STABLE_READ_INTERVAL_MS` | `1200` | 两次稳定读取的间隔 |
| `VWR_MIN_CONTENT_CHARS` | `200` | 正文最短可信长度 |
| `VWR_TTL_MINUTES` | `15` | 临时分块过期时间 |
| `VWR_MAX_TEMP_BYTES` | `8388608` | 临时正文总量上限 |
| `VWR_LOG_LEVEL` | `warn` | stderr 日志级别；stdout 永远只有 JSON |
| `VWR_PROFILE_LOCK_WAIT_MS` | `30000` | 同一 managed profile 并发任务的最长排队时间 |
| `VWR_PROFILE_LOCK_STALE_MS` | `300000` | 异常退出后 profile 锁的失效时间 |

Skill 调用必须使用 `{baseDir}` 定位脚本，并把 `VWR_READ_INPUT_JSON` 放在
OpenClaw exec 工具的独立 `env` 字段；不得把 URL 或 JSON拼入 Shell 命令。

## 浏览器后端

### openclaw（同机托管浏览器）

CLI 通过 `openclaw browser ...` 子命令（`status/start/stop/open/focus/
evaluate/close`，全部 execFile argv 数组）控制专用 profile，参数形式已按
OpenClaw 2026.7.1-2 的实际 CLI 核对（`open`/`close`/`focus` 位置参数、
`evaluate --fn`）。优先使用 `suggestedTargetId`/稳定 `tabId`，避免导航替换原始
target 后丢失标签页。若后续版本旗标变化，只需调整 `src/browser-client.ts`
中的 `openclawArgs` 常量（有单元测试锁定 argv 数组形式）。

OpenClaw 的 `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` 必须保持未设置或
`false`（当前默认即严格模式）。本工具还会在导航前和最终 URL 上独立校验；
OpenClaw 的请求级策略负责在浏览器侧拦截被拒绝的文档导航。高安全环境仍应使用
主机出口防火墙或策略代理作为最终网络边界。

生命周期所有权：profile 原本在运行 → 只复用、绝不停止；profile 由本次任务
启动 → 任务结束按 `VWR_STOP_BROWSER_IF_STARTED` 停止。任务标签页无论成败
都在 `finally` 中关闭。

### cdp（远程 CDP，如腾讯云浏览器 + SSH 隧道）

- 只在兜底任务期间连接 `VWR_CDP_URL`，任务结束关闭标签页并断开；
- 该后端不启动、不停止远程浏览器（生命周期属于既有基础设施）；
- 端点不可达时直接返回 `browser_unavailable`，不做无限重连；
- 通过 CDP `Fetch.requestPaused` 在每个 HTTP(S) 请求继续之前执行 URL/DNS
  安全检查，文档重定向单独计数，子资源不再被误算为重定向；
- CDP 端口禁止暴露公网，仅限 `127.0.0.1`、私网或 SSH 隧道。

WSL + 腾讯云示例：`ssh -N -L 9222:127.0.0.1:9222 user@host`（由你现有的
运维方式管理，本项目不创建常驻隧道服务）。

## 安装为 OpenClaw Skill

1. `npm install && npm run build`；
2. 把 `skill/verified-web-reader/` 复制到 OpenClaw 的 Skill 目录；Skill 内使用
   `{baseDir}` 引用自身脚本，不依赖 workspace 当前目录；
3. 设置环境变量 `VWR_CLI_JS` 指向构建产物 `dist/cli.js` 的绝对路径
   （或直接编辑 `scripts/verified-browser-read` 中的默认路径）；
4. 配置专用 browser profile（`verified-reader`）；
5. 人工执行一次 `verified-browser-read doctor` 和真实页面 smoke test。

禁止的部署动作：`openclaw mcp add`、systemd/PM2/Supervisor 常驻、
`docker run --restart=always`、cron 清理任务、浏览器预热任务。

部署后可人工运行一次 `scripts/acceptance-smoke.sh <公开测试URL>`，检查 browser
doctor、真实读取、标签页关闭、进程退出和监听端口不变。该脚本只用于安装验收，
不得由 Skill 正常读取流程调用。

## 项目结构

```text
src/
├── cli.ts                  一次性 CLI 入口（read/chunk/cleanup/doctor）
├── config.ts               环境变量配置
├── browser-runner.ts       兜底流程编排 + 浏览器生命周期所有权
├── browser-client.ts       openclaw / CDP 双后端（argv 数组，无 shell）
├── exclusive-run-lock.ts   managed profile 跨进程互斥与活性刷新
├── browser-page-script.ts  固定页面脚本（参数只作为 JSON 数据注入）
├── page-verifier.ts        页面身份 + 正文完整性验证（fail-closed）
├── blockers.ts             登录/验证码/付费墙/错页识别
├── url-safety.ts           SSRF 防护（私网/回环/元数据地址拒绝 + DNS 校验）
├── temp-chunk-store.ts     短期临时分块（0700/0600，无守护进程）
└── site-adapters/          generic 通用 + zhihu 回答适配器
skill/verified-web-reader/  OpenClaw Skill（SKILL.md + wrapper + references）
scripts/acceptance-smoke.sh 目标机手工验收（非正常读取流程）
test/                       vitest 单元测试与 HTML fixtures
CODE_REVIEW_AND_FIXES.md    需求覆盖、问题修复与验证记录
```
