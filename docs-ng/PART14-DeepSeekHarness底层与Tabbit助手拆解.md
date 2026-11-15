# PART14 · DeepSeek Harness 底层实现 + Tabbit 浏览器 AI 助手 · 拆解报告

生成时间：2026-10-29
状态：**只做研究，不落代码**。本文是 PART15（NG AI 助手引擎与双形态面板插件完整规划）的事实底座。
范围：① DeepSeek Harness（dsh）完整底层逻辑；② Tabbit 浏览器的 AI 助手形态与网页理解能力；③ 两者对 NG 的可迁移结论。
明确排除：RT / 老 Hira —— 无 AI 助手，不作为参考。

***

## 0. 一页结论

| 维度   | DeepSeek Harness                                    | Tabbit                                 | 对 NG 的结论                                                  |
| ---- | --------------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| 本质   | Agent 运行时（"Agent 的操作系统"），**Everything is a Plugin** | AI 原生浏览器（Chromium 壳 + 侧边 Chat + Agent） | 我们做的是**浏览器内的 AI 运行时**，不是聊天框                               |
| 插件底座 | Cordis：`apply(ctx)`、Fiber 状态机、依赖注入、可逆副作用            | 不对外开放底层，只有"技能/Skill"这一层                | NG 的 PluginRegistryV2 + SlotRegistry 已具备同构能力，**不再造第二套内核** |
| 组合方式 | profile → bundle → patch 分层叠加，YAML 即组合              | 无                                      | NG 用 manifest + `dependsOn` + 槽位，等价于"profile 的静态版"        |
| 唯一真源 | 事件溯源会话日志（`SessionEvent` 只追加）                        | 本地保存 highlights/chats                  | NG 用 SQLite/Drizzle 做事件表，禁止"内存里再存一份对话"                    |
| 执行模型 | turn / step，流式 + 工具调用 + 审批 + 取消                     | 单轮 Agent 自主点击                          | 必须做 turn/step，否则无法插入"审批 / 打断 / 注入上下文"                     |
| 接API | provider 适配器 seam，自定义网关三种协议                         | 内置多模型，用户不可接自有 API                      | 我们要的是"用户自带 Key / 自带中转站"，**OpenAI 兼容优先**                   |
| 上下文  | 工作区文件 + MCP + 浏览器自动化 provider                       | @标签页 / 文件 / 截图 / 划词 / 收藏全文             | 浏览器上下文（页面 DOM、选区、截图、标签）是 NG 的护城河                          |
| UI   | client-ui 插件 + 会话投影渲染                               | 侧边栏 Chat + 独立窗口                        | NG 直接复用已有 `ui-panel-*` + `WINDOW_TYPES` 双形态范式             |

一句话：**DSH 提供"内核怎么写"，Tabbit 提供"浏览器里怎么用"，NG 提供"插件怎么装"。三者拼起来就是本文的 PART15 方案。**

## 0.5 分层学习边界（本次明确的硬规则）

> 用户口径：**功能性与上下文获取的操作方式 → 学 Tabbit（标准 AI 助手浏览器）；接 AI、跑模型、接 API、对话底层逻辑与优化 → 学 DSH（标准对话 Agent）。**
> 两者不可混用：拿 Tabbit 的产品形态去推底层，会做出"只有聊天框、没有引擎"的空壳；拿 DSH 的工程结构去推产品，会做出"给开发者用的终端"，不是浏览器助手。

| 层 | 学谁 | 具体学什么 | 明确不学什么 |
|---|---|---|---|
| **产品 / 交互层** | Tabbit | 入口位置与唤起方式；`@` 引用面板；上下文对象全集（标签页 / 元素 / 选区 / 截图 / 收藏 / 历史 / tab graves）；提问手势（划词、截图、拖入）；技能 `/` 调起与三类形态；收藏自动摘要；会话与页面并排的阅读工作流 | 不学它"内置模型、用户不能自带 API"；不学它的闭源实现假设 |
| **引擎 / 底层** | DSH | 事件溯源会话日志；turn/step 循环；inbox 三原语（followup / steer / inject）；工具流水线（前置 waterfall + 单调守卫 + 一次性审批 + 结果投影）；LLM 适配器 seam 与三协议；provider / model / credential / reasoning 的 schema 化；上下文注入的预算与裁剪；prompt 缓存友好；压缩（compaction）与工具结果修剪；流式 settlement 与投影；重试语义；取消语义 | 不学它的 Web Server / 远程部署 / 沙箱 / ACP / subagent 体系；不学它的 profile·bundle·patch YAML（NG 已有 manifest + dependsOn） |
| **插件 / 装配层** | NG 自身 | manifest 声明、SlotRegistry 四模式、面板与窗口双形态、插件六态与进程隔离 | 不引入第二套插件内核 |

