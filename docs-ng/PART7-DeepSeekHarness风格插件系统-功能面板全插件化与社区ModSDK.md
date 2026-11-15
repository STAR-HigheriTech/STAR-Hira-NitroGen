# STAR Hira NG 大换血重写规划 PART 7

## DeepSeekHarness 风格插件系统：功能/面板 全插件化 + 前置依赖 + 社区 Mod SDK

生成时间：2026-01-04
继承：PART3 §3.4 IHiraModule 统一接口 升级为 v2.0 (Harness Plugin v2)

> 核心思想：浏览器 = 最小可运行 Harness Core + 一组可插拔插件
> 「标签栏是插件、书签是插件、面板是插件、皮肤是插件、快捷键方案是插件」
> 「社区可以写 Mod，挂到官方 Extension Point（插槽）里运行，不需要改核心代码」

=========================================
7.1 设计理念：Harness ≠ Framework
=========================================

Framework（框架）思路：核心代码写死所有功能，UI组件调用函数 → 不满足就改源码
→ 问题：要加一个新面板？改 taskOverlay 三个文件；改标签栏样式？改 ui-tabbar 源码

Harness（承载体）思路（DeepSeekHarness 风格）：

1.  Core 只做 3 件事：
    - 插件生命周期管理（安装/启用/禁用/卸载/热重载）
    - Extension Point（插槽）注册与分发
    - 跨插件 API 调用 + 权限沙箱
2.  浏览器所有功能 = 插件集合：
    tabbar-management（标签栏）/ bookmark-core（书签核心）/
    favorites-panel（收藏面板）/ dark-mode-theme（暗色主题）/
    vim-keybindings（Vim 快捷键）
3.  插件之间 不直接 import 对方代码 → 只通过「Extension Point 插槽」+「Provided API 接口」通信
4.  社区 Mod = 三级权限插件，官方提供 SDK + 脚手架，编译后放到 plugins/ 目录即装即用

→ 结果：
✓ 想要极简浏览器？禁用 15 个插件只留 core+webview+tabbar，冷启动 <1s
✓ 想要侧边栏？装 side-panel-skeleton 前置插件 + 装 8 个面板插件（可只装 1 个）
✓ 想改标签栏外观？写社区 Mod rainbow-tab-colors，依赖 tabbar-management 的 tab-item-renderer 插槽，不用改一行核心
✓ 想做 AI 侧边栏？写社区 Mod ai-panel，依赖 side-panel-skeleton 的 panel-slot 即可

=========================================
7.2 四级插件类型系统（每种装/卸/开/关 完全独立）
=========================================

按 Trust 信任等级 + 功能职责，分 4 类：
（权限由 PluginRegistry 强制执行，社区 Mod 无法越级）

--- TYPE C: CORE PLUGINS (核心承载体) ---
信任级: CORE (用户不可卸载，只能开关=false)
数量: <10 个
特征: 提供底层 Extension Point 插槽 + 最基础 Provided API
清单（9个 = 浏览器能显示一个空白窗口的最小集合 = Harness Core Minimal Set）：
C1 infra-plugin 插件注册中心本身（自举）
C2 infra-window BrowserWindow + WebContentsManager 三类 webContents 管理 + window-factory EP + webcontents-lifecycle EP
★ PART11 RT 架构增强: install() 创建 WebContentsManager 实例 → 管理 UI Shell / Panel / Tab 三类独立 webContents
暴露 EP: webcontents.panel-created / panel-destroyed / tab-created / tab-destroyed
C3 infra-ipc TypedIpc* + 进程间通信 EP
C4 infra-db SQLite + Drizzle + db-schema-migration EP
C5 infra-theme CSS 变量系统 + theme-token-provider EP
C6 infra-l10n 本地化字符串加载 + l10n-bundle EP
C7 harness-ui-core UI Shell webContents 加载 + web-component 注册中心 + shell-layout EP
★ PART11 RT 架构增强: install() 调 C2 的 WebContentsManager.createUiShell()
创建 UI shell webContents → 加载 app-shell/index.html (标签栏/导航栏/搜索栏/rail 容器)
暴露 EP: shell.layout-slot / shell.component-mount-slot
C8 harness-webview-core Tab webContents 容器 + webcontents-lifecycle EP
★ PART11 RT 架构增强: 不再用 <webview> 标签 → 改用 WebContentsView 主进程管理
和 C2 的 WebContentsManager.createTab() 协作 → 每个 tab = 独立 webContents 进程
C9 harness-layout-root 主窗口布局骨架 layout-slot EP（最顶部插槽）
→ 这 9 个 = 空壳浏览器。用户看到什么功能，全部由下面三级插件提供！

