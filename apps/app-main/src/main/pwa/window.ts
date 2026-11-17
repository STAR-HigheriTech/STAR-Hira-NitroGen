/**
 * PWA 应用窗 —— 「安装为应用」的窗口本体。
 *
 * ── 结构（与 peek 完全同构）─────────────────────────────────────────
 * 窗口自己的 `webContents` 只画 chrome 标题栏（subwindow 入口，`?type=pwa-app`）；
 * **网页本体是另一条 webContents** —— 贴在标题栏下方的 `WebContentsView`。
 *
 * 为什么不能直接 `win.loadURL(start_url)`：那样整块画布都归网页，自绘的
 * 图标 / 后退前进 / 刷新 / 菜单就没有地方画。标题栏高度只有渲染侧知道
 *（padding / 字体 / 图标尺寸共同决定），所以由 chrome 页量完上报
 *（`ngipc:send:pwa:chrome`），本模块据此落位 —— 与 peek 同一条思路。
 *
 * ── 本模块的边界 ────────────────────────────────────────────────────
 * 只认识「一个应用窗口」：建窗、贴视图、导航、几何、关闭。
 * **不认识** pwaService / profile / 卸载 / 更新 —— 那些是 `runtime.js` 的事。
 * 这样窗口可以单独复用（例如以后的「应用窗预览」），运行时也可以换成
 * 多窗口 / 多 profile 策略而不动这里。
 *
 * ── 导航策略（§8.2）────────────────────────────────────────────────
 *   · scope 内 → 留在应用窗里导航
 *   · scope 外的 http(s) → 交给系统浏览器，应用窗保持原样
 *   · 非 http(s) 协议 → 一律交给系统
 *   · `window.open` → 不新建 Electron 窗（deny）；scope 内则就地导航
 */

import {
  WebContentsView,
  screen,
  shell,
  clipboard,
  type BrowserWindow,
  type Event as ElectronEvent,
  type Session,
  type WebContents
} from 'electron'
import {
  createSubWindow,
  buildTabWebPreferences,
  navigateWebHistory,
  readWebNavigationState,
  type WindowRegistry
} from '@hira-ng/infra-window'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
// 错误页是 `data:` 独立文档（读不到外壳令牌）→ 直接用唯一字体栈的字面值。
import { UI_FONT_STACK } from '@hira-ng/shared-types/src/font-stack.mjs'
import { WINDOW_CONTROLS_OVERLAY_HEIGHT } from '@hira-ng/shared-types/src/layout.mjs'
import { rules, type PwaRecord, type PwaWindowState } from '@hira-ng/domain-pwa'
import { WINDOW_TYPES, WINDOW_CONFIG, resolveWindowUrl, type WindowConfigEntry } from '../window-config'
import { createWindowControlsPolicy } from '../window-controls-policy'
import { createPwaOverlayHost } from './overlay-host'
import { createPwaAppFeatures } from './app-features'
import * as identity from './identity'
import { buildRelaunchCommand } from '../app/pwa-args'
import { getRuntimeIdentity } from '../app/runtime-identity'
import type { PwaPaths } from './paths'
// 「算不算普通网页」的唯一判据（错误页重试 / 对外打开都用同一条）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'

/** 几何落盘防抖：拖窗口时 move 事件每帧都有，500ms 足够稳又不丢最后位置。 */
const GEOMETRY_DEBOUNCE_MS = 500

/**
 * chrome 页异常（脚本报错 / 加载失败）时永远不会上报高度，网页视图会一直不可见。
 * 这里给一个兜底：超时后按默认标题栏高度落位，宁可标题栏底部露一点白，
 * 也不能让用户看到一整块空白窗口。
 *
 * 高度直接取 WCO 常量（38）—— 与主浏览器顶部 chrome 行**同一条基线**，
 * 否则系统绘制的三颗按钮会和 PWA 自己的图标 / 菜单错开几像素。
 */
const DEFAULT_CHROME_HEIGHT = WINDOW_CONTROLS_OVERLAY_HEIGHT
const CHROME_FALLBACK_MS = 1500

function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 网络错误码 → 用户能看懂的一句话（Electron 的 desc 是英文，直接展示太生硬）。 */
function describeLoadError(code: unknown, description: unknown): string {
  const known: Readonly<Record<string, string>> = {
    '-7': '网络连接超时',
    '-102': '服务器拒绝连接',
    '-105': '无法解析服务器地址',
    '-106': '网络不可用',
    '-118': '连接超时',
    '-501': '服务器返回了无效响应'
  }
  return known[String(code)] || String(description || '').trim() || '无法加载此页面'
}

