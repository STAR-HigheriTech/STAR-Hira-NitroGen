/**
 * 新闻源 · 少数派
 *
 * 数据来源：少数派**自己的**公开接口 —— 这是刻意的选择。
 * 原来那两个聚合站（api-hot.imsyy.top / api.vvhan.com）在 2026-10-07 的排查里
 * **域名已经解析不到了**（不是限流、不是地区问题，是没了）。
 * 结论：第一方接口的存活率远高于第三方聚合，所以现在只接第一方。
 *
 * 想看原站：https://sspai.com/
 *
 * 不提供 `hot`：少数派的点赞量级是个位数，显示成「热度 5」没有意义 ——
 * 少一项信息，好过给一项噪音（卡片会只显示「来源 · 时间」）。
 */
import { defineProvider } from '../registry.js'
import { getJson } from '../http.js'

const ENDPOINT = 'https://sspai.com/api/v1/article/index/page/get'

defineProvider({
  id: 'sspai',
  name: '少数派',
  kind: 'news',
  home: 'https://sspai.com/',
  async fetch({ signal, limit } = {}) {
    const count = Math.max(1, Math.min(Number(limit) || 40, 50))
    const data = await getJson(`${ENDPOINT}?limit=${count}&offset=0`, { signal })
    const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const list = Array.isArray(payload.data) ? payload.data : []
    return list
      .filter((item) => item && item.id && item.title)
      .map((item) => ({
        id: String(item.id),
        title: String(item.title),
        url: `https://sspai.com/post/${item.id}`,
        // released_time 是**秒**，统一成毫秒（service 与 relativeTime 都按毫秒算）
        time: Number.isFinite(item.released_time) ? item.released_time * 1000 : undefined
      }))
  }
})
