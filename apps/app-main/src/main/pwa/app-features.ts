/**
 * PWA 应用窗 · 桌面级能力包
 *
 * ══════════════════════════════════════════════════════════════════
 * 一个应用窗「像一个应用一样好用」所需要的全部能力，收敛在这一个文件
 * ══════════════════════════════════════════════════════════════════
 *   · 页内查找（查找栏浮层 + Chromium 查找会话）
 *   · 页面缩放（快捷档位 / Ctrl+滚轮 / 缩放条浮层 / 按站点记忆）
 *   · 网页右键菜单（复用主浏览器同一份 infra 实现，过滤掉应用窗没有的宿主能力）
 *   · 快捷键（复用主浏览器的 keybindings 管理器与默认绑定）
 *   · 打印（交出现场，作业与预览窗口由主进程统一编排）
 *   · Esc / 窗口失焦这类「收尾动作」
 *
 * ── 为什么要独立成一层（而不是塞进 window.js）──────────────────────────
 * `window.js` 只认识「建窗 / 贴视图 / 导航 / 几何」；这些能力是**可插拔的叠加层**：
 * 将来要给应用窗加「阅读模式」之类的桌面能力，只动本文件，窗口本体不变。
 * 反过来，想在没有查找/缩放的场景复用应用窗（例如安装预览）时，不 new 这一层即可。
 *
 * ── 端口全部注入，不认识 IPC ──────────────────────────────────────────
 * 主进程的 `pwa:find-*` / `pwa:zoom-*` / `pwa-overlay:*` 通道只是把 renderer 的意图
 * 转给这里暴露的 `find / zoom / overlays`；本文件不 require 任何 ipc 注册器 ——
 * 与主窗口的 find-bar / zoom-controller / context-menu 同一套依赖方向。
 *
 * ── 为什么不能复用主窗口的控制器 ──────────────────────────────────────
 * 主窗口那套挂在 window-runtime-registry 上，PWA 窗不在注册表里 ——
 * 复用会让「应用窗 Ctrl+F」开到主窗口去。这里每个应用窗一份独立实例，天然隔离。
 */

import type {
  BrowserWindow,
  ContextMenuParams,
  Event as ElectronEvent,
  Input,
  WebContents
} from 'electron'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
// 菜单快捷键提示的唯一真源（动作名 → 键位 id → 当前组合串 → Electron accelerator）。
import { menuAccelerator } from '@hira-ng/shared-types/src/keybindings.mjs'
import { navigateWebHistory, onWebContentsDestroyed, showWebContentMenu, type ContextMenuOptions } from '@hira-ng/infra-window'
import { createFindBarController } from '../find-bar'
import { createZoomController, type ZoomPayload } from '../zoom-controller'
import { createKeybindingsManager } from '../keybindings'
import type { createPwaOverlayHost } from './overlay-host'

/** 浮层名（= renderer 目录名，与 overlay-host 的 OVERLAY_NAMES 逐字一致）。 */
const OVERLAY_FIND = 'findbar-overlay'
const OVERLAY_ZOOM = 'zoom-overlay'

/**
 * 应用窗里**没有对应宿主服务**的菜单项。
 *
 * 为什么必须显式排除而不是"留着反正点了没反应"：
 *   · `view-source` 在 infra 里有 `onOpenLink('view-source:…')` 的回落 —— 不排除会变成
 *     「点查看源代码 → 系统浏览器打开一个坏链接」；
 *   · 截图 / 翻译 / 小窗预览的落点都在主窗口外壳上（标签世界、下载面板），
 *     应用窗里没有它们的位置；
 *   · 「搜索选中内容」需要搜索引擎与标签世界，应用窗直接交给系统浏览器更符合直觉，
 *     但菜单项写着「使用 Bing 搜索」会让人以为在原地开新标签 —— 一并去掉。
 */
const EXCLUDED_COMMANDS = Object.freeze([
  'peek-link',
  'capture-viewport',
  'capture-fullpage',
  'capture-region',
  'translate-page',
  'view-source',
  'search-selection'
])

/**
 * 标签世界词汇 → 应用窗口词汇。
 * 应用窗没有标签栏，原样保留「在新标签页中打开链接」会让人找不到那个标签页。
 */
const LABEL_OVERRIDES = Object.freeze({
  'open-link': '在浏览器中打开链接',
  'open-link-window': '在浏览器新窗口中打开链接',
  'open-media': '在浏览器中打开'
})

