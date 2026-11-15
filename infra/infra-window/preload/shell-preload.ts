const { contextBridge, ipcRenderer } = require('electron')
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'

// 系统文件拖入外壳任意区域（导航栏 / 标签条 / 侧栏 / 工具栏）→ 本窗口开新标签。
// 必须静态内联：sandbox 下 preload 不能 require 本地文件（见该文件头）。
import './file-drop/index.js'
// 外壳拖拽项经过**浮层视图**（落位预览 / 分屏工具条 / 悬停 URL…）时同样要显示拖拽光标。
// 浮层是独立 WebContentsView，指针进它以后事件就归它了 —— 外壳 DOM 的 drop 处理够不着；
// 不接这一条，框一浮出来光标就当场变「禁止」（正是"拖标签到网页中央没有拖拽光标"的现场）。
import './internal-drag/index.js'

function makeChannel(scope: string, kind: string, route?: string | null): string {
  const base = scope + ':' + kind
  if (!route) return base
  return base + ':' + route
}

const provider = {
  invoke(route: string, payload?: unknown): Promise<unknown> {
    const ch = makeChannel('ngipc', 'invoke', route)
    return ipcRenderer.invoke(ch, payload)
  },
  // 单向 IPC：不等待主进程返回，适合 fire-and-forget 场景（浮层 show/hide/display）。
  // 用 send 前缀避免与 invoke 的 handle 通道冲突。
  send(route: string, payload?: unknown): void {
    const ch = makeChannel('ngipc', 'send', route)
    ipcRenderer.send(ch, payload)
  }
}

// 订阅登记用的进程内唯一作用域：listenerId 必须**跨 webContents 全局唯一** ——
// 主进程按 id 记账，两个渲染进程若都生成 "tab:changed#1" 就会互相覆盖，
// 表现为「其中一个窗口订阅了却收不到事件」。
const listenerScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
let listenerSeq = 0

const on = {
  subscribe(route: string, listener: (payload: unknown) => void): () => void {
    const ch = makeChannel('ngipc', 'event', route)
    const fn = (_e: Electron.IpcRendererEvent, payload: unknown) => {
      try {
        listener(payload)
      } catch (error) {
        console.error(`[preload] event listener failed: ${route}`, error)
      }
    }
    ipcRenderer.on(ch, fn)
    // 登记给主进程：事件只发给登记过的 webContents（见 infra-ipc/ListenerRegistry）。
    // 与挂监听同 tick 发出，确保不会出现「已订阅但主进程还不知道」的窗口期。
    const listenerId = `${listenerScope}#${++listenerSeq}`
    ipcRenderer.send(makeChannel('ngipc', 'send', PRELOAD_ROUTES.listenersAdd), { channel: route, listenerId })
    return () => {
      ipcRenderer.removeListener(ch, fn)
      ipcRenderer.send(makeChannel('ngipc', 'send', PRELOAD_ROUTES.listenersRemove), { listenerId })
    }
  }
}

contextBridge.exposeInMainWorld('hira', { provider, on })
