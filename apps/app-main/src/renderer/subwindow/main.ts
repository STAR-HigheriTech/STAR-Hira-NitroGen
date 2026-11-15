/**
 * 共享子窗口渲染器。
 * 根据 URL 的 ?type= 参数决定展示哪个窗口的 UI。
 * 复杂窗口（如 settings）有独立 entry，简单窗口共用此 entry。
 *
 * 解耦原则：不导入 infra/domain 模块，仅通过 window.hira.provider 与主进程通信。
 * 具体窗口 UI 拆在 windows/ 子模块，通过 WINDOW_MOUNTS 注册表装配 ——
 * 新窗口 = 加一个模块 + 注册一行，本入口保持零业务逻辑。
 */
import { mountBookmarkEditor, mountTagBookmarks } from './windows/bookmark-editor.js'
import { mountEaselWindow } from './windows/easel-window.js'
import { mountInjectEditor } from './windows/inject-editor.js'
import { mountPeek } from './windows/peek.js'
import { mountPwaApp } from './windows/pwa-app.js'
import { mountPwaInstall } from './windows/pwa-install.js'
import { mountPasskeyPicker } from './windows/passkey-picker.js'
import { mountCaptureHub } from './windows/capture-hub.js'
// 通用「面板独立窗口」：面板 → 窗口是通用能力，与任何具体面板无关（见该文件头）。
import { mountDetachedPanel } from './windows/detached-panel.js'
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { APP_NAME } from '@hira-ng/shared-types/src/associations.mjs'
import { createWindowControlsOverlay } from '../app-shell/wco.js'
// 主题落地：所有子窗口共用**这一处**装配（窗口模块不再各自 start 一遍）。
import { createThemeController } from '../shared/theme-controller.js'
// 窗口控制按钮簇 —— **与主窗口同一份实现**（ui-common）。子窗口过去自己画了一套
// 26×22 圆角小按钮（10×10 字形 + 灰字），与主窗口的 46px 直角原生字形摆在一起
// 明显是两种东西。这里改成直接复用，字形 / 尺寸 / 悬停（含关闭键的 #e81123）全部同源。
import { createWindowControlCluster, WINDOW_CONTROLS_CSS } from '@hira-ng/ui-common'
import type { SubwindowMount } from './windows/contract.js'

const WINDOW_TITLES: Record<string, string> = {
  'add-bookmark': '添加书签',
  'edit-bookmark': '编辑书签',
  'tag-bookmarks': '打标签',
  'peek': '小窗预览',
  'pwa-app': '应用',
  'pwa-install': '安装应用',
  'passkey-picker': '选择 Passkey',
  'capture-hub': '收集',
  'easel-window': '画板',
  'inject-editor': '编辑注入规则',
  'detached-panel': '面板'
}

// 窗口 UI 注册表：有专属实现的类型挂载对应模块，其余走占位
const WINDOW_MOUNTS: Record<string, SubwindowMount> = {
  'add-bookmark': mountBookmarkEditor,
  'edit-bookmark': mountBookmarkEditor,
  // 批量打标签（右键「打标签…」的统一落点）：payload.ids 给出目标集合。
  'tag-bookmarks': mountTagBookmarks,
  // 画板（D4）：面板负责导航，画布在这个独立窗口里（见 ui/ui-panel-easel）。
  'easel-window': mountEaselWindow,
  // 注入规则编辑器（J10）：面板里的「编辑 CSS / JS…」开这个窗口（见 ui/ui-panel-inject）。
  'inject-editor': mountInjectEditor,
  // 截图标注不在此表：它是**浏览器窗口内的浮层**（renderer/capture-editor/），不是子窗口。
  // 小窗预览：这个入口里它**不画界面**，只画那条标题栏（正文是主进程贴的原生网页视图）
  'peek': mountPeek,
  // PWA 应用窗：同样只画标题栏（网页本体是主进程贴的 WebContentsView）
  'pwa-app': mountPwaApp,
  // PWA 安装确认框：图标 + 名称 + 三个开关 + 阶段文案
  'pwa-install': mountPwaInstall,
  'passkey-picker': mountPasskeyPicker,
  'capture-hub': mountCaptureHub,
  // 通用面板独立窗口：内容由 URL payload 里的 panelId 决定（与任何具体面板无关）
  'detached-panel': mountDetachedPanel
} satisfies Record<string, SubwindowMount>

