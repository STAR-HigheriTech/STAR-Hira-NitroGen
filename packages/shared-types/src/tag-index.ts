/**
 * 标签索引 —— 纯函数真源（零 IO、零依赖）
 *
 * 归档自旧版 Hira `js/places/tagIndex.js`（F-0756~F-0760）。
 * 旧实现把索引绑在 `window` 全局上、数据源是浏览历史；NG 里数据源换成**书签**
 * （标签只存在于书签上），但打分/共现/时间衰减的口径逐条保留：
 *
 *   · `rankTags`        —— 词项-标签共现的 tf-idf 式打分（标签自身命中词项 ×1.5）
 *   · `suggestTags`     —— 取前 N、分数 > 阈值（旧版 3 条 / 0.66）
 *   · `autocompleteTags` —— 已选标签的共现衰减排序（14 天半衰，最低 ×1）
 *
 * 为什么是纯函数：主进程（domain-bookmark 的缓存索引）与渲染层（书签编辑器预览）
 * 可以跑**同一份**规则，不存在"两处各写一遍、慢慢漂移"。
 * 索引对象由调用方持有并负责持久化/失效 —— 本模块不碰 DB、不碰 electron。
 *
 * 词法口径与旧版 `fullTextSearch#tokenize` 对齐（小写 / 去撇号 / 非字母数字转空格 /
 * NFD 去变音 / 停用词 / 长度上限），唯一的差异是**不做 Porter 词干化**：
 * 真源包要同时被主进程与渲染层引用，保持零依赖；英文标签的召回略降，不影响中文标签。
 */

/** 旧版视为"域名噪声"的词项，不参与索引。 */
const GENERIC_TOKENS = new Set(['http', 'htps', 'www', 'com', 'net', 'html', 'pdf', 'file'])

/** 停用词表（与旧版同一份，来源 elasticlunr 的 stop_word_filter）。 */
const STOP_WORDS = new Set([
  '', 'a', 'able', 'about', 'across', 'after', 'all', 'almost', 'also', 'am', 'among', 'an',
  'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'but', 'by', 'can', 'cannot',
  'could', 'dear', 'did', 'do', 'does', 'either', 'else', 'ever', 'every', 'for', 'from',
  'get', 'got', 'had', 'has', 'have', 'he', 'her', 'hers', 'him', 'his', 'how', 'however',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'least', 'let', 'like', 'likely',
  'may', 'me', 'might', 'most', 'must', 'my', 'neither', 'no', 'nor', 'not', 'of', 'off',
  'often', 'on', 'only', 'or', 'other', 'our', 'own', 'rather', 'said', 'say', 'says',
  'she', 'should', 'since', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'tis', 'to', 'too', 'twas', 'us', 'wants', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'yet', 'you', 'your'
])

const NON_LETTER = /[^\p{L}\p{N}\s]+/gu
const WHITESPACE = /\s+/g
const MAX_TOKENS = 20000
const MAX_TOKEN_LENGTH = 100

/**
 * 文本 → 词项数组（小写、去变音、去停用词）。
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeText(input: string) : string[] {
  if (!input) return []
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019]+/g, '')
    .replace(NON_LETTER, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(WHITESPACE)
    .filter((t) => t && !STOP_WORDS.has(t) && t.length <= MAX_TOKEN_LENGTH)
    .slice(0, MAX_TOKENS)
}

/**
 * 页面 → 去重词项。URL 只取"主机名去掉 TLD + 前两段路径"——
 * 域名后缀与路径深层对标签推荐没有区分度（旧版同口径）。
 * `file://` / `hi://` 包裹的真实地址会先剥一层。
 * @param {{ url?: string|null, title?: string|null }} page
 * @returns {string[]}
 */
