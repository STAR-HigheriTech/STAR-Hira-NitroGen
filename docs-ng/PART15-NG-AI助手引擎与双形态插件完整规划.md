# PART15 · NG AI 助手引擎 + 双形态面板插件 · 完整规划

生成时间：2026-10-29
状态：**纯规划，未动一行代码**。前置阅读：`PART14-DeepSeekHarness底层与Tabbit助手拆解.md`。
定位：给 NG 加一个**用户自带 API** 的 AI 助手 —— 引擎是内核（插件化、可替换），面板与窗口只是它的两块"皮"。

---

## 0. 目标与非目标

### 目标（按优先级）

1. **P0** 一个可用的浏览器 AI 助手：侧栏对话、流式输出、当前页摘要/翻译/解释、右键菜单提问、截图提问。
2. **P0** 用户自己接 API：Provider ID / Base URL / 协议 / Key / 模型目录 / 推理等级，全部结构化可编辑，密钥只写。
3. **P0** 两种形态随时切换：**侧栏面板 ↔ 独立窗口**，状态不丢、可同时看同一会话。
4. **P0** 会话持久化：事件溯源日志落到 SQLite，重启可恢复、可搜索、可导出。
5. **P1** `@` 上下文：标签页 / 当前页元素 / 选区 / 截图 / 收藏 / 历史 / 本地文件。
6. **P1** 工具调用 + 审批：开标签、读页、滚动、点击、填表、截图，全部走审批与审计。
7. **P1** 技能（Skill）：prompt / script / agent 三类，`/` 调起，可导入导出。
8. **P2** 收藏自动摘要、历史语义检索（FTS / 向量）、页面脚本型技能。
9. **P3** 多智能体、站点 MCP、外部 MCP。

### 非目标（第一版明确不做）

- 不做内置模型额度 / 代充 / 账号体系（用户自带 Key）。
- 不做云端同步、不做遥测、不上传会话。
- 不做外部浏览器自动化 provider（Playwright / CDP 外挂）——我们就在浏览器内部。
- 不做 DSH 的 Web Server / 远程部署 / 沙箱执行 / ACP。
- 不动 RT 与老 Hira。

### 一条硬边界

**AI 引擎不认识 Electron，UI 不认识数据库。**
引擎只依赖 `ai-core` 的接口；UI 只通过 IPC 契约（zod 校验）说话。任何一边想"顺手 import 对方"都是架构事故。

---

## 0.5 两层学习基线（这个方案的"谁说了算"）

| 层 | 唯一参照 | 本方案对应章节 | 约束 |
|---|---|---|---|
| **产品 / 交互层**（用户看得见） | **Tabbit** | §9 上下文交互、§12 UI、§11 双形态、§13 设置 | 入口、`@` 引用、右键菜单意图/截图/拖入、`/` 技能、引用 chip、并排阅读；**但去掉它的划词浮动条**，改用浏览器原生右键菜单 |
| **引擎 / 底层**（用户看不见） | **DeepSeek Harness** | §4 契约、§6 内核、§7 provider、§8 存储、§9.2–9.4 管道 | 事件溯源、turn/step、inbox 三原语、工具流水线 + 审批、适配器 seam、预算与裁剪、流式 settlement |
| **装配层** | **NG 自身** | §3 包、§5 槽位、§11 窗口 | manifest + SlotRegistry，不引入第二套内核 |

两条互不越界的红线：
1. **不要用 DSH 的产品观去做交互**（它服务开发者：工作区、终端、审批面板是给工程师看的）。
2. **不要用 Tabbit 的产品想象去推底层**（它会诱导你把"对话"直接塞进渲染进程、把密钥放前端、把上下文拼成一个巨型字符串）。

> 落到评审口径：UI 评审问"像不像浏览器里的助手"；引擎评审问"事件能不能重建模型输入、取消后有没有残留、上下文超限怎么办"。

---

## 1. 设计原则（全部来自 PART14 的可迁移结论）

| # | 原则 | 落地方式 |
|---|---|---|
| 1 | **内核无特权** | 引擎、provider、工具、上下文采集、Skill 全部是插件或可替换 seam |
| 2 | **唯一真源** | 会话 = 追加事件日志；UI 从投影渲染，不自己存对话 |
| 3 | **可逆副作用** | 引擎注册的流/定时器/监听，随插件禁用与 `dispose` 全部回收 |
| 4 | **三角色能力** | 每个能力拆 Definition / Provider / Consumer，Provider 与 Consumer 不互相 import |
| 5 | **turn / step 模型** | 一个 turn 多个 step；支持打断、插入、重试、审批 |
| 6 | **审批先于执行** | 工具调用先过 waterfall + 策略守卫 + 一次性审批，拒绝即不执行 |
| 7 | **声明式优先** | 面板、provider、Skill 都是 manifest 声明；不写"第二份清单" |
| 8 | **惰性 + 可销毁** | 面板不预热；窗口关闭即销毁；禁用插件即释放渲染进程 |
| 9 | **不改核心** | AI 面板不改 `panels/main.js` 的渲染代码，只通过 manifest + render 入口接入 |
| 10 | **死代码零容忍** | 不保留"以后可能用到"的空接口；每阶段结束清理未接线的槽位 |

---

## 2. 总体架构

> 读图方式：**上半部分（渲染层）按 Tabbit 的产品范式**，交互与信息架构以它为准；**下半部分（主进程 + ai-core）按 DSH 的引擎范式**，状态机、事件、审批、适配器以它为准。中间用 IPC 契约隔开。

```
┌──────────────────────────── 渲染层（panel / window / 浮层） ────────────────────────────┐
│ ui-panel-ai.renderer.js（薄壳）   ui-ai-chat（共享聊天 UI，纯 DOM）   ai-window 入口        │
│        ▲ 同一份 store / 同一份事件订阅（projection）                                     │
└────────┼──────────────────────────────────────────────────────────────────────────────┘
         │ IPC（zod 契约，单向流 + 命令）
┌────────▼──────────────────────── 主进程 ────────────────────────────────────────────────┐
│  ai-engine 插件（feature plugin）                                                        │
│   ├─ AiSessionService     会话/事件日志/投影（真源）                                     │
│   ├─ AiTurnRunner         turn/step 驱动（ai-core 纯逻辑）                               │
│   ├─ AiProviderRegistry   provider + model + credential 引用                             │
│   ├─ AiToolRegistry       浏览器工具 + 审批流水线                                        │
│   ├─ AiContextService     上下文采集总线（tab/page/selection/screenshot/…）              │
│   ├─ AiSkillService       技能加载与执行                                                 │
│   └─ AiUsageService       token / 成本统计                                               │
└────────┬──────────────────────────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────┐   ┌───────────────────────────────────────────────┐
│ ai-core（纯 TS，零 Electron 依赖） │   │ 复用现有基础设施                                │
│  ├─ 协议类型 / 事件类型 / 帧类型   │   │  infra-ipc（契约与通道）                        │
│  ├─ 事件折叠 projections          │   │  infra-db（Drizzle + better-sqlite3 + migration）│
│  ├─ turn/step 状态机              │   │  infra-secret（safeStorage 加密密钥）            │
│  ├─ provider 适配器（3 协议）      │   │  infra-window（WINDOW_TYPES / WindowFactory）    │
│  └─ token 预算 / 裁剪             │   │  infra-plugin（SlotRegistry / manifest）         │
└───────────────────────────────────┘   └───────────────────────────────────────────────┘
```

**依赖方向（单向，违反即 CONTRACT-11 事故）**

```
packages/shared-types/ai  ←  ai-core  ←  domain-ai  ←  apps/app-main（宿主接线）
                                     ↑
                        ui/ui-ai-chat（只依赖 shared-types + ui-common）
```

`ui/*` 一律不得 import `apps/app-main/src/renderer/shared/*-client.js`；面板能力只从宿主注入的 `ctx` 拿（现有规则 §4.6）。

---

## 3. 包与文件清单

### 3.1 新增包

| 包 | 语言 | 职责 | 依赖 |
|---|---|---|---|
| `packages/shared-types/src/ai/` | TS | 协议类型、事件类型、IPC 契约、错误码、常量 | zod |
| `packages/ai-core/` | TS | 事件折叠、turn/step 状态机、provider 适配器、token 预算；**零 IO / 零 Electron** | shared-types |
| `domain/domain-ai/` | TS | 会话、消息、provider、模型、Skill、用量的用例层 | ai-core、infra-db、infra-secret |
| `ui/ui-ai-chat/` | TS + CSS | 共享聊天 UI（消息流、工具卡、引用 chip、composer） | shared-types、ui-common |
| `infra/infra-ai-net/`（可选） | TS | 主进程 fetch + SSE 解析 + 超时/重试；不暴露给渲染层 | 无 |

> 原则：**包少而边界硬**。provider 适配器放 `ai-core/providers/` 一个目录，不单独发包；工具放 `ai-core/tools/` 与宿主适配各一半。

