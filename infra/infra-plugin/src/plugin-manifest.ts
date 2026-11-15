import fs from 'node:fs'
import path from 'node:path'
import { SCOPE_PERMISSIONS, type PermissionLevel } from './plugin-sandbox'
import type { UnknownRecord } from './types'
import {
  panelUiFromManifest,
  isRenderModulePath,
  renderEntryCandidates,
  resolvePluginType
} from '@hira-ng/shared-types/src/plugin-ui'
import type {
  PluginHealthCheck,
  PluginManifest,
  PluginPublisherTrustLevel
} from '@hira-ng/shared-types/src/plugin-core'
import { isPluginId } from '@hira-ng/shared-types/src/plugin-id'

export type { PluginHealthCheck, PluginManifest } from '@hira-ng/shared-types/src/plugin-core'

export interface NormalizeManifestOptions {
  defaultTrustLevel?: PluginPublisherTrustLevel
  allowFirstParty?: boolean
}

const isRecord = (value: unknown): value is UnknownRecord => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : []
const finitePositive = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
const boundedNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, finitePositive(value, fallback)))
const MAX_MANIFEST_BYTES = 1024 * 1024

function pickText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  for (const key of ['zh-CN', 'zh', 'en-US', 'en']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  const first = Object.values(value).find((candidate): candidate is string => typeof candidate === 'string' && !!candidate.trim())
  return first?.trim() ?? ''
}

export function readJsonFile(filePath: string): unknown {
  const size = fs.statSync(filePath).size
  if (size > MAX_MANIFEST_BYTES) throw new Error(`Manifest is too large: ${filePath}`)
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
}

export function defaultManifestFileFilter(name: string): boolean {
  return name.endsWith('.hira-plugin.json') || name.endsWith('.plugin.json')
}

export function normalizeManifest(
  value: unknown,
  originPath?: string | null,
  options: NormalizeManifestOptions = {}
): PluginManifest {
  if (!isRecord(value)) throw new Error(`Invalid manifest: ${originPath}`)
  const input = value
  const id = String(input.id || '').trim()
  if (!id) throw new Error(`Manifest missing id: ${originPath}`)
  if (!isPluginId(id)) throw new Error(`Manifest id is not path-safe: ${id}`)

  const entryPath = (candidate: unknown, label: string): string | null => {
    if (candidate === undefined || candidate === null || candidate === '') return null
    const raw = String(candidate).trim().replace(/\\/g, '/')
    if (!raw) return null
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.split('/').includes('..')) {
      throw new Error(`Manifest ${id}: ${label} must stay inside the plugin directory`)
    }
    return raw.replace(/^\.\//, '')
  }

  const dependsOn = strings(input.dependsOn)
  const optionalDependsOn = strings(input.optionalDependsOn)
  const conflictsWith = strings(input.conflictsWith)
  const entry = isRecord(input.entry) ? input.entry : {}
  const main = entryPath(input.main || entry.main, 'main')
  const render = entryPath(input.render || entry.render, 'render')
  const capabilities = strings(input.capabilities)
  const declaredTrustLevel = input.trustLevel
    ? String(input.trustLevel).trim()
    : options.defaultTrustLevel || 'internal'
  const requestsFirstParty = declaredTrustLevel === 'internal' || declaredTrustLevel === 'core'
  const isFirstParty = requestsFirstParty && options.allowFirstParty !== false
  // User-installed plugins can never self-upgrade into the first-party trust boundary.
  const trustLevel: PluginPublisherTrustLevel = isFirstParty ? declaredTrustLevel : 'community'
  const requestedPermissions = strings(input.requestedPermissions)
  const permissionLevelRaw = input.permissionLevel ? String(input.permissionLevel).trim() : ''
  const permissionLevel: PermissionLevel = isFirstParty
    ? 'full'
    : permissionLevelRaw === 'none' || permissionLevelRaw === 'ui' || permissionLevelRaw === 'network'
      ? permissionLevelRaw
      : 'ui'

  const unknownScopes = requestedPermissions.filter((scope) => !(scope in SCOPE_PERMISSIONS))
  if (unknownScopes.length) throw new Error(`Manifest ${id}: unknown permission scope(s): ${unknownScopes.join(', ')}`)

  const contributes = isRecord(input.contributes) ? input.contributes : {}
  const lifecycle = isRecord(input.lifecycle) ? input.lifecycle : {}
  const healthRaw = isRecord(input.healthCheck) ? input.healthCheck : isRecord(lifecycle.healthCheck) ? lifecycle.healthCheck : null
  const healthCheck: PluginHealthCheck | null = healthRaw ? {
    enabled: healthRaw.enabled !== false,
    // 健康检查是常驻定时器：不可信 manifest 不能把周期压到毫秒级空转。
    intervalMs: boundedNumber(healthRaw.interval, 60_000, 1_000, 24 * 60 * 60 * 1000),
    timeoutMs: boundedNumber(healthRaw.timeout, 5_000, 250, 60_000),
    failures: Math.floor(boundedNumber(healthRaw.failures, 3, 1, 100))
  } : null

  const declaredUi = panelUiFromManifest(input)
  // Executable renderer modules share the shell's JavaScript realm and therefore
  // expose the full renderer IPC object. Only bundled first-party modules may use
  // that trust boundary. User-installed UI must use the sandboxed HTML/XAML panel.
  let renderEffective = isFirstParty && render && isRenderModulePath(render) ? render : null
  if (isFirstParty && originPath && Array.isArray(contributes.panels) && contributes.panels.length) {
    const directory = path.dirname(originPath)
    const usable = (candidate: string | null): boolean => {
      if (!candidate || candidate === main || !isRenderModulePath(candidate)) return false
      try { return fs.statSync(path.resolve(directory, candidate)).isFile() } catch { return false }
    }
    if (!usable(renderEffective)) renderEffective = renderEntryCandidates(id).find(usable) ?? null
  }

  let renderVersion: number | null = null
  if (isFirstParty && renderEffective && originPath) {
    try { renderVersion = fs.statSync(path.resolve(path.dirname(originPath), renderEffective)).mtimeMs } catch { renderVersion = null }
  }

  return {
    id,
    version: input.version ? String(input.version).trim() : '0.0.0',
    name: pickText(input.name) || id,
    description: pickText(input.description),
    type: String(resolvePluginType(input) || ''),
    trustLevel,
    isFirstParty,
    permissionLevel,
    requestedPermissions,
    main,
    render: renderEffective,
    renderVersion,
    uiEntry: declaredUi,
    capabilities,
    contributes,
    dependsOn,
    optionalDependsOn,
    conflictsWith,
    healthCheck,
    nonDisableable: input.nonDisableable === true && isFirstParty,
    defaultDisabled: input.defaultDisabled === true,
    originPath: originPath || null
  }
}

