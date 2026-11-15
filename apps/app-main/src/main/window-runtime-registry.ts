/**
 * 窗口运行单元注册表 —— 「这次 IPC 属于哪个窗口」的**唯一解析点**（多窗口第三步）。
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────
 * `registerCoreIpc` 把**那一个** tabManager / layoutCoordinator / webContentsManager
 * 直接注给约 40 个 registrar。多窗口下这必然出错：窗口 B 点关闭，会关掉窗口 A 的标签。
 * 而逐个改 40 个 registrar 既庞大又容易漏。
 *
 * ── 做法：把「哪个窗口」变成可沿异步链传播的上下文 ────────────────────
 * 1. `runWithSender(sender, fn)`：在 `ipcMain.handle` 的回调外层包一层，
 *    把 sender 放进 AsyncLocalStorage —— 它能跨 await 正确传播，因此 handler 内部
 *    任意深度的调用都能拿到「我是被哪个窗口触发的」。
 * 2. `scoped(name)`：把 runtime 上的一个成员（如 `tabManager`）变成代理，
 *    每次访问都按**当前上下文**解析到对应窗口的那一份。
 *    没有上下文时（定时器、事件、启动期）回退到 primary —— 与单窗口时的行为**完全一致**。
 *
 * ── 为什么用 AsyncLocalStorage 而不是显式传参 ─────────────────────
 * 显式传参要改 40 个 registrar 的每一个 handler（数百处）。而「这次请求属于哪个窗口」
 * 本质上就是环境信息，正是 ALS 的用途。这里把它限制在**主进程 IPC 边界**内使用：
 * 只有 `ipcMain.handle` 的回调会进入上下文，其它代码路径一律 primary。
 *
 * ── 边界（必须知道）───────────────────────────────────────────────
 * · 只覆盖走 typedMain.handle 的 invoke 通道。用 `ipcMain.on` 注册的裸通道
 *   （listeners 登记等）不进入上下文 → 解析为 primary。
 * · 子窗口（hira:// 内部页等 28 类）的 webContents 不属于任何浏览器窗口运行单元
 *   → 解析为 primary；要从「某个窗口的标签」取上下文的功能（页面信息等）
 *   需要第 4 步按「发起窗口」传递目标标签。
 */

const { AsyncLocalStorage } = require('node:async_hooks') as typeof import('node:async_hooks')
import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'

interface WindowRuntime {
  win?: BrowserWindow
  incognito?: boolean
  webContentsManager?: {
    findViewByWebContents?: (webContents: WebContents) => unknown
  }
  spaceRuntime?: {
    getCurrent?: () => { profileId?: string; spaceId?: string } | null
  } | null
}

interface ContextStore {
  sender?: unknown
  profileId?: string | null
  spaceId?: string | null
}

/**
 * 宿主注入的「窗口归属兜底解析器」。
 *
 * 为什么需要注入而不是在本函数里直接找注册表：
 * `ownerWindowOf` 的调用方不止注册表自己 —— preboot 的订阅登记表 scopeOf、
 * 权限事件归属解析都走它。而 Electron 对 **WebContentsView**（标签页 / 浮层 /
 * 面板 / 侧栏）的 `BrowserWindow.fromWebContents` 并不保证可用，
 * `getOwnerBrowserWindow` 也不在 43.x 的类型声明里。注册表知道每个窗口的
 * WebContentsManager，能可靠地把 wc 反查回所属窗口 —— 由它在创建时注入，
 * 所有调用方因此共享同一份兜底，而不是各处各写一套（那正是串台的温床）。
 *
 */
let ownerFallbackResolver: ((webContents: unknown) => WindowRuntime | null) | null = null

function setOwnerFallbackResolver(
  resolver: ((webContents: unknown) => WindowRuntime | null) | null
): void {
  ownerFallbackResolver = typeof resolver === 'function' ? resolver : null
}

