/**
 * 外壳的**块骨架** —— 「两块 + 四行」的空容器，一个部件都不含。
 *
 * 两块（可被外部独立摆放）：
 *   · `#navbar-tabbar`  标签栏块（拖拽手柄 / 空间切换器 / 标签条槽 / 新建标签槽 / 可选窗口控制按钮）
 *   · `#navbar-toolbar` 导航栏块（侧栏标题行 / 导航行 / 地址栏 / 进度条）
 *
 * 四行（导航栏块的内部规格；横排只用到「地址栏 / 工具按钮」两类，纵排各占一行）：
 *   · `.navbar-side-header`   侧栏标题行（纵排才有；空间切换器寄住在此）
 *   · `.navbar-bottom-center` 地址栏
 *   · `.navbar-actions-row`   工具按钮行 —— 包裹 `.navbar-bottom-left` 与 `.navbar-bottom-right`
 *
 * 为什么工具按钮要**包裹成一行**（横排时反而看不见这一层）：
 *   横排下它是 `display: contents`（两簇仍是导航栏的直接布局项，靠 `order` 回到左/中/右），
 *   纵排下它是**真实的 flex 行** —— 导航簇与面板簇并排，而不是各占一行把「一排工具」拉成两排。
 *   详见 docs/vertical-tabs-architecture.md §4.3。
 *
 * ⚠ 纵排下 `.navbar-bottom-right`（面板簇 + 菜单）**常常不在这里**：它由
 *   `row/sideDock.ts` 借住到标签栏块的侧栏底槽，于是面板行落在标签列表之下（正是
 *   全功能侧栏该有的样子）。这一层只负责「把两个容器造出来」，谁搬走是别人的事。
 *
 * 为什么单独一个模块：这些容器不属于任何部件 —— 它们是「块」这一层的存在证明。
 * 部件换掉（例：把地址栏换成命令栏）时这一层一行不改；反过来，要改块的行规格
 * 也不必翻进任何一个部件的文件。
 *
 * ⚠ `chrome` 是**内部组装用的逻辑根，不挂到 DOM**：两块做好后由 ui-chrome-layout
 *   分别取走摆放，因此这里不能假定它们是同一容器里的上下两行。
 */

import { createSideHeader } from './sideHeader'
import { guardMiddleClickAutoscroll } from '@hira-ng/ui-common'

/**
 * @param {Document} doc
 * @returns {{
 *   chrome: HTMLElement,
 *   tabRow: HTMLElement,
 *   toolbar: HTMLElement,
 *   sideHeader: HTMLElement,
 *   actionsRow: HTMLElement,
 *   bottomLeft: HTMLElement,
 *   bottomCenter: HTMLElement,
 *   bottomRight: HTMLElement
 * }}
 */
export function createChromeBlocks(doc: Document): {
  chrome: HTMLElement
  tabRow: HTMLElement
  toolbar: HTMLElement
  sideHeader: HTMLElement
  actionsRow: HTMLElement
  bottomLeft: HTMLElement
  bottomCenter: HTMLElement
  bottomRight: HTMLElement
} {
  const chrome = doc.createElement('div')
  chrome.id = 'navbar-chrome'

  const tabRow = doc.createElement('div')
  tabRow.id = 'navbar-tabbar'
  tabRow.className = 'navbar-top-row theme-background-color theme-text-color'
  // 中键自动滚动守卫：整块标签栏（拖拽手柄 / 空间切换器 / 标签条 / 新建标签）都不该
  // 起自动滚动 —— 行与控件之间的**空白**同样是这一块，而中键在那里照样会起四向箭头、
  // 把「中键关标签」抢掉一拍（见 @hira-ng/ui-common#middleClickGuard）。
  guardMiddleClickAutoscroll(tabRow)

  const toolbar = doc.createElement('div')
  toolbar.id = 'navbar-toolbar'
  toolbar.className = 'navbar-bottom-row theme-background-color theme-text-color'

  chrome.appendChild(tabRow)

  const sideHeader = createSideHeader(doc)

  const bottomLeft = doc.createElement('div')
  bottomLeft.className = 'navbar-bottom-left'
  const bottomRight = doc.createElement('div')
  bottomRight.className = 'navbar-bottom-right'

  // 工具按钮行：把「左导航区」与「右站点控制区」收进同一个包裹行。
  // 键顺序无关紧要（纵排靠 order、横排靠 display:contents + order），这里按视觉排。
  const actionsRow = doc.createElement('div')
  actionsRow.className = 'navbar-actions-row'
  actionsRow.appendChild(bottomLeft)
  actionsRow.appendChild(bottomRight)

  const bottomCenter = doc.createElement('div')
  bottomCenter.className = 'navbar-bottom-center'

  toolbar.appendChild(sideHeader.element)
  toolbar.appendChild(actionsRow)
  toolbar.appendChild(bottomCenter)

  return {
    chrome,
    tabRow,
    toolbar,
    sideHeader: sideHeader.element,
    actionsRow,
    bottomLeft,
    bottomCenter,
    bottomRight
  }
}
