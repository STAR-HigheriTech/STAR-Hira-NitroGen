// @ts-check
/**
 * 拖拽落点控制器 —— 落点语义、指示线、堆叠高亮、插件抢答，全在这里。
 *
 * 为什么独立成模块：拖放是标签条里**语义最复杂**的一块（六种落点、两套高亮、
 * 与插件抢答的先后关系、左右半区判据），而它需要的输入只有两样：
 *   ① 本轮投影（判断落点是不是组内标签）；② 「松手了，落点是什么」的出口。
 * 摆进渲染循环里会让「diff 数据」和「解释鼠标位置」混在同一段代码里 ——
 * 那是两种完全不同的心智负担。
 *
 * ── 落点语义（与 Edge / Chrome 的直觉对齐，不需要用户知道修饰键）──────────
 *   · 拖到**标签组芯片**上          → 并入该组（整块高亮）
 *   · 拖到**组内标签**上            → 并入它所在的组（整块高亮）
 *   · 按住 Ctrl/Shift/Alt 拖到标签上 → 强制并入（与上面两条完全等价的一条显式入口）
 *   · 拖到**组外的散标签**上        → 组内标签拖出去 = 退出所在组
 *   · 拖到**组外的散标签**上（散标签之间）→ 插入排序（左/右半区决定前/后）
 *   · 拖到**标签条空白处**          → 退出所在组
 * 「并入」与「插入」必须高亮得明显不同：一个是整块描边，一个是细线。
 * 已在同一组内的两个标签互相拖 → 不算并入，走插入排序（用户能在组内调顺序）。
 */

import { createDragRegionSuppressor, axisAdapter, createDragHintWatch, getDragItem, hasDragItem, pickDropEffect, canDropOnItem, isPinnedItem } from '@hira-ng/ui-common'
import type { DragItem } from '@hira-ng/shared-types/src/drag-item.mjs'
import { stackIdOfTab } from './projection.js'
import type {
  DropPayload,
  DropTargetDescription,
  TabbarProjectionItem,
  UnknownRecord
} from '../types.js'

interface DropControllerContext {
  getItems?: () => TabbarProjectionItem[]
  onDragEnd?: (payload: DropPayload) => unknown
  onDragHintChange?: (active: boolean) => unknown
  onSessionEnd?: () => unknown
  claimDrop?: ((payload: UnknownRecord) => unknown) | null
  onExternalDrop?: ((item: DragItem, target: DropTargetDescription) => unknown) | null
}

interface DropHit {
  chip: HTMLElement | null
  tab: HTMLElement | null
}

/** 本组件是**横排**：落点几何与纵向列表同一份实现，只差"取哪个轴"（见 axisAdapter.ts）。 */
const geo = axisAdapter('row')

/**
 * @param {Document} doc
 * @param {HTMLElement} hostEl 落点指示线的挂载容器（#tabs，即拖拽区）
 * @param {HTMLElement} innerEl 滚动/命中容器（#tabs-inner）
 * @param {{
 *   getItems: () => TabbarProjectionItem[],
 *   onDragEnd?: (payload: DropPayload) => void,
 *   onDragHintChange?: (active: boolean) => void,
 *   claimDrop?: ((payload: UnknownRecord) => unknown) | null,
 *   onExternalDrop?: ((item: DragItem, target: DropTargetDescription) => unknown) | null
 * }} ctx
 */
