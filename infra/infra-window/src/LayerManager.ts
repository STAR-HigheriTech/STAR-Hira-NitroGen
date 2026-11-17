/**
 * LayerManager —— contentView 子视图的「图层管理器」（对齐 RT LayerManager）。
 *
 * ── 与 LayerStack 的分工（彻底解耦）────────────────────────────────────
 *   · LayerStack   = 纯规则：z 序 / 焦点优先级 / modal 谓词 / 前缀重排计划。零 electron、零副作用。
 *   · LayerManager = 纯宿主：持 view、排序、挂载/摘除、按前缀跳过做增量重排、焦点再分配。
 *   LayerManager 只依赖 LayerStack 的纯规则 + 注入的 parentView（一个 Electron View）。
 *
 * ── 三条核心机制（NG 此前缺失，直接导致切层卡顿/焦点错乱）──────────────
 *   1. **单次挂载 + setVisible**：图层只在 push 时 addChildView 一次，之后显隐只切
 *      setVisible，绝不 removeChildView/addChildView —— 后者会拆掉原生视图宿主
 *      （NativeViewHost），触发 WasHidden/WasShown + 合成器销毁重建 + 整页重绘。
 *   2. **z-order 增量重排（前缀跳过）**：addChildView 对已存在子 view 等价于「移到顶层」，
 *      故「按 低→高 全量重挂」与「只重挂相对上次已应用序列开始分歧的后缀」结果完全等价。
 *      面板/浮层增删时跳过不变的低层前缀 → 极低开销、零闪烁（RT `_layersChanged`）。
 *   3. **焦点再分配 + modal 阻塞**：图层隐藏后，把键盘焦点交给「优先级最高、
 *      且未被上层可见 modal 图层遮挡」的可见图层（RT `reallocateFocus`）。
 */
const { focusPriorityFor, createModalTo } = require('./LayerStack')

import type { WebContents, WebContentsView } from 'electron'
import { onWebContentsDestroyed } from './webContentsLifecycle'

interface ViewPort {
  isFake?: boolean
  webContents?: WebContents
  getVisible?(): boolean
  setVisible?(visible: boolean): void
  once?(event: 'destroyed', listener: () => void): unknown
}

interface ParentViewPort {
  addChildView(view: unknown): void
  removeChildView(view: unknown): void
}

interface LayerHost {
  getModalLayersFor(layer: Layer): Layer[]
  getFocusedLayer(): Layer | null
  reallocateFocus(): Layer | null
}

interface LayerOptions {
  name?: string
  zIndex?: number
  focusPriority?: number
  modalTo?: (otherName: string) => boolean
  isVisible?: () => boolean
}

interface LayerManagerOptions {
  isShellFocused?: () => boolean
  isForeignWindowFocused?: () => boolean
}

/**
 * 「没有遮挡层」的共享返回值。
 *
 * `getModalLayersFor` 被 `Layer#focus()` / `TabHostLayer#focus()` / `reallocateFocus`
 * 在**每一次焦点仲裁**里调用，而绝大多数窗口里根本没有 modal 图层 —— 每次 `filter`
 * 都产出一个空数组就是纯垃圾（焦点链路是本模块最高频的路径）。
 * 调用方只读 `.length`，共享一个冻结空数组即可。
 */
const EMPTY_LAYERS = Object.freeze([]) as unknown as Layer[]

let _WebContentsView: typeof WebContentsView | null = null
function _isWebContentsView(view: unknown): view is WebContentsView {
  if (!view) return false
  if (!_WebContentsView) {
    try { _WebContentsView = require('electron').WebContentsView as typeof WebContentsView } catch (_) { _WebContentsView = null }
  }
  return !!_WebContentsView && view instanceof _WebContentsView
}

/**
 * 单个图层：持有一个 Electron View，带 z 序 / 焦点优先级 / modal 谓词。
 * 可被子类覆盖 focus()/isFocused()/isVisible() —— 例如「标签容器图层」需把焦点
 * 代理到其内部当前可见的标签视图（容器自身不是 WebContentsView）。
 */
