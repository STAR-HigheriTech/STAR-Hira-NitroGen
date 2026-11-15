/**
 * Searchbar Overlay Renderer — 地址栏「命令面板」下拉专属独立浮层图层。
 *
 * 彻底解耦：本浮层拥有**独立**的 WebContentsView（searchbar-overlay），
 * 不与 tabpreview / permission / password 等任何浮层共用图层，绝不串扰。
 *
 * ── 落位（对齐 RT omnibox）────────────────────────────────────────────
 * 本层**只上报事实**，几何一律收在主进程：
 *   · `anchor` —— 地址栏在窗口 content 坐标系里的矩形与展开方向（由 ui-searchbar 上报）；
 *   · `width` / `height` —— **卡片实测尺寸 + 四边 pad**（含阴影留白的 outer 尺寸）；
 *   · `position: 'anchor-below'` + `pad` / `gap` / `margin`。
 * 主进程 `LayoutCoordinator#anchorFloatBelow` 用窗口 content 尺寸算 x/y 并夹取
 * （对齐 RT `utils/browser/omnibox.ts` 的 normalizeBounds + addShadowPadding）。
 * ⚠ 改造前这里走的是 `center:true`（整窗居中），下拉根本不贴地址栏 —— 别退回去。
 *
 * ── 外观（对齐 RT 命令面板）──────────────────────────────────────────
 * 13px 圆角、四层阴影、行 padding 10/12 + 圆角 10 + gap 10、主 14px / 次 12px、
 * 隐藏滚动条、hover 与选中两态（令牌驱动，随主题走）。
 * 行图标走**共用图标表**（`ui-common/icons`），不再用 emoji —— emoji 字形/基线
 * 各系统不同且无法跟随 `currentColor`。
 *
 * ── IPC（独立通道）───────────────────────────────────────────────────
 *   订阅：searchbar-overlay:show / :hide / :update-selection
 *   调用：searchbar-overlay:display / :ready
 *   回传：overlay:commit { kind:'searchbar', suggestion }
 *         overlay:commit { kind:'overlay-action', action:'remove-search-history', id }
 *         overlay:commit { kind:'overlay-action', action:'remove-history', id }
 *         overlay:commit { kind:'overlay-action', action:'edit-bookmark', url, title }
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
// 行图标走**共用图标表**（`ui-common/icons`）—— 不再在这里手写 emoji / SVG。
import { iconByName } from '@hira-ng/ui-common/src/icons'
// 站点图标**唯一真源**（代理 → 直连 → 放弃 + 看门狗）。浮层不自己拼 URL、不自己判协议。
import { createFaviconImg, faviconSourceCandidates } from '@hira-ng/shared-types/src/favicon-src.mjs'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { defineRendererSlots, callRendererSlot, activateRendererSlots } from '../shared/plugin-slots.js'
import { pluginsClient } from '../shared/plugins-client.js'

// ── 渲染侧插槽：地址栏结果项渲染器（`omnibar.result-item-renderer`，SINGLE）──
//
// 这里**必须**走渲染侧插槽而不是主进程描述符：这一槽的产出物是 DOM 节点，
// 过不了结构化克隆。宿主只认"实现返回一个 HTMLElement"这一个契约，
// 选中/点击/悬停这些交互仍由本文件统一接管（见 renderSuggestion）——
// 插件只负责"长什么样"，不负责"点了会怎样"。
defineRendererSlots(['omnibar.result-item-renderer'])

const themeController = createThemeController({ document, bridge: getHiraBridge() })
themeController.start()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing searchbar overlay root')
const root = rootElement

// ── 常量（与主进程 anchorFloatBelow 的契约）──────────────────
/**
 * 阴影留白 —— **只给左 / 右 / 下**，上边不给。
 *
 * 为什么上边必须是 0：留白是 view 的一部分，view 的上缘 = 卡片上缘 - pad.top。
 * 给 30 的时候整个 view 会往**上**多吃 30px，压住地址栏下半截 —— 视觉上是一层
 * 半透明阴影糊在输入框上，交互上那块区域的点击也被浮层接走。
 * 上边留白归零后，view 从卡片顶开始，阴影往上的那一丁点由 view 边界直接裁掉
 * （与站点信息浮层的处理同一口径，见 LayoutCoordinator#anchorFloatBelow 的 pad 说明）。
 */
const PAD = { top: 0, right: 30, bottom: 30, left: 30 }
/**
 * 卡片与地址栏下缘的间距。
 *
 * 6 → 10：卡片上缘不再带阴影留白之后，6px 看起来是"贴着输入框"；
 * 拉开一点点让两层之间有呼吸，又不会离得太远而失去归属感。
 */
const GAP = 10
/** 卡片最大高度（RT DEFAULT_OMNIBOX_HEIGHT = 335）：超出则列表内部滚动。 */
const CARD_MAX_HEIGHT = 335
/** 与窗口内容区四边的最小留白（主进程 anchorFloatBelow 据此夹 view 的外缘）。 */
const EDGE_MARGIN = 8

