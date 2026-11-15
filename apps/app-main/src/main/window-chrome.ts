/**
 * 窗口级 chrome 辅助（按窗口参数化 —— 多窗口的第一步）。
 *
 * ── 为什么必须从 main.js 里抽出来 ────────────────────────────────
 * 下面这两者此前都是 main.js 闭包内的函数/对象，直接捕获了**那一个** layoutCoordinator。
 * 多窗口下这是致命的：浮层的显示/收起是按窗口裁定的，如果两个窗口共用一个
 * `hideFloat`，就会出现「窗口 B 里鼠标移出，把窗口 A 的浮层收掉」。
 *
 * 因此这里把「窗口」变成**显式参数**：每个浏览器窗口各建一份自己的
 * `{ passwordOverlayController, hideFloat }`，绑定到自己的
 * layoutCoordinator。main.js 只负责为每个窗口调用一次本工厂。
 *
 * 本模块不认识 TabManager / 业务领域，只依赖注入的 layoutCoordinator 端口，
 * 因此可单测、可在任意窗口复用。
 */

const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs')
import type { BrowserWindow, WebContents } from 'electron'

interface WindowChromeFloatOptions { keepFocus?: boolean; animateOut?: boolean }

interface WindowChromeLayoutPort {
  getWindow?(): BrowserWindow | null
  setSideColumnRevealListener?(listener: (revealed: boolean) => void): void
  setChromeDragSuppressedListener?(listener: (suppressed: boolean) => void): void
  setFloatDragGuardListener?(listener: (open: boolean) => void): void
  setFloatDismissListener?(listener: (name: string) => void): void
  setFloatDismissOnOutside?(name: string, enabled: boolean): void
  hideFloat?(name: string, options?: WindowChromeFloatOptions): boolean | void
  getFloatWebContents?(name: string): WebContents | null
  getUiShellWebContents?(): WebContents | null
  getFloatOpener?(name: string): WebContents | null
}

/**
 * @param {{ layoutCoordinator: WindowChromeLayoutPort, emit?: Function }} deps
 * @returns {{ passwordOverlayController: { hideTransient: () => void }, hideFloat: Function }}
 */
