// @ts-check
/**
 * @hira-ng/ui-tabbar —— 横向标签条（外壳顶行的标签列）。
 *
 * 这个文件只做**装配**：搭出两个容器 → 把各模块装上去 → 把能力拼成对外契约。
 * 每件事都有了自己的家：
 *
 *   styles.js                 全部样式（标签行 / 开合关键帧 / 取色 / 芯片 / 下划线 / 预览）
 *   components/Tab.js         单条标签（favicon / 标题 / 关闭 / 音频指示 / 双击中键）
 *   components/TabStack.js    标签组芯片（含自带菜单与行内重命名）
 *   components/TabPreview.js  hover 预览浮层的计时与锚点
 *   components/AddTabButton.js 新建标签按钮（供别处复用的最小件）
 *   components/decoration.js  插件装饰层（渲染侧插槽）的挂载语义 + 样式
 *   view/projection.js        投影纯函数（diff / 找组 / 找相邻项）
 *   view/animations.js        开合动效 + FLIP 让位
 *   view/stackLineLayer.js    标签组下划线图层（几何 + 逐帧跟踪）
 *   view/dropController.js    拖拽落点语义 / 指示线 / 堆叠高亮 / 插件抢答
 *   view/contextMenu.js       右键菜单（模板在 ui-common，这里只接意图）
 *   view/tabRecord.js         标签行的渲染记录（keyed 复用单元）
 *   view/stackRecord.js       芯片的渲染记录
 *   view/renderer.js          增量渲染引擎（keyed 复用 + 字段 diff + 两阶段删除）
 *   view/tabSizing.js         Edge 式压缩：标签多了先缩宽度（CSS flex），再收窄间距（本模块）
 *
 * 滚动行为（横向可滚、交叉轴禁滚、滚动条外观、滚轮横推）**不在这里、也不在本包**：
 * 它是横竖两种模式共用的能力，住在 `@hira-ng/ui-common#stripScroller` —— 装配处一行挂上，
 * 本包只交出「我是横向条」这一个参数（`createStripScroller(inner, 'x')`）。
 *
 * 为什么必须这样拆：本组件曾经是**一个 1200 行的文件** —— 样式、渲染循环、
 * 拖拽六种落点、下划线几何、右键菜单、编辑器生命周期全挤在一起。结果是
 * 「调一个圆角要滚过整条渲染管线」「改落点语义要读懂下划线怎么量」。
 * 现在**加一个能力 = 加一个文件 + 这里一行装配**，删掉同理 —— 与插件扩展姿势一致。
 *
 * 边界（一直没变，且更硬了）：
 *   · 不认识 IPC / 设置 / 标签数据：意图全部经 options 回调上抛；
 *   · 不认识插件系统：装饰层与拖放认领是**宿主注入的函数**（缺省 = 没有插件参与）；
 *   · 不认识布局：只暴露 element 与 renderTabs，摆放由编排层决定。
 */

import {
  createStripScroller, createSplitClip, injectSplitClipStyles, guardMiddleClickAutoscroll,
  createFramePump, relayGeometryMotion
} from '@hira-ng/ui-common'
import { injectTabbarStyles } from './styles.js'
import { createTabPreview } from './components/TabPreview.js'
import { createTabAnimator } from './view/animations.js'
import { createStackLineLayer } from './view/stackLineLayer.js'
import { createSplitClipLayer } from './view/splitClipLayer.js'
import { keyOf } from './view/projection.js'
import { createDropController } from './view/dropController.js'
import { createTabSizing } from './view/tabSizing.js'
import { createTabbarContextMenu } from './view/contextMenu.js'
import { createTabRenderer } from './view/renderer.js'
import type { TabbarController, TabbarOptions, TabRendererController } from './types.js'

export type {
  TabViewState,
  TabStackState,
  TabbarProjectionItem,
  TabbarProjection,
  TabPatch,
  StackPatch,
  ProjectionPatch,
  TabDecorator,
  TabPreviewOverlayPort,
  TabbarRendererSlots,
  TabbarOptions,
  TabbarController,
  TabComponentController,
  TabStackComponentController,
  IntentHandler,
  IntentHandlers,
  UnknownRecord
} from './types.js'