// ── 一次性注入样式：令牌驱动 + 隐藏滚动条 ─────────────────────
const style = document.createElement('style')
style.textContent = `
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  .hira-searchbar-card {
    position: fixed;
    left: ${PAD.left}px;
    top: ${PAD.top}px;
    box-sizing: border-box;
    background: var(--hira-bg-elevated, #ffffff);
    border: 1px solid var(--hira-border-subtle, rgba(0,0,0,0.1));
    border-radius: var(--hira-theme-radius, 13px);
    box-shadow:
      0 10px 25px -10px rgba(0,0,0,0.52),
      0 6px 14px -8px rgba(0,0,0,0.3),
      0 2px 6px rgba(0,0,0,0.16),
      0 1px 0 rgba(255,255,255,0.08);
    padding: 6px;
    display: none;
    max-height: ${CARD_MAX_HEIGHT}px;
    overflow-y: auto;
    overflow-x: hidden;
    pointer-events: auto;
    /* 隐藏滚动条（RT：下拉不显示滚动条）—— 三条写法覆盖 Chromium / Firefox / 旧 WebKit */
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .hira-searchbar-card::-webkit-scrollbar { display: none; width: 0; height: 0; }
  .hira-searchbar-row {
    padding: 10px 12px;
    border-radius: var(--hira-radius-md, 10px);
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    color: var(--hira-text-primary, #1a1a1a);
    cursor: pointer;
    background: transparent;
    /* 删除按钮（×）是**浮在行上**的，不参与 flex 排布（见 .hira-sb-remove 的说明）。 */
    position: relative;
  }
  .hira-searchbar-row.is-selected { background: var(--hira-track-bg, rgba(0,0,0,0.1)); }
  .hira-searchbar-row .hira-sb-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--hira-text-secondary, #6b7280);
  }
  .hira-searchbar-row .hira-sb-icon img { width: 16px; height: 16px; border-radius: 3px; }
  /* 面板入口行（「询问 AI」）：颜色跟 rail / navbar 的面板按钮同源（--hira-chrome-fg），
     而不是行图标那档次要灰 —— 两者字形相同，只差这一档颜色就会被看成"另一颗图标"。 */
  .hira-searchbar-row .hira-sb-icon.is-panel-entry {
    color: var(--hira-chrome-fg, var(--hira-text-primary, #1a1a1a));
  }
  .hira-searchbar-row .hira-sb-primary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hira-searchbar-row .hira-sb-secondary {
    color: var(--hira-text-secondary, #6b7280);
    font-size: 12px;
    flex-shrink: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 命中片段高亮：这一段是"用户输入在 URL 里命中"的原文，颜色抬到正文色 + 加粗，
     其余部分仍是次要色 —— 只为解释"这条记录为什么会出现"，不改变行的可读层级。 */
  .hira-searchbar-row .hira-sb-hit {
    color: var(--hira-text-primary, #1a1a1a);
    font-weight: 600;
  }
  /* 行内「删除历史」按钮（×）：默认隐形，悬停 / 选中才浮现，避免下拉一屏都是叉叉。
     **绝对定位盖在行上**，不占排版位 —— 不悬停时右侧文字照常占满整行（此前留 22px
     空位，没悬停也像少了一截，很难看）；出现时直接压在那段文字上，所以它必须自带
     不透明圆底，否则会和底下文字糊在一起。底色走 token，深浅主题自动跟随。 */
  .hira-searchbar-row .hira-sb-remove {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    z-index: var(--hira-z-elevated);
    border: 0;
    background: var(--hira-surface, #ffffff);
    color: var(--hira-text-secondary, #6b7280);
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    /* 隐形时**必须不吃鼠标**：它压在行内容上，若 opacity:0 仍可点，点行右侧就会
       误删这条历史（行右端本来该是"打开这一条"）。浮现的三种情形见下面三条规则。 */
    pointer-events: none;
    /* 圆底与行底色可能同色（都取 surface）—— 一圈细描边 + 轻投影把按钮托起来 */
    box-shadow: 0 0 0 1px var(--hira-track-bg, rgba(0,0,0,0.1)), 0 1px 3px rgba(0,0,0,0.18);
    transition: opacity 120ms ease, background-color 120ms ease, color 120ms ease;
  }
  .hira-searchbar-row .hira-sb-remove:hover {
    color: var(--hira-text-primary, #1a1a1a);
    /* 实心底 + 一层选中色叠加：不需要额外的 hover 专用 token，深浅两套都跟着走 */
    background: linear-gradient(var(--hira-track-bg, rgba(0,0,0,0.1)), var(--hira-track-bg, rgba(0,0,0,0.1))), var(--hira-surface, #ffffff);
  }
  /* 行内动作（书签「编辑」）：默认隐形，悬停/选中才浮现，避免下拉一屏都是按钮。 */
  .hira-searchbar-row .hira-sb-action {
    border: 0;
    background: transparent;
    color: var(--hira-text-secondary, #6b7280);
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: var(--hira-radius-xs, 6px);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease, background-color 120ms ease, color 120ms ease;
  }
  .hira-searchbar-row .hira-sb-action:hover {
    color: var(--hira-text-primary, #1a1a1a);
    background: var(--hira-surface-soft, rgba(0,0,0,0.08));
  }
  /* 悬停高亮（纯视觉，零状态 —— 悬停绝不影响选中项与回车，见 createRow 说明）：
     且只在「鼠标真的移动过」之后出现（hira-mouse 由 mousemove 监听挂上、
     每次建议重绘摘掉）。浮层在静止的光标下方弹出时，光标恰好压在某一行上并不
     代表用户想选它 —— 用户在打字，手根本不在鼠标上，那一行不该亮。 */
  .hira-mouse .hira-searchbar-row:hover { background: var(--hira-surface-soft, rgba(0,0,0,0.04)); }
  .hira-searchbar-row.is-selected .hira-sb-action { opacity: 1; }
  .hira-mouse .hira-searchbar-row:hover .hira-sb-action { opacity: 1; }
  /* 删除按钮的浮现时机：行被悬停（指针真压在这一行上）／键盘选中／自己拿到焦点。
     ⚠ 不跟 .hira-mouse 那道闸：闸的用途是"别让静止的光标把某一行误亮成悬停态"，
     而按钮只在指针真的压在这一行上时才出现，不会造成误判；反过来，一旦闸门因为
     任何原因没挂上，用户就完全看不到删除入口（曾经的表现）。 */
  .hira-searchbar-row.is-selected .hira-sb-remove { opacity: 1; pointer-events: auto; }
  .hira-searchbar-row:hover .hira-sb-remove { opacity: 1; pointer-events: auto; }
  .hira-searchbar-row .hira-sb-remove:focus-visible { opacity: 1; pointer-events: auto; outline: 2px solid currentColor; outline-offset: -2px; }
`
document.head.appendChild(style)

