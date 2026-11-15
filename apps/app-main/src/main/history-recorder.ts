/**
 * 浏览历史写入策略（按窗口一份的「记录器」）。
 *
 * ── 为什么单独成模块 ─────────────────────────────────────────────
 * 历史写入曾经散落在三处：`TabManager.navigate()` 的 onNavigate（提交即写）、
 * `page-title-updated` 的标题回写、以及「新标签 / 页面内跳转」根本没人管。
 * 结果就是：
 *   · 页面还没加载完就落库 → 只有 URL、没有标题；
 *   · 新标签打开、站内跳转、搜索结果点进去 → 完全不记录；
 *   · 每处各写一份「去重 / 何时写 / 算不算重定向」的规则 → 必然漂移。
 *
 * 本模块是**唯一**的历史写入决策点（对齐 HiraRT 的 `recordBrowsingHistoryVisit`
 * 与时序：`did-finish-load` / `did-navigate-in-page(isMainFrame)` / 标签激活补记）。
 * infra 只负责报告「导航事实」（不知道历史、不认识数据库），apps 在这里决定
 * 「记不记、记什么标题、算不算 typed、要不要合并写」。
 *
 * ── 职责边界 ────────────────────────────────────────────────────
 * 输入：`onNavigationCommitted` / `onPageReady` / `onTitleUpdated` / `onActivation` /
 *       `markTypedIntent` / `forget` / `clearDedupe` / `flush` / `dispose`。
 * 输出：只调用注入的 history 服务（`addVisit` / `updateTitle`）与 favicon 服务（读缓存）。
 * 不 require electron、不碰 IPC、不持有窗口对象 —— 换一个宿主也能复用。
 *
 * ── 关键规则 ────────────────────────────────────────────────────
 * 1. 只记 `http:` / `https:`；无痕标签、内部页、错误页一律不记。
 * 2. **只记活动标签**：后台标签加载完成不写库，切到它时 `onActivation` 补记
 *    （避免「后台预加载的页面把历史刷满」）。
 * 3. 每标签按 `canonicalHistoryUrl`（shared-utils 单一真源）去重：同页刷新 / 同页重复
 *    commit 不重复计数，SPA 的 `replaceState` 抖动也不会刷屏。
 * 4. **一条导航链只记最终落地页**（见下方 `NAV_SETTLE_MS`）：重定向 / 客户端跳转 /
 *    SPA 首屏换址都会各自提交一次，提交即写库就会「跳一点记一次」。
 * 5. `typedCount` 只在地址栏手动提交时自增：`markTypedIntent` 登记意图，记录时
 *    用同一个规范化 URL 精确比对；命中后顺着重定向链顺延到**最终落地页**才消费。
 * 6. 标题写入合并 800ms 固定窗（高频改标题的站点不放大写库），窗口关闭强制 flush
 *    （flush 同时结算所有待落库的访问，绝不因为去抖丢记录）。
 * 7. 历史行被删除后清空对应去重键 —— 否则「删了历史再访问同一页」永远不会重新记录。
 */

const { canonicalHistoryUrl } = require('@hira-ng/shared-utils') as { canonicalHistoryUrl(url: string): string }
// 「算不算普通网页」的唯一判据（历史只记 http(s)，内部页 / 错误页一律不记）。
const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs') as { isHttpUrl(url: string): boolean }

interface HistoryChange {
  action?: string
  url?: string
  urls?: string[]
}

interface PendingVisit {
  key: string
  url: string
  title: string
  favicon: string
  typed: boolean
  startedAt: number
  lastActivityAt: number
  loaded: boolean
  timer: NodeJS.Timeout | null
}

interface TabHistoryState {
  url: string
  title: string
  favicon: string
  incognito: boolean
  lastKey: string
  typedPending: string | null
  pending: PendingVisit | null
}

interface HistoryServicePort {
  addVisit(input: { url: string; title: string; favicon: string | null; transition: 'typed' | 'link' }): unknown
  updateTitle(input: { url: string; title: string }): unknown
  subscribe?(listener: (change: HistoryChange) => void): () => void
}

interface FaviconServicePort {
  get(url: string): { faviconUrl?: string | null } | null | undefined
}

export interface HistoryRecorderDependencies {
  getHistoryService?(): HistoryServicePort | null | undefined
  getFaviconService?(): FaviconServicePort | null | undefined
  getProfileId?(): string
  runAsProfile?<T>(profileId: string, operation: () => T): T
  isTabActive?(tabId: string): boolean
}

interface HistoryNavigationPayload {
  tabId?: unknown
  url?: unknown
  title?: unknown
  favicon?: unknown
  inPage?: unknown
  incognito?: unknown
}

