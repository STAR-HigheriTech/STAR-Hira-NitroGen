/**
 * @hira-ng/ui-common / tabRowList —— 「标签行列表」通用组件
 *
 * 打开标签面板（opentabs）与固定标签面板（pinned）**共用这一个实现**：同一套排版、
 * 样式令牌、hover 预览、右键菜单、拖拽排序、音频/关闭按钮与增量渲染。两个面板的差异
 * 全部收敛成参数（filter / emptyText / extraActions / dragKind），因此它们在任何时刻
 * 都必然长得一模一样 —— 不会出现「改了一个忘了另一个」的风格漂移。
 *
 * 解耦要点：
 *  - 哑组件：不碰 IPC、不碰原生菜单。状态上行 setItems(tabs)，意图全部经 onIntent 上行，
 *    预览浮层经 ctx.overlay 注入（面板内画不出面板外的浮层，见下方注释）。
 *  - 行事件全部在 wrap 上**委托**，行节点只建一次，从零重挂监听。
 */

import { applyFaviconColor } from './faviconColor'
import { guardMiddleClickAutoscroll } from './middleClickGuard'
import { setDragItem, getDragItem, hasDragItem, pickDropEffect } from '@hira-ng/shared-types/src/drag-item.mjs'
import { createDragRegionSuppressor } from './dragRegion'
import { createHoverPreview } from './hoverPreview'
// 预览的载荷形状（锚点矩形 + 标签数据 + 外侧边界）——与横向列表共用同一份拼法。
import { tabPreviewFacts } from './tabPreviewFacts'
import { ChevronRight, ChevronDown, Folder, Plus, Search } from './icons'
// 分屏「连接判据」的共用件：合体行要的"哪几行连成一段"（与横向标签条用的是同一份，
// 本列表只交出"怎么摆"—— 纵向的"合体"就是把同一段的行并排塞进一个槽位）。
import { splitMarks, type SplitLinkRun } from './tab/splitLink'
// 分屏「回形针」的外观 / 显隐语义：与横向标签条共用的那份，本列表只负责摆放
//（摆在合体容器的接缝正中，见 injectTabRowStyles 的 .tabrow-pair 一族）。
import { createSplitClip, injectSplitClipStyles } from './tab/splitClip'
// 标签组「成员标记」的判据（可见组 / 成员归属）：
// 与横向标签条（.in-tab-stack）**共用同一份**，本列表只负责写 data-stack-indent 与摆连线条。
import { stackMarks } from './tab/stackMarks'
// 标签组「连线条」的绘制层：一组一条连续竖线，画在成员让出的左侧槽里
//（与横向标签条的下划线层 stackLineLayer 同一范式：真实矩形 + 有界逐帧跟踪）。
import { createStackRailLayer } from './tab/stackRailLayer'
// 标签组的**菜单模板与动作分派**：与横向标签条芯片（ui-tabbar/components/TabStack.js）
// 共用同一份。本列表只保留"重命名要在这一行上开输入框"这一件 DOM 事。
import { createStackChipMenu, runStackMenuAction, STACK_MENU_RENAME } from './tab/chipMenu'
import type { StackMenuHandlers, StackMenuSibling } from './tab/chipMenu'
// 标签组显示名（固定分组兜底「固定标签」）—— 与横向芯片共用同一份规则，不在两端各写一遍。
import { stackDisplayLabel, canDropOnItem, isPinnedItem } from './tabStackActions'
// 「一张标签脸」的三件（图标位/无痕/首字兜底、音频按钮、渲染规则）：与横向标签条共用同一份。
import { renderAudioState, createTabFavicon, createTabAudioButton } from './tab/iconArea'
// 标题区与关闭按钮同样取共用件（横竖同一份实现，本列表只交出类名与意图）。
import { createTabTitleArea } from './tab/titleArea'
import { createTabCloseButton } from './tab/closeButton'
// 权限请求标记：图标 / 显隐 / 点击止步都与横向标签条同一份，本列表只交出类名与意图。
import { createTabPermissionMark } from './tab/permissionMark'
// 行内重命名的机制（换输入框 / Enter·Esc·失焦收尾 / 换回原节点）也与横向共用同一份。
import { createRenameSlot } from './tab/renameSlot'
// 单击/双击的计时判据：同样与横向标签条共用（横向整条挂手势，纵向委托在容器上）。
import { noteTabPrimaryClick, isFastDoubleClick, isSplitModifier, createDragHintWatch } from './tab/gestures'
import { onTransitionEndOnce } from './transitions'
import { capturePositions, playSlide } from './flip'
// 共享帧泵 + 几何过渡中继：所有「装饰绘制层」共用一条 rAF（见 tab/framePump.ts）。
import { createFramePump, relayGeometryMotion } from './tab/framePump'
// 落点几何（中点判定 / 首尾外推 / 指示线贴边）——与横向标签条**共用**一份，本列表只交出轴。
import { axisAdapter } from './axisAdapter'
import type {
  TabRowExternalDragItem,
  TabRowId,
  TabRowItem,
  TabRowListController,
  TabRowListOptions,
  TabRowStack,
  TabRowTab
} from './tabRowTypes'

export type * from './tabRowTypes'

/** 本列表是**纵排**：几何只差"取哪个轴"，规则本身与横排同一份实现。 */
const geo = axisAdapter('column')

const STYLE_ID = 'ui-common-tabrow-styles'

interface SplitSlot {
  headKey: string
  keys: string[]
}

interface PairRecord {
  el: HTMLDivElement
  clips: HTMLElement[]
}

interface TabRowParts {
  row: HTMLDivElement
  fav: ReturnType<typeof createTabFavicon>
  favicon: HTMLImageElement | null
  titleArea: ReturnType<typeof createTabTitleArea>
  audioBtn: HTMLButtonElement
  permissionMark: ReturnType<typeof createTabPermissionMark>
}

interface StackRowParts {
  row: HTMLDivElement
  arrow: HTMLSpanElement
  pin: HTMLSpanElement
  label: HTMLSpanElement
  count: HTMLSpanElement
  kind: 'stack'
}

interface TabRowRecord {
  kind: 'tab'
  parts: TabRowParts
  node: HTMLDivElement
  item: TabRowItem | null
}

interface StackRowRecord {
  kind: 'stack'
  parts: StackRowParts
  node: HTMLDivElement
  item: TabRowItem | null
}

type RowRecord = TabRowRecord | StackRowRecord

type RowDropDecision =
  | { kind: 'reject' }
  | { kind: 'blank'; self: boolean }
  | {
      kind: 'stack'
      row: HTMLElement
      stackId: string
      stackPinned: boolean
      targetTabId?: undefined
      draggedStackId?: undefined
    }
  | {
      kind: 'stack'
      row: HTMLElement
      targetTabId: string
      draggedStackId: string | null
      stackId?: undefined
      stackPinned?: undefined
    }
  | {
      kind: 'move'
      targetId: string
      insertAfter: boolean
      rect: { top: number; bottom: number; left: number; right: number; width: number; height: number }
      leaveStack: boolean
    }

/**
 * 搜索框的**去抖窗口（ms）**：逐键过滤的「跟手 / 不抖」平衡点。
 *
 * 导出而不是内联：「总览」浮层的搜索框（renderer/overview-overlay/view.js）与本列表的搜索框
 * 必须**同一档**——它们共享同一条「输入 → 过滤 → 行进出场动效」链路，
 * 两处各写一个数，迟早一处改了另一处没改，观感就分叉了。
 */
export const ROW_SEARCH_DEBOUNCE_MS = 120

// 单击 / 双击（够不够快）的**计时判据**不在这里：横竖两种模式共用同一份，见
// ./tab/gestures.ts 的 noteTabPrimaryClick() / isFastDoubleClick()（那里的文件头写了
// 为什么这份状态必须是模块级而不是建行的闭包）。

/**
 * 注入标签行列表样式（幂等）。两个面板调用的是同一份样式，视觉不可能分叉。
 * 注意：这是**叠加**在 injectPanelStyles 之上的行样式，调用方仍需先注入面板基底样式。
 * @param {Document} doc
 */
