/**
 * hira:// 协议层
 *
 * 职责单一：把 hira://<host>/<path> 的请求映射到某个 Response。
 * 具体页面的 HTML/CSS/JS 一律不再内联在本进程里 —— 全部落在
 *   apps/app-main/src/pages/<host>/   （构建时拷到 out/pages/<host>/）
 * **没有例外**：设置页也在这里，只是它多了一个 `<link>` 和一个 `settings.js` 的差别。
 * 本文件不认识任何具体页面，也不需要认识。
 *
 * 设计要点（对齐 docs-ng PART3「模块化 / 插件化 / 解耦」）：
 *  - 注册中心驱动：每个 host 对应一条描述符，新增页面 = 丢一个目录（自动发现）
 *    或调用 registerHiraPage() 注册一个动态页，**无需改动分发逻辑**
 *  - 没有优先级链：host 是唯一键，历史实现里
 *    「error / pdf / jsdialog 被硬编码在文件查找之前，导致 pages/error 永远不生效」
 *    的顺序耦合被彻底消除
 *  - 分层：本文件只做「协议 + 分发 + 静态读盘」，不含任何页面内容
 *
 * 描述符字段：
 *   host      hira://<host>，小写
 *   kind      'static'  → 从 out/pages/<dir>/ 读真实文件（默认）
 *             'dynamic' → 调用 resolve(url) 自行返回 Response
 *   dir       kind='static' 时的磁盘目录名（默认取 host）
 *   resolve   kind='dynamic' 时的处理函数 (url) => Response|null
 */

import fs from 'node:fs'
import path from 'node:path'
import { net, protocol, type Session } from 'electron'
import { createLruCache } from '@hira-ng/shared-utils'
import { createChromiumHostResolver, createNetworkGuard } from '@hira-ng/infra-net-guard'
import { isHttpProtocol } from '@hira-ng/shared-types/src/url-protocols.mjs'
import { pageIconSvgText } from '@hira-ng/shared-types/src/page-icon.mjs'
import { CHROME_FAVICON_QUERY_KEY, chromeFaviconPageUrl } from '@hira-ng/shared-types/src/favicon-compat.mjs'
import { ARCHIVE_CONTENT_HOST, archiveContentId } from '@hira-ng/shared-types/src/archive-content.mjs'
const { PAGE_ROUTE_ALIASES } = require('@hira-ng/shared-types/src/page-url.mjs') as {
  PAGE_ROUTE_ALIASES: Readonly<Record<string, string>>
}

const fsp = fs.promises
// 「算不算普通网页」的唯一判据（favicon 只代理 http(s)，重定向后同样复核）。
const {
  mimeOf,
  firstExistingDir,
  serveStaticAsync
} = require('./static-serve') as {
  mimeOf(filePath: string): string
  firstExistingDir(candidates: string[]): string
  serveStaticAsync(baseDir: string, pathname: string, options?: { label?: string }): Promise<Response | null>
}
// 内部页图标（favicon）的唯一真源：host → 字形 → SVG 文本。
// 本文件不认识任何具体页面，也不需要认识 —— 只按 p 参数去查那张表。
// chrome://favicon 的解析规则（path / pageUrl / page_url / url 四种写法）——
// 与扩展页 preload 的「只认前缀」改写共用同一份口径，解析真源在 shared-types。

interface HiraPageDescriptor {
  host: string
  kind?: 'static' | 'dynamic'
  dir?: string
  resolve?(url: URL, session?: Session | null): Response | Promise<Response> | null | undefined
}

interface RegisteredHiraPage extends HiraPageDescriptor {
  host: string
  kind: 'static' | 'dynamic'
}

interface IconAsset { buffer: Buffer; contentType?: string }

type ExtensionIconPort = (extensionId: string, profileId?: string) => Promise<IconAsset | null>
type FaviconIconPort = (hash: string) => IconAsset | null
type ArchiveAssetPort = (noteId: string) => Promise<{ htmlPath: string } | null> | { htmlPath: string } | null

/** hira:// 协议名。改这里即改全局（协议注册、URL 生成同源）。 */
export const HIRA_SCHEME = 'hira'

/**
 * Every trusted internal document shares this baseline. The shell bridge is
 * powerful enough that one DOM XSS would otherwise become an IPC compromise;
 * inline styles remain allowed because the build pipeline intentionally inlines
 * the shared design tokens for first-paint performance.
 */
