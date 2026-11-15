# STAR Hira NG 大换血重写规划 PART 3 - NG 架构设计 (4层严格依赖 + Monorepo模块化)

生成时间：2026-01-03

\=========================================
3.1 核心设计原则 (写在最前面 执行时不可违反)
==========================

D1. 分层依赖规则 (违反即构建失败 Linter检测):
APPS 只能依赖 UI\_COMPONENTS + DOMAIN + INFRA
UI\_COMPONENTS 只能依赖 DOMAIN + INFRA (不能依赖APPS)
DOMAIN 只能依赖 INFRA (不能依赖UI/APPS)
INFRA 最底层 零业务依赖 (纯技术能力)
D2. 全局变量为零: APPS/UI层 不得出现 window\.xxx = 任何业务对象
main 进程不得出现 global.xxx = 业务函数/状态
D3. 无字符串耦合: DOM ID/IPC通道/settings键名 必须从常量枚举文件导入
字符串字面量在源码中不存在 (Linter检测)
D4. 单一数据源 (Single Source of Truth):
任何业务概念在NG中只有一个 canonical 写路径
不允许 places Dexie + Repository + Map 三写
D5. 模块接口统一: 所有功能模块 (书签/历史/下载/设置/扩展...)
必须实现 IHiraModule 标准接口 否则不允许加入 Plugin Registry
D6. UI 像素冻结: 视觉输出与现有系统严格一致
DOM 结构可完全重构 但 CSS computed style 必须 A/B 截图对比通过
D7. 错误隔离 (无连环并发bug):
任何模块 throw 不得影响同进程其他模块运行
模块沙箱 + domain级 try/catch 边界

\=========================================
3.2 4层架构全图 + 职责边界
=================

┌──────────────────────────────────────────────────────────┐
│ Layer 4: APPS (应用入口) │
│ - app-main (主浏览器窗口入口: 加载全部模块 编排启动顺序) │
│ - app-windows (子窗口工厂: 书签编辑器/查找栏/权限对话框) │
│ - app-settings (设置窗口入口) │
│ - app-manager (书签/历史/下载 管理窗口入口) │
│ │
│ 职责: 仅模块加载/启动编排 零业务逻辑 │
├──────────────────────────────────────────────────────────┤
│ Layer 3: UI\_COMPONENTS (UI层 与框架无关) │
│ - ui-tabbar / ui-navbar / ui-webviews │
│ - ui-taskoverlay + 8个面板组件(ui-panel-favorites/...) │
│ - ui-searchbar + 插件系统 ui-searchbar-plugin-\* │
│ - ui-common (list-item / modal / window-controls 共用) │
│ │
│ 职责: 仅负责渲染 + 用户事件捕获 + 调用DOMAIN接口 │
│ 约束: 不得直接操作 INFRA (DB/IPC/FS) │
├──────────────────────────────────────────────────────────┤
│ Layer 2: DOMAIN (领域服务层 核心业务价值 无UI无技术细节) │
│ - domain-bookmark (书签CRUD/文件夹/导入导出 11用例) │
│ - domain-history (历史记录/访问统计/清理策略) │
│ - domain-download (下载管理/多线程/P6检测/状态机) │
│ - domain-tabs (标签/标签组/栈/空间 全生命周期) │
│ - domain-settings (设置键管理 + 迁移 + 类型化读写) │
│ - domain-profile (空间/Profile 隔离) │
│ - domain-password (密码管理器 统一4后端抽象) │
│ - domain-extension (扩展管理 Web Store CRUD) │
│ - domain-permission (站点权限/通知/弹窗 策略) │
│ - domain-search (统一搜索 suggestions + bangs + FT) │
│ - domain-session (会话恢复/崩溃恢复/启动时标签载入) │
│ │
│ 职责: 纯业务逻辑 输入POJO输出POJO 单测可脱离Electron运行 │
│ 约束: 不 import electron / fs / path (只能通过 INFRA 接口注入)
├──────────────────────────────────────────────────────────┤
│ Layer 1: INFRASTRUCTURE (基础设施层 纯技术能力 零业务) │
│ - infra-db (SQLite + Drizzle: Connection Pool + 事务) │
│ - infra-ipc (TypedIpcMain/TypedIpcRenderer + Zod校验) │
│ - infra-window (WindowFactory + 统一BrowserWindow模板) │
│ - infra-plugin (PluginRegistry + 生命周期 + 依赖管理) │
│ - infra-storage (JsonStore抽象 + FileIO原子写 + Watcher) │
│ - infra-logger (统一日志: 分级/滚动/上报/隔离) │
│ - infra-error (ErrorBoundary + 模块沙箱 + 崩溃上报) │
│ - infra-fs (文件系统操作 Promise化 权限封装) │
│ - infra-platform (平台差异封装: win/mac/linux) │
│ - infra-theme (主题系统: 浅/深/跟随OS CSS变量生成) │
│ - infra-l10n (本地化 字符串字典 + 按需加载) │
└──────────────────────────────────────────────────────────┘