export function createDropController(
  doc: Document,
  hostEl: HTMLElement,
  innerEl: HTMLElement,
  ctx: DropControllerContext = {}
) {
  const getItems = typeof ctx.getItems === 'function' ? ctx.getItems : () => []
  const onDragEnd = typeof ctx.onDragEnd === 'function' ? ctx.onDragEnd : null
  /** 拖拽期"可以拖到网页区域分屏"的能力提示开关（宿主据此显隐提示；见 index.js#setDropHint）。 */
  const onDragHintChange = typeof ctx.onDragHintChange === 'function' ? ctx.onDragHintChange : null
  /** 拖拽会话无论经 drop 还是 dragend 收尾，都要释放预览暂停态。 */
  const onSessionEnd = typeof ctx.onSessionEnd === 'function' ? ctx.onSessionEnd : null
  /** 插件**拖放目标认领器**（渲染侧插槽 `tabbar.drop-target`，MULTI），见下面 drop 的处理。 */
  const claimDrop = typeof ctx.claimDrop === 'function' ? ctx.claimDrop : null
  /**
   * **外部拖入**出口（跨视图统一协议，shared-types#drag-item）：集锦卡 / 书签 / 历史 /
   * 下载 / 画板卡片从别的面板拖到标签条上。落点语义与内置拖拽同形（tab / stack / strip），
   * 由宿主决定"开新标签"还是"并入某处"。缺省 = 标签条不接收外部内容。
   */
  const onExternalDrop = typeof ctx.onExternalDrop === 'function' ? ctx.onExternalDrop : null

  /** 当前正在被拖的标签 id；null = 没在拖。拖拽生命周期由标签行调用 begin/end 驱动。 */
  let draggedId: string | null = null
  /** 当前被高亮为「堆叠落点」的节点（同一时刻只有一个）。 */
  let stackTargetNode: HTMLElement | null = null

  /**
   * 拖拽期「窗口拖拽区中和器」（见 ui-common/dragRegion.ts）。
   *
   * 没有它，"拖过头一点"就是整场报废 —— 指针一越出标签条，底下要么是普通元素
   * （事件冒泡到标签条的**兄弟**节点上，本控制器的监听器收不到），要么干脆是
   * `-webkit-app-region: drag` 的窗口拖拽区（事件根本不进渲染进程）。而拖过头是常态。
   * 语义一条不改：落点判定仍按下面的原逻辑走，只是监听器挂 **document**、命中改看 `e.target`。
   */
  const dragRegion = createDragRegionSuppressor(doc)

  /** 标签条内可作落点的节点（芯片与标签，按排布顺序）—— 越界兜底按它们的横向总带贴边取首/末。 */
  const DROP_TARGETS = '.tab-stack-chip, .tab-item'

  /**
   * 一次拖拽会话内复用同一份 DOM 几何。
   *
   * dragover 是高频事件，而 `getBoundingClientRect()` 会强制同步布局；标签数量一多，
   * 每次事件重测全部节点就是拖拽掉帧的主因。拖拽期间标签宽度/顺序不变化，因此在
   * begin / 首次外部拖入时量一次，之后只做纯数值比较。
   */
  interface RectSnapshot { top: number; bottom: number; left: number; right: number; width: number; height: number }
  let hostRect: RectSnapshot | null = null
  let innerRect: RectSnapshot | null = null
  let innerOffsetLeft = 0
  let targetNodes: HTMLElement[] = []
  let targetRects: RectSnapshot[] = []
  let rectCache = new WeakMap<Element, RectSnapshot>()

  function snapshotRect(el: Element): RectSnapshot {
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
  }

  function resetDropGeometry(): void {
    hostRect = null
    innerRect = null
    innerOffsetLeft = 0
    targetNodes = []
    targetRects = []
    rectCache = new WeakMap()
  }

  function ensureDropGeometry(): void {
    if (hostRect && innerRect) return
    hostRect = snapshotRect(hostEl)
    innerRect = snapshotRect(innerEl)
    innerOffsetLeft = innerEl.offsetLeft
    targetNodes = Array.from(innerEl.querySelectorAll<HTMLElement>(DROP_TARGETS))
    targetRects = targetNodes.map((el) => {
      const rect = snapshotRect(el)
      rectCache.set(el, rect)
      return rect
    })
  }

  function rectOf(el: Element): RectSnapshot {
    const cached = rectCache.get(el)
    if (cached) return cached
    const rect = snapshotRect(el)
    rectCache.set(el, rect)
    return rect
  }

  // 滚动 / 窗口尺寸变化会让快照失效；只在真正发生这类变化时重测，常态拖拽仍零布局读取。
  innerEl.addEventListener('scroll', resetDropGeometry, { passive: true })
  doc.defaultView?.addEventListener('resize', resetDropGeometry, { passive: true })

  /**
   * 指针下**真正**的落点候选（事件挂在 document 上，`e.target` 就是指针下那个元素）。
   *
   * 命中不到芯片/标签时按**横向总带**贴边兜底：
   *   · 在**首个落点之左** → 首个（插到最前）；在**末个落点之右** → 末个（插到最后）；
   *   · 总带**之内**（标签之间那点缝）→ 空白处。
   *
   * 为什么必须贴边兜底：标签条本体是 `flex: 1` 铺满整行，末个标签之右留着一大片空白。
   * 向右拖过头一点点就落进那片空白 —— 判成"空白处"会**同时**让定位条消失、让排序失败，
   * 而"拖过头"恰恰是拖拽的常态（同浏览器：拖到标签条外仍按边界插入，而不是整场作废）。
   */
  function hitUnder(e: DragEvent): DropHit {
    const hit = e.target as Element | null
    if (hit && typeof hit.closest === 'function') {
      const chip = hit.closest('.tab-stack-chip')
      if (chip) return { chip: chip as HTMLElement, tab: null }
      const tab = hit.closest('.tab-item')
      if (tab && (tab as HTMLElement).dataset.tabId) return { chip: null, tab: tab as HTMLElement }
    }
    return edgeTargetByX(e.clientX)
  }

  /** 见 hitUnder：按横向总带贴边取首/末个落点，并翻译成与命中分支同形的返回值。 */
  function edgeTargetByX(x: number): DropHit {
    ensureDropGeometry()
    if (!targetNodes.length) return { chip: null, tab: null }
    // 首尾外推规则与纵向列表共用（pickEdge）—— 别再写一遍 x < first.left / x > last.right。
    const edge = geo.pickEdge(x, targetRects)
    if (edge < 0) return { chip: null, tab: null }
    const target = targetNodes[edge]
    return target.classList.contains('tab-stack-chip')
      ? { chip: target, tab: null }
      : { chip: null, tab: target.dataset.tabId ? target : null }
  }

  const indicator = doc.createElement('div')
  indicator.className = 'tab-drop-indicator'
  // 用 opacity 而不是 display 显隐：指示线出现/消失能淡入淡出（display 切换是硬切，且无法过渡）
  indicator.style.cssText = 'opacity:0;width:2px;background:var(--hira-accent,#3b82f6);position:absolute;top:0;bottom:0;z-index:var(--hira-z-elevated);pointer-events:none;transition:opacity var(--ng-anim-fast,120ms) var(--ng-anim-ease,ease);' /* 拖拽落点指示线 = elevated */

  let indicatorShown = false
  let indicatorLeft = -1

  function hideIndicator() {
    if (!indicatorShown) return
    indicatorShown = false
    indicator.style.opacity = '0'
  }

  /** 幂等显示：dragover 是高频事件，重复写同样的值会白白触发样式重算。 */
  function showIndicator(left: number) {
    if (left !== indicatorLeft) {
      indicatorLeft = left
      indicator.style.left = `${left}px`
    }
    if (!indicatorShown) {
      indicatorShown = true
      indicator.style.opacity = '1'
    }
  }

  function setStackTarget(node: HTMLElement | null) {
    if (stackTargetNode === node) return
    if (stackTargetNode) stackTargetNode.classList.remove('is-stack-target')
    stackTargetNode = node || null
    if (stackTargetNode) stackTargetNode.classList.add('is-stack-target')
  }

  /**
   * 拖拽时是否按住了「堆叠」修饰键。
   * Ctrl / Shift / Alt 任一即可 —— 用户不必记住具体是哪一个，
   * 三个键在这里都没有别的含义（不会与系统或浏览器的拖放语义冲突）。
   */
  function stackModifierHeld(e: DragEvent) {
    return !!(e && (e.ctrlKey || e.shiftKey || e.altKey))
  }

  /** 落点是否在目标标签行的**右半区**（内置插入排序的实际判据，抽出来给插件复用）。 */
  function dropIsAfter(e: DragEvent, tabEl: HTMLElement) {
    // 中点判定只此一份实现（横竖共用，见 ui-common#axisAdapter）。
    return geo.isAfter(e.clientX, rectOf(tabEl))
  }

  /**
   * 把一次原生 drop 事件翻译成给插件的**纯数据落点描述**。
   *
   * 只暴露可序列化的窄字段（不把 DOM 节点、事件对象递出去）：插件的第一诉求是
   * 「落在谁身上」，而不是「自己再解析一遍 DOM」—— 后者会让每个插件都去依赖
   * 宿主此刻的类名与层级，那是宿主随时可以改的内部细节。
   *
   * 三种落点：`tab`（某个标签行，带它自己的 stackId）/ `stack`（某个组芯片）/ `strip`（空白处）。
   */
  function describeDropTarget(
    e: DragEvent,
    stackTargetEl: HTMLElement | null,
    tabEl: HTMLElement | null
  ): DropTargetDescription {
    const items = getItems()
    if (stackTargetEl) {
      return { kind: 'stack', stackId: stackTargetEl.dataset.stackId || null }
    }
    if (tabEl && tabEl.dataset.tabId) {
      const tabId = String(tabEl.dataset.tabId)
      return {
        kind: 'tab',
        tabId,
        stackId: stackIdOfTab(items, tabId),
        // 左/右半区：与内置的「插入排序」判据一致，插件要复刻这个手势时不必自己量。
        insertAfter: dropIsAfter(e, tabEl)
      }
    }
    return { kind: 'strip' }
  }

  // ── 外部拖入：只认「落在标签条自己身上」的落点 ─────────────────────────────
  // 三条监听挂在 document 上（与内置拖拽同一份，见 dragRegion 的说明），因此外部分支
  // 必须先自己判范围：否则把一个便签从集锦拖到集锦自己身上，也会被标签条当成
  // "要开新标签"。范围 = #tabs 的视口矩形（含内边距，不含分屏提示那句浮字）。
  function isOverStrip(e: DragEvent) {
    ensureDropGeometry()
    const rect = hostRect!
    return e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom
  }

  /** 标签条对**外部内容**是否值得亮起：至少有一个接收方（宿主出口或插件抢答）。 */
  function acceptsExternal(dt: DataTransfer | null) {
    return !!(claimDrop || onExternalDrop) && hasDragItem(dt)
  }

  // ── dragover：显示插入位置 / 高亮「并入」落点 ─────────────────────────────
  // 挂在 document 上（不是 innerEl）：指针越出标签条后事件冒泡到的是 innerEl 的
  // **兄弟**节点，挂 innerEl 收不到 —— 那正是"拖过头一点点就失效"的成因（见 dragRegion.ts）。
  doc.addEventListener('dragenter', (e: DragEvent) => {
    if (!draggedId) {
      if (acceptsExternal(e.dataTransfer) && isOverStrip(e)) {
        e.preventDefault()
      }
      return
    }
    ensureDropGeometry()
    e.preventDefault()
  })

  doc.addEventListener('dragover', (e: DragEvent) => {
    if (!draggedId) {
      // 外部拖入：允许落下 + 复刻同一套插入线（用户看到的落位与内置拖拽一致）。
      // 不在条上就顺手收线 —— 外部拖拽没有 dragend 兜底，指针移进页面内容时
      // dragleave 的 relatedTarget 非空，不在这里收就会留下一条幽灵插入线。
      const dt = e.dataTransfer
      if (!dt || !acceptsExternal(dt) || !isOverStrip(e)) {
        hideIndicator()
        return
      }
      e.preventDefault()
      dt.dropEffect = pickDropEffect(dt, 'copy')
      const { tab: target } = hitUnder(e)
      // dataset.tabId 为空 = 正在播关闭动效的节点（身份标识已摘）→ 不作为落点。
      if (!target || !target.dataset.tabId) {
        hideIndicator()
        return
      }
      const rect = rectOf(target)
      const insertAfter = geo.isAfter(e.clientX, rect)
      const left = geo.indicatorOffset(rect, innerRect!, insertAfter) + innerOffsetLeft
      showIndicator(left)
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const { chip: chipTarget, tab: target } = hitUnder(e)
    if (chipTarget) {
      // 种类裁决（唯一真源 tab-policy）：固定文件夹 ↔ 普通标签组不能互收。
      // 不亮整块高亮 —— 与落库同一份策略，避免"高亮得很积极，松手却什么都不发生"。
      const stackId = chipTarget.dataset.stackId
      if (!stackId || !canDropOnItem(getItems(), draggedId, stackId)) {
        setStackTarget(null)
        hideIndicator()
        return
      }
      hideIndicator()
      setStackTarget(chipTarget)
      return
    }
    // dataset.tabId 为空 = 正在播关闭动效的节点（身份标识已摘）→ 不作为落点
    if (!target || !target.dataset.tabId || target.dataset.tabId === draggedId) {
      setStackTarget(null)
      hideIndicator()
      return
    }
    const items = getItems()
    // 同上：固定标签与普通标签之间不能混排 / 混组 → 落点不亮。
    if (!canDropOnItem(items, draggedId, target.dataset.tabId)) {
      setStackTarget(null)
      hideIndicator()
      return
    }
    const draggedStackId = stackIdOfTab(items, draggedId)
    const targetStackId = stackIdOfTab(items, target.dataset.tabId)
    const joinIntent = stackModifierHeld(e) || (targetStackId != null && targetStackId !== draggedStackId)
    if (joinIntent) {
      hideIndicator()
      setStackTarget(target)
      return
    }
    setStackTarget(null)
    const rect = rectOf(target)
    // 中点判定与指示线贴边都走**轴向适配器**（横竖共用一份几何，见 ui-common#axisAdapter）。
    const insertAfter = geo.isAfter(e.clientX, rect)
    // 指示线挂在 hostEl（拖拽区）上、而坐标以 innerEl 为参照，两者相差
    // `innerEl.offsetLeft`（= 拖拽区的左内边距）—— 不补这一项，线会整体偏移十几像素。
    const left = geo.indicatorOffset(rect, innerRect!, insertAfter) + innerOffsetLeft
    showIndicator(left)
  })

  /**
   * 外部拖入离开标签条 → 收起插入线。
   * 内置拖拽的收尾仍由 dragend / drop 负责；`e.relatedTarget` 有值时说明只是
   * 在文档内部换了目标（例如从标签行移到空白），不要误收指示线。
   */
  doc.addEventListener('dragleave', (e: DragEvent) => {
    if (draggedId || e.relatedTarget) return
    hideIndicator()
    resetDropGeometry()
  })

  // 外部拖拽可能在不经过本视图 drop/dragleave 的情况下结束；下一次 begin/dragenter
  // 会重新测量，但这里顺手清掉可避免把旧几何当成新会话的真相。
  doc.addEventListener('dragend', () => {
    if (onSessionEnd) onSessionEnd()
    if (!draggedId) resetDropGeometry()
  })

  // ── drop：把落点解释成五条通道之一，交给宿主落库 ───────────────────────────
  doc.addEventListener('drop', (e: DragEvent) => {
    if (!draggedId) {
      // 外部拖入：与内置拖拽共用同一套落点描述（tab / stack / strip）+ 插件抢答。
      const dt = e.dataTransfer
      if (!dt || !acceptsExternal(dt) || !isOverStrip(e)) return
      e.preventDefault()
      hideIndicator()
      setStackTarget(null)
      const item = getDragItem(dt) as DragItem | null
      if (!item || typeof item !== 'object') return
      const { chip: chipTarget, tab: hitTab } = hitUnder(e)
      const target = describeDropTarget(e, chipTarget, hitTab)
      if (claimDrop && claimDrop({ draggedId: null, item, target })) return
      if (onExternalDrop) onExternalDrop(item, target)
      resetDropGeometry()
      return
    }
    e.preventDefault()
    if (onSessionEnd) onSessionEnd()
    // 立刻收尾：落库会触发重渲染，源节点可能因此被移出 DOM，那之后 `dragend`
    // 就未必还会冒泡到标签行上 —— 中和类留在根元素上会让整窗再也拖不动。
    dragRegion.disarm()
    hideIndicator()
    setStackTarget(null)
    const items = getItems()
    const { chip: chipTarget, tab: hitTab } = hitUnder(e)
    const target = chipTarget ? null : hitTab
    const draggedStackId = stackIdOfTab(items, draggedId)

    // 插件拖放目标（`tabbar.drop-target`）：先给插件一次**认领**的机会。
    // 语义是「抢答」而不是「再叠一层」：返回真值 = 这次拖放归它，宿主的内置语义
    // （插入排序 / 与右侧堆叠 / 并入标签组）不再执行。若只是「额外也通知一声」，
    // 插件就永远无法覆盖任何行为 —— 那这个插槽等于只能做副作用。
    if (claimDrop && claimDrop({ draggedId, target: describeDropTarget(e, chipTarget, target) })) return

    if (chipTarget) {
      const stackId = chipTarget.dataset.stackId || ''
      // 已经在这个组里 → 无操作（避免白跑一次 IPC 换来一次全量重渲染）；
      // 跨种类（固定文件夹 ↔ 普通标签组）同样不做 —— 与 dragover 的高亮判据同一份策略。
      if (stackId && stackId !== draggedStackId && onDragEnd && canDropOnItem(items, draggedId, stackId)) {
        onDragEnd({ draggedId, targetStackId: stackId, targetStackPinned: isPinnedItem(items, stackId) })
      }
      return
    }

    // 落到**自己身上** = 无操作。必须与「空白处」分开判：拖拽源节点仍留在流里
    // （只是透明度降低），原地松手时 e.target 就是它自己 —— 混在一起会把「原地
    // 轻轻拖一下再松手」误判成「拖出组」，组内标签莫名被踢出去。
    if (target && target.dataset.tabId === draggedId) return

    if (!target) {
      // 落到标签条**空白处** = 退出标签组（最自然的「拖出去」手势：把它拖离那一条下划线）。
      // 没有组就不做任何事 —— 空白处不是「移到末尾」的落点，别顺手改顺序。
      if (draggedStackId && onDragEnd) onDragEnd({ draggedId, leaveStack: true })
      return
    }

    const targetTabId = String(target.dataset.tabId)
    // 跨种类（固定 ↔ 普通）→ 拖过去什么都不发生（落库侧还有同一道闸）。
    if (!canDropOnItem(items, draggedId, targetTabId)) return
    const targetStackId = stackIdOfTab(items, targetTabId)
    const forced = stackModifierHeld(e)

    // 组内标签拖到**组外的散标签**上 = 拖出这个组：落点在那条组下划线之外，
    // 与「拖到空白处」是同一个意图（Chrome 里把标签拖到组容器外就是这个效果）。
    // 带上落点与左右半区 —— 指示线已经按同一判据画出来了，出组后就落在那一侧，
    // 不然「线画在右边、标签却停在原处」是 UI 在说谎。
    // 按住修饰键则相反 —— 那是显式的「并入」，把落点并进被拖的那个组。
    if (!forced && targetStackId == null && draggedStackId) {
      if (onDragEnd) {
        onDragEnd({ draggedId, targetId: targetTabId, insertAfter: dropIsAfter(e, target), leaveStack: true })
      }
      return
    }

    const joinIntent = forced || (targetStackId != null && targetStackId !== draggedStackId)
    if (joinIntent) {
      // 与目标标签堆叠成组（不复用「插入排序」那条通道：一个是「放到它旁边」，
      // 一个是「和它合成一组」，语义完全不同）。
      // 传**投影项**而不是裸 id：它带着目标标签自己的 stackId，调用方据此决定
      // 是「并入它所在的组」还是「新建一个组」，不必再异步查一遍标签列表。
      // draggedStackId 一并带上：两边都还没组时新建组，被拖的已在组里时把落点并进去
      //（复用原组的 name/accent，而不是新起一个空组把原组拆散）。
      if (onDragEnd) {
        const item = items.find((it) => it && String(it.tabId) === targetTabId) || { tabId: targetTabId }
        onDragEnd({ draggedId, stackWithItem: item, draggedStackId })
      }
      return
    }

    if (onDragEnd) {
      onDragEnd({ draggedId, targetId: target.dataset.tabId, insertAfter: dropIsAfter(e, target) })
    }
  })

  /**
   * 拖拽期的能力提示观察器（与纵向列表**共用同一份**，见 ui-common/tab/gestures.ts）。
   * 只在拖拽进行时 arm、结束立刻 disarm —— 常态下零监听器、零开销。
   */
  const hintWatch = createDragHintWatch(doc, (active: boolean) => {
    if (onDragHintChange) onDragHintChange(active)
  })

  return {
    /** 落点指示线（由装配层挂到 hostEl 上 —— 顺序与拆分前一致：注册监听之后）。 */
    element: indicator,

    /** 拖拽开始（标签行的 dragstart 调用）。 */
    begin(tabId: string) {
      draggedId = tabId
      resetDropGeometry()
      ensureDropGeometry()
      dragRegion.arm()
      hintWatch.arm()
    },
    /** 拖拽结束（dragend / 收尾都调用）——把指示线与高亮一并复位。 */
    end() {
      draggedId = null
      hideIndicator()
      setStackTarget(null)
      dragRegion.disarm()
      hintWatch.disarm()
      resetDropGeometry()
    }
  }
}
