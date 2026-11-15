/**
 * 内部页图标（hira://<host> 的 favicon）—— **唯一真源**。
 *
 * ── 为什么要有这一份 ────────────────────────────────────────────────────
 * hira:// 的内部页（设置 / 历史 / 下载 / 新标签页…）**不会自己声明图标**，
 * 而 Chromium 的 favicon 完全由页面声明的 link[rel=icon] 驱动 ——
 * 于是它们在标签条上只能显示兜底的"标题首字"（用户报过的那条：
 * "设置是设置、新标签页也不该是个临时图标"）。
 *
 * 这里把两件事收成一份数据：
 *   ① host → 字形名（这张表）；
 *   ② 字形名 → 路径数据（PAGE_ICON_PATHS）。
 *
 * ── 图形从哪来（**不另造美术**）────────────────────────────────────────
 * 字形**照搬项目既有的图标集**，与 rail / navbar / 面板上那颗是**同一份路径数据**：
 *   · 多数取自 `icon-paths.mjs#SHARED_ICON_PATHS`（ui-common 图标集与内部页图标集
 *     已经收敛到那一个文件，这里只 spread，不再抄字面量）；
 *   · 少数项目里没有对应字形的（钥匙 / 剪贴板 / 吸管 / 消息框 …），取 **Lucide 官方**
 *     的同一族（24 格、圆头、1.5 描边），不自己画。
 *
 * ⚠ 为什么路径数据必须落在这层（而不是 import 渲染层的图标模块）：
 *   它有三个消费者，横跨三个进程/层 ——
 *     · 主进程：hira://page-icon 协议端点（按 host 吐 SVG 字节）；
 *     · 构建期：electron.vite.config.js 给每个内部页注入 link[rel=icon]；
 *     · 渲染层（将来）：tabbar / 面板要按 host 画同一个字形。
 *   ui 包不能反向依赖 apps，主进程也 require 不了渲染层的 ESM —— 所以真源只能在这层
 *   纯数据模块里（与 favicon-src.mjs / file-icon.mjs 同一口径）。
 *
 * 命名与 ICON_REGISTRY 一致（PascalCase）：表里写 'Star' 就真的是 rail 上那颗 Star。
 */

import { PAGES } from './pages.js'
import { SHARED_ICON_PATHS } from './icon-paths.js'

/**
 * 字形表：名称 → 内部 SVG 标记。
 *
 * 前半段直接 spread `icon-paths.mjs#SHARED_ICON_PATHS` —— 那是 ui-common 图标集、内部页
 * 图标集、以及本文件三方**共用的同一份字面量**。于是"标签条上的历史"与"rail 上的历史"
 * 在结构上就不可能是两颗不同的钟，不需要靠人工守表来保证一致。
 */
/** @type {Readonly<Record<string, string>>} */
export const PAGE_ICON_PATHS: Readonly<Record<string, string>> = Object.freeze({
  // ── 与 ui-common#ICON_REGISTRY / pages/_shared#SPACE_PATHS 共用 ──────────
  ...SHARED_ICON_PATHS,

  // ── 项目里没有对应字形 → 取 Lucide 官方同族 ─────────────────────────────
  /** 密码（钥匙） */
  KeyRound: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  /** 任务管理器（占用曲线） */
  Activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  /** 分享 / 二维码 */
  Share2: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  /** 查看源代码 */
  Code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  /** 表单填充（地址 / 支付卡） */
  ClipboardList: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  /** 取色器 */
  Pipette: '<path d="m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12"/><path d="m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z"/><path d="m2 22 .414-.414"/>',
  /** PDF 查看器 */
  FileText: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  /** Cookie 与站点数据 */
  Cookie: '<path d="M11 17h.01"/><path d="M11.496 2c.324-.016.558.292.529.615a4 4 0 0 0 4.235 4.368.713.713 0 0 1 .758.757 4 4 0 0 0 4.366 4.237c.323-.03.63.204.614.527a10 10 0 0 1-2.915 6.566A1 1 0 1 1 4.93 4.918 10 10 0 0 1 11.496 2"/><path d="M12 12h.01"/><path d="M16 16h.01"/><path d="M16 3h.01"/><path d="M21 4h.01"/><path d="M21 8h.01"/><path d="M7 14h.01"/><path d="M9 8h.01"/>',
  /** 证书管理（合规徽章） */
  BadgeCheck: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m16 9-5.5 5.5L8 12"/>',
  /** JS 对话框（确认 / 提示） */
  MessageSquare: '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>',
  /** 崩溃报告 */
  Bug: '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
  /** 插件中心（积木块） */
  Blocks: '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>'
})

/** 表里没有的页面（含**插件新增的内部页**）用这一颗。 */
export const DEFAULT_PAGE_ICON_GLYPH = 'AppWindow'

