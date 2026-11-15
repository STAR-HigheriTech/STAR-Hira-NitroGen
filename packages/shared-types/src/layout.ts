/**
 * layout.mjs —— 窗口 chrome 布局的**唯一真源**
 *
 * 模型分三层：**块（block）** → **区域（region）** → **轴（axis）**。
 *
 *   四种块 —— 外壳里四块互不相识的哑块：
 *     tabbar       标签栏（拖拽手柄 + 空间切换器 + 标签条 + 新建标签 + 可选窗口控制按钮）
 *     navbar       导航栏（后退/前进/刷新 + 地址栏 + 面板按钮 + 菜单）
 *     titlebar     标题栏（网页标题，可开关）
 *     bookmarkbar  书签栏
 *
 *   三个区域 —— 每块**各自**选一个（`positions`），互不牵连：
 *     top / bottom 行区（每个独立 bar 各占一行；顺序由 rowOrder 决定）
 *     side         侧栏区（纵排：多块只会上下堆叠，永不合并）
 *
 *   ★ 「默认布局 vs 垂直布局」不是一种模式枚举，而是**推导结果**：
 *     没有任何块选 `side` → 侧栏区不渲染（与历史版本逐像素一致）；
 *     有块选 `side`      → 侧栏区激活，窗口进入垂直布局。
 *     「垂直标签（Edge 型）」= 只有 tabbar 选 side；
 *     「垂直标签（全功能侧栏）」= tabbar 与 navbar 都选 side。
 *     两者只是同一套映射的两个**预设**（LAYOUT_PRESETS），不是两条代码路径。
 *
 *   两种行区模式：
 *     default      四块各自成行，按各自的区域与共用的顺序表摆放；
 *     compact      紧凑模式 —— 只改变间距策略，tabbar 与 navbar 永远保持两个独立 block。
 *
 * 摆放计划（plan）由 planChromeLayout(state) 产出：它只回答「哪一块落哪个区域、
 * 同一区域内谁先谁后、窗口控制按钮归谁」，不碰 DOM。渲染层（ui-chrome-layout）
 * 按计划摆 DOM —— 于是「加一种摆法」= 改本文件的一个函数，不动任何块内部。
 *
 * 为什么放在 shared-types：主进程（CJS require：写默认值 / 渲染设置页 options）
 * 与渲染层（ESM import：实际摆放）必须读同一份真源。本文件是 `.mjs`；
 * Electron 43 运行时为 Node 24，`require()` 可直接加载 ESM。
 *
 * 职责边界：不碰 DOM、不查库、不认识任何具体元素。
 */

export type LayoutMode = 'default' | 'compact'
export type RowPosition = 'top' | 'bottom' | 'side'
export type ChromeRow = 'tabbar' | 'navbar' | 'titlebar' | 'bookmarkbar'
export type WindowControlsHost = 'tabbar' | 'navbar' | 'titlebar'

/** 设置页下拉的 [值, 中文名]；顺序即展示顺序。 */
const LAYOUT_MODE_OPTIONS = Object.freeze([
  ['default', '默认'],
  ['compact', '紧凑（栏位独立）']
])

/** 缺省模式（等同于历史版本的行为：各行独立摆放）。 */
const DEFAULT_LAYOUT_MODE = 'default'

/** 所有块的规范 id（也是默认顺序）。 */
const CHROME_ROWS: readonly ChromeRow[] = Object.freeze(['tabbar', 'navbar', 'titlebar', 'bookmarkbar'])

/** 同侧相对顺序的缺省：标签栏 → 导航栏 → 标题栏 → 书签栏。 */
const DEFAULT_CHROME_ROW_ORDER: readonly ChromeRow[] = Object.freeze(['tabbar', 'navbar', 'titlebar', 'bookmarkbar'])

/**
 * 侧栏区内的缺省顺序。
 *
 * 与行区相反（行区是标签栏在前）：侧栏里导航栏在上、标签列表在下 ——
 * 这与 RT / Arc / Zen Single Toolbar 的侧栏从上到下一致
 * （空间与地址栏在顶、标签列表吃剩余高度、工具区在底）。
 *
 * ⚠ 表里的 bookmarkbar 一项现在**用不到**：书签栏按能力矩阵不能住侧栏（见 CHROME_ROW_REGIONS）。
 *   留着是为了"顺序表列全所有块"这一整齐性，将来若要恢复也只改矩阵一行。
 */
const DEFAULT_SIDE_ROW_ORDER: readonly ChromeRow[] = Object.freeze(['navbar', 'tabbar', 'bookmarkbar', 'titlebar'])

/**
 * 窗口控制按钮的**实现样式**：'native'（强制系统原生）/ 'custom'（应用自绘）。
 *
 * 两态、无推导 —— 用户选什么就是什么：
 *   · native = 启用 WCO（Window Controls Overlay），三颗按钮由**操作系统**画在窗口
 *     右上角（Win11 下自带 Snap Layouts：悬停最大化弹出窗口布局预览，自绘永远做不到）。
 *     系统按钮**去不了**其它位置，因此这种样式下 `app.window_controls_host` 不再有意义 ——
 *     按钮恒在右上角，应用侧不再自绘任何一颗。垂直布局（标签栏 / 导航栏进侧栏）时同理。
 *   · custom = 应用自绘，落点由宿主设置决定（旧行为，任何布局都成立）。
 *
 * ⚠ 建窗期决定：Windows 上 WCO 只能在 `new BrowserWindow` 时启用
 * （`setTitleBarOverlay` 只能换已启用 overlay 的样式，无运行时开关），
 * 所以改这一项**下次开窗口生效**（当前窗口不重建）。
 */
const WINDOW_CONTROLS_STYLE_OPTIONS = Object.freeze([
  ['native', '系统原生（强制）'],
  ['custom', '应用自绘']
])
const DEFAULT_WINDOW_CONTROLS_STYLE = 'native'

/**
 * **系统窗口按钮带的高度**（WCO 的 `titleBarOverlay.height`）。
 *
 * ⚠ 必须等于**顶部 chrome 行高**（CSS 变量 `--ng-navbar-top-row-height`，同为 38px）：
 *   系统把三颗按钮**垂直居中**在这条带子里，而带子是从窗口最顶开始算的 ——
 *   两个数一旦不等，按钮的垂直中心就与行内控件（标签 / 地址栏…）错开，
 *   表现就是「按钮比所有控件都高一截、整片顶部像贴死在窗口上沿」。
 *   所以这个数只能有一份：主进程拿它声明 overlay，CSS 那个 token 是它的镜像，
 *   改一个必须改另一个（两处注释互相指名）。
 */
const WINDOW_CONTROLS_OVERLAY_HEIGHT = 38

/** 顺序表项的 [id, 中文名]（设置页「各栏上下顺序」用）。 */
const CHROME_ROW_ORDER_OPTIONS = Object.freeze([
  ['tabbar', '标签栏'],
  ['navbar', '导航栏'],
  ['titlebar', '标题栏'],
  ['bookmarkbar', '书签栏']
])

