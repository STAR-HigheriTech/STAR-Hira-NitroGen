/**
 * AI 引擎 · 联网工具（web_search / web_fetch）。
 *
 * 与其它工具文件同一条纪律：这里只做"声明 + 形状收口"，真正的抓取在
 * fetch-page.cjs（取页）与 web-search.cjs（结果页解析）里，可单独替换。
 *
 * ── 来源（sources）是这里的第一公民 ──────────────────────────────────
 * 用户要求"联网搜索时列出参考网页、被总结网页，透明可视化"。做法不是让模型
 * 自己复述链接（它会漏、会编），而是让**工具结果自带结构化来源**：
 *   `sources: [{ title, url, kind }]`
 * turn-runner 会把它们汇总进本轮的 assistant 记录并落库，界面照着渲染。
 * 这样"用过哪些网页"是执行事实，不是模型的叙述。
 */

const { fetchPage } = require('./fetch-page.cjs')
const { webSearch } = require('./web-search.cjs')

import type { AiToolDefinition, JsonSchema, ToolArgs, UnknownRecord } from '../types'

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 一条来源的统一形状（界面按 url 去重，kind 只用于文案）。 */
function sourceOf(item: unknown, kind: string): { title: string; url: string; kind: string } {
  const record = item && typeof item === 'object' ? item as UnknownRecord : {}
  return {
    title: String(record.title || '') || String(record.url || ''),
    url: String(record.url || ''),
    kind
  }
}

/** @param {{ }} [host] 预留：联网工具目前不需要宿主能力（共享 session 由 net 提供）。 */
function createWebTools(): AiToolDefinition[] {
  const tools: AiToolDefinition[] = [
    {
      name: 'web_search',
      description:
        '联网搜索：返回若干条 {title,url,snippet}。需要最新信息、自己不掌握的事实、或用户明确要求查资料时用它；' +
        '拿到链接后可用 web_fetch 读正文再总结。结果会自动登记为本次回答的来源。',
      parameters: obj({
        query: { type: 'string', description: '搜索词（自然语言即可）' },
        limit: { type: 'number', description: '条数，默认 6，上限 10' },
        engine: { type: 'string', enum: ['duckduckgo', 'bing'], description: '指定引擎；省略则自动选择并在失败时降级' }
      }, ['query']),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const query = String(args.query || '').trim()
        if (!query) throw new Error('query 不能为空')
        const limit = clampInt(args.limit, 6, 1, 10)
        const engine = String(args.engine || '').trim().toLowerCase()
        const res = await webSearch(query, { limit, engine })
        if (!res.ok) {
          // 明确失败原因（超时 / 被拦 / 空结果）：模型据此决定"换关键词"还是"告诉用户查不到"。
          return { ok: false, query, reason: res.reason, results: [], sources: [] }
        }
        const results: Array<{ title: string; url: string; snippet: string }> = (Array.isArray(res.results) ? res.results : []).map((raw: unknown) => {
          const r = raw && typeof raw === 'object' ? raw as UnknownRecord : {}
          return { title: String(r.title || ''), url: String(r.url || ''), snippet: String(r.snippet || '') }
        })
        return {
          ok: true,
          query,
          engine: res.engine,
          results,
          // 搜索页面的**每条结果**都是来源：用户点得开、可核对。
          sources: results.map((r: { title: string; url: string; snippet: string }) => sourceOf(r, 'search'))
        }
      }
    },
    {
      name: 'web_fetch',
      description:
        '读取一个 http/https 页面的正文（不执行页面脚本、不带登录态），返回标题与纯文本。' +
        '喜欢先从 web_search 拿链接，再用它读全文；页面会被登记为来源。',
      parameters: obj({
        url: { type: 'string', description: '完整 http/https 地址' },
        maxChars: { type: 'number', description: '正文上限字符数，默认 20000，上限 60000' }
      }, ['url']),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const url = String(args.url || '').trim()
        if (!/^https?:\/\//i.test(url)) throw new Error('只允许 http/https 地址')
        const maxChars = clampInt(args.maxChars, 20000, 1000, 60000)
        const page = await fetchPage(url, { maxChars, maxLinks: 20 })
        if (!page.ok) return { ok: false, url, reason: page.reason, sources: [] }
        return {
          ok: true,
          url: page.url || url,
          title: page.title || '',
          text: page.text || '',
          truncated: !!page.truncated,
          // 即便标题为空也要留一条来源：用户要能看到"读过哪个地址"。
          sources: [sourceOf({ title: page.title, url: page.url || url }, 'page')]
        }
      }
    }
  ]
  return tools
}

module.exports = { createWebTools }
