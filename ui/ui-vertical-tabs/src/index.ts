// @ts-check
/**
 * @hira-ng/ui-vertical-tabs —— 垂直标签栏（住在侧栏里的那条**占位**标签列）。
 *
 * 本文件只做**装配**：取宿主骨架 → 把标签列表放进去 → 拼出对外契约与自描述定义。
 * 三件事各有各的家：
 *
 *   src/styles.js   全部样式（骨架 / 固定钮 / 把手 / 图标条形态 / 最小基底；并先注入共享行样式）
 *   src/host.js     四段骨架 + 固定钮 + 调宽把手 + 「图标条 / 展开」形态机（**不认识标签**）
 *   src/index.js    （本文件）host + 标签列表 → createVerticalTabs + verticalTabsDefinition
 *
 * 拆分的判据与 ui-tabbar 完全一致：**能独立换掉的东西单独一个文件**。
 * 换骨架（例：浮出卡片型侧栏）不动标签列表；换列表（例：网格型固定标签）不动骨架与把手。
 *
 * 标签列表**完整复用 ui-common 的 `createTabListHost`** —— 与「打开标签」「固定标签」
 * 两个面板**同一份实现**：右键菜单、hover 预览、拖拽重排与并入标签组、音频与关闭按钮、
 * 双击/中键关闭、标签组行、开合动效因此天然一致，不可能各写一套而漂移。
 *
 * 它**不认识谁**：不认识 app-shell、不认识 rail / 面板 / navbar，也不碰任何 IPC ——
 * 能力全部由 ctx 注入（与面板宿主同一套契约）。
 *
 * 与横向标签条的关系：两者是**同一个标签模型的两种呈现**，数据同源、互不认识；
 * 此刻谁是宿主由摆放计划决定（shared-types#planChromeLayout 的 side 区域），
 * 组件只通过 `data-host-axis="column"` 承认「我现在住在纵排区域里」这一个事实。
 *
 * ── 侧栏可见性里它负责哪一半 ─────────────────────────────────────────────
 *   · **常驻占位（attached）** → 宽度恒为 `plan.side.restWidth`；
 *   · **悬停展开（floating）** → 静止宽 `plan.side.restWidth`，展开形态由计划里的
 *     `revealOverlay` 一分为二（本组件不判形态，只按编排层给的 `collapsed` 画）：
 *       - Edge 型（true）→ 静止即本条侧栏的图标 rail，展开是**覆盖网页的独立浮层**
 *         （主进程 WebContentsView `sidebar-float`），网页不缩进、不重排；
 *       - 全功能型（false）→ 静止宽 0（网页铺满），唤出时这条侧栏自己变宽、推挤网页；
 *   · **隐藏** → `plan.side` 为空，本组件不会被挂载。
 * 本组件只画「固定 / 悬停」按钮的外观与形态，宽度与唤出时机完全由侧栏容器与主进程按计划落。
 */

import { createTabListHost, type TabRowItem } from '@hira-ng/ui-common'
import { createVtabsHost } from './host.js'
import { injectVerticalTabsStyles } from './styles.js'

export interface VerticalTabsWidthRange {
  min?: number
  max?: number
  default?: number
}

export interface VerticalTabsContext {
  widthRange?: VerticalTabsWidthRange
  onResizeStart?: () => void
  onResize?: (width: number) => void
  onResizeEnd?: () => void
  onTogglePin?: () => void
  [key: string]: unknown
}

export interface VerticalTabsController {
  readonly element: HTMLElement
  readonly slots: ReturnType<typeof createVtabsHost>['slots']
  setItems(items: readonly TabRowItem[]): void
  flush(): void
  setCollapsed(collapsed: boolean): void
  setPinned(pinned: boolean): void
  isCollapsed(): boolean
  isPinned(): boolean
  dispose(): void
}

/**
 * 创建垂直标签栏（宿主骨架 + 标签列表）。
 *
 * @param {Document} doc
 * @param {object} [ctx] 与 createTabListHost 同一套契约（菜单 / 预览 / 拖拽落库 / 意图出口…）。
 *   本组件**原样转发**，不解释其中任何一项 —— 于是「标签能力」升级只发生在 ui-common。
 * @returns {{
 *   element: HTMLElement,
 *   slots: { pin: HTMLElement, top: HTMLElement, body: HTMLElement, dock: HTMLElement, bottom: HTMLElement },
 *   setItems: (items: readonly TabRowItem[]) => void,
 *   flush: () => void,
 *   setCollapsed: (collapsed: boolean) => void,
 *   setPinned: (pinned: boolean) => void,
 *   isCollapsed: () => boolean,
 *   isPinned: () => boolean,
 *   dispose: () => void
 * }}
 */
