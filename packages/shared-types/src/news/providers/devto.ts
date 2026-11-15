/**
 * 新闻源 · dev.to
 *
 * 数据来源：dev.to 的**官方公开 API**（免鉴权、带 CORS 头）。
 * 与 sspai / hackernews 一样都属第一方 —— 理由见 sspai.mjs 的文件头：
 * 第三方热榜聚合站是会被关掉的。
 *
 * 想看原站：https://dev.to/
 *
 * `hot` 用点赞数：dev.to 的反应数量级在几十到几百，显示成「热度 · 」是有意义的。
 */
import { defineProvider } from '../registry.js'
import { getJson } from '../http.js'

const ENDPOINT = 'https://dev.to/api/articles'

defineProvider({
  id: 'devto',
  name: 'dev.to',
  kind: 'news',
  home: 'https://dev.to/',
  async fetch({ signal, limit } = {}) {
    const count = Math.max(1, Math.min(Number(limit) || 40, 100))
    // top=7 → 取最近 7 天内最热的（不带这个参数会混进很旧的文章）
    const list = await getJson(`${ENDPOINT}?top=7&per_page=${count}`, { signal })
    const items = Array.isArray(list) ? list : []
    return items
      .filter((item) => item && item.title && item.url)
      .map((item) => {
        const time = Date.parse(item.published_at)
        return {
          id: String(item.id || item.url),
          title: String(item.title),
          url: String(item.url),
          hot: Number.isFinite(item.positive_reactions_count) ? item.positive_reactions_count : undefined,
          time: Number.isFinite(time) ? time : undefined
        }
      })
  }
})
