/**
 * 新闻源 · Hacker News（英文科技圈首页）
 * 数据来源：Algolia 的 HN 官方搜索 API（https://hn.algolia.com/api）——
 * 一次请求拿回完整列表（HN 官方 Firebase API 要 1+N 次请求，不要）。
 * 免鉴权、带 CORS 头。
 *
 * 排在降级链末尾：它是境外接口，国内的可用性不如前面几家，但内容质量高，
 * 前面几家都拿不到时它是很好的第二落点。
 */
import { defineProvider } from '../registry.js'
import { getJson } from '../http.js'

const ENDPOINT = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40'

export const hackerNewsProvider = defineProvider({
  id: 'hackernews',
  name: 'Hacker News',
  kind: 'news',
  home: 'https://news.ycombinator.com/',
  async fetch({ signal }) {
    const json = await getJson(ENDPOINT, { signal })
    const payload = json && typeof json === 'object' ? json as Record<string, unknown> : {}
    const hits = Array.isArray(payload.hits) ? payload.hits : []
    return hits.map((h) => {
      const id = String(h.objectID || '')
      return {
        id: 'hn:' + id,
        title: h.title || h.story_title || '',
        // Ask HN / Show HN 这类没有外链，回到讨论页
        url: h.url || h.story_url || (id ? `https://news.ycombinator.com/item?id=${id}` : ''),
        hot: h.points,
        time: Number(h.created_at_i) ? Number(h.created_at_i) * 1000 : undefined,
        source: 'HN'
      }
    })
  }
})
