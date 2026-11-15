# STAR Hira NG 大换血重写规划 PART 5 - 双轨开发执行路线图 (10阶段)

生成时间：2026-01-03

=========================================
5.0 双轨开发核心原则
=========================================

开发目录: 1A-STAR_Hira_NG/ (与原项目完全并列 物理独立)
原项目目录: 1A-STAR_Hira/ (整个开发期间保持不变 只修紧急线上bug)

两条平行线:

- 轨道A(维护): 原项目 只修线上blocker级bug 大功能不做
- 轨道B(重写): NG目录 完全按本文档 从零搭脚手架 逐步填充模块

每阶段末尾: 里程碑验证 + 轨道A/B对照评审 → 决定是否进入下一阶段

关键: 绝不中途修改原项目架构配合NG 也绝不"先在原项目改一点再迁移"
→ 这样即便 NG 出问题 可随时 100% 回到原项目 无风险

=========================================
5.1 阶段总览甘特 (10阶段)
=========================================

| 阶段 | 名称                   | 周期估 | 交付物                                                          | 风险等级 | 验收标准                                       |
| ---- | ---------------------- | ------ | --------------------------------------------------------------- | -------- | ---------------------------------------------- |
| S0   | 基础设施脚手架         | 1.5 周 | NG目录+monorepo+electron-vite跑起空窗口+SQLite连通              | 低       | 空窗口启动 <2s 数据库打开正常                  |
| S1   | INFRA层核心            | 2 周   | infra-plugin/ipc/window/logger/storage 10个基础包全通过         | 中       | PluginRegistry跑通IHiraModule接口 100%单测覆盖 |
| S2   | DOMAIN-Tabs + Settings | 2 周   | domain-tabs + domain-settings + migrations架构跑通              | 中高     | 1000 Tab 压力测试通过 settings 雪崩解决        |
| S3   | DOMAIN-核心业务        | 2.5 周 | domain-bookmark + history + download + profile + session        | 高       | 8历史bug场景 全部防止 通过                     |
| S4   | DOMAIN-扩展模块        | 1.5 周 | domain-password(4后端抽象) + permission + search + extension    | 高       | 与旧系统 功能矩阵100%映射                      |
| S5   | UI-核心层              | 2.5 周 | ui-common + ui-tabbar + ui-navbar + ui-webviews + ui-searchbar  | 极高     | 像素对齐 A/B截图 95%+ 匹配                     |
| S6   | UI-面板层              | 2 周   | ui-taskoverlay + 8个面板 + findinpage/download-manager/password | 高       | 10个面板 功能正常 截图对齐                     |
| S7   | APPS集成 & 子窗口      | 2 周   | app-main + 28种子窗口的WindowFactory统一                        | 中高     | 28种子窗口 webPreferences 100%一致 无遗漏      |
| S8   | 迁移工具 & 全量测试    | 2.5 周 | from-hira-v7.5.0 8适配器 + 3测试数据集全过                      | 极高     | 2k书签/10w历史数据集 迁移成功率 100%无错       |
| S9   | 稳定性 & 发布准备      | 2 周   | 48h压力测试+崩溃注入+回滚演练 + Widevine DRM验证                | 极高     | 无连环崩溃 模块故障不影响整体 DRM视频正常播放  |

总计估计: 21 周 ≈ 5 个月 (可加速: S2/S3并行 或 UI/后端双团队S4+S5并行)

=========================================
5.2 阶段S0: 基础设施脚手架 (1.5周)
=========================================

目标: 从 0 到 1 让 monorepo + electron-vite 能出一个能联网的空窗口

