// @ts-check
/**
 * `hira-plugin://` 特权协议 —— 所有插件的渲染侧代码入口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它补的是哪一块
 * ══════════════════════════════════════════════════════════════════════
 * 第一方插件由 `scripts/build-plugins.ts` 预编译成独立 ESM，第三方插件由安装器落盘；
 * 两者都经本协议加载。渲染层是打包过的 ESM，没有 `fs`、也没法
 * `import('/abs/path/to.js')`
 * （Chromium 不接受任意本地路径，`file://` 在 `hira://` 页面里还会被 CORS 拒）。
 *
 * 所以第三方插件的渲染代码只能通过一个**特权协议**暴露给渲染层：
 *
 *   hira-plugin://<pluginId>/<相对插件目录的路径>?v=<renderVersion>
 *        │                    │
 *        │                    └─ 只能落在**该插件自己的目录里**（目录穿越直接 403）
 *        └─ 必须是**当前已启用**的插件（禁用后它的 URL 立刻失效）
 *
 * 与 `hira://` 的关系：同一套模式（特权 scheme 登记 + `session.protocol.handle`），
 * 特权登记统一在 `main/scheme-privileges.js`（全库只有那一次
 * `registerSchemesAsPrivileged` —— 多次调用会互相覆盖）。
 * 但**刻意分成两个协议**而不是复用 `hira://` 的一个 host：
 *   · 语义不同 —— `hira://` 是"应用自己的页面"，这里是"用户装的代码"；
 *   · 安全边界不同 —— 这里要能把"插件目录"这件事单独锁住，将来收紧（CSP、
 *     独立 session）时改动面只在这一个文件；
 *   · 可观测性 —— 出问题时看 URL 就知道是哪一类资源。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 安全边界（逐条都是必须的，不是"防御性编程"）
 * ══════════════════════════════════════════════════════════════════════
 *   · **目录穿越**：`../../../../etc/passwd` 必须 403。用 `path.resolve` 之后
 *     做前缀比较，而不是"把 `..` 过滤掉"（过滤法在编码变体下会漏）。
 *   · **扩展名白名单**：只允许渲染层真正需要的那几类。插件目录里可能同时还躺着
 *     作者的笔记、密钥、`.env` —— 不设白名单等于把它们全部暴露给页面。
 *   · **仅已启用**：`getPluginRoot` 只对启用中的插件返回路径。禁用后已发出的 URL
 *     立刻 404 —— 否则"禁用"只是摘掉了 provider，插件代码照样还在页面里跑。
 *   · **单文件上限**：插件不该拿一个几百 MB 的文件把渲染进程的内存吃光。
 *   · **缓存交给 URL 版本**：带 `?v=<mtime>` 的非标记资产长期缓存（immutable），
 *     没有版本参数的回 `no-cache` + ETag（每次校验、命中只回 304）。
 *     两者都不允许"浏览器自己猜" —— 猜错的后果是"作者改了代码但页面还是旧的"。
 */

import path from 'node:path'
import fs from 'node:fs'
import { protocol, type Session } from 'electron'
import {
  RASTER_IMAGE_EXTENSIONS,
  VECTOR_IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  FONT_EXTENSIONS,
  WEB_TEXT_EXTENSIONS,
  MARKUP_EXTENSIONS,
  EXT_MIME_TYPES
} from '@hira-ng/shared-types/src/media-extensions.mjs'
import { buildPanelUiCsp, normalizePermissionLevel, PANEL_UI_MAX_ENTRY_BYTES } from '@hira-ng/shared-types/src/plugin-ui.mjs'

const { fileResponse } = require('./asset-response') as {
  fileResponse(request: Request, filePath: string, options: {
    mime?: string
    maxBytes?: number
    cacheControl?: string
    headers?: Record<string, string>
  }): Promise<Response>
}
// 扩展名词表真源（与 hira-theme:// 共用同一份视频/位图清单）。
const EXT_MIME: Readonly<Record<string, string>> = EXT_MIME_TYPES

export interface PluginProtocolOptions {
  getPluginRoot(pluginId: string): string | null | undefined
  getPluginPermissionLevel?(pluginId: string): unknown
  logger?: { warn?(...args: unknown[]): void }
}

/** 协议名。改这里即改全局（scheme 注册、渲染侧 URL 生成同源）。 */
export const PLUGIN_SCHEME = 'hira-plugin'

/**
 * 允许从插件目录读出去的扩展名白名单。
 * 只列渲染层**真正需要**的那几类 —— 见文件头的安全边界说明。
 * 类别清单本身在 shared-types（与 `hira-theme://` 共用），这里只决定"允许哪几类"。
 */