/** 每块可选的区域：[值, 中文名]。第三项「侧栏」只在**该块支持**时出现（见 CHROME_ROW_REGIONS）。 */
const ROW_POSITION_OPTIONS = Object.freeze([
  ['top', '顶部'],
  ['bottom', '底部'],
  ['side', '侧栏']
])

/** 每块缺省所在区域。 */
const DEFAULT_ROW_POSITION = 'top'

/**
 * **块 × 区域 能力矩阵**（声明式真源）。
 *
 * 每块能住哪些区域 —— 设置页据此生成下拉选项，摆放计划据此做归一化回落
 * （不支持的取值一律回落缺省，手改设置文件也不会摆出畸形布局）。
 *
 * 扩展点：
 *   · 新增一块      = CHROME_ROWS 加 id + 本矩阵加一行 + 编排层交出元素；
 *   · 新增一个区域  = 本矩阵给相关块加一项 + 容器加一个区域实现 + 一张顺序表。
 * 两种扩展都不需要改任何块的内部。
 */
const CHROME_ROW_REGIONS = Object.freeze({
  tabbar: Object.freeze(['top', 'bottom', 'side']),
  navbar: Object.freeze(['top', 'bottom', 'side']),
  titlebar: Object.freeze(['top', 'bottom']),
  bookmarkbar: Object.freeze(['top', 'bottom'])
})

/**
 * **哪些块可以横跨侧栏**（= 它那一行铺满整窗、压在侧栏上方/下方）；其余块一律给侧栏让位
 * （只在侧栏右边那一段里渲染）。
 *
 * 用户口径（2026-10，逐字）："**侧栏应该在 navbar 下方，但是不应该在书签栏下方**" ——
 * 于是这两件事必须**解耦**：导航栏那一行横跨整窗（侧栏从它下面起算），而书签栏是一条
 * 内容横条，它让位（在侧栏右侧、与网页同宽）。
 *
 * 为什么写成一张声明表而不是在容器里判块 id：
 *   · 容器不认识任何具体块（这是"加一块不用改容器"的前提）；
 *   · 于是"谁可以压过侧栏"是**块自己的声明**，容器只照表分派（见 ui-chrome-layout）；
 *   · 将来再出第三类（例如"只横跨一半"）也只是这张表加一个取值，不散落到各块内部。
 */
const CHROME_ROW_CROSSES_SIDE: Readonly<Record<string, boolean>> = Object.freeze({
  tabbar: true,
  navbar: true,
  titlebar: true,
  bookmarkbar: false
})

/**
 * 某一「行」（行内块 id 列表）是否**横跨侧栏**。
 *
 * 判据是**整行都声明可跨**才算可跨：混装行按"让位"处理 —— 宁可收窄，也不要某一行的
 * 内容一半压在侧栏上、一半不压（那才是真的畸形布局）。
 *
 * @param {string[]|undefined|null} blocks 行内的块 id
 * @returns {boolean}
 */
function rowCrossesSide(blocks: string[]|undefined|null) : boolean {
  const list = (blocks || []).filter(Boolean)
  if (!list.length) return false
  return list.every((id) => CHROME_ROW_CROSSES_SIDE[id] === true)
}

/**
 * 布局预设 —— **宏，不是真源**。
 *
 * 真源永远是「每块各自的区域」；预设只是一次性把若干区域键写好的快捷方式。
 * 于是：用户微调任何一块之后，预设显示为「自定义」，绝不反向覆盖用户的选择。
 *
 * 两个垂直预设就是你要的两种垂直布局（对标见 docs/vertical-tabs-design.md §1.3）：
 *   vertical-tabs         Edge / Vivaldi / Zen Multiple Toolbar 型：只有标签栏进侧栏，
 *                         顶部的导航栏（地址栏那一行）原样保留；
 *   vertical-all-in-one   RT / Arc / Zen Single Toolbar 型：导航栏也进侧栏，
 *                         顶部只剩窗口控制条 / 标题栏 / 书签栏。
 */
const LAYOUT_PRESET_OPTIONS = Object.freeze([
  ['classic', '默认布局'],
  ['vertical-tabs', '垂直标签（Edge 型）'],
  ['vertical-all-in-one', '垂直标签（全功能侧栏）'],
  // 由「每块各自的区域」反推出来的状态：任何一块与三个预设都不一致时显示它。
  // 它不是可选的「第四种布局」，选中它只改标签、不动任何块的区域 —— 见 matchLayoutPreset。
  ['custom', '自定义（由上方各项组合）']
])
const DEFAULT_LAYOUT_PRESET = 'classic'

/** 预设 → 它要写入的区域键值（只列需要改的块，未列出的块保持用户原设置）。 */
const LAYOUT_PRESETS: Readonly<Record<string, Readonly<Partial<Record<ChromeRow, RowPosition>>>>> = Object.freeze({
  classic: Object.freeze({ tabbar: 'top', navbar: 'top' }),
  'vertical-tabs': Object.freeze({ tabbar: 'side', navbar: 'top' }),
  'vertical-all-in-one': Object.freeze({ tabbar: 'side', navbar: 'side' })
})

/**
 * 侧栏区的可见性状态（常驻 / 悬停展开 / 隐藏）。
 *
 * `floating` = **自动隐藏的占位侧栏**：平时宽度归零（网页铺满）→ 鼠标贴到侧栏那一侧
 * 窗口边缘时，**原本那条侧栏**按用户宽度推挤网页展开（不是覆盖浮层）→ 指针移开又归零。
 * 它与 `attached` 只差「静止宽度 0 还是用户宽度」，所以只需要这一个开关。
 */
const SIDEBAR_VISIBILITY_OPTIONS = Object.freeze([
  ['attached', '常驻占位'],
  ['floating', '悬停展开（平时自动隐藏）'],
  ['hidden', '隐藏']
])
const DEFAULT_SIDEBAR_VISIBILITY = 'attached'

/**
 * 纵向轨道「靠左 / 靠右」两态位置选项 —— 工具图标栏（rail + 面板）与垂直标签侧栏共用一份。
 *
 * 两段的位置都是同一个二进制选择，文案与顺序只该有一处；设置页把这份表直接铺成下拉。
 */
const SIDEBAR_POSITION_OPTIONS = Object.freeze([
  ['left', '靠左'],
  ['right', '靠右']
])
const DEFAULT_SIDEBAR_POSITION = 'left'

/**
 * **工具图标栏（rail）位置**：左右 = 纵向列；上下 = 横向条。
 *
 * 横向条时，「按钮起始边」决定 rail 靠左还是靠右 —— 面板随之在左 / 右打开
 * （见 resolveRailPanelSide）。这是唯一一份位置枚举，设置页与主进程共读。
 */
const RAIL_POSITION_OPTIONS = Object.freeze([
  ['left', '靠左'],
  ['right', '靠右'],
  ['top', '顶部（横向）'],
  ['bottom', '底部（横向）']
])
const DEFAULT_RAIL_POSITION = 'left'

