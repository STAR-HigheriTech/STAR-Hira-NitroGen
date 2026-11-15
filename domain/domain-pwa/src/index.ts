/**
 * PWA domain facade: profile-scoped persistence plus pure install/manifest rules.
 * This layer has no Electron, filesystem, network, or UI dependencies.
 */

import { pwaApps } from '@hira-ng/infra-db/schema'
import {
  and as drizzleAnd,
  desc as drizzleDesc,
  eq as drizzleEq
} from 'drizzle-orm'
import * as manifest from './manifest'
import * as rules from './rules'
import type {
  PwaApp,
  PwaChange,
  PwaChangeListener,
  PwaChangeReason,
  PwaCheckedPatch,
  PwaDatabase,
  PwaFlagsPatch,
  PwaInstallKind,
  PwaRecord,
  PwaRemoveResult,
  PwaRow,
  PwaService,
  PwaServiceOptions,
  PwaUpdateState,
  PwaUpsertInput,
  PwaUpsertResult,
  PwaWindowState
} from './types'

export * from './types'
export * from './integrations'
export * from './rules'
export * from './manifest'
export { manifest, rules }

type Condition = unknown
const eq = drizzleEq as unknown as (column: unknown, value: unknown) => Condition
const and = drizzleAnd as unknown as (...conditions: Condition[]) => Condition
const desc = drizzleDesc as unknown as (column: unknown) => unknown

const VALID_INSTALL_KINDS = new Set<PwaInstallKind>(['full', 'shortcut'])
const VALID_UPDATE_STATES = new Set<PwaUpdateState>(['idle', 'available', 'error'])

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

function optionalTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeWindowState(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Remove the hash because it does not change app identity. */
export function normalizeStartUrl(url: unknown): string {
  try {
    const parsed = new URL(String(url || ''))
    parsed.hash = ''
    return parsed.href
  } catch {
    return ''
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function toApp(row: PwaRow | null | undefined): PwaApp | null {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    shortName: row.shortName || null,
    startUrl: row.startUrl,
    scope: row.scope || null,
    display: row.display,
    themeColor: row.themeColor || null,
    backgroundColor: row.backgroundColor || null,
    installKind: row.installKind,
    source: row.source,
    hasIcon: !!row.iconPath,
    hasSmallIcon: !!row.iconSmallPath,
    hasIco: !!row.iconIcoPath,
    hasStartMenuShortcut: !!row.startMenuShortcut,
    hasDesktopShortcut: !!row.desktopShortcut,
    runOnStartup: !!row.runOnStartup,
    windowState: parseJson<PwaWindowState | null>(row.windowState, null),
    updateState: row.updateState,
    lastCheckedAt: row.lastCheckedAt || null,
    lastLaunchedAt: row.lastLaunchedAt || null,
    launchCount: row.launchCount || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function toRecord(row: PwaRow | null | undefined): PwaRecord | null {
  if (!row) return null
  return {
    ...row,
    profileId: row.profileId || 'default',
    windowState: parseJson<PwaWindowState | null>(row.windowState, null)
  }
}

export function createPwaService(db: PwaDatabase, options: PwaServiceOptions = {}): PwaService {
  const database = db
  const now = (): number => Date.now()
  const profileIdPort = typeof options.getProfileId === 'function' ? options.getProfileId : null

  const currentProfile = (): string => {
    if (!profileIdPort) return 'default'
    try {
      const value = profileIdPort()
      return value ? String(value) : 'default'
    } catch {
      return 'default'
    }
  }

  const profileCondition = (): unknown => eq(pwaApps.profileId, currentProfile())
  const changeListeners = new Set<PwaChangeListener>()

  const emitChange = (reason: PwaChangeReason, id: string | null = null): void => {
    const change: PwaChange = { reason, id }
    for (const listener of changeListeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('[pwa-service] change listener error:', error)
      }
    }
  }

  const subscribe = (listener: PwaChangeListener): (() => void) => {
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
    }
  }

  const findRow = (id: unknown): PwaRow | null => {
    const key = String(id ?? '')
    if (!key) return null
    return database
      .select()
      .from(pwaApps)
      .where(and(eq(pwaApps.id, key), profileCondition()))
      .get() || null
  }

  return {
    list(): PwaApp[] {
      return database
        .select()
        .from(pwaApps)
        .where(profileCondition())
        .orderBy(desc(pwaApps.lastLaunchedAt), desc(pwaApps.createdAt))
        .all()
        .map((row) => toApp(row))
        .filter((app): app is PwaApp => app !== null)
    },

    get(id: unknown): PwaApp | null {
      return toApp(findRow(id))
    },

    getRecord(id: unknown): PwaRecord | null {
      return toRecord(findRow(id))
    },

    findByStartUrl(url: unknown): PwaApp | null {
      const startUrl = normalizeStartUrl(url)
      if (!startUrl) return null
      const row = database
        .select()
        .from(pwaApps)
        .where(and(eq(pwaApps.profileId, currentProfile()), eq(pwaApps.startUrl, startUrl)))
        .get() || null
      return toApp(row)
    },

    upsert(input: PwaUpsertInput | null | undefined): PwaUpsertResult {
      if (!isRecord(input)) return { ok: false, reason: '缺少应用记录' }
      const record = input as PwaUpsertInput
      const profileId = currentProfile()
      const startUrl = normalizeStartUrl(record.startUrl)
      if (!startUrl) return { ok: false, reason: 'start_url 非法' }

      const name = String(record.name || '').trim()
      if (!name) return { ok: false, reason: '应用名不能为空' }

      const id = String(record.id || rules.makeAppId(profileId, startUrl))
      const timestamp = now()
      const installKind = VALID_INSTALL_KINDS.has(record.installKind as PwaInstallKind)
        ? record.installKind as PwaInstallKind
        : 'full'

      const derived: Omit<Partial<PwaRow>, 'id' | 'profileId' | 'createdAt'> = {
        name,
        shortName: optionalString(record.shortName),
        startUrl,
        scope: optionalString(record.scope),
        manifestUrl: optionalString(record.manifestUrl),
        manifestJson: typeof record.manifestJson === 'string' ? record.manifestJson : null,
        display: record.display ? String(record.display) : 'standalone',
        themeColor: optionalString(record.themeColor),
        backgroundColor: optionalString(record.backgroundColor),
        iconPath: optionalString(record.iconPath),
        iconSmallPath: optionalString(record.iconSmallPath),
        iconIcoPath: optionalString(record.iconIcoPath),
        installKind,
        source: record.source ? String(record.source) : 'manifest',
        sessionPartition: optionalString(record.sessionPartition),
        updatedAt: timestamp
      }

      const existing = (
        record.id
          ? database
              .select()
              .from(pwaApps)
              .where(and(eq(pwaApps.id, id), eq(pwaApps.profileId, profileId)))
              .get()
          : null
      ) || database
        .select()
        .from(pwaApps)
        .where(and(eq(pwaApps.profileId, profileId), eq(pwaApps.startUrl, startUrl)))
        .get()

      if (existing) {
        database.update(pwaApps).set({
          ...derived,
          startMenuShortcut: record.startMenuShortcut !== undefined
            ? optionalString(record.startMenuShortcut)
            : existing.startMenuShortcut,
          desktopShortcut: record.desktopShortcut !== undefined
            ? optionalString(record.desktopShortcut)
            : existing.desktopShortcut,
          runOnStartup: record.runOnStartup !== undefined
            ? (record.runOnStartup ? 1 : 0)
            : existing.runOnStartup,
          windowState: record.windowState !== undefined
            ? normalizeWindowState(record.windowState)
            : existing.windowState,
          updateState: VALID_UPDATE_STATES.has(record.updateState as PwaUpdateState)
            ? record.updateState as PwaUpdateState
            : 'idle',
          lastCheckedAt: record.lastCheckedAt !== undefined
            ? optionalTimestamp(record.lastCheckedAt)
            : existing.lastCheckedAt
        }).where(eq(pwaApps.id, existing.id)).run()
        emitChange('update', existing.id)
        return { ok: true, app: toApp(findRow(existing.id))!, created: false }
      }

      const row: PwaRow = {
        id,
        profileId,
        name,
        shortName: derived.shortName ?? null,
        startUrl,
        scope: derived.scope ?? null,
        manifestUrl: derived.manifestUrl ?? null,
        manifestJson: derived.manifestJson ?? null,
        display: derived.display ?? 'standalone',
        themeColor: derived.themeColor ?? null,
        backgroundColor: derived.backgroundColor ?? null,
        iconPath: derived.iconPath ?? null,
        iconSmallPath: derived.iconSmallPath ?? null,
        iconIcoPath: derived.iconIcoPath ?? null,
        installKind,
        source: derived.source ?? 'manifest',
        sessionPartition: derived.sessionPartition ?? null,
        startMenuShortcut: optionalString(record.startMenuShortcut),
        desktopShortcut: optionalString(record.desktopShortcut),
        runOnStartup: record.runOnStartup ? 1 : 0,
        windowState: normalizeWindowState(record.windowState),
        updateState: VALID_UPDATE_STATES.has(record.updateState as PwaUpdateState)
          ? record.updateState as PwaUpdateState
          : 'idle',
        lastCheckedAt: optionalTimestamp(record.lastCheckedAt),
        lastLaunchedAt: optionalTimestamp(record.lastLaunchedAt),
        launchCount: typeof record.launchCount === 'number' && Number.isFinite(record.launchCount)
          ? record.launchCount
          : 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }

      database.insert(pwaApps).values(row).run()
      emitChange('install', id)
      return { ok: true, app: toApp(findRow(id))!, created: true }
    },

    remove(id: unknown): PwaRemoveResult {
      const row = findRow(id)
      if (!row) return { ok: false, reason: '应用不存在' }
      database.delete(pwaApps).where(and(eq(pwaApps.id, row.id), profileCondition())).run()
      emitChange('uninstall', row.id)
      return { ok: true, record: toRecord(row)! }
    },

    touchLaunched(id: unknown): PwaApp | null {
      const row = findRow(id)
      if (!row) return null
      const timestamp = now()
      database.update(pwaApps).set({
        lastLaunchedAt: timestamp,
        launchCount: (row.launchCount || 0) + 1,
        updatedAt: timestamp
      }).where(eq(pwaApps.id, row.id)).run()
      return toApp(findRow(id))
    },

    markChecked(id: unknown, patch: PwaCheckedPatch = {}): PwaApp | null {
      const row = findRow(id)
      if (!row) return null
      const updateState = VALID_UPDATE_STATES.has(patch.updateState as PwaUpdateState)
        ? patch.updateState as PwaUpdateState
        : row.updateState
      database.update(pwaApps).set({
        updateState,
        lastCheckedAt: optionalTimestamp(patch.lastCheckedAt) || now(),
        updatedAt: now()
      }).where(eq(pwaApps.id, row.id)).run()
      return toApp(findRow(id))
    },

    setFlags(id: unknown, flags: PwaFlagsPatch = {}): PwaApp | null {
      const row = findRow(id)
      if (!row) return null
      const next: Partial<PwaRow> = { updatedAt: now() }
      if (flags.runOnStartup !== undefined) next.runOnStartup = flags.runOnStartup ? 1 : 0
      if (flags.startMenuShortcut !== undefined) next.startMenuShortcut = optionalString(flags.startMenuShortcut)
      if (flags.desktopShortcut !== undefined) next.desktopShortcut = optionalString(flags.desktopShortcut)
      database.update(pwaApps).set(next).where(eq(pwaApps.id, row.id)).run()
      emitChange('flags', row.id)
      return toApp(findRow(row.id))
    },

    setWindowState(id: unknown, state: unknown): boolean | null {
      const row = findRow(id)
      if (!row) return null
      database.update(pwaApps).set({ windowState: normalizeWindowState(state) }).where(eq(pwaApps.id, row.id)).run()
      return true
    },

    setSessionPartition(id: unknown, partition: unknown): PwaApp | null {
      const row = findRow(id)
      if (!row) return null
      database.update(pwaApps).set({
        sessionPartition: optionalString(partition),
        updatedAt: now()
      }).where(eq(pwaApps.id, row.id)).run()
      return toApp(findRow(row.id))
    },

    subscribe
  }
}
