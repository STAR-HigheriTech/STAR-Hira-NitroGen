/**
 * AI 工作室 · 产物规整（纯逻辑，PART17 §2 / §3）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它做什么、不做什么
 * ══════════════════════════════════════════════════════════════════════
 * 做：把**模型给的参数**变成「一份可落盘的 manifest + 一组文本文件」。
 * 不做：落盘、安装、卸载、通知 —— 那些在 `main/studio.cjs` 编排，最终仍走
 *       `installFromPath` 这条唯一安装链路。
 *
 * 三条硬边界（不可协商）：
 *   1. **信任级只能我们给**：`trustLevel` 一律改写为 `local`，`signature` 一律丢弃
 *      —— 模型写 `internal` / 自带签名都不能改变它。
 *   2. **权限逐条对白名单**：`requestedPermissions` 对照 `SCOPE_PERMISSIONS`，
 *      未知 scope 直接报错并列出合法值（不静默忽略）。
 *   3. **只写文本**：路径必须相对、无 `..`、无盘符、不以 `.` 开头；扩展名白名单；
 *      单文件 / 总量 / 数量三重上限。`hira-plugin.json` 由本模块重建，不接受模型直写。
 *
 * 本文件零 IO（不 require fs / electron），因此可以被单测与任意宿主复用。
 */

const { normalizeTheme } = require('@hira-ng/shared-types/src/theme.mjs')
const {
  parseUserScriptMeta,
  buildUserScriptPluginManifest
} = require('@hira-ng/shared-types/src/userscript.mjs')
const {
  normalizePanelUi,
  isPanelUiEntry,
  isRenderModulePath,
  renderEntryCandidates,
  panelUiFromContribution,
  panelUiFromManifest,
  resolvePluginType,
  PLUGIN_TYPES,
  PANEL_UI_FIELD_ALIASES
} = require('@hira-ng/shared-types/src/plugin-ui.mjs')
// 声明式面板的编写契约（manifest 写法 / HTML 骨架 / hira.* 能力与事件 / data-* 约定）。
// 与运行时共用同一份真源 —— 这里只做转发，不重写一遍。
const {
  panelUiAuthoringGuide,
  panelUiAuthoringMarkdown,
  panelUiAuthoringSections,
  PANEL_UI_AUTHORING_MENU,
  PANEL_UI_AUTHORING_DIGEST
} = require('@hira-ng/shared-types/src/panel-ui-contract.mjs')
const {
  normalizeIconName,
  ICON_NAME_SUGGESTIONS
} = require('@hira-ng/shared-types/src/icon-names.mjs')
const { sandbox } = require('@hira-ng/infra-plugin')

import type { UnknownRecord } from '../types'

interface StudioError extends Error { code: string }
export interface StudioFile { path: string; content: string }
interface PanelContribution extends UnknownRecord {
  id?: string
  title?: string
  name?: string
  label?: string
  icon?: unknown
  ui?: unknown
  uiEntry?: unknown
}
interface StudioManifest extends UnknownRecord {
  id?: string
  name?: string
  version?: string
  description?: string
  main?: string
  render?: string
  ui?: unknown
  html?: unknown
  view?: unknown
  entryFile?: unknown
  trustLevel?: string
  permissionLevel?: string
  requestedPermissions?: unknown
  contributes?: UnknownRecord
}
interface PreparedArtifact { ok: true; kind: string; id: string; manifest?: StudioManifest; files: StudioFile[] }
interface StudioRequest extends UnknownRecord {
  files?: unknown
  manifest?: unknown
  contributes?: unknown
  theme?: unknown
  skill?: unknown
  userscript?: unknown
  id?: unknown
  name?: unknown
  version?: unknown
  description?: unknown
  permissions?: unknown
}

/** 产物类型。加新类型只需：这里加一项 + `prepareArtifact` 加一个分支。 */
const STUDIO_KINDS = Object.freeze(['plugin', 'theme', 'userscript', 'skill'])

const MANIFEST_NAME = 'hira-plugin.json'
const THEME_FILE_NAME = 'theme.json'
const SCRIPT_FILE_NAME = 'script.user.js'

/** 插件 id = 目录名，字符集必须与 `plugin-installer#ID_PATTERN` 一致。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 文本文件名与体积上限（见 PART17 §3.3）。 */
const MAX_FILES = 40
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const ALLOWED_EXTENSIONS = Object.freeze(['js', 'mjs', 'cjs', 'css', 'html', 'htm', 'json', 'svg', 'txt', 'md'])

/** `permissionLevel` 只允许这三档；`full` 永远不给 AI 产物。 */
const PERMISSION_LEVELS = Object.freeze(['none', 'ui', 'network'])

/** 已注册的能力 scope（唯一真源在 infra-plugin 的沙箱里）。 */
const SCOPE_KEYS = Object.freeze(Object.keys(sandbox && sandbox.SCOPE_PERMISSIONS ? sandbox.SCOPE_PERMISSIONS : {}))

function fail(code: string, message?: string): StudioError {
  const err = new Error(message || code) as StudioError
  err.code = code
  return err
}

function text(value: unknown): string {
  return String(value == null ? '' : value).trim()
}

/** 把任意文案压成 id 片段（与用户名脚本同一口径）。 */
function slugify(value: unknown): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * 解析产物 id：显式给了就校验，没给就从 name 派生。
 * @param {unknown} rawId
 * @param {unknown} name
 * @param {string} prefix 派生前缀（`ai` / `ai-theme` / `userscript`）
 */
function resolveId(rawId: unknown, name: unknown, prefix: string) {
  const explicit = text(rawId)
  if (explicit) {
    if (!ID_PATTERN.test(explicit)) {
      throw fail('STUDIO_ID_INVALID', `id「${explicit}」不合法：只能包含字母、数字与 . _ -，且以字母或数字开头（≤64 字符）`)
    }
    return explicit
  }
  const slug = slugify(name)
  const id = `${prefix}-${slug || Date.now().toString(36)}`.slice(0, 64)
  if (!ID_PATTERN.test(id)) throw fail('STUDIO_ID_INVALID', `无法从名称生成合法 id（${id}），请显式提供 id`)
  return id
}

