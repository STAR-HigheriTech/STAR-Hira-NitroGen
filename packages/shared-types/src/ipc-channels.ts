/**
 * IPC 契约 · 通道枚举（主进程 ⇄ 渲染进程共用）
 *
 * ── 为什么在 packages 里、为什么是 .mjs ────────────────────────
 * 这两张表是**跨进程共享的协议**，不属于任何一个 app 的私有实现，
 * 所以放在 `packages/shared-types`（PACKAGES 层任意层可依赖）。
 * 原先它是 `apps/app-main/src/shared/ipc-contract.js` —— 一个 APPS 层内部的
 * 私有文件，却被 main 侧（CJS，靠 `await import()`）和 renderer 侧（ESM）同时引用。
 *
 * 用 **`.mjs`** 而不是 `.js` 是为了绕开一个死结：
 *   - main 进程是 CJS，renderer 是 ESM，两边都要直接读这张表；
 *   - 本包的 `main` 入口 `src/index.js` 是 CJS，若把本文件写成 `.js` 就会
 *     被 Node 按 CJS 解析，`export const` 直接语法错误。
 *   - `.mjs` 后缀不依赖任何 package.json 的 `type` 字段，Node 与 vite/rollup
 *     都一律按 ESM 处理，是这里唯一不需要额外配置的写法。
 *
 * 新增通道**必须**登记到这两张表 —— 渲染侧与主进程侧都以它为准，
 * 散落的字符串字面量会让"谁在用这个通道"无从查起。
 *
 * ── preload 子集 ──────────────────────────────────────────────
 * preload 需要自己拼通道名的那 26 条，值定义在 `ipc-channels-preload.mjs`
 * （零依赖、体积极小），本文件在末尾把它们并回全量表。
 * 原因：preload 体积趴在首屏关键路径上，不能为了几个名字拉入整张表。
 * 同名 key 由 `withPreload` 当场抛错拦截，不会出现两处定义悄悄分叉。
 */

import { PRELOAD_EVENTS, PRELOAD_ROUTES } from './ipc-channels-preload.js'

/**
 * 合并 preload 子表。
 * 同名 = 契约错误：同一个通道若在两处各写一个值，preload 与主进程会各用各的，
 * 而且没有任何报错 —— 正是"能跑但永远对不上"的那类屎山，故直接炸掉。
 */
function withPreload<T extends Record<string, unknown>, E extends Record<string, unknown>>(
  own: T,
  extra: E,
  table: string
): Readonly<T & E> {
  for (const key of Object.keys(extra)) {
    if (Object.hasOwn(own, key)) {
      throw new Error(`[ipc-channels] ${table} 的 "${key}" 重复定义：preload 子表与主表只能二选一`)
    }
  }
  return { ...own, ...extra }
}

