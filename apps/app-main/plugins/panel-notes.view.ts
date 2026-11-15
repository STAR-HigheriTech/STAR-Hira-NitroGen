/**
 * 笔记面板的**视图**（只画 DOM + 转译用户意图，不持有数据）。
 *
 * 面板的第一职责是**记录 / 备忘 / 暂存**：快速收进来 + 快速取用。因此列表是**主态**，
 * 编辑器是**独立态**（只在点 note 卡或 ⋯→编辑时进入，并有一条明确的 ‹ 返回）。
 *
 * IA 对齐经典 Edge 集锦的**单栏两态**：
 *   · 列表态（根）——「集锦」+ 新建 + 集锦卡片墙 + 未归档卡片；
 *   · 卡片态（进入某集锦）—— ‹ 返回 + 集锦名 + ⋯ + 卡片列表。
 * 顶部保留五个高频分段：集锦 / 全部 / 稍后读 / 归档 / 回收站；类型过滤收进「筛选」下拉，
 * 不在窄面板里铺一排 chip（这是窄侧栏的第一条纪律）。
 *
 * 「网页就是网页，卡片就是卡片」：单击行为**不在本文件按 kind 判**，一律交给
 * `model.primaryAction(card)`（唯一真源）；视图只把它返回结果里需要 DOM 的那两种
 * 呈现出来（写剪贴板 + 大图预览），其余（打开链接 / 打开原图 / 跳目标 / 进编辑）模型已做完。
 *
 * 四个不变量：
 *   1. 工具栏只建一次 —— 搜索框若每次 render 重建，输入一个字就丢焦点；
 *   2. 编辑器按 note id 缓存 —— 输入期间 state 变化不能把 textarea 重建掉；
 *   3. 所有卡片只经**同一个 `renderCard`** 出口 —— 绝不为某一种 kind 另写一套列表；
 *   4. 单击行为只经 `model.primaryAction` 一个出口 —— 见上，防"页面卡点开却进了编辑器"回归。
 *
 * 键盘导航（"暂存场景下用户是键盘手"）：
 *   在**卡片列表态**且焦点不在输入框 / 编辑器里时，↑↓ 移动聚焦卡、Enter 对它执行
 *   `primaryAction`（"一点就用"的键盘等价物）、Del/Backspace 删除（进回收站）、Esc 收起、
 *   Ctrl/Cmd+C 复制链接 —— 即"不离开键盘就能用"。聚焦态是**视图局部状态** keyNavId
 *   （与 editingNoteId / renamingFolderId 同类），不进 model：重画时按 id 复原即可。
 */

import { renderMarkdown, plainTextSnippet } from './panel-notes.markdown.js'
import {
  NOTE_COLORS, NOTE_SORTS, NOTE_KINDS, KIND_LABELS, NOTE_SECTIONS, NOTE_SECTION_LABELS,
  NOTE_EXPORT_FORMATS, NOTE_EXPORT_FORMAT_LABELS, NOTES_LIST_RENDER_LIMIT,
  displayTitle, normalizeKind, TEXT_FRAGMENT_MARKER,
  parseNoteAssetUri,
  perfStart, perfEnd,
  type NotesModel
} from './panel-notes.model.js'
import { faviconSourceCandidates, createFaviconImg } from '@hira-ng/shared-types/src/favicon-src.mjs'
import { setDragItem, getDragItem, hasDragItem, pickDropEffect } from '@hira-ng/shared-types/src/drag-item.mjs'
import { createArchiveView, injectArchiveViewStyles } from '@hira-ng/ui-panel-opentabs'
// 「域名缩写」的**唯一真源**：只认 http(s)、取 hostname、去 `www.`、丢弃路径与查询。
// 直接引 shared-types 的站点键（与"按域名分组标签 / 注入规则 host"同一口径）——
// 各写一份的代价是"卡片上显示的域名"与"标签分组用的域名"迟早对不上（去 www. 只做了一处）。
import { isHttpUrl, siteKeyOf } from '@hira-ng/shared-types/src/url-protocols.mjs'
import type { CaptureNoteInput, Note, NoteFolder, NoteKind } from '@hira-ng/domain-notes'

interface CaptureProvider {
  label?: unknown
  id?: unknown
  capture?: () => unknown | Promise<unknown>
}

interface EditorRefs {
  root: HTMLDivElement
  titleInput: HTMLInputElement
  textarea: HTMLTextAreaElement
  preview: HTMLDivElement
  tagsInput: HTMLInputElement
  pinBtn: HTMLButtonElement
  mdBtn: HTMLButtonElement | null
  folderSelect: HTMLSelectElement
  meta: HTMLDivElement
  dotEls: Map<string, HTMLButtonElement>
  imageThumb: HTMLImageElement | null
  imageOpenBtn: HTMLButtonElement | null
  imageNote: HTMLSpanElement | null
}

interface LoadThumbOptions {
  lazy?: boolean
}

interface ExportProvider {
  id?: unknown
  label?: unknown
  extension?: unknown
  serialize(cards: Note[], name: string): unknown | Promise<unknown>
  encoding?: 'utf8' | 'base64'
}

