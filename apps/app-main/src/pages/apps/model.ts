export type PwaInstallKind = 'full' | 'shortcut'
export type PwaUpdateState = 'idle' | 'available' | 'error'

export interface InstalledApp {
  id: string
  name: string
  shortName?: string | null
  startUrl: string
  scope?: string | null
  display?: string | null
  themeColor?: string | null
  backgroundColor?: string | null
  iconUrl?: string | null
  installKind?: PwaInstallKind | string | null
  source?: string | null
  hasStartMenuShortcut?: boolean
  hasDesktopShortcut?: boolean
  runOnStartup?: boolean
  updateState?: PwaUpdateState | string | null
  lastCheckedAt?: number | null
  lastLaunchedAt?: number | null
  launchCount?: number | null
  createdAt?: number | null
  updatedAt?: number | null
}

export interface InstallKindMeta {
  label: string
  updatable: boolean
  updateHint: string
}

export const INSTALL_KINDS: Readonly<Record<string, InstallKindMeta>> = Object.freeze({
  full: Object.freeze({ label: '应用', updatable: true, updateHint: '' }),
  shortcut: Object.freeze({
    label: '快捷方式',
    updatable: false,
    updateHint: '快捷方式没有可检查的站点清单'
  })
})

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalText(value: unknown): string | null {
  return text(value) || null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readInstalledApps(value: unknown): InstalledApp[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const apps: InstalledApp[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = text(item.id)
    const startUrl = text(item.startUrl)
    if (!id || !startUrl || seen.has(id)) continue
    seen.add(id)
    apps.push({
      ...item,
      id,
      name: text(item.name) || text(item.shortName) || startUrl,
      shortName: optionalText(item.shortName),
      startUrl,
      iconUrl: optionalText(item.iconUrl),
      installKind: text(item.installKind) || 'full',
      source: optionalText(item.source),
      hasStartMenuShortcut: item.hasStartMenuShortcut === true,
      hasDesktopShortcut: item.hasDesktopShortcut === true,
      runOnStartup: item.runOnStartup === true,
      updateState: text(item.updateState) || 'idle',
      lastCheckedAt: optionalNumber(item.lastCheckedAt),
      lastLaunchedAt: optionalNumber(item.lastLaunchedAt),
      launchCount: optionalNumber(item.launchCount),
      createdAt: optionalNumber(item.createdAt),
      updatedAt: optionalNumber(item.updatedAt)
    })
  }
  return apps
}

export function kindOf(app: InstalledApp): InstallKindMeta {
  const id = String(app.installKind || '')
  return INSTALL_KINDS[id] || Object.freeze({
    label: id || '应用',
    updatable: false,
    updateHint: '此应用类型暂不支持检查更新'
  })
}

export function sourceLabel(app: InstalledApp): string {
  if (app.source === 'shortcut') return '页面快捷方式'
  if (app.source === 'manifest') return '站点清单'
  return '未知来源'
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url
  }
}

export function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function filterApps(apps: readonly InstalledApp[], query: string): InstalledApp[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...apps]
  return apps.filter((app) => {
    const fields = [app.name, app.shortName, app.startUrl, hostLabel(app.startUrl)]
    return fields.some((field) => String(field || '').toLowerCase().includes(needle))
  })
}

export function appSignature(apps: readonly InstalledApp[]): string {
  return apps.map((app) => [
    app.id,
    app.name,
    app.shortName,
    app.startUrl,
    app.iconUrl,
    app.installKind,
    app.source,
    app.updateState,
    app.hasDesktopShortcut,
    app.hasStartMenuShortcut,
    app.runOnStartup,
    app.lastCheckedAt,
    app.lastLaunchedAt,
    app.launchCount,
    app.updatedAt
  ].join('\u0001')).join('\u0002')
}

export function actionError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : isRecord(error) && error.message !== undefined
      ? String(error.message)
      : String(error || '')
  if (/no handler|not registered|not found/i.test(raw)) return '该能力尚未就绪，请稍后重试'
  return raw.trim() || '操作失败'
}