\=========================================
3.3 Monorepo 包清单 (pnpm workspaces)
==================================

位置: 1A-STAR\_Hira\_NG/ (与原项目并列 双轨开发 完全独立互不干扰)

1A-STAR\_Hira\_NG/
├─ package.json # pnpm workspaces root + electron-vite dev/build
├─ electron.vite.config.js # 三段式统一构建 (main/preload/renderer)
├─ drizzle.config.js # SQLite schema + migrations 目录
├─ pnpm-workspace.yaml
├─ tsconfig.base.json # // @ts-check 的 JSDoc 配置 (可选TS转JS)
├─ eslint.config.js # 规则: no-global-assign / no-string-ipc / ...
├─ .zodcheckrc # Zod schema 必须覆盖全部IpcHandler配置

├─ apps/ (L4 APPS层)
│ ├─ app-main/ # 主窗口入口 (electron-vite renderer entry #1)
│ │ package.json -> deps: ui-\* domain-\* infra-\*
│ └─ app-subwindows/ # 所有子窗口合集 (多 entry 自动生成)
│ ├─ entries/bookmark-editor/
│ ├─ entries/find-bar/
│ ├─ entries/permission-dialog/ (x6种权限)
│ ├─ entries/js-dialog/ (alert/confirm/prompt)
│ └─ ... (28种子窗口全部独立 entry)
│
├─ ui/ (L3 UI\_COMPONENTS层, 技术栈 原生JS + Web Components)
│ ├─ ui-common/ # 共用UI基础组件
│ │ components/list-item.js (原 listItem.css 组件化版)
│ │ components/modal.js (原 modal.css)
│ │ components/window-controls.js
│ │ styles/base.css (base.css + variables 无全局类)
│ │ exports: { ListItem, Modal, WindowControls, classnames, cssVars }
│ │
│ ├─ ui-tabbar/ # 原 navbar/ 系列 (tabBar + 子组件)
│ │ components/TabBar.js
│ │ components/Tab.js
│ │ components/TabStack.js
│ │ components/TabPreview\.js
│ │ components/AddTabButton.js
│ │ components/TabEditor.js
│ │ hooks/useTabDrag.js (拖拽逻辑独立)
│ │ styles/tabbar.css (全部类前缀 ui-tabbar\_\_ )
│ │ public API: { TabBarElement mount() updateTabs(\[...]) }
│ │ on('tab-select'|'tab-close'|'tab-drag')
│ │ 依赖: infra-platform, domain-tabs (仅读接口 不写DB)
│ │
│ ├─ ui-navbar/ # 导航栏 (地址栏/按钮/进度条)
│ │ components/Navbar.js
│ │ components/NavigationButtons.js
│ │ components/BookmarkStar.js
│ │ components/ProgressBar.js
│ │ components/PermissionRequests.js
│ │ components/ContentBlockingToggle.js
│ │ components/MenuButton.js
│ │ styles/navbar.css (前缀 ui-navbar\_\_ )
│ │ 依赖: ui-searchbar, infra-theme
│ │
│ ├─ ui-searchbar/ # 搜索框 + 插件架构
│ │ core/SearchBarElement.js
│ │ core/PluginRegistry.js (ISearchbarPlugin 接口)
│ │ plugins/BangsPlugin.js
│ │ plugins/CalculatorPlugin.js
│ │ plugins/SearchSuggestionsPlugin.js
│ │ plugins/PlaceSuggestionsPlugin.js
│ │ plugins/HistoryViewerPlugin.js
│ │ plugins/InstantAnswerPlugin.js
│ │ plugins/BookmarkEditorPlugin.js
│ │ plugins/CustomBangsPlugin.js
│ │ plugins/ShortcutButtonsPlugin.js
│ │ plugins/UpdateNotificationsPlugin.js
│ │ styles/searchbar.css
│ │ 依赖: domain-search, infra-l10n
│ │
│ ├─ ui-webviews/ # webview 容器 + 管理 (原 webviews.js)
│ │ WebviewContainerElement.js
│ │ WebviewWrapper.js (单个标签webview的封装)
│ │ GestureHandler.js (webviewGestures.js)
│ │ AudioManager.js (tabAudio.js)
│ │ styles/webviews.css
│ │ 依赖: infra-window, infra-platform, domain-tabs
│ │
│ ├─ ui-taskoverlay/ # 侧栏任务面板
│ │ TaskOverlayElement.js (根容器 zenMode rail展开收起)
│ │ RailModule.js (rail 列图标 + hover浮层)
│ │ SidebarBase.js (面板底座 搜索框/视图切换)
│ │ panels/FavoritesPanel.js (ui-panel-favorites 独立包也行)
│ │ panels/HistoryPanel.js
│ │ panels/DownloadsPanel.js
│ │ panels/ExtensionsPanel.js
│ │ panels/NotesPanel.js
│ │ panels/PinnedPanel.js
│ │ panels/ProfilesPanel.js
│ │ panels/OpenTabsPanel.js
│ │ panels/TabPreviewPanel.js
│ │ util/PanelRegistry.js (IPanel 接口 + 注册中心)
│ │ util/panel-signatures.js
│ │ styles/ (对应 css/taskOverlay/\* 全部分文件 前缀 ui-panel\_\_xxx )
│ │ 依赖: 各 domain 服务, infra-theme, infra-l10n
│ │
│ ├─ ui-findinpage/ # 页面内查找栏 (findinpage.js)
│ ├─ ui-download-manager/ # 下载条 (downloadManager.js)
│ ├─ ui-password-manager/ # 密码捕获条/查看器
│ ├─ ui-modal/ # modal 系统
│ ├─ ui-settings/ # 设置页 UI 组件
│ └─ ui-new-tab/ # 新标签页 定制外壳
│
├─ domain/ (L2 DOMAIN领域层 核心业务 纯JS 可脱离Electron单测)
│ ├─ domain-bookmark/ # 书签系统 (P0 最优先)
│ │ src/IBookmarkService.js (接口定义 = 契约文档)
│ │ src/BookmarkService.js (实现 11个文件夹用例)
│ │ src/usecases/createFolder.js
│ │ src/usecases/moveBookmarksToFolder.js
│ │ src/usecases/renameFolder.js
│ │ src/usecases/deleteFolderCascade.js
│ │ src/usecases/reorderWithinFolder.js
│ │ src/usecases/importBookmarksHTML.js
│ │ src/usecases/exportBookmarksHTML.js
│ │ src/usecases/undoLastOperation.js
│ │ src/schema.js (Zod: Bookmark/Folder/Meta 验证)
│ │ test/ (Vitest 脱离 Electron 跑)
│ │ package.json
│ │ peerDeps: infra-db (只依赖IStorageBackend接口)
│ │ exports only: { createBookmarkService(storage) }
│ │
│ ├─ domain-history/
│ │ src/IHistoryService.js (查询 / 按天分组 / 搜索 / 清理)
│ │ src/HistoryService.js
│ │ src/FullTextSearch.js (比原来 placesSearch 解耦)
│ │ src/HistoryVisitCollector.js (URL去重+访问事实写入)
│ │ src/schema.js (Zod: HistoryUrl/HistoryVisit)
│ │
│ ├─ domain-download/ # 下载系统 (替换 download.js 1000行)
│ │ src/IDownloadService.js
│ │ src/DownloadService.js (单例 进程级)
│ │ src/DownloadTask.js (单个下载 状态机)
│ │ src/MultiConnectionDownloader.js (独立模块 原1200行)
│ │ src/SecurityScanner.js (P6危险文件检测)
│ │ src/FileOpener.js (打开文件/打开文件夹 跨平台)
│ │ src/schema.js
│ │
│ ├─ domain-tabs/ # 标签领域
│ │ src/ITabList.js (增删改查 选择 切换 分组)
│ │ src/TabList.js (纯内存实现 无副作用 可单测)
│ │ src/Tab.js (单个 Tab 数据结构 方法)
│ │ src/TabStack.js (标签栈)
│ │ src/TabGroup.js (标签组)
│ │ src/Workspace.js (工作区/空间)
│ │ src/schema.js (Zod: Tab/TabGroup/Workspace 完整结构)
│ │ test/ (TabList.test.js 100+用例 覆盖所有边界)
│ │
│ ├─ domain-settings/ # 设置领域
│ │ src/ISettingsService.js
│ │ src/SettingsService.js (类型化读写 带schema校验 命名空间)
│ │ src/migrations/ (版本化迁移脚本 取代扁平key坟场)
│ │ src/schema.js (全部设置键 Zod 完整定义)
│ │ src/watch.js (细粒度watch(key\_pattern,cb) 解决雪崩)
│ │
│ ├─ domain-profile/ # 空间/Profile (取代 profileStore.js)
│ │ src/IProfileService.js
│ │ src/ProfileService.js (DB主表 profiles + 按profile隔离)
│ │ src/IsolationItems.js (8项隔离配置独立表格)
│ │
│ ├─ domain-password/ # 密码统一抽象
│ │ src/IPasswordBackend.js (所有后端实现此接口)
│ │ src/backends/BuiltinBackend.js
│ │ src/backends/BitwardenBackend.js
│ │ src/backends/OnePasswordBackend.js
│ │ src/backends/KeychainBackend.js (macOS)
│ │ src/PasswordManagerFacade.js (Facade 分派到后端)
│ │ src/schema.js
│ │
│ ├─ domain-extension/ # 扩展领域
│ ├─ domain-permission/ # 权限领域 (取代 filtering.js + permissionManager.js)
│ ├─ domain-search/ # 搜索领域 (聚合所有 suggestions 来源)
│ └─ domain-session/ # 会话恢复领域
│
├─ infra/ (L1 INFRASTRUCTURE底层)
│ ├─ infra-db/
│ │ src/index.js # better-sqlite3 + drizzle instance 导出
│ │ src/schema.js # PART4 全20+表 drizzle schema
│ │ src/migrator.js # drizzle-kit + 启动时自动runMigrations
│ │ src/Transaction.js # 事务封装 + 跨域事务协调
│ │ src/backups.js # 定时备份 崩溃恢复 回滚点
│ │ drizzle/ # generate 出来的迁移 SQL
│ │
│ ├─ infra-ipc/
│ │ src/TypedIpcMain.js # 封装 ipcMain.handle + Zod schema 强制
│ │ src/TypedIpcRenderer.js# 封装 ipcRenderer.invoke + 返回类型
│ │ src/ListenersManager.js# 自动管理 on/off 随窗口销毁清理
│ │ src/ChannelNames.js # 枚举所有IPC通道 不允许字符串字面量
│ │ src/contracts/ # 每个域一份 Zod IpcContract
│ │ bookmarks.zod.js
│ │ history.zod.js
│ │ tabs.zod.js
│ │ ...
│ │
│ ├─ infra-window/ # ★ PART11 RT webContents 架构增强
│ │ src/WindowFactory.js # 唯一 BrowserWindow 创建入口 (28窗口统一!)
│ │ src/WindowTemplate.js # 标准 webPreferences 模板
│ │ src/WindowRegistry.js # 窗口注册表 getAllByType getOwnerWindow
│ │ src/WindowLifecycle.js # 统一 show/hide/destroy 行为 + 事件
│ │ src/WebContentsManager.js # ★新增: 三类 webContents 生命周期+布局+崩溃处理
│ │ # 类型A UI Shell(1个) + 类型B Panel(0~~8个) + 类型C Tab(0~~N个)
│ │ # 目标: UI(标签栏/导航栏/侧栏容器)=独立 UI Shell webContents；8 面板=各自独立 Panel webContents；每个 Tab=独立 Tab webContents
│ │ # 约束: UI 像素对齐只看最终截图；进程/webContents 数量不作为验收指标
│ │ # 详见 PART11 §11.2-11.4 完整接口设计
│ │ src/LayoutCoordinator.js # ★新增: 协调 shell/panel/tab 三区域 setBounds 布局
│ │ preload/
│ │ shell-preload.js # ★新增: UI shell contextBridge (ProviderProxy)
│ │ panel-preload.js # ★新增: 面板 contextBridge (ProviderProxy, 权限可受限)
│ │ tab-preload.js # ★新增: 标签页 contextBridge (ProviderProxy + webview API)
│ │
│ ├─ infra-plugin/
│ │ src/IHiraModule.js # 统一模块接口 (所有域/UI模块必实现!)
│ │ /\* interface IHiraModule {
│ │ id: string 唯一id 例 domain-bookmark
│ │ version: string 语义化版本
│ │ dependencies: string\[] 依赖模块id 启动顺序拓扑排序
│ │ provides: Record\<string, any> 暴露给其他模块的API
│ │ install(ctx) => Promise 安装: 建表/迁移/注册IPC
│ │ start(ctx) => Promise 启动: 订阅事件/加载默认数据
│ │ stop(ctx) => Promise 停止: 取消订阅/断开连接/写盘
│ │ uninstall(ctx) => Promise 卸载: 删表/清理IPC/恢复默认
│ │ healthCheck() => { ok: bool, errors: string\[] }
│ │ } \*/
│ │ src/PluginRegistry.js # 核心: 按依赖拓扑排序 install/start 全模块
│ │ src/ModuleSandbox.js # 每个模块包一层 try/catch 边界
│ │ src/DependencyGraph.js # 循环依赖检测 启动前静态检查
│ │
│ ├─ infra-storage/
│ │ src/JsonStore.js # 单文件JSON存储抽象 (原jsonStore.js升级)
│ │ src/FileIO.js # fs Promise 原子写 跨平台路径
│ │ src/KeyValueStore.js # 通用键值存(用于缓存/临时数据 LRU TTL)
│ │ src/CrossWinSyncer.js # 多窗口广播同步(解决JsonStore多窗口不同步)
│ │
│ ├─ infra-logger/
│ │ src/Logger.js # debug/info/warn/error分级 滚动文件 控制台
│ │ src/CrashReporter.js # 模块崩溃自动上报 + 健康检查快照
│ │
│ ├─ infra-error/
│ │ src/ErrorBoundary.js # 模块级错误隔离
│ │ src/RecoveryStrategies.js # 降级策略:重试/重启模块/安全模式启动
│ │
│ ├─ infra-fs/
│ ├─ infra-platform/ # 封装 platformType 仅本层能读 process.platform
│ ├─ infra-theme/ # CSS 变量生成 深浅模式切换
│ └─ infra-l10n/ # 本地化字符串加载 替换 l() 全局函数