export class Layer {
  readonly manager: LayerHost
  readonly name: string
  readonly view: ViewPort
  readonly zIndex: number
  readonly focusPriority: number
  readonly modalTo: (otherName: string) => boolean
  private readonly _visibleOverride: (() => boolean) | null

  constructor(manager: LayerHost, view: unknown, options: LayerOptions = {}) {
    const { name = '', zIndex = 0, focusPriority, modalTo, isVisible } = options
    this.manager = manager
    this.name = String(name)
    this.view = view as ViewPort
    this.zIndex = Number.isFinite(zIndex) ? zIndex : 0
    // 非 WebContentsView（纯容器）默认不可聚焦；显式传入 focusPriority 可覆盖。
    const isWcv = _isWebContentsView(view)
    this.focusPriority = Number.isFinite(focusPriority)
      ? focusPriority
      : (isWcv ? focusPriorityFor(this.name) : -1)
    // 谓词签名与 LayerStack 一致：`(otherName) => boolean`（本图层是否遮挡 otherName）。
    this.modalTo = typeof modalTo === 'function' ? modalTo : createModalTo(this.name)
    /**
     * 可选的「是否可见」谓词。用于那些**常驻 visible、只靠 bounds 控制显隐**的图层
     * （浮层就是这样：切 setVisible 会让 Chromium 在变可见的瞬间原生抢走键盘焦点，
     * 把正在输入的地址栏顶掉）。没有它，0x0 收起态的浮层仍会被算作「可见图层」，
     * 错误地参与模态遮挡与焦点再分配。
     * @type {null | (() => boolean)}
     */
    this._visibleOverride = typeof isVisible === 'function' ? isVisible : null
  }

  get webContents(): WebContents | null {
    return _isWebContentsView(this.view) ? this.view.webContents : null
  }

  isWebContentsView(): boolean {
    return _isWebContentsView(this.view)
  }

  isFocused(): boolean {
    const wc = this.webContents
    if (!wc || typeof wc.isDestroyed !== 'function' || wc.isDestroyed()) return false
    return wc.isFocused()
  }

  focus(): boolean {
    const wc = this.webContents
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false
    // 被上层可见 modal 图层遮挡 → 不抢焦点
    if (this.manager.getModalLayersFor(this).length > 0) return false
    try { wc.focus(); return true } catch (_) { return false }
  }

  isVisible(): boolean {
    if (this._visibleOverride) return !!this._visibleOverride()
    return typeof this.view.getVisible === 'function' ? this.view.getVisible() : true
  }

  setVisible(visible: boolean, options: { keepFocus?: boolean } = {}): void {
    const next = Boolean(visible)
    const prev = this.isVisible()
    if (prev === next) return
    if (typeof this.view.setVisible !== 'function') return
    try { this.view.setVisible(next) } catch (_) { return }
    this._visibilityChanging(prev, next, options)
  }

  addThisAsChildView(parentView: ParentViewPort): void {
    parentView.addChildView(this.view)
  }

  removeThisFromParentView(parentView: ParentViewPort): void {
    parentView.removeChildView(this.view)
  }