--- TYPE F: FEATURE PLUGINS (功能插件) ---
信任级: INTERNAL (官方功能，默认预装，用户可开关)
特征: 提供「业务能力」，不含/或含少量 UI；对外暴露 Extension Point 让别人扩展自己
举例 = 你的要求：
F01 tabbar-management 标签栏管理功能插件 - 提供: tab-list-store / tab-CRUD / 拖拽排序 逻辑 - 暴露 Extension Points:
tabbar.item-renderer / tabbar.context-menu-item
tabbar.drop-target / tabbar.tab-stack-renderer - 暴露 Provided API:
tabs.create / tabs.move / tabs.group / tabs.closeById - ❌ 不自己渲染 UI (UI 留给 TYPE P 插件 tabbar-ui-default)
F02 bookmark-core 书签业务功能插件 - 提供: 书签CRUD/文件夹/导入导出/全文搜索 (domain-bookmark 逻辑封装) - 暴露 EPs: bookmark.tree-renderer-item / bookmark.context-menu - 暴露 API: bookmarks.* (11 usecases) - ❌ 不包含 UI
F03 history-core 历史业务插件 (API + history.* EPs)
F04 download-core 下载业务插件 (状态机 + P6扫描)
F05 profile-core 空间管理插件
F06 password-core-facade 密码4后端统一
F07 permission-engine 权限策略引擎
F08 extension-store Chrome扩展管理
F09 search-aggregator 搜索建议聚合 (12个子provider插槽可插)
F10 session-restore-engine 会话崩溃恢复
F11 shortcut-engine 快捷键引擎 + shortcut-binding EP
F12 omnibar-logic 地址栏逻辑 (不含输入框UI)
→ 特点: 可全部关闭！关闭 tabbar-management = 没有标签栏功能（极端极简模式）

--- TYPE P: UI PANEL / VIEW PLUGINS (面板视图插件) ---
信任级: INTERNAL / COMMUNITY 都可做
特征: 纯 UI 渲染组件，不直接写 DB；通过 Feature Plugin 的 Provided API 获取数据
★ 你的要求核心：「每个面板可拆装，有前置依赖」
前置依赖关系示例:
P01 side-panel-skeleton (侧栏骨架面板插件) - dependsOn: [C7 harness-ui-core, C5 infra-theme, C2 infra-window] - ★ PART11 RT 架构增强: install() 从 infra-window 获取 WebContentsManager 实例 - install() 为 8 个面板创建各自独立 Panel webContents（可单独 reload 热重启）- skeleton 把“面板ID -> webContents”映射作为自身 provides/EP 上下文暴露，面板插件挂载到 skeleton 分配的 webContents 上 - 做什么: 创建面板 webContents 池 + 管理 panel layout + UI shell 内 rail 容器渲染 - 规则: 面板插件自身不创建/不持有 BrowserWindow/webContents，只能通过 skeleton 分配的 panel webContents 渲染 - 暴露 Extension Points (插槽):
EP1: side-panel.rail-icon-slot
（注册一个 rail 列图标）
EP2: side-panel.panel-render-slot
（注册一个面板视图，挂到展开区域）
EP3: side-panel.toolbar-action-slot
（面板顶部工具栏加按钮）- 这就是你说的「侧边栏面板是一些面板界面插件的前置插件」！
→ 不装 side-panel-skeleton，下面 P02~P09 全部都装不上（依赖不满足，PluginRegistry 自动阻止安装提示）
P02 favorites-panel (收藏面板 插件) - dependsOn: [P01 side-panel-skeleton, F02 bookmark-core] - 注册到 EP side-panel.panel-render-slot - 提供 rail 图标 "★收藏" + 面板 UI
P03 history-panel - dependsOn: [P01 side-panel-skeleton, F03 history-core]
P04 downloads-panel - dependsOn: [P01 side-panel-skeleton, F04 download-core]
P05 extensions-panel - dependsOn: [P01 side-panel-skeleton, F08 extension-store]
P06 notes-panel - dependsOn: [P01 side-panel-skeleton]
P07 pinned-panel - dependsOn: [P01 side-panel-skeleton, F01 tabbar-management]
P08 profiles-panel - dependsOn: [P01 side-panel-skeleton, F05 profile-core]
P09 open-tabs-panel - dependsOn: [P01 side-panel-skeleton, F01 tabbar-management]
→ 8 个面板 = 8 个独立插件，前置都依赖 side-panel-skeleton
→ 用户偏好极简？只装 P02 favorites 不装其他 7 个 = 侧栏只有一个收藏面板

更多 UI 插件:
P10 tabbar-ui-default 默认标签栏 UI 渲染器
dependsOn: [F01 tabbar-management, C7, C8]
registers: tabbar.item-renderer (用官方 EP, 社区 Mod 可替换!)
P11 navbar-ui-default 导航栏默认
dependsOn: [P10, F12 omnibar-logic, F02 bookmark-core]
P12 searchbar-ui-classic 搜索框经典外观
dependsOn: [F12 omnibar-logic, F09 search-aggregator]
P13 webview-ui-default 默认 webview 容器
P14 find-bar-default 查找栏
dependsOn: [C8, C7]
P15 settings-ui-default 设置窗口
P16 bookmark-manager-view 书签管理器独立窗口
P17 password-capture-bar-ui 密码捕获条

