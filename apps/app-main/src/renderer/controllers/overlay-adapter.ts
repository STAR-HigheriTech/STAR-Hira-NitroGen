/**
 * overlay-adapter.js —— 浮层适配器（ui-shell 侧的 overlay 统一出入口）
 *
 * 独立浮层图层：searchbar 下拉、tab preview、permission 弹窗渲染在各自独立的
 * overlay webContents view，不再扩展 navbar bounds 覆盖全窗口，tab 网页始终可交互。
 * 本适配器把「新浮层 IPC 转发」与「旧 overlay DOM API（compat）」统一成一个对象，
 * 供 navbar / tabbar 等哑组件调用 —— 组件只认接口，不认通道。
 *
 * 彻底解耦：provider 与 document 全部注入，不 import bridge、不读全局。
 *
 * 兼容旧 overlay API（mount/setVisible/position/unmount）：供尚未迁移到独立
 * 浮层 view 的小型弹窗在 ui-shell document.body 内渲染（后续逐步迁移清零）。
 */

/**
 * @typedef {object} OverlayAdapterDeps
 * @property {object} provider  window.hira.provider（单向 send / invoke）
 * @property {Document} document
 */
// 渲染层 UI 层级常量（单一真源 @hira-ng/shared-ui-tokens）——此处不写裸的 z-index 数字
import { UILayer } from '@hira-ng/shared-ui-tokens'
// 通道名的唯一真源：本适配器是外壳侧**唯一**的 overlay 出口，字符串不散落在调用方。
import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'

/**
 * 浮层名 → 预热入口的**唯一真源**。调用方只报「哪一类菜单」，不写字面量。
 * 名字必须落在主进程 FLOAT_NAMES 白名单内（ipc/layout.js）。
 */
const FLOAT = {
  searchbar: 'searchbar-overlay',
  tabpreview: 'tabpreview-overlay',
  overview: 'overview-overlay',
  siteinfo: 'siteinfo-overlay',
  targetPicker: 'target-picker-overlay'
} as const

interface OverlayProviderPort {
  send(route: string, payload?: unknown): void
  invoke(route: string, payload?: unknown): Promise<Record<string, unknown>>
}

export interface OverlayAdapterDeps { provider: OverlayProviderPort; document: Document }

interface CompatOverlayEntry { element: HTMLElement; visible: boolean; onHide?: () => void }

interface CompatMountOptions { x?: number; y?: number; onHide?: () => void }

/**
 * @param {OverlayAdapterDeps} deps
 */
