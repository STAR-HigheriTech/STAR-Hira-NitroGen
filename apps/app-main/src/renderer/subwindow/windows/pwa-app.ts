/**
 * PWA 应用窗的 chrome（自绘标题栏）。
 *
 * ── 这个窗口里只有标题栏是我们的 ───────────────────────────────────
 * 正文是主进程贴在标题栏**正下方**的原生 `WebContentsView`（见 `main/pwa/window.js`）——
 * 它盖住 `.content` 那一块，所以本模块不画界面，只做四件事：
 *   ① 画标题栏：导航按钮 + 应用图标 / 名称 + `…` 菜单；
 *   ② 量出标题栏高度并上报（主进程据此把网页视图贴在它正下方，与 peek 同一条思路）；
 *   ③ 订阅窗口状态（标题 / 可后退 / 加载中）刷新按钮；
 *   ④ 把按钮点击翻译成 `pwa:navigate` 的 action —— 动作集合的**权威在窗口控制器**，
 *      这里只负责发字符串，不自己实现导航（否则规则就有了两份）。
 *
 * ── 与主浏览器同一套视觉（刻意的硬约束）─────────────────────────────
 * 导航按钮 = `ui-navbar#createActionButton`（32×32 / 8px 圆角 / 同一套 hover / 按下回弹），
 * 图标 = `ui-common` 同一份 SVG（24×24 / stroke 1.5 / 18px），行高 = 38px（与 WCO 同高），
 * 背景 / 前景 / 禁用色全部走 `shared-ui-tokens`。**不要**在这里另画一套按钮 ——
 * PWA 窗口是浏览器的另一个外壳，不是另一个产品。
 *
 * ── 菜单：原生，不是自绘 ────────────────────────────────────────────
 * `…` 按钮走 `shared/menu-client` → `ui:popup-menu` → 主进程 `Menu.popup`，与主浏览器
 * 的 `≡` 是**同一条链路**（同一套原生菜单渲染、同一种键盘可达性）。因此这里只描述
 * 菜单项（原生契约），不写任何下拉 DOM / 定位 / 关闭逻辑。
 *
 * ── 系统窗口按钮（WCO）──────────────────────────────────────────────
 * 建窗期决定窗口按钮由**系统**画（`titleBarStyle:'hidden'` + `titleBarOverlay`）。
 * 渲染层只需要知道"是不是系统画的"：是 → 不再自绘、并在右侧让出系统按钮占宽；
 * 否 → 由 subwindow 入口装自绘簇。判据统一来自 `app-shell/wco.js`，不自己推断设置。
 *
 * 解耦原则：不 import infra / domain，只经 `window.hira` 说话。
 */

import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
// 快捷键的唯一真源（动作名 → 键位 id → 当前组合串 → Electron accelerator）。
// 菜单只显示**当前生效值**，这里不抄任何组合键字面量。
import { KEYBINDING_DEFAULTS, menuAccelerator } from '@hira-ng/shared-types/src/keybindings.mjs'
import type { RendererBridge } from '../../shared/bridge.js'
import { ArrowLeft, ArrowRight, Menu, RefreshCw, X } from '@hira-ng/ui-common'
import { createActionButton, injectNavbarStyles, setActionButtonIcon } from '@hira-ng/ui-navbar'
import { createWindowControlsOverlay } from '../../app-shell/wco.js'
import { menuClient } from '../../shared/menu-client.js'
import type { SubwindowMountContext } from './contract.js'

interface PwaWindowState {
  appId?: string
  canGoBack?: boolean
  canGoForward?: boolean
  isLoading?: boolean
  title?: unknown
}

interface PwaWindowStateResult {
  ok?: boolean
  state?: unknown
}

// 令牌是视觉的真源：subwindow 这个 entry 里已有别的窗口 import 过（Vite 去重），
// 这里再显式 import 一次是为了**声明依赖** —— 换一个入口复用时也不会缺 token。
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/layers.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'

