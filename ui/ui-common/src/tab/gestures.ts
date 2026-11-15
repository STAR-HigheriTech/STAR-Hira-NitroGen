/**
 * 标签行的**手势** —— 单击切换、双击关闭、中键关闭。
 *
 * 为什么单独成模块：这三条手势共享一份**跨 DOM 重建的时序状态**（「上一次点击
 * 距今多久」），而这份状态必须放在**模块级**：
 *
 *   两次 click 之间主进程会广播 tabs:changed，触发渲染引擎重建 / 复用整棵标签 DOM；
 *   闭包里的计时状态会随之丢失。放在模块级，跨 DOM 重建依然有效 ——
 *   这正是「双击关闭」在标签栏频繁重渲染下仍能成立的原因。
 *
 * 把它与「造行结构」放在一起时，这条约束极容易被顺手改成闭包变量（看起来更干净），
 * 于是双击就悄悄坏了。单独成文件 + 文件头写明原因，是让它活下来的方式。
 *
 * **两种模式共用这一份**：横向标签条用 `attachTabGestures()` 一次挂齐三条手势；
 * 纵向列表的行把点击委托在列表容器上（行节点不挂监听），于是它只用下面的
 * `noteTabPrimaryClick()` / `isFastDoubleClick()` 这两个**判据** ——
 * 但"够不够快"的计时状态仍然只有这一份（此前两处各抄一遍 250ms 与两个变量）。
 */

// 中键自动滚动的判据/处理只有一份（见该文件头：一条规则、两种挂载粒度）。
import { suppressMiddleClickAutoscroll } from '../middleClickGuard'

export interface TabGestureHandlers {
  onSelect?: () => void
  onClose?: () => void
  onAltSelect?: () => void
}

export interface DragHintWatch {
  arm: () => void
  disarm: () => void
}

/**
 * 双击关闭的判定间隔（毫秒）。比浏览器系统默认（Windows GetDoubleClickTime ~500ms）
 * 更严：两次点击必须足够快（≤250ms）才算「双击关闭」，慢一点就退化成两次普通单击，
 * 防误触关错标签。
 */
export const DOUBLE_CLICK_MAX_INTERVAL_MS = 250

let lastClickAt = 0
let lastClickGap = Infinity

/**
 * 记录一次**主键单击**（模块级状态，见文件头）。
 * 两种模式的行在 click 时都必须调它一次 —— 它是「够不够快」这一判据的唯一计时来源。
 */
export function noteTabPrimaryClick() {
  const t = Date.now()
  lastClickGap = t - lastClickAt
  lastClickAt = t
}

/**
 * 这次双击**够不够快**？
 * 只有上两次点击的间隔 ≤ DOUBLE_CLICK_MAX_INTERVAL_MS 才算有效双击；
 * 慢双击当作两次普通单击（防误触关错标签）。
 */
export function isFastDoubleClick() {
  return lastClickGap <= DOUBLE_CLICK_MAX_INTERVAL_MS
}

/**
 * 这次点击是不是**分屏修饰键 + 点击**？
 *
 * 「分屏」在这两个模式里必须是**同一个修饰键**，所以判据只有这一份 ——
 * 横向标签条（`attachTabGestures`）与纵向列表（`tabRowList` 的委托点击）都调它。
 * 各写一遍的结局必然是"横向能用、纵向不能"（先例：关闭右侧标签曾经只在一个入口有）。
 *
 * 选 Alt/Option：与 Firefox / Zen 的「Alt+点击标签 = 与当前标签分屏」逐字一致，
 * 用户从那边过来不需要重新学。Ctrl 已被多选占用、Shift 已被范围选择占用。
 *
 * @param {{ altKey?: boolean }} e
 */
export function isSplitModifier(e?: { altKey?: boolean } | null): boolean {
  return !!(e && e.altKey)
}

/**
 * 拖拽期"指针是否还在本视口里"的观察器 —— 驱动"可拖到网页区域分屏"的能力提示。
 *
 * **横向标签条与纵向列表共用这一份**（一次拖拽一个观察器）：各写一遍必然变成
 * "一边有提示、一边没有"，而提示措辞又必须两边一致。
 *
 * 判据：`dragleave` 在整个文档树里都会触发，只有 **`relatedTarget` 为 null** 才是
 * 真正"离开了文档"（指针移到了某块网页原生视图上，或移到了别的窗口）；
 * 文档上任何一次 `dragover` 都表示"又回到外壳里了"。
 *
 * ⚠ 只在拖拽期间 `arm()`、结束立刻 `disarm()` —— 标签条/列表都是最热路径，
 * 常态下必须零监听器零开销。
 *
 * @param {Document} doc
 * @param {(active: boolean) => void} onChange
 * @returns {{ arm: () => void, disarm: () => void }}
 */
