// @ts-check
/**
 * 插件源（社区市场的**索引那一半**）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它补的是哪一段
 * ══════════════════════════════════════════════════════════════════════
 * 上一轮把「安装」做通了：目录 / zip / 覆盖 / 卸载 / 验签。但那是**手动**安装 ——
 * 用户得自己找到插件、下下来、再点"从压缩包安装"。所谓"市场"缺的正是中间那一段：
 *   一个**索引**（有哪些插件、最新版本、包在哪）+ 一键安装/更新。
 *
 * 索引就是一个静态 JSON（任何静态托管都能放），所以这一层**不需要服务端**：
 * 作者把 `index.json` 和若干 zip 丢上去，用户填一个地址就能用。
 *
 * **支持多个源**（`plugins.marketSources`，一个字符串数组），并发的、互相独立的：
 *   · 一条源失败**只影响它自己** —— 一个源自挂掉不该让整个插件中心空掉；
 *   · **顺序即优先级**：同一个 id 在多个源里出现时靠前的胜出（并回报 `duplicates`，
 *     静默取第一个会让人以为另一个源根本没生效）；
 *   · 每个源单独回报状态（`sources[]`），界面上能指出"坏的是哪个"。
 *
 * ```json
 * {
 *   "schema": 1,
 *   "name": "示例插件源",
 *   "plugins": [
 *     { "id": "acme-demo", "name": "Acme 演示插件", "version": "1.2.0",
 *       "description": "…", "author": "…", "homepage": "https://…",
 *       "url": "https://…/acme-demo-1.2.0.zip",
 *       "sha256": "…" }
 *   ]
 * }
 * ```
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个模块**不做**的三件事（都很重要）
 * ══════════════════════════════════════════════════════════════════════
 * 1. **不绕过安装器的任何一道**。下载下来的包一律走 `installer.installArchive`
 *    —— 体检、撞名、zip-slip、扩展名白名单、签名，一个都不少。
 *    "从市场装的"不是一种更可信的来源，只是更省事的来源。
 * 2. **不自动信任索引**。索引是**远端数据**，它给的 `id` / `url` 都要在入口处剪裁
 *    （id 必须过安装器同一套字符集，url 必须过协议白名单）。一个坏索引不该能让
 *    主进程去下载任意 URL 或让安装器处理怪 id。
 * 3. **不自动更新**。它只回答"有哪些更新可用"，装不装是用户点的。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么用全局 `fetch` 而不是 `electron.net`
 * ══════════════════════════════════════════════════════════════════════
 * `fetch` 在 Electron 主进程与纯 node 下**都有**。选它意味着这个模块可以在
 * 不启 Electron 的情况下被完整测掉（起一个本地 http 服务即可）——
 * 网络模块恰恰是最需要"能单独跑一遍"的那类代码：它的失败模式几乎全是
 * 「超时 / 重定向 / 巨大响应 / 形状不对」，而这些用桩去测是测不出来的。
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { isPluginId } from '@hira-ng/shared-types/src/plugin-id'
import { assertSafeOutboundUrl } from '@hira-ng/infra-net-guard'

type UnknownRecord = Record<string, unknown>

interface MarketEntry {
  id: string
  name: string
  version: string
  description: string
  author: string
  homepage: string
  url: string
  sha256: string
}

interface MarketSourceResult {
  ok: boolean
  source: string
  entries: MarketEntry[]
  name?: string
  reason?: string
  cached?: boolean
  skipped?: number
}

interface MarketInstallResult {
  ok: boolean
  id?: string
  version?: string
  name?: string
  reason?: string
  signature?: unknown
  warnings?: string[]
  verified?: boolean
}

interface InstallerPort {
  installArchive(path: string, options?: { overwrite?: boolean }): Promise<MarketInstallResult>
  listInstalled?(): string[]
}

interface MarketOptions {
  installer: InstallerPort
  getSources?: () => unknown
  setSources?: (sources: string[]) => unknown
  getLocalVersions?: () => Record<string, string>
  log?: (message: string, error?: unknown) => void
}

interface FetchOptions {
  force?: boolean
}

interface InstallOptions extends FetchOptions {
  overwrite?: boolean
}

interface CacheEntry {
  entries: MarketEntry[]
  name: string
  at: number
}

/** 索引里最多有多少条 —— 一个"插件源"不该有上万条，超了多半是选错了地址。 */
const MAX_ENTRIES = 500
/** 索引体积上限（远端数据，必须封顶）。 */
const MAX_INDEX_BYTES = 1024 * 1024
/** 单个包上限（与安装器的 64MB 一致：超了安装器也会拒，不如在下载时就断掉）。 */
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
/** 单次请求超时：一个卡住的源不该把插件中心的加载拖成"永远转圈"。 */
const TIMEOUT_MS = 15_000
/** 与安装器的 id 字符集**完全一致**（这里是入口剪裁，那边是落盘守卫，两处同一口径）。 */
function isRecord (value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function errorMessage (error: unknown): string {
  return isRecord(error) && error.message ? String(error.message) : String(error)
}

function isAbortError (error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError'
}

/**
 * 下载地址的协议白名单。
 *
 * `http:` 只放**回环地址**：本地自建源 / 端到端自测都需要它，而它到不了公网 ——
 * 于是"允许 http"不会变成"允许降级到明文"。公网一律 https。
 * @param {string} urlString
 * @returns {boolean}
 */
export function isAllowedUrl (urlString: unknown): boolean {
  let u: URL
  try {
    u = new URL(String(urlString || ''))
  } catch (_) {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') {
    const host = u.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  }
  return false
}

function isExplicitLoopback (urlString: string): boolean {
  try {
    const url = new URL(urlString)
    if (url.protocol !== 'http:') return false
    const host = url.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch (_) {
    return false
  }
}

async function assertMarketTarget (urlString: string, allowLoopback: boolean): Promise<string> {
  if (allowLoopback && isExplicitLoopback(urlString)) return urlString
  const verdict = await assertSafeOutboundUrl(urlString)
  if (!verdict.ok) throw new Error(`插件源地址不允许访问：${verdict.reason}`)
  return verdict.url
}

/** 带超时的 fetch，并手动逐跳校验重定向，避免可信源把请求引向内网。 */
async function fetchWithTimeout (url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  // The signal must stay alive after the headers arrive: a peer can send 200 and then
  // stall the body forever. AbortSignal.timeout covers redirects, headers and body reads.
  const signal = AbortSignal.timeout(timeoutMs)
  let current = url
  // Only a source the user explicitly configured as loopback may stay on loopback;
  // a public HTTPS source is never allowed to redirect into localhost.
  const allowLoopback = isExplicitLoopback(url)
  for (let hop = 0; hop <= 5; hop += 1) {
    current = await assertMarketTarget(current, allowLoopback)
    const response = await fetch(current, { ...init, signal, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    try { await response.body?.cancel() } catch (_) {}
    if (!location) throw new Error(`重定向缺少 Location（HTTP ${response.status}）`)
    current = new URL(location, current).href
  }
  throw new Error('重定向次数过多')
}

/** 把响应体读成 Buffer，**流式读取 + 封顶**（超限立刻断开，不把大响应吞进内存）。 */
async function readCapped (res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared && declared > maxBytes) {
    try { await res.body?.cancel() } catch (_) {}
    throw new Error(`响应过大（声明 ${declared} 字节，上限 ${maxBytes}）`)
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    return Buffer.alloc(0)
  }
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch (_) {}
        throw new Error(`响应过大（上限 ${maxBytes} 字节）`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try { reader.releaseLock() } catch (_) {}
  }
  return Buffer.concat(chunks)
}

/** 边下边写，同样封顶；返回写出的字节数。 */
async function writeCapped (res: Response, filePath: string, maxBytes: number): Promise<number> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared && declared > maxBytes) {
    try { await res.body?.cancel() } catch (_) {}
    throw new Error(`安装包过大（声明 ${declared} 字节，上限 ${maxBytes}）`)
  }
  const out = fs.createWriteStream(filePath)
  let rejectFailure: (error: Error) => void = () => {}
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject })
  failure.catch(() => {})
  let streamFailure: Error | null = null
  out.on('error', (error) => {
    streamFailure = error instanceof Error ? error : new Error(String(error))
    rejectFailure(streamFailure)
  })
  let total = 0
  try {
    const endOutput = (): Promise<void> => new Promise<void>((resolve, reject) => {
      out.end(() => {
        if (streamFailure) reject(streamFailure)
        else resolve()
      })
    })
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`安装包过大（上限 ${maxBytes} 字节）`)
      out.write(buf)
      await Promise.race([endOutput(), failure])
      return buf.length
    }
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch (_) {}
        throw new Error(`安装包过大（上限 ${maxBytes} 字节）`)
      }
      // 背压：写不下就等 drain，别把 64MB 全堆在内存里
      if (!out.write(Buffer.from(value))) {
        await Promise.race([
          new Promise<void>((resolve) => out.once('drain', resolve)),
          failure
        ])
      }
    }
    await Promise.race([endOutput(), failure])
    return total
  } catch (e) {
    try { out.destroy() } catch (_) {}
    throw e
  }
}

