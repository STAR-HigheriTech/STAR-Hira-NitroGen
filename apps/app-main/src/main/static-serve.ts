/**
 * 静态文件服务原语（主进程共用）
 *
 * 从 hira-protocol.js 抽出，供 hira:// 内部页与 hira-game:// 外部 bundle
 * 两条协议共用同一套「路径解析 + 遍历守卫 + MIME + Response 包装」逻辑。
 *
 * 职责单一：给一个 baseDir 和一个 URL pathname，安全地吐出一个 Response。
 * 不含任何协议注册、页面注册、业务分发逻辑 —— 那些留在各自的协议模块里。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { EXT_MIME_TYPES } = require('@hira-ng/shared-types/src/media-extensions.mjs')

/**
 * 扩展名 → MIME。
 *
 * 媒体/字体/脚本/样式那一半来自 shared-types 的**同一张表**（三条协议共用一份），
 * 这里只补内部页专有的几条（文档、清单、音频、sourcemap）。新增页面资源类型时在此登记。
 */
interface StaticCacheEntry { data: Buffer; etag: Record<string,string>; headers: Record<string,string> }
interface ServeStaticOptions { label?: string; cache?: boolean; headers?: Record<string,string> }

const MIME = {
  ...EXT_MIME_TYPES,
  '.html': 'text/html',
  '.webmanifest': 'application/manifest+json',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
  '.map': 'application/json'
}

/** @param {string} filePath */
function mimeOf (filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

/**
 * 从候选目录里挑第一个存在的，都不存在则返回第一个（便于报错信息指向预期位置）。
 * @param {string[]} candidates
 * @returns {string}
 */
function firstExistingDir (candidates: string[]): string {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch { /* ignore */ }
  }
  return candidates[0]
}

/**
 * 把 URL pathname 解析成 baseDir 下的**规范绝对路径** —— **纯字符串运算，不碰磁盘**。
 *
 * 为什么要把「算路径」与「落盘确认」拆成两步：静态资源**缓存命中时根本不需要磁盘**，
 * 而缓存键就是这条规范路径。原实现是「先 `await` 解析（内含一次 `fsp.stat`）再查缓存」，
 * 于是**每一次缓存命中也要白走一趟线程池** —— 而内部页（hira://settings 等）的
 * html / css / js / shared **每个子资源都要过一次 handler**，这笔开销是按资源数叠加的。
 * 拆开后：键同步算出 → 命中直接返回；只有未命中才 `stat`。
 *
 * 含目录遍历守卫（解析结果必须落在 baseDir 内），越界返回 null。
 * @param {string} baseDir
 * @param {string} pathname
 * @returns {string|null}
 */
function resolvePathUnder (baseDir: string, pathname: string): string | null {
  let rel = decodeURIComponent(pathname || '')
  if (rel === '/' || rel === '' || rel === '\\') rel = '/index.html'
  // 剥掉前导 ../（防遍历）与前导 /（Windows 下 path.join 会把它当绝对路径而丢弃 baseDir）
  const normalized = path.normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[\\/]+/, '')
  const resolved = path.resolve(path.join(baseDir, normalized))
  const rootResolved = path.resolve(baseDir)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null
  return resolved
}

/* ───────────────────────────────────────────────────────────────
 * 进程内静态资源缓存。
 *
 * 为什么：内部页（hira://settings/history/...）冷加载时，html/css/js/shared
 * 多个资源会在 protocol.handle 里逐个被读取。若每次都同步 fs.readFileSync，
 * 主进程事件循环会被反复卡住 —— 而主进程一卡，**所有窗口的 IPC/点击都冻结**
 * （表现为"从零打开设置页冻很久才能点"）。缓存 + 异步读彻底移除了这个阻塞点：
 *   - 缓存：构建产物不会热变，命中即返回 Buffer，不必反复读盘；
 *   - 异步：首次未命中走 fsp 线程池，不占主进程事件循环。
 * 内存开销：一块资源一份 Buffer，压缩产物体积小，占用可忽略。
 *
 * ── 字节预算（本轮新增）────────────────────────────────────────
 * 原来只按**条数**封顶（256 条），单条没有上限：内部页的共享 chunk / 字体 / 图标
 * 单份可以到几百 KB，256 条最坏就是几十 MB —— 而它是**主进程常驻**，用户前台用多久
 * 就占多久。现在再叠一条 12MB 的总字节预算，超了同样从最旧开始淘汰。
 * 12MB 足够覆盖全部内部页的热资源（实际常用也就几 MB），同时把上限钉死。
 * ─────────────────────────────────────────────────────────────── */
const _fileCache = new Map<string, StaticCacheEntry>()
const _CACHE_MAX = 256
/** 缓存总字节预算（见上面「字节预算」）。 */
const _CACHE_MAX_BYTES = 12 * 1024 * 1024
/** 当前缓存占用（字节，按 Buffer.length 累计；随淘汰同步扣减）。 */
let _cachedBytes = 0

// 开发模式：out/pages 会被迭代构建覆盖，禁用缓存避免吃到旧产物；PROD 才启缓存。
const IS_DEV = !!(process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL)

function _cacheGet (key: string): StaticCacheEntry | undefined {
  const hit = _fileCache.get(key)
  if (hit !== undefined) {
    // 简单 LRU：命中后重新置顶，避免缓存沦为热点不清理
    _fileCache.delete(key)
    _fileCache.set(key, hit)
    return hit
  }
  return undefined
}

/** 摘掉一条并同步扣减字节计数（**唯一的删除入口**，否则计数必然漂移）。 */
function _cacheEvict (key: string, value: StaticCacheEntry | undefined): void {
  _fileCache.delete(key)
  if (value && value.data) _cachedBytes -= value.data.length
  if (_cachedBytes < 0) _cachedBytes = 0
}

