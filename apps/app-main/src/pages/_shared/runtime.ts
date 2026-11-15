/**
 * hira:// 内部页 · 公共运行时（ES Module）
 *
 * 设计约束：
 *  - 纯 ES Module 具名导出，**不往 window 上挂任何东西**（宪法 C05：0 业务全局变量）
 *  - 只放跨页面重复的逻辑，页面特有的渲染一律留在各自 <host>.js
 *  - 通过 hira://shared/runtime.js 加载（协议层给 hira:// 静态响应带 ACAO，跨 host 可 import）
 *
 * 用法：
 *   <script type="module" src="./<host>.js"></script>
 *   import { rpc, el, fmtTime } from 'hira://shared/runtime.js'
 */

/**
 * 调用主进程 Provider 路由。等价于 window.hira.provider.invoke，但带桥可用性守卫。
 * @param {string} route   如 'history:list'
 * @param {object} [payload]
 * @returns {Promise<unknown>}
 */

// 通道表**不再手抄**：electron.vite.config.js 的 sync-shared-contracts 插件会把
// canonical 契约表复制成 out/pages/_shared/ipc-channels.mjs（即 hira://shared/ipc-channels.mjs）。
// 于是「内部页通道名」与「主进程/渲染层通道名」永远出自同一份文件，不会再漂移。
// 本地 import 是为了本文件里 popupMenu 直接用；再 export 一次给各内部页。
import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
export { IPC_ROUTES, IPC_EVENTS }

// 体积文本的唯一真源（同样由 sync-shared-contracts 复制到 out/pages/_shared/）：
// 标签 hover 预览浮层要显示的是**同一个数**（Electron 进程内存 KB），
// 两处各留一份取整规则必然漂移，故内部页也从这份 canonical 实现转发。
import { formatBytes } from '@hira-ng/shared-types/src/format-size.mjs'

// 图标的两条真源（同样由 sync-shared-contracts 复制到 out/pages/_shared/）：
// 站点图标来源解析 / 下载项文件图标。面板（ui-common）import 的是**同一份文件**，
// 所以「内部页怎么画图标」与「面板怎么画图标」不会再有第二套规则。
import { createFaviconImg, faviconSourceCandidates } from '@hira-ng/shared-types/src/favicon-src.mjs'
import { createFileIcon, createFileIconLoader } from '@hira-ng/shared-types/src/file-icon.mjs'

// 背景层渲染器（图片 / 渐变 / 视频）—— 与外壳、编辑器预览共用**同一份**代码
// （canonical 真源在 packages/shared-types/src/theme-background.mjs）。
// 内部页是未打包的静态页，只能靠 sync-shared-contracts 把它复制过来 —— 见那里的说明。
// 普通内部页不自己画壁纸：窗口外壳那一份是唯一的（见 initThemeWallpaperFlag）。
// 独立窗口没有外壳，可用 initThemeBackground 复用同一份渲染器。
import { applyThemeBackground } from '@hira-ng/shared-types/src/theme-background.mjs'
// 主题设置键名的真源（与主进程 applier / 域层默认值同一份）。
import { THEME_SETTING_KEYS, normalizeThemeMode } from '@hira-ng/shared-types/src/theme.mjs'

// 内部页外壳（左侧导航）。**所有**内部页都 import 本文件，所以在模块求值时挂一次即可：
// 未登记的页面（newtab / error / pdf / jsdialog…）在 mountShell 里第一行就 return，
// 页面自己一行都不用改，也不会各写一套入口列表（真源见 _shared/shell-registry.ts）。
import { mountShell } from './shell.js'

// 点击打开意图（Ctrl/Cmd/中键 → 后台新标签 …）的唯一规则源。
// 与网页侧 Chromium 的 disposition 口径对齐；各页面**不再**自己判断修饰键。
import { LINK_INTENT, resolveLinkIntent, type LinkIntentEvent } from '@hira-ng/shared-types/src/link-intent.mjs'

export interface PageMenuItem {
  label?: string
  action?: string
  enabled?: boolean
  type?: 'separator'
  submenu?: PageMenuItem[]
}

export interface ThemeBackgroundSpec {
  visible?: boolean
  mode?: 'none' | 'css' | 'video'
  videoSrc?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  backgroundRepeat?: string
  opacity?: string | number
  filter?: string
  overlayColor?: string
  [key: string]: unknown
}

export interface ThemeBackground {
  window?: ThemeBackgroundSpec | null
  newtab?: ThemeBackgroundSpec | null
  [scope: string]: ThemeBackgroundSpec | null | undefined
}