/**
 * `did-start-navigation` 在本仓库有两种签名（位置参数 / details 对象）。
 * 统一读成一份判据，避免换签名后「查找会话不结束」这类静默失效。
 */
function readStartNavigation(args: unknown[]): { url: string; isSameDocument: boolean; isMainFrame: unknown } {
  const first = args[0]
  const details = first && typeof first === 'object'
    ? first as { url?: unknown; isSameDocument?: unknown; isInPlace?: unknown; isMainFrame?: unknown }
    : null
  if (details && typeof details.url === 'string' && typeof details.isMainFrame === 'boolean') {
    return {
      url: details.url,
      isSameDocument: details.isSameDocument === true || details.isInPlace === true,
      isMainFrame: details.isMainFrame
    }
  }
  return { url: String(args[1] || ''), isSameDocument: args[2] === true, isMainFrame: args[3] }
}

interface PwaSettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

interface PwaOverlayHost extends ReturnType<typeof createPwaOverlayHost> {}

export interface PwaAppFeaturesInput {
  appId: string
  win: BrowserWindow
  getPageWebContents(): WebContents | null | undefined
  overlayHost: PwaOverlayHost
  settings?: PwaSettingsPort | null
  settingsService?: PwaSettingsPort | null
  openExternal?(url: string): void
  shouldStayInWindow?(url: string): boolean
  printPage?(context: { wc: WebContents; title: string; url: string }): void
  getRetryUrl?(): string | null
  logger?: { warn?(...args: unknown[]): void }
}

interface WebContentsEventEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

interface WiredListener { event: string; handler: (...args: never[]) => void }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {object} input
 * @param {string} input.appId
 * @param {Electron.BrowserWindow} input.win
 * @param {() => Electron.WebContents|null} input.getPageWebContents 网页本体（可能还没建好）
 * @param {object} input.overlayHost `createPwaOverlayHost` 的实例
 * @param {{ get: Function, set: Function }} input.settings 缩放记忆的 KV 端口
 * @param {object} [input.settingsService] 完整设置服务（快捷键自定义与主窗口共享一份）
 * @param {(url: string) => void} [input.openExternal] 交给系统浏览器
 * @param {(url: string) => boolean} [input.shouldStayInWindow] 链接是否属于应用 scope
 * @param {(ctx: { wc: Electron.WebContents, title: string, url: string }) => void} [input.printPage]
 *        打印当前页面（作业编排在主进程，本层只交出现场）
 * @param {() => string|null} [input.getRetryUrl]
 *        错误页期间的失败地址（刷新 / Ctrl+R 重试它，而不是重载错误页）
 * @param {{ warn?: Function }} [input.logger]
 */
