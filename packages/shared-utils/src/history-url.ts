/**
 * 历史 URL 身份（纯函数，零依赖）。
 *
 * ── 判定机制 ────────────────────────────────────────────────────
 * 一条 URL 身份 = 一行 `history` 聚合；每次访问只在 `history_visits` 追加日志，
 * 所以「同一页」必须映射到同一个身份，否则列表里就会一个页面裂成 2~3 条
 * （大型站点的 SPA 会在跳转时不断改写 URL：B 站的 `spm_id_from` / `trackid` /
 * `vd_source`、各种广告归因 `utm_*` / `gclid`，以及 `/a/` 与 `/a` 两种写法）。
 *
 * 身份由三步构成：
 *   1. WHATWG `URL` 规范化（小写 scheme/host、去默认端口、百分号编码归一）——
 *      与 Chromium 的 GURL 同源；
 *   2. 剥掉**纯追踪参数**（只影响归因，不影响页面内容），其余参数与顺序原样保留
 *      （很多签名 URL 对参数顺序敏感，排序会直接 403）；
 *   3. 非根路径去掉尾斜杠（`/a/` 与 `/a` 是同一页；根路径 `/` 保留）。
 *
 * 明确**不做**：不去 `www.`、不跨站归一（YouTube 视频 id 等平台特判一律没有）、
 * 不改写 fragment —— 这些会把**不同页面**合成一条，比重复更糟。
 *
 * 「算不算普通网页」不在本模块判断 —— 取 `shared-types#url-protocols` 的唯一判据。
 */

const { isHttpProtocol } = require('@hira-ng/shared-types/src/url-protocols.mjs')

/** 精确匹配的追踪参数（小写）。前缀类见 `TRACKING_PARAM_PREFIXES`。 */
const TRACKING_PARAMS = new Set([
  // 通用广告 / 归因
  'gclid', 'dclid', 'gclsrc', 'gbraid', 'wbraid', 'gad_source', 'srsltid',
  'fbclid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'igshid', 'epik',
  'mc_eid', 'mc_cid', 'mkt_tok', '_hsenc', '_hsmi', 'vero_id', 'vero_conv',
  '_ga', '_gl',
  // 内容平台分享 / 推荐位（B 站、YouTube 等大型站点的高频噪声）
  'spm', 'spm_id_from', 'scm', 'vd_source', 'trackid', 'from_source',
  'from_spmid', 'share_source', 'share_medium', 'share_plat', 'share_session_id',
  'share_tag', 'unique_k', 'buvid', 'is_story_h5', 'plat_id', 'share_from',
  'ref_src', 'ref_url', 'click_id', 'si'
])

/** 前缀匹配的追踪参数：`utm_source` / `utm_medium` / …… 整族。 */
const TRACKING_PARAM_PREFIXES = ['utm_', 'pk_', 'mtm_', 'hsa_']

/** @param {string} key */
function isTrackingParam(key: unknown): boolean {
  const k = String(key || '').toLowerCase()
  if (!k) return false
  if (TRACKING_PARAMS.has(k)) return true
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (k.startsWith(prefix)) return true
  }
  return false
}

/**
 * 取原始 query 片段里参数的键（不解码值，避免重编码改变 URL 文本）。
 * @param {string} pair
 * @returns {string}
 */
function rawParamKey(pair: string): string {
  const eq = pair.indexOf('=')
  const rawKey = eq === -1 ? pair : pair.slice(0, eq)
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' ')).toLowerCase()
  } catch (_) {
    return rawKey.toLowerCase()
  }
}

/**
 * 历史身份：规范化 + 去追踪参数 + 去尾斜杠。非 http(s) 原样返回
 *（内部页 / about:blank 不进历史，但函数保持全函数，调用方仍可用 `isHttpUrl` 过滤）。
 * @param {string} urlString
 * @returns {string}
 */
function canonicalHistoryUrl(urlString: unknown): string {
  const raw = String(urlString || '')
  let parsed
  try {
    parsed = new URL(raw)
  } catch (_) {
    return raw
  }
  if (!isHttpProtocol(parsed.protocol)) return raw

  // 追踪参数：按原始片段过滤，保留其余参数的原样编码与顺序。
  if (parsed.search) {
    const pairs = parsed.search.slice(1).split('&').filter(Boolean)
    const kept = pairs.filter((pair) => !isTrackingParam(rawParamKey(pair)))
    if (kept.length !== pairs.length) {
      parsed.search = kept.length > 0 ? `?${kept.join('&')}` : ''
    }
  }

  // 非根路径去掉尾斜杠（`/a/` 与 `/a` 同一页；根路径保留 `/`）。
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
  }

  return parsed.href
}

export { canonicalHistoryUrl }
export default { canonicalHistoryUrl }
