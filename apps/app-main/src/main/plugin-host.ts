'use strict'

/**
 * plugin-host.js —— 社区插件的**独立进程宿主**（Electron `utilityProcess`）
 *
 * ── 为什么必须有它（PART7 §7.13 的硬指标）────────────────────────────
 * `plugin-sandbox.js` 的进程内沙箱只能拦住"顺手 `require('fs')`"这类误用：
 * `process` / `global` / `Function` / `eval` 对它全部可见，一次 `while(true)`、
 * 一次 `process.exit()`、一次原生层崩溃，浏览器就跟着一起死。
 * 真正的隔离只有一条路 —— **把插件代码放到另一个进程里跑**，于是：
 *   · 崩溃 = 宿主进程退出 → 主进程只收到一个 `exit` 事件；
 *   · 死循环 = 宿主进程卡死 → 主进程按超时把它 `kill()` 掉；
 *   · `require('fs')` = 被本文件的白名单挡在 `new Function` 里。
 *
 * ── 两条铁律（改这个文件前先读）───────────────────────────────────
 * 1. **自包含**：不 require 仓库里的任何模块（`@hira-ng/*`、`./xxx` 一律不许）。
 *    infra 的源码会被打进主进程 bundle，宿主进程里根本解析不到它们。
 *    只允许 Node 内建：`fs`（读插件目录里的兄弟文件）与 `path`。
 * 2. **只信任 init 下发的数据面**：`{ source, entry, rootDir, permissionLevel,
 *    allowedModules, deniedModules, snapshot }`。除此之外宿主自己什么都不知道。
 *
 * ── 协议（主进程 ⇄ 宿主）────────────────────────────────────────
 *   主 → 宿主：init / invoke / call-result / dispose
 *   宿主 → 主：ready   / reply  / call
 *
 *   · `invoke`  主进程调用插件的导出方法（含插件返回的对象上的方法）。
 *   · `call`    插件反向调用主进程能力的**唯一**通道：宿主侧把 ctx 做成
 *               **能力代理**（属性读 → 更深一层代理；调用 → 一次 RPC），
 *               主进程在**真 ctx** 上执行后把结果结构化克隆回来。
 *   · 函数值一律走「引用句柄」跨进程往返（见 encode / decode），
 *     因为 `postMessage` 的结构化克隆会直接丢掉函数。
 */

import fs from 'node:fs'
import path from 'node:path'

type UnknownRecord = Record<string, unknown>

interface CachedModule {
  exports: unknown
}

interface PendingRpc {
  resolve(value: unknown): void
  reject(reason?: unknown): void
  timer: NodeJS.Timeout
}

interface HostMessage {
  type?: string
  reqId?: string
  source?: string
  entry?: string
  rootDir?: string | null
  permissionLevel?: string
  allowedModules?: string[]
  deniedModules?: string[]
  snapshot?: unknown
  path?: unknown[]
  args?: unknown[]
  ok?: boolean
  value?: unknown
  error?: unknown
  exports?: unknown
  level?: string
  message?: string
}

const parentPort = process.parentPort
/** Only the trusted loader may compile plugin modules after the global guard is installed. */
const HostFunction = Function

/** 插件调用主进程能力的超时上限（超过即视为插件侧死锁 / 主进程异常）。 */
const CALL_TIMEOUT_MS = 20_000
/** 返回值引用表上限：超出按 FIFO 淘汰最旧的（老句柄失效时给出明确报错）。 */
const REF_CAP = 4096
const MAX_PENDING_CALLS = 128

/** 挂在能力代理上的路径标记 —— encode 靠它把"句柄回传"还原成路径。 */
const REMOTE_PATH = Symbol('hira.remotePath')

/** init 注入的运行时状态。 */
let mod: unknown = null
let ctx: UnknownRecord | null = null
let rootDir: string | null = null
let allowedModules = new Set<string>()
let deniedModules = new Set<string>()
const originalGetBuiltinModule = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule.bind(process)
  : null

/** 宿主发起的 RPC：reqId → { resolve, reject, timer }。 */
const pending = new Map<string, PendingRpc>()
let seq = 0

