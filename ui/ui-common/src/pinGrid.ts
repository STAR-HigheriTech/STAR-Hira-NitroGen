/**
 * @hira-ng/ui-common#createPinGrid —— 「固定标签」的**网格视图**（A4 / Pin Grid）。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────────
 * 把固定标签从"一条横条"变成"一页网格"：每个固定标签是一张**大卡片**（大图标 +
 * 标题），hover 出预览、点击打开、右键出菜单、拖动改顺序、卡片角上的小喇叭一键静音。
 * 于是固定标签一多也能一眼扫视（信息密度远高于横条）。
 *
 * ── 文件夹（与列表形态同一份语义）──────────────────────────────────────────
 * 固定标签恒属于一个**固定文件夹**（`pinned: true` 的标签栈）。列表形态里它是可收展的
 * 组行；网格形态里它是**整行宽的文件夹抬头**（Folder 图标 + 名称 + 计数 + 折叠箭头），
 * 其成员卡片排在抬头下面，收起即隐藏。抬头与标签组行共用同一套动作（由面板注入）：
 * 点抬头收展、双击改名、右键进组菜单、把卡片拖到抬头上 = 移入该文件夹。
 *
 * 数据契约（`setItems`，两种条目可混排）：
 *   { type: 'folder', stackId, label, accent, collapsed, count, children: Tab[] }
 *   Tab（扁平标签，作为"散固定标签"或文件夹成员的容器）
 * 面板负责把 projection 翻译成这个形状 —— 本组件不认识 IPC / 栈 / 持久化。
 *
 * ── 为什么单独一个模块、而不是改写 tabRowList ────────────────────────────────
 * 纵向列表（`tabRowList`）的每一行是"又宽又扁的一条"，与网格的"一个方块"是**两种
 * 布局**：行的量宽 / 方向 / 落点语义全不同。硬塞进一个组件会变成一堆 `if (mode===grid)`。
 * 因此这里只做**网格这一种形态**，与列表**并列**存在 —— 面板按用户选的模式装配其一
 * （两种模式统一由面板管理，见 ui-panel-opentabs#pinnedView）。二者共用的是**同一批下层件**：
 * favicon 徽标（favicon.ts）、hover 预览状态机（hoverPreview.ts）、
 * 预览载荷事实（tabPreviewFacts.ts）、行内改名槽位（tab/renameSlot.ts）—— 因此
 * "预览什么时候弹、改名怎么提交"两处必然一致。
 *
 * ── 常量与 HiraRT 逐字同源 ────────────────────────────────────────────────
 * `MIN_TAB_WIDTH=80` / `GAP=8` / `MAX_COLS=5` / `DEFAULT_COLS=3`，列数算法亦同：
 *   cols = clamp( floor((width + GAP) / (MIN_TAB_WIDTH + GAP)), 1, min(count, MAX_COLS) )
 * 见 RT `browser-sidebar/_components/pin-grid/normal/use-pin-grid-columns.ts`。
 *
 * ── 它不认识谁 ────────────────────────────────────────────────────────────
 * 不认识 IPC、不认识面板、不认识右键菜单模板：点击 / 右键 / 静音 / 重排 / 预览
 * 全部由 opts 注入（与 tabRowList 同一个端口范式）。
 */

import { createFaviconBadge } from './favicon'
import { applyFaviconColor, TAB_FAVICON_BG_VAR, TAB_FAVICON_FG_VAR } from './faviconColor'
import { createHoverPreview } from './hoverPreview'
import { tabPreviewFacts } from './tabPreviewFacts'
import { createRenameSlot } from './tab/renameSlot'
import { Folder, ChevronDown, ChevronRight } from './icons'
import { stackDisplayLabel } from './tabStackActions'
import { audioToggleLabel } from './tab/audioLabel'
import type { TabPreviewSource } from './tabPreviewFacts'
import type { TabRowPreviewOverlay, TabRowTab } from './tabRowTypes'

export interface PinGridTab extends TabRowTab, TabPreviewSource {
  type?: 'tab'
  tabId: string | number
  title?: string
  url?: string
  favicon?: string
  active?: boolean
  muted?: boolean
  isPlaying?: boolean
  [key: string]: unknown
}