export function createPwaAppFeatures(input: PwaAppFeaturesInput) {
  const { appId, win, getPageWebContents, overlayHost } = input
  if (!appId || !win || !overlayHost) {
    throw new TypeError('createPwaAppFeatures 需要 appId / win / overlayHost')
  }
  const logger = input.logger || console
  const settings: PwaSettingsPort = input.settings || {
    get: () => undefined,
    set: () => undefined
  }

  let disposed = false

  function pageWebContents(): WebContents | null {
    if (disposed) return null
    try {
      const wc = typeof getPageWebContents === 'function' ? getPageWebContents() : null
      return wc && !wc.isDestroyed() ? wc : null
    } catch (_) {
      return null
    }
  }

  function chromeWebContents(): WebContents | null {
    if (disposed) return null
    try {
      const wc = win.webContents
      return wc && !wc.isDestroyed() ? wc : null
    } catch (_) {
      return null
    }
  }

  function sendToChrome(channel: string, payload: unknown): void {
    const wc = chromeWebContents()
    if (!wc) return
    try { wc.send(channel, payload) } catch (_) {}
  }

  // ── 查找 ────────────────────────────────────────────────────────────
  // hideFloat 是这个应用窗的「关栏收尾」唯一钩子：收起浮层后必须把键盘焦点还回去，
  // 否则焦点停在一个 0×0 的视图上，用户打字没有任何反应。
  const find = createFindBarController({
    layoutCoordinator: overlayHost,
    getActiveTabId: () => appId,
    getActiveWebContents: pageWebContents,
    hideFloat: (name: string) => {
      try { overlayHost.hideFloat(name) } catch (_) {}
      try {
        if (overlayHost.isFloatVisible(OVERLAY_FIND)) overlayHost.focusFloat(OVERLAY_FIND)
        else {
          const wc = pageWebContents()
          if (wc) wc.focus()
        }
      } catch (_) {}
    }
  })

  // ── 缩放 ────────────────────────────────────────────────────────────
  const zoom = createZoomController({
    getActiveWebContents: pageWebContents,
    settings,
    // 与主窗口 browser-window-runtime 的 notify 时序逐条对齐：
    // 非 restore 先登记可见（display 通道的闸门需要它），再推事件给缩放条浮层；
    // 浮层还没建时 sendToFloat 会惰性建视图并等到 did-finish-load 再发。
    notify: (payload: ZoomPayload) => {
      if (payload && payload.source !== 'restore') {
        try {
          if (!overlayHost.isFloatVisible(OVERLAY_ZOOM)) overlayHost.noteFloatShow(OVERLAY_ZOOM)
        } catch (_) {}
      }
      try {
        overlayHost.sendToFloat(OVERLAY_ZOOM, `ngipc:event:${IPC_EVENTS.zoomChanged}`, payload).catch(() => {})
      } catch (_) {}
      // chrome 也收一份（菜单 / 状态展示将来可以直接用），与主窗口推给外壳同一个口径。
      sendToChrome(`ngipc:event:${IPC_EVENTS.zoomChanged}`, payload)
    }
  })

  /**
   * 收起缩放条；同步复位浮层组件的显隐状态（否则下次同样的缩放不会重播动效）。
   *
   * 通道必须走 `ngipc:event:<route>`：renderer 侧 `bridge.on.subscribe(route)` 由 preload
   * 统一补前缀（见 shell-preload `makeChannel`），裸 `zoom-overlay:hide` 永远收不到。
   * 只用 `getFloatWebContents` 不建视图 —— blur 时不该为一条复位回执白开一个 renderer。
   */
  function hideZoomOverlay(): void {
    try { overlayHost.hideFloat(OVERLAY_ZOOM) } catch (_) {}
    try {
      const wc = overlayHost.getFloatWebContents(OVERLAY_ZOOM)
      if (wc) wc.send(`ngipc:event:${IPC_EVENTS.zoomOverlayHide}`, {})
    } catch (_) {}
  }

  // ── 快捷键 ──────────────────────────────────────────────────────────
  function navHistory(method: 'goBack' | 'goForward'): void {
    const wc = pageWebContents()
    if (!wc) return
    navigateWebHistory(wc, method === 'goBack' ? 'back' : 'forward')
  }

  // ── 打印 ────────────────────────────────────────────────────────────
  // 与主浏览器**同一个 printService / 同一个预览窗口**：本层只负责把「当前页面」
  // 交出去（webContents + 标题 + URL），不建 job、不渲染、不弹窗。
  // 端口缺省（安装预览等没有打印宿主的场景）时静默跳过。
  function printPage(): void {
    if (typeof input.printPage !== 'function') return
    const wc = pageWebContents()
    if (!wc) return
    let title = ''
    let url = ''
    try {
      title = wc.getTitle() || win.getTitle() || ''
      url = wc.getURL() || ''
    } catch (_) {}
    try {
      input.printPage({ wc, title, url })
    } catch (err) {
      logger.warn?.('[pwa-features] 打印失败:', errorMessage(err))
    }
  }

  /**
   * 动作表刻意只覆盖**应用窗真的拥有**的动作。
   * 其余默认绑定（新标签、切空间、分屏…）在这里没有对应函数 → 管理器判定为未命中 →
   * 不 preventDefault，页面自己还能收到按键（比如应用内 Ctrl+1 切视图）。
   */
  const actions: Record<string, () => unknown> = {
    'find:open': () => find.toggle(),
    'find:next': () => find.step(true),
    'find:prev': () => find.step(false),
    'page:print': () => printPage(),
    'zoom:in': () => zoom.step(1),
    'zoom:in-plus': () => zoom.step(1),
    'zoom:out': () => zoom.step(-1),
    'zoom:reset': () => zoom.reset(),
    'tab:reload': () => {
      const wc = pageWebContents()
      if (!wc) return
      // 应用窗停在错误页时，刷新的语义是「重试失败地址」。
      const retry = typeof input.getRetryUrl === 'function' ? input.getRetryUrl() : null
      if (retry) wc.loadURL(retry).catch(() => {})
      else wc.reload()
    },
    'tab:back': () => navHistory('goBack'),
    'tab:forward': () => navHistory('goForward'),
    'tab:close': () => { try { if (!win.isDestroyed()) win.close() } catch (_) {} },
    'view:devtools': () => { const wc = pageWebContents(); if (wc) wc.toggleDevTools() },
    'view:toggle-fullscreen': () => {
      try { if (!win.isDestroyed()) win.setFullScreen(!win.isFullScreen()) } catch (_) {}
    }
  }

  const keybindings = createKeybindingsManager({
    actions,
    // 传入真实的 settingsService：应用窗与主窗口**共享同一份自定义快捷键**。
    settingsService: input.settingsService || null
  })

  /**
   * Esc 单独处理：`normalizeCombo` 拒绝无修饰键的组合（Esc 不在默认绑定表里），
   * 而「Esc 关查找栏」是应用窗必须有的肌肉记忆。
   */
  function handleEscape(event: { preventDefault(): void }, rawInput: Input): void {
    if (!rawInput || rawInput.type !== 'keyDown') return
    if (rawInput.key !== 'Escape' && rawInput.key !== 'Esc') return
    if (!find.isOpen()) return
    event.preventDefault()
    find.close()
  }

  // ── 网页右键菜单 ────────────────────────────────────────────────────
  function buildContextMenuOptions(): ContextMenuOptions {
    return {
      ownerWindow: win,
      excludeCommands: EXCLUDED_COMMANDS,
      labelOverrides: LABEL_OVERRIDES,
      // 快捷键提示：与本应用窗的键位管理器同一份数据（用户改键后即时跟随）。
      accelerator: (command: string) => menuAccelerator(command, keybindings.getKeybindings()),
      // 链接 / 图片一律"在浏览器里打开"：scope 内就地导航（应用自己处理自己的路由），
      // scope 外交给系统浏览器 —— 与 window.js 的导航策略同一条判据。
      onOpenLink: (url: string, disposition: 'foreground-tab' | 'background-tab' | 'new-window') => {
        const target = String(url || '')
        if (!target) return
        if (disposition !== 'new-window') {
          try {
            if (typeof input.shouldStayInWindow === 'function' && input.shouldStayInWindow(target)) {
              const wc = pageWebContents()
              if (wc) { wc.loadURL(target).catch(() => {}); return }
            }
          } catch (_) {}
        }
        if (typeof input.openExternal === 'function') input.openExternal(target)
      },
      onSaveLinkAs: (url: string) => {
        const wc = pageWebContents()
        if (wc && url) { try { wc.downloadURL(String(url)) } catch (_) {} }
      },
      onSaveImageAs: (url: string) => {
        const wc = pageWebContents()
        if (wc && url) { try { wc.downloadURL(String(url)) } catch (_) {} }
      },
      onInspectElement: (x: number, y: number) => {
        const wc = pageWebContents()
        if (wc) { try { wc.inspectElement(x, y) } catch (_) {} }
      }
    }
  }

  // ── 监听登记 ────────────────────────────────────────────────────────
  // wc → [event, handler]。网页本体挂的事件比 chrome 多，但**摘除永远对称**：
  // dispose 逐条 removeListener，不允许「挂了没摘」留下悬空回调。
  const wired = new Map<WebContents, WiredListener[]>()

  function unwireWebContents(wc: WebContents): void {
    const listeners = wired.get(wc)
    if (!listeners) return
    wired.delete(wc)
    try { keybindings.detach(wc) } catch (_) {}
    const emitter = wc as unknown as WebContentsEventEmitter
    for (const { event, handler } of listeners) {
      try { emitter.removeListener(event, handler as (...args: unknown[]) => void) } catch (_) {}
    }
  }

  /**
   * 挂监听。`page` 区分「网页本体」与「chrome 标题栏」：
   * 标题栏只吃快捷键 / Esc，不该接管缩放记忆、查找会话与网页右键菜单。
   */
  function wireWebContents(wc: WebContents | null | undefined, { page = true }: { page?: boolean } = {}): void {
    if (!wc || wired.has(wc)) return
    const listeners: WiredListener[] = []
    const emitter = wc as unknown as WebContentsEventEmitter
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      unwireWebContents(wc)
    }
    const on = (event: string, handler: (...args: never[]) => void): void => {
      emitter.on(event, handler as (...args: unknown[]) => void)
      listeners.push({ event, handler })
    }

    keybindings.attach(wc)
    onWebContentsDestroyed(wc, release)
    on('before-input-event', handleEscape)

    if (page) {
      // Ctrl+滚轮：`zoom-changed` 只报 'in' / 'out'，换算成 ±1 交给同一个控制器
      //（与主窗口、按 origin 的记忆完全同源）。必须 preventDefault：否则
      // Chromium 自己也会缩一格，和这里叠成两格。
      on('zoom-changed', (event: unknown, direction: unknown) => {
        const eventPort = event as { preventDefault?(): void } | null
        try { eventPort?.preventDefault?.() } catch (_) {}
        zoom.step(direction === 'in' ? 1 : -1, wc, 'wheel')
      })

      // 导航到新站点：恢复该站点的缩放记忆（source='restore'，不弹缩放条）。
      on('did-navigate', () => {
        try { zoom.restore(wc) } catch (_) {}
      })

      // 主框架开始新导航：查找会话随旧页面一起结束（Chromium 的会话是绑页面的）。
      on('did-start-navigation', (...args: unknown[]) => {
        const nav = readStartNavigation(args)
        if (nav.isMainFrame === false || nav.isSameDocument) return
        try { if (find.isOpen()) find.close() } catch (_) {}
      })

      on('context-menu', (_event: ElectronEvent, params: ContextMenuParams) => {
        try {
          showWebContentMenu(wc, params, buildContextMenuOptions())
        } catch (err) {
          logger.warn?.('[pwa-features] 右键菜单失败:', errorMessage(err))
        }
      })
    }

    wired.set(wc, listeners)
  }

  // ── 窗口级失活收尾 ──────────────────────────────────────────────────
  // 与主窗口 browser-window-assembly 的 blur 收尾同一语义：
  // 查找栏继续持焦（回来打字会打进看不见的输入框）、缩放条是操作回执，一起收。
  const onWindowBlur = (): void => {
    try { find.close() } catch (_) {}
    hideZoomOverlay()
  }
  try { win.on('blur', onWindowBlur) } catch (_) {}

  // chrome 也挂快捷键（Ctrl+F / Ctrl+= 在标题栏上按下去也要生效），但不吃网页事件。
  wireWebContents(chromeWebContents(), { page: false })

  // 网页本体可能晚于本层就绪（window.js 先建视图再装配）—— 这里取一次，
  // 取不到就等视图建好后由 window.js 调 `attachPage()`。
  wireWebContents(pageWebContents())

  return {
    find,
    zoom,
    overlays: overlayHost,
    /** 打印当前页面（菜单 action / 快捷键共用）。 */
    print: printPage,

    /** 网页视图建好 / 重建后调用（幂等：同一个 wc 只挂一次）。 */
    attachPage(wc: WebContents) {
      if (disposed || !wc || wc.isDestroyed()) return
      wireWebContents(wc)
    },

    /** sender 是否属于本应用窗（chrome / 网页 / 两个浮层）。 */
    ownsSender(sender: WebContents | null | undefined) {
      if (!sender) return true
      if (chromeWebContents() === sender) return true
      if (pageWebContents() === sender) return true
      for (const name of [OVERLAY_FIND, OVERLAY_ZOOM]) {
        try {
          if (overlayHost.getFloatWebContents(name) === sender) return true
        } catch (_) {}
      }
      return false
    },

    /** 浮层加载完成后由 overlay-host 触发（重新落位 + 交还焦点）。 */
    relayout: () => { try { overlayHost.relayout() } catch (_) {} },

    dispose() {
      if (disposed) return
      // 先收查找 / 缩放：它们还要读页面 wc 与浮层；之后再置 disposed。
      try { win.removeListener('blur', onWindowBlur) } catch (_) {}
      try { find.close() } catch (_) {}
      try { zoom.flush() } catch (_) {}
      disposed = true
      // 对称摘除：快捷键管理器 + 当年通过 `on()` 登记的每一条监听。
      for (const wc of Array.from(wired.keys())) unwireWebContents(wc)
      wired.clear()
    }
  }
}