/**
 * PWA chrome 专属样式。
 *
 * 只挂在 `.header.pwa-chrome` 上 —— `index.html` 里那条 `.header`（34px）是另外 8 类
 * 子窗口的公共标题栏，不跟着改。行高 38 与 `WINDOW_CONTROLS_OVERLAY_HEIGHT` 一致
 * （系统窗口按钮就垂直居中的这条带子里，两者不等会明显错位）。
 */
const CHROME_CSS = `
  .header.pwa-chrome {
    --ng-navbar-top-row-height: 38px;
    height: var(--ng-navbar-top-row-height);
    /* 左内边距与主浏览器导航行同值；右侧刻意留 0 —— 自绘窗控要贴住窗口右上角，
       系统窗控则由下面的 reserve 让位。 */
    padding: 0 0 0 var(--ng-navbar-bottom-row-padding-x, 8px);
    gap: var(--ng-navbar-bottom-row-gap, 4px);
    background: var(--pwa-chrome-bg, var(--main-bg-color));
    color: var(--pwa-chrome-fg, inherit);
    border-bottom-color: var(--pwa-chrome-border, var(--main-border-color, transparent));
  }
  /* 系统绘制窗口按钮时，菜单按钮必须让出右上角（系统按钮不在 DOM 里，会压住它）。 */
  body[data-window-controls='native'] .header.pwa-chrome {
    padding-right: calc(var(--ng-wco-reserve, 138px) + 4px);
  }
  /* 导航按钮簇：与主浏览器 #toolbar-navigation-buttons 同一条排版（flex / gap 由
     injectNavbarStyles 的 NAV_CLUSTER_CSS 提供，这里只保证它不被拉宽）。 */
  .header.pwa-chrome #toolbar-navigation-buttons {
    flex: 0 0 auto;
  }
  .header.pwa-chrome .pwa-brand {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 4px;
    overflow: hidden;
  }
  .header.pwa-chrome .pwa-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 4px;
    object-fit: contain;
  }
  .header.pwa-chrome .pwa-icon[hidden] { display: none; }
  .header.pwa-chrome #title { flex: 1; }
  .header.pwa-chrome .pwa-actions {
    -webkit-app-region: no-drag;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: 2px;
  }
`

/**
 * `…` 菜单项 —— **原生菜单契约**（`{ label, type, role, action, submenu }`）。
 *
 * 只列应用窗真正拥有、且适合应用窗的能力：
 *   · 查找 / 缩放有专用通道（PWA 窗不在 runtimeRegistry 里，泛用通道会打到主窗口）；
 *   · 其余走 `pwa:navigate` 的 action（语义权威在 `main/pwa/window.js#navigate`）；
 *   · 「关闭窗口」交给原生 role —— 渲染层不必知道怎么关。
 *
 * **刻意不写 `accelerator`**：唯一的真源是 shared-types#keybindings.mjs
 * （用户可在 hira://shortcuts 改键）。写死一份就是第二份真源，改键后菜单立刻撒谎；
 * 组合键在弹出前由 `buildMenuItems` 按当前键位现算。
 */
const MENU_ITEMS = Object.freeze([
  { label: '查找…', action: 'find' },
  { label: '打印…', action: 'print' },
  { type: 'separator' },
  { label: '放大', action: 'zoom-in' },
  { label: '缩小', action: 'zoom-out' },
  { label: '重置为 100%', action: 'zoom-reset' },
  { type: 'separator' },
  { label: '复制链接', action: 'copy-url' },
  { label: '在浏览器中打开', action: 'open-in-browser' },
  { type: 'separator' },
  { label: '开发者工具', action: 'devtools' },
  { type: 'separator' },
  { label: '卸载此应用…', action: 'uninstall' },
  { type: 'separator' },
  { label: '关闭窗口', role: 'close' }
])

