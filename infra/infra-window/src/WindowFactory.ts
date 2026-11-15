import type {
  BrowserWindow as BrowserWindowType,
  BrowserWindowConstructorOptions,
  Event as ElectronEvent,
  WebPreferences
} from 'electron'
import { buildWebPreferences, type WebPreferenceOptions } from './webPreferences'
import { WindowRegistry } from './WindowRegistry'

const { BrowserWindow } = require('electron') as { BrowserWindow: typeof import('electron').BrowserWindow }
interface WebContentsManagerInstance { loadUiShell(): Promise<unknown>; loadRail(): Promise<unknown> }
interface LayoutCoordinatorInstance { attachUiShell(): void; attachRail(): void }
const { WebContentsManager } = require('./WebContentsManager') as {
  WebContentsManager: new (win: BrowserWindowType, options: Record<string, unknown>) => WebContentsManagerInstance
}
const { LayoutCoordinator } = require('./LayoutCoordinator') as {
  LayoutCoordinator: new (win: BrowserWindowType, manager: WebContentsManagerInstance, options: Record<string, unknown>) => LayoutCoordinatorInstance
}
// 统一 webPreferences 定义点 — 主窗口 / 子窗口 / tab / panel / rail / 浮层共用，
// 见 webPreferences.js（唯一真相源）。此处 re-export，保持 infra-window 根的公开契约。

/**
 * 默认窗口图标（唯一真源）。
 *
 * 打包态**不设**：Windows 的窗口 / 任务栏 / Alt-Tab 图标由 exe 内嵌资源决定
 * （electron-builder 的 `build/icon.ico`），运行期再传 PNG 反而会用单一位图
 * 覆盖系统按 DPI 选中的多尺寸资源。
 * 开发态由 app-main 启动时注入（exe 是 electron.exe，不设就只能看到 Electron 图标）。
 *
 * 放在 infra 层做「一个开关、全体生效」：主窗口 / 子窗口 / 对话框共用，
 * 不在每个调用点重复传 icon。
 */
let defaultWindowIcon: string | null = null

interface WindowFactoryBaseOptions extends Partial<BrowserWindowConstructorOptions> {
  icon?: string
}

interface MainWindowOptions extends WindowFactoryBaseOptions {
  maximized?: boolean
  autoLoadUiShell?: boolean
  webContentsManager?: Record<string, unknown>
  layout?: Record<string, unknown>
  windowRegistry?: WindowRegistry<BrowserWindowType> | null
}

interface SubWindowOptions extends WindowFactoryBaseOptions {
  url?: string
  modal?: boolean
  parent?: BrowserWindowType
  showOnReady?: boolean
  showOnReadyMode?: 'show' | 'inactive'
  windowType?: string
  windowRegistry?: WindowRegistry<BrowserWindowType> | null
  webPreferences?: WebPreferences
}

interface MainWindowResult {
  win: BrowserWindowType
  webContentsManager: WebContentsManagerInstance
  layoutCoordinator: LayoutCoordinatorInstance
  ready: Promise<unknown>
}

export function setDefaultWindowIcon(iconPath: string | null | undefined): void {
  defaultWindowIcon = iconPath || null
}

function windowIconOption(options: WindowFactoryBaseOptions): { icon?: string } {
  const icon = options.icon || defaultWindowIcon
  return icon ? { icon } : {}
}

