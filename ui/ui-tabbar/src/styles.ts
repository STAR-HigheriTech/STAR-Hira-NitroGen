// @ts-check
/**
 * @hira-ng/ui-tabbar 的样式注入 —— **样式与结构彻底分离**。
 *
 * 为什么单独成文件：标签条的 CSS 有近 400 行（标签行 / 开合关键帧 / favicon 取色 /
 * 标签组芯片 / 下划线图层 / 拖拽指示线 / 行内编辑器 / hover 预览）。它与「谁造 DOM、
 * 谁接事件、谁跑增量渲染」没有一行关系 —— 摆在渲染逻辑里，改一个圆角要滚过整条
 * 渲染管线。现在：
 *
 *   · 宿主只调一次 `injectTabbarStyles(doc)`（幂等）；
 *   · 渲染模块（renderer / records）**完全不碰样式**，只负责造结构、挂状态类名；
 *   · 装饰层样式由插件侧模块 `components/decoration.js` 自带，这里汇总进来。
 *
 * 与 ui-navbar 同一范式（见 ui-navbar/src/styles.js）：各部件自带 CSS 常量，
 * 由汇总器拼成一份注入 —— 于是「加一个部件」不需要在这个文件里找位置插 CSS。
 */

import { injectCommonStyles, injectStripScrollerStyles, injectSplitClipStyles } from '@hira-ng/ui-common'
import { DECORATION_CSS } from './components/decoration.js'

/** 全局唯一注入锚点（幂等判据）。 */
export const STYLE_ID = 'hira-tabbar-styles'

/**
 * 标签条本体样式。
 *
 * ⚠ 写在模板字面量里的 CSS 注释**绝不能含反引号**，否则字符串会提前闭合：
 *   · 闭合点之后若还是 CSS 文本 → Rollup 报 `Expected ';', '}' or <eof>`；
 *   · 闭合点之后恰好接上一对括号 → 运行时变成「**那段 CSS** is not a function」。
 *   本文件踩过两次（第二次就是注释里给 `.vtabs` 加了反引号）——
 *   要在注释里强调选择器，用「.vtabs」或直接裸写，**不要用反引号**。
 */