export interface ThemeSurface {
  material?: string
  applied?: boolean
  supported?: boolean
  reason?: string
  message?: string
}

export interface ThemePayload {
  mode?: string
  tokens?: Record<string, string> | null
  background?: ThemeBackground | null
  surface?: ThemeSurface | null
}

export interface PageRpcRecord {
  [key: string]: unknown
  ok?: boolean
  error?: unknown
  message?: unknown
  reason?: unknown
  code?: unknown
  key?: string
  scope?: string
  id?: string
  name?: string
  title?: string
  text?: string
  source?: string
  path?: string
  svg?: string
  apiKey?: string
  level?: string
  session?: PageRpcRecord
  model?: PageRpcRecord
  reasoning?: PageRpcRecord
  approval?: PageRpcRecord
  value?: unknown
  default?: string
  defaultTemplate?: string
  searchActions?: PageRpcRecord[]
  items?: PageRpcRecord[]
  sessions?: PageRpcRecord[]
  providers?: PageRpcRecord[]
  tabs?: PageRpcRecord[]
  games?: PageRpcRecord[]
  gestures?: PageRpcRecord[]
  engines?: PageRpcRecord[]
  groups?: PageRpcRecord[]
  themes?: PageRpcRecord[]
  sources?: PageRpcRecord[]
  entries?: PageRpcRecord[]
  skills?: PageRpcRecord[]
  kinds?: PageRpcRecord[]
  keys?: PageRpcRecord[]
  metrics?: PageRpcRecord
  theme?: PageRpcRecord | null
  job?: PageRpcRecord
  pdfUrl?: string
  canceled?: boolean
  cascade?: boolean
  overwrite?: boolean
  force?: boolean
  imported?: number
  skipped?: number
  formats?: PageRpcRecord[]
}

export function subscribe<T = unknown>(event: string, listener: (payload: T) => void): () => void {
  const bridge = window.hira
  if (!bridge || !bridge.on || typeof bridge.on.subscribe !== 'function') {
    return () => {}
  }
  return bridge.on.subscribe(event, listener)
}

export function rpc<T = PageRpcRecord>(route: string, payload?: unknown): Promise<T> {
  const bridge = window.hira
  if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') {
    return Promise.reject(new Error('hira bridge unavailable'))
  }
  return bridge.provider.invoke<T>(route, payload)
}

/**
 * 内部页 · 打开链接的**唯一出口**（所有内部页都走这里，规则只有一份）。
 *
 * 为什么需要它：网页里的 Ctrl+点击由 Chromium 原生处理（disposition =
 * `background-tab`），内部页的链接却是页面自己的 JS 打开的 —— 以前一律
 * `nav:go`，于是「Ctrl+点击开新标签」在内部页整体失效（把当前页顶掉）。
 *
 * 意图由 `link-intent.mjs` 判定（与 Chrome 同口径）：
 *   current → 当前标签页；background → 后台新标签；foreground → 前台新标签；
 *   window → 新窗口（内部页没有"带地址开窗口"的通道，降级为**前台新标签**，
 *            绝不静默丢动作）。
 *
 * @param {string} url
 * @param {unknown} [event] 触发这次打开的鼠标事件（缺省 = 当前标签页，保持旧行为）
 * @returns {Promise<void>}
 */