/**
 * 把索引里的**一条**剪裁成内部形状；不可用的返回 `null`（而不是抛）。
 *
 * 逐条隔离：一条坏条目不该让整个源"打不开" —— 那会让作者在几百条里找那一处笔误。
 * @param {unknown} raw
 * @param {string} baseUrl 索引自身的地址，用于解析相对 `url`
 */
export function normalizeEntry (raw: unknown, baseUrl: string): MarketEntry | null {
  if (!isRecord(raw)) return null
  const id = String(raw.id || '')
  if (!isPluginId(id)) return null
  let url = String(raw.url || '')
  if (url && baseUrl) {
    // 允许相对路径（作者写 `./pkgs/x.zip` 比写死域名更常见，也更不容易挂）
    try { url = new URL(url, baseUrl).href } catch (_) { return null }
  }
  if (!url || !isAllowedUrl(url)) return null
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
  return {
    id,
    name: String(raw.name || id),
    version: String(raw.version || ''),
    description: String(raw.description || ''),
    author: String(raw.author || ''),
    homepage: isAllowedUrl(raw.homepage) ? String(raw.homepage) : '',
    url,
    sha256: /^[0-9a-f]{64}$/.test(sha256) ? sha256 : ''
  }
}

/** 源数量上限：每个源都是一次出网，20 个已经远超正常需要（也拦住了"塞一堆源拖死刷新"）。 */
const MAX_SOURCES = 20

