/**
 * target-picker.js —— 通用「选择目标」浮层内核（apps 层共享件，零业务知识）
 *
 * ── 它解决的问题 ──────────────────────────────────────────────────
 * 「点一个东西，然后在一列可选项里挑一个落点」这件事，此前每个场景各写一遍
 * （书签栏文件夹下拉等），于是"点外部收起""下钻返回""锚点摆位""不抢
 * 拖拽区"这些细节每份都要重写一遍，且必然漂移。
 *
 * 本文件把它抽成**一份内核**：
 *   · 几何 / 观感 / 收起判据 / 下钻栈 —— 全在这里；
 *   · 「有哪些项、点了干什么」—— 全部由**来源（source）**注入。
 *
 * 浮层宿主（`renderer/target-picker-overlay/main.js`）只做接线：
 *
 * ```js
 * const picker = createTargetPicker(document, {
 *   sources: { bookmark: bookmarkSource },
 *   onCommit: (payload) => provider.send('overlay:commit', payload)
 * })
 * ```
 *
 * ── 来源契约（这就是扩展点）─────────────────────────────────────────
 * ```js
 * sources[sourceId] = {
 *   // 静态声明（可选）：与"取数据"无关的元信息，声明在来源上而不是 load 的返回值里 ——
 *   // 于是**预取载荷**（show 自带 items）也能先同步摆出列表，不必等 load 回来才知道截断口径。
 *   emptyText?, limit?, overflowTarget?,
 *   // 宿主随 show 带来的**预取载荷**（业务原始行，例如书签节点）→ 本层 item 数组。
 *   // 可选；缺省 = 原样当 item 用。与 load 的分工：load 返回的已是 item，
 *   // 预取载荷还没经过任何一层的映射 —— 那是**来源**的知识，不是内核的。
 *   mapItems?: (raw: unknown[]) => unknown[],
 *   // 打开某一层：payload 是宿主 show 时的原样载荷（含 levelId / items 等）
 *   load: async ({ id, payload }) => ({ items, emptyText?, limit?, overflowTarget? }),
 *   // 用户点了非下钻项：api.commit(target) / api.close() 由来源决定
 *   onPick: (item, api, event) => void
 * }
 * ```
 *
 * `limit` / `overflowTarget` 是**列表上限**的声明面（截断只有一份实现，在本内核里）：
 *   · `limit`          —— 本层最多摆几项（取值来自 `ui-common#LIST_LIMITS`，不在这里写死数字）；
 *   · `overflowTarget` —— 超上限时末尾那条省略行的去向：`{ label, panelId }`
 *     （`label` 是完整入口的名字，`panelId` 由打开方在外壳里查目录）。
 * 两者都省略 = 本层不设上限。
 *
 * ── 首帧不等数据（预取载荷）──────────────────────────────────────────
 * 宿主在**意图期**（悬停 / 按下）就可能已经取到了内容，随 show 一起放进 `items`。
 * 内核会先同步摆出这份列表并立刻上报 bounds，随后 load 的结果回来时**只在内容真的变了**才重绘 ——
 * 于是"点开文件夹先看到一张空卡片、过一拍才蹦出条目"这一跳被彻底去掉。
 *
 * item 形状（全部可选，除了 label / separator）：
 * ```js
 * { id, label, title, icon:'folder'|'favicon'|'plus'|'none', favicon, url,
 *   drill:true, target:unknown, data:unknown }
 * { separator:true }
 * ```
 *
 * **加一种「选择目标」场景 = 在宿主注册表里加一个 source**，不需要碰内核，
 * 也不需要新开一只浮层（新浮层还要再登记通道 / 焦点 / 模态，见文档 10 的契约表）。
 *
 * ── 与「总览」浮层同构，不重复造第二套观感 ──────────────────────────────
 * 铺满整窗 + 贴锚点卡片 + 点外部/滚轮/Esc 收起 + 不抢键盘焦点；
 * 卡片词汇一律取自 ui-common#injectOverlayCardStyles（.hira-overlay-*），
 * 本文件只补「返回栏 / 图标位 / 空态」这几个独有部件的值。
 */