Todo:
S0-1 pnpm init monorepo - 创建 1A-STAR_Hira_NG/ 目录 - pnpm-workspace.yaml: packages apps ui domain infra 4 workspace roots - package.json: electron-vite 5.x / better-sqlite3 / drizzle-orm / zod / vitest - eslint: 规则集: no-global-assign / no-process-platform / no-direct-ipc / no-string-domid
S0-2 electron.vite.config.js 三段式配置 - main: alias @/=main ~/=packages/shared-types entry: apps/app-main/src/main.js - preload: 同上 entry: apps/app-main/src/preload.js (contextIsolation=true!) - renderer: alias @/=apps/app-main/src/renderer ~/=shared entry: index.html
S0-3 drizzle.config.js SQLite 配置 - schema: infra/infra-db/src/schema.js - out: infra/infra-db/drizzle - dialect: sqlite
S0-4 最小 IHiraModule 骨架 + PluginRegistry 最简实现 - 只实现 install/start 不做错误处理 只跑通流程
S0-5 最小空窗口 WindowFactory.createMainWindow() - 使用正确安全的 webPreferences (contextIsolation:true sandbox:true nodeIntegration:false) - preload 中只通过 contextBridge 暴露 flow: {} 空对象 绝对不暴露 ipcRenderer
S0-6 SQLite 建库 打开 关闭 测试 - PRAGMA 测试 + 1张测试表 插入1000行再读 => 性能OK (<50ms)
S0-7 Widevine DRM 兼容性测试 (最重要的非功能性) - 切换 Electron 到 castlabs/electron-releases 对应版本 - 打开 Netflix/Spotify DRM 测试页 => 视频正常播放 (否则整套构建要重来!) - electron-builder.yml 配置 widevine 相关签名
S0-8 打包流程 dry run - 空窗口能打包出 exe (win-unpacked 能运行)

验收: 启动时间 <2s 数据库1000行读写<50ms DRM视频能播放

=========================================
5.3 阶段S1: INFRA层10个包完整实现 (2周)
=========================================

交付: infra-* 10 个包全部 单测覆盖 >=90% 文档齐全
顺序(依赖图 从上到下=从最底层开始):
S1-1 infra-fs, infra-platform, infra-logger, infra-error (零交叉依赖 可并行)
S1-2 infra-storage (依赖 infra-fs/infra-logger) JsonStore + FileIO
S1-3 infra-db (依赖 infra-logger + better-sqlite3) Drizzle schema v1 空表
migrator/backup/事务封装
S1-4 infra-theme, infra-l10n (ui tokens + l() 函数)
S1-5 infra-ipc (依赖 infra-logger) TypedIpcMain/TypedRenderer + 强制Zod + ListenersManager + ChannelNames 枚举
S1-6 infra-window (依赖 infra-logger + infra-platform) WindowFactory 3种模板
WindowRegistry + WindowLifecycle
S1-7 infra-plugin (依赖 infra-ipc + infra-error) PluginRegistry 完整实现
DependencyGraph Tarjan循环检测 ModuleSandbox 错误隔离
healthCheck 调度器

核心交付 S1-7 PluginRegistry 启动流程 必须写死12步:

1.  扫描所有模块的 IHiraModule 实现文件 (import.meta.glob 或注册清单)
2.  建图 A.dependencies → B 连边
3.  Tarjan 算法查强连通分量 => 有环直接 THROW (禁止启动 输出循环路径)
4.  Kahn 算法拓扑排序 => 确定安装顺序
5.  按顺序逐个 install(module): 包 try/catch 沙箱 失败的模块标记 FAILED
6.  非 core 模块 FAILED 只告警 不终止启动 (无连环崩溃! 核心设计!)
7.  core 模块 FAILED: 进入安全模式 只启动 infa-* + 回滚对话框
8.  全部 install 成功后 逐个 start(module) 再走一轮沙箱
9.  start 成功后 模块 provides API 暴露给其他模块
10. 注册 module health 定时任务: 每30s 调 healthCheck
11. UI/APPS 通过 PluginRegistry.getApi(id) 拿模块API 禁止直接 import 内部
12. 启动完成事件广播 各模块:

S1 验证:

- 人为 throw: domain-bookmark install 抛错 → 其他 39 模块 正常启动 标签栏可用只是书签按钮禁用 ✅
- 人为 throw: infra-db (core) → 自动进入安全模式 对话框 3选项: 回滚/重装/退出 ✅
- 循环依赖检测: domain-bookmark 依赖 domain-history 又依赖 domain-bookmark
  → 启动前就 throw 显示循环路径图 ✅

=========================================
5.4 阶段S2: DOMAIN-Tabs + Settings (2周) [P0最优先]
=========================================

目标: 替换 window.tabs (60+模块依赖的 P0炸弹) + 解决 settings 广播雪崩

