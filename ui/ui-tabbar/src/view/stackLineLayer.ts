// @ts-check
/**
 * 标签组下划线图层 —— 「每个标签组一条完整下划线，从芯片左端连到最后一个成员右端」。
 *
 * 为什么独立成模块：它是一个**自成一体的绘制层**（自己的 DOM 层、自己的几何算法、
 * 自己的逐帧跟踪循环、自己的增删生命周期），与标签数据、与渲染 diff 都没有关系 ——
 * 它只需要两样东西：① 本轮投影；② 「按 key 拿节点」的能力。摆在渲染循环里
 * （曾经那样）会让 renderTabs 多出 90 行几何代码，且读的人分不清哪段在 diff、哪段在测量。
 *
 * 视觉口径（与 styles.js 的 .tab-stack-lines / .tab-stack-line 一对）：
 *   · 绘制层是 #tabs-inner 的**最后一个子节点**，于是线压在标签底色之上；
 *   · 线画在「标签正下方那条凹槽」里（#tabs 的 align-self: stretch 腾出来的）；
 *   · 位置取**真实矩形**（getBoundingClientRect），不是 offset*——见下面 layout 的说明。
 *
 * ⚠ 这条凹槽以前还要与分屏「连接带」并排（两条线上下叠在同一段凹槽里）。合体标签
 *   （分屏两半拼成一条）之后，横向不再有任何连接带 —— 整段凹槽归本层所有。
 */

import { createFramePump } from '@hira-ng/ui-common'
import type { TabbarProjection, TabbarProjectionItem } from '../types.js'

interface StackLineLayerContext {
  getNode?: (key: string) => HTMLElement | null
  pump?: ReturnType<typeof createFramePump>
}

interface StackLineTarget {
  stackId: string
  accent?: string
  left: number
  width: number
  bottom: number
  height: number
}

interface StackLinePlan {
  targets: StackLineTarget[]
  alive: Set<string>
}

interface StackLineGroup {
  stackId: string
  accent: string
  first: HTMLElement | null
  last: HTMLElement | null
}

const LINES_TRACK_MS = 260

/**
 * @param {Document} doc
 * @param {HTMLElement} innerEl 滚动容器（#tabs-inner），绘制层挂在它里面
 * @param {{
 *   getNode: (key: string) => HTMLElement|null,
 *   pump?: ReturnType<typeof createFramePump>
 * }} ctx
 *   `getNode` 由渲染层提供 —— 图层**不认识** nodeRecords，只知道「给我 key、给我节点」。
 *   这是本模块与渲染引擎之间唯一的一条缝，因此两边可以各自替换。
 *   `pump` 由宿主注入（同一容器上的所有绘制层共用一条 rAF）；缺省自建 ——
 *   单独使用本层（例如被别的宿主复用时）也能自洽工作。
 */