export function createOverlayAdapter(deps: OverlayAdapterDeps) {
  const { provider, document } = deps

  /** @type {Map<string, {element:HTMLElement, visible:boolean, onHide?:()=>void}>} */
  const compat: Map<string, {element:HTMLElement, visible:boolean, onHide?:()=>void}> = new Map<string, CompatOverlayEntry>()

  /**
   * **预热**某个浮层：请主进程在后台建视图 + 载入渲染页（不显示，bounds 仍是 0×0）。
   *
   * ── 为什么不留"悬停落定窗口"（指针停 60ms 才真发）──────────────────────
   * 这段等待是**直接加在关键路径上**的：浮层各自是独立 renderer，冷启动要几百毫秒，
   * 而菜单类浮层的触发点寥寥可数（空间胶囊 / 站点身份按钮 / 书签栏文件夹）。指针一旦
   * 落在触发器上就已经是有意图了；早发 60ms，renderer 就早 60ms 开始加载。
   * 扫过造成的多余进程也有上界（就那几个触发器），且闲置回收照旧把它们收走。
   *
   * 主进程侧幂等（视图已存在则空转），见 LayoutCoordinator#warmFloatView。
   * @param {string} name 浮层名（主进程 FLOAT_NAMES 白名单校验）
   */
  function warmFloat(name: string) {
    try { provider.send(IPC_ROUTES.floatWarm, { name }) } catch (_) {}
  }

  return {
    // ── 独立浮层：单向 IPC 转发（不等待返回） ──
    /** 显示 searchbar 下拉框 */
    showSearchbar(payload: unknown) {
      try { provider.send(IPC_EVENTS.searchbarOverlayShow, payload) } catch (e) { console.error('[overlay] show-searchbar failed:', e) }
    },
    /**
     * **预热**下拉浮层：后台建视图 + 载入渲染页，不显示。
     *
     * 由地址栏在**获得焦点**时调用（见 ui-searchbar#onFocus）—— 下拉是跟着第一次按键
     * 出的，若那一刻才惰性创建浮层，用户要等一次 renderer 冷启动（数百毫秒）。
     * 主进程侧幂等、闲置仍会被回收，见 LayoutCoordinator#warmFloatView。
     */
    warmSearchbar() {
      warmFloat(FLOAT.searchbar)
    },
    hideSearchbar(options?: { keepFocus?: boolean }) {
      try { provider.send(IPC_EVENTS.searchbarOverlayHide, { keepFocus: !!(options && options.keepFocus) }) } catch (e) { console.error('[overlay] hide-searchbar failed:', e) }
    },
    updateSelection(selectedIndex: number) {
      try { provider.send(IPC_ROUTES.searchbarOverlayUpdateSelection, { selectedIndex }) } catch {}
    },
    showTabPreview(payload: unknown) {
      try { provider.send(IPC_EVENTS.tabpreviewOverlayShow, payload) } catch (e) { console.error('[overlay] show-tab-preview failed:', e) }
    },
    hideTabPreview() {
      try { provider.send(IPC_EVENTS.tabpreviewOverlayHide, {}) } catch (e) { console.error('[overlay] hide-tab-preview failed:', e) }
    },
    /**
     * **预热**标签预览浮层 —— 由 hover 状态机的 `onIntent` 在「起 700ms 停留计时」那一拍调用
     * （横向标签条 / 纵向列表 / 固定网格三处共用同一个信号，见 ui-common#hoverPreview）。
     * 700ms 足够盖住一次 renderer 冷启动，于是预览弹出时不再有"空框等一瞬"。
     */
    warmTabPreview() {
      warmFloat(FLOAT.tabpreview)
    },
    // ── 站点信息聚合浮层：地址栏锚定 ──
    // payload 由编排层组装：`{ anchor, site, tab, viewport }`。
    // 浮层自己测量卡片尺寸，主进程按 position:'anchor-below' 夹取边界 —— 坐标系不经过 navbar。
    /**
     * **预热**站点信息浮层 —— 站点身份按钮在 hover / pointerdown 上报意图
     * （见 ui-navbar#siteIdentity 的 onIntent）。
     */
    warmSiteInfo() {
      warmFloat(FLOAT.siteinfo)
    },
    showSiteInfo(payload: unknown) {
      try { provider.send(IPC_EVENTS.siteinfoOverlayShow, payload) } catch (e) { console.error('[overlay] show-site-info failed:', e) }
    },
    hideSiteInfo() {
      try { provider.send(IPC_EVENTS.siteinfoOverlayHide, {}) } catch (e) { console.error('[overlay] hide-site-info failed:', e) }
    },
    // ── 权限申请浮层：独立视图，固定弹在**内容区左上角** ──
    // payload 只有事实：`{ requests }`（id / origin / type / sensitive）。
    // 浮层自己测量卡片，主进程按 position:'in-content' + 左上对齐落位 ——
    // 不依赖铃铛锚点（铃铛已经并入站点身份按钮），也不认窗口坐标。
    showPermissionRequests(requests: unknown[]) {
      try { provider.send(IPC_EVENTS.permissionOverlayShow, { requests: Array.isArray(requests) ? requests : [] }) } catch (e) { console.error('[overlay] show-permission-requests failed:', e) }
    },
    hidePermissionRequests() {
      try { provider.send(IPC_EVENTS.permissionOverlayHide, {}) } catch (e) { console.error('[overlay] hide-permission-requests failed:', e) }
    },
    // ── 「总览」浮层：空间胶囊的下拉卡片（独立浮层图层，z 高于 rail / navbar）──
    // 为什么要独立图层：ui-shell 是窗口本体，处在所有原生子视图之下 —— 挂在它 DOM 里的
    // 卡片会被 #navbar 的 overflow 裁掉并被 rail 盖住，只能渲染在浮层视图里。
    // 浮层自己拉全部数据（常驻 visible、订阅不断），这里只报**事实**：
    //   · show 载荷 `{ x, y, viewport? }` —— x/y = 触发器的窗口坐标（外壳即窗口本体，
    //     client 坐标可直接用；独立视图由主进程按视图偏移平移好）；
    //   · hide 走通用 `:hide`（bounds 归零 + 浮层清 DOM），外壳不维护开合状态。
    /**
     * **预热**总览浮层 —— 空间胶囊在 hover / pointerdown 上报意图
     * （见 ui-space-switcher#onIntent）。
     */
    warmOverview() {
      warmFloat(FLOAT.overview)
    },
    showOverview(payload: unknown) {
      try { provider.send(IPC_EVENTS.overviewOverlayShow, payload) } catch (e) { console.error('[overlay] show-overview failed:', e) }
    },
    hideOverview() {
      try { provider.send(IPC_EVENTS.overviewOverlayHide, {}) } catch (e) { console.error('[overlay] hide-overview failed:', e) }
    },
    // ── 通用「选择目标」浮层：独立浮层图层（与 overview-overlay **同构**）──
    // 一处实现承接所有「挑一个落点」的交互：书签栏文件夹下拉、收进集锦……
    // payload 走单向 send：`{ source, anchor, ...业务事实 }`，浮层按来源拉内容、
    // 把卡片贴锚点摆进铺满整窗的视图里，选中 / 收起经 overlay:commit 回传发起方。
    // 调用方只报**事实**（来源 + 锚点矩形），不知道浮层名、不认通道细节。
    /**
     * **预热**选择目标浮层 —— 书签栏文件夹项在 hover / pointerdown 上报意图
     * （见 ui-bookmarkbar#onFolderIntent）。
     */
    warmTargetPicker() {
      warmFloat(FLOAT.targetPicker)
    },
    showTargetPicker(payload: unknown) {
      try { provider.send(IPC_EVENTS.targetPickerOverlayShow, payload) } catch (e) { console.error('[overlay] show-target-picker failed:', e) }
    },
    hideTargetPicker() {
      try { provider.send(IPC_EVENTS.targetPickerOverlayHide, {}) } catch (e) { console.error('[overlay] hide-target-picker failed:', e) }
    },

    // ── 兼容旧 overlay API（body 内 DOM，供未迁移的小型弹窗使用） ──
    mount(id: string, element: HTMLElement, opts: CompatMountOptions = {}) {
      this.unmount(id)
      element.style.position = 'fixed'
      element.style.zIndex = String(UILayer.popover) /* 兼容浮层容器 = popover */
      element.style.display = 'none'
      element.style.pointerEvents = 'none'
      if (opts.x != null) element.style.left = `${opts.x}px`
      if (opts.y != null) element.style.top = `${opts.y}px`
      document.body.appendChild(element)
      compat.set(id, { element, visible: false, onHide: opts.onHide })
    },
    unmount(id: string) {
      const e = compat.get(id)
      if (!e) return
      if (e.element.parentNode) e.element.parentNode.removeChild(e.element)
      if (typeof e.onHide === 'function') e.onHide()
      compat.delete(id)
    },
    position(id: string, x: number, y: number) {
      const e = compat.get(id)
      if (!e) return
      e.element.style.left = `${x}px`
      e.element.style.top = `${y}px`
    },
    setVisible(id: string, visible: boolean) {
      const e = compat.get(id)
      if (!e) return
      e.visible = visible
      e.element.style.display = visible ? '' : 'none'
      e.element.style.pointerEvents = visible ? 'auto' : 'none'
    },
    get(id: string) {
      return compat.get(id)?.element
    },
    dispose() {
      for (const id of [...compat.keys()]) this.unmount(id)
    }
  }
}