export const ALLOWED_EXT: ReadonlySet<string> = Object.freeze(new Set<string>([
  ...WEB_TEXT_EXTENSIONS,
  ...VECTOR_IMAGE_EXTENSIONS,
  ...RASTER_IMAGE_EXTENSIONS,
  // 视频：主题插件可以用 `background.kind = 'video'` 声明动态壁纸 —— 与用户主题
  // 同一条链，所以这条协议也得发得出去。
  ...VIDEO_EXTENSIONS,
  ...FONT_EXTENSIONS,
  // 标记语言：面板 UI 可以直接用 `.html` / `.xaml` 交付界面（见 plugin-ui.mjs）。
  // 发得出去 ≠ 能当顶层文档跑：渲染层只会把它塞进无 `allow-same-origin` 的
  // `iframe.srcdoc`，并且响应本身也带派生 CSP（见下方 markup 分支）。
  ...MARKUP_EXTENSIONS
]))

/** 标记语言扩展名（响应要额外带安全头的那一类）。 */
const MARKUP_EXT: ReadonlySet<string> = Object.freeze(new Set<string>(MARKUP_EXTENSIONS))

/**
 * 单个**代码/文本**文件上限（2MB）—— 见文件头安全边界。渲染侧代码本来就该是几十 KB 量级。
 */
const MAX_BYTES = 2 * 1024 * 1024

/**
 * 单个**资产**文件上限（8MB，对齐 Vivaldi 主题包的 8MB 上限）。
 *
 * 为什么按扩展名分档而不是统一放宽：主题包的背景图是**用户自己拍的照片**，
 * 几 MB 是常态，卡在 2MB 会让"导入一个主题"直接失败；而 `.js` / `.json` 这类
 * 会被当作代码/数据读进渲染层的东西**不该**有 8MB 的额度 —— 那是一条能被
 * 用来一次性灌满内存的通道。
 *
 * ⚠ 放宽的只有**单文件体积**。安全边界一条不动：白名单（ALLOWED_EXT）、
 *   目录穿越守卫、以及"只有已启用的插件才读得到"。
 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024

/** 走"资产额度"的扩展名：图片与字体（视频另有更大的档，见 VIDEO_EXT）。 */
const ASSET_EXT = Object.freeze(new Set([
  ...VECTOR_IMAGE_EXTENSIONS,
  ...RASTER_IMAGE_EXTENSIONS,
  ...FONT_EXTENSIONS
]))

/**
 * 视频的额度（64MB）—— 与 `hira-theme://` 的 `MAX_VIDEO_BYTES` **同值**。
 *
 * 两处不一致的后果很隐蔽：同一条动态壁纸主题，用户自建的能加载、插件贡献的加载不出来
 * （或者反过来），而报错只有一句 413。动态壁纸是媒体文件，几十 MB 是常态，
 * 卡在 8MB 就等于"插件主题永远做不了视频背景"。
 */
const MAX_VIDEO_ASSET_BYTES = 64 * 1024 * 1024

/** 视频扩展名（与 EXT_MIME / ALLOWED_EXT 里的那几条对应）。 */
const VIDEO_EXT = Object.freeze(new Set(VIDEO_EXTENSIONS))

/** 某扩展名的单文件上限。 */
function maxBytesFor(ext: unknown): number {
  const e = String(ext || '').toLowerCase()
  if (VIDEO_EXT.has(e)) return MAX_VIDEO_ASSET_BYTES
  return ASSET_EXT.has(e) ? MAX_ASSET_BYTES : MAX_BYTES
}

/**
 * 构造协议处理器。
 *
 * @param {{
 *   getPluginRoot: (pluginId: string) => string | null,
 *   getPluginPermissionLevel?: (pluginId: string) => string | null,
 *   logger?: { warn?: Function }
 * }} options
 *   `getPluginRoot` 由 APPS 注入（它知道注册中心在哪）；**只对已启用插件返回路径**。
 *   `getPluginPermissionLevel` 可选：用于给 `.html` / `.xaml` 响应派生 CSP；
 *   缺省按最严格的 `none` 处理（宁可按"不能联网"发，也不放宽）。
 * @returns {(request: Request) => Promise<Response>}
 */
