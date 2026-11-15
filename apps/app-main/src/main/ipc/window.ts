/**
 * IPC · Window / 原生 UI 域
 *
 * 原生上下文菜单（渲染进程请求主进程弹 Menu）+ 无边框窗口控制。
 *
 * ── 为什么菜单是"非阻塞"的（去阻塞核心）──────────────────────
 * 旧实现把 `ui:popup-menu` 的 invoke Promise 挂在菜单项的 click / popup callback
 * 上 —— 菜单存续期间该 IPC 一直 pending，渲染层（尤其右键链接/图片）被拖住。
 *
 * 现在：主进程弹出菜单后 **invoke 立即 resolve `{ ok: true }`**；用户点击的
 * action（或菜单关闭时的 null）经 `ui:popup-menu-selected` 单向事件、按 requestId
 * 回传给**发起方 renderer**，由渲染侧 `shared/menu-client.js` 对账。
 *
 * 两条从 context-menu.js 继承的硬规则（缺一会冻主进程）：
 *   - Menu 引用必须活到 `menu-will-close`（按窗口持有，关闭时释放）；
 *   - 永不显式 `closePopup()`（旧菜单由 Electron 在新 popup 时自然关闭）。
 */

import { Menu, BrowserWindow, clipboard, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface RendererMenuItem {
  label?: unknown
  type?: unknown
  enabled?: unknown
  checked?: unknown
  visible?: unknown
  accelerator?: unknown
  role?: unknown
  submenu?: RendererMenuItem[]
  action?: unknown
}
interface WindowIpcContext {
  routes: IpcRoutes
  events?: { uiPopupMenuSelected?: string }
  schemas: IpcSchemas['window']
  openSubWindowByType?: (type: unknown, payload: unknown) => unknown
  openBrowserWindow?: (options: { url: unknown; incognito: boolean }) => Promise<{ win?: { id: number } } | null | undefined> | { win?: { id: number } } | null | undefined
  listBrowserWindows?: () => unknown
  moveTabToWindow?: (request: unknown) => unknown
  layoutCoordinator?: MethodPort | null
  menuSlotItems?: ((slotId: string, snapshot: unknown, kind: string) => unknown[]) | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function senderOf(event: unknown): WebContents | null {
  if (!event || typeof event !== 'object' || !('sender' in event)) return null
  return (event as { sender?: WebContents }).sender || null
}

/**
 * 渲染层上报的「菜单种类」→ 官方插槽 id（PART7 §7.3）。
 *
 * 为什么由主进程做这张映射，而不是让渲染层直接传插槽 id：
 * 插槽 id 一旦由调用方自由指定，渲染层（含内部页）就能触发任意插槽
 * （比如 `db.schema.migration`）。这里只放行**明确的菜单扩展面**，
 * 相当于给"谁能调用哪个插槽"设了一道白名单。
 *
 * 新增一种可扩展菜单 = 这里加一行。
 */
const MENU_SLOT_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  bookmark: 'bookmark.context-menu',
  tab: 'tabbar.context-menu-item',
  // 列表 / 卡片类宿主：每个 kind 对应官方插槽表里同名的一条菜单插槽。
  // 新增一类扩展面 = 这里加一行 + `official-extension-points.js` 加一条，渲染层无需改。
  note: 'note.context-menu',
  history: 'history.context-menu',
  download: 'download.context-menu',
  easel: 'easel.context-menu',
  archive: 'archive.context-menu',
  'open-tab': 'open-tab.context-menu',
  media: 'media.context-menu',
  session: 'session.context-menu'
})

/** 单向事件通道名（与 preload makeChannel('ngipc','event',route) 一致）。 */
const evtCh = (route: string): string => `ngipc:event:${route}`

/** @type {Map<string, { menu: Electron.Menu, sender: Electron.WebContents }>} 窗口 → 正在展示的菜单 */
const activeMenus: Map<string, { menu: Electron.Menu, sender: Electron.WebContents }> = new Map<string, { menu: Menu; sender: WebContents }>()

function keyOf(win: BrowserWindow | null | undefined): string {
  return win && !win.isDestroyed() ? `win:${win.id}` : 'global'
}