interface HistoryTitlePayload { tabId?: unknown; url?: unknown; title?: unknown }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 标题回写窗口：同 URL 的多变标题只落最后一次，固定窗保证有界新鲜度。 */
const TITLE_FLUSH_WINDOW_MS = 800

/**
 * 导航落库确认窗（重定向链去抖）。
 *
 * 一次「访问」在 Chromium 里往往是一条链：`A --302--> B --JS replace--> C`。
 * 链上每一跳都可能各自提交一次（`did-navigate` / `did-navigate-in-page`），
 * 所以「提交即写库」会把一次访问记成 2~3 条 —— 用户看到的「跳一点就记一次」。
 * 对齐 Chromium 的 `CHAIN_START|CHAIN_END` 口径：**一条链只落最终落地页**。
 *
 * 判定纯看时序（不需要事件里的 redirect 位，Electron 也不给）：
 *   · 提交后先挂起（pending），等一个安静窗；
 *   · 窗内又发生下一跳 → 上一跳是中间跳，整条丢弃；
 *   · 窗内没有下一跳 → 它就是落地页，落库。
 */
const NAV_SETTLE_MS = 1200

/** 页面已 `did-finish-load` 后的确认窗：客户端跳转（meta refresh / location.replace）通常紧随其后。 */
const LOADED_SETTLE_MS = 1500

/** 迟迟等不到 `did-finish-load` 的兜底上限：超过就照常落库，绝不让一次访问永远不落库。 */
const PENDING_MAX_MS = 6000

/**
 * 可记录地址：只有真实网页。`about:blank` / `hira://` / `chrome-extension://`
 * / 错误页（hira://error）都不进历史。
 * @param {string} urlString
 * @returns {boolean}
 */
export function isRecordableUrl(urlString: string): boolean {
  return isHttpUrl(urlString)
}

/**
 * 落库标题：真实标题优先；没有标题时回落 hostname（对齐 RT），再失败回落 URL。
 * 标题随后会被 `onTitleUpdated` 精准补全，所以这个兜底只影响「标题还没到的瞬间」。
 * @param {string} urlString
 * @param {string} title
 * @returns {string}
 */
export function displayTitleOf(urlString: string, title: unknown): string {
  const trimmed = String(title || '').trim()
  if (trimmed) return trimmed
  try {
    return new URL(String(urlString || '')).hostname || String(urlString || '')
  } catch (_) {
    return String(urlString || '')
  }
}

/**
 * @param {object} deps
 * @param {() => object|null} deps.getHistoryService 历史服务 getter（延迟解析）
 * @param {() => object|null} [deps.getFaviconService] favicon 服务 getter（读缓存兜底）
 * @param {() => string} [deps.getProfileId] 本窗口所属 profile
 * @param {(id:string, fn:()=>any) => any} [deps.runAsProfile] 进入 profile 数据作用域
 * @param {(tabId:string) => boolean} [deps.isTabActive] 该标签是否活动（缺省视为活动）
 */