/** 横向 rail 的按钮起始边：从左起 / 从右起（决定 rail 偏左还是偏右 → 面板开在哪侧）。 */
const RAIL_HORIZONTAL_ALIGN_OPTIONS = Object.freeze([
  ['left', '从左起'],
  ['right', '从右起']
])
const DEFAULT_RAIL_HORIZONTAL_ALIGN = 'left'

/** 纵向 rail 的按钮起始边：默认从头（上）起 / 从下起（整组按钮贴底）。 */
const RAIL_VERTICAL_ALIGN_OPTIONS = Object.freeze([
  ['top', '从头（上）起'],
  ['bottom', '从下起']
])
const DEFAULT_RAIL_VERTICAL_ALIGN = 'top'

/**
 * rail 的初始呈现模式。
 *
 * · rail     —— 启动时保持普通图标栏；
 * · expanded —— 启动时展开为面板分组；
 * · auto     —— 默认展开；面板打开时自动收起，并在关闭后恢复打开前的状态。
 *
 * 手动箭头仍可随时切换当前呈现；模式只决定新会话 / 新窗口的起始状态。
 */
const RAIL_EXPAND_MODE_OPTIONS = Object.freeze([
  ['auto', '自动'],
  ['rail', '普通图标栏'],
  ['expanded', '展开']
])
const DEFAULT_RAIL_EXPAND_MODE = 'auto'
/** rail 是否固定常驻；取消固定后静止隐藏，贴边悬停时占位唤出。 */
const DEFAULT_RAIL_PINNED = true

/**
 * 图标条自身的**厚度**（纵向列 = 宽，横向条 = 高）。
 *
 * 它和 `sidebarWidth`（渲染层上报的纵向 **lane 占宽** 48）是两回事：lane 里除了这条
 * 44px 的图标条，还要给与网页/面板之间的呼吸空留出余量。纵向那一路的呼吸空已经调好，
 * 横向条**不能**照抄 sidebarWidth —— 照抄时那条带高 48，而组件里的图标条只有 44 且钉在
 * 一头，多出来的 4px 会全落在另一头，上下留白不对称且明显偏多（用户口径：
 * "rail 在顶部底部横向时上下空白边距过多，而左右就很完美"）。
 *
 * 只此一份：主进程算横向带高 / rail 视图高读它，rail 组件画图标条也读它。
 */
const RAIL_BAR_SIZE = 44

/**
 * 可展开工具图标栏的尺寸口径。
 *
 * 收起态沿用历史 lane 宽度 48；展开态只由用户拖拽改变。主进程布局与 rail 渲染层
 * 必须读同一组边界，避免 UI 已经进入“名称态”、原生视图却仍被裁在 48px。
 */
const RAIL_COLLAPSED_WIDTH = 48
const RAIL_WIDTH_MIN = 140
const RAIL_WIDTH_MAX = 480
const RAIL_WIDTH_DEFAULT = RAIL_WIDTH_MIN

/** @param {unknown} value @returns {number} */
function normalizeRailWidth(value: unknown): number {
  const width = Math.round(Number(value))
  if (!Number.isFinite(width)) return RAIL_WIDTH_DEFAULT
  // 运行时宽度允许直接落到普通态；RAIL_WIDTH_MIN 只约束“展开态”的拖拽 / 设置输入。
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_COLLAPSED_WIDTH, width))
}

/** @param {unknown} value @returns {'left'|'right'|'top'|'bottom'} */
function normalizeRailPosition(value: unknown) {
  return value === 'right' || value === 'top' || value === 'bottom' ? value : DEFAULT_RAIL_POSITION
}

/** @param {unknown} value @returns {boolean} rail 是否为横向条（顶部 / 底部） */
function isHorizontalRailPosition(value: unknown) {
  const pos = normalizeRailPosition(value)
  return pos === 'top' || pos === 'bottom'
}

/** @param {unknown} value @returns {'left'|'right'} */
function normalizeRailHorizontalAlign(value: unknown) {
  return value === 'right' ? 'right' : DEFAULT_RAIL_HORIZONTAL_ALIGN
}

/** @param {unknown} value @returns {'top'|'bottom'} */
function normalizeRailVerticalAlign(value: unknown) {
  return value === 'bottom' ? 'bottom' : DEFAULT_RAIL_VERTICAL_ALIGN
}

/** @param {unknown} value @returns {'auto'|'rail'|'expanded'} */
function normalizeRailExpandMode(value: unknown) {
  return value === 'rail' || value === 'expanded' ? value : DEFAULT_RAIL_EXPAND_MODE
}

/** @param {unknown} value @returns {boolean} */
function normalizeRailPinned(value: unknown): boolean {
  if (value == null || value === '') return DEFAULT_RAIL_PINNED
  return !(value === false || value === 'false' || value === 0 || value === '0')
}

/**
 * rail 位置 + 起始边 → **面板开在哪一侧**。
 *
 * 纵向 rail：面板就开在 rail 自己那一侧。
 * 横向 rail：按钮从右起 → rail 偏右 → 面板开右；从左起则开左。
 *
 * 「面板的侧」只有这一份算术：LayoutCoordinator 的轨道布局、渲染层上报的
 * sidebarSide、rail 自身唤醒面板的方向，都必须读它，否则三者会各说各话。
 *
 * @param {unknown} position
 * @param {unknown} horizontalAlign
 * @returns {'left'|'right'}
 */
function resolveRailPanelSide(position: unknown, horizontalAlign: unknown) : 'left'|'right' {
  const pos = normalizeRailPosition(position)
  if (pos === 'left' || pos === 'right') return pos
  return normalizeRailHorizontalAlign(horizontalAlign) === 'right' ? 'right' : 'left'
}

/** 侧栏区尺寸口径（与 docs/vertical-tabs-design.md §3.1 同源：RT 实测值）。 */
const SIDEBAR_WIDTH_MIN = 150
const SIDEBAR_WIDTH_MAX = 500
const SIDEBAR_WIDTH_DEFAULT = 200
/**
 * 折叠态 / 悬停覆盖态静止时的**图标条宽度**。
 *
 * 56 而不是 48：48 只够塞一个图标，两侧几乎没有留白，与带底色的行 hover 块挤在一起时
 * 看过去就是"一条很细的缝"（用户原话）。56 让图标四周有呼吸空间，也与图标本身
 * （折叠态放大一档，见 ui-vertical-tabs 的 styles）重新配平 —— 两个形态的宽度
 * 只在这一处声明，chrome 侧栏与悬停浮出层都读它。
 */
const SIDEBAR_COLLAPSED_WIDTH = 56

/**
 * 标题栏缺省关闭：它是新增能力，不能悄悄改变既有用户的观感。
 * 「标题栏」块只有在这条为 true 时才参与摆放。
 */
const DEFAULT_TITLEBAR_ENABLED = false

/** 窗口控制按钮（最小化 / 最大化 / 关闭）的可选宿主块。「新建标签」不在此列 —— 它恒在标签栏。 */
const WINDOW_CONTROLS_HOST_OPTIONS = Object.freeze([
  ['tabbar', '标签栏'],
  ['navbar', '导航栏'],
  ['titlebar', '标题栏']
])
const DEFAULT_WINDOW_CONTROLS_HOST: WindowControlsHost = 'tabbar'