export interface PwaAccentThemeInfo {
  isDark?: boolean
  accentColor?: string
  onAccentColor?: string
}

interface PwaWindowGeometry extends PwaWindowState {
  width: number
  height: number
  maximized: boolean
}

interface PwaWindowFallback {
  width: number
  height: number
  minWidth?: number
  minHeight?: number
}

interface PwaSettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

export interface PwaAppWindowInput {
  record: PwaRecord
  profileId?: string
  paths: PwaPaths
  session?: Session | null
  spaceId?: string | null
  windowRegistry?: WindowRegistry<BrowserWindow> | null
  settingsService?: PwaSettingsPort | null
  onClosed?(appId: string): void
  onStateChange?(appId: string, state: PwaWindowState): void
  onOpenInBrowser?(url: string): void
  onUninstall?(appId: string): void
  printPage?(context: { wc: WebContents; title: string; url: string }): void
  getAccentThemeInfo?(context?: { appId: string; profileId: string }): PwaAccentThemeInfo | null
}

export interface PwaAppWindowNavigateInput {
  action?: string
  url?: string
  zoom?: unknown
}

export interface PwaAppWindowController {
  appId: string
  profileId: string
  win: BrowserWindow
  view: WebContentsView | null
  appName: string
  startUrl: string
  features: ReturnType<typeof createPwaAppFeatures>
  overlayHost: ReturnType<typeof createPwaOverlayHost>
  navigate(input?: PwaAppWindowNavigateInput): { ok: boolean; reason?: string }
  setChromeHeight(height: unknown): void
  pushWindowState(): void
  getWindowState(): PwaWindowState & {
    appId: string
    canGoBack: boolean
    canGoForward: boolean
    url: string
  }
  focus(): void
  flushGeometry(): void
  close(): void
  isAlive(): boolean
  ownsSender(sender: WebContents | null | undefined): boolean
  hasChrome(): boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSafeExternalWebUrl(value: unknown): boolean {
  try {
    const protocol = new URL(String(value || '')).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch (_) {
    return false
  }
}

/**
 * 应用窗内置错误页。
 *
 * 为什么要自己画：`did-fail-load` 之后 `WebContentsView` 是一片空白，用户
 * 只看到「窗口开着、内容没了」，既不知道发生了什么也没有重试入口。
 *
 * 为什么用 `data:` 而不是本地文件：应用窗没有 preload / 没有宿主桥，
 * 错误页必须**零依赖、零脚本**（不加载任何本地资源，也不给页面注入能力）。
 * 页面里只有一个指向失败地址的普通链接 —— 点击后走 `will-navigate`，
 * 与应用内其它导航同一条策略（scope 内留窗、scope 外交系统）。
 */
function buildLoadErrorPage({ appName, code, description, url, accentTheme }: {
  appName: unknown
  code: unknown
  description: unknown
  url: unknown
  accentTheme: PwaAccentThemeInfo | null
}): string {
  const safeName = escapeHtml(appName)
  const safeUrl = escapeHtml(url)
  const reason = escapeHtml(describeLoadError(code, description))
  // 应用窗没有 preload / 宿主桥，读不到外壳 CSS 令牌 → 强调色必须由调用方带值。
  // 取到主题信息就按「当前明暗」写死一套；取不到则退回 media query + 出厂蓝，
  // 保证错误页任何时候都画得出来。
  const safeAccent = accentTheme && accentTheme.accentColor ? escapeHtml(accentTheme.accentColor) : ''
  const safeOnAccent =
    accentTheme && accentTheme.onAccentColor ? escapeHtml(accentTheme.onAccentColor) : '#ffffff'
  const themeAttr = accentTheme ? ` data-theme="${accentTheme.isDark === true ? 'dark' : 'light'}"` : ''
  const accentDecl = safeAccent ? `--accent: ${safeAccent};` : '--accent: #3370ff;'
  const html = `<!doctype html>
<html lang="zh-CN"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${safeName}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f8fa; --fg: #1f2329; --muted: #646a73; --faint: #8f959e;
    --on-accent: ${safeOnAccent};
    ${accentDecl}
  }
  html[data-theme="dark"] { --bg: #1f1f1f; --fg: #e8e8e8; --muted: #a6a6a6; --faint: #7a7a7a; }
  @media (prefers-color-scheme: dark) {
    html:not([data-theme]) { --bg: #1f1f1f; --fg: #e8e8e8; --muted: #a6a6a6; --faint: #7a7a7a; --accent: #4e83fd; }
  }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--fg);
    font: 14px/1.6 ${UI_FONT_STACK};
  }
  .card { max-width: 440px; padding: 32px 28px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  p { margin: 0 0 16px; color: var(--muted); }
  .url { margin: 0 0 20px; font-size: 12px; color: var(--faint); word-break: break-all; }
  a {
    display: inline-block; padding: 7px 20px; border-radius: 6px;
    background: var(--accent); color: var(--on-accent); text-decoration: none;
    transition: filter .12s ease;
  }
  a:hover { filter: brightness(1.06); }
</style>
</head>
<body>
  <div class="card">
    <h1>${safeName} 暂时无法打开此页面</h1>
    <p>${reason}</p>
    <p class="url">${safeUrl}</p>
    <a href="${safeUrl}" rel="noreferrer">重试</a>
  </div>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/**
 * 恢复几何：宽度/高度做下限裁剪；x/y 只有**确实落在某块屏幕可见范围**时才采用
 *（显示器拔掉后旧坐标可能完全在屏幕外，窗口会「打开了却找不到」）。
 */
function sanitizeWindowState(state: PwaWindowState | null | undefined, fallback: PwaWindowFallback): PwaWindowGeometry {
  const src: PwaWindowState = state && typeof state === 'object' ? state : {}
  const width = Number(src.width)
  const height = Number(src.height)
  const out: PwaWindowGeometry = {
    width: Number.isFinite(width) && width >= (fallback.minWidth || 240) ? Math.round(width) : fallback.width,
    height: Number.isFinite(height) && height >= (fallback.minHeight || 160) ? Math.round(height) : fallback.height,
    maximized: src.maximized === true
  }
  const x = Number(src.x)
  const y = Number(src.y)
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const left = x
    const top = y
    const right = x + out.width
    const bottom = y + out.height
    let visible = false
    try {
      visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea
        // 至少露出 120×60 才算「看得见」——只压住一条边不算。
        return (
          left + 120 < area.x + area.width &&
          right - 120 > area.x &&
          top + 60 < area.y + area.height &&
          bottom - 60 > area.y
        )
      })
    } catch (_) {
      visible = false
    }
    if (visible) {
      out.x = Math.round(left)
      out.y = Math.round(top)
    }
  }
  return out
}

/**
 * 拼 chrome 页 URL。profile 必须显式带上（`p=`）：PWA 应用窗不注册窗口运行单元，
 * chrome 页无法从 ALS 解析 profile，图标协议的 `?p=` 是它唯一的 profile 线索。
 */
function chromeUrl({ record, profileId, iconUrl }: { record: PwaRecord; profileId: string; iconUrl?: string }): string {
  const base = resolveWindowUrl('subwindow', WINDOW_TYPES.PWA_APP)
  const params = new URLSearchParams()
  params.set('appId', record.id)
  params.set('p', String(profileId || 'default'))
  params.set('name', String(record.shortName || record.name || ''))
  if (record.themeColor) params.set('theme', String(record.themeColor))
  if (record.backgroundColor) params.set('bg', String(record.backgroundColor))
  if (iconUrl) params.set('icon', iconUrl)
  return `${base}&${params.toString()}`
}

/**
 * @param {object} input
 * @param {object} input.record             domain-pwa 的 toRecord 行（含 startUrl / scope / windowState / 图标绝对路径）
 * @param {string} input.profileId
 * @param {object} input.paths              createPwaPaths 的实例（图标 URL 唯一拼接点）
 * @param {Electron.Session} [input.session] 该 profile 的 session（网页视图与 chrome 共用）
 * @param {object} [input.windowRegistry]
 * @param {{get:(key:string)=>any}} [input.settingsService] 设置端口（WCO 模式 + 缩放记忆）
 * @param {(appId: string) => void} [input.onClosed]
 * @param {(appId: string, state: object) => void} [input.onStateChange]
 * @param {(url: string) => void} [input.onOpenInBrowser]
 * @param {(appId: string) => void} [input.onUninstall]
 * @param {(ctx: { wc: Electron.WebContents, title: string, url: string }) => void} [input.printPage]
 *        打印当前页面（主进程统一编排作业与预览窗口；缺省 = 应用窗没有打印能力）
 * @param {() => {isDark?: boolean, accentColor?: string, onAccentColor?: string}|null} [input.getAccentThemeInfo]
 *        强调色端口（主题服务唯一真源）。应用窗的加载错误页是零依赖 data: 页面，
 *        读不到外壳令牌，只能由这里带值；缺省时错误页退回系统明暗 + 出厂蓝。
 * @returns {object|null} 窗口控制器；建窗失败返回 null
 */
export function createPwaAppWindow(input: PwaAppWindowInput): PwaAppWindowController | null {
  const record = input.record
  if (!record || !record.id || !record.startUrl) return null
  const appId = String(record.id)
  const profileId = String(input.profileId || 'default')
  const appName = String(record.shortName || record.name || '应用')
  const scope = record.scope || rules.defaultScope(record.startUrl) || record.startUrl
  const getAccentThemeInfo = typeof input.getAccentThemeInfo === 'function' ? input.getAccentThemeInfo : null

  const cfg: WindowConfigEntry = WINDOW_CONFIG[WINDOW_TYPES.PWA_APP] || {}
  const state = sanitizeWindowState(record.windowState, {
    width: cfg.width || 1200,
    height: cfg.height || 800,
    minWidth: cfg.minWidth || 360,
    minHeight: cfg.minHeight || 240
  })

  // 图标只有一个来源：**磁盘上真实存在的资产**（不再猜 record.hasSmallIcon）。
  // 窗口图标走 .ico 优先，chrome 标题栏走位图优先 —— 同一份资产，两种用途。
  // 图标资产探测走 paths 的唯一口径（DB 里存的是相对文件名，不能直接当路径用）。
  const windowIconAsset = input.paths.resolveIconAsset(profileId, appId, input.paths.WINDOW_ICON_ORDER)
  const chromeIconAsset = input.paths.resolveIconAsset(profileId, appId, input.paths.UI_ICON_ORDER)
  let iconUrl = ''
  try {
    if (chromeIconAsset) iconUrl = input.paths.iconUrl(profileId, appId, chromeIconAsset.file)
  } catch (_) {
    iconUrl = ''
  }

  // WCO：与主浏览器同一个策略实例口径（读写 app.window_controls_style）。
  // native → titleBarOverlay，系统绘制三颗按钮；custom → 不传，走渲染侧自绘。
  const controlsPolicy = createWindowControlsPolicy(input.settingsService)

  let win: BrowserWindow
  try {
    ;({ win } = createSubWindow({
      ...cfg,
      ...(state.x != null ? { x: state.x, y: state.y } : {}),
      width: state.width,
      height: state.height,
      url: chromeUrl({ record, profileId, iconUrl }),
      windowType: WINDOW_TYPES.PWA_APP,
      windowRegistry: input.windowRegistry || undefined,
      parent: undefined,
      title: appName,
      ...(windowIconAsset ? { icon: windowIconAsset.full } : {}),
      // 两种窗口控件模式各自成对出现，绝不混搭：
      //   native → titleBarStyle:'hidden' + WCO 覆盖层（系统画三颗按钮）；
      //   custom → frame:false（无系统标题栏，渲染侧自绘那一簇）。
      // 若 custom 仍留着系统标题栏，就会出现「系统标题栏 + 自绘 chrome 行」双标题。
      ...(controlsPolicy.overlay ? { titleBarOverlay: controlsPolicy.overlay } : { frame: false })
    }))
  } catch (err) {
    console.error('[pwa] 创建应用窗口失败:', errorMessage(err))
    return null
  }
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null

  // native 模式下跟随系统明暗切换符号色；closed 自清理。
  try { controlsPolicy.attach(win) } catch (_) {}

  // 最大化必须在 show 之前：showOnReady 触发后用户先看到小窗再跳大会闪一下。
  if (state.maximized) {
    try { win.maximize() } catch (_) {}
  }

  // ── 任务栏身份：必须在第一次显示之前写入 ──────────────────────────
  // AUMID / 图标 / 重新启动命令行三处逐字符一致是「任务栏固定项能回到这个应用」的前提，
  // 生成点全部收敛在 identity.js + app/pwa-args.js（本文件不自己拼）。
  if (process.platform === 'win32' && getRuntimeIdentity().systemIntegrationEnabled && typeof win.setAppDetails === 'function') {
    try {
      win.setAppDetails({
        appId: identity.toAumid(appId),
        ...(windowIconAsset ? { appIconPath: windowIconAsset.full } : {}),
        relaunchCommand: buildRelaunchCommand({
          appId,
          profileId,
          spaceId: input.spaceId || null
        }),
        relaunchDisplayName: appName
      })
    } catch (err) {
      console.warn('[pwa] setAppDetails 失败（任务栏分组可能不准）:', errorMessage(err))
    }
  }

  // ── 网页本体 ──────────────────────────────────────────────────────
  let view: WebContentsView | null = null
  /** chrome 上报的标题栏高度（<= 0 表示还没收到）。 */
  let chromeHeight = 0
  let closed = false
  let geometryTimer: ReturnType<typeof setTimeout> | null = null
  let chromeFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let lastGeometryJson = ''
  /**
   * 错误页期间「真正想打开、但加载失败」的地址。
   * 非空 = 当前画面上是内置错误页（此时 wc.getURL() 是 data:，不能对外暴露）。
   * 一旦主框架开始加载任何真实 http(s) 地址就清空。
   */
  let errorUrl: string | null = null

  const pageWebContents = (): WebContents | null => {
    if (!view) return null
    try {
      const wc = view.webContents
      return wc && !wc.isDestroyed() ? wc : null
    } catch (_) {
      return null
    }
  }

  /** 对外展示的地址：错误页期间回落到失败前的真实 URL，绝不把 data: 泄露出去。 */
  const displayUrl = (wc: WebContents): string => {
    if (errorUrl) return errorUrl
    try { return wc.getURL() || record.startUrl } catch (_) { return record.startUrl }
  }

  // ── 浮层宿主（查找栏 / 缩放条）──────────────────────────────────────
  // 每个应用窗一份独立实例：PWA 窗不在 runtimeRegistry 里，复用主窗口的
  // layoutCoordinator 会让「应用窗 Ctrl+F」开到主窗口去（见 overlay-host.js 头注释）。
  // 网页矩形上边界 = chrome 上报高度，所以这里必须晚于 chromeHeight 声明。
  const overlayHost = createPwaOverlayHost({
    win,
    appId,
    getChromeHeight: () => chromeHeight,
    ...(input.session ? { session: input.session } : {})
  })

  // ── 桌面级能力包（查找 / 缩放 / 右键菜单 / 快捷键）─────────────────
  // 依赖全部注入：本文件不认识 IPC，能力包也不认识窗口几何。
  // 将来加新能力（打印 / 阅读模式）只改 app-features.js，这里只补参数。
  const features = createPwaAppFeatures({
    appId,
    win,
    getPageWebContents: pageWebContents,
    overlayHost,
    settings: input.settingsService || null,
    settingsService: input.settingsService || null,
    openExternal: (url: string) => {
      const target = String(url || '')
      if (!isSafeExternalWebUrl(target)) return
      try {
        if (typeof input.onOpenInBrowser === 'function') input.onOpenInBrowser(target)
        else shell.openExternal(target).catch(() => {})
      } catch (_) {}
    },
    shouldStayInWindow: (url: string) => {
      try { return rules.isInScope(url, scope) } catch (_) { return false }
    },
    // 错误页期间 Ctrl+R / 菜单里的「刷新」必须重试失败地址，而不是重载错误页本身。
    getRetryUrl: () => errorUrl,
    printPage: input.printPage
  })

  const placePage = (): void => {
    const wc = pageWebContents()
    if (!wc || !view || chromeHeight <= 0 || closed) return
    try {
      if (win.isDestroyed()) return
      const [width, height] = win.getContentSize()
      view.setBounds({
        x: 0,
        y: chromeHeight,
        width,
        height: Math.max(0, height - chromeHeight)
      })
      view.setVisible(true)
    } catch (_) {}
    // 网页矩形就是浮层的坐标系：视图一动，查找栏 / 缩放条必须跟着重新落位，
    // 否则窗口 resize 后它们会停在旧位置（甚至跑出窗口外）。
    overlayHost.relayout()
  }

  const pushWindowState = (): void => {
    const wc = pageWebContents()
    if (!wc) return
    let payload: {
      appId: string
      url: string
      title: string
      canGoBack: boolean
      canGoForward: boolean
      isLoading: boolean
      isMaximized: boolean
      isFullScreen: boolean
      zoom: number
    }
    try {
      const navigation = readWebNavigationState(wc)
      payload = {
        appId,
        url: displayUrl(wc),
        title: wc.getTitle() || appName,
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        isLoading: wc.isLoading(),
        isMaximized: win.isMaximized(),
        isFullScreen: win.isFullScreen(),
        zoom: wc.getZoomFactor()
      }
    } catch (_) {
      return
    }
    try {
      if (!win.isDestroyed()) win.webContents.send(`ngipc:event:${IPC_EVENTS.pwaWindowState}`, payload)
    } catch (_) {}
  }

  // ── 几何：防抖落盘 ────────────────────────────────────────────────
  const currentGeometry = (): PwaWindowGeometry | null => {
    let bounds
    try {
      // 最大化时存「还原后的矩形」：下次打开按普通尺寸恢复再 maximize，
      // 否则用户取消最大化后窗口会停在一块奇怪的大小上。
      bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    } catch (_) {
      return null
    }
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: (() => { try { return win.isMaximized() } catch (_) { return false } })()
    }
  }

  const flushGeometry = (): void => {
    if (geometryTimer) {
      clearTimeout(geometryTimer)
      geometryTimer = null
    }
    if (closed) return
    const geometry = currentGeometry()
    if (!geometry) return
    const json = JSON.stringify(geometry)
    if (json === lastGeometryJson) return
    lastGeometryJson = json
    try {
      if (typeof input.onStateChange === 'function') input.onStateChange(appId, geometry)
    } catch (err) {
      console.warn('[pwa] 保存窗口几何失败:', errorMessage(err))
    }
  }

  const scheduleGeometry = (): void => {
    if (closed) return
    if (geometryTimer) clearTimeout(geometryTimer)
    geometryTimer = setTimeout(flushGeometry, GEOMETRY_DEBOUNCE_MS)
    pushWindowState()
  }

  // ── 导航动作 ──────────────────────────────────────────────────────
  const navigate = (req: PwaAppWindowNavigateInput = {}): { ok: boolean; reason?: string } => {
    const wc = pageWebContents()
    if (!wc) return { ok: false, reason: '窗口已关闭' }
    const action = String(req.action || '')
    try {
      switch (action) {
        case 'back':
          if (!navigateWebHistory(wc, 'back')) return { ok: false, reason: '没有可后退的页面' }
          break
        case 'forward':
          if (!navigateWebHistory(wc, 'forward')) return { ok: false, reason: '没有可前进的页面' }
          break
        case 'reload':
          // 错误页不是「当前页面」：刷新语义 = 重试失败的真实地址。
          if (errorUrl) void wc.loadURL(errorUrl).catch(() => {})
          else wc.reload()
          break
        case 'stop':
          wc.stop()
          break
        case 'home':
          void wc.loadURL(record.startUrl).catch(() => {})
          break
        case 'devtools':
          wc.openDevTools({ mode: 'detach' })
          break
        case 'print':
          features.print()
          break
        case 'copy-url':
          clipboard.writeText(displayUrl(wc))
          break
        case 'open-in-browser':
          {
            const target = displayUrl(wc)
            if (!isSafeExternalWebUrl(target)) return { ok: false, reason: '当前页面不是可外开的网页' }
            if (typeof input.onOpenInBrowser === 'function') input.onOpenInBrowser(target)
            else void shell.openExternal(target).catch(() => {})
          }
          break
        case 'open-external': {
          const target = String(req.url || displayUrl(wc))
          try {
            const protocol = new URL(target).protocol
            if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' || protocol === 'tel:') {
              void shell.openExternal(target).catch(() => {})
            }
          } catch (_) {}
          break
        }
        case 'zoom': {
          const zoom = Number(req.zoom)
          if (Number.isFinite(zoom) && zoom > 0) wc.setZoomFactor(zoom)
          break
        }
        case 'uninstall':
          if (typeof input.onUninstall === 'function') input.onUninstall(appId)
          break
        case 'url':
        case 'navigate': {
          const target = String(req.url || '').trim()
          if (target) void wc.loadURL(target).catch(() => {})
          break
        }
        default:
          // 没有 action 但带了 url：当作地址栏导航。
          if (req.url) void wc.loadURL(String(req.url)).catch(() => {})
          else return { ok: false, reason: '未知动作' }
      }
      pushWindowState()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: errorMessage(err) }
    }
  }

  try {
    view = new WebContentsView({
      webPreferences: buildTabWebPreferences({
        // 应用窗没有标签那一整套宿主接线（右键菜单 / JS 对话框桥 / 跳转钩子都在
        // 主窗口的 tabEvents 上），注入 tab-preload 只会让页面弹窗没人应答。
        preload: false,
        ...(input.session ? { session: input.session } : {})
      })
    })
    win.contentView.addChildView(view)
    view.setVisible(false)
    view.setBackgroundColor(record.backgroundColor || '#ffffff')
  } catch (err) {
    console.error('[pwa] 创建应用网页视图失败:', errorMessage(err))
    view = null
  }

  // 网页视图是能力包的最后一块拼图（快捷键 / Ctrl+滚轮 / 右键 / 查找都挂在它上面）。
  if (view) features.attachPage(view.webContents)

  if (view) {
    const wc = view.webContents

    // 导航策略（§8.2）：scope 内留窗，其余交给系统。
    wc.on('will-navigate', (event: ElectronEvent, url: string) => {
      try {
        if (rules.isInScope(url, scope)) return
      } catch (_) {}
      event.preventDefault()
      if (isSafeExternalWebUrl(url)) shell.openExternal(url).catch(() => {})
    })
    wc.setWindowOpenHandler(({ url }: { url: string }) => {
      try {
        if (rules.isInScope(url, scope)) {
          void wc.loadURL(url).catch(() => {})
        } else if (isSafeExternalWebUrl(url)) {
          shell.openExternal(url).catch(() => {})
        }
      } catch (_) {}
      return { action: 'deny' }
    })

    wc.on('page-title-updated', (_event: ElectronEvent, title: string) => {
      const text = String(title == null ? '' : title).trim()
      try { if (!win.isDestroyed()) win.setTitle(text || appName) } catch (_) {}
      pushWindowState()
    })
    wc.on('did-start-loading', pushWindowState)
    wc.on('did-stop-loading', pushWindowState)
    let htmlFullscreen = false
    const setHtmlFullscreen = (active: boolean): void => {
      const next = Boolean(active)
      if (next === htmlFullscreen) return
      htmlFullscreen = next
      if (!win.isDestroyed()) {
        try { win.setFullScreen(next) } catch {}
      }
      placePage()
    }
    wc.on('enter-html-full-screen', () => setHtmlFullscreen(true))
    wc.on('leave-html-full-screen', () => setHtmlFullscreen(false))
    // 主框架开始真实导航 = 错误页使命结束（错误页自身是 data:，不算）。
    // 仓库内 did-start-navigation 存在两种签名（位置参数 / details 对象），这里都兼容。
    wc.on('did-start-navigation', (...args: unknown[]) => {
      const first = args[0]
      const details = first && typeof first === 'object'
        ? first as { url?: unknown; isMainFrame?: unknown; isSameDocument?: unknown; isInPlace?: unknown }
        : null
      const targetUrl = details && typeof details.url === 'string' ? details.url : args[1]
      const isSameDocument = details ? (details.isSameDocument === true || details.isInPlace === true) : args[2]
      const isMainFrame = details && typeof details.isMainFrame === 'boolean' ? details.isMainFrame : args[3]
      if (isMainFrame === false || isSameDocument) return
      if (isHttpUrl(targetUrl)) errorUrl = null
    })
    wc.on('did-navigate', pushWindowState)
    wc.on('did-navigate-in-page', pushWindowState)
    wc.on('did-fail-load', (_event: ElectronEvent, code: number, desc: string, failedUrl: string, isMainFrame: boolean) => {
      // -3 是「主动中止」（比如点了停止），不是错误。
      if (isMainFrame !== false && code !== -3) {
        console.warn('[pwa] 应用页加载失败:', code, desc, failedUrl)
        const target = String(failedUrl || '')
        // 只给真实网页画错误页：data:/file: 之类失败不在这里兜（也不是用户地址）。
        if (isHttpUrl(target)) {
          errorUrl = target
          let accentTheme = null
          if (getAccentThemeInfo) {
            try { accentTheme = getAccentThemeInfo({ appId, profileId }) } catch (_) { accentTheme = null }
          }
          try {
            wc.loadURL(buildLoadErrorPage({ appName, code, description: desc, url: target, accentTheme })).catch(() => {})
          } catch (_) {}
        }
      }
      pushWindowState()
    })
  }

  // ── chrome 高度上报 ───────────────────────────────────────────────
  // 走**全局路由** `pwa:chrome`（ipc/pwa.js）→ runtime.setChromeHeight：
  // 这里不再另挂 `win.webContents.ipc`，否则同一份上报会有两条落位路径。
  const setChromeHeight = (height: unknown): void => {
    const value = Math.max(0, Math.round(Number(height) || 0))
    if (value === chromeHeight) return
    chromeHeight = value
    placePage()
  }

  // 兜底落位：chrome 页在超时前仍未上报高度就按默认值铺开网页视图。
  chromeFallbackTimer = setTimeout(() => {
    chromeFallbackTimer = null
    if (closed || chromeHeight > 0) return
    setChromeHeight(DEFAULT_CHROME_HEIGHT)
  }, CHROME_FALLBACK_MS)

  win.on('resize', () => { placePage(); scheduleGeometry() })
  win.on('app-command', (_event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return
    navigateWebHistory(pageWebContents(), command === 'browser-backward' ? 'back' : 'forward')
  })
  win.on('move', scheduleGeometry)
  win.on('maximize', () => { placePage(); scheduleGeometry() })
  win.on('unmaximize', () => { placePage(); scheduleGeometry() })
  win.on('enter-full-screen', placePage)
  win.on('leave-full-screen', placePage)
  win.on('focus', pushWindowState)
  // `close` 在窗口销毁**之前**触发 —— 这是最后一次能读到真实 bounds 的时机。
  win.on('close', flushGeometry)

  win.on('closed', () => {
    closed = true
    // 顺序不能反：能力包的 dispose 还要用浮层宿主收栏 / 交还焦点，
    // 必须先收能力包，再销毁浮层视图。
    try { features.dispose() } catch (_) {}
    try { overlayHost.destroy() } catch (_) {}
    if (geometryTimer) {
      clearTimeout(geometryTimer)
      geometryTimer = null
    }
    if (chromeFallbackTimer) {
      clearTimeout(chromeFallbackTimer)
      chromeFallbackTimer = null
    }
    // 关闭前最后一笔几何必须落下（防抖窗口里的最后一次拖动不能丢）——
    // 但此时窗口已销毁，getBounds 会抛错，所以用 closed 之前缓存的值。
    try {
      if (typeof input.onClosed === 'function') input.onClosed(appId)
    } catch (err) {
      console.warn('[pwa] 关闭回调失败:', errorMessage(err))
    }
    try {
      if (view && !view.webContents.isDestroyed()) view.webContents.close()
    } catch (_) {}
    view = null
  })

  if (view) {
    const target = String(record.startUrl)
    view.webContents.loadURL(target).catch((err) => {
      console.warn('[pwa] 加载 start_url 失败:', errorMessage(err))
    })
  }

  return {
    appId,
    profileId,
    win,
    view,
    appName,
    startUrl: record.startUrl,
    /** 桌面级能力包（查找 / 缩放 / 右键菜单 / 快捷键）。 */
    features,
    /** 浮层宿主（IPC 落 display / hide 时必须拿到它）。 */
    overlayHost,
    navigate,
    setChromeHeight,
    pushWindowState,
    /** 当前窗口真实状态（IPC `pwa:get-window-state` 用）。 */
    getWindowState() {
      const geometry = currentGeometry()
      return {
        ...(geometry || {}),
        appId,
        canGoBack: (() => {
          try { return !!pageWebContents()?.navigationHistory.canGoBack() } catch (_) { return false }
        })(),
        canGoForward: (() => {
          try { return !!pageWebContents()?.navigationHistory.canGoForward() } catch (_) { return false }
        })(),
        url: (() => {
          const wc = pageWebContents()
          return wc ? displayUrl(wc) : (errorUrl || record.startUrl)
        })()
      }
    },
    focus() {
      if (closed || win.isDestroyed()) return
      try {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      } catch (_) {}
      pushWindowState()
    },
    /** 关闭前把几何立即写盘（卸载 / 退出时调用，不等防抖）。 */
    flushGeometry,
    close() {
      try { if (!win.isDestroyed()) win.close() } catch (_) {}
    },
    isAlive() {
      return !closed && !win.isDestroyed()
    },
    /** sender 是否属于本应用窗（chrome / 网页 / 浮层）。 */
    ownsSender(sender: WebContents | null | undefined) {
      try { return features.ownsSender(sender) } catch (_) { return false }
    },
    /** chrome 是否已上报过高度（诊断用）。 */
    hasChrome: () => chromeHeight > 0
  }
}
