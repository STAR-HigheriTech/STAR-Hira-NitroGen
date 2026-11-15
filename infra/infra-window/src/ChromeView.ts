/**
 * ChromeView —— 把「窗口自身 webContents」包装成与 WebContentsView 同形的「假视图」
 * （对齐 RT `FakeWebContentsViewLayer`）。
 *
 * ── 为什么需要它（根因）──────────────────────────────────────────────
 *   NG 此前把浏览器外壳（chrome：navbar / tabbar / bookmarkbar）做成一个独立的
 *   `WebContentsView`，而窗口自身的 `webContents` 空转 `about:blank` ——
 *   与 HiraRT（`browserWindow.webContents` 即 chrome）和旧 Hira
 *   （`contentView.children[0]` 是窗口本体）**方向相反**。后果：
 *     · 多一份 renderer 进程 + 多一次导航，启动更慢；
 *     · 窗口的关闭 / `window-all-closed` 语义失真；
 *     · chrome 要手工算 bounds（只覆盖 topbarHeight），renderer↔main 反复回报；
 *     · IPC 广播不得不特判「chrome 列表」。
 *
 * ── 归一后的模型 ─────────────────────────────────────────────────────
 *   chrome = 窗口本体（`win.webContents`）。它天然铺满窗口、天然位于 contentView
 *   所有子视图（tab / rail / panel / 浮层）**之下**，因此：
 *     · 无需 `addChildView`，无需 `setBounds`，无需显隐切换；
 *     · z-order 基座天然正确，不再依赖重排顺序。
 *
 *   本类只做一件事：让 `win.webContents` 具备与 WebContentsView 相同的**鸭子类型**
 *   表面（`webContents` / `getVisible` / `setVisible` / `setBounds`），使
 *   `WebContentsManager` / `LayoutCoordinator` 无需分支判断即可复用既有取用路径
 *   （`createUiShell().webContents`、`captureUiShell()`、`listChromeWebContents()`）。
 *
 * **彻底解耦**：本类不 require electron、不持有 session、不认识业务领域，
 *   只持有一个注入的 BrowserWindow 引用。
 */
import type { BrowserWindow, WebContents } from 'electron'

export class ChromeView {
  private readonly _win: BrowserWindow
  readonly isFake = true
  /**
   * @param {Electron.BrowserWindow} win 宿主窗口（其 webContents 即 chrome 基座）
   */
  constructor(win: BrowserWindow) {
    if (!win || typeof win.isDestroyed !== 'function') {
      throw new Error('[ChromeView] requires a BrowserWindow instance')
    }
    this._win = win
    /**
     * 恒 true：标记为「非真实 WebContentsView」。
     * 任何把视图当作原生子视图挂载（addChildView）的路径都必须跳过它 ——
     * 窗口本体不能、也不需要成为 contentView 的子视图。
     */
  }

  /** chrome 的 webContents = 窗口自身 webContents（窗口销毁后为 null） */
  get webContents(): WebContents | null {
    return this._win.isDestroyed() ? null : this._win.webContents
  }

  /** 窗口本体恒可见：不参与图层 setVisible 显隐 */
  getVisible(): boolean {
    return true
  }

  /** no-op：窗口本体无法（也不需要）被隐藏 */
  setVisible(): void {}

  /** no-op：窗口本体天然铺满 contentView，无需布局 */
  setBounds(): void {}

  isDestroyed(): boolean {
    return this._win.isDestroyed()
  }
}
