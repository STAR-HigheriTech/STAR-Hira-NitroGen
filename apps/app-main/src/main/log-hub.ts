// @ts-check
/**
 * 日志中心（Log Hub）—— 浏览器运行日志的**唯一采集与查询入口**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它解决的问题
 * ══════════════════════════════════════════════════════════════════════
 * 以前主进程的 console 只往终端吐，页面里的 console 只有 `HIRA_UI_SHELL_DEBUG=1`
 * 时才跨进程打一行 —— AI 与任何界面都**查不到**"刚才发生了什么"。
 * 本模块把这些散落的输出收进一个固定容量的环形缓冲，并给出一条可过滤的查询面。
 *
 * 采集面（全部是"只观察、不改行为"）：
 *   · 主进程 console.log / info / warn / error / debug / trace（就地包一层）
 *   · 每个 webContents 的 console-message（兼容 Electron 新旧两种签名）
 *   · 页面加载失败 / 渲染进程退出 / 无响应 / preload 报错
 *   · app 级 `web-contents-created`（新窗口 / 标签 / 扩展后台页自动纳管）
 *   · `child-process-gone`（GPU / utility 进程崩溃）
 *
 * 三条纪律：
 *   1. **绝不抛错** —— 采集链路上的任何异常都吞掉：日志系统本身不能拖垮浏览器；
 *   2. **绝不会递归** —— 缓冲写入不调用 console；
 *   3. **固定内存** —— 环形数组 + 单条截断，容量上限 20000 条。
 */

import { format } from 'node:util'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  seq: number
  at: number
  level: LogLevel
  source: string
  scope: string
  message: string
  url: string
  line: number | null
  extra?: Record<string, string | number | boolean | null>
}

export interface LogInput {
  level?: unknown
  source?: unknown
  scope?: unknown
  message?: unknown
  url?: unknown
  line?: unknown
  extra?: unknown
  at?: unknown
}

export interface LogQuery {
  level?: string
  source?: string
  scope?: string
  contains?: string
  since?: number
  until?: number
  limit?: number
}

export interface LogQueryResult {
  total: number
  size: number
  capacity: number
  items: LogRecord[]
}

export interface LogStats {
  size: number
  capacity: number
  seq: number
  oldestAt: number
  newestAt: number
  byLevel: Record<string, number>
  bySource: Record<string, number>
}

interface WebContentsPort {
  getURL?(): string
  getType?(): string
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

interface AppPort {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/** 级别从低到高（`query` 的 `level` 表示"该级别及以上"）。 */
export const LEVELS: readonly LogLevel[] = Object.freeze(['trace', 'debug', 'info', 'warn', 'error'] as const)

const LEVEL_RANK = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 })

/** 单条消息上限：再长的堆栈对模型没有额外价值，只会撑爆上下文。 */
const MAX_MESSAGE = 4000

/** 额外字段只保留浅层可序列化值（Electron 对象过不了结构化克隆）。 */
const MAX_EXTRA_KEYS = 12

/**
 * @param {any} value
 * @returns {string}
 */
function rankOf(value: unknown): number {
  const level = normalizeLevel(value)
  return LEVEL_RANK[level] || LEVEL_RANK.info
}

/**
 * 把各来源的级别写法归一到五档。
 * 兼容：Electron 旧数字签名（0 verbose / 1 info / 2 warning / 3 error）、
 * Chromium 字符串（'verbose' / 'warning'）、Node 的 'log'。
 * @param {any} value
 * @returns {'trace'|'debug'|'info'|'warn'|'error'}
 */
export function normalizeLevel(value: unknown): LogLevel {
  if (typeof value === 'number') {
    if (value >= 3) return 'error'
    if (value === 2) return 'warn'
    if (value === 0) return 'debug'
    return 'info'
  }
  const s = String(value == null ? '' : value).trim().toLowerCase()
  if (s === 'warning' || s === 'warn') return 'warn'
  if (s === 'error' || s === 'fatal') return 'error'
  if (s === 'trace') return 'trace'
  if (s === 'debug' || s === 'verbose' || s === 'log') return 'debug'
  return 'info'
}