/**
 * host → 字形名。
 *
 * host 就是 `hira://<host>/` 里那一段，也等于 out/pages/<host>/ 的目录名 ——
 * 所以"新增一个内部页" = 丢一个目录；忘了登记也只是退到兜底字形，不会没有图标。
 *
 * ⚠ 这张表**不再手写**：成员与字形都来自 `pages.mjs#PAGES` 的 `glyph` 字段
 *   （页面身份的唯一真源）。新增页面时在那一行写 `glyph: 'Star'` 就够了，
 *   不会出现"标签条有图标、侧栏导航却是另一颗/空着"的两套词表。
 */
export const PAGE_ICON_BY_HOST = Object.freeze(
  Object.fromEntries(
    PAGES.filter((page) => page.glyph).map((page) => [page.host, page.glyph])
  )
)

/**
 * host → 字形名（大小写无关，未知 host 退兜底）。
 * @param {string} host
 * @returns {string}
 */
export function pageIconGlyph (host: string) : string {
  const key = String(host == null ? '' : host).toLowerCase()
  return PAGE_ICON_BY_HOST[key] || DEFAULT_PAGE_ICON_GLYPH
}

/**
 * 该页图标的**URL** —— 内部页把它写进 `<link rel="icon">`。
 *
 * 为什么给的是协议端点而不是 data: URL：
 *   · 短、稳定、可缓存（data: 会把几百字节的路径数据写进标签记录与 favicons 表）；
 *   · 与扩展图标（hira://extension-icon）同一姿势 —— 图标字节由主进程按需吐，
 *     新增/更换字形不需要动任何页面文件。
 * @param {string} host
 * @returns {string}
 */
export function pageIconUrl (host: string) : string {
  return 'hira://page-icon/?p=' + encodeURIComponent(String(host == null ? '' : host).toLowerCase())
}

/**
 * 徽标口径：**白底 + 黑字形**，白底块画在图标**自己的位图里**。
 *
 * ⚠ 为什么白底必须画在图里（而不是像站点图标那样靠 CSS 的 padding + background）：
 *   图片内容在 Chromium 里会被**吸附到设备像素**（实测：图片盒落在 135.0125 这种分数量
 *   坐标上时，内容被向上取整到下一个设备像素），而 CSS 背景不受这一吸附 ——
 *   两者相差最多 1 个设备像素。站点图标看不出来（它们的墨迹本来就铺满整格），
 *   但内部页图标是"线性字形 + 一圈白边"，0.5px 的偏移在白边上会被放大成
 *   "图形不在正中间、有点偏右上"（用户实测反馈）。
 *   把白底与字形放进**同一张位图**，两者的相对位置就由构造保证，怎么吸附都不会错开。
 *   代价：这类图标的渲染侧不再套 CSS 白底（见 ui-tabbar / tabRowList 的
 *   isPageIconUrl 分支），盒子尺寸仍是 20x20，布局零变化。
 */
const BADGE_SIZE = 20
const BADGE_RADIUS = 5
const BADGE_FILL = '#ffffff'
/** 字形颜色：**黑白**（与站点图标那种彩底衬白边的观感区分开）。 */
const INK_COLOR = '#000000'
/** 字形的坐标系（全项目图标集统一 24 格）。 */
const GLYPH_BOX = 24
/** 字形在徽标里的**光学框**：24 格缩到 16 格（= 白边 2px 一圈）。 */
const GLYPH_SIZE = 16

/**
 * 这是不是「内部页图标」的 URL。
 *
 * 渲染侧靠它决定"要不要套自己那层 CSS 白底"：**这类图标自带白底**，
 * 再套一层只会把半像素偏移带回来（见上面 BADGE_* 那段）。
 * 与 pageIconUrl 同源，改 URL 形状时两边一起改。
 * @param {string} url
 * @returns {boolean}
 */
export function isPageIconUrl (url: string) : boolean {
  return String(url == null ? '' : url).startsWith('hira://page-icon/')
}

/**
 * 该页图标的 SVG 文本（协议端点直接吐它）。
 * @param {string} host
 * @returns {string}
 */
export function pageIconSvgText (host: string) : string {
  const glyph = pageIconGlyph(host) as keyof typeof PAGE_ICON_PATHS
  const markup = PAGE_ICON_PATHS[glyph] || PAGE_ICON_PATHS[DEFAULT_PAGE_ICON_GLYPH]
  const half = BADGE_SIZE / 2
  const halfGlyph = GLYPH_BOX / 2
  const scale = +(GLYPH_SIZE / GLYPH_BOX).toFixed(5)
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + BADGE_SIZE + ' ' + BADGE_SIZE + '"'
    + ' width="' + BADGE_SIZE + '" height="' + BADGE_SIZE + '">'
    + '<rect width="' + BADGE_SIZE + '" height="' + BADGE_SIZE + '" rx="' + BADGE_RADIUS + '" fill="' + BADGE_FILL + '"/>'
    + '<g transform="translate(' + half + ' ' + half + ') scale(' + scale + ') translate(' + (-halfGlyph) + ' ' + (-halfGlyph) + ')"'
    + ' fill="none" stroke="' + INK_COLOR + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
    + ' color="' + INK_COLOR + '">'
    + markup + '</g></svg>'
}
