/**
 * named-sessions —— 命名会话（N14）的主进程引擎。
 *
 * 「保存当前空间的标签集 → 起个名字 → 之后一键恢复」。
 *
 * ── 为什么是"打开"而不是"替换" ────────────────────────────────────
 * 恢复时把标签**追加**打开，不动用户此刻已经开着的标签 —— 恢复一个会话是
 * "把当时那批页面拿回来"，不是"把我现在的活全关掉"。主流浏览器（Vivaldi 保存会话）
 * 也是这个语义；要清空是另一个动作，不该藏在"恢复"里。
 *
 * ── 分工 ──────────────────────────────────────────────────────────
 *   · 形状与去重/上限在纯层 `shared-types#named-sessions.mjs`（本模块不认识 JSON 细节）；
 *   · 存哪在 APPS（设置项 `sessions.named`，随 profile 隔离，不建新表）；
 *   · 开标签走 `tabManager.newTab`（引擎不认识 IPC）。
 *
 */

const {
  parseNamedSessions,
  serializeNamedSessions,
  pushNamedSession,
  removeNamedSession,
  NAMED_SESSIONS_SETTING_KEY
} = require('@hira-ng/shared-types/src/named-sessions.mjs')

/** 存储键（设置项；与 `archive.entries` 同族 —— 结构化小集合不建表）。 */
const NAMED_SESSIONS_KEY = NAMED_SESSIONS_SETTING_KEY

interface NamedSessionTab {
  url?: string
  title?: string
  pinned: boolean
}

interface NamedSession {
  id: string
  name: string
  createdAt: number
  spaceId: string
  tabs: NamedSessionTab[]
}

interface NamedSessionsDeps {
  settings?: {
    get?: (key: string) => unknown
    set?: (key: string, value: unknown) => unknown
  } | null
  tabManager?: {
    list?: () => Array<{ url?: string; title?: string; pinned?: boolean }>
    newTab?: (options: {
      url?: string
      pinned: boolean
      openInBackground: boolean
    }) => Promise<unknown>
  } | null
}

function createNamedSessions(deps: NamedSessionsDeps = {}) {
  const settings = deps.settings || null
  const tabManager = deps.tabManager || null

  function readAll(): NamedSession[] {
    try {
      return parseNamedSessions(
        settings && typeof settings.get === 'function' ? settings.get(NAMED_SESSIONS_KEY) : ''
      ) as NamedSession[]
    } catch (_) {
      return []
    }
  }

  function writeAll(list: NamedSession[]): boolean {
    try {
      if (settings && typeof settings.set === 'function') {
        settings.set(NAMED_SESSIONS_KEY, serializeNamedSessions(list))
        return true
      }
    } catch (error) {
      console.warn('[named-sessions] 保存失败:', error instanceof Error ? error.message : error)
    }
    return false
  }

  /** 当前窗口可见标签的快照（`tabManager.list()` 已是"当前空间"那一批）。 */
  function snapshotTabs(): NamedSessionTab[] {
    if (!tabManager || typeof tabManager.list !== 'function') return []
    try {
      return (tabManager.list() || []).map((tab) => ({
        url: tab.url,
        title: tab.title,
        pinned: !!tab.pinned
      }))
    } catch (_) {
      return []
    }
  }

  return {
    list() {
      return readAll()
    },

    /**
     * 把当前标签集存成一个命名会话。
     */
    async save(name: string): Promise<{ ok: boolean; session?: NamedSession; reason?: string }> {
      const label = String(name == null ? '' : name).trim()
      if (!label) return { ok: false, reason: '请填写会话名称' }
      const tabs = snapshotTabs()
      if (tabs.length === 0) return { ok: false, reason: '当前没有可保存的标签' }
      // id 用"名字 + 时间戳"：同名多次保存是**各自独立**的快照（用户可能就是要两个版本），
      // 不覆盖 —— 与"同名去重"相比，这里的语义更接近"另存为"。
      const session: NamedSession = {
        id: `${label}::${Date.now()}`,
        name: label,
        createdAt: Date.now(),
        spaceId: '',
        tabs
      }
      const next = pushNamedSession(readAll(), session)
      if (!writeAll(next)) return { ok: false, reason: '写入设置失败' }
      return {
        ok: true,
        session: (next as NamedSession[]).find((item: NamedSession) => item.id === session.id) || session
      }
    },

    /**
     * 恢复一个会话（把它的标签**追加**打开）。
     */
    async restore(id: string): Promise<{ ok: boolean; opened?: number; reason?: string }> {
      const key = String(id == null ? '' : id)
      const session = readAll().find((item) => item.id === key)
      if (!session) return { ok: false, reason: '会话不存在' }
      if (!tabManager || typeof tabManager.newTab !== 'function') {
        return { ok: false, reason: '当前窗口不可用' }
      }
      let opened = 0
      for (const tab of session.tabs) {
        try {
          await tabManager.newTab({ url: tab.url, pinned: !!tab.pinned, openInBackground: true })
          opened++
        } catch (error) {
          console.warn(
            '[named-sessions] 打开标签失败（跳过）:',
            tab.url,
            error instanceof Error ? error.message : error
          )
        }
      }
      return { ok: opened > 0, opened }
    },

    /**
     * 删除一个命名会话。
     */
    async remove(id: string): Promise<{ ok: boolean }> {
      const next = removeNamedSession(readAll(), id)
      return { ok: writeAll(next) }
    }
  }
}

module.exports = { createNamedSessions, NAMED_SESSIONS_KEY }