/** 插件交给宿主的**活对象**（含函数），主进程按 `['__ret', token, ...]` 回指。 */
const retRefs = new Map<string, unknown>()
const retOrder: string[] = []
let retSeq = 0

/**
 * 插件目录内的兄弟文件缓存（自建迷你 CJS 加载器）。
 * 上限按条目计：一个插件进程只服务一个插件，正常体量远到不了；超限按最久未用淘汰，
 * 防止**环形 require / 动态拼接文件名**这类写法把宿主内存拖成无界增长。
 * 代价（刻意接受）：被淘汰的模块再次 require 会重新执行一遍（丢掉旧的模块级状态）。
 */
const fileCache = new Map<string, CachedModule>()
const FILE_CACHE_MAX = 1024
const MAX_MODULE_SOURCE_BYTES = 4 * 1024 * 1024

function canonicalModuleName (name: unknown): string {
  const specifier = String(name || '').trim()
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier
}

/** The module contract is CommonJS; dynamic ESM import would bypass the require policy. */
function assertSourcePolicy (source: string, filename: string): void {
  if (/\bimport\s*\(/.test(source)) {
    throw new Error(`[PluginSandbox] dynamic import() is not allowed in plugin modules: ${filename}`)
  }
  if (/\bprocess\s*\.\s*(?:binding|_linkedBinding)\s*\(/.test(source)) {
    throw new Error(`[PluginSandbox] internal process bindings are not allowed: ${filename}`)
  }
}

function installRuntimeGuards (permissionLevel: string): void {
  if (originalGetBuiltinModule) {
    try {
      Object.defineProperty(process, 'getBuiltinModule', {
        configurable: false,
        writable: false,
        value: (name: string) => requireBare(name)
      })
    } catch (error) {
      // A writable original would bypass the module policy. Fail the host closed
      // instead of running untrusted code with an unverified require path.
      throw new Error(`[PluginSandbox] cannot install getBuiltinModule guard: ${errText(error)}`)
    }
  }
  for (const key of ['binding', '_linkedBinding', 'dlopen', 'kill', 'reallyExit', 'abort', 'report']) {
    try {
      Object.defineProperty(process, key, {
        configurable: false,
        writable: false,
        value: () => { throw new Error(`[PluginSandbox] process.${key} is not available to plugins`) }
      })
    } catch (_) {}
  }
  if (permissionLevel !== 'network' && permissionLevel !== 'full') {
    for (const key of ['fetch', 'WebSocket', 'EventSource']) {
      try { Object.defineProperty(globalThis, key, { configurable: false, writable: false, value: undefined }) } catch (_) {}
    }
  }
  const blocked = function blockedDynamicCode (): never {
    throw new Error('[PluginSandbox] Function / eval are not available to plugins')
  }
  const asyncFunction = (async function () {}).constructor as { prototype: object }
  const generatorFunction = (function* () {}).constructor as { prototype: object }
  const asyncGeneratorFunction = (async function* () {}).constructor as { prototype: object }
  for (const object of [
    Function.prototype,
    asyncFunction.prototype,
    generatorFunction.prototype,
    asyncGeneratorFunction.prototype
  ]) {
    Object.defineProperty(object, 'constructor', {
      configurable: false,
      writable: false,
      value: blocked
    })
  }
  Object.defineProperty(globalThis, 'Function', { configurable: false, writable: false, value: blocked })
  Object.defineProperty(globalThis, 'eval', { configurable: false, writable: false, value: blocked })
}

function cacheGet (filename: string): CachedModule | undefined {
  const hit = fileCache.get(filename)
  if (hit === undefined) return undefined
  // 命中后提到队尾，让淘汰真正落在"最久没用"的那条上
  fileCache.delete(filename)
  fileCache.set(filename, hit)
  return hit
}

function cacheSet (filename: string, m: CachedModule): void {
  if (fileCache.has(filename)) fileCache.delete(filename)
  fileCache.set(filename, m)
  while (fileCache.size > FILE_CACHE_MAX) {
    const oldest = fileCache.keys().next()
    if (oldest.done) break
    fileCache.delete(oldest.value)
  }
}

// ── 基础工具 ─────────────────────────────────────────────────────

function isPlainObject (v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** 结构化克隆能不能过 —— 能过就整棵子树原样返回，省掉逐字段重建。 */
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
  if (!isRecord(e)) return String(e)
  return (e.stack ? String(e.stack) : '') || String(e.message || e)
}

function isRecord (value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function readMember (value: unknown, key: string): unknown {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') return undefined
  return isRecord(value) ? value[key] : undefined
}

function registerRet (v: unknown): string {
  const token = `r${++retSeq}`
  retRefs.set(token, v)
  retOrder.push(token)
  while (retOrder.length > REF_CAP) {
    const oldest = retOrder.shift()
    if (oldest) retRefs.delete(oldest)
  }
  return token
}

// ── 能力代理：宿主侧唯一通向主进程的门 ───────────────────────────

/**
 * 把一个**路径**包装成"可读可调"的代理。
 *
 * 关键性质：读任意属性都拿到**同构的更深代理**，于是插件的
 * `ctx.tabManager.getTabs()` / `ctx.webContents.zoomFactor` 这类写法天然成立 ——
 * 真正的执行发生在主进程，宿主只负责把路径 + 参数递过去。
 */
function makeCapability (segs: string[]): unknown {
  const target = function (): void {}
  return new Proxy(target, {
    get (_t, prop) {
      if (prop === REMOTE_PATH) return segs
      if (prop === 'then') return undefined // 别被当成 thenable
      if (prop === 'constructor') return undefined
      if (prop === '__proto__' || prop === 'prototype') return undefined
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toPrimitive || prop === Symbol.toStringTag) return () => `[Hira 能力代理 ${segs.join('.')}]`
        return undefined
      }
      if (prop === 'toString' || prop === 'valueOf' || prop === 'inspect') {
        return () => `[Hira 能力代理 ${segs.join('.')}]`
      }
      return makeCapability(segs.concat(String(prop)))
    },
    apply (_t, _thisArg, args) {
      return rpcCall(segs, args)
    },
    set () {
      throw new Error(`[plugin-host] 插件不能给宿主能力赋值：${segs.join('.')}`)
    }
  })
}

function rpcCall (segs: string[], args: unknown[]): Promise<unknown> {
  if (pending.size >= MAX_PENDING_CALLS) {
    return Promise.reject(new Error('[plugin-host] 宿主能力并发调用过多'))
  }
  const reqId = `w${++seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      reject(new Error(`[plugin-host] 调用宿主能力超时（${CALL_TIMEOUT_MS}ms）：${segs.join('.')}`))
    }, CALL_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    pending.set(reqId, { resolve, reject, timer })
    try {
      parentPort.postMessage({ type: 'call', reqId, path: segs, args: encode(args, [], new Set()) })
    } catch (e) {
      clearTimeout(timer)
      pending.delete(reqId)
      reject(new Error(`[plugin-host] 参数无法跨进程传递（${segs.join('.')}）：${errText(e)}`))
    }
  })
}

/** ctx 代理：init 带来的「可克隆快照」直接读，其余一律落到能力代理。 */
function createCtxProxy (snapshot: unknown): UnknownRecord {
  const base: UnknownRecord = isRecord(snapshot) ? snapshot : {}
  return new Proxy(base, {
    get (t, prop) {
      if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') return undefined
      if (typeof prop === 'symbol') return Reflect.get(t, prop)
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop]
      return makeCapability([String(prop)])
    }
  })
}

// ── 跨进程值的编码 / 解码 ────────────────────────────────────────

/**
 * 宿主 → 主进程。
 *   · 可克隆 → 原样（结构化克隆自己会处理）
 *   · 函数   → 句柄 `{ __hiraRemote: path }`（主进程据此回调）
 *   · 能力代理 → 原样还原成 `{ __hiraCtx }` / `{ __hiraRef }`
 *   · 其余含函数的对象 → 登记为引用，函数按 `['__ret', token, ...]` 回指
 */
function encode (v: unknown, basePath: Array<string | number>, seen: Set<object>): unknown {
  if (v === null || v === undefined) return v
  const t = typeof v
  if (t === 'function') {
    const remotePath = Reflect.get(v, REMOTE_PATH)
    if (Array.isArray(remotePath) && remotePath.length) {
      const segs = remotePath.map(String)
      if (segs[0] === '__ref') return { __hiraRef: segs[1] }
      if (segs.length === 1) return { __hiraCtx: segs[0] }
      throw new Error(`[plugin-host] 能力代理只能整体回传，不能切片：${segs.join('.')}`)
    }
    return { __hiraRemote: ['__ret', registerRet(v)] }
  }
  if (t !== 'object') {
    if (t === 'symbol') throw new Error('[plugin-host] 插件返回值包含 Symbol，无法跨进程传递')
    return v
  }
  if (cloneable(v)) return v
    if (seen.has(v)) return null // 循环引用 → 断链，避免整条消息发不出去
  seen.add(v)
  try {
    const token = registerRet(v)
    const base: Array<string | number> = ['__ret', token]
    if (Array.isArray(v)) return v.map((x, i) => encode(x, base.concat(i), seen))
    const out: UnknownRecord = Object.create(null)
    const record = v as UnknownRecord
    for (const k of Object.keys(record)) out[k] = encode(record[k], base.concat(k), seen)
    return out
  } finally {
    seen.delete(v)
  }
}

/** 主进程 → 宿主：把句柄还原成可用的东西（能力代理 / 本地函数）。 */
function decode (v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  const record = v as UnknownRecord
  if (record.__hiraCtx) return ctx ? ctx[String(record.__hiraCtx)] : undefined
  if (record.__hiraRef) return makeCapability(['__ref', String(record.__hiraRef)])
  if (Array.isArray(record.__hiraRemote)) {
    const segs = record.__hiraRemote.map(String)
    return function (...args: unknown[]) {
      const { fn, owner } = resolveTarget(segs)
      if (typeof fn !== 'function') throw new Error(`[plugin-host] 句柄已失效：${segs.join('.')}`)
      return fn.apply(owner, args.map(decode))
    }
  }
  if (Array.isArray(v)) return v.map(decode)
  const out: UnknownRecord = Object.create(null)
  for (const k of Object.keys(record)) out[k] = decode(record[k])
  return out
}

function resolveTarget (segs: string[]): { fn: unknown; owner: unknown } {
  let cur: unknown
  let owner: unknown = null
  let i = 0
  if (segs[0] === '__ret') {
    cur = retRefs.get(segs[1])
    i = 2
  } else {
    cur = mod
  }
  for (; i < segs.length; i++) {
    owner = cur
    cur = readMember(cur, segs[i])
  }
  return { fn: cur, owner }
}

// ── 插件侧 require：白名单 + 目录内相对路径 ──────────────────────

function requireBare (name: unknown): unknown {
  const n = canonicalModuleName(name)
  if (deniedModules.has(n)) {
    throw new Error(`[PluginSandbox] require('${n}') 被禁止（权限级别不足）。请改用插件 API。`)
  }
  if (!allowedModules.has(n)) {
    throw new Error(`[PluginSandbox] require('${n}') 不在白名单内。`)
  }
  return require(n)
}

/** 解析插件目录内的相对路径（越界一律拒绝）。 */
function insideRoot (p: string): boolean {
  if (!rootDir) return false
  try {
    const realRoot = fs.realpathSync(rootDir)
    const realPath = fs.realpathSync(p)
    const rel = path.relative(realRoot, realPath)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch (_) {
    return false
  }
}

function resolveFile (base: string): string {
  const candidates = [
    base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`,
    path.join(base, 'index.js'), path.join(base, 'index.cjs')
  ]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch (_) {}
  }
  throw new Error(`[PluginSandbox] 找不到模块：${base}`)
}

