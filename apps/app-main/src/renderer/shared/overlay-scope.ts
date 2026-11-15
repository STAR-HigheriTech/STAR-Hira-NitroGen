/**
 * 浮层作用域（overlay scope）—— 同一个浮层页在「主窗口」和「PWA 应用窗」两种宿主下
 * 走**不同 IPC 路由**的唯一收敛点。
 *
 * ── 为什么必须分路 ────────────────────────────────────────────────────
 * 主窗口的浮层通道（`find:query` / `zoom:step` / `<name>:display` …）全部绑在
 * `main/ipc/layout.js` 的 layoutCoordinator **单例**上，并且靠 runtimeRegistry 的 ALS
 * 反查窗口。PWA 应用窗不在 runtimeRegistry 里，`matchBySender → null` 会兜底到
 * primaryRuntime —— 结果是「应用窗按 Ctrl+F，查找栏开到了主窗口」。
 *
 * 所以 PWA 宿主给浮层页带上 `?scope=pwa&appId=…`，本模块把同样的意图翻译成
 * `pwa:find-*` / `pwa:zoom-*` / `pwa-overlay:*` 专用路由（主进程按 `event.sender`
 * 反查所属应用窗）。浮层组件与两个宿主页都**不需要知道**这件事。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 * 本模块只做「路由选择 + payload 补 appId/name」。不做校验、不做几何、不碰 DOM ——
 * 那些分别属于主进程 handler 与浮层宿主页。
 */

import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'

/**
 * @param {string} name 浮层名（= 渲染目录名，如 'findbar-overlay'）
 * @param {{ send: Function, invoke: Function }} provider 渲染层 IPC 端口
 */
interface OverlayScopeProvider {
  send(route: string, payload?: unknown): void
  invoke<T = unknown>(route: string, payload?: unknown): Promise<T>
}

export function resolveOverlayScope(name: string, provider: OverlayScopeProvider) {
  let params: URLSearchParams | null = null
  try {
    params = new URLSearchParams(window.location.search)
  } catch (_) {
    params = null
  }
  const pwa = params?.get('scope') === 'pwa'
  const appId = pwa && params ? String(params.get('appId') || '') : ''

  /** 主窗口路由 = `<name>:display` 这类按名注册的全局通道；PWA 走专用路由。 */
  const send = (route: string, payload?: Record<string, unknown>): void => {
    if (!route) return
    try {
      if (pwa) provider.send(route, { appId, ...(payload || {}) })
      else provider.send(route, payload || {})
    } catch (_) {}
  }

  return {
    pwa,
    appId,
    name,

    // ── 查找 ────────────────────────────────────────────────────────
    findQuery(payload?: Record<string, unknown>) {
      send(pwa ? IPC_ROUTES.pwaFindQuery : IPC_ROUTES.findQuery, payload)
    },
    findStop(payload?: Record<string, unknown>) {
      send(pwa ? IPC_ROUTES.pwaFindStop : IPC_ROUTES.findStop, payload)
    },
    findClose() {
      send(pwa ? IPC_ROUTES.pwaFindClose : IPC_ROUTES.findClose, {})
    },

    // ── 缩放 ────────────────────────────────────────────────────────
    zoomStep(payload?: Record<string, unknown>) {
      send(pwa ? IPC_ROUTES.pwaZoomStep : IPC_ROUTES.zoomStep, payload)
    },
    zoomReset() {
      send(pwa ? IPC_ROUTES.pwaZoomReset : IPC_ROUTES.zoomReset, {})
    },

    // ── 几何 / 显隐 ─────────────────────────────────────────────────
    display(display?: Record<string, unknown>) {
      send(
        pwa ? IPC_ROUTES.pwaOverlayDisplay : `${name}:display`,
        pwa ? { ...(display || {}), name } : display
      )
    },
    hide() {
      send(pwa ? IPC_ROUTES.pwaOverlayHide : `${name}:hide`, pwa ? { name } : {})
    },

    // ── 就绪 ────────────────────────────────────────────────────────
    // 主窗口是 invoke（layout.js 按名注册 `<name>:ready`）；PWA 是单向 send（浮层宿主
    // 只需要"可以下发事件了"，没有返回值可言）。
    async ready(): Promise<void> {
      if (pwa) {
        send(IPC_ROUTES.pwaOverlayReady, { name })
        return
      }
      try {
        await provider.invoke(`${name}:ready`, {})
      } catch (_) {}
    }
  }
}

