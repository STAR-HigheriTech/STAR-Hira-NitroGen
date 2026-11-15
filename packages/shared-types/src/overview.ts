/**
 * overview —— 「总览」浮层的**纯层**（唯一真源，零依赖 / 零 IO / 不 require electron）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是什么
 * ══════════════════════════════════════════════════════════════════════
 * 一块贴触发器弹出的聚合卡片（对齐 Edge 左上角「标签操作菜单」）要同时给出：
 *     空间（少量） → 搜索框 → 打开的标签（大量） → 会话 → 最近关闭
 * 每块超过上限就只留前 N 条 + 一行「还有 N 项 · 转到 xxx 面板」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 单表 descriptor（用户规则：「一个视图有模式就解耦、统一管理」）
 * ══════════════════════════════════════════════════════════════════════
 * 「摆几块、每块摆什么、上限多少、超了去哪、搜索怎么分组、块头有什么动作」
 * **全部集中在 `OVERVIEW_SECTIONS` 一张表里**。下面那些 `OVERVIEW_*` 常量
 * 都是从这张表派生的只读视图 —— 不再维护多张平行表（旧写法改一个额度要动五处，
 * 漏一处就是"标题写着上限、实际不按它截断"这种漂移）。
 *
 * 加一块 = 表里加一条 descriptor + 编排层造一个行件交给 `hosts[kind]`：
 *   · 视图（renderer/overview-overlay/view.js）不认识上限 / 标题 / 去向 / 动作，只按
 *     `buildOverview()` 吐出的 `Section[]` 画；
 *   · 编排层与浮层宿主零改动。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两种模式，一份纯函数
 * ══════════════════════════════════════════════════════════════════════
 * 「浏览」与「搜索」不是两套视图，是 `buildOverview()` 的两种输出：
 *   浏览 → mode='browse'，各块按 `limit` 截断 + 溢出省略行；
 *   搜索 → mode='search'，只作用在 `searchable` 的块上，结果同样**分组**、
 *          组标题带命中数、不再截断（已是命中子集）。
 * 不可搜索的块（空间）两种模式下都原样留着。
 *
 * ⚠ 省略行的**措辞**不在这里 —— 它的唯一实现是 ui-common#overflowRowText
 * （浮层与面板共用同一句）。本文件只交出 `hiddenCount` + `targetLabel` 两个事实，
 * 由渲染侧去拼那句话。
 */

export interface OverviewSectionSpec {
  kind: string
  title: string
  limit: number
  zone: 'above' | 'below'
  searchable: boolean
  matchKeys: readonly string[]
  target: Readonly<{ panel: string; label: string }>
  headerTarget?: boolean
  action: string
  actionLabel: string
}

/** @type {readonly OverviewSectionSpec[]} */
export const OVERVIEW_SECTIONS: readonly OverviewSectionSpec[] = Object.freeze([
  Object.freeze({
    // 空间：刻意压到 2（对齐 Edge 菜单只露两格工作区）；不参与搜索。
    kind: 'spaces',
    title: '空间',
    limit: 2,
    zone: 'above',
    searchable: false,
    matchKeys: Object.freeze(['name']),
    target: Object.freeze({ panel: 'spaces-panel', label: '空间面板' }),
    // 无溢出时块头给「转到空间面板」小字；有溢出时由省略行承担（不重复）。
    headerTarget: true,
    action: '',
    actionLabel: ''
  }),
  Object.freeze({
    // 打开的标签：面板高度就是整窗，能摆 6 条。
    kind: 'tabs',
    title: '打开的标签',
    limit: 6,
    zone: 'below',
    searchable: true,
    matchKeys: Object.freeze(['title', 'url']),
    target: Object.freeze({ panel: 'open-tabs-panel', label: '标签面板' }),
    // 无溢出时块头给「转到标签面板」小字；有溢出时由省略行承担（不重复）。
    headerTarget: true,
    action: '',
    actionLabel: ''
  }),
  Object.freeze({
    // 会话：命名会话的最近几条；块头「保存当前」= 这一块自己就能存，
    // 与「会话面板」的保存走同一条 `session:named-save`（此处不做第二套语义）。
    kind: 'sessions',
    title: '会话',
    limit: 3,
    zone: 'below',
    searchable: true,
    matchKeys: Object.freeze(['name']),
    target: Object.freeze({ panel: 'sessions-panel', label: '会话面板' }),
    action: 'save-session',
    actionLabel: '保存当前'
  }),
  Object.freeze({
    // 最近关闭：撤销栈的头部即可；块头留「刷新」（撤销栈不再往总览推送）。
    // 摆在会话之下、列表最末 —— 它是「一次性撤销」的收尾块，不该压住要长期用的会话。
    kind: 'recent',
    title: '最近关闭',
    limit: 5,
    zone: 'below',
    searchable: true,
    matchKeys: Object.freeze(['title', 'url']),
    target: Object.freeze({ panel: 'history-panel', label: '历史面板' }),
    // 无溢出时块头也给「转到历史面板」小字（与「刷新」并排）；有溢出时由省略行承担。
    headerTarget: true,
    action: 'refresh',
    actionLabel: '刷新'
  })
])