├─ packages/ (跨层共享 不属于任何层 不属于APPS)
│ ├─ shared-types/ # 纯类型 + Zod schema 定义 (main/preload/renderer共用)
│ │ bookmark.schema.js
│ │ history.schema.js
│ │ tabs.schema.js
│ │ settings.schema.js
│ │ download.schema.js
│ │ profile.schema.js
│ │ password.schema.js
│ │ permission.schema.js
│ │ extension.schema.js
│ │ ipc-contracts/ # IPC请求/响应类型 (main/renderer双方同时import)
│ │ ui-props/ # UI组件 props 类型
│ │ errors/ # 统一错误码 + 错误类层次
│ │ constants/ # DOM\_IDS 枚举 / IPC\_CHANNELS 枚举 / SETTINGS\_KEYS 枚举
│ │
│ ├─ shared-utils/ # 纯函数工具库 零副作用
│ │ urlParser.js (原 util/urlParser.js 无DOM依赖版)
│ │ relativeDate.js (格式化时间)
│ │ searchEngine.js (搜索引擎 URL 模板)
│ │ compareVersions.js
│ │ deepClone.js
│ │ throttle.js + debounce.js (不再挂 window!)
│ │ hosts.js / keyMap.js / proxy.js
│ │ tabTitle.js / autocomplete.js
│ │
│ └─ shared-ui-tokens/ # UI 设计令牌 保证外观像素一致
│ tokens-light.css (颜色/间距/字体/圆角 原设计值提取)
│ tokens-dark.css
│ components.css (list-item/modal等共用样式精确值)
│ README.md (严格像素对齐指南)

