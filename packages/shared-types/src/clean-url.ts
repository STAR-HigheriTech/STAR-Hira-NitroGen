/**
 * clean-url —— 「复制干净链接」的**唯一纯规则**（零依赖、无 IO、不 require electron）。
 *
 * 为什么单独一份：这条判据要在**两处**成立且必须一致 ——
 *   · 菜单模型（`context-menu-model.js`）用它判断"这一项要不要出现"（去不掉东西就不显示）；
 *   · 命令表（`context-menu.js`）用它真正产出要写进剪贴板的文本。
 * 各写一份必然漂移：菜单说"能清"，复制出来却没变。
 *
 * 只清**公认的追踪参数**，不碰 `ref` / `from` / `source` 这类**可能是功能参数**的键
 * （很多站点靠它们决定跳转目标，删了会把链接改坏）。
 */

import { isHttpProtocol } from './url-protocols.js'

/** 前缀命中即清（大小写不敏感）。 */
const TRACKING_PREFIXES = Object.freeze([
  'utm_',   // Google Analytics 系（utm_source/medium/campaign/…）
  'oly_',   // Omeda
  'hsa_',   // HubSpot Ads
  'mtm_',   // Matomo（Piwik）
  'pk_',    // Matomo 旧版（pk_campaign / pk_kwd …）
  '_hs'     // HubSpot（_hsenc / _hsmi / _hsfp）
])

/** 精确命中即清（大小写不敏感）。 */
const TRACKING_EXACT = Object.freeze(new Set([
  'fbclid',          // Facebook
  'gclid',           // Google Ads
  'dclid',           // Google Display
  'msclkid',         // Microsoft Ads
  'yclid',           // Yandex
  'twclid',          // Twitter Ads
  'igshid',          // Instagram
  'mc_cid', 'mc_eid', // Mailchimp
  'mkt_tok',         // Marketo
  'vero_id',         // Vero
  'wickedid',        // Wicked Reports
  '_openstat',       // OpenStat
  'ref_src',         // Twitter 来源
  'spm', 'scm',      // 阿里系埋点
  'trk', 'trkcampaign' // LinkedIn
]))

/**
 * 去掉 URL 里的追踪参数。
 *
 * 不满足条件时**原样返回输入**（含非法 URL / 非 http(s) / 没有可清参数）——
 * 调用方据此判断"有没有变化"，没有变化就不该给用户一个点了没反应的菜单项。
 *
 * @param {unknown} url
 * @returns {string} 清理后的 URL；无可清理时等于输入的 trim 结果
 */
export function stripTrackingParams(url: unknown): string {
  const raw = String(url == null ? '' : url).trim()
  if (!raw) return raw
  let parsed
  try {
    parsed = new URL(raw)
  } catch (_) {
    return raw
  }
  if (!isHttpProtocol(parsed.protocol)) return raw

  const drop = []
  for (const key of parsed.searchParams.keys()) {
    const k = String(key).toLowerCase()
    if (TRACKING_EXACT.has(k) || TRACKING_PREFIXES.some((prefix) => k.startsWith(prefix))) drop.push(key)
  }
  if (drop.length === 0) return raw
  for (const key of drop) parsed.searchParams.delete(key)

  let out = parsed.toString()
  // `searchParams.delete` 清空后 URL 仍可能以 `?` 结尾，去掉它更干净。
  if (parsed.search === '' && out.endsWith('?')) out = out.slice(0, -1)
  return out
}