const HIRA_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' hira: blob:",
  "script-src-elem 'self' hira: blob:",
  "script-src-attr 'none'",
  "style-src 'self' hira: hira-theme: hira-plugin: 'unsafe-inline'",
  "img-src 'self' hira: hira-theme: hira-pwa: hira-plugin: https: data: blob:",
  "font-src 'self' hira: hira-theme: hira-plugin: data:",
  "media-src 'self' hira: hira-theme: hira-pwa: https: data: blob:",
  "connect-src 'self' hira: hira-theme: hira-pwa: hira-plugin: https: data: blob:",
  "frame-src 'self' hira: hira-plugin: data: blob: about:",
  "child-src 'self' hira: hira-plugin: data: blob: about:",
  "worker-src 'self' hira: blob:",
  "manifest-src 'self' hira:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' hira:",
  "frame-ancestors 'none'"
].join('; ')

const ARCHIVE_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data: https:",
  "media-src 'self' data: https: blob:",
  "connect-src 'none'",
  "frame-src 'self'",
  "child-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors hira://archive"
].join('; ')

function secureHiraDocument(response: Response): Response {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  const archiveDocument = headers.get('X-Hira-Archive') === '1'
  headers.delete('X-Hira-Archive')
  if (archiveDocument && contentType.includes('text/html')) {
    headers.set('Content-Security-Policy', ARCHIVE_DOCUMENT_CSP)
    headers.set('Referrer-Policy', 'no-referrer')
    headers.delete('X-Frame-Options')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }
  if (contentType.includes('text/html')) {
    headers.set('Content-Security-Policy', HIRA_DOCUMENT_CSP)
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('X-Frame-Options', 'DENY')
  } else if (contentType.includes('image/svg+xml')) {
    // SVG is a document when navigated directly. Never let a remote favicon or
    // extension-provided icon execute scripts under a hira:// origin.
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; object-src 'none'; base-uri 'none'; sandbox"
    )
    headers.set('Referrer-Policy', 'no-referrer')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 页面注册中心
//
// 特权注册不在这里 —— 见 `scheme-privileges.js`（全库唯一一次
// `registerSchemesAsPrivileged`；分散调用会互相覆盖）。
// ─────────────────────────────────────────────────────────────────────────────

const hiraPages = new Map<string, RegisteredHiraPage>()

/**
 * 注册一个 hira:// 页面。
 * @param {{host:string, kind?:'static'|'dynamic', dir?:string, resolve?:(url:URL)=>Response|null}} desc
 */
export function registerHiraPage (desc: HiraPageDescriptor | null | undefined): boolean {
  if (!desc || !desc.host) return false
  hiraPages.set(String(desc.host).toLowerCase(), {
    kind: 'static',
    dir: String(desc.host).toLowerCase(),
    ...desc,
    host: String(desc.host).toLowerCase()
  })
  return true
}

/** @param {string} host */
export function getHiraPage (host: unknown): RegisteredHiraPage | null {
  return hiraPages.get(String(host || '').toLowerCase()) || null
}

/** 已注册的 host 列表（诊断用） */
export function listHiraPages (): string[] {
  return Array.from(hiraPages.keys())
}

/**
 * 注销一个 hira:// 页面（插件停用/卸载时清残影）。
 * @param {string} host
 * @returns {boolean} 是否确实移除了
 */
export function unregisterHiraPage (host: unknown): boolean {
  const key = String(host || '').toLowerCase()
  if (!key) return false
  return hiraPages.delete(key)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 磁盘布局解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 定位 out/pages。
 * internal-pages 既可能被打包进 out/main/index.js（__dirname = out/main），
 * 也可能作为独立文件落在 out/main/（copy 插件会原样拷贝），两种都探测一次。
 */
function resolvePagesRoot () {
  return firstExistingDir([
    path.join(__dirname, '..', 'pages'),
    path.join(__dirname, '..', '..', 'pages')
  ])
}
const PAGES_ROOT = resolvePagesRoot()

/**
 * pdfjs-dist 静态资源目录（main lib + worker）。
 * 优先 out/main → 项目 node_modules；保留历史路径与 cwd 兜底。
 */
const PDFJS_DIR_CANDIDATES = [
  path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'build'),
  path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'pdfjs-dist', 'build'),
  path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build')
]
function resolvePdfjsDir () {
  return firstExistingDir(PDFJS_DIR_CANDIDATES)
}

// MIME / 路径守卫 / 静态读盘 已抽到 main/static-serve.js（与 hira-game:// 共用）

