/**
 * permission-state.js —— Web Prompts 权限请求状态机
 *
 * 主进程 setPermissionRequestHandler 收到请求 → 'permission:request' 推送；
 * 处理完成 → 'permission:cleared' 通知。本模块是 renderer 侧唯一请求列表持有者：
 *   · 去重合流（事件推送 + 启动时拉取 pending 列表）
 *   · 列表变化 → onChange 回调（navbar 刷新 Bell badge）
 *
 * 彻底解耦：provider / 事件订阅 / 变更回调全部注入，不读 window 全局（C05）。
 */

/**
 * @typedef {object} PermissionStateDeps
 * @property {object} provider                                  window.hira.provider
 * @property {(event:string, cb:(payload:unknown)=>void) => void} onSubscribe
 * @property {() => void} onChange                                列表变化回调（badge 刷新）
 */
import type { RendererProvider } from '../shared/bridge.js'

export interface PermissionStateDeps {
  provider: RendererProvider
  onSubscribe(event: string, callback: (payload: Record<string, unknown>) => void): () => void
  onChange(): void
}

/**
 * @param {PermissionStateDeps} deps
 */
export function createPermissionState(deps: PermissionStateDeps) {
  const { provider, onSubscribe, onChange } = deps

  let disposed = false

  /** @type {Array<{id:string, origin:string, type:string, sensitive?:boolean, tabId?:string|null}>} */
  let requests: Array<{id:string, origin:string, type:string, sensitive?:boolean, tabId?:string|null}> = []

  function normalizeRequest(request: Record<string, unknown>): {
    id: string
    origin: string
    type: string
    sensitive: boolean
    tabId: string | null
  } {
    return {
      id: typeof request.id === 'string' ? request.id : '',
      origin: typeof request.origin === 'string' ? request.origin : '',
      type: typeof request.type === 'string' ? request.type : '',
      sensitive: request.sensitive === true,
      // 归属标签：只有主进程能解析（webContents → tab），renderer 只消费。
      // null = 无法归属（扩展页/子窗口等），此类请求不在任何标签上打标记。
      tabId: typeof request.tabId === 'string' && request.tabId ? request.tabId : null
    }
  }

  function notify() {
    onChange()
  }

  const unsubscribeRequest = onSubscribe('permission:request', (payload) => {
    if (disposed) return
    if (!payload || !payload.id) return
    // 去重：同一 id 不重复加入
    const exists = requests.some((r) => r.id === payload.id)
    if (!exists) {
      requests = [...requests, normalizeRequest(payload)]
      notify()
    }
  })

  const unsubscribeCleared = onSubscribe('permission:cleared', (payload) => {
    if (disposed) return
    if (!payload || !payload.id) return
    const next = requests.filter((r) => r.id !== payload.id)
    if (next.length !== requests.length) {
      requests = next
      notify()
    }
  })

  /**
   * 与主进程的 pending 列表**全量对齐**。
   *
   * 唯一真值在主进程 —— 本地只是它的投影。三个入口都用这一份：
   *   · 启动时补拉（主进程早已存在、renderer 未收到的请求）；
   *   · 响应返回 `{ ok:false }`（这条已被别处响应 / 页面已导航销毁）；
   *   · 事件丢失后的兜底（`permission:cleared` 没到，本地会留下死请求）。
   * 全量替换（而不是只合流新增）才能把本地多余的死请求清掉 ——
   * 只加不减正是「点了允许、浮层还挂着那条请求」的形态。
   */
  async function refresh() {
    try {
      const list = await provider.invoke('permission:pending-list')
      if (disposed || !Array.isArray(list)) return
      /** @type {Array<{id:string, origin:string, type:string, sensitive?:boolean, tabId?:string|null}>} */
      const next: Array<{id:string, origin:string, type:string, sensitive?:boolean, tabId?:string|null}> = []
      const seen = new Set()
      for (const r of list) {
        if (!r || !r.id || seen.has(r.id)) continue
        seen.add(r.id)
        next.push(normalizeRequest(r))
      }
      const changed = next.length !== requests.length ||
        next.some((r, i) => !requests[i] || requests[i].id !== r.id)
      if (!changed) return
      requests = next
      notify()
    } catch {}
  }

  // 启动时补拉一次（主进程可能已有请求，而本 renderer 尚未收到推送）
  refresh()

  return {
    getRequests: () => requests,
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeRequest()
      unsubscribeCleared()
      requests = []
    }
  }
}