/** 由单表派生一张「kind → 某字段」的只读表（派生而不是再抄一份）。 */
function derive<T>(pick: (section: OverviewSectionSpec) => T): Readonly<Record<string, T>> {
  const out: Record<string, T> = {}
  for (const section of OVERVIEW_SECTIONS) out[section.kind] = pick(section)
  return Object.freeze(out)
}

/** 各块最多摆几项（派生视图；要调配额改 `OVERVIEW_SECTIONS`）。 */
export const OVERVIEW_LIMITS = derive((s) => s.limit)

/**
 * 各块「超上限之后去哪」——`{ panel, label }`。
 * `panel` 是目标面板 id（渲染侧交给 panelsClient.toggle），`label` 是省略行文案里的名字。
 */
export const OVERVIEW_TARGETS = derive((s) => s.target)

/** 各块的标题（浏览态不带计数；搜索态由本文件拼上命中数）。 */
export const OVERVIEW_TITLES = derive((s) => s.title)

/** 各块的**匹配键**（搜索时按这些字段做小写包含匹配）。 */
export const OVERVIEW_MATCH_KEYS = derive((s) => s.matchKeys)

/**
 * 布局：搜索框**上方**摆哪些块、**下方**摆哪些块。
 * 用户原话「搜索框在打开的标签和 space 部分之间」→ 空间在上、其余在下。
 * 要调顺序只改 descriptor 的 `zone`（或直接调表内顺序），渲染层完全按输出装配。
 */
export const OVERVIEW_ABOVE_SEARCH = Object.freeze(
  OVERVIEW_SECTIONS.filter((s) => s.zone === 'above').map((s) => s.kind)
)
export const OVERVIEW_BELOW_SEARCH = Object.freeze(
  OVERVIEW_SECTIONS.filter((s) => s.zone === 'below').map((s) => s.kind)
)

/** 搜索**作用域**（哪些块参与过滤）。作用域外的块两种模式都原样。 */
export const OVERVIEW_SEARCH_SCOPE = Object.freeze(
  OVERVIEW_SECTIONS.filter((s) => s.searchable).map((s) => s.kind)
)

/** 规范化查询串（统一小写 + 去首尾空白；空串 = 浏览态）。 */
function normalizeQuery(query: unknown): string {
  return String(query == null ? '' : query).trim().toLowerCase()
}

/** 某项是否命中（任一匹配键的字符串值小写包含）。 */
function matchesItem(item: unknown, keys: readonly string[], needle: string): boolean {
  if (!item || typeof item !== 'object') return false
  const record = item as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true
  }
  return false
}

/** 过滤一份列表（纯函数，不改原数组）。 */
function filterItems(items: readonly OverviewItem[], keys: readonly string[], needle: string): OverviewItem[] {
  const out: OverviewItem[] = []
  for (const item of items) if (matchesItem(item, keys, needle)) out.push(item)
  return out
}

/**
 * 造一个 Section。
 *
 * @param {OverviewSectionSpec} spec 该块的 descriptor
 * @param {any[]} items 该块（可能已过滤）的全部条目
 * @param {number|null} limit 本模式下的展示上限；null = 不截断（搜索态）
 * @param {boolean} searching 是否搜索态（决定标题是否带命中数）
 * @returns {{
 *   key: string, kind: string, title: string, items: any[], count: number,
 *   hiddenCount: number, targetPanel: string, targetLabel: string,
 *   headerTarget: boolean, action: string, actionLabel: string
 * }}
 */