export function getPageTokens(page: { url?: string|null, title?: string|null }) : string[] {
  const rawUrl = page && page.url ? String(page.url) : ''
  let urlChunk = ''
  if (rawUrl) {
    try {
      let url = new URL(rawUrl)
      const nestedUrl = url.searchParams.get('url')
      if ((rawUrl.startsWith('file://') || rawUrl.startsWith('hi://')) && nestedUrl) {
        url = new URL(nestedUrl)
      }
      urlChunk = url.hostname.split('.').slice(0, -1).join(' ') + ' ' +
        url.pathname.split('/').filter((p) => p.length > 1).slice(0, 2).join(' ')
    } catch (_) {
      // 非法 URL：只用标题，绝不因一条坏数据中断索引
    }
  }

  const title = page && page.title ? String(page.title) : ''
  const heading = /^(http|https|file):\/\//.test(title) ? '' : title
  const tokens = tokenizeText(`${heading} ${urlChunk}`)

  const seen = new Set()
  const out = []
  for (const token of tokens) {
    if (token.length <= 2 || GENERIC_TOKENS.has(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/**
 * 新建一份空索引。
 *
 * `docs` 保存每个被索引页面的词项快照 —— 删除/更新时**用建索引时的词项**回滚，
 * 而不是拿当前值重算（URL/标题改过就重算对不上，会把计数越减越歪）。
 *
 * @returns {{
 *   docs: Map<string, { tokens: string[], tags: string[], lastVisit: number }>,
 *   totalDocs: number,
 *   termDocCounts: Map<string, number>,
 *   termTags: Map<string, Map<string, number>>,
 *   tagCounts: Map<string, number>,
 *   tagTagMap: Map<string, Map<string, number>>,
 *   tagUpdateTimes: Map<string, number>
 * }}
 */
export function createTagIndex() : {
  docs: Map<string, { tokens: string[], tags: string[], lastVisit: number }>,
  totalDocs: number,
  termDocCounts: Map<string, number>,
  termTags: Map<string, Map<string, number>>,
  tagCounts: Map<string, number>,
  tagTagMap: Map<string, Map<string, number>>,
  tagUpdateTimes: Map<string, number>
} {
  return {
    docs: new Map(),
    totalDocs: 0,
    termDocCounts: new Map(),
    termTags: new Map(),
    tagCounts: new Map(),
    tagTagMap: new Map(),
    tagUpdateTimes: new Map()
  }
}

/** 清空索引（保留对象引用，调用方持有的句柄继续有效）。 */
/** @param {ReturnType<typeof createTagIndex>} index */
export function clearTagIndex(index: ReturnType<typeof createTagIndex>) {
  index.docs.clear()
  index.termDocCounts.clear()
  index.termTags.clear()
  index.tagCounts.clear()
  index.tagTagMap.clear()
  index.tagUpdateTimes.clear()
  index.totalDocs = 0
}

/** @param {Map<string, number>} map @param {string} key @param {number} delta */
function bump(map: Map<string, number>, key: string, delta: number) {
  const next = (map.get(key) || 0) + delta
  if (next > 0) map.set(key, next)
  else map.delete(key)
}

/** @param {Map<string, Map<string, number>>} outer @param {string} key @param {string} inner @param {number} delta */
function bumpNested(outer: Map<string, Map<string, number>>, key: string, inner: string, delta: number) {
  let innerMap = outer.get(key)
  if (!innerMap) {
    if (delta <= 0) return
    innerMap = new Map()
    outer.set(key, innerMap)
  }
  const next = (innerMap.get(inner) || 0) + delta
  if (next > 0) innerMap.set(inner, next)
  else innerMap.delete(inner)
  if (innerMap.size === 0) outer.delete(key)
}

/** @param {unknown} tags @returns {string[]} 去重后的非空标签 */
function normalizeTags(tags: unknown) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const out = []
  for (const raw of tags) {
    const tag = String(raw == null ? '' : raw).trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/** @param {any} page @returns {string} */
function pageId(page: unknown) {
  if (!page) return ''
  const source = typeof page === 'object' ? page as Record<string, unknown> : {}
  if (source.id != null && source.id !== '') return String(source.id)
  return source.url ? String(source.url) : ''
}

/**
 * 把一个页面加入索引（幂等：同 id 重复索引会先回滚旧快照）。
 * 没有标签的页面不入索引 —— 标签索引只关心"被标注过的页面"。
 * @param {ReturnType<typeof createTagIndex>} index
 * @param {{ id?: string|null, url?: string|null, title?: string|null, tags?: string[]|null, lastVisit?: number }} page
 * @returns {boolean} 是否真正入索引
 */
export function indexPage(index: ReturnType<typeof createTagIndex>, page: { id?: string|null, url?: string|null, title?: string|null, tags?: string[]|null, lastVisit?: number }) : boolean {
  const id = pageId(page)
  if (!id) return false
  if (index.docs.has(id)) unindexPage(index, id)

  const tags = normalizeTags(page.tags)
  if (tags.length === 0) return false

  const tokens = getPageTokens(page)
  const lastVisit = Number(page.lastVisit) || 0
  index.docs.set(id, { tokens, tags, lastVisit })
  index.totalDocs++

  for (const token of tokens) bump(index.termDocCounts, token, 1)
  for (const tag of tags) {
    for (const token of tokens) bumpNested(index.termTags, token, tag, 1)
    bump(index.tagCounts, tag, 1)
    for (const other of tags) {
      if (other !== tag) bumpNested(index.tagTagMap, tag, other, 1)
    }
    if (lastVisit > (index.tagUpdateTimes.get(tag) || 0)) index.tagUpdateTimes.set(tag, lastVisit)
  }
  return true
}

/**
 * 从索引里移除一个页面（按 id 找快照；也可直接传 id）。
 * 未索引过的页面是无操作 —— 调用方不必先判断。
 * @param {ReturnType<typeof createTagIndex>} index
 * @param {string|{ id?: string|null, url?: string|null }} pageOrId
 * @returns {boolean}
 */
export function unindexPage(index: ReturnType<typeof createTagIndex>, pageOrId: string|{ id?: string|null, url?: string|null }) : boolean {
  const id = typeof pageOrId === 'string' || typeof pageOrId === 'number'
    ? String(pageOrId)
    : pageId(pageOrId)
  if (!id) return false

  const entry = index.docs.get(id)
  if (!entry) return false
  index.docs.delete(id)
  index.totalDocs--

  const { tokens, tags } = entry
  for (const token of tokens) bump(index.termDocCounts, token, -1)
  for (const tag of tags) {
    for (const token of tokens) bumpNested(index.termTags, token, tag, -1)
    bump(index.tagCounts, tag, -1)
    for (const other of tags) {
      if (other !== tag) bumpNested(index.tagTagMap, tag, other, -1)
    }
  }
  // tagUpdateTimes 与旧版一致：只增不减（"最近用过"是历史事实，删页面不代表没用过）
  return true
}

/**
 * 先回滚旧快照、再索引新快照。`newPage` 为空即纯移除。
 * @param {ReturnType<typeof createTagIndex>} index
 * @param {{ id?: string|null, url?: string|null }|null} oldPage
 * @param {{ id?: string|null, url?: string|null, title?: string|null, tags?: string[]|null, lastVisit?: number }|null} newPage
 */
export function reindexPage(index: ReturnType<typeof createTagIndex>, oldPage: { id?: string|null, url?: string|null }|null, newPage: { id?: string|null, url?: string|null, title?: string|null, tags?: string[]|null, lastVisit?: number }|null) {
  const oldId = pageId(oldPage)
  const newId = pageId(newPage)
  // id 变化时分别处理（书签 id 不会变，这里只是把契约写完整）
  if (oldId && oldId !== newId) unindexPage(index, oldId)
  if (newPage) indexPage(index, newPage)
  else if (oldId) unindexPage(index, oldId)
}

/**
 * 页面 → 全量标签打分（降序）。
 *
 * 打分公式与旧版逐字一致：
 *   score += (docsWithTag / termDocCount)² × (0.85 + 0.1 × √termDocCount)
 *   · 标签自身是页面词项 → ×1.5（"标签就是这个词"的强信号）
 *   · 只有同时被多个文档、多个词项支撑的标签才保留分数（防单例噪声）
 *
 * @param {ReturnType<typeof createTagIndex>} index
 * @param {{ url?: string|null, title?: string|null }} page
 * @returns {Array<{ tag: string, value: number }>}
 */
export function rankTags(index: ReturnType<typeof createTagIndex>, page: { url?: string|null, title?: string|null }) : Array<{ tag: string, value: number }> {
  const tokens = getPageTokens(page)
  const scores = new Map()
  const contributingDocs = new Map()
  const contributingTerms = new Map()

  for (const term of tokens) {
    const tagMap = index.termTags.get(term)
    if (!tagMap) continue
    const docCount = index.termDocCounts.get(term) || 1
    const weight = Math.pow(1 / docCount, 2) * (0.85 + 0.1 * Math.sqrt(docCount))
    for (const [tag, docsWithTag] of tagMap) {
      if ((index.tagCounts.get(tag) || 0) < 2) continue
      scores.set(tag, (scores.get(tag) || 0) + docsWithTag * docsWithTag * weight)
      contributingDocs.set(tag, (contributingDocs.get(tag) || 0) + docsWithTag)
      contributingTerms.set(tag, (contributingTerms.get(tag) || 0) + 1)
    }
  }

  const out = []
  for (const [tag, score] of scores) {
    const firstToken = tokenizeText(tag)[0]
    const value = firstToken && tokens.includes(firstToken) ? score * 1.5 : score
    const supported = (contributingDocs.get(tag) || 0) > 1 && (contributingTerms.get(tag) || 0) > 1
    out.push({ tag, value: supported ? value : 0 })
  }
  return out.sort((a, b) => b.value - a.value)
}

/**
 * 为页面推荐标签：取前 `limit` 个且分数 > `threshold`（旧版 3 / 0.66）。
 * @param {ReturnType<typeof createTagIndex>} index
 * @param {{ url?: string|null, title?: string|null, tags?: string[]|null }} page
 * @param {{ limit?: number, threshold?: number }} [opts]
 * @returns {string[]}
 */
export function suggestTags(index: ReturnType<typeof createTagIndex>, page: { url?: string|null, title?: string|null, tags?: string[]|null }, { limit = 3, threshold = 0.66 } = {}) : string[] {
  const owned = new Set(normalizeTags(page && page.tags))
  return rankTags(index, page)
    .slice(0, Math.max(0, limit))
    .filter((item) => item.value > threshold && !owned.has(item.tag))
    .map((item) => item.tag)
}

/**
 * 已选标签 → 下一个标签的自动补全（共现次数 × 时间衰减）。
 *
 * `score = tagCount × Π coOccur(selected, tag) × max(2 − age / 14d, 1)`
 * 无已选标签时退化为热度榜 —— 与旧版一致。
 *
 * @param {ReturnType<typeof createTagIndex>} index
 * @param {string[]} searchTags
 * @param {{ limit?: number, now?: number, halfLifeDays?: number }} [opts]
 * @returns {string[]}
 */
export function autocompleteTags(index: ReturnType<typeof createTagIndex>, searchTags: string[], { limit = 8, now = Date.now(), halfLifeDays = 14 } = {}) : string[] {
  const selected = normalizeTags(searchTags)
  const selectedSet = new Set(selected)
  const halfLifeMs = Math.max(1, halfLifeDays) * 24 * 60 * 60 * 1000
  const scored = []

  for (const [tag, count] of index.tagCounts) {
    if (selectedSet.has(tag)) continue
    let score = count
    for (const searchTag of selected) {
      const coMap = index.tagTagMap.get(searchTag)
      score *= (coMap && coMap.get(tag)) || 0
      if (score <= 0) break
    }
    if (score <= 0) continue
    score *= Math.max(2 - ((now - (index.tagUpdateTimes.get(tag) || 0)) / halfLifeMs), 1)
    scored.push({ tag, score })
  }

  return scored
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
    .slice(0, Math.max(0, limit))
    .map((item) => item.tag)
}

/**
 * 标签热度榜（供 `bookmark:tags` 复用，避免 domain 里再写一遍聚合）。
 * @param {ReturnType<typeof createTagIndex>} index
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{ tag: string, count: number }>}
 */
export function listTagCounts(index: ReturnType<typeof createTagIndex>, { limit = 100 } = {}) : Array<{ tag: string, count: number }> {
  return [...index.tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, Math.max(0, limit))
}
