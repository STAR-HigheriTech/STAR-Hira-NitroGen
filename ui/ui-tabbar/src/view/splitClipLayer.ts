// @ts-check
/**
 * 分屏回形针图层 —— 「回形针画在**两条相邻标签之间那道缝的正中**」。
 *
 * ── 为什么必须是一层（而不是挂在某个标签里）─────────────────────────────
 * 「两个标签之间」意味着要**跨在边界上**（左右各半）。而 `.tab-item` 带
 * `overflow: hidden` —— 关闭时要把宽度塌到 0，不裁住内容就会露出 favicon 与关闭按钮。
 * 因此标签内部**画不出**任何越过自身边界的东西：第一版把回形针塞进前一个标签的右内边距，
 * 视觉上就成了"挂在第一个标签的末尾"（用户原话：**不是在某个标签的末尾，而是在两个标签之间**）。
 *
 * 绘制层是唯一能做到"真的在两者之间"的位置：它挂在滚动容器 `#tabs-inner` 里，
 * 不属于任何标签，因此可以居中跨在缝上，也不参与 flex 排版。
 * 同款做法本项目已有先例（标签组下划线层 `stackLineLayer.js`）。
 *
 * ── 几何 ────────────────────────────────────────────────────────────
 *   · 「缝」= 前一条标签的右缘 → 后一条的左缘（标签条有 `gap: --ng-tab-gap-x`，通常 2px）；
 *   · 回形针中心 = 缝的中点；垂直居中于标签；
 *   · 只量**真实矩形**（getBoundingClientRect）而不是 offset*：标签开合 / 拖拽让位 /
 *     选中态换宽（140↔160）全都是 180ms 的逐帧动画，offset* 是"布局最终值"，
 *     量完就定死的话回形针会停在旧位置上（与下划线层同一条教训）。
 *
 * ── 谁决定"画在哪一对之间" ──────────────────────────────────────────
 * 共用件 `ui-common#splitLinkPairs`（读主进程算好的 `splitLinkAfter`）。
 * 本层**不认识**分屏业务，只回答"给我投影，我把标记摆到正确的缝上"。
 */

import { createFramePump, splitLinkPairs } from '@hira-ng/ui-common'
import type { TabbarProjection, TabbarProjectionItem } from '../types.js'

interface SplitClipLayerContext {
  getNode?: (key: string) => HTMLElement | null
  keyOf?: (item: TabbarProjectionItem) => string
  createClip?: () => HTMLElement | null
  pump?: ReturnType<typeof createFramePump>
}

interface SplitClipPlan {
  targets: Array<{ key: string; left: number; centerY: number }>
  alive: Set<string>
}

/** 让位/开合动效的跟踪窗口（与下划线层同量级；动效结束后自动停表）。 */
const TRACK_MS = 300

/**
 * @param {Document} doc
 * @param {HTMLElement} innerEl 滚动容器（`#tabs-inner`），绘制层挂在它里面
 * @param {{
 *   getNode: (key: string) => HTMLElement|null,
 *   keyOf: (item: TabbarProjectionItem) => string,
 *   createClip: () => HTMLElement,
 *   pump?: ReturnType<typeof createFramePump>
 * }} ctx
 *   `getNode`/`keyOf` 是渲染引擎交给本层的**唯一两条缝** —— 层不认识 nodeRecords、
 *   也不认识投影的形状（key 怎么拼由渲染引擎说了算）。
 *   `createClip` 由宿主注入（共用件 `createSplitClip`）—— ui-tabbar 不重复实现外观。
 *   `pump` 由宿主注入（与下划线层**共用**一条 rAF，一帧只结算一次布局）；缺省自建。
 */