// ── DOM：命令面板卡片 ────────────────────────────────────────
const card = document.createElement('div')
card.className = 'hira-searchbar-card'
root.appendChild(card)

// 悬停视觉的开关（样式见 `.hira-mouse` 规则）：鼠标真的移动过才允许 :hover 生效。
// 每次 `showSearchbar` 复位 —— "打字中，手不在鼠标上"时浮层弹在静止光标下也不亮行。
let mouseActive = false
document.addEventListener('mousemove', () => {
  if (mouseActive) return
  mouseActive = true
  card.classList.add('hira-mouse')
}, { passive: true })

// ── 状态 ─────────────────────────────────────────────────────
/** @type {unknown[]} */
interface SearchSuggestion {
  id?: string
  type?: string
  url?: string
  query?: string
  title?: string
  source?: string
  provider?: string
  displayUrl?: string
  urlMatch?: string
  matchField?: string
  expression?: string
  result?: string
  historyId?: string
  favicon?: string | null
  icon?: string | null
  custom?: boolean
  bangId?: string
  [key: string]: unknown
}

interface SearchbarAnchor {
  left: number
  top: number
  width: number
  height: number
  align?: 'left' | 'right'
}

interface SearchbarPayload {
  anchor?: SearchbarAnchor
  suggestions?: SearchSuggestion[]
  selectedIndex?: number
  query?: string
}

interface SearchRowElement extends HTMLElement {
  __ngCustom?: boolean
  __ngRow?: RowEntry
}

interface RowEntry {
  node: HTMLElement
  sig: string
  s: SearchSuggestion
  index: number
  custom: boolean
}

let currentSuggestions: SearchSuggestion[] = []
let currentSelectedIndex = -1
/** 当前输入文本 —— 只用于把「URL 命中」的片段高亮出来（见 buildSecondaryNode）。 */
let currentQuery = ''

/**
 * 行节点登记表（key → `{ node, sig, s, index }`）—— **keyed 复用**。
 *
 * 改造前 `repaintRows()` 是 `card.textContent = ''` + 全量重建：每次按键都
 *   · 重新 `new Image` / 重新请求 favicon（图标闪一下）
 *   · 重新给每行绑 2~3 个监听器
 *   · 丢弃全部节点 → 滚动位置与 hover 态一起丢
 * 现在同一条建议在多次重绘间复用同一个节点，只有"新出现的行"才创建 DOM。
 */
const rowRegistry = new Map<string, RowEntry>()
/** 当前显示顺序（节点数组）—— 选择态切换只碰 1 个节点，不再全量 toggle。 */
let rowNodes: HTMLElement[] = []
/** 当前行集合指纹：内容/顺序都没变时，`showSearchbar` 可复用上次实测尺寸（免一次强制同步布局）。 */
let rowSetKey = ''
/** 当前高亮节点（O(1) 选择态切换用）。 */
let selectedNode: HTMLElement | null = null
/** 上一次写入卡片的宽度（只在真的变了才写 style，避免无谓的样式失效）。 */
let cardWidth = -1
/** 上一次实测的 outer 尺寸及其失效 key（`宽度|行集合指纹`）。 */
const lastMeasure = { key: '', w: 0, h: 0 }
/** 上一次上报给主进程的 display 事实（payload 相同时不重复 IPC，主进程也就不必反复 setBounds）。 */
let lastDisplayKey = ''

/**
 * 面板入口行的图标口径 —— 与 rail / navbar 的面板按钮一致（18px；颜色见样式表
 * `.hira-sb-icon.is-panel-entry`）。
 *
 * 地址栏里只有「询问 AI」属于这一类：它不是一个结果类型，而是"侧栏那个面板"的
 * 快捷入口，所以按面板按钮画，而不是按搜索结果画（16px + 次要灰）。
 */
const PANEL_ENTRY_ICON_SIZE = 18

// ── 类型 → 图标名（共用图标表 ui-common/icons）────────────────
const TYPE_ICON: Record<string, string> = {
  search: 'Search',
  website: 'Globe',
  'open-tab': 'AppWindow',
  'search-history': 'Clock',
  calc: 'Calculator',
  pedal: 'Zap',
  // 即时答案（F-0771~F-0773）：圆圈信息点（ui-common/icons#Info）
  'instant-answer': 'Info',
  // 「询问 AI」：AI 插件的建议行（类型由插件声明，图标在这里统一给一张）。
  'ai-ask': 'Sparkles',
  // 开发态提示：三角感叹号（ui-common/icons#TriangleAlert）
  'dev-mode': 'TriangleAlert'
}

