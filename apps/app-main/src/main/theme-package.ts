/**
 * theme-package.js —— 主题包（zip）的**组装与拆解**（主进程，纯逻辑 + 一点 IO 编排）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一个主题包长什么样
 * ══════════════════════════════════════════════════════════════════════
 *   theme.json      —— 我们的主题定义（归一化后的那份，与插件 manifest 里的一致）
 *   vivaldi.json    —— 同一主题的 Vivaldi 字段名版本（字段名对照见 theme-vivaldi.js）
 *   background.*    —— 背景图（若主题用它；文件名与主题里的 `background.path` 一致）
 *
 * 三份内容**都在同一个包里**，于是同一个文件既能被我们自己导入（读 theme.json），
 * 也能丢给 Vivaldi 试（读 vivaldi.json）—— 这就是"双向搬运"不靠两套导出格式的做法。
 * 少写一份、少一处会漂移的东西。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 导入认三种包（按优先级）
 * ══════════════════════════════════════════════════════════════════════
 *   1. `hira-plugin.json` —— 已经是一个主题插件包（我们导出的、或手写的）；
 *      取 `contributes.themes[0]`。
 *   2. `theme.json` 含 `colorScheme` —— Vivaldi 的导出包（走 theme-vivaldi 映射）。
 *   3. `theme.json`（或其它顶层 `*.json`）是我们的形状 —— 直接读。
 * 三种都认不出来就明确报错，而不是"装进去一个空的"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 安全边界（本文件负责，不能省）
 * ══════════════════════════════════════════════════════════════════════
 * `plugin-archive` 只负责"把字节读出来"，**路径合法性是本文件的职责** ——
 * 因为我们随后会把资产**写到磁盘**上（导入时落成插件目录）。
 * 所以：条目名必须通过 `safeEntryName`（拒绝绝对路径 / `..` / 盘符 / 空名），
 * 并且只保留白名单扩展名、单文件与总量都有上限。
 * 少了这一步，一个 `../../` 的条目名就能写到插件目录之外。
 */

import path from 'node:path'
import { BACKGROUND_ASSET_KINDS, normalizeTheme, type ThemeData } from '@hira-ng/shared-types/src/theme.mjs'
// 资产扩展名词表真源（与两条协议共用）。
import {
  RASTER_IMAGE_EXTENSIONS,
  VECTOR_IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS
} from '@hira-ng/shared-types/src/media-extensions.mjs'
import { fromVivaldi, looksLikeVivaldi, toVivaldi } from './theme-vivaldi'

interface ZipEntry {
  name: string
  isDir?: boolean
  compSize: number
  rawSize: number
  [key: string]: unknown
}
interface SafeZipEntry extends ZipEntry { safeName: string }
interface ThemeAsset { name: string; data: Buffer }
interface ThemePackageFile { name: string; data: Buffer | string }
type ThemeUnpackResult =
  | { ok: true; kind: 'plugin' | 'theme' | 'vivaldi'; theme: ThemeData; assets: ThemeAsset[]; warnings: string[] }
  | { ok: false; reason: string }

