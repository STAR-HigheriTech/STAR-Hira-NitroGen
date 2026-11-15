/**
 * plugin-ui.mjs —— 「插件 UI 面」的**纯规则层**（跨进程、零依赖、零 IO）。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────
 * 面板过去只有两种实现来源：仓库自带的 `ui/ui-panel-*` 包、插件自带的
 * `.renderer.js`。两者都要求**写代码并参与打包**，于是"只想画个界面"的插件
 * 被迫学习我们的渲染器协议。
 *
 * 本文件让第三种来源成立：插件交付一个 `.html`（或 `.xaml`）文件就是一块面板。
 * 但"允许插件交 HTML"这件事如果只是"塞进 iframe"，等于把浏览器交给陌生人：
 *   · srcdoc 的 iframe 一旦拿到 `allow-same-origin`，它的 origin 就继承父页面，
 *     一句 `parent.document` 就能改整个外壳 —— 所以沙箱串里**永远**不出现它；
 *   · 不给 CSP，插件里的 `fetch('https://…')` 就能把用户数据外送 —— 所以这里
 *     按插件的 `permissionLevel` **派生** CSP，而不是让插件自己声明；
 *   · 不给 `<base>`，所有相对路径（图片 / 样式 / 脚本）都会打到渲染页的源上 ——
 *     所以统一钉到 `hira-plugin://<id>/`，并由主进程协议做目录穿越防护。
 *
 * 于是"彻底开放"与"防恶意破坏"在这里同时成立：插件能画任何界面、能读写自己的
 * 数据（走桥，见 `plugin-ui-bridge.js`），但**碰不到壳、碰不到别人的数据、碰不到网**。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * 同一套规则有**三个**消费方，任何一处各写一遍都会漂移：
 *   1. 主进程协议（`plugin-protocol.js`）—— 哪些扩展名能当 UI 入口；
 *   2. 渲染层（`plugin-ui-frame.js`）—— 怎么把源码拼成最终文档；
 *   3. 校验器 / 安装器（`validate-plugin.cjs`、`plugin-installer.js`）—— 声明合法否。
 * 放在纯层 = 三者 import 同一个函数，形状不可能不一致。
 *
 * ── 与契约层的关系 ────────────────────────────────────────────────
 * `normalizePanelUi()` 的返回形状必须与
 * `infra/infra-ipc/src/contracts/plugins.js#panelUiEntrySchema` 逐字一致
 * （zod 只保留声明过的字段，漏一个字段 = 渲染层永远拿不到 ui）。
 */

import { normalizeIconName } from './icon-names.js'
// 字体栈唯一真源：插件 srcdoc 的宿主可信 CSS 里会注入主题令牌，因此优先用变量。
import { uiFontVar } from './font-stack.js'

/** 插件 UI 面使用的特权协议（与 `plugin-protocol.js#PLUGIN_SCHEME` 同源）。 */
export const PANEL_UI_SCHEME = 'hira-plugin'

/**
 * iframe 的 sandbox 串 —— **唯一定义处**。
 *
 * 只给脚本与表单：
 *   · 不给 `allow-same-origin`：文档停在 opaque origin，`parent.document` / 父级
 *     localStorage / IndexedDB 全部不可达（这是整个 UI 面安全模型的支点）；
 *   · 不给 `allow-popups` / `allow-top-navigation`：不能开窗、不能劫持外壳；
 *   · 不给 `allow-modals`：不能拿 `alert()` 卡死主线程。
 * 需要"开新标签 / 打开外链"时走 `hira.tabs.open()`（受 scope 门控），不是开洞。
 */
export const PANEL_UI_SANDBOX = 'allow-scripts allow-forms'

/** 支持的 UI 面种类（扩展名 → 种类）。 */
export const PANEL_UI_KINDS = Object.freeze(/** @type {const} */ ((['html', 'xaml']) as const))

