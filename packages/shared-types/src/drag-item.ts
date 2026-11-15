/**
 * drag-item —— 跨视图/跨面板拖放的**统一载荷协议**。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 标签栏、集锦、书签、历史、下载、画板各自在不同 WebContentsView 里，HTML5 拖拽
 * 跨视图时 `dataTransfer.getData()` **不能保证同步可读**（Electron 的实现差异 +
 * 浏览器安全模型都会让它在 dragenter/dragover 阶段返回空串）。
 * 若每个面板自己约定 `text/plain` 的格式，就会形成"N 个源 × M 个落点"的兼容矩阵
 * —— 每加一个面板都要改所有落点，最后必然烂成屎山。
 *
 * 本模块只做三件事：
 *   1. 定义唯一 MIME 与载荷形状（`{ domain, id, kind, url, title, text, tabId, folderId }`）；
 *   2. `setDragItem` 写入时**同时**写 `text/plain` 兜底（跨视图最后一道保险）；
 *   3. `getDragItem` 读取时按「MIME → 前缀编码的 text/plain → http(s) 链接」三级降级。
 *
 * ── 落点怎么用 ────────────────────────────────────────────────────
 *   dragover:  if (!hasDragItem(e.dataTransfer)) return   // 不认领就别 preventDefault
 *   drop:      const item = getDragItem(e.dataTransfer); if (!item) return
 *              switch (item.domain) { ... }               // 按域分发，而不是按来源面板
 *
 * ── 它不认识 DOM ──────────────────────────────────────────────────
 * 纯数据层，零外部依赖；Node（`require`）与浏览器（`import`）双端可加载。
 */

// 图片扩展名的判定口径与协议/笔记资产共用同一份（见 media-extensions.mjs）。
import { IMAGE_FILE_EXTENSIONS } from './media-extensions.js'

/** 唯一 MIME：所有 hira 内部拖拽源都应写它。 */
export const DRAG_ITEM_MIME = 'application/x-hira-item'

/** `text/plain` 兜底的前缀（跨视图读不到 MIME 时靠它还原）。 */
export const DRAG_ITEM_PREFIX = 'hira-item:'

/**
 * 拖拽域：**来源模块**，不是目标类型。
 * 落点按 domain 决定"怎么落地"，kind 只描述内容形状。
 */
export const DRAG_DOMAINS = Object.freeze([
  'tab',
  'note',
  'bookmark',
  'history',
  'download',
  'easel',
  'link'
])

/** 内容形状（与集锦 NOTE_KINDS / 画板 CARD_KINDS 对齐，但**不做强校验**）。 */
export const DRAG_KINDS = Object.freeze(['page', 'note', 'image', 'file', 'folder', 'snippet', 'ref', 'text'])

const DOMAIN_SET = new Set(DRAG_DOMAINS)
const KIND_SET = new Set(DRAG_KINDS)

/** 载荷体积上限：防止把整篇文档塞进 dataTransfer 拖慢拖拽。 */
const MAX_TEXT = 20000
const MAX_URL = 8000
const MAX_TITLE = 500

export interface DragItem {
  domain: string
  id: string
  kind: string
  url: string
  title: string
  text: string
  tabId: string
  folderId: string
  source: string
}

interface InferKindInput {
  domain: string
  url: string
  text: string
  rawKind: string
}

function clip(value: unknown, max: number): string {
  if (value == null) return ''
  const s = String(value).trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max) : s
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const s = value.trim()
  if (!s) return false
  return /^https?:\/\//i.test(s) || /^file:\/\//i.test(s)
}

/**
 * 归一化一个拖拽载荷。
 *
 * @param {object} raw 原始载荷（各拖拽源自己拼的）
 * @returns {{domain:string,id:string,kind:string,url:string,title:string,text:string,tabId:string,folderId:string,source:string}|null}
 *   非法（无 domain / domain 不认识 / 无 id 且无 url 且无 text）时返回 null。
 */