export interface PinGridFolderInput {
  type: 'folder'
  stackId: string | number
  label?: string
  accent?: string | null
  collapsed?: boolean
  count?: number
  children?: PinGridTab[]
  [key: string]: unknown
}

export type PinGridInput = PinGridFolderInput | PinGridTab

interface PinFolderEntry {
  kind: 'folder'
  stackId: string
  pinned: true
  label: string
  accent: string
  collapsed: boolean
  children: PinGridTab[]
}

interface PinTabEntry {
  kind: 'tab'
  tab: PinGridTab
}

type PinGridEntry = PinFolderEntry | PinTabEntry

export interface PinReorderInfo {
  draggedId: string
  targetId: string
  insertAfter: boolean
}

export interface PinGridOptions {
  onActivate?: (tab: PinGridTab) => void
  onContextMenu?: (tab: PinGridTab, event: MouseEvent, nextItem?: PinGridTab) => void
  onToggleMute?: (tab: PinGridTab) => void
  onReorder?: (info: PinReorderInfo) => void
  onToggleFolder?: (stackId: string) => void
  onFolderMenu?: (stackId: string, event: MouseEvent, api: { beginRename: () => void }) => void
  onRenameFolder?: (stackId: string, label: string) => void
  onMoveToFolder?: (tabId: string, stackId: string) => void
  overlay?: TabRowPreviewOverlay | null
  emptyText?: string
}

export interface PinGridController {
  element: HTMLDivElement
  setItems: (items: readonly PinGridInput[]) => void
  beginRenameFolder: (stackId: string) => boolean
  dispose: () => void
}

/** 单个固定卡片的最小宽度（与 RT 同源）。 */
export const PIN_MIN_TAB_WIDTH = 80
/** 卡片间距（RT 的 `gap-2` = 8px）。 */
export const PIN_GAP = 8
/** 网格最大列数（与 RT 同源）。 */
export const PIN_MAX_COLS = 5
/** 首次测量前的默认列数。 */
const DEFAULT_COLS = 3

const STYLE_ID = 'hira-pin-grid-styles'

/**
 * 网格列数（纯函数，便于单独验证 —— 与 RT 的算法逐字一致）。
 * @param {number} containerWidth 容器可用宽度（px）
 * @param {number} pinCount 卡片数量
 * @returns {number}
 */
export function computePinColumns(containerWidth: number, pinCount: number): number {
  let measured = DEFAULT_COLS
  if (containerWidth > 0) {
    measured = Math.max(1, Math.floor((containerWidth + PIN_GAP) / (PIN_MIN_TAB_WIDTH + PIN_GAP)))
  }
  const count = Number.isFinite(pinCount) ? Math.max(0, Math.floor(pinCount)) : 0
  const cap = count > 0 ? Math.min(count, PIN_MAX_COLS) : PIN_MAX_COLS
  return Math.max(1, Math.min(measured, cap))
}

/**
 * 注入网格样式（按 id 幂等；面板入口调用一次即可）。
 * @param {Document} doc
 */
