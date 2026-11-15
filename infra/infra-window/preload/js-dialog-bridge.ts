/**
 * JS Dialog 桥（preload 侧）—— `window.alert/confirm/prompt` 的**唯一出口**。
 *
 * 为什么单独拆一份：需要"网页式对话框"的渲染进程不止标签页一种 ——
 *   · 标签页（tab-preload）、
 *   · 侧边面板 / rail / 独立侧栏（panel-preload）。
 * 过去这套桥只内联在 tab-preload 里，面板里的 `confirm`（如「删除集锦」）就落回
 * Electron 的**系统原生对话框**，与网页弹窗的样子完全不一致（用户实测反馈）。
 * 桥的协议（通道名 / 同步语义 / 兜底返回值）只有一份真源，各 preload 只负责调用。
 *
 * 同步语义（真同步，对齐 HiraRT prompts 的 promise-hold）：
 *   · alert / beforeunload：`sendSync(show)` 立即返回默认值，主进程异步开浮层；
 *   · confirm / prompt：`send(showAsync)` 异步开浮层 + **单次** `sendSync(pollResult)`。
 *     主进程若结果未就绪会**挂起该事件**（不写 returnValue），等用户响应后再写入 ——
 *     渲染进程同步等待即可，主进程事件循环不被阻塞，也不存在轮询自旋烧 CPU。
 *     主进程侧有兜底超时，异常情况下不会永久挂起。
 *
 * ⚠ sandbox 下 preload 不能 require 本地文件，因此这里必须是 **ESM import**，
 * 由 electron-vite / rollup 在构建时内联进各 preload 产物（与 password-autofill
 * 等引擎同一口径）。
 */

import { JS_DIALOG_CHANNELS } from '@hira-ng/shared-types/src/js-dialog-channels'
import type { ContextBridge, IpcRenderer } from 'electron'

interface JsDialogOptions {
  type?: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  [key: string]: unknown
}

/**
 * 把 `window.__jsDialogBridge` 暴露给页面 main world。
 *
 * 调用方负责"是否该注入"的前置判定（如 `hira-game://` 这类第三方 bundle 不注入），
 * 本函数只管暴露；已暴露过（热重载等）时静默忽略。
 *
 * @param {import('electron').IpcRenderer} ipcRenderer
 * @param {import('electron').ContextBridge} contextBridge
 */
export function exposeJsDialogBridge(ipcRenderer: IpcRenderer, contextBridge: ContextBridge): void {
  let tokens = 3
  let refilledAt = Date.now()
  function allowDialog(): boolean {
    const now = Date.now()
    tokens = Math.min(3, tokens + Math.max(0, now - refilledAt) / 1000)
    refilledAt = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }

  /** 单次同步等待用户结果（主进程结果未就绪时挂起该事件，不是忙等）。 */
  function pollForResult(): { action?: string; value?: string } | null {
    try {
      return ipcRenderer.sendSync(JS_DIALOG_CHANNELS.pollResult)
    } catch (_) {
      return null
    }
  }

  try {
    contextBridge.exposeInMainWorld('__jsDialogBridge', {
      // alert / prompt / beforeunload：同步返回默认值（页面继续执行）
      show: function (options: JsDialogOptions) {
        if (!allowDialog()) {
          if (options && options.type === 'prompt') return null
          if (options && options.type === 'confirm') return false
          if (options && options.type === 'beforeunload') return 'leave'
          return undefined
        }
        try {
          return ipcRenderer.sendSync(JS_DIALOG_CHANNELS.show, options)
        } catch (_e) {
          if (options && options.type === 'prompt') return null
          if (options && options.type === 'confirm') return false
          if (options && options.type === 'beforeunload') return 'leave'
          return undefined
        }
      },
      // confirm 真同步：等待用户真实选择（取消 / 关闭浮层一律 false）
      confirmSync: function (options: JsDialogOptions) {
        if (!allowDialog()) return false
        try {
          options.type = 'confirm'
          ipcRenderer.send(JS_DIALOG_CHANNELS.showAsync, options)
          const result = pollForResult()
          return result ? (result.action === 'ok') : false
        } catch (_) {
          return false
        }
      },
      // prompt 真同步：等待用户输入；取消返回 null（与原生 prompt 一致）
      promptSync: function (options: JsDialogOptions) {
        if (!allowDialog()) return null
        try {
          options.type = 'prompt'
          ipcRenderer.send(JS_DIALOG_CHANNELS.showAsync, options)
          const result = pollForResult()
          if (result && result.action === 'ok') return result.value || ''
          return null
        } catch (_) {
          return null
        }
      }
    })
  } catch (_e) {
    // bridge 已暴露（热重载等情况），忽略
  }
}