├─ migrations/ (独立于代码 版本化迁移工具)
│ └─ from-hira-v7.5.0/
│ index.js # 将 Hira v7.5.0 现有全部数据迁移到 NG SQLite
│ adapters/
│ dexie-places-adapter.js # 读旧 IndexedDB -> SQLite (主进程版Dexie)
│ settings-json-adapter.js # 读 settings.json -> 拆分到各表
│ profile-store-adapter.js # S3 嵌套大对象 -> profiles + tabs + settings
│ extension-list-adapter.js # S4 browserExtensions -> extensions表
│ download-history-adapter.js# S5 downloadHistory.json -> downloads表
│ json-store-adapters/\* # 其他JsonStore
│ test-datasets/
│ empty/ (空数据 全新安装)
│ small-2k-bookmarks/ (2000书签 200文件夹 中等数据)
│ heavy-100k-history/ (10万历史 压力测试)
│ regression-bugs/ (8个历史bug场景数据 验证迁移后无回归)

\=========================================
3.4 IHiraModule 统一模块接口 (核心 支持单模块拆装!)
====================================

所有功能模块必须 100% 严格实现以下接口 (PluginRegistry 检测不通过拒绝加载):

/\*\*

- 统一模块化接口 - 所有 domain/ui/infra(除了最底层infra-db等) 模块必须实现