export function injectTabRowStyles(doc: Document): void {
  // 回形针的**外观与显隐语义**归共用件（与横向标签条同一份）——本列表只写"摆在哪"
  //（摆在合体容器的接缝正中，见下面 .tabrow-pair 一族）。
  injectSplitClipStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .tabrow-wrap {
      display: flex; flex-direction: column; min-height: 100%; position: relative;
      /* ── 「指示条槽」的唯一口径（favicon 色条 / 标签组连线条共用）─────────────
         两条线必须是**同一根轴**上的同一种东西：抠掉"行内 1px、组线 4px"这类
         各写各的偏移，否则同一列里两条竖线错开几像素，看过去就是没对齐。
         值相对**内容左缘**量（行首 / wrap 的 padding box 由各自的内边距决定），
         绘制层（tab/stackRailLayer.ts）也读这同一个变量 —— 改这里，两处一起动。 */
      --tabrow-rail-inset: 2px;
      --tabrow-rail-width: 3px;
      /* 行自己的透明占位边框（见 .tabrow-row）。favicon 色条是**行内**绝对定位，
         坐标基准是行的 padding box —— 行边框那 1px 落在它外面，绘制层必须补上，
         两条线才是真正的同一 x（否则永远差 1px，肉眼恰好看得出"没对齐"）。
         行改成了**零描边**（扁平化），于是补正值同步归零。 */
      --tabrow-rail-frame: 0px;
    }
    /* ── 搜索形态的骨架（仅 searchable 的宿主）─────────────────────────────────
       shell = [搜索条（固定）] + [滚动视口 [wrap]]。

       为什么搜索条必须待在滚动视口**之外**：旧形态是"wrap 里 sticky + 通栏渐变遮罩"，
       带来两个无法在遮罩层里修掉的缺陷 ——
         · 聚焦环画在输入框外侧 2px，而输入框贴满了滚动视口，环的上/左/右被裁掉，
           只剩一个残缺矩形（面板打开即聚焦搜索框，所以每次都能看见）；
         · 遮罩铺的是 --hira-panel-bg，而它本身可能是半透明的（面板遮罩不透明度 < 100%
           时）—— 在 #root 已经铺过一层之后再叠一层，就是那块更实的"矩形色带"。
       现在搜索条在滚动视口外：行从下面滚过时不会穿过它（不需要任何遮罩），
       它自己也永远不被滚动容器裁切。

       ⚠ wrap 必须是滚动视口的**直接子元素**：预览按 wrap.parentElement 取滚动容器
       （见 present()），中间再插一层会把它指到错误的元素上。 */
    .tabrow-shell {
      display: flex; flex-direction: column;
      flex: 1 1 auto; height: 100%; min-height: 0;
    }
    .tabrow-scroll {
      flex: 1 1 auto; min-height: 0;
      overflow-y: auto; overscroll-behavior: contain;
    }
    .tabrow-search {
      flex: 0 0 auto;
      /* 上/左/右各让 2px = 聚焦环的厚度（--hira-focus-ring 向外扩 2px）：
         环必须落在父级视口内，否则又会被切掉三边。下边 8px 是与首行的呼吸。 */
      padding: 2px 2px 8px;
    }
    /* 字段外观走面板原子层的同一套语言：软底 + 零描边，聚焦只加一圈环。
       高度 / 圆角 / 过渡全部消费 --hira-* 令牌，不再自带字面量。 */
    .tabrow-search__box {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: none;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .tabrow-search__box:focus-within {
      background: var(--hira-field-bg-focus, rgba(0,0,0,0.05));
      box-shadow: var(--hira-focus-ring);
    }
    .tabrow-search__icon {
      flex-shrink: 0;
      display: flex; align-items: center;
      color: var(--hira-text-tertiary, #9ca3af);
    }
    .tabrow-search__input {
      flex: 1; min-width: 0; width: 100%; box-sizing: border-box;
      padding: 0; font-size: 12px; font-family: inherit;
      border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a);
    }
    .tabrow-search__input::placeholder { color: var(--hira-text-tertiary, #9ca3af); }
    .tabrow-empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #9ca3af); font-size: 12px; line-height: 19px;
    }
    .tabrow-row {
      display: flex; align-items: center; gap: var(--ng-tab-gap, 8px);
      /* 行几何与横向 tabbar **逐项同源**（--ng-tab-*）：同一个标签在横排 / 纵排里
         同高、同圆角、同一档行距。这里不许自留一套「纵向更宽松」的字面量 ——
         34px 行高 + 6px 纵向内距 + 逐行外边距叠出来就是"又胖又厚"。
         左内边距比右大：左侧留出「指示条槽」—— 色条画在槽里（见下），
         favicon 从槽右缘再往内一格。此前左边只有 8px，色条几乎贴着图标
         （用户原话"贴太紧"）：两条 3px 的线叠在一起看，先分不清谁是图标的一部分。 */
      height: var(--ng-tab-height, 32px);
      min-height: var(--ng-tab-height, 32px);
      padding: 0 8px 0 14px;
      border-radius: var(--ng-tab-radius, 9px);
      /* 不描边：层级只由 hover / 选中的软底表达（见下面的两档状态） */
      border: 0;
      cursor: pointer;
      /* 未选中项的 favicon 色指示线是绝对定位的，需要本行作为定位上下文 */
      position: relative;
      /* 与 tabbar 同一组动效 token（见 tokens-base 的 --ng-anim-*）：
         hover / 选中是即时反馈用 fast，行高变化（开合）用 base */
      transition:
        background var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
        /* transform 供拖拽重排的「滑动让位」用（FLIP，见 flip.ts）：
           没有它，重排是瞬时位移；有了它，下面的行是滑上去让位的。 */
        transform var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease);
      contain: layout style paint;
      -webkit-user-drag: element;
    }
    /*
     * ── 跟随 favicon 取色（学 Hira railModule.css 的视觉）────────────────────────
     * 选中行：整块底色 = favicon 主色 + 对比色文字（inline style，见 faviconColor.ts）。
     * 未选中行：左侧一条 2px 该色竖线 —— 纵向列表里"底部横线"没有意义，竖线才对位。
     * 「一切无视深色模式压暗」：这里没有任何 body.dark 覆盖，深浅色用同一份色值。
     */
    .tabrow-row.has-favicon-color:not(.tabrow-row--active)::after {
      content: '';
      position: absolute;
      /* 与标签组连线条**同一根轴**（--tabrow-rail-inset / --tabrow-rail-width
         由 .tabrow-wrap 声明，绘制层也读同一组变量）—— 于是"标签自己的色条"
         与"组的色条"永远落在同一条竖线上，不再各偏几像素。 */
      left: var(--tabrow-rail-inset, 4px);
      top: 5px;
      bottom: 5px;
      width: var(--tabrow-rail-width, 3px);
      border-radius: 999px;
      background: var(--favicon-tab-color, rgba(148, 163, 184, 0.3));
      opacity: 0.55;
    }
    /* 分屏合体行不画 favicon 色条：半宽行里没有"指示条槽"（padding 只有 5px），
       硬画就压在图标上；且并排两半各一条竖线，视觉上像是在给分屏划线。 */
    .tabrow-pair > .tabrow-row::after { display: none; }
    /* 组内成员行**照常画自己的色条**：组线在缩进槽里、成员行从槽右缘才开始，
       两者天然错开（组线约 x=3，成员行色条约 x=11 起），不再重叠。
       组行（组头）没有 has-favicon-color，自然不画。 */
    /*
     * 行「打开 / 关闭」动效。
     * 两件事走两条路（横向标签条也是这两条，只是轴不同）：
     *   · **打开** —— 关键帧（见下面的 @keyframes tabrow-row-enter）：
     *     节点凭空出现、没有"上一帧高度"可插值，所以必须自己播动画；
     *     这里**不量高**：节点可能刚入 DOM、宿主还没把它画出来（量到 0），
     *     旧实现量到 0 就直接 return，于是"新建标签没有创建动画"。
     *   · **关闭** —— 经典两段式（结束高度是 auto，关键帧做不到）：
     *     JS 量出自然高度 h → 把 height 钉成 h → 下一帧钉成 0，由 transition 插值。
     * 行高逐帧变化 → 下面的行逐帧上移，"关掉一个、下面的滑上来"是连续的。
     * 关闭期间行仍留在流里（只是塌到 0），所以不会出现瞬移。
     */
    .tabrow-row--animating {
      overflow: hidden;
      /* 高度要能真的塌到 0：flex 项的 automatic minimum size（min-height:auto）会顶住，
         只有 overflow 非 visible 时它才归零 —— 这里显式写上，不依赖那条隐式规则。 */
      min-height: 0;
      transition:
        height var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease),
        opacity var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    /*
     * 入场 / 退场动画期间把**竖向的 padding / border / margin 一起清零**。
     *
     * 这是「关中间标签时动画播完会卡一下再补空隙」的根因修复：只把 content 高度动到 0 的话，
     * 动画结束时行仍占着 8px padding + 2px border + 2px margin，节点一被移除，
     * 那截空隙"啪"地跳掉 —— 视感就是动画播完后卡顿一下。
     * 配合 JS 把钉住的高度取成**外框高度**（见 outerHeightOf），这样：
     *   动画起点 = 原来的整块占位（相邻行不动），终点 = 0（移除时零跳变）。
     * 横向的 padding / border 一律不动，避免左右抖动。
     */
    .tabrow-row--box-collapsed {
      padding-top: 0; padding-bottom: 0;
      border-top-width: 0; border-bottom-width: 0;
      margin-top: 0; margin-bottom: 0;
    }
    /*
     * ── 新建行的入场动效（与横向标签条的 ng-tab-enter 同一条思路，轴从"宽"换成"高"）──
     * 只写 from、不写 to：结束值取元素自己的计算值 —— 于是普通行、折叠成图标条的行、
     * 分屏半宽行都自动收到各自的高度，不需要为每种形态各写一条关键帧。
     * 类名由 renderer 在节点真正入 DOM 之后挂上（见 animateRowEnter）。
     *
     * 为什么不沿用关闭那套「量高再钉半段」：入场时节点往往**刚创建**，宿主可能还没
     * 把它画出来（甚至还没挂进文档）——量到的高度是 0，旧实现直接 return，
     * 于是"创建了但没有动画"。关键帧不依赖任何测量：只要它真的被画出来，
     * 就从 0 长到自己的高。这也正是用户报的"垂直标签没有创建动画"的修法。
     */
    @keyframes tabrow-row-enter {
      from {
        height: 0; min-height: 0;
        opacity: 0;
      }
    }
    .tabrow-row--entering {
      /* 高度塌到 0 期间把内容裁掉（行内容比 0 高时不能溢出来叠到下一行上）。 */
      overflow: hidden;
      animation: tabrow-row-enter var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease);
    }
    /* 动效降级：系统要求减少动效时不播（与面板 / 侧栏其它动效同一口径）。 */
    @media (prefers-reduced-motion: reduce) {
      .tabrow-row--entering { animation: none; }
    }
    /* 已开始消失的行：不再接受任何鼠标/拖拽命中（它的身份标识也已摘掉） */
    .tabrow-row--closing { pointer-events: none; }
    /* 非当前选中项 hover：与 tabbar 的 hover 同一组 token（深色下自动转浅） */
    .tabrow-row:hover:not(.tabrow-row--active) {
      background: var(--ui-hover, var(--hira-hover-bg, rgba(0,0,0,0.06)));
    }
    /* 当前选中 tab：**与横向 tabbar 的「.tab-item.active」共用同一组令牌**
       （--ng-tab-active-bg / -fg / -border-color，见 tokens-base 的说明）——
       纵向列表、打开标签面板、固定标签面板里的"我在哪儿"与标签条上是同一块底色，
       不再各写一套 accent 软底。
       行仍是零描边几何（上一轮回滚的口径）：轮廓用 inset 阴影画，
       视觉等于 tabbar 的 1px 描边，但不吃布局、不改行高。
       有 favicon 取色时底色由 inline style 接管，不加环（tabbar 那边描边也跟着取色）。 */
    .tabrow-row--active {
      background: var(--ng-tab-active-bg, var(--bg-color, #fff));
      color: var(--ng-tab-active-fg, var(--hira-accent, #3b82f6));
    }
    .tabrow-row--active:not(.has-favicon-color) {
      box-shadow: inset 0 0 0 1px var(--ng-tab-active-border-color, rgba(100, 116, 139, 0.32));
    }
    .tabrow-row--active .tabrow-label { color: var(--ng-tab-active-fg, var(--hira-accent, #3b82f6)); }

    /* ── 分屏「合体」（纵向列表）──────────────────────────────────────────────
       口径与横向标签条**完全一致**：同一段分屏的几行并排贴在一起，行间无缝隙、
       内缘无圆角无边框、只有整段的外缘收圆 —— 看过去就是"一坨"，而不是
       一条带子 + 几个各自独立的行（旧版的左侧连接带与回形针左缘定位已整层删除）。

       为什么要有这层容器（而不是直接在 wrap 里做 flex-wrap）：wrap 是**纵向列**，
       底部「新建标签页」靠 margin-top: auto 吸底、并 sticky 在滚动容器底；一改方向
       这两件都不成立了。所以一段合体 = wrap 里的**一个排版槽位**（一个直接子节点），
       成员行并排塞进它 —— 槽位模型让顺序 / FLIP / 插入锚点照旧按"槽根"算。

       宽度口径（用户）：两个合起来的宽度 = **一条正常行宽**，不作任何放大；
       所以这里不引用 --ng-tab-split-scale（那是横向标签条的事），只按 N 等分。

       回形针也搬到了本容器上：行带 contain: layout style paint，钉在行内的绝对定位
       子元素会被裁掉，而容器没有裁剪 —— 这是"挂在接缝正中"能成立的前提。 */
    .tabrow-pair {
      display: flex; align-items: stretch;
      position: relative;
      margin: 0;
      min-width: 0;
    }
    .tabrow-pair > .tabrow-row {
      flex: 1 1 0; min-width: 0;
      /* 合体槽位与单行同占一格高度：行距由 wrap 的排版决定，容器不再自加一条缝 */
      margin: 0;
      /* 内半收紧：半宽里要塞下 favicon + 标题 + 按钮，按整行口径的 padding/gap 会太挤 */
      padding: 0 5px; gap: 3px;
      border-radius: 0;
    }
    /* 内缘：不留圆角、不画边框（画了就是"两行之间那道线"，与合体相悖）。
       用 :not(:first-of-type) / :not(:last-of-type) 只收内缘，外缘保持 8px。 */
    .tabrow-pair > .tabrow-row:not(:first-of-type) {
      border-top-left-radius: 0; border-bottom-left-radius: 0;
      border-left-width: 0;
    }
    .tabrow-pair > .tabrow-row:not(:last-of-type) {
      border-top-right-radius: 0; border-bottom-right-radius: 0;
      border-right-width: 0;
    }
    .tabrow-pair > .tabrow-row:first-of-type {
      border-top-left-radius: var(--ng-tab-radius, 9px);
      border-bottom-left-radius: var(--ng-tab-radius, 9px);
    }
    .tabrow-pair > .tabrow-row:last-of-type {
      border-top-right-radius: var(--ng-tab-radius, 9px);
      border-bottom-right-radius: var(--ng-tab-radius, 9px);
    }
    /* 回形针：外观 / 显隐归共用件，这里只写"摆在接缝正中"（left 由 JS 按 k / N 写百分比）。
       上下居中 = 两半行的垂直中线；左右居中 = 那道接缝。指针穿透，不吃点击。 */
    .tabrow-pair > .tabrow-clip {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: var(--ng-tab-active-bg, var(--hira-bg-elevated, #ffffff));
      pointer-events: none;
    }

    /* 拖拽期的能力提示（"松手在网页区域可分屏"）——与横向标签条**同一措辞、同一观察器**
       （见 tab/gestures.ts#createDragHintWatch）。用 viewport 坐标（position: fixed）定位，
       因此不依赖列表根是不是定位上下文；pointer-events: none 是硬要求（绝不能吃掉指针）。 */
    .tabrow-drag-hint {
      position: fixed;
      /* 提示气泡：语义层 tooltip（原值 60）。 */
      z-index: var(--hira-z-tooltip);
      pointer-events: none;
      padding: 2px 8px;
      border-radius: var(--hira-radius-xs, 6px);
      font-size: 11px;
      line-height: 16px;
      white-space: nowrap;
      max-width: calc(100vw - 16px);
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-color, inherit);
      background: var(--hira-surface, #fff);
      border: 0;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
      opacity: 0.95;
    }
    .tabrow-label {
      flex: 1; min-width: 0; text-align: left;
      border: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a);
      cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; padding: 0;
    }
    /*
     * 标题区改由**共用件**造（容器 div + 内层 .title span，见 ui-common 的 tab/titleArea.ts），
     * 不再是 button —— 面板基底里那条全局 button:hover/active 底色自然管不到它，
     * 原先为压掉「两层 hover 底色叠加」而写的 .tabrow-label:hover 规则随之删除（不再需要）。
     * 省略号仍出在**容器**上（overflow/text-overflow/white-space 见上一条规则）；
     * 内层 span 是行内元素，不额外写一份 —— 这正是横竖两种模式共用的那条口径。
     */
    .tabrow-btn {
      width: 20px; height: 20px;
      border: none; background: transparent;
      color: var(--hira-text-secondary, #6b7280);
      cursor: pointer;
      border-radius: var(--hira-radius-xs, 6px); font-size: 12px;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .tabrow-btn:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.08)); }
    .tabrow-btn svg { display: block; }
    .tabrow-btn--audio { padding: 0; line-height: 1; }
    .tabrow-btn[hidden] { display: none !important; }
    /*
     * 音频按钮「冒出来」：静音/播放状态切换时它可能首次出现。
     * hidden 属性切的是 display，没法过渡，所以用一次性关键帧做入场。
     */
    @keyframes tabrow-pop {
      from { transform: scale(0.5); opacity: 0; }
    }
    .tabrow-btn--pop { animation: tabrow-pop var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease); }

    /* 拖拽插入指示线（用 opacity 显隐 → 出现/消失能淡入淡出，display 切换是硬切） */
    .tabrow-drop {
      position: absolute; left: 6px; right: 6px; height: 2px;
      background: var(--hira-accent, #3b82f6);
      z-index: var(--hira-z-elevated); /* 拖拽落点指示线 = elevated */
      pointer-events: none;
      opacity: 0;
      transition: opacity var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    .tabrow-drop--show { opacity: 1; }

    /* ── 标签组行（纵向列表里的"芯片"）───────────────────────────────────────
       与 tabbar 的 .tab-stack-chip 同义，只是排版随纵向列表走：折叠箭头 + 名称 +
       成员数横排。展开时组行**和它的成员一起缩进**，让出的左侧槽由连线条贯穿 ——
       组项与标签因此是同一根脊，不再有"组行自己一条短色条"（已删除）。 */
    .tabrow-row--stack {
      background: color-mix(in srgb, var(--tab-stack-accent, var(--hira-accent, #1a73e8)) 10%, transparent);
      cursor: pointer;
      -webkit-user-drag: none;
    }
    .tabrow-stack-arrow { display: inline-flex; align-items: center; flex-shrink: 0; opacity: 0.75; }
    /* 固定文件夹（Zen Essentials）：与 tabbar 芯片**同一套辨识语言** ——
       ① 展开/收起仍是整行，靠 Folder 图标辨识文件夹身份（不用色条）；
       ② 底色/描边更实、左上角收成小直角（文件夹轮廓，见 tabbar 的同名规则）。 */
    .tabrow-stack-pin { display: none; align-items: center; flex-shrink: 0; opacity: 0.9; }
    .tabrow-row--stack[data-stack-pinned] .tabrow-stack-pin { display: inline-flex; }
    .tabrow-row--stack[data-stack-pinned] { border-radius: var(--hira-radius-xs, 6px) var(--ng-tab-radius, 9px) var(--ng-tab-radius, 9px) var(--ng-tab-radius, 9px); }
    .tabrow-row--stack[data-stack-pinned] {
      background: var(--hira-accent-soft, rgba(59,130,246,0.14));
    }
    .tabrow-row--stack[data-stack-pinned] .tabrow-stack-pin { color: var(--hira-accent, #3b82f6); }
    .tabrow-stack-count {
      flex-shrink: 0; min-width: 16px; text-align: center;
      padding: 0 5px; border-radius: 999px;
      background: var(--ui-hover, rgba(0, 0, 0, 0.08));
      color: var(--hira-text-secondary, #6b7280);
      font-size: 11px; line-height: 16px;
    }
    /* 「堆叠落点」高亮：与 tabbar 同一套反馈（整行描边，区别于插入细线） */
    .tabrow-row.tabrow-row--stack-target {
      outline: 2px solid var(--hira-accent, #0a84ff);
      outline-offset: -2px;
    }

    /* ── 标签组「连线条」+ 组/成员缩进（纵向列表，Edge 口径）───────────────────
       展开时**组行与它的成员**（连同成员所在的合体容器）一起向右让出一条槽；
       连线条就画在这条槽里，由独立绘制层（tab/stackRailLayer.ts）按真实矩形
       **一组画一条** —— 从组行顶端一直连到最后一个成员的下沿，两端收圆。
       于是"组项"和"它的标签"是同一根脊：原先组行内部那条 3×16 的短色条已删除。

       为什么让槽而不是贴面板外缘：线必须与它连的那些行**挨着看**（Edge 就是这样），
       贴到面板最外缘的旧竖条隔着整条内容内边距，既远又断。槽在行的左侧，
       与面板挂左 / 挂右无关 —— 换边镜像从此不需要。
       缩进写在**槽根**上：合体容器是一整个排版槽位，成员行跟着它一起让。
       收起态（组行后面没有成员）不缩进、也不画线 —— 那只是一只普通行。 */
    .tabrow-row[data-stack-indent],
    .tabrow-pair[data-stack-indent] {
      /* 缩进 8px（原 14）：成员行只需让出**连线条那一格**，不必把图标再往里推一大截 ——
         14px 在窄侧栏里看起来"陷进去"（用户原话"缩进不要这么厉害"）。
         线的 x 是内容左缘 + inset + frame ≈ 3px，8px 的槽足够把它与成员行分开。 */
      margin-left: var(--tabrow-stack-gutter, 8px);
    }
    .tabrow-stack-rails {
      position: absolute; inset: 0;
      /* 行与合体容器都是定位元素，且本层先于行入 DOM —— 不给层级就会被后插入的行盖住。
         抬到 elevated（仍低于 sticky 浮钮的 controls）后，圆头端点压在行沿上也不会被吃掉。 */
      z-index: var(--hira-z-elevated, 10);
      pointer-events: none;
    }
    .tabrow-stack-rail {
      position: absolute;
      /* 线的 x 必须跟着**内容左缘**走：本层定位基准是 wrap 的内边距盒，而正常行从内容
         左缘排起。垂直侧栏的 wrap 有 6px 内边距（面板没有）—— 绘制层按实测值把 x 写在
         本层的 --tabrow-stack-rail-x 上，宿主不必再各记一组数，两个宿主才会长得一样。 */
      left: var(--tabrow-stack-rail-x, 4px);
      /* 与 favicon 色条同宽（同一个变量）—— 两条竖线的粗细也必须一致。 */
      width: var(--tabrow-rail-width, 3px);
      border-radius: 999px;
      background: var(--tab-stack-accent, var(--hira-accent, #1a73e8));
      opacity: 0.9;
    }

    /* 底部常驻的「新建标签页」─────────────────────────────────────────────────
       为什么用 sticky 而不是 fixed：面板内容区带「contain: paint」，它会让
       「position: fixed」的包含块变成该元素本身 —— fixed 会跟着列表一起滚走，
       反而"不常驻"。sticky 相对滚动容器（.panel-content / .vtabs__body）钉在底部，
       且**留在流里**（不会盖住最后一行），短列表时由前面的 .tabrow-add-gap 把它顶到面板底部。

       ⚠ 底色必须是**不透明**的：它在滚动中会压在行上，半透明的软底会让行从底下透出来
       （用户口径：新建按钮要不透明）。hover 只换图标色 + 加深投影，绝不换成半透明底
       —— 否则"不透明"只在不 hover 时成立。 */
    .tabrow-add-gap {
      /* 「最后一行的呼吸」：内容超出视口时 flex-grow 无处可去，只剩最小 10px；
         内容不足一屏时它吃掉所有剩余空间，把按钮顶到列表底部（替代原来的 margin-top:auto）。
         于是**滚到最底部时按钮上方永远有条缝**，不会贴着最后一行。 */
      flex: 1 0 10px;
      min-height: 10px;
    }
    .tabrow-add {
      position: sticky; bottom: 0;
      /* 常驻浮钮必须**压在行之上**（它是"始终可交互的控件"）：合体容器与行的
         层叠上下文都可能高于普通行，不长到控制层就会在滚到它下面时被盖住。 */
      z-index: var(--hira-z-controls);
      margin-bottom: 8px;
      display: flex; align-items: center; justify-content: center;
      height: var(--ng-tab-height, 32px); padding: 0; flex-shrink: 0;
      /* 无描边：实底自成一格，hover 只换字色与投影（"边框变蓝"那套工程感已去掉）。 */
      border: 0;
      border-radius: var(--ng-tab-radius, 9px);
      background: var(--hira-surface, #ffffff);
      color: var(--hira-text-secondary, #6b7280);
      /* 实底与行同色系时靠一层很淡的投影分界（离开行不靠描边）。 */
      box-shadow: 0 1px 3px var(--tab-label-box-shadow-color, rgba(0, 0, 0, 0.1));
      cursor: pointer; -webkit-app-region: no-drag;
      transition:
        color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
        box-shadow var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    /* hover：**保持同一个不透明底**，只把图标提到强调色、投影加深一档。 */
    .tabrow-add:hover {
      color: var(--hira-accent, #3b82f6);
      box-shadow: 0 2px 8px var(--tab-label-box-shadow-color, rgba(0, 0, 0, 0.12));
    }

    /*
     * hover 预览**不在这里画**：面板是独立 WebContentsView，面板内的 DOM 浮层一超出
     * 面板边界就被原生裁掉，而预览恰恰要落在面板外侧（靠左时贴右缘、靠右时贴左缘，
     * 见 LayoutCoordinator#anchorFloatBesidePanel）。所以预览统一走 tabpreview-overlay
     * 这条独立浮层通道，由编排层经 ctx.overlay 注入，本组件只回答「鼠标停在哪个标签上」。
     */
  `
  doc.head.appendChild(style)
}

/**
 * 创建一个与宿主解耦的纵向标签列表。
 * 数据由 `setItems` 推入，交互全部通过 `TabRowListOptions` 的端口上抛。
 */
export function createTabRowList(
  doc: Document,
  ctx: TabRowListOptions = {}
): TabRowListController {
  const view = doc.defaultView as Window & typeof globalThis
  if (!view) throw new Error('createTabRowList requires a live document')
  const onIntent = ctx.onIntent || (() => {})
  const showMenu = ctx.showMenu || (() => Promise.resolve(null))
  const onDragEnd = ctx.onDragEnd || (() => {})
  const overlay = ctx.overlay || null
  const filter = typeof ctx.filter === 'function' ? ctx.filter : null
  const dragKind = String(ctx.dragKind || 'tabrow')
  const motionEnabled = ctx.motion !== false
  /** 空态文案：允许传函数 —— 搜索无结果时的措辞与"一个标签都没有"必须不同。 */
  const emptyTextOf = (): string => {
    const text = ctx.emptyText
    return typeof text === 'function' ? text() : text || ''
  }
  const onSearch = typeof ctx.onSearch === 'function' ? ctx.onSearch : null
  /**
   * 外部拖入的出口（统一协议 `drag-item`，见 shared-types）：
   * 只交「拖进来的是什么 + 落在哪一行」，具体动作（新开标签 / 建组 …）由宿主决定。
   */
  const onExternalDrop = typeof ctx.onExternalDrop === 'function' ? ctx.onExternalDrop : null
  // 标签组行自己的菜单是**通用弹层**（不是标签行菜单）：这里用的是原始
  // menuClient，而不是上面那个 `showMenu`（后者已经绑定了标签行的固定菜单项）。
  const menuClient = ctx.menu || null
  /** 标签组行的改名（展开/收起走 onIntent 的 `toggle-stack`）—— 其余四个走 stackMenu 整包。 */
  const onRenameStack = ctx.onRenameStack || (() => {})
  /**
   * 标签组的四个动作**整包**（解散 / 平铺成分屏 / 合并 / 配色）—— 由宿主注入
   * （apps 侧 `createStackMenuHandlers(tabsClient)`），与横向标签条芯片取的是**同一份**。
   * 本列表不再逐项读 ctx：逐项读就会与横向各写一份动作表，改一处漏一处。
   */
  const stackMenuHandlers = ctx.stackMenu || {}
  /** 「拖到网页区域 = 分屏」的出口：只报落点（本视口坐标），判定在主进程。 */
  const onDropOnContent = typeof ctx.onDropOnContent === 'function' ? ctx.onDropOnContent : null
  /**
   * 同一条链的**开始**那半（拖动一开始就报）。与横向标签条**同一个端口、同一语义**：
   * 主进程据此起 30fps 光标采样，拖动期间把"这一格会落在哪"推给落位预览浮层 ——
   * 拖动期间渲染层收不到指针事件（指针一进网页原生视图就离开本视口），只有主进程能算。
   */
  const onDropOnContentBegin = typeof ctx.onDropOnContentBegin === 'function' ? ctx.onDropOnContentBegin : null
  /**
   * 同一条链的**收尾兜底**：dragend 里没有"落在网页上"的落点时也要报一次 ——
   * 主进程据此归档整场拖动（停表 + 收落位框 + 解除侧栏唤出冻结）。
   *
   * 为什么不能省：`dropTabOnContent` 只在"可能落在网页上"时才发，而在**本列表里松手**
   * （排序 / 成组，最常见的拖动）根本不会发 —— 主进程那条采样表与"拖动期保持侧栏展开"
   * 就永远留着（用户报的"分屏黏住 / 侧栏收不回去"）。
   */
  const onDropOnContentCancel = typeof ctx.onDropOnContentCancel === 'function' ? ctx.onDropOnContentCancel : null

  const wrap = doc.createElement('div')
  wrap.className = 'tabrow-wrap'
  /**
   * 对外挂载的节点：默认就是 wrap；`searchable` 时外面再套一层
   * 「固定搜索条 + 滚动视口」（见 injectTabRowStyles 的 .tabrow-shell）。
   * 无论哪种形态，wrap 都仍是**滚动容器的直接子元素**（预览几何依赖这一点）。
   * @type {HTMLDivElement}
   */
  let element: HTMLDivElement = wrap

  // ── 拖拽期的能力提示（与横向标签条同一份观察器、同一措辞）─────────────────
  // 纵向列表是"拖到网页区域"最自然的地方（侧栏就贴着网页），所以这里也必须提示；
  // 提示是**能力提示**（"可以"）而不是状态指示 —— 外壳收不到"指针是否压在网页上"的事件。
  const dragHint = doc.createElement('div')
  dragHint.className = 'tabrow-drag-hint'
  dragHint.textContent = '松手在网页区域可分屏'
  dragHint.style.display = 'none'
  wrap.appendChild(dragHint)

  function setDragHint(active: boolean): void {
    if (!active) {
      dragHint.style.display = 'none'
      return
    }
    const rect = wrap.getBoundingClientRect()
    dragHint.style.display = ''
    dragHint.style.left = `${Math.round(rect.left + 8)}px`
    dragHint.style.top = `${Math.round(Math.max(8, rect.bottom - 30))}px`
  }
  const hintWatch = createDragHintWatch(doc, setDragHint)

  // 拖拽插入指示线（垂直列表：显示在行上方/下方）
  const dropIndicator = doc.createElement('div')
  dropIndicator.className = 'tabrow-drop'
  wrap.appendChild(dropIndicator)

  /**
   * 搜索框（`searchable` 的宿主才建）。
   *
   * 位置：与滚动视口**并列**（见 injectTabRowStyles 的 .tabrow-shell）——
   * 输入框永远不会被行滚过，聚焦环也不会被滚动容器裁切。
   *
   * 这里只负责「输入 → 上抛查询串」（去抖 `ROW_SEARCH_DEBOUNCE_MS`）：**过滤不在这里** ——
   * 本组件是哑的，数据是宿主推进来的，由宿主按查询决定推哪一份。
   */
  let searchInput: HTMLInputElement | null = null
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  if (ctx.searchable === true) {
    const bar = doc.createElement('div')
    bar.className = 'tabrow-search'
    const box = doc.createElement('div')
    box.className = 'tabrow-search__box'
    const icon = doc.createElement('span')
    icon.className = 'tabrow-search__icon'
    icon.appendChild(Search(doc, { size: 15 }))
    const input = doc.createElement('input')
    searchInput = input
    input.type = 'text'
    input.className = 'tabrow-search__input'
    input.placeholder = '搜索标签…'
    input.spellcheck = false
    input.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        searchTimer = null
        if (onSearch) onSearch(input.value)
      }, ROW_SEARCH_DEBOUNCE_MS)
    })
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape' && input.value) {
        e.preventDefault()
        input.value = ''
        if (onSearch) onSearch('')
      }
    })
    // 输入框上的点击不该被列表当成"点空白"（拖拽收尾 / 取消选择之类）
    input.addEventListener('click', (e) => e.stopPropagation())
    box.append(icon, input)
    bar.appendChild(box)
    // 搜索条装在滚动视口**之外**（见 injectTabRowStyles 的 .tabrow-shell 说明）：
    const scroll = doc.createElement('div')
    scroll.className = 'tabrow-scroll'
    scroll.appendChild(wrap)
    element = doc.createElement('div')
    element.className = 'tabrow-shell'
    element.append(bar, scroll)
  }

  /**
   * 拖拽期「窗口拖拽区中和器」：让"拖过头一点"照常成立（见 dragRegion.ts）。
   * 本组件的落点语义**一条都不改** —— 只是把 `dragover` / `drop` 挂到 document 上，
   * 于是指针在任何位置（含列表外、含 app-region 区）都收得到，落点仍按 e.target 判。
   */
  const dragRegion = createDragRegionSuppressor(doc)

  /**
   * 底部悬浮的「新建标签页」—— 常驻显示，与 tabbar 的新建按钮同一套反馈
   * （Plus 图标 + hover 抬起 + 强调色），只是落点是面板底部。
   * 由 ctx.showAddButton 显式开启：不是每个列表都需要一个新建入口。
   */
  let addBtnEl: HTMLButtonElement | null = null
  /**
   * 按钮前面的「呼吸位」（见 .tabrow-add-gap）—— 同时也是行插入的锚点。
   * 必须是**独立节点**而不是按钮的 margin：auto 外边距在内容溢出时会变成 0，
   * 而这里要的正是"溢出时也留一条缝"（滚动到底部时按钮不贴住最后一行）。
   */
  let addGapEl: HTMLDivElement | null = null
  if (ctx.showAddButton === true) {
    const addBtn = doc.createElement('button')
    addBtn.className = 'tabrow-add'
    addBtn.type = 'button'
    // 用 aria-label 而不是 title：面板里不要 hover 冒出的原生提示条（见关闭按钮同款说明）
    addBtn.setAttribute('aria-label', '新建标签页')
    addBtn.appendChild(Plus(doc, { size: 16 }))
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      onIntent({ type: 'new-tab' })
    })
    addGapEl = doc.createElement('div')
    addGapEl.className = 'tabrow-add-gap'
    // 顺序即语义：…行 → 呼吸位 → 按钮。行一律插在**呼吸位之前**（见 setItems 的 ref）。
    wrap.appendChild(addGapEl)
    wrap.appendChild(addBtn)
    addBtnEl = addBtn
  }

  let emptyEl: HTMLDivElement | null = null
  let currentTabs: TabRowItem[] = []
  const rowRecords = new Map<string, RowRecord>()

  // ── 标签组「连线条」绘制层 ─────────────────────────────────────────────────
  // 独立层（自己的 DOM / 几何 / 有界逐帧跟踪）——列表只交出「按 key 拿行节点」。
  // 层挂在 wrap 里（wrap 已有 position: relative），随内容一起滚动。
  //
  // 帧泵由本列表持有并注入：一帧只跑一条 rAF（层内不再自建循环），且三类触发源
  // 汇到同一个 ping —— 渲染后的动效窗口、行高过渡（几何属性过滤）、容器尺寸变化。
  const pump = createFramePump(view, {
    durationMs: 300,
    alive: () => wrap.isConnected
  })
  const unstickMotion = motionEnabled
    ? relayGeometryMotion(wrap, (ms) => pump.ping(ms), { durationMs: 300 })
    : () => {}

  const stackRail = createStackRailLayer(doc, wrap, {
    getNode: (key) => {
      const rec = rowRecords.get(key)
      return rec ? rec.node : null
    },
    pump
  })
  wrap.appendChild(stackRail.element)

  /**
   * 容器尺寸变化（面板伸缩、窗口缩放、首次显示、侧栏↔面板换宽）→ 重画连线条。
   * 顺手作废几何口径缓存：线的 x 依赖 wrap 的实测内边距，容器换了它就可能变。
   * 没有标签组时层内 measure 直接早退，这条观察者也就只剩一次空帧。
   */
  const sizeWatch = typeof view.ResizeObserver === 'function'
    ? new view.ResizeObserver(() => {
      stackRail.invalidateMetrics()
      pump.ping(300)
    })
    : null
  if (sizeWatch) sizeWatch.observe(wrap)

  // ── 分屏「合体」容器 ───────────────────────────────────────────────────────
  /**
   * 一段连续的分屏链 = 一个 `.tabrow-pair`（wrap 的**一个直接子节点** = 一个排版槽位）。
   *
   * 为什么不把成员行直接摊在 wrap 里再用 flex-wrap：wrap 是纵向列，底部「新建标签页」
   * 靠 margin-top: auto 吸底 + sticky 钉在滚动容器底 —— 一旦改方向，这两件同时失效。
   * 槽位模型把"合体"整体收成一个排版单位，顺序 / FLIP / 插入锚点都按槽根算，
   * 行仍是增量复用与动效的单位，两层职责互不干扰。
   *
   * 容器由 `headKey`（该段第一行的复用键）标识：链内成员换了、只要链头没变就复用同一个
   * 容器（FLIP 与动效因此不会因为"重排列"而整块重建）。
   * @type {Map<string, { el: HTMLDivElement, clips: HTMLElement[] }>}
   */
  const pairEls: Map<string, { el: HTMLDivElement, clips: HTMLElement[] }> = new Map<string, PairRecord>()

  /**
   * 取（或建）一段合体的容器，并把它上面的回形针数量 / 位置对齐到这一段。
   *
   * 回形针挂在**容器**上而不是行内：行带 `contain: layout style paint`，钉在行内、
   * 跨越两行边界的绝对定位子元素会被裁掉一半（这是旧实现要靠 `--split-head` 抬层的
   * 病根）。容器没有裁剪，钉在接缝正中即可 —— 抬层那套因此整体删除。
   *
   * 回形针数量 = 成员数 - 1（每道接缝一枚）；位置 = k / N 的百分比，N 为成员数。
   * 换言之 3 分屏会自动得出两枚、落在 1/3 与 2/3 —— 与横向"一段可以不止两员"同构。
   * @param {{ headKey: string, keys: string[] }} slot
   * @returns {{ el: HTMLDivElement, clips: HTMLElement[] }}
   */
  function pairElFor(slot: SplitSlot): PairRecord {
    let rec = pairEls.get(slot.headKey)
    if (!rec) {
      const el = doc.createElement('div')
      el.className = 'tabrow-pair'
      // 调试 / 样式钩子用：容器本身不代表任何标签，不写 data-row。
      el.setAttribute('data-split-pair', '')
      rec = { el, clips: [] }
      pairEls.set(slot.headKey, rec)
    }
    const need = Math.max(0, slot.keys.length - 1)
    while (rec.clips.length < need) {
      const clip = createSplitClip(doc, { className: 'tabrow-clip', label: '与相邻标签分屏' })
      rec.el.appendChild(clip)
      rec.clips.push(clip)
    }
    while (rec.clips.length > need) {
      const dead = rec.clips.pop()
      if (dead) dead.remove()
    }
    for (let i = 0; i < rec.clips.length; i++) {
      rec.clips[i].style.left = `${(((i + 1) / slot.keys.length) * 100).toFixed(4)}%`
    }
    return rec
  }

  /**
   * 把投影切成**排版槽位**：一段连续分屏链合成一槽，其余每项各一槽。
   *
   * 判据完全来自 `splitMarks(...).runs`（与横向标签条同一份），本函数只回答
   * "怎么摆" —— 不在列表这一侧重推"谁和谁连"。
   */
  function buildSlots(list: readonly TabRowItem[], runs: readonly SplitLinkRun[]): SplitSlot[] {
    const runByHead = new Map<string, SplitLinkRun>()
    for (const run of runs) {
      if (run && run.keys && run.keys.length >= 2) runByHead.set(run.keys[0], run)
    }
    const slots: SplitSlot[] = []
    for (let i = 0; i < list.length; i++) {
      const headKey = rowKey(list[i])
      const run = runByHead.get(headKey)
      if (run) {
        slots.push({ headKey, keys: run.keys.slice() })
        i += run.keys.length - 1
        continue
      }
      slots.push({ headKey, keys: [headKey] })
    }
    return slots
  }

  /**
   * 摘掉一行；如果它是一个合体容器的最后一个成员，把空容器一并摘掉。
   *
   * 为什么必须走这里而不是 `node.remove()`：容器是 wrap 的直接子节点，行删了容器还在，
   * 就会在列表里留一块**看不见但占着 1px 外边距**的空槽（关闭动效播完尤甚）。
   * @param {HTMLElement|null} node
   */
  function removeRow(node: HTMLElement | null): void {
    if (!node || !node.isConnected) return
    const parent = node.parentNode as Element | null
    node.remove()
    if (!parent || !parent.classList || !parent.classList.contains('tabrow-pair')) return
    // 容器里还有别的成员（或正在播关闭动效的行）→ 留着
    if (parent.querySelector('[data-row]')) return
    for (const [key, rec] of pairEls) if (rec.el === parent) pairEls.delete(key)
    parent.remove()
  }

  /** 清空所有合体容器（列表被整体清空 / 空态）。 */
  function clearPairs() {
    for (const rec of pairEls.values()) rec.el.remove()
    pairEls.clear()
  }

  /**
   * 回收本轮没用到的容器。
   *
   * 只收"已经空了的"：成员正在播关闭动效时容器必须留着 —— 动效结束由 `removeRow`
   * 收尾，提前摘容器会让正在塌陷的那半枚凭空消失。
   * @param {Set<string>} used
   */
  function prunePairs(used: Set<string>): void {
    for (const [key, rec] of pairEls) {
      if (used.has(key)) continue
      if (rec.el.querySelector('[data-row]')) continue
      rec.el.remove()
      pairEls.delete(key)
    }
  }

  // ── hover 预览 ─────────────────────────────────────────────────────────────
  // 「什么时候显、什么时候收」由**横竖共用**的状态机负责（六条规则见 hoverPreview.ts
  // 文件头：列表级计时 / 已可见立即换锚 / 320ms 重挂 / 项以外延迟收 与 离开列表即收 /
  // 按下别处即收 / 锚点消失即收并锁到指针动过）。本列表因此只交出三件事实 ——
  //「鼠标进了哪一行」与「鼠标是不是还在本列表里」与宿主 document ——不再自己维护一套计时器
  //（此前与横向标签条各写一份，常量也各抄一遍；规则 ⑤ 更是只有横向条有，纵向三宿主全缺）。
  const hover = createHoverPreview({
    document: doc,
    // 意图预热（与横向标签条同一条）：预览是独立浮层视图，闲置会被回收 ——
    // 700ms 停留延迟足够盖住一次 renderer 冷启动，于是起表的同时后台载入。
    onIntent() {
      if (overlay && typeof overlay.warmTabPreview === 'function') {
        try { overlay.warmTabPreview() } catch (_) {}
      }
    },
    onShow: (row: HTMLElement, tab: TabRowItem) => present(row, tab),
    onHide: () => {
      if (overlay && typeof overlay.hideTabPreview === 'function') overlay.hideTabPreview()
    }
  })

  /** 收起（本文件内的旧名字，语义 = 状态机的 hide）—— 指针离开 / 拖拽开始走它。 */
  function hidePreview() { hover.hide() }
  /**
   * 被 hover 的那一行**已从投影里消失**（关闭 / 取消固定 / 列表清空）→ 规则 ⑥。
   *
   * 不能只调 `hide()`：行被移除后相邻行会在**指针没动**的情况下滑到指针底下，
   * Chromium 补发的那次 mouseover 会被规则 ②③ 当成新 hover 当场补显 ——
   * 表现就是"关掉这个标签，预览还卡着"。`invalidate()` 收起并锁到指针真的动过。
   */
  function invalidatePreview() { hover.invalidate() }
  /** 指针仍在列表内、但不在任何行上（行间缝隙 / 空白）→ 延迟收起，回到行上即取消。 */
  function scheduleRowAbsentHide() { hover.absent() }

  /**
   * 拖拽收尾：收起预览，并**解除补显窗口**（`forgetRound`）。
   *
   * 拖拽期间 Chromium 不发 mouseover / mousemove，松手后指针第一次移动会被补发一次
   * mouseover。若此刻重挂窗口还开着，那次 mouseover 会走状态机的「同一轮巡视」分支，
   * **立刻**把预览弹出来且不再计时 —— 用户看到的「松手离开了 tab，预览还显示着」正是这个。
   * 清掉窗口后，松手后的 hover 必须重新计满延迟才出预览（正常的 hover 语义）。
   */
  function endDragPreview() {
    hover.hide({ forgetRound: true })
  }

  function present(row: HTMLElement, tab: TabRowItem): void {
    if (!overlay || typeof overlay.showTabPreview !== 'function') return
    // 载荷形状（锚点矩形 + 标签数据 + 外侧边界）与横向列表**共用一份**（tabPreviewFacts）：
    // 两个列表各拼一遍时，只要一边漏一个字段，同一个预览在两种模式下的表现就会不一致。
    // 外侧边界取**本条列表所在的滚动容器**（侧栏的 `.vtabs__body`、面板内容区同构）——
    // 行的矩形量不到右边那道滚动条，理由与后果见 tabPreviewFacts 的文件头。
    const facts = tabPreviewFacts({ anchorEl: row, tab, stripEl: wrap.parentElement })
    if (!facts) return
    overlay.showTabPreview(facts)
  }

  /** 指针进入某一行 → 交给共用状态机（同一行重复进入它自己会忽略）。 */
  function onRowEnter(row: HTMLElement, tab: TabRowItem): void {
    hover.enter(row, tab)
  }

  // ── 拖拽排序 ───────────────────────────────────────────────────────────────
  // 当前拖拽源 tabId：独立 WebContentsView 下 dataTransfer.getData 在 drop 时不可靠，
  // 用闭包变量保存，零序列化、跨视图稳定。
  let dragId = ''

  /**
   * 拖拽会话内的几何快照。dragover 会高频触发，重复 `getBoundingClientRect()`
   * 会对整列行强制同步布局；拖拽期间行顺序与尺寸不变，因此只在开始时量一次。
   */
  interface RowRectSnapshot { top: number; bottom: number; left: number; right: number; width: number; height: number }
  let listRect: RowRectSnapshot | null = null
  let rowNodes: HTMLElement[] = []
  let rowRects: RowRectSnapshot[] = []
  let rowRectCache = new WeakMap<Element, RowRectSnapshot>()
  let externalDragGeometryActive = false

  function snapshotRect(el: Element): RowRectSnapshot {
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
  }

  function resetRowDropGeometry(): void {
    listRect = null
    rowNodes = []
    rowRects = []
    rowRectCache = new WeakMap()
  }

  function ensureRowDropGeometry(): void {
    if (listRect) return
    listRect = snapshotRect(wrap)
    rowNodes = Array.from(wrap.querySelectorAll<HTMLElement>('[data-row]:not(.tabrow-row--closing)'))
    rowRects = rowNodes.map((row) => {
      const rect = snapshotRect(row)
      rowRectCache.set(row, rect)
      return rect
    })
  }

  function rowRectOf(row: Element): RowRectSnapshot {
    const cached = rowRectCache.get(row)
    if (cached) return cached
    const rect = snapshotRect(row)
    rowRectCache.set(row, rect)
    return rect
  }

  // 滚动 / 窗口尺寸改变会让快照失效；只在此时重测，常态 dragover 不再读布局。
  element.addEventListener('scroll', resetRowDropGeometry, { passive: true, capture: true })
  doc.defaultView?.addEventListener('resize', resetRowDropGeometry, { passive: true })

  /**
   * 分屏落点用的两个 id（与 `dragId` **分开存**）。
   *
   * 为什么不复用 `dragId`：`drop` 处理器（落进列表内）会先把 `dragId` 清空（见下），
   * 到 `dragend` 时已经读不到了 —— 而复用会让"落在列表里"与"落在网页上"两种情况
   * 都变成读不到 id。这两个只在 dragstart 写、dragend 清。
   */
  let dragSplitTabId = ''
  let dragSplitBaseTabId = ''

  /** 当前被高亮为「堆叠落点」的行（同一时刻只有一个）。 */
  let stackTargetRow: HTMLElement | null = null
  function setStackTarget(row: HTMLElement | null): void {
    if (stackTargetRow === row) return
    if (stackTargetRow) stackTargetRow.classList.remove('tabrow-row--stack-target')
    stackTargetRow = row || null
    if (stackTargetRow) stackTargetRow.classList.add('tabrow-row--stack-target')
  }
  /**
   * 拖拽时是否按住了「堆叠」修饰键（Ctrl / Shift / Alt 任一）。
   * 与 tabbar 同一口径：三个键在拖放里都没有别的含义，用户不必记住具体是哪个。
   */
  const stackModifierHeld = (e: DragEvent | null): boolean => !!(
    e && (e.ctrlKey || e.shiftKey || e.altKey)
  )

  function isStackItem(item: TabRowItem | null | undefined): item is TabRowStack {
    return !!item && item.type === 'stack'
  }

  function isTabItem(item: TabRowItem | null | undefined): item is TabRowTab {
    return !!item && item.type !== 'stack'
  }

  function asExternalDragItem(value: unknown): TabRowExternalDragItem | null {
    return value && typeof value === 'object' ? value as TabRowExternalDragItem : null
  }

  /**
   * 列表里某个标签自己所属的标签组 id（散标签 / 查不到 → null）。
   *
   * 组行靠 `data-stack-id` 属性自报家门，而**标签行不带这个属性**（带了会让点击 /
   * 菜单把标签行误判成组行）。因此「落点标签是不是组内成员」只能从数据侧查
   * `currentTabs` —— 与 tabbar 用投影项查 stackId 是同一口径。
   */
  function stackIdOfTab(tabId: TabRowId | null | undefined): string | null {
    const id = String(tabId)
    const item = currentTabs.find((it) => it && it.tabId != null && String(it.tabId) === id)
    return item && item.stackId != null ? String(item.stackId) : null
  }

  /**
   * 外部拖入的载荷若是**本窗口自己的标签**，返回它的 tabId；否则 null。
   *
   * 为什么必须认：浮层展开是**另一个 WebContentsView**（`sidebar-float`），跨视图松手落到
   * 它上面时它的 `dragId` 是空的 —— 被当成"外部拖入"，`onExternalDrop` 见到 url 就开新
   * 标签 = *只是拖动排序，却复制出一个新标签*（用户实测：展开赶在拖拽前一瞬间时必现）。
   * 本窗口的标签落到本窗口的任一列表视图，语义只能是**重排**，不可能是"新建"。
   *
   * 判据取「这个 tabId 就在 `currentTabs` 里」：四个纵向宿主（侧栏 / 浮层 / 打开标签 /
   * 固定标签）共用同一份投影；不在投影里的 tab 交给宿主做跨窗口整体迁移。
   */
  function ownTabDragId(item: TabRowExternalDragItem | null): string | null {
    if (!item || item.domain !== 'tab') return null
    const id = String(item.id || item.tabId || '')
    if (!id) return null
    return currentTabs.some((it) => it && it.tabId != null && String(it.tabId) === id) ? id : null
  }

  /**
   * `dataTransfer.types` 里有没有标签拖拽源写的私有 MIME。
   *
   * `dragover` 阶段读不到值（跨视图 `getData` 一律空串），但 `types` 可读 —— 有它就知道
   * 这一下拖的是**标签**（本窗口列表或横向标签条），光标该报 move 而不是 copy。
   */
  function hasOwnTabType(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false
    const types = dataTransfer.types
    if (!types) return false
    for (let i = 0; i < types.length; i += 1) {
      if (String(types[i]).toLowerCase() === 'application/x-ng-tab') return true
    }
    return false
  }

  /**
   * 一次拖放的**唯一裁决**：给定被拖标签与指针下的行，得出「该做什么」。
   *
   * 为什么必须抽出来：dragover 要画（插入线 / 堆叠高亮），drop 要提交。两边各写一遍判据
   * 迟早漂移成"亮得很积极，松手却什么都不发生"（或反过来：没亮却动了）。这里只算一次
   * 口径，视觉与提交读同一份结论 —— 顺带把 `_targetId` / `_insertAfter` 这类隐式 DOM
   * 状态删掉（它们是"上一拍的事实"，drop 时早已过期）。
   *
   * @param {string} draggedId 被拖的标签 id
   * @param {HTMLElement|null} target 指针下的行（见 rowUnder），null = 列表空白处
   * @param {DragEvent} e 用于修饰键判据
   * @returns {object} 四种之一：
   *   `{kind:'reject'}` 不认这一下；`{kind:'blank', self}` 空白处 / 自己那一行；
   *   `{kind:'stack', row, stackId, stackPinned}` 并入组行；
   *   `{kind:'stack', row, targetTabId, draggedStackId}` 与标签行堆叠成组；
   *   `{kind:'move', targetId, insertAfter, rect, leaveStack}` 同层重排。
   */
  function decideRowDrop(
    draggedId: string,
    target: HTMLElement | null,
    e: DragEvent
  ): RowDropDecision {
    const targetStackId = target ? (target.getAttribute('data-stack-id') || '') : ''
    const targetTabId = target ? (target.getAttribute('data-tab-id') || '') : ''
    // 没行 / 行上没有任何 id → 列表空白处；落到**自己那一行**是明确的"无操作"，与空白处
    // 分开判（否则组内原地松手会把标签误踢出组）。
    if (!target || (!targetStackId && !targetTabId)) return { kind: 'blank', self: false }
    if (targetTabId && targetTabId === draggedId) return { kind: 'blank', self: true }
    // 种类裁决（唯一真源 tab-policy）：固定标签 ↔ 普通标签不能混排 / 混组。
    // 落点不亮 —— 与落库用同一份策略，才不会"高亮得很积极，松手却什么都不发生"。
    if (!canDropOnItem(currentTabs, draggedId, targetStackId || targetTabId)) return { kind: 'reject' }
    // 「并入」触发 ①：落到**标签组行**上（无论有没有按修饰键）。
    if (targetStackId) {
      return {
        kind: 'stack',
        row: target,
        stackId: targetStackId,
        stackPinned: isPinnedItem(currentTabs, targetStackId)
      }
    }
    const draggedStackId = stackIdOfTab(draggedId)
    const memberStackId = stackIdOfTab(targetTabId)
    // 「并入」触发 ②③（与 tabbar 逐条对齐）：落到**组内标签行**上 / 修饰键 + 落到另一标签行。
    // 已在同一组内 → 不算并入（让用户能在组内调整顺序）。
    if (stackModifierHeld(e) || (memberStackId != null && memberStackId !== draggedStackId)) {
      return { kind: 'stack', row: target, targetTabId, draggedStackId }
    }
    const rect = rowRectOf(target)
    return {
      kind: 'move',
      targetId: targetTabId,
      insertAfter: geo.isAfter(e.clientY, rect),
      rect,
      // 落点是**组外的散标签** → 被拖的若在某个组里，先出组再落在这一侧（与 tabbar 同一手势）。
      // 必须放在通用重排之前：不带这一判，组内标签拖到散标签上会「留在原组里换了个位置」。
      leaveStack: !!draggedStackId && memberStackId == null
    }
  }

  function eventElement(e: Event): Element | null {
    const target = e.target
    return target && typeof (target as Element).closest === 'function'
      ? target as Element
      : null
  }

  wrap.addEventListener('dragstart', (e) => {
    const row = eventElement(e)?.closest<HTMLElement>('[data-row]')
    if (!row) return
    const transfer = e.dataTransfer
    if (!transfer) { e.preventDefault(); return }
    const tabId = row.getAttribute('data-tab-id') || ''
    if (!tabId) { e.preventDefault(); return }
    // 先切到被拖的标签、再开始重排 —— 与 Edge / Chrome 同口径（纵向列表与 tabbar 一个行为）。
    // 判据读行上的类：它就是渲染期由投影的 active 写下的，不必再查一份数据。
    const wasActive = row.classList.contains('tabrow-row--active')
    if (!wasActive) onIntent({ type: 'switch', tabId })
    // 分屏落点要配对的是「拖动前正在看的那一格」——必须在切换**之前**确定（上面那个 wasActive
    // 就是那一刻的事实）。被拖的行本来就是活动行时留空：没有可配对的"另一格"，
    // 主进程会安静地不做（见 TabManager#dropTabOnContent）。
    dragSplitTabId = String(tabId)
    const activeRow = wrap.querySelector('.tabrow-row--active')
    dragSplitBaseTabId = wasActive || !activeRow ? '' : (activeRow.getAttribute('data-tab-id') || '')
    // 报"开始拖了"（落位预览的起点，见上面 onDropOnContentBegin 的说明）。
    // 与横向标签条同一口径：base 取**切换之前**那一刻的活动行 —— 它就是"拖前在看的那一格"。
    // 固定标签不能分屏（tab-policy#canSplit）→ 连落位预览都不该起来。
    if (onDropOnContentBegin && !isPinnedItem(currentTabs, tabId)) {
      onDropOnContentBegin(String(tabId), dragSplitBaseTabId || '')
    }
    dragId = String(tabId)
    externalDragGeometryActive = false
    resetRowDropGeometry()
    ensureRowDropGeometry()
    hidePreview()
    // 中和窗口拖拽区：指针一旦越出列表落进 app-region 区，连 dragover 都不会派发，
    // 那时候再想补救已经收不到任何信号了 —— 必须**拖拽开始那一刻**就中和（见 dragRegion.ts）。
    dragRegion.arm()
    hintWatch.arm()
    // copyMove：列表内重排用 move，拖到别的面板用 copy（理由见 ui-tabbar/tabRecord.js）。
    transfer.effectAllowed = 'copyMove'
    // 私有 MIME（理由见 ui-tabbar 的 tabRecord.js）：避免网页把这次拖放当文本接走。
    try { transfer.setData('application/x-ng-tab', `${dragKind}:${tabId}`) } catch (_) {}
    // 统一拖拽协议（shared-types#drag-item）—— 跨视图落点（集锦 / 画板 / 书签栏）按 domain 分发。
    // `plain:'none'` 与横向标签条同口径：绝不写 text/plain。
    const dragTab = currentTabs.find((it) => it && it.tabId != null && String(it.tabId) === String(tabId))
    setDragItem(transfer, {
      domain: 'tab',
      id: String(tabId),
      kind: 'page',
      tabId: String(tabId),
      url: isTabItem(dragTab) ? dragTab.url || '' : '',
      title: isTabItem(dragTab) ? dragTab.title || '' : ''
    }, { plain: 'none' })
  })

  /**
   * 指针此刻压着**哪一条行** —— 拖放落点的唯一入口。
   *
   * 先看指针下的真实元素（事件挂在 document 上，`e.target` 就是它，语义与改动前完全一致）；
   * 命中不到行时按**纵向总带**贴边兜底：
   *   · 在**首行之上** → 首行（插到最前）；在**末行之下** → 末行（插到最后）；
   *   · 总带**之内**（行与行之间那 1px 缝）→ 返回 null，保留"拖到空白处 = 退出标签组"原语义。
   *
   * 为什么必须贴边兜底：行的容器铺满整个内容区（`min-height: 100%`），末行之下留着一大片
   * 空白。向下拖过头一点点就落进那片空白 —— 返回 null 会**同时**让定位条消失、让排序失败，
   * 而"拖过头"恰恰是拖拽的常态（同浏览器：拖到列表外仍按边界插入，而不是整场作废）。
   */
  function rowUnder(e: DragEvent): HTMLElement | null {
    const hit = eventElement(e)
    if (hit && typeof hit.closest === 'function') {
      const direct = hit.closest<HTMLElement>('[data-row]:not(.tabrow-row--closing)')
      if (direct) return direct
    }
    return edgeRowByY(e.clientY)
  }

  /** 见 rowUnder：按纵向总带贴边取首/末行（组行也是合法落点，故不按 data-tab-id 过滤）。 */
  function edgeRowByY(y: number): HTMLElement | null {
    ensureRowDropGeometry()
    if (!rowNodes.length) return null
    // 首尾外推的规则横竖共用（pickEdge）—— 别再写一遍 y < first.top / y > last.bottom。
    const edge = geo.pickEdge(y, rowRects)
    return edge < 0 ? null : rowNodes[edge]
  }

  // 挂在 document 上（不是 wrap）：指针越出列表后事件冒泡到的是 wrap 的**兄弟**节点，
  // 挂 wrap 收不到 —— 那正是"拖过头一点点就失效"的成因（见 dragRegion.ts）。
  doc.addEventListener('dragenter', (e) => {
    if (!dragId) {
      // 外部拖入（统一协议）：同样要 preventDefault 才算把 document 认成合法落点。
      if (e.dataTransfer && hasDragItem(e.dataTransfer)) {
        if (!externalDragGeometryActive) {
          externalDragGeometryActive = true
          resetRowDropGeometry()
        }
        e.preventDefault()
      }
      return
    }
    externalDragGeometryActive = false
    // 取消 dragenter 才算把 document 认成合法落点（Chromium 的判据）
    e.preventDefault()
  })

  doc.addEventListener('dragover', (e) => {
    const transfer = e.dataTransfer
    if (!dragId) {
      // 外部拖入：显示插入线（松手时若是本窗口的标签，本列表自己按重排提交；否则交给宿主）。
      if (!transfer || !hasDragItem(transfer)) return
      e.preventDefault()
      // 标签源报 move（搬一格），其它域（书签 / 集锦等可能只许 copy 的源）仍报 copy。
      transfer.dropEffect = pickDropEffect(
        transfer,
        hasOwnTabType(transfer) ? 'move' : 'copy'
      )
      const row = rowUnder(e)
      if (!row) {
        dropIndicator.classList.remove('tabrow-drop--show')
        return
      }
      const rect = rowRectOf(row)
      const insertAfter = geo.isAfter(e.clientY, rect)
      dropIndicator.classList.add('tabrow-drop--show')
      ensureRowDropGeometry()
      dropIndicator.style.top = `${geo.indicatorOffset(rect, listRect!, insertAfter) - 1}px`
      return
    }
    e.preventDefault()
    if (transfer) transfer.dropEffect = 'move'
    // 视觉只读裁决结论（与 drop 的提交读同一份，见 decideRowDrop）。
    const decision = decideRowDrop(dragId, rowUnder(e), e)
    if (decision.kind === 'move') {
      setStackTarget(null)
      dropIndicator.classList.add('tabrow-drop--show')
      // indicatorOffset 给的是容器坐标系里的偏移；-1 是让 2px 的条压在行的边界线上。
      ensureRowDropGeometry()
      dropIndicator.style.top = `${geo.indicatorOffset(decision.rect, listRect!, decision.insertAfter) - 1}px`
      return
    }
    dropIndicator.classList.remove('tabrow-drop--show')
    setStackTarget(decision.kind === 'stack' ? decision.row : null)
  })

  // 外部拖入离开本视图时（不会来的 dragend）也要收起插入线。
  doc.addEventListener('dragleave', (e) => {
    if (dragId || e.relatedTarget) return
    dropIndicator.classList.remove('tabrow-drop--show')
    externalDragGeometryActive = false
    resetRowDropGeometry()
  })

  doc.addEventListener('drop', (e) => {
    const transfer = e.dataTransfer
    if (!transfer) return
    if (!dragId) externalDragGeometryActive = false
    if (!dragId) {
      // 外部拖入（统一协议）。
      if (!hasDragItem(transfer)) return
      const item = asExternalDragItem(getDragItem(transfer))
      // 本窗口自己的标签 → **认领成内部重排**（见 ownTabDragId）。绝不走 `onExternalDrop`：
      // 那条路见到 url 就开新标签，正是"拖动排序却复制出一个新标签"的来源。
      const ownId = ownTabDragId(item)
      if (!ownId) {
        e.preventDefault()
        dropIndicator.classList.remove('tabrow-drop--show')
        if (!item || !onExternalDrop) return
        // 把载荷与落点交给宿主。
        const row = rowUnder(e)
        if (!row) { onExternalDrop(item, { kind: 'strip' }); return }
        const stackId = row.getAttribute('data-stack-id') || ''
        if (stackId) { onExternalDrop(item, { kind: 'stack', stackId }); return }
        const tabId = row.getAttribute('data-tab-id') || ''
        if (!tabId) { onExternalDrop(item, { kind: 'strip' }); return }
        onExternalDrop(item, {
          kind: 'tab',
          tabId,
          stackId: stackIdOfTab(tabId),
          insertAfter: geo.isAfter(e.clientY, rowRectOf(row))
        })
        return
      }
      dragId = ownId
    }
    e.preventDefault()
    // 立刻收尾：drop 处理里会重排（源节点可能因此被移出 DOM），那之后 dragend 就未必
    // 还会冒泡到 wrap 上 —— 中和类留在根元素上会让整窗再也拖不动。
    dragRegion.disarm()
    dropIndicator.classList.remove('tabrow-drop--show')
    const draggedId = dragId
    dragId = ''
    // 落点**就在列表内**（本文件处理的任何一次 drop 都是"落在本列表文档里"）——
    // 它永远不可能是"拖到网页上"。所以顺手把分屏落点用的两个 id 清掉，否则紧随其后的
    // `dragend` 还会再走一次 drop-on-content：主进程的降级判据会把这次落在列表里的拖动
    // 误认成"落在网页上" → 明明只是拖动标签排序，却凭空分屏（见 TabManager#dropTabOnContent）。
    dragSplitTabId = ''
    dragSplitBaseTabId = ''
    // 已经在列表里松手 = 这场拖动的分屏分支没发生：立刻告诉主进程**归档整场拖动**
    //（停表 + 收落位框 + 解除侧栏唤出冻结）。不能等 dragend —— 重排会把源行移出 DOM，
    // 那之后 dragend 未必还冒泡到 wrap 上（同 dragRegion.disarm 那条注释的理由）。
    if (onDropOnContentCancel) onDropOnContentCancel()
    // 先收尾再重排：重排会让行在光标下换位，避免它们带着旧 hover 状态把预览拉起来
    endDragPreview()
    const decision = decideRowDrop(draggedId, rowUnder(e), e)
    setStackTarget(null)
    if (decision.kind === 'reject') return
    if (decision.kind === 'stack') {
      // 落到标签组行 → 并入该组
      if (decision.stackId) {
        onDragEnd({ draggedId, targetStackId: decision.stackId, targetStackPinned: decision.stackPinned })
        return
      }
      // 落到标签行 → 与它堆叠成组。传**投影项**（带着它自己的 stackId）与被拖标签当前的组，
      // 调用方据此决定「并入它所在的组」「新建一个组」还是「把落点并进被拖的组」。
      const matched = currentTabs.find((it) => (
        isTabItem(it) && String(it.tabId) === String(decision.targetTabId)
      ))
      const item: TabRowItem = isTabItem(matched)
        ? matched
        : { tabId: String(decision.targetTabId || '') }
      onDragEnd({ draggedId, stackWithItem: item, draggedStackId: decision.draggedStackId })
      return
    }
    if (decision.kind === 'blank') {
      // 落到**自己那一行** = 无操作。必须与"空白处"分开判 —— 否则组内原地松手会把标签误踢出组。
      if (decision.self) return
      // 落到列表**空白处** = 退出标签组（与 tabbar 的「拖到标签条空白处」同一手势）。
      // 没有组就不做任何事 —— 空白处不是「移到末尾」的落点。
      if (stackIdOfTab(draggedId)) onDragEnd({ draggedId, leaveStack: true })
      return
    }
    onDragEnd({
      draggedId,
      targetId: decision.targetId,
      insertAfter: decision.insertAfter,
      leaveStack: decision.leaveStack
    })
  })

  wrap.addEventListener('dragend', () => {
    dropIndicator.classList.remove('tabrow-drop--show')
    setStackTarget(null)
    dragId = ''
    externalDragGeometryActive = false
    resetRowDropGeometry()
    // 拖出面板 / Esc 取消也会走到这里 —— 同样必须收尾
    dragRegion.disarm()
    hintWatch.disarm()
    endDragPreview()

    // ── Arc 式入口：拖到**网页区域**松手 = 与"拖动前正在看的那一格"分屏 ──────────
    // 与横向标签条**同一个出口、同一套判据**：这里只报两个 id（"拖前在看哪个"可能为空），
    // **落点与判定全在主进程** —— 见 TabManager#dropTabOnContent。
    const dragged = dragSplitTabId
    const base = dragSplitBaseTabId
    dragSplitTabId = ''
    dragSplitBaseTabId = ''
    // ── 整场拖动**一律收尾**（两个出口，职责相同：让主进程把这场拖归档）─────────
    //  · 有候选落点 → 走 commit（主进程按最后一次意图决定分不分屏；`end()` 顺带归档）；
    //  · 没有（本列表里松手已 clear / 固定标签 / 宿主没接 commit 端口）→ 走 cancel
    //（只归档、不提交）。⚠ 绝不在这里 `return` 了事 —— 那正是"分屏黏住"的来源：
    //  主进程的采样表与侧栏唤出冻结会永远留着，直到下一次拖动或窗口失焦。
    if (dragged && onDropOnContent && !isPinnedItem(currentTabs, dragged)) {
      onDropOnContent(dragged, base || '')
      return
    }
    if (onDropOnContentCancel) onDropOnContentCancel()
  })

  // ── 点击 / 右键（全部委托，行节点不挂监听）─────────────────────────────────
  wrap.addEventListener('click', (e) => {
    const row = eventElement(e)?.closest<HTMLElement>('[data-row]')
    if (!row) return
    // 记录相邻两次点击的间隔，供下面的双击关闭做「够快才关闭」过滤
    //（与横向标签条**共用同一份计时**，见 tab/gestures.ts）
    noteTabPrimaryClick()
    // 标签组行：点整行 = 折叠 / 展开该组（与 tabbar 芯片同一语义）
    const stackId = row.getAttribute('data-stack-id') || ''
    if (stackId) { onIntent({ type: 'toggle-stack', stackId }); return }
    const tabId = row.getAttribute('data-tab-id') || ''
    if (!tabId) return
    // Alt/Option + 单击 = 与当前活动标签分屏 —— 与横向标签条**同一个修饰键判据**
    //（见 tab/gestures.ts#isSplitModifier）。各写一遍必然变成"横向能用、纵向不能用"。
    if (isSplitModifier(e)) { onIntent({ type: 'split-with', tabId }); return }
    // 行内按钮（音频 / 关闭）都由共用件自己吃冒泡并上抛意图（见 tab/iconArea.ts、tab/closeButton.ts），
    // 委托这里只剩「点行 = 切标签」一条路径。
    onIntent({ type: 'switch', tabId })
  })

  // ── 双击关闭 / 中键关闭（与 tabbar 逐条对齐，见 ui-tabbar/components/Tab.js）──
  // 双击：只有两次点击足够快（≤250ms）才算数，慢双击退化成两次普通单击（防误触）。
  // 落在行内按钮（关闭 / 静音）上的双击不处理，避免与按钮自身语义打架。
  wrap.addEventListener('dblclick', (e) => {
    const row = eventElement(e)?.closest<HTMLElement>('[data-row]')
    if (!row) return
    if (eventElement(e)?.closest('.tabrow-btn')) return
    if (!isFastDoubleClick()) return
    const tabId = row.getAttribute('data-tab-id') || ''
    // 标签组行没有对应标签，双击不关任何东西（组要靠菜单拆分）
    if (!tabId) return
    onIntent({ type: 'close', tabId })
  })

  // 中键关闭：**中键自动滚动必须先被吃掉**，否则 Chromium 的「四向箭头 + 页面跟着
  // 鼠标滚」会跟关闭抢一拍（表现就是"中键关标签卡一下"）。
  // 吃默认行为的规则只有一份（middleClickGuard），这里挂着的是**列表根** ——
  // 行与行之间的空白同样是这块区域，只挂行的话背景照样会起自动滚动光标。
  // auxclick 仍会正常派发，不受影响。
  guardMiddleClickAutoscroll(element)
  wrap.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    const row = eventElement(e)?.closest<HTMLElement>('[data-row]')
    if (!row) return
    const tabId = row.getAttribute('data-tab-id') || ''
    if (!tabId) return
    onIntent({ type: 'close', tabId })
  })

  wrap.addEventListener('mouseover', (e) => {
    const row = eventElement(e)?.closest<HTMLElement>('[data-row]')
    if (!row || row.getAttribute('data-tab-id') == null) {
      // 指针不在任何行上（面板空白区、行间缝）→ 延迟收起；越过缝进入下一行会取消。
      // wrap 铺满整个内容区，所以「还在面板里」不足以说明「还在标签上」。
      scheduleRowAbsentHide()
      return
    }
    const tabId = row.getAttribute('data-tab-id') || ''
    const tab = currentTabs.find((t) => isTabItem(t) && String(t.tabId) === String(tabId))
    if (!tab) return
    // 进入行 → 状态机自己会取消待收起（不必在这里显式 cancel）
    onRowEnter(row, tab)
  })

  // 离开 wrap 本身（面板内边距 / 滚动条 / 面板头部 / 面板外）→ 立即收起。
  // 注意这条**管不到**「wrap 内部、但不在任何行上」的空白区（wrap 是 height:100%），
  // 那一块由上面 mouseover 的「行以外」分支负责。
  wrap.addEventListener('mouseleave', hidePreview)

  wrap.addEventListener('contextmenu', (e) => {
    const row = eventElement(e)?.closest<HTMLElement>('[data-row]')
    if (!row) return
    e.preventDefault()
    // 标签组行 → 标签组菜单（重命名 / 拆分 / 合并 / 颜色），与 tabbar 芯片逐项对齐
    const stackId = row.getAttribute('data-stack-id') || ''
    if (stackId) {
      const stack = currentTabs.find((t) => isStackItem(t) && String(t.stackId) === String(stackId))
      if (isStackItem(stack)) showStackMenu(e.clientX, e.clientY, stack, row)
      return
    }
    const tabId = row.getAttribute('data-tab-id') || ''
    const matchedTab = currentTabs.find((t) => isTabItem(t) && String(t.tabId) === String(tabId))
    const tab: Partial<TabRowTab> = isTabItem(matchedTab)
      ? matchedTab
      : {}
    // 把「下一个行项」一并交给菜单：面板是纵向列表，「与下方标签堆叠」需要知道下面是谁。
    const index = currentTabs.findIndex((t) => t && String(t.tabId) === String(tabId))
    const nextItem = index >= 0 ? (currentTabs[index + 1] || null) : null
    showMenu(e.clientX, e.clientY, tab, nextItem)
  })

  // ── 行的打开 / 关闭动效（与 tabbar 同一套语言，见 tokens-base 的 --ng-anim-*）──
  // 纵向列表的结束高度是 auto，没法用关键帧，所以走经典两段式：
  //   进入：量自然高度 h → 钉成 h → 强制 reflow → 钉成 0（过渡插值）→ 结束清 inline
  //   离开：钉成 h → 强制 reflow → 钉成 0 + 淡出 → 过渡结束才真正 remove()
  // 期间行仍留在流里，下面的行逐帧上移 —— 没有瞬移。

  /** 动效兜底时长：过渡被中断（窗口隐藏、元素已移除）时也要收尾，避免行永留 DOM / 永久塌着 */
  const ROW_ANIM_FALLBACK_MS = 400
  /** 入场动效的类名（关键帧见 injectTabRowStyles 的 @keyframes tabrow-row-enter）。 */
  const ROW_ENTER_CLASS = 'tabrow-row--entering'

  /** 首次填充不播入场 —— 打开面板时十几行一起展开太吵 */
  let rowsPrimed = false

  /** 跳过正在消失的行（它们不再参与排序锚点判定） */
  function nextSiblingSkippingClosing(node: HTMLElement): ChildNode | null {
    let n = node.nextSibling
    while (n && (n as Element).classList?.contains('tabrow-row--closing')) n = n.nextSibling
    return n
  }

  /**
   * 行「外框高度」= border-box 高度 + 上下外边距。
   *
   * 为什么不用 offsetHeight：入场/退场期间会把竖向的 padding / border / margin 一起
   * 清零（见 .tabrow-row--box-collapsed），钉住的高度必须按**清零前的整块占位**取，
   * 否则动画终点的实际高度与 0 会差出那一截，节点被移除时空隙"啪"地跳掉。
   * @param {HTMLElement} row
   * @returns {number}
   */
  function outerHeightOf(row: HTMLElement): number {
    let mt = 0
    let mb = 0
    try {
      const cs = view.getComputedStyle(row)
      mt = parseFloat(cs.marginTop) || 0
      mb = parseFloat(cs.marginBottom) || 0
    } catch (_) {}
    return Math.max(0, Math.round(row.getBoundingClientRect().height + mt + mb))
  }

  /**
   * 新建行的入场动效：**只挂一个类，动画交给关键帧**（见 styles 的 @keyframes tabrow-row-enter）。
   *
   * 与横向标签条 `ng-tab-enter` 逐条对应（只是轴从宽换成高）。这里**不量高度**是有意的：
   * 新建的行常常刚创建、宿主可能还没把它画出来（甚至还没挂进文档），此时量到的是 0。
   * 旧实现就在那一步 `if (!h) return` —— 于是"新建标签没有创建动画"（用户报的现象）。
   * 关键帧不依赖测量：节点真正被画出来时，它自然从 0 长到自己的高。
   * @param {HTMLElement} row
   */
  function animateRowEnter(row: HTMLElement): void {
    if (!motionEnabled) return
    if (!row || row.classList.contains('tabrow-row--closing')) return
    row.classList.add(ROW_ENTER_CLASS)
    // 与横向同一条兜底：动画被中断（元素提前被移除 / 窗口隐藏）时也不能留着类
    const done = () => row.classList.remove(ROW_ENTER_CLASS)
    row.addEventListener('animationend', done, { once: true })
    setTimeout(done, ROW_ANIM_FALLBACK_MS)
  }

  function animateRowExit(row: HTMLElement): void {
    if (!row || !row.isConnected || row.classList.contains('tabrow-row--closing')) return
    if (!motionEnabled) {
      removeRow(row)
      return
    }
    // 先量外框高度（改样式之前量），再清零装饰 + 钉住它：起点 = 原来的整块占位。
    const h = outerHeightOf(row)
    row.classList.add('tabrow-row--closing')
    // 入场还没播完就被关掉：摘掉入场类，否则关键帧会把高度又撑回去（与退场的钉高打架）
    row.classList.remove(ROW_ENTER_CLASS)
    // 摘掉身份标识：正在消失的行不再被选择器/命中判定看到（同一 tabId 可能马上被恢复）
    row.removeAttribute('data-tab-id')
    row.draggable = false
    row.classList.add('tabrow-row--animating', 'tabrow-row--box-collapsed')
    if (h > 0) row.style.height = `${h}px`
    void row.offsetHeight
    // 终点 0：装饰已清零，所以这里的 0 是**整块占位**归零 —— 动画结束即可安全移除，
    // 后续行在整个过程中连续上移，收尾零跳变（这正是"卡一下再补空隙"的修复点）。
    row.style.height = '0px'
    row.style.opacity = '0'
    // 收尾走 removeRow：合体容器里的最后一员被摘掉时，空容器要一并收走。
    const done = () => removeRow(row)
    // 必须等 **height** 结束才移除：不能写成 `{ once: true }` 再过滤属性 ——
    // 那会被先结束的 opacity(120ms) 吃掉监听，只剩 400ms 兜底，
    // 表现就是「动画播完卡一下、空隙才补上」。
    onTransitionEndOnce(row, 'height', done, ROW_ANIM_FALLBACK_MS)
  }

  /** 一次性入场关键帧（音频按钮首次出现时用） */
  function popIn(el: HTMLElement | null): void {
    if (!el || !motionEnabled) return
    el.classList.add('tabrow-btn--pop')
    const done = () => el.classList.remove('tabrow-btn--pop')
    el.addEventListener('animationend', done, { once: true })
    setTimeout(done, ROW_ANIM_FALLBACK_MS)
  }

  function applyAudioState(audioBtn: HTMLButtonElement, state: TabRowTab): void {
    const wasHidden = audioBtn.hasAttribute('hidden')
    // 三态规则与横向标签条**共用**（见 tab/iconArea.ts 的导出）—— 本列表只管
    // 「首次冒出来时播一次入场」这条**纵向列表自己的**观感。
    renderAudioState(doc, audioBtn, state, { size: 12 })
    // 静音/开始播放 → 按钮首次冒出来时给它一个入场，而不是凭空出现
    if (wasHidden && !audioBtn.hasAttribute('hidden')) popIn(audioBtn)
  }

  // ── 行节点构造 / 增量更新 ──────────────────────────────────────────────────
  function makeRow(t: TabRowTab): TabRowParts {
    const row = doc.createElement('div')
    row.className = 'tabrow-row'
    row.setAttribute('data-row', '')
    row.draggable = true

    // 图标位 / 无痕标识 / 音频按钮三件都取**共用最小件**（见 tab/iconArea.ts）：
    // 本列表只交出「用哪套类名」（行内 CSS 口径不变）与音频按钮的点击意图。
    // 无痕标签的 🕶 判断因此与横向标签条同一处（数据一旦带上 incognito，两端同时生效）。
    const fav = createTabFavicon(doc, t, {
      classNames: {
        iconBox: 'tabrow-icon-box',
        favicon: 'tabrow-favicon',
        letter: 'tabrow-letter',
        incognito: 'tabrow-incognito-icon'
      }
    })
    // favicon 的跟随前景色底板 / 内部页图标的"自带白底"两套几何**都不在这里**：
    // 它们归共用件（tab/iconArea.ts 的 FAVICON_* 常量），横向标签条与纵向行消费同一份。
    // 本列表此前把同一组数字又内联写了一遍 —— 那正是"侧栏图标比别处小一圈"的来历。
    row.appendChild(fav.element)

    // 标题区也取共用件（容器 + 一行省略号文本）。本列表只交出**容器**类名 ——
    // 内层 span 的 `.title` 是固定的：它是行内编辑器的查找锚点（见 tab/titleArea.ts 文件头）。
    const title = createTabTitleArea(doc, '', { classNames: { container: 'tabrow-label' } })
    row.appendChild(title.element)

    // 权限请求标记：与横向标签条**同一个共用件**（图标键名 → SVG / 显隐 / 点击止步）。
    // 位置归本列表：落在音频按钮左侧，仍是行右端按钮区的一块「非切标签」命中目标。
    const permissionMark = createTabPermissionMark(doc, {
      onPermissionClick: () => onIntent({ type: 'permission', tabId: String(t.tabId) })
    }, { classNames: { mark: 'tabrow-btn tabrow-btn--permission' }, size: 12 })
    permissionMark.update(t.permissionIcons)
    row.appendChild(permissionMark.element)

    // 音频按钮：**位置**归本列表（仍在行右端、贴近关闭按钮，与 Edge 一致），
    // **规则**归共用件（三态 / 显隐 / 语义标签 / 点击止步）。
    const audio = createTabAudioButton(doc, {
      onToggleAudio: () => onIntent({ type: 'toggle-mute', tabId: String(t.tabId) }),
      size: 12
    }, { classNames: { audio: 'tabrow-btn tabrow-btn--audio' } })
    row.appendChild(audio.element)

    // 关闭按钮同样取共用件（X 图标 + 吃冒泡 + 无参意图），本列表只交出类名与意图。
    const closeBtn = createTabCloseButton(doc, {
      onClose: () => onIntent({ type: 'close', tabId: String(t.tabId) })
    }, { classNames: 'tabrow-btn' })
    row.appendChild(closeBtn.element)

    // 分屏「回形针」**不建在行内**：它挂在合体容器上（见 pairElFor）——
    // 行有 contain: paint，跨接缝的绝对定位子元素会被裁掉。
    return { row, fav, favicon: fav.favicon, titleArea: title, audioBtn: audio.element, permissionMark }
  }

  // 仅写入变化字段（对齐 RT/Hira 增量更新；prev=null 表示首次建行）
  function applyRow(parts: TabRowParts, t: TabRowTab, prev: TabRowTab | null): void {
    const { row, titleArea, audioBtn, permissionMark } = parts
    if (t.tabId != null) row.setAttribute('data-tab-id', String(t.tabId))
    let repaintColor = false
    if (!prev || prev.active !== t.active) {
      row.classList.toggle('tabrow-row--active', !!t.active)
      repaintColor = true // 选中/未选中是两套画法（整块底色 vs 一条指示线）
    }
    const textChanged = !prev || (prev.title || prev.url) !== (t.title || t.url)
    if (!prev || prev.favicon !== t.favicon || textChanged) {
      // 图标位的一条渲染规则（横向标签条同一条）：有 favicon 显图标，没有则显**标题首字**。
      // 所以标题/URL 变了也要重画 —— 否则图标条形态下那一格会停在旧的首字上。
      parts.fav.render({ favicon: t.favicon || '', title: t.title, url: t.url })
      repaintColor = true
    }
    if (textChanged) {
      const label = t.title || t.url || 'Untitled'
      // 共用件的 setTitle 每次现查 `.title`（见其文件头的坑），节点被复用也写得进去。
      titleArea.setTitle(label.length > 80 ? label.slice(0, 80) + '…' : label)
    }
    if (!prev || prev.muted !== t.muted || prev.isPlaying !== t.isPlaying) {
      applyAudioState(audioBtn, t)
    }
    // 权限标记：宿主保证「内容相同 → 同一个数组引用」，所以引用比较即可，
    // 无请求/未变化时在这条最热路径上是零 DOM 写入。
    if (!prev || prev.permissionIcons !== t.permissionIcons) {
      permissionMark.update(t.permissionIcons)
    }
    if (repaintColor) syncFaviconColor(row, parts.favicon, t)
  }

  /**
   * 行身份键：标签行与标签组行共用一张增量复用表，因此键必须互不冲突
   * （`tab:x` 与 `stack:x` 是两类东西，即使 id 字面相同也不该复用同一节点）。
   */
  function rowKey(item: TabRowItem | null | undefined): string {
    if (!item) return ''
    return item.type === 'stack' ? `stack:${item.stackId}` : `tab:${item.tabId}`
  }

  /**
   * 让出左侧「连线条槽」（见 injectTabRowStyles 的 .tabrow-stack-rail 一族）。
   * 两个对象都要让：**展开时的组行**（线与它连成一根脊）与**组内成员**。
   *
   * 为什么在组件里算而不是让调用方传：要不要缩进只取决于**这一个列表里有没有组行**
   * （固定标签面板传的是扁平列表，那里没有组头 —— 照样缩进就是一群没有归属的悬空行）。
   * 这是排版自身的事，不该外泄给调用方。
   * 每次都按目标值比对后再写，避免每轮刷新产生无意义的 DOM 写入。
   *
   * @param {HTMLElement|null} node 槽根（单行，或合体容器）
   * @param {boolean} indented
   */
  function applyStackIndent(node: HTMLElement | null, indented: boolean): void {
    if (!node) return
    if (node.hasAttribute('data-stack-indent') !== indented) {
      if (indented) node.setAttribute('data-stack-indent', '')
      else node.removeAttribute('data-stack-indent')
    }
  }

  // ── 标签组行（纵向列表里的"芯片"；对应 tabbar 的 .tab-stack-chip）─────────────
  function makeStackRow(stack: TabRowStack): StackRowParts {
    const row = doc.createElement('div')
    row.className = 'tabrow-row tabrow-row--stack'
    row.setAttribute('data-row', '')
    // 组行不参与拖动重排：组与组的合并走菜单「合并标签组」，
    // 把整组拖来拖去既容易误触，也没有对应的落库语义。
    row.draggable = false

    const arrow = doc.createElement('span')
    arrow.className = 'tabrow-stack-arrow'
    // 固定文件夹的身份标记（Folder）——普通标签组由 CSS 隐藏，不必来回插拔节点。
    const pin = doc.createElement('span')
    pin.className = 'tabrow-stack-pin'
    pin.appendChild(Folder(doc, { size: 12 }))
    const label = doc.createElement('span')
    label.className = 'tabrow-label'
    const count = doc.createElement('span')
    count.className = 'tabrow-stack-count'
    row.appendChild(arrow)
    row.appendChild(pin)
    row.appendChild(label)
    row.appendChild(count)
    return { row, arrow, pin, label, count, kind: 'stack' }
  }

  /** 仅写变化字段（与 applyRow 同一口径）。 */
  function applyStackRow(
    parts: StackRowParts,
    stack: TabRowStack,
    prev: TabRowStack | null
  ): void {
    const { row, arrow, label, count } = parts
    row.setAttribute('data-stack-id', String(stack.stackId))
    if (!prev || prev.collapsed !== stack.collapsed) {
      arrow.innerHTML = ''
      arrow.appendChild(stack.collapsed ? ChevronRight(doc, { size: 14 }) : ChevronDown(doc, { size: 14 }))
    }
    // 固定分组：数据属性既驱动 Pin 显隐 / 更实的底色，也让「兜底名」跟着 pin 走。
    if (!prev || !!prev.pinned !== !!stack.pinned) {
      if (stack.pinned) row.setAttribute('data-stack-pinned', '')
      else row.removeAttribute('data-stack-pinned')
      label.textContent = stackDisplayLabel(stack)
    }
    if (!prev || prev.label !== stack.label) {
      // 没命名时给一句兜底文案：空 label 会让组行只剩一个数字，认不出是什么
      label.textContent = stackDisplayLabel(stack)
    }
    if (!prev || prev.count !== stack.count) count.textContent = String(stack.count || 0)
    if (!prev || prev.accent !== stack.accent) {
      if (stack.accent) row.style.setProperty('--tab-stack-accent', stack.accent)
      else row.style.removeProperty('--tab-stack-accent')
    }
  }

  /**
   * 标签组菜单本体（共用件）：只出题（把状态翻译成菜单项、返回被点中的动作），
   * 不改任何 DOM。合并目标走子菜单列出**其它标签组** —— 用户不必知道、也记不住那个 uuid。
   */
  const openStackChipMenu = createStackChipMenu({
    showMenu: menuClient && typeof menuClient.popupMenu === 'function'
      ? async (payload) => menuClient.popupMenu!(payload)
      : undefined,
    getSiblings: () => currentTabs.filter((it) => it && it.type === 'stack') as unknown as StackMenuSibling[]
  })

  /**
   * 标签组行右键菜单 —— **模板与动作分派都取共用件**（`tab/chipMenu.ts`），
   * 与横向标签条芯片逐项一致：重命名 / 解散标签组 / 平铺成分屏 / 合并标签组 / 配色。
   *
   * ⚠ 上一版这份菜单是**就地手抄**的（注释里写着"与 TabStack.js 同一套做法"）——
   * 结果两端各写一份、各改一处：横向把「拆分标签组」写成了"点了没反应"的坏项，
   * 纵向也跟着有一份同样的坏项。现在只剩"重命名要在这一行上开输入框"这一件 DOM 事
   * 归本文件（`startStackRename`），其余全部共用。
   *
   * 重命名与合并**不用 `window.prompt`**：Electron 的渲染进程没有实现 prompt，
   * 调它只会静默返回 undefined（表现为"点了菜单什么也没发生"）—— 这是旧实现踩过的坑。
   */
  async function showStackMenu(
    x: number,
    y: number,
    stack: TabRowStack,
    row: HTMLElement
  ): Promise<void> {
    if (!menuClient || typeof menuClient.popupMenu !== 'function') return
    const found = currentTabs.find((it) => isStackItem(it) && it.stackId === stack.stackId)
    const item = isStackItem(found) ? found : stack
    const action = await openStackChipMenu(x, y, item)
    if (!action) return
    const outcome = runStackMenuAction(action, item, stackMenuHandlers as StackMenuHandlers)
    // 'rename' 是本列表唯一需要自己做的 DOM 事（行内输入框，见 startStackRename）
    if (outcome === STACK_MENU_RENAME) startStackRename(row, item)
  }

  /**
   * 行内重命名标签组：**机制整体归共用槽位**（`tab/renameSlot.ts`：换输入框 →
   * Enter/失焦提交、Esc 取消 → 换回原节点 → 掐断点击冒泡）。
   * 本列表只交出「行根 / 名称节点 / 初值 / 提交意图」与输入框的**行内口径**：
   * 类名沿用 `.tabrow-*`（宽度不设上限，行是全宽的）。
   */
  const rename = createRenameSlot(doc, {
    extraClasses: 'tabrow-stack-rename tabrow-label',
    inputStyle: 'border:none;outline:none;background:transparent;font:inherit;color:inherit;padding:0;min-width:0;'
  })

  function startStackRename(row: HTMLElement, stack: TabRowStack): void {
    if (!row) return
    const labelEl = row.querySelector<HTMLElement>('.tabrow-label')
    if (!labelEl) return
    rename.begin(row, labelEl, stack.label || '', (next) => onRenameStack(String(stack.stackId), next))
  }

  /**
   * 让某个标签组行进入行内改名（新建固定文件夹后由宿主立刻调用）。
   * 与网格形态的 `beginRenameFolder` 同一语义：数据刚推下来、行已就位时开始编辑。
   * @param {string} stackId
   * @returns {boolean} 是否找到了该组行
   */
  function beginRenameStack(stackId: string): boolean {
    const id = String(stackId == null ? '' : stackId)
    for (const rec of rowRecords.values()) {
      const item = rec.item
      if (item && item.type === 'stack' && String(item.stackId) === id) {
        startStackRename(rec.node, item)
        return true
      }
    }
    return false
  }

  /**
   * 跟随 favicon 取色（学 Hira `js/navbar/tabColor.js`）。
   *
   * 色值是异步来的（图片加载 + canvas 抽样），而行会被 keyed 复用、标签也可能中途
   * 导航到别的站 —— 用 `dataset.faviconUrl` 记下「这一行此刻代表哪张图」，结果回来时
   * 对不上就丢弃，绝不把 A 站的颜色画到 B 站的行上。
   */
  function syncFaviconColor(
    row: HTMLElement,
    faviconEl: HTMLImageElement | null,
    t: TabRowTab
  ): void {
    if (!faviconEl) return
    const faviconUrl = t.favicon || ''
    row.dataset.faviconUrl = faviconUrl
    applyFaviconColor(row, faviconUrl, !!t.active, () => (
      row.isConnected && row.dataset.faviconUrl === faviconUrl
    ))
  }

  function showEmpty(): void {
    if (emptyEl) return
    for (const [key, rec] of rowRecords) { removeRow(rec.node); rowRecords.delete(key) }
    clearPairs()
    emptyEl = doc.createElement('div')
    emptyEl.className = 'tabrow-empty'
    emptyEl.textContent = emptyTextOf() || ''
    wrap.appendChild(emptyEl)
  }

  function hideEmpty(): void {
    if (!emptyEl) return
    emptyEl.remove()
    emptyEl = null
  }

  /**
   * 本轮**是否真的重排**（已有行的相对顺序变了）—— 决定要不要跑 FLIP。
   *
   * FLIP（capturePositions + playSlide）只服务**重排让位**（拖拽换位）。而开/关标签
   * 这些高频动作不改已有行的相对顺序：行高塌陷/展开本身就是逐帧重排带动的，
   * 再叠一层 transform 纯属白付代价 —— 每次关闭都要付出 n 次强制布局（"顿一下"的来源）。
   *
   * 判据只看**子节点序列与投影**（零布局开销）：把 wrap 里"仍在表内"的行按顺序取键，
   * 与投影里同一批行的顺序逐位比对；完全一致 = 没有重排 = 不需要 FLIP。
   * 正在播关闭动效的行已出表（不在 rowRecords 里），因此不会被算进来。
   */
  function willReorder(list: readonly TabRowItem[]): boolean {
    const keyByNode = new Map<Element, string>()
    for (const [key, rec] of rowRecords) keyByNode.set(rec.node, key)
    const domSeq: string[] = []
    for (const el of wrap.children) {
      // 合体容器是**一个**排版槽位，但顺序比对要按成员展开 —— 否则容器内的
      // 成员换序会被当成"没有重排"，FLIP 就不播了。
      if (el.classList && el.classList.contains('tabrow-pair')) {
        for (const member of el.children) {
          const memberKey = keyByNode.get(member)
          if (memberKey) domSeq.push(memberKey)
        }
        continue
      }
      const key = keyByNode.get(el)
      if (key) domSeq.push(key)
    }
    if (domSeq.length === 0) return false
    const live = new Set(domSeq)
    let i = 0
    for (const item of list) {
      const key = rowKey(item)
      if (!live.has(key)) continue
      if (domSeq[i] !== key) return true
      i += 1
    }
    return i !== domSeq.length
  }

  // ── 增量渲染（对齐 HiraRT keyed 复用）──────────────────────────────────────
  // 旧实现每次 tab:changed 都全量重建所有行 + 重建 favicon，面板打开时每个页面事件
  // 都要重建整张列表；改为按 tabId 复用行、仅写变化字段。
  function setItems(tabs: readonly TabRowItem[]): void {
    const list = filter ? (Array.isArray(tabs) ? tabs : []).filter(filter) : (Array.isArray(tabs) ? tabs : [])
    currentTabs = list
    // 本轮渲染会把行逐个 diff / 重建 —— 正在编辑的重命名先就地收尾（提交），
    // 否则输入框会随节点消失，而槽位里那条"待收尾"还会在下次 begin 时被当成有效编辑。
    rename.commit()
    if (list.length === 0) {
      // 列表空 → 预览绝不能留在已被移除的行上（锚点消失 = 规则 ⑥）
      invalidatePreview()
      if (emptyTextOf()) showEmpty()
      else {
        for (const [key, rec] of rowRecords) { removeRow(rec.node); rowRecords.delete(key) }
        clearPairs()
      }
      // 组没了 → 连线条跟着消失（layout 按 stackId 回收，空投影只做清理）
      stackRail.layout(list)
      return
    }
    hideEmpty()
    // 记下重排前每行的位置（FLIP 的 First）：必须在本轮任何 DOM 改动之前量，
    // 否则量到的是"已经动过"的位置，反向偏移就错了。
    // **只在真的会重排时**才量（判据见 willReorder）—— 开/关标签不需要它。
    const posBefore = willReorder(list)
      ? capturePositions(Array.from(rowRecords.values(), (rec) => rec.node), 'y')
      : null
    const seen = new Set<string>()
    const newRows: HTMLElement[] = []

    // ── 标签组「连线条」的行标记（成员让出左侧槽，线由 stackRail 画在槽里）───────
    // 「哪些标签属于一个当前真的有组头的组」在**共用纯函数**里算（`stackMarks`）——
    // 横向标签条的 `.in-tab-stack` 用的是同一份，本列表不再就地推一遍
    //（那样两轴迟早一边变了另一边不变）。
    const stackMark = stackMarks(list, rowKey)

    // ── 分屏「合体」的槽位（纵向列表里"并排贴在一起"的那几行）─────────────────
    // 判据（谁和谁连成一段）由**共用件一趟扫描**产出（`splitMarks`，横向标签条的
    // 绘制层读的是同一份事实）；本列表只回答"怎么摆"：把每段 run 收进一个
    // `.tabrow-pair` 容器，于是它成为 wrap 里的**一个排版槽位**。
    // 3 分屏等多员段天然支持：容器内 N 等分，回形针 N-1 枚（见 pairElFor）。
    const splitMark = splitMarks(list, rowKey)
    const slots = buildSlots(list, splitMark.runs)

    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      const key = rowKey(t)
      let rec = rowRecords.get(key)
      if (!rec) {
        if (isStackItem(t)) {
          const parts = makeStackRow(t)
          rec = { kind: 'stack', parts, node: parts.row, item: null }
          applyStackRow(parts, t, null)
        } else {
          const parts = makeRow(t)
          rec = { kind: 'tab', parts, node: parts.row, item: null }
          applyRow(parts, t, null)
        }
        rowRecords.set(key, rec)
        newRows.push(rec.node)
      } else if (isStackItem(t)) {
        // key 前缀（stack: / tab:）保证同一 key 的节点类型不会变化。
        applyStackRow(rec.parts as StackRowParts, t, rec.item as TabRowStack | null)
      } else {
        applyRow(rec.parts as TabRowParts, t, rec.item as TabRowTab | null)
      }
      rec.item = t
      seen.add(key)
    }
    // 删除已消失的行（关闭标签 / 取消固定）—— 两阶段：先播塌陷动效，过渡结束才摘除
    let removedRows = 0
    for (const [key, rec] of rowRecords) {
      if (!seen.has(key)) {
        removedRows += 1
        // 正在 hover 的那一行被移除 → 规则 ⑥（收起 + 锁到指针真的动过）：
        // 下面几行会在指针没动的情况下上移，不能把它们补发的 mouseover 当新 hover。
        if (rec.node === hover.current()) invalidatePreview()
        // 先出表：同一 tabId 立刻回到列表时应当建新行，而不是复用这个正在消失的
        rowRecords.delete(key)
        animateRowExit(rec.node)
      }
    }
    // ── 就位：先成员、后槽位 ──────────────────────────────────────────────────
    //
    // 两段式的原因：合体容器内的成员位置与容器在 wrap 里的位置是**两个维度**——
    // 先把成员塞进各自的容器（成员之间也可能换序：拖拽 / 新分屏成员追加），
    // 再把容器整体摆到槽位顺序上。反过来做会被"容器还没就位"打乱锚点。
    //
    // 槽位根 = 合体容器（多员段）或单行本身；`ref` 一律取槽根 —— 于是排序逻辑
    // 与"没有合体"的时代逐字相同，只是把连续的多行折叠成了一个单位。
    const usedPairs = new Set<string>()
    for (const slot of slots) {
      // 槽根缩进：该槽里**只要有组内成员**，或它本身就是「展开且有成员」的组行 →
      // 整槽让出连线条的那条槽。缩进必须写在槽根（合体容器整体让），成员行再各让
      // 一次就是缩两次。用 some 而不是只看槽首：分屏与标签组交叉时，槽首可能不是成员。
      const indented = slot.keys.some((key) => stackMark.memberStackByKey.has(key))
        || stackMark.stackKeysWithMembers.has(slot.headKey)
      if (slot.keys.length < 2) {
        const rec = rowRecords.get(slot.headKey)
        applyStackIndent(rec ? rec.node : null, indented)
        continue
      }
      usedPairs.add(slot.headKey)
      const pairRec = pairElFor(slot)
      applyStackIndent(pairRec.el, indented)
      // 回形针在 DOM 里排在所有成员之后（成员插在它前面）；它同时充当成员就位的锚点。
      let memberRef = pairRec.clips[0] || null
      for (let i = slot.keys.length - 1; i >= 0; i--) {
        const rec = rowRecords.get(slot.keys[i])
        if (!rec) continue
        const node = rec.node
        applyStackIndent(node, false)
        if (node.parentNode !== pairRec.el || node.nextSibling !== memberRef) {
          pairRec.el.insertBefore(node, memberRef)
        }
        memberRef = node
      }
    }
    // 按目标顺序重排槽位（dropIndicator 恒为 wrap 首子节点，所有槽插在其后；未变项零操作）
    //
    // 关键：新建的行此刻**还没挂到 wrap 上**（makeRow 只造节点不 append），因此
    //   · node.nextSibling 恒为 null；
    //   · 当 ref 也恰为 null（队尾那一项）时，`nextSibling !== ref` 判定为 equal →
    //     直接跳过插入 → 该行永远不会进入 DOM。1 个标签时表现为整个列表空白。
    //   · 当 ref 非 null 时又会踩到 insertBefore 的第二参不在 wrap 内 →
    //     NotFoundError，异常打断整个 refresh，列表同样空白。
    // 所以必须把「当前不在正确父节点下」也视为需要插入，只有已就位的槽才跳过。
    //
    // 正在播关闭动效的行已从 rowRecords 出表、也不再算锚点（见 nextSiblingSkippingClosing）：
    // 拿一个马上要消失的节点当参照，会把其它槽推来推去（关最后一个标签时尤其明显）。
    let ref = addGapEl || addBtnEl || null
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i]
      const node = slot.keys.length > 1
        ? pairEls.get(slot.headKey)?.el
        : rowRecords.get(slot.headKey)?.node
      if (!node) continue
      if (node.parentNode !== wrap || nextSiblingSkippingClosing(node) !== ref) wrap.insertBefore(node, ref)
      ref = node
    }
    // 回收本轮没用到的容器（解散分屏 / 链头换了键 / 成员被拆走）
    prunePairs(usedPairs)
    // 滑动让位：把「因重排而换位」的行滑到新位置，而不是生硬瞬移。
    // 只在**本轮真的重排过**时才播（见 willReorder）—— 开/关标签的让位由行高过渡天然带动。
    // 正在播关闭/入场动画的行跳过 —— 它们自己有一套高度过渡，再叠 transform 会互相干扰（抖动）。
    if (posBefore && motionEnabled) {
      playSlide(posBefore, 'y', {
        skip: (node) => node.classList.contains('tabrow-row--closing') || node.classList.contains('tabrow-row--animating') || node.classList.contains(ROW_ENTER_CLASS)
      })
    }
    // 新行的入场动效（关键帧，见 animateRowEnter）：必须在**入 DOM 之后**挂类，
    // 否则动画会在节点还没被渲染时白白播完。首次填充不播。
    if (newRows.length) {
      if (rowsPrimed) for (const r of newRows) animateRowEnter(r)
      else rowsPrimed = true
    }
    // 连线条：本轮行都就位后先画一次（读真实矩形），再在动效窗口内逐帧跟住
    // —— 新行展开、滑动让位期间线必须跟着长/跟着挪，不能等动效结束才归位。
    //
    // ⚠ 只有**本轮真的可能改了行的几何**时才重画 + 续期跟踪：纯内容事件（标题、favicon、
    //   音频按钮、权限标记）不改行高，若照样 ping，有标签组的窗口在页面加载期会常驻
    //   逐帧测量。容器尺寸变化由 ResizeObserver、行高过渡由 transition 中继兜住。
    if (newRows.length > 0 || removedRows > 0 || posBefore) {
      stackRail.layout(list)
      stackRail.track(() => currentTabs)
    }
  }

  /**
   * 把键盘焦点交给搜索框（`searchable` 的宿主才有效）。
   *
   * 为什么由列表自己交出这个方法：搜索框是本组件建的（宿主看不见它），
   * 「打开就聚焦搜索框」这件事只能由本组件实施 —— 宿主只报意图（见 tabListHost）。
   * 顺带 `select()`：重开时旧查询被整体选中，直接敲字即替换（与查找栏同一手感）。
   * @returns {boolean} 是否真的聚焦成功（无搜索框 = false）
   */
  function focusSearch(): boolean {
    if (!searchInput) return false
    try {
      searchInput.focus()
      if (typeof searchInput.select === 'function') searchInput.select()
      return true
    } catch (_) { return false }
  }

  /**
   * 拆除本列表：宿主卸载时调用（见 tabListHost 的 dispose）。
   * 要收的三样：连线条层（含它注册到帧泵的 sink）、几何中继、容器尺寸观察者；
   * 其余全是 DOM 事件，随节点移除自然失效。
   */
  function dispose(): void {
    if (sizeWatch) sizeWatch.disconnect()
    unstickMotion()
    stackRail.dispose()
    pump.dispose()
  }

  return { element, setItems, focusSearch, beginRenameStack, dispose }
}
