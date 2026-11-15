/**
 * ListenerRegistry —— 主进程侧的事件订阅登记表（对齐 RT `ipc/listeners-manager.ts`）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────
 * 事件广播的旧实现是「无条件遍历一批 webContents 逐个 send」：
 *   · 主窗口事件只对 ui-shell 有用，却会被发给 rail / 每个面板 / 每个浮层；
 *   · 页面加载期间 tab:loading / tab:changed 密集触发时，这份放大是实打实的 IPC 风暴。
 * RT 的做法是让渲染层先登记再收：`listeners:add` → 主进程记账 → 只发给订阅者。
 *
 * ── 语义边界（很重要）─────────────────────────────────────────────
 * 本模块**不认识路由名**，只记 `route ↔ webContents` 的对应关系；
 * 「谁该收到」由渲染层的 subscribe 决定。因此它同时解决了一类隐蔽 bug：
 * 过去「只广播给 chrome 层」的过滤会把内部页（hira:// 页运行在**标签页**里）
 * 排除在外 —— 例如书签页订阅了 bookmark:changed 却永远收不到。
 * 改成登记制后，**只要订阅了就收得到，与它住在哪个图层无关**。
 *
 * 本模块不 import electron：只按鸭子类型使用 webContents 的
 * `id / isDestroyed() / once('destroyed')`，因此可单测、可替换实现。
 *
 * ── 窗口作用域（多窗口隔离的关键一道）──────────────────────────────
 * 登记表是**进程级**的（一个 route 一张表），而 `tab:changed` / `tab:loading`
 * 这类事件描述的是**某一个窗口**的状态。若只按 route 投递，窗口 A 的标签变化会
 * 被送到窗口 B 的 ui-shell —— 而 ui-shell 是**直接拿推送载荷渲染**的
 * （见 renderer/tabs-client → tab-session-controller）：B 的标签条立刻显示 A 的标签、
 * B 的地址栏指向 A 的页面。多窗口的「标签串台」正是从这里冒出来的。
 *
 * 因此本模块接受一个宿主注入的 `scopeOf(wc) → 作用域键`（APPS 层传窗口 id），
 * 并在 `subscribersOf(route, { scope })` 时按作用域过滤。本模块仍然不认识
 * electron / 窗口 —— 「谁属于哪个窗口」是宿主的知识。
 * 未注入 `scopeOf` 或调用方不传 `scope` 时行为与改造前逐字节一致（全量投递）。
 */

/**
 * @param {{
 *   scopeOf?: (wc: object) => unknown,
 *   onUnknownRoute?: (route: string) => void
 * }} [options]
 *   onUnknownRoute：宿主注入的「这条路由不在名册里」回调（仅开发态传）。
 *     本模块仍不认识路由名，只是把字符串转交给宿主的校验端口。
 */
export interface WebContentsPort {
  id?: number
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
  once?(event: 'destroyed', listener: () => void): unknown
}

export interface ListenerRegistryOptions {
  scopeOf?(webContents: WebContentsPort): unknown
  onUnknownRoute?(route: string): void
}

export interface ListenerRegistry {
  add(webContents: WebContentsPort, route: string, listenerId: string): boolean
  remove(webContents: WebContentsPort, listenerId: string): boolean
  dropWebContents(webContents: WebContentsPort): number
  subscribersOf(route: string, options?: { scope?: unknown }): WebContentsPort[]
  clear(): void
  readonly routeCount: number
  readonly listenerCount: number
}

