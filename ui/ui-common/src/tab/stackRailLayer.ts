/**
 * 标签组「连线条」绘制层（纵向列表）—— 「一组一条连续竖线，画在行的外侧」。
 *
 * 为什么独立成模块：它是一个**自成一体的绘制层**（自己的 DOM 层、自己的几何、
 * 自己的有界逐帧跟踪、自己的增删生命周期），与标签数据、与渲染 diff 都没有关系。
 * 它只需要两样东西：① 本轮投影；② 「按 key 拿行节点」的能力。
 *
 * 视觉口径（与 tabRowList 的 .tabrow-stack-rails / .tabrow-stack-rail 一对；
 * 对齐 Edge 的垂直标签组）：
 *   · 组内成员行（连同展开时的**组行**）统一向右让出一条 8px 的槽（宿主的
 *     data-stack-indent），线画在这条槽里 —— 因此它永远在标签**外面**，不压任何底色
 *     / favicon 指示线；组行也不再有自己的那条短色条（那会和这条线分成两截）。
 *   · 线的 x 按「内容左缘 + 2px」算（读 wrap 的实测左内边距再垫）—— 侧栏的 wrap 有
 *     6px 内边距、面板没有，宿主各写死一组数必然漂移，这里让几何自己跟着走。
 *   · 一组**只有一条**线：从组行顶端一直连到最后一个成员的下沿（不是逐行各画一段），
 *     两端收圆（border-radius: 999px）—— 组项与它的标签是同一根"脊"。
 *   · 槽在行的左侧，与面板挂左 / 挂右无关 —— 不再需要任何换边镜像。
 *
 * ⚠ 旧实现是「每一行自己的 ::before 各画一段」并贴到面板最外缘：行与行之间靠
 *   上下各多伸 2px 硬接，且行带 contain: paint，向行外绘制全靠偏移量凑 —— 视觉上
 *   又远又断续（用户明确否掉）。一条独立线 + 真实矩形，任何时刻都不会断。
 */

import { createFramePump } from './framePump'
import type { FramePump } from './framePump'

export interface StackRailItem {
  type?: string
  tabId?: string | number | null
  stackId?: string | number | null
  accent?: string | null
  [key: string]: unknown
}

export interface StackRailLayerContext {
  getNode?: (key: string) => HTMLElement | null
  keyOf?: (item: StackRailItem) => string
  pump?: FramePump
}

export interface StackRailLayerController {
  element: HTMLDivElement
  layout: (items: readonly StackRailItem[]) => void
  track: (getItems: () => readonly StackRailItem[]) => void
  invalidateMetrics: () => void
  dispose: () => void
}

interface RailMetrics {
  padLeft: number
  inset: number
  frame: number
}

interface StackGroupMeasure {
  stackId: string
  accent: string
  headTop: number | null
  top: number
  bottom: number
  has: boolean
}

interface StackRailTarget {
  stackId: string
  accent: string
  top: number
  height: number
}

interface StackRailPlan {
  targets: StackRailTarget[]
  alive: Set<string>
  x: number
}

const RAILS_TRACK_MS = 260
/** 线在组头下沿 / 末行下沿各多伸出一点，把行间那 1px 缝顶掉，视觉上才"接住"。 */
const RAIL_OVERHANG = 3
/** 线离**内容左缘**的距离（槽内留白）—— 样式表没给 --tabrow-rail-inset 时的兜底。 */
const RAIL_INSET_FALLBACK = 2

/**
 * @param {Document} doc
 * @param {HTMLElement} wrapEl 滚动内容容器（.tabrow-wrap），绘制层挂在它里面
 * @param {{
 *   getNode: (key: string) => HTMLElement|null,
 *   keyOf?: (item: StackRailItem) => string,
 *   pump?: ReturnType<typeof createFramePump>
 * }} ctx
 *   `getNode` / `keyOf` 由列表提供 —— 图层**不认识** rowRecords，只知道
 *   「给我 key、给我节点」。这是本模块与渲染循环之间唯一的一条缝。
 *   `pump` 由宿主注入（同容器上的所有绘制层共用一条 rAF）；缺省自建。
 */