--- TYPE M: COMMUNITY MODS (社区 Mod，三级权限) ---
信任级: RESTRICTED (沙箱运行，权限申请制)
来源: 第三方开发者 / 社区 / 用户自己写
加载: 放 plugins/ 目录 / 拖 zip 包 / Hira Mod Store 市场一键安装
权限: 只能通过 SDK 暴露的 API 做事；fs/db/IPC 默认禁止；需要的话申请 permission 清单弹窗用户确认
SDK: @hira/mod-sdk (npm包，TypeScript/JSDoc类型)
示例 (你的可学习案例 3):
M01 rainbow-tab-colors (社区 Mod)
dependsOn: [F01 tabbar-management, P10 tabbar-ui-default]
extendsEP: tabbar.item-renderer (给官方默认渲染器加一个 CSS class hook)
效果: 根据域名自动给标签染色，不需要改 ui-tabbar 源码
M02 ai-side-panel (社区 Mod)
dependsOn: [P01 side-panel-skeleton]
registers: side-panel.panel-render-slot (新增 AI 面板)
effect: 增加一个侧边栏 AI 对话面板，用 LLM API 总结页面
M03 vim-keybindings-mod (社区 Mod)
dependsOn: [F11 shortcut-engine]
registers: shortcut-binding EP (注册 hjkl 等 Vim 键)
M04 custom-bookmark-tree-mod
dependsOn: [F02 bookmark-core, P02 favorites-panel]
extendsEP: bookmark.tree-renderer-item (自定义树节点)

=========================================
7.3 Extension Point（扩展点 = 插槽）系统
=========================================

这是 Harness 架构的灵魂！ = 官方提前定义好的「可挂载位置契约」。
没有 EP，插件无法影响核心；EP 定义越多，社区可玩度越高。
每个 EP 必须有: 唯一id / 参数契约(Zod) / 返回契约 / 执行模式(sync/async/reduce)

--- EP 执行模式 ---
MODE=SINGLE: 只能注册一个实现，后注册的替换先注册的 (Override风格)
例: tabbar.item-renderer / theme.token-provider
MODE=MULTI: 可注册 N 个实现，按顺序全部执行 (Chain风格)
例: bookmark.context-menu-item (每个插件加一个菜单项，全部显示)
MODE=REDUCE: N 个实现，前一个返回值传给下一个 (Pipe风格)
例: search.suggestion-provider (所有提供器结果合并排序)
MODE=EVENT: N 个实现，事件广播，返回值忽略 (Observer风格)
例: webview.lifecycle.did-navigate / download.completed

--- 官方第一层 Extension Points 注册表（>=25 个，覆盖全部可扩展面）---
EP-ID MODE 说明 所属插件
------------------------------------------------------------------------------------------------

tabbar.item-renderer SINGLE 单个标签DOM渲染器 tabbar-management F01
tabbar.context-menu-item MULTI 标签右键菜单添加项 F01
tabbar.drop-target MULTI 标签拖放目标处理器 F01
tabbar.tab-stack-renderer SINGLE 标签栈 glance 渲染器 F01

bookmark.tree-renderer-item REDUCE 书签树节点渲染 bookmark-core F02
bookmark.context-menu MULTI 书签右键菜单项 F02
bookmark.import-format MULTI 自定义导入格式解析器 F02

history.search-filter REDUCE 历史搜索过滤器 history-core F03
download.state-badge-renderer SINGLE 下载列表状态角标渲染器 download-core F04

side-panel.rail-icon-slot MULTI 侧栏 rail 注册图标 side-panel-skeleton P01
side-panel.panel-render-slot MULTI 侧栏展开区注册面板 P01 ★
side-panel.toolbar-action-slot MULTI 面板顶部工具栏加按钮 P01
side-panel.panel-header-renderer REDUCE 面板头部自定义渲染 P01

shortcut.binding MULTI 快捷键注册 shortcut-engine F11
theme.token-provider REDUCE 主题CSS变量提供者 infra-theme C5
l10n.bundle-provider MULTI 语言包提供者 infra-l10n C6

webview.lifecycle.will-navigate REDUCE 页面跳转前钩子 (可cancel) webview-core C8
webview.lifecycle.did-navigate EVENT 跳转后钩子 C8
webview.lifecycle.did-finish-load EVENT 加载完成钩子 C8
webview.context-menu.item MULTI 页面右键菜单项 C8

search.suggestion-provider REDUCE 搜索建议提供者 search-aggregator F09
omnibar.input-transformer REDUCE 地址栏输入文字转换器 omnibar-logic F12
omnibar.result-item-renderer SINGLE 地址栏结果项渲染器 F12

db.schema.migration MULTI 自定义表迁移 infra-db C4
layout.root-slot MULTI 主窗口布局根插槽 layout-core C9

