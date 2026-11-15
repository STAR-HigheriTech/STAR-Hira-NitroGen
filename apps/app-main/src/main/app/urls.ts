/**
 * App: URL 入口（对齐 RT `src/main/app/urls.ts`）
 *
 * 冷启动期间到达的 URL 先入队，等「首个窗口（会话恢复或全新窗口）就绪」后再统一打开，
 * 避免「URL 处理器」与「会话恢复」各自创建窗口 → 出现两个窗口的竞态。
 *
 * ── 与 RT 的差异（必须保留）──────────────────────────────────────
 * RT 只认 http(s)；STAR Hira NitroGen 还挂了文件关联（.html / .pdf …），双击文档时命令行里
 * 送进来的是**本地绝对路径**。这里把它归一成 file:// URL，其余环节（实例转发、
 * 启动队列、appUrlOpener）就只面对一种形态 —— 归一化只发生在本文件。
 *
 * 本模块**无 Electron 依赖**：窗口/标签能力经 `openUrlInWindow` 端口注入，
 * 因此可脱离运行时单测，也符合「APPS 层编排、能力下沉到端口」的分层约定。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs') as {
  isHttpUrl(url: string): boolean
}
const { isAssociatedFilePath } = require('@hira-ng/shared-types/src/associations.mjs') as {
  isAssociatedFilePath(filePath: string): boolean
}

export interface UrlOpenOptions { incognito?: boolean }

interface PendingUrl {
  useNewWindow: boolean
  url: string
  incognito: boolean
}

export interface UrlRouterOptions {
  openUrlInWindow?: (useNewWindow: boolean, url: string, options?: UrlOpenOptions) => Promise<unknown> | unknown
}

export interface UrlRouter {
  isValidOpenerUrl(url: unknown): boolean
  normalizeOpenerTarget(value: unknown): string | null
  handleOpenUrl(useNewWindow: boolean, url: unknown, options?: UrlOpenOptions): Promise<void>
  flushPendingUrls(): Promise<void>
  processInitialUrl(argv: unknown): void
  hasNewWindowFlag(argv: unknown): boolean
  hasIncognitoFlag(argv: unknown): boolean
}

/**
 * 本地路径 → file:// URL。
 * 只接受「我们登记过的文件类型」的绝对路径，避免把 `--user-data-dir=x` 之类的
 * 参数、或任意本地路径当成用户要打开的目标（安全边界，不是宽松匹配）。
 * @param {unknown} value
 * @returns {string|null}
 */
function toFileUrl(value: unknown): string | null {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  if (/^file:\/\//i.test(text)) {
    try {
      return new URL(text).href
    } catch (_) {
      return null
    }
  }
  if (!path.isAbsolute(text)) return null
  if (!isAssociatedFilePath(text)) return null
  try {
    return pathToFileURL(text).href
  } catch (_) {
    return null
  }
}

/**
 * 系统关联入口送来的文件。
 *
 * 普通命令行仍只接受静态登记的扩展名（见 `toFileUrl`）；只有注册表命令显式带上
 * `--open-associated` 时才放行任意本地路径。这样运行期动态发现的新文件类型双击可用，
 * 但 `STAR Hira NitroGen.exe C:\secret.exe` 这类普通参数不会绕过原来的安全边界。
 */
function toAssociatedFileUrl(value: unknown): string | null {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  if (/^file:\/\//i.test(text)) {
    try {
      return new URL(text).href
    } catch (_) {
      return null
    }
  }
  if (!path.isAbsolute(text)) return null
  try {
    return pathToFileURL(text).href
  } catch (_) {
    return null
  }
}

/**
 * 归一化一个「可以拿去开标签页」的目标：
 *   · http(s) → 原样；
 *   · 登记过的本地文件（绝对路径 / file://）→ file:// URL；
 *   · 其它 → null。
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeOpenerTarget(value: unknown): string | null {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  if (isHttpUrl(text)) return text
  return toFileUrl(text)
}

/**
 * 是否是「可以拿去开标签页」的外部目标（http(s) 或登记过的本地文件）。
 * @param {unknown} url
 * @returns {boolean}
 */
