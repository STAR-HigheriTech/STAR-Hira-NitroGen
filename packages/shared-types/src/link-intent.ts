/**
 * link-intent.mjs —— 「这一次点击应该怎么打开链接」的**唯一规则源**（零依赖纯函数）
 *
 * ── 为什么必须只有这一处 ──────────────────────────────────────────────────
 * 网页里的 Ctrl+点击由 Chromium 原生处理（`setWindowOpenHandler` 收到
 * `disposition: 'background-tab'`，见 infra-window#tabEvents）；但**内部页**
 * （hira://newtab / bookmarks / history…）里的链接是页面自己的 JS 打开的。
 * 如果每个页面各写一段 `if (e.ctrlKey) …`，规则必然漂移，最终表现就是用户实测的
 * 「网页里 Ctrl+点击能开新标签，内部页里点了却把当前页顶掉 / 什么都不发生」。
 *
 * 所以修饰键 → 意图的映射收在这一份里（纯数据 + 纯函数，不碰 DOM / 不碰 IPC），
 * 由 `pages/_shared/runtime.js#openLink` 统一执行 —— 那是内部页"打开链接"的唯一出口。
 *
 * ── 口径（对齐 Chrome）────────────────────────────────────────────────────
 *   · 无修饰 / 左键            → current    当前标签页
 *   · Ctrl / Cmd / 中键        → background 后台新标签（不抢焦点）
 *   · Ctrl+Shift / 中键+Shift  → foreground 前台新标签
 *   · Shift                    → window     新窗口
 *   · Alt                      → current    （Chrome 是"下载"，浏览器不接管，避免误伤）
 *
 * 注意：这里只回答"意图"，**怎么落地由执行侧决定**（例如内部页没有"带着目标地址
 * 开新窗口"的通道，openLink 会把 window 降级为前台新标签，而不是静默丢掉动作）。
 */

export const LINK_INTENT = Object.freeze({
  CURRENT: 'current',
  BACKGROUND: 'background',
  FOREGROUND: 'foreground',
  WINDOW: 'window'
})

/** 中键（`click` / `auxclick` 的 button 值）。 */
const MIDDLE_BUTTON = 1

export interface LinkIntentEvent {
  button?: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

/**
 * 从一次鼠标事件解析打开意图。
 * @param {any} event MouseEvent（或任何带 button / ctrlKey / metaKey / shiftKey 的对象）
 * @returns {'current'|'background'|'foreground'|'window'}
 */
export function resolveLinkIntent(event: LinkIntentEvent | null | undefined): (typeof LINK_INTENT)[keyof typeof LINK_INTENT] {
  if (!event || typeof event !== 'object') return LINK_INTENT.CURRENT
  const middle = typeof event.button === 'number' && event.button === MIDDLE_BUTTON
  // 只认左键 / 中键；右键（2）等交给 contextmenu，不在这里抢。
  if (typeof event.button === 'number' && !middle && event.button !== 0) {
    return LINK_INTENT.CURRENT
  }
  const primary = Boolean(event.ctrlKey || event.metaKey) || middle
  const shift = Boolean(event.shiftKey)
  if (primary) return shift ? LINK_INTENT.FOREGROUND : LINK_INTENT.BACKGROUND
  return shift ? LINK_INTENT.WINDOW : LINK_INTENT.CURRENT
}

/**
 * 这次点击是否需要"另开一个目标"（不是当前标签页）。
 * @param {any} event
 * @returns {boolean}
 */
export function opensNewTarget(event: LinkIntentEvent | null | undefined): boolean {
  return resolveLinkIntent(event) !== LINK_INTENT.CURRENT
}
