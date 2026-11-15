/**
 * 笔记面板的**状态模型**（不含任何 DOM）。
 *
 * 分工：
 *   · 本文件 —— 一处状态 + 一处数据来源（IPC 客户端），对外暴露语义化动作与选择器；
 *   · `panel-notes.view.js` —— 只读状态、只画、只把用户意图转成对本模型的调用；
 *   · `panel-notes.renderer.js` —— 把两者与宿主端口接起来。
 *
 * 「一份状态、一个写入口」是刻意的：面板里有列表 / 文件夹树 / 编辑器三块互相影响的 UI，
 * 若各自缓存一份数据，切换、置顶、重命名之后必然出现「这边变了那边没变」。
 *
 * 本面板同时是「经典 Edge 集锦」的完全体：卡片按 `kind` 分四态，集锦（= 文件夹）单栏两态
 * （集锦卡片墙 ⇄ 卡片板），外加回收站 / 引用反链 / 全部打开等集锦级动作。所有分段、排序、
 * 颜色、卡片类型的**枚举与标签都只在本文件出现一次**，视图侧不写任何字面量。
 */

// 「稍后读」文件夹名（泳道语义）在共享层 —— 写入侧在 renderer、读取侧是本插件，
// 两个独立 bundle 必须共用一份常量（见 reading-list.mjs 的文件头）。
import { READING_LIST_FOLDER } from '@hira-ng/shared-types/src/reading-list.mjs'
import { PAGE_ARCHIVE_FOLDER } from '@hira-ng/shared-types/src/page-library.mjs'
import { pageUrl } from '@hira-ng/shared-types/src/page-url.mjs'
// 「算不算普通网页」的唯一判据（拖进来的链接 / 文本要收成 page 还是普通笔记）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
// 集锦 / 笔记域的**唯一真源**：卡片类型、面板分段、默认集锦名、引用 URI 都在这里，
// 由域层 / 主进程 / 面板三个 bundle 共用（见 notes.mjs 的文件头"为什么必须只有一处"）。
// 展示 / 序列化纯函数（plainTextSnippet / displayNoteTitle / notesTo*）同样是共享真源：
// 主进程的 `note:*` 动作与面板的「复制全部 / 导出」必须产出逐字一致的内容。
import {
  NOTE_KINDS,
  NOTE_KIND_LABELS,
  NOTE_SECTIONS,
  normalizeNoteSection,
  noteRefUri,
  NOTE_EXPORT_FORMATS,
  NOTES_LIST_RENDER_LIMIT,
  buildSourceNoteContent,
  buildTextFragmentUrl,
  TEXT_FRAGMENT_MARKER,
  plainTextSnippet,
  normalizeNoteKind,
  displayNoteTitle,
  notesToPlainText,
  notesToMarkdown,
  notesToHtml,
  notesToJson,
  noteTimeValue,
  sortNotesForDisplay,
  noteAssetUri,
  parseNoteAssetUri
} from '@hira-ng/shared-types/src/notes.mjs'
import type {
  AddNoteInput,
  BacklinkNote,
  CaptureNoteInput,
  Note,
  NoteChange,
  NoteFolder,
  NoteKind,
  UpdateNoteInput
} from '@hira-ng/domain-notes'

type TimerHandle = ReturnType<typeof setTimeout>

export interface NotesPanelClient {
  folders(): Promise<NoteFolder[]>
  folderCounts(): Promise<Record<string, number>>
  list(options?: { folderId?: string | null }): Promise<Note[]>
  add(input?: AddNoteInput): Promise<Note | null>
  update(input: { id: string } & UpdateNoteInput): Promise<Note | null>
  remove(id: string): Promise<{ ok: boolean }>
  move(id: string, folderId: string | null): Promise<Note | null>
  pinSet(id: string, pinned: boolean): Promise<Note | null>
  reorder(folderId: string | null, orderedIds: string[]): Promise<{ ok: boolean }>
  capture(input: CaptureNoteInput & { tabId?: string }): Promise<Note | null>
  restore(id: string): Promise<{ ok: boolean }>
  purge(id: string): Promise<{ ok: boolean }>
  trash(): Promise<Note[]>
  emptyTrash(): Promise<{ ok: boolean }>
  backlinks(id: string): Promise<BacklinkNote[]>
  refCounts(): Promise<Record<string, number>>
  addFolder(input: { name?: string; parentId?: string | null }): Promise<{ id: string | null }>
  renameFolder(id: string, name: string): Promise<{ ok: boolean }>
  removeFolder(id: string): Promise<{ ok: boolean }>
  moveFolder(id: string, parentId: string | null): Promise<{ ok: boolean }>
  reorderFolders(parentId: string | null, orderedIds: string[]): Promise<{ ok: boolean }>
  onChanged(listener: (payload: NoteChange) => void): () => void
  assetFetch(input: { url: string; referer?: string }): Promise<AssetResult>
  assetSaveBuffer(input: { dataUrl: string }): Promise<AssetResult>
  assetThumb(path: string): Promise<{ dataUrl: string | null }>
  assetOpen(path: string): Promise<{ ok: boolean; error?: string }>
  exportFile(input: { format: string; filename?: string; content: string; encoding?: 'utf8' | 'base64' }): Promise<ExportResult>
}

interface AssetResult {
  ok: boolean
  assetPath?: string | null
  thumbPath?: string
  assetMime?: string
  assetWidth?: number
  assetHeight?: number
  oversize?: boolean
  reason?: string
  dataUrl?: string
}

interface ExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

interface NotesModelOptions {
  onChange?: () => void
  onError?: (message: string) => void
  tabs?: { newTab?: (arg: { url?: string }) => unknown } | null
  prefs?: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): unknown
  } | null
}

export interface NotesPanelState {
  loaded: boolean
  error: string | null
  notes: Note[]
  folders: NoteFolder[]
  counts: Record<string, number>
  scopeFolderId: string | null | undefined
  expanded: Set<string>
  unfiledCollapsed: boolean
  query: string
  activeTags: string[]
  kindFilter: NoteKind[]
  sort: 'modified' | 'created' | 'title'
  mode: 'list' | 'edit'
  activeNoteId: string | null
  section: string
  refCounts: Record<string, number>
  trash: Note[]
  highlightId: string | null
  selected: Set<string>
}

/** 颜色标签色板（与 Vivaldi 的笔记颜色同一用途：一眼区分分类）。 */
export const NOTE_COLORS = Object.freeze([
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'
])

export const NOTE_SORTS = Object.freeze([
  { id: 'modified', label: '按修改时间' },
  { id: 'created', label: '按创建时间' },
  { id: 'title', label: '按标题' }
])

// 卡片类型与分段枚举都由 shared-types 提供，这里**原样转出**供视图消费
// （视图只认 model 一个入口，不直接 import shared 件 —— 面板内部保持"一处取用"）。
export { NOTE_KINDS, NOTE_SECTIONS }
// text fragment 标记同样转出：视图要判「这个来源链接是不是能跳到原文那段」以决定文案。
export { TEXT_FRAGMENT_MARKER }

/** 卡片类型 → 中文名（转出共享真源里的映射，UI 文案的唯一来源）。 */
export const KIND_LABELS = NOTE_KIND_LABELS

/**
 * 分段 id → 中文名。**这是纯 UI 文案**（枚举取值/顺序/归一化的真源在 shared-types），
 * 放在 model 是为了让视图不自己造第二份标签表。
 */
export const NOTE_SECTION_LABELS = Object.freeze({
  collections: '集锦',
  all: '全部',
  reading: '稍后读',
  archive: '归档',
  trash: '回收站'
})

// 展示 / 序列化纯函数全部下沉到 shared-types（唯一真源，主进程 `note:*` 动作与面板共用）。
// 这里只保留面板侧的**别名**：视图一直从 model 取 `normalizeKind` / `displayTitle`，
// 改调用点没有收益，反而会把"面板内部一处取用"的约定打散。
export const normalizeKind = normalizeNoteKind as (value: unknown) => NoteKind
export const displayTitle = (note: Note): string => displayNoteTitle({
  title: note.title,
  content: note.content,
  kind: note.kind,
  sourceTitle: note.sourceTitle ?? undefined
})
export { notesToPlainText }
// 正文内联图片的资产 URI（构造 / 解析）由 shared-types 提供，面板只从 model 取用 ——
// 视图不直接 import shared，保证"面板内部一处取用"的约定不被绕开。
export { noteAssetUri, parseNoteAssetUri }

/** NG 过渡期（localStorage 版）的存储键 —— 首次挂载时一次性搬进数据库。 */
const LEGACY_STORAGE_KEY = 'hira-notes'

/**
 * 本面板的**视图偏好**键（设置域里的普通键，不属于笔记数据）。
 * 键名集中在这里，避免同一个偏好被视图 / 装配层各写一个字符串而漂移。
 */
const VIEW_PREF_KEYS = Object.freeze({
  unfiledCollapsed: 'notes.unfiled_collapsed'
})

/** 卡片的时间戳（口径与排序同源：shared-types#noteTimeValue）。 */
const noteTime = noteTimeValue

/** 导出格式 id → 菜单文案（「导出」子菜单三选用；与 shared 的枚举一一对应）。 */
export const NOTE_EXPORT_FORMAT_LABELS = Object.freeze({ md: 'Markdown', html: 'HTML', json: 'JSON' })

