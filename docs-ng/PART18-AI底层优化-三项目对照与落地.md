# PART18 · AI 底层优化：Codex / Claude Code / DeepSeek Harness 对照与落地

生成时间：2026-11-12

范围：只处理 AI 引擎与对话呈现的底层逻辑，不改变产品入口，不新增第二套插件内核。

## 1. 一页结论

三家实现的共同点不是“提示词更长”，而是把 agent 当成一套可恢复的运行时：

1. **会话历史是不可变事实，模型上下文是它的可替换投影。**
2. **一次模型请求必须冻结**；流式期间的新输入、页面变化和工具状态只影响下一次 step。
3. **缓存依赖前缀稳定性**：系统提示、工具定义、历史顺序不能无理由变化。
4. **上下文超限先做配对安全的修剪与压缩**，不能逐条删消息制造孤立 tool call。
5. **工具结果、审批、取消、失败都必须落到同一事件链**，UI 只渲染投影。
6. **复杂能力按需加载**，高频工具保持小而稳定；动态能力追加，不重排既有前缀。
7. **最终回答只交付结论、证据、操作结果和下一步**，内部推理不混入正文。

Hira 原有 turn / step、事件溯源、审批流水线和三宿主共享状态方向正确。主要差距是请求预算没有覆盖完整请求、全部工具常驻、旧工具结果反复计费、长对话只裁不总结，以及缓存收益不可观测。

## 2. 对照结论

| 底层问题 | OpenAI Codex / Responses | Claude Code | DeepSeek Harness | Hira 采用 |
|---|---|---|---|---|
| 多步执行 | Responses + tool outputs 继续推理；服务端压缩跨阈值触发 | gather context → take action → verify，可随时 steer | turn / step，单会话单活跃 driver | 保留 turn / step，取消后补齐工具结果 |
| 上下文压缩 | `/responses/compact` 或 `context_management.compact_threshold`；压缩项原样传递 | 自动 compact；摘要后重新注入系统提示、项目规则、记忆、最近文件 | 先修剪工具结果，再对旧区间做摘要；压缩事件可恢复 | 整轮删除 + 模型摘要检查点；UI 仍保留原始历史 |
| 缓存前缀 | 稳定指令 / 工具在前；历史追加；压缩与摘要会改变前缀 | system prompt + 工具、项目上下文、conversation 三层；改工具集会整体失效 | 系统头、工具顺序、历史必须字节稳定；动态内容作为尾部快照 | 核心工具固定顺序；扩展工具只追加；请求记录 hash |
| 工具数量 | 工具定义影响前缀与成本，能力应稳定可复用 | 工具、skills、MCP 分层；skill 内容作为会话消息追加 | 条件工具与按需能力，不把全部声明塞给模型 | 20 个核心工具 + `tool_search` 动态追加 |
| 工具结果 | 作为后续 input item 回传 | tool result 进入会话，长结果会占 context | 8192 字符阈值，保头尾；配对不可破坏 | 当前回合 24KB、历史 3KB，保头尾 |
| 取消 / 失败 | 需要可恢复的 response / compaction item | 会话可恢复、fork，执行中可 steer | 失败步骤补 tool result，取消原因结构化 | 取消信号透传到工具；孤立 call/result 不进入模型 |
| 输出逻辑 | 结果优先，避免过程噪声；证据与动作可追溯 | CLI 中工具过程与最终答复分离 | reasoning 与 final answer 分层；不倾倒 JSON | 稳定回答契约；运行时错误转可操作文案 |

## 3. 本轮已落地

### 3.1 按需工具面

文件：`apps/app-main/plugins/ai/core/tool-surface.cts`

- 默认只暴露高频浏览器能力：标签、读页、页面操作、搜索、设置、日志、面板等。
- 新增 `tool_search`，模型需要插件、主题、下载、权限、工作室等能力时先检索。
- 核心工具顺序固定；扩展工具按加载顺序追加到尾部，同一会话只增不减。
- 会话内已加载工具持久保存在 runner 内存中，避免每次追问重新搜索和重排 schema。
- 纯浏览器基线曾降到“21 个 schema / 6632 字符”；接入本地 Agent 后默认面为“35 个 schema / 11265 字符”，相对全量“96 个 / 32637 字符”仍缩小约 65%，且高频本地能力无需再搜索。

这不是权限白名单：所有工具仍可被发现和调用，隐藏工具若被模型猜名调用会被拒绝并提示先搜索。

### 3.2 完整请求预算

文件：`apps/app-main/plugins/ai/core/context.cts`、`core/tokens.cts`、`main/turn-runner.cts`

- 预算同时计算系统提示、完整工具 schema、消息、推理正文、工具参数与工具结果。
- 每条消息、每个 content block 增加固定结构开销，避免“正文没超但请求超了”。
- 输出预留不再固定 4096；优先使用模型 `maxOutputTokens`。
- 超限按完整 user turn 删除，不再逐条 shift 破坏 tool-call / tool-result 配对。
- 当前回合工具结果保留 24KB，历史结果压到 3KB；两者都保留头尾，兼顾正文与末尾状态字段。

