/**
 * 布局协调器：管理 Rail / Panel / Tab / 各浮层等 contentView 子视图的位置与图层。
 * （chrome / navbar 外壳 = 窗口本体，不在此管理 —— 见下方「图层策略」注。）
 *
 * ── 挂载模型（对齐 RT LayerManager，性能核心）─────────────────────────────
 * 所有 view **只 addChildView 一次**，之后：
 *   · 切换标签  → 只切 `setVisible(true/false)`（挂在 _tabLayer 容器上）
 *   · 开关面板  → 只切 `setVisible(true/false)`
 *   · 改位置    → 只 `setBounds`，且 bounds 未变化时直接跳过
 * 绝不为了「隐藏」去做 removeChildView —— 那会拆掉原生视图宿主
 * （NativeViewHost），webContents 收到 WasHidden，重挂回来再 WasShown，
 * 合成器被销毁重建 + 整页重排重绘。重页面上就是几百 ms 的卡顿/冻结。
 *
 * 图层策略：所有 contentView 子 view 通过 addChildView 顺序控制 z-order。
 * addChildView(view) 会把 view 移到同级最顶层，因此按 低→高 顺序依次添加即可
 * （标签装在 _tabLayer 里，不参与外层重排）：
 *   tabLayer(最底，内含全部标签) → panel → rail → 各浮层 → password-overlay
 *
 * 注：chrome（navbar/tabbar 外壳）**不是图层** —— 它是窗口本体（`win.webContents`，
 * 由 ChromeView 假视图承载），天然铺满窗口且位于 contentView 所有子视图之下，
 * 不参与 addChildView / setBounds / z 序 / 焦点 / 模态（对齐 RT FakeWebContentsViewLayer）。
 *
 * 布局（sidebarPosition='left'，默认）：
 *   ┌──────────────────────────────────────────┐
 *   │   侧栏区（可选）   │  UI Shell (navbar)     │  ← 侧栏区是**整列**（含顶部）
 *   ├──────┬──────┬────┬────────────────────────┤
 *   │ 侧栏 │ RAIL │PANEL│      Tab (网页)         │
 *   │(垂直 │ 48px │320 │                        │
 *   │标签) │      │    │                        │
 *   └──────┴──────┴────┴────────────────────────┘
 *     ↑ 有块住侧栏时才存在（无 → 归零，界面与历史版本逐像素一致）
 *
 * 布局（sidebarPosition='right'）：
 *   ┌──────────────────────────────────────────┐
 *   │  UI Shell (navbar)   │   侧栏区（可选）    │
 *   ├────────────────────────┬────┬──────┬──────┤
 *   │      Tab (网页)        │PANEL│ RAIL │ 侧栏 │
 *   └────────────────────────┴────┴──────┴──────┘
 *
 * UI Shell 覆盖顶部 headerHeight（**主列**宽度，不含侧栏区）；Rail / Panel / Tab 均在 navbar 下方。
 * sidebarPosition 由设置项 app.sidebar_position 驱动，侧栏区那一侧的 sideColumnSide 由
 * app.side_column_position 驱动 —— **两条独立设置**，都经 applier 注入（渲染层也会随占宽
 * 复报一次，见 setPageLayoutParams）。两段可以各靠一边，算术见 applyInitialLayout。
 *
 * 浮层图层（每个浮层一个独立 WebContentsView，绝不共用）：
 *   各浮层 bounds 独立管理（0x0 = 隐藏），互不争抢，可同时存在而不串扰。
 */
import { BrowserWindow, screen, systemPreferences, type Event as ElectronEvent, type Input, type Rectangle, type View, type WebContents, type WebContentsView } from 'electron'
import { onWebContentsDestroyed } from './webContentsLifecycle'
import { Layer, LayerManager } from './LayerManager'
import { TabHostLayer } from './TabHostLayer'
import { installPanelLayoutController } from './PanelLayoutController'
import { installWebSidebarController } from './WebSidebarController'
import { getSideColumnWidth, type SideColumnLayoutParams } from './side-column-width'
// 内容面焦点记忆体（纯模块）：记住「用户刚才在哪个网页视图里打字」，
// 供窗口失活再激活 / 点外壳非输入区之后把键盘焦点送回去 —— 见该文件头。
import { ContentFocusMemory, type ContentFocusEntry } from './ContentFocusMemory'
// 悬浮预览卡的落位真源（与渲染层浮层共用同一份；见该文件头的三条不变式）。
import { resolvePreviewPlacement, PREVIEW_PLACEMENT } from '@hira-ng/shared-types/src/preview-placement'
// 贴顶浮层的落位真源（权限 / 地址栏下拉 / 下载等）：几何算术全在那份纯函数里，
// 这里只负责把窗口与布局事实凑齐 —— 见 anchorFloatBelowTopbar。
import { anchorFloatBelowTopbar as computeBelowTopbar } from '@hira-ng/shared-types/src/float-anchor'
// 分屏几何真源（切分算术只有一份：主进程落 bounds、渲染层画分隔条都读它）
import { solveSplitPanes, ratiosFromDrag, SPLIT_METRICS } from '@hira-ng/shared-types/src/split-layout'
// 速览几何真源（叠放两张卡的尺寸差只有一份：主进程落 bounds 读它，见 glance-layout.mjs）
import { solveGlanceCards } from '@hira-ng/shared-types/src/glance-layout'
// 速览两张卡之间的装饰（投影 + 蓝色聚焦框）：**唯一**一份画进网页里的装饰 ——
// 它注入 back 卡那一页、贴着 front 的轮廓画（另两条框走外壳 DOM，见那个文件头的几何论证）。
import { createGlanceDeckChrome } from './glance-deck-chrome'
// 屏幕指针位置：chrome 收起 / 侧栏自动隐藏时「该不该唤出」的**唯一不依赖渲染层事件**的判据。
// 聚焦框几何推送的通道名 —— 与外壳 preload 的 `ngipc:event:<route>` 约定同源（不手写字符串）。
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels'
// 侧栏「位置偏好 → 实际侧别」的唯一一份算术（`'auto'` = 与工具区**同侧**，即跟随）。
import { DEFAULT_WEB_SIDEBAR_POSITION } from '@hira-ng/shared-types/src/web-sidebar'
// rail 位置 → 轴向 / 面板侧的唯一算术（横向 rail 的「偏左还是偏右、面板开哪侧」都在这里）。
import {
  normalizeRailPosition,
  normalizeRailHorizontalAlign,
  normalizeRailVerticalAlign,
  normalizeRailWidth,
  resolveRailPanelSide,
  isHorizontalRailPosition,
  RAIL_BAR_SIZE,
  RAIL_COLLAPSED_WIDTH
} from '@hira-ng/shared-types/src/layout'

/**
 * 侧栏区（垂直标签栏 / 未来任何住侧栏的块）**实际占宽**的唯一算法。
 *
 * 为什么抽成模块级函数：网页内缩（applyInitialLayout）与「页面内坐标 → 窗口坐标」
 * 的换算（getActiveTabViewOffset）必须用同一个数 —— 两处各算一遍，改动时必然漂移，
 * 表现为浮层/右键菜单整体错位一个侧栏的宽度。
 *
 * 三种形态共用这一条口径（**同一件事只有一份实现**）：
 *   · 常驻占位（autoHide=false）→ 渲染层实测宽（折叠态就是图标条宽）；
 *   · 悬停唤出·占位型（autoHide=true / revealOverlay=false，全功能侧栏）→
 *     静止 0，`revealed` 时取唤出宽度（网页真让位）；
 *   · 悬停唤出·浮层型（autoHide=true / revealOverlay=true，Edge 型垂直标签）→
 *     **恒为实测宽**（静止就是那条 56px 的标签 rail）；展开是盖在网页上的独立浮层
 *     （见 `_syncSideOverlayFloat`），网页不缩进、不重排。
 * 注意它**与 rail 的收起状态无关**：两者是纵向轨道上相邻但独立的区块。
 * @param {object} params 布局参数（见 _pageLayoutParams）
 * @param {boolean} revealed 是否处于悬停唤出态
 * @returns {number}
 */
import { zIndexFor, focusPriorityFor, createModalTo } from './LayerStack'

/**
 * 「页面自身会重建合成表面」的 webContents 事件（见 `_watchRadiusSurface`）。
 *
 * 为什么是这四个：跨文档导航（`did-navigate`）与进程内跳转（`did-navigate-in-page`）
 * 会让渲染器重新提交第一帧；`did-finish-load` 覆盖慢页面（表面在 navigate 之后才建好）；
 * `render-process-gone` 之后 Chromium 会用新进程重开一页，表面必然全新。
 * 圆角遮罩挂在这些表面上，事件一到就补写一次 —— 否则大圆角下页面四角会冒白色方块。
 */
const RADIUS_SURFACE_EVENTS = ['did-navigate', 'did-navigate-in-page', 'did-finish-load', 'render-process-gone'] as const

/**
 * 「贴边唤出」的两条判定参数（chrome 收起时的整屏唤出 + 侧栏自动隐藏时的悬停唤出共用）。
 *
 *   · IMMERSIVE_EDGE_PX —— 指针离窗口边缘多少像素以内算「贴上」（3px：与 Windows 的
 *     窗口缩放边距同量级 —— 够窄不误触，又够宽点得中）；
 *   · IMMERSIVE_TICK_MS  —— 巡看周期。只在指针事件够不着的时候跑（chrome 收起时网页
 *     铺满整窗；侧栏自动隐藏时它静止宽 0，边上没有任何 chrome 可 hover）。
 */
const IMMERSIVE_EDGE_PX = 3
const IMMERSIVE_TICK_MS = 80
/**
 * 侧栏悬停唤出的**退场宽限期**（毫秒）。
 *
 * 为什么需要：指针从侧栏移到网页上（或去点别的按钮）时必然**擦过**一条边界，
 * 零宽限就是"手一动侧栏就没了"。
 *
 * 浮层型与占位型共用同一条回滞：指针短暂擦出保持圈时，只要在宽限内回来就保持展开；
 * 越过窗口外缘则进入保持闩锁，直到指针重新进入窗口后才恢复退场判定。
 */
const SIDE_REVEAL_HIDE_DELAY_MS = 200
/** 展开后保持圈向内额外放宽的像素；吸收指针在手柄 / 边界附近的手抖。 */
const SIDE_REVEAL_KEEP_MARGIN_PX = 16
/**
 * 侧栏悬停唤出的**驻留阈值**（毫秒）：**只对浮层型（Edge）生效**。
 *
 * 用户口径：「edge 的悬停浮层是要 hover 280ms 再展开」。浮层一出现就整块盖住网页，
 * 指针只是掠过窗缘（去点窗口缩放边 / 划过屏幕边）时不该把面板砸下来。
 * 占位型（全功能侧栏）保持**立即**展开 —— 它只是把网页挤开一条，没有遮挡，
 * 而且用户对它的诉求是"贴着就出来"（宽度从 0 开始长，不会有东西被盖住）。
 *
 * 关闭方向两种形态统一使用短回滞，避免指针擦边时闪烁（见 `_tickSideReveal`）。
 */
const SIDE_REVEAL_ENTER_DELAY_MS = 280
/**
 * 侧栏巡看的采样周期（毫秒）。
 *
 * 为什么不复用 IMMERSIVE_TICK_MS（80）：上面那条 280ms 驻留阈值要的是"贴住多久"，
 * 80ms 的粒度会把 280ms 抖成 320ms（用户感知得到"要比 280ms 慢半拍"）；
 * 40ms 让**展开时机**与 **200ms 关闭宽限**都落在 ±40ms 内。25 次/秒读一次
 * `screen.getCursorScreenPoint()` 的开销可忽略（只在自动隐藏形态开着时才跑表）。
 */
const SIDE_REVEAL_TICK_MS = 40
/** 未固定 rail 的指针巡看周期与退场宽限；与占位型侧栏使用同一跟手节奏。 */
const RAIL_REVEAL_TICK_MS = 40
const RAIL_REVEAL_HIDE_DELAY_MS = 200
const RAIL_REVEAL_KEEP_MARGIN_PX = 16
/**
 * 浮层展开动画期间**补 hover** 的探针窗口（毫秒）与节拍。
 *
 * 浮层展开是 `clip-path` 划开（渲染层 `sidebar-float/main.js`，180ms），而 clip-path 会连
 * **命中区**一起裁 —— 动画期间被裁掉的区域不参与 hit-test。鼠标停在原地不动时浏览器
 * 压根没派发过 pointermove，于是动画播完行上也没有 hover 高亮，非要抖一下鼠标才出来
 * （用户口径："浮层显示时动画时，鼠标也能正常显示 hover 在 tab 上的连贯性"）。
 *
 * 这里在展开后的这段时间里按节拍补几条**合成** `mousemove`：`sendInputEvent` 产生的是
 * trusted 事件，能真正驱动 CSS `:hover` 与 mouseover 链路（合成 DOM 事件做不到）。
 * 窗口取动画时长的 4/3，保证最后一拍落在动画结束之后（那时整块都已可命中）。
 */
const FLOAT_HOVER_PROBE_MS = 240
const FLOAT_HOVER_PROBE_TICK_MS = 40
import { BoundsTween, type BoundsRect } from './BoundsTween'
import { FloatPointerAvoidController } from './FloatPointerAvoid'
import { FloatBoundsController } from './FloatBoundsController'
// 窗口材质（亚克力等）：原生窗口级效果。开/关状态由 backdrop 模块统一持有，
// 这里只负责把主题的 `style.material` 传下去，并处理"材质生效时不能写窗口底色"。
import { applyWindowBackdrop } from './backdrop'
import { WebContentsManager } from './WebContentsManager'

/**
 * 侧栏区在**纵向轨道**中的位置说明（配合 applyInitialLayout 阅读）：
 *
 *   同一侧由外侧到内侧 = [侧栏区 sideColumnWidth] → [rail sidebarWidth] → [面板 panelWidth]
 *
 * 三者同侧相邻时：侧栏区贴窗缘，rail 紧邻其内侧，面板最靠内。
 * 于是「网页内缩 = 三者之和」、「rail 的 x = 侧栏区宽度」，
 * 而面板 / rail 在右侧时只有右侧那部分计入右内缩。
 *
 * ⚠ 侧栏区与 rail/面板**各有自己的侧**（两条独立设置）——两段可以分居两侧。
 *   因此下面的算术按「每一侧各自累加」写，同侧时自然退化成上面那一句。
 */

/**
 * 标签容器图层：容器本身是一个空 View（非 WebContentsView），无法直接聚焦，
 * 故把 isVisible/isFocused/focus 代理到「当前可见的标签视图」——
 * 这样焦点再分配（reallocateFocus）会把键盘焦点正确交给网页，而非 chrome 层。
 */
/**
 * 外壳聚焦的**补偿时间表**（ms，相对首次请求）。
 *
 * 对齐 RT `Omnibox#show`：RT 也是 `window.focus()` + `layer.focus()` 后再
 * `setTimeout(tryFocus, 100)` 补一次 —— 单次 focus 拿不住。
 * 标签 WebContentsView 的抢焦发生在 `create → setVisible(true) → 首次 commit`
 * 之后几十到几百毫秒（Chromium 原生行为，不经过任何 JS focus 调用，无 hook 可拦），
 * 故按递减密度反复重申，把整个「新标签页开始加载 → 加载完成」窗口都覆盖住。
 */
const SHELL_FOCUS_RETRY_MS = [16, 40, 80, 140, 240, 380, 600, 900, 1250]

/**
 * 「把焦点还给浮层之前的持焦者」的重申拍次（_restoreFocusTo 专用）。
 * 与 SHELL_FOCUS_RETRY_MS 同形不同值：归还发生在浮层隐藏后，抢焦方已经退场，
 * 密度不必像"新建标签抢焦"那样高。
 */
const RESTORE_FOCUS_RETRY_MS = [16, 50, 120, 260, 500, 800, 1200]

/**
 * 「把键盘焦点还给内容面（网页 / 侧栏 / 面板）」的重申拍次（`restoreContentFocus` 专用）。
 *
 * 与上面两条的关系：它们都是「往某一个视图要焦点」，都需要重申；差别在**触发时机**——
 * 这一条发生在「窗口刚从失活回到前台」或「用户刚点了一下外壳的空白处」，两个时刻都伴随
 * Chromium 自己的焦点改派（窗口激活会重放 native focus），所以同样必须覆盖住最初几百毫秒。
 * 拍次比 SHELL_FOCUS_RETRY_MS 更稀：这条路径上没有「视图正在创建」那种持续抢占。
 */
const CONTENT_FOCUS_RETRY_MS = [0, 16, 40, 90, 180, 320, 600, 900, 1300]

/**
 * 「外壳抢到焦点就送回去」的宽容窗（毫秒）—— 从窗口重新激活算起。
 *
 * 必须存在的理由（用户实测："Alt+Tab 切回来什么都没有，得手动点网页"）：
 * 本项目的**外壳就是窗口本体 webContents**，标签 / 侧栏 / 面板全是它上面的
 * `WebContentsView`。Windows 激活 HWND 时，Chromium 把 native focus 重放给**窗口本体**
 * （外壳），子视图不会自动失而复得 —— 而这次重放发生的时刻**不可预知**：可能在激活后
 * 20ms，也可能在 1.2s 后（等渲染进程那一帧提交完）。固定拍次表覆盖不到的部分，
 * 只能靠 `webContents.on('focus')` 这个**事件**来接：外壳一拿到焦点，就该被送回去。
 *
 * 为什么要有窗口期：外壳拿到焦点也可能来自**用户主动点击**地址栏 / 工具栏。窗口期之外
 * 一律不插手 —— 那是用户意图。窗口期内还有 `_shellEditableFocused`、
 * `focusShell` 链在跑来区分"用户要打字"与"Chromium 重放"。
 */
const SHELL_BOUNCE_GRACE_MS = 1800

/**
 * 判定前的观察延迟（毫秒）：外壳的 `focus` 事件在**原生焦点已转移**时立刻到，
 * 但"用户点的是不是一个输入框"要等渲染层的 `focusin` → IPC 回报（约 1 帧）。
 * 等这么一下再判定，就不会把「点地址栏」误判成「Chromium 重放」。
 */
const SHELL_BOUNCE_DELAY_MS = 90

/**
 * 「外壳正在打字」这一判据的**保鲜期**（毫秒）。
 *
 * `_shellEditableFocused` 是渲染层上报的 DOM 事实，它在两种时刻会**残留**：
 *   · 窗口失活（Chromium 不清 DOM 焦点）；
 *   · 内容面被原生抢焦（外壳侧收不到可靠的 focusout）。
 * 残留的 true 在窗口重新激活那一刻恰好"过期作废"——只用它当判据，回焦链会被
 * 永久拦下（用户实测："Alt+Tab 切回来什么都没焦点"）。改为「值 + 时间戳」：
 * 只有**刚发生**的打字意图才算用户意图，超过这个窗口的残留值一律忽略。
 */
const SHELL_EDIT_INTENT_TTL_MS = 1200

/**
 * 「外壳抢焦就送回去」的**看门狗**节拍（毫秒）与总时长（见 SHELL_BOUNCE_GRACE_MS）。
 *
 * 为什么除事件之外还要一个轮询看门狗：窗口激活时 Chromium 把 native focus 重放给
 * 窗口本体（外壳）这件事本身**不保证**触发 `webContents.on('focus')`（外壳可能
 * 从未"失焦"过、或重放发生在渲染进程提交之后），而且重放时刻不可预知。
 * 事件漏掉一次就彻底没戏；看门狗只做有界轮询（窗口期内、每拍比对一次
 * `webContents.getFocusedWebContents()`），对漏事件天然免疫。
 */
const SHELL_FOCUS_WATCHDOG_MS = 60

/** 一次窗口激活里最多送回去几拍（Chromium 重放通常 1~3 次；这里只防病态反复抢）。 */
const SHELL_BOUNCE_MAX = 32

/**
 * `BrowserWindow#focus()` 的最小调用间隔（毫秒）。
 *
 * 该调用在 Windows 上等价于 `SetForegroundWindow`：会**真的**把窗口顶到最前。
 * 而回焦拍次表（0/16/40/90/180/320/600/900/1300）+ 看门狗（60ms × 30 拍）在窗口
 * 激活的 1.8s 内可以合计触发 30+ 次 —— 表现为窗口反复闪烁、从别的程序手里抢前台。
 * `webContents.focus()` 不受此限（它只改窗口内部的键盘焦点归属，无副作用），
 * 所以**只节流窗口这一层**，内容面重申的力度一点不减。
 */
const WIN_FOCUS_THROTTLE_MS = 300

/**
 * 内容尺寸为 0（启动期 / 最小化段）时 applyInitialLayout 的重排重试：
 * 每 16ms 一拍、最多 40 拍（≈640ms）。尺寸恢复后 win 的 resize 监听
 * （_onWinResize → applyInitialLayout immediate）会重新驱动，不需要无上限空转。
 */
const LAYOUT_RETRY_MS = 16
const LAYOUT_RETRY_MAX = 40

/**
 * 带退场动效的浮层在 renderer 回执前，bounds 保留的最长时间。
 * 取 420ms：明显长于浮层的退场动画（~160ms）与 renderer 自己的兜底（动画 +120ms），
 * 正常情况永远由 renderer 的 hidden 回执先到；这个值只在 renderer 崩了 / 没加载完时
 * 兜底，避免留下"僵尸浮层"。
 */
const FLOAT_EXIT_FALLBACK_MS = 420

/**
 * 浮层「闲置回收」等待时长：一个浮层**收起之后**超过这么久还没被再次显示，
 * 就销毁它的 WebContentsView，把那个 renderer 进程还回去。
 *
 * 为什么是 2 分钟：
 *   · 重建代价实测只有 **~65ms**（建视图 + 加载到 did-finish-load），远低于感知阈值 ——
 *     缓冲期本就不需要长。早期写 5 分钟是为了给**已被删除的"启动预热"**让路
 *     （见 browser-window-assembly 的文件头），预热一删，"保温"的意义就没了；
 *   · 2 分钟足够覆盖"连续操作同一只浮层"（手指在浮层与网页之间来回时不会闲置 2 分钟）；
 *   · 同时足够短 —— 一旦不再用它，那 ~104MB 工作集 / ~25MB 独占很快就还回去。
 *
 * 代价如实体现在这里：闲置超过 2 分钟的浮层，下次显示要付一次 ~65ms 的视图重建。
 * 内存压力来临时不依赖这个 TTL —— 见 `reclaimIdleFloatViews`（立即回收全部不可见浮层）。
 */
const FLOAT_IDLE_RECLAIM_MS = 2 * 60 * 1000

/**
 * 密码浮层（多凭据选择菜单 / 保存密码提示卡）的**闲置回收**等待时长。
 *
 * 为什么比普通浮层（2 分钟）还短：它是**极低频**的东西 —— 只在"保存密码""登录时多凭据"
 * 这类时刻出现，一次会话里可能一次都用不到。而它此前**只有创建、没有任何销毁路径**
 * （用户第一次遇到保存密码之后，那份 renderer 就永久常驻了，≈104MB 工作集 / 25MB 独占）。
 * 60 秒足够覆盖"同一处连续操作"（上下选凭据、改完再确认），之后不用就还回去。
 *
 * 重建代价与浮层相同：~65ms。
 */
const PASSWORD_IDLE_RECLAIM_MS = 60 * 1000

/**
 * 面板「关闭即卸载」——**关掉一个面板就立刻销毁它的 WebContentsView**，不留缓冲期。
 *
 * 为什么必须这么做（实测数据）：`WebContentsManager#createPanel` 是**一个面板一个
 * `WebContentsView` = 一个独立 renderer 进程**，而 `loadPanel` 的口径是"首次显示时加载，
 * 之后**保持存活**"——于是用户点开过的每一个面板都常驻一份渲染进程。
 * 实测 3 个面板 = 3 个 renderer = **310.7MB 工作集 / 89.2MB 独占**（平均每个 ~104/30MB）。
 * `destroyPanel` 早就存在（它自己的注释写着"面板视图只增不减……与『合理释放』的目标相反"），
 * 但此前只有 `reconcilePanels`（插件从目录消失时）会调它 —— **关掉面板什么都不释放**。
 *
 * 为什么是"立即"而不是闲置 N 分钟后再收：
 *   面板是**用户主动关闭**的东西 —— 关掉这个动作本身就表达了"我现在不用它了"，
 *   继续替它留着一个完整渲染进程没有依据。对比浮层（悬停预览、查找栏…）是"手一动就要
 *   再出现"的瞬态 UI，才需要一段缓冲期；面板的开/关频率低得多，重建代价只有 ~65ms
 *   （实测：建视图 + 加载到 did-finish-load），而省下的是 30MB 独占内存。
 *
 * 代价如实记在这里：**再打开时要重建**（~65ms + 面板内容重新从 domain 读一次），
 * 面板内的滚动位置与未保存的临时编辑会回到初始。
 */

/**
 * 「自己持有键盘焦点」的浮层 —— 显示后**必须由它自己持焦**，主进程不得把焦点还给原主。
 *
 * 为什么需要这条机制：浮层 renderer 加载完成 / 首次显示时，Chromium 会原生抢走键盘焦点，
 * 于是 `setFloatBounds` 走「还给原主」（`_restoreFocusTo`）把焦点还回去 —— 对**列表型**
 * 浮层（建议下拉、标签预览）这是对的：它们只要鼠标，键盘仍该留在地址栏 / 网页上。
 *
 * 但查找栏里住着一个 `<input>`：它被显示出来就是为了**接住键盘输入**，把焦点还给原主
 * 等于"打开就自动失焦、必须再点一下输入框才能打字"。所以这类浮层进入白名单，跳过归还；
 * 由它自己的 renderer 调 `focusFloat` 拿焦（见该方法）。
 */
const SELF_FOCUS_FLOATS = new Set([
  'findbar-overlay',
  'siteinfo-overlay',
  // 「总览」浮层一打开就把光标放进搜索框（与 Edge 标签操作菜单一致）——
  // 它是**自己持焦**的浮层，Esc / 输入都靠它自己接。
  'overview-overlay',
    // 浏览器壳叠加编辑器：工具条按钮、drag / Esc / undo 都需要键盘落在本视图。
    // 与总览同属铺满整窗的模态工作层。
    'buttons-edit-overlay',
  // 专注模式整窗浮层：它是**模态**（盖住窗口每一寸像素），键盘必须落在它身上，
  // 否则 Esc 会被下面的网页吃掉。由 main/break-overlay.js 显示后主动 focusFloat 拿焦。
  'break-overlay'
])

/**
 * 「只吃鼠标、从不吃键盘」的浮层 —— 可见时被点中也**不得**把键盘从外壳手里夺走。
 *
 * 为什么需要（用户实测："点下拉里的删除叉叉，下拉就被关掉、也没删掉"）：
 * 浮层是独立 WebContentsView，指针按在它上面的那一刻 Chromium 就**原生**把键盘焦点
 * 交给它 → 外壳地址栏 blur → 建议下拉被外壳收起（DOM 清空），于是行内按钮的 click
 * 永远不会到、删除也发不出去。
 *
 * 可是这类浮层的身份是"外壳某个输入框的建议列表"：方向键、回车、继续打字都必须落回
 * 那个输入框，键盘本就不该在它身上。所以一旦它抢到键盘，立刻交还外壳（外壳侧据此把
 * DOM 光标补回输入框、并取消那次"假失焦"的收起）。
 *
 * 与 SELF_FOCUS_FLOATS 恰好互补：那边是"自己就是要键盘"（查找栏 / 站点信息 / 总览），
 * 这边是"键盘永远不属于它"。新增同类浮层 = 在这张表里加一行。
 */
const MOUSE_ONLY_FLOATS = new Set([
  'searchbar-overlay'
])

/**
 * 收起后必须**重新分配键盘焦点**的浮层（交互式浮层）。
 *
 * 这类浮层常驻 visible、显隐只靠 bounds（0x0 = 收起），因此不会走 `Layer#setVisible`
 * 的焦点善后：用户点过它之后键盘焦点会留在那张 0×0 的视图上，之后所有键盘事件都掉进
 * "看不见的视图"（打字没反应）。收起时显式捞一次焦点，交给可见图层里的最优先者。
 */
const HIDE_FOCUS_REALLOC_FLOATS = new Set([
  'findbar-overlay',
  'zoom-overlay',
  // 站点信息卡：点过里面的开关后键盘焦点会留在它身上，收起时必须捞回来。
  'siteinfo-overlay',
  // 铺满整窗的模态下拉族：收起后焦点绝不能留在 0×0 的浮层视图上。
  'overview-overlay',
  'buttons-edit-overlay',
  'target-picker-overlay',
  // 插件浮层：用户点进卡片后键盘焦点会留在它身上，收起时必须捞回来。
  'plugin-overlay'
])

/**
 * 贴锚浮层（地址栏下拉）与窗口内容区四边的**默认最小留白**（px）。
 *
 * 为什么要留：`anchor-below` 的夹取以前是 0 / (cw−宽)、(ch−高) —— 窗口一窄、卡片一宽，
 * 下拉就会**正好贴到窗口边缘**（视觉上像粘在窗框上）。这个值是 view 的外缘下限，
 * 于是连同阴影留白在内的整块浮层都不会碰到边缘。
 */
const DEFAULT_FLOAT_EDGE_MARGIN = 8

/**
 * 窗口「前台可交互性」会变化的窗口事件名。
 *
 * 三条指针巡看表（侧栏悬停唤出 40ms / 沉浸贴边 80ms / 浮层指针避让 30Hz）每一拍都要
 * `win.getContentBounds()` + `screen.getCursorScreenPoint()`，而它们回答的问题
 * ——「指针在不在本窗口的那条边上」——在窗口最小化 / 被别的应用盖住 / 失焦时**不成立**。
 * 这里只做一件事：在这些事件上按需起停那三条表（判据见 `_windowInteractive`）。
 */
const WIN_ACTIVITY_EVENTS = ['blur', 'focus', 'minimize', 'restore', 'hide', 'show'] as const

type Side = 'left' | 'right'
type RailPosition = ReturnType<typeof normalizeRailPosition>
type RailHorizontalAlign = ReturnType<typeof normalizeRailHorizontalAlign>
type RailVerticalAlign = ReturnType<typeof normalizeRailVerticalAlign>
type Timer = ReturnType<typeof setTimeout>
type SplitSolved = ReturnType<typeof solveSplitPanes>
type GlanceSolved = ReturnType<typeof solveGlanceCards>
type BackdropResult = ReturnType<typeof applyWindowBackdrop>
type GlanceDeck = ReturnType<typeof createGlanceDeckChrome>
type ShellView = ReturnType<WebContentsManager['createUiShell']>
type PanelHostContract = Parameters<typeof installPanelLayoutController>[0]
type SidebarHostContract = Parameters<typeof installWebSidebarController>[0]
interface PanelIdentity { id: string; side: Side; pinned: boolean }
interface WindowEventPort {
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}
interface InputEventPort {
  on(event: 'input-event', listener: (event: ElectronEvent, input: Input) => void): unknown
  removeListener(event: 'input-event', listener: (event: ElectronEvent, input: Input) => void): unknown
}

interface ActiveSplitState {
  splitId: string
  members: string[]
  layout: unknown
  ratios: number[]
  activeTabId?: string | null
}

interface ActiveGlanceState {
  glanceId: string
  members: string[]
  frontTabId?: string | null
  activeTabId?: string | null
}

interface PageLayoutParams extends SideColumnLayoutParams {
  topbarHeight: number
  topbarVisible?: boolean
  bottombarHeight: number
  navSide: 'top' | 'bottom'
  sidebarWidth: number
  sidebarSide: Side
  railPosition: RailPosition
  railHorizontalAlign: RailHorizontalAlign
  railVerticalAlign: RailVerticalAlign
  sidebarAnimating?: boolean
  contentTopOffset?: number
  immersiveMode?: boolean
  sideColumnRevealWidth?: number
  sideColumnRect?: Rectangle | null
  sideColumnSide?: Side | null
  sideColumnResizing?: boolean
  [key: string]: unknown
}

interface FocusRestoreOptions {
  reason?: string
  immediate?: boolean
  retries?: boolean
  preempt?: boolean
  activation?: boolean
  defer?: boolean
}

interface ParentFocusRequestOptions {
  activation?: boolean
  preempt?: boolean
}

interface ApplyLayoutOptions {
  immediate?: boolean
  retries?: number
}

interface SideOverlayGeometry {
  bounds: { width: number; height: number }
  topbarHeight: number
  bottombarHeight: number
  columnSide: Side
  sideGone: boolean
}

interface FloatAnchorRequest extends Partial<Rectangle> {
  anchor?: {
    left?: number
    top?: number
    width?: number
    height?: number
    align?: 'left' | 'right' | 'center'
    valign?: 'below' | 'center'
  }
  card?: { width?: number; height?: number }
  width?: number
  height?: number
  pad?: number | { top?: number; right?: number; bottom?: number; left?: number }
  gap?: number
  margin?: number
  panelSide?: Side | null
  align?: 'left' | 'right' | 'center'
  valign?: 'top' | 'bottom' | 'center'
  [key: string]: unknown
}

interface TabThemeOptions {
  surfaceBackgroundColor?: string
  radius?: number
  inset?: number
  frameBackgroundColor?: string
  accentColor?: string
  windowMaterial?: string
}

interface RailLayoutOptions {
  position?: string
  horizontalAlign?: string
  verticalAlign?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface LayoutCoordinatorOptions {
  panelWidth?: number
  headerHeight?: number
  railWidth?: number
  railPinned?: boolean
  railPosition?: string
  sidebarPosition?: string
  railHorizontalAlign?: string
  railVerticalAlign?: string
  sideColumnSide?: string | null
  contentPadding?: number
  contentInsetTop?: number
  contentInsetLeft?: number
  contentInsetRight?: number
  contentInsetBottom?: number
  tabBorderRadius?: number
  frameBackgroundColor?: string
  accentColor?: string
  pinnedPanelWidth?: number
  webSidebarWidth?: number
  onPanelSideChanged?: (panelId: string, side: Side | null, pinned: boolean) => void
  [key: string]: unknown
}

class LayoutCoordinator {
  private readonly _win: BrowserWindow
  private readonly _wcm: WebContentsManager
  private _panelWidth: number
  private _panelWidths: Record<Side, number>
  private _headerHeight: number
  private _railWidth: number
  private _railRestoreExpanded: boolean | null
  private _railRestoreWidth: number
  private _railRevealed: boolean
  private _railRevealLeaveAt: number
  private _railRevealWatch: Timer | null
  private _immersiveRevealed: boolean
  private _editingPresentation: boolean
  private _railPinnedBeforeEditing: boolean | null
  private _immersiveWatch: Timer | null
  private _chromeDragSuppressedListener: ((suppressed: boolean) => void) | null
  private _lastChromeDragSuppressed: boolean | null
  private _railPosition: RailPosition
  private _railHorizontalAlign: RailHorizontalAlign
  private _railVerticalAlign: RailVerticalAlign
  private _sidebarPosition: Side
  private _sideColumnSide: Side | null
  private _contentPadding: number
  private _sideColumnAutoHide: boolean
  private _sideColumnRevealOverlay: boolean
  private _sideRevealed: boolean
  private _sideRevealLeaveAt: number
  private _sideRevealEnterAt: number
  private _sideRevealHold: boolean
  private _sideRevealSuspended: boolean
  private _sideOverlayShown: boolean
  private _sideOverlaySide: Side | null
  private _sideRevealWatch: Timer | null
  private _sideColumnRevealListener: ((revealed: boolean) => void) | null
  private _contentInsetTop: number
  private _contentInsetLeft: number
  private _contentInsetRight: number
  private _contentInsetBottom: number
  private _tabBorderRadius: number
  private _pageLayoutParams: PageLayoutParams
  private _frameBackgroundColor: string
  private _tabAccent: string
  private _windowMaterial: string
  private _windowMaterialResult: BackdropResult | null
  private _paintedFrameColor: string
  private _uiShellView: ShellView | null
  private _railView: WebContentsView | null
  private _railPinned: boolean
  private _floatViews: Map<string, WebContentsView>
  private _floatBounds: Map<string, Rectangle>
  private _floatBoundsController: FloatBoundsController
  private _floatThrottled: Map<string, boolean>
  private _floatInteractive: Map<string, boolean>
  private _floatHoverProbe: Timer | null
  private _pointerAvoid: FloatPointerAvoidController
  private _chromeDragBands: Rectangle[]
  private _floatDragGuardOpen: boolean
  private _floatDragGuardListener: ((open: boolean) => void) | null
  private _floatVisible: Map<string, boolean>
  private _floatSeq: Map<string, number>
  private _floatOpener: Map<string, WebContents>
  private _floatDismissOutside: Set<string>
  private _floatDismissListener: ((name: string) => void) | null
  private _floatDismissBound: Map<WebContents, (event: ElectronEvent, input: Input) => void>
  private _floatReclaimTimers: Map<string, Timer>
  private _passwordOverlayView: WebContentsView | null
  private _lastPasswordOverlayViewportKey: string
  private _lastPasswordOverlayPlacement: FloatAnchorRequest | null
  private _panelSlots: Record<Side, string | null>
  private _panelPinned: Record<Side, string | null>
  private _pinnedWidths: Record<Side, number>
  private _onPanelSideChanged: ((panelId: string, side: Side | null, pinned: boolean) => void) | null
  private _panelViewPort: PanelHostContract['_panelViewPort']
  private _panelParts: PanelHostContract['_panelParts']
  private _pendingPanelPlace: PanelHostContract['_pendingPanelPlace']
  private _preparedPanel: PanelHostContract['_preparedPanel']
  private _passwordReclaimTimer: Timer | null
  private _webSidebar: SidebarHostContract['_webSidebar']
  private _webSidebarSideListener: (() => void) | null
  private _webSidebarViewPort: SidebarHostContract['_webSidebarViewPort']
  private _webSidebarParts: SidebarHostContract['_webSidebarParts']
  private _lastWebSidebarRect: Rectangle | null
  private _webSidebarInsets: { left: number; top: number; right: number; bottom: number }
  private _webSidebarHandleRect: Rectangle | null
  private _webSidebarActive: boolean
  private _webSidebarDropPreview: string | null
  private _webSidebarSlotBySide: Record<string, Rectangle> | null
  private _webSidebarDropPreviewPort: ((rect: Rectangle | null) => void) | null
  private _tabFocusHooked: WeakSet<WebContentsView>
  private _activeTabId: string | null
  private _tabBounds: Rectangle | null
  private _tabBoundView: WebContentsView | null
  private _tabIsFullscreen: boolean
  private _layers: LayerManager
  private _shellFocusRetries: Timer[]
  private _floatFocusRetries: Timer[]
  private _panelFocusRetries: Timer[]
  private _restoreFocusRetries: Timer[]
  private _focusMemory: ContentFocusMemory<WebContents>
  private _chromeFocusViews: Set<WebContents>
  private _contentSurfaceGuards: Map<string, (entry: ContentFocusEntry<WebContents>) => boolean>
  private _shellEditableFocused: boolean
  private _shellEditableAt: number
  private _contentFocusRetries: Timer[]
  private _shellBounceUntil: number
  private _shellBounceCount: number
  private _shellBounceTimer: Timer | null
  private _shellFocusListener: { wc: WebContents; onFocus: () => void } | null
  private _shellFocusWatchdog: Timer | null
  private _shellWatchdogDeadline: number
  private _lastWinFocusAt: number
  private _layoutRetryCount: number
  private _layoutRetryTimer: Timer | null
  private _floatFocusHolders: Map<string, WebContents | null>
  private _floatExitPending: Map<string, boolean>
  private _floatExitTimers: Map<string, Timer>
  private _chromeLayers: Map<string, Layer>
  private _tabLayer: View | null
  private _tabHostLayer: TabHostLayer | null
  private _tabLayerChildren: Set<View>
  private _visibleTabView: WebContentsView | null
  private _visibleTabIds: Set<string>
  private _activeSplit: ActiveSplitState | null
  private _lastSplitSolved: SplitSolved | null
  private _lastSplitGeometryKey: string
  private _lastWebSidebarFrameKey: string
  private _activeGlance: ActiveGlanceState | null
  private _lastGlanceSolved: GlanceSolved | null
  private _lastGlanceGeometry: { back: Rectangle; radius: number } | null
  private _glanceDeck: GlanceDeck | null
  private _lastGlanceBackId: string | null = null
  private _lastBounds: WeakMap<View, Rectangle>
  private _lastRadius: WeakMap<WebContentsView, number>
  private _radiusWatchers: WeakSet<WebContentsView>
  private _lastPageBounds: Rectangle | null
  private _tabTween: BoundsTween
  private _resizeBound = false
  private _winActivityBound = false
  private _onWinResize: (() => void) | null = null
  private _onWinActivity: (() => void) | null = null

  constructor(win: BrowserWindow, webContentsManager: WebContentsManager, options: LayoutCoordinatorOptions = {}) {
    this._win = win
    this._wcm = webContentsManager
    this._panelWidth = options.panelWidth ?? 360
    /**
     * 左右两个面板位**各自的宽度**：用户各拖各的，互不干扰（右侧面板宽不该被左侧的拖拽改掉）。
     * 记忆（重启后仍是这个宽度）由设置项 app.panel_width_left / app.panel_width_right 承担，
     * 见 settings/appliers/layout.js。
     * @type {{ left: number, right: number }}
     */
    this._panelWidths = { left: this._panelWidth, right: this._panelWidth }
    this._headerHeight = options.headerHeight ?? 140
    this._railWidth = options.railWidth == null
      ? RAIL_COLLAPSED_WIDTH
      : normalizeRailWidth(options.railWidth)
    this._railRestoreExpanded = null
    this._railRestoreWidth = this._railWidth
    /**
     * 未固定 rail 的贴边唤出态。与全功能侧栏的占位型自动隐藏同口径：
     * 静止宽 0，唤出时恢复 rail 自身宽度并让网页真实让位。
     */
    this._railRevealed = false
    this._railRevealLeaveAt = 0
    this._railRevealWatch = null
    /**
     * 沉浸 / 全屏下的**贴边唤出**状态：指针贴到窗口任一条边缘 → 整套界面一起回来
     * （顶栏 + 侧栏区 + rail + 面板 + 底部栏），指针离开这套界面再一起收起。
     *
     * 为什么是**一个**状态、不按方向各记一个：用户要的是「全都一起展开，而不是只展开
     * 一个方向」（原话）。按边记两份必然出现"贴了上缘只出顶栏、贴侧缘只出侧栏"，
     * 而沉浸模式的语义是"UI 收起 ↔ UI 全出"这一对二的切换 —— 一份状态、一个判据。
     */
    this._immersiveRevealed = false
    /**
     * chrome 收起时的窗口拖拽让位态。
     *
     * Chromium 会合并**整个窗口**所有 WebContentsView 的 -webkit-app-region；
     * 沉浸模式网页铺满后，下层 navbar / tabbar 的 drag 仍会命中。这里把
     * 「chrome 收起且尚未贴边唤出」作为唯一判据，只在跳变时通知宿主。
     */
    this._chromeDragSuppressedListener = null
    this._lastChromeDragSuppressed = null
    /** 编辑器临时“全部展开”态：不改设置，只覆盖本轮原生布局预算。 */
    this._editingPresentation = false
    this._railPinnedBeforeEditing = null
    /**
     * 贴边唤出的指针巡看定时器（null = 没在跑）。
     * 只在 chrome 收起时跑 —— 那时渲染层收不到任何指针事件，只能由主进程读屏幕指针位置。
     */
    this._immersiveWatch = null
    // 工具图标栏（rail）位置：left / right（纵向列）或 top / bottom（横向条）。
    // 由设置项 app.sidebar_position 驱动；横向时面板所在侧由「按钮起始边」解算。
    this._railPosition = normalizeRailPosition(options.railPosition || options.sidebarPosition)
    // rail 按钮起始边：横向用 left/right（决定 rail 偏左偏右 → 面板开哪侧），
    // 纵向用 top/bottom（只影响按钮堆叠方向）。设置页各一条，互不串用。
    this._railHorizontalAlign = normalizeRailHorizontalAlign(options.railHorizontalAlign)
    this._railVerticalAlign = normalizeRailVerticalAlign(options.railVerticalAlign)
    // 面板（下载 / 历史 …）所在侧：纵向 rail = rail 自身侧；横向 rail = 起始边解算出的侧。
    // **一切"工具区在哪一侧"的判断都读它**，不直接读 rail 位置。
    this._sidebarPosition = resolveRailPanelSide(this._railPosition, this._railHorizontalAlign)
    /**
     * 侧栏区（垂直标签栏那一列）**自己那一侧**；null = 跟随 rail（历史行为：两段同侧）。
     *
     * 由设置项 app.side_column_position 驱动（applier 注入），并由渲染层随占宽一起上报
     * 纠正。它与 `_sidebarPosition` 相互独立 —— 两段可以各靠一边（见 applyInitialLayout）。
     * @type {'left'|'right'|null}
     */
    this._sideColumnSide = options.sideColumnSide === 'left' || options.sideColumnSide === 'right'
      ? options.sideColumnSide
      : null
    this._contentPadding = options.contentPadding ?? 4
    /**
     * 侧栏区的「悬停唤出」。
     *
     * 字段与侧栏 DOM 的形态**完全解耦**：
     *   · `_sideColumnAutoHide`       —— 形态开关（`app.sidebar_visibility = floating`）；
     *   · `_sideColumnRevealOverlay`  —— 唤出方式（Edge 型垂直标签为 true = 浮层型）；
     *   · `_sideRevealed`             —— 此刻是否唤出（本类按屏幕指针位置裁定）；
     *   · `_sideRevealLeaveAt`        —— 指针离开展开区的时刻（0 = 还在圈内；宽限期用）；
     *   · `_sideRevealWatch`          —— 指针巡看定时器（null = 没在跑）。
     *
     * 两种唤出方式（同一份部署、同一份巡看与宽限，只有"怎么露出"不同）：
     *   · **占位型**（revealOverlay=false，全功能侧栏）→ 静止宽 0，唤出时把唤出宽
     *     播给外壳，网页真让位；
     *   · **浮层型**（revealOverlay=true，Edge 型垂直标签）→ 静止就是那条 56px 的
     *     标签 rail（网页让出 56px），唤出时把一条**独立浮层**（WebContentsView）
     *     盖在网页上展开到 revealWidth —— 网页**不缩进、不重排**（见 `_syncSideOverlayFloat`）。
     *
     * 为什么必须由主进程判：静止时那条边上要么是网页原生视图、要么是 chrome，
     * 渲染层都不该替它算"此刻该不该展开"（浮层一出现就会盖住光标 → DOM hover 必然抖）。
     */
    this._sideColumnAutoHide = false
    this._sideColumnRevealOverlay = false
    this._sideRevealed = false
    /** 指针离开保持圈的时刻（Date.now()；0 = 在圈内）。 */
    this._sideRevealLeaveAt = 0
    /**
     * 指针开始**贴边驻留**的时刻（Date.now()；0 = 没贴边）。
     * 只用于浮层型（Edge）的 SIDE_REVEAL_ENTER_DELAY_MS 阈值 —— 占位型贴边即展开。
     */
    this._sideRevealEnterAt = 0
    /**
     * 「唤出保持」——拖动标签期间冻结巡看（见 {@link setSideRevealHold}）。
     *
     * 为什么必须有：拖一个标签从侧栏里出来时，指针必然离开保持圈 → 巡看立刻收起侧栏
     * 浮层 → **拖拽源视图在拖动中被写成 0×0** → Windows 取消原生拖拽、`dragend` 丢失
     *（表现：分屏预览/会话黏住、松手误触分屏）。拖动期间只要"别动它"，源视图就一直活着。
     */
    this._sideRevealHold = false
    /** 模态编辑期间完全冻结侧栏边缘唤出（独立于标签拖拽 hold）。 */
    this._sideRevealSuspended = false
    /** 浮层型：浮层此刻是否已按唤出态铺开（= 上一次 show 已下发）。 */
    this._sideOverlayShown = false
    /** 浮层型：浮层上一次下发的侧别（换边要重发 show 让 renderer 换边）。 */
    this._sideOverlaySide = null
    /** @type {ReturnType<typeof setInterval>|null} */
    this._sideRevealWatch = null
    /**
     * 唤出态变化的外通告（宿主注入：window-chrome 用它广播给外壳）。
     * @type {((revealed: boolean) => void) | null}
     */
    this._sideColumnRevealListener = null
    // 页面四周的「边距空隙」必须**四边同值**：它是页面与 chrome 之间那一圈底色，
    // 只有左/右/下有、上面为 0 时，页面会与顶栏（含书签栏）贴死在一条线上 ——
    // 书签栏看起来就落进了这圈空隙里。补上 top 之后，书签栏/工具栏在空隙**之外**，
    // 页面是一圈完整的 4px 环绕（对齐 Hira 的 --corner-inset-top）。
    this._contentInsetTop = options.contentInsetTop ?? 4
    this._contentInsetLeft = options.contentInsetLeft ?? 4
    this._contentInsetRight = options.contentInsetRight ?? 4
    this._contentInsetBottom = options.contentInsetBottom ?? 4
    this._tabBorderRadius = options.tabBorderRadius ?? 6
    this._pageLayoutParams = {
      topbarHeight: this._headerHeight,
      topbarVisible: true,
      // 底部工具栏占用高度（底部布局 = 工具栏高度；其余布局为 0）
      bottombarHeight: 0,
      // 导航栏（地址栏那块）所在侧 —— 地址栏下拉的锚定方向由它决定，见 anchorFloatBelowTopbar
      navSide: 'top',
      sidebarWidth: this._railWidth,
      sidebarSide: this._sidebarPosition,
      // rail 轴向 + 起始边：布局/渲染共用同一份事实，避免横向 rail 被当成纵向列。
      railPosition: this._railPosition,
      railHorizontalAlign: this._railHorizontalAlign,
      railVerticalAlign: this._railVerticalAlign,
      sidebarAnimating: false,
      /**
       * 侧栏区（垂直标签栏 / 未来任何住在侧栏里的块）的占宽。
       *
       * 它是**纵向轨道上最靠外**的一段：网页内缩 = 侧栏区 + rail + 面板，
       * 而 rail 的 x 要让出侧栏区（见 applyInitialLayout）——
       * 否则 rail 会压在侧栏之上（rail z=20 高于 chrome 本体）。
       */
      sideColumnWidth: 0,
      sideColumnVisible: true,
      contentTopOffset: 0
    }
    this._frameBackgroundColor = options.frameBackgroundColor || '#f9fafb'
    /**
     * 主题强调色（= `palette.accent`，见 `setTabTheme`）。
     *
     * 为什么要在这里存一份：速览的卡片间聚焦框是**注入进网页**的样式
     * （`glance-deck-chrome.js`），那一页里没有 `--hira-accent`，只能把色值带过去。
     * 分屏活动格框 / 侧栏聚焦框走外壳 DOM，直接读令牌，不需要这条。
     */
    this._tabAccent = options.accentColor || ''
    /** 当前窗口材质 id（`none` / `acrylic`…）—— 主题 `style.material` 的落点。 */
    this._windowMaterial = 'none'
    /** 上一次材质应用结果（`{ material, applied, supported, reason, message }`），供上层读取。 */
    this._windowMaterialResult = null
    /**
     * 上次真正写进 `win.setBackgroundColor` 的颜色（空串 = 材质态，窗口底色归 DWM 管）。
     * 用途：材质关闭后只在"值真的变了"时才写回，避免每次主题发布都惊动系统重绘。
     */
    this._paintedFrameColor = ''
    this._uiShellView = null
    this._railView = null
    this._railPinned = options.railPinned !== false
    // 独立浮层视图表：name → WebContentsView。每个浮层一份，绝不共用。
    // ⚠ 叠放次序的唯一真源是 `LayerStack#Z_INDEX`（LayerManager 按 layer.zIndex 升序挂载）。
    //   这里曾有一份 `_floatOrder`「浮层名单」数组 —— 它是**只写不读**的状态
    //   （谁算浮层的真源是渲染入口表 + `ipc/layout.js` 的 FLOAT_NAMES），
    //   留着等于第三份会漂移的名单，已删。
    this._floatViews = new Map()
    this._floatBounds = new Map()
    this._floatBoundsController = new FloatBoundsController({
      getView: (name) => this._floatViews.get(name),
      getBounds: (name) => this._floatBounds.get(name),
      setBounds: (name, bounds, view) => {
        this._floatBounds.set(name, bounds)
        view.setBounds(bounds)
      },
      syncThrottle: (name, throttled) => this._syncFloatThrottle(name, throttled),
      syncDragGuard: () => this._syncFloatDragGuard(),
      hasDismissOutside: (name) => this._floatDismissOutside.has(name),
      syncDismissSources: () => this._syncFloatDismissSources(),
      raiseFloat: (name) => this.raiseFloatView(name),
      restoreFocusTo: (webContents) => this._restoreFocusTo(webContents),
      scheduleReclaim: (name) => this._scheduleFloatReclaim(name),
      cancelReclaim: (name) => this._cancelFloatReclaim(name),
      setInteractive: (name, interactive) => this.setFloatInteractive(name, interactive),
      isWebContentsFocused: (webContents) => this._isWcFocused(webContents),
      reallocateFocus: () => this._layers.reallocateFocus(),
      restoreContentFocus: (options) => this.restoreContentFocus(options),
      takeFocusHolder: (name) => {
        const holder = this._floatFocusHolders.get(name) || null
        if (holder) this._floatFocusHolders.delete(name)
        return holder
      },
      selfFocusFloats: SELF_FOCUS_FLOATS,
      hideFocusReallocFloats: HIDE_FOCUS_REALLOC_FLOATS
    })
    /**
     * 收起态浮层的 backgroundThrottling 记账（name → 当前是否节流）。
     *
     * 浮层**常驻 visible**、只用 0×0 bounds 表示收起（见 _ensureFloatView）。而 Electron
     * 的规则是「同一窗口内只要有**任一 displayed webContents 关掉了 backgroundThrottling，
     * 整窗所有 webContents 都会持续出帧」。浮层为了首帧不空白，创建时关掉了它 ——
     * 于是**一个收起的 0×0 浮层会让整个窗口（含正在播放/滚动的标签）永久 60fps 出帧**。
     * 这里按显隐跳变把它重新打开/关闭：收起 = true（回到默认行为，整窗不再被它拖住），
     * 显示 = false（保持首帧秒出）。表只记跳变，稳态零调用。
     */
    this._floatThrottled = new Map()
    this._floatInteractive = new Map()
    /** @type {ReturnType<typeof setInterval>|null} 「展开动画期间补 hover」的探针表（自停，见 _startFloatHoverProbe） */
    this._floatHoverProbe = null
    this._pointerAvoid = new FloatPointerAvoidController({
      window: this._win,
      getCursorPoint: () => screen.getCursorScreenPoint(),
      isWindowInteractive: () => this._windowInteractive(),
      isFloatVisible: (name) => this.isFloatVisible(name),
      getFloatBounds: (name) => this._floatBounds.get(name),
      hideFloat: (name) => this.hideFloat(name)
    })
    /**
     * chrome **拖拽带**（窗口坐标系）——本趟布局算出来的那几块「谁在上面谁就顶替标题栏」的矩形。
     *
     * 存在的唯一理由：`-webkit-app-region` 由 Chromium 按**整个窗口**合并所有
     * WebContentsView 的命中区 —— 浮层无法「盖住」下层视图声明的 drag 区。于是任何
     * 浮层（交互式也好、穿透式也好）只要压在拖拽带上，点在浮层上的那一下就会被窗口
     * 当成拖动标题栏吃掉。唯一解法是让下层视图在**这种时刻**主动放弃 drag，
     * 而「这种时刻」的判据必须由几何回答：**浮层矩形 ∩ 拖拽带 ≠ ∅**。
     *
     * 拖拽带只有这四处来源（都在 applyInitialLayout 同一趟里算，绝不另算一遍）：
     * 顶栏带（navbar / tabbar / titlebar / 书签栏）、底栏带、rail 列（空白区的 drag）、
     * 各面板列（面板标题栏的 drag）。侧栏区整列 no-drag，故不在表里。
     * @type {Array<{x:number,y:number,width:number,height:number}>}
     */
    this._chromeDragBands = []
    /** 上一拍「是否有浮层压在拖拽带上」——只在**跳变**时通知宿主，见 _syncFloatDragGuard。 */
    this._floatDragGuardOpen = false
    /**
     * 「浮层压在 chrome 拖拽带上」观察者（宿主注入）。
     *
     * 这里只做「广播事实」，不认识任何具体浮层、也不认识渲染层 —— 投递由宿主决定。
     * @type {((open: boolean) => void) | null}
     */
    this._floatDragGuardListener = null
    /**
     * 逻辑可见态（唯一真相源）+ 代际号：
     * renderer 只是「请求方」；浮层最终是否可见由主进程裁定。每次 show / hide 递增
     * 代际号；迟到的 display（renderer 测量后回传）或冷启动才下发的 show，若与当前
     * 意图不符一律作废 —— 否则「收起后又被 display 复活」会让浮层闪一下再弹出来，
     * 「hide 先到、show 后到」也会让它凭空弹出。
     * @type {Map<string, boolean>}
     */
    this._floatVisible = new Map()
    /** @type {Map<string, number>} */
    this._floatSeq = new Map()
    /**
     * 浮层的**发起方**（show 请求来自哪个 webContents）。
     *
     * 为什么要有它：同一只浮层可能被两三个不同的视图打开 —— 空间菜单既可能由外壳
     * （navbar / 常驻侧栏里的切换器）打开，也可能由**侧栏浮出层**（独立视图）打开；
     * 而浮层的回传（`overlay:commit`）必须回到**打开它的那一个视图**手里 ——
     * 回传写死给外壳时，浮出层开的那只菜单点「选择空间」后外壳不认为菜单还开着，
     * 于是既不收起浮层也不处理后续（表现：菜单再也关不掉）。
     * 与「面板 hover 预览按发送方判定贴哪条边」同一条思路：谁发起，谁收到回音。
     * @type {Map<string, Electron.WebContents>}
     */
    this._floatOpener = new Map()
    /**
     * 「点击浮层外部即收起」登记（name 集合）+ 宿主回调。
     *
     * 为什么放在布局层：浮层是独立的 WebContentsView，点击网页 / 其它 chrome 视图
     * 时浮层 renderer 根本收不到任何事件（它只在自己的矩形里收鼠标）。唯一可靠的
     * 观测点是主进程 —— 对这些视图挂 `input-event`，命中 mouseDown 就说明用户
     * 把注意力挪走了。这里只广播事实（哪个浮层该收），怎么收由宿主决定，
     * infra 不认识 siteinfo / searchbar 这些业务名。
     * @type {Set<string>}
     */
    this._floatDismissOutside = new Set()
    /** @type {((name: string) => void) | null} */
    this._floatDismissListener = null
    /**
     * 已挂 input-event 的来源视图（wc → handler）。
     * 只在「有可收起浮层正在屏上」期间持有，全部收起即整表解绑 ——
     * 页面 mousemove 同样会触发 input-event，常态挂着等于白付一次主进程回调。
     * @type {Map<Electron.WebContents, Function>}
     */
    this._floatDismissBound = new Map()
    /**
     * 各浮层的**闲置回收**定时器（name → timer）。
     *
     * 按需启停，绝不是常态轮询：收起时排一个、显示时撤掉 ——
     * 没有任何浮层处于"已收起"状态时这张表是空的，也就没有任何定时器。
     * 见 `_scheduleFloatReclaim` / `_reclaimFloatView`。
     * @type {Map<string, ReturnType<typeof setTimeout>>}
     */
    this._floatReclaimTimers = new Map()
    this._passwordOverlayView = null
    this._lastPasswordOverlayViewportKey = ''
    this._lastPasswordOverlayPlacement = null
    /**
     * 面板位：'left' | 'right' → panelId | null。
     *
     * 为什么是**两个位**而不是一个"活动面板"：打开面板的入口分居窗口两侧 ——
     * rail 图标在自己那一侧（跟随 app.sidebar_position），导航栏的面板按钮则由**它自己
     * 此刻住哪**决定：在顶部导航栏时靠右，随工具按钮行借住到标签侧栏时就是侧栏那一侧
     * （见 windowControlsPlacement/sideDock 一族的说明）。
     * 各自声明要哪一侧，两侧就能同时各挂一个面板（左边看标签列表、右边看历史…）。
     *
     * 一个面板**同时只占一个位**（每个 panelId 只有一份 WebContentsView）：把已经
     * 显示在左边的面板再从 navbar 打开，结果是它挪到右边、左边空出来 —— 不是开两个。
     */
    this._panelSlots = { left: null, right: null }
    /**
     * **钉住位**：'left' | 'right' → panelId | null（每侧最多一个）。
     *
     * 与 `_panelSlots`（普通位）的关系：
     *   · 普通位 = 「切换即替换」的那一格（rail 点什么都往这里放）；
     *   · 钉住位 = 「切换不动它」的那一格 —— 用户按下标题栏的图钉后，这块面板**常驻**，
     *     同侧再开别的面板只会替换普通位，钉住的面板一直在。
     *
     * 轨道顺序（同一侧由外到内）：**[侧栏区] → [rail] → [普通面板] → [钉住面板] → [网页]**。
     * 钉住面板因此**更靠网页那一侧**（用户原话："固定的面板始终更往外，指靠向网页视图这一边"），
     * 普通面板则始终贴着 rail / 窗口边缘。
     *
     * 一个 panelId 全局只有一份视图，所以**同一块面板只能在普通位或钉住位之一**。
     * @type {{ left: string|null, right: string|null }}
     */
    this._panelPinned = { left: null, right: null }
    /**
     * 钉住位的宽度（与普通位**各记各的**：钉住面板通常更窄，拖它不该改到普通位）。
     * @type {{ left: number, right: number }}
     */
    this._pinnedWidths = { left: options.pinnedPanelWidth ?? 320, right: options.pinnedPanelWidth ?? 320 }
    /**
     * 「某面板实际所在侧」变化时的上报口（宿主注入，见 browser-window-assembly）。
     * infra 不认识事件名，只回答事实；面板宿主据此把拖拽手柄放到面向内容的那条边、
     * 以及把图钉按钮画成"已钉住"的样子。
     * @type {((panelId: string, side: 'left'|'right'|null, pinned: boolean) => void) | null}
     */
    this._onPanelSideChanged = typeof options.onPanelSideChanged === 'function' ? options.onPanelSideChanged : null
    /**
     * **面板视图端口**（apps 装配期用 `setPanelViewPort` 注入）。
     *
     * 为什么是端口而不是自己 `_wcm.createPanel() / loadPanel()`：那样布局层就得知道"面板里装
     * 什么"（我们的本地页？别人的远程站？用什么 preload / session / UA？）—— 而它只该知道
     * "这块矩形归谁"。端口把"造 / 加载"整体留在 apps 层（那里是**唯一**认识面板种类的地方）。
     * @type {{ ensurePanelView?: (panelId: string) => import('electron').WebContentsView|null, destroy?: (panelId: string) => boolean }|null}
     */
    this._panelViewPort = null
    /**
     * 端口交回来的**视图包**：`panelId → { content, header, headerHeight }`。
     * 本类只读它（读视图去摆、读一个数字去算顶条），不认识它从哪来。
     */
    this._panelParts = new Map()
    /**
     * 「已请求打开、但页面还没就绪」的面板：`panelId → 目标侧`。
     *
     * 为什么需要它（用户原话：「不加载出来就不要有空面板了」）：
     * 面板"关闭即卸载"之后每次打开都要重建视图，而新视图要 ~65ms 才能画出内容。
     * 若这两件事分开做（先给面板占位、再等视图画出来），用户看到的就是
     * **"网页先收窄 → 空面板区域停 65ms → 内容才出现"** —— 视觉上就是闪/抖。
     * 这里改成**就绪前根本不占位**：`_panelSlots` 不写、布局不动、界面完全不变；
     * 等页面就绪后一次性"占位 + 显示 + 应用布局"，面板**原子地**出现。
     *
     * 它同时是"这一侧是否已被预约"的标志 —— `_placePanel` 据此**跳过写槽**，
     * `showPanel` / `switchPanel` 据此**跳过 applyInitialLayout**（否则网页会先收窄）。
     * @type {Map<string, 'left'|'right'>}
     */
    this._pendingPanelPlace = new Map()
    /**
     * 「意图预取」出来的那块面板：`{ id, timer }` | null（**单槽**）。
     *
     * 见 `preparePanel`：视图已造好并在后台加载，但**不占位、不挂图层**。
     * 单槽是刻意的 —— 预取的唯一理由是"下一拍就点它"，用户不可能同时悬停两个入口；
     * 换目标时前一份立刻回收，常驻上限因此恒为 1 个进程。
     * @type {{ id: string, timer: ReturnType<typeof setTimeout> }|null}
     */
    this._preparedPanel = null
    /**
     * 密码浮层的闲置回收定时器（单个 —— 它只有一份视图）。
     * 收起时排、显示时撤，与 `_floatReclaimTimers` 同款：不需要时它是 null。
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this._passwordReclaimTimer = null
    /**
     * **独立侧栏（Web Sidebar）** —— 远程网页住的第三块区域。
     *
     * ── 为什么它是"第三块"而不是"又一个面板位" ──────────────────────────
     * 轨道（同一侧由外到内）：
     *   [侧栏区 sideColumn] → [rail] → [面板 panel] → **[网页侧栏 webSidebar]** → [网页]
     * 它与面板槽**毫无关系**：不进面板目录、不参与 `reconcilePanels` 对账、有自己的宽度与
     * 持久化。用户要的是"独立的一个侧栏系统，且与面板**可以共存**"——共存这件事只有把
     * 它做成独立区域才成立（挤进 `_panelSlots` 就变成"一个位只能装一个"）。
     *
     * `position` 是**它自己的位置偏好**（设置项 `app.web_sidebar_position`）：
     * `'auto'`（默认）= 落在工具区（rail + 面板）**所在的那一侧**（跟随）；也可显式钉左/右。
     * "跟随"是默认：侧栏是从工具区点出来的（rail 上的固定书签、贴底的「放进侧栏」…），
     * 从哪边点开就该在哪边出来。要"错开一侧"就显式钉左/右或拖顶条。
     * @type {{ visible: boolean, width: number, position: 'auto'|'left'|'right' }}
     */
    this._webSidebar = {
      visible: false,
      width: Math.max(0, Math.round(Number(options.webSidebarWidth) || 400)),
      position: DEFAULT_WEB_SIDEBAR_POSITION
    }
    /**
     * 侧栏**侧别变化**的观察者（装配期由 apps 注入一次）。
     *
     * 为什么需要它：侧别同时是"布局事实"（本类算 x）与"顶条要呈现的事实"
     * （顶条按 side 切 `is-left/is-right` 类、把宽度把手贴到内缘）。布局改了却不告诉
     * 顶条，用户就会看到"设置里换了边，侧栏挪过去了、顶条那道把手还在原来那条边"。
     * 用回调端口而不是让本类去认识顶条/事件通道 —— infra 不认识 apps 的东西。
     * @type {(() => void)|null}
     */
    this._webSidebarSideListener = null
    /**
     * **侧栏视图端口**（apps 装配期用 `setWebSidebarViewPort` 注入）。
     *
     * 与面板端口同一条理由、同一个形状：布局层只该知道"这块矩形归谁"，而它里面装什么
     * （远程页 / 用什么 preload / 哪个 session）是 apps 层的事。**两套端口刻意分开** ——
     * 合成一个就等于把"面板"和"侧栏"重新焊在一起，那正是这次重写要拆掉的东西。
     * @type {{ ensureView?: () => import('electron').WebContentsView|null, destroy?: () => void }|null}
     */
    this._webSidebarViewPort = null
    /** 端口交回来的视图包 `{ content, header, headerHeight }`；本类只读它。 */
    this._webSidebarParts = null
    /**
     * 侧栏槽**最近一次**的矩形（收起时为 null）。
     *
     * 用途：**聚焦框的外框**就是它 —— 框的线朝**内**画，于是整条线都落在槽里，
     * 不会越过槽去撞隔壁的原生视图（panel / 底栏都盖在 chrome DOM 之上，
     * 框一旦外溢就被它们吃掉一角，表现为"靠 rail/panel 一侧与底部的框线被裁"）。
     */
    this._lastWebSidebarRect = null
    /**
     * 内容四周的**呼吸空**（槽 → 内容块的内缩量）。三处要用：
     *   · 算内容块与网页矩形；
     *   · 顶条视图原点的换算（拖顶条换边的中线判据）；
     *   · 框的圆角 —— 要与网页圆角**同心**，得把这段内缩加回去。
     */
    this._webSidebarInsets = { left: 0, top: 0, right: 0, bottom: 0 }
    /**
     * 侧栏**调宽把手**的矩形（窗口内容区坐标）。
     *
     * 为什么是**存下来**而不是每次现算：它要"侧栏槽"与"网页"**同一趟布局**的两个矩形，
     * 而这两个字段在同一趟里是**先后**写上的（侧栏先落位，页码范围在后面）。现算就会拿到
     * 一个旧一个旧/一新一旧的组合 —— 那正是"把手跑到侧栏中间、被网页盖住"的成因。
     * 所以与 `_webSidebarSlotBySide` 同一条口径：**在主进程算好、留一份**。
     */
    this._webSidebarHandleRect = null
    /**
     * **活动面**：侧栏内容页是否是"用户此刻在操作的那一块网页面"。
     *
     * ⚠ 这是**显式状态**，不是 `webContents.isFocused()` 的派生 —— 查找栏是**自持焦浮层**
     * （打开时把 chrome 与侧栏都 blur 掉），用 isFocused 判会把"在侧栏按 Ctrl+F"
     * 算回隔壁标签（这正是 S10 要钉死的 bug）。与分屏的活动格（`split.activeTabId`）同构：
     * 只挂 `focus`（用户点了侧栏网页 → 置 true），**刻意不挂 `blur`**；
     * 点标签网页 / `showTab` 切标签 / 侧栏收起时显式收回。
     * @type {boolean}
     */
    this._webSidebarActive = false
    /**
     * 拖动顶条换边时的**落位侧**（`'left' | 'right' | null`）。
     *
     * ⚠ 拖动途中**不改布局**：换边会让顶条视图当场挪到另一侧，"指针在顶条视图内的坐标"
     * 随即失去参照，中线判据来回翻转 —— 表现为侧栏在两跳之间抖。
     * 预览交给**原生浮层**画（chrome DOM 会被网页盖住），松手才真的换边。
     * @type {'left'|'right'|null}
     */
    this._webSidebarDropPreview = null
    /**
     * 两侧各自的**侧栏槽矩形**（`applyInitialLayout` 每次重排时刷新）。
     *
     * 存在的理由只有一个：拖动换边的**落位预览**要画在"松手后它真会去的地方"。
     * 复刻一遍轨道算术必然漂移（rail / 面板各占多宽都在那边算），所以直接留两份 ——
     * **预览与落点是同一个矩形**，所见即所得由结构保证。
     * @type {{left: object, right: object}|null}
     */
    this._webSidebarSlotBySide = null
    /** 装配层注入的落位预览端口（`(rect|null) => void`）—— 本类不认识那个浮层是谁。 */
    this._webSidebarDropPreviewPort = null
    /** 已挂过"点标签即收回活动面"监听的标签视图（WeakSet 幂等；视图会不断新建销毁）。 */
    this._tabFocusHooked = new WeakSet()
    this._activeTabId = null
    this._tabBounds = null
    this._tabBoundView = null
    this._tabIsFullscreen = false
    // ── 图层管理器（对齐 RT LayerManager：z 序 / 焦点 / 模态的唯一真相源）────
    // 所有 contentView 级子视图（标签容器 / 面板 / rail / 各浮层 / 密码浮层）
    // 都是 Layer：push 时挂载一次，之后显隐只切 setVisible；z 序变更走前缀优化增量重排。
    // 注：chrome（窗口本体）不是 Layer —— 它天然位于所有子视图之下，不参与图层体系。
    // 但它是**合法的焦点持有者**：注入探针让 LayerManager 知道外壳是否持焦，
    // 否则图层显隐 / 惰性建浮层视图 / 切标签都会被误判成"无人持焦"而把焦点抢给网页
    // （地址栏刚聚焦就被顶掉）。
    this._layers = new LayerManager(this._contentView(), {
      isShellFocused: () => this._isViewFocused(this._uiShellView),
      /**
       * 「本应用的**另一个**窗口正持焦」—— 焦点再分配的前置闸口。
       *
       * 典型场景就是查找栏：它是挂在浏览器窗口下的**独立窗口**（对齐 Hira / RT），
       * 被激活时浏览器窗口本身就是失活的。此时若因为"某个浮层收起 / 切标签"触发一次
       * 焦点再分配，就会给本窗口里的网页 `focus()` → **把浏览器窗口重新激活、
       * 顺手把查找栏的键盘焦点抢回来**（用户看到的正是"焦点又没了"）。
       *
       * 用 `getFocusedWindow()` 而不是 `win.isFocused()`：启动期还没有任何窗口持焦
       * （返回 null）时不能拦住正常的首次聚焦；而"用户在别的应用里"同样返回 null，
       * 行为与改造前一致 —— 只有"我们自己的另一个窗口正持焦"这一种情况被挡下。
       */
      isForeignWindowFocused: () => {
        try {
          const { BrowserWindow } = require('electron')
          const focused = typeof BrowserWindow.getFocusedWindow === 'function' ? BrowserWindow.getFocusedWindow() : null
          if (!focused || focused.isDestroyed()) return false
          return focused !== this._win
        } catch (_) {
          return false
        }
      }
    })
    /** @type {NodeJS.Timeout[]} 外壳聚焦补偿定时器（重新请求时清空） */
    this._shellFocusRetries = []
    /** @type {NodeJS.Timeout[]} 浮层聚焦补偿定时器（重新请求时清空，dispose 兜底清） */
    this._floatFocusRetries = []
    /** @type {NodeJS.Timeout[]} 面板聚焦补偿定时器（同款；见 `focusPanel`） */
    this._panelFocusRetries = []
    /** @type {NodeJS.Timeout[]} 「焦点还给原主」补偿定时器（dispose 兜底清） */
    this._restoreFocusRetries = []
    // ── 内容面焦点记忆（窗口失活再激活 / 点外壳空白处之后把焦点送回网页）──────
    // 为什么需要：外壳是窗口本体，和网页（WebContentsView）**争同一个原生键盘焦点**。
    // 点一下外壳 = 焦点被外壳拿走，而 LayerManager 在外壳持焦时**永不回让**；
    // 窗口失活再激活时 Chromium 也不会替我们把焦点送回刚才那张网页。两条路都必须有
    // 一个"刚才用户在哪个视图里打字"的记忆，见 ContentFocusMemory.js 的文件头。
    this._focusMemory = new ContentFocusMemory<WebContents>()
    /**
     * 「会抢走原生焦点、但压根不需要键盘」的外观面（rail 图标条这类）。
     *
     * 它们也是 WebContentsView：用户点一下就拿到键盘焦点，可里面没有一个输入框 ——
     * 于是网页里刚才在打字的输入框看起来还在，键盘却进了这条图标条（用户报的
     * "点无关界面就失焦"里，标签栏之外的另一半）。登记在这里 = 拿到焦点立刻原路送回，
     * 同时回焦链**不再**把它当成"用户主动选择的焦点"而放弃。
     * @type {Set<Electron.WebContents>}
     */
    this._chromeFocusViews = new Set()
    /**
     * 内容面 kind → 可用性守卫。守卫回答「这一面此刻还值得回焦吗」——
     * 那是布局知识（面板是否还开着、标签是否还在屏幕上），不属于纯记忆体。
     * 每个 kind 一条，新增内容面只需 `registerContentSurfaceKind`，不动回焦逻辑本身。
     * @type {Map<string, (entry: {wc: import('electron').WebContents, kind: string, key: string|null}) => boolean>}
     */
    this._contentSurfaceGuards = new Map()
    /**
     * 外壳此刻是否持有一个**可编辑**焦点（地址栏 / 搜索框）。
     *
     * 它是「窗口回到前台时该不该把焦点抢回网页」的唯一判据：用户正在地址栏里打字、
     * 切出去再切回来，必须原样留在地址栏 —— 少了这条，每次切回窗口都会被我们自己
     * 拽回网页（这正是"自动聚焦地址栏"那条既有修复的反向事故）。
     */
    this._shellEditableFocused = false
    /**
     * `_shellEditableFocused` 变 true 的时刻（0 = 当前没有保鲜中的打字意图）。
     * 与布尔值配对使用，见 `SHELL_EDIT_INTENT_TTL_MS`：残留的 true 不配拥有否决权。
     */
    this._shellEditableAt = 0
    /** @type {NodeJS.Timeout[]} 内容面回焦补偿定时器（重新请求时清空、dispose 兜底清） */
    this._contentFocusRetries = []
    /**
     * ── 「外壳抢到焦点就送回去」────────────────────────────────────────────
     * 见 `SHELL_BOUNCE_GRACE_MS` 的说明：窗口激活时 Chromium 会把 native focus
     * 重放给外壳（窗口本体），时刻不可预知，只能靠事件接。
     *
     * 三者合起来是一个**有界**的自我修正：只在窗口刚激活的窗口期内生效、最多 N 拍、
     * 判定前先等一帧看 `_shellEditableFocused`。窗口期之外 / 外壳要打字时一律不动。
     */
    this._shellBounceUntil = 0
    this._shellBounceCount = 0
    this._shellBounceTimer = null
    this._shellFocusListener = null
    /** @type {NodeJS.Timeout|null} 窗口激活窗口期内的焦点看门狗（见 SHELL_FOCUS_WATCHDOG_MS） */
    this._shellFocusWatchdog = null
    /** 看门狗的截止时刻（毫秒时间戳；0 = 未运行） */
    this._shellWatchdogDeadline = 0
    /** 上次真正调用 `win.focus()` 的时刻（见 WIN_FOCUS_THROTTLE_MS，防窗口闪烁 / 抢前台） */
    this._lastWinFocusAt = 0
    this._installDefaultContentSurfaceGuards()
    this._installShellFocusBounce()
    /** 内容尺寸为 0 时的布局重排重试计数 / 在途定时器（上限 LAYOUT_RETRY_MAX 拍） */
    this._layoutRetryCount = 0
    this._layoutRetryTimer = null
    /**
     * 「用户请求显示某浮层那一刻」持焦的 webContents（浮层名 → webContents）。
     * 浮层 renderer 加载完成时会「原生」抢走键盘焦点，而归还目标必须是**那一刻**的
     * 持有者 —— 到 setFloatBounds 再取就晚了（那时可能已被别的东西改掉）。
     * @type {Map<string, Electron.WebContents>}
     */
    this._floatFocusHolders = new Map()
    /**
     * 「正在播退场动效、bounds 尚未收」的浮层（浮层名 → true）。
     * 需要动效收起的浮层（标签预览）不能一收到 hide 就把 bounds 收成 0 —— view 瞬间
     * 缩没，renderer 根本没机会画退场动画。改为：hide 时保留 bounds，等 renderer 播完
     * 回执（finishFloatHide）再收；期间来了新的 show 就整体作废（注：仍带兜底超时，
     * renderer 崩了/没加载完也不会留下"僵尸浮层"）。
     * @type {Map<string, boolean>}
     */
    this._floatExitPending = new Map()
    /** @type {Map<string, NodeJS.Timeout>} 退场兜底定时器（renderer 不回执时兜底收起） */
    this._floatExitTimers = new Map()
    /** @type {Map<string, Layer>} 逻辑名 → 图层（面板/浮层按 id 唯一化） */
    this._chromeLayers = new Map()
    // ── Tab 图层容器（对齐 RT LayerManager 的挂载模型）────────────────────
    // 所有标签 WebContentsView 都是这个空容器的子 view：**只挂载一次**，
    // 之后切标签只切 `setVisible()`，绝不 removeChildView/addChildView。
    //
    // 为什么必须这样：对 WebContentsView 做 remove/removeChildView 会拆掉原生
    // 视图宿主（NativeViewHost），WebContents 收到 WasHidden，重挂时再 WasShown
    // —— 合成器被销毁重建、整页重排重绘。重页面（B 站/YouTube）单次切换就要几百 ms，
    // 表现为「切标签/点击/跳转卡顿 + 窗口冻结 + 网页加载慢」。
    this._tabLayer = null
    /** @type {TabHostLayer|null} 标签容器图层（焦点代理到当前可见标签） */
    this._tabHostLayer = null
    /** @type {Set<object>} 已挂到 tabLayer 的标签视图（幂等挂载用） */
    this._tabLayerChildren = new Set()
    /** 当前可见的标签视图（切走时 setVisible(false)） */
    this._visibleTabView = null
    /**
     * **当前可见的标签集合**（分屏时 >1）。
     *
     * 为什么要有集合而不是只有一个 `_visibleTabView`：分屏把"一屏一页"变成"一屏 N 格"，
     * 而"把上一个可见的收起来"这件事必须按**集合差**做 —— 只记一个的话，从 2 格分屏
     * 切到普通标签时，第二格的 view 永远不会被 setVisible(false)，它会**继续盖在网页上**。
     */
    this._visibleTabIds = new Set()
    /**
     * 当前活动的分屏组（null = 不在分屏里）。
     *
     * 形状 `{ splitId, members: string[], layout, ratios, activeTabId }`。
     * **由 TabManager（标签的 owner）灌进来**，本类不查库、不认识 domain —— 它只回答
     * "这块矩形该怎么切"。这样分屏规则与布局几何彻底解耦（见 TabSplits.js 文件头）。
     */
    this._activeSplit = null
    /** 最近一次分屏求解结果（活动格判定 / 浮层锚定要用；非分屏时为 null）。 */
    this._lastSplitSolved = null
    /**
     * 最近一次**推给外壳**的分屏几何签名（见 `_pushSplitGeometry` 的去重）。
     *
     * 为什么需要：那条推送挂在 `showTab` 末尾，**每次切标签**都会走一遍；而绝大多数
     * 窗口根本没有分屏。不记签名就是每次切标签白发一条 `split:changed`。
     */
    this._lastSplitGeometryKey = ''
    /**
     * 最近一次**推给外壳**的侧栏聚焦框几何签名（见 `_pushWebSidebarFrame` 的去重）。
     *
     * 与 `_lastSplitGeometryKey` 同一条规矩：那条推送挂在布局末尾，窗口 resize 的
     * 每一帧、面板开关、切侧栏都会经过它，而框的几何多数时候一个字都没变。
     * 键里带 `wc.id` —— 外壳视图被重建（重新加载）时同一份几何也要重新下发。
     */
    this._lastWebSidebarFrameKey = ''
    /**
     * 当前活动的速览组（null = 不在速览里）。A1。
     *
     * 形状 `{ glanceId, members:[back,front], frontTabId, activeTabId }`。
     * 与 `_activeSplit` **互斥**（TabManager 在 `_syncActiveSplit` 里保证同刻至多一个非空）。
     * 同样由 TabManager 灌进来，本类只回答"这两张卡各自该落哪块矩形、谁在上面"。
     */
    this._activeGlance = null
    /** 最近一次速览求解结果（`{back,front}` 两矩形；非速览时为 null）。 */
    this._lastGlanceSolved = null
    /**
     * 最近一次**推给外壳**的速览外环阴影几何（`{ back, radius }`；不在速览时为 null）。
     * 只用来去重：全量布局会被窗口 resize / 面板开关频繁触发，而阴影多数时候没变 ——
     * 不记这一笔就要每趟多发一次 IPC + 让外壳白重画一遍 DOM。
     */
    this._lastGlanceGeometry = null
    /**
     * 速览两张卡之间的装饰（投影 + 蓝框），注入 **back 卡那一页**。
     * 懒建一次；`_lastGlanceDeckKey` 是它的注入键（换卡 / 圆角 / 明暗变才重注）。
     */
    this._glanceDeck = null
    // 各 view 的上一次 bounds（WeakMap 按 view 隔离：不同 view 共用一个缓存槽会互相跳过 setBounds）
    this._lastBounds = new WeakMap()
    /**
     * 各 view 的上一次**圆角**（同上按 view 隔离）。只做"值没变就别写"的去重 ——
     * 重复 `setBorderRadius` 会让那层视图重做一遍圆角遮罩（见 _setRadiusIfChanged）。
     *
     * ⚠ 这份账本只回答"我上次写了多少"，**不回答"那片表面上还有没有半径"**：
     *   合成表面一被重建（视图重新挂载 / 重新点亮），半径遮罩就没了而账本还记着老值。
     *   所以凡是会重建表面的位置都要显式 `_invalidateRadius(view)` —— 收口在两个原生调用点，
     *   其余布局分支（单视图 / 分屏 / 速览）一律只管 `_setRadiusIfChanged`，不必各写一套。
     */
    this._lastRadius = new WeakMap()
    /**
     * 已经绑过「表面重建 ⇒ 重写圆角」监听的 view（幂等标记，见 `_watchRadiusSurface`）。
     */
    this._radiusWatchers = new WeakSet()
    this._lastPageBounds = null
    // ── 标签 bounds 的缓动动画（时长 + 曲线，对齐 RT SidebarInterpolation）──────
    // 彻底解耦：只注入「把整数 rect 应用到当前活动标签」与「能否动画」两个回调，
    // 本模块不持有 view —— sleep/wake 重建、切标签换 view 都不影响动画内部状态。
    //
    // 为什么必须有它：切侧栏 / 切全屏是**结构性跳变**，直接 setBounds 是硬切；
    // 缓动让页面区域平滑滑入（180ms，与 --ng-anim-base 同一口径）。
    //
    // ── 谁走缓动、谁不走（唯一口径）──────────────────────────────────────
    //   · 走：**面板打开 / 关闭**（含就绪交接）—— 面板占住的那块宽度是被"推开 / 收回"的，
    //     网页跟着平滑让位；这是面板开合的观感本体，不是可选项。
    //   · 不走：**同侧换面板（切换）** —— 槽位宽度全程不变 ⇒ 网页 bounds 相同 ⇒
    //     补间天然空转，切换因此没有任何宽度动画（这是刻意要的"切换零动画"）。
    //   · 不走：窗口 resize / 面板拖拽 —— 逐帧跟手的高频量，补间只会落后于光标。
    this._tabTween = new BoundsTween({
      applyBounds: (rect) => this._applyTabBounds(rect),
      canAnimate: () => Boolean(this._activeTabId) && !this._win.isDestroyed()
    })
    installWebSidebarController(this as unknown as SidebarHostContract)
    installPanelLayoutController(this as unknown as PanelHostContract)
  }

  /**
   * 释放本协调器持有的**常驻资源**（窗口销毁时调用一次）。
   *
   * 为什么必须有它：本类持有三条主进程轮询定时器（贴边唤出 / 侧栏悬停唤出 / 指针避让）
   * 与一个窗口 `resize` 监听。它们原本各自「靠回调里的 isDestroyed 自愈」——逻辑上能清，
   * 但那是**靠时序**：任一条早退分支没走到自检（例如侧栏唤出巡看在
   * 指针恰好出窗的同一帧提前 return），定时器就会一直持有整个协调器
   * （连同 `_floatViews` 里的全部视图引用）。窗口都没了还挂着一个释放不掉的对象，
   * 是「最小内存」最不该有的形态。这里一次性收干净，不依赖任何后续回调。
   */
  dispose() {
    this._stopPointerAvoidTimer()
    this._stopSideRevealWatch()
    this._stopRailRevealWatch()
    // 浮层闲置回收定时器：窗口都没了，这些定时器只会保留住 `_floatViews` 里的视图引用
    // （正是 dispose 要消灭的那类东西）。全部清掉。
    for (const timer of this._floatReclaimTimers.values()) {
      try { clearTimeout(timer) } catch (_) {}
    }
    this._floatReclaimTimers.clear()
    this._pendingPanelPlace.clear()
    // 密码浮层的闲置回收定时器：同款理由（窗口都没了，留着只会吊住那份视图引用）。
    this._cancelPasswordReclaim()
    if (this._immersiveWatch) {
      clearInterval(this._immersiveWatch)
      this._immersiveWatch = null
    }
    this._chromeDragSuppressedListener = null
    if (this._onWinResize) {
      try { this._win.removeListener('resize', this._onWinResize) } catch (_) {}
      this._onWinResize = null
    }
    this._resizeBound = false
    if (this._onWinActivity) {
      const winEvents = this._win as unknown as WindowEventPort
      for (const evt of WIN_ACTIVITY_EVENTS) {
        try { winEvents.removeListener(evt, this._onWinActivity) } catch (_) {}
      }
      this._onWinActivity = null
    }
    this._winActivityBound = false
    this._pointerAvoid.clearAll()
    // 三条焦点补偿链 + 布局重试定时器：窗口都没了，留着只会各跑最多 1.25s 空拍、
    // 并把协调器钉在定时器回调的闭包上。登记就是为了这一刻能整串清掉。
    this._clearShellFocusRetries()
    this._clearFloatFocusRetries()
    this._clearPanelFocusRetries()
    this._clearRestoreFocusRetries()
    // 送焦订阅 + 宽容窗定时器：订阅挂在窗口本体 webContents 上，不清掉就是跨窗口生命周期的泄漏。
    this._removeShellFocusBounce()
    this.endShellFocusBounce()
    // 回内容面的补偿链 + 焦点记忆 / 守卫表：窗口都没了，两者都只可能在尸体上跑空拍。
    this._clearContentFocusRetries()
    this._focusMemory.clear()
    this._contentSurfaceGuards.clear()
    this._chromeFocusViews.clear()
    if (this._layoutRetryTimer) {
      try { clearTimeout(this._layoutRetryTimer) } catch (_) {}
      this._layoutRetryTimer = null
    }
    if (this._tabTween && typeof this._tabTween.stop === 'function') {
      try { this._tabTween.stop() } catch (_) {}
    }
    /**
     * ★ 剩下那些**登记表**同样必须清 —— 它们每一项都是一个 `Map<string, 视图/定时器>`，
     *   留着就等于把整份对象图（含已销毁窗口的原生视图引用）钉在这个协调器上。
     *   窗口都没了，它们不可能再被读，清掉是纯收益。
     *
     * 为什么原先漏了：`dispose` 当时只盯着"三条轮询 + resize 监听"这几样**会自己跑**的
     * 东西（漏掉定时器会持续占 CPU），而登记表是"不跑但占内存"——就把它们忘了。
     * 两者在"最小内存"这个目标下是同等的。
     */
    for (const timer of this._floatExitTimers.values()) {
      try { clearTimeout(timer) } catch (_) {}
    }
    this._floatExitTimers.clear()
    this._floatFocusHolders.clear()
    this._unbindFloatDismissSources()
    this._floatDismissOutside.clear()
    this._floatDismissListener = null
    this._floatBounds.clear()
    this._floatThrottled.clear()
    this._floatInteractive.clear()
    this._stopFloatHoverProbe()
    this._floatVisible.clear()
    this._floatSeq.clear()
    this._floatOpener.clear()
    this._floatViews.clear()
    this._floatExitPending.clear()
    this._chromeLayers.clear()
    this._tabLayerChildren.clear()
    this._visibleTabIds.clear()
    // 图层宿主：把登记的图层全部摘掉（含从窗口 contentView 摘视图）。
    // 它是唯一持有"视图→图层"映射的地方，不清就留着一整棵视图树。
    try { this._layers.destroy() } catch (_) {}
  }

  /** 取 contentView，统一子 view 管理入口 */
  _contentView() {
    return this._win.contentView
  }

  /** 比较两个 bounds 是否相同 */
  static _boundsEqual(a: Rectangle | null | undefined, b: Rectangle | null | undefined) {
    if (!a || !b) return false
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  }

  /**
   * 系统要求减少动态效果 / 当前会话不适合重动画时，原生 bounds 直接落位。
   * 这比"动画播得更短"更稳定：尤其远程桌面和高负载机器上，逐帧改
   * WebContentsView bounds 会让整页交换链反复重建。
   */
  static _prefersReducedNativeMotion(): boolean {
    try {
      const settings = systemPreferences.getAnimationSettings()
      return settings.prefersReducedMotion || settings.shouldRenderRichAnimation === false
    } catch (_) {
      return false
    }
  }

  /** 安全设置 view bounds：bounds 未变化时跳过，避免触发不必要重绘 */
  _setBoundsIfChanged(view: View, next: Rectangle) {
    if (!view) return
    const prev = this._lastBounds.get(view)
    if (prev && LayoutCoordinator._boundsEqual(prev, next)) return
    this._lastBounds.set(view, next)
    try { view.setBounds(next) } catch (_) {}
  }

  /**
   * 网页是否处于**贴边模式**：真实窗口全屏（F11 / HTML5 全屏）。
   *
   * 与沉浸模式的区别：沉浸只是让 chrome 走开，网页仍保留主题的呼吸空与圆角
   * （「全屏的展开规则与沉浸一致」说的是显隐流程，不是表面形态）；而全屏是内容独占
   * 整窗，四边内缩与圆角都必须归零，否则屏幕上就是一圈底色缝 + 四个圆角缺口。
   *
   * 判据只此一处：布局的内缩（pad*）与表面圆角都吃它 —— 两边各写一份必然漂移。
   */
  _isEdgeToEdge() {
    if (this._tabIsFullscreen) return true
    return !!(this._win && !this._win.isDestroyed() && this._win.isFullScreen())
  }

  /** 网页表面圆角：贴边模式归零，其余取主题圆角。 */
  _pageRadius() {
    return this._isEdgeToEdge() ? 0 : this._tabBorderRadius
  }

  /**
   * 只有圆角真的变了才写。**值没变也调一次 `setBorderRadius` 会闪。**
   *
   * 这个调用在原生侧要**重做这层视图的圆角遮罩**（不是个普通属性）：每趟布局都无脑调，
   * 等于让屏上所有网页视图各重做一遍遮罩 —— 而全量布局会被悬停/开关面板/窗口缩放
   * 频繁触发，表现就是"什么都没变，画面却抖一下"。
   * 圆角在稳定态是常量（主题圆角；全屏贴边时为 0），所以现实里只有**圆角真正变化
   * 的那一趟**（进/出全屏、改主题）与**视图刚建出来**（WeakMap 里没有记录）会真正写入。
   * @param {import('electron').WebContentsView} view
   * @param {number} [radius] 缺省为主题圆角；网页表面传 `_pageRadius()`（全屏归零）。
   */
  _setRadiusIfChanged(view: WebContentsView, radius: number = this._tabBorderRadius) {
    if (!view || typeof view.setBorderRadius !== 'function') return
    // 顺手挂上「表面重建就重写」的监听（幂等）—— 见 _watchRadiusSurface。
    this._watchRadiusSurface(view)
    if (this._lastRadius.get(view) === radius) return
    this._lastRadius.set(view, radius)
    try { view.setBorderRadius(radius) } catch (_) {}
  }

  /**
   * 给某个 view 挂上「合成表面可能被重建 ⇒ 重写一遍圆角」的监听（每个 view 只挂一次）。
   *
   * 为什么需要：`setBorderRadius` 造出的圆角遮罩挂在该视图的**合成表面**上，而表面会被
   * 两类事件重建 —— 一是这里登记的三处原生调用（挂载 / 点亮 / 提层，已各自 `_invalidateRadius`），
   * 二是**页面自身的导航**（跨进程换渲染器时整片表面重建，这个时机 LayoutCoordinator 收不到
   * 任何布局调用）。后者就是用户看到的"圆角拉大以后，有时候网页四角又变回白色方块"：
   * 遮罩没了、账本还记着老值，下一次布局的去重直接把重写跳过去。
   *
   * 做法：在 webContents 的导航/加载/崩溃事件上补一次写入（下一拍再补一次，覆盖"提交后
   * 表面才重建"的时序）。账本不做任何改动 —— 写的仍是**这个 view 的既有目标半径**
   * （标签页是 `_pageRadius()` 的结果，面板/速览卡是 `_tabBorderRadius`，账本里存的就是它），
   * 所以不会把全屏归零之类的事情写错。
   * @param {import('electron').WebContentsView} view
   */
  _watchRadiusSurface(view: WebContentsView) {
    if (!view || this._radiusWatchers.has(view)) return
    const wc = view.webContents
    if (!wc || typeof wc.on !== 'function') return
    this._radiusWatchers.add(view)
    const reapply = () => {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return
      if (typeof view.setBorderRadius !== 'function') return
      if (!this._lastRadius.has(view)) return
      const radius = this._lastRadius.get(view)
      if (radius == null) return
      try { view.setBorderRadius(radius) } catch (_) {}
    }
    // 双拍：事件本身在"新文档已提交"时到，跨进程导航的表面重建可能还要晚一帧。
    const handler = () => { reapply(); setImmediate(reapply) }
    const surface = wc as unknown as { on(event: string, listener: () => void): unknown }
    for (const evt of RADIUS_SURFACE_EVENTS) surface.on(evt, handler)
  }

  /**
   * 作废某个视图的「上次已写圆角」记账 ⇒ 下一次 `_setRadiusIfChanged` 必然重写一次。
   *
   * 为什么需要它：`setBorderRadius` 在原生侧**不是普通属性**，它给这层视图造一层圆角遮罩，
   * 而遮罩挂在那片**合成表面**上 —— 视图重新挂载（`addChildView`）或重新点亮
   * （`setVisible(true)`）都会重建表面、连带丢掉遮罩。可账本只记"我上次写了 12"，
   * 于是去重会把该写的那一次跳过去，表现就是"这张卡（或这一格）没有主题圆角"。
   *
   * 取舍：把"表面没了"这件事**只在重建它的三个原生调用点登记一次**
   * （`_attachTabView` / `_raiseTabView` / `_setVisibleTabs`），而不是让每条布局分支
   * 自己判断"这趟要不要 force"—— 后者会把同一条规则抄进单视图 / 分屏 / 速览三处，
   * 早晚漂移。于是所有布局分支都只写一句 `_setRadiusIfChanged(view, this._pageRadius())`。
   * @param {import('electron').WebContentsView} view
   */
  _invalidateRadius(view: WebContentsView) {
    if (view) this._lastRadius.delete(view)
  }

  /**
   * 把整数 bounds 应用到「当前活动标签 view」（由 BoundsTween 每帧回调）。
   * view 解析在此完成 —— 动画模块与 WebContentsView 生命周期（sleep/wake 重建）彻底解耦。
   * @param {{x:number,y:number,width:number,height:number}} rect
   */
  _applyTabBounds(rect: BoundsRect) {
    if (!this._activeTabId || this._win.isDestroyed()) return
    try {
      const view = this._wcm.getTab(this._activeTabId)
      if (view) view.setBounds(rect)
    } catch (_) {}
  }

  /**
   * 懒创建「标签图层容器」：一个空 View，作为所有标签 WebContentsView 的父级，
   * 按最底层挂到 contentView。首次调用后永久复用。
   * @returns {Electron.View|null}
   */
  _ensureTabLayer() : Electron.View|null {
    if (this._tabLayer) return this._tabLayer
    try {
      const { View } = require('electron')
      const container = new View()
      this._tabLayer = container
      // 容器作为「标签容器图层」挂到 contentView 最底层；焦点代理到当前可见标签。
      this._tabHostLayer = new TabHostLayer(
        this._layers,
        container,
        () => this._visibleTabView
      )
      this._layers.push(this._tabHostLayer)
      this._chromeLayers.set('tab-layer', this._tabHostLayer)
      // 让 WebContentsManager 在 destroyTab/sleepTab 时能从该容器摘除子视图
      if (typeof this._wcm.setTabHost === 'function') this._wcm.setTabHost(container)
      // 立刻跑一次全量布局：容器必须铺满窗口。子 view 会被父 view 裁剪，
      // 若容器停留在默认 0x0，整个标签页会不可见。
      this.applyInitialLayout()
    } catch (e) {
        console.error('[layout] create tab layer failed:', errorMessage(e))
      return null
    }
    return this._tabLayer
  }

  /** 把标签视图挂到 tab 图层（幂等：已挂过就是空操作，不做任何重排） */
  _attachTabView(view: WebContentsView) {
    if (!view) return
    const layer = this._ensureTabLayer()
    if (!layer) return
    if (this._tabLayerChildren.has(view)) return
    try { layer.addChildView(view) } catch (_) {}
    this._tabLayerChildren.add(view)
    // 挂载 = 新的合成表面 ⇒ 之前写过的圆角遮罩不在这片表面上，记账作废（见 _invalidateRadius）。
    this._invalidateRadius(view)
    this._hookTabViewFocus(view)
    // 浮层开着时新建的标签同样要是「外部」：补挂侦听（见 _syncFloatDismissSources）。
    if (this._floatDismissBound.size > 0) this._syncFloatDismissSources()
  }

  /**
   * 给标签视图挂「点它即把活动面收回标签」的监听（**只挂一次**）。
   *
   * 为什么靠事件而不是靠"谁调用 showTab"：用户点标签网页这条路**不经过任何 API**
   * （原生视图自己拿焦点），只有 `focus` 事件能观测到。
   * 与侧栏那条对称：侧栏挂 `focus` → 置 true；标签挂 `focus` → 置 false。
   *
   * 幂等用 WeakSet（不是给 view 打属性）：标签视图会不断新建/销毁，
   * WeakSet 随视图被回收，不留任何"幽灵标记"。
   * @param {import('electron').WebContentsView} view
   */
  _hookTabViewFocus(view: WebContentsView) {
    if (!view || this._tabFocusHooked.has(view)) return
    const wc = view.webContents
    if (!wc || typeof wc.on !== 'function') return
    this._tabFocusHooked.add(view)
    try {
      wc.on('focus', () => {
        this._setWebSidebarActive(false)
        // 记住"用户最后在哪个内容面里"—— 窗口失活再激活时靠它把焦点送回来。
        this._rememberContentFocus(wc, 'tab')
      })
      onWebContentsDestroyed(wc, () => { this.forgetContentFocus(wc) })
    } catch (_) {}
  }

  /**
   * 设定「活动面」（见 `_webSidebarActive` 的说明）。
   *
   * 变化时**只推一次聚焦框几何**（不重排 bounds）—— 恒定 gap 的设计让"换活动面"
   * 这件事没有布局代价。
   * @param {boolean} active
   */
  _setWebSidebarActive(active: boolean) {
    const next = !!active
    if (next === this._webSidebarActive) return
    this._webSidebarActive = next
    this._pushWebSidebarFrame()
  }

  _clearShellFocusRetries() {
    for (const t of this._shellFocusRetries) clearTimeout(t)
    this._shellFocusRetries.length = 0
  }

  _clearFloatFocusRetries() {
    for (const t of this._floatFocusRetries) clearTimeout(t)
    this._floatFocusRetries.length = 0
  }

  _clearPanelFocusRetries() {
    for (const t of this._panelFocusRetries) clearTimeout(t)
    this._panelFocusRetries.length = 0
  }

  _clearRestoreFocusRetries() {
    for (const t of this._restoreFocusRetries) clearTimeout(t)
    this._restoreFocusRetries.length = 0
  }

  _clearContentFocusRetries() {
    for (const t of this._contentFocusRetries) clearTimeout(t)
    this._contentFocusRetries.length = 0
  }

  /**
   * 排一串「分几拍重申」的定时器，并让**数组长度恒等于「还在跑的拍次」**。
   *
   * 每拍触发时先把自己从数组里摘掉 —— 这是不变式，不是优化：
   * `_contentFocusBlocked()` 的闸口④ 正是拿这几个数组非空来判断「外壳 / 浮层 /
   * 面板要焦点的链正在跑」。早先只 push 不摘，链条跑完后数组永久非空 → 闸口④ 从此
   * 永远为真 → **所有回焦全部空转**（用户实测：Alt+Tab 切回来键盘焦点一个都没有，
   * 必须手动点网页）。
   *
   * @param {Array<ReturnType<typeof setTimeout>>} list 该链的定时器数组（`_clearXxxRetries` 共用同一份）
   * @param {() => void} attempt 一拍的回调
   * @param {number[]} msList 每拍的延迟
   */
  _armFocusRetries(list: Timer[], attempt: () => void, msList: number[]) {
    for (const ms of msList) {
      const timer = setTimeout(() => {
        const i = list.indexOf(timer)
        if (i >= 0) list.splice(i, 1)
        // 与看门狗同理：定时器回调里的异常会直达主进程 uncaughtException，
        // 直接崩掉应用。任一拍失败只该损失这一拍，不该损失整个进程。
        try { attempt() } catch (_) {}
      }, ms)
      list.push(timer)
    }
  }

  // ── 内容面焦点记忆 / 回焦 ────────────────────────────────────────────────
  // 这一组方法的共同背景：外壳（窗口本体 webContents）与每个内容面（标签 / 独立侧栏 /
  // 面板）都是**同一个窗口里互斥**的键盘焦点持有者。所有"焦点该在谁身上"的判断集中在
  // 这里，别处只上报事实（谁拿到了焦点、外壳是否在输入框里），不各自猜。

  /**
   * 注册内置的三类内容面守卫。
   *
   * 为什么守卫是必需的：记忆体里可能留着**已经不该回焦**的视图 —— 面板已被关闭
   * （关闭即销毁，见文件写 "面板关闭即卸载" 那段）、标签已被隐藏（别的标签上屏）、
   * 侧栏已收起。给这些视图 `focus()` 轻则无效果，重则把焦点交给一块看不见的网页
   * （用户看到的是"键盘又没反应了"）。
   */
  _installDefaultContentSurfaceGuards() {
    /** 标签：必须此刻在屏幕上（分屏/速览下非活动的那一格同样算）。 */
    this.registerContentSurfaceKind('tab', (entry) => {
      const wc = entry.wc
      const same = (id: string) => {
        const view = this._wcm && typeof this._wcm.getTab === 'function' ? this._wcm.getTab(id) : null
        return !!(view && view.webContents === wc)
      }
      for (const id of this._visibleTabIds) {
        if (same(id)) return true
      }
      return !!(this._activeTabId && same(this._activeTabId))
    })
    /** 独立侧栏：收起后（不占位）就不要再回焦它。 */
    this.registerContentSurfaceKind('sidebar', (entry) => {
      const parts = this._webSidebarParts
      if (!parts || !parts.content || parts.content.webContents !== entry.wc) return false
      return !!(this._webSidebar && this._webSidebar.visible)
    })
    /** 面板：还占着某一侧才算可用（关掉即销毁 → 回落到标签）。 */
    this.registerContentSurfaceKind('panel', (entry) => {
      const key = entry.key
      if (!key) return false
      const parts = this._panelParts.get(key) || null
      const wc = parts && parts.content && parts.content.webContents
        ? parts.content.webContents
        : null
      if (wc !== entry.wc) return false
      let side = null
      try { side = this.getPanelSideOf(key) } catch (_) { side = null }
      return !!side
    })
  }

  /**
   * 注册（或覆盖）一类内容面的可用性守卫 —— **未来新增内容面的唯一扩展点**。
   *
   * 新增一类内容面（如未来的浮窗网页 / 侧边笔记）只需两步：
   *   ① 该视图拿到焦点时调 `_rememberContentFocus(wc, '新kind', key)`；
   *   ② 这里注册一个「它此刻还在屏幕上吗」的判据。
   * 回焦流程（`restoreContentFocus`）本身一个字都不用改。
   *
   * @param {string} kind
   * @param {(entry: {wc: import('electron').WebContents, kind: string, key: string|null}) => boolean} isAvailable
   * @returns {() => void} 注销函数（重复注册同 kind 会被覆盖；注销只摘自己那次）
   */
  registerContentSurfaceKind(kind: string, isAvailable: (entry: ContentFocusEntry<WebContents>) => boolean) : () => void {
    const key = String(kind || '').trim()
    if (!key) return () => {}
    const guard = typeof isAvailable === 'function' ? isAvailable : () => true
    this._contentSurfaceGuards.set(key, guard)
    return () => {
      if (this._contentSurfaceGuards.get(key) === guard) this._contentSurfaceGuards.delete(key)
    }
  }

  /**
   * 登记一个「拿得走原生焦点、却不需要键盘」的外观面（rail 一类图标条）。
   *
   * 它和 `registerContentSurfaceKind` 是一对反向概念：
   *   · 内容面 = 可能要键盘 → 记下来当回焦目标；
   *   · 外观面 = 不要键盘 → 抢到焦点就原路送回内容面。
   * 未来新增哪条图标条 / 工具条，只要在创建视图后调这一个方法，焦点语义自动一致。
   *
   * @param {import('electron').WebContents} wc
   * @returns {() => void} 注销函数
   */
  registerChromeFocusSink(wc: WebContents) : () => void {
    if (!wc || this._chromeFocusViews.has(wc)) return () => {}
    this._chromeFocusViews.add(wc)
    const onFocus = () => {
      // 记忆为空 = 还没有任何内容面被用户用过（启动期 / 全新窗口）：
      // 这时多半是视图加载自己抢了一次焦点，不插手，留给外壳的地址栏聚焦链。
      if (this._focusMemory.list().length === 0) return
      // 焦点既然已经不在外壳上，"外壳正在某个输入框里"的判据就过期了 ——
      // 不清掉的话闸口② 会把这条回焦永久拦下（用户先点地址栏再点图标条就会踩到）。
      this._shellEditableFocused = false
      this.restoreContentFocus({ reason: 'chrome-focus-sink', immediate: true, retries: false })
    }
    try { wc.on('focus', onFocus) } catch (_) {}
    try { onWebContentsDestroyed(wc, () => { this._chromeFocusViews.delete(wc) }) } catch (_) {}
    return () => {
      this._chromeFocusViews.delete(wc)
      try { wc.removeListener('focus', onFocus) } catch (_) {}
    }
  }

  /** 某条记忆此刻是否值得回焦（未注册守卫的 kind 视为可用：它自己登记过自己）。 */
  _isContentSurfaceAvailable(entry: ContentFocusEntry<WebContents>) {
    if (!entry) return false
    const guard = this._contentSurfaceGuards.get(entry.kind)
    if (!guard) return true
    try { return !!guard(entry) } catch (_) { return false }
  }

  /**
   * 记下「这个内容面刚拿到焦点」。所有内容面的 `focus` 事件都汇到这里 ——
   * 这样回焦目标始终等于"用户最后真正在用的那一面"，不需要任何调用方自己维护。
   * @param {import('electron').WebContents} wc
   * @param {string} kind
   * @param {string|null} [key]
   */
  _rememberContentFocus(wc: WebContents, kind: string, key: string | null = null) {
    if (!wc) return
    this._focusMemory.remember(wc, kind, key)
    // 内容面拿到焦点 ⇒ 外壳不再持有键盘焦点（含"刚才在地址栏里"那件事）。
    // 这条是 `_shellEditableFocused` 的唯一自然失效路径：用户在地址栏打完字直接点网页，
    // 外壳侧不会收到任何"我失焦了"的可靠信号（DOM focusout 在视图切换时并不保证发）。
    this._shellEditableFocused = false
    this._shellEditableAt = 0
  }

  /** 摘掉某个内容面的焦点记忆（视图销毁时调用；不调也不会错，resolve 会跳过已销毁的）。 */
  forgetContentFocus(wc: WebContents) {
    this._focusMemory.forget(wc)
  }

  /**
   * 上报「外壳此刻是否持有一个可编辑焦点」（由外壳渲染层的 focus-sentinel 订阅上报）。
   * @param {boolean} editable
   */
  setShellEditableFocused(editable: boolean) {
    const next = !!editable
    this._shellEditableFocused = next
    // 时间戳跟随布尔值翻转：true 才刷新（"刚刚开始打字"），false 立刻归零。
    // 只记 true 不记 false 会导致「上一次打字」在新一轮激活里重新获得否决权。
    this._shellEditableAt = next ? Date.now() : 0
    // 「用户开始在外壳里打字」⇒ 正在跑的"回内容面"链立刻作废 —— 否则它会在下一拍
    // 把光标从地址栏拽走（"点了地址栏却打不进字"的成因之一）。
    // 判据必须带上「外壳确实持焦」：渲染层的 DOM 事实在视图切换时会滞后/残留，
    // 仅凭它作废，会把"窗口切回来该回焦网页"这条路径永久关掉。
    if (next && this.isShellFocused()) {
      this._clearContentFocusRetries()
      this._shellBounceUntil = 0
      // 用户明确要在外壳里打字 ⇒ 看门狗当场退场，绝不能和人的输入抢光标。
      this._stopShellFocusWatchdog()
    }
  }

  /** 外壳当前是否在输入框里（地址栏 / 搜索框）—— 是则绝不能被回焦流程抢走。 */
  isShellEditableFocused() {
    return this._shellEditableFocused
  }

  /**
   * 「外壳正在打字」是否是**新鲜**的意图（见 `SHELL_EDIT_INTENT_TTL_MS`）。
   *
   * 所有"要不要把焦点送回内容面"的判据都必须用这一条，而不是裸的
   * `_shellEditableFocused`：后者在窗口失活 / 视图抢焦之后会残留 true，
   * 一旦拿它当闸口，Alt+Tab 回来就永远回不了焦（用户实测的正是这个症状）。
   *
   * @param {number} [withinMs] 保鲜期，默认 TTL
   * @returns {boolean}
   */
  _shellEditIntentFresh(withinMs: number = SHELL_EDIT_INTENT_TTL_MS) : boolean {
    if (!this._shellEditableFocused) return false
    if (!this._shellEditableAt) return false
    return Date.now() - this._shellEditableAt <= withinMs
  }

  // ── 外壳抢焦 → 送回内容面（窗口激活时 Chromium 的 native focus 重放）────────
  /**
   * 订阅**外壳自己**的 `focus` 事件：外壳拿到原生焦点时，若此刻处于「窗口刚重新激活」
   * 的窗口期内、且用户并不是要往外壳的输入框里打字，就把焦点送回内容面。
   *
   * 为什么必须用事件而不只靠拍次表：重放时刻由渲染进程的提交时机决定（实测跨度
   * 20ms ~ 1s+），固定拍次表必然有覆盖不到的部分；而这次重放**一定**会让外壳
   * webContents 触发一次 `focus` —— 那是唯一可靠、零轮询的锚点。
   *
   * 可扩展性：这里只认「外壳」这一个特例（它是窗口本体，地位天然特殊）。将来若出现
   * 第二种"会抢焦但不要键盘"的常驻面，走 `registerChromeFocusSink`，不要加分支在这里。
   */
  _installShellFocusBounce() {
    const attach = () => {
      const shell = this.getUiShellWebContents()
      if (!shell) return false
      try { if (shell.isDestroyed()) return false } catch (_) { return false }
      if (this._shellFocusListener && this._shellFocusListener.wc === shell) return true
      this._removeShellFocusBounce()
      const onFocus = () => this._scheduleShellFocusBounce()
      try { shell.on('focus', onFocus) } catch (_) { return false }
      try {
        onWebContentsDestroyed(shell, () => {
          const l = this._shellFocusListener
          if (l && l.wc === shell) this._shellFocusListener = null
        })
      } catch (_) {}
      this._shellFocusListener = { wc: shell, onFocus }
      return true
    }
    // 构造期窗口的 webContents 一定已存在；宿主若建得更早，下一拍再挂（一次性）。
    if (!attach()) {
      const t = setTimeout(() => { attach() }, 0)
      if (t && typeof t.unref === 'function') t.unref()
    }
  }

  /** 摘掉外壳 focus 订阅（dispose / 换 webContents） */
  _removeShellFocusBounce() {
    const l = this._shellFocusListener
    this._shellFocusListener = null
    if (!l) return
    try { if (l.wc && !l.wc.isDestroyed()) l.wc.removeListener('focus', l.onFocus) } catch (_) {}
  }

  /** 外壳刚拿到焦点：等一帧再判定（见 SHELL_BOUNCE_DELAY_MS）。 */
  _scheduleShellFocusBounce() {
    if (this._shellBounceTimer) return
    this._shellBounceTimer = setTimeout(() => {
      this._shellBounceTimer = null
      try { this._bounceShellFocus() } catch (_) {}
    }, SHELL_BOUNCE_DELAY_MS)
  }

  /**
   * 判定并执行「外壳 → 内容面」的焦点送回。否决条件每一条都对应用户真实意图：
   *   · 不在窗口期 → 用户主动点外壳（地址栏 / 工具栏），不动；
   *   · 外壳在输入框里 → 他在打字，不动；
   *   · 外壳聚焦链在跑（启动首标签 / 新建标签页要聚焦地址栏）→ 明确意图，不动；
   *   · 自持焦浮层开着（查找栏 / 站点信息卡）→ 它们要键盘，不动；
   *   · 窗口不在前台 → 后台重放，不动；
   *   · 内容面已持焦 → 幂等早退（避免与自家的回焦链 ping-pong）。
   */
  _bounceShellFocus() {
    if (Date.now() > this._shellBounceUntil) return
    if (this._shellBounceCount >= SHELL_BOUNCE_MAX) return
    const win = this._win
    if (!win || win.isDestroyed()) return
    try { if (!win.isFocused()) return } catch (_) { return }
    if (this._shellEditIntentFresh()) return
    if (this._shellFocusRetries.length) return
    if (this._hasSelfFocusFloatVisible()) return
    const wc = this._resolveContentFocusTarget()
    if (!wc || this._isWcFocused(wc)) return
    this._shellBounceCount += 1
    this._focusContentWebContents(wc)
  }

  /**
   * 启动「窗口激活窗口期」的焦点看门狗（有界轮询，见 SHELL_FOCUS_WATCHDOG_MS）。
   *
   * 与 `_bounceShellFocus` 的分工：那条是**事件驱动**（外壳 focus 一到就判定），
   * 这条是**状态驱动**（每 60ms 直接问 Chromium「现在谁持焦」）。
   * 两者互不依赖，任意一条生效就够了 —— 这正是"事件漏了就彻底没救"的解药。
   *
   * 幂等：重复调用只续期，不叠加 interval。
   */
  _startShellFocusWatchdog() {
    this._shellWatchdogDeadline = Date.now() + SHELL_BOUNCE_GRACE_MS
    if (this._shellFocusWatchdog) return
    this._shellFocusWatchdog = setInterval(() => {
      // 定时器回调**不允许**抛出去：主进程没有 uncaughtException 兜底，
      // 一拍里任何一次 Electron API 异常（视图刚被销毁、webContents 正在析构）
      // 都会直接崩掉整个应用。异常等同于"本拍失败"，交给下一拍重试。
      let keep = false
      try {
        keep = this._watchdogTick()
      } catch (_) {
        keep = false
      }
      if (!keep) this._stopShellFocusWatchdog()
    }, SHELL_FOCUS_WATCHDOG_MS)
    // 定时器绝不能把事件循环钉住（窗口关掉后进程要能退出）。
    if (this._shellFocusWatchdog && typeof this._shellFocusWatchdog.unref === 'function') {
      this._shellFocusWatchdog.unref()
    }
    // 激活的第一帧就该有焦点：立刻先查一次，不必等第一个节拍。
    let keep = false
    try {
      keep = this._watchdogTick()
    } catch (_) {
      keep = false
    }
    if (!keep) this._stopShellFocusWatchdog()
  }

  /** 停掉看门狗（窗口失活 / 用户开始在外壳打字 / dispose）。 */
  _stopShellFocusWatchdog() {
    if (!this._shellFocusWatchdog) {
      this._shellWatchdogDeadline = 0
      return
    }
    try { clearInterval(this._shellFocusWatchdog) } catch (_) {}
    this._shellFocusWatchdog = null
    this._shellWatchdogDeadline = 0
  }

  /**
   * 看门狗一拍。
   *
   * 返回值语义**必须分两类**，混淆一次就会永久失去自愈能力：
   *   · `false` = **已达目的 / 永久失效**（窗口没了、超期、键盘已在配得上的面上）；
   *   · `true`  = **本拍不动手，但继续观察**（暂时性阻塞：窗口还没真正激活、
   *               用户此刻在地址栏、查找栏浮层开着、外壳聚焦链在跑…）。
   * 这些暂时性条件随时会解除；一旦在这里 return false，`_startShellFocusWatchdog`
   * 就会把 interval 关掉，之后再没人接手 —— 用户实测的"切回来什么都没有"正是这样。
   *
   * @returns {boolean} 是否继续轮询
   */
  _watchdogTick() : boolean {
    const win = this._win
    if (!win || win.isDestroyed()) return false
    if (Date.now() > this._shellWatchdogDeadline) return false
    // 窗口暂时不在前台：**继续等**。Alt+Tab 切回时 `focus` 事件往往早于
    // `isFocused()` 稳定为真，此刻退场等于把自愈能力扔掉。
    try { if (!win.isFocused()) return true } catch (_) { return true }
    // 以下全是「本拍不该动手，但值得继续观察」——必须是 true。
    // 自己持焦的浮层（查找栏）开着：它就要键盘，但随时会关。
    if (this._hasSelfFocusFloatVisible()) return true
    // 用户正在外壳里打字（新鲜意图）：人的输入优先，但意图会过期。
    if (this._shellEditIntentFresh()) return true
    // 键盘已经落在"配得上它"的面上了 → 目的达成，退场。
    const current = this._currentFocusedWebContents()
    if (this._hostSurfaceHoldsKeyboard(current)) return false
    // 外壳自己的聚焦链（新标签页要聚焦地址栏）在跑：让给它，下一拍再确认
    // —— 链跑完若焦点又落到外壳而用户并没有在输入，本拍就会接回来。
    if (this._shellFocusRetries.length) return true
    // 暂无可用目标（视图还在加载）：继续等，别退场。
    const wc = this._resolveContentFocusTarget()
    if (!wc) return true
    if (this._isWcFocused(wc)) return false
    this._focusContentWebContents(wc)
    // 成功 → 收工；失败 → 继续拍到窗口期结束（native 激活可能还没完成）。
    return !this._isWcFocused(wc)
  }

  /**
   * 「这个 webContents 配得上键盘吗」—— 全项目唯一的**持有人资格**判据。
   *
   * 不配的三类（正是用户说的"层级抢焦点"）：
   *   · 外壳（窗口本体）：正常业务里它从不该持键盘（除地址栏输入，那条由
   *     `_shellEditIntentFresh` 单独把关）；
   *   · 外观面（rail 图标条）：登记在 `_chromeFocusViews`，压根没有输入框；
   *   · **已收起的浮层**（bounds 0x0）：看不见却持着键盘，之后所有按键都掉进黑洞
   *     —— 用户看到的就是"打字没反应、得手动点网页"。
   * 其余（标签 / 侧栏 / 面板 / 可见浮层 / 未知视图）一律算数：保守不抢。
   *
   * @param {import('electron').WebContents} wc
   * @returns {boolean}
   */
  _hostSurfaceHoldsKeyboard(wc: WebContents) : boolean {
    if (!wc) return false
    if (this._isShellWebContents(wc)) return false
    if (this._chromeFocusViews.has(wc)) return false
    if (this._isFloatHoldingKeyboardHidden(wc)) return false
    return true
  }

  /**
   * webContents → 它所属的浮层逻辑名（不是浮层视图 = null）。
   * 浮层视图的用户数据一律走这套映射，别处不要各自遍历 `_floatViews`。
   * @param {import('electron').WebContents} wc
   * @returns {string|null}
   */
  _floatNameOfWebContents(wc: WebContents) : string|null {
    if (!wc) return null
    for (const [name, view] of this._floatViews) {
      if (view && view.webContents === wc) return name
    }
    return null
  }

  /**
   * 该 webContents 是不是一个**已经收起（bounds 0x0）的浮层**。
   *
   * 浮层是常驻 visible、显隐只靠 bounds 的（见 `_ensureFloatView`），所以
   * "看不见"这件事在 `webContents.isFocused()` 上完全体现不出来 ——
   * 只有结合 `_floatBounds` 才能回答。
   * @param {import('electron').WebContents} wc
   * @returns {boolean}
   */
  _isFloatHoldingKeyboardHidden(wc: WebContents) : boolean {
    const name = this._floatNameOfWebContents(wc)
    if (!name) return false
    const b = this._floatBounds.get(name)
    return !b || b.width <= 0 || b.height <= 0
  }

  /**
   * 结束这次激活的送焦窗口。
   * 公开（宿主窗口失活 / dispose 时调用）：窗口已经不在前台了，宽容窗留着没有意义，
   * 只会让下一次激活的头 90ms 里立刻触发一次本不该发生的判定。
   */
  endShellFocusBounce() {
    this._shellBounceUntil = 0
    this._shellBounceCount = 0
    // 下一次激活是一次全新的原生激活：不该被上一次的节流记录拖住。
    this._lastWinFocusAt = 0
    if (this._shellBounceTimer) {
      try { clearTimeout(this._shellBounceTimer) } catch (_) {}
      this._shellBounceTimer = null
    }
    // 宽容窗一结束，看门狗也失去存在理由：窗口都不在前台了，轮询只会空转。
    this._stopShellFocusWatchdog()
  }

  /** 是否有「自己持焦」的浮层**真的在屏上**（查找栏 / 站点信息卡）—— 它们要键盘，别抢。 */
  _hasSelfFocusFloatVisible() {
    for (const name of SELF_FOCUS_FLOATS) {
      if (!this.isFloatVisible(name)) continue
      // 逻辑可见 ≠ 真在屏上：bounds 已被收成 0×0 的浮层既看不见、也拿不到键盘。
      // 只看逻辑态（早先的写法）会让本闸口永久为真 —— 某条只收 bounds 没收逻辑态的
      // 路径一出现，回焦与看门狗就一起废掉（用户实测："切回来什么都没有"）。
      // 反过来只看 bounds 又会漏掉「已请求显示、矩形还没量出来」的窗口期，那种按
      // "即将出现"处理（bounds 缺失 = 不否决），宁可晚一拍还焦。
      const b = this._floatBounds.get(name)
      if (b && (b.width <= 0 || b.height <= 0)) continue
      return true
    }
    return false
  }

  /** 该 webContents 是不是外壳（窗口本体） */
  _isShellWebContents(wc: WebContents) {
    if (!wc) return false
    let shell = null
    try { shell = this.getUiShellWebContents() } catch (_) { shell = null }
    return !!shell && shell === wc
  }

  /** 回焦目标：记忆里最近一个仍可用的内容面；都没有 → 活动标签；再没有 → null。 */
  _resolveContentFocusTarget() {
    const entry = this._focusMemory.resolve((e) => this._isContentSurfaceAvailable(e))
    if (entry) return entry.wc
    // 兜底：记忆为空（刚启动 / 全部失效）时回到活动标签 —— 这正是"窗口回到前台，
    // 键盘该落在正看着的那张网页上"的默认语义。
    const id = this._activeTabId
    if (!id || !this._wcm || typeof this._wcm.getTab !== 'function') return null
    const view = this._wcm.getTab(id)
    const wc = view && view.webContents
    if (!wc) return null
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return null
    return wc
  }

  /**
   * 此刻是否**不该**把焦点送回内容面（任一闸口成立即停手）。
   * @param {{ activation?: boolean }} [options] activation=true：本次是「窗口重新激活」，
   *        浮层 / 面板的聚焦链一律视为过期意图（见 restoreContentFocus 的 preempt）。
   */
  _contentFocusBlocked(options: ParentFocusRequestOptions = {}): boolean {
    const win = this._win
    if (!win || win.isDestroyed()) return true
    // ① 后台窗口绝不抢 OS 焦点（那是"我切到别的应用，它把我的焦点拽回去"）。
    try {
      if (typeof win.isFocused === 'function' && !win.isFocused()) return true
    } catch (_) { return true }
    // ② 用户正在外壳的输入框里打字 —— 且**外壳确实持焦**、且这条意图是**新鲜的**。
    //    `_shellEditableFocused` 是渲染层上报的 DOM 事实，视图切换 / 窗口失活时会残留：
    //    只要拿裸布尔值当闸口，Alt+Tab 回来就会永久拦死回焦（用户实测症状）。
    //    改为「值 + 时间戳」后，残留值自动过期；真在打字时（每键都会刷新）照样拦住。
    if (this._shellEditableFocused && this.isShellFocused() && this._shellEditIntentFresh()) return true
    // ③ 查找栏 / 站点信息卡这类"自己持焦"的浮层正开着。
    if (this._hasSelfFocusFloatVisible()) return true
    // ④ 外壳 / 浮层 / 面板的**聚焦意图链**正在跑：它们各有自己的重申拍次，
    //    这里再插一脚只会两条链互相抢（表现为光标在两处闪）。
    //    窗口重新激活时例外：浮层 / 面板的链必然是切走前留下的过期意图（激活时
    //    浮层已全部收起，见 assembly 的 blur 处理），再让它们否决回焦就永远回不去。
    const chainsBusy = this._shellFocusRetries.length
      || (options.activation === true
        ? false
        : (this._floatFocusRetries.length || this._panelFocusRetries.length))
    if (chainsBusy) return true
    // ⑤ 本应用的另一个窗口（如查找栏独立窗口）正持焦 —— 同 isForeignWindowFocused。
    try {
      const { BrowserWindow } = require('electron')
      const focused = typeof BrowserWindow.getFocusedWindow === 'function' ? BrowserWindow.getFocusedWindow() : null
      if (focused && !focused.isDestroyed() && focused !== win) return true
    } catch (_) {}
    return false
  }

  /**
   * 把键盘焦点还给**内容面**（用户刚才打字的那张网页 / 侧栏 / 面板）。
   *
   * 两个调用方，语义完全一致：
   *   · 窗口从失活回到前台（`browser-window-assembly` 的 `win.on('focus')`）；
   *   · 外壳渲染层报告「用户点了外壳的非输入区」（`content:focus` 通道）——
   *     这一条是"点标签栏空白 / 点顶条后网页输入框失焦、键盘没反应"的正面修复。
   *
   * 为什么是"分几拍重申"而不是一次 `focus()`：窗口激活时 Chromium 会**自己重放**
   * 一次 native focus（通常落回外壳），单次调用只会换来"光标闪一下就被顶掉"。
   * 每拍都重新过一遍闸口 —— 用户在拍次之间主动点了别处，后面几拍自动空转，
   * 不会把焦点硬抢回来。
   *
   * @param {{ reason?: string, immediate?: boolean, retries?: boolean, preempt?: boolean }} [options]
   *   immediate=true：先同步试一拍（点外壳空白处这种"当场就该回去"的路径用）。
   *   retries=false：只做那一拍，不排重申拍次（切标签用 —— 那里没有会回抢的一方，
   *   排拍次反而会在启动时与"地址栏聚焦链"抢）。
   *   preempt=true：作废其他"要焦点"链 + 启动焦点看门狗（窗口回到前台专用，见下方注释）。
   * @returns {boolean} 是否发起了（窗口不可用 / 已被闸口拦下 = false）
   */
  restoreContentFocus(options: FocusRestoreOptions = {}): boolean {
    const win = this._win
    if (!win || win.isDestroyed()) return false
    // 「窗口重新激活」是一个**结构性**时刻：native focus 会被 Chromium 重放给外壳，
    // 时刻不可预知，且任何"事件"都可能漏。它同时拥有最高优先级语义 ——
    // 切走时地址栏光标已被主动交还（`releaseAddressFocus`），此刻还挂着的
    // shell / 浮层 / 面板聚焦链全是**过期意图**。不作废它们，闸口④ 会把这条路径
    // 再拦 1s 以上 —— 用户看到的就是"切回来什么都没有"。
    const activation = options.preempt === true || options.activation === true
    if (options.preempt === true) {
      this._clearShellFocusRetries()
      this._clearFloatFocusRetries()
      this._clearPanelFocusRetries()
      // 上一条"回内容面"链也是过期意图：不清掉它会与本条并行跑，两串拍次互相顶。
      this._clearRestoreFocusRetries()
      // 同时开启「外壳抢焦就送回去」的宽容窗：窗口激活后 Chromium 必然把 native
      // focus 重放给外壳（窗口本体），时刻不可预知 —— 拍次表只能覆盖前半段，
      // 剩下的交给 `shell.webContents.on('focus')` 事件（见 _installShellFocusBounce）。
      this._shellBounceUntil = Date.now() + SHELL_BOUNCE_GRACE_MS
      this._shellBounceCount = 0
      // 事件可能压根不来（外壳从未真正失焦 / 重放晚于渲染提交）：再叠一层有界
      // 状态轮询兜底。两条通道互不依赖，任意一条生效即可。
      this._startShellFocusWatchdog()
    }
    const attempt = () => {
      if (this._contentFocusBlocked({ activation })) return
      const wc = this._resolveContentFocusTarget()
      if (!wc) return
      if (this._isWcFocused(wc)) return
      // 只在「无人持焦 / 外壳持焦 / 焦点就在目标这一面」时接手：
      // 用户已经主动点进侧栏、面板或某个浮层时，绝不能把焦点拽回标签。
      // 外观面（rail 图标条）不算"用户的选择"——它压根不要键盘，见 registerChromeFocusSink。
      // **已收起的浮层同样不算**：它看不见却持着键盘，正是"打字没反应"的元凶
      // （以前这里会因为 `_focusMemory` 里查不到它而直接 return，回焦永远不发生）。
      const current = this._currentFocusedWebContents()
      if (
        current &&
        current !== wc &&
        !this._isShellWebContents(current) &&
        !this._chromeFocusViews.has(current) &&
        !this._isFloatHoldingKeyboardHidden(current)
      ) {
        const known = this._focusMemory.list().find((e) => e.wc === current)
        if (!known || this._isContentSurfaceAvailable(known)) return
      }
      this._focusContentWebContents(wc)
    }
    this._clearContentFocusRetries()
    if (options.immediate === true) attempt()
    if (options.retries === false) return true
    this._armFocusRetries(this._contentFocusRetries, attempt, CONTENT_FOCUS_RETRY_MS)
    return true
  }

  /**
   * 切标签后「键盘跟着页面上屏」—— 分屏 / 速览 / 普通三条路径**共用这一条判据**。
   *
   * 为什么不能只靠 `reallocateFocus()`：外壳持焦时它会主动空转（让位给地址栏输入，
   * 见 LayerManager）。而"用户点了另一个标签"恰恰是最该把键盘交给新页面的动作 ——
   * 少了这一步，点标签条以后键盘就停在外壳上，网页输入框看起来在、实际打不进字。
   *
   * 与地址栏的关系由闸口决定（不是这里）：`_shellEditableFocused` 为真时
   * （用户正在地址栏里，Ctrl+Tab 切标签）整个回焦会被拦下，键盘留在地址栏。
   *
   * @param {boolean} prevWasFocused 切走前键盘是否在原来那张网页上
   */
  _syncFocusAfterTabShow(prevWasFocused: boolean) {
    if (!prevWasFocused && this._layers.getFocusedLayer()) return
    this._layers.reallocateFocus()
    this.restoreContentFocus({ reason: 'tab-show', immediate: true, retries: false })
  }

  /** 从 tab 图层摘除标签视图（关闭 / 休眠时调用，为的是让 webContents 能安全销毁） */
  _detachTabView(view: WebContentsView) {
    if (!view) return
    if (this._visibleTabView === view) this._visibleTabView = null
    if (!this._tabLayerChildren.has(view)) return
    this._tabLayerChildren.delete(view)
    if (!this._tabLayer) return
    try { this._tabLayer.removeChildView(view) } catch (_) {}
  }

  /**
   * 把一个 contentView 级 view 包装成图层并挂载（幂等：同名图层且 view 相同则复用）。
   * 图层名决定 zIndex / 焦点优先级 / modal 谓词（见 LayerStack）。
   * @param {string} name 逻辑图层名（Map 键，可含 id 以唯一化）
   * @param {Electron.View} view
   * @param {string} [zKey] 用于取 zIndex/焦点/modal 的规则名（默认同 name）
   * @returns {Layer}
   */
  _pushLayer(name: string, view: View, zKey?: string, layerOptions?: ConstructorParameters<typeof Layer>[2]): Layer {
    const key = String(name)
    const existing = this._chromeLayers.get(key)
    if (existing) {
      if (existing.view === (view as unknown as Layer['view'])) return existing
      // 同逻辑名换了新 view：先摘掉旧图层，避免重复挂载 / 焦点错乱
      this._layers.pop(existing)
      this._chromeLayers.delete(key)
    }
    const ruleName = zKey ? String(zKey) : key
    const layer = new Layer(this._layers, view, {
      ...(layerOptions || {}),
      name: ruleName,
      zIndex: zIndexFor(ruleName),
      focusPriority: focusPriorityFor(ruleName),
      modalTo: createModalTo(ruleName)
    })
    this._layers.push(layer)
    this._chromeLayers.set(key, layer)
    return layer
  }

  /** 取逻辑名对应的图层（不存在则 null） */
  _getLayer(name: string): Layer | null {
    return this._chromeLayers.get(String(name)) || null
  }

  attachUiShell() {
    const view = this._wcm.createUiShell()
    this._uiShellView = view
    // chrome = 窗口本体（ChromeView 假视图）：天然铺满 contentView、天然位于其所有
    // 子视图（tab / rail / panel / 浮层）之下 —— 因此**不进入图层体系**：
    // 不 push 图层（不 addChildView、不参与 z 序 / 焦点 / 模态），也不 setBounds。
    // WebContentsView 没有 setAutoResize，窗口 resize 时手动重排其余图层。
    // 只注册一次 resize 监听，用 RAF 合并高频 resize 事件，避免主进程卡顿。
    if (!this._resizeBound) {
      this._resizeBound = true
      let pending = false
      // 句柄留存（而不是内联箭头）—— dispose() 要能把它摘掉，否则窗口销毁后
      // 这个监听仍把整个协调器钉在窗口对象上。
      this._onWinResize = () => {
        if (pending) return
        pending = true
        setImmediate(() => {
          pending = false
          // immediate：拖拽窗口边缘时网页必须逐帧跟手，绝不能被弹簧拖住
          try { this.applyInitialLayout({ immediate: true }) } catch (_) {}
        })
      }
      this._win.on('resize', this._onWinResize)
    }
    /**
     * 窗口前后台切换 → 三条指针巡看表按需起停（判据见 `_windowInteractive`）。
     *
     * 与 resize 监听同处注册：这里也是「窗口事件」的唯一绑定点，摘除在 dispose()。
     * 事件本身很稀疏（失焦 / 回焦 / 最小化 / 恢复），开销可忽略；换来的是
     * **窗口不在前台时主进程零轮询** —— 切去别的应用后不会再每 25ms 醒一次去读指针。
     */
    if (!this._winActivityBound) {
      this._winActivityBound = true
      this._onWinActivity = () => {
        try {
          this._syncImmersiveWatch()
          this._syncSideRevealWatch()
          this._syncRailRevealWatch()
          if (this._windowInteractive()) this._ensurePointerAvoidTimer()
          else this._stopPointerAvoidTimer()
        } catch (_) {}
      }
      const winEvents = this._win as unknown as WindowEventPort
      for (const evt of WIN_ACTIVITY_EVENTS) winEvents.on(evt, this._onWinActivity)
    }
    this.applyInitialLayout()
  }

  /**
   * 惰性创建并挂载某个独立浮层 view（searchbar 下拉 / tab preview / permission）。
   *
   * **对齐 RT：启动期绝不预热浮层 renderer。** 只有在该浮层首次真正需要显示时
   * 才建 view + 挂图层 + 后台加载内容 —— 省掉启动期 3 个多余渲染进程。
   *
   * **彻底解耦**：每个浮层一个专属 view，各自 bounds 独立（0x0 = 隐藏），
   * 不共用图层、不强制互斥 —— 多个浮层可同时存在且互不干扰。
   * 默认 0x0 + ignoreMouseEvents，不拦截任何下层点击。
   *
   * @param {string} name 浮层逻辑名（searchbar-overlay / tabpreview-overlay / siteinfo-overlay）
   * @returns {Electron.WebContentsView|null}
   */
  _ensureFloatView(name: string): WebContentsView | null {
    const key = String(name)
    const existing = this._floatViews.get(key)
    if (existing) return existing

    const view = this._wcm.createFloatView(key)
    this._floatViews.set(key, view)
    /**
     * 浮层**常驻 visible**，显隐只靠 bounds（0x0 = 收起）。
     *
     * 为什么不切 setVisible：WebContentsView 由隐藏变可见的那一刻，Chromium 会**原生**
     * 把键盘焦点交给它 —— 不经任何 JS focus 调用，`webPreferences.focusable:false` 也无效。
     * 后果是「地址栏刚敲的第一个字符打不进去」「中文输入法的组合串被整段取消」
     * 「鼠标划过标签弹出预览把网页焦点顶掉」。常驻 visible 从根上消除了这次可见性跳变。
     * 收起的浮层 bounds 为 0x0，既不渲染也不拦鼠标；它的「可见性」由下方 isVisible 谓词
     * 按 bounds 判定，以免 0x0 的收起态仍被算作可见图层去参与模态遮挡与焦点再分配。
     */
    this._pushLayer(`float:${key}`, view, undefined, {
      isVisible: () => {
        const b = this._floatBounds.get(key)
        return !!b && b.width > 0 && b.height > 0
      }
    })
    const hiddenBounds = { x: 0, y: 0, width: 0, height: 0 }
    this._floatBounds.set(key, hiddenBounds)
    this._floatInteractive.set(key, false)
    // 初始化逻辑可见态/代际：**只在未登记时**写入 —— 首次 show 会先 noteFloatShow
    // （已置 true）再惰性建 view，此处若无条件覆盖会把刚登记的显示意图抹掉。
    if (!this._floatVisible.has(key)) this._floatVisible.set(key, false)
    if (!this._floatSeq.has(key)) this._floatSeq.set(key, 0)
    // 「收起的浮层绝不持键盘」—— 事件驱动的那一半（另一半在 setFloatBounds 收起分支）。
    //
    // 为什么必须在**拿到焦点那一刻**拦：浮层 renderer 加载完成 / 内部重排时，Chromium
    // 会**原生**把键盘焦点交给它，而常驻 visible 的浮层收起后仍是"可见视图"（只是 0x0），
    // 于是键盘掉进一块看不见的网页 —— 用户看到的就是"打字完全没反应，得手动点网页"。
    // 这条规则对**所有**浮层成立（不再按名单维护），新增浮层自动被覆盖。
    try {
      const floatWc = view.webContents
      const onFloatFocus = () => {
        if (this._isFloatHoldingKeyboardHidden(floatWc)) {
          // 让出焦点是异步的：此刻可能正处在 show → 回执 → setBounds 的中间态，
          // 等一拍再看，避免把"马上要显示"的浮层误判成收起态。
          setImmediate(() => {
            try { if (floatWc.isDestroyed()) return } catch (_) { return }
            if (!this._isFloatHoldingKeyboardHidden(floatWc)) return
            this.restoreContentFocus({ reason: 'float-hidden-focus', immediate: true, retries: false })
          })
          return
        }
        // 可见的「只吃鼠标」浮层（地址栏下拉）抢到键盘 → 立刻交还外壳。
        // 不交还的话，点一下下拉（删除叉叉 / 行内按钮）就会把地址栏顶失焦、下拉被收起。
        if (!MOUSE_ONLY_FLOATS.has(key)) return
        setImmediate(() => {
          try { if (floatWc.isDestroyed() || !floatWc.isFocused()) return } catch (_) { return }
          const shell = this.getUiShellWebContents()
          if (shell && !shell.isDestroyed()) this._restoreFocusTo(shell)
        })
      }
      floatWc.on('focus', onFloatFocus)
    } catch (_) {}
    try { view.setBounds(hiddenBounds) } catch (_) {}
    // 内容惰性加载：视图建好后立刻后台载入 renderer，首次显示即就绪。
    if (typeof this._wcm.loadFloatView === 'function') {
      this._wcm
        .loadFloatView(key)
        // 加载完成仍在收起态（预热 / 建好没用到）→ 立刻把节流打开：
        // 加载**期间**必须保持不节流（boot 期的定时器 / rAF 不能被降到 1Hz），
        // 加载完成后它只是一块 0×0 的空壳，没有理由再拖着整窗出帧。
        .then(() => {
          if (!this._isFloatOnScreen(key)) this._syncFloatThrottle(key, true)
        })
        .catch((e: unknown) => console.error(`[layout] loadFloatView(${key}) failed:`, errorMessage(e)))
    }
    // 新视图**先按"闲置"计**，排一次回收。
    // 为什么必须在这里也排：**预热**建出来的浮层（见 warmFloatView）如果用户从没用到它，
    // 它永远不会经过"收起"这条路 —— 只靠 setFloatBounds 接线的话那几个进程会原样挂到
    // 窗口关闭。显示时 setFloatBounds(正矩形) 会自动把它撤掉。
    this._scheduleFloatReclaim(key)
    return view
  }

  /**
   * 显式挂载某浮层（保留的公开 API；等价于 _ensureFloatView）。
   * @param {string} name
   * @returns {Electron.WebContentsView|null}
   */
  attachFloatView(name: string): WebContentsView | null {
    return this._ensureFloatView(name)
  }

  /**
   * **预热**某浮层：后台建好视图并把渲染页载入，但**不显示**（bounds 仍是 0×0）。
   *
   * ── 为什么必须有这一步（而不是靠首次 show 惰性创建）──────────────────────
   * 每个浮层都是**独立 renderer 进程**：惰性创建的那一次要付「进程启动 + 页面加载 +
   * JS/CSS 解析」，实测几百毫秒。浏览器的搜索下拉是**跟着第一次按键出**的 —— 这段冷启动
   * 正好落在用户刚敲下的第一个字符上，表现就是「输入后下拉栏半天不出来」。
   * 项目先前**刻意取消了启动预热**（省掉每个浮层 ~22MB，见 WebContentsManager#destroyFloatView），
   * 但地址栏**获得焦点**是一个极强的"马上要用它"信号 → 此刻后台预热既省内存又不迟到。
   *
   * 加载完成时 Chromium 会「原生」把键盘焦点拿给浮层 renderer，因此先记下当时的持焦者，
   * 载入完成后还回去 —— 否则表现就是「刚点进地址栏，字打不进去了」。
   *
   * 幂等：视图已存在则直接返回（载入早已完成或正在进行）。闲置回收照旧生效 ——
   * 预热后若用户一直没用它，`_scheduleFloatReclaim` 到点仍会把它销毁。
   *
   * @param {string} name 浮层逻辑名
   */
  warmFloatView(name: string): void {
    const key = String(name)
    if (this._floatViews.has(key)) return
    const holder = this._currentFocusedWebContents()
    this._ensureFloatView(key)
    if (holder && typeof this._wcm.loadFloatView === 'function') {
      this._wcm.loadFloatView(key)
        .then(() => this._restoreFocusTo(holder))
        .catch(() => {})
    }
  }

  /**
   * 向某浮层 renderer 发送事件。浮层尚未创建时**先惰性创建**，并等待 renderer
   * 就绪（did-finish-load）后再发送 —— 避免「首帧 show 事件打在空白 renderer 上丢失」。
   * @param {string} name 浮层逻辑名
   * @param {string} channel IPC 事件通道
   * @param {unknown} payload
   * @param {() => boolean} [guard] 就绪后再次校验的守卫；返回 false 则放弃下发
   */
  async sendToFloat(name: string, channel: string, payload: unknown, guard?: () => boolean): Promise<void> {
    const key = String(name)
    const view = this._ensureFloatView(key)
    if (!view) return
    const wc = view.webContents
    if (!wc || wc.isDestroyed()) return
    try {
      if (typeof this._wcm.loadFloatView === 'function') await this._wcm.loadFloatView(key)
    } catch (_) {
      // 浮层页面加载失败：视图仍留在表里（0×0、鼠标穿透），下一次 show 会再试一次。
      // 这里不能把异常抛出去 —— 它会把整条 show 链路（含聚焦）一起带走。
    }
    if (wc.isDestroyed()) return
    // 冷启动 await 期间可能已被 hide / 新 show 取代 —— 过期就不下发，
    // 否则 show 会反向插队到 hide 之后，浮层在"已关闭"状态下凭空弹出来。
    if (typeof guard === 'function' && !guard()) return
    try { wc.send(channel, payload) } catch (_) {}
  }

  /**
   * 声明某浮层「请求显示」：递增代际 + 逻辑可见态置为可见。
   * @param {string} name 浮层逻辑名
   * @param {Electron.WebContents} [opener] 发起本次 show 的视图（不传 = 外壳 / 未知）。
   *   见 `_floatOpener`：它决定浮层的回传（overlay:commit）送回哪个视图。
   * @returns {number} 本次请求的代际号（show 真正下发前用它校验是否已被取代）
   */
  noteFloatShow(name: string, opener?: WebContents): number {
    const key = String(name)
    // 发起方只在**明确给出**时更新：内部预热（warmFloatView）不传发送方，
    // 不能把上一次真实发起方抹掉。
    if (opener && typeof opener.isDestroyed === 'function' && !opener.isDestroyed()) {
      this._floatOpener.set(key, opener)
    }
    const next = (this._floatSeq.get(key) || 0) + 1
    this._floatSeq.set(key, next)
    this._floatVisible.set(key, true)
    // 「要用了」—— 立刻撤掉闲置回收定时器。不能只等 setFloatBounds(正矩形)：
    // 从 show 意图到 renderer 回传 display 之间有窗口期，定时器若正好在这期间到期，
    // 会把这个马上要显示的浮层收掉（功能不错但白重建一次）。这里显式撤销。
    this._cancelFloatReclaim(key)
    // 新的 show 作废上一次"退场中"的状态：否则退场兜底定时器会把刚显示出来的浮层收掉。
    this._cancelFloatExit(key)
    // 记下这一刻谁在持焦：浮层 renderer 加载完成时会「原生」抢走键盘焦点，
    // 归还目标必须是「用户请求显示之前」的那个持有者 —— 正在地址栏输入时它就是地址栏。
    this._floatFocusHolders.set(key, this._currentFocusedWebContents())
    return next
  }

  /** 该代际的 show 是否仍然有效（未被后续 hide / 新 show 取代） */
  isFloatShowCurrent(name: string, seq: number): boolean {
    return (this._floatSeq.get(String(name)) || 0) === seq
  }

  /**
   * 某浮层最近一次 show 的**发起方**（见 `_floatOpener`）。
   *
   * 返回 null = 发起方是外壳（窗口本体，没有 getBounds）或视图已被销毁 ——
   * 调用方此时应回退到外壳（历史行为）。
   * @param {string} name
   * @returns {Electron.WebContents|null}
   */
  getFloatOpener(name: string): WebContents | null {
    const wc = this._floatOpener.get(String(name))
    return wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() ? wc : null
  }

  /**
   * 窗口内容区尺寸（CSS 像素）。
   *
   * 用途：铺满整窗的浮层（空间菜单）要用**窗口**尺寸夹自己的最大宽高 —— 而它的
   * 发起方（侧栏浮出层）的 innerWidth 只是自己那条视图的宽度，量不出窗口有多大。
   * @returns {{ width: number, height: number }|null}
   */
  getWindowContentSize() : { width: number, height: number }|null {
    const win = this._win
    if (!win || win.isDestroyed()) return null
    const size = typeof win.getContentSize === 'function' ? win.getContentSize() : null
    if (!size || !Number.isFinite(size[0]) || !Number.isFinite(size[1])) return null
    return { width: Math.round(size[0]), height: Math.round(size[1]) }
  }

  /** 某浮层当前是否为「逻辑可见」（主进程裁定；renderer 回传不得越过它） */
  isFloatVisible(name: string): boolean {
    return this._floatVisible.get(String(name)) === true
  }

  /** 某浮层是否**逻辑可见且原生尺寸大于零**（主进程驱动型浮层的自愈探针）。 */
  isFloatShown(name: string): boolean {
    return this._isFloatShown(String(name))
  }

  /**
   * 某个**内容区坐标**的点是否落在**别的可见浮层**的矩形内。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────
   * 拖标签的落点判定（"光标在不在网页上"）只看网页矩形。但浮层是**盖在网页之上**的
   * （例如 rail 收起态悬停展开的标签列浮层），于是在浮层里正常范围内拖动标签时，
   * 光标几何上确实落在网页矩形内 —— 判据会误判成"拖到网页上"，表现就是
   * **在浮层里拖动却闪出分屏预览、松手还真的分了屏**。浮层那块不属于网页。
   *
   * @param {{x:number,y:number}} point 内容区坐标
   * @param {{except?: string|string[]}} [options] 要忽略的浮层名。
   *   拖标签时**必须**忽略落点预览自己（`dropzone-overlay`）：它本来就画在光标那片区域上，
   *   不忽略的话预览一出现就会把自己判成"在浮层里"从而立刻收起（自己否决自己）。
   */
  isPointOverFloat(point: { x: number; y: number }, options: { except?: string | string[] } = {}): boolean {
    if (!point || this._floatBounds.size === 0) return false
    const raw = options && options.except
    // 快路径：不忽略任何浮层时**不建 Set** —— 本方法在拖标签期间按拍被调（30fps），
    // 每拍三份短命分配（两数组 + 一 Set）纯属浪费。
    const except = raw ? new Set((Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(String)) : null
    for (const [name, rect] of this._floatBounds) {
      if (!rect) continue
      if (except && except.has(String(name))) continue
      if (!this.isFloatVisible(name)) continue
      if (point.x >= rect.x && point.x <= rect.x + rect.width &&
        point.y >= rect.y && point.y <= rect.y + rect.height) return true
    }
    return false
  }

  /**
   * 权威收起某浮层：逻辑可见态置隐藏并递增代际（作废在途的 show / display），
   * 收起 bounds 与交互。主进程所有收起路径（IPC hide / 切标签 / 关标签 / 窗口失焦）
   * 统一走这里 —— 不再只依赖 renderer 的 mouseout / blur 这类易丢信号。
   * @param {string} name 浮层逻辑名
   * @param {{ keepFocus?: boolean, animateOut?: boolean }} [options] keepFocus：收起时不让位键盘焦点
   * @returns {boolean} 这次调用**是否真的做了什么**。false = 它本来就没开着
   *   （逻辑不可见 + bounds 已为 0 + 没有在途退场）。
   *   宿主（`window-chrome#hideFloat`）据此跳过后续的 `:hide` / `overlay:closed` 通知 ——
   *   切一次标签要过 8 个浮层名册，绝大多数本来就没开着，那十几条 IPC 纯属白烧。
   */
  hideFloat(name: string, options: { keepFocus?: boolean; animateOut?: boolean } = {}): boolean {
    const key = String(name)
    const resumeEditingPresentation = key === 'buttons-edit-overlay' && this._editingPresentation
    const resumeSideReveal = key === 'buttons-edit-overlay' && this._sideRevealSuspended
    if (resumeSideReveal) this._sideRevealSuspended = false
    const b = this._floatBounds.get(key)
    const onScreen = !!b && b.width > 0 && b.height > 0
    // 完全没事可做：三个状态都为"不在台上"（判据与 _reclaimFloatView 的闸门同源）。
    if (!onScreen && !this.isFloatVisible(key) && !this._floatExitPending.get(key)) {
      // 逻辑态本就已经是 false；这里只在它意外为 true 时纠正（极少数外部直接写表的情况）
      if (resumeEditingPresentation) this.setEditingPresentation(false)
      if (resumeSideReveal) this._syncSideRevealWatch()
      return false
    }
    this._floatSeq.set(key, (this._floatSeq.get(key) || 0) + 1)
    this._floatVisible.set(key, false)
    // 逻辑可见态一变就解挂外部点击侦听（见 _syncFloatDismissSources）。
    if (this._floatDismissOutside.has(key)) this._syncFloatDismissSources()
    if (!this._floatViews.has(key)) {
      if (resumeEditingPresentation) this.setEditingPresentation(false)
      if (resumeSideReveal) this._syncSideRevealWatch()
      return true
    }
    // 先立刻失去交互：浮层正在退场，绝不能还拦着下层的点击
    this.setFloatInteractive(key, false)
    if (options.animateOut) {
      // 带退场动效的浮层（标签预览）：bounds 先留着，等 renderer 播完动画回执再收 ——
      // 否则 view 瞬间缩成 0，动画根本来不及画。兜底超时防止 renderer 不回执时留僵尸浮层。
      this._floatExitPending.set(key, true)
      this._clearFloatExitTimer(key)
      this._floatExitTimers.set(key, setTimeout(() => {
        this._floatExitTimers.delete(key)
        try { this.finishFloatHide(key) } catch (_) {}
      }, FLOAT_EXIT_FALLBACK_MS))
      return true
    }
    this.setFloatBounds(key, { x: 0, y: 0, width: 0, height: 0 }, options)
    if (resumeEditingPresentation) this.setEditingPresentation(false)
    if (resumeSideReveal) this._syncSideRevealWatch()
    return true
  }

  /**
   * renderer 播完退场动效后的回执：这时才真正把 bounds 收成 0（幂等）。
   * 只有确实处于"退场中"才动手 —— 期间已被新的 show 打断时，这次回执必须忽略。
   * @param {string} name
   */
  finishFloatHide(name: string): void {
    const key = String(name)
    if (!this._floatExitPending.get(key)) return
    this._cancelFloatExit(key)
    this.setFloatBounds(key, { x: 0, y: 0, width: 0, height: 0 })
  }

  /** 作废某浮层的"退场中"状态与兜底定时器 */
  _cancelFloatExit(key: string): void {
    this._floatExitPending.delete(key)
    this._clearFloatExitTimer(key)
  }

  _clearFloatExitTimer(key: string): void {
    const t = this._floatExitTimers.get(key)
    if (t) {
      clearTimeout(t)
      this._floatExitTimers.delete(key)
    }
  }

  // ── 浮层闲置回收（把「不用就还回去」做成常态）──────────────────────────────
  //
  // 一个浮层 = 一个独立 renderer 进程（实测：独占 ~22 MB / 工作集 ~108 MB）。
  // 而 chrome 这些浮层绝大多数时间是不显示的 —— 视图即使 0×0 + 鼠标穿透，
  // 进程照样常驻。窗口开上几小时后**所有**浮层都被创建过一遍却再没显示过，
  // 那是纯浪费。这里给它一条回收腿，与标签的自动休眠同一思路：
  //   标签：sleepTab 销毁 webContents、保留记录（唤醒重建）
  //   浮层：destroyFloatView 销毁视图与 webContents、保留逻辑名（显示时重建）
  //
  // 触发有两条腿，互为补充：
  //   · 温和：收起后闲置超 FLOAT_IDLE_RECLAIM_MS（排在这里，显示时撤销）；
  //   · 急迫：内存压力回收时**立即**收掉全部不可见浮层（见 reclaimIdleFloatViews，
  //     由 main 的 memory.guard 调用）—— 浮层是纯 UI，重建只要 ~200ms，
  //     比"重建一整个网页"便宜得多，所以它该排在**标签休眠之前**做。

  /**
   * 给某浮层排一次闲置回收（**幂等**：已排则不动）。
   *
   * 只在它确实还有一个视图时才排 —— 没有视图就没有进程可回收，
   * 排了也只是空转一个定时器。
   * @param {string} name
   */
  _scheduleFloatReclaim(name: string): void {
    const key = String(name)
    if (this._floatReclaimTimers.has(key)) return
    if (!this._floatViews.has(key)) return
    const timer = setTimeout(() => {
      this._floatReclaimTimers.delete(key)
      try { this._reclaimFloatView(key) } catch (_) {}
    }, FLOAT_IDLE_RECLAIM_MS)
    // unref：这个定时器不该成为"进程退不掉"的最后一个抓手。
    if (typeof timer.unref === 'function') timer.unref()
    this._floatReclaimTimers.set(key, timer)
  }

  /**
   * 撤销某浮层的闲置回收（**幂等**）。显示 / 已回收 / 从未排过都是安全空操作。
   * @param {string} name
   */
  _cancelFloatReclaim(name: string): void {
    const key = String(name)
    const timer = this._floatReclaimTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this._floatReclaimTimers.delete(key)
  }

  /**
   * 某浮层此刻是否**真的占着屏幕**（真实 bounds 非零）。
   *
   * 与图层登记时的 `isVisible` 谓词**同一判据**（见 `_ensureFloatView` 的说明：
   * "浮层常驻 visible，显隐只靠 bounds"）。**不能**用 `isFloatVisible`（那是"逻辑
   * 显示意图"，由 noteFloatShow / hideFloat 维护）—— 真实存在"只设了 bounds、
   * 没走 noteFloatShow"的路径，拿逻辑态当可见性判据会漏判。
   * @param {string} key
   */
  _isFloatOnScreen(key: string): boolean {
    const b = this._floatBounds.get(key)
    return !!b && b.width > 0 && b.height > 0
  }

  /**
   * 收起 / 显示浮层时同步它的 backgroundThrottling（只记跳变，稳态零调用）。
   *
   * 背景：浮层创建时 `backgroundThrottling: false` 是为了「首次显示首帧不空白」；
   * 但 Electron 文档写明「同一 BrowserWindow 内只要有**任一** displayed webContents
   * 关掉了它，整窗所有 webContents 都会持续绘制与交换」。浮层收起后仍是 visible 的
   * 0×0 视图 —— 不把它关回去，整个窗口（含前台正在播放 / 滚动的标签页）就会被它
   * 永久拖在 60fps，代价是 CPU / GPU / 耗电，且前台越忙越容易掉帧。
   *
   * 所以：**收起 = 节流开（true，回到默认）**，**显示 = 节流关（false，保持秒开）**。
   * 显示这一拍先于 setBounds 调用，Chromium 收到的第一帧就不在节流态。
   *
   * @param {string} key 浮层名
   * @param {boolean} throttled true = 允许节流（收起态）
   */
  _syncFloatThrottle(key: string, throttled: boolean): void {
    const view = this._floatViews.get(key)
    if (!view) return
    const viewWc = view.webContents
    if (!viewWc) return
    const next = Boolean(throttled)
    if (this._floatThrottled.get(key) === next) return
    this._floatThrottled.set(key, next)
    try {
      if (typeof viewWc.setBackgroundThrottling === 'function') viewWc.setBackgroundThrottling(next)
    } catch (_) {
      // 视图已销毁 / Electron 版本不支持：保持创建时的默认（不节流），不影响功能
    }
  }

  /**
   * 回收一个浮层的渲染进程（销毁视图与 webContents）。**只有它没在被用时才动手。**
   *
   * 闸门缺一不可（任何一条成立都说明"它正在被用"）：
   *   · **占着屏幕**（真实 bounds 非零）—— 用户正看着它，拆掉就是当场白屏；
   *   · 逻辑可见 —— 显示途中（noteFloatShow 已置位，bounds 还没量出来）；
   *   · 交互态   —— 指针 / 键盘正落在它上面；
   *   · 退场中   —— 动效还没播完，此时拆视图会留下僵尸 bounds；
   *   · 正被让开 —— 指针避让登记中，它还要恢复显示；
   *   · 视图表里已无 —— 已被别处收掉（幂等）。
   *
   * ⚠ 前两条**必须都在**：只看逻辑态会漏掉"直接 setBounds 显示"的路径
   * （实测踩到过 —— 那种浮层会被当场收掉）；只看 bounds 则会漏掉"已请求显示、
   * renderer 还没回传矩形"的窗口期。
   *
   * 清理由本方法独占：它把**本层为这个浮层登记的每一项**都清掉，使状态回到
   * "从未创建过"。下次显示会自动走 `_ensureFloatView` 重建 —— 那边本来就是
   * 「表里没有就建」，因此回收**不需要**任何配套的状态恢复逻辑。
   *
   * @param {string} name
   * @returns {boolean} 是否真的回收了
   */
  _reclaimFloatView(name: string): boolean {
    const key = String(name)
    const view = this._floatViews.get(key)
    if (!view) return false
    if (this._isFloatOnScreen(key)) return false
    if (this.isFloatVisible(key)) return false
    if (this._floatInteractive.get(key) === true) return false
    if (this._floatExitPending.get(key)) return false
    if (this.isFloatPointerAvoided(key)) return false

    this._cancelFloatReclaim(key)
    // 图层先摘：LayerManager 会自动重排剩余图层的 z 序。
    this._dropLayerByView(view)
    this._floatViews.delete(key)
    // 本层为它登记的每一项都清掉（回到"从未创建"的样子）。
    this._floatBounds.delete(key)
    this._floatThrottled.delete(key)
    this._floatInteractive.delete(key)
    this._floatVisible.delete(key)
    this._floatSeq.delete(key)
    this._floatOpener.delete(key)
    this._floatFocusHolders.delete(key)
    // 指针避让登记也要摘：视图都没了，"它恢复显示"这件事已不存在，
    // 留着这条只会让避让轮询为一个不存在的浮层继续跑（宿主那边是 forget 得到的，
    // 但回收是主进程单方面的动作，不能指望宿主再发一次 forget）。
    this._pointerAvoid.clear(key)
    this._cancelFloatExit(key)
    this._lastBounds.delete(view)
    // 真正销毁渲染进程（WCM 侧同时清掉它的加载去重 Promise）。
    try {
      if (typeof this._wcm.destroyFloatView === 'function') this._wcm.destroyFloatView(key)
    } catch (e) {
      console.error(`[layout] destroyFloatView(${key}) failed:`, errorMessage(e))
    }
    return true
  }

  /**
   * **立即**回收全部当前不可见的浮层渲染进程（不看闲置 TTL）。
   *
   * 给内存压力回收用：浮层是纯 UI 壳，重建约 200ms；而休眠一个标签意味着
   * 用户切回去要**重新加载整个网页**。同样省下一份 renderer 进程，
   * 收浮层的代价小得多 —— 所以它应该是内存回收的**第一优先级**。
   *
   * 对没有浮层的窗口是零成本（空表遍历）。
   *
   * 返回**裸数组**（而不是 `{ reclaimed }` 包裹）：多窗口下由 `layoutFanout` 的
   * `unionMethods` 把各窗口的结果拼成一份，日志才看得到"这次一共收掉了哪些"。
   *
   * @returns {string[]} 被回收的浮层名（供日志观察）
   */
  reclaimIdleFloatViews() : string[] {
    const reclaimed = []
    // 快照 keys：回收过程中 `_floatViews` 会被改，不能边遍历边删。
    for (const key of Array.from(this._floatViews.keys())) {
      if (this._reclaimFloatView(key)) reclaimed.push(key)
    }
    return reclaimed
  }

  /**
   * 惰性创建密码浮层独立 view（幂等）。
   *
   * **对齐 RT：启动期绝不预热密码浮层 renderer。** 只有首次真正需要展示
   * （多凭据菜单 / 保存提示卡）时才建 view + 挂图层 + 后台加载内容。
   * 与其它浮层完全解耦：独立 WebContentsView、独立页面与 IPC 通道，
   * 图层压在所有浮层之上（最顶层）；默认 0x0 + ignoreMouseEvents，不拦截任何下层点击。
   * @returns {Electron.WebContentsView|null}
   */
  _ensurePasswordOverlay() : Electron.WebContentsView|null {
    const existing = this._passwordOverlayView
    if (existing) {
      try {
        if (!existing.webContents.isDestroyed()) return existing
      } catch (_) {}
      // renderer 崩溃后保留的视图外壳不能再复用：先摘图层并销毁，下面走同一条重建路径。
      this._dropLayerByView(existing)
      this._passwordOverlayView = null
      this._lastPasswordOverlayViewportKey = ''
      try {
        if (typeof this._wcm.destroyPasswordOverlay === 'function') this._wcm.destroyPasswordOverlay()
      } catch (_) {}
    }
    const view = this._wcm.createPasswordOverlay()
    this._passwordOverlayView = view
    const layer = this._pushLayer('password-overlay', view)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    layer.setVisible(false)
    // 内容惰性加载：视图建好后立刻后台载入 renderer，首次显示即就绪。
    if (typeof this._wcm.loadPasswordOverlay === 'function') {
      this._wcm.loadPasswordOverlay().catch((e: unknown) => console.error('[layout] loadPasswordOverlay failed:', errorMessage(e)))
    }
    // 新视图先按"闲置"计 —— 建出来但若一直没被显示过，也该在 PASSWORD_IDLE_RECLAIM_MS 后收回去。
    this._schedulePasswordReclaim()
    return view
  }

  // ── 密码浮层闲置回收（它此前只创建不销毁 —— 见 PASSWORD_IDLE_RECLAIM_MS）──
  //
  // 密码浮层不在 `_floatViews` 家族里（它有独立图层、独立的显隐通道），
  // 所以这里单独配一条腿，但结构与前两条（浮层 / 面板）刻意保持同构：
  // 收起才排、显示就撤、定时器按需启停、`unref`、`dispose` 清空。

  /** 排一次密码浮层的闲置回收（**幂等**）。只在视图存在时才排。 */
  _schedulePasswordReclaim() {
    if (this._passwordReclaimTimer) return
    if (!this._passwordOverlayView) return
    const timer = setTimeout(() => {
      this._passwordReclaimTimer = null
      try { this._reclaimPasswordOverlay() } catch (_) {}
    }, PASSWORD_IDLE_RECLAIM_MS)
    if (typeof timer.unref === 'function') timer.unref()
    this._passwordReclaimTimer = timer
  }

  /** 撤销密码浮层的闲置回收（**幂等**）。 */
  _cancelPasswordReclaim() {
    if (!this._passwordReclaimTimer) return
    clearTimeout(this._passwordReclaimTimer)
    this._passwordReclaimTimer = null
  }

  /**
   * **回收**密码浮层的渲染进程（销毁视图与 webContents）。只有它**当前不可见**才动手。
   *
   * 下次要用时 `_ensurePasswordOverlay` 会重建（连页面一起重新加载）——
   * 那条路本来就是"表里没有就建"，因此不需要任何配套的状态恢复逻辑。
   * 内存压力回收链也会直接调它（见 main 的 `memory.guard`）。
   *
   * @returns {boolean} 是否真的回收了
   */
  _reclaimPasswordOverlay() : boolean {
    const view = this._passwordOverlayView
    if (!view) return false
    // 闸门：正在显示就绝不收 —— 用户可能正点它（多凭据菜单 / 保存密码卡）。
    try {
      const b = view.getBounds()
      if (b && b.width > 0 && b.height > 0) return false
    } catch (_) {}
    const layer = this._getLayer('password-overlay')
    if (layer && typeof layer.isVisible === 'function' && layer.isVisible()) return false

    this._cancelPasswordReclaim()
    // 先摘图层再销毁：留着图层就是一条指向已销毁 webContents 的空壳。
    this._dropLayerByView(view)
    this._passwordOverlayView = null
    this._lastPasswordOverlayViewportKey = ''
    this._lastPasswordOverlayPlacement = null
    try {
      if (this._wcm && typeof this._wcm.destroyPasswordOverlay === 'function') {
        this._wcm.destroyPasswordOverlay()
      }
    } catch (e) {
      console.error('[layout] destroyPasswordOverlay failed:', errorMessage(e))
    }
    return true
  }

  /**
   * **对外**的密码浮层回收口（内存压力回收链用）。
   * 与 `reclaimIdleFloatViews` / `reclaimIdlePanelViews` 平级。
   * @returns {boolean} 是否真的回收了
   */
  reclaimPasswordOverlay() : boolean {
    return this._reclaimPasswordOverlay()
  }

  /**
   * 向密码浮层 renderer 发送事件。浮层尚未创建时**先惰性创建**，并等待 renderer
   * 就绪（did-finish-load）后再发送 —— 避免「首个 show 事件打在空白 renderer 上丢失」。
   * @param {string} channel IPC 事件通道
   * @param {unknown} payload
   */
  async sendToPasswordOverlay(channel: string, payload: unknown): Promise<boolean> {
    // 这次 send 就是"马上要用"的明确意图。先撤销闲置回收，避免加载中的视图
    // 恰好在 bounds 落地前被回收，表现为保存 / 解锁卡永远不出现。
    this._cancelPasswordReclaim()
    const view = this._ensurePasswordOverlay()
    if (!view) return false
    const wc = view.webContents
    if (!wc || wc.isDestroyed()) return false
    try {
      if (typeof this._wcm.loadPasswordOverlay === 'function') await this._wcm.loadPasswordOverlay()
    } catch (_) {
      return false
    }
    if (wc.isDestroyed()) return false
    try {
      wc.send(channel, payload)
      return true
    } catch (_) {
      return false
    }
  }

  /** 只在密码浮层可见时同步网页矩形；相同几何不重复发 IPC。 */
  private _syncPasswordOverlayViewport(): void {
    const view = this._passwordOverlayView
    if (!view || view.webContents.isDestroyed()) return
    try {
      const own = view.getBounds()
      if (!own || own.width <= 0 || own.height <= 0) return
    } catch (_) {
      return
    }
    const viewport = this.getActiveTabViewBounds()
    if (!viewport) return
    if (this._lastPasswordOverlayPlacement) {
      this.anchorPasswordOverlayInContent(this._lastPasswordOverlayPlacement)
    }
    const key = `${viewport.x}:${viewport.y}:${viewport.width}:${viewport.height}`
    if (key === this._lastPasswordOverlayViewportKey) return
    this._lastPasswordOverlayViewportKey = key
    try {
      view.webContents.send(IPC_EVENTS.overlayPasswordViewport, viewport)
    } catch (_) {}
  }

  attachRail() {
    const view = this._wcm.createRail()
    this._railView = view
    // 图标条不要键盘：点它 / 窗口回归时它若抢到焦点，一律原路送回内容面。
    this.registerChromeFocusSink(view.webContents)
    this._pushLayer('rail', view)
    this._syncRailLayerVisibility()
    this.applyInitialLayout()
  }

  /**
   * 全量重排布局（页面 / 面板 / rail / 各图层 + 标签 bounds）。
   *
   * 标签 bounds 默认走缓动（切侧栏等结构性变化平滑过渡）；
   * `opts.immediate === true`（窗口 resize、面板拖拽、全屏进出）直接落位，逐帧跟手。
   * **面板打开 / 关闭走缓动**（网页平滑让位），同侧换面板因槽宽不变而不产生动画 ——
   * 见 `_tabTween` 的说明。
   * @param {{immediate?: boolean}} [opts]
   */
  applyInitialLayout(opts: ApplyLayoutOptions = {}) {
    const [w, h] = this._win.getContentSize()
    if (!w || !h) {
      // 启动期 / 最小化段内容尺寸为 0：有限重试（LAYOUT_RETRY_MAX 拍 ≈640ms），
      // 尺寸恢复由 win 的 resize 监听重新驱动 —— 不需要无上限空转。
      if (!this._win.isDestroyed() && this._layoutRetryCount < LAYOUT_RETRY_MAX) {
        this._layoutRetryCount++
        this._layoutRetryTimer = setTimeout(() => {
          this._layoutRetryTimer = null
          try { this.applyInitialLayout() } catch (_) {}
        }, LAYOUT_RETRY_MS)
      }
      return
    }
    this._layoutRetryCount = 0
    const bounds = { width: Math.round(w), height: Math.round(h) }
    const params = this._pageLayoutParams
    // 贴边模式（真实全屏）：四边内缩与圆角一起归零，网页铺满整窗。判据只此一处。
    const edgeToEdge = this._isEdgeToEdge()
    /**
     * chrome（顶栏 / 侧栏 / rail / 底部栏）此刻是否**整体收起** —— 全屏与沉浸模式共用
     * 这一条判据（见 #_chromeHidden 的说明）。下面所有"要不要让位"的决定都改吃它。
     */
    const chromeHidden = this._chromeHidden()
    /**
     * 收起态下的**贴边唤出**：为真时整套界面一起回来。任一条边缘都能触发（见 _tickImmersive）。
     */
    const revealed = chromeHidden && this._immersiveRevealed
    const topbarVisible = this._editingPresentation
      ? true
      : (chromeHidden ? revealed : params.topbarVisible !== false)
    const sidebarVisible = this._editingPresentation
      ? (this._railPinned || this._railRevealed)
      : ((revealed || !chromeHidden) && (this._railPinned || this._railRevealed || revealed))
    // 顶栏占高由渲染层按容器实测上报，**如实采信**：布局现在可以把四块全摆到底部，
    // 此时 0 是合法值。以前这里写死 `Math.max(40, …)` 兜底（当时顶栏必然存在），
    // 在「顶部一块都没有」的布局下会凭空多出 40px 顶部空白，把网页往下挤。
    const reportedTopbar = Math.round(params.topbarHeight) || 0
    const topbarHeight = topbarVisible
      ? Math.min(Math.max(0, reportedTopbar), bounds.height)
      : (edgeToEdge ? 0 : Math.max(0, this._contentPadding))
    const sidebarWidth = sidebarVisible
      ? Math.max(0, Math.round(params.sidebarWidth))
      : 0
    /**
     * rail 的轴向由**位置**唯一决定：左右 = 纵向列（占宽），上下 = 横向条（占高）。
     *
     * 横向条不再参与左右 lane，而是像顶栏/底栏那样在纵向让位：`railTopBand` /
     * `railBottomBand` 同时进入网页内缩与面板高度 —— 面板永远与 rail 不重叠。
     * 这里只算一次，后面 lane / rail bounds / 面板 / 拖拽带全部复用，绝不再各自算。
     */
    const railPosition = this._railPosition
    const railHorizontal = isHorizontalRailPosition(railPosition)
    // 横向带高 = 图标条自身厚度（RAIL_BAR_SIZE），**不是** sidebarWidth：
    // sidebarWidth 是纵向 lane 的占宽口径（48，含与网页之间的呼吸空）。照抄它的话，
    // 那条带比组件里的图标条（44）多出 4px，而图标条钉在带的一头 —— 多出来的部分
    // 全落在另一头，上下留白既不对称又明显偏多（用户口径："上下空白边距过多，
    // 而左右就很完美"）。纵向保持原值不动。
    const railTopBand = railHorizontal && sidebarVisible && railPosition === 'top' ? RAIL_BAR_SIZE : 0
    const railBottomBand = railHorizontal && sidebarVisible && railPosition === 'bottom' ? RAIL_BAR_SIZE : 0
    const railVerticalSpace = railTopBand + railBottomBand
    /**
     * 侧栏区（垂直标签栏 / 未来任何住侧栏的块）的占宽。
     *
     * 它是**纵向轨道上最靠外**的一段，与 rail 同侧相邻：
     *   外侧 → 内侧 = [侧栏区][rail][面板][网页]
     * 于是它要同时做两件事：把网页内缩（leftBlocks/rightBlocks），
     * 以及把 rail 的 x 往里推（railX）—— 后者不做的话 rail（z 高于 chrome 本体）
     * 会直接压在侧栏上。
     *
     * 注意它**不跟随 rail 的收起状态**（两者是独立区块：收起 rail 不该让标签消失），
     * 只跟随全屏（全屏时 chrome 整体隐藏）。
     */
    const sideColumnWidth = (chromeHidden && !revealed)
      ? 0
      : getSideColumnWidth(params, revealed || this._sideRevealed)
    const sideGone = chromeHidden && !revealed
    // 面板：左右两个位各自占宽（每个位记着自己的宽度，互不干扰）
    // 收起态下它们跟随**贴边唤出**一起回来（"全都一起展开"= 侧栏区 + rail + 面板）。
    const leftPanelId = this._panelSlots.left
    const rightPanelId = this._panelSlots.right
    /* 钉住位：与普通位**各自独立**（宽度各记各的、可同时存在）。 */
    const leftPinnedId = this._panelPinned.left
    const rightPinnedId = this._panelPinned.right
    const leftPanelWidth = leftPanelId && !sideGone ? this._panelWidths.left : 0
    const rightPanelWidth = rightPanelId && !sideGone ? this._panelWidths.right : 0
    const leftPinnedWidth = leftPinnedId && !sideGone ? this._pinnedWidths.left : 0
    const rightPinnedWidth = rightPinnedId && !sideGone ? this._pinnedWidths.right : 0
    // 顶栏占高 + 顶栏与页面之间的那一道边距空隙：空隙归页面（四边框的一部分），
    // 于是书签栏 / 工具栏都落在空隙之外。顶栏不可见时 topbarHeight 本身就已经是
    // 那份空隙（见上），不再叠加，避免出现双层留白。
    // 贴边模式（全屏）下四边内缩一律为 0：内容独占整窗，不留底色缝（圆角同步归零，见 _pageRadius）。
    const padTop = topbarHeight
      + railTopBand
      + Math.max(0, Number(params.contentTopOffset) || 0)
      + (!edgeToEdge && topbarVisible ? Math.max(0, this._contentInsetTop) : 0)
    // 底部工具栏（底部布局）：chrome 收起且没被唤出时不占位（"全都一起展开"时它一起回来）。
    const bottombarHeight = sideGone
      ? 0
      : Math.min(Math.max(0, Math.round(params.bottombarHeight || 0)), Math.max(0, bounds.height - topbarHeight))
    const padLeft = edgeToEdge ? 0 : Math.max(0, this._contentInsetLeft)
    const padRight = edgeToEdge ? 0 : Math.max(0, this._contentInsetRight)
    // 底部横向 rail 同样占一条纵向带（落在底栏之上、面板/网页之下）。
    const padBottom = (edgeToEdge ? 0 : Math.max(0, this._contentInsetBottom)) + railBottomBand
    const side = params.sidebarSide === 'right' ? 'right' : 'left'
    // 侧栏区自己那一侧（null = 跟随 rail，历史行为）。两段可以分居两侧 ——
    // 见文件头的轨道说明与 _sideColumnSide。
    const columnSide = this._resolvedSideColumnSide()
    // rail 贴边唤出：仅「rail 未固定 + 用户边缘唤出」时生效。
    // 与全功能侧栏的占位型自动隐藏一致：唤出时把 rail 自身宽度计入轨道，
    // 网页真实让位；静止时该宽度为 0。
    // chrome 收起（全屏 / 沉浸）时会随整套界面一起唤回（见 _tickImmersive）。
    // 横向 rail 没有对应的左右贴边唤出几何。
    // 收起即收起，内容立即回收那条纵向带。
    const revealedRail = !this._railPinned && this._railRevealed
    const railEffectiveWidth = revealedRail
      ? Math.max(RAIL_COLLAPSED_WIDTH, this._railWidth)
      : sidebarWidth
    // rail 视图在**短边**上的厚度（纵向列 = 宽，横向条 = 高）：横向必须与带高同源
    // （RAIL_BAR_SIZE），否则视图比带高多一条，组件又被钉在视图的一头，留白就偏一侧。
    const railCrossSize = railHorizontal ? RAIL_BAR_SIZE : railEffectiveWidth
    // 每侧由外到内的占位：**[侧栏区] → [rail] → [面板]**（面板最靠内、紧邻网页）。
    // 两段各有自己的侧，故左右各自累加 —— 同侧时退化成原来的 laneWidth。
    // 横向 rail 不占左右 lane（它占的是上下带），纵向常驻与贴边唤出都占宽。
    const railLaneWidth = railHorizontal ? 0 : railEffectiveWidth
    const leftLane = (columnSide === 'left' ? sideColumnWidth : 0) + (side === 'left' ? railLaneWidth : 0)
    const rightLane = (columnSide === 'right' ? sideColumnWidth : 0) + (side === 'right' ? railLaneWidth : 0)
    // 钉住位排在**普通位的内侧**（更靠网页）：外侧 → 内侧 = [lane][普通][钉住][网页]。
    const leftBlocks = leftLane + leftPanelWidth + leftPinnedWidth
    const rightBlocks = rightLane + rightPanelWidth + rightPinnedWidth
    /**
     * rail 落位：纵向列贴自己那一侧（侧栏区之外）；横向条贴顶 / 贴底，
     * 左右让开侧栏区那一列（它有整窗高度，rail 不能压在它上面）。
     */
    const columnLeftWidth = columnSide === 'left' ? sideColumnWidth : 0
    const columnRightWidth = columnSide === 'right' ? sideColumnWidth : 0
    const railX = railHorizontal
      ? columnLeftWidth
      : (side === 'right'
        ? bounds.width - columnRightWidth - railCrossSize
        : columnLeftWidth)
    const railY = railHorizontal
      ? (railPosition === 'top'
        ? topbarHeight
        : Math.max(topbarHeight, bounds.height - bottombarHeight - railCrossSize))
      : topbarHeight
    const railWidth = railHorizontal
      ? Math.max(0, bounds.width - columnLeftWidth - columnRightWidth)
      : railCrossSize
    const railHeight = railHorizontal
      ? railCrossSize
      : Math.max(0, bounds.height - topbarHeight - bottombarHeight)
    // 面板是最靠内的一段：它自己那一侧的外侧占位之和，就是它的起点。
    const leftPanelX = leftLane
    const rightPanelX = bounds.width - rightLane - rightPanelWidth
    /**
     * 独立侧栏（Web Sidebar）—— 轨道上**最靠内**的一段：紧邻网页、排在面板内侧。
     * 与面板各占各的宽度，**可同时存在**（共存就是"两者宽度相加"这么自然）。
     * chrome 收起（全屏 / 沉浸未唤出）时与其它段一起让位（见 sideGone）。
     */
    const wsSide = this.getWebSidebarSide()
    const wsWidth = (this._webSidebar.visible && !sideGone)
      ? Math.max(0, Math.round(this._webSidebar.width))
      : 0
    const leftWebSidebarX = leftLane + leftPanelWidth + leftPinnedWidth
    const rightWebSidebarX = bounds.width - rightLane - rightPanelWidth - rightPinnedWidth - wsWidth
    const contentX = leftBlocks + (wsSide === 'left' ? wsWidth : 0)
    const contentWidth = Math.max(0, bounds.width - leftBlocks - rightBlocks - wsWidth)
    // 网页 bounds：普通 / 沉浸模式四边内缩（chrome 收起时 topbarHeight 本身就是那点内边距，
    // "收起"只是界面走开，呼吸空与圆角都在）；全屏贴边模式 pad* 全为 0，网页铺满整窗。
    const pageBounds = {
          x: Math.round(contentX + padLeft),
          y: Math.round(padTop),
          width: Math.max(0, Math.round(contentWidth - padLeft - padRight)),
          height: Math.max(0, Math.round(bounds.height - padTop - bottombarHeight - padBottom))
        }

    // chrome（窗口本体）不在此布局：它天然铺满窗口且位于所有子视图之下。
    // 仅布局 contentView 内的子视图：tab 容器 / rail / panel / 浮层。

    // tab 图层容器始终铺满窗口：标签 bounds 是窗口绝对坐标，相对该容器就是同一套数值
    if (this._tabLayer) {
      this._setBoundsIfChanged(this._tabLayer, { x: 0, y: 0, width: bounds.width, height: bounds.height })
    }

    // rail 是否在场（贴边唤出态也算）。拖拽带与下面那段落位共用这一条。
    const railShown = revealedRail || sidebarVisible
    if (this._railView) {
      // 挂载一次、只切可见性（Layer.setVisible 自带变化检测）：
      // rail 的 webContents 既不会 WasHidden/WasShown，也不会被反复 addChildView。
      const railLayer = this._getLayer('rail')
      if (railLayer) railLayer.setVisible(railShown)
      else { try { this._railView.setVisible(railShown) } catch (_) {} }
      this._setBoundsIfChanged(this._railView, railShown
        ? { x: railX, y: railY, width: railWidth, height: railHeight }
        : { x: 0, y: 0, width: 0, height: 0 }
      )
    }

    // 两个面板位各自落位：只重排真正在显示的那一个，另一个不动（免得白改一次 bounds）
    // 侧缘唤出时它们跟着回来（见 sideGone）。
    // 槽矩形是**不含呼吸空**的那块（呼吸空 + 圆角由 _placePanelSlot 按"与网页同源"加）。
    // 面板与 rail **互不重叠**：顶部横向 rail → 面板从 rail 下沿开始；
    // 底部横向 rail → 面板到 rail 上沿为止（`railVerticalSpace` 扣掉那一条带）。
    const panelTop = sideGone ? 0 : topbarHeight + railTopBand
    const panelHeight = sideGone
      ? 0
      : Math.max(0, bounds.height - topbarHeight - bottombarHeight - railVerticalSpace)
    if (leftPanelId) {
      this._placePanelSlot(leftPanelId, { x: leftPanelX, y: panelTop, width: leftPanelWidth, height: panelHeight }, 'left')
    }
    if (rightPanelId) {
      this._placePanelSlot(rightPanelId, { x: rightPanelX, y: panelTop, width: rightPanelWidth, height: panelHeight }, 'right')
    }
    // 钉住位 = 紧贴普通位**内侧**的那一格。它自己的"外侧"(即与普通位相邻的那条边)
    // 由 `_placePanelSlot` 按侧别让出 `_contentInset*`，于是两块面板之间正好留出
    // 与网页同源的一道 4px 缝；普通位不存在时，这道缝退化成它与 rail/lane 的呼吸空。
    if (leftPinnedId) {
      this._placePanelSlot(leftPinnedId, {
        x: leftPanelX + leftPanelWidth,
        y: panelTop,
        width: leftPinnedWidth,
        height: panelHeight
      }, 'left')
    }
    if (rightPinnedId) {
      this._placePanelSlot(rightPinnedId, {
        x: rightPanelX - rightPinnedWidth,
        y: panelTop,
        width: rightPinnedWidth,
        height: panelHeight
      }, 'right')
    }

    /**
     * chrome 拖拽带（见 `_chromeDragBands` 的文件头）。
     *
     * 与上面几段落位**同一趟、同一批局部变量**：凡是在这个函数里再算一遍轨道算术，
     * 迟早与真实落位漂移（那正是「浮层明明盖住标题栏、点击却还是拖窗口」的成因）。
     * 面板/rail 收起时宽高为 0 → 自然不入表（没有声明 drag 的视图）。
     */
    this._chromeDragBands = [
      // 顶栏带：navbar / tabbar / titlebar / 书签栏（四块都只可能住顶栏）
      ...(topbarVisible && topbarHeight > 0
        ? [{ x: 0, y: 0, width: bounds.width, height: topbarHeight }]
        : []),
      // 底栏带：住在底部的那几块
      ...(bottombarHeight > 0
        ? [{ x: 0, y: bounds.height - bottombarHeight, width: bounds.width, height: bottombarHeight }]
        : []),
      // rail 带：图标之间的空白（.hira-rail-spacer）声明 drag。
      // 纵向 = 一整列；横向 = 顶 / 底那条整行（几何与 rail bounds 同源）。
      ...(railShown && railCrossSize > 0
        ? [{ x: railX, y: railY, width: railWidth, height: railHeight }]
        : []),
      // 面板列：面板标题栏声明 drag（整列都算 —— 只压到内容区也让它让位，多让一次无感）
      ...(leftPanelId && leftPanelWidth > 0
        ? [{ x: leftPanelX, y: panelTop, width: leftPanelWidth, height: panelHeight }]
        : []),
      ...(rightPanelId && rightPanelWidth > 0
        ? [{ x: rightPanelX, y: panelTop, width: rightPanelWidth, height: panelHeight }]
        : []),
      // 钉住面板列：它同样是面板（标题栏拖拽），整列都算。
      ...(leftPinnedId && leftPinnedWidth > 0
        ? [{
            x: leftPanelX + leftPanelWidth,
            y: panelTop,
            width: leftPinnedWidth,
            height: panelHeight
          }]
        : []),
      ...(rightPinnedId && rightPinnedWidth > 0
        ? [{
            x: rightPanelX - rightPinnedWidth,
            y: panelTop,
            width: rightPinnedWidth,
            height: panelHeight
          }]
        : [])
    ]

    // 独立侧栏：显示时占位；收起 / 全屏时连它的两份视图一并收起来
    // （`_placeWebSidebar(null)` = 只切 setVisible，不重排、不销毁 —— 再次打开无需重建，
    //  页面状态与滚动位置都还在）。
    // 两侧槽矩形都留一份：拖动换边的落位预览要画在"松手后它真会去的地方"，
    // 复刻轨道算术必然漂移 —— 留两份才能让预览与落点**同源**（见 `_webSidebarSlotBySide`）。
    const wsSlotParts = { y: panelTop, width: wsWidth, height: panelHeight }
    this._webSidebarSlotBySide = wsWidth > 0
      ? {
          left: { x: leftWebSidebarX, ...wsSlotParts },
          right: { x: rightWebSidebarX, ...wsSlotParts }
        }
      : null
    if (wsWidth > 0) {
      this._placeWebSidebar(
        { x: wsSide === 'left' ? leftWebSidebarX : rightWebSidebarX, ...wsSlotParts },
        /**
         * 侧栏内容四周的**呼吸空** —— 与主视图网页**同一份**（用户要求"侧栏的网页也要
         * 和主视图一样有圆角、边距对齐主视图"）。
         *
         * 顶部只补**差额**：槽的 y 已经是 `panelTop`（顶栏之下），而主视图的 `padTop`
         * 还额外含 `contentTopOffset + _contentInsetTop` 那一段 —— 补这一差，侧栏里的网页
         * 才与主视图的网页**同一水平线**。
         */
        {
          left: padLeft,
          right: padRight,
          bottom: padBottom,
          top: Math.max(0, padTop - topbarHeight)
        }
      )
    } else if (this._webSidebarParts) {
      this._placeWebSidebar(null)
    }

    // 缓存 pageBounds，供 showTab 直接使用（切换 tab 时无需重算全量布局）
    this._lastPageBounds = pageBounds
    /**
     * 侧栏调宽把手的矩形 —— **只能在这里算**。
     *
     * 它要"侧栏槽"（`_placeWebSidebar` 在本趟早段写）与"网页"（上一行的 `pageBounds`）
     * 这两个矩形**同一趟**的值。此前它在 `getWebSidebarFrameGeometry()` 里现算，
     * 而那条链是**从 `_placeWebSidebar` 末尾推出去的** —— 早于 `pageBounds` 的赋值，
     * 于是它读到的是**上一趟**的网页矩形：侧栏刚打开那一趟，上一趟的网页还是"没有侧栏"
     * 的满宽矩形 → 算出来的把手横跨大半个侧栏、压在侧栏自己的网页视图底下（用户看到的就是
     * "宽度调节被网页视图遮挡"）。
     */
    this._webSidebarHandleRect = this._webSidebarResizeHandleRect(pageBounds)

    if (this._activeGlance && this._activeGlance.members.length === 2) {
      // 速览：内容区叠放两张卡（front 略小压在后页之上）。与分屏互斥，优先于分屏判定。
      this._lastSplitSolved = null
      this._placeGlanceCards(pageBounds)
    } else if (this._activeSplit && this._activeSplit.members.length >= 2) {
      // 分屏：内容区被切成 N 格。切分是**内容区内部**的事 —— 上面那些外壳算术
      // （顶/底栏、侧栏区、rail、面板）一行都不动，`pageBounds` 怎么变分屏都跟着变。
      this._placeSplitPanes(pageBounds)
    } else if (this._activeTabId) {
      // 退出分屏：这里只负责把**活动格铺满**整块内容区（以及清掉求解结果，分隔条由末尾的
      // `_pushSplitGeometry()` 以 `{active:false}` 统一下发）。
      // ⚠ 其余格的**视图收起**不在这里做 —— 那是"集合差"的事，收口在
      // `_exitSplitToSingleView`（只在真正退出分屏那一刻跑一次，见 `setActiveSplit`）。
      // 放在这里等于每次全量布局都做一遍（resize / 面板开关都会走到），白付原生往返。
      this._lastSplitSolved = null
      const tabView = this._wcm.getTab(this._activeTabId)
      if (tabView) {
        const next = {
          x: pageBounds.x,
          y: pageBounds.y,
          width: pageBounds.width,
          height: pageBounds.height
        }
        const previous = this._tabBounds
        // view 换人（首次布局 / 切标签 / sleep-wake 重建）→ 动画状态整体复位并**立即**落位：
        // 否则新 view 会因「目标 bounds 与上次相同」被去重跳过，拿不到任何 bounds。
        const viewChanged = this._tabBoundView !== tabView
        const boundsChanged = !previous || !LayoutCoordinator._boundsEqual(previous, next)
        this._tabBounds = next
        this._tabBoundView = tabView
        if (viewChanged) {
          this._tabTween.resetLastAppliedBounds()
          this._tabTween.setBoundsImmediate(next)
        } else if (boundsChanged || opts.immediate === true) {
          this._tabTween.setBounds(next, opts.immediate === true || LayoutCoordinator._prefersReducedNativeMotion())
        }
        // 圆角跟随贴边模式：全屏 0、其余主题圆角（见 _pageRadius）。
        this._setRadiusIfChanged(tabView, this._pageRadius())
      }
    } else {
      // 既没有分屏也没有活动标签：同样只清求解结果（分隔条由 `_pushSplitGeometry()` 收起）。
      this._lastSplitSolved = null
    }

    // 收敛点收尾：chrome 收起（全屏 / 沉浸）时把"贴边唤出"的指针巡看接上/断开。
    // 放在**末尾**：它可能在退出收起态时清掉 rail 唤出状态，而那要再排一次布局 ——
    // 放在中途会与正在跑的这一趟抢同一个收敛点（外层算出的 revealedRail 会覆盖内层结果）。
    this._syncImmersiveWatch()
    this._syncChromeDragSuppressed()
    // 侧栏「悬停唤出」的指针巡看：同一条收敛点收尾（形态关掉 / chrome 收起时它会自己停表）。
    this._syncSideRevealWatch()
    this._syncRailRevealWatch()
    /**
     * 浮层型唤出的"第二条腿"：与上面同一份 `_sideRevealed`，但落点是**独立浮层**
     * （流水线见 `_syncSideOverlayFloat`）。几何用本趟算好的那几段（与 rail 落位同源）。
     * 放在巡看之后：巡看可能在这一拍把 `_sideRevealed` 收敛掉（形态关掉 / chrome 收起），
     * 那时这里读到的就是收敛后的值 —— 浮层与 chrome 侧栏不会一开一合地打架。
     */
    this._syncSideOverlayFloat({ bounds, topbarHeight, bottombarHeight, columnSide, sideGone })
    // 拖拽带刚换过（面板开关 / 全屏 / 换边都会改它）→ 重判「已有浮层是否压上来了」。
    // 不放在 setFloatBounds 里就够：几何变了但浮层矩形没变时，那条路径压根不会触发。
    this._syncFloatDragGuard()

    // 分屏几何随这次全量重排一起变（窗口 resize / 面板开关 / 侧栏切换都会走到这里）——
    // 把它推给外壳 renderer，让分隔条跟着新的格矩形走。
    this._pushSplitGeometry()

    /**
     * 侧栏聚焦框 / 调宽把手同样在**这一趟几何都齐了之后**再推。
     *
     * 以前这一推挂在 `_placeWebSidebar` 末尾 —— 那时候 `pageBounds` 还没算出来，
     * 把手就会拿到上一趟的网页矩形（见上面 `_webSidebarHandleRect` 的说明）。
     * 现在它与 `_pushSplitGeometry()` 并列收在末尾：两个几何推送**同一个发送时机**，
     * 不存在"一个早一个晚"这类只在首次布局暴露的坑。
     */
    this._pushWebSidebarFrame()
    // 密码浮层的锚点是“活动网页”，不是窗口。窗口缩放 / 面板开关 / 分屏变化
    // 都在本收敛点之后把新矩形推给浮层，由它按当前卡片实测尺寸重新钳位。
    this._syncPasswordOverlayViewport()
  }

  // ═══════════════════════════════════════════════════════════════════
  //  分屏（Split View）
  //
  //  本类只做两件事：① 把 TabManager 灌进来的分屏状态**记下来**；
  //  ② 按共享求解器把内容区切成 N 格并逐格落 bounds。
  //  **不认识 domain、不查库、不认识标签业务** —— 切分是纯几何（见 split-layout.mjs）。
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 灌入当前活动的分屏组。传 null / 成员 <2 = 退出分屏（回落单视图）。
   *
   * ⚠ 退出分屏必须**同时收掉非活动格的视图**（见 `_exitSplitToSingleView`）——
   * `applyInitialLayout` 的单视图分支只把活动格铺满，它不知道屏幕上还挂着谁。
   *
   * @param {{ splitId:string, members:string[], layout?:string, ratios?:number[], activeTabId?:string|null }|null} split
   * @returns {object|null} 归一化后的当前分屏状态
   */
  setActiveSplit(split: ActiveSplitState | null) : object|null {
    const members = split && Array.isArray(split.members) ? split.members.map(String) : []
    /** 这一趟是不是**真的从分屏退出**（而不是"本来就不在分屏"）—— 决定要不要收格子。 */
    const wasSplit = !!(this._activeSplit && this._activeSplit.members.length >= 2)
    if (!split || members.length < 2) {
      this._activeSplit = null
      this._lastSplitSolved = null
      // 只在**真的发生退出**时收一次：普通切标签也会走到这里（`_showTab` → 本方法），
      // 那种情况下"收格子"是白做（`showTab` 紧接着自己会收），不该多加一次原生可见性往返。
      if (wasSplit) this._exitSplitToSingleView()
    } else {
      const prev = this._activeSplit
      const next = {
        splitId: String(split.splitId || ''),
        members,
        layout: split.layout,
        ratios: Array.isArray(split.ratios) ? split.ratios.slice() : [],
        activeTabId: split.activeTabId == null ? members[0] : String(split.activeTabId)
      }
      this._activeSplit = next
      /**
       * **同一组、只是换了活动格 → 不重跑整套布局。**
       *
       * 为什么可以省：`TabManager#_showTab` 的固定顺序是
       * `_syncActiveSplit(id)` → `layout.showTab(id)`，而后者在分屏分支里**自己就会**
       * 做"切可见性 + 摆格 + 推几何"那一趟。于是当"组长 / 成员 / 形态 / 比例"都没变、
       * 变的只是活动格时，这里那趟 `applyInitialLayout()`（rail + 面板 + 标签层的全套
       * bounds、一次分屏求解、两次几何下发）是**纯重复**。
       *
       * 这与上面「退出方向」那条口径完全同源（`_showTab` 紧随其后会收格子，所以不在这里多收
       * 一次）—— 只是这次省在**进入 / 同组切换**方向。分屏里点另一格是最热的操作之一，
       * 每次省掉一整趟全量重排。
       *
       * 仍然补一次**只切可见性**：万一某个调用方（例如"把焦点移到下一格"）后面并不走
       * `showTab`，被聚焦的那一格也必须是可见的。这一步极便宜、幂等，且**不动任何几何**。
       */
      const sameGroup = !!prev
        && prev.splitId === next.splitId
        && prev.layout === next.layout
        && prev.members.join('\u0000') === members.join('\u0000')
        && prev.ratios.join(',') === next.ratios.join(',')
      if (sameGroup) {
        this._setVisibleTabs(members, next.activeTabId)
        return this.getActiveSplit()
      }
    }
    this.applyInitialLayout()
    return this.getActiveSplit()
  }

  /**
   * 退出分屏 → 回落单视图：**收起非活动格 + 作废几何去重缓存**。
   *
   * 为什么必须有这一步（这是"收拢为标签组后彻底崩坏"的真因，两半缺一不可）：
   *
   * ① **收格子**：分屏把可见集合从 1 个变成 N 个，"收起来"是集合差的事 ——
   *    `applyInitialLayout` 的单视图分支只把活动格铺满，它不知道屏幕上还挂着谁。少了这一步，
   *    被解散的那一格会**留在原来的半屏矩形里继续可见**：它盖在新页面之上，又已经不属于
   *    任何活动分屏 —— 点它不会切标签（`tabEvents` 的「点哪格切哪格」要求它属于活动组），
   *    表现就是"焦点切不动 + 画面糊成一片"。
   *
   * ② **作废去重缓存**：`_tabBounds / _tabBoundView` 是"单视图几何"的记账，而分屏的格矩形
   *    是 `_placeSplitPanes` 直接落的、**不经过它**（见 §"格矩形刻意不走 _tabTween"）。
   *    于是退出时这两个缓存仍停在"进分屏之前那一份"，与新的满屏矩形**恰好相等** →
   *    `applyInitialLayout` 的单视图分支判定"没变化"而**跳过 setBounds** →
   *    活动格卡在半屏矩形里不动。作废缓存即让那一步必然重排（并按既有口径立即落位）。
   *
   * 只在**发生退出**的那一刻跑（不是每次布局），所以没有热路径开销。
   */
  _exitSplitToSingleView() {
    // ② 几何去重缓存作废（与 `showTab` 进/出分屏那一对重置同一口径）
    this._tabBounds = null
    this._tabBoundView = null
    /**
     * ★ 还必须作废**按 view 的那份**去重缓存 `_lastBounds`（`_setBoundsIfChanged` 用的）。
     *
     * 为什么二者都要：退出分屏时活动格是经 `_tabTween` 拉成满屏的，而**那条路不写
     * `_lastBounds`** —— 于是缓存里仍留着"它当初那一格半屏矩形"。等用户再切回分屏标签、
     * `_placeSplitPanes` 想把它摆回同一个半屏矩形时，`_setBoundsIfChanged` 拿缓存一比
     * "没变化" → **跳过 setBounds** → 活动格停在满屏、盖住另一格。
     *
     * 而分屏状态本身没丢（`_activeSplit` / `_lastSplitSolved` 都还在 → 工具条照常显示），
     * 所以用户看到的是"**切走再切回后只剩一个满屏视图**，点工具条任一按钮又好了"
     * （按钮改了 members/layout → 格矩形变新 → 不再命中缓存 → 真正 setBounds）。
     *
     * 覆盖此刻可见的全部成员（= 分屏的格子集合）：非活动格虽被隐藏、矩形没变，
     * 但"缓存与原生实际一致"这件事不该靠推断去赌。
     */
    for (const tabId of Array.from(this._visibleTabIds)) {
      const v = this._wcm.getTab(tabId)
      if (v) this._lastBounds.delete(v)
    }

    // ① 只留活动格
    const active = String(this._activeTabId || '')
    const view = active ? this._wcm.getTab(active) : null
    if (view) {
      // 活动格有视图 → 直接走集合差那条唯一实现（它同时负责 setVisible 与 `_visibleTabIds` 记账）
      this._setVisibleTabs([active], active)
      return
    }
    // 活动格暂时没有视图（休眠 / 正在重建）→ 至少把别的格收干净，绝不留残影
    for (const tabId of Array.from(this._visibleTabIds)) {
      const v = this._wcm.getTab(tabId)
      if (v) { try { v.setVisible(false) } catch (_) {} }
    }
    this._visibleTabIds.clear()
    this._visibleTabView = null
  }

  /** 退出分屏（回落单视图）。 */
  clearActiveSplit() {
    return this.setActiveSplit(null)
  }

  /** 当前分屏状态的安全副本（null = 不在分屏里）。 */
  getActiveSplit() {
    const s = this._activeSplit
    return s ? { ...s, members: s.members.slice(), ratios: s.ratios.slice() } : null
  }

  /**
   * 当前「正在被用户操作的网页矩形」——**分屏时是活动格**，否则整块内容区。
   *
   * 这是所有"贴网页"的浮层（查找栏 / 缩放条 / 悬停 URL）与坐标换算的**唯一判据**：
   * 分屏后如果还按整块内容区锚定，查找栏会横跨两格居中 —— 用户看到的是"查找栏跑到
   * 两个网页中间去了"。收口在这里，二十个调用点一行都不用改。
   */
  _activePaneBounds() {
    // 速览：贴网页的浮层（查找栏 / 缩放条 / 悬停 URL）锚到**前台大卡**矩形上。
    const glance = this._activeGlance
    if (glance && glance.members.length === 2 && this._lastGlanceSolved) {
      const declaredFront = glance.frontTabId == null ? '' : String(glance.frontTabId)
      const frontId = glance.members.includes(declaredFront) ? declaredFront : String(glance.members[1] || '')
      const isFrontActive = String(this._activeTabId) === String(frontId)
      const card = isFrontActive ? this._lastGlanceSolved.front : this._lastGlanceSolved.back
      if (card) return { x: card.x, y: card.y, width: card.width, height: card.height }
    }
    const split = this._activeSplit
    if (split && split.members.length >= 2 && this._lastSplitSolved) {
      const idx = split.members.indexOf(String(this._activeTabId))
      const pane = this._lastSplitSolved.panes[idx >= 0 ? idx : 0]
      if (pane) return { x: pane.x, y: pane.y, width: pane.width, height: pane.height }
    }
    return this._lastPageBounds || null
  }

  /**
   * 把内容区切成 N 格并逐格落 bounds（分屏路径）。
   *
   * 刻意**不走 `_tabTween`**：分屏的格矩形是"随手拖分隔条就变"的高频量，
   * 弹簧动画会让拖拽滞后于指针（不跟手），而结构变化（建/解散分屏）本身是瞬时的。
   * @param {{x:number,y:number,width:number,height:number}} pageBounds
   */
  _placeSplitPanes(pageBounds: Rectangle): void {
    const split = this._activeSplit
    if (!split) return
    const members = split.members
    const solved = solveSplitPanes({
      rect: pageBounds,
      layout: split.layout,
      ratios: split.ratios,
      count: members.length
    })
    this._lastSplitSolved = solved
    // 可见集合按**组**算：成员全部可见、其余收起。这一步同时负责把"上一轮的成员"
    // 收起来（用户可能刚把某一格移出组 / 关了某一个成员）。
    this._setVisibleTabs(members, split.activeTabId || members[0])
    for (let i = 0; i < members.length; i++) {
      const view = this._wcm.getTab(members[i])
      const pane = solved.panes[i]
      if (!view || !pane) continue
      // 每格从自己的矩形里**收进 paneGap**：让出那一圈给活动格淡蓝框（见 SPLIT_METRICS.paneGap）。
      // 恒定值 → 切活动格不动任何 bounds，换框只是 DOM 变化。
      // 全屏贴边模式下 gap 归零：网页铺满整窗，分隔只剩 DOM 框本身。
      const gap = this._isEdgeToEdge() ? 0 : SPLIT_METRICS.paneGap
      this._setBoundsIfChanged(view, {
        x: pane.x + gap,
        y: pane.y + gap,
        width: Math.max(0, pane.width - gap * 2),
        height: Math.max(0, pane.height - gap * 2)
      })
      // 圆角跟随贴边模式（全屏 0，其余主题圆角）；
      // 走去重口 —— 值没变时重复 setBorderRadius 会让这一格重做圆角遮罩（闪）。
      this._setRadiusIfChanged(view, this._pageRadius())
    }
  }

  /**
   * 把"当前哪些标签可见 + 谁是活动格"一次性落地。
   *
   * 为什么按集合差做：分屏让可见标签从 1 个变成 N 个，而"收起上一个"必须逐 id 判断。
   * 只记单个的话，从 2 格分屏切回普通标签时第二格的 view 永远不会被 setVisible(false)。
   *
   * @param {string[]} ids 应可见的标签 id
   * @param {string} activeId 活动格
   */
  _setVisibleTabs(ids: Iterable<string>, activeId?: string | null): void {
    const keep = new Set((Array.isArray(ids) ? ids : []).map(String))
    // 可见集合是否真的变了 —— 变了才需要重算浮层「外部点击收起」的侦听源
    // （见 `_syncFloatDismissSources`：标签只挂**可见**的那几个）。
    let tabSetChanged = false
    for (const tabId of Array.from(this._visibleTabIds)) {
      if (keep.has(tabId)) continue
      const v = this._wcm.getTab(tabId)
      // ⚠ 按**原生真实状态**去重（`View#getVisible`）：值没变还写一次 `setVisible`，
      //    原生侧会把这层视图从视图树上摘掉再挂回去 —— 那一片合成表面被重建 = 闪一下。
      //    直接读原生状态而不是自己记账：**没有"账本与实际不同步"的空间**。
      if (v && !LayoutCoordinator._isViewHidden(v)) { try { v.setVisible(false) } catch (_) {} }
      this._visibleTabIds.delete(tabId)
      tabSetChanged = true
    }
    for (const tabId of keep) {
      const v = this._wcm.getTab(tabId)
      if (!v) continue
      this._attachTabView(v)
      // 同上：**已经亮着的别再点亮一次**。这个循环每趟布局都跑（速览/分屏路径都走它），
      // 无脑 `setVisible(true)` 等于每趟把屏上每个网页视图重挂一遍。
      if (!LayoutCoordinator._isViewShown(v)) {
        try { v.setVisible(true) } catch (_) {}
        // 点亮 = 合成表面重建 ⇒ 圆角遮罩丢失，记账作废（见 _invalidateRadius）。
        this._invalidateRadius(v)
      }
      this._visibleTabIds.add(tabId)
      tabSetChanged = true
    }
    const active = String(activeId)
    this._activeTabId = active
    this._visibleTabView = this._wcm.getTab(active) || null
    // 切标签 / 进分屏 / 退分屏都经过这里：可见标签集合变了而浮层还开着时，
    // 「外部点击收起」的侦听源必须跟着换（新标签要挂、旧标签要摘）。
    if (tabSetChanged && this._floatDismissBound.size > 0) this._syncFloatDismissSources()
  }

  /**
   * 这层原生视图现在是不是**真的已经可见 / 已经隐藏**。
   *
   * 用 `View#getVisible()` 读原生真实状态，而不是自己维护一份"谁亮着"的账本 ——
   * 全仓有六七处会直接写 `setVisible`（切标签 / 收起 / 分屏 / 侧栏…），
   * 任何一份账本都会在某个角落里失真，而**失真后的表现是"该亮的没亮"**（比多写一次严重得多）。
   * 老版本 Electron 没有这个方法时一律返回"不知道"，调用方就会照常写入（行为与从前一致）。
   * @param {View} view
   */
  static _isViewShown(view: View): boolean {
    return typeof view.getVisible === 'function' && view.getVisible() === true
  }

  /** 同上：这层原生视图是不是**真的已经隐藏**。 */
  static _isViewHidden(view: View): boolean {
    return typeof view.getVisible === 'function' && view.getVisible() === false
  }

  /**
   * 把分屏几何推给**本窗口的外壳 renderer**（分隔条与活动格标记由它渲染）。
   *
   * 为什么由本类直接推、不走事件广播器：几何是主进程独有的事实（renderer 量不到
   * 原生视图的位置），而广播器需要一个 route 的登记表；这里只有"本窗口外壳"一个读者。
   * 通道名与 preload 的 `on.subscribe` 约定逐字一致（`ngipc:event:<route>`）。
   */
  _pushSplitGeometry() {
    const wc = this.getUiShellWebContents()
    if (!wc || wc.isDestroyed()) return
    const split = this._activeSplit
    const solved = this._lastSplitSolved
    const payload = split && solved
      ? {
          active: true,
          splitId: split.splitId,
          layout: solved.layout,
          count: solved.count,
          members: split.members.slice(),
          activeTabId: split.activeTabId,
          panes: (solved.panes || []).map((p) => ({ ...p })),
          dividers: (solved.dividers || []).map((d) => ({ ...d })),
          clamped: solved.clamped,
          // 活动格淡蓝框的两个参数由主进程给（主进程是几何与圆角的真源，渲染侧不自算）：
          //   gap    —— 每格收进的空隙，也就是框的落点（见 SPLIT_METRICS.paneGap）；
          //             全屏贴边时与格子的实际内收同步归零，框才落回格沿
          //   radius —— 与网页圆角同一个派生值（全屏 0），框与格子才对得上
          gap: this._isEdgeToEdge() ? 0 : SPLIT_METRICS.paneGap,
          radius: this._pageRadius()
        }
      : { active: false }
    /**
     * **内容没变就不发**。
     *
     * 这条在 `showTab` 末尾**每次切标签**都会调一遍，而绝大多数窗口里根本没有分屏
     * —— 不判的话就是"每切一次标签白送一条跨进程消息"（外壳还得收下、走一遍处理器，
     * 并触发一次 split 层重绘判断）。键里带 `wc.id`：外壳视图被重建（重新加载）时
     * 同一份几何也要重新下发一次。
     */
    const panes = payload.active === true ? (payload.panes || []) : []
    const dividers = payload.active === true ? (payload.dividers || []) : []
    const key = payload.active
      ? `${wc.id}|${payload.splitId}|${payload.activeTabId}|${payload.layout}|${payload.clamped}` +
        `|${panes.map((p) => `${p.x},${p.y},${p.width},${p.height}`).join(';')}` +
        `|${dividers.map((d) => `${d.axis},${d.x},${d.y},${d.width},${d.height}`).join(';')}` +
        `|${payload.gap},${payload.radius}`
      : `${wc.id}|inactive`
    if (key === this._lastSplitGeometryKey) return
    this._lastSplitGeometryKey = key
    try { wc.send(`ngipc:event:${IPC_EVENTS.splitChanged}`, payload) } catch (_) {}
  }

  /**
   * 分隔条拖拽 → 新比例（主进程是权威：renderer 只报"指针在哪"）。
   *
   * 算术走共享的 `ratiosFromDrag`（与渲染侧同一份），主进程负责落库与重排。
   * @param {{ index:number, axis:'x'|'y', position:number }} req 指针在**窗口内容区坐标**里的位置
   * @returns {{ ok:boolean, ratios?:number[], reason?:string }}
   */
  applySplitDrag(req: { index?: number; axis?: string; position?: number }) : { ok:boolean, ratios?:number[], reason?:string } {
    const split = this._activeSplit
    const page = this._lastPageBounds
    if (!split || !page || split.members.length < 2) return { ok: false, reason: 'no-active-split' }
    const ratios = ratiosFromDrag({
      rect: page,
      layout: split.layout,
      ratios: split.ratios,
      count: split.members.length,
      dividerIndex: Number(req && req.index),
      axis: req && req.axis === 'y' ? 'y' : 'x',
      position: Number(req && req.position)
    })
    if (!ratios) return { ok: false, reason: 'invalid-drag' }
    // 指针在同一整数像素内抖动时，求解结果完全不变。此时重排一次原生视图
    // 只会让 WebContentsView 重建交换链，收益为 0 —— 直接按幂等成功返回。
    const previous = split.ratios
    if (Array.isArray(previous) && previous.length === ratios.length
      && ratios.every((value, index) => Math.abs(value - previous[index]) < 1e-9)) {
      return { ok: true, ratios: previous }
    }
    split.ratios = ratios
    this.applyInitialLayout()
    return { ok: true, ratios }
  }

  /** 当前分屏几何快照（渲染层首次挂载时主动拉一次，不必等下一次推送）。 */
  getSplitGeometry() {
    const split = this._activeSplit
    const solved = this._lastSplitSolved
    if (!split || !solved) return { active: false }
    return {
      active: true,
      splitId: split.splitId,
      layout: solved.layout,
      count: solved.count,
      members: split.members.slice(),
      activeTabId: split.activeTabId,
      panes: solved.panes.map((p) => ({ ...p })),
      dividers: solved.dividers.map((d) => ({ ...d })),
      clamped: solved.clamped
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  速览（Glance，A1）—— 与分屏互斥、同一套骨架
  //
  //  TabManager 把「当前活动速览组」灌进来，本类只做两件事：
  //  ① 记下来；② 按共享求解器落两张卡的 bounds + 把 front 提到最上层。
  //  不认识 domain、不查库 —— 叠放尺寸口径在 shared-types/glance-layout.mjs。
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 灌入当前活动的速览组。传 null / 成员 ≠2 = 退出速览（回落单视图）。
   *
   * @param {{ glanceId:string, members:string[], frontTabId?:string|null, activeTabId?:string|null }|null} glance
   * @returns {object|null} 归一化后的当前速览状态
   */
  setActiveGlance(glance: ActiveGlanceState | null): ActiveGlanceState | null {
    const members = glance && Array.isArray(glance.members) ? glance.members.map(String) : []
    /** 这一趟是不是**真的从速览退出**（决定要不要收卡片）。 */
    const wasGlance = !!(this._activeGlance && this._activeGlance.members.length === 2)
    if (!glance || members.length !== 2) {
      /**
       * ⚠ 本来就不在速览时**直接返回、不重排**。
       *
       * `_syncActiveSplit` 在切标签/建组等热路径上每次都会"清一次速览态"，
       * 若无条件 `applyInitialLayout()`，每次切标签都要多跑一遍全量布局
       * （外壳算术 + 原生 setBounds 往返）——纯浪费，还会让网页在切换瞬间多闪一帧。
       * 与 `setActiveSplit` 的差别正在这里：那个是"分屏态"的权威入口，
       * 这个只是"顺手清一下"，所以必须幂等且零代价。
       */
      if (this._activeGlance == null) return null
      this._activeGlance = null
      this._lastGlanceSolved = null
      if (wasGlance) this._exitGlanceToSingleView()
    } else {
      const frontId = glance.frontTabId == null ? members[members.length - 1] : String(glance.frontTabId)
      const next = {
        glanceId: String(glance.glanceId || ''),
        members,
        frontTabId: members.includes(frontId) ? frontId : members[members.length - 1],
        activeTabId: glance.activeTabId == null ? frontId : String(glance.activeTabId)
      }
      const prev = this._activeGlance
      /**
       * 「前后台互换」是速览里**最热的一拍**（点背景卡 / 点标签条切到另一张）。
       * 这一拍只换角色，外壳几何与 chrome 一律没变 —— 于是直接按缓存的内容区重落两张卡，
       * **不跑全量布局**（分屏同款思路，见 `showTab` 尾部的注释）。
       *
       * 全量布局在切换这一拍上是纯浪费：外壳算术 + rail / 面板 / 侧栏 / 网页的
       * `setBounds` 往返 + 两路几何 IPC，全部结果都和上一趟一模一样；而它挤在
       * 用户刚点下去的那一帧里，表现就是"切换要等一拍"。
       */
      const onlyRoleSwap = !!prev && prev.members.length === 2 &&
        prev.glanceId === next.glanceId &&
        prev.members[0] === next.members[0] && prev.members[1] === next.members[1] &&
        (prev.frontTabId !== next.frontTabId || prev.activeTabId !== next.activeTabId)
      this._activeGlance = next
      if (onlyRoleSwap && this._lastPageBounds) {
        this._placeGlanceCards(this._lastPageBounds)
        return this.getActiveGlance()
      }
    }
    this.applyInitialLayout()
    return this.getActiveGlance()
  }

  /** 退出速览（回落单视图）。 */
  clearActiveGlance() {
    return this.setActiveGlance(null)
  }

  /** 当前速览状态的安全副本（null = 不在速览里）。 */
  getActiveGlance() {
    const g = this._activeGlance
    return g ? { ...g, members: g.members.slice() } : null
  }

  /**
   * 退出速览 → 回落单视图：收起非活动卡 + 作废几何去重缓存。
   * 与 `_exitSplitToSingleView` 同款理由（集合差 + 缓存作废），只是"活动卡"换成
   * 速览的 front（退出时保留的那张）。
   */
  _exitGlanceToSingleView() {
    this._tabBounds = null
    this._tabBoundView = null
    // 装饰面（阴影 + 聚焦框）随速览一起退场 —— 放在这个"退出速览"的收敛点里，
    // 于是所有退出路径（切标签 / 解散 / 关标签 / 全部隐藏）自动都走到，不会漏。
    this._hideGlanceSurface()
    const active = String(this._activeTabId || '')
    const view = active ? this._wcm.getTab(active) : null
    if (view) {
      this._setVisibleTabs([active], active)
      return
    }
    for (const tabId of Array.from(this._visibleTabIds)) {
      const v = this._wcm.getTab(tabId)
      if (v) { try { v.setVisible(false) } catch (_) {} }
    }
    this._visibleTabIds.clear()
    this._visibleTabView = null
  }

  /**
   * 落两张卡片的 bounds（速览路径）。
   *
   * 刻意**不走 `_tabTween`**（与分屏同款）：切前后是一次结构跳变，两卡同帧落位最干净。
   * z 序：back 先、front 后 —— `addChildView` 对已有子视图等价"移到顶层"，故显式抬 front。
   * @param {{x:number,y:number,width:number,height:number}} pageBounds
   */
  _placeGlanceCards(pageBounds: Rectangle): void {
    const glance = this._activeGlance
    if (!glance) return
    const solved = solveGlanceCards(pageBounds)
    this._lastGlanceSolved = solved
    // 可见集合 = 两张成员（顺序 [back, front]）。
    const declaredFront = glance.frontTabId == null ? '' : String(glance.frontTabId)
    const backId = String(glance.members.find((id) => id !== declaredFront) || glance.members[0] || '')
    const frontId = glance.members.includes(declaredFront) ? declaredFront : String(glance.members[1] || '')
    if (!backId || !frontId) return
    this._setVisibleTabs([backId, frontId], glance.activeTabId == null ? frontId : String(glance.activeTabId))
    const backView = this._wcm.getTab(backId)
    const frontView = this._wcm.getTab(frontId)
    if (backView) this._setBoundsIfChanged(backView, solved.back)
    if (frontView) this._setBoundsIfChanged(frontView, solved.front)
    // front 必须压在 back 之上：显式 raise。
    // ⚠ 这一步**每趟布局**都会走到，而 `addChildView` 对"已经是子视图"的对象是
    //   "摘下来再挂到顶层"（Electron 文档原话：reordered such that it becomes the topmost view）
    //   —— 无脑调用等于每趟都把 front 那片合成表面重建一次，表现就是画面抖一下。
    //   所以 `_raiseTabView` 内部带了"已在顶层就返回"的去重（真重排时它顺带作废圆角记账）。
    if (frontView) this._raiseTabView(frontView)
    // 圆角：**两张卡都必须是主浏览视图那一个主题圆角**（全屏贴边时归零）。
    // 无需在这里额外判"要不要强制"：`_setVisibleTabs` 点亮 / `_raiseTabView` 重排
    // 都会重建合成表面并作废圆角记账（见 `_invalidateRadius`），所以这一句去重写入
    // 在"表面刚重建"的那一趟必然真正落到原生；表面没动的那一趟则正确跳过（不闪）。
    const radius = this._pageRadius()
    if (backView) this._setRadiusIfChanged(backView, radius)
    if (frontView) this._setRadiusIfChanged(frontView, radius)
    // 卡片落位之后才是两道装饰：
    //   · 外环阴影 —— 走外壳 DOM，要的正是 back 卡那块矩形（见 _syncGlanceSurface）；
    //   · 卡片之间的投影 + 蓝框 —— 必须画进**后卡那一页**里（见 glance-deck-chrome.js）。
    this._syncGlanceSurface(solved.back, radius)
    this._syncGlanceDeck(backId)
  }

  /**
   * 速览两张卡之间的装饰（前台卡的投影 + 蓝色聚焦框）落在**后卡那一张**上。
   *
   * 为什么是 back、不是 front：front 四周都是 back 的像素，框若画在 front 自己页面上、
   * 贴着视口边缘，就必被 front 自身的圆角裁切切掉四角；画在 back 页、贴着 front 轮廓，
   * 光带落在「front 之外 / back 之内」那圈无人覆盖的像素里，完整可见（完整论证见
   * `glance-deck-chrome.js` 文件头）。
   *
   * 只报"哪一张 + 主题圆角 + 明暗"，不报几何 —— 位置由 `GLANCE_METRICS` 的纯函数推出，
   * 装饰贴视口按百分比画，天然与卡片重合。
   *
   * ⚠ 圆角必须给：它是 front 原生裁切轮廓的半径，装饰层的圆角要与之同心。
   *
   * @param {string|null} backTabId 后卡标签 id；`null` = 收起
   */
  _syncGlanceDeck(backTabId: string): void {
    const id = backTabId == null ? null : String(backTabId)
    this._lastGlanceBackId = id
    if (!this._glanceDeck) {
      this._glanceDeck = createGlanceDeckChrome({
        getTabWebContents: (id) => {
          const view = this._wcm.getTab(id)
          return view && view.webContents ? view.webContents : null
        }
      })
    }
    this._glanceDeck.sync(id, {
      radius: this._pageRadius(),
      dark: this._glanceIsDark(),
      accent: this._tabAccent
    })
  }

  /**
   * 主题底色是否偏暗 —— 只用来选注入阴影的配色（深色底上纯黑没有对比度）。
   * 取 `_frameBackgroundColor`（= 主题 `palette.bg`，见 `setTabTheme`）按 Rec.709
   * 感知亮度判一次。认不出颜色就当浅色（与外壳那份外环阴影的默认分支一致）。
   */
  _glanceIsDark() {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(this._frameBackgroundColor || '').trim())
    if (!m) return false
    const n = parseInt(m[1], 16)
    const luminance = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
    return luminance < 128
  }

  /**
   * 速览的**外环阴影**：把 back 卡的矩形推给**本窗口外壳**去画。
   *
   * ── 为什么是外壳 DOM，而不是独立浮层视图 ──────────────────────────
   * 与分屏分隔条 / 活动格框、侧栏聚焦框**同一条原理**（见 `renderer/shared/split-surface.js`
   * 文件头）：阴影落在"**没有任何网页 view 覆盖**"的那圈留白里，而 chrome（窗口本体）
   * 天然在所有子视图之下、恰好在那些区域露出来 —— 于是**不需要额外渲染进程、图层、
   * IPC 家族**，也不必管浮层的惰性创建与闲置回收这一整套。
   *
   * ⚠ 更要紧的是**点击**：外壳 DOM **永远抢不走卡片的点击**（原生视图始终在它之上）。
   *   早先这一层做成了浮层视图，它铺满内容区又盖在卡片之上，把"**点背景卡 → 提升前台**"
   *   （`tabEvents` 的 `wc.on('focus')` 钩子）与网页点击**全吃掉了** —— 因为
   *   `View` / `WebContentsView` 没有可用的 `setIgnoreMouseEvents`（视图只要可见就参与命中，
   *   项目早有结论：见 `renderer/hoverurl-overlay/main.js`）。
   *
   * 阴影铺在 **back 卡**矩形上即可：阴影默认画在框外，所以只有"卡片之外那一圈"可见 ——
   * 正好是外壳露出来的地方；卡片之内的像素本来也被卡片自己盖住。
   *
   * ⚠ 蓝聚焦框 + 卡间投影**不走这里**：front 的左右两条边正落在 back 卡身上
   *   （那片像素归 back 卡这张原生视图所有，外壳 DOM 到不了）—— 所以它们画进 **back 卡那一页**
   *   里，由 `_syncGlanceDeck` / `glance-deck-chrome.js` 负责（那里有完整几何论证）。
   *
   * @param {{x:number,y:number,width:number,height:number}|null} back back 卡矩形（窗口内容区坐标）；
   *   `null` = 收起（退出速览 / 全部标签隐藏）
   * @param {number} [radius] 卡片圆角（与 `setBorderRadius` 同一个值，主进程是真源）
   */
  _syncGlanceSurface(back: Rectangle | null, radius: number = 0): void {
    const next = back && back.width > 0 && back.height > 0
      ? {
          back: {
            x: Math.round(back.x),
            y: Math.round(back.y),
            width: Math.round(back.width),
            height: Math.round(back.height)
          },
          radius: Math.max(0, Math.round(Number(radius) || 0))
        }
      : null
    const prev = this._lastGlanceGeometry
    // 几何没变就不重复推（全量布局会被 resize / 面板开关频繁触发，而阴影多数时候没变）。
    // `null` 也去重：退出速览会有好几条路径（切标签 / 解散 / 关标签 / 全部隐藏）都走到这里。
    if (prev && next &&
        prev.back.x === next.back.x && prev.back.y === next.back.y &&
        prev.back.width === next.back.width && prev.back.height === next.back.height &&
        prev.radius === next.radius) {
      return
    }
    if (!prev && !next) return
    this._lastGlanceGeometry = next
    const wc = this.getUiShellWebContents()
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send(`ngipc:event:${IPC_EVENTS.glanceChanged}`, next || { back: null, radius: 0 })
    } catch (_) {}
  }

  /**
   * 收起速览的两个装饰（退出速览 / 全部标签隐藏时）。
   * 与分屏的 `_pushSplitGeometry` 同款：载荷里给"不活跃"这一态，渲染侧据此清掉 DOM。
   */
  _hideGlanceSurface() {
    this._syncGlanceSurface(null)
    // 那两道装饰是注入进 back 卡网页的样式，与外壳通道无关 —— 必须单独摘掉，否则会留在那一页上。
    if (this._glanceDeck) this._glanceDeck.sync(null)
  }

  /**
   * 阴影几何快照（给外壳**挂载时主动拉一次**用）。
   *
   * 为什么需要这条"拉"的路：`glance:changed` 是推送，而**会话恢复**会在外壳
   * 订阅之前就把速览还原好 —— 那一次推送必然早于订阅。与 `getSplitGeometry` /
   * `getWebSidebarFrameGeometry` 完全同一条思路（也是同一条 IPC 家族的第三个成员）。
   * @returns {{ back: object|null, radius: number }}
   */
  getGlanceSurfaceGeometry() : { back: object|null, radius: number } {
    const cur = this._lastGlanceGeometry
    return cur
      ? { back: { ...cur.back }, radius: cur.radius }
      : { back: null, radius: 0 }
  }

  /**
   * 把某个已挂载的标签视图移到 tab 图层最顶层。
   *
   * ⚠ **已经在顶层就什么都不做** —— 这不是优化，是防闪的必需：
   * Electron 的 `addChildView` 对"已经是该父视图子节点"的对象是**重排**
   *（文档原话：*reordered such that it becomes the topmost view*），内部等于
   * "摘下来再挂回去" → 那一片合成表面会被重建 → 画面抖一下 / 闪一帧。
   * 而速览路径是**每趟布局**都调它（resize、开关面板、悬停引起的全量布局都会到）。
   * @param {import('electron').WebContentsView} view
   * @returns {boolean} 这一趟**是否真的重排了**（重排意味着合成表面重建，圆角记账已在此作废）。
   */
  _raiseTabView(view: WebContentsView): boolean {
    if (!view || !this._tabLayer) return false
    if (!this._tabLayerChildren.has(view)) return false
    const children = this._tabLayer.children || []
    if (children.length && children[children.length - 1] === view) return false
    try { this._tabLayer.addChildView(view) } catch (_) { return false }
    // 重排 = 合成表面重建 ⇒ 圆角遮罩丢了，作废记账让布局分支那一句去重写入真正生效。
    this._invalidateRadius(view)
    return true
  }

  setPageLayoutParams(params: Partial<PageLayoutParams> = {}): boolean {
    const next = {
      ...this._pageLayoutParams,
      ...params
    }
    // rail 位置 / 起始边由渲染层随布局参数一起上报 —— 主进程不自己猜。
    // 二者齐备时「面板侧」由唯一算术解算，覆盖渲染层可能过期的 sidebarSide。
    if (params.railPosition != null) {
      this._railPosition = normalizeRailPosition(params.railPosition)
    }
    if (params.railHorizontalAlign != null) {
      this._railHorizontalAlign = normalizeRailHorizontalAlign(params.railHorizontalAlign)
    }
    if (params.railVerticalAlign != null) {
      this._railVerticalAlign = normalizeRailVerticalAlign(params.railVerticalAlign)
    }
    if (params.railPosition != null || params.railHorizontalAlign != null) {
      next.sidebarSide = resolveRailPanelSide(this._railPosition, this._railHorizontalAlign)
    }
    if (next.sidebarSide !== 'right') next.sidebarSide = 'left'
    if (next.navSide !== 'bottom') next.navSide = 'top'
    next.topbarHeight = Math.max(0, Number(next.topbarHeight) || 0)
    next.bottombarHeight = Math.max(0, Number(next.bottombarHeight) || 0)
    next.sidebarWidth = Math.max(0, Number(next.sidebarWidth) || 0)
    next.sideColumnWidth = Math.max(0, Number(next.sideColumnWidth) || 0)
    next.sideColumnVisible = next.sideColumnVisible !== false
    // 侧栏区自己那一侧：渲染层随占宽一起上报（它才知道本段此刻靠哪边）。
    // 缺省（nullish）→ null = 跟随 rail（历史行为，见 _resolvedSideColumnSide）。
    if (next.sideColumnSide !== 'left' && next.sideColumnSide !== 'right') next.sideColumnSide = null
    next.contentTopOffset = Math.max(0, Number(next.contentTopOffset) || 0)
    /**
     * 侧栏「悬停唤出」的三项计划事实（渲染层随占宽一起上报）：
     *   · autoHide —— 形态开关（设置 app.sidebar_visibility === 'floating'）；
     *   · revealOverlay —— 唤出方式（Edge 型垂直标签 = true：标签 rail 静止 +
     *     展开为独立浮层；false：唤出时真占位、网页让位）；
     *   · revealWidth —— 唤出后的宽度（折叠着就是图标条宽，否则是用户拖的宽度）。
     * 缺省/非法一律回落到实测占宽 —— 渲染层不报时行为与常驻态完全一致。
     */
    next.sideColumnAutoHide = next.sideColumnAutoHide === true
    next.sideColumnRevealOverlay = next.sideColumnRevealOverlay === true
    const revealWidth = Math.round(Number(next.sideColumnRevealWidth))
    next.sideColumnRevealWidth = Number.isFinite(revealWidth) && revealWidth > 0
      ? revealWidth
      : next.sideColumnWidth
    this._pageLayoutParams = next
    this._headerHeight = next.topbarHeight || this._headerHeight
    this._sidebarPosition = next.sidebarSide
    this._sideColumnSide = next.sideColumnSide
    this._applySideColumnRevealParams(params)
    if (params.sideColumnResizing != null) {
      this.setSideRevealHold(params.sideColumnResizing === true)
    }
    this.applyInitialLayout()
    return true
  }

  /**
   * 吸收「侧栏悬停唤出」的计划事实（渲染层随布局参数上报）。
   *
   * 只认**本次真正送来的字段**（`params` 原样，不是合并后的 next）——
   * 旧渲染层不带它们时，不能把已经生效的唤出态凭空抹掉。
   *
   * @param {object} params 本次上报的原始字段
   */
  _applySideColumnRevealParams(params: Partial<PageLayoutParams>): void {
    const p = params || {}
    if (typeof p.sideColumnAutoHide === 'boolean') this._sideColumnAutoHide = p.sideColumnAutoHide
    if (typeof p.sideColumnRevealOverlay === 'boolean') this._sideColumnRevealOverlay = p.sideColumnRevealOverlay
    // 巡看的启停交给 applyInitialLayout 末尾的 _syncSideRevealWatch（唯一收敛点）——
    // 这里再推一次会与紧接着的那趟重排抢同一个收敛点（白算一次几何）。
  }

  /**
   * 唤出态变化的对外出口（宿主注入：window-chrome 用它广播给外壳）。
   * @param {((revealed: boolean) => void) | null} fn
   */
  setSideColumnRevealListener(fn: ((revealed: boolean) => void) | null): void {
    this._sideColumnRevealListener = typeof fn === 'function' ? fn : null
  }

  /**
   * 落定「此刻是否唤出」—— **唯一的状态收敛点**。
   *
   * 两类形态共用这一个布尔，各自的下游动作不同：
   *   · 占位型：网页真的让位（`getSideColumnWidth`）+ 外壳把侧栏改宽到 revealWidth；
   *   · 浮层型：网页**不动**（占宽恒为静止 rail 宽）+ 本类把独立浮层铺开
   *     （见 `_syncSideOverlayFloat`，由紧接着的那趟重排执行）。
   *
   * ⚠ 必须 immediate：补间 = 逐帧改原生 `WebContentsView#setBounds`（渲染进程每帧
   *   重建交换链）→ 悬停时掉帧。唤出要的是"一下到位"。
   */
  _setSideRevealed(next: boolean): void {
    const value = next === true
    // 两个方向都清时间戳记账（离开宽限 + 贴边驻留）：state 一旦落定，
    // "离开多久" / "贴了多久"都没有意义了。
    this._sideRevealLeaveAt = 0
    this._sideRevealEnterAt = 0
    if (value === this._sideRevealed) return
    this._sideRevealed = value
    if (this._sideColumnRevealListener) {
      try { this._sideColumnRevealListener(value) } catch (_) {}
    }
    try { this.applyInitialLayout({ immediate: true }) } catch (_) {}
  }

  /**
   * 冻结 / 解冻「侧栏悬停唤出」——**拖动标签期间唯一需要的那一件事**。
   *
   * 拖动中指针一定会离开保持圈（从浮层里拖到网页上），而巡看是「指针不在圈内就收起」。
   * 照常跑的下场是**拖拽源视图在拖动中途被收成 0×0**：Windows 会取消原生拖拽，
   * 渲染层的 `dragend` 于是丢失 —— 会话（`tab-drop-zone` 采样表 + 落位框浮层）永远留着，
   * 活动标签停在配对那一格（"分屏黏住"）；同时侧栏浮层消失后指针落在网页上，
   * 250ms 停留门禁一过又浮出预览、松手真空分屏（"误触分屏"）。
   *
   * 保持期间**只冻结巡看的状态迁移**（不收起、也不新展开），不动已经落定的唤出态 ——
   * 于是"我正拖着的那个侧栏"原地不动，拖拽源一直活着。
   *
   * 唯一的例外是「展开刚好赶在拖拽开始前一瞬间」那次竞态：那时浮层并不是拖拽源，
   * 却盖在源上面等着接住松手 —— 开启时按拖动源视图把这次误展开撤回去
   *（见 `_withdrawSideOverlayForDragSource`）。
   *
   * 解除时立刻走一趟 `_syncSideRevealWatch()` 重新收敛：形态已不该唤出（比如拖完顺手
   * 把侧栏关了）就直接收起，其余情形交给下一拍巡看按指针位置决定。
   *
   * @param {boolean} on
   * @param {{ sourceWebContentsId?: number|null }} [options]
   *   `sourceWebContentsId` = 这场拖动的**发起视图**（渲染层 WebContents id）。
   *   开启冻结那一拍用它判"刚才那次展开是不是误展开"，见 `_withdrawSideOverlayForDragSource`。
   * @returns {boolean} 状态是否真的变了（幂等，可被高频调用）
   */
  setSideRevealHold(on: boolean, options: { sourceWebContentsId?: number | null } = {}): boolean {
    const value = on === true
    // 撤回只看「这一场拖动的源是谁」，**与冻结状态是否变化无关**：上一场若丢了 dragend，
    // hold 会残留 true，这时更需要把盖在源上的浮层撤掉（`_withdrawSideOverlayForDragSource`）。
    if (value) this._withdrawSideOverlayForDragSource(options && options.sourceWebContentsId)
    if (value === this._sideRevealHold) return false
    this._sideRevealHold = value
    // 两个方向都把计时记账清掉：冻结期间的"离开多久 / 贴了多久"没有意义。
    this._sideRevealLeaveAt = 0
    this._sideRevealEnterAt = 0
    this._railRevealLeaveAt = 0
    // 解冻即重新收敛（冻结时跳过了 `!need` 的那条收起分支，见 _syncSideRevealWatch）。
    if (!value) {
      this._syncSideRevealWatch()
      this._syncRailRevealWatch()
    }
    return true
  }

  /**
   * 模态编辑层打开时**彻底停掉侧栏边缘唤出**。
   *
   * 与 `setSideRevealHold` 的区别：hold 为标签拖拽服务，只冻结状态迁移并保留
   * 已经落定的侧栏；编辑模式必须同时收起已展开的 sidebar-float，否则它仍会
   * 参与焦点与原生拖放竞争。桌面端 WebContentsView 没有真正的鼠标穿透，
   * 上层编辑层不能只靠 z-index 保证“下面不响应”。
   *
   * @param {boolean} on
   * @returns {boolean}
   */
  setSideRevealSuspended(on: boolean): boolean {
    const value = on === true
    if (value === this._sideRevealSuspended) return false
    this._sideRevealSuspended = value
    if (value) {
      this._stopSideRevealWatch()
      this._setSideRevealed(false)
      this._syncRailRevealWatch()
      return true
    }
    this._syncSideRevealWatch()
    this._syncRailRevealWatch()
    return true
  }

  /**
   * 按钮编辑模式的**全展开临时展示态**。
   *
   * 不改任何设置，只覆盖原生布局预算：沉浸 / 全屏不再收起 chrome，rail 强制在场，
   * 侧栏唤出冻结。退出后恢复用户原来的 rail 可见性与沉浸状态。
   *
   * @param {boolean} on
   * @returns {boolean}
   */
  setEditingPresentation(on: boolean): boolean {
    const value = on === true
    if (value === this._editingPresentation) return false
    this._editingPresentation = value
    if (value) {
      this._railPinnedBeforeEditing = this._railPinned
      this._railPinned = true
      this._railRevealed = false
      this._syncRailLayerVisibility()
      this._immersiveRevealed = false
      if (this._immersiveWatch) {
        clearInterval(this._immersiveWatch)
        this._immersiveWatch = null
      }
      this.setSideRevealSuspended(true)
    } else {
      if (this._railPinnedBeforeEditing !== null) {
        this._railPinned = this._railPinnedBeforeEditing
        this._railPinnedBeforeEditing = null
      }
      this._syncRailLayerVisibility()
      this.setSideRevealSuspended(false)
    }
    try { this.applyInitialLayout({ immediate: true }) } catch (_) {}
    this._syncImmersiveWatch()
    return true
  }

  /**
   * 拖动开始时**撤回**掉一次"刚好赶上"的浮层唤出 —— 修「拖一下就凭空复制出一个标签页」。
   *
   * 竞态（用户实测）：指针贴上窗缘 280ms，浮层在**拖拽开始的前一瞬间**划开。拖动源在
   * chrome 的 rail 里，浮层却盖在它上面 —— 松手那一刻 `drop` 落在浮层这个**另一个
   * WebContentsView** 上。浮层是独立渲染进程，它没发起过这次拖动（自己的 `dragId` 为空），
   * 于是把自己的 drop 当"外部拖入"，按载荷里的 url 开了一个新标签 ——
   * **同一次排序手势凭空复制出一个标签页**。
   *
   * 冻结（调用方）只能拦住之后的展开，拦不住已经落定的这一次；所以这里把已展开的浮层
   * **立刻退回静止 rail**：拖动继续在 rail 里完成，排序一切照旧（同一份手势，不多也不少）。
   *
   * 两条不动的情形：
   *   · 拖动源**就是浮层自己**（在展开的面板里拖标签）—— 收掉它等于把拖拽源从手上夺走；
   *   · 源未知（老渲染层 / 非渲染层的拖动）—— 宁可不动，收错一次就是"拖到一半面板没了"。
   *
   * @param {number|null|undefined} sourceWebContentsId
   * @returns {boolean} 是否真的撤回了
   */
  _withdrawSideOverlayForDragSource(sourceWebContentsId?: number | null): boolean {
    if (this._sideColumnRevealOverlay !== true) return false
    if (!this._sideRevealed) return false
    if (sourceWebContentsId == null) return false
    const floatWc = this.getFloatWebContents('sidebar-float')
    if (floatWc && floatWc.id === sourceWebContentsId) return false
    this._setSideRevealed(false)
    return true
  }

  /**
   * 侧栏**静止宽**（= 不悬停时应占的宽）—— 巡看判据与浮层几何的唯一来源。
   *
   * ⚠ 不能直接用实测的 `sideColumnWidth`：占位型（全功能侧栏）**展开时**它就是唤出宽，
   *   与 `sideColumnRevealWidth` 相等 → `revealWidth > restWidth` 恒 false →
   *   `_syncSideRevealWatch` 停表并收起 → 外壳报回 0 → 又开表展 → 无限闪烁重排
   *   （用户报的「hover 一直闪烁重排、侧栏稳定不下来」就是这个）。
   *   静止宽是**形态事实**，按形态回答，不按当前实测：
   *     · 浮层型（Edge）→ 静止就是 chrome 里那条 rail，吃实测（与 rail 像素级对齐）；
   *     · 自动隐藏的占位型 → 恒 0（静止时网页铺满）；
   *     · 常驻型 → 实测（不该有巡看，这里只是口径完整）。
   *   同一个口径的另一半在 `getSideColumnWidth(params, false)`（网页内缩用的静止占宽）——
   *   那边多折了一条「侧栏整个关掉 = 0」，可见性由调用方单独判（见 `_syncSideRevealWatch`）。
   * @returns {number}
   */
  _sideRevealRestWidth() : number {
    const p = this._pageLayoutParams || {}
    const measured = Math.max(0, Math.round(Number(p.sideColumnWidth) || 0))
    if (p.sideColumnRevealOverlay === true) return measured
    if (p.sideColumnAutoHide === true) return 0
    return measured
  }

  /**
   * 窗口此刻是否「在前台可交互」：存在、可见、未最小化、有焦点。
   *
   * 为什么要有这个闸门：三条指针巡看表回答的是「指针在不在本窗口的那条边上」，
   * 而窗口最小化 / 被别的应用盖住 / 失焦时这个问题**根本不成立** —— 表却还在按
   * 40ms / 80ms / 30Hz 唤醒事件循环去读系统指针位置。失焦即停表，把「切到别的应用后
   * 主进程零轮询」做成结构性保证，而不是靠每条 tick 里的早退去省那几次系统调用
   * （早退本身仍要唤醒一次事件循环）。
   *
   * 回焦 / 恢复时窗口事件会重新 `_sync*Watch()` 把表按需起回来（绑定见 attachUiShell）。
   * @returns {boolean}
   */
  _windowInteractive() : boolean {
    const win = this._win
    if (!win || win.isDestroyed()) return false
    try {
      if (typeof win.isVisible === 'function' && !win.isVisible()) return false
      if (typeof win.isMinimized === 'function' && win.isMinimized()) return false
      if (typeof win.isFocused === 'function' && !win.isFocused()) return false
    } catch (_) {
      return false
    }
    return true
  }

  /**
   * 维护「侧栏悬停唤出」的指针巡看：仅该形态开着、且 chrome 没收起时需要。
   *
   * 为什么必须在主进程判定：静止时侧栏要么宽 0（占位型）——那条边下面是**网页原生视图**；
   * 要么是 chrome 里的静态 rail（浮层型）——浮层一出现就会盖住光标。
   * 两种情况下"此刻该不该展开"都只能按屏幕指针位置算。
   *
   * 唤出宽不大于静止宽（图标条折叠态）时**没有可展开的东西**，不跑表。
   */
  _syncSideRevealWatch() {
    const p = this._pageLayoutParams || {}
    const restWidth = this._sideRevealRestWidth()
    const revealWidth = Math.max(0, Math.round(
      Number(p.sideColumnRevealWidth) || restWidth
    ))
    // 侧栏被整个关掉时没有可唤出的东西（否则会"悬停一下就把藏起来的侧栏拽出来"）。
    // 窗口不在前台可交互时不跑表：指针巡看读的是**屏幕坐标**，失焦 / 最小化时它没有意义
    // （见 `_windowInteractive`；回焦时窗口事件会把表重新拉起来）。
    const need = this._windowInteractive() &&
      !this._sideRevealSuspended &&
      !this.isFloatVisible('buttons-edit-overlay') &&
      this._sideColumnAutoHide &&
      p.sideColumnVisible !== false &&
      !this._chromeHidden() &&
      revealWidth > restWidth
    if (!need) {
      this._stopSideRevealWatch()
      // 冻结期间不强制收起：拖动中形态参数可能刚被重报一趟，这里收掉就是"拖拽源凭空消失"。
      // 解冻时 `setSideRevealHold(false)` 会再走一趟本函数，届时该收的自然会收。
      if (!this._sideRevealHold) this._setSideRevealed(false)
      return
    }
    if (this._sideRevealWatch) return
    this._sideRevealWatch = setInterval(() => {
      try { this._tickSideReveal() } catch (_) {}
    }, SIDE_REVEAL_TICK_MS)
    if (typeof this._sideRevealWatch.unref === 'function') this._sideRevealWatch.unref()
  }

  /** 一次唤出判定（只在 _syncSideRevealWatch 的定时器里跑）。 */
  _tickSideReveal() {
    const win = this._win
    if (!win || win.isDestroyed()) {
      this._stopSideRevealWatch()
      return
    }
    if (this._chromeHidden()) {
      // chrome 收起时归沉浸模式那套（整屏贴边唤出），这里让位并停表。
      this._syncSideRevealWatch()
      return
    }
    if (this._sideRevealSuspended || this.isFloatVisible('buttons-edit-overlay')) {
      this._stopSideRevealWatch()
      return
    }
    /**
     * 拖动标签期间**冻结**：不展开、不收起、不记时。
     *
     * 这正是不误触分屏 / 不黏住的前提 —— 拖动中指针必然离开保持圈（从侧栏浮层拖到网页上），
     * 照常判定就会把**拖拽源视图**收成 0×0（浮层型）或把侧栏压回静止宽（占位型）：
     *   · 视图在被拖动时改变尺寸/消失 → 系统取消原生拖拽 → 渲染层 `dragend` 丢失
     *     → `tab-drop-zone` 会话与落位框永远留着、活动标签停在配对那一格（"黏住"）；
     *   · 侧栏一收，指针就"落"在网页上 → 250ms 停留门禁一过浮出预览 → 松手真空分屏。
     * 保持只冻结"状态迁移"，不动已经落定的唤出态，所以被拖的那一行一直可见。
     */
    if (this._sideRevealHold) {
      this._sideRevealLeaveAt = 0
      this._sideRevealEnterAt = 0
      return
    }
    const content = win.getContentBounds()
    if (!content || content.width <= 0 || content.height <= 0) return
    const point = screen.getCursorScreenPoint()
    const x = point.x - content.x
    const y = point.y - content.y
    const now = Date.now()
    // 指针越过窗口外缘时进入“外缘闩锁”：保持当前展开态，不启动收起计时。
    // 只有重新进入窗口后才恢复正常判定 —— 若落到保持圈外，再按退场宽限收起。
    if (x < 0 || y < 0 || x > content.width || y > content.height) {
      this._sideRevealEnterAt = 0
      this._sideRevealLeaveAt = 0
      return
    }
    const side = this._resolvedSideColumnSide()
    // 静止宽是**形态事实**（见 `_sideRevealRestWidth`）—— 不能用展开后的实测宽，
    // 否则占位型会在「展开 → 判停表 → 收起 → 又展开」之间无限闪烁。
    const restWidth = this._sideRevealRestWidth()
    // 唤出宽随计划报上来；首帧（渲染层还没上报）回落到常驻宽，免得保持圈是 0。
    const revealWidth = Math.max(0, Math.round(
      Number(this._pageLayoutParams.sideColumnRevealWidth) || restWidth
    ))
    /**
     * 触发圈：浮层型静止就摆着一条 rail（它本身就是 chrome 的一部分），
     * 指针**落在静止宽以内**也算"贴上"；占位型静止宽 0，只有窗缘那一条。
     * 保持圈一律按唤出宽算 —— 指着展开出来的那块侧栏不该立刻被收起。
     */
    const restPx = this._sideColumnRevealOverlay
      ? Math.max(IMMERSIVE_EDGE_PX, restWidth)
      : IMMERSIVE_EDGE_PX
    const atEdge = side === 'left'
      ? x <= restPx
      : x >= content.width - restPx
    const insideRevealed = revealWidth > 0 && (side === 'left'
      ? x <= revealWidth + SIDE_REVEAL_KEEP_MARGIN_PX
      : x >= content.width - revealWidth - SIDE_REVEAL_KEEP_MARGIN_PX)
    if (atEdge) {
      /**
       * 贴边 = 想展开，但**浮层型要驻留** SIDE_REVEAL_ENTER_DELAY_MS 才真正展开
       * （用户口径：「edge 的悬停浮层是要 hover 200ms 再展开」）。
       * 占位型照旧立即展开：它只是把网页挤开一条，没有遮挡；
       * 而浮层型一出现就整块盖住网页，掠过窗缘不该把面板砸下来。
       */
      if (!this._sideColumnRevealOverlay || this._sideRevealed) {
        this._sideRevealEnterAt = 0
        this._setSideRevealed(true)
        return
      }
      if (!this._sideRevealEnterAt) {
        this._sideRevealEnterAt = now
        return
      }
      if (now - this._sideRevealEnterAt < SIDE_REVEAL_ENTER_DELAY_MS) return
      this._sideRevealEnterAt = 0
      this._setSideRevealed(true)
      return
    }
    // 离开贴边圈 → 驻留计时作废（下一次贴边从零开始计）。
    this._sideRevealEnterAt = 0
    if (!this._sideRevealed) return
    if (insideRevealed) {
      // 还在展开出来的那块侧栏上 —— 撤销宽限计数。
      this._sideRevealLeaveAt = 0
      return
    }
    // 出了保持圈：两种形态统一走同一段退场宽限。
    // 用时间戳而不是 setTimeout：tick 每 40ms 拍一次，重排定时器会让它永不触发；
    // 时间戳判据天然幂等，也不会在停表时漏清理。
    if (!this._sideRevealLeaveAt) {
      this._sideRevealLeaveAt = now
      return
    }
    if (now - this._sideRevealLeaveAt >= SIDE_REVEAL_HIDE_DELAY_MS) {
      this._setSideRevealed(false)
    }
  }

  /** 停指针巡看（幂等）。 */
  _stopSideRevealWatch() {
    this._sideRevealLeaveAt = 0
    this._sideRevealEnterAt = 0
    if (!this._sideRevealWatch) return
    clearInterval(this._sideRevealWatch)
    this._sideRevealWatch = null
  }

  /**
   * **浮层型唤出**的落位与显隐 —— 侧栏悬停展开的"第二条腿"。
   *
   * 与占位型的分工（同一份巡看，Edge 型不享宽限，见 `_tickSideReveal`）：
   *   · 占位型把唤出宽播给外壳，网页**真让位**；
   *   · 浮层型网页一动不动，由这里把一条**独立浮层**（WebContentsView）盖在网页左侧
   *     （右侧布局时贴右）—— 覆盖从窗口外缘起、宽 `revealWidth`、
   *     高 = 渲染层实测的**侧栏区矩形**（`sideColumnRect`，与 rail 同一块 DOM，
   *     所以两边缘像素级对齐；不要用 topbar/bottombar 反推，那里面含主列的让位段）。
   *     于是静止的 chrome rail（56px）被它整块盖住，观感就是 Edge 那条"rail + 浮出面板"。
   *
   * 为什么必须是独立视图而不是 chrome 里的 DOM：chrome 是**窗口本体**（假视图），
   * 天生位于 contentView 所有子视图**之下** —— 它画得再高也盖不住网页。
   * 浮层的 z 序由 LayerStack（`float:sidebar-float` = 21）决定，高于 tab-layer、低于其它浮层。
   *
   * 常驻预热：形态可用时立刻 warm 并撤掉闲置回收 —— 悬停展开必须是"一下就在"，
   * 不能每次都在用户指针下重建一个 renderer 进程（那是几百毫秒的空窗）。
   *
   * @param {{bounds:{width:number,height:number}, topbarHeight:number, bottombarHeight:number, columnSide:'left'|'right', sideGone:boolean}} geo
   *   本趟全量布局算好的几何（横向 x / 可用性判定用；纵向以 `sideColumnRect` 为准）。
   */
  _syncSideOverlayFloat(geo: SideOverlayGeometry): void {
    const key = 'sidebar-float'
    const p = this._pageLayoutParams || {}
    const bounds = geo && geo.bounds
    // 静止宽按**形态事实**取（Edge 型 = chrome 里那条 rail 的实测宽，见 `_sideRevealRestWidth`）。
    const restWidth = this._sideRevealRestWidth()
    // 浮层宽度**只**来自布局计划（`app.sidebar_width` → revealWidth），浮层自身不可拖宽。
    const revealWidth = Math.max(0, Math.round(
      Number(p.sideColumnRevealWidth) || restWidth
    ))
    const usable = this._sideColumnRevealOverlay === true &&
      p.sideColumnVisible !== false &&
      !(geo && geo.sideGone) &&
      revealWidth > restWidth &&
      !!bounds && bounds.width > 0 && bounds.height > 0
    if (!usable) {
      // 形态关掉 / 切回常驻：浮层立刻退场（不再预热 —— 它已经不该存在）。
      this._hideSideOverlayFloat(key)
      return
    }
    // 预热 + 常驻驻留：显示路径上不能有任何一次"起进程"。
    this.warmFloatView(key)
    this._cancelFloatReclaim(key)
    const side = geo.columnSide === 'right' ? 'right' : 'left'
    /**
     * 浮层的纵向几何吃**侧栏区自己的 DOM 矩形**（渲染层实测上报的 `sideColumnRect`），
     * 而不是本趟的 topbar/bottombar：那两项里还含主列内部的"让位段"
     * （`#chrome-main-top/bottom`，书签栏那类），它们只缩短主列、不缩短侧栏区 ——
     * 拿它反推会算出一块比 rail 矮一整行的浮层（用户看到的就是这个）。
     * 矩形缺省（旧渲染层 / 侧栏 display:none）才退回旧算术。
     */
    const rect = p.sideColumnRect
    const hasRect = !!(rect && rect.height > 0)
    const top = hasRect ? Math.round(rect.y) : Math.round(geo.topbarHeight)
    const height = hasRect
      ? Math.round(rect.height)
      : Math.max(0, Math.round(bounds.height - geo.topbarHeight - geo.bottombarHeight))
    if (!this._sideRevealed || height <= 0) {
      this._hideSideOverlayFloat(key)
      // 收起会排闲置回收（见 setFloatBounds 的 0×0 分支）—— 形态仍可用时立刻撤掉：
      // 下一次悬停必须瞬时出，不接受冷启动。
      this._cancelFloatReclaim(key)
      return
    }
    const wasShown = this._sideOverlayShown
    if (!wasShown) this.noteFloatShow(key)
    this.setFloatBounds(key, {
      x: side === 'right' ? Math.max(0, bounds.width - revealWidth) : 0,
      y: top,
      width: revealWidth,
      height
    })
    this.setFloatInteractive(key, true)
    // show 只在「首次显示 / 换边」时下发：renderer 只需要知道靠哪边（分隔线/文本方向）。
    // 每次布局都发会让浮层里的标签列表反复空转（切个标签就重排一次）。
    if (!wasShown || this._sideOverlaySide !== side) {
      this._sideOverlayShown = true
      this._sideOverlaySide = side
      // 它同时是**展开动画**的唯一触发点（浮层静息态是闭合，见 sidebar-float/index.html）。
      // guard：sendToFloat 会 await 冷启动加载，期间可能已被收起 —— 过期就不下发，
      // 否则动画会播在一块已经收起的视图上，且下一次展开拿不到 show。
      this.sendToFloat(
        key,
        `ngipc:event:${key}:show`,
        { side },
        () => this._sideOverlayShown && this._sideOverlaySide === side
      ).catch(() => {})
      // 与动画同一拍起一段 hover 探针：clip-path 划开时命中区是被裁掉的，
      // 指针不动就永远收不到 mouseover（见 FLOAT_HOVER_PROBE_MS）。
      this._startFloatHoverProbe(key)
    }
  }

  /**
   * 收起 Edge 型侧栏浮层 —— **唯一出口**（`_syncSideOverlayFloat` 的两条收起分支都走它）。
   *
   * 为什么必须先发 `:hide` 再落 0×0：浮层的显隐只靠 bounds（`setFloatBounds` 一律不调
   * `setVisible`，见那条方法的注释），本页感知不到「我已收起」。而展开动画的静息态是
   * **闭合**（sidebar-float/index.html 的 critical CSS）—— 没有这条事件，下一次悬停会先
   * 露出整块面板、等 show 到了才播动画（观感："弹一下再动"）。
   * @param {string} key 浮层逻辑名
   */
  _hideSideOverlayFloat(key: string): void {
    const wasShown = this._sideOverlayShown
    this._sideOverlayShown = false
    this._sideOverlaySide = null
    // 收起即停 hover 探针：浮层已经不在屏上，再投合成事件只会打到 0×0 的视图。
    this._stopFloatHoverProbe()
    if (wasShown) this.sendToFloat(key, `ngipc:event:${key}:hide`, {}).catch(() => {})
    try { this.hideFloat(key, { keepFocus: true }) } catch (_) {}
  }

  setTabFullscreen(fullscreen: boolean): boolean {
    const next = Boolean(fullscreen)
    if (next === this._tabIsFullscreen) return false
    this._tabIsFullscreen = next
    // 全屏进出必须瞬时铺满 / 复位，不做弹簧过渡
    this.resetTabBounds()
    this.applyInitialLayout({ immediate: true })
    return true
  }

  setTabFullscreenFromWindow() {
    return this.setTabFullscreen(this._win.isFullScreen())
  }

  resetTabBounds() {
    this._tabBounds = null
    this._tabBoundView = null
    // 底层 view 被销毁/重建（sleep / wake / 切换标签）后，动画状态必须整体复位并停表，
    // 否则新 view 会因目标 bounds 相等而被去重跳过，拿不到任何 bounds（对齐 RT onViewDestroyed）。
    this._tabTween.resetLastAppliedBounds()
  }

  forgetView(view: WebContentsView): boolean {
    if (!view) return false
    // 关闭 / 休眠标签时，必须先从 tab 图层摘除 —— 否则 webContents.destroy()
    // 后原生视图宿主仍挂在图层里，触发合成器崩溃或内存泄漏。
    if (this._tabLayerChildren.has(view)) this._detachTabView(view)
    // 若该 view 恰好是某个 chrome 图层（面板/浮层/rail），一并摘除。
    // z 序由 LayerManager 增量重排自动收敛，无需手动标记脏。
    this._dropLayerByView(view)
    this._lastBounds.delete(view)
    if (this._tabBoundView === view) {
      this._tabBounds = null
      this._tabBoundView = null
      this._tabTween.resetLastAppliedBounds()
    }
    return true
  }

  /** 按 view 摘除对应 chrome 图层（LayerManager 自动重排剩余图层 z 序） */
  _dropLayerByView(view: View | null): boolean {
    if (!view) return false
    for (const [key, layer] of this._chromeLayers) {
      if (layer && layer.view === (view as unknown as Layer['view'])) {
        this._layers.pop(layer)
        this._chromeLayers.delete(key)
        return true
      }
    }
    return false
  }

  /**
   * 应用主题的**原生表面**设置。
   *
   * @param {{ surfaceBackgroundColor?: string, radius?: number,
   *           inset?: number, frameBackgroundColor?: string,
   *           accentColor?: string, windowMaterial?: string }} [opts]
   *   `surfaceBackgroundColor`：面板 / rail 这些"表面型"子视图的原生底色。
   *   为什么要单独一个字段：它们是 chrome，主题带壁纸时原生底必须是**透明**的，
   *   才能透出外壳那一层壁纸（否则半透明的面板页只会与不透明的原生底色混成一个平色，
   *   壁纸根本看不见）。
   *   `windowMaterial`：窗口材质 id（`none` / `acrylic`）。见 `_applyWindowMaterial`。
   *
   * @returns {{ material: string, applied: boolean, supported: boolean, reason: string, message: string }}
   *   本次材质应用结果。⚠ 经 `layoutFanout` 后返回的是**最后一个窗口**的结果，
   *   判断"这台机器支不支持"请用 `getBackdropCapabilities()`。
   *
   * ⚠ **本方法绝不改标签视图（网页）的底色** —— 网页的画布色固定为白纸，
   *   由 `WebContentsManager` 自己保证。主题只有权决定"网页之外"的表面色：
   *   外圈那 4px 缝（`frameBackgroundColor`）与 rail / 面板（`surfaceBackgroundColor`）。
   *   把网页底色也跟主题走会让大量未定义背景的站点整页染上主题色（用户反馈的
   *   "白色背景网页跟着变颜色"就是这个）。
   */
  setTabTheme({ surfaceBackgroundColor, radius, inset, frameBackgroundColor, accentColor, windowMaterial }: TabThemeOptions = {}) : { material: string, applied: boolean, supported: boolean, reason: string, message: string } {
    if (accentColor) this._tabAccent = String(accentColor)
    if (surfaceBackgroundColor) {
      // 面板 / rail 是占位区域：底色若**不**跟主题走，深色下就会在页面绘制前露出原生白底
      if (typeof this._wcm.setSurfaceBackgroundColor === 'function') {
        this._wcm.setSurfaceBackgroundColor(surfaceBackgroundColor)
      }
    }
    if (frameBackgroundColor) this._frameBackgroundColor = String(frameBackgroundColor)
    // 材质先落地：它的结果决定窗口底色还能不能写（见 _applyWindowMaterial）。
    const surface = this._applyWindowMaterial(windowMaterial || this._windowMaterial)
    if (radius != null && Number.isFinite(radius) && radius >= 0) this._tabBorderRadius = Number(radius)
    if (inset != null && Number.isFinite(inset) && inset >= 0) {
      const value = Number(inset)
      this._contentPadding = value
      // 四边一起设：页面与 chrome 之间那一圈空隙必须是闭合的（含 top），
      // 否则书签栏 / 工具栏会紧贴页面、看起来落在空隙里（见 _contentInsetTop 的注释）。
      this._contentInsetTop = value
      this._contentInsetLeft = value
      this._contentInsetRight = value
      this._contentInsetBottom = value
    }
    // 强调色 / 圆角可能变了：速览的卡片间聚焦框是**注入进网页**的样式，
    // 它读不到令牌，只能按新色重注一次（幂等：CSS 没变就什么都不做）。
    if (this._glanceDeck && this._lastGlanceBackId) this._syncGlanceDeck(this._lastGlanceBackId)
    this.applyInitialLayout()
    return surface
  }

  /**
   * 窗口材质落地（**唯一落点**）。
   *
   * 材质生效时**绝不能**再调 `win.setBackgroundColor`：Electron 的
   * `setBackgroundMaterial` 内部会把窗口底色置为透明并交给 DWM；之后任何不透明底色
   * 写入都会把它整个盖掉 —— 表现就是"开了亚克力却还是一块死板底色"。
   *
   * 反过来，材质关闭 / 系统不支持时，这里负责把主题底色写回去，
   * 否则窗口会停留在上一轮被置透明的状态。
   */
  _applyWindowMaterial(material: string): BackdropResult {
    if (typeof material === 'string' && material) this._windowMaterial = material
    const previous = this._windowMaterialResult
    const result = applyWindowBackdrop(this._win, { material: this._windowMaterial })
    this._windowMaterialResult = result
    if (result.applied) {
      // 材质在身：底色由 Electron 交给 DWM（透明），此时写任何底色都会把材质盖死。
      this._paintedFrameColor = ''
      return result
    }
    // 材质**没**生效（关掉了 / 系统不支持 / 调用失败）→ 窗口底色必须是主题底色。
    // 两种情况必须写：从材质退回（Electron 内部还是透明的）、以及主题换了底色。
    const released = !!(previous && previous.applied)
    if (released || this._paintedFrameColor !== this._frameBackgroundColor) {
      try {
        this._win.setBackgroundColor(this._frameBackgroundColor)
        this._paintedFrameColor = this._frameBackgroundColor
      } catch (_) {}
    }
    return result
  }

  /** 归一化侧值：只认 'left' / 'right'，其余（含 undefined）退回设置那一侧。 */
  /**
   * 面板集合变动后的对账（面板插件被启用 / 禁用时由主进程调用）。
   *
   * ── 为什么必须有这一步 ────────────────────────────────────────────
   * 面板现在是插件：禁用某个面板插件之后，目录里没有它的 id 了，
   * 但**已经打开并常驻的那份面板视图仍在**：
   *   · 面板还占着宽度、还显示着内容（用户会觉得"开关没生效"）；
   *   · 它的渲染进程也不会自己退出（`hidePanel` 只 setVisible(false)）。
   * 所以这里做两件事：先按正常路径关掉已失效的活动面板包（宽度/焦点/hover 预览
   * 都收干净），再销毁所有已不在目录里的面板视图，把渲染进程真正释放掉。
   *
   * 幂等：目录没变时不会销毁任何东西。已在目录里的面板一个都不动 ——
   * 用户正在看的面板不会因为「启用了一个无关插件」而闪断。
   *
   * @param {string[]} validPanelIds 当前面板目录里的 id（`panel:catalog` 的 ids）
   * @returns {number} 被销毁的面板视图数
   */
  reconcilePanels(validPanelIds: Iterable<string>): number {
    if (!this._wcm || typeof this._wcm.listPanelIds !== 'function') return 0
    const valid = new Set((Array.isArray(validPanelIds) ? validPanelIds : []).map(String))

    // 1. 已失效的面板位 → 走正常关闭路径（它会把占位宽度归零并重排，
    //    比直接抹掉视图干净：hover 预览浮层、焦点、图层顺序都按既有逻辑收拾好）
    //    ⚠ 逐块关（closePanel）：同侧可能同时开着普通位与钉住位，
    //    用 hidePanel(side) 会把**仍然有效**的另一块一起关掉。
    for (const s of ['left', 'right'] as const) {
      for (const id of this._panelIdsOnSide(s)) {
        if (valid.has(id)) continue
        try { this.closePanel(id) } catch (e) { console.warn('[layout] closePanel during reconcile failed:', errorMessage(e)) }
      }
    }

    // 2. 销毁所有不在目录里的面板（含上一步刚关掉的那个）
    let destroyed = 0
    for (const panelId of this._wcm.listPanelIds()) {
      if (valid.has(panelId)) continue
      // 先摘图层再销毁视图：留着图层就是留着一个指向已销毁 webContents 的空壳
      const name = `panel:${panelId}`
      const layer = this._getLayer(name)
      if (layer) {
        try { this._layers.pop(layer) } catch (_) {}
        this._chromeLayers.delete(name)
      }
      // 顶条（网页面板）同样先摘图层 —— 它与内容是两份视图，少摘一份就留下一条空壳
      const headerName = `${name}:header`
      const headerLayer = this._getLayer(headerName)
      if (headerLayer) {
        try { this._layers.pop(headerLayer) } catch (_) {}
        this._chromeLayers.delete(headerName)
      }
      // 视图包作废：下次这条 id 再出现时重新向端口要
      this._panelParts.delete(String(panelId))
      // 销毁交给**端口**（谁造的谁销毁：app 面板一份视图、网页面板还多一份顶条）
      const viaPort = this._panelViewPort && typeof this._panelViewPort.destroy === 'function'
        ? !!this._panelViewPort.destroy(panelId)
        : false
      if (viaPort || this._wcm.destroyPanel(panelId)) destroyed += 1
    }

    if (destroyed) {
      try { this.applyInitialLayout() } catch (_) {}
    }
    return destroyed
  }

  showTab(tabId: string) {
    const id = String(tabId)
    // 显式切标签 = 活动面回到标签（点标签条 / Ctrl+Tab / Ctrl+1..9 都走这里）。
    // 与"鼠标直接点标签网页"那条 focus 路径互补：那条管原生视图自己拿焦点，这条管程序化切换。
    this._setWebSidebarActive(false)
    // TabManager 必须在调用前唤醒休眠标签（见 TabManager#_showTab）并创建好视图。
    // 这里**绝不**用 createTab 兜底：休眠标签若在此被直接重建，会绕过
    // TabLifecycle 的导航历史还原与事件绑定，导致「显示空白 + 状态失联」。
    const view = this._wcm.getTab(id)
    if (!view) return { tabId: id, missing: true }

    // 分屏：该标签属于当前活动的分屏组 → **整组一起可见**，活动格换成它。
    // 判据只有这一条 —— 不在组里（或没有活动组）就回落单视图，**没有"分屏模式"这种分支**。
    const split = this._activeSplit
    const inSplit = !!split && split.members.includes(id)

    const prevView = this._visibleTabView
    const prevWasFocused = this._isViewFocused(prevView)

    // 速览：该标签属于当前活动的速览组 → 两张卡一起可见，活动卡换成它（front 随之提升）。
    const glance = this._activeGlance
    const inGlance = !!glance && glance.members.includes(id)
    if (inGlance) {
      glance.activeTabId = id
      glance.frontTabId = id
      this._tabBounds = null
      this._tabBoundView = null
      if (this._lastPageBounds) this._placeGlanceCards(this._lastPageBounds)
      else this.applyInitialLayout()
      this._syncFocusAfterTabShow(prevWasFocused)
      return { tabId: id }
    }

    if (inSplit) {
      split.activeTabId = id
      this._tabBounds = null
      this._tabBoundView = null
      this._setVisibleTabs(split.members, id)
      if (this._lastPageBounds) this._placeSplitPanes(this._lastPageBounds)
      else this.applyInitialLayout()
      this._pushSplitGeometry()
      this._syncFocusAfterTabShow(prevWasFocused)
      return { tabId: id }
    }

    // 对齐 RT LayerManager：视图只在首次显示时挂载（addChildView once），
    // 之后切标签**只切 setVisible** —— 零重挂载、零 z-order 重排、零全页重排。
    this._attachTabView(view)
    // ⚠ 与 `_setVisibleTabs` 同一条纪律：**按原生真实状态去重**。
    // 值没变还写一次 `setVisible`，原生侧会把这层视图从视图树上摘掉再挂回去 ——
    // 那一片合成表面被重建，用户看到的就是切标签时闪一下。
    if (prevView && prevView !== view && !LayoutCoordinator._isViewHidden(prevView)) {
      try { prevView.setVisible(false) } catch (_) {}
    }
    // 从分屏切到普通标签：把**其余**可见标签一并收起（集合差在这里兜底 ——
    // TabManager 通常已把 activeSplit 清掉，但"清状态"与"收视图"必须都发生）。
    for (const visibleId of Array.from(this._visibleTabIds)) {
      if (visibleId === id) continue
      const v = this._wcm.getTab(visibleId)
      if (v && !LayoutCoordinator._isViewHidden(v)) { try { v.setVisible(false) } catch (_) {} }
    }
    this._visibleTabIds = new Set([id])
    if (prevView !== view && !LayoutCoordinator._isViewShown(view)) {
      try { view.setVisible(true) } catch (_) {}
      // 同 `_setVisibleTabs`：点亮重建合成表面 → 圆角记账作废（见 _invalidateRadius）。
      this._invalidateRadius(view)
    }
    this._visibleTabView = view
    this._lastSplitSolved = null
    // 走到这里 = 已不是速览成员（inGlance 提前返回）→ 清掉求解缓存。
    this._lastGlanceSolved = null
    this._pushSplitGeometry()

    if (this._activeTabId !== id) {
      this._tabBounds = null
      this._tabBoundView = null
    }
    this._activeTabId = id

    // 优化：切换 tab 时 rail/panel 的 bounds 都没变，
    // 只需用缓存的 pageBounds 设置新 tab view 的 bounds，不调用全量 applyInitialLayout。
    // 首次布局（_lastPageBounds 为空）时才走全量布局。
    if (this._lastPageBounds) {
      const next = {
        x: this._lastPageBounds.x,
        y: this._lastPageBounds.y,
        width: this._lastPageBounds.width,
        height: this._lastPageBounds.height
      }
      const viewChanged = this._tabBoundView !== view
      const boundsChanged = !LayoutCoordinator._boundsEqual(this._tabBounds, next)
      this._tabBounds = next
      this._tabBoundView = view
      if (viewChanged) {
        // 切标签 / sleep-wake 重建：新 view 首帧立即落位（切标签不做过渡动画）
        this._tabTween.resetLastAppliedBounds()
        this._tabTween.setBoundsImmediate(next)
      } else if (boundsChanged) {
        this._tabTween.setBounds(next, LayoutCoordinator._prefersReducedNativeMotion())
      }
      // 圆角跟随贴边模式：全屏 0、其余主题圆角（见 _pageRadius）。
      this._setRadiusIfChanged(view, this._pageRadius())
    } else {
      this.applyInitialLayout()
    }
    // 键盘焦点跟随当前标签：仅当「切走前焦点就在网页上」或「当前没有任何图层持有焦点」
    // 时才动它（对齐 RT reallocateFocus），避免抢走 omnibox/浮层的焦点。
    this._syncFocusAfterTabShow(prevWasFocused)
    return { tabId: id }
  }

  hideTab() {
    const prevView = this._visibleTabView
    const prevWasFocused = this._isViewFocused(prevView)
    if (prevView) {
      try { prevView.setVisible(false) } catch (_) {}
      this._visibleTabView = null
    }
    // 分屏时可见的不止一个：全部收起，且把分屏状态一并清掉（没有活动标签就没有分屏可谈）。
    for (const tabId of Array.from(this._visibleTabIds)) {
      const v = this._wcm.getTab(tabId)
      if (v) { try { v.setVisible(false) } catch (_) {} }
    }
    this._visibleTabIds.clear()
    this._activeSplit = null
    this._lastSplitSolved = null
    this._activeGlance = null
    this._hideGlanceSurface()
    this._lastGlanceSolved = null
    this._activeTabId = null
    this._tabBounds = null
    this._tabBoundView = null
    if (prevWasFocused) this._layers.reallocateFocus()
  }

  /**
   * 把键盘焦点交给外壳（地址栏），并在一小段时间内**反复重申**。
   *
   * 只在「用户明确要求聚焦地址栏」时调用（启动首个标签 / 新建标签页，见 `shell:focus`）。
   * 绝不在浮层显示时调用 —— 那会让鼠标划过标签、弹出建议下拉这类动作都把焦点抢到
   * 地址栏上。浮层抢焦走「还给原主」那条路（见 setFloatBounds）。
   *
   * 反复重申的原因：标签是独立 WebContentsView，它「创建 / 首次由隐藏变可见」时
   * Chromium 会**原生**把键盘焦点交给网页 —— 不经任何 JS `focus()` 调用，也没有事件
   * 可拦，单次 focus 只会换来「光标闪一下就被顶掉」。
   * 对齐 RT `Omnibox#show / refocus`：`window.focus()` + `focus()` 之后还要再补一次。
   *
   * @returns {boolean} 是否已发起（外壳不可用时 false）
   */
  focusShell() : boolean {
    const win = this._win
    if (!win || win.isDestroyed()) return false
    const initial = this.getUiShellWebContents()
    if (!initial || initial.isDestroyed()) return false
    const attempt = () => {
      if (win.isDestroyed()) return
      const shell = this.getUiShellWebContents()
      if (!shell || shell.isDestroyed()) return
      // 窗口本身没在前台时先把它拉回前台，否则 webContents.focus() 拿不到键盘焦点
      try { if (!win.isFocused()) win.focus() } catch (_) {}
      try { shell.focus() } catch (_) {}
    }
    this._clearShellFocusRetries()
    // 外壳要焦点 → 正在跑的"回内容面"链立刻作废，否则两条链会把光标来回拽。
    this._clearContentFocusRetries()
    attempt()
    this._armFocusRetries(this._shellFocusRetries, attempt, SHELL_FOCUS_RETRY_MS)
    return true
  }

  /** 外壳（窗口本体 webContents）当前是否持有键盘焦点 */
  isShellFocused() {
    return this._isViewFocused(this._uiShellView)
  }

  /** 该 webContents 此刻是否真的持有原生键盘焦点（安全判空 / 已销毁 = false）。 */
  _isWcFocused(wc: { isDestroyed?(): boolean; isFocused?(): boolean } | null | undefined): boolean {
    if (!wc) return false
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false
      return typeof wc.isFocused === 'function' ? !!wc.isFocused() : false
    } catch (_) { return false }
  }

  /**
   * 节流后的「把窗口顶到前台」（见 `WIN_FOCUS_THROTTLE_MS`）。
   *
   * 只做一件事：在允许的间隔内调用 `BrowserWindow#focus()`。回焦拍次表与看门狗都会
   * 反复走到这里，但真正需要的只是**第一次** —— 窗口一旦是原生活动窗口，后续所有
   * `webContents.focus()` 就能正常生效。多调的那些只会让窗口闪烁 / 抢前台。
   *
   * @returns {boolean} 本次是否真的发起了 `win.focus()`
   */
  _requestWindowFocus() : boolean {
    const win = this._win
    if (!win || win.isDestroyed()) return false
    const now = Date.now()
    if (now - this._lastWinFocusAt < WIN_FOCUS_THROTTLE_MS) return false
    this._lastWinFocusAt = now
    try { win.focus() } catch (_) { return false }
    return true
  }

  /**
   * 把原生键盘焦点**确实**落到某个内容面上（带结果校验，不是"发出去就算完"）。
   *
   * 为什么一次 `focus()` 不够：窗口从失活回到前台时，Windows 下 Chromium 会先把
   * 原生焦点**重放给窗口本体**（外壳 webContents），对子视图的那一次 focus 常被这次
   * 重放吞掉 —— 结果正是用户说的"切回来什么都没有，得手动点一下网页"。
   * 校验失败时补两段（对齐 RT `Omnibox#refocus`）：先 `win.focus()` 确保窗口本身是
   * 活动原生窗口，再重申一次目标视图。
   *
   * @param {Electron.WebContents} wc
   * @param {{ defer?: boolean }} [options] defer=false：失败后不再补异步重申（幂等路径用）
   * @returns {boolean} 焦点是否确实落在该 webContents 上
   */
  _focusContentWebContents(wc: WebContents, options: FocusRestoreOptions = {}): boolean {
    if (!wc) return false
    try { wc.focus() } catch (_) {}
    if (this._isWcFocused(wc)) return true
    // 「win.isFocused() === true」只说明**逻辑上**激活了，不代表**原生激活**已完成
    // （Windows 上 OS 激活 → Chromium 处理 → 渲染帧提交是一条异步链）。这段空窗里
    // 对子视图的 focus 会被吞掉。因此这里再 win.focus() 一次把它顶到最前，
    // 而不是像以前那样"看起来已聚焦就跳过"—— 恰恰是跳过让回焦永远落空。
    // 窗口这一层**必须节流**（见 `_requestWindowFocus`），否则拍次表会把它变成闪烁源。
    this._requestWindowFocus()
    try { wc.focus() } catch (_) {}
    if (this._isWcFocused(wc)) return true
    // 再补一段异步重申：等 native 激活完成后给一次机会。不排队、不阻塞调用方 ——
    // 它是"最后一厘米"，成败交给随后的看门狗 / 拍次表复核。
    if (options.defer !== false) {
      setImmediate(() => {
        if (!wc) return
        try { if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return } catch (_) { return }
        if (this._isWcFocused(wc)) return
        try { wc.focus() } catch (_) {}
      })
    }
    return false
  }

  /** 某 view 的 webContents 当前是否持有键盘焦点（安全判空） */
  _isViewFocused(view: { webContents?: WebContents | null; isFocused?(): boolean } | null): boolean {
    return view ? this._isWcFocused(view.webContents) : false
  }

  /** 当前持有键盘焦点的 webContents（无则 null） */
  _currentFocusedWebContents() {
    try {
      const { webContents } = require('electron')
      const wc = typeof webContents.getFocusedWebContents === 'function'
        ? webContents.getFocusedWebContents()
        : null
      return wc && !wc.isDestroyed() ? wc : null
    } catch (_) { return null }
  }

  /**
   * 该浮层是否「自己持焦」（见 SELF_FOCUS_FLOATS）。
   *
   * 存在的意义：把白名单**只留一份**。外层（IPC 接线 / 主进程驱动的浮层）不该
   * 各自维护一份"哪些浮层要抢焦点"的名单 —— 那正是后续新增浮层最容易漏的一环。
   *
   * @param {string} name 浮层逻辑名
   * @returns {boolean}
   */
  isSelfFocusFloat(name: string): boolean {
    return SELF_FOCUS_FLOATS.has(String(name))
  }

  /**
   * 把键盘焦点交给某个独立浮层（「自己持焦」的浮层专用，见 SELF_FOCUS_FLOATS）。
   *
   * 与 `focusShell` 同款「分几拍重申」：浮层的 renderer 是**独立进程**，它自己的
   * `input.focus()` 只改 DOM 焦点 —— 键盘焦点若不在这个视图上，光标不会出现、
   * 输入法组合串也进不来。而原生焦点会在「视图创建 / 内容加载完成」时被 Chromium
   * 自己改派，单次 focus 只会换来"光标闪一下就被顶掉"。
   *
   * ⚠ **确认到手就停**：每拍先看它是否已经持焦，是则整串作废（后续拍次自行空转）。
   * 少了这条，"重申"就变成把用户在这段时间里主动点走的焦点硬抢回来 —— 那正是
   * 用户反馈的"焦点不稳"。
   *
   * @param {string} name 浮层逻辑名
   * @returns {boolean} 是否已发起（浮层视图不可用时 false）
   */
  focusFloat(name: string): boolean {
    const key = String(name)
    if (!this._floatVisible.get(key)) return false
    const view = this._floatViews.get(key)
    if (!view || !view.webContents || view.webContents.isDestroyed()) return false
    const win = this._win
    /** 已持焦（或视图已经没了）→ 不必再补。 */
    const held = () => {
      const v = this._floatViews.get(key)
      const wc = v && v.webContents
      if (!wc || wc.isDestroyed()) return true
      try { return !!wc.isFocused() } catch (_) { return true }
    }
    const attempt = () => {
      if (!win || win.isDestroyed()) return
      if (!this._floatVisible.get(key) || held()) return
      const v = this._floatViews.get(key)
      const wc = v && v.webContents
      if (!wc || wc.isDestroyed()) return
      try { if (!win.isFocused()) win.focus() } catch (_) {}
      try { wc.focus() } catch (_) {}
    }
    attempt()
    this._clearFloatFocusRetries()
    this._clearContentFocusRetries()
    this._armFocusRetries(this._floatFocusRetries, attempt, SHELL_FOCUS_RETRY_MS)
    return true
  }

  /**
   * 把键盘焦点交给某个已打开面板的内容视图。
   *
   * ── 为什么需要它（不能只靠面板 renderer 自己的 `input.focus()`）────────────
   * 面板是一个独立 `WebContentsView`，而**键盘事件只送给持焦的那一个视图**。
   * 面板 renderer 里的 `input.focus()` 只改**它自己文档内**的焦点元素 —— 视图本身
   * 没拿到原生键盘焦点时，光标不会出现、输入法组合串也进不来（同一个窗口里同时只有
   * 一个视图持焦，这是 Chromium 的原生事实，不经任何 JS 调用改变）。
   *
   * 典型调用者：`panels/main.js` 在面板挂载后（面板带搜索框时）请主进程把焦点要过来 ——
   * 「打开面板 → 直接打字」因此成立，而不是"打开了还得先点一下输入框"。
   *
   * 与 `focusFloat` 同款「分几拍重申 + 确认到手就停」：面板视图可能在加载完成时被
   * Chromium 自己改派焦点，单次 `focus()` 只会换来"光标闪一下就被顶掉"。
   *
   * @param {string} panelId
   * @returns {boolean} 是否已发起（视图不在 / 已销毁 = false）
   */
  focusPanel(panelId: string): boolean {
    const id = String(panelId)
    const win = this._win
    /** 面板此刻的内容视图（普通面板走 WCM，网页面板走端口包）。 */
    const contentOf = (): { webContents?: WebContents | null } | null => {
      const parts = this._panelParts.get(id) || null
      const content = (parts && parts.content) ||
        (this._wcm && typeof this._wcm.getPanel === 'function' ? this._wcm.getPanel(id) : null)
      return content as unknown as { webContents?: WebContents | null } | null
    }
    const wcOf = (): WebContents | null => {
      const view = contentOf()
      return view && view.webContents ? view.webContents as WebContents : null
    }
    const wc0 = wcOf()
    if (!wc0 || (typeof wc0.isDestroyed === 'function' && wc0.isDestroyed())) {
      this._clearPanelFocusRetries()
      return false
    }
    /** 已持焦（或视图已经没了）→ 不必再补（见 focusFloat 的同款取舍）。 */
    const held = () => {
      const wc = wcOf()
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return true
      try { return typeof wc.isFocused === 'function' ? !!wc.isFocused() : true } catch (_) { return true }
    }
    const attempt = () => {
      if (!win || win.isDestroyed()) return
      // 面板已被关掉（不再占任何一侧）→ 停手：给一个已经卸掉的面板要焦点是没有意义的。
      if (!this.getPanelSideOf(id)) return
      if (held()) return
      const wc = wcOf()
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
      try { if (!win.isFocused()) win.focus() } catch (_) {}
      try { wc.focus() } catch (_) {}
    }
    attempt()
    this._clearPanelFocusRetries()
    this._clearContentFocusRetries()
    this._armFocusRetries(this._panelFocusRetries, attempt, SHELL_FOCUS_RETRY_MS)
    return true
  }

  /**
   * 把键盘焦点还给「浮层显示之前持有它的那个 webContents」。
   *
   * 两条约束缺一不可：
   *   · 分几拍重申 —— 浮层 renderer 加载完成才抢焦，那一刻可能晚至 1s 后；
   *   · **只在焦点确实被某个浮层抢走时才归还** —— 用户之后主动点了网页或工具栏时
   *     绝不干预，否则就成了「我动一下就把焦点抢回地址栏」。
   * @param {Electron.WebContents} wc 目标 webContents
   */
  _restoreFocusTo(wc: unknown): void {
    if (!wc || typeof wc !== 'object') return
    const target = wc as { isDestroyed?(): boolean; isFocused?(): boolean; focus?(): void }
    const restore = () => {
      if ((typeof target.isDestroyed === 'function' && target.isDestroyed())
        || (typeof target.isFocused === 'function' && target.isFocused())) return
      if (!this._isFloatWebContents(this._currentFocusedWebContents())) return
      try { target.focus?.() } catch (_) {}
    }
    restore()
    this._armFocusRetries(this._restoreFocusRetries, restore, RESTORE_FOCUS_RETRY_MS)
  }

  /** 该 webContents 是否属于本窗口的某个浮层（建议下拉 / 标签预览 / 权限弹窗 / 密码浮层） */
  _isFloatWebContents(target: WebContents | null | undefined): boolean {
    if (!target) return false
    for (const v of this._floatViews.values()) {
      if (v && v.webContents === target) return true
    }
    return !!(this._passwordOverlayView && this._passwordOverlayView.webContents === target)
  }

  getActiveTabId() {
    return this._activeTabId
  }

  /**
   * **当前正显示在屏幕上**的标签 id（普通布局 1 个，分屏 / 速览时 >1）。
   *
   * 与 `getActiveTabId()` 的区别是本方法存在的全部理由：活动标签只是"可见集合里的一员"。
   * 分屏 / 速览下**非活动的那一格同样在屏幕上渲染着** —— 谁要动一个标签的 view
   * （休眠销毁 / 归档删除 / 关闭），都必须按本方法避开，不能只看活动 id。
   *
   * 谁消费：`tabLifecycle` 的休眠 / 归档守卫 —— 曾经只看活动 id，
   * 于是分屏的另一格被休眠后 view 被销毁，屏幕上留下一块点不动、关不掉的空白格。
   *
   * @returns {string[]} 可见标签 id（无可见标签时为空数组）
   */
  getVisibleTabIds() : string[] {
    return Array.from(this._visibleTabIds)
  }

  /**
   * 某个标签此刻是否可见（在屏幕上）。
   * @param {string} tabId
   * @returns {boolean}
   */
  isTabVisible(tabId: string): boolean {
    const id = String(tabId)
    if (this._visibleTabIds.has(id)) return true
    // 兜底：可见集合尚未记账（首次显示前的极短窗口）时，至少把活动标签算作可见 ——
    // 宁可少休眠一个，也不能把一个正在显示的页面拆掉。
    return String(this._activeTabId || '') === id
  }

  /**
   * 获取活动标签 view 在窗口（contentView 原点）中的左上角偏移。
   * 用于把“页面内”坐标换算成 overlay 浮层的窗口坐标。
   * @returns {{ x: number, y: number }|null}
   */
  getActiveTabViewOffset() : { x: number, y: number }|null {
    if (!this._activeTabId) return null
    const [w, h] = this._win.getContentSize()
    if (!w || !h) return null
    // 直接读**活动标签 view 当前 bounds** 的左上角 —— 它就是"页面坐标系原点在窗口里的位置"，
    // 与自己是不是在分屏、chrome 是否收起**完全无关**（分屏时它就是那一格的 x/y）。
    //
    // 旧实现按「各段宽度累加」重算，有两个真问题：
    //   ① 与 applyInitialLayout 的算法漂移（改布局的人不会记得同步这里）；
    //   ② chrome 收起（全屏 / 沉浸）分支里引用了**未定义的 `wc`** → 那条分支一调必抛
    //      ReferenceError（沉浸模式下按 Ctrl+F 等需要换算页面坐标的路径会静默失效）。
    const view = this._wcm.getTab(this._activeTabId)
    if (view && typeof view.getBounds === 'function') {
      try {
        const b = view.getBounds()
        if (b && b.width > 0 && b.height > 0) return { x: Math.round(b.x || 0), y: Math.round(b.y || 0) }
      } catch (_) {}
    }
    // 尚未布局（首次创建、bounds 还是 0×0）→ 退回计划值，至少不会把坐标算飞。
    const pane = this._activePaneBounds()
    if (pane) return { x: Math.round(pane.x), y: Math.round(pane.y) }
    return { x: 0, y: 0 }
  }

  /**
   * 活动网页在窗口内容区中的完整矩形。
   *
   * 优先读取真实 tab view bounds；视图尚未落位时退回最近一次布局结果。
   * 密码浮层只在返回矩形内定位，不能再拿整个窗口尺寸充当网页可视区。
   */
  getActiveTabViewBounds(): Rectangle | null {
    if (this._activeTabId) {
      const view = this._wcm.getTab(this._activeTabId)
      if (view && typeof view.getBounds === 'function') {
        try {
          const rect = view.getBounds()
          if (rect && rect.width > 0 && rect.height > 0) return { ...rect }
        } catch (_) {}
      }
    }
    const fallback = this._lastPageBounds
    return fallback && fallback.width > 0 && fallback.height > 0 ? { ...fallback } : null
  }

  /**
   * 按 webContents 取它所属视图在**窗口内容区坐标系**里的左上角偏移。
   *
   * 用途：面板 / 浮层里的按钮要弹出锚定在它下方的 popup，而渲染层只能上报**视图内**
   * 坐标（`getBoundingClientRect()`）；弹窗定位用的是窗口内容区坐标 —— 中间差的正是这段偏移。
   *
   * 直接读视图**当前 bounds**：面板 / 浮层是 contentView 的直接子视图，标签挂在同样
   * 铺满窗口的 tab 图层下，两种情形下 bounds 就是内容区坐标。不再按 panelX / topbarHeight
   * 重算一遍 —— 重算必然与 applyInitialLayout 漂移（改布局的人不会记得同步这里）。
   *
   * 以下情形一律返回 null（调用方退化到默认锚点，**不抛错**）：
   *   · wc 不属于本窗口任何子视图（含窗口本体 ChromeView —— 它没有 getBounds）；
   *   · 同一 wc 命中多个视图（视图表歧义，见 WebContentsManager#findViewByWebContents）；
   *   · 视图尚未完成布局（bounds 为 0 尺寸 —— 例如面板刚创建、还没跑过 applyInitialLayout）。
   * @param {Electron.WebContents} wc
   * @returns {{ x: number, y: number }|null}
   */
  getViewContentOffset(wc: WebContents): { x: number; y: number } | null {
    const wcm = this._wcm
    if (!wcm || typeof wcm.findViewByWebContents !== 'function') return null
    const hit = wcm.findViewByWebContents(wc)
    if (!hit || !hit.view) return null
    const view = hit.view as unknown as { getBounds?: () => Rectangle }
    if (typeof view.getBounds !== 'function') return null
    let bounds = null
    try { bounds = view.getBounds() } catch (_) { return null }
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null
    return { x: Math.round(bounds.x || 0), y: Math.round(bounds.y || 0) }
  }

  setHeaderHeight(px: number): boolean {
    const n = Number(px)
    if (!Number.isFinite(n)) return false
    const next = Math.floor(n)
    if (next <= 0) return false
    if (next === this._headerHeight) return false
    this._headerHeight = next
    this.applyInitialLayout()
    return true
  }

  /**
   * 设置面板宽度（用户拖拽调节）。
   * @param {number} px 面板宽度像素
   * @param {'left'|'right'} [side] 哪个面板位（缺省 = 设置那一侧）
   * @param {'normal'|'pinned'} [slot] 哪个槽（普通位 / 钉住位，缺省 = 普通位）
   * @returns {boolean} 是否实际更新
   */
  setPanelWidth(px: number, side?: string | null, slot?: string | null): boolean {
    const n = Number(px)
    if (!Number.isFinite(n)) return false
    const next = Math.floor(n)
    if (next < 200 || next > 600) return false
    // ⚠ 这里此前误写成 `this._railWidth = next`：rail 渲染器启动时会用保存的面板宽度
    // （默认 320）调一次 setPanelWidth，结果把 48px 的 rail 撑成 320px。
    // 校验区间 200~600 也说明它只能是面板宽度，不可能是 rail 宽度。
    const target = this._normalizePanelSide(side)
    const store = slot === 'pinned' ? this._pinnedWidths : this._panelWidths
    if (next === store[target]) return false
    store[target] = next
    // immediate：面板拖拽期间页面宽度必须逐帧跟手（弹簧只在开/关面板时做过渡）
    this.applyInitialLayout({ immediate: true })
    return true
  }

  /** 某一侧面板位的宽度（缺省 = 设置那一侧）。 */
  getPanelWidth(side?: string | null, slot?: string | null): number {
    const store = slot === 'pinned' ? this._pinnedWidths : this._panelWidths
    return store[this._normalizePanelSide(side)]
  }

  /**
   * 记录面板关闭后 rail 应恢复到的状态。
   *
   * 这只是“关闭前预算”，不会立刻改布局；真正落位发生在最后一个面板移除时，
   * 与面板关闭共用一次 `applyInitialLayout()`。
   */
  setRailCloseRestore(expanded: unknown, width: unknown): boolean {
    const nextExpanded = typeof expanded === 'boolean' ? expanded : null
    const nextWidth = nextExpanded
      ? Math.max(RAIL_COLLAPSED_WIDTH, normalizeRailWidth(width))
      : this._railRestoreWidth
    const changed = nextExpanded !== this._railRestoreExpanded ||
      (nextExpanded === true && nextWidth !== this._railRestoreWidth)
    this._railRestoreExpanded = nextExpanded
    this._railRestoreWidth = nextWidth
    return changed
  }

  /**
   * 关闭最后一个面板前的 rail 预算。
   *
   * 必须在 PanelLayoutController 调 `applyInitialLayout()` 之前执行：
   * 先把 rail 原生宽度与页面布局参数切到恢复值，后面同一趟布局会直接计算
   * “面板已移除 + rail 已展开”的最终几何，不会先排收起态再补一次重排。
   */
  _prepareRailRestoreBeforePanelClose(): boolean {
    const restore = this._railRestoreExpanded
    if (restore === null) return false
    this._railRestoreExpanded = null
    if (!restore || isHorizontalRailPosition(this._railPosition)) return false
    const width = Math.max(RAIL_COLLAPSED_WIDTH, normalizeRailWidth(this._railRestoreWidth))
    const changed = this._railWidth !== width
    this._railWidth = width
    if (this._pageLayoutParams) this._pageLayoutParams.sidebarWidth = width
    return changed
  }

  /**
   * 设置 rail 原生视图的当前宽度。
   *
   * 这是“展开态 / 普通态 / 拖拽预览”共用的唯一入口：宽度由 rail 渲染层提交，
   * 主进程负责夹取区间、同步页面布局参数并立即重排。设置持久化不在本方法里发生，
   * 因而拖拽期间可逐帧调用而不会触发设置广播风暴。
   */
  setRailWidth(px: number): boolean {
    const width = normalizeRailWidth(px)
    const widthChanged = width !== this._railWidth
    const layoutStale = !!this._pageLayoutParams && this._pageLayoutParams.sidebarWidth !== width
    if (!widthChanged && !layoutStale) return false
    this._railWidth = width
    if (this._pageLayoutParams) this._pageLayoutParams.sidebarWidth = width
    this.applyInitialLayout({ immediate: true })
    return widthChanged
  }

  /**
   * 设置工具图标栏（rail）的位置与按钮起始边。**唯一入口**：
   *   · position：left / right（纵向列）/ top / bottom（横向条）
   *   · horizontalAlign：left / right —— 横向时决定 rail 偏左还是偏右（面板随之开侧）
   *   · verticalAlign：top / bottom —— 纵向时决定按钮从头还是从下排
   *
   * 三件事在这里一次落定：rail 自己的轴向、面板所在侧、网页侧栏跟随侧。
   * 布局只重算一次，避免"改位置 → 排一次，改起始边 → 再排一次"的抖动。
   *
   * @param {{position?:string, horizontalAlign?:string, verticalAlign?:string}} next
   * @returns {boolean} 是否有实际变化
   */
  setRailLayout(next: RailLayoutOptions = {}): boolean {
    const position = normalizeRailPosition(
      next.position != null ? next.position : this._railPosition
    )
    const horizontalAlign = normalizeRailHorizontalAlign(
      next.horizontalAlign != null ? next.horizontalAlign : this._railHorizontalAlign
    )
    const verticalAlign = normalizeRailVerticalAlign(
      next.verticalAlign != null ? next.verticalAlign : this._railVerticalAlign
    )
    if (
      position === this._railPosition &&
      horizontalAlign === this._railHorizontalAlign &&
      verticalAlign === this._railVerticalAlign
    ) {
      return false
    }
    const beforeWebSidebarSide = this.getWebSidebarSide()
    this._railPosition = position
    this._railHorizontalAlign = horizontalAlign
    this._railVerticalAlign = verticalAlign
    // 换成横向条时，贴边唤出态立刻归位；留着它会在切回纵向后莫名复现。
    if (isHorizontalRailPosition(position)) {
      this._railRevealed = false
      this._syncRailLayerVisibility()
    }
    this._sidebarPosition = resolveRailPanelSide(position, horizontalAlign)
    // applyInitialLayout 读的是 `_pageLayoutParams.sidebarSide`，这里必须同步，
    // 否则要等渲染层下一次上报才生效（设置页会"点了没反应"）。
    if (this._pageLayoutParams) {
      this._pageLayoutParams.sidebarSide = this._sidebarPosition
      this._pageLayoutParams.railPosition = position
      this._pageLayoutParams.railHorizontalAlign = horizontalAlign
      this._pageLayoutParams.railVerticalAlign = verticalAlign
    }
    this.applyInitialLayout()
    /**
     * ⚠ 工具区换边时，**自动模式**下的网页侧栏也跟着换边（它俩是"跟随"关系：
     * 从哪边点开就从哪边出来）。这时侧栏的实际侧别变了，必须把新事实投影出去 ——
     * 否则聚焦框与顶条把手还停在原来那条边（用户看到"工具区挪过去了，侧栏的框还在老地方"）。
     */
    if (this.getWebSidebarSide() !== beforeWebSidebarSide) this._notifyWebSidebarSide()
    return true
  }

  /** 当前 rail 布局（位置 + 两条起始边）。 */
  getRailLayout() {
    return {
      position: this._railPosition,
      horizontalAlign: this._railHorizontalAlign,
      verticalAlign: this._railVerticalAlign
    }
  }

  /** 面板（工具区）所在侧 —— 由 rail 位置 + 起始边解算的唯一结果。 */
  getSidebarPosition() {
    return this._sidebarPosition
  }

  /**
   * 切换 rail 固定态（navbar 的图钉按钮）。
   *
   * **职责边界：本方法只管 rail 自己。** panel 的显隐是 panel 自己的事
   * （`showPanel` / `hidePanel` / `togglePanel`），rail 不得代劳 ——
   * 收起 rail 不等于"关闭当前面板"，两者是相互独立的状态。
   *
   * - 取消固定：rail 静止宽 0；指针贴边时按 rail 自身宽度占位唤出；
   * - 固定：rail 常驻可见并持续占位。
 *
   * @returns {{ visible: boolean, pinned: boolean, width: number }}
 */
  toggleRail() : { visible: boolean; pinned: boolean; width: number } {
    return this.setRailPinned(!this._railPinned)
  }

  /** 设置 rail 固定态；固定态是主进程唯一真源，不跟随 renderer 布局上报回写。 */
  setRailPinned(pinned: boolean): { visible: boolean; pinned: boolean; width: number } {
    const next = Boolean(pinned)
    if (next === this._railPinned) {
      if (next && this._railRevealed) {
        this._railRevealed = false
        this._syncRailLayerVisibility()
        this.applyInitialLayout()
      }
      return { visible: this._railPinned, pinned: this._railPinned, width: this._railWidth }
    }
    this._railPinned = next
    if (next) this._railRevealed = false
    this._syncRailLayerVisibility()
    this.applyInitialLayout()
    return { visible: this._railPinned, pinned: this._railPinned, width: this._railWidth }
  }

  isRailPinned() {
    return this._railPinned
  }

  /** rail 图层只在常驻固定或贴边唤出时显示；挂载后只切可见性，避免页面反复重载。 */
  _syncRailLayerVisibility() {
    if (!this._railView) return
    const visible = this._railPinned || this._railRevealed
    const layer = this._getLayer('rail')
    if (layer) layer.setVisible(visible)
    else { try { this._railView.setVisible(visible) } catch (_) {} }
  }

  /**
   * 未固定 rail 的指针巡看启停。
   *
   * 网页是原生 WebContentsView，会吞掉外壳 DOM 的 hover；因此 rail 与全功能侧栏一样，
   * 必须由主进程读取屏幕指针来决定「是否进入目标侧唤醒带」。
   */
  _syncRailRevealWatch() {
    const need = this._windowInteractive() &&
      !this._chromeHidden() &&
      !this._editingPresentation &&
      !this._railPinned &&
      !this._sideRevealSuspended &&
      !this.isFloatVisible('buttons-edit-overlay')

    if (!need) {
      this._stopRailRevealWatch()
      if (!this._sideRevealHold && this._railRevealed) {
        this._railRevealed = false
        this._syncRailLayerVisibility()
        setTimeout(() => {
          try { this.applyInitialLayout({ immediate: true }) } catch (_) {}
        }, 0)
      }
      return
    }

    if (this._railRevealWatch) return
    this._railRevealWatch = setInterval(() => {
      try { this._tickRailReveal() } catch (_) {}
    }, RAIL_REVEAL_TICK_MS)
    if (typeof this._railRevealWatch.unref === 'function') this._railRevealWatch.unref()
  }

  /** 主进程侧的一次 rail 唤醒判定。 */
  _tickRailReveal() {
    if (this._sideRevealHold || this._sideRevealSuspended) return
    if (!this._railPinned && this._windowInteractive() && !this._chromeHidden()) {
      const content = this._win.getContentBounds()
      if (content && content.width > 0 && content.height > 0) {
        const point = screen.getCursorScreenPoint()
        const x = point.x - content.x
        const y = point.y - content.y
        if (x < 0 || y < 0 || x > content.width || y > content.height) return

        const now = Date.now()
        const horizontal = isHorizontalRailPosition(this._railPosition)
        const side = this._sidebarPosition
        const revealSize = horizontal
          ? RAIL_BAR_SIZE
          : Math.max(RAIL_COLLAPSED_WIDTH, this._railWidth)
        const inTriggerBand = horizontal
          ? (this._railPosition === 'top'
              ? y <= IMMERSIVE_EDGE_PX
              : y >= content.height - IMMERSIVE_EDGE_PX)
          : (side === 'left'
              ? x <= IMMERSIVE_EDGE_PX
              : x >= content.width - IMMERSIVE_EDGE_PX)
        const inKeepBand = horizontal
          ? (this._railPosition === 'top'
              ? y <= revealSize + RAIL_REVEAL_KEEP_MARGIN_PX
              : y >= content.height - revealSize - RAIL_REVEAL_KEEP_MARGIN_PX)
          : (side === 'left'
              ? x <= revealSize + RAIL_REVEAL_KEEP_MARGIN_PX
              : x >= content.width - revealSize - RAIL_REVEAL_KEEP_MARGIN_PX)

        if (!this._railRevealed) {
          this._railRevealLeaveAt = 0
          if (inTriggerBand) this._applyRailReveal(true)
          return
        }

        if (inKeepBand) {
          this._railRevealLeaveAt = 0
          return
        }
        if (!this._railRevealLeaveAt) {
          this._railRevealLeaveAt = now
          return
        }
        if (now - this._railRevealLeaveAt >= RAIL_REVEAL_HIDE_DELAY_MS) {
          this._applyRailReveal(false)
        }
        return
      }
    }
    this._syncRailRevealWatch()
  }

  /** 停掉 rail 指针巡看（幂等）。 */
  _stopRailRevealWatch() {
    this._railRevealLeaveAt = 0
    if (!this._railRevealWatch) return
    clearInterval(this._railRevealWatch)
    this._railRevealWatch = null
  }

  /**
   * 未固定 rail 的贴边唤出开合。
   *
   * 触发源：本类的主进程指针巡看在窗口边缘命中后调用本方法；
   * 网页原生视图不会吞掉这条判定。
   *
   * **只在 rail 未固定时生效**。与全功能侧栏悬停唤出同口径：唤出即计入轨道宽度，
   * 网页真实让位；离开后恢复 0，而不是覆盖网页。
   * @param {boolean} revealed
   * @returns {{ revealed: boolean }}
   */
  setRailReveal(revealed: boolean): { revealed: boolean } {
    // chrome 整体收起时（全屏 / 沉浸模式）网页铺满整窗，渲染层**收不到指针事件** ——
    // 它那声"指针走了"会在下一帧把主进程刚按屏幕坐标唤出的 rail 又收回去。
    // 所以这条（渲染层）路径在收起态一律忽略，唤出改由主进程贴边巡看驱动（见 _tickImmersive）。
    if (this._chromeHidden()) return { revealed: this._railRevealed }
    return this._applyRailReveal(revealed)
  }

  /** 真正改 rail 贴边唤出态（渲染层路径与主进程贴边巡看共用一份实现）。 */
  _applyRailReveal(revealed: boolean): { revealed: boolean } {
    const next = Boolean(revealed) && !this._railPinned
    if (next === this._railRevealed) return { revealed: this._railRevealed }
    this._railRevealed = next
    this._syncRailLayerVisibility()
    this.applyInitialLayout({ immediate: true })
    return { revealed: this._railRevealed }
  }

  /**
   * chrome（顶栏 / 侧栏 / rail / 底部栏）此刻是否**整体收起**。
   *
   * 两个来源共用这一条口径（散成两个布尔必然漂移，表现就是"全屏时界面唤不出来"）：
   *   · **全屏**（F11 / HTML5 全屏）—— 界面让位给内容，浏览器一贯行为；
   *   · **沉浸模式**（设置 app.immersive_mode）—— 学 HiraRT：所有 UI 收起，
   *     鼠标贴到窗口边缘才把对应那一块唤出来。
   * 两者的呈现与唤出方式完全一样，所以判据也合成一条。
   */
  _chromeHidden() {
    if (this._editingPresentation) return false
    // 全屏判据与贴边共用 `_isEdgeToEdge()`：两处各写一份，迟早出现"界面收了但网页没贴边"。
    return this._isEdgeToEdge() || this._pageLayoutParams.immersiveMode === true
  }

  /**
   * 订阅「chrome 收起、窗口拖拽区必须让位」的事实。
   *
   * 判据与布局共用 `_chromeHidden()` / `_immersiveRevealed`，不在宿主侧重算；
   * 订阅时立即校准一次，避免渲染层晚挂载时停留在错误状态。
   * @param {((suppressed: boolean) => void) | null} fn
   */
  setChromeDragSuppressedListener(fn: ((suppressed: boolean) => void) | null): void {
    this._chromeDragSuppressedListener = typeof fn === 'function' ? fn : null
    const suppressed = this._chromeHidden() && !this._immersiveRevealed
    this._lastChromeDragSuppressed = suppressed
    if (this._chromeDragSuppressedListener) {
      try { this._chromeDragSuppressedListener(suppressed) } catch (_) {}
    }
  }

  /** 把拖拽让位态收敛到当前布局（只在跳变时外发）。 */
  _syncChromeDragSuppressed(): void {
    const suppressed = this._chromeHidden() && !this._immersiveRevealed
    if (suppressed === this._lastChromeDragSuppressed) return
    this._lastChromeDragSuppressed = suppressed
    if (!this._chromeDragSuppressedListener) return
    try { this._chromeDragSuppressedListener(suppressed) } catch (_) {}
  }

  /**
   * 维护"贴边唤出"的指针巡看：仅 chrome 收起时需要。
   *
   * 为什么必须在主进程判定：chrome 是**窗口本体**，天然在所有子视图之下；界面收起时
   * 网页（原生 WebContentsView）铺满整窗 → 渲染层这时收不到任何指针事件，
   * 「鼠标hover过去才显示」在那里根本无从判定。主进程手里有矩形、也读得到屏幕指针位置。
   *
   * 唤出的都是**已经存在的那几块**，不另造浮层：任一条边缘触发，整套界面一起回来
   * （顶栏 + 底部栏 + 侧栏区 + rail + 面板，见 _tickImmersive）。
   * 由 applyInitialLayout 每次收尾时调用（收敛点只有一处）。
   */
  _syncImmersiveWatch() {
    // 不在前台可交互（失焦 / 最小化 / 隐藏）：只停表，**不动**唤出态。
    // 「指针贴着窗缘」在窗口不是前台时无从谈起，80ms 的表纯属空转；
    // 而已唤出的界面保持原样，回焦后由窗口事件重新进本函数，该收的才收。
    if (!this._windowInteractive()) {
      if (this._immersiveWatch) {
        clearInterval(this._immersiveWatch)
        this._immersiveWatch = null
      }
      return
    }
    if (this._chromeHidden()) {
      if (!this._immersiveWatch) {
        this._immersiveWatch = setInterval(() => {
          try { this._tickImmersive() } catch (_) {}
        }, IMMERSIVE_TICK_MS)
        if (typeof this._immersiveWatch.unref === 'function') this._immersiveWatch.unref()
      }
      return
    }
    if (this._immersiveWatch) {
      clearInterval(this._immersiveWatch)
      this._immersiveWatch = null
    }
    // 退出收起态：只归位沉浸态。rail 的贴边唤出由独立的 rail 巡看维护，
    // 这里若一并清除，会在每次布局收尾时形成「展开 → 清掉 → 再展开」的闪烁环。
    this._immersiveRevealed = false
  }

  /**
   * 侧栏那一叠在**外缘侧**的总占宽（侧栏区 + rail + 该侧面板）。
   * 推挤式唤出时用它回答"指针还在这一叠里吗"（在里面就不收起）。
   */
  _immersiveSideStackWidth() {
    const params = this._pageLayoutParams
    const side = this._resolvedSideColumnSide()
    const column = getSideColumnWidth(params, this._immersiveRevealed || this._sideRevealed)
    const rail = (this._railPinned || this._railRevealed) ? this._railWidth : 0
    const panel = this._panelSlots[side] ? Math.max(0, Number(this._panelWidths[side]) || 0) : 0
    const pinned = this._panelPinned[side] ? Math.max(0, Number(this._pinnedWidths[side]) || 0) : 0
    return Math.max(0, column + rail + panel + pinned)
  }

  /** 一次贴边判定（只在 chrome 收起时被 _syncImmersiveWatch 的定时器调用）。 */
  _tickImmersive() {
    const win = this._win
    if (!win || win.isDestroyed()) {
      // 窗口已销毁：巡看没必要再跑（本定时器无人再管，自己收尾）。
      if (this._immersiveWatch) {
        clearInterval(this._immersiveWatch)
        this._immersiveWatch = null
      }
      return
    }
    if (!this._chromeHidden()) return
    const content = win.getContentBounds()
    if (!content || content.width <= 0 || content.height <= 0) return
    const point = screen.getCursorScreenPoint()
    const x = point.x - content.x
    const y = point.y - content.y
    // 指针不在本窗口内：既不唤出、也不催收（可能只是移去了别的窗口 / 另一块屏幕）。
    if (x < 0 || y < 0 || x > content.width || y > content.height) return

    // ── 贴边唤出：**任一条边缘**都能触发，且整套界面**一起出/一起收** ──
    // 判据分两半：触发（贴到边缘）与保持（指针仍在这套界面里）。
    // 保持那一圈 = 被唤出的界面自己占的区域（顶栏 / 底部栏 / 侧栏那一叠），
    // 于是指针移进界面继续操作时不会被立刻收起。
    const params = this._pageLayoutParams
    const side = this._resolvedSideColumnSide()
    const topbarHeight = Math.max(0, Math.round(params.topbarHeight) || 0)
    const bottombarHeight = Math.max(0, Math.round(params.bottombarHeight) || 0)
    const stack = this._immersiveSideStackWidth()
    const atEdge = y <= IMMERSIVE_EDGE_PX ||
      y >= content.height - IMMERSIVE_EDGE_PX ||
      (side === 'left' ? x <= IMMERSIVE_EDGE_PX : x >= content.width - IMMERSIVE_EDGE_PX)
    const insideChrome = y <= topbarHeight + IMMERSIVE_EDGE_PX ||
      y >= content.height - bottombarHeight - IMMERSIVE_EDGE_PX ||
      (side === 'left' ? x <= stack + IMMERSIVE_EDGE_PX : x >= content.width - stack - IMMERSIVE_EDGE_PX)
    const want = atEdge || (this._immersiveRevealed && insideChrome)
    if (want === this._immersiveRevealed) return
    this._immersiveRevealed = want
    // 沉浸模式与侧栏自动隐藏不是两套互斥 UI：
    // chrome 被贴边唤出时，自动隐藏的侧栏也必须一起进入“已展开”态，
    // 否则 tab 列表仍按 restWidth=0/图标条预算，整块 chrome 出现但列表是空白。
    const sideShouldExpand = want &&
      !this._sideRevealHold &&
      params.sideColumnAutoHide === true &&
      params.sideColumnVisible !== false
    if (sideShouldExpand !== this._sideRevealed) this._setSideRevealed(sideShouldExpand)
    // ⚠ **必须 immediate**：默认那条路会让网页走 BoundsTween 弹簧 —— 逐帧改原生
    // `WebContentsView#setBounds`（渲染进程每帧重建交换链）必然掉帧。界面展开/收起
    // 要的是"一下到位"（全屏工具栏也是这么切的），不是补间。
    this.applyInitialLayout({ immediate: true })
  }

  isRailRevealed() {
    return this._railRevealed
  }

  /**
   * 某独立浮层的交互区域切换。
   * - interactive=true: 该浮层 view 捕获鼠标事件
   * - interactive=false: 透传鼠标事件到下层
   *
   * 每个浮层独立控制，互不影响（不再有单一的全局 overlay 交互开关）。
   *
   * @param {string} name 浮层逻辑名
   * @param {boolean} interactive
   */
  setFloatInteractive(name: string, interactive: boolean): void {
    const key = String(name)
    const v = this._floatViews.get(key)
    if (!v) return
    const next = Boolean(interactive)
    if (this._floatInteractive.get(key) === next) return
    this._floatInteractive.set(key, next)
  }

  /**
   * 按**当前屏幕指针**往某浮层补一条合成 `mousemove` —— 让展开动画期间的 hover 连贯
   *（理由完整版见 `FLOAT_HOVER_PROBE_MS`：clip-path 连命中区一起裁，指针不动就没有 hover）。
   *
   * 坐标换算与巡看同一口径：`屏幕指针 − 窗口内容区原点 − 浮层 bounds 原点` = 视图内坐标
   * （浮层 bounds 用的就是内容区坐标，见 `setFloatBounds`）。
   *
   * @param {string} name 浮层逻辑名
   * @returns {boolean} 是否真的投出去了一条（不可见 / 指针不在浮层上 → false）
   */
  probeFloatHover(name: string): boolean {
    const key = String(name)
    const wc = this.getFloatWebContents(key)
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false
    const b = this._floatBounds.get(key)
    if (!b || b.width <= 0 || b.height <= 0) return false
    const win = this._win
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false
    try {
      const content = win.getContentBounds()
      if (!content) return false
      const point = screen.getCursorScreenPoint()
      const x = Math.round(point.x - content.x - b.x)
      const y = Math.round(point.y - content.y - b.y)
      // 指针不在这个浮层上：什么也不做（不能给一块指针不在上面的浮层凭空造 hover）。
      if (x < 0 || y < 0 || x >= b.width || y >= b.height) return false
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      return true
    } catch (_) {
      return false
    }
  }

  /**
   * 浮层显隐跳变到「显示」那一拍起一段探针表（自停，见 `FLOAT_HOVER_PROBE_MS`）。
   * @param {string} name 浮层逻辑名
   */
  _startFloatHoverProbe(name: string): void {
    this._stopFloatHoverProbe()
    // 第一拍立刻投：动画还没走到"命中区覆盖指针"之前，至少 hover 状态机已经从这一刻起算。
    this.probeFloatHover(name)
    const ticks = Math.ceil(FLOAT_HOVER_PROBE_MS / FLOAT_HOVER_PROBE_TICK_MS)
    let fired = 0
    this._floatHoverProbe = setInterval(() => {
      fired += 1
      this.probeFloatHover(name)
      if (fired >= ticks) this._stopFloatHoverProbe()
    }, FLOAT_HOVER_PROBE_TICK_MS)
    if (typeof this._floatHoverProbe.unref === 'function') this._floatHoverProbe.unref()
  }

  /** 停探针表（幂等）。 */
  _stopFloatHoverProbe() {
    if (!this._floatHoverProbe) return
    clearInterval(this._floatHoverProbe)
    this._floatHoverProbe = null
  }

  /**
   * 重判「此刻是否有浮层压在 chrome 拖拽带上」，只在**跳变**时通知宿主（见 `_floatDragGuardListener`）。
   *
   * 判据只有一条几何事实：**屏幕上有矩形 ∩ `_chromeDragBands` ≠ ∅**。它同时覆盖两种浮层 ——
   *   · 交互式（侧栏浮出层 / 模态菜单）：点击本会落在浮层自己身上，但 Chromium 的
   *     drag 命中区是**窗口级合并**的，下层标题栏照样把这一下当成拖动；
   *   · 穿透式（标签预览卡）：点击直接穿到下层视图，落在哪条拖拽带上就拖哪条。
   * 两类在这一条规则下不再分家 —— 不需要任何浮层名单，新增浮层自动被覆盖。
   *
   * 只在跳变时广播：浮层随滚动 / 悬停扫过多个锚点时矩形一直变，若每拍都发一条，
   * 各 chrome 图层就要反复切类（那些图层是独立渲染进程，白付一串 IPC + 样式重算）。
   */
  _syncFloatDragGuard() {
    let open = false
    for (const b of this._floatBounds.values()) {
      if (!b || b.width <= 0 || b.height <= 0) continue
      if (this._rectHitsChromeDrag(b)) { open = true; break }
    }
    if (open === this._floatDragGuardOpen) return
    this._floatDragGuardOpen = open
    if (this._floatDragGuardListener) {
      try { this._floatDragGuardListener(open) } catch (_) {}
    }
  }

  /** 矩形是否压到任一拖拽带（半开区间：相切不算压到）。 */
  _rectHitsChromeDrag(rect: Rectangle): boolean {
    const rx2 = rect.x + rect.width
    const ry2 = rect.y + rect.height
    for (const band of this._chromeDragBands) {
      if (rect.x < band.x + band.width && band.x < rx2 &&
          rect.y < band.y + band.height && band.y < ry2) return true
    }
    return false
  }

  /**
   * 登记「浮层压在 chrome 拖拽带上」观察者（宿主用它把事实广播给各 chrome 图层）。
   *
   * 传 null 可解绑。同一时刻只保留一个观察者 —— 多窗口下每个 LayoutCoordinator
   * 各有一份，天然按窗口隔离（见 window-chrome）。
   *
   * @param {((open: boolean) => void) | null} fn
   */
  setFloatDragGuardListener(fn: ((open: boolean) => void) | null): void {
    this._floatDragGuardListener = typeof fn === 'function' ? fn : null
  }

  /**
   * 登记「浮层外部点击收起」观察者（宿主注入）。
   *
   * 传 null 可解绑。与交互态监听同款：每个窗口一份，按窗口天然隔离。
   * @param {((name: string) => void) | null} fn
   */
  setFloatDismissListener(fn: ((name: string) => void) | null): void {
    this._floatDismissListener = typeof fn === 'function' ? fn : null
    this._syncFloatDismissSources()
  }

  /**
   * 声明某浮层「用户点它外面就收起」。
   *
   * 与 `hideFloat` 的分工：这里只负责**侦测**并把事实回调给宿主；真正收起
   * 必须由宿主走 `hideFloat`（那里才会给 renderer 发 hide、给外壳发 overlay:closed）。
   * 这样默认收起动作仍然是单一权威路径，不会出现"浮层收了但宿主以为还开着"。
   *
   * @param {string} name 浮层逻辑名
   * @param {boolean} enabled
   */
  setFloatDismissOnOutside(name: string, enabled: boolean): void {
    const key = String(name)
    if (enabled) this._floatDismissOutside.add(key)
    else this._floatDismissOutside.delete(key)
    this._syncFloatDismissSources()
  }

  /** 该浮层此刻是否**逻辑可见且真的在屏上**（用户能看见、能点、能拿到键盘）。 */
  _isFloatShown(name: string): boolean {
    return this.isFloatVisible(name) && this._isFloatOnScreen(name)
  }

  /** 当前是否有「可外部点击收起」的浮层在屏上。 */
  _hasDismissableFloatOnScreen() {
    if (!this._floatDismissListener) return false
    for (const name of this._floatDismissOutside) {
      if (this._isFloatShown(name)) return true
    }
    return false
  }

  /**
   * 按需挂 / 解挂来源视图的 mouseDown 侦听（幂等）。
   *
   * 只在**有可收起浮层在屏上**期间挂载：`input-event` 连 mousemove 都会派发，
   * 常态挂着就是给每次鼠标移动加一次主进程回调 —— 与"极致跟手"直接冲突。
   */
  _syncFloatDismissSources(): void {
    if (!this._hasDismissableFloatOnScreen()) {
      if (this._floatDismissBound.size > 0) this._unbindFloatDismissSources()
      return
    }
    // **外壳（win.webContents）刻意排除**：外壳是浮层的持有者（address bar / tabbar /
    // bookmark bar 全在它的 DOM 里），由它自己的 pointerdown 处理收起 —— 那里认得
    // 「打开浮层的那个按钮」，能正确地放行（否则 mousedown 先收起、click 再 toggle，
    // 点开关会变成"关不掉、只会重开"）。
    // 这里只兜住外壳**看不到**的独立视图：网页标签、rail、面板侧栏。
    const shellWc = this.getUiShellWebContents()
    /** 该挂的来源集合 */
    const targets = new Set<WebContents>()
    const add = (wc: WebContents) => {
      if (!wc) return
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return
      if (shellWc && wc === shellWc) return
      targets.add(wc)
    }
    if (this._wcm && typeof this._wcm.listChromeWebContents === 'function') {
      for (const wc of this._wcm.listChromeWebContents()) add(wc)
    }
    // 标签**只挂当前可见的那几个**（通常 1 个，分屏 2 个）。
    //
    // 为什么不挂全部标签：`input-event` 连 mousemove 都会派发 —— 挂到 N 个标签
    // 就是「每次鼠标移动都有 N 个 renderer 跨进程回调主进程」，是纯粹的延迟税。
    // 而**隐藏的标签根本不可能被点到**（原生视图不可见 = 收不到输入），挂了毫无作用。
    // 可见集合变化时由 `_setVisibleTabs` 补一次 re-sync（那条路径同时覆盖切标签 / 分屏）。
    if (this._wcm && typeof this._wcm.getTab === 'function') {
      const ids = this._visibleTabIds.size > 0
        ? this._visibleTabIds
        : (this._activeTabId ? [this._activeTabId] : [])
      for (const tabId of ids) {
        const view = this._wcm.getTab(tabId)
        if (view) add(view.webContents)
      }
    }
    // 集合没变 → 已挂的就是对的（布局每趟都会走到这里，能省一次遍历就省）。
    let same = targets.size === this._floatDismissBound.size
    if (same) {
      for (const wc of targets) {
        if (!this._floatDismissBound.has(wc)) { same = false; break }
      }
    }
    if (same) return
    // 集合变了 → **只做差集**：解挂离场的、挂上新增的。整体清空重挂会让"稳定来源"
    // 的侦听在一次布局里被摘了又挂（多两次原生注册/注销），完全没必要。
    // 顺带清掉已销毁的 wc 引用（它们必然不在 targets 里，不 leave 到窗口关闭）。
    for (const [wc, handler] of this._floatDismissBound) {
      if (targets.has(wc)) continue
      try {
        if (!(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
          ;(wc as unknown as InputEventPort).removeListener('input-event', handler)
        }
      } catch (_) {}
      this._floatDismissBound.delete(wc)
    }
    for (const wc of targets) this._bindFloatDismissSource(wc)
  }

  _bindFloatDismissSource(wc: WebContents): void {
    if (this._floatDismissBound.has(wc)) return
    const handler = (_event: ElectronEvent, input: Input) => {
      // 只认按下：mousemove / wheel 不该收起浮层（用户可能只是扫过页面）。
      if (!input || input.type !== 'mouseDown') return
      this._handleFloatDismissPointer(wc)
    }
    try {
      ;(wc as unknown as InputEventPort).on('input-event', handler)
      this._floatDismissBound.set(wc, handler)
    } catch (_) {}
  }

  _unbindFloatDismissSources() {
    for (const [wc, handler] of this._floatDismissBound) {
      try {
        if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue
        ;(wc as unknown as InputEventPort).removeListener('input-event', handler)
      } catch (_) {}
    }
    this._floatDismissBound.clear()
  }

  /** 某来源视图上按下鼠标 → 通知宿主收起所有「在屏且不是它自己」的可收起浮层。 */
  _handleFloatDismissPointer(sourceWc: WebContents): void {
    if (!this._floatDismissListener) return
    for (const name of this._floatDismissOutside) {
      if (!this._isFloatShown(name)) continue
      if (this.getFloatWebContents(name) === sourceWc) continue
      try { this._floatDismissListener(name) } catch (_) {}
    }
  }

  /**
   * 按需 resize 某个独立浮层 view 到实际区域（searchbar 下拉 / tab preview / permission）。
   * 每个浮层各管各的 bounds，绝不复用 —— 显示时不重置其它浮层。
   *
   * @param {string} name 浮层逻辑名
   * @param {{ x: number, y: number, width: number, height: number }} rect
   *        传 { width: 0, height: 0 } 收起该浮层
   * @param {{ keepFocus?: boolean }} [options] keepFocus：收起时不让位焦点
   *        （建议下拉因清空输入而消失 —— 不能让键盘焦点落到网页上，否则地址栏失焦）
   */
  setFloatBounds(name: string, rect: Partial<Rectangle>, options: { keepFocus?: boolean } = {}): void {
    const bounds = {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0
    }
    this._floatBoundsController.set(name, bounds, options)
  }

  /** 获取某独立浮层 webContents（供 IPC 转发用） */
  getFloatWebContents(name: string): WebContents | null {
    const v = this._floatViews.get(String(name))
    return v ? v.webContents : null
  }

  raiseFloatView(name: string): boolean {
    const key = String(name)
    const layer = this._getLayer(`float:${key}`)
    // 走 LayerManager：addChildView 对已存在子 view 等价于「移到顶层」，
    // 同时同步内部 oldLayers 顺序，避免下一次增量重排误判前缀。
    if (layer) return this._layers.raiseLayer(layer)
    const view = this._floatViews.get(key)
    if (!view || !this._win || this._win.isDestroyed()) return false
    try {
      this._contentView().addChildView(view)
      return true
    } catch (e) {
      console.error(`[layout] raiseFloatView(${key}) failed:`, errorMessage(e))
      return false
    }
  }

  /**
   * 把某独立浮层居中对齐到主窗口（水平+垂直）。
   * 区别于 setFloatBounds：它用主进程窗口 content 尺寸定位，不依赖 ui-shell 上报坐标。
   * @param {string} name 浮层逻辑名
   * @param {{ width: number, height: number }} rect 浮层自身尺寸
   */
  centerFloat(name: string, rect: Partial<Rectangle>): void {
    const key = String(name)
    const v = this._floatViews.get(key)
    if (!v || !this._win || this._win.isDestroyed()) return
    try {
      const [cw, ch] = typeof this._win.getContentSize === 'function' ? this._win.getContentSize() : [0, 0]
      const w = Math.max(0, Math.floor(rect.width || 0))
      const h = Math.max(0, Math.floor(rect.height || 0))
      const x = Math.max(0, Math.round((cw - w) / 2))
      const y = Math.max(0, Math.round((ch - h) / 2))
      this.setFloatBounds(key, { x, y, width: w, height: h })
    } catch (e) {
      console.error(`[layout] centerFloat(${key}) failed:`, errorMessage(e))
    }
  }

  /**
   * 把某独立浮层锚定在**网页矩形内部**（查找栏 / 缩放条 / 悬停 URL 用的就是这条）。
   *
   * ── 为什么要贴网页而不是贴窗口 ────────────────────────────────────────
   * 这三条都是"网页的附着物"：查找栏在网页右上角、缩放条在网页顶部居中、悬停 URL 在
   * 网页左下角（对齐 RT `TargetUrlIndicator` 的 left + bottom + PADDING）。rail / 面板 /
   * 顶栏都会把网页挤开，用窗口坐标算就会跑到工具栏底下或被面板压住。网页矩形的唯一
   * 真源就在本类（`_lastPageBounds`，每次布局算出来的那一份）—— renderer 量不到原生
   * 视图的位置，所以落位必须在这里做，尺寸仍由 renderer 量后上报。
   *
   * 网格不足时（网页比浮层还窄/矮）贴住网页左上角，绝不让浮层越出网页。
   *
   * @param {string} name 浮层逻辑名
   * @param {{ width:number, height:number, align?:'left'|'center'|'right',
   *           valign?:'top'|'bottom', margin?:number }} rect 浮层自身尺寸 + 对齐 + 间距
   */
  private _resolveInContentBounds(rect: FloatAnchorRequest = {}): Rectangle | null {
    if (!this._win || this._win.isDestroyed()) return null
    try {
      // 用**当前聚焦的那块网页面**矩形（侧栏聚焦时是侧栏，否则是活动格；分屏时是那一格）
      // ——见 `_focusedWebBounds`。若一律按整块内容区锚定，分屏下查找栏会横跨两格居中，
      // 侧栏聚焦时又会跑到旁边的标签页上去。
      const page = this._focusedWebBounds() || this._fallbackPageBounds()
      if (!page || !(page.width > 0) || !(page.height > 0)) return null
      const w = Math.max(0, Math.floor(rect.width || 0))
      const h = Math.max(0, Math.floor(rect.height || 0))
      if (!w || !h) return null
      const margin = Math.max(0, Math.floor(rect.margin || 0))
      const align = rect.align === 'left' ? 'left' : rect.align === 'right' ? 'right' : 'center'
      const x = align === 'left'
        ? page.x + margin
        : align === 'right'
          ? page.x + page.width - w - margin
          : page.x + Math.round((page.width - w) / 2)
      const y = rect.valign === 'bottom'
        ? page.y + page.height - h - margin
        : page.y + margin
      // 夹回网页矩形内（网页比浮层小时贴住左上角），再交给 setFloatBounds 做非负夹取。
      const clampedX = Math.max(page.x, Math.min(x, page.x + page.width - w))
      const clampedY = Math.max(page.y, Math.min(y, page.y + page.height - h))
      return { x: clampedX, y: clampedY, width: w, height: h }
    } catch (e) {
      console.error('[layout] resolve in-content float failed:', errorMessage(e))
      return null
    }
  }

  anchorFloatInContent(name: string, rect: FloatAnchorRequest = {}): void {
    const key = String(name)
    const v = this._floatViews.get(key)
    if (!v) return
    const out = this._resolveInContentBounds(rect)
    if (out) this.setFloatBounds(key, out)
  }

  /**
   * 把某独立浮层锚定到**锚点矩形的正下方**（地址栏 suggestion 下拉用的就是这条）。
   *
   * ── 为什么落位必须在主进程 ──────────────────────────────────────────
   * 对齐 RT `controllers/windows-controller/utils/browser/omnibox.ts` 的 `normalizeBounds`
   * + `addShadowPadding` 两段式：renderer（外壳）只上报**锚点事实**（地址栏在窗口里
   * 的 left/top/width/height）与**卡片实测尺寸**（含阴影留白的 outer 尺寸，由 renderer
   * 把 pad 一并计入）。窗口 content 尺寸只有主进程知道 —— 夹取（保证不越出窗口）也就
   * 只能在这里做。此前这条链走的是 `centerFloat`（整窗居中），于是下拉根本不贴地址栏。
   *
   * 尺寸契约（与 renderer 同源，不要在主进程再写一份卡片尺寸）：
   *   · `width` / `height` 是**含阴影留白**的 outer 尺寸（renderer 上报：cardW + 2*pad）；
   *   · `pad` 是四边留白（renderer 的卡片就画在 view 内的 pad 偏移处）；
   *   · 因此卡片实际宽高 = outer − 2*pad。这里先按卡片尺寸夹取，再加 pad 回展成 view bounds。
   *
   * @param {string} name 浮层逻辑名
   * @param {{ anchor?: {left?:number, top?:number, width?:number, height?:number,
   *           align?: 'left'|'right'|'center', valign?: 'below'|'center'},
   *           width?:number, height?:number, pad?:number, gap?:number, margin?:number }} rect
   *        margin：与窗口内容区四边的最小留白（缺省见 DEFAULT_FLOAT_EDGE_MARGIN）
   */
  anchorFloatBelow(name: string, rect: FloatAnchorRequest = {}): void {
    const key = String(name)
    const v = this._floatViews.get(key)
    if (!v || !this._win || this._win.isDestroyed()) return
    try {
      const [cw, ch] = typeof this._win.getContentSize === 'function' ? this._win.getContentSize() : [0, 0]
      if (!cw || !ch) return
      const a = (rect && rect.anchor) || {}
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : d)
      const perSide = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.max(0, Math.floor(Number(x))) : d)
      /**
       * 阴影留白：允许两种形态，**四边同宽**（一个数）或**四边各报**（对象）。
       *
       * 为什么必须允许各边不同：卡片阴影的方向就是留白的方向。
       *   · searchbar 下拉 —— 左右/下要留（阴影往四周洇），**上方不留**：
       *     上边留白会把整个 view 顶到地址栏下半截上，糊住输入框、还吃掉那块的点击；
       *   · 站点信息浮层 —— 阴影只往下投（`0 10px 16px -2px`），**上方不留**：
       *     顶上那圈留白是 view 的一部分、会把 navbar 下沿的点击吃掉；
       *     而左右/下方不足则阴影会被 view 边界**裁掉**（用户可见的"阴影断了一截"）。
       * 缺省仍按四边 30（历史值）—— 老调用点一字不用改。
       */
      const pad = rect.pad && typeof rect.pad === 'object'
        ? {
            top: perSide(rect.pad.top, 0),
            right: perSide(rect.pad.right, 30),
            bottom: perSide(rect.pad.bottom, 30),
            left: perSide(rect.pad.left, 30)
          }
        : (() => {
            const p = Math.max(0, Math.floor(num(rect.pad, 30)))
            return { top: p, right: p, bottom: p, left: p }
          })()
      const gap = Math.max(0, Math.floor(num(rect.gap, 0)))
      const outerW = Math.max(0, Math.floor(num(rect.width, 0)))
      const outerH = Math.max(0, Math.floor(num(rect.height, 0)))
      const cardW = Math.max(0, outerW - pad.left - pad.right)
      const cardH = Math.max(0, outerH - pad.top - pad.bottom)
      // 外边距先算：卡片本身也要留白，不能只裁 view 的外壳。
      const margin = Math.max(0, Math.min(
        Math.floor(num(rect.margin, DEFAULT_FLOAT_EDGE_MARGIN)),
        Math.floor(cw / 4),
        Math.floor(ch / 4)
      ))
      const minCardX = margin + pad.left
      const maxCardX = Math.max(
        Math.min(minCardX, Math.max(0, cw - cardW)),
        cw - margin - pad.right - cardW
      )
      // 展开方向由锚点声明：左栏向右、右栏向左扩张，常规横向栏保持左缘对齐。
      const align = a.align === 'right' ? 'right' : a.align === 'center' ? 'center' : 'left'
      const anchorLeft = num(a.left, 0)
      const anchorWidth = Math.max(0, num(a.width, cardW))
      const preferredX = align === 'right'
        ? anchorLeft + anchorWidth - cardW
        : align === 'center'
          ? anchorLeft + Math.round((anchorWidth - cardW) / 2)
          : anchorLeft
      const cardX = Math.min(Math.max(preferredX, minCardX), maxCardX)

      const anchorTop = num(a.top, 0)
      const anchorBottom = anchorTop + num(a.height, 0)
      const safeTop = margin + pad.top
      const safeBottom = Math.max(safeTop, ch - margin - pad.bottom)
      const maxCardY = Math.max(safeTop, safeBottom - cardH)
      const belowY = anchorBottom + gap
      let cardY = Math.max(safeTop, Math.min(belowY, maxCardY))

      // 底部导航栏没有足够的下方空间时，在输入框上方的安全区里垂直居中 ——
      // 既保持命令面板的完整高度，也绝不会压住搜索框本身。
      if (a.valign === 'center') {
        const centerTop = safeTop
        const centerBottom = anchorTop - gap
        if (centerBottom - centerTop >= cardH) {
          cardY = centerTop + Math.round((centerBottom - centerTop - cardH) / 2)
        }
      }

      // 外缘留白：卡片与阴影整体都不许贴窗口边；只裁最终 view，卡片坐标已按左右
      // 对称留白夹好，这样侧栏在右时不会比在左时少一截右边距。
      const maxRight = Math.max(margin, cw - margin)
      const maxBottom = Math.max(margin, ch - margin)
      const x = Math.min(Math.max(margin, cardX - pad.left), maxRight)
      const y = Math.min(Math.max(margin, cardY - pad.top), maxBottom)
      const right = Math.max(x, Math.min(cardX + cardW + pad.right, maxRight))
      const bottom = Math.max(y, Math.min(cardY + cardH + pad.bottom, maxBottom))
      this.setFloatBounds(key, { x, y, width: right - x, height: bottom - y })
    } catch (e) {
      console.error(`[layout] anchorFloatBelow(${key}) failed:`, errorMessage(e))
    }
  }

  /** 尚未跑过布局时（_lastPageBounds 为空）退化成整窗内容区，至少不会把浮层摆到窗外。 */
  _fallbackPageBounds() {
    const size = this.getWindowContentSize()
    if (!size) return null
    return { x: 0, y: 0, width: size.width, height: size.height }
  }

  /**
   * 「指针靠近就避让」——给**信息层**浮层用（当前唯一使用者：链接悬停 URL 提示条）。
   *
   * ── 为什么需要它（也正是"抖动"的根治）──────────────────────────────
   * 浮层是原生 `WebContentsView`：它**只要可见，就会吃掉自己矩形内的鼠标事件**
   * （`View` / `WebContentsView` 没有 `setIgnoreMouseEvents`，Electron 43 只有窗口有）。
   * 提示条贴在网页左下角，指针一旦压上去，网页那一小块就"失去指针"：
   *   页面 hover 态断掉（光标 pointer↔arrow 闪）→ 网页随即发出 `update-target-url` 空值
   *   → 提示条收起 → 指针又落回网页 → hover 恢复 → 提示条再次显示……**这就是抖动环**。
   * 从"输入侧"修不掉（根因是浮层吃鼠标这个物理事实）。换个方向：**指针靠近就主动让开**，
   * 让它永远没机会被压住。
   *
   * ── 机制（对齐 RT `cursor-edge-monitor.ts`）──────────────────────────
   * 主进程按 30fps 轮询 `screen.getCursorScreenPoint()` —— 指针位置只有系统知道：
   * 被浮层吃掉的那部分移动，网页侧根本收不到，拿不到可靠坐标。
   * 指针进入「浮层矩形 + pad」→ 立刻把它收起来，并**在指针离开该矩形之前拒绝恢复**
   * （这一步才是打断抖动环的关键）；离开后回调 `onRestore`，由宿主决定要不要重新显示。
   *
   * 轮询**只在必要时跑**：这张表为空、或所有条目都既不可见也不在避让态时**完全停表** ——
   * 零常态开销（同 RT：没有活跃订阅者就不轮询）。
   *
   * @param {string} name 浮层逻辑名
   * @param {{ pad?: number, onAvoid?: (() => void) | null, onRestore?: (() => void) | null }} [opts]
   *        pad：指针距浮层边界多少像素内算"靠近"（默认 16）
   *        onAvoid：刚让开时回调（宿主在这里**通知渲染页复位内部状态** —— 本类只收几何，
   *                 渲染页的"我在显示"态住在它自己那边，不复位的话同一内容再推过去
   *                 会被它按"内容没变"挡掉，表现为让开之后再也回不来）
   *        onRestore：指针离开后回调（宿主通常在这里把内容重新推一遍以恢复显示）
   */
  setFloatPointerAvoid(name: string, opts: { pad?: number; onAvoid?: () => void; onRestore?: () => void } = {}): void {
    const key = String(name)
    if (!this._floatViews.has(key)) return
    this._pointerAvoid.set(key, opts)
  }

  clearFloatPointerAvoid(name: string): void {
    this._pointerAvoid.clear(name)
  }

  isFloatPointerAvoided(name: string): boolean {
    return this._pointerAvoid.isAvoided(name)
  }

  _ensurePointerAvoidTimer() {
    this._pointerAvoid.ensure()
  }

  _stopPointerAvoidTimer() {
    this._pointerAvoid.stop()
  }

  _tickPointerAvoid() {
    this._pointerAvoid.tick()
  }

  /**
   * 网页区域矩形（窗口内容区坐标）—— `applyInitialLayout` 每次算出来的那一份。
   *
   * 用途：宿主需要"网页有多大"这类事实时（悬停 URL 的胶囊最宽 = 网页宽的 60%，
   * 见 RT TargetUrlIndicator），不必自己在 apps 层重算一遍内缩 —— 重算必然与布局漂移。
   * 返回副本，调用方改不坏内部状态。
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  getContentBounds() : {x:number,y:number,width:number,height:number}|null {
    // 语义是「用户正在操作的那块网页矩形」—— 分屏时是**活动格**（见 _activePaneBounds）。
    const page = this._activePaneBounds()
    if (!page) return null
    return { x: page.x, y: page.y, width: page.width, height: page.height }
  }

  /**
   * 把某独立浮层锚定到「顶栏下方、内容区右上角」。
   * 区别于 setFloatBounds：坐标由主进程按窗口 content 尺寸 + 页面布局参数计算，
   * 不依赖 renderer 上报坐标 —— 贴顶浮层用。
   *
   * 尺寸契约（密码浮层 / 居中提示用的就是这条）：width/height 由**浮层 renderer 测量**、
   * 一并送来，本方法只负责算 x/y 并落位。
   * 也就是说卡片 CSS 尺寸与这里落下的 bounds 永远同源，
   * 不需要在主进程再写一份尺寸常量 —— 写死反而会与 CSS 漂移出「空白 / 被裁切」。
   *
   * ⚠ 几何**不在这里**：本方法只把事实凑齐（窗口 content 尺寸 / 顶底栏占高 / 导航栏
   *   所在侧 / 是否沉浸 / 右侧内缩），再交给
   *   `@hira-ng/shared-types/src/float-anchor` 解析 —— 那边负责按内容区夹取
   *   x/y/宽高（以前只夹到 ≥0，卡片过大时会被 setBounds 裁掉右缘/底部）。
   * @param {string} name 浮层逻辑名
   * @param {{ width: number, height: number, margin?: number }} rect 浮层自身尺寸 + 与顶栏/右缘的间距
   */
  anchorFloatBelowTopbar(name: string, rect: FloatAnchorRequest = {}): void {
    const key = String(name)
    const v = this._floatViews.get(key)
    if (!v || !this._win || this._win.isDestroyed()) return
    try {
      const [cw, ch] = typeof this._win.getContentSize === 'function' ? this._win.getContentSize() : [0, 0]
      if (!cw || !ch) return
      const out = computeBelowTopbar({
        window: { width: cw, height: ch },
        card: { width: rect.width, height: rect.height },
        topbarHeight: this._pageLayoutParams.topbarHeight,
        bottombarHeight: this._pageLayoutParams.bottombarHeight,
        navSide: this._pageLayoutParams.navSide,
        // 外壳收起（chrome 隐藏且未唤出）时顶底栏都不占高。
        chromeHidden: this._chromeHidden() && !this._immersiveRevealed,
        insetRight: this._contentInsetRight,
        margin: rect.margin
      })
      if (out) this.setFloatBounds(key, out)
    } catch (e) {
      console.error(`[layout] anchorFloatBelowTopbar(${key}) failed:`, errorMessage(e))
    }
  }

  /**
   * 把某独立浮层锚定到「侧边面板的**外侧**」——面板靠左时贴它的右缘，面板靠右时贴它的左缘。
   *
   * 为什么必须由主进程算：面板是独立 WebContentsView，面板内的 DOM 浮层一超出
   * 面板边界就被裁掉，所以「打开标签 / 固定标签」这类面板的 hover 预览只能是独立
   * 浮层；而它落在面板左边还是右边、view 多大，取决于面板的**实际 bounds** —— 只有主进程知道。
   *
   * ⚠ 几何**不在这里**：本方法只负责把事实凑齐（面板 bounds / 窗口尺寸 / 顶栏高 / rail 宽），
   *   再交给 `@hira-ng/shared-types/src/preview-placement` 解析（三条不变式写在那份文件头）。
   *   以前这里是一整套手写算术，与渲染层那三段各自漂移 —— 那正是"预览一换就闪、卡片错位"
   *   这类只看肉眼才发现的病的温床。
   * @param {string} name 浮层逻辑名
   * @param {{ card?: {width?: number, height?: number}, anchor?: object|null, margin?: number, panelSide?: 'left'|'right'|null }} rect
   */
  anchorFloatBesidePanel(name: string, rect: FloatAnchorRequest = {}): void {
    const key = String(name)
    const v = this._floatViews.get(key)
    if (!v || !this._win || this._win.isDestroyed()) return
    try {
      const [cw, ch] = typeof this._win.getContentSize === 'function' ? this._win.getContentSize() : [0, 0]
      if (!cw || !ch) return
      const card = {
        width: Math.max(0, Math.floor((rect.card && rect.card.width) || 0)),
        height: Math.max(0, Math.floor((rect.card && rect.card.height) || 0))
      }
      if (!card.width || !card.height) {
        this.setFloatBounds(key, { x: 0, y: 0, width: 0, height: 0 })
        return
      }
      // 「浮层贴哪条边」取决于**发起它的那个面板**在哪一侧（面板在右 → 浮层落在它左边）。
      // rect.panelSide 由 IPC 层按发送方视图填；但**这里补一道**：`display` 的发送方是
      // 浮层自己（不是面板），所以 IPC 层那次取值必然是空的 —— 真正知道"是谁请求的"的
      // 是 `_floatOpener`（show 时记下的发起视图）。两侧面板都开着时，只有这条能给出正确的一侧。
      const opener = this._floatOpener.get(key)
      const openerSide = opener && !(typeof opener.isDestroyed === 'function' && opener.isDestroyed())
        ? this.getPanelSideOfWebContents(opener)
        : null
      const explicit = rect.panelSide === 'left' || rect.panelSide === 'right'
        ? rect.panelSide
        : openerSide
      // 判"哪一侧只有面板"时把钉住位一起算上：只钉住一块时同样能定侧。
      const anyLeft = !!(this._panelSlots.left || this._panelPinned.left)
      const anyRight = !!(this._panelSlots.right || this._panelPinned.right)
      const slotSide = explicit || (anyLeft && !anyRight
        ? 'left'
        : (anyRight && !anyLeft ? 'right' : this._sidebarPosition))
      // 发起面板优先：钉住位与普通位可能同侧并存，取"发请求的那一块"的几何才贴得准。
      const openerPanel = opener ? this.getPanelIdOfWebContents(opener) : null
      const anchorPanelId = (openerPanel && openerPanel.id)
        || this._panelSlots[slotSide]
        || this._panelPinned[slotSide]
      const view = anchorPanelId && this._wcm && typeof this._wcm.getPanel === 'function'
        ? this._wcm.getPanel(anchorPanelId)
        : null
      let panel = null
      try { panel = view && typeof view.getBounds === 'function' ? view.getBounds() : null } catch (_) { panel = null }
      const anchor = rect.anchor
        ? {
            left: Number(rect.anchor.left) || 0,
            top: Number(rect.anchor.top) || 0,
            width: Math.max(0, Number(rect.anchor.width) || 0),
            height: Math.max(0, Number(rect.anchor.height) || 0),
            align: rect.anchor.align
          }
        : null
      const out = resolvePreviewPlacement({
        placement: PREVIEW_PLACEMENT.BESIDE_PANEL,
        card,
        anchor,
        // 浮层贴哪条边由**面板**那一侧决定（面板在右 → 浮层落在它左边）。
        panelSide: slotSide,
        panel,
        railWidth: (this._railPinned || this._railRevealed) ? this._railWidth : 0,
        margin: rect.margin,
        window: {
          width: cw,
          height: ch,
          topbarHeight: (this._chromeHidden() && !this._immersiveRevealed)
            ? 0
            : Math.min(Math.max(40, Math.round(this._headerHeight)), ch)
        }
      })
      this.setFloatBounds(key, { x: out.x, y: out.y, width: out.width, height: out.height })
    } catch (e) {
      console.error(`[layout] anchorFloatBesidePanel(${key}) failed:`, errorMessage(e))
    }
  }

  /**
   * 该 webContents 是否属于本窗口的**侧边面板**视图。
   *
   * 用途：面板里的 hover 预览要落在面板外侧（见 anchorFloatBesidePanel），主进程必须
   * 能区分「请求来自面板」与「请求来自外壳 / 标签栏」—— 两者坐标系不同（面板是子视图，
   * 需要加视图偏移），落位规则也不同。
   * @param {Electron.WebContents} target
   * @returns {boolean}
   */
  isPanelWebContents(target: WebContents | null | undefined): boolean {
    return !!this.getPanelSideOfWebContents(target)
  }

  /**
   * 该 webContents 属于哪个**面板位**（不是面板视图则返回 null）。
   * 两侧都开着时，光靠 isPanelWebContents 分不出是哪一边 —— 浮层贴边要用这个。
   * @param {Electron.WebContents} target
   * @returns {'left'|'right'|null}
   */
  getPanelSideOfWebContents(target: WebContents | null | undefined): Side | null {
    const found = this.getPanelIdOfWebContents(target)
    return found ? found.side : null
  }

  /**
   * 该 webContents 属于**哪一块面板**（普通位 / 钉住位都查）。不是面板视图 → null。
   *
   * 两侧可能各开两块（普通 + 钉住），仅凭"哪一侧"已经定位不到具体那一块 ——
   * 浮层贴边（`anchorFloatBesidePanel`）要的是那一块的**真实 bounds**。
   * @param {Electron.WebContents} target
   * @returns {{ id: string, side: 'left'|'right', pinned: boolean }|null}
   */
  getPanelIdOfWebContents(target: WebContents | null | undefined): PanelIdentity | null {
    if (!target || !this._wcm || typeof this._wcm.getPanel !== 'function') return null
    for (const s of ['left', 'right'] as const) {
      const slots: Array<[string | null, boolean]> = [
        [this._panelSlots[s], false],
        [this._panelPinned[s], true]
      ]
      for (const [id, pinned] of slots) {
        if (!id) continue
        const view = this._wcm.getPanel(id)
        if (view && view.webContents === target) return { id, side: s, pinned }
      }
    }
    return null
  }

  // ── 密码浮层独立图层（与通用 overlay 同构，但互不影响）──────────
  setPasswordOverlayInteractive(interactive: boolean): void {
    // 惰性：纯收起（非交互）且视图尚未创建时无需创建
    if (!this._passwordOverlayView && !interactive) return
    this._ensurePasswordOverlay()
  }

  /**
   * 把密码浮层强制提升到 contentView 最顶层（高于 tab 网页 / rail / ui-shell / 通用 overlay）。
   * addChildView 对已存在的子 view 会重新移到同级末尾（最前绘制），
   * 用于浮层显示瞬间、或 tab view 被重挂后，保证浮层始终盖住网页。
   */
  raisePasswordOverlay() {
    const layer = this._getLayer('password-overlay')
    if (layer) { this._layers.raiseLayer(layer); return }
    this._ensurePasswordOverlay()
    if (!this._passwordOverlayView) return
    try {
      this._contentView().addChildView(this._passwordOverlayView)
    } catch (e) {
      console.error('[layout] raisePasswordOverlay failed:', errorMessage(e))
    }
  }

  /**
   * 密码卡与权限 / 查找栏共用同一套 in-content 落位：
   * renderer 只提交自己的 outer 尺寸和对齐意图，网页矩形与最大化后的夹取全在这里算。
   */
  anchorPasswordOverlayInContent(rect: FloatAnchorRequest = {}): void {
    this._lastPasswordOverlayPlacement = {
      width: Math.max(0, Math.floor(rect.width || 0)),
      height: Math.max(0, Math.floor(rect.height || 0)),
      align: rect.align,
      valign: rect.valign,
      margin: rect.margin
    }
    const out = this._resolveInContentBounds(rect)
    if (out) this._applyPasswordOverlayBounds(out)
  }

  setPasswordOverlayBounds(rect: Partial<Rectangle>): void {
    this._lastPasswordOverlayPlacement = null
    this._applyPasswordOverlayBounds(rect)
  }

  private _applyPasswordOverlayBounds(rect: Partial<Rectangle>): void {
    const w0 = Math.max(0, Math.floor((rect && rect.width) || 0))
    const h0 = Math.max(0, Math.floor((rect && rect.height) || 0))
    // 惰性：纯收起（0x0）且视图尚未创建时无需创建
    if (!this._passwordOverlayView && !(w0 > 0 && h0 > 0)) return
    const overlay = this._ensurePasswordOverlay()
    if (!overlay) return
    try {
      const x = Math.max(0, Math.floor(rect.x || 0))
      const y = Math.max(0, Math.floor(rect.y || 0))
      const w = Math.max(0, Math.floor(rect.width || 0))
      const h = Math.max(0, Math.floor(rect.height || 0))
      const isVisible = w > 0 && h > 0
      const layer = this._getLayer('password-overlay')
      // 显示（非 0x0）时先置顶再布局，确保菜单/保存卡一定压在网页视图之上
      if (isVisible) {
        this.raisePasswordOverlay()
        if (layer) layer.setVisible(true)
        // 「要用了」—— 撤掉闲置回收定时器（见 PASSWORD_IDLE_RECLAIM_MS）。
        this._cancelPasswordReclaim()
      }
      overlay.setBounds({ x, y, width: w, height: h })
      if (!isVisible) {
        // 收起：隐藏图层（不参与焦点/模态判定）+ 恢复鼠标穿透
        if (layer) layer.setVisible(false)
        // 收起就排一次闲置回收 —— 这条腿此前**完全不存在**，于是密码浮层创建一次就永久常驻。
        this._schedulePasswordReclaim()
      }
    } catch (e) {
      console.error('[layout] setPasswordOverlayBounds failed:', errorMessage(e))
    }
  }

  /** 获取密码浮层 webContents（供 IPC 推送用） */
  getPasswordOverlayWebContents() {
    return this._passwordOverlayView ? this._passwordOverlayView.webContents : null
  }

  /** 获取宿主 BrowserWindow（供 IPC 计算窗口级坐标用） */
  getWindow() {
    return this._win && !this._win.isDestroyed() ? this._win : null
  }

  /** 获取 ui-shell webContents（= 窗口本体，供 IPC 转发用） */
  getUiShellWebContents() {
    return this._win && !this._win.isDestroyed() ? this._win.webContents : null
  }
}

interface LayoutCoordinator {
  _normalizePanelSide(side: string | Side | null | undefined): Side
  _resolvedSideColumnSide(): Side
  _panelIdsOnSide(side: Side): string[]
  _placePanelSlot(panelId: string, rect: Rectangle, side: Side): void
  getPanelSideOf(panelId: string): Side | null
  closePanel(panelId: string): boolean
  _notifyWebSidebarSide(): void
  _placeWebSidebar(rect: Rectangle | null, insets?: { left: number; top: number; right: number; bottom: number }): void
  _pushWebSidebarFrame(): void
  _focusedWebBounds(): Rectangle | null
  _webSidebarResizeHandleRect(pageBounds: Rectangle | null): Rectangle | null
  getWebSidebarSide(): Side
}

export { LayoutCoordinator }