/**
 * 相对路径守卫（**写盘前必须过**）。
 * @param {unknown} raw
 * @returns {string} 合法则返回归一化（`/` 分隔）路径；否则空串
 */
function safeRelPath(raw: unknown) : string {
  const name = String(raw == null ? '' : raw).replace(/\\/g, '/').trim()
  if (!name || name.endsWith('/')) return ''
  if (name.startsWith('/')) return ''
  if (/^[a-zA-Z]:/.test(name)) return ''
  const parts = name.split('/')
  // 任一空段 / `.` / `..` / 隐藏段都拒绝 —— 后者也顺带挡住了 `.git` 这类目录。
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return ''
  return parts.join('/')
}

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * 文件清单归一化：支持 `[{ path, content }]` 与 `{ "main.js": "…" }` 两种写法。
 * 对象 / 数组内容会被序列化成 JSON 文本（模型经常直接把 json 文件写成对象）。
 *
 * @param {unknown} raw
 * @returns {Array<{ path: string, content: string }>}
 */
function normalizeFiles(raw: unknown): StudioFile[] {
  let entries: Array<[unknown, unknown]> = []
  if (Array.isArray(raw)) {
    entries = raw.map((item) => [item && item.path, item && item.content])
  } else if (raw && typeof raw === 'object') {
    entries = Object.entries(raw)
  }

  if (entries.length > MAX_FILES) {
    throw fail('STUDIO_FILES_LIMIT', `文件太多（${entries.length} 个），上限 ${MAX_FILES} 个`)
  }

  const seen = new Set<string>()
  const out: StudioFile[] = []
  let total = 0
  for (const [rawPath, rawContent] of entries) {
    const name = safeRelPath(rawPath)
    if (!name) {
      throw fail('STUDIO_FILE_PATH', `文件路径「${text(rawPath)}」不合法：必须是相对路径，不能包含 .. / 盘符 / 隐藏段`)
    }
    if (name === MANIFEST_NAME) {
      throw fail('STUDIO_MANIFEST', `${MANIFEST_NAME} 由系统生成，不要自己写`)
    }
    if (seen.has(name)) throw fail('STUDIO_FILE_DUPLICATE', `文件重复：${name}`)
    seen.add(name)

    const ext = extensionOf(name)
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw fail('STUDIO_FILE_TYPE', `不支持的文件类型「${ext || '无扩展名'}」：只接受 ${ALLOWED_EXTENSIONS.join(' / ')}`)
    }

    let content
    if (typeof rawContent === 'string') content = rawContent
    else if (rawContent && typeof rawContent === 'object') content = JSON.stringify(rawContent, null, 2)
    else if (rawContent == null) content = ''
    else content = String(rawContent)

    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      throw fail('STUDIO_FILE_SIZE', `文件「${name}」过大（${Math.ceil(bytes / 1024)}KB，上限 ${MAX_FILE_BYTES / 1024}KB）`)
    }
    total += bytes
    if (total > MAX_TOTAL_BYTES) {
      throw fail('STUDIO_TOTAL_SIZE', `产物总大小超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB`)
    }

    out.push({ path: name, content })
  }
  return out
}

/**
 * `files` 里若夹带了 `hira-plugin.json`，把它的**内容当作 manifest 输入**。
 *
 * 为什么不直接报错：模型（和人）最自然的写法就是「把 manifest 也当文件交上来」，
 * 而 manifest 最终**仍然由本模块重建**（信任级 / 签名 / 权限一律归一化），
 * 收紧成报错只会让一次本来正确的创作白跑一轮。这里只把它从文件清单里摘掉、
 * 内容合并进 manifest；显式的 `manifest` 参数优先。
 *
 * @param {unknown} rawFiles `[{ path, content }]` 或 `{ "main.js": "…" }`
 * @returns 插件文件与已归一化的清单；没有清单时为 `null`
 */