/**
 * 行图标节点：站点行走 **favicon 真源**，失败或没有站点时退回类型图标。
 *
 * 「这张行该显示哪张站点图」的规则只在 `shared-types/favicon-src.mjs` 一处：
 *   数据行带 favicon → 主进程字节代理；没带 → `<origin>/favicon.ico`；都不行 → 类型图标。
 * 改造前这里只认 `img.src = s.favicon`：
 *   · 历史行（favicon 常为 null）与已打开标签（域层当时没透传）永远拿不到图，
 *     国内网络下直连站点还会「挂住」—— 图标位一直空白，连降级都不触发；
 *   · 与面板 / 书签栏 / 内部页的取图规则分叉，同一个站点这里空白、那里有图。
 *
 * 没有 url 的行（搜索历史 / 计算器 / 快捷动作 / 开发提示）本来就没有站点可去，
 * 仍用类型图标。即时答案的图标来自上游 provider，不是站点图标，单独一条。
 *
 * ⚠ 搜索项（`type:'search'`：verbatim 兜底搜索、`!引擎` 行）**不解析站点图标** ——
 * 它的 url 只是"搜索引擎的查询地址"，拿去取 favicon 得到的是引擎自己的品牌图标
 * （Google 的 G、Bing 的 b…），观感上像"要打开 Google 这个站"，而它其实是一次搜索。
 * 这一档统一给中性的搜索图标；真要展示来源，右侧已经有「快捷搜索 / 引擎名」标签。
 */
function buildIconNode(s: SearchSuggestion): HTMLElement {
  const box = document.createElement('span')
  box.className = 'hira-sb-icon'
  const fallback = () => {
    box.textContent = ''
    const svg = iconByName(TYPE_ICON[s.type || ''] || 'Search', document, { size: 16 })
    if (svg) box.appendChild(svg)
  }

  if (s.type === 'instant-answer') {
    if (!s.icon) {
      fallback()
      return box
    }
    const img = document.createElement('img')
    img.referrerPolicy = 'no-referrer'
    img.addEventListener('error', fallback)
    img.src = s.icon
    box.appendChild(img)
    return box
  }

  // 「询问 AI」不是站点行：它带 url 是为了提交导航，但那个 url 是 `hira://ai`，
  // 拿去解析 favicon 只会得到一张内部页图标（还可能白等一次请求）—— 直接用类型图标。
  //
  // ⚠ 它其实是**面板入口在地址栏的投影**（点下去就是侧栏那颗 AI 助手），所以尺寸/颜色
  //   必须跟 rail / navbar 的面板按钮完全同口径：18px + UI 前景色（rail 的
  //   `.hira-rail-item svg` = 18px、color = `--hira-chrome-fg`）。
  //   行图标那套是 16px + 次要灰，只适合"搜索结果"，用在这里会让人认不出是同一个东西。
  if (s.type === 'ai-ask') {
    box.classList.add('is-panel-entry')
    box.textContent = ''
    const svg = iconByName(TYPE_ICON['ai-ask'], document, { size: PANEL_ENTRY_ICON_SIZE })
    if (svg) box.appendChild(svg)
    return box
  }

  // 搜索项（verbatim 兜底搜索 / `!引擎` 行）同理不是站点行：url 是搜索引擎的查询地址，
  // 取 favicon 只会拿到引擎品牌图标（每行都是同一个 G / b），既像"打开站点"又多一次请求。
  // 统一给 Search 图标（见 TYPE_ICON），来源信息由右侧标签承担。
  if (s.type === 'search') {
    fallback()
    return box
  }

  // 带页面地址的建议（website / open-tab）按站点解析 —— 它们点下去真的是去那个站点。
  const candidates = s.url ? faviconSourceCandidates(s.url, s.favicon ?? null) : null
  if (candidates && candidates.primary) {
    box.appendChild(createFaviconImg(document, candidates, { size: 16, borderRadius: 3, onFail: fallback }))
    return box
  }

  fallback()
  return box
}

function primaryText(s: SearchSuggestion): string {
  switch (s.type) {
    case 'search': return s.query || ''
    case 'website': return s.title || ''
    case 'open-tab': return s.title || ''
    case 'search-history': return s.query || ''
    case 'calc': return `${s.expression || ''} = ${s.result || ''}`
    case 'pedal': return s.title || ''
    // 即时答案：主文本就是答案/摘要/条目本身（标题由主进程裁到 160 字内）
    case 'instant-answer': return s.title || ''
    // 「询问 AI」：标题由建议提供者写好（`询问 AI：<输入>`），宿主不拼文案。
    case 'ai-ask': return s.title || ''
    // 开发态提示：纯状态行，无 url / query，点击与回车都不产生导航
    case 'dev-mode': return s.title || ''
    default: return ''
  }
}

/**
 * 右侧「来源」标签。
 *
 * 界面文本一律本地化：来源字段是**语义**（history / bookmark / …），直接显示英文
 * 会很出戏；映射到中文标签。未知的（引擎品牌名 google / bing / baidu…）原样显示 ——
 * 那些是用户认得的专有名词，翻译反而失真。空串表示"无需标注"（如 verbatim 搜索兜底）。
 */
