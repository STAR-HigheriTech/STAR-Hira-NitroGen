/**
 * Lucide-style SVG icons (24x24 viewBox, stroke currentColor).
 * Returns an SVGElement so callers can set size/color via CSS.
 *
 * ⚠ 路径字面量**不在这里抄**：与内部页图标集（`pages/_shared/icons.js`）、
 *   内部页 favicon（`hira://page-icon`，主进程吐）共用的那几颗，统一放在
 *   `packages/shared-types/src/icon-paths.mjs#SHARED_ICON_PATHS`。
 *   三处各自 import 同一份数据 —— 不会再出现"rail 上是这只钟、标签条上是另一只"。
 */

import { SHARED_ICON_PATHS } from '@hira-ng/shared-types/src/icon-paths.mjs'
// 图标名清单与别名是**跨进程唯一真源**（主进程创作侧 / AI 能力清单也用同一份）。
import { ICON_NAMES, normalizeIconName } from '@hira-ng/shared-types/src/icon-names.mjs'

export { normalizeIconName }

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface IconOptions {
  size?: number
  strokeWidth?: number
}

export type IconFactory = (doc: Document, options?: IconOptions) => Element
export type CaptionFactory = (doc: Document) => SVGSVGElement

export interface SvgIconOptions extends IconOptions {
  fallback?: boolean
}

export interface CatalogItem {
  id: string
  label: string
  icon: IconFactory
  iconSpec?: string
  navbar: boolean
  rail: boolean
  segment: string
  removable?: boolean
  order?: number
  pluginId?: string | null
  opensWindow?: string | null
  opensPage?: string | null
  hostPage?: string | null
  feature?: string | null
  [key: string]: unknown
}

export interface PanelCatalogEntry {
  id?: string
  title?: string
  icon?: unknown
  segment?: unknown
  order?: unknown
  pluginId?: string | null
  opensWindow?: string | null
  opensPage?: string | null
  hostPage?: string | null
  feature?: string | null
  [key: string]: unknown
}

/**
 * @param {Document} doc
 * @param {string} paths - inner SVG markup (paths/circles/etc)
 * @param {object} [opts]
 * @param {number} [opts.size=20]
 * @param {number} [opts.strokeWidth=1.5]
 * @returns {SVGSVGElement}
 */
function createSvg(doc: Document, paths: string, opts: IconOptions = {}): SVGSVGElement {
  const size = opts.size ?? 20
  // 1.5：比 Lucide 默认 2 更细的视觉重量，navbar/rail/panel 全端统一由这里决定。
  const strokeWidth = opts.strokeWidth ?? 1.5
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
  svg.innerHTML = paths
  return svg
}

// --- Window caption glyphs（最小化 / 最大化 / 还原 / 关闭）---
//
// ⚠ 这一族**刻意不复用上面的 createSvg（24 格 + viewBox）**。
//
// 为什么：上面那套是 Lucide 的 24×24 坐标系，缩到 14/16px 时缩放比是 0.583 / 0.667 ——
// 于是**每一个坐标都变成分数**（如 14 格的方块 → 8.17px），1.5 的描边也跟着缩成 0.875px。
// 半像素的边 + 亚像素的线，在 1x 屏上就是"糊"，在 Windows 125% 缩放下更明显 ——
// 用户看到的"锯齿大 / 丑"就是这么来的。标题栏字形是**硬件感的直线**，容不下这种重采样。
//
// 所以这里改成 Hira 的口径：**在自己 12×12 的坐标系里 1:1 作画**（不设 viewBox，
// 1 单位 = 1 CSS 像素，零缩放），字形 10px、描边 1.2、端头直角（butt/miter）——
// 与 Windows 11 原生标题栏字形的几何逐字同源（Hira `pages/app/parts/window-controls.html.part`）。
const CAPTION_SIZE = 12

/**
 * @param {Document} doc
 * @param {string} markup 12×12 坐标系内的内部标记
 * @returns {SVGSVGElement}
 */
function createCaptionSvg(doc: Document, markup: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  // 只给 width/height、**不给 viewBox**：两者相等即 1:1，坐标不会被重采样。
  svg.setAttribute('width', String(CAPTION_SIZE))
  svg.setAttribute('height', String(CAPTION_SIZE))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.2')
  // 直角端头：Windows 标题栏字形是硬边，round 会让 1px 线的两端发虚。
  svg.setAttribute('stroke-linecap', 'butt')
  svg.setAttribute('stroke-linejoin', 'miter')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  svg.innerHTML = markup
  return svg
}

