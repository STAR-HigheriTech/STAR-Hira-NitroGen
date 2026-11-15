/**
 * 窗口拖拽手柄 —— 标签行最左那一条（在空间切换器之前）。
 *
 * 它自身就是「这里能拖窗口」的拖拽区（-webkit-app-region: drag）；
 * 看得见的那条 3px 小横杠是**画出来的**（::after），元素本体吃满整行高度。
 * 两者尺寸刻意分开：曾经命中区就等于那条 16×3 的横杠，指针几乎按不中 ——
 * 表现就是「拖动按钮总是失效」。现在可抓区域是 16×(整行高)。
 *
 * ⚠ 这里**不能**写 pointer-events: none：命中区被挖空，拖拽区也跟着失效。
 * ⚠ ::after 必须自己再写一次 drag：伪元素不会从父级继承 app-region，
 *    漏了它就会在手柄正中间挖出一个 no-drag 的洞（洞的大小正好是那条横杠）。
 *
 * ⚠ **纵排（住进侧栏）时整个手柄隐藏**：侧栏三态一律不吃窗口拖拽区（用户口径
 *    2026-10：「都不要有拖动区域出现」）。手柄是纯拖拽件，留着它只剩一条
 *    "看得见却不敢点的 3px 横杠"。侧栏形态下拖窗口交给侧栏之外的行。
 */

export const DRAG_HANDLE_CSS = `
    #navbar-drag-handle {
      width: 16px;
      flex-shrink: 0;
      align-self: stretch;
      margin-right: 6px;
      position: relative;
      -webkit-app-region: drag;
    }
    /* 纵排宿主 = 侧栏 → 不出现拖拽件（见文件头）。 */
    #navbar-toolbar[data-host-axis="column"] #navbar-drag-handle {
      display: none;
    }
    /* chrome 收起时连可见把手一起退场；布局占位保留，贴边唤出时不会横向跳一下。 */
    html.hira-chrome-drag-suppressed #navbar-drag-handle {
      visibility: hidden;
    }
    #navbar-drag-handle::after {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      width: 100%;
      height: 3px;
      transform: translateY(-50%);
      border-radius: 2px;
      background: var(--ng-tabs-drag-handle-color, rgba(0, 0, 0, 0.25));
      -webkit-app-region: drag;
    }
`

/**
 * @param {Document} doc
 * @returns {HTMLDivElement}
 */
export function createDragHandle(doc: Document): HTMLDivElement {
  const el = doc.createElement('div')
  el.id = 'navbar-drag-handle'
  return el
}