交付:
S2-1 domain-tabs 完整实现 (ITabList 接口 + Tab/TabGroup/Workspace 4类) - 100+ 单测用例 (所有边界条件: 插入/删除/移动/分组/栈切换/重复ID) - 1000 Tab 压力测试: add/remove 10万次 内存泄漏<10MB 无crash - Schema B1-B4 drizzle generate 迁移脚本
S2-2 domain-settings 完整实现 (ISettingsService) - schema.js: 首批 80 key 的 Zod 定义 + namespace 体系 - watch(pattern, callback): 通配符订阅 minisearch pattern匹配 engine - migrations 001_initial.js: 默认值注入 - settings.set('ui.darkMode', true) 后:
✅ 只有 watch('ui.*') 和 watch('ui.darkMode') 的 cb 执行
❌ 其他 200+ 不关心的 listener 完全不触发 (广播雪崩解决!)
S2-3 domain-profile + A1-A2 表 跑通 - 创建/删除/切换 profile + 8项隔离配置
S2-4 domain-session: 会话恢复服务 - 冷启动: 从 tabs B1 表加载 -> 还原位置/分组/选中项 -> 性能 <500ms (100 tabs)
S2-5 B/E 组表 drizzle 生成 (tabs/window_states/workspaces/search_history/...)

S2 验收: 内存中 1000 Tab + 100 settings watcher

- 改 1 个 setting key -> 平均只有 1.3 个 cb 执行 (原系统 231 个!)
- Tab 全部操作 无global 直接 require('@hira/domain-tabs') 就能跑脱离Electron测试

=========================================
5.5 阶段S3: DOMAIN 核心业务 (2.5周) [历史bug验证期]
=========================================

交付: domain-bookmark / history / download / profile 4 个核心 P1 模块

S3-1 domain-bookmark (最优先 历史bug最多 必须覆盖8场景):
11个用例实现 对应 8个历史bug必须全部通过:
UC1 createBookmark(url, folderId) → 事务: bookmarks插入 + folder.updated_at
UC2 createFolder(name, parentId) → 防止重名 UNIQUE 校验
UC3 moveBookmarks([ids], toFolderId)→ 事务: 多行更新 + 重新计算 order_in_folder (fractional indexing)
UC4 moveFolder(folderId, newParent) → 环检测: 不能把父文件夹移到自己子文件夹里
UC5 deleteFolderCascade(folderId) → 事务: 递归删除 所有子孙 bookmarks+folders + 已删备份到 recycle_bin
UC6 reorderWithinFolder → REAL fractional 插入 (无需N行UPDATE)
UC7 import HTML Netscape 格式 → 10000 书签导入 < 10s 不阻塞UI
UC8 export HTML
UC9 undoLastOperation (栈 20步)
UC10 getFolderTree(profileId) → 一次SQL查出全量 folders + 内存建树 <10ms
UC11 searchBookmarks(text) → FTS5 全文搜索 <20ms 10k行
8 个历史 bug 验证:
BUG1 创建时 folderId 是 undefined → 不再落到 settings 散落的 key (修复)
BUG2 删除文件夹子文件夹不删 (原 deleteFolderRows bug) → Cascade事务保证
BUG3 移动到子级自己 → 环检测函数抛错拒绝
BUG4 重排 update N+1 条 SQL → REAL排序值 只改1条
BUG5 多窗口同时重排不一致 → SQLite写锁+事务
BUG6 settings.listen 雪崩抖动 → pattern watch 只发关心的key
BUG7 扩展侧栏pinned与folder顺序双写 → 都在bookmarks C3表 单列事务
BUG8 导入重复URL去重错 → UNIQUE索引 + merge策略可选
S3-2 domain-history: URL去重 + 访问事实 + FTS5全文搜索 (10w行无压力)
S3-3 domain-download: 下载状态机 + 多连接下载器 + P6危险文件检测 scanner
S3-4 domain-profile 完整 + 8 隔离项 + 切换副作用
S3-5 E2E组表: bookmarks/history/downloads完整表 + FTS虚拟表

验证S3: 8个历史BUG回归测试用例 全部 100% 通过

=========================================
5.6 阶段S4: DOMAIN 扩展模块 (1.5周)
=========================================

Todo:
S4-1 domain-password: IPasswordBackend 4 后端实现 + Facade
S4-2 domain-permission: permissions D3 表 + 取代 filtering.js 权限函数
S4-3 domain-search: 聚合 suggestions 来源 (历史+书签+搜索引擎+open tabs+bangs)
S4-4 domain-extension: extensions D2 表 + electron-chrome-extensions 集成
按 profile 加载 Session partition 扩展独立