export type OverviewItem = Record<string, unknown>

export interface OverviewInput {
  spaces?: OverviewItem[]
  tabs?: OverviewItem[]
  recent?: OverviewItem[]
  sessions?: OverviewItem[]
  query?: string
}

export interface OverviewSection {
  key: string
  kind: string
  title: string
  items: OverviewItem[]
  count: number
  hiddenCount: number
  targetPanel: string
  targetLabel: string
  headerTarget: boolean
  action: string
  actionLabel: string
}

function buildSection(spec: OverviewSectionSpec, items: OverviewItem[], limit: number | null, searching: boolean): OverviewSection {
  const hidden = limit != null && items.length > limit ? items.length - limit : 0
  return {
    key: spec.kind,
    kind: spec.kind,
    title: searching ? `${spec.title} · ${items.length}` : spec.title,
    items: hidden > 0 && limit != null ? items.slice(0, limit) : items,
    count: items.length,
    hiddenCount: hidden,
    targetPanel: spec.target.panel,
    targetLabel: spec.target.label,
    // 块头「转到 xxx 面板」小字的开关：descriptor 只说"要不要"，
    // 视图再叠上"没有溢出"这条（有溢出时省略行已经在说同一句话，不重复）。
    headerTarget: spec.headerTarget === true,
    // 块头动作是 descriptor 给的事实：视图只按 `action` 非空与否决定画不画按钮，
    // 点击后原样把 `{ type:'section-action', kind, action }` 上行 ——
    // 「哪个动作该做什么」由编排层解释（视图不认识会话 / 刷新）。
    action: spec.action || '',
    actionLabel: spec.actionLabel || ''
  }
}

/** 空块一律不画（浏览态没内容、搜索态没命中，都不该顶着个空标题）。 */
function isVisible(section: OverviewSection): boolean {
  return section.items.length > 0
}

/**
 * 把各块数据 + 查询串，编成搜索框上下两组 Section。
 *
 * @param {Record<string, any[]> & { query?: string }} [input] 键 = descriptor 的 kind
 * @returns {{ mode: 'browse'|'search', query: string, top: object[], bottom: object[] }}
 *   top    = 搜索框**上方**的块
 *   bottom = 搜索框**下方**的块
 */
export function buildOverview(input: OverviewInput = {}) : { mode: 'browse'|'search', query: string, top: OverviewSection[], bottom: OverviewSection[] } {
  const query = normalizeQuery(input.query)
  const searching = query.length > 0
  const sections = input as Record<string, unknown>

  const top: OverviewSection[] = []
  const bottom: OverviewSection[] = []
  for (const spec of OVERVIEW_SECTIONS) {
    let items: OverviewItem[] = Array.isArray(sections[spec.kind]) ? sections[spec.kind] as OverviewItem[] : []
    // 搜索态只过滤可搜索的块；作用域外的块（空间）原样。
    if (searching && spec.searchable) items = filterItems(items, spec.matchKeys, query)
    // 搜索态的可搜索块不截断（结果已是命中子集）—— 避免"搜了还看不到"的怪相。
    const limit = searching && spec.searchable ? null : spec.limit
    const section = buildSection(spec, items, limit, searching)
    if (!isVisible(section)) continue
    ;(spec.zone === 'above' ? top : bottom).push(section)
  }

  return { mode: searching ? 'search' : 'browse', query, top, bottom }
}

/**
 * 只取搜索命中（供纯函数复用 / 将来单测）—— `buildOverview` 内部就是用它。
 *
 * @param {Record<string, any[]>} input
 * @param {string} query
 * @returns {Record<string, any[]>}
 */
export function searchOverview(input: Record<string, OverviewItem[]> = {}, query: string = ''): Record<string, OverviewItem[]> {
  const needle = normalizeQuery(query)
  /** @type {Record<string, any[]>} */
  const out: Record<string, OverviewItem[]> = {}
  for (const spec of OVERVIEW_SECTIONS) {
    const items = Array.isArray(input[spec.kind]) ? input[spec.kind] : []
    out[spec.kind] = needle && spec.searchable ? filterItems(items, spec.matchKeys, needle) : items
  }
  return out
}
