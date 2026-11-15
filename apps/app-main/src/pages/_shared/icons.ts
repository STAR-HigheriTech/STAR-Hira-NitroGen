/**
 * 图标集（单一事实源）
 *
 * 为什么放在 pages/_shared：
 *   - hira:// 内部页是「原样拷贝、不打包」的，只能通过 hira://shared/* 拿到跨页公共模块；
 *   - renderer（vite 打包）用相对路径 import 同一份文件，于是「内部页 / 面板 / navbar」
 *     共用同一套图标路径，不会再出现两边各画一套符号（unicode ◈⌂★ vs 线条图标）的问题。
 *
 * 风格与浏览器 UI（navbar / rail / 面板）完全同源：Lucide 风格 24×24、
 * stroke=currentColor、1.5 线宽、圆角端点。数据是纯数据（id → inner SVG markup），
 * 与渲染环境无关，DOM 一律由这里的 svg 工厂创建。
 *
 * 两类出口：
 *   - spaceIconSvg()：空间图标（可选集合见 SPACE_ICON_NAMES，存进 DB space.icon）
 *   - uiIconSvg()   ：界面动作图标（新增/删除/编辑/确认/箭头…），只用于按钮
 */

// 空间图标的 **id 语义**（白名单 / 别名 / 归一 / 默认分配）唯一真源在 shared-types：
// domain 写库校验与这里画图必须用同一张表，否则「存得进去、画不出来」。
// 内部页源码里的裸名会在构建时被改写成 hira://shared/space-icon.mjs（见 electron.vite.config.js）。
import {
  SPACE_ICON_IDS,
  DEFAULT_SPACE_ICON as DEFAULT_SPACE_ICON_ID,
  resolveSpaceIconId
} from '@hira-ng/shared-types/src/space-icon.mjs'
import {
  PAGE_ICON_PATHS,
  pageIconGlyph,
  DEFAULT_PAGE_ICON_GLYPH
} from '@hira-ng/shared-types/src/page-icon.mjs'
// 与浏览器 UI（ui-common#ICON_REGISTRY）、主进程 favicon（page-icon.mjs）共用的
// 字形字面量一律从这里取 —— 同一颗星/齿轮/手柄不允许在这里再抄一遍。
import { SHARED_ICON_PATHS } from '@hira-ng/shared-types/src/icon-paths.mjs'

export { resolveSpaceIconId }

const SVG_NS = 'http://www.w3.org/2000/svg'

interface IconOptions { size?: number; strokeWidth?: number }

function createSvg (doc: Document, markup: string, size?: number, strokeWidth?: number): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(strokeWidth))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  svg.innerHTML = markup
  return svg
}

// ── 1. 空间图标 ────────────────────────────────────────────────────────────

/** 可选空间图标（选择器展示顺序）。id 同时是 DB `space.icon` 的存储值（真源在 shared-types）。 */
export const SPACE_ICON_NAMES = SPACE_ICON_IDS

const SPACE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  home: '<path d="m3 9.5 9-7 9 7V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9.5 22v-6h5v6"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: SHARED_ICON_PATHS.Users,
  layout: SHARED_ICON_PATHS.LayoutGrid,
  folder: SHARED_ICON_PATHS.Folder,
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
  education: '<path d="M21.42 10.92a1 1 0 0 0-.02-1.84L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.83l8.57 3.91a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
  game: SHARED_ICON_PATHS.Gamepad,
  palette: SHARED_ICON_PATHS.Palette,
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  globe: SHARED_ICON_PATHS.Globe,
  tent: '<path d="M3.5 21 14 3"/><path d="M20.5 21 10 3"/><path d="M15.5 21 12 15l-3.5 6"/><path d="M2 21h20"/>',
  settings: SHARED_ICON_PATHS.Settings,
  lock: SHARED_ICON_PATHS.Lock,
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  star: SHARED_ICON_PATHS.Star,
  fire: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  growth: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  document: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9"/><path d="M4 16h16l1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45Z"/>',
  incognito: '<path d="M10.73 5.08A10.74 10.74 0 0 1 21.94 11.65a1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>',
  diamond: '<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0z"/>',
  circle: SHARED_ICON_PATHS.Circle,
  square: SHARED_ICON_PATHS.Square,
  triangle: '<path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  coffee: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
  zap: SHARED_ICON_PATHS.Zap,
  sparkles: SHARED_ICON_PATHS.Sparkle,
  flower: '<circle cx="12" cy="12" r="2.6"/><path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5"/>'
})

/** 默认空间图标（空值 / 未知值兜底），与 navbar「Spaces」面板图标同形。 */
export const DEFAULT_SPACE_ICON = DEFAULT_SPACE_ICON_ID