- 安装顺序: 依赖图拓扑排序 -> 全部install -> 全部start

- 拆卸顺序: 反向 stop(module) -> uninstall(module)
  \*/
  interface IHiraModule {
  // --- 元数据 静态定义 ---
  readonly id: string // 唯一标识 例: "domain-bookmark" / "ui-tabbar"
  readonly version: string // 语义化版本 例: "1.0.0"
  readonly layer: "infra"|"domain"|"ui"|"app" // 分层校验用
  readonly dependencies: string\[] // 依赖的其他模块 id (本层或下层)
  readonly provides?: string\[] // 可选: 暴露的子 API 名 供其他模块调用
  readonly tags?: string\[] // "core"(不可卸载) / "optional"(可拆装) / "experimental"

// --- 生命周期 (顺序严格: install→start → 运行中 → stop→uninstall) ---
install(ctx: ModuleInstallContext): Promise<void>
// install 做: 建DB表/注册IPC契约/注册UI组件/加载静态资源
// install 不做: 读用户数据/写settings/发IPC消息/改动其他模块状态
// 失败: throw 表示安装失败 PluginRegistry 自动标记 fail
// ctx: { infra-db, infra-ipc, infra-plugin, logger, modulePath }

start(ctx: ModuleRuntimeContext): Promise<void>
// start 做: 订阅DB变更/加载用户数据/注册默认快捷键/IPC handler激活
// start 可调用其他模块 ctx.getModule(depId).provides.xxx()
// 失败: throw = 启动失败

stop(ctx: ModuleRuntimeContext): Promise<void>
// stop 做: 取消订阅/停止定时器/停止I/O/IPC handler取消激活
// 必须保证幂等: 多次调用不报错
// 关闭窗口 / 卸载模块 / 进入安全模式 都会被调用

uninstall(ctx: ModuleInstallContext): Promise<void>
// uninstall 做: (用户明确卸载模块时调用) DROP表/删除数据文件/清理IPC
// 普通关闭应用 不调用uninstall 只调用stop

// --- 健康检查 (连环BUG杀手锏: 自动检测模块异常) ---
healthCheck(): ModuleHealthReport
// 由监控器每30s调用 必须返回同步结果:
// { ok: bool, score: 0-100, errors: string\[], warnings: string\[], stats: {} }
// domain-bookmark例子: DB能连通吗? 索引存在吗? 最近10次操作错误数?

// --- 运行时API (被其他模块调用 可选) ---
provides?: Record\<string, Function>
// 例: domain-bookmark.provides = {
// getFolderTree: () => ...,
// createBookmark: (url,title,folderId) => ...,
// }
// 所有函数必须: 参数Zod校验 + 返回值Promise + 错误类型化
}