function secondaryText(s: SearchSuggestion): string {
  // **URL 命中**：右侧给的是"命中附近的部分 URL"（domain-search 的 `matchSnippet`，
  // 命中处居中、两端省略），而不是只到主机名的 `displayUrl` —— 用户输入往往落在路径里，
  // 只显示主机名等于没解释这条记录为什么会出现。高亮由 `buildSecondaryNode` 画。
  if (s.matchField === 'url' && s.urlMatch) return s.urlMatch
  const src = String(s.source || '')
  if (s.type === 'search-history') return '搜索历史'
  if (s.type === 'open-tab') return '已打开的标签页'
  if (s.type === 'calc') return '计算器'
  if (s.type === 'pedal') return s.source === 'panel' ? '面板' : '快捷操作'
  // 即时答案右侧只标来源（Wikipedia / DuckDuckGo / 相关结果），不堆正文。
  if (s.type === 'instant-answer') return s.provider || '即时答案'
  // 「询问 AI」只标来源身份，不重复标题里已有的输入内容。
  if (s.type === 'ai-ask') return 'AI 助手'
  if (s.type === 'dev-mode') return '开发模式'
  if (src.startsWith('bang:')) return '快捷搜索'
  if (src === 'bookmark') return '书签'
  if (src === 'history') return '历史记录'
  if (src === 'verbatim' || src === 'remote' || src === 'open-tab' || src === 'search-history') {
    // 来源语义无需标注时，退而显示主机名（domain-search 预计算的 shortUrl）——
    // 让「这条建议指向哪个站」一眼可见，也避免右侧留白。
    return s.displayUrl || ''
  }
  return src || s.displayUrl || ''
}

/**
 * 右侧文本节点。唯一需要**分段着色**的情形是「URL 命中」：把片段里跟当前输入
 * 大小写不敏感命中的字符包进 `.hira-sb-hit`，让用户一眼看到"我输的这几个字在哪"。
 *
 * 只对 `matchField === 'url'` 的行做 —— 来源标签、标题、引擎名都不高亮，
 * 否则一屏都是加粗，反而看不出哪条是真的命中了输入。
 *
 * @param {unknown} s
 * @returns {HTMLElement}
 */
function buildSecondaryNode(s: SearchSuggestion): HTMLElement {
  const box = document.createElement('span')
  box.className = 'hira-sb-secondary'
  const text = secondaryText(s)
  const q = (currentQuery || '').trim()
  if (!text || !q || s.matchField !== 'url') {
    box.textContent = text
    return box
  }
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let from = 0
  let at = lower.indexOf(needle, from)
  if (at < 0) {
    box.textContent = text
    return box
  }
  while (at >= 0) {
    if (at > from) box.appendChild(document.createTextNode(text.slice(from, at)))
    const hit = document.createElement('span')
    hit.className = 'hira-sb-hit'
    hit.textContent = text.slice(at, at + needle.length)
    box.appendChild(hit)
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  if (from < text.length) box.appendChild(document.createTextNode(text.slice(from)))
  return box
}

/**
 * 默认行渲染（没有任何插件接管 `omnibar.result-item-renderer` 时走这里）。
 */
function buildDefaultRow(s: SearchSuggestion): HTMLElement {
  const row = document.createElement('div')
  row.className = 'hira-searchbar-row'

  row.appendChild(buildIconNode(s))

  const primary = document.createElement('span')
  primary.className = 'hira-sb-primary'
  primary.textContent = primaryText(s)
  row.appendChild(primary)

  row.appendChild(buildSecondaryNode(s))

  return row
}

/**
 * 这条建议能删什么 —— 返回 `{ action, id, label }`，不能删返回 null。
 *
 * 只有**历史**可删，且两种历史的实体不同：
 *   · 搜索词历史（`type: 'search-history'`）—— 删的是 `search_history` 里的一行；
 *   · 浏览历史（`source: 'history'`）—— 删的是 `history` 聚合行（`historyId`，
 *     domain-search 随建议下发），即"这个网址的浏览痕迹"。
 * 书签**刻意不给**删除：那是用户显式收藏，不是浏览痕迹（它有自己的编辑入口）。
 * 插件贡献的建议也没有 `historyId` —— 数据库里没有对应行，自然不出现按钮。
 */
function removableHistoryTarget(s: SearchSuggestion): { action: string; id: string; label: string } | null {
  if (!s) return null
  if (s.type === 'search-history' && s.id) {
    return { action: 'remove-search-history', id: s.id, label: '删除这条搜索历史' }
  }
  if (s.source === 'history' && s.historyId) {
    return { action: 'remove-history', id: s.historyId, label: '删除这条浏览记录' }
  }
  return null
}

/**
 * 行尾「×」：永久删除这条历史（悬停 / 选中才浮现，见 CSS）。
 *
 * 与书签「编辑」同一套机制：按钮自己掐掉 mousedown，避免把点击当成"打开这一条"；
 * 事件一律读 `row.__ngRow`（节点是 keyed 复用的）。
 * 本层**只报事实**（action + id），不就地摘行 —— 删完由外壳重查建议、带着新列表
 * 回到 `showSearchbar`，行与卡片高度一起更新（见 click 里的说明）。
 */
function attachRemoveHistoryAction(row: SearchRowElement, s: SearchSuggestion): void {
  const target = removableHistoryTarget(s)
  if (!target) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'hira-sb-remove'
  btn.textContent = '×'
  btn.title = target.label
  btn.setAttribute('aria-label', target.label)
  /**
   * 真正发一次删除动作。
   *
   * 节点会被 keyed 复用 —— 一律读**当前**这条建议，而不是创建时的闭包变量。
   *
   * ⚠ 必须走 `overlay:commit`（kind = overlay-action）：这条通道由主进程按 kind 路由
   * 回发起方视图（见 main/ipc/layout.js#COMMIT_OWNER），app-shell 收到后才真正落库删除。
   * `overlay:action` 那条通道的 app-shell 订阅者只打日志，**删不掉**。
   *
   * 这里**不**就地摘行：建议的真源是外壳的 `currentSuggestions`，浮层手里只是渲染快照。
   * 本地摘掉会让两边漂移（方向键 + 回车能提交到刚删掉的那一条），所以由外壳删完
   * 重查一次 → `showSearchbar` 带新列表回来，行与卡片高度一起更新。
   */
  const removeEntry = () => {
    const cur = (row.__ngRow && row.__ngRow.s) || s
    const hit = removableHistoryTarget(cur)
    if (!hit) return
    try {
      getHiraBridge().provider.send('overlay:commit', { kind: 'overlay-action', action: hit.action, id: hit.id })
    } catch {}
  }
  // ⚠ 动作必须在 **mousedown** 发出去，不能等 click：
  // 下拉是独立 WebContentsView，指针按下去的那一瞬 Chromium 就**原生**把键盘焦点
  // 从外壳手里拿走 —— 外壳输入框 blur（随后收起下拉、清空 DOM），等 click 到达时
  // 按钮早已不在文档树里。表现就是"点一下就关，而且根本没删掉"。
  // 行提交同理（见 renderSuggestion 里的 mousedown）。
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    removeEntry()
  })
  // 键盘激活（回车 / 空格）不产生 mousedown，只派发 `detail === 0` 的 click —— 补一条兜底。
  // 鼠标点击的 click（detail >= 1）已经在上面发过，不能再发第二次（会删两条 / 重复请求）。
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.detail === 0) removeEntry()
  })
  row.appendChild(btn)
}