**判据（写代码时用）**：这个决定如果做错了，用户会不会看见？
- 会看见（入口、手势、引用、卡片、布局）→ 按 Tabbit。
- 看不见（状态机、落盘、流、审批、裁剪、适配器）→ 按 DSH。

***

## 1. DeepSeek Harness 是什么

- 定位：DeepSeek 官方开源的 **Agent 运行时框架**，官方口号 *Everything is a Plugin*，社区总结 *Agent = Mod*。

- 形态：`dsh` CLI + Web UI（默认 `127.0.0.1:3080`）+ Electron 桌面应用 + Python/TypeScript SDK + ACP 自动化服务器。

- 状态：**技术预览（developer preview）**，接口会变；社区热度极高、插件生态（`dsh-plugin` topic）已成型。

- 关键事实：**没有特权内核**。模型适配器、工具注册表、会话日志、甚至 agent loop 本身都是插件，都能被配置替换。

这一条是全部设计的起点：**内核只负责插件生命周期、服务依赖图、事件分发、副作用回收**。

***

## 2. 骨架：Cordis 插件运行时

### 2.1 插件三形态

插件 = 导出 `apply` 的 TS 模块：

```ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'my-plugin'
export const inject = ['tools']          // 声明依赖
export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)          // 通过 ctx 注册能力
}
```

三种写法等价：函数式 / 对象式（`export default { name, inject, apply }`）/ 类式（`class X extends Service`，用于**对外提供服务**）。

### 2.2 Fiber 状态机

