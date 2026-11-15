# STAR Hira NG 大换血重写规划 PART 1 - 全库耦合检测矩阵

生成时间：2026-01-03 | 扫描文件：400+ 源码文件

=========================================

1. 文件统计
   \=========================================
   | 层级 | 目录 | 文件数 |
   |--------------|-----------------------------|--------|
   | 主进程MAIN | main/ (25 ipc + 12 ext) | 72 JS |
   | 渲染进程 | js/ (navbar/taskOverlay/..) | 127 JS |
   | 构建脚本 | scripts/ | 15 JS |
   | 样式CSS | css/ | 31 CSS |
   | 页面窗口 | pages/ (22 parts+26窗口) | 130+ |
   | RT参考架构 | 1A-STAR_Hira_RT/src/ | 200+ TS|

========================================= 2. 全局变量污染 (P0致命x3)
=========================================

--- 2.1 渲染进程 window.xxx = 81处 / 35文件 ---
TOP 5 最危险(连环BUG根因):
#1 window.tabs - TabList单例 -> 60+模块直接依赖 完全不可拆装 P0
#2 window.ipc - ipcRenderer -> 37文件 259次调用 无类型无校验 P0
#3 window.settings - 单例 -> 42文件 231次listen 广播雪崩 P0
#4 window.platformType - 'mac'|'windows'|'linux' -> 12+模块裸if P1
#5 window.bookmarkRepository / bookmarkMetaByURL / bookmarkFoldersById
内存缓存+DB双写 3路径并行 P1
其他: window.electron/fs/EventEmitter/throttle/debounce/empty 工具裸挂,
window.isDarkMode, window.searchEngines, window.domLazy,
window.TaskOverlay, window.currentPasswordManager,
window.__ntpLastAiSidebarToggleAt, window.__taskOverlaySearchSyncInitialized

--- 2.2 主进程 global.xxx = 80处 / 28文件 ---
a) 函数型服务 42个: filterPopups, buildAppMenu, sidebarViewManager,
createPermissionDialog, runMemoryOptimizer, registryInstaller,
12个ghostery函数, 8个download函数
-> 靠 typeof global.xxx === 'function' 判存调用 顺序依赖TDZ P0
b) 状态单例 18个: extensionsSession, plugins, isFocusMode,
newtabURL, MenuItem, nativeTheme, isDebuggingEnabled, devForceQuit
c) 回调注入 20个: getWindowFromViewContents, getTabIDFromWebContents,
registerJsDialogViewListener, injectJsDialogOverride

========================================= 3. 存储系统 7+种 = 一致性地狱
=========================================

| #   | 名称                | 底层               | Profile隔离 | 事务   |
| --- | ------------------- | ------------------ | ----------- | ------ |
| S1  | 历史/书签/缩略图    | IndexedDB Dexie    | ❌ 全局     | ✅     |
| S2  | settings.json       | JSON原子写         | ❌ 全局     | ❌     |
| S3  | profileStore(嵌S2)  | S2.key 深拷贝对象  | ✅          | ❌     |
| S4  | 扩展列表(嵌S2)      | S2 2keys           | ✅          | ❌     |
| S5  | 下载/会话 JsonStore | 独立JSON+防抖写    | ❌          | ❌     |
| S6  | 扩展内部存储        | chrome.storage API | ✅partition | 各实现 |
| S7  | Cookie/缓存会话     | Session partition  | ✅partition | 内核   |
| S8  | 密码(4后端)         | 分散               | ⚠️部分      | 各后端 |

存储一致性缺陷 TOP3:
[P0] S2广播风暴: set大对象 -> IPC -> 231 listen全执行 -> UI抖动
[P0] 跨S1/S2无事务: 书签创建写2存储3位置 -> 中间crash产生孤儿数据
[P1] S1双写路径: places Dexie + bookmarkRepository + placesService内存Map
[P1] S3深拷贝性能: JSON.parse(JSON.stringify(500KB)) 阻塞主线程

========================================= 4. IPC通信审计 259次调用 4模式混用
=========================================

| 模式         | 问题                                  |
| ------------ | ------------------------------------- |
| ipc.send     | 单向无响应 回调地狱                   |
| ipc.sendSync | UI阻塞 Electron官方强烈反对           |
| ipc.invoke   | payload无结构校验                     |
| ipc.on       | 监听leak 窗口关闭不清 同一事件执行N次 |

[P0 致命] _invokeHandlers反向调用链 (main/ipc/bookmarkEditor.js:77)
bookmarkEditor直接读 Electron私有: ipcMain._invokeHandlers.get('manager-places-invoke')
-> 升级Electron = 整个链路静默失效