/**
 * 设置键名 —— 主进程 registry 与渲染层编排共用同一份，
 * 杜绝两边各手抄一遍字符串（抄错一处就是一个静默失效的设置项）。
 */
const LAYOUT_SETTING_KEYS = Object.freeze({
  mode: 'app.layout_mode',
  preset: 'app.layout_preset',
  titlebarEnabled: 'app.titlebar_enabled',
  windowControlsHost: 'app.window_controls_host',
  /**
   * 窗口控制按钮**实现样式**：'auto' | 'native' | 'custom'（见 WINDOW_CONTROLS_STYLE_OPTIONS）。
   * ⚠ 建窗期决定（Windows 上 WCO 无运行时开关），改动**下次开窗口生效**（方案 B）。
   */
  windowControlsStyle: 'app.window_controls_style',
  rowOrder: 'app.chrome_row_order',
  sideOrder: 'app.side_row_order',
  rowPosition: Object.freeze({
    tabbar: 'app.tabbar_position',
    navbar: 'app.navbar_position',
    titlebar: 'app.titlebar_position',
    bookmarkbar: 'app.bookmarkbar_position'
  }),
  /**
   * **工具图标栏（rail）+ 侧边面板**所在位置：`'left' | 'right' | 'top' | 'bottom'`
   * （见 RAIL_POSITION_OPTIONS；上下 = 横向 rail）。
   *
   * ⚠ 面板开在哪侧**不由这个键直接给出**：横向时由 `toolRailHorizontalAlign` 决定
   *   （从右起 → rail 偏右 → 面板在右），唯一解算见 `resolveRailPanelSide`。
   *
   * ⚠ 与 `sideColumnPosition` 是两条独立设置：纵向轨道上相邻的两段可以各靠一边
   *   （标签列在右、工具图标栏在左）。
   *
   * ⚠ **不进 LAYOUT_SETTING_KEY_LIST**：它由独立的 applier（settings/appliers/layout.js）
   *   与渲染层 rail / app-shell 的订阅链路处理，chrome 编排不需要跟着它重摆。
   */
  toolSidebarPosition: 'app.sidebar_position',
  /**
   * 横向 rail（顶部 / 底部）的按钮起始边：'left' | 'right'。
   * 它决定 rail 偏左还是偏右，进而决定面板在左 / 右打开（见 resolveRailPanelSide）。
   */
  toolRailHorizontalAlign: 'app.rail_horizontal_align',
  /**
   * 纵向 rail（靠左 / 靠右）的按钮起始边：'top'（默认从头起）| 'bottom'（从下起）。
   * 只影响 rail 内部按钮的堆叠方向，不改变面板所在侧。
   */
  toolRailVerticalAlign: 'app.rail_vertical_align',
  /** 可展开 rail 的起始状态：auto / rail / expanded。 */
  toolRailExpandMode: 'app.rail_expand_mode',
  /** 展开态宽度；与模式分开，切换三态不会丢失用户拖出的宽度。 */
  toolRailWidth: 'app.rail_width',
  /** rail 固定态：刷新后恢复上次状态；false = 静止隐藏、贴边悬停占位唤出。 */
  toolRailPinned: 'app.rail_pinned',
  /**
   * 侧栏区自身的状态（与「哪一块住侧栏」无关：没有块住侧栏时这些键无效果）。
   *
   * ⚠ 命名与归属：这些键描述的是**侧栏区**（垂直标签栏住的那一栏），
   * 不是布局参数里的 `sidebarWidth`（那是 rail 图标栏的宽度）—— 两者是纵向轨道上
   * 相邻但独立的两个区块，故这里统一用 `sideColumn*` 前缀，避免再一次张冠李戴。
   *
   * ⚠ 位置键（`position`）与 rail / 面板的 `app.sidebar_position` 是**两条独立设置**：
   * 纵向轨道上的两段可以各靠一边（标签列在右、工具图标栏在左）。主进程按两段各自的
   * 侧分别算内缩与 x 位置（见 LayoutCoordinator#applyInitialLayout 的轨道算术）。
   */
  sideColumnPosition: 'app.side_column_position',
  /**
   * 侧栏显示方式：`attached`（常驻占位）/ `floating`（悬停展开、平时自动隐藏）/ `hidden`。
   *
   * ⚠ 「收起不占位、贴边悬停才展开」这件事**只有这一个开关**（floating）。
   *   历史上另有一个 `app.sidebar_pinned`（"折叠时仍占位"）与它表达同一件事 ——
   *   两条口径同语义 = 迟早互相矛盾，已删除（见 docs/vertical-tabs-design.md §4.5）。
   *
   * ⚠ 侧栏顶部的「固定 / 悬停」按钮写的也是这个键 —— 同一件事只有一份真源。
   */
  sideColumnVisibility: 'app.sidebar_visibility',
  sideColumnWidth: 'app.sidebar_width',
  sideColumnCollapsed: 'app.sidebar_collapsed',
  /**
   * **独立侧栏（Web Sidebar）** 的位置偏好：`'auto' | 'left' | 'right'`。
   *
   * 纵向轨道上的**第三段**，与前两段的关系是：
   *   ① `app.sidebar_position`      —— 工具图标栏（rail）+ 侧边面板；
   *   ② `app.side_column_position`  —— 垂直标签侧栏（标签列那一栏）；
   *   ③ `app.web_sidebar_position`  —— 侧栏里那个**浏览网页**的独立视图。
   *
   * ⚠ `'auto'`（默认）落到**工具区（①）所在的那一侧**（跟随 —— "从哪边点开就从哪边出来"）。
   * 需要"错开一侧"（工具区在左、侧栏在右）时显式选 `'left'` / `'right'`，或直接
   * **拖侧栏顶条**拖到另一边：那是一次显式决定，不该由默认值替用户做。
   * 解析成实际侧别的算术只有一份：`resolveWebSidebarSide`（同文件 web-sidebar.mjs）。
   */
  webSidebarPosition: 'app.web_sidebar_position',
  /**
   * 独立侧栏的尺寸记忆与呈现模式。
   *
   * ⚠ 这两项**不进 LAYOUT_SETTING_KEY_LIST**：宽度只由侧栏自己拖动时读写，
   *   呈现模式只影响 UA（换一条 UA 与外壳摆放无关）；放进列表会让 chrome 编排
   *   平白订阅两个"变化后无事可做"的键。
   */
  webSidebarWidth: 'app.web_sidebar_width',
  webSidebarViewMode: 'app.web_sidebar_view_mode',
  /**
   * 沉浸模式（学 HiraRT）：chrome（顶栏 / 侧栏 / rail / 底部栏）整体收起、网页铺满窗口，
   * 鼠标贴到窗口**边缘**才把对应那一块唤出来（上缘 → 顶栏推挤显示；侧缘 → 侧栏浮出）。
   *
   * 与**全屏**共用同一套呈现与同一条判据（见 LayoutCoordinator#_chromeHidden）：
   * 全屏时界面本来就该让位给内容，"唤出"这件事两边完全一样 —— 两套实现必然漂移
   * （表现就是"全屏下界面唤不出来"）。
   */
  immersiveMode: 'app.immersive_mode'
})


