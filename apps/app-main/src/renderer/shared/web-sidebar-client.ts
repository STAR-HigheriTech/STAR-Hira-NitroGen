/**
 * web-sidebar-client —— **独立侧栏（Web Sidebar）** 的渲染层客户端。
 *
 * 与 `panels-client` **并列而不是合并**：面板与侧栏是两套平行系统（见
 * apps/main/web-sidebar.js 的文件头）。把两者塞进同一个 client，就是又走回
 * "两个板块共用一条通道"的老路 —— 下一次改动必然只改一半。
 *
 * 本模块只搬运事实：不认识布局、不认识视图、不认识面板目录。
 */
import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

interface WebSidebarState extends JsonRecord {
  open?: boolean
  url?: string
  title?: string
  favicon?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/** 拖动过程量：单向发送，不等主进程回包。 */
function send(route: string, payload?: unknown): void {
  try {
    getHiraBridge().provider.send(route, payload)
  } catch (_) {}
}

export const webSidebarClient = {
  /**
   * **把这个 URL 放进侧栏**（书签右键 / 收藏面板右键 / rail 的 `+`）。
   *
   * 语义是"打开"不是"开关"：同一个书签点两次不会把它关掉。
   * @param {string} [url] 省略 = 把**当前页**放上侧栏（活动标签只有主进程权威）
   * @param {{ side?: 'left'|'right', title?: string }} [opts]
   * @returns {Promise<{ open: boolean, url: string }>}
   */
  open(url?: unknown, opts?: { side?: 'left' | 'right'; title?: string }) : Promise<{ open: boolean, url: string }> {
    const o = opts || {}
    const side = o.side === 'left' || o.side === 'right' ? o.side : undefined
    const target = url == null ? '' : String(url)
    return invoke(IPC_ROUTES.webSidebarOpen, {
      ...(target ? { url: target } : {}),
      side,
      title: o.title ? String(o.title) : undefined
    })
  },

  /** 收起侧栏（视图与会话都留着，再打开时页面状态还在）。 */
  close() {
    return invoke(IPC_ROUTES.webSidebarClose, {})
  },

  /** 侧栏宽度（拖内缘逐帧上报；主进程做区间校验并落库）。 */
  setWidth(width: number) {
    return invoke(IPC_ROUTES.webSidebarSetWidth, { width: Number(width) || 0 })
  },

  /**
   * 拖动中的宽度（单向、无 Promise、无回包）。
   *
   * 逐帧路径只负责把原生 view 跟到指针位置；松手时再走 `setWidth` 做最终确认。
   * 这样不会在 60/120Hz 的指针链上制造 invoke 回包、Promise 与 GC 压力。
   */
  setWidthLive(width: number) {
    send(IPC_ROUTES.webSidebarSetWidth, { width: Number(width) || 0 })
  },

  /**
   * **拖动顶条换边**：拖动中持续上报指针在**顶条视图内**的 x（单向、高频，不等回执）。
   *
   * 它只报"指针在哪"—— 目标侧别由主进程按窗口中线算，预览也由它推给外壳。
   * 与 `setWidth` 走 invoke 不同：那一条要落库（需要结果），这一条是逐帧过程量。
   */
  movePreview(viewX: number) {
    getHiraBridge().provider.send(IPC_ROUTES.webSidebarMovePreview, { x: Number(viewX) || 0 })
  },

  /** 松手落定换边；`cancel = true` 表示拖动被中断（Esc / 指针丢失），只撤预览、不换边。 */
  endMove(cancel: boolean) {
    getHiraBridge().provider.send(IPC_ROUTES.webSidebarMove, { cancel: !!cancel })
  },

  /**
   * 侧栏顶条的命令（单向发送，不等回执）：
   * `back` / `forward` / `reload` / `open-in-tab` / `close`。
   * 执行权只在主进程（顶条不认识标签世界，也不认识侧栏自己的状态）。
   */
  command(command: string) {
    getHiraBridge().provider.send(IPC_ROUTES.webSidebarCommand, { command: String(command || '') })
  },

  /**
   * 侧栏状态（main → 顶条 / 外壳）：
   * `{ open, url, title, favicon, loading, canGoBack, canGoForward }`。
   */
  onState(handler: (payload: WebSidebarState) => void): () => void {
    return getHiraBridge().on.subscribe<WebSidebarState>(IPC_EVENTS.webSidebarState, handler)
  }
}