const ROUTES_OWN = {
  // 事件订阅登记（对齐 RT listeners-manager）。
  // 渲染层 `hira.on.subscribe(route, fn)` 会同时发一条 add；退订发 remove。
  // 主进程据此把事件**只发给真正订阅了的 webContents** —— 见 ListenerRegistry。
  // add / remove 两条 preload 也在拼 → 定义在 preload 子表。
  panelList: 'panel:list',
  panelToggle: 'panel:toggle',
  panelShow: 'panel:show',
  // 面板**实际所在侧**（renderer → main 询问：'left' | 'right'）。
  // 与设置项 app.sidebar_position **未必一致**：面板开在「打开它的入口」那一侧
  // （见 panelToggle 的 side 入参），面板宿主必须问真值才知道该把
  // 拖拽手柄放在哪条边。
  panelSide: 'panel:side',
  // **钉住 / 取消钉住**（面板标题栏的图钉按钮 → main）。
  //
  // 钉住 = 常驻：该面板移到**钉住位**（同侧靠网页那一侧的那一格），此后从 rail / 导航栏
  // 切换面板只替换普通位，钉住的面板不会被关闭或**隐式**换边；标题栏的换边按钮仍可显式移动它。
  // 取消钉住 = 回到同侧普通位（仍然开着，只是重新"可被切换替换"）。
  panelPin: 'panel:pin',
  // 与另一侧的**同类型面板位**互换：普通位 ↔ 普通位，钉住位 ↔ 钉住位。
  // 对侧同位为空时就是纯移动；两端视图都复用，不销毁、不重载。
  panelSwapSides: 'panel:swap-sides',
  // 面板目录（id + 中文名 + 图标名 + 顺序 + 段）—— UI 动态装配的数据源。
  // rail / navbar / 按钮编辑浮层据此渲染；插件启停后重新拉取，面板随之增删。
  panelCatalog: 'panel:catalog',
  // 面板**意图预取**（renderer → main，单向、无返回值）。
  // 入口被悬停/按下时发一次：主进程后台把这块面板的视图造好并加载（不占位、不显示）。
  // 与 floatWarm 同一判据 —— 面板"关闭即销毁"，冷启动那笔开销不该落在用户的点击上。
  // 主进程按「单槽 + TTL」管理，用户只是掠过入口就自动回收（见 LayoutCoordinator#preparePanel）。
  panelPrepare: 'panel:prepare',
  layoutSetHeaderHeight: 'layout:setHeaderHeight',
  layoutSetPageLayoutParams: 'layout:setPageLayoutParams',
  layoutSetPanelWidth: 'layout:setPanelWidth',
  layoutSetRailWidth: 'layout:setRailWidth',
  layoutSetRailRestore: 'layout:set-rail-restore',
  // 「把键盘焦点交给某个已打开面板的内容视图」（面板宿主挂载后请一次）。
  // 面板是独立 WebContentsView，renderer 里的 input.focus() 只改**文档内**焦点 ——
  // 视图本身没拿到原生键盘焦点时输入进不去（见 LayoutCoordinator#focusPanel）。
  layoutFocusPanel: 'layout:focus-panel',
  layoutToggleRail: 'layout:toggleRail',
  // rail 贴边唤出：未固定时由光标贴边触发；唤出期间按 rail 自身宽度占位并推挤网页。
  // 与 toggleRail 分开：toggleRail 改固定态，这里只改当前的贴边唤出态。
  layoutSetRailReveal: 'layout:set-rail-reveal',
  // ── 浮层基础设施（单向 fire-and-forget，无需返回值）──────────────────
  // 浮层预热：renderer 声明「马上要用它了」，主进程提前把该浮层的 renderer 载起来。
  floatWarm: 'float:warm',
  // 键盘焦点交还外壳：标签 / 浮层都是独立 WebContentsView，DOM focus 不足以把键盘焦点还给地址栏。
  shellFocus: 'shell:focus',
  // 外壳此刻是否持有一个**可编辑**焦点（外壳 → 主，载荷 `{ editable: boolean }`）。
  // 主进程据此决定「窗口回到前台时要不要把焦点还给网页」—— 用户正在地址栏里打字、
  // 切出去再切回来，必须原样留在地址栏；没有这条就变成"每次切回都被拽回网页"。
  shellFocusState: 'shell:focus-state',
  // 搜索建议选中项同步：renderer → main → searchbar-overlay（与同名事件成对）。
  searchbarOverlayUpdateSelection: 'searchbar-overlay:update-selection',
  tabList: 'tab:list',
  tabProjection: 'tab:projection',
  tabStackCreate: 'tab:stack-create',
  tabStackSet: 'tab:stack-set',
  tabStackToggle: 'tab:stack-toggle',
  tabStackRename: 'tab:stack-rename',
  tabStackSetColor: 'tab:stack-set-color',
  tabStackMerge: 'tab:stack-merge',
  // ── 栈查询与通用 patch ──────────────────────────────────────────────
  //   收口成一组的原因：调用方（右键菜单 / 面板 / 扩展 API）需要「这个标签属于哪个栈」
  //   与「一次改 label+accent」这类能力，此前只能靠投影或多次单字段调用拼出来
  //   —— 前者要全量投影、后者会触发多次 tab:changed。
  tabStackGet: 'tab:stack-get',
  tabStackOfTab: 'tab:stack-get-of-tab',
  tabStackList: 'tab:stack-list',
  tabStackIsTabInAny: 'tab:stack-is-tab-in-any',
  tabStackUpdate: 'tab:stack-update',
  // 解散标签组（成员全部回到散标签、组元数据删掉）。
  // ⚠ 这里**没有** `tab:stack-split`：domain 的 splitStack 是"把**部分**成员迁到另一个新组"，
  //   而菜单上曾拿它冒充「拆分标签组」—— 点下去只是整组换了个内部 id、外观一字不变，
  //   用户感受就是"点了没反应"。语义正确的「解散标签组」见下一条；规则能力仍留在 domain。
  tabStackDissolve: 'tab:stack-dissolve',
  // ── 分屏（Split View）—— 与标签栈**正交**：栈是收纳（一次只见一个），分屏是并列
  //    （全部成员同时可见）。一个标签可以同时在某个栈里、又参与某个分屏。
  //    组元数据（layout / ratios / members / activeTabId）由 `split:changed` 推给渲染层。
  tabSplitCreate: 'tab:split-create',
  // 「与当前活动标签分屏」（对齐 Firefox / Zen 的 Alt+点击标签）。
  // 为什么单独一条而不是让渲染层传两个 tabId：**活动标签只有主进程是权威**
  // —— 横向标签条 / 纵向标签列 / 两个面板共 5 个宿主，各自维护一份"谁是当前标签"
  // 就是 5 份会漂移的状态。宿主只报"被点的那个"，另一个由主进程解析。
  tabSplitWith: 'tab:split-with',
  tabSplitDissolve: 'tab:split-dissolve',
  tabSplitSet: 'tab:split-set',
  tabSplitLayout: 'tab:split-layout',
  tabSplitActive: 'tab:split-active',
  // 按**预设**改比例（均分 / 主格 70% / 主格 30%）。预设 → 比例数组的换算在
  // `shared-types#split-layout.ratiosForPreset` 一处（格数是变量，写死数组会在 3 格时失真），
  // 因此渲染层只报预设名，不自己算比例。
  tabSplitRatioPreset: 'tab:split-ratio-preset',
  // 键盘驱动的**格导航**（上/下/左/右）：从活动格出发找相邻格并切过去。
  // 判定（投影重叠优先、再比距离）在 `shared-types#split-layout.neighborPaneIndex`，
  // 主进程按当前求解结果算 —— 渲染层拿不到格矩形。
  tabSplitFocus: 'tab:split-focus',
  // 复原**最近解散**的分屏组（成员仍在才可复原；已关闭的成员不复活）。
  tabSplitRestore: 'tab:split-restore',
  tabSplitReverse: 'tab:split-reverse',
  tabSplitList: 'tab:split-list',
  // ── 速览（Glance，A1）—— 第三条正交维度：栈收纳 / 分屏并列 / **速览叠放**。
  //    恰好两张卡：front（略小）压住 back（略大）。归属随 `tab:changed` 推
  //    （每条的 `glanceId` / `glanceFront`），不新开几何通道。
  tabGlanceCreate: 'tab:glance-create',
  // 「把被点的标签与当前活动标签叠成速览」（对齐 tabbar 右键「速览」）——
  // 另一个成员由主进程解析（活动标签只有主进程权威，理由同 tabSplitWith）。
  tabGlanceWith: 'tab:glance-with',
  tabGlanceDissolve: 'tab:glance-dissolve',
  // 交换前后（把某成员提为前台大卡）。
  tabGlanceFront: 'tab:glance-front',
  tabGlanceList: 'tab:glance-list',
  /**
   * 「把标签拖到了网页区域」——**单向**（renderer → main，`ngipc:send:` 前缀）。
   *
   * 渲染层只报「哪个标签 / 拖前在看哪个标签 / 落点在本视口里的坐标」，
   * **判定在主进程**：发送者视图的 bounds（主进程独有）+ 内容区矩形（主进程独有）都在那边，
   * 一次加法即得结论。这样**四个纵向宿主 + 横向标签条共用同一套判据** —— 侧栏 view /
   * 覆盖层 / 两个面板都跑在各自独立的渲染进程里，那边根本没有主窗口的外壳 DOM，
   * 任何"在渲染层量一量"的做法（例如命中 `#chrome-content`）只能在其中一个宿主成立。
   */
  tabDragDropContent: 'tab:drag-drop-content',
  // 拖动**开始**（renderer → main，单向）：主进程据此起 30fps 光标采样，
  // 拖动期间把"新格将落在哪一块"推给 dropzone-overlay（见 main/tab-drop-zone.js）。
  // 与上面那条配对：begin 报"开始了"，drop-content 报"松手了"（并带回最后一次意图）。
  // 为什么不能省掉 begin（例如让主进程自己猜）：拖动的开始只有渲染层知道，
  // 而拖动期间**没有任何渲染层事件**可用（指针一进网页原生视图就离开了外壳视口）。
  tabDragDropBegin: 'tab:drag-drop-begin',
  // 拖动**结束但这下不算数**（renderer → main，单向）：落在本列表里（= 排序 / 成组）、
  // 或渲染层判断不出"落在网页上"时走这条，主进程据此**归档整场拖动**（停表 + 收浮层 +
  // 解除侧栏唤出冻结），但**不提交**任何分屏。
  //
  // 为什么必须有它：整场拖动的收尾**不能挂在"有没有落点"上** —— 上一版只在
  // `dropTabOnContent` 那条路上收尾，于是"在列表里松手"（最常见的拖动）会让主进程的
  // 采样表与「侧栏唤出保持」永远留着：分屏黏住、侧栏收不回去。
  // 落地：`ui-common/src/tabRowList.ts` 的 dragend 一律收尾（有落点走 commit，没有走这条）。
  tabDragDropCancel: 'tab:drag-drop-cancel',
  // 落位预览 renderer 已把最新一帧真正应用到 DOM（renderer → main，单向）。
  // `previewId` 逐帧回传，主进程据此区分“事件已投递”和“只改了原生 bounds 但内容没画出来”；
  // 未确认的帧会做低频重推，避免首次冷启动 / 拖拽期合成器重建造成概率性透明空层。
  tabDragDropShown: 'tab:drag-drop-shown',
  // 分屏工具条 → 主进程的一条**命令**通道（裸 ipcMain.on，单向）。
  // 为什么合一条而不是每按钮一条：工具条上的动作会增删，而"命令"的形态是固定的
  //（`{ type: 'action'|'drag-begin'|'drag-end', ... }`）—— 每加一个按钮就多一条 IPC 通道
  // 正是本项目"接线漏一处"的老路。执行权**只在主进程**（工具条不认识 TabManager）。
  splitToolbarCommand: 'split-toolbar:command',
  // 分隔条拖拽：渲染层只报"指针在窗口内容区坐标里的位置"，主进程用共享算术算出新比例
  // （不把"怎么算比例"复制到渲染层，也不让渲染层拿到内容区矩形）。
  layoutSplitDrag: 'layout:split-drag',
  // 分屏几何快照：渲染层挂载时主动拉一次（`split:changed` 是推送，首帧可能早于订阅）。
  layoutSplitGeometry: 'layout:split-geometry',
  // 独立侧栏**聚焦框**几何快照（与 splitGeometry 同一条思路：渲染层挂载时主动拉一次）。
  // 与推送通道 webSidebarChanged 配成一对 —— 快照补"订阅晚于首次推送"，推送补"之后的变化"。
  layoutWebSidebarGeometry: 'layout:web-sidebar-geometry',
  // 速览（A1）**装饰面**几何快照（与 splitGeometry / webSidebarGeometry 同一条思路：
  // 渲染层挂载时主动拉一次 —— `glance:changed` 是推送，而**会话恢复**能在外壳
  // 订阅之前就把速览还原好，那一次推送必然早于订阅）。
  layoutGlanceGeometry: 'layout:glance-geometry',
  // ── 独立侧栏（Web Sidebar）─────────────────────────────────────────
  // 「把这个 URL 在独立侧栏打开」：书签右键 / 收藏面板右键 / 页面右键 / rail 的 `+` 共用这一条。
  // 与 panelToggle **毫无关系**：这条属于侧栏子系统，不进面板目录、不占面板槽
  //（见 docs/web-sidebar-design.md 的「为什么不是 panel」）。
  webSidebarOpen: 'web-sidebar:open',
  // 收起侧栏（invoke：调用方要拿到"已收起"这个结果去同步 UI）。
  webSidebarClose: 'web-sidebar:close',
  // 侧栏**顶部控制条** → 主进程的一条命令通道（裸 ipcMain.on，单向）。
  // 为什么合一条而不是每按钮一条：理由与 splitToolbarCommand 逐字相同 ——
  // 命令的形态是固定的（`{ command }`），而按钮会增删。
  webSidebarCommand: 'web-sidebar:command',
  // 侧栏宽度（用户拖侧栏内缘时逐帧上报；落库由主进程写设置）。
  webSidebarSetWidth: 'web-sidebar:set-width',
  /**
   * **拖动顶条换边**（单向，高频）：拖动中持续上报指针在顶条视图内的 x。
   *
   * 为什么走单向裸通道而不是 invoke：拖动是逐帧的（与面板宽度上报同一形态），
   * 配一个 Promise 只是白造一批待决对象 —— 失败由下一次上报覆盖。
   * 判据与落点都在主进程（它才知道窗口中线与侧栏矩形），渲染层只报"指针在哪"。
   * ⚠ 换边是**实时**的（越过中线侧栏就真的摆过去，与分屏拖分隔条同一手感）——
   * 不做浮层预览：那种带子会被原生网页视图整个盖住。
   */
  webSidebarMovePreview: 'web-sidebar:move-preview',
  /**
   * 松手落定 / 取消换边（单向）：`{ cancel?: boolean }`。
   *
   * 侧栏在拖动途中就已经摆到位了，这条只负责"把结果写进设置"（或复位临时位置），
   * 不再改布局 —— 因此它**没有**侧别参数。
   */
  webSidebarMove: 'web-sidebar:move',
  tabNew: 'tab:new',
  tabNewIncognito: 'tab:new-incognito',
  tabSwitch: 'tab:switch',
  tabClose: 'tab:close',
  tabCloseOthers: 'tab:close-others',
  tabCloseRight: 'tab:close-right',
  tabReorder: 'tab:reorder',
  tabTogglePin: 'tab:toggle-pin',
  // 把标签放进某个固定文件夹（`stackId` 省略 = 默认固定组）。
  // 为什么单开一条：普通标签 → 固定文件夹是 **pin 动作**，不能借 `tab:stack-set`
  // （那条只搬运同种类标签，跨种类会被 tab-policy 拒绝）。见 infra-window#tabLayout.addTabToPinnedGroup。
  tabPinnedGroupAdd: 'tab:pinned-group-add',
  tabToggleMute: 'tab:toggle-mute',
  // 周期性自动刷新（C7）：`{ tabId, intervalMs }`，0 = 关闭。计时器随标签关闭一起停。
  tabAutoRefresh: 'tab:auto-refresh',
  tabDuplicate: 'tab:duplicate',
  tabUndoClose: 'tab:undo-close',
  tabStats: 'tab:stats',
  tabVisibleAfter: 'tab:visible-after',
  tabSleep: 'tab:sleep',
  // 归档单个标签（J9）：关闭 + 记入「归档区」（可恢复）。与自动归档（tabs.archiveAfter）同一条引擎。
  tabArchive: 'tab:archive',
  // 已关闭标签（对齐 RT recently-closed）：列出 / 清空 / 恢复指定项。
  // 纯内存栈，重启即空；恢复的 index 口径 = 列表返回顺序（0 = 最近关闭在前）。
  tabRecentlyClosed: 'tab:recently-closed',
  tabRecentlyClosedClear: 'tab:recently-closed:clear',
  tabRecentlyClosedRestore: 'tab:recently-closed:restore',
  // 标签截图（对齐 RT tab-snapshot）：渲染层问「某标签截图的读取 URL」，
  // 主进程返回 hira://tab-snapshot?id=…（内存 JPEG，每次采集 id 都新 → 天然防缓存）
  tabSnapshot: 'tab:snapshot',
  // 标签内存占用（hover 预览浮层显示「这个标签占多少内存」）：
  // 与 Chromium 风格任务管理器**同源** —— webContents.getOSProcessId() →
  // app.getAppMetrics() 该进程的**独占内存**（口径唯一真源见 main/process-memory.ts）。
  // 渲染层算不出这个数；休眠标签没有活着的渲染进程 → memoryKB 为 null
  //（sleeping 由 TabManager 侧口径给出）。
  tabMemory: 'tab:memory',
  omniboxAction: 'omnibox:action',
  navGo: 'nav:go',
  navBack: 'nav:back',
  navForward: 'nav:forward',
  // 导航历史条目列表（右键前进/后退菜单）与「跳到某条历史」。
  navEntries: 'nav:entries',
  navGoToEntry: 'nav:go-to-entry',
  navReload: 'nav:reload',
  // 中止加载：刷新按钮在「加载中」形态下的动作（对齐 Hira：loading 时刷新键变停止键）。
  // 与 nav:reload 同形状 —— 它只是提前结束当前这次加载，不产生新的导航。
  navStop: 'nav:stop',
  // Domain: Bookmark
  bookmarkList: 'bookmark:list',
  bookmarkAdd: 'bookmark:add',
  bookmarkRemove: 'bookmark:remove',
  bookmarkUpdate: 'bookmark:update',
  bookmarkSearch: 'bookmark:search',
  bookmarkMove: 'bookmark:move',
  // 同父级内重排（拖拽落点回传"该父级下全部子节点"的新顺序）
  bookmarkReorder: 'bookmark:reorder',
  bookmarkExport: 'bookmark:export',
  bookmarkImport: 'bookmark:import',
  // 插件贡献的导入格式清单（扩展点 `bookmark.import-format` 的**声明侧**）：
  // 来自各插件 manifest 的 `contributes.importFormats`。导入页据此渲染格式下拉。
  bookmarkImportFormats: 'bookmark:import-formats',
  // 星标状态同步：按 URL 查询/取消收藏（URL 是渲染端唯一稳定标识，
  // 渲染端拿不到也不该拿 bookmark id）
  bookmarkGetByUrl: 'bookmark:get-by-url',
  bookmarkRemoveByUrl: 'bookmark:remove-by-url',
  // 全量书签树（编辑器文件夹下拉、书签页渲染），单次 IPC 杜绝 N+1
  bookmarkTree: 'bookmark:tree',
  // 面板聚合快照：一次 IPC / 一次 SELECT 取齐 items + pinned + pinnedOrder + folders。
  // 首屏用这条；分次路由保留给增量刷新与局部消费者。
  bookmarkSnapshot: 'bookmark:snapshot',
  // 书签栏（pinned bar）：列表 / 固定切换 / 拖拽整体重排
  bookmarkPinnedList: 'bookmark:pinned-list',
  bookmarkPinnedSet: 'bookmark:pinned-set',
  bookmarkPinnedReorder: 'bookmark:pinned-reorder',
  // rail（侧栏图标栏）的**固定项**：把书签固定成 rail 上的一个图标，点了在独立侧栏打开。
  // 与上面的 pinned（书签栏）是两个独立固定位 —— 书签栏是横向一条、rail 是纵向一列。
  bookmarkRailPinnedList: 'bookmark:rail-pinned-list',
  bookmarkTags: 'bookmark:tags',
  // 标签索引（F-0756~F-0760）：按页面推荐标签 / 已选标签的共现补全
  bookmarkTagSuggestions: 'bookmark:tag-suggestions',
  bookmarkTagAutocomplete: 'bookmark:tag-autocomplete',
  bookmarkRailPinnedSet: 'bookmark:rail-pinned-set',
  // rail 固定区**自己的**顺序（拖拽重排整列）：与书签栏的 pinned-reorder 是两条独立链 ——
  // 在 rail 上拖一下不该把书签栏的顺序一起改掉（两处各有一份 order 字段）。
  bookmarkRailPinnedReorder: 'bookmark:rail-pinned-reorder',
  // 书签自己的**打开偏好**：点击它时默认在独立侧栏打开（无修饰键时生效）。
  // 与 pinned / railPinned 一样是书签属性 —— 逐个书签各异，不做全局开关。
  bookmarkOpenInSidebarSet: 'bookmark:open-in-sidebar-set',
  // 批量打标签 / 批量固定 —— 多选模式的统一写通道（单事务 + 单次广播）。
  // 系统标签在写路径上被解释为固定开关，所以"勾一个标签"与"点固定"是同一条路。
  bookmarkTagBulk: 'bookmark:tag-bulk',
  bookmarkPinnedBulk: 'bookmark:pinned-bulk',
  bookmarkRailPinnedBulk: 'bookmark:rail-pinned-bulk',
  // 删除一个用户标签（全库摘除该标签，行本身不删）。系统标签（system:*）会被拒绝。
  bookmarkTagDelete: 'bookmark:tag-delete',
  // 自动备份：备份文件清单 / 立即备份 / 从备份恢复
  bookmarkBackupList: 'bookmark:backup-list',
  bookmarkBackupNow: 'bookmark:backup-now',
  bookmarkBackupRestore: 'bookmark:backup-restore',
  // Domain: Note（侧栏笔记 + 文件夹，对齐 Vivaldi Notes）
  // 笔记列表（folderId 省略=全部 / null=根级 / 字符串=该文件夹）
  noteList: 'note:list',
  noteGet: 'note:get',
  noteAdd: 'note:add',
  noteUpdate: 'note:update',
  noteRemove: 'note:remove',
  noteSearch: 'note:search',
  noteMove: 'note:move',
  notePinSet: 'note:pin-set',
  noteReorder: 'note:reorder',
  // 文件夹：列表 / 新建 / 重命名 / 删除 / 各文件夹笔记计数
  noteFolderList: 'note:folder-list',
  noteFolderAdd: 'note:folder-add',
  noteFolderRename: 'note:folder-rename',
  noteFolderRemove: 'note:folder-remove',
  // 拖拽：移动到另一父级 / 同级重排（回传同级全部 id 的新顺序）
  noteFolderMove: 'note:folder-move',
  noteFolderReorder: 'note:folder-reorder',
  noteFolderCounts: 'note:folder-counts',
  // ── 集锦（经典 Edge Collections 完全体）────────────────────────────────
  // 抓取入口：把当前页 / 片段 / 图片收进某文件夹（同一文件夹内 page 同 url 去重）。
  noteCapture: 'note:capture',
  // 回收站：恢复 / 真删 / 列出 / 清空（删除是软删，这几个才是真删与还原）。
  noteRestore: 'note:restore',
  notePurge: 'note:purge',
  noteTrashList: 'note:trash-list',
  noteTrashEmpty: 'note:trash-empty',
  // 引用 / 反链：谁引用了它 / 每张卡被引用几次（列表画 ↩N 徽标）。
  noteBacklinks: 'note:backlinks',
  noteRefCounts: 'note:ref-counts',
  // ── 集锦图片资产（P2）────────────────────────────────────────────────
  // 图片卡此前没有资产通道：右键收图 / 粘贴 / 拖放收进来的图**没有任何字节落地**，
  // 面板只能画类型图标占位。这四条补齐"字节进得来、出得去"：
  //   asset-fetch      按 URL 抓一张图（带当前标签 session 的 cookie 与 referer）→ 落盘
  //   asset-save-buffer 渲染层从剪贴板 / 拖放拿到的图（dataURL）→ 落盘
  //   asset-thumb      读缩略图 → dataURL（渲染层是独立 WebContentsView，见 notes-assets.js）
  //   asset-open       用系统默认程序打开原图（编辑器「打开原图」）
  noteAssetFetch: 'note:asset-fetch',
  noteAssetSaveBuffer: 'note:asset-save-buffer',
  noteAssetThumb: 'note:asset-thumb',
  noteAssetOpen: 'note:asset-open',
  // 集锦导出到文件（md / html / json）：主进程弹保存框并写盘。
  noteExportFile: 'note:export-file',
  /**
   * 拉取「上一次 open-view 意图」（面板挂载时调用，取完即清）。
   *
   * 为什么需要拉取而不是只靠 `note:open-view` 事件：每个面板是**独立 renderer 进程**，
   * 关掉即销毁（见 LayoutCoordinator 的面板卸载段）。动作层「先 showPanel、再 emit」时
   * 面板可能刚开始加载 —— 订阅还没挂上，事件就丢了（症状：收录完面板开了，但没定位到卡）。
   * 于是：面板**未开**时动作层把载荷留在该窗口的 pending 槽，面板挂载后主动来取一次。
   */
  noteTakeOpenView: 'note:take-open-view',
  // Domain: History
  historyList: 'history:list',
  historySearch: 'history:search',
  historyQueryRange: 'history:query-range',
  historyRemove: 'history:remove',
  historyRemoveMany: 'history:remove-many',
  historyRemoveBefore: 'history:remove-before',
  historyClear: 'history:clear',
  /** E1 双表：逐次访问日志（游标分页）—— 历史面板"展开该站点的访问记录"。 */
  historyVisits: 'history:visits',
  // Domain: Download
  downloadList: 'download:list',
  downloadRemove: 'download:remove',
  downloadRemoveMany: 'download:remove-many',
  downloadClearCompleted: 'download:clear-completed',
  downloadOpen: 'download:open',
  downloadShowInFolder: 'download:show-in-folder',
  downloadPause: 'download:pause',
  downloadResume: 'download:resume',
  downloadCancel: 'download:cancel',
  downloadGetFileIcon: 'download:get-file-icon',
  downloadSetRateLimit: 'download:set-rate-limit',
  downloadGetRateLimit: 'download:get-rate-limit',
  downloadRetry: 'download:retry',
  /** 当前**活动**下载数（>0 即"有下载在跑"）。供 rail / navbar 红点在启动时取初始态。 */
  downloadActive: 'download:active',
  // Extension System (C10)
  extensionList: 'extension:list',
  extensionInstall: 'extension:install',
  extensionUninstall: 'extension:uninstall',
  extensionToggle: 'extension:toggle',
  // 「固定扩展」：纯用户意图（写入安装记录、随 profile 持久化），不改变运行时。
  // 与 toggle 分开是语义要求 —— 停用 / 加载失败的扩展同样可以被固定。
  extensionSetPinned: 'extension:set-pinned',
  extensionImportFolder: 'extension:import-folder',
  adblockerStatus: 'adblocker:status',
  adblockerToggle: 'adblocker:toggle',
  adblockerBlockedCount: 'adblocker:blocked-count',
  extensionRuntimeStatus: 'extension:runtime-status',
  extensionReload: 'extension:reload',
  extensionDiagnostics: 'extension:diagnostics',
  extensionWarnings: 'extension:warnings',
  // 打开扩展自身的页面：选项页（新标签页承载）/ 弹出窗口（popup）/ 商店详情页。
  // 「该扩展有没有设置页或弹窗」由列表项的 hasOptionsPage / hasPopup 表达，
  // 因此前两条只负责「真的点了」那一跳，缺能力时响应 ok:false；
  // 商店页由主进程从列表项的 storeUrl 取地址（清单 homepage_url → 商店详情路由回落）。
  extensionOpenOptions: 'extension:open-options',
  extensionOpenPopup: 'extension:open-popup',
  extensionOpenStore: 'extension:open-store',
  // 「检查视图」（对齐 Chrome 扩展详情页的那一栏）：把扩展的后台上下文交给开发者工具。
  // 为什么非要新开一条：全工程此前**没有任何**打开 DevTools 的通道（grep openDevTools
  // 在 apps 下零命中），而这一跳必须落到「某个扩展的后台 WebContents」上 ——
  // 现有通道没有一条能表达这个目标（open-options 是开标签页、ui:popup-menu 是原生菜单）。
  // 列表项里的 `inspectViews[].target` 就是本通道的入参，capability 由主进程产出。
  extensionInspectView: 'extension:inspect-view',
  // 「更新」：立即检查并安装所有扩展的可用更新（对齐 RT 开发者模式工具条的「更新」按钮）。
  // 同样没有可复用的通道：它是一次性的全局动作（无入参、无目标），
  // extension:reload 是「重载某一个」、settings:set 改的是配置，都不是这件事。
  extensionUpdateAll: 'extension:update-all',
  keybindingsGet: 'keybindings:get',
  keybindingsDefaults: 'keybindings:defaults',
  keybindingsSet: 'keybindings:set',
  keybindingsResetOne: 'keybindings:reset-one',
  keybindingsReset: 'keybindings:reset',
  // 录制快捷键时**临时让出内置按键**：`hira://shortcuts` 是普通标签页，
  // 它的 webContents 也挂在 keybindings 上 —— 不让出的话，用户按 Ctrl+T 那一瞬
  // 主进程会先开一个新标签页，页面永远收不到这个键（录制形同失效）。
  // 页面进入编辑时置 true、保存 / 取消 / 导航 / 销毁时自动复位。
  keybindingsSetRecording: 'keybindings:set-recording',
  sessionRead: 'session:read',
  sessionStats: 'session:stats',
  sessionSave: 'session:save',
  sessionRestore: 'session:restore',
  sessionClear: 'session:clear',
  sessionExists: 'session:exists',
  // 「上次关闭」（启动时归档的上一轮会话）：读摘要 / 恢复 / 清除。
  sessionLastClosed: 'session:last-closed',
  sessionLastClosedRestore: 'session:last-closed:restore',
  sessionLastClosedClear: 'session:last-closed:clear',
  // 命名会话 / 会话模板（N14）：存/列/恢复/删。存储走设置项 `sessions.named`（不建新表）。
  sessionNamedList: 'session:named-list',
  sessionNamedSave: 'session:named-save',
  sessionNamedRestore: 'session:named-restore',
  sessionNamedRemove: 'session:named-remove',
  // Domain: Password (S4-1)
  // preload 自己拼通道名的那几条（backends / suggestions / save / never-save / 浮层）
  // 定义在 ipc-channels-preload.mjs。
  passwordSetActive: 'password:set-active',
  // 外部密码后端运行时动作（Bitwarden / 1Password）：probe / unlock / sign-in / sync。
  // 主密码只在这一次 invoke 里经过，域内用完即弃；会话密钥不返回渲染层。
  passwordBackendAction: 'password:backend-action',
  // 安装外部 CLI：主进程弹系统文件选择框并复制到 userData/tools/（不让用户自己搬文件）。
  passwordInstallTool: 'password:install-tool',
  // 密码体检（N8）：常见弱密码 / 强度不足 / 重复使用（本地判定，域不联网）。
  passwordAudit: 'password:audit',
  passwordDelete: 'password:delete',
  passwordList: 'password:list',
  // 密码页专用的单条明文 / 编辑 / 导出入口；主进程额外校验发送方必须是 hira://passwords。
  passwordReveal: 'password:reveal',
  passwordUpdate: 'password:update',
  passwordExport: 'password:export',
  // 凭据 CSV 批量导入（F-0598）：渲染层只递交文件文本，解析与去重全在域内。
  passwordImportCsv: 'password:import-csv',
  // never-save 的 add / list 两条、以及自动填充浮层那组（menu / captured / overlay-commit）
  // 都是 preload 直接拼的 → 定义在 ipc-channels-preload.mjs。
  passwordNeverSaveRemove: 'password:never-save:remove',
  passwordGenerate: 'password:generate',
  // 支付卡 / 地址保管库（N7）：list 只回摘要（掩码）；reveal 是**显式揭示**单条明文。
  formFillList: 'form-fill:list',
  formFillAdd: 'form-fill:add',
  formFillRemove: 'form-fill:remove',
  formFillReveal: 'form-fill:reveal',
  // 填充候选（form-fill:options）是 preload 直接用的 → 定义在 ipc-channels-preload.mjs。
  // Domain: Permission (S4-2)
  permissionGet: 'permission:get',
  permissionResolveRequest: 'permission:resolve-request',
  permissionSet: 'permission:set',
  permissionSetSite: 'permission:set-site',
  permissionResetSite: 'permission:reset-site',
  permissionRemove: 'permission:remove',
  permissionListAll: 'permission:list-all',
  permissionGetSite: 'permission:get-site',
  permissionClearSite: 'permission:clear-site',
  // 类型级默认规则（全局"默认行为"）
  permissionDefaults: 'permission:defaults',
  permissionSetDefault: 'permission:set-default',
  // 批量（按类型批量 / 多站点批量清理）
  permissionSetByType: 'permission:set-by-type',
  permissionClearByType: 'permission:clear-by-type',
  permissionClearSites: 'permission:clear-sites',
  permissionRespond: 'permission:respond',
  permissionPendingList: 'permission:pending-list',
  // Domain: Search (S4-3)
  searchSuggestions: 'search:suggestions',
  searchHistory: 'search:history',
  searchRecord: 'search:record',
  searchRemoveHistoryEntry: 'search:remove-history-entry',
  searchClearHistory: 'search:clear-history',
  // 搜索引擎全量配置（含当前默认引擎 + 各引擎 URL 模板），供地址栏一次性拉取
  searchConfig: 'search:config',
  // 即时答案（F-0771~F-0773）：网络与解析在主进程，渲染层只拿中立事实数组。
  searchInstantAnswer: 'search:instant-answer',
  // 用户自定义 Bang（F-0761~F-0764 / F-0769 / F-1092 / F-1093）
  // 与内置 Bang 分开：内置是代码事实，自定义是用户数据（落 SQLite，按 profile 分区）。
  searchCustomBangs: 'search:custom-bangs',
  searchCustomBangSave: 'search:custom-bang-save',
  searchCustomBangRemove: 'search:custom-bang-remove',
  searchCustomBangUsed: 'search:custom-bang-used',
  // 用户自定义搜索引擎（与内置引擎分离：内置是代码事实，自定义是用户数据）
  //   `search:engines` = 默认引擎下拉的选项源（`[[id,label],…]`），设置页 optionsRoute 消费。
  //   其余四条是 CRUD + 使用计数，形状与 custom-bang 完全对称。
  searchEngines: 'search:engines',
  searchCustomEngines: 'search:custom-engines',
  searchCustomEngineSave: 'search:custom-engine-save',
  searchCustomEngineRemove: 'search:custom-engine-remove',
  // Domain: Automation（D2 命令链 + D3 鼠标手势）
  /** 读配置：命令链 / 手势映射 / 开关 / 命令目录（自动化页与地址栏建议共用）。 */
  automationGet: 'automation:get',
  /** 写配置：只传要改的字段（chains / gestures / gesturesEnabled）。 */
  automationSave: 'automation:save',
  /** 执行：跑一条命令链（`{ chainId }`）或单条命令（`{ action }`）。 */
  automationRun: 'automation:run',
  // automation:gesture / automation:gesture-map 由 preload 手势引擎直接拼 → preload 子表。
  // Domain: Translate（C3 网页翻译）
  // translate:text 由页面翻译引擎直接拼 → preload 子表。
  // Domain: BreakMode（D5 番茄钟 / 专注）
  // break:control 由浮层按钮回传，preload 直接拼 → preload 子表。
  // Domain: ExternalGames — hira-game:// 外部静态 bundle（游戏等）目录清单
  // 目录由 main/external-games/ 扫描 out/external/games/<id>/game.json 生成，
  // 新增一个 bundle = 丢一个目录 + 一个 game.json，无需改动任何代码。
  gameList: 'game:list',
  // Domain: Settings (S5-1)
  // settings:get 也被 preload（spatial-nav）直接拼 → 定义在 preload 子表。
  settingsSet: 'settings:set',
  settingsList: 'settings:list',
  settingsReset: 'settings:reset',
  settingsSchema: 'settings:schema',
  // 设置面板增强：偏离默认键 / 展示型 CSS 变量
  settingsChangedKeys: 'settings:changed-keys',
  settingsCssVars: 'settings:css-vars',
  // 「按空间」写设置（B2 / J13）：给**具名空间**写一个按空间隔离的键。
  // 与 settings:set 的区别只有"写哪个空间"——set 写当前空间，这条写指定空间。
  settingsSetForSpace: 'settings:set-for-space',
  // 选择目录（供「默认下载目录」等 directory 字段：打开原生目录选择器）
  settingsChooseDirectory: 'settings:choose-directory',
  // 「record」型设置的随机生成（如浏览器指纹）：页面只传 schema 里的生成器 id，
  // 生成逻辑住在主进程的 record-generators 注册表，页面不认识具体业务。
  settingsRecordGenerate: 'settings:record-generate',
  // 拼写检查（设置页「语言」分区）：
  //   · languages   —— 运行时可用词典清单（随 Electron 构建/平台变化，故走 IPC 现取）
  //   · dictionary  —— 当前 profile 的自定义词典（右键「添加到词典」加进来的词）
  //   · dictionary-remove —— 从自定义词典删一个词
  // 词典本体在 Chromium 会话里，渲染层无法直接枚举 —— 这三条是与它之间的唯一通道。
  spellcheckLanguages: 'spellcheck:languages',
  spellcheckDictionary: 'spellcheck:dictionary',
  spellcheckDictionaryRemove: 'spellcheck:dictionary-remove',
  // Domain: Theme —— 主题（docs-ng/主题系统设计.md）。
  // 主题是一条**数据**：`theme:list` 给目录，`theme:set` 换主题，`theme:tokens` 给令牌表。
  // 变化经既有 `theme:changed` 事件广播（载荷含 tokens），不新增事件。
  themeList: 'theme:list',
  themeActive: 'theme:active',
  themeSet: 'theme:set',
  // theme:tokens（令牌表，内部页 / preload 自取配色）在 preload 子表 —— 见那里说明。
  themeScheduleGet: 'theme:schedule:get',
  themeScheduleSet: 'theme:schedule:set',
  // 重新扫描主题来源（装/卸主题插件后对账；也可给"打开主题页时刷新"用）。
  themeRefresh: 'theme:refresh',
  // ── 主题编辑器（用户主题）────────────────────────────────────────────
  // 用户主题存在 settings（`app.theme.user_themes`），它们**不是**插件：
  // 装一个插件只为了改三个颜色、还会出现在插件列表里，是把两件事混在一起。
  // 这三条是编辑器的全部写入口，判据（id 前缀、内置不可改）全在 theme-service。
  themeDraft: 'theme:draft',
  themeSave: 'theme:save',
  themeDelete: 'theme:delete',
  // 草稿 → 令牌表（编辑器实时预览用）：**不落盘**，只把一份主题定义换算成最终配色。
  themePreview: 'theme:preview',
  // 「选择背景图片」：开系统文件对话框 → 把图**拷进** app 的主题资产库 → 回一个
  // 可加载的 key/URL（主题里只存 key）。用户主题原本没有资产通道，这条就是那条链。
  themeAssetPick: 'theme:asset:pick',
  // 私密窗口主题：写（`{ id }`，空串 = 与普通窗口相同）。
  // 读走 `theme:list`（它的载荷里带 privateId）—— 不为一个字段单独开一条读口。
  themePrivateSet: 'theme:private:set',
  // ── 主题包分发（P4）─────────────────────────────────────────────────
  // 导出：主题 → zip（含 theme.json + vivaldi.json + 背景图），弹保存框。
  // 导入：zip → 解析/换算 → **落成一个主题插件目录** → 交给插件体系安装。
  // 为什么导入走插件体系：资产的落盘与取用（hira-plugin:// + 目录守卫 + 启停/卸载）
  // 那套能力已经写好并验证过，主题包天然是"一份别人给的东西"，正该由它承接。
  themeExport: 'theme:export',
  themeImport: 'theme:import',
  // Domain: OpenExternal —— 网页打开外部协议（mailto: / 自定义协议）的授权记录。
  // 记录存在 domain-settings 的独立前缀里、由主进程在权限请求那一刻读写；
  // 这两条通道只暴露「列出已授权项 / 撤销一项」，设置页据此展示与撤销。
  openExternalList: 'open-external:list',
  openExternalUnset: 'open-external:unset',
  // Domain: Files —— 系统文件拖入窗口（外壳 / 面板 / 网页任意区域）。
  // files:drop 由 preload 直接拼；分流规则见 main/file-open/policy.js → preload 子表。
  // Domain: Plugins —— Harness 插件中心（PART7 §7.9）。
  // 列出已发现插件（manifest + 运行态）与启用/禁用单个插件。
  // 与 Chrome 扩展（extensions:*）是两套东西：这里是浏览器自身的插件。
  pluginsList: 'plugins:list',
  pluginsSetEnabled: 'plugins:set-enabled',
  // 功能面可用性（§10.4 UI 与引擎的联动禁用）：一次拿到全部功能面的可用布尔。
  // 与 plugins:list 分开 —— 消费方多得多（约二十个 UI 入口），且它们不关心 manifest。
  // 订阅复用 IPC_EVENTS.pluginsChanged，不新增事件。
  featuresAvailability: 'features:availability',
  // 授权第三方插件声明的权限（PART7 §7.5）：scopes 原样回传，UI 无权增减。
  // 传空数组 = 撤销授权。
  pluginsGrantPermissions: 'plugins:grant-permissions',
  // 热重载一个插件（重读 manifest + 重新编译模块代码）。开发插件时的必备入口 ——
  // 此前改一行代码就得重启整个浏览器。
  pluginsReload: 'plugins:reload',
  // 在系统文件管理器里打开「用户插件目录」（`userData/plugins`）——
  // 社区市场的最小可用入口：先让用户知道该往哪放插件，安装器是后话。
  pluginsOpenDir: 'plugins:open-dir',
  // 安装一个插件（社区市场）：从**文件夹**或 **zip 压缩包**装进 `userData/plugins/<id>/`。
  // `path` 省略时由主进程弹系统选择框（来源决定是选目录还是选文件）。
  pluginsInstall: 'plugins:install',
  // 安装一个**用户脚本**（`.user.js`）—— 它是插件的一种（`type: "userscript-plugin"`），
  // 落盘走同一条安装器、收尾走同一个 afterInstallHook：于是启停 / 卸载 / 广播
  // 全部复用插件中心，不需要为脚本再维护一套生命周期。
  // `text` 用于"粘贴安装"；`path` 省略时由主进程弹选择框。
  pluginsInstallUserscript: 'plugins:install-userscript',
  // 用户脚本清单（面板 / 插件中心的展示面）：元数据 + 单脚本启停态，不含源码。
  // 与 `plugins:list` 分开：一个插件可以贡献多条脚本，粒度在**脚本**而不是插件。
  pluginsListUserscripts: 'plugins:list-userscripts',
  // 单条用户脚本的启停（`key` = `<pluginId>/<scriptId>`）。插件开着、但这条不跑。
  pluginsSetUserscriptEnabled: 'plugins:set-userscript-enabled',
  // `userscriptGmRequest`（GM_xmlhttpRequest 代理）由页面 preload 直接拼，
  // 定义在 `ipc-channels-preload.mjs` —— 本表经 withPreload 合并，不能再写一份。
  // 卸载一个**运行时安装**的插件（只删用户目录里的那份，内置插件拒绝）。
  pluginsUninstall: 'plugins:uninstall',
  // 受信任的签名公钥（验签的另一半）：列出 / 导入 / 移除。
  // 没有这几个入口，`signature` 就只是摆设 —— 公钥要用户手工丢进 plugin-trust 目录。
  pluginsTrustList: 'plugins:trust-list',
  pluginsTrustAdd: 'plugins:trust-add',
  pluginsTrustRemove: 'plugins:trust-remove',
  // 插件源（社区市场的索引那一半）：查索引 / 设置源列表 / 一键安装或更新。
  // 索引只是一个静态 JSON，任何静态托管都能放 —— 不需要自建服务端。
  // 支持**多个源**，顺序即优先级（同 id 靠前的胜出）。
  pluginsMarketList: 'plugins:market-list',
  pluginsMarketSetSources: 'plugins:market-set-sources',
  pluginsMarketInstall: 'plugins:market-install',
  // 插件键值存储（开放 API 的持久化面，落点是 profile 库的 plugin_storage 表）。
  //
  // 为什么单独一组而不是复用 `kv`：kv 是全局库、不按 profile 分区（插件数据跨档案串味），
  // 且没有"按插件整体清除"。这一组的每条请求都带 pluginId，主键 (profile_id, plugin_id, key)
  // 天然完成隔离；配额与校验在 `main/plugin-storage.js`（唯一实现处）。
  pluginsStorageGet: 'plugins:storage-get',
  pluginsStorageSet: 'plugins:storage-set',
  pluginsStorageRemove: 'plugins:storage-remove',
  pluginsStorageKeys: 'plugins:storage-keys',
  pluginsStorageClear: 'plugins:storage-clear',
  // Domain: ScreenCapture —— 屏幕抓帧（「扫码器」插件的取景框数据源）。
  //
  // 桌面画面只有主进程拿得到，所以这是一条**很窄**的通道：
  // 「渲染层点一次 → 主进程抓一帧（按取景框裁剪）→ 回像素」。实现在 `qr-scanner`
  // 插件的能力里（`qr.captureScreen`）—— 禁用该插件，这条通道连同它的能力一起失效
  // （`isCapabilityBlocked`），不是"入口没了但还能抓"。
  screenCapture: 'screen:capture',
  // 扫码浮框（可拖动的取景框窗口）的开关。窗口本身是核心的窗口设施
  // （WINDOW_TYPES.QR_SCAN_FRAME），这里只暴露"开一下 / 关一下"。
  screenFrameOpen: 'screen:frame-open',
  screenFrameClose: 'screen:frame-close',
  // 拖框 / 缩放框：取景框页只报**意图** —— `{ mode, edge, dx, dy }`，
  // 矩形由主进程用自己的 `getBounds()` 算（窗口矩形只有主进程是权威）。
  //
  // 为什么不让渲染层把目标矩形算好报上来：渲染层量到的矩形（`window.screenX` 与
  // `window.innerWidth`）和 `setBounds` 用的坐标系在缩放的显示器上并不总是同一个数。
  // 一旦不一致，**第一次落位**就会把窗口"跳"到一个偏大的尺寸 —— 用户看到的就是
  // "按住一下就自己变大"。位移则没有这个问题：它只是一个差值，与矩形无关。
  // 为什么不用 CSS 的 `-webkit-app-region: drag`：透明无边框窗口在部分平台上那条
  // OS 级拖拽并不可靠，而"能拖动"是取景框的**唯一交互** —— 不能压在一个平台特性上。
  screenFrameDrag: 'screen:frame-drag',
  // 上报"用户正在拖动 / 缩放"：交互期间**暂停抓屏**（抓屏是主进程的重活，
  // 边拖边抓 = 拖不动），松手静默一拍后由主进程发出 `qrScanSettled`。
  screenFrameInteract: 'screen:frame-interact',
  // 取景框的**几何快照**（裁剪矩形 + 所在显示器），给"渲染进程自己抓屏"那条路用。
  //
  // 为什么需要它：让屏幕像素**永不进主进程**的唯一办法是渲染层持有屏幕视频流
  // （`getDisplayMedia`，Chromium 原生媒体管线），而"流里的哪一块是取景框"必须由
  // 主进程算（几何权威只此一处，见 screenFrameDrag）。这条通道只回两个矩形，没有像素 ——
  // 比抓一帧整屏便宜四个数量级。
  screenFrameGeometry: 'screen:frame-geometry',
  // Domain: Slots —— 渲染侧插槽宿主（PART7 §7.3 的跨进程那一半）。
  //   slots:render   → 主进程执行插槽，回可序列化描述符（函数已剥掉）
  //   slots:dispatch → 渲染层把项的 key 送回，主进程调用该实现的 onSelect
  // 只放行主进程白名单里的「渲染侧宿主插槽」（如 side-panel.*），不是任意插槽的通道。
  slotsRender: 'slots:render',
  slotsDispatch: 'slots:dispatch',
  // Domain: Plugin Overlays（PART18 开放世界）—— 插件自定义浮层的唯一通道。
  //   plugin:overlay-show (main → renderer)  { key, title, url, anchor, width, height, modal }
  //   plugin:overlay-hide (main → renderer)  { key }
  //   plugins:overlay-close (renderer → main) { key }  用户关掉浮层，回报以便插件得知
  // 为什么浮层内容用 URL（插件内部页）而不是 DOM：函数与 DOM 都过不了 IPC；
  // 浮层内容本来就该是插件自己的页面，渲染侧只负责开一个 iframe 容器。
  pluginsOverlayClose: 'plugins:overlay-close',
  // Domain: NTP 快速拨号（新标签页起始页）
  ntpListSites: 'ntp:list-sites',
  ntpAddSite: 'ntp:add-site',
  ntpRemoveSite: 'ntp:remove-site',
  ntpRenameSite: 'ntp:rename-site',
  // Domain: Profile (W21)
  profileList: 'profile:list',
  profileGetActive: 'profile:get-active',
  profileCreate: 'profile:create',
  profileUpdate: 'profile:update',
  profileSetActive: 'profile:set-active',
  profileRemove: 'profile:remove',
  profileIncognito: 'profile:create-incognito',
  profileVisible: 'profile:list-visible',
  // Domain: Space（工作空间，对齐 RT spaces-controller）
  // 空间归属于 profile；会话数据落 profiles/<profileId>/spaces/<spaceId>/
  spaceList: 'space:list',
  spaceListAll: 'space:list-all',
  spaceGet: 'space:get',
  spaceCreate: 'space:create',
  spaceUpdate: 'space:update',
  spaceMove: 'space:move',
  spaceRemove: 'space:remove',
  spaceReorder: 'space:reorder',
  spaceSetUsing: 'space:set-using',
  spaceGetUsing: 'space:get-using',
  spaceGetLastUsed: 'space:get-last-used',
  // 空间级导出 / 导入（动作型路由）：主进程弹原生保存 / 打开对话框，
  // 用户取消返回 `{ ok:false, canceled:true }`。格式真源在
  // `shared-types/src/space-archive.mjs`；导入永远只在目标 profile 下**新建**空间。
  spaceExport: 'space:export',
  spaceImport: 'space:import',
  // Domain: Cookie（对齐 RT/Chromium 的站点数据管理）
  // 只暴露「列 / 单删 / 全清」三件事；读写都走当前 profile 的 Session，
  // 由主进程用 session.cookies 完成，渲染层永远拿不到 session 对象本身。
  cookieList: 'cookie:list',
  cookieRemove: 'cookie:remove',
  cookieClear: 'cookie:clear',
  // Domain: BrowsingData（清除浏览数据）—— 立即清理路径
  // 与 settings 的 privacy.clear_*_on_exit（退出时清理）互补，不是同一件事。
  browsingDataClear: 'browsing-data:clear',
  // Domain: AppMetrics（任务管理器）—— Chromium 风格进程/内存/CPU 视图
  appMetrics: 'app:metrics',
  appKillProcess: 'app:kill-process',
  // Domain: AppInfo（关于页 / 更新页）—— 版本、运行时、平台与用户数据目录。
  // 渲染进程只能从 UA 字符串反推版本，反推不出**应用自身版本**，故由主进程提供。
  appInfo: 'app:info',
  safeBrowsingContinue: 'security:continue',
  // Domain: Update（软件更新）—— 打开更新页时取一次快照，之后靠 update:changed 事件。
  // 四条刻意分开：检查 / 下载 / 安装是三个不同的用户动作，合并会变成"不知道点了什么"。
  // 状态真源只有 main/update/service.js 一处；渲染层不得自行推导"有没有新版本"。
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  // 默认浏览器：查询 / 设为系统默认（Windows 上登记 http/https 处理器）。
  // 「是不是默认浏览器」只有主进程问得了 Electron，渲染层据此渲染两态按钮。
  appIsDefaultBrowser: 'app:is-default-browser',
  appSetDefaultBrowser: 'app:set-default-browser',
  // Passkey / WebAuthn：能力诊断 + 多账户选择回传。凭据秘密始终留在系统认证器。
  passkeyCapabilities: 'passkey:capabilities',
  passkeySelect: 'passkey:select',
  // OOBE 首次启动引导：状态查询 / 完成（可带「导入数据」）/ 重新运行。
  // 「是否已完成」的真源只有 main/onboarding/index.js 一处（键 app.onboarding_version），
  // 渲染层不得自行推断 —— 否则升版本、重置这些动作会出现两套判断。
  onboardingState: 'onboarding:state',
  onboardingComplete: 'onboarding:complete',
  onboardingReset: 'onboarding:reset',
  // 浏览器一键迁移（Chrome / Edge → Hira）：探测本机来源 / 执行导入。
  // 「有哪些浏览器、能搬什么」只由主进程 adapter 判定（能力位），渲染层不得按浏览器名分支。
  browserImportSources: 'import:sources',
  browserImportRun: 'import:browser-data',
  // 配置档案导出 / 导入（G1 / G2）：两条都是**动作**型路由 ——
  // 主进程弹原生保存 / 打开对话框，用户取消返回 `{ ok:false, canceled:true }`。
  // 格式真源在 `shared-types/src/profile-archive.mjs`；导入永远只**新建** profile。
  appExportProfile: 'app:export-profile',
  appImportProfile: 'app:import-profile',
  // 分享 / 二维码（N15）：`{ text }` → `{ svg }`。生成在主进程（`qr` 是 ESM 依赖），
  // 分享页 `hira://share` 只负责把这段 SVG 内联进 DOM。
  shareQr: 'share:qr',
  captureHubOpen: 'capture-hub:open',
  captureHubCommit: 'capture-hub:commit',
  pageArchiveList: 'page-archive:list',
  pageArchiveSaveActive: 'page-archive:save-active',
  pageArchiveGet: 'page-archive:get',
  // Domain: Page（当前页面信息 / 查看源代码）
  pageInfo: 'page:info',
  pageViewSource: 'page:view-source',
  // 主页地址的唯一解析结果（app.home_mode + app.home_url → 一个 URL）。
  // 壳层的「主页」按钮必须用它与启动页保持同一真源。
  homeUrl: 'home:url',
  // Domain: HTTP Basic 认证（对齐 RT app/basic-auth.ts）
  // 主进程在 app `login` 事件里挂起请求，用独立窗口向用户索要凭据。
  // ready 同时充当「窗口已就绪」的握手：它的响应直接带回本次请求的展示信息。
  httpAuthReady: 'http-auth:ready',
  httpAuthSubmit: 'http-auth:submit',
  httpAuthCancel: 'http-auth:cancel',
  // Domain: Security（崩溃报告 / 证书错误 / 当前站点安全状态）
  // 崩溃记录来自 Electron crashReporter；证书对象只在 certificate-error 回调里出现，
  // 两者渲染层都拿不到，只能由主进程采集后透传。
  crashList: 'crash:list',
  certificateList: 'certificate:list',
  // 当前活动标签（或证书页来源标签）的传输安全与完整证书链。
  // 请求 `{ tabId? }` → `{ secure, protocol, certificate, error? }`：
  // 证书来自 CDP `Network.getCertificate`，主进程用 X509Certificate 解析成扁平字段；
  // 拿不到时依然返回 `{ secure, protocol }`，`certificate` 为 null，浮层据此降级展示。
  securitySite: 'security:site',
  // UI: native context menu
  uiPopupMenu: 'ui:popup-menu',
  /**
   * 读剪贴板纯文本（外壳渲染层 → 主进程）。
   *
   * 为什么不让渲染层用 `navigator.clipboard.readText()`：它受 Permissions-Policy
   * 与「文档必须聚焦」双重限制，外壳（WebContentsView）在原生菜单存续期间还会失焦，
   * 读出来经常是空的。`electron.clipboard.readText()` 没有这些约束，且与原生
   * 菜单里的「粘贴」（role: paste）用的是同一个来源 —— 地址栏「粘贴并前往」必须
   * 与手动粘贴看到**完全一样**的文本。
   */
  clipboardReadText: 'clipboard:read-text',
  // Window controls (frameless window)
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowGetState: 'window:get-state',
  /**
   * 小窗预览的**自绘标题栏高度**上报（小窗渲染页 → 主进程，单向 send）。
   *
   * payload = `{ titlebarHeight: number }`（CSS 像素，窗口内容区坐标）。
   *
   * ── 为什么必须有这条通道 ─────────────────────────────────────────
   * 小窗是"自绘标题栏 + 贴在它之下的**原生 WebContentsView**"（见 main/peek.js）。
   * 原生视图落 bounds 只能由主进程做，而**标题栏多高只有渲染侧知道** —— 它在 DOM 里
   * （padding / 字体 / 按钮尺寸共同决定，且要跟书签编辑器那条标题栏保持一致，
   * 于是更不能写死一个数）。这与 `windowTabbarRect` 是同一条思路：**chrome 几何由
   * 渲染层量、主进程据此给原生视图让位**（见 ipc/tab-drag.js），只是那条挂在
   * "每窗口运行时"上，小窗没有运行时，故单开一条。
   *
   * 幂等：可重复上报（字体加载完高度可能变），主进程只按最新值落位。
   */
  peekChrome: 'peek:chrome',
  // 原生窗口标题（任务栏 / Alt-Tab 上显示的那一行）。
  // 为什么不靠页面 <title> 自动同步：chrome 外壳是 WebContentsView（不是窗口的 document），
  // 它的 document.title 改不到窗口标题上 —— 必须显式告诉主进程。
  windowSetTitle: 'window:set-title',
  windowOpen: 'window:open',
  // 新建浏览器窗口 / 无痕窗口（对齐 RT browser.newWindow / newIncognitoWindow）
  windowNew: 'window:new',
  windowNewIncognito: 'window:new-incognito',
  // 多窗口：列出全部浏览器窗口 / 把一个标签迁到别的窗口
  windowList: 'window:list',
  tabMoveToWindow: 'tab:move-to-window',
  // Overlay（独立浮层图层）：overlay → ui-shell 转发。
  // 具体浮层的打开/关闭走上方 `FLOAT_NAMES` 同名通道（`<name>:show/hide/...`），
  // 不再保留已废弃的 `overlay:show-searchbar` 一族。
  overlayCommit: 'overlay:commit',
  overlayAction: 'overlay:action',
  searchbarOverlaySetInteractive: 'searchbar-overlay:set-interactive',
  searchbarOverlaySetBounds: 'searchbar-overlay:set-bounds',
  searchbarOverlayReady: 'searchbar-overlay:ready',
  tabpreviewOverlaySetInteractive: 'tabpreview-overlay:set-interactive',
  tabpreviewOverlaySetBounds: 'tabpreview-overlay:set-bounds',
  tabpreviewOverlayReady: 'tabpreview-overlay:ready',
  // 站点信息聚合浮层（地址栏锚定）：当前站点权限 / 安全证书 / Cookie / 内容拦截。
  // 与 searchbar 同形：display 由渲染层实测后上报，主进程按 anchor-below 落位。
  siteinfoOverlaySetInteractive: 'siteinfo-overlay:set-interactive',
  siteinfoOverlaySetBounds: 'siteinfo-overlay:set-bounds',
  siteinfoOverlayReady: 'siteinfo-overlay:ready',
  // 权限申请浮层（独立视图）：网页发起权限请求时弹在**内容区左上角**。
  // 它只做「测量后经 display 上报」这一条路径（同 hoverurl / zoom），
  // 故这里只登记 ready；set-bounds / set-interactive 由 FLOAT_NAMES 循环按需跳过。
  permissionOverlayReady: 'permission-overlay:ready',
  // 密码浮层独立图层（多凭据菜单 / 保存提示卡）：专用 bounds/interactive，
  // 不再复用通用 overlay，避免与 searchbar / permission 浮层串扰
  passwordOverlaySetInteractive: 'password-overlay:set-interactive',
  passwordOverlaySetBounds: 'password-overlay:set-bounds',
  passwordOverlayReady: 'password-overlay:ready',
  // ── chrome 级瞬态浮层三兄弟：查找栏 / 悬停 URL / 缩放条 ──────────────────
  // 三者的 `:show` / `:hide` / `:hidden` / `:display` 单向通道由
  // `apps/app-main/src/main/ipc/layout.js#FLOAT_NAMES` 循环按名注册（零新增代码）；
  // 这里只补 `set-bounds` / `set-interactive` / `ready` 三条 invoke 路由 ——
  // 命名规则：`camelize('<name>') + Suffix`，与 searchbar 那三条逐字同形。
  // （三者都只用 `:display` / `:show`：尺寸由渲染页实测后经 display 一次上报，
  //   不需要 set-bounds / set-interactive 这两条 invoke。）
  hoverurlOverlaySetInteractive: 'hoverurl-overlay:set-interactive',
  hoverurlOverlaySetBounds: 'hoverurl-overlay:set-bounds',
  hoverurlOverlayReady: 'hoverurl-overlay:ready',
  zoomOverlaySetInteractive: 'zoom-overlay:set-interactive',
  zoomOverlaySetBounds: 'zoom-overlay:set-bounds',
  zoomOverlayReady: 'zoom-overlay:ready',
  // 拖动落点预览（拖标签到网页区域时"这一格会落在哪"的半透明块）。
  // 与上面三个不同的地方：它是**主进程驱动**的 —— 主进程在拖动期间按 30fps 采样光标、
  // 直接 set-bounds + 推 payload，渲染层从不发起 show/display。
  // 因此这里的三条 invoke 里只有 `ready` 会被用到（渲染页报告"我加载好了"）；
  // 另两条保留同形，便于将来切回"渲染层驱动"的形态。
  dropzoneOverlaySetInteractive: 'dropzone-overlay:set-interactive',
  dropzoneOverlaySetBounds: 'dropzone-overlay:set-bounds',
  dropzoneOverlayReady: 'dropzone-overlay:ready',
  // 通用「选择目标」浮层（renderer/target-picker-overlay）—— 与上面几个同族：
  // show / hide / display 三条单向通道由 ipc/layout.js#FLOAT_NAMES 循环按名注册（零新增代码），
  // 这里只补 set-bounds / set-interactive / ready 三条 invoke 路由（命名规则同 searchbar）。
  // 落位由浮层按外壳报来的锚点矩形 + 主进程补的 viewport 自行算出（见该渲染页文件头）。
  targetPickerOverlaySetInteractive: 'target-picker-overlay:set-interactive',
  targetPickerOverlaySetBounds: 'target-picker-overlay:set-bounds',
  targetPickerOverlayReady: 'target-picker-overlay:ready',
  // 框选截图图层（capture-overlay）的**渲染层 → 主进程**两条单向上报：
  //   select —— 用户框出的矩形 `{x,y,width,height}`（与页面视口同坐标系，见该图层说明）
  //   cancel —— Esc / 点空白 / 框太小
  // show / hide 走 IPC_EVENTS（主进程驱动，与 dropzone 同族），故这里没有对应的 show 路由。
  captureOverlaySelect: 'capture-overlay:select',
  captureOverlayCancel: 'capture-overlay:cancel',
  // 截图标注编辑器（**浏览器窗口内浮层**，三种截图共用）：
  //   load —— 挂载时按 captureId 取走主进程暂存的底图（取走即释放）
  //   copy —— 画布重新编码后的 PNG → 系统剪贴板
  //   save —— 画布重新编码后的 PNG → 「另存为」对话框
  //   close —— 浮层 → 主进程：收起自己（单向，不含返回值）
  //   ready —— 浮层 → 主进程：**首帧已经画出来了**（单向）
  //            `show` 只是把数据送进 renderer，此刻画布还是空的；主进程要等这一条
  //            才能收起下层的框选层 / 淡暗层，否则会出现"先亮回来再压暗"的闪跳。
  captureEditorLoad: 'capture-editor:load',
  captureEditorCopy: 'capture-editor:copy',
  captureEditorSave: 'capture-editor:save',
  captureEditorClose: 'capture-editor:close',
  captureEditorReady: 'capture-editor:ready',
  // 分屏工具条（hover 在分屏上浮出的那排小按钮：拖拽重排 / 切方向 / 反转格序 / 收拢为标签组 / 解散）。
  // 与 dropzone 一样是**主进程驱动**：hover 判定要读原生视图的格矩形（渲染层量不到），
  // 所以 bounds 与形态都由主进程推。这里三条 invoke 里只用到 `ready`。
  splitToolbarSetInteractive: 'split-toolbar:set-interactive',
  splitToolbarSetBounds: 'split-toolbar:set-bounds',
  splitToolbarReady: 'split-toolbar:ready',
  // 页内查找：查找栏窗口 → 主进程 → **活动标签**的 webContents。
  // 用 send（单向）而不是 invoke：查找是高频的（每次输入一个字符都发一次），
  // 结果由 `find:result` 事件异步回来 —— 不需要、也不该等一次往返。
  findQuery: 'find:query',
  // 结束查找：action ∈ 'clearSelection' | 'keepSelection' | 'activateSelection'
  findStop: 'find:stop',
  // 收起查找栏（Esc / ✕）：主进程据此隐藏窗口并结束会话（清页内高亮在同一处收口）。
  findClose: 'find:close',
  // 页面缩放（缩放条浮层 / 快捷键 → 主进程）：
  //   step  —— delta 为 ±1 档（档位语义见 zoom-controller，不是 zoomLevel 的 ±0.5）
  //   reset —— 回到 100%（清掉本站点记忆）
  zoomStep: 'zoom:step',
  zoomReset: 'zoom:reset',
  // 光标边缘监控（对齐 RT interface:cursor-at-edge）：ui-shell 订阅/退订，
  // 主进程按窗口启停 30fps 轮询（无订阅者则完全停表，零 CPU）。
  // 为什么必须走主进程：标签 WebContentsView 盖在 chrome 渲染层之上并吃掉鼠标事件，
  // 渲染层的 mousemove 感知不到窗口边缘，边缘唤出只能由主进程轮询后推。
  // 按钮编辑模式（navbar / rail 的面板按钮排序与显隐）：
  //   set-active / is-active 走 invoke（进入 / 退出编辑模式、查询状态）；
  //   zone 走 send —— 外壳与 rail **各自**把自己那排按钮的几何报上来（自身视图坐标），
  //   主进程按发送方视图补上窗口偏移后转发给编辑浮层（高频、无需返回值）。
  buttonsEditSetActive: 'buttons-edit:set-active',
  buttonsEditIsActive: 'buttons-edit:is-active',
  buttonsEditZone: 'buttons-edit:zone',
  // Layout Studio 文档（积木布局的唯一持久化入口）
  layoutDocumentSnapshot: 'layout-document:snapshot',
  layoutDocumentDispatch: 'layout-document:dispatch',
  layoutDocumentReplace: 'layout-document:replace',
  layoutDocumentReset: 'layout-document:reset',
  layoutDocumentRestore: 'layout-document:restore',
  layoutDocumentExport: 'layout-document:export',
  layoutDocumentImport: 'layout-document:import',
  // 「请重新量一次几何」—— 编辑浮层**每次落点之后**调一次。
  // 为什么需要：按钮被收走 / 放回会改变真实按钮的并集（段会变长变短、宿主会塌成 0×0），
  // 而几何是「进入编辑时上报一次」的快照；不重报的话浮层里的框与按钮会越编辑越偏，
  // 用户下一次落点就只能靠猜（表现为「要一点点精细蹭」）。
  buttonsEditRemeasure: 'buttons-edit:remeasure-request',
  // Domain: TOTP（2FA 验证器插件）
  //
  // ⚠ 这里**没有**「取密钥」这类路由，而且刻意不会有：验证码在**主进程**算，
  // 渲染层只拿 `{ code, remaining, period }`（见 totpCode 的响应）。唯一的例外是
  // totpExportUri —— 它的语义就是"把这条亮出来"（导出到别的 App），所以它单独一条路由，
  // 好审计、好单独收紧。
  totpList: 'totp:list',
  // 当前所有条目的验证码；带 id 则只算那一条（响应里的 now 供渲染层对齐倒计时）
  totpCode: 'totp:code',
  totpAdd: 'totp:add',
  totpUpdate: 'totp:update',
  totpRemove: 'totp:remove',
  // 批量导入：只收 `otpauth://` URI —— 各家 App 的导出格式在渲染层就转成 URI 了，
  // 于是"再支持一家新 App"不需要碰主进程一行
  totpImport: 'totp:import',
  totpExportUri: 'totp:export-uri',
  // 联网校准本机时钟偏差（`{ reset: true }` = 清掉偏移、回到纯本机时间）。
  // 偏移由主进程保存并在算码时叠加 —— 只影响验证码，不改系统时间。
  totpCalibrate: 'totp:calibrate',
  // Domain: PWA（把站点安装为应用）
  //
  // 安装链路是「探测 → 准备 → 确认 → 安装」两段式：
  //   pwaCandidate（单向 send，tab-preload 上报线索）→ pwaDetected（事件，三态）
  //   → pwaPrepare（拿 candidateId + 预览）→ pwaInstall（真正落盘）
  // 候选是渲染层与主进程之间唯一交接凭证，避免把整份 manifest 在 IPC 里来回搬。
  pwaList: 'pwa:list',
  pwaGet: 'pwa:get',
  pwaPrepare: 'pwa:prepare',
  // 轻量查询：切标签时回放该标签的探测状态，不创建候选（见 detect.stateForTab）
  pwaState: 'pwa:state',
  pwaInstall: 'pwa:install',
  pwaUninstall: 'pwa:uninstall',
  pwaLaunch: 'pwa:launch',
  pwaUpdate: 'pwa:update',
  pwaCheckUpdates: 'pwa:check-updates',
  pwaSetRunOnStartup: 'pwa:set-run-on-startup',
  pwaCreateShortcut: 'pwa:create-shortcut',
  pwaRemoveShortcut: 'pwa:remove-shortcut',
  pwaNavigate: 'pwa:navigate',
  pwaGetWindowState: 'pwa:get-window-state',
  // 单向 send：应用窗 chrome 高度上报
  pwaChrome: 'pwa:chrome',
  // 单向 send：tab-preload 上报安装线索 → 定义在 preload 子表。
  // ── PWA 应用窗专用通道 ────────────────────────────────────────────────
  // 为什么另开一套：PWA 应用窗**不在 runtimeRegistry 里**，泛用 `find:* / zoom:*`
  // 路由会 resolve 到主运行时（串台到主窗口）。这些路由在 handler 内按
  // `event.sender` 反查所属应用窗，天然隔离。
  pwaFindQuery: 'pwa:find-query',
  pwaFindStop: 'pwa:find-stop',
  pwaFindClose: 'pwa:find-close',
  // 菜单「查找」入口：与 Ctrl+F 走同一条逻辑（已开且可见 → 只聚焦输入框）。
  pwaFindToggle: 'pwa:find-toggle',
  pwaZoomStep: 'pwa:zoom-step',
  pwaZoomReset: 'pwa:zoom-reset',
  // 浮层（查找栏 / 缩放指示器）布局上报：与主窗口同名浮层共用渲染页，靠 scope 分流
  pwaOverlayDisplay: 'pwa-overlay:display',
  pwaOverlayHide: 'pwa-overlay:hide',
  pwaOverlayReady: 'pwa-overlay:ready',
  // ── Domain: Print（打印预览 / 系统打印 / 另存为 PDF）──────────────────
  //
  // 预览窗口只持有 jobId：页面 → PDF 的渲染、系统打印对话框全部在主进程
  // （见 main/print/service.ts）。这里四条的职责各不相同，刻意不合并：
  //   printJob    —— 取 job 元数据（标题 / URL，预览页首帧用）
  //   printRender —— 按当前选项渲染 PDF，返回带 rev 的 hira://print-pdf 地址
  //   printCommit —— 把**源页面**交给系统打印对话框（保真度与 Ctrl+P 一致）
  //   printSavePdf—— 渲染后另存为 PDF（保存对话框的父窗口是预览窗口自己）
  //   printClose  —— 预览窗口关闭时释放 job（不再攥着源 WebContents 引用）
  printJob: 'print:job',
  printRender: 'print:render',
  printCommit: 'print:commit',
  printSavePdf: 'print:save-pdf',
  printClose: 'print:close',

  // ── Domain: AI 助手（PART15）─────────────────────────────────────────
  //
  // 全部由 `ai-engine` 插件在第一方 kernel 端口上自注册（禁用即撤销）。
  // 命名规约：`ai:<域>`，读操作是名词、写操作是动词。载荷一律带 sessionId
  // （或返回 sessionId），面板/独立窗口按它过滤推送 —— 多窗口不串台。
  //
  //   aiState          —— 打开面板时的**唯一快照**：会话、模型、待决意图、进行中的回合
  //   aiSessionList    —— 会话列表（左侧历史）
  //   aiSessionCreate / Rename / Delete
  //   aiSessionMessages—— 事件日志的**投影**（分页读，不整段搬）
  //   aiSend / aiStop  —— 一个回合的开始 / 中止
  //   aiApproval       —— 审批卡的裁决回传（allow/deny + 是否记住）
  //   aiIntentInvoke   —— 右键菜单意图入口（explain/translate/…）
  //   aiContextCapture —— 截图 / 拖入 / 页面快照的上下文采集
  //   aiProvider*      —— 模型服务 CRUD + 连接测试
  //   aiSkill*         —— 技能 CRUD
  //   aiUsage / aiPurge—— 用量统计 / 彻底移除（清空全部 AI 数据）
  aiState: 'ai:state',
  // 跨宿主共享的界面状态（当前会话 / 模型 / 推理档位 / 审批模式）。
  // 侧栏面板、独立窗口、内部页是三个渲染进程，同一次选择必须落成**一份** ——
  // 读用 `aiUiState`，写用 `aiUiStateSet`，变更由 `aiUiStateChanged` 广播。
  aiUiState: 'ai:ui-state',
  aiUiStateSet: 'ai:ui-state:set',
  aiSessionList: 'ai:session:list',
  aiSessionCreate: 'ai:session:create',
  aiSessionRename: 'ai:session:rename',
  aiSessionDelete: 'ai:session:delete',
  aiSessionMessages: 'ai:session:messages',
  aiSessionSearch: 'ai:session:search',
  aiSessionExport: 'ai:session:export',
  aiSend: 'ai:send',
  aiSteer: 'ai:steer',
  aiRetry: 'ai:retry',
  aiStop: 'ai:stop',
  aiApproval: 'ai:approval',
  aiIntentInvoke: 'ai:intent:invoke',
  aiContextCapture: 'ai:context:capture',
  aiContextCandidates: 'ai:context:candidates',
  aiContextReveal: 'ai:context:reveal',
  aiProviderList: 'ai:provider:list',
  aiProviderSave: 'ai:provider:save',
  aiProviderRemove: 'ai:provider:remove',
  aiProviderTest: 'ai:provider:test',
  aiModelUpsert: 'ai:model:upsert',
  aiModelRemove: 'ai:model:remove',
  aiSkillList: 'ai:skill:list',
  aiSkillSave: 'ai:skill:save',
  aiSkillRemove: 'ai:skill:remove',
  aiSkillSetEnabled: 'ai:skill:set-enabled',
  aiSkillExport: 'ai:skill:export',
  aiSkillImport: 'ai:skill:import',
  aiSkillRun: 'ai:skill:run',
  aiUsage: 'ai:usage',
  aiPurge: 'ai:purge',
  aiAuditExport: 'ai:audit:export',
  // 面板 → 窗口 / 窗口 → 面板的**通用**形态切换（与 AI 无关，任何面板都能用）：
  //   { panelId, direction: 'detach'|'dock', state? }
  // 主进程据此开/关 detached-panel 窗口并把面板状态带过去（同实例语义）。
  panelTransfer: 'panel:transfer',
  // 取走「迁移到本宿主」的那份状态（renderer → main，一次即焚）。
  //   { panelId } → { state: unknown|null }
  // 面板宿主在**挂载后**调用：dock 方向下侧栏面板是**新造**的渲染进程，
  // 主进程广播的 panel:transferred 事件必然早于它加载完成 —— 事件会丢，所以再给一条拉取。
  panelTransferState: 'panel:transfer-state'
}

