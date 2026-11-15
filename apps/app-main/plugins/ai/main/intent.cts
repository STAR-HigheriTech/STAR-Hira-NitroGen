/**
 * AI 引擎 · 意图入口（PART15 §11「所有提问入口都走右键菜单意图」）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这一层只做三件事
 * ══════════════════════════════════════════════════════════════════════
 *   1. **菜单贡献**：往官方插槽挂菜单项（`webview.context-menu.item` 与各列表菜单）。
 *   2. **意图投递**：把点击翻译成一条 `ai:intent` 事件；面板没开就先入 pending，
 *      同时把面板打开 —— 用户点了菜单却什么也没发生是最糟的反馈。
 *   3. **快捷键**：`Ctrl+Shift+E` 开关面板、`Ctrl+Shift+M` 新建会话。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条边界（别在这里长肉）
 * ══════════════════════════════════════════════════════════════════════
 *   · **不认识页面内容**：菜单只带 url/title/选中文字这类"指针"，真正的正文由引擎的
 *     `ai.context.provider` 在发送前补全（隔离世界提取，见 core/page.cjs）。
 *     右键回调必须**立刻返回**，不能在这里 await 一个页面抓取。
 *   · **不持有会话正文**：只解出 sessionId，消息内容全在 store 的事件日志里。
 *   · **不决定气泡长什么样**：`items` 是 `contextItem` 契约，渲染层照自己的样式画 chip。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 菜单项与 10 个 intent 枚举的映射（契约只认这 10 个）
 * ══════════════════════════════════════════════════════════════════════
 *   explain / translate / summarize                     → 带上下文**自动发送**
 *   ask-about-page / ask-about-selection                → 只加 chip，等用户输入
 *   add-page-to-context / add-selection-to-context /
 *   add-screenshot-to-context                           → 只加 chip，等用户输入
 *   digest-bookmarks / deep-research                    → **模板类**：没有上下文项，
 *       直接把一条技能的提示词发出去（提示词取自技能库，与 `/` 菜单同一份）。
 *
 * 「自动发送」只给"读完就能给答案"的动作。`ask-about-*` 若也自动发，
 * 发出去的是一句空话（用户原本就想自己问）。
 */

const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs')

const AI_PANEL_ID = 'ai-panel'

/** 契约里的 10 个枚举（contracts/ai.js#intentInvoke）。 */
const INTENTS = Object.freeze([
  'explain',
  'translate',
  'summarize',
  'ask-about-page',
  'ask-about-selection',
  'add-page-to-context',
  'add-selection-to-context',
  'add-screenshot-to-context',
  'digest-bookmarks',
  'deep-research'
]) as readonly string[]
const INTENT_SET = new Set<string>(INTENTS)

/** 点击后立刻发送的三个动作。 */
const AUTO_SEND = new Set<string>(['explain', 'translate', 'summarize'])

/**
 * 模板类意图 → 技能 id（提示词单一真源在技能库里，不在这里复制一份）。
 * 这类意图没有上下文项，但仍然要自动发送 —— 用户点的就是"帮我跑这个"。
 */
const TEMPLATE_SKILL: Record<string, string> = Object.freeze({
  'digest-bookmarks': 'bookmark-digest',
  'deep-research': 'agent-research'
})

/** 技能被用户删掉时的兜底话术（入口不能变成"点了没反应"）。 */
const TEMPLATE_FALLBACK: Record<string, string> = Object.freeze({
  'digest-bookmarks': '请帮我给还没有摘要的收藏补 AI 摘要（用 bookmark_list 找出 hasSummary=false 的条目，再用 bookmark_digest 处理），做完用中文汇报结果。',
  'deep-research': '请用 agent_delegate（role=research）帮我查证这件事，用中文分条给结论并注明来源。'
})

/** 自动发送时的起手话术 —— 让模型知道"要拿上下文做什么"，而不是收到一段裸文本。 */
const AUTO_PROMPT: Record<string, string> = Object.freeze({
  explain: '请解释下面这段内容（必要时给一个通俗的例子）。',
  translate: '请把下面这段内容翻译成简体中文，保留原有结构。',
  summarize: '请总结下面的内容，输出 5 条以内要点，每条一句话。'
})

