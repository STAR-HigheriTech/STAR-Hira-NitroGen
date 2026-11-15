// @ts-check
/**
 * 标签行的开合动效 + 重排滑动让位 —— **只管动，不管数据**。
 *
 * 为什么独立成模块：这几件事（入场关键帧、两阶段删除、FLIP 记录与播放）都依赖
 * 「元素的当前宽度 / 上一帧位置」这类**时序细节**，和标签数据完全无关。混在渲染
 * 循环里，读代码的人会以为它们参与了 diff；事实上它们只在 DOM 已经改完之后被调用。
 *
 * 学 Hira 的动效语言：短促、只动真正该动的东西。Hira 的做法是全局
 * `* { transition: 200ms }` 让所有状态变化自己滑过去，再在少数关键处 `transition: none`
 * 退出。标签的开合**没法**靠过渡实现（新节点是凭空出现的，没有「上一个宽度」可插值），
 * 所以这两条必须自己驱动：
 *   · 打开 —— 节点入 DOM 后挂 is-tab-entering，从 0 宽展开（关键帧见 styles.js）
 *   · 关闭 —— 先塌宽淡出，过渡结束才摘除（两阶段删除）
 * 两者都靠**逐帧重排**带动邻居：塌宽/展开期间布局每帧重算，于是「关掉一个、后面的
 * 滑过来」是连续的，而不是 remove() 之后啪地瞬移。
 */

import { onTransitionEndOnce, capturePositions, playSlide } from '@hira-ng/ui-common'
import type { PlaySlideOptions, SlideAxis } from '@hira-ng/ui-common/src/flip'

/** 关闭动效的最长等待：过渡被中断（窗口隐藏、元素已被移除）时兜底摘除，避免节点永留 DOM */
export const ANIM_FALLBACK_MS = 400

/**
 * @returns {{
 *   skipClosing: (node: Node|null) => Node|null,
 *   enterNew: (nodes: HTMLElement[]) => void,
 *   exit: (el: HTMLElement) => void,
 *   capture: (nodes: HTMLElement[], axis: SlideAxis) => Map<HTMLElement, number>,
 *   slide: (before: ReadonlyMap<HTMLElement, number>, axis: SlideAxis, opts?: PlaySlideOptions) => void
 * }}
 */