/**
 * 扩展图标的**读取口**（由 main.js 在扩展系统就绪后注入）。
 *
 * 为什么图标要走协议而不是在列表里塞 data URL：清单里的 `icons` 只是扩展目录内的
 * 相对路径（Electron 的 Extension 对象没有 iconPath 字段），那个字符串进 `<img src>`
 * 会相对当前页面解析、必然 404。RT 走的是 `hx://extension-icon?id=…`（ipc/app/extensions.ts:41-43），
 * NG 对应 `hira://extension-icon?id=<id>` —— 好处是同一张图能被渲染进程按 URL 缓存，
 * 不必在每次列表刷新时把图标字节重新塞进 IPC 载荷（对齐「极致优化」）。
 * @type {null | ((extensionId: string, profileId?: string) => Promise<{ buffer: Buffer, contentType?: string }|null>)}
 */
let extensionIconPort: ExtensionIconPort | null = null
let archiveAssetPort: ArchiveAssetPort | null = null

/**
 * 注入扩展图标读取口。传非函数即视为「不提供图标」—— 页面会退回首字母徽标。
 * @param {null | ((extensionId: string) => Promise<any>)} fn
 */
export function setExtensionIconPort (fn: ExtensionIconPort | null | undefined): void {
  extensionIconPort = typeof fn === 'function' ? fn : null
}

export function setArchiveAssetPort (fn: ArchiveAssetPort | null | undefined): void {
  archiveAssetPort = typeof fn === 'function' ? fn : null
}

