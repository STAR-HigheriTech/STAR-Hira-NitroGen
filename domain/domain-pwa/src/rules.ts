/** Pure PWA identity, URL, scope, shortcut, and installability rules. */

import { createHash } from 'node:crypto'
import { HTTP_PROTOCOLS, isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
import type { NormalizedWebAppManifest, PwaDisplayMode, PwaInstallKind, PwaIcon } from './types'

export { HTTP_PROTOCOLS, isHttpUrl }

export const FULL_DISPLAY_MODES = Object.freeze([
  'standalone',
  'minimal-ui',
  'fullscreen'
]) as readonly PwaDisplayMode[]

export const ICON_MIN_SIZE = 192

const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

export function parseUrl(value: unknown, base?: string | URL): URL | null {
  try {
    return value instanceof URL ? value : new URL(String(value ?? ''), base)
  } catch {
    return null
  }
}

export function isSameOrigin(left: unknown, right: unknown): boolean {
  const leftUrl = parseUrl(left)
  const rightUrl = parseUrl(right)
  return !!leftUrl && !!rightUrl && leftUrl.origin === rightUrl.origin
}

export function defaultScope(startUrl: unknown): string | null {
  const url = parseUrl(startUrl)
  if (!url) return null
  const directory = url.pathname.replace(/[^/]*$/, '')
  return `${url.origin}${directory || '/'}`
}

function normalizeScopePath(pathname: unknown): string {
  const value = String(pathname || '/')
  return value.endsWith('/') ? value : `${value}/`
}

export function isInScope(url: unknown, scope: unknown): boolean {
  const target = parseUrl(url)
  const boundary = parseUrl(scope)
  if (!target || !boundary || target.origin !== boundary.origin) return false
  const scopePath = normalizeScopePath(boundary.pathname)
  return scopePath === '/'
    || target.pathname === scopePath.slice(0, -1)
    || target.pathname.startsWith(scopePath)
}

export function makeAppId(profileId: unknown, startUrl: unknown): string {
  const id = String(profileId || 'default')
  const url = parseUrl(startUrl)
  if (!url) throw new Error('makeAppId 收到非法 start_url')
  url.hash = ''
  const seed = `${id}\n${url.href}`
  return `pwa-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`
}

export function sanitizeShortcutName(name: unknown, fallbackUrl = ''): string {
  let output = String(name ?? '')
    .replace(ILLEGAL_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!output) {
    const url = parseUrl(fallbackUrl)
    output = url ? url.hostname : '应用'
  }
  return output.slice(0, 60).trim() || '应用'
}

export function classifyInstall(manifest: Partial<NormalizedWebAppManifest> | null | undefined): PwaInstallKind {
  if (!manifest || typeof manifest !== 'object') return 'shortcut'
  if (!manifest.name || !isHttpUrl(manifest.startUrl)) return 'shortcut'
  if (!manifest.display || !(FULL_DISPLAY_MODES as readonly string[]).includes(manifest.display)) return 'shortcut'
  const icons: Partial<PwaIcon>[] = Array.isArray(manifest.icons) ? manifest.icons : []
  const hasLargeIcon = icons.some((icon) => {
    const width = Number(icon.width) || 0
    const height = Number(icon.height) || 0
    return Math.min(width, height) >= ICON_MIN_SIZE
  })
  return hasLargeIcon ? 'full' : 'shortcut'
}