export async function openLink (url?: string, event?: LinkIntentEvent | null): Promise<void> {
  if (!url) return
  const intent = resolveLinkIntent(event)
  if (intent !== LINK_INTENT.CURRENT) {
    try {
      await rpc(IPC_ROUTES.tabNew, {
        url,
        openInBackground: intent === LINK_INTENT.BACKGROUND
      })
      return
    } catch (_) { /* 桥不可用 / 路由失败 → 落到当前标签页，至少别让点击没反应 */ }
  }
  try {
    await rpc(IPC_ROUTES.navGo, { url })
  } catch (_) {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/**
 * 内部页的「修饰键 / 中键点链接」统一接管（模块求值时挂一次，见文件末尾）。
 *
 * 内部页大量使用裸 `<a href>`：它们由 Chromium 自己导航 —— 而 Chromium 在
 * 内部页里遇到 Ctrl+点击时只会（或不会）在**当前标签页**换地址，
 * 浏览器语义上的"新标签"根本不会发生。所以这里在捕获阶段统一改道到 openLink，
 * 让"网页里能新标签打开"的同一个手势在内部页同样成立。
 *
 * 只接管 http(s) / hira 链接、且只在**有修饰键 / 中键**时接管：
 * 普通左键保持 Chromium 原生行为，页面自己的普通点击逻辑一行都不受影响。
 */
function installLinkClicks () {
  if (typeof document === 'undefined' || !document.addEventListener) return

  /** @returns {string} 命中的链接地址；不该接管时返回 '' */
  const pickLink = (event: MouseEvent): string => {
    if (resolveLinkIntent(event) === LINK_INTENT.CURRENT) return ''
    const target = event.target
    if (!(target instanceof Element)) return ''
    const anchor = target.closest('a[href]') as HTMLAnchorElement | null
    if (!anchor) return ''
    const raw = anchor.getAttribute('href') || ''
    // 只处理真实地址：`#anchor` / `javascript:` / `mailto:` 等交给页面自己。
    if (!/^(https?|hira):/i.test(raw)) return ''
    return anchor.href || raw
  }

  const route = (event: MouseEvent): void => {
    if (event.defaultPrevented) return
    const url = pickLink(event)
    if (!url) return
    // 先断掉页面自己的 click 逻辑（否则会既开新标签、又把当前页导航走）。
    event.preventDefault()
    event.stopPropagation()
    openLink(url, event)
  }

  document.addEventListener('click', route, true)
  // 中键不触发 click（Chromium 发 auxclick）：辅助键口径相同。
  document.addEventListener('auxclick', (event: MouseEvent) => {
    if (event.button === 1) route(event)
  }, true)
}

/**
 * 内部页 · 弹出**原生上下文菜单**，返回被选中的 action（未选中 / 关闭 → null）。
 *
 * 为什么要它：右键菜单必须与浏览器其它地方**同一个形状**（原生 Menu），
 * 在页面里自绘一块浮层去冒充菜单是另一套观感与另一套键盘行为。
 * 这条链路与渲染层 `renderer/shared/menu-client.js` 完全同源：
 *   · `ui:popup-menu` 只负责弹，invoke **立即返回**；
 *   · 用户选中的 action 经 `ui:popup-menu-selected` 按 requestId 单向回传。
 * 内部页拿不到 `renderer/shared`（不是打包产物），所以在公共运行时里留这一份薄壳 ——
 * 规则仍然只有一份（通道名、非阻塞协议都来自 canonical 契约表）。
 *
 * items 形状与渲染层一致：`{ label, action }` / `{ type: 'separator' }` / `{ label, submenu: [...] }`。
 *
 * @param {{ items: unknown[], x?: number, y?: number, context?: { kind: string, snapshot?: object } }} arg
 * @returns {Promise<string|null>}
 */
let menuSeq = 0
export function popupMenu ({ items, x, y, context }: {
  items: PageMenuItem[]
  x?: number
  y?: number
  context?: { kind: string; snapshot?: object }
} ): Promise<string | null> {
  const bridge = window.hira
  if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') {
    return Promise.resolve(null)
  }
  const requestId = `menu_${Date.now().toString(36)}_${(menuSeq++).toString(36)}`
  return new Promise<string | null>((resolve) => {
    let done = false
    let unsubscribe: () => void = () => {}
    const finish = (action?: string | null | undefined): void => {
      if (done) return
      done = true
      unsubscribe()
      resolve(action || null)
    }
    if (bridge.on && typeof bridge.on.subscribe === 'function') {
      unsubscribe = bridge.on.subscribe<{ requestId?: string; action?: string | null }>(IPC_EVENTS.uiPopupMenuSelected, (payload) => {
        if (!payload || payload.requestId !== requestId) return
        finish(payload.action)
      })
    }
    bridge.provider.invoke(IPC_ROUTES.uiPopupMenu, { items, x, y, requestId, context }).catch(() => finish(null))
  })
}

/**
 * 创建元素的小工具，替代成串的 createElement / className / textContent 赋值。
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string | number
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

/**
 * 清空容器并放入一行空状态提示（DOM 与旧的 innerHTML 写法等价）。
 * @param {HTMLElement} container
 * @param {string} text
 */
export function renderEmpty (container: HTMLElement, text = ''): void {
  container.textContent = ''
  container.appendChild(el('div', 'empty', text))
}

/**
 * 时间戳 → 本地时间字符串。空值返回空串。
 * @param {number|string|Date} ts
 * @returns {string}
 */
export function fmtTime (ts?: number | string | Date | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString()
}

/**
 * 字节数 → 人类可读体积。空值返回空串。
 *
 * 实现已上移到 `packages/shared-types/src/format-size.mjs`（唯一真源，见那里的说明）。
 * 这里保留 `fmtSize` 这个既有名字与签名，因此既有页面（下载 / 导入数据 / 任务管理器…）
 * 一行都不用改，显示文本也一字未变。
 * @param {number} bytes
 * @returns {string}
 */
export const fmtSize: (bytes?: number | null | undefined) => string = formatBytes

/**
 * 站点 favicon 地址（**唯一真源**：`packages/shared-types/src/favicon-src.mjs`）。
 *
 * 内部页与面板/书签栏/rail 从此共用同一条解析规则：数据行带回来的 favicon 优先，
 * 否则用 `<origin>/favicon.ico`；http(s) 资源统一走主进程字节代理
 * （同源 + 去重 + 失败确定）。在这里**再写一遍**拼 URL 的规则就是造第二处真源 ——
 * 上一版正是各自拼了一个 `google.com/s2/favicons`（国内连不上，且 <img> 会挂住
 * 而不是报错，连首字母降级都触发不了），于是书签/历史页的图标永远是空的。
 */
export { faviconProxyUrl, wellKnownFaviconUrl, faviconSourceCandidates } from '@hira-ng/shared-types/src/favicon-src.mjs'

/**
 * 内部页字形表（`_shared/icons.js`）在本模块**整表转发**。
 *
 * 为什么整表转发而不是挑几个名字：字形表是会长的一块（空间图标 / UI 图标 / 页面图标），
 * 逐个列举等于在 runtime 里维护第二份清单，漏一个新的就又是"页面单独 import 一次"。
 *
 * 为什么页面不该再 `import 'hira://shared/icons.js'`：`runtime.js` 本来就经
 * `shell.js` 静态依赖 `icons.js`，再单独引一次等于让同一个模块在页面里出现**两份**
 * （多一次协议请求、多一份解析与实例）。从这里拿，永远是同一份。
 */
export * from './icons.js'

/**
 * 键盘快捷键目录与组合键工具（唯一真源：`packages/shared-types/src/keybindings.mjs`）。
 *
 * 快捷键页要画「分组 / 名称 / 默认键位」，还在录制时把按键归一成组合串 ——
 * 这些规则主进程 `main/keybindings.js` 用的是**同一份**。页面自己抄一份的下场是
 * "页面显示 Ctrl+Shift+,，实际按了没反应"（标点按 key 还是按 code 的经典分叉）。
 * 所以整表转发，与 icons.js 同一手法。
 */
export * from '@hira-ng/shared-types/src/keybindings.mjs'

/**
 * 内部页身份表 + 唯一地址拼法（唯一真源：`packages/shared-types/src/pages.mjs`）。
 *
 * 新标签页快捷入口 / 页面里的「去某个管理页」链接都从 `pageLabel(host)` /
 * `pageUrl(host)` 取，别再手写 `hira://xxx` 字符串与中文名 —— 那正是"同一页在
 * 侧栏叫书签、在快捷入口叫收藏夹"的成因。
 */
export * from '@hira-ng/shared-types/src/pages.mjs'

/**
 * 地址栏命令表与 bangs（唯一真源：`packages/shared-types/src/commands.mjs`）。
 * 新标签页搜索框与地址栏建议共用同一份命令 / 引擎清单，页面不再自建副本。
 */
export * from '@hira-ng/shared-types/src/commands.mjs'

/**
 * 按扩展名归类到文件类型图标（唯一真源：`packages/shared-types/src/file-icon.mjs`）。
 * 与下载面板 / 下载栏取值一致。
 */
export { fileTypeIcon as fileIcon, fileExtension } from '@hira-ng/shared-types/src/file-icon.mjs'

// 真实的**文件图标**取数器（带缓存 + 并发合并）—— 下载页与下载面板共用同一份实现，
// 只是「问谁要」不同：这里走 rpc（页面只有桥），面板走 bridge.invoke。
const loadOsFileIcon = createFileIconLoader((filePath: string, size: number) =>
  rpc<{ dataUrl?: string | null }>('download:get-file-icon', { filePath, size }).then((res) => res?.dataUrl || null)
)

/**
 * 给 favicon <img> 挂上加载失败自动隐藏的行为。
 * @param {HTMLImageElement} img
 */
export function hideOnError (img: HTMLImageElement): void {
  img.onerror = () => { img.style.display = 'none' }
}

/**
 * 下载项行首图标 —— **真实文件图标优先，扩展名类型图标兜底**（C02 原语）。
 *
 * 学老 Hira 的下载项图标做法（`app.getFileIcon` + 按下载项缓存，见
 * `js/downloadManager.js#ensureDownloadBarFileIcon`）：主进程能给真实图标就给，
 * 拿不到（文件已删 / 还没落盘）才退回按扩展名归类的类型图标。
 *
 * @param {{filename?: string|null, url?: string|null, filePath?: string|null}} item
 * @returns {HTMLElement}  .file-icon
 */
export function fileIconBadge (item?: { filename?: string | null; url?: string | null; filePath?: string | null }): HTMLElement {
  return createFileIcon(document, item || {}, { size: 16, className: 'file-icon', loadIcon: loadOsFileIcon })
}

/**
 * 站点图标徽标（favicon）—— 加载失败 / 来源缺失时降级为首字母（面板 / 内部页共用原语）。
 *
 * @param {string} url    页面地址（决定众所周知的 `/favicon.ico` 兜底）
 * @param {string} [title] 降级徽标的取字文本（标题优先）
 * @param {string|null} [favicon] 数据行带回来的 favicon URL（书签 / 历史行都有，**优先用它**）
 * @param {{ size?: number }} [opts] size 只影响图标边长（默认 16，与列表行一致）；
 *   降级徽标同步尺寸，避免不同尺寸调用点被迫用 `!important` 覆盖内联宽高。
 * @returns {HTMLElement}  .favicon-wrap
 */
export function faviconBadge (
  url?: string,
  title?: string | null,
  favicon?: string | null,
  opts?: { size?: number }
): HTMLElement {
  const size = (opts && Number(opts.size)) || 16
  const wrap = el('span', 'favicon-wrap')
  const candidates = faviconSourceCandidates(url || '', favicon || null)

  const fallback = () => {
    const fb = el('span', 'favicon-fallback', (title || url || '?').trim().charAt(0).toUpperCase() || '?')
    if (size !== 16) {
      fb.style.width = size + 'px'
      fb.style.height = size + 'px'
      fb.style.fontSize = Math.round(size * 0.5) + 'px'
    }
    wrap.replaceChildren(fb)
  }

  if (!candidates.primary) {
    fallback()
    return wrap
  }

  // 不设 loading="lazy"：降级链带超时看门狗，而懒加载会让**尚未开始取图**的
  // 元素在超时时被误判成失败（表现就是"滚下去图标全变成首字母"）。
  // 列表有上限（history 默认 100 行）+ 来源走主进程去重缓存，eager 的代价可控。
  wrap.appendChild(createFaviconImg(document, candidates, { size, className: 'favicon', onFail: fallback }))
  return wrap
}

/**
 * 主题快照缓存（localStorage，按 hira://<host> 每个页面各存一份）。
 *
 * 为什么需要：`theme:tokens` 是异步 IPC，页面在"模块求值 → 首帧"之间有一段空窗，
 * 于是从浅色页跳到深色页时会先白闪一下（逐页切换尤其明显）。
 * 把上一轮**已经落地过**的 `{ mode, tokens }` 存下来，下次同一页启动时先同步铺上，
 * 再让异步结果校正 —— 视觉上只剩"一致"和"极少数真改了主题时的微调"。
 *
 * 只缓存渲染所需的数据，不缓存任何业务状态；解析失败 / 存储不可用一律静默降级
 * （沙箱或隐私模式下 localStorage 可能抛错，不能因此让整页脚本挂掉）。
 */
const THEME_CACHE_KEY = 'hira:theme:v1'

function readThemeCache (): ThemePayload | null {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const tokens = parsed.tokens && typeof parsed.tokens === 'object'
      ? parsed.tokens as Record<string, string>
      : null
    return { mode: normalizeThemeMode(parsed.mode), tokens }
  } catch {
    return null
  }
}

