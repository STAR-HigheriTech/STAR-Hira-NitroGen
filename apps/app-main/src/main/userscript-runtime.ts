/**
 * 用户脚本宿主运行时（main 进程）—— 只做两件「必须有特权」的事：
 *
 *   1. `@require` 取码：把脚本声明的前置库拉回本地，交给注入层**内联**执行
 *      （Tampermonkey 语义：`@require` 里的 `var` / `function` 对脚本可见）。
 *   2. `GM_xmlhttpRequest` 代理：页面侧只调 `window.__hiraGm.request`，
 *      真正的网络请求在这里发出。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么授权判定必须在这里（而不是页面 / preload）
 * ══════════════════════════════════════════════════════════════════════
 * 页面能伪造任何东西 —— 它可以把 `details` 里的字段、甚至自己声明"我是谁"都改成任意值。
 * 唯一可信的输入是 **IPC 发送方的页面 URL**（`event.senderFrame.url`，由 Electron 给出）。
 * 于是这里的判定链是：
 *
 *   发送方 URL → `resolveUserScripts()` 找出该页**该执行**的脚本
 *              → 其中是否存在一条同时满足
 *                  · `@grant GM_xmlhttpRequest`（`userScriptNeedsGmRequest`）
 *                  · `@connect` 放行目标域（`userScriptConnectAllows`）
 *
 * 缺任何一环都拒绝：**没有 `@connect` 就等于不允许**（与 Tampermonkey 同口径）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * `@require` 的缓存策略
 * ══════════════════════════════════════════════════════════════════════
 * 内存缓存（本轮进程）→ 磁盘缓存（跨重启，7 天）→ 网络。
 * 网络失败时**回落到过期的磁盘缓存**：用户脚本上一次能跑，这次断网也不该整页失效。
 * 同一 URL 的并发请求合并成一次（`inflightRequires`）—— 十个标签同时打开时
 * 不该对同一个 CDN 发十次。
 *
 * 本文件不解析脚本、不拼注入代码：那些是纯层 `shared-types/userscript.mjs` 的职责。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveNetFetch } from './net-clock'
import { assertSafeOutboundUrl, isBlockedHost } from '@hira-ng/infra-net-guard'
import {
  resolveUserScripts,
  userScriptNeedsGmRequest,
  userScriptConnectAllows,
  type normalizeUserScript
} from '@hira-ng/shared-types/src/userscript.mjs'

type UserScript = ReturnType<typeof normalizeUserScript>

/** `@require` 磁盘缓存的保鲜期（超过仍可用作网络失败时的回落）。 */
const REQUIRE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单个 `@require` 的体积上限（库文件；超过多半是取错了地址）。 */
const MAX_REQUIRE_BYTES = 2 * 1024 * 1024
/** 代理响应体上限 —— 超过直接判失败，不把几十 MB 塞进页面。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_REQUIRE_CACHE_ENTRIES = 256
const MAX_REQUIRE_CACHE_BYTES = 64 * 1024 * 1024
const MAX_DISK_REQUIRE_FILES = 512
const DISK_PRUNE_INTERVAL_WRITES = 32
const MAX_REDIRECTS = 5
const MAX_REQUEST_URL_CHARS = 8 * 1024
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_HEADER_BYTES = 64 * 1024
const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade'])
const DEFAULT_TIMEOUT_MS = 20000
const MAX_TIMEOUT_MS = 120000
/** 代理允许的方法（与 Tampermonkey 的常用集合一致）。 */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

export interface UserScriptRuntimeOptions {
  cacheDir?: string
  getScripts?(): unknown[]
  logger?: { warn?(...args: unknown[]): void; error?(...args: unknown[]): void }
}

export interface UserScriptGmRequest {
  url?: unknown
  method?: unknown
  timeout?: unknown
  headers?: unknown
  data?: unknown
}

