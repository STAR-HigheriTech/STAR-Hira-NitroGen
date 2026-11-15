import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

function invoke(route: string, arg?: unknown): Promise<JsonRecord> {
  return getHiraBridge().provider.invoke<JsonRecord>(route, arg)
}

function send(route: string, payload?: unknown): void {
  try {
    getHiraBridge().provider.send(route, payload)
  } catch (_) {}
}

export const layoutClient = {
  setHeaderHeight(height: number): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.layoutSetHeaderHeight, { height })
  },
  setPageLayoutParams(params: unknown): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.layoutSetPageLayoutParams, params)
  },
  /** 结构布局上报：只推进主进程几何，不需要回包。 */
  setPageLayoutParamsLive(params: unknown): void {
    send(IPC_ROUTES.layoutSetPageLayoutParams, params)
  },
  /**
   * 设置面板宽度。
   * @param {number} width
   * @param {'left'|'right'} [side] 哪一侧 —— 两侧各有独立宽度，必须带上自己那一侧
   *   （面板宿主知道自己是哪一侧，见 panels-client#getSide）。不传 = 设置那一侧。
   * @param {'normal'|'pinned'} [slot] 哪一格 —— 同一侧的普通位与钉住位宽度各记各的
   *   （钉住面板通常更窄，拖它不该改到普通位）。不传 = 普通位。
   */
  setPanelWidth(width: number, side?: 'left' | 'right', slot?: 'normal' | 'pinned'): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.layoutSetPanelWidth, {
      width,
      side,
      slot: slot === 'pinned' ? 'pinned' : 'normal'
    })
  },
  /** 拖动帧：单向发送，不等待回包；松手时再走 `setPanelWidth` 做最终确认。 */
  setPanelWidthLive(width: number, side?: 'left' | 'right', slot?: 'normal' | 'pinned'): void {
    send(IPC_ROUTES.layoutSetPanelWidth, {
      width,
      side,
      slot: slot === 'pinned' ? 'pinned' : 'normal'
    })
  },
  /**
   * 设置 rail 原生视图的当前宽度。
   *
   * 拖拽时逐帧调用，失败静默由调用方处理；持久化宽度单独写 app.rail_width，
   * 因而这条通道不触发设置广播，也不会把拖拽放大成一串全量重排。
   */
  setRailWidth(width: number): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.layoutSetRailWidth, { width })
  },
  /** rail 拖动帧：单向发送；最终宽度由 `setRailWidth` 确认。 */
  setRailWidthLive(width: number): void {
    send(IPC_ROUTES.layoutSetRailWidth, { width })
  },
  /** 记录最后一个面板关闭时 rail 应恢复到的宽度；主进程据此与面板移除合并布局。 */
  setRailCloseRestore(expanded: boolean | null, width: number): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.layoutSetRailRestore, { expanded, width })
  },
  /**
   * 把**原生键盘焦点**交给某个已打开面板的视图。
   *
   * 面板显示本身不会自动获焦（FOCUS_PRIORITY=0，低于 tab-layer），
   * 而「打开面板即聚焦它的搜索框」是两件事：DOM 焦点（渲染层自己 focus()）
   * + 原生视图焦点（这一条）。缺后者时搜索框看着已聚焦、键盘输入却仍进网页。
   */
  focusPanel(panelId: string | number): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.layoutFocusPanel, { panelId: String(panelId) })
  },
  toggleRail() {
    return invoke(IPC_ROUTES.layoutToggleRail, {})
  },
  /** 独立侧栏当前几何（含 side / width）；工坊用它把真实侧栏加入可拖动图层。 */
  webSidebarGeometry(): Promise<JsonRecord> {
    return invoke(IPC_ROUTES.layoutWebSidebarGeometry, {})
  }
}