/**
 * 创建插件源（**多源聚合**）。
 *
 * @param {{
 *   installer: { installArchive: (p: string, o?: { overwrite?: boolean }) => Promise<MarketInstallResult>, listInstalled: () => string[] },
 *   getSources: () => string[],
 *   setSources: (list: string[]) => string[]|null,
 *   getLocalVersions: () => Record<string, string>,
 *   log?: (msg: string, err?: unknown) => void
 * }} options
 */
function createPluginMarket (options: MarketOptions) {
  const installer = options.installer
  const getSources = typeof options.getSources === 'function' ? options.getSources : (): unknown => []
  const setSourcesPort = typeof options.setSources === 'function' ? options.setSources : (): unknown => null
  /** 本地已装版本（`id → version`）。更新判定靠它，不靠"目录在不在"。 */
  const getLocalVersions = typeof options.getLocalVersions === 'function' ? options.getLocalVersions : (): Record<string, string> => ({})
  const log = typeof options.log === 'function' ? options.log : (): void => {}

  /**
   * 短期缓存，**按源分桶**（`url → { entries, name, at }`）。
   *
   * 为什么不是一个全局单槽：多个源各有各的刷新节奏，全局单槽会让"刷新 A"顺手把
   * B 的缓存也丢掉 —— 于是交替刷新时两边反复出网。分桶还让"移除某个源"能只作废它自己。
   */
  const cache = new Map<string, CacheEntry>()
  const CACHE_TTL_MS = 60_000

  /** 当前配置的源（去过空白）。去重由存储层保证（它在写入时归一化）。 */
  function currentSources (): string[] {
    const raw = getSources()
    return (Array.isArray(raw) ? raw : []).map((source) => String(source || '').trim()).filter(Boolean)
  }

  /**
   * 拉取并解析**一个**源的索引。
   * @param {string} source
   * @param {{ force?: boolean }} [opts]
   */
  async function fetchOneIndex (source: unknown, opts: FetchOptions = {}): Promise<MarketSourceResult> {
    const url = String(source || '').trim()
    if (!url) return { ok: false, source: '', entries: [], reason: '插件源地址为空' }
    if (!isAllowedUrl(url)) {
      return { ok: false, source: url, entries: [], reason: '插件源地址必须是 https://（本地调试可用 http://127.0.0.1）' }
    }
    const hit = cache.get(url)
    if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ok: true, source: url, entries: hit.entries, name: hit.name, cached: true }
    }

    let res
    try {
      res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } })
    } catch (e) {
      const msg = isAbortError(e) ? `请求超时（${TIMEOUT_MS / 1000}s）` : `无法连接：${errorMessage(e)}`
      return { ok: false, source: url, entries: [], reason: msg }
    }
    if (!res.ok) {
      try { await res.body?.cancel() } catch (_) {}
      return { ok: false, source: url, entries: [], reason: `插件源返回 ${res.status}` }
    }
    // 重定向后复核协议：跟到 http / file 上就等于绕过了那条白名单
    if (res.url && !isAllowedUrl(res.url)) {
      return { ok: false, source: url, entries: [], reason: '插件源被重定向到了不被允许的地址' }
    }

    let data: unknown
    try {
      const buf = await readCapped(res, MAX_INDEX_BYTES)
      data = JSON.parse(buf.toString('utf8'))
    } catch (e) {
      return { ok: false, source: url, entries: [], reason: `索引格式不对：${errorMessage(e)}` }
    }
    const rawList = isRecord(data) && Array.isArray(data.plugins) ? data.plugins : null
    if (!rawList) return { ok: false, source: url, entries: [], reason: '索引里没有 plugins 数组' }
    if (rawList.length > MAX_ENTRIES) {
      return { ok: false, source: url, entries: [], reason: `索引条目过多（${rawList.length}，上限 ${MAX_ENTRIES}）` }
    }

    const base = res.url || url
    const seen = new Set<string>()
    const entries: MarketEntry[] = []
    let skipped = 0
    for (const raw of rawList) {
      const entry = normalizeEntry(raw, base)
      if (!entry) { skipped += 1; continue }
      if (seen.has(entry.id)) { skipped += 1; continue }
      seen.add(entry.id)
      entries.push(entry)
    }
    if (skipped) log(`[market] ${url} 的索引里有 ${skipped} 条条目不可用（id/url 不合法或重复），已跳过`)

    const name = String((isRecord(data) && data.name) || '')
    cache.set(url, { entries, name, at: Date.now() })
    return { ok: true, source: url, entries, name, skipped }
  }

  /**
   * 聚合**全部**源。
   *
   * 两条关键语义：
   *   · **一条源失败只影响它自己**。这正是多源相对单源最大的好处 ——
   *     一个源自挂掉不该让整个插件中心空掉。所以每个源的状态单独回报，
   *     用户在界面上能看出"是哪个源坏了、坏在哪"，而不是笼统一句"插件源不可用"。
   *   · **同 id 冲突时靠前的源胜出**（顺序即优先级），并记 `duplicates`
   *     让界面能提示"这个 id 在别的源里也有" —— 静默取第一个会让人以为另一个源没生效。
   *
   * @param {{ force?: boolean }} [opts]
   */
  async function fetchIndex (opts: FetchOptions = {}) {
    const sources = currentSources()
    if (!sources.length) return { ok: false, sources: [], entries: [], duplicates: 0, reason: '还没有设置插件源' }
    const activeSources = new Set(sources)
    for (const key of Array.from(cache.keys())) {
      if (!activeSources.has(key)) cache.delete(key)
    }

    const settled = await Promise.all(sources.map((s) => fetchOneIndex(s, opts)))
    const seen = new Set<string>()
    const entries: Array<MarketEntry & { sourceUrl: string; sourceName: string }> = []
    let duplicates = 0
    for (const res of settled) {
      for (const e of res.entries || []) {
        if (seen.has(e.id)) { duplicates += 1; continue }
        seen.add(e.id)
        // 带上来源：同 id 在多源出现时，用户需要知道"装的是哪个源的包"
        entries.push({ ...e, sourceUrl: res.source, sourceName: res.name || '' })
      }
    }
    const report = settled.map((r) => ({
      url: r.source,
      ok: !!r.ok,
      name: r.name || '',
      reason: r.reason || '',
      cached: !!r.cached,
      skipped: r.skipped || 0,
      count: (r.entries || []).length
    }))
    const anyOk = settled.some((r) => r.ok)
    const failed = settled.filter((r) => !r.ok && r.reason)
    return {
      ok: anyOk,
      sources: report,
      entries,
      duplicates,
      /**
       * 顶层 `reason` 只在**一条源都没成功**时给（那时它是逐条原因的汇总）。
       *
       * 为什么要有它：不然"全挂了"这件事的可用信息只散在 `sources[]` 里，
       * 每个调用方（一键安装的兜底提示、CLI、验证脚本）都得自己拼一遍 ——
       * 而漏拼的表现是用户看到一句没有信息量的"插件源不可用"。
       * 只要有**一条**成功就**不给**顶层原因：那不是错误状态，逐条原因已经在 sources 里。
       */
      reason: anyOk ? undefined : (failed.map((r) => `${r.source}：${r.reason}`).join('；') || '插件源不可用')
    }
  }

  /**
   * 拉索引 + **合并本地安装态**。UI 直接渲染这个结果，不必自己算"是不是已装 / 有没有更新"。
   *
   * 版本比较刻意做成**简单字符串不等**而不是 semver 比较：这里的两个版本号来自
   * 本地 manifest 与远端索引，格式由作者决定；用 semver 规则去比一个非 semver 字符串
   * 会得出"永远有更新"或"永远没更新"这类静默错误。字符串不等至少是**可解释**的
   * （"版本号变了就提示你更新"），代价是作者随便改个后缀也会提示一次 —— 那正是他想要的。
   */
  async function query (opts: FetchOptions = {}) {
    const res = await fetchIndex(opts)
    const local = getLocalVersions() || {}
    const entries = (res.entries || []).map((e) => {
      const installedVersion = local[e.id] || ''
      return {
        ...e,
        installed: !!installedVersion,
        installedVersion,
        updateAvailable: !!installedVersion && !!e.version && installedVersion !== e.version
      }
    })
    return {
      ok: !!res.ok,
      sources: res.sources || [],
      duplicates: res.duplicates || 0,
      // 只在"一个源都没有"时才有值；源级原因在 sources[i].reason 里逐条给
      reason: res.reason,
      entries
    }
  }

  /**
   * 设置插件源列表。
   *
   * 分工：**这里只校验语义**（地址白名单 / 数量上限），归一化与持久化交给存储层
   * （`plugin-state-store` 在写入时就去空白、去重）—— 两边各写一份归一化必然漂移，
   * 而漂移的表现是"界面上看到的"和"实际存的"不一样。
   *
   * 缓存按 URL 分桶，所以**只作废被移除的那些**：保留的源在下次刷新时仍走缓存。
   */
  function setSources (list: unknown) {
    const next = (Array.isArray(list) ? list : []).map((s) => String(s || '').trim()).filter(Boolean)
    if (next.length > MAX_SOURCES) {
      return { ok: false, reason: `最多只能配 ${MAX_SOURCES} 个插件源` }
    }
    const bad = next.find((s) => !isAllowedUrl(s))
    if (bad) {
      return { ok: false, reason: `地址不被允许：${bad}（必须是 https://，本地调试可用 http://127.0.0.1）` }
    }
    let saved = null
    try {
      saved = setSourcesPort(next)
    } catch (e) {
      return { ok: false, reason: `保存失败：${errorMessage(e)}` }
    }
    if (!Array.isArray(saved)) return { ok: false, reason: '保存失败（存储层未就绪）' }
    for (const key of Array.from(cache.keys())) {
      if (!saved.includes(key)) cache.delete(key)
    }
    return { ok: true, sources: saved }
  }

  /**
   * 从源安装/更新一个插件。
   *
   * 顺序上**先下到临时文件、校验 sha256、再交给安装器**：
   *   · 临时文件在 `os.tmpdir()`（不在插件目录里），下载失败不会污染插件目录；
   *   · sha256 是索引对**字节**的承诺，校验失败直接丢弃 —— 这一步是"市场"相对
   *     "用户自己下载"唯一多出来的保证；
   *   · 交给安装器的仍然是一个**普通 zip 路径**，所以体检 / 撞名 / 穿越 / 签名照旧。
   *
   * @param {string} entryId
   * @param {{ overwrite?: boolean, force?: boolean }} [opts]
   */
  async function install (entryId: unknown, opts: InstallOptions = {}): Promise<MarketInstallResult> {
    const id = String(entryId || '')
    const list = await fetchIndex({ force: !!opts.force })
    if (!list.ok) {
      // 多源下"不可用"要能指出**是哪个源**：否则用户在界面上只会看到一句笼统的失败，
      // 而他配了 3 个源，根本不知道该动哪一个。
      const failed = (list.sources || []).filter((s) => !s.ok).map((s) => `${s.url}：${s.reason}`)
      return { ok: false, id, reason: list.reason || failed.join('；') || '插件源不可用' }
    }
    // 多源聚合后同 id 只保留靠前源的那一条，所以这里找到的就是"优先级最高"的那个包
    const entry = (list.entries || []).find((e) => e.id === id)
    if (!entry) return { ok: false, id, reason: `插件源里没有 ${id}` }

    let res
    try {
      res = await fetchWithTimeout(entry.url, { redirect: 'follow' })
    } catch (e) {
      const msg = isAbortError(e) ? `下载超时（${TIMEOUT_MS / 1000}s）` : `下载失败：${errorMessage(e)}`
      return { ok: false, id, version: entry.version, reason: msg }
    }
    if (!res.ok) {
      try { await res.body?.cancel() } catch (_) {}
      return { ok: false, id, version: entry.version, reason: `下载失败：HTTP ${res.status}` }
    }
    // 同一条教训：跟随重定向之后必须复核最终地址
    if (res.url && !isAllowedUrl(res.url)) {
      return { ok: false, id, version: entry.version, reason: '下载被重定向到了不被允许的地址' }
    }

    const tmpFile = path.join(os.tmpdir(), `hira-market-${id}-${Date.now().toString(36)}.zip`)
    try {
      let bytes = 0
      try {
        bytes = await writeCapped(res, tmpFile, MAX_PACKAGE_BYTES)
      } catch (e) {
        return { ok: false, id, version: entry.version, reason: `下载失败：${errorMessage(e)}` }
      }
      if (bytes < 22) return { ok: false, id, version: entry.version, reason: '下载到的文件不是有效的压缩包' }

      if (entry.sha256) {
        const hash = crypto.createHash('sha256')
        await new Promise<void>((resolve, reject) => {
          const rs = fs.createReadStream(tmpFile)
          rs.on('data', (c) => hash.update(c))
          rs.on('error', reject)
          rs.on('end', () => resolve())
        })
        const got = hash.digest('hex')
        if (got !== entry.sha256) {
          return {
            ok: false,
            id,
            version: entry.version,
            reason: `校验和不符（索引声明 ${entry.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）：文件可能被篡改或不完整，已丢弃`
          }
        }
      }

      const result = await installer.installArchive(tmpFile, { overwrite: opts.overwrite !== false })
      if (!result.ok) return { ok: false, id, version: entry.version, reason: result.reason }
      return {
        ok: true,
        id: result.id || id,
        version: entry.version,
        name: result.name || entry.name,
        signature: result.signature,
        warnings: result.warnings,
        verified: !!entry.sha256
      }
    } catch (e) {
      return { ok: false, id, version: entry.version, reason: errorMessage(e) }
    } finally {
      // 无论成败都清掉临时包：它是**下载产物**，留着只会越积越多（而且里面是别人的代码）
      try { await fsp.rm(tmpFile, { force: true }) } catch (_) {}
    }
  }

  return { query, setSources, install, fetchIndex, _internals: { isAllowedUrl, normalizeEntry } }
}

export { createPluginMarket, MAX_ENTRIES, MAX_SOURCES, MAX_PACKAGE_BYTES }
