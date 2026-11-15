/**
 * WCO（Window Controls Overlay）—— 系统原生窗口按钮在**渲染层的唯一感知点**。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 窗口控制按钮有两种实现（见 apps 层 browser-window-assembly#resolveWindowControlsMode）：
 *   · **自绘**（缺省）—— 三颗按钮是 ui-navbar 造的真实 DOM，可以去任何宿主块；
 *   · **系统原生**—— Electron 的 `titleBarOverlay`，由 **操作系统** 在窗口右上角绘制
 *     （Windows 11 下自带 Snap Layouts：悬停最大化弹出窗口布局预览，自绘永远做不到）。
 *
 * 原生模式是**建窗期**决定的（Windows 上无运行时开关），所以渲染层不需要"切换"，
 * 只需要在启动时问一次、然后照着它布置两件事：
 *
 *   ① **不要再自绘**那三颗按钮（否则系统按钮与应用按钮会叠在一起，看起来像画了两遍）；
 *   ② 把系统按钮**占掉的宽度**让出来 —— 原生按钮压在网页内容/接口之上（是 OS 画的，
 *      不在 DOM 里），标签条与行末按钮若铺到窗口最右，就会被压在按钮底下点不到。
 *      `navigator.windowControlsOverlay.getTitlebarAreaRect()` 给出"可拖拽标题栏区"的
 *      矩形，窗口宽减去它右边界 = 系统按钮实际占多宽（随 DPI / 系统缩放变化，
 *      所以**实测**而不是写死），写进 CSS 变量 `--ng-wco-reserve` 供样式消费。
 *
 * ── 判据是"在不在"，不是"有没有配" ────────────────────────────────
 * 只认 `navigator.windowControlsOverlay.visible` —— 浏览器（Electron）只有在
 * 建窗期真的启用了 overlay 时才暴露这个对象。**绝不**自己去读设置然后推断：
 * 那会出现"设置说原生、窗口其实没启用"的分裂（渲染层的设置订阅晚于建窗，
 * 而且多窗口下每个窗口的建窗时刻不同）。让窗口自己回答，是唯一不会撒谎的答案。
 *
 * ── 边界 ──────────────────────────────────────────────────────────
 * 不碰任何按钮、不认识布局、不知道 ui-navbar 的存在：只写两个事实
 * （`document.body.dataset.windowControls` 与 `--ng-wco-reserve`），
 * 谁想用谁来读 —— 于是"再加一个需要避开系统按钮的行"不必改这里。
 */

/** 系统按钮宽度的**兜底估值**（Windows 三颗 ≈ 138px）—— 只有在拿不到矩形时才用。 */
const FALLBACK_RESERVE_PX = 138

/**
 * @param {Document} doc
 * @returns {{
 *   native: boolean,
 *   reserve: number,
 *   sync: () => number,
 *   dispose: () => void
 * }}
 *   `native` = 本窗口由系统绘制窗口按钮；`reserve` = 系统按钮占用的右侧宽度（px）。
 */
export function createWindowControlsOverlay(doc: Document) : {
  native: boolean,
  reserve: number,
  sync: () => number,
  dispose: () => void
} {
  const overlay = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null
  const native = !!(overlay && overlay.visible === true)
  let reserve = native ? FALLBACK_RESERVE_PX : 0

  /**
   * 实测系统按钮占宽并写进 CSS 变量（幂等；值没变不写，避免无谓的样式失效重算）。
   *
   * 「可拖拽标题栏区」的右边界到窗口右缘之间就是系统按钮的地盘。宽度取整
   * （布局只关心整数像素，分数会让相邻的标签条出现半像素缝）。
   * @returns {number}
   */
  function sync() : number {
    if (!native) return 0
    let next = 0
    try {
      const rect = overlay.getTitlebarAreaRect()
      // rect 是窗口坐标系下的 CSS px：width === 0 表示此刻还量不到（视图未布局完），
      // 那种情况下退回兜底估值，等 geometrychange 再校正。
      if (rect && rect.width > 0) {
        next = Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width)))
      }
    } catch (_) { next = 0 }
    if (next <= 0) next = FALLBACK_RESERVE_PX
    reserve = next
    // **无条件写**（不做"值没变就不写"的短路）：Windows 上三颗按钮恰好 46×3 = 138px，
    // 与兜底估值相同 —— 若按"值没变"短路，首次 sync 就会因为等于初值而一次都不写，
    // 变量永远缺席、样式只能吃兜底值（换个 DPI / 系统缩放就错了）。
    try {
      doc.body.style.setProperty('--ng-wco-reserve', `${reserve}px`)
    } catch (_) {}
    return reserve
  }

  /** 窗口几何变化（含系统缩放 / 最大化）后系统按钮会重新量，跟着更新。 */
  const onGeometryChange = () => { sync() }
  const onResize = () => { sync() }

  if (native) {
    // 标记「本窗口的窗口按钮由系统画」：样式与装配都按它决定要不要自绘。
    try { doc.body.dataset.windowControls = 'native' } catch (_) {}
    sync()
    try { overlay.addEventListener('geometrychange', onGeometryChange) } catch (_) {}
    window.addEventListener('resize', onResize)
  }

  return {
    native,
    get reserve() { return reserve },
    sync,
    dispose() {
      if (!native) return
      try { overlay.removeEventListener('geometrychange', onGeometryChange) } catch (_) {}
      window.removeEventListener('resize', onResize)
    }
  }
}