const { readZipEntries, extractEntry, writeZipEntries } = require('./plugin-archive') as {
  readZipEntries(buffer: Buffer): ZipEntry[]
  extractEntry(entry: ZipEntry): Buffer
  writeZipEntries(files: readonly ThemePackageFile[]): Buffer
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

/** 插件包清单名（与 plugin-installer 的 MANIFEST_NAME 同名，是协议的一部分）。 */
const MANIFEST_NAME = 'hira-plugin.json'
const THEME_NAME = 'theme.json'
const VIVALDI_NAME = 'vivaldi.json'

/** 导入包体积上限（含资产）。要装得下"一段几十秒的动态壁纸"，见 §6.4.4 的分档表。 */
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024
/** 单个**图片**资产上限（与 plugin-protocol 的图片档同值 —— 两处不一致会让导入的东西读不出来）。 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024
/** 单个**视频**资产上限（与 `hira-theme://` / `hira-plugin://` 的视频档同值）。 */
const MAX_VIDEO_ASSET_BYTES = 64 * 1024 * 1024
/** 单次导入保留的资产总字节上限。 */
const MAX_TOTAL_ASSET_BYTES = 128 * 1024 * 1024

/** 会被当资产保留的扩展名：图片（含矢量）+ 视频，词表真源在 shared-types。 */
const ASSET_EXT: ReadonlySet<string> = Object.freeze(new Set<string>([
  ...RASTER_IMAGE_EXTENSIONS,
  ...VECTOR_IMAGE_EXTENSIONS,
  // 视频：动态壁纸（`background.kind === 'video'`）要能随主题包一起走。
  ...VIDEO_EXTENSIONS
]))

/** 走"视频额度"的扩展名。 */
const VIDEO_ASSET_EXT: ReadonlySet<string> = Object.freeze(new Set<string>(VIDEO_EXTENSIONS))

/** 某个资产文件名的体积上限（按扩展名分档，**唯一一处**）。 */
function maxAssetBytesFor(name: unknown): number {
  return VIDEO_ASSET_EXT.has(path.extname(String(name || '')).toLowerCase())
    ? MAX_VIDEO_ASSET_BYTES
    : MAX_ASSET_BYTES
}

/** 主题 id 允许的字符（与 plugin-installer 的 ID_PATTERN 同口径：id 就是目录名）。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

// ══════════════════════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════════════════════

/**
 * 主题 → 写进包的 `theme.json` 内容。
 *
 * 刻意**剥掉运行时字段**（`source` / `pluginId` / `preview`）：那三项是"这条主题在
 * 我这台机器上的处境"，不是主题本身。把它们写进包，别人导入后会拿到一个指向
 * 别人插件的 `pluginId`（背景图永远加载不出来），是最难查的一类问题。
 */
export function exportableTheme(theme: unknown): Omit<ThemeData, 'source' | 'pluginId' | 'preview'> {
  const t = normalizeTheme(theme)
  return {
    id: t.id,
    name: t.name,
    author: t.author,
    version: t.version,
    schemaVersion: 1,
    mode: t.mode,
    colors: t.colors,
    style: t.style,
    background: { ...t.background },
    icons: t.icons
  }
}

/**
 * 组装导出包的文件列表。
 * @param {any} theme 归一化主题
 * @param {Array<{ name: string, data: Buffer }>} [assets] 主题自带的资产（背景图），由调用方读出
 * @returns {Array<{ name: string, data: Buffer | string }>}
 */
export function packageFiles(theme: unknown, assets?: readonly ThemeAsset[]): ThemePackageFile[] {
  const payload = exportableTheme(theme)
  const files = [
    { name: THEME_NAME, data: JSON.stringify(payload, null, 2) + '\n' },
    { name: VIVALDI_NAME, data: JSON.stringify(toVivaldi(theme), null, 2) + '\n' }
  ]
  for (const asset of Array.isArray(assets) ? assets : []) {
    const name = safeEntryName(asset && asset.name)
    if (!name || !Buffer.isBuffer(asset.data)) continue
    files.push({ name, data: asset.data })
  }
  return files
}

/** 主题 → zip Buffer（给 `dialog.showSaveDialog` 之后直接写盘用）。 */
export function packTheme(theme: unknown, assets?: readonly ThemeAsset[]): Buffer {
  return writeZipEntries(packageFiles(theme, assets))
}

/** 导出文件名（`hira-theme-<安全名>.zip`）—— 去掉文件系统不接受的字符。 */
export function suggestedFileName(theme: unknown): string {
  const raw = String(asRecord(theme)?.name || 'theme')
  const safe = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 48) || 'theme'
  return `hira-theme-${safe}.zip`
}

// ══════════════════════════════════════════════════════════════════════
// 导入
// ══════════════════════════════════════════════════════════════════════

/**
 * 条目名是否安全（**必须**在落盘前调用）。
 *
 * 拒绝：空名、绝对路径、盘符、任何一段是 `..`、以及绝对化后仍跑到上级的路径。
 * 这不是"防手滑"，而是 zip-slip 的唯一闸门 —— 条目名是压缩包内容的一部分，
 * 也就是**攻击者可控的输入**。
 *
 * @param {unknown} raw
 * @returns {string} 合法则返回归一化（`/` 分隔）的名字；否则空串
 */