IPC通道清单(25文件 80+字符串无枚举):
appConfirm bookmarkEditor commandPalette dialogService findBar
httpAuth jsDialog linkHover menuButton misc notificationPermission
passwordFillMenu places popupPermission profileSwitcher railTabsHover
resizePreview searchbar sitePermission system tabPreview tabStateSync
webstore zoomBar extensions-ipc identity-ipc
-> 拼错=静默失效 无法静态查找所有引用位置

========================================= 5. 构建系统 6套自定义拼接 = TDZ炸弹
=========================================

buildMain.js: 67文件硬编码顺序 fs.readFileSync字符串拼接 -> main.build.js
顺序见 scripts/buildMain.js:6-73 (67项!!)
[P0致命] main.js是第15位 调用后面第50+位定义的const -> TDZ ReferenceError
现有补丁: setImmediate(migrateProfileStore) 绕开 非根本修复
buildBrowser.js: localization + default.js 拼接 -> Browserify + renderify
-> EOL技术 无ESM无Tree-shaking无HMR
buildPreload.js: browserify -> preload.js
buildBrowserStyles.js: 31CSS直接拼接 -> bundle.css
[P1] 无命名空间 .tab-item/.panel-item跨文件覆盖
buildLocalization.js: 合并languages/*.json
buildIndexHtml.js: 22个.part文件装配 index.html

========================================= 6. DOM耦合 187次getElementById x 裸字符串
=========================================

TOP10 高频ID 引用文件数:
#tabs(14) #webviews(12) #navbar(10) #sidebar(10) #task-overlay(8)
#searchbar(6) #webview-placeholder(6) #workspace-switcher(5)
#pinned-bookmarks-bar(4) #8个面板ID(各2-3文件)
-> 与pages/app/parts/*.part一一对应 无编译期校验

========================================= 7. BrowserWindow 28种 = 8种创建模式
=========================================

主窗口/书签编辑器/findBar/zoomBar/搜索栏/命令面板/Tab预览/Rail浮层
LinkHover/菜单按钮/6种权限对话框/JS对话框/AppConfirm/密码填充
HTTP认证/通知权限/弹窗权限/站点权限/Profile切换/Prompt/扩展Popup
RemoteMenu/ResizePreview

[P0致命] webPreferences在8处重复写 -> 安全升级漏改=漏洞
[P0致命] 无统一窗口工厂 hide vs destroy不统一 -> 内存泄漏

========================================= 8. settings键名 (200+扁平key 无namespace无schema)
=========================================

| Key                      | 调用数 | 问题                      |
| ------------------------ | ------ | ------------------------- |
| profileStore             | 63+    | 每次set序列化500KB大对象  |
| darkMode                 | 11     | 与window.isDarkMode双源   |
| customUserAgent          | 10+    | 全局+profile双优先级      |
| filtering.blockingLevel  | 10     | 带点key与对象方式并存     |
| browserExtensions        | 9+     | 与profileExtensionMap双写 |
| useSeparateTitlebar      | 8      | 5个UI模块各get无抽象      |
| sidebarFavoritesOrder    | 7+     | 多窗口顺序不一致          |
| popup/notifPermissions.* | 10+    | 与filtering全局函数双源   |

========================================= 9. 耦合热力图 (P0致命x11 必须根除)
=========================================

P0 致命(必须全部根除): 01. window.tabs 全局单例 60+ 模块硬依赖 -> 不可拆装 02. buildMain.js 67 文件硬编码顺序拼接 -> TDZ 炸弹 03. global.xxx 80函数 + typeof 判存调用 -> 顺序依赖静默失效 04. BrowserWindow 28种 8种创建模式 -> 安全漏洞+内存泄漏 05. settings.json 广播雪崩: 231 listen 无差别回调 UI全抖动 06. ipcMain._invokeHandlers Electron私有API反向耦合 -> 升级即死 07. 跨S1/S2存储无事务 + places三路径双写 -> 数据孤儿不一致 08. IPC 4模式混用无契约 80+通道裸字符串 -> 通信无可靠性 09. 7+种存储系统无统一抽象 无中心化接口 -> 数据各写各的 10. window.ipc 裸暴露 无类型无权限无校验 -> 渲染任意调用主进程 11. settings 200+扁平key 无schema无version无migration -> 脏键坟场

P1 严重(必须修复):

- window.platformType 12+模块 if裸判断 无PlatformService抽象
- Dexie places渲染进程 崩溃恢复难 主进程需数据需IPC绕
- 187 getElementById字符串耦合 DOM改动=187处需同步改
- CSS 31文件无命名空间 类名跨模块覆盖
- Browserify paths非标准别名 编辑器全红线 无循环依赖检测
- 密码4后端无统一PasswordService UI层20+处按名称分派
- JsonStore无跨窗口同步 多窗口下载列表显示不一致
- module.exports 单例模式与window.xxx全局 模块实例化双路径