交付: 与原系统 功能矩阵对照表 100% 对应 (逐项打勾 不能漏)

=========================================
5.7 阶段S5: UI 核心层 (2.5周) [像素冻结 最敏感]
=========================================

UI 技术栈: 原生 JS + Web Components (Shadow DOM 局部CSS 天然无冲突) + 不引入 React (像素对齐 React 合成事件与原生事件偏差难调)

交付顺序:
S5-1 ui-common: ListItem Modal WindowControls + shared-ui-tokens (颜色/间距/字体/圆角)
→ 原 CSS 变量逐一提取到 tokens-light.css / tokens-dark.css
→ 每个组件的 computed style 输出 与原系统 A/B diff <1px
S5-2 ui-tabbar: TabBar + 子组件 (Tab TabStack TabPreview AddTabButton TabEditor)
→ 拖拽排序: @atlaskit/pragmatic-drag-and-drop (同RT 企业级拖拽库)
→ 事件: on('tab-select', id) 等 不依赖 window.tabs
→ ★ 截图对比工具 (pixelmatch) 对 20 种状态截图 像素匹配率 >= 95%
S5-3 ui-navbar: Navbar + NavigationButtons + BookmarkStar + ProgressBar + PermissionRequests + ContentBlockingToggle + MenuButton
S5-4 ui-searchbar: SearchBarElement + 12个SearchbarPlugin 逐个实现
→ Bangs/Calculator/SearchSuggestions/PlaceSuggestions/InstantAnswer
/HistoryViewer/BookmarkEditor/CustomBangs/ShortcutButtons/UpdateNotifications
S5-5 ui-webviews: WebviewContainer + GestureHandler + AudioManager + TitleSync
→ 替代 webviews.js 1300 行
S5-6 每个组件 必须带 截图测试: 原 vs NG pixelmatch 差异图归档

S5 验收: 20种UI状态 (标签/导航/搜索/webview) 像素匹配率 95%+
差异 <5% 必须是 bugfix (比如原bug的padding 修复 算可接受差异)

=========================================
5.8 阶段S6: UI 面板层 (2周)
=========================================

S6-1 ui-taskoverlay: TaskOverlayElement 根容器 + RailModule + SidebarBase
zenMode/rail展开收起 → 原交互完全对应
S6-2 8 个面板逐个实现 (每个都是独立 IHiraModule 可热插拔):
ui-panel-favorites + history + downloads + extensions + notes + pinned + profiles + openTabs + TabPreviewPanel
S6-3 ui-findinpage + ui-password-manager + ui-modal + ui-new-tab + ui-settings
S6-4 全部侧栏面板 样式截图对比 95%+ 匹配
S6-5 交互模拟测试: 100 常见用户操作序列 自动化脚本

=========================================
5.9 阶段S7: APPS集成 + 子窗口统一 (2周)
=========================================

S7-1 app-main 主窗口入口 + PluginRegistry 启动全部模块
完整启动流程: 冷启动 -> DB -> migrations -> PluginRegistry -> UI挂载 -> 恢复标签
S7-2 28 种子窗口的 WindowFactory.create(type, options) 统一 - 枚举所有窗口类型: BOOKMARK_EDITOR / FIND_BAR / ZOOM_BAR / ... - 每种窗口: 一份 WindowSpec (尺寸/frame/modal/parent/webPreferences继承模板) - 绝对不允许 28 处各自 new BrowserWindow
S7-3 app-subwindows 28 个子窗口各自独立 electron-vite entry - 自动路由生成 (类似 RT generateRoutes) - 每个子窗口独立 preload + contextIsolation
S7-4 app-settings + app-manager 三个管理页入口
S7-5 IPC 完整契约测试: 每条通道请求/响应 Zod 校验通过
S7-6 快捷键完整映射: defaultKeybindings 100% 迁移 + domain-shortcuts

验收: 原来 28 种子窗口现在全部可以通过 WindowFactory 用常量枚举创建
webPreferences 代码中只出现 1 份模板定义

=========================================
5.10 阶段S8: 迁移工具 + 全量测试 (2.5周) [最重要安全闸]
=========================================