export function createListenerRegistry(options: ListenerRegistryOptions = {}): ListenerRegistry {
  const MAX_LISTENERS_PER_CONTENTS = 512
  const MAX_ROUTE_LENGTH = 256
  const MAX_LISTENER_ID_LENGTH = 256
  /** route → Map<listenerId, WebContents> */
  const byRoute = new Map<string, Map<string, WebContentsPort>>()
  /** listenerId → route（remove 时无需调用方再传 route） */
  const routeOf = new Map<string, string>()
  /** 已挂过 destroyed 监听的 webContents（防重复挂） */
  const watched = new WeakSet<WebContentsPort>()
  /** webContents → 当前登记数（防止受信页面因脚本错误无限重复订阅）。 */
  const listenerCounts = new WeakMap<WebContentsPort, number>()
  /** 宿主注入的作用域解析：webContents → 所属窗口（缺省 = 不做作用域过滤） */
  const scopeOf = typeof options.scopeOf === 'function' ? options.scopeOf : null
  /** 宿主注入的路由校验（缺省 = 不校验） */
  const onUnknownRoute = typeof options.onUnknownRoute === 'function' ? options.onUnknownRoute : null

  /**
   * 该 webContents 的作用域键。
   * 不缓存：标签 / 面板的 webContents 可以在窗口之间迁移，永久缓存会让迁移后的
   * 订阅继续按旧窗口过滤，表现为事件丢失或串窗。归属查询有原生快路径，
   * 正确性优先于一次 WeakMap 命中。
   */
  function scopeFor(wc: WebContentsPort): unknown {
    if (!scopeOf) return undefined
    try {
      return scopeOf(wc)
    } catch (_) {
      return undefined
    }
  }

  function isAlive(wc: WebContentsPort | null | undefined): boolean {
    if (!wc) return false
    try {
      return typeof wc.isDestroyed !== 'function' || !wc.isDestroyed()
    } catch (_) {
      return false
    }
  }

  /** webContents 销毁 → 立即摘掉它的全部登记，绝不留下悬空引用。 */
  function dropWebContents(wc: WebContentsPort): number {
    let dropped = 0
    for (const [route, bucket] of byRoute) {
      for (const [id, owner] of bucket) {
        if (owner !== wc) continue
        bucket.delete(id)
        routeOf.delete(id)
        const count = listenerCounts.get(wc)
        if (count !== undefined) listenerCounts.set(wc, Math.max(0, count - 1))
        dropped++
      }
      if (bucket.size === 0) byRoute.delete(route)
    }
    return dropped
  }

  /**
   * 登记一个订阅。
   * @param {object} wc 订阅方 webContents
   * @param {string} route 事件路由（如 'tab:changed'）
   * @param {string} listenerId 订阅方自己生成的唯一 id（退订凭据）
   * @returns {boolean}
   */
  function add(wc: WebContentsPort, route: string, listenerId: string): boolean {
    if (!wc || !route || !listenerId) return false
    if (route.length > MAX_ROUTE_LENGTH || listenerId.length > MAX_LISTENER_ID_LENGTH) return false
    const id = String(listenerId)
    const existingRoute = routeOf.get(id)
    if (existingRoute) {
      const existingBucket = byRoute.get(existingRoute)
      const existingOwner = existingBucket ? existingBucket.get(id) : null
      // listenerId 是跨进程退订凭据。不同 sender / 不同 route 绝不能复用，
      // 否则新登记会覆盖旧归属，旧监听再也无法退订并一直持有 webContents。
      if (existingOwner && (existingOwner !== wc || existingRoute !== route)) return false
    }
    if (onUnknownRoute) {
      try {
        onUnknownRoute(route)
      } catch (_) {}
    }
    let bucket = byRoute.get(route)
    if (!bucket) {
      bucket = new Map()
      byRoute.set(route, bucket)
    }
    const existed = bucket.has(id)
    if (!existed && (listenerCounts.get(wc) || 0) >= MAX_LISTENERS_PER_CONTENTS) return false
    bucket.set(id, wc)
    routeOf.set(id, route)
    listenerCounts.set(wc, (listenerCounts.get(wc) || 0) + (existed ? 0 : 1))
    if (!watched.has(wc) && typeof wc.once === 'function') {
      watched.add(wc)
      try {
        wc.once('destroyed', () => dropWebContents(wc))
      } catch (_) {}
    }
    return true
  }

  /**
   * 退订。只允许退掉**自己**登记的那条 —— 否则一个渲染进程可以用别人的 id
   * 把另一个窗口的订阅摘掉（跨窗口互相干扰）。
   * @param {object} wc
   * @param {string} listenerId
   * @returns {boolean} 是否真的移除了一条
   */
  function remove(wc: WebContentsPort, listenerId: string): boolean {
    const id = String(listenerId || '')
    const route = routeOf.get(id)
    if (!route) return false
    const bucket = byRoute.get(route)
    if (!bucket) {
      routeOf.delete(id)
      return false
    }
    const owner = bucket.get(id)
    if (!owner) {
      routeOf.delete(id)
      return false
    }
    if (wc && owner !== wc) return false
    bucket.delete(id)
    const count = listenerCounts.get(wc)
    if (count !== undefined) listenerCounts.set(wc, Math.max(0, count - 1))
    if (bucket.size === 0) byRoute.delete(route)
    routeOf.delete(id)
    return true
  }

  /**
   * 某路由的存活订阅者（已销毁的顺手剔除）。
   * 每次现算而不是缓存：订阅关系变化远少于事件触发次数，缓存反而增加失效风险。
   *
   * @param {string} route
   * @param {{ scope?: unknown }} [opts] 传 scope 时只返回属于该作用域（窗口）的订阅者
   *   —— 「窗口级事件不跨窗口」的唯一执行点。
   * @returns {object[]}
   */
  function subscribersOf(route: string, opts: { scope?: unknown } = {}): WebContentsPort[] {
    const bucket = byRoute.get(route)
    if (!bucket || bucket.size === 0) return []
    const wantScope = opts && opts.scope !== undefined ? opts.scope : undefined
    const out: WebContentsPort[] = []
    for (const [id, wc] of bucket) {
      if (!isAlive(wc)) {
        bucket.delete(id)
        routeOf.delete(id)
        continue
      }
      if (wantScope !== undefined && scopeFor(wc) !== wantScope) continue
      out.push(wc)
    }
    if (bucket.size === 0) byRoute.delete(route)
    return out
  }

  function clear(): void {
    byRoute.clear()
    routeOf.clear()
  }

  return {
    add,
    remove,
    dropWebContents,
    subscribersOf,
    clear,
    /** 当前有订阅者的路由数（诊断用） */
    get routeCount() {
      return byRoute.size
    },
    /** 当前登记总数（诊断用） */
    get listenerCount() {
      let n = 0
      for (const bucket of byRoute.values()) n += bucket.size
      return n
    }
  }
}