type WindowType = keyof typeof WINDOW_TITLES

function isWindowType(value: string): value is WindowType {
  return Object.prototype.hasOwnProperty.call(WINDOW_TITLES, value) &&
    Object.prototype.hasOwnProperty.call(WINDOW_MOUNTS, value)
}

/**
 * 自绘标题栏的窗口按钮（最小化 / 最大化 / 关闭）—— 直接复用**主窗口那一簇**。
 *
 * ── 为什么统一到 ui-common 那一份 ─────────────────────────────────
 * 这些窗口（书签编辑器 / 画板 / 注入编辑器）
 * 与主窗口的自绘按钮本来就是**同一件东西**，各画一套的结局是两种字形、
 * 两种尺寸、两种悬停。现在字形（12×12 的 1:1 标题栏字形）、CSS（46px 直角、
 * 悬停铺满整行、关闭键 #e81123）、最大化↔还原的切换全部与主窗口同源。
 * ui-common 里本来就为这件事留好了口子（侧栏浮出层也用同一份）。
 *
 * ── 为什么能力要**现问主进程** ────────────────────────────────────
 * 哪些按钮该亮，取决于窗口的真实配置（小窗预览 `maximizable:false`、书签编辑器
 * `minimizable:false`、扫码浮框不可缩放…）。在渲染层按 `?type=` 抄一张"哪种窗口有
 * 哪些按钮"的表，必然与 `window-config.js` 漂移 —— 而漂移的表现是"按钮亮着却点不动"。
 * 所以这里问 `window:get-state`，由主进程用 `win.isMinimizable()/isMaximizable()`
 * 回答当前窗口**真实**能做什么。**各窗口的显隐规则因此一字未改。**
 *
 * ── 为什么挂 resize 重问一次 ──────────────────────────────────────
 * 最大化态决定按钮画"口"还是"还原"图标。双击拖动区 / 系统快捷键也能最大化，
 * 那两条路不经过我们的按钮，所以用 resize 兜底刷新（本窗口的 resize 次数极少）。
 */
function wireWindowControls() {
  const host = document.getElementById('header-actions')
  if (!host) return
  const bridge = window.hira
  const invoke = (route: string) => {
    try {
      if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') return Promise.resolve(null)
      return bridge.provider.invoke(route)
    } catch (_) { return Promise.resolve(null) }
  }
  // 子窗口是独立渲染入口，不加载外壳的样式表 —— 簇的 CSS 要显式注入一次。
  if (!document.getElementById('ui-common-window-controls')) {
    const style = document.createElement('style')
    style.id = 'ui-common-window-controls'
    style.textContent = WINDOW_CONTROLS_CSS
    document.head.appendChild(style)
  }

  const apply = (state: { minimizable?: boolean; maximizable?: boolean; isMaximized?: boolean } | null) => {
    if (!state) return
    if (cluster.minBtn) cluster.minBtn.hidden = state.minimizable !== true
    if (cluster.maxBtn) cluster.maxBtn.hidden = state.maximizable !== true
    cluster.setMaximized(state.isMaximized === true)
  }
  const refresh = () => { invoke(IPC_ROUTES.windowGetState).then(apply).catch(() => {}) }

  // 关闭**不依赖桥**（`window.close()` 由 Electron 对窗口自身内容页放行）——
  // 所以即使桥不可用，也照常造出这一簇，绝不出现"无边框窗口没有关闭键"。
  const cluster = createWindowControlCluster(document, {
    onMinimize: () => { invoke(IPC_ROUTES.windowMinimize) },
    onMaximize: () => { invoke(IPC_ROUTES.windowMaximize).then(refresh).catch(() => {}) },
    onClose: () => window.close()
  })
  cluster.placeInto(host)
  // 先按"最小"亮出来（只留关闭），等 `window:get-state` 回来再按真实能力补上 ——
  // 与旧版把这两颗写在 HTML 里 `hidden` 是同一个意图：能力是异步问来的，
  // 先亮再收会看到一次闪烁。
  if (cluster.minBtn) cluster.minBtn.hidden = true
  if (cluster.maxBtn) cluster.maxBtn.hidden = true

  refresh()
  window.addEventListener('resize', refresh)
}