/**
 * 规整菜单项列表：剔除 `visible === false` 的项，并折叠连续分隔符、去掉首尾分隔符。
 *
 * 为什么必须在主进程统一收口：渲染层是按「静态列表 + visible 条件」声明菜单的
 * （例如标签菜单里「静音标签」只在播放中可见、书签菜单的条件项只在特定状态可见）。
 * 若某个条件段整段不可见，它两侧的静态分隔符就会**相邻**，原生菜单会在中间渲染出
 * 一条空白栏（观感就是"多出来一栏"）。此处统一处理，所有菜单一并受益。
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
function normalizeMenuItems(list: unknown): RendererMenuItem[] {
  const out: RendererMenuItem[] = []
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || it.visible === false) continue
    if (it.type === 'separator') {
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue
      out.push(it as RendererMenuItem)
      continue
    }
    out.push(Array.isArray(it.submenu) ? { ...(it as RendererMenuItem), submenu: normalizeMenuItems(it.submenu) } : it as RendererMenuItem)
  }
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/**
 * @param {object} [deps.layoutCoordinator] - 按发送方窗口解析的布局协调器（scoped 代理）。
 *   只用来把渲染层上报的**视图内**坐标换算成窗口内容区坐标 —— 侧边面板是独立
 *   WebContentsView，与窗口本体差一个视图偏移（见下方 popup 处理里的归一化）。
 */