// **深路径**引用：本文件是浮层 renderer 的启动路径，只该评估真正用到的模块 ——
// 桶文件会把整座 ui 原子层拉进模块图（见 ui-common/src/index.ts 头注）。
import { OverlayCardStyle, injectOverlayCardStyles, dismissOnOutsidePointerDown } from '@hira-ng/ui-common/src/overlayCard'
import { createFaviconBadge } from '@hira-ng/ui-common/src/favicon'
import { createFolderIcon } from '@hira-ng/ui-common/src/folderIcon'
import { splitByLimit, createOverflowRow, injectListOverflowStyles } from '@hira-ng/ui-common/src/listOverflow'

/** 卡片几何（px）—— 浮层宿主共用这一份，不再各写一份。 */
const TARGET_PICKER_CARD = Object.freeze({
  width: 240,
  /** 卡片与锚点下缘的间距。 */
  gap: 6,
  /** 高度上限：几百项的大文件夹不得拉出一整屏高。 */
  maxHeight: 420,
  /** 与窗口各边的安全边距。 */
  edgeMargin: 12
})

const STYLE_ID = 'hira-target-picker-styles'

/**
 * 注入本层独有部件的样式（幂等）。
 * 卡片骨架来自共享样式表 —— 这里只写返回栏 / 图标位 / 空态。
 */