### 3.2 新增插件（声明即资产，删目录即消失）

```
apps/app-main/plugins/
  ai-engine.hira-plugin.json          # 功能插件：注册服务、槽位宿主、IPC
  ai-engine.cjs                       # 主进程装配（只做接线，不写业务）
  panel-ai.hira-plugin.json           # 面板插件：contributes.panels + render
  panel-ai.renderer.js                # 薄壳：mount 共享 UI
  ai-provider-builtin.hira-plugin.json# 内置 provider 目录（可选，数据插件）
```

`panel-ai` manifest（照 §4.1 范式，零核心改动）：

```jsonc
{
  "id": "panel-ai",
  "name": "AI 助手",
  "version": "0.1.0",
  "type": "ui-panel-plugin",
  "trustLevel": "internal",
  "description": "侧栏 AI 助手：对话 / 网页理解 / 技能 / 工具执行",
  "render": "./panel-ai.renderer.js",
  "contributes": {
    "panels": [{
      "id": "ai-panel",
      "title": "AI 助手",
      "icon": "Sparkles",
      "order": 110,
      "segment": "panel",
      "bangs": ["ai", "助手", "问AI", "总结"]
    }]
  },
  "dependsOn": ["side-panel-skeleton", "ai-engine"]
}
```

- `Sparkles` 必须已在 `ui/ui-common/src/icons.ts#ICON_REGISTRY` 登记（没有就先补一行）。
- 禁用 `panel-ai` → 面板、rail 图标、navbar 按钮、按钮编辑浮层**四处同时消失**（现有对账链路，无需新代码）。
- 禁用 `ai-engine` → 所有依赖它的面板自动 `PENDING`（现有前置依赖语义）。

### 3.3 需要触碰的现有文件（最小集）

| 文件 | 改动 | 说明 |
|---|---|---|
| `infra/infra-plugin/src/official-extension-points.js` | 新增 AI 槽位（纯数据） | 只加行，不改调度器 |
| `infra`（新增 `infra-panel-host`）+ `window-config.js` | 面板挂载契约 `PanelView`、`PanelPresentationService`、通用窗口类型 `detached-panel` | **通用双形态能力**，任何面板受益；AI 不写窗口配置 |
| `apps/app-main/src/renderer/subwindow/windows/` | 新增通用 `detached-panel.js` 入口（按 `?panelId=` 挂载任意面板） | 复用共享 subwindow 壳；**不是 AI 专用页面** |
| `infra/infra-ipc/src/contracts/` | 新增 `ai.js` | zod 契约 + 通道常量 |
| `migrations/` | 新增 AI 表迁移 | 走 `db.schema.migration` 槽位 |

**不改**：`panels/main.js` 的渲染逻辑、rail 的渲染逻辑、`plugin-registry-v2.js` 的调度语义、设置页静态分区表。`window-config.js` 只加一个**与 AI 无关**的 `detached-panel` 通用类型，禁止出现任何 `ai-*` 窗口常量。

---

## 4. Service seam 契约（先定义，后实现）

全部定义在 `packages/shared-types/src/ai/`，实现分散，**Provider 与 Consumer 互不依赖**。

### 4.1 数据词汇

```ts
export type AiRole = 'system' | 'user' | 'assistant' | 'tool'

export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; width?: number; height?: number; ref: string } // ref → 附件表
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; callId: string; name: string; args: unknown }
  | { type: 'tool-result'; callId: string; ok: boolean; content: AiContentBlock[] }
  | { type: 'citation'; kind: AiContextKind; refId: string; label: string }

export interface AiMessage { id: string; role: AiRole; blocks: AiContentBlock[]; at: number; source?: AiMessageSource }

export type AiContextKind = 'tab' | 'page' | 'selection' | 'screenshot' | 'bookmark' | 'history' | 'file' | 'note'

export interface AiContextItem {
  id: string
  kind: AiContextKind
  title: string
  subtitle?: string
  ref: unknown          // 解析器私有
  tokens?: number       // 预算计量（估算即可）
  preview?: string
}
```

### 4.2 事件（唯一真源）

```ts
export type AiSessionEvent =
  | { type: 'turn/start';  seq: number; turn: number; at: number }
  | { type: 'step/start';  seq: number; turn: number; step: number; at: number }
  | { type: 'user/message'; seq: number; message: AiMessage }
  | { type: 'assistant/message'; seq: number; message: AiMessage; stream?: AiCompactStream }
  | { type: 'assistant/attempt'; seq: number; attempt: AiAttempt }
  | { type: 'tool/call';   seq: number; callId: string; name: string; args: unknown; at: number }
  | { type: 'tool/result'; seq: number; callId: string; ok: boolean; blocks: AiContentBlock[]; at: number }
  | { type: 'context/injected'; seq: number; items: AiContextItem[] }
  | { type: 'step/end';    seq: number }
  | { type: 'turn/end';    seq: number; outcome: 'completed' | 'aborted' | 'error'; reason?: string }
  | { type: 'conv/renamed'; seq: number; title: string }
```

规则：
- **只追加、不修改、不删除**；`seq` 每个会话单调递增。
- 模型可见的每一条输入，都必须能由事件重建（"模型可见 = 已记录"）。
- 中断的 turn 必须补 `turn/end{aborted}`；未结清的工具调用必须补 `tool/result{ok:false, reason:'interrupted'}`，否则下轮请求会出现"tool_call 无 tool_result"。

### 4.3 流式帧（进程内，不落盘）

```ts
export type AiStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; delta: AiDelta }
  | { type: 'end';   attemptId: string; revision: number; outcome:
      | { kind: 'committed'; eventSeq: number }
      | { kind: 'abandoned'; reason: string } }
```

UI 只消费帧；落盘由 `assistant/message` 承担。**两条路，互不阻塞**。

### 4.4 服务接口

```ts
export interface AiProviderService {
  list(): AiProviderView[]                              // 密钥永不出现在这里
  upsert(input: AiProviderInput): Promise<AiProviderView>
  remove(id: string): Promise<void>
  probe(input: AiProbeInput): Promise<AiProbeResult>    // 探测可用模型（失败可手填）
}

export interface AiModelCatalog {
  list(providerId?: string): Promise<AiModelView[]>
  resolve(route: AiRoute): AiModelView                  // 缺失即抛，不做静默兜底
}

export interface AiSessionService {
  create(input: AiCreateSessionInput): Promise<AiSessionView>
  list(query: AiSessionQuery): Promise<AiSessionSummary[]>
  open(id: string): Promise<{ events: AiSessionEvent[]; state: AiSessionState }>
  rename(id: string, title: string): Promise<void>
  remove(id: string): Promise<void>
  export(id: string, format: 'md' | 'json'): Promise<string>
  append(id: string, events: AiSessionEvent[]): Promise<void>   // 仅内核调用
}

export interface AiTurnRunner {
  start(sessionId: string, input: AiTurnInput): Promise<AiTurnHandle>
  steer(sessionId: string, message: AiMessage): void
  inject(sessionId: string, message: AiMessage): void
  cancel(sessionId: string, cause: AiCancelCause): void
  whenIdle(sessionId: string): Promise<void>
}

export interface AiToolService {
  register(tool: AiToolDefinition): () => void          // 返回撤销函数（可逆副作用）
  list(): AiToolDescriptor[]
  invoke(callId: string, name: string, args: unknown, scope: AiToolScope): Promise<AiToolOutcome>
}

export interface AiContextService {
  collect(refs: AiContextRef[], budget: AiTokenBudget): Promise<AiContextBundle>
  snapshotTab(tabId: string, mode: 'text' | 'full'): Promise<AiPageSnapshot>
  captureSelection(tabId: string): Promise<AiContextItem | null>
  captureScreenshot(tabId: string): Promise<AiContextItem>
}

export interface AiSkillService {
  list(): AiSkillView[]
  save(skill: AiSkillInput): Promise<AiSkillView>
  resolve(trigger: string): AiSkillView | null          // `/` 调起
}

export interface AiApprovalService {
  request(req: AiApprovalRequest): Promise<AiApprovalDecision>  // 无界面/超时 → deny
}
```

---

## 5. 扩展点（新增槽位，manifest 可扩展）

在 `official-extension-points.js` 追加（沿用现有 46 个的格式：`id / mode / description / owner`）：