/** 全部布局设置键的扁平列表：编排层据此批量读取 / 批量订阅。 */
const LAYOUT_SETTING_KEY_LIST = Object.freeze([
  LAYOUT_SETTING_KEYS.mode,
  LAYOUT_SETTING_KEYS.preset,
  LAYOUT_SETTING_KEYS.titlebarEnabled,
  LAYOUT_SETTING_KEYS.immersiveMode,
  LAYOUT_SETTING_KEYS.windowControlsHost,
  // ⚠ windowControlsStyle **刻意不进这张表**：它是**建窗期**决定的（见
  // resolveWindowControlsMode 的说明），渲染层改不了、也不该跟着它重摆任何东西。
  // 放进来的话 chrome-layout-controller 会白白订阅一个"变化后无事可做"的键，
  // 读到的值还会进 state 让 planChromeLayout 收到一个它不认识的字段。
  // 主进程在建窗时直接读 LAYOUT_SETTING_KEYS.windowControlsStyle（见 browser-window-assembly）。
  LAYOUT_SETTING_KEYS.rowOrder,
  LAYOUT_SETTING_KEYS.sideOrder,
  LAYOUT_SETTING_KEYS.rowPosition.tabbar,
  LAYOUT_SETTING_KEYS.rowPosition.navbar,
  LAYOUT_SETTING_KEYS.rowPosition.titlebar,
  LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar,
  LAYOUT_SETTING_KEYS.sideColumnPosition,
  LAYOUT_SETTING_KEYS.sideColumnVisibility,
  LAYOUT_SETTING_KEYS.sideColumnWidth,
  LAYOUT_SETTING_KEYS.sideColumnCollapsed,
  LAYOUT_SETTING_KEYS.webSidebarPosition
])

/**
 * 宽松布尔判定（**只认真正的真值**）。
 *
 * 为什么不能用 `Boolean(value)`：设置文件是用户可手改的 JSON，
 * 字符串 `"false"` 的 `Boolean()` 结果是 **true** —— 于是「关掉标题栏」手改一下就变成关不掉。
 * 这里只把 true / 'true' / 1 / '1' 当作真，其余（含 'false' / 'off' / 空串 / undefined）一律假。
 * @param {unknown} value
 * @returns {boolean}
 */
function toFlag(value: unknown) : boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

/**
 * 归一化任意历史/异常取值到两态。
 * 设置文件是用户可手改的 JSON，不能假设干净 —— 无法识别的值一律回落缺省。
 * @param {unknown} value
 * @returns {LayoutMode}
 */
function normalizeLayoutMode(value: unknown) : LayoutMode {
  return value === 'compact' ? 'compact' : DEFAULT_LAYOUT_MODE
}

/** 是否为紧凑模式（不改变 bar 的独立边界）。 @param {unknown} value */
function isCompactLayout(value: unknown) {
  return normalizeLayoutMode(value) === 'compact'
}

/**
 * 归一化某块所在**区域**。
 *
 * 传了 rowId 时按 CHROME_ROW_REGIONS 把关：该块不支持的取值一律回落缺省 ——
 * 于是「某块不支持侧栏」或「手改设置文件给不支持的块写了 side」都不会摆出畸形布局。
 * @param {unknown} value
 * @param {ChromeRow} [rowId]
 * @returns {RowPosition}
 */
function normalizeRowPosition(value: unknown, rowId?: ChromeRow): RowPosition {
  const allowed = rowId ? CHROME_ROW_REGIONS[rowId] : null
  const list = allowed || ROW_POSITION_OPTIONS.map((opt) => opt[0])
  return list.includes(String(value)) ? value as RowPosition : DEFAULT_ROW_POSITION
}

/**
 * 归一化侧栏区可见性。
 * @param {unknown} value
 * @returns {'attached'|'floating'|'hidden'}
 */
function normalizeSidebarVisibility(value: unknown) : 'attached'|'floating'|'hidden' {
  return value === 'floating' || value === 'hidden' ? value : DEFAULT_SIDEBAR_VISIBILITY
}

/**
 * 归一化侧栏区宽度（夹取到合法区间；非法值回落缺省）。
 * @param {unknown} value
 * @returns {number}
 */
function normalizeSidebarWidth(value: unknown) : number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n))
}

/**
 * 归一化侧栏区所在侧（左 / 右）。
 *
 * 与 rail / 面板的 `app.sidebar_position` 是**两条独立设置**：纵向轨道上相邻的两段
 * （侧栏区、rail + 面板）可以各靠一边。主进程按两段各自的侧分别算内缩与 x 位置 ——
 * 故渲染层必须把**本段的侧**（而不是 rail 的侧）随占宽一起上报。
 * @param {unknown} value
 * @returns {'left'|'right'}
 */
function normalizeSidebarPosition(value: unknown) : 'left'|'right' {
  return value === 'right' ? 'right' : DEFAULT_SIDEBAR_POSITION
}

/**
 * 归一化窗口控制按钮宿主。
 * @param {unknown} value
 * @returns {WindowControlsHost}
 */
function normalizeWindowControlsHost(value: unknown): WindowControlsHost {
  if (value === 'navbar' || value === 'titlebar' || value === 'tabbar') return value
  return DEFAULT_WINDOW_CONTROLS_HOST
}

/**
 * 归一化窗口控制按钮实现样式（两态；非法值回落缺省「系统原生」）。
 * @param {unknown} value
 * @returns {'native'|'custom'}
 */
function normalizeWindowControlsStyle(value: unknown) : 'native'|'custom' {
  return value === 'custom' ? 'custom' : DEFAULT_WINDOW_CONTROLS_STYLE
}

/**
 * **建窗期**决定窗口控制按钮用系统原生（WCO）还是应用自绘 —— 主进程构造
 * BrowserWindow 时的唯一判据（无推导、无回落：用户选哪个就是哪个）。
 *
 * 为什么不留"自动"：做过一版按布局推导的自动（缺省位置 → 原生，其余 → 自绘），
 * 结果是**同一个视觉位置在不同布局下行为不同**，用户根本预判不了自己会看到哪种按钮 ——
 * 那比多一个开关更糟。现在只有两种确定的结局：要么系统按钮恒在右上角，要么全部自绘。
 *
 * @param {{ style?: unknown }} [input] 只吃 `app.window_controls_style` 一项
 * @returns {'native'|'custom'}
 */
function resolveWindowControlsMode(input: { style?: unknown }) : 'native'|'custom' {
  return normalizeWindowControlsStyle(input && input.style)
}

/**
 * 归一化顺序表：去重、剔除未知 id、补全缺失的块。
 * 返回的数组一定恰好包含 CHROME_ROWS 的每个 id 一次。
 *
 * @param {unknown} value
 * @param {readonly string[]} [fallback] 补全时用的顺序（行区与侧栏区缺省顺序不同）
 * @returns {ChromeRow[]}
 */
