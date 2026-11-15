/**
 * tabLifecycle —— 标签生命周期（对齐 RT `TabLifecycleManager`）。
 *
 * 职责：休眠 / 唤醒 / 批量休眠 / 激活打点 / **归档**。
 * 两条「回收腿」（对齐 RT）：
 *   · 休眠（可逆）：销毁 webContents 释放内存，保留标签记录，切回自动唤醒；
 *   · 归档（删除）：等价于用户关掉标签 —— 记录与视图一起消失，只在标签栏里腾位。
 * 二者共用同一套候选豁免（domain-tabs#sleepCandidates），只有回收强度不同。
 *
 * 与 TabManager 的关系：本模块是「无状态算法」，全部副作用通过 host 契约回调执行，
 * 因此可脱离 Electron 单测，也避免与 TabManager 双向耦合。
 *
 * host 契约（由 TabManager 提供）：
 *   - _tabs: Map<tabId, TabRecord>
 *   - _wcm:  WebContentsManager（isTabSleeping / getTab / createTab / sleepTab / destroyTab）
 *   - _layout: LayoutCoordinator（getActiveTabId / isTabVisible / forgetView / resetTabBounds）
 *   - _boundTabIds: Set<tabId>
 *   - _wcToTabId: Map<webContents, tabId>
 *   - _tabRules: 领域规则端口（sleepCandidates）
 *   - _ruleInput(): 构造规则输入
 *   - _notifyTabWillHide(id): 销毁 webContents 前广播「即将隐藏」（供采帧）
 *   - _bindTabEvents(tabId): 重建事件接线
 *   - _scheduleEmitChanged(): 合并派发 tab:changed
 *   - close(id, { skipUndoStack }): 关闭标签（归档复用该路径，但不写撤销栈）
 *
 * 休眠 = 抓 PreSleepState 快照 → 摘除视图 → 销毁 webContents（保留 _tabOptions）。
 * 唤醒 = 重建视图 → 重新绑定事件 → 用快照还原导航历史（失败才回退 loadURL）。
 * 归档 = 直接走 close 删除标签（不写撤销栈，故 Ctrl+Shift+T 不会吐出归档项）。
 */

const {
  capturePreSleepState,
  restoreNavigationHistory
} = require('./tabPreSleep')
const { isWebErrorUrl, failedUrlOfErrorPage } = require('@hira-ng/shared-types/src/web-error')

import type { NavigationEntry, WebContents, WebContentsView } from 'electron'
import type { PreSleepState } from './tabPreSleep'

interface LifecycleTabRecord {
  url: string
  title?: string
  favicon?: string
  spaceId?: string
  pinned?: boolean
  sleeping?: boolean
  muted?: boolean
  audioPlaying?: boolean
  loading?: boolean
  lastActivated?: number
  preSleep?: PreSleepState | null
  error?: { url?: string } | null
  [key: string]: unknown
}

interface TabView { webContents: WebContents }
interface TabLayoutPort {
  isTabVisible?(id: string): boolean
  getActiveTabId(): string | null
  forgetView?(view: TabView): void
  resetTabBounds?(): void
  showTab?(id: string): void
}
interface TabWebContentsPort {
  getTab(id: string): TabView | null | undefined
  isTabSleeping(id: string): boolean
  sleepTab(id: string): void
  createTab(id: string): WebContentsView
}
interface TabRulesPort {
  sleepCandidates(input: unknown, options: { activeTabId: string | null; now: number; inactiveThresholdMs: number; excludePinned: boolean }): string[]
}
export interface TabLifecycleHost {
  _layout: TabLayoutPort
  _wcm: TabWebContentsPort
  _tabs: Map<string, LifecycleTabRecord>
  _boundTabIds: Set<string>
  _wcToTabId: Map<WebContents, string>
  _tabRules: TabRulesPort
  _ruleInput(): Array<Record<string, unknown> & { sleeping?: boolean }>
  _notifyTabWillHide?(id: string): void
  _bindTabEvents(id: string): void
  _scheduleEmitChanged(): void
  _withEmitBatch(callback: () => void): void
  _hooks: { onTabArchived?(entry: { tabId: string; url: string; title?: string; favicon?: string; spaceId?: string }): void }
  close(id: string, options: { skipUndoStack: boolean }): { closed: boolean; reason?: string } | null | undefined
}