| 槽位 id | mode | 谁调用（宿主） | 用途 |
|---|---|---|---|
| `ai.provider.adapter` | SINGLE | ai-engine | 自定义协议适配器（内置三种之外） |
| `ai.provider.catalog` | MULTI | ai-engine | 贡献内置 provider/模型目录（数据） |
| `ai.context.provider` | MULTI | AiContextService | 贡献上下文来源（标签/书签/历史/文件…） |
| `ai.tool.provider` | MULTI | AiToolService | 贡献工具（含 schema 与风险等级） |
| `ai.system-prompt.section` | MULTI | 提示词组装 | 追加系统提示段落（插件可注入领域知识） |
| `ai.message.renderer` | SINGLE | ui-ai-chat | 覆盖某种 block 的渲染（社区换皮） |
| `ai.chat.node` | MULTI | ui-ai-chat | 新增聊天节点类型（审批卡 / diff 卡 / 结果卡） |
| `ai.skill.kind` | MULTI | AiSkillService | 新增技能类型（除 prompt/script/agent） |
| `ai.usage.observer` | EVENT | AiUsageService | 观察 token/成本 |
| `ai.turn.stopping` | EVENT | 内核 | 轮次边界扩展（自动标题、自动归档） |
| `ai.tool.pre-execute` | REDUCE | 内核流水线 | 工具前置策略（可返回 deny） |
| `settings.ai-card` | MULTI | 设置页描述符 | 设置分区卡片（若走描述符路线） |

**三条硬规则沿用现有调度器**：先声明后实现、契约校验先于实现、插件实现抛错隔离跳过。

### 5.1 右键菜单：复用现有槽位，不新增菜单系统

菜单项由 `ai-engine` 插件通过**已有槽位**贡献，不改任何宿主菜单代码：

| 宿主区域 | 复用槽位 | 菜单项示例 |
|---|---|---|
| 网页内容区（含选区/链接/图片） | `webview.context-menu.item`（也接受 `context-menu.item`） | AI 解释 / 翻译 / 总结所选 / 问 AI… / 总结此页 / 识别图片 |
| 标签栏 / 已开标签 / 垂直标签 | `tabbar.context-menu-item`、`open-tab.context-menu` | 加入 AI 上下文 / 用 AI 总结此标签 |
| 书签 / 历史 / 笔记 / 集锦 | `bookmark.context-menu`、`history.context-menu`、`note.context-menu` | 用 AI 总结 / 加入 AI 上下文 |
| 任意宿主通用 | `context-menu.item` | 「问 AI…」 |

菜单项点击统一走 **intent**（不直接发请求）：

```ts
type AiIntent =
  | 'explain-selection' | 'translate-selection' | 'summarize-selection'
  | 'ask-selection'     | 'summarize-page'       | 'explain-page'
  | 'ask-page'          | 'summarize-link'       | 'describe-image'
  | 'summarize-tab'     | 'add-tab-context'      | 'summarize-bookmark'

// 菜单 → 主进程 → ai-engine
ipc: 'ai:intent:invoke' { intent, contextRefs }
```

intent 的处理规则（引擎侧）：
- `explain / translate / summarize` → 打开（或聚焦）面板 + 附 chip + **立即发送**（用户意图明确）。
- `ask-*` / `add-*` → 打开面板 + 附 chip + 聚焦输入框，**不发送**。
- 面板未打开且 `presentation === 'window'` → 聚焦或新建 AI 窗口，行为一致。
- 所有 intent 都要求 `ai-engine` 已启用；禁用后菜单项自然消失（槽位无实现）。
- **禁止**：站点页面 DOM 注入的浮层/工具条；菜单项点击不得触发任何 write/destructive 工具。

manifest 里声明方式（与现有 `extensionPoints` 完全一致）：

```jsonc
{
  "id": "ai-provider-deepseek",
  "extensionPoints": [
    { "id": "ai.provider.catalog", "mode": "MULTI" }
  ],
  "contributes": { "aiProviderCatalog": [ /* 数据 */ ] }
}
```

### 5.2 可拆卸契约：插件关了 = 零残留

> 用户口径：**所有 AI 功能、菜单接入都必须由插件涵盖；插件一关就什么都没有，不留残留，可随时装回。**
> 这条不是"尽量"，是**验收红线**：禁用 `ai-engine` / `panel-ai` 后，运行一次"无 AI 的 NG"，任何位置都不该出现 AI 痕迹。

| # | 残留面 | 必须的做法 | 禁用后的正确表现 |
|---|---|---|---|
| 1 | 面板、rail 图标、navbar 按钮、按钮编辑浮层 | manifest `contributes.panels` + 现有对账链路 | 四处同时消失，点击历史位置无响应 |
| 2 | 网页/标签/书签/历史/笔记右键菜单 | 全部走现有 `*.context-menu` / `context-menu.item` 槽位 | 菜单里没有任何 AI 项（槽位无实现） |
| 3 | 快捷键 `Ctrl+Shift+A` 等 | `shortcut.binding` 插件贡献 | 按键无副作用，不弹任何窗口 |
| 4 | 设置分区「AI 助手」 | `settings.section-renderer` 插件贡献 | 设置里没有该分区，也不留空白页签 |
| 5 | AI 独立窗口 | 走通用 `DetachedPanelHost`（`panel:transfer`），AI 不注册窗口类型、不写窗口配置 | 无 AI 面板可分离 → 无按钮、无窗口；通用壳 `detached-panel` 属核心，不含 AI 代码 |
| 6 | IPC 通道 `ai:*` | 插件 apply 时注册 handler，返回 disposer | 渲染层调用得到"未知通道"，不挂死 |
| 7 | 网络请求 / SSE / 超时 / 重试定时器 | 全部持 `AbortController` + `ctx.effect` | 无后台连接、无定时器、无重试 |
| 8 | 渲染进程（面板宿主） | 禁用即卸载；AI 窗口 `destroy()` | 内存回落到"无 AI"基线，无隐藏 webContents |
| 9 | 内存态 | 会话投影缓存、模型目录缓存、上下文快照全部归属插件实例 | 单例销毁即释放，不挂全局变量 |
| 10 | 事件监听 / 槽位实现 / 服务实例 | 一律经 `ctx` 注册 | 卸载时逆序撤销，无悬空监听 |
| 11 | 静态代码 | 不新增"AI 专用"核心常量/分支；菜单/设置/快捷键/窗口均声明式 | 禁用后核心代码路径与无 AI 版本一致 |
| 12 | 文案与图标资源 | 随插件目录打包 | 不占用核心 i18n 词条、不占图标注册表 |
| 13 | 用户数据（会话 / 附件 / 密钥 / 技能） | **默认保留**（用户资产），不可见、不可用 | 重新启用即恢复；另提供「彻底移除」显式清理 |
| 14 | 数据库迁移 | 只加表，不 DROP | 禁用不丢数据；卸载插件也不破坏库 |

**关于第 13 条的分寸**（需你确认）：我会把"关插件"与"删数据"分开——
- **禁用插件** = 界面与运行时零残留，数据留在库里但不读不写；
- **彻底移除** = 用户显式勾选后删表、删附件目录、删 secret 条目、删 AI 设置命名空间。

理由：会话与密钥属于用户资产，静默删除是不可接受的破坏性行为；但"看起来像没装过"的产品状态由禁用保证。

**装回来的语义**：重新启用 → 面板/菜单/快捷键/设置/窗口全部原样恢复，历史会话仍在列表里，模型与 Key 仍可用（不重新配置）。

**第三方 AI 插件同规**：`ai-provider-*`、`ai-tool-*`、社区 Skill 包卸载后，其菜单项、设置卡片、工具、模型目录条目一并消失；不允许任何插件往核心写"永久注册"。

---

## 6. 引擎内核：turn / step

### 6.1 状态机

```
idle ──start──▶ running ──step*──▶ running ──无欠账──▶ idle
                  │
                  ├─ cancel(user/parent/hook/disposed) → turn/end{aborted}
                  ├─ error(step 失败) → assistant/attempt + turn/end{error}
                  └─ steer/inject 在 step 边界插入
```

### 6.2 单轮流程

```
1. 领取输入：user/message + 待注入的 context/injected
2. 组装：system prompt 段落（ai.system-prompt.section）+ 工具 schema + 历史投影
3. step:
   a. 校验 token 预算 → 超出则裁剪（旧工具结果 → 旧轮次 → 摘要）
   b. 调 provider 适配器流式请求 → 帧转发到 UI
   c. 收尾：assistant/message（含紧凑流）或 assistant/attempt
   d. 有 tool-call → 流水线（见 6.4）
   e. 工具结果回填 → 判断是否还欠一次请求
4. turn/end
```

### 6.3 三个插入原语（必须有，否则体验残缺）

| 原语 | 语义 | 用户可见效果 |
|---|---|---|
| `followup` | 排队一个完整新轮次 | 用户连续发消息 |
| `steer` | 最近一个 step 边界插入 | AI 跑到一半，用户改主意："别点了，先总结" |
| `inject` | 只进上下文、不唤醒 | 用户切标签页，页面内容自动补进上下文 |

### 6.4 工具流水线（照 PART14 §5.4 简化）

```
tool/call（先落盘，UI 出 pending 卡）
 → ai.tool.pre-execute (REDUCE)        // 插件策略，可 deny
 → 风险等级守卫（read / write / destructive）
 → AiApprovalService.request()         // 无回答 = 拒绝
 → 工具 execute()                      // 超时 / 重试 / 指标
 → 结果归一化（JSON 无损） → 内容裁剪（图片转附件引用）
 → tool/result（冻结终局）
 → 必要时追加 user/message 形式的结果摘要
```

