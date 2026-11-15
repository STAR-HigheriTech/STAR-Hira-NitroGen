import type {
  SettingsApplier,
  SettingsApplyContext,
  SettingsPort
} from './appliers/types'

/**
 * settings/sync.ts — 设置生效协调器（main process）
 *
 * 解决的问题：`settings:set` 只把值写进存储就结束，没有任何模块知道值变了 →
 * "改设置没效果"。本模块把一次变更同时送达两条下游链路：
 *   1. **应用**：分发给注册的 applier，让它在主进程侧真正生效
 *      （改 session header、改下载行为、改搜索引擎……）
 *   2. **广播**：推给所有渲染进程，让 UI 侧即时响应
 *
 * 不做的事：
 *   - 不认识任何具体设置项的含义（那是 applier 的事）
 *   - 不做校验 / 拒绝（domain 层已经存了，这里只负责让它生效）
 *
 * 插件化：任何模块都可以 `registerApplier({ id, keys, apply })` 挂载自己的生效逻辑，
 * 无需修改本文件。差异点是 Provider，不是 if-else。
 *
 * 性能（极致流畅）：
 *   - 广播**跳过发起变更的那个 webContents**（originId）—— 发起方通常已经乐观更新，
 *     再回送一次纯属浪费，还可能引发不必要的重渲染。
 *   - 只向存活且非自身的 webContents 发送。
 *   - 广播先落地，后台 applier 串行执行，避免慢副作用拖住界面。
 */

/**
 */
export interface SettingsChange {
  scope: 'one' | 'all'
  key?: string
  value?: unknown
  previous?: unknown
  originId?: number
  /** 变更所属作用域；切换 profile/space 时用于钉住 applier 的读取上下文。 */
  profileId?: string
  spaceId?: string
  /** 后台排队期间目标已被更快的一次切换取代时，applier 应整段跳过。 */
  shouldApply?: () => boolean
}

export interface SettingsServicePort extends SettingsPort {
  subscribe?(listener: (change: SettingsChange) => void): (() => void) | unknown
  list?(section?: string): unknown
}

export interface SettingsSyncOptions {
  settings: SettingsServicePort
  send?: (route: string, payload: unknown, options?: { skipWebContentsId?: number }) => number
  runWithScope?: <T>(profileId: string, spaceId: string, task: () => T) => T
}

