/**
 * URL → 站点信息（单一真源）
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────
 * 「当前站点」这个概念被三处同时消费：
 *   · 地址栏左侧的站点信息按钮（ui/ui-navbar）—— 决定显示锁 / 地球、悬停文案；
 *   · 站点设置聚合卡（ui/ui-panel-permissions）—— 决定聚合哪一站、按什么 key 查规则；
 *   · 编排层（apps/app-main/src/renderer/app-shell）—— 把活动标签的 URL 摊平成站点状态。
 * 三处各写一份 `new URL()` 解析，必然出现「按钮显示 example.com、面板却查 example.com:8443」
 * 这类对不上的问题。因此解析与归一全部收在这里，界面层只消费结果。
 *
 * ── 字段口径（与服务端必须一致）─────────────────────────────────────────
 * `domain` 的口径与 `packages/shared-utils` 的 `normalizeDomain` 完全一致：
 *   hostname + (port ? ':' + port : '')，不带协议、不带路径。
 * 只有口径一致，本文件给出的 domain 才能直接对上 `permission:list-all` 返回的
 * `domain` 字段、`cookie:list({ domain })` 的键、以及 `browsing-data:clear` 的 origin。
 *
 * 只接受 http / https：hira:// 内部页、about:blank、data:、file: 都不是「有站点身份」
 * 的页面（没有 cookie、没有权限可授权），返回 null 让调用方整体隐藏入口，
 * 而不是给一个看起来能点、点开全是空的假入口。
 */

import { isHttpProtocol } from './url-protocols.js'

/**
 * @typedef {Object} SiteInfo
 * @property {string} url      原始 URL（保留路径，供展示 / 复制）
 * @property {string} origin   `https://example.com`（含端口，不带末尾斜杠）—— 用于按站点清数据
 * @property {string} hostname `example.com`（不含端口）—— 用于 cookie:list 的 domain 键
 * @property {string} domain   `example.com[:port]` —— 与 normalizeDomain 同口径，用于权限规则匹配
 * @property {boolean} secure  https = true
 */



/**
 * 把任意 URL 解析成站点信息；不是普通网页则返回 null。
 * @param {unknown} url
 * @returns {SiteInfo | null}
 */
export interface SiteInfo {
  url: string
  origin: string
  hostname: string
  domain: string
  secure: boolean
}

export function siteInfoOfUrl (url: unknown): SiteInfo | null {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!raw) return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (!isHttpProtocol(parsed.protocol)) return null
  const hostname = parsed.hostname
  if (!hostname) return null
  const port = parsed.port
  return {
    url: raw,
    origin: parsed.origin,
    hostname,
    domain: hostname + (port ? `:${port}` : ''),
    secure: parsed.protocol === 'https:'
  }
}

/**
 * 两个站点是否同一个（按 domain 口径，忽略协议 / 路径 / 大小写）。
 * 面板里「当前站点」与规则行的匹配走这里，避免各处再手写比较。
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function isSameSite (a: unknown, b: unknown): boolean {
  const left = typeof a === 'string' ? a.trim().toLowerCase() : ''
  const right = typeof b === 'string' ? b.trim().toLowerCase() : ''
  return !!left && left === right
}
