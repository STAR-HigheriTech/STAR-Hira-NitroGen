// @ts-check
/**
 * Verbatim suggestor: exact search + URL detection.
 * If input looks like a URL → website suggestion.
 * Otherwise → search suggestion using default search engine.
 */

import { defaultSearchUrl } from '@hira-ng/shared-types/src/search-engines.mjs'

/**
 * 兜底引擎：只在 searchbar 未注入 searchUrl（未接设置）时使用。
 * 正常路径一律走 ctx.searchUrl —— 那是设置里的默认搜索引擎。
 * 兜底值同样来自 `search-engines.mjs`，不在这里另抄一份 URL。
 * @type {(q:string)=>string}
 */
const FALLBACK: (q:string)=>string = (q: string): string => defaultSearchUrl(q)

/**
 * 是否"看起来像一个地址"。**唯一真源**：即时答案 suggestor 也复用它
 * （URL 输入不该再出网问一次性答案）。
 * @param {string} input
 * @returns {boolean}
 */
import type { SuggestorContext, Suggestion } from '../types'
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  // 任意带 scheme 的 URL：file://、hira://、about:、chrome://、chrome-extension://、http(s):// 等
  // 对齐 TabManager.normalizeUrl 支持的协议列表，避免 file://hira:// 被误判为搜索关键词
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true
  // about:blank 等 scheme: 形式（无 //）
  if (/^(about|blob|data|javascript|mailto|tel|ftp):/i.test(trimmed)) return true
  // localhost / IP
  if (/^(localhost|127\.0\.0\.1|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?(\/.*)?$/.test(trimmed)) return true
  // Windows 盘符绝对路径：C:\... 或 C:/...
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true
  // POSIX 绝对路径 / 家目录
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return true
  // domain.tld pattern
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(trimmed)) return true
  return false
}

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {import('../types').Suggestion[]}
 */
export function verbatimSuggestor(ctx: SuggestorContext): Suggestion[] {
  const q = ctx.query.trim()
  if (!q) return []
  const results: Suggestion[] = []
  const searchUrl = typeof ctx.searchUrl === 'function' ? ctx.searchUrl : FALLBACK

  if (looksLikeUrl(q)) {
    // 已带 scheme（http/https/file/hira/about/chrome/...）原样使用
    // 否则补 https://（域名/localhost/路径才走到这里）
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^(about|blob|data|mailto|tel|ftp):/i.test(q)
    const isLocalhost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(q)
    const url = hasScheme ? q : isLocalhost ? `http://${q}` : `https://${q}`
    results.push({
      type: 'website' as const,
      title: url,
      url,
      relevance: 502,
      source: 'verbatim'
    })
  }

  // Always provide a verbatim search suggestion
  results.push({
    type: 'search',
    query: q,
    url: searchUrl(q),
    relevance: 501,
    source: 'verbatim'
  })

  return results
}
