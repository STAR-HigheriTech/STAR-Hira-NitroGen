const path = require('path')
const { hasKnownScheme, isNonWebUrl } = require('./url-schemes')
// 内部页地址的唯一拼法（真源 pages.mjs）—— PDF 查看器地址也不手拼。
const { pageUrl } = require('@hira-ng/shared-types/src/pages')

/**
 * 把「用户输入」规整为可加载的 URL（纯函数，无副作用）。
 *
 * 协议白名单来自 url-schemes 注册中心（内建 http/https/about/file/chrome…
 * + 各协议模块自行注册的 hira:/hira-game:…）：infra 不认识具体业务协议，
 * 上层新增协议只需在自己那里 registerUrlScheme()，本文件无需改动。
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeUrl(input: unknown): string {
  const raw = String(input || '').trim()
  if (!raw) return 'about:blank'
  if (/^https?:\/*/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return raw.replace(/^(https?):\/*/i, (_match, scheme: string) => `${scheme.toLowerCase()}://`)
  }
  if (/^file:\/*/i.test(raw) && !/^file:\/\/\//i.test(raw)) {
    const rest = raw.replace(/^file:\/*/i, '')
    return /^[a-zA-Z]:[\\/]/.test(rest) ? `file:///${rest.replace(/\\/g, '/')}` : `file://${rest}`
  }
  if (hasKnownScheme(raw)) {
    return raw
  }
  // Windows / POSIX 绝对路径：转换为 file:// URL
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    const normalized = raw.replace(/\\/g, '/')
    return `file:///${normalized}`
  }
  if (raw.startsWith('/')) {
    return `file://${raw}`
  }
  if (raw.startsWith('~')) {
    try {
      const os = require('os')
      const home = os.homedir()
      const expanded = path.resolve(home, raw.slice(1))
      return `file://${expanded.replace(/\\/g, '/')}`
    } catch {}
  }
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(raw)) {
    return `http://${raw}`
  }
  return `https://${raw}`
}

/**
 * 判断 URL 是否为 PDF（基于扩展名或 ?file= 参数猜测）。
 * 不拦截内部/特殊协议（about:、file:、chrome:、hira:、hira-game:…）——
 * 判定走 url-schemes 注册中心，新增协议无需改这里。
 * file:// 跳过以避免跨域加载问题（本地 PDF 由浏览器默认查看器处理）。
 * @param {string} url
 * @returns {boolean}
 */
export function isPdfUrl(url: unknown): boolean {
  const u = String(url || '').toLowerCase()
  if (!u) return false
  if (isNonWebUrl(u)) return false
  try {
    const parsed = new URL(u)
    const p = parsed.pathname || ''
    if (p.toLowerCase().endsWith('.pdf')) return true
    if (parsed.searchParams.has('file')) {
      const f = parsed.searchParams.get('file') || ''
      if (f.toLowerCase().endsWith('.pdf')) return true
    }
    return false
  } catch {
    return u.endsWith('.pdf')
  }
}

/** 将 PDF URL 包装为 RT 同名的 hira://pdf-viewer 查看器 URL */
export function wrapPdfUrl(url: string): string {
  return pageUrl('pdf', { url })
}

/**
 * PDF 分流的**唯一判据**：这个地址最终该去哪（`tabUrl` 是这条判据的家）。
 *
 * 三件事串成一步：①确实是 PDF；②设置里没关掉内置查看器；③于是改道
 * `hira://pdf-viewer`（旧 `hira://pdf` 继续作为协议别名兼容）。
 * **为什么必须收成一个函数**：这套组合原先在四处各写一遍 ——
 *   新建标签（`TabManager#_createTabSync`）、地址栏导航（`TabManager#navigate`）、
 *   页面自己发起的导航（`tabEvents` 的 will-navigate / will-redirect）、独立侧栏（`web-sidebar`）。
 * 任何一处漏判设置项，表现就是"内置查看器已经关了，可某条路径还是把它拦去查看器了" ——
 * 这类漂移只能靠**只有一份**来杜绝。
 *
 * @param {string} url 已归一化的地址
 * @param {(url: string) => boolean} [shouldUseViewer] 设置端口（返回 false = 已关闭内置查看器）。
 *   ⚠ 允许调用方传**带完整①②判据**的版本（本项目 `TabManager#_shouldUsePdfViewer` 就是），
 *   那样只会把①多判一次，结果不变 —— 于是两种口径都能安全接进来。
 *   端口缺省或抛错时**保守按开启处理**（与出厂默认一致）：设置故障不该变成功能缺失。
 * @returns {string} 该去的地址；不需要改道时**原样返回**（调用方据"是否等于原地址"判断要不要拦）
 */
export function resolvePdfTarget(url: unknown, shouldUseViewer?: (url: string) => boolean): string {
  const target = String(url == null ? '' : url)
  if (!isPdfUrl(target)) return target
  if (typeof shouldUseViewer === 'function') {
    try {
      if (shouldUseViewer(target) === false) return target
    } catch (_) {}
  }
  return wrapPdfUrl(target)
}

/**
 * 取 URL 的站点标识（hostname，仅 http/https）—— 判断「是否换了站点」用。
 *
 * 非 http(s)（hira://、about:、file:// …）与无法解析的一律返回 ''，视作「不同站点」——
 * 这条"一律视为换站"是有意为之：hira:// 内部页之间互相跳转时，图标就该换（各自有各自的图标）。
 *
 * 判据不在这里 —— 真源是 `shared-types#url-protocols` 的 `siteKeyOf`
 * （与注入规则 host 归一、按域名分组标签同一份）。本文件只保留 URL 规整类工具。
 */

