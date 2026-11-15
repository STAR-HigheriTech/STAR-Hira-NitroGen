/**
 * main/open-external.js — 网页打开外部协议（mailto: / tel: / 自定义协议）的授权记录
 *
 * ── 为什么需要它 ───────────────────────────────────────────────
 * 网页点击 `mailto:xxx` / `someapp://xxx` 这类**非 http(s) 协议**时，Electron 会向
 * session 的 `setPermissionRequestHandler` 抛出一条 `permission === 'openExternal'`
 * 的权限请求（`details.requestingUrl` = 发起方页面，`details.externalURL` = 目标外部地址）。
 * NG 此前的权限处理器只认 notification/camera 等白名单类型，
 * `openExternal` 会被判为 unsupported → 一律拒绝 —— 即「外部链接点了没反应」。
 *
 * 本模块对齐 RT（saving/open-external.ts + sessions-controller/handlers）补齐这条链路：
 *   1. 命中「始终允许」记录 → 直接放行，不再打扰用户；
 *   2. 未命中 → 弹原生询问框（取消 / 打开 / 始终允许）；
 *   3. 选「始终允许」→ 把记录落盘，并供设置页列出 / 撤销。
 *
 * ── 为什么用 domain-settings 而不是新建存储 ────────────────────
 * 记录是「小体量、低频写、按 key 查」的键值数据，与设置完全同构；
 * domain-settings 本就是一个接受任意键的 JSON KV 存储（见其 set 注释），
 * 用一条独立前缀 `openExternal.always::` 与真正的设置项隔离即可。
 * 键结构沿用 RT 的 base64 方案（b64(请求方站点) + ':' + b64(协议)），
 * 使其与 RT 的 always-open-external datastore 可以互相迁移。
 * 前缀带 `openExternal.` 后，settings 的 changedKeys / cssVars 都不会误认它为设置项。
 *
 * 依赖 electron 的 dialog / BrowserWindow / app —— 这是 APPS 层（组合根）的既有做法，
 * 与 download-manager / http-auth 等主进程特性模块一致。
 */

const { app, dialog, BrowserWindow } = require('electron')
import type { MessageBoxOptions, WebContents } from 'electron'

/** 记录键前缀。独立命名空间，避免与真实设置项（app.* / privacy.* …）混在一起。 */
const KEY_PREFIX = 'openExternal.always::'

/** 撤销后写入的哨兵值：settings 的 KV 没有 delete，置 false 等价于「不再授权」。 */
const REVOKED = false

function toB64(s: unknown): string {
  return Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64')
}

function fromB64(s: unknown): string {
  try {
    return Buffer.from(String(s == null ? '' : s), 'base64').toString('utf8')
  } catch (_) {
    return ''
  }
}

/**
 * 请求方站点的可读标识 `protocol//host`（与 RT 的 minifiedUrl 同构）。
 * 取不到 host 时退回 origin；再取不到就原样返回 —— 只为展示与配对，不做安全判定。
 * 幂等：对已经是 `https://a.com` 的结果再调一次仍得同一串（撤销时用得上）。
 */
function siteOf(rawUrl: unknown): string {
  const raw = String(rawUrl == null ? '' : rawUrl)
  try {
    const u = new URL(raw)
    if (u.host) return u.protocol + '//' + u.host
    if (u.origin && u.origin !== 'null') return u.origin
    return raw
  } catch (_) {
    return raw
  }
}

/** 外部 URL 的协议（含尾冒号，如 `mailto:`）；解析失败返回空串。 */
function protocolOf(rawUrl: unknown): string {
  try {
    return new URL(String(rawUrl == null ? '' : rawUrl)).protocol
  } catch (_) {
    return ''
  }
}

interface OpenExternalSettings {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => unknown
  list: () => Record<string, unknown> | null | undefined
}

interface ExternalPermissionDetails {
  externalURL?: string
  requestingUrl?: string
  isMainFrame?: boolean
}

