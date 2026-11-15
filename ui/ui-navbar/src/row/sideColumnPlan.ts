/**
 * **侧栏分区计划** —— 纵排宿主里「哪些东西住哪一行」的唯一判定处。
 *
 * 它管三件（且只有三件）：
 *   · 固定「空间切换器」的落点（横排标签行首 / 垂直标签列左上角）；
 *   · 「固定 / 悬停展开」按钮（`slots.pin`）的落点 —— **永远与空间切换器同一行**，
 *     紧挨在它**后面**（用户口径：固定钮不是独立一行，就在切换器右侧紧邻）；
 *   · 「新建标签」（`#navbar-add-tab`）在**横排**下的落点（标签行末）。
 *
 * 判据只有两个事实，都住在 `row/rowForm.ts`（本模块只读，不存副本）：
 *   · `form.inSide` —— 标签栏块是否在侧栏（= 有没有借出槽位）；
 *   · `form.navbarInSide` —— 本块（navbar）自己是否也在侧栏。
 *
 * ⚠ 「新建标签」在**侧栏模式下不搬**：纵向标签列表自带常驻的「新建标签页」浮钮
 *   （ui-common 的 `.tabrow-add`，由 ui-vertical-tabs 以 `showAddButton` 打开），
 *   再把这颗搬进侧栏底槽就成了同一条侧栏里**两个新建入口**。
 *   不搬 = 它留在标签行；而侧栏模式下标签行本就不在台上，随之自然不显示。
 *
 * 本模块只搬节点，既不认识窗口控制按钮（`windowControlsPlacement` 的事），
 * 也不认识行内顺序（`tabRowLayout` 的事）。
 */

import type { RowForm } from './rowForm'

/**
 * @param {{
 *   tabRow: HTMLElement,
 *   sideHeader: HTMLElement,
 *   workspace: HTMLElement,
 *   addTabSlot: HTMLElement,
 *   dragHandle?: HTMLElement,
 *   navbarHost?: HTMLElement,
 *   form: import('./rowForm.ts').RowForm
 * }} ctx
 * @returns {{ place: () => void }}
 */
