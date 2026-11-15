// @ts-check
/**
 * 即时答案 suggestor（F-0771~F-0773）：把「像一个问题」的输入变成可直接看答案的候选行。
 *
 * 分层约定：
 *   · 出网 / 解析 / 缓存**全部在主进程**（main/instant-answer.js + shared-types/instant-answer.mjs），
 *     本 suggestor 只做 UI 侧的取舍与形状归一 —— UI 包不摸 IPC、不碰网络；
 *   · 数据入口由编排层注入（`ctx.getInstantAnswers`），缺失时静默不参与。
 *
 * 何时参与（宁缺毋滥，免费 API 不该被输入抖动打爆）：
 *   · 仅默认引擎是 DuckDuckGo（`duckduckgo` / `ddg`）—— 上游就是 DDG Instant Answer，
 *     用 Google 的人不该看到 DDG 的答案卡片；
 *   · 排除 `!bang` 与 URL 输入 —— 那是有明确目标的动作，不是"问问题"；
 *   · 至少 4 个字符（英文一个词 ≈ 4 字符起，中文 4 字起才算完整短语）。
 *
 * relevance 量纲（与既有建议对齐，见 calc/verbatim/remote）：
 *   answer 590 / abstract 580 / related 560 —— 高于逐字搜索（501）与网址（502），
 *   低于计算器（600）与本地命中（书签 700+、历史 ≤760），永不误抢首选项。
 */

import { looksLikeUrl } from './verbatim'

/** 上游支持即时答案的默认引擎键名。 */
const SUPPORTED_ENGINES = new Set(['duckduckgo', 'ddg'])

/** kind → relevance：答案最硬、摘要次之、相关条目只作补充。 */
const RELEVANCE = Object.freeze({ answer: 590, abstract: 580, related: 560 })

/** 主进程一次最多回几条就渲染几条；再多会挤掉本地命中。 */
const MAX_ITEMS = 3

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {Promise<import('../types').Suggestion[]>}
 */
import type { SuggestorContext, Suggestion } from '../types'
import { defineSuggestor } from '../core/define-suggestor'

function instantAnswerSearch(ctx: SuggestorContext): Promise<Suggestion[]> {
  const getAnswers = ctx.getInstantAnswers
  if (typeof getAnswers !== 'function') return Promise.resolve([])
  if (typeof ctx.getDefaultEngine === 'function') {
    let engine = ''
    try { engine = String(ctx.getDefaultEngine() || '').toLowerCase() } catch (_) { engine = '' }
    if (!SUPPORTED_ENGINES.has(engine)) return Promise.resolve([])
  } else {
    // 拿不到默认引擎就不猜：错引擎上展示外来答案比不展示更糟。
    return Promise.resolve([])
  }

  const q = ctx.query.trim()
  if (q.length < 4 || q.startsWith('!') || looksLikeUrl(q)) return Promise.resolve([])

  return Promise.resolve()
    .then(() => getAnswers.call(ctx, q, MAX_ITEMS))
    .then((items) => {
      if (!Array.isArray(items)) return []
      return items
        .filter((it) => it && typeof it.title === 'string' && it.title)
        .slice(0, MAX_ITEMS)
        .map((it, i) => {
          const kind = it.kind === 'answer' || it.kind === 'related' ? it.kind : 'abstract'
          return {
            // id 稳定（同一次查询内不随渲染变化）：键盘上下移动时选中项不会跳。
            id: `ia:${kind}:${it.url || it.title}:${i}`,
            type: 'instant-answer',
            kind,
            title: it.title,
            text: typeof it.text === 'string' ? it.text : '',
            // 没有 url 的答案（纯计算结果类）提交时回落到"用该 query 搜索"，见 suggestionToUrl。
            url: typeof it.url === 'string' ? it.url : '',
            icon: typeof it.icon === 'string' ? it.icon : '',
            provider: typeof it.provider === 'string' ? it.provider : 'DuckDuckGo',
            query: q,
            relevance: RELEVANCE[kind],
            source: 'instant-answer'
          }
        })
    })
    .catch(() => [])
}

// 出网链路必须放到慢相，不能拖住本地建议的首屏渲染。
export const instantAnswerSuggestor = defineSuggestor(instantAnswerSearch, { phase: 'slow', id: 'instant-answer' })
