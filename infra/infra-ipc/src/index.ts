import { z } from 'zod'
import { ipcSchemas } from './contracts'
import { createListenerRegistry } from './ListenerRegistry'

export interface SchemaPort<Output = unknown> {
  parse(value: unknown): Output
}

export interface IpcMainPort {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void
}

export interface IpcRendererPort {
  invoke(channel: string, payload?: unknown): Promise<unknown>
}

export interface IpcHandlerDefinition<Request = unknown, Response = unknown> {
  requestSchema?: SchemaPort<Request>
  responseSchema?: SchemaPort<Response>
  handler(event: unknown, request: Request): Response | Promise<Response>
}

export interface IpcInvokeDefinition<Request = unknown, Response = unknown> {
  requestSchema?: SchemaPort<Request>
  responseSchema?: SchemaPort<Response>
}

export interface TypedIpcMain {
  scope: string
  handle<Request = unknown, Response = unknown>(route: string, definition: IpcHandlerDefinition<Request, Response>): string
}

export interface TypedIpcMainOptions {
  scope?: string
  /**
   * Sender trust boundary for every invoke route registered through this port.
   *
   * It runs before request parsing so untrusted renderers cannot spend main-process
   * time on large payloads or reach route-specific business logic through a schema
   * validation error oracle.
   */
  authorize?: (event: unknown, route: string) => boolean | Promise<boolean>
}

export interface TypedIpcRenderer {
  scope: string
  invoke<Request = unknown, Response = unknown>(route: string, definition: IpcInvokeDefinition<Request, Response>, payload: unknown): Promise<Response>
}

export interface EventSubscriberPort {
  id?: number
  send(channel: string, payload: unknown): void
}

export interface EventCatalogPort {
  has?(route: string): boolean
  isWindowScoped?(route: string): boolean
}

export interface EventListenerRegistryPort {
  subscribersOf(route: string, options?: { scope?: unknown }): readonly EventSubscriberPort[]
}

export interface BroadcasterOptions {
  scope?: string
  kind?: string
  catalog?: EventCatalogPort | null
  warn?: ((message: string) => void) | null
}

export interface BroadcastOptions {
  skipWebContentsId?: number
  windowId?: number | null
}

export function makeChannel(scope: string, kind: string, route?: string): string {
  const base = scope + ':' + kind
  if (!route) return base
  return base + ':' + route
}

export function createTypedIpcMain(ipcMain: IpcMainPort, { scope = 'ngipc', authorize }: TypedIpcMainOptions = {}): TypedIpcMain {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('ipcMain.handle is required')

  return {
    scope,
    handle<Request = unknown, Response = unknown>(route: string, { requestSchema, responseSchema, handler }: IpcHandlerDefinition<Request, Response>) {
      if (!route) throw new Error('route is required')
      if (typeof handler !== 'function') throw new Error('handler is required')

      const channel = makeChannel(scope, 'invoke', route)
      ipcMain.handle(channel, async (event, payload) => {
        if (authorize && await authorize(event, route) !== true) {
          throw new Error(`IPC sender is not trusted for route: ${route}`)
        }
        const req = (requestSchema ? requestSchema.parse(payload) : payload) as Request
        const res = await handler(event, req)
        return responseSchema ? responseSchema.parse(res as unknown) : res
      })
      return channel
    }
  }
}

export function createTypedIpcRenderer(ipcRenderer: IpcRendererPort, { scope = 'ngipc' }: { scope?: string } = {}): TypedIpcRenderer {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') throw new Error('ipcRenderer.invoke is required')

  return {
    scope,
    async invoke<Request = unknown, Response = unknown>(route: string, { requestSchema, responseSchema }: IpcInvokeDefinition<Request, Response>, payload: unknown) {
      if (!route) throw new Error('route is required')
      const req = requestSchema ? requestSchema.parse(payload) : payload
      const channel = makeChannel(scope, 'invoke', route)
      const res = await ipcRenderer.invoke(channel, req)
      return (responseSchema ? responseSchema.parse(res) : res) as Response
    }
  }
}