S8-1 8 适配器实现: SettingsAdapter / DexiePlaces / Thumbnails / DownloadHistory
/ SessionRestore / CustomBangs / PasswordsMeta / DataIntegrityVerifier
S8-2 3 套测试数据集:
DATA1-empty: 全新安装 空数据
DATA2-realistic2k: 2000 书签 200 文件夹 50000 历史访问 200 下载
DATA3-heavy100k: 100k 历史访问 5000 书签 50空间 压力边界
DATA4-regression8: 对应 8 个历史 bug 的构造数据 (故意脏数据/重复/坏引用)
S8-3 迁移 4 套数据集 全部通过:
✅ 迁移无异常
✅ 迁移后 100 条完整性 SQL 全通过
✅ 书签 URL 数 不变 文件夹 层级正确
✅ 历史访问数 不变 URL 去重正确
✅ 下载条目 state 映射正确
✅ 4 套数据 迁移平均时间 <30s DATA3 <2min
S8-4 回滚演练:
迁移过程中断电 (模拟 kill -9):
→ 下次启动自动检测 partial 标记 → 自动回滚到备份 → 无损坏 ✅
S8-5 跨版本迁移: 拿 3 个用户真实数据库 (脱敏) 做迁移

S8 验收: 4套数据集迁移100%成功 回滚演练100%成功

=========================================
5.11 阶段S9: 稳定性 & 发布准备 (2周) [质量闸]
=========================================

S9-1 48h 压力测试:
自动化脚本: 随机打开1000网址 切profile 200次 开关面板500次
→ 内存增长 <200MB (不无限泄露) → 无 uncaughtException
→ 模块 healthCheck 全部 ok>95
S9-2 崩溃注入测试 (连环bug杀手锏):
对每个模块故意:
(a) install throw => 其他模块正常启动 核心模块进入安全模式 ✅
(b) runtime throw 100次 => 每次ErrorBoundary捕获 模块降级 其他模块不影响 ✅
(c) stop 卸载再 start 热重启 => 状态恢复功能正常 ✅
S9-3 模块拆装演练:
hira module stop domain-bookmark => 主窗口正常 书签按钮灰 其他功能全好 ✅
hira module restart ui-tabbar => 标签栏热刷新 不用关整个窗口 ✅
hira module list => 43个模块状态实时 ✅
S9-4 截图全量回归: 100 UI 状态 NG vs 原系统 像素匹配 95%+ 差异项人工 review通过
S9-5 文档齐全: 本规划 PART1~6 + README 启动指南 + 开发指南 + 模块API文档 (JSDoc)
S9-6 DRM / 扩展 / 密码 实际网站测试:
Netflix 视频 / YouTube 4K / 微信公众号 / 百度网盘 /
10 个常用 Chrome 扩展安装启用 / Bitwarden 登录
S9-7 electron-builder 打包:
Windows NSIS 安装包 + portable zip
自动签名 + Widevine 配置
S9-8 灰度发布准备: 迁移前备份 / 双轨并行启动器 (可选原/NG) / 一键回滚 bat

最终发布验收清单 (全部必须 ✅):
□ 所有 P0 致命耦合 11项 全部根除 (代码搜索 0 处!)
□ 43 个模块 全部实现 IHiraModule 接口 可热拆装
□ 全部 80+ IPC 通道 Zod schema 覆盖率 100%
□ settings 广播雪崩 解决 (改1key平均执行<2 cb)
□ 8 个历史 bug 用例 100% 回归防护
□ 28 子窗口 WindowFactory 统一 webPreferences 只定义1份
□ settings 200+键 schema 完整 无扁平裸key
□ SQLite 事务 跨域写 100% 保证一致性
□ UI 像素匹配 95%+ (100状态截图全对比)
□ DRM视频正常播放
□ 4套迁移数据集 100%成功 回滚演练100%成功
□ 48h压力测试内存增长<200MB 无崩溃
□ 模块崩溃注入 100% 通过 (不连环 不整体 crash)
□ 模块拆装 命令 全通过 (stop/restart/health/list)
□ 10个常用 Chrome扩展 能正常安装运行
□ 4密码后端 全部可用 (内置/Bitwarden/1Password/macOS Keychain)
□ 快捷键 100% 与原系统一致
□ 8项profile隔离配置 全部生效
□ 打包签名安装成功 冷启动 <3s

---

满足以上全部才从 v7.5.0 升级到 NG v1.0.0