  /**
   * 显隐变化时的焦点善后：本图层失去焦点（或它曾遮挡当前焦点图层）时，
   * 调度一次全局焦点再分配。对齐 RT `Layer#_visibilityChanging`。
   * @param {boolean} prevVisible
   * @param {boolean} nextVisible
   * @param {{ keepFocus?: boolean }} [options] keepFocus：本次收起不让位焦点
   *        （由调用方声明，如建议下拉因清空输入而消失 → 地址栏必须继续持有焦点）
   */
  _visibilityChanging(prevVisible: boolean, nextVisible: boolean, options: { keepFocus?: boolean } = {}): void {
    if (prevVisible !== true || nextVisible !== false) return
    // 调用方显式声明「本次收起不得让位焦点」（如建议下拉因清空输入而消失）。
    // 外壳（ui-shell / omnibox）不是图层，`getFocusedLayer()` 看不到它 —— 若不让位，
    // 焦点会误落到优先级最高的网页上，把正在输入的地址栏顶掉。
    if (options.keepFocus) return
    const wasFocused = this.isFocused()
    const focusedLayer = this.manager.getFocusedLayer()
    const shouldReallocate =
      wasFocused ||
      !focusedLayer ||
      (focusedLayer !== this && this.modalTo(focusedLayer.name) === true)
    if (shouldReallocate) setImmediate(() => this.manager.reallocateFocus())
  }
}

/**
 * 图层管理器：持一组 Layer，按 zIndex 升序挂载到 parentView。
 * 所有 z 序变化都走 `_layersChanged()`（前缀优化增量重排），零全量重挂。
 */
export class LayerManager implements LayerHost {
  readonly parentView: ParentViewPort
  private readonly _isShellFocused: (() => boolean) | null
  private readonly _isForeignWindowFocused: (() => boolean) | null
  layers: Layer[]
  oldLayers: Layer[]
  private readonly _destroyListeners: WeakSet<Layer>
  private _focusOrder: Layer[]

  constructor(parentView: ParentViewPort, options: LayerManagerOptions = {}) {
    this.parentView = parentView
    /**
     * 「浏览器外壳是否持有键盘焦点」探针（可选，由宿主注入）。
     *
     * 外壳（ui-shell / 地址栏）是**窗口本体**，按架构约定不进图层体系，因此
     * `getFocusedLayer()` 看不见它。缺了这一步，任何图层显隐（首次惰性创建浮层视图时
     * 的 `setVisible(false)`、面板/侧栏收起、标签重排）都会被误判成「无人持焦」，
     * 于是把键盘焦点抢给网页 —— 表现为「地址栏/搜索框刚聚焦就被顶掉」。
     * @type {null | (() => boolean)}
     */
    this._isShellFocused = typeof options.isShellFocused === 'function' ? options.isShellFocused : null
    /**
     * 「本应用的**另一个**窗口正持有键盘焦点」探针（可选，由宿主注入）。
     *
     * 为什么它必须参与焦点再分配：本窗口此刻是失活的，给窗口内的视图 `focus()`
     * 会把它重新激活，把那个窗口（典型：挂在本窗口下的查找栏窗口）刚拿到的焦点抢走。
     * 判据由宿主给（infra 不 require electron 的 BrowserWindow 也能做到，
     * 放这里只是为了让"零 electron 依赖"这条约束不破）。
     * @type {null | (() => boolean)}
     */
    this._isForeignWindowFocused = typeof options.isForeignWindowFocused === 'function'
      ? options.isForeignWindowFocused
      : null
    /** @type {Layer[]} 期望的图层集（升序） */
    this.layers = []
    /** @type {Layer[]} 上一次「已应用」到 parentView 的图层序列（前缀优化基准） */
    this.oldLayers = []
    this._destroyListeners = new WeakSet<Layer>()
    /**
     * 按**焦点优先级降序**预排好的图层序列（`reallocateFocus` 的唯一读取源）。
     *
     * 为什么预排：焦点优先级在图层构造时就定死了，只有图层集变化才可能改变相对次序；
     * 而 `reallocateFocus` 每次焦点仲裁都会跑（显隐善后 / pop / showTab / hideTab…）。
     * 在那里做 `filter + sort + 新数组` 等于把「结构变更时算一次」的开销搬到「每次仲裁」，
     * 是纯粹的浪费 —— 这里改成结构变更时重排一次（`_layersChanged` / `_removeDestroyedLayer`）。
     * @type {Layer[]}
     */
    this._focusOrder = []
  }

