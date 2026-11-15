/**
 * Chromium 系浏览器检测（Chrome / Edge / 未来的 Brave 等都复用这个工厂）
 *
 * 判据（按可靠性排序，**不是**按浏览器名分支）：
 *   1. `<User Data>/Local State` 的 `profile.info_cache` —— 官方登记的 profile 清单
 *      与展示名都在这里，是唯一能拿到「工作 / 个人」这类用户自定义名称的来源；
 *   2. 目录扫描兜底 —— Local State 缺失 / 损坏 / 版本变化时，退回 `Default` 与
 *      `Profile N` 目录；仍要求目录里有 `Preferences`（确认是真实 profile）。
 *   3. 每个 profile 至少有 `Bookmarks` / `History` / `Extensions` 之一才算「有东西可搬」。
 *
 * 路径永远不越过 IPC：`listProfiles()` 只返回 id / 展示名 / 能力位，
 * 绝对路径由 `resolveProfile()` 在主进程内部使用（见 import/index.js）。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  CAPABILITY_BOOKMARKS,
  CAPABILITY_HISTORY,
  CAPABILITY_EXTENSIONS
} from '../capabilities'

export interface BrowserProfileSummary {
  id: string
  name: string
  capabilities: number
}

export interface DetectedProfiles {
  ok: boolean
  profiles: BrowserProfileSummary[]
  error?: string
}

export interface ResolvedBrowserProfile {
  ok: true
  dir: string
  hasBookmarks: boolean
  hasHistory: boolean
  hasExtensions: boolean
  extensionsDir: string
}

export interface ProfileResolutionFailure { ok: false; error: string }

export interface ChromiumSourceSpec {
  id: string
  label: string
  userDataDirs: string[]
}

export interface ChromiumSource {
  readonly id: string
  readonly label: string
  readonly capabilities: number
  listProfiles(): DetectedProfiles
  resolveProfile(profileId: unknown): ResolvedBrowserProfile | ProfileResolutionFailure
}

interface InspectedProfile {
  dir: string
  hasBookmarks: boolean
  hasHistory: boolean
  hasExtensions: boolean
  capabilities: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Windows 上 Chromium 系共享的数据根：`%LOCALAPPDATA%\<vendor>\<product>\User Data`。 */
