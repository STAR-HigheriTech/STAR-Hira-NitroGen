/**
 * page-inject —— 网页注入的**哑通道**（infra 层）。
 *
 * 它只做一件事：把给定的 CSS / JS 加到这一页上。**不认识** Boosts / 强制深色 / 用户脚本
 * 分别是什么 —— 三者的规则形状、站点匹配与载荷拼装全在
 * `packages/shared-types/src/page-inject`（纯层，可单测）。
 * 这样"往页面上加东西"只有一个实现，而"加什么、为什么加"留在上层。
 *
 * 两条硬要求：
 *   1. **绝不抛** —— 注入失败只是这一页没效果，不能影响导航 / 事件链；
 *   2. **不堆叠** —— 同一 wc 重复注入前先移除上一轮插入的样式键，否则同一段 CSS 会叠加生效。
 */

import type { WebContents } from 'electron'

interface PageInjectionPayload { css?: string; js?: string }

const insertedKeys = new WeakMap<WebContents, string[]>()

/**
 * 把载荷应用到某个 webContents。空载荷直接返回（不做无谓的跨进程往返）。
 *
 */
export function applyPageInjections(webContents: WebContents | null | undefined, payload?: PageInjectionPayload): void {
  if (!webContents) return
  try {
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return
  } catch (_) {
    return
  }
  const css = payload && typeof payload.css === 'string' ? payload.css : ''
  const js = payload && typeof payload.js === 'string' ? payload.js : ''
  if (!css && !js) return

  if (css) {
    // 先清掉上一轮的注入（同页重载可能复用同一个 wc）。
    const prev = insertedKeys.get(webContents) || []
    for (const key of prev) {
      try { webContents.removeInsertedCSS(key) } catch (_) {}
    }
    insertedKeys.delete(webContents)
    try {
      const pending = webContents.insertCSS(css)
      if (pending && typeof pending.then === 'function') {
        pending
          .then((key: string) => { if (key) insertedKeys.set(webContents, [String(key)]) })
          .catch(() => {})
      }
    } catch (_) {}
  }

  if (js) {
    try {
      const pending = webContents.executeJavaScript(js, true)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch (_) {}
  }
}