export function createVerticalTabs(doc: Document, ctx: VerticalTabsContext = {}): VerticalTabsController {
  const host = createVtabsHost(doc, ctx)

  // 标签列表：与两个面板**同一份实现**（见文件头）。
  // 常驻底部「新建标签」浮钮由它自带（showAddButton），与横向标签条同一个入口语义。
  // 装配这一步就是「把列表放进列表体槽」—— 两边互不认识，只有这里知道它们是一对。
  const list = createTabListHost(doc, Object.assign({}, ctx, { showAddButton: true }))
  host.slots.body.appendChild(list.element)

  return {
    element: host.element,
    slots: host.slots,

    /** 灌入标签投影（含标签组行）—— 与面板 `setItems` 同一条数据口径。 */
    setItems(items: readonly TabRowItem[]) {
      list.setItems(items)
    },

    /**
     * 宿主显示时补齐隐藏期攒下的列表变更（闸门在 ui-common#tabListHost）。
     * 只有 `autoSubscribe` 的宿主需要它（外壳那份由 `setItems` 主动推）。
     */
    flush() {
      list.flush()
    },

    setCollapsed: host.setCollapsed,
    setPinned: host.setPinned,
    isCollapsed: host.isCollapsed,
    isPinned: host.isPinned,

    dispose() {
      list.dispose()
      host.dispose()
    }
  }
}

/**
 * 垂直标签栏的**自描述定义** —— 与 `ui-panel-opentabs` 的 `panelDefinition` 同一范式。
 *
 * 为什么要有它：宿主（app-shell）此前要手写一大坨 ctx（意图映射、拖拽五条通道、
 * 右键菜单、预览浮层、宽度落库…）才能把这个块立起来 —— 那些全是**本组件自己的知识**，
 * 摆在宿主里既臃肿又容易两边漂移。收进定义之后，宿主的装配退化成「交出端口」：
 *
 *     const v = verticalTabsDefinition.mount(document, {
 *       clients: { tabs }, createTabRowMenu, menu, previewOverlay,
 *       widthRange, onResize, onTogglePin
 *     })
 *
 * 与 opentabs 面板逐项对齐的口径：
 *   · `injectStyles(doc)` —— 样式由谁挂载谁注入（宿主调一次），组件不自作主张往文档里写；
 *   · `mount(doc, ctx)`  —— 只吃**端口**，不认识任何具体客户端实现、不碰 IPC。
 *
 * 数据契约（与面板的唯一区别）：面板住在独立视图，只能自己 `tabsClient.onChanged` 拉；
 * 垂直标签住在**外壳视图**里时，标签投影由编排层经 `setItems` 推入（少一条订阅、少一次渲染），
 * 因此外壳挂载时不开 autoSubscribe —— 而 Edge 型展开浮层（独立视图 `sidebar-float`）
 * 用的是同一个 mount，它必须打开 autoSubscribe 自己拉。
 */
export const verticalTabsDefinition = {
  id: 'vertical-tabs',
  injectStyles: injectVerticalTabsStyles,

  /**
   * @param {Document} doc
   * @param {{
   *   clients?: { tabs?: object },
   *   createTabRowMenu?: (opts: { labels: object }) => Function,
   *   menu?: object,
   *   previewOverlay?: { showTabPreview?: Function, hideTabPreview?: Function, warmTabPreview?: Function },
   *   labels?: object,
   *   widthRange?: { min?: number, max?: number, default?: number },
 *   onResizeStart?: () => void,
   *   onResize?: (width: number) => void,
 *   onResizeEnd?: () => void,
   *   onTogglePin?: () => void
   * }} [ctx]
   */
  mount(doc: Document, ctx: VerticalTabsContext = {}) {
    return createVerticalTabs(doc, ctx)
  }
}

export { injectVerticalTabsStyles, createVtabsHost }