function loadFile (filename: string): unknown {
  const hit = cacheGet(filename)
  if (hit) return hit.exports
  if (fs.statSync(filename).size > MAX_MODULE_SOURCE_BYTES) {
    throw new Error(`[PluginSandbox] module exceeds ${MAX_MODULE_SOURCE_BYTES} bytes: ${filename}`)
  }
  const src = fs.readFileSync(filename, 'utf8')
  assertSourcePolicy(src, filename)
  const m: CachedModule = { exports: {} }
  cacheSet(filename, m)
  const dir = path.dirname(filename)
  const localRequire = (spec: unknown): unknown => {
    const s = String(spec)
    if (s.startsWith('.') || path.isAbsolute(s)) {
      const resolved = resolveFile(path.resolve(dir, s))
      if (!insideRoot(resolved)) {
        throw new Error(`[PluginSandbox] 越界访问插件目录之外的文件：${s}`)
      }
      return loadFile(resolved)
    }
    return requireBare(s)
  }
  const factory = new HostFunction('require', 'module', 'exports', '__filename', '__dirname', src)
  factory(localRequire, m, m.exports, filename, dir)
  return m.exports
}

// ── 主进程消息处理 ───────────────────────────────────────────────

function replyResult (reqId: unknown, ok: boolean, value: unknown, error: unknown): void {
  parentPort.postMessage(ok
    ? { type: 'reply', reqId, ok: true, value }
    : { type: 'reply', reqId, ok: false, error })
}