export function createDragHintWatch(
  doc: Document,
  onChange: (active: boolean) => void
): DragHintWatch {
  let active = false
  let onLeave: ((event: DragEvent) => void) | null = null
  let onOver: (() => void) | null = null
  const emit = (next: boolean) => {
    if (active === next) return
    active = next
    if (typeof onChange === 'function') onChange(next)
  }
  return {
    arm() {
      if (onLeave) return
      onLeave = (e) => { if (!e.relatedTarget) emit(true) }
      onOver = () => emit(false)
      doc.addEventListener('dragleave', onLeave, true)
      doc.addEventListener('dragover', onOver, true)
    },
    disarm() {
      if (onLeave) doc.removeEventListener('dragleave', onLeave, true)
      if (onOver) doc.removeEventListener('dragover', onOver, true)
      onLeave = null
      onOver = null
      emit(false)
    }
  }
}

/**
 * 从 DOM 读"当前活动标签"。
 *
 * 用在**拖拽开始的那一刻、且必须在切换之前**调用：拖拽会先把当前标签切到被拖的那个
 * （Edge / Chrome 同口径），一旦切完再问就只剩被拖的那个了，而"拖动前正在看的那一格"
 * 正是分屏落点要配对的对象。
 *
 * ⚠ 刻意读 DOM 而不是读宿主的 `activeTabId`：宿主的那个值在 `tab:changed` 回推后才更新，
 * 依赖"此刻还没更新"是一种隐式时序耦合；DOM 上的 `.active` 类才是用户此刻看到的事实。
 * ⚠ 只服务**横向标签条**（`.tab-item.active`）：纵向列表各宿主用 `.tabrow-row--active`，
 * 在自己的 dragstart 里就地读（各宿主最清楚自己的标记，硬凑一个通用选择器只会更脆）。
 *
 * @param {HTMLElement} row 标签行元素（用于找到所在的标签条）
 * @returns {string|null}
 */
export function currentActiveTabIdFromDom(row: HTMLElement): string | null {
  if (!row || typeof row.closest !== 'function') return null
  const strip = row.closest('[data-tab-strip]') || row.parentElement
  if (!strip) return null
  const active = strip.querySelector<HTMLElement>('.tab-item.active')
  return active && active.dataset ? active.dataset.tabId || null : null
}

/**
 * 给标签行挂上三条手势。
 *
 * @param {HTMLElement} el 标签行节点
 * @param {{ onSelect?: () => void, onClose?: () => void, onAltSelect?: () => void }} handlers
 *   **无参意图**：调用方（记录）负责补当前 tabId。
 *   `onAltSelect` = Alt/Option + 单击（与活动标签分屏）；未提供时该手势退化成普通单击。
 */
export function attachTabGestures(el: HTMLElement, handlers: TabGestureHandlers = {}): void {
  const select = () => { if (typeof handlers.onSelect === 'function') handlers.onSelect() }
  const close = () => { if (typeof handlers.onClose === 'function') handlers.onClose() }

  // 左键单击切换（click 只由主键/键盘触发，中键走 auxclick）
  // 同时记录相邻两次 click 的间隔（模块级），供 dblclick 做「够快才关闭」过滤。
  el.addEventListener('click', (e) => {
    noteTabPrimaryClick()
    // Alt/Option + 单击 = 与当前活动标签分屏（对齐 Firefox / Zen）。
    // **不切换过去**：分屏后用户仍在原标签上操作，被点的那个成为第二个格子
    // （切过去会让"当前标签"变成被点那个，分屏方向就反了）。
    if (isSplitModifier(e) && typeof handlers.onAltSelect === 'function') {
      handlers.onAltSelect()
      return
    }
    select()
  })

  // 双击关闭标签：对齐 Vivaldi/Firefox「双击标签页即关闭」的习惯，但叠加间隔过滤 ——
  // 只有两次 click 间隔 ≤ DOUBLE_CLICK_MAX_INTERVAL_MS 才算有效双击，慢双击忽略（防误触）。
  // 落在 close / audio 按钮上的双击不处理，避免与按钮自身语义打架。
  el.addEventListener('dblclick', (e) => {
    const target = e.target as Element | null
    if (target?.closest('.tab-close-button') || target?.closest('.tab-audio-button')) return
    if (!isFastDoubleClick()) return
    close()
  })

  // 中键关闭：`mousedown` 先吃掉默认行为 —— 中键在 Chromium 里会触发「自动滚动」光标，
  // 而那个光标会和关闭抢一拍（"中键关标签卡一下"）。规则只有一份（middleClickGuard），
  // 这里挂的是**行**那一层；容器根那一层由各自宿主挂（见该模块头部的两种粒度说明）。
  // auxclick 仍会正常派发，实测不受影响。
  el.addEventListener('mousedown', suppressMiddleClickAutoscroll)
  el.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    close()
  })
}