/**
 * 取 webContents 所属的浏览器窗口。
 * 顺序：`BrowserWindow.fromWebContents` → `getOwnerBrowserWindow`
 * → 宿主兜底解析器（注册表按 WebContentsManager 反查，见上）。
 */
function ownerWindowOf(webContents: unknown): BrowserWindow | null {
  if (!webContents) return null
  try {
    const { BrowserWindow } = require('electron')
    const byFrom = BrowserWindow.fromWebContents(webContents)
    if (byFrom) return byFrom
  } catch (_) {}
  try {
    const candidate = webContents as { getOwnerBrowserWindow?: () => BrowserWindow | null }
    if (typeof candidate.getOwnerBrowserWindow === 'function') {
      const owner = candidate.getOwnerBrowserWindow()
      if (owner) return owner
    }
  } catch (_) {}
  if (ownerFallbackResolver) {
    try {
      const runtime = ownerFallbackResolver(webContents)
      const win = runtime && runtime.win
      if (win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed())) return win
    } catch (_) {}
  }
  return null
}

function createWindowRuntimeRegistry({
  primary = null
}: { primary?: WindowRuntime | null } = {}) {
  const context = new AsyncLocalStorage<ContextStore>()
  const runtimes = new Set<WindowRuntime>()
  let primaryRuntime: WindowRuntime | null = primary || null

  /**
   * 注册表侧的 wc → runtime 反查：只问各窗口的 WebContentsManager，
   * **绝不回调 `ownerWindowOf`**（那会经兜底解析器绕回自己，形成递归）。
   * `findViewByWebContents` 覆盖 shell / 标签 / 浮层 / 面板 / 密码浮层全部视图。
   */
  function runtimeOfContents(wc: unknown): WindowRuntime | null {
    if (!wc) return null
    for (const runtime of runtimes) {
      try {
        const manager = runtime && runtime.webContentsManager
        if (manager && typeof manager.findViewByWebContents === 'function' &&
            manager.findViewByWebContents(wc as WebContents)) return runtime
      } catch (_) {
        // 单个窗口的运行单元缺字段 / 已销毁：跳过，继续找
      }
    }
    return null
  }

  // 把兜底能力注入 `ownerWindowOf`，让**所有**调用方（IPC 归属解析、
  // preboot 的订阅 scopeOf）共享同一份可靠解析，而不是各自处理 Electron 差异。
  setOwnerFallbackResolver(runtimeOfContents)

  function register<T extends WindowRuntime>(runtime: T): T {
    if (!runtime) return runtime
    runtimes.add(runtime)
    for (const entry of providers) applyProvider(runtime, entry)
    return runtime
  }

  function unregister(runtime: WindowRuntime): void {
    runtimes.delete(runtime)
  }

  function setPrimary(runtime: WindowRuntime | null): void {
    primaryRuntime = runtime || null
    if (runtime) {
      runtimes.add(runtime)
      for (const entry of providers) applyProvider(runtime, entry)
    }
  }

  /**
   * 「按窗口对象的派生属性」注入表。
   *
   * 有些按窗口的对象在**窗口创建时还拿不到实现** —— 例如密码浮层控制器的
   * hideTransient / generatePassword 要等 IPC 注册器装配完成。而往 `scoped(name)`
   * 代理上直接赋值是无效的：代理没有 set 陷阱，赋值只会落到代理自己的空壳上
   * （这正是 hideTransient 曾经静默失效的原因）。
   *
   * 这里给出一条显式注入路径：
   *   · 已注册的窗口立刻写入；
   *   · 之后新开的窗口在 register() 时自动写入（不会漏掉第二个窗口）。
   *
   * @param {string} name 运行单元成员名（如 'passwordOverlayController'）
   * @param {string} prop 属性名
   * @param {(runtime:object) => unknown} factory 由**该窗口自己的**运行单元派生属性值
   * @returns {() => void} 撤销注入（已写入的属性不回滚）
   */
  interface ProviderEntry {
    name: string
    prop: string
    factory: (runtime: WindowRuntime) => unknown
  }

  const providers: ProviderEntry[] = []
  function applyProvider(runtime: WindowRuntime, entry: ProviderEntry): void {
    try {
      const owner = runtime && (runtime as unknown as Record<string, unknown>)[entry.name]
      if (owner && typeof owner === 'object') {
        (owner as Record<string, unknown>)[entry.prop] = entry.factory(runtime)
      }
    } catch (_) { /* 单个窗口失败不影响其它窗口 */ }
  }

  function provide(
    name: string,
    prop: string,
    factory: (runtime: WindowRuntime) => unknown
  ): () => void {
    const entry = { name, prop, factory }
    providers.push(entry)
    for (const runtime of runtimes) applyProvider(runtime, entry)
    return () => {
      const i = providers.indexOf(entry)
      if (i >= 0) providers.splice(i, 1)
    }
  }

  /**
   * 全部已注册的窗口运行单元。
   *
   * 用途：**全局对账**——一件影响所有窗口的事（如面板插件启停导致面板集合变化）
   * 需要逐个窗口施加。逐个改 40 个 registrar 之外，这是唯一能拿到「所有窗口」的口子。
   * 返回快照数组（不是内部 Set）：调用方可能在对账过程中开关窗口，
   * 直接暴露 Set 会让遍历中途被改。
   */
  function list(): WindowRuntime[] {
    return Array.from(runtimes)
  }

  /**
   * 按 sender **精确**解析所属窗口运行单元；解析不到返回 null。
   *
   * 与 `resolve` 的唯一区别：**不回落 primary**。这条区分是多窗口的关键 ——
   * 「解析不到就落到主窗口」在单窗口下与改造前逐字节等价，但在多窗口下就是
   * 串台的温床：窗口 B 发起的一次操作会因为某个环节拿不到 sender 而落到窗口 A 上。
   * 因此凡是「这次调用明确属于某个窗口」的场景（窗口级事件投递、子窗口锚点…）
   * 都应走本方法，并在拿不到时**明确失败/告警**，绝不静默改道主窗口。
   */
  function matchBySender(sender: unknown): WindowRuntime | null {
    if (!sender) return null
    const owner = ownerWindowOf(sender)
    if (!owner) return null
    const windowId = owner.id
    for (const runtime of runtimes) {
      try {
        if (runtime.win && !runtime.win.isDestroyed() && runtime.win.id === windowId) return runtime
      } catch (_) {
        // 单个运行单元的窗口已销毁：跳过，继续找
      }
    }
    return null
  }

  /**
   * 由 sender 解析出它所属窗口的运行单元。
   * 解析不出来时回退 primary —— 这条兜底保证了「单窗口下行为与改造前逐字节一致」。
   * ⚠ 需要「不回落」语义时用 `currentOrNull()` / `matchBySender()`（见其说明）。
   */
  function resolve(sender: unknown): WindowRuntime | null {
    return matchBySender(sender) || primaryRuntime
  }

  /** 在「本次调用来自哪个 sender」的上下文中执行 fn（供 IPC 边界使用）。 */
  function runWithSender<T>(sender: unknown, fn: () => T): T {
    return context.run({ sender }, fn)
  }

  /**
   * 在「当前 profile」的上下文中执行 fn（Steam 式多用户的数据分区键）。
   *
   * 为什么需要：数据域（书签 / 历史 / 下载 / favicon）按 profile 分区读写，
   * 而它们的读写点并不都在 IPC 边界内 —— 标签的 page-title-updated、
   * 会话的 will-download 等是 **webContents / session 事件**，ALS 里没有 sender，
   * 只能回落到主窗口的 profile。这些路径必须由调用方（它自己知道是哪个窗口/profile）
   * 显式进入作用域。与 runWithSender 复用同一个 ALS 槽位：外层 sender 被保留，
   * 内层加一个显式 profileId，后者的优先级更高。
   *
   * @param {string} profileId
   * @param {Function} fn
   */
  function runWithProfile<T>(profileId: string, fn: () => T): T {
    const store = context.getStore() || {}
    return context.run({ ...store, profileId: profileId ? String(profileId) : null }, fn)
  }

  /**
   * 在「指定 profile + space」的上下文中执行 fn。
   *
   * 切换编排需要先投影目标窗口、再让设置域按目标作用域读取值。此时调用栈本身
   * 可能来自另一个窗口，单靠 `runWithProfile` 仍会把空间解析到当前可见窗口。
   * 这个入口把两个身份一次性钉死，异步的 applier 链也不会被后续点击串档。
   */
  function runWithScope<T>(profileId: string, spaceId: string, fn: () => T): T {
    const store = context.getStore() || {}
    return context.run({
      ...store,
      profileId: profileId ? String(profileId) : null,
      spaceId: spaceId ? String(spaceId) : null
    }, fn)
  }

  /**
   * 当前上下文所属的 profile id —— 数据域按 profile 分区的**唯一解析点**。
   *
   * 解析顺序（前者优先）：
   *   1. 显式作用域：`runWithProfile` 设的 profileId（事件型调用方注入）；
   *   2. 当前运行单元的 spaceRuntime：IPC 调用天然带上发起窗口的 profile
   *      （`runWithSender` → sender 所属窗口 → 该窗口的空间运行态）；
   *   3. 'default'：解析不出来时的兜底 —— 单 profile 场景与改造前逐字节一致。
   *
   * ⚠ 绝不返回空：返回空会让下游「拿不到 profile 就不过滤」，那是跨用户串数据。
   * @returns {string}
   */
  function currentProfileId(): string {
    const store = context.getStore()
    if (store && store.profileId) return store.profileId
    const runtime = resolve(store ? store.sender : null)
    try {
      const cur = runtime && runtime.spaceRuntime && typeof runtime.spaceRuntime.getCurrent === 'function'
        ? runtime.spaceRuntime.getCurrent()
        : null
      if (cur && cur.profileId) return String(cur.profileId)
    } catch (_) {}
    return 'default'
  }

  /**
   * 把裸 `ipcMain` 包成「on 通道自动进入发送方上下文」的代理。
   *
   * ── 为什么需要（多窗口下最隐蔽的一条串台路径）──────────────────────
   * `ipcMain.handle`（invoke）由 ipc-routes 统一包了 runWithSender，但
   * `ipcMain.on`（单向 fire-and-forget：浮层 show/hide/display、shell:focus、
   * 拖拽上报…）**从不进入上下文**，于是它们下面用的 `scoped(...)` 代理一律
   * 回退主窗口：窗口 B 打开总览浮层/建议下拉 → 浮层出现在窗口 A 上；窗口 B 聚焦
   * 地址栏 → 焦点被反复交给窗口 A。用户感受就是「B 没有自主权」。
   *
   * 这些回调都是同步的（或 fire-and-forget），同步包一层即可让作用域在整个回调
   * （及其派生的 Promise 链）内正确传播；注册器因此无需各自手写 `e.sender` 解析。
   *
   * @param {object} ipcMain
   * @returns {object} 与入参同形（仅 `on` 被包一层）的 ipcMain
   */
  function scopeRawIpcMain(ipcMain: IpcMain): IpcMain {
    if (!ipcMain || typeof ipcMain.on !== 'function') return ipcMain
    return new Proxy(ipcMain, {
      get(target, prop) {
        if (prop === 'on') {
          return (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => unknown) =>
            target.on(channel, (event, ...args) =>
              context.run({ sender: event && event.sender }, () => handler(event, ...args))
            )
        }
        const value = (target as unknown as Record<PropertyKey, unknown>)[prop]
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }

  /** 当前上下文对应的运行单元（无上下文 → primary）。 */
  function current(): WindowRuntime | null {
    const store = context.getStore()
    return resolve(store ? store.sender : null)
  }

  /**
   * 当前上下文对应的运行单元；**无法确定时返回 null**（不回落 primary）。
   *
   * 什么时候必须用它：
   *   · 要投递/执行一件「明确属于某个窗口」的事（窗口级事件、子窗口锚点），
   *     拿不到归属就该失败并告警，而不是改道主窗口（那正是串台的成因）；
   *   · 需要区分「真的解析到了主窗口」与「解析失败被兜底成主窗口」。
   * 什么时候仍用 `current()`：单窗口语义下「无上下文=主窗口」是**合理**的兜底
   *   （例如进程级定时任务确实需要一个窗口当执行者），且改造前就是这个行为。
   */
  function currentOrNull(): WindowRuntime | null {
    const store = context.getStore()
    if (!store) return null
    return matchBySender(store.sender)
  }

  /**
   * 把运行单元上的一个成员变成「按当前上下文解析」的代理。
   *
   * 方法必须 bind 到真实 target，否则 `this` 会指向代理对象本身 —— 那会让
   * TabManager 这类依赖实例字段的类当场失效。
   */
  function scoped<T extends object = Record<PropertyKey, unknown>>(name: string): T {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          const runtime = current()
          const owner = runtime ? (runtime as unknown as Record<PropertyKey, unknown>)[name] as Record<PropertyKey, unknown> | null : null
          if (!owner) return undefined
          const value = owner[prop]
          return typeof value === 'function' ? value.bind(owner) : value
        },
        has(_target, prop) {
          const runtime = current()
          const owner = runtime ? (runtime as unknown as Record<PropertyKey, unknown>)[name] as Record<PropertyKey, unknown> | null : null
          return Boolean(owner && prop in owner)
        }
      }
    ) as T
  }

  /**
   * 「当前空间」—— 与 `currentProfileId` **同一套解析顺序**
   *（显式作用域 → 发起窗口的空间运行态），但**兜底是空串而不是 'default'**。
   *
   * ⚠ 两条兜底刻意不同，理由不能混：
   *   · profile 为空会让下游「拿不到就不过滤」→ 跨用户串数据，**必须**兜底；
   *   · space 为空只表示"这一次读写不参与空间层"，安全地退化为用户级设置。
   *     若也兜底 'default'，所有"解析不出窗口"的调用（设置 applier / 启动早期）
   *     都会落到 **default 空间那一层** —— 那是一个具体空间的覆盖，
   *     可能并不是用户此刻所在的空间，等于凭空替另一个空间做了决定。
   *
   * 用途：「按空间隔离的设置」读取（`domain-settings#SPACE_SCOPED_SETTING_KEYS`）。
   * @returns {string} 空间 id；解析不出返回 ''（= 不参与空间层）
   */
  function currentSpaceId(): string {
    const store = context.getStore()
    if (store && store.spaceId) return String(store.spaceId)
    const runtime = resolve(store ? store.sender : null)
    try {
      const cur = runtime && runtime.spaceRuntime && typeof runtime.spaceRuntime.getCurrent === 'function'
        ? runtime.spaceRuntime.getCurrent()
        : null
      if (cur && cur.spaceId) return String(cur.spaceId)
    } catch (_) {}
    return ''
  }

  return {
    register,
    unregister,
    setPrimary,
    list,
    provide,
    resolve,
    matchBySender,
    current,
    currentOrNull,
    currentProfileId,
    currentSpaceId,
    runWithSender,
    runWithProfile,
    runWithScope,
    scopeRawIpcMain,
    scoped,
    /** 诊断：当前注册了几个窗口运行单元 */
    get size() {
      return runtimes.size
    }
  }
}

export { createWindowRuntimeRegistry, ownerWindowOf, setOwnerFallbackResolver }
export type WindowRuntimeRegistry = ReturnType<typeof createWindowRuntimeRegistry>