/**
 * 建一个空间图标 SVG（navbar 同族线条图标）。
 * @param {Document} doc
 * @param {string} name
 * @param {{ size?: number, strokeWidth?: number }} [opts]
 * @returns {SVGSVGElement}
 */
export function spaceIconSvg (doc: Document, name?: string, opts: IconOptions = {}): SVGSVGElement {
  return createSvg(doc, SPACE_PATHS[resolveSpaceIconId(name)], opts.size ?? 18, opts.strokeWidth ?? 1.5)
}

// ── 2. 界面动作图标 ────────────────────────────────────────────────────────

const UI_PATHS: Readonly<Record<string, string>> = Object.freeze({
  plus: SHARED_ICON_PATHS.Plus,
  x: SHARED_ICON_PATHS.X,
  check: SHARED_ICON_PATHS.Check,
  pencil: '<path d="M21.17 6.83a2.83 2.83 0 0 0-4-4L3 17v4h4z"/><path d="m15 5 4 4"/>',
  /**
   * 齿轮（"设置"）。**路径数据引用空间图标那一份**，不复制字面量 ——
   * 同一个齿轮在两处各抄一遍，改一处另一处不动就是必然的漂移。
   *
   * 它是被漏掉过的一档：组件卡上的"设置"按钮调 `uiIconSvg(doc, 'settings')`，
   * 而这里没有 → 返回 null → 按钮退化成「设置」两个字，挤在 24px 的方框里。
   * 现在补齐；同时 actionButton 那边加了告警，未知图标名不会再悄悄变成文字。
   */
  settings: SPACE_PATHS.settings,
  // ── 内部页快捷入口用（新标签页顶部那一排）──
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  /** 空间：与空间图标共用同一份路径数据（不复制字面量） */
  spaces: SPACE_PATHS.layout,
  trash: SHARED_ICON_PATHS.Trash2,
  arrowRight: SHARED_ICON_PATHS.ArrowRight,
  // 归档搬运（空间/配置档案的导出·导入）：向下出、向上入，与常见"下载/上传"同语义
  download: SHARED_ICON_PATHS.Download,
  upload: SHARED_ICON_PATHS.Upload,
  gripVertical: SHARED_ICON_PATHS.GripVertical,
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  archive: SHARED_ICON_PATHS.Archive,
  automation: SHARED_ICON_PATHS.Zap,
  /**
   * 放大镜：搜索字段的**前置图标**（面板里的搜索框也用同一份路径数据，
   * 见 ui-common#icons 的 `Search`）。字段外观原语是 base.css 的 `.searchfield`。
   */
  search: SHARED_ICON_PATHS.Search,
  /** AI 助手标志（书签摘要等"用 AI 处理"的动作按钮，与 rail 面板同一颗） */
  sparkles: SHARED_ICON_PATHS.Sparkles
})

/**
 * 建一个界面动作图标 SVG。
 * @param {Document} doc
 * @param {keyof typeof UI_PATHS | string} name
 * @param {{ size?: number, strokeWidth?: number }} [opts]
 * @returns {SVGSVGElement | null}
 */
export function uiIconSvg (doc?: Document, name?: string, opts: IconOptions = {}): SVGSVGElement | null {
  if (!doc || !name) return null
  const markup: string | undefined = UI_PATHS[name]
  if (!markup) return null
  return createSvg(doc, markup, opts.size ?? 16, opts.strokeWidth ?? 1.5)
}

// ── 3. 内部页图标（单色字形）────────────────────────────────────────────────

/**
 * 某个内部页的**单色字形**（`hira://<host>` → 与 rail / 标签栏同一个字形名）。
 *
 * 与 `hira://page-icon/?p=<host>` 的区别只在外观：那个端点吐的是「白底徽标」
 * （自带白边、黑墨），用于标签栏那种需要与站点 favicon 并排的场合；
 * 这里是**纯字形**，`stroke=currentColor`，用于跟随文字色的导航项 / 列表。
 * 两者的字形名同源（shared-types#page-icon.mjs），不会各画一套。
 *
 * @param {Document} doc
 * @param {string} host `hira://<host>` 里的 host
 * @param {{ size?: number, strokeWidth?: number }} [opts]
 * @returns {SVGSVGElement | null}
 */
export function pageIconSvg (doc?: Document, host?: string, opts: IconOptions = {}): SVGSVGElement | null {
  if (!doc) return null
  const glyph = (pageIconGlyph(host || '') || DEFAULT_PAGE_ICON_GLYPH) as keyof typeof PAGE_ICON_PATHS
  const markup = PAGE_ICON_PATHS[glyph] || PAGE_ICON_PATHS[DEFAULT_PAGE_ICON_GLYPH]
  if (!markup) return null
  return createSvg(doc, markup, opts.size ?? 17, opts.strokeWidth ?? 1.6)
}