export function createMainWindow(options: MainWindowOptions = {}): MainWindowResult {
  const win = new BrowserWindow({
    width: options.width ?? 1100,
    height: options.height ?? 720,
    ...windowIconOption(options),
    // x/y 只在**有值**时传入：显式传 undefined 会让 Electron 把窗口丢到 (0,0)，
    // 而不是「由系统决定位置」。窗口状态持久化恢复几何时依赖这条。
    ...(Number.isFinite(options.x) ? { x: options.x } : {}),
    ...(Number.isFinite(options.y) ? { y: options.y } : {}),
    minWidth: options.minWidth ?? 480,
    minHeight: options.minHeight ?? 360,
    show: options.show ?? true,
    useContentSize: true,
    frame: false,
    // 主窗口同样显式声明：无边框 + 不透明（说明见 createSubWindow 的同类注释）。
    thickFrame: options.thickFrame ?? true,
    transparent: options.transparent ?? false,
    backgroundColor: options.backgroundColor ?? '#f9fafb',
    webPreferences: buildWebPreferences()
  })

  // 恢复「上次是最大化」的窗口：必须在 show 之前 maximize，
  // 否则用户会先看到一个小窗口再跳成最大化（闪一下）。
  if (options.maximized) {
    try { win.maximize() } catch (_) {}
  }

  // chrome 归一到窗口本体（对齐 RT FakeWebContentsViewLayer）：
  // 不再加载 about:blank 空转 renderer —— 窗口自身 webContents 就是浏览器外壳基座，
  // 随后由 loadUiShell() 载入 app-shell。省一份 renderer 进程，关闭/生命周期语义回归。
  const wcm = new WebContentsManager(win, options.webContentsManager || {})
  const layout = new LayoutCoordinator(win, wcm, options.layout || {})

  layout.attachUiShell()
  layout.attachRail()
  // 对齐 RT：启动期只创建 chrome(uiShell = 窗口本体) + rail 两个视图。
  // 4 个通用浮层 + 密码浮层一律延迟到「首次真正显示」时由
  //   LayoutCoordinator._ensureFloatView / _ensurePasswordOverlay 惰性创建，
  // 省掉启动期 5 个多余渲染进程。
  const ready =
    options.autoLoadUiShell === false
      ? Promise.resolve()
      : Promise.all([wcm.loadUiShell(), wcm.loadRail()])

  const registry = options.windowRegistry || null
  if (registry instanceof WindowRegistry) registry.register(win, 'browser')

  return { win, webContentsManager: wcm, layoutCoordinator: layout, ready }
}

/**
 * 创建子窗口（28 种统一入口）。
 * infra 层不关心业务类型，只接收 url 和窗口参数。
 * @param {object} options
 * @param {string} options.url          加载的 URL（hira://xxx 或 dev server 路径）
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.x]                 创建时的 x（仅在有值时传入，同 createMainWindow）
 * @param {number} [options.y]                 创建时的 y
 * @param {number} [options.minWidth]
 * @param {number} [options.minHeight]
 * @param {boolean} [options.modal]
 * @param {BrowserWindow} [options.parent]
 * @param {boolean} [options.show]
 * @param {boolean} [options.frame]            无边框窗口（如书签编辑器对齐 Hira）
 * @param {boolean} [options.alwaysOnTop]       始终置顶
 * @param {boolean} [options.autoHideMenuBar]   自动隐藏菜单栏
 * @param {boolean} [options.skipTaskbar]       不占任务栏
 * @param {boolean} [options.showOnReady]       ready-to-show 后再 show（避免白闪）
 * @param {('show'|'inactive')} [options.showOnReadyMode]  就绪后显示方式：'inactive' 不夺焦点（浮层提示类）
 * @param {string} [options.title]
 * @param {string} [options.backgroundColor]   不透明背景色（避免 show 时白屏）
 * @param {boolean} [options.hasShadow]        原生系统阴影
 * @param {boolean} [options.paintWhenInitiallyHidden] 隐藏时也绘制（配合 showOnReady 免白闪）
 * @param {boolean} [options.thickFrame]       Windows 上保留可拖拽的粗边框
 * @param {boolean} [options.resizable]
 * @param {boolean} [options.minimizable]
 * @param {boolean} [options.maximizable]
 * @param {boolean} [options.fullscreenable]
 * @param {string} [options.windowType]        登记到 WindowRegistry 的类型维度（默认 'window'）
 * @param {WindowRegistry} [options.windowRegistry]
 * @returns {{ win: BrowserWindow }}
 */