**不可协商**：审批先于执行；页面内容里的"请点击确认"不能触发任何 write/destructive 工具。

### 6.5 引擎优化（照 PART14 §12 的 15 条，落成实现要求）

| # | 实现要求 | 验收方式（人工，不写测试脚本） |
|---|---|---|
| 1 | `AiPreparedCall` 冻结后才发请求；`inject/steer` 只影响下一次 step | 流式过程中切标签页注入内容，本轮回答不受影响，下一轮才生效 |
| 2 | 重试只重发请求，不重跑 pre-step / 不重复注入 | 连续重试 3 次，历史里没有重复的上下文消息 |
| 3 | 提示词 = 稳定前缀 + 可变尾段；稳定段（人格、工具 schema）顺序固定 | 同一会话连续提问，请求前缀字节级一致（便于上游缓存命中） |
| 4 | 流式帧与落盘分离：帧只走 IPC（16ms 合并），提交时一次性写 `assistant/message` | 生成中强杀渲染进程，重开面板内容完整；无"半截消息" |
| 5 | 打开会话只 fold 一次；之后按事件增量 patch；投影可重建 | 1000 条会话切换 ≤ 80ms |
| 6 | 压缩走 `ai.compaction` 槽位（基础实现：摘要 + `replace` 区间） | 超长会话自动摘要，摘要事件可回放，不丢原始日志 |
| 7 | 发送前 token 计量；超限先降旧工具结果保真度，再整段替换 | 触发超限时有明确提示与可预期裁剪顺序 |
| 8 | 工具结果先无损快照 → `projectContent`（图片转附件）→ `finalizeContent` | 返回 5MB JSON / 大图时内存不飙升 |
| 9 | 中断/异常补 `tool/result{ok:false, reason}` | 停止后立刻再发消息，不会出现"孤立 tool_call"报错 |
| 10 | 取消原因结构化 + `keepInbox` 选项 | 取消后排队消息按选择去留，UI 状态与实际一致 |
| 11 | 所有注册返回 disposer（流、监听、定时器、槽位实现） | 禁用 `ai-engine` 后无残留进程、无后台网络请求 |
| 12 | 待发送/排队消息落事件，重启可读 | 关闭浏览器再开，未发送草稿与排队输入仍在 |
| 13 | 迁移只加表/加列，不改历史事件 | 旧会话升级后仍可打开 |
| 14 | 适配器只做协议翻译；重试/路由/裁剪在 runner | 新增一个协议不重复实现重试逻辑 |
| 15 | 单会话并发 1 个 turn；新输入进 inbox | 连点发送不会产生两个并行 assistant 输出 |

---

## 7. Provider / 模型 / 密钥（"自己接 API"）

### 7.1 三种协议

| 协议 | 端点形态 | 流式 |
|---|---|---|
| `openai-completions` | `POST {base}/chat/completions` | SSE `data: {...}` + `[DONE]` |
| `openai-responses` | `POST {base}/responses` | SSE 事件流（`response.output_text.delta` 等） |
| `anthropic-messages` | `POST {base}/messages` | SSE `event: content_block_delta` |

适配器统一输出 `AiStreamFrame`：

```ts
export interface AiAdapter {
  readonly api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  listModels?(input: AiProbeInput): Promise<AiModelView[]>
  stream(call: AiPreparedCall, signal: AbortSignal): AsyncIterable<AiDelta>
}
```

- **一个 provider 只允许一种协议**；网关同时支持两种就建两个 provider（沿用 DSH 结论，避免请求歧义）。
- `Provider ID` 小写、不可改（改了会话与默认值全断）；显示名、baseURL、协议、模型可改。
- 超时 / 重试 / 自定义请求头按 provider 存 JSON，请求时读取，改完下一次请求生效（不重启）。

### 7.2 模型目录字段

`id / 显示名 / contextWindow / maxOutput / input: ['text','image'] / reasoning: {off,low,medium,high → api 参数值} / 兼容开关`

- `reasoning` 只声明端点真正支持的档位；至少保留一个非 off 档。
- 模型缺失时**报错并提示选模型**，不静默回落到第一个模型（DSH 的做法）。

### 7.3 密钥

- 存 `infra-secret`（Electron `safeStorage`），表里只存**引用**。
- 渲染层永远只拿到 `masked: 'sk-****abcd'`；输入框只写、不可回读，带眼睛按钮看当前输入。
- 网络请求**只在主进程**发起；渲染层通过 IPC 收流。这样 Key 不进任何网页上下文，也不受 CORS 限制。

---

## 8. 存储设计（SQLite / Drizzle）

新增迁移 `migrations/00xx_ai.sql`（沿用现有 migration 机制 + `db.schema.migration` 槽位）。

```sql
ai_provider(id TEXT PK, label TEXT, api TEXT, base_url TEXT, headers_json TEXT,
            credential_ref TEXT, enabled INT, sort INT, created_at INT, updated_at INT)

ai_model(provider_id TEXT, model_id TEXT, label TEXT, context_window INT, max_output INT,
         input_json TEXT, reasoning_json TEXT, compat_json TEXT, enabled INT,
         PRIMARY KEY(provider_id, model_id))

ai_session(id TEXT PK, title TEXT, profile_id TEXT, space_id TEXT,
           provider TEXT, model TEXT, presentation TEXT,   -- panel|window|floating
           pinned INT, archived INT, created_at INT, updated_at INT, last_seq INT)

ai_event(session_id TEXT, seq INT, type TEXT, payload_json TEXT, at INT,
         PRIMARY KEY(session_id, seq))          -- 只追加；索引 (session_id, at)

ai_attachment(id TEXT PK, session_id TEXT, kind TEXT, mime TEXT, bytes INT,
              storage_path TEXT, width INT, height INT, created_at INT)

ai_skill(id TEXT PK, kind TEXT, title TEXT, icon TEXT, color TEXT,
         body TEXT, params_json TEXT, builtin INT, enabled INT, created_at INT)

ai_usage(id TEXT PK, session_id TEXT, provider TEXT, model TEXT,
         prompt_tokens INT, completion_tokens INT, cost REAL, at INT)

ai_audit(id TEXT PK, session_id TEXT, tool TEXT, args_json TEXT, decision TEXT,
         site TEXT, at INT)                     -- 工具审计，可导出
```

补充：
- **搜索**：`ai_event` 上建 FTS5（`ai_event_fts`），标题与会话内容可搜；需要语义检索时再加向量列（P2）。
- **投影缓存**：`AiSessionState` 由事件折叠而来，打开会话时重算一次；**不单独建可写消息表**（避免第二份真源）。需要性能时只加"只读缓存 + 可重建"标记。
- **附件**：落 `userData/ai-attachments/<sessionId>/`，DB 只存路径与元数据；删除会话时一并清理（`dispose` 语义）。
- **profile / 空间**：`profile_id` / `space_id` 只做展示与过滤，不做物理隔离（沿用 §8.3 决策）。

---

## 9. 上下文系统（Tabbit 式交互 + DSH 式管道）

### 9.0 交互契约（照 Tabbit，先定死再实现）

这一节是**产品层**的定义，引擎按它取数，UI 按它出交互。七条全部要落地：

| # | 契约 | 实现落点 |
|---|---|---|
| 1 | 三个入口一套会话：rail 图标 / 全局快捷键 / 新标签页下令 | 都调用同一个 `ai:session:open`；不按入口分叉状态 |
| 2 | `@` 一等公民：连续多选、chip 可删、回答带可点回的引用标记 | `context-tray` + `@` 选择面板；引用标记点击 → 切回标签页 / 高亮选区 |
| 3 | 提问入口：**右键菜单**（选区 / 页面 / 链接 / 图片 / 标签 / 书签 / 历史 / 笔记）+ 框选截图 + 文件拖入；**不做划词浮动条** | 菜单项复用 `context-menu.item` / `webview.context-menu.item` 槽位；菜单点击 → `ai:intent:invoke`；截图复用 `ui-capture-editor`；拖入走面板 drop 区 |
| 4 | 上下文可见：默认只带标题+URL；正文需"读此页"或站点授权；面板顶部常驻上下文摘要 | `AiContextService` 默认档 + 顶部 summary bar |
| 5 | `/` 技能：列表带图标/类型，选中填模板，参数位高亮 | `AiSkillService.resolve` + composer |
| 6 | 面板与页面并排；窗口可与主窗并排；切换形态保留滚动与草稿 | §11 的 presentation 协议 + `ai_session` 草稿字段 |
| 7 | 收藏即知识：收藏时可选生成摘要，`@收藏` 引用摘要而非整页 | 收藏插件挂 `ai.summary` 服务；摘要入卡片字段 |

**明确不做的"聪明"**：不自动读取所有标签页、不自动把当前页全文塞进每次请求、不在用户不知情时发送截图。**上下文必须显式。**

### 9.1 统一条目

```ts
AiContextItem = { id, kind, title, subtitle, ref, tokens, preview }
```

