// @ts-check
/**
 * 垂直标签栏的**样式** —— 只在这里往文档里写 <style>，且只写「骨架 + 把手 + 形态」这一层。
 *
 * 为什么单独成模块：样式是「能整体换掉」的东西（例：换成浮出卡片型侧栏要整套重画），
 * 而标签行的**全部样式**（行 / 标签组芯片 / 插入指示线 / 音频与关闭按钮 / 开合动效 /
 * 新建浮钮）在 `ui-common#injectTabRowStyles` 那份共享表里 —— 本文件只补「侧栏自己搭的
 * 那些容器」。于是「换宿主形态」与「换标签行内部」互不牵动。
 *
 * ⚠ 必须同时注入 `injectTabRowStyles` —— `createTabRowList` 只管造 DOM、
 * **不自注入样式**（与 opentabs 面板同一约定：谁挂载谁注入）。漏掉它的表现就是
 * 「标签列表全是裸 DOM」——这里曾经踩过。
 *
 * 反过来**不能**注入 `injectPanelStyles`：那份是面板视图（独立 WebContentsView）的
 * html/body reset 与全局 button 底色，本组件住在 chrome 视图里，注入会污染外壳。
 * 行样式真正依赖的基底只有两条（盒模型与按钮字体），下面自带。
 */

import { injectTabRowStyles, injectStripScrollerStyles } from '@hira-ng/ui-common'

export const STYLE_ID = 'hira-vertical-tabs-styles'

