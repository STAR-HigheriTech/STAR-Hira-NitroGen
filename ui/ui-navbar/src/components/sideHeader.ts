/**
 * **侧栏标题行槽** —— 纵排宿主（侧栏）里整列最顶上那一行的落点。
 *
 * 为什么单独一个模块：这是「空间切换器寄住」的容器，而它的显隐规则完全由**轴**决定
 * （横排里这一行不存在，纵排里才占位，且空着不显示）—— 与导航栏里任何一个部件都无关。
 * 把它做成一个哑槽，`sideColumnPlan` 只需回答「谁住进来」，样式由本模块自己的 CSS 回答。
 *
 * 为什么这一行在纵排时是**拖拽区**：无边框窗口在纵排宿主的顶部没有标签条可以拖，
 * 整列顶部若不可拖，窗口就几乎拖不动（与 `#navbar-toolbar` 的透明处同口径）。
 * 故容器是 drag 区，住进来的空间切换器各自 no-drag 覆盖其上。
 *
 * 本模块**不认识**空间切换器是什么（不知道它长什么样、点什么）—— 只提供槽。
 */

export const SIDE_HEADER_CSS = `
    /* 横排里不存在这一行（导航栏不纵排时，标题行没有意义）。 */
    .navbar-side-header {
      display: none;
    }

    /* 纵排 + 有内容 → 才是真实的一行（空槽不留高度，否则列顶凭空多一条缝）。
       行内间距同样走**侧栏口径**（--ng-navbar-column-gap）：这一行住着空间切换器与
       窗口控制按钮，窄栏下 4px 的缝会把两件东西推得比可用宽还宽。
       同时它是"侧栏窄不窄"的**容器查询容器**之一（container: side-column）：
       全功能侧栏下空间切换器寄住在这里（不在侧栏骨架里），"窄栏只留图标"那条规则
       得有个容器可查 —— 本行宽度 = 侧栏区宽度，且本行**不带玻璃**
       （玻璃在 #chrome-top / #chrome-side 上，而 container 会把自己变成 backdrop root，
       所以只能挂在玻璃之外的元素上，见 ui-chrome-layout 里 #chrome-side 的警告）。 */
    #navbar-toolbar[data-host-axis="column"] > .navbar-side-header:not(:empty) {
      display: flex;
      align-items: center;
      gap: var(--ng-navbar-column-gap);
      min-width: 0;
      flex: 0 0 auto;
      order: -2;
      margin-left: 0;
      container: side-column / inline-size;
      -webkit-app-region: drag;
    }

    /* 容器是拖拽区，住进来的控件各自让出拖拽。 */
    #navbar-toolbar[data-host-axis="column"] > .navbar-side-header > * {
      -webkit-app-region: no-drag;
    }

    /* 住进来的控件按**窄列**的规格显示：窗口控制按钮从导航栏整行的 46×38 收到 28×26。
       为什么必须收：这一行还住着空间切换器，而侧栏最窄 150px（可用 134px）——
       三颗 46px 的按钮会把空间切换器整个挤出去。26px 是空间切换器触发器的高度
       （见 ui-space-switcher），于是顶行两件东西同高、连成一条。
       判据是**这一行**而不是按钮自己：同一颗按钮在横排导航栏 / 标签行里仍是 46×38。 */
    #navbar-toolbar[data-host-axis="column"] > .navbar-side-header .window-control-btn {
      width: 28px;
      height: 26px;
    }

    /* 固定钮**靠右**（用户口径：「固定按钮靠右」）：全功能侧栏里它住在这一行
       （不在 .vtabs 里，所以 ui-vertical-tabs 那条祖先选择器管不到），这里补同一句。
       于是整行从外到内是「窗控 → 空间切换器 ………… 固定钮」。 */
    #navbar-toolbar[data-host-axis="column"] > .navbar-side-header .vtabs__pin-btn {
      margin-left: auto;
    }
`

/**
 * @param {Document} doc
 * @returns {{ element: HTMLElement }}
 */
export function createSideHeader(doc: Document): { element: HTMLElement } {
  const element = doc.createElement('div')
  element.className = 'navbar-side-header'
  return { element }
}
