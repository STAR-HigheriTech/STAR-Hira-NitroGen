/**
 * share —— 「分享 / 二维码」（N15）的**唯一纯规则**。
 *
 * 一处定义就能让五类宿主（横向标签条 / 纵向标签列 / 两个面板 / 覆盖层）
 * 用同一条链接形态 —— 它们是不同的 bundle，各写一遍字符串迟早漂移
 *（一处带 `encodeURIComponent`、一处不带，遇到带 `&` 的 URL 就断在中间）。
 */

import { pageUrl } from './page-url.js'

/** 分享页（内部页，由 hira-protocol 从 out/pages/share/ 提供）。 */
export const SHARE_PAGE = pageUrl('share')

/**
 * 由页面 URL 造出分享页地址。
 * @param {unknown} target
 * @returns {string} 无 URL 时返回分享页本身（页面会提示"没有可分享的地址"）
 */
export function shareUrlFor(target: unknown): string {
  const url = String(target == null ? '' : target).trim()
  if (!url) return SHARE_PAGE
  return pageUrl('share', { url })
}

/**
 * 从分享页的 `location.search` 里取回原始 URL（可能为空）。
 * @param {unknown} search 形如 `?url=https%3A%2F%2F…`
 * @returns {string}
 */
export function pageUrlFromShareQuery(search: unknown): string {
  try {
    const params = new URLSearchParams(String(search == null ? '' : search).replace(/^\?/, ''))
    return params.get('url') || ''
  } catch (_) {
    return ''
  }
}