function normalizeChromeRowOrder(value: unknown, fallback: readonly string[]) : ChromeRow[] {
  const out: ChromeRow[] = []
  if (Array.isArray(value)) {
    for (const row of value) {
      if (isChromeRow(row) && !out.includes(row)) out.push(row)
    }
  }
  for (const row of (fallback || CHROME_ROWS)) if (isChromeRow(row) && !out.includes(row)) out.push(row)
  return out
}

function isChromeRow(value: unknown): value is ChromeRow {
  return typeof value === 'string' && CHROME_ROWS.some((row) => row === value)
}

/**
 * 把「按设置键索引的原始值表」收拾成 planChromeLayout 认识的输入。
 *
 * 为什么单独一层：设置键名的主人是本模块（LAYOUT_SETTING_KEYS），
 * 编排层只该持有一份 `{ [key]: value }`，不该再自己拼 `positions.tabbar` 这种结构 ——
 * 那样键名知识就漏到了两层。
 *
 * @param {Record<string, unknown>|null|undefined} settings
 * @returns {{ mode: unknown, titlebarEnabled: unknown, windowControlsHost: unknown, rowOrder: unknown, positions: Record<string, unknown> }}
 */
function chromeLayoutStateFromSettings(settings: Record<string, unknown>|null|undefined) : {
  mode: unknown
  titlebarEnabled: unknown
  windowControlsHost: unknown
  rowOrder: unknown
  sideOrder: unknown
  positions: Record<string, unknown>
  sideColumn: Record<string, unknown>
} {
  const all = settings || {}
  const p = LAYOUT_SETTING_KEYS.rowPosition
  return {
    mode: all[LAYOUT_SETTING_KEYS.mode],
    titlebarEnabled: all[LAYOUT_SETTING_KEYS.titlebarEnabled],
    windowControlsHost: all[LAYOUT_SETTING_KEYS.windowControlsHost],
    rowOrder: all[LAYOUT_SETTING_KEYS.rowOrder],
    sideOrder: all[LAYOUT_SETTING_KEYS.sideOrder],
    positions: {
      tabbar: all[p.tabbar],
      navbar: all[p.navbar],
      titlebar: all[p.titlebar],
      bookmarkbar: all[p.bookmarkbar]
    },
    sideColumn: {
      position: all[LAYOUT_SETTING_KEYS.sideColumnPosition],
      visibility: all[LAYOUT_SETTING_KEYS.sideColumnVisibility],
      width: all[LAYOUT_SETTING_KEYS.sideColumnWidth],
      collapsed: all[LAYOUT_SETTING_KEYS.sideColumnCollapsed]
    }
  }
}

/**
 * 预设 → 「要写的设置键值对」（布局预设的实现落点）。
 *
 * 写的是**每块各自的区域键**（真源），不是预览值 —— app-shell 菜单点「切换为垂直标签」
 * 时按这个表批量写，其余键一律不动。未列出的块保持用户原设置（例如用户把书签栏
 * 放到侧栏之后，切到 `vertical-tabs` 预设不会把书签栏拽回来）。
 *
 * @param {unknown} presetId
 * @returns {Array<[string, string]>} [设置键, 值] 列表；未知预设返回空数组
 */
function layoutPresetWrites(presetId: unknown) : Array<[string, string]> {
  const table = LAYOUT_PRESETS[String(presetId)]
  if (!table) return []
  const p = LAYOUT_SETTING_KEYS.rowPosition
  /** @type {Array<[string, string]>} */
  const out: Array<[string, string]> = []
  for (const row of CHROME_ROWS) {
    const value = table[row]
    if (typeof value === 'string') out.push([p[row], value])
  }
  return out
}

/**
 * 由「每块各自的区域」反推**当前匹配的预设**（用于设置页把预设显示成选中态）。
 * 只比较预设关心的那几块；任何一块不匹配就返回 null（= 自定义）。
 *
 * @param {Record<string, unknown>|null|undefined} positions
 * @param {boolean} [titlebarEnabled]
 * @returns {string|null}
 */
function matchLayoutPreset(positions: Record<string, unknown>|null|undefined, titlebarEnabled: boolean) : string|null {
  const p = positions || {}
  const flag = titlebarEnabled === undefined ? true : toFlag(titlebarEnabled)
  const rows = CHROME_ROWS.filter((row) => row !== 'titlebar' || flag)
  for (const presetId of Object.keys(LAYOUT_PRESETS)) {
    const table = LAYOUT_PRESETS[presetId]
    const hit = Object.keys(table).every((row) =>
      rows.includes(row as ChromeRow) && normalizeRowPosition(p[row], row as ChromeRow) === table[row as ChromeRow]
    )
    if (hit) return presetId
  }
  return null
}

/**
 * 页面标题 + 应用名 → **原生窗口标题**（任务栏 / Alt-Tab / Aero Peek 上显示的那一行）。
 *
 * 排版规则照搬 legacy Hira（`js/browserUI.js#setWindowTitle`）与 wexond
 * （`src/main/windows/app.ts#updateTitle`）两家一致的做法：
 *   `[截断后的页面标题, 应用名].filter(Boolean).join(' | ')`
 * 于是有页面标题时是「网页标题 | 应用名」，没有时退化成只剩应用名 ——
 * 绝不会出现「 | 应用名」这种前导分隔符。
 *
 * 为什么截断：Windows 任务栏按钮的标题会按宽度截断显示，太长反而把真正有信息量的
 * 前缀挤没；legacy Hira 取值同样是 100。
 *
 * 放在本模块（而不是编排层或主进程）：它是**标题文本的排版规则**，与布局同属
 * 「外壳长什么样」的真源；主进程与渲染层必须读到同一份，否则任务栏标题会随窗口类型漂移。
 *
 * @param {unknown} pageTitle 页面标题（可为空 / null / 含空白与换行）
 * @param {unknown} appName 应用名（启动时取自页面 <title>，不硬编码）
 * @returns {string}
 */
const WINDOW_TITLE_MAX_LENGTH = 100

function formatWindowTitle(pageTitle: unknown, appName: unknown): string {
  // 页面标题可能带换行 / 制表（站点标题里很常见）：先把空白压成单个空格，再截断。
  const raw = String(pageTitle == null ? '' : pageTitle).replace(/\s+/g, ' ').trim()
  const title = raw.length > WINDOW_TITLE_MAX_LENGTH ? raw.slice(0, WINDOW_TITLE_MAX_LENGTH).trim() : raw
  const app = String(appName == null ? '' : appName).trim()
  return [title, app].filter(Boolean).join(' | ')
}

