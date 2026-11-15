/**
 * 新标签页 · 看板（自定义摆放的核心）
 *
 * 职责边界（刻意划死，方便日后单独替换）：
 *   · 认识 store（状态）与 grid（几何），**不认识任何具体组件**
 *   · 认识注册中心，按 id 取组件定义；组件的内部实现它一概不知
 *   · 只做：挂载/卸载、自定义模式、拖拽、改尺寸、配置弹层、持久化
 *
 * 流畅性上的两个关键取舍：
 *  1) **位置一律用 transform**（不是 left/top）→ 拖拽全程只走合成层，不触发回流。
 *  2) **跟手与落点分离**：被拖的那一格按真实像素走（有 1:1 跟手感），落点每帧只算给自己；
 *     松手才提交。拖动过程中每帧只写 style，不读布局（不产生 forced reflow）。
 *
 * ── 一条不可动摇的纪律：**操作只影响被操作的那一格** ──────────────────────
 * 拖 A 时 B 不许动，拉大 A 时 B 不许动，搜索框也不许被谁"顺手挪走"。
 * 于是这里**没有任何"让位 / 上浮"**：落点被占就由 grid#placeFree 给这一格
 * 找最近的空位；改尺寸撞到别人就停在当前尺寸。详见 grid.js 头部。
 *
 * 落点规则全部委托给 grid.js（本层不自己判断哪里"合法"）：
 *   · 横向 —— **只有三处完美对称的锚点**：贴左 / 正中 / 贴右，按卡片自身宽度计算（见 grid#hAnchors）；
 *   · 纵向 —— 仍是整数行（竖向规则不变），只向下生长、不再上浮。
 * 于是"卡片永远只落在左/中/右"这件事只有一处出处，拖拽、缩放、新增组件、换断点全都从这里收口。
 */
import {
  BREAKPOINT_IDS,
  MAIN_BREAKPOINT,
  breakpoint,
  breakpointFor,
  siblingBreakpoint,
  load,
  save,
  flush,
  newInstanceId
} from './store.js'
import * as grid from './grid.js'
import { getWidget, resolveConfig } from './registry.js'
import { createSettingsForm } from './settings-form.js'
import { createPopover } from './popover.js'
import { createPicker } from './picker.js'
import { applyAppearance } from './appearance.js'
import { uiIconSvg } from 'hira://shared/runtime.js'
import type { LinkIntentEvent } from 'hira://shared/link-intent.mjs'
import type {
  BoardPreset,
  BoardPresetItem,
  Rect,
  WidgetConfig,
  WidgetDefinition,
  WidgetInstance,
  WidgetInstanceHandle
} from './types.js'

interface BoardOptions {
  host: HTMLElement
  openUrl: (url: string, event?: LinkIntentEvent) => void
  presets?: BoardPreset[]
}

interface BoardView {
  inst: WidgetInstance
  def: WidgetDefinition
  root: HTMLElement
  body: HTMLElement
  api: WidgetInstanceHandle | null
}

export interface BoardApi {
  isEditing: () => boolean
  setEditing: (next: boolean) => void
  toggleEditing: () => void
  onEditingChange: (callback?: (editing: boolean) => void) => void
  addWidget: (widgetId: string) => void
  openPicker: (anchor: HTMLElement) => void
  closePickers: () => void
  hasInstance: (widgetId: string) => boolean
  count: () => number
  destroy: () => void
}

