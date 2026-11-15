/**
 * web-error.mjs —— 我们自己的**错误页**地址的**唯一构造点**。
 *
 * 为什么必须只有一处：错误页的 query 形状（`errorCode` / `url` / `initial` / `surface`）被
 * 协议层（`hira://error` 的处理器）与渲染页（`pages/error/`）同时消费 —— 多一处拼装
 * 就多一处漂移，表现是"某个入口的错误页少了一个字段、重试按钮失效"。
 *
 * 现在有两个"网页面"会用到它：标签页（`infra-window/tabEvents.js`）与
 * 独立侧栏（`apps/main/web-sidebar.js`）。两者都不是"另写一份"，而是引这里。
 *
 * 纯函数：零依赖、零 IO。
 */

import { pageUrl } from './page-url.js'

/** 错误页地址的基址（`isWebErrorUrl` 的前缀也用它，不另写一份字面量）。 */
const ERROR_PAGE = pageUrl('error')

/**
 * @param {number|string} errorCode Chromium 的网络错误码（如 -105 = ERR_NAME_NOT_RESOLVED）
 * @param {string} failedUrl 加载失败的那个地址
 * @param {'tab'|'web-sidebar'} [surface] 错误页所在宿主；决定按钮应操作标签还是侧栏
 * @returns {string} `hira://error?...`（调用方直接 loadURL）
 */
export function webErrorUrl(
  errorCode: unknown,
  failedUrl: unknown,
  surface: 'tab' | 'web-sidebar' = 'tab'
): string {
  return pageUrl('error', {
    errorCode: String(errorCode == null ? '' : errorCode),
    url: String(failedUrl == null ? '' : failedUrl),
    initial: 1,
    surface: surface === 'web-sidebar' ? 'web-sidebar' : ''
  })
}

/**
 * 这个地址是不是错误页本身。
 *
 * 用途：加载失败处理要**跳过**"错误页自己加载失败"这一种情况，否则会无限自噬
 * （错误页 → 又失败 → 又切错误页）。
 * @param {string} url
 */
export function isWebErrorUrl(url: unknown): boolean {
  return String(url == null ? '' : url).startsWith(ERROR_PAGE)
}

/**
 * 错误页**背后**那个加载失败的地址。
 *
 * 错误页是**过渡视图**，不是用户要访问的页面：地址栏要显示它、刷新要重试它、
 * 休眠快照要记它。这些判断都只能从错误页 URL 的 `url` query 里取回原地址 ——
 * 取出规则只放在这里，任何调用方都不许自己 `new URL` 再拼一遍。
 *
 * @param {string} url 错误页地址（非错误页返回 ''）
 * @returns {string} 失败的原地址；解析不出也返回 ''
 */
export function failedUrlOfErrorPage(url: unknown): string {
  const raw = String(url == null ? '' : url)
  if (!isWebErrorUrl(raw)) return ''
  try {
    return String(new URL(raw).searchParams.get('url') || '')
  } catch {
    return ''
  }
}
