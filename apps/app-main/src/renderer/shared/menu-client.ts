/**
 * 原生上下文菜单渲染侧客户端（薄壳）
 *
 * ── 为什么需要它（去阻塞核心）───────────────────────────────
 * 旧链路：`await provider.invoke('ui:popup-menu', …)` —— 主进程把 IPC Promise 的
 * resolve 挂在菜单项的 click / popup callback 上，于是**菜单存续期间渲染层一直
 * 被阻塞**（右键链接/图片时尤其明显）。
 *
 * 新链路：主进程弹出菜单后 **invoke 立即返回**；用户点击的 action（或菜单关闭时的
 * null）经 `ui:popup-menu-selected` 单向事件回传，本客户端按 requestId 对账，
 * 对调用方仍暴露语义等价的 `Promise<action|null>` —— 调用方零改动即可受益。
 *
 * 只做「弹菜单 + 等一次结果」的编排，不含任何业务状态。
 */
import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

let seq = 0

interface MenuProviderPort {
  invoke(route: string, payload?: unknown): Promise<Record<string, unknown>>
}

interface MenuClientDeps {
  provider: MenuProviderPort
  onSubscribe(route: string, listener: (payload: Record<string, unknown>) => void): () => void
}

interface MenuPopupArgument {
  items?: unknown[]
  x?: number
  y?: number
  context?: unknown
}

export interface MenuClient {
  popupMenu(argument?: MenuPopupArgument): Promise<string | null>
  lastAnchor(): { left: number; top: number; right: number; bottom: number } | null
}

/**
 * 用注入的 provider / onSubscribe 装配一个菜单客户端（保持依赖注入、可测试）。
 * @param {{ provider: { invoke: Function }, onSubscribe: (route: string, cb: Function) => (() => void) }} deps
 */
export function createMenuClient({ provider, onSubscribe }: MenuClientDeps): MenuClient {
  if (!provider || typeof provider.invoke !== 'function') {
    throw new Error('menu-client: provider.invoke is required')
  }
  if (typeof onSubscribe !== 'function') {
    throw new Error('menu-client: onSubscribe is required')
  }

  /** 最近一次弹菜单的位置（窗口坐标）—— 供「菜单选完后紧接着弹浮层」的场景取锚点。 */
  let lastPos: { x: number; y: number } | null = null
  let activeMenu: ((action: string | null) => void) | null = null
  try {
    window.addEventListener('pagehide', () => activeMenu?.(null), { once: true })
  } catch (_) {}

  /**
   * 弹出原生菜单，返回被选中的 action（未选中 / 菜单关闭返回 null）。
   *
   * `context` 用来请主进程把**官方插槽贡献的菜单项**追加进来（如书签菜单）。
   * 只传种类与快照；插槽里的实现在主进程执行、点击也在主进程派发，
   * 因此这些项**不会**作为 action 回传 —— 本函数的返回值只覆盖渲染层自己那部分 items。
   *
   * @param {{ items: unknown[], x?: number, y?: number,
   *           context?: { kind: string, snapshot?: object } }} arg
   * @returns {Promise<string|null>}
   */
  function popupMenu({ items = [], x, y, context }: MenuPopupArgument = {}): Promise<string | null> {
    // 坐标必须是 Int32：主进程 `menu.popup({ x, y })` 走 gin 的 int 转换，
    // 收到 72.5 这类浮点会直接抛错 → 整条 IPC 被拒 → 「右键毫无反应」。
    // 渲染层的 rect / clientX 都可能带小数（分数缩放、非整数布局），故在**唯一入口**取整。
    const px = Number.isFinite(Number(x)) ? Math.round(Number(x)) : undefined
    const py = Number.isFinite(Number(y)) ? Math.round(Number(y)) : undefined
    if (px !== undefined && py !== undefined) lastPos = { x: px, y: py }
    const requestId = `menu_${Date.now().toString(36)}_${(seq++).toString(36)}`
    return new Promise((resolve) => {
      let done = false
      const finish = (action: string | null): void => {
        if (done) return
        done = true
        if (activeMenu === finish) activeMenu = null
        unsubscribe()
        resolve(action)
      }
      // Chromium keeps one native popup per renderer window. If another surface
      // opens a menu, settle the previous waiter immediately instead of leaving
      // a promise/listener alive until an event that will never arrive.
      activeMenu?.(null)
      activeMenu = finish
      const unsubscribe = onSubscribe(IPC_EVENTS.uiPopupMenuSelected, (payload) => {
        if (!payload || payload.requestId !== requestId) return
        finish(typeof payload.action === 'string' ? payload.action : null)
      })
      // invoke 立即返回（菜单已弹出）；真正的结果随后经事件到达。
      // 失败要**打得出来**：契约校验不通过 / 原生菜单构建失败都从这里经过，
      // 静默 finish(null) 会把「菜单没弹出来」伪装成「用户点了空白处」。
      try {
        provider.invoke(IPC_ROUTES.uiPopupMenu, { items, x: px, y: py, requestId, context })
          .then((res) => {
            // 主进程构建失败会显式回 `{ ok: false }`（例如模板为空 / 原生构建抛错）——
            // 这种"弹了但没弹出来"的情况同样必须留痕，不能和「用户点了空白处」混在一起。
            if (res && res.ok === false) {
              console.error('[menu-client] popup-menu rejected by main process')
              finish(null)
            }
          })
          .catch((error) => {
            console.error('[menu-client] popup-menu failed:', error)
            finish(null)
          })
      } catch (error) {
        console.error('[menu-client] popup-menu failed:', error)
        finish(null)
      }
    })
  }

  /**
   * 最近一次弹菜单处的**锚点矩形**（1px 点扩展成矩形，与浮层的 anchor 契约同形）。
   *
   * 用途：右键菜单里选了「收进集锦…」后紧接着要弹选择器浮层 —— 原生菜单不会告诉
   * 我们它长在哪，而用户的手指/光标就在刚才右键的位置，那里就是最自然的锚点。
   * 没弹过菜单（键盘触发）时返回 null，由调用方决定兜底落位。
   * @returns {{left:number, top:number, right:number, bottom:number}|null}
   */
  function lastAnchor(): { left: number; top: number; right: number; bottom: number } | null {
    if (!lastPos) return null
    return { left: lastPos.x, top: lastPos.y, right: lastPos.x + 1, bottom: lastPos.y + 1 }
  }

  return { popupMenu, lastAnchor }
}

// 单例：绝大多数 renderer 直接用 window.hira 桥，无需自行装配。
let singleton: MenuClient | null = null
function getSingleton() {
  if (!singleton) {
    const bridge = getHiraBridge()
    singleton = createMenuClient({
      provider: bridge.provider,
      onSubscribe: (route, cb) => bridge.on.subscribe(route, cb)
    })
  }
  return singleton
}

export const menuClient = {
  popupMenu(arg?: MenuPopupArgument) {
    return getSingleton().popupMenu(arg)
  },
  lastAnchor() {
    return getSingleton().lastAnchor()
  }
}