export const IPC_ROUTES = withPreload(ROUTES_OWN, PRELOAD_ROUTES, 'IPC_ROUTES')

const EVENTS_OWN = {
  tabChanged: 'tab:changed',
  tabLoading: 'tab:loading',
  /**
   * 主框架导航**已提交**（main → **该窗口**外壳 renderer）。payload = `{ tabId, url, inPage, active }`。
   *
   * 与 `tab:loading` 分工明确：那一条报的是「开始/结束加载」，起点那一刻 `t.url`
   * 还是**上一页**的地址（Chromium 尚未提交新文档），拿它回填地址栏会闪回旧网址。
   * 本事件只在 `did-navigate` / `did-navigate-in-page` 写回 `t.url` **之后**发出，
   * 因此它是「地址栏该显示什么」的唯一权威时刻 —— 刷新（同 URL 重新提交）也走这里。
   */
  tabNavigated: 'tab:navigated',
  // 分屏几何变化（main → **该窗口**外壳 renderer）：分隔条与格矩形由渲染层画。
  // 与 tab:changed 分开：窗口 resize / 面板开关 / 侧栏切换都会改变几何，但那些
  // 不是标签状态变化 —— 塞进 tab:changed 会让整条标签栏在这些动作里白重渲染一遍。
  splitChanged: 'split:changed',
  /**
   * 跨窗口标签同步（A5 / J15）的**截图占位**（main → 某一个窗口的外壳 renderer）。
   *
   * payload = `{ url: string|null }`：`url` 是 `hira://tab-snapshot?id=…` 的读取地址
   * （渲染层只持地址、不持字节，与 tabpreview-overlay 同款）；`null` = 收起占位。
   *
   * 为什么需要它：同步把活动标签的真实视图迁走后，原窗口那块内容区**变成空的**
   * （没有任何 WebContentsView）。外壳此时正好**可以**在这块空区域作画（与分屏分隔条
   * 只能画在 paneGap 里不同，这里根本没有网页盖着）—— 于是贴一张截图，避免"移动瞬间"的空白。
   */
  tabSyncPlaceholder: 'tabs:sync-placeholder',
  // 拖动落点预览的形状（main → dropzone-overlay renderer）。
  // payload = { mode:'split'|'join'|'blocked', zone?, layout?, count?, maxPanes? }
  // 只描述"长什么样"：**显示多大**是主进程 setBounds 的事（视图矩形 = 预览块矩形本身），
  // 所以这条载荷在整次拖动里只在"跨过中线/换形态"时才有变化（见 tab-drop-zone.js 的去重）。
  dropzoneUpdate: 'dropzone-overlay:update',
  // 收起预览（main → dropzone-overlay renderer）：拖动结束 / 取消 / 窗口失焦时复位 DOM。
  dropzoneHide: 'dropzone-overlay:hide',
  // ── 框选截图（J7 收口）：图层是独立原生视图，主进程驱动（同 dropzone 一族）──
  // show / hide 由主进程直接推给该视图；select / cancel 是渲染层 →
  // 主进程的单向上报（框选矩形 / 取消），路由见 IPC_ROUTES 的两条同名项。
  captureOverlayShow: 'capture-overlay:show',
  captureOverlayHide: 'capture-overlay:hide',
  // settle —— 标注浮层首帧已经出图，框选层可以把"选区外 0.45"淡出、交给上层接管。
  // 没有这一条，两层等量淡暗会叠加成 0.6975，在收层前那 1~2 帧就是"周围忽然更黑"。
  captureOverlaySettle: 'capture-overlay:settle',
  // ── 截图标注浮层（capture-editor，浏览器窗口内、盖在目标网页视图上）──
  // show 带 `{ captureId, place }`：底图仍走 captureId 暂存（大图不进 IPC 的论文见
  // main/capture-editor.js）；hide 让浮层复位并释放画布。
  captureEditorShow: 'capture-editor:show',
  captureEditorHide: 'capture-editor:hide',
  // ── 专注模式（D5）：整窗浮层 ──────────────────────────────────────────
  // show 带完整一帧 `{ phase, remainingMs, totalMs, message, paused }`；
  // update 每秒推同一份形状（计时 / 阶段唯一真源在主进程，浮层只负责画）；
  // hide 让浮层先播退场动画（主进程随后零 bounds 收起视图）。
  // 三条都由 main/break-overlay.js 直接推给该窗口的浮层 —— 不走 FLOAT_NAMES
  // （它管的是"外壳驱动"的浮层显隐，这一族的显隐由番茄钟状态机驱动）。
  breakOverlayShow: 'break-overlay:show',
  breakOverlayUpdate: 'break-overlay:update',
  breakOverlayHide: 'break-overlay:hide',

  // ── 浮层 show / hide（main → 该浮层 renderer）──────────────────────────
  // 这一族由 `main/ipc/layout.js#FLOAT_NAMES` 循环按名字注册（`<name>:show / hide /
  // hidden / display`）。其中 `show` / `hide` 是**主进程推给浮层的事件**，渲染层要
  // 订阅，所以必须收进 IPC_EVENTS 并在 event-catalog 登记 —— 订阅侧告警只认名册
  // （见 main/app/preboot.js#createSubscriptionAudit）。
  // `hidden` / `display` 是浮层 → 主进程的上报方向，不属于"事件"，故不列。
  // 只登记真实存在的方向：hoverurl / zoom / buttons-edit 从不发 show（前者自己
  // 测量后走 display，后两者由主进程驱动），补一条没人发的 show 就是死常量。
  searchbarOverlayShow: 'searchbar-overlay:show',
  searchbarOverlayHide: 'searchbar-overlay:hide',
  tabpreviewOverlayShow: 'tabpreview-overlay:show',
  tabpreviewOverlayHide: 'tabpreview-overlay:hide',
  siteinfoOverlayShow: 'siteinfo-overlay:show',
  siteinfoOverlayHide: 'siteinfo-overlay:hide',
  // 权限申请浮层（独立视图）：请求列表变化时外壳推 show（带 requests），
  // 列表清空 / 全部处理完时推 hide。
  permissionOverlayShow: 'permission-overlay:show',
  permissionOverlayHide: 'permission-overlay:hide',
  // 「总览」浮层（空间胶囊的下拉卡片）：show 带锚点矩形（触发器在窗口坐标系里的左下角），
  // hide 由外壳 / 主进程判处收起。
  overviewOverlayShow: 'overview-overlay:show',
  overviewOverlayHide: 'overview-overlay:hide',
  targetPickerOverlayShow: 'target-picker-overlay:show',
  targetPickerOverlayHide: 'target-picker-overlay:hide',
  buttonsEditOverlayHide: 'buttons-edit-overlay:hide',
  hoverurlOverlayHide: 'hoverurl-overlay:hide',
  zoomOverlayHide: 'zoom-overlay:hide',
  // 分屏工具条的形态（main → split-toolbar renderer）：
  //   payload = { splitId, layout, count, memberIndex, members, activeTabId, panes, dragging }
  //   `panes` 是**相对工具条视图原点**的矩形（拖动模式下视图铺满整片分屏区域，要拿它画高亮）。
  splitToolbarUpdate: 'split-toolbar:update',
  // 收起工具条（main → split-toolbar renderer）。
  splitToolbarHide: 'split-toolbar:hide',
  // ── 速览的外环阴影（A1，main → 本窗口**外壳**）──
  //   payload = { back, radius }：`back` 是两张卡里更大那张（back 卡）的矩形，
  //   **窗口内容区坐标**（与 `split:changed` 的格矩形同一坐标系）；`back: null` = 收起。
  //   外壳拿它画一个完全透明的方块 + box-shadow（阴影画在框外 ⇒ 只有卡片之外那一圈可见）。
  //   ⚠ 卡间投影 + 蓝聚焦框**不走这条通道**：front 卡的左右边坐在 back 卡身上
  //     （那片像素归 back 那张原生视图所有，外壳 DOM 到不了）—— 它们注入进 **back 卡
  //     那一页**里，见 infra-window/glance-deck-chrome.js。
  // 为什么由主进程推：卡片矩形只有主进程算得出来（内容区算术 + 视图 bounds 都在那边）。
  // 为什么收给**外壳 DOM** 而不是独立浮层视图：阴影落在"没有任何网页 view 覆盖"的那圈
  //   留白里，而 chrome（窗口本体）天然在所有子视图之下、恰好在那些区域露出来 ——
  //   与分屏分隔条、侧栏聚焦框同一条原理（见 `renderer/shared/split-surface.js` 文件头）。
  //   于是**不需要额外渲染进程 / 图层 / IPC 家族**；更要紧的是外壳 DOM **抢不走卡片的点击**
  //   （原生视图永远在它之上）—— 早先做成浮层时，那一层铺满内容区又盖在卡片之上，
  //   把"点背景卡 → 提升前台"与网页点击全吃掉了（`View` 没有可用的 `setIgnoreMouseEvents`）。
  // 命名与 split 对仗：那条几何通道叫 `split:changed`（只走几何，成员关系走 tab 投影），
  //   这条就叫 `glance:changed`。
  glanceChanged: 'glance:changed',
  // 独立侧栏的状态（main → web-sidebar-header renderer，并广播给外壳）：
  //   payload = { open, url, title, favicon, loading, canGoBack, canGoForward }
  // 为什么由主进程推：这些事实都只在主进程手里（导航历史 / 加载态 / 页面标题），
  // 侧栏顶条是个哑壳，只负责画。
  webSidebarState: 'web-sidebar:state',
  /**
   * 独立侧栏**聚焦框**几何（main → 本窗口外壳）。
   *
   * 与 `split:changed` **刻意分开**：侧栏与分屏是两套系统，只是"在让出的缝里画一个淡蓝框"
   * 这件事长得一样。合到一条通道，两边状态会互相覆盖（侧栏一开就把分屏的框刷没了）。
   */
  webSidebarChanged: 'web-sidebar:changed',
  // 书签变更广播（main → 所有 renderer）：任何来源的增删改都推一条，
  // 星标/收藏面板/书签页据此刷新（对齐老版 repo 'changed' 事件总线）
  // payload: { reason, id, url }
  bookmarkChanged: 'bookmark:changed',
  historyChanged: 'history:changed',
  // 笔记变更广播（main → 所有 renderer）：任何来源的增删改都推一条，
  // 笔记面板据此刷新（对齐 bookmark/history 的变更广播）。
  noteChanged: 'note:changed',
  /**
   * 「打开集锦面板并直达某张卡 / 某个集锦」（main → **发起窗口**的外壳）。
   *
   * 为什么需要一条**窗口级**事件而不是直接开面板：收录动作发生在主进程，
   * 而"收录完把这次结果显示出来"的落点是面板里的某个集锦 / 某张卡。
   * 动作层只发意图（`{ folderId?, noteId?, section?, open? }`），
   * 由面板自己决定是进编辑器（`open:true`）还是仅高亮（默认）。
   *
   * ⚠ 必须带 `windowId` 定向发送（见 main.js#emit 的 opts）：广播会让每个窗口各开一次面板。
   */
  noteOpenView: 'note:open-view',
  // TOTP 条目变更广播（main → renderer）：导入/改名/删除后推一条，
  // 面板与插件窗口据此重拉（对齐 bookmark/history/notes 的变更广播）。
  // payload: { reason, id }
  totpChanged: 'totp:changed',
  extensionChanged: 'extension:changed',
  // Harness 插件变更（main → 所有 renderer）：插件被启用/禁用后推一条，
  // 插件中心据此重拉列表 —— 与 bookmark/history 的「变更后对账」同一套路。
  pluginsChanged: 'plugins:changed',
  // 插件「外壳贡献」变更（main → 所有 renderer）：navbar / rail / 标签动作 / 浮层 / 命令
  // 这几类声明式贡献变了就推一条，外壳据此重拉插槽描述符。
  // 为什么不复用 pluginsChanged：那条会让插件中心整表重拉（每加一个按钮都跑一次全量 list），
  // 而外壳刷新只需要三张轻量表 —— 语义与开销都不该混在一起。
  pluginChromeChanged: 'plugins:chrome-changed',
  // 插件浮层（PART18）：主进程按插件请求开 / 关某个浮层。payload 见 IPC_ROUTES.pluginsOverlayClose。
  pluginOverlayShow: 'plugin:overlay-show',
  pluginOverlayHide: 'plugin:overlay-hide',
  // 主题变更（theme:changed，载荷 = 完整发布内容）→ 定义在 preload 子表。
  // 收件方三类：外壳 / 内部页 / 新标签页；私密窗口另有定向推送，语义相同。
  // 内容拦截状态变更（main → 所有 chrome renderer）：blocker 就绪或用户切换都会推。
  // 为什么需要它：blocker 的过滤列表是**后台异步**下载的，启动时读一次状态必然读到
  // 「还未启用」；没有这条事件，盾牌图标就会一直显示为关闭。
  adblockerChanged: 'adblocker:changed',
  // 下载事件（main → 所有 renderer）：progress 携带 speed/eta 供面板实时渲染，
  // done 触发重列。文件路径/ID 等主进程细节仍不向 renderer 泄漏之外字段。
  downloadProgress: 'download:progress',
  downloadDone: 'download:done',
  downloadVerified: 'download:verified',
  // 下载**活动态**跃迁（main → 所有 chrome renderer）：载荷 `{ active: boolean }`。
  // 只在"有/无活动下载"这一条布尔上跃迁时发（不是每个进度都发）——
  // rail / navbar 的下载红点据此常亮，零轮询、零每帧开销。
  downloadActivity: 'download:activity',
  // Window state changes (maximize/unmaximize/fullscreen)
  windowStateChanged: 'window:state-changed',
  // 窗口**真正失活**（切到别的应用 / 别的窗口）。与 windowStateChanged 的区别：
  // 它只在 OS 级失活时发 —— 外壳据此让地址栏当场交还 DOM 光标，避免"切回来又被
  // Chromium 恢复聚焦到地址栏"（外壳自己的 window blur 在标签/浮层抢焦时也会响，不可用）。
  windowBlurred: 'window:blurred',
  // 窗口**重新激活**（OS 级）。与 windowBlurred 成对：外壳用它恢复「自动弹出站点信息
  // 浮层」的判据（后台窗口弹浮层只会打断用户），并作为窗口活跃态的唯一真源。
  windowFocused: 'window:focus',
  // 内容面里的可编辑元素**明确拿到键盘**（main → shell）。外壳收到后立即 blur
  // 地址栏 DOM 焦点，避免地址栏 input 残留 activeElement，在之后任何原生 focus
  // 重放时又把光标自动吸回地址栏。载荷 { reason }，仅作诊断。
  shellFocusReleased: 'shell:focus-released',
  /**
   * 小窗预览（N1）的**网页标题**（main → 小窗自己的渲染页）。
   *
   * 为什么需要它：小窗是自绘标题栏窗口，标题栏由渲染页画，而标题来自**另一个**
   * webContents（承载网页的那个原生视图）的 `page-title-updated` —— 渲染页自己
   * 观测不到（它加载的是 subwindow 入口，不是网页）。原生 `setTitle` 只管任务栏，
   * 画不到自绘标题栏上。
   * payload = 标题字符串（空串 = 回落到"小窗预览"）。
   */
  peekTitle: 'peek:title',
  // ── "主进程 → preload 引擎"的两条线：translate:page / input:spatial-nav
  //    都在 preload 子表（payload 说明见那里）。Break Mode 已迁到整窗浮层，
  //    那三条事件见上面的 EVENTS_OWN（breakOverlayShow / Update / Hide）。
  // Web Prompts 权限请求：网页触发 geolocation/notifications/camera/mic 等权限请求时
  // 主进程通过此事件通知 renderer 显示权限请求弹窗
  permissionRequest: 'permission:request',
  permissionCleared: 'permission:cleared',
  // 搜索建议选中项同步（main → searchbar-overlay）
  searchbarOverlayUpdateSelection: 'searchbar-overlay:update-selection',
  // Overlay 转发事件（main → overlay renderer）
  overlayShowPasswordMenu: 'overlay:show-password-menu',
  overlayHidePasswordMenu: 'overlay:hide-password-menu',
  overlayShowPasswordSave: 'overlay:show-password-save',
  overlayHidePasswordSave: 'overlay:hide-password-save',
  // 活动网页的当前矩形。窗口缩放 / 分屏 / 面板开关后由布局协调器推送，
  // 密码浮层据此重排，始终留在网页可视区域内。
  overlayPasswordViewport: 'overlay:password-viewport',
  // 「解锁 / 登录」卡：保险库锁着时先弹这张，用户完成后自动重试原 getSuggestions。
  overlayShowPasswordUnlock: 'overlay:show-password-unlock',
  overlayHidePasswordUnlock: 'overlay:hide-password-unlock',
  // Overlay 转发事件（main → ui-shell renderer）
  overlayCommit: 'overlay:commit',
  overlayAction: 'overlay:action',
  // 说明：overlayAction 目前仅用于调试日志订阅（保留为扩展位，勿删）。
  // 主进程兜底收起浮层（切标签 / 导航 / 视图失焦）→ 外壳 / rail / 侧栏复位隐身态。
  // payload: { name }
  overlayClosed: 'overlay:closed',
  // 快捷键聚焦地址栏（main → ui-shell）：渲染层只认这一条消息。
  shortcutFocusUrl: 'shortcut:focus-url',
  // 「打开总览浮层」（main → ui-shell）：快捷键 / 主进程命令都只发这一条，
  // 锚点由外壳按空间胶囊的实时矩形算（只有外壳知道那颗按钮在哪）。
  overviewOpen: 'overview:open',
  // 密码浮层回传与权威收起（password:autofill-menu-select / password:overlay-hidden）
  // 都是 preload 订阅的 → 定义在 preload 子表。
  // 原生菜单选中回传（main → 发起方 renderer）：`ui:popup-menu` 的非阻塞对账通道。
  // 主进程弹出菜单后 invoke 立即返回，用户点击的 action（或菜单关闭时的 null）
  // 经此事件按 requestId 回传，避免把 IPC Promise 挂在菜单生命周期上阻塞渲染层。
  // payload: { requestId, action: string|null }
  uiPopupMenuSelected: 'ui:popup-menu-selected',
  // 设置变更广播（main → 所有 renderer）：让改动的设置即时生效
  settingsChanged: 'settings:changed',
  /**
   * 自动更新状态（main → 更新页 / 订阅者）：载荷 = 整份状态快照
   * （`{ supported, status, currentVersion, channel, availableVersion, progress,
   * transferred, total, bytesPerSecond, lastCheckAt, message, error }`）。
   *
   * 推**整体**而不是补丁：状态机只有一处真源（main/update/service.js），
   * 订阅方拿到即可整屏重画 —— 因此订阅方**不得轮询**，也不得自己拼状态。
   * 进度按 ~250ms 节流，状态跃迁立即推送。
   */
  updateChanged: 'update:changed',
  // 面板「实际所在侧」变化（main → **该窗口**的面板宿主）：payload { side: 'left'|'right' }。
  // 只在真值变化时发（面板被换到另一侧 / 设置与面板侧同时改变）。
  panelSideChanged: 'panel:side-changed',
  // 面板**换宿主**（main → 所有 renderer）：payload { panelId, direction: 'detach'|'dock', state, reason? }。
  // 活着的宿主据此收起/恢复自己的状态；新造的宿主用 `panel:transfer-state` 拉一次。
  panelTransferred: 'panel:transferred',
  // 空间变更广播（main → 所有 renderer）：创建/更新/删除/重排后推一条，
  // 空间切换器与设置页据此重拉列表（对齐 RT spaces:on-changed）
  spaceChanged: 'space:changed',
  // 窗口当前空间变更（main → 该窗口 renderer）：对齐 RT spaces:on-set-window-space。
  // 跨 profile 的空间切换由主进程判定 profile 是否也随之切换。
  spaceWindowChanged: 'space:window-changed',
  // **当前 profile 变了**（main → 所有 renderer）：切 profile，或切到"属于别的 profile 的空间"
  // 时推一条，payload { profileId }。
  //
  // 为什么需要它（与 settings:changed 分工不同）：设置那条只覆盖"设置值"这一件事 ——
  // 各界面**自己的数据**（面板列表、书签栏、侧栏…）全是按 profile 分区的，
  // 数据域不会因为换了用户就自己发一条 changed。没有这条事件，界面会**一直显示上一个
  // profile 的内容**，直到用户手动关掉重开。收到它就该重取自己那份数据。
  profileChanged: 'profile:changed',
  // 手势配置热更新（automation:gestures-config）与触发密码生成（password:generate-request）
  // 由 preload 订阅 → 定义在 preload 子表。
  // 光标边缘事件（main → ui-shell renderer）：payload { edge:'left'|'right'|null, x, y }。
  // 订阅方据此做进入边缘与越界回落判定。
  // 按钮编辑模式开关（main → **该窗口**的外壳 / rail / 编辑浮层）：
  //   外壳与 rail 收到 true 时「先量几何上报、再把自己那排按钮隐身」；
  //   编辑浮层据此开始 / 结束编辑。窗口级事件，不走全量广播。
  buttonsEditActive: 'buttons-edit:active',
  // 某一排按钮的几何（main → 编辑浮层）：已按发送方视图换算成**窗口内容区坐标**。
  // payload: { surface: 'navbar'|'rail'|'rail-pins'|'chrome'|'panels'|'web-sidebar', segments: [{ key, grow, axis, rect, items }] }
  buttonsEditZone: 'buttons-edit:zone',
  layoutDocumentChanged: 'layout-document:changed',
  // ── 页内查找（main → 查找栏浮层）────────────────────────────────────
  // payload: { tabId, requestId, matches, activeMatchOrdinal, finalUpdate }
  //   matches = **本次会话已扫到的**命中总数（Chromium 边扫边报，数字会往上爬）；
  //   activeMatchOrdinal = 当前是第几条（从 1 起）
  //   finalUpdate = 这一条是不是"扫完了" —— 浮层据此区分"还没扫完的 0"与"确实没有"。
  // 只发给查找栏浮层（其他视图没有显示它的需求）→ 不走 broadcaster 广播。
  findResult: 'find:result',
  // 查找栏显示（main → 查找栏浮层）：payload { query }
  //   query = 该标签本次会话的查询串（关栏即清，所以通常是空串）。
  findShow: 'find:show',
  // 只把焦点召回输入框（main → 查找栏浮层）：连按 Ctrl+F 时用 ——
  // 不是新会话，因此**不带 query**（不重跑搜索、不重置匹配位置）。
  findFocus: 'find:focus',
  // ── 链接悬停 URL（main → 悬停 URL 浮层）──────────────────────────────
  // payload: { url }（空串 = 指针离开链接 / 标签切走 / 页面开始导航 → 收起）
  // 这是逐帧高频事件（鼠标每滑过一个链接就变），只发给该浮层一条视图。
  hoverUrlUpdate: 'hover-url:update',
  // ── 页面缩放变化（main → 缩放条浮层 + **该窗口**外壳）────────────────
  // payload: { level, percent, origin, source }
  //   level   = Chromium zoomLevel（0 = 100%）
  //   percent = 人类可读百分比（100 / 110 / 125 …）
  //   source  = 'shortcut' | 'wheel' | 'overlay' | 'restore' —— 浮层据此决定要不要弹出来
  // 外壳也收：地址栏/工具区将来要显示缩放徽标时不必再拉一条通道（同一条事实只推一次）。
  zoomChanged: 'zoom:changed',
  // 请外壳 / rail 重新量一次自己那排按钮的几何（main → **该窗口**的外壳与 rail）。
  // 由编辑浮层在一次落点落库后触发：真实按钮刚变，浮层手里的几何必须跟着变。
  buttonsEditRemeasure: 'buttons-edit:remeasure',
  // 编辑期低精度窗口快照（main → 编辑浮层）。仅在进入编辑与横/竖大布局变化时更新，
  // 拖动时从这份缓存裁切，不再重新绘制整套仿真控件。
  // 模态浮层开合（main → **该窗口**的 chrome 图层：ui-shell / rail / panel 宿主）。
  // payload: { open: boolean }
  //
  // 为什么必须有这条：`-webkit-app-region` 由 Chromium 按**整个窗口**合并所有
  // WebContentsView 的 drag 命中区 —— 铺满整窗的模态浮层（空间菜单 / 按钮编辑）
  // 盖在 panel 标题栏、navbar、tabbar、rail 的拖拽区之上时，点击被窗口当作拖动标题栏
  // 吃掉，浮层自己反而点不动。浮层无法「覆盖」drag，只能让下层**主动放弃**。
  // 各图层据此切换 html.hira-overlay-modal（见 ui-common#setOverlayDragSuppressed）。
  overlayModal: 'overlay:modal',
  // chrome 收起期间（沉浸模式未唤出 / 全屏）禁止窗口拖拽区（main → 该窗口的
  // ui-shell / rail / panel 宿主）。payload: { suppressed: boolean }
  //
  // 为什么独立于 overlay:modal：收起态没有可点击的浮层，但仍有一个窗口级事实需要
  // 各 WebContentsView 同时遵守 —— Chromium 会把所有视图的 -webkit-app-region 合并，
  // 网页视图盖住 navbar / tabbar 也阻止不了下层 drag 命中。各图层据此切换
  // html.hira-chrome-drag-suppressed（见 ui-common#setChromeDragSuppressed）。
  chromeDragSuppressed: 'layout:chrome-drag-suppressed',
  // 侧栏「悬停唤出」态（main → 该窗口的 chrome 外壳）。
  // payload: { revealed: boolean, window? } —— 只报一个布尔，几何由布局自身算。
  //
  // 为什么需要：唤出是主进程判定的（它拿得到屏幕坐标），但**宽度要挂在渲染层的
  // 侧栏容器上**（同一块 #chrome-side 的两种宽度，见 shared-types#planChromeLayout 的
  // restWidth / revealWidth）。渲染层必须知道自己此刻该用哪一档 —— 否则网页让位了、
  // 侧栏还按老宽度画，边缘会露出残条或留白。
  sideColumnReveal: 'layout:side-column-reveal',
  // 扫码取景框"已经放下"（main → 扫码器面板）：用户拖完 / 缩放完，静默一小段之后发一次。
  //
  // 为什么要有这条：抓屏是主进程最重的一步（整屏回读 + 大块 IPC），**绝不能持续跑** ——
  // 每 600ms 一帧会把主进程占满，表现就是整个界面卡死、鼠标都动不了。
  // 所以扫码改成**触发式**：拖完 → 主进程发这条 → 面板才抓**一帧**解码。
  // 于是静止时**零抓屏、零解码**，代价只在用户真正放下取景框的那一刻。
  qrScanSettled: 'screen:frame-settled',
  // 取景框窗口**被关掉了**（main → 扫码器面板）：用户点了框上的 ✕，或窗口因别的原因销毁。
  //
  // 为什么必须有这条：抓屏改成触发式之后，面板平时**不发任何请求**，也就没有"顺手发现
  // 框没了"的机会（旧版每 600ms 抓一次，顺带就知道框没了）。没有这条事件，用户关掉框
  // 之后面板会一直显示"扫描中"。
  qrScanFrameClosed: 'screen:frame-closed',
  // PWA：应用列表/记录变化（安装、卸载、快捷方式、开机启动开关）
  pwaChanged: 'pwa:changed',
  // PWA：当前标签的探测结果（installed / installable / shortcut / none）
  pwaDetected: 'pwa:detected',
  // PWA：安装进度（stage: icon | shortcut | db，仅用于文案）
  pwaInstallProgress: 'pwa:install-progress',
  // PWA：应用窗最大化/全屏/窗口尺寸变化（chrome 渲染用）
  pwaWindowState: 'pwa:window-state',

  // ── AI 助手（PART15）───────────────────────────────────────────────
  //
  // 应用级事实（scope: app），载荷自带 `sessionId`；面板与独立窗口按它过滤，
  // 于是"同一个会话在两个宿主里同时开着"也能各自只画自己那份。
  //
  //   aiStateChanged   —— 会话级状态变了（新会话 / 改名 / 删除 / 模型切换）
  //   aiStream         —— 流式帧 `{ sessionId, turnId, frame: 'start'|'chunk'|'end', … }`
  //                       **只 append 当前节点**（见 PART15 §12），不重排消息流
  //   aiIntent         —— 右键菜单意图（面板未开时先存 pending，挂载后补发）
  //   aiApprovalRequest—— 工具需要审批（渲染层画审批卡）
  //   aiUsageTick      —— 用量累计（token / 成本），观察者插槽的推送面
  aiStateChanged: 'ai:state-changed',
  // 共享界面状态变了（任一宿主改了会话 / 模型 / 推理 / 审批）。
  // 载荷就是整份状态 —— 三个宿主只读不改，收到后各自对齐界面。
  aiUiStateChanged: 'ai:ui-state-changed',
  aiStream: 'ai:stream',
  aiIntent: 'ai:intent',
  aiApprovalRequest: 'ai:approval-request',
  aiUsageTick: 'ai:usage-tick'
}

export const IPC_EVENTS = withPreload(EVENTS_OWN, PRELOAD_EVENTS, 'IPC_EVENTS')