function _cacheSet (key: string, value: StaticCacheEntry): void {
  const bytes = value && value.data ? value.data.length : 0
  // 单条就超过总预算的资源不缓存：仍正常返回本次响应，但不能让“至少留一条”
  // 变成绕过内存上限的后门。
  if (bytes > _CACHE_MAX_BYTES) return
  const prev = _fileCache.get(key)
  if (prev !== undefined) _cacheEvict(key, prev)
  _fileCache.set(key, value)
  _cachedBytes += bytes
  // 双闸门：条数或总字节任一超限都淘汰。
  while (_fileCache.size > 0 && (_fileCache.size > _CACHE_MAX || _cachedBytes > _CACHE_MAX_BYTES)) {
    const oldest = _fileCache.keys().next()
    if (oldest.done) break
    _cacheEvict(oldest.value, _fileCache.get(oldest.value))
  }
}

// 开发模式下 out/pages 会被迭代构建覆盖：浏览器侧也不许留旧副本。
// 只关进程内缓存（IS_DEV）不够 —— 响应头仍带 max-age 时，Chromium 会直接拿
// HTTP 缓存里的旧模块，表现为「源码/产物都改了，窗口还是老样子、甚至白屏」。
const CACHE_CONTROL = IS_DEV ? 'no-store' : 'max-age=3600, must-revalidate'

function _respHeaders (file: string, extra: Record<string,string> = {}): Record<string,string> {
  return {
    'Content-Type': mimeOf(file) + '; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    // 构建产物在 PROD 不会热变：长缓存 + 校验，命中 Etag 即 304，冷加载不再重复读盘/传输
    'Cache-Control': CACHE_CONTROL,
    ...extra
  }
}

/**
 * 异步读一个静态文件并包成 Response（异步 IO，不阻塞主进程 + 内存缓存）。
 *
 * **缓存优先**：缓存键 = `resolvePathUnder` 的纯字符串结果，因此命中时
 * **一次磁盘都不碰**（原实现先 `await resolveFileUnderAsync` → 内含 `fsp.stat`，
 * 命中也要走一趟线程池）。内部页的每个子资源都要过一遍 handler，这里是按资源数
 * 叠加的固定开销，省下来的是"每次冷加载 × 资源数"。
 * 未命中才 `stat` 确认（目录 / 不存在 → null，语义与原实现一致）。
 *
 * ⚠ 语义代价（刻意接受）：文件在运行期被删除后，缓存里那几份仍会被继续返回，
 * 直到被 LRU 挤出 —— 这正是"缓存"的含义。产物不热变；开发模式（IS_DEV）
 * 本就不启用缓存，所以无需担心吃到旧产物。
 *
 * @param {string} baseDir
 * @param {string} pathname
 * @param {{label?:string, cache?:boolean}} [opts]  cache=false 跳过缓存（仍走异步读）
 * @returns {Promise<Response|null>}
 */
async function serveStaticAsync (baseDir: string, pathname: string, opts: ServeStaticOptions = {}): Promise<Response | null> {
  const cache = opts.cache !== false && !IS_DEV
  try {
    // ① 算键：纯字符串，不碰磁盘
    const key = resolvePathUnder(baseDir, pathname)
    if (!key) return null
    // ② 查缓存：命中即返回
    if (cache) {
      const cached = _cacheGet(key)
      if (cached !== undefined) {
        return new Response(cached.data as unknown as BodyInit, { headers: _respHeaders(key, { ...cached.headers, ...cached.etag }) })
      }
    }
    // ③ 未命中：落盘确认（目录 / 不存在 → null）+ 异步读
    const realBase = await fsp.realpath(baseDir).catch(() => '')
    const realKey = await fsp.realpath(key).catch(() => '')
    if (!realBase || !realKey) return null
    const baseCheck = process.platform === 'win32' ? realBase.toLowerCase() : realBase
    const keyCheck = process.platform === 'win32' ? realKey.toLowerCase() : realKey
    if (keyCheck !== baseCheck && !keyCheck.startsWith(baseCheck + path.sep)) return null
    let resolvedFile = realKey
    let st = await fsp.stat(resolvedFile).catch(() => null)
    if (st?.isDirectory()) {
      resolvedFile = await fsp.realpath(path.join(realKey, 'index.html')).catch(() => '')
      if (!resolvedFile) return null
      const fileCheck = process.platform === 'win32' ? resolvedFile.toLowerCase() : resolvedFile
      if (fileCheck !== baseCheck && !fileCheck.startsWith(baseCheck + path.sep)) return null
      st = await fsp.stat(resolvedFile).catch(() => null)
    }
    if (!st || !st.isFile()) return null
    const data = await fsp.readFile(resolvedFile)
    const etag = `"${Buffer.byteLength(data).toString(16)}"`
    const headers = { ...(opts.headers || {}) }
    const resp = new Response(data as unknown as BodyInit, { headers: _respHeaders(resolvedFile, { ...headers, ETag: etag }) })
    if (cache) _cacheSet(resolvedFile, { data, etag: { ETag: etag }, headers })
    return resp
  } catch (error) {
    console.error(`[${opts.label || 'static-serve'}] async read failed:`, baseDir, pathname, error instanceof Error ? error.message : error)
    return null
  }
}

module.exports = {
  MIME,
  mimeOf,
  firstExistingDir,
  // 规范路径（不碰磁盘）：需要"先算键、命中就不碰盘"的调用方用这条，
  // 落盘与读盘由 serveStaticAsync 一并完成。
  resolvePathUnder,
  serveStaticAsync,
  // 暴露给测试/诊断：内部页读到多少资源进缓存，便于验证不再反复读盘
  _fileCache
}
