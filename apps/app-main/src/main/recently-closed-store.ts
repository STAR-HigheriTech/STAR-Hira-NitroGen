/**
 * recently-closed-store —— 「最近关闭」的跨启动持久化（APPS 层）。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────
 * `TabManager#_closedTabStack` 是纯内存的撤销栈：进程一退，"昨天关掉的那个页面"
 * 就彻底没了。用户口径：**像历史记录一样长期保存，但只留最近三次启动里的记录**。
 *
 * ── 为什么在 APPS 层、而不是塞进 infra ────────────────────────────
 * `infra/infra-window` 只该认识"标签"这一个领域，不该认识设置项 / 磁盘 / profile；
 * 因此存储与启动分组在这里，TabManager 只留两个**可选钩子**：
 *   · `loadClosedTabs()`        —— 构造时播种撤销栈（旧 → 新）
 *   · `onClosedStackChanged()`  —— 栈每次变化后镜像回存储
 * 两个钩子都不传，infra 的行为与改造前完全一致（快照单元 / 单测即这个用法）。
 *
 * ── 「一次启动」的判定 ────────────────────────────────────────────
 * `LAUNCH_AT` 在**模块加载时**取一次时间戳 —— 主进程里所有窗口共享同一个值，
 * 因此同一次运行中关掉的标签属于同一组；重启后自然换一组。
 *
 * ── 存哪 ─────────────────────────────────────────────────────────
 * 设置项 `session.recently_closed`（JSON 串）。与命名会话 / 归档区同一手法：
 * 结构化小集合不建表，天然随 profile 隔离；写入走设置服务的**防抖异步落盘**，
 * 退出前由设置服务的 flush 兜底，不在这条"关标签"的热路径上做同步磁盘 I/O。
 */

const {
  RECENTLY_CLOSED_SETTING_KEY,
  RECENTLY_CLOSED_ENTRIES_LIMIT,
  parseRecentlyClosed,
  serializeRecentlyClosed,
  normalizeClosedEntry
} = require('@hira-ng/shared-types/src/recently-closed.mjs')

/** 本次**进程启动**的时间戳（同一次运行内所有记录共用；见文件头）。 */
const LAUNCH_AT = Date.now()

interface RecentlyClosedEntry {
  tabId?: string
  url?: string
  title?: string
  favicon?: string
  pinned?: boolean
  stackId?: string | null
  index?: number
  closedAt?: number
  launchAt?: number
  [key: string]: unknown
}

interface RecentlyClosedSettings {
  get?: (key: string) => unknown
  set?: (key: string, value: unknown) => unknown
}

function createRecentlyClosedStore({ settings }: { settings?: RecentlyClosedSettings } = {}) {
  /** 已归一化的记录（最近关闭在前）。惰性读一次，之后以内存为准。 */
  let cache: RecentlyClosedEntry[] | null = null

  function readAll(): RecentlyClosedEntry[] {
    if (cache) return cache
    try {
      cache = parseRecentlyClosed(settings && typeof settings.get === 'function'
        ? settings.get(RECENTLY_CLOSED_SETTING_KEY)
        : '') as RecentlyClosedEntry[]
    } catch (_) {
      cache = []
    }
    return cache
  }

  /** 写回存储（设置服务自己防抖落盘；这里只保证内存与设置缓存同步）。 */
  function writeAll(list: RecentlyClosedEntry[]): void {
    const raw = serializeRecentlyClosed(list)
    cache = parseRecentlyClosed(raw)
    try {
      if (settings && typeof settings.set === 'function') {
        settings.set(RECENTLY_CLOSED_SETTING_KEY, raw)
      }
    } catch (error) {
      console.warn('[recently-closed] 保存失败:', error instanceof Error ? error.message : error)
    }
  }

  /**
   * 播种：把上次（及上上次）启动留下的记录交给 TabManager 的撤销栈。
   * 顺序为**旧 → 新**（撤销栈的下标口径），因此把"最近在前"的存储倒过来。
   * @returns {Array}
   */
  function seed(): RecentlyClosedEntry[] {
    return readAll()
      .slice(0, RECENTLY_CLOSED_ENTRIES_LIMIT)
      .slice()
      .reverse()
      .map((entry) => ({ ...entry }))
  }

  /**
   * 镜像：撤销栈每次变化后同步回存储。
   *
   * 新条目（本次启动关掉的）没有 `launchAt` → 打上本次启动的戳；播种来的旧条目
   * 保留各自的戳。按启动分组只留最新 `LIMIT` 组（见纯层 trim）。
   * @param {Array} stack TabManager 的撤销栈（旧 → 新；只读）
   */
  function mirror(stack: unknown): void {
    const rows = (Array.isArray(stack) ? stack : []).map((entry: RecentlyClosedEntry | null) => normalizeClosedEntry({
      ...(entry || {}),
      launchAt: Number(entry?.launchAt) > 0 ? Number(entry?.launchAt) : LAUNCH_AT
    })).filter(Boolean) as RecentlyClosedEntry[]
    writeAll(rows)
  }

  return { seed, mirror }
}

module.exports = { createRecentlyClosedStore, RECENTLY_CLOSED_LAUNCH_AT: LAUNCH_AT }