所有来源经 `ai.context.provider` 槽位注册，**一个来源一个 provider**：

| provider | 采集方式 | 权限 |
|---|---|---|
| tab | `domain-tabs` 列表 / 标题 / URL | 无 |
| page | 主进程 `executeJavaScriptInIsolatedWorld` 提取 | 首次需站点授权 |
| selection | 页面选区（preload 暴露） | 同上 |
| screenshot | `webContents.capturePage()` → 附件 | 同上 |
| bookmark | `domain-bookmark` 查询 | 无 |
| history | `domain-history` 查询 | 无 |
| file | 用户拖入 / 选择，落附件 | 用户主动 |
| note | 集锦面板的卡片引用 | 无 |

### 9.2 页面快照（结构化，不是 innerText 一把梭）

```ts
interface AiPageSnapshot {
  url: string; title: string; lang?: string
  selection?: string
  headings: { level: number; text: string }[]
  text: string                 // 正文，按 readability 规则裁剪
  links: { text: string; href: string }[]   // 限 N 条
  forms?: { action: string; fields: string[] }[]
  meta?: Record<string, string>
  truncated: boolean
}
```

规则：
- 提取脚本运行在**隔离世界**，只读，不改页面；页面自身的 JS 无法篡改结果。
- 剔除 `<script>/<style>/<noscript>`、隐藏节点、`input[type=password]`、`autocomplete=cc-*`。
- 默认上限：正文 60k 字符 / 单图 ≤ 2MB（超出转截图附件或拒绝并提示）。
- 私密窗口 / 用户排除站点默认**不采集**。

### 9.3 Token 预算与裁剪

```
预算 = model.contextWindow - maxOutput - systemPromptTokens - 工具 schema tokens
优先级：用户最新消息 > 选区/当前页 > 引用的标签页 > 历史轮次 > 旧工具结果 > 附件描述
裁剪顺序：旧 tool/result 表层替换 → 旧轮次摘要 → 拒绝并提示"内容过长，请缩小引用范围"
```

### 9.4 注入形态

注入内容包在明确分隔符里，并附一行"不可信内容"声明（**防提示注入的第一道墙**）：

```
<<<UNTRUSTED PAGE CONTENT src="https://...">>>
...
<<<END UNTRUSTED>>>
```

---

## 10. 工具系统（浏览器动作）

### 10.1 工具清单（第一版）

| 工具 | 风险 | 说明 | 审批 |
|---|---|---|---|
| `tab_list` | read | 列出标签（id/标题/URL/激活态） | 否 |
| `tab_open` | write | 新标签打开 URL | 首次以后免 |
| `tab_close` / `tab_switch` | write | 关闭 / 切换 | 否（可撤销） |
| `page_read` | read | 结构化快照 | 站点首次 |
| `page_find` | read | 页内查找 | 否 |
| `page_scroll` | write | 滚动到位置 / 元素 | 否 |
| `page_click` | write | 点击元素（selector 或 ref） | **是**（每次或按站点记住） |
| `page_type` | write | 输入文本 / 选择下拉 | **是** |
| `page_screenshot` | read | 截图 | 否 |
| `bookmark_search` / `bookmark_add` | read / write | 书签 | add 需确认 |
| `history_search` | read | 历史 | 否 |
| `download_file` | write | 触发下载 | **是** |

### 10.2 工具定义

```ts
export interface AiToolDefinition {
  name: string
  description: string
  parameters: z.ZodTypeAny            // 直接进 JSON Schema
  risk: 'read' | 'write' | 'destructive'
  scope: 'tab' | 'window' | 'global'
  execute(args: unknown, ctx: AiToolScope): Promise<AiToolOutcome>
}
```

`AiToolScope` 提供：`tabId` / `windowId` / `signal` / `log()` / `captureExtras()`。**工具不碰 DB、不发 IPC**。

### 10.3 审批 UI

- 审批卡是 `ai.chat.node` 的一种节点：工具名、目标站点、参数（可折叠）、允许一次 / 本会话允许 / 本站点允许 / 拒绝。
- 无界面（未打开面板）时：默认 deny + 桌面通知；绝不"静默批准"。
- 所有决策写 `ai_audit`，用户可导出。

---

## 11. 双形态：面板 ↔ 窗口

### 11.1 三种呈现（宿主能力，不是 AI 专属）

| 形态 | 实现 | 适合 |
|---|---|---|
| `panel` | `contributes.panels` → `side-panel.panel-render-slot` | 边看边聊（默认） |
| `detached`（窗口） | **通用 `DetachedPanelHost`** + 面板挂载契约 | 长对话 / 多引用 / 双屏；任何面板都可选 |
| `floating`（P2） | 复用 overlay 体系 | 临时提问，不打断 |

**原则："面板还是窗口"是基础设施能力，插件不该各自造窗口。** AI 只是第一个使用者；下载、历史、书签、插件管理将来都能白拿。

### 11.2 通用分离宿主（DetachedPanelHost）

不写任何 AI 专用窗口配置，也不给 AI 单开一套窗口代码。组成四件（全部在 `infra`，AI 无关）：

1. **面板挂载契约**（`infra-panel-host`）
   ```ts
   interface PanelView {
     mount(el: HTMLElement, ctx: PanelViewCtx): void
     serialize?(): unknown          // 可选：迁移快照
     restore?(state: unknown): void // 可选：恢复草稿/滚动锚点
     dispose(): void
   }
   ```
   同一个面板组件既能挂进侧栏，也能挂进窗口 —— **一份实现，两种宿主**。

2. **一个通用窗口类型**：`WindowFactory` 静态注册 `detached-panel`（entry: `subwindow`，参数 `?panelId=`）。这是核心壳，不含任何 AI 代码，因此禁用 AI 后无残留。

3. **`PanelPresentationService`**（主进程）
   ```ts
   detach(panelId, state?): windowId   // 建窗或聚焦已有窗
   dock(panelId): void                 // 关窗 + 回侧栏 + 迁移状态
   isDetached(panelId): boolean
   ```
   单实例语义：同一 `panelId` 同时只允许一个宿主形态，切换即迁移，避免双写。

4. **宿主注入的切换按钮**：面板标题栏的「在窗口中打开 / 停靠回侧栏」由宿主统一渲染，插件**不实现、不重复**；`presentation: 'dock' | 'both'`（manifest 声明，默认 `dock`）决定是否显示。

**状态迁移**（通用通道，不带 `ai:` 前缀）：

```
IPC: panel:transfer { panelId, direction: 'dock'|'detach', state }
```

- `state` 由面板的 `serialize()` 给出，窗口侧 `restore()` 消费；
- AI 的 state = `{ sessionId, draft, scrollAnchor, chips }`，**只有数据，没有消息历史**（历史在主进程事件日志里）；
- 因此迁移 = 换宿主 + 换订阅，**不重新 fold、不重新请求、不重发**。

**禁用语义**：`panel-ai` 不存在 → 没有面板可分离 → 无按钮、无窗口；`detached-panel` 作为通用壳保留，但没有任何 AI 痕迹。

### 11.3 切换流程（以 AI 为例，机制是通用的）

```
IPC: ai:presentation:set { sessionId, target: 'panel' | 'detached' }
```

- 切换前：草稿、滚动锚点、未发送 chip 写入 `ai_session`（`presentation` + 草稿字段）。
- `panel → detached`：`PanelPresentationService.detach('ai-panel', state)` → 关侧栏面板 → 窗口挂载同一面板组件 → 聚焦。
- `detached → panel`：`dock('ai-panel')` → 窗口 `destroy()` → 侧栏显示同一 `sessionId`。
- **两边同时存在时**：都订阅同一 `session/event` 广播（主进程单向推送），消息、流式增量、工具卡天然同步，不做镜像状态。

### 11.4 面板窄栏约束

面板宽度通常 ≤ 380px：
- 消息区单列、工具卡折叠、引用 chip 横向滚动；
- 窗口态展开：左侧会话列表、右侧详情、底部 composer；
- 统一字号基线 12px（与现有面板一致），图标 14px；
- 深色模式跟随主题 token，不写死颜色。

### 11.5 会话列表与入口

- 面板顶部：`新建` / `历史` / `切换形态` / `设置` 四个按钮（沿 `side-panel.toolbar-action-slot` 范式）。
- 快捷键：`Ctrl+Shift+A` 打开/收起面板；`Ctrl+Shift+N` 新建会话（注册到现有 `shortcut.binding`）。
- navbar 的 panel 目录自动出现 AI 图标（无需改 navbar）。

---

## 12. UI 结构（共享 UI，单一实现）

```
ui/ui-ai-chat/
  index.ts                 # 公共导出（mountAiChat(root, port)）
  store.ts                 # 会话状态机（事件折叠的镜像，只读）
  stream.ts                # 帧缓冲 → 16ms 合并 → 逐节点 patch
  components/
    message-list.ts        # 虚拟列表
    message-item.ts        # markdown / code / 表格 / 引用
    tool-card.ts           # pending / running / done / denied
    approval-card.ts
    context-tray.ts        # 引用 chip
    composer.ts            # 输入 / /技能 / @引用 / 发送 / 停止
    model-picker.ts        # 模型 + 推理等级
    empty-state.ts
  styles/ai-chat.css
```