function writeThemeCache (mode?: string, tokens?: Record<string, string> | null | undefined): void {
  if (!tokens || typeof tokens !== 'object') return
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ mode, tokens }))
  } catch {
    // 存储不可用：下一帧仍旧走异步 IPC，只是没有"预热"，不影响正确性
  }
}

// ── 主题源：本页**唯一**的一次 IPC 与一组订阅 ────────────────────────────
//
// 为什么要有这一层：`initTheme`（配色）与 `initThemeWallpaperFlag`（壁纸标记）过去各自
// invoke 一次 `theme:tokens`、各自订阅 `theme:changed` + `settings:changed`。
// 新标签页两个都会调 → 同一次发布被拆成 2 次 IPC + 4 个订阅：主进程要多推一遍、
// 渲染进程要多登记一遍、Localstorage 要写两遍。这里收敛成**一个载荷缓存 +
// 一组订阅**，谁要哪一面就 `onTheme` 订阅本地回调，发起请求也天然合并。
//
// 载荷形状 `{ mode, tokens, background }` 正好是主进程发布面的并集。

/** 最近一次主题载荷（null = 还没拿到）。 */
let themePayload: ThemePayload | null = null
/** 在途的 `theme:tokens` 请求（并发调用复用它，不排队、不重复 IPC）。 */
let themeInflight: Promise<ThemePayload | null> | null = null
/** 拉取代际：广播比 IPC 响应更新鲜时，旧响应必须作废。 */
let themeRequestRevision = 0
/** 本地订阅者（配色 / 壁纸标记 / 将来别的面）。 */
const themeWatchers = new Set<(payload: ThemePayload) => void>()
/** 广播是否已接线（幂等）。 */
let themeWired = false