export function createSideColumnPlan(ctx: {
  tabRow: HTMLElement
  sideHeader: HTMLElement
  workspace: HTMLElement
  addTabSlot: HTMLElement
  dragHandle?: HTMLElement
  navbarHost?: HTMLElement
  form: RowForm
}): { place: () => void } {
  const { tabRow, sideHeader, workspace, addTabSlot, dragHandle, navbarHost, form } = ctx

  /**
   * Profile 切换器是**标签栏固定件**，不属于可编辑按钮账本。
   * 横排时钉在标签条之前；纵排时优先进入垂直标签列自己的顶部槽，
   * 因而始终是 tabbar 内容的左上角第一件，而不是 navbar 的可排序成员。
   */
  function placeWorkspace(inSide: boolean): void {
    if (inSide) {
      const target = (form.slots && form.slots.top) || sideHeader
      if (!target) return
      if (workspace.parentNode !== target || target.firstChild !== workspace) {
        target.insertBefore(workspace, target.firstChild)
      }
      return
    }
    const anchor = dragHandle && dragHandle.parentNode === tabRow
      ? dragHandle.nextSibling
      : tabRow.firstChild
    if (workspace.parentNode !== tabRow || workspace !== anchor) {
      tabRow.insertBefore(workspace, anchor)
    }
  }

  /**
   * 拖拽手柄的落位（两条规则）：
   *
   *   ① **Edge 型**（只有标签列住侧栏、导航栏还在顶上）→ 借住**导航栏最前**。
   *      那时侧栏是一条窄图标条，横杆放进去既没地方也没意义。
   *   ② **横排** → 紧贴空间切换器**正前方**（切换器在标签行首，手柄就在它前面）。
   *   ③ **全功能侧栏**（导航栏也住侧栏）→ **不动**：手柄在侧栏里由 CSS 隐藏
   *      （侧栏三态不吃窗口拖拽区，见 components/dragHandle.ts）。
   * 一句话：侧栏之外手柄永远在"最上面那一行的最前面"，且跟着切换器走。
   * 幂等：位置已对时一次 DOM 都不动。
   */
  function placeDragHandle(inSide: boolean, navbarInSide: boolean): void {
    if (!dragHandle) return
    // ① Edge 型（只有标签列住侧栏、导航栏还在顶上）→ 手柄借住**导航栏最前**。
    if (inSide && !navbarInSide && navbarHost) {
      if (navbarHost.firstChild !== dragHandle) navbarHost.insertBefore(dragHandle, navbarHost.firstChild)
      return
    }
    // ③ 全功能侧栏 → 侧栏里不出现手柄（CSS 隐藏），DOM 留在原处即可。
    if (inSide) return
    // ② 横排：紧贴空间切换器正前方。
    if (dragHandle.parentNode !== tabRow || tabRow.firstChild !== dragHandle) {
      tabRow.insertBefore(dragHandle, tabRow.firstChild)
    }
  }

  /**
   * 固定钮的落位：**与空间切换器同一行、紧挨在它后面**（用户口径：
   * 「按钮在 profile 按钮右侧」）。
   *
   * 行只有两处（由 ① 决定）：侧栏标题行（全功能侧栏）/ 侧栏顶部槽（Edge 型）。
   * 所以这里不做自己的判定，直接拿「切换器**此刻的父节点**」当目标行 ——
   * 一行只有一处真相，切换器搬到哪，按钮就跟到哪，不可能出现"按钮留在旧行"。
   *
   * 幂等判据用「紧邻切换器之后」（`previousSibling === workspace`），与插入位置
   * 同一口径，位置已对时一次 DOM 都不动。
   */
  function placePin(inSide: boolean): void {
    // 按钮来自槽位（构造本模块时还没有槽位 —— 它在 mountSideTabs 才交过来），
    // 所以每次重摆现读，不缓存副本。
    const pin = form.slots && form.slots.pin
    if (!pin) return
    // 横排：侧栏不在台上 → 按钮离场（否则纵排导航栏那一行会剩一颗孤零零的钉）。
    if (!inSide) {
      if (pin.parentNode) pin.remove()
      return
    }
    const host = workspace.parentNode
    // 切换器还没落到侧栏里（挂载时序的中间态）→ 按钮不动，下一轮重摆再跟。
    if (!host || host === tabRow) return
    if (pin.parentNode === host && pin.previousSibling === workspace) return
    host.insertBefore(pin, workspace.nextSibling)
  }

  /**
   * 重摆（幂等 —— 目标位没变则一次 DOM 都不动）。
   *
   * ① 标题行归属：本块也在侧栏 → 寄住在自己的标题行（整列顶部）
   *              → 否则（本块在顶、标签栏在侧）交给侧栏顶部槽
   *              → 否则（横排）回标签行首
   * 固定钮：跟着 ① 的那一行走，紧邻切换器之后（见 placePin）
   * 新建标签：横排 → 标签行末；侧栏 → **不搬**（列表自带浮钮，见文件头）
   */
  function place() {
    const inSide = form.inSide
    const navbarInSide = form.navbarInSide

    placeWorkspace(inSide)
    placePin(inSide)

    // ② 新建标签：只在横排时钉回标签行末；侧栏下留在原处（标签行不在台上 = 不显示），
    // 免得与列表自带的「新建标签页」浮钮重复。
    if (!inSide && addTabSlot.parentNode !== tabRow) {
      tabRow.appendChild(addTabSlot)
    }

    // ③ 拖拽手柄：Edge 型借住导航栏最前，其余模式紧贴空间切换器（见 placeDragHandle）。
    // 顺序有讲究：必须在 ① 之后 —— 手柄要挨着切换器**当前所在**的那一行。
    placeDragHandle(inSide, navbarInSide)
  }

  return { place }
}