/** 面板桥协议版本（子侧 `hira.app.info().bridgeVersion` 读的就是它）。 */
export const PANEL_UI_BRIDGE_VERSION = 1

/**
 * 插件类型（插件中心按它分栏）。**唯一真源** —— 注册中心、创作侧、列表页共用。
 *
 * 加一个新类型 = 这里加一项 + `pages/plugins/format.js` 加一段中文标题；
 * 不在这里的类型一律按 `feature-plugin` 归类，不会凭空多出一栏。
 */
export const PLUGIN_TYPES = Object.freeze([
  'core',
  'ai-skill-plugin',
  'feature-plugin',
  'ui-panel-plugin',
  'theme-plugin',
  'userscript-plugin',
  'community-mod'
])

/**
 * 推导插件类型：**有面板就是界面面板插件**。
 *
 * 为什么必须推导、不能默认 `feature-plugin`：插件中心按 type 分栏，而
 * `feature-plugin` 那一栏叫「功能插件」（引擎）。一个只贡献面板的插件若落进引擎栏，
 * 用户会去「引擎」里找自己的面板，看起来像插件根本没装上 —— 真实事故。
 *
 * 显式 `type` 永远优先：一个插件可以既提供能力又带面板，那时归类由作者决定。
 *
 * @param {any} input manifest（`contributes.panels` / 顶层 `ui` 任一存在即算面板插件）
 * @returns {string}
 */
export function resolvePluginType(input: unknown) : string {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const explicit = String(source.type || '').trim()
  if (explicit) return explicit
  const contributes = source.contributes && typeof source.contributes === 'object'
    ? source.contributes as Record<string, unknown>
    : {}
  const panels = Array.isArray(contributes.panels) ? contributes.panels : []
  if (panels.length) return 'ui-panel-plugin'
  // 顶层声明式 UI 等同于一整块面板（与 `panelUiFromManifest` 同一份判定）。
  if (input && panelUiFromManifest(input)) return 'ui-panel-plugin'
  return 'feature-plugin'
}

/**
 * 宿主写进面板文档的 **data-\* 约定** —— 面板作者可以据此写 CSS / 做分支，
 * 不必再去问宿主"我是谁"。
 *
 * 为什么要有这套属性：`hira.*` 只能在脚本里用，纯 CSS 场景（第一方主题微调、
 * 第三方按权限级别隐藏入口）没有其它稳定的判定入口。属性写在 `<html>` 上，
 * 由宿主注入的**可信脚本**设置（不经过插件源码），所以插件无法伪造。
 *
 * ⚠ 名字是契约：改名等于破坏已有面板，新增只能往后加。
 */
export const PANEL_UI_HOST_DATA_ATTRS = Object.freeze({
  /** 插件 id（小写目录名） */
  pluginId: 'data-hira-plugin-id',
  /** 面板 id（= contributes.panels[].id） */
  panelId: 'data-hira-panel-id',
  /** `html` / `xaml` */
  panelKind: 'data-hira-panel-kind',
  /** `none` / `ui` / `network` / `full` */
  permissionLevel: 'data-hira-permission-level',
  /** `"true"` / `"false"`（第一方插件为 true，scope 不再逐个授权） */
  firstParty: 'data-hira-first-party',
  /** 桥协议版本号 */
  bridgeVersion: 'data-hira-bridge-version'
})

/** 入口扩展名 → UI 种类。**唯一白名单**：不在这里的一律不是 UI 入口。 */
export const PANEL_UI_EXT_KIND: Readonly<Record<string, 'html' | 'xaml'>> = Object.freeze({
  '.html': 'html',
  '.htm': 'html',
  '.xaml': 'xaml'
})

/** 单个入口文档的字节上限（与协议 `MAX_BYTES` 对齐：2 MiB 足够任何界面）。 */
export const PANEL_UI_MAX_ENTRY_BYTES = 2 * 1024 * 1024

