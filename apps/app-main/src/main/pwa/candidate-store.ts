/**
 * 安装候选缓存 —— 探测（preload 线索）与安装（确认框点"安装"）之间的**唯一交接点**。
 *
 * 为什么需要它：
 *  · 安装必须重新拉 manifest（页面给的只是地址）；拉取是异步的，而用户点安装可能隔几分钟；
 *  · 渲染层只拿得到 `candidateId`，拿不到 manifest 本身（避免把大对象透传给 UI）；
 *  · 候选必须与 profile / tab 绑定：A 窗口的候选不能在 B 窗口装。
 *
 * 纪律：
 *  · TTL 10 分钟，过期即视为"请刷新页面重试"；
 *  · 同一 tab 只保留最新一份（页面跳转后旧候选立刻作废）；
 *  · 纯内存，不落库 —— 进程重启后重新探测即可。
 */

import { randomUUID } from 'node:crypto'
import type { NormalizedWebAppManifest, PwaIcon } from '@hira-ng/domain-pwa'

export const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 512

export interface PwaCandidate {
  appId?: string
  candidateId?: string
  kind?: 'full' | 'shortcut'
  profileId?: string
  documentUrl?: string
  manifestUrl?: string | null
  title?: string
  name?: string
  shortName?: string | null
  startUrl?: string
  scope?: string | null
  display?: string
  themeColor?: string | null
  backgroundColor?: string | null
  icons?: PwaIcon[]
  faviconUrl?: string | null
  manifest?: NormalizedWebAppManifest | null
  detectedAt?: number
  [key: string]: unknown
}

export interface CandidateEntry {
  id: string
  tabId: string
  profileId: string
  candidate: PwaCandidate
  createdAt: number
}

interface CandidateStoreOptions {
  ttlMs?: number
  maxEntries?: number
  now?(): number
}

export interface CandidateStore {
  readonly ttlMs: number
  put(input: { tabId: unknown; profileId: unknown; candidate: PwaCandidate | null | undefined }): CandidateEntry | null
  get(id: unknown): CandidateEntry | null
  getForTab(tabId: unknown): CandidateEntry | null
  remove(id: unknown): CandidateEntry | null
  clearTab(tabId: unknown): CandidateEntry | null
  clearProfile(profileId: unknown): void
  clearAll(): void
  sweep(): void
  readonly size: number
}

/**
 * @param {{ ttlMs?: number, now?: () => number }} options
 */
export function createCandidateStore(options: CandidateStoreOptions = {}): CandidateStore {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS
  const maxEntries = Number(options.maxEntries) > 0
    ? Math.max(1, Math.floor(Number(options.maxEntries)))
    : DEFAULT_MAX_ENTRIES
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  const byId = new Map<string, CandidateEntry>()
  const byTab = new Map<string, string>()

  function isExpired(entry: CandidateEntry | null | undefined): boolean {
    return !entry || now() - entry.createdAt > ttlMs
  }

  function drop(id: string): CandidateEntry | null {
    const entry = byId.get(id)
    if (!entry) return null
    byId.delete(id)
    if (byTab.get(entry.tabId) === id) byTab.delete(entry.tabId)
    return entry
  }

  function sweep(): void {
    for (const [id, entry] of byId) {
      if (isExpired(entry)) drop(id)
    }
  }

  function evictOldest(): void {
    while (byId.size >= maxEntries) {
      const oldest = byId.keys().next()
      if (oldest.done) break
      drop(oldest.value)
    }
  }

  /**
   * 写入候选。同一 tab 的旧候选立即作废（页面已导航 / manifest 已变化）。
   * @param {{ tabId: string, profileId: string, candidate: object }} input
   */
  function put({ tabId, profileId, candidate }: { tabId: unknown; profileId: unknown; candidate: PwaCandidate | null | undefined }): CandidateEntry | null {
    sweep()
    const t = String(tabId || '')
    if (!t || !candidate) return null
    const previous = byTab.get(t)
    if (previous) drop(previous)
    evictOldest()
    const entry = {
      id: randomUUID(),
      tabId: t,
      profileId: String(profileId || 'default'),
      candidate,
      createdAt: now()
    }
    byId.set(entry.id, entry)
    byTab.set(t, entry.id)
    return entry
  }

  function get(id: unknown): CandidateEntry | null {
    const entry = byId.get(String(id || ''))
    if (!entry) return null
    if (isExpired(entry)) { drop(entry.id); return null }
    return entry
  }

  function getForTab(tabId: unknown): CandidateEntry | null {
    const id = byTab.get(String(tabId || ''))
    return id ? get(id) : null
  }

  function remove(id: unknown): CandidateEntry | null {
    return drop(String(id || '')) || null
  }

  function clearTab(tabId: unknown): CandidateEntry | null {
    const id = byTab.get(String(tabId || ''))
    return id ? drop(id) : null
  }

  function clearProfile(profileId: unknown): void {
    const pid = String(profileId || 'default')
    for (const [id, entry] of byId) {
      if (entry.profileId === pid) drop(id)
    }
  }

  function clearAll(): void {
    byId.clear()
    byTab.clear()
  }

  return {
    ttlMs,
    put,
    get,
    getForTab,
    remove,
    clearTab,
    clearProfile,
    clearAll,
    sweep,
    get size() { return byId.size }
  }
}