export function createTabAnimator() : {
  skipClosing: (node: Node|null) => Node|null,
  enterNew: (nodes: HTMLElement[]) => void,
  exit: (el: HTMLElement) => void,
  capture: (nodes: HTMLElement[], axis: SlideAxis) => Map<HTMLElement, number>,
  slide: (before: ReadonlyMap<HTMLElement, number>, axis: SlideAxis, opts?: PlaySlideOptions) => void
} {
  /** 首次填充（启动恢复标签）不播打开动效 —— 一次冒出十几个标签一起展开太吵 */
  let firstRenderDone = false

  /**
   * 本任务里有没有已经强制过一次布局（见 runExit 里的说明）。
   *
   * 为什么要有它：`void el.offsetWidth` 是**强制同步布局** —— 一次几十微秒到一毫秒。
   * 批量关闭（「关闭其它标签」/ 拖出一整段分屏）时，旧实现是**每条标签各来一次**，
   * 于是一次用户操作里塞进 N 次布局结算，正是"批量操作会卡一下"的来源。
   * 同一次 render() 里所有标签的样式写入都发生在同一个任务里，**一次结算就够**：
   * 结算之后每条标签的"当前宽度"都已经是写入后的真实值，过渡起点各自正确。
   */
  let layoutFlushed = false

  /** 强制一次布局（同任务内之后的调用直接返回）。 */
  function flushLayoutOnce(el: HTMLElement) {
    if (layoutFlushed) return
    layoutFlushed = true
    void el.offsetWidth
    // 微任务点复位：下一次 render()（新任务）重新允许一次结算。
    // 用微任务而不是 rAF —— 复位必须发生在**下一次用户操作之前**，而不是等到下一帧。
    queueMicrotask(() => { layoutFlushed = false })
  }

  /** 跳过正在播关闭动效的节点（它们不再是布局锚点） */
  function skipClosing(node: Node | null): Node | null {
    let n = node
    while (n && n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains('is-tab-closing')) {
      n = n.nextSibling
    }
    return n
  }

  function runEnter(el: HTMLElement) {
    if (!el || el.classList.contains('is-tab-closing')) return
    el.classList.add('is-tab-entering')
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      // 动画正常结束时把兜底定时器撤掉：否则每个新标签都会在 400ms 后白跑一次回调
      // （批量恢复/批量打开时就是几十个无意义的定时器）。
      if (timer) { clearTimeout(timer); timer = undefined }
      el.removeEventListener('animationend', done)
      el.classList.remove('is-tab-entering')
    }
    el.addEventListener('animationend', done, { once: true })
    timer = setTimeout(done, ANIM_FALLBACK_MS)
  }

  function runExit(el: HTMLElement) {
    if (!el || !el.isConnected) return
    // 已经在消失中的（同一帧被删两次）不重播
    if (el.classList.contains('is-tab-closing')) return
    el.classList.add('is-tab-closing')
    el.setAttribute('aria-hidden', 'true')
    // 摘掉身份标识：正在消失的节点不再参与任何选择器/命中判定（同 id 的标签可能马上被恢复）
    el.removeAttribute('data-tab-id')
    el.draggable = false
    if (el.classList.contains('is-tab-entering')) el.classList.remove('is-tab-entering')
    /**
     * 清掉**取色写入的行内样式**（见 ui-common#paintFaviconColor）。
     *
     * 行内样式压过样式表：不清的话，关闭态那条 `background: transparent` 对
     * **选中 / 带 favicon 色**的标签是无效的 —— 它会以整块彩色底、连同文字色一起
     * 缩没，看着像"一块色块被抽走"，而不是标签淡出。媒体标签同样是常态选中 +
     * 可能带取色，这一条与 min-width 那条一起构成"特殊状态标签关闭不顺"的两个成因。
     */
    el.classList.remove('has-favicon-color')
    el.style.removeProperty('--favicon-tab-color')
    el.style.background = ''
    el.style.color = ''
    el.style.borderColor = ''
    // 宽度过渡需要一次 reflow 才能以「当前宽度」为起点（否则样式变更会被合并成一步）。
    // ⚠ **每任务最多一次**（见 layoutFlushed 的说明）：批量关闭 N 个不再 N 次强制布局。
    flushLayoutOnce(el)
    const done = () => { if (el.isConnected) el.remove() }
    // 必须等 **width** 过渡真正结束才移除节点。
    // ⚠ 不能写成 `(e) => { if (e.propertyName !== 'width') return; done() }, { once: true }`：
    // `{ once: true }` 只认第一个 transitionend，而本元素的 opacity(120ms) 一定先于
    // width(180ms) 结束 —— 监听器会被 opacity 吃掉，width 结束时回调已不存在，
    // 只剩 400ms 兜底才删节点。用户看到的就是「塌宽动画播完了，却卡一下空隙才补上」。
    onTransitionEndOnce(el, 'width', done, ANIM_FALLBACK_MS)
  }

  return {
    skipClosing,
    /**
     * 给本轮**新建**的节点播入场动效。
     * 首次填充整批跳过（见 firstRenderDone 的说明）—— 由本函数统一判定，
     * 调用方不必自己记「这是不是第一帧」。
     */
    enterNew(nodes: HTMLElement[]) {
      if (!nodes || !nodes.length) return
      const wasFirst = firstRenderDone
      firstRenderDone = true
      if (wasFirst) for (const n of nodes) runEnter(n)
    },
    exit: runExit,
    capture: capturePositions,
    slide: playSlide
  }
}

export { capturePositions, playSlide, onTransitionEndOnce }
