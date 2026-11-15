/**
 * overview-overlay/view —— 「总览」浮层的**外壳视图**（只摆位，不画行）。
 *
 * ── 布局（对齐 Edge 左上角「标签操作菜单」）────────────────────────────
 *   ┌ 空间（最多 2 + 「还有 N 个 · 转到空间面板」）
 *   ├ 搜索（独立区块：自带「搜索」标题 + 发丝线，字段本体在标题下方）
 *   ├ 打开的标签（最多 6 + 「还有 N 项 · 转到标签面板」）
 *   ├ 会话（最多 3 + 「还有 N 项 · 转到会话面板」）
 *   └ 最近关闭（最多 5 + 「还有 N 项 · 转到历史面板」）
 *
 * ── 行不在这里画（用户口径：「学习对应的面板一模一样的样式、功能」）──────
 * 四块的行**直接复用各自面板的行实现**：
 *   · 空间    ← `@hira-ng/ui-panel-profiles#createSpaceRows`（行内改名 + 右键菜单）
 *   · 打开的标签 ← `@hira-ng/ui-common#createTabListHost`（含右键菜单 / 静音 / 音量 / 预览 / 拖拽）
 *   · 最近关闭 ← `@hira-ng/ui-panel-history#createRecentList`（撤销栈行件：favicon / 点击恢复 / 拖拽）
 *   · 会话    ← `@hira-ng/ui-panel-sessions#createSessionRows`（与「会话面板」同一份行件）
 * 本文件只负责「标题 + 宿主元素 + 溢出省略行」的外壳，并按纯层给出的顺序装配。
 * 行件由编排层造好后经 `handlers.hosts` 注入 —— 视图不认识 IPC，也不认识行里的任何细节。
 *
 * ── 两种模式（浏览 / 搜索）──────────────────────────────────────────
 * 不是两套视图：`setModel({ mode, top, bottom, active })` 两种模式走同一条装配路径。
 * 搜索态只作用在纯层划定的作用域上（标签 / 最近关闭 / 会话），结果同样**分组**；
 * 「空间」块两种模式都原样留着（不参与搜索）。
 */

import { overflowRowText, ROW_SEARCH_DEBOUNCE_MS, iconByName } from '@hira-ng/ui-common'
import type { OverviewSection } from '@hira-ng/shared-types/src/overview.mjs'

const STYLE_ID = 'hira-overview-styles'

/** 空态文案（两种模式各一句）。 */
const EMPTY_SEARCH = '没有匹配的标签'
const EMPTY_BROWSE = '没有可显示的内容'

