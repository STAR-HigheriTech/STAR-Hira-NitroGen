/**
 * peek —— 小窗预览（N1，Arc 的 Little Arc）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────
 * 很多链接只是"看一眼"：从别的应用点开的、聊天里贴的、搜索结果里想顺手确认的。
 * 给它开一个正式标签会污染标签栏；小窗预览把它放在一个**随时关掉的小窗口**里，
 * 看完就走；觉得值得留下时，一键**升级为正式标签**（Ctrl+Enter）。
 *
 * ── 窗口怎么拼：自绘标题栏 + 一个原生网页视图 ──────────────────────
 * 窗口本身（`win.webContents`）加载的是 **subwindow 入口**，只画一条标题栏
 *（拖动区 + 最小化 / 关闭，见 `renderer/subwindow/windows/peek.js`）；
 * **网页本体是另一条 webContents** —— 一个贴在标题栏正下方的 `WebContentsView`。
 *
 * 为什么不是"窗口直接 loadURL(网页)"：那样窗口的整块画布都归网页，自绘标题栏就没地方画。
 * 标题栏多高**只有渲染侧知道**（它在 DOM 里 —— padding / 字体 / 按钮尺寸共同决定，
 * 且要与书签编辑器那条标题栏保持**同一套样式**，因此更不能写死一个数）：
 * 渲染页量完用 `peek:chrome` 上报，本模块据此落位（见 `placePage`）。
 *
 * 由此还顺带定下两条口径：
 *   · **不注入 tab preload**（`preload: false`）：小窗没有标签那一整套宿主接线
 *     （右键菜单 / JS 对话框桥 / 跳转钩子都在主窗口的 tabEvents 上），注入进去
 *     只会让页面的 alert/confirm 被 preload 接管却没人应答 —— 那比不管更糟。
 *   · **session 取自发起页**（`payload.webContents.session`）：小窗里的网页与
 *     你右键的那一页共享同一 profile 与隐身态，登录态接得上，不是一座孤岛。
 *
 * ── 单例 ──────────────────────────────────────────────────────────
 * 小窗同时只留一个：它本来就是"浮在上面看一眼"，多开只会互相盖住，
 * 而且用户很难分清哪一个是刚才那个。
 *
 * ── 生命周期：跟着**发起它的那个窗口**一起关 ────────────────────────
 * 小窗是"从某个主窗口点开的链接"。若它比发起窗口活得久，就成了没人认领的幽灵窗
 * （会浮在桌面上不走，还会拖住"所有窗口关闭即退出"的判定）。
 * 这里绑的是**发起窗口的生命周期**，而**不是** Electron 的 `parent`：
 * 挂 parent 会把它降格成子窗口（永远压在主窗口之上、随主窗口最小化，且不占独立任务栏项），
 * 而小窗要能独立摆放、压到别的应用之上（见下）—— 所以只订阅 `closed` 这一个事实。
 */

import { WebContentsView, type BrowserWindow, type Session, type WebPreferences } from 'electron'

const { createSubWindow, buildTabWebPreferences } = require('@hira-ng/infra-window') as {
  createSubWindow(options: Record<string, unknown>): { win: BrowserWindow }
  buildTabWebPreferences(options: Record<string, unknown>): WebPreferences
}
const { ipcSchemas } = require('@hira-ng/infra-ipc') as typeof import('@hira-ng/infra-ipc')
const { WINDOW_TYPES, WINDOW_CONFIG, resolveWindowUrl } = require('./window-config') as {
  WINDOW_TYPES: Record<string, string>
  WINDOW_CONFIG: Record<string, Record<string, unknown>>
  resolveWindowUrl(...parts: string[]): string
}
const { IPC_EVENTS, IPC_ROUTES } = require('@hira-ng/shared-types/src/ipc-channels.mjs') as {
  IPC_EVENTS: Record<string, string>
  IPC_ROUTES: Record<string, string>
}
const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs') as { isHttpUrl(url: string): boolean }

interface PeekInput {
  url?: unknown
  session?: Session
  originWindow?: BrowserWindow
}