export function createPluginProtocolHandler(options: PluginProtocolOptions): (request: Request) => Promise<Response> {
  const logger = options.logger || console
  const getPluginRoot = options.getPluginRoot
  const getPluginPermissionLevel = options.getPluginPermissionLevel

  return async function handlePluginRequest(request: Request): Promise<Response> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch (_) {
      return new Response('Bad request', { status: 400 })
    }

    // standard scheme 的 host 由 Chromium 规范化过（已小写）；这里再兜一次，
    // 免得将来换成非 standard scheme 时出现"id 大小写不同 → 找不到插件"的玄学问题。
    const pluginId = String(url.hostname || '').toLowerCase()
    let rel = ''
    try { rel = decodeURIComponent(String(url.pathname || '').replace(/^\/+/, '')) } catch (_) {
      return new Response('Bad request', { status: 400 })
    }
    if (!pluginId || !rel) return new Response('Bad request', { status: 400 })

    let root = null
    try {
      root = typeof getPluginRoot === 'function' ? getPluginRoot(pluginId) : null
    } catch (e) {
      logger.warn?.('[plugin-protocol] getPluginRoot 失败：', e instanceof Error ? e.message : String(e))
      root = null
    }
    // 未安装 / 未启用 / 没有该插件 —— 一律 404（不区分，避免把"装了但没启用"这件事当探测器用）
    if (!root) return new Response('Not Found', { status: 404 })

    // ── 目录穿越守卫 ──────────────────────────────────────────────
    // resolve 之后再比前缀，而不是把 `..` 过滤掉：过滤法在 `%2e%2e` / 多重编码 /
    // Windows 的 `..\` 变体下会漏，而"解析到绝对路径再判断开头的目录"是唯一可靠的判据。
    const lexicalAbs = path.resolve(root, rel)
    let abs = ''
    let inside = false
    try {
      const realRoot = fs.realpathSync(root)
      abs = fs.realpathSync(lexicalAbs)
      const rootKey = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot
      const fileKey = process.platform === 'win32' ? abs.toLowerCase() : abs
      inside = fileKey === rootKey || fileKey.startsWith(rootKey + path.sep)
    } catch (_) {
      return new Response('Not Found', { status: 404 })
    }
    if (!inside) {
      logger.warn?.(`[plugin-protocol] 拒绝越界访问：${pluginId} → ${rel}`)
      return new Response('Forbidden', { status: 403 })
    }

    const ext = path.extname(abs).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      return new Response('Forbidden', { status: 403 })
    }

    /* 读取、分档限额、Range/206、流式返回 —— 与 `hira-theme://` 共用同一份实现
       （见 asset-response.js：视频必须支持 Range，两处各写一遍必然只补一处）。 */
    const isText = ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.css'
      // 标记语言也要带 charset：`.xaml` 里的中文标题不该靠浏览器猜编码。
      || MARKUP_EXT.has(ext)

    /* 标记语言文档**即使被直接导航**也不能裸奔：
       · `nosniff` 阻止"按内容猜类型"把资源当脚本执行；
       · CSP 由宿主的权限分级派生（插件自己声明的一律不认），默认 `default-src 'none'`。
       正常的 HTML/XAML 面板走的是 `iframe.srcdoc`，根本不会用到这里 —— 这一层是
       "作者把面板入口 URL 贴进地址栏"或"将来别的入口误用"时的兜底。 */
    const headers: Record<string, string> = {}
    if (MARKUP_EXT.has(ext)) {
      let permissionLevel = 'none'
      try {
        permissionLevel = normalizePermissionLevel(
          typeof getPluginPermissionLevel === 'function' ? getPluginPermissionLevel(pluginId) : null
        )
      } catch (_) {
        permissionLevel = 'none'
      }
      headers['X-Content-Type-Options'] = 'nosniff'
      headers['Content-Security-Policy'] = buildPanelUiCsp({ pluginId, permissionLevel })
    }

    /* 版本化（`?v=<mtime>`）的**非标记**资产可以长期缓存：URL 一变就换条目，
       这也是面板图片 / 字体 / 外链脚本的主要提速来源。
       标记语言（.html/.xaml）仍走 `no-store`：它的响应头里带**按权限派生的 CSP**，
       权限级别变化后不能让客户端继续用旧头；而面板入口本来就由渲染层带版本号读取。 */
    const versioned = url.searchParams.has('v') && !MARKUP_EXT.has(ext)

    return fileResponse(request, abs, {
      mime: `${EXT_MIME[ext] || 'application/octet-stream'}${isText ? '; charset=utf-8' : ''}`,
      maxBytes: Math.min(maxBytesFor(ext), MARKUP_EXT.has(ext) ? PANEL_UI_MAX_ENTRY_BYTES : Infinity),
      cacheControl: versioned ? 'private, max-age=31536000, immutable' : (MARKUP_EXT.has(ext) ? 'no-store' : 'no-cache'),
      headers
    })
  }
}

/**
 * 把处理器挂到某个 session 上。
 * @param {import('electron').Session} [session] 缺省 = 默认 session
 * @param {{ getPluginRoot: Function }} options
 */
export function registerPluginProtocol(
  session: Session | undefined,
  options: PluginProtocolOptions
): (request: Request) => Promise<Response> {
  const handler = createPluginProtocolHandler(options)
  const target = session ? session.protocol : protocol
  target.handle(PLUGIN_SCHEME, handler)
  return handler
}

/**
 * 生成渲染侧要 import 的 URL。
 *
 * 放在这里（与协议层同一个文件）而不是渲染层各拼各的：URL 形状是**协议与消费方
 * 之间的契约**，两处各写一份必然漂移（改了 host 规则、忘了带 `?v=` 就表现为
 * "作者改了代码但页面还是旧的"，最难查）。
 *
 * @param {string} pluginId
 * @param {string} renderPath manifest 里的相对路径（形如 `./panel.renderer.js`）
 * @param {number|string|null} [version] `renderVersion`（mtime）；有值就拼进 `?v=`
 * @returns {string}
 */
export function buildPluginAssetUrl(pluginId: unknown, renderPath: unknown, version?: number | string | null): string {
  const id = String(pluginId || '').toLowerCase()
  const rel = String(renderPath || '').replace(/^\.?\//, '')
  const base = `${PLUGIN_SCHEME}://${id}/${rel}`
  return version ? `${base}?v=${encodeURIComponent(String(version))}` : base
}