profile.on-before-switch REDUCE 空间切换前 (可拦截) profile-core F05
profile.on-after-switch EVENT 空间切换后钩子 F05

settings.section-renderer MULTI 设置窗口 section 注册 settings-ui P15
settings.custom-widget MULTI 设置自定义控件 P15

社区能做什么？只要注册到上面的任何一个 EP 就能影响浏览器！
比如 注册 webview.context-menu.item = 右键加一个"翻译此页"菜单项！

=========================================
7.4 插件前置依赖契约 v2.0
=========================================

原 PART3 dependencies:string[] 升级成 5 类关系 (IHiraModule v2 manifest字段)

字段:
dependsOn: 硬依赖，必须存在且启用，否则本插件无法启动 (装不上，报错列出缺少的)
optionalDependsOn: 软依赖，存在就用它提供的 EP / API，不存在也照样装 (降级运行)
provides: 我提供的 API 名 (PluginRegistry 据此校验依赖可达)
extends: 我扩展了哪个插件的哪个 EP → 列出来，方便排错
conflictsWith: 与谁冲突 → 两个不能同时启用 (比如两个不同 tabbar 渲染器)
requiredPluginVersion: 对硬依赖的最低版本要求 (semver)
optionalPluginVersion: 对软依赖的最低版本

示例依赖关系图 (对应你要求的面板前置):
side-panel-skeleton@1.0
provides: [side-panel-skeleton-v1]
extends: [layout.root-slot(来自 C9 layout-core)]

bookmark-core@1.0
provides: [bookmark-api-v1]

favorites-panel@1.0 (收藏面板)
dependsOn: [ side-panel-skeleton>=1.0, bookmark-core>=1.0 ]
↑ 这两个缺一个，用户装 favorites-panel 时提示:
"缺少前置: side-panel-skeleton (侧栏骨架) 和 bookmark-core (书签核心)，是否一并安装？"
extends: [ side-panel.panel-render-slot, side-panel.rail-icon-slot ]
optionalDependsOn: [ notes-panel, tab-preview-panel ]
conflictsWith: [ legacy-favorites-panel-v0 ]

rainbow-tab-colors@0.3.0 (社区 Mod)
dependsOn: [ tabbar-management>=1.2, tabbar-ui-default>=1.0 ]
extends: [ tabbar.item-renderer ]
requiredPermissions: [ "webview:read:title", "tab:read:all" ]

→ 依赖安装器: 用户点安装 favorites-panel，PluginResolver 自动:

1.  查 dependsOn 缺什么？缺 side-panel-skeleton + bookmark-core
2.  到官方仓库拉匹配版本
3.  拓扑排序 安装顺序: bookmark-core → side-panel-skeleton → favorites-panel
4.  依次 install → enable → 全部成功才告知完成
5.  任一失败，整体回滚，已安装的两个绝不残留

=========================================
7.5 hira-plugin.json 插件清单标准 v2.0
=========================================

所有插件 不管哪一级 根目录必须有一个 hira-plugin.json
这个文件 = 契约！PluginRegistry 只看这个文件决定怎么加载。

--- 示例 1: tabbar-management 官方功能插件 (TYPE F INTERNAL) ---
{
"$schema": "https://schema.hira.app/hira-plugin-v2.schema.json",
"manifestVersion": 2,

"id": "com.hira.official.tabbar-management",
"name": "标签栏管理引擎",
"version": "1.4.2",
"type": "feature-plugin",
"trustLevel": "internal",
"author": { "name": "STAR HigheriTech", "url": "https://higheri.tech" },
"license": "MIT",

"description": {
"zh-CN": "提供标签/标签组/标签栈 数据与业务逻辑。不包含 UI。是所有标签类面板和 Mod 的前置依赖。",
"en-US": "Tab data & business logic engine (no UI). Required by tab UI and tab-related mods."
},

"tags": ["core-feature", "tabs", "pre-dependency"],

// ---- 依赖契约 ----
"dependencies": {
"com.hira.core.harness-ui-core": ">=1.0.0",
"com.hira.core.infra-db": ">=1.0.0"
},
"optionalDependencies": {
"com.hira.official.session-restore-engine": "^1.2.0"
},
"conflictsWith": [
"org.community.legacy.tab-manager-v0"
],

// ---- 我提供 ----
"provides": {
"apis": ["hira.tabbar.v1"],
"extensionPoints": [
{ "id": "tabbar.item-renderer", "mode": "SINGLE", "contract": "./contracts/tabbar-item-renderer.zod.json" },
{ "id": "tabbar.context-menu-item", "mode": "MULTI", "contract": "./contracts/context-menu-item.zod.json" },
{ "id": "tabbar.drop-target", "mode": "MULTI", "contract": "./contracts/drop-target.zod.json" },
{ "id": "tabbar.tab-stack-renderer", "mode": "SINGLE", "contract": "./contracts/tab-stack-renderer.zod.json" }
]
},

// ---- 我扩展 (注册到别的插件提供的插槽) ----
"registers": [
{ "to": "db.schema.migration", "with": "./migrations/tables.js" }
],

// ---- 运行时入口 ----
"entry": {
"main": "./dist/main/index.js", // 主进程侧代码 (注册IPC/写DB)
"render": "./dist/render/index.js", // 渲染进程侧 (注册UI EP)
"preload":".dist/preload/index.js", // 可选: 需要注入 webview 的预加载脚本
"styles": ["./dist/styles/tabbar-logic.css"]
},

// ---- 权限 (INTERNAL=默认全部 社区Mod必须逐条申请) ----
"permissions": {
"level": "internal-full",
"scopes": ["db:write:tab-group", "ipc:send:tabbar.*"]
},

// ---- 生命周期钩子 ----
"lifecycle": {
"install": "./scripts/install.js", // 首次安装: 初始化默认表
"enable": "./scripts/enable.js", // 用户启用时
"disable": "./scripts/disable.js", // 用户禁用时
"uninstall":"./scripts/uninstall.js", // 彻底卸载时
"onCrash": "restart:3 then disable" // 连续崩溃3次→自动禁用，防止连环坏
}
}

