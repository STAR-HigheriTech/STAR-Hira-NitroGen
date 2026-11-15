import {
  PERMISSION_TYPES as SHARED_PERMISSION_TYPES,
  isValidPermissionSetting,
  normalizePermissionSetting
} from '@hira-ng/shared-types/src/permission-labels.mjs'
import type {
  NormalizedPermissionEntry,
  PermissionBatchResult,
  PermissionClassifiedRules,
  PermissionRuleSummary,
  PermissionSetting
} from './types'

/** Pure permission rules. No storage, clock, process, Electron, or filesystem dependency. */
export const KNOWN_TYPES = Object.freeze([...SHARED_PERMISSION_TYPES]) as readonly string[]

const SENSITIVE_TYPES = new Set([
  'camera',
  'microphone',
  'media',
  'geolocation',
  'pointerLock',
  'keyboardLock',
  'midiSysex',
  'hid',
  'serial',
  'usb',
  'bluetooth'
])

const PERMISSION_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  camera: 100,
  microphone: 90,
  media: 85,
  geolocation: 80,
  'display-capture': 75,
  pointerLock: 70,
  'clipboard-read': 65,
  notifications: 60,
  notification: 60,
  'clipboard-sanitized-write': 55,
  'clipboard-write': 54,
  'deprecated-sync-clipboard-read': 54.5,
  mediaKeySystem: 53,
  keyboardLock: 50,
  hid: 45,
  usb: 44,
  serial: 43,
  bluetooth: 42,
  midiSysex: 41,
  midi: 10,
  'idle-detection': 35,
  'storage-access': 34,
  'top-level-storage-access': 33.5,
  'window-management': 33,
  'local-fonts': 32,
  fileSystem: 31,
  sensors: 30,
  'speaker-selection': 29,
  fullscreen: 25,
  openExternal: 24,
  'automatic-downloads': 21,
  popup: 20,
  idleDetection: 18
})

export function normalizeOrigin(origin: unknown): string {
  if (typeof origin !== 'string') return ''
  let host = origin.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  host = host.split(/[/:?#]/)[0]
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) return ''
  host = host.toLowerCase().replace(/^www\./, '').replace(/^\.+|\.+$/g, '')
  return host && host.includes('.') && !host.includes('..') ? host : ''
}

export function isValidPermissionType(
  type: unknown,
  knownTypes?: readonly string[]
): type is string {
  if (typeof type !== 'string' || !type) return false
  const set = knownTypes && knownTypes.length ? knownTypes : KNOWN_TYPES
  return set.includes(type)
}

export const isValidSetting = isValidPermissionSetting as (setting: unknown) => boolean
export const sanitizeSetting = normalizePermissionSetting as (setting: unknown) => PermissionSetting

export function matchesOrigin(origin: unknown, ruleOrigin: unknown): boolean {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) return false
  const rule = typeof ruleOrigin === 'string'
    ? ruleOrigin.trim().toLowerCase().replace(/\.+$/, '')
    : ''
  return !!rule && (normalizedOrigin === rule || normalizedOrigin.endsWith(`.${rule}`))
}

export function classifySiteRules(
  map: unknown,
  knownTypes?: readonly string[]
): PermissionClassifiedRules {
  const result: PermissionClassifiedRules = { allow: [], block: [], ask: [] }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return result
  for (const [type, setting] of Object.entries(map as Record<string, unknown>)) {
    if (!isValidPermissionType(type, knownTypes)) continue
    result[sanitizeSetting(setting)].push(type)
  }
  return result
}

export function summarizeSiteRules(
  map: unknown,
  knownTypes?: readonly string[]
): PermissionRuleSummary {
  const classified = classifySiteRules(map, knownTypes)
  return {
    allow: classified.allow.length,
    block: classified.block.length,
    ask: classified.ask.length
  }
}

export function isSensitivePermission(type: unknown): boolean {
  return typeof type === 'string' && SENSITIVE_TYPES.has(type)
}

export function requestKey(origin: unknown, type: unknown): string {
  return `${normalizeOrigin(origin)}::${typeof type === 'string' ? type : ''}`
}

export function resolveSetting(precedent: unknown, fallback: unknown): PermissionSetting {
  if (isValidSetting(precedent)) return precedent as PermissionSetting
  return isValidSetting(fallback) ? fallback as PermissionSetting : 'ask'
}

export function batchNormalize(
  entries: unknown,
  knownTypes?: readonly string[]
): PermissionBatchResult {
  const valid: NormalizedPermissionEntry[] = []
  const dropped: PermissionBatchResult['dropped'] = []
  if (!Array.isArray(entries)) return { valid, dropped }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      dropped.push({ entry, reason: 'invalid-entry' })
      continue
    }
    const record = entry as Record<string, unknown>
    const origin = normalizeOrigin(record.origin)
    if (!origin) {
      dropped.push({ entry, reason: 'invalid-origin' })
      continue
    }
    if (!isValidPermissionType(record.type, knownTypes)) {
      dropped.push({ entry, reason: 'invalid-type' })
      continue
    }
    valid.push({ origin, type: record.type, setting: sanitizeSetting(record.setting) })
  }
  return { valid, dropped }
}

export function priorityOf(type: unknown): number {
  return typeof type === 'string' ? PERMISSION_PRIORITY[type] || 0 : 0
}
