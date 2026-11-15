/**
 * 浏览器一键迁移 · 扩展（parse + write 两段，无「copy」段）
 *
 * 为什么不走 copy/ 那套临时快照：扩展目录不是「读一眼就丢」的数据 ——
 * 它要被**复制进本应用自己的扩展存储**并由安装记录长期引用，因此复制由
 * infra-extensions 的 `installFromExternalDirectory` 负责（它才是扩展存储的宿主），
 * 迁移层只做「枚举 + 逐个转交 + 汇总结果」。
 *
 * 目录约定（Chromium 系）：`<profile>/Extensions/<extensionId>/<version>/manifest.json`。
 * 同一扩展可能留着多个版本目录，取 manifest 里 version 最大的那个。
 *
 * 一切失败都结构化返回（`{ imported, skipped, errors }`），不抛异常：
 * 扩展导入是引导流程里的可选项，单个扩展装不上不该拖死整次迁移。
 */
import fs from 'node:fs'
import path from 'node:path'

export interface SourceExtension {
  key: string
  name: string
  version: string
  srcDir: string
}

export interface ExtensionImportResult {
  imported: number
  skipped: number
  errors: string[]
}

interface ExtensionManifest {
  name?: unknown
  version?: unknown
  default_locale?: unknown
  [key: string]: unknown
}

interface ExtensionInstallResult {
  ok?: boolean
  already?: boolean
  error?: unknown
}

export interface ExtensionInstallService {
  installFromExternalDirectory(
    sourceDir: string,
    metadata: { slot: string; version: string }
  ): Promise<ExtensionInstallResult> | ExtensionInstallResult
}

const MAX_EXTENSION_JSON_BYTES = 4 * 1024 * 1024

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readJson(filePath: string): unknown {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EXTENSION_JSON_BYTES) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_) {
    return null
  }
}

/** 版本号比较（Chromium 的版本就是点分数字；非数字段按 0 处理，够用且不会抛）。 */
export function compareVersion(a: unknown, b: unknown): number {
  const pa = String(a || '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 解析 manifest 里的 `__MSG_name__` 本地化名（读不到就回落到 key 本身）。 */
function resolveLocalizedName(manifest: ExtensionManifest, dir: string): string {
  const raw = typeof manifest.name === 'string' ? manifest.name : ''
  const matched = raw.match(/^__MSG_([A-Za-z0-9_]+)__$/)
  if (!matched) return raw
  const key = matched[1] || ''
  const rawLocale = typeof manifest.default_locale === 'string' ? manifest.default_locale : 'en'
  const locale = /^[A-Za-z0-9_-]+$/.test(rawLocale) ? rawLocale : 'en'
  const localesRoot = path.resolve(dir, '_locales')
  const messagesFile = path.resolve(localesRoot, locale, 'messages.json')
  const relative = path.relative(localesRoot, messagesFile)
  let messages: unknown = null
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    try {
      const realRoot = fs.realpathSync(dir)
      const realFile = fs.realpathSync(messagesFile)
      const realRelative = path.relative(realRoot, realFile)
      if (!realRelative.startsWith('..') && !path.isAbsolute(realRelative)) messages = readJson(realFile)
    } catch (_) {}
  }
  const entry = asRecord(asRecord(messages)?.[key])
  return (typeof entry?.message === 'string' && entry.message) || key
}

/**
 * 枚举一个浏览器 profile 里可导入的扩展。
 * @param {string} extensionsDir `<profile>/Extensions`
 * @returns {Array<{ key: string, name: string, version: string, srcDir: string }>}
 */
export function listSourceExtensions(extensionsDir: unknown): SourceExtension[] {
  const dir = typeof extensionsDir === 'string' ? extensionsDir : ''
  if (!dir) return []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return []
  }

  const result: SourceExtension[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const idDir = path.join(dir, entry.name)
    let versionDirs: string[] = []
    try {
      versionDirs = fs.readdirSync(idDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch (_) {
      continue
    }

    let best: SourceExtension | null = null
    for (const versionDir of versionDirs) {
      const srcDir = path.join(idDir, versionDir)
      const manifest = asRecord(readJson(path.join(srcDir, 'manifest.json'))) as ExtensionManifest | null
      if (!manifest) continue
      const version = String(manifest.version || versionDir)
      if (!best || compareVersion(version, best.version) > 0) {
        best = {
          key: entry.name,
          name: resolveLocalizedName(manifest, srcDir) || entry.name,
          version,
          srcDir
        }
      }
    }
    if (best) result.push(best)
  }
  return result
}

/**
 * 把一个 profile 的扩展逐个装进 Hira。
 *
 * @param {string} extensionsDir `<profile>/Extensions`
 * @param {any} extensionService infra-extensions 服务实例（当前 profile 的那份）
 * @returns {Promise<{ imported: number, skipped: number, errors: string[] }>}
 */
export async function importExtensionsFromProfile(
  extensionsDir: unknown,
  extensionService: ExtensionInstallService | null | undefined
): Promise<ExtensionImportResult> {
  const items = listSourceExtensions(extensionsDir)
  const result: ExtensionImportResult = { imported: 0, skipped: 0, errors: [] }
  if (items.length === 0) return result
  if (!extensionService || typeof extensionService.installFromExternalDirectory !== 'function') {
    result.errors.push('扩展服务不可用（无法安装扩展）')
    return result
  }

  for (const item of items) {
    const installed = await extensionService.installFromExternalDirectory(item.srcDir, {
      slot: item.key,
      version: item.version
    })
    if (installed && installed.ok) {
      if (installed.already) result.skipped++
      else result.imported++
      continue
    }
    result.errors.push(`${item.name}：${(installed && installed.error) || '安装失败'}`)
  }
  return result
}

