/**
 * 窗口控制按钮（最小化 / 最大化 / 关闭）的**唯一落点判定**。
 *
 * 四个目标位，由「宿主块」与「本块住的宿主轴」共同决定（两个事实都住在
 * `row/rowForm.ts`，本模块只读：`form.wcHost` / `form.navbarInSide` / `form.slots`）：
 *   · **纵排**（本块住在侧栏 = 全功能侧栏）→ 归整列**最顶行的最前**，即
 *     侧栏左上角、空间切换器**左边**（`sideHeader` 的首子节点 —— 见 sideHeader.ts）；
 *   · 宿主是**标签栏** + 横排 → 标签行末（侧栏可见时这里是侧栏底槽，同一条分支）；
 *   · 宿主是**导航栏** + 横排 → 导航栏行末（行内由 CSS 的 order 钉在整行最右）；
 *   · 宿主是**标题栏** → 让出（见 ownsControls），本块不主张。
 *
 * 为什么纵排不再分「宿主是谁」：纵排下真正决定位置的是**整列最顶那一行**这一个空间事实 ——
 * 那一行就是 navbar 自己的标题行（`sideHeader`，空间切换器也寄住在那儿）。
 * 窗控若还按「宿主是导航栏 → 导航栏行」走，就会变成侧栏里的一整行（且与空间切换器分家）；
 * 按「一律归侧栏底行」走则落到了侧栏最下面 —— 都不是用户要的「左上角、空间切换器旁边」。
 *
 * **外观也在这里定**（place 的第一件事）：落在侧栏顶行那种"窗口左上角"的位置时用
 * macOS 红绿灯（关闭/最小化/最大化），其余宿主保持 Windows 标题栏字形。
 * 判据与落点同为 form 的事实，所以外观与位置永远对得上。
 *
 * 为什么单独成模块：按钮的宿主是可配的（标签栏 / 导航栏 / 标题栏），
 * 而「此刻该在哪」要综合三件事实。旧实现里这些判定散在构造、布局回调、侧栏切换三条路径上，
 * 各判一次的结果就是「换布局后有一条路径忘了搬，按钮凭空消失」。收到一处之后，
 * 每条路径都只是「改一个事实，然后重摆一次」（改事实见 `row/rowForm.ts`）。
 *
 * ⚠ 「按钮此刻是否归本块管」：宿主可以是第三块（标题栏）—— 那种情况下按钮是标题栏的
 *   节点，本块必须彻底放手：否则本块之后任何一次内部重摆（换布局 / 换宿主轴）都会把
 *   节点从标题栏里抢回来，表现就是「设成标题栏后又自己跑回标签栏」。
 *
 * ⚠ 落进**标签行**时，按钮会挤进那一行的既有顺序里 —— 行内顺序归 `tabRowLayout` 管。
 *   本模块通过注入的 `refreshTabRow` 请它重施一次，而不是自己去懂那一行的规矩。
 *   横排导航栏与侧栏标题行都没有这种「后挂重排」问题：前者靠 CSS 的 order（见 styles.ts
 *   的 `#navbar-toolbar:not([data-host-axis="column"]) > .navbar-top-right-actions`），
 *   后者靠「插在最前」这一个位置事实。
 */

import type { WindowControls } from '../types'
import type { RowForm } from './rowForm'

/**
 * @param {{
 *   tabRow: HTMLElement,
 *   toolbar: HTMLElement,
 *   sideHeader: HTMLElement,
 *   bottomRight: HTMLElement,
 *   windowControls: { element: HTMLElement, placeInto: (target: Node|null, at?: 'start'|'end') => void, setVariant?: (v: 'windows'|'mac') => void },
 *   refreshTabRow: () => void,
 *   form: import('./rowForm.ts').RowForm
 * }} ctx
 * @returns {{ place: () => void }}
 */
export function createWindowControlsPlacement(ctx: {
  tabRow: HTMLElement
  toolbar: HTMLElement
  sideHeader: HTMLElement
  bottomRight: HTMLElement
  windowControls: WindowControls
  refreshTabRow: () => void
  form: RowForm
}): { place: () => void } {
  const { tabRow, toolbar, sideHeader, windowControls, refreshTabRow, form } = ctx

  /**
   * 幂等：目标位没变则一次 DOM 都不动。
   */
  function place() {
    // 原生 WCO 窗口（系统在窗口右上角画按钮）没有自绘簇 —— `element` 为 null，
    // 本模块整体让位（唯一的"没有按钮"形态；其余情况下 element 恒为真实容器）。
    if (!windowControls.element) return
    // 按钮归标题栏那块时不主张（见文件头的 ⚠）：外观也一并不动，否则"被让出去的那一簇"
    // 会带着红绿灯外观进标题栏。
    const ownsControls = form.wcHost !== 'titlebar'
    // 外观变体随落点走：按钮落在**侧栏顶行**（= 窗口左上角、空间切换器左边）时用
    // macOS 红绿灯；其余宿主（标签行 / 导航栏行 / 侧栏底槽）保持 Windows 标题栏字形。
    // 判据与下面的 dest **同源**（都是 form 的事实），所以不会出现"外观与位置对不上"。
    if (typeof windowControls.setVariant === 'function') {
      windowControls.setVariant(ownsControls && form.navbarInSide ? 'mac' : 'windows')
    }
    if (!ownsControls) return
    const sideBottom = form.slots && form.slots.bottom ? form.slots.bottom : null

    let dest: { target: Node | null; at: 'start' | 'end' }
    if (form.navbarInSide) {
      // 纵排（全功能侧栏）：整列最顶行、**最前** —— 空间切换器左边（见文件头）。
      dest = { target: sideHeader, at: 'start' }
    } else if (form.wcHost === 'navbar') {
      // 横排导航栏：行内最右由 CSS 的 order 决定（见 styles.ts）。
      dest = { target: toolbar, at: 'end' }
    } else {
      dest = { target: sideBottom || tabRow, at: 'end' }
    }

    windowControls.placeInto(dest.target, dest.at)
    // 只有按钮此刻真的落在**标签行**时，才需要按横排规则重施行内顺序。
    if (windowControls.element.parentNode === tabRow) refreshTabRow()
  }

  return { place }
}