```
PENDING → LOADING → ACTIVE ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

- `PENDING`：已声明，`inject` 的服务未就绪 → **不会执行** **`apply`**。

- 依赖运行期消失（provider 卸载）→ 依赖方**自动 dispose**，服务回来后**自动重载**。

- `ctx.plugin(child)` 创建子 Fiber，随父卸载。

- `fiber.dispose()` 递归卸载、等待清理完成。

### 2.3 可逆副作用（自动清理）

通过 `ctx` 做的一切注册都被追踪，卸载时**逆序**撤销：`ctx.on()`、`ctx.tools.register()`、`ctx.llm.registerAdapter()`、`ctx.effect(cleanup)`。
异步清理是**并发**的，有顺序依赖的必须塞进同一个 `ctx.effect()` 里串行等待。

> 对 NG 的启示：插件系统已经有 `disable → removeImplementations` 的回收，但**引擎内部**（AI 引擎的流、定时器、网络请求）也必须"注册即可逆"，否则禁用插件等于内存泄漏。

### 2.4 服务与依赖注入

- 服务 = 挂在 `ctx` 上的具名能力（`ctx.tools` / `ctx.llm` / `ctx.agents`），用 `class X extends Service` + 声明合并获得类型。

- `inject` 是**加载闸门**；可选依赖用 `ctx.get('x')` 探测。

- **服务隔离**：`cordis.yml` 的 `isolate` 让不同插件组看到同一服务的不同实例（例：两个 Bash provider，5s / 60s 超时互不影响）。

### 2.5 事件系统（四种模式）

| 模式          | 语义                                  | 用途           |
| ----------- | ----------------------------------- | ------------ |
| `emit`      | 广播，返回值忽略                            | 生命周期通知       |
| `bail`      | 顺序执行，第一个非空返回即终止                     | 校验、短路        |
| `serial`    | 顺序执行并 await，首个非空即终止                 | 阶段推进         |
| `waterfall` | 每个监听器**必须调用** **`next()`**，可包裹下游返回值 | 拦截 / 改写 / 网关 |

`waterfall` 不调 `next()` 就是**故意短路**——这是"拦截器"的实现方式。类型安全靠 `declare module` 声明合并。

**三种事件域**（DSH 的核心分类法，非常值得抄）：

1. **会话事件**：追加进日志、由 `session/event` 广播的**持久事实**（`turn/*`、`step/*`、`user/message`、`assistant/message`、`tool/call`、`tool/result`）。
2. **Agent 事件**（`agent/*`）：携带活跃 Agent，用于**观察/拦截进行中的工作**（`agent/pre-step`、`agent/request`、`agent/status`）。
3. **能力事件**：挂在 seam 上的策略与适配器（`fs/*`、`tools/*`、`telemetry/*`）。

> 判据：**"重进进程后还要存在吗？"** 是 → 会话事件；否 → Agent/能力事件。

***

## 3. 组装：profile / bundle / patch

```
dsh 进程 = 一棵插件树
 ├─ profile（web / headless / sdk / desktop / acp）
 │    ├─ 有序 bundle（dsh-base → dsh-web-app …）
 │    ├─ profile 的 cordis.patch.yml
 │    ├─ home patch
 │    └─ --patch overlay（开发时插本地插件）
 └─ 每条 patch：按 id 定位条目 → 整条替换 config / 插入新条目
```

- `dsh-base` = 模型适配器 + 工具 + 持久化 + 沙箱与审批 + 设置 + 凭据 + 遥测的公共第一层。

- `dsh plugin --profile web add <git/包>` 安装树外插件；`dsh --profile web --dump-config` 打印最终配置树。

- **HMR**：改插件源码 → 卸载旧插件（清全部注册）→ 重载 → 新 `apply`。

> 对 NG 的启示：NG 的 manifest 是"声明式 profile"，但**没有 patch 层**。AI 引擎要允许用户级配置覆盖（例如同一个 provider 的 baseURL 被用户在设置页改掉），这层覆盖必须只有一处真源，不能写死在 manifest 里。

***

## 4. 能力 seam：三角色模型

**最有价值的一条设计原则。**

一项可替换能力必须拆成三个包：

| 角色                 | 职责                           | 例（Bash）          |
| ------------------ | ---------------------------- | ---------------- |
| Service Definition | 定义服务与 Request/Result 类型，很少改动 | `dsh-shell`      |
| Service Provider   | 实现能力，可多个，性能/安全独立演进           | `dsh-bash-local` |
| Consumer           | 把能力暴露给模型（工具）或 UI             | `dsh-tool-bash`  |

**Provider 与 Consumer 互不依赖**，都只依赖 Definition。换 provider（本地 → 远程沙箱）不需要动工具和提示词。

官方给出 60+ 服务清单，按域分组，可直接作为我们 AI 引擎的"能力词典"：

- **核心**：`sessions` / `systemPrompt` / `tools` / `agents` / `agentLoop` / `scope`

- **LLM**：`llm`（适配器 seam）/ `tokenMeter` / `compaction` / `toolResultPruner` / `subagentModelSelection`

- **Agent 运行**：`inbox`（概念）/ `jobs` / `goals` / `subagents` / `agentTeams` / `agentPresets` / `planMode` / `userQuestions` / `commands` / `skills`

- **执行与安全**：`shell` / `subprocess` / `terminals` / `fs` / `sandbox` / `sandboxPolicy` / `approval` / `permissionPresets` / `ptcRuntime` / `lsp`

- **上下文**：`workingDirectory` / `attachments` / `fileUploads` / `mcpResources` / `mcpClient` / `browserUse` / `computerUse` / `fileReferences` / `web`

- **持久化与设置**：`storage` / `sessionPersistence` / `settings` / `credentials` / `configEditor` / `workspaceRegistry`

- **UI/宿主**：`clientModules` / `webApp` / `webServer` / `sessionProjections` / `sessionController` / `pluginManager` / `pluginMarket` / `hmr`

> 特别注意 `browserUse` 与 `computerUse` 是**可替换 provider 的 seam**（Playwright MCP / Chrome DevTools MCP / native 三选一）。**浏览器内做的 AI，天然不需要外部浏览器自动化 provider —— 这本身就是一个巨大的实现优势。**

***

## 5. 核心执行链（底层逻辑）

### 5.1 唯一真源：事件溯源会话日志

- `core/session` 维护**仅追加**的 `SessionEvent` 日志（`ctx.sessions`）。

- `deriveMessages()` 从日志**投影**出模型历史；**模型可见 = 已记录**。

- 每个 `assistant/message` 内嵌产生它的紧凑流；失败/重试/取消记为 `assistant/attempt`（不进模型历史）。

- fork / 恢复 / transcript / 遥测 / 持久化全部从日志派生，**实时 UI 增量**来自 `agent/assistant-stream`（进程内 start/chunk/end 帧）。

- 插件可注册**纯消息投影**改内容而不改日志。

- `sessionProjections`：增量折叠已提交事件，UI 用 `stateOf()` 读类型化状态、`snapshot()` 批量取客户端视图。

> 这是"流式 UI 与持久化不打架"的答案：**流是进程内事件，落盘是提交后的帧**。

### 5.2 轮次流程（turn / step 时序）

```
turn/start
  claim next-step input + 一条排队消息
  组装 prompt 段落 + 工具 schema
  -> agent/pre-step (waterfall)   // 可改写 / 拒绝 / enter
step/start
  agent/request -> prepareCall()  // 解析路由、提交系统提示与用户消息
  append user/message，冻结历史
  -> llm/stream -> agent/assistant-stream(start)
  agent/assistant-stream(chunk*)
  assistant/message | assistant/attempt -> agent/assistant-stream(end)
  tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
step/end
  还有欠账或新 next-step 输入 -> 下一个 step
  -> agent/turn-stopping (serial)
turn/end
```

要点：

- **一个 step = 一次模型请求 + 它的工具调用**；一个 turn = 0..n 个 step。

- 取消：`AbortSignal` + 稳定 `cause`（user / parent / hook / disposed），持久化为 `turn/end { kind: 'aborted' }`。

- **重试不会重跑** **`agent/pre-step`**，避免上下文重复注入。

- 失败步骤必须**补记缺失的工具结果**，否则下次请求的 tool\_call 没有对应 tool\_result。

### 5.3 Agent 句柄（对外唯一编程面）

```ts
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions      // provider / model / reasoningEffort / maxTokens
  readonly session: Session           // 日志是真源
  readonly inbox: Inbox               // next-turn / next-step 两条有序待办
  readonly status: 'idle' | 'running'
  readonly ctx: Context               // agent 作用域，随 dispose 回收
  send(msg, target, wakeup)           // 底层投递
  followup(msg)                       // 排队一个完整新轮次
  steer(msg)                          // 最近一个 step 边界插入
  inject(msg)                         // 只进上下文，不唤醒
  cancel(cause, { keepInbox? })
  whenIdle()
  runMaintenance(task)
}
```

`Inbox` 支持 `append/prepend/replace/remove/splice`，变更持久化为 `agent/inbox/spliced`。
`followup / steer / inject` 就是"用户补充、工具中途打断、自动注入页面上下文"三件事的**原语**。

> NG 必须原样保留这三个语义。少了 `steer`，"AI 正在跑时用户改主意"就只能取消重来。

### 5.4 工具执行流水线（含审批）

```
assistant tool-call
  -> 记 tool/call（执行前落盘，UI 显示 pending 卡片）
  -> tools/pre-execute (waterfall)     // 钩子 / 权限 / 沙箱
  -> 单调守卫（deny 或弃权，身份受保护）
  -> ctx.approval 一次性询问（无法回答 = 拒绝）
  -> tools/execute (waterfall)          // 超时 / 重试 / 指标包裹
  -> 工具 body -> projectContent（准备文本与图片）
  -> tools/post-execute (waterfall)     // accept / block / replace / 追加上下文
  -> finalizeContent（最后一道纯内容不变量）
  -> tools/result（同步通知，冻结终局）
  -> 追加 user/message 形式的 additionalContext
  -> 记 tool/result，批次结清，UI 完成卡片
```

关键点：**审批在守卫之前、单一 waterfall 承载跨工具族的策略**，工具本身不与策略服务耦合。

### 5.5 LLM seam

- `ctx.llm` 是适配器注册表：插件 `ctx.llm.registerAdapter(names, adapter)`。

- 词汇表由 `packages/llm` 声明：`Message` / `ContentBlock` / `StreamChunk` / 模型请求。

- 路由 = `provider + model + reasoningEffort + maxTokens`，请求前解析，缺失即拒绝。

- 支持 **PTC mode**（`run_code` 传输 + 子调用，子调用携带父级 token，拒绝是"有约束力的驳回"）。

***

## 6. "自己接 API" 的完整机制（重点对照）

DSH 在**设置 → 模型**里提供两种卡片：

### 6.1 内置 provider

`anthropic` / `openai` / `moonshotai`(Kimi) / `zai`(GLM) / `deepseek` / `deepseek-account` 等，由"已安装目录"提供端点、协议、模型列表。

### 6.2 自定义模型 API（中转站 / 公司网关 / 自建服务）

| 字段          | 说明                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------- |
| Provider ID | **小写、永久**（请求、会话、模型默认值、凭据引用都用它；想改名 = 新建再删旧）                                                |
| 基础 URL      | 端点                                                                                        |
| API 协议      | **三选一**：`openai-completions` / `openai-responses` / `anthropic-messages`（一个 provider 只一种） |
| 凭据          | API Key 或环境变量后备，**只写**，页面只拿脱敏描述符                                                          |
| 模型目录        | 至少一个模型：ID / 显示名 / 上下文窗口 / 最大输出 / 输入类型（text / image）/ 推理等级                                 |
| 探测          | "获取可用模型"用表单当前地址+协议+密钥询问端点（失败可手填，等价）                                                       |

### 6.3 凭据与配置落点

- 密钥存 `$DSH_HOME/.credentials.yaml`，settings 只存**引用**；输入框只写，眼睛按钮看当前输入，保存后不可回读。

- 模型页写 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`；适配器**下一次请求**重读，无需重启。

- 推理等级：档位 `off/low/medium/high` → **API 参数值**可逐档映射；关掉开关即删除声明。

- 图片输入：`input: [text, image]`（pi-ai）或 `inputModalities`（DeepSeek 直连，空列表会被拒）。

> 结论：**"自己接 API"不是一个输入框，而是一张 schema**。NG 必须把 provider/model/credential/reasoning 做成结构化数据 + 独立存储，而不是在面板里塞 `fetch(key)`。

***

## 7. UI 侧：插件化的客户端

- `client-ui-*` 包（如 `client-ui-plugin-manager`、`client-ui-plugin-market`、`client-ui-sidebar-documentpreview`、`client-ui-cot-translation`）证明 **UI 面板本身也是插件**。

- 会话渲染：**驱动** **`ctx.agents`** **+ 从** **`session/event`** **渲染**，不自己保存对话状态。

- 扩展 UI 的官方入口：注册 `ConversationNodeDefinition` + keyed renderer（新增一种聊天节点，如工具卡、审批卡、diff 卡）。

- 设置页有"插件式卡片"注册（`ctx.settings` / config catalog 自动生成文档）。

- 桌面端：Electron 私有 Host 跑完整 Web 应用，窗口加载打包资源 → 同一文档内激活客户端插件；Node IPC 只传启动注入 / 就绪 / 致命错误 / 关闭。

> 对 NG：NG 已经是"主进程 + 三类 webContents + 渲染侧插槽"的结构，比 DSH 的浏览器形态更贴近真实浏览器。**要抄的是"UI 从会话投影渲染"，不是它的 Web Server。**

***

## 8. DSH → NG 的映射表（哪些抄、哪些不抄）

| DSH 机制                         | NG 现状                                    | 结论                                      |
| ------------------------------ | ---------------------------------------- | --------------------------------------- |
| Cordis Fiber 生命周期              | PluginRegistryV2 六态 + 前置依赖 + 热重载 + 进程级隔离 | **已有，不重造**；AI 引擎按同样六态接入                 |
| 服务注入 `inject`                  | manifest `dependsOn` + ProviderRegistry  | **已有**；AI 内部 seam 用同类依赖声明               |
| 事件四模式                          | SlotRegistry `SINGLE/MULTI/REDUCE/EVENT` | **一一对应**，新增 AI 槽位即可                     |
| profile / bundle / patch       | manifest + dependsOn                     | 缺"用户补丁层"，AI provider 配置需要它              |
| 会话事件日志                         | SQLite/Drizzle，但目前无事件溯源                  | **要新增**（AI 会话表按事件追加）                    |
| turn/step + inbox              | 无                                        | **必抄**（引擎骨架）                            |
| 工具执行流水线 + 审批                   | 无                                        | **必抄**（浏览器自动化必须审批）                      |
| LLM 适配器 seam                   | 无                                        | **必抄**（三协议 + 自定义网关）                     |
| client-ui 插件 + 会话投影渲染          | 面板已是插件                                   | **必抄渲染原则**，不抄 Web Server                |
| MCP / browserUse / computerUse | 无                                        | **不抄 browserUse**（我们就在浏览器里）；MCP 留作后续开放面 |
| Sandbox / 远程执行                 | 无                                        | 不抄；浏览器工具天然自有权限边界                        |
| subagent / agentTeams          | 无                                        | 后续可选（多智能体），不进第一版                        |

***

## 9. Tabbit 浏览器 AI 助手拆解

### 9.1 定位与形态

- 美团光年之外团队出品，Chromium 内核，**AI 原生浏览器**；"The Agentic AI Browser"。

- 三种入口：**右上角 Chat 按钮 / 快捷键 / 新标签页直接下任务**。

- 形态：**侧边栏 Chat 为主**，不是独立窗口；Agent 执行时页面自动跳转、点击、提取。

- 与插件的关系：**不是浏览器扩展**，是壳内一等公民。

### 9.2 上下文系统：`@ anything`

官方原话 "Not just tabs. PDFs, bookmarks, HTML elements, tab graves. Every bit on your desktop."

可引用对象：

- 标签页 / 标签组 / **已关闭的标签（tab graves）**

- 本地文件（PDF 等）

- 截图 / 划词高亮（highlights）

- **网页里的具体 DOM 元素**（"whatever you bring in"）

- 收藏页 / 历史（全文检索）

工程含义：需要一条**统一的"上下文条目"总线**（type + resolver + token 计量 + 去重 + 展示 chip），而不是给每种来源写一条 if。

### 9.3 网页理解

- 直接读当前页 **DOM**（不是剪贴板/扩展桥），所以长文翻译、观点提取比插件准确。

- 划词 + 截图提问（"哪里不会点哪里"）。**NG 只保留截图提问与右键菜单意图，不做页面内划词浮动条**（理由见 §9.8 第 3 条）。

- 收藏页自动生成摘要（Favorite = 链接 + AI 简报）。

- "技能"里的**脚本型 Skill** 可对页面做处理（去广告、生成目录），并可保存复用。

### 9.4 Agent 执行

- 跨页面、跨标签自主执行：搜索、打开、阅读、提取、填表。

- 多智能体：Research / Operator / Writer / Analyst，各自加载对应 Skills。

- **Agent Memory**（长期记忆）。

- 站点 MCP（Site MCPs）—— 让特定站点暴露结构化能力。

### 9.5 技能 / Skills

- 三种类型：**提示词（prompt）/ 脚本（script）/ 智能代理（agent）**。

- 每个技能可选图标、颜色；Chat 输入框 `/` 调起。

- 官方站点技能库（2000+，覆盖 YouTube/Bilibili/ChatGPT/Substack/Papers/GitHub/Gmail…），也允许用户自建。

- 脚本型：AI 生成代码 → 点击执行 → 满意则存为技能。

### 9.6 模型与隐私

- 内置多家模型（国内：Doubao / Kimi / Qwen / GLM / DeepSeek；国际：GPT / Gemini / Claude / Grok），输入框下切换。

- 声明：highlights / chats / saved pages **留在本机**，不售卖、不用于训练。

- **不提供自带 API**（这正是 NG 的差异点与优势）。

### 9.7 Tabbit → NG 的对应能力

| Tabbit 能力   | NG 已有底座                                              | 缺口                    |
| ----------- | ---------------------------------------------------- | --------------------- |
| 侧边 Chat     | `ui-panel-*` + rail + `side-panel.panel-render-slot` | 聊天面板本体                |
| @ 标签页       | `domain-tabs` / `opentabs` 面板                        | 上下文总线                 |
| @ 网页元素 / 划词 | `ui-webviews` / tab webContents                      | 选区与 DOM 采集协议          |
| @ 截图        | 已有截图/标注（`ui-capture-editor`）                         | 接入上下文总线               |
| @ 收藏 / 历史   | `domain-bookmark` / `domain-history`                 | 全文检索接入                |
| 技能 / Skills | 插件 `contributes.pages` / `bangs`                     | Skill 声明 + `/` 调起     |
| Agent 自动操作  | `WebContentsManager`（主进程持有 tab webContents）          | 工具层 + 审批              |
| 独立窗口形态      | `WINDOW_TYPES` + 共享 subwindow 入口（插件管理即范例）            | AI 窗口类型               |
| 多模型切换       | 无                                                    | provider/model schema |
| 本地隐私        | 已有本地 SQLite                                          | 日志与密钥策略               |

### 9.8 上下文获取的交互范式（产品层要照搬的部分）

这一节只讲**用户怎么把东西给 AI**，不涉及引擎。NG 应逐条对齐，因为它决定"AI 助手像不像浏览器里的东西"。

1. **三个入口，一套会话**
   - 侧栏 rail 图标 → 打开 AI 面板（默认）
   - 全局快捷键 → 面板展开 / 收起（焦点进输入框）
   - 新标签页里直接下任务（命令式输入 → 自动开面板执行）
   入口不同，但落到同一个会话模型，**不因入口分叉出第二套状态**。

2. **`@` 是一等公民，不是彩蛋**
   - 输入框打 `@` 弹出引用面板，可连续多选；
   - 引用对象：当前标签页 / 其他标签页 / 标签组 / 已关闭标签（tab graves）/ 收藏 / 历史 / 本地文件 / 当前选区 / 截图；
   - 选中后变成 composer 上方的一排 **chip**，可单独删除；
   - chip 与消息一起发送，回答里出现**可点回的引用标记**（点击回到原标签页或高亮原选区）。
   - 关键细节：**引用是显式的**。AI 不"偷偷读所有标签页"，用户永远知道这次给了什么。

3. **三种入口：右键菜单 / 截图 / 拖入（不做划词浮动条）**
   - **右键菜单**（替代划词浮动条）：不往页面里注入任何 UI，复用 NG 现有菜单体系（`context-menu.item` / `webview.context-menu.item` 槽位）。
     - 选区右键：「AI 解释」「AI 翻译」「AI 总结所选」→ 直接开面板并流式出结果；「问 AI 关于这段…」→ 只填 chip、不自动发送。
     - 页面空白右键：「用 AI 总结此页」「用 AI 解读此页」「问 AI 关于此页…」。
     - 链接右键：「用 AI 总结此链接」（后台加载后提取正文，再把结果带进面板）。
     - 图片右键：「用 AI 识别此图片」。
     - 标签 / 标签组 / 书签 / 历史 / 笔记右键：「用 AI 总结」「加入 AI 上下文」。
   - **截图**：框选区域 → 作为图片上下文；适合图表、PDF、视频帧。
   - **拖入**：文件拖到面板即成为上下文，不必先上传对话框。
   - 为什么不要浮动条：注入式 UI 污染页面、与站点样式打架、权限面更大、还要处理 iframe/缩放/遮挡；右键菜单是浏览器原生心智，零页面侵入，且菜单项随插件禁用自动消失。

4. **"看得见的上下文"**
   Tabbit 的原话是 *"你看见的，就是上下文"*。工程上要落到三条：
   - 当前页默认只带**标题 + URL**（省 token、可控）；
   - 正文要用户点"读此页"或首次站点授权后才进上下文；
   - 面板顶部常驻一行"本次上下文"摘要（几个标签页、多少字符、是否含截图）。

5. **技能 `/`**
   - 输入 `/` 弹出技能列表（图标 + 名称 + 类型）；
   - 选中后把模板填入输入框，参数位高亮待填；
   - 技能可以是 prompt / script / agent 三类，行为不同但入口统一。

6. **会话与页面并排**
   - 面板态：页面在左、AI 在右，滚动互不干扰；
   - 窗口态：AI 独立窗口，可与主窗并排（这正是 NG `WINDOW_TYPES` 的强项）；
   - 同一会话在两种形态间切换时，**滚动位置与草稿都要保留**。

7. **收藏即知识**
   - 收藏一个页面时顺手生成摘要（用户可选择关闭）；
   - 摘要进入收藏卡片，日后 `@收藏` 直接引用摘要而不是整页。

> 以上 7 条属于**交互契约**，写进 PART15 的 UI 与上下文章节；底层怎么采集、怎么裁剪、怎么注入，一律按 DSH 的管道来。

***

## 10. 适合浏览器的 AI 助手：能力清单（定优先级用）

| #  | 能力                                  | 依赖                     | 优先级 |
| -- | ----------------------------------- | ---------------------- | --- |
| 1  | 侧栏对话（流式、Markdown、停止/重生成）            | 引擎 + 面板                | P0  |
| 2  | 当前页摘要 / 翻译 / 解释（DOM 提取）             | 上下文采集                  | P0  |
| 3  | 右键菜单提问（选区 / 页面 / 链接 / 图片）  | 菜单 intent → 上下文        | P0  |
| 4  | 自定义 API（Key / baseURL / 协议 / 模型）    | provider schema + 密钥存储 | P0  |
| 5  | 会话持久化 / 多会话 / 搜索                    | SQLite                 | P0  |
| 6  | 面板 ↔ 独立窗口双形态切换                      | `WINDOW_TYPES`         | P0  |
| 7  | `@` 引用：标签页 / 收藏 / 历史 / 文件           | 上下文总线                  | P1  |
| 8  | 工具调用：开标签、读页、滚动、点击、填表                | 工具层 + 审批               | P1  |
| 9  | 技能 / Skill（prompt / script / agent） | 插件声明面                  | P1  |
| 10 | 页面脚本注入式 Skill（去干扰、目录）               | 已有 inject 面板能力         | P2  |
| 11 | 收藏自动摘要 / 历史语义检索（RAG）                | 向量或 FTS                | P2  |
| 12 | 多智能体 / 长任务后台执行                      | 子 Agent                | P3  |
| 13 | 站点 MCP / 外部 MCP                     | MCP client             | P3  |

***

## 11. 本案不参考的对象

- **RT / 老 Hira**：无 AI 助手，架构与插件形态也不同，避免污染设计。

- **Tabbit 的闭源实现**：只借鉴**产品形态与能力边界**，不假设其内部机制。

- **DSH 的 Web Server / 远程部署 / 沙箱 / subagent**：与浏览器场景无关，第一版不做。

***

## 12. 引擎层优化清单（DSH 可直接照搬）

这一节只列**能不能抄、抄了省什么**，不重复原理。

| # | DSH 的做法 | 解决的痛点 | NG 怎么用 |
|---|---|---|---|
| 1 | **请求冻结**：一次 step 的消息数组、工具 schema、路由全部不可变，只复用"冻结证据" | 流式期间被别处改写导致请求错乱 | 把 `AiPreparedCall` 冻结后再发；`inject/steer` 落到**下一次** step |
| 2 | **重试不重跑 `pre-step`** | 重试重复注入上下文、历史膨胀 | 重试只重发请求，不重跑"前置决策/注入" |
| 3 | **系统提示即 surface 节点**（`system/message`） | 提示词改了要重建整个请求；缓存前缀被打断 | 提示词按"稳定前缀 + 可变尾段"组织，稳定段放前，利于上游 prompt 缓存命中 |
| 4 | **流式 settlement 与日志分离**：进程内 `start/chunk/end` 帧 + 提交后的 `assistant/message` | UI 卡顿、断线重连、崩溃丢流 | 帧只走 IPC；落盘只在提交时一次；重开面板从日志重建，不依赖内存 |
| 5 | **事件溯源 + 增量投影**（`sessionProjections`） | 全量重算导致切会话卡顿 | 打开会话只 fold 一次；之后按事件增量 patch；缓存可重建 |
| 6 | **压缩 seam（compaction）**：独立能力，不在主循环里 | 长会话上下文溢出 | `ai.compaction` 槽位；基础 provider 做"摘要 + replace 区间"；后续可换后端 |
| 7 | **工具结果修剪（toolResultPruner）+ token 计量（tokenMeter）** | 工具输出撑爆上下文 | 旧 `tool/result` 先降低保真度，再整段替换；发送前按真实/估算 token 计量 |
| 8 | **工具结果无损快照 + 内容投影/裁剪** | 超大 JSON / base64 撑爆内存 | 结果先快照，再 `projectContent`（图片转附件引用），最后 `finalizeContent` |
| 9 | **失败步骤补记缺失的 tool/result** | 下次请求出现孤立 tool_call 被拒 | 中断/异常时补 `tool/result{ok:false, reason}` |
| 10 | **取消原因结构化**（user / parent / hook / disposed）+ `keepInbox` | 取消后排队消息全丢，或取消不彻底 | 取消只杀当前 step；`keepInbox` 决定排队消息去留 |
| 11 | **Agent 作用域 `ctx`，注册即回收** | 插件卸载后监听/定时器残留 | 引擎所有注册返回 disposer；禁用插件全回收 |
| 12 | **inbox 持久投影**（无活跃 Agent 也能读） | 关掉面板再打开，排队输入丢了 | 待发送/排队消息落 `ai_event`，UI 从投影读 |
| 13 | **事件日志 generation 迁移**（已提交文件不重命名/不删除） | 升级后旧会话读不出 | 迁移只"加版本文件"，禁止原地改历史 |
| 14 | **适配器只管"协议 → 增量"**，重试/路由/裁剪在引擎 | 每家协议各写一套重试逻辑 | `AiAdapter.stream()` 只吐 `AiDelta`；超时重试统一在 runner |
| 15 | **单轮单驱动**（活跃 driver 唯一） | 并发写同一会话导致事件 seq 错乱 | 单会话并发 1 个 turn；新输入进 inbox 排队 |

> 这 15 条里，**1/2/4/5/6/7/9/10/11/15 是"必须抄"**（不抄就一定有 bug）；3/8/12/13/14 是"抄了明显更好"。

***

## 13. 参考来源

- DeepSeek Harness 官方文档（架构 / 开发 / 参考）

  - <https://deepseek-harness.github.io/deepseek-harness/reference/>

  - <https://deepseek-harness.github.io/deepseek-harness/develop/basic/>

  - <https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool>

  - <https://deepseek-harness.github.io/deepseek-harness/develop/framework/>

  - <https://deepseek-harness.github.io/deepseek-harness/develop/framework/service>

  - <https://deepseek-harness.github.io/deepseek-harness/develop/framework/events>

  - <https://deepseek-harness.github.io/deepseek-harness/develop/practice/>

  - <https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams>

  - <https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core>

  - <https://deepseek-harness.github.io/deepseek-harness/reference/tool-execution-pipeline>

  - <https://deepseek-harness.github.io/deepseek-harness/guide/providers>

- DeepSeek Harness 仓库与社区

  - <https://github.com/deepseek-ai/deepseek-harness>

  - <https://github.com/topics/dsh-plugin>

- Tabbit

  - <https://www.tabbit-ai.com/>

  - <https://www.tabbitbrowser.com/>

  - <https://m.toutiao.com/group/7614519347473613312/（功能实测：Agent> / 技能 / 智能分组 / 侧边 Chat）

  - <https://m.sohu.com/a/992208162_121675819/（产品定位与体验）>