/**
 * 组装外壳摆放计划（纯函数）。
 *
 * @param {{
 *   mode?: unknown,
 *   titlebarEnabled?: unknown,
 *   windowControlsHost?: unknown,
 *   rowOrder?: unknown,
 *   sideOrder?: unknown,
 *   positions?: Record<string, unknown>,
 *   sideColumn?: Record<string, unknown>
 * }} [input]
 * @returns {{
 *   mode: LayoutMode,
 *   titlebarEnabled: boolean,
 *   windowControlsHost: WindowControlsHost,
 *   navbarSide: 'top'|'bottom',
 *   merged: boolean,
 *   top: string[][],
 *   bottom: string[][],
 *   side: {
 *     rows: string[][],
 *     position: 'left'|'right',
 *     visibility: 'attached'|'floating'|'hidden',
 *     autoHide: boolean,
 *     revealOverlay: boolean,
 *     width: number,
 *     collapsed: boolean,
 *     restWidth: number,
 *     revealWidth: number
 *   } | null
 * }}
 *   top / bottom：行区，每项是一「行」（行内块横排）；side：侧栏区，每项是纵向堆叠的一「带」。
 *   **side === null 即没有块住侧栏 = 默认布局**（渲染层据此完全不渲染侧栏区）。
 *   navbarSide 只描述行区里的导航栏所在侧（地址栏下拉方向由主进程消费）。
 *   merged：兼容字段。tabbar / navbar 现在是永久独立 block，恒为 false。
 */
function planChromeLayout(input: {
  mode?: unknown
  titlebarEnabled?: unknown
  windowControlsHost?: unknown
  rowOrder?: unknown
  sideOrder?: unknown
  positions?: Record<string, unknown>
  sideColumn?: Record<string, unknown>
}) : {
  mode: LayoutMode,
  titlebarEnabled: boolean,
  windowControlsHost: WindowControlsHost,
  navbarSide: 'top'|'bottom',
  merged: boolean,
  top: string[][],
  bottom: string[][],
  side: {
    rows: string[][],
    position: 'left'|'right',
    visibility: 'attached'|'floating'|'hidden',
    autoHide: boolean,
    revealOverlay: boolean,
    width: number,
    collapsed: boolean,
    restWidth: number,
    revealWidth: number
  } | null
} {
  const src = input || {}
  const mode = normalizeLayoutMode(src.mode)
  const titlebarEnabled = toFlag(src.titlebarEnabled)
  const positions = src.positions || {}
  const order = normalizeChromeRowOrder(src.rowOrder, DEFAULT_CHROME_ROW_ORDER)
  const sideOrder = normalizeChromeRowOrder(src.sideOrder, DEFAULT_SIDE_ROW_ORDER)

  // 标题栏关闭 = 这块**不存在**：不进摆放，也不可作为窗口控制按钮宿主。
  const availableRows: ChromeRow[] = CHROME_ROWS.filter((row) => row !== 'titlebar' || titlebarEnabled)

  /** 每块的实际区域（按能力矩阵归一化：不支持的取值回落顶部）。 @type {Record<string, RowPosition>} */
  const regionOf: Partial<Record<ChromeRow, RowPosition>> = {}
  for (const row of availableRows) {
    const rowId = row as ChromeRow
    regionOf[rowId] = normalizeRowPosition(positions[rowId], rowId)
  }

  // ★ 唯一的「默认布局 / 垂直布局」判据：**有没有块住在侧栏区**。
  const sideRows = sideOrder.filter((row) => availableRows.includes(row) && regionOf[row] === 'side')
  const rowRows = order.filter((row) => availableRows.includes(row) && regionOf[row] !== 'side')

  /**
   * **Edge 型侧栏**：侧栏里**只有标签列**（导航栏还在顶上）。
   * 唯一用途：窗口控制按钮**强制归导航栏**（见下面 host 的那一步）——
   * 那时标签栏是一条窄竖条，三颗窗控塞进去既挤又反直觉。
   */
  const edgeSidebar = sideRows.length === 1 && sideRows[0] === 'tabbar'

  // 紧凑单行只在编辑器显式把 tabbar / navbar 叠到同一行时启用。
  // 普通拖放不会自动写入 compact，因此非单行模式始终保持两个独立 bar。
  const merged = mode === 'compact' &&
    rowRows.includes('tabbar') && rowRows.includes('navbar') &&
    regionOf.tabbar === regionOf.navbar

  const units: Array<{ blocks: string[]; pos: RowPosition }> = []
  let mergedPushed = false
  for (const row of rowRows) {
    if (merged && (row === 'tabbar' || row === 'navbar')) {
      if (!mergedPushed) {
        units.push({ blocks: ['tabbar', 'navbar'], pos: regionOf.navbar || DEFAULT_ROW_POSITION })
        mergedPushed = true
      }
      continue
    }
    units.push({ blocks: [row], pos: regionOf[row] || DEFAULT_ROW_POSITION })
  }

  const top: string[][] = []
  const bottom: string[][] = []
  for (const unit of units) (unit.pos === 'bottom' ? bottom : top).push(unit.blocks)

  // 窗口控制按钮宿主：不可用则回退 标签栏 → 导航栏。
  let host = normalizeWindowControlsHost(src.windowControlsHost)
  if (merged && host === 'tabbar') host = 'navbar'
  if (!availableRows.includes(host)) {
    host = availableRows.includes('tabbar') ? 'tabbar' : 'navbar'
  }
  // ★ Edge 型侧栏（标签列独占侧栏、导航栏在顶上）→ **强制归导航栏**
  //   （用户口径："edge 侧栏模式下，强制是在 navbar 导航栏中的窗口控制按钮"）。
  //   理由：那时标签栏是一条**窄竖条**（48~200px），三颗窗控塞进去既挤又与"最右一排按钮"
  //   的直觉相反；而顶上那条导航栏本来就横跨一侧，才是它们该在的地方。
  //   于是这个形态下宿主设置实际只在两种落点之间选：
  //     · navbar（默认落点）；
  //     · titlebar —— **仅当标题栏那块真的在台上**（titlebarEnabled）才算数，否则同样回落
  //       导航栏（回落不给标签栏：标签栏在侧栏里，等于又把它塞回竖条）。
  //   这一条放在"可用性回退"之后：上面那次回退在 Edge 型下会挑中 tabbar（= 竖条），
  //   正是要在这里纠正掉的那种结果。
  if (edgeSidebar && host !== 'navbar' && !(host === 'titlebar' && titlebarEnabled)) host = 'navbar'

  const sb = src.sideColumn || {}
  const collapsed = toFlag(sb.collapsed)
  const expandedWidth = normalizeSidebarWidth(sb.width)
  const visibility = normalizeSidebarVisibility(sb.visibility)
  /**
   * **两种自动隐藏（`app.sidebar_visibility = floating`），行为不同，不能混为一谈：**
   *
   *   · **Edge 型**（侧栏只住标签列）→ 「标签 rail 常驻 + 悬停展开浮层」：
   *     静止时整条 rail 依旧让出图标条宽（网页让位 56px），鼠标贴到那一侧窗口边缘
   *     展开的**不是**这条 rail，而是一个**覆盖网页的独立浮层**（网页不缩进、不重排）。
   *     即 `restWidth = 图标条宽`、`revealOverlay = true`。
   *   · **全功能型**（导航栏也住侧栏）→ 「静止完全消失 + 贴边唤出占位」：
   *     静止宽度 0（网页铺满整窗），贴边唤出的整条侧栏**推挤网页**（占位，不是浮层）。
   *     即 `restWidth = 0`、`revealOverlay = false`。
   *
   * 与 `collapsed`（用户手动点出来的图标条）是两件事，两者可以叠加。
   *
   * ⚠ 这里只出「形态」这两个事实；**什么时候展开**是运行期状态，由主进程的贴边巡看
   *   决定并推给渲染层（见 LayoutCoordinator 的 `_sideReveal*`）。计划是纯函数，
   *   不该掺进指针位置。
   */
  const autoHide = visibility === 'floating'
  const edgeFloating = edgeSidebar && autoHide
  const side = sideRows.length
    ? {
        rows: sideRows.map((id) => [id]),
        position: normalizeSidebarPosition(sb.position),
        visibility,
        /** 自动隐藏（渲染层据此把静止宽度写 0 或保持 rail、并接受唤出指令） */
        autoHide,
        /** 展开后的宽度（用户拖拽的原始口径；设置页/拖拽把手读它） */
        width: expandedWidth,
        /** 折叠为图标条（自动隐藏展开时也按它决定露出图标条还是完整侧栏） */
        collapsed,
        /**
         * **悬停展开 = 覆盖网页的浮层**（Edge 型自动隐藏专有）：
         *   · true  → 静止宽度按 `restWidth`（图标条）**照常占位**，展开的是独立浮层，
         *             网页宽度**不因唤出而变化**（渲染层/主进程据此跳过「唤出时让位」）；
         *   · false → 唤出即占位展开（全功能型：静止 0，唤出推挤网页）。
         */
        revealOverlay: edgeFloating,
        /**
         * **静止占位宽度**（网页平时让出多少）—— 渲染层与主进程**只用这一个数**：
         *   · Edge 型自动隐藏 → 图标条宽（rail 常驻）
         *   · 全功能型自动隐藏 → 0（网页铺满）
         *   · 手动折叠 → 图标条宽
         *   · 其余 → 用户拖的宽度
         */
        restWidth: autoHide
          ? (edgeFloating ? SIDEBAR_COLLAPSED_WIDTH : 0)
          : (collapsed ? SIDEBAR_COLLAPSED_WIDTH : expandedWidth),
        /** **唤出（悬停展开）宽度**：折叠着就露出图标条，否则就是用户拖的宽度。 */
        revealWidth: collapsed ? SIDEBAR_COLLAPSED_WIDTH : expandedWidth
      }
    : null

  return {
    mode,
    titlebarEnabled,
    windowControlsHost: host,
    navbarSide: bottom.some((blocks) => blocks.includes('navbar')) ? 'bottom' : 'top',
    merged,
    top,
    bottom,
    side
  }
}