/**
 * 书签行「编辑」动作（**机制层**，不归行渲染插件）。
 *
 * 只认 `source === 'bookmark'`：同一 URL 同时命中历史与书签时，domain-search 已按来源
 * 加权去重并保留 bookmark，所以这里不会把普通历史行误变成书签编辑器。
 *
 * 动作**不在本层执行** —— 浮层不认识子窗口类型，只上报
 * `overlay-action / edit-bookmark`，由 app-shell 转成
 * `window:open { type:'edit-bookmark' }`。单向依赖：overlay → app-shell。
 */
function attachBookmarkEditAction(row: SearchRowElement, s: SearchSuggestion): void {
  if (!s || s.source !== 'bookmark' || !s.url) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'hira-sb-action'
  btn.title = '编辑书签'
  const svg = iconByName('Pencil', document, { size: 14 })
  if (svg) btn.appendChild(svg)
  else btn.textContent = '✎'
  // 与行 mousedown 的提交互斥：按钮按下时**不能**触发导航（行是 mousedown 提交的）。
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    // 行节点 keyed 复用 → 读当前建议（签名保证 source/url/title 一致，这里只是取最新引用）。
    const cur = (row.__ngRow && row.__ngRow.s) || s
    if (!cur.url) return
    try {
      getHiraBridge().provider.send('overlay:commit', {
        kind: 'overlay-action',
        action: 'edit-bookmark',
        url: cur.url,
        title: cur.title || ''
      })
    } catch {}
    hideSearchbar()
  })
  row.appendChild(btn)
}

/**
 * 行内容签名 —— 决定"这个节点还能不能复用"。
 *
 * 覆盖所有会被画进 DOM 的字段（图标来源、主/次文本、删除按钮、书签编辑按钮）。
 * 签名相同 = 复用节点（favicon 不重解码、监听不重绑）；不同 = 重建该行。
 * `relevance` / `tabId` 之类不参与绘制的字段刻意不纳入，避免无谓重建。
 */
const ROW_SIG_FIELDS = [
  'type', 'id', 'url', 'query', 'title', 'favicon', 'icon',
  'source', 'displayUrl', 'provider', 'expression', 'result', 'action',
  // 浏览历史的聚合行 id：它决定这一行**有没有**「×」（以及删的是哪一行），
  // 有→无（或换了 id）都必须重建，否则复用的节点会留着指向旧记录的删除按钮。
  'historyId',
  // 命中信息：URL 命中会改写次级文本并高亮，变了一定要重建这一行。
  'matchField', 'urlMatch'
]

function rowSignature(s: SearchSuggestion): string {
  let sig = ''
  for (let i = 0; i < ROW_SIG_FIELDS.length; i++) {
    const v = s[ROW_SIG_FIELDS[i]]
    sig += (v == null ? '' : String(v)) + '\u0001'
  }
  return sig
}

/**
 * 创建一行建议。
 *
 * 插件可以接管"长什么样"（返回 HTMLElement），但**选中/提交由本函数统一接管**：
 * 这些是下拉栏的机制（键盘上下移动要能同步高亮、点击要 commit），交给每个插件各写
 * 一份必然漂移（"插件做的行键盘选不中"就是这么来的）。
 *
 * 悬停不是机制：它只是 CSS 视觉反馈，不参与任何状态（见下方 mouseenter 说明）。
 *
 * ⚠ 监听器只在创建时绑**一次**，回调一律读 `node.__ngRow`（见 repaintRows 的 keyed 复用）。
 */