--- 示例 2: favorites-panel 面板插件 (TYPE P INTERNAL，依赖 side-panel-skeleton) ---
{
"manifestVersion": 2,
"id": "com.hira.official.favorites-panel",
"name": "收藏面板",
"version": "1.0.5",
"type": "ui-panel-plugin",
"trustLevel": "internal",

"description": {
"zh-CN": "在侧栏显示收藏夹/书签树。需要先安装 侧栏骨架(前置依赖) 和 书签核心。"
},

// ★ 前置依赖：这是你要求的核心！
"dependencies": {
"com.hira.official.side-panel-skeleton": ">=1.3.0", // ← 侧栏骨架 (面板载体)
"com.hira.official.bookmark-core": ">=1.2.0" // ← 书签核心 (数据来源)
},
"optionalDependencies": {
"com.hira.official.notes-panel": ">=0.9.0"
},

// ★ 注册到哪里？前置插件的插槽
"registers": [
{
"to": "side-panel.rail-icon-slot",
"with": {
"panelId": "favorites",
"iconSvg": "./assets/icon-favorites.svg",
"labelI18n": "panels.favorites.railLabel",
"tooltip": { "zh-CN": "收藏夹 (Ctrl+Shift+B)" },
"orderWeight": 200
}
},
{
"to": "side-panel.panel-render-slot",
"with": {
"panelId": "favorites",
"elementTagName": "hira-panel-favorites", // Web Component 标签名
"defaultWidth": 320,
"minWidth": 240,
"maxWidth": 800,
"keybinding": "Ctrl+Shift+B",
"openInMainView": true
}
},
{
"to": "bookmark.context-menu",
"with": { "itemId": "openInFavoritesPanel", "order": 50, "label": "在收藏面板中显示", "action": "focusPanel" }
}
],

"entry": {
"render": "./dist/render/favorites-panel.element.js", // Web Component 定义
"styles": ["./dist/styles/favorites-panel.css"]
},

// UI 像素对齐验证文件 (启动时校验 不达标警告)
"uiSnapshots": {
"baseline": "./snapshots/light-panel.png",
"tolerancePercent": 5
}
}

--- 示例 3: 社区 Mod rainbow-tab-colors (TYPE M RESTRICTED) ---
{
"manifestVersion": 2,
"id": "com.github.yourname.rainbow-tab-colors",
"name": "彩虹标签栏",
"version": "0.3.2",
"type": "community-mod",
"trustLevel": "restricted",
"author": { "name": "Your Name", "url": "https://github.com/yourname/hira-rainbow-tabs" },
"homepage": "https://github.com/yourname/hira-rainbow-tabs",
"repository": "github:yourname/hira-rainbow-tabs",

"description": {
"zh-CN": "社区 Mod：根据标签网站域名自动给标签染色，支持 HSL 色调规则。"
},

"dependencies": {
"com.hira.official.tabbar-management": ">=1.2.0 <2.0.0",
"com.hira.official.tabbar-ui-default": ">=1.0.0"
},

"extendsViaExtensionPoint": [
{
"point": "tabbar.item-renderer",
"hook": "after", // after = 在官方渲染器之后 追加 CSS 类 (不替换)
"entry": "./dist/render/colorizer.js"
}
],

// ★ 社区 Mod 权限必须逐条声明，首次启用弹用户确认对话框
"requestedPermissions": [
{
"scope": "tab:read:all",
"reason": "读取所有标签的 URL，以按域名计算颜色。",
"risk": "low"
},
{
"scope": "tab:update:style",
"reason": "给标签 DOM 元素添加彩虹颜色的 CSS class。",
"risk": "low"
}
],

"entry": {
"render": "./dist/render/index.js",
"styles": ["./dist/styles/rainbow.css"]
},

// 沙箱级别: strict (默认社区 Mod 全部跑沙箱 不能直接 require fs/path/electron)
"sandbox": "strict"
}