function notifyTheme (payload: ThemePayload): void {
  for (const fn of themeWatchers) {
    // 单个订阅者抛异常不得打断其它面
    try { fn(payload) } catch (_) {}
  }
}

function wireTheme () {
  if (themeWired) return
  const bridge = window.hira
  if (!bridge || !bridge.on || typeof bridge.on.subscribe !== 'function') return
  themeWired = true
  bridge.on.subscribe<{
    resolved?: string
    tokens?: Record<string, string>
    background?: ThemeBackground | null
    surface?: ThemeSurface | null
  }>('theme:changed', (change) => {
    if (!change) return
    // 广播是权威推送；作废在途拉取，避免它稍后回来把新主题盖回去。
    themeRequestRevision += 1
    // 广播是"部分更新"：只覆盖本次带了的字段，其余沿用上一次 —— 与过去两条订阅
    // 各自只取自己那一半的行为等价，但一次发布只通知一次。
    const prev: ThemePayload = themePayload || {}
    const next = {
      mode: change.resolved || prev.mode,
      tokens: change.tokens || prev.tokens,
      background: change.background || prev.background,
      surface: change.surface !== undefined ? change.surface : prev.surface
    }
    themePayload = next
    notifyTheme(next)
  })
  bridge.on.subscribe<{ scope?: string; key?: string }>('settings:changed', (change) => {
    if (!change) return
    if (change.scope === 'all' || change.key === THEME_SETTING_KEYS.active) refreshThemePayload()
  })
}

