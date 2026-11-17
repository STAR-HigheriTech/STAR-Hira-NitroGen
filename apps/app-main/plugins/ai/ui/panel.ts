/**
 * AI 面板 · **装配根**（PART15 §11）。
 *
 * 它是整块面板里唯一知道"有哪几个视图"的地方，也只做四件事：
 *   1. 把 store 的**一次快照 + 增量事件**分发给各视图；
 *   2. 把视图之间的动作接起来（空态卡 → 采集 → 发送；顶栏 → 抽屉）；
 *   3. 承接宿主的 `serialize / restore`（面板 ↔ 独立窗口迁移，§11.2）；
 *   4. 销毁时逐个收口（面板关闭即销毁，见 panels/host.js）。
 *
 * 明确的**不做什么**：
 *   · 不认识 IPC（那在 store 与本目录各视图里）；
 *   · 不认识宿主形态（只读 `ctx.compact` 决定密度 class 与 `ctx.host` 交代记忆归属，
 *     不判断"我在窗口里"）；
 *   · 不做「拆出窗口」按钮 —— 那是宿主统一画的（shared/panel-transfer.js）。
 */

import { attach, h, icon, iconButton } from './dom.js'
import { chipElement } from './chips.js'
import { createAiStore } from './store.js'
import { createChat } from './chat.js'
import { createComposer } from './composer.js'
import { createSessions } from './sessions.js'
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'
import { openUrlPreferExistingTab } from '@hira-ng/ui-common/src/bookmark-open'
import type { AiClientPort, AiHost, AiUiState } from './types.js'