interface UserScriptGmResult {
  ok: boolean
  error?: string
  timeout?: boolean
  status?: number
  statusText?: string
  responseHeaders?: Record<string, string>
  responseText?: string
  finalUrl?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createUserScriptRuntime (options: UserScriptRuntimeOptions = {}) {
  const cacheDir = String(options.cacheDir || '')
  const getScripts = typeof options.getScripts === 'function' ? options.getScripts : () => []
  const logger = options.logger || console
  const warn = (msg: string, ...rest: unknown[]): void => { logger.warn?.(`[userscript-runtime] ${msg}`, ...rest) }
  const fetchImpl = resolveNetFetch()

  /** url → { code, at }（本轮进程内的前置库缓存）。 */
  const memoryRequires = new Map<string, { code: string; at: number; size: number }>()
  let memoryRequireBytes = 0
  let diskWritesSincePrune = 0
  let diskPrune: Promise<void> | null = null
  /** url → Promise<string>（并发合并）。 */
  const inflightRequires = new Map<string, Promise<string>>()

  function cachePaths (url: unknown): { js: string; meta: string } {
    const hash = crypto.createHash('sha1').update(String(url)).digest('hex')
    return {
      js: path.join(cacheDir, `${hash}.js`),
      meta: path.join(cacheDir, `${hash}.json`)
    }
  }

  /** 读磁盘缓存（不存在 / 损坏 → null）。 */
  async function readDiskCache (url: string): Promise<{ code: string; at: number } | null> {
    if (!cacheDir) return null
    const p = cachePaths(url)
    try {
      const [jsStat, metaStat] = await Promise.all([fs.promises.stat(p.js), fs.promises.stat(p.meta)])
      if (jsStat.size > MAX_REQUIRE_BYTES || metaStat.size > 64 * 1024) return null
      const [metaText, code] = await Promise.all([
        fs.promises.readFile(p.meta, 'utf8'),
        fs.promises.readFile(p.js, 'utf8')
      ])
      const meta = JSON.parse(metaText) as { fetchedAt?: unknown }
      if (!code) return null
      return { code, at: Number(meta && meta.fetchedAt) || 0 }
    } catch (_) {
      return null
    }
  }

  function rememberRequire (url: string, code: string, at: number): void {
    const size = Buffer.byteLength(code, 'utf8')
    const previous = memoryRequires.get(url)
    if (previous) {
      memoryRequireBytes -= previous.size
      memoryRequires.delete(url)
    }
    memoryRequires.set(url, { code, at, size })
    memoryRequireBytes += size
    while (memoryRequires.size > MAX_REQUIRE_CACHE_ENTRIES || memoryRequireBytes > MAX_REQUIRE_CACHE_BYTES) {
      const oldest = memoryRequires.keys().next()
      if (oldest.done) break
      const evicted = memoryRequires.get(oldest.value)
      if (evicted) memoryRequireBytes -= evicted.size
      memoryRequires.delete(oldest.value)
    }
    if (memoryRequireBytes < 0) memoryRequireBytes = 0
  }

  async function readTextCapped (res: Response, maxBytes: number): Promise<string> {
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new Error(`内容超过 ${Math.round(maxBytes / 1024)}KB 上限`)
    const reader = res.body?.getReader()
    if (!reader) {
      const text = await res.text()
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`内容超过 ${Math.round(maxBytes / 1024)}KB 上限`)
      return text
    }
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          try { await reader.cancel() } catch (_) {}
          throw new Error(`内容超过 ${Math.round(maxBytes / 1024)}KB 上限`)
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      try { await reader.cancel() } catch (_) {}
      throw error
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }

  async function writeDiskCache (url: string, code: string): Promise<void> {
    if (!cacheDir) return
    const p = cachePaths(url)
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true })
      await fs.promises.writeFile(p.js, code, 'utf8')
      await fs.promises.writeFile(p.meta, JSON.stringify({ url, fetchedAt: Date.now() }), 'utf8')
      diskWritesSincePrune += 1
      if (diskWritesSincePrune >= DISK_PRUNE_INTERVAL_WRITES) {
        diskWritesSincePrune = 0
        void pruneDiskCache()
      }
    } catch (e) {
      warn('写入 @require 缓存失败（不影响本次执行）：', errorMessage(e))
    }
  }

  /** Bound the on-disk @require cache as well as the in-memory LRU. */
  function pruneDiskCache (): Promise<void> {
    if (!cacheDir) return Promise.resolve()
    if (diskPrune) return diskPrune
    diskPrune = (async () => {
      let entries
      try {
        entries = await fs.promises.readdir(cacheDir, { withFileTypes: true })
      } catch (_) {
        return
      }
      const scripts = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      if (scripts.length <= MAX_DISK_REQUIRE_FILES) return
      const stamped = await Promise.all(scripts.map(async (entry) => {
        const full = path.join(cacheDir, entry.name)
        try {
          const stat = await fs.promises.stat(full)
          return { full, mtimeMs: stat.mtimeMs }
        } catch (_) {
          return null
        }
      }))
      const ordered = stamped.filter((item): item is { full: string; mtimeMs: number } => item !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      await Promise.all(ordered.slice(MAX_DISK_REQUIRE_FILES).flatMap((item) => {
        const base = item.full.slice(0, -3)
        return [fs.promises.rm(item.full, { force: true }), fs.promises.rm(`${base}.json`, { force: true })]
      }))
    })().catch((error) => {
      warn('清理 @require 磁盘缓存失败：', errorMessage(error))
    }).finally(() => {
      diskPrune = null
    })
    return diskPrune
  }

  /**
   * 拉一段文本（带超时与体积上限）。
   * @param {string} url
   * @param {{ timeoutMs?: number, maxBytes?: number }} [opts]
   */
  async function fetchText (url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
    if (!fetchImpl) throw new Error('当前环境没有可用的网络实现')
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_REQUIRE_BYTES
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch (_) {} }, timeoutMs)
    try {
      let current = url
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const verdict = await assertSafeOutboundUrl(current)
        if (!verdict.ok) throw new Error(`@require 地址不允许访问：${verdict.reason}`)
        const res = await fetchImpl(verdict.url, { signal: controller.signal, redirect: 'manual' })
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location')
          try { await res.body?.cancel() } catch (_) {}
          if (!location) throw new Error(`HTTP ${res.status}`)
          current = new URL(location, verdict.url).href
          continue
        }
        if (!res.ok) {
          try { await res.body?.cancel() } catch (_) {}
          throw new Error(`HTTP ${res.status}`)
        }
        return await readTextCapped(res, maxBytes)
      }
      throw new Error('@require 重定向次数过多')
    } finally {
      clearTimeout(timer)
    }
  }

  /** 取一个 `@require`（内存 → 网络/磁盘）。取不到返回空串（脚本仍会跑）。 */
  async function loadOneRequire (rawUrl: unknown): Promise<string> {
    const url = String(rawUrl || '').trim()
    if (!/^https?:\/\//i.test(url)) return ''
    const hit = memoryRequires.get(url)
    if (hit && Date.now() - (hit.at || 0) < REQUIRE_TTL_MS) return hit.code
    const pending = inflightRequires.get(url)
    if (pending) return pending

    const task = (async () => {
      try {
        const code = await fetchText(url, { timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: MAX_REQUIRE_BYTES })
        rememberRequire(url, code, Date.now())
        await writeDiskCache(url, code)
        return code
      } catch (e) {
        warn(`@require 拉取失败（${url}）：`, errorMessage(e))
        // 断网 / CDN 抽风：回落到上一次成功的缓存，别让整条脚本凭空失效。
        const stale = await readDiskCache(url)
        if (stale && stale.code) {
          rememberRequire(url, stale.code, stale.at)
          return stale.code
        }
        return ''
      } finally {
        inflightRequires.delete(url)
      }
    })()
    inflightRequires.set(url, task)
    return task
  }

  /**
   * 取一个脚本声明的全部 `@require`（保持声明顺序，失败的条目被过滤）。
   * @param {{ require?: string[] }} script
   * @returns {Promise<string[]>}
   */
  async function loadRequires (script: Pick<UserScript, 'require'> | null | undefined): Promise<string[]> {
    const list = script && Array.isArray(script.require) ? script.require : []
    if (!list.length) return []
    const codes = await Promise.all(list.map((url) => loadOneRequire(url)))
    return codes.filter((code) => typeof code === 'string' && code.trim())
  }

  function clampTimeout (raw: unknown): number {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
    return Math.min(Math.max(n, 1000), MAX_TIMEOUT_MS)
  }

  function hasExplicitPrivateTarget (script: UserScript, targetUrl: string, pageUrl: string): boolean {
    let host = ''
    try { host = new URL(targetUrl).hostname } catch (_) { return false }
    if (!isBlockedHost(host)) return false
    const entries = Array.isArray(script.connect) ? script.connect : []
    return entries.some((entry) => {
      const raw = String(entry || '').trim().toLowerCase()
      if (!raw || raw === '*' || raw === 'self' || raw.includes('*')) return false
      return userScriptConnectAllows({ connect: [raw] }, targetUrl, pageUrl)
    })
  }

  /**
   * `GM_xmlhttpRequest` 代理 —— IPC handler 的唯一实现。
   *
   * @param {string} senderUrl 发送方页面的 URL（**唯一可信的授权输入**）
   * @param {any} payload 页面侧传上来的请求描述
   * @returns {Promise<object>}
   */
  async function handleRequest (senderUrl: unknown, payload: UserScriptGmRequest = {}): Promise<UserScriptGmResult> {
    const url = String((payload && payload.url) || '')
    if (url.length > MAX_REQUEST_URL_CHARS) return { ok: false, error: 'URL 过长' }
    let target
    try { target = new URL(url) } catch (_) { return { ok: false, error: 'URL 非法' } }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { ok: false, error: 'GM_xmlhttpRequest 只允许 http / https' }
    }
    if (target.username || target.password) return { ok: false, error: 'URL 不能包含凭据' }
    const method = String((payload && payload.method) || 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) return { ok: false, error: `不支持的方法：${method}` }

    let scripts: unknown[] = []
    try { scripts = getScripts() } catch (_) { scripts = [] }
    const pageUrl = String(senderUrl || '')
    const matched = resolveUserScripts({ scripts: Array.isArray(scripts) ? scripts : [], url: pageUrl })
    const allowed = matched.some(
      (script: UserScript) => userScriptNeedsGmRequest(script) && userScriptConnectAllows(script, url, pageUrl)
    )
    if (!allowed) {
      return {
        ok: false,
        error: '请求未获授权：脚本需 @grant GM_xmlhttpRequest 且 @connect 放行该域名'
      }
    }
    if (!fetchImpl) return { ok: false, error: '当前环境没有可用的网络实现' }

    const timeoutMs = clampTimeout(payload && payload.timeout)
    const data = typeof payload.data === 'string' ? payload.data : ''
    if (Buffer.byteLength(data, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      return { ok: false, error: '请求体超过大小上限' }
    }
    const requestHeaders: Record<string, string> = {}
    let headerBytes = 0
    if (payload.headers && typeof payload.headers === 'object' && !Array.isArray(payload.headers)) {
      for (const [key, value] of Object.entries(payload.headers as Record<string, unknown>)) {
        const name = String(key).trim()
        if (!name || /[\r\n:]/.test(name) || FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) continue
        const text = String(value ?? '')
        if (/[\r\n]/.test(text)) return { ok: false, error: '请求头包含非法换行' }
        headerBytes += Buffer.byteLength(name + text, 'utf8')
        if (headerBytes > MAX_REQUEST_HEADER_BYTES) return { ok: false, error: '请求头超过大小上限' }
        requestHeaders[name] = text
      }
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { controller.abort() } catch (_) {}
    }, timeoutMs)
    try {
      const init: RequestInit & { body?: string } = {
        method,
        headers: requestHeaders,
        signal: controller.signal,
        redirect: 'manual'
      }
      if (data && method !== 'GET' && method !== 'HEAD') init.body = data
      let currentUrl = url
      let res: Response | null = null
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const hopScripts = matched.filter(
          (script: UserScript) => userScriptNeedsGmRequest(script) && userScriptConnectAllows(script, currentUrl, pageUrl)
        )
        if (!hopScripts.length) return { ok: false, error: `重定向目标未获 @connect 授权：${currentUrl}` }
        const verdict = await assertSafeOutboundUrl(currentUrl)
        if (!verdict.ok && !hopScripts.some((script: UserScript) => hasExplicitPrivateTarget(script, currentUrl, pageUrl))) {
          return { ok: false, error: `目标地址不允许访问：${verdict.reason}` }
        }
        const requestUrl = verdict.ok ? verdict.url : currentUrl
        const response = await fetchImpl(requestUrl, init)
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          res = response
          break
        }
        const location = response.headers.get('location')
        try { await response.body?.cancel() } catch (_) {}
        if (!location) return { ok: false, status: response.status, error: '重定向缺少 Location' }
        currentUrl = new URL(location, requestUrl).href
      }
      if (!res) return { ok: false, error: '重定向次数过多' }
      const responseText = await readTextCapped(res, MAX_RESPONSE_BYTES)
      const responseHeaders: Record<string, string> = {}
      try {
        for (const [key, value] of res.headers.entries()) responseHeaders[key] = String(value)
      } catch (_) {}
      return {
        ok: true,
        status: res.status,
        statusText: res.statusText || '',
        responseHeaders,
        responseText,
        finalUrl: res.url || currentUrl
      }
    } catch (e) {
      if (timedOut) return { ok: false, timeout: true, error: `请求超时（${timeoutMs}ms）` }
      return { ok: false, error: errorMessage(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  if (cacheDir) setTimeout(() => { void pruneDiskCache() }, 30_000).unref?.()

  return { loadRequires, handleRequest }
}