export function createWindowChrome({ layoutCoordinator, emit }: { layoutCoordinator: WindowChromeLayoutPort; emit?: (route: string, payload: unknown, options?: { windowId?: number }) => unknown }): { passwordOverlayController: { hideTransient: () => void }; hideFloat: (name: string, options?: WindowChromeFloatOptions) => void } {
  // 密码浮层"瞬态卡"收起控制器：具体实现由 ipc/passwords.js 注册时回填（hideTransient）。
  // 只收多凭据菜单 / 解锁卡；保存提示卡是待用户决定的请求，生命周期事件一律不动它。
  // 触发源：切标签（onTabSwitched）、导航开始（tab:loading 仅活动标签）、窗口失焦（win blur）。
  // 对象在前创建、方法后回填 —— 用可变引用解耦 ipc 注册时序，hook 运行时才调用。
  const passwordOverlayController = { hideTransient: () => {} }

  // ── 浮层压在 chrome 拖拽区上 → 各图层让位 ──────────────────────────────
  //
  // 为什么需要：`-webkit-app-region` 由 Chromium 按**整个窗口**合并所有 WebContentsView
  // 的命中区。浮层无法「盖住」下层声明的 drag —— panel 标题栏 / navbar / tabbar /
  // 书签栏 / rail 空白区的拖拽区一旦落在浮层矩形之下，点在浮层上的那一下会被窗口当作
  // 拖动标题栏吃掉（用户原话：「浮层不能穿透点击到后方 panel 标题栏的拖动区域……
  // 现在一点就拖动」）。唯一解法是让下层视图在那段时间**主动放弃** drag。
  //
  // 「那段时间」的判据**不在本文件**：它是一条纯几何事实 ——
  // **浮层矩形 ∩ chrome 拖拽带 ≠ ∅**，由 LayoutCoordinator 用本趟布局算出的拖拽带
  // 判定（见 `_chromeDragBands` / `_syncFloatDragGuard`）。于是：
  //   · 交互式浮层（侧栏浮出层 / 总览）与穿透式浮层（标签预览卡）**同一套规则**；
  //   · 不再有「模态浮层名单」这种要人肉维护的表，新增浮层自动被覆盖；
  //   · 浮层只在网页区时（查找栏 / 悬停 URL / 缩放条）完全不打扰拖窗口。
  let dragGuardOpen = false

  /** 本窗口 id（按窗口投递时用；拿不到就不带）。 */
  function currentWindowId(): number | undefined {
    try {
      const win = typeof layoutCoordinator.getWindow === 'function' ? layoutCoordinator.getWindow() : null
      if (win && !win.isDestroyed()) return win.id
    } catch (_) {}
    return undefined
  }

  function broadcastDragGuard(open: boolean): void {
    if (open === dragGuardOpen) return
    dragGuardOpen = open
    if (typeof emit !== 'function') return
    // 按窗口投递：多窗口下窗口 A 的浮层不该让窗口 B 的 chrome 也让位。
    const windowId = currentWindowId()
    try {
      emit('overlay:modal', { open }, windowId ? { windowId } : undefined)
    } catch (_) {}
  }

  /**
   * 「点它外面就收起」的浮层名单（Vivaldi 式轻量下拉的共同语义）。
   *
   * 只登记**非模态**的锚定卡片：模态浮层有自己的遮罩 / 显式关闭路径，塞进来会被
   * "点面板标题栏就消失"误伤。站点信息卡是纯信息 + 开关的轻量浮层，用户点网页、
   * 点标签栏、点地址栏都应当自然离开 —— 与浏览器原生地址栏气泡一致。
   */
  const DISMISS_ON_OUTSIDE_FLOATS = new Set(['siteinfo-overlay'])

  /**
   * 侧栏「悬停唤出」的档位变化 → 通知本窗口的外壳。
   *
   * 只发一个布尔：唤出**不是**第二个视图、不是覆盖层，而是把同一块侧栏的宽度
   * 从 0 切到 revealWidth（网页因此真的让位）。几何全在布局层算，这里不掺和。
   *
   * @param {boolean} revealed
   */
  function broadcastSideColumnReveal(revealed: boolean): void {
    if (typeof emit !== 'function') return
    const windowId = currentWindowId()
    try {
      emit(IPC_EVENTS.sideColumnReveal, {
        revealed: !!revealed
      }, windowId ? { windowId } : undefined)
    } catch (_) {}
  }

  if (layoutCoordinator && typeof layoutCoordinator.setSideColumnRevealListener === 'function') {
    layoutCoordinator.setSideColumnRevealListener((revealed: boolean) => {
      broadcastSideColumnReveal(revealed)
    })
  }

  let chromeDragSuppressed = false
  function broadcastChromeDragSuppressed(suppressed: boolean): void {
    const next = suppressed === true
    if (next === chromeDragSuppressed) return
    chromeDragSuppressed = next
    if (typeof emit !== 'function') return
    const windowId = currentWindowId()
    try {
      emit(IPC_EVENTS.chromeDragSuppressed, { suppressed: next }, windowId ? { windowId } : undefined)
    } catch (_) {}
  }

  if (layoutCoordinator && typeof layoutCoordinator.setChromeDragSuppressedListener === 'function') {
    layoutCoordinator.setChromeDragSuppressedListener(broadcastChromeDragSuppressed)
  }

  if (layoutCoordinator && typeof layoutCoordinator.setFloatDragGuardListener === 'function') {
    layoutCoordinator.setFloatDragGuardListener(broadcastDragGuard)
  }


  // ── 外部点击收起 ──────────────────────────────────────────────────────
  //
  // 布局层只负责**侦测**（在网页 / 其它 chrome 视图的 mouseDown 上回调），
  // 真正收起仍走 hideFloat —— 那一条才会给浮层 renderer 发 hide、给外壳发
  // overlay:closed（宿主据此复位开合状态），不会出现"收了但宿主以为还开着"。
  function bindFloatDismissSources(): void {
    if (!layoutCoordinator) return
    if (typeof layoutCoordinator.setFloatDismissListener === 'function') {
      layoutCoordinator.setFloatDismissListener((name: string) => hideFloat(name))
    }
    if (typeof layoutCoordinator.setFloatDismissOnOutside === 'function') {
      for (const name of DISMISS_ON_OUTSIDE_FLOATS) {
        layoutCoordinator.setFloatDismissOnOutside(name, true)
      }
    }
  }

  /**
   * 主进程权威收起独立浮层：逻辑可见态置隐藏（作废在途 show/display）+ 收起 bounds +
   * 通知浮层 renderer 清 DOM。
   *
   * 为什么必须由主进程兜底：浮层的"显示"由主进程裁定，"收起"也必须由主进程负责 ——
   * renderer 侧的 mouseout / blur 都是**易丢信号**（标签节点被 remove 不发 mouseout、
   * 跨窗口失焦收不到），只靠它们会让浮层挂着不关。
   */
  function hideFloat(name: string, options?: WindowChromeFloatOptions): void {
    if (!layoutCoordinator || typeof layoutCoordinator.hideFloat !== 'function') return
    // 只有**真的收起了什么**才发通知。`LayoutCoordinator#hideFloat` 的返回值就是唯一判据：
    // false = 它本来就没开着（逻辑不可见 + bounds 已为 0 + 没有在途退场）。
    // 为什么必须尊重它：切一次标签要过 8 个浮层名册、窗口失焦要过 13 个，绝大多数本来
    // 就没开着 —— 旧实现无条件给浮层发 `:hide`、给外壳 + 发起方发 `overlay:closed`，
    // 把外壳渲染进程白白唤醒十几次。用 `=== false` 而非 falsy：返回 undefined（别的实现 /
    // 未来签名变化）时保持旧行为，不会漏通知。
    if (layoutCoordinator.hideFloat(name, options) === false) return
    const wc = typeof layoutCoordinator.getFloatWebContents === 'function'
      ? layoutCoordinator.getFloatWebContents(name)
      : null
    if (wc && !wc.isDestroyed()) {
      try { wc.send(`ngipc:event:${name}:hide`, {}) } catch (_) {}
    }
    // 权威收起还要让**开合真源所在的视图**知道：浮层的开合真源在发起它的那个视图
    // （如书签夹的 folderOverlay —— 既可能是外壳，也可能是**侧栏浮出层**）。主进程兜底
    // 收起（切标签 / 窗口失焦）绕过了那一侧，不同步复位的话它会以为浮层还开着 ——
    // 下次数据刷新（相关事件）就会按「还开着」把浮层重新 show 出来。
    // 收件人 = 外壳 + 发起方（浮出层打开时就是它自己；两者相同则只发一次）。
    const targets = new Set<WebContents>()
    const shellWC = typeof layoutCoordinator.getUiShellWebContents === 'function'
      ? layoutCoordinator.getUiShellWebContents()
      : null
    if (shellWC && !shellWC.isDestroyed()) targets.add(shellWC)
    const opener = typeof layoutCoordinator.getFloatOpener === 'function'
      ? layoutCoordinator.getFloatOpener(name)
      : null
    if (opener && !opener.isDestroyed()) targets.add(opener)
    for (const wc of targets) {
      try { wc.send(`ngipc:event:${IPC_EVENTS.overlayClosed}`, { name }) } catch (_) {}
    }
  }

  bindFloatDismissSources()

  return { passwordOverlayController, hideFloat }
}

module.exports = { createWindowChrome }