export function safeEntryName(raw: unknown): string {
  const name = String(raw == null ? '' : raw).replace(/\\/g, '/').trim()
  if (!name || name.endsWith('/')) return ''
  if (name.startsWith('/')) return ''
  if (/^[a-zA-Z]:/.test(name)) return ''
  const parts = name.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return ''
  return parts.join('/')
}

/** 包内常见的"多套了一层目录"（Vivaldi 导出的包有时如此）——取出真正的相对名。 */
function stripCommonRoot(names: readonly string[]): { prefix: string; map(name: string): string } {
  const list = names.filter(Boolean)
  if (list.length < 2) return { prefix: '', map: (n: string) => n }
  const first = list.map((n) => n.split('/')[0])
  const same = first.every((p) => p === first[0])
  if (!same) return { prefix: '', map: (n: string) => n }
  // 顶层只有那一个目录（所有条目都在它下面）→ 剥掉它
  if (list.every((n) => n.includes('/'))) {
    return { prefix: `${first[0]}/`, map: (n: string) => (n.startsWith(`${first[0]}/`) ? n.slice((first[0] || '').length + 1) : n) }
  }
  return { prefix: '', map: (n: string) => n }
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (_) {
    return null
  }
}

/**
 * 拆一个主题包。
 *
 * @param {Buffer} buf zip 内容
 * @returns {{ ok: boolean, reason?: string, kind?: 'plugin'|'theme'|'vivaldi',
 *             theme?: object, assets?: Array<{ name: string, data: Buffer }>, warnings?: string[] }}
 */