/**
 * 该标签此刻是否**正显示在屏幕上**（自动回收的第一道豁免）。
 *
 * 为什么不能只看 `getActiveTabId()`：活动标签只是"可见集合里的一员"。分屏 / 速览下
 * 非活动的那一格同样在渲染 —— 休眠/归档它会**销毁正在显示的 view**，屏幕上就留下
 * 一块点不动、关不掉的空白格（用户报的"幽灵标签"，横竖两种标签条都中招）。
 * 判据归布局层所有（`LayoutCoordinator#isTabVisible`），本模块只问不判。
 *
 * @param {object} host
 * @param {string} id
 * @returns {boolean}
 */
function isOnScreen(host: TabLifecycleHost, id: string): boolean {
  const layout = host && host._layout
  if (layout && typeof layout.isTabVisible === 'function') {
    try { return layout.isTabVisible(id) } catch (_) { /* 布局异常 → 退回活动判定 */ }
  }
  return String((layout && layout.getActiveTabId && layout.getActiveTabId()) || '') === String(id)
}

/**
 * 把错误页从休眠快照里抹掉，只保留**失败的原网址**。
 *
 * 错误页是过渡视图，不是用户要停留的页面。若原样快照：
 *   · `snap.url` 会变成 `hira://error?...` → 唤醒后地址栏显示错误页地址，且直接重载错误页；
 *   · `navHistory` 里那条错误页条目同样会被还原，前进/后退会退回错误页。
 * 因此快照只记原网址：URL 换成失败地址，历史条目剔除错误页并按剔除位置钳制活动索引。
 *
 * @param {{url: string, navHistory: any[], navHistoryIndex: number}} snap
 * @param {object} t tab 记录（`t.error.url` 是宿主记录的权威失败地址）
 * @returns {string} 快照最终应采用的 URL
 */
function stripErrorPageFromSnapshot(snap: PreSleepState, t: LifecycleTabRecord): string {
  const entries = Array.isArray(snap.navHistory) ? snap.navHistory : []
  const hasErrorEntry = entries.some((e) => e && isWebErrorUrl(e.url))
  if (!isWebErrorUrl(snap.url) && !hasErrorEntry) return snap.url
  const failed = failedUrlOfErrorPage(snap.url) || String((t && t.error && t.error.url) || '')
  if (isWebErrorUrl(snap.url)) snap.url = failed
  if (hasErrorEntry) {
    const active = Number(snap.navHistoryIndex) || 0
    const kept: NavigationEntry[] = []
    let removedUpToActive = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e && isWebErrorUrl(e.url)) {
        if (i <= active) removedUpToActive++
        continue
      }
      kept.push(e)
    }
    snap.navHistory = kept
    snap.navHistoryIndex = Math.max(0, Math.min(kept.length - 1, active - removedUpToActive))
  }
  return snap.url
}

/**
 * 休眠前抓取导航快照并写回 tab 记录（对齐 RT `putToSleep`）。
 * @returns {boolean} 是否抓取到快照
 */
function captureSnapshot(host: TabLifecycleHost, id: string, t: LifecycleTabRecord): boolean {
  const view = host._wcm.getTab(id)
  const snap = capturePreSleepState(view && view.webContents, t.url)
  if (!snap) return false
  // 停在错误页时，快照必须记「原网址」而不是错误页本身（见 stripErrorPageFromSnapshot）。
  stripErrorPageFromSnapshot(snap, t)
  t.preSleep = snap
  if (snap.url) t.url = snap.url
  return true
}

/**
 * 休眠收尾：摘除布局视图、销毁 webContents、清理事件映射、标记状态。
 * @param {object} host
 * @param {string} id
 * @param {object} t tab 记录
 */