/** 骨架 / 把手 / 折叠态 / 最小基底 —— 与竖向三段一一对应。 */
export const VTABS_CSS = `
    /* ── 最小基底 ──────────────────────────────────────────────────────────
       面板视图有 injectPanelStyles 提供这两条，chrome 视图没有：
         · 盒模型 —— 行/按钮的 padding 与百分比宽度全靠它；
         · 按钮字体 —— .tabrow-label / .tabrow-btn 都是 button，不继承就变系统按钮字体，
           与面板里的同名列表看起来就不一样了。 */
    .vtabs, .vtabs * { box-sizing: border-box; }
    .vtabs button { font-family: inherit; }
    /* 侧栏内容：竖向三段 —— 顶部槽 / 标签列表 / 底部槽。铺满侧栏宽度与高度。 */
    .vtabs {
      display: flex;
      flex-direction: column;
      /* flex:1 而不是 height:100%：侧栏里可能不止本块（V1 下导航栏也在侧栏，
         在它上方）。100% 会按**整列高度**算基准高，与同列的另一块相加就溢出；
         flex 基准则让「吃满剩余高度」这件事由 flex 布局算，与兄弟块共存天然正确。 */
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      width: 100%;
      position: relative;
      background: var(--main-bg-color);
      color: var(--text-color);
      overflow: hidden;
      user-select: none;
      /* ── 整条侧栏**三态一律不吃窗口拖拽区**（关键，别改回 drag）───────────────
         图标条 / 悬停唤出 / 常驻占位共用这一个根元素，三种形态一条声明解决 ——
         不允许"某个形态再单独开一小块拖拽区"（那必然在行间隙、wrap 的 6px 槽、
         列表下方空白里挖出洞来）。

         为什么不给"空白处拖窗口"：-webkit-app-region: drag 命中的是**非客户区**，
         指针事件根本不进渲染进程 —— 于是行内边距、行与行之间那 1px、图标两侧的槽
         全都变成"标题栏"，点标签没反应、想把标签拖动却把窗口拖走（用户原话
         "每个 tab 自己的区域要撑满，而不是只有标题、icon 这一小块判定区"）。

         竖排模式拖窗口由顶部承担（导航栏 / sideHeader 的 drag 区），侧栏内容区
         整个让给标签交互 —— 看到什么就能点什么。 */
      -webkit-app-region: no-drag;
      /* ── 容器查询的**容器**：本元素宽度 = 侧栏区宽度 ──────────────────────────
         消费方是 apps 的 sidebar-surface（"侧栏窄了就只留图标"，见 @container side-column）。
         为什么挂这里、而不是挂在侧栏区本身（chrome 的 #chrome-side）：
         那个是**玻璃带**，而 containment 会截断它自己的 backdrop 采样 ——
         侧栏区就是这么丢掉毛玻璃的：全仓只有它"玻璃带 + containment"两样都占，
         表现也就是"这一带的模糊/颜色和其他 chrome 带对不上"。本元素不带玻璃，随便 contain。
         宽度口径仍然正确：.vtabs 宽度 = 侧栏区宽度（内容不参与定宽 ⇒ 藏掉名字
         不会反过来把"宽"判成"窄"；自测量写法会死锁）。 */
      container: side-column / inline-size;
    }

    /* 调宽把手：开在**朝内**那一侧（侧栏贴左 → 右缘；贴右 → 左缘）。
       侧别由布局容器打（data-region-side）—— 组件不问自己旁边是谁，只问自己贴哪边。
       4px 命中区、平时透明、hover/拖动时点亮；折叠态与不在侧栏时都不给拖。

       ⚠ 亮起来的那条线画在 ::after 上、**只有 1px**（与面板的 .panel-resize-handle 同款）：
       命中区 4px 是给手用的（再窄就不好抓），但整条 4px 一起点亮就是"一条很粗的蓝带"
       （用户原话）。两者分开之后，手感不变、观感回到一条细线 —— 全工程只有这一种调宽线的长相。 */
    .vtabs__handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 4px;
      cursor: col-resize;
      z-index: var(--hira-z-controls);
      background: transparent;
    }
    .vtabs__handle::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background: transparent;
      transition: background var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    /* 细线贴着**朝内**那条边（正是侧栏画分隔线的地方），与面板把手同一口径。 */
    .vtabs[data-region-side="left"] .vtabs__handle::after { right: 0; }
    .vtabs[data-region-side="right"] .vtabs__handle::after { left: 0; }
    .vtabs__handle:hover::after,
    .vtabs__handle[data-dragging="true"]::after {
      background: var(--hira-accent, var(--accent-color, #3b82f6));
    }
    .vtabs[data-region-side="left"] .vtabs__handle { right: 0; }
    .vtabs[data-region-side="right"] .vtabs__handle { left: 0; }
    .vtabs:not([data-region-side]) .vtabs__handle,
    .vtabs[data-collapsed="true"] .vtabs__handle,
    .vtabs[data-pinned="false"] .vtabs__handle {
      display: none;
    }

    /* ── 固定钮（「固定 / 悬停展开」）────────────────────────────────────────
       它**不自己占一行**：由 ui-vertical-tabs 交出（slots.pin），落点跟着空间切换器走
       —— Edge 型落在 .vtabs__top 里、全功能侧栏落在 .navbar-side-header 里，
       永远是「切换器前面那一颗」（见 ui-navbar#row/sideColumnPlan）。

       所以这里的样式必须**自包含**：不依赖祖先是谁、不写行级 padding / justify-content。
       26px 高度与空间切换器触发器（26px）、侧栏标题行里的窗控（28×26）同一口径，
       同一行里三件东西顶端对齐、连成一条。 */
    .vtabs__pin-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: var(--hira-radius-xs, 6px);
      background: transparent;
      color: var(--text-color-secondary, var(--text-color));
      cursor: pointer;
      -webkit-app-region: no-drag;
      transition: background var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
                  color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
    }
    .vtabs__pin-btn svg { width: 14px; height: 14px; display: block; }
    .vtabs__pin-btn:hover { background: var(--hover-bg-color, rgba(127, 127, 127, .16)); }
    /* 固定 = 点亮（与选中标签同一个强调色）；悬停展开 = 常态灰。图标只有一份。 */
    .vtabs__pin-btn[data-pinned="true"] { color: var(--hira-accent, var(--accent-color, #3b82f6)); }
    /* 图标条（56px）里收一档：22px 才放得下「22 按钮 + 2 缝 + 22 切换器」。
       判据是按钮**自己的** data-collapsed（host.js#syncVisual 打的）——
       它住在侧栏标题行时祖先是 .navbar-side-header 而不是 .vtabs，靠祖先选择器会失效。 */
    .vtabs__pin-btn[data-collapsed="true"] {
      width: 22px;
      height: 22px;
      border-radius: var(--hira-radius-2xs, 4px);
    }
    .vtabs__pin-btn[data-collapsed="true"] svg { width: 13px; height: 13px; }
    /* 固定钮**靠右**（用户口径：「固定按钮靠右」）：展开态里它推到所属那一行的最右端，
       空间切换器留在左端 —— 一行两件、各贴一边。
       图标条（56px）里不推：那里两件图标居中并排，推到两边会散成两颗孤岛。
       判据用祖先的 data-collapsed（住 .navbar-side-header 时由 sideHeader 的规则补同一句）。 */
    .vtabs:not([data-collapsed="true"]) .vtabs__pin-btn {
      margin-left: auto;
    }

    /* 顶部槽（空间切换器等由编排层搬进来；空着一块都不占） */
    .vtabs__top {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      min-width: 0;
      padding: 8px 8px 4px;
    }
    .vtabs__top:empty { display: none; }
    /* 标签列表（唯一的滚动区，吃满剩余高度）。
       滚动行为（竖轴可滚 / 横轴彻底禁滚 / 滚动条外观 / 滚轮换算）**不在这里** ——
       它与横向标签条共用同一份实现，见 @hira-ng/ui-common#stripScroller
       （host.js 装配处用 createStripScroller(body, 'y') 挂上）。本文件只管版式。
       顺带说明：共享行样式里「底部新建浮钮」是 sticky 相对**最近的滚动容器**钉底的，
       所以这里必须真的是个滚动容器（overflow: hidden 会让它钉在整列底部而不是可视区底部）。 */
    .vtabs__body {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      padding: 2px 0 4px;
      /* **永远预留滚动条那条槽**：滚动条（4px）一出现就会吃掉内容宽，
         于是行与底部「新建标签页」各自横跳 4px —— 用户要的是"有没有滚动条位置都一样"。
         预留之后，滚动条在不在，内容宽度都不变（滚动条画在那条槽里）。 */
      scrollbar-gutter: stable;
    }
    .vtabs__body > * { min-width: 0; }

    /* 面板行（借位槽）：全功能侧栏下，导航栏块把它的站点控制簇（面板按钮 + 菜单）搬进来，
       于是面板按钮落在「标签列表之下、底行之上」；本组件对它零知识 —— 只提供一个空槽
       （见 host.js 文件头）。空着时整行不占位：Edge 型垂直标签里导航栏在顶部，这一槽永远空，
       视觉与加槽之前逐像素一致。 */
    .vtabs__dock {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      /* 宽度护栏：面板插件多的时候折成两行，而不是被侧栏裁掉一行按钮。 */
      flex-wrap: wrap;
      min-width: 0;
      padding: 4px 8px 2px;
      border-top: 1px solid var(--border-color);
    }
    .vtabs__dock:empty { display: none; }
    /* 面板行在场时，它与底行之间不再画第二条分隔线（底行的上边线让位）。 */
    .vtabs__dock:not(:empty) + .vtabs__bottom { border-top: 0; }

    /* 底部槽（新建标签浮钮由列表自带；窗口控制按钮宿主为标签栏/纵排导航栏时落在这里） */
    .vtabs__bottom {
      display: flex;
      align-items: center;
      /* 两端对齐：新建标签贴左、窗口控制按钮贴右（两者各自 margin 也能做到，
         这里给一条兜底 —— 免得少了一个时剩下的那个跑到中间）。 */
      justify-content: space-between;
      /* 宽度护栏：容不下时折行而不是裁切（窄侧栏下 35px 新建 + 138px 窗控挤不进 134px）。 */
      flex-wrap: wrap;
      gap: 6px;
      flex: 0 0 auto;
      min-width: 0;
      padding: 4px 8px 6px;
      border-top: 1px solid var(--border-color);
    }
    .vtabs__bottom:empty { display: none; }

    /* 列表根的内侧留白：行的悬浮 / 选中底色不该贴到侧栏边缘。
       口径与同一列里的顶部槽 / 面板行 / 底行一致（6px）。
       加在**列表根**而不是行上：行的内边距是它自己的命中区，不能拿来当整体缩进
       （行内左右缩进会连带缩小可点区域）。 */
    .vtabs .tabrow-wrap { padding: 0 6px; }

    /* ── 图标条形态（data-collapsed="true"）──────────────────────────────────
       两个来源，由编排层折成这一个输入（本文件不判形态）：
         · 用户**显式折叠**（设置项 app.sidebar_collapsed）；
         · Edge 型自动隐藏的**静止态**（计划 revealOverlay === true）——
           此刻本条侧栏就是那条常驻 rail，展开是覆盖网页的独立浮层
           （renderer/sidebar-float），不是这里变宽。

       行高 / 图标尺寸与展开态 1:1；横向**居中**。组内成员保留 8px 缩进（组线不贴图标），
       图标在收窄后的行里继续居中。
       顶部槽（固定钮 + 切换器）也在这一态收边，见下方「窄条里的槽一起收边」。 */
    .vtabs[data-collapsed="true"] .tabrow-wrap {
      --tabrow-stack-gutter: 8px;
    }
    .vtabs[data-collapsed="true"] .tabrow-row {
      justify-content: center;
      padding: 0;
    }

    /* 图标条里**不预留滚动条槽**，滚动条本身也归零。
       56px 再被 scrollbar-gutter: stable 永久吃掉 4px，行就从 6..50 缩成 6..46，
       图标中心落到 26 —— 而竖条中心是 28 ⇒ **整列系统性左偏 2px**（用户原话
       "favicon 在底板中偏左上"）。图标条宽度固定，没有"滚动条一出现就横跳"
       的顾虑，所以直接归零（滚轮照常滚；展开态仍保留 stable，那里确实会横跳）。
       ⚠ 只能写 ::-webkit-scrollbar —— 写 scrollbar-width 会让整段定制失效。 */
    .vtabs[data-collapsed="true"] .vtabs__body {
      scrollbar-gutter: auto;
    }
    .vtabs[data-collapsed="true"] .vtabs__body::-webkit-scrollbar {
      width: 0;
      height: 0;
    }

    /* ── 图标条里只留图标 ────────────────────────────────────────────────
       隐藏文字、按钮、组计数（行内布局不在这里改）。 */
    .vtabs[data-collapsed="true"] .tabrow-row .tabrow-label,
    .vtabs[data-collapsed="true"] .tabrow-row .tabrow-btn,
    .vtabs[data-collapsed="true"] .tabrow-row .tabrow-stack-count {
      display: none;
    }
    /* 图标条下标签组行只剩箭头（它仍要能折叠/展开） */
    .vtabs[data-collapsed="true"] .tabrow-row .tabrow-stack-arrow { margin: 0; }

    /* 窄条里的三个槽一起收边：8px 的内边距会把可用的 56px 吃掉一半。
       槽里的内容一律居中，且**允许换行** —— 56px 横排放不下「新建 + 三个窗口控制按钮」，
       让它们自然折成竖排，好过横向溢出被裁掉（裁掉的按钮就点不到了）。 */
    .vtabs[data-collapsed="true"] .vtabs__top,
    .vtabs[data-collapsed="true"] .vtabs__dock,
    .vtabs[data-collapsed="true"] .vtabs__bottom {
      justify-content: center;
      /* 图标条已加宽到 56px（SIDEBAR_COLLAPSED_WIDTH）：留 4px 比原来的 2px
         更均衡，槽里的按钮不会贴着两侧的边框线。 */
      padding-left: 4px;
      padding-right: 4px;
    }
    .vtabs[data-collapsed="true"] .vtabs__top > *,
    .vtabs[data-collapsed="true"] .vtabs__dock > *,
    .vtabs[data-collapsed="true"] .vtabs__bottom > * {
      max-width: 100%;
      flex-wrap: wrap;
      justify-content: center;
    }
    /* 顶部槽在图标条里更紧一档：这一行住着「固定钮 22 + 切换器 22」——
       4px 边距 + 6px 缝会变成 22+6+22+8=58 > 56（溢出裁切）。
       收到 2px 边距 + 2px 缝：22+2+22+4 = 50，稳落在 56 里，
       剩下的 6px 由 justify-content:center 均分到两侧（与标签图标同一条中轴）。 */
    .vtabs[data-collapsed="true"] .vtabs__top {
      gap: 2px;
      padding-left: 2px;
      padding-right: 2px;
    }

    /* ── 展开态对齐图标条的图标列（图标条是基准，不反过来改它）──────────────
       图标块边长 = ui-common/tab/iconArea.ts 的 FAVICON_BOX（图标 18 + 白边 2×2 = 22）。
       改那一处常量时，下面的 11 / 7 / 4 要按同一条公式重算。
       图标条：wrap 左右各 6px → 行宽 44px → 22px 图标块在行内**居中** → x = 17（中心 28）。
       展开态行变宽，左内边距取 **11px**（6 + 11 = 17），图标落在同一个 x（中心同一列）。
       行的边框是 0（--tabrow-rail-frame: 0px），所以这里不需要再补 1px。
       组内成员 / 组头在图标条里是"缩进 8 + 在 36px 行内居中" → x = 21（中心 32）；
       展开态左内边距取 **7px**（6 + 8 缩进 + 7 = 21），同样回到 21。
       分屏半宽行（两枚标签并排）结构上无法与单行同轴，保持行自己的 4px。 */
    .vtabs:not([data-collapsed="true"]) .tabrow-row { padding-left: 11px; }
    .vtabs:not([data-collapsed="true"]) .tabrow-row[data-stack-indent] { padding-left: 7px; }
    .vtabs:not([data-collapsed="true"]) .tabrow-pair > .tabrow-row { padding-left: 4px; }

    /* 侧栏里的空态：一行提示 + 新建入口（列表自带空态文案，这里只调间距） */
    .vtabs .tabrow-empty { padding: 12px 8px; text-align: center; }
`

/**
 * 注入垂直标签栏样式（幂等）。
 * @param {Document} doc
 */
export function injectVerticalTabsStyles(doc: Document): void {
  injectTabRowStyles(doc)
  // 滚动区（与横向标签条**共用**的那一份实现）—— 见本包 host.js 的 createStripScroller(body,'y')。
  injectStripScrollerStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = VTABS_CSS
  doc.head.appendChild(style)
}