\=> 模块拆装 CLI/命令:
hira module list -> 全部模块 状态 OK/STOPPED/FAILED
hira module stop domain-bookmark -> 调用 stop() 书签功能暂时禁用
hira module start domain-bookmark -> 调用 start() 恢复 (热重启!)
hira module restart ui-tabbar -> 热重启标签栏 不用关整个浏览器
hira module health -> 全部模块健康报告 低分自动告警

\=========================================
3.5 依赖图规则 & 循环检测 (Linter强制)
===========================

规则 R1: 只能同层或下一层依赖
APPS -> UI ✅ UI -> DOMAIN ✅ DOMAIN -> INFRA ✅
APPS -> DOMAIN ✅ (允许直接编排)
APPS -> UI -> DOMAIN -> INFRA ✅ (完整链路)
❌ DOMAIN -> UI ❌ INFRA -> DOMAIN ❌ UI -> APPS
❌ 任何层 -> APPS (向上依赖一律禁止)

规则 R2: 同层模块之间可以依赖 但禁止循环 (A->B->A):
infra-plugin -> infra-ipc ✅ (infra-plugin 用 infra-ipc 注册模块通信)
infra-ipc -> infra-logger ✅ (ipc handler出错记日志)
infra-logger -> infra-ipc ❌ 循环!
\=> 启动时 infra-plugin 跑 Tarjan 算法检测 循环直接throw 不让启动

