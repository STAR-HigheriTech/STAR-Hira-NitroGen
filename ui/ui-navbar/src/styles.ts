/**
 * 导航栏样式注入 —— 只在这里往文档里写 <style>，且**只写「块容器」这一层**。
 *
 * 为什么每个部件自带 CSS 常量、再在这里汇总：
 *   · 部件换掉（例：把地址栏换成命令栏）= 换一个模块的 import，别的文件一行不改；
 *   · 读某个部件的样式不必翻一个千行文件；
 *   · 「加一个部件」= 新文件 + 这里加一行 —— 与插件的扩展姿势一致。
 *
 * 本文件自己只负责两块**容器**的骨架（标签行 / 导航栏行）：它们不属于任何部件，
 * 而是「块」这一层的存在证明 —— 谁住进来都会被容器按行排版。
 */

import { injectCommonStyles } from '@hira-ng/ui-common'
import { ACTION_BUTTON_CSS } from './components/actionButton'
import { DRAG_HANDLE_CSS } from './components/dragHandle'
import { EXT_ACTIONS_CSS } from './components/extActions'
import { WINDOW_CONTROLS_CSS } from './components/windowControls'
import { NAV_CLUSTER_CSS } from './components/navCluster'
import { OMNIBOX_CSS } from './components/omnibox'
import { PANEL_BUTTONS_CSS } from './components/panelButtons'
import { PROGRESS_BAR_CSS } from './components/progressBar'
import { SIDE_HEADER_CSS } from './components/sideHeader'

const STYLE_ID = 'hira-navbar-styles'