function createRow(s: SearchSuggestion, index: number): SearchRowElement {
  const custom = callRendererSlot('omnibar.result-item-renderer',
    { suggestion: s, index, selected: index === currentSelectedIndex }, null)
  const row = (custom instanceof Element ? custom : buildDefaultRow(s)) as SearchRowElement
  // 插件行可能是"按位置"画的（编号、首行强调…）：位置一变就必须重建。
  row.__ngCustom = row === custom

  row.classList.add('hira-searchbar-row')
  row.style.cursor = 'pointer'
  // 书签行的「编辑」入口同样挂在机制层：插件只管长什么样，动作归宿主。
  attachBookmarkEditAction(row, s)
  // 历史行（搜索词 / 浏览记录）的「×」也在机制层：插件行也照样能删历史。
  attachRemoveHistoryAction(row, s)
  // **在 mousedown 上提交** —— 主流菜单 / 命令面板的既有做法：
  // 点建议项时，本浮层这个**独立 view** 会原生抢走键盘焦点 → 外壳地址栏收到一次**真实**失焦
  // → 外壳立刻收起浮层。若仍等 click（mouseup）才提交，那次收起可能抢先一步把本 view
  // 收成 0×0，点击就丢了。改成 mousedown 提交：动作在焦点转移的同一拍就发出去，稳。
  row.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const entry = row.__ngRow
    if (entry) commitSuggestion(entry.s)
  })
  // ⚠ 悬停**只做视觉反馈**（CSS `.hira-searchbar-row:hover`），绝不改变选中项。
  //
  //   这里曾绑过 `mouseenter → currentSelectedIndex = entry.index`：于是鼠标恰好停在
  //   首行时会"看起来选中"它，而回车是否也选它取决于 navbar 侧的 selectedIndex ——
  //   两边一旦不同步（默认位不在首行时），用户看到的高亮就和回车实际执行的不一致。
  //   选中项的唯一写入方是**键盘方向键**（navbar 侧 selectedIndex + updateSelection），
  //   鼠标只有"点击某一行"才是明确选择（mousedown 提交，见上）。

  return row
}

/**
 * 选择态切换：只碰"旧高亮"和"新高亮"两个节点（O(1)）。
 * 改造前是 `querySelectorAll(...).forEach(toggle)` —— 方向键每移一格全量写类名。
 */
function updateSelection() {
  const node = rowNodes[currentSelectedIndex] || null
  if (selectedNode && selectedNode !== node) selectedNode.classList.remove('is-selected')
  if (node && node !== selectedNode) node.classList.add('is-selected')
  selectedNode = node
}

// ── 显示/隐藏 ────────────────────────────────────────────────
/**
 * 用 `currentSuggestions` 对账出全部行（首次展示 / 每次按键 / 插件启停后重画共用）。
 *
 * keyed reconcile：同一条建议复用同一节点，只有新行才创建 DOM，消失的行才移除。
 * 顺带记录行集合指纹（`rowSetKey`），供 `showSearchbar` 判断尺寸缓存是否仍有效。
 */
function repaintRows() {
  const counts = new Map()
  const live = new Set()
  const nodes: HTMLElement[] = []
  const keys: string[] = []
  let anchor = card.firstChild

  currentSuggestions.forEach((s, i) => {
    const base = String(s.id || `${s.type}:${s.url || s.query || s.title || ''}`)
    const ordinal = counts.get(base) || 0
    counts.set(base, ordinal + 1)
    const key = ordinal === 0 ? base : `${base}#${ordinal}`
    const sig = rowSignature(s)

    let entry = rowRegistry.get(key)
    if (entry && entry.sig === sig && (!entry.custom || entry.index === i)) {
      // 同一条建议、内容也没变 → 复用节点，只刷新引用与序号。
      entry.s = s
      entry.index = i
    } else {
      // 内容变了（或首次出现）→ 只重建这一行。
      if (entry) {
        // 游标正指向这一行时先推进，否则移除后 anchor 会脱离文档树，
        // 后续 insertBefore(node, anchor) 会抛 NotFoundError。
        if (entry.node === anchor) anchor = anchor.nextSibling
        entry.node.remove()
      }
      const node = createRow(s, i)
      entry = { node, sig, s, index: i, custom: !!node.__ngCustom }
      node.__ngRow = entry
      rowRegistry.set(key, entry)
    }

    nodes.push(entry.node)
    live.add(key)
    keys.push(key)

    // 按序就位：位置已对就不动（最小 DOM 操作），否则插到游标前。
    if (entry.node === anchor) anchor = anchor.nextSibling
    else {
      // 兜底：游标已脱离文档树（被本轮的移除操作摘掉）时改为追加到末尾。
      if (anchor && anchor.parentNode !== card) anchor = null
      card.insertBefore(entry.node, anchor)
    }
  })

  // 淘汰本轮不再出现的行。
  for (const [key, entry] of rowRegistry) {
    if (live.has(key)) continue
    entry.node.remove()
    rowRegistry.delete(key)
  }

  rowNodes = nodes
  rowSetKey = keys.join('|')
  updateSelection()
}

/** 强制全部重建（插件启停后：同一份数据现在要由**新插件**来画）。 */
function rebuildRows() {
  for (const entry of rowRegistry.values()) entry.node.remove()
  rowRegistry.clear()
  rowNodes = []
  selectedNode = null
  lastMeasure.key = ''
  repaintRows()
}

/**
 * 展示命令面板。
 * @param {{ anchor?: {left:number, top:number, width:number, height:number, align?:'left'|'right'},
 *           suggestions?: unknown[], selectedIndex?: number }} payload
 */
