// @ts-check
/**
 * @hira-ng/ui-panel-downloads —— 下载侧边面板（增强版）
 *
 * 哑组件：状态上行 setItems() / updateProgress() / 意图下行 onIntent。
 * 能力：
 *   - 状态筛选 tab（全部 / 进行中 / 已完成）
 *   - 每行实时进度条 + 百分比 + 速度 + 剩余时间（由 updateProgress 原地刷新，无重排闪烁）
 *   - 已完成项 → 行内「打开 / 打开文件夹」按钮（**独占一行**，不挤标题行）
 *   - 终态项 → 行内「删除记录」图标按钮（垃圾桶；只移除记录，不动已下载的文件）
 *   - 右键 → onIntent({ type:'menu', item, x, y })，由编排层弹原生菜单
 *   - 工具栏：全选 / 删除所选 / 清理已完成 / 复制链接
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import {
  injectPanelStyles,
  createFileIcon,
  setDragItem,
  Check,
  Trash2,
  Eraser,
  Copy,
  ExternalLink,
  Folder
} from '@hira-ng/ui-common'
// 真实文件图标的取数器（缓存 + 并发合并）——与内部页下载页用的是同一份实现：
// 页面喂 rpc、面板喂 bridge.invoke，规则只有一套。
import { createFileIconLoader } from '@hira-ng/shared-types/src/file-icon.mjs'
// 「收进集锦」的原生子菜单：描述符真源 + 动作串解码 + 落库编排，全部来自这一处。
import {
  buildCollectionMenuEntries,
  toActionMenuItems,
  collectionTargetFromAction,
  captureToCollectionTarget
} from '@hira-ng/shared-types/src/collection-menu.mjs'
import type { CollectionNotesPort } from '@hira-ng/shared-types/src/collection-menu.mjs'
// 「快照 + 实时进度」的合并口径只有一份（与底部下载条 / 内部下载页共用）。
import {
  resolveDownloadView,
  isActiveDownloadState,
  isLiveDownloadState,
  downloadStateText
} from '@hira-ng/shared-types/src/download-view.mjs'
import type { DownloadView } from '@hira-ng/shared-types/src/download-view.mjs'
import type { MenuItem, MenuPopPayload, PanelSlotsPort } from '@hira-ng/ui-common'
// 单位阶梯只保留一份（B→TB 的档位名称与递进），取整口径各自不同、见下方注释。
import { BYTE_UNITS } from '@hira-ng/shared-types/src/format-size.mjs'
// 「算不算普通网页」的唯一判据（决定下载项的源地址能否收进集锦）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
// 「收进集锦」走**原生右键菜单的子菜单**（与页面右键 / 标签右键同一个形状）：
// 描述符只从共享真源 `shared-types/src/collection-menu.mjs` 取，顺序与文案不在这里另排。

const STYLE_ID = 'hira-panel-downloads-styles'

type CollectionTarget = { kind: 'reading' | 'unfiled' | 'folder' | 'new'; folderId?: string | null }

interface DownloadItem {
  id: string | number
  filename?: string
  url?: string
  filePath?: string
  state?: string
  totalBytes?: number | null
  receivedBytes?: number | null
  danger?: string | null
  multiThreaded?: number | boolean | null
  connections?: number | null
  [key: string]: unknown
}

interface DownloadProgress {
  id: string | number
  receivedBytes?: number | null
  totalBytes?: number | null
  state?: string
  speed?: number
  eta?: number
}

interface DownloadRowRefs {
  item: DownloadItem
  row: HTMLElement
  state: string
  size: HTMLElement
  pct: HTMLElement
  speed: HTMLElement
  eta: HTMLElement
  bar: HTMLElement
  barInner: HTMLElement
}

interface DownloadIntent {
  type?: string
  id?: string
  filePath?: string
  ids?: string[]
  item?: DownloadItem
  x?: number
  y?: number
}

interface DownloadPanelResult {
  element: HTMLDivElement
  setItems: (items: readonly DownloadItem[]) => void
  updateProgress: (progress: DownloadProgress) => boolean
  hasActive: () => boolean
}

type IconFactory = (doc: Document, opts?: { size?: number }) => Element
type UiIconFactory = (name: string, size?: number) => Element | null

interface ActionButtonOptions {
  iconFn?: IconFactory
  icon?: string
  iconSize?: number
  title?: string
  label?: string
}

interface NotesPort extends CollectionNotesPort { folders(): Promise<Array<{ id?: string; name?: string }>> }

interface MenuClientPort {
  popupMenu(payload: MenuPopPayload): Promise<string | null>
}

interface DownloadBridge {
  provider: { invoke(route: string, payload?: unknown): Promise<unknown> }
}

type DownloadPanelContext = Omit<PanelContext, 'clients' | 'bridge' | 'menu' | 'events' | 'on' | 'icons' | 'isFeatureAvailable'> & {
  clients?: {
    notes?: NotesPort
    [key: string]: unknown
  } | null
  bridge?: DownloadBridge
  menu?: MenuClientPort | null
  events?: Record<string, string>
  on?: (route: string, listener: (payload: unknown) => void) => (() => void) | void
  icons?: { ui?: UiIconFactory }
  slots?: PanelSlotsPort
  loadFileIcon?: (filePath: string, size: number) => Promise<string | null>
  confirm?: PanelContext['confirm']
  isFeatureAvailable?: (featureId: string) => boolean
}

/**
 * 体积文本（下载**面板**紧凑口径）：≥100 的量级取整（`412 MB` 而非 `412.3 MB`），
 * 非法输入给占位符「—」，单位档到 TB。
 * 与共享真源 `format-size.mjs` 的两个函数是**不同展示语境的不同口径**
 * （任务管理器逐位 / 下载条精确到两位），不是重复实现，不要互相替换。
 */