/** 真正去主进程要一次（在途请求复用；结束后清空，让下一次能找到新值）。 */
function refreshThemePayload (): Promise<ThemePayload | null> {
  themeRequestRevision += 1
  if (themeInflight) return themeInflight
  const bridge = window.hira
  if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') {
    return Promise.resolve(null)
  }
  const task = (async () => {
    // High-frequency theme broadcasts can otherwise keep this retry loop alive
    // for as long as the app runs. Bound it; the next broadcast starts a fresh pass.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const revision = themeRequestRevision
      try {
        const res = await bridge.provider.invoke<ThemePayload>('theme:tokens', {})
        // 请求期间又来了设置变更 / 主题广播 → 这份响应已经过时，继续拉最新一份。
        if (revision !== themeRequestRevision) continue
        const payload: ThemePayload = res && typeof res === 'object' ? res : {}
        themePayload = payload
        notifyTheme(payload)
        return payload
      } catch (_) {
        return null
      }
    }
    return null
  })()
  themeInflight = task
  void task.finally(() => { if (themeInflight === task) themeInflight = null })
  return task
}

/**
 * 取主题载荷：已有缓存时立即拿到，否则发起（并发合并）一次 IPC。
 * @returns {Promise<{mode?: string, tokens?: object, background?: object}|null>}
 */
export function requestThemePayload (): Promise<ThemePayload | null> {
  if (themePayload) return Promise.resolve(themePayload)
  return refreshThemePayload()
}

/**
 * 订阅主题载荷。注册时若已有缓存会**同步**回调一次（首屏立即落地）。
 * @param {(payload: {mode?: string, tokens?: object, background?: object}) => void} fn
 * @returns {() => void} 退订
 */
export function onTheme (fn?: (payload: ThemePayload) => void): () => void {
  if (typeof fn !== 'function') return () => {}
  themeWatchers.add(fn)
  wireTheme()
  if (themePayload) {
    try { fn(themePayload) } catch (_) {}
  }
  return () => { themeWatchers.delete(fn) }
}