  /** 外壳（窗口本体 webContents）当前是否持有键盘焦点（探针缺失/异常一律视为 false） */
  isShellFocused(): boolean {
    if (!this._isShellFocused) return false
    try { return !!this._isShellFocused() } catch (_) { return false }
  }

  /** 图层是否可用：非 WebContentsView（纯容器）恒可用；WebContentsView 需 webContents 未销毁。 */
  isLayerUsable(layer: Layer | null | undefined): boolean {
    if (!layer) return false
    if (!layer.isWebContentsView()) return true
    const wc = layer.webContents
    return !!wc && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())
  }

  /** 为 WebContentsView 图层注册一次性 destroyed 监听：webContents 被销毁时自动摘层。 */
  _ensureDestroyListener(layer: Layer): void {
    if (!layer || !layer.isWebContentsView()) return
    if (this._destroyListeners.has(layer)) return
    const wc = layer.webContents
    if (!wc) return
    this._destroyListeners.add(layer)
    try {
      onWebContentsDestroyed(wc, () => this._removeDestroyedLayer(layer))
    } catch (_) {}
  }

  /** webContents 被销毁后：把图层从集合与已应用序列中彻底剔除并重排。 */
  _removeDestroyedLayer(layer: Layer): void {
    const hadLayer = this.layers.includes(layer)
    this.layers = this.layers.filter((l) => l !== layer)
    this.oldLayers = this.oldLayers.filter((l) => l !== layer)
    this._rebuildFocusOrder()
    if (hadLayer) {
      try { layer.removeThisFromParentView(this.parentView) } catch (_) {}
      setImmediate(() => this.reallocateFocus())
    }
  }

  /** 重排 `_focusOrder`（只读源；结构变更时调一次）。 */
  _rebuildFocusOrder(): void {
    this._focusOrder = this.layers.slice().sort((a, b) => b.focusPriority - a.focusPriority)
  }

  /**
   * 遮挡 targetLayer 的可见 modal 图层（按 z 序从高到低）。
   *
   * 单遍扫描、**按需分配**：`this.layers` 恒为 zIndex 升序（`_layersChanged` 维护），
   * 反向遍历即天然从高到低 —— 不需要额外 `sort`；没有遮挡层时直接返回共享空数组，
   * 不为「最常见的空结果」分配任何对象。
   */
  getModalLayersFor(targetLayer: Layer | null | undefined): Layer[] {
    if (!targetLayer || this.layers.length < 2) return EMPTY_LAYERS
    const targetZ = targetLayer.zIndex
    const targetName = targetLayer.name
    let out: Layer[] | null = null
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]
      if (l === targetLayer) continue
      if (l.zIndex <= targetZ) break
      if (!l.isVisible()) continue
      if (l.modalTo(targetName) !== true) continue
      if (!out) out = []
      out.push(l)
    }
    return out || EMPTY_LAYERS
  }

  /** 当前真正持有键盘焦点的图层（无则 null）。 */
  getFocusedLayer(): Layer | null {
    for (const l of this.layers) if (l.isFocused()) return l
    return null
  }

  /**
   * 焦点再分配：在「可见」图层中按焦点优先级降序，选第一个能成功拿到焦点的
   * （`Layer#focus` 内部会跳过被上层 modal 遮挡的图层）。对齐 RT `reallocateFocus`。
   *
   * **外壳持焦时一律不让位**：键盘焦点若正停在浏览器外壳（地址栏 / 工具按钮）上，
   * 图层变动无权把它交给网页。这里是唯一闸口 —— 所有调用方（显隐善后 / pop /
   * showTab / hideTab）都经由此处，无需各自重复判断。
   *
   * **本应用的另一个窗口正持焦时同样不让位**：这时本窗口是**失活**的（典型场景：
   * 挂在本窗口下的查找栏窗口被激活）。给本窗口里的视图 `focus()` 会把窗口重新激活，
   * 顺手把那个窗口刚拿到的键盘焦点抢回来 —— 表现就是"打字打到一半焦点又没了"。
   * 判据由宿主注入（见 `_isForeignWindowFocused`），本模块仍然零 electron 依赖。
   * @returns {Layer|null} 实际获得焦点的图层
   */
  reallocateFocus(): Layer | null {
    if (this.isShellFocused()) return null
    if (this._isForeignWindowFocused && this._isForeignWindowFocused()) return null
    // 读预排好的降序序列：这里只剩「可见性过滤 + 试焦」，不再排序、不再分配数组。
    for (const l of this._focusOrder) {
      if (!l.isVisible()) continue
      if (l.focus()) return l
    }
    return null
  }

  /**
   * z 序变化后的增量重排（RT `_layersChanged`）：
   *   1. 按 zIndex 升序排序；
   *   2. 摘除已不在集合中的旧图层；
   *   3. 计算「已应用序列」与「新序列」的最长公共前缀，只从分歧点开始重挂 ——
   *      因 addChildView 等价「移到顶层」，按 低→高 补挂后缀即得正确 z 序。
   */
  _layersChanged(): void {
    this.layers.sort((a, b) => a.zIndex - b.zIndex)
    const newLayers = this.layers
    const adjustedOld: Layer[] = []
    for (const old of this.oldLayers) {
      if (newLayers.includes(old)) {
        adjustedOld.push(old)
      } else {
        try { old.removeThisFromParentView(this.parentView) } catch (_) {}
      }
    }
    const limit = Math.min(adjustedOld.length, newLayers.length)
    let prefix = 0
    while (prefix < limit && adjustedOld[prefix] === newLayers[prefix]) prefix++
    for (let i = prefix; i < newLayers.length; i++) {
      try { newLayers[i].addThisAsChildView(this.parentView) } catch (_) {}
    }
    this.oldLayers = [...newLayers]
    this._rebuildFocusOrder()
  }

  has(layer: Layer): boolean {
    return this.layers.includes(layer)
  }

  /**
   * 加入图层（首次 addChildView；重复 push / 不可用图层 / 假视图为空操作）。
   *
   * 「假视图」（`view.isFake === true`，如 ChromeView = 窗口本体）**永不进入图层体系**：
   * 它不是 Electron View，不能、也无需成为 contentView 的子视图 —— 窗口本体天然位于
   * 所有子视图之下。这里做兜底拦截，保证任何调用方都无法把它误挂载。
   */
  push(layer: Layer | null | undefined): boolean {
    if (!layer || !layer.view) return false
    if (layer.view.isFake === true) return false
    if (!this.isLayerUsable(layer)) return false
    if (this.layers.includes(layer)) return false
    this._ensureDestroyListener(layer)
    this.layers.push(layer)
    this._layersChanged()
    return true
  }

  /** 移除图层（removeChildView + 重排；若它持有焦点则调度焦点再分配）。 */
  pop(layer: Layer): boolean {
    const idx = this.layers.indexOf(layer)
    if (idx === -1) return false
    const wasFocused = layer.isFocused()
    this.layers.splice(idx, 1)
    this._layersChanged()
    if (wasFocused) setImmediate(() => this.reallocateFocus())
    return true
  }

  /**
   * 把图层强制提升到最顶层（addChildView 等价「移到顶层」）。
   * 仅对「已是最高 z 序」的图层语义安全（如 password-overlay）；同步修正已应用序列。
   */
  raiseLayer(layer: Layer): boolean {
    if (!this.layers.includes(layer)) return false
    try { layer.addThisAsChildView(this.parentView) } catch (_) { return false }
    const idx = this.oldLayers.indexOf(layer)
    if (idx !== -1 && idx !== this.oldLayers.length - 1) {
      this.oldLayers.splice(idx, 1)
      this.oldLayers.push(layer)
    }
    return true
  }

  destroy(): void {
    this.layers = []
    this.oldLayers = []
    this._focusOrder = []
  }
}