function formatBytes(value: unknown) {
  const n = Number(value)
  if (!n || n <= 0) return '—'
  const units = BYTE_UNITS
  let v = n; let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function formatSpeed(value: unknown) {
  const bps = Number(value)
  if (!bps || bps <= 0) return ''
  return `${formatBytes(bps)}/s`
}

function formatETA(value: unknown) {
  const sec = Number(value)
  if (!sec || sec <= 0 || !isFinite(sec)) return ''
  if (sec < 60) return `剩余 ${Math.round(sec)}s`
  if (sec < 3600) return `剩余 ${Math.floor(sec / 60)}m`
  return `剩余 ${Math.floor(sec / 3600)}h`
}

export function injectDownloadsPanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .downloads-panel__wrap { display: flex; flex-direction: column; height: 100%; gap: 10px; }
    .downloads-panel__filters { display: flex; gap: 4px; flex-wrap: wrap; }
    /* 筛选：无描边 chip，选中 = accent 软底。行内不再出现"一圈框套一个胶囊"。 */
    .downloads-panel__filter {
      border: 0; background: transparent;
      border-radius: var(--hira-radius-xs, 6px); height: 28px; padding: 0 11px; font-size: 11px; font-weight: 500;
      cursor: pointer; color: var(--hira-text-secondary, #6b7280);
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .downloads-panel__filter:hover { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.04)); }
    .downloads-panel__filter--active,
    .downloads-panel__filter--active:hover {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
      color: var(--hira-accent, #3b82f6);
    }
    .downloads-panel__toolbar { display: flex; gap: 2px; flex-wrap: wrap; }
    .downloads-panel__toolbar button {
      border: 0; background: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: var(--hira-radius-sm, 8px);
      width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px); padding: 0;
      cursor: pointer; color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .downloads-panel__toolbar button:hover:not(:disabled) { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.04)); }
    .downloads-panel__toolbar button:disabled { opacity: 0.4; cursor: default; }
    /* ⚠ min-height: 0 是滚动的前提：flex column 的子项默认 min-height: auto
       （= 内容高度），窗口一矮时它按内容撑开而不产生滚动 —— 外层 #root 是
       overflow: hidden，于是内容被裁掉、滚轮也无效。 */
    .downloads-panel__list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 0 0 8px; }
    /* 下载项是一行内容，不是一张卡：去掉描边与卡片底，
       层级交给 hover 软底 —— 长列表因此安静下来，眼睛只落在文件名与进度上。 */
    .downloads-panel__row {
      display: flex; flex-direction: column; gap: 6px; padding: 10px;
      border: 0;
      border-radius: var(--hira-radius-md, 10px);
      background: transparent;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      contain: layout style; cursor: context-menu;
    }
    .downloads-panel__row:hover { background: var(--hira-panel-card-hover, rgba(0,0,0,0.035)); }
    .downloads-panel__row.is-dragging { opacity: 0.45; }
    .downloads-panel__row__head { display: flex; align-items: center; gap: 10px; }
    .downloads-panel__check { margin: 0; flex-shrink: 0; cursor: pointer; }
    .downloads-panel__label {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; font-weight: 500; line-height: 18px; color: var(--hira-text-primary, #1a1a1a);
    }
    .downloads-panel__state { font-size: 11px; color: var(--hira-text-tertiary, #9ca3af); flex-shrink: 0; }
    /* 插件画的状态角标（download.state-badge-renderer）：宿主只保证它「在这一格里排得下」，
       外观（颜色/圆角/内边距）归插件 —— 加一条 padding 规则就等于替插件定了长相。 */
    .downloads-panel__state-badge { display: inline-flex; align-items: center; gap: 3px; }
    .downloads-panel__meta { display: flex; gap: 12px; padding-left: 26px; font-size: 11px; line-height: 15px; color: var(--hira-text-tertiary, #9ca3af); font-variant-numeric: tabular-nums; }
    .downloads-panel__bar { height: 3px; border-radius: 999px; background: var(--hira-track-bg, rgba(0,0,0,0.1)); overflow: hidden; margin-left: 26px; }
    /* 未进入多选时行首无复选框：meta/进度条贴齐标签（去掉对齐留白） */
    .downloads-panel__list:not(.is-multi) .downloads-panel__meta { padding-left: 0; }
    .downloads-panel__list:not(.is-multi) .downloads-panel__bar { margin-left: 0; }
    .downloads-panel__bar-inner { height: 100%; background: var(--hira-accent, #3b82f6); border-radius: 999px; transition: width 0.25s ease; }
    /* 总量未知（chunked / 无 Content-Length）时没有百分比可算：跑一条不确定态滑块，
       而不是留一根空条 —— 空条读起来就是"卡在 0%"。只用 transform，不触发布局。 */
    .downloads-panel__bar.is-indeterminate .downloads-panel__bar-inner { width: 35% !important; animation: hira-dl-indeterminate 1.1s var(--hira-ease-standard, ease) infinite; }
    @keyframes hira-dl-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(285%); } }
    /*
     * 已完成项的「打开 / 打开文件夹」——**单独占一行**。
     * 挤进标题行的话，文件名会被两个按钮压到只剩几个字（完成项那一行又长又臃肿），
     * 所以让它另起一行；纵向与 meta / 进度条一致，多选态下按 26px 对齐复选框。
     */
    .downloads-panel__actions { display: flex; flex-wrap: wrap; gap: 4px; padding-left: 26px; }
    .downloads-panel__list:not(.is-multi) .downloads-panel__actions { padding-left: 0; }
    .downloads-panel__actions button {
      border: 0; background: transparent;
      border-radius: var(--hira-radius-sm, 8px); height: var(--hira-control-height, 32px); padding: 0 12px;
      cursor: pointer; font-size: 11px; font-weight: 500; color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .downloads-panel__actions button:hover {
      color: var(--hira-text-primary, #1a1a1a);
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
    }
    /* 纯图标动作（删除记录）：方键，字形由宿主注入的图标端口画（不在这里写死 SVG）。 */
    .downloads-panel__actions button.downloads-panel__action--icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; padding: 0;
    }
    /* 删除记录是破坏性动作：只在 hover 时上危险色 —— 常驻红色会让整行变吵，
       但它又必须和「打开」在视觉上分开，避免误点。 */
    .downloads-panel__actions button.downloads-panel__action--danger:hover {
      color: var(--hira-danger, #ef4444);
      background: var(--hira-danger-soft, rgba(239, 68, 68, 0.1));
    }
    .downloads-panel__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #9ca3af); font-size: 12px; line-height: 19px;
    }
  `
  doc.head.appendChild(style)
}

/**
 * @param {Document} doc
 * @param {{
 *   onIntent?: (intent: DownloadIntent) => void,
 *   slots?: { call?: (slotId: string, payload: unknown, fallback?: unknown) => unknown },
 *   loadFileIcon?: (filePath: string, size: number) => Promise<string|null>,
 *   createIcon?: (name: string, size?: number) => Element|null
 * }} [ctx]
 *   `ctx.slots` 是宿主注入的**渲染侧插槽端口**（本组件不认识插件系统，只知道
 *   "按 id 调一个函数"）。用于 `download.state-badge-renderer`，见 renderRow。
 *   `ctx.loadFileIcon` 是**真实文件图标**的取数端口（宿主用 bridge 建一个喂进来）——
 *   本组件因此不需要认识 IPC 通道名（CONTRACT-11），拿不到就只画类型图标。
 * @returns {DownloadPanelResult}
 */
export function createDownloadsPanel(doc: Document, ctx: PanelContext = {}): DownloadPanelResult {
  const panelCtx = ctx as DownloadPanelContext
  const onIntent = typeof panelCtx.onIntent === 'function' ? panelCtx.onIntent : () => {}
  const slots = panelCtx.slots || null
  const loadFileIcon = typeof panelCtx.loadFileIcon === 'function' ? panelCtx.loadFileIcon : null
  // 图标端口（宿主注入，ui 包不得 import 应用层图标表）：拿不到就退回文字按钮，
  // 绝不能出现一个"没有字也没有图"的空方键。
  const createIcon = typeof panelCtx.createIcon === 'function' ? panelCtx.createIcon : null
  const wrap = doc.createElement('div')
  wrap.className = 'downloads-panel__wrap'

  // ── 状态筛选 ──
  const filters = doc.createElement('div')
  filters.className = 'downloads-panel__filters'
  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '进行中' },
    { key: 'completed', label: '已完成' }
  ]
  let activeFilter = 'all'
  for (const f of FILTERS) {
    const btn = doc.createElement('button')
    btn.className = `downloads-panel__filter${f.key === activeFilter ? ' downloads-panel__filter--active' : ''}`
    btn.textContent = f.label
    btn.dataset.filter = f.key
    btn.addEventListener('click', () => {
      activeFilter = f.key
      filters.querySelectorAll<HTMLElement>('.downloads-panel__filter').forEach((filterButton) => {
        filterButton.classList.toggle('downloads-panel__filter--active', filterButton.dataset.filter === activeFilter)
      })
      render()
    })
    filters.appendChild(btn)
  }
  wrap.appendChild(filters)

  // ── 工具栏 ──
  const toolbar = doc.createElement('div')
  toolbar.className = 'downloads-panel__toolbar'
  const selectAll = doc.createElement('button')
  selectAll.appendChild(Check(doc, { size: 16 }))
  selectAll.title = '全选 / 取消全选'
  selectAll.setAttribute('aria-label', selectAll.title)
  const removeSelected = doc.createElement('button')
  removeSelected.appendChild(Trash2(doc, { size: 16 }))
  removeSelected.title = '删除所选中项的下载记录'
  removeSelected.setAttribute('aria-label', removeSelected.title)
  removeSelected.disabled = true
  const clearCompleted = doc.createElement('button')
  clearCompleted.appendChild(Eraser(doc, { size: 16 }))
  clearCompleted.title = '清理已完成项的记录'
  clearCompleted.setAttribute('aria-label', clearCompleted.title)
  const copyLink = doc.createElement('button')
  copyLink.appendChild(Copy(doc, { size: 16 }))
  copyLink.title = '复制选中项的下载链接'
  copyLink.setAttribute('aria-label', copyLink.title)
  copyLink.disabled = true
  toolbar.append(selectAll, removeSelected, clearCompleted, copyLink)
  wrap.appendChild(toolbar)

  const list = doc.createElement('div')
  list.className = 'downloads-panel__list'
  wrap.appendChild(list)

  let items: DownloadItem[] = []
  const progressMap = new Map<string, DownloadProgress>()
  /**
   * 已挂载行的元素引用（id → refs）。
   *
   * 为什么不在 updateProgress 里用 `querySelector` 现找：每 200ms 一次 × 多个活动下载，
   * 每次都要走一遍选择器 + 再找 4 个子节点，是白给的开销。行是 render 时建的，
   * 建的时候顺手把要改的节点记下来，刷新就是几次属性写入。
   */
  const rowRefs = new Map<string, DownloadRowRefs>()
  let itemById = new Map<string, DownloadItem>()
  /** 上一次整表渲染时的结构签名（见 structureSignature） */
  let lastSignature = ''
  /** @type {Set<string>} */ const selected: Set<string> = new Set()
  // 多选态：仅进入多选时才显示每行复选框（未多选时行首无复选框也无占位）
  let multiSelect = false

  function matchesFilter(item: DownloadItem) {
    const s = item.state
    switch (activeFilter) {
      case 'active': return isActiveDownloadState(s)
      case 'completed': return s === 'completed'
      default: return true
    }
  }

  function syncActionState() {
    removeSelected.disabled = selected.size === 0
    copyLink.disabled = selected.size === 0 || selected.size > 1
  }

  // ── 右键 → 原生菜单（意图上行，编排层负责弹 Menu 与分发）──
  list.addEventListener('contextmenu', (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-id]')
    if (!row) return
    e.preventDefault()
    const id = row.getAttribute('data-id')
    const item = items.find((candidate) => String(candidate.id) === id)
    if (!item) return
    // 状态以实时进度为准：列表快照只在下一次重列时更新，右键"暂停/继续"不能按旧状态判。
    const live = id ? progressMap.get(id) : undefined
    onIntent({ type: 'menu', item: live && live.state ? { ...item, state: live.state } : item, x: e.clientX, y: e.clientY })
  })

  wrap.addEventListener('click', (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    // 行内动作按钮（打开 / 打开文件夹）：**必须先于**下面的多选分支拦截 ——
    // 否则会先命中「点击行 = 切换选中」，变成点一下按钮顺带改了选中集。
    const actionBtn = target?.closest<HTMLElement>('.downloads-panel__action')
    if (actionBtn) {
      e.stopPropagation()
      const id = actionBtn.getAttribute('data-id')
      const item = items.find((candidate) => String(candidate.id) === String(id))
      onIntent({ type: actionBtn.dataset.action, id, filePath: item?.filePath })
      return
    }
    if (e.target === selectAll) {
      const rows = list.querySelectorAll('[data-id]')
      const allSelected = rows.length > 0 && Array.from(rows).every((row) => {
        const rowId = row.getAttribute('data-id')
        return rowId !== null && selected.has(rowId)
      })
      if (allSelected) {
        selected.clear()
        multiSelect = false
      } else {
        selected.clear()
        rows.forEach((row) => {
          const rowId = row.getAttribute('data-id')
          if (rowId) selected.add(rowId)
        })
        multiSelect = true
      }
      render()
      return
    }
    if (e.target === removeSelected) {
      const ids = Array.from(selected)
      if (ids.length) {
        selected.clear()
        multiSelect = false
        onIntent({ type: 'remove-many', ids })
      }
      return
    }
    if (e.target === clearCompleted) { onIntent({ type: 'clear-completed' }); return }
    if (e.target === copyLink) {
      const ids = Array.from(selected)
      if (ids.length === 1) onIntent({ type: 'copy-link', id: ids[0] })
      return
    }
    const check = target?.closest<HTMLInputElement>('input[type=checkbox].downloads-panel__check[data-id]')
    if (check) {
      const id = check.getAttribute('data-id')
      if (id && check.checked) selected.add(id)
      else if (id) selected.delete(id)
      if (selected.size === 0) multiSelect = false
      render()
      return
    }
    // 多选态或 Ctrl/⌘ 点击行 = 切换选中（保留批量能力，未多选时点击行不做事）
    const row = target?.closest<HTMLElement>('[data-id]')
    if (row && (e.ctrlKey || e.metaKey || multiSelect)) {
      const id = row.getAttribute('data-id')
      if (id && selected.has(id)) selected.delete(id)
      else if (id) selected.add(id)
      if (selected.size === 0 && multiSelect) multiSelect = false
      if (e.ctrlKey || e.metaKey || multiSelect) render()
      else syncActionState()
      return
    }
  })

  function reflowChecks() {
    list.querySelectorAll<HTMLInputElement>('input[type=checkbox].downloads-panel__check').forEach((checkbox) => {
      checkbox.checked = checkbox.dataset.id ? selected.has(checkbox.dataset.id) : false
    })
  }

  /**
   * 一行的有效可视量：**DB 静态字段 + 实时进度覆盖** → 单一口径。
   * 合并规则在 shared-types（底部下载条 / 内部下载页共用同一份），这里只做别名。
   */
  const resolveView = resolveDownloadView

  /** 按位置显隐（保持节点顺序稳定，避免实时刷新时增删节点引起布局跳动） */
  function pick(el: HTMLElement, show: boolean, text: string) {
    el.style.display = show ? '' : 'none'
    el.textContent = show ? text : ''
  }

  /**
   * 把有效可视量写进已挂载的一行 —— **只改文本/宽度/显隐，不建节点、不重排**。
   * 状态变化不走这里（见 updateProgress：状态变了就重建那一行，插件角标也跟着重画）。
   */
  function applyView(refs: DownloadRowRefs, view: DownloadView) {
    // 0 字节时 formatBytes 的占位符「—」在这条语境里读着像"没数据"，写成 0 B
    const got = view.received > 0 ? formatBytes(view.received) : '0 B'
    refs.size.textContent = view.total > 0 ? `${got} / ${formatBytes(view.total)}` : `已接收 ${got}`
    pick(refs.pct, view.pct != null, view.pct != null ? `${view.pct}%` : '')
    pick(refs.speed, view.speed > 0, formatSpeed(view.speed))
    // ETA 算不出来（总量未知 / 采样还不够）就不显示：状态词已经在标题行有一份，
    // 这里再写一遍等于同一句话在一行里出现两次。格子恒定存在，只是 display:none。
    pick(refs.eta, view.eta > 0, formatETA(view.eta))
    // 总量未知但仍在跑 → 不确定态滑块（见样式处说明）；否则按百分比走
    const indeterminate = view.active && view.pct == null
    refs.bar.classList.toggle('is-indeterminate', indeterminate)
    refs.barInner.style.width = indeterminate ? '35%' : `${view.pct ?? 0}%`
    refs.bar.style.display = view.total > 0 || view.active ? '' : 'none'
  }

  function renderEmpty() {
    list.textContent = ''
    const empty = doc.createElement('div')
    empty.className = 'downloads-panel__empty'
    empty.textContent = '暂无下载'
    list.appendChild(empty)
  }

  /**
   * 状态角标插槽（`download.state-badge-renderer`，SINGLE）。
   *
   * 只交给插件**已经算好的量**：`received / total / pct / speed / eta` 都是本组件
   * 自己在算的东西，让插件再来一遍不但重复，还会因为"实时字段来自 progressMap、
   * 静态字段来自 DB"这条分叉在插件侧漏掉一半（表现就是角标停在陈旧数值上）。
   *
   * @returns {HTMLElement|null} 插件画的角标；没有实现 / 返回值不是元素 → null（回落内置文案）
   */
  function renderStateBadge(item: DownloadItem, view: DownloadView): HTMLElement | null {
    if (!slots || typeof slots.call !== 'function') return null
    const node = slots.call('download.state-badge-renderer', {
      id: item.id,
      filename: item.filename || '',
      url: item.url || '',
      filePath: item.filePath || '',
      state: view.state,
      stateText: downloadStateText(view.state),
      isActive: view.active,
      receivedBytes: view.received,
      totalBytes: view.total,
      percent: view.pct,
      speed: view.speed,
      eta: view.eta
    }, null)
    if (!(node instanceof Element) || node.nodeType !== Node.ELEMENT_NODE) return null
    const element = node as HTMLElement
    // 宿主的类名只负责「排得进去」（对齐状态文字那一格），外观仍归插件。
    element.classList.add('downloads-panel__state-badge')
    return element
  }

  /**
   * 行内动作按钮（唯一构造处）：优先**图标型**（28px 方键），端口缺失时退回文字。
   * 图标可来自本包图标（`iconFn`，首选）或宿主端口（`icon` 名字），
   * 两者都取不到就退文字 —— 绝不出现空方键。
   */
  function makeActionButton(item: DownloadItem, action: string, text: string, opts: ActionButtonOptions = {}) {
    const btn = doc.createElement('button')
    btn.type = 'button'
    const danger = action === 'remove'
    btn.className = `downloads-panel__action${danger ? ' downloads-panel__action--danger' : ''}`
    btn.dataset.action = action
    if (item.id != null) btn.setAttribute('data-id', String(item.id))
    const title = opts.title || text
    if (title) btn.title = title
    const size = opts.iconSize || 14
    const icon = typeof opts.iconFn === 'function'
      ? opts.iconFn(doc, { size })
      : (opts.icon && createIcon ? createIcon(opts.icon, size) : null)
    if (icon) {
      btn.classList.add('downloads-panel__action--icon')
      btn.appendChild(icon)
      btn.setAttribute('aria-label', text || opts.label || action)
    } else {
      btn.textContent = text
    }
    return btn
  }

  function renderRow(item: DownloadItem) {
    const key = item.id != null ? String(item.id) : ''
    const row = doc.createElement('div')
    row.className = 'downloads-panel__row'
    if (key) row.setAttribute('data-id', key)
    row.title = '右键查看下载操作'

    // ── 统一拖拽源 ────────────────────────────────────────────────
    // 把一条下载拖进集锦 / 画板 = "这个资源我要留着"。有远端 URL 就给 URL
    // （落点可当链接/图片卡）；只有落盘路径时给 filePath（落点可当本地引用）。
    row.draggable = true
    row.addEventListener('dragstart', (e: DragEvent) => {
      const dataTransfer = e.dataTransfer
      if (!dataTransfer) return
      setDragItem(dataTransfer, {
        domain: 'download',
        id: item.id != null ? String(item.id) : (item.url || item.filePath || item.filename || ''),
        kind: 'file',
        url: item.url || '',
        title: item.filename || '',
        text: item.filePath || ''
      }, { effectAllowed: 'copy' })
      row.classList.add('is-dragging')
    })
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'))

    const head = doc.createElement('div')
    head.className = 'downloads-panel__row__head'

    // 复选框仅在多选态显示（未多选时行首无复选框、无占位，直接是文件图标）
    if (multiSelect) {
      const check = doc.createElement('input')
      check.type = 'checkbox'
      check.className = 'downloads-panel__check'
      check.setAttribute('data-id', String(item.id))
      check.checked = selected.has(String(item.id))
      head.appendChild(check)
    }

    // 行首文件图标：真实文件图标优先（有落盘路径就问主进程要），
    // 拿不到才回落扩展名类型图标 —— 与 hira://downloads 内部页同一套实现（真源在
    // shared-types/src/file-icon.mjs），所以同一个下载项在面板与下载页长得一样。
    head.appendChild(createFileIcon(doc, item.filename, 16, { filePath: item.filePath, loadIcon: loadFileIcon }))

    const label = doc.createElement('span')
    label.className = 'downloads-panel__label'
    label.textContent = item.filename || 'download'
    label.title = item.url || ''
    head.appendChild(label)

    // 进度 + 速度 + 剩余时间（实时字段合并 progressMap）。
    // 注意：这份合并量必须**先于状态角标**算出来 —— 角标是插件画的，
    // 插件要显示"45% · 1.2 MB/s"这类东西时得拿得到它们（见下方 renderStateBadge）。
    const view = resolveView(item, progressMap.get(key))

    const st = doc.createElement('span')
    st.className = 'downloads-panel__state'
    // 状态角标插槽（`download.state-badge-renderer`，SINGLE）：
    // 插件给了元素就用它，否则回落内置文案 —— SINGLE 的语义就是"替换默认实现"。
    const badge = renderStateBadge(item, view)
    if (badge) st.appendChild(badge)
    else st.textContent = downloadStateText(view.state)
    head.appendChild(st)

    row.appendChild(head)

    // meta 的四个格子**恒定存在**（用显隐控制"有没有值"）：实时刷新只改文本与
    // display，不往 DOM 里插节点/删节点 —— 否则同一次下载里"速度"从无到有时会重排。
    const meta = doc.createElement('div')
    meta.className = 'downloads-panel__meta'
    const sizeEl = doc.createElement('span')
    const pctEl = doc.createElement('span')
    const speedEl = doc.createElement('span')
    const etaEl = doc.createElement('span')
    meta.append(sizeEl, pctEl, speedEl, etaEl)
    row.appendChild(meta)

    const bar = doc.createElement('div')
    bar.className = 'downloads-panel__bar'
    const inner = doc.createElement('div')
    inner.className = 'downloads-panel__bar-inner'
    row.appendChild(bar)
    bar.appendChild(inner)

    // 建行时就把"待会儿要改的节点"记下来：updateProgress 因此不需要查 DOM。
    const refs = {
      item,
      row,
      state: view.state,
      size: sizeEl,
      pct: pctEl,
      speed: speedEl,
      eta: etaEl,
      bar,
      barInner: inner
    }
    if (key) rowRefs.set(key, refs)
    applyView(refs, view)

    // 行内动作独占一行（见样式处的说明）。取舍判据与右键菜单完全一致，两处不分叉：
    //   · 「打开 / 打开文件夹」：只有**已经落地成文件**的项才谈得上打开；
    //   · 「删除记录」：只给**终态**项 —— 活动项删了记录，主进程的进度事件会追着一个
    //     不存在的条目继续广播（面板每 200ms 补一次列表来发现"新下载"，等于风暴）。
    //     活动项该用右键菜单的「取消」，取消后再删。
    const openable = item.state === 'completed' && Boolean(item.filePath)
    const removable = !isLiveDownloadState(item.state)
    if (openable || removable) {
      const actions = doc.createElement('div')
      actions.className = 'downloads-panel__actions'
      if (openable) {
        actions.appendChild(makeActionButton(item, 'open', '打开', { iconFn: ExternalLink, title: '打开文件' }))
        actions.appendChild(makeActionButton(item, 'show-in-folder', '打开文件夹', { iconFn: Folder, title: '在文件夹中显示' }))
      }
      if (removable) {
        // 图标型：垃圾桶，文案只留在 title / aria-label 里。
        actions.appendChild(makeActionButton(item, 'remove', '删除记录', {
          iconFn: Trash2,
          title: '删除记录（仅移除下载记录，不删除已下载的文件）'
        }))
      }
      row.appendChild(actions)
    }
    return row
  }

  function render() {
    // 行会被整批重建，旧引用一律作废（updateProgress 命中不到就该走"补一次列表"）
    rowRefs.clear()
    lastSignature = structureSignature()
    const shown = items.filter(matchesFilter)
    if (shown.length === 0) { renderEmpty(); syncActionState(); return }
    const frag = doc.createDocumentFragment()
    for (const it of shown) frag.appendChild(renderRow(it))
    list.textContent = ''
    list.classList.toggle('is-multi', multiSelect)
    list.appendChild(frag)
    reflowChecks()
    syncActionState()
  }

  /**
   * 结构签名：决定"这一屏的行集合/行内容是否需要重建"。
   * 只有 id 序、状态、落盘路径、筛选、多选态变了才重建；
   * 其余变化（receivedBytes 等）走 repaint() 原地写文本 —— 补一次列表不会闪屏。
   */
  function structureSignature() {
    const parts = [`${activeFilter}|${multiSelect ? 1 : 0}`]
    for (const it of items) {
      if (!matchesFilter(it)) continue
      parts.push(`${it.id}\u0001${it.state}\u0001${it.filePath || ''}\u0001${it.filename || ''}`)
    }
    return parts.join('\u0002')
  }

  /** 原地重绘所有已挂载行（复用 applyView；状态变了只重建那一行） */
  function repaint() {
    for (const [key, refs] of rowRefs) {
      const item = itemById.get(key) || refs.item
      const view = resolveView(item, progressMap.get(key))
      if (view.state !== refs.state) {
        const fresh = renderRow(item)
        refs.row.replaceWith(fresh)
      } else {
        refs.item = item
        applyView(refs, view)
      }
    }
    syncActionState()
  }

  /** 全量重列（DB 静态字段 + 保留实时进度覆盖） */
  function setItems(newItems: readonly DownloadItem[]) {
    items = Array.isArray(newItems) ? newItems.slice() : []
    itemById = new Map(items.map((item) => [String(item.id), item]))
    // 只保留「还在跑 / 暂停」条目的进度缓存：
    //   · 终态条目的进度已由主进程落库（完成前补了最终值），缓存没有意义；
    //   · 而且最后一条 progress 的 state 还停在 in_progress，留着会把"已完成"覆盖成"进行中"。
    /** @type {Set<string>} */ const alive: Set<string> = new Set()
    for (const it of items) {
      if (isLiveDownloadState(it.state)) alive.add(String(it.id))
    }
    for (const k of Array.from(progressMap.keys())) if (!alive.has(k)) progressMap.delete(k)
    // 行集合没变 → 只刷新文本/进度条，避免 2s 校准与补列时整表重建引起的闪烁。
    if (structureSignature() === lastSignature) { repaint(); return }
    render()
  }

  /** 是否有进行中的下载（宿主的兜底校准据此决定要不要补一次列表） */
  function hasActive() {
    for (const p of progressMap.values()) if (isActiveDownloadState(p.state)) return true
    return items.some((item) => isActiveDownloadState(item.state))
  }

  /**
   * 实时进度合并：原地把这一行的**全部实时量**刷新一遍（大小 / 百分比 / 速度 / ETA / 进度条），
   * 不整表重排 —— 100ms 级的刷新不能带起布局抖动。
   *
   * 状态变化（进行中 ↔ 暂停）不逐字改，而是**只重建这一行**：状态文案与插件角标都
   * 依赖状态，重建比"分别记得要重画哪几处"更不容易漏（角标是插件画的，宿主无法局部改）。
   *
   * @returns {boolean} 该行当前是否已在列表中（未命中=新下载项，编排层据此补一次列表刷新）
   */
  function updateProgress(progress: DownloadProgress): boolean {
    const p = progress
    if (!p || p.id == null) return false
    const key = String(p.id)
    progressMap.set(key, p)
    const refs = rowRefs.get(key)
    if (refs) {
      const view = resolveView(refs.item, p)
      if (view.state !== refs.state) {
        const fresh = renderRow(refs.item)
        refs.row.replaceWith(fresh)
      } else {
        applyView(refs, view)
      }
      return true
    }
    // 行不在 DOM：**已知条目**只是被筛选掉（如筛选在「已完成」时下载仍在跑），
    // 不需要补列表；未知 id 才是新下载。
    return items.some((item) => String(item.id) === key)
  }

  return { element: wrap, setItems, updateProgress, hasActive }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'downloads-panel',
  injectStyles: injectDownloadsPanelStyles,

  mount(doc, ctx) {
    const panelCtx = ctx as DownloadPanelContext
    const { bridge, events, on, menu: menuClient, confirm } = panelCtx
    if (!bridge) throw new Error('downloads panel requires a renderer bridge')
    const downloadBridge = bridge

    // 具名函数（而非对象字面量里的方法简写）：右键菜单的「暂停/继续/取消/重试」
    // 分支要回调它 —— 方法简写不在外层作用域里，先前那样写会在点到这些项时抛
    // ReferenceError（表现为「下载右键菜单点暂停没反应」）。
    function handleIntent(intent: DownloadIntent) {
      const { type, id, filePath, ids, item, x, y } = intent
      if (type === 'remove' && id != null) {
        downloadBridge.provider.invoke('download:remove', { id }).then(refresh).catch(() => {})
      } else if (type === 'remove-many' && Array.isArray(ids)) {
        downloadBridge.provider.invoke('download:remove-many', { ids }).then(refresh).catch(() => {})
      } else if (type === 'clear-completed') {
        const confirmation = confirm
          ? confirm({ title: '清空下载', message: '确定清空全部已完成的下载记录吗？此操作不可撤销。', danger: true, confirmLabel: '清空' })
          : true
        Promise.resolve(confirmation).then((ok) => {
          if (ok) downloadBridge.provider.invoke('download:clear-completed', {}).then(refresh).catch(() => {})
        }).catch(() => {})
      } else if (type === 'pause' && id) {
        downloadBridge.provider.invoke('download:pause', { id }).then(refresh).catch(() => {})
      } else if (type === 'resume' && id) {
        downloadBridge.provider.invoke('download:resume', { id }).then(refresh).catch(() => {})
      } else if (type === 'cancel' && id) {
        downloadBridge.provider.invoke('download:cancel', { id }).then(refresh).catch(() => {})
      } else if (type === 'retry' && id) {
        downloadBridge.provider.invoke('download:retry', { id }).catch(() => {})
      } else if (type === 'open' && (id || filePath)) {
        downloadBridge.provider.invoke('download:open', id ? { id } : { filePath })
      } else if (type === 'show-in-folder' && (id || filePath)) {
        downloadBridge.provider.invoke('download:show-in-folder', id ? { id } : { filePath })
      } else if (type === 'copy-link' && (item?.url || id)) {
        const url = item?.url
        if (url) navigator.clipboard.writeText(url).catch(() => {})
      } else if (type === 'menu' && item) {
        showDownloadMenu(item, x || 0, y || 0)
      }
    }

    const panel = createDownloadsPanel(doc, {
      onIntent: handleIntent,
      slots: panelCtx.slots,
      // 图标端口：ui 包不得 import 应用层图标表，字形一律由宿主按名字注入。
      createIcon: panelCtx.icons && typeof panelCtx.icons.ui === 'function'
        ? (name: string, size?: number) => panelCtx.icons?.ui?.(name, size) || null
        : null,
      // 真实文件图标：主进程 app.getFileIcon 的 dataUrl（老 Hira 的下载项图标做法）。
      // 取数器带缓存 —— 每 2s 一次的进度刷新不会重复问同一张图标。
      loadFileIcon: createFileIconLoader((filePath, size) =>
        downloadBridge.provider.invoke('download:get-file-icon', { filePath, size }).then((result) => {
          if (!result || typeof result !== 'object') return null
          const dataUrl = (result as { dataUrl?: unknown }).dataUrl
          return typeof dataUrl === 'string' ? dataUrl : null
        })
      )
    })

    // 每次补列都要过一次 IPC；进度事件与 2s 校准可能同时触发 → 一次在飞、一次排队，
    // 不叠加请求、也不会让最后一次请求被丢掉。
    let refreshInFlight: Promise<void> | null = null
    let refreshQueued = false
    let refreshEpoch = 0

    function refresh() {
      const epoch = ++refreshEpoch
      if (refreshInFlight) { refreshQueued = true; return refreshInFlight }
      refreshInFlight = downloadBridge.provider.invoke('download:list', {})
        .then((next) => {
          if (epoch !== refreshEpoch) return
          panel.setItems(Array.isArray(next) ? next as DownloadItem[] : [])
          syncCalibration()
        })
        .catch(() => {})
        .finally(() => {
          refreshInFlight = null
          if (refreshQueued) { refreshQueued = false; refresh() }
        })
      return refreshInFlight
    }

    refresh()

    // 实时进度：progress 事件已携带 speed/eta，原地更新对应行，不整表重排。
    // 未命中行 = 新下载开始 → 补一次列表，让进行中项立即出现并显示进度条。
    // 但「记录已被删除、下载仍在跑」的条目也会持续报进度：不加节流就是每 200ms
    // 一次 IPC + 整表比对。500ms 的窗口足以让新下载立刻出现，又不会让被删项刷屏。
    let lastProbeAt = 0
    if (typeof on === 'function' && events?.downloadProgress && events.downloadDone) {
      on(events.downloadProgress, (payload) => {
        if (!payload || typeof payload !== 'object') return
        try {
          if (panel.updateProgress(payload as DownloadProgress)) return
          const now = Date.now()
          if (now - lastProbeAt < 500) return
          lastProbeAt = now
          refresh()
        } catch (_) {}
      })
      on(events.downloadDone, () => refresh())
    }

    // 兜底校准：progress 事件偶发丢失（如 MCD 与 DownloadItem 交接、窗口重建）时，
    // 只靠事件会让一行停在旧数值上。**只在有活动下载时保留定时器**：
    // 空闲面板不再每 2s 唤醒一次；下一次 progress / done / 列表刷新会把表重新收敛。
    // **不看 doc.hidden**：面板是独立 WebContentsView，隐藏/未激活时 document.visibilityState
    // 常被判成 hidden；一旦按它跳过，事件再丢就永远追不上（表现就是"卡 0%，下完跳 100%"）。
    const win = doc.defaultView
    let calibrateTimer: ReturnType<typeof setInterval> | null = null
    function stopCalibration(): void {
      if (!calibrateTimer) return
      clearInterval(calibrateTimer)
      calibrateTimer = null
    }
    function syncCalibration(): void {
      if (!panel.hasActive()) {
        stopCalibration()
        return
      }
      if (calibrateTimer) return
      calibrateTimer = setInterval(() => {
        if (!panel.hasActive()) {
          stopCalibration()
          return
        }
        refresh()
      }, 2000)
    }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', stopCalibration, { once: true })
    }

    // 下载项右键菜单：原生 Menu，动作分发映射到各 IPC
    async function showDownloadMenu(item: DownloadItem, x: number, y: number) {
      const id = String(item.id)
      const state = item.state
      const isActive = state === 'in_progress' || state === 'progressing' || state === 'pending'
      // 源地址可收进集锦（与页面右键 / 标签右键同一个原生子菜单）；
      // 本地文件 / blob 没有可收藏的地址 → 整项不出现。
      const collectible = isHttpUrl(item.url)
      const notes = panelCtx.clients?.notes || null
      // notes 功能面不可用（集锦引擎 / 集锦面板被关掉）⇒ 不收子菜单，整项直接不出现。
      // 宿主没提供判据（老的 ctx / 单元测试）时 fail-open，保持"有客户端就给入口"。
      const notesAvailable = typeof panelCtx.isFeatureAvailable === 'function' ? panelCtx.isFeatureAvailable('notes') : true
      let collectionItems: MenuItem[] = []
      if (collectible && notes && notesAvailable) {
        let folders: Array<{ id?: string; name?: string }> = []
        // 取不到集锦也不能让「收进」入口消失：描述符在空列表下依然给出
        // 稍后读 / 未归档 / 新建集锦三项（顺序由真源保证）。
        try { folders = await notes.folders() } catch (_) { folders = [] }
        collectionItems = toActionMenuItems(buildCollectionMenuEntries(folders)) as MenuItem[]
      }
      const items: MenuItem[] = []
      if (isActive) items.push({ label: '暂停', action: 'pause' })
      else if (state === 'paused') items.push({ label: '继续', action: 'resume' })
      if (isActive || state === 'paused') items.push({ label: '取消', action: 'cancel' })
      if (state === 'completed' && item.filePath) {
        items.push({ label: '打开文件', action: 'open' })
        items.push({ label: '打开所在文件夹', action: 'show-in-folder' })
      }
      if (state === 'interrupted' || state === 'failed' || state === 'cancelled') {
        items.push({ label: '重试', action: 'retry' })
      }
      items.push({ type: 'separator', action: null })
      items.push({ label: '复制下载链接', action: 'copy-link' })
      if (collectionItems.length) items.push({ label: '添加到集锦', submenu: collectionItems })
      items.push({ label: '删除记录', action: 'remove' })
      if (!menuClient) return
      menuClient.popupMenu({
        items,
        x,
        y,
        // 只上报「哪一类菜单」+ 快照，插槽映射由主进程白名单决定（渲染层不能自选插槽）。
        context: {
          kind: 'download',
          snapshot: { id, url: item.url || '', filename: item.filename || '', state, filePath: item.filePath || '' }
        }
      }).then((act) => {
        if (!act) return
        if (act === 'copy-link') {
          if (item.url) navigator.clipboard.writeText(item.url).catch(() => {})
        } else if (act === 'remove') {
          downloadBridge.provider.invoke('download:remove', { id }).then(refresh).catch(() => {})
        } else {
          const target = collectionTargetFromAction(act) as CollectionTarget | null
          if (!target) {
            handleIntent({ type: act, id, filePath: item.filePath })
            return
          }
          // 子菜单回传的落点：解码 + 落库都走共享真源（新建集锦 / 稍后读的兜底全在那边）。
          if (notes) {
            captureToCollectionTarget(notes, { url: item.url, title: item.filename || item.url }, target)
              .then((ok) => { if (ok) refresh() })
              .catch(() => {})
          }
        }
      }).catch(() => {})
    }

    return { element: panel.element, refresh }
  }
}