/**
 * 内部页主题钩子：让 `hira://` 页面跟随**当前主题**（不只是深浅两态）。
 *
 * ── 为什么内部页也要吃令牌表，而不是只看 data-theme ──────────────────
 * `_shared/base.css` 里那套 `--bg/--surface/--text/--accent…` 曾经是"与设置页同值"
 * 的手工对齐副本 —— 于是同一个主题在**外壳**与**内部页**上会呈现两套配色
 * （改一处另一处不动）。现在两边都从主进程的令牌表取值：内部页拿到什么、
 * 外壳就拿到什么，`base.css` 的 `:root` 退化成"拿不到时的兜底"。
 *
 * 只做两件事，其它全部交给 CSS：
 *   - 把令牌表写进 html 与 body（内联 → 盖住 base.css 里的规则）
 *   - 写 data-theme + color-scheme（原生控件 / 滚动条跟随）
 * 页面 module 启动时调用一次即可；本函数不往 window 挂任何东西（宪法 C05）。
 *
 * 首帧：先用 localStorage 里的上一轮快照**同步**落地（见 THEME_CACHE_KEY），
 * 再异步向主进程要真值校正 —— 逐页切换时不会先亮一下白底。
 *
 * @returns {Promise<void>} 首帧令牌落地后 resolve（需要读 `--hira-accent` 的页面可 await）
 */
export function initTheme (): Promise<void> {
  let tokenKeys: string[] = []

  const applyTokens = (raw?: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    const record = raw as Record<string, string>
    /**
     * ⚠ 内部页**不是浏览器 UI**：把"UI 前景"那根线剪断。
     *
     * `--hira-text-primary` / `--text-color` 在令牌表里绑的是 `colors.chromeFg`
     * —— 那是给**工具栏 / 标签栏 / rail / 面板**的图标与文字用的。可它们的名字太通用，
     * 任何**跨场景共用件**（例如 ui-modal、通用列表）自然会引用，于是"只调浏览器 UI
     * 前景"会顺带把内部页与弹窗的文字一起改掉（用户明确指正过："为什么还是会波及到
     * 其他界面使其变色"）。
     *
     * 这里在**本层唯一的令牌应用点**上按回**内容前景**（`--text`）：
     * 内部页拿到什么，`--hira-text-primary` 就是什么 —— 与 `--text` 逐字相同。
     * 子窗口（subwindow 入口）用同一条口径（见 subwindow/index.html），
     * 那两处就是"内容面"的全部入口；浏览器 UI 侧一个字不动。
     */
    const tokens = record['--text']
      ? Object.assign({}, record, {
          '--hira-text-primary': record['--text'],
          '--text-color': record['--text'],
          '--hira-chrome-fg': record['--text']
        })
      : record
    const root = document.documentElement
    const body = document.body
    const nextKeys: string[] = []
    for (const key in tokens) {
      const value = tokens[key]
      if (value == null || value === '') continue
      nextKeys.push(key)
      root.style.setProperty(key, String(value))
      if (body) body.style.setProperty(key, String(value))
    }
    // 换主题时清掉上一批多出来的键，避免残留（与 theme-controller 同一处理）
    for (const key of tokenKeys) {
      if (nextKeys.indexOf(key) >= 0) continue
      root.style.removeProperty(key)
      if (body) body.style.removeProperty(key)
    }
    tokenKeys = nextKeys
  }

  const apply = (mode?: string, tokens?: Record<string,string> | null | undefined): void => {
    const t = normalizeThemeMode(mode)
    document.documentElement.dataset.theme = t
    document.documentElement.style.colorScheme = t
    applyTokens(tokens)
    writeThemeCache(t, tokens)
  }

  // 同步预热：上一轮落地过的快照先铺上（同一任务内 → 首帧就是对的色），
  // 再由主题源的真值校正。首访（没有快照）时行为与从前一致。
  const cached = readThemeCache()
  if (cached) apply(cached.mode || 'light', cached.tokens)

  // 本页唯一的应用点：主题源每次发布（广播 / 设置变更 / 首次拉取）都通知到这里。
  onTheme((payload) => apply(payload.mode || 'light', payload.tokens))

  // 返回首帧令牌落地的 Promise：需要「按主题 accent 播种」的页面（取色器、
  // 图表等）可以 `await initTheme()` 后再读 `--hira-accent`，不必猜时机。
  return requestThemePayload().then((payload) => {
    // 没有桥（页面被单独丢进浏览器调试）：保持 CSS 自身默认，不强行改配色；
    // 有桥但取不到（主进程异常）：退回浅色 —— 与旧实现逐字一致。
    if (payload) return
    if (!window.hira) return
    apply('light', null)
  })
}

export interface ThemeBackgroundOptions {
  scope?: 'window' | 'newtab'
  overlay?: HTMLElement | null
}

/**
 * 给**没有浏览器外壳的独立页**铺主题背景。
 *
 * 普通 hira:// 页面看到的是外壳那张唯一壁纸；OOBE 等独立窗口没有外壳，
 * 必须自己持有背景层。这里仍复用共享的背景渲染器与主题源，不复制判据：
 * - 图片 / 动态壁纸的 DOM 规则在 theme-background.mjs；
 * - 玻璃标记只在“背景实际可见或主题启用了窗口材质”时打开；
 * - 只有真有壁纸时才写 data-theme-wallpaper，CSS 才启用合成提示与局部模糊。
 */
