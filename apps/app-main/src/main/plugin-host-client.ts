'use strict'

/**
 * plugin-host-client.js —— 进程级隔离的**主进程侧**（宿主客户端）
 *
 * 每个被隔离的插件对应**一个** `utilityProcess` 宿主（`plugin-host.js`）。
 * 本文件负责四件事：
 *
 *   1. **fork / 握手 / 收尾**：启动宿主、下发 init（源码 + 权限 + ctx 快照）、
 *      等待 `ready` 拿到插件导出的**远程模块对象**；退出时 `kill()`。
 *   2. **反向上行（宿主 → 主）**：请求/响应两通道 + 超时 + `exit` 监听。
 *      **宿主崩溃只影响它自己** —— 主进程把 pending 全部拒绝并上报，
 *      随后这个插件的生命周期状态落到 `failed`（下次启动重试），其余插件毫发无损。
 *   3. **能力代理（插件 → 主 → 真 ctx）**：宿主把 ctx 上的调用递回来，
 *      这里在**真正的** Electron 对象上执行，结果结构化克隆回传。
 *   4. **权限闸门**：只有 `grantedScopes` 放开的那几条 ctx 路径可被触达，
 *      越权时给出「缺哪个 scope」的明确报错（而不是静默返回 undefined）。
 *
 * 与 infra 的解耦：本文件不认识 `PluginRegistryV2`，只提供
 * `start()`（拿模块）与 `dispose()`（收尾）两个原语，由 APPS 组合根接线。
 */

import path from 'node:path'
import { utilityProcess } from 'electron'

type HostContext = Record<string, unknown>
type HostChild = ReturnType<typeof utilityProcess.fork>

interface PluginHostClientOptions {
  id: string
  hostPath: string
  source?: string
  entry?: string
  pluginDir?: string | null
  permissionLevel?: string
  allowedModules?: string[]
  deniedModules?: string[]
  grantedScopes?: string[]
  context?: HostContext
  timeoutMs?: number
  onCrash?(id: string, error: Error): void
  onLog?(id: string, level: string, message: string): void
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(reason: unknown): void
  timer: NodeJS.Timeout
}

interface HostMessage {
  type?: string
  reqId?: string
  exports?: unknown
  error?: unknown
  level?: string
  message?: string
  path?: unknown[]
  segs?: unknown[]
  args?: unknown[]
  ok?: boolean
  value?: unknown
  [key: string]: unknown
}

/** 默认的调用超时（init 与 invoke 共用；健康检查等短任务可自行调小）。 */
const DEFAULT_TIMEOUT_MS = 15_000
const RPC_RATE_PER_SECOND = 300
const RPC_RATE_BURST = 600
const MAX_PENDING_INVOKES = 256
const MAX_ACTIVE_CALLS = 64
const MAX_MESSAGE_DEPTH = 64
const MAX_MESSAGE_NODES = 100_000
const CAPABILITY_CALL_TIMEOUT_MS = 20_000

