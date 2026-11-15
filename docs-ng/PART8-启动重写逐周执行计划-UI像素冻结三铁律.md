# STAR Hira NG · PART 8 - 启动重写的逐周执行计划（21周/5个月）

## 特别约束：UI 不做大改 = UI 像素冻结策略（本文件最优先级）

生成时间: 2026-01-04
前置文档: PART1~PART7 / Addendum

> 核心指令重申：**UI 不作大改动，像素对齐原外观**。
> 功能/架构/存储/插件系统可以完全重写，但是用户一打开 NG 版浏览器，视觉上必须"感觉还是那个 Hira"。
> 本文件把"怎么保证 UI 不大改"写成强制执行的三条铁律 + 每周自动化像素检查闸。

=========================================
8.0 启动重写的第一步：第一周 Day1~Day5 具体做事清单
=========================================

（不是计划了，直接照着做就能启动）

Day 1 上午（环境 & 目录初始化）

1. 创建 NG 目录并列放置
   e:\Desktop\OTHER\1A-STAR_Hira_NG\
2. pnpm 初始化 monorepo
   pnpm init
   写 pnpm-workspace.yaml (packages: apps/* ui/* domain/* infra/*)
   安装核心依赖:
   pnpm add -Dw electron-vite vite @vitejs/plugin-react
   pnpm add -Dw better-sqlite3 drizzle-orm drizzle-kit zod vitest pixelmatch pngjs
   pnpm add -Dw eslint @electron-toolkit/eslint-config-ts
   pnpm add -w electron@castlabs (带 Widevine 对应版本!!! 不能下官方 electron)
3. 从 RT 项目 copy 关键配置骨架改:
   electron.vite.config.js (三段 main/preload/renderer 别名)
   drizzle.config.js (sqlite schema 路径)
   tsconfig.base.json (// @ts-check 启用 strict JSDoc)

Day 1 下午（UI 像素冻结第一条铁律：基线快照库建立）4. 启动现有 Hira v7.5.0，按 [UI-SNAPSHOT-100-MATRIX]（本文件附录 A）拍 100 个关键状态截图
→ 存到 docs-ng/ui-baseline/v7.5.0/state-001-light-tab-5tabs.png … state-100-dark-panel-favorites-open.png
→ 每个截图配一个 JSON：{ windowSize:{w,h}, profile:'default' , 描述, 操作序列 }
★ 这 100 张图 = 视觉"宪法"，之后所有 UI 组件每一个写完强制对比。

Day 2 （UI 像素冻结第二条铁律：CSS Tokens 提取）5. 打开现有系统 bundle.css，用自动化脚本提取 160+ 个设计令牌到 shared-ui-tokens：
颜色（Color Palette 56 个）:
--color-bg: #fafafa; --color-bg-dark: #1c1c1c;
--color-tab-bg: #ffffff; --color-tab-hover: rgba(0,0,0,0.04);
--color-panel-bg: #ffffff; --color-border: rgba(0,0,0,0.08);
--color-accent: #0a84ff; --color-danger: #ff3b30;
...
间距（Spacing 32 个）:
--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
--tab-padding-x: 12px; --tab-padding-y: 6px;
--panel-header-height: 40px;
--navbar-height: 40px; --tabbar-height: 38px; ...
字体/字号（Typography 18 个）:
--font-family: -apple-system, "Segoe UI", sans-serif;
--font-size-xs: 11px; --font-size-sm: 12px; --font-size-md: 13px; --font-size-lg: 14px;
--font-weight-normal: 400; --font-weight-medium: 500; --font-weight-semibold: 600;
圆角/阴影/边框（Shape 24 个）:
--radius-xs: 3px; --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-full: 9999px;
--border-width: 1px; --shadow-panel: 0 2px 8px rgba(0,0,0,0.08);
--tab-corner-radius: 6px 6px 0 0;
动画（Motion 12 个）:
--dur-fast: 80ms; --dur-normal: 150ms; --dur-slow: 250ms;
--ease-default: cubic-bezier(.2,.8,.2,1);
→ 存到 packages/shared-ui-tokens/tokens-light.css / tokens-dark.css / tokens-base.css
★ 之后所有 NG 的 UI 组件 CSS 只能 var(--xxx) 使用这些令牌，**严禁在组件 CSS 内写死任何颜色值/像素值**。
任何写死像素 → Linter 直接报错（eslint rule: no-hardcoded-color-or-spacing）。

Day 3 （最小 CORE 骨架 + ★ PART11 RT webContents 骨架）6. 实现 infra-plugin/src/PluginRegistry-minimal.js
能跑通：扫描 manifest → 拓扑排序 → install(3个mock插件) → start → healthCheck 7. 实现 infra-window/WindowFactory.js + WebContentsManager.js + LayoutCoordinator.js
★ PART11 RT 架构: 不再只做 createMainWindow → 还要做:
WindowFactory.createMainWindow():
① 创建 BrowserWindow（安全 webPreferences 模板）
② const wcm = new WebContentsManager(window, pluginRegistry)
③ wcm.createUiShell() → 创建 UI shell webContents → 加载 app-shell/index.html
④ LayoutCoordinator 初始布局: shell 全屏, panel/tab 区域 0x0
三个 preload 文件骨架 (空壳 contextBridge):
preload/shell-preload.js: window.hira = { provider: {}, on: {} }
preload/panel-preload.js: 同上（Week5 填充）
preload/tab-preload.js: 同上（Week4 填充）8. 跑起来: pnpm dev → BrowserWindow 内 UI shell webContents 显示 "Hira NG v0.0.1"
★ 验证: WebContentsView attach + setBounds 正常 → 不再是 renderer 直接渲染空白页

Day 4 （DRM & 打包验证闸 - 必须 Day4 过）9. Widevine DRM 验证：打开 Netflix / Spotify 公开测试页 → 能播放视频（必须通过！）
→ 不过：回到 Day1 第 3 步换 electron 版本，不进入下周 10. electron-builder 打 NSIS 安装包 → 安装到其他目录 → 安装版也能开空白窗口
→ 不过：回到 build 配置，不进入下周

Day 5 （UI 像素冻结第三条铁律：pixelmatch 自动化流水线）11. 搭 UI 快照对比 CI: - tests/ui/snapshot-runner.js (Playwright 打开窗口 → 按预设操作 → 截图 → 与 baseline 对比) - 命令: pnpm test:ui-snapshot --case=001
输出: 差异图差异像素数 / 匹配率 % - 验收标准: 匹配率 ≥ 95% 通过；90-95% 人工 review；<90% 直接打回改组件 12. 跑第 1 个空窗口快照: 空白主窗口 → 与原 Hira 刚开窗口的空白截图比对 → ≥95%（通过）
→ 不过：回到 tokens CSS 找边距/字体/颜色哪里不对

→ **以上 Day1-5 共 12 件事 全部通过才算「启动重写成功」，任何一件不过回到对应步骤解决，不进入 Week 2。**

=========================================
8.1 UI 像素冻结三条铁律（重写全程强制执行）
=========================================

铁律 1：基线快照法
100 个关键 UI 状态截图（附录 A 矩阵）= 宪法，任何改动必须 pixelmatch ≥95%。
触发时机: 任何 UI 组件 PR 提交前 / 每周五周报告 / 每个里程碑。
命令: pnpm test:ui-snapshot --all → 输出 100 项报告，<95% 项数>2 则本周不验收。

铁律 2：令牌禁止硬写法
UI 组件 CSS 不得出现硬编码颜色 (#1c1c1c / rgb(0,0,0) 全部禁止) / 硬编码间距 (8px / margin:12px 全部禁止)
只能用 var(--color-tab-bg) / var(--space-3) 等来自 shared-ui-tokens 的变量。
触发时机: ESLint pre-commit hook，任何硬编码直接无法 commit。
例外: 第三方扩展注入的 CSS 不在此限。

铁律 3：结构-样式分离法
DOM 结构可以完全重构（Web Components / Shadow DOM），但是计算样式 (getComputedStyle)
对每一个标准状态的关键元素（标签/按钮/面板头部/菜单项）必须和原系统一致（公差：
颜色 ΔE ≤ 3，间距 ≤ 2px，字号 ≤ 0.5px，line-height ≤ 1px）。
触发时机: 每个 UI 组件首次写完，跑 compute-style-diff 工具脚本，列出所有超限项逐一修。

→ 三铁律的权重：任何设计决策 / 架构优化 vs UI 像素一致性冲突时，**UI 像素一致性优先**（你明确要求的）。

=========================================
8.2 21 周逐周执行计划（周交付物 + 验收 + UI像素检查点）
=========================================

-------- 阶段 S0 基础设施脚手架 (Week 1~2 = Day1-Day10) --------
Week 1: 环境 + 基线
★ UI 检查点: 完成 Day5 100 基线截图 + tokens 提取 + 空窗口像素匹配 95%
交付:
W1-1 [目录] 1A-STAR_Hira_NG/ monorepo 43 包空目录结构 (package.json + index.js stub)
W1-2 [配置] electron.vite + drizzle + eslint(含禁止硬编码 rule) + tsconfig 全部生效
W1-3 [基线库] docs-ng/ui-baseline/v7.5.0/ 100 张截图 + JSON 元数据 (附录 A)
W1-4 [令牌库] packages/shared-ui-tokens/ tokens-light+dark+base 142 个 CSS 变量提取完成
W1-5 [可运行] pnpm dev 能出空白窗口 → Netflix DRM 视频能播放 → 安装包能安装
验收: 5 项交付全部 OK + 12 件 Day1-5 事全部完成

Week 2: INFRA 核心 (10包) 第一版
★ UI 检查点: infra-theme token → CSS var 渲染生成测试页面 颜色与原图对 ΔE≤3
交付:
W2-1 infra-logger: 分级日志 + 滚动文件 + 控制台
W2-2 infra-fs + infra-platform: Promise fs 封装 / isWin/isMac (window上跑对)
W2-3 infra-storage: JsonStore + FileIO atomic + CrossWinSyncer (100次读写测试全过)
W2-4 infra-error: ErrorBoundary + RecoveryStrategies (人为 throw 不连环)
W2-5 infra-db: better-sqlite3 + drizzle 打开/关闭/备份/完整性检查全跑通 + schema 空表 V1 (profiles/settings/tabs 三桩表建表成功)
W2-6 infra-ipc: TypedIpcMain + TypedIpcRenderer + Zod schema 强制 (3 mock handler 全过)
W2-7 infra-window: WindowFactory 2 模板 (main + dialog) + WindowRegistry (注册表查询正常)
W2-8 infra-theme: tokens → CSS var 生成器 + 浅深切换 (事件触发测试)
W2-9 infra-l10n: 4 语言包加载 + l() 函数 (不挂window)
W2-10 infra-plugin v2: PluginRegistry 完整 14 步生命周期 (见 PART7 §7.6) + Tarjan 环检测 + Kahn 拓扑 + ModuleSandbox
(人为 throw 43 个 mock 插件 = 核心挂进安全模式 非核心不影响)
验收: 10 包 单测 ≥ 90% 覆盖；崩溃注入 非 core 插件 throw → 其他正常

-------- 阶段 S1 DOMAIN 核心 (Week 3~6) --------
Week 3: domain-settings + 雪崩验证
★ UI 检查点: settings 变更仅触发 1-2 个组件重绘 (Chrome DevTools Paint 闪测)
交付:
W3-1 settings 表 schema (PART4 A3 + namespace 命名) + settings_versions
W3-2 SettingsService: 类型化读写 + Zod 校验 + 200 key schema 首批定义
W3-3 watch(pattern, cb) 实现 + **雪崩对比测试**:
模拟原系统: 改 'ui.darkMode' → 231 全部回调 NG 版
改同键 → cb 调用次数平均 ≤ 2 (原 1% 不到) ✅
W3-4 migration 框架: from v0 empty → v1 schema + SQL 迁移脚本
W3-5 ★ RT webContents: side-panel-skeleton install() 创建 Panel webContents 路径跑通（空白页可显示/可 reload/可销毁重建）
验收: 雪崩对比测试通过

Week 4: domain-tabs (替换 window.tabs 炸弹 P0)
★ UI 检查点: (无 UI，纯逻辑) 1000 Tab 增删移动性能基线 ≤ 5ms/操作
交付:
W4-1 Tab/TabList/TabGroup/Workspace 数据结构纯 JS 实现 (脱离 electron 可跑)
W4-2 100+ 单测 + 1000 Tab 压力测试 + 循环依赖检测
W4-3 schema B1~B4 tabs/tab_groups/window_states/workspaces drizzle 表跑通
W4-4 Provider-Service 模式应用: 28 个 Provider 注册 4 钩子 = 28×4=112 EP
W4-5 coverage: pnpm plugin:coverage → domain-tabs 28/28 = 100% ✓
W4-6 ★ RT webContents: WebContentsManager.createTab()/destroyTab() 骨架 + tabId 绑定（只做生命周期与布局 attach，不做网页加载逻辑）
验收: 100 单测全过 + 压力测试达标 + coverage 100%

Week 5: domain-profile + domain-session
★ UI 检查点: 切 profile 无 UI 抖动 (同雪崩测试方式)
交付:
W5-1 profiles/profile_isolation_items schema + CRUD
W5-2 profile.switch 事务: 切 partition + 写 settings + UI 事件
W5-3 session.snapshot.take/save → cold start 恢复 100 tabs <500ms
W5-4 Provider 注册: profile(11) + session(6) = 68 EP
W5-5 coverage 100%
验收: 切 profile 回调次数 ≤10 UI 组件

Week 6: domain-bookmark (核心业务 + 8 bug 防回归) 里程碑 M1
★ UI 检查点: M1 启动里程碑窗口像素: 空窗口 + 标签栏≥95%
交付:
W6-1 schema C3/C4 bookmarks/folders 表 + FTS5 虚拟表
W6-2 11 usecases 实现: createBookmark / createFolder / deleteFolderCascade ...
W6-3 8 bug 场景 8 个测试数据回归: (PART6 附录 B 8 bug)
B-001 folderId 不 NULL ✓ / B-002 级联删除 ✓ / B-003 环检测 ✓
B-004 重排性能 ✓ / B-005 多窗口一致 ✓ / B-006 无广播 ✓
B-007 扩展列表一致 ✓ / B-008 下载暂停状态机 ✓
W6-4 Provider 注册: bookmark(30) + FTS 钩子 = 120 EP
W6-5 coverage 30/30 = 100%
M1 里程碑验收:
✅ 能启动主窗口 → 空白标签页显示（外观像素≥95%）
✅ 新建标签/关闭标签 (5个Tab 增删改 全部正常)
✅ 创建书签 / 创建文件夹 / 删除文件夹级联 (8 个 BUG 场景全防)
✅ DRM 视频正常播放
✅ 改一个 setting key → 平均回调 < 2 次

-------- 阶段 S2 DOMAIN 扩展 (Week 7~9) --------
Week 7: domain-history + domain-download
★ UI 检查点: 下载面板列表 item 像素匹配 95% (组件搭桩)
交付: history(14) + download(22) Provider 注册 = 144 EP
download P6 危险检测扫描接入 + 状态机测试 (暂停/恢复/取消)
验收: 10w 条历史导入 < 30s / 10 并发下载性能达标

Week 8: domain-password (4 后端抽象) + domain-permission + domain-search
★ UI 检查点: 密码捕获条外观像素
交付: password(10) + permission(8) + search(9) Provider = 108 EP
IPasswordBackend 4 后端接口 + Builtin 后端跑通
search 9 provider 合并排序测试

Week 9: domain-extension + shortcut-engine/navigation-theme-engine
★ UI 检查点: (无 UI) 扩展安装卸载流程正常
交付: extension(11) + 引擎混合(19) Provider = 120 EP
electron-chrome-extensions 跑通 + 10 个常见扩展安装测试
chrome.storage.local 正常
验收: **全 11 Domain + 混合引擎 168 Provider 覆盖检查 = 168/168 100%**
(这是内部功能 Mod 化 100% 的里程碑)

-------- 阶段 S3 UI 核心层 (Week 10~13) 【UI 像素最关键的 4 周】 --------
Week 10: ui-common + ui-tabbar (标签栏 UI)
★ UI 检查点: 标签栏 20 状态 snapshot 全部 ≥ 95% （像素冻结 核心战斗周）
交付:
W10-1 ui-common: ListItem / Modal / WindowControls 3 基础组件
(3 组件 snapshot = 12 状态 全部 ≥ 95%)
W10-2 ui-tabbar TabBarElement Web Component
W10-3 Tab / TabStack / TabPreview / AddTabButton / TabEditor 5 子组件
W10-4 拖拽排序接入 @atlaskit/pragmatic-drag-and-drop
W10-5 EP: tabbar.item-renderer / context-menu-item 注册测试
验收: 标签栏 20 状态 snapshot 全部 95%
中键关闭 / 拖排序 / 新建 / 右键菜单 操作正常

Week 11: ui-navbar + ui-searchbar (导航栏 + 搜索框)
★ UI 检查点: 导航栏 15 状态 + 搜索框建议 5 状态 快照匹配
交付: NavbarElement + 6 子组件 (NavBtns / BookmarkStar / ProgressBar /
PermissionRequests / ContentBlockingToggle / MenuButton)
SearchBarElement + 12 个 searchbar 插件 (bangs/calc/history/…)

Week 12: ui-webviews + ui-password-manager (webview 容器 + 密码 UI)
★ UI 检查点: webview 圆角/内边距/边框 严格匹配
交付: WebviewContainer + GestureHandler + AudioManager
PasswordCaptureBar + PasswordViewer

Week 13: 剩余 UI 小组件 (findinpage / download-manager / modal-mode / new-tab-shell) 里程碑 M2
★ UI 检查点: M2 主窗口 50 状态 全部 ≥95% (一半快照通过了!)
交付: find-bar + download-manager-bar + Modals + custom-new-tab-shell
M2 里程碑验收:
✅ 主窗口 UI: 标签栏/导航栏/搜索框/webview/下载条 像素 50/50 全 ≥95%
✅ 书签/历史/下载 核心功能: 能正常操作 + 数据不丢
✅ 8 bug 场景 防回归通过
✅ 168 Domain Provider 覆盖 100%
✅ DRM / 扩展安装 正常

-------- 阶段 S4 UI 面板层 (Week 14~16) 侧栏面板 UI 像素关键 --------
Week 14: side-panel-skeleton (侧栏骨架 前置插件) + favorites-panel
★ UI 检查点: 侧栏 rail 图标 8 状态 + 收藏面板 12 状态 像素匹配
交付: TaskOverlayElement (根) + RailModule + SidebarBase + FavoritesPanel
★ 注册 EP: side-panel.rail-icon-slot / panel-render-slot (让其他面板插件可挂)
favorites-panel dependsOn 链验证: 缺 side-panel-skeleton 装不上提示安装前置

Week 15: 7 个面板 + taskoverlay 小组件
★ UI 检查点: 8 个面板 每个 8 状态 = 64 张快照 匹配率 95% 全过
交付: history-panel / downloads-panel / extensions-panel / notes-panel
/ pinned-panel / profiles-panel / open-tabs-panel + tab-preview-panel
(每个 = 独立 UI 插件 独立 hira-plugin.json dependsOn: side-panel-skeleton)

Week 16: taskoverlay 交互 (rail hover / zen mode / 面板重排 / 侧栏宽度拖拽)
★ UI 检查点: zen mode 3 状态 + rail-hover 浮层 4 状态 像素匹配
交付: Rail hover判定区 + Zen mode 1000ms 展开 + 面板宽度拖拽 + 侧栏搜索

-------- 阶段 S5 APPS + 子窗口 (Week 17~19) --------
Week 17: app-main (主入口编排 加载 43 插件) + app-settings
★ UI 检查点: 设置窗口 section 像素匹配 (同原 settings)
交付: PluginRegistry 冷启动 14 步完整跑通 43 插件
app-main: 主窗口 entry / preload / renderer
app-settings: 设置窗口 UI + settings section renderer EP
settings 200 键 完整 schema (不缺原系统任何一个键的迁移)

Week 18: 子窗口统一 WindowFactory × 28 (28 种子窗口)
★ UI 检查点: 28 种子窗口 × 3 状态 = 84 快照 匹配
交付: app-subwindows 28 子窗口独立 entry (路由自动生成)
bookmark-editor / find-bar / zoom-bar / 6 权限 dialog /
js-dialog / prompt / app-confirm / password-fill-menu /
http-auth / notif / popup-permission / site-permission /
profile-switcher / menu-button / rail-tab-hover / link-hover /
resize-preview / searchbar-window / tab-preview /
manager-window ×3 (bookmark/history/download) + safety-manager / welcome / error / game / pdf-viewer
全部通过 WindowFactory.create(type) 唯一入口创建
28 × webPreferences 模板统一 = 代码中只定义一份模板 ✓ (P0-04 根除)

Week 19: 迁移工具 + 4 数据集迁移测试 里程碑 M3
★ UI 检查点: M3 主窗口 + 8 面板 + 28 子窗口 (≈150 快照) 匹配率 98%
交付: from-hira-v7.5.0 8 适配器 (PART4 §4.4) 全部实现
跑 4 数据集迁移:
DATA1 空: 通过
DATA2 2000 书签 + 200 文件夹 + 50000 历史: 100% 通过 <30s
DATA3 100k 历史: 通过 <2min
DATA4 8 个构造脏数据 (回归 8 bug): 通过
迁移后完整性 100 SQL: 100 项通过
断电模拟: 杀进程 → 启动自动 partial 回滚 → 无损坏
M3 里程碑验收:
✅ 150 UI 快照匹配 98%
✅ 4 数据集迁移 100% 成功 + 断电模拟回滚成功
✅ 28 子窗口 webPreferences 1 份模板 (P0-04 grep 验证: 仅 WindowFactory 1 处)

-------- 阶段 S6 稳定性 + 发布 (Week 20~21) --------
Week 20: 崩溃注入 + 48h 压力测试
交付:
W20-1 模块崩溃注入: 43 模块 × 100 次 throw → 其他模块正常 (核心进安全模式)
W20-2 社区 Mod 崩溃: 10 个 Mod ×100 次 throw → Mod 自动禁用 整体正常
W20-3 Provider crash: 168 Provider 每个故意返回 throw → ErrorBoundary 全捕获
W20-4 48h 压力测试: 自动化脚本 1000 URL 随机切换 + 200 次 profile 切换
内存增长 <200MB, 0 uncaught, 所有模块 healthCheck ok>95
W20-5 11 P0 根除验证 (PART6 §6.2):
V01 window.tabs === 0 ... V11 settings key 带点率 ===100%
→ 11 条全部通过 ✓
W20-6 插件权限沙箱: 社区 Mod require('fs') 必须 throw
4 级权限 × 20 scope 组合测试全通过

Week 21: 文档 + 灰度 + 最终发布闸 30 项
交付:
W21-1 用户文档: 启动指南 / 迁移指南 / Mod SDK 教程
W21-2 双轨启动器: 启动器可选 "启动 Hira v7.5.0" / "启动 Hira NG v1.0"
一键回滚脚本: rollback-to-v750.bat (<10s)
W21-3 灰度 100 用户两周测试反馈收集 + 热修复
W21-4 最终发布闸 30 项全打勾 (见 PART5 S9 末尾):
11 P0 根除 + 43 模块接口 + 80 IPC Zod 覆盖 +
settings 雪崩 <2cb + 8 bug 防 + 28 WindowFactory +
settings key namespace + SQLite 事务 + 150 UI 快照 98% +
DRM + 4 数据集迁移 100% + 48h 内存 + Mod 崩溃注入 +
模块拆装命令 + 10 Chrome 扩展 + 4 密码后端 +
快捷键 100% + 8 项隔离 + 打包签名
→ 30/30 全部打勾 → 正式发布 NG v1.0.0

=========================================
8.3 6 级里程碑可运行交付（每一级都能实际打开浏览器用）
=========================================

M0 (Week 2 末): 空壳窗口版

- 能启动空白窗口，宽高/标题栏外观和原系统一致
- Netflix DRM 视频能播放 (Day4 闸)
- 插件 Registry 能装 mock 插件

M1 (Week 6 末): "能标签+能书签" 最小可用版

- 主窗口 UI 骨架: 标签栏/导航栏 像素 95%+
- 能新建/关闭/切换标签，能收藏网页 / 建书签文件夹
- 8 bug 防回归 4 项通过

M2 (Week 13 末): "日常浏览可用" 核心版

- 主窗口 UI: 标签栏/导航栏/搜索框/webview/下载条 全 50 状态像素全过
- 书签/历史/下载 三大核心功能正常
- 能装扩展，密码能保存填充

M3 (Week 19 末): "全功能像素匹配" 完整 UI 版

- 150 快照 98% 匹配 (主窗口 + 8 面板 + 28 子窗口)
- 4 数据集迁移 100% 通过 + 断电模拟回滚通过
- 所有 8 个面板: side-panel-skeleton 前置依赖链全正常

M4 (Week 20 末): "稳定无连环崩" 加固版

- 48h 压力 OK / 崩溃注入 OK / 11 P0 根除 OK / 权限沙箱 OK
- Mod 拆装 UI: 能禁用书签功能 → 标签栏还能用 → 再启用书签 数据不丢

M5 (Week 21 末): "灰度发布" NG v1.0.0

- 双轨启动器 + 回滚脚本
- 30 项最终发布闸 30/30 ✓
- 灰度 100 用户 → 两周 → 全量推送

=========================================
8.4 UI 不大改的每周工作流程（怎么具体落地）
=========================================

每周固定流程:
周一上午: 拉取上周 code → pnpm test:ui-snapshot --all --baseline=v7.5.0
周一上午: 列出 <95% 的 UI 项 → 本周首要修复（任何功能开发往后排）
周一~周三: 写功能代码
周三下午: 每个 UI 组件提交 PR 前: pnpm test:ui-snapshot --case=xxx 必须 ≥95%
周四: 功能单测 / 集成测试 / 崩溃注入
周五上午: 每周快照报告（100 张图的匹配率趋势）+ 覆盖报告 + 回归报告
周五下午: 不写代码，做 UI Review + 令牌 Review（看有没有人偷偷硬编码颜色）

每个 UI 组件的"做对流程"（比如写 ui-panel-favorites）:
Step 1: 先从基线库里找对应 8 张基准图:
state-043-light-panel-favorites-closed.png
state-044-light-panel-favorites-open-5items.png ...
Step 2: 先不写逻辑，只写 HTML/CSS + var(--xxx) tokens（只用令牌！）
Step 3: pnpm test:ui-snapshot --case=043-050 → 8 张全部 ≥95% → 视觉通过
若 <95%: 用 pixelmatch 差异图看哪里偏 → 调令牌值 (比如 --panel-header-height 从 40px → 39px)
Step 4: 视觉通过 → 再挂 JS 逻辑 + Provider API + EP
Step 5: 逻辑测完 → 再跑一次快照 → 视觉不能低于 Step 3 结果 → 提交 PR

=========================================
附录 A - UI 100 快照基线矩阵（Day1 要拍的图）
=========================================

分类：
A. 主窗口框架 (1-15):
001-005 浅/深模式，0 标签 / 1 标签 / 5 标签 / 10 标签 / 20 标签（滚动）
006-010 窗口状态: 普通 / 最大化 / 最小化还原 / 全屏 / 高 DPI 150%
011-015 聚焦 / 失焦 / zen-mode / rail-展开 / rail-收起

B. 标签栏 & 标签 (16-40 × 浅深各一套 = 25×2=50):
16 普通选中 / 未选中 / hover
17 标签上有声音播放 / 静音状态 / 录制指示器
18 2 标签堆叠 (栈 glance) / 栈展开
19 5 个标签组 + 选中组头
20 固定标签栏 (pinned tab 5 个)
21 标签右键菜单弹出 (5 项菜单都显示)
22 标签编辑器 (重命名输入框显示)
23 标签预览浮层 (700ms hover 显示缩略图+标题)
24 拖拽中状态 (拖到标签间隙 插入指示器显示)
25 新增按钮 hover / workspace-switcher 展开

C. 导航栏 + 搜索框 (41-55):
41 导航栏按钮后退/前进可用/禁用态
42 书签星 实心 / 空心 / hover
43 进度条 10% / 50% / 90% / 安全指示锁图标
44 内容屏蔽开/关 指示器
45 权限请求条 (麦克风/摄像头/通知)
46 菜单按钮点击弹出 (窗口控制菜单全显)
47 搜索框聚焦 / 非聚焦
48 搜索建议 5 条显示 (书签/历史/搜索引擎/bang各1)
49 搜索框计算器结果 (例: 输入 1+1= 显示 2)
50 自定义 bang !g → 展开正确
51 搜索框 Tab 切换 focus 态

D. 侧栏 TaskOverlay × 8 面板 (56-80):
56 side-panel-skeleton: rail 5 图标显示
57 rail 图标 hover (浮层预览 tooltip)
58 favorites-panel 空 / 5 书签 / 3 层文件夹展开
59 history-panel 今天/昨天/7天前 分组显示
60 downloads-panel 下载中 / 已完成 / 已暂停 / 危险文件 4 状态
61 extensions-panel 扩展 3 个列表
62 notes-panel 笔记 2 条 + 选中态
63 profiles-panel 3 个空间 + 选中态高亮
64 pinned-panel 固定标签 5 个
65 open-tabs-panel 10 标签搜索显示
66 tab-preview-panel 预览浮层显示
67 侧栏宽度拖拽到最大/最小状态
68 zen-mode 侧栏自动展开 1s 后 (rail → tabs)
69 侧栏 search 框聚焦 + 搜索 3 结果

E. 子窗口 + 对话框 (81-100):
81 bookmark-editor 对话框 普通态 / 文件夹选择下拉展开
82 find-bar 查找栏 (3 结果高亮 + 计数 1/3)
83 js-dialog alert / confirm / prompt 3 样式
84 权限对话框: 通知 + 弹窗 2 种
85 http-auth 用户名密码输入
86 profile-switcher 空间切换弹出
87 tab-preview 独立预览窗口
88 link-hover 状态栏 (URL 显示左下角)
89 zoom-bar 缩放栏 150% 显示
90 password-fill-menu 填充建议 2 条
91 command-palette 命令面板 (输入 "bookmark" 5 结果)
92 menu-button 独立菜单弹出 (完整菜单项)
93 rail-tabs-hover 浮层显示
94 popup-permission 请求对话框
95 notification-permission 请求
96 site-permission 管理
97 manager 书签管理器窗口 (大窗口)
98 settings 窗口 General/Appearance/Privacy/Search/Shortcuts 5 页
99 safety-manager 安全管理 (危险下载列表)
100 welcome 首次启动欢迎窗口

→ 合计 100 张基准图 = UI 宪法

=========================================
8.5 启动重写 Day1 超具体 Step by Step（复制命令就能用）
=========================================

:: File: start-rewrite-day1.bat 放在 1A-STAR_Hira/ 根目录
@echo off
echo ========================================================
echo Hira NG 重写 Day1 启动脚本 - 照着跑就行
echo ========================================================

:: Step1: 建目录
echo [1/7] 创建 NG 目录...
mkdir ..\1A-STAR_Hira_NG
mkdir ..\1A-STAR_Hira_NG\apps
mkdir ..\1A-STAR_Hira_NG\ui
mkdir ..\1A-STAR_Hira_NG\domain
mkdir ..\1A-STAR_Hira_NG\infra
mkdir ..\1A-STAR_Hira_NG\packages
mkdir ..\1A-STAR_Hira_NG\migrations
mkdir ..\1A-STAR_Hira_NG\docs-ng\ui-baseline\v7.5.0
mkdir ..\1A-STAR_Hira_NG\tests\ui

:: Step2: 拷贝现有核心配置骨架
echo [2/7] 从 RT 项目 拷贝配置骨架
copy 1A-STAR_Hira_RT\electron.vite.config.ts ..\1A-STAR_Hira_NG\electron.vite.config.js
copy 1A-STAR_Hira_RT\drizzle.config.ts ..\1A-STAR_Hira_NG\drizzle.config.js
copy 1A-STAR_Hira_RT\tsconfig.json ..\1A-STAR_Hira_NG\tsconfig.base.json
:: (然后手动改路径 去掉 .ts 扩展名保留结构)

:: Step3: pnpm 初始化
echo [3/7] pnpm monorepo 初始化 (需要 pnpm)
cd ..\1A-STAR_Hira_NG
pnpm init
echo packages: >> pnpm-workspace.yaml
echo - "apps/_" >> pnpm-workspace.yaml
echo - "ui/_" >> pnpm-workspace.yaml
echo - "domain/_" >> pnpm-workspace.yaml
echo - "infra/_" >> pnpm-workspace.yaml
echo - "packages/*" >> pnpm-workspace.yaml

:: Step4: 安装依赖 - 注意 electron 要用 castlabs Widevine 版本
echo [4/7] 安装核心依赖...
pnpm add -Dw electron-vite vitest pixelmatch pngjs
pnpm add -Dw drizzle-kit eslint@9
pnpm add -w better-sqlite3 drizzle-orm zod
:: 关键：castlabs Widevine DRM 版 electron (不能用默认官方!)
pnpm add -w "electron@https://github.com/castlabs/electron-releases#v41.1.1+wvcus"

:: Step5: 43 包 空目录 + package.json 模板
echo [5/7] 创建 43 包空目录...
FOR %%P IN (
infra-db infra-ipc infra-window infra-plugin infra-storage
infra-logger infra-error infra-fs infra-platform infra-theme infra-l10n
domain-bookmark domain-history domain-download domain-tabs domain-settings
domain-profile domain-password domain-permission domain-extension
domain-search domain-session
ui-common ui-tabbar ui-navbar ui-searchbar ui-webviews ui-taskoverlay
ui-panel-favorites ui-panel-history ui-panel-downloads ui-panel-extensions
ui-panel-notes ui-panel-pinned ui-panel-profiles ui-panel-opentabs
ui-panel-tabpreview ui-findinpage ui-password-manager
app-main app-subwindows app-settings app-manager
packages-shared-types packages-shared-utils packages-shared-ui-tokens
) DO (
mkdir %%P
echo { "name": "@hira/%%P", "version": "0.0.1", "main": "src/index.js", "scripts": {"test": "vitest run"} } > %%P\package.json
mkdir %%P\src
echo // @ts-check >> %%P\src\index.js
echo export const id = "%%P"; >> %%P\src\index.js
)

:: Step6: 跑快照基线提取脚本
echo [6/7] 提取 CSS tokens...
node scripts\extract-css-tokens.js css\base.css packages\shared-ui-tokens\tokens-base.css
node scripts\extract-css-tokens.js css\base.css +--dark packages\shared-ui-tokens\tokens-dark.css

:: Step7: 验证空白窗口 + DRM
echo [7/7] Day5 验证: pnpm dev 跑空窗口 + 快照对比
pnpm dev --verify-drm

echo ========================================================
echo Day1 完成。任何一步失败回到对应步骤解决。
echo 通过了就进入 Week2 写 INFRA 10 包。
echo ========================================================

→ 保存这个 bat 就能按按钮启动重写。

--- EOF ---