function createOpenExternalPermissions({
  settingsService
}: {
  settingsService: OpenExternalSettings
}) {
  if (!settingsService) throw new Error('[open-external] settingsService is required')

  /** 记录键：base64(站点) :: base64(协议) —— 两者都 base64 后，分隔符 `::` 不会与内容冲突。 */
  function keyOf(requestingUrl: unknown, openingProtocol: unknown): string {
    return KEY_PREFIX + toB64(siteOf(requestingUrl)) + '::' + toB64(openingProtocol)
  }

  /** 是否已对该「站点 × 协议」持久授权。 */
  function shouldAlwaysOpen(requestingUrl: unknown, externalUrl: unknown): boolean {
    const protocol = protocolOf(externalUrl)
    if (!protocol) return false
    return settingsService.get(keyOf(requestingUrl, protocol)) === true
  }

  /** 落盘一条「始终允许」。 */
  function setAlwaysOpen(requestingUrl: unknown, externalUrl: unknown): boolean {
    const protocol = protocolOf(externalUrl)
    if (!protocol) return false
    settingsService.set(keyOf(requestingUrl, protocol), true)
    return true
  }

  /**
   * 列出全部仍有效的授权记录。
   * 键/值都从 KV 现读现解，不另存一份内存索引 —— 单一真源在 settings。
   */
  function list(): Array<{ requestingURL: string; openingProtocol: string }> {
    const all = settingsService.list() || {}
    const out: Array<{ requestingURL: string; openingProtocol: string }> = []
    for (const key of Object.keys(all)) {
      if (!key.startsWith(KEY_PREFIX)) continue
      if (all[key] !== true) continue // 哨兵值 false = 已撤销，不出现在列表里
      const rest = key.slice(KEY_PREFIX.length)
      const sep = rest.indexOf('::')
      if (sep < 0) continue
      const requestingURL = fromB64(rest.slice(0, sep))
      const openingProtocol = fromB64(rest.slice(sep + 2))
      if (requestingURL && openingProtocol) out.push({ requestingURL, openingProtocol })
    }
    return out
  }

  /**
   * 撤销一条授权。
   * @returns {boolean} 是否确实撤销了一条（不存在 → false，供 UI 判断）
   */
  function unset(requestingURL: unknown, openingProtocol: unknown): boolean {
    const key = keyOf(requestingURL, openingProtocol)
    if (settingsService.get(key) !== true) return false
    settingsService.set(key, REVOKED)
    return true
  }

  /**
   * 处理一次 openExternal 权限请求：命中记录直接放行，否则弹原生询问框。
   */
  async function confirm(
    wc: WebContents,
    details: ExternalPermissionDetails
  ): Promise<boolean> {
    const externalUrl = details && details.externalURL
    if (!externalUrl) return false
    const requestingUrl = (details && details.requestingUrl) ||
      (wc && typeof wc.getURL === 'function' ? wc.getURL() : '') || ''

    if (shouldAlwaysOpen(requestingUrl, externalUrl)) return true

    // 与 Chrome / Edge 对齐的两道静默门禁（Electron 把 openExternal 完全交给宿主，
    // Chromium 自带的那两道判断不会发生，必须在这里补上）：
    //   1. 系统里没有该协议的处理程序 → 直接丢弃，不打扰用户。否则就会出现
    //      「页面后台探测 bitbrowser://、我们弹框、用户点打开、Windows 又说没有关联项」
    //      的无意义链路（真实 Chrome 在这种情况下连提示都不会有）。
    //   2. 非主框架发起的协议跳转 → 一律丢弃（广告 / 探测脚本常藏在 iframe 里）。
    if (details && details.isMainFrame === false) return false

    let appName = ''
    try {
      appName = app.getApplicationNameForProtocol(externalUrl) || ''
    } catch (_) {}
    if (!appName) return false

    const site = siteOf(requestingUrl)
    const protocol = protocolOf(externalUrl) || externalUrl
    const message = `“${site}” 想要使用 ${appName} 打开 ${protocol} 链接。`

    const opts: MessageBoxOptions = {
      type: 'question',
      buttons: ['取消', '打开', '始终允许'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      message,
      detail: externalUrl
    }

    let res
    try {
      const win = BrowserWindow.fromWebContents(wc)
      res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    } catch (error) {
      console.error('[open-external] 询问对话框失败:', error instanceof Error ? error.message : error)
      return false
    }

    const choice = res && typeof res.response === 'number' ? res.response : 0
    if (choice === 2) {
      setAlwaysOpen(requestingUrl, externalUrl)
      return true
    }
    return choice === 1
  }

  return { shouldAlwaysOpen, setAlwaysOpen, list, unset, confirm }
}

module.exports = { createOpenExternalPermissions, siteOf, protocolOf }