function teardownForSleep(host: TabLifecycleHost, id: string, t: LifecycleTabRecord): void {
  const view = host._wcm.getTab(id)
  if (view && host._layout && typeof host._layout.forgetView === 'function') {
    host._layout.forgetView(view)
  }
  host._wcm.sleepTab(id)
  if (host._layout && typeof host._layout.resetTabBounds === 'function' && host._layout.getActiveTabId() === id) {
    host._layout.resetTabBounds()
  }
  host._boundTabIds.delete(id)
  for (const [wc, tid] of host._wcToTabId) {
    if (tid === id) host._wcToTabId.delete(wc)
  }
  t.sleeping = true
  // 没有 webContents 就**不可能**还在加载 —— 必须显式落 false。
  // 不落的话：休眠时正在加载的标签会把 loading=true 永久留在投影里，
  // 切到它时进度条与"停止"键一起挂死（而且 did-stop-loading 永远不会再来了，
  // 承载它的 wc 已经被销毁）。
  t.loading = false
  // 同理：进程没了就不可能还在发声。这一位是休眠豁免的判据（见 TabRules#sleepCandidates），
  // 残留 true 会让标签在唤醒后**继续**享受"正在发声"的豁免，直到页面再次播报媒体事件 ——
  // 一个静音自动播放的页面完全可以永不播报，于是永久免疫休眠。
  t.audioPlaying = false
}

/**
 * 唤醒标签的内部同步实现：重建 webContents + 绑定事件 + 还原导航历史。
 * 不派发 tab:changed（由调用方决定时机）。
 * @returns {Electron.WebContentsView | null}
 */
function wakeInternal(host: TabLifecycleHost, id: string): WebContentsView | null {
  const t = host._tabs.get(id)
  if (!t) return null
  if (!host._wcm.isTabSleeping(id)) return host._wcm.createTab(id)
  const view = host._wcm.createTab(id)
  host._bindTabEvents(id)
  try { if (t.muted && view.webContents) view.webContents.setAudioMuted(true) } catch {}
  // 优先用休眠快照还原导航历史（对齐 RT wakeUp）：restore 会把页面恢复到
  // 休眠前的活动条目，因此无需再 loadURL；只有快照缺失时才回退到加载 URL。
  const pre = t.preSleep
  const restored = restoreNavigationHistory(view.webContents, pre)
  if (!restored && t.url && t.url !== 'about:blank') {
    view.webContents.loadURL(t.url).catch((e) => {
      if (e && e.code !== 'ERR_ABORTED' && !String(e.message).includes('ERR_ABORTED')) {
        console.error(`[tab] wake loadURL failed: ${e.message}`)
      }
    })
  }
  t.preSleep = null
  t.sleeping = false
  return view
}

/**
 * 休眠标签：销毁 webContents 释放内存，保留 URL/title/favicon 与导航快照。
 * @returns {{ tabId: string, sleeping: boolean, reason?: string }}
 */
function sleepTab(host: TabLifecycleHost, tabId: string): { tabId: string; sleeping: boolean; reason?: string } {
  const id = String(tabId)
  const t = host._tabs.get(id)
  if (!t) return { tabId: id, sleeping: false }
  // 屏幕上正显示的标签不能休眠（活动标签只是其中一员，分屏/速览时还有别的格）——
  // 见 isOnScreen 的说明：休眠会销毁正在渲染的 view，留下空白格。
  if (isOnScreen(host, id)) return { tabId: id, sleeping: false, reason: 'visible' }
  // 已休眠
  if (host._wcm.isTabSleeping(id)) return { tabId: id, sleeping: true }
  // 销毁 webContents 前先抓导航快照（对齐 RT PreSleepState），
  // 否则唤醒后失去前进/后退历史，且持久化只能存到一个孤立 URL。
  // 同时广播 onTabWillHide 让消费方（hover 预览）抓最后一帧 ——
  // 休眠同样是一次「隐藏」，且是**不可逆地**销毁渲染进程，之后 capturePage 只能是空图。
  if (typeof host._notifyTabWillHide === 'function') host._notifyTabWillHide(id)
  captureSnapshot(host, id, t)
  teardownForSleep(host, id, t)
  host._scheduleEmitChanged()
  console.log(`[tab] slept: ${id} url=${t.url}`)
  return { tabId: id, sleeping: true }
}

