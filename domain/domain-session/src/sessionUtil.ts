import type {
  MutableTabUserState,
  SessionGlanceRecord,
  SessionNavEntry,
  SessionRecord,
  SessionSplitRecord,
  SessionStackRecord,
  SessionTabRecord,
  SuggestSessionNameOptions
} from './types'

const EMPTY_RECORD = (): SessionRecord => ({
  activeTabId: null,
  tabs: [],
  stacks: [],
  splits: [],
  glances: []
})

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 从 URL 提取 host（去协议、端口、路径、查询）。 */
export function hostOfUrl(url: unknown): string {
  const value = String(url ?? '')
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(value)
  return match ? match[1].split(':')[0] : ''
}

/** 去查询串与 hash，作为标签去重键。 */
export function stripUrl(url: unknown): string {
  return String(url ?? '').split('?')[0].split('#')[0]
}

export const MIN_STACK_MEMBERS = 2
export const MIN_SPLIT_MEMBERS = 2
export const GLANCE_MEMBERS = 2

/** 剔除成员不足或引用悬空标签的退化栈，同时清理标签指针。 */
export function pruneDegenerateStacks(
  tabs: SessionTabRecord[],
  stacks: readonly SessionStackRecord[],
  min = MIN_STACK_MEMBERS
): SessionStackRecord[] {
  const members = new Map<string, number>()
  for (const tab of tabs) {
    if (!tab.stackId) continue
    const id = String(tab.stackId)
    members.set(id, (members.get(id) ?? 0) + 1)
  }

  const kept = stacks.filter((stack) => {
    if (!stack) return false
    if (stack.pinned) return true
    return (members.get(String(stack.stackId)) ?? 0) >= min
  })
  const keptIds = new Set(kept.map((stack) => String(stack.stackId)))
  for (const tab of tabs) {
    if (tab.stackId && !keptIds.has(String(tab.stackId))) {
      delete tab.stackId
      tab.pinned = false
    }
  }
  return kept
}

/** 分屏成员恒为至少两个；不足时整组退化，标签本身保留。 */
export function pruneDegenerateSplits(
  tabs: SessionTabRecord[],
  splits: readonly SessionSplitRecord[]
): SessionSplitRecord[] {
  const kept: SessionSplitRecord[] = []
  for (const split of splits) {
    if (!split || split.splitId == null) continue
    const splitId = String(split.splitId)
    const members = tabs
      .filter((tab) => tab.splitId != null && String(tab.splitId) === splitId)
      .map((tab) => String(tab.tabId))
    if (members.length < MIN_SPLIT_MEMBERS) continue
    kept.push({
      splitId,
      layout: typeof split.layout === 'string' ? split.layout : 'row',
      ratios: split.ratios.filter((value) => Number.isFinite(value)),
      members,
      activeTabId: split.activeTabId == null ? null : String(split.activeTabId)
    })
  }

  const keptIds = new Set(kept.map((split) => split.splitId))
  for (const tab of tabs) {
    if (tab.splitId && !keptIds.has(String(tab.splitId))) delete tab.splitId
  }
  return kept
}

/** 速览成员必须恰好为两个，不满足时整组退化。 */
export function pruneDegenerateGlances(
  tabs: SessionTabRecord[],
  glances: readonly SessionGlanceRecord[]
): SessionGlanceRecord[] {
  const kept: SessionGlanceRecord[] = []
  for (const glance of glances) {
    if (!glance || glance.glanceId == null) continue
    const glanceId = String(glance.glanceId)
    const members = tabs
      .filter((tab) => tab.glanceId != null && String(tab.glanceId) === glanceId)
      .map((tab) => String(tab.tabId))
    if (members.length !== GLANCE_MEMBERS) continue
    const front = glance.frontTabId == null ? '' : String(glance.frontTabId)
    kept.push({
      glanceId,
      members,
      frontTabId: members.includes(front) ? front : members[members.length - 1] ?? null
    })
  }

  const keptIds = new Set(kept.map((glance) => glance.glanceId))
  for (const tab of tabs) {
    if (tab.glanceId && !keptIds.has(String(tab.glanceId))) delete tab.glanceId
  }
  return kept
}

/** 导航历史只有在至少两条时才值得持久化。 */
export function sanitizeNavHistory(entries: unknown): SessionNavEntry[] | null {
  if (!Array.isArray(entries)) return null
  const output: SessionNavEntry[] = []
  for (const item of entries) {
    const entry = asRecord(item)
    if (!entry || typeof entry.url !== 'string' || entry.url.length === 0) continue
    const next: SessionNavEntry = { url: entry.url }
    if (typeof entry.title === 'string' && entry.title) next.title = entry.title
    if (typeof entry.pageState === 'string' && entry.pageState) next.pageState = entry.pageState
    output.push(next)
  }
  return output.length > 1 ? output : null
}