/**
 * 事件广播器 —— 事件从主进程发往渲染层的**唯一出口**。
 *
 * 只发给「登记过该 route 的 webContents」（见 ListenerRegistry）。为什么不再无条件
 * 全量广播：主窗口事件对 rail / 面板 / 浮层毫无意义，而 tab:loading / tab:changed
 * 在页面加载期密集触发，逐条复制给 N 个 chrome 层就是实打实的 IPC 风暴。
 *
 * 再按**窗口**收一次口：`opts.windowId` 把事件限定为「只发给属于该窗口的订阅者」。
 * 描述某个窗口状态的事件（tab:changed / tab:loading / space:window-changed…）必须带它 ——
 * 否则窗口 A 的标签变化会被投给窗口 B 的 ui-shell，而 ui-shell 直接渲染推送载荷，
 * 于是两个窗口的标签条互相覆盖（多窗口「标签串台」）。应用级事件（settings / 书签 /
 * 历史 / 下载 / 扩展）不带 windowId，保持全量广播。
 *
 * @param {{ subscribersOf: (route: string, opts?: {scope?: unknown}) => object[] }} registry
 * @param {{
 *   scope?: string,
 *   kind?: string,
 *   catalog?: { has: (route: string) => boolean, isWindowScoped: (route: string) => boolean },
 *   warn?: (message: string) => void
 * }} [options]
 *   catalog：事件名册的**校验端口**（由 APPS 注入，见 shared-types#event-catalog）。
 *     infra 不认识具体事件表，只问「这条登记过吗 / 它是不是窗口级」——
 *     保持 infra 不反向依赖 shared-types 的具体数据。
 *   warn：只在开发态传（main.js 用 `!app.isPackaged` 判断）；生产态不传即零开销。
 * @returns {{ send: (route: string, payload?: unknown, opts?: { skipWebContentsId?: number, windowId?: number }) => number }}
 */
export function createBroadcaster(registry: EventListenerRegistryPort, { scope = 'ngipc', kind = 'event', catalog = null, warn = null }: BroadcasterOptions = {}) : { send: (route: string, payload?: unknown, opts?: { skipWebContentsId?: number, windowId?: number }) => number } {
  if (!registry || typeof registry.subscribersOf !== 'function') {
    throw new Error('createBroadcaster: listener registry is required')
  }

  // 一次性告警：同一路由反复出错（例如每 16ms 一条 tab:changed）只提示一次，
  // 否则控制台会被同一条消息刷爆，反而看不见真正的问题。
  const warnedRoutes = new Set<string>()

  function audit(route: string, opts: BroadcastOptions): void {
    if (!catalog || typeof warn !== 'function') return
    const missingWindow = () => opts.windowId === undefined || opts.windowId === null
    if (typeof catalog.has === 'function' && !catalog.has(route)) {
      if (warnedRoutes.has(route)) return
      warnedRoutes.add(route)
      warn('[broadcaster] 未登记的事件路由: ' + route + ' —— 请在 shared-types/src/event-catalog.mjs 登记')
      return
    }
    if (typeof catalog.isWindowScoped === 'function' && catalog.isWindowScoped(route) && missingWindow()) {
      if (warnedRoutes.has(route)) return
      warnedRoutes.add(route)
      warn('[broadcaster] 窗口级事件缺少 windowId: ' + route + ' —— 多窗口会串台')
    }
  }

  /**
   * @param {string} route 事件路由（如 'tab:changed'）
   * @param {unknown} [payload]
   * @param {{ skipWebContentsId?: number, windowId?: number }} [opts]
   *   windowId：把投递限定在「属于该窗口的订阅者」（窗口级事件必须传，见函数头说明）；
   *   skipWebContentsId：跳过发起方（避免回声造成无谓重渲染）。
   * @returns {number} 实际送达的接收者数量（诊断用）
   */
  function send(route: string, payload?: unknown, opts: BroadcastOptions = {}): number {
    // 开发态名册校验放在投递之前：没有订阅者时也要能发现「路由拼错 / 窗口级漏 windowId」。
    audit(route, opts)
    // windowId 为 null / undefined = 应用级事件 → 广播给所有订阅者（与改造前一致）
    const scopeOpt = opts && opts.windowId !== undefined && opts.windowId !== null
      ? { scope: opts.windowId }
      : undefined
    const targets = registry.subscribersOf(route, scopeOpt)
    if (targets.length === 0) return 0
    const channel = makeChannel(scope, kind, route)
    const skip = opts && typeof opts.skipWebContentsId === 'number' ? opts.skipWebContentsId : 0
    let delivered = 0
    for (const wc of targets) {
      try {
        if (skip && wc.id === skip) continue
        wc.send(channel, payload)
        delivered++
      } catch (_) {
        // 单个目标失效（正在关闭）不影响其余
      }
    }
    return delivered
  }

  return { send }
}

export {
  z,
  ipcSchemas,
  createListenerRegistry
}
