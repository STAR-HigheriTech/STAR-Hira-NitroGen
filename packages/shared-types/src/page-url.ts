/**
 * page-url.mjs —— 内部页地址的**唯一拼法**（`hira://<host>?<query>`）。
 *
 * 为什么单独成文件：地址拼法是最底层的原语，任何模块都可能要拼一个内部页地址
 * （设置大类里的「门」、分享链接、错误页…）。若把它留在身份表 `pages.mjs` 里，
 * 这些叶子模块就得反向依赖整张身份表；而 `pages.mjs` 又依赖 `settings-groups.mjs`
 * 取分组标题 —— 于是 `settings-groups.mjs` 只能手抄 `'hira://about/'`。
 * 本文件**零依赖**，谁都能引，这条悖论就消失了。
 *
 * 身份（host / 中文名 / 字形 / 侧栏分组）仍在 `pages.mjs`；这里只管"怎么拼"。
 */

/**
 * `query` 支持两种形态：
 *   · 字符串 —— 原样拼（带不带 `?` 都行），用于 `'tab=update'` 这类深链；
 *   · 对象   —— 走 URLSearchParams（自动编码），空值自动丢弃。
 *
 * @param {unknown} host
 * @param {string | Record<string, unknown>} [query]
 * @returns {string}
 */
export function pageUrl(host: unknown, query?: string | Record<string, unknown>): string {
  const key = String(host == null ? '' : host).trim().toLowerCase()
  const base = key ? `hira://${key}` : 'hira://'
  if (query == null || query === '') return base
  if (typeof query === 'string') {
    return base + (query.startsWith('?') ? query : `?${query}`)
  }
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value == null || value === '') continue
    params.set(name, String(value))
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}