/** @param {string} text @param {number} max */
function truncate(text: unknown, max: number): string {
  const s = String(text == null ? '' : text)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * console 参数 → 一行文本（沿用 Node 的格式化规则：对象会被 inspect）。
 * @param {any[]} args
 * @returns {string}
 */
function formatArgs(args: readonly unknown[]): string {
  try {
    return truncate(format(...args), MAX_MESSAGE)
  } catch (_) {
    try {
      return truncate(args.map((a) => String(a)).join(' '), MAX_MESSAGE)
    } catch (_) {
      return '(无法格式化的日志参数)'
    }
  }
}

/**
 * 额外上下文：只保留字符串 / 数字 / 布尔 / null，最多 12 个键。
 * 对象与数组先 JSON 序列化再截断 —— 保证是纯数据，且不把循环引用带进缓冲。
 * @param {any} extra
 * @returns {Record<string, any>|undefined}
 */
function sanitizeExtra(extra: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!extra || typeof extra !== 'object') return undefined
  const out: Record<string, string | number | boolean | null> = {}
  let count = 0
  for (const key of Object.keys(extra)) {
    if (count >= MAX_EXTRA_KEYS) break
    const value = (extra as Record<string, unknown>)[key]
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = typeof value === 'string' ? truncate(value, 400) : value
      count++
      continue
    }
    if (value === undefined) continue
    try {
      out[key] = truncate(JSON.stringify(value), 400)
      count++
    } catch (_) {
      /* 循环引用 / 不可序列化：直接丢弃该键 */
    }
  }
  return count ? out : undefined
}

/** @param {any} wc */
function pageUrlOf(wc: WebContentsPort): string {
  try {
    return typeof wc.getURL === 'function' ? String(wc.getURL() || '') : ''
  } catch (_) {
    return ''
  }
}

/**
 * 页面 console-message 的新旧签名归一化。
 *
 * Electron 32+：`(event)`，event = { level, message, lineNumber, sourceId }
 * 旧版：`(event, level, message, line, sourceId)`
 * @returns {{ level: string, message: string, line: number|null, sourceId: string }|null}
 */
function readConsoleEvent(event: unknown, level: unknown, message: unknown, line: unknown, sourceId: unknown) : { level: string, message: string, line: number|null, sourceId: string }|null {
  const record = event && typeof event === 'object' ? event as Record<string, unknown> : null
  if (record && typeof record.message === 'string' && record.level !== undefined) {
    return {
      level: normalizeLevel(record.level),
      message: String(record.message),
      line: Number.isFinite(record.lineNumber) ? Number(record.lineNumber) : null,
      sourceId: String(record.sourceId || '')
    }
  }
  if (typeof message === 'string') {
    return {
      level: normalizeLevel(level),
      message,
      line: Number.isFinite(line) ? Number(line) : null,
      sourceId: String(sourceId || '')
    }
  }
  return null
}

/**
 * @param {{ capacity?: number }} [options]
 */