/** 注入面板样式（幂等）。调用方需先注入三块行件的样式与面板基底。 */
export function injectOverviewStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    /* 卡片内边距（唯一一份）：所有行 / 标题 / 输入条一律离卡片边框 6px ——
       否则行悬停底会顶到卡片的圆角、滚动条贴着边，看起来"内容糊在边上"。 */
    .overview-overlay__wrap {
      display: flex; flex-direction: column; height: 100%; min-height: 0;
      box-sizing: border-box; padding: 6px;
    }
    /* 空间块 + 搜索框都是固定兄弟（不参与滚动），只有下面三块滚动 —— 与历史面板同构。
       这样搜索框**不需要也不允许**自己铺底：面板底（#root 那层 --hira-panel-bg）已经是唯一一层，
       子元素再铺同一条半透明色会叠两层（≈更实的色块），换 solid 档则直接是一块实色。 */
    .overview-overlay__above { flex-shrink: 0; }
    .overview-overlay__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 0 8px; }

    .overview-overlay__section { display: flex; flex-direction: column; }
    .overview-overlay__section[hidden] { display: none; }
    /* 分组标题：只用留白 + 弱色分层，不再画横向发丝线（无框语汇）。
       区块之间的空气是**这一条**给的 —— 上下各一档，不再靠行内挤。 */
    .overview-overlay__section-title {
      display: flex; align-items: center; gap: 8px;
      padding: var(--hira-section-gap-top, 16px) 10px var(--hira-section-gap-bottom, 8px);
      font-size: 11px; font-weight: 500;
      letter-spacing: 0.02em; color: var(--hira-text-tertiary, #8a8f98);
      text-transform: none;
    }
    /* 第一个区块贴着内容区顶端，不再多顶一档（避免标题下出现一段空荡）。 */
    .overview-overlay__above > .overview-overlay__section:first-child > .overview-overlay__section-title,
    .overview-overlay__below > .overview-overlay__section:first-child > .overview-overlay__section-title {
      padding-top: 4px;
    }
    .overview-overlay__section-label { order: 0; white-space: nowrap; }
    /* 块头动作按钮（刷新 / 保存当前…）：次级小按钮（软底、无描边），hover 才显底。
       文案与是否出现全部由纯层 descriptor 给（section.action / actionLabel）——
       视图里不再出现「只有最近关闭有刷新」这类 kind 硬编码。 */
    .overview-overlay__section-action {
      order: 2; flex-shrink: 0;
      height: 30px; padding: 0 10px;
      display: inline-flex; align-items: center;
      border-radius: var(--hira-radius-xs, 6px);
      border: 0;
      background: transparent;
      font: inherit; font-size: 11.5px; line-height: 1; font-weight: 500;
      color: var(--hira-text-tertiary, #8a8f98);
      cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .overview-overlay__section-action:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
      color: var(--hira-text-primary, #1a1a1a);
    }
    .overview-overlay__section-action[hidden] { display: none; }
    /* ── 「轻文字出口」的唯一一份词汇：块头「转到 xxx 面板」小字 + 溢出省略行 ──
       两者说的是同一件事（去对应面板），字号 / 字重 / 常态色 / hover 必须同源：
       改这里两处一起变；hover 统一变成**主题色字**（用户口径：超出时的样式与块头小字统一）。 */
    .overview-overlay__section-go,
    .overview-overlay__overflow {
      font: inherit; font-size: 11px; font-weight: 500;
      color: var(--hira-text-tertiary, #8a8f98);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .overview-overlay__section-go:hover,
    .overview-overlay__overflow:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.06));
      color: var(--hira-accent, #3b82f6);
    }
    /* 块头小字（descriptor 的 headerTarget）：与标题同行、紧贴标题右侧。
       只在**没有溢出**时出现 —— 有溢出时省略行已经在说「还有 N 项 · 转到 xxx 面板」，
       同一句话绝不出现两次（用户口径：有超出时别重复，按原位置）。 */
    .overview-overlay__section-go {
      order: 1; flex-shrink: 0;
      height: 22px; padding: 0 6px; margin-left: -2px;
      display: inline-flex; align-items: center;
      border: 0; border-radius: var(--hira-radius-xs, 6px);
      background: transparent;
      line-height: 1; white-space: nowrap; cursor: pointer;
    }
    .overview-overlay__section-go[hidden] { display: none; }

    /* ── 行宿主的容器：把三块行件各自的「撑满高度 / 自己滚动」交还给外层 ──
       行件在各自面板里就是整屏（.tabrow-wrap 有 min-height:100%、.history-panel__list
       有 flex:1 + overflow），直接塞进总览会把最近关闭挤到折叠线下、或长出第二条滚动条。 */
    .overview-overlay__host { display: block; min-width: 0; }
    .overview-overlay__host .tabrow-wrap { min-height: 0; }
    .overview-overlay__host .spaces-panel__list { overflow: visible; }
    .overview-overlay__host .history-panel__list { flex: none; min-height: 0; overflow: visible; }
    /* 会话列表在会话面板里是 flex:1 的自滚动区；塞进总览同样要交还高度与滚动。 */
    .overview-overlay__host .sessions-panel__list { flex: none; min-height: 0; overflow: visible; }
    .overview-overlay__host .tabrow-empty,
    .overview-overlay__host .history-panel__empty,
    .overview-overlay__host .sessions-panel__empty { padding: 16px; }

    /* ── 溢出省略行（措辞来自 ui-common#overflowRowText）──
       文字词汇（字号 / 字重 / 色 / hover）在上一份共享规则里，这里只管"它是一整行"的布局：
       内距与圆角跟上面的标签行同一档（它紧挨着标签行，厚一格就会显得突兀）。 */
    .overview-overlay__overflow {
      display: block; width: calc(100% - 8px); box-sizing: border-box;
      margin: 2px 4px; padding: 6px 10px;
      border: none;
      border-radius: var(--ng-tab-radius, 9px);
      background: transparent;
      line-height: 16px; text-align: left; cursor: pointer;
    }
    .overview-overlay__overflow[hidden] { display: none; }

    /* ── 搜索区：**独立区块**（与「空间」「打开的标签」「最近关闭」同构）──
       标题只做弱色引导，字段本体是软底无描边的输入条。 */
    .overview-overlay__searchbar { flex-shrink: 0; }
    .overview-overlay__search-body { padding: 0 10px 12px; }
    .overview-overlay__search {
      display: flex; align-items: center; gap: 8px;
      box-sizing: border-box;
      height: var(--hira-control-height, 32px);
      padding: 0 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .overview-overlay__search:focus-within {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.06));
      box-shadow: var(--hira-focus-ring);
    }
    .overview-overlay__search-icon { color: var(--hira-text-tertiary, #8a8f98); font-size: 12px; flex-shrink: 0; }
    .overview-overlay__search input {
      flex: 1; min-width: 0; border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a); font: inherit; font-size: 12px; padding: 0;
    }
    .overview-overlay__search input::placeholder { color: var(--hira-text-tertiary, #8a8f98); }

    .overview-overlay__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #8a8f98); font-size: 12px; line-height: 19px;
    }
    .overview-overlay__empty[hidden] { display: none; }
  `
  doc.head.appendChild(style)
}

/** 小工具：造一个带类名的元素。 */
function el<T extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: T,
  className?: string
): HTMLElementTagNameMap[T] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  return node
}

/**
 * @param {Document} doc
 * @param {{
 *   onIntent?: (intent: {type: string, [k: string]: unknown}) => void,
 *   hosts?: Record<string, { element: HTMLElement, setItems: (items: unknown[], active?: object) => void }>
 * }} [handlers]
 * @returns {{ element: HTMLElement, setModel: (model: object) => void, focusSearch: () => boolean }}
 */
export interface OverviewHost {
  element: HTMLElement
  setItems(items: unknown[], active?: { spaceId?: string; profileId?: string }): void
}

interface OverviewHandlers {
  onIntent?(intent: { type: string; [key: string]: unknown }): void
  hosts?: Record<string, OverviewHost>
}

export interface OverviewModel {
  mode: 'browse' | 'search'
  top: OverviewSection[]
  bottom: OverviewSection[]
  query?: string
  active?: { spaceId?: string; profileId?: string }
}

export function createOverviewView(doc: Document, handlers: OverviewHandlers = {}) {
  const onIntent = handlers.onIntent || (() => {})
  const hosts = handlers.hosts || {}

  const wrap = el(doc, 'div', 'overview-overlay__wrap')
  const scroll = el(doc, 'div', 'overview-overlay__scroll')
  const aboveEl = el(doc, 'div', 'overview-overlay__above')

  // 搜索区：独立区块（与三块同构）—— 自带「搜索」标题 + 发丝线，字段本体在标题下方。
  // 因此它与「空间」块之间是与其他区块完全一致的分隔语汇，而不是整块 border 划线。
  const searchbar = el(doc, 'div', 'overview-overlay__section overview-overlay__searchbar')
  const searchTitle = el(doc, 'div', 'overview-overlay__section-title')
  const searchLabel = el(doc, 'span', 'overview-overlay__section-label')
  searchLabel.textContent = '搜索'
  searchTitle.appendChild(searchLabel)
  const searchBody = el(doc, 'div', 'overview-overlay__search-body')
  const searchBox = el(doc, 'div', 'overview-overlay__search')
  const searchIcon = el(doc, 'span', 'overview-overlay__search-icon')
  const searchGlyph = iconByName('Search', doc, { size: 15 })
  if (searchGlyph) searchIcon.appendChild(searchGlyph)
  const searchInput = doc.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '搜索打开的标签与最近关闭…'
  searchInput.setAttribute('aria-label', '搜索标签')
  searchInput.spellcheck = false
  searchBox.append(searchIcon, searchInput)
  searchBody.appendChild(searchBox)
  searchbar.append(searchTitle, searchBody)

  const belowEl = el(doc, 'div', 'overview-overlay__below')
  const emptyEl = el(doc, 'div', 'overview-overlay__empty')
  emptyEl.hidden = true
  scroll.append(belowEl, emptyEl)
  wrap.append(aboveEl, searchbar, scroll)

  /** 当前模型（唯一一份状态）：`{ mode, top, bottom, active }`。 */
  let model: OverviewModel = { mode: 'browse', top: [], bottom: [], active: {} }

  /**
   * kind → 外壳（标题 + 宿主 + 溢出按钮）。**每种 kind 只造一次**，跨渲染复用：
   * 行件是有状态组件（改名输入框、拖拽、hover），每次重画都换节点会把它们拆掉。
   * @type {Map<string, { box: HTMLElement, title: HTMLElement, label: HTMLElement, go: HTMLElement, action: HTMLElement, host: unknown, overflow: HTMLElement }>}
   */
  interface OverviewBox {
    box: HTMLElement
    title: HTMLElement
    label: HTMLElement
    go: HTMLButtonElement
    action: HTMLButtonElement
    host: OverviewHost
    overflow: HTMLButtonElement
    sig: string
  }

  const boxes = new Map<string, OverviewBox>()

  function ensureBox(kind: string): OverviewBox | null {
    const existing = boxes.get(kind)
    if (existing) return existing
    const host = hosts[kind]
    if (!host || !host.element) return null

    const box = el(doc, 'div', 'overview-overlay__section')
    box.dataset.kind = kind
    const title = el(doc, 'div', 'overview-overlay__section-title')
    // 标题文字单独一个 span：layout() 只会改它的 textContent，
    // 不会顺手抹掉同一行里的动作 / 溢出按钮。
    const label = el(doc, 'span', 'overview-overlay__section-label')
    // 块头动作按钮：**通用槽位**（刷新 / 保存当前…）。显示什么由纯层的 section.action /
    // actionLabel 决定，点击原样上行 `{ type:'section-action', kind, action }`。
    const action = el(doc, 'button', 'overview-overlay__section-action')
    action.type = 'button'
    action.hidden = true
    action.addEventListener('click', () => {
      const name = action.dataset.action
      if (name) onIntent({ type: 'section-action', kind, action: name })
    })
    // 块头「转到 xxx 面板」小字：无溢出时的常驻出口（要不要给由纯层 headerTarget 决定）。
    const go = el(doc, 'button', 'overview-overlay__section-go')
    go.type = 'button'
    go.hidden = true
    go.addEventListener('click', () => {
      const panel = go.dataset.panel
      if (panel) onIntent({ type: 'go', panel })
    })
    title.append(label, go, action)
    const hostEl = el(doc, 'div', 'overview-overlay__host')
    hostEl.appendChild(host.element)
    const overflow = el(doc, 'button', 'overview-overlay__overflow')
    overflow.type = 'button'
    overflow.hidden = true
    overflow.addEventListener('click', () => {
      const panel = overflow.dataset.panel
      if (panel) onIntent({ type: 'go', panel })
    })
    box.append(title, hostEl, overflow)

    const entry: OverviewBox = { box, title, label, go, action, host, overflow, sig: '' }
    boxes.set(kind, entry)
    return entry
  }

  /**
   * 一份块的轻量签名：块没变就跳过 `setItems`。
   * 搜索是**逐键**触发渲染的；空间块没有增量复用（整表重建），
   * 不跳过的话每敲一个字都会把（可能正在改名的）行拆掉重造。
   */
  function sectionSig(section: OverviewSection): string {
    const items = section.items || []
    let sig = section.kind + '\u0001' + section.title + '\u0001' + section.hiddenCount +
      '\u0001' + (model.active ? model.active.spaceId + '/' + model.active.profileId : '')
    for (const item of items) {
      sig += '\u0002' + (item && [
        item.tabId ?? item.stackId ?? item.id ?? item.restoreIndex ?? '',
        item.stackId ?? '',
        // 组行用 label（改名 / 折叠 / 配色都会改这几项），标签行用 title。
        item.title ?? item.name ?? item.label ?? '',
        item.url ?? '',
        item.profileId ?? '',
        item.favicon ?? '',
        item.accent ?? '',
        item.collapsed ? 1 : 0,
        item.muted ? 1 : 0,
        item.active ? 1 : 0
      ].join('\u0003'))
    }
    return sig
  }

  /** 按纯层给的顺序装配一个区域（搜索框上 / 下之一）。 */
  function layout(container: HTMLElement, sections: readonly OverviewSection[]): void {
    for (const section of sections) {
      const entry = ensureBox(section.kind)
      if (!entry) continue
      const sig = sectionSig(section)
      if (sig !== entry.sig) {
        entry.sig = sig
        entry.label.textContent = section.title
        // 行件的状态上行：三块接口统一成 setItems(items, active)；
        // spaces 的包装在编排层完成（它需要 active 才能标出当前空间）。
        entry.host.setItems(section.items, model.active)
      }
      entry.box.hidden = false
      // 块头动作（descriptor 驱动）：recent → 刷新；sessions → 保存当前；
      // 空串 = 这一块没有动作，按钮不出现。每次 layout 都刷新，避免模式切换后残留。
      const actionName = section.action || ''
      entry.action.hidden = !actionName
      if (actionName) {
        entry.action.dataset.action = actionName
        entry.action.textContent = section.actionLabel || ''
        entry.action.title = section.actionLabel || ''
      }
      if (section.hiddenCount > 0) {
        entry.overflow.hidden = false
        entry.overflow.dataset.panel = section.targetPanel
        entry.overflow.textContent = overflowRowText(section.hiddenCount, section.targetLabel)
      } else {
        entry.overflow.hidden = true
      }
      // 没溢出 → 块头小字给出口（「转到 xxx 面板」）；有溢出 → 省略行已经在说同一句话，
      // 这里必须收起来，不能两处重复（用户口径）。
      const showGo = section.headerTarget === true && section.hiddenCount === 0
      entry.go.hidden = !showGo
      if (showGo) {
        entry.go.dataset.panel = section.targetPanel
        entry.go.textContent = `转到${section.targetLabel}`
        entry.go.title = `在${section.targetLabel}中查看全部`
      }
      // 换区域 / 换顺序 = 移动同一个节点（不重造，行件状态得以保留）。
      container.appendChild(entry.box)
    }
  }

  /**
   * 搜索框的输入上行：去抖窗口与行列表的搜索框**同一档**（`ROW_SEARCH_DEBOUNCE_MS`）。
   * 逐键上抛会让下面两块每一拍重推一次过滤结果 —— 行进出场动效再各播一轮，
   * 观感就是"整张列表在抖"，这正是当初总览被迫关掉行动效的原因。
   */
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  function emitSearch() {
    searchTimer = null
    onIntent({ type: 'search', query: searchInput.value })
  }
  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(emitSearch, ROW_SEARCH_DEBOUNCE_MS)
  })
  searchInput.addEventListener('keydown', (e) => {
    // Escape 清空是**即时**动作（不排队）：用户按下去就要看到完整列表回来。
    if (e.key !== 'Escape' || !searchInput.value) return
    e.preventDefault()
    searchInput.value = ''
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
    onIntent({ type: 'search', query: '' })
  })

  /**
   * 状态上行：写入一个完整的模型（纯层 `buildOverview()` 的输出 + 活动标记）。
   * @param {{ mode?: string, top?: object[], bottom?: object[], active?: object }} next
   */
  function setModel(next: OverviewModel): void {
    model = {
      mode: (next && next.mode) || 'browse',
      top: (next && next.top) || [],
      bottom: (next && next.bottom) || [],
      active: (next && next.active) || {}
    }
    const visible = new Set([...model.top, ...model.bottom].map((s) => s.kind))
    // 不在本次模型里的块先藏起来（块节点留在 map 里，下次直接复用）。
    for (const [kind, entry] of boxes) entry.box.hidden = !visible.has(kind)

    layout(aboveEl, model.top)
    layout(belowEl, model.bottom)

    const empty = model.top.length === 0 && model.bottom.length === 0
    emptyEl.hidden = !empty
    if (empty) emptyEl.textContent = model.mode === 'search' ? EMPTY_SEARCH : EMPTY_BROWSE
  }

  /** 打开面板即聚焦它（宿主的泛化判据：mount 结果暴露 focusSearch 就调）。 */
  function focusSearch() {
    try {
      searchInput.focus()
      searchInput.select()
    } catch (_) {
      return false
    }
    return true
  }

  return { element: wrap, setModel, focusSearch }
}