/** 单条上下文项的字数上限（用户选中一大段时防止把 IPC 撑爆；正文由引擎侧再截）。 */
const SELECTION_LIMIT = 4000

interface AiLayoutPort {
  getPanelSideOf?(panelId: string): unknown
  showPanel(panelId: string): void
  hidePanel?(): void
  togglePanel?(panelId: string, opts: Record<string, unknown>): void
}

interface AiPanelPresentationPort {
  isDetached(panelId: string): boolean
  dock(panelId: string): void
}

interface KernelPort {
  emit(route: string, payload: unknown): number
  getLayout?(): AiLayoutPort | null
  panelPresentation?: AiPanelPresentationPort
}

interface SkillRow {
  id: string
  label?: string
  prompt?: string
  kind?: string
}

interface SessionRow {
  id: string
}

interface IntentStorePort {
  listSkills(): SkillRow[]
  getSession(id: string): SessionRow | null
  createSession(input: { title: string }): SessionRow
}

interface IntentUiStatePort {
  set(patch: Record<string, unknown>): unknown
}

interface IntentPayload {
  url?: unknown
  text?: unknown
  title?: unknown
  kind?: unknown
  path?: unknown
  ids?: unknown
  bookmark?: unknown
  filename?: unknown
  [key: string]: unknown
}

interface IntentItem {
  kind: string
  payload: Record<string, unknown>
  meta?: { url: string; title: string }
}

type IntentHost = 'panel' | 'window'

interface IntentMessage {
  id: string
  intent: string
  sessionId: string | null
  /** 面板族宿主：侧栏 panel / 独立 window。内部页不接收菜单意图。 */
  targetHost: IntentHost
  /** 外部入口默认新开对话；只有调用方显式给出有效 sessionId 时才续写。 */
  newSession: boolean
  items: IntentItem[]
  text: string
  autoSend: boolean
  prompt: string
  at: number
}

interface InvokeResult {
  ok: boolean
  queued: boolean
  intent: string
  reason?: string
}

interface IntentServiceDeps {
  kernel: KernelPort
  store: IntentStorePort
  skills?: { list(): { skills?: SkillRow[] } } | null
  uiState?: IntentUiStatePort | null
  isFeatureOn?(featureId: string): boolean
  logger?: { warn?(...args: unknown[]): void; info?(...args: unknown[]): void }
}

