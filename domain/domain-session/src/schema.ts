import { z } from 'zod'
import type { ParsedSessionRecord, SessionTabRecord } from './types'

/** 会话文件格式版本。新增可选字段不升级；改变既有字段语义时必须升级。 */
export const SESSION_VERSION = 4

export const SessionNavEntrySchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  pageState: z.string().optional()
})

export const SessionTabSchema = z.object({
  tabId: z.string().min(1),
  profileId: z.string().min(1).optional(),
  spaceId: z.string().min(1).optional(),
  url: z.string().min(1),
  pinned: z.boolean().default(false),
  stackId: z.string().min(1).nullable().optional(),
  splitId: z.string().min(1).nullable().optional(),
  glanceId: z.string().min(1).nullable().optional(),
  navHistory: z.array(SessionNavEntrySchema).optional(),
  navHistoryIndex: z.number().int().nonnegative().optional(),
  muted: z.boolean().default(false),
  lastActivated: z.number().int().nonnegative().optional(),
  position: z.number().optional(),
  title: z.string().optional(),
  favicon: z.string().optional()
})

export const SessionStackSchema = z.object({
  stackId: z.string().min(1),
  label: z.string().default(''),
  accent: z.string().default(''),
  collapsed: z.boolean().default(false),
  pinned: z.boolean().default(false)
})

export const SessionSplitSchema = z.object({
  splitId: z.string().min(1),
  layout: z.string().default('row'),
  ratios: z.array(z.number()).default([]),
  members: z.array(z.string()).default([]),
  activeTabId: z.string().min(1).nullable().optional()
})

export const SessionGlanceSchema = z.object({
  glanceId: z.string().min(1),
  members: z.array(z.string()).default([]),
  frontTabId: z.string().min(1).nullable().optional()
})

export const SessionFileSchema = z.object({
  version: z.number().int().positive().default(SESSION_VERSION),
  savedAt: z.number().int().nonnegative().default(0),
  activeTabId: z.string().min(1).nullable().default(null),
  tabs: z.array(z.unknown()).default([]),
  stacks: z.array(z.unknown()).default([]),
  splits: z.array(z.unknown()).default([]),
  glances: z.array(z.unknown()).default([])
})

type SessionNavEntry = z.infer<typeof SessionNavEntrySchema>
export type SessionTab = z.infer<typeof SessionTabSchema>
export type SessionStack = z.infer<typeof SessionStackSchema>
export type SessionSplit = z.infer<typeof SessionSplitSchema>
export type SessionGlance = z.infer<typeof SessionGlanceSchema>
export type SessionFile = z.infer<typeof SessionFileSchema>

/** 宽进严出：坏的单条记录只丢自身，始终保留其余可恢复数据。 */
export function parseSessionFile(raw: unknown): ParsedSessionRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const outer = SessionFileSchema.safeParse(raw)
  if (!outer.success) return null
  const head = outer.data

  const tabs: SessionTab[] = []
  for (const item of head.tabs) {
    const parsed = SessionTabSchema.safeParse(item)
    if (parsed.success) tabs.push(parsed.data)
  }
  if (tabs.length === 0) return null

  const stackIds = new Set(
    tabs
      .map((tab) => tab.stackId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
  const stacks: SessionStack[] = []
  for (const item of head.stacks) {
    const parsed = SessionStackSchema.safeParse(item)
    if (!parsed.success) continue
    if (!parsed.data.pinned && !stackIds.has(parsed.data.stackId)) continue
    stacks.push(parsed.data)
  }
  const validStackIds = new Set(stacks.map((stack) => stack.stackId))
  for (const tab of tabs) {
    if (tab.stackId && !validStackIds.has(tab.stackId)) tab.stackId = null
  }

  const splitIds = new Set(
    tabs
      .map((tab) => tab.splitId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
  const splits: SessionSplit[] = []
  for (const item of head.splits) {
    const parsed = SessionSplitSchema.safeParse(item)
    if (!parsed.success || !splitIds.has(parsed.data.splitId)) continue
    const members = tabs
      .filter((tab) => tab.splitId === parsed.data.splitId)
      .map((tab) => tab.tabId)
    if (members.length < 2) continue
    splits.push({
      ...parsed.data,
      members,
      activeTabId: parsed.data.activeTabId ?? null
    })
  }
  const validSplitIds = new Set(splits.map((split) => split.splitId))
  for (const tab of tabs) {
    if (tab.splitId && !validSplitIds.has(tab.splitId)) tab.splitId = null
  }

  const glanceIds = new Set(
    tabs
      .map((tab) => tab.glanceId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )
  const glances: SessionGlance[] = []
  for (const item of head.glances) {
    const parsed = SessionGlanceSchema.safeParse(item)
    if (!parsed.success || !glanceIds.has(parsed.data.glanceId)) continue
    const members = tabs
      .filter((tab) => tab.glanceId === parsed.data.glanceId)
      .map((tab) => tab.tabId)
    if (members.length !== 2) continue
    const front = parsed.data.frontTabId
    glances.push({
      ...parsed.data,
      members,
      frontTabId: front && members.includes(front) ? front : members[members.length - 1]
    })
  }
  const validGlanceIds = new Set(glances.map((glance) => glance.glanceId))
  for (const tab of tabs) {
    if (tab.glanceId && !validGlanceIds.has(tab.glanceId)) tab.glanceId = null
  }

  const activeTabId = head.activeTabId && tabs.some((tab) => tab.tabId === head.activeTabId)
    ? head.activeTabId
    : null

  return {
    version: head.version,
    savedAt: head.savedAt,
    activeTabId,
    tabs: tabs as SessionTabRecord[],
    stacks,
    splits,
    glances
  }
}