export function isValidOpenerUrl(url: unknown): boolean {
  return normalizeOpenerTarget(url) !== null
}

/**
 * 从命令行参数里挑出可打开的目标（倒序，最后一个优先 —— 与 RT 一致）。
 * 开关参数（`-` / `--` 开头）一律跳过；返回值已归一化为 http(s) / file://。
 * @param {unknown} argv
 * @returns {string|null}
 */
export function pickOpenerUrlFromArgv(argv: unknown): string | null {
  const list = Array.isArray(argv) ? argv : []
  const associatedAt = list.findIndex((arg) => arg === '--open-associated')
  if (associatedAt >= 0) {
    for (let i = associatedAt + 1; i < list.length; i++) {
      const arg = list[i]
      if (typeof arg !== 'string' || !arg) continue
      if (isHttpUrl(arg)) return arg
      const fileUrl = toAssociatedFileUrl(arg)
      if (fileUrl) return fileUrl
      break
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const arg = list[i]
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) continue
    const target = normalizeOpenerTarget(arg)
    if (target) return target
  }
  return null
}

/**
 * 命令行里是否显式要求「新窗口」（Chromium 标准开关 `--new-window`）。
 * @param {unknown} argv
 * @returns {boolean}
 */
export function hasNewWindowFlag(argv: unknown): boolean {
  const list = Array.isArray(argv) ? argv : []
  return list.some((a) => a === '--new-window' || a === '-n')
}

/**
 * 命令行里是否要求无痕（Chromium 标准开关 `--incognito`）。
 * @param {unknown} argv
 * @returns {boolean}
 */
export function hasIncognitoFlag(argv: unknown): boolean {
  const list = Array.isArray(argv) ? argv : []
  return list.some((a) => a === '--incognito' || a === '-i')
}

/**
 * @param {{ openUrlInWindow?: (useNewWindow: boolean, url: string, opts?: object) => Promise<unknown>|unknown }} [deps]
 */
export function createUrlRouter({ openUrlInWindow }: UrlRouterOptions = {}): UrlRouter {
  const open = typeof openUrlInWindow === 'function' ? openUrlInWindow : async (): Promise<void> => {}
  let pendingStartupUrls: PendingUrl[] = []
  let startupComplete = false

  /**
   * 打开一个外部目标。启动未完成时先入队（见文件头说明）。
   * @param {boolean} useNewWindow
   * @param {unknown} url
   * @param {{ incognito?: boolean }} [opts]
   */
  async function handleOpenUrl(useNewWindow: boolean, url: unknown, opts: UrlOpenOptions = {}): Promise<void> {
    const target = normalizeOpenerTarget(url)
    if (!target) return
    const item = { useNewWindow: !!useNewWindow, url: target, incognito: opts.incognito === true }
    if (!startupComplete) {
      pendingStartupUrls.push(item)
      return
    }
    await open(item.useNewWindow, item.url, { incognito: item.incognito })
  }

  /**
   * 首个窗口就绪后调用：把启动期间排队的 URL 依次打开。
   */
  async function flushPendingUrls(): Promise<void> {
    startupComplete = true
    const urls = pendingStartupUrls
    pendingStartupUrls = []
    for (const item of urls) await open(item.useNewWindow, item.url, { incognito: item.incognito })
  }

  /**
   * 冷启动参数里的初始 URL（例如 `electron . https://x` / 双击 `.html`）。
   * 应在 whenReady 前调用。
   * @param {unknown} argv
   */
  function processInitialUrl(argv: unknown): void {
    const url = pickOpenerUrlFromArgv(argv)
    if (url) handleOpenUrl(hasNewWindowFlag(argv), url, { incognito: hasIncognitoFlag(argv) }).catch(() => {})
  }

  return {
    isValidOpenerUrl,
    normalizeOpenerTarget,
    handleOpenUrl,
    flushPendingUrls,
    processInitialUrl,
    hasNewWindowFlag,
    hasIncognitoFlag
  }
}