export function windowsUserDataDirs(...segments: string[]): string[] {
  const bases = [process.env.LOCALAPPDATA, process.env.APPDATA]
    .filter((base): base is string => typeof base === 'string' && base.length > 0)
  const dirs = bases.map((base) => path.join(base, ...segments, 'User Data'))
  return [...new Set(dirs)]
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch (_) {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch (_) {
    return false
  }
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (_) {
    return null
  }
}

/**
 * @param {{ id: string, label: string, userDataDirs: string[] }} spec
 *   id         稳定标识（IPC 里传的就是它，不允许随展示名变化）
 *   label      展示名（页面直接显示，不做二次本地化）
 *   userDataDirs 候选 User Data 目录（按优先级；通常来自 windowsUserDataDirs）
 */
export function createChromiumSource(spec: ChromiumSourceSpec): ChromiumSource {
  const id = String(spec.id || '').trim()
  const label = String(spec.label || id)
  const userDataDirs = Array.isArray(spec.userDataDirs) ? spec.userDataDirs : []
  const capabilities =
    CAPABILITY_BOOKMARKS | CAPABILITY_HISTORY | CAPABILITY_EXTENSIONS

  function locateUserDataDir(): string | null {
    for (const dir of userDataDirs) {
      if (isDir(dir)) return dir
    }
    return null
  }

  /**
   * profile 目录名清单（已按「最近使用优先」排序）。
   * 注意：只返回目录名，不返回路径。
   * @returns {string[]}
   */
  function candidateProfiles(root: string): string[] {
    const localState = readJson(path.join(root, 'Local State'))
    const profile = asRecord(asRecord(localState)?.profile)
    const cache = asRecord(profile?.info_cache)
    const keys = cache ? Object.keys(cache) : []

    const ordered: string[] = []
    const seen = new Set<string>()
    const push = (name: string): void => {
      if (!name || seen.has(name)) return
      seen.add(name)
      ordered.push(name)
    }

    if (keys.length > 0) {
      const lastUsed = typeof profile?.last_used === 'string' ? profile.last_used : ''
      push(lastUsed)
      push('Default')
      for (const key of keys) push(key)
      return ordered
    }

    // 兜底：Local State 不可用 → 扫目录（只认 Chromium 的命名约定）
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (_) {
      return []
    }
    const names = entries
      .filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
      .map((e) => e.name)
    names.sort((a, b) => {
      if (a === b) return 0
      if (a === 'Default') return -1
      if (b === 'Default') return 1
      return a.localeCompare(b, 'en')
    })
    for (const name of names) push(name)
    return ordered
  }

  /** 读一个 profile 目录的可导入能力（要求 Preferences 存在）。 */
  function inspectProfile(root: string, dirName: string): InspectedProfile | null {
    const dir = path.join(root, dirName)
    if (!isDir(dir) || !isFile(path.join(dir, 'Preferences'))) return null
    const hasBookmarks = isFile(path.join(dir, 'Bookmarks'))
    const hasHistory = isFile(path.join(dir, 'History'))
    const hasExtensions = isDir(path.join(dir, 'Extensions'))
    if (!hasBookmarks && !hasHistory && !hasExtensions) return null
    return {
      dir,
      hasBookmarks,
      hasHistory,
      hasExtensions,
      capabilities:
        (hasBookmarks ? CAPABILITY_BOOKMARKS : 0) |
        (hasHistory ? CAPABILITY_HISTORY : 0) |
        (hasExtensions ? CAPABILITY_EXTENSIONS : 0)
    }
  }

  function listProfiles(): DetectedProfiles {
    const root = locateUserDataDir()
    if (!root) return { ok: true, profiles: [] }
    try {
      const localState = readJson(path.join(root, 'Local State'))
      const profile = asRecord(asRecord(localState)?.profile)
      const cache = asRecord(profile?.info_cache) || {}
      const profiles: BrowserProfileSummary[] = []
      for (const dirName of candidateProfiles(root)) {
        const info = inspectProfile(root, dirName)
        if (!info) continue
        const meta = asRecord(cache[dirName]) || {}
        profiles.push({
          id: dirName,
          name: String(meta.name || meta.shortcut_name || dirName),
          capabilities: info.capabilities
        })
      }
      return { ok: true, profiles }
    } catch (e) {
      return { ok: false, profiles: [], error: errorMessage(e) }
    }
  }

  /**
   * 把 profileId 解析成主进程内部可用的绝对路径与能力。
   * 只接受 User Data 的**直接子目录名** —— 阻断 `..\..\` 这类穿越。
   */
  function resolveProfile(profileId: unknown): ResolvedBrowserProfile | ProfileResolutionFailure {
    const root = locateUserDataDir()
    if (!root) return { ok: false, error: '未检测到安装目录' }
    const id = String(profileId || '').trim()
    if (!id) return { ok: false, error: '缺少 profile 标识' }
    const dir = path.join(root, id)
    if (path.dirname(dir) !== root) return { ok: false, error: '非法的 profile 标识' }
    const info = inspectProfile(root, id)
    if (!info) return { ok: false, error: 'profile 不存在或没有可导入的数据' }
    return {
      ok: true,
      dir: info.dir,
      hasBookmarks: info.hasBookmarks,
      hasHistory: info.hasHistory,
      hasExtensions: info.hasExtensions,
      extensionsDir: path.join(info.dir, 'Extensions')
    }
  }

  return {
    id,
    label,
    capabilities,
    listProfiles,
    resolveProfile
  }
}