/**
 * 唤醒标签：重新创建 webContents 并还原导航历史。
 * @returns {Promise<{ tabId: string, sleeping: boolean }>}
 */
async function wakeTab(host: TabLifecycleHost, tabId: string): Promise<{ tabId: string; sleeping: boolean }> {
  const id = String(tabId)
  const t = host._tabs.get(id)
  if (!t) return { tabId: id, sleeping: false }
  if (!host._wcm.isTabSleeping(id)) return { tabId: id, sleeping: false }
  wakeInternal(host, id)
  // 唤醒后新视图默认隐藏且未挂载（对齐 RT tab.ts 的 setVisible(false)）。
  // 若它是当前活动标签，必须经 showTab 重新挂载并显示，否则唤醒了却看不见。
  if (host._layout.getActiveTabId() === id && typeof host._layout.showTab === 'function') host._layout.showTab(id)
  host._scheduleEmitChanged()
  console.log(`[tab] woke: ${id} url=${t.url}`)
  return { tabId: id, sleeping: false }
}

/**
 * 把一批（**已经过领域规则筛选**的）tabId 真正睡掉。
 *
 * 抽出来的理由：休眠触发点现在有两条（显式 / 时间腿），而「执行一次休眠」
 * 的副作用链是**唯一**的 —— 可见性豁免 → 抓快照 → 广播即将隐藏 → 拆视图销毁 wc。
 * 两个入口各写一遍必然漂移（历史上的"幽灵标签"就是漏了可见性那一道）。
 *
 * 这里只补领域规则看不见的两件事：
 *   1. **屏幕上正显示的**（分屏/速览的另一格也算）一律跳过 —— 见 isOnScreen；
 *   2. 执行期间记录可能已变（并发关闭 / 已睡）→ 逐个再校验一次。
 *
 * @param {object} host
 * @param {string[]} ids
 * @returns {string[]} 真正睡掉的 tabId
 */
function sleepIds(host: TabLifecycleHost, ids: string[]): string[] {
  /** @type {string[]} */
  const slept: string[] = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const t = host._tabs.get(id)
    if (!t || t.sleeping) continue
    // 屏幕上正显示的（分屏/速览的另一格也算）一律跳过：领域规则只认"活动"，
    // 而"可见"是布局层才知道的事 —— 这里补上，见 isOnScreen。
    if (isOnScreen(host, id)) continue
    // 抓导航快照（对齐 RT PreSleepState），保住前进/后退历史；
    // 并在销毁前广播 onTabWillHide（同 sleepTab：休眠前是最后一帧的唯一采集时机）
    if (typeof host._notifyTabWillHide === 'function') host._notifyTabWillHide(id)
    captureSnapshot(host, id, t)
    teardownForSleep(host, id, t)
    slept.push(id)
  }
  if (slept.length > 0) host._scheduleEmitChanged()
  return slept
}

/**
 * 批量休眠非活动标签（内存优化）。
 * 「谁该睡」是领域规则 → 交给注入的 tabRules 算，这里只执行副作用。
 * @returns {{ slept: string[] }}
 */
function sleepInactive(host: TabLifecycleHost, opts: { inactiveThresholdMs?: number; excludePinned?: boolean } = {}): { slept: string[] } {
  const inactiveThresholdMs = opts.inactiveThresholdMs ?? 5 * 60 * 1000
  const excludePinned = opts.excludePinned !== false
  const now = Date.now()
  const activeId = host._layout.getActiveTabId()
  // 「谁该睡」由领域规则给出，infra 只执行副作用
  const candidates = host._tabRules.sleepCandidates(host._ruleInput(), {
    activeTabId: activeId,
    now,
    inactiveThresholdMs,
    excludePinned
  })
  return { slept: sleepIds(host, candidates) }
}