function injectTargetPickerStyles(doc: Document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return
  injectOverlayCardStyles(doc)
  // 省略行（「还有 N 项 · 转到收藏面板」）的共用样式 —— 与权限浮层 / 站点信息浮层同源。
  injectListOverflowStyles(doc)
  const { rowGap, rowRadius, rowTransition, rowHoverBackground, rowFontSize, cardColor, groupColor } = OverlayCardStyle
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #root {
      position: relative;
      /* 整棵子树不吃窗口拖拽区：-webkit-app-region 是 Chromium 按整个窗口合并的命中区，
         下层（书签栏等）声明 drag 时会把浮层部分区域当成标题栏吃掉。 */
      -webkit-app-region: no-drag;
    }
    #root,
    #root * {
      -webkit-app-region: no-drag;
    }
    /* 卡片：铺满整窗视图里的一块 fixed 元素（定位 / 圆角 / 边框 / 底色 / 阴影来自
       .hira-overlay-card）。这里只补结构：定宽 + 纵向 flex（固定头部 + 滚动列表）。 */
    .tp-card {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    /* 下钻后的顶部（返回 + 标题）：固定不滚动 —— 返回是"永远可及"的导航。 */
    .tp-head {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: ${rowGap};
    }
    .tp-back {
      flex: 0 0 auto;
      border: none;
      background: transparent;
      color: ${groupColor};
      cursor: default;
      font: inherit;
      font-size: ${rowFontSize};
      line-height: 1;
      padding: 2px 6px;
      border-radius: ${rowRadius};
      transition: ${rowTransition};
    }
    .tp-back:hover {
      background: ${rowHoverBackground};
      color: ${cardColor};
    }
    .tp-list {
      flex: 1 1 auto;
      min-height: 0;
    }
    .tp-ico {
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .tp-folder-ico {
      color: ${groupColor};
    }
    .tp-empty {
      padding: 10px 8px;
      color: ${groupColor};
      font-size: ${rowFontSize};
    }
  `
  doc.head.appendChild(style)
}

/** 默认图标绘制器（宿主可整体替换，用于注入自己的图标语言）。 */
const defaultRenderIcon = (doc: Document, item: TargetPickerItem): Node => {
  if (item.icon === 'folder') return createFolderIcon(doc, { size: 15, className: 'tp-ico tp-folder-ico' })
  if (item.icon === 'favicon') return createFaviconBadge(doc, item.favicon, item.label, 16, item.url)
  if (item.icon === 'plus') {
    const span = doc.createElement('span')
    span.className = 'tp-ico tp-folder-ico'
    span.textContent = '+'
    span.style.fontSize = '14px'
    span.style.lineHeight = '1'
    return span
  }
  const span = doc.createElement('span')
  span.className = 'tp-ico'
  return span
}

export interface TargetPickerItem {
  id?: string
  label?: string
  title?: string
  icon?: string
  favicon?: string
  url?: string
  drill?: boolean
  target?: unknown
  data?: unknown
  separator?: boolean
  [key: string]: unknown
}

interface TargetPickerOverflow {
  hiddenCount: number
  label: string
  panelId: string
}

interface TargetPickerLevel {
  id: string
  title: string
  items: TargetPickerItem[]
  emptyText?: string
  overflow: TargetPickerOverflow | null
}

interface TargetPickerLoadResult {
  items: TargetPickerItem[]
  emptyText?: string
  limit?: number
  overflowTarget?: { label: string; panelId: string }
}

export interface TargetPickerApi {
  commit(target: unknown): void
  close(): void
}

export interface TargetPickerSource {
  emptyText?: string
  limit?: number
  overflowTarget?: { label: string; panelId: string }
  mapItems?(raw: unknown[]): TargetPickerItem[]
  load(args: { id: string; payload: TargetPickerPayload }): Promise<TargetPickerLoadResult>
  onPick?(item: TargetPickerItem, api: TargetPickerApi, event: MouseEvent): void
}

export interface TargetPickerShowRequest {
  source: string
  pickerId?: string
  levelId?: string
  title?: string
  anchor?: TargetPickerAnchor
  viewport?: { width: number; height: number }
  overlay: string
  items?: unknown[]
}

export type TargetPickerPayload = TargetPickerShowRequest & {
  title: string
  viewport: { width: number; height: number }
}

export interface TargetPickerAnchor {
  left?: number
  top?: number
  bottom?: number
  width?: number
  height?: number
  [key: string]: unknown
}

function isTargetPickerItem(value: unknown): value is TargetPickerItem {
  return typeof value === 'object' && value !== null
}

/**
 * 创建选择器内核。
 *
 * @param {Document} doc
 * @param {{
 *   sources: Record<string, {
 *     emptyText?: string,
 *     limit?: number,
 *     overflowTarget?: {label: string, panelId: string},
 *     mapItems?: (raw: unknown[]) => unknown[],
 *     load: (args: {id: string, payload: object}) => Promise<{
 *       items: unknown[], emptyText?: string,
 *       limit?: number, overflowTarget?: {label: string, panelId: string}
 *     }>,
 *     onPick?: (item: unknown, api: object, event: Event) => void
 *   }>,
 *   onCommit: (payload: object) => void,
 *   send?: (route: string, data: object) => void,
 *   overlayName: string,
 *   renderIcon?: (doc: Document, item: unknown) => Node
 * }} options
 */
function createTargetPicker(doc: Document, options: {
  sources: Record<string, TargetPickerSource>,
  onCommit: (payload: Record<string, unknown>) => void,
  send?: (route: string, data: Record<string, unknown>) => void,
  overlayName: string,
  renderIcon?: (doc: Document, item: TargetPickerItem) => Node
}) {
  injectTargetPickerStyles(doc)
  const sources = (options && options.sources) || {}
  const onCommit = options && typeof options.onCommit === 'function' ? options.onCommit : () => {}
  const send = options && typeof options.send === 'function' ? options.send : null
  const overlayName = options && options.overlayName ? String(options.overlayName) : ''
  const renderIcon = options && typeof options.renderIcon === 'function' ? options.renderIcon : defaultRenderIcon

  const root = doc.getElementById('root') || doc.body
  const card = doc.createElement('div')
  card.className = 'hira-overlay-card tp-card'
  card.style.width = `${TARGET_PICKER_CARD.width}px`
  card.style.display = 'none'
  root.appendChild(card)

  const head = doc.createElement('div')
  head.className = 'hira-overlay-group tp-head'
  head.style.display = 'none'
  const backBtn = doc.createElement('button')
  backBtn.className = 'tp-back'
  backBtn.type = 'button'
  backBtn.textContent = '←'
  backBtn.title = '返回上一级'
  const headTitle = doc.createElement('span')
  headTitle.className = 'hira-overlay-label'
  head.append(backBtn, headTitle)

  const sep = doc.createElement('div')
  sep.className = 'hira-overlay-sep'
  sep.style.display = 'none'

  const list = doc.createElement('div')
  list.className = 'hira-overlay-scroll tp-list'
  card.append(head, sep, list)

  /** 当前这一轮的 show 载荷（anchor / viewport / pickerId / source …）。 */
  let payload: TargetPickerPayload | null = null
  let stack: TargetPickerLevel[] = []
  let open = false

  backBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (stack.length > 1) {
      stack.pop()
      render()
    }
  })

  /** 当前 source 的描述符（未注册的来源 = 忽略本次 show，不抛错）。 */
  function sourceDef() {
    return payload && payload.source ? sources[payload.source] || null : null
  }

  function layoutCard() {
    const current = payload
    if (!current) return
    const anchor = current.anchor
    if (!anchor) return
    const vp = current.viewport
    const vw = vp && Number.isFinite(vp.width) ? vp.width : doc.defaultView ? doc.defaultView.innerWidth : 0
    const vh = vp && Number.isFinite(vp.height) ? vp.height : doc.defaultView ? doc.defaultView.innerHeight : 0
    const { width, gap, maxHeight, edgeMargin } = TARGET_PICKER_CARD

    let x = Math.round(Number(anchor.left) || 0)
    if (vw && x + width > vw - edgeMargin) x = Math.max(edgeMargin, Math.round(vw - width - edgeMargin))
    const y = Math.round(Number(anchor.bottom) || Number(anchor.top) || 0) + gap
    card.style.left = `${Math.max(0, x)}px`
    card.style.top = `${y}px`
    const maxH = vh ? Math.max(80, Math.min(maxHeight, vh - y - edgeMargin)) : maxHeight
    card.style.maxHeight = `${maxH}px`
  }

  /** 上报整窗 bounds（本层常驻铺满整窗，显隐与落位都靠它）。 */
  function display() {
    const vp = payload && payload.viewport
    const vw = vp && Number.isFinite(vp.width) ? vp.width : doc.defaultView ? doc.defaultView.innerWidth : 0
    const vh = vp && Number.isFinite(vp.height) ? vp.height : doc.defaultView ? doc.defaultView.innerHeight : 0
    if (!vw || !vh) return
    if (!overlayName || !send) return
    try {
      send(`${overlayName}:display`, { x: 0, y: 0, width: Math.round(vw), height: Math.round(vh), interactive: true })
    } catch (_) {}
  }

  /** 提交：告诉打开方"用户选了什么"，随后本地收起（不等 IPC 往返）。 */
  function commit(target: unknown): void {
    const p = payload
    if (!p) return
    reset()
    try {
      onCommit({ kind: 'target-picker-select', pickerId: p.pickerId, source: p.source, target: target || null })
    } catch (_) {}
  }

  /** 收起：告诉打开方"该收了"（开合真源在宿主，不在这一层）。 */
  function dismiss() {
    const p = payload
    if (!p || !open) return
    reset()
    try {
      onCommit({ kind: 'target-picker-dismiss', pickerId: p.pickerId, source: p.source })
    } catch (_) {}
  }

  /** 清状态与 DOM（不回调）。下一次 show 重新建。 */
  function reset() {
    open = false
    stack = []
    payload = null
    list.textContent = ''
    head.style.display = 'none'
    sep.style.display = 'none'
    card.style.display = 'none'
  }

  /**
   * 当前层末尾那条「还有 N 项 · 转到…」被点下：本层只回传**动作 + 面板 id**，
   * 「那个 id 是哪个面板、展开在哪一侧」由打开方（外壳）裁定 ——
   * 与 select / dismiss 走同一条 overlay:commit 路。
   */
  function activateOverflow(level: TargetPickerLevel): void {
    const p = payload
    if (!p) return
    const panelId = level && level.overflow ? level.overflow.panelId : null
    reset()
    try {
      onCommit({
        kind: 'target-picker-open-panel',
        pickerId: p.pickerId,
        source: p.source,
        panelId: panelId || null
      })
    } catch (_) {}
  }

  const api = {
    commit,
    close: dismiss,
    dismiss,
    /** 由来源主动下钻一层（少见；多数情况用 item.drill 即可）。 */
    drill(id: string, title: string) {
      return loadLevel(id, title, true)
    }
  }

  /**
   * 把「一层的数据 + 来源元信息」合成可渲染的 level。
   *
   * 上限截断**只在这里做一次**：来源只声明 `limit` 与 `overflowTarget`（见文件头来源契约），
   * 切分口径来自 ui-common#splitByLimit —— 每个来源各写一份 slice(0, n) 必然漂移。
   * 元信息的取值顺序：load 返回值 > 来源上的静态声明 —— 后者让预取载荷（没有 load 结果）
   * 也能摆出同样的截断与空态。
   */
  function buildLevel(id: string, title: string, items: TargetPickerItem[], result: TargetPickerLoadResult | null): TargetPickerLevel {
    const src = sourceDef()
    const limit = result && result.limit != null ? result.limit : (src ? src.limit : undefined)
    const overflowTarget = (result && result.overflowTarget) || (src ? src.overflowTarget : undefined)
    const emptyText = (result && result.emptyText) || (src ? src.emptyText : undefined)
    const { shown, hiddenCount } = splitByLimit<TargetPickerItem>(items, Number.isFinite(limit) ? Number(limit) : items.length)
    return {
      id,
      title: title || '',
      items: shown,
      emptyText,
      overflow: hiddenCount > 0 && overflowTarget
        ? { hiddenCount, label: overflowTarget.label, panelId: overflowTarget.panelId }
        : null
    }
  }

  /**
   * 一行的「可见内容」指纹 —— 不含 data / target 这类点击用的载荷（它们不参与绘制）。
   * 判"要不要重绘"必须看**真正画出来的东西**：只比 id 会让"同一批 id、但图标/下钻
   * 标记是空的坏帧"被判定为相同而永久留在屏幕上（这正是此前浮层"有字、没图标、
   * 点了没反应"却一直不自我纠正的原因）。
   */
  function rowKey(item: TargetPickerItem | null | undefined) {
    if (!item) return ''
    if (item.separator) return '\u0001'
    return [
      String(item.id == null ? '' : item.id),
      item.icon || '',
      item.label || '',
      item.url || '',
      item.drill ? '1' : '0',
      item.favicon || ''
    ].join('\u0000')
  }

  /** 两层是否"看起来一样"（同内容指纹序列 + 同空态 + 同省略行）—— 用来跳过预取之后的重绘。 */
  function sameLevel(a: TargetPickerLevel | null, b: TargetPickerLevel | null) {
    if (!a || !b || a.items.length !== b.items.length) return false
    if (a.emptyText !== b.emptyText) return false
    const oa = a.overflow
    const ob = b.overflow
    if (!!oa !== !!ob) return false
    if (oa && (!ob || oa.hiddenCount !== ob.hiddenCount || oa.panelId !== ob.panelId)) return false
    for (let i = 0; i < a.items.length; i++) {
      if (rowKey(a.items[i]) !== rowKey(b.items[i])) return false
    }
    return true
  }

  /**
   * 预取载荷 → item 数组。
   *
   * show 带来的 `items` 是**宿主在意图期取到的业务原始行**（例如书签节点），不是本层的
   * item 形状 —— 映射规则由来源声明（`mapItems`），内核不认识任何业务字段。
   * 来源没声明就原样使用（适用于"宿主本来就按 item 形状预取"的场景）。
   */
  function mapPrefetchItems(raw: unknown): TargetPickerItem[] {
    const list = Array.isArray(raw) ? raw.filter(isTargetPickerItem) : []
    const src = sourceDef()
    if (!src || typeof src.mapItems !== 'function') return list
    try {
      const mapped = src.mapItems(list)
      return Array.isArray(mapped) ? mapped.filter(isTargetPickerItem) : []
    } catch (_) {
      return list
    }
  }

  /** 加载某一层并（可选）入栈。 */
  async function loadLevel(id: string, title: string, push: boolean) {
    const src = sourceDef()
    if (!payload || !src || typeof src.load !== 'function') return
    let result: TargetPickerLoadResult | null = null
    try {
      result = await src.load({ id, payload })
    } catch (_) {
      result = { items: [] }
    }
    if (!open) return // 加载期间被收起 → 丢弃
    const level = buildLevel(id, title, result?.items || [], result)
    if (push) {
      stack.push(level)
      render()
      return
    }
    // 顶层：若这一层正是预取载荷已经摆出来的那一份（内容一致），不再重绘 ——
    // 重绘会把已经出现在屏幕上的卡片再抖一次（滚动位置 / hover 态 / 首帧布局全丢）。
    const current = stack.length === 1 ? stack[0] : null
    if (current && sameLevel(current, level)) return
    stack = [level]
    render()
  }

  function buildRow(item: TargetPickerItem) {
    const row = doc.createElement('button')
    row.className = 'hira-overlay-row'
    row.type = 'button'
    row.title = item.title || (item.icon === 'favicon' ? item.url || '' : item.label || '')
    row.appendChild(renderIcon(doc, item))
    const label = doc.createElement('span')
    label.className = 'hira-overlay-label'
    label.textContent = item.label || item.title || item.url || ''
    row.appendChild(label)
    row.addEventListener('click', (e) => {
      if (item.drill) {
        loadLevel(String(item.id), item.label || '', true)
        return
      }
      const src = sourceDef()
      if (src && typeof src.onPick === 'function') {
        src.onPick(item, api, e)
        return
      }
      if (item.target) api.commit(item.target)
      else api.close()
    })
    return row
  }

  function render() {
    const top = stack[stack.length - 1]
    if (!top) return
    list.textContent = ''
    const items = Array.isArray(top.items) ? top.items : []
    if (!items.length) {
      const empty = doc.createElement('div')
      empty.className = 'tp-empty'
      empty.textContent = top.emptyText || '（空）'
      list.appendChild(empty)
    } else {
      const frag = doc.createDocumentFragment()
      for (const item of items) {
        if (!item) continue
        if (item.separator) {
          const line = doc.createElement('div')
          line.className = 'hira-overlay-sep'
          frag.appendChild(line)
          continue
        }
        frag.appendChild(buildRow(item))
      }
      // 末尾的省略行：本层摆不下的项收成一条「还有 N 项 · 转到…」（上限与文案只此一份）。
      if (top.overflow) {
        frag.appendChild(createOverflowRow(doc, {
          hiddenCount: top.overflow.hiddenCount,
          targetLabel: top.overflow.label,
          onActivate: () => activateOverflow(top)
        }))
      }
      list.appendChild(frag)
    }
    // 顶部标题/返回只在**下钻之后**出现 —— 顶层时触发器本身就是标题。
    const deep = stack.length > 1
    head.style.display = deep ? '' : 'none'
    sep.style.display = deep ? '' : 'none'
    if (deep) headTitle.textContent = top.title || ''
  }

  /**
   * 打开选择器。
   *
   * `items` 是**预取载荷**（宿主在意图期取到的内容，可选）：有它就先同步摆出列表再上报
   * bounds —— 首帧就是有内容的卡片；随后 load 用权威数据核对，内容一致则不再重绘。
   * @param {{source:string, pickerId?:string, levelId?:string, title?:string, anchor?:object,
   *          viewport?:{width:number,height:number}, overlay:string, items?:unknown[]}} req
   */
  function show(req: TargetPickerShowRequest | null | undefined) {
    const p = req
    if (!p?.source || !p.anchor) return false
    if (!sources[p.source]) return false
    // 保留来源带来的全部字段（items 等），只补两个几何/通道缺省 —— 来源的 load 拿到的
    // 就是这份对象，因此"浮层不需要认识的业务数据"也能原样透传给来源。
    payload = {
      ...p,
      title: p.title || '',
      viewport: p.viewport || { width: doc.defaultView ? doc.defaultView.innerWidth : 0, height: doc.defaultView ? doc.defaultView.innerHeight : 0 }
    }
    open = true
    stack = []
    card.style.display = ''
    layoutCard()
    const id = String(p.levelId || '')
    const title = p.title || ''
    if (Array.isArray(p.items)) {
      // 预取命中：先摆内容，再 display —— 卡片一出现就是填好的（不会有一拍空列表）。
      // 预取载荷是业务原始行，必须先经来源的 mapItems 归一成 item（否则没有 icon /
      // data / drill，表现就是"有文字、没图标、点了没反应"）。
      stack = [buildLevel(id, title, mapPrefetchItems(p.items), null)]
      render()
    }
    display()
    loadLevel(id, title, false)
    return true
  }

  /** 主进程确认收起 / 本层自己收起。 */
  function hide() {
    reset()
  }

  /** 数据在打开期间变了（例如书签被别的窗口改动）→ 重取当前层。 */
  function refresh() {
    const top = stack[stack.length - 1]
    if (!top || !open) return
    return loadLevel(top.id, top.title, false)
  }

  function isOpen() {
    return open
  }

  // Esc：本层若拿到键盘焦点就地收起；没焦点时宿主的兜底路径会收（两互补，不重复）。
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) dismiss()
  })

  // 「点（或滚）卡片之外 → 收起」：判据与站点信息 / 权限浮层共用一份。
  dismissOnOutsidePointerDown(doc, {
    isOpen: () => open,
    element: card,
    onDismiss: dismiss,
    wheel: true
  })

  return { show, hide, refresh, isOpen }
}

export { createTargetPicker, injectTargetPickerStyles, TARGET_PICKER_CARD }