export function createStackRailLayer(
  doc: Document,
  wrapEl: HTMLElement,
  ctx: StackRailLayerContext = {}
): StackRailLayerController {
  const getNode = typeof ctx.getNode === 'function' ? ctx.getNode : () => null
  const keyOf = typeof ctx.keyOf === 'function' ? ctx.keyOf : defaultKeyOf
  const ownsPump = !ctx.pump
  const pump = ctx.pump || createFramePump(doc.defaultView, {
    durationMs: RAILS_TRACK_MS,
    alive: () => wrapEl.isConnected
  })

  const layer = doc.createElement('div')
  layer.className = 'tabrow-stack-rails'

  /** @type {Map<string, HTMLElement>} stackId → 该组唯一的那条连线条 */
  const railByStack: Map<string, HTMLElement> = new Map<string, HTMLDivElement>()

  /** 最近一次投影的取数器（`track` 登记，帧泵每帧重新取）。 */
  let readItems: (() => readonly StackRailItem[]) | null = null
  /** measure 相的产物；paint 相消费。 */
  let pending: StackRailPlan | null = null

  /** 上一次算出的线 x（px）；-1 = 还没量过。 */
  let railX = -1
  /** `readRailMetrics()` 的缓存 —— `getComputedStyle` 会强制样式结算，不能每帧读。 */
  let metrics: RailMetrics | null = null

  /**
   * 一次读齐这层需要的几何口径：wrap 的左内边距 + 样式表里的「指示条槽」变量。
   *
   * 三个值来自同一处（.tabrow-wrap），与行内 favicon 色条读写的是**同一组变量** ——
   * 于是"标签自己的色条"与"组的连线条"不可能各偏几像素（这条对齐曾是肉眼可见的偏差）。
   * `frame` 补的是行自己的透明占位边框：色条是行内绝对定位，坐标基准是 padding box，
   * 边框那 1px 落在它外面。
   *
   * ⚠ 结果缓存：本方法内部是 `getComputedStyle`，每帧调用会让样式结算永不空闲。
   *   容器尺寸 / 主题变量变化时由宿主调用 `invalidateMetrics()` 作废。
   */
  function readRailMetrics(): RailMetrics {
    const view = doc.defaultView
    if (!view || typeof view.getComputedStyle !== 'function') {
      return { padLeft: 0, inset: RAIL_INSET_FALLBACK, frame: 1 }
    }
    const cs = view.getComputedStyle(wrapEl)
    const pxVar = (name: string, fallback: number): number => {
      const n = parseFloat(cs.getPropertyValue(name))
      return Number.isFinite(n) ? Math.round(n) : fallback
    }
    return {
      padLeft: Math.round(parseFloat(cs.paddingLeft) || 0),
      inset: pxVar('--tabrow-rail-inset', RAIL_INSET_FALLBACK),
      frame: pxVar('--tabrow-rail-frame', 1)
    }
  }

  function railMetrics(): RailMetrics {
    if (!metrics) metrics = readRailMetrics()
    return metrics
  }

  /**
   * 丢弃几何口径缓存（容器尺寸 / 主题变量变了）。下一次 measure 重新读一次。
   * 宿主（tabRowList）在 ResizeObserver / 主题切换时调用。
   */
  function invalidateMetrics() {
    metrics = null
    railX = -1
  }


  /**
   * 本层是否有活要干：现存线（可能正在消失，需要收尾）或本次投影里有标签组。
   * `layout` 与 `track` 共用这一条口径，避免两处规则漂移。
   * @param {readonly StackRailItem[]} items
   */
  function hasWork(items: readonly StackRailItem[]): boolean {
    if (railByStack.size > 0) return true
    for (const it of items) {
      if (it && it.type === 'stack') return true
    }
    return false
  }

  /**
   * 重画所有组的连线条。
   *
   * 投影里「组行 + 紧跟其后的同组成员」一定是连续的（domain-tabs 的 projectTabStacks），
   * 顺着扫一遍就能切出每个组当前占了哪一段。组内成员可能被收进分屏合体容器
   * （.tabrow-pair），但合体成员是并排的、上下沿完全一致 —— 所以按成员行自己的
   * 真实矩形取 top/bottom 仍然正确，不需要认识合体容器。
   *
   * 只量**当前真实矩形**（不是 offset*）：开合 / 重排让位是 180ms 逐帧动画，
   * offset* 给的是「最终值」，动画期间会立刻错位。动的那段时间交给 track 逐帧重画。
   *
   * 高度为 0 的行（刚建出来 / 正在塌陷）不计入，否则线会被一瞬间拉到 0。
   *
   * @param {readonly StackRailItem[]|null|undefined} list 本次投影
   * @returns {StackRailPlan|null} null = 本帧无事
   */
  function measurePlan(list: readonly StackRailItem[] | null | undefined): StackRailPlan | null {
    // 还没挂到窗口上（首次渲染早于挂载）→ 量到的矩形全是 0，画出来只会错位。
    if (!wrapEl.isConnected) return null
    const items = Array.isArray(list) ? list : []
    if (!hasWork(items)) return null

    // 先**只读**（一次布局结算量完所有行），再统一写。
    const layerRect = layer.getBoundingClientRect()
    // 本层的定位基准是 wrap 的**内边距盒**，而正常行是从内容左缘排起的。垂直侧栏给
    // wrap 加了左右内边距（面板没有）—— 不垫上它，线就会落到行的内边距里、与成员行
    // 隔出两倍距离（同一份缩进，侧栏看着"过头"、面板正好）。按实测值垫一次；
    // inset 与 frame 与行内 favicon 色条同源，两条竖线因此落在**同一条 x** 上。
    const m = railMetrics()
    const x = m.padLeft + m.inset + m.frame
    /**
     * @type {{ stackId: string, accent: string, headTop: number|null, top: number, bottom: number, has: boolean }[]}
     */
    const groups: StackGroupMeasure[] = []
    let cur: StackGroupMeasure | null = null
    for (const item of items) {
      if (!item) continue
      if (item.type === 'stack') {
        cur = {
          stackId: String(item.stackId),
          accent: item.accent || '',
          // 组行自己也是这条线要连住的一段：线从**组行顶端**起，一路连到末成员下沿。
          // 组行收起 / 刚建 / 塌陷中量不到高度 → 退回用首成员顶端（宁可短一点，不要错位）。
          headTop: null,
          top: 0,
          bottom: 0,
          has: false
        }
        const headNode = getNode(keyOf(item))
        if (headNode && headNode.isConnected) {
          const hr = headNode.getBoundingClientRect()
          if (hr.height > 0) cur.headTop = hr.top
        }
        groups.push(cur)
        continue
      }
      // 非组项：只有紧跟组行、且属于该组的成员才续上这一组；否则视作组已结束。
      const sid = item.stackId != null ? String(item.stackId) : ''
      if (!cur || !sid || sid !== cur.stackId) {
        cur = null
        continue
      }
      const node = getNode(keyOf(item))
      if (!node || !node.isConnected) continue
      const rect = node.getBoundingClientRect()
      if (!(rect.height > 0)) continue
      if (!cur.has) {
        cur.top = rect.top
        cur.has = true
      }
      cur.bottom = rect.bottom
    }

    const alive = new Set<string>()
    const targets: StackRailTarget[] = []
    for (const g of groups) {
      // 收起态的组只有组行、没有可见成员 → 没有线可画（与 Edge 一致）
      if (!g.has) continue
      alive.add(g.stackId)
      const start = g.headTop != null ? Math.min(g.headTop, g.top) : g.top
      targets.push({
        stackId: g.stackId,
        accent: g.accent,
        top: start - layerRect.top - RAIL_OVERHANG,
        height: Math.max(1, g.bottom - start + RAIL_OVERHANG * 2)
      })
    }

    return { targets, alive, x }
  }

  /**
   * 写相：把 measurePlan 的产物落到 DOM 上（一帧里所有读都已完成，这里不再摸布局）。
   * @param {StackRailPlan|null} plan
   */
  function applyPlan(plan: StackRailPlan | null): void {
    if (!plan) return

    // 线 x 只在真的变了时才写（属性变更会触发整层重绘）。
    if (plan.x !== railX) {
      railX = plan.x
      layer.style.setProperty('--tabrow-stack-rail-x', `${plan.x}px`)
    }

    for (const t of plan.targets) {
      let el = railByStack.get(t.stackId)
      if (!el) {
        el = doc.createElement('div')
        el.className = 'tabrow-stack-rail'
        railByStack.set(t.stackId, el)
        layer.appendChild(el)
      }
      // 组的颜色必须写在线上：线不是组行的子节点，拿不到组行上的 --tab-stack-accent
      if (t.accent) el.style.setProperty('--tab-stack-accent', t.accent)
      else el.style.removeProperty('--tab-stack-accent')
      el.style.top = `${Math.round(t.top)}px`
      el.style.height = `${Math.round(t.height)}px`
    }

    // 组没了 / 成员全关 / 组被收起 → 线跟着消失（按 stackId，不会误删别的组）
    for (const [stackId, el] of railByStack) {
      if (!plan.alive.has(stackId)) {
        el.remove()
        railByStack.delete(stackId)
      }
    }
  }

  /**
   * 动效期间**逐帧**重画，直到布局重新静止。
   *
   * 行高开合 / 拖拽让位 / 分屏合体就位都是 180ms 动画，布局在这段时间里逐帧在变。
   * 只在渲染时量一次的话，收起组时量到的还是「成员没收完」的旧位置。与其去猜
   * 终点，不如在动的这段时间里老实跟着真实矩形走 —— 起点、过程、终点全对。
   *
   * 有界：窗口期一过就停（不是常驻 rAF）；整窗没有标签组时本层直接早退，
   * 因此对绝大多数窗口这份开销为零。
   *
   * @param {() => readonly StackRailItem[]} getItems 取「当前投影」（跟踪期间投影可能又变了）
   */
  function track(getItems: () => readonly StackRailItem[]): void {
    // 先记住取数器：即便这一轮没有活，容器尺寸变化（RO）或过渡事件仍然要靠它重算。
    if (typeof getItems === 'function') readItems = getItems
    if (!hasWork(typeof getItems === 'function' ? getItems() : [])) return
    pump.ping(RAILS_TRACK_MS)
  }

  /** 一帧的读相（由帧泵调度，与同容器的其它绘制层合并成一次布局结算）。 */
  function measure(): void {
    if (!readItems) return
    pending = measurePlan(readItems())
  }

  /** 一帧的写相。 */
  function paint(): void {
    if (!pending) return
    const plan = pending
    pending = null
    applyPlan(plan)
  }

  const unregister = pump.register({ measure, paint })

  return {
    /** 绘制层本体（列表负责把它挂进 wrap）。 */
    element: layer,
    /** 立即摆位（渲染完一轮的同步首绘；随后的动效窗口交给帧泵逐帧跟）。 */
    layout(list: readonly StackRailItem[]) {
      applyPlan(measurePlan(list))
    },
    track,
    /** 容器尺寸 / 主题变量变了 → 作废几何口径缓存（帧泵随后重算）。 */
    invalidateMetrics,
    dispose() {
      unregister()
      pending = null
      readItems = null
      if (ownsPump) pump.dispose()
      railByStack.clear()
      layer.remove()
    }
  }
}

/**
 * 投影项 → keyed 复用键（与 tabRowList 的 rowKey、横向 recKeyOf 同一套键空间）。
 * @param {StackRailItem} item
 * @returns {string}
 */
function defaultKeyOf(item: StackRailItem): string {
  if (!item) return ''
  return item.type === 'stack' ? `stack:${item.stackId}` : `tab:${item.tabId}`
}
