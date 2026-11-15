// @ts-check
/**
 * 开发模式提示（F-0770）。
 *
 * 归档自旧版 `js/searchbar/developmentModeNotification.js`：它不是"搜索建议"，
 * 而是一条**常驻状态提示** —— 开发态（未打包）时在地址栏下拉底部留一行，
 * 提醒当前跑的不是正式构建。
 *
 * 解耦要点：
 *   · 是否开发态由编排层注入（`isDevelopmentMode()`，数据来自主进程 `app:info`），
 *     本模块不认识 electron / process.env；
 *   · relevance 压到最低（1）—— 永远排在真实建议之后，绝不抢首选项；
 *   · `!` 模式不显示：那是在列 bang，混一行状态提示只会干扰；
 *   · 点击它没有导航语义（没有 url），宿主按普通 suggestion 提交时会被 `suggestionToUrl`
 *     返回空串而自然忽略 —— 无需在提交路径上再开特例。
 */

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {import('../types').Suggestion[]}
 */
import type { SuggestorContext, Suggestion } from '../types'
export function developmentModeSuggestor(ctx: SuggestorContext): Suggestion[] {
  let enabled = false
  try {
    enabled = !!(typeof ctx.isDevelopmentMode === 'function' && ctx.isDevelopmentMode())
  } catch (_) {
    enabled = false
  }
  if (!enabled) return []

  // `!` 是"列出全部 bang"的模式，状态提示在这里没有意义。
  if (ctx.query.trim().startsWith('!')) return []

  return [{
    type: 'dev-mode',
    title: '开发模式已启用（未打包构建）',
    relevance: 1,
    source: 'dev-mode'
  }]
}
