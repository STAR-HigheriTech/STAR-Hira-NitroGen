/**
 * instant-answer —— 即时答案（DuckDuckGo Instant Answer）的**纯解析规则**。
 *
 * 为什么单独一份纯函数：
 *   · 解析只跟"上游返回了什么"有关，与网络、缓存、IPC 无关 → 放 shared-types，
 *     主进程（CJS require）与任何渲染侧（ESM import）都能复用同一套口径；
 *   · 上游字段是 HTML 片段（`<b>` / `&quot;`），**清洗规则必须唯一** ——
 *     在 UI 里再写一遍 `replace(/<[^>]*>/g)` 必然与主进程漂移（一边去标签、一边留实体）。
 *
 * 产出形状是**中立事实**，不含 relevance / type 这类 UI 决策：
 *   `{ kind:'answer'|'abstract'|'related', title, text?, url?, icon?, provider? }`
 * UI 侧（ui-searchbar 的 instant-answer suggestor）再折算成 suggestion。
 *
 * 零依赖、零 IO、不 require electron（domain/infra 之外的分层都可以直接引用）。
 */

// 「算不算普通网页」的唯一判据（图标的绝对地址必须是 http(s)）。
import { isHttpUrl } from './url-protocols.js'

/**
 * HTML 实体 → 字符。
 * 只覆盖上游真正常见的几个（DDG 的摘要来自 Wikipedia，`&quot;` / `&amp;` / `&#39;` 最多）。
 * 数字实体（`&#39;` / `&#x27;`）另行按码点解码，不在此表里堆。
 */
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…'
})

/** 上游 icon 字段常给相对路径（`/i/xxx.png`）—— 补成绝对 URL，UI 才画得出来。 */
const DDG_ORIGIN = 'https://duckduckgo.com'

/** 单条结果正文的展示上限：地址栏一行放不下小作文，超出直接截断。 */
const MAX_TEXT = 160

/**
 * 去标签 + 解实体 + 折叠空白（F-0771）。
 *
 * 顺序要紧：
 *   1. 先把块级标签换成**空格** —— 否则 `a</p><p>b` 去标签后会粘成 `ab`；
 *   2. 再去掉剩余标签；
 *   3. 最后解实体（先解实体会把 `&lt;b&gt;` 变成真标签，被下一步误删）。
 *
 * @param {unknown} input
 * @returns {string}
 */
export function removeTags(input: unknown) : string {
  if (input == null) return ''
  let s = String(input)
  // 块级边界 → 空格（<br>、</p>、</div>、</li>、</h1..6> 等）
  s = s.replace(/<\s*\/?\s*(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|blockquote)\b[^>]*>/gi, ' ')
  // 其余标签整体去掉（含 script/style 的标签壳，内容由上游负责，不在本层执行/求值）
  s = s.replace(/<[^>]*>/g, '')
  // 实体：命名实体走表，数字实体按码点解
  s = s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    const key = String(body).toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? safeFromCodePoint(code) : match
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? safeFromCodePoint(code) : match
    }
    const named = NAMED_ENTITIES[key as keyof typeof NAMED_ENTITIES]
    return named === undefined ? match : named
  })
  return s.replace(/\s+/g, ' ').trim()
}

/** @param {number} code */
function safeFromCodePoint(code: number) {
  try {
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  } catch (_) {
    return ''
  }
}

/** 截断到 `max` 个字符（中文按 1 个算），超出补省略号。 */
function clip(text: unknown, max = MAX_TEXT): string {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** 相对 icon → 绝对 URL；空值 / 非字符串直接空串。 */
function normalizeIcon(icon: unknown): string {
  if (!icon) return ''
  const iconRecord = icon && typeof icon === 'object' ? icon as Record<string, unknown> : null
  const raw = typeof icon === 'string' ? icon : (typeof iconRecord?.URL === 'string' ? iconRecord.URL : '')
  if (!raw) return ''
  if (isHttpUrl(raw)) return raw
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('/')) return `${DDG_ORIGIN}${raw}`
  return ''
}