规则 R3: 全局黑名单 (import 直接失败)
禁止任何模块 import 'electron' 直接调用 ipcMain/ipcRenderer (只能走 infra-ipc)
禁止任何模块 直接 require('fs') 必须走 infra-fs
禁止任何模块 直接访问 process.platform 必须走 infra-platform
禁止任何模块 直接操作 window/document.getElementById 必须走 UI组件封装

\=========================================
3.6 包清单与依赖矩阵表 (完整 36个包)
=======================

| #                                                    | 包名                | 层     | 核心依赖                                 | 可卸载   | 核心接口                                                          |
| ---------------------------------------------------- | ------------------- | ------ | ---------------------------------------- | -------- | ----------------------------------------------------------------- |
| INFRA 层 (10个 全 core)                              | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| 1                                                    | infra-db            | infra  | 无 (最底层)                              | ❌核心   | drizzle, tx, backup                                               |
| 2                                                    | infra-ipc           | infra  | infra-logger, shared-types               | ❌核心   | TypedIpcMain/Renderer                                             |
| 3                                                    | infra-window        | infra  | infra-logger                             | ❌核心   | WindowFactory + WebContentsManager + LayoutCoordinator + Registry |
| 4                                                    | infra-plugin        | infra  | infra-logger, infra-ipc                  | ❌核心   | PluginRegistry                                                    |
| 5                                                    | infra-storage       | infra  | infra-fs, infra-logger                   | ❌核心   | JsonStore + KV + Syncer                                           |
| 6                                                    | infra-logger        | infra  | 无                                       | ❌核心   | Logger + CrashReporter                                            |
| 7                                                    | infra-error         | infra  | infra-logger                             | ❌核心   | ErrorBoundary + Recovery                                          |
| 8                                                    | infra-fs            | infra  | 无                                       | ❌核心   | FileIO Promise                                                    |
| 9                                                    | infra-platform      | infra  | 无                                       | ❌核心   | isWin/isMac/isLinux/PathSep                                       |
| 10                                                   | infra-theme         | infra  | shared-ui-tokens                         | ❌核心   | ThemeSystem tokens->CSS                                           |
| 11                                                   | infra-l10n          | infra  | infra-fs                                 | ❌核心   | l() 按需加载                                                      |
| <br />                                               | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| DOMAIN 层 (11个 bookmarks/history/download 可热插拔) | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| 12                                                   | domain-settings     | domain | infra-db, infra-storage                  | ❌核心   | ISettingsService                                                  |
| 13                                                   | domain-tabs         | domain | shared-types                             | ❌核心   | ITabList (替换 window\.tabs)                                      |
| 14                                                   | domain-profile      | domain | domain-settings, infra-db                | ❌核心   | IProfileService                                                   |
| 15                                                   | domain-bookmark     | domain | infra-db, domain-search(可选)            | ✅可拆   | IBookmarkService 11用例                                           |
| 16                                                   | domain-history      | domain | infra-db                                 | ✅可拆   | IHistoryService                                                   |
| 17                                                   | domain-download     | domain | infra-db, infra-storage, infra-fs        | ✅可拆   | IDownloadService                                                  |
| 18                                                   | domain-password     | domain | domain-profile, infra-storage            | ✅可拆   | IPasswordManagerFacade                                            |
| 19                                                   | domain-extension    | domain | domain-profile, infra-window             | ✅可拆   | IExtensionService                                                 |
| 20                                                   | domain-permission   | domain | domain-profile, domain-settings          | ✅可拆   | IPermissionService                                                |
| 21                                                   | domain-search       | domain | domain-history, domain-bookmark          | ✅可拆   | ISearchAggregator                                                 |
| 22                                                   | domain-session      | domain | domain-tabs, infra-storage               | ❌核心   | ISessionRestoreService                                            |
| <br />                                               | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| UI 层 (10+ 个 大部分可热插拔)                        | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| 23                                                   | ui-common           | ui     | infra-theme, infra-l10n                  | ❌核心   | BaseComponent/Modal/ListItem                                      |
| 24                                                   | ui-tabbar           | ui     | ui-common, domain-tabs                   | ✅可拆   | TabBarElement                                                     |
| 25                                                   | ui-navbar           | ui     | ui-common, ui-searchbar, domain-bookmark | ✅       | NavbarElement                                                     |
| 26                                                   | ui-searchbar        | ui     | ui-common, domain-search                 | ✅可拆   | SearchBarElement + plugins                                        |
| 27                                                   | ui-webviews         | ui     | ui-common, infra-window, domain-tabs     | ✅       | WebviewContainer                                                  |
| 28                                                   | ui-taskoverlay      | ui     | ui-common + 8 panels                     | ✅可拆   | TaskOverlayElement                                                |
| 29                                                   | ui-panel-favorites  | ui     | ui-taskoverlay, domain-bookmark          | ✅可拆   | FavoritesPanel                                                    |
| 30                                                   | ui-panel-history    | ui     | ui-taskoverlay, domain-history           | ✅可拆   | HistoryPanel                                                      |
| 31                                                   | ui-panel-downloads  | ui     | ui-taskoverlay, domain-download          | ✅可拆   | DownloadsPanel                                                    |
| 32                                                   | ui-panel-extensions | ui     | ui-taskoverlay, domain-extension         | ✅可拆   | ExtensionsPanel                                                   |
| 33                                                   | ui-panel-profiles   | ui     | ui-taskoverlay, domain-profile           | ✅可拆   | ProfilesPanel                                                     |
| 34                                                   | ui-panel-\*         | ui     | (notes/pinned/openTabs/preview)          | ✅可拆   | 每个可独立卸载                                                    |
| 35                                                   | ui-findinpage       | ui     | ui-common                                | ✅可拆   | FindBarElement                                                    |
| 36                                                   | ui-password-manager | ui     | ui-common, domain-password               | ✅可拆   | PasswordCapture + Viewer                                          |
| <br />                                               | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| APPS 层 (4个入口)                                    | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| 37                                                   | app-main            | apps   | 全部 UI + 全部 Domain + PluginReg        | ❌核心   | MainWindow Entry                                                  |
| 38                                                   | app-subwindows      | apps   | ui-\* + domain-\*                        | ✅部分   | 28子窗口 entry集合                                                |
| 39                                                   | app-settings        | apps   | ui-common, domain-settings               | ✅可拆   | Settings Window                                                   |
| 40                                                   | app-manager         | apps   | ui-common, bkmk/hist/dl                  | ✅可拆   | BkmkManager/HistManager/DlManager                                 |
| <br />                                               | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| PACKAGES 共享层 (3个 全引用)                         | <br />              | <br /> | <br />                                   | <br />   | <br />                                                            |
| 41                                                   | shared-types        | pkg    | 无                                       | 全部依赖 | Zod schemas + constants                                           |
| 42                                                   | shared-utils        | pkg    | 无                                       | 按需     | 纯函数工具库                                                      |
| 43                                                   | shared-ui-tokens    | pkg    | 无                                       | 全部UI   | CSS tokens 像素规范                                               |