function handleInit (msg: HostMessage): void {
  allowedModules = new Set((msg.allowedModules || []).map(canonicalModuleName))
  deniedModules = new Set((msg.deniedModules || []).map(canonicalModuleName))
  rootDir = msg.rootDir || null
  ctx = createCtxProxy(msg.snapshot)
  installRuntimeGuards(String(msg.permissionLevel || 'ui'))
  try {
    const entry = String(msg.entry || '')
    const source = String(msg.source || '')
    if (!entry || !source) throw new Error('插件宿主初始化缺少入口路径或源码')
    assertSourcePolicy(source, entry)
    const m: CachedModule = { exports: {} }
    const factory = new HostFunction('require', 'module', 'exports', '__filename', '__dirname', source)
    factory(requireBare, m, m.exports, entry, path.dirname(entry))
    mod = m.exports
    if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
      throw new Error('插件入口必须导出对象（module.exports = { ... }）')
    }
    if (rootDir) cacheSet(entry, m)
    parentPort.postMessage({ type: 'ready', reqId: msg.reqId, ok: true, exports: encode(mod, [], new Set()) })
  } catch (e) {
    parentPort.postMessage({ type: 'ready', reqId: msg.reqId, ok: false, error: errText(e) })
  }
}

async function handleInvoke (msg: HostMessage): Promise<void> {
  try {
    const pathSegs = Array.isArray(msg.path) ? msg.path.map(String) : []
    const { fn, owner } = resolveTarget(pathSegs)
    if (typeof fn !== 'function') {
      throw new Error(`插件未导出方法：${pathSegs.join('.')}`)
    }
    const args = (msg.args || []).map(decode)
    const out = await fn.apply(owner, args)
    replyResult(msg.reqId, true, encode(out, [], new Set()), null)
  } catch (e) {
    replyResult(msg.reqId, false, null, errText(e))
  }
}

function handleCallResult (msg: HostMessage): void {
  const reqId = String(msg.reqId || '')
  const p = pending.get(reqId)
  if (!p) return
  pending.delete(reqId)
  clearTimeout(p.timer)
  if (msg.ok) p.resolve(decode(msg.value))
  else p.reject(new Error(errText(msg.error || '宿主能力调用失败')))
}

parentPort.on('message', (event) => {
  const raw = event && event.data
  if (!isRecord(raw)) return
  const msg = raw as HostMessage
  switch (msg.type) {
    case 'init': handleInit(msg); break
    case 'invoke': handleInvoke(msg); break
    case 'call-result': handleCallResult(msg); break
    case 'dispose': process.exit(0); break
    default: break
  }
})

// 宿主进程自己出错也不能把主进程拖下水 —— 报错后退出，主进程按崩溃处理。
process.on('uncaughtException', (e) => {
  try { parentPort.postMessage({ type: 'log', level: 'error', message: `未捕获异常：${errText(e)}` }) } catch (_) {}
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  try { parentPort.postMessage({ type: 'log', level: 'error', message: `未处理的 Promise 拒绝：${errText(e)}` }) } catch (_) {}
})