export const CaptionMinimize: CaptionFactory = (doc) =>
  createCaptionSvg(doc, '<line x1="1" y1="5.5" x2="11" y2="5.5"/>')

/** 最大化：9×9 直角方框（居中）。 */
export const CaptionMaximize: CaptionFactory = (doc) =>
  createCaptionSvg(doc, '<rect x="1.5" y="1.5" width="9" height="9"/>')

/**
 * 还原：**层叠双框**（前框 + 后框的 L 形轮廓）—— 这才是 Windows 的还原字形。
 * 以前这里拿 `X`（关闭图标）顶替，语义完全错位：还原看起来像"要关掉窗口"。
 */
export const CaptionRestore: CaptionFactory = (doc) =>
  createCaptionSvg(doc, '<rect x="1.5" y="3.5" width="7" height="7"/><polyline points="3.5,3.5 3.5,1.5 10.5,1.5 10.5,8.5 8.5,8.5"/>')

export const CaptionClose: CaptionFactory = (doc) =>
  createCaptionSvg(doc, '<path d="M1,1 l 10,10 M1,11 l 10,-10"/>')

// --- Navigation ---
export const ArrowLeft: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>', o)

export const ArrowRight: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.ArrowRight, o)

export const RefreshCw: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.RefreshCw, o)

// 「反转格序」—— 左右各一个箭头对穿（分屏工具条用它表示"把格的顺序倒过来"）。
// 语义上不存在于别处，所以放在这里而不是拿 RefreshCw 顶替（循环箭头读起来像"刷新/重来"）。
export const ArrowLeftRight: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>', o)

export const Home: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Home, o)

// --- Actions ---
export const Plus: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Plus, o)

// 「移除」—— 垃圾桶。与相邻的 X（关闭/收起视图）语义不同：它表示**销毁定义**，
// 所以必须有自己的字形，不能拿 X 顶替（两个叉挨在一起会让人以为重复了）。
export const Trash2: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Trash2, o)

export const X: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.X, o)

// Window control icons (minimize, maximize, restore)
export const Minus: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M5 12h14"/>', o)

export const Square: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Square, o)

export const CopyPlus: IconFactory = (doc, o) =>
  createSvg(doc, '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', o)

// 拖动手柄（六个点）—— 与 Lucide 同款：`fill="none"` 下靠**描边**把 r=1 的小圆画成实心点。
// ⚠ 这里曾经写成 `{ strokeWidth: 0 }`（想画"实心点"却没给 fill）—— strokeWidth 归零 + fill none
//    = 什么都不画，图标整个消失（分屏工具条的拖拽按钮就是这么变成空白的）。别再动这一行。
export const GripVertical: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.GripVertical, o)

export const ChevronRight: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m9 18 6-6-6-6"/>', o)

export const ChevronLeft: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m15 18-6-6 6-6"/>', o)

export const ChevronDown: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m6 9 6 6 6-6"/>', o)

export const ChevronUp: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m18 15-6-6-6 6"/>', o)

// 回形针 —— 分屏成员**之间**的连接标记（Edge / Firefox 同款：两个标签连着、不可分离）
export const Paperclip: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>', o)

// --- Audio ---
export const Volume2: IconFactory = (doc, o) =>
  createSvg(doc, '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>', o)

export const VolumeX: IconFactory = (doc, o) =>
  createSvg(doc, '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>', o)

// --- Panel icons ---
// 画笔 —— 「注入规则」面板（Boosts / 自定义 CSS·JS）
export const Paintbrush: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z"/><path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7"/><line x1="14.5" y1="17.5" x2="4.5" y2="15.5"/>', o)

// 归档箱 —— 「归档」面板（J9）
export const Archive: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Archive, o)

/**
 * 文件夹 —— **固定文件夹**在标签栏 / 面板里的唯一标识。
 *
 * 为什么不用 `Pin`：固定标签在语义上已经升级成「收藏夹文件夹」（可建多个、可收展、可改名），
 * 图钉表达的是「这个东西被钉住了」，表达不了「这是一个装标签的容器」。两者必须在
 * 标签栏里一眼可分（用户明确要求样式要不一样），所以固定文件夹一律用 Folder 轮廓。
 */