/**
 * 窗口控制按钮簇此刻是否落在**侧栏槽位**里（`ui-vertical-tabs` 的 `slots.bottom`）。
 *
 * 判据与 ui-navbar#row/windowControlsPlacement **同源**（那边管搬节点，这里管"要不要造"）：
 *   · 宿主设为 `navbar` → 按钮归导航栏行，与侧栏无关；
 *   · 宿主设为 `titlebar` → 让给标题栏那块；
 *   · 宿主为 `tabbar`，且导航栏块**不在**侧栏 → 落在侧栏底槽。
 *
 * ★ **Edge 型侧栏下恒不落底槽**（用户口径："edge 侧栏模式下，强制是在 navbar 导航栏中的
 *   窗口控制按钮"）：那时标签栏是一条窄竖条，塞三颗窗控既挤又反直觉。调用方传入
 *   `plan.side` 是否只有标签列这一个事实即可。plan 那边同样强制归导航栏，两边同一个答案。
 *
 * @param {unknown} windowControlsHost `app.window_controls_host` 的原始值
 * @param {unknown} edgeSidebar 侧栏是否只住着标签列（= Edge 型侧栏）
 * @returns {boolean}
 */
function windowControlsPlacementInSidebar(windowControlsHost: unknown, edgeSidebar: unknown) : boolean {
  // Edge 型侧栏 → 窗控归导航栏，与侧栏底槽无关。
  if (edgeSidebar) return false
  return normalizeWindowControlsHost(windowControlsHost) === 'tabbar'
}

export {
  LAYOUT_MODE_OPTIONS,
  DEFAULT_LAYOUT_MODE,
  CHROME_ROWS,
  DEFAULT_CHROME_ROW_ORDER,
  DEFAULT_SIDE_ROW_ORDER,
  CHROME_ROW_ORDER_OPTIONS,
  CHROME_ROW_REGIONS,
  ROW_POSITION_OPTIONS,
  DEFAULT_ROW_POSITION,
  LAYOUT_PRESET_OPTIONS,
  DEFAULT_LAYOUT_PRESET,
  LAYOUT_PRESETS,
  SIDEBAR_VISIBILITY_OPTIONS,
  DEFAULT_SIDEBAR_VISIBILITY,
  SIDEBAR_POSITION_OPTIONS,
  DEFAULT_SIDEBAR_POSITION,
  RAIL_POSITION_OPTIONS,
  DEFAULT_RAIL_POSITION,
  RAIL_HORIZONTAL_ALIGN_OPTIONS,
  DEFAULT_RAIL_HORIZONTAL_ALIGN,
  RAIL_VERTICAL_ALIGN_OPTIONS,
  DEFAULT_RAIL_VERTICAL_ALIGN,
  RAIL_EXPAND_MODE_OPTIONS,
  DEFAULT_RAIL_EXPAND_MODE,
  DEFAULT_RAIL_PINNED,
  RAIL_BAR_SIZE,
  RAIL_COLLAPSED_WIDTH,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_DEFAULT,
  normalizeRailPosition,
  isHorizontalRailPosition,
  normalizeRailHorizontalAlign,
  normalizeRailVerticalAlign,
  normalizeRailExpandMode,
  normalizeRailPinned,
  normalizeRailWidth,
  resolveRailPanelSide,

  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_COLLAPSED_WIDTH,
  DEFAULT_TITLEBAR_ENABLED,
  WINDOW_CONTROLS_HOST_OPTIONS,
  DEFAULT_WINDOW_CONTROLS_HOST,
  WINDOW_CONTROLS_STYLE_OPTIONS,
  DEFAULT_WINDOW_CONTROLS_STYLE,
  WINDOW_CONTROLS_OVERLAY_HEIGHT,
  LAYOUT_SETTING_KEYS,
  LAYOUT_SETTING_KEY_LIST,
  WINDOW_TITLE_MAX_LENGTH,
  normalizeLayoutMode,
  isCompactLayout,
  normalizeRowPosition,
  normalizeWindowControlsHost,
  normalizeWindowControlsStyle,
  resolveWindowControlsMode,
  normalizeChromeRowOrder,
  normalizeSidebarVisibility,
  normalizeSidebarWidth,
  normalizeSidebarPosition,
  chromeLayoutStateFromSettings,
  layoutPresetWrites,
  matchLayoutPreset,
  formatWindowTitle,
  planChromeLayout,
  windowControlsPlacementInSidebar,
  rowCrossesSide,
  toFlag
}