export function scanPluginDir(
  directory: string,
  shape: 'flat' | 'dir',
  filter: (name: string) => boolean,
  options: NormalizeManifestOptions = {}
): PluginManifest[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    console.warn(`[plugin] 无法读取插件目录 ${directory}:`, error instanceof Error ? error.message : error)
    return []
  }

  const found: PluginManifest[] = []
  for (const entry of entries) {
    let manifestPath: string | null = null
    if (shape === 'flat') {
      if (!entry.isFile() || !filter(entry.name)) continue
      manifestPath = path.join(directory, entry.name)
    } else {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      for (const name of ['hira-plugin.json', 'plugin.json']) {
        const candidate = path.join(directory, entry.name, name)
        if (fs.existsSync(candidate)) {
          manifestPath = candidate
          break
        }
      }
      if (!manifestPath) continue
    }

    try {
      found.push(normalizeManifest(readJsonFile(manifestPath), manifestPath, options))
    } catch (error) {
      console.warn(`[plugin] manifest 解析失败，已跳过：${manifestPath} — ${error instanceof Error ? error.message : error}`)
    }
  }
  return found
}

export function validateDeps(manifests: readonly PluginManifest[]): true {
  const byId = new Map<string, PluginManifest>()
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) throw new Error(`Duplicate plugin id: ${manifest.id}`)
    byId.set(manifest.id, manifest)
  }

  const edges = new Map<string, string[]>()
  for (const manifest of manifests) {
    edges.set(manifest.id, manifest.dependsOn.slice())
    for (const dependencyId of manifest.dependsOn) {
      if (!byId.has(dependencyId)) throw new Error(`Plugin ${manifest.id} depends on missing ${dependencyId}`)
    }
  }

  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let cursor = 0

  const strongConnect = (node: string): void => {
    index.set(node, cursor)
    low.set(node, cursor)
    cursor += 1
    stack.push(node)
    onStack.add(node)
    for (const target of edges.get(node) ?? []) {
      if (!index.has(target)) {
        strongConnect(target)
        low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0))
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0))
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = []
      while (stack.length) {
        const current = stack.pop()
        if (current === undefined) break
        onStack.delete(current)
        component.push(current)
        if (current === node) break
      }
      components.push(component)
    }
  }

  for (const manifest of manifests) if (!index.has(manifest.id)) strongConnect(manifest.id)
  const cycle = components.find((component) => component.length > 1)
  if (cycle) throw new Error(`Plugin dependency cycle: ${cycle.join(' -> ')}`)
  for (const manifest of manifests) {
    for (const conflict of manifest.conflictsWith) {
      if (byId.has(conflict)) throw new Error(`Plugin ${manifest.id} conflictsWith ${conflict}`)
    }
  }
  return true
}

export function topoSort(manifests: readonly PluginManifest[]): PluginManifest[] {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]))
  const permanent = new Set<string>()
  const temporary = new Set<string>()
  const output: PluginManifest[] = []

  const visit = (id: string): void => {
    if (permanent.has(id)) return
    if (temporary.has(id)) throw new Error(`Plugin dependency cycle: ${Array.from(temporary).join(' -> ')} -> ${id}`)
    const manifest = byId.get(id)
    if (!manifest) throw new Error(`Missing plugin: ${id}`)
    temporary.add(id)
    for (const dependencyId of manifest.dependsOn) visit(dependencyId)
    temporary.delete(id)
    permanent.add(id)
    output.push(manifest)
  }

  for (const manifest of manifests) visit(manifest.id)
  return output
}