=========================================
7.6 插件生命周期 v2.0 (14 步 支持 Enable/Disable 动态切换)
=========================================

旧 IHiraModule v1 只有 4 步 (install/start/stop/uninstall)
v2 升级到 14 步，每一步都可以有 hook：

[仓库下载/解压]
↓
P1 discover() 发现 hira-plugin.json → 校验 manifest
↓ 校验失败=拒绝载入/打标unsafe
P2 validateDeps() 依赖图构建 + Tarjan 环检测 + conflictsWith 检测
↓ 缺依赖=提示自动装 环=拒绝
P3 preInstall() 钩子: 备份当前状态 预留回滚点
P4 install() 跑 install 脚本 (建表/资源释放/注册 IPC schema)
↓ 失败=回滚 P3
P5 postInstall() 钩子: 刷新缓存
↓
[用户启用]
↓
P6 preEnable() 权限弹窗确认 (仅 Community Mod)
P7 registerExtensionPoints() 把本插件提供/注册的 EP 加入 Harness 注册表
P8 injectStyles() 注入 CSS (scoped 按插件前缀)
P9 enable() 跑 enable 脚本 → 正式可用
P10 postEnable() 钩子: 广播 system.plugin.enabled 事件
↓
[运行中 30s healthCheck 循环]
↓
[用户禁用]
↓
P11 preDisable() 事件广播
P12 disable() 跑 disable 脚本
P13 unregisterEPs() 从注册表移除 + 卸载样式 + 撤销所有 listener
↓ (可再次 Enable 从 P6 开始，不需要重装)
[用户彻底卸载]
↓
P14 uninstall() 跑 uninstall 脚本: 清理DB/删资源/移除本地缓存

关键新增：
✓ Enable/Disable 不删除数据，只是从运行时摘除 → 用户随时开关面板
✓ onCrash 策略: 连续崩溃 N 次 auto-disable，自动不连环带垮整体
✓ Hot-Reload: 开发模式下改插件代码 → 自动 P11→P6 循环，1s 刷新 (不用重启整个浏览器)

=========================================
7.7 社区 Mod SDK 规范 (@hira/mod-sdk)
=========================================

目标: 让社区开发者 5 分钟写出第一个 Mod

--- SDK 组成 ---

1. npm 包: @hira/mod-sdk
   - JSDoc + TypeScript 类型 (用户可用纯 JS 或 TS 开发)
   - createMod(manifest, { main, render }) 脚手架函数
   - 全部 Extension Point 的 Zod Contract 类型定义 (IDE 自动补全)
2. 脚手架命令:
   npm create @hira/mod@latest my-rainbow-tabs
   → 生成目录结构 my-rainbow-tabs/:
   hira-plugin.json
   src/render/index.js
   src/assets/icon.svg
   styles/rainbow.css
   package.json (scripts: dev build pack publish)
   README.md
3. Dev 命令:
   hira mod dev # 插件调试模式 → 自动热重载到开发版浏览器
   hira mod pack # 打包成 .hira-mod.zip (可直接拖进浏览器安装)
   hira mod publish # 发布到官方 Hira Mod Store (可选)
   hira mod doctor # 权限/兼容性/性能检查

--- 社区 Mod 沙箱 4 级权限边界 ---
Level 0 SANDBOX_STRICT (默认):
✅ 只能通过 SDK.Harness.* API 间接访问
✅ 只能读自己插件目录内的文件
❌ require() node 原生模块 (fs/path/child_process 全禁)
❌ 不能直接 DOM.innerHTML (必须用 SDK safeHtml)
❌ 不能 eval / new Function
Level 1 SANDBOX_LIMITED (申请 + 用户同意):
✅ 可访问 webview:read:title / tab:read / settings:read 只读域
Level 2 SANDBOX_ELEVATED (高风险操作，需额外审查):
✅ bookmark:write / download:start / extension:install
Level 3 FULL_ACCESS (官方内部 或 开源代码签名审查通过):
✅ 同 INTERNAL 权限 (社区极少能拿到)

--- SDK 常用 API 示例 (rainbow-tab-colors Mod 核心代码) ---
// 社区 Mod 入口文件 只需 15 行
import { createMod, Harness } from '@hira/mod-sdk'

createMod({
// 自动读取 hira-plugin.json 注入
async onEnable ({ registerExtPoint }) {
// 注册到 tabbar.item-renderer 插槽 (after 模式)
registerExtPoint('tabbar.item-renderer', 'after', async (ctx, tab) => {
const domain = await Harness.Tabs.readDomain(tab.id) // SDK API
const color = Harness.Utils.colorFromText(domain || tab.url)
// 返回的 CSS class 追加到 tab 元素
return { injectCss: { class: `rainbow hue-${color.hue}`, style: `--tab-hue:${color.hue}deg` } }
})
},

async onDisable ({ unregisterAll }) {
unregisterAll() // 一键清理本 Mod 所有注册 + 样式
}
})

