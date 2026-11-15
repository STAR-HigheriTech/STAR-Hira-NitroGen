/**
 * Domain: Tabs — 标签领域规则（纯函数）
 *
 * 这里回答的都是 **"哪些标签该怎么处理"** 的问题，而不是"怎么处理"：
 *   哪些该休眠 / 关闭其它该关掉谁 / 关掉右侧留谁 / 撤销关闭插回哪一格 / 拖拽后什么顺序
 *
 * 设计约束（与 domain-session 同规矩）：
 *   - **零 IO、零 Electron、零时间依赖** —— `now` 由调用方传入；
 *   - 只做 POJO → POJO，不碰 WebContents、不产生副作用；
 *   - 调用方拿到"名单/顺序"后自己执行副作用。
 *
 * 为什么值得单独成模块：这五条规则原先内联在 841 行的 `infra-window#TabManager` 里，
 * 与 WebContentsView 的创建/销毁交织，**既不可单测也极易在边界上悄悄改错**
 * （固定标签误伤、活动标签被休眠、索引越界、id 不存在）。
 *
 * @typedef {{ tabId: string, pinned?: boolean, sleeping?: boolean, audio?: boolean, audioPlaying?: boolean, lastActivated?: number }} TabLike
 */



interface TabLike { tabId: string; pinned: boolean; sleeping: boolean; audio: boolean; lastActivated: number }
interface SleepOptions { activeTabId?: string | null; now: number; inactiveThresholdMs?: number; excludePinned?: boolean }
interface ReorderPayload { draggedId: string; targetId: string; insertAfter?: boolean }

const { canCloseWithOthers } = require('@hira-ng/shared-types/src/tab-policy.mjs')
// 默认"多久没激活才允许休眠"：5 分钟 —— 与设置项缺省值 / 运行时定时器同一真源。
const { DEFAULT_AUTO_SLEEP_THRESHOLD_MS } = require('@hira-ng/shared-types/src/tab-sleep.mjs')
const DEFAULT_INACTIVE_THRESHOLD_MS = DEFAULT_AUTO_SLEEP_THRESHOLD_MS

/**
 * 把任意输入收敛成干净的 TabLike 数组。
 * 丢弃没有 tabId 的脏数据，id 一律字符串化 —— 上游 tabId 可能来自 IPC（数字）或内部（uuid）。
 * @param {unknown} tabList
 * @returns {TabLike[]}
 */
function normalize(tabList: unknown): TabLike[] {
  if (!Array.isArray(tabList)) return []
  const out: TabLike[] = []
  for (const t of tabList) {
    if (!t || t.tabId == null) continue
    out.push({
      tabId: String(t.tabId),
      pinned: !!t.pinned,
      sleeping: !!t.sleeping,
      // 音频字段兼容两种命名：domain 惯例是 `audio`（见 TabAdjust.tabStats），
      // infra 内部记录用的是 `audioPlaying`（由 tabEvents 的 media-* 维护）。
      // 二者取或，任一为真即视为"媒体型标签"。
      audio: !!(t.audio || t.audioPlaying),
      lastActivated: typeof t.lastActivated === 'number' ? t.lastActivated : 0
    })
  }
  return out
}

/**
 * 批量休眠的候选名单。
 *
 * 四重豁免（顺序无关，但都在这里收口）：
 *   1. **活动标签**永不休眠 —— 睡了页面就白屏；
 *   2. `excludePinned`（默认 true）时 **固定标签** 不睡；
 *   3. 已经在睡的跳过；
 *   4. **正在播放音频/视频的标签**不睡 —— 对齐 legacy Hira `webviews.js` 的
 *      `if (tab.hasAudio) return`。否则后台音乐、视频通话会被 `webContents.destroy()`
 *      直接掐断，属于"内存优化反而打断用户"的功能回归级缺陷。
 *
 * `lastActivated` 缺失按 0 处理，即"从没被激活过" → 视为可休眠。
 * 这与旧实现 `t.lastActivated || 0` 一致，别改成"缺失就不睡"。
 *
 * @param {unknown} tabList
 * @param {{ activeTabId?: string|null, now: number, inactiveThresholdMs?: number, excludePinned?: boolean }} opts
 * @returns {string[]} 可以休眠的 tabId（保持输入顺序）
 */