interface PeekDependencies {
  openInTab?(url: string): void
  windowRegistry?: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {object} deps
 * @param {(url: string) => void} deps.openInTab 把 URL 升级为正式标签（APPS 注入）
 * @param {object} [deps.windowRegistry]
 */
export function createPeekController(deps: PeekDependencies = {}) {
  const openInTab = typeof deps.openInTab === 'function' ? deps.openInTab : () => {}
  /** @type {Electron.BrowserWindow|null} */
  let current: BrowserWindow | null = null

  function close(): void {
    const win = current
    current = null
    try { if (win && !win.isDestroyed()) win.close() } catch (_) {}
  }

  return {
    /**
     * 打开小窗预览（重复调用会把上一个换掉）。
     * @param {{ url?: string, session?: any, originWindow?: any }} input
     *   `session`：发起页所属的 session（小窗里的网页沿用它，见文件头）
     *   `originWindow`：发起这次预览的窗口；它关掉时小窗**一起关**（见文件头「生命周期」）
     * @returns {{ ok: boolean, reason?: string }}
     */
    open(input: PeekInput = {}) : { ok: boolean, reason?: string } {
      const url = String(input.url == null ? '' : input.url).trim()
      if (!url) {
        console.warn('[peek] 没有可预览的地址')
        return { ok: false, reason: '没有可预览的地址' }
      }
      // 只预览网页：hira:// / about: / devtools:// 之类在小窗里没有意义。
      if (!isHttpUrl(url)) {
        console.warn('[peek] 非网页地址，已忽略:', url.slice(0, 80))
        return { ok: false, reason: '只支持网页地址' }
      }
      // 发起窗口（已销毁的当作没有）：小窗的生命周期绑在它上面。
      const originWindow = input.originWindow
        && typeof input.originWindow.isDestroyed === 'function'
        && !input.originWindow.isDestroyed()
        ? input.originWindow
        : null

      close()
      const cfg = WINDOW_CONFIG[WINDOW_TYPES.PEEK] || {}
      let win: BrowserWindow | null = null
      try {
        ;({ win } = createSubWindow({
          ...cfg,
          // 窗口自己的画面 = subwindow 入口（标题栏）。网页是贴上去的另一条视图。
          url: resolveWindowUrl('subwindow', WINDOW_TYPES.PEEK),
          windowType: WINDOW_TYPES.PEEK,
          windowRegistry: deps.windowRegistry,
          // 刻意**不挂 parent**：挂了就会被系统当作子窗口、锁在主窗口之上并随其最小化，
          // 而小窗要能单独摆放（与扫码取景框同一考量）。
          // 但"跟着主窗口一起关"这件事仍然要做 —— 不用 parent，改用**显式的生命周期订阅**
          //（见下方 originWindow 那段），两件事互不牵连。
          parent: null,
          title: '小窗预览'
        }))
      } catch (e) {
        // 建窗失败必须**可见** —— 静默吞掉就变成"点了没反应"，最难查。
        console.error('[peek] 创建小窗失败:', errorMessage(e))
        return { ok: false, reason: '创建小窗失败' }
      }
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
        console.error('[peek] 创建小窗失败：未拿到窗口句柄')
        return { ok: false, reason: '创建小窗失败' }
      }
      current = win

      // ── 生命周期绑定：跟着发起窗口一起关（见文件头「生命周期」）─────────────
      // 不用 Electron 的 `parent`（那会引入子窗口的堆叠/最小化语义），只订阅 `closed`
      // 这一个事实：发起窗口关掉时，如果当前还是这个小窗，就把它一起关掉。
      // 小窗自己先关时把监听摘掉 —— 发起窗口可能还活很久，别在它身上留一个闭包。
      if (originWindow) {
        const onOriginClosed = () => { if (current === win) close() }
        try {
          originWindow.once('closed', onOriginClosed)
          win.once('closed', () => {
            try { originWindow.removeListener('closed', onOriginClosed) } catch (_) {}
          })
        } catch (e) {
          console.warn('[peek] 生命周期绑定失败（小窗不会随主窗口关闭）:', errorMessage(e))
        }
      }

      // ── 网页本体：一条贴在标题栏正下方的原生视图 ────────────────────
      //
      // ⚠ 落位**等渲染侧报高度**（`peek:chrome`，见 ipc-channels 的说明）：
      //   标题栏是 DOM，高度由 padding / 字体 / 按钮尺寸共同决定；主进程写死一个数
      //   就会差出一条白缝。收到上报前先**隐藏**它，否则它会先盖住标题栏闪一下。
      let page: WebContentsView | null = null
      /** 已上报的标题栏高度（<= 0 表示还没收到）。 */
      let titlebarH = 0
      const placePage = (): void => {
        if (!page || titlebarH <= 0) return
        try {
          if (win.isDestroyed() || page.webContents.isDestroyed()) return
          // 窗口用 useContentSize: true（见 WindowFactory）→ 这里的坐标就是内容区坐标，
          // 与渲染侧那条标题栏 1:1 对齐。
          const [w, h] = win.getContentSize()
          page.setBounds({ x: 0, y: titlebarH, width: w, height: Math.max(0, h - titlebarH) })
          page.setVisible(true)
        } catch (_) {}
      }
      try {
        page = new WebContentsView({
          webPreferences: buildTabWebPreferences({
            // 小窗没有标签那套宿主接线（见文件头），一律不注入 preload。
            preload: false,
            // 与发起页同一个 session（同一 profile / 隐身态）—— 登录态接得上。
            ...(input.session ? { session: input.session } : {})
          })
        })
        win.contentView.addChildView(page)
        page.setVisible(false)
        // 只认**本窗口标题栏页面**的上报：用 `webContents.ipc`（按 webContents 收），
        // 而不是全局路由 —— 既不必动 ipc-routes 的装配，也免得别的窗口能改这里的位置。
        win.webContents.ipc.on(`ngipc:send:${IPC_ROUTES.peekChrome}`, (_event, payload) => {
          const req = ipcSchemas.window.peekChrome.request.safeParse(payload)
          if (!req.success) return
          titlebarH = Math.max(0, Math.round(Number(req.data.titlebarHeight) || 0))
          placePage()
        })
        // 尺寸固定（resizable:false），正常不会有 resize；仍按窗口实际内容尺寸兜一次 ——
        // 视图与窗口一旦对不上，用户看到的是标题栏下多一条空白（或网页被切掉一截），
        // 且没有任何报错。
        win.on('resize', placePage)
        win.on('enter-full-screen', placePage)
      } catch (e) {
        console.error('[peek] 创建网页视图失败:', errorMessage(e))
      }

      /**
       * 两个动作：留下（升级为正式标签）/ 关掉。
       *
       * ⚠ **不走菜单加速键**：本窗口是 `frame:false` 的自绘窗口，菜单栏根本不存在，
       *   而"无边框窗口上 setMenu 的加速键是否生效"依赖 Electron 版本行为 —— 一旦不生效，
       *   这两个动作就**彻底没有入口**（页面上也没有我们的按钮），属于静默失效。
       *   改用**窗口级按键拦截**：两个 webContents（标题栏 + 网页）都挂一份，
       *   于是无论焦点在哪都接得到，且与"窗口"而不是"菜单"绑定。
       */
      const openCurrentAsTab = () => {
        // ⚠ 取的必须是**网页那条视图**的当前地址，不是 win.webContents ——
        //   后者是标题栏那一页（subwindow 入口），拿它升级会开出一个设置页。
        let target = url
        try {
          if (page && page.webContents && !page.webContents.isDestroyed()) {
            target = page.webContents.getURL() || url
          }
        } catch (_) {}
        openInTab(target)
        close()
      }
      const onKey = (event: { preventDefault(): void }, input: { type?: string; key?: string; alt?: boolean; control?: boolean; meta?: boolean }): void => {
        if (!input || input.type !== 'keyDown') return
        if (input.key === 'Escape' && !input.alt) {
          event.preventDefault()
          close()
        } else if (input.key === 'Enter' && (input.control || input.meta)) {
          event.preventDefault()
          openCurrentAsTab()
        }
      }
      try {
        win.webContents.on('before-input-event', onKey)
        if (page) page.webContents.on('before-input-event', onKey)
      } catch (e) {
        console.warn('[peek] 快捷键装配失败（非致命）:', errorMessage(e))
      }

      // 标题：原生标题（任务栏）跟随页面标题；自绘标题栏那条由**渲染页**画，
      // 它观测不到网页的 page-title-updated（那是另一条 webContents），故推给它。
      if (page) {
        const pushTitle = (title: unknown): void => {
          const text = String(title == null ? '' : title).trim()
          try { if (!win.isDestroyed()) win.setTitle(text ? `${text} — 小窗预览` : '小窗预览') } catch (_) {}
          try {
            if (!win.isDestroyed()) win.webContents.send(`ngipc:event:${IPC_EVENTS.peekTitle}`, text)
          } catch (_) {}
        }
        try {
          page.webContents.on('page-title-updated', (_event, title) => pushTitle(title))
          pushTitle(page.webContents.getTitle())
        } catch (_) {}
      }

      win.on('closed', () => { if (current === win) current = null })
      if (page) {
        page.webContents.loadURL(url).catch((error) => console.warn('[peek] 加载失败:', errorMessage(error)))
      } else {
        // 视图没建起来就等于"窗口里什么都没有"——明说，别让用户对着空白猜。
        console.error('[peek] 没有网页视图，小窗将只显示标题栏')
      }
      return { ok: true }
    },

    close,
    /** 当前是否有小窗（诊断用）。 */
    isOpen: () => Boolean(current && !current.isDestroyed())
  }
}

