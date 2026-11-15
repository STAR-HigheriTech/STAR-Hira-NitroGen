/** Shared contracts for the pure tab-domain rules. */
export type TabId = string | number

export interface TabRecord {
  tabId: TabId
  pinned?: boolean
  sleeping?: boolean
  audio?: boolean
  isAudioPlaying?: boolean
  active?: boolean
  lastActivated?: number
  stackId?: TabId | null
  splitId?: TabId | null
  glanceId?: TabId | null
  [key: string]: unknown
}

export interface StackRecord {
  stackId: string
  label: string
  accent: string
  collapsed: boolean
  pinned: boolean
  [key: string]: unknown
}

export interface StackView extends StackRecord {
  count: number
  children: string[]
}

export type SplitLayout = 'row' | 'column' | 'grid'

export interface SplitRecord {
  splitId: string
  layout: SplitLayout
  members: string[]
  ratios: number[]
  activeTabId: string | null
  [key: string]: unknown
}

export interface GlanceRecord {
  glanceId: string
  members: string[]
  frontTabId: string
  [key: string]: unknown
}

export interface StackMutationResult {
  tabs: TabRecord[]
  stacks: StackRecord[]
  [key: string]: unknown
}

export interface SplitMutationResult {
  tabs: TabRecord[]
  splits: SplitRecord[]
  [key: string]: unknown
}

export interface GlanceMutationResult {
  tabs: TabRecord[]
  glances: GlanceRecord[]
  [key: string]: unknown
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function isTabRecord(value: unknown): value is TabRecord {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>).tabId != null
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function tabRecords(value: unknown): TabRecord[] {
  return Array.isArray(value) ? value.filter(isTabRecord) : []
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : []
}