/**
 * 归档候选名单 —— **复用领域规则 `sleepCandidates` 作为唯一的豁免判定入口**。
 *
 * 为什么必须复用而不是另写一份：休眠与归档的豁免规则（活动 / 固定 / 正在发声 /
 * 未达闲置阈值）必须永远一致，否则两条腿会各自漂移 —— 例如归档漏掉音频豁免，
 * 就会把正在后台放音乐的标签直接删掉。把「谁够格」交给同一个 domain 纯函数，
 * infra 只负责「怎么执行」，这是本项目分层的主旨。
 *
 * 唯一差异是「已休眠」这一位：`sleepCandidates` 把已休眠视为跳过项（它回答的是
 * 「谁还需要被睡」，已经在睡的自然不用再睡）；而归档回答的是「谁该被删掉」——
 * 已休眠标签虽不再占 webContents 内存，却仍在标签栏里只增不减，同样是归档候选。
 * 因此这里把输入里的 `sleeping` 位**归一为 false** 再交给领域规则：
 * 只改这一个位，四条豁免仍由 domain 计算，属于复用而非重写。
 *
 * @returns {string[]} 可以归档的 tabId（保持输入顺序）
 */
function archiveCandidates(host: TabLifecycleHost, { now, inactiveThresholdMs }: { now: number; inactiveThresholdMs: number }): string[] {
  const asAwake = host._ruleInput().map((t) => ({ ...t, sleeping: false }))
  const ids = host._tabRules.sleepCandidates(asAwake, {
    activeTabId: host._layout.getActiveTabId(),
    now,
    inactiveThresholdMs,
    // 固定标签是用户「显式保留」的承诺；归档会删标签，任何情况下都不得动它 → 恒定豁免
    excludePinned: true
  })
  // 领域规则只按 inactiveThresholdMs 判"闲置"，看不见"谁在屏幕上"。
  // 归档 = 删标签，把分屏另一格删掉会留下空白格 → 这里按布局层的可见集合再滤一道。
  return (Array.isArray(ids) ? ids : []).filter((id) => !isOnScreen(host, id))
}

/**
 * 归档标签 —— 语义等价于「用户关掉了它」：记录与视图一并消失。
 *
 * 与休眠的本质区别：休眠可逆（保留记录，切回自动唤醒），归档不可逆。
 * 因此这里**走既有 `close(id, { skipUndoStack: true })`**，而不是自己拆视图/删记录：
 *   · 复用 close 的全部边界处理（最后一个标签替换、活动标签切换到邻居、栈回收、
 *     webContents → tabId 映射清理、onTabClosed hook、tab:changed 派发）；
 *   · `skipUndoStack` 是关键 —— 归档不是用户主动关闭，绝不能进「恢复关闭的标签页」
 *     撤销栈，否则 Ctrl+Shift+T 会一次性吐出一堆用户从没关过的标签。
 *
 * 对所有异常状态（标签不存在 / 已休眠 / webContents 已销毁）安全：不抛错。
 * @param {object} host
 * @param {string} tabId
 * @param {{ explicit?: boolean }} [options]
 *   `explicit: true` = **用户显式归档**（标签右键菜单 / 面板按钮）。
 *   与后台自动清理的唯一区别就在"活动标签"这一条上，见下面的注释。
 * @returns {{ tabId: string, archived: boolean, reason?: string }}
 */