// 导出格式枚举由 shared-types 提供，这里原样转出（面板内部保持"一处取用"，视图不直接 import shared）。
export { NOTE_EXPORT_FORMATS }

// 长列表建卡上限（shared-types 真源）同样原样转出：视图只从 model 取口径。
export { NOTES_LIST_RENDER_LIMIT }

/**
 * 「结构性变更」—— 只有这些才需要重拉**计数**（folderCounts / refCounts）。
 *
 * 为什么把 'update' 单拎出来：域层的 `update` 覆盖了正文 / 标题 / 标签 / 颜色 / 置顶 / 移动
 * 全部"改一条"的写路径（`move` / `setPinned` 都走 update，所以它们的 reason 也是 'update'）。
 * 而 `list()` 已经把每条卡的最新数据整体带回 —— 计数只是**别处**（集锦卡片墙的「N 张」、
 * 列表的 ↩N 徽标）读的投影，一次纯文本更新动不了它们。故纯 update 只打 1 条 IPC（list），
 * 而不是 4 条；连续保存时这省下的是"每存一次字都白跑两趟"。
 * （本面板自己的移动 / 删除等动作走 reload('manual')，按结构性口径全量拉 —— 见 reload。）
 */
const STRUCTURAL_REASONS = new Set([
  'add', 'remove', 'move', 'reorder', 'restore', 'purge',
  'folder-add', 'folder-update', 'folder-remove'
])

/**
 * 关键路径耗时告警阈值（ms）—— 见 perfStart / perfEnd。
 * 这不是日志噪音：它让用户 / 开发者能回报"卡"的具体数字（哪条路径、多少张卡、几毫秒）。
 */
const PERF_WARN_MS = 100

/** performance.now() 的安全取值（没有 performance 时退回 Date.now）。 */
function perfNow() {
  return (typeof performance !== 'undefined' && performance && performance.now) ? performance.now() : Date.now()
}

/**
 * 关键路径计时（**唯一定义**）—— 视图与模型共用这一对。
 *
 * 优先用 Performance API（`performance.mark` / `measure`，可在 DevTools 的 Performance 面板里
 * 看到具体条目），拿不到就退回 `performance.now()` 差值。
 * 只有**超过阈值**才 `console.warn` 并**保留**时间线条目（供进一步定位）；
 * 低于阈值立刻清掉条目 —— 否则每重画一次都在性能时间线里留一条，长时间运行会无界增长。
 * @param {string} label 路径名（如 '重画列表' / '一次刷新'）
 * @returns {string|number} 句柄，原样交回 perfEnd
 */
function perfStart(label: string) : string|number {
  if (typeof performance !== 'undefined' && performance && typeof performance.mark === 'function') {
    const mark = `notes:${label}:start`
    try { performance.mark(mark); return mark } catch (_) { /* 退回 now() */ }
  }
  return perfNow()
}

/** @param {string} label @param {string|number} token perfStart 的返回值 @param {number} count 参与渲染的卡片数 */
function perfEnd(label: string, token: string | number, count: number): number {
  let ms = 0
  if (typeof token === 'string' && typeof performance !== 'undefined' && performance && typeof performance.measure === 'function') {
    const endMark = `notes:${label}:end`
    try {
      performance.mark(endMark)
      ms = performance.measure(`notes:${label}`, token, endMark).duration
    } catch (_) { ms = 0 }
  } else {
    ms = perfNow() - Number(token || 0)
  }
  if (ms > PERF_WARN_MS) {
    console.warn(`[notes] ${label}用时 ${Math.round(ms)}ms（${count} 张卡）`)
    return ms // 超阈值 → 保留时间线条目供 DevTools 查看
  }
  clearPerfEntries(label)
  return ms
}

/** 清掉一条路径的 mark / measure（低于阈值时用，避免性能时间线无界增长）。 */
function clearPerfEntries(label: string): void {
  if (typeof performance === 'undefined' || !performance || typeof performance.clearMarks !== 'function') return
  try {
    performance.clearMarks(`notes:${label}:start`)
    performance.clearMarks(`notes:${label}:end`)
    if (typeof performance.clearMeasures === 'function') performance.clearMeasures(`notes:${label}`)
  } catch (_) {}
}

export { perfStart, perfEnd }