export const Folder: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Folder, o)

/** 新建文件夹（Folder + 加号）：面板工具栏「新建文件夹」与右键菜单「新建文件夹…」。 */
export const FolderPlus: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M12 10v6"/><path d="M9 13h6"/>' + SHARED_ICON_PATHS.Folder, o)

export const Star: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Star, o)

export const Clock: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Clock, o)

export const Download: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Download, o)

export const Puzzle: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Puzzle, o)

// 插件（Harness 插件中心）—— 与「扩展」(Puzzle) 必须可辨：
// 扩展是第三方外来件（拼图块），插件是浏览器自身的可拆装单元（积木块）。
export const Blocks: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>', o)

export const StickyNote: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h11l5-5V5a2 2 0 0 0-2-2h-3.5Z"/><path d="M14 3v4a2 2 0 0 0 2 2h4"/><path d="M9 13h6"/>', o)

/**
 * 调色盘 —— 主题面板的图标。
 * 为什么不用 `LayoutGrid`（形状接近）：主题是"一套配色"，必须与"网格视图 / 布局"
 * 在**形状上**就分得开 —— 一排小 icon 里靠语义猜是猜不准的，形状才是第一判据。
 */
export const Palette: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Palette, o)

export const Pin: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>', o)

export const Users: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Users, o)

export const LayoutGrid: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.LayoutGrid, o)

/** 空间（工作空间）—— 叠层：一层层可切换的工作区。 */
export const Layers: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Layers, o)

/**
 * 手机 —— 「网页面板的移动视图」（面板顶条用它一眼说明当前是移动版）。
 * 与 `AppWindow`（桌面/在标签页打开）配对使用。
 */
export const Smartphone: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>', o)

/**
 * 显示器 —— 「网页面板的桌面视图」（与 `Smartphone` 移动视图成对，顶条二选一显示）。
 */
export const Monitor: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>', o)

/** 打开的标签页 —— 带标题栏的窗口（与「空间」的叠层图标区分开）。 */
export const AppWindow: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.AppWindow, o)

/**
 * 弹出窗口 —— 把面板从侧栏**拎出来变成一个独立窗口**（面板标题栏那一颗按钮）。
 *
 * 字形是「一块窗口 + 后方错位探出的另一块窗口」：说的是"这里还能多出一个窗口"。
 * 为什么不用现成的：
 *   · `ExternalLink` 是"去外部页面"，用在这里会被读成"上网"；
 *   · `AppWindow` 在本项目里已是"在标签页打开"（见 webSidebarHeader 的 open-in-tab），
 *     两者挨着放会撞语义。所以窗口形态单独一只，且与 `PanelRight`（收回侧栏）成对。
 */
export const DetachWindow: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M9 3h8a4 4 0 0 1 4 4v8"/><rect width="13" height="13" x="3" y="8" rx="2.5"/>', o)

export const Menu: IconFactory = (doc, o) =>
  createSvg(doc, '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>', o)

/** 更多（横向三点）—— 侧边面板行内「次要动作」的收拢按钮。 */
export const MoreHorizontal: IconFactory = (doc, o) =>
  createSvg(doc, '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', o)

/** 齿轮 —— 打开某个对象的设置页（扩展 / 插件 / 站点规则）。 */
export const Settings: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Settings, o)

/** 外链 —— 「去外部页面（应用店 / 商店详情 / 管理页）」的唯一语义。 */
export const ExternalLink: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', o)

/**
 * 弹出窗口 —— 「打开扩展自己的 popup」。
 * 与 `AppWindow`（把整页开成标签）刻意分开：popup 是**贴着工具栏展开的一小块**，
 * 所以字形是「下方一块面板 + 上方一小块」而不是完整窗口。
 */
export const PanelTop: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="18" height="14" x="3" y="7" rx="2"/><path d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/>', o)

// --- Security / misc ---
export const Lock: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Lock, o)

export const Shield: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Shield, o)

export const ShieldCheck: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Shield + '<path d="m9 12 2 2 4-4"/>', o)

export const ShieldX: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Shield + '<path d="m15 9-6 6"/><path d="m9 9 6 6"/>', o)

export const Bell: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', o)

export const Check: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Check, o)

export const XCircle: IconFactory = (doc, o) =>
  createSvg(doc, '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>', o)

