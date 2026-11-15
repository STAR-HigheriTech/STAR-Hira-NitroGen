/**
 * 小窗预览（N1，Arc 的 Little Arc）的自绘标题栏。
 *
 * ── 这个窗口里只有标题栏是我们的 ───────────────────────────────────
 * 正文是主进程贴在标题栏**正下方**的原生 `WebContentsView`（见 `main/peek.js`）——
 * 它盖住 `.content` 那一块，所以本模块不画任何界面，只做三件事：
 *   ① 量出标题栏高度并上报（主进程据此把网页视图贴在它正下方）；
 *   ② 亮出最小化按钮并接线（subwindow 那一族里只有小窗需要它）；
 *   ③ 让标题跟随网页标题。
 *
 * 关闭按钮不用额外做：subwindow 入口本来就有一个，`window.close()` 直接关掉整个窗口。
 * 标题栏样式与书签编辑器**完全同一套**（共享 `.header` / `.header__btn`），
 * 所以也不在这里改任何样式。
 *
 * 解耦原则同其它窗口模块：不 import infra / domain，只经 `window.hira` 说话。
 */

import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { SubwindowMountContext } from './contract.js'

function hira() {
  return globalThis.window ? globalThis.window.hira : null
}

export function mountPeek({ content }: Pick<SubwindowMountContext, 'content'>) {
  const bridge = hira()
  const header = document.querySelector('.header')

  // 正文区归原生网页视图（它就盖在这一块上）：这里留空，
  // 否则"加载中..."那句占位会先闪一下再被网页盖掉。
  if (content) {
    content.textContent = ''
    content.style.display = 'none'
  }

  // ① 标题栏高度上报：**由渲染侧量**，因为高度在 DOM 里（padding / 字体 / 按钮尺寸
  //    共同决定），主进程猜一个常量就会差出"网页与标题栏之间一条白缝"。
  //    与主窗口上报 chrome 几何是同一条思路（几何由渲染层量，主进程不猜）。
  if (bridge && bridge.provider && typeof bridge.provider.send === 'function') {
    const reportChrome = () => {
      try {
        const h = header ? Math.round(header.getBoundingClientRect().height) : 0
        if (h > 0) bridge.provider.send(IPC_ROUTES.peekChrome, { titlebarHeight: h })
      } catch (_) {}
    }
    reportChrome()
    // 字体加载完成可能改变行高 → 再报一次（上报是幂等的，主进程只按最新值落位）
    try {
      if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
        document.fonts.ready.then(reportChrome).catch(() => {})
      }
    } catch (_) {}
  }

  // ② 最小化 / 最大化：**由 subwindow 入口统一接线**（见 subwindow/main.js#wireWindowControls）——
  //    它按 `window:get-state` 回报的真实能力亮按钮：本窗口 `maximizable:false`，
  //    于是只亮「最小化 + 关闭」。这里**刻意不再自己接一遍**，否则一次点击会触发两次。
  //
  // ③ 标题跟随网页：主进程推（渲染页观测不到**另一条** webContents 的标题事件）
  if (bridge && bridge.on && typeof bridge.on.subscribe === 'function') {
    bridge.on.subscribe(IPC_EVENTS.peekTitle, (title) => {
      const text = String(title == null ? '' : title).trim() || '小窗预览'
      const el = document.getElementById('title')
      if (el) el.textContent = text
      document.title = text
    })
  }
}