function adoptManifestFile(rawFiles: unknown): { files: unknown; manifest: StudioManifest | null } {
  let entries: Array<[unknown, unknown]> = []
  if (Array.isArray(rawFiles)) {
    entries = rawFiles.map((item) => [item && item.path, item && item.content])
  } else if (rawFiles && typeof rawFiles === 'object') {
    entries = Object.entries(rawFiles)
  } else {
    return { files: rawFiles, manifest: null }
  }

  let manifest: StudioManifest | null = null
  const kept: Array<{ path: unknown; content: unknown }> = []
  for (const [rawPath, rawContent] of entries) {
    if (safeRelPath(rawPath) !== MANIFEST_NAME) {
      kept.push({ path: rawPath, content: rawContent })
      continue
    }
    let parsed
    if (rawContent && typeof rawContent === 'object' && !Array.isArray(rawContent)) {
      parsed = rawContent
    } else {
      try {
        parsed = JSON.parse(String(rawContent == null ? '' : rawContent))
      } catch (e) {
        throw fail('STUDIO_MANIFEST', `${MANIFEST_NAME} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw fail('STUDIO_MANIFEST', `${MANIFEST_NAME} 必须是一个 JSON 对象`)
    }
    manifest = { ...(manifest || {}), ...parsed }
  }
  // 没夹带 manifest 时原样返回，交给 normalizeFiles 走它本来的校验（含错误文案）。
  return manifest ? { files: kept, manifest } : { files: rawFiles, manifest: null }
}

/** 权限 scope 白名单校验（未知 scope 报错，不静默丢弃）。 */
function normalizePermissions(raw: unknown): string[] {
  if (raw == null || raw === '') return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  const invalid: string[] = []
  for (const item of list) {
    const scope = text(item)
    if (!scope) continue
    if (!SCOPE_KEYS.includes(scope)) {
      invalid.push(scope)
      continue
    }
    if (!out.includes(scope)) out.push(scope)
  }
  if (invalid.length) {
    throw fail('STUDIO_PERMISSION_INVALID', `未知权限 scope：${invalid.join(', ')}。可用值：${SCOPE_KEYS.join(', ')}`)
  }
  return out
}

/**
 * 面板声明里**宿主不认的字段**（不是契约的一部分）。
 *
 * 能映射成 `ui` 的别名直接取自运行时那份表（`PANEL_UI_FIELD_ALIASES`），
 * 这里只额外列出「纯自创、没有任何语义」的键。两份手写清单必然漂移，
 * 最终表现为「生成时说合法、宿主说没有」。
 */
const PANEL_IGNORED_FIELDS = Object.freeze([
  'module', 'renderer', 'renderEntry', 'panelRender'
])
/** 别名中除了 `ui` / `uiEntry`（已单独处理）之外的键：出现时尝试映射为 ui。 */
const PANEL_ALIAS_FIELDS = Object.freeze(
  (PANEL_UI_FIELD_ALIASES as string[]).filter((key: string) => key !== 'ui' && key !== 'uiEntry')
)
const PANEL_LEGACY_FIELDS = Object.freeze([...PANEL_ALIAS_FIELDS, ...PANEL_IGNORED_FIELDS])

/**
 * 从文件清单里挑一个「看起来就是渲染入口」的文件。
 *
 * 为什么需要它：真实事故里模型把 `render` 写成了 `main.cjs`（主进程入口），
 * 而真正的面板实现放在 `render.js` —— 结果 manifest 合法、文件都在、面板永远加载失败。
 * 这种情况属于「声明与文件对不上」，能在创作侧纠正就不该留给用户排查。
 * 候选顺序与注册中心的自愈共用 `renderEntryCandidates`（同一份口径）。
 *
 * @param {StudioFile[]} files
 * @param {string} id 插件 id（用于匹配 `<id>.renderer.js`）
 * @param {string} exclude 已经在用的入口（通常是 main），不作为候选
 */
function pickRenderCandidate(files: StudioFile[], id: string, exclude: string) {
  const available = new Set((Array.isArray(files) ? files : []).map((file: StudioFile) => file.path))
  return (renderEntryCandidates(id) as string[]).find((name: string) => name !== exclude && available.has(name)) || ''
}

/** 图标可以是一段原文（图片 / SVG），这类不查名字表。 */
function isIconSpecText(value: unknown): boolean {
  const textValue = text(value)
  if (!textValue) return false
  return /^data:image\//i.test(textValue) ||
    /^(hira-plugin|https?):\/\//i.test(textValue) ||
    /<svg[\s>]/i.test(textValue)
}

/**
 * `contributes.panels[]` → **契约以内的形状**（icon / title / ui 全部归一）。
 *
 * 为什么必须在创作侧做：面板声明是插件与宿主之间最容易被"想当然"的地方。
 * 真实事故：模型写了 `icon: "bookmark"`（当时不在名字表里 → 空白按钮）、
 * 自创 `entry / html / renderEntry`（宿主只认 `ui` → 声明了却永远「尚未实现」）。
 * 这些都是**生成时就该纠正**的，而不是等用户点开面板看见空白。
 *
 * 规则：
 *   · icon：名字归一到注册名；认不出来的回落 `Puzzle` 并给出合法名单（不静默留白）；
 *     同时允许 data URL / `hira-plugin://` / `<svg>` 原文（插件自带图形）。
 *   · ui：唯一字段。历史别名（entry/html/view/…）若指向真实存在的 HTML/XAML，
 *     自动映射成 `ui.entry` 并提示；指向别的文件则忽略并提示。
 *   · 面板必须有实现：manifest.render 或每块面板的 ui，缺一个就报错（附修法）。
 *
 * @param {any} contributes
 * @param {StudioFile[]} files
 * @param {string[]} warnings
 */
function normalizePanelContributions(contributes: unknown, files: StudioFile[], warnings: string[]): void {
  if (!contributes || typeof contributes !== 'object') return
  const contribution = contributes as UnknownRecord
  const raw = contribution.panels
  if (!raw) return

  /** 数组是标准写法；对象写法（id → 声明）也接受 —— 模型两种都写过。 */
  const entries: unknown[] = Array.isArray(raw)
    ? raw as unknown[]
    : (typeof raw === 'object'
      ? Object.entries(raw).map(([id, value]) => (
        value && typeof value === 'object' ? { id, ...value } : { id }
      ))
      : [])

  const available = new Set((Array.isArray(files) ? files : []).map((file: StudioFile) => file.path))
  const seen = new Set<string>()
  const out: PanelContribution[] = []

  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const panel: PanelContribution = { ...(item as PanelContribution) }
    const id = text(panel.id)
    if (!id) {
      throw fail('STUDIO_PANEL_ID', 'contributes.panels[] 的每一项都必须有 id（面板被打开时用的稳定标识）')
    }
    if (!ID_PATTERN.test(id)) {
      throw fail('STUDIO_PANEL_ID', `面板 id「${id}」不合法：只能包含字母、数字与 . _ -，且以字母或数字开头（≤64 字符）`)
    }
    if (seen.has(id)) throw fail('STUDIO_PANEL_ID', `面板 id 重复：${id}`)
    seen.add(id)
    panel.id = id
    // 标题：title 是契约字段；name / label 是模型常用的等价写法，收进来后删掉。
    panel.title = text(panel.title || panel.name || panel.label) || id
    delete panel.name
    delete panel.label

    // ── 图标 ────────────────────────────────────────────────
    const iconSpec = text(panel.icon)
    if (!iconSpec) {
      panel.icon = 'Puzzle'
    } else if (isIconSpecText(iconSpec)) {
      panel.icon = iconSpec
    } else {
      const canonical = normalizeIconName(iconSpec)
      if (canonical) {
        panel.icon = canonical
      } else {
        warnings.push(
          `面板 ${id} 的图标「${iconSpec}」不是已知图标名，已回落 Puzzle。` +
          `可用名（节选）：${ICON_NAME_SUGGESTIONS.slice(0, 24).join(', ')} …`
        )
        panel.icon = 'Puzzle'
      }
    }

    // ── 声明式 UI 面 ────────────────────────────────────────
    let uiDecl = panel.ui != null ? panel.ui : panel.uiEntry
    let legacyField = ''
    for (const key of PANEL_LEGACY_FIELDS) {
      if (panel[key] == null) continue
      const value = text(panel[key]).replace(/^\.?\//, '')
      if (uiDecl == null && value && available.has(value) && isPanelUiEntry(value)) {
        uiDecl = value
        legacyField = key
      }
      delete panel[key]
    }
    if (uiDecl != null && uiDecl !== '') {
      const ui = normalizePanelUi(uiDecl)
      if (!ui) {
        throw fail(
          'STUDIO_PANEL_UI',
          `面板 ${id} 的 ui 入口不合法：只接受插件内的 .html / .htm / .xaml 相对路径（收到「${text(uiDecl)}」）`
        )
      }
      if (!available.has(ui.entry)) {
        throw fail('STUDIO_PANEL_UI_MISSING', `面板 ${id} 的 ui 入口「${ui.entry}」不在 files 里`)
      }
      panel.ui = ui
      if (legacyField) {
        warnings.push(`面板 ${id} 用了非标准字段 ${legacyField}，已映射为 ui（契约字段只有 ui）`)
      }
    }
    out.push(panel)
  }

  contribution.panels = out
}

/**
 * 模型常用的面板贡献别名先归一。
 *
 * `sidebarPanels` 这类字段过去会被静默忽略，validate 仍返回 ready，模型只能再读一次
 * 手册重写。这里把明确无歧义的别名直接映射到 `panels` 并返回 warning；若标准字段
 * 与别名同时存在则不猜，直接报冲突。
 */
function normalizeContributionAliases(contributes: unknown, warnings: string[]): void {
  if (!contributes || typeof contributes !== 'object') return
  const record = contributes as UnknownRecord
  const aliases = ['sidebarPanels', 'sidePanels', 'sidebar-panels', 'sidebarPanel', 'sidePanel', 'panel']
  for (const alias of aliases) {
    if (record[alias] == null) continue
    if (record.panels != null) {
      throw fail('STUDIO_PANEL_CONFLICT', `contributes.${alias} 与标准字段 contributes.panels 同时存在，请只保留 panels`)
    }
    record.panels = record[alias]
    delete record[alias]
    warnings.push(`contributes.${alias} 已自动映射为 contributes.panels`)
  }
  if (record.panels == null) {
    const suspicious = Object.keys(record).filter((key) => /panel/i.test(key))
    if (suspicious.length) {
      throw fail(
        'STUDIO_PANEL_FIELD_UNKNOWN',
        `未知面板贡献字段：${suspicious.join(', ')}。标准字段只有 contributes.panels；可用别名：${aliases.join(' / ')}`
      )
    }
  }
}

/**
 * 统一收口 manifest：强制 local 信任级 + 权限白名单 + 入口文件自检 + 面板契约。
 *
 * @param {any} raw
 * @param {StudioFile[]} files
 * @param {string[]} [warnings] 非致命问题（回落 / 别名映射）都记在这里
 */
function finalizeManifest(raw: unknown, files: StudioFile[], warnings: string[] = []): StudioManifest {
  const input: StudioManifest = raw && typeof raw === 'object' ? { ...(raw as StudioManifest) } : {}
  // 模型不能自带签名：签名的语义是"作者对内容负责"，而这里的内容是模型刚写的。
  delete input.signature
  delete input.signatureKeyId
  // 渲染入口版本由注册中心按 mtime 生成，产物不该声明。
  delete input.renderVersion

  const available = new Set((Array.isArray(files) ? files : []).map((file) => file.path))
  // `render` 必须是**可加载模块**。写成 `.html/.xaml` 是最常见的误解（把声明式文档
  // 当成了"渲染入口"）—— 那不是模块，`import()` 必然失败，面板于是永远「尚未实现」。
  // 这里把它**改判成顶层 UI 面**（面板可继承），再按文件清单找一个真正的模块入口。
  const renderDecl = text(input.render)
  if (renderDecl && !isRenderModulePath(renderDecl)) {
    const uiDecl = normalizePanelUi(renderDecl)
    if (uiDecl) {
      if (!input.ui) input.ui = uiDecl.entry
      warnings.push(
        `render 指向 ${renderDecl}：render 只能是 .js/.mjs/.cjs 模块（声明式文档属于 ui），已改判为顶层 UI 面`
      )
    } else {
      warnings.push(`render 指向 ${renderDecl}，既不是模块也不是 .html/.xaml，已忽略`)
    }
    delete input.render
  }
  for (const key of ['main', 'render']) {
    const entry = text(input[key])
    if (!entry) continue
    const safe = safeRelPath(entry)
    if (!safe || !available.has(safe)) {
      throw fail('STUDIO_ENTRY_MISSING', `manifest 的 ${key} 指向「${entry}」，但 files 里没有这个文件`)
    }
    input[key] = safe
  }
  // 顶层 UI 面（模型常写 html / view / entry）：文件必须真实存在，否则面板必然白屏。
  const manifestUiDecl = text(input.ui || input.html || input.view)
  if (manifestUiDecl) {
    const ui = normalizePanelUi(manifestUiDecl)
    const rel = ui ? ui.entry : ''
    if (!ui || !available.has(rel)) {
      throw fail('STUDIO_PANEL_UI_MISSING', `manifest 的 ui 入口「${manifestUiDecl}」不在 files 里（或不是 .html/.htm/.xaml）`)
    }
    input.ui = rel
  }
  delete input.html
  delete input.view
  delete input.entryFile

  input.trustLevel = 'local'
  const requestedLevel = text(input.permissionLevel)
  if (requestedLevel && !PERMISSION_LEVELS.includes(requestedLevel)) {
    warnings.push(`permissionLevel「${requestedLevel}」不合法，已归一为 ui（可选：${PERMISSION_LEVELS.join(' / ')}）`)
  }
  input.permissionLevel = requestedLevel && PERMISSION_LEVELS.includes(requestedLevel) ? requestedLevel : 'ui'
  input.requestedPermissions = normalizePermissions(input.requestedPermissions)

  // 面板契约：icon / title / ui 归一，并确保每块面板都有实现来源。
  normalizeContributionAliases(input.contributes, warnings)
  normalizePanelContributions(input.contributes, files, warnings)
  const panels: PanelContribution[] = input.contributes && Array.isArray(input.contributes.panels)
    ? input.contributes.panels as PanelContribution[]
    : []
  if (panels.length) {
    // render 与 main 指向同一个文件 = 主进程入口被当成渲染入口（真实事故）。
    // 文件清单里另有「像渲染入口」的文件时直接改过去，并把原因讲清楚。
    const candidate = pickRenderCandidate(files, text(input.id), text(input.main))
    if (!input.render && candidate) {
      input.render = candidate
      warnings.push(`manifest 没写 render，已按文件清单自动指向 ${candidate}（面板的实现来源）`)
    } else if (input.render && input.render === input.main && candidate) {
      warnings.push(
        `render 与 main 都指向 ${input.render}：主进程入口不能当渲染入口，已改用 ${candidate}`
      )
      input.render = candidate
    }
    // 顶层 UI 面可被每块面板继承（`{ html: 'panel.html', panels: [{ id }] }` 这种写法）。
    const inheritedUi = panelUiFromManifest(input)
    const hasImpl = (panel: PanelContribution) => !!input.render || !!(panelUiFromContribution(panel) || inheritedUi)
    if (!input.render) {
      const dead = panels.filter((p) => !hasImpl(p)).map((p) => p.id)
      if (dead.length === panels.length) {
        throw fail(
          'STUDIO_PANEL_NO_IMPL',
          `面板 ${dead.join('、')} 没有任何实现：请在 manifest 里提供 render（渲染入口 .js/.mjs/.cjs），` +
          '或给每块面板写 ui（声明式 HTML 面的相对路径）'
        )
      }
      if (dead.length) {
        warnings.push(
          `面板 ${dead.join('、')} 没有实现：manifest 没有 render，面板自己也没写 ui，打开会显示「尚未实现」`
        )
      }
    }
    if (input.render && /\.cjs$/i.test(String(input.render))) {
      warnings.push(
        'render 指向 .cjs：能加载，但里面不能 require()。渲染入口推荐写成自包含的 ESM（.js / .mjs）'
      )
    }
  }
  return input
}

/**
 * kind = plugin
 * @param {any} req
 */
function preparePlugin(req: StudioRequest = {}): PreparedArtifact & { warnings: string[] } {
  const warnings: string[] = []
  const adopted = adoptManifestFile(req.files)
  if (adopted.manifest) {
    warnings.push(
      `${MANIFEST_NAME} 已当作 manifest 输入处理（最终仍由系统重建：信任级 / 签名 / 权限一律归一化）`
    )
  }
  // 显式的 manifest 参数优先于文件里的同名键 —— 调用方最后说明的意图最可信。
  const raw: StudioManifest = { ...(adopted.manifest || {}), ...(req.manifest && typeof req.manifest === 'object' ? req.manifest as StudioManifest : {}) }
  const files: StudioFile[] = normalizeFiles(adopted.files)
  const contributes = raw.contributes !== undefined ? raw.contributes : req.contributes
  normalizeContributionAliases(contributes, warnings)
  /**
   * 允许「纯数据插件」：只有 manifest + contributes、不写一行代码。
   * 但两者都没有 = 一个装进去什么都不做的空壳，直接拒绝（安装器那边也过不了）。
   */
  if (!files.length && !(contributes && typeof contributes === 'object' && Object.keys(contributes).length)) {
    throw fail('STUDIO_FILES_EMPTY', '插件至少要有一个文件（例如 main.cjs / render.js）；纯声明式插件也可以只写 contributes。')
  }

  const id = resolveId(req.id || raw.id, req.name || raw.name, 'ai')
  /** 非致命提示（图标回落 / 别名映射 / 入口建议）—— 一起交给模型与用户。 */
  const manifest = finalizeManifest({
    ...raw,
    id,
    name: text(req.name || raw.name) || id,
    version: text(req.version || raw.version) || '1.0.0',
    description: text(req.description || raw.description),
    author: text(raw.author) || 'AI 助手',
    // 类型由声明推导：有面板 = `ui-panel-plugin`（插件中心「界面面板插件」栏）。
    // 默认落到 feature-plugin 会让面板插件出现在「功能插件（引擎）」里。
    type: resolvePluginType({ ...raw, contributes }),
    // 顶层 `contributes` / `permissions` 是扁平写法，manifest 里的同名字段优先。
    contributes,
    requestedPermissions: raw.requestedPermissions !== undefined
      ? raw.requestedPermissions
      : req.permissions
  }, files, warnings)

  return { ok: true, kind: 'plugin', id, manifest, files, warnings }
}

/**
 * kind = theme
 * @param {any} req
 */
function prepareTheme(req: StudioRequest = {}): PreparedArtifact {
  const rawTheme = req.theme && typeof req.theme === 'object' ? req.theme as UnknownRecord : null
  if (!rawTheme) throw fail('STUDIO_THEME_EMPTY', '缺少 theme 对象（至少需要 colors）')

  const id = resolveId(req.id || rawTheme.id, req.name || rawTheme.name, 'ai-theme')
  const theme = normalizeTheme({
    ...rawTheme,
    id,
    name: text(req.name || rawTheme.name) || id,
    version: text(req.version || rawTheme.version) || '1.0.0',
    source: 'plugin'
  })

  if (!Object.keys(theme.colors || {}).length) {
    throw fail('STUDIO_THEME_COLORS', '主题没有可用颜色：colors 至少需要一个合法色值（例如 bg / fg / accent）')
  }
  const backgroundKind = theme.background && theme.background.kind
  if (backgroundKind === 'image' || backgroundKind === 'video') {
    throw fail('STUDIO_THEME_BINARY', 'AI 主题不能携带图片 / 视频背景（只写文本文件）。请改用 background.kind = "css" 或 "color"')
  }

  const files: StudioFile[] = [{ path: THEME_FILE_NAME, content: `${JSON.stringify(theme, null, 2)}\n` }]
  const manifest = finalizeManifest({
    id,
    name: theme.name || id,
    version: theme.version || '1.0.0',
    description: text(req.description || rawTheme.description),
    author: text(rawTheme.author) || 'AI 助手',
    type: 'theme-plugin',
    permissionLevel: 'ui',
    contributes: { themes: [theme] }
  }, files)

  return { ok: true, kind: 'theme', id, manifest, files }
}

/**
 * kind = userscript
 * @param {any} req
 */
function prepareUserScript(req: StudioRequest = {}): PreparedArtifact {
  const source = text(req.userscript)
  if (!source) throw fail('STUDIO_USERSCRIPT_EMPTY', '缺少 userscript 脚本内容（需要 ==UserScript== 元数据头）')
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_BYTES) {
    throw fail('STUDIO_USERSCRIPT_SIZE', `脚本超过 ${MAX_FILE_BYTES / 1024}KB 上限`)
  }

  const meta = parseUserScriptMeta(source)
  if (meta.error) throw fail('STUDIO_USERSCRIPT_INVALID', meta.error)
  if (!meta.name) throw fail('STUDIO_USERSCRIPT_INVALID', '脚本缺少 @name')
  if (!meta.match.length && !meta.include.length) {
    throw fail('STUDIO_USERSCRIPT_SCOPE', '脚本没有声明 @match 或 @include，无法确定在哪些页面运行')
  }

  const id = req.id
    ? resolveId(req.id, meta.name, 'userscript')
    : undefined
  const manifest = finalizeManifest(buildUserScriptPluginManifest(meta, {
    file: SCRIPT_FILE_NAME,
    trustLevel: 'local',
    ...(id ? { id } : {}),
    ...(req.version ? { version: text(req.version) } : {})
  }), [{ path: SCRIPT_FILE_NAME, content: source }])

  const files: StudioFile[] = [{ path: SCRIPT_FILE_NAME, content: `${source.replace(/^\uFEFF/, '').trimEnd()}\n` }]
  return { ok: true, kind: 'userscript', id: text(manifest.id), manifest, files }
}

/**
 * 把一轮模型参数变成「可落盘的 manifest + 文件清单」。
 *
 * @param {any} req `studio_create` 的参数
 * @returns {{ ok: true, kind: string, id: string, manifest?: any, files: Array<{ path: string, content: string }> }}
 */
function prepareArtifact(req: StudioRequest = {}): PreparedArtifact {
  const input = req
  const kind = text(input.kind || 'plugin').toLowerCase()
  if (!STUDIO_KINDS.includes(kind)) {
    throw fail('STUDIO_KIND_UNKNOWN', `不支持的产物类型「${kind}」，可选：${STUDIO_KINDS.join(' / ')}`)
  }
  if (kind === 'skill') {
    const skill = input.skill && typeof input.skill === 'object' ? input.skill as UnknownRecord : {}
    return { ok: true, kind, id: text(skill.id || input.id), files: [] }
  }
  if (kind === 'theme') return prepareTheme(input)
  if (kind === 'userscript') return prepareUserScript(input)
  return preparePlugin(input)
}

/** 给模型看的「我能造什么」（纯数据；`userDir` 由 main 层补）。 */
function capabilities() {
  return {
    kinds: [
      {
        kind: 'plugin',
        label: '插件',
        description: '声明式贡献（contributes）+ 可选 main.cjs / render.js；装完出现在插件中心，可启停 / 卸载。' +
          '带 contributes.panels 时自动归为「界面面板插件」，不需要 main',
        files: '文本文件，如 panel.html、render.js、main.cjs'
      },
      {
        kind: 'theme',
        label: '主题',
        description: 'contributes.themes 贡献；装完立即出现在主题库（背景只支持纯色 / CSS，不支持图片 / 视频）',
        files: '由系统生成 theme.json'
      },
      {
        kind: 'userscript',
        label: '用户脚本',
        description: '带 ==UserScript== 头的脚本；必须有 @name 与 @match/@include。' +
          '装完即是一个插件（userscript-plugin），在匹配站点加载后执行，可在「注入」面板单条启停；' +
          'GM API 白名单 / @require / @connect 规则见 studio_guide section=userscript',
        files: '由系统生成 script.user.js'
      },
      {
        kind: 'skill',
        label: '技能',
        description: '用户技能（prompt / script / agent），存数据库，可在技能面板编辑',
        files: '无'
      }
    ],
    /** 插件中心的分栏依据（type）。不写时由声明推导，见 derived。 */
    pluginTypes: {
      values: [...PLUGIN_TYPES],
      derived: '未写 type 时：有 contributes.panels（或顶层 ui）→ ui-panel-plugin（界面面板插件），否则 feature-plugin（功能插件 / 引擎）'
    },
    permissions: [...SCOPE_KEYS],
    /**
     * 面板契约 —— 这几条是「为什么没图标 / 为什么未实现」的全部答案。
     * 放在 capabilities 里，模型一次就能读到，不用翻文档。
     */
    panels: {
      where: 'manifest.contributes.panels[]',
      fields: {
        id: '必填，稳定标识（字母/数字/. _ -，≤64）',
        title: '显示名；缺省用 id',
        icon: '图标名（见 icons，大小写/别名都认）或 data:image/... 或 <svg>…</svg> 原文；缺省 Puzzle',
        ui: '声明式 HTML 面的相对路径（.html/.htm/.xaml）；与 render 二选一或并用。' +
          '也可以只在 manifest 顶层写一次 ui，所有面板共用（面板项里只留 id）'
      },
      implementations: [
        'render：manifest.render 指向**可执行模块**，扩展名只认 .js/.mjs/.cjs（推荐 ESM）；' +
          '写成 .html 会被当成声明式 ui，而不是渲染入口',
        'ui：每块面板（或 manifest 顶层）给 ui（插件内 HTML 文件），宿主以沙箱 iframe 承载；' +
          `字段别名 ${PANEL_UI_FIELD_ALIASES.join('/')} 都认，但只有指向 .html/.htm/.xaml 才算`,
        '两者都没有 = 声明了一块画不出来的面板，会被拒绝（STUDIO_PANEL_NO_IMPL）',
        'render 缺省时若目录里有 render.js / <id>.renderer.js 等候选，安装后会自动补上'
      ],
      /** 能映射成 `ui` 的别名（与运行时同一份表）。 */
      aliases: [...PANEL_UI_FIELD_ALIASES],
      /** 纯自创、没有任何语义的字段：会被清掉。 */
      ignoredFields: [...PANEL_IGNORED_FIELDS],
      example: {
        render: 'render.js',
        contributes: {
          panels: [{ id: 'my-panel', title: '我的面板', icon: 'Puzzle', ui: 'panel.html' }]
        }
      }
    },
    /**
     * 声明式面板（`ui: "panel.html"`）的**完整编写契约** —— 一次读全，不用查文档：
     *   · `manifestExample` 可直接复制的 manifest；
     *   · `panelHtml` / `panelScript` 骨架（不需要自己声明 hira:// 脚本或 CSP）；
     *   · `hostInjects` 宿主自动注入的 7 段（base / CSP / 主题变量 / 身份脚本 / 桥 / …）；
     *   · `dataAttributes` `<html>` 上的 data-hira-* 约定；
     *   · `capabilities` / `events` 运行时能力与事件表（与桥共用同一份真源）；
     *   · `notes` 高频踩坑（module 脚本 / CDN / localStorage 等）。
     */
    panelUi: panelUiAuthoringGuide(),
    /** 可用图标名（写 icon 时从这里挑；其它名字会被回落成 Puzzle 并给出 warning）。 */
    icons: [...ICON_NAME_SUGGESTIONS],
    limits: {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      extensions: [...ALLOWED_EXTENSIONS]
    },
    trustLevel: 'local',
    permissionLevels: [...PERMISSION_LEVELS],
    manifestName: MANIFEST_NAME
  }
}

/**
 * 用户脚本创作规范（Markdown）。
 *
 * 与 `packages/shared-types/src/userscript.mjs` **同源**：那里定义解析 / 匹配 / GM 垫片，
 * 这里只是给模型看的说明。改语义必须两处一起改 —— 否则模型会照着过时的说明写脚本，
 * 表现是"装上了但某站点不生效 / GM_xmlhttpRequest 永远被拒"。
 */
const USERSCRIPT_AUTHORING_MARKDOWN = [
  '# 用户脚本（Tampermonkey 风格）',
  '',
  '> 安装方式：`studio_create { kind: "userscript", userscript: "<脚本全文>" }`。',
  '> 脚本在本项目里**就是插件**（`type: "userscript-plugin"`），装完可在「注入」面板单条启停。',
  '',
  '## 1. 结构',
  '',
  '```js',
  '// ==UserScript==',
  '// @name        示例：去掉某站的登录遮挡',
  '// @namespace   demo',
  '// @version     1.0.0',
  '// @description 一句话说明这个脚本做什么',
  '// @match       https://example.com/*',
  '// @grant       none',
  '// ==/UserScript==',
  '(function () {',
  '  // …',
  '})();',
  '```',
  '',
  '- 元数据头必须**首尾闭合**（`==/UserScript==`），否则拒绝安装。',
  '- `@name` 必填；`@match` / `@include` **至少一条**，否则无法确定在哪些页面运行。',
  '- 标量键取第一条非空值；`@match` `@include` `@exclude` `@grant` `@require` `@connect` `@resource` 可写多行。',
  '',
  '## 2. `@match` 写法',
  '',
  '支持 Chrome 风格 `<scheme>://<host><path>`（`*` 通配）、`<all_urls>`、以及 `/正则/flags`：',
  '',
  '- `https://*.example.com/*` —— 子域；**不含裸域** `example.com`，需要就再写一行。',
  '- `*://*/*` —— 全部 http / https 页面。',
  '- 用户脚本只注入 **http / https** 页面（`file:` / `about:` 不生效）。',
  '',
  '## 3. `@grant` 与 GM API',
  '',
  '不写 `@grant` 或写 `@grant none` = 只用原生 DOM API。宿主内置（无需引入库）：',
  '',
  '`GM_getValue` `GM_setValue` `GM_deleteValue` `GM_listValues` `GM_addStyle` `GM_log` `GM_setClipboard` `GM_openInTab` `GM_info` `unsafeWindow`',
  '',
  '- 存储落在页面 `localStorage`，按 `插件:脚本` 命名空间隔离（刷新仍在、同域共享）。',
  '- `GM_xmlhttpRequest` **必须**显式 `@grant GM_xmlhttpRequest`，并用 `@connect` 声明目标域：',
  '  `@connect example.com` / `@connect *.example.com` / `@connect *`。',
  '  请求由主进程发出，授权判定也在主进程 —— URL 与 `@connect` 不匹配会被直接拒绝。',
  '',
  '## 4. `@require`',
  '',
  '- `@require https://cdn.example.com/lib.min.js` —— 宿主取回后与脚本**同作用域内联**（Tampermonkey 语义）。',
  '- 只接受 http / https；首次要联网（带 7 天缓存）。取不到时脚本仍会跑，只是少了那个库。',
  '- 优先用原生 API；非必要不引第三方库（体积与失败点都更多）。',
  '',
  '## 5. `@run-at`',
  '',
  '`document-start` / `document-end`（默认）/ `document-idle`。',
  '当前宿主在**页面加载完成**后注入（等价于 document-end）；需要"页面一出现就改"的脚本，',
  '请自己在脚本里用 `MutationObserver` 监听，不要依赖 document-start。',
  '',
  '## 6. 硬规则',
  '',
  '- 全部逻辑包在 IIFE 里，别污染页面全局；`unsafeWindow` 才是页面世界。',
  '- 不用 `eval` / `new Function`（页面 CSP 会拦）；不读取本地文件。',
  '- 注入样式用 `GM_addStyle`，不要 `document.write`。',
  '- **幂等**：SPA 会反复触发路由变化，用标记属性（如 `data-hira-done`）防重复插入。',
  '- 自己 try/catch，别让一条脚本的异常影响页面；需要排查时用 `GM_log`。',
  '',
  '## 7. 提交前自检',
  '',
  '- [ ] 元数据头首尾闭合，`@name` 非空。',
  '- [ ] 至少一条 `@match` / `@include`，且正是目标站点。',
  '- [ ] 用了 `GM_xmlhttpRequest` 就同时写了 `@grant` 与 `@connect`。',
  '- [ ] `@require` 全部是 https 且可访问。',
  '- [ ] 重复执行不会插入两份 UI。'
].join('\n')

/** 章节菜单（id / 标题 / 说明）—— 工具描述与模型索引共用同一份。 */
interface GuideSection { id: string; title: string; summary?: string; markdown?: string }

const USERSCRIPT_GUIDE_SECTION = Object.freeze({
  id: 'userscript',
  title: '用户脚本（Tampermonkey 风格）',
  summary: '元数据头必填项 / @match 写法 / @grant 白名单 / @connect / @require'
})
const GUIDE_SECTIONS: readonly GuideSection[] = Object.freeze([
  ...(PANEL_UI_AUTHORING_MENU as GuideSection[]),
  USERSCRIPT_GUIDE_SECTION
])
const GUIDE_SECTION_IDS: string[] = GUIDE_SECTIONS.map((section) => section.id)

/**
 * 单次手册正文的字符预算。
 *
 * 工具结果进模型有当前回合 24KB 上限（`turn-runner#TOOL_RESULT_LIMIT`），
 * 但整本手册仍会稀释当前任务；留出 JSON 包装余量后按预算逐节装 ——
 * 手册以后变长时，**末尾的节会自动退到 `remaining` 里让模型再取一次**，
 * 而不是被截断成残句。
 */
const GUIDE_MARKDOWN_BUDGET = 5200

/** 按「快速上手」优先级装节，装不下就跳过（后面的节可能更小）。 */
function digestSectionIds(): string[] {
  const authoringSections = panelUiAuthoringSections() as GuideSection[]
  const sizeById = new Map<string, number>(authoringSections.map((section) => [section.id, section.markdown?.length || 0]))
  const picked: string[] = []
  let used = 0
  for (const id of PANEL_UI_AUTHORING_DIGEST as string[]) {
    const size = sizeById.get(id) || 0
    if (picked.length && used + size > GUIDE_MARKDOWN_BUDGET) continue
    picked.push(id)
    used += size
  }
  return picked
}

/**
 * 固定创作手册（Markdown），**按节取用**。
 *
 * 为什么不塞进 `capabilities()`：手册约 10KB，只有真要写面板时才需要；
 * 为什么分节：整本手册会稀释当前任务；默认给「快速上手」包，其余按需取。
 *
 * 内容与运行时同源（`panel-ui-contract.mjs`），改契约即改手册。
 *
 * @param {{ section?: string }} [req] 逗号分隔的章节 id；`all` = 全本；不传 = 快速上手包
 */
function guide(req: { section?: string } = {}) {
  const raw = text(req && req.section)
  const asked = raw
    ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : digestSectionIds()
  const ids = asked.includes('all') ? GUIDE_SECTION_IDS.slice() : asked
  const unknown = ids.filter((id) => !GUIDE_SECTION_IDS.includes(id))
  if (unknown.length) {
    throw fail('STUDIO_GUIDE_SECTION', `未知章节：${unknown.join(', ')}。可用：${GUIDE_SECTION_IDS.join(', ')}（或 all）`)
  }
  // 两类章节分属两本手册：声明式面板（panel-ui-contract.mjs）与用户脚本（userscript.mjs）。
  // 各自只渲染被点到的那些，避免把另一本的正文也塞进 6KB 的预算里。
  const panelIds = ids.filter((id: string) => id !== USERSCRIPT_GUIDE_SECTION.id)
  const wantUserScript = ids.includes(USERSCRIPT_GUIDE_SECTION.id)
  const markdown = [
    panelIds.length ? panelUiAuthoringMarkdown(panelIds) : '',
    wantUserScript ? USERSCRIPT_AUTHORING_MARKDOWN : ''
  ].filter(Boolean).join('\n\n')
  return {
    ok: true,
    format: 'markdown',
    title: wantUserScript && !panelIds.length
      ? 'Hira 用户脚本创作规范'
      : 'Hira 插件 · 声明式面板创作规范',
    sections: ids,
    // 没返回的章节列出来 —— 模型不用猜"还有没有别的能看"。
    remaining: GUIDE_SECTIONS.filter((section) => !ids.includes(section.id)).map((section) => `${section.id}：${section.title}`),
    markdown
  }
}

module.exports = {
  STUDIO_KINDS,
  MANIFEST_NAME,
  prepareArtifact,
  capabilities,
  guide,
  GUIDE_SECTIONS
}