渲染规则：
- **Markdown 必须消毒**（`marked` + `dompurify`，或自研最小渲染器）；代码块高亮可选。
- 流式：只 append 到当前 assistant 节点，不整树重渲染；滚动跟随仅在用户未上滚时启用。
- 消息节点来自事件投影：`AssistantStreamFrame` 只更新"正在生成"的节点。
- 空态提示：`/` 技能、`@` 引用、当前页摘要三个卡片（不写长文案）。
- 失败态：协议错误（401/429/超时/上下文超限）分类文案 + 一键重试；不做无意义 toast 堆叠。

---

## 13. 设置页接入

新增分区 **「AI 助手」**（与 rail 板块同级），子页签：

| 子页 | 内容 |
|---|---|
| 模型服务 | provider 列表 / 新建（内置目录 or 自定义 API）/ 模型表 / 探测 / 推理等级 / 默认模型 |
| 助手行为 | 系统提示人格、默认上下文开关、自动注入当前页、温度与最大输出 |
| 上下文与隐私 | 站点授权列表、敏感信息剔除、私密窗口策略、附件上限、记忆开关 |
| 技能 | 列表 / 导入导出 / 内置技能开关 |
| 数据 | 会话搜索、导出（md/json）、清理、用量统计 |

- 简单字段走 `settings.section-renderer` 描述符路线；需要自绘 DOM 时走
  `settings.custom-widget`（静态设置页已通过统一运行时加载器接通，见插件指南 §15.11）。
- provider 编辑器里的 Key 字段：只写、眼睛按钮、保存后显示脱敏串。

---

## 14. 开放面（社区 Mod）

第三方能做什么，第一版就定好，避免以后改协议：

| 开放面 | 形式 | 例子 |
|---|---|---|
| 新 provider 协议 | `ai.provider.adapter` 槽位（JS 模块） | 公司内部网关 |
| 内置模型目录 | manifest `contributes.aiProviderCatalog` | 某个中转站预设 |
| 新上下文来源 | `ai.context.provider` | 阅读器高亮、笔记应用 |
| 新工具 | `ai.tool.provider` | 翻译、OCR、站点操作 |
| 新技能类型 | `ai.skill.kind` | 工作流 / 定时任务 |
| 换皮肤 | `ai.message.renderer` | 气泡样式、终端风格 |
| 新消息节点 | `ai.chat.node` | diff 卡、表格卡 |

SDK 形状（`@hira/mod-sdk` 增补类型即可，不新建 SDK 包）：

```ts
declare function defineAiTool(def: AiToolDefinition): AiToolDefinition
declare function defineContextProvider(p: AiContextProvider): AiContextProvider
```

---

## 15. 安全与隐私

| 威胁 | 对策 |
|---|---|
| Key 泄漏 | 只在主进程；`safeStorage` 加密；渲染层只见脱敏；日志不打印 header |
| 提示注入（网页内容骗 AI 点确认） | 页面内容显式包裹为不可信；write/destructive 工具**一律人工审批**；页面文字不能改变系统提示 |
| 恶意站点自动操作 | 工具 scope 绑定 tabId + 站点；跨站点导航后需重新授权 |
| 隐私 | 默认不采集私密窗口；密码框/银行卡字段剔除；站点授权可逐个撤销；零遥测 |
| 会话泄露 | 本地 SQLite；导出前提示含敏感内容；可选"仅当前空间可见"过滤 |
| 供应链 | provider 适配器是第一方代码；第三方 Mod 走现有沙箱与权限清单（`requestedPermissions`） |
| 资源滥用 | 单会话并发 1 个 turn；工具并发上限；请求超时与最大输出硬上限 |

---

## 16. 分阶段实施计划（一口气排完，不暂停）

> 每阶段结束即可用；下一阶段不推翻上一阶段的数据结构。所有新增表都在同一迁移链里，禁止"临时表后面再改"。

### Phase 0 · 契约与骨架（不接模型也能跑通 UI）

1. `packages/shared-types/src/ai/`：类型、事件、帧、错误码、IPC 契约（zod）。
2. `packages/ai-core/`：事件折叠 `foldSession()`、`AiTurnRunner` 状态机空实现、`AiTokenBudget`。
3. `official-extension-points.js` 增加 §5 的 12 个槽位（纯数据）。
4. 迁移：§8 的 8 张表。
5. `ai-engine.hira-plugin.json` + `.cjs`：注册服务占位、IPC 通道、`panel-ai` 依赖。
6. **通用双形态底座**：`infra-panel-host`（`PanelView` 挂载契约）+ `PanelPresentationService` + 通用 `detached-panel` 窗口类型；`panel-ai` 用同一 `ui-ai-chat` 空壳跑通"面板 ↔ 窗口"切换，并验证任意其他面板可复用。
7. 设置分区骨架（模型服务/助手行为/上下文/技能/数据五个空页），走 `settings.section-renderer` 插件贡献。

**验收**：面板出现 → 切换窗口 → 关窗口再切回面板，会话草稿不丢；**禁用 `ai-engine` + `panel-ai` 后按 §5.2 逐项过一遍**：面板/图标/右键菜单/快捷键/设置分区/窗口/IPC 全部消失，无后台请求与残留进程，核心代码路径与无 AI 版本一致。

### Phase 1 · Provider / 模型 / 密钥

1. `ai-core/providers/`：三种协议适配器 + SSE 解析 + 错误归一。
2. 主进程网络层：`fetch` + `AbortController` + 超时/重试；IPC 流式转发（16ms 合并）。
3. `AiProviderService` / `AiModelCatalog` 实现；设置页 provider 编辑器（含探测）。
4. 密钥落 `infra-secret`；脱敏返回。
5. 默认模型与推理等级选择器（composer 底部）。

**验收**：填一个中转站（OpenAI 兼容）→ 探测模型 → 选模型 → 发"你好"能流式返回；Key 重启后仍在且不可回读；401/429 有分类提示。

### Phase 2 · 会话引擎

1. `AiSessionService` 事件落盘 + `foldSession` 投影；会话列表/重命名/删除/导出。
2. turn/step 完整实现：`assistant/message`、`assistant/attempt`、取消、重试、`steer`、`inject`。
3. UI：消息流、Markdown 消毒、代码块、停止/重生成、错误卡、滚动策略。
4. 自动标题（`ai.turn.stopping` 事件 + 轻量总结请求）。
5. 搜索：FTS5。

**验收**：多轮对话重启恢复；AI 生成中途点停止 → `turn/end{aborted}`；再次发送不会出现孤立 tool_call。

### Phase 3 · 浏览器上下文

1. `AiContextService` + 槽位 `ai.context.provider`；tab/bookmark/history provider。
2. 页面快照提取（隔离世界）、选区、截图（附件）。
3. composer 的 `@` 引用面板 + 引用 chip + token 估算。
4. 预算裁剪与"不可信内容"包裹。
5. 站点首次授权弹窗（读页 / 发给模型）。
6. 右键菜单意图补齐：选区（解释/翻译/总结/提问）、页面（总结/解读/提问）、链接（总结链接）、图片（识别）、标签与标签组、书签、历史、笔记；**不注入页面浮动条**；已关闭标签（tab graves）作为 `@` 来源。
7. 上下文可见性：默认档只带标题+URL；面板顶部常驻"本次上下文"摘要条；回答里的引用标记可点回原标签/高亮选区。

**验收**：拖入三个标签页 + 一段选区 → 提问"对比这三篇文章的观点"→ 回答带引用 chip；超长页面被裁剪并明确提示；选中文字右键「AI 解释」，结果在侧栏流式出现且页面无任何注入 UI、不跳转。

### Phase 4 · 工具 + 审批

1. `AiToolRegistry` 与流水线（`ai.tool.pre-execute` / 审批 / 审计）。
2. §10.1 工具实现（先 read 后 write；`page_click` / `page_type` 最后接）。
3. 审批卡节点、站点记忆、无界面时 deny + 通知。
4. 审计导出。

**验收**：让 AI "打开 3 个标签页并总结"→ 自动执行（读类免审批）；"在搜索框输入并回车"→ 弹审批卡；拒绝后 AI 收到拒绝结果并能改方案。

### Phase 5 · 技能 / Skill

1. `AiSkillService` + 三类：prompt / script / agent。
2. composer `/` 调起、参数占位、图标颜色。
3. 脚本型：在页面隔离世界执行，结果回填；"保存为技能"。
4. 导入导出（`.hira-ai-skill.json`）；内置 10 个左右（总结/翻译/对比/提炼待办/生成目录…）。

**验收**：`/总结` 一键跑通；脚本技能"去掉订阅栏并生成目录"在示例站点生效且不改源页面 DOM（只在隔离世界渲染）。

