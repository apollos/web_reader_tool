# 站点适配器

对应设计文档第 12 节。适配器只是静态数据 + URL 逻辑；DOM 操作全部由固定
页面脚本执行，模型不生成任何页面代码。

## generic（通用兜底）

- 匹配：所有未被专用适配器命中的 URL。
- 正文候选优先级：`article` → `main` → `[role=main]` → 文本密度最高且
  链接密度较低的内容块。
- 排除：导航、页眉页脚、侧栏、评论、推荐、分享、登录提示。
- 内容 ID：URL 路径中最后一个 ≥3 位的纯数字段（如 /article/12345）。
- 允许的最终 host：目标 host 及其 www/裸域规范化形式。

## zhihu-answer（知乎回答）

- 匹配：`zhihu.com/question/<question_id>/answer/<answer_id>`。
- 从 URL 提取 question_id 和 answer_id；最终 URL 必须仍指向目标问题与回答。
- 目标容器：优先 `div.AnswerItem[name="<answer_id>"]`，否则要求容器内存在
  指向 `/answer/<answer_id>` 的链接或含该 ID 的 data 属性。
- **只在目标回答容器内**查找并点击"阅读全文"，页面上其他回答的同名按钮
  一律不点（多个同名按钮是固定回归场景）。
- 正文限定在 `.RichContent-inner`，排除互动区、打赏区、评论区、更多回答。
- 站点专用阻断特征：知乎异常流量验证页、登录引导（SignFlow）。

## 新增适配器要求

新适配器必须同时提供：URL 匹配规则、内容 ID 提取、正文容器定位、展开控件
限定范围、标题与作者提取、阻断特征、完整性策略、固定 HTML 测试夹具，以及
至少一个错页或多正文容器反例。实现位置：`src/site-adapters/`，并在
`src/site-adapters/index.ts` 中置于 generic 之前注册。
