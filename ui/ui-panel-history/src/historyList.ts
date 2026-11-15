// @ts-check
/**
 * 历史记录**行列表**的唯一实现（历史面板 / 聚合总览共用）。
 *
 * 为什么抽出来：同一份「浏览器历史」在历史面板里是主视图，在聚合总览里是
 * 「最近关闭」块。两处的行长得一样、行为也一样（favicon + 标题、点击打开、
 * hover 删除、可拖到集锦/画板/书签栏），复制一份就是两条会各自
 * 漂移的实现。抽成组件后 class 与 DOM 一字不差，`injectHistoryPanelStyles`
 * 一份样式同时管住两处。
 *
 * 只做「列表」：不持 IPC、不搜索 —— 数据由宿主推入（setItems），
 * 用户动作经 onIntent 上行（navigate / remove）。
 *
 * 两种宿主模式由选项统一管理（不是两套代码分支）：
 *   · grouped       —— 是否按日期分组（面板 true，总览摘要 false）
 *   · selectable    —— 多选（全选 / 复选 / Ctrl·⌘ 点击 / 右键）是否可用
 */

import type { PanelContext } from '@hira-ng/ui-common'
import { createFaviconBadge, setDragItem, modifiersFromEvent } from '@hira-ng/ui-common'
import type { BookmarkModifierSnapshot } from '@hira-ng/ui-common'
// 日期分段口径的唯一真源（与归档 / 会话面板共用一份；分组标签也在那里）。
import { DATE_BUCKETS, dateBucketLabel, dateBucketOf } from '@hira-ng/shared-types/src/date-display.mjs'

export interface HistoryListItem {
  id?: string | number
  url?: string
  title?: string
  favicon?: string
  lastVisitAt?: number
  [key: string]: unknown
}

export interface HistoryGroup {
  label: string
  key: string
  items: HistoryListItem[]
}

export interface HistoryListIntent {
  type: 'navigate' | 'remove'
  url?: string
  id?: string
  title?: string
  modifiers?: BookmarkModifierSnapshot
  [key: string]: unknown
}

type HistoryListContext = Omit<PanelContext, 'onIntent'> & {
  onIntent?: (intent: HistoryListIntent) => void
  grouped?: boolean
  selectable?: boolean
  emptyText?: string | (() => string)
  onSelectionChange?: (count: number) => void
  onContextMenu?: (item: HistoryListItem, x: number, y: number) => void
}

/**
 * 将 items 按 lastVisitAt 分组为 [{ label, items }]。
 * 分段边界与标签由 shared-types#date-display.mjs 统一给出（三个面板同一口径）。
 * @param {readonly HistoryListItem[]} items
 * @param {number} [now]
 * @returns {HistoryGroup[]}
 */
export function groupHistoryByDate(items: readonly HistoryListItem[], now: number = Date.now()): HistoryGroup[] {
  const buckets: Record<string, HistoryListItem[]> = { today: [], yesterday: [], week: [], older: [] }

  for (const item of items) {
    const ts = typeof item.lastVisitAt === 'number' ? item.lastVisitAt : 0
    buckets[dateBucketOf(ts, now)].push(item)
  }

  const out: HistoryGroup[] = []
  // DATE_BUCKETS 自带展示顺序，循环顺序 = 用户看到的顺序。
  for (const key of DATE_BUCKETS) {
    if (buckets[key].length) out.push({ key, label: dateBucketLabel(key), items: buckets[key] })
  }
  return out
}

/**
 * 让一行成为**统一拖拽源**（历史 / 最近关闭共用）。
 *
 * 历史是"取用"的入口之一：把一条记录拖进集锦 / 画板 / 书签栏，
 * 就是"这个页面我要留着"的最直接表达。载荷只带 domain + url + title，
 * 落点怎么落地由各自的落点决定（本组件不关心）。
 *
 * @param {HTMLElement} row
 * @param {HistoryListItem} item
 */
