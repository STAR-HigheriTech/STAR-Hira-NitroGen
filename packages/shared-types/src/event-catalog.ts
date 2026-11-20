/**
 * 事件名册 —— 主进程 → 渲染层所有事件的**唯一事实表**。
 *
 * 为什么需要它：`IPC_EVENTS` 只回答「事件叫什么」，回答不了三个更要命的问题：
 *   ① 这条事实属于**谁**（整个应用 / 某个窗口 / 某一个视图）；
 *   ② 载荷长什么样；
 *   ③ 谁应该订阅它。
 * 没有这张表时，新增一个面板要"跟着别处变化"只能靠通读 main.js 里的 emit 调用点，
 * 或者更糟 —— 写一个 setInterval 去轮询（IPC 风暴 + 状态永远慢半拍）。
 *
 * 约定（新增事件时必须同步登记，否则开发态会告警）：
 *   scope = 'app'    应用级事实：settings / 书签 / 历史 / 笔记 / 下载 / 扩展 …
 *                     → 不带 windowId，广播给所有订阅者。
 *   scope = 'window' 窗口级事实：标签、分屏几何、窗口状态、当前空间 …
 *                     → **必须**带 `windowId`，只发给该窗口的订阅者（否则多窗口串台）。
 *   scope = 'target' 定向事实：浮层 / 某个 preload 引擎 / 发起方 renderer …
 *                     → 主进程直接 `wc.send`，不经 broadcaster；登记它是为了标注归属，
 *                       并让"该不该广播"这件事有据可查。
 *
 * 消费方式：
 *   - 主进程：`createBroadcaster(registry, { catalog: createEventCatalogPort() })`
 *     拿到未知路由 / 窗口级事件缺 windowId 的告警。
 *   - 渲染层：`eventSpec(EVENTS.someRoute)` 可判断"我该不该在这个窗口里响应它"。
 *
 * ⚠ 键一律引用 `IPC_EVENTS.*`，不二次手写字符串 —— 路由改名时这张表跟着改，
 *   不会出现"表里有、通道改名了"的静默失配。
 */
import { IPC_EVENTS as E } from './ipc-channels.js'

export const EVENT_SCOPE = Object.freeze({
  APP: 'app',
  WINDOW: 'window',
  TARGET: 'target'
})

export interface EventSpec {
  scope: 'app' | 'window' | 'target'
  payload: string
  subscribers: string[]
  note?: string
}

const APP = EVENT_SCOPE.APP
const WINDOW = EVENT_SCOPE.WINDOW
const TARGET = EVENT_SCOPE.TARGET