async function serveArchiveContent(url: URL): Promise<Response> {
  const id = archiveContentId(url.pathname)
  if (!id || !archiveAssetPort) return new Response('Not Found', { status: 404 })
  let asset: { htmlPath: string } | null = null
  try {
    asset = await archiveAssetPort(id)
  } catch {
    asset = null
  }
  if (!asset?.htmlPath) return new Response('Not Found', { status: 404 })

  const baseDir = path.dirname(asset.htmlPath)
  const rawRelative = url.pathname.split('/').slice(2).join('/')
  let filePath = asset.htmlPath
  if (rawRelative) {
    let relative = ''
    try {
      relative = decodeURIComponent(rawRelative)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    filePath = path.resolve(baseDir, relative)
  }
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    return new Response('Forbidden', { status: 403 })
  }
  try {
    const [realBase, realFile] = await Promise.all([
      fsp.realpath(baseDir),
      fsp.realpath(filePath)
    ])
    const baseKey = process.platform === 'win32' ? realBase.toLowerCase() : realBase
    const fileKey = process.platform === 'win32' ? realFile.toLowerCase() : realFile
    if (fileKey !== baseKey && !fileKey.startsWith(baseKey + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    filePath = realFile
    const body = await fsp.readFile(filePath)
    return new Response(body as unknown as BodyInit, {
      headers: {
        'Content-Type': mimeOf(filePath),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store',
        'X-Hira-Archive': '1'
      }
    })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

/**
 * hira://extension-icon?id=<extensionId> —— 返回该扩展清单里那一档图标的字节。
 * 任何取不到的情况（没有该扩展 / 没声明 icons / 文件不存在 / 越界）一律 404，
 * 由 `<img onerror>` 降级成首字母徽标，绝不返回假图。
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function serveExtensionIcon (url: URL): Promise<Response> {
  const id = url.searchParams.get('id') || ''
  const profileId = url.searchParams.get('profile') || ''
  if (!extensionIconPort || !id) return new Response('Not Found', { status: 404 })
  let asset = null
  try {
    asset = await extensionIconPort(id, profileId)
  } catch (e) {
    console.warn('[hira-protocol] extension icon read failed:', id, e instanceof Error ? e.message : String(e))
    return new Response('Not Found', { status: 404 })
  }
  if (!asset || !asset.buffer) return new Response('Not Found', { status: 404 })
  return new Response(asset.buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': asset.contentType || 'application/octet-stream',
      // 与静态资源同口径：hira:// 各 host 互为异源，带上 ACAO 才不会在
      // 「跨 host 取用」这类写法下被浏览器拦掉（<img> 本不要求，但成本为零）。
      'Access-Control-Allow-Origin': '*',
      // 图标 URL 带 `v=<version>`（见 main/ipc/extensions.js），版本一变就是新 URL，
      // 因此这里可以放心让渲染进程缓存，避免每次列表重绘都重新读盘。
      'Cache-Control': 'private, max-age=3600'
    }
  })
}

/**
 * hira://pdfjs/<filename> —— 提供 pdfjs-dist 的 main lib / worker。
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function servePdfjs (url: URL): Promise<Response> {
  const filename = url.pathname.slice(1)
  // 防路径遍历：只允许字母数字点破折号下划线
  const safe = String(filename || '').replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safe) return new Response('Bad request', { status: 400 })

  const filePath = path.join(resolvePdfjsDir(), safe)
  try {
    const st = await fsp.stat(filePath)
    if (!st.isFile()) return new Response('Not Found', { status: 404 })
    const data = await fsp.readFile(filePath)
    return new Response(data, {
      headers: {
        'Content-Type': mimeOf(filePath) + '; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch {
    console.warn('[hira-protocol] pdfjs static not found:', safe)
    return new Response('Not Found', { status: 404 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.5 favicon 代理（hira://favicon/?url=…）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 代理缓存与限额。favicon 是小文件，但代理**必须**设上限 —— 否则一个畸形/恶意
 * URL 就能让主进程把任意大的响应体读进内存。
 *
 * 缓存条数取 320：书签 / 历史页一屏可能上百行，而**同一站点只占一条**
 * （按 favicon URL 键，不是按页面 URL），500 行的历史通常也就几十条真实图标。
 */
const FAVICON_CACHE_MAX = 320
/**
 * 缓存总字节预算。只按条数封顶时，单条 512KB 的最坏情形仍能撑出上百 MB 常驻
 * 主进程；实际图标通常几 KB，**12MB 已够覆盖数千个站点**，同时把上限钉死。
 *
 * 本轮由 24MB 收到 12MB：这份缓存是**主进程常驻**（前台用多久就占多久），
 * 而 favicon 本来就是可随时重取的纯缓存 —— 命中率下降一点点，换来上限减半。
 */
const FAVICON_CACHE_MAX_BYTES = 12 * 1024 * 1024
const FAVICON_MAX_BYTES = 512 * 1024

/**
 * 单张图标的取回超时。
 *
 * 为什么必须有：请求被墙 / 网络黑洞时 `net.fetch` 会**一直挂着**（既不成功也不失败），
 * 于是 inflight 表里那条 Promise 永不 settle（每次访问都在表里堆一条），
 * 而渲染侧的 `<img>` 也永远拿不到 load/error —— 表现就是"图标位永远空着"。
 * 超时兜底把它变成一次确定的失败（404），渲染侧才好画降级徽标。
 */
const FAVICON_TIMEOUT_MS = 8000
/** 与 AI 取页同口径：每一跳都重新校验，禁止服务器把公开地址跳到内网。 */
const FAVICON_MAX_REDIRECTS = 5

const faviconNetworkGuard = createNetworkGuard({
  resolveHost: createChromiumHostResolver(net),
  dnsTimeoutMs: 3_000,
  dnsCacheTtlMs: 30_000,
  dnsCacheMaxEntries: 256
})

/** 图标字节缓存：条数与总字节双封顶，超出从最旧开始淘汰 */
const faviconCache = createLruCache<{ buffer: Buffer; contentType: string }>({
  maxEntries: FAVICON_CACHE_MAX,
  maxWeight: FAVICON_CACHE_MAX_BYTES,
  weigh: (entry: { buffer: Buffer; contentType: string }) => entry.buffer.length
})
/** @type {Map<string, Promise<{buffer: Buffer, contentType: string}|null>>} 同 URL 并发去重 */
const faviconInflight: Map<string, Promise<{buffer: Buffer, contentType: string}|null>> = new Map<string, Promise<{ buffer: Buffer; contentType: string } | null>>()

/**
 * 远程取图的并发上限。
 *
 * 为什么必须有：内部页 / 面板一屏可能上百行没有本地图标，全部落到
 * `<origin>/favicon.ico` 兜底 —— 不设闸门时主进程会同时发起上百个 `net.fetch`，
 * 每个都可能挂 8 秒，表现就是「整个应用卡住」。6 个并行足够跑满带宽，
 * 又不会把主进程事件循环顶住。
 */
const FAVICON_MAX_CONCURRENT = 6
const FAVICON_MAX_QUEUE = 64
let faviconActive = 0
const faviconWaiting: Array<() => void> = []

function pumpFaviconQueue(): void {
  while (faviconActive < FAVICON_MAX_CONCURRENT && faviconWaiting.length > 0) {
    const next = faviconWaiting.shift()
    next?.()
  }
}

/** 在并发闸门内执行一次远程取图（排队期间不占用 inflight 之外的资源）。 */
function runFaviconTask<T>(task: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      faviconActive++
      Promise.resolve()
        .then(task)
        .then(
          (value) => { faviconActive--; pumpFaviconQueue(); resolve(value) },
          (error) => { faviconActive--; pumpFaviconQueue(); reject(error) }
        )
    }
    if (faviconActive < FAVICON_MAX_CONCURRENT) start()
    else if (faviconWaiting.length < FAVICON_MAX_QUEUE) faviconWaiting.push(start)
    else reject(new Error('favicon queue is full'))
  })
}

/**
 * 本地图标字节读取口（`hira://favicon/?icon=<hash>`）。
 * 由组合根注入（domain-favicon#getIcon）—— 协议层不认识数据库。
 * @type {((hash:string)=>({contentType:string, buffer:Buffer}|null))|null}
 */
let faviconIconPort: FaviconIconPort | null = null

/**
 * 注入本地图标读取口。
 * @param {((hash:string)=>({contentType:string, buffer:Buffer}|null))|null} fn
 */
export function setFaviconIconPort(fn: FaviconIconPort | null | undefined): void {
  faviconIconPort = typeof fn === 'function' ? fn : null
}

interface FaviconBytes { buffer: Buffer; contentType: string }
type FaviconRequestResult = { kind: 'bytes'; entry: FaviconBytes } | { kind: 'redirect'; target: string } | null

/**
 * Chromium favicon 请求的媒体类型清单。
 *
 * 有些站点用内容协商 / 反爬网关判定"这不是浏览器请求"，缺少 Accept 时直接回
 * HTML 或 403。这里是 `<img>` 天然会声明的集合，不带第三方 UA 字符串。
 */
const FAVICON_ACCEPT = [
  'image/avif',
  'image/webp',
  'image/apng',
  'image/svg+xml',
  'image/*',
  '*/*;q=0.8'
].join(',')

/**
 * 服务器把图片标成 `application/octet-stream` / 不给 Content-Type 的情况并不少见；
 * 这里按文件头认一遍常用图标格式，HTML / JSON 等非图片仍然拒绝。
 */
function sniffFaviconMimeType(buffer: Buffer): string {
  if (!buffer || buffer.length < 4) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp' && buffer.subarray(8, 12).toString('ascii').startsWith('avif')) return 'image/avif'
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return 'image/x-icon'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  const head = buffer.subarray(0, 512).toString('utf8').toLowerCase()
  if (/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return ''
}

function drainIncomingMessage(res: Electron.IncomingMessage): void {
  const resumable = res as Electron.IncomingMessage & { resume?: () => void }
  try { resumable.resume?.() } catch (_) {}
}

/** 单跳请求。`manual` 保证服务器响应头里的内网地址不会在 Chromium 内被直接取走。 */
function requestFaviconOnce(target: string, timeoutMs: number, session: Session | null = null): Promise<FaviconRequestResult> {
  if (timeoutMs <= 0) return Promise.resolve(null)
  return new Promise<FaviconRequestResult>((resolve) => {
    let req: Electron.ClientRequest
    try {
      const targetUrl = new URL(target)
      const userAgent = typeof session?.getUserAgent === 'function' ? session.getUserAgent() : ''
      req = net.request({
        method: 'GET',
        url: target,
        redirect: 'manual',
        headers: {
          Accept: FAVICON_ACCEPT,
          Referer: targetUrl.origin + '/',
          ...(userAgent ? { 'User-Agent': userAgent } : {})
        },
        ...(session ? { session, useSessionCookies: true } : {})
      })
    } catch (_) {
      resolve(null)
      return
    }

    let settled = false
    const finish = (result: FaviconRequestResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { req.abort() } catch (_) {}
      finish(null)
    }, timeoutMs)
    timer.unref?.()

    req.on('response', (res: Electron.IncomingMessage) => {
      const status = Number(res.statusCode) || 0
      if (status >= 300 && status < 400) {
        const rawLocation = res.headers.location
        const location = String(Array.isArray(rawLocation) ? rawLocation[0] : (rawLocation || '')).trim()
        drainIncomingMessage(res)
        if (!location) return finish(null)
        try {
          finish({ kind: 'redirect', target: new URL(location, target).toString() })
        } catch (_) {
          finish(null)
        }
        return
      }
      if (status < 200 || status >= 300) {
        drainIncomingMessage(res)
        finish(null)
        return
      }

      const rawType = res.headers['content-type']
      const type = String(Array.isArray(rawType) ? rawType[0] : (rawType || '')).toLowerCase()

      const rawLength = res.headers['content-length']
      if (Number(Array.isArray(rawLength) ? rawLength[0] : (rawLength || 0)) > FAVICON_MAX_BYTES) {
        drainIncomingMessage(res)
        finish(null)
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > FAVICON_MAX_BYTES) {
          try { req.abort() } catch (_) {}
          finish(null)
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      res.on('end', () => {
        if (!total) return finish(null)
        const bytes = Buffer.concat(chunks)
        const declaredType = type.split(';')[0].trim().toLowerCase()
        const contentType = /^image\//i.test(declaredType)
          ? declaredType
          : sniffFaviconMimeType(bytes)
        if (!contentType) return finish(null)
        finish({
          kind: 'bytes',
          entry: { buffer: bytes, contentType }
        })
      })
      res.on('error', () => finish(null))
    })
    req.on('error', () => finish(null))
    req.end()
  })
}

/** 取回 favicon 字节；任何一步不合规都返回 null（由调用方转 404，绝不放行脏数据）。 */
async function fetchFaviconBytes(target: string | URL, session: Session | null = null): Promise<FaviconBytes | null> {
  const deadline = Date.now() + FAVICON_TIMEOUT_MS
  let current = String(target)

  for (let hop = 0; hop <= FAVICON_MAX_REDIRECTS; hop++) {
    const verdict = await faviconNetworkGuard.assertSafeUrl(current)
    if (!verdict.ok) return null
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null

    const result = await requestFaviconOnce(verdict.url, remaining, session)
    if (!result) return null
    if (result.kind === 'bytes') return result.entry
    current = result.target
  }
  return null
}

function faviconResponse(entry: { buffer: Buffer; contentType: string }): Response {
  return new Response(entry.buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': entry.contentType || 'image/x-icon',
      // 关键的一条：渲染层（file:// / localhost）要把它 drawImage 进 canvas 再
      // getImageData —— 没有 ACAO 就还是会被判污染，代理就白做了。
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=600'
    }
  })
}