function archiveTab(host: TabLifecycleHost, tabId: string, options: { explicit?: boolean } = {}): { tabId: string; archived: boolean; reason?: string } {
  const id = String(tabId)
  const t = host._tabs.get(id)
  // 标签已不存在（并发下可能刚被用户关掉）→ 视为已达成目标，静默返回
  if (!t) return { tabId: id, archived: false, reason: 'missing' }
  // 固定标签是用户显式保留的承诺，归档绝不触碰（与候选规则同源，这里再兜一道）
  if (t.pinned) return { tabId: id, archived: false, reason: 'pinned' }
  /**
   * 活动标签：**两条路径必须分开对待**。
   *
   *   · 后台自动归档（`archiveInactive`）绝不能替用户关掉他正看着的页面 —— 那是"抢"。
   *   · 用户**显式**点「归档标签」时恰恰相反：他要归档的多半就是当前这一页
   *     （右键的通常是活动标签），拦住它等于**点了毫无反应** —— 这条拦截曾经就是
   *     "右键归档没反应"的全部原因（拦截返回的 reason 被静默吞掉）。
   *
   * 所以判据挂在 `explicit` 上，而不是简单删掉这个保护。
   * 自动那条腿的判据后来从「活动」放宽到「**可见**」（见 isOnScreen）——
   * 分屏/速览下非活动的那一格同样在屏幕上，归档它一样会留下空白格。
   */
  if (!options.explicit && isOnScreen(host, id)) {
    // 同上但再严一档：**可见**即豁免（分屏另一格也在屏幕上，删掉它同样会留下空白格）。
    // 用户显式归档时不受此限 —— 显式意图优先（见上面对 explicit 的说明）。
    return { tabId: id, archived: false, reason: 'visible' }
  }
  const result = host.close(id, { skipUndoStack: true })
  // close 可能拒绝真正删除（例如「最后一个标签」会被替换成空白页而非关掉）——
  // 那种情况下标签仍在，不能算归档成功。
  if (!result || !result.closed) {
    return { tabId: id, archived: false, reason: (result && result.reason) || 'not-closed' }
  }
  console.log(`[tab] archived: ${id} url=${t.url}`)
  // 记入「归档区」（可恢复）：**只把事实报给宿主** —— infra 不认识"归档区"这个 UI 概念，
  // 由 APPS 决定写去哪（当前：设置项 archive.entries，见 browser-window-runtime）。
  if (typeof host._hooks.onTabArchived === 'function') {
    try {
      host._hooks.onTabArchived({ tabId: id, url: t.url, title: t.title, favicon: t.favicon, spaceId: t.spaceId })
    } catch (_) {}
  }
  return { tabId: id, archived: true }
}

/**
 * 批量归档长期闲置的非活动标签（标签栏瘦身，对齐 RT 的第二条回收腿）。
 * 「谁该归档」同样是领域规则 → 交给 `sleepCandidates` 算，这里只执行副作用。
 *
 * 安全默认：归档是**不可逆的删除**，阈值缺失/非法时**什么也不做**。
 * 上层（tabs.auto-sleep）在 `tabs.archiveAfter === 'never'` 时根本不会调用本方法，
 * 这里是第二道保险，确保任何误调用都不会删掉用户的标签。
 *
 * @param {{ inactiveThresholdMs?: number }} [opts]
 * @returns {{ archived: string[] }}
 */
function archiveInactive(host: TabLifecycleHost, opts: { inactiveThresholdMs?: number } = {}): { archived: string[] } {
  const inactiveThresholdMs = Number(opts.inactiveThresholdMs)
  if (!Number.isFinite(inactiveThresholdMs) || inactiveThresholdMs <= 0) return { archived: [] }
  const now = Date.now()
  const candidates = archiveCandidates(host, { now, inactiveThresholdMs })
  /** @type {string[]} */
  const archived: string[] = []
  // close 是**立即派发**的（用户关标签要立刻有反馈）—— 批量归档必须折叠成一次，
  // 否则归档 N 个就是 N 次全量 list() + 投影 + IPC。
  host._withEmitBatch(() => {
    for (const id of candidates) {
      if (archiveTab(host, id).archived) archived.push(id)
    }
  })
  return { archived }
}

/** 记录标签被激活的时间戳（用于 sleepInactive 判定） */
function markActivated(host: TabLifecycleHost, tabId: string): void {
  const id = String(tabId)
  const t = host._tabs.get(id)
  if (t) t.lastActivated = Date.now()
}

export { sleepTab, wakeTab, sleepIds, sleepInactive, archiveTab, archiveInactive, markActivated, wakeInternal }