/**
 * 读「当前生效」的键位表（默认值 + 用户改键由主进程合并）。
 *
 * 应用窗与主窗口**共享同一份自定义快捷键**（见 main/pwa/app-features.js 的
 * createKeybindingsManager），所以这条路由读到的就是本窗真实生效的那份。
 * 失败一律退回默认表 —— 菜单必须弹得出来，少一行提示远好过点不动。
 * @param {unknown} bridge `window.hira`
 * @returns {Promise<Record<string, string>>}
 */
async function readKeybindings(bridge: RendererBridge | null | undefined) : Promise<Record<string, string>> {
  try {
    if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') {
      return { ...KEYBINDING_DEFAULTS }
    }
    const current = await bridge.provider.invoke<Record<string, string>>(IPC_ROUTES.keybindingsGet)
    return { ...KEYBINDING_DEFAULTS, ...(current || {}) }
  } catch (_) {
    return { ...KEYBINDING_DEFAULTS }
  }
}

/**
 * 菜单项 + 快捷键提示 = 原生菜单契约。
 *
 * 动作名 → 键位 id → 组合串 → Electron accelerator 全由 `menuAccelerator` 一处完成；
 * 没有键位的动作（复制链接 / 卸载…）**不写字段** —— Electron 拿到空串会渲染一个
 * 空提示位并告警。
 * @param {Record<string, string>} keybindings
 * @returns {Array<Record<string, unknown>>}
 */
function buildMenuItems(keybindings: Record<string, string>) : Array<Record<string, unknown>> {
  return MENU_ITEMS.map((item) => {
    if (!item.action) return item
    const accelerator = menuAccelerator(item.action, keybindings)
    return accelerator ? { ...item, accelerator } : item
  })
}

function hira() {
  return globalThis.window ? globalThis.window.hira : null
}

/** 把任意 CSS 颜色归一成 `#rrggbb`；非法返回 null。 */
function normalizeColor(value: unknown): string | null {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  try {
    if (!globalThis.CSS || !CSS.supports('color', text)) return null
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    // canvas 的 fillStyle 会把 rgb()/hsl()/颜色名统一成 #rrggbb（含 alpha 时另说）。
    ctx.fillStyle = '#000000'
    ctx.fillStyle = text
    const normalized = String(ctx.fillStyle || '')
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : null
  } catch (_) {
    return null
  }
}

/** 按相对亮度取黑 / 白前景（阈值 0.55：白字只在确实偏深的底上出现）。 */
function contrastText(hex: string | null | undefined): string | null {
  const value = String(hex || '').replace('#', '')
  if (value.length !== 6) return null
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return luminance > 0.55 ? '#101418' : '#ffffff'
}