const TABBAR_CSS = `
    #tabs {
      display: flex;
      flex: 1;
      min-width: 0;
      -webkit-app-region: drag;
      padding: 0 8px 0 16px;
      position: relative;
      box-sizing: border-box;
      background: var(--main-bg-color);
      /* 铺满整行（.navbar-top-row 是 align-items: center，不写这条就只按内容高 = 标签高）。
         这一步是标签组下划线的前提：标签条比标签高，标签正下方才会**空出一条凹槽**，
         下划线才有地方画 —— 否则它只能压在标签上（往上），或者伸出标签条被
         滚动容器的裁剪切掉（往下）。标签本身仍然垂直居中，位置一个像素都不变。 */
      align-self: stretch;
    }

    #tabs-inner {
      display: flex;
      align-items: center;
      /* 标签之间留一点点缝：密排时各自圆角边框不粘连，点击目标也更清楚 */
      gap: var(--ng-tab-gap-x, 2px);
      /* 宽度 = **内容宽**（标签不溢出时只占内容那么多），右侧剩下的空白留给
         #tabs::after（拖拽区，见下）；容器不够宽时它收缩到可用宽，在自己内部横向滚动。
         为什么不用 flex:1：那样它会吃掉整行，空白也就落在它自己的 no-drag 区里了。 */
      flex: 0 1 auto;
      min-width: 0;
      /* 滚动行为**不在这里**：主轴可滚 / 交叉轴彻底禁滚 / 滚动条外观 / 滚轮换算，
         横竖两种模式共用同一份实现 —— 见 @hira-ng/ui-common 的 stripScroller
         （装配处 index.js 用 createStripScroller(inner, 'x') 挂上）。本文件只管版式。 */
      /* 滚动条自己必须是**可交互**的：本元素在 #tabs 的拖拽区里，而 Chromium 把
         拖拽区当窗口非客户区 —— mousedown / click / hover 根本不进渲染进程。
         表现就是「横向滚动条点不到、拖不动，指针一移上去（:hover 收不到）滑块就消失」。
         故显式让出：本元素（含属于它的滚动条）不再吃窗口拖拽 ——
         让出的那部分空白由 #tabs::after 接回（见下）。 */
      -webkit-app-region: no-drag;
      /* 标签组下划线绘制层（见 .tab-stack-lines）要相对本容器绝对定位：
         绘制层留在**滚动容器内部**，横向滚动时下划线才跟着标签一起走。 */
      position: relative;
    }

    /* 标签右侧的空白 = **窗口拖拽区**（横向标签条自己的口径，与侧栏无关）。
       它是 #tabs 自己的 flex 项（不是滚动容器里的东西）：拖拽区**先于**交互控件算出来，
       语义最干净 —— 「容器是拖拽区、交互控件各自 no-drag」这条既有口径一字不改。
       为什么只有横向条需要它：纵向标签列（.vtabs）三态**整块 no-drag**（用户口径
       2026-10：「rail 还是展开态还是固定占位，都不要有拖动区域出现」），竖排时拖窗口
       由侧栏之外的行承担（顶部导航栏 / 标题栏 / 书签栏）；面板里的列表同样不该拖窗口。
       故这是**横向标签条自己的**一段版式。 */
    #tabs::after {
      content: '';
      flex: 1 1 0;
      min-width: 0;
      -webkit-app-region: drag;
    }

    /* 标签一律靠左排列。
       （曾用 #tabs-inner::before / ::after 两个 flex:1 占位把标签挤成动态居中，
       那是 Win11 的观感；此处按需求回归常规的靠左顺排 —— 滚动容器里的占位已全部移除，
       只剩上面那**一个挂在 #tabs 上的 ::after**，且它不是排版占位、而是拖拽区。
       于是标签从左侧起排，右侧的剩余空白仍然能拖窗口。） */

    /* ⚠ flex-shrink 必须是 1（**可被压缩**），这是「标签多了自动变窄」的唯一机制：
       width 是**偏好宽**（flex 收缩的基准），min-width 是压缩下限 —— 放不下时
       flex 布局会按比例把它们一起压窄（选中那个基准更宽，因此压完仍略宽），
       压到下限还放不下才轮到滚动（见 @hira-ng/ui-common#stripScroller）。
       配 flex-shrink: 0（旧值）的后果就是本行元素永远 140px、直接溢出成滚动 ——
       与 Edge / Chrome 的行为正相反。 */
    #tabs-inner > .tab-item {
      -webkit-app-region: no-drag;
      position: relative;
      z-index: var(--hira-z-elevated); /* 标签项（浮在其拖拽手柄等兄弟之上）= elevated */
      flex-shrink: 1;
    }

    /* 容器标签（N10）：用**别的 profile 身份**开的那一行，顶边一条身份色带。
       手法与 Firefox Multi-Account Containers 一致 —— 一眼可辨，又不占用横向空间。
       ⚠ 走 ::before 而不是新增子节点：标签内部的间距由 tabSizing 按固定那几个孩子
       压缩计算（见 components/Tab.js 的说明）；另外 ::after 已被 favicon 取色指示线占用，
       两者必须各用各的伪元素，否则会互相盖掉。 */
    .tab-item.container::before {
      content: '';
      position: absolute;
      left: 2px;
      right: 2px;
      top: 0;
      height: 2px;
      border-radius: 0 0 2px 2px;
      background: var(--container-color, #5b9bff);
      pointer-events: none;
    }

    .tab-item {
      /* 三档宽度：偏好宽（下面的 width）/ 压缩下限 / 上限。
         下限与偏好宽是**两个数**（见 tokens-base 里那组 token 的说明）——
         合起来才是 Edge 那种「多标签一起变窄、但不至于窄到点不中」的行为。 */
      min-width: var(--ng-tab-min-width);
      max-width: var(--ng-tab-max-width);
      width: var(--ng-tab-width);
      line-height: var(--ng-tab-height);
      height: var(--ng-tab-height);
      overflow: hidden;
      position: relative;
      display: flex;
      align-items: center;
      gap: var(--ng-tab-gap);
      padding: 0 var(--ng-tab-padding-x);
      background-color: transparent;
      border: 1px solid transparent;
      border-radius: var(--ng-tab-radius);
      box-sizing: border-box;
      /* 绘制隔离（contain: paint）：把本标签的重绘范围**关在自己家里**。
         为什么值得：开合动效是逐帧重排，没有它时引擎会在每帧把整条标签条的重绘
         一起算进去（实测：连发 4 个关闭时最差帧 20ms → 加它之后 8ms）。
         裁剪盒与上面那句 overflow: hidden **完全一致**（都是 padding box），
         所以观感一个像素都不变。 */
      contain: paint;
      /*
       * 动效基线（见 tokens-base 的 --ng-anim-*）：只挂真正需要过渡的属性。
       * width 是关键的一条 —— 选中态宽 160 / 普通 140，切换时宽度**滑过去**而不是跳过去；
       * 关闭/打开时，正在塌宽或展开的那一个标签会让后续标签逐帧重排，于是整条标签栏
       * 是连续滑动，而不是「啪」地瞬移（对齐 Hira 的全局 200ms 基线思路）。
       *
       * ⚠ min-width 必须在列表里（与 width 同一条曲线）：标签条**被压缩**时（标签多到
       *   放不下，见 view/tabSizing.js），每条标签的实际宽度是被 flex 压到**下限**上的 ——
       *   那时决定宽度的不是 width 而是 min-width。只过渡 width 的话，"选中/取消选中"
       *   换的是下限（选中下限 122 / 普通 90），宽度会**直接跳变**：表现就是
       *   「标签一多，切标签就没有滑动了，只有标签少时才有动画」。
       */
      transition:
        width var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease),
        min-width var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease),
        /* 只过渡 background-color（不是 background 简写）：本元素的背景永远是
           一个纯色（上面那几条状态规则全是变量/纯色，没有渐变与图片），收窄到单一
           长属性后，浏览器不必为"会不会有 background-image 插值"留后路 ——
           过渡项少一个、样式失效时的比对面也小一点。 */
        background-color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
        border-color var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease),
        /* transform 供拖拽重排的「滑动让位」用（FLIP，见 ui-common/flip.ts）：
           没有它，重排是瞬时位移；有了它，让位是滑过去的。 */
        transform var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease),
        opacity var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
      /* ⚠ 这里**没有** box-shadow：本元素从不设阴影（基态与关闭态都是 none，
         那一项是历史残留的死配置 —— 每次塌宽/展开多一条插值）。
         见 .tab-item.pinned 的 favicon 环：那是**子元素**的阴影，与本元素的过渡无关。 */
    }

    .tab-item:not(:last-child)::after {
      content: '';
      position: absolute;
      right: 0;
      top: var(--ng-tab-separator-inset);
      bottom: var(--ng-tab-separator-inset);
      width: 1px;
      background-color: var(--ng-tab-separator-color);
    }

    .tab-item:hover:not(.active) {
      background-color: var(--ui-hover, var(--hira-hover-bg, rgba(0, 0, 0, 0.06)));
      border-color: var(--ui-border, var(--hira-border-subtle, rgba(0, 0, 0, 0.1)));
    }

    .tab-item.active {
      width: var(--ng-tab-active-width);
      /* 选中标签有自己的**压缩下限**（比邻居宽一截）：压缩后它仍然明显更宽 ——
         这就是"当前标签"最省事的视觉锚点（见 tokens-base 里那两个下限 token）。
         平时（放得下时）它的宽度仍是上面的 --ng-tab-active-width，这条不生效。 */
      min-width: var(--ng-tab-active-min-width);
      background-color: var(--ng-tab-active-bg);
      border: 1px solid var(--ng-tab-active-border-color);
      color: var(--ng-tab-active-fg);
    }

    /*
     * **带音频/静音按钮的标签，下限再加一截**（见 tokens-base 的 --ng-tab-audio-extra）：
     * 那个按钮是图标区里**额外**的 20px（＋2px 缝），挤到普通下限时标题正好被它顶成 0 ——
     * "至少看得见第一个字"会在这类标签上失效。
     *
     * ⚠ 判定用**行上的类**（.has-audio，由 components/Tab.js 在音频按钮显隐时写），
     *   **不再用 :has(.tab-audio-button:not([hidden]))**。两个理由，都是实打实的：
     *   ① 性能：:has() 会让"标签内任何 DOM / 属性变化"都触发祖先的样式重算 ——
     *      页面加载期每一条标题 / favicon / 权限标记的更新都会命中，媒体标签一多
     *      就是整条标签条反复 recalc。类只在这一条标签真变化时切一次。
     *   ② 正确性（**关闭动画卡死的主因**）：:has() 把这条规则的特异度抬到 (0,3,0) /
     *      (0,4,0)，**高过** .tab-item.is-tab-closing（0,2,0）—— 于是带音频按钮的标签
     *      在关闭时 min-width 根本降不到 0，宽度只能塌到 90/122+20px 就卡住，
     *      等 180ms 过渡跑完被直接摘除（观感：媒体标签"关不掉、卡一下才消失"）。
     */
    .tab-item.has-audio {
      min-width: calc(var(--ng-tab-min-width) + var(--ng-tab-audio-extra));
    }
    /* 选中态另有一条（更宽的下限）：两条都在关闭规则之前，关闭态用 id 选择器压过它们。 */
    .tab-item.has-audio.active {
      min-width: calc(var(--ng-tab-active-min-width) + var(--ng-tab-audio-extra));
    }

    /*
     * ── 分屏「合体标签」（Edge 式）─────────────────────────────────────────
     * 两个分屏伙伴在标签条上**拼成一条标签**：各占半宽、内部接缝没有缝隙也没有
     * 圆角、整段总宽 = 一条普通标签 × --ng-tab-split-scale（1.45，见 tokens 的说明 ——
     * 纯 1.0 时半宽里的标题只剩一个字符），只有**外缘**保留标签圆角。
     *
     * 为什么不跟着选中态加宽：合体之后「一段」就是一条标签，再按 active 加宽会让两半
     * 一大一小（160/2 vs 140/2），接缝当场错位。于是整段一律取同一个偏好宽，
     * 选中与否只由底色 / 边框色表达（那两条规则不受影响）。
     *
     * ⚠ 本段必须排在 is-tab-closing 规则**之前**：那条同样用 #tabs-inner > .tab-item
     *   把宽度钉到 0，两者特异度相同，只能靠源码顺序取胜 —— 排到后面的话，关闭中的
     *   合体标签会塌不下去（宽度卡在半宽上直到被摘除）。
     * ⚠ 消缝用**负 margin 抵消 flex 的 gap**，而不是把 gap 写 0：gap 是密度压缩的动态值
     *   （--ng-tab-gap-x，2px → 0px，见 view/tabSizing.js），负 margin 引同一个变量才能
     *   一直贴合；写死 0 会让压缩态之外的普通标签也失去呼吸缝。
     */
    #tabs-inner > .tab-item.in-split-run {
      /* 三档宽度同乘 --ng-tab-split-scale —— tabSizing 用同一个系数折算基准宽与下限 */
      width: calc(var(--ng-tab-width) * var(--ng-tab-split-scale, 1.45) / 2);
      min-width: calc(var(--ng-tab-min-width) * var(--ng-tab-split-scale, 1.45) / 2);
      max-width: calc(var(--ng-tab-max-width) * var(--ng-tab-split-scale, 1.45) / 2);
      border-radius: 0;
      /* 半宽只有一整条的 1/2：内部留白与图标间距同步收紧，
         否则 favicon 底板(22，见 ui-common/tab/iconArea.ts) + 两条 8px 内缝
         + 关闭键(24) 就把标题挤成 0 宽。 */
      padding: 0 3px;
      gap: 4px;
    }
    #tabs-inner > .tab-item.in-split-run .tab-close-button {
      width: 20px;
      height: 20px;
    }
    #tabs-inner > .tab-item.in-split-run.split-run-first {
      border-top-left-radius: var(--ng-tab-radius);
      border-bottom-left-radius: var(--ng-tab-radius);
      /* 内部那条竖边由**右半**负责裁掉：两半各留 1px 会叠成一条 2px 的假缝 */
      border-right-width: 0;
    }
    #tabs-inner > .tab-item.in-split-run:not(.split-run-first) {
      /* 抵消 flex gap：负 margin 与 gap 用同一个变量，压缩到 0 时也严丝合缝 */
      margin-left: calc(-1 * var(--ng-tab-gap-x, 2px));
      border-left-width: 0;
    }
    #tabs-inner > .tab-item.in-split-run.split-run-last {
      border-top-right-radius: var(--ng-tab-radius);
      border-bottom-right-radius: var(--ng-tab-radius);
    }
    /*
     * 1px 分隔竖线（.tab-item::after）与 favicon 色条**共用** ::after，但两件事要分开处理：
     *   · 段内相邻的两半之间不能有竖线 —— 那正是"合体"的反面；
     *   · 段尾那一条竖线要留（它划的是本段与**下一条标签**的分界，与其余标签一致）；
     *   · 底部那条 favicon 色条就是用户要去的"下划线"—— 段内一律不画。
     */
    #tabs-inner > .tab-item.in-split-run:not(.split-run-last)::after {
      display: none;
    }
    #tabs-inner > .tab-item.in-split-run.has-favicon-color:not(.active)::after {
      display: none;
    }

    /*
     * ── 打开动效 ───────────────────────────────────────────────────────────
     * 新标签从「0 宽 + 全透明」展开到它自己的宽度。
     * 只写 from、不写 to：结束值自动取元素当前计算值 —— 于是普通标签收到 140、
     * 选中态收到 160，不需要为两种宽度各写一条关键帧。
     * 类名由 renderer 在节点真正入 DOM 之后挂上（见 animations.js 的 runEnter）。
     */
    @keyframes ng-tab-enter {
      from {
        width: 0; min-width: 0;
        /* 一并收到 0：border-box 下 padding/border 会撑出一个宽度下限，
           不清掉的话标签最多只能塌到 26px（左右 padding 12 + 边框 1）就卡住 */
        padding-left: 0; padding-right: 0;
        border-left-width: 0; border-right-width: 0;
        opacity: 0;
      }
    }

    .tab-item.is-tab-entering {
      animation: ng-tab-enter var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease);
    }

    /*
     * ── 关闭动效 ───────────────────────────────────────────────────────────
     * 关闭**不是**立刻 remove()：先挂上这个类塌宽 + 淡出，过渡结束后才由 JS 摘除
     * （两阶段删除，见 animations.js 的 runExit）。
     * 塌宽期间后续标签逐帧重排 → 「关掉一个、右边的滑过来」是连续的。
     *
     * ⚠ 选择器带 #tabs-inner >（而不是只写 .tab-item.is-tab-closing）：
     *   关闭态必须**无条件**压过所有会设 width / min-width 的状态规则 ——
     *   选中态 .tab-item.active 与"带音频按钮"的 .tab-item.has-audio.active 都会
     *   抬高下限；同特异度靠源码顺序只是运气，一旦有人在这些规则后面再加一条就又会卡住。
     *   id 选择器把"关闭就是宽度归零"钉成不可覆盖的一条（这也是媒体标签关闭卡顿的修法）。
     */
    #tabs-inner > .tab-item.is-tab-closing {
      width: 0;
      min-width: 0;
      /* 塌陷动效只需要两个属性 —— 这里**显式覆盖**上面那条完整过渡表。
         为什么必须收窄：标签塌陷是**逐帧重排**（每条标签的宽度都在变），
         过渡表里多一条就是每帧多一次插值 + 多一次样式失效；而 background-color /
         border-color / transform 在一条正在淡出的标签上毫无意义。
         其中 min-width 尤其要点名：它归零**不参与过渡**（直接生效）——
         否则压缩态下它会把塌陷卡在"下限"上（先等 min-width 降下来，宽度才跟着降），
         塌陷曲线会被拉长、与"点了就收"的手感相反。 */
      transition:
        width var(--ng-anim-base, 180ms) var(--ng-anim-ease, ease),
        opacity var(--ng-anim-fast, 120ms) var(--ng-anim-ease, ease);
      /* 同入场：padding/border 不清零，标签会卡在 26px 而不是塌到 0 */
      padding-left: 0; padding-right: 0;
      border-left-width: 0; border-right-width: 0;
      opacity: 0;
      pointer-events: none;
      background-color: transparent;
      border-color: transparent;
    }

    /* 拖拽期的能力提示（"松手在网页区域可分屏"）。
       只在一次拖拽里、且指针离开外壳视口时短暂出现 —— 用 viewport 坐标定位
       （position: fixed），因此不依赖标签条根是不是定位上下文。
       pointer-events: none 是硬要求：它压在手柄/按钮上时绝不能吃掉指针。 */
    .tabbar-drag-hint {
      position: fixed;
      /* 提示气泡：语义层 tooltip（原值 60）。 */
      z-index: var(--hira-z-tooltip);
      pointer-events: none;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      line-height: 16px;
      white-space: nowrap;
      color: var(--text-color, inherit);
      background: rgba(127, 127, 127, 0.18);
      border: 1px solid rgba(127, 127, 127, 0.28);
      opacity: 0.9;
    }

    /* ── 分屏「回形针」图层（两条相邻标签**之间**那道缝）────────────────────
       为什么是一层、而不是挂在标签里：回形针要跨在两条标签的边界上（左右各半），
       而 .tab-item 带 overflow: hidden（关闭时要塌宽裁住内容）—— 标签内部画不出
       任何越过自身边界的东西。层挂在滚动容器里，不属于任何标签，于是能居中跨在缝上。
       做法与标签组下划线层同源（stackLineLayer.js）。

       外观（尺寸 / 颜色 / 显隐语义）**不在这里** —— 它归 ui-common#splitClip 共用件，
       与纵向标签列用的是同一份（这正是"两种呈现、一套规则"）。
       本层只回答"摆在哪"：left / top 由 JS 按真实矩形逐帧写（见 splitClipLayer.js）。 */
    #tabs-inner .tab-split-clips {
      position: absolute;
      inset: 0;
      pointer-events: none;
      /* 与标签同层（标签是 elevated），靠 DOM 顺序取胜：层是 #tabs-inner 的子节点，
         挂在所有标签之后 —— 于是回形针压在标签底色之上，不会被选中态的整块底色盖掉。 */
      z-index: var(--hira-z-elevated);
    }
    #tabs-inner .tab-split-clips .tab-split-clip {
      position: absolute;
    }

    .tab-item .tab-icon-area {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }

    /*
     * favicon 的尺寸 / 跟随文字色的底板 / 内部页图标的"自带白底"**都不在这里** ——
     * 归共用件 ui-common 的 tab/iconArea.ts（FAVICON_GLYPH / PAD / BOX 常量，
     * 写成内联样式，横向标签条与纵向标签列消费同一份）。
     * 此前这里另写过一份 16 + 2×2：与纵向行那份各自漂移，就是
     * "侧栏图标比标签条小一圈"的来历。要调大小改那一处常量即可，不要再在这里加规则。
     */

    /*
     * ── 跟随 favicon 取色（学 Hira js/navbar/tabColor.js 的视觉）────────────────
     * 选中项：整块底色 = favicon 主色 + 按对比度选出的文字色 —— 两者都由 JS 写成
     *         inline style（见 ui-common/src/faviconColor.ts 的 paintFaviconColor）。
     * 未选中项：底部一条 2px 的该色指示线（Win10 任务栏风格），颜色走 --favicon-tab-color。
     *
     * 「一切无视深色模式压暗」：这两条规则**没有任何 body.dark 覆盖** —— 主色、白底、
     * 文字色在深浅色下完全一致。Hira 在深色下会把选中标签的 favicon 色抹成透明，
     * 这里按需求不做这件事。
     */
    .tab-item.has-favicon-color:not(.active) {
      border-color: transparent;
    }

    /* 指示线复用 ::after：这两个标签的分隔竖线让位给 favicon 色条（与 Hira 一致） */
    .tab-item.has-favicon-color:not(.active)::after {
      content: '';
      position: absolute;
      left: 8px;
      right: 8px;
      top: auto;
      bottom: 2px;
      width: auto;
      height: 2px;
      border-radius: 1px;
      background: var(--favicon-tab-color, rgba(148, 163, 184, 0.3));
      opacity: 0.5;
    }

    .tab-item .title-container {
      display: flex;
      position: relative;
      flex: 1;
      overflow: hidden;
      align-items: center;
    }

    .tab-item .title {
      display: block;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transform-origin: left center;
    }

    .tab-item .tab-close-button {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      /* 24px：命中区给足（原来是 20px，X 又只有 12px，太小不好点） */
      width: 24px;
      height: 24px;
      border-radius: var(--hira-radius-xs, 6px);
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      flex-shrink: 0;
      /* 默认不显示（见下面 :hover）—— 用 visibility + opacity 而不是 display:
         display:none 会让这 24px 在悬停瞬间长出来，标题被挤到截断、文字跳一下；
         visibility:hidden 保留占位，只做淡入淡出，鼠标划过时标题纹丝不动。 */
      opacity: 0;
      visibility: hidden;
      transition: background 0.15s, opacity 0.15s, visibility 0.15s;
    }

    /* 只有 hover 的标签才显示关闭按钮（对齐 Hira 的
       body:not(.touch) .tab-item .tab-close-button 规则）——
       常驻显示等于每条标签都挂个 X，密排时全是噪音。 */
    .tab-item:hover .tab-close-button {
      opacity: 0.6;
      visibility: visible;
    }

    .tab-item .tab-close-button:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.08));
      opacity: 1;
    }

    .tab-item .tab-audio-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      flex-shrink: 0;
      border-radius: var(--hira-radius-2xs, 4px);
      transition: background 0.15s;
    }

    .tab-item .tab-audio-button:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.08));
    }

    /* ── 固定标签（Pinned Tab）────────────────────────────────────────────
       固定 = 常驻可见的单体：只留图标，标题 / 关闭按钮 / 权限标记让位给
       "永远排在最前、永远不会被误关"。
       宽度写死而不是走 flex 收缩：固定标签通常个位数，宽度抖动比省几像素更刺眼；
       52px - 2 * 4px 内边距 = 44px 内容区，容纳 favicon 底板 22 + 缝隙 2 + 音频按钮 20。
       选择器权重刻意与 .tab-item.active / .has-audio 同级（0,2,0）且排在其后，
       于是固定标签的宽度与显隐不被活动态 / 出声态改写。 */
    .tab-item.pinned {
      width: 52px;
      min-width: 52px;
      max-width: 52px;
      padding: 0 4px;
      justify-content: center;
    }

    /* 标题整块撤掉（不是 visibility）—— 固定标签不存在"悬停时长出按钮把标题挤跳"的问题。 */
    .tab-item.pinned .title-container {
      display: none;
    }

    /* 固定标签不提供关闭按钮：单击切换、右键菜单仍可关闭，避免误点丢掉常驻页。 */
    .tab-item.pinned .tab-close-button {
      display: none;
    }

    /* 权限标记同样让位：固定标签的宽度只够一个图标 + 音频按钮。 */
    .tab-item.pinned .tab-permission-mark {
      display: none;
    }

    /* 固定标识：favicon 外一圈 accent 环，不额外占宽高（box-shadow 不参与布局）。
       这已经足够与普通标签区分，因此不再用 :has() 加"固定段分隔线" ——
       标签条上 :has() 的样式重算代价与特异度副作用在本文件另一处已有专门说明。 */
    .tab-item.pinned .tab-favicon {
      box-shadow: 0 0 0 1px var(--hira-accent, #3b82f6);
    }

    /* 「堆叠落点」高亮：把标签拖到另一个标签 / 组芯片上、语义是「并入这一组」时整块高亮。
       必须与「插入排序」的细线指示在视觉上明确区分 —— 否则用户分不清这一放
       是「插到它旁边」还是「和它堆成一组」。 */
    #tabs-inner .tab-item.is-stack-target,
    #tabs-inner .tab-stack-chip.is-stack-target {
      outline: 2px solid var(--hira-accent, #3b82f6);
      outline-offset: -2px;
      border-radius: var(--hira-radius-xs, 6px);
    }

    /* ── 标签组下划线（横向连成一条，不留断口）───────────────────────────────
       为什么不按「每个标签自己画一段下划线」来拼（Hira 的做法）：.tab-item 带
       overflow: hidden（关闭时要塌宽，必须裁住内容），伪元素伸不出自己的盒子 ——
       相邻标签之间那 2px 的 gap 就补不上，表现就是「线有断处」；而且每段还得靠
       负外边距互叠，缩放/取整稍偏一点就露缝。

       这里改成：在标签条内部铺一层绘制层，**每个标签组只画一条完整下划线**
       （芯片左端 → 最后一个成员的右端）。中间的空隙被同一条线天然盖住，
       所以任意时刻、任意缩放下都不存在断口。
       绘制层在滚动容器内部 → 横向滚动时线跟着标签走，不必监听 scroll。 */
    #tabs-inner .tab-stack-lines {
      position: absolute;
      inset: 0;
      pointer-events: none;
      /* 与标签同层（标签是 --hira-z-elevated），靠 DOM 顺序取胜：层恒为最后一个子节点，
         因此线压在标签底色之上 —— 选中标签是整块不透明底色，线若被它盖住就成了断的。 */
      z-index: var(--hira-z-elevated);
    }

    #tabs-inner .tab-stack-line {
      position: absolute;
      /* 画在「标签正下方那条凹槽」里（见 #tabs 的 align-self: stretch）：
         标签条比标签高出来的那几像素，就是这条线的专用位置 ——
         不压标签、不压边框、不压圆角，也不伸出标签条被裁。
         bottom / height / left / width 全部由 JS 逐帧写（见 stackLineLayer.js）。 */
      bottom: 0;
      height: 3px;
      border-radius: 1.5px;
      background: var(--tab-stack-accent, var(--hira-accent, #1a73e8));
      opacity: 0.9;
      /* **不要**给 left/width 加过渡：位置是逐帧量出来直接写上的（真实矩形），
         再加一层过渡等于给已经准确的值再补一段滞后动画。 */
    }

    /* ── 组内成员：底部交给「组下划线」，自己不再画细线 ──────────────────────
       成员不再画网站主题色的 2px 细线，也不画标签之间的 1px 分隔竖线：
       整个组由下方那一条组下划线统起来（对齐 Hira / Edge 的组内画法）。
       否则组内每个标签各带一条自家主题色细线，组的整体感会被切碎。 */
    #tabs-inner .tab-item.in-tab-stack::after {
      display: none;
    }

    /* 标签组 chip */
    #tabs-inner .tab-stack-chip {
      --_chip-accent: var(--tab-stack-accent, var(--hira-accent, #1a73e8));
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 28px;
      min-width: 32px;
      max-width: 140px;
      padding: 0 8px 0 6px;
      margin: 0 2px;
      border-radius: var(--hira-radius-xs, 6px);
      background: color-mix(in srgb, var(--_chip-accent) 15%, transparent);
      border: 1px solid color-mix(in srgb, var(--_chip-accent) 35%, transparent);
      cursor: pointer;
      -webkit-app-region: no-drag;
      user-select: none;
      position: relative;
      vertical-align: middle;
      flex-shrink: 0;
    }

    #tabs-inner .tab-stack-chip:hover {
      background: color-mix(in srgb, var(--_chip-accent) 25%, transparent);
      border-color: color-mix(in srgb, var(--_chip-accent) 55%, transparent);
    }

    #tabs-inner .tab-stack-chip .tab-stack-chip-bar {
      width: 3px;
      height: 16px;
      border-radius: 2px;
      background: var(--_chip-accent);
      flex-shrink: 0;
      opacity: 0.7;
    }

    #tabs-inner .tab-stack-chip .tab-stack-chip-arrow {
      font-size: 9px;
      color: var(--_chip-accent);
      line-height: 1;
      flex-shrink: 0;
      width: 10px;
      text-align: center;
    }

    #tabs-inner .tab-stack-chip .tab-stack-chip-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--_chip-accent);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 80px;
    }

    #tabs-inner .tab-stack-chip .tab-stack-chip-count {
      font-size: 10px;
      color: color-mix(in srgb, var(--_chip-accent) 70%, var(--text-color, #555));
      background: color-mix(in srgb, var(--_chip-accent) 12%, transparent);
      border-radius: var(--hira-radius-sm, 8px);
      padding: 0 5px;
      min-width: 16px;
      text-align: center;
      flex-shrink: 0;
    }

    /* ── 固定文件夹（Zen Essentials / 收藏夹语义）─────────────────────────────
       与普通标签组**同一枚芯片、两套皮**：普通组 = 色条 + 浅底（"一组标签"），
       文件夹 = Folder 图标 + 文件夹轮廓（"一只装标签的容器"）。用户要求两者一眼可分，
       所以差异必须落在**形状**与**左侧身份标记**上，而不是只换个颜色深浅：
         ① 隐藏左侧色条（色条是组身份的符号，文件夹用 Folder 图标）；
         ② 左上角收成小直角、其余三角圆角 —— 纸张/文件夹的轮廓读法；
         ③ 底色更实 + 一圈内高光，像一只立起来的文件夹，而不是一枚半透明色块。 */
    #tabs-inner .tab-stack-chip .tab-stack-chip-pin {
      display: none;
      align-items: center;
      justify-content: center;
      width: 13px;
      height: 13px;
      flex-shrink: 0;
      color: var(--_chip-accent);
      opacity: 0.95;
    }

    #tabs-inner .tab-stack-chip .tab-stack-chip-pin svg {
      width: 13px;
      height: 13px;
    }

    #tabs-inner .tab-stack-chip.tab-stack-pinned {
      border-radius: 2px var(--hira-radius-sm, 8px) var(--hira-radius-sm, 8px) var(--hira-radius-sm, 8px);
      padding-left: 7px;
      background: color-mix(in srgb, var(--_chip-accent) 24%, transparent);
      border-color: color-mix(in srgb, var(--_chip-accent) 52%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, #ffffff 18%, transparent);
    }

    #tabs-inner .tab-stack-chip.tab-stack-pinned:hover {
      background: color-mix(in srgb, var(--_chip-accent) 34%, transparent);
      border-color: color-mix(in srgb, var(--_chip-accent) 68%, transparent);
    }

    #tabs-inner .tab-stack-chip.tab-stack-pinned .tab-stack-chip-pin {
      display: inline-flex;
    }

    #tabs-inner .tab-stack-chip.tab-stack-pinned .tab-stack-chip-bar {
      display: none;
    }

    #tabs-inner .tab-stack-chip.tab-stack-pinned .tab-stack-chip-label {
      font-weight: 600;
    }
`


/**
 * 注入标签条样式（幂等）。宿主只需调一次 —— 与 `injectNavbarStyles` 同一口径。
 * @param {Document} doc
 */
export function injectTabbarStyles(doc: Document): void {
  injectCommonStyles(doc)
  // 滚动区（标签条与纵向标签列**共用**的一份实现）—— 与下面本包自己的样式一起注入。
  injectStripScrollerStyles(doc)
  // 分屏回形针的**外观与显隐语义**（横向标签条与纵向标签列共用一份）。
  // 本包只提供"摆在哪"的定位（见下面 .tab-split-clips 一族）。
  injectSplitClipStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `${DECORATION_CSS}\n${TABBAR_CSS}`
  doc.head.appendChild(style)
}

export { TABBAR_CSS }