function sleepCandidates(tabList: unknown, opts: SleepOptions = { now: 0 }): string[] {
  const { activeTabId = null, now, inactiveThresholdMs = DEFAULT_INACTIVE_THRESHOLD_MS, excludePinned = true } = opts
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('sleepCandidates: now 必须是有限数字（时间由调用方注入）')
  }
  const active = activeTabId == null ? null : String(activeTabId)
  const ids: string[] = []
  for (const t of normalize(tabList)) {
    if (t.tabId === active) continue
    if (excludePinned && t.pinned) continue
    if (t.sleeping) continue
    if (t.audio) continue
    if (now - t.lastActivated < inactiveThresholdMs) continue
    ids.push(t.tabId)
  }
  return ids
}

/**
 * 「关闭其它标签」的目标名单：除 `tabId` 自身外全部，但**放固定标签一条生路**。
 * @param {unknown} tabList
 * @param {string} tabId
 * @returns {string[]}
 */
function othersToClose(tabList: unknown, tabId: string): string[] {
  const self = String(tabId)
  return normalize(tabList)
    .filter((t) => t.tabId !== self && canCloseWithOthers(t))
    .map((t) => t.tabId)
}

/**
 * 「关闭右侧标签」的目标名单：`tabId` **之后**的标签，同样跳过固定标签。
 * `tabId` 不存在时返回空数组（旧实现返回 `{closed: 0}`，此处等价）。
 * @param {unknown} tabList
 * @param {string} tabId
 * @returns {string[]}
 */
function rightToClose(tabList: unknown, tabId: string): string[] {
  const self = String(tabId)
  const tabs = normalize(tabList)
  const idx = tabs.findIndex((t) => t.tabId === self)
  if (idx < 0) return []
  return tabs.slice(idx + 1).filter((t) => canCloseWithOthers(t)).map((t) => t.tabId)
}

/**
 * 撤销关闭时把标签插回原来的位置。
 *
 * 旧实现是 `Math.min(last.index, entries.length)` —— **只夹了上界**。
 * 这里补上下界：脏数据里的负数/NaN 索引会让 `splice` 反向插入，静默把标签放错位置。
 * @param {number} preferredIndex 关闭前的原始下标
 * @param {number} length 当前列表长度（不含待插入项）
 * @returns {number} 落在 [0, length] 的合法下标
 */
function undoInsertIndex(preferredIndex: number, length: number): number {
  const max = Number.isFinite(length) && length > 0 ? Math.floor(length) : 0
  const idx = Number.isFinite(preferredIndex) ? Math.floor(preferredIndex) : 0
  if (idx < 0) return 0
  return Math.min(idx, max)
}

/**
 * 拖拽重排：算出新的 id 顺序。
 *
 * 语义与旧实现逐步对齐（移除 → 在**移除后**的数组上定位 target → 插到前/后）：
 * 先摘掉被拖项，`target` 的下标必须在摘除之后再算，否则 `insertAfter` 会偏一格。
 *
 * @param {unknown} ids 当前顺序
 * @param {{ draggedId: string, targetId: string, insertAfter?: boolean }} payload
 * @returns {{ ok: true, ids: string[] } | { ok: false, reason: 'same' | 'missing' }}
 */
function reorderIds(ids: unknown, payload: ReorderPayload = { draggedId: '', targetId: '' }): { ok: true; ids: string[] } | { ok: false; reason: 'same' | 'missing' } {
  const list = (Array.isArray(ids) ? ids : []).map(String)
  const dragged = String(payload.draggedId)
  const target = String(payload.targetId)
  if (dragged === target) return { ok: false, reason: 'same' }

  const draggedIdx = list.indexOf(dragged)
  if (draggedIdx < 0 || list.indexOf(target) < 0) return { ok: false, reason: 'missing' }

  const next = list.slice()
  next.splice(draggedIdx, 1)
  let targetIdx = next.indexOf(target)
  if (payload.insertAfter) targetIdx += 1
  next.splice(targetIdx, 0, dragged)
  return { ok: true, ids: next }
}

export {
  DEFAULT_INACTIVE_THRESHOLD_MS,
  sleepCandidates,
  othersToClose,
  rightToClose,
  undoInsertIndex,
  reorderIds
}