export function initThemeBackground (
  target: HTMLElement | null,
  { scope = 'window', overlay = null }: ThemeBackgroundOptions = {}
): Promise<void> {
  if (!target) return Promise.resolve()

  let appliedOverlay: string | null = null
  const apply = (payload: ThemePayload | null): void => {
    const background = payload && payload.background && typeof payload.background === 'object'
      ? payload.background
      : null
    const raw = background ? background[scope] : null
    const spec = raw && typeof raw === 'object' ? raw : null
    const effective = applyThemeBackground(target, spec)
    const material = payload && payload.surface && typeof payload.surface.material === 'string'
      ? payload.surface.material
      : ''
    const visible = effective !== 'none'
    const glass = visible || (material !== '' && material !== 'none')
    const root = document.documentElement

    const backgroundFlag = glass ? '1' : '0'
    const wallpaperFlag = visible ? '1' : '0'
    if (root.dataset.themeBackground !== backgroundFlag) root.dataset.themeBackground = backgroundFlag
    if (root.dataset.themeWallpaper !== wallpaperFlag) root.dataset.themeWallpaper = wallpaperFlag

    if (overlay) {
      const color = visible ? String(spec?.overlayColor || 'transparent') : 'transparent'
      if (color !== appliedOverlay) {
        appliedOverlay = color
        overlay.style.background = color
      }
    }
  }

  onTheme((payload) => apply(payload))
  return requestThemePayload().then((payload) => {
    if (!payload) apply(null)
  })
}

/**
 * 新标签页的**壁纸标记**（不是壁纸本身）。
 *
 * ── 壁纸只有一份 ────────────────────────────────────────────────────────
 * 真正绘制壁纸的是窗口外壳的 `#chrome-theme-background`（`position:fixed; inset:0`，
 * 在所有 WebContentsView 之下）。标签视图是**透明画布**（见 APPS 侧 tabCanvasColor 钩子），
 * 新标签页的 body 在有壁纸时也透明 —— 于是看到的就是同一张图、同一份裁切。
 *
 * 这解决的是旧「镜像拼接」方案的死结：面板 / 侧栏动画每帧都在改标签视图的 bounds，
 * 页面里那份镜像的几何（由 IPC 事后取回）永远慢半拍，表现就是壁纸跟着界面一起动、
 * 接缝补不上、然后闪一下。现在页面里**没有任何壁纸图层**，自然无从跟着动。
 *
 * 本函数因此只做一件事：把「现在有没有壁纸」写成 `html[data-ntp-wallpaper]`，
 * 供 CSS 决定卡片要不要换玻璃材质。**不画背景、不问几何、不订阅布局**。
 *
 * @returns {Promise<void>}
 */
export function initThemeWallpaperFlag (): Promise<void> {
  const apply = (bg?: ThemePayload['background'] | null | undefined): void => {
    // 判据取**窗口面**（`background.window`）：壁纸是外壳在窗口级画的，
    // 只有那一个面真有图层时本页才该透明。取 `newtab` 面会退化成"页面以为有壁纸、
    // 其实外壳没画"—— 透明之后露出的是一块空的 chrome 底色。
    // （归一化已保证 newtab ⇒ window，这两个面现在同值，这里只是把真源写明确。）
    const spec = bg && bg.window ? bg.window : null
    document.documentElement.dataset.ntpWallpaper = spec && spec.visible ? '1' : '0'
  }
  // 与 initTheme 共用**同一个**主题源（一次 IPC、一组订阅）：这里只挑 background。
  onTheme((payload) => apply(payload.background))
  return requestThemePayload().then((payload) => {
    // 没有桥（页面被单独丢进浏览器调试）：保持"无壁纸"，body 用主题底色，观感与从前一致
    if (payload || !window.hira) return
    apply(null)
  })
}

// ── 模块求值即挂载左侧导航 ────────────────────────────────────────────────
// 放在文件末尾：此时本模块的具名导出（rpc / el / initTheme…）已经就位，
// 外壳建导航时若将来需要用到它们也不会踩到 TDZ。
// 未登记的页面（newtab / error / pdf / jsdialog…）与自带导航的页面（设置）在
// mountShell 第一行就返回，因此这里**不需要**任何 host 判断分支。
mountShell()
// 修饰键 / 中键点链接 → 统一走 openLink（Ctrl 开后台新标签）。
// 所有内部页都 import 本文件，所以在这一处挂一次即可，各页面不用再写一遍。
installLinkClicks()
