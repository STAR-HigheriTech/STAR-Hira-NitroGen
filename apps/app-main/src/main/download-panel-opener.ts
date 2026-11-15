/**
 * download-panel-opener.ts —— 下载开始 → 自动打开下载面板（选边策略在此一处）
 *
 * 职责边界：
 *   · `download-manager.js` 只认识"下载开始了"，不认识窗口 / 布局 / 面板目录；
 *   · 本文件只认识"把一个面板开到哪一侧"，不认识下载事件本身；
 *   · 两者的粘合（谁属于哪个窗口、面板目录有没有这一项）由 main.js 现场注入。
 *
 * 选边规则（用户口径）：
 *   · 面板**已经开在任一侧**（含钉住位）→ 什么都不做。
 *     不能改调 `showPanel(panelId, 另一侧)` 去"顺手修正"：LayoutCoordinator 的语义是
 *     **搬动**，那会把用户正在看的面板无故跳到另一边（点了没反应/乱跳的来源）。
 *   · 面板**拆在独立窗口里**（presentation === 'both' 且已 detach）→ 同样不动：
 *     它已经是打开状态，再 `showPanel` 会造出第二份（违背面板的单实例语义）。
 *   · 只有一侧有面板 → 开在**另一侧**（左边有 → 右边开）。
 *   · 两侧都空 / 两侧都忙 → 交给 `showPanel(panelId)` 走布局自己的默认侧：
 *     默认侧被占时它会按既有替换语义接管，不为下载单独发明一套规则。
 *
 * 为什么"选边"要独立成模块：它是**下载之外**也会复用的能力（将来"打开某个面板到空闲侧"
 * 的入口只需要调这里），写进下载管理器会让下载与布局耦合，写进 LayoutCoordinator 又会让
 * 布局层认识"下载"这种业务概念。这里只有 panelId + layout 两个输入，零业务词汇。
 */

/** LayoutCoordinator 的一侧是否已被占用（普通位或钉住位都算"这一侧有面板"）。 */
type PanelSide = 'left' | 'right'

interface PanelSlots {
  left?: string | null
  right?: string | null
  pinnedLeft?: string | null
  pinnedRight?: string | null
}

interface PanelLayout {
  showPanel?: (panelId: string, side?: PanelSide) => unknown
  getPanelSideOf?: (panelId: string) => PanelSide | null | undefined
  getPanelSlots?: () => PanelSlots | null
}

interface DownloadPanelOpenerDeps {
  getRuntime: (payload: object) => { layoutCoordinator?: PanelLayout | null } | null
  getPanelCatalog: () => { has?: (panelId: string) => boolean } | null
  isPanelDetached?: (panelId: string) => boolean
  panelId?: string
}

function sideBusy(slots: PanelSlots | null | undefined, side: PanelSide): boolean {
  if (!slots) return false
  return side === 'left'
    ? Boolean(slots.left || slots.pinnedLeft)
    : Boolean(slots.right || slots.pinnedRight)
}

/**
 * 把一个面板打开到"空闲的那一侧"。
 *
 * @param {object} layout LayoutCoordinator 实例
 * @param {string} panelId 面板 id
 * @returns {boolean} 本次是否真的发起了打开（已开着 / 参数不全时返回 false）
 */
function openPanelOnFreeSide(
  layout: PanelLayout | null | undefined,
  panelId: string
): boolean {
  if (!layout || typeof layout.showPanel !== 'function') return false
  const id = String(panelId || '')
  if (!id) return false

  // 已开（任一侧、含钉住）：保持不动。先判这一步，避免下面把它搬走。
  if (typeof layout.getPanelSideOf === 'function' && layout.getPanelSideOf(id)) return false

  let side: PanelSide | undefined
  if (typeof layout.getPanelSlots === 'function') {
    let slots: PanelSlots | null = null
    try { slots = layout.getPanelSlots() } catch (_) {}
    const leftBusy = sideBusy(slots, 'left')
    const rightBusy = sideBusy(slots, 'right')
    // 严格互斥才算"挑边"；同空 / 同忙都交给默认侧（见文件头第三条）。
    if (leftBusy && !rightBusy) side = 'right'
    else if (rightBusy && !leftBusy) side = 'left'
  }

  try {
    layout.showPanel(id, side)
    return true
  } catch (_) {
    return false
  }
}

/**
 * 造一个「下载开始」回调，交给 download-manager 的 `onDownloadStarted` 端口。
 *
 * @param {object} deps
 * @param {(payload:object) => object|null} deps.getRuntime
 *   由载荷（含 `webContents`）解析出**发起下载的那个窗口**的运行单元；
 *   解析不到时返回 null（调用方自行兜底焦点窗口）。
 * @param {() => object|null} deps.getPanelCatalog 面板目录（延迟取用，见 main.js 的时序说明）
 * @param {(panelId: string) => boolean} [deps.isPanelDetached]
 *   面板是否正住在**独立窗口**里（PanelPresentationService#isDetached）。
 *   缺省视为 false。延迟取用理由同 getPanelCatalog。
 * @param {string} [deps.panelId] 下载面板 id，缺省 `downloads-panel`
 * @returns {(payload:object) => void}
 */
function createDownloadPanelOpener({
  getRuntime,
  getPanelCatalog,
  isPanelDetached,
  panelId = 'downloads-panel'
}: DownloadPanelOpenerDeps): (payload: object) => void {
  return function onDownloadStarted(payload: object): void {
    try {
      // 面板目录可能尚未就绪（启动早期）—— 缺失即静默跳过，不让下载本身受影响。
      const catalog = typeof getPanelCatalog === 'function' ? getPanelCatalog() : null
      if (catalog && typeof catalog.has === 'function' && !catalog.has(panelId)) return
      // 已拆在独立窗口：已经是"打开着"的状态，不再造第二份。
      if (typeof isPanelDetached === 'function') {
        try { if (isPanelDetached(panelId)) return } catch (_) {}
      }
      const runtime = typeof getRuntime === 'function' ? getRuntime(payload || {}) : null
      openPanelOnFreeSide(runtime && runtime.layoutCoordinator, panelId)
    } catch (_) {}
  }
}

module.exports = { createDownloadPanelOpener, openPanelOnFreeSide }
