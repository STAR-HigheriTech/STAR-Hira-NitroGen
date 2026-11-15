/**
 * search-url —— 搜索模板 → 搜索 URL 的**唯一纯规则**（零依赖、无 IO、不 require electron）。
 *
 * 为什么单独一份：这条换算**两处**都要用 ——
 *   · 默认搜索引擎（编排层 `search-controller`，用户按回车时构造 URL）；
 *   · 地址栏 `!bang`（`ui-searchbar` 的 bangs/自定义引擎建议）。
 * 各写一份的结果必然是"默认引擎认 `{query}`、bang 只认 `%s`"这种同一模板两种结果。
 *
 * 支持的模板写法（按优先级依次匹配，兼容常见搜索引擎）：
 *   1. 含 `{query}` 占位符            → 直接替换
 *   2. 含 `%s` 占位符                 → 直接替换（旧式 printf 风格）
 *   3. 已带 `?q= / &q= / p= / wd=`    → 就地替换该参数的值
 *   4. 其它（以 `?` 或 `=` 结尾、或裸域名）→ 追加 `?q=` 或直接拼接
 *
 * @param {string} template 搜索引擎模板（如 `https://www.google.com/search?q=`）
 * @param {string} query 关键词
 * @returns {string} 可导航的搜索 URL；模板为空时返回空串
 */
export function buildSearchUrl(template: unknown, query: unknown): string {
  const encoded = encodeURIComponent(String(query == null ? '' : query).trim())
  const tpl = String(template || '')
  if (!tpl) return ''
  if (tpl.includes('{query}')) return tpl.replaceAll('{query}', encoded)
  if (tpl.includes('%s')) return tpl.replaceAll('%s', encoded)
  if (/[?&](q|query|p|wd)=/i.test(tpl)) {
    return tpl.replace(/([?&](?:q|query|p|wd)=)[^&]*/i, `$1${encoded}`)
  }
  return `${tpl}${tpl.includes('?') || tpl.endsWith('=') ? '' : '?q='}${encoded}`
}