interface AiPanelContext {
  clients: {
    ai: AiClientPort
    tabs?: {
      list?(): Promise<unknown> | unknown
      newTab?(input: { url: string }): Promise<unknown> | unknown
      switchTab?(tabId: string | number): Promise<unknown> | unknown
    } | null
  }
  compact?: boolean
  host?: AiHost
  confirm?: (options: { title?: string; message?: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean>
  icons?: { ui(name: string, size?: number): Element | null }
  transferState?: Record<string, unknown> | null
  payload?: { state?: Record<string, unknown> | null } | null
}

export interface AiPanelInstance {
  element: HTMLElement
  serialize(): Record<string, unknown>
  restore(payload: unknown): void
  refresh(): Promise<void>
  focusSearch(): void
  ask(text: unknown): Promise<unknown>
  dispose(): void
}

/** 空态第一张卡的提示语（与 store 的默认 prompt 同一口径，避免两份措辞）。 */
const SUMMARIZE_PROMPT = '请阅读我引用的页面：先用一句话给出结论，再按主题列出 5-8 条关键要点（每条用短标签概括后补充一句解释），最后列出可执行行动、风险或待确认项，并附来源。'
/** 达到这个实际宽度后，会话历史从覆盖层升级为常驻左栏。 */
const SESSION_DOCK_MIN_WIDTH = 760

/**
 * @param {Document} doc
 * @param {any} ctx 宿主端口（见 shared/panel-context.js）
 * @returns {Promise<{ element: HTMLElement, serialize: () => any, restore: (s: any) => void, refresh: () => Promise<void>, focusSearch: () => void }>}
 */
export async function createAiPanel(doc: Document, ctx: AiPanelContext): Promise<AiPanelInstance> {
  const ai = ctx.clients?.ai
  if (!ai) throw new Error('AI 客户端不可用（ai-engine 插件未启用？）')

  const confirmFn = typeof ctx.confirm === 'function' ? ctx.confirm : null

  const element = h(doc, 'div', `ai-panel${ctx.compact ? ' is-compact' : ''}`)
  const workspace = h(doc, 'div', 'ai-workspace')
  const mainPane = h(doc, 'div', 'ai-main')
  attach(workspace, mainPane)
  element.appendChild(workspace)

  // ── store：唯一状态源 ───────────────────────────────────────────────
  const store = createAiStore({
    doc,
    ai: ai as AiClientPort,
    // 记忆归属：侧栏 / 窗口 / 内部页各自记自己的"当前会话"（见 store.js 文件头）。
    host: ctx.host,
    onIntentComplete: () => {
      // 意图没要求自动发送时，把光标交回输入区（"右键 → 加进对话"的落点）。
      composer.focus()
    }
  })

  // ── 顶栏 ────────────────────────────────────────────────────────────
  const topbar = h(doc, 'div', 'ai-topbar')

  const sessionBtn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-topbar__session'))
  sessionBtn.type = 'button'
  sessionBtn.title = '会话列表'
  // 一眼认出「这是会话列表」：列表图标徽章 + 当前会话标题 + 会话数 + 下拉箭头。
  // 只用标题 + 箭头（改版前）时，它看起来像一个普通标题，没人会去点。
  const sessionBadge = h(doc, 'span', 'ai-topbar__session-icon')
  const badgeGlyph = icon(doc, 'List', 14)
  if (badgeGlyph) sessionBadge.appendChild(badgeGlyph)
  const sessionTitle = h(doc, 'span', 'ai-topbar__title', '新会话')
  const sessionCount = h(doc, 'span', 'ai-topbar__count')
  sessionCount.hidden = true
  const sessionChevron = h(doc, 'span', 'ai-topbar__chevron')
  const chevron = icon(doc, 'ChevronDown', 12)
  if (chevron) sessionChevron.appendChild(chevron)
  attach(sessionBtn, sessionBadge, sessionTitle, sessionCount, sessionChevron)

  const newBtn = iconButton(doc, {
    iconName: 'Plus',
    label: '新建会话',
    onClick: () => { store.newSession().then(() => composer.focus()) }
  })
  const settingsBtn = iconButton(doc, {
    iconName: 'Settings',
    label: 'AI 助手设置（在新标签页打开）',
    onClick: () => openSettings()
  })

  attach(topbar, sessionBtn, newBtn, settingsBtn)
  mainPane.appendChild(topbar)

  // ── 本次上下文摘要条（PART15 §13 / Phase 3-7） ───────────────────────
  // 常驻可见：用户随时看到"这一次会把哪些材料发给模型、大概多大"。
  // 画的是**材料本身**（favicon / 缩略图 + 标题 + 类型 + 单项移除），
  // 而不是"页面 ×2"这种统计 —— 统计看不出到底引用了哪一篇。
  const contextBar = h(doc, 'div', 'ai-context-bar')
  contextBar.hidden = true
  const contextHead = h(doc, 'div', 'ai-context-bar__head')
  const contextCount = h(doc, 'span', 'ai-context-bar__count')
  const contextTokens = h(doc, 'span', 'ai-context-bar__tokens')
  const contextClear = iconButton(doc, {
    iconName: 'X',
    label: '清空本次引用',
    className: 'ai-icon-btn--tiny',
    size: 12,
    onClick: () => store.clearChips()
  })
  attach(contextHead, h(doc, 'span', 'ai-context-bar__label', '本次上下文'), contextCount, contextTokens, contextClear)
  const contextChips = h(doc, 'div', 'ai-context-bar__chips')
  attach(contextBar, contextHead, contextChips)
  mainPane.appendChild(contextBar)

  /** token 粗估的展示口径（与主进程同源，见 engine.itemTokens）。 */
  function formatTokens(n: unknown): string {
    const v = Number(n) || 0
    if (!v) return ''
    if (v < 1000) return `≈ ${v} tokens`
    return `≈ ${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k tokens`
  }

  let contextSignature = ''
  function applyContextBar(state: AiUiState): void {
    // 起草中看 chips；已发出、回合还没跑完时看那一条的 chips —— 摘要条不闪断
    const drafting = Array.isArray(state.chips) && state.chips.length > 0
    const items = drafting
      ? state.chips
      : (state.pendingUser && Array.isArray(state.pendingUser.chips) ? state.pendingUser.chips : [])
    if (!items.length) {
      if (contextSignature !== '') { contextSignature = ''; contextBar.hidden = true }
      return
    }
    let tokens = 0
    for (const item of items) tokens += Number(item && item.tokens) || 0
    const signature = `${drafting ? 'd' : 's'}|${items.length}|${tokens}|${items.map((it) => `${it.key || ''}:${it.title || ''}:${it.kind}`).join('|')}`
    if (signature === contextSignature) return
    contextSignature = signature

    contextCount.textContent = `${items.length} 项`
    contextTokens.textContent = formatTokens(tokens)
    contextTokens.hidden = !tokens
    // 清空只对"还在起草的材料"有意义：已发出去的那一条是历史，不能改
    contextClear.hidden = !drafting
    // 起草中的材料可逐项移除、可点回原页面；已发出的那一条只读（不能再改历史）
    contextChips.textContent = ''
    attach(contextChips, ...items.map((item) => chipElement(
      doc,
      item,
      drafting ? (key) => store.removeChip(key) : null,
      (url) => store.revealSource(url)
    )))
    contextBar.hidden = false
  }

  // ── 消息区 / 回底按钮 ───────────────────────────────────────────────
  const chat = createChat(doc, {
    store,
    onQuickAction: runQuickAction,
    onAtBottomChange: (atBottom) => {
      jumpBtn.classList.toggle('is-visible', !atBottom)
    }
  })
  mainPane.appendChild(chat.element)

  const jumpBtn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-jump'))
  jumpBtn.type = 'button'
  jumpBtn.title = '回到底部'
  jumpBtn.setAttribute('aria-label', '回到底部')
  const jumpGlyph = ctx.icons && typeof ctx.icons.ui === 'function' ? ctx.icons.ui('ArrowDown', 15) : null
  if (jumpGlyph) jumpBtn.appendChild(jumpGlyph)
  else jumpBtn.textContent = '↓'
  jumpBtn.addEventListener('click', () => { chat.scrollToBottom(); composer.focus() })
  mainPane.appendChild(jumpBtn)

  // ── 输入区 ──────────────────────────────────────────────────────────
  const composer = createComposer(doc, {
    store,
    onSent: () => { chat.scrollToBottom() },
    onOpenSettings: (tab) => openSettings(tab)
  })
  mainPane.appendChild(composer.element)

  // ── 会话侧栏 ────────────────────────────────────────────────────────
  // 设置不再有抽屉：它是内部页 `hira://aisettings`（侧栏 / 独立窗口 / AI 页都打开同一页）。
  const sessions = createSessions(doc, {
    store,
    confirm: confirmFn || undefined,
    onOpen: () => syncSidebarChrome(),
    onClose: () => syncSidebarChrome()
  })
  workspace.insertBefore(sessions.element, mainPane)

  let sidebarWide = false
  let sidebarWidthReady = false
  let sidebarUserCollapsed = false
  let lastTitle = ''

  function paintSessionChevron(open: boolean): void {
    sessionChevron.textContent = ''
    const glyph = icon(doc, open ? 'ChevronLeft' : 'ChevronRight', 12)
    if (glyph) sessionChevron.appendChild(glyph)
  }

  function syncSidebarChrome(): void {
    const open = sessions.isOpen()
    const docked = sessions.isDocked()
    element.classList.toggle('has-session-sidebar', docked)
    sessionBtn.classList.toggle('is-open', open)
    sessionBtn.setAttribute('aria-expanded', String(open))
    sessionBtn.setAttribute('aria-label', open ? '收起会话侧栏' : '展开会话侧栏')
    sessionBtn.title = `${lastTitle ? `${lastTitle} · ` : ''}${open ? '收起会话侧栏' : '展开会话侧栏'}`
    sessionChevron.classList.toggle('is-open', open)
    paintSessionChevron(open)
  }

  function applySidebarWidth(width: number): void {
    const wide = width >= SESSION_DOCK_MIN_WIDTH
    if (sidebarWidthReady && wide === sidebarWide) {
      syncSidebarChrome()
      return
    }
    sidebarWide = wide
    sidebarWidthReady = true
    if (wide && !sidebarUserCollapsed) sessions.open(true, false)
    else if (!wide) sessions.close()
    syncSidebarChrome()
  }

  const resizeObserver = typeof (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver === 'function'
    ? new ((doc.defaultView as Window & { ResizeObserver: typeof ResizeObserver }).ResizeObserver)((entries) => {
      const width = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : element.clientWidth
      applySidebarWidth(Number(width) || element.clientWidth || 0)
    })
    : null
  if (resizeObserver) resizeObserver.observe(element)
  const onWindowResize = () => applySidebarWidth(element.clientWidth || 0)
  if (!resizeObserver && doc.defaultView) doc.defaultView.addEventListener('resize', onWindowResize)

  /**
   * 打开 AI 设置页。
   *
   * 为什么不再在面板里开抽屉：抽屉是"面板里的模态"，独立窗口形态下生命周期与尺寸
   * 完全不同 —— 同一件事被迫实现两遍。内部页天然两种形态都能开，且能深链。
   * 深链用 `#providers`（未配模型时输入区提示的落点），面板齿轮给默认页签。
   *
   * `skills` 已移到插件页的「AI 技能」大类（技能彻底插件化），
   * 这里把「管理技能」指向 `hira://plugins#ai-skill-plugin`，不保留第二套界面。
   */
  function openSettings(tab?: string): void {
    const isSkills = tab === 'skills'
    const base = pageUrl(isSkills ? 'plugins' : 'aisettings')
    const url = isSkills ? `${base}#ai-skill-plugin` : tab ? `${base}#${tab}` : base
    const tabs = ctx && ctx.clients ? ctx.clients.tabs : null
    if (tabs && typeof tabs.list === 'function' && typeof tabs.newTab === 'function' && typeof tabs.switchTab === 'function') {
      openUrlPreferExistingTab(url, tabs as Required<typeof tabs>).catch(() => {})
      return
    }
    try { doc.defaultView && doc.defaultView.open(url, '_blank') } catch (_) {}
  }

  sessionBtn.addEventListener('click', () => {
    if (sessions.isOpen()) {
      sessions.close()
      sidebarUserCollapsed = sidebarWide
    } else {
      sidebarUserCollapsed = false
      sessions.open(sidebarWide, true)
    }
    syncSidebarChrome()
  })
  // Esc 先关浮层，再收起会话侧栏。
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    if (composer.isPopoverOpen()) { composer.closePopover(); return }
    if (sessions.isOpen() && !sessions.isRenaming) {
      sessions.close()
      if (sidebarWide) sidebarUserCollapsed = true
    }
  }
  doc.addEventListener('keydown', onKeyDown, true)

  // ── 空态卡：都落回同一条采集路径（§13 上下文） ──────────────────────
  async function runQuickAction(id: string): Promise<void> {
    if (id === 'summarize-page') {
      const item = await store.captureInto('page', undefined)
      if (!item) return
      await store.send({ text: SUMMARIZE_PROMPT })
      return
    }
    if (id === 'explain-selection') {
      const item = await store.captureInto('selection', undefined)
      if (item) composer.focus()
      return
    }
    if (id === 'screenshot') {
      const item = await store.captureInto('screenshot', undefined)
      if (item) composer.focus()
      return
    }
    // 深度研究 = 内置技能 `agent-research`：走与 `/` 菜单同一条技能路径（含自动发送），
    // 面板里不再写第二遍"插模板 + submit"。
    if (id === 'deep-research') {
      await composer.pickSkillById('agent-research')
    }
  }

  // ── 视图分发 ────────────────────────────────────────────────────────
  let lastCount = -1
  /** 独立窗口重新挂载后的阅读位置（等消息投影到位再还原）。 */
  let pendingAnchor: number | null = null

  /** 单个视图更新失败只影响它自己（面板仍要跟手，不能整帧停摆）。 */
  function safeUpdate(name: string, fn: () => void): void {
    try { fn() } catch (e) { console.error(`[ai-panel] ${name} 视图更新失败：`, e) }
  }

  function applyState(state: AiUiState): void {
    // 每个视图单独兜底：一个视图画崩了不能连带别人一起停更
    // （此前 chat 抛错会让 composer / 顶栏 / 会话列表整帧被跳过）。
    safeUpdate('chat', () => chat.update(state))
    safeUpdate('composer', () => composer.update(state))
    safeUpdate('sessions', () => sessions.update(state))
    safeUpdate('context', () => applyContextBar(state))

    const title = (state.session && state.session.title) || (state.sessionId ? '加载中…' : '新会话')
    if (title !== lastTitle) {
      lastTitle = title
      sessionTitle.textContent = title
    }

    // 会话数：徽章在 ≥2 时出现 —— 它比"会话"两个字更直接地说明这里是一份列表。
    const total = Array.isArray(state.sessions) ? state.sessions.length : 0
    if (total !== lastCount) {
      lastCount = total
      sessionCount.hidden = total < 2
      sessionCount.textContent = total < 2 ? '' : String(total)
    }
    syncSidebarChrome()

    if (pendingAnchor != null && state.ready && state.messages.length) {
      chat.restoreAnchor(pendingAnchor)
      pendingAnchor = null
    }
  }

  const unsubscribe = store.subscribe(applyState)

  // ── 迁移快照（§11.2）：只有数据，没有历史 ──────────────────────────
  function serialize() {
    const base = store.serialize()
    return {
      ...base,
      draft: composer.getValue(),
      scrollAnchor: chat.anchor()
    }
  }

  function restore(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const value = payload as Record<string, unknown>
    store.restore(value)
    if (typeof value.draft === 'string' && value.draft) composer.setValue(value.draft)
    if (typeof value.scrollAnchor === 'number') pendingAnchor = value.scrollAnchor
  }

  // 快照拉取放在装配最后：视图已经各自拿到首帧，不会白屏等地。
  //
  // 换宿主（拆窗 / 停靠）时首帧就该落在**带过来的会话**上：宿主在 mount 前把
  // 迁移快照写进 `ctx.transferState`（侧栏，取代一次即焚的暂存）或 `ctx.payload.state`
  // （独立窗口），这里直接把它当 `init` 的初始会话 —— 否则会先画本宿主上次的对话
  // 再跳一下，正是"面板切到窗口要接当前对话"里最刺眼的那一帧。
  const inherited = (ctx && (ctx.transferState || (ctx.payload && ctx.payload.state))) || null
  const inheritedSessionId = inherited && inherited.sessionId ? String(inherited.sessionId) : ''
  await store.init(inheritedSessionId ? { sessionId: inheritedSessionId } : {})
  if (doc.defaultView) doc.defaultView.setTimeout(() => applySidebarWidth(element.clientWidth || 0), 0)
  composer.focus()

  return {
    element,
    serialize,
    restore,
    refresh: () => store.refresh(),
    focusSearch: () => composer.focus(),
    /**
     * 「把这句话作为**新对话的第一条消息**问出去」—— 外部入口只有这一条。
     *
     * 内部页深链 ?ask= 每次都走这里：先由目标宿主创建新会话，再发送。
     * 失败时把原文放回输入区，用户可以直接重试，不会因为地址栏 query 被清掉而丢内容。
     */
    ask: async (text) => {
      const value = String(text == null ? '' : text).trim()
      if (!value) return { ok: false, reason: 'empty' }
      const result = await store.askNew(value)
      if (!result || result.ok === false) composer.setValue(value)
      return result
    },
    dispose() {
      unsubscribe()
      doc.removeEventListener('keydown', onKeyDown, true)
      if (resizeObserver) resizeObserver.disconnect()
      else if (doc.defaultView) doc.defaultView.removeEventListener('resize', onWindowResize)
      composer.dispose()
      sessions.dispose()
      chat.dispose()
      store.dispose()
    }
  }
}