export function createLogHub(options: { capacity?: number } = {}) {
  const capacity = Math.max(50, Math.min(20000, Number(options.capacity) || 2000))

  const slots = new Array<LogRecord | undefined>(capacity)
  let head = 0
  let size = 0
  let seq = 0

  const listeners = new Set<(record: LogRecord) => void>()
  /** @type {Array<() => void>} */
  const detachers: Array<() => void> = []

  /**
   * 记一条日志。**这是唯一写入口**，任何采集面都走它。
   * @param {{ level?: any, source?: string, scope?: string, message?: any, url?: string, line?: number|null, extra?: any, at?: number }|string} input
   */
  function push(input: LogInput | string): LogRecord {
    const raw: LogInput = input && typeof input === 'object' ? input : { message: input }
    const record: LogRecord = {
      seq: ++seq,
      at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now(),
      level: normalizeLevel(raw.level),
      source: String(raw.source || 'main'),
      scope: raw.scope ? String(raw.scope) : '',
      message: truncate(String(raw.message == null ? '' : raw.message), MAX_MESSAGE),
      url: raw.url ? truncate(String(raw.url), 1000) : '',
      line: typeof raw.line === 'number' && Number.isFinite(raw.line) ? raw.line : null,
      extra: sanitizeExtra(raw.extra)
    }
    slots[head] = record
    head = (head + 1) % capacity
    if (size < capacity) size++
    for (const fn of listeners) {
      try { fn(record) } catch (_) { /* 订阅者异常不影响写路径 */ }
    }
    return record
  }

  /**
   * 按条件取最近的日志（时间正序返回）。
   * @param {{
   *   level?: string, source?: string, scope?: string, contains?: string,
   *   since?: number, until?: number, limit?: number
   * }} [filter]
   */
  function query(filter: LogQuery = {}): LogQueryResult {
    const limit = Math.max(1, Math.min(1000, Number(filter.limit) || 100))
    const minRank = filter.level ? rankOf(filter.level) : 0
    const source = filter.source ? String(filter.source) : ''
    const scope = filter.scope ? String(filter.scope) : ''
    const needle = filter.contains ? String(filter.contains).toLowerCase() : ''
    const since = typeof filter.since === 'number' && Number.isFinite(filter.since) ? filter.since : 0
    const until = typeof filter.until === 'number' && Number.isFinite(filter.until) ? filter.until : 0

    const matches: LogRecord[] = []
    for (let i = 0; i < size; i++) {
      const index = (head - size + i + capacity) % capacity
      const record = slots[index]
      if (!record) continue
      if (minRank && rankOf(record.level) < minRank) continue
      if (source && record.source !== source) continue
      if (scope && record.scope !== scope) continue
      if (since && record.at < since) continue
      if (until && record.at > until) continue
      if (needle && !`${record.message} ${record.url}`.toLowerCase().includes(needle)) continue
      matches.push(record)
    }
    return {
      total: matches.length,
      size,
      capacity,
      items: matches.slice(-limit)
    }
  }

  /** 当前缓冲的分布摘要（级别 / 来源 / 时间跨度）。 */
  function stats(): LogStats {
    const byLevel = { trace: 0, debug: 0, info: 0, warn: 0, error: 0 }
    const bySource: Record<string, number> = {}
    let oldestAt = 0
    let newestAt = 0
    for (let i = 0; i < size; i++) {
      const index = (head - size + i + capacity) % capacity
      const record = slots[index]
      if (!record) continue
      byLevel[record.level] = (byLevel[record.level] || 0) + 1
      bySource[record.source] = (bySource[record.source] || 0) + 1
      if (!oldestAt || record.at < oldestAt) oldestAt = record.at
      if (record.at > newestAt) newestAt = record.at
    }
    return { size, capacity, seq, oldestAt, newestAt, byLevel, bySource }
  }

  /** 清空缓冲（容量与订阅者保留）。 */
  function clear(): void {
    for (let i = 0; i < capacity; i++) slots[i] = undefined
    head = 0
    size = 0
  }

  /** 订阅新日志（供未来的日志面板 / 实时输出使用）。@returns {() => void} */
  function subscribe(fn: unknown): () => void {
    if (typeof fn !== 'function') return () => {}
    const listener = fn as (record: LogRecord) => void
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /**
   * 就地包裹主进程 console，把每条输出同时写进缓冲。
   * 返回还原函数（测试 / 热重载用）。
   * @param {Console} [target]
   */
  function attachConsole(target: Console = console): () => void {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
    const restore: Array<() => void> = []
    for (const method of methods) {
      const original = target[method]
      if (typeof original !== 'function') continue
      const level = method === 'log' ? 'info' : method
      const patched = function patchedConsoleLog(...args: unknown[]): unknown {
        try { push({ level, source: 'main', message: formatArgs(args) }) } catch (_) { /* 采集绝不抛错 */ }
        return Reflect.apply(original, target, args)
      }
      Reflect.set(target, method, patched)
      restore.push(() => {
        if (Reflect.get(target, method) === patched) Reflect.set(target, method, original)
      })
    }
    const detach = (): void => {
      while (restore.length) {
        const undo = restore.pop()
        try { undo?.() } catch (_) {}
      }
    }
    detachers.push(detach)
    return detach
  }

  /** 已纳管的 webContents（避免同一条被 attach 两次）。 */
  const attached = new WeakSet<WebContentsPort>()

  /**
   * 纳管一个 webContents：console / 加载失败 / 渲染进程退出 / preload 报错。
   * @param {any} wc
   * @param {{ source?: string, scope?: string }} [meta]
   * @returns {() => void} 解除纳管
   */
  function attachWebContents(wc: WebContentsPort | null | undefined, meta: { source?: string; scope?: string } = {}): () => void {
    if (!wc || typeof wc.on !== 'function') return () => {}
    if (attached.has(wc)) return () => {}
    attached.add(wc)

    let type = ''
    try { type = typeof wc.getType === 'function' ? String(wc.getType() || '') : '' } catch (_) { type = '' }
    const source = String(meta.source || type || 'webcontents')
    const fixedScope = meta.scope ? String(meta.scope) : ''
    const scopeOf = () => fixedScope || pageUrlOf(wc)

    const handlers: Array<[string, (...args: unknown[]) => void]> = []
    const on = (event: string, fn: (...args: unknown[]) => void): void => {
      try {
        wc.on(event, fn)
        handlers.push([event, fn])
      } catch (_) { /* 事件名在当前 Electron 版本不存在：忽略 */ }
    }

    on('console-message', (event, level, message, line, sourceId) => {
      const info = readConsoleEvent(event, level, message, line, sourceId)
      if (!info) return
      const url = pageUrlOf(wc)
      push({
        level: info.level,
        source,
        scope: scopeOf(),
        message: info.message,
        url,
        line: info.line,
        extra: info.sourceId && info.sourceId !== url ? { sourceId: info.sourceId } : undefined
      })
    })

    on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      push({
        level: 'error',
        source: 'navigation',
        scope: scopeOf(),
        message: `页面加载失败 ${errorCode} ${errorDescription || ''}`.trim(),
        url: String(validatedURL || ''),
        extra: { errorCode, errorDescription, isMainFrame: !!isMainFrame }
      })
    })

    on('render-process-gone', (_event, details) => {
      const detailRecord = details && typeof details === 'object' ? details as Record<string, unknown> : {}
      push({
        level: 'error',
        source: 'renderer',
        scope: scopeOf(),
        message: `渲染进程退出：${detailRecord.reason || 'unknown'}`,
        url: pageUrlOf(wc),
        extra: details
      })
    })

    on('preload-error', (_event, preloadPath, error) => {
      const errorRecord = error && typeof error === 'object' ? error as Record<string, unknown> : {}
      push({
        level: 'error',
        source: 'preload',
        scope: scopeOf(),
        message: `preload 执行失败：${errorRecord.message || '未知错误'}`,
        url: pageUrlOf(wc),
        extra: { preloadPath }
      })
    })

    on('unresponsive', () => {
      push({ level: 'warn', source: 'renderer', scope: scopeOf(), message: '页面无响应', url: pageUrlOf(wc) })
    })

    on('responsive', () => {
      push({ level: 'info', source: 'renderer', scope: scopeOf(), message: '页面恢复响应', url: pageUrlOf(wc) })
    })

    let detach = (): void => {}
    const onDestroyed = (): void => detach()
    detach = () => {
      for (const [event, fn] of handlers) {
        try { wc.removeListener(event, fn) } catch (_) {}
      }
      handlers.length = 0
      try { wc.removeListener('destroyed', onDestroyed) } catch (_) {}
      attached.delete(wc)
      const index = detachers.indexOf(detach)
      if (index >= 0) detachers.splice(index, 1)
    }
    try {
      if (typeof wc.once === 'function') wc.once('destroyed', onDestroyed)
      else wc.on('destroyed', onDestroyed)
    } catch (_) {}
    detachers.push(detach)
    return detach
  }

  /**
   * 纳管 app：新窗口 / 标签 / 扩展后台页一出现就自动接上，外加子进程崩溃。
   * 必须在任何窗口创建之前调用（main.js 模块加载期）。
   * @param {any} app
   * @returns {() => void}
   */
  function attachApp(app: AppPort | null | undefined): () => void {
    if (!app || typeof app.on !== 'function') return () => {}
    const handlers: Array<[string, (...args: unknown[]) => void]> = []

    const onCreated = (_event: unknown, wc: unknown): void => {
      try {
        attachWebContents(wc as WebContentsPort, {})
      } catch (_) { /* 纳管失败不影响窗口创建 */ }
    }
    try { app.on('web-contents-created', onCreated); handlers.push(['web-contents-created', onCreated]) } catch (_) {}

    const onChildGone = (_event: unknown, details: unknown): void => {
      const detailRecord = details && typeof details === 'object' ? details as Record<string, unknown> : {}
      push({
        level: 'error',
        source: 'process',
        message: `子进程退出：${detailRecord.type || 'unknown'} ${detailRecord.reason || ''}`.trim(),
        extra: details
      })
    }
    try { app.on('child-process-gone', onChildGone); handlers.push(['child-process-gone', onChildGone]) } catch (_) {}

    const detach = () => {
      for (const [event, fn] of handlers) {
        try { app.removeListener(event, fn) } catch (_) {}
      }
      handlers.length = 0
    }
    detachers.push(detach)
    return detach
  }

  /** 解除全部采集（还原 console、摘掉所有监听）。 */
  function dispose(): void {
    while (detachers.length) {
      const detach = detachers.pop()
      try { detach?.() } catch (_) {}
    }
    listeners.clear()
  }

  return {
    push,
    query,
    stats,
    clear,
    subscribe,
    attachConsole,
    attachWebContents,
    attachApp,
    dispose,
    capacity
  }
}