export const Camera: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>', o)

/**
 * 扫码（取景框 + 中线）—— 「扫码器」面板的图标。
 * 与 Camera 的分工：Camera 说"这是相机"，ScanLine 说"这是**扫**"——
 * 面板入口上后者更准确地表达了点击后会发生什么。
 */
export const ScanLine: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>', o)

export const Mic: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>', o)

export const Search: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Search, o)

/**
 * 地球 —— 地址栏建议里 `website` 候选**没有 favicon 时**的兜底行图标。
 * 语义是"这是一个网址"，与 `Search`（去搜索引擎搜这几个字）刻意区分。
 */
export const Globe: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Globe, o)

/**
 * 计算器 —— 地址栏建议里 `calc` 候选（`1+1 = 2`）的行图标。
 * 语义是"这段输入被当成算式算出了一个结果"，不能借 `Search`（那会被读成"去搜这几个字"）。
 */
export const Calculator: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>', o)

/**
 * 闪电 —— 地址栏建议里 `pedal` 候选（命令 / 自动化链）的行图标。
 * 语义是"这是一条能立刻执行的动作"，与 `Search`（去搜索）刻意区分。
 */
export const Zap: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Zap, o)

/**
 * RSS（订阅广播）—— 「实时更新 / Live Folders」面板的图标。
 * 语义是"订阅源推送过来的条目"，与 `RefreshCw`（手动刷新动作）刻意区分：
 * 面板入口表达的是"这里有一批会自己更新的内容"，而不是"点一下去刷新"。
 */
export const Rss: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>', o)

/**
 * 侧栏面板（一整块内容 + 贴着一边的窄栏）—— 「把当前页放进侧栏」的图标。
 *
 * 为什么需要专门一个：这个动作原先借的是 `Plus`，而 `Plus` 在整套界面里就是
 * 「新建 / 新增」的通用语义（新建标签页、新建笔记……），放在 rail 底部会让人读成
 * 「新建一个面板」。这里的语义是**把这一页挪到侧栏那块区域去**，字形必须说明
 * "一块面板被分出来"，而不是"多了一个东西"。
 * 与 `AppWindow`（打开标签页面板）、`LayoutGrid`（四宫格）都不同。
 */
export const PanelRight: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>', o)

/**
 * 列表（三行 + 每行一个项目符号）—— 「固定标签」的**列表模式**图标。
 * 与 `LayoutGrid`（网格模式）成对：两者是同一块面板的两种视图，图标必须能一眼区分
 * "竖排一条条" 与 "平铺一格格的"，所以不能用 `Menu`（汉堡）顶替 —— 那是菜单语义。
 */
export const List: IconFactory = (doc, o) =>
  createSvg(doc, '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>', o)

/**
 * 静态按钮目录 —— **只含 shell 自身的外壳按钮，不含任何面板**。
 *
 * 面板按钮为什么不在里面了：面板现在是**插件**（PART7 §7.2 TYPE P）。它们的
 * id / 中文名 / 图标 / 顺序由插件 manifest 的 `contributes.panels` 声明，经主进程
 * 面板目录（`apps/app-main/src/main/panel-catalog.js`）下发到渲染层，再由
 * `buildCatalog()` 追加到本目录之后。于是「装一个面板插件 = 多一个按钮」，
 * 「禁用 = 按钮随面板一起消失」，两端都不需要改代码。
 *
 * 字段：
 *   navbar/rail —— 该按钮是否出现在这个界面上；
 *   segment     —— 在界面上属于哪一段（navbar 的按钮分住两处，见下）。
 *
 * navbar 的两段（物理位置不同，故分段落渲染与投放；跨段拖动无意义）：
 *   nav     左导航区：后退 / 前进 / 刷新 / 主页
 *   panel   右面板开关（**面板条目运行时追加**，段名同为 'panel'）
 * rail 的投放区由 rail 自己声明：常驻（rail）+ 抽屉（drawer），见 ui-taskoverlay。
 *
 * **地址栏内的件一律不在目录里**：站点身份（锁）、收藏星、PWA 安装 / 打开应用、
 * 转到 —— 它们是地址栏字段的固定装饰件，位置与显隐由地址栏自己决定，不可编辑。
 * 登记进来只会在按钮编辑浮层里留下"拖不走、改了也没用"的幽灵格子。
 *
 * 主页按钮也在目录里：它曾是「由 app.show_home_button 开关驱动的固定按钮」，
 * 现在是普通可编辑成员（拖动排序 / 拖进浮层隐藏），设置里不再有那个开关。
 */