export function mountPwaApp({ params, content, wco: injectedWco }: SubwindowMountContext): void {
  const bridge = hira()
  const header = document.querySelector<HTMLElement>('.header')
  const titleEl = document.getElementById('title')
  const appId = params.get('appId') || ''
  const appName = params.get('name') || '应用'

  // 正文归原生网页视图（它就盖在这一块上）：必须留空并隐藏，
  // 否则"加载中..."的占位会先闪一下再被网页盖掉。
  if (content) {
    content.textContent = ''
    content.style.display = 'none'
  }

  // 与主浏览器外壳**同一份**部件样式（动作按钮 / 导航簇 / 通用件）。
  injectNavbarStyles(document)

  if (!document.getElementById('pwa-app-chrome-css')) {
    const style = document.createElement('style')
    style.id = 'pwa-app-chrome-css'
    style.textContent = CHROME_CSS
    document.head.appendChild(style)
  }
  if (header) header.classList.add('pwa-chrome')

  /**
   * 导航面板的唯一出口：动作字符串的语义由 `main/pwa/window.js#navigate` 定义。
   * 这里不判断"能不能后退 / 要不要刷新"，只转发 —— 规则只有一份。
   */
  function navigate(action: string) {
    if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') return
    if (!action) return
    bridge.provider.invoke(IPC_ROUTES.pwaNavigate, { appId, action }).catch(() => {})
  }

  /** PWA 专用通道（查找 / 缩放）：泛用路由在 PWA 窗里会落错窗口。 */
  function sendRoute(route: string, payload?: unknown) {
    if (!bridge || !bridge.provider || typeof bridge.provider.send !== 'function') return
    try { bridge.provider.send(route, payload) } catch (_) {}
  }

  // ── 导航按钮：主浏览器同款（createActionButton / 18px 图标）──────────
  const navCluster = document.createElement('div')
  navCluster.id = 'toolbar-navigation-buttons'

  const backBtn = createActionButton(document, {
    id: 'back-button',
    icon: ArrowLeft,
    title: '后退',
    onClick: () => navigate('back')
  })
  const forwardBtn = createActionButton(document, {
    id: 'forward-button',
    icon: ArrowRight,
    title: '前进',
    onClick: () => navigate('forward')
  })
  let stopMode = false
  const reloadBtn = createActionButton(document, {
    id: 'refresh-button',
    icon: RefreshCw,
    title: '刷新',
    onClick: () => navigate(stopMode ? 'stop' : 'reload')
  })
  backBtn.disabled = true
  forwardBtn.disabled = true
  navCluster.append(backBtn, forwardBtn, reloadBtn)

  // ── 品牌区：图标 + 名称 ────────────────────────────────────────────
  if (header && titleEl) {
    header.insertBefore(navCluster, titleEl)

    const brand = document.createElement('div')
    brand.className = 'pwa-brand'
    const icon = document.createElement('img')
    icon.className = 'pwa-icon'
    icon.alt = ''
    icon.draggable = false
    const iconSrc = params.get('icon')
    if (iconSrc) icon.src = iconSrc
    else icon.hidden = true
    icon.addEventListener('error', () => { icon.hidden = true })
    header.insertBefore(brand, titleEl)
    brand.appendChild(icon)
    brand.appendChild(titleEl)
    titleEl.textContent = appName
  }
  document.title = appName

  // ── `…` 菜单：原生菜单，与主浏览器同一条链路 ──────────────────────
  const actions = document.createElement('div')
  actions.className = 'pwa-actions'
  const menuBtn = createActionButton(document, {
    id: 'menu-button',
    icon: Menu,
    title: '菜单',
    onClick: (event) => {
      // 坐标与主浏览器外壳一致：用点击点作为菜单左上角（主进程按窗口内容区解释）。
      const x = Number.isFinite(event?.clientX) ? Math.round(event.clientX) : undefined
      const y = Number.isFinite(event?.clientY) ? Math.round(event.clientY) : undefined
      // 键位现读：改键后下一次打开菜单立刻生效，不欠订阅生命周期。
      readKeybindings(bridge)
        .then((keybindings) => menuClient.popupMenu({ items: buildMenuItems(keybindings), x, y }))
        .then(handleMenuAction)
        .catch(() => {})
    }
  })
  actions.appendChild(menuBtn)

  const headerActions = document.getElementById('header-actions')
  if (header) header.insertBefore(actions, headerActions || null)

  /** 菜单动作 → 各自的能力通道。 */
  function handleMenuAction(action: string | null) {
    switch (action) {
      case 'find':
        sendRoute(IPC_ROUTES.pwaFindToggle, { appId })
        break
      case 'zoom-in':
        sendRoute(IPC_ROUTES.pwaZoomStep, { appId, delta: 1 })
        break
      case 'zoom-out':
        sendRoute(IPC_ROUTES.pwaZoomStep, { appId, delta: -1 })
        break
      case 'zoom-reset':
        sendRoute(IPC_ROUTES.pwaZoomReset, { appId })
        break
      default:
        // 其余都是窗口控制器的 action（copy-url / open-in-browser / devtools / uninstall）。
        if (action) navigate(action)
    }
  }

  // ── 系统窗口按钮（WCO）：本进程只感知、不重绘 ──────────────────────
  // 自绘簇是否装配由 subwindow 入口按 `native` 决定；这里负责把系统按钮的占宽
  // 写进 `--ng-wco-reserve`（窗口缩放 / 换 DPI 时自动更新）。
  // 入口已建好实例时直接复用（同一文档只需要一条 geometrychange / resize 监听）。
  const wco = injectedWco || createWindowControlsOverlay(document)
  const ownsWco = !injectedWco

  // ── 主题：manifest 的 theme_color 直接做标题栏底色 ────────────────
  const themeHex = normalizeColor(params.get('theme'))
  const bgHex = normalizeColor(params.get('bg'))
  // 深色模式（subwindow 入口的主题控制器会把解析结果落到 body.dark）不拿
  // manifest 的浅色底去盖 chrome —— 那会得到"深色系统里的白条"。
  if (bgHex && !document.body.classList.contains('dark')) document.body.style.background = bgHex
  if (header && themeHex) {
    const fg = contrastText(themeHex)
    header.style.setProperty('--pwa-chrome-bg', themeHex)
    if (fg) {
      header.style.setProperty('--pwa-chrome-fg', fg)
      // 按钮的悬停 / 禁用色必须跟着底色走：浅色底沿用令牌，深色底换成白色叠层。
      header.style.setProperty(
        '--main-btn-bg-color-hover',
        fg === '#ffffff' ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.1)'
      )
      header.style.setProperty(
        '--tool-btn-dis-color',
        fg === '#ffffff' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)'
      )
      header.style.setProperty(
        '--pwa-chrome-border',
        fg === '#ffffff' ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.1)'
      )
    }
  }

  // ── 标题栏高度上报（幂等，主进程只按最新值落位）────────────────────
  if (bridge && bridge.provider && typeof bridge.provider.send === 'function') {
    const reportChrome = () => {
      try {
        const height = header ? Math.round(header.getBoundingClientRect().height) : 0
        if (height > 0 && appId) bridge.provider.send(IPC_ROUTES.pwaChrome, { appId, height })
      } catch (_) {}
    }
    reportChrome()
    try {
      if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
        document.fonts.ready.then(reportChrome).catch(() => {})
      }
    } catch (_) {}
    if (globalThis.ResizeObserver && header) {
      try {
        new ResizeObserver(reportChrome).observe(header)
      } catch (_) {}
    }
  }

  // ── 窗口状态：标题 / 可后退 / 加载中 ──────────────────────────────
  const applyState = (state: PwaWindowState | null) => {
    if (!state || (state.appId && state.appId !== appId)) return
    backBtn.disabled = state.canGoBack !== true
    forwardBtn.disabled = state.canGoForward !== true
    const loading = state.isLoading === true
    if (loading !== stopMode) {
      stopMode = loading
      // 刷新 ↔ 停止：同一颗按钮换形（与主浏览器 navCluster 的形态一字不差）。
      setActionButtonIcon(reloadBtn, loading ? X : RefreshCw)
      reloadBtn.title = loading ? '停止加载' : '刷新'
      reloadBtn.setAttribute('aria-label', reloadBtn.title)
    }
    const text = String(state.title == null ? '' : state.title).trim()
    if (text && titleEl && titleEl.textContent !== text) {
      titleEl.textContent = text
      document.title = text
    }
  }

  if (bridge && bridge.on && typeof bridge.on.subscribe === 'function') {
    bridge.on.subscribe<PwaWindowState>(IPC_EVENTS.pwaWindowState, applyState)
  }
  if (bridge && bridge.provider && typeof bridge.provider.invoke === 'function' && appId) {
    bridge.provider
      .invoke<PwaWindowStateResult>(IPC_ROUTES.pwaGetWindowState, { appId })
      .then((result) => {
        const state = result && result.ok && result.state && typeof result.state === 'object'
          ? result.state as PwaWindowState
          : null
        applyState(state)
      })
      .catch(() => {})
  }

  // 窗口卸载时把自建实例的 WCO 监听摘掉（入口注入的由入口自己收拾）。
  if (ownsWco) window.addEventListener('unload', () => { try { wco.dispose() } catch (_) {} })
}