/** 入口文档的默认标题（插件没给标题时的兜底）。 */
const DEFAULT_TITLE = ''

/**
 * 路径 → UI 种类。不是 UI 入口时返回空串（调用方据此走原有分支）。
 * @param {string} filePath
 * @returns {'html'|'xaml'|''}
 */
export function panelUiKindOfPath(filePath: string) : 'html'|'xaml'|'' {
  const p = String(filePath == null ? '' : filePath).trim().toLowerCase()
  const dot = p.lastIndexOf('.')
  if (dot < 0) return ''
  const ext = p.slice(dot)
  const kind = PANEL_UI_EXT_KIND[ext] as 'html' | 'xaml' | undefined
  return kind || ''
}

/**
 * 这个路径能不能当 UI 面入口？（校验器 / 安装器共用）
 * @param {string} filePath
 * @returns {boolean}
 */
export function isPanelUiEntry(filePath: string) : boolean {
  return panelUiKindOfPath(filePath) !== ''
}

/**
 * 归一化一条 UI 面声明。
 *
 * 接受三种写法（插件作者不必记形状）：
 *   · `"ui/panel.html"`                        —— 最常见，种类从扩展名推；
 *   · `{ entry: "ui/panel.xaml" }`             —— 显式对象；
 *   · `{ src|path: "ui/panel.html", kind: … }` —— 兼容别名，kind 只能是合法值。
 *
 * 非法（空串 / 非 UI 扩展名 / 种类与扩展名冲突）一律返回 `null` ——
 * 宁可不给这条面板，也不给一个必然白屏的入口。
 *
 * @param {any} raw
 * @returns {{ entry: string, kind: 'html'|'xaml' }|null}
 */