/**
 * 把 RelatedTopics / Results 的条目摊平成候选项。
 * RelatedTopics 可能**两层嵌套**（`Topics` 分组），要递归展开；`Results` 是平铺的。
 * @param {unknown} list
 * @param {Array<{kind:'related',title:string,text?:string,url?:string,icon?:string,provider?:string}>} out
 */
function collectRelated(list: unknown, out: InstantAnswerItem[]) {
  const items = Array.isArray(list) ? list : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const nested = record.Topics
    if (Array.isArray(nested)) {
      collectRelated(nested, out)
      continue
    }
    const text = removeTags(record.Text || record.Name)
    const url = typeof record.FirstURL === 'string' ? record.FirstURL : ''
    if (!text && !url) continue
    out.push({
      kind: 'related',
      title: clip(text || url, 100),
      text: clip(text),
      url,
      icon: normalizeIcon(record.Icon),
      provider: '相关结果'
    })
  }
}

/**
 * 解析 DDG Instant Answer 响应（F-0772 的数据半）。
 *
 * 优先级（与旧版插件一致）：直接答案 → 摘要/定义 → 相关结果。
 * 直接答案可能没有 URL（纯算式/换算），此时 UI 侧提交会退回"搜索原查询"。
 *
 * @param {unknown} payload DDG `format=json` 的响应体
 * @param {{ limit?: number }} [options]
 * @returns {Array<{kind:'answer'|'abstract'|'related', title:string, text?:string, url?:string, icon?:string, provider?:string}>}
 */
export interface InstantAnswerItem {
  kind: 'answer' | 'abstract' | 'related'
  title: string
  text?: string
  url?: string
  icon?: string
  provider?: string
}

export function parseInstantAnswer(payload: unknown, options: { limit?: number } = {}): InstantAnswerItem[] {
  const limit = Math.max(1, Math.min(10, Number(options && options.limit) || 3))
  if (!payload || typeof payload !== 'object') return []

  /** @type {Array<{kind:'answer'|'abstract'|'related', title:string, text?:string, url?:string, icon?:string, provider?:string}>} */
  const out: InstantAnswerItem[] = []
  const p = payload as Record<string, unknown>

  // 1) 直接答案（`Answer` 字段）：优先级最高，通常没有跳转链接。
  const answer = removeTags(p.Answer)
  if (answer) {
    out.push({
      kind: 'answer',
      title: clip(answer),
      text: removeTags(p.AnswerType) || undefined,
      url: typeof p.AbstractURL === 'string' ? p.AbstractURL : '',
      icon: normalizeIcon(p.Icon),
      provider: 'DuckDuckGo'
    })
  }

  // 2) 摘要（`AbstractText`）：Wikipedia 类条目，带来源与跳转 URL。
  const abstract = removeTags(p.AbstractText)
  if (abstract) {
    out.push({
      kind: 'abstract',
      title: clip(abstract),
      text: removeTags(p.Heading) || undefined,
      url: typeof p.AbstractURL === 'string' ? p.AbstractURL : '',
      icon: normalizeIcon(p.Icon),
      provider: removeTags(p.AbstractSource) || 'DuckDuckGo'
    })
  }

  // 3) 定义（`Definition`）：词典类条目，与摘要互斥的情况很少，一并收集。
  const definition = removeTags(p.Definition)
  if (definition) {
    out.push({
      kind: 'abstract',
      title: clip(definition),
      text: removeTags(p.Heading) || undefined,
      url: typeof p.DefinitionURL === 'string' ? p.DefinitionURL : '',
      icon: normalizeIcon(p.Icon),
      provider: removeTags(p.DefinitionSource) || 'DuckDuckGo'
    })
  }

  // 4) 相关结果：RelatedTopics（可嵌套）+ Results（平铺）。
  collectRelated(p.RelatedTopics, out)
  collectRelated(p.Results, out)

  // 去重：同一 URL 或同一标题只留最靠前的那条（直接答案 > 摘要 > 相关）。
  const seen = new Set<string>()
  const deduped: InstantAnswerItem[] = []
  for (const item of out) {
    const key = (item.url || '').trim().toLowerCase() || `t:${item.title.toLowerCase()}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
    if (deduped.length >= limit) break
  }
  return deduped
}