/** 两个可被外部独立摆放的块 —— 本组件只保证「造好它们」，不假定二者的相对位置。 */
const CHROME_BLOCKS_CSS = `
    /* ── 两个可被外部独立摆放的块（拆自原 #navbar）────────────────────
       · #navbar-tabbar ：拖拽手柄 + 空间切换器 + 标签条槽 + 新建标签槽（可选窗口控制按钮）；
       · #navbar-toolbar：导航按钮 + 地址栏 + 面板按钮 + 菜单（导航栏块）。
       谁放在哪里、是否合并成一行、窗口控制按钮归谁，全部由编排层按 shared-types
       的摆放计划决定 —— 本组件只负责「造好这两块」，不假定二者的相对位置。 */
    #navbar-tabbar {
      display: flex;
      align-items: center;
      width: 100%;
      flex-shrink: 0;
      background: var(--main-bg-color);
      color: inherit;
      /* 高度 = 内容行高 + 顶部系统安全区（frameless 下的可拖拽余量） */
      height: calc(var(--ng-navbar-top-row-height) + var(--control-space-top));
      padding-top: var(--control-space-top);
      -webkit-user-select: none;
      position: relative;
      outline: none;
      z-index: var(--hira-z-controls); /* 浏览器 chrome 栏本体 = controls */
      overflow: hidden;
    }
    #navbar-tabbar::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: var(--control-space-top);
      -webkit-app-region: drag;
      z-index: var(--hira-z-base); /* 顶部窗口拖拽条（垫在导航控件之下）= base */
    }

    #navbar-toolbar {
      width: 100%;
      flex-shrink: 0;
      background: var(--main-bg-color);
      color: inherit;
      -webkit-user-select: none;
      position: relative;
      z-index: var(--hira-z-controls);
      /* 这里曾经是 overflow: hidden —— 它会**把窗口控制按钮的悬停底色削掉一截**：
         窗控按钮高 38px（= 整条 chrome 行的高度），而本行高 36px 且自带 2px margin-top，
         按钮要靠负 margin 上探到窗口最顶那 2px；一旦本行裁剪溢出，那 2px 就被切掉，
         表现就是"按钮明明贴边了，悬停底色却还差一点"（实测：rect 0→38，实际绘制 2.4→38）。
         删掉它是安全的：窗控的几何现在**正好落在本行所在 chrome-row 的 38px 之内**
         （见下方 #navbar-toolbar 的窗控定位规则），不再需要靠裁剪兜住溢出。
         注意这**不影响拖拽区**：拖拽区取的是本元素的边框盒绘制区域，
         与是否裁剪子元素无关。 */
      overflow: visible;
      /* 导航栏自己的**透明处**（按钮之间的缝、行末空白、内边距）就是窗口拖拽区。
         口径与标签条一致：拖拽区 = 本元素的绘制区域，交互控件各自 no-drag 覆盖其上
         （见下面的直接子元素规则）。
         为什么必须有：窗口是无边框的，"拖窗口"曾经只靠标签条与它的拖拽手柄 ——
         一旦标签栏进了侧栏（垂直标签，Edge 型），顶部这一行就只剩导航栏，
         窗口会变得几乎拖不动（只剩侧栏那条空白）。 */
      -webkit-app-region: drag;
    }

    /* ── 纵排宿主（侧栏）里的导航栏：**确定的行，与宽度无关** ─────────────
       · .navbar-side-header   ①标题行（空间切换器寄住；见 sideHeader.ts）
       · .navbar-bottom-center ②地址栏行
       · .navbar-actions-row   ③工具按钮行（导航簇 …… 面板簇）
       见 docs/vertical-tabs-architecture.md §4.2。标记由布局容器打（data-host-axis），
       本块只按它变形 —— 容器不认识导航栏内部，导航栏也不认识容器在哪里。

       为什么用 flex-direction: column + order 而不是「换行 + 独占行」的近似：
       换行的行数是**宽度决定的**（两段恰好挤得下就并成一行），形态会随侧栏宽窄漂移；
       而纵排形态在文档里是**确定的行**，与宽度无关。列的三个孩子一一对应那三行，
       靠 order 排序即可（① -2 / ② -1 / ③ 0）。 */
    #navbar-toolbar[data-host-axis="column"] {
      height: auto;
      flex-direction: column;
      align-items: stretch;
      padding: 4px 8px;
      margin-top: 0;
      /* 纵排宿主 = **侧栏**。侧栏里一律不吃窗口拖拽区（rail / 悬停展开 / 固定占位
         三种形态一视同仁）：drag 区是非客户区，指针事件根本不进渲染进程，
         行间 3px 缝、按钮之间的空白都会变成「点不动 + 拖窗口」的洞。
         上面 #navbar-toolbar 的 drag 只服务于**行区**（顶部导航栏），这里是它的唯一例外。 */
      -webkit-app-region: no-drag;
      /* 行与行之间 3px（设计稿 §3.2 的「行间 6px 留白」是**常规宽度**下的口径；
         窄列里按钮与行本身都小一号，6px 会显得比按钮还抢眼 —— 见
         docs/vertical-tabs-architecture.md §4.3「侧栏口径」）。
         用 row-gap 而不是 gap：行的划分与列无关，行内按钮间距仍归各自容器管。 */
      row-gap: 3px;
    }
    /* ② 地址栏独占一行（RT / Arc / Zen Single 的侧栏中部就是地址栏）。 */
    #navbar-toolbar[data-host-axis="column"] > .navbar-bottom-center {
      order: -1;
      flex: 0 0 auto;
      margin-left: 0;
    }
    /* ③ 导航行：只剩导航簇（← → ⟳ ⌂；rail 开关在最前 —— 见 railButtonPlacement）。
       面板簇已借住到侧栏底行的 dock 槽（见 row/sideDock.ts）—— 它不在这里，
       所以纵排下「一排工具」不会再被两簇挤爆（200px 侧栏可用宽 184px，而两簇相加 268px+）。
       下面那条 bottomRight 规则是**回落**：没有 dock 可借时（标签栏不在侧栏）它照旧贴右。 */
    #navbar-toolbar[data-host-axis="column"] > .navbar-actions-row {
      order: 0;
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      width: 100%;
      gap: var(--ng-navbar-column-gap);
      margin-left: 0;
      /* 宽度护栏：窄侧栏（150px → 可用 134px）下导航簇自身也会超出可用宽 ——
         折成两行而不是被 #navbar-toolbar 的 overflow:hidden 裁掉几颗按钮。 */
      flex-wrap: wrap;
      row-gap: var(--ng-navbar-column-gap);
      /* 这一行住在**侧栏**里 —— 侧栏三态（rail / 悬停展开 / 固定占位）一律不吃
         窗口拖拽区（用户口径 2026-10：「rail 还是展开态还是固定占位，都不要有
         拖动区域出现」）。拖窗口交给侧栏之外的行（顶部导航栏 / 标题栏 / 书签栏）。 */
      -webkit-app-region: no-drag;
    }
    #navbar-toolbar[data-host-axis="column"] > .navbar-actions-row > .navbar-bottom-left,
    #navbar-toolbar[data-host-axis="column"] > .navbar-actions-row > .navbar-bottom-right {
      flex: 0 0 auto;
    }
    /* 导航簇自己是「一排按钮」的容器 —— 上面的护栏要能折行，必须它也允许折行
       （行容器允许折行但内部单块不允许，等于没折）。 */
    #navbar-toolbar[data-host-axis="column"] #toolbar-navigation-buttons {
      gap: var(--ng-navbar-column-gap);
      flex-wrap: wrap;
      row-gap: var(--ng-navbar-column-gap);
    }
    /* 纵排的地址栏：**输入框独占一行**，站点控制件（权限铃 / 内容拦截 / 收藏星 / 转到）
       折到它下面那一行 —— 134px 宽的栏里，输入框与这四颗按钮挤在同一行等于两边都残废
       （输入框只剩几十像素、按钮还得一路缩尺寸缩间距）。
       为什么用折行而不是把按钮搬去别处：这四件都是"**当前这个页面**"的动作（权限、
       拦截、收藏、转到），语义上就该跟着地址栏走；一行放不下就换行，不搬家。
       PC 上的宽导航栏仍是原来的一行（本条只在纵排生效）。 */
    #navbar-toolbar[data-host-axis="column"] .omnibox {
      max-width: none;
      width: 100%;
      flex-wrap: wrap;
      gap: var(--ng-navbar-column-gap);
      row-gap: var(--ng-navbar-column-gap);
    }
    /* flex-basis 100% ⇒ 输入框一定占满第一行，按钮随之被挤到第二行 */
    #navbar-toolbar[data-host-axis="column"] .omnibox > #address-input {
      flex: 1 1 100%;
    }

    /* ── 窄列里的按钮**收一档**（30 / 图标 17，取值在 token 里）───────────
       两个宿主共用同一份规则，因为它们同属「侧栏里的按钮」这一件事：
         ① 纵排的导航栏块内部（导航簇 / 地址栏里的星标·权限铃 / rail 开关）；
         ② 借住到侧栏底槽的按钮簇 —— 它**不在导航栏块里**（面板簇被 sideDock 搬进了
            标签栏块的 slots.dock），故不能靠上面那条后代选择器命中，要按
            row/sideDock.ts 打的 data-dock 标记再写一段。
       取值只有一处（tokens 的 --ng-navbar-action-btn-size[-icon]-column）：
       26 / 28 嫌小、30 / 32 嫌大，落在 29 —— 想再动就改那一行，别在这里写死。

       图标是 svg 的 width/height **属性**，按标准行为可被 CSS 覆盖 ——
       ui-common#icons 本身就是「返回 svg，尺寸/颜色交给调用方（CSS）」的口径，
       所以这里不必回 JS 改每一处写死的 size。 */
    #navbar-toolbar[data-host-axis="column"] .navbar-action-button,
    .navbar-bottom-right[data-dock="true"] .navbar-action-button {
      width: var(--ng-navbar-action-btn-size-column);
      height: var(--ng-navbar-action-btn-size-column);
    }
    #navbar-toolbar[data-host-axis="column"] .navbar-action-button > svg,
    .navbar-bottom-right[data-dock="true"] .navbar-action-button > svg {
      width: var(--ng-navbar-action-btn-icon-size-column);
      height: var(--ng-navbar-action-btn-icon-size-column);
    }

    .navbar-top-row {
      display: flex;
      align-items: center;
      height: var(--ng-navbar-top-row-height);
      width: 100%;
      flex-shrink: 0;
      padding-left: var(--control-space-left);
      padding-right: var(--control-space-right);
      box-sizing: border-box;
      /* 窗口控制按钮簇寄住本行时**贴住窗口角**（Windows 原生：悬停底色铺到边缘）。
         本行右侧留了多少，就由这一行自己报出去，由窗控簇反向抵消 ——
         见 ui-common#windowControls 的「贴边与间距」。 */
      --ng-window-controls-bleed: var(--control-space-right);
    }

    .navbar-bottom-row {
      display: flex;
      align-items: center;
      height: var(--ng-navbar-bottom-row-height);
      width: 100%;
      flex-shrink: 0;
      gap: var(--ng-navbar-bottom-row-gap);
      padding: 0 var(--ng-navbar-bottom-row-padding-x);
      margin-top: var(--ng-navbar-bottom-row-margin-top);
      box-sizing: border-box;
      /* 同上（navbar-top-row）：窗控按钮要贴住窗口角，本行把自己的右侧留白报出去。 */
      --ng-window-controls-bleed: var(--ng-navbar-bottom-row-padding-x);
    }

    /* 工具按钮包裹行（横排形态）：**它自己不占位置** —— display:contents 让两簇直接
       成为导航栏的布局项，靠 order 回到「左 / 中 / 右」。纵排时它会变成真实的 flex 行
       （见上方 column 规则）—— 同一份 DOM 的两种形态，见架构文档 §4.3。 */
    .navbar-actions-row {
      display: contents;
    }
    .navbar-bottom-left { order: 1; }
    .navbar-bottom-center { order: 2; }
    .navbar-bottom-right { order: 3; }

    /* 横排导航栏里的窗口控制按钮 = **整行最右**。
       为什么必须显式给 order：它是被**搬**进来的（落点由 row/windowControlsPlacement
       判定），没有 order 时落到缺省的 0 —— 排在导航簇（order:1）之前，表现就是
       「设成导航栏后按钮跑到最左边」。给一个比 .navbar-bottom-right 更大的 order，
       它就钉在整行末尾（与 Edge / Chrome 一致：窗控在浏览器按钮之后的最右端）。
       纵排（侧栏）不走这里：那时按钮归侧栏顶行，见 components/sideHeader.ts。 */
    #navbar-toolbar:not([data-host-axis="column"]) > .navbar-top-right-actions {
      order: 4;
      /* 顶部也贴边（左右由窗控簇自己按 --ng-window-controls-bleed 抵消）。
         Windows 标题栏按钮从**窗口最顶**一直铺到行底，留 1~2px 就明显"浮着"。
         而本行是 align-items: center + margin-top 留白：38px 的按钮在 36px 的行里被居中，
         结果是上边差 1px、下边差 1px。故这里把整簇钉到行的上沿，再把行自己的
         margin-top 吃掉 —— 于是按钮正好从 0 铺到行底，上下都贴边。
         纵排（侧栏顶行 = 红绿灯）不走这里：那条分支被 :not([data-host-axis="column"]) 挡住。 */
      align-self: flex-start;
      margin-top: calc(var(--ng-navbar-bottom-row-margin-top, 0px) * -1);
    }

    .navbar-bottom-left {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    /* 单行（精致）模式下导航按钮组被搬进顶行，左区随之空掉 —— 空容器不能占位，
       否则 .navbar-bottom-row 的 gap 会在地址栏左侧多留出一条 4px 的缝。 */
    .navbar-bottom-left:empty {
      display: none;
    }

    .navbar-bottom-center {
      display: flex;
      align-items: center;
      /* 地址栏有宽度上限（tokens#--ng-omnibox-max-width）：宿主把剩余空间均分到两侧，
         而不是全部堆在地址栏右边 —— 否则上限一到，右侧就多出一大块死白。 */
      justify-content: center;
      flex: 1;
      min-width: 0;
    }

    .navbar-bottom-right {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      margin-left: auto;
    }

    /* 两行的**直接子元素**一律让出窗口拖拽（**行区**容器本身是 drag 区，见 #navbar-toolbar；
       纵排住进侧栏时容器已经整体 no-drag，这条在那里是冗余但无害的兜底）。
       注意只覆盖直接子元素：再深一层是各部件自己的域，它们各自带 no-drag。 */
    .navbar-top-row > button,
    .navbar-top-row > div,
    .navbar-bottom-row > div,
    .navbar-bottom-row > button,
    /* 工具按钮包裹行里的两簇在横排下被 display:contents 「提升」为导航栏的直接布局项，
       故此处必须一并让出拖拽 —— 否则按钮一齐变成窗口拖拽区，点不动。 */
    .navbar-actions-row > div,
    .navbar-actions-row > button {
      -webkit-app-region: no-drag;
      flex-shrink: 0;
      position: relative;
      z-index: var(--hira-z-controls); /* 导航栏内交互控件（按钮/行容器）= controls */
      cursor: default;
    }

    /* 地址栏行是**容器**，不是控件 —— 它吃下地址栏之外的全部余量，那部分余量是**空白**，
       必须是窗口拖拽区。上面的「直接子元素一律 no-drag」是把"行里的按钮簇"当控件让位，
       对这一个子元素是误伤：地址栏加上限（--ng-omnibox-max-width）之后，
       窗口越宽，中间这块死白就越大，整条标题行反而拖不动了（用户口径）。
       行内的真控件各自已声明 no-drag（.omnibox__field / 扩展动作 / 收藏星），洞不会被填掉。
       纵排（侧栏）不走这条：那里整块 no-drag（见上面的 column 规则）。 */
    #navbar-toolbar:not([data-host-axis="column"]) > .navbar-bottom-center {
      -webkit-app-region: drag;
    }

    /* 「新建标签」的常驻槽：**始终住在标签栏**（标签条右侧），与窗口控制按钮彻底分开 ——
       后者会按设置去标签栏 / 导航栏 / 标题栏，而新建标签永不离开标签栏。 */
    #navbar-add-tab {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    #add-tab-button {
      width: var(--ng-navbar-add-tab-width);
      font-size: var(--ng-navbar-add-tab-font-size);
    }
`

