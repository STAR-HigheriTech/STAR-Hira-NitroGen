const { contextBridge, ipcRenderer, webUtils } = require('electron')
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'

// 独立面板 / rail / 侧栏也是独立 WebContentsView：同样接管文件拖入（与外壳同构）。
import './file-drop/index.js'
// 同样接管外壳拖拽项的「可放置」语义：面板边缘也常常压在网页之上，
// 不接这一条，拖标签经过面板缝时光标照样是禁止（见 internal-drag 文件头）。
import './internal-drag/index.js'
// JS Dialog 桥（alert/confirm/prompt/beforeunload）：与标签页共用同一份实现。
// 面板里的 `confirm`（删除集锦 / 导入确认等）走的就是 `window.confirm`（见 ui-common#confirm），
// 不注入这条桥就会落回 Electron 的**系统原生对话框**，和网页弹窗的样子不一致（用户实测反馈）。
import { exposeJsDialogBridge } from './js-dialog-bridge.js'

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
  /**
   * 单向发送（不等待、无 Promise）。
   * 面板里的 hover 预览必须落在**面板之外**（预览浮层是独立 WebContentsView，
   * 位置由主进程裁定），因此面板需要这条与外壳同构的通道来请求 show / hide。
   */
  send(route: string, payload?: unknown): void {
    const ch = makeChannel('ngipc', 'send', route)
    ipcRenderer.send(ch, payload)
  }
}

// 订阅登记用的进程内唯一作用域（listenerId 必须跨 webContents 全局唯一，见 shell-preload）
const listenerScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
let listenerSeq = 0

const on = {
  subscribe(route: string, listener: (payload: unknown) => void): () => void {
    const ch = makeChannel('ngipc', 'event', route)
    const fn = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(ch, fn)
    // 登记给主进程：事件只发给登记过的 webContents（见 infra-ipc/ListenerRegistry）
    const listenerId = `${listenerScope}#${++listenerSeq}`
    ipcRenderer.send(makeChannel('ngipc', 'send', PRELOAD_ROUTES.listenersAdd), { channel: route, listenerId })
    return () => {
      ipcRenderer.removeListener(ch, fn)
      ipcRenderer.send(makeChannel('ngipc', 'send', PRELOAD_ROUTES.listenersRemove), { listenerId })
    }
  }
}

/**
 * 文件的**真实路径**（拖入 / 文件选择之后要用）。
 *
 * Electron 43 起 `File.path` 已被移除，唯一正路是 `webUtils.getPathForFile`。
 * 需要它的是「把文件内容当作上下文」的面板（AI 助手的拖入与 `@` 文件）：
 * 渲染层只拿到 `File`，读盘在主进程，所以第一步得先把路径交出去。
 * 取不到（虚拟文件 / 非文件条目）返回空串，由调用方决定退化成读文本还是忽略。
 */
const files = {
        pathFor(file: File): string {
    try {
      return file ? (webUtils.getPathForFile(file) || '') : ''
    } catch (_) {
      return ''
    }
  }
}

contextBridge.exposeInMainWorld('hira', { provider, on, files })

// 面板是我们自己的本地页（file:// 载入 out/renderer/panels/），一律注入 —— 无白名单判定。
exposeJsDialogBridge(ipcRenderer, contextBridge)