export function createSubWindow(options: SubWindowOptions = {}): { win: BrowserWindowType } {
  const showOnReady = options.showOnReady === true
  // 就绪后的显示方式：浮层提示类窗口（JS 对话框等）必须 showInactive —— 不抢焦点，
  // 否则会把父窗口的焦点从输入框上夺走。
  const showInactive = options.showOnReadyMode === 'inactive'
  const win = new BrowserWindow({
    width: options.width ?? 520,
    height: options.height ?? 420,
    ...windowIconOption(options),
    // x/y 只在**有值**时传入（与 createMainWindow 同一口径）：显式传 undefined 会被
    // Electron 当成 (0,0)，而不是「由系统决定位置」。扩展弹窗需要按锚点算好落点后
    // 一次性创建 —— 建完再 setPosition 会先闪一下再跳到目标位置。
    ...(Number.isFinite(options.x) ? { x: options.x } : {}),
    ...(Number.isFinite(options.y) ? { y: options.y } : {}),
    minWidth: options.minWidth ?? 0,
    minHeight: options.minHeight ?? 0,
    show: showOnReady ? false : (options.show ?? true),
    modal: Boolean(options.parent) && options.modal !== false,
    parent: options.parent || undefined,
    title: options.title,
    // frame 必须给默认值 true。显式传 undefined 会被 Electron 当作「无边框」，
    // 而页面型子窗口（关于 / 下载 / 历史 / 书签 / 权限 / 会话 / 快捷键 …）的界面里
    // **没有任何自绘关闭入口**（pages/_shared 全局搜 close 零命中）—— 一旦无边框就彻底关不掉。
    // 真正需要无边框的窗口（书签编辑器 / JS 对话框 / HTTP 认证）都在 window-config.js 里
    // 显式写了 `frame: false`，并各自带自绘关闭按钮，不受此默认值影响。
    frame: options.frame ?? true,
    alwaysOnTop: options.alwaysOnTop,
    autoHideMenuBar: options.autoHideMenuBar,
    skipTaskbar: options.skipTaskbar,
    resizable: options.resizable ?? true,
    minimizable: options.minimizable ?? true,
    maximizable: options.maximizable ?? true,
    fullscreenable: options.fullscreenable ?? true,
    backgroundColor: options.backgroundColor,
    hasShadow: options.hasShadow,
    paintWhenInitiallyHidden: options.paintWhenInitiallyHidden,
    // Windows 专用窗口特性 —— 显式声明，不依赖 Electron 的默认值：
    //   thickFrame: true   → 无边框窗口（书签编辑器 / JS 对话框 / HTTP 认证）保留系统厚边框，
    //                        窗口阴影、边缘拖拽与系统动画都还在；
    //   transparent: false → 绝不创建透明窗口。透明窗口在 Windows 上极易整窗不可见
    //                        （渲染异常时就是「窗口建了却什么都看不见」的幽灵态），
    //                        而所有子窗口都已有实心 backgroundColor，本就不需要透明。
    thickFrame: options.thickFrame ?? true,
    transparent: options.transparent ?? false,
    useContentSize: true,
    webPreferences: buildWebPreferences(options.webPreferences || {})
  })

  const registry = options.windowRegistry || null
  if (registry instanceof WindowRegistry) registry.register(win, options.windowType || 'window')

  if (showOnReady) {
    // 窗口「建了却不显示」的幽灵态只有两种成因：ready 事件没来、或 show 没生效。
    // 这里一次性把两条都堵上 —— 三条兜底全部幂等，谁先到谁生效。
    let shown = false
    const showNow = () => {
      if (shown || win.isDestroyed()) return
      shown = true
      try {
        if (showInactive) {
          win.showInactive()
          // modal 窗口在 Windows 上偶发 showInactive 不生效（窗口不可见）→ 回退 show()。
          // 只在「确实没显示」时才回退，因此不会平白夺走父窗口的输入焦点。
          if (!win.isVisible()) win.show()
        } else {
          win.show()
        }
      } catch (_) {}
    }
    win.once('ready-to-show', showNow)
    // 兜底 1：`ready-to-show` 依赖 renderer 的首次绘制 —— 页面加载失败或极慢时可能
    // **永不触发**，窗口就会一直停在 show:false，成为「点了没反应」的幽灵窗口。
    win.webContents.once('did-finish-load', () => setImmediate(showNow))
    // 兜底 2：加载失败也要把窗口显出来（否则用户只看到"没反应"），并留可诊断日志。
    win.webContents.once('did-fail-load', (_e: ElectronEvent, code: number, desc: string, failedUrl: string) => {
      console.error('[window] subwindow load failed:', code, desc, failedUrl)
      setImmediate(showNow)
    })
    // 兜底 3：极端情况（既不 finish 也不 fail）的最终保险。
    setTimeout(showNow, 1500)
  }

  if (options.url) {
    void win.loadURL(options.url).catch((error: unknown) => {
      console.error('[window] loadURL failed:', options.url, error instanceof Error ? error.message : String(error))
    })
  } else {
    void win.loadURL('about:blank').catch(() => {})
  }

  return { win }
}

export function createDialogWindow(options: SubWindowOptions = {}): { win: BrowserWindowType } {
  return createSubWindow({
    width: options.width ?? 520,
    height: options.height ?? 420,
    ...options,
    modal: options.modal ?? true
  })
}

export const createBlankWindow = createMainWindow
export { buildWebPreferences }