export function injectPinGridStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .pingrid-root { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
    .pingrid-scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
    .pingrid-grid { display: grid; gap: ${PIN_GAP}px; padding: 2px 2px 8px; }
    .pingrid-card {
      position: relative; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 6px; min-height: 62px; padding: 8px 6px;
      border: 0; border-radius: var(--hira-radius-lg, 14px); cursor: pointer;
      background: transparent; box-sizing: border-box; overflow: hidden;
      color: var(--hira-text-secondary, #4b5563);
      ${TAB_FAVICON_BG_VAR}: var(--ng-tab-active-fg, var(--hira-accent, #3b82f6));
      ${TAB_FAVICON_FG_VAR}: var(--hira-bg-elevated, #fff);
      contain: layout style; -webkit-user-select: none; user-select: none;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .pingrid-card:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    /* 选中卡片 = tabbar 选中标签的同一组令牌（与 .tabrow-row--active 同源）：
       列表态 / 网格态切换时，"当前标签"是同一块底色；环用 inset 阴影画，不吃布局。 */
    .pingrid-card--active,
    .pingrid-card--active:hover {
      background: var(--ng-tab-active-bg, var(--bg-color, #fff));
      color: var(--ng-tab-active-fg, var(--hira-accent, #3b82f6));
      box-shadow: inset 0 0 0 1px var(--ng-tab-active-border-color, rgba(100, 116, 139, 0.32));
    }
    .pingrid-card--dragging { opacity: 0.4; }
    .pingrid-card--drop-before::before,
    .pingrid-card--drop-after::after {
      content: ''; position: absolute; top: 6px; bottom: 6px; width: 2px;
      background: var(--hira-accent, #3b82f6); border-radius: 2px;
    }
    .pingrid-card--drop-before::before { left: -${Math.round(PIN_GAP / 2)}px; }
    .pingrid-card--drop-after::after { right: -${Math.round(PIN_GAP / 2)}px; }
    .pingrid-fav { display: flex; align-items: center; justify-content: center; pointer-events: none; }
    .pingrid-title {
      width: 100%; font-size: 11px; line-height: 1.3; text-align: center;
      color: var(--hira-text-secondary, #4b5563); word-break: break-word;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      pointer-events: none;
    }
    .pingrid-card--active .pingrid-title { color: var(--ng-tab-active-fg, var(--hira-accent, #3b82f6)); font-weight: 500; }
    .pingrid-audio {
      position: absolute; right: 3px; bottom: 3px; width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
      border: 0; padding: 0; background: transparent;
      border-radius: var(--hira-radius-xs, 6px);
      color: var(--hira-text-tertiary, #8b8b8b); cursor: pointer;
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .pingrid-audio:hover { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    .pingrid-empty {
      grid-column: 1 / -1; padding: 48px 20px; text-align: center;
      font-size: 12px; line-height: 19px; color: var(--hira-text-tertiary, #8b8b8b);
    }

    /* ── 固定文件夹抬头（网格形态）────────────────────────────────────────────
       整行宽的软底条：Folder 图标 + 名称 + 计数 + 折叠箭头。无描边，用浅色底
       与留白区分层级；配色只作用于图标 / 文字，不铺满整块。 */
    .pingrid-folder {
      grid-column: 1 / -1;
      display: flex; align-items: center; gap: 6px;
      min-height: 32px; padding: 5px 10px; margin-top: 6px;
      border: 0;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.035));
      color: var(--pin-folder-accent, var(--hira-text-secondary, #4b5563));
      cursor: pointer; box-sizing: border-box;
      -webkit-user-select: none; user-select: none;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .pingrid-folder:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .pingrid-folder--drop { background: var(--hira-accent-soft, rgba(59,130,246,0.14)); }
    .pingrid-folder-arrow { display: inline-flex; align-items: center; flex-shrink: 0; opacity: 0.65; }
    .pingrid-folder-icon { display: inline-flex; align-items: center; flex-shrink: 0; opacity: 0.9; }
    .pingrid-folder-label {
      flex: 1 1 auto; min-width: 0; font-size: 11.5px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pingrid-folder-count {
      flex-shrink: 0; min-width: 16px; text-align: center; padding: 0 7px;
      border-radius: var(--hira-radius-xs, 6px); font-size: 10px; line-height: 16px;
      background: var(--hira-surface-soft, rgba(0,0,0,0.05));
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .pingrid-folder-rename {
      flex: 1 1 auto; min-width: 0; font: inherit; font-size: 11.5px; font-weight: 500;
      color: var(--hira-text-primary, inherit); background: var(--hira-field-bg, rgba(0,0,0,0.05));
      border: 0; border-radius: var(--hira-radius-xs, 6px);
      padding: 4px 8px; outline: none; box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,0.35));
    }
  `
  doc.head.appendChild(style)
}

/**
 * 造一张「固定标签网格」。
 *
 * @param {Document} doc
 * @param {{
 *   onActivate?: (tab: PinGridTab) => void,
 *   onContextMenu?: (tab: PinGridTab, ev: MouseEvent, nextItem?: PinGridItem) => void,
 *   onToggleMute?: (tab: PinGridTab) => void,
 *   onReorder?: (info: { draggedId: string, targetId: string, insertAfter: boolean }) => void,
 *   onToggleFolder?: (stackId: string) => void,
 *   onFolderMenu?: (stackId: string, ev: MouseEvent, api: { beginRename: () => void }) => void,
 *   onRenameFolder?: (stackId: string, label: string) => void,
 *   onMoveToFolder?: (tabId: string, stackId: string) => void,
 *   overlay?: { showTabPreview?: Function, hideTabPreview?: Function, warmTabPreview?: Function } | null,
 *   emptyText?: string
 * }} [opts]
 * @returns {{
 *   element: HTMLElement,
 *   setItems: (items: readonly PinGridInput[]) => void,
 *   beginRenameFolder: (stackId: string) => boolean,
 *   dispose: () => void
 * }}
 */
export function createPinGrid(doc: Document, opts: PinGridOptions = {}): PinGridController {
  injectPinGridStyles(doc)
  const onActivate = typeof opts.onActivate === 'function' ? opts.onActivate : () => {}
  const onContextMenu = typeof opts.onContextMenu === 'function' ? opts.onContextMenu : null
  const onToggleMute = typeof opts.onToggleMute === 'function' ? opts.onToggleMute : null
  const onReorder = typeof opts.onReorder === 'function' ? opts.onReorder : null
  const onToggleFolder = typeof opts.onToggleFolder === 'function' ? opts.onToggleFolder : () => {}
  const onFolderMenu = typeof opts.onFolderMenu === 'function' ? opts.onFolderMenu : null
  const onRenameFolder = typeof opts.onRenameFolder === 'function' ? opts.onRenameFolder : null
  const onMoveToFolder = typeof opts.onMoveToFolder === 'function' ? opts.onMoveToFolder : null
  const overlay = opts.overlay || null
  const emptyText = String(opts.emptyText || '没有固定标签')

  const root = doc.createElement('div')
  root.className = 'pingrid-root'
  const scroll = doc.createElement('div')
  scroll.className = 'pingrid-scroll'
  const grid = doc.createElement('div')
  grid.className = 'pingrid-grid'
  scroll.appendChild(grid)
  root.appendChild(scroll)

  /** 规范化后的条目：{ kind:'folder' | 'tab', key, ... }。 */
  let entries: PinGridEntry[] = []
  const nodeByKey = new Map<string, HTMLElement>()
  /** 拖拽源 tabId（独立 WebContentsView 下 dataTransfer.getData 不可靠，用闭包变量）。 */
  let dragId = ''
  /** 当前落点提示所在的卡片（避免每个 dragover 都遍历全部卡片去清）。 */
  let hintCard: HTMLElement | null = null
  /** 落点高亮的文件夹抬头（与 hintCard 互斥，指针只能在一个目标上）。 */
  let hintFolder: HTMLElement | null = null

  /**
   * hover 预览状态机 —— 与纵向 / 横向列表**共用一份**（延迟 / 换锚 / 收起 / 按下即收 /
   * 锚点消失即收并锁到指针动过的规则一致，见 hoverPreview.ts 文件头六条）。`document`
   * 注入给它 → 规则 ⑤⑥ 自动生效，网格不必再自己写一遍。
   * 载荷走 `tabPreviewFacts`，外侧边界取滚动容器（与列表同一条理由，见该文件头）。
   */
  const hover = createHoverPreview<PinGridTab>({
    document: doc,
    // 意图预热：与两个列表同一条（见 tabRowList 里同一段的选择理由）。
    onIntent() {
      if (overlay && typeof overlay.warmTabPreview === 'function') {
        try { overlay.warmTabPreview() } catch (_) {}
      }
    },
    onShow(anchorEl, tab) {
      if (!overlay || typeof overlay.showTabPreview !== 'function') return
      const facts = tabPreviewFacts({ anchorEl, tab, stripEl: scroll })
      if (facts) overlay.showTabPreview(facts)
    },
    onHide() {
      if (overlay && typeof overlay.hideTabPreview === 'function') overlay.hideTabPreview()
    }
  })

  /** 行内改名（与列表同一个槽位实现：Enter/失焦提交、Esc 取消、点击不冒泡）。 */
  const rename = createRenameSlot(doc, { extraClasses: 'pingrid-folder-rename' })

  function clearDropHint() {
    if (hintCard) {
      hintCard.classList.remove('pingrid-card--drop-before', 'pingrid-card--drop-after')
      hintCard = null
    }
    if (hintFolder) {
      hintFolder.classList.remove('pingrid-folder--drop')
      hintFolder = null
    }
  }

  /** 指针落在卡片的左半还是右半 → 插入到它之前 / 之后。 */
  function edgeOf(card: HTMLElement, ev: DragEvent | MouseEvent): boolean {
    const rect = card.getBoundingClientRect()
    return (ev.clientX - rect.left) > rect.width / 2
  }

  /** 全部可见标签（按条目顺序，展开的文件夹展开成其成员）—— 重排与相邻判据用。 */
  function visibleTabs(): PinGridTab[] {
    const out: PinGridTab[] = []
    for (const entry of entries) {
      if (entry.kind === 'tab') out.push(entry.tab)
      else if (!entry.collapsed) out.push(...entry.children)
    }
    return out
  }

  function nextItemOf(tabId: string | number): PinGridTab | undefined {
    const list = visibleTabs()
    const i = list.findIndex((t) => String(t.tabId) === String(tabId))
    if (i < 0 || i + 1 >= list.length) return undefined
    return list[i + 1]
  }

  /**
   * 网格卡片只同步 favicon 底板，不改变卡片自身的选中底色。
   * `active=false` 是刻意的：它让共享取色器只写底板令牌，
   * 同时仍使用该标签选中时应有的前景色（白/深）作为底板。
   */
  function syncFaviconChip(card: HTMLElement, tab: PinGridTab): void {
    const faviconUrl = tab.favicon || ''
    card.dataset.faviconUrl = faviconUrl
    applyFaviconColor(card, faviconUrl, false, () => (
      card.isConnected && card.dataset.faviconUrl === faviconUrl
    ))
  }

  // ── 卡片 ──────────────────────────────────────────────────────────────────
  function buildCard(tab: PinGridTab): HTMLDivElement {
    const card = doc.createElement('div')
    card.className = 'pingrid-card'
    card.draggable = true
    card.setAttribute('data-tab-id', String(tab.tabId))
    if (tab.active) card.classList.add('pingrid-card--active')
    card.title = tab.title || tab.url || ''

    const fav = doc.createElement('div')
    fav.className = 'pingrid-fav'
    fav.appendChild(createFaviconBadge(doc, tab.favicon, tab.title || tab.url, 30, tab.url, { tabChip: true }))
    card.appendChild(fav)

    const title = doc.createElement('div')
    title.className = 'pingrid-title'
    title.setAttribute('data-tab-title', '')
    title.textContent = tab.title || tab.url || ''
    card.appendChild(title)
    syncFaviconChip(card, tab)

    // 正在放音的标签：角上一个可点的静音开关（点击不触发展开）
    if (tab.isPlaying || tab.muted) {
      const audio = doc.createElement('button')
      audio.type = 'button'
      audio.className = 'pingrid-audio'
      audio.title = audioToggleLabel(!!tab.muted)
      audio.setAttribute('aria-label', audio.title)
      const icon = doc.createElement('span')
      icon.textContent = tab.muted ? '\u{1F507}' : '\u{1F50A}'
      icon.style.fontSize = '11px'
      icon.style.lineHeight = '1'
      audio.appendChild(icon)
      audio.addEventListener('click', (e) => {
        e.stopPropagation()
        if (onToggleMute) onToggleMute(tab)
      })
      card.appendChild(audio)
    }

    card.addEventListener('click', () => onActivate(tab))
    if (onContextMenu) {
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        hover.hide()
        onContextMenu(tab, e, nextItemOf(tab.tabId))
      })
    }

    // ── hover 预览（进入卡片 → 交给共用状态机）──
    card.addEventListener('mouseenter', () => hover.enter(card, tab))
    card.addEventListener('mouseleave', () => hover.absent())

    // ── 拖动重排 ──
    card.addEventListener('dragstart', (e) => {
      dragId = String(tab.tabId)
      card.classList.add('pingrid-card--dragging')
      hover.hide()
      try {
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('application/x-ng-pin', dragId)
        }
      } catch (_) {}
    })
    card.addEventListener('dragend', () => {
      dragId = ''
      card.classList.remove('pingrid-card--dragging')
      clearDropHint()
    })
    card.addEventListener('dragover', (e) => {
      if (!dragId || dragId === String(tab.tabId)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const after = edgeOf(card, e)
      if (hintFolder) {
        hintFolder.classList.remove('pingrid-folder--drop')
        hintFolder = null
      }
      if (hintCard !== card) {
        clearDropHint()
        hintCard = card
      }
      card.classList.toggle('pingrid-card--drop-before', !after)
      card.classList.toggle('pingrid-card--drop-after', after)
    })
    card.addEventListener('dragleave', () => {
      if (hintCard === card) clearDropHint()
    })
    card.addEventListener('drop', (e) => {
      if (!dragId || dragId === String(tab.tabId)) return
      e.preventDefault()
      const after = edgeOf(card, e)
      const moved = dragId
      dragId = ''
      clearDropHint()
      if (onReorder) onReorder({ draggedId: moved, targetId: String(tab.tabId), insertAfter: after })
    })

    return card
  }

  /** 就地更新一张卡片（避免整格重建导致 hover 状态与滚动位置丢失）。 */
  function updateCard(card: HTMLElement, tab: PinGridTab): void {
    card.classList.toggle('pingrid-card--active', !!tab.active)
    card.title = tab.title || tab.url || ''
    const titleEl = card.querySelector('.pingrid-title')
    if (titleEl) titleEl.textContent = tab.title || tab.url || ''
    const favWrap = card.querySelector('.pingrid-fav')
    if (favWrap) {
      favWrap.replaceChildren(createFaviconBadge(doc, tab.favicon, tab.title || tab.url, 30, tab.url, { tabChip: true }))
    }
    syncFaviconChip(card, tab)
    const hasAudio = !!card.querySelector('.pingrid-audio')
    const wantAudio = !!(tab.isPlaying || tab.muted)
    if (hasAudio !== wantAudio) {
      // 音频态变了 → 交给下一次整体重画（数量关系会变，局部补删易漏），这里只标脏。
      card.setAttribute('data-audio-dirty', '1')
    }
  }

  // ── 文件夹抬头 ────────────────────────────────────────────────────────────
  function startFolderRename(head: HTMLElement, labelEl: HTMLElement, entry: PinFolderEntry): void {
    if (!onRenameFolder) return
    rename.begin(head, labelEl, entry.label || '', (next) => onRenameFolder(entry.stackId, next))
  }

  function buildFolderHead(entry: PinFolderEntry): HTMLDivElement {
    const head = doc.createElement('div')
    head.className = 'pingrid-folder'
    head.setAttribute('data-stack-id', entry.stackId)
    if (entry.collapsed) head.classList.add('pingrid-folder--collapsed')
    if (entry.accent) head.style.setProperty('--pin-folder-accent', entry.accent)

    const arrow = doc.createElement('span')
    arrow.className = 'pingrid-folder-arrow'
    arrow.appendChild(entry.collapsed ? ChevronRight(doc, { size: 13 }) : ChevronDown(doc, { size: 13 }))

    const icon = doc.createElement('span')
    icon.className = 'pingrid-folder-icon'
    icon.appendChild(Folder(doc, { size: 13 }))

    const label = doc.createElement('span')
    label.className = 'pingrid-folder-label'
    label.textContent = stackDisplayLabel(entry)

    const count = doc.createElement('span')
    count.className = 'pingrid-folder-count'
    count.textContent = String(entry.children.length)

    head.append(arrow, icon, label, count)
    head.title = stackDisplayLabel(entry)

    head.addEventListener('click', () => onToggleFolder(entry.stackId))
    head.addEventListener('dblclick', (e) => {
      e.preventDefault()
      startFolderRename(head, label, entry)
    })
    if (onFolderMenu) {
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        hover.hide()
        onFolderMenu(entry.stackId, e, { beginRename: () => startFolderRename(head, label, entry) })
      })
    }

    // 卡片拖到文件夹抬头 = 移入该文件夹（含从展开的其他文件夹里拖过来）。
    head.addEventListener('dragover', (e) => {
      if (!dragId) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      if (hintCard) {
        hintCard.classList.remove('pingrid-card--drop-before', 'pingrid-card--drop-after')
        hintCard = null
      }
      if (hintFolder !== head) {
        clearDropHint()
        hintFolder = head
      }
      head.classList.add('pingrid-folder--drop')
    })
    head.addEventListener('dragleave', () => {
      if (hintFolder === head) clearDropHint()
    })
    head.addEventListener('drop', (e) => {
      if (!dragId) return
      e.preventDefault()
      const moved = dragId
      dragId = ''
      clearDropHint()
      if (onMoveToFolder) onMoveToFolder(moved, entry.stackId)
    })

    return head
  }

  /** 抬头就地更新（折叠态 / 名称 / 计数 / 配色）。 */
  function updateFolderHead(head: HTMLElement, entry: PinFolderEntry): void {
    const wantCollapsed = !!entry.collapsed
    head.classList.toggle('pingrid-folder--collapsed', wantCollapsed)
    if (entry.accent) head.style.setProperty('--pin-folder-accent', entry.accent)
    else head.style.removeProperty('--pin-folder-accent')
    const labelEl = head.querySelector('.pingrid-folder-label')
    const want = stackDisplayLabel(entry)
    if (labelEl && labelEl.textContent !== want) labelEl.textContent = want
    const countEl = head.querySelector('.pingrid-folder-count')
    if (countEl) countEl.textContent = String(entry.children.length)
    // 箭头只在折叠态真的翻转时重建（折叠态由 dataset 记住，避免每次推送都换 DOM）
    if (head.dataset.collapsedArrow !== (wantCollapsed ? '1' : '0')) {
      const arrow = head.querySelector('.pingrid-folder-arrow')
      if (arrow) {
        arrow.replaceChildren(wantCollapsed ? ChevronRight(doc, { size: 13 }) : ChevronDown(doc, { size: 13 }))
      }
      head.dataset.collapsedArrow = wantCollapsed ? '1' : '0'
    }
    head.title = stackDisplayLabel(entry)
  }

  // ── 规范化与重画 ──────────────────────────────────────────────────────────
  /**
   * 把面板给的混合条目规范化成内部形状。**不丢字段**：未知类型忽略，
   * 文件夹的 `children` 只保留有 tabId 的标签。
   * @param {readonly PinGridInput[]} next
   */
  function normalize(next: readonly PinGridInput[]): PinGridEntry[] {
    const out: PinGridEntry[] = []
    for (const item of Array.isArray(next) ? next : []) {
      if (!item) continue
      if (item.type === 'folder') {
        if (item.stackId == null) continue
        out.push({
          kind: 'folder',
          stackId: String(item.stackId),
          // 网格里的文件夹恒为固定文件夹 → 没名字时用「固定标签」兜底（与组行同一份规则）。
          pinned: true,
          label: typeof item.label === 'string' ? item.label : '',
          accent: typeof item.accent === 'string' ? item.accent : '',
          collapsed: !!item.collapsed,
          children: (Array.isArray(item.children) ? item.children as unknown[] : [])
            .filter((t: unknown): t is PinGridTab =>
              !!t && typeof t === 'object' && (t as PinGridTab).tabId != null
            )
        })
      } else if (item.tabId != null) {
        out.push({ kind: 'tab', tab: item })
      }
    }
    return out
  }

  /** 结构签名：条目顺序 / 身份 / 折叠态 / 成员 / 音频态 —— 变了才整格重建。 */
  function signatureOf(list: readonly PinGridEntry[]): string {
    return list.map((entry) => {
      if (entry.kind === 'folder') {
        return 'f:' + entry.stackId + ':' + (entry.collapsed ? '1' : '0') + ':' +
          entry.children.map((t) => String(t.tabId) + (t.isPlaying || t.muted ? '*' : '')).join(',')
      }
      return 't:' + String(entry.tab.tabId) + (entry.tab.isPlaying || entry.tab.muted ? '*' : '')
    }).join('|')
  }

  /**
   * 有序、增量的重画：
   *   · 数量 / 顺序 / 折叠态 / 音频态变化 → 整格重建（卡片数量一般很小，重建代价可忽略且最不易错）；
   *   · 仅 active / 标题 / 图标 / 文件夹名称与配色变化 → 就地更新（不打断 hover、不丢滚动位置）。
   * @param {readonly PinGridEntry[]} list 规范化后的条目
   */
  function render(list: readonly PinGridEntry[]): void {
    // 空态：整格清空后放一句说明（**幂等** —— 每次推送都重来一遍，不会越叠越多）。
    if (!list.length) {
      hover.invalidate()
      hover.hide()
      clearDropHint()
      grid.replaceChildren()
      nodeByKey.clear()
      root.dataset.signature = ''
      const empty = doc.createElement('div')
      empty.className = 'pingrid-empty'
      empty.textContent = emptyText
      grid.appendChild(empty)
      grid.style.gridTemplateColumns = ''
      return
    }

    const signature = signatureOf(list)
    const structural = signature !== root.dataset.signature

    if (structural) {
      clearDropHint()
      // 整格重建 = 所有卡片节点都被换掉：正在 hover 的那张锚点已经不存在了。
      // 走规则 ⑥（收起 + 锁到指针真的动过）—— 新卡片会落在指针底下并补发
      // mouseenter，不锁的话预览会在"用户没动"的情况下立刻又弹出来。
      hover.invalidate()
      grid.replaceChildren()
      nodeByKey.clear()
      for (const entry of list) {
        if (entry.kind === 'folder') {
          const head = buildFolderHead(entry)
          head.dataset.collapsedArrow = entry.collapsed ? '1' : '0'
          nodeByKey.set('folder:' + entry.stackId, head)
          grid.appendChild(head)
          for (const tab of entry.children) {
            if (entry.collapsed) break
            const card = buildCard(tab)
            nodeByKey.set('tab:' + tab.tabId, card)
            grid.appendChild(card)
          }
        } else {
          const card = buildCard(entry.tab)
          nodeByKey.set('tab:' + entry.tab.tabId, card)
          grid.appendChild(card)
        }
      }
      root.dataset.signature = signature
    } else {
      for (const entry of list) {
        if (entry.kind === 'folder') {
          const head = nodeByKey.get('folder:' + entry.stackId)
          if (head) updateFolderHead(head, entry)
          for (const tab of entry.children) {
            const card = nodeByKey.get('tab:' + tab.tabId)
            if (card) updateCard(card, tab)
          }
        } else {
          const card = nodeByKey.get('tab:' + entry.tab.tabId)
          if (card) updateCard(card, entry.tab)
        }
      }
    }

    applyColumns()
  }

  function applyColumns() {
    const tabs = visibleTabs()
    const cols = computePinColumns(root.clientWidth || scroll.clientWidth, tabs.length)
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
  }

  // 容器宽度变化 → 重排列数（节流到每帧一次）。
  let columnsFrame = 0
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (columnsFrame) return
        columnsFrame = requestAnimationFrame(() => {
          columnsFrame = 0
          if (entries.length) applyColumns()
        })
      })
    : null
  if (ro) ro.observe(root)

  return {
    element: root,
    setItems(next: readonly PinGridInput[]) {
      entries = normalize(next)
      render(entries)
    },
    /**
     * 让某个文件夹抬头进入行内改名（新建文件夹后由面板立刻调用 ——
     * 「先建好再起名」比「弹一个输入框挡住整块面板」更贴近收藏夹的手感）。
     * @param {string} stackId
     * @returns {boolean} 是否真的进入了改名（抬头还没渲染出来时为 false）
     */
    beginRenameFolder(stackId: string) : boolean {
      const id = String(stackId == null ? '' : stackId)
      const head = nodeByKey.get('folder:' + id)
      const entry = entries.find((e): e is PinFolderEntry => e.kind === 'folder' && e.stackId === id)
      if (!head || !entry) return false
      const labelEl = head.querySelector<HTMLElement>('.pingrid-folder-label')
      if (!labelEl) return false
      startFolderRename(head, labelEl, entry)
      return true
    },
    dispose() {
      hover.dispose()
      if (ro) ro.disconnect()
      if (columnsFrame) cancelAnimationFrame(columnsFrame)
      nodeByKey.clear()
      root.remove()
    }
  }
}
