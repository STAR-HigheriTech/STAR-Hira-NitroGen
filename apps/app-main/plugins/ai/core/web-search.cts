/**
 * AI 引擎 · 联网检索（PART15 §9「联网」）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么自己解析结果页，而不是接一个搜索 API
 * ══════════════════════════════════════════════════════════════════════
 * 搜索 API 都要 key / 计费 / 账号，而这里的需求只是"给模型几条可引用的链接"：
 * 结果页本身就是 http 文本，抓一次 + 剥标签即可。因此走**无凭证的共享 session**
 * （与 fetch-page.cjs 同一条纪律：不带 cookie，不把登录态带进后台请求）。
 *
 * 引擎是**可替换的**：每个引擎只提供 `url(query)` + `parse(html, limit)` 两件事。
 * 新增一家（Brave、Ecosia……）只需在 ENGINES 里加一项，工具层零改动。
 * 首选引擎失败（超时 / 反爬拦截 / 空结果）自动降到下一个 —— 不把"某一家挂了"
 * 变成"联网不可用"。
 *
 * 输出统一为 `{ title, url, snippet }`：这正是界面"来源"列表要显示的三件事。
 */

const { fetchHtml, decodeEntities, collapse } = require('./fetch-page.cjs')

interface AnchorRecord { cls: string; href: string; html: string }
interface SearchResult { title: string; url: string; snippet: string }
interface SearchEngine { url(query: string): string; parse(html: string, limit: number): SearchResult[] }
type EngineName = 'duckduckgo' | 'bing'

/** 单次检索最多取几条（工具层另有更小的上限，这里只兜底）。 */
const MAX_RESULTS = 20

/** 解析页面上所有 `<a>`（类名 / href / 内文分开给，供各引擎各自挑选）。 */
function parseAnchors(html: string): AnchorRecord[] {
  const out: AnchorRecord[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html))) {
    const attrs = m[1] || ''
    const cls = (/class\s*=\s*["']([^"']*)["']/i.exec(attrs) || [])[1] || ''
    const href = decodeEntities((/href\s*=\s*["']([^"']*)["']/i.exec(attrs) || [])[1] || '')
    out.push({ cls, href, html: m[2] })
  }
  return out
}

/** 标签内文 → 纯文本（搜索结果的标题 / 摘要都只需一行字）。 */
function textOf(html: unknown, max: number): string {
  return collapse(decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))).slice(0, max)
}

/**
 * 把"跳转链接"还原成真实站点地址。
 *
 * DuckDuckGo 的结果链接是 `//duckduckgo.com/l/?uddg=<encoded>`；
 * Bing 的是 `https://www.bing.com/ck/a?...&u=a1<base64url>`。
 * 不还原的话来源列表里全是搜索站自己的地址 —— 对用户毫无意义。
 */
function unwrapRedirect(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const uddg = u.searchParams.get('uddg')
    if (uddg) return uddg
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname === '/ck/a') {
      const raw = u.searchParams.get('u') || ''
      // `a1` 前缀是 Bing 的"这是一条 base64url 编码的目标地址"标记。
      if (/^a1/.test(raw)) {
        const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/')
        try { return Buffer.from(b64, 'base64').toString('utf8') } catch (_) { /* 落到原样 */ }
      }
    }
    return href
  } catch (_) {
    return href
  }
}

/** DuckDuckGo HTML 版：`result__a` 标题 + `result__snippet` 摘要，按出现次序一一配对。 */
function parseDuck(html: string, limit: number): SearchResult[] {
  const anchors = parseAnchors(html)
  const titles = anchors.filter((a) => /\bresult__a\b/.test(a.cls))
  const snippets = anchors.filter((a) => /\bresult__snippet\b/.test(a.cls))
  const out: SearchResult[] = []
  const seen = new Set<string>()
  for (let i = 0; i < titles.length && out.length < limit; i++) {
    const url = unwrapRedirect(titles[i].href)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    const title = textOf(titles[i].html, 200)
    if (!title) continue
    seen.add(url)
    out.push({ title, url, snippet: snippets[i] ? textOf(snippets[i].html, 300) : '' })
  }
  return out
}

/** Bing：每条结果是 `<li class="b_algo">`，块内第一个 `<a>` 是标题、第一个 `<p>` 是摘要。 */
function parseBing(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = []
  const seen = new Set<string>()
  const re = /<li\b[^>]*class\s*=\s*["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    const block = m[1]
    const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const url = unwrapRedirect((/href\s*=\s*["']([^"']*)["']/i.exec(a[1]) || [])[1] || '')
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    if (/^(www\.)?bing\.com$/i.test(new URL(url).hostname || '')) continue
    const title = textOf(a[2], 200)
    if (!title) continue
    seen.add(url)
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    out.push({ title, url, snippet: p ? textOf(p[1], 300) : '' })
  }
  return out
}

/**
 * 引擎表：`parse` 是纯函数（html, limit）→ 结果数组。
 * 顺序即"首选 → 降级"的顺序；`webSearch` 的 `engine` 参数只改变起点。
 */
const ENGINES: Record<EngineName, SearchEngine> = {
  duckduckgo: {
    url: (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=wt-wt`,
    parse: parseDuck
  },
  bing: {
    url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hans`,
    parse: parseBing
  }
}

const ENGINE_NAMES = Object.keys(ENGINES) as EngineName[]

/**
 * 联网检索。
 *
 * @param {string} query
 * @param {{ limit?: number, engine?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, query: string, engine?: string,
 *   results: Array<{title: string, url: string, snippet: string}>, reason?: string }>}
 */
async function webSearch(query: string, { limit = 8, engine = '', timeoutMs = 15000 }: { limit?: number; engine?: string; timeoutMs?: number } = {}) : Promise<{ ok: boolean, query: string, engine?: string,
  results: Array<{title: string, url: string, snippet: string}>, reason?: string }> {
  const q = String(query || '').trim()
  if (!q) return { ok: false, query: '', results: [], reason: 'empty-query' }
  const max = Math.min(Math.max(Math.round(Number(limit) || 8), 1), MAX_RESULTS)

  // 指定的引擎优先，其余按表序兜底（去重，避免同一家试两遍）。
  const typedEngine = engine === 'duckduckgo' || engine === 'bing' ? engine : ''
  const order: EngineName[] = typedEngine
    ? [typedEngine, ...ENGINE_NAMES.filter((name) => name !== typedEngine)]
    : ENGINE_NAMES
  let reason = ''
  for (const name of order) {
    const res = await fetchHtml(ENGINES[name].url(q), { timeoutMs })
    if (!res.ok) { reason = `${name}: ${res.reason}`; continue }
    const results = ENGINES[name].parse(res.html, max)
    if (results.length) return { ok: true, query: q, engine: name, results }
    reason = `${name}: empty`
  }
  return { ok: false, query: q, results: [], reason: reason || 'no-results' }
}

module.exports = { webSearch, ENGINES, ENGINE_NAMES, unwrapRedirect }