export function createStackLineLayer(doc: Document, innerEl: HTMLElement, ctx: StackLineLayerContext = {}) {
  const getNode: (key: string) => HTMLElement | null = typeof ctx.getNode === 'function' ? ctx.getNode : () => null
  const ownsPump = !ctx.pump
  const pump = ctx.pump || createFramePump(doc.defaultView, {
    durationMs: LINES_TRACK_MS,
    alive: () => innerEl.isConnected
  })

  const layer = doc.createElement('div')
  layer.className = 'tab-stack-lines'

  /** @type {Map<string, HTMLElement>} stackId → 该组唯一的那条下划线 */
  const lineByStack: Map<string, HTMLElement> = new Map()

  /** 最近一次投影的取数器（`track` 登记，帧泵每帧重新取 —— 跟踪期间投影可能又变了）。 */
  let readItems: (() => TabbarProjectionItem[]) | null = null
  /** measure 相的产物；paint 相消费。null = 本帧无事可做。 */
  let pending: StackLinePlan | null = null

  /**
   * 本层是否有活要干：现存线（可能正在消失，需要逐帧收尾）或本次投影里有标签组。
   * `layout` 与 `track` 共用这一条口径 —— 闸门只写一次，避免两处规则漂移。
   * @param {readonly TabbarProjectionItem[]} items
   */
  function hasWork(items: TabbarProjection): boolean {
    if (lineByStack.size > 0) return true
    for (const it of items) {
      if (it && it.type === 'stack') return true
    }
    return false
  }

  /**
   * 重画所有组下划线。
   *
   * 投影里「组芯片 + 紧跟其后的同组成员」一定是连续的（domain-tabs 的 projectTabStacks），
   * 所以顺着投影扫一遍就能切出每个组当前占了哪一段。
   *
   * ⚠ 只量**节点当前的真实矩形**，而不是 offsetLeft/offsetWidth：
   *   offset* 是「布局最终值」，而标签的开合/让位是**逐帧在动的**。收起一个组时，被收起的
   *   成员要播 180ms 的塌宽动画，它们的宽度是逐帧收掉的 —— 此刻用 offset* 量到的右端
   *   还在「没收完」的老位置上。量完就定死的话，等它们塌完标签往左滑走，线却停在旧长度
   *   （看起来就是「都收起了线还那么长、甚至越过组」）。真实矩形每帧都在跟着走，所以
   *   这条线由 layout + track 在动效期间**逐帧**重画。
   *
   * 收起态的组投影里也会留下「活动成员」（否则地址栏会空白）；若该组没有活动成员，
   * 投影里就只剩一枚芯片 —— 此时没有线可画（first === last）。
   *
   * @param {TabbarProjection} list 本次投影
   * @returns {StackLinePlan|null} 纯只读产物；null = 本帧无事
   */
  function measurePlan(list: TabbarProjection): StackLinePlan | null {
    // 还没挂到窗口上（首次渲染早于挂载）→ 这时量到的矩形全是 0，画出来只会是一条
    // 错位的线；直接不画，等挂载后的下一次渲染再补上。
    if (!innerEl.isConnected) return null
    const items = Array.isArray(list) ? list : []
    // 早退：整窗没有标签组、且现存也没有线时（绝大多数情况）一个 DOM 动作都不做。
    if (!hasWork(items)) return null

    // 先**只读**（一次布局结算就把所有组的几何量完），再统一写。
    // 读-写交错会让每次 style 写入都作废下一次读，逐组触发一次强制重排。
    const layerRect = layer.getBoundingClientRect()
    // 切出「芯片 + 它的成员」：first 恒为芯片，last 是该组最后一个成员
    const groups: StackLineGroup[] = []
    let cur: StackLineGroup | null = null
    for (const item of items) {
      if (!item) continue
      if (item.type === 'stack') {
        cur = {
          stackId: String(item.stackId),
          accent: item.accent || '',
          first: getNode(`stack:${item.stackId}`),
          last: null
        }
        groups.push(cur)
        continue
      }
      if (cur && item.stackId != null && String(item.stackId) === cur.stackId) {
        const node = getNode(`tab:${item.tabId}`)
        if (node && node.isConnected) cur.last = node
        continue
      }
      cur = null
    }

    // 横向滚动条占在标签条底部那几像素上（标签多到溢出时才出现）。它是**覆盖**在
    // 凹槽上的独立层，下划线必须让开它 —— 既不能钻到它底下，也不能因此压回标签上。
    const scrollbarH = Math.max(0, innerEl.offsetHeight - innerEl.clientHeight)

    const alive = new Set<string>()
    const targets: StackLineTarget[] = []
    for (const g of groups) {
      if (!g.first || !g.last || !g.first.isConnected || !g.last.isConnected) continue
      alive.add(g.stackId)
      const firstRect = g.first.getBoundingClientRect()
      const lastRect = g.last.getBoundingClientRect()
      // 左端 = 芯片左缘；右端 = 最后一个成员右缘（都用当前真实矩形）。
      // 线的坐标是相对绘制层的，而绘制层本身就在滚动容器里、会随内容一起滚，
      // 所以两者相减就是内容坐标 —— 不需要再加 scrollLeft。
      //
      // 凹槽 = 标签下沿 → 标签条底部（再扣掉滚动条那几像素）。
      // 高度按它收窄：凹槽够 3px 就是 3px；标签高度以后被调大、或出现滚动条时，
      // 线只会变细，绝不会压到标签上（宁可细一点，也不叠）。
      const slack = Math.round(layerRect.bottom - scrollbarH - lastRect.bottom)
      targets.push({
        stackId: g.stackId,
        accent: g.accent,
        left: firstRect.left - layerRect.left,
        width: Math.max(0, lastRect.right - firstRect.left),
        bottom: scrollbarH,
        height: Math.max(1, Math.min(3, Number.isFinite(slack) ? slack : 3))
      })
    }

    return { targets, alive }
  }

  /**
   * 写相：把 measurePlan 的产物落到 DOM 上（一帧里所有读都已完成，这里不再摸布局）。
   * @param {StackLinePlan|null} plan
   */
  function applyPlan(plan: StackLinePlan | null): void {
    if (!plan) return
    for (const t of plan.targets) {
      let el = lineByStack.get(t.stackId)
      if (!el) {
        el = doc.createElement('div')
        el.className = 'tab-stack-line'
        lineByStack.set(t.stackId, el)
        layer.appendChild(el)
      }
      // 组的颜色必须写在线上：线不是芯片的子节点，拿不到芯片上的 --tab-stack-accent
      if (t.accent) el.style.setProperty('--tab-stack-accent', t.accent)
      else el.style.removeProperty('--tab-stack-accent')
      el.style.left = `${t.left}px`
      el.style.width = `${t.width}px`
      el.style.bottom = `${t.bottom}px`
      el.style.height = `${t.height}px`
    }

    // 组没了 / 成员全关了 → 线也跟着消失（按 stackId，不会误删别的组）
    for (const [stackId, el] of lineByStack) {
      if (!plan.alive.has(stackId)) {
        el.remove()
        lineByStack.delete(stackId)
      }
    }
  }

  /**
   * 动效期间**逐帧**重画下划线，直到布局重新静止。
   *
   * 为什么必须有这一段：标签的开合/让位是 180ms 的动画，布局在这段时间里逐帧在变。
   * 只在渲染时量一次的话，收起组时量到的还是「成员没收完」的旧位置 —— 等动画播完
   * 标签滑走了，线却停在旧长度上。与其去猜「动画结束后该多长」，不如在动的这段时间里
   * 老老实实每帧跟着真实矩形走：起点、过程、终点全对，而且开合 / 拖拽让位 /
   * 活动标签换宽（140↔160）全都一套覆盖。
   *
   * 有界：窗口期一过就停（不是常驻 rAF）；整窗没有标签组时 layout 直接早退，
   * 所以对绝大多数窗口这份开销为零。
   *
   * @param {() => TabbarProjectionItem[]} getItems 取「当前投影」——跟踪期间投影又变了，
   *   所以每次 tick 都重新取，而不是把某一帧的列表钉死。
   */
  function track(getItems: () => TabbarProjectionItem[]) {
    // 先记住取数器：即便这一轮没有活，容器尺寸变化（RO）或过渡事件仍然要靠它重算。
    if (typeof getItems === 'function') readItems = getItems
    // 闸门（与 layout 同一条口径）：整窗零标签组、现存也无线 → 本层无事可做，
    // **根本不续帧**。否则页面加载期每个 tab:changed 都会把窗口续期 260ms，
    // 而每帧 measure 又立刻早退 —— 三条绘制层一起白跑整个加载期。
    if (!hasWork(typeof getItems === 'function' ? getItems() : [])) return
    pump.ping(LINES_TRACK_MS)
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
    /** 绘制层本体（渲染层负责把它挂成 #tabs-inner 的最后一个子节点）。 */
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
      lineByStack.clear()
      layer.remove()
    }
  }
}
