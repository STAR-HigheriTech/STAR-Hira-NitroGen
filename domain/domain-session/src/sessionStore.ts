import { SESSION_VERSION } from './schema'
import { applyTabUserState } from './sessionUtil'
import type {
  PersistedSessionRecord,
  PersistableTab,
  SessionGlanceInput,
  SessionGlanceRecord,
  SessionNavEntry,
  SessionRecord,
  SessionRestorePlan,
  SessionRestoreTab,
  SessionSplitInput,
  SessionSplitRecord,
  SessionStackInput,
  SessionStackRecord,
  SessionTabRecord
} from './types'

/** 单条标签最多持久化 25 条导航历史，避免 base64 pageState 无限膨胀。 */
export const MAX_PERSISTED_NAV_ENTRIES = 25

/** 运行期导航历史 → 可写盘的紧凑形式。 */
export function compactNavHistory(entries?: readonly SessionNavEntry[] | null): SessionNavEntry[] {
  const output: SessionNavEntry[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.url !== 'string' || entry.url.length === 0) continue
    const next: SessionNavEntry = { url: entry.url }
    if (typeof entry.title === 'string' && entry.title) next.title = entry.title
    if (typeof entry.pageState === 'string' && entry.pageState) next.pageState = entry.pageState
    output.push(next)
  }
  return output
}

/** 运行期标签快照 → 单会话文件记录。 */
export function toRecord(
  tabList: readonly PersistableTab[] | null | undefined,
  activeTabId: string | number | null | undefined,
  now: number,
  stackList: readonly SessionStackInput[] = [],
  splitList: readonly SessionSplitInput[] = [],
  glanceList: readonly SessionGlanceInput[] = []
): PersistedSessionRecord {
  const ordered = (Array.isArray(tabList) ? tabList : [])
    .filter((tab) => tab && typeof tab.url === 'string' && tab.url.length > 0)
    .slice()

  if (ordered.length > 0 && ordered.every((tab) => Number.isFinite(Number(tab.position)))) {
    ordered.sort((left, right) => Number(left.position) - Number(right.position))
  }

  const tabs = ordered.map((source): SessionTabRecord => {
    const tab: SessionTabRecord = {
      tabId: String(source.tabId),
      url: source.url as string,
      pinned: Boolean(source.pinned)
    }
    if (typeof source.profileId === 'string' && source.profileId) tab.profileId = source.profileId
    if (typeof source.spaceId === 'string' && source.spaceId) tab.spaceId = source.spaceId
    if (typeof source.stackId === 'string' && source.stackId) tab.stackId = source.stackId
    if (typeof source.splitId === 'string' && source.splitId) tab.splitId = source.splitId
    if (typeof source.glanceId === 'string' && source.glanceId) tab.glanceId = source.glanceId
    applyTabUserState(tab, source)

    const history = source.navHistory
    const sourceLength = Array.isArray(history) ? history.length : 0
    if (sourceLength > 1) {
      const dropped = Math.max(0, sourceLength - MAX_PERSISTED_NAV_ENTRIES)
      const nav = compactNavHistory(history?.slice(dropped))
      if (nav.length > 1) {
        tab.navHistory = nav
        const index = Number(source.navHistoryIndex)
        tab.navHistoryIndex = Number.isFinite(index)
          ? Math.min(Math.max(0, index - dropped), nav.length - 1)
          : nav.length - 1
      }
    }
    return tab
  })

  const stackIds = new Set(
    tabs
      .map((tab) => tab.stackId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
  const stacks = (Array.isArray(stackList) ? stackList : [])
    .filter((stack) => stack && (Boolean(stack.pinned) || stackIds.has(String(stack.stackId))))
    .map((stack): SessionStackRecord => ({
      stackId: String(stack.stackId),
      label: typeof stack.label === 'string' ? stack.label : '',
      accent: typeof stack.accent === 'string' ? stack.accent : '',
      collapsed: Boolean(stack.collapsed),
      pinned: Boolean(stack.pinned)
    }))

  const active = activeTabId != null && tabs.some((tab) => tab.tabId === String(activeTabId))
    ? String(activeTabId)
    : null

  const splitIds = new Set(
    tabs
      .map((tab) => tab.splitId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
  const splits = (Array.isArray(splitList) ? splitList : [])
    .filter((split) => split && splitIds.has(String(split.splitId)))
    .map((split): SessionSplitRecord => {
      const memberList: readonly (string | number)[] = split.members ?? []
      const members = memberList
        .map((id) => String(id))
        .filter((id: string) => tabs.some((tab) => tab.tabId === id))
      return {
        splitId: String(split.splitId),
        layout: typeof split.layout === 'string' ? split.layout : 'row',
        ratios: Array.isArray(split.ratios) ? split.ratios.slice() : [],
        members,
        activeTabId: split.activeTabId == null ? null : String(split.activeTabId)
      }
    })
    .filter((split) => split.members.length >= 2)

  const glanceIds = new Set(
    tabs
      .map((tab) => tab.glanceId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
  const glances = (Array.isArray(glanceList) ? glanceList : [])
    .filter((glance) => glance && glanceIds.has(String(glance.glanceId)))
    .map((glance): SessionGlanceRecord => {
      const memberList: readonly (string | number)[] = glance.members ?? []
      const members = memberList
        .map((id) => String(id))
        .filter((id: string) => tabs.some((tab) => tab.tabId === id))
      const front = glance.frontTabId == null ? '' : String(glance.frontTabId)
      return {
        glanceId: String(glance.glanceId),
        members,
        frontTabId: members.includes(front) ? front : members[members.length - 1] ?? null
      }
    })
    .filter((glance) => glance.members.length === 2)

  return {
    version: SESSION_VERSION,
    savedAt: now,
    activeTabId: active,
    tabs,
    stacks,
    splits,
    glances
  }
}

/** 持久化记录 → 恢复计划；活动标签换算为位置，运行期 id 不跨会话复用。 */
export function toRestorePlan(record?: SessionRecord | null): SessionRestorePlan {
  if (!record || !Array.isArray(record.tabs) || record.tabs.length === 0) {
    return { tabs: [], activeIndex: -1 }
  }

  const tabs = record.tabs.map((source): SessionRestoreTab => {
    const tab: SessionRestoreTab = { url: source.url, pinned: Boolean(source.pinned) }
    if (source.stackId) tab.stackId = source.stackId
    if (source.splitId) tab.splitId = source.splitId
    if (source.glanceId) tab.glanceId = source.glanceId
    applyTabUserState(tab, source)
    if (Array.isArray(source.navHistory) && source.navHistory.length > 1) {
      tab.navHistory = source.navHistory
      tab.navHistoryIndex = Number.isFinite(Number(source.navHistoryIndex))
        ? Number(source.navHistoryIndex)
        : source.navHistory.length - 1
    }
    return tab
  })

  const activeIndex = record.activeTabId
    ? record.tabs.findIndex((tab) => tab.tabId === record.activeTabId)
    : -1
  return { tabs, activeIndex }
}