export function createBoard(opts: BoardOptions): BoardApi {
  const host = opts.host
  const openUrl = typeof opts.openUrl === 'function' ? opts.openUrl : (_url: string) => {}
  /**
   * 默认摆放**预设表**由调用方给（板层不认识任何具体组件 id）。
   * 表按修订号升序，最后一个生效；前面的只用于识别"老用户那套没动过的默认"。
   */
  const presets: BoardPreset[] = Array.isArray(opts.presets) ? opts.presets.slice() : []
  const currentPreset = presets.length ? presets[presets.length - 1] : null
  const defaults: BoardPresetItem[] = currentPreset ? currentPreset.layout : []

  const state = load()
  const views = new Map<string, BoardView>()

  let bpId = breakpointFor(measureWidth())
  let metric = measure()
  let editing = false
  let onEditingChange: ((editing: boolean) => void) | null = null

  const settingsPop = createPopover({ className: 'ntp-pop--settings' })
  const picker = createPicker({
    hasInstance,
    onPick: (id: string) => addWidget(id)
  })

  // ── 度量 ────────────────────────────────────────────────────────────────

  /**
   * 量可用宽度。
   *
   * 看板在「空且不在自定义模式」时是 `display:none`（不占位，免得在表面上留一条空条），
   * 此时自身 `clientWidth` 恒为 0 —— 直接用它会把网格算成 1px。
   * 所以回退去量**父元素（表面）的内容盒**：看板恒为表面内容盒的 100% 宽，
   * 这个数无论看板自身可不可见都是对的。
   */
  function measureWidth() {
    const own = host.clientWidth
    if (own) return own
    const parent = host.parentElement
    if (!parent) return window.innerWidth
    const cs = getComputedStyle(parent)
    const inner = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
    return inner > 0 ? inner : window.innerWidth
  }

  function measure() {
    return grid.metrics({ width: Math.max(1, measureWidth()), cols: breakpoint(bpId).cols })
  }

  function rects() {
    return state.layouts[bpId]
  }

  // ── 布局维护 ────────────────────────────────────────────────────────────

  /**
   * 尺寸收敛到组件自己声明的 min/max 与当前列数之内；
   * **横坐标收敛到最近的对称锚点**（左 / 中 / 右，见 grid#hAnchor）——
   * 这是"绝对完美对称"的兜底：无论位置来自拖拽、按比例推导还是老数据，
   * 只要经过这里就一定落在三处对称锚点之一，绝不会停在"偏半格"的中间态。
   */
  function clampSizeFor(def: WidgetDefinition | null, r: Rect, cols: number): Rect {
    const min = (def && def.minSize) || { w: 1, h: 1 }
    const max = (def && def.maxSize) || { w: cols, h: 8 }
    const wMax = Math.min(max.w, cols)
    const w = Math.max(min.w, Math.min(Math.round(Number(r.w)), wMax))
    const h = Math.max(min.h, Math.min(Math.round(Number(r.h)), max.h))
    const x = grid.hAnchor(cols, w, r.x)
    const y = Math.max(0, Math.round(Number(r.y || 0)))
    return { x, y, w, h }
  }

  /**
   * 保证每个实例在当前断点都有一格位置。
   *
   * 两条路径，规则都收口在 grid.js，所以"对称锚点"只有一处定义：
   *   ① **已有位置**：只收敛尺寸与横坐标（吸附到最近的对称锚点）；
   *      若吸附后压到别人，就保持原样 —— 宁可不对齐，也绝不让"对齐"生出重叠。
   *   ② **缺失位置**：按另一档的**视觉顺序**（先 y 后 x）逐个推导，再用 `grid.placeDown`
   *      落位（横向三锚点 + 纵向只向下）。
   *
   * 曾经的写法是"按比例算出 x/y，然后 firstFreeSlot 从左上角找洞" ——
   * 算出来的对称位置被整块丢弃，于是窗口一窄，所有卡片都塌到最左边、搜索框也不再居中，
   * 后推导的小卡片还会钻进前面的空隙里，视觉上就是"排序混乱"。
   * 现在的推导保留投影位置与相对顺序：贴左的仍贴左、贴右的仍贴右、谁在上谁在上。
   */
  function ensureLayout() {
    const bucket = state.layouts[bpId]
    const cols = breakpoint(bpId).cols
    const sibId = siblingBreakpoint(bpId)
    const sib = state.layouts[sibId]
    const sibCols = breakpoint(sibId).cols
    let changed = false

    // ① 已有位置：收敛（不制造重叠）
    for (const inst of state.instances) {
      const cur = bucket[inst.i]
      if (!cur) continue
      const fixed = clampSizeFor(getWidget(inst.widget), cur, cols)
      if (sameRect(fixed, cur)) continue
      if (grid.collides(bucket, inst.i, fixed)) continue
      bucket[inst.i] = fixed
      changed = true
    }

    // ② 缺失位置：先算出投影，再按源布局的视觉顺序逐个落位
    const seeds: Array<{ inst: WidgetInstance; rect: Rect; derived: boolean }> = []
    for (const inst of state.instances) {
      if (bucket[inst.i]) continue
      const def = getWidget(inst.widget)
      const base = sib[inst.i]
      const rect = base
        ? clampSizeFor(
            def,
            {
              // x/w 都按列数等比投影；x 刻意不先取整 —— 交给 clampSizeFor 吸附到最近锚点，
              // 正中可能是 .5 格，提前 round 会把"精确居中"挪掉半格（见 grid#hAnchors）。
              x: (base.x * cols) / sibCols,
              y: base.y,
              w: (base.w * cols) / sibCols,
              h: base.h
            },
            cols
          )
        : clampSizeFor(def, { x: 0, y: 0, ...((def && def.defaultSize) || { w: 4, h: 2 }) }, cols)
      seeds.push({ inst, rect, derived: !!base })
    }
    // 先 y 后 x：推导顺序 = 源布局的阅读顺序，目标档的上下/左右关系因此不会乱。
    seeds.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    // floorY：后推导卡片的顶边不得高于先推导卡片 —— 保证目标档里的上下顺序
    // 与源布局完全一致（同一行左右并排的卡片仍可落在同一个 floorY 上）。
    let floorY = 0
    for (const { inst, rect, derived } of seeds) {
      if (derived) {
        const placed = grid.placeDown(bucket, rect, cols, { x: rect.x, y: Math.max(rect.y, floorY) })
        bucket[inst.i] = placed
        floorY = placed.y
      } else {
        bucket[inst.i] = grid.firstFreeSlot(bucket, rect, cols)
      }
      changed = true
    }

    if (changed) push()
  }

  function push() {
    save(state)
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  /**
   * 网格矩形 → 像素落点。
   *
   * 横向三处锚点里有两处要**反推**，而不是走网格换算：
   *   · 正中（`x === (cols − w)/2`）→ `(画布宽 − 卡宽)/2`，左右留白逐像素相等；
   *   · 贴右（`x === cols − w`）   → `画布宽 − 卡宽`，右边界严格贴住画布。
   * 数学上它们与 `xAt(x)` 相等，但网格换算是浮点、再各自取整就可能差 1px ——
   * 而"对称 / 贴边"这件事上 1px 就是看得出的裂缝。只有三处锚点，判据本身极便宜。
   */
  function pxOf(r: Rect): { pxW: number; pxH: number; pxX: number; pxY: number } {
    const W = Math.round(metric.width)
    const pxW = Math.round(metric.wAt(r.w))
    const pxX =
      r.x === (metric.cols - r.w) / 2
        ? Math.round((W - pxW) / 2)
        : r.x === metric.cols - r.w
          ? W - pxW
          : Math.round(metric.xAt(r.x))
    return { pxW, pxH: Math.round(metric.hAt(r.h)), pxX, pxY: Math.round(metric.yAt(r.y)) }
  }

  /**
   * 把布局写进 DOM（只读位置表，**不改**位置 —— 拖 / 缩放过程中本体自己逐帧写像素，
   * 这里不参与，所以没有"跳过谁"这回事）。
   */
  function applyLayout() {
    const bucket = rects()
    let maxRow = 0
    for (const [i, view] of views) {
      const r = bucket[i]
      if (!r) continue
      const el = view.root
      const px = pxOf(r)
      maxRow = Math.max(maxRow, r.y + r.h)
      el.style.transform = `translate3d(${px.pxX}px, ${px.pxY}px, 0)`
      el.style.width = px.pxW + 'px'
      el.style.height = px.pxH + 'px'
      // 同时给**网格尺寸**与**像素尺寸**：
      // 组件的自适应阈值一律用像素 —— 网格的列数/行高以后再改，组件不用跟着重调。
      if (view.api && typeof view.api.resize === 'function') {
        view.api.resize({ w: r.w, h: r.h, pxW: px.pxW, pxH: px.pxH })
      }
    }
    // 内联 min-height = 内容需要的像素高度（行数 × 行步长 − 一个间隙）。
    // 它只是**下限**：看板在 CSS 里是 flex: 1，本来就会铺满可用区，
    // 组件排到画布之外时才靠这个下限继续往下撑。
    // ⚠ 两个模式必须算出同一个值（所以这里不按 editing 加行）——
    // 否则进出编辑模式看板高度变化、整块内容位移（§4.6 那条铁律）。
    const rows = maxRow
    host.style.minHeight = rows > 0 ? Math.round(rows * metric.stepY - metric.gap) + 'px' : '0px'
    host.style.setProperty('--ntp-step-x', metric.stepX + 'px')
    host.style.setProperty('--ntp-step-y', metric.stepY + 'px')
    host.dataset.editing = editing ? '1' : '0'
    // 编辑态的全部视觉都挂在 `.ntp__board[data-editing='1']`（见 newtab.css）——
    // 不往 body 上再挂一个类：那是同一份状态的第二处真源，早晚会漂。
  }

  function mount(inst: WidgetInstance): BoardView | null {
    const def = getWidget(inst.widget)
    if (!def) return null

    const root = document.createElement('section')
    root.className = 'wgt'
    root.dataset.i = inst.i
    root.dataset.widget = inst.widget
    // 形状语言**由组件自己声明**（'' = 默认圆角矩形；'capsule' = 胶囊，如搜索框）。
    // 于是"搜索框长得像搜索框"不是板层里的一个 id 判断，而是组件的一个属性。
    if (def.shape) root.dataset.shape = def.shape

    const body = document.createElement('div')
    body.className = 'wgt__body'
    root.appendChild(body)

    // 自定义模式才可见的"操作蒙层"：既提供拖拽抓手，也顺手挡住组件内部的误点
    const mask = document.createElement('div')
    mask.className = 'wgt__mask'
    const name = document.createElement('span')
    name.className = 'wgt__name'
    name.textContent = def.name
    const actions = document.createElement('div')
    actions.className = 'wgt__actions'
    // 没有可调项就不给 ⚙（点了只会看到"没有可调项"）；
    // removable:false 的常驻组件（搜索框）不给 ✕。
    const btnSettings = def.settings.length ? actionButton('settings', '设置') : null
    const btnRemove = def.removable === false ? null : actionButton('x', '移除')
    if (btnSettings) actions.appendChild(btnSettings)
    if (btnRemove) actions.appendChild(btnRemove)
    mask.append(name, actions)
    root.appendChild(mask)

    const grip = document.createElement('div')
    grip.className = 'wgt__resize'
    grip.setAttribute('aria-hidden', 'true')
    root.appendChild(grip)

    host.appendChild(root)

    const view: BoardView = { inst, def, root, body, api: null }
    views.set(inst.i, view)

    if (btnSettings) {
      btnSettings.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation()
        openSettings(view, btnSettings)
      })
    }
    if (btnRemove) {
      btnRemove.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation()
        removeInstance(inst.i)
      })
    }
    root.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.wgt__actions, .wgt__resize')) return
      beginDrag(view, e)
    })
    grip.addEventListener('pointerdown', (e: PointerEvent) => beginResize(view, e))

    mountContent(view)
    return view
  }

  /** 挂载/重挂组件内容。配置一变就整块重建 —— 组件无需自己处理"增量更新"。 */
  function mountContent(view: BoardView): void {
    if (view.api && typeof view.api.destroy === 'function') {
      try {
        view.api.destroy()
      } catch (_) {}
    }
    view.api = null
    view.body.replaceChildren()

    const rect = rects()[view.inst.i]
    const ctx = {
      root: view.body,
      config: resolveConfig(view.def, state.configs[view.inst.i]),
      setConfig: (patch: WidgetConfig) => updateConfig(view.inst.i, patch),
      instance: { ...view.inst },
      // 网格尺寸（w/h）+ 像素尺寸（pxW/pxH）。组件的自适应判断请用像素那两个 ——
      // 网格粗细（列数 / 行高）是会变的，像素阈值不会因此失效。
      size: rect
        ? {
            w: rect.w,
            h: rect.h,
            pxW: Math.round(metric.wAt(rect.w)),
            pxH: Math.round(metric.hAt(rect.h))
          }
        : { w: 0, h: 0, pxW: 0, pxH: 0 },
      isEditing: () => editing,
      openUrl
    }
    // 通用外观（底色不透明度 / 字体颜色）落在**卡片**上 —— 它属于卡片，
    // 不属于组件内容，所以在这里统一应用：组件不需要知道有这几个调节。
    // 传 def 是为了按**该组件自己的档**夹取（组件可收窄范围，见 appearance.js）。
    // 配置一变就会重挂内容（见 updateConfig），于是这条调用也顺带覆盖了改配置的路径。
    applyAppearance(view.root, ctx.config, view.def)
    const api = view.def.create(ctx)
    view.api = api || null
  }

  function unmount(i: string): void {
    const view = views.get(i)
    if (!view) return
    if (view.api && typeof view.api.destroy === 'function') {
      try {
        view.api.destroy()
      } catch (_) {}
    }
    view.root.remove()
    views.delete(i)
  }

  function renderAll() {
    // 先补齐布局再挂载：mountContent 会读当前格子尺寸（组件可能按尺寸决定初始布局）
    ensureLayout()
    const alive = new Set(state.instances.map((x) => x.i))
    for (const i of Array.from(views.keys())) if (!alive.has(i)) unmount(i)
    for (const inst of state.instances) if (!views.has(inst.i)) mount(inst)
    applyLayout()
  }

  // ── 增删改 ──────────────────────────────────────────────────────────────

  function hasInstance(widgetId: string): boolean {
    return state.instances.some((x) => x.widget === widgetId)
  }

  /** 搜索框的组件 id —— 常驻项（hidden + 不可删），必须恰好有一个。 */
  const SEARCH_WIDGET = 'search'

  /**
   * 保证有且只有一个搜索框实例。
   *
   * 搜索框从"页面里写死的一行"变成了**网格里的一个普通项** —— 于是它可以被拖动、
   * 被缩放，别的组件也就能摆到它上方。老数据（v1）里没有这一项，这里补一个：
   * 把它落在顶部正中（被占就就近找空位），**只动它自己**，绝不把用户已摆好的组件推开。
   */
  function ensureSearch() {
    const def = getWidget(SEARCH_WIDGET)
    if (!def || hasInstance(SEARCH_WIDGET)) return

    const inst = { i: newInstanceId(), widget: SEARCH_WIDGET }
    state.instances.push(inst)
    state.configs[inst.i] = resolveConfig(def, null)

    for (const id of BREAKPOINT_IDS) {
      const cols = breakpoint(id).cols
      const w = Math.min(cols, def.defaultSize.w)
      // 钉在顶部正中；万一正中已被占，就近找空位 —— **只动搜索框自己**，
      // 绝不把用户已摆好的组件往下推（见 grid.js 头部那条纪律）。
      state.layouts[id][inst.i] = grid.placeFree(
        state.layouts[id],
        { w, h: def.defaultSize.h },
        cols,
        { x: (cols - w) / 2, y: 0 }
      )
    }
    push()
  }

  function addWidget(widgetId: string): void {
    const def = getWidget(widgetId)
    if (!def) return
    if (def.unique && hasInstance(widgetId)) return

    const inst = { i: newInstanceId(), widget: widgetId }
    state.instances.push(inst)
    state.configs[inst.i] = resolveConfig(def, null)

    // 两个断点同时落位：用户在哪种窗口宽度下加，另一档也不会"凭空冒在左上角"
    for (const id of BREAKPOINT_IDS) {
      const cols = breakpoint(id).cols
      const size = clampSizeFor(
        def,
        {
          x: 0,
          y: 0,
          w: Math.max(1, Math.round((def.defaultSize.w * cols) / breakpoint(MAIN_BREAKPOINT).cols)),
          h: def.defaultSize.h
        },
        cols
      )
      state.layouts[id][inst.i] = grid.firstFreeSlot(state.layouts[id], size, cols)
    }
    push()

    const view = mount(inst)
    applyLayout()
    if (view) {
      view.root.classList.add('is-entering')
      window.setTimeout(() => view.root.classList.remove('is-entering'), 340)
    }
  }

  function removeInstance(i: string): void {
    unmount(i)
    state.instances = state.instances.filter((x) => x.i !== i)
    delete state.configs[i]
    for (const id of BREAKPOINT_IDS) delete state.layouts[id][i]
    push()
    applyLayout()
  }

  function updateConfig(i: string, patch: WidgetConfig): void {
    const cfg = state.configs[i] || (state.configs[i] = {})
    Object.assign(cfg, patch)
    push()
    const view = views.get(i)
    if (view) mountContent(view)
  }

  function openSettings(view: BoardView, anchor: HTMLElement): void {
    settingsPop.panel.replaceChildren()
    const title = document.createElement('div')
    title.className = 'ntp-pop__title'
    title.textContent = view.def.name
    settingsPop.panel.appendChild(title)
    settingsPop.panel.appendChild(
      createSettingsForm(view.def, resolveConfig(view.def, state.configs[view.inst.i]), (patch: WidgetConfig) =>
        updateConfig(view.inst.i, patch)
      )
    )
    settingsPop.open(anchor)
  }

  // ── 拖拽 ────────────────────────────────────────────────────────────────

  /**
   * 拖拽 = 「跟手」与「落点」分开走：
   *   · 本体按真实像素 1:1 位移（零滞后，拖动全程不跳格）；
   *   · **落点**每帧只算给自己听（横向吸附到最近对称锚点、纵向整数行），
   *     **不碰任何别的格子** —— 谁都不许被拖走（用户明令，见 grid.js 头部纪律）；
   *   · 松手才提交：落点被别人占着，就给自己找**最近的**空位，仍然只动自己。
   * 每一帧只写 style、不读布局，不产生 forced reflow。
   */
  function beginDrag(view: BoardView, ev: PointerEvent): void {
    if (!editing) return
    const bucket = rects()
    const startRect = bucket[view.inst.i]
    if (!startRect) return

    ev.preventDefault()
    picker.close()
    settingsPop.close()
    view.root.classList.add('is-dragging')
    try {
      view.root.setPointerCapture(ev.pointerId)
    } catch (_) {}

    const startX = ev.clientX
    const startY = ev.clientY
    const startPx = { x: metric.xAt(startRect.x), y: metric.yAt(startRect.y) }
    const cols = metric.cols
    const stepX = metric.stepX
    const stepY = metric.stepY

    let cur: Rect = { ...startRect }
    let delta: { dx: number; dy: number } | null = null
    let raf = 0

    const frame = () => {
      raf = 0
      if (!delta) return
      // ① 跟手：本体按真实像素位移（1:1，拖动过程中不吸附、不跳格）
      const px = Math.round(startPx.x + delta.dx)
      const py = Math.round(startPx.y + delta.dy)
      view.root.style.transform = `translate3d(${px}px, ${py}px, 0)`

      // ② 只更新**自己**的落点：横向 → 最近对称锚点（宽度不变，只有左/中/右三种可能），
      //    纵向 → 整数行（只夹下界不设上界，看板向下生长）。
      //    这里刻意不做任何"让位 / 上浮"—— 别的格子此刻必须纹丝不动。
      const gx = grid.hAnchor(cols, startRect.w, startRect.x + delta.dx / stepX)
      const gy = Math.max(0, Math.round(startRect.y + delta.dy / stepY))
      if (gx === cur.x && gy === cur.y) return
      cur = { ...cur, x: gx, y: gy }
    }

    const onMove = (e: PointerEvent) => {
      delta = { dx: e.clientX - startX, dy: e.clientY - startY }
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const finish = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      view.root.removeEventListener('pointermove', onMove)
      view.root.removeEventListener('pointerup', finish)
      view.root.removeEventListener('pointercancel', finish)
      try {
        view.root.releasePointerCapture(ev.pointerId)
      } catch (_) {}
      // 提交：落点若被别人占着，就给自己找最近空位（只挪自己）；本体的像素由
      // applyLayout 改回格位 → 过渡把它滑过去（归位）。
      bucket[view.inst.i] = grid.placeFree(bucket, cur, cols, cur, view.inst.i)
      view.root.classList.remove('is-dragging')
      push()
      applyLayout()
    }

    view.root.addEventListener('pointermove', onMove)
    view.root.addEventListener('pointerup', finish)
    view.root.addEventListener('pointercancel', finish)
  }

  // ── 改尺寸 ──────────────────────────────────────────────────────────────

  /**
   * 改尺寸 = 尺寸吸附到整数格（固定），**只影响自己**：
   *   · 宽高按整格走（`Math.round`），夹在组件声明的 min/max 与列数之内；
   *   · **左边界固定**（抓手在右下角，右/下边界跟着指针走），右边界不越画布 ⇒
   *     贴右的卡放大时自动向左长，保持"贴右"这一对称态；
   *   · 长进别人的地盘就**停在当前尺寸**（卡住，不推别人）——
   *     别人被拉大时自己乱跑，同样是用户明令禁止的（见 grid.js 头部纪律）；
   *   · 松手才把横坐标归到新宽度下最近的对称锚点（居中/贴边在缩放过程中不会被拽跑）。
   */
  function beginResize(view: BoardView, ev: PointerEvent): void {
    if (!editing) return
    const bucket = rects()
    const startRect = bucket[view.inst.i]
    if (!startRect) return

    ev.preventDefault()
    ev.stopPropagation()
    picker.close()
    settingsPop.close()

    const grip = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : view.root
    const def = view.def
    const cols = metric.cols
    const min = def.minSize || { w: 1, h: 1 }
    const max = def.maxSize || { w: cols, h: 8 }
    const startX = ev.clientX
    const startY = ev.clientY

    view.root.classList.add('is-resizing')
    try {
      grip.setPointerCapture(ev.pointerId)
    } catch (_) {}

    let cur: Rect = { ...startRect }
    let delta: { dx: number; dy: number } | null = null
    let raf = 0

    const frame = () => {
      raf = 0
      if (!delta) return
      // ① 吸附到整格
      const w = Math.max(min.w, Math.min(max.w, cols, Math.round(startRect.w + delta.dx / metric.stepX)))
      const h = Math.max(min.h, Math.min(max.h, Math.round(startRect.h + delta.dy / metric.stepY)))
      if (w === cur.w && h === cur.h) return
      // ② 左边界固定、右边界不越界（贴右的卡于是向左长，仍是"贴右"）
      const next = { x: Math.min(startRect.x, cols - w), y: startRect.y, w, h }
      // ③ 长进别人地盘 → 停手（冻结在这一步，绝不把别人推开）
      if (grid.collides(bucket, view.inst.i, next)) return
      cur = next
      const px = pxOf(cur)
      view.root.style.width = px.pxW + 'px'
      view.root.style.height = px.pxH + 'px'
      view.root.style.transform = `translate3d(${px.pxX}px, ${px.pxY}px, 0)`
      // 组件按新尺寸切排版（新闻卡的紧凑态等）—— 拖动中就要跟着变，别等松手
      if (view.api && typeof view.api.resize === 'function') {
        view.api.resize({ w: cur.w, h: cur.h, pxW: px.pxW, pxH: px.pxH })
      }
    }

    const onMove = (e: PointerEvent) => {
      delta = { dx: e.clientX - startX, dy: e.clientY - startY }
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const finish = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', finish)
      grip.removeEventListener('pointercancel', finish)
      try {
        grip.releasePointerCapture(ev.pointerId)
      } catch (_) {}
      const changed = cur.w !== startRect.w || cur.h !== startRect.h
      // 提交：横坐标归到**新宽度下最近的对称锚点**；万一吸附后压到别人，
      // 就保持原落点 —— 宁可不对齐，也不动别人。
      const anchored = { ...cur, x: grid.hAnchor(cols, cur.w, cur.x) }
      bucket[view.inst.i] = grid.collides(bucket, view.inst.i, anchored) ? cur : anchored
      view.root.classList.remove('is-resizing')
      push()
      // 尺寸变了才需要重挂（组件可能按尺寸换布局）
      if (changed) mountContent(view)
      applyLayout()
    }

    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', finish)
    grip.addEventListener('pointercancel', finish)
  }

  // ── 自定义模式 ──────────────────────────────────────────────────────────

  function setEditing(next: boolean): void {
    editing = !!next
    if (!editing) {
      picker.close()
      settingsPop.close()
    }
    applyLayout()
    if (typeof onEditingChange === 'function') onEditingChange(editing)
  }

  // ── 断点响应 ────────────────────────────────────────────────────────────

  // 观察**父元素（表面）**而不是看板自身：看板在空态是 display:none，
  // 自身尺寸不随窗口变化，观察它就会漏掉"窗口变宽/变窄"这件事。
  // 只对宽度变化作反应 —— 我们自己会写 minHeight，不过滤就会自激。
  let lastWidth = Math.round(measureWidth())
  const observer = new ResizeObserver(() => {
    const width = Math.round(measureWidth())
    if (width === lastWidth) return
    lastWidth = width
    bpId = breakpointFor(width)
    metric = measure()
    ensureLayout()
    applyLayout()
  })

  // ── 启动 ────────────────────────────────────────────────────────────────

  /**
   * 首次使用（从未存过任何摆放）时铺一套默认组件。
   *
   * 默认清单由**使用它的分区**给（见 sections/home.js 的 PRESETS，板层只取最后一版），
   * 板层不认识任何组件 id。
   * 只给**主断点（16 列）**写坐标，其余断点交给 ensureLayout 按比例推导 ——
   * 于是"默认摆放"只有一处真源，加断点/改列数都不用回来改这里。
   */
  function seedDefaults() {
    for (const item of defaults) {
      const def = getWidget(item.widget)
      if (!def) continue
      const inst = { i: newInstanceId(), widget: item.widget }
      state.instances.push(inst)
      state.configs[inst.i] = resolveConfig(def, null)
      state.layouts[MAIN_BREAKPOINT][inst.i] = clampSizeFor(
        def,
        item.rect,
        breakpoint(MAIN_BREAKPOINT).cols
      )
    }
    state.seeded = true
    push()
  }

  /** 当前主断点布局是否就是 `layout` 这一版预设（逐格一致、实例集合完全对应）。 */
  function matchesPreset(layout: BoardPresetItem[]): boolean {
    if (state.instances.length !== layout.length) return false
    const byWidget = new Map<string, Rect>(layout.map((it) => [it.widget, it.rect]))
    if (byWidget.size !== state.instances.length) return false
    const cols = breakpoint(MAIN_BREAKPOINT).cols
    for (const inst of state.instances) {
      const rect = byWidget.get(inst.widget)
      const cur = state.layouts[MAIN_BREAKPOINT][inst.i]
      if (!rect || !cur) return false
      if (!sameRect(cur, clampSizeFor(getWidget(inst.widget), rect, cols))) return false
    }
    return true
  }

  /**
   * 把某一版预设套到**现有实例**上。
   *
   * 只有在 upgradePreset 确认当前布局逐格命中旧默认时才会走到这里，因此可以安全地把
   * 新预设不再包含的实例一并移除：否则"默认布局从五张卡收敛为一张"时，旧卡会因为没有
   * 新矩形而原样留在原地，升级看似生效、实际上什么都没删。
   *
   * 保留下来的实例 id 与配置分毫不动，只更新矩形；非主断点统一交给 ensureLayout 重建。
   */
  function applyPreset(layout: BoardPresetItem[]): void {
    const byWidget = new Map<string, Rect>(layout.map((it) => [it.widget, it.rect]))
    const cols = breakpoint(MAIN_BREAKPOINT).cols
    const keptIds = new Set<string>()
    const keptInstances: WidgetInstance[] = []

    for (const inst of state.instances) {
      const rect = byWidget.get(inst.widget)
      if (!rect) {
        delete state.configs[inst.i]
        continue
      }
      keptIds.add(inst.i)
      keptInstances.push(inst)
      state.layouts[MAIN_BREAKPOINT][inst.i] = clampSizeFor(getWidget(inst.widget), rect, cols)
    }
    state.instances = keptInstances

    // 非主断点清空，交给 ensureLayout 按新主断点重新推导。
    for (const id of BREAKPOINT_IDS) {
      if (id !== MAIN_BREAKPOINT) {
        state.layouts[id] = {}
        continue
      }
      // 主断点也删掉被移除实例的残留矩形，避免下一次增删时读到幽灵布局。
      for (const instanceId of Object.keys(state.layouts[id])) {
        if (!keptIds.has(instanceId)) delete state.layouts[id][instanceId]
      }
    }
    push()
  }

  /**
   * 预设升级：**只认「还是当年那套没动过的默认」**。
   *
   * 逐格比对各版本老预设，命中才换；用户亲手摆过的布局一个字都不动。
   * 幂等：换完即匹配当前版，下次启动不会再触发；因此不需要往存储里加字段、
   * 也不用 bump VERSION —— 迁移的判据就是布局本身。
   */
  function upgradePreset() {
    if (!currentPreset || !state.instances.length) return
    if (matchesPreset(currentPreset.layout)) return
    const from = presets.slice(0, -1).find((p) => matchesPreset(p.layout))
    if (!from) return
    applyPreset(currentPreset.layout)
  }

  if (!state.seeded && !state.instances.length) seedDefaults()
  upgradePreset()
  ensureSearch()

  ensureLayout()
  renderAll()
  observer.observe(host.parentElement || host)

  const onUnload = () => flush(state)
  window.addEventListener('pagehide', onUnload)
  window.addEventListener('beforeunload', onUnload)

  return {
    isEditing: () => editing,
    setEditing,
    toggleEditing: () => setEditing(!editing),
    onEditingChange: (callback?: (editing: boolean) => void) => {
      onEditingChange = callback || null
    },
    addWidget,
    openPicker: (anchor: HTMLElement) => picker.toggle(anchor),
    closePickers: () => {
      picker.close()
      settingsPop.close()
    },
    hasInstance,
    count: () => views.size,
    destroy() {
      observer.disconnect()
      window.removeEventListener('pagehide', onUnload)
      window.removeEventListener('beforeunload', onUnload)
      for (const i of Array.from(views.keys())) unmount(i)
    }
  }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function actionButton(icon: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'wgt__btn'
  btn.title = title
  btn.setAttribute('aria-label', title)
  const svg = uiIconSvg(document, icon, { size: 14 })
  if (svg) {
    btn.appendChild(svg)
  } else {
    // 未知图标名不再是"悄悄变成文字" —— 那会撑破 24px 的方框，
    // 而且从界面上根本看不出这是个 bug（"设置"按钮曾这样显示成两个字）。
    console.warn(`[newtab] 未知图标名 "${icon}"，已回退为文字`)
    btn.textContent = title
  }
  return btn
}