function settleWithin<T>(work: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(work).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function pluginHostEnvironment (): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']) {
    const value = process.env[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  return env
}

/**
 * **任何已启用插件都允许**的 ctx 路径。
 *
 * 这些是"扩展面"本身（注册 provider / 贡献声明 / 插槽调度 / 面板目录），
 * 不是系统访问 —— 插件用它来扩展浏览器，而不是读取用户数据。
 * 真正涉及数据与系统能力的路径一律要 scope（见 SCOPE_CTX_PATHS）。
 */
const BASE_CTX_PATHS = ['browser', 'onCleanup', 'onDispose', 'isActive']

/**
 * scope → 它解锁的 ctx 顶层路径。
 *
 * 为什么必须集中在一张表里：scope 的**语义**在 `plugin-sandbox.js`（SCOPE_PERMISSIONS），
 * 而"落到哪个 ctx 手柄"是 APPS 侧的知识（只有这里知道 ctx 长什么样）。
 * 两者本就不该混在一处，但必须**各自只有一份**。
 */
const SCOPE_CTX_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({})

/** 引用表上限：宿主返回的活对象按 token 暂存，超出 FIFO 淘汰。 */
const REF_CAP = 2048

let refSeq = 0

function isPlainObject (v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function cloneable (v: unknown): boolean {
  try {
    structuredClone(v)
    return true
  } catch (_) {
    return false
  }
}

function errText (e: unknown): string {
  if (!e) return '未知错误'
  if (typeof e === 'string') return e
  return e instanceof Error ? e.message : String(e)
}

function assertSafeMemberPath (segments: readonly string[]): void {
  if (segments.length > 64) throw new Error('[plugin-host] capability path is too deep')
  for (const segment of segments) {
    if (!segment || segment.length > 128 || segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
      throw new Error('[plugin-host] capability path contains a forbidden prototype member')
    }
  }
}

/** 从 ctx 里挑出可以**直接当数据**下发的部分（其余走能力代理）。 */
function buildSnapshot (context: HostContext | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  const source = context || {}
  for (const k of Object.keys(source)) {
    const v = source[k]
    if (v === null || v === undefined) continue
    const t = typeof v
    if (t === 'string' || t === 'number' || t === 'boolean') { out[k] = v; continue }
    if (t !== 'object') continue
    if (Array.isArray(v) || isPlainObject(v)) {
      if (cloneable(v)) out[k] = v
    }
  }
  return out
}

class PluginHostClient {
  readonly id: string
  private readonly _hostPath: string
  private readonly _source: string
  private readonly _entry: string
  private readonly _pluginDir: string | null
  private readonly _permissionLevel: string
  private readonly _allowedModules: string[]
  private readonly _deniedModules: string[]
  private readonly _context: HostContext
  private readonly _timeoutMs: number
  private readonly _onCrash: ((id: string, error: Error) => void) | null
  private readonly _onLog: ((id: string, level: string, message: string) => void) | null
  private readonly _allowedCtxKeys: Set<string> | null
  private _child: HostChild | null
  private _alive: boolean
  private _disposed: boolean
  private _initSettled: boolean
  private _initTimer: NodeJS.Timeout | null
  private _seq: number
  private readonly _pending: Map<string, PendingRequest>
  private readonly _refs: Map<string, object>
  private readonly _refOrder: string[]
  private readonly _refIds: Map<object, string>
  private readonly _ctxRefKeys: Map<object, string>
  private _rpcTokens: number
  private _rpcRefilledAt: number
  private _activeCalls: number
  private _readyPromise!: Promise<unknown>
  private _initResolve!: (value: unknown) => void
  private _initReject!: (reason: unknown) => void
  /**
   * @param {object} options
   * @param {string} options.id             插件 id
   * @param {string} options.hostPath       plugin-host.js 的绝对路径
   * @param {string} options.source         入口源码（主进程读好下发，宿主不碰磁盘布局）
   * @param {string} options.entry          入口绝对路径（__filename / __dirname 用）
   * @param {string} options.pluginDir      插件目录（宿主内相对 require 的边界）
   * @param {string} options.permissionLevel 'none' | 'ui' | 'network' | 'full'
   * @param {string[]} options.allowedModules 允许 require 的模块
   * @param {string[]} options.deniedModules  一律拒绝的模块
   * @param {string[]} options.grantedScopes  用户已授权的 scope
   * @param {object} options.context         **真 ctx**（在主进程侧持有）
   * @param {number} [options.timeoutMs]
   * @param {(id:string, err:Error)=>void} [options.onCrash]
   * @param {(id:string, level:string, message:string)=>void} [options.onLog]
   */
  constructor (options: PluginHostClientOptions) {
    this.id = String(options.id || '')
    this._hostPath = options.hostPath
    this._source = options.source || ''
    this._entry = options.entry || ''
    this._pluginDir = options.pluginDir || null
    this._permissionLevel = options.permissionLevel || 'ui'
    this._allowedModules = (options.allowedModules || []).slice()
    this._deniedModules = (options.deniedModules || []).slice()
    this._context = options.context || {}
    this._timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS
    this._onCrash = typeof options.onCrash === 'function' ? options.onCrash : null
    this._onLog = typeof options.onLog === 'function' ? options.onLog : null

    this._child = null
    this._alive = false
    this._disposed = false
    this._initSettled = false
    this._initTimer = null
    this._seq = 0
    this._pending = new Map() // reqId -> { resolve, reject, timer }
    this._refs = new Map()
    this._refOrder = []
    this._refIds = new Map()

    /** ctx 顶层值 → 键的反查表（_encode 做身份判断用，避免每次重建）。 */
    this._ctxRefKeys = new Map()
    this._rpcTokens = RPC_RATE_BURST
    this._rpcRefilledAt = Date.now()
    this._activeCalls = 0
    this._allowedCtxKeys = this._computeAllowedCtxKeys(options.grantedScopes || [], options.permissionLevel)
    this.primeContextRefs()
  }

  get alive () {
    return this._alive && !this._disposed
  }

  _computeAllowedCtxKeys (scopes: readonly string[], level?: string): Set<string> | null {
    // 第一方不会走到这里（loader 会委托回 in-process），但保留这条兜底：
    // 万一组合根把 full 级别的模块送进来，就别再用 scope 卡它。
    if (level === 'full') return null // null = 全放行
    const allowed = new Set(BASE_CTX_PATHS)
    for (const s of scopes) {
      const paths = SCOPE_CTX_PATHS[s]
      if (!paths) continue
      for (const p of paths) allowed.add(p)
    }
    return allowed
  }

  _assertCtxAllowed (key: string): void {
    if (this._allowedCtxKeys === null) return
    if (this._allowedCtxKeys.has(key)) return
    throw new Error(
      `[plugin-host] 插件 "${this.id}" 试图访问 ctx.${key}，但它没有对应的权限 scope。` +
      '请在 manifest 的 requestedPermissions 里声明并在插件中心授权。'
    )
  }

  _takeRpcToken (): boolean {
    const now = Date.now()
    this._rpcTokens = Math.min(
      RPC_RATE_BURST,
      this._rpcTokens + ((now - this._rpcRefilledAt) / 1000) * RPC_RATE_PER_SECOND
    )
    this._rpcRefilledAt = now
    if (this._rpcTokens < 1) return false
    this._rpcTokens -= 1
    return true
  }

  // ── 生命周期 ───────────────────────────────────────────────────

  /**
   * 启动宿主并编译插件。
   * @returns {Promise<object>} 远程模块对象（函数属性为可 await 的远程句柄）
   */
  start (): Promise<unknown> {
    if (this._child) return this._readyPromise
    this._readyPromise = new Promise((resolve, reject) => {
      this._initResolve = resolve
      this._initReject = reject
    })
    try {
      const readRoots = Array.from(new Set([this._hostPath, this._pluginDir].filter((entry): entry is string => !!entry)))
      this._child = utilityProcess.fork(this._hostPath, [], {
        serviceName: `hira-plugin:${this.id}`,
        env: pluginHostEnvironment(),
        // Node's permission model is the OS-visible backstop for the small loader:
        // direct `process.getBuiltinModule('fs')` paths still cannot escape the
        // plugin directory even if a future loader regression bypasses require().
        execArgv: [
          '--permission',
          '--max-old-space-size=256',
          ...readRoots.map((root) => `--allow-fs-read=${root}`)
        ]
      })
    } catch (e) {
      this._alive = false
      // ⚠ 这里**不能**直接用 `reject`：它只是 executor 的形参，作用域停在那个闭包里，
      //   在本方法体内引用会抛 ReferenceError —— 于是"启动插件宿主失败"这条报错
      //   会被替换成一条无关的 ReferenceError（排查时完全看不出真正原因）。
      //   `this._initReject` 是同一个 reject 的持有者，用它才是本意。
      this._initReject(new Error(`[plugin-host] 无法启动插件宿主进程（${this.id}）：${errText(e)}`))
      return this._readyPromise
    }

    this._child.on('spawn', () => {
      this._alive = true
      const reqId = `i${++this._seq}`
      const child = this._child
      if (!child) return this._failInit(new Error('[plugin-host] 宿主进程未创建'))
      try {
        child.postMessage({
          type: 'init',
          reqId,
          source: this._source,
          entry: this._entry,
          rootDir: this._pluginDir,
          permissionLevel: this._permissionLevel,
          allowedModules: this._allowedModules,
          deniedModules: this._deniedModules,
          snapshot: buildSnapshot(this._context)
        })
      } catch (e) {
        this._failInit(new Error(`[plugin-host] init 下发失败：${errText(e)}`))
        return
      }
      // init 也要有超时 —— 插件在顶层 `while(true)` 时，宿主永远回不出 ready。
      this._initTimer = setTimeout(() => this._failInit(new Error(
        `[plugin-host] 插件 "${this.id}" 初始化超时（${this._timeoutMs}ms）——入口代码可能卡死或抛错`
      )), this._timeoutMs)
      if (typeof this._initTimer.unref === 'function') this._initTimer.unref()
    })

    this._child.on('message', (msg) => this._onMessage(msg))

    this._child.on('exit', (code) => {
      const wasAlive = this._alive
      this._alive = false
      const err = new Error(`[plugin-host] 插件 "${this.id}" 的宿主进程已退出（code=${code}）`)
      this._rejectAllPending(err)
      this._failInit(err)
      // 主动 dispose 触发的退出不算崩溃。
      if (wasAlive && !this._disposed && this._onCrash) {
        try { this._onCrash(this.id, err) } catch (_) {}
      }
    })

    return this._readyPromise
  }

  _failInit (err: unknown): void {
    if (this._initSettled) return
    this._initSettled = true
    if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null }
    if (this._initReject) this._initReject(err)
  }

  _settleInit (): void {
    this._initSettled = true
    if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null }
  }

  _onMessage (msg: HostMessage): void {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'ready': {
        if (this._initSettled) return
        this._settleInit()
        if (msg.ok) {
          try { this._initResolve(this._decode(msg.exports)) } catch (e) { this._initReject(e) }
        } else {
          this._initReject(new Error(`[plugin-host] 插件 "${this.id}" 加载失败：${msg.error}`))
        }
        break
      }
      case 'reply': {
        const reqId = msg.reqId
        if (!reqId) return
        const p = this._pending.get(reqId)
        if (!p) return
        this._pending.delete(reqId)
        clearTimeout(p.timer)
        if (msg.ok) {
          try { p.resolve(this._decode(msg.value)) } catch (e) { p.reject(e) }
        } else {
          p.reject(new Error(errText(msg.error || '插件方法调用失败')))
        }
        break
      }
      case 'call':
        this._handleCall(msg)
        break
      case 'log':
        if (this._onLog) { try { this._onLog(this.id, msg.level || 'info', String(msg.message || '')) } catch (_) {} }
        break
      default:
        break
    }
  }

  _rejectAllPending (err: unknown): void {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this._pending.clear()
  }

  // ── 上行：主 → 宿主 ────────────────────────────────────────────

  /**
   * 远程调用插件导出的方法（含插件返回的对象上的方法）。
   * @param {string[]} segs 路径（相对模块导出）
   * @param {unknown[]} args
   */
  invoke (segs: string[], args?: unknown[]): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`[plugin-host] 插件 "${this.id}" 的宿主未运行`))
    if (this._pending.size >= MAX_PENDING_INVOKES) {
      return Promise.reject(new Error(`[plugin-host] 插件 "${this.id}" 的并发调用过多`))
    }
    const reqId = `p${++this._seq}`
    let payload
    try {
      payload = (args || []).map((a, i) => this._encode(a, `${segs.join('.')} 的第 ${i + 1} 个参数`, new Set()))
    } catch (e) {
      return Promise.reject(e)
    }
    return new Promise((resolve, reject) => {
      const child = this._child
      if (!child) {
        reject(new Error(`[plugin-host] 插件 "${this.id}" 的宿主连接已关闭`))
        return
      }
      const timer = setTimeout(() => {
        this._pending.delete(reqId)
        reject(new Error(`[plugin-host] 调用插件方法超时（${this._timeoutMs}ms）：${segs.join('.')}`))
      }, this._timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this._pending.set(reqId, { resolve, reject, timer })
      try {
        child.postMessage({ type: 'invoke', reqId, path: segs, args: payload })
      } catch (e) {
        clearTimeout(timer)
        this._pending.delete(reqId)
        reject(new Error(`[plugin-host] 下发调用失败：${errText(e)}`))
      }
    })
  }

  // ── 下行：宿主 → 主（插件调用真 ctx）──────────────────────────

  async _handleCall (msg: HostMessage): Promise<void> {
    const reqId = msg.reqId
    const segs = Array.isArray(msg.path) ? msg.path.map(String) : []
    const done = (ok: boolean, value: unknown, error: unknown): void => {
      if (!this._child) return
      try {
        this._child.postMessage(ok
          ? { type: 'call-result', reqId, ok: true, value }
          : { type: 'call-result', reqId, ok: false, error })
      } catch (_) {}
    }
    if (this._activeCalls >= MAX_ACTIVE_CALLS) {
      done(false, null, '插件能力调用并发过多，请稍后重试')
      return
    }
    this._activeCalls += 1
    try {
      if (!this._takeRpcToken()) throw new Error('插件能力调用过于频繁，请稍后重试')
      const decodedArgs = (msg.args || []).map((a) => this._decode(a))
      const { fn, owner } = this._resolveContext(segs)
      if (typeof fn !== 'function') {
        throw new Error(`ctx.${segs.join('.')} 不是可调用的能力`)
      }
      let out: unknown = fn.apply(owner, decodedArgs)
      if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
        out = await settleWithin(
          out as PromiseLike<unknown>,
          CAPABILITY_CALL_TIMEOUT_MS,
          `[plugin-host] 能力调用超时（${CAPABILITY_CALL_TIMEOUT_MS}ms）：ctx.${segs.join('.')}`
        )
      }
      done(true, this._encode(out, `ctx.${segs.join('.')} 的返回值`, new Set()), null)
    } catch (e) {
      done(false, null, errText(e))
    } finally {
      this._activeCalls = Math.max(0, this._activeCalls - 1)
    }
  }

  /** 把 `['a','b']` / `['__ref', token, ...]` 解析成 { fn, owner }。 */
  _resolveContext (segs: string[]): { fn: ((...args: unknown[]) => unknown) | null; owner: unknown } {
    assertSafeMemberPath(segs)
    let cur: unknown
    let i = 0
    if (segs[0] === '__ref') {
      cur = this._refs.get(segs[1])
      if (!cur) throw new Error('[plugin-host] 引用已失效（引用表已淘汰该对象），请重新获取')
      i = 2
    } else {
      if (!segs.length) throw new Error('[plugin-host] 无效的 ctx 路径')
      this._assertCtxAllowed(segs[0])
      cur = this._context
    }
    let owner = null
    for (; i < segs.length; i++) {
      owner = cur
      const record = cur && typeof cur === 'object' ? cur as Record<string, unknown> : null
      cur = record ? record[segs[i]] : undefined
    }
    return { fn: typeof cur === 'function' ? cur as (...args: unknown[]) => unknown : null, owner }
  }

  // ── 值编解码 ──────────────────────────────────────────────────

  _storeRef (v: object): string {
    const exist = this._refIds.get(v)
    if (exist !== undefined) return exist
    const token = `m${++refSeq}`
    this._refIds.set(v, token)
    this._refs.set(token, v)
    this._refOrder.push(token)
    while (this._refOrder.length > REF_CAP) {
      const old = this._refOrder.shift()
      if (!old) break
      const dead = this._refs.get(old)
      if (dead !== undefined) this._refIds.delete(dead)
      this._refs.delete(old)
    }
    return token
  }

  _encode (v: unknown, label: string, seen: Set<object>): unknown {
    if (v === null || v === undefined) return v
    const t = typeof v
    if (t === 'function') {
      const key = this._ctxRefKeys.get(v)
      if (key !== undefined) return { __hiraCtx: key }
      const remote = (v as ((...args: unknown[]) => Promise<unknown>) & { __hiraRemotePath?: unknown }).__hiraRemotePath
      if (Array.isArray(remote)) return { __hiraRemote: remote }
      return { __hiraRef: this._storeRef(v) }
    }
    if (t !== 'object') {
      if (t === 'symbol') throw new Error(`[plugin-host] 参数 ${label} 是 Symbol，无法跨进程传递`)
      return v
    }
    const key = this._ctxRefKeys.get(v)
    if (key !== undefined) {
      this._assertCtxAllowed(key)
      return { __hiraCtx: key }
    }
    const ref = this._refIds.get(v)
    if (ref !== undefined) return { __hiraRef: ref }
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new Error(`[plugin-host] 参数 ${label} 存在循环引用，无法跨进程传递`)
      seen.add(v)
      try { return v.map((x, i) => this._encode(x, `${label}[${i}]`, seen)) } finally { seen.delete(v) }
    }
    if (isPlainObject(v)) {
      if (seen.has(v)) throw new Error(`[plugin-host] 参数 ${label} 存在循环引用，无法跨进程传递`)
      seen.add(v)
      try {
        const out: Record<string, unknown> = Object.create(null)
        const record = v as Record<string, unknown>
        for (const k of Object.keys(record)) out[k] = this._encode(record[k], `${label}.${k}`, seen)
        return out
      } finally { seen.delete(v) }
    }
    // 类实例 / 活对象：能结构化克隆就传值；带函数的活对象一律拒绝。
    // A live main-process reference would expose every method reachable from that
    // object, defeating the facade's method-level capability checks.
    if (cloneable(v)) return v
    throw new Error(`[plugin-host] ${label} 返回了不可序列化的主进程对象；请在能力门面中转换为纯数据`)
  }

  _decode (v: unknown): unknown {
    return this._decodeWithBudget(v, 0, { nodes: 0 })
  }

  private _decodeWithBudget (v: unknown, depth: number, budget: { nodes: number }): unknown {
    if (depth > MAX_MESSAGE_DEPTH) throw new Error('[plugin-host] 插件返回值嵌套过深')
    budget.nodes += 1
    if (budget.nodes > MAX_MESSAGE_NODES) throw new Error('[plugin-host] 插件返回值节点过多')
    if (v === null || typeof v !== 'object') return v
    const record = v as Record<string, unknown>
    if (record.__hiraCtx !== undefined) {
      const contextKey = String(record.__hiraCtx)
      this._assertCtxAllowed(contextKey)
      return this._context[contextKey]
    }
    if (record.__hiraRef !== undefined) return this._refs.get(String(record.__hiraRef))
    if (Array.isArray(record.__hiraRemote)) return this._remoteFunction(record.__hiraRemote.map(String))
    if (Array.isArray(v)) return v.map((x) => this._decodeWithBudget(x, depth + 1, budget))
    const out: Record<string, unknown> = Object.create(null)
    for (const k of Object.keys(record)) out[k] = this._decodeWithBudget(record[k], depth + 1, budget)
    return out
  }

  /**
   * 把宿主给的函数句柄包成一个**真函数**：调用即回落到宿主里的那个函数。
   *
   * 注意它返回 **Promise** —— 跨进程不可能同步取值。infra 侧对 provider /
   * 插槽实现一律 `await`，所以这条折衷在契约内成立。
   */
  _remoteFunction (segs: string[]): (...args: unknown[]) => Promise<unknown> {
    const client = this
    const fn = function (...args: unknown[]): Promise<unknown> { return client.invoke(segs, args) } as ((...args: unknown[]) => Promise<unknown>) & { __hiraRemotePath?: string[] }
    fn.__hiraRemotePath = segs
    return fn
  }

  /** ctx 顶层值 → 键的反查表（供 _encode 做身份判断）。 */
  primeContextRefs (): void {
    for (const k of Object.keys(this._context || {})) {
      const v = this._context[k]
      if (v === null || v === undefined) continue
      const t = typeof v
      if (t === 'object' || t === 'function') this._ctxRefKeys.set(v, k)
    }
  }

  // ── 收尾 ─────────────────────────────────────────────────────

  dispose (): void {
    if (this._disposed) return
    this._disposed = true
    this._alive = false
    this._rejectAllPending(new Error(`[plugin-host] 插件 "${this.id}" 的宿主已关闭`))
    if (!this._initSettled) this._failInit(new Error(`[plugin-host] 插件 "${this.id}" 的宿主在初始化完成前被关闭`))
    const child = this._child
    this._child = null
    if (!child) return
    try { child.postMessage({ type: 'dispose' }) } catch (_) {}
    try { child.kill() } catch (_) {}
  }
}

/** 便于组合根直接拿到路径（无需自己拼 __dirname）。 */
export const hostPath = path.join(__dirname, 'plugin-host.js')

export { PluginHostClient, SCOPE_CTX_PATHS, BASE_CTX_PATHS }
