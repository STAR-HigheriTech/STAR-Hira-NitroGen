/**
 * 子窗口配置表。
 * 职责：类型 → { url, width, height, modal } 映射。
 * infra 层的 WindowFactory 只负责创建窗口，不关心业务类型。
 *
 * URL 解析策略（二选一，同一个类型只用一种）：
 * - `page`: 走 hira://<host> 内部页（真实界面落在 pages/<host>/），
 *   WindowFactory 支持任意 URL，hira:// 协议挂在默认 session 上，子窗口直接可用。
 * - `entry`: 走 renderer 子目录（out/renderer/<entry>/index.html），共享 subwindow
 *   入口的类型通过 `?type=` 区分；有 devServerUrl 时用 dev server，否则用 file://。
 * - `entry: null` 且无 `page`：该类型走系统对话框 / 由专用控制器接管，不创建 BrowserWindow。
 *
 * 下载 / 历史 / 书签 / 扩展 / 密码 / 权限 / 站点设置 / Cookie / 取色器 / 崩溃报告 等
 * **一律是标签页**（hira://<host> 作为活动 tab 打开），不走子窗口 —— 因此本表不为它们
 * 保留条目。少一条配置就少一处可能与页面漂移的真源。
 */
import path from 'node:path'
import { getAppRoot } from '@hira-ng/shared-utils'
// 浮框的尺寸与裁剪几何在 shared-types 里（渲染层的框页 import 同一份）——
// 两处各写一份必然漂移，而漂移的表现是"框里明明有码却扫不到"。
import { QR_SCAN_FRAME_SIZE } from '@hira-ng/shared-types/src/qr-scan-frame.mjs'
// 内部页地址拼法（唯一真源）：本表只声明 host，不再手写 `hira://` 前缀。
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'

export interface WindowConfigEntry {
  dynamic?: boolean
  page?: string
  entry?: string | null
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  modal?: boolean
  frame?: boolean
  alwaysOnTop?: boolean
  autoHideMenuBar?: boolean
  skipTaskbar?: boolean
  resizable?: boolean
  minimizable?: boolean
  maximizable?: boolean
  fullscreenable?: boolean
  independent?: boolean
  showOnReady?: boolean
  backgroundColor?: string
  followThemeMaterial?: boolean
  [key: string]: unknown
}

export type ResolvedWindowConfig = WindowConfigEntry & { url: string }

/** 子窗口类型枚举（含 `extension-popup`：URL/session 由运行时给出的动态类型）。 */
export const WINDOW_TYPES = {
  TASK_MANAGER: 'task-manager',
  VIEW_SOURCE: 'view-source',
  ADD_BOOKMARK: 'add-bookmark',
  EDIT_BOOKMARK: 'edit-bookmark',
  // 批量打标签窗口：右键「打标签…」不再在面板/页面里弹层，而是开这个子窗口
  //（与单条书签的编辑窗口同一形态；条目由 payload.ids 给出）。
  TAG_BOOKMARKS: 'tag-bookmarks',
  FIND: 'find',
  PRINT: 'print',
  HTTP_AUTH: 'http-auth',
  EXTENSION_POPUP: 'extension-popup',
  // 扫码浮框（「扫码器」插件的取景框）：透明置顶、可拖动的小窗口，见下表条目。
  QR_SCAN_FRAME: 'qr-scan-frame',
  // 小窗预览（N1，Arc 的 Little Arc）：从别的应用点开的链接 / 想"看一眼"的页面
  // 用一个小窗口打开，不占标签栏；想留下时一键升级成正式标签（见 main/peek.js）。
  PEEK: 'peek',
  // 画板（D4，Arc 的 Easel）：窄面板只做导航，画布在独立窗口里（见 ui/ui-panel-easel）。
  EASEL_WINDOW: 'easel-window',
  // 注入规则编辑器（J10）：窄面板写不下 CSS/JS，代码编辑放独立窗口（见 ui-panel-inject）。
  INJECT_EDITOR: 'inject-editor',
  // 截图标注**不是窗口**：它是浏览器窗口内的浮层视图（见 main/capture-editor-overlay.js），
  // 因此本表不为它保留类型 —— 少一条配置就少一处可能与浮层漂移的真源。
  // PWA 应用窗（与 Edge/Chrome「安装为应用」对齐）：网页本体是运行时给的
  // WebContentsView，窗口自己只画 chrome 标题栏（见 main/pwa/window.js）。
  PWA_APP: 'pwa-app',
  // PWA 安装确认框：复用 subwindow 入口（自绘标题栏 + 关闭按钮）。
  PWA_INSTALL: 'pwa-install',
  // WebAuthn 多凭据账户选择器：账户摘要由 Electron 运行时给出，不含私钥。
  PASSKEY_PICKER: 'passkey-picker',
  CAPTURE_HUB: 'capture-hub',
  // OOBE 首次启动引导：独立自绘窗口，页面走 hira://onboarding（见 main/onboarding/）。
  ONBOARDING: 'onboarding',
  /**
   * **通用「面板独立窗口」**（与任何具体面板/插件无关）。
   *
   * 任何侧栏面板都能从主窗口里"拎出来"变成一个独立窗口继续用，也可以再"塞回去"
   * （见 renderer/shared/panel-context.js 与 subwindow/windows/detached-panel.js）。
   * 本类型只承载窗口特性与入口，**不认识 panelId** —— 面板身份由 payload 里的
   * `panelId` 运行时给出（openSubWindowByType 已把 payload 塞进 URL 查询参数）。
   *
   * 刻意放进 WINDOW_TYPES 而不是让 AI 插件自己造窗口：面板 → 窗口是**通用能力**，
   * 换任何面板都成立；把它绑到某个业务插件上，下一个面板要拆出去时就得复制一遍。
   */
  DETACHED_PANEL: 'detached-panel'
} as const