export const CHROME_BUTTONS: CatalogItem[] = [
  // Profile 切换器固定在标签栏头部，不再参与 navbar 的按钮账本 / 编辑浮层。
  { id: 'workspace-switcher', label: 'Profile 切换器', icon: Users, navbar: false, rail: false, segment: 'workspace', removable: false },
  { id: 'rail-toggle-button', label: '工具栏固定', icon: Pin, navbar: true, rail: false, segment: 'nav', removable: false },
  // ── navbar 左导航区 ──
  { id: 'back-button', label: '后退', icon: ArrowLeft, navbar: true, rail: false, segment: 'nav' },
  { id: 'forward-button', label: '前进', icon: ArrowRight, navbar: true, rail: false, segment: 'nav' },
  { id: 'refresh-button', label: '刷新', icon: RefreshCw, navbar: true, rail: false, segment: 'nav' },
  { id: 'home-button', label: '主页', icon: Home, navbar: true, rail: false, segment: 'nav' }
]

/**
 * 图标名字符串 → 图标构造器。
 *
 * 为什么需要它：面板目录要过 IPC，而 IPC 只能传可序列化的值 —— 图标函数不能随目录走，
 * 只能传**名字**（`"Star"`），由渲染层在这里还原成构造器。所有可用作面板/按钮图标的
 * 图标都必须登记在此，否则目录里写了名字也渲染不出图标。
 */
// ── 画板（D4）工具栏专用的一组（与其它图标同一套 24×24 / 1.5 描边，所以按钮里
//    并排也不显得是"两种风格"）。刻意不用字符图标：字符的字宽、基线、笔形都跟着
//    系统字体走，一排按钮会高矮不齐 —— 这正是图标该解决的事。
export const MousePointer2: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>', o)

export const Pencil: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>', o)

export const ArrowUpRight: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>', o)

export const Circle: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Circle, o)

/** 连线：两端各一个节点、中间一条曲率线 —— "把两个东西连起来"最直白的形状。 */
export const Spline: IconFactory = (doc, o) =>
  createSvg(doc, '<circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M5 17A12 12 0 0 1 17 5"/>', o)

export const Eraser: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>', o)

export const Undo2: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>', o)

/** 思维导图自动整理：父节点在上、两个子节点在下、三线相连。 */
export const Network: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="6" height="6" x="9" y="2" rx="1"/><rect width="6" height="6" x="2" y="16" rx="1"/><rect width="6" height="6" x="16" y="16" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>', o)

/**
 * 画板面板（D4）的**专属入口图标**：三角 + 方 + 圆三个基本图形。
 *
 * 为什么必须单开一个：此前它借的是 `StickyNote` —— 与「笔记」面板**同一个图标**，
 * rail 上两个按钮长得一模一样，根本分不出点哪个。语义上"画板"是画布与图形，
 * 与"便签纸"也不是一回事。
 */
export const Shapes: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>', o)

/** 开发模式提示（未打包构建）：三角感叹号，走 `currentColor` 跟随主题。 */
export const TriangleAlert: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.TriangleAlert, o)

/** 即时答案（F-0771~F-0773）：圆圈 + 信息点，与"搜索/网站"类候选区分开。 */
export const Info: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Info, o)

/** 截图标注（`ui/ui-capture-editor`）：文字工具。 */
export const Type: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>', o)

/** 截图标注：高亮笔（斜握的马克笔）。 */
export const Highlighter: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>', o)

/** 截图标注：重做（Undo2 的镜像）。 */
export const Redo2: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>', o)

/** 截图标注：模糊（水滴）。 */
export const Droplet: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>', o)

/** 通用「复制」：两张叠纸。 */
export const Copy: IconFactory = (doc, o) =>
  createSvg(doc, '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', o)

/** 书签 / 固定（插件里最常见的面板图标名；`bookmark` 别名落到这一颗）。 */
export const Bookmark: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>', o)

/**
 * AI 助手入口（面板目录 `icon:'Sparkles'`）。
 *
 * 路径取自 `SHARED_ICON_PATHS.Sparkles` —— 与内部页 `hira://ai` / `hira://aisettings`
 * 的页图标、地址栏「询问 AI」建议行是同一份字面量，不在这里另抄一颗。
 */