export interface SettingsSync {
  start(): void
  stop(): void
  emit(change: SettingsChange, options?: { broadcast?: boolean }): Promise<void>
  applyAll(extra?: Partial<SettingsApplyContext>): void
  applyAllAsync(extra?: Partial<SettingsApplyContext>, options?: { shouldContinue?: () => boolean }): Promise<boolean>
  applyApplier(id: string, extra?: Partial<SettingsApplyContext>): boolean
  broadcast(change: SettingsChange): void
  registerApplier(applier: SettingsApplier): void
  unregisterApplier(id: string): void
  listAppliers(): Array<{ id: string; keys: readonly string[] }>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const APPLIER_TIMEOUT_MS = 15_000

/** 判断 applier 声明的 keys 是否命中某个 key */
export function matches(keys: readonly string[], key: string | undefined): boolean {
  if (typeof key !== 'string') return false
  for (const k of keys) {
    if (k === key) return true
    if (k.endsWith('.') && String(key).startsWith(k)) return true
    if (k === '*') return true
  }
  return false
}

/**
 * @param {Object} options
 * @param {{ subscribe:(fn:(c:SettingsChange)=>void)=>()=>void, get:(k:string)=>any, list:(s?:string)=>any }} options.settings
 * @param {(route:string, payload:any, opts?:{skipWebContentsId?:number}) => number} options.send
 *   事件广播出口（只发给登记过订阅的渲染进程）。由 APPS 层注入 broadcaster.send。
 */
export function createSettingsSync({ settings, send, runWithScope }: SettingsSyncOptions): SettingsSync {
  const appliers: SettingsApplier[] = []
  /** 待处理的变更队列：串行执行，避免并发 applier 互相踩踏 */
  let chain: Promise<void> = Promise.resolve()
  let started = false
  let stopped = false
  let unsubscribeSettings: (() => void) | null = null

  async function applyOne(applier: SettingsApplier, context: SettingsApplyContext, label: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const result = applier.apply(context)
      if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return true
      const work = Promise.resolve(result as PromiseLike<unknown>)
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`applier timed out after ${APPLIER_TIMEOUT_MS}ms`)), APPLIER_TIMEOUT_MS)
      })
      await Promise.race([work, timeout])
      return true
    } catch (error) {
      console.error(`[settings] applier "${applier.id}" failed on ${label}:`, errorMessage(error))
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 注册一个"设置生效器"。
   * @param {Applier} applier
   */
  function registerApplier(applier: SettingsApplier): void {
    if (!applier || typeof applier.apply !== 'function') return
    appliers.push(applier)
  }

  /**
   * 注销（Mod 卸载 / 热替换用）。
   * @param {string} id
   */
  function unregisterApplier(id: string): void {
    const i = appliers.findIndex((a) => a.id === id)
    if (i >= 0) appliers.splice(i, 1)
  }

  /**
   * 广播变更到所有渲染进程。
   *
   * 用 `webContents.getAllWebContents()` 而不是自己维护窗口列表 ——
   * 标签是 WebContentsView 而非 BrowserWindow，只遍历 BrowserWindow 会漏掉全部标签页。
   *
   * @param {SettingsChange} change
   */
  function broadcast(change: SettingsChange): void {
    const originId = change.originId || 0
    if (typeof send !== 'function') return
    // 只发给「登记过 settings:changed」的渲染进程（见 infra-ipc/ListenerRegistry）。
    // skipWebContentsId 跳过发起方：它已经乐观更新过，回声只会制造无谓的重渲染。
    send('settings:changed', {
      scope: change.scope,
      key: change.key,
      value: change.value,
      originId,
      ...(change.profileId ? { profileId: change.profileId } : {}),
      ...(change.spaceId ? { spaceId: change.spaceId } : {})
    }, originId ? { skipWebContentsId: originId } : undefined)
  }

  /**
   * 在主进程侧应用一次变更。
   * @param {SettingsChange} change
   */
  async function applyChange(change: SettingsChange): Promise<void> {
    // scope==='all'（整体重置）：通知所有 applier，key 为空表示"全量重算"
    if (change.scope === 'all') {
      for (const a of appliers) {
        await applyOne(a, { key: '', value: undefined, previous: change.previous, settings }, 'reset')
      }
      return
    }
    for (const a of appliers) {
      if (!matches(a.keys, change.key)) continue
      await applyOne(
        a,
        { key: change.key, value: change.value, previous: change.previous, settings },
        String(change.key || 'all')
      )
    }
  }

  function handleChange(change: SettingsChange, options: { broadcast?: boolean } = {}): Promise<void> {
    if (stopped) return Promise.resolve()
    // 广播不等 applier：设置值已经持久化，UI 必须立刻看到新值；
    // 主进程副作用再按队列顺序执行。
    if (options.broadcast !== false && (typeof change.shouldApply !== 'function' || change.shouldApply())) {
      try { broadcast(change) } catch (e) {
        console.error('[settings] broadcast failed:', errorMessage(e))
      }
    }
    // 串行化：applier 多是"改全局状态"的操作（session header、下载目录等），
    // 并发执行顺序不可控。串行保证后一次变更覆盖前一次。
    chain = chain.then(async () => {
      const run = async () => {
        if (typeof change.shouldApply === 'function' && !change.shouldApply()) return
        await applyChange(change)
      }
      if (typeof runWithScope === 'function' && (change.profileId || change.spaceId)) {
        return await runWithScope(change.profileId || '', change.spaceId || '', run)
      }
      return await run()
    }).catch((e) => {
      console.error('[settings] sync chain error:', errorMessage(e))
    })
    return chain
  }

  /** 开始订阅 domain 层的变更通知 */
  function start(): void {
    if (started) return
    started = true
    stopped = false
    if (typeof settings.subscribe !== 'function') {
      console.warn('[settings] settings.subscribe unavailable — 设置变更不会被应用/广播')
      return
    }
    try {
      const unsubscribe = settings.subscribe(handleChange)
      unsubscribeSettings = typeof unsubscribe === 'function' ? unsubscribe as () => void : null
    } catch (error) {
      started = false
      stopped = true
      console.error('[settings] subscribe failed:', errorMessage(error))
    }
  }

  function stop(): void {
    if (!started) return
    started = false
    stopped = true
    if (unsubscribeSettings) {
      try {
        unsubscribeSettings()
      } catch (error) {
        console.warn('[settings] unsubscribe failed:', errorMessage(error))
      }
      unsubscribeSettings = null
    }
  }

  /**
   * 外部（如 IPC handler）显式上报一次变更（可携带 originId）。
   * @param {SettingsChange} change
   */
  function emit(change: SettingsChange, options: { broadcast?: boolean } = {}): Promise<void> {
    return handleChange(change, options)
  }

  /**
   * 启动时全量应用一次：把已持久化的设置推给所有 applier。
   * 否则"上次退出时保存的设置"要等到下次改动才生效。
   * @param {object} [extra] 透传给 applier 的额外载荷（如 `{ force: true }`）
   */
  function applyAll(extra: Partial<SettingsApplyContext> = {}): void {
    for (const a of appliers) {
      void applyOne(a, { key: '', value: undefined, previous: undefined, settings, ...extra }, 'init')
    }
  }

  /**
   * 合作式全量应用：每个 applier 之间让出一拍事件循环。
   *
   * 切 profile 后确实需要重跑全部 applier，但把它们串成一段同步长任务会阻塞
   * 点击、首帧与 IPC。这里的顺序与 applyAll 完全一致，只把「一段长同步」
   * 拆成可响应的小段；shouldContinue 让快速连续切换能及时中止旧目标。
   */
  async function applyAllAsync(
    extra: Partial<SettingsApplyContext> = {},
    options: { shouldContinue?: () => boolean } = {}
  ): Promise<boolean> {
    for (const a of appliers) {
      if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return false
      await applyOne(a, { key: '', value: undefined, previous: undefined, settings, ...extra }, 'cooperative replay')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return !options.shouldContinue || options.shouldContinue()
  }

  /**
   * 只重放**某一个** applier（按 id）。
   *
   * 用途：切 profile 时，有指纹去重的 applier（网络代理 / UA）需要**强制**重下一次 ——
   * 否则"新 profile 的代理恰好与旧 profile 相同"时会被去重跳过，而它的 session
   * 其实一次都没配过。这里按 id 精确重放，不必惊动其余 applier
   * （全量 applyAll 会让内容拦截等重活白跑一遍）。
   * @param {string} id
   * @param {object} [extra]
   */
  function applyApplier(id: string, extra: Partial<SettingsApplyContext> = {}): boolean {
    const a = appliers.find((x) => x.id === id)
    if (!a) return false
    void applyOne(a, { key: '', value: undefined, previous: undefined, settings, ...extra }, 'replay')
    return true
  }

  return {
    start,
    stop,
    emit,
    applyAll,
    applyAllAsync,
    applyApplier,
    broadcast,
    registerApplier,
    unregisterApplier,
    listAppliers: () => appliers.map((a) => ({ id: a.id, keys: a.keys }))
  }
}