/** @type {Readonly<Record<string, EventSpec>>} */
export const EVENT_CATALOG: Readonly<Record<string, EventSpec>> = Object.freeze({
  // ── 标签 / 分屏 / 窗口几何（窗口级）──────────────────────────────────────
  [E.tabChanged]: {
    scope: WINDOW,
    payload: '{ tabs, projection }',
    subscribers: ['ui-shell', 'rail', 'panel'],
    note: '16ms 合帧；外壳直接渲染载荷，必须带 windowId'
  },
  [E.tabLoading]: {
    scope: WINDOW,
    payload: '{ tabId, loading }',
    subscribers: ['ui-shell'],
    note: '页面加载期高频，禁止全量广播'
  },
  [E.tabNavigated]: {
    scope: WINDOW,
    payload: '{ tabId, url, inPage, active }',
    subscribers: ['ui-shell'],
    note: '导航已提交（含刷新）；地址栏据此强制回填真实地址'
  },
  [E.splitChanged]: {
    scope: WINDOW,
    payload: '{ splitId, layout, panes }',
    subscribers: ['ui-shell', 'split-toolbar'],
    note: '只描述几何；成员关系走 tab:changed 的投影'
  },
  [E.tabSyncPlaceholder]: {
    scope: WINDOW,
    payload: '{ url: string|null }',
    subscribers: ['ui-shell']
  },
  [E.glanceChanged]: {
    scope: WINDOW,
    payload: '{ back, radius } | { back: null }',
    subscribers: ['ui-shell']
  },
  [E.webSidebarState]: {
    scope: WINDOW,
    payload: '{ open, url, title, favicon, loading, canGoBack, canGoForward, viewMode }',
    subscribers: ['web-sidebar-header', 'ui-shell']
  },
  [E.webSidebarChanged]: {
    scope: WINDOW,
    payload: '{ open }',
    subscribers: ['ui-shell'],
    note: '与 split:changed 分开，否则互相覆盖'
  },
  [E.windowStateChanged]: {
    scope: WINDOW,
    payload: '{ maximized, fullscreen }',
    subscribers: ['ui-shell']
  },
  [E.windowBlurred]: {
    scope: WINDOW,
    payload: 'undefined',
    subscribers: ['ui-shell'],
    note: '只在 OS 级失活时发'
  },
  [E.windowFocused]: {
    scope: WINDOW,
    payload: 'undefined',
    subscribers: ['ui-shell'],
    note: '与 window:blurred 对称；回到前台时补弹被压住的权限/站点信息'
  },
  [E.panelSideChanged]: {
    scope: WINDOW,
    // pinned：这块面板是否已钉住（决定宿主把图钉画成"已钉住"、以及宽度按哪个槽读写）。
    payload: "{ side: 'left'|'right'|null, pinned?: boolean }",
    subscribers: ['panel-host']
  },
  // 面板换宿主（main/panel-presentation.js → 所有 renderer）：`state` 只有数据，
  // 是面板自己的 serialize() 快照，没有历史。新造的宿主收不到这一条 ——
  // 它挂载后用 `panel:transfer-state` 拉一次（一次即焚）。
  [E.panelTransferred]: {
    scope: APP,
    payload: "{ panelId, direction: 'detach'|'dock', state: unknown|null, reason? }",
    subscribers: [],
    note: "内置宿主通过 panel:side-changed 对账；本事件保留给插件观察。reason ∈ open-window|dock-back|window-closed"
  },
  [E.buttonsEditActive]: {
    scope: WINDOW,
    payload: '{ active: boolean }',
    subscribers: ['ui-shell', 'rail', 'buttons-edit-overlay']
  },
  [E.buttonsEditRemeasure]: {
    scope: WINDOW,
    payload: 'undefined',
    subscribers: ['ui-shell', 'rail']
  },
  [E.zoomChanged]: {
    scope: WINDOW,
    payload: '{ level, percent, origin, source }',
    subscribers: ['zoom-overlay', 'ui-shell']
  },
  [E.pwaDetected]: {
    scope: WINDOW,
    payload: "{ state: 'installed'|'installable'|'shortcut'|'none' }",
    subscribers: ['ui-shell']
  },
  [E.pwaInstallProgress]: {
    scope: WINDOW,
    payload: "{ stage: 'icon'|'shortcut'|'db' }",
    subscribers: ['ui-shell']
  },

  // ── 浮层让位（窗口级，窄广播）────────────────────────────────────────────
  [E.overlayModal]: {
    scope: WINDOW,
    payload: '{ open: boolean }',
    subscribers: ['ui-shell', 'rail', 'panel-host'],
    note: '-webkit-app-region 按整窗合并，下层必须主动放弃 drag（hira-overlay-modal）'
  },
  [E.sideColumnReveal]: {
    scope: WINDOW,
    payload: '{ revealed: boolean, window? }',
    subscribers: ['ui-shell'],
    note: '侧栏「悬停唤出」的两档宽度切换；只报一个布尔，唤出/收起都由外壳把同一块侧栏改宽'
  },

  // ── 应用级数据变更（广播）────────────────────────────────────────────────
  [E.bookmarkChanged]: {
    scope: APP,
    payload: '{ reason, id, url }',
    subscribers: ['ui-shell', 'panel', 'bookmarks-page', 'overlay'],
    note: '跨模块刷新一律订阅它，禁止轮询'
  },
  [E.historyChanged]: {
    scope: APP,
    payload: '{ action, count, id, url, urls, before }',
    // 当前无内建订阅方（历史页已改为手动刷新）；广播保留为扩展位，
    // 面板 / 插件订阅后自行去抖重拉。别再往这里写「已订阅」的假承诺。
    subscribers: [],
    note: '历史库唯一变更广播；订阅方按需去抖刷新，禁止轮询'
  },
  [E.faviconChanged]: {
    scope: APP,
    payload: '{ url, origin, favicon }',
    subscribers: ['panel'],
    note: '图标缓存晚到广播；订阅方按站点补齐展示，不重拉列表'
  },
  [E.noteChanged]: {
    scope: APP,
    payload: '{ reason, id, folderId }',
    subscribers: ['panel', 'ui-shell']
  },
  [E.totpChanged]: {
    scope: APP,
    payload: '{ reason, id }',
    subscribers: ['panel']
  },
  [E.extensionChanged]: {
    scope: APP,
    payload: '{ reason, id }',
    subscribers: ['panel', 'extensions-page']
  },
  [E.pluginsChanged]: {
    scope: APP,
    payload: 'undefined',
    subscribers: ['panel', 'plugins-page']
  },
  [E.pluginChromeChanged]: {
    scope: APP,
    payload: 'undefined',
    subscribers: ['ui-shell'],
    note: 'navbar / rail / 标签动作 / 浮层 / 命令等外壳贡献变更 → 外壳重拉插槽'
  },
  [E.pluginOverlayShow]: {
    scope: WINDOW,
    payload: '{ key, title, url, anchor, width, height, modal }',
    subscribers: ['ui-shell'],
    note: '插件浮层：必须带 windowId，否则每个窗口都开一次'
  },
  [E.pluginOverlayHide]: {
    scope: WINDOW,
    payload: '{ key }',
    subscribers: ['ui-shell']
  },
  [E.themeChanged]: {
    scope: APP,
    payload: '{ themeId, resolved, preference, tokens, background }',
    subscribers: ['ui-shell', 'internal-page', 'new-tab', 'panel'],
    note: '私密窗口会额外收到一条同语义定向推送'
  },
  [E.adblockerChanged]: {
    scope: APP,
    payload: '{ enabled, ready }',
    subscribers: ['ui-shell', 'panel']
  },
  [E.downloadProgress]: {
    scope: APP,
    payload: '{ id, received, total, speed, eta, state }',
    subscribers: ['panel', 'download-controller']
  },
  [E.downloadDone]: {
    scope: APP,
    payload: '{ id, state }',
    subscribers: ['panel', 'download-controller']
  },
  [E.downloadVerified]: {
    scope: APP,
    payload: '{ id, sha256, duplicateOf? }',
    subscribers: ['page', 'download-controller']
  },
  [E.downloadActivity]: {
    scope: APP,
    payload: '{ active }',
    subscribers: ['rail', 'ui-shell'],
    note: '只在「有/无活动下载」跃迁时发；红点据此常亮，零轮询'
  },
  [E.permissionRequest]: {
    scope: APP,
    payload: '{ id, origin, permission }',
    subscribers: ['siteinfo-overlay', 'panel']
  },
  [E.permissionCleared]: {
    scope: APP,
    payload: '{ id }',
    subscribers: ['siteinfo-overlay', 'panel']
  },
  [E.uiPopupMenuSelected]: {
    scope: TARGET,
    payload: '{ requestId, action: string|null }',
    subscribers: ['发起方 renderer'],
    note: '按 requestId 定向回传，不走广播'
  },
  [E.settingsChanged]: {
    scope: APP,
    payload: '{ key, value, changed }',
    subscribers: ['ui-shell', 'panel', 'internal-page']
  },
  [E.updateChanged]: {
    scope: APP,
    payload: '{ supported, status, currentVersion, channel, availableVersion, progress, transferred, total, bytesPerSecond, lastCheckAt, message, error }',
    subscribers: ['about-page'],
    note: '状态机整体快照（真源 main/update/service.js），订阅方不得轮询、不得自行推导；原独立 update 页已并入关于页的「软件更新」选项卡（pages/about/update-panel.js）'
  },
  [E.spaceChanged]: {
    scope: APP,
    payload: '{ reason, id }',
    subscribers: ['ui-shell', 'panel', 'space-switcher', 'settings-page']
  },
  [E.spaceWindowChanged]: {
    scope: WINDOW,
    payload: '{ spaceId }',
    subscribers: ['ui-shell', 'panel']
  },
  [E.layoutDocumentChanged]: {
    scope: WINDOW,
    payload: '{ layoutId, revision, changedNodeIds }',
    subscribers: ['layout-editor'],
    note: '布局文档提交后的窗口级投影；变更节点用于局部重绘'
  },
  [E.profileChanged]: {
    scope: APP,
    payload: '{ profileId }',
    subscribers: ['ui-shell', 'panel', 'bookmarks-bar'],
    note: '各界面数据按 profile 分区，收到后必须重取自己那份'
  },
  [E.automationGesturesConfig]: {
    scope: APP,
    payload: '{ enabled: boolean, map: Record<string,{action,label}> }',
    subscribers: ['每一个标签页的 preload 手势引擎'],
    note: '关掉「启用鼠标手势」必须让页面立刻停手（不画轨迹、不吞右键菜单）；' +
      '只在主进程丢弃上报会让开关看起来完全无效'
  },
  [E.pwaChanged]: {
    scope: APP,
    payload: '{ reason, id }',
    subscribers: ['ui-shell', 'apps-page']
  },

  // ── 定向：主进程 → 某个浮层视图 ──────────────────────────────────────────
  [E.dropzoneUpdate]: {
    scope: TARGET,
    payload: "{ mode: 'split'|'join'|'blocked', zone?, layout?, count?, maxPanes? }",
    subscribers: ['dropzone-overlay']
  },
  [E.dropzoneHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['dropzone-overlay']
  },
  [E.captureOverlayShow]: {
    scope: TARGET,
    payload: '{ bounds, scale }',
    subscribers: ['capture-overlay']
  },
  [E.captureOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['capture-overlay']
  },
  // 标注浮层首帧已出图 → 框选层淡出自己的压暗（与标注浮层同长度淡入交叉，避免双暗叠加）
  [E.captureOverlaySettle]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['capture-overlay']
  },
  // 截图标注浮层（浏览器窗口内的独立视图，不是应用子窗口）：
  //   show 带 { captureId, place } —— 底图按 captureId 取走，place = 选区在目标视图里的矩形
  [E.captureEditorShow]: {
    scope: TARGET,
    payload: '{ captureId, place? }',
    subscribers: ['capture-editor']
  },
  [E.captureEditorHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['capture-editor']
  },
  // ── 浮层 show / hide（`main/ipc/layout.js#FLOAT_NAMES` 循环注册的同一族）──────
  // 通道本身由那张白名单按名字生成，这里登记的是**语义与订阅方**：
  // 不知道这条，订阅侧就会报「未登记的事件路由」。
  [E.searchbarOverlayShow]: {
    scope: TARGET,
    payload: '{ anchor, suggestions, selectedIndex }',
    subscribers: ['searchbar-overlay'],
    note: 'anchor 是地址栏锚点矩形（事实），落位与尺寸由浮层自己算'
  },
  [E.searchbarOverlayHide]: {
    scope: TARGET,
    payload: '{ keepFocus? }',
    subscribers: ['searchbar-overlay']
  },
  [E.tabpreviewOverlayShow]: {
    scope: TARGET,
    payload: '{ tab, besidePanel, placement, side, anchor, stripRight, windowWidth }',
    subscribers: ['tabpreview-overlay'],
    note: '标签条 / 垂直标签 / OpenTabs 面板共用这一条，动效只写一处'
  },
  [E.tabpreviewOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['tabpreview-overlay']
  },
  [E.siteinfoOverlayShow]: {
    scope: TARGET,
    payload: '{ anchor, site, tabId? }',
    subscribers: ['siteinfo-overlay'],
    note: 'anchor 是地址栏左端按钮矩形（事实）；卡片尺寸由浮层实测后经 display 上报'
  },
  [E.siteinfoOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['siteinfo-overlay']
  },
  [E.permissionOverlayShow]: {
    scope: TARGET,
    payload: '{ requests: [{ id, origin, type, sensitive }] }',
    subscribers: ['permission-overlay'],
    note: '只有事实；卡片测量与落位由浮层自己经 display 上报（内容区左上角，不认锚点）'
  },
  [E.permissionOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['permission-overlay'],
    note: '列表清空 / 全部处理完时收起；发起方是外壳经 preload send 转给主进程'
  },
  [E.overviewOverlayShow]: {
    scope: TARGET,
    payload: '{ x, y, viewport }',
    subscribers: ['overview-overlay'],
    note: '铺满整窗，卡片按锚点（x/y = 触发器左下角，窗口坐标）摆进视图；数据由浮层自己拉'
  },
  [E.overviewOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['overview-overlay']
  },
  [E.targetPickerOverlayShow]: {
    scope: TARGET,
    payload: '{ source, anchor, viewport, pickerId, ...业务事实 }',
    subscribers: ['target-picker-overlay'],
    note: '与 overview-overlay 同构；选中 / 收起经 overlay:commit 回传发起方'
  },
  [E.targetPickerOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['target-picker-overlay']
  },
  [E.buttonsEditOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['buttons-edit-overlay'],
    note: '主进程驱动，浮层从不收 show'
  },
  [E.hoverurlOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['hoverurl-overlay'],
    note: '显示走 hover-url:update + 浮层自己测量后的 display，没有 show'
  },
  [E.zoomOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['zoom-overlay'],
    note: '内容更新走 zoom:changed，没有 show'
  },
  [E.splitToolbarUpdate]: {
    scope: TARGET,
    payload: '{ splitId, layout, count, memberIndex, members, activeTabId, panes, dragging }',
    subscribers: ['split-toolbar']
  },
  [E.splitToolbarHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['split-toolbar']
  },
  [E.searchbarOverlayUpdateSelection]: {
    scope: TARGET,
    payload: '{ selectedIndex }',
    subscribers: ['searchbar-overlay']
  },
  [E.overlayShowPasswordMenu]: {
    scope: TARGET,
    payload: '{ hostname, credentials, x, y, viewport }',
    subscribers: ['overlay'],
    note: 'x / y 为窗口内容区坐标；viewport 是活动网页矩形，浮层只在其中落位'
  },
  [E.overlayHidePasswordMenu]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['overlay']
  },
  [E.overlayShowPasswordSave]: {
    scope: TARGET,
    payload: '{ hostname, username, password, readOnlyBackend, viewport }',
    subscribers: ['overlay'],
    note: '保存卡使用活动网页矩形定位；窗口尺寸变化由 overlayPasswordViewport 继续同步'
  },
  [E.overlayPasswordViewport]: {
    scope: TARGET,
    payload: '{ x, y, width, height }',
    subscribers: ['overlay'],
    note: '活动网页在窗口内容区中的矩形；窗口缩放 / 分屏 / 面板变化后推送，密码浮层只在该区域内落位'
  },
  [E.overlayHidePasswordSave]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['overlay']
  },
  [E.overlayShowPasswordUnlock]: {
    scope: TARGET,
    payload: '{ backend, displayName, stage, hostname, signInLabel, signInHint, signInFields, unlockHint, message, viewport }',
    subscribers: ['overlay'],
    note: '保险库锁着时先弹「解锁 / 登录」卡；stage 由后端 status.signInRequired 决定，主进程无厂商分支'
  },
  [E.overlayHidePasswordUnlock]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['overlay'],
    note: '成功 / 取消 / 权威收起（切标签、导航、失焦）三条路都发这一条'
  },
  [E.overlayCommit]: {
    scope: WINDOW,
    payload: '{ kind, value }',
    subscribers: ['ui-shell']
  },
  [E.overlayAction]: {
    scope: WINDOW,
    payload: '{ ...动作 }',
    subscribers: ['ui-shell'],
    note: '调试扩展位：主进程把浮层的动作原样转发给外壳，当前仅打日志；勿删'
  },
  [E.overlayClosed]: {
    scope: WINDOW,
    payload: '{ name }',
    subscribers: ['ui-shell', 'rail']
  },
  [E.shortcutFocusUrl]: {
    scope: WINDOW,
    payload: 'undefined',
    subscribers: ['ui-shell']
  },
  // 「打开总览浮层」：快捷键 / 主进程的「打开的标签」命令只发这一条；
  // 锚点由外壳按空间胶囊的实时矩形算，因此载荷无参数（WINDOW 级，按 windowId 定向）。
  [E.overviewOpen]: {
    scope: WINDOW,
    payload: 'undefined',
    subscribers: ['ui-shell'],
    note: '外壳收后自行组织 show 载荷（焦点由 LayoutCoordinator#SELF_FOCUS_FLOATS 交给浮层）'
  },
  [E.buttonsEditZone]: {
    scope: TARGET,
    payload: "{ surface: 'navbar'|'rail'|'rail-pins'|'chrome'|'panels'|'web-sidebar', segments: [{ key, grow, axis, rect, items }] }",
    subscribers: ['buttons-edit-overlay']
  },
  [E.findResult]: {
    scope: TARGET,
    payload: '{ tabId, requestId, matches, activeMatchOrdinal, finalUpdate }',
    subscribers: ['find-overlay']
  },
  [E.findShow]: {
    scope: TARGET,
    payload: '{ query }',
    subscribers: ['find-overlay']
  },
  [E.findFocus]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['find-overlay']
  },
  [E.hoverUrlUpdate]: {
    scope: TARGET,
    payload: '{ url }',
    subscribers: ['hover-url-overlay'],
    note: '逐帧高频，只发一条视图'
  },
  [E.qrScanSettled]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['scanner-panel']
  },
  [E.qrScanFrameClosed]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['scanner-panel']
  },
  [E.peekTitle]: {
    scope: TARGET,
    payload: 'string',
    subscribers: ['peek-window']
  },
  [E.pwaWindowState]: {
    scope: TARGET,
    payload: '{ maximized, fullscreen, width, height }',
    subscribers: ['pwa-chrome']
  },

  // ── 定向：主进程 → 页面 preload 引擎 ─────────────────────────────────────
  [E.translatePage]: {
    scope: TARGET,
    payload: '{ to: string }',
    subscribers: ['tab-preload'],
    note: '再发一次 = 收起'
  },
  [E.spatialNav]: {
    scope: APP,
    payload: '{ enabled: boolean }',
    subscribers: ['tab-preload'],
    note: '设置变更时广播给所有标签 preload'
  },
  // 专注模式（D5）：整窗原生浮层（out/renderer/break-overlay，见 main/break-overlay.js）。
  //   show 带完整一帧；update 每秒同一份形状；hide 让浮层先播退场动画。
  // 三条都直推给**该窗口的那个浮层**（不走 tab-preload —— 页面内 DOM 盖不住原生视图）。
  [E.breakOverlayShow]: {
    scope: TARGET,
    payload: "{ phase: 'focus'|'break', remainingMs, totalMs, message, paused }",
    subscribers: ['break-overlay']
  },
  [E.breakOverlayUpdate]: {
    scope: TARGET,
    payload: "{ phase: 'focus'|'break', remainingMs, totalMs, message, paused }",
    subscribers: ['break-overlay']
  },
  [E.breakOverlayHide]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['break-overlay']
  },
  [E.passwordAutofillMenuSelect]: {
    scope: TARGET,
    payload: '{ tabId, credentialId }',
    subscribers: ['tab-preload']
  },
  [E.passwordOverlayHidden]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['tab-preload'],
    note: '主进程权威收起密码浮层的回执（发往**发起页** preload）；不同步它，页内 menuOpen 会残留成「点两次才弹」'
  },
  [E.generatePassword]: {
    scope: TARGET,
    payload: 'undefined',
    subscribers: ['tab-preload']
  },
  [E.noteOpenView]: {
    scope: WINDOW,
    payload: '{ folderId?, noteId?, section?, open? }',
    subscribers: ['ui-shell', 'panel-host'],
    note: '收录动作的落点；必须带 windowId，否则每个窗口各开一次面板'
  },

  // ── AI 助手（PART15）────────────────────────────────────────────────────
  // 一律 app 级：载荷自带 sessionId，订阅方按它过滤。做成 window 级会把"同一会话
  // 在独立窗口里继续看"直接堵死（那是 AI 面板双形态的核心场景）。
  [E.aiStateChanged]: {
    scope: APP,
    payload: '{ sessionId, kind, ...patch }',
    subscribers: ['ai-panel', 'ai-detached-window', 'settings-ai'],
    note: 'kind ∈ created|renamed|deleted|model|title；面板据此只更新侧栏，不重排消息流'
  },
  [E.aiUiStateChanged]: {
    scope: APP,
    payload: '{ sessionId, modelChoice, reasoning, approvalMode }',
    subscribers: ['ai-panel', 'ai-detached-window', 'settings-ai'],
    note: '跨宿主共享的界面状态（侧栏 / 独立窗口 / 内部页同一份）；收到后各自对齐，不回写'
  },
  [E.aiStream]: {
    scope: APP,
    payload: "{ sessionId, turnId, frame: 'start'|'chunk'|'end', seq, text?, usage?, error? }",
    subscribers: ['ai-panel', 'ai-detached-window'],
    note: '16ms 合帧；流式只 append 当前节点（不整段重渲染），见 PART15 §12'
  },
  [E.aiIntent]: {
    scope: APP,
    payload: '{ intent, sessionId?, payload? }',
    subscribers: ['ai-panel', 'ai-detached-window'],
    note: '右键菜单意图；面板未开时主进程先存 pending，挂载后经 ai:state 补发'
  },
  [E.aiApprovalRequest]: {
    scope: APP,
    payload: '{ sessionId, approvalId, toolName, args, risk, expiresAt }',
    subscribers: ['ai-panel', 'ai-detached-window'],
    note: '无界面宿主（面板未开）默认 deny 并通知，不在这里空等'
  },
  [E.aiUsageTick]: {
    scope: APP,
    payload: '{ sessionId, model, promptTokens, completionTokens, costUsd? }',
    subscribers: ['ai-panel', 'settings-ai'],
    note: '用量观察者插槽的推送面；只报增量，累计由渲染层或设置页算'
  }
})

