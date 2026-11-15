import { parseSessionFile } from './schema'
import { toRecord, toRestorePlan } from './sessionStore'
import {
  MIN_STACK_MEMBERS,
  capSessionTabs,
  dedupeSessionTabs,
  isRestorable,
  sanitizeSessionRecord,
  sessionStats
} from './sessionUtil'
import type {
  CreateSessionServiceOptions,
  NewSessionTabInput,
  ParsedSessionRecord,
  PersistableTab,
  SessionService,
  SessionSummary,
  SessionTabPort,
  StackCreateInput
} from './types'

export const DEFAULT_FILE_NAME = 'session.json'
export const DEFAULT_RESTORE_CAP = 200

function tabsForPersist(tabPort: SessionTabPort): readonly PersistableTab[] {
  return typeof tabPort.listForPersist === 'function'
    ? tabPort.listForPersist()
    : tabPort.list()
}

/** 会话保存、恢复及摘要的领域服务；所有 IO 与标签操作均由端口注入。 */
export function createSessionService(options: CreateSessionServiceOptions = {}): SessionService {
  const {
    filePort,
    fileName = DEFAULT_FILE_NAME,
    logger,
    isExpiredTab
  } = options
  if (!filePort) {
    throw new Error('[domain-session] filePort is required (inject @hira-ng/infra-fs#createFilePort)')
  }
  const port = filePort
  const warn = (message: string): void => {
    if (logger && typeof logger.warn === 'function') logger.warn(message)
    else console.warn(message)
  }
  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  function sessionPath(dir: string): string {
    return port.join(dir, fileName)
  }

  function exists(dir: string): boolean {
    try {
      return port.existsSync(sessionPath(dir))
    } catch {
      return false
    }
  }

  function read(dir: string): ParsedSessionRecord | null {
    const file = sessionPath(dir)
    try {
      if (!port.existsSync(file)) return null
      const parsed = parseSessionFile(port.readJsonSync(file))
      if (!parsed) return null
      return {
        ...sanitizeSessionRecord(parsed),
        version: parsed.version,
        savedAt: parsed.savedAt
      } as ParsedSessionRecord
    } catch (error) {
      warn(`[session] read failed: ${errorMessage(error)}`)
      return null
    }
  }

  function snapshot(dir: string, tabPort: SessionTabPort): boolean {
    const record = toRecord(
      tabsForPersist(tabPort),
      tabPort.getActiveTabId(),
      Date.now(),
      tabPort.listStacks?.(),
      tabPort.listSplits?.(),
      tabPort.listGlances?.()
    )
    port.writeJsonAtomicSync(sessionPath(dir), record, { space: 2 })
    return true
  }

  function save(dir: string, tabPort: SessionTabPort): boolean {
    try {
      return snapshot(dir, tabPort)
    } catch (error) {
      warn(`[session] save failed: ${errorMessage(error)}`)
      return false
    }
  }

  async function saveAsync(dir: string, tabPort: SessionTabPort): Promise<boolean> {
    try {
      const record = toRecord(
        tabsForPersist(tabPort),
        tabPort.getActiveTabId(),
        Date.now(),
        tabPort.listStacks?.(),
        tabPort.listSplits?.(),
        tabPort.listGlances?.()
      )
      await port.writeJsonAtomic(sessionPath(dir), record, { space: 2 })
      return true
    } catch (error) {
      warn(`[session] saveAsync failed: ${errorMessage(error)}`)
      return false
    }
  }

  async function restore(dir: string, tabPort: SessionTabPort) {
    const record = read(dir)
    if (!isRestorable(record)) return { restored: false }

    let source = sanitizeSessionRecord(record)
    if (typeof isExpiredTab === 'function') {
      const now = Date.now()
      const kept = source.tabs.filter((tab) => {
        try {
          return !isExpiredTab(tab, now)
        } catch {
          return true
        }
      })
      if (kept.length !== source.tabs.length) {
        if (kept.length === 0) return { restored: false }
        source = { ...source, tabs: kept }
      }
    }

    const capped = capSessionTabs(source, DEFAULT_RESTORE_CAP)
    const trimmed = capped.tabs.length < source.tabs.length
    const normalized = sanitizeSessionRecord(capped)
    const tabs = dedupeSessionTabs(normalized)
    const activeTabId = normalized.activeTabId && tabs.some((tab) => tab.tabId === normalized.activeTabId)
      ? normalized.activeTabId
      : null
    const plan = toRestorePlan({ ...normalized, tabs, activeTabId })
    if (plan.tabs.length === 0) return { restored: false }

    try {
      let restoredActiveId: string | null = null
      const restoredIds = new Map<string, string>()
      for (let index = 0; index < plan.tabs.length; index++) {
        const tab = plan.tabs[index]
        const sourceTab = tabs[index]
        const input: NewSessionTabInput = {
          url: tab.url,
          pinned: Boolean(tab.pinned && !sourceTab.stackId),
          muted: tab.muted,
          lastActivated: tab.lastActivated,
          position: tab.position,
          title: tab.title,
          favicon: tab.favicon,
          openInBackground: true,
          sleeping: true,
          navHistory: tab.navHistory,
          navHistoryIndex: tab.navHistoryIndex
        }
        const created = await tabPort.newTab(input)
        const createdId = created && created.tabId != null ? String(created.tabId) : null
        if (createdId) restoredIds.set(sourceTab.tabId, createdId)
        if (index === plan.activeIndex && createdId) restoredActiveId = createdId
      }

      if (typeof tabPort.createStack === 'function') {
        for (const stack of normalized.stacks) {
          const tabIds = tabs
            .filter((tab) => tab.stackId === stack.stackId)
            .map((tab) => restoredIds.get(tab.tabId))
            .filter((id): id is string => Boolean(id))
          if (tabIds.length >= MIN_STACK_MEMBERS || stack.pinned) {
            const payload: StackCreateInput = {
              tabIds,
              label: stack.label,
              accent: stack.accent,
              collapsed: stack.collapsed
            }
            if (stack.pinned) payload.pinned = true
            tabPort.createStack(payload)
          }
        }
        if (typeof tabPort.adoptPinnedTabs === 'function') tabPort.adoptPinnedTabs()
      }

      // 速览必须先于分屏恢复，才能复用运行期“分屏优先”的冲突裁剪规则。
      if (typeof tabPort.createGlance === 'function') {
        for (const glance of normalized.glances) {
          const tabIds = glance.members
            .map((oldId) => restoredIds.get(oldId))
            .filter((id): id is string => Boolean(id))
          if (tabIds.length !== 2) continue
          const frontRestored = glance.frontTabId ? restoredIds.get(glance.frontTabId) : undefined
          tabPort.createGlance({
            tabIds,
            frontTabId: frontRestored && tabIds.includes(frontRestored) ? frontRestored : undefined
          })
        }
      }

      if (typeof tabPort.createSplit === 'function') {
        for (const split of normalized.splits) {
          const tabIds = split.members
            .map((oldId) => restoredIds.get(oldId))
            .filter((id): id is string => Boolean(id))
          if (tabIds.length < 2) continue
          const activeRestored = split.activeTabId ? restoredIds.get(split.activeTabId) : undefined
          tabPort.createSplit({
            tabIds,
            layout: split.layout,
            ratios: split.ratios,
            activeTabId: activeRestored && tabIds.includes(activeRestored) ? activeRestored : undefined
          })
        }
      }

      if (restoredActiveId) {
        tabPort.switchTo(restoredActiveId)
      } else {
        const all = tabPort.list()
        if (all.length > 0) tabPort.switchTo(String(all[0].tabId))
      }

      return { restored: true, activeTabId: restoredActiveId, trimmed }
    } catch (error) {
      warn(`[session] restore failed: ${errorMessage(error)}`)
      return { restored: false }
    }
  }

  function stats(dir: string) {
    return sessionStats(read(dir))
  }

  function summary(dir: string, { limit = 4 }: { limit?: number } = {}): SessionSummary {
    const empty: SessionSummary = { exists: false, savedAt: 0, tabs: 0, pinned: 0, items: [] }
    const take = Math.max(0, Number(limit) || 0)
    try {
      const file = sessionPath(dir)
      if (!port.existsSync(file)) return empty
      const record = parseSessionFile(port.readJsonSync(file))
      if (!record || record.tabs.length === 0) return empty
      return {
        exists: true,
        savedAt: record.savedAt || 0,
        tabs: record.tabs.length,
        pinned: record.tabs.filter((tab) => tab.pinned).length,
        items: record.tabs.slice(0, take).map((tab) => ({
          title: tab.title || '',
          url: tab.url,
          favicon: tab.favicon || ''
        }))
      }
    } catch (error) {
      warn(`[session] summary failed: ${errorMessage(error)}`)
      return empty
    }
  }

  function clear(dir: string): boolean {
    try {
      port.writeJsonAtomicSync(sessionPath(dir), toRecord([], null, Date.now()), { space: 2 })
      return true
    } catch {
      return false
    }
  }

  return { sessionPath, exists, read, save, saveAsync, restore, stats, summary, clear }
}