=========================================
7.8 三个完整示例 (完全对应你的要求: 功能=插件/面板=插件/前置依赖/社区Mod)
=========================================

--- ★ 示例 1: tabbar-management 作为 Feature Plugin (TYPE F) ---
说明: 标签栏管理 = 独立功能插件，不是写死在核心！

- 提供 tab-list-store (tags CRUD / 分组 / 栈 / 拖拽排序)
- 不包含 UI (UI 留给另一个独立插件 tabbar-ui-default)
- 暴露 tabbar.* 系列 Extension Points
- 用户可以:
  → 禁用 tabbar-management 会怎样？→ 没标签功能，只能用键盘快捷键切 webview（极简模式）
  → 替换 tabbar-management 为社区自写的 vertical-tabbar-management？
  ↳ 完全可以！只要它提供相同 API: hira.tabbar.v1，其他所有依赖 tabbar-management 的面板插件不用改一行代码（面向接口编程！）
  关键文件结构:
  plugins/official.com.hira.official.tabbar-management@1.4.2/
  ├── hira-plugin.json (清单 7.5 示例 1)
  ├── contracts/ (Zod schema: tabbar EP 契约)
  ├── migrations/ (SQL: tabs/tab_groups 表建表)
  ├── dist/main/index.js (主进程侧: 写DB + IPC handler)
  └── dist/render/index.js (渲染侧: 注册 tabbar.* EPs + 暴露 hira.tabbar.v1)

--- ★ 示例 2: favorites-panel (收藏面板) 依赖 side-panel-skeleton + bookmark-core ---
说明: 每个面板都是独立 UI 插件，前置依赖 side-panel-skeleton (=侧栏骨架)
依赖图:
[C9 layout-core] (提供 layout.root-slot)
↓ provides
[P01 side-panel-skeleton (TYPE P)] (注册到 layout.root-slot)
↓ provides side-panel.panel-render-slot / rail-icon-slot
[F02 bookmark-core (TYPE F)] (提供书签 API)
↓ 两者都是硬依赖
[P02 favorites-panel (TYPE P)] (注册到 side-panel 两个插槽 + 调 bookmark API)
为什么这么好？
✓ 不想要侧栏？禁用 side-panel-skeleton → 8 面板 + rail 全部消失 (一键极简!)
✓ 只要收藏面板，不要历史/下载等 → 只装 P01 + F02 + P02 三个插件 其他 7 个面板都不装 (侧栏只有一个图标!)
✓ 社区想写 AI 面板？直接 dependsOn P01 side-panel-skeleton → register panel-render-slot → Done! (不用改核心)

--- ★ 示例 3: 社区 Mod rainbow-tab-colors (TYPE M) ---
说明: 社区开发者完全不用改浏览器源码，只依赖官方两个功能插件 + SDK 就能发布 Mod
依赖链:
[F01 tabbar-management (官方功能)] ← 提供 EP + API
[P10 tabbar-ui-default (官方默认UI)] ← 提供基础渲染器
↓ 两者都是社区 Mod 的 hard dependsOn
[M01 rainbow-tab-colors (社区 Mod)]
↓ extends tabbar.item-renderer (after hook, 不替换只加class)
效果:
用户从 Hira Mod Store 安装 → 弹权限确认 (读取标签域名 / 修改样式) → 启用 → 标签立刻变彩虹颜色
用户禁用 → CSS class 全部移除，标签恢复原样。不用重启浏览器，不影响其他任何功能。

=========================================
7.9 插件管理器 UI 设计 (侧栏内置 + 开发者模式)
=========================================

侧栏新增面板 PX plugins-panel (本身也是个插件! 依赖 side-panel-skeleton):
三个 Tab:
Tab1「已安装」: - 分组显示: CORE 核心 (灰色锁定 不可卸) / 官方功能 / 面板 / 社区 Mods - 每个插件卡片: 名称/版本/作者/启用开关/三点菜单(设置/重装/卸载/降级/查看依赖图) - 顶部搜索: 按 ID/标签/名称搜 - 依赖图查看按钮: 打开 force graph 显示当前插件 dependsOn 关系 (可视化帮助理解前置)
Tab2「市场」: - Hira Mod Store: 官方精选 + 社区上传 (带安全标签: 已签名/社区热门/新上架) - 分类: 面板 / 主题 / 快捷键 / 标签增强 / 隐私 / 自动化 / 开发者工具 - 点安装 → 自动解析前置依赖 → 一并安装 → 进度条 → 启用
Tab3「开发者」: - 加载未打包插件 (选本地目录) - 热重载开关 - Extension Points 注册表浏览器: 显示 25+ 官方 EP 每个注册了哪些插件 + 顺序 - Console: 实时查看插件日志/崩溃堆栈 - 导出当前插件组合: hira-profile.json (别人导入就能得到一模一样的浏览器配置) - 权限审计: 显示所有社区 Mod 申请的权限，可单独每项再开关