function init() {
  const params = new URLSearchParams(window.location.search)
  const rawType = params.get('type') || ''
  const type = isWindowType(rawType) ? rawType : ''
  const title = type ? WINDOW_TITLES[type] : APP_NAME

  const titleElement = document.getElementById('title')
  if (titleElement) titleElement.textContent = title
  document.title = title

  // ── 主题窗口材质（亚克力 / Mica）的渲染侧开关 ──────────────────────
  // 主进程只在 `window-config.js` 声明了 `followThemeMaterial` 的窗口上带这个参数
  // （目前是通用面板窗口）。原生材质的**开 / 关**是主进程的事（见 main/window-material-follow.js）；
  // 渲染层只需表达"可以让材质透出来"，由 subwindow/index.html 的唯一玻璃规则让开 body 底色。
  // 放在主题控制器启动之前：首帧就按目标底色渲染，不出现"先实心再变玻璃"的闪。
  if (params.get('windowMaterial') === '1') {
    document.documentElement.dataset.windowMaterial = '1'
  }

  // 自绘标题栏的窗口按钮（最小化 / 最大化 / 关闭）：与主窗口同一簇，按窗口真实能力亮。
  //
  // PWA 应用窗是**系统绘制**（WCO）的：窗口右上角那三颗由系统画，且与网页共享同一行。
  // 这时再叠一簇自绘按钮就是两套按钮并排。所以先问 WCO 是否生效，只在非 native
  // （用户把窗口控件样式设成了 `custom`）时才装配自绘簇 —— 判定与样式全部收敛在
  // wco.js / window-controls-policy.js 两个模式源里，这里只做分流。
  const wco = type === 'pwa-app' ? createWindowControlsOverlay(document) : null
  if (!wco || !wco.native) wireWindowControls()
  if (wco) window.addEventListener('unload', () => { try { wco.dispose() } catch (_) {} })

  // ── 主题 ──────────────────────────────────────────────────────────
  // **所有子窗口**（含只用系统配色的那些）都在这一处接入主题令牌：
  // `--hira-accent` / `--hira-bg-*` / `--hira-text-*` / `--hira-danger` … 由主进程
  // 推来的令牌表落到 html 与 body（见 theme-controller 文件头），窗口模块只管用。
  // 以前是"用到的窗口各自 createThemeController().start()" —— 那种写法必然漏掉
  // 新窗口（pwa-install 就漏了，整套 Fluent 蓝脱离主题）。收敛到入口后，
  // 「新窗口 = 加一个模块 + 注册一行」仍然成立，且天生跟随主题。
  // 这里**不再**用 prefers-color-scheme 自己判深浅：当前主题只有主进程一个答案。
  const themeController = createThemeController({ document, bridge: window.hira })
  themeController.start()
  window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

  const content = document.getElementById('content')
  if (!content) return
  const mount = type ? WINDOW_MOUNTS[type] : null
  if (mount) {
    mount({ type, params, content, wco })
  } else {
    // 防御性分支：所有走本入口的窗口类型都已在 WINDOW_MOUNTS 注册。
    // 真走到这里说明 window-config.js 与注册表不同步（新增类型忘了注册），
    // 因此直说是配置问题，而不是留一句「占位」让人以为还没做。
    content.textContent = ''
    const notice = document.createElement('p')
    notice.style.cssText = 'color:#9ca3af;font-size:14px'
    notice.textContent = `窗口类型「${rawType}」没有注册界面（window-config.js 与 WINDOW_MOUNTS 不同步）`
    content.appendChild(notice)
  }
}

document.addEventListener('DOMContentLoaded', init)