/**
 * 窗口配置表。
 * entry: renderer 子目录名（对应 out/renderer/<entry>/index.html）
 *   - 'subwindow' 为共享 entry，通过 ?type=<type> 区分具体窗口
 *   - null 表示该类型不经 WindowFactory 建窗口（浮层视图 / 专用控制器接管）
 * 注意：设置页不在本表 —— 它走 hira://settings（作为**活动 tab 打开的一个页面**），
 *      不是独立渲染窗口。该页与其它内部页同构：`pages/settings/` → out/pages/settings/，
 *      由协议层的磁盘发现自动注册（见 main/hira-protocol.js）。
 */
export const WINDOW_CONFIG: Readonly<Record<string, WindowConfigEntry>> = {
  [WINDOW_TYPES.TASK_MANAGER]:       { page: 'task-manager', width: 720, height: 500, modal: false },
  // 页面信息不在此表：它永远是**标签页**（hira://page-info?tabId=<来源>），
  // 弹窗形态会让「看的那一页」被遮挡，也与浮层深链的语义分叉。见 app-shell#handleSiteInfoAction。
  // 查看源代码：**独立窗口**（independent）—— 不挂 parent。
  // 挂 parent 的窗口会被系统视为子窗口、永远压在主窗口之上，且不占独立任务栏项；
  // 而看源码是「对照阅读」场景，用户需要把它和 hira 并排摆放、随时切到别的应用。
  [WINDOW_TYPES.VIEW_SOURCE]:        { page: 'view-source', width: 920, height: 700, modal: false, independent: true },
  // 书签编辑器：对齐老版 Hira main/ipc/bookmarkEditor.js 的窗口特性 ——
  //   480x520 / frame:false（无标题栏）/ alwaysOnTop（置顶）/ modal（挂父窗）/
  //   resizable:false / autoHideMenuBar / showOnReady（ready 后再显示避免白闪）。
  // `minimizable:false`（自绘标题栏据此**不画最小化按钮**）：它是一个挂父窗的模态小表单，
  //   最小化到任务栏毫无意义（父窗被模态挡住、恢复要靠任务栏翻找）。能力声明写在配置里，
  //   而不是让渲染层按窗口类型特判 —— 见 subwindow/main.js#wireWindowControls。
  [WINDOW_TYPES.ADD_BOOKMARK]:       { entry: 'subwindow', width: 480, height: 520, modal: true, frame: false, alwaysOnTop: true, autoHideMenuBar: true, resizable: false, minimizable: false, showOnReady: true },
  [WINDOW_TYPES.EDIT_BOOKMARK]:      { entry: 'subwindow', width: 480, height: 520, modal: true, frame: false, alwaysOnTop: true, autoHideMenuBar: true, resizable: false, minimizable: false, showOnReady: true },
  // 批量打标签：与编辑器同一形态（挂父窗的模态、无边框、置顶、就绪后显示），
  // 只是内容为标签决策面板 —— 右键/批量「打标签」的统一落点。
  [WINDOW_TYPES.TAG_BOOKMARKS]:      { entry: 'subwindow', width: 480, height: 560, modal: true, frame: false, alwaysOnTop: true, autoHideMenuBar: true, resizable: false, minimizable: false, showOnReady: true },
  // 书签编辑器复用 subwindow 入口 —— 那个入口自带标题栏、自绘关闭按钮与拖拽区，
  // 因此必须显式 frame:false：否则会同时出现原生标题栏和自绘标题栏（双标题）。
  // 页面型窗口（任务管理器 / 查看源代码 …）则相反：它们**没有任何自绘关闭入口**，
  // 必须依赖原生边框，所以不写 frame（由 WindowFactory 默认为 true）。
  // 快捷键 / 主题管理都是内部页（hira://shortcuts、hira://themes，作为活动标签打开）。
  // 本表只管窗口，因此这里不留条目 —— 少一条配置就少一处可能与页面漂移的真源。
  // 页内查找栏不是子窗口 —— 它是**主窗口里的一条独立浮层视图**（与悬停 URL / 缩放条同族，
  // 见 ipc/layout.js#FLOAT_NAMES 与 renderer/findbar-overlay/）：
  // 不占位、不挤网页，浮在网页右上角，位置由主进程按网页矩形算。
  // 因此这里 `entry: null`（该类型不经 WindowFactory 建窗口）。
  [WINDOW_TYPES.FIND]:               { entry: null },
  // 打印预览：独立窗口（不挂 parent，可与主窗口并排调选项），
  // 页面只持 jobId；PDF 由主进程经 hira://print-pdf/<jobId> 直吐。
  [WINDOW_TYPES.PRINT]:              { page: 'print-preview', width: 980, height: 740, modal: false, independent: true },
  // HTTP Basic / Proxy 认证弹窗：无边框、置顶、不占任务栏、不可缩放、就绪后显示。
  // 刻意非 modal —— 认证弹窗绝不能锁死浏览器（用户可能要去别的标签查账号）。
  [WINDOW_TYPES.HTTP_AUTH]:          { page: 'http-auth', width: 420, height: 300, modal: false, frame: false, alwaysOnTop: true, autoHideMenuBar: true, skipTaskbar: true, resizable: false, minimizable: false, showOnReady: true },
  // 扩展弹窗（点扩展图标弹出的那个 popup）—— 对齐 RT 的 ExtensionPopupWindow 类型登记。
  //
  // 与其它类型的**根本区别**：它的 URL 与 session 只能由运行时决定
  // （`chrome-extension://<id>/<default_popup>`，且必须绑到**该扩展所属 profile 的
  // session**，否则弹窗里的 chrome.* API 全废），静态配置表给不出这两样。
  // 因此本条目只承载「窗口特性 + 注册表类型维度」这一件事，url 由
  // main/extension-popup.js 在打开时传入；getWindowConfig 对它返回 null
  // （既无 page 也无 entry），`window:open` 路由因此不会误开一个空白弹窗。
  //
  // 特性依据（对齐 ECE 的 PopupView 与 RT 的扩展弹窗语义）：
  //   frame:false        自绘内容，不要标题栏（popup 本来就是扩展页面的容器）
  //   parent            打开时挂发起方窗口 —— 弹窗必须压在其父窗口之上（见 openExtensionPopup）
  //   skipTaskbar        不占任务栏项
  //   resizable/minimizable/maximizable/fullscreenable: false   弹窗不做窗口管理动作
  //   showOnReady        就绪后再显示，避免白闪一下
  //   刻意**不设** alwaysOnTop：挂了 parent 的子窗口本来就压在父窗口之上，
  //   再加 alwaysOnTop 会让它浮到**其它应用**之上（点别的软件它还在最前面），
  //   ECE 的 PopupView 同样只用 parent 不用 alwaysOnTop。
  [WINDOW_TYPES.EXTENSION_POPUP]:    {
    dynamic: true,
    width: 360,
    height: 560,
    minWidth: 240,
    minHeight: 120,
    modal: false,
    frame: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    showOnReady: true,
    backgroundColor: '#ffffff'
  },

  /**
   * 扫码浮框（「扫码器」插件的取景框）。
   *
   * 它不是"另一个功能窗口"，而是**一个可以拖到屏幕上任何位置的取景框**：
   * 用户把它套在二维码上，主进程按它的屏幕矩形裁剪抓屏画面后再解码
   * （几何真源见 shared-types#qr-scan-frame）。
   *
   * 特性逐项的理由：
   *   transparent: true     框外必须完全透明 —— 底下就是用户要看的那块屏幕
   *   frame: false          自绘（角标 / 提示条 / 关闭），不要标题栏
   *   alwaysOnTop: true     框要压在被扫的网页（以及别的应用）之上，否则一拖就藏进去了
   *   skipTaskbar: true     它是一个临时取景器，不是一份"工作"
   *   resizable: false      取景框尺寸固定（裁剪区尺寸即几何常量），改尺寸只会让映射失真
   *   hasShadow: false      系统阴影会落在框外并压暗边缘像素
   *   thickFrame: false     透明无边框窗口不要保留那圈可拖拽厚边框（会画出实体边）
   *   showOnReadyMode:'inactive' 就绪后不夺焦显示（避免一开框就把焦点从输入框上抢走）
   *   independent: true     **不挂 parent** —— 挂了就会被系统当成子窗口锁在主窗口边界内，
   *                         而取景框要能拖到屏幕任何地方（包括别的应用上面）
   *
   * 刻意**不设** `focusable: false`：不可激活 + 透明 + 置顶 这个组合在 Windows 上
   * 与鼠标穿透（setIgnoreMouseEvents）叠在一起时行为不稳（收不到点击/移动），
   * 而"拖动取景框"全靠鼠标事件。焦点用 showOnReadyMode 处理就够了。
   */
  [WINDOW_TYPES.QR_SCAN_FRAME]: {
    entry: 'qr-scan-frame',
    width: QR_SCAN_FRAME_SIZE.width,
    height: QR_SCAN_FRAME_SIZE.height,
    modal: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    thickFrame: false,
    independent: true,
    showOnReady: true,
    showOnReadyMode: 'inactive',
    // 全透明背景（Electron 是 #AARRGGBB：A=00 → 完全透明）。
    // 透明窗口**必须**显式写它：默认白底会在框外糊一层白，那就不是"浮框"而是"白板"了。
    backgroundColor: '#00000000'
  },

  /**
   * 小窗预览（N1 / Arc 的 Little Arc）。
   *
   * 与扩展弹窗同属"URL 由运行时给出"的一类：本条目**既不写 page 也不写 entry**
   * → `getWindowConfig` 返回 null（`window:open` 开不出它，免得开出一个没有网页的
   * 空壳小窗）；要开就走 `main/peek.js`，它自己把 subwindow 入口 + 网页 URL 拼起来
   * （entry 写进表里就等于把这条口子打开了，而小窗的正文是**运行时那个 URL**，
   * 不像书签编辑器那样"入口自己就是完整界面"，所以这里刻意留空）。
   *
   * ── 窗口特性：**与书签编辑器窗口一致** ─────────────────────────────
   * （`ADD_BOOKMARK` / `EDIT_BOOKMARK`：`frame:false` + alwaysOnTop + autoHideMenuBar
   *  + showOnReady）。标题栏也是那一套（subwindow 入口的 `.header`，
   * 拖动区 + 自绘按钮），所以两边观感、拖动行为完全相同。
   *
   * 与之**刻意不同**的三点，都只关乎"它是什么窗口"，不关乎外观：
   *   resizable: true（书签编辑器的表单宽度是设计好的，小窗不是）
   *     小窗里装的是**任意网页**：长文要拉高、宽表格要拉宽，用户必须能自己调宽高。
   *     无边框窗口的缩放边由 Windows 的 `WS_THICKFRAME` 提供 —— 也就是
   *     **默认的 thickFrame**（本条目刻意不写它，与主窗口同一套路：主窗口能拖边缩放，
   *     靠的就是这圈原生边框）。minWidth/minHeight 给个下限，免得被拖成一条线。
   *   modal: false / independent: true
   *     书签编辑器是挂在父窗上的模态子窗口（modal:true）；而小窗预览是"从别的应用
   *     点开一个链接"的落点，必须能独立摆放、压到别的应用之上，也要能一边看它一边
   *     操作主窗口 —— 挂 parent 会把它锁在主窗口边界内并挡住主窗口。
   *   dynamic: true
   *     正文 URL 由运行时给（见上）。
   *
   * 最大化仍然关闭：自绘标题栏下没有最大化按钮，但双击拖动区 / 拖到屏幕顶部这类
   * 系统手势仍可能触发，显式 `maximizable/fullscreenable: false` 才彻底。
   * 注意这**不影响**上面那条拖边缩放 —— 两者在 Windows 上是两套机制
   *（`WS_THICKFRAME` 给缩放边，`WS_MAXIMIZEBOX` 给最大化）。
   */
  [WINDOW_TYPES.PEEK]: {
    dynamic: true,
    // 默认 800×600：小窗里装的是**任意网页**，太窄的话桌面版布局会被压成移动版
    //（很多站点在 900px 以下就换布局），而"看一眼"的前提是**看得清**；
    // 同时也不能太大 —— 它是"瞥一眼就走"的临时窗，别占去大半个屏幕。
    // 仍然是可缩放的（上下限见 minWidth/minHeight），用户随时拖边调。
    width: 800,
    height: 600,
    minWidth: 320,
    minHeight: 240,
    modal: false,
    frame: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    independent: true,
    showOnReady: true,
    backgroundColor: '#ffffff'
  },

  // 画板（D4）：与主题管理同一形态 —— 复用 subwindow 入口的自绘标题栏（→ frame:false）。
  // 但它是**独立任务窗口**（`independent: true`）：不挂 parent，否则会被系统当成主窗口的
  // 子窗口 —— 永远压在主窗口之上、不占独立任务栏项、也没有正常的最大化/最小化语义。
  // 画布是"无限工作区"，给足初始面积；可最大化 / 最小化 / 拖边缩放（均由自绘标题栏驱动）。
  [WINDOW_TYPES.EASEL_WINDOW]: {
    entry: 'subwindow',
    width: 1040,
    height: 720,
    modal: false,
    frame: false,
    independent: true,
    showOnReady: true
  },

  // 注入规则编辑器（J10）：与主题管理 / 画板同一形态（复用 subwindow 入口的自绘标题栏
  // → frame:false）。要编辑的是 CSS / JS —— 给足高度让两个代码区各自能看到二十来行。
  // 同为**独立任务窗口**（理由见上：编辑代码时要能和主窗口并排摆放）。
  [WINDOW_TYPES.INJECT_EDITOR]: {
    entry: 'subwindow',
    width: 880,
    height: 760,
    modal: false,
    frame: false,
    independent: true,
    showOnReady: true
  },

  /**
   * PWA 应用窗（「安装为应用」的落地形态）。
   *
   * 与 peek 同构：`dynamic: true` 且**既不写 page 也不写 entry** —— 正文 URL 是
   * 运行时从应用记录里取的，静态表开不出它（走 `pwa:launch` → main/pwa/runtime.js）。
   *
   *   frame: false          自绘 chrome（图标 / 标题 / 前进后退 / 刷新 / 菜单）
   *   independent: true     必须是独立任务窗 —— 否则会被系统当作主窗口的子窗口，
   *                         永远压在主窗口之上、不占独立任务栏项（与"应用"的语义相反）
   *   resizable: true       应用窗要能拖边缩放；最大化/最小化保持默认 true
   *   minWidth/minHeight    下限按 Chrome 应用窗的可用性给，别被拖成一条线
   *   showOnReady: true     等 chrome 首帧就绪再显示，避免白闪
   *
   * 窗口的 AUMID / 标题 / 图标由 `win.setAppDetails()` 在显示前写入 —— 这样任务栏、
   * 开始菜单固定项、Alt+Tab 都把它当成**那个应用**，而不是第二个 Hira 窗口。
   */
  [WINDOW_TYPES.PWA_APP]: {
    dynamic: true,
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 240,
    modal: false,
    // ⚠ 必须保留标准边框：系统窗口控制按钮（WCO）依赖
    // `titleBarStyle:'hidden' + titleBarOverlay`，而 titleBarOverlay 在 frame:false
    // 下不生效。实际建窗时 createPwaAppWindow 会显式传 titleBarOverlay。
    frame: true,
    autoHideMenuBar: true,
    resizable: true,
    independent: true,
    showOnReady: true,
    backgroundColor: '#ffffff'
  },

  /**
   * PWA 安装确认框：挂在发起窗口上的模态子窗口。
   * 与书签编辑器同一形态（subwindow 入口自带标题栏 → 必须 frame:false，否则双标题）。
   */
  [WINDOW_TYPES.PWA_INSTALL]: {
    entry: 'subwindow',
    width: 480,
    height: 420,
    modal: true,
    frame: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    showOnReady: true,
    backgroundColor: '#ffffff'
  },
  [WINDOW_TYPES.PASSKEY_PICKER]: {
    entry: 'subwindow',
    width: 430,
    height: 380,
    modal: false,
    frame: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    independent: true,
    showOnReady: true,
    backgroundColor: '#ffffff'
  },
  [WINDOW_TYPES.CAPTURE_HUB]: {
    entry: 'subwindow',
    width: 520,
    height: 520,
    modal: false,
    frame: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    independent: true,
    showOnReady: true,
    backgroundColor: '#ffffff'
  },

  /**
   * OOBE 首次启动引导：独立自绘无边框窗口，页面走 hira://onboarding。
   *
   * independent:true 是**必须**的 —— 此时主窗还是 show:false 的空壳，
   * 走 createSubWindow 的默认 parent 会变成 modal，父窗隐藏会把引导窗一起藏掉。
   * 尺寸 / 不可缩放对齐 RT 的 onboarding 窗口；居中由控制器拿到 BrowserWindow
   * 后 win.center() 完成（createSubWindow 不支持 center）。
   * followThemeMaterial 让引导窗和独立面板一样跟随主题材质；renderer 拿到
   * windowMaterial=1 后让开不透明底，原生模糊才透得出来。
   */
  [WINDOW_TYPES.ONBOARDING]: {
    page: 'onboarding',
    width: 1000,
    height: 700,
    independent: true,
    modal: false,
    frame: false,
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    showOnReady: true,
    followThemeMaterial: true,
    backgroundColor: '#050A20'
  },

  /**
   * 通用面板独立窗口。
   *
   * 与主题管理同形态：复用 subwindow 入口的自绘标题栏 → `frame:false`。
   *   independent: true   面板窗口要能与主窗口并排摆放（不是挂在主窗上的模态）
   *   resizable: true     不同面板信息密度差异很大，用户必须能自己调
   *   minWidth/minHeight  窄面板的可用下限（再窄就只剩标题了）
   *   showOnReady: true   首帧就绪再显示，避免白闪
   *   followThemeMaterial 跟随主题的窗口材质（亚克力 / Mica）：本窗口没有
   *                       LayoutCoordinator，材质由 theme-runtime 显式推下来
   *                       （见 main/window-material-follow.js）。这是**能力位**，
   *                       与具体面板无关；将来别的自绘子窗口要材质时加同一行即可。
   * 尺寸给一个「侧栏面板拆出来」的合理初值：比面板宽一点，读起来不挤。
   */
  [WINDOW_TYPES.DETACHED_PANEL]: {
    entry: 'subwindow',
    width: 440,
    height: 780,
    minWidth: 320,
    minHeight: 420,
    modal: false,
    frame: false,
    independent: true,
    resizable: true,
    showOnReady: true,
    followThemeMaterial: true
  }
}