interface NotesViewPorts {
  menu?: { popupMenu(options: unknown): unknown } | null
  confirm?: (options: { title?: string; message?: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean>
  slots?: {
    call(id: string, payload: unknown, fallback?: unknown): unknown
    callMulti(id: string, payload: unknown): unknown
  } | null
  archiveView?: ReturnType<typeof createArchiveView> | null
}

interface NotesViewArgs {
  doc: Document
  model: NotesModel
  ports?: NotesViewPorts
}

// ── 本地图标（插件自带的 UI 不该依赖宿主图标表的键名）────────────────
// 24 格、圆头、1.8 描边 —— 与全项目图标集同一族。
const ICON_PATHS: Record<string, string> = {
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  linkPlus: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  sort: '<path d="M11 5h10"/><path d="M11 9h7"/><path d="M11 13h4"/><path d="m3 17 3 3 3-3"/><path d="M6 18V4"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  markdown: '<path d="M4 6h16v12H4z"/><path d="M7 15V9l2.5 3L12 9v6"/><path d="M16 9v6"/><path d="m14 13 2 2 2-2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/>',
  // 卡片四态的类型图标（同一个图标位，让四种卡片在同一列里"看起来是一家人"）
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/>',
  quote: '<path d="M9 7H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a3 3 0 0 1-3 3"/><path d="M20 7h-4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a3 3 0 0 1-3 3"/>',
  sticky: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  archive: '<rect width="18" height="5" x="3" y="3" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>'
}

/** 四种卡片各自的类型图标（缺省 = 笔记）。 */
const KIND_ICONS: Record<string, string> = Object.freeze({ note: 'sticky', page: 'globe', image: 'image', snippet: 'quote', ref: 'arrowRight' })

/** 分段 → 图标（标签文字来自 model 的 NOTE_SECTIONS，视图只补图标，不复制文案）。 */
const SECTION_ICONS: Record<string, string> = Object.freeze({ collections: 'layers', all: 'grid', reading: 'clock', archive: 'archive', trash: 'trash' })

type TimerHandle = ReturnType<typeof setTimeout>

const COLOR_NAMES: Record<string, string> = { '#ef4444': '红', '#f59e0b': '橙', '#10b981': '绿', '#3b82f6': '蓝', '#8b5cf6': '紫', '#ec4899': '粉' }

export function createNotesView({ doc, model, ports = {} }: NotesViewArgs) {
  const archiveView = ports.archiveView || null
  if (archiveView) injectArchiveViewStyles(doc)
  const menu = ports.menu ?? null
  const confirm = ports.confirm ?? (async () => true)

  // ── 渲染侧插槽（可选能力，拿不到就整体降级成内建行为）──────────────
  //
  // 端口由宿主注入（apps/app-main/src/renderer/panels/main.js#slotPort）；面板本身
  // **不 import 插件系统**（CONTRACT-11），也不知道"谁实现、怎么注册"。
  //   · note.card-renderer     SINGLE —— 返回元素则替换卡片主体
  //   · note.capture-provider  MULTI  —— 「添加当前页面」旁边多出几个抓取源
  //   · note.export-format     MULTI  —— 集锦「导出」子菜单多出几种格式
  const slots = ports.slots ?? null
  const callSlot = (id: string, payload: unknown, fallback: unknown = null): unknown => {
    if (!slots || typeof slots.call !== 'function') return fallback
    try { return slots.call(id, payload, fallback) } catch (_) { return fallback }
  }
  const callSlotMulti = (id: string, payload: unknown): Record<string, unknown>[] => {
    if (!slots || typeof slots.callMulti !== 'function') return []
    try {
      const list = slots.callMulti(id, payload)
      return Array.isArray(list) ? list.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : []
    } catch (_) { return [] }
  }
  const captureProviders = (): CaptureProvider[] =>
    callSlotMulti('note.capture-provider', {}) as CaptureProvider[]

  /**
   * 渲染层缩略图缓存（path → dataURL | null）。
   *
   * 为什么在渲染层**再缓存一层**（主进程已有 LRU）：每次列表重绘（切分段 / 搜索 / 收录后
   * reload）都会对**同一批**图片卡重新发起 assetThumb IPC —— 面板重绘很频繁，这一层把
   * "同一张图反复过 IPC" 挡在渲染侧。主进程那侧缓存的是"读盘 + base64"，
   * 这一层省的是"往返"：两层各挡各的，不重复。
   */
  const thumbCache = new Map<string, string | null>()

  const wrap = doc.createElement('div')
  wrap.className = 'notes-panel'

  const toolbar = doc.createElement('div')
  toolbar.className = 'notes-panel__toolbar'
  const body = doc.createElement('div')
  body.className = 'notes-panel__body'
  // 批量栏：多选后从**底部**浮出的一条（已选 N + 动作）。常驻节点、只切显隐 ——
  // 每次重画都新建会让它一闪一闪，且会丢掉按钮上的键盘焦点。
  const batchBar = doc.createElement('div')
  batchBar.className = 'notes-panel__batchbar'
  wrap.append(toolbar, body, batchBar)

  // ── 关键路径耗时告警（可诊断"慢"）─────────────────────────
  //
  // 计时实现（perfStart / perfEnd）在 model —— 视图与模型共用一处，
  // 只有**超过阈值**才 console.warn 并带上"哪条路径 + 多少张卡 + 几毫秒"。
  // 这不是日志噪音：它是让用户 / 开发者能回报"卡"的具体数字的唯一出口。

  // ── 缩略图懒加载（IntersectionObserver）──────────────────
  //
  // 为什么懒加载：一屏卡片的缩略图若都在**同一帧**发起 IPC（读盘 → dataURL），
  // 长列表（几百张）会瞬间堆出几十条屏幕外的并发读取 —— 首屏因此又慢又抖。
  // 这里只对**进入视口（预取一屏）**的 <img> 发起真正的读取；`thumbCache` 仍然拦
  // "同一 path 重复过 IPC"（两条纪律各挡一层，不重复）。
  //
  // root = body（面板的滚动容器）：只有以它为根，视口判断才等于"用户看得见的那一块"。
  const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null)
  const THUMB_ROOT_MARGIN = '200px 0px' // 预取一屏：快滚时也不会先看到一片空白格
  const thumbTasks = new WeakMap<HTMLImageElement, { path: string; onFail?: () => void }>()
  const thumbObserver = (win && typeof win.IntersectionObserver === 'function')
    ? new win.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const img = entry.target
          if (!(img instanceof HTMLImageElement)) continue
          const task = thumbTasks.get(img)
          thumbObserver?.unobserve(img)
          thumbTasks.delete(img)
          if (task) fetchThumb(task.path, img, task.onFail)
        }
      }, { root: body, rootMargin: THUMB_ROOT_MARGIN })
    : null

  /** 记下"这张图一进视口就读这个 path"，交给观察器。 */
  function observeThumb(path: string, img: HTMLImageElement, onFail?: () => void): void {
    // 没有 IO（老环境）→ 直接读：不为了懒加载把图判成"读不到"。
    if (!thumbObserver) { fetchThumb(path, img, onFail); return }
    thumbTasks.set(img, { path, onFail })
    thumbObserver.observe(img)
  }

  /** 真正读一次缩略图（结果进 thumbCache）。 */
  function fetchThumb(p: string, img: HTMLImageElement, onFail?: () => void): void {
    Promise.resolve(model.assetThumb(p)).then((result) => {
      const value = result || null
      thumbCache.set(p, value)
      if (value) { if (img.isConnected) img.src = value }
      else if (onFail) onFail()
    }).catch(() => {
      thumbCache.set(p, null)
      if (onFail) onFail()
    })
  }

  /**
   * 重画前**必须**先清干净：断开缩略图观察器（旧节点即将移除）。
   * 断开的理由：观察器持有旧 img 引用，重画 N 次就积累 N 组待观察节点（内存与回调都在漏）。
   *
   * ⚠ **不要**在这里取消搜索防抖计时器：它承载的是"用户刚敲下、还没应用"的查询，
   *   重画（例如别处改了一条触发的）把它清掉，搜索框里明明有字、列表却还是旧结果 —— 那是 bug。
   *   该计时器只有一个槽位（不随重画累积），自然在"触发 / 下一次输入 / Esc"时收口。
   */
  function cleanupBeforeRedraw(): void {
    if (thumbObserver) thumbObserver.disconnect()
  }

  // ── 图标工具 ────────────────────────────────────────────
  function icon(name: string, size: number = 15): SVGElement {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.innerHTML = ICON_PATHS[name] || ''
    return svg
  }

  function button(name: string, title: string, onClick: (event: MouseEvent) => void, size: number = 15): HTMLButtonElement {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'notes-panel__icon-btn'
    btn.title = title
    btn.setAttribute('aria-label', title)
    btn.appendChild(icon(name, size))
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick(e)
    })
    return btn
  }

  function chip(label: string, onClick: (event: MouseEvent) => void, iconName?: string): HTMLButtonElement {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'notes-panel__chip'
    if (iconName) btn.appendChild(icon(iconName, 12))
    const span = doc.createElement('span')
    span.textContent = label
    btn.appendChild(span)
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
    return btn
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string | null,
    text?: unknown
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = String(text)
    return node
  }

  // 颜色：由**一个**颜色推出"亮 → 本色"的渐变，视觉上是个有体积的球（编辑器色板沿用），
  // 列表里则改画**左侧 2px 色条**（见 CSS）——同一份配色，呈现方式按列宽取舍。
  function lighten(hex: string, amount: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
    if (!m) return hex
    const n = parseInt(m[1], 16)
    const mix = (c: number): number => Math.round(c + (255 - c) * amount)
    return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`
  }
  /** @param {string|null} hex @returns {string} 空串 = 没有颜色（交给 CSS 画空心圈） */
  function ballGradient(hex: string|null) {
    if (!hex) return ''
    return `linear-gradient(135deg, ${lighten(hex, 0.42)}, ${hex})`
  }

  // ── 工具栏（只建一次）──────────────────────────────────
  // 结构对齐 history 面板：**第一行**分段选项卡，**第二行**搜索框 + 动作图标。
  // 搜索框永远独占一行（历史面板同款外壳：图标 + 圆角浅底 + focus-within 高亮）。
  let searchBox: HTMLDivElement | null = null
  let searchInput: HTMLInputElement | null = null
  // 搜索**防抖 + 竞态保护**：
  //   · 防抖：每个按键都重画整块列表，在几百张卡时会明显掉帧；150ms 后一次应用即可。
  //   · 竞态保护：`searchSeq` 单调递增，只有"最后一次输入"对应的那次应用才生效 ——
  //     今天是纯本地过滤（天然同步、无慢请求），这个序号是为"搜索以后若改走 IPC"预留的
  //     顺序保证（慢的旧结果绝不能覆盖新结果）。
  //   · "正在搜索"：只切 toolbar 上一个 class（那里 CSS 给搜索框一道高亮），
  //     **不**触发 render —— 否则每敲一个字都整块重画，既白屏又丢焦点。
  let searchSeq = 0
  let searchTimer: TimerHandle | null = null
  const SEARCH_DEBOUNCE_MS = 150
  const markSearching = (on: unknown): void => { toolbar.classList.toggle('is-searching', !!on) }

  /** 立即提交搜索词（取消防抖、作废挂起项）—— 内建输入与外壳下发共用这一条路径。 */
  function commitQuery(value: unknown): void {
    if (searchTimer != null) { clearTimeout(searchTimer); searchTimer = null }
    searchSeq++
    markSearching(false)
    model.setQuery(value)
  }

  searchBox = doc.createElement('div')
  searchBox.className = 'notes-panel__search'
  const searchIcon = icon('search', 12)
  searchIcon.classList.add('notes-panel__search-icon')
  searchInput = doc.createElement('input')
  searchInput.type = 'text'
  searchInput.className = 'notes-panel__search-input'
  searchInput.placeholder = '搜索卡片…'
  searchBox.append(searchIcon, searchInput)
  searchInput.addEventListener('input', () => {
    const value = searchInput.value
    const seq = ++searchSeq
    markSearching(true)
    if (searchTimer != null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTimer = null
      markSearching(false)
      if (seq !== searchSeq) return // 已有更新的输入 → 丢弃这次
      model.setQuery(value)
    }, SEARCH_DEBOUNCE_MS)
  })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = ''
      commitQuery('')
    }
  })

  /**
   * 执行一个 `note.capture-provider` 实现：它只产出「要收什么」（capture 请求体），
   * 落点由 model 决定。返回空 = 用户取消，静默收场。
   */
  async function runCaptureProvider(provider: CaptureProvider | undefined): Promise<void> {
    if (!provider || typeof provider.capture !== 'function') return
    try {
      const input = await provider.capture()
      if (input && typeof input === 'object') await model.captureInput(input as CaptureNoteInput)
    } catch (err: unknown) {
      toast(`收录失败：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  /**
   * 收录入口（工具栏 / 集锦动作行 / 空白菜单共用）。
   *
   * 没有 provider 时**与旧行为逐字一致**（直接收当前页面，不多一次弹菜单）；
   * 有 provider 才弹来源菜单：第一项仍是内建「当前页面」，其后是插件贡献的来源。
   */
  async function promptCapture(x: number, y: number): Promise<void> {
    const providers = captureProviders()
    if (!providers.length || !menu) { model.captureCurrentPage(); return }
    let action = null
    try {
      action = await menu.popupMenu({
        items: [
          { label: '当前页面', action: 'builtin' },
          { type: 'separator', action: null },
          ...providers.map((p, i) => ({ label: String(p.label || p.id), action: `provider:${i}` }))
        ],
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0
      })
    } catch (_) { action = null }
    if (typeof action !== 'string') return
    if (action === 'builtin') { model.captureCurrentPage(); return }
    const index = Number(action.slice('provider:'.length))
    if (!Number.isInteger(index)) return
    await runCaptureProvider(providers[index])
  }

  /** 把「按钮矩形」换成菜单坐标（工具栏图标按钮没有自己的坐标，菜单挂在它下沿）。 */
  function promptCaptureAt(target: Element | null): void {
    const rect = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null
    void promptCapture(rect ? rect.left : 0, rect ? rect.bottom + 2 : 0)
  }

  const captureBtn = button('linkPlus', '添加当前页面到集锦', (e) => { promptCaptureAt(e.currentTarget as Element | null) })
  const noteBtn = button('plus', '新建备注卡片', () => { model.createNoteCard() })
  const filterBtn = button('filter', '筛选卡片类型', (e) => { toggleFilterPop(e.currentTarget as Element | null) })
  const sortBtn = button('sort', '排序', (e) => { showSortMenu(e) })

  const viewSwitch = doc.createElement('div')
  viewSwitch.className = 'notes-panel__viewswitch'
  viewSwitch.setAttribute('role', 'tablist')
  const sectionBtns = NOTE_SECTIONS.map((sectionId) => {
    const label = (NOTE_SECTION_LABELS as Record<string, string>)[sectionId] || sectionId
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = 'notes-panel__tab'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', 'false')
    b.title = label
    b.dataset.section = sectionId
    b.appendChild(icon(SECTION_ICONS[sectionId] || 'layers', 12))
    b.appendChild(el('span', null, label))
    // 计数徽标：只有「回收站」用它显示 `folderCounts().__trash`（**绝不并进 __all/__unfiled**）。
    b.appendChild(el('span', 'notes-panel__tab-count'))
    b.addEventListener('click', () => model.setSection(sectionId))
    viewSwitch.appendChild(b)
    return b
  })

  // 第二行：搜索框**独占一行**（与历史 / 收藏 / 扩展面板同一口径）；
  // 动作图标另起一行 —— 搜索框因此在窄栏里也拿得到完整宽度。
  const actions = doc.createElement('div')
  actions.className = 'notes-panel__actions'
  actions.append(captureBtn, noteBtn, filterBtn, sortBtn)

  toolbar.append(viewSwitch, searchBox, actions)

  let editorKey: string | null = null
  let editor: EditorRefs | null = null
  let previewMode = false
  let renamingFolderId: string | null = null
  // 正在就地编辑「注释便签」的卡片 id（null = 无）。**渲染层局部状态**：注释只在卡片底部一条
  // 小横条里改，绝不把整张卡变成编辑器（与"非 note 卡单击不进编辑器"同一条铁律）。
  let editingNoteId: string | null = null
  // 键盘导航的**聚焦项**（与"多选 selected"、"跳转高亮 highlightId"是三个不同的东西）：
  // 用户是键盘手时 ↑↓ 移动的是它，Enter 对它是 primaryAction。视图局部状态，不进 model。
  let keyNavId: string | null = null

  function syncToolbar(): void {
    if (searchInput && doc.activeElement !== searchInput) searchInput.value = model.state.query
    const sort = NOTE_SORTS.find((s) => s.id === model.state.sort)
    sortBtn.title = `排序：${sort ? sort.label : '按修改时间'}`
    const section = model.state.section
    for (let i = 0; i < sectionBtns.length; i++) {
      const id = NOTE_SECTIONS[i]
      sectionBtns[i].setAttribute('aria-selected', id === section ? 'true' : 'false')
      const badge = sectionBtns[i].querySelector('.notes-panel__tab-count')
      if (badge) {
        const n = id === 'trash' ? model.trashCount() : 0
        badge.textContent = n ? String(n) : ''
      }
    }
    // 类型筛选在"没有卡片列表"的分段（回收站）没有意义 → 收起按钮，省一处会被误点的空操作。
    filterBtn.style.display = model.isTrashSection() || model.state.section === 'archive' ? 'none' : ''
    if (searchBox) searchBox.style.display = model.state.section === 'archive' ? 'none' : ''
    actions.style.display = model.state.section === 'archive' ? 'none' : ''
    const n = model.state.kindFilter.length
    filterBtn.classList.toggle('is-active', n > 0)
    filterBtn.title = n ? `已筛选 ${n} 种类型` : '筛选卡片类型'
  }

  let lastSection: string | null = null
  // 「长列表」是否已展开全部（见 buildCardList）。**视图局部状态**：换视图（分段/集锦/搜索词）时复位。
  let showAllCards = false
  // 上一次列表的"视图身份"（分段 + 集锦 + 模式 + 搜索词）—— 用来判断重画是"同一屏内容"还是"换了一屏"。
  let lastListViewKey: string | null = null

  /** 列表的"视图身份"：变它就换了一屏内容 —— 该滚回顶部并复位展开态。 */
  function listViewKey(): string {
    return [model.state.section, model.state.scopeFolderId || '', model.state.mode, model.state.query].join('|')
  }

  function render(): void {
    // 重画前**先清干净**（断开缩略图观察器 + 取消挂起的搜索计时器）：
    // body 里所有节点即将被丢弃，观察器若不断开会把旧 img 一直攒着（内存与回调都在漏）。
    cleanupBeforeRedraw()
    // 筛选下拉是"身体之外"的浮层：只在**切分段 / 进编辑器**时收起来，
    // 不随每次列表重绘关闭 —— 否则勾一种类型就被 render 关掉，根本勾不了第二种。
    if (model.state.section !== lastSection || model.state.mode === 'edit') closeFilterPop()
    // 切分段 / 进编辑器时收起注释便签的就地编辑：它锚在某张卡上，换了列表再挂着会"对不上"。
    // 键盘聚焦项同理 —— 换了列表就不该再指着一张旧卡。
    if (model.state.section !== lastSection || model.state.mode === 'edit') { editingNoteId = null; keyNavId = null }
    lastSection = model.state.section
    syncToolbar()
    if (model.state.mode === 'edit') renderEditor()
    else renderList()
    // 批量栏放在最后：它读的是 selection（model 状态），与列表/编辑器无关，
    // 但必须在 body 画完之后再渲染，才不会在重画中被 body.textContent='' 清掉。
    renderBatchBar()
  }

  // ── 列表 ────────────────────────────────────────────────

  function renderList(): void {
    editorKey = null
    editor = null
    const t0 = perfStart('重画列表')
    // 视图身份没变（例如"别处改了一条"触发的重画）→ 保住滚动位置（不打断正在看的那一屏）；
    // 变了（切分段 / 进集锦 / 改搜索词）→ 回到顶部并复位「显示全部」。
    const key = listViewKey()
    const sameView = key === lastListViewKey
    if (!sameView) showAllCards = false
    const prevScroll = sameView ? body.scrollTop : 0
    lastListViewKey = key

    body.textContent = ''

    if (model.state.error) {
      body.appendChild(emptyState(`笔记加载失败：${model.state.error}`))
      return
    }
    if (!model.state.loaded) {
      body.appendChild(emptyState('正在加载…'))
      return
    }
    if (model.state.section === 'archive') {
      if (!archiveView) {
        body.appendChild(emptyState('归档视图不可用'))
        return
      }
      body.appendChild(archiveView.element)
      void archiveView.refresh()
      return
    }

    // 整屏内容先建进 DocumentFragment，最后**一次** appendChild ——
    // 否则"每加一块就触发布局"，长列表时这一串同步布局是首屏卡顿的主要来源。
    const frag = doc.createDocumentFragment()
    if (model.isTrashSection()) {
      renderTrash(frag)
    } else {
      if (model.isCollectionsSection()) renderCollections(frag)
      else renderFlatList(frag)
      insertTagBar(frag)
    }
    const count = frag.querySelectorAll('.notes-panel__card').length
    body.appendChild(frag)

    if (sameView) body.scrollTop = prevScroll
    scrollToHighlight()
    // 列表已重画：把键盘聚焦态补回新节点上（找不到就丢弃 keyNavId）。
    applyKeyNav(false)
    perfEnd('重画列表', t0, count)
  }

  /**
   * 标签筛选条：插到标题块**之下**（在 fragment 上定位，逻辑与原实现一致）。
   * 放在标题条之下、列表之上 —— 标题条由各分段先画，但「全部 / 稍后读」没有标题条，
   * 所以要按"标题条存不存在"决定插在哪。
   */
  function insertTagBar(frag: DocumentFragment): void {
    const tagBar = buildTagBar()
    if (!tagBar) return
    // 卡片态/根态的标题是 `.notes-panel__headerblock`（标题行 + 主动作行一块）——标签条要插在
    // **整块之下**，不能插进标题行与动作行之间（那样会把标题块劈成两半）。
    const header = frag.querySelector('.notes-panel__headerblock') || frag.querySelector('.notes-panel__header')
    if (header && header.nextSibling) frag.insertBefore(tagBar, header.nextSibling)
    else if (header) frag.appendChild(tagBar)
    else frag.insertBefore(tagBar, frag.firstChild)
  }

  /**
   * 集锦分段：单栏两态。
   *   · 根 —— 标题 +「新建集锦」+ 集锦卡片墙 + 未归档卡片；
   *   · 进入某集锦 —— ‹ 返回 + 集锦名 + ⋯ + 子集锦 + 卡片列表。
   * 展开/折叠仍然保留：卡片墙里每个集锦左侧的三角可就地看它下面的子集锦（不再无限缩进）。
   */
  function renderCollections(parent: HTMLElement | DocumentFragment): void {
    const t0 = perfStart('重画集锦墙')
    const scope = model.state.scopeFolderId
    const inside = typeof scope === 'string'

    if (inside) {
      parent.appendChild(buildCollectionHeader(scope))
      const children = model.childFolders(scope)
      if (children.length) {
        const box = el('div', 'notes-panel__section')
        box.appendChild(renderCollectionItems(scope, 0, false))
        parent.appendChild(box)
      }
    } else {
      parent.appendChild(buildRootHeader())
      const tops = model.childFolders(null)
      if (tops.length) {
        const wall = el('div', 'notes-panel__wall')
        wall.appendChild(renderCollectionItems(null, 0, true))
        parent.appendChild(wall)
      }
    }
    perfEnd('重画集锦墙', t0, model.state.folders.length)

    const notes = model.visibleNotes()
    // 搜索 / 标签 / 类型筛选期间**强制展开**：折叠是"平时浏览时收起"，不是"搜到也不给看"。
    const filtered = !!(model.state.query || model.state.activeTags.length || model.state.kindFilter.length)
    const collapsed = !inside && model.unfiledCollapsed() && !filtered
    if (notes.length) {
      // 根态在集锦卡片墙之下还有一块「未归档」—— 给一行小标题标出它 + 条数，
      // 否则用户分不清下面这一堆卡片是"某个集锦里的"还是"没进集锦的"。
      // 小标题本身就是收起的开关：箭头随状态换向（收起 → 右，展开 → 下）。
      // 筛选态下分组恒定展开（搜到就该看得见），此时小标题是纯标签、不提供收起。
      if (!inside) {
        const label = filtered ? '未归档' : `未归档 · ${model.unfiledCount()}`
        parent.appendChild(filtered
          ? el('div', 'notes-panel__sectionlabel is-static', label)
          : buildUnfiledLabel(label, collapsed))
      }
      if (!collapsed) parent.appendChild(buildCardList(notes))
    } else if (!inside && !model.state.query && !model.state.activeTags.length && !model.state.kindFilter.length) {
      // 根视图的**空态主动作**：给两条能立刻走的路，而不是"空白 + 一排图标"。
      parent.appendChild(emptyState(
        model.childFolders(null).length
          ? '还没有卡片。点上方「+ 添加当前页面」或「+ 笔记」。'
          // 根态收进来的东西落在**未归档**（不自动造目录，见 model#currentCaptureFolderId）
          : '还没有集锦。点「新建集锦」建一个，或直接「+ 添加当前页面」。'
      ))
    } else {
      parent.appendChild(emptyState(collectionEmptyMessage(inside)))
    }
  }

  /**
   * 「未归档」分组的小标题（兼收起开关）。
   * 箭头朝向与状态一致：**收起时朝右（chevronRight）、展开时朝下（chevronDown）**。
   */
  function buildUnfiledLabel(text: string, collapsed: boolean): HTMLButtonElement {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'notes-panel__sectionlabel'
    btn.setAttribute('aria-expanded', String(!collapsed))
    btn.title = collapsed ? '展开未归档' : '收起未归档'
    btn.appendChild(icon(collapsed ? 'chevronRight' : 'chevronDown', 12))
    btn.appendChild(el('span', null, text))
    btn.addEventListener('click', () => model.toggleUnfiled())
    return btn
  }

  function collectionEmptyMessage(inside: boolean): string {
    if (model.state.query) return `没有匹配「${model.state.query}」的卡片`
    if (model.state.activeTags.length) return `没有标签为 ${model.state.activeTags.map((t) => `#${t}`).join(' + ')} 的卡片`
    if (model.state.kindFilter.length) return `没有符合所选类型的卡片`
    if (inside) return '这里还没有卡片'
    return '还没有卡片'
  }

  /** 根标题：集锦 + 新建集锦。 */
  function buildRootHeader(): HTMLElement {
    const bar = el('div', 'notes-panel__header')
    bar.appendChild(el('div', 'notes-panel__title', '集锦'))
    bar.appendChild(chip('新建集锦', () => promptNewFolder(null), 'plus'))
    return bar
  }

  /**
   * 卡片态标题块（对齐 Edge 集锦的单栏两态）：
   *   第一行：`‹ 返回` + 集锦名 + `⋯`；
   *   第二行：主动作行 —— **「+ 添加当前页面」是集锦的主动作（视觉权重最高）**，
   *           「+ 笔记」次之（笔记是添花，不抢集锦的戏）。
   */
  function buildCollectionHeader(folderId: string | null): HTMLElement {
    const block = el('div', 'notes-panel__headerblock')
    const bar = el('div', 'notes-panel__header')

    const back = doc.createElement('button')
    back.type = 'button'
    back.className = 'notes-panel__chip'
    back.title = '返回上一层'
    back.appendChild(icon('arrowLeft', 13))
    back.appendChild(el('span', null, '返回'))
    back.addEventListener('click', () => model.goUp())
    bar.appendChild(back)

    const name = el('div', 'notes-panel__title', model.folderLabel(folderId))
    name.title = model.folderPath(folderId).join(' / ')
    bar.appendChild(name)

    const folder = model.state.folders.find((f) => f.id === folderId) ?? { id: folderId, name: '' }
    bar.appendChild(button('more', '集锦操作', (e) => showCollectionMenu(folder, e.clientX, e.clientY), 14))
    block.appendChild(bar)

    const actions = el('div', 'notes-panel__actions')
    actions.appendChild(actionButton('linkPlus', '添加当前页面', true, (e) => { promptCaptureAt(e.currentTarget as Element | null) }))
    actions.appendChild(actionButton('plus', '笔记', false, () => { model.createNoteCard() }))
    block.appendChild(actions)

    return block
  }

  /** 卡片态主动作行里的一个按钮（`is-primary` = 集锦的主动作，视觉权重更高）。 */
  function actionButton(
    iconName: string,
    label: string,
    primary: boolean,
    onClick: (event: MouseEvent) => void
  ): HTMLButtonElement {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'notes-panel__actionbtn' + (primary ? ' is-primary' : '')
    btn.appendChild(icon(iconName, 13))
    btn.appendChild(el('span', null, label))
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
    return btn
  }

  /**
   * 集锦卡片墙 / 子集锦列表。
   * @param {string|null} parentId
   * @param {number} depth
   * @param {boolean} asCard 顶层渲染成大卡片（有封面）；更深层是紧凑行
   */
  function renderCollectionItems(parentId: string|null, depth: number, asCard: boolean) {
    const frag = doc.createDocumentFragment()
    for (const folder of model.childFolders(parentId)) {
      frag.appendChild(collectionItem(folder, depth, asCard))
    }
    return frag
  }

  function collectionItem(folder: NoteFolder, depth: number, asCard: boolean): HTMLElement {
    const box = el('div', 'notes-panel__collection-box')
    box.appendChild(collectionRow(folder, depth, asCard))
    // 就地展开：只在 3 层以内铺开（更深时改为进入 + 面包屑，避免缩进吃掉半块面板宽）。
    if (depth < 3 && model.state.expanded.has(folder.id)) {
      box.appendChild(renderCollectionItems(folder.id, depth + 1, false))
    }
    return box
  }

  function collectionRow(folder: NoteFolder, depth: number, asCard: boolean): HTMLElement {
    const row = el('div', 'notes-panel__collection' + (asCard ? ' is-card' : ''))
    row.dataset.kind = 'folder'
    row.dataset.folderId = folder.id || ''
    row.draggable = true
    if (depth > 0) row.style.paddingLeft = `calc(${depth} * var(--notes-indent))`

    const hasChildren = model.hasChildFolders(folder.id)

    // 封面：由该集锦里**前几张有图的卡片**缩略图拼成（网页缩略图与图片卡都算）。
    // 一张图都没有才退成文件夹图标（"有图才有封面"）。同样的"先 append 再异步回填"纪律
    // （见 previewImageBox 的说明）：缓存命中且上次读失败时 loadThumb **同步**回调 onFail，
    // 那时图还没进文档，靠 `cover.isConnected` 判断回落。
    const cover = el('span', 'notes-panel__cover')
    const coverFallback = () => { cover.textContent = ''; cover.appendChild(icon('folder', asCard ? 20 : 16)) }
    const paths = model.folderCoverPaths(folder.id, 3)
    if (paths.length) {
      cover.classList.add('is-grid')
      for (const p of paths) {
        const img = doc.createElement('img')
        img.alt = ''
        cover.appendChild(img)
        loadThumb(p, img, () => {
          if (img.parentNode) img.parentNode.removeChild(img)
          // 全部图都读失败 → 退回文件夹图标（否则留一个空白的封面格）。
          // 判据只看"还有没有 img"，不看 isConnected —— cover 此刻可能还没进文档
          //（同步失败时），但 coverFallback 对脱离文档的节点同样成立。
          if (!cover.querySelector('img')) coverFallback()
        })
      }
    } else {
      coverFallback()
    }
    row.appendChild(cover)

    if (renamingFolderId === folder.id) {
      const input = doc.createElement('input')
      input.type = 'text'
      input.className = 'notes-panel__rename'
      input.value = folder.name
      const commit = () => {
        const next = input.value
        renamingFolderId = null
        if (next.trim() && next.trim() !== folder.name) model.renameFolder(folder.id, next)
        else render()
      }
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') { renamingFolderId = null; render() }
      })
      input.addEventListener('blur', commit)
      input.addEventListener('click', (e) => e.stopPropagation())
      row.appendChild(input)
      queueMicrotask(() => { input.focus(); input.select() })
      return row
    }

    const main = el('div', 'notes-panel__collection-main')
    main.appendChild(el('div', 'notes-panel__collection-name', folder.name))
    const count = model.folderCount(folder.id)
    const updated = model.folderUpdatedAt(folder.id)
    const metaBits = [`${count} 张`]
    if (updated) metaBits.push(`${formatDate(updated)} 更新`)
    main.appendChild(el('div', 'notes-panel__collection-meta', metaBits.join(' · ')))
    row.appendChild(main)

    // 展开 / 折叠键在**行尾**（只有真的有子集锦时才出现，叶子不再留一个隐形空槽）。
    // 放在行首的旧写法会让每个文件夹的封面/名字整体右移一格，看着就像"平白多了缩进"。
    if (hasChildren) {
      const twisty = doc.createElement('button')
      twisty.type = 'button'
      twisty.className = 'notes-panel__twisty'
      twisty.appendChild(icon(model.state.expanded.has(folder.id) ? 'chevronDown' : 'chevronRight', 13))
      twisty.title = model.state.expanded.has(folder.id) ? '折叠' : '展开'
      twisty.setAttribute('aria-label', twisty.title)
      twisty.addEventListener('click', (e) => { e.stopPropagation(); model.toggleExpand(folder.id) })
      row.appendChild(twisty)
    }

    row.addEventListener('click', () => model.openFolder(folder.id))
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showCollectionMenu(folder, e.clientX, e.clientY)
    })
    return row
  }

  /** 「全部 / 稍后读」两段的平铺卡片列表。 */
  function renderFlatList(parent: HTMLElement | DocumentFragment): void {
    const reading = model.isReadingSection()
    const notes = model.visibleNotes()
    if (!notes.length) {
      const searching = !!model.state.query
      const msg = searching
        ? `没有匹配「${model.state.query}」的卡片`
        : (model.state.activeTags.length
            ? `没有标签为 ${model.state.activeTags.map((t) => `#${t}`).join(' + ')} 的卡片`
            : (model.state.kindFilter.length
                ? '没有符合所选类型的卡片'
                : (reading
                    // 「稍后读」空态要给出**怎么往里加**，否则用户只知道是空的、不知道下一步做什么。
                    ? '「稍后读」还是空的。在标签上右键选择「添加到集锦 ▸ 稍后读」。'
                    : '还没有卡片')))
      parent.appendChild(emptyState(msg))
      return
    }
    parent.appendChild(buildCardList(notes))
  }

  /**
   * 卡片列表容器 + 统一的 renderCard 出口。
   *
   * **长列表保护**：超过 NOTES_LIST_RENDER_LIMIT 张时**先渲染前 N 张** + 一个「显示全部」按钮，
   * 避免一次性建几千个 DOM（每张卡还各挂若干监听）把首屏拖垮。
   * 阈值与理由见 shared-types#NOTES_LIST_RENDER_LIMIT。
   */
  function buildCardList(notes: Note[]): HTMLElement {
    const list = el('div', 'notes-panel__list')
    const frag = doc.createDocumentFragment()
    const total = notes.length
    const limit = showAllCards ? total : Math.min(total, NOTES_LIST_RENDER_LIMIT)
    for (let i = 0; i < limit; i++) frag.appendChild(renderCard(notes[i]))
    if (limit < total) frag.appendChild(showAllRow(total - limit))
    list.appendChild(frag)
    return list
  }

  /** 长列表尾部的「显示全部（还有 N 张）」—— 点了才把剩余卡片一次性建出来。 */
  function showAllRow(remaining: number): HTMLElement {
    const box = el('div', 'notes-panel__more')
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'notes-panel__more-btn'
    btn.textContent = `显示全部（还有 ${remaining} 张）`
    btn.addEventListener('click', () => { showAllCards = true; render() })
    box.appendChild(btn)
    return box
  }

  /** 标签筛选条：列出全部标签，可多选（多选 = 交集）。没有标签时不渲染。 */
  function buildTagBar(): HTMLElement | null {
    const tags = model.allTags()
    if (!tags.length) return null
    const bar = el('div', 'notes-panel__tagbar')
    for (const tag of tags) {
      const active = model.state.activeTags.includes(tag)
      const chipEl = doc.createElement('button')
      chipEl.type = 'button'
      chipEl.className = 'notes-panel__tagchip' + (active ? ' is-active' : '')
      chipEl.textContent = `#${tag}`
      chipEl.title = active ? '取消该标签筛选' : `只看 #${tag}`
      chipEl.addEventListener('click', () => model.toggleTag(tag))
      bar.appendChild(chipEl)
    }
    return bar
  }

  function emptyState(text: string): HTMLElement {
    return el('div', 'notes-panel__empty', text)
  }

  // ── 卡片（四态的唯一出口，Edge 三段式骨架）─────────────
  //
  // 「卡片为什么是 预览 + 两行」（防回归，照 docs-new/9 §1.2/§1.3/§8.2 的 Edge 复刻）：
  //   · 第 1 段 = **预览区**（有则显示、无则整段不占位）——网页卡是页面缩略图、图片卡是图片本身、
  //     划词卡是摊开的摘录文字、备注卡是正文；引用卡没有预览。
  //   · 第 2 段 = **元信息两行**——第一行 `图标 + 标题`（网页卡图标位是 favicon），
  //     第二行是**域名缩写**（page/snippet/image 才有；备注卡显示相对时间）。
  //   · 第 3 段 = **注释便签**（可选的底部小横条，`📝 注释首行`）。
  // 上一轮把卡片做成"两行纯文字、没有预览区"是错的：那让网页卡认不出是哪一页、
  // 图片卡看不到图、划词卡看不到摘到的字 —— 集锦的价值恰恰在"卡片本身就是内容"。

  /**
   * 卡片行：**同一个出口**画四种 kind + 引用卡（三段式，见上）。
   * 颜色标记画成**左侧 2px 色条**（省宽度、纵向列表里更好扫），配色与旧色球完全一致。
   */
  function renderCard(note: Note): HTMLElement {
    const kind = normalizeKind(note.kind)
    // 引用卡**只有 chip 一档**：内联嵌入（把目标内容只读嵌进来）是**笔记应用**的思路，
    // 与集锦「记录 / 备忘 / 暂存」的定位不符，故移除（`ref_mode` 字段仍留在数据层，UI 不再读它）。
    const row = el('div', 'notes-panel__card')
    row.classList.add(`is-${kind}`)
    if (note.pinned) row.classList.add('is-pinned')
    if (model.state.highlightId === note.id) row.classList.add('is-highlight')
    if (model.isSelected(note.id)) row.classList.add('is-selected')
    // 键盘导航聚焦项（↑↓ 选中的那张）—— 视觉在 CSS 的 is-keynav。
    if (note.id === keyNavId) row.classList.add('is-keynav')
    row.dataset.kind = 'note'
    row.dataset.noteId = note.id
    row.dataset.folderId = note.folderId || ''
    row.draggable = true

    const bar = el('span', 'notes-panel__cardbar')
    if (note.color) bar.style.background = note.color
    row.appendChild(bar)

    // 第 1~3 段 = **默认主体**；`note.card-renderer` 返回元素时整块替换它。
    // 只换"内容呈现"，卡片外壳 / 动作位 / 点击与右键行为仍归宿主 —— 否则插件一挂上，
    // 多选、键盘导航、拖放这些整列共享的交互就全断了。
    const customBody = callSlot('note.card-renderer', { note, kind, folderId: note.folderId || null }, null)
    if (customBody instanceof Node) {
      row.appendChild(customBody)
    } else {
      // 第 1 段：预览区（无内容时不 append，整段不占位）。
      const preview = buildCardPreview(note, kind)
      if (preview) row.appendChild(preview)

      // 第 2 段：元信息两行。
      const bodyEl = el('div', 'notes-panel__card-body')
      const line1 = el('div', 'notes-panel__card-line1')
      line1.appendChild(renderLead(note, kind))
      line1.appendChild(el('span', 'notes-panel__card-title', displayTitle(note)))
      // 置顶图钉：**宽档才现身**（窄/标准档收进 ⋯ 菜单的「置顶 / 取消置顶」）—— 见 CSS 的宽档规则。
      if (note.pinned) {
        const pin = el('span', 'notes-panel__card-pin')
        pin.title = '已置顶'
        pin.appendChild(icon('pin', 12))
        line1.appendChild(pin)
      }
      bodyEl.appendChild(line1)
      // 行 2 = **只放域名**（没有内容就不 append，绝不留一条空行）。
      const meta = buildMeta(note, kind)
      if (meta) bodyEl.appendChild(meta)
      // 宽档专属补充行 = 日期 · 标签（窄/标准档整块 display:none，见 CSS —— 于是窄档不会多出空行）。
      const metaWide = buildMetaWide(note, kind)
      if (metaWide) bodyEl.appendChild(metaWide)
      row.appendChild(bodyEl)

      // 第 3 段：注释便签（page/image 才有；空则不显示）。
      const noteStrip = buildCardNoteStrip(note, kind)
      if (noteStrip) row.appendChild(noteStrip)
    }

    // 右上角动作位：`⋯` + 多选复选框（hover / 选中时才显形，平时不占视觉）。
    const actions = el('span', 'notes-panel__card-actions')
    actions.appendChild(cardMoreButton(note))
    actions.appendChild(selectCheckbox(note.id))
    row.appendChild(actions)

    // 单击 = 该 kind 的**主动作**（唯一真源在 model.primaryAction —— 见文件头不变量 4）。
    // 页面卡打开网页、图片卡看图、片段去来源/复制、引用卡跳目标、只有 note 卡进编辑。
    row.addEventListener('click', () => { void activateCard(note) })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showCardMenu(note, e.clientX, e.clientY)
    })
    return row
  }

  /**
   * 预览区（第 1 段）。四种 kind 各自的预览内容：
   *   page    → 页面缩略图（`thumbPath`，收录时异步抓的；没有则**不显示预览区**）
   *   image   → 图片本身（`thumbPath` 优先，退回 `assetPath`）
   *   snippet → `content` 里的摘录文字（浅底 + 左侧引用竖条，最多 5 行）
   *   note    → `content` 正文（最多 4 行）
   *   ref     → 无预览（引用卡只有 chip 一档）
   * @returns {HTMLElement|null}
   */
  function buildCardPreview(note: Note, kind: NoteKind): HTMLElement | null {
    if (kind === 'page') {
      if (!note.thumbPath) return null
      return previewImageBox(note.thumbPath)
    }
    if (kind === 'image') {
      const path = note.thumbPath || note.assetPath
      if (!path) return null
      return previewImageBox(path)
    }
    if (kind === 'snippet') {
      // ⚠ snippet 分支**只为老数据保留**：划词 / 纯文本入口现在都收成 note
      // （见 model#captureText 与主进程 captureSelectionIntoCollection），**不再产生新数据**。
      const text = plainTextSnippet(note.content, 320)
      if (!text) return null
      const box = el('div', 'notes-panel__card-preview is-quote')
      box.appendChild(el('div', 'notes-panel__preview-quote', text))
      return box
    }
    if (kind === 'note') {
      const text = plainTextSnippet(note.content, 400)
      if (!text) return null
      const box = el('div', 'notes-panel__card-preview is-note')
      box.appendChild(el('div', 'notes-panel__preview-text', text))
      return box
    }
    return null
  }

  /** 图片型预览：固定高度 + `object-fit: cover`；读不到图则整块移除（不留空框）。 */
  function previewImageBox(path: string): HTMLElement | null {
    const box = el('div', 'notes-panel__card-preview')
    const img = doc.createElement('img')
    img.className = 'notes-panel__preview-img'
    img.alt = ''
    // ⚠ **同步失败要当场判定、不要先 append 再等回调**：loadThumb 在"缓存命中但上次读失败"
    // 这条路径上是**同步**回调 onFail —— 那时 box 还没进文档，任何 `isConnected` 判断都会
    // 把它吞掉，卡片就留下一个**空预览框**（正是"网页卡空白"这类缺陷的成因）。
    // 因此：先试读，同步失败直接返回 null（整段不占位）；异步失败再由回调移除。
    // （未缓存的路径现在是**懒加载**：进视口才读 IPC，失败走异步 onFail —— 上面这条同步性
    //  只对"缓存命中且上次读失败"成立，行为与改懒加载前一致。）
    let failed = false
    const onFail = () => {
      failed = true
      if (box.parentNode) box.parentNode.removeChild(box)
    }
    loadThumb(path, img, onFail)
    if (failed) return null
    box.appendChild(img)
    return box
  }

  /**
   * 注释便签（第 3 段）。只有 page / image 卡有（见 model#setCardNote 的说明）：
   *   · 有注释 → 一条 `📝 首行…` 的小横条（点击就地编辑）；
   *   · 空 → 不显示（不留空条）；
   *   · 正在编辑 → 换成一个小输入区（**不是**整卡编辑器）。
   * @returns {HTMLElement|null}
   */
  function buildCardNoteStrip(note: Note, kind: NoteKind): HTMLElement | null {
    if (kind !== 'page' && kind !== 'image') return null
    if (editingNoteId === note.id) return buildCardNoteEditor(note)
    const text = String(note.content || '').replace(/\s+/g, ' ').trim()
    if (!text) return null
    const strip = el('div', 'notes-panel__card-note')
    strip.title = '点击编辑注释'
    strip.appendChild(el('span', 'notes-panel__card-note-icon', '📝'))
    strip.appendChild(el('span', 'notes-panel__card-note-text', text))
    strip.addEventListener('click', (e) => {
      e.stopPropagation()
      editingNoteId = note.id
      render()
    })
    return strip
  }

  /** 注释的**就地小输入区**：Enter 保存、Shift+Enter 换行、Esc 取消、失焦保存。 */
  function buildCardNoteEditor(note: Note): HTMLElement {
    const box = el('div', 'notes-panel__card-note is-editing')
    const input = doc.createElement('textarea')
    input.className = 'notes-panel__card-note-input'
    input.rows = 2
    input.placeholder = '给这张卡片写一条注释…'
    input.value = String(note.content || '')
    let done = false
    const commit = (save: boolean): void => {
      if (done) return
      done = true
      editingNoteId = null
      if (save) {
        const text = input.value.trim()
        if (text !== String(note.content || '')) model.setCardNote(note.id, text)
      }
      render()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') commit(false)
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(true) }
    })
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('blur', () => commit(true))
    box.addEventListener('click', (e) => e.stopPropagation())
    box.appendChild(input)
    queueMicrotask(() => { if (input.isConnected) input.focus() })
    return box
  }

  /** 卡片右上角的 `⋯`（打开该卡的上下文菜单，与右键同一份菜单）。 */
  function cardMoreButton(note: Note): HTMLButtonElement {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'notes-panel__card-more'
    btn.title = '更多操作'
    btn.setAttribute('aria-label', '更多操作')
    btn.appendChild(icon('more', 14))
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      showCardMenu(note, e.clientX, e.clientY)
    })
    return btn
  }

  /** 多选复选框：**点击即切换**（不需要按 Ctrl，与仓库既有的勾选约定一致）。 */
  function selectCheckbox(id: string): HTMLButtonElement {
    const box = doc.createElement('button')
    box.type = 'button'
    box.className = 'notes-panel__select'
    box.title = '选择'
    box.setAttribute('aria-label', '选择')
    if (model.isSelected(id)) {
      box.classList.add('is-on')
      box.appendChild(icon('check', 12))
    }
    box.addEventListener('click', (e) => { e.stopPropagation(); model.toggleSelect(id) })
    return box
  }

  /**
   * 预览里的引用 chip 点击 → 跳到目标所在集锦并高亮。
   * 事件委托在**容器**上（chip 是 innerHTML 拼出来的，逐个挂监听既不必要也容易漏）。
   * 复用的是反链那套 `model.revealNote`（切 collections 分段 + 进入目标层 + 高亮）。
   */
  function bindRefChipClicks(container: HTMLElement): void {
    container.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null
      const chip = target?.closest('[data-note-ref]') ?? null
      if (!chip) return
      e.preventDefault()
      e.stopPropagation()
      const id = chip.getAttribute('data-note-ref')
      if (id && model.getNote(id)) model.revealNote(id)
    })
  }

  /**
   * 卡片左侧的"身份位"（元信息第 1 行的 16px 图标）：网页卡 = favicon，其余 = 类型图标。
   * ⚠ 图片卡**不再**在这里放缩略图 —— 图片本身移到了卡片顶部的预览区（见 buildCardPreview）。
   * 这个图标位让四种卡片在同一列里"看起来是一家人"（见 docs-new/9 §6.5）。
   */
  function renderLead(note: Note, kind: NoteKind): HTMLElement {
    const lead = el('span', 'notes-panel__lead')
    if (kind === 'page') {
      const candidates = faviconSourceCandidates(note.url || '', null)
      if (!candidates.primary) { lead.appendChild(icon('globe', 16)); return lead }
      // 代理失败 → 直连兜底 → 再失败才退图标（三段式降级在 createFaviconImg 内部）。
      const img = createFaviconImg(doc, candidates, {
        size: 16,
        timeoutMs: 4000,
        borderRadius: 3,
        className: 'notes-panel__favicon',
        onFail: () => { lead.textContent = ''; lead.appendChild(icon('globe', 16)) }
      })
      lead.appendChild(img)
      return lead
    }
    lead.appendChild(icon(KIND_ICONS[kind] || 'sticky', 16))
    return lead
  }

  /**
   * 元信息**第二行**：**只放这一项信息 —— 来源**（有 url 的卡）/ 引用落点 / 无。
   *
   * 有 url 的卡（page / image / 划词来的 note）：渲染为**可点来源**（favicon + 域名），
   * 点它就是打开来源页；带 text fragment 的 url 会让浏览器滚到并高亮所选文字那段
   * （见 buildSourceLink / shared notes.mjs#buildTextFragmentUrl）。
   * 这就是"一眼读懂 + 一点即达"：第二行只此一项，不再把日期 / 标签 / ↩N 全塞进来（那会让每张卡都在抢注意力）。
   *
   * 唯一破例：搜索结果里额外标出"这条属于哪个集锦"（跨集锦时才出现，是必要信息）。
   * @returns {HTMLElement|null} 没有任何内容时返回 null（视图据此不 append，避免一条空行）
   */
  function buildMeta(note: Note, kind: NoteKind): HTMLElement | null {
    const meta = el('div', 'notes-panel__card-meta')
    /** 第二行的"来源"位：引用卡是落点文本，有 url 的卡是可点来源链接，其余无。 */
    let domainSlot = null

    if (kind === 'ref') {
      const target = model.refTarget(note)
      domainSlot = el('span', 'notes-panel__card-domain')
      if (target) {
        domainSlot.textContent = `→ ${model.folderLabel(target.folderId)}`
        domainSlot.title = displayTitle(target)
      } else {
        domainSlot.textContent = '已失效的引用'
        meta.classList.add('is-missing')
      }
    } else if (note.url) {
      domainSlot = buildSourceLink(note, kind)
    }

    if (domainSlot) meta.appendChild(domainSlot)

    // 搜索结果会跨集锦 —— 标出这条卡片属于哪个集锦（否则用户以为它就在当前层）。
    const loc = buildCardLocation(note)
    if (loc) {
      if (domainSlot && domainSlot.textContent) meta.appendChild(el('span', 'notes-panel__card-dot', '·'))
      meta.appendChild(loc)
    }
    return meta.childNodes.length ? meta : null
  }

  /**
   * 卡片第二行的**可点来源**：`favicon + 域名` 的一个链接。
   *
   * 点它 = 打开来源页（note.url）；若 url 带 text fragment，Chromium 会**直接滚到并高亮**
   * 所选文字那段 —— 这正是「点来源 → 跳回原文选中处」的实现（原生能力、零自绘高亮，
   * 见 shared notes.mjs#buildTextFragmentUrl：卡片 url 字段存的就是这种定位 URL）。
   *
   * ⚠ 必须 `stopPropagation`：第二行在卡片内部，不拦的话会顺带触发卡片的主动作
   *   （note 卡单击 = 进编辑器），那就成了"想跳来源却进了编辑器"。
   * @param {any} note
   * @param {string} kind 归一化后的卡片类型（决定要不要画来源 favicon）
   * @returns {HTMLAnchorElement}
   */
  function buildSourceLink(note: Note, kind: NoteKind): HTMLAnchorElement {
    const url = String(note.url || '')
    const isLocator = url.includes(TEXT_FRAGMENT_MARKER)
    const a = doc.createElement('a')
    a.className = 'notes-panel__card-source'
    a.href = url
    a.rel = 'noreferrer noopener'
    a.title = isLocator ? '跳到原文的选中位置' : '打开来源'
    // page 卡第一行的身份位**已经是**该站 favicon，第二行不再重复画一枚同款图标；
    // 用 is-no-favicon 补一段左内边距（= 13px 图标 + 4px gap），让它的域名仍与其它 kind 对齐。
    // 其余 kind（note/image/snippet/ref）第一行是类型图标，第二行的网站 favicon 是必要信息，照常画。
    if (kind === 'page') {
      a.classList.add('is-no-favicon')
    } else {
      // 来源站点 favicon（代理 → 直连 → 地球图标的三段式降级在 createFaviconImg 内部）。
      const candidates = faviconSourceCandidates(url, null)
      if (candidates.primary) {
        const img = createFaviconImg(doc, candidates, {
          size: 13,
          timeoutMs: 4000,
          borderRadius: 2,
          className: 'notes-panel__card-source-favicon',
          // 失败 → 换成地球图标（异步回调，此时 img 已就绪）。
          onFail: () => { if (img.parentNode) img.parentNode.replaceChild(icon('globe', 12), img) }
        })
        a.appendChild(img)
      } else {
        a.appendChild(icon('globe', 12))
      }
    }
    a.appendChild(el('span', 'notes-panel__card-domain', domainOf(url)))
    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openUrl(url)
    })
    return a
  }

  /**
   * 元信息**宽档专属的补充行**：日期 · 标签（图片卡再带上尺寸）。
   *
   * 为什么单独一条、且默认 `display:none`：面板窄，这些都不是"一眼要的信息"，
   * 只在容器 >420px 时才显示；窄/标准档收进 ⋯ 菜单（图钉→「置顶」、引用→「被引用 N 次…」）。
   * 关键收益：**没有域名的备注卡在窄档不会有这一行** —— display:none 的元素不是 flex 项、
   * 不吃 body 的 gap，卡片高度因此干净齐整。
   * @returns {HTMLElement}
   */
  function buildMetaWide(note: Note, kind: NoteKind): HTMLElement {
    const meta = el('div', 'notes-panel__card-meta notes-panel__card-meta--wide')
    let first = true
    const sep = () => { if (!first) meta.appendChild(el('span', 'notes-panel__card-dot', '·')); first = false }
    if (kind === 'image') {
      const w = Number(note.assetWidth || 0)
      const h = Number(note.assetHeight || 0)
      if (w && h) { meta.appendChild(el('span', 'notes-panel__card-date', `${w}×${h}`)); first = false }
    }
    sep()
    meta.appendChild(el('span', 'notes-panel__card-date', formatDate(note.modifiedAt)))
    // 标签：最多 4 个 + 一个 "+N"（宽档才显示整块，见 CSS）。
    const tags = (Array.isArray(note.tags) ? note.tags : []).map((t) => String(t)).filter(Boolean)
    if (tags.length) {
      const tagBox = el('span', 'notes-panel__card-tags')
      for (const t of tags.slice(0, 4)) tagBox.appendChild(el('span', 'notes-panel__notetag', `#${t}`))
      if (tags.length > 4) tagBox.appendChild(el('span', 'notes-panel__notetag is-more', `+${tags.length - 4}`))
      meta.appendChild(tagBox)
    }
    return meta
  }

  /** 搜索结果跨集锦 —— 标出这条卡片属于哪个集锦（否则用户以为它就在当前层）。 */
  function buildCardLocation(note: Note): HTMLElement | null {
    if (!model.state.query || !note.folderId) return null
    const loc = el('span', 'notes-panel__noteloc', model.folderLabel(note.folderId))
    loc.title = model.folderPath(note.folderId).join(' / ')
    return loc
  }
  // ── 回收站 ──────────────────────────────────────────────

  function renderTrash(parent: HTMLElement | DocumentFragment): void {
    const items = model.trashItems()
    const bar = el('div', 'notes-panel__header')
    bar.appendChild(el('div', 'notes-panel__title', '回收站'))
    bar.appendChild(el('div', 'notes-panel__header-spacer'))
    if (items.length) {
      bar.appendChild(chip('清空回收站', async () => {
        const ok = await confirm({
          title: '清空回收站',
          message: `确定彻底删除回收站里的 ${items.length} 张卡片？此操作不可恢复。`,
          danger: true,
          confirmLabel: '清空'
        })
        if (ok) model.emptyTrash()
      }))
    }
    parent.appendChild(bar)

    if (!items.length) {
      parent.appendChild(emptyState('回收站是空的 —— 删除的卡片会先放这里，可以恢复'))
      return
    }
    const list = el('div', 'notes-panel__list')
    const frag = doc.createDocumentFragment()
    for (const note of items) {
      const row = el('div', 'notes-panel__card is-trash')
      row.appendChild(el('span', 'notes-panel__cardbar'))
      // 回收站行是**紧凑一行**（图标 + 标题 + 删除时间 + 动作），不是三段式卡片 ——
      // 用 `.is-row` 让 body 内层恢复横向排列（`__card-body` 默认是纵向两行）。
      const bodyEl = el('div', 'notes-panel__card-body is-row')
      const lead = el('span', 'notes-panel__lead')
      lead.appendChild(icon(KIND_ICONS[normalizeKind(note.kind)] || 'sticky', 16))
      bodyEl.appendChild(lead)
      const main = el('div', 'notes-panel__trash-main')
      main.appendChild(el('div', 'notes-panel__card-line1', displayTitle(note)))
      main.appendChild(el('div', 'notes-panel__card-meta', `删除于 ${formatDate(note.deletedAt)}`))
      bodyEl.appendChild(main)

      // 动作按钮放**同一行**（bodyEl 是 is-row 横向排列）—— `.notes-panel__card` 现在是纵向
      // 三段式容器，若把动作挂在卡片根上，它会掉到 body 下面独占一行（回收站行是紧凑一行）。
      const actions = el('span', 'notes-panel__trash-actions')
      actions.appendChild(button('restore', '恢复', (e) => { e.stopPropagation(); model.restoreNote(note.id) }, 14))
      actions.appendChild(button('trash', '彻底删除', async (e) => {
        e.stopPropagation()
        const ok = await confirm({
          title: '彻底删除',
          message: `确定彻底删除「${displayTitle(note)}」？此操作不可恢复。`,
          danger: true,
          confirmLabel: '删除'
        })
        if (ok) model.purgeNote(note.id)
      }, 14))
      bodyEl.appendChild(actions)
      row.appendChild(bodyEl)
      frag.appendChild(row)
    }
    list.appendChild(frag)
    parent.appendChild(list)
  }

  // ── 编辑器 ──────────────────────────────────────────────

  function renderEditor(): void {
    const note = model.getActiveNote()
    if (!note) {
      model.backToList()
      return
    }
    if (editorKey !== note.id) {
      body.textContent = ''
      editor = buildEditor(note)
      editorKey = note.id
      body.appendChild(editor.root)
    }
    syncEditor(note)
  }

  function buildEditor(note: Note): EditorRefs {
    const root = el('div', 'notes-panel__editor')
    root.classList.add(`is-${normalizeKind(note.kind)}`)

    // 头部：返回（与集锦的 `‹ 返回` 同级、同一样式）+ 类型标签 + 标题 + 置顶 + 预览(仅 note) + 复制 + ⋯。
    const head = el('div', 'notes-panel__editor-head')
    const backBtn = doc.createElement('button')
    backBtn.type = 'button'
    backBtn.className = 'notes-panel__chip'
    backBtn.title = '返回列表'
    backBtn.appendChild(icon('arrowLeft', 13))
    backBtn.appendChild(el('span', null, '返回'))
    backBtn.addEventListener('click', () => model.backToList())
    const kindTag = el('span', 'notes-panel__kindtag', KIND_LABELS[normalizeKind(note.kind)] || '笔记')

    const titleInput = doc.createElement('input')
    titleInput.type = 'text'
    titleInput.className = 'notes-panel__editor-title'
    titleInput.placeholder = '标题'
    titleInput.addEventListener('input', () => model.updateActive({ title: titleInput.value }))
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') titleInput.blur()
      if (e.key === 'Enter') { e.preventDefault(); (textarea || titleInput).focus() }
    })

    const pinBtn = button('pin', '置顶', () => {
      const cur = model.getActiveNote()
      if (cur) model.togglePin(cur.id)
    }, 14)
    // Markdown 预览**只对 note 卡存在**：非 note 卡（页面/图片/片段/引用）点开是"取用"，
    // 编辑器只是它们"改标题 / 改描述"的次要入口，不该在它们身上再摆一个预览开关。
    const mdBtn = normalizeKind(note.kind) === 'note'
      ? button('markdown', 'Markdown 预览', () => {
          previewMode = !previewMode
          const current = model.getActiveNote()
          if (current) syncEditor(current)
        }, 14)
      : null
    // 「跳到原文」：note 卡且带来源 url 时才有。点开来源页；url 带 text fragment 时浏览器
    // 会滚到并高亮所选文字那段 —— 与卡片第二行的来源链接同一行为（文案按有没有定位而变）。
    const jumpBtn = normalizeKind(note.kind) === 'note' && note.url
      ? button('arrowRight',
          String(note.url).includes(TEXT_FRAGMENT_MARKER) ? '跳到原文' : '打开来源',
          () => {
            const cur = model.getActiveNote()
            if (cur && cur.url) openUrl(cur.url)
          }, 14)
      : null
    const copyBtn = button('copy', '复制正文', async () => {
      const cur = model.getActiveNote()
      if (!cur) return
      try { await navigator.clipboard.writeText(cur.content || '') } catch (_) {}
    }, 14)
    const moreBtn = button('more', '更多', (e) => {
      const cur = model.getActiveNote()
      if (cur) showCardMenu(cur, e.clientX, e.clientY)
    }, 14)

    head.append(backBtn, kindTag, titleInput, pinBtn)
    if (mdBtn) head.appendChild(mdBtn)
    if (jumpBtn) head.appendChild(jumpBtn)
    head.append(copyBtn, moreBtn)

    const textarea = doc.createElement('textarea')
    textarea.className = 'notes-panel__editor-content'
    // 占位语按类型给：图片卡写"描述"、片段卡是原文、note 是可 Markdown 的正文、其余是描述/备注。
    // `@` 内联引用补全已移除（属于"长文笔记应用"的写法，与集锦的暂存定位不符）——
    // 正文里要引用别的卡，走卡片 `⋯ → 复制引用 / 在此处插入引用` 两个轻量入口。
    const kindNow = normalizeKind(note.kind)
    textarea.placeholder = kindNow === 'snippet'
      ? '片段原文（可直接编辑）'
      : (kindNow === 'image'
          ? '图片描述（可选）'
          : (kindNow === 'note' ? '开始记录…（支持 Markdown）' : '描述 / 备注（可选）'))
    textarea.spellcheck = false
    textarea.addEventListener('input', () => model.updateActive({ content: textarea.value }))
    // 正文粘贴图片：图字节落成资产文件，在光标处插入一行 Markdown 图片引用
    // （`hira-asset:<相对路径>`，**绝不把 dataURL 写进正文** —— 见 model#saveNoteImage）。
    // 只对 note 卡开：片段卡正文是摘录原文、图片卡正文是描述，往那里塞图片引用没有语义。
    // 普通文本粘贴不拦截（不 preventDefault），交给浏览器默认行为。
    if (kindNow === 'note') {
      textarea.addEventListener('paste', (e) => {
        const file = findImageFile(e.clipboardData)
        if (!file) return
        e.preventDefault()
        // 面板整块也监听 paste（会把图收成一张图片卡）；编辑器已接管这张图，别再冒泡。
        e.stopPropagation()
        fileToDataUrl(file).then(async (dataUrl) => {
          if (!dataUrl) return
          const saved = await model.saveNoteImage(dataUrl)
          if (!saved) { toast('图片保存失败（可能过大或格式不支持）'); return }
          insertAtCaret(textarea, `![图片](${saved.uri})`)
          refreshPreview()
        }).catch(() => {})
      })
    }

    const preview = el('div', 'notes-panel__preview notes-panel__md')
    // 预览里的 `hira-note://<id>` 渲染成可点 chip（点击 = 跳到目标集锦并高亮）。
    bindRefChipClicks(preview)

    // 图片卡：正文之上先给一块**大缩略图 + 打开原图**（图片卡的"内容"就是这张图本身）。
    // 只在 kind==='image' 时建（卡片类型不可改，所以按 kind 一次性决定是安全的）。
    let imageBlock: HTMLDivElement | null = null
    let imageThumb: HTMLImageElement | null = null
    let imageOpenBtn: HTMLButtonElement | null = null
    let imageNote: HTMLSpanElement | null = null
    if (normalizeKind(note.kind) === 'image') {
      imageBlock = el('div', 'notes-panel__editor-image')
      imageThumb = doc.createElement('img')
      imageThumb.className = 'notes-panel__editor-thumb'
      imageThumb.alt = ''
      imageOpenBtn = doc.createElement('button')
      imageOpenBtn.type = 'button'
      imageOpenBtn.className = 'notes-panel__linkbtn'
      imageOpenBtn.textContent = '打开原图'
      imageOpenBtn.addEventListener('click', () => {
        const cur = model.getActiveNote()
        if (cur && cur.assetPath) model.assetOpen(cur.assetPath)
      })
      // assetPath 为空 = oversize 降级 / 原图缺失 → 只有缩略图，得明确告诉用户。
      imageNote = el('span', 'notes-panel__editor-image-note', '仅缩略图（原图过大未保存）')
      const imageActions = el('div', 'notes-panel__editor-image-actions')
      imageActions.append(imageOpenBtn, imageNote)
      imageBlock.append(imageThumb, imageActions)
    }

    const foot = el('div', 'notes-panel__editor-foot')

    const dots = el('div', 'notes-panel__dots')
    const dotEls = new Map<string, HTMLButtonElement>()
    const noneDot = doc.createElement('button')
    noneDot.type = 'button'
    noneDot.className = 'notes-panel__dot-btn is-none'
    noneDot.title = '无颜色'
    noneDot.addEventListener('click', () => model.setColor(note.id, null))
    dots.appendChild(noneDot)
    dotEls.set('', noneDot)
    for (const hex of NOTE_COLORS) {
      const b = doc.createElement('button')
      b.type = 'button'
      b.className = 'notes-panel__dot-btn'
      b.style.background = ballGradient(hex)
      b.title = COLOR_NAMES[hex] || hex
      b.addEventListener('click', () => model.setColor(note.id, hex))
      dots.appendChild(b)
      dotEls.set(hex, b)
    }

    // 标签输入：与书签编辑器同一套约定（逗号分隔，change 时提交）——
    // 面板窄，用内联输入而不是"标签编辑弹窗"。
    const tagsInput = doc.createElement('input')
    tagsInput.type = 'text'
    tagsInput.className = 'notes-panel__tags-input'
    tagsInput.placeholder = '标签，逗号分隔（如 工作, 灵感）'
    tagsInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); tagsInput.blur() }
    })
    tagsInput.addEventListener('change', () => {
      model.setNoteTags(note.id, tagsInput.value.split(/[,，]/))
    })

    const folderSelect = doc.createElement('select')
    folderSelect.className = 'notes-panel__folder-select'
    folderSelect.title = '移动到集锦'
    folderSelect.addEventListener('change', () => {
      const value = folderSelect.value
      model.moveNote(note.id, value || null)
    })

    const meta = el('div', 'notes-panel__editor-meta')

    foot.append(dots, folderSelect, meta)
    // 编辑器只留「标题 / 正文 / 标签 / 颜色 /（图片卡另有大图与「打开原图」）」——
    // 反链**不再常驻页脚**（改到卡片 `⋯ → 被引用 N 次…` 按需展开，见 showCardMenu）。
    const nodes = imageBlock
      ? [head, imageBlock, textarea, preview, tagsInput, foot]
      : [head, textarea, preview, tagsInput, foot]
    root.append(...nodes)

    return { root, titleInput, textarea, preview, tagsInput, pinBtn, mdBtn, folderSelect, meta, dotEls, imageThumb, imageOpenBtn, imageNote }
  }

  function syncEditor(note: Note): void {
    if (!editor) return
    if (!editor || !note) return
    if (doc.activeElement !== editor.titleInput) editor.titleInput.value = note.title || ''
    if (doc.activeElement !== editor.textarea) editor.textarea.value = note.content || ''
    if (doc.activeElement !== editor.tagsInput) {
      editor.tagsInput.value = Array.isArray(note.tags) ? note.tags.join(', ') : ''
    }

    editor.pinBtn.classList.toggle('is-active', !!note.pinned)
    // Markdown 预览只对 note 卡存在（非 note 卡的编辑器里根本没有这个按钮，见 buildEditor）。
    const previewOn = !!editor.mdBtn && previewMode
    if (editor.mdBtn) editor.mdBtn.classList.toggle('is-active', previewOn)
    editor.root.classList.toggle('is-preview', previewOn)
    if (previewOn) refreshPreview()

    for (const [hex, node] of editor.dotEls) {
      node.classList.toggle('is-active', (note.color || '') === hex)
    }

    // 文件夹下拉：每次重建选项（集锦可增删），但保持当前值
    const options = model.flatFolderOptions()
    const current = note.folderId || ''
    editor.folderSelect.textContent = ''
    for (const opt of options) {
      const o = doc.createElement('option')
      o.value = opt.id || ''
      o.textContent = `${'\u00a0\u00a0'.repeat(opt.depth)}${opt.label}`
      editor.folderSelect.appendChild(o)
    }
    editor.folderSelect.value = current
    if (editor.folderSelect.value !== current) editor.folderSelect.value = ''

    editor.meta.textContent = ''
    const when = el('span', null, `修改于 ${formatDateTime(note.modifiedAt)}`)
    editor.meta.appendChild(when)
    if (note.url) {
      editor.meta.appendChild(el('span', null, ' · '))
      const link = doc.createElement('a')
      link.href = note.url
      link.rel = 'noreferrer noopener'
      link.textContent = domainOf(note.url)
      link.title = note.url
      link.addEventListener('click', (e) => { e.preventDefault(); openUrl(note.url) })
      editor.meta.appendChild(link)
    }
    // 引用卡：正文之上再给一行「引用自」，否则用户看不出这张卡指向谁。
    if (normalizeKind(note.kind) === 'ref') {
      const target = model.refTarget(note)
      editor.meta.appendChild(el('span', null, ' · '))
      editor.meta.appendChild(el('span', 'notes-panel__ref-target',
        target ? `引用：${displayTitle(target)}` : '已失效的引用'))
    }

    // 图片卡的缩略图 + 「打开原图」/「仅缩略图」提示（见 buildEditor 的说明）。
    if (editor.imageThumb) {
      const path = note.thumbPath || note.assetPath
      if (path) {
        editor.imageThumb.style.display = ''
        // lazy:false —— 编辑器里的大图是"点开就要看到"，不走视口懒加载。
        const thumb = editor.imageThumb
        loadThumb(path, thumb, () => { thumb.style.display = 'none' }, { lazy: false })
      } else {
        editor.imageThumb.style.display = 'none'
      }
      const hasOriginal = !!note.assetPath
      if (editor.imageOpenBtn) editor.imageOpenBtn.style.display = hasOriginal ? '' : 'none'
      if (editor.imageNote) editor.imageNote.style.display = hasOriginal ? 'none' : ''
    }
  }

  // ── 菜单 ────────────────────────────────────────────────

  function colorSubmenu(): Array<{ label: string; action: string }> {
    const items: Array<{ label: string; action: string }> = [{ label: '无', action: 'color:' }]
    for (const hex of NOTE_COLORS) items.push({ label: COLOR_NAMES[hex] || hex, action: `color:${hex}` })
    return items
  }

  function buildMoveSubmenu(): Array<{ label: string; action: string }> {
    return model.flatFolderOptions().map((opt) => ({
      label: `${'\u00a0\u00a0'.repeat(opt.depth)}${opt.label}`,
      action: `move:${opt.id || ''}`
    }))
  }

  /**
   * 卡片 `⋯` / 右键菜单（按 kind 增删项，但仍是同一个弹出器）。
   *
   * 「编辑」对非 note 卡是**次要动作**：它们单击是"取用"（打开网页 / 看图 / 去来源 / 跳目标），
   * 想改标题与描述才走这里，所以文案明确写成「编辑标题与描述」。
   * 反链（被引用 N 次）也从编辑器页脚搬到了这里：点开才列出，不常驻占版面。
   */
  async function showCardMenu(note: Note, x: number, y: number): Promise<void> {
    if (!menu) return
    const kind = normalizeKind(note.kind)
    const refs = model.refCount(note.id)
    // 「添加注释 / 编辑注释」只给 page / image 卡：它们的 `content` 语义就是"这条记录的注释"
    // （见 model#setCardNote）。snippet 的 content 是摘录原文、note 卡本身就是笔记，都不适用。
    const canAnnotate = kind === 'page' || kind === 'image'
    const hasAnnotation = String(note.content || '').trim().length > 0
    const items = [
      { label: kind === 'note' ? '编辑' : '编辑标题与描述', action: 'edit' },
      ...(canAnnotate ? [{ label: hasAnnotation ? '编辑注释' : '添加注释', action: 'annotate' }] : []),
      { label: note.pinned ? '取消置顶' : '置顶', action: 'pin' },
      ...(refs > 0 ? [{ label: `被引用 ${refs} 次…`, action: 'refs' }] : []),
      { type: 'separator', action: null },
      { label: '复制正文', action: 'copy' },
      { label: '复制引用', action: 'copy-ref' },
      { label: '在此处插入引用', action: 'insert-ref' },
      ...(note.url ? [{ label: '打开来源', action: 'open-url' }, { label: '复制链接', action: 'copy-url' }] : []),
      { label: '移动到', type: 'submenu', submenu: buildMoveSubmenu() },
      { label: '颜色', type: 'submenu', submenu: colorSubmenu() },
      { type: 'separator', action: null },
      { label: '删除', action: 'delete' }
    ]
    let action = null
    try {
      action = await menu.popupMenu({
        items, x, y,
        // 只上报种类与快照：插件贡献的项由主进程按 note.context-menu 插槽追加。
        // `url/title` 是页面类卡片（page / image / snippet）的"这一条指向哪"，
        // 语言无关的插件（如 AI 菜单）只认这两个字段，不必认识集锦的数据模型。
        context: {
          kind: 'note',
          snapshot: {
            scope: 'card',
            noteId: note.id,
            folderId: note.folderId || null,
            noteKind: kind,
            url: note.url || '',
            title: displayTitle(note)
          }
        }
      })
    } catch (_) { action = null }
    const actionId = typeof action === 'string' ? action : ''
    if (!actionId) return
    if (actionId === 'edit') model.openNote(note.id)
    // 注释是**卡片底部一条小横条**里改的（就地小输入区），绝不打开整卡编辑器 ——
    // 与"非 note 卡单击绝不进编辑器"同一条铁律（见文件头）。
    else if (actionId === 'annotate') { editingNoteId = note.id; render() }
    else if (actionId === 'pin') model.togglePin(note.id)
    else if (actionId === 'refs') showBacklinksMenu(note, x, y)
    else if (actionId === 'copy') { try { await navigator.clipboard.writeText(note.content || '') } catch (_) {} }
    else if (actionId === 'copy-ref') { try { await navigator.clipboard.writeText(model.refLink(note.id)) } catch (_) {} }
    else if (actionId === 'insert-ref') model.insertRefCard(note)
    else if (actionId === 'open-url' && note.url) openUrl(note.url)
    else if (actionId === 'copy-url' && note.url) { try { await navigator.clipboard.writeText(note.url) } catch (_) {} }
    else if (actionId.startsWith('color:')) model.setColor(note.id, actionId.slice('color:'.length) || null)
    else if (actionId.startsWith('move:')) model.moveNote(note.id, actionId.slice('move:'.length) || null)
    else if (actionId === 'delete') {
      const ok = await confirm({
        title: '删除卡片',
        message: `确定删除「${displayTitle(note)}」？它会先进回收站，可以恢复。`,
        danger: true,
        confirmLabel: '删除'
      })
      if (ok) model.deleteNote(note.id)
    }
  }

  /**
   * 集锦菜单（标题栏 ⋯ 与集锦右键共用一份）—— 经典集锦的四个集锦级动作都在这里。
   * 「导出」是子菜单：内建 Markdown / HTML / JSON + 插件经 `note.export-format` 贡献的格式。
   * 序列化在 model 的纯函数（或插件实现）里，落盘走主进程 `note:export-file`（弹原生保存框）。
   */
  async function showCollectionMenu(folder: NoteFolder | { id: string | null; name: string }, x: number, y: number): Promise<void> {
    if (!menu) return
    const providers = callSlotMulti('note.export-format', {
      scope: 'collection',
      folderId: folder.id,
      folderName: folder.name
    }).filter((f) => !!f.id && typeof f.serialize === 'function') as unknown as ExportProvider[]
    const exportSubmenu = [
      ...NOTE_EXPORT_FORMATS.map((fmt) => ({
        label: (NOTE_EXPORT_FORMAT_LABELS as Record<string, string>)[fmt] || fmt,
        action: `export:${fmt}`
      })),
      ...(providers.length ? [{ type: 'separator', action: null }] : []),
      ...providers.map((f) => ({
        label: String(f.label || f.id),
        action: `export-plugin:${f.id}`
      }))
    ]
    const items = [
      { label: '全部打开', action: 'open-all' },
      { label: '复制全部', action: 'copy-all' },
      { label: '复制为 Markdown', action: 'copy-md' },
      { label: '导出', type: 'submenu', submenu: exportSubmenu },
      { type: 'separator', action: null },
      { label: '在此新建备注', action: 'new-note' },
      { label: '新建子集锦', action: 'new-subfolder' },
      { type: 'separator', action: null },
      { label: '重命名', action: 'rename' },
      { label: '删除', action: 'delete' }
    ]
    let action = null
    try {
      action = await menu.popupMenu({
        items, x, y,
        context: { kind: 'note', snapshot: { scope: 'collection', folderId: folder.id, folderName: folder.name } }
      })
    } catch (_) { action = null }
    const actionId = typeof action === 'string' ? action : ''
    if (!actionId) return
    if (actionId === 'open-all') model.openAllInCollection(folder.id)
    else if (actionId === 'copy-all') { try { await navigator.clipboard.writeText(model.collectionPlainText(folder.id)) } catch (_) {} }
    else if (actionId === 'copy-md') { try { await navigator.clipboard.writeText(model.collectionMarkdown(folder.id)) } catch (_) {} }
    else if (actionId.startsWith('export:')) { model.exportCollection(folder.id, actionId.slice('export:'.length)).catch(() => {}) }
    else if (actionId.startsWith('export-plugin:')) {
      const id = actionId.slice('export-plugin:'.length)
      const provider = providers.find((f) => String(f.id) === id)
      if (provider) {
        model.exportCollection(folder.id, String(provider.extension || provider.id || ''), {
          extension: provider.extension == null ? undefined : String(provider.extension),
          serialize: provider.serialize,
          encoding: provider.encoding
        }).catch(() => {})
      }
    }
    else if (actionId === 'new-note') model.createNote({ folderId: folder.id, kind: 'note' })
    else if (actionId === 'new-subfolder') promptNewFolder(folder.id)
    else if (actionId === 'rename' && folder.id) { renamingFolderId = folder.id; render() }
    else if (actionId === 'delete' && folder.id) {
      const ok = await confirm({
        title: '删除集锦',
        message: `确定删除「${folder.name}」？其中的卡片会移回「未归档」，不会被删除。`,
        danger: true,
        confirmLabel: '删除'
      })
      if (ok) model.deleteFolder(folder.id)
    }
  }

  /** 反链列表（卡片 `⋯ → 被引用 N 次…`）—— chip 形式，点即跳到来源卡所在集锦并高亮。 */
  async function showBacklinksMenu(note: Note, x: number, y: number): Promise<void> {
    if (!menu) return
    let list: Awaited<ReturnType<NotesModel['backlinks']>> = []
    try { list = await model.backlinks(note.id) || [] } catch (_) { list = [] }
    if (!list.length) return
    const items = list.map((source, i) => ({
      label: `${source.missing ? '（已失效）' : ''}${displayTitle(source)}`,
      action: `go:${i}`
    }))
    let action = null
    try {
      action = await menu.popupMenu({
        items, x, y,
        context: { kind: 'note', snapshot: { scope: 'backlinks', noteId: note.id } }
      })
    } catch (_) { action = null }
    const actionId = typeof action === 'string' ? action : ''
    if (!actionId.startsWith('go:')) return
    const picked = list[Number(actionId.slice(3))]
    if (picked && !picked.missing) model.revealNote(picked.id)
  }

  async function showSortMenu(e: MouseEvent): Promise<void> {
    if (!menu) return
    const items = NOTE_SORTS.map((s) => ({
      label: s.label + (model.state.sort === s.id ? ' ✓' : ''),
      action: s.id
    }))
    let action = null
    try { action = await menu.popupMenu({ items, x: e.clientX, y: e.clientY }) } catch (_) { action = null }
    if (typeof action === 'string') model.setSort(action)
  }

  /** 新建集锦：先建"新建集锦"，随即进入行内重命名，少一次弹窗。 */
  async function promptNewFolder(parentId: string | null = null): Promise<void> {
    const id = await model.createFolder(parentId)
    if (id) {
      renamingFolderId = id
      render()
    }
  }

  // ── 卡片单击 → 主动作（唯一入口）────────────────────────
  //
  // `@` 内联引用补全**已整块移除**（它是"长文笔记应用"的写法，与集锦的暂存定位不符）。
  // 正文引用仍可通过卡片 `⋯ → 复制引用 / 在此处插入引用` 完成，链路（域层抽 URI 写边表）不动。

  /**
   * 卡片单击 = 该 kind 的主动作。**行为本身全在 `model.primaryAction`**（一处判，防回归）；
   * 本函数只把它返回结果里**需要 DOM 的那两种**呈现出来：
   *   · `copy-text`    → 写剪贴板 + 一次轻提示（toast）；
   *   · `preview-image` → 用缩略图在面板内开大图预览（lightbox）。
   * 其余结果（opened / editing / revealed / none）模型已做完，视图不再补动作。
   * @param {any} note
   */
  async function activateCard(note: Note): Promise<void> {
    let res = null
    try { res = await model.primaryAction(note) } catch (_) { res = null }
    if (!res) return
    if (res.type === 'copy-text') {
      let ok = false
      try { await navigator.clipboard.writeText(res.text || ''); ok = true } catch (_) { ok = false }
      toast(ok ? '已复制文本' : '复制失败')
      return
    }
    if (res.type === 'preview-image') {
      if (res.path) openImageLightbox(res.path, displayTitle(note))
      return
    }
    if (res.type === 'open-url' && res.url) {
      // 模型侧走标签客户端没成功 → 退回 window.open 兜底（既有口径）。
      try { window.open(res.url, '_blank') } catch (_) {}
    }
  }

  // ── 键盘导航（"暂存场景下用户是键盘手"）─────────────────────────────
  //
  // 为什么值得做：集锦是**暂存** —— 用户的动作是"快速收、快速取"，手不离键盘是常态。
  // ↑↓ 选卡、Enter 用卡（= 单击的键盘等价物，走**同一个** model.primaryAction）、Del 删、
  // Esc 收、Ctrl/Cmd+C 复制链接。全部只在**卡片列表态**且**焦点不在输入框 / 编辑器**时生效，
  // 因此与搜索框、注释就地编辑、重命名输入框互不干扰。

  /** 当前分段里能上下移动的卡片序列（回收站是另一套紧凑行，不参与键盘导航）。 */
  function navCards(): Note[] {
    if (model.isTrashSection()) return []
    return model.visibleNotes()
  }

  /** 把聚焦态画到 keyNavId 那张卡上；列表重画后调用（节点没了就丢弃 keyNavId）。 */
  function applyKeyNav(scroll: boolean): void {
    for (const n of body.querySelectorAll('.notes-panel__card.is-keynav')) n.classList.remove('is-keynav')
    if (!keyNavId) return
    const node = body.querySelector(`[data-note-id="${cssEscape(keyNavId)}"]`)
    if (!node) { keyNavId = null; return }
    node.classList.add('is-keynav')
    if (scroll && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
  }

  /** ↑/↓：有聚焦时移动，没有时从第一张开始（Edge 集锦同款肌肉记忆）。 */
  function moveKeyNav(dir: -1 | 1): void {
    const cards = navCards()
    if (!cards.length) return
    let idx = cards.findIndex((n) => n.id === keyNavId)
    if (idx < 0) idx = dir > 0 ? -1 : cards.length
    let next = idx + dir
    if (next < 0) next = 0
    if (next > cards.length - 1) next = cards.length - 1
    keyNavId = cards[next].id
    applyKeyNav(true)
  }

  /** 键盘 Delete：与 ⋯ 菜单的删除同一口径（先确认、进回收站可恢复）。 */
  async function confirmDeleteNote(note: Note): Promise<void> {
    const ok = await confirm({
      title: '删除卡片',
      message: `确定删除「${displayTitle(note)}」？它会先进回收站，可以恢复。`,
      danger: true,
      confirmLabel: '删除'
    })
    if (ok) model.deleteNote(note.id)
  }

  /** 键盘 Ctrl/Cmd+C：复制聚焦卡的"链接"（page→url、snippet→摘录原文、其余→标题）。 */
  async function copyCardLink(note: Note): Promise<void> {
    const kind = normalizeKind(note.kind)
    const text = kind === 'page'
      ? (note.url || displayTitle(note))
      : (kind === 'snippet' ? (String(note.content || '') || displayTitle(note)) : displayTitle(note))
    let ok = false
    try { await navigator.clipboard.writeText(text); ok = true } catch (_) { ok = false }
    toast(ok ? '已复制' : '复制失败')
  }

  doc.addEventListener('keydown', (e) => {
    if (model.state.mode !== 'list') return
    const t = e.target instanceof HTMLElement ? e.target : null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    const cur = keyNavId ? model.getNote(keyNavId) : null
    if (e.key === 'ArrowDown') { e.preventDefault(); moveKeyNav(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveKeyNav(-1) }
    else if (e.key === 'Enter') { if (cur) { e.preventDefault(); void activateCard(cur) } }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (cur) { e.preventDefault(); void confirmDeleteNote(cur) } }
    else if (e.key === 'Escape') { if (keyNavId) { keyNavId = null; applyKeyNav(false) } }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) { if (cur) { e.preventDefault(); void copyCardLink(cur) } }
  })

  // 轻提示（片段卡复制 / 复制失败反馈）：常驻节点、只改文案并重放显隐，不随列表重绘重建。
  const toastEl = el('div', 'notes-panel__toast')
  wrap.appendChild(toastEl)
  let toastTimer: TimerHandle | null = null
  function toast(text: unknown): void {
    toastEl.textContent = String(text ?? '')
    toastEl.classList.add('is-visible')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.classList.remove('is-visible') }, 1400)
  }

  /**
   * 面板内大图预览：**只对"只有缩略图"的图片卡**用（有原图时走系统看图，见 model.primaryAction）。
   * 缩略图本身走 loadThumb（与列表同一份 dataURL 缓存，不再额外往返）。点任意处 / Esc 关闭。
   */
  let lightboxEl: HTMLDivElement | null = null
  function openImageLightbox(path: string, title: unknown): void {
    if (lightboxEl) return
    const box = el('div', 'notes-panel__lightbox')
    const img = doc.createElement('img')
    img.alt = ''
    if (title) img.title = String(title)
    box.appendChild(img)
    box.addEventListener('click', () => closeImageLightbox())
    lightboxEl = box
    wrap.appendChild(box)
    const p = String(path || '')
    if (/^(https?:|data:|file:|hira:)/i.test(p)) img.src = p
    // lazy:false —— 大图预览是 fixed 浮层（不在 body 滚动容器内），视口懒加载不适用。
    else loadThumb(p, img, () => {}, { lazy: false })
  }
  function closeImageLightbox(): void {
    if (!lightboxEl) return
    lightboxEl.remove()
    lightboxEl = null
  }
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightboxEl) closeImageLightbox()
  })

  // ── 多选批量栏 ──────────────────────────────────────────

  function renderBatchBar(): void {
    const n = model.selectedCount()
    batchBar.classList.toggle('is-visible', n > 0)
    if (!n) { batchBar.textContent = ''; return }
    batchBar.textContent = ''
    batchBar.appendChild(el('span', 'notes-panel__batch-count', `已选 ${n}`))
    batchBar.appendChild(el('span', 'notes-panel__batch-spacer'))

    const moveBtn = doc.createElement('button')
    moveBtn.type = 'button'
    moveBtn.className = 'notes-panel__batch-btn'
    moveBtn.textContent = '移动到…'
    moveBtn.addEventListener('click', (e) => showBatchMoveMenu(e))
    batchBar.appendChild(moveBtn)

    const copyBtn = doc.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'notes-panel__batch-btn'
    copyBtn.textContent = '复制引用'
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(model.selectedRefsText()) } catch (_) {}
    })
    batchBar.appendChild(copyBtn)

    const delBtn = doc.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'notes-panel__batch-btn is-danger'
    delBtn.textContent = '删除'
    delBtn.addEventListener('click', async () => {
      const ok = await confirm({
        title: '删除卡片',
        message: `确定删除选中的 ${n} 张卡片？它们会先进回收站，可以恢复。`,
        danger: true,
        confirmLabel: '删除'
      })
      if (ok) model.deleteSelected()
    })
    batchBar.appendChild(delBtn)

    const cancelBtn = doc.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'notes-panel__batch-btn'
    cancelBtn.textContent = '取消'
    cancelBtn.addEventListener('click', () => model.clearSelection())
    batchBar.appendChild(cancelBtn)
  }

  /**
   * 批量「移动到…」：**复用**卡片右键那一份集锦选择子菜单（buildMoveSubmenu）——
   * 不新造第二个"选集锦"浮层（造了就会与卡片右键那份各写一套、迟早对不齐）。
   */
  async function showBatchMoveMenu(e: MouseEvent): Promise<void> {
    if (!menu) return
    const items = buildMoveSubmenu()
    let action = null
    try { action = await menu.popupMenu({ items, x: e.clientX, y: e.clientY }) } catch (_) { action = null }
    const actionId = typeof action === 'string' ? action : ''
    if (!actionId.startsWith('move:')) return
    model.moveSelectedTo(actionId.slice('move:'.length) || null)
  }

  // ── 类型筛选下拉（自绘，支持真正的多选勾选）──────────────
  // 为什么不用原生菜单：原生菜单点一下就关，勾 3 种类型要开 3 次 —— 那不是"勾选"。
  let filterPop: HTMLDivElement | null = null

  function closeFilterPop(): void {
    if (!filterPop) return
    filterPop.remove()
    filterPop = null
  }

  function toggleFilterPop(anchor: Element | null): void {
    if (filterPop) { closeFilterPop(); return }
    if (!anchor) return
    filterPop = el('div', 'notes-panel__popover')
    doc.body.appendChild(filterPop)
    const rect = anchor.getBoundingClientRect()
    filterPop.style.top = `${Math.round(rect.bottom + 4)}px`
    filterPop.style.left = `${Math.round(Math.min(rect.left, (doc.documentElement.clientWidth || rect.left) - 180))}px`
    refreshFilterPop()
  }

  function refreshFilterPop(): void {
    if (!filterPop) return
    filterPop.textContent = ''
    for (const kind of NOTE_KINDS as NoteKind[]) {
      const active = model.state.kindFilter.includes(kind)
      const row = el('button', 'notes-panel__popover-row' + (active ? ' is-active' : ''))
      row.type = 'button'
      const box = el('span', 'notes-panel__checkbox')
      if (active) box.appendChild(icon('check', 12))
      row.appendChild(box)
      row.appendChild(el('span', 'notes-panel__popover-label', KIND_LABELS[kind] || kind))
      row.addEventListener('click', () => { model.toggleKindFilter(kind); refreshFilterPop() })
      filterPop.appendChild(row)
    }
    if (model.state.kindFilter.length) {
      const clear = el('button', 'notes-panel__popover-clear', '清除筛选')
      clear.type = 'button'
      clear.addEventListener('click', () => { model.clearKindFilter(); refreshFilterPop() })
      filterPop.appendChild(clear)
    }
  }

  doc.addEventListener('mousedown', (e) => {
    if (!filterPop) return
    const target = e.target instanceof Node ? e.target : null
    if (target && filterPop.contains(target)) return
    if (target && (target === filterBtn || filterBtn.contains(target))) return
    closeFilterPop()
  })

  // Esc 清空多选（经典集锦同款肌肉记忆）。与搜索框 / 重命名的 Esc 互不冲突：
  // 那两处各自处理完自己的事，这里只多做"把选择清掉"这一件，没有选择时什么也不做。
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (model.selectedCount() > 0) model.clearSelection()
  })

  // 空白区右键：新建入口（Vivaldi / Edge 里也是右键面板空白处新建）
  body.addEventListener('contextmenu', (e) => {
    if (e.target !== body) return
    e.preventDefault()
    if (!menu) return
    const providers = captureProviders()
    void Promise.resolve(menu.popupMenu({
      items: [
        { label: '新建备注', action: 'new-note' },
        { label: '添加当前页面', action: 'new-from-page' },
        // 插件贡献的抓取源（没有就不出现，菜单与旧版逐字一致）。
        ...providers.map((p, i) => ({ label: `收进：${String(p.label || p.id)}`, action: `capture-provider:${i}` })),
        { label: '新建集锦', action: 'new-folder' }
      ],
      x: e.clientX,
      y: e.clientY,
      // 空白区也属于笔记面板这一个宿主：`scope: 'blank'` 让插件知道这里没有具体卡片。
      context: { kind: 'note', snapshot: { scope: 'blank', folderId: model.scopeParentId() } }
    })).then((action: unknown) => {
      const actionId = typeof action === 'string' ? action : ''
      if (actionId === 'new-note') model.createNoteCard()
      else if (actionId === 'new-from-page') model.captureCurrentPage()
      else if (actionId === 'new-folder') promptNewFolder(model.scopeParentId())
      else if (actionId.startsWith('capture-provider:')) {
        const index = Number(actionId.slice('capture-provider:'.length))
        if (Number.isInteger(index)) void runCaptureProvider(providers[index])
      }
    }).catch(() => {})
  })

  // ── 粘贴导入（P2）──────────────────────────────────────
  //
  // 面板（整块）监听 paste：剪贴板里的**图片**存成资产卡，**文本**按 URL 形态收成
  // 网页卡或片段卡。这是"内容进得来"的**确定性路径**（与下面的拖放并存，见那里的说明）。
  //
  // 为什么从 `paste` 事件的 `clipboardData` 取图，而不是 `clipboard.readImage()`：
  //   渲染层是独立 WebContentsView，**拿不到** Electron 的 clipboard 模块
  //   （见 panel-preload.js 只暴露 provider / on）；`navigator.clipboard.read()` 的图片读取
  //   需要额外的剪贴板读权限、窗口未聚焦时还会 reject。paste 事件自带的 DataTransfer
  //   是**无权限、无往返**的确定性来源 —— 取到的图转 dataURL 交主进程落盘。
  wrap.addEventListener('paste', (e) => {
    const target = e.target instanceof HTMLElement ? e.target : null
    // 在标题 / 正文 / 标签输入框里粘贴 = 普通文本编辑 —— 绝不拦截。
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
    const dt = e.clipboardData
    if (!dt) return
    const imageFile = findImageFile(dt)
    if (imageFile) {
      e.preventDefault()
      fileToDataUrl(imageFile).then((dataUrl) => {
        if (dataUrl) model.captureImageFromDataUrl({ dataUrl, title: imageFile.name || '' }).catch(() => {})
      }).catch(() => {})
      return
    }
    const text = dt.getData('text/plain') || ''
    if (text.trim()) {
      e.preventDefault()
      model.captureText({ text }).catch(() => {})
    }
  })

  /**
   * 外部拖入（文件 / 链接 / 文本 / HTML）—— 与上面"面板内拖拽排序"是两条独立的路。
   *
   * ⚠ 跨 `WebContentsView` 的 HTML5 拖放**未经运行实测**：面板本身在独立原生视图里，
   *   从网页视图 / 系统拖进来的 `DataTransfer` 能不能可靠拿到（尤其 Files 与 uri-list）
   *   取决于 Electron 版本与平台。粘贴是同一需求的**确定性路径**，二者并存、互不依赖。
   *   这一段刻意**不自造主进程事件通道**、也不改协议层 —— 只用 DOM 的 DataTransfer。
   */
  function handleExternalDrop(e: DragEvent): void {
    const dt = e.dataTransfer
    if (!dt) return
    e.preventDefault()
    // ① 图片文件（从系统 / 页面拖来的图）：逐张存成资产卡。
    const files = dt.files ? Array.from(dt.files) : []
    const imageFiles = files.filter((f) => f && /^image\//i.test(f.type || ''))
    for (const file of imageFiles) {
      fileToDataUrl(file).then((dataUrl) => {
        if (dataUrl) model.captureImageFromDataUrl({ dataUrl, title: file.name || '' }).catch(() => {})
      }).catch(() => {})
    }
    if (imageFiles.length === files.length && files.length > 0) return

    // ② text/uri-list（多行 = 多项）→ 逐项：图片型 URL 走抓图，其它走网页卡。
    // ③ 回落到 text/plain；④ 再回落到 text/html 里的第一个 <a href>。
    const uriList = dt.getData('text/uri-list') || ''
    const uris = uriList.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    const plain = (dt.getData('text/plain') || '').trim()
    let targets = uris.length ? uris : (plain ? [plain] : [])
    if (!targets.length) {
      const html = dt.getData('text/html') || ''
      const m = /<a[^>]+href=["']([^"']+)["']/i.exec(html)
      if (m) targets = [m[1]]
    }
    for (const target of targets) {
      if (isHttpUrl(target)) {
        if (looksLikeImageUrl(target)) model.captureImageFromUrl({ url: target }).catch(() => {})
        else model.captureLink({ url: target }).catch(() => {})
      } else {
        model.captureText({ text: target }).catch(() => {})
      }
    }
  }

  /**
   * 统一拖拽协议的落点（标签 / 书签 / 历史 / 下载 / 画板 / 其它集锦卡）。
   *
   * 与 `handleExternalDrop`（系统文件 / 外部链接）是两条独立的路：
   *   · 前者读**本应用自己的载荷**（MIME / 前缀），按 domain 精确分发；
   *   · 后者读系统 DataTransfer（Files / uri-list / html），只做"尽力导入"。
   * 优先走协议 —— 否则页面卡的 URL 会先被 uri-list 那条路截走、丢掉 tabId 与标题。
   */
  function handleProtocolDrop(e: DragEvent): void {
    const dt = e.dataTransfer
    if (!dt) return
    const item = getDragItem(dt)
    if (!item) {
      handleExternalDrop(e)
      return
    }
    e.preventDefault()
    clearDrop()
    body.classList.remove('drop-root')
    // 指针压在某个集锦行上 = 直接收进它；否则收进当前所在集锦 / 未归档。
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-kind="folder"]') ?? null
    const folderId = row?.dataset.folderId ?? model.currentCaptureFolderId()
    // 集锦（文件夹）不是可成卡的内容 —— 只允许在集锦之间移动，跨域落库时忽略。
    if (item.kind === 'folder') return
    model.captureDroppedItem(item, { folderId }).catch(() => {})
  }

  // ── 拖拽（学收藏面板：落点三分带 + 防环）────────────────
  //
  // 只在「集锦」分段启用：拖拽要有"文件夹"这个落点才有语义；全部/稍后读是平铺视图，
  // 没有落点可言。
  let dragKind: string | null = null
  let dragId: string | null = null
  let dropEl: HTMLElement | null = null
  let dropZone = ''

  function clearDrop(): void {
    if (dropEl) dropEl.classList.remove('drop-into', 'drop-before', 'drop-after')
    dropEl = null
    dropZone = ''
  }
  function setDrop(node: HTMLElement | null, zone: string): void {
    if (dropEl === node && dropZone === zone) return
    clearDrop()
    if (!node || !zone) return
    dropEl = node
    dropZone = zone
    node.classList.add(zone === 'into' ? 'drop-into' : zone === 'before' ? 'drop-before' : 'drop-after')
  }
  /** 行内落点带：集锦中段 = 放进里面，其余按上下半插入。 */
  function zoneOf(row: HTMLElement, e: DragEvent): 'into' | 'before' | 'after' {
    const rect = row.getBoundingClientRect()
    const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5
    if (row.dataset.kind === 'folder' && ratio > 0.28 && ratio < 0.72) return 'into'
    return ratio < 0.5 ? 'before' : 'after'
  }
  function insertIndex(siblingIds: string[], targetId: string, zone: string): number | null {
    const at = siblingIds.indexOf(targetId)
    if (at < 0) return null
    return zone === 'after' ? at + 1 : at
  }

  body.addEventListener('dragstart', (e) => {
    if (!model.isCollectionsSection()) return
    const target = e.target instanceof Element ? e.target : null
    const row = target?.closest<HTMLElement>('[data-kind]') ?? null
    if (!row) return
    const dt = e.dataTransfer
    if (!dt) return
    const id = row.dataset.kind === 'note' ? row.dataset.noteId : row.dataset.folderId
    if (!id) return
    dragKind = row.dataset.kind ?? null
    dragId = id
    try {
      // 面板内是排序（move），拖到别处是搬运（copy）—— 两者都声明，落点才好选 dropEffect。
      dt.effectAllowed = 'copyMove'
      dt.setData('text/plain', id)
    } catch (_) {}
    // 统一拖拽协议：卡片 / 集锦都能拖到画板、书签栏、标签栏（跨视图按 domain 分发）。
    if (dragKind === 'note') {
      const note = model.getNote(id)
      setDragItem(dt, {
        domain: 'note',
        id,
        kind: note ? note.kind : 'note',
        url: note && note.url ? note.url : '',
        title: note ? displayTitle(note) : '',
        text: note ? String(note.content || '') : '',
        folderId: note && note.folderId ? note.folderId : ''
      }, { plain: 'prefix' })
    } else {
      const folder = model.state.folders.find((f) => f.id === id)
      setDragItem(dt, {
        domain: 'note',
        id,
        kind: 'folder',
        title: folder ? (folder.name || '') : ''
      }, { plain: 'prefix' })
    }
    row.classList.add('is-dragging')
  })

  body.addEventListener('dragend', () => {
    clearDrop()
    body.classList.remove('drop-root')
    for (const node of body.querySelectorAll('.is-dragging')) node.classList.remove('is-dragging')
    dragKind = null
    dragId = null
  })

  body.addEventListener('dragover', (e) => {
    const dt = e.dataTransfer
    const target = e.target instanceof Element ? e.target : null
    if (!dt) return
    if (!dragKind) {
      // ① 应用内统一协议（标签 / 书签 / 历史 / 下载 / 画板）—— 优先，见 handleProtocolDrop。
      if (hasDragItem(dt)) {
        e.preventDefault()
        dt.dropEffect = pickDropEffect(dt, 'copy')
        const row = target?.closest<HTMLElement>('[data-kind="folder"]') ?? null
        if (row) setDrop(row, 'into')
        else clearDrop()
        return
      }
      // ② 外部拖入（文件 / 链接 / 文本 / HTML）—— 允许落下，给出 copy 光标。
      // 见 handleExternalDrop 的"未实测"说明。
      const types = dt.types ? Array.from(dt.types) : []
      if (types.some((t) => /text\/uri-list|text\/plain|text\/html|Files/i.test(t))) {
        e.preventDefault()
        dt.dropEffect = 'copy'
      }
      return
    }
    const row = target?.closest<HTMLElement>('[data-kind]') ?? null
    if (!row) {
      // 空白区 = 落到**当前这一层**的末尾
      e.preventDefault()
      dt.dropEffect = 'move'
      clearDrop()
      body.classList.add('drop-root')
      return
    }
    const kind = row.dataset.kind
    if (dragKind === 'folder' && kind === 'note') return // 文件夹不能落进卡片
    if (kind === 'note' && row.dataset.noteId === dragId) return
    if (kind === 'folder' && row.dataset.folderId === dragId) return
    if (dragKind === 'folder' && kind === 'folder') {
      const target = row.dataset.folderId
      if (target && dragId && model.descendantFolderIds(dragId).has(target)) return // 防环
    }
    e.preventDefault()
    dt.dropEffect = 'move'
    body.classList.remove('drop-root')
    setDrop(row, zoneOf(row, e))
  })

  body.addEventListener('dragleave', (e) => {
    if (!(e.relatedTarget instanceof Node) || !body.contains(e.relatedTarget)) body.classList.remove('drop-root')
  })

  body.addEventListener('drop', (e) => {
    const target = e.target instanceof Element ? e.target : null
    const dt = e.dataTransfer
    if (!dragKind) {
      // 应用内统一协议优先（见 handleProtocolDrop），否则退回系统导入路径。
      if (hasDragItem(dt)) handleProtocolDrop(e)
      else handleExternalDrop(e)
      return
    }
    const kind = dragKind
    const id = dragId
    const row = target?.closest<HTMLElement>('[data-kind]') ?? null
    const onRoot = body.classList.contains('drop-root')
    clearDrop()
    body.classList.remove('drop-root')
    dragKind = null
    dragId = null
    e.preventDefault()
    if (!id) return

    if (!row) {
      if (onRoot) {
        const level = model.scopeParentId()
        if (kind === 'note') model.dropNote(id, level, null)
        else model.dropFolder(id, level, null)
      }
      return
    }
    const rk = row.dataset.kind

    if (kind === 'note') {
      if (rk === 'folder') {
        model.dropNote(id, row.dataset.folderId || null, null)
        return
      }
      const target = model.getNote(row.dataset.noteId ?? null)
      if (!target || target.id === id) return
      const siblings = model.siblingNoteIds(target.folderId).filter((x) => x !== id)
      model.dropNote(id, target.folderId, insertIndex(siblings, target.id, zoneOf(row, e)))
      return
    }

    // 拖的是集锦
    if (rk !== 'folder') return
    const targetFolderId = row.dataset.folderId
    if (!targetFolderId || targetFolderId === id) return
    const zone = zoneOf(row, e)
    if (zone === 'into') {
      model.dropFolder(id, targetFolderId, null)
      return
    }
    const parent = (model.state.folders.find((f) => f.id === targetFolderId) || {}).parentId || null
    const siblings = model.siblingFolderIds(parent).filter((x) => x !== id)
    model.dropFolder(id, parent, insertIndex(siblings, targetFolderId, zone))
  })

  // ── 小工具 ──────────────────────────────────────────────

  /** 反链跳转落地后把目标卡滚进视野并清掉高亮标记（否则标记会一直留着）。 */
  function scrollToHighlight(): void {
    const id = model.state.highlightId
    if (!id) return
    const node = body.querySelector(`[data-note-id="${cssEscape(id)}"]`)
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center' })
    model.clearHighlight()
  }

  function cssEscape(v: unknown): string {
    return String(v).replace(/["\\]/g, '\\$&')
  }

  /** 重画当前编辑器的 Markdown 预览（粘贴图片后立刻能看到 —— 不必等下一次 model emit）。 */
  function refreshPreview(): void {
    if (!editor) return
    const note = model.getActiveNote()
    if (!note) return
    editor.preview.innerHTML = renderMarkdown(note.content || '', { resolveRef: (id) => model.refChipInfo(id) })
    hydratePreviewAssets(editor.preview)
  }

  /**
   * 预览里的**内联图片**：正文写的是 `hira-asset:<相对路径>`，渲染层读不了本地文件，
   * 必须经主进程换 dataURL（`loadThumb` → assetThumb，带 LRU 与缓存）。
   * 读不到 → 清掉 src 并留 alt 文案（绝不留一个破图图标）。
   */
  function hydratePreviewAssets(container: Element): void {
    if (!container || !container.querySelectorAll) return
    for (const img of container.querySelectorAll('img')) {
      const path = parseNoteAssetUri(img.getAttribute('src'))
      if (!path) continue
      img.removeAttribute('src')
      if (!img.alt) img.alt = '图片'
      loadThumb(path, img, () => {
        img.classList.add('is-missing')
        img.alt = '图片不可用'
      }, { lazy: false })
    }
  }

  /**
   * 在 textarea 光标处插入一段文本（粘贴图片用），并让图片独占一行。
   * 同步把新值写回 model（与手动输入走同一条 updateActive 通道）。
   */
  function insertAtCaret(textarea: HTMLTextAreaElement, snippet: string): void {
    if (!textarea) return
    const value = textarea.value
    const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : value.length
    const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start
    const before = value.slice(0, start)
    const after = value.slice(end)
    const text = `${before && !before.endsWith('\n') ? '\n' : ''}${snippet}${after && !after.startsWith('\n') ? '\n' : ''}`
    textarea.value = before + text + after
    const caret = before.length + text.length
    try { textarea.setSelectionRange(caret, caret) } catch (_) {}
    textarea.focus()
    model.updateActive({ content: textarea.value })
  }

  /**
   * 把一个资产路径（库里的 `thumbPath` / `assetPath`，相对 userData）灌进 `<img>`。
   *
   * 两条来源：
   *   · 本来就是可加载 URL（http/data/file/hira，老数据可能长这样）→ 直接当 src；
   *   · 相对路径 → 经 `model.assetThumb` 让主进程读盘转 dataURL（见 notes-assets.js 的
   *     "为什么走 dataURL" 说明）。结果进 `thumbCache`，同一张图不再往返。
   *
   * **懒加载**：未缓存的相对路径默认交给 IntersectionObserver（进视口才读 IPC，见 observeThumb）；
   * 传 `{ lazy: false }` 的调用点（编辑器大图 / 大图预览）是"点了就一定要立刻看到"，直接读。
   *
   * ⚠ 缓存命中在**同步**返回：previewImageBox 依赖这条同步性（上次读失败 → 立刻判定、
   * 不留空预览框）；未缓存路径的失败改由异步 onFail 处理（box 已在文档里，回调会移除它）。
   */
  function loadThumb(
    path: string,
    img: HTMLImageElement | null,
    onFail?: () => void,
    opts: LoadThumbOptions = {}
  ): void {
    const p = String(path || '')
    if (!img || !p) { if (onFail) onFail(); return }
    if (/^(https?:|data:|file:|hira:)/i.test(p)) { img.src = p; return }
    if (thumbCache.has(p)) {
      const hit = thumbCache.get(p)
      if (hit) img.src = hit
      else if (onFail) onFail()
      return
    }
    if (opts && opts.lazy === false) fetchThumb(p, img, onFail)
    else observeThumb(p, img, onFail)
  }

  /** 一个 URL 看起来是不是"图片"（决定拖放时走抓图还是当网页卡）—— 只按扩展名判，够用且零成本。 */
  function looksLikeImageUrl(url: string): boolean {
    const u = String(url || '').split(/[?#]/)[0]
    return /^data:image\//i.test(String(url || '')) || /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(u)
  }

  /** 从 DataTransfer 里取第一个图片文件（粘贴 / 拖放共用）。 */
  function findImageFile(dt: DataTransfer | null): File | null {
    if (!dt) return null
    if (dt.items) {
      for (const item of dt.items) {
        if (item && item.kind === 'file' && /^image\//i.test(item.type || '')) {
          const file = item.getAsFile()
          if (file) return file
        }
      }
    }
    if (dt.files) {
      for (const file of dt.files) if (file && /^image\//i.test(file.type || '')) return file
    }
    return null
  }

  /** 一个图片文件 → dataURL（主进程按 dataURL 落资产，见 notes-assets.js#saveBufferFromDataUrl）。 */
  function fileToDataUrl(file: File): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      try {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(file)
      } catch (_) {
        resolve(null)
      }
    })
  }

  /** 打开一个 URL：优先走标签客户端（面板里比 window.open 可靠），失败再退回 window.open。 */
  async function openUrl(url: unknown): Promise<void> {
    const ok = await model.openUrl(url)
    if (!ok) { try { window.open(String(url ?? ''), '_blank') } catch (_) {} }
  }

  function formatDate(ts: unknown): string {
    const d = new Date(Number(ts) || Date.now())
    const now = new Date()
    const sameYear = d.getFullYear() === now.getFullYear()
    return sameYear
      ? `${d.getMonth() + 1}/${d.getDate()}`
      : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  }
  function formatDateTime(ts: unknown): string {
    const d = new Date(Number(ts) || Date.now())
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  /**
   * 域名缩写：复用 ui-common 的 `siteKeyOf`（只认 http(s)、取 hostname、去 `www.`、丢路径与查询）。
   *
   * 为什么需要这里的兜底：`siteKeyOf` 对非 http(s)（老数据里可能混进 `hira:` / `about:` 等）
   * 一律返回空串 —— 卡片第二行不能因此变成空白，故退回原串的 host 部分（再不行就原样）。
   */
  function domainOf(url: unknown): string {
    const key = siteKeyOf(url)
    if (key) return key
    try {
      return new URL(String(url || '')).hostname || String(url || '')
    } catch (_) {
      return String(url || '')
    }
  }

  // ── 对外端口 ─────────────────────────────────────────
  // `element / render / toast` 是原有契约（面板本体直接用）。
  // 其余几个是给 renderer / 外部定位用的受控端口：分段与搜索词可被下发，
  // 生命周期由 renderer 统一收口 —— 视图自己不监听 window 事件、不持有全局资源。
  function setQuery(next: unknown): void {
    const value = String(next == null ? '' : next)
    if (searchInput && doc.activeElement !== searchInput) searchInput.value = value
    commitQuery(value)
  }

  /** 面板常驻搜索框；返回 true = 已拿到焦点。 */
  function focusSearch(): boolean {
    if (!searchInput) return false
    searchInput.focus()
    searchInput.select()
    return true
  }

  function setSection(section: unknown): void {
    model.setSection(section)
  }

  function dispose(): void {
    if (searchTimer != null) { clearTimeout(searchTimer); searchTimer = null }
    if (toastTimer != null) { clearTimeout(toastTimer); toastTimer = null }
    archiveView?.dispose()
    if (thumbObserver) thumbObserver.disconnect()
    closeFilterPop()
  }

  return { element: wrap, render, toast, setQuery, focusSearch, setSection, dispose }
}