export function normalizePanelUi(raw: unknown) : { entry: string, kind: 'html'|'xaml' }|null {
  let entry = ''
  let declared = ''
  if (typeof raw === 'string') {
    entry = raw
  } else if (raw && typeof raw === 'object') {
    const src = raw as Record<string, unknown>
    entry = String(src.entry || src.src || src.path || '')
    declared = src.kind ? String(src.kind).trim().toLowerCase() : ''
  }
  entry = String(entry == null ? '' : entry).trim()
  // 只接受插件目录内的相对路径：绝对路径 / 反斜杠 / `..` 一律拒绝（目录穿越的第一道闸）。
  if (!entry) return null
  if (entry.startsWith('/') || entry.startsWith('\\') || /^[A-Za-z]:/.test(entry)) return null
  if (entry.split('/').some((seg) => seg === '..')) return null
  const normalizedEntry = entry.replace(/\\/g, '/').replace(/^\.\//, '')
  const byExt = panelUiKindOfPath(normalizedEntry)
  if (!byExt) return null
  if (declared && declared !== byExt) return null
  return { entry: normalizedEntry, kind: /** @type {'html'|'xaml'} */ ((byExt) as 'html'|'xaml') }
}

/**
 * 声明式 UI 入口的**字段别名**（按优先级）。
 *
 * 契约字段只有 `ui`，但模型与真实插件反复写过 `uiEntry / entry / html / view / …`
 * —— 它们语义完全相同，都是「这块面板画在哪个文档里」。集中在一处接受别名，
 * 是为了让"写歪了也能跑"发生在**唯一一个判定函数**里，而不是每个消费方各兼容一遍
 * （那必然漂移成"清单说有、渲染说没有"）。
 *
 * ⚠ 这是**唯一**的别名表：创作侧（AI 工作室）也 import 它来清理 / 改写面板声明，
 * 不许在别处再手写一份。
 */
export const PANEL_UI_FIELD_ALIASES = Object.freeze([
  'ui', 'uiEntry', 'entry', 'html', 'view', 'page', 'file', 'src', 'path', 'render'
])

/**
 * 某条面板声明里的 UI 入口（`contributes.panels[].ui`，兼容历史别名）。
 *
 * 别名只在该字段**指向合法 UI 文档**（`.html/.htm/.xaml`）时才认 ——
 * 于是 `render: "render.js"` 不会被误当成 UI 面，而 `render: "panel.html"` 会。
 *
 * @param {any} panel
 * @returns {{ entry: string, kind: 'html'|'xaml' }|null}
 */
export function panelUiFromContribution(panel: unknown) : { entry: string, kind: 'html'|'xaml' }|null {
  if (!panel || typeof panel !== 'object') return null
  const src = panel as Record<string, unknown>
  for (const key of PANEL_UI_FIELD_ALIASES) {
    const value = src[key]
    if (value == null || value === '') continue
    const ui = normalizePanelUi(value)
    if (ui) return ui
  }
  return null
}

/**
 * manifest **顶层**的 UI 入口（插件只有一块声明式面板时的写法）。
 *
 * 真实事故形态：`{ "html": "panel.html", "render": "panel.html", "contributes": { "panels": [{ id }] } }`
 * —— 作者把"入口"写在顶层，面板项里只留 id。此时若只认面板级 `ui`，宿主会判成
 * 「没有实现」。这里让面板可以**继承**顶层的 UI 入口，与面板级写法等价。
 *
 * @param {any} manifest
 * @returns {{ entry: string, kind: 'html'|'xaml' }|null}
 */
export function panelUiFromManifest(manifest: unknown) : { entry: string, kind: 'html'|'xaml' }|null {
  if (!manifest || typeof manifest !== 'object') return null
  const src = manifest as Record<string, unknown>
  for (const key of PANEL_UI_FIELD_ALIASES) {
    const value = src[key]
    if (value == null || value === '') continue
    const ui = normalizePanelUi(value)
    if (ui) return ui
  }
  return null
}

/**
 * 渲染入口**可加载**的扩展名白名单。
 *
 * `render` 必须是能在渲染进程里求值的模块；HTML/XAML 是**文档**，属于 `ui` 面。
 * 两者混用是真实事故（`"render": "panel.html"` → 模块加载必然失败 → 面板「尚未实现」），
 * 所以判定必须只有一处，注册中心 / 渲染层 / 创作侧共用。
 */
export const RENDER_MODULE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs'])

/**
 * 这个路径能不能当**渲染模块**入口？
 * @param {any} filePath
 * @returns {boolean}
 */
export function isRenderModulePath(filePath: unknown) : boolean {
  const p = String(filePath == null ? '' : filePath).trim().toLowerCase()
  const dot = p.lastIndexOf('.')
  if (dot < 0) return false
  return RENDER_MODULE_EXTENSIONS.includes(p.slice(dot))
}

/**
 * 渲染入口候选文件名（按优先级）—— 注册中心自愈、创作侧纠正共用同一份顺序。
 * @param {string} [pluginId]
 * @returns {string[]}
 */
export function renderEntryCandidates(pluginId: string) : string[] {
  const id = String(pluginId == null ? '' : pluginId).trim()
  return [
    id ? `${id}.renderer.js` : '',
    'render.js', 'render.mjs', 'renderer.js', 'render.cjs', 'panel.js', 'panel.mjs'
  ].filter(Boolean)
}

/**
 * 图标声明能否被宿主解析？
 *
 * 三类合法写法（与渲染层 `resolveIcon` 同口径）：
 *   1. 注册表里的名字（含大小写 / 分隔符归一与别名）；
 *   2. 图片 URL（`data:image/…`、`hira-plugin://…`、`http(s)://…`）；
 *   3. 内联 SVG 原文（`<svg …>`）。
 *
 * 为什么判定要放在这里：创作侧（要不要警告模型）与清单侧（要不要标 iconValid）
 * 必须得到同一个答案，否则会出现"生成时说合法、清单里说不可用"。
 *
 * @param {any} icon
 * @returns {boolean}
 */
export function panelIconResolvable(icon: unknown) : boolean {
  const spec = String(icon == null ? '' : icon).trim()
  if (!spec) return false
  if (/^data:image\//i.test(spec)) return true
  if (/^(hira-plugin|https?):\/\//i.test(spec)) return true
  if (/<svg[\s>]/i.test(spec)) return true
  return normalizeIconName(spec) !== ''
}

/**
 * 一条面板声明的**实现摘要** —— `{ id, title, icon, iconValid, ui, implementation }`。
 *
 * `implementation` 是模型最需要的那个结论：
 *   · `'render'` —— manifest.render 提供了渲染入口（插件代码画界面）
 *   · `'ui'`     —— 这块面板有声明式 HTML 面
 *   · `'none'`   —— 两者都没有 = 打开必然「尚未实现」
 *
 * 创作侧（studio）与清单侧（AI 的 plugin_list / studio_list）共用同一个函数，
 * 避免两处各写一套判定慢慢漂移。
 *
 * @param {any} panel       `contributes.panels[]` 的一项
 * @param {{ hasRender?: boolean, manifestUi?: { entry: string }|null }} [options]
 * @returns {{ id: string, title: string, icon: string, iconValid: boolean, ui: string, implementation: 'render'|'ui'|'none' }}
 */
export function summarizePanelContribution(panel: unknown, options: { hasRender?: boolean, manifestUi?: { entry: string }|null } = {}) : { id: string, title: string, icon: string, iconValid: boolean, ui: string, implementation: 'render'|'ui'|'none' } {
  const src = panel && typeof panel === 'object' ? panel as Record<string, unknown> : {}
  const ui = panelUiFromContribution(src) || (options.manifestUi || null)
  const icon = String(src.icon == null ? '' : src.icon).trim()
  const id = String(src.id == null ? '' : src.id)
  const title = String(src.title || id)
  return {
    id,
    title,
    icon,
    iconValid: panelIconResolvable(icon),
    ui: ui ? ui.entry : '',
    implementation: options.hasRender ? 'render' : (ui ? 'ui' : 'none')
  }
}

/**
 * 归一化权限级别。非法值回落 `ui`（与注册中心同口径 —— 不相信插件自声明）。
 * @param {any} value
 * @returns {'none'|'ui'|'network'|'full'}
 */
export function normalizePermissionLevel(value: unknown) : 'none'|'ui'|'network'|'full' {
  const v = String(value == null ? '' : value).trim().toLowerCase()
  if (v === 'none' || v === 'ui' || v === 'network' || v === 'full') return v
  return 'ui'
}

/**
 * 这个权限级别能不能出网？
 * @param {any} permissionLevel
 */
export function panelUiCanNetwork(permissionLevel: unknown) {
  const level = normalizePermissionLevel(permissionLevel)
  return level === 'network' || level === 'full'
}

/**
 * 插件的资源源（同时也是 `<base href>` 的真源）。
 * @param {string} pluginId
 * @returns {string} 形如 `hira-plugin://my-plugin`
 */
export function panelUiPluginOrigin(pluginId: string) : string {
  const id = String(pluginId == null ? '' : pluginId).trim().toLowerCase()
  return `${PANEL_UI_SCHEME}://${id}`
}

/**
 * 派生 CSP —— **不是**让插件自己写。
 *
 * 原则：默认全关（`default-src 'none'`），只有界面绘制必需的几类**同源**资源开口，
 * 网络能力严格跟着 `permissionLevel` 走。这样即使插件 HTML 里写了
 * `<script src="https://cdn…">` 或 `fetch('https://collect…')`，也只会被浏览器拒绝，
 * 而不是我们事后审计。
 *
 * 注：`frame-ancestors` 刻意不写 —— 本文件正是要被宿主 iframe 内嵌的。
 *
 * @param {{ pluginId?: string, permissionLevel?: any }} [options]
 * @returns {string}
 */
export function buildPanelUiCsp(options: { pluginId?: string, permissionLevel?: unknown } = {}) : string {
  const origin = panelUiPluginOrigin(options.pluginId || '')
  const net = panelUiCanNetwork(options.permissionLevel)
  const self = `${PANEL_UI_SCHEME}:`
  const img = [`${self}`, 'data:', 'blob:']
  const media = [`${self}`, 'data:', 'blob:']
  const connect = [`${self}`]
  if (net) {
    img.push('https:', 'http:')
    media.push('https:')
    connect.push('https:', 'http:', 'wss:', 'ws:')
  }
  return [
    `default-src 'none'`,
    // 内联样式是插件的常态（XAML 编译产物全是 style 属性），必须放行；
    // 图片走 data: 也一样。脚本只允许内联与自身包内文件（srcdoc 无 origin，
    // 不能用 nonce 之外的更严手段，而插件 HTML 无法预知 nonce）。
    `style-src ${self} 'unsafe-inline'`,
    `script-src ${self} 'unsafe-inline'`,
    `img-src ${img.join(' ')}`,
    `font-src ${self} data:`,
    `media-src ${media.join(' ')}`,
    `connect-src ${connect.join(' ')}`,
    `base-uri ${self}`,
    `form-action 'none'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `child-src 'none'`,
    `worker-src 'none'`,
    `manifest-src 'none'`
  ].join('; ')
}

/**
 * 转义映射 —— **单次扫描**（`replace(/[&<>]/g, …)`）。
 *
 * 为什么不用三个连续 `.replace()`：转义发生在**每一个**文本节点与属性值上
 * （XAML 编译尤其密集），三次全串扫描 + 三次中间串分配是这条路径上最白给的开销；
 * 一次扫描只分配一个结果串，且行为逐字不变。
 */
const TEXT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })
const ATTR_ESCAPES: Readonly<Record<string, string>> = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })

/** HTML 文本转义。 */
export function escapeHtmlText(value: unknown): string {
  return String(value == null ? '' : value).replace(/[&<>]/g, (ch) => TEXT_ESCAPES[ch])
}

/** HTML 属性值转义（双引号包裹）。 */
export function escapeHtmlAttribute(value: unknown): string {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ATTR_ESCAPES[ch])
}

/**
 * 宿主注入的基础样式。
 *
 * 刻意极薄：只做"能显示"的最小重置（浏览器默认 body 有 8px margin、默认字体是
 * 衬线体、默认背景是白色）。颜色一律走 CSS 变量，让插件自己也能读同一套主题。
 */
const BASE_STYLE = [
  'html,body{margin:0;padding:0;height:100%;}',
  // 前景取**面板**那一档（`--hira-panel-fg`），没设时回落到 UI 前景：
  // 面板背景由宿主的 iframe 容器透出，所以这里只能给文字上色、不能铺底。
  `body{font:13px/1.5 ${uiFontVar()};`,
  'color:var(--hira-panel-fg,var(--hira-text-primary,#e7e7ea));background:transparent;',
  '-webkit-font-smoothing:antialiased;}',
  '*{box-sizing:border-box;}'
].join('')

/**
 * 组装最终塞进 `iframe.srcdoc` 的文档。
 *
 * 组装顺序是安全语义的一部分（**改这个函数前先读**）：
 *   1. `<meta charset>` —— 否则中文会乱码（srcdoc 没有响应头可以带 charset）；
 *   2. `<meta CSP>` —— 必须排在插件任何自有标签之前，否则先加载的资源已经跑了；
 *   3. `<base>` —— 钉住相对路径；插件自己写的 `<base>` 会被 CSP 的 `base-uri` 拦掉；
 *   4. 主题变量（宿主可信 CSS）；
 *   5. 宿主身份 —— 子侧 `hira.pluginId` 读的全局量 + `<html>` 上的 `data-hira-*`，
 *      必须在桥脚本之前（桥脚本创建时就要把这些读出来）；
 *   6. 桥脚本 —— 必须在插件脚本之前执行（`window.hira` 要在第一时间就存在）；
 *   7. 最小基础样式。
 *
 * 插件给的源码若是**完整文档**，我们把上面 7 段注入它的 `<head>`（保持它的结构）；
 * 若是片段，则包一层标准文档 —— 两种写法都能工作，作者不必知道区别。
 *
 * @param {object} options
 * @param {string} options.source                      HTML 源码或 XAML 编译产物
 * @param {string} options.pluginId
 * @param {'html'|'xaml'} [options.kind]
 * @param {any} [options.permissionLevel]
 * @param {string} [options.title]
 * @param {string} [options.panelId]                   面板 id（写进 `data-hira-panel-id`）
 * @param {boolean} [options.firstParty]               第一方插件（写进 `data-hira-first-party`）
 * @param {string} [options.bridgeScript]             子侧桥脚本（**必须**是静态字符串）
 * @param {string} [options.themeStyle]               宿主主题变量 CSS（可信）
 * @param {string} [options.bodyClass]
 * @returns {string}
 */
export interface PanelUiDocumentOptions {
  source: string
  pluginId: string
  kind?: 'html' | 'xaml'
  permissionLevel?: unknown
  title?: string
  panelId?: string
  firstParty?: boolean
  bridgeScript?: string
  themeStyle?: string
  bodyClass?: string
}

export function buildPanelUiDocument(options: PanelUiDocumentOptions): string {
  const source = String(options.source == null ? '' : options.source)
  const pluginId = String(options.pluginId == null ? '' : options.pluginId).trim()
  const kind = options.kind === 'xaml' ? 'xaml' : 'html'
  const title = String(options.title == null ? DEFAULT_TITLE : options.title)
  const csp = buildPanelUiCsp({ pluginId, permissionLevel: options.permissionLevel })

  const head = []
  head.push('<meta charset="utf-8">')
  head.push(`<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`)
  head.push(`<base href="${escapeHtmlAttribute(`${panelUiPluginOrigin(pluginId)}/`)}">`)
  head.push('<meta name="viewport" content="width=device-width,initial-scale=1">')
  if (title) head.push(`<title>${escapeHtmlText(title)}</title>`)
  if (options.themeStyle) head.push(`<style>${String(options.themeStyle)}</style>`)
  // 宿主身份必须在桥脚本之前：桥脚本创建时就把身份读出来（之后不可改）。
  // 同一段脚本写两件事：`hira.pluginId` 读的全局量 + `<html>` 上的 data-* 约定。
  const identityScript = buildHostIdentityScript({
    pluginId,
    panelId: String(options.panelId == null ? '' : options.panelId).trim(),
    kind,
    permissionLevel: normalizePermissionLevel(options.permissionLevel),
    firstParty: options.firstParty === true
  })
  if (identityScript) head.push(`<script>${inlineScript(identityScript)}</script>`)
  if (options.bridgeScript) head.push(`<script>${inlineScript(options.bridgeScript)}</script>`)
  head.push(`<style>${BASE_STYLE}</style>`)
  const headText = head.join('\n')

  // XAML 编译产物永远是片段；HTML 可能是完整文档（作者直接交了个能双击打开的文件）。
  if (kind === 'html' && looksLikeFullDocument(source)) {
    return injectHead(source, headText)
  }
  return wrapDocument(headText, source, options.bodyClass)
}

/**
 * 宿主身份脚本（可信，先于插件任何脚本执行）。
 *
 * 两个产出：
 *   1. `window.__hiraPanelUiPluginId` —— 桥脚本读它填 `hira.pluginId`；
 *   2. `<html data-hira-*>` —— CSS / 纯静态分支的唯一稳定入口（见 `PANEL_UI_HOST_DATA_ATTRS`）。
 *
 * 为什么属性写在 `<html>` 而不是 `<body>`：插件源码可能在 `<head>` 里就写 CSS 选择器，
 * 此时 `<body>` 还不存在；`document.documentElement` 一定已就绪。
 *
 * @param {{ pluginId: string, panelId: string, kind: string, permissionLevel: string, firstParty: boolean }} info
 * @returns {string} 空串 = 没有可写的东西
 */
function buildHostIdentityScript(info: { pluginId: string, panelId: string, kind: string, permissionLevel: string, firstParty: boolean }) : string {
  const attrs: string[] = []
  /** @param {string} name @param {string} value */
  const push = (name: string, value: string) => {
    if (!value) return
    attrs.push(`[${JSON.stringify(name)},${JSON.stringify(value)}]`)
  }
  push(PANEL_UI_HOST_DATA_ATTRS.pluginId, info.pluginId)
  push(PANEL_UI_HOST_DATA_ATTRS.panelId, info.panelId)
  push(PANEL_UI_HOST_DATA_ATTRS.panelKind, info.kind)
  push(PANEL_UI_HOST_DATA_ATTRS.permissionLevel, info.permissionLevel)
  push(PANEL_UI_HOST_DATA_ATTRS.firstParty, info.firstParty ? 'true' : 'false')
  push(PANEL_UI_HOST_DATA_ATTRS.bridgeVersion, String(PANEL_UI_BRIDGE_VERSION))
  if (!info.pluginId && !attrs.length) return ''
  const lines = []
  if (info.pluginId) lines.push(`window.__hiraPanelUiPluginId=${JSON.stringify(info.pluginId)};`)
  if (attrs.length) {
    lines.push(`try{var el=document.documentElement,list=[${attrs.join(',')}];`)
    lines.push('for(var i=0;i<list.length;i++){el.setAttribute(list[i][0],list[i][1]);}}catch(e){}')
  }
  return lines.join('')
}

/**
 * 内联脚本的兜底处理：`</script` 出现在字符串字面量里会提前闭合标签。
 * 桥脚本是我们自己写的静态串，但这条防护必须留着 —— 将来任何动态拼进去的内容
 * 都不该有能力跳出 `<script>`。
 * @param {string} script
 */
function inlineScript(script: string) {
  return String(script).replace(/<\/script/gi, '<\\/script')
}

/** @param {string} source */
function looksLikeFullDocument(source: string) {
  return /<html[\s>]/i.test(source) || /<!doctype\s+html/i.test(source) || /<head[\s>]/i.test(source)
}

/**
 * 把 head 段注入已有文档。四个层级依次尝试（**顺序不能换**）：
 * `<head>` → `<html>` → `<body>` → 整体包一层。
 * @param {string} source
 * @param {string} headText
 */
function injectHead(source: string, headText: string) {
  const headOpen = /<head(\s[^>]*)?>/i
  if (headOpen.test(source)) return source.replace(headOpen, (m) => `${m}\n${headText}`)
  const htmlOpen = /<html(\s[^>]*)?>/i
  if (htmlOpen.test(source)) return source.replace(htmlOpen, (m) => `${m}\n<head>\n${headText}\n</head>`)
  const bodyOpen = /<body(\s[^>]*)?>/i
  if (bodyOpen.test(source)) return source.replace(bodyOpen, () => `<head>\n${headText}\n</head>\n$&`)
  return wrapDocument(headText, source, '')
}

/**
 * @param {string} headText
 * @param {string} bodyInner
 * @param {string} [bodyClass]
 */
function wrapDocument(headText: string, bodyInner: string, bodyClass: string | undefined) {
  const cls = bodyClass ? ` class="${escapeHtmlAttribute(bodyClass)}"` : ''
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    headText,
    '</head>',
    `<body${cls}>`,
    bodyInner,
    '</body>',
    '</html>'
  ].join('\n')
}