export function normalizeDragItem(raw: Record<string, unknown>): DragItem | null {
  if (!raw || typeof raw !== 'object') return null
  const domain = clip(raw.domain, 32).toLowerCase()
  if (!DOMAIN_SET.has(domain)) return null

  const url = clip(raw.url, MAX_URL)
  const title = clip(raw.title, MAX_TITLE)
  const text = clip(raw.text, MAX_TEXT)
  const id = clip(raw.id, 256) || url || text
  if (!id) return null

  const rawKind = clip(raw.kind, 32).toLowerCase()
  const kind = KIND_SET.has(rawKind) ? rawKind : inferKind({ domain, url, text, rawKind })

  return {
    domain,
    id,
    kind,
    url,
    title,
    text,
    tabId: clip(raw.tabId, 128),
    folderId: clip(raw.folderId, 128),
    source: clip(raw.source, 64)
  }
}

function inferKind({ domain, url, text, rawKind }: InferKindInput): string {
  if (rawKind === 'folder') return 'folder'
  if (url) return guessUrlKind(url)
  if (domain === 'note' || domain === 'easel') return 'note'
  if (text) return 'text'
  return 'page'
}

function guessUrlKind(url: string): string {
  const clean = String(url).split(/[?#]/)[0].toLowerCase()
  const ext = clean.slice(clean.lastIndexOf('.'))
  return IMAGE_FILE_EXTENSIONS.includes(ext) ? 'image' : 'page'
}

/** 是否是本协议的载荷对象。 */
export function isDragItem(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return !!normalizeDragItem(value as Record<string, unknown>)
}

/**
 * 写入拖拽源。
 *
 * 会同时写：
 *   · `application/x-hira-item` → JSON（首选，同视图必可读）
 *   · `text/plain`              → 链接优先（让外部应用也能"拖出去"），否则前缀编码
 *
 * @param {DataTransfer} dataTransfer
 * @param {object} item
 * @param {{effectAllowed?:string, plain?:'url'|'prefix'|'none'}} [options]
 *   `plain` 控制 `text/plain` 兜底：`'url'`（默认，外部应用可用）/ `'prefix'`（前缀编码）/
 *   `'none'`（**完全不写** —— 标签拖拽必须用它：网页会把 text/plain 接走并当成搜索词）。
 * @returns {DragItem|null} 归一化后的载荷
 */
export function setDragItem(
  dataTransfer: DataTransfer,
  item: Record<string, unknown>,
  options: { effectAllowed?: DataTransfer['effectAllowed']; plain?: 'url' | 'prefix' | 'none' } = {}
) : DragItem|null {
  const normalized = normalizeDragItem(item)
  if (!dataTransfer || !normalized) return null
  const opts = options || {}
  try {
    if (opts.effectAllowed) dataTransfer.effectAllowed = opts.effectAllowed
    const json = JSON.stringify(normalized)
    dataTransfer.setData(DRAG_ITEM_MIME, json)
    const plainMode = opts.plain === undefined ? 'url' : opts.plain
    if (plainMode !== 'none') {
      // text/plain：有链接就给链接（拖到地址栏/外部编辑器都可用），否则给可还原的前缀串。
      const plain = plainMode === 'url'
        ? (normalized.url || `${DRAG_ITEM_PREFIX}${json}`)
        : `${DRAG_ITEM_PREFIX}${json}`
      dataTransfer.setData('text/plain', plain)
    }
  } catch (_) {
    /* 某些环境（只读 DataTransfer）写入会抛错，忽略即可 —— 闭包变量仍是主真源。 */
  }
  return normalized
}

/** 只读探测：`dragover` 阶段用它决定是否 `preventDefault()`。 */
export function hasDragItem(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  try {
    const types = dataTransfer.types
    if (!types) return false
    for (let i = 0; i < types.length; i += 1) {
      const t = String(types[i]).toLowerCase()
      if (t === DRAG_ITEM_MIME) return true
      // Chromium 偶尔会把未知 MIME 归到 Files / text/plain，交给 getDragItem 判空即可。
    }
    return false
  } catch (_) {
    return false
  }
}

/**
 * 选出这次拖放**实际可用**的 dropEffect。
 *
 * 源端可以声明 `effectAllowed='move'`（标签条的内置排序就是），此时落点若硬写
 * `dropEffect='copy'`，Chromium 会把它判成"禁止落下"—— 连 drop 事件都不会派发。
 * 落点表达的是"我想怎么接"（通常是 copy），实际值必须落在源端允许的集合里；
 * 跨视图拖放尤其明显（源在另一个 WebContentsView，落点看不到源的变化）。
 *
 * @param {DataTransfer} dataTransfer
 * @param {'copy'|'move'|'link'} [preferred] 落点倾向，默认 copy
 * @returns {'copy'|'move'|'link'|'none'}
 */
export function pickDropEffect(dataTransfer: DataTransfer, preferred: 'copy'|'move'|'link') : 'copy'|'move'|'link'|'none' {
  const want = preferred === 'move' || preferred === 'link' ? preferred : 'copy'
  let allowed = ''
  try { allowed = String((dataTransfer && dataTransfer.effectAllowed) || '') } catch (_) {}
  switch (allowed) {
    case '':
    case 'uninitialized':
    case 'all':
      return want
    case 'copyMove':
      return want === 'link' ? 'copy' : want
    case 'copyLink':
      return want === 'move' ? 'copy' : want
    case 'linkMove':
      return want === 'copy' ? 'move' : want
    case 'copy':
    case 'move':
    case 'link':
      return allowed
    default:
      return want
  }
}

/**
 * 读取拖拽载荷（三级降级）。
 *
 * @param {DataTransfer} dataTransfer
 * @returns {DragItem|null}
 */
export function getDragItem(dataTransfer: DataTransfer) : DragItem|null {
  if (!dataTransfer) return null
  let json = ''
  try {
    json = dataTransfer.getData(DRAG_ITEM_MIME)
  } catch (_) {}
  if (json) {
    const fromJson = parseJsonItem(json)
    if (fromJson) return fromJson
  }

  let plain = ''
  try {
    plain = dataTransfer.getData('text/plain')
  } catch (_) {}
  if (plain) {
    const fromPlain = parsePlainItem(plain)
    if (fromPlain) return fromPlain
  }

  // 最后兜底：外部浏览器拖来的普通链接 —— 也能直接落进集锦/画板。
  try {
    const uriList = dataTransfer.getData('text/uri-list')
    if (uriList) {
      const first = uriList.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
      if (isHttpUrl(first)) return normalizeDragItem({ domain: 'link', id: first, url: first, title: plain })
    }
  } catch (_) {}

  return null
}

function parseJsonItem(json: string): DragItem | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return normalizeDragItem(parsed as Record<string, unknown>)
  } catch (_) {}
  return null
}

function parsePlainItem(plain: string): DragItem | null {
  const s = String(plain).trim()
  if (!s) return null
  if (s.startsWith(DRAG_ITEM_PREFIX)) {
    const fromPrefix = parseJsonItem(s.slice(DRAG_ITEM_PREFIX.length))
    if (fromPrefix) return fromPrefix
  }
  if (isHttpUrl(s)) {
    return normalizeDragItem({ domain: 'link', id: s, url: s, title: '' })
  }
  return null
}

/**
 * 生成"可落地为链接卡片"的最小载荷（落点若只想要 URL 时用）。
 * @param {object} item
 * @returns {{url:string,title:string}|null}
 */
export function dragItemToLink(item: Record<string, unknown>) : {url:string,title:string}|null {
  const normalized = normalizeDragItem(item)
  if (!normalized || !normalized.url) return null
  return { url: normalized.url, title: normalized.title || normalized.url }
}