### 3.3 持久压缩检查点

文件：`main/turn-runner.cts`、`core/store.cts`

- 预算发生整轮裁剪时，调用同一模型生成结构化旧会话摘要。
- 摘要写入 `context/compacted` 事件，包含 `throughSeq`、摘要、压缩前 token 和来源消息数。
- 模型投影只替换 `throughSeq` 之前的内容；UI 与导出仍读取原始事件，不丢用户历史。
- 摘要失败不影响本轮：保留原始事件，继续使用配对安全的硬裁剪。
- 摘要调用单独记 usage，成本不隐身。

### 3.4 缓存可观测性

文件：`core/providers.cts`、`core/store.cts`、`pages/aisettings/sections/usage.ts`

- 解析 OpenAI `cached_tokens`、DeepSeek `prompt_cache_hit_tokens`、Anthropic `cache_read_input_tokens`。
- `ai_usage` 增加 `cached_tokens` 幂等迁移；用量页展示输入 / 缓存命中 / 输出。
- `step/start` 记录 `systemHash`、`toolsHash`、`prefixHash` 与估算输入 token，便于判断是哪一层破坏缓存。
- Anthropic 请求在稳定 system 与最后一个工具 schema 上设置 ephemeral cache breakpoint；兼容网关拒绝时自动降级重试。

### 3.5 工具回路正确性

文件：`main/turn-runner.cts`

- 模型取消后仍为每个已返回的工具调用补结果，避免下一轮出现孤立 tool call。
- 工具执行接收同一个 `AbortSignal`。
- 旧历史中孤立的 tool-call / tool-result 在模型投影层过滤，不让脏日志永久毒化会话。
- 异常记录包含错误码与堆栈；界面不再直接暴露 `Cannot read properties...` 这类运行时文案。

### 3.6 输出质量

文件：`core/context.cts`

稳定系统提示新增可验证规则：

1. 先给结论或实际结果；简单事实用短段落，多条目、功能、步骤、来源、观点和信息采集结果必须使用可扫描的分组清单。
2. 总结固定按「结论 → 关键要点 → 细节/风险 → 来源」组织，每条先给短标签再解释。
3. 信息获取和研究结果按「已确认事实 → 最新变化 → 影响 → 不确定项 → 来源」组织，不得省略用户明确要求的类别。
4. 三个以上对象或字段的对比优先使用 Markdown 表格，简单列表不强制表格化。
5. 当前页面、标签、设置和操作结果必须先取证；事实、推断和未确认项分开，并给来源链接。
6. 所需能力不在当前工具列表时先用 `tool_search`，不猜工具名。

Markdown 渲染器同时补齐 GFM 表格解析、列对齐、窄栏横向滚动和安全转义；模型输出表格不再显示成竖线文本。

### 3.7 稳定系统头与运行期上下文分离

- 系统提示只保留不随时间变化的身份、取证、权限和输出规则。
- `ai.system-prompt.section` 的插件贡献改为对话尾部隐藏 `RUNTIME CONTEXT` 快照。
- 页面、工作区、插件状态等动态值不再改写系统头；缓存最多从当前尾部失效，而不是整段历史重算。

## 4. 不照搬的部分

- 不引入 Cordis / Fiber 或第二套插件生命周期；Hira 已有 PluginRegistryV2 与槽位系统。
- 不照搬 DeepSeek Harness 的 Web Server、ACP、远程沙箱、profile / bundle / patch。
- 不默认开启多代理；简单浏览器任务使用子代理只会增加延迟和费用。
- 不采用固定 4 字符/token；Hira 的 CJK 估算更接近中文请求。
- 不将压缩摘要当 UI 历史真源；摘要只服务模型投影。

## 5. 后续仍应补齐

1. 对只读且声明 `isConcurrencySafe(args)` 的工具做并行批次；写操作保持独占。
2. 对话中显示压缩检查点、缓存命中与上下文压力，不隐藏系统做了什么。
3. 模型 / reasoning 中途切换时提示缓存失效，并在自然任务边界建议切换。

## 6. 参考

- OpenAI Compaction: <https://developers.openai.com/api/docs/guides/compaction>
- OpenAI Prompt caching: <https://developers.openai.com/api/docs/guides/prompt-caching>
- Claude Code agentic loop: <https://code.claude.com/docs/en/how-claude-code-works>
- Claude Code context window: <https://code.claude.com/docs/en/context-window>
- Claude Code prompt caching: <https://code.claude.com/docs/en/prompt-caching>
- DeepSeek Harness: <https://github.com/deepseek-ai/deepseek-harness>
- Hira 既有拆解：`docs-ng/PART14-DeepSeekHarness底层与Tabbit助手拆解.md`