/**
 * hira://favicon/?url=<encoded> —— favicon 字节代理。
 *
 * 为什么要代理（而不是让渲染层直接加载站点原始 favicon）：
 *   tab 的 favicon 是站点声明的原始 URL，绝大多数是**异源** https://，而渲染层
 *   origin 是 file://（生产）/ localhost（开发）。异源图片进 canvas 后
 *   getImageData 会因「画布被污染」抛 SecurityError —— 「跟随 favicon 取色」根本
 *   无从谈起。这里由主进程把字节取回来、以同源 URL + ACAO 吐出，渲染层才能安全取色。
 *
 * 两个入口参数（互斥，`chrome` 优先）：
 *   · `url`    —— 直接给要取的图标地址（tab / 书签 / 历史用）；
 *   · `chrome` —— 扩展页里原样的 `chrome://favicon…` 地址。Chrome 扩展常把
 *     图标写成 chrome://favicon/<页面地址>，NG 不能注册 webRequest 重定向
 *     （见 shared-types/favicon-compat.mjs 文件头），改由扩展页 preload 把地址
 *     换成这个参数 —— **解析规则不在 preload 里**，全部收口在 shared-types。
 *
 * 安全约束（代理天然是 SSRF 面，逐条守住）：
 *   · 只允许 http/https（file:// / hira:// / data: 一律 400）；
 *   · 地址先过 SSRF 守卫，重定向手动逐跳跟随并**每跳复核**；
 *   · 只接受 image/* 响应；
 *   · 512KB 上限，流式读超限即断开；
 *   · 内存 LRU（320 条 / 12MB）——同一张图只出一次网。
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function serveFavicon (url: URL, session: Session | null = null): Promise<Response> {
  // 本地图标（导入时从源浏览器搬来的字节）：内容寻址，零联网、可长缓存。
  // 参数优先于 url/chrome —— 它不解析任何外部地址，是纯本地读。
  const iconHash = url.searchParams.get('icon') || ''
  if (iconHash) {
    const hit = faviconIconPort ? faviconIconPort(iconHash) : null
    if (!hit || !hit.buffer) return new Response('Not Found', { status: 404 })
    return new Response(hit.buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': hit.contentType || 'image/x-icon',
        'Access-Control-Allow-Origin': '*',
        // 内容寻址 = 同一 URL 永远同一张图，可放心长缓存
        'Cache-Control': 'private, max-age=86400'
      }
    })
  }

  const chromeRaw = url.searchParams.get(CHROME_FAVICON_QUERY_KEY) || ''
  const raw = chromeRaw || url.searchParams.get('url') || ''
  let target = null
  try {
    if (chromeRaw) {
      // chrome:// → 页面地址（非 http/https / 畸形地址在这里就被拒掉）。
      const pageUrl = chromeFaviconPageUrl(chromeRaw)
      if (!pageUrl) return new Response('Bad request', { status: 400 })
      target = new URL(pageUrl)
    } else {
      target = new URL(raw)
    }
  } catch (_) {
    return new Response('Bad request', { status: 400 })
  }
  if (!isHttpProtocol(target.protocol)) {
    return new Response('Bad request', { status: 400 })
  }

  const key = target.href
  const cached = faviconCache.get(key)
  if (cached) return faviconResponse(cached)

  let task = faviconInflight.get(key)
  if (!task) {
    task = runFaviconTask(() => fetchFaviconBytes(key, session)).catch(() => null)
    faviconInflight.set(key, task)
    task.finally(() => faviconInflight.delete(key))
  }
  const got = await task
  if (!got) return new Response('Not Found', { status: 404 })
  faviconCache.set(key, got)
  return faviconResponse(got)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.6 内部页图标（hira://page-icon/?p=<host>）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hira://page-icon/?p=<host> —— 某个内部页自己的 favicon（SVG）。
 *
 * 为什么要有它：Chromium 的 favicon 只认**页面自己声明**的图标，而 hira:// 内部页
 * 全是静态 HTML —— 每页手放一个 .svg 会立刻退化成"33 个文件各画一份美术"，
 * 新增页面还会漏。走协议端点后：
 *   · 字形与 rail/面板用的是**同一份路径数据**（真源在 shared-types#page-icon.mjs）；
 *   · 换图标只改那张表，页面一行不动；
 *   · 插件新增的内部页，登记一个 host 就有图标（没登记则退兜底字形，不会空着）。
 *
 * p 用 host（也等于 out/pages/<host>/ 的目录名）而不是整串 URL：
 * 页面是 `<link rel="icon" href="hira://page-icon/?p=settings">` —— 短、稳定、可缓存。
 * 未知 host 一律给兜底字形（绝不 404）：图标位空着比"通用图标"更糟。
 * @param {URL} url
 * @returns {Response}
 */