export function registerWindowIpc(
  typedMain: IpcTypedMain,
  { routes, events, schemas, openSubWindowByType, openBrowserWindow, listBrowserWindows, moveTabToWindow, layoutCoordinator, menuSlotItems }: WindowIpcContext
): void {
  // 回传通道：ui:popup-menu-selected（登记于 IPC_EVENTS，缺省兜底防漂移）。
  const selectedRoute = (events && events.uiPopupMenuSelected) || 'ui:popup-menu-selected'

  // ── UI: 原生上下文菜单（渲染进程请求主进程弹出原生 Menu）──
  typedMain.handle(routes.uiPopupMenu, {
    requestSchema: schemas.popupMenu.request,
    responseSchema: schemas.popupMenu.response,
    handler: async (e, req) => {
      const { items, x, y, requestId, context } = req
      const sender = senderOf(e)
      const win = sender ? BrowserWindow.fromWebContents(sender) || undefined : undefined

      /*
       * 坐标归一化（同步段完成，与 extensions.js#toWindowContentRect 同一口径）：
       * menu.popup 的 x/y 以**窗口内容区**为原点，而侧边面板是独立 WebContentsView，
       * 面板渲染层只能上报**视图内**坐标 —— 两者差一个视图原点偏移（面板靠左时
       * x 还要再算上 rail 宽度、y 要算上标题栏高度）。
       * 不补这一下，面板里的右键菜单会整体往左上错位：观感就是「菜单的腰落在鼠标处」，
       * 而不是左上角贴着鼠标。
       * 外壳（窗口本体）查不到视图偏移 → 原样使用，tabbar / navbar 的菜单行为不变。
       */
      const offset = asRecord(layoutCoordinator && typeof layoutCoordinator.getViewContentOffset === 'function'
        ? layoutCoordinator.getViewContentOffset(sender)
        : null)
      // 取整是**硬要求**：`menu.popup({ x, y })` 的 x/y 是 Int32（gin 转换），
      // 渲染层送来的 rect / clientX 在分数缩放下可能是 72.5 这类浮点 —— 直接传会让
      // popup 抛错，整条请求失败，观感就是「右键没反应」（渲染侧的 catch 以前还是静默的）。
      const popupX = typeof x === 'number' && Number.isFinite(x) ? Math.round(x + Number(offset.x || 0)) : undefined
      const popupY = typeof y === 'number' && Number.isFinite(y) ? Math.round(y + Number(offset.y || 0)) : undefined

      // 选中/关闭只回传一次（replied 守卫，避免重复事件）。
      let replied = false
      const reply = (action: unknown): void => {
        if (replied) return
        replied = true
        try {
          if (sender && !sender.isDestroyed()) {
            sender.send(evtCh(selectedRoute), { requestId, action: action || null })
          }
        } catch (_) {}
      }

      // 递归构建模板：子菜单（移动到…等）通过 submenu 数组实现嵌套。
      function build(it: RendererMenuItem): MenuItemConstructorOptions {
        const hasSubmenu = Array.isArray(it.submenu)
        const action = typeof it.action === 'string' && it.action ? it.action : ''
        const base: MenuItemConstructorOptions = {
          ...(typeof it.label === 'string' ? { label: it.label } : {}),
          ...(typeof it.type === 'string' ? { type: it.type as MenuItemConstructorOptions['type'] } : {}),
          enabled: typeof it.enabled === 'boolean'
            ? it.enabled
            : Boolean(it.role || hasSubmenu || action),
          ...(typeof it.checked === 'boolean' ? { checked: it.checked } : {}),
          ...(typeof it.visible === 'boolean' ? { visible: it.visible } : {})
        }
        // 快捷键提示：上下文菜单里的 accelerator 只做**展示**（Electron 不为它注册
        // 全局快捷键），正好用来在菜单右侧显示 Ctrl+X / Ctrl+C 这类提示。
        if (typeof it.accelerator === 'string') base.accelerator = it.accelerator as MenuItemConstructorOptions['accelerator']
        // 原生 role（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选…）：
        // 编辑语义交给 Electron 原生实现 —— 自己用 execCommand 做不了「粘贴」
        // （浏览器安全策略禁掉），而且这些项的启用状态由原生按当前选区自动裁定，
        // 无需手工维护。role 项由原生驱动，不需要 click 回传。
        if (typeof it.role === 'string') {
          base.role = it.role as MenuItemConstructorOptions['role']
          return base
        }
        if (hasSubmenu) {
          base.type = 'submenu'
          base.submenu = it.submenu!.map(build)
          if (typeof it.enabled !== 'boolean') {
            base.enabled = base.submenu.some((child) => child.type !== 'separator' && child.enabled !== false)
          }
        } else {
          base.click = () => reply(action)
        }
        return base
      }

      // 先规整再构建：不可见项剔除后，连续/首尾分隔符必须一起折叠，否则会出现空栏。
      const baseTemplate = normalizeMenuItems(items).map(build)

      /**
       * 插件贡献的菜单项（官方插槽 `bookmark.context-menu` 等）。
       *
       * 由**主进程自己**追加，而不是渲染层传进来 —— 于是实现的 `onSelect` 闭包直接挂在
       * 菜单项的 click 上，点击在主进程内完成，不需要往渲染层往返一次。
       * 也因此这些项**不会**经 `reply(action)` 回传：它们与渲染层的 action 通道无关。
       *
       * 渲染层只说"我这是哪一类菜单"（context.kind），由 MENU_SLOT_BY_KIND 白名单映射到插槽，
       * 避免渲染层能自由指定任意插槽 id。
       */
      const contextRecord = asRecord(context)
      const kind = contextRecord.kind ? String(contextRecord.kind) : ''
      const slotId = kind ? MENU_SLOT_BY_KIND[kind] : ''
      // 第三个参数 `kind` 让主进程同时合并**声明式**菜单贡献
      // （`contributes.menus` 里 where=bookmark.context 之类，见 plugin-surfaces.js）——
      // 那批项是纯数据，没有插槽实现可挂，只有拿到 kind 才能反查 where。
      const contributed = (kind && typeof menuSlotItems === 'function')
        ? menuSlotItems(slotId, contextRecord.snapshot || {}, kind)
        : []
      const template = contributed.length
        ? normalizeMenuItems([...baseTemplate, { type: 'separator' }, ...contributed])
        : baseTemplate

      // 空模板 = 一个可点项都没有。Electron 不会报错，只是"什么都没弹" ——
      // 那与「右键坏了」在用户眼里无法区分，故在这里留下线索并如实回报。
      if (!template.length) {
        console.error('[ui:popup-menu] empty menu template')
        reply(null)
        return { ok: false }
      }

      let menu
      try {
        menu = Menu.buildFromTemplate(template as MenuItemConstructorOptions[])
      } catch (error) {
        // 构建失败必须就地收口：让它冒泡会让 invoke reject，而渲染层那条链路
        // 历史上是静默吞错的 —— 最终现象就是"右键毫无反应"，且无任何日志。
        console.error('[ui:popup-menu] Menu.buildFromTemplate failed:', error)
        reply(null)
        return { ok: false }
      }

      // 规则：引用活到 menu-will-close 为止（关闭即释放）。
      const key = keyOf(win)
      if (sender) activeMenus.set(key, { menu, sender })
      const release = () => {
        if (win) {
          try { win.removeListener('closed', release) } catch (_) {}
        }
        const entry = activeMenus.get(key)
        if (entry && entry.menu === menu) activeMenus.delete(key)
      }
      // A native popup can still be open when its owner window is destroyed.
      // Do not keep the Menu / WebContents object graph alive in the module map.
      if (win) {
        try { win.once('closed', release) } catch (_) {}
      }

      // menu-will-close 只做引用清理，不承载业务结果：本 Electron 构建下它早于
      // 菜单项 click 触发，若在此 reply(null) 会抢先锁死 replied、吞掉真实 action。
      menu.once('menu-will-close', release)

      try {
        // null 兜底走 popup callback（必定晚于菜单项 click），再延后一个宏任务，
        // 双保险确保任何时序下真实 action 都不会被 null 抢先覆盖。
        menu.popup({
          window: win,
          x: popupX,
          y: popupY,
          callback: () => { release(); setTimeout(() => reply(null), 0) }
        })
      } catch (error) {
        console.error('[ui:popup-menu] menu.popup failed:', error)
        release()
        reply(null)
      }

      // invoke 立即返回：结果随后经 ui:popup-menu-selected 事件到达。
      return { ok: true }
    }
  })

  // ── 剪贴板（只读纯文本）──────────────────────────────
  // 地址栏「粘贴并前往」的数据源：与原生菜单 role: paste 同一个 `electron.clipboard`，
  // 保证「菜单里看到能前往的文本」和「手动粘贴出来的文本」完全一致。
  // 读不到（非文本 / 空 / 平台异常）一律回空串 —— 调用方只需判空，不必处理错误。
  typedMain.handle(routes.clipboardReadText, {
    requestSchema: schemas.clipboardReadText.request,
    responseSchema: schemas.clipboardReadText.response,
    handler: async () => {
      let text = ''
      try { text = clipboard.readText() || '' } catch (_) {}
      return { text }
    }
  })

  // ── Window controls (frameless window) ─────────────────
  typedMain.handle(routes.windowMinimize, {
    requestSchema: schemas.minimize.request,
    responseSchema: schemas.minimize.response,
    handler: async (e) => {
      const sender = senderOf(e)
      const win = sender ? BrowserWindow.fromWebContents(sender) : null
      if (win) win.minimize()
      return { ok: true }
    }
  })
  typedMain.handle(routes.windowMaximize, {
    requestSchema: schemas.maximize.request,
    responseSchema: schemas.maximize.response,
    handler: async (e) => {
      const sender = senderOf(e)
      const win = sender ? BrowserWindow.fromWebContents(sender) : null
      if (win) {
        // 全屏态的“最大化/还原”语义等同于退出全屏。
        // 直接 maximize() 会让 Windows 在已全屏窗口上再套一层最大化状态，
        // 产生几何/还原目标异常的奇怪窗口。
        if (win.isFullScreen()) win.setFullScreen(false)
        else if (win.isMaximized()) win.unmaximize()
        else win.maximize()
      }
      return { ok: true }
    }
  })
  typedMain.handle(routes.windowClose, {
    requestSchema: schemas.close.request,
    responseSchema: schemas.close.response,
    handler: async (e) => {
      const sender = senderOf(e)
      const win = sender ? BrowserWindow.fromWebContents(sender) : null
      if (win) win.close()
      return { ok: true }
    }
  })
  typedMain.handle(routes.windowGetState, {
    requestSchema: schemas.getState.request,
    responseSchema: schemas.getState.response,
    handler: async (e) => {
      const sender = senderOf(e)
      const win = sender ? BrowserWindow.fromWebContents(sender) : null
      if (!win) return { isMaximized: false, isFullscreen: false, minimizable: false, maximizable: false, resizable: false }
      // 能力一并回报：自绘标题栏按**真实窗口状态**亮按钮（见契约里的说明）。
      // isMinimizable/isMaximizable/isResizable 在个别平台可能缺失 → 包一层兜底。
      const safe = (method: string, fallback: boolean): boolean => {
        try {
          const candidate = (win as unknown as Record<string, unknown>)[method]
          return typeof candidate === 'function' ? Boolean((candidate as () => unknown).call(win)) : fallback
        } catch (_) {
          return fallback
        }
      }
      return {
        isMaximized: win.isMaximized(),
        isFullscreen: win.isFullScreen(),
        minimizable: safe('isMinimizable', true),
        maximizable: safe('isMaximizable', true),
        resizable: safe('isResizable', true)
      }
    }
  })

  // 原生窗口标题（任务栏 / Alt-Tab 上那一行）。
  // 渲染层送来的已经是**排版好的整串**（`页面标题 | 应用名`，规则在 shared-types），
  // 主进程这一层只负责落到窗口上 —— 换个窗口类型（子窗口 / 无痕）也不必各抄一遍规则。
  typedMain.handle(routes.windowSetTitle, {
    requestSchema: schemas.setTitle.request,
    responseSchema: schemas.setTitle.response,
    handler: async (e, req) => {
      const sender = senderOf(e)
      const win = sender ? BrowserWindow.fromWebContents(sender) : null
      const title = String((req && req.title) || '')
      if (win && !win.isDestroyed()) win.setTitle(title)
      return { ok: true }
    }
  })

  // ── 统一子窗口打开路由（28 种子窗口类型）──
  // 实现 openSubWindowByType 由 main.js 注入（闭包持有 createSubWindow/windowRegistry/
  // 主窗口引用），这里只做通道注册 —— 避免窗口工厂逻辑散落到 IPC 层。
  typedMain.handle(routes.windowOpen, {
    requestSchema: schemas.open.request,
    responseSchema: schemas.open.response,
    handler: async (_e, req) => {
      if (typeof openSubWindowByType !== 'function') {
        return { ok: false, error: 'openSubWindowByType is unavailable' }
      }
      return openSubWindowByType(req.type, req.payload)
    }
  })

  // ── 新建浏览器窗口 / 无痕窗口 ──────────────────────────────────
  // 与「统一子窗口路由」是两件事：这里要的是**又一个完整浏览器窗口**
  // （自带 chrome / TabManager / 独立标签条），不是 28 类辅助子窗口。
  // 未注入实现时如实返回失败，而不是静默 ok —— 静默成功会让 UI 以为窗口开了。
  typedMain.handle(routes.windowNew, {
    requestSchema: schemas.newWindow.request,
    responseSchema: schemas.newWindow.response,
    handler: async (_e, req) => {
      if (typeof openBrowserWindow !== 'function') {
        return { ok: false, error: 'openBrowserWindow is unavailable' }
      }
      try {
        const runtime = await openBrowserWindow({ url: req && req.url, incognito: false })
        return { ok: true, windowId: runtime && runtime.win ? runtime.win.id : undefined }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'open window failed' }
      }
    }
  })
  typedMain.handle(routes.windowNewIncognito, {
    requestSchema: schemas.newWindow.request,
    responseSchema: schemas.newWindow.response,
    handler: async (_e, req) => {
      if (typeof openBrowserWindow !== 'function') {
        return { ok: false, error: 'openBrowserWindow is unavailable' }
      }
      try {
        const runtime = await openBrowserWindow({ url: req && req.url, incognito: true })
        return { ok: true, windowId: runtime && runtime.win ? runtime.win.id : undefined }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'open window failed' }
      }
    }
  })

  // ── 多窗口：窗口清单 / 标签迁移 ────────────────────────────────
  // 两条都只做路由 → 服务方法映射：窗口集合与迁移编排都在 APPS 层（main.js），
  // 因为「哪个窗口」只有那边知道（registry + 当前空间 + 会话相关性）。
  typedMain.handle(routes.windowList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => ({
      windows: typeof listBrowserWindows === 'function' ? listBrowserWindows() : []
    })
  })
  typedMain.handle(routes.tabMoveToWindow, {
    requestSchema: schemas.moveTabToWindow.request,
    responseSchema: schemas.moveTabToWindow.response,
    handler: async (_e, req) => {
      if (typeof moveTabToWindow !== 'function') {
        return { ok: false, error: 'moveTabToWindow is unavailable' }
      }
      try {
        return await moveTabToWindow(req || {})
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'move tab failed' }
      }
    }
  })
}