/** 按钮编辑模式的样式契约（登记表与编辑浮层共用；见 toolbarRegistry）。 */
const BUTTON_EDIT_CSS = `
    /* 被编辑浮层收走的按钮：直接不显示（不留空位）。 */
    .hira-toolbar-hidden {
      display: none !important;
    }

    /* 按钮编辑模式：可编辑按钮交给编辑浮层去画（浮层按上报的几何原样克隆它们，
       做到「进编辑模式视觉上不跳」）。visibility 而非 display —— 几何必须仍可测。

       判据挂在 hira-buttons-editing（由编排层打在 body 上）而不是某个块容器上：
       可编辑按钮**不保证住在同一个块里** —— 纵排时面板簇借住到了标签栏块的 dock 槽
       （见 row/sideDock.ts），若按「#navbar-toolbar 的后代」来判，那一排按钮就隐不了身，
       会在浮层背后露出来。编辑模式是**外壳级**状态，不是某一块的状态。 */
    body.hira-buttons-editing .hira-toolbar-item {
      visibility: hidden;
    }
`

/**
 * 注入导航栏样式（幂等）。
 * @param {Document} doc
 */
export function injectNavbarStyles(doc: Document): void {
  injectCommonStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    CHROME_BLOCKS_CSS,
    BUTTON_EDIT_CSS,
    ACTION_BUTTON_CSS,
    DRAG_HANDLE_CSS,
    EXT_ACTIONS_CSS,
    WINDOW_CONTROLS_CSS,
    NAV_CLUSTER_CSS,
    OMNIBOX_CSS,
    PANEL_BUTTONS_CSS,
    PROGRESS_BAR_CSS,
    SIDE_HEADER_CSS
  ].join('\n')
  doc.head.appendChild(style)
}