/** 读写共用的标签用户态归一化规则。 */
export function applyTabUserState<T extends MutableTabUserState>(tab: T, source: unknown): T {
  const src = asRecord(source)
  if (!tab || !src) return tab
  if (src.muted === true) tab.muted = true

  const lastActivated = Number(src.lastActivated)
  if (Number.isFinite(lastActivated) && lastActivated > 0) {
    tab.lastActivated = Math.floor(lastActivated)
  }
  const position = Number(src.position)
  if (Number.isFinite(position)) tab.position = position
  if (typeof src.title === 'string' && src.title) tab.title = src.title
  if (typeof src.favicon === 'string' && src.favicon) tab.favicon = src.favicon
  return tab
}

/** 把任意输入收敛成内部自洽的会话记录。 */
export function sanitizeSessionRecord(record: unknown): SessionRecord {
  const source = asRecord(record)
  if (!source) return EMPTY_RECORD()

  const rawTabs = Array.isArray(source.tabs) ? source.tabs : []
  const tabs: SessionTabRecord[] = []
  for (const item of rawTabs) {
    const candidate = asRecord(item)
    if (!candidate || typeof candidate.url !== 'string' || candidate.url.length === 0) continue
    const tab: SessionTabRecord = {
      tabId: candidate.tabId == null ? String(Math.random()) : String(candidate.tabId),
      url: candidate.url,
      pinned: Boolean(candidate.pinned)
    }
    if (typeof candidate.profileId === 'string' && candidate.profileId) tab.profileId = candidate.profileId
    if (typeof candidate.spaceId === 'string' && candidate.spaceId) tab.spaceId = candidate.spaceId
    if (typeof candidate.stackId === 'string' && candidate.stackId) tab.stackId = candidate.stackId
    if (typeof candidate.splitId === 'string' && candidate.splitId) tab.splitId = candidate.splitId
    if (typeof candidate.glanceId === 'string' && candidate.glanceId) tab.glanceId = candidate.glanceId
    applyTabUserState(tab, candidate)

    const nav = sanitizeNavHistory(candidate.navHistory)
    if (nav) {
      tab.navHistory = nav
      const index = Number(candidate.navHistoryIndex)
      tab.navHistoryIndex = Number.isFinite(index)
        ? Math.min(Math.max(0, index), nav.length - 1)
        : nav.length - 1
    }
    tabs.push(tab)
  }

  const rawStacks: SessionStackRecord[] = []
  for (const item of Array.isArray(source.stacks) ? source.stacks : []) {
    const candidate = asRecord(item)
    if (!candidate || candidate.stackId == null) continue
    rawStacks.push({
      stackId: String(candidate.stackId),
      label: typeof candidate.label === 'string' ? candidate.label : '',
      accent: typeof candidate.accent === 'string' ? candidate.accent : '',
      collapsed: Boolean(candidate.collapsed),
      pinned: Boolean(candidate.pinned)
    })
  }
  const stacks = pruneDegenerateStacks(tabs, rawStacks)

  const rawSplits: SessionSplitRecord[] = []
  for (const item of Array.isArray(source.splits) ? source.splits : []) {
    const candidate = asRecord(item)
    if (!candidate || candidate.splitId == null) continue
    const ratios = Array.isArray(candidate.ratios)
      ? candidate.ratios.filter((value): value is number => Number.isFinite(Number(value))).map(Number)
      : []
    rawSplits.push({
      splitId: String(candidate.splitId),
      layout: typeof candidate.layout === 'string' ? candidate.layout : 'row',
      ratios,
      members: Array.isArray(candidate.members) ? candidate.members.map(String) : [],
      activeTabId: candidate.activeTabId == null ? null : String(candidate.activeTabId)
    })
  }
  const splits = pruneDegenerateSplits(tabs, rawSplits)

  const rawGlances: SessionGlanceRecord[] = []
  for (const item of Array.isArray(source.glances) ? source.glances : []) {
    const candidate = asRecord(item)
    if (!candidate || candidate.glanceId == null) continue
    rawGlances.push({
      glanceId: String(candidate.glanceId),
      members: Array.isArray(candidate.members) ? candidate.members.map(String) : [],
      frontTabId: candidate.frontTabId == null ? null : String(candidate.frontTabId)
    })
  }
  const glances = pruneDegenerateGlances(tabs, rawGlances)

  const activeTabId = tabs.some((tab) => tab.tabId === source.activeTabId)
    ? String(source.activeTabId)
    : null
  const version = typeof source.version === 'string' || typeof source.version === 'number'
    ? source.version
    : undefined

  return {
    version,
    savedAt: typeof source.savedAt === 'number' ? source.savedAt : undefined,
    activeTabId,
    tabs,
    stacks,
    splits,
    glances
  }
}