/**
 * @param {Document} doc
 * @param {object} [options] 意图出口（全部可选；组件对它们零知识）。
 *   拖拽落库的五条通道（空处=出栈 / 组外散标签=先出栈再落位 / 组内=并入 /
 *   与目标堆叠=stackTogether / 行间=重排）由 `onDragEnd` 一个出口统一接收，
 *   具体载荷形状由 dropController 定义。
 */
export function createTabbar(doc: Document, options: TabbarOptions = {}): TabbarController {
  const {
    onSwitchTab, onToggleStack, onRenameStack,
    onStackWith, onCloseTab, onNewTab, onDragEnd, onCloseOthers, onCloseRight, onTogglePin,
    onToggleMute, onDuplicate, onReload, onGoBack, onGoForward, onUndoClose,
    // 权限请求标记的点击出口：交出「被点的是哪条标签」。
    // 与 onSwitchTab 同形（tabId 由渲染记录补）—— 本组件不认识权限模型，只转发意图。
    onPermissionClick,
    // 右键「定时刷新」（C7）：宿主调 tab:auto-refresh（intervalMs=0 关闭）。
    onAutoRefresh,
    // 右键「分享 / 生成二维码」（N15）：宿主开分享页（hira://share?url=…）。
    onSharePage,
    // 右键「移出标签组」：单个标签脱离它所在的组（组还在，其余成员照旧）
    onLeaveStack,
    // 右键「按域名分组标签」：宿主拿 (tabIds, domain) 去落库（复用既有 stack-create）。
    onGroupByDomain,
    // 右键「归档标签」：宿主调 tab:archive（关闭 + 记入归档区）。
    onArchive,
    // Alt/Option + 单击标签 = 与当前活动标签分屏（对齐 Firefox / Zen）。
    // 宿主只需交出「被点的是哪条」，另一个格子由主进程解析（活动标签只有主进程权威）。
    onSplitWithActive,
    // Arc 式入口：拖标签到网页区域松手 = 与"拖动前正在看的那一格"分屏
    onDropOnContent,
    // 同一条链的**开始**那半：拖动一开始就告诉宿主 —— 拖动期间的"这一格会落在哪"
    // 预览只能由主进程按屏幕光标算（渲染层在拖动期收不到指针事件），所以必须有一个起点信号。
    onDropOnContentBegin,
    // 拖拽期"可拖到网页区域分屏"的能力提示开关（拖拽生命周期由落点控制器驱动）
    onDragHintChange,
    /**
     * 外部拖入（集锦卡 / 书签 / 历史 / 下载 / 画板）：统一协议载荷 →
     * `(item, target)`，落点语义与内置拖拽同形（tab / stack / strip）。缺省不做任何事。
     */
    onExternalDrop,
    /**
     * **标签行右键菜单的动作整包**（宿主把各动作表拼好一次性交进来：
     * `{ ...createSplitMenuHandlers(tabsClient), ...createGlanceMenuHandlers(tabsClient) }`）。
     *
     * 为什么是**唯一一整包**，而不是 `splitMenu` / `glanceMenu` 这样"一个特性一个字段"：
     * 本组件曾经把菜单回调逐项列出来，于是**加了新项就漏接**（分屏那七项、以及后来
     * 的速览三项都是这样一直"能看见、点了没反应"—— 宿主早就把动作表造好了，这里
     * 既没解构、也没转交）。一个特性一个字段只是把"逐项列"从一层挪到三层：每加一个
     * 功能仍要在 apps / index.js / contextMenu.js 各补一行，漏任一处就复发。
     * 整包之后，**"菜单里多一项"只需要改 ui-common 的模板与 apps 的动作表** ——
     * 本组件与 contextMenu.js 此后永不需要因为新增功能而改动。
     */
    tabMenuHandlers,
    /**
     * **标签组动作整包**（宿主用 `createStackMenuHandlers(tabsClient)` 造好的那一份）。
     * 理由同上：芯片菜单的项会增删，逐项列必然漂移。
     *（注意它进的是**芯片菜单**，不是标签行菜单，所以与 `tabMenuHandlers` 是两回事。）
     */
    stackMenu,
    showMenu, overlay, slots
  } = options

  /**
   * 宿主注入的**装饰层调用器**（渲染侧插槽 `tabbar.item-renderer` / `tabbar.tab-stack-renderer`）。
   * `ui-tabbar` 是哑组件，不认识插件系统 —— 拿到的是两个函数，缺省即「没有插件参与」。
   * 语义与两条硬约束见 `components/decoration.js`。
   */
  const decorateTab = slots && typeof slots.itemDecorator === 'function' ? slots.itemDecorator : null
  const decorateStack = slots && typeof slots.stackDecorator === 'function' ? slots.stackDecorator : null
  /**
   * 插件**拖放目标认领器**（渲染侧插槽 `tabbar.drop-target`，MULTI）。
   * 语义是「抢答」而不是「再叠一层」—— 见 view/dropController.js 的 drop 处理。
   */
  const claimDrop = slots && typeof slots.dropTargetAccepter === 'function' ? slots.dropTargetAccepter : null

  // ── DOM 骨架（只有两个容器，其余全由各模块自建）────────────────────────────
  const tabs = doc.createElement('div')
  tabs.id = 'tabs'

  const inner = doc.createElement('div')
  inner.id = 'tabs-inner'
  inner.setAttribute('role', 'tablist')
  inner.className = 'has-thin-scrollbar'
  tabs.appendChild(inner)

  // 滚动区：**横竖两种模式共用**的那一份实现（主轴可滚 / 交叉轴禁滚 / 滚动条外观 / 滚轮换算），
  // 本组件只交出「我是横向条」这一个参数，见 @hira-ng/ui-common#stripScroller。
  createStripScroller(inner, 'x')

  // 中键自动滚动守卫：挂在**标签条根**（不是各行上）—— 行与行之间、行与容器边缘之间
  // 的那片**背景**也属于标签条，而中键在背景上照样会起自动滚动光标、把「中键关闭」
  // 抢掉一拍（用户原话："无论如何包括这个 tabbar 底部的背景图层"）。
  // 规则与横向/纵向两种模式共用一份，见 @hira-ng/ui-common#middleClickGuard。
  // 行内那一份仍在（attachTabGestures 自己也挂）—— 行是最小件，可能被装进别的宿主。
  guardMiddleClickAutoscroll(tabs)

  // 标签条的**压缩**（Edge 式）：横向条专属 —— 宽度那一半由 CSS flex 完成（见 styles.js
  // 的 flex-shrink 注释），这里只负责 CSS 做不到的那一半（随密度收窄的间距与内边距）。
  // 它自己观察 DOM（增删 + class 变化）与外层尺寸，本装配处不需要任何回调。
  createTabSizing({ strip: tabs, inner })

  // 拖拽手柄已移到 navbar 顶行最左（见 ui-navbar 的拖拽手柄部件）：
  // 标签回归靠左顺排后，标签栏左侧不再有空白，手柄留在原处只会压住第一个标签。

  // ⚠ 构造次序：下面多处需要「此刻的投影」「按 key 拿节点」，而投影与节点都归渲染引擎所有。
  // 用 refs 做可变引用（与 ui-navbar 的 hosts/anchors/refs 同一手法），
  // 于是各模块可以**先建后连**，不必为了拿一个引用把构造顺序绑成死结。
  const refs: { renderer?: TabRendererController } = {}

  /**
   * 标签条**共享帧泵**：所有挂在 `#tabs-inner` 里的「装饰绘制层」（组下划线、分屏回形针）
   * 共用这一条 rAF —— 一帧里先让全员读完几何、再让全员写，于是同一帧最多**一次**布局结算，
   * 而不是每层各跑一轮「读→写」（那会把对方刚写的样式作废，逐层强制重排）。
   *
   * 三类触发源都汇到同一个 `ping`：
   *   · 每轮渲染后的动效窗口（各层 `track` 自行续期）；
   *   · 几何相关 CSS 过渡（宽度/高度/内边距/transform…）—— `relayGeometryMotion`；
   *   · 容器尺寸变化（窗口拉宽、首次显示、纵向↔横向切换）—— ResizeObserver。
   */
  const stripPump = createFramePump(doc.defaultView, {
    durationMs: 300,
    alive: () => inner.isConnected
  })
  const unstuckMotion = relayGeometryMotion(inner, (ms: number) => stripPump.ping(ms), { durationMs: 300 })
  /** 绘制层有活时才存在的观察者（绝大多窗口零标签组 / 零分屏，仍会有 0 次回调开销）。 */
  const stripResize = doc.defaultView && typeof doc.defaultView.ResizeObserver === 'function'
    ? new doc.defaultView.ResizeObserver(() => stripPump.ping(300))
    : null
  if (stripResize) stripResize.observe(inner)

  /**
   * 标签组下划线图层：挂在滚动容器**内部**，横向滚动时线跟着标签走（见 styles.js）。
   * 分屏回形针图层同理 —— 它也必须挂在容器内部：回形针要**跨在两条标签之间的缝上**，
   * 而标签自身 `overflow: hidden`（关闭时要塌宽裁住内容），装不进标签里。
   * 两个层的顺序无所谓（一个画底部凹槽、一个画垂直居中的缝，像素上不重叠）。
   */
  const stackLines = createStackLineLayer(doc, inner, {
    getNode: (key: string) => (refs.renderer ? refs.renderer.getNode(key) : null),
    pump: stripPump
  })
  inner.appendChild(stackLines.element)

  const splitClips = createSplitClipLayer(doc, inner, {
    getNode: (key: string) => (refs.renderer ? refs.renderer.getNode(key) : null),
    // key 怎么拼由渲染引擎说了算（本层不认识投影形状）；回形针长什么样由 ui-common 说了算
    // （本层不重复实现外观 —— 那正是上一版"横向纵向外形各写一份"的病根）。
    keyOf,
    createClip: () => createSplitClip(doc, { label: '与右侧标签分屏' }),
    pump: stripPump
  })
  inner.appendChild(splitClips.element)

  /** 拖拽落点控制器：指示线挂在拖拽区（#tabs）上，命中判定在滚动容器（#tabs-inner）内。 */
  const drop = createDropController(doc, tabs, inner, {
    getItems: () => (refs.renderer ? refs.renderer.getItems() : []),
    onDragEnd,
    onDragHintChange,
    claimDrop,
    onExternalDrop
  })
  tabs.appendChild(drop.element)

  // ── 拖拽期的能力提示 ─────────────────────────────────────────────────────
  // 为什么是"能力提示"而不是"状态指示"：外壳收不到"指针是否压在网页上"的事件 ——
  // 网页是原生视图，指针一进它就离开了外壳视口。所以这里只能表达"你已经拖到外壳之外
  // ——那正是可以分屏的地方"，而不去断言"你正在某个网页上方"（拖向另一个窗口时后者是错的）。
  // 措辞因此用"可以"而不是"即将"。
  const dragHint = doc.createElement('div')
  dragHint.className = 'tabbar-drag-hint'
  dragHint.textContent = '松手在网页区域可分屏'
  dragHint.style.display = 'none'
  tabs.appendChild(dragHint)

  function setDropHint(active: boolean) {
    if (!active) {
      dragHint.style.display = 'none'
      return
    }
    // 用 viewport 坐标（`position: fixed`）而不是父元素坐标：这样完全不依赖
    // 「标签条根有没有 position:relative」，也就不必去动它的定位上下文。
    const rect = tabs.getBoundingClientRect()
    dragHint.style.display = ''
    dragHint.style.top = `${Math.round(rect.top + Math.max(0, (rect.height - 20) / 2))}px`
    dragHint.style.right = `${Math.round(Math.max(8, window.innerWidth - rect.right + 10))}px`
  }

  const preview = createTabPreview(doc, overlay)
  /**
   * 指针离开**整条标签条** → 立即收起预览。
   *
   * 为什么单标签的 mouseout 不够：标签右侧那块空白是 `#tabs::after`（**拖拽区**），
   * 它不是标签，指针进入时标签的 mouseout 早已派发完、并按「relatedTarget 仍在
   * `#tabs` 内」放行；此后再往右/往上挪出标签条，**没有任何标签元素还在鼠标底下**，
   * 于是不会再有任何事件 —— 预览就永久挂在那里（用户实测："移到空白处再挪开，
   * tabpreview 卡死"）。
   *
   * 判据必须挂在标签条根上：它同时覆盖「标签列 + 右侧空白 + 上下内边距」，
   * 也就是"指针是否还在标签条这个容器里"这个唯一事实。`mouseleave` 不冒泡、
   * 只在真正离开整条时派发，子元素之间移动一律不触发。
   */
  tabs.addEventListener('mouseleave', () => preview.hide())
  const animator = createTabAnimator()
  const openMenu = createTabbarContextMenu({
    showMenu,
    getItems: () => (refs.renderer ? refs.renderer.getItems() : []),
    intent: {
      onGoBack, onGoForward, onReload, onDuplicate, onTogglePin, onToggleMute, onNewTab,
      onAutoRefresh,
      onSharePage,
      onStackWith, onLeaveStack, onGroupByDomain, onArchive, onCloseTab, onCloseOthers, onCloseRight, onUndoClose
    },
    // 特性动作**整包直送 handlers**（见 contextMenu.js 的说明）——
    // 不再绕 `intent → call(name)`：那道转手会因为 handlers 是固定几项而**静默丢掉**整包，
    // 表现就是"菜单项都在、点了没反应"。整包之后"菜单多一项"只需改模板与 apps 的动作表。
    tabMenuHandlers
  })

  refs.renderer = createTabRenderer(doc, {
    innerEl: inner,
    animator,
    stackLines,
    splitClips,
    preview,
    ports: {
      // 标签行
      onSelect: onSwitchTab,
      onSplitWithActive,
      onDropOnContent,
      onDropOnContentBegin,
      onClose: onCloseTab,
      onToggleAudio: onToggleMute,
      // 权限请求标记：与关闭/静音同为「行内按钮」，点击意图经同一条端口链上抛。
      onPermissionClick,
      decorateTab,
      drag: drop,
      openMenu,
      // 标签组芯片：展开/收起与改名（这两个要碰芯片自己的 DOM），
      // 其余四个动作走 stackMenu 整包（见上面的说明）。
      onToggleStack,
      onRenameStack,
      stackMenu,
      decorateStack,
      showMenu
    }
  })

  return {
    element: tabs,
    renderTabs: refs.renderer!.render,
    /** 拖拽期能力提示的开关（由落点控制器的拖拽生命周期驱动）。 */
    setDropHint,
    /**
     * 拆除：宿主卸载标签条时调用。收掉帧泵的三条触发源与两个绘制层，
     * 其余全是 DOM 事件（随 tabs 节点移除自然失效）。
     */
    dispose() {
      if (stripResize) stripResize.disconnect()
      unstuckMotion()
      stackLines.dispose()
      splitClips.dispose()
      stripPump.dispose()
    }
  }
}

export { injectTabbarStyles }

// 既有导出面保持不变：这些「最小件」仍可被别处复用（与拆分前逐项一致）。
export { createTab } from './components/Tab.js'
export { createAddTabButton } from './components/AddTabButton.js'
export { createTabPreview } from './components/TabPreview.js'
export { createTabStack } from './components/TabStack.js'

// 新增的装配件（供扩展方复用 / 组合出别的标签呈现，例如垂直标签）。
export { createTabRenderer } from './view/renderer.js'
export { createTabRecord } from './view/tabRecord.js'
export { createStackRecord } from './view/stackRecord.js'
export { createTabbarContextMenu } from './view/contextMenu.js'
export { createDropController } from './view/dropController.js'