### Phase 6 · 记忆与增强（可选）

1. 收藏自动摘要（写入 `ai_memory` 或集锦卡片字段）。
2. 历史语义检索（FTS 先行，向量后置）。
3. 多智能体（研究/操作/写作）——只有前 5 阶段稳定后再开。

### 贯穿所有阶段的性能红线

每个 Phase 完成时必须同时过 §17.1 预算表对应项，不允许"先做功能、性能最后再优化"：
- Phase 0–1：冷启动增量 ≤ 5ms、面板首次打开 ≤ 120ms、禁用零残留。
- Phase 2–3：首 token ≤ 400ms、流式 60fps、上滚暂停跟随、上下文预算生效。
- Phase 4：审批/工具期间 UI 不冻结，取消即时生效。
- Phase 5–6：`/`、检索、附件全部走异步 + 上限；无全表扫描。

---

## 17. 性能、开销、流畅性、跟手性、占用（五条红线）

> 口径：**AI 是"寄生"在浏览器里的功能，绝不能让人感觉浏览器变慢。** 面板关着 = 零成本；面板开着 = 只花它该花的钱。

### 17.0 五条原则

1. **零加载**：禁用 / 未打开时，AI 不占 CPU、不占内存、不建连接、不跑定时器。
2. **增量优先**：任何更新只改"变的那一个节点 / 那一行"，禁止全量重渲染、全量 fold、全量查询。
3. **主线程免疫**：渲染进程的流式与滚动不掉帧；主进程的网络解析、DB 写入不阻塞窗口事件。
4. **可取消**：所有异步都有 Abort；用户切走、关面板、点停止，资源立刻释放。
5. **有预算就降级**：超长/超大/低端机走降级路径，而不是让界面卡死。

### 17.1 预算表（验收用）

| 维度 | 指标 | 目标 |
|---|---|---|
| 冷启动 | AI 插件对启动时间的影响 | **≤ 5ms**；禁用时 0（`PENDING` 不执行 `apply`） |
| 装配 | 启用 AI 插件到"可输入"增量 | ≤ 30ms（只注册，不建连接、不读全表） |
| 面板首次打开 | 从点击到可见 | ≤ 120ms；二次打开 ≤ 40ms（复用宿主，不重建） |
| 首个 token | 从发送到首字 | ≤ 400ms（本地网络正常；含上下文采集） |
| 流式帧率 | 生成期间滚动 | 60fps，无长任务 > 16ms |
| 单帧 DOM 变更 | 每个流式 chunk | 只改 1 个文本节点；不整段重排 |
| 会话切换 | 1000 条消息 | ≤ 80ms（分页 + 一次 fold + 虚拟列表） |
| IPC | 流式转发 | ≤ 60 帧/秒，单帧 ≤ 4KB；大块走附件 |
| DB | 单次事件写入 | ≤ 2ms（批量事务 + WAL） |
| 内存 | 面板开启增量 | ≤ 60MB；窗口关闭回落 ≤ 5MB 残留 |
| 磁盘 | 会话/附件增长 | 事件压缩存；附件按需存，单图 ≤ 2MB |
| 成本 | 单次问答 token | 默认上下文 ≤ 8k；超限先裁剪不直接拒答 |

### 17.2 启动与装配期

- **能力按需加载**：provider 适配器、工具定义、Skill 解析器在"第一次用到"时 import，不在 `apply` 时全量加载。
- **迁移一次性**：AI 表迁移跟现有 migration 链，不在启动时做数据修复；需要修复的走后台空闲任务。
- **不预热**：面板宿主不预创建（现有 `ui-panel-*` 已是惰性，沿用）；AI 窗口绝不预开。
- **不读全表**：`AiSessionService.list()` 只查摘要索引（title/updated_at），不读事件。
- **槽位实现只做注册**：插件 `apply` 里不跑网络、不扫目录、不加载模型目录 JSON（首次打开设置页再读）。

### 17.3 交互与跟手性

| 场景 | 做法 |
|---|---|
| 输入框打字 | 输入、光标、IME 组合**不触发任何** token 估算/请求；`@` 面板在 80ms 空闲后再搜索 |
| 点击发送 | 立即入 inbox + 乐观渲染用户消息 + 清空输入，不等网络 |
| 流式期间滚动 | 用户上滚即**停止跟随**，出现"回到底部"按钮；不回弹、不抢占滚动 |
| 停止生成 | 点击即停（abort 立刻生效），UI 立刻退出 loading，不等服务端 |
| 切换会话 | 先渲染本地缓存的最后 N 条，再后台补齐；不出现空白等待 |
| 切换形态 | 面板 ↔ 窗口只迁移 sessionId + 草稿 + 滚动锚点，**不重新 fold、不重新请求** |
| 右键菜单 | 菜单项构建复用现有同步路径，AI 项只返回 `{label, action}`，不做 IO |
| 拖入文件 | 先出占位 chip 再读文件；大文件拒绝要即时给原因 |

### 17.4 流式渲染（最容易翻车的地方）

- **帧合并**：IPC 帧 → 渲染层缓冲 → 每 16ms（或每 2 帧）flush 一次，多个 chunk 拼成一个文本节点 patch。
- **流中不做完整 Markdown**：生成中按"纯文本 + 轻量行内标记"渲染；**流结束**才做一次完整 Markdown/代码块/表格解析。避免每个 chunk 重排整个 DOM。
- **DOM 复用**：assistant 节点在生成期间固定，只更新其文本节点；结束才替换为富文本容器。
- **代码高亮后置**：只对**可见**的代码块高亮，且用空闲时间（`requestIdleCallback`）；滚动离开即释放。
- **后台标签节流**：AI 面板不可见时降低 flush 频率（如 4 帧一次），但**不停止**接收（避免"回来发现少了内容"）。
- **超长回答**：超过 N 字符切"分段虚拟化"，只保留可视窗口内的节点。

### 17.5 IPC 与主进程开销

- **单向流通道**：流式走专用轻量 channel（不复用通用 invoke 大通道），参数为扁平结构，避免深层结构化克隆。
- **大负载不进 IPC**：截图/图片/大工具结果写附件文件，只传 `ref + 元信息`；单条消息超过 64KB 自动转附件。
- **背压**：UI 消费慢时丢"可丢帧"（仅中间 chunk 的重复空帧），但保证 `start`/`end`/`tool-call` 不丢。
- **取消传播**：渲染层取消 → 主进程 `AbortController.abort()` → 适配器断流 → 释放 socket；链路每一跳都要传 signal。
- **避免广播风暴**：会话事件只推给"打开了该会话的视图"（panel 或 window，最多两个订阅者），不做全局广播。
- **主进程不做重活**：超大 JSON 解析、超长文本 token 估算放到 `utilityProcess`（P2 可选）；第一版用采样估算（`chars/3.5`）即可，**精确用量只信 provider 返回的 usage**。

### 17.6 数据层

- **WAL + 批量事务**：流式期间不逐 chunk 落盘；一个 step 结束批量写（`assistant/message` + 若干 `tool/*`）。
- **分页**：默认一次 200 条事件；向上滚动按 `seq` 倒序取，不 `OFFSET` 大偏移（用 `seq < ?`）。
- **索引**：`(session_id, seq)` 主键即索引；`(updated_at)` 用于列表；FTS 单独虚拟表。
- **FTS 节流**：会话标题与消息正文的索引写入延迟到 turn 结束，不在流中写。
- **投影缓存**：只缓存"最近打开的 3 个会话"的状态；超出 LRU 丢弃，重开再 fold。
- **附件**：磁盘存文件，DB 存元数据；删除会话走后台清理任务，不阻塞 UI。
- **不做同步大查询**：任何 > 10ms 的查询都异步化；主进程 DB 只在必要时同步（如迁移）。

### 17.7 内存与占用

| 对象 | 策略 |
|---|---|
| 会话事件 | 只保留当前会话 + 最近 2 个；其余回库 |
| 消息 DOM | 虚拟列表，视窗外节点回收（保留高度占位） |
| 图片 | 只在进入视口时解码；缩略图与原件分离；离开视口释放 bitmap |
| 上下文快照 | 用后即弃（发送后释放），不常驻 |
| 模型目录 | 按 provider 懒加载，缓存在主进程，设上限 |
| 工具结果 | 无损快照只在流水线内短暂存在，落盘后即释放 |
| 面板宿主 | 关闭面板不销毁进程（复用），但清空消息 DOM 与缓存 |
| AI 窗口 | 关闭 `destroy()`，不 hide |
| 全局 | 禁止把会话/事件挂 `window` 或模块级单例；一切归服务实例 |

### 17.8 成本优化（token 与网络）

