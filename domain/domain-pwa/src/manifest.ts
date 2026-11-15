/** Pure Web App Manifest normalization and icon selection. */

import { defaultScope, isHttpUrl, isInScope, isSameOrigin, parseUrl } from './rules'
import type {
  NormalizeManifestContext,
  NormalizedWebAppManifest,
  PwaIcon,
  PwaIconSize,
  PwaManifestSnapshot,
  RawWebAppManifest
} from './types'

export const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]{3,20})$/i

const ICON_TYPE_RANK: Readonly<Record<string, number>> = Object.freeze({
  'image/png': 0,
  'image/webp': 1,
  'image/jpeg': 2,
  'image/svg+xml': 3
})

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function cleanString(value: unknown, maxLength = 200): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : ''
}

export function cleanColor(value: unknown): string | null {
  const color = cleanString(value, 64)
  return color && COLOR_RE.test(color) ? color : null
}

export function parseSizes(sizes: unknown): PwaIconSize[] {
  const raw = cleanString(sizes, 120).toLowerCase()
  if (!raw) return []
  if (raw.split(/\s+/).includes('any')) return [{ any: true }]

  const sizesOut: PwaIconSize[] = []
  for (const token of raw.split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(token)
    if (!match) continue
    const width = Number(match[1])
    const height = Number(match[2])
    if (width > 0 && height > 0) sizesOut.push({ width, height })
  }
  return sizesOut
}

function iconMime(icon: UnknownRecord): string {
  const declared = cleanString(icon.type, 64).toLowerCase()
  if (declared) return declared
  const source = cleanString(icon.src, 2048).split('?')[0].toLowerCase()
  if (source.endsWith('.svg')) return 'image/svg+xml'
  if (source.endsWith('.webp')) return 'image/webp'
  if (source.endsWith('.jpg') || source.endsWith('.jpeg')) return 'image/jpeg'
  if (source.endsWith('.ico')) return 'image/x-icon'
  return 'image/png'
}

export function normalizeIcons(rawIcons: unknown, baseUrl: string): PwaIcon[] {
  if (!Array.isArray(rawIcons)) return []
  const icons: PwaIcon[] = []

  for (const raw of rawIcons) {
    if (!isRecord(raw)) continue
    const sourceRaw = cleanString(raw.src, 2048)
    if (!sourceRaw) continue

    let source: string | null = null
    if (/^data:image\//i.test(sourceRaw)) {
      if (sourceRaw.length <= 700_000) source = sourceRaw
    } else {
      const resolved = parseUrl(sourceRaw, baseUrl)
      if (resolved && isHttpUrl(resolved)) source = resolved.href
    }
    if (!source) continue

    const type = iconMime(raw)
    const purpose = cleanString(raw.purpose, 64).toLowerCase()
    const sizes = parseSizes(raw.sizes)
    for (const size of sizes.length ? sizes : [{ any: true } as const]) {
      icons.push({
        src: source,
        type,
        purpose,
        width: 'any' in size ? 0 : size.width,
        height: 'any' in size ? 0 : size.height,
        any: 'any' in size
      })
    }
  }
  return icons
}

export function resolveStartUrl(raw: RawWebAppManifest, baseUrl: string, documentUrl: string): string | null {
  const value = cleanString(raw.start_url, 2048) || documentUrl
  const url = parseUrl(value, baseUrl)
  return url ? url.href : null
}

export function resolveScope(raw: RawWebAppManifest, startUrl: string, baseUrl: string): string | null {
  const value = cleanString(raw.scope, 2048)
  if (value) {
    const url = parseUrl(value, baseUrl)
    if (url && url.origin === parseUrl(startUrl)?.origin) {
      const scope = url.href.endsWith('/') ? url.href : `${url.href}/`
      if (isInScope(startUrl, scope)) return scope
    }
  }
  return defaultScope(startUrl)
}

export function resolveAppName(manifest: RawWebAppManifest | null | undefined, pageTitle: unknown, documentUrl: string): string {
  const shortName = cleanString(manifest?.short_name, 40)
  const name = cleanString(manifest?.name, 80)
  if (shortName) return shortName
  if (name) return name
  const title = cleanString(pageTitle, 80)
  if (title) return title
  return parseUrl(documentUrl)?.hostname || '应用'
}

export function normalizeManifest(raw: unknown, context: NormalizeManifestContext): NormalizedWebAppManifest | null {
  if (!isRecord(raw)) return null
  const documentUrl = cleanString(context.documentUrl, 2048)
  if (!isHttpUrl(documentUrl)) return null

  const manifestUrl = isHttpUrl(context.manifestUrl) ? cleanString(context.manifestUrl, 2048) : null
  const baseUrl = manifestUrl || documentUrl
  const source = raw as RawWebAppManifest
  const startUrl = resolveStartUrl(source, baseUrl, documentUrl)
  if (!isHttpUrl(startUrl) || !isSameOrigin(startUrl, documentUrl)) return null

  const display = cleanString(source.display, 32).toLowerCase() || 'browser'
  const themeColor = cleanColor(source.theme_color)
  const backgroundColor = cleanColor(source.background_color)
  const name = resolveAppName(source, context.pageTitle, documentUrl)
  const shortName = cleanString(source.short_name, 40) || null

  return {
    name,
    shortName,
    display,
    startUrl: startUrl!,
    scope: resolveScope(source, startUrl!, baseUrl) || defaultScope(startUrl) || startUrl!,
    themeColor,
    backgroundColor,
    icons: normalizeIcons(source.icons, baseUrl),
    manifestUrl,
    raw: source
  }
}

export function pickBestIcon(
  icons: readonly PwaIcon[] | null | undefined,
  options: { targetSize?: number } = {}
): PwaIcon | null {
  const list = Array.isArray(icons) ? [...icons] : []
  if (!list.length) return null
  const targetSize = Number(options.targetSize) > 0 ? Number(options.targetSize) : 512
  const rankType = (icon: PwaIcon): number => ICON_TYPE_RANK[icon.type] ?? 9
  const sized = list.filter((icon) => !icon.any && icon.width > 0 && icon.height > 0)

  if (sized.length) {
    const enough = sized.filter((icon) => Math.min(icon.width, icon.height) >= targetSize)
    const pool = enough.length ? enough : sized
    pool.sort((left, right) => {
      const areaDifference = enough.length
        ? left.width * left.height - right.width * right.height
        : right.width * right.height - left.width * left.height
      return areaDifference || rankType(left) - rankType(right)
    })
    return pool[0]
  }

  const flexible = list.filter((icon) => icon.any)
  flexible.sort((left, right) => rankType(left) - rankType(right))
  return flexible[0] || null
}

export function toSnapshot(manifest: NormalizedWebAppManifest | null | undefined): PwaManifestSnapshot | null {
  if (!manifest) return null
  return {
    name: manifest.name,
    shortName: manifest.shortName,
    display: manifest.display,
    startUrl: manifest.startUrl,
    scope: manifest.scope,
    themeColor: manifest.themeColor,
    backgroundColor: manifest.backgroundColor,
    icons: manifest.icons.map((icon) => ({
      src: icon.src.length > 2048 ? '' : icon.src,
      type: icon.type,
      width: icon.width,
      height: icon.height,
      any: !!icon.any
    }))
  }
}