export function makeRowDraggable(row: HTMLElement, item: HistoryListItem) {
  if (!item || !item.url) return
  row.draggable = true
  row.addEventListener('dragstart', (e: DragEvent) => {
    const dataTransfer = e.dataTransfer
    if (!dataTransfer) return
    setDragItem(dataTransfer, {
      domain: 'history',
      id: item.id != null ? String(item.id) : item.url,
      kind: 'page',
      url: item.url,
      title: item.title || ''
    }, { effectAllowed: 'copy' })
    row.classList.add('is-dragging')
  })
  row.addEventListener('dragend', () => row.classList.remove('is-dragging'))
}

/**
 * @param {Document} doc
 * @param {{
 *   onIntent?: (intent: HistoryListIntent) => void,
 *   grouped?: boolean,
 *   selectable?: boolean,
 *   emptyText?: string | (() => string),
 *   onSelectionChange?: (count: number) => void,
 *   onContextMenu?: (item: HistoryListItem, x: number, y: number) => void
 * }} [ctx]
 *   `onContextMenu`：宿主提供时，右键**上报这一条**（宿主弹原生菜单，AI 等插件项由
 *   主进程按 `context.kind` 追加）；不提供时保持原行为 —— 右键 = 切换复选
 *   （聚合总览的"最近关闭"摘要就属于这种情形，它没有自己的右键菜单）。
 * @returns {{
 *   element: HTMLElement,
 *   setItems: (items: readonly HistoryListItem[]|null) => void,
 *   toggleSelectAll: () => void,
 *   clearSelection: () => void,
 *   selectedIds: () => string[]
 * }}
 */
