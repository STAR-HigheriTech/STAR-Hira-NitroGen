/**
 * extension-icon.mjs —— 扩展图标协议地址（`hira://extension-icon?id=…&v=…`）的**唯一拼法**。
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────
 * 这条地址有**两个**生产者，且它们必须逐字一致（同一个端点、同样的 `v` 版本语义）：
 *   1. 标签图标兜底（`main/browser-window-runtime.js`，扩展页没有 favicon 时）；
 *   2. 扩展列表 / 详情（`main/ipc/extensions.js`，`iconDataUrl` 读盘失败时的兜底）。
 * 历史上两处各写一份 `new URLSearchParams(...)` 拼装，端点名与 `v` 的语义全靠
 * 「记得一起改」维系 —— 任何一处漂移都会让其中一侧静默 404（渲染层只看到破图）。
 * 因此把拼法收敛到这里：地址改哪里、`v` 何时带，都只在本文件决定。
 *
 * 注意：这是 hira 协议的**动态端点**（由 `hira-protocol.js` 的 `serveExtensionIcon`
 * 按 id 读盘响应），不是内部静态页，因此不进 `pages.mjs` 的身份表。
 */

import { pageUrl } from './page-url.js'

/**
 * 拼一块扩展图标的协议地址。
 *
 * 带版本号 = 图标换了就是**新 URL**，渲染层（`<img src>`）可放心按 URL 长期缓存；
 * 不带版本号（清单缺失 / 调用方拿不到）也能用，只是缓存无法随升级失效。
 *
 * @param {unknown} id 扩展 id；空值返回空串（调用方据此退回首字母徽标，绝不发注定 404 的请求）
 * @param {unknown} [version] 清单版本；空值则不带 `v` 参数
 * @param {unknown} [profileId] 扩展所属 profile；跨窗口图标读取用它选对 Session
 * @returns {string}
 */
export function extensionIconUrl(id: unknown, version: unknown, profileId?: unknown): string {
  const extensionId = String(id == null ? '' : id).trim()
  if (!extensionId) return ''
  const resolvedVersion = version == null ? '' : String(version).trim()
  const resolvedProfileId = profileId == null ? '' : String(profileId).trim()
  return pageUrl('extension-icon', {
    id: extensionId,
    ...(resolvedVersion ? { v: resolvedVersion } : {}),
    ...(resolvedProfileId ? { profile: resolvedProfileId } : {})
  })
}