function clip(text: unknown, limit: number): string {
  const s = String(text || '')
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

/**
 * @param {{
 *   kernel: { emit: Function, getLayout?: Function },
 *   store: object,
 *   skills?: { list: Function },
 *   uiState?: object,
 *   isFeatureOn?: (featureId: string) => boolean,
 *   logger?: {warn?: Function, info?: Function}
 * }} deps
 */
function createIntentService({ kernel, store, skills: skillService = null, uiState = null, isFeatureOn, logger = console }: IntentServiceDeps) {
  /**
   * AI 入口的**唯一门禁**（`feature-map.js` 的 `ai` 功能面）。
   *
   * 为什么要在这里查，而不是靠「插件被禁用后插槽实现自动消失」：
   * 菜单实现由 `ai-engine`（引擎）挂载，落点却是 `panel-ai`（面板）。用户只关掉面板、
   * 引擎仍在跑时，实现不会被摘除 —— 菜单项会留着，点下去打开的却是一个不存在的面板。
   * 所以每次生成菜单 / 建议 / 快捷键时都现查一次功能面，运行时启停即时生效。
   *
   * 判据只有一份（`feature-map` 的 `ai`：engine + panel 都要在），这里不各自判断
   * 「panel-ai 在不在」—— 否则又会散成两套口径。
   */
  const aiUiOn = () => (typeof isFeatureOn === 'function' ? isFeatureOn('ai') : true)
  /** 技能清单的读取口：插件贡献 + 用户自建（没给服务时退回用户表）。 */
  function listSkillRows(): SkillRow[] {
    if (skillService) return skillService.list().skills || []
    return store.listSkills()
  }
  /** 面板未挂载时攒着的意图。挂载后由 `takePending()` 一次性取走。 */
  const pending: IntentMessage[] = []
  let seq = 0

  /** 面板此刻是否**已在某处可见**（侧栏槽位 或 独立窗口 —— 单实例，二者不会同时）。 */
  function isPanelOpen(): boolean {
    try {
      const presentation = kernel.panelPresentation
      if (presentation && typeof presentation.isDetached === 'function' && presentation.isDetached(AI_PANEL_ID)) {
        return true
      }
      const layout = typeof kernel.getLayout === 'function' ? kernel.getLayout() : null
      if (!layout || typeof layout.getPanelSideOf !== 'function') return false
      return Boolean(layout.getPanelSideOf(AI_PANEL_ID))
    } catch (_) {
      return false
    }
  }

  function openPanel(): boolean {
    try {
      // 已拆成窗口也算"已打开"——再开侧栏会造出第二份宿主，违反单实例语义。
      if (isPanelOpen()) return true
      const layout = typeof kernel.getLayout === 'function' ? kernel.getLayout() : null
      if (!layout) return false
      layout.showPanel(AI_PANEL_ID)
      return true
    } catch (e) {
      logger.warn && logger.warn('[ai] 打开面板失败：', e instanceof Error ? e.message : String(e))
      return false
    }
  }

  function togglePanel(): boolean {
    try {
      // 窗口形态下的「收起」= 停靠回侧栏（而不是留下一个既没面板又没窗口的空档）。
      const presentation = kernel.panelPresentation
      if (presentation && typeof presentation.isDetached === 'function' && presentation.isDetached(AI_PANEL_ID)) {
        presentation.dock(AI_PANEL_ID)
        return true
      }
      const layout = typeof kernel.getLayout === 'function' ? kernel.getLayout() : null
      if (!layout) return false
      if (typeof layout.togglePanel === 'function') {
        layout.togglePanel(AI_PANEL_ID, {})
        return true
      }
      if (layout.getPanelSideOf && layout.getPanelSideOf(AI_PANEL_ID)) {
        layout.hidePanel && layout.hidePanel()
        return true
      }
      layout.showPanel(AI_PANEL_ID)
      return true
    } catch (e) {
      logger.warn && logger.warn('[ai] 切换面板失败：', e instanceof Error ? e.message : String(e))
      return false
    }
  }

  /**
   * 菜单意图的落点只可能是**面板族**：侧栏面板或独立窗口。
   *
   * 内部页也是 AI 宿主，但它不是右键菜单的默认落点。把目标宿主写进消息，
   * 渲染侧就能过滤掉广播到其它宿主的同一份意图，避免多个 AI 页面同时切会话、
   * 同一条消息被执行多次。
   */
  function panelTargetHost(): IntentHost {
    try {
      const presentation = kernel.panelPresentation
      if (presentation && typeof presentation.isDetached === 'function' && presentation.isDetached(AI_PANEL_ID)) {
        return 'window'
      }
    } catch (_) {}
    return 'panel'
  }

  /**
   * 外部入口的会话策略：**默认新开**，绝不猜测"最近一条"。
   *
   * 旧实现会自动取 latest session，导致右键总结 / 地址栏提问都写进上一条对话，
   * 用户看到的就是"永远卡在老对话"。只有调用方显式传入且仍然存在的 sessionId
   * 才有续写语义。真正的 create 由目标渲染宿主完成，这样 ui-state 的宿主槽位
   * 与 created 广播都走 engine.createSession 的同一条路径。
   */
  function routeFor(sessionId: string | null): { sessionId: string | null; newSession: boolean; targetHost: IntentHost } {
    const given = sessionId ? String(sessionId).trim() : ''
    let existing: string | null = null
    if (given) {
      try {
        existing = store.getSession(given) ? given : null
      } catch (_) {
        existing = null
      }
    }
    return {
      sessionId: existing,
      newSession: !existing,
      targetHost: panelTargetHost()
    }
  }

  /**
   * 模板类意图的提示词：从技能库按 id 取，用户删改了技能这里也跟着变。
   * `payload.ids` 收窄到指定条目，`payload.text` 追加一条用户补充。
   */
  function templatePrompt(intent: string, payload: IntentPayload = {}): string {
    let prompt = ''
    try {
      const skillId = TEMPLATE_SKILL[intent]
      const skill = listSkillRows().find((s) => s && s.id === skillId)
      prompt = (skill && skill.prompt) || ''
    } catch (e) {
      logger.warn && logger.warn('[ai] 读取技能提示词失败：', e instanceof Error ? e.message : String(e))
    }
    if (!prompt) prompt = TEMPLATE_FALLBACK[intent] || ''

    const ids = Array.isArray(payload.ids) ? payload.ids.filter(Boolean).map(String) : []
    if (ids.length) prompt += `\n\n只处理这些收藏 id：${ids.join(', ')}`
    const extra = payload.text ? String(payload.text) : ''
    if (extra) prompt += `\n${extra}`
    return prompt
  }

  /** 把"这次点击"组装成一条可序列化的意图消息。 */
  function buildMessage(intent: string, payload: IntentPayload = {}, sessionId: string | null = null): IntentMessage {
    const id = `i_${Date.now().toString(36)}_${++seq}`
    const route = routeFor(sessionId)

    // 模板类：没有上下文项，也必须自动发送（`AUTO_SEND` 依赖 items 非空，走不到这里）。
    if (TEMPLATE_SKILL[intent]) {
      return {
        id,
        intent,
        sessionId: route.sessionId,
        targetHost: route.targetHost,
        newSession: route.newSession,
        items: [],
        text: '',
        autoSend: true,
        prompt: templatePrompt(intent, payload),
        at: Date.now()
      }
    }

    const items = []
    const text = payload.text != null ? clip(payload.text, SELECTION_LIMIT) : ''
    const url = payload.url ? String(payload.url) : ''
    const title = payload.title ? String(payload.title) : ''

    if (intent === 'add-screenshot-to-context') {
      items.push({ kind: 'screenshot', payload: { hint: 'capture-current-view' } })
    } else if (text) {
      // 选区意图：带 url/title 方便面板画 chip（"来自《标题》的一段"）
      items.push({
        kind: 'selection',
        payload: { text, url, title },
        meta: { url, title }
      })
    } else if (url) {
      items.push({ kind: 'page', payload: { url, title }, meta: { url, title } })
    } else if (payload.kind === 'file' && payload.path) {
      items.push({ kind: 'file', payload: { path: String(payload.path) } })
    }

    const autoSend = AUTO_SEND.has(intent) && items.length > 0
    return {
      id,
      intent,
      sessionId: route.sessionId,
      targetHost: route.targetHost,
      newSession: route.newSession,
      items,
      text,
      autoSend,
      // 自动发送的起手话术：渲染层直接把它当 composer 内容发出去，不必认识每种意图。
      prompt: autoSend ? AUTO_PROMPT[intent] || '' : '',
      at: Date.now()
    }
  }

  /**
   * 投递一条意图。
   * @returns {{ ok: boolean, queued: boolean, intent: string }}
   */
  function invoke({ intent, payload, sessionId }: { intent?: unknown; payload?: IntentPayload | null; sessionId?: string | null } = {}): InvokeResult {
    const name = String(intent || '')
    if (!INTENT_SET.has(name)) return { ok: false, queued: false, intent: name, reason: 'unknown-intent' }

    const message = buildMessage(name, payload || {}, sessionId || null)
    const open = isPanelOpen()

    if (open) {
      let delivered = 0
      try {
        delivered = kernel.emit(IPC_EVENTS.aiIntent, message)
      } catch (e) {
        logger.warn && logger.warn('[ai] 意图广播失败：', e instanceof Error ? e.message : String(e))
        delivered = 0
      }
      if (delivered) return { ok: true, queued: false, intent: name }
    }

    // 面板没开（或开了但没订阅成功）→ 先存起来再开面板。
    // 顺序不能反：先开面板会让渲染层在挂载时拉一次 pending，此刻还没入队就会丢。
    pending.push(message)
    // 只留最近的 20 条：右键连点不该无限攒内存。
    while (pending.length > 20) pending.shift()
    openPanel()
    return { ok: true, queued: true, intent: name }
  }

  /**
   * 面板挂载后取走**属于该宿主族**的待补发意图。
   *
   * panel / window 是同一块面板的两种呈现，可互相接手（拆窗 / 停靠时目标会变）；
   * page 永远不消费菜单意图。这样内部页先挂载也不会把面板的右键意图吃掉。
   */
  function takePending(host?: string): IntentMessage[] {
    if (!pending.length) return []
    const requested = String(host || '').trim().toLowerCase()
    if (!requested) return pending.splice(0, pending.length)
    const wantsPanelFamily = requested !== 'page'
    const taken: IntentMessage[] = []
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index]
      // 老版本热更新遗留的消息没有 targetHost；菜单意图一律按面板族处理。
      const itemPanelFamily = String(item.targetHost || '') !== 'page'
      if (itemPanelFamily !== wantsPanelFamily) continue
      taken.unshift(item)
      pending.splice(index, 1)
    }
    return taken
  }

  function dispose(): void {
    pending.length = 0
  }

  // ── 菜单贡献 ──────────────────────────────────────────────────────
  /**
   * 菜单项只造描述符 `{ label, onSelect }`：`onSelect` 在主进程内直接执行，
   * 不需要往渲染层往返（见 slot-menu.js 的契约）。**不加前导分隔符** ——
   * 宿主会自动在主模板后插一条。
   */
  function menuItem(label: string, intent: string, payload: IntentPayload, sessionId?: string | null) {
    return { label, onSelect: () => invoke({ intent, payload, sessionId }) }
  }

  /**
   * 网页右键：`webview.context-menu.item`（MULTI）。
   *
   * payload 形状由宿主钉死（main.js#getSlotMenuItems）：
   * `{ url, linkURL, srcURL, mediaType, selectionText, isEditable }`
   */
  function webviewMenu(payload: IntentPayload = {}) {
    if (!aiUiOn()) return []
    // 输入框里的右键不掺和：那里的菜单该由原生编辑命令占满。
    if (payload.isEditable) return []

    const url = payload.url ? String(payload.url) : ''
    const selection = payload.selectionText ? clip(payload.selectionText, SELECTION_LIMIT) : ''
    const media = String(payload.mediaType || 'none')
    const srcURL = payload.srcURL ? String(payload.srcURL) : ''
    const target = { url, text: selection, title: '' }

    if (selection) {
      return [
        menuItem('用 AI 解释这段内容', 'explain', target),
        menuItem('用 AI 翻译这段内容', 'translate', target),
        menuItem('用 AI 总结这段内容', 'summarize', target),
        menuItem('问 AI：关于这段文字…', 'ask-about-selection', target)
      ]
    }

    if (media === 'image' && srcURL) {
      // 图片走页面上下文：不把 base64 塞进意图（IPC 会被撑爆），由引擎侧按需抓。
      return [
        menuItem('用 AI 看这张图…', 'ask-about-page', { url: url || srcURL, title: '' })
      ]
    }

    if (payload.linkURL) {
      const linkURL = String(payload.linkURL)
      return [
        menuItem('用 AI 总结这个链接', 'summarize', { url: linkURL, title: '' }),
        menuItem('把此链接加入 AI 上下文', 'add-page-to-context', { url: linkURL, title: '' })
      ]
    }

    if (!url) return []
    return [
      menuItem('用 AI 总结此页', 'summarize', target),
      menuItem('问 AI：关于这个页面…', 'ask-about-page', target),
      menuItem('把此页加入 AI 上下文', 'add-page-to-context', target)
    ]
  }

  /**
   * 从各宿主菜单快照里解出「这一条指向哪个页面」。
   *
   * 菜单快照的形状由**各宿主**决定（历史/标签是平铺 `{url,title}`，书签栏与收藏面板
   * 习惯把书签包在 `bookmark` 里）—— 这里做一次归一，AI 菜单才不会因为"快照长得不一样"
   * 在某个宿主里凭空消失（插件不认识宿主，只认识这组字段）。
   * @param {any} payload
   * @returns {{url: string, title: string}}
   */
  function urlTargetOf(payload: IntentPayload = {}): {url: string, title: string} {
    const b = payload.bookmark && typeof payload.bookmark === 'object' ? payload.bookmark as Record<string, unknown> : null
    const url = payload.url || (b && b.url) || ''
    const title = payload.title || (b && b.title) || payload.filename || ''
    return { url: url ? String(url) : '', title: title ? String(title) : '' }
  }

  /** 标签 / 书签 / 历史 / 已开标签 / 笔记：同一套「这个 URL 能干什么」。 */
  function urlMenu(payload?: IntentPayload) {
    if (!aiUiOn()) return []
    const { url, title } = urlTargetOf(payload)
    if (!url) return []
    return [
      menuItem('用 AI 总结此页', 'summarize', { url, title }),
      menuItem('问 AI：关于这个页面…', 'ask-about-page', { url, title }),
      menuItem('把此页加入 AI 上下文', 'add-page-to-context', { url, title })
    ]
  }

  /**
   * 地址栏下拉的「询问 AI」（`search.suggestion-provider`，REDUCE）。
   *
   * 这是**建议注入**，不是菜单：只把一条 `ai-ask` 塞进队列，点击 / 回车后由宿主
   * 当普通导航打开 `hira://ai?ask=…`，AI 页面自己消费 query 并发送。
   * 宿主（下拉渲染 / 提交）只认识 `ai-ask` 这个通用行类型，不认识 AI —— 插件摘掉后
   * 这一行自然消失，地址栏一行代码都不用改。
   *
   * **位置由宿主决定**（`ui-searchbar#SUGGESTION_TIER` 把 `ai-ask` 放在"常规前往/搜索
   * 之下、搜索记录推荐之上"）。这里不玩 relevance 抢位 —— 谁的位置由谁写，插件只声明
   * "我有一行这样的建议"；`relevance` 只是宿主档内排序的兜底值。
   *
   * @param {any[]} acc 已合并的建议（流水线累加值）
   * @param {{query?: string}} _payload 与 acc 同值（本插槽没声明 initialValue）
   * @param {{query?: string, limit?: number}} [ctx] 用户输入走第三参
   * @returns {any[]}
   */
  function withAskSuggestion(acc: unknown[], _payload: {query?: string}, ctx?: {query?: string, limit?: number}) : unknown[] {
    const list = Array.isArray(acc) ? acc : []
    if (!aiUiOn()) return list
    const query = String((ctx && ctx.query) || '').trim()
    // 空输入不插（没有内容可问）；`!` 开头是 bang 快捷搜索语法，语义是"去某个站搜"。
    if (!query || query.startsWith('!')) return list
    // 幂等：同一轮被多次 reduce / 多宿主重复挂载时不重复插。
    if (list.some((item) => !!item && typeof item === 'object' && (item as { id?: unknown }).id === 'ai-ask')) return list
    return [
      ...list,
      {
        id: 'ai-ask',
        type: 'ai-ask',
        title: `询问 AI：${query}`,
        query,
        // 深链由 AI 页面自己消费（见 src/pages/ai/page.js）。
        url: `hira://ai?ask=${encodeURIComponent(query)}`,
        relevance: 500,
        source: 'ai'
      }
    ]
  }

  /**
   * 新标签页搜索框旁的「询问 AI」按钮（`newtab.search-action`，MULTI）。
   *
   * 与 `withAskSuggestion` 同一条深链（`hira://ai?ask=…`，由 AI 页面自己消费），
   * 区别只在入口形状：地址栏是"下拉里的一行"，这里是"输入框旁的一枚按钮"。
   *
   * `template` 里的 `{query}` 由宿主替换成 encodeURIComponent 后的输入 ——
   * 页面不认识 AI，只认识"这里有一个带占位符的动作"；回车那条路完全不受影响
   * （仍是搜索 / 直接导航），按钮只是**额外的**一种提交方式。
   */
  function newtabSearchActions() {
    if (!aiUiOn()) return []
    return [
      {
        id: 'ai-ask',
        label: '询问 AI',
        title: '把输入的内容发给 AI 助手（回车仍然是搜索）',
        icon: 'sparkles',
        template: 'hira://ai?ask={query}'
      }
    ]
  }

  /**
   * 主菜单贡献（`app-menu.item`，MULTI）。
   *
   * 右键菜单只能对"某个已有对象"发问；想凭空问一句的用户得先自己找到面板。
   * 于是把 AI 也挂进「工具」菜单 —— 与集锦 / 扩展 / 任务管理器同一层可发现性。
   * `where` 由 `plugin-surfaces#menuItems` 二次过滤，本实现只管给出候选。
   */
  function appMenuItems() {
    if (!aiUiOn()) return []
    return [
      { where: 'app.tools', label: 'AI 助手', order: 10, onSelect: () => togglePanel() },
      { where: 'app.tools', label: '新建 AI 会话', order: 11, onSelect: () => newSession() }
    ]
  }

  /**
   * 快捷键（`shortcut.binding`，MULTI）。
   *
   * ⚠ 必须**同步**返回：宿主在原生 keydown 回调栈里现问一次，异步项会被直接跳过。
   * `Ctrl+Shift+A/N` 已被标签搜索/新窗口占用，这里取 E（engine）/ M（message）。
   */
  function shortcutBinding(combo: unknown) {
    if (!aiUiOn()) return null
    const key = String(combo || '').toLowerCase().replace(/\s+/g, '')
    if (key === 'ctrl+shift+e') return { run: () => togglePanel() }
    if (key === 'ctrl+shift+m') return { run: () => newSession() }
    return null
  }

  /** 新建会话并让**当前面板宿主**（侧栏或独立窗口）切过去。 */
  function newSession(): SessionRow | null {
    try {
      const host = panelTargetHost()
      const session = store.createSession({ title: '' })
      try { uiState && uiState.set({ host, sessionId: session.id }) } catch (_) {}
      try {
        kernel.emit(IPC_EVENTS.aiStateChanged, { sessionId: session.id, reason: 'created', host })
      } catch (_) {}
      openPanel()
      return session
    } catch (e) {
      logger.warn && logger.warn('[ai] 新建会话失败：', e instanceof Error ? e.message : String(e))
      return null
    }
  }

  /**
   * 给 `ai-engine.cjs` 的 `extensionPoints()` 用。
   * 官方插槽表已经声明了这些 id（`official-extension-points.js`），这里只挂实现。
   */
  function extensions() {
    return [
      { to: 'webview.context-menu.item', impl: (payload: IntentPayload) => webviewMenu(payload) },
      { to: 'tabbar.context-menu-item', impl: (payload: IntentPayload) => urlMenu(payload) },
      { to: 'bookmark.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      { to: 'history.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      { to: 'open-tab.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      // 笔记卡片：只有带 url 的来源卡片才出现这三项。
      { to: 'note.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      // 画板 / 归档 / 媒体 / 会话：同样都是"某一条有 URL"的宿主，
      // 一律复用 urlMenu —— 新增宿主不必再写一份 AI 菜单（菜单项文案只有这一处）。
      //
      // ⚠ 下载面板**不挂** AI 项（用户明确要求）：下载列表的右键是文件操作面
      // （暂停 / 打开 / 定位 / 删除），再塞三条「用 AI 总结此页」既不对题也挤掉了
      // 真正要用的动作。宿主侧 `MENU_SLOT_BY_KIND` 仍保留 download 映射（其它插件
      // 可以按需贡献），这里只是 AI 插件自己不再参与。
      { to: 'easel.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      { to: 'archive.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      { to: 'media.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      { to: 'session.context-menu', impl: (payload: IntentPayload) => urlMenu(payload) },
      // 地址栏下拉第一行的「询问 AI」（建议注入，宿主只当普通导航提交）。
      { to: 'search.suggestion-provider', impl: withAskSuggestion },
      // 新标签页搜索框旁的「询问 AI」按钮（输入框旁的动作，不改变回车语义）。
      { to: 'newtab.search-action', impl: () => newtabSearchActions() },
      // 「工具」菜单里的常驻入口（凭空发问时不必先找面板）。
      { to: 'app-menu.item', impl: () => appMenuItems() },
      { to: 'shortcut.binding', impl: (combo: unknown) => shortcutBinding(combo) }
    ]
  }

  return {
    invoke,
    takePending,
    pendingCount: () => pending.length,
    isPanelOpen,
    openPanel,
    togglePanel,
    newSession,
    extensions,
    dispose
  }
}

module.exports = { createIntentService, AI_PANEL_ID, INTENTS, AUTO_SEND }