export const Sparkles: IconFactory = (doc, o) =>
  createSvg(doc, SHARED_ICON_PATHS.Sparkles, o)

/** 发送（AI composer）。 */
export const Send: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>', o)

/** 会话 / 消息（AI 空态与会话列表）。 */
export const MessageSquare: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', o)

/** 助手身份（消息头像）。 */
export const Bot: IconFactory = (doc, o) =>
  createSvg(doc, '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>', o)

export const ICON_REGISTRY: Readonly<Record<string, IconFactory>> = Object.freeze({
  ArrowLeft, ArrowRight, ArrowLeftRight, RefreshCw, Home, Plus, X, Minus, Square,
  CopyPlus, GripVertical, ChevronRight, ChevronLeft, ChevronDown, ChevronUp, Paperclip,
  Volume2, VolumeX, Star, Clock, Download, Puzzle, Blocks, StickyNote, Palette,
  Pin, Users, LayoutGrid, Layers, AppWindow, DetachWindow, Menu, Lock, Smartphone, Monitor,
  MoreHorizontal, Settings, ExternalLink, PanelTop,
  Shield, ShieldCheck, ShieldX, Bell, Check, XCircle, Camera, ScanLine, Mic, Search,
  PanelRight, Paintbrush, Archive, Rss, List, Globe, Calculator, Zap,
  // 固定文件夹（标签栏 / 固定面板）
  Folder, FolderPlus,
  // 画板工具栏（D4）
  MousePointer2, Pencil, ArrowUpRight, Circle, Spline, Eraser, Undo2, Trash2, Network,
  // 画板面板入口（与「笔记」的 StickyNote 区分开）
  Shapes,
  // 地址栏「开发模式」提示
  TriangleAlert,
  // 地址栏「即时答案」候选
  Info,
  // 截图标注编辑器（ui/ui-capture-editor）
  Type, Highlighter, Redo2, Droplet, Copy,
  // 书签 / 固定
  Bookmark,
  // AI 助手（侧栏面板 / 独立窗口共用同一套字形）
  Sparkles, Send, MessageSquare, Bot
})

/**
 * 名字清单（`icon-names.mjs`）与注册表必须一一对应 —— 少一个就意味着
 * "AI 被告知可用、渲染却画不出来"。开发期告警即可，生产不因此中断。
 */
;(function assertIconRegistryComplete() {
  const missing = (ICON_NAMES as string[]).filter((name) => typeof ICON_REGISTRY[name] !== 'function')
  if (missing.length) console.warn('[icons] ICON_REGISTRY 缺少 ICON_NAMES 中的：', missing.join(', '))
})()

/**
 * 按名字取图标构造器（找不到返回 null，调用方决定缺省形态）。
 * @param {string} name
 * @param {Document} doc
 * @param {{size?: number, strokeWidth?: number}} [opts]
 * @returns {Element|null}
 */
export function iconByName(name: string, doc: Document, opts?: IconOptions): Element | null {
  const key = normalizeIconName(name)
  return key ? ICON_REGISTRY[key](doc, opts) : null
}

/** `data:` / `hira-plugin://` / `http(s)` 图片直接当图标（插件可以自带位图图标）。 */
function imageIcon(doc: Document, src: string, size: number): HTMLImageElement {
  const img = doc.createElement('img')
  img.src = String(src)
  img.alt = ''
  img.width = size
  img.height = size
  img.draggable = false
  img.style.cssText = `display:block;width:${size}px;height:${size}px;object-fit:contain;`
  return img
}

const SAFE_SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'mask', 'pattern', 'use', 'title', 'desc'
])