export function createSplitClipLayer(doc: Document, innerEl: HTMLElement, ctx: SplitClipLayerContext = {}) {
  const getNode: (key: string) => HTMLElement | null = typeof ctx.getNode === 'function' ? ctx.getNode : () => null
  const keyOf: (item: TabbarProjectionItem) => string = typeof ctx.keyOf === 'function' ? ctx.keyOf : () => ''
  const createClip: () => HTMLElement | null = typeof ctx.createClip === 'function' ? ctx.createClip : () => null
  const ownsPump = !ctx.pump
  const pump = ctx.pump || createFramePump(doc.defaultView, {
    durationMs: TRACK_MS,
    alive: () => innerEl.isConnected
  })

  const layer = doc.createElement('div')
  layer.className = 'tab-split-clips'

  /** @type {Map<string, HTMLElement>} 「这一对的**前一条**的 key」→ 缝上那枚回形针 */
  const clipByKey: Map<string, HTMLElement> = new Map()

  /** 最近一次投影的取数器（`track` 登记，帧泵每帧重新取）。 */
  let readItems: (() => TabbarProjectionItem[]) | null = null
  /** measure 相的产物；paint 相消费。 */
  let pending: SplitClipPlan | null = null

  /**
   * 本层是否有活要干：现存标记（可能正在消失、需要逐帧收尾）或本次投影里还有配对。
   * `layout` 与 `track` 共用这一条口径 —— 闸门只写一次，避免两处规则漂移。
   * @param {readonly TabbarProjectionItem[]} items
   */
  function hasWork(items: readonly TabbarProjectionItem[]): boolean {
    if (clipByKey.size > 0) return true
    return splitLinkPairs(items, keyOf).length > 0
  }

  /**
   * 读相：量出每对「缝」的坐标（纯只读，一次布局结算量完）。
   * @param {TabbarProjection} list 本次投影
   * @returns {SplitClipPlan|null} null = 本帧无事
   */
  function measurePlan(list: TabbarProjection): SplitClipPlan | null {
    // 还没挂到窗口上（首次渲染早于挂载）→ 量到的矩形全是 0，画出来只会错位。
    if (!innerEl.isConnected) return null
    const items = (Array.isArray(list) ? list : []).filter(
      (item): item is TabbarProjectionItem => item != null
    )
    // 早退：本来就一对都没有、且之前也没画过 → 一个 DOM 动作都不做。
    if (!hasWork(items)) return null
    const pairs = splitLinkPairs(items, keyOf)

    // 先**只读**（一次布局结算把几何量完），再统一写 —— 读写交错会逐条触发强制重排。
    const layerRect = layer.getBoundingClientRect()
    const targets: Array<{ key: string; left: number; centerY: number }> = []
    for (const pair of pairs) {
      const before = getNode(pair.beforeKey)
      const after = getNode(pair.afterKey)
      if (!before || !after || !before.isConnected || !after.isConnected) continue
      // 正在播关闭动效的节点宽度已塌到 0，拿它算缝会让回形针跑到左边去 —— 跳过这一对，
      // 等它真的消失后投影里也不会再有这一对（`_markSplitLinks` 是主进程按当前成员算的）。
      if (before.classList.contains('is-tab-closing') || after.classList.contains('is-tab-closing')) continue
      const beforeRect = before.getBoundingClientRect()
      const afterRect = after.getBoundingClientRect()
      // 缝的中点：前一条的右缘与后一条的左缘之间（gap 有几个像素就取几个像素的中点）。
      const center = (beforeRect.right + afterRect.left) / 2
      targets.push({
        key: pair.beforeKey,
        // 坐标是相对绘制层的；层本身在滚动容器里、随内容一起滚，所以相减即得内容坐标
        //（不必再加 scrollLeft —— 与下划线层同一条口径）。
        left: center - layerRect.left,
        centerY: (Math.min(beforeRect.top, afterRect.top) + Math.max(beforeRect.bottom, afterRect.bottom)) / 2 - layerRect.top
      })
    }

    const alive = new Set<string>()
    for (const t of targets) alive.add(t.key)
    return { targets, alive }
  }

  /**
   * 写相：把 measurePlan 的产物落到 DOM 上（一帧里所有读都已完成，这里不再摸布局）。
   * @param {SplitClipPlan|null} plan
   */
  function applyPlan(plan: SplitClipPlan | null): void {
    if (!plan) return
    for (const t of plan.targets) {
      let el = clipByKey.get(t.key)
      if (!el) {
        const created = createClip()
        if (!created) continue
        el = created
        clipByKey.set(t.key, el)
        layer.appendChild(el)
      }
      // 居中跨在缝上：`translate(-50%, -50%)`（用 transform 而不是 margin，因为回形针的
      // 尺寸是共用件说了算，这里不该写死 6px 的负边距）。
      el.style.transform = 'translate(-50%, -50%)'
      el.style.left = `${t.left}px`
      el.style.top = `${t.centerY}px`
    }

    // 这一对不在了（解散分屏 / 关掉一个 / 中间被插了别的标签）→ 标记跟着消失
    for (const [key, el] of clipByKey) {
      if (plan.alive.has(key)) continue
      el.remove()
      clipByKey.delete(key)
    }
  }

  /**
   * 动效期间**逐帧**重画，直到布局重新静止。
   * 与下划线层同一条理由：开合 / 让位是 180ms 动画，只量一次会让标记停在旧位置。
   * 有界（窗口期一过即停），且全程零分屏时 layout 直接早退。
   * @param {() => TabbarProjectionItem[]} getItems
   */
  function track(getItems: () => TabbarProjectionItem[]) {
    // 先记住取数器：即便这一轮没有活，容器尺寸变化（RO）或过渡事件仍然要靠它重算。
    if (typeof getItems === 'function') readItems = getItems
    // 闸门（与 measurePlan 同一条口径）：零配对、现存也无标记 → 本层无事可做，**不续帧**。
    if (!hasWork(typeof getItems === 'function' ? getItems() : [])) return
    pump.ping(TRACK_MS)
  }

  /** 一帧的读相（由帧泵调度，与同容器的其它绘制层合并成一次布局结算）。 */
  function measure() {
    if (!readItems) return
    pending = measurePlan(readItems())
  }

  /** 一帧的写相。 */
  function paint() {
    if (!pending) return
    const plan = pending
    pending = null
    applyPlan(plan)
  }

  const unregister = pump.register({ measure, paint })

  return {
    /** 绘制层本体（渲染层负责把它挂成 `#tabs-inner` 的子节点）。 */
    element: layer,
    /** 立即摆位（渲染完一轮的同步首绘；随后的动效窗口交给帧泵逐帧跟）。 */
    layout(list: TabbarProjection) {
      applyPlan(measurePlan(list))
    },
    track,
    dispose() {
      unregister()
      pending = null
      readItems = null
      if (ownsPump) pump.dispose()
      clipByKey.clear()
      layer.remove()
    }
  }
}