export function createHistoryRecorder(deps: HistoryRecorderDependencies = {}) {
  const getHistoryService = typeof deps.getHistoryService === 'function' ? deps.getHistoryService : () => null
  const getFaviconService = typeof deps.getFaviconService === 'function' ? deps.getFaviconService : () => null
  const getProfileId = typeof deps.getProfileId === 'function' ? deps.getProfileId : () => 'default'
  const runAsProfile = typeof deps.runAsProfile === 'function'
    ? deps.runAsProfile
    : <T>(_profileId: string, operation: () => T): T => operation()
  const isTabActive = typeof deps.isTabActive === 'function' ? deps.isTabActive : () => true

  /**
   * 每标签的导航状态。
   * `pending` = 已提交、等安静窗确认的访问（重定向链去抖的核心状态）。
   * @type {Map<string, {
   *   url:string, title:string, favicon:string, incognito:boolean,
   *   lastKey:string, typedPending:string|null,
   *   pending:null|{ key:string, url:string, title:string, favicon:string, typed:boolean,
   *                   startedAt:number, lastActivityAt:number, loaded:boolean,
   *                   timer:ReturnType<typeof setTimeout>|null }
   * }>}
   */
  const tabStates: Map<string, {
  url:string, title:string, favicon:string, incognito:boolean,
  lastKey:string, typedPending:string|null,
  pending:null|{ key:string, url:string, title:string, favicon:string, typed:boolean,
                  startedAt:number, lastActivityAt:number, loaded:boolean,
                  timer:ReturnType<typeof setTimeout>|null }
}> = new Map<string, TabHistoryState>()

  /** @type {Map<string, string>} url → 待回写的最新标题 */
  const pendingTitles: Map<string, string> = new Map<string, string>()
  /** @type {ReturnType<typeof setTimeout>|null} */
  let titleFlushTimer: NodeJS.Timeout | null = null
  /** 单槽去重："改成 A 又改回 A" 这类重复直接吃掉 */
  let lastWrittenTitle = { url: '', title: '' }
  /** @type {null | (() => void)} 历史变更订阅的退订函数 */
  let unsubscribe: (() => void) | null = null
  let disposed = false

  function stateOf(tabId: string): TabHistoryState {
    const id = String(tabId || '')
    let state = tabStates.get(id)
    if (!state) {
      state = {
        url: '',
        title: '',
        favicon: '',
        incognito: false,
        lastKey: '',
        typedPending: null,
        pending: null
      }
      tabStates.set(id, state)
    }
    return state
  }

  function historyOf(): HistoryServicePort | null {
    try {
      return getHistoryService() || null
    } catch (_) {
      return null
    }
  }

  /**
   * 懒订阅历史变更：只在第一次真正记录时挂上（服务可能晚于本单元创建）。
   * 删除历史后清空去重键 —— 否则「删掉记录 → 再访问同一页」会被去重吃掉。
   */
  function ensureSubscribed(): void {
    if (unsubscribe || disposed) return
    const history = historyOf()
    if (!history || typeof history.subscribe !== 'function') return
    try {
      unsubscribe = history.subscribe((change: HistoryChange) => {
        if (!change || typeof change !== 'object') return
        switch (change.action) {
          case 'remove':
            if (change.url) clearDedupe(change.url)
            break
          case 'remove-many':
            if (Array.isArray(change.urls)) change.urls.forEach(clearDedupe)
            break
          case 'remove-before':
          case 'clear':
          case 'compact':
            clearDedupe()
            break
          default:
            break
        }
      })
    } catch (_) {
      unsubscribe = null
    }
  }

  /**
   * 清空每标签去重键。
   * @param {string} [url] 省略 = 全部清空；给了 url = 只清「该页」对应的键
   */
  function clearDedupe(url?: string): void {
    if (!url) {
      for (const state of tabStates.values()) {
        state.lastKey = ''
        dropPending(state)
      }
      return
    }
    const key = canonicalHistoryUrl(String(url))
    for (const state of tabStates.values()) {
      if (state.lastKey === key) state.lastKey = ''
      if (state.pending && state.pending.key === key) dropPending(state)
    }
  }

  /** 丢弃待落库的访问（= 它是重定向链的中间跳，不该进历史）。 */
  function dropPending(state: TabHistoryState | null | undefined): void {
    if (!state || !state.pending) return
    if (state.pending.timer) clearTimeout(state.pending.timer)
    state.pending = null
  }

  /**
   * 给待落库项续上确认计时器。
   * 已加载的页面用 `LOADED_SETTLE_MS`；仍在加载的页面不算「最终落点」，
   * 一直等到 `did-finish-load` 或 `PENDING_MAX_MS` 兜底上限。
   */
  function armPending(tabId: string, state: TabHistoryState): void {
    const pending = state.pending
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    const now = Date.now()
    const windowMs = pending.loaded ? LOADED_SETTLE_MS : NAV_SETTLE_MS
    let wait = windowMs - (now - pending.lastActivityAt)
    if (!pending.loaded && wait <= 0) {
      // 仍在加载，且确认窗已过：继续等加载完成，但受兜底上限约束。
      wait = Math.max(50, PENDING_MAX_MS - (now - pending.startedAt))
    }
    pending.timer = setTimeout(() => settlePending(tabId), Math.max(0, wait))
    if (typeof pending.timer.unref === 'function') pending.timer.unref()
  }

  /** 确认窗到点：没有新的跳转就落库，否则（仍在加载）继续等。 */
  function settlePending(tabId: string): void {
    const state = tabStates.get(String(tabId || ''))
    if (!state || !state.pending) return
    const pending = state.pending
    pending.timer = null
    if (!pending.loaded && Date.now() - pending.startedAt < PENDING_MAX_MS) {
      armPending(tabId, state)
      return
    }
    state.pending = null
    writeVisit(state, pending)
  }

  /**
   * 真正写一条访问（本模块唯一的 `history.addVisit` 出口）。
   * @param {object} state 标签状态
   * @param {{ url:string, key?:string, title?:string, favicon?:string, typed?:boolean }} entry
   */
  function writeVisit(state: TabHistoryState, entry: PendingVisit | null | undefined): void {
    if (!entry) return
    const history = historyOf()
    if (!history) return
    const typed = entry.typed === true
    if (typed) state.typedPending = null
    state.lastKey = entry.key || canonicalHistoryUrl(entry.url)

    let favicon = entry.favicon || null
    if (!favicon) {
      try {
        favicon = getFaviconService()?.get(entry.url)?.faviconUrl || null
      } catch (_) {
        favicon = null
      }
    }
    const title = displayTitleOf(entry.url, entry.title)
    try {
      runAsProfile(getProfileId(), () => history.addVisit({
        url: entry.url,
        title,
        favicon,
        transition: typed ? 'typed' : 'link'
      }))
    } catch (e) {
      console.error('[history] 记录访问失败:', errorMessage(e))
    }
  }

  /**
   * 把「当前标签状态」排进待落库队列（所有导航路径的唯一入口）。
   * @param {string} tabId
   * @param {object} state
   * @param {boolean} loaded 这次导航提交时文档是否已加载完成（页内导航恒为 true）
   */
  function scheduleVisit(tabId: string, state: TabHistoryState, loaded: boolean): void {
    if (disposed || !state) return
    const url = String(state.url || '')
    // 空页 / 非网页 / 无痕：不排队，也不留旧账。
    // 注意空 url 不清 typed 意图：地址栏刚提交、导航还没提交到这一刻，意图必须留着。
    if (!isRecordableUrl(url) || state.incognito) {
      if (url) state.typedPending = null
      dropPending(state)
      return
    }
    // 后台标签：先不排队，等用户切到它时由 onActivation 补（对齐 RT）。
    if (!isTabActive(tabId)) return

    const key = canonicalHistoryUrl(url)
    if (key === state.lastKey && state.lastKey !== '') {
      // 同一页面的重复提交（刷新 / 重复 commit）：已记过，不重复计数。
      state.typedPending = null
      dropPending(state)
      return
    }

    const pending = state.pending
    if (pending) {
      if (pending.key === key) {
        // 链上又回到同一 URL：只刷新标题 / 图标 / 加载态，不重开计时窗。
        if (state.title) pending.title = state.title
        if (state.favicon) pending.favicon = state.favicon
        if (state.typedPending !== null) pending.typed = true
        if (loaded === true) pending.loaded = true
        pending.lastActivityAt = Date.now()
        armPending(tabId, state)
        return
      }
      // 上一跳还没落库就又跳走了 —— 它是重定向链的中间跳，整条丢弃。
      dropPending(state)
    }

    ensureSubscribed()
    state.pending = {
      key,
      url,
      title: state.title,
      favicon: state.favicon,
      typed: state.typedPending !== null,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      loaded: loaded === true,
      timer: null
    }
    armPending(tabId, state)
  }

  function queueTitleWrite(url: string, title: string): void {
    if (!url || !title) return
    if (pendingTitles.get(url) === title) return
    pendingTitles.set(url, title)
    if (titleFlushTimer) return
    titleFlushTimer = setTimeout(flushTitles, TITLE_FLUSH_WINDOW_MS)
    if (typeof titleFlushTimer.unref === 'function') titleFlushTimer.unref()
  }

  /** 把合并窗里的标题落库（窗口关闭时也会强制调用）。 */
  function flushTitles(): void {
    if (titleFlushTimer) {
      clearTimeout(titleFlushTimer)
      titleFlushTimer = null
    }
    if (pendingTitles.size === 0) return
    const batch = Array.from(pendingTitles.entries())
    pendingTitles.clear()
    const history = historyOf()
    if (!history) return
    try {
      runAsProfile(getProfileId(), () => {
        for (const [url, title] of batch) {
          if (lastWrittenTitle.url === url && lastWrittenTitle.title === title) continue
          history.updateTitle({ url, title })
          lastWrittenTitle = { url, title }
        }
      })
    } catch (e) {
      console.error('[history] 标题回写失败:', errorMessage(e))
    }
  }

  /**
   * 主框架导航已提交（`did-navigate` / `did-navigate-in-page`）。
   * 两条路径都**只排队、不立刻写库**：链上任何一跳都可能是重定向中间跳，
   * 由 `scheduleVisit` 的确认窗决定最终谁落库。
   * @param {{ tabId:string, url:string, title?:string, favicon?:string, inPage?:boolean, incognito?:boolean }} payload
   */
  function onNavigationCommitted(payload: HistoryNavigationPayload | null | undefined): void {
    if (disposed || !payload) return
    const tabId = String(payload.tabId || '')
    if (!tabId) return
    const state = stateOf(tabId)
    state.incognito = payload.incognito === true
    state.url = String(payload.url || '')

    if (payload.inPage === true) {
      // 页内导航：文档没换，标题通常还是同一份，新上报就覆盖。
      if (payload.title) state.title = String(payload.title)
      if (payload.favicon) state.favicon = String(payload.favicon)
      scheduleVisit(tabId, state, true)
      return
    }

    // 跨文档导航已提交但还没加载完：标题此刻是上一页的，必须清空等页面自己报。
    state.title = String(payload.title || '')
    state.favicon = String(payload.favicon || '')
    scheduleVisit(tabId, state, false)
  }

  /**
   * 页面加载完成（`did-finish-load`）：标题已就绪，也是「这确实是落地页」的信号。
   * @param {{ tabId:string, url:string, title?:string, favicon?:string, incognito?:boolean }} payload
   */
  function onPageReady(payload: HistoryNavigationPayload | null | undefined): void {
    if (disposed || !payload) return
    const tabId = String(payload.tabId || '')
    if (!tabId) return
    const state = stateOf(tabId)
    if (payload.url) state.url = String(payload.url)
    if (payload.title) state.title = String(payload.title)
    if (payload.favicon) state.favicon = String(payload.favicon)
    if (typeof payload.incognito === 'boolean') state.incognito = payload.incognito
    scheduleVisit(tabId, state, true)
  }

  /**
   * 页面标题变化（`page-title-updated`）：更新标签状态 + 合并回写。
   * 回写只改标题（不增 visitCount），并只对「已记录过」的行生效；
   * 还没落库的那次访问直接改 pending 里的标题（落库时一次写对）。
   * @param {{ tabId:string, url:string, title:string }} payload
   */
  function onTitleUpdated(payload: HistoryTitlePayload | null | undefined): void {
    if (disposed || !payload) return
    const tabId = String(payload.tabId || '')
    const url = String(payload.url || '')
    const title = String(payload.title || '').trim()
    if (!url || !title) return
    const key = canonicalHistoryUrl(url)
    const state = tabStates.get(tabId)
    if (state) {
      if (canonicalHistoryUrl(state.url) === key) state.title = title
      if (state.pending && state.pending.key === key) state.pending.title = title
    }
    if (!isRecordableUrl(url) || (state && state.incognito)) return
    queueTitleWrite(url, title)
  }

  /**
   * 标签被激活（`onTabSwitched`）：后台加载完的页面在这里补记。
   * @param {string} tabId
   */
  function onActivation(tabId: string): void {
    if (disposed) return
    const id = String(tabId || '')
    const state = tabStates.get(id)
    if (!state) return
    scheduleVisit(id, state, true)
  }

  /**
   * 登记一次「地址栏手动提交」意图：下一次成功记录命中该 URL 时 typedCount +1。
   * 非 http(s) 地址不登记（内部页永远不进历史）。
   * @param {string} tabId
   * @param {string} url
   */
  function markTypedIntent(tabId: string, url: string): void {
    if (disposed) return
    const id = String(tabId || '')
    if (!id || !isRecordableUrl(url)) return
    const state = stateOf(id)
    // 地址栏新提交 = 上一跳作废（它不再是一条导航链的落地页）。
    dropPending(state)
    state.typedPending = canonicalHistoryUrl(url)
  }

  /** 标签关闭：先把还没落库的那次访问结算掉，再释放状态。 */
  function forget(tabId: string): void {
    const id = String(tabId || '')
    const state = tabStates.get(id)
    if (state && state.pending) {
      const pending = state.pending
      if (pending.timer) clearTimeout(pending.timer)
      state.pending = null
      writeVisit(state, pending)
    }
    tabStates.delete(id)
  }

  /** 强制结算：标题合并窗 + 所有待落库的访问（窗口关闭 / 退出前调用）。 */
  function flush(): void {
    flushTitles()
    for (const state of tabStates.values()) {
      if (!state.pending) continue
      const pending = state.pending
      if (pending.timer) clearTimeout(pending.timer)
      state.pending = null
      writeVisit(state, pending)
    }
  }

  function dispose(): void {
    if (disposed) return
    flush()
    disposed = true
    try {
      if (unsubscribe) unsubscribe()
    } catch (_) {}
    unsubscribe = null
    tabStates.clear()
    pendingTitles.clear()
  }

  return {
    onNavigationCommitted,
    onPageReady,
    onTitleUpdated,
    onActivation,
    markTypedIntent,
    forget,
    clearDedupe,
    flush,
    dispose
  }
}