/**
 * 解析窗口加载 URL（entry 型）。
 * @param {string} entry  renderer 子目录名
 * @param {string} [type] 窗口类型（用于 subwindow 共享 entry 的 ?type= 参数）
 * @returns {string} dev server URL 或 file:// URL
 */
export function resolveWindowUrl(entry: string, type?: string): string {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
  const base = devServerUrl
    ? `${devServerUrl}/${entry}/index.html`
    : `file://${path.join(getAppRoot(), 'out', 'renderer', entry, 'index.html')}`
  return entry === 'subwindow' && type ? `${base}?type=${type}` : base
}

/**
 * 根据窗口类型获取完整配置（含解析后的 URL）。
 * @param {string} type
 * @returns {object|null} 配置对象；无此类型、或既无 page 又无 entry 时返回 null
 *
 * 注：扩展弹窗（EXTENSION_POPUP）**有意**落进「既无 page 又无 entry」这一支 ——
 * 它的 URL 与 session 只能由运行时给出（见该条目的注释），因此 `window:open`
 * 路由开不出它；需要开弹窗时走 extension:open-popup → main/extension-popup.js，
 * 那边从本表读取窗口特性。这样静态表仍然是窗口特性的唯一真源。
 */
export function getWindowConfig(type: string): ResolvedWindowConfig | null {
  const cfg = WINDOW_CONFIG[type]
  if (!cfg) return null
  // page 型：直接加载 hira:// 内部页真实界面
  if (cfg.page) return { ...cfg, url: pageUrl(cfg.page) }
  // entry 型：renderer 子目录；entry 为 null 表示走系统对话框，不建窗口
  if (!cfg.entry) return null
  return { ...cfg, url: resolveWindowUrl(cfg.entry, type) }
}