function servePageIcon (url: URL): Response {
  const host = String(url.searchParams.get('p') || '')
  return new Response(pageIconSvgText(host), {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // 与静态层同口径：跨 host 引用（<img> / 取色）不受影响
      'Access-Control-Allow-Origin': '*',
      // 纯函数式的产物（同一 host 永远同一张图）→ 让渲染进程放心缓存
      'Cache-Control': 'private, max-age=3600'
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 内置注册
// ─────────────────────────────────────────────────────────────────────────────

/** 公共资源别名：hira://shared/* → out/pages/_shared/* */
const ASSET_ALIASES = {
  shared: '_shared'
}

let builtinsReady = false

// 静态别名 + 动态页（零 IO，同步注册）；磁盘页面目录走异步发现，避免主进程同步扫盘
function ensureBuiltinHiraPages () {
  if (builtinsReady) return
  builtinsReady = true

  for (const [host, dir] of Object.entries(ASSET_ALIASES)) {
    registerHiraPage({ host, kind: 'static', dir })
  }

  // 动态页：需要按请求参数生成，无法文件化
  registerHiraPage({ host: 'pdfjs', kind: 'dynamic', resolve: servePdfjs })
  // hira://extension-icon?id=<id> —— 扩展图标（读取口由 main.js 注入，拿不到就是 404）
  registerHiraPage({ host: 'extension-icon', kind: 'dynamic', resolve: serveExtensionIcon })
  // hira://favicon/?url=<encoded> —— favicon 字节代理（同源化，供渲染层安全取色）
  registerHiraPage({ host: 'favicon', kind: 'dynamic', resolve: serveFavicon })
  // hira://page-icon/?p=<host> —— 内部页自己的图标（真源 shared-types#page-icon.mjs）
  registerHiraPage({ host: 'page-icon', kind: 'dynamic', resolve: servePageIcon })
  registerHiraPage({ host: ARCHIVE_CONTENT_HOST, kind: 'dynamic', resolve: serveArchiveContent })
  // hira://settings —— 设置页**不在这里**：它是 out/pages/settings/ 下的普通静态页，
  // 由下面的磁盘发现自动注册。任何页面都不再需要"显式注册 + 自定义路径映射"。
  for (const [legacyHost, publicHost] of Object.entries(PAGE_ROUTE_ALIASES)) {
    registerHiraPage({ host: publicHost, kind: 'static', dir: legacyHost })
  }

  // 磁盘发现前置到首个请求，交给异步协议流水线，Scan 完成前 miss 的静态页
  // 由 handler 侧的 ensureBuiltinHiraPagesScan() 兜底补扫一次
  ensureBuiltinHiraPagesScan().catch(() => {})
}

/** 用备注替换原有逻辑：异步扫描 out/pages，注册静态页（幂等、可反复调用）。 */
let scanPromise: Promise<void> | null = null
function ensureBuiltinHiraPagesScan (): Promise<void> {
  if (!scanPromise) {
    scanPromise = (async () => {
      let entries = []
      try {
        entries = await fsp.readdir(PAGES_ROOT, { withFileTypes: true })
      } catch (e) {
        console.warn('[hira-protocol] pages root unreadable:', PAGES_ROOT, e instanceof Error ? e.message : String(e))
        return
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('_')) continue // _shared 等内部目录不作为页面
        // 已注册则跳过（保留 pdfjs 等 dynamic 优先级不受静态目录覆盖影响）
        if (hiraPages.has(e.name)) continue
        registerHiraPage({ host: e.name, kind: 'static', dir: e.name })
      }
    })()
  }
  return scanPromise
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 兜底页
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 未注册 / 文件缺失时的兜底 HTML。
 * @param {string} host
 * @returns {string}
 */
function escapeHtmlText (value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildNotFoundHtml (host: string): string {
  const safeHost = escapeHtmlText(host)
  const title = safeHost.charAt(0).toUpperCase() + safeHost.slice(1)
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  /* 独立文档、拿不到 UI 令牌：写全中文字体栈，避免中文回退到宋体点阵。 */
  body { font-family: "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, -apple-system, sans-serif; padding: 24px; background: #f0f3f7; color: #1a1a1a; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  p { color: #666; }
</style>
</head>
<body><h1>${title}</h1><p>Page not found.</p></body>
</html>`
}

function htmlResponse (html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 请求分发
//
// ⚠ 本层**不做**扩展新标签页覆盖（`chrome_url_overrides.newtab`）的重定向：
//   `Response.redirect('chrome-extension://<id>/…', 302)` 会让 Chromium 把扩展 id
//   当域名走 DNS 解析 → ERR_NAME_NOT_RESOLVED (-20)，落到「无法访问此网站」。
//   扩展页只能由浏览器主动 loadURL（直接导航是正常的）。覆盖解析在
//   `main/home-url.js#resolveNewTabUrl` + TabManager 的 onResolveTabUrl 钩子上完成。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function serveHiraRequest (request: Request, session: Session | null = null): Promise<Response> {
  try {
    ensureBuiltinHiraPages()
    // 静态页目录发现异步执行：首个请求让位给 scan 完成后分发，保证内部页可解析
    await ensureBuiltinHiraPagesScan()

    const url = new URL(request.url)
    const host = url.hostname.toLowerCase()
    // Hosts are registry keys, not free-form text. Reject percent-encoded
    // punctuation and malformed names before they can reach the fallback HTML.
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(host)) {
      return secureHiraDocument(htmlResponse(buildNotFoundHtml('invalid-page'), 400))
    }

    const page = getHiraPage(host)

    if (page) {
      const resp = page.kind === 'dynamic'
        ? page.resolve ? await page.resolve(url, session) : null
        : await serveStaticAsync(path.join(PAGES_ROOT, page.dir || host), url.pathname, { label: 'hira-protocol' })
      if (resp) return secureHiraDocument(resp)
      // 带上 referrer：这条警告只说明「文件不存在」，但不说明**谁在要**。
      // 排查幽灵请求（例如已删掉的共享模块仍被某页 import）时全靠它。
      console.warn(`[hira-protocol] ${host} registered but not served: ${url.pathname} (referrer=${request.referrer || '-'})`)
    }

    return secureHiraDocument(htmlResponse(buildNotFoundHtml(host)))
  } catch (e) {
      console.error('[hira-protocol] error:', e instanceof Error ? e.message : String(e))
    return secureHiraDocument(htmlResponse(buildNotFoundHtml('error')))
  }
}

/**
 * 注册 hira:// 协议处理器。
 * @param {import('electron').Session} [session] 指定 session 则注册到该 session，否则注册到默认 session
 */
export function registerHiraProtocol (session?: Session): void {
  ensureBuiltinHiraPages()
  // 每个 session 的 hira:// 处理器要带上它自己的 session：favicon 代理据此继承
  // 该 profile 的 cookie / 登录态，而不是回落到全局默认 session。
  const target = session ? session.protocol : protocol
  target.handle(HIRA_SCHEME, (request) => serveHiraRequest(request, session || null))
}