export function unpackTheme(buf: Buffer): ThemeUnpackResult {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, reason: '不是有效的压缩包' }
  if (buf.length > MAX_ARCHIVE_BYTES) {
    return { ok: false, reason: `压缩包过大（${Math.round(buf.length / 1024 / 1024)}MB，上限 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` }
  }

  let entries
  try {
    entries = readZipEntries(buf)
  } catch (e) {
    return { ok: false, reason: errorMessage(e) || '压缩包无法解析' }
  }

  const warnings: string[] = []
  /** 先做路径守卫，再做任何"按名字取文件"的动作。 */
  const safe: SafeZipEntry[] = []
  for (const entry of entries) {
    if (entry.isDir) continue
    const name = safeEntryName(entry.name)
    if (!name) {
      warnings.push(`已跳过不安全的条目：${String(entry.name).slice(0, 60)}`)
      continue
    }
    safe.push({ ...entry, safeName: name })
  }
  if (!safe.length) return { ok: false, reason: '压缩包里没有可用文件' }

  const { prefix, map } = stripCommonRoot(safe.map((e) => e.safeName))
  if (prefix) warnings.push(`已自动剥掉顶层目录「${prefix.replace(/\/$/, '')}」`)
  const byName = new Map<string, SafeZipEntry>()
  for (const entry of safe) byName.set(map(entry.safeName), entry)

  // ── 1. 主题插件包 ───────────────────────────────────────────────────
  const manifestEntry = byName.get(MANIFEST_NAME)
  const manifestJson = manifestEntry ? parseJson(extractEntry(manifestEntry)) : null
  // 有些包把 `contributes.themes` 写成数组、有些写成单条；两种都收。
  let rawTheme: Record<string, unknown> | null = null
  let kind: '' | 'plugin' | 'theme' | 'vivaldi' = ''
  const manifest = manifestJson && typeof manifestJson === 'object' ? manifestJson as Record<string, unknown> : null
  const contributes = manifest && manifest.contributes && typeof manifest.contributes === 'object'
    ? manifest.contributes as Record<string, unknown>
    : null
  if (contributes && contributes.themes) {
    const list = Array.isArray(contributes.themes) ? contributes.themes : [contributes.themes]
    rawTheme = list.find((themeItem): themeItem is Record<string, unknown> => !!themeItem && typeof themeItem === 'object') || null
    kind = 'plugin'
    if (list.length > 1) warnings.push(`包里有 ${list.length} 条主题，只导入第一条（要全部导入请分别导出）`)
  }

  // ── 2/3. theme.json（可能是我们的，也可能是 Vivaldi 的）────────────────
  if (!rawTheme) {
    const themeEntry = byName.get(THEME_NAME)
    const json = themeEntry ? parseJson(extractEntry(themeEntry)) : null
    if (json && looksLikeVivaldi(json)) {
      rawTheme = fromVivaldi(json)
      kind = 'vivaldi'
    } else if (json && typeof json === 'object') {
      rawTheme = asRecord(json)
      kind = 'theme'
    } else {
      // 兜底：顶层任意一个"看起来像主题"的 json
      for (const [name, entry] of byName) {
        if (!name.toLowerCase().endsWith('.json')) continue
        const anyJson = parseJson(extractEntry(entry))
        if (looksLikeVivaldi(anyJson)) {
          rawTheme = fromVivaldi(anyJson)
          kind = 'vivaldi'
          break
        }
        const candidate = asRecord(anyJson)
        if (candidate && (candidate.colors || candidate.colorScheme)) {
          rawTheme = candidate
          kind = 'theme'
          break
        }
      }
    }
  }

  if (!rawTheme) {
    return { ok: false, reason: `包里找不到主题定义（需要 ${THEME_NAME} 或 ${MANIFEST_NAME}）` }
  }

  const theme = normalizeTheme({ ...rawTheme, source: 'plugin', pluginId: '' })
  if (!theme.id) warnings.push('主题没有 id，导入时会自动生成一个')

  // ── 资产：只保留主题引用到的那一个文件（图片**或视频**）──────────────────
  const wanted = new Set<string>()
  const bgPath = theme.background && theme.background.path ? safeEntryName(theme.background.path) : ''
  const bgKind = theme.background ? theme.background.kind : ''
  /** 引用的是"一份本地资产"吗 —— 判据取自共享层（图片/视频同一份清单，见 BACKGROUND_ASSET_KINDS）。 */
  const bgHasAsset = BACKGROUND_ASSET_KINDS.includes(bgKind) && !!bgPath
  if (bgHasAsset) wanted.add(bgPath)

  const assets: ThemeAsset[] = []
  let assetBytes = 0
  for (const name of wanted) {
    const entry = byName.get(name)
    if (!entry) {
      warnings.push(`主题引用了背景文件「${name}」，但包里没有这个文件 —— 已降级为纯色背景`)
      continue
    }
    const ext = path.extname(name).toLowerCase()
    if (!ASSET_EXT.has(ext)) {
      warnings.push(`背景文件「${name}」的类型不受支持，已跳过`)
      continue
    }
    const limit = maxAssetBytesFor(name)
    if (entry.compSize > limit || entry.rawSize > limit) {
      warnings.push(`背景文件「${name}」超过 ${limit / 1024 / 1024}MB，已跳过`)
      continue
    }
    const data = extractEntry(entry)
    if (assetBytes + data.length > MAX_TOTAL_ASSET_BYTES) {
      warnings.push('资产总量超限，已跳过剩余文件')
      break
    }
    assetBytes += data.length
    assets.push({ name, data })
  }

  // 引用了文件但没拿到 → 降级，避免留下一个"指向不存在文件"的主题
  let outTheme: ThemeData = theme
  if (bgHasAsset && !assets.length) {
    outTheme = normalizeTheme({
      ...theme,
      background: { ...theme.background, kind: 'color', path: '', color: theme.background.color || theme.colors.bg || '' }
    })
  }

  return { ok: true, kind: kind || 'theme', theme: outTheme, assets, warnings }
}

/**
 * 把导入的主题组装成一个**主题插件目录**的文件清单。
 *
 * 为什么导入要落成插件目录、而不是塞进 settings 里的用户主题：
 *   背景图是**文件**，而插件目录已经有一整套"发现 / 启停 / 资产协议（`hira-plugin://`）/
 *   卸载 / 版本"的能力。用户导入的包天然是"一份别人给的东西"，用插件体系承接它，
 *   等于把最贵的那部分（安全的落盘与取用）交给已经写好并验证过的链路。
 *   settings 里那份用户主题留给"我自己在编辑器里改出来的主题" —— 它没有资产。
 *
 * ⚠ 生成的 manifest **完全由我们重建**（只取主题定义），绝不照抄包里的清单：
 *   否则第三方包里的 `main` / `requestedPermissions` 会连同代码一起被带进来 ——
 *   而"导入一个主题"这件事，用户预期的是"换套颜色"，不是"装了一段程序"。
 *
 * @param {{ theme: any, assets: Array<{ name: string, data: Buffer }>, id?: string }} input
 * @returns {{ manifest: object, files: Array<{ name: string, data: Buffer | string }> }}
 */