export function createHistoryList(doc: Document, ctx: PanelContext = {}) : {
  element: HTMLElement,
  setItems: (items: readonly HistoryListItem[]|null) => void,
  toggleSelectAll: () => void,
  clearSelection: () => void,
  selectedIds: () => string[]
} {
  const listCtx = ctx as HistoryListContext
  const onIntent = typeof listCtx.onIntent === 'function' ? listCtx.onIntent : () => {}
  const onContextMenu = typeof listCtx.onContextMenu === 'function' ? listCtx.onContextMenu : null
  const grouped = listCtx.grouped !== false
  const selectable = listCtx.selectable !== false
  const emptyText = typeof listCtx.emptyText === 'function'
    ? listCtx.emptyText
    : () => (typeof listCtx.emptyText === 'string' ? listCtx.emptyText : '尚无历史记录')

  const list = doc.createElement('div')
  list.className = 'history-panel__list'

  let items: HistoryListItem[] = []
  /** 选中 id 集（按 id 或 url 回退） */
  /** @type {Map<string, string>} */ const selected: Map<string, string> = new Map()
  /** 多选态：仅进入多选时才显示每行复选框（未多选时行首无复选框也无占位）。 */
  let multiSelect = false

  function selectedIds() {
    return Array.from(selected.keys())
  }

  function notifySelection() {
    listCtx.onSelectionChange?.(selected.size)
  }

  /**
   * 切换某一行的选择态 —— **复选框 / Ctrl·⌘ 点击 / 右键 三条入口的唯一实现**。
   *
   * 与收藏面板同一口径：未选中的行 → 勾上；已选中的行 → 取消勾选；选空即退出多选
   * （复选框随之收起）。正因为三条入口都走它，「右键 = 点复选框」才是字面意义上的
   * 同一个动作，而不是另定一套规则再想办法保持同步。
   * @param {string|null} id
   * @param {string|null} url
   */
  function toggleSelection(id: string | null, url: string | null) {
    if (!selectable || !id) return
    multiSelect = true
    if (selected.has(id)) selected.delete(id)
    else selected.set(id, url || '')
    if (selected.size === 0) multiSelect = false
    render()
  }

  /** 全选 / 全不选（面板工具栏「全选」）。 */
  function toggleSelectAll() {
    if (!selectable) return
    const rows = list.querySelectorAll('[data-id]')
    const allSelected = rows.length > 0 && Array.from(rows).every((row) => {
      const rowId = row.getAttribute('data-id')
      return rowId !== null && selected.has(rowId)
    })
    selected.clear()
    if (allSelected) {
      multiSelect = false
    } else {
      rows.forEach((row) => {
        const rowId = row.getAttribute('data-id')
        if (rowId) selected.set(rowId, row.getAttribute('data-url') || '')
      })
      multiSelect = true
    }
    render()
  }

  function clearSelection() {
    selected.clear()
    multiSelect = false
    render()
  }

  function reflowCheckboxes() {
    list.querySelectorAll<HTMLInputElement>('input[type=checkbox].history-panel__check').forEach((checkbox) => {
      checkbox.checked = checkbox.dataset.id ? selected.has(checkbox.dataset.id) : false
    })
  }

  function renderEmpty() {
    list.textContent = ''
    const empty = doc.createElement('div')
    empty.className = 'history-panel__empty'
    empty.textContent = emptyText()
    list.appendChild(empty)
  }

  function renderGroup(group: HistoryGroup) {
    const groupEl = doc.createElement('div')
    groupEl.className = 'history-panel__group'
    const label = doc.createElement('div')
    label.className = 'history-panel__group-label'
    label.textContent = `${group.label} · ${group.items.length}`
    groupEl.appendChild(label)

    for (const item of group.items) groupEl.appendChild(renderRow(item))
    return groupEl
  }

  /** 单行 DOM（历史面板与聚合总览必须一模一样）。 */
  function renderRow(item: HistoryListItem) {
    const row = doc.createElement('div')
    row.className = 'history-panel__row'
    row.setAttribute('data-row', '')
    const idKey = item.id != null ? String(item.id) : (item.url || '')
    if (item.url) row.setAttribute('data-url', item.url)
    if (item.title) row.setAttribute('data-title', item.title)
    if (idKey) row.setAttribute('data-id', idKey)
    row.title = item.url || ''
    makeRowDraggable(row, item)

    // 复选框仅在多选态显示（未多选时行首无复选框、无占位，直接是图标）
    if (selectable && multiSelect) {
      const check = doc.createElement('input')
      check.type = 'checkbox'
      check.className = 'history-panel__check'
      check.setAttribute('data-id', idKey)
      check.setAttribute('data-url', item.url || '')
      check.checked = selected.has(idKey)
      row.appendChild(check)
    }

    // 行首页面图标：favicon 失败降级首字母徽标。
    // 第 5 参 = 页面地址（缺 favicon 时推导 /favicon.ico）——
    // 规则真源 shared-types/src/favicon-src.mjs，与 hira://history 页共用。
    row.appendChild(createFaviconBadge(doc, item.favicon || null, item.title || item.url || '', 16, item.url || null))

    const main = doc.createElement('button')
    main.type = 'button'
    main.className = 'history-panel__row-main'
    const title = doc.createElement('span')
    title.className = 'history-panel__row-title'
    title.textContent = item.title || item.url || ''
    main.appendChild(title)
    if (item.url && item.url !== title.textContent) {
      const url = doc.createElement('span')
      url.className = 'history-panel__row-url'
      url.textContent = item.url
      main.appendChild(url)
    }
    row.appendChild(main)

    const del = doc.createElement('button')
    del.className = 'history-panel__btn'
    del.textContent = '✕'
    del.title = '删除这条记录'
    del.setAttribute('data-action', 'remove')
    row.appendChild(del)

    return row
  }

  /** 渲染。分组模式下每组一个块；平铺模式（总览摘要）只出行。 */
  function render() {
    if (!items || items.length === 0) {
      renderEmpty()
      notifySelection()
      return
    }
    const frag = doc.createDocumentFragment()
    if (grouped) {
      const groups = groupHistoryByDate(items)
      for (const g of groups) frag.appendChild(renderGroup(g))
    } else {
      for (const item of items) frag.appendChild(renderRow(item))
    }
    list.textContent = ''
    list.appendChild(frag)
    reflowCheckboxes()
    notifySelection()
  }

  // ── 事件委托（整块列表一份）──
  list.addEventListener('click', (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const check = target?.closest<HTMLElement>('.history-panel__check[data-id]')
    if (check) {
      e.stopPropagation()
      // 复选框走的是与「Ctrl/⌘ 点击」「右键」**同一个**切换动作 —— 三条入口一份实现，
      // 不再各写一段（勾选态由选中集推导，不读 .checked，免得与重画差一拍）。
      toggleSelection(check.getAttribute('data-id'), check.getAttribute('data-url'))
      return
    }
    const row = target?.closest<HTMLElement>('[data-row]')
    if (!row) return
    const btn = target?.closest<HTMLElement>('[data-action]')
    if (btn) {
      e.stopPropagation()
      const action = btn.getAttribute('data-action')
      const id = row.getAttribute('data-id') || ''
      const url = row.getAttribute('data-url') || ''
      if (action === 'remove') {
        selected.delete(id)
        if (selected.size === 0) multiSelect = false
        // 不本地删行：宿主删除成功后会经 setItems 回推真实状态（失败也能回到真相）。
        onIntent({ type: 'remove', id, url })
      }
      return
    }
    const id = row.getAttribute('data-id') || ''
    const url = row.getAttribute('data-url') || ''
    // Ctrl/⌘ 点击（进入多选并反选）与多选态下的普通点击：都是切换选择
    if (selectable && (e.ctrlKey || e.metaKey || multiSelect)) {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
      toggleSelection(id, url)
      return
    }
    if (url) onIntent({
      type: 'navigate',
      url,
      title: row.getAttribute('data-title') || '',
      // 只上报修饰键事实：去向规则由宿主统一决定（面板 Alt = 侧栏，见 panel-open.ts）。
      modifiers: modifiersFromEvent(e)
    })
  })

  /**
   * 行 → 数据项（右键菜单要完整快照：DOM 上只有 id / url / title 三个投影）。
   * 找不到对应数据项时用 DOM 上的三字段兜底 —— 菜单仍可用，不会因为一次重画丢引用而哑掉。
   * @param {HTMLElement} row
   */
  function itemOfRow(row: HTMLElement): HistoryListItem {
    const idKey = row.getAttribute('data-id') || ''
    const found = items.find((item) => String(item.id != null ? item.id : item.url) === idKey)
    if (found) return found
    return {
      id: idKey,
      url: row.getAttribute('data-url') || '',
      title: row.getAttribute('data-title') || ''
    }
  }

  // 右键：宿主提供 `onContextMenu` → 上报**这一条**（原生菜单 + 插件插槽项）；
  // 否则保持原行为 —— 切换复选（与单击复选框、Ctrl/⌘ 点击完全同一个动作）。
  if (selectable) {
    list.addEventListener('contextmenu', (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const row = target?.closest<HTMLElement>('[data-row]')
      if (!row) return
      e.preventDefault()
      if (onContextMenu) {
        const item = itemOfRow(row)
        // 没有 url 的记录本就没有可打开 / 可询问的落点 —— 退回"切复选"，不留空菜单。
        if (item.url) {
          onContextMenu(item, e.clientX, e.clientY)
          return
        }
      }
      toggleSelection(row.getAttribute('data-id') || '', row.getAttribute('data-url') || '')
    })
  }

  function setItems(next: readonly HistoryListItem[] | null) {
    items = Array.isArray(next) ? next.slice() : []
    render()
  }

  return { element: list, setItems, toggleSelectAll, clearSelection, selectedIds }
}