export function sessionTabCount(record: unknown): number {
  return sanitizeSessionRecord(record).tabs.length
}

export function pinnedSessionTabs(record: unknown): SessionTabRecord[] {
  return sanitizeSessionRecord(record).tabs.filter((tab) => tab.pinned)
}

export function activeSessionTabUrl(record: unknown): string {
  const normalized = sanitizeSessionRecord(record)
  return normalized.tabs.find((tab) => tab.tabId === normalized.activeTabId)?.url ?? ''
}

export function isRestorable(record: unknown): boolean {
  return sanitizeSessionRecord(record).tabs.length > 0
}

export function sessionStats(record: unknown): { tabs: number; pinned: number; activeIndex: number } {
  const normalized = sanitizeSessionRecord(record)
  return {
    tabs: normalized.tabs.length,
    pinned: normalized.tabs.filter((tab) => tab.pinned).length,
    activeIndex: normalized.activeTabId
      ? normalized.tabs.findIndex((tab) => tab.tabId === normalized.activeTabId)
      : -1
  }
}

export function filterSessionByQuery(record: unknown, query: unknown): SessionTabRecord[] {
  const needle = String(query ?? '').toLowerCase()
  const tabs = sanitizeSessionRecord(record).tabs
  return needle ? tabs.filter((tab) => tab.url.toLowerCase().includes(needle)) : tabs
}

export function mergeSessions(first: unknown, second: unknown): SessionRecord {
  const left = sanitizeSessionRecord(first)
  const right = sanitizeSessionRecord(second)
  return sanitizeSessionRecord({
    version: left.version ?? right.version,
    savedAt: Math.max(left.savedAt ?? 0, right.savedAt ?? 0),
    activeTabId: left.activeTabId ?? right.activeTabId,
    tabs: left.tabs.concat(right.tabs)
  })
}

export function dedupeSessionTabs(record: unknown): SessionTabRecord[] {
  const seen = new Set<string>()
  const output: SessionTabRecord[] = []
  for (const tab of sanitizeSessionRecord(record).tabs) {
    const key = stripUrl(tab.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(tab)
  }
  return output
}

export function hasTabsForHost(record: unknown, host: unknown): boolean {
  const needle = String(host ?? '').toLowerCase()
  return Boolean(needle) && sanitizeSessionRecord(record).tabs.some(
    (tab) => hostOfUrl(tab.url).toLowerCase() === needle
  )
}

export function suggestSessionName(
  tabUrls: readonly unknown[] | null | undefined,
  { emptyLabel = '空会话' }: SuggestSessionNameOptions = {}
): string {
  const urls = Array.isArray(tabUrls) ? tabUrls : []
  if (urls.length === 0) return emptyLabel

  const counts = new Map<string, number>()
  for (const url of urls) {
    const host = hostOfUrl(url)
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host
      bestCount = count
    }
  }
  if (!best) return emptyLabel
  const top = best.replace(/^www\./, '')
  return urls.length === 1 ? top : `${top} 等 ${urls.length} 个标签页`
}

export function sessionAgeLabel(savedAt: unknown, nowTs?: unknown): string {
  const timestamp = savedAt == null ? 0 : Number(savedAt)
  const now = nowTs == null ? Date.now() : Number(nowTs)
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const today = day.getTime()
  const dayMs = 24 * 60 * 60 * 1000
  if (timestamp >= today) return '今天'
  if (timestamp >= today - dayMs) return '昨天'
  return '更早'
}

/** 截断会话，固定标签优先；普通标签从尾部丢弃。 */
export function capSessionTabs(record: unknown, maxTabs: unknown): SessionRecord {
  const normalized = sanitizeSessionRecord(record)
  const numericLimit = Number(maxTabs)
  const limit = Number.isFinite(numericLimit) && numericLimit > 0 ? Math.floor(numericLimit) : 0
  const pinned = normalized.tabs.filter((tab) => tab.pinned)
  const plain = normalized.tabs.filter((tab) => !tab.pinned)
  const tabs = pinned.concat(plain.slice(0, Math.max(0, limit - pinned.length)))
  const activeTabId = tabs.some((tab) => tab.tabId === normalized.activeTabId)
    ? normalized.activeTabId
    : null
  return { ...normalized, tabs, activeTabId }
}
