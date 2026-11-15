import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

export interface PanelCatalogEntry {
  id: string
  title?: string
  icon?: string
  order?: number
  segment?: string
  pluginId?: string | null
  presentation?: string
  hostPage?: string | null
  [key: string]: unknown
}

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/**
 * 预取的「悬停落定」窗口。
 *
 * 为什么不是立刻发：鼠标从 rail 顶部划到面板的那一格，中途会掠过好几个入口 ——
 * 每掠过一格就造一个 renderer 进程，主进程要**连带销毁**上一个（拆进程是主线程开销），
 * 那比不预取还卡。等指针在同一格停住这一小段时间，才认为"它是真想开这个"。
 *
 * 60ms 低于人的"卡顿感知"阈值，又足以滤掉划过：点击最快也在 100ms 量级。
 */
const PREPARE_SETTLE_MS = 60
let prepareTimer: ReturnType<typeof setTimeout> | null = null
let prepareTarget = ''

/**
 * 把一次预取排进这个窗口（同目标的重复触发自动合并）。
 * @param {string} id
 */
function schedulePrepare(id: string): void {
  if (prepareTimer && prepareTarget === id) return
  if (prepareTimer) clearTimeout(prepareTimer)
  prepareTarget = id
  prepareTimer = setTimeout(() => {
    prepareTimer = null
    const target = prepareTarget
    prepareTarget = ''
    if (!target) return
    try { getHiraBridge().provider.send(IPC_ROUTES.panelPrepare, { panelId: target }) } catch (_) {}
  }, PREPARE_SETTLE_MS)
}

export const panelsClient = {
  /** 面板 id 列表（等价于 catalog().map(p => p.id)，保留给只需要 id 的调用方）。 */
  list() {
    return invoke(IPC_ROUTES.panelList)
  },
  /**
   * 面板目录：`{ id, title, icon, order, segment, pluginId }[]`。
   *
   * 这是「面板即插件」在渲染层的唯一数据源 —— rail / navbar / 按钮编辑浮层全部消费它。
   * 面板集合随插件启停变化，所以**不要缓存**：需要时现拉，并在 plugins:changed 后重拉。
   */
  catalog(): Promise<PanelCatalogEntry[]> {
    return invoke(IPC_ROUTES.panelCatalog).then((res) => {
      return Array.isArray(res.panels) ? res.panels as unknown as PanelCatalogEntry[] : []
    })
  },
  /**
   * 开关面板。
   *
   * @param {string} panelId
   * @param {{ side?: 'left'|'right' }} [opts]
   *   side：本次打开把面板放在哪一侧。**由「打开它的入口」自己声明** —— rail 图标传
   *   自己那一侧；导航栏的面板按钮传它此刻住哪（在顶部时靠右，借住到标签侧栏时就是
   *   侧栏那一侧，见 app-shell#onPlan 的 panelOpenSide）。不带 = 纯开关
   *   （面板自己的关闭按钮走这条）。
   *
   * 两侧各有面板位，可同时显示；同一个面板只占一个位（从另一侧打开它 = 挪过去）。
   */
  toggle(panelId: string, opts?: { side?: 'left' | 'right' }): Promise<{ open: boolean; panelId: string }> {
    const side = opts && (opts.side === 'left' || opts.side === 'right') ? opts.side : undefined
    return invoke<{ open: boolean; panelId: string }>(IPC_ROUTES.panelToggle, { panelId, side })
  },
  /** 强制打开面板；已打开时不关闭。 */
  show(panelId: string, opts?: { side?: 'left' | 'right' }): Promise<{ open: boolean; panelId: string }> {
    const side = opts && (opts.side === 'left' || opts.side === 'right') ? opts.side : undefined
    return invoke<{ open: boolean; panelId: string }>(IPC_ROUTES.panelShow, { panelId, side })
  },
  /**
   * 该面板**实际所在侧**与**是否钉住**：`{ side: 'left'|'right'|null, pinned: boolean }`。
   *
   * 面板宿主用它决定两件事：
   *   · 拖拽手柄放在哪条边（手柄必须在面向内容的那条边上，拖拽方向也随侧相反）；
   *   · 宽度往哪个槽写（普通位 / 钉住位各有一份宽度与记忆）。
   * 它与 app.sidebar_position 未必一致 —— 见 toggle 的 side 说明。
   * 面板宿主启动时问一次（那一刻早于事件订阅，推送会丢），之后靠 `onSideChanged` 纠正。
   */
  getSide(panelId: string) {
    return invoke(IPC_ROUTES.panelSide, { panelId })
      .then((res) => ({
        side: res && (res.side === 'left' || res.side === 'right') ? res.side : null,
        pinned: !!(res && res.pinned)
      }))
  },
  /**
   * 钉住 / 取消钉住（省略 pinned = 切换）。
   * 主进程是唯一真值：返回最终的 `{ pinned, side }`，宿主据此落 UI。
   */
  pin(panelId: string, pinned?: boolean) {
    return invoke(IPC_ROUTES.panelPin, {
      panelId: String(panelId),
      pinned: typeof pinned === 'boolean' ? pinned : undefined
    })
  },
  /**
   * 某面板实际所在侧 / 钉住状态变化（main → 面板宿主）：
   * `{ panelId, side, pinned }`（side 可为 null）
   */
  onSideChanged(handler: (payload: JsonRecord) => void) {
    return getHiraBridge().on.subscribe(IPC_EVENTS.panelSideChanged, handler)
  },
  /**
   * 插件集合变化（启用/禁用任一面板插件）→ 面板目录可能已变。
   * 订阅方应重拉 catalog() 并重建自己的按钮/图标列。
   */
  onChanged(handler: (payload: JsonRecord) => void) {
    return getHiraBridge().on.subscribe(IPC_EVENTS.pluginsChanged, handler)
  },
  /**
   * **意图预取**：入口被悬停 / 按下时发一次。
   *
   * 面板"关闭即销毁"，冷启动（建 renderer + 加载页面 + 求值模块）原先是全压在
   * 用户点击上的。提前到"鼠标已经在入口上"这一拍，点击时视图通常已经就绪 ——
   * 面板因此**原子出现**，不再有"点了没反应"的空档。
   *
   * 单向、无返回值、**幂等**（主进程单槽 + TTL 管理）：调用方不必去重，
   * hover 反复触发也只是同一条消息。失败静默 —— 预取永远不能影响点击本身。
   *
   * 发出时机由 `schedulePrepare` 决定：只有指针在同一个入口上**停住**才真发，
   * 划过一串入口不会各造一个进程（见 PREPARE_SETTLE_MS）。
   * @param {string} panelId
   */
  prepare(panelId: string) {
    const id = String(panelId == null ? '' : panelId)
    if (!id) return
    schedulePrepare(id)
  }
}