export function createNotesModel(client: NotesPanelClient, options: NotesModelOptions = {}) {
  const onChange = options.onChange ?? (() => {})
  // 非致命错误出口（刷新失败但**仍有上一份数据**时用）：面板侧把它接到既有 toast 上，
  // 于是"某条 IPC 挂了"不会变成整块错误页，只是一次轻提示。
  const onError = options.onError ?? (() => {})
  const tabs = options.tabs ?? null
  // 面板级**视图偏好**（折叠态这类"只有视图在乎"的小状态）走设置域持久化 ——
  // 与笔记数据分开：它不是用户的资产，换台机器丢了也不可惜，但重开面板要记得住。
  const prefs = options.prefs ?? null

  const state: NotesPanelState = {
    loaded: false,
    error: null,
    notes: [],
    folders: [],
    counts: { __all: 0, __unfiled: 0, __trash: 0 },
    /** undefined = 顶层；null 视为顶层；字符串 = 站在某个集锦里（仅 collections 分段使用） */
    scopeFolderId: undefined,
    expanded: new Set<string>(),
    /** 「未归档」分组是否收起（持久化在设置域，见 prefs / VIEW_PREF_KEYS）。 */
    unfiledCollapsed: false,
    query: '',
    /** 已选中的标签过滤器（AND 语义：多选时只留同时命中全部标签的笔记） */
    activeTags: [],
    /** 已选中的卡片类型过滤器（空 = 不过滤；多选 = 并集） */
    kindFilter: [],
    sort: 'modified',
    mode: 'list',
    activeNoteId: null,
    /** 面板级分段（见 NOTE_SECTIONS）。默认落在「集锦」—— 这是集锦面板的主语。 */
    section: 'collections',
    /** 引用计数 `{ [noteId]: number }`（列表画 ↩N 徽标） */
    refCounts: {},
    /** 回收站列表（仅 trash 分段会拉取） */
    trash: [],
    /** 跳转后要高亮的那张卡（跨集锦跳转时给出落点提示；下一次导航自动清除） */
    highlightId: null,
    /**
     * 多选（经典集锦的复选框批量）：**卡片 id 的集合**。
     * 放在 model 而不是视图 —— 重画（切分段 / 搜索 / 收录后 reload）后必须保持选中，
     * 视图每次 render 都会重建 DOM，选中的 fact 只有 model 记得住。
     */
    selected: new Set<string>()
  }

  let refreshRaf: number | TimerHandle | null = null // 刷新合流句柄（rAF/兜底 setTimeout，见 scheduleRefresh）
  let pendingRefreshReason: string | null = null // 待处理刷新的原因（不可见时挂起，可见时补一次）
  let reloadSeq = 0                // 竞态保护：只接受最后一次发起的刷新结果
  let saveTimer: TimerHandle | null = null
  let pendingPatch: UpdateNoteInput | null = null
  let unsubscribe: (() => void) | null = null
  let onVisibility: (() => void) | null = null
  let legacyDone = false

  function emit() {
    try {
      onChange()
    } catch (e) {
      console.error('[notes-panel] onChange error:', e)
    }
  }

  // ── 加载 ────────────────────────────────────────────────

  /** 面板当前是否可见（不可见时不刷新：侧栏切走 / 收起时的刷新全是白跑）。 */
  function isPanelVisible() {
    return !(typeof document !== 'undefined' && document && document.visibilityState === 'hidden')
  }

  /** 把一次 IPC 包成"成功/失败都返回结果"的信封 —— 一次刷新里各条互不拖累。 */
  function settle<T>(promise: PromiseLike<T> | T): Promise<
    { ok: true; value: T } | { ok: false; error: unknown }
  > {
    return Promise.resolve(promise).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
  }

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  /**
   * 拉一次数据。
   *
   * ── 并行 + 按需（见文件头 STRUCTURAL_REASONS）─────────────────────────
   * 四个取数**并行**发出（一次刷新只一个往返，而不是 list → refCounts → trash 串行三趟，
   * 那三趟的延迟是**相加**的）；计数类（folders / folderCounts / refCounts）只在
   * **结构性变更**时才拉 —— 纯文本更新（reason='update'）下它们只是别处的投影，不拉。
   *
   * ── 失败不清空（保命）────────────────────────────────────────────────
   * 每一条 IPC 单独兜底：失败的**保留上一份数据继续显示**，绝不把列表清空；
   * 已经有数据时给一次轻提示（onError → toast），而不是整块变成错误页。
   *
   * ── 竞态保护 ────────────────────────────────────────────────────────
   * `seq` 单调递增，只有最后一次发起的刷新能把结果写回 state（慢的旧请求回来会被丢弃）。
   *
   * @param {string} reason 触发原因（'manual' 或 note:changed 的 reason）
   */
  async function reload(reason: string = 'manual') {
    const seq = ++reloadSeq
    const structural = reason === 'manual' || STRUCTURAL_REASONS.has(reason)
    const t0 = perfStart('一次刷新')
    const [notesRes, foldersRes, countsRes, refRes, trashRes] = await Promise.all([
      settle(client.list()),
      structural ? settle(client.folders()) : Promise.resolve(null),
      structural ? settle(client.folderCounts()) : Promise.resolve(null),
      structural ? settle(client.refCounts()) : Promise.resolve(null),
      // 回收站只在真正看着它时才拉（多一次 IPC 只为一块看不见的列表不划算）。
      state.section === 'trash' ? settle(client.trash()) : Promise.resolve(null)
    ])
    if (seq !== reloadSeq) return // 已有更新的一次刷新接管 → 丢弃本次结果

    let failed = false
    if (notesRes.ok) {
      state.notes = Array.isArray(notesRes.value) ? notesRes.value : []
      state.error = null
    } else {
      failed = true
      // 首次加载就失败 → 没有上一份数据可留，给整页错误态；否则**保留旧列表**（不清空）。
      if (!state.loaded) state.error = errorText(notesRes.error)
    }
    if (foldersRes) {
      if (foldersRes.ok) state.folders = Array.isArray(foldersRes.value) ? foldersRes.value : []
      else failed = true
    }
    if (countsRes) {
      if (countsRes.ok) {
        state.counts = countsRes.value && typeof countsRes.value === 'object'
          ? countsRes.value
          : { __all: 0, __unfiled: 0, __trash: 0 }
      } else failed = true
    }
    if (refRes) {
      if (refRes.ok) state.refCounts = refRes.value && typeof refRes.value === 'object' ? refRes.value : {}
      else failed = true
    }
    if (trashRes) {
      if (trashRes.ok) state.trash = Array.isArray(trashRes.value) ? trashRes.value : []
      else failed = true
    }

    state.loaded = true
    // 多选要**跟着数据收口**：被别处删掉 / 移走（切了集锦）的卡片不该再占着选中位，
    // 否则批量栏会显示"已选 3"却只对得上 1 张卡（点了删除只删掉看得见的那张）。
    if (state.selected.size) {
      const alive = new Set(state.notes.map((n) => n.id))
      for (const id of [...state.selected]) if (!alive.has(id)) state.selected.delete(id)
    }
    // 正在编辑的笔记被别处删掉了 → 退回列表（否则编辑器会对着一个不存在的 id 写）。
    if (state.mode === 'edit' && !state.notes.some((n) => n.id === state.activeNoteId)) {
      state.mode = 'list'
      state.activeNoteId = null
    }
    emit()
    // 有旧数据时，失败只做一次轻提示（不清空、不打断）；首次加载失败已走整页错误态。
    if (failed && state.error == null) {
      onError(notesRes.ok ? '集锦部分数据刷新失败，仍显示上一次的内容' : '集锦刷新失败，仍显示上一次的内容')
    }
    perfEnd('一次刷新', t0, state.notes.length)
  }

  /** 同一帧内多条变更合并：只要有一条是结构性的，整体就按结构性口径刷新。 */
  function mergeReason(a: string | null, b: string | null): string | null {
    if (!a) return b
    if (!b) return a
    if (STRUCTURAL_REASONS.has(a)) return a
    if (STRUCTURAL_REASONS.has(b)) return b
    return 'update'
  }

  /**
   * 变更推送 → **合并成一次刷新**。
   *
   * 为什么合并：域层每次写（含**自动保存每 200ms 落一次库**）都会发一条 note:changed，
   * 拖拽重排 / 批量操作更是一串连发。"一条一来就刷新"等于对自己的 IPC 通道做自我 DOS ——
   * 所以用 requestAnimationFrame 把它们并成一帧一次（同一帧内的多条只留一个合并后的 reason）。
   *
   * 面板不可见时不刷新：把原因挂起，等可见时补一次（见 init 里的 visibilitychange）。
   */
  function scheduleRefresh(reason = 'manual') {
    pendingRefreshReason = mergeReason(pendingRefreshReason, reason)
    if (!isPanelVisible()) return // 不可见 → 先挂起，可见时补
    if (refreshRaf != null) return
    const raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (fn: (time: number) => void): number => setTimeout(() => fn(Date.now()), 16) as unknown as number
    refreshRaf = raf(() => {
      refreshRaf = null
      const r = pendingRefreshReason || 'manual'
      pendingRefreshReason = null
      reload(r)
    })
  }

  /**
   * 把 NG 过渡期存在 localStorage 的笔记搬进数据库。**只做一次的搬家**，
   * 不是持续同步 —— 之后 localStorage 那份被删掉，唯一真源是数据库。
   */
  async function importLegacyOnce() {
    if (legacyDone) return
    legacyDone = true
    if (state.notes.length > 0 || state.folders.length > 0) {
      try { localStorage.removeItem(LEGACY_STORAGE_KEY) } catch (_) {}
      return
    }
    /** @type {any} */
    let raw: unknown = null
    try {
      raw = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null')
    } catch (_) {
      raw = null
    }
    if (!Array.isArray(raw) || raw.length === 0) return
    try {
      // 老数据是「新的在前」（unshift 写入），逐条 add 会反序 → 从尾到头倒着搬。
      for (const item of raw.slice().reverse()) {
        if (!item || typeof item !== 'object') continue
        await client.add({ title: item.title || '', content: item.content || '' })
      }
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch (e) {
      console.warn('[notes-panel] 旧数据搬迁失败，保留 localStorage 原样:', e)
    }
  }

  /**
   * 读一次视图偏好（面板首帧前）。
   * 拿不到就留在默认值 —— 设置 IPC 迟到 / 被禁用不该挡住面板首屏。
   */
  async function loadViewPrefs() {
    if (!prefs || typeof prefs.get !== 'function') return
    try {
      const value = await prefs.get(VIEW_PREF_KEYS.unfiledCollapsed)
      if (typeof value === 'boolean') state.unfiledCollapsed = value
    } catch (_) {}
  }

  async function init() {
    await loadViewPrefs()
    await reload()
    await importLegacyOnce()
    if (!unsubscribe) {
      unsubscribe = client.onChanged((payload) => {
        const reason = (payload && payload.reason) || 'update'
        const id = payload && payload.id
        // 只有"这条卡可能已经不在库里了"的 reason 才值得打断正在编辑的这条：
        //   · remove / purge —— 别处删了 / 真删了你正在写的这条，必须退回列表（否则编辑器
        //     会对着一个不存在的 id 继续写）；
        //   · 其余（update / add / reorder / folder-* …）对它都是"内容或位置变了"，而本地
        //     （本面板就是写入方）已是最新：重载不仅白跑 IPC，还会在 renderEditor 里冒失地
        //     重设输入框、抢走光标。'add' 之所以也跳过，是因为这条正是本面板刚建出来、正在编辑的那条。
        const mayBeGone = reason === 'remove' || reason === 'purge'
        if (state.mode === 'edit' && id && id === state.activeNoteId && !mayBeGone) return
        scheduleRefresh(reason)
      })
    }
    if (!onVisibility && typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
      onVisibility = () => {
        // 可见时补一次挂起的刷新：不可见期间累积的变更在这里一次性收口（期间一条都不打 IPC）。
        if (isPanelVisible() && pendingRefreshReason) scheduleRefresh(pendingRefreshReason)
      }
      document.addEventListener('visibilitychange', onVisibility)
    }
  }

  function dispose() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    if (refreshRaf != null) {
      if (typeof refreshRaf === 'number' && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(refreshRaf)
      else clearTimeout(refreshRaf)
      refreshRaf = null
    }
    pendingRefreshReason = null
    if (onVisibility && typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
    onVisibility = null
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  }

  // ── 选择器 ──────────────────────────────────────────────

  function childFolders(parentId: string | null): NoteFolder[] {
    const key = parentId == null ? null : String(parentId)
    return state.folders
      .filter((f) => (f.parentId || null) === key)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
  }

  function hasChildFolders(id: string): boolean {
    return state.folders.some((f) => f.parentId === id)
  }

  function folderLabel(id: string | null | undefined): string {
    if (id === undefined || id === null) return '全部笔记'
    const f = state.folders.find((x) => x.id === id)
    return f ? f.name : '笔记'
  }

  /** 当前作用域的父级（undefined = 顶层根目录；null 视为顶层）。 */
  function scopeParentId() {
    return state.scopeFolderId === undefined || state.scopeFolderId === null ? null : state.scopeFolderId
  }

  /** 某文件夹的父级 id（null = 顶层）。 */
  function parentFolderId(id: string | null): string | null {
    const f = state.folders.find((x) => x.id === id)
    return f ? (f.parentId || null) : null
  }

  /** 从顶层到该文件夹的名字链（面包屑用）。 */
  function folderPath(id: string | null): string[] {
    const chain: string[] = []
    let cur = id
    let guard = 0
    while (cur && guard++ < 64) {
      const f = state.folders.find((x) => x.id === cur)
      if (!f) break
      chain.unshift(f.name)
      cur = f.parentId || null
    }
    return chain
  }

  /**
   * 「稍后读」文件夹的 id 集合（**含其后代**）。
   *
   * 为什么含后代：用户完全可能在「稍后读」下再建分类（「稍后读 / 技术」…）——
   * 移进去的条目不该从清单里凭空消失，否则用户会以为"条目丢了"。
   *
   * 文件夹不存在时返回空集合（清单为空 → 视图给出引导文案，见 panel-notes.view）。
   * 注意这里**不创建**文件夹：读取侧只读，"新建文件夹"是写入侧（右键加入稍后读）的职责。
   * @returns {Set<string>}
   */
  function readingFolderIds() : Set<string> {
    const root = state.folders.find((f) => f && f.name === READING_LIST_FOLDER)
    if (!root || !root.id) return new Set()
    const out = new Set<string>([String(root.id)])
    for (const id of descendantFolderIds(root.id)) out.add(String(id))
    return out
  }

  /**
   * 当前分段的**基集**（还没排序，也还没做搜索/标签/类型过滤）。
   *
   * 层级语义（仅 collections 分段）：**卡片只出现在它所属的那一层**。
   *   · 顶层（scope 未进入任何集锦）→ 只有 `folderId === null` 的卡片；
   *   · 进入某集锦 → 只有 `folderId === 该集锦` 的卡片。
   * 早先"顶层把所有卡片铺平"的写法会让放进集锦的卡片同时出现在根目录 —— 那正是
   * 「全在根目录放着」的来源。
   *
   * all 分段刻意**忽略层级**：它就是"一次看完所有卡片"，与文件夹树浏览是两件事。
   * reading / trash 各自的基集在别处（reading 见下；trash 用 state.trash）。
   */
  function sectionNotes() {
    if (state.section === 'reading') {
      const ids = readingFolderIds()
      return state.notes.filter((n) => ids.has(String((n && n.folderId) || '')))
    }
    if (state.section === 'all') return state.notes
    if (state.section === 'collections') {
      const key = scopeParentId()
      return state.notes.filter((n) => (n.folderId || null) === key)
    }
    return [] // trash 走 trashItems()
  }

  /**
   * 当前分段下、经搜索 / 标签 / 类型过滤并排好序的卡片。
   * 排序：置顶恒优先（不变），其余按所选排序。
   */
  function visibleNotes() {
    let list = sectionNotes()
    const q = state.query.trim().toLowerCase()
    if (q) {
      // 搜索是**显式动作**，跨集锦找一条卡片才有意义（结果行会标出它属于哪个集锦）。
      // 各分段都生效；source_title 一并纳入（抓取的网页标题与页面标题可能不同）。
      list = list.filter((n) =>
        String(n.title || '').toLowerCase().includes(q) ||
        String(n.content || '').toLowerCase().includes(q) ||
        String(n.url || '').toLowerCase().includes(q) ||
        String(n.sourceTitle || '').toLowerCase().includes(q) ||
        (n.tags || []).some((t) => String(t).toLowerCase().includes(q)))
    }
    if (state.activeTags.length) {
      list = list.filter((n) => state.activeTags.every((t) => (n.tags || []).includes(t)))
    }
    if (state.kindFilter.length) {
      list = list.filter((n) => state.kindFilter.includes(normalizeKind(n.kind)))
    }
    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    return list.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (state.sort === 'title') return collator.compare(displayTitle(a), displayTitle(b))
      if (state.sort === 'created') return (b.createdAt || 0) - (a.createdAt || 0)
      return (b.modifiedAt || 0) - (a.modifiedAt || 0)
    })
  }

  /** 全部标签（去重 + 稳定排序）—— 标签筛选条用它。基于**全部**卡片而非当前作用域，
   *  否则切一个集锦标签条就会变，用户会以为"标签没了"。 */
  function allTags() {
    const seen = new Set<string>()
    for (const n of state.notes) {
      for (const t of n.tags || []) {
        const v = String(t || '').trim()
        if (v) seen.add(v)
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }

  /** 某文件夹的全部后代 id（拖拽防环：不能把文件夹拖进自己的子树）。 */
  function descendantFolderIds(id: string): Set<string> {
    const out = new Set<string>()
    let grew = true
    while (grew) {
      grew = false
      for (const f of state.folders) {
        if (out.has(f.id)) continue
        if (f.parentId === id || (f.parentId && out.has(f.parentId))) {
          out.add(f.id)
          grew = true
        }
      }
    }
    return out
  }

  /** 同一文件夹下的笔记 id（按持久顺序）—— 拖拽重排要回传"该文件夹下全部 id 的新顺序"。 */
  function siblingNoteIds(folderId: string | null): string[] {
    const key = folderId == null ? null : String(folderId)
    return state.notes
      .filter((n) => (n.folderId || null) === key)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.createdAt || 0) - (b.createdAt || 0))
      .map((n) => n.id)
  }

  /** 同一父级下的子文件夹 id（按持久顺序）。 */
  function siblingFolderIds(parentId: string | null): string[] {
    const key = parentId == null ? null : String(parentId)
    return state.folders
      .filter((f) => (f.parentId || null) === key)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.createdAt || 0) - (b.createdAt || 0))
      .map((f) => f.id)
  }

  /** 下拉/子菜单用的扁平文件夹列表（带缩进层级；首项是「未归档」）。 */
  function flatFolderOptions() {
    const out: Array<{ id: string | null; label: string; depth: number }> = [{ id: null, label: '未归档', depth: 0 }]
    const walk = (parentId: string | null, depth: number): void => {
      for (const f of childFolders(parentId)) {
        out.push({ id: f.id, label: f.name, depth })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 1)
    return out
  }

  function getNote(id: string | null): Note | null {
    return state.notes.find((n) => n.id === id) || null
  }

  function getActiveNote() {
    return state.mode === 'edit' ? getNote(state.activeNoteId) : null
  }

  /** 某集锦的卡片数（来自 folderCounts；不含回收站）。 */
  function folderCount(id: string): number {
    return Number((state.counts && state.counts[id]) || 0)
  }

  /** 未归档卡片数。 */
  function unfiledCount() {
    return Number((state.counts && state.counts.__unfiled) || 0)
  }

  /** 回收站条数（来自 folderCounts.__trash；**绝不并进 __all/__unfiled**）。 */
  function trashCount() {
    return Number((state.counts && state.counts.__trash) || 0)
  }

  /** 引用计数（列表画 ↩N）。 */
  function refCount(id: string): number {
    return Number((state.refCounts && state.refCounts[id]) || 0)
  }

  /**
   * 某集锦的**封面图路径列表**（最多 `limit` 张，按卡片顺序去重）—— 集锦卡片墙用它拼封面。
   *
   * 为什么是"几张拼起来"而不是"第一张"：
   *   · 集锦里可能既有网页缩略图又有图片卡缩略图，拼图能一眼看出"这个集锦里有什么"；
   *   · 只取第一张在"第一张恰好是无图卡片"时就会退成文件夹图标，拼图更不容易落空。
   * 路径优先 `thumbPath`（列表口径的小图），没有才退回 `assetPath`；**什么都没有的卡跳过**。
   * 返回空数组 = 该集锦没有任何可见图 → 视图退成文件夹图标（有图才有封面）。
   * @param {string|null} id 集锦（文件夹）id
   * @param {number} [limit]
   * @returns {string[]}
   */
  function folderCoverPaths(id: string|null, limit: number = 3) : string[] {
    const key = id == null ? null : String(id)
    const out: string[] = []
    for (const n of state.notes) {
      if ((n.folderId || null) !== key) continue
      const p = n.thumbPath || n.assetPath
      if (p && !out.includes(p)) {
        out.push(p)
        if (out.length >= limit) break
      }
    }
    return out
  }

  /** 某集锦的「更新时间」= 其中卡片的最大修改时间（无卡片时退回文件夹自身的创建时间）。 */
  function folderUpdatedAt(id: string): number {
    let max = 0
    for (const n of state.notes) {
      if ((n.folderId || null) === (id || null)) {
        const t = noteTime(n)
        if (t > max) max = t
      }
    }
    if (max) return max
    const f = state.folders.find((x) => x.id === id)
    return f ? Number(f.createdAt || 0) || 0 : 0
  }

  /** 引用卡的目标卡（已删/找不到 → null，视图据此降级为「已失效的引用」）。 */
  function refTarget(note: Note): Note | null {
    if (!note || note.kind !== 'ref' || !note.refId) return null
    return getNote(note.refId)
  }

  /**
   * 正文内联引用 chip 需要的信息（芯片渲染的唯一出口）。
   * 只认 id → 目标卡在不在库里：找不到时给 `missing`，由渲染层画灰 chip（**绝不静默消失**，
   * 否则用户会以为这条引用从没写进去过 —— 与引用卡的失效降级同一口径）。
   */
  function refChipInfo(id: string): { id: string; title: string | null; missing: boolean } {
    const note = getNote(id)
    if (!note) return { id: String(id || ''), title: null, missing: true }
    return { id: note.id, title: displayTitle(note), missing: false }
  }

  // `@` 补全候选（mentionCandidates）已移除：`@` 补全属于"长文笔记应用"的写法，
  // 与集锦「记录 / 备忘 / 暂存」的定位不符（面板第一职责是快速收进来 + 快速取用）。
  // 正文引用仍可通过卡片的 `⋯ → 复制引用 / 在此处插入引用` 完成，链路不受影响。

  // ── 多选（经典集锦的复选框批量）─────────────────────────

  function isSelected(id: string): boolean { return state.selected.has(id) }
  function selectedCount(): number { return state.selected.size }
  function selectedIds(): string[] { return [...state.selected] }

  /** 点击即切换（**不需要按 Ctrl** —— 与仓库既有的勾选约定一致）。 */
  function toggleSelect(id: string): void {
    if (!id) return
    if (state.selected.has(id)) state.selected.delete(id)
    else state.selected.add(id)
    emit()
  }
  function clearSelection() {
    if (!state.selected.size) return
    state.selected.clear()
    emit()
  }

  /** 选中项的引用 URI，逐行（「复制引用」写剪贴板用；构造走共享真源的 noteRefUri）。 */
  function selectedRefsText() {
    return selectedIds().map((id) => noteRefUri(id)).join('\n')
  }

  /** 批量移动：逐张 move（域层的 move 会重排到目标集锦末尾），完成后清空选择。 */
  async function moveSelectedTo(folderId: string | null) {
    const ids = selectedIds()
    if (!ids.length) return
    for (const id of ids) await client.move(id, folderId == null ? null : String(folderId))
    state.selected.clear()
    await reload()
  }

  /** 批量删除：逐张软删（进回收站，可恢复 —— 与单卡删除同一条口径）。完成后清空选择。 */
  async function deleteSelected() {
    const ids = selectedIds()
    if (!ids.length) return
    for (const id of ids) await client.remove(id)
    state.selected.clear()
    await reload()
  }

  /** 某集锦里的卡片（集锦级动作：全部打开 / 复制全部 / 导出）。 */
  function cardsInCollection(folderId: string | null): Note[] {
    const key = folderId == null ? null : String(folderId)
    // 顺序口径来自 shared-types#sortNotesForDisplay —— 主进程 `note:*` 动作取的是同一份定义。
    const cards = state.notes.filter((n) => (n.folderId || null) === key)
    return sortNotesForDisplay(cards as unknown as Parameters<typeof sortNotesForDisplay>[0]) as unknown as Note[]
  }

  /** 回收站列表（视图用）。 */
  function trashItems(): Note[] {
    return state.trash.slice()
  }

  // ── 动作：分段 / 过滤 ───────────────────────────────────

  function setQuery(query: unknown): void {
    state.query = String(query || '')
    state.highlightId = null
    emit()
  }
  function setSort(sort: unknown): void {
    const next = String(sort)
    state.sort = NOTE_SORTS.some((s) => s.id === next) ? next as NotesPanelState['sort'] : 'modified'
    emit()
  }

  /**
   * 切换面板分段（见 NOTE_SECTIONS）。越界值由 normalizeNoteSection（shared 真源）归一。
   * 正在编辑时先落盘并退回列表：否则"切了分段，屏幕上还停着编辑器"，而它下面的列表
   * 已经换了内容 —— 用户会觉得"点了没反应"。
   */
  function setSection(section: unknown): void {
    const next = normalizeNoteSection(section)
    if (next === state.section) return
    state.section = next
    state.highlightId = null
    if (state.mode === 'edit') {
      flushActive()
      state.mode = 'list'
      state.activeNoteId = null
    }
    // 回收站要拉一份 trash 列表；其余分段复用已有 state.notes。
    if (next === 'trash') reload()
    else emit()
  }

  function isReadingSection() { return state.section === 'reading' }
  function isTrashSection() { return state.section === 'trash' }
  function isCollectionsSection() { return state.section === 'collections' }

  /** 标签筛选条的开关（多选 = 交集）。 */
  function toggleTag(tag: unknown): void {
    const t = String(tag || '').trim()
    if (!t) return
    const i = state.activeTags.indexOf(t)
    if (i >= 0) state.activeTags.splice(i, 1)
    else state.activeTags.push(t)
    emit()
  }
  function clearTags() {
    if (!state.activeTags.length) return
    state.activeTags = []
    emit()
  }

  /** 类型过滤（多选 = 并集）。 */
  function toggleKindFilter(kind: unknown): void {
    const k = normalizeKind(kind)
    const i = state.kindFilter.indexOf(k)
    if (i >= 0) state.kindFilter.splice(i, 1)
    else state.kindFilter.push(k)
    emit()
  }
  function clearKindFilter() {
    if (!state.kindFilter.length) return
    state.kindFilter = []
    emit()
  }

  /** 进入某集锦（`undefined`/`null` = 回到顶层根目录）。 */
  function openFolder(id: string | null | undefined): void {
    state.scopeFolderId = id == null ? undefined : id
    state.section = 'collections'
    state.mode = 'list'
    state.activeNoteId = null
    state.highlightId = null
    emit()
  }
  /** 返回上一层（顶层时保持不动）。 */
  function goUp() {
    const cur = state.scopeFolderId
    if (cur === undefined || cur === null) return
    openFolder(parentFolderId(cur))
  }
  function toggleExpand(id: string): void {
    if (state.expanded.has(id)) state.expanded.delete(id)
    else state.expanded.add(id)
    emit()
  }

  /** 「未归档」分组当前是否收起。 */
  function unfiledCollapsed() {
    return state.unfiledCollapsed === true
  }

  /** 收起 / 展开「未归档」分组 —— 先改本地（立即生效），再异步落设置域。 */
  function toggleUnfiled() {
    state.unfiledCollapsed = !state.unfiledCollapsed
    if (prefs && typeof prefs.set === 'function') {
      try {
        Promise.resolve(prefs.set(VIEW_PREF_KEYS.unfiledCollapsed, state.unfiledCollapsed)).catch(() => {})
      } catch (_) {}
    }
    emit()
  }
  function openNote(id: string): void {
    if (!getNote(id)) return
    state.activeNoteId = id
    state.mode = 'edit'
    state.highlightId = null
    emit()
  }
  function backToList() {
    flushActive()
    state.mode = 'list'
    state.activeNoteId = null
    emit()
  }

  /**
   * 跳到某张卡片所在的集锦并高亮（反链 chip 点击用）。
   * 目标可能在别的集锦里 —— 所以先切回 collections 分段、再进入它那一层。
   */
  function revealNote(id: string): void {
    const note = getNote(id)
    if (!note) return
    state.section = 'collections'
    state.scopeFolderId = note.folderId || undefined
    state.mode = 'list'
    state.activeNoteId = null
    state.highlightId = id
    emit()
  }

  /** 高亮到达目标卡的锚点后清除（视图滚动到位后调用）。 */
  function clearHighlight() {
    if (state.highlightId == null) return
    state.highlightId = null
    emit()
  }

  // ── 卡片主动作（单击分派：**唯一真源**）──────────────────
  //
  // 「网页就是网页，卡片就是卡片」—— 一张卡单击该做什么，由它的 kind 决定，且**只在本
  // 函数里判一次**（视图只负责调用它，并把返回结果里需要 DOM 的那两种呈现出来）。
  // 铁律：**单击绝不能让非 note 卡进编辑器**。
  //   · 页面卡点开就该打开那个网页（它没有"正文"可写，进编辑器纯属荒谬）；
  //   · 图片卡点开就该看图（原图 / 缩略图预览），而不是进一个"编辑图片标题"的表单；
  //   · 片段有来源就去来源页，没有就把原文复制走（用户要的是"取用"，不是"编辑"）；
  //   · 引用卡点开就跳到目标卡；
  //   · 只有 note 卡单击进编辑 —— 笔记本来就是拿来写的。
  // 「改标题 / 改描述」对非 note 卡是**次要动作**，收在卡片的 `⋯` 菜单里（编辑标题与描述），
  // 任何路径（含恢复状态）都不许让非 note 卡自动进编辑态。
  //
  // 复用既有 API：openUrl（标签客户端打开）/ assetOpen（系统看图）/ revealNote（跳目标）/
  // openNote（进编辑）。返回一个结果描述，视图据此做两件纯呈现的事（写剪贴板 + 大图预览）。
  // @param {any|string} note 卡片对象或 id
  // @returns {Promise<{type:'opened'|'open-url'|'preview-image'|'copy-text'|'editing'|'revealed'|'none',
  //                    url?:string, text?:string, path?:string}>}
  async function primaryAction(note: Note | string): Promise<{
    type: 'opened' | 'open-url' | 'preview-image' | 'copy-text' | 'editing' | 'revealed' | 'none'
    url?: string
    text?: string
    path?: string
  }> {
    const n = typeof note === 'string' ? getNote(note) : note
    if (!n) return { type: 'none' }
    switch (normalizeKind(n.kind)) {
      case 'page': {
        if (!n.url) return { type: 'none' }
        if (folderLabel(n.folderId) === PAGE_ARCHIVE_FOLDER) {
          const url = pageUrl('archive', { id: n.id })
          return (await openUrl(url)) ? { type: 'opened' } : { type: 'open-url', url }
        }
        // 走既有"打开链接"口径：能走标签客户端就用新标签打开；走不通交视图 window.open 兜底。
        return (await openUrl(n.url)) ? { type: 'opened' } : { type: 'open-url', url: n.url }
      }
      case 'image': {
        // 有原图 → 用系统默认程序打开；只有缩略图（oversize 降级）→ 面板内大图预览。
        if (n.assetPath) {
          try { await assetOpen(n.assetPath) } catch (_) {}
          return { type: 'opened' }
        }
        if (n.thumbPath) return { type: 'preview-image', path: n.thumbPath }
        return { type: 'none' }
      }
      case 'snippet': {
        if (n.url) return (await openUrl(n.url)) ? { type: 'opened' } : { type: 'open-url', url: n.url }
        return { type: 'copy-text', text: String(n.content || '') }
      }
      case 'ref': {
        const target = refTarget(n)
        if (!target) return { type: 'none' }
        revealNote(target.id)
        return { type: 'revealed' }
      }
      case 'note':
      default: {
        // 只有 note 卡单击进编辑（见上面的铁律）。
        openNote(n.id)
        return { type: 'editing' }
      }
    }
  }

  // ── 动作：笔记 ──────────────────────────────────────────

  /**
   * 面板侧所有"新收进来的东西"落到哪个集锦 —— **一条规则，只有这一处**：
   *   · 正站在某个集锦里（`scopeFolderId` 是字符串）→ 就放它；
   *   · 在根态（顶层 / 「全部」分段）→ **未归档**（`folderId: null`，域层的"根级"那一态）。
   *
   * ── 为什么不"没有集锦就自动建一个默认集锦"────────────────────────────
   * 面板里**没有任何"收进哪里"的选择器**（窄侧栏里再塞一层选择浮层是负收益），所以这里必须
   * 用"用户此刻看得见的那一层"当落点。早先的实现会在根态**自动建一个名为「集锦」的文件夹**
   * 再把卡片塞进去 —— 那是一个用户从没点过、却凭空出现的目录，而且它与「未归档」这一态
   * （域层显式存在的语义）互相打脸：同一批卡片在不同入口下会落到两个不同的地方。
   * 现在统一成"当前集锦 / 未归档"，与四个原生菜单入口（都有显式「未归档」项）同一口径。
   *
   * ⚠ 想收进别的集锦：在面板里进那个集锦再收，或走标签右键 / 页面右键 / 应用菜单（都有选择器）。
   * @returns {string|null}
   */
  function currentCaptureFolderId() : string|null {
    return typeof state.scopeFolderId === 'string' ? state.scopeFolderId : null
  }

  /** 新笔记落到「当前所在集锦 / 未归档」（见 currentCaptureFolderId）。 */
  async function createNote(extra: AddNoteInput = {}) {
    const folderId = typeof extra.folderId === 'string' || extra.folderId === null
      ? extra.folderId
      : currentCaptureFolderId()
    const note = await client.add({ title: '', content: '', folderId, ...extra })
    if (note && note.id) {
      state.notes.unshift(note)
      state.activeNoteId = note.id
      state.mode = 'edit'
      emit()
      // 后台补一次真实数据：文件夹计数/排序要立刻正确，而这两样只有库里有。
      reload()
    }
    return note
  }

  /** 「+ 备注」：在当前（或未归档）集锦里新建一张 kind='note' 空卡并聚焦编辑器。 */
  async function createNoteCard() {
    return createNote({ kind: 'note', folderId: currentCaptureFolderId() })
  }

  /**
   * 「+ 添加当前页面」：把**发送方窗口的活动标签**收成一张 kind='page' 卡片
   * （同集锦同 URL 会被域层去重）。
   *
   * ── 渲染层只发"我要收当前页"这个意图 ──────────────────────────────────
   * 这里**不带 url / title / tabId**：主进程按 IPC 发送方（`runWithSender`）解析到本面板所属
   * 窗口，再用它的 `tabManager.getActiveTabId()` + `getWebContents(id)` 取权威 url/title 与
   * 缩略图来源（见 ipc/notes.js#resolvePageSource）。理由见 panel-notes.renderer 的注释：
   * 「哪个标签是活动标签」只有主进程是权威，渲染层那份只是一个还会按空间过滤的投影。
   *
   * 拿不到可用网页（内部页 / 没有活动标签）时主进程会退化成一条 note（不让按钮变成"没反应"）。
   */
  async function captureCurrentPage() {
    const folderId = currentCaptureFolderId()
    const note = await client.capture({ kind: 'page', folderId })
    // 收完把视线带到落点并高亮新卡 —— 否则在根态收录会"点了没反应"。
    state.section = 'collections'
    state.scopeFolderId = note && note.folderId ? note.folderId : undefined
    if (note && note.id) state.highlightId = note.id
    await reload()
    return note
  }

  /**
   * 把 `note.capture-provider` 插槽产出的输入落成一张卡。
   *
   * provider 只产出「要收什么」（`{ kind, url, title, content, tags… }`，形状即
   * `note:capture` 的请求体），**落点仍由面板决定**：没显式给 folderId 时跟着当前所在集锦，
   * 与内建「添加当前页面」同一口径。一个 provider 返回空 → 当作用户取消，静默收场。
   */
  async function captureInput(input: CaptureNoteInput & { tabId?: string }) {
    const payload = input && typeof input === 'object' ? { ...input } : null
    if (!payload) return null
    if (payload.folderId === undefined) payload.folderId = currentCaptureFolderId()
    const note = await client.capture(payload)
    return afterCapture(note)
  }

  async function deleteNote(id: string) {
    await client.remove(id)
    state.notes = state.notes.filter((n) => n.id !== id)
    if (state.activeNoteId === id) {
      state.mode = 'list'
      state.activeNoteId = null
    }
    emit()
    reload()
  }

  async function togglePin(id: string) {
    const note = getNote(id)
    if (!note) return
    const next = !note.pinned
    note.pinned = next // 乐观更新：置顶是"立刻要看到"的动作，等一次往返会显得迟钝
    emit()
    try {
      await client.pinSet(id, next)
    } catch (e) {
      note.pinned = !next
      emit()
    }
  }

  async function setColor(id: string, color: string | null) {
    const note = getNote(id)
    if (!note) return
    note.color = color || null
    emit()
    await client.update({ id, color: color || null })
  }

  async function moveNote(id: string, folderId: string | null) {
    await client.move(id, folderId)
    await reload()
  }

  /** 笔记拖动重排（同文件夹内）。 */
  async function reorderNotes(folderId: string | null, orderedIds: string[]) {
    await client.reorder(folderId, orderedIds)
    await reload()
  }

  /**
   * 拖拽落点：把一条笔记放进某文件夹的指定位置（跨文件夹时=移动 + 重排）。
   * @param {string} noteId
   * @param {string|null} folderId
   * @param {number|null} index 该文件夹下的插入位；null = 追加末尾
   */
  async function dropNote(noteId: string, folderId: string|null, index: number|null) {
    const siblings = siblingNoteIds(folderId).filter((id) => id !== noteId)
    const at = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length))
    siblings.splice(at, 0, noteId)
    await client.move(noteId, folderId)
    await client.reorder(folderId, siblings)
    await reload()
  }

  /** 更新标签（编辑器里的逗号分隔输入 → 数组）。 */
  async function setNoteTags(id: string, tags: string[]) {
    const clean = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean)
    const note = getNote(id)
    if (note) note.tags = clean
    emit()
    await client.update({ id, tags: clean })
  }

  /**
   * 写入 / 清空一张卡片的**注释便签**。
   *
   * 为什么存进卡片自己的 `content`（**不新建表 / 字段 / IPC**）：
   *   · 对 page / image 卡，`content` 的语义本就是"这条记录的描述/备注"（见 domain-notes 的
   *     add/update 参数与 notes.mjs 的注释），注释只是给它一个更贴切的呈现（卡片底部一条便签）；
   *   · 复用既有 `note:update` 通道即可，无需为"注释"单开一张表或一条通道 —— 那是
   *     "第 9 个收集实体"式的重复真源。
   * ⚠ 划词卡（snippet）的 `content` 是**摘录原文**（它存在的理由），故注释不适用于它
   *   （视图侧不给它「添加注释」入口，见 panel-notes.view#canAnnotate）；备注卡（note）本身就是笔记。
   * @param {string} id
   * @param {string} text
   */
  async function setCardNote(id: string, text: string) {
    const note = getNote(id)
    if (!note) return
    const value = String(text == null ? '' : text)
    note.content = value
    emit()
    await client.update({ id, content: value })
  }

  // ── 动作：编辑器 ────────────────────────────────────────

  /** 输入即存：合并同一阵连续输入，200ms 落一次库。 */
  function updateActive(patch: UpdateNoteInput) {
    const id = state.activeNoteId
    if (!id) return
    const note = getNote(id)
    if (note) Object.assign(note, patch)
    pendingPatch = Object.assign(pendingPatch || {}, patch)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushActive, 200)
  }

  function flushActive() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    const patch = pendingPatch
    pendingPatch = null
    const id = state.activeNoteId
    if (!id || !patch) return
    client.update({ id, ...patch }).catch((e) => console.warn('[notes-panel] 保存失败', e))
  }

  // ── 动作：文件夹（集锦）────────────────────────────────

  async function createFolder(parentId: string | null = null) {
    const created = await client.addFolder({ name: '新建集锦', parentId })
    const id = created.id
    if (parentId) state.expanded.add(parentId)
    await reload()
    return id
  }

  async function renameFolder(id: string, name: unknown) {
    const next = String(name || '').trim()
    if (!next) return false
    const folder = state.folders.find((f) => f.id === id)
    if (folder) folder.name = next
    emit()
    return client.renameFolder(id, next)
  }

  async function deleteFolder(id: string) {
    await client.removeFolder(id)
    if (state.scopeFolderId === id) state.scopeFolderId = undefined
    await reload()
  }

  /**
   * 拖拽落点：把文件夹放到某父级的指定位置。
   * @param {string} folderId
   * @param {string|null} parentId
   * @param {number|null} index 同级插入位；null = 追加末尾
   * @returns {Promise<boolean>} false = 落点非法（拖进自身/自己的后代）
   */
  async function dropFolder(folderId: string, parentId: string|null, index: number|null) : Promise<boolean> {
    if (!folderId || folderId === parentId) return false
    if (parentId && descendantFolderIds(folderId).has(parentId)) return false
    const siblings = siblingFolderIds(parentId).filter((id) => id !== folderId)
    const at = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length))
    siblings.splice(at, 0, folderId)
    await client.moveFolder(folderId, parentId)
    await client.reorderFolders(parentId, siblings)
    await reload()
    return true
  }

  // ── 动作：集锦级（全部打开 / 复制 / 导出内容）──────────

  /**
   * 在新标签里打开一组 URL。
   *
   * 降级说明：tabs 客户端**没有**"新窗口成组开标签"的能力（只有 `newTab`），
   * 所以经典集锦的「全部打开 = 新窗口一组标签」在这里降级为**逐个新标签**打开。
   */
  async function openAllInCollection(folderId: string | null) {
    const cards = cardsInCollection(folderId).filter((n) => n.kind === 'page' && n.url)
    for (const card of cards) {
      await openUrl(card.url)
    }
    return cards.length
  }

  /** 打开一个 URL（优先走标签客户端；没有则返回 false，由视图退回 window.open）。 */
  async function openUrl(url: unknown) {
    const u = String(url || '')
    if (!u) return false
    if (tabs && typeof tabs.newTab === 'function') {
      try { await tabs.newTab({ url: u }); return true } catch (_) { return false }
    }
    return false
  }

  /** 某集锦所有卡片的纯文本（视图写剪贴板）。 */
  function collectionPlainText(folderId: string | null) {
    return notesToPlainText(cardsInCollection(folderId) as unknown as Parameters<typeof notesToPlainText>[0])
  }

  /** 某集锦所有卡片的 Markdown（视图写剪贴板）。 */
  function collectionMarkdown(folderId: string | null) {
    return notesToMarkdown(
      cardsInCollection(folderId) as unknown as Parameters<typeof notesToMarkdown>[0],
      folderLabel(folderId)
    )
  }

  /** 引用 URI 由共享真源构造（与域层解析正文引用用的是同一 scheme）。 */
  function refLink(id: string) {
    return noteRefUri(id)
  }

  /** 「在此处插入引用」：在当前（或未归档）集锦追加一张指向 target 的引用卡。 */
  async function insertRefCard(target: Note) {
    if (!target || !target.id) return null
    const folderId = currentCaptureFolderId()
    const note = await client.add({
      kind: 'ref',
      refId: target.id,
      title: displayTitle(target),
      folderId
    })
    if (note && note.id) state.highlightId = note.id
    await reload()
    return note
  }

  // ── 动作：回收站 ────────────────────────────────────────

  async function restoreNote(id: string) {
    await client.restore(id)
    await reload()
  }
  async function purgeNote(id: string) {
    await client.purge(id)
    await reload()
  }
  async function emptyTrash() {
    await client.emptyTrash()
    await reload()
  }

  /** 反链（编辑器页脚 / 引用详情用）；已删来源卡带 missing:true。 */
  function backlinks(id: string) {
    return client.backlinks(id)
  }

  // ── 动作：图片资产 / 导入（P2）────────────────────────────

  /**
   * 读缩略图（或原图兜底）→ dataURL，供 `<img src>` 直接用。
   * 读不到回 null（视图据此回落类型图标占位）。
   * 刻意**不做缓存**：缓存归视图（同一张卡在同一次列表里会被画一次），
   * 模型这层每次如实问主进程 —— 主进程那侧才是真正的 LRU（见 notes-assets.js）。
   */
  async function assetThumb(path: string) {
    const p = String(path || '')
    if (!p) return null
    try {
      const res = await client.assetThumb(p)
      return (res && res.dataUrl) || null
    } catch (_) {
      return null
    }
  }

  /** 用系统默认程序打开原图。 */
  function assetOpen(path: string) {
    return client.assetOpen(path)
  }

  /**
   * 正文内联图片：把粘贴进来的图字节落成资产文件，返回**可直接写进 Markdown 正文的 URI**。
   *
   * 为什么不复用 `captureImageFromDataUrl`：那条路会**新建一张图片卡**（收藏用），
   * 而这里用户是在写笔记，图应该是正文的一部分。两条路共用同一个落盘通道
   * （`note:asset-save-buffer`），只是落点不同：一个进卡片，一个进正文。
   *
   * 正文只写短 URI（`hira-asset:<相对路径>`，见 shared-types#noteAssetUri）——
   * **绝不写 dataURL**：几 MB 的 base64 会把库和每次列表拉取一起拖垮。
   *
   * @param {string} dataUrl `data:image/...;base64,...`
   * @returns {Promise<{ uri:string, asset:any }|null>} null = 落盘失败 / 不是图片
   */
  async function saveNoteImage(dataUrl: string): Promise<{ uri: string; asset: AssetResult } | null> {
    const d = String(dataUrl || '')
    if (!/^data:image\//i.test(d)) return null
    let asset = null
    try { asset = await client.assetSaveBuffer({ dataUrl: d }) } catch (_) { asset = null }
    if (!asset || !asset.ok) return null
    // oversize 时没有原图，只能引用缩略图 —— 有图可看胜过"图没了"。
    const assetRef = asset.assetPath || asset.thumbPath
    if (!assetRef) return null
    const uri = noteAssetUri(assetRef)
    return uri ? { uri, asset } : null
  }

  /**
   * 收录完成后统一收尾：切回「集锦」分段、把视线带到落点集锦并高亮新卡，
   * 再回库刷新（计数 / 排序 / 资产路径都要立刻正确）。
   * 与 captureCurrentPage 同一套收尾 —— 否则在根下收录会"点了没反应"。
   */
  async function afterCapture(note: Note | null): Promise<Note | null> {
    state.section = 'collections'
    if (note && note.folderId) state.scopeFolderId = note.folderId
    if (note && note.id) state.highlightId = note.id
    await reload()
    return note
  }

  /** 一段纯文本 → 单行标题（前 60 字，去换行）。 */
  function oneLineTitle(text: unknown): string {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  }

  /**
   * 把一个**已落盘的资产结果**收成卡片。
   *
   * 三态（与 notes-assets 的返回对齐）：
   *   · 全量资产（assetPath + thumbPath 都在）      → kind:'image'（完整图片卡）
   *   · oversize（只有 thumbPath，assetPath 为空）  → allowOversizeThumb ? 图片卡（仅缩略图）：降级网页卡
   *   · 抓取失败（ok:false / 无任何路径）           → 降级网页卡（收下 URL）
   *
   * 为什么 oversize 还要分两种口径：面板内（粘贴 / 拖放）用户是"主动塞图进来"，
   * 留一张"仅缩略图"的图片卡更贴合意图；页面右键那一路按产品口径统一退成网页卡
   * （见 browser-window-assembly#captureImageIntoCollection 的注释）。
   */
  async function captureImageAsset(asset: AssetResult | null, {
    url,
    title,
    sourceTitle,
    allowOversizeThumb,
    folderId: targetFolderId
  }: {
    url?: string
    title?: string
    sourceTitle?: string
    allowOversizeThumb?: boolean
    folderId?: string | null
  } = {}) {
    const folderId = targetFolderId !== undefined ? targetFolderId : currentCaptureFolderId()
    const u = url ? String(url) : undefined
    const t = String(title || '').trim()
    const hasFull = !!(asset && asset.ok && asset.assetPath && asset.thumbPath)
    const hasThumbOnly = !!(asset && asset.ok && !asset.assetPath && asset.thumbPath)
    if (hasFull || (hasThumbOnly && allowOversizeThumb)) {
      return client.capture({
        kind: 'image',
        url: u,
        title: t || '图片',
        sourceTitle: sourceTitle ? String(sourceTitle) : undefined,
        folderId,
        assetPath: hasFull ? asset.assetPath : null,
        assetMime: asset.assetMime,
        assetWidth: asset.assetWidth,
        assetHeight: asset.assetHeight,
        thumbPath: asset.thumbPath
      })
    }
    // 降级：收下 URL 当网页卡（点了没反应比"少存一张原图"糟糕得多）。
    if (!u) return null
    return client.capture({ kind: 'page', url: u, title: t || u, sourceTitle: sourceTitle ? String(sourceTitle) : undefined, folderId })
  }

  /** 粘贴 / 拖放：把 dataURL 图字节存成资产并收录（allowOversizeThumb=true，见 captureImageAsset）。 */
  async function captureImageFromDataUrl({
    dataUrl,
    title,
    sourceTitle,
    folderId
  }: {
    dataUrl: string
    title?: string
    sourceTitle?: string
    folderId?: string | null
  }) {
    let asset = null
    try { asset = await client.assetSaveBuffer({ dataUrl }) } catch (_) { asset = null }
    const note = await captureImageAsset(asset, { title, sourceTitle, allowOversizeThumb: true, folderId })
    return afterCapture(note)
  }

  /** 拖放 / 右键：按 URL 抓图并收录（allowOversizeThumb=false = 大图退网页卡）。 */
  async function captureImageFromUrl({
    url,
    referer,
    title,
    sourceTitle,
    folderId
  }: {
    url: string
    referer?: string
    title?: string
    sourceTitle?: string
    folderId?: string | null
  }) {
    let asset = null
    try { asset = await client.assetFetch({ url, referer }) } catch (_) { asset = null }
    const note = await captureImageAsset(asset, { url, title, sourceTitle, allowOversizeThumb: false, folderId })
    return afterCapture(note)
  }

  /**
   * 粘贴 / 拖放拿到的一段文本：URL 形态 → kind:'page'；否则 → **kind:'note'**。
   *
   * ── 口径：文本进来 = note（与页面右键「添加所选文字」逐字一致）───────────────
   * 一段文字天然就是一条笔记（能编辑 / Markdown 预览 / 打标签 / 换色 / 导出）；旧版收成
   * snippet 的渲染分支保留（老数据要能显示），但**不再产生新数据**。
   * 判据只看"整段是不是一个 http(s) URL"—— 一段带 URL 的说明文字仍按文本收（保原文）。
   * 若调用方给了来源（url / sourceTitle，例如从网页拖来的文本），按来源模板拼正文并带上
   * 「跳到原文那段」的定位 URL（与主进程右键路径共用同一对纯函数）；纯文本就是普通笔记。
   */
  async function captureText({
    text,
    url,
    sourceTitle,
    folderId: targetFolderId
  }: {
    text?: string
    url?: string
    sourceTitle?: string
    folderId?: string | null
  } = {}) {
    const raw = String(text || '').trim()
    if (!raw) return null
    const folderId = targetFolderId !== undefined ? targetFolderId : currentCaptureFolderId()
    let note
    // 整段就是**一个**地址（无空白）才算 page —— 多行文本即便以 URL 开头也是笔记。
    if (/^\S+$/.test(raw) && isHttpUrl(raw)) {
      note = await client.capture({ kind: 'page', url: raw, title: raw, sourceTitle: sourceTitle ? String(sourceTitle) : undefined, folderId })
    } else {
      const srcTitle = String(sourceTitle || '').trim()
      const srcUrl = String(url || '').trim()
      if (srcUrl) {
        const title = srcTitle || oneLineTitle(raw) || '笔记'
        note = await client.capture({
          kind: 'note',
          title,
          sourceTitle: srcTitle || undefined,
          content: buildSourceNoteContent({ title, url: srcUrl, text: String(text) }),
          url: buildTextFragmentUrl(srcUrl, String(text)),
          folderId
        })
      } else {
        // 纯文本（无来源）：正文即原文，标题留空交给 displayTitle 从首行取 ——
        // 免得标题行与预览区显示同一段文字（重复且难看）。
        note = await client.capture({ kind: 'note', content: String(text), folderId })
      }
    }
    return afterCapture(note)
  }

  /** 拖放 / 右键拿到的一个链接 URL → kind:'page'（标题优先链接文字）。 */
  async function captureLink({
    url,
    title,
    sourceTitle,
    folderId: targetFolderId
  }: {
    url: string
    title?: string
    sourceTitle?: string
    folderId?: string | null
  }) {
    const link = String(url || '').trim()
    if (!isHttpUrl(link)) return null
    const note = await client.capture({
      kind: 'page',
      url: link,
      title: String(title || '').trim() || link,
      sourceTitle: sourceTitle ? String(sourceTitle) : undefined,
      folderId: targetFolderId !== undefined ? targetFolderId : currentCaptureFolderId()
    })
    return afterCapture(note)
  }

  /**
   * 统一拖拽协议的**落库入口**（跨面板 / 跨视图拖入）。
   *
   * 视图只回答"指针压在哪一行"（即 `target.folderId`），这里回答"这个域该怎么落地"：
   *   · `tab`（标签）      → `kind:'page'` + 带上 tabId（域层可据此回到活动标签）；
   *   · `image` 形状的 URL → 抓图成 `kind:'image'`（与粘贴/外部拖入同一口径）；
   *   · 其它带 URL 的域    → `kind:'page'`（书签 / 历史 / 下载 / 集锦卡 / 画板链接卡）；
   *   · 无 URL 的文本域    → `kind:'note'`（便签卡 / 画板便签 / 下载的落盘路径）。
   *
   * 之所以放在模型而不是视图：这是**业务语义**（哪种域 => 哪种卡），换一个宿主
   * （窗口形态、内部页）也该共用同一份；视图里再写一套就必然漂移。
   *
   * @param {{domain:string,id:string,kind:string,url:string,title:string,text:string,tabId?:string}} item
   * @param {{folderId?:string|null}} [target] 落点集锦；缺省 = 当前所在集锦 / 未归档
   * @returns {Promise<any|null>}
   */
  async function captureDroppedItem(item: {domain:string,id:string,kind:string,url:string,title:string,text:string,tabId?:string}, target?: {folderId?:string|null}) : Promise<Note|null> {
    if (!item || typeof item !== 'object') return null
    const folderId = target && target.folderId !== undefined ? target.folderId : currentCaptureFolderId()
    const url = String(item.url || '').trim()
    const title = String(item.title || '').trim()
    const text = String(item.text || '').trim()

    if (item.domain === 'tab') {
      if (!url) return null
      const note = await client.capture({
        kind: 'page',
        url,
        title: title || url,
        ...(item.tabId ? { tabId: String(item.tabId) } : {}),
        folderId
      })
      return afterCapture(note)
    }

    if (url) {
      if (item.kind === 'image') return captureImageFromUrl({ url, title, folderId })
      return captureLink({ url, title, folderId })
    }

    // 画板图片卡没有 url，字节直接是 dataURL —— 走资产入库，别降级成一段文本。
    if (item.kind === 'image' && /^data:image\//i.test(text)) {
      return captureImageFromDataUrl({ dataUrl: text, title, folderId })
    }

    // 无 URL：文本 / 便签 / 本地落盘路径 —— 一律收成可编辑的 note 卡。
    if (text || title) return captureText({ text: text || title, folderId })
    return null
  }

  /**
   * 导出某集锦到文件（md / html / json，或插件提供的自定义格式）。
   * 序列化在**本文件**（纯函数，见 notesToMarkdown / notesToHtml / notesToJson），
   * 落盘在主进程（弹原生保存框）—— 面板不认识对话框，主进程不认识卡片语法。
   *
   * `provider`（可选）= `note.export-format` 插槽的实现，形如
   * `{ extension, serialize(cards, name), encoding? }`：序列化仍由插件负责（它最懂自己的格式），
   * 这里只负责取卡片、定文件名、交给同一条落盘通道。`encoding === 'base64'`
   * 表示 `serialize` 返回 base64 字符串（xlsx/docx 等二进制容器），其余按文本写。
   * @returns {Promise<{ ok:boolean, canceled?:boolean, path?:string, error?:string }>}
   */
  async function exportCollection(
    folderId: string | null,
    format: string,
    provider?: {
      extension?: string
      serialize(cards: Note[], name: string): unknown | Promise<unknown>
      encoding?: 'utf8' | 'base64'
    } | null
  ): Promise<ExportResult> {
    const cards = cardsInCollection(folderId)
    const name = folderLabel(folderId) || '集锦'
    if (provider && typeof provider.serialize === 'function') {
      const extension = String(provider.extension || format || 'txt').replace(/^\./, '').toLowerCase()
      const content = String(await provider.serialize(cards, name) ?? '')
      return client.exportFile({
        format: extension,
        filename: `${name}.${extension}`,
        content,
        ...(provider.encoding === 'base64' ? { encoding: 'base64' } : {})
      })
    }
    const fmt = NOTE_EXPORT_FORMATS.includes(format) ? format : 'md'
    const content = fmt === 'html'
      ? notesToHtml(cards as unknown as Parameters<typeof notesToHtml>[0], name)
      : (fmt === 'json'
          ? notesToJson(cards as unknown as Parameters<typeof notesToJson>[0], name)
          : notesToMarkdown(cards as unknown as Parameters<typeof notesToMarkdown>[0], name))
    return client.exportFile({ format: fmt, filename: `${name}.${fmt}`, content })
  }

  return {
    state,
    // 生命周期
    init,
    reload,
    dispose,
    // 选择器
    childFolders,
    hasChildFolders,
    folderLabel,
    folderPath,
    parentFolderId,
    scopeParentId,
    visibleNotes,
    trashItems,
    allTags,
    flatFolderOptions,
    getNote,
    getActiveNote,
    descendantFolderIds,
    siblingNoteIds,
    siblingFolderIds,
    folderCount,
    unfiledCount,
    unfiledCollapsed,
    toggleUnfiled,
    trashCount,
    refCount,
    folderCoverPaths,
    folderUpdatedAt,
    refTarget,
    refChipInfo,
    cardsInCollection,
    // 多选 / 批量
    isSelected,
    selectedCount,
    selectedIds,
    selectedRefsText,
    toggleSelect,
    clearSelection,
    moveSelectedTo,
    deleteSelected,
    // 导航 / 分段
    setQuery,
    setSort,
    setSection,
    isReadingSection,
    isTrashSection,
    isCollectionsSection,
    toggleTag,
    clearTags,
    toggleKindFilter,
    clearKindFilter,
    openFolder,
    goUp,
    toggleExpand,
    openNote,
    backToList,
    revealNote,
    clearHighlight,
    // 卡片主动作（单击分派）
    primaryAction,
    // 笔记
    createNote,
    createNoteCard,
    captureCurrentPage,
    captureInput,
    deleteNote,
    togglePin,
    setColor,
    setNoteTags,
    setCardNote,
    moveNote,
    reorderNotes,
    dropNote,
    updateActive,
    flushActive,
    // 集锦级
    openAllInCollection,
    openUrl,
    collectionPlainText,
    collectionMarkdown,
    refLink,
    insertRefCard,
    backlinks,
    // 图片资产 / 导入（P2）
    assetThumb,
    assetOpen,
    saveNoteImage,
    captureImageFromDataUrl,
    captureImageFromUrl,
    captureText,
    captureLink,
    captureDroppedItem,
    currentCaptureFolderId,
    exportCollection,
    // 回收站
    restoreNote,
    purgeNote,
    emptyTrash,
    // 文件夹
    createFolder,
    renameFolder,
    deleteFolder,
    dropFolder
  }
}

export type NotesModel = ReturnType<typeof createNotesModel>