function showSearchbar(payload: SearchbarPayload = {}) {
  const p = payload || {}
  const anchor = p.anchor || { left: 0, top: 0, width: 0, height: 0 }
  // 新一轮建议 = 新一轮"打字中"：静止的光标不构成悬停，直到鼠标再次移动。
  mouseActive = false
  card.classList.remove('hira-mouse')
  currentSuggestions = Array.isArray(p.suggestions) ? p.suggestions : []
  currentQuery = typeof p.query === 'string' ? p.query : ''
  // 选中态由 navbar 权威下发；缺省（调用方没给）= **不选中任何行** ——
  // 与"没按过方向键就没有选中项"同一条口径，绝不默认落在首行。
  currentSelectedIndex = typeof p.selectedIndex === 'number' ? p.selectedIndex : -1
  repaintRows()

  // 卡片宽度由 ui-searchbar 按宿主形态与可用空间算好；高度仍由内容自然决定，
  // CSS max-height 封顶后内部滚动。
  const cardW = Math.max(120, Math.round(anchor.width || 0))
  if (cardW !== cardWidth) {
    card.style.width = `${cardW}px`
    cardWidth = cardW
  }
  if (card.style.display !== 'block') card.style.display = 'block'

  // 实测卡片尺寸 → 加上阴影留白组成 view 的 outer 尺寸上报。
  // **只在"宽度或行集合变了"时才量** —— 打字过程中行内容每键都在变，但行集合
  // （行数 / 行高）通常不变，此时复用上次实测值，省掉一次写后读的强制同步布局。
  const measureKey = `${cardW}|${rowSetKey}`
  if (measureKey !== lastMeasure.key) {
    const rect = card.getBoundingClientRect()
    lastMeasure.key = measureKey
    lastMeasure.w = Math.round(rect.width) + PAD.left + PAD.right
    lastMeasure.h = Math.ceil(rect.height) + PAD.top + PAD.bottom
  }
  display(lastMeasure.w, lastMeasure.h, anchor, true)
}

function hideSearchbar() {
  card.style.display = 'none'
  currentSuggestions = []
  currentSelectedIndex = -1
  currentQuery = ''
  // 下次展示重新量一次（期间可能换主题 / 换字体 / 换 DPI），但打字过程中仍然复用。
  lastMeasure.key = ''
  // 下次展示必须重新上报一次（主进程 hide 时已把 view 收起）。
  lastDisplayKey = ''
  // 不再向主进程回传 bounds/interactive —— hide 已由主进程直接收起
}

function commitSuggestion(s: SearchSuggestion): void {
  try { getHiraBridge().provider.send('overlay:commit', { kind: 'searchbar', suggestion: s }) } catch {}
  hideSearchbar()
}

/**
 * 上报 outer 尺寸 + 落位事实。`position: 'anchor-below'` 由主进程算几何并夹取，
 * 本层不再自己算坐标（改造前这里写死 padding + 主进程 center，导致下拉不贴地址栏）。
 */
function display(width: number, height: number, anchor: SearchbarAnchor, interactive: boolean): void {
  // 同一份"落位事实"不重复上报：主进程每次都要 anchorFloatBelow + setBounds，
  // 打字期间锚点与尺寸通常不变 —— 逐键 IPC 纯属白烧。
  const nextKey = `${width}x${height}|${anchor.left},${anchor.top},${anchor.width},${anchor.height},${anchor.align || 'left'}|${interactive ? 1 : 0}`
  if (nextKey === lastDisplayKey) return
  try {
    getHiraBridge().provider.send('searchbar-overlay:display', {
      width,
      height,
      interactive,
      position: 'anchor-below',
      anchor,
      pad: PAD,
      gap: GAP,
      // 与窗口内容区四边的最小留白 —— 整块浮层（含阴影）都不贴窗口边缘。
      margin: EDGE_MARGIN
    })
    lastDisplayKey = nextKey
  } catch {}
}

// ── 监听 IPC 事件（独立通道）────────────────────────────────
const bridge = getHiraBridge()

bridge.on.subscribe<SearchbarPayload>(IPC_EVENTS.searchbarOverlayShow, (payload) => showSearchbar(payload))
bridge.on.subscribe(IPC_EVENTS.searchbarOverlayHide, () => hideSearchbar())
// 建议来自当前 profile 的搜索历史 / 已打开标签；切换身份后旧列表必须立即消失。
bridge.on.subscribe(IPC_EVENTS.profileChanged, () => hideSearchbar())
bridge.on.subscribe(IPC_EVENTS.searchbarOverlayUpdateSelection, (p) => {
  if (p && typeof p.selectedIndex === 'number') {
    currentSelectedIndex = p.selectedIndex
    updateSelection()
  }
})

// 通知主进程本浮层 renderer 已就绪
;(async () => {
  try { await bridge.provider.invoke('searchbar-overlay:ready', {}) } catch {}
})()

// ── 渲染侧插件插槽激活 ──────────────────────────────────────
// 晚于上面的 defineRendererSlots。插件启停后重跑一次：注册表整体重建，
// 并且**必须重画已显示的下拉** —— 否则用户眼前那一列还是旧插件画的 DOM。
activateRendererSlots().catch((error) => {
  console.error('[searchbar] renderer slots activation failed:', error)
})
const offPluginSlotsChanged = pluginsClient.onChanged(() => {
  activateRendererSlots().then(() => {
    // 换插件后同一份数据要由新插件重新画 → 必须强制重建（不能走 keyed 复用）。
    if (card.style.display !== 'none') rebuildRows()
  }).catch((error) => {
    console.error('[searchbar] renderer slots refresh failed:', error)
  })
})
window.addEventListener('pagehide', offPluginSlotsChanged, { once: true })