/** 路由 → 名册条目（未知路由返回 undefined）。 */
export function eventSpec(route: string): EventSpec | null {
  return Object.prototype.hasOwnProperty.call(EVENT_CATALOG, route)
    ? EVENT_CATALOG[route]
    : null
}

/** 这条路由是否在名册里。 */
export function isKnownEvent(route: string): boolean {
  return typeof route === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CATALOG, route)
}

/** 窗口级事实？这些事件**必须**带 windowId 才能避免多窗口串台。 */
export function isWindowScopedEvent(route: string): boolean {
  const spec = eventSpec(route)
  return !!spec && spec.scope === EVENT_SCOPE.WINDOW
}

/**
 * 给 `infra-ipc#createBroadcaster` 用的**校验端口**（注入式，保持 infra 不反向依赖本表）。
 *
 * @returns {{ has(route: string): boolean, isWindowScoped(route: string): boolean, spec(route: string): EventSpec|undefined }}
 */
export function createEventCatalogPort() : { has(route: string): boolean, isWindowScoped(route: string): boolean, spec(route: string): EventSpec|undefined } {
  return {
    has: isKnownEvent,
    isWindowScoped: isWindowScopedEvent,
    spec(route: string): EventSpec | undefined {
      return eventSpec(route) ?? undefined
    }
  }
}