- **默认上下文最省**：新会话只带标题 + URL；正文按需、经授权。
- **前缀稳定**：系统提示与工具 schema 顺序固定 → 命中上游 prompt 缓存（长会话成本可降一个量级）。
- **预算先算后发**：发送前估算；超限按 §9.3 顺序裁剪，**不把整页硬塞**。
- **读页去噪**：只取正文 + 标题 + 必要链接，剔除导航/评论/广告；PDF 先转文本再截断。
- **工具结果修剪**：旧 `tool/result` 先降保真（保留首尾），再整段替换为一行摘要。
- **图片降采样**：截图按目标模型能力缩到合适边长，避免 4K 原图上传。
- **去重**：同一 URL/同一选区多次引用只算一次；上下文 chip 合并。
- **模型路由**：默认模型可配"便宜优先"，长文/复杂任务手动升档（不做自动猜测，避免不可预期成本）。
- **重试不重复计费**：重试只重发失败 step，不重发整个 turn。

### 17.9 大负载与降级

| 触发 | 降级策略 |
|---|---|
| 会话 > 5000 条事件 | 打开只 fold 最近 300 条 + 摘要头；更早按需分页 |
| 页面正文 > 60k 字符 | 截断 + 明示"已截断，可分段引用" |
| 单条工具结果 > 1MB | 转附件 + 只把摘要给模型 |
| 图片 > 2MB | 降采样/压缩；失败则拒绝并提示 |
| 主进程繁忙（DB/网络） | 流式帧降频，保证 UI 优先 |
| 低端机 / 省电模式 | 关闭流式动画、代码高亮、图片预览 |
| 网络差 | 超时更短、错误更明确、重试退避；不自动切模型烧钱 |

### 17.10 反模式清单（出现即打回）

1. 每个流式 chunk 重建整个消息列表 / 重新 Markdown 解析。
2. 每次事件到达都全量 `foldSession()`。
3. 把 base64 图片、超大工具结果塞进事件或 IPC。
4. 在渲染层做大循环 token 计数。
5. 面板打开就预加载所有会话、所有模型目录。
6. 在 `apply` 里读全表、建连接、扫目录。
7. 滚动容器与流式更新互相抢布局（未做"上滚暂停跟随"）。
8. 用 `setInterval` 轮询会话状态。
9. 全局单例缓存会话数据、监听器不注销。
10. 窗口 hide 而不 destroy，导致常驻渲染进程。
11. 每次 `@` 输入都全量搜索历史/书签（无 debounce、无索引）。
12. 同步 SQLite 大查询卡住主进程。

### 17.11 怎么验证（不写测试脚本）

- 打开 DevTools Performance：生成 2000 字回答，录制 5 秒，确认无 > 16ms 长任务、无强制同步布局。
- 任务管理器：面板开/关、窗口开/关前后对比内存与 CPU，确认回落。
- 冷启动计时：禁用 AI / 启用 AI 各启动 3 次取中位数，差值 ≤ 5ms。
- 弱网模拟：限速 + 断流，确认停止按钮即时生效、重试不重复计费。
- 长会话：5000 条事件会话打开，确认 ≤ 80ms 首屏。

---

## 18. 风险与回滚

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 三家协议差异导致适配器臃肿 | 高 | 中 | 适配器只做"协议 → AiDelta"翻译；路由与重试在引擎 |
| 页面快照质量差 | 中 | 高 | 先做结构化 + 可替换 `page.read` 实现；后续接 readability |
| 工具误操作 | 中 | 高 | 风险分级 + 审批 + 审计 + 站点记忆 |
| 流式 + 双形态状态漂移 | 中 | 中 | 状态只在事件日志；两端订阅同一广播 |
| 插件禁用残留 | 中 | 中 | 所有注册返回 disposer；禁用走现有 reconcile |
| 大仓库里再加一堆包变散 | 高 | 中 | 只加 4 个包（§3.1），不按功能碎片化 |
| 密钥/隐私事故 | 低 | 极高 | 主进程网络 + safeStorage + 零遥测 |

回滚：`ai-engine` 与 `panel-ai` 都是插件 —— 禁用即回到"没有 AI 的 NG"，数据库迁移只加表不删列，不影响现有功能。

---

## 19. 需要你拍板的点 / 需要你提供的参考

### 19.1 需要确认（不确认我就按推荐项做）

1. **Markdown 渲染**：新增 `marked` + `dompurify` 两个依赖（推荐），还是自研最小渲染器（零依赖但表格/代码块能力弱）？
2. **代码高亮**：第一版不做（推荐），还是接 `shiki`（体积大）？
3. **窗口形态**：AI 窗口要不要像插件管理那样**独立**（可与主窗并排，推荐），还是挂父窗模态？
4. **默认上下文**：新会话是否自动带上"当前页"（推荐"仅标题+URL，正文按需授权"）？
5. **流式协议**：是否允许 `openai-responses` 协议进第一版（推荐进，成本低）？
6. **端点请求**：是否允许用户自定义请求头（推荐允许，网关常需要）？

### 19.2 如果你能提供本地参考项目，最有用的是这三样

1. **DeepSeek Harness 源码本地副本**（尤其 `packages/core/agent-loop`、`packages/llm/*`、`packages/client/ui-*`、`packages/boot/*`）—— 我可以直接对着实现核对 turn/step、inbox、审批流水线的细节，而不是只看文档。
2. **Cordis 源码**（`shigma/cordis`）—— 确认 Fiber 生命周期与服务隔离的边界条件。
3. **一个你认可的"网页正文提取"实现**（Readability / Mozilla Readability / 某开源浏览器的 reader mode）—— 决定 `page.read` 的质量上限。

如果你手上有 **Nanobrowser / agent-browser** 这类"浏览器内 AI 自动化"的开源项目，也一并给我：它们的工具 schema 与审批设计可以直接对照（但只作参考，不引入其运行时）。

---

## 20. 附录 A · 目录树草案

```
packages/
  shared-types/src/ai/
    index.ts  types.ts  events.ts  frames.ts  ipc.ts  errors.ts
  ai-core/
    src/index.ts
    src/session/fold.ts        # 事件 → 状态投影
    src/session/validate.ts    # 事件顺序/完整性校验
    src/turn/runner.ts         # turn/step 状态机
    src/turn/prompt.ts         # 系统提示 + 工具 schema 组装
    src/turn/budget.ts         # token 预算与裁剪
    src/providers/registry.ts
    src/providers/openai-completions.ts
    src/providers/openai-responses.ts
    src/providers/anthropic-messages.ts
    src/providers/sse.ts
    src/tools/registry.ts      # 流水线 + 审批接口
    src/tools/definitions/*.ts # 工具（纯逻辑，宿主注入 scope）
    src/context/bus.ts
    src/context/budget.ts
    src/skills/resolve.ts
domain/domain-ai/
  src/index.ts
  src/services/provider.ts
  src/services/session.ts
  src/services/usage.ts
  src/repositories/*.ts
  src/schema.ts                # Drizzle 表定义
ui/ui-ai-chat/
  src/index.ts  src/store.ts  src/stream.ts  src/components/*  src/styles/*

apps/app-main/plugins/
  ai-engine.hira-plugin.json
  ai-engine.cjs
  panel-ai.hira-plugin.json
  panel-ai.renderer.js
apps/app-main/src/renderer/subwindow/windows/ai-assistant.js
apps/app-main/src/main/ai/host.js          # 接线：WindowFactory / WebContentsManager / 站点授权
infra/infra-ipc/src/contracts/ai.js
```

## 附录 B · 命名规范

- 事件类型：`turn/start`、`step/start`、`tool/call`（照 DSH 用小写 + 斜杠）
- 槽位：`ai.<域>.<种类>`
- IPC 通道：`ai:<域>:<动作>`（`ai:session:list`、`ai:stream:start`）
- 表：`ai_*`
- 错误码：`AI_` 前缀（`AI_AUTH_FAILED`、`AI_RATE_LIMITED`、`AI_CONTEXT_OVERFLOW`、`AI_TOOL_DENIED`）

## 附录 C · 开工前自检（每阶段都过一遍）

- [ ] 有没有产生**第二份清单**？（provider 目录、模型、面板、槽位都只能有一处声明）
- [ ] 新能力是不是定义成了 **Definition / Provider / Consumer** 三角色？有没有让 Provider 反向依赖 Consumer？
- [ ] 注册的东西有没有**撤销函数**？禁用插件后渲染进程、监听、流、定时器是否全部释放？
- [ ] 模型可见的输入是否都能**从事件重建**？
- [ ] write/destructive 工具是否**全部**经过审批与审计？
- [ ] 是否**只改声明**就接入了面板，没有动 `panels/main.js` 渲染代码？
- [ ] 面板与窗口是否共用同一份 UI 与 store，没有第二套状态？
- [ ] 有没有留下"以后可能用"的空接口 / 死代码？
- [ ] 禁用全部 AI 插件后，菜单 / 快捷键 / 设置分区 / 窗口 / IPC 是否**一个都不剩**？（§5.2）
- [ ] 有没有往核心写"永久注册"（静态窗口类型、静态设置分区、全局单例）？
- [ ] 重新启用后能否**原样恢复**（面板位置、历史会话、模型与 Key）？