/** 插件直接写进 manifest 的 `<svg>` 原文 → 图标节点（元素/属性白名单消毒）。 */
function svgIcon(doc: Document, markup: string, size: number): SVGSVGElement | null {
  const Parser = doc.defaultView?.DOMParser ?? DOMParser
  const parsed = new Parser().parseFromString(String(markup), 'image/svg+xml')
  if (parsed.querySelector('parsererror')) return null
  const source = parsed.documentElement
  if (!source || source.nodeName.toLowerCase() !== 'svg') return null
  const svg = doc.importNode(source, true) as unknown as SVGSVGElement
  for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    if (!SAFE_SVG_ELEMENTS.has(element.nodeName.toLowerCase())) {
      element.remove()
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim().toLowerCase()
      const href = name === 'href' || name === 'xlink:href'
      const executable = value.startsWith('javascript:') || value.startsWith('vbscript:') || value.startsWith('data:text/html')
      const externalCssUrl = value.includes('url(') && !/^url\([^)]*#/.test(value)
      if (name.startsWith('on') || name === 'style' || executable || externalCssUrl || (href && !value.startsWith('#'))) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  if (!svg.getAttribute('fill')) svg.setAttribute('fill', 'none')
  if (!svg.getAttribute('stroke')) svg.setAttribute('stroke', 'currentColor')
  svg.style.display = 'block'
  return svg
}

/**
 * **容错**图标解析 —— 目录项 / 标题栏 / rail 的统一入口。
 *
 * 支持四种写法（插件作者写哪种都行）：
 *   ① 注册名（`Star`）或别名（`bookmark` / `sticky-note`，不区分大小写与连字符）
 *   ② `data:image/...` / `hira-plugin://...` / `http(s)://...` 图片地址
 *   ③ 原始 `<svg>…</svg>` 片段
 *   ④ 空 / 认不出来 → 回落 `Puzzle`（**绝不返回 null 留一个空白格**）
 *
 * @param {string} spec manifest / 目录里的 icon 字符串
 * @param {Document} doc
 * @param {{size?: number, strokeWidth?: number, fallback?: boolean}} [opts]
 *        `fallback: false` 时认不出来仍返回 null（给"宁可省略也不要兜底图标"的场景）
 * @returns {Element|null}
 */
export function resolveIcon(spec: unknown, doc: Document, opts: SvgIconOptions = {}): Element | null {
  const size = Number(opts.size) || 20
  const text = String(spec == null ? '' : spec).trim()
  if (text) {
    if (/^data:image\//i.test(text) || /^(hira-plugin|https?):\/\//i.test(text)) {
      return imageIcon(doc, text, size)
    }
    if (/<svg[\s>]/i.test(text)) {
      const node = svgIcon(doc, text, size)
      if (node) return node
    }
    const key = normalizeIconName(text)
    if (key) return ICON_REGISTRY[key](doc, opts)
  }
  if (opts.fallback === false) return null
  return Puzzle(doc, { ...opts, size })
}

/**
 * PanelEntry（主进程下发）→ 可编辑按钮目录项。
 * 契约见 `infra/infra-ipc/src/contracts/layout.js#panelEntrySchema`。
 */
export function panelEntryToCatalogItem(entry?: PanelCatalogEntry | null): CatalogItem | null {
  if (!entry || !entry.id) return null
  return {
    id: String(entry.id),
    label: String(entry.title || entry.id),
    /**
     * **容错解析**：注册名 / 别名 / data URL / 原始 SVG 都认；认不出来回落 Puzzle。
     * 以前这里是 `ICON_REGISTRY[name] || null` —— 插件写 `bookmark` 就得到 null，
     * rail / navbar 上是一个**空白格**（用户报的"做了面板但没图标"就是这个）。
     */
    icon: (doc, opts) => resolveIcon(entry.icon, doc, { ...opts, fallback: true }) ?? Puzzle(doc, opts),
    /** 原始图标字符串（编辑浮层 / 诊断用；渲染一律走上面的 icon 函数）。 */
    iconSpec: String(entry.icon || ''),
    navbar: true,
    rail: true,
    segment: String(entry.segment || 'panel'),
    // 面板专有信息（编辑浮层 / 调试用）
    order: Number(entry.order) || 0,
    pluginId: entry.pluginId || null,
    /**
     * 声明了它 = 这一格**是个动作**：点下去开的是这个子窗口类型，不是侧栏面板。
     *
     * 为什么必须跟着目录项一起走：目录项是**所有入口共用的唯一输入**（rail / navbar /
     * 编辑浮层）。把"去哪"挂在目录项上，三个入口就自动一致；挂在各入口的点击处理器里
     * 就变成三份 `id === 'xxx'` 判断，那是必然漂移的写法。
     * 语义真源见 `packages/shared-types/src/panel-entry.mjs#panelEntryWindowType`。
     */
    opensWindow: entry.opensWindow ? String(entry.opensWindow) : null,
    /**
     * 与 `opensWindow` 对称的第二类动作：点下去在标签页里打开内部页 `hira://<host>`。
     * 同样必须跟着目录项走 —— 理由同上（入口只有一份输入，去向就只判一次）。
     * 语义真源见 `packages/shared-types/src/panel-entry.mjs#panelEntryPageHost`。
     */
    opensPage: entry.opensPage ? String(entry.opensPage) : null,
    /**
     * 面板的**内部页形态** host（如 AI 助手的 'ai'）。与 opensPage 不同：入口照旧开面板，
     * 只是宿主标题栏会多画一颗「在页面中打开」。同样必须跟着目录项走，理由同上。
     * 语义真源见 `packages/shared-types/src/panel-entry.mjs#panelEntryHostPage`。
     */
    hostPage: entry.hostPage ? String(entry.hostPage) : null
  }
}

/**
 * 合并成完整可编辑目录：外壳按钮 + 动态面板条目。
 *
 * 顺序约定：外壳按钮保持 CHROME_BUTTONS 的既有次序（不要动它，用户排过序的按钮
 * 靠这个次序兜底），面板条目按自身 `order` 升序追加在后 —— 与重构前的按钮顺序一致。
 *
 * @param {Array<object>} panelEntries 主进程面板目录（可为空 = 无面板）
 * @param {Array<object>} [chromeButtons]
 */
export function buildCatalog(
  panelEntries: readonly PanelCatalogEntry[] | null | undefined,
  chromeButtons: readonly CatalogItem[] = CHROME_BUTTONS
): CatalogItem[] {
  const panels = (Array.isArray(panelEntries) ? panelEntries : [])
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .map(panelEntryToCatalogItem)
    .filter((item): item is CatalogItem => item !== null)
  return [...chromeButtons, ...panels]
}

/** 某界面上可编辑的按钮目录（navbar / rail）。 */
export function catalogFor(
  surface: 'navbar' | 'rail' | string,
  catalog: readonly CatalogItem[] = CHROME_BUTTONS
): CatalogItem[] {
  return (catalog || []).filter((p) => p[surface] === true)
}

/**
 * 按「引擎功能面可用性」过滤外壳按钮目录（§10.4）。
 *
 * **为什么必须过滤目录，而不是只把 DOM 隐藏掉**：目录同时驱动按钮编辑浮层的格子。
 * 只藏 DOM 的话，用户在编辑浮层里仍能看到那一格、把它拖回可见 —— 于是得到一个
 * "引擎已禁用"的按钮，点下去报错。过滤目录让按钮与它的格子**同时**消失，口径一致。
 * （这与面板入口的处理是同一条道理，见 §10.4 的"面板陷阱"。）
 *
 * 纯函数、无 IPC：可用性由调用方（编排层）从 `renderer/shared/features-client.js` 取，
 * `ui-common` 不认识插件系统（分层约束）。
 *
 * @param {Array<object>} catalog
 * @param {(featureId: string) => boolean} isAvailable 缺省/未声明 feature 的按钮恒保留
 */
export function filterCatalogByAvailability(
  catalog: readonly CatalogItem[] | null | undefined,
  isAvailable?: (featureId: string) => boolean
): CatalogItem[] {
  const list = catalog || []
  if (typeof isAvailable !== 'function') return list.slice()
  return list.filter((item) => !item.feature || isAvailable(item.feature) !== false)
}

/** 目录里出现过、且去重后的全部段名（按目录首次出现顺序）。 */
export function segmentsOf(
  surface: 'navbar' | 'rail' | string,
  catalog: readonly CatalogItem[] = CHROME_BUTTONS
): string[] {
  const out: string[] = []
  for (const p of catalogFor(surface, catalog)) {
    if (p.segment && !out.includes(p.segment)) out.push(p.segment)
  }
  return out
}

/** panel id → 图标构造器（**仅外壳按钮**；面板图标随目录自带，见 buildCatalog）。 */
export const PANEL_ICONS = Object.freeze(
  Object.fromEntries(CHROME_BUTTONS.map((p) => [p.id, p.icon]))
)

/** panel id → 中文名（**仅外壳按钮**；面板名随目录自带）。 */
export const PANEL_LABELS = Object.freeze(
  Object.fromEntries(CHROME_BUTTONS.map((p) => [p.id, p.label]))
)