=========================================
7.10 插件权限模型 4 级 (防止恶意社区 Mod)
=========================================

信任级从低到高，每级能做的 API 明确区分:

Level 名称 能做的事 谁能发

---

L4 CORE 全部 INFRA 权限 (DB/IPC/FS/Window/Process) 内置9个
L3 INTERNAL-FULL 全部业务权限 (DB读写业务表/IPC业务/菜单) 官方插件
L2 RESTRICTED-EXT 需要的每个 scope 单独申请 + 用户弹窗确认 签名社区Mod
L1 SANDBOX-ONLY 只有 @hira/mod-sdk 暴露的安全 API 所有社区Mod(默认)

Scope 粒度示例 (社区Mod要在 requestedPermissions 逐条声明 reason):
tab:read:all
tab:update:style
tab:close (高风险! 关闭用户标签 必须弹风险说明)
bookmark:read
bookmark:write (中风险)
history:read (中风险 泄露浏览历史)
webview:read:title (低风险)
webview:inject:css (中风险 可能改页面 需说明用途)
download:start (高风险)
settings:write:* (高风险 可能改核心设置)
fs:read:pluginDir (只读本Mod目录 默认允许)
fs:read:userData (高风险 读整个 userData)

→ 用户第一次启用 Mod:
弹权限对话框:
┌─────────────────────────────────────────────────┐
│ 安装 彩虹标签栏 v0.3.2 │
│ 作者: YourName | ★ 已签名 | 风险: 低 │
│ │
│ 此 Mod 申请以下权限: │
│ ✅ 读取所有标签的 URL (计算颜色) │
│ ✅ 修改标签元素的 CSS class │
│ ⚠️ 不会: 读取浏览历史 / 关闭标签 / 下载文件 │
│ │
│ [取消] [启用并授予权限] │
└─────────────────────────────────────────────────┘

=========================================
7.11 与 PART3 IHiraModule v1 的对应关系 (升级兼容)
=========================================

- 原有 43 包 → 除了 9 个 core INFRA (TYPE C)，其余 34 个全部自动升级为 TYPE F / TYPE P 官方插件
- IHiraModule v1 字段: id/version/dependencies/install/start/stop/uninstall → 全部映射到 hira-plugin.json manifest + entry 入口
- 原有 PluginRegistry v1 → 升级 HarnessPluginManager v2:
  v1 功能 (拓扑/循环/沙箱) 全部保留
  v2 新增: ExtensionPointRegistry (插槽管理) + DependencyResolver (自动装依赖) + PermissionEnforcer (权限沙箱) + ModStoreClient (市场客户端)
- 所以: 完成 PART3 43 包之后 -> 给每包加一个 hira-plugin.json = 自动具备 v2 所有能力（不是重写，是增量加壳！）

=========================================
7.12 插件市场后端 (可选后续建设 不是 NG v1.0 阻塞项)
=========================================

- 插件元数据: JSON schema + semver
- 代码签名: 作者 ed25519 签名 → 浏览器校验，防止中间人篡改 Mod
- 自动安全扫描 CI: 每个上传的 Mod 自动跑权限分析 + 可疑 API 检测 → 打安全分
- 兼容矩阵: Mod 版本 vs Hira 版本 自动提示 "此 Mod 不兼容你的浏览器版本"

=========================================
7.13 验证标准 (本部分必须达成)
=========================================

执行完后 下面全部必须 ✅:
✅ 浏览器功能数 == 插件数 (除 9 个 CORE 之外没有其他"功能"是写死核心的)
✅ 侧边栏 8 个面板 = 8 个独立插件，dependsOn side-panel-skeleton → 不装骨架就装不上面板
✅ tabbar-management / bookmark-core / download-core / history-core = 4 个独立功能插件 可禁用可热重启
✅ 社区 Mod hello-world: 10 行 SDK 代码 + hira-plugin.json → 拖 zip 进浏览器能用 (5分钟 Demo)
✅ 插件管理器能可视化显示「favorites-panel 依赖 side-panel-skeleton + bookmark-core」完整依赖图
✅ 30+ 官方 Extension Point 全部有 Zod 契约 + IDE 自动补全
✅ 4 级权限 沙箱强制: 社区 Mod require('fs') 必须 throw (运行时集成测试)
✅ crash-inject: 故意让社区 Mod throw 100 次 → 核心 + 其他插件 = 完全不受影响 (只 Mod 被 disable)
✅ hira-plugin.json schema 校验: 缺少必填字段 / 依赖不存在 → 启动前就 fail-fast (明确提示哪里错)