export function buildImportPackage({ theme, assets, id }: { theme: unknown; assets: readonly ThemeAsset[]; id?: string }) : { manifest: object, files: Array<{ name: string, data: Buffer | string }> } {
  /**
   * ⚠ **总是**新生成一个 id，而不是沿用包里的主题 id。
   *
   * 沿用会踩两个坑，且两个都是"看起来装好了但就是不生效"：
   *   ① 我导出自己的用户主题（id 形如 `user.abc`）再导回来 → 生成的插件主题
   *      与那条用户主题**同 id**，而主题目录的去重是"内置 > 用户 > 插件"——
   *      导入进来的那条永远被压在下面，用户只会看到"导入成功了，但列表里没有它"；
   *   ② 重复导入同一个包 → id 相同 → 安装器的撞名守卫会让第二次安装失败，
   *      而用户的心智是"我想要两份"（或至少再装一次应当是个新条目）。
   *
   * "覆盖已有插件"那种更新语义属于插件市场（它有版本与来源），不属于"导入一个文件"。
   */
  const themeId = validId(id) || generatedId(theme)
  const themeRecord = asRecord(theme)
  const displayName = String(themeRecord?.name || '').trim() || themeId
  const payload = exportableTheme(theme)
  // 主题定义里的 id 与插件 id 必须一致：`theme-service` 用它做目录去重，
  // 而 manifest 的 id 决定插件目录名 —— 两者不同会让"卸载插件"与"主题消失"对不上。
  payload.id = themeId

  const manifest = {
    id: themeId,
    name: { 'zh-CN': displayName },
    version: String(themeRecord?.version || '1.0.0') || '1.0.0',
    type: 'theme-plugin',
    // 本地导入 = 用户自己挑的文件。它**没有 main、没有权限声明**，
    // 所以既不会被沙箱拦、也不会要求授权（见 plugin-registry-v2 的授权判据）。
    trustLevel: 'local',
    description: `由主题包导入：${displayName}`,
    contributes: { themes: [payload] }
  }

  const files = [
    { name: MANIFEST_NAME, data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: THEME_NAME, data: JSON.stringify(payload, null, 2) + '\n' }
  ]
  for (const asset of Array.isArray(assets) ? assets : []) {
    const name = safeEntryName(asset && asset.name)
    if (!name || !Buffer.isBuffer(asset.data)) continue
    files.push({ name, data: asset.data })
  }
  return { manifest, files }
}

/** 目录名/插件 id 合法性（与 plugin-installer 的 ID_PATTERN 同口径）。 */
export function validId(candidate: unknown): string {
  const id = String(candidate == null ? '' : candidate).trim()
  if (!id || id === '.' || id === '..') return ''
  return ID_PATTERN.test(id) ? id : ''
}

/**
 * 由主题名派生一个合法 id：`theme-<slug>-<base36 时间>`。
 *
 * 带时间后缀而不是纯 slug：导入同一个主题两次应当得到**两个**插件
 * （用户可能就是想要一份改着玩），而不是第二次静默覆盖掉第一次。
 */
export function generatedId(theme: unknown): string {
  const raw = String(asRecord(theme)?.name || 'imported')
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const suffix = Date.now().toString(36)
  // 中文名 slug 之后会是空串（`[^\a-z0-9]` 全被换成连字符又被裁掉）——
  // 直接拼会得到 `theme--mux…` 这种双横线，虽然合法但很难看，也没信息量。
  const parts = ['theme', slug, suffix].filter(Boolean)
  return validId(parts.join('-')) || `theme-${suffix}`
}

