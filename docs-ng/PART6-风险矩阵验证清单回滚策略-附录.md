# STAR Hira NG 大换血重写规划 PART 6 - 风险矩阵 验证清单 回滚策略 附录

生成时间：2026-01-03

=========================================
6.1 风险矩阵 (R1-R15) 按概率x影响排序
=========================================

风险级别: ████ 灾难 ███ 严重 ██ 中等 █ 低

R1 ████ UI 像素不一致导致 大面积用户投诉
概率: 40% | 影响: 5/5 (完全抵消重构收益 用户骂声一片)
预防:

- S5 每个组件 强制 pixelmatch 像素对比 归档差异图 <5% 才能过
- 100 个常见用户场景 人工走查 截图留存
- 两套 UI 并跑 beta 版 100 用户试用两周 收集偏差反馈
  降级: 提供 UI 开关 "经典外观 / NG 外观" 回退到经典 (代价大 但必须留)

R2 ████ 迁移时 数据丢失 或 不一致
概率: 20% | 影响: 5/5 (用户数据丢失 = 产品死刑)
预防:

- S8 4套数据集 3类(空/典型/压力/回归脏数据) 迁移 100% 通过
- 迁移前 自动: settings.json + 所有 JsonStore + IndexedDB 导出 zip 备份
- 迁移流程: 先写临时 hira.db.tmp → verifier 通过 → rename 成正式
  → 任何一步失败 不动原文件 用户无感知
- 迁移后 完整性 SQL 100 条 全通过才允许启动
  回滚: 启动器提供 "从旧系统数据恢复" 一键 回滚 .bak 文件

R3 ████ Widevine DRM 不兼容 (castlabs electron 签名问题)
概率: 30% | 影响: 5/5 (Netflix/Spotify 看不了 用户直接卸载)
预防:

- S0-7 阶段0 DRM 就验证 跑不通不进入下一阶段 (最前置!)
- electron 版本锁定 castlabs/electron-releases 对应版本
- electron-builder 的 afterPack/签名配置 完整保留 RT 做对的做法
  降级: 发版前 用 3 台不同 Windows 机器 实机验证 Netflix/Spotify/YouTube

R4 ███ 模块热插拔 产生边界 case 导致 局部崩溃
概率: 35% | 影响: 4/5
预防:

- PluginRegistry.ModuleSandbox 每个模块包一层 domain error 边界
- 每个 IHiraModule.provides 函数 入口强制 try/catch
- S9-2 崩溃注入测试: 每个模块 throw 100 次 其他模块必须全正常
  降级: UI 右上角 "健康状态图标" 点击查看模块报告 低分模块 提示用户重启该模块
  (用户不用重启整个浏览器)

R5 ███ settings 命名空间迁移 漏掉 某些老 key 导致 UI 显示默认值
概率: 50% | 影响: 3/5 (中 困扰用户但数据不丢)
预防:

- settings-keys-map.json 完整 200+ key 映射表 (PART4 A3 表)
- 迁移最后阶段: 遍历 settings.json 原始 所有 key → 检查 mapping 覆盖率
  未映射的 打 warning 日志 不会丢失 作为 "unknown.key.*" 存 settings 表
- 首启动弹出 "迁移摘要" 显示 迁移了多少键 多少未知 让用户确认
  降级: 未映射 key 作为 legacy 数据保留 不丢失 后续版本按需补映射

R6 ███ 28 种子窗口 各种边角交互遗漏 (原系统多年演化的特例)
概率: 45% | 影响: 3/5
预防:

- 建 WindowInteractionTest 28 × 10 用例矩阵:
  每个子窗口: 创建/显示/隐藏/关闭/销毁/父窗口关闭时/ESC/点击外部/resize/错误恢复
- electron-vite 自动路由 + 统一 WindowFactory
  不会漏一种窗口两种 webPreferences

R7 ███ 密码 4 后端 迁移后 绑定关系断 无法解密旧密码
概率: 25% | 影响: 4/5
预防:

- 密码 sensitive value 不迁移! 只迁移 passwords_meta (id/domain/username/backend_ref)
  实际密文仍然存在原后端
- 首次启动旧后端直接对接验证: 第 1 个密码登录成功再迁移 meta
- Bitwarden/1Password 保持 原 API key/会话不清理
  降级: 设置中 "密码后端重建索引" 手动扫描后端 重建 metadata

R8 ███ 与原系统 side-by-side 双轨时 userData 冲突
概率: 60% | 影响: 2/5 (低)
预防:

- NG 初期 app.setPath('userData', ...Hira-NG-development) 独立目录
- 发布后 beta 通道: STAR_Hira_NG 与原 Hira 完全独立
  → 用户可同时安装两个版本 分别跑不同 userData 互不影响
- 正式升级: 第一次启动 NG 才做迁移 原目录 .bak
  → 随时可以卸载 NG 回到原 Hira

R9 ██ Electron 升级 产生不兼容 (原系统是老 Chromium 149)
概率: 30% | 影响: 3/5
预防:

- 统一锁定到 RT 对应的 Chromium 版本(已验证通过的)
- commandLine.appendSwitch 整理: 原系统 11 个 switch 逐个验证必要性
  移除 已纳入默认/过时的 switch
- 原系统的安全开关禁用 (webSecurity:false 等) 必须替换成正确的白名单配置
  不能继续裸开

R10 ██ 构建系统 electron-vite 与 browserify 行为差异导致 require 路径解析错
概率: 40% | 影响: 2/5
预防:

- 不再用 Browserify 非标准 paths 别名
- 全部用 package.json exports + pnpm workspace 标准别名
  @hira/ui-tabbar / @hira/domain-bookmark / @hira/infra-db
- ESLint no-restricted-imports: 禁止 'webviews.js' 相对裸路径
  必须 '@hira/ui-webviews' 包名导入

R11 ██ better-sqlite3 原生模块 Windows 编译失败 (node-gyp)
概率: 30% | 影响: 2/5
预防:

- package.json 加 trustedDependencies: better-sqlite3
- electron-builder install-app-deps postinstall hook 确保 Electron ABI 编译
- 开发文档写明: Windows 需要 VS Build Tools C++ (官方标准)
- 提前将预编译好的 better-sqlite3 .node 文件 放到 build assets 提供备用

R12 ██ 扩展 electron-chrome-extensions 新版 API 变动
概率: 25% | 影响: 3/5
预防:

- 版本锁定到 RT 验证过的版本 (@iamevan/electron-chrome-extensions 4.9.4)
- domain-extension 对 chrome-extensions API 套一层适配层
  万一升级 只要改适配层 其他代码不用动

R13 ██ 原系统的 67 条 TDZ 顺序依赖 迁移时 误当有效逻辑保留
概率: 35% | 影响: 2/5
预防:

- NG 的 PluginRegistry 拓扑排序依赖 显式 dependencies[] 声明
  不再依赖 文件拼接顺序 所以 原 TDZ 自然不存在
- 原 main.build.js 的 setImmediate 绕开逻辑 必须不搬过来
  任何 NG 代码 只要出现 setImmediate(xx) 要 review 为什么

R14 ██ 性能退化: NG 层封装 冷启动变慢
概率: 40% | 影响: 3/5
预防:

- 冷启动性能基线 (原系统: 冷启动到首页可操作 < 1.8s)
- S9-5 基准测试: 10次冷启动 平均时间 必须 <= 基线 * 1.1
- PluginRegistry: core 模块优先同步加载 optional 模块 idle后异步加载
  核心 UI 1.5s 内必须可见

R15 ██ UI 组件 事件语义差异 导致 快捷键/手势不一致
概率: 45% | 影响: 2/5
预防:

- 交互测试用例: 50条 原系统习惯 (Ctrl+T 新标签 / 中键关闭 / 拖标签新建组 ...)
  自动化脚本 对比 原系统 和 NG 对同一输入的响应 完全一致

=========================================
6.2 11 P0 致命耦合 根除验证清单 (每个必须执行)
=========================================

验证方法: 代码搜索 (grep -r) + 运行时检测
全部通过 = PART1 P0 11 项 完全消除

验证命令 全部必须 === 0 results:

V01 window.tabs 全局单例: (60+依赖 根除)
grep -rn "window\.tabs\s*=" js/ apps/ ui/
grep -rn "window\.tabs\." renderer/ 期望 0

V02 67文件硬编码顺序拼接:
grep -rn "modules\s*=\s*\[" scripts/ (原 buildMain.js:6-73)
确认 buildMain.js 不再是 build 流程一部分

V03 global.xxx + typeof 判存调用:
grep -rn "typeof global\.\w+\s*===\s*['\"]function['\"]" main/ ==0
grep -rn "global\.\w+\s*=" main/ <3 只剩 core 内置

V04 28种 BrowserWindow 8种创建模式:
grep -rn "new BrowserWindow" main/ apps/
=== 1 处 仅出现在 infra-window/WindowFactory.js (其他全部改为 WindowFactory.create(type,opt))

V05 settings 广播雪崩 231 listen:
grep -rn "settings\.listen.*function" ui/ apps/ ==0
全部改为 settings.watch('namespace.pattern', cb) 形式

V06 ipcMain._invokeHandlers 反向调用:
grep -rn "_invokeHandlers" main/ apps/ ==0
直接删除 bookmarkEditor.js 那条链路 用 domain 服务获取数据

V07 跨存储双写路径:
Dexie open() 调用点 在渲染进程 ===0
所有 places 访问 全部走 domain-bookmark / domain-history
places.js/Repository/Map 三路径 只允许 domain 内有 1 条路径

V08 IPC send/sendSync/invoke 裸调用:
grep -rn "ipcRenderer\." preload/ apps/ ui/ ==0
(除了 infra-ipc/TypedIpcRenderer.js 内部)
grep -rn "ipcMain\.(on|handle)\s*(" apps/ domain/ ==0
(除了 infra-ipc/TypedIpcMain.js 内部)

V09 7种存储无统一抽象:
fs.writeFileSync(.*settings.json 直接写调用 ==0
(全部走 domain-settings / infra-storage JsonStore)

V10 window.ipc 裸暴露:
grep -rn "contextBridge\.exposeInMainWorld.*ipc" preload/ ==0
只允许 exposeInMainWorld('flow', {...4层API}) 对象

V11 settings 扁平裸key无namespace:
SELECT COUNT(_) FROM settings WHERE key NOT GLOB '_.*' => ===0
(所有 key 必须有至少一个点 命名空间)

11项 全0通过 = P0 根除 质量闸 没过 不允许进入S9

=========================================
6.3 回滚策略 (3层防线)
=========================================

--- 防线1: 应用级回滚 (无需卸载) ---
启动器参数:
Hira.exe --rollback-to-v750
→ 执行: 1. 关闭 NG 所有窗口 2. 将 NG hira.db 重命名 hira.db.rollback.bak 3. 将原 settings.json.bak.7.5.0 / JsonStore.bak / IndexedDB 备份
还原回原位置 4. 重启 原系统版本 (双轨并行期保留旧exe)
→ 整个过程 < 10s

--- 防线2: 模块级回滚 (不用退整个系统 只退有问题的模块) ---
hira module rollback <module-id> <version>
→ 从 package.version store 拉取指定版本模块 热替换 重启模块
→ 例: domain-bookmark 1.2 出问题 回滚到 1.1 其他模块不动

--- 防线3: 安装级回滚 (Windows Installer) ---
控制面板 → 卸载 Hira NG → 旧版 Hira v7.5.0 仍然保留在 Program Files
→ 旧版 userData 从未被删除 打开旧版直接回到升级前状态
(关键: 原 Hira 与 NG 使用不同 userData 目录 直到用户明确 "确定迁移")

三重防线确保: 最坏情况 10 分钟内回到熟悉的旧系统 无任何数据损失

=========================================
附录 A: 完整文档索引 (docs-ng/)
=========================================

| #   | 文件                                  | 行数 | 核心内容                                                                                                    |
| --- | ------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| A1  | PART1-全库耦合检测矩阵.md             | 157  | 400文件统计 81window/80global全局变量 7存储 259IPC 6构建 187DOM耦合 11P0列表                                |
| A2  | PART2-RT现代化架构抽取.md             | 272  | electron-vite Flow API 4层20域 Drizzle6表 Schema Controller/Modules/Saving三层 React层 可学习vs不可学习清单 |
| A3  | PART3-NG四层架构设计与Monorepo清单.md | 504  | 4层严格依赖图 IHiraModule统一接口 Monorepo 43包 依赖矩阵 Linter黑名单规则                                   |
| A4  | PART4-统一存储SQLite-Drizzle设计.md   | 437  | 5组20+表完整Schema(settings/tabs/bookmarks/downloads/ui) 8适配器迁移 事务保证 备份策略                      |
| A5  | PART5-双轨开发10阶段路线图.md         | 312  | S0-S9 10阶段 5个月 里程碑验收 S9 30项最终发布闸                                                             |
| A6  | PART6-风险验证回滚附录.md (本文件)    | xxx  | 15风险矩阵 11P0根除验证命令 3层回滚策略 B C D E 附录                                                        |

=========================================
附录 B: 8 个历史 bug 场景 NG 预防说明
=========================================

(对应 S3-1 验证)

BUG-ID 旧系统问题 NG 怎么防止
B-001 bookmarks.folderId undefined 散落3处key bookmarks C3表 folder_id NOT NULL + DB级约束 不可能为NULL
B-002 删除文件夹 子文件夹不删 产生孤儿 deleteFolderCascade 递归事务 包含子孙 bookmarks+folders 全删或全不删
B-003 把父文件夹 移到 子文件夹下 (环) isDescendantFolder() 检测 + DB级trigger 环不允许写入
B-004 重排 UPDATE N行 性能差 + 多窗口不一致 fractional indexing REAL order 仅改1行 + SQLite写锁事务
B-005 多窗口侧栏固定顺序不一致 pinned_order UPDATE 事务 + CrossWinSyncer 细粒度广播
B-006 改一个 settings 所有 UI 抖动 (231 listen) settings.watch(pattern) 只触发订阅了该namespace的组件 平均<2 cb
B-007 settings.browserExtensions 与profileExtMap双写 extensions D2表 UNIQUE(profile, ext_id) 单一写路径 不可能不一致
B-008 下载进度条 暂停后还继续动 恢复后大小不变 DownloadTask 状态机 原子性: PAUSED状态下 绝对不执行received_bytes+=

=========================================
附录 C: 原系统 => NG 模块映射 (每个旧文件在哪里)
=========================================

--- 构建 ---
scripts/buildMain.js, buildBrowser.js, buildPreload.js -> 删除 替换 electron.vite.config.js
scripts/buildBrowserStyles.js, buildIndexHtml.js -> 删除

--- 主进程 ---
main/main.js + 72文件 平铺开 -> Controller + Modules + Saving 三层
windowManagement.js / windowLifecycle.js -> infra-window/WindowFactory + Lifecycle
appEvents.js / quitHandler.js -> infra-plugin Lifecycle hooks
remoteActions.js (含 _invokeHandlers!) -> 删除 (domain IPC 走正常链路)
filtering.js + permissionManager.js -> domain-permission
download.js + multiConnectionDownloader.js -> domain-download
extensionInit.js / extensionStore.js -> domain-extension
adblocker.js -> infra-modules/content-blocker
25 个 main/ipc/_.js -> infra-ipc contracts + domain._.zod handlers

--- 渲染进程 (最大重灾区) ---
js/default.js (全局变量挂载源头) -> 删除! infra-l10n/infra-platform 各自封装
window.tabs = new TabList -> domain-tabs ITabList (PluginRegistry.getApi)
window.ipc = electron.ipcRenderer -> 删除! 只 flow.* API
window.electron / fs / EventEmitter -> 删除! 提供对应infra模块
window.throttle/debounce/empty -> shared-utils 函数库 import
js/tabState.js + tabState/_.js -> domain-tabs 100% 重写
js/webviews.js (1300行) -> ui-webviews WebviewContainer
places.js / placesSearch.js / database.js -> domain-bookmark + domain-history (主进程 SQLite)
places/bookmarkRepository.js -> domain-bookmark 服务内
places/placesService.js (27 window.xxx =) -> 删除! 改为单一服务暴露
downloadManager.js -> ui-download-manager + domain-download
util/settings/_.js (4文件) -> domain-settings + infra-db settings表
profileStore.js (深拷贝对象模式) -> domain-profile (SQLite A1+A2表)
navbar/_.js (15个文件) -> ui-tabbar + ui-navbar
taskOverlay/_.js (16文件) + panels/ 8个面板 -> ui-taskoverlay + 8 独立 ui-panel-* 包
searchbar/_.js (12个插件) -> ui-searchbar 每个插件独立文件
passwordManager/_.js (4后端) -> domain-password IPasswordBackend ×4
util/database.js (Dexie IndexedDB) -> 删除! 由 infra-db SQLite + domain-* 替代
util/jsonStore.js -> infra-storage JsonStore 升级版
util/theme.js -> infra-theme
util/searchEngine.js -> shared-utils
127个文件 全部 映射到 43 包中 无遗漏

--- CSS 样式 ---
css/_.css (31个文件) 拼接 bundle.css -> shared-ui-tokens + 各UI包 scoped.css
base.css -> ui-common/styles/base.css
tabBar.css / webviews.css / searchbar.css -> ui-tabbar/ui-webviews/ui-searchbar 各自包内css
taskOverlay/panels/_.css (14) -> 8个 ui-panel-* 包内 各自独立

--- 页面窗口 ---
pages/app/parts/_.part (22个 HTML 片段) -> 删除 由 Web Components 挂载 (无需拼接)
pages/26 独立子窗口/_ -> app-subwindows/entries/* 自动路由
28 种子窗口 各自 BrowserWindow.create -> infra-window WindowFactory(type) 统一

=========================================
附录 D: IHiraModule 示例实现 (最小可运行)
=========================================

这是 domain-bookmark 的最小骨架 (给执行时做参考模板):

// packages/domain-bookmark/src/index.js
// @ts-check
const { z } = require('zod')
const bookmarkSchema = require('./schema.js')

/** @implements {IHiraModule} */
const BookmarkModule = {
id: 'domain-bookmark',
version: '1.0.0',
layer: 'domain',
dependencies: ['infra-db', 'infra-logger', 'infra-ipc'],
tags: ['core'], // core 不可卸载

async install(ctx) {
const { db, logger } = ctx.infra
// drizzle 迁移确保表存在
await db.runMigrations('bookmark-module-v1')
// 注册 IPC 契约 (TypedIpcMain强制Zod)
await ctx.typedIpc.registerContract({
channel: 'domain.bookmark.list',
request: z.object({ folderId: z.string() }),
response: z.array(bookmarkSchema),
handler: (req, caller) => this.provides.listFolder(req.folderId),
})
logger.info(`[${this.id}] installed ok`)
},

async start(ctx) {
// 订阅 profile 切换事件: 缓存清空
ctx.onEvent('domain.profile.changed', (pid) => this._invalidateCache(pid))
},

async stop(ctx) {
this._cache.clear()
},

async uninstall(ctx) {
// 用户卸载模块时才会被调用 清表
await ctx.infra.db.exec('DROP TABLE IF EXISTS bookmarks_folders_fts')
},

healthCheck() {
try {
const count = this.provides.countAll()
return { ok: true, score: 100, errors: [], stats: { count } }
} catch (e) {
return { ok: false, score: 30, errors: [e.message] }
}
},

provides: {
listFolder: (folderId) => { /* 查 C3/C4 表 _/ },
createBookmark: (url, title, folderId) => { /_ SQLite 事务 _/ },
createFolder: (name, parentId) => { /_ UNIQUE + 环检测 _/ },
moveToFolder: (ids, folderId) => { /_ 跨域事务 + fractional order _/ },
deleteFolderCascade: (folderId) => { /_ 递归事务 + 回收站 _/ },
searchBookmarks: (text) => { /_ FTS5 C5 */ },
// 共 11 个用例对应函数
}
}

module.exports = BookmarkModule

=========================================
附录 E: 常用操作速查表 (执行时用)
=========================================

E.1 启动命令
pnpm install # 安装 monorepo 所有包
pnpm -F @hira/infra-db test # 跑单个包测试
pnpm dev # electron-vite 开发模式 热更新
pnpm build # 类型检查 + electron-vite build + 迁移脚本
pnpm typecheck // @ts-check + zod 覆盖检查
pnpm migrate:generate # drizzle-kit generate: SQL 迁移脚本
pnpm migrate:apply # 对本地测试 db 应用迁移
pnpm migrate:test:from-v750 # 跑 S8 4 数据集迁移
pnpm test:ui-snapshot # 跑 UI 像素对比 100 状态
pnpm test:crash-inject # S9-2 崩溃注入 43模块 × 100 次
pnpm build:win # electron-builder 打包 NSIS 安装包

E.2 模块操作 (运行时 REPL 或 命令)
hira module list
hira module health
hira module stop ui-panel-notes
hira module start ui-panel-notes
hira module restart domain-bookmark
hira module deps domain-bookmark # 查依赖图 为什么被加载
hira module rollback ui-tabbar 1.0.1 # 回滚模块版本

E.3 诊断命令
hira doctor # 11项 P0 根除验证 + UI 像素对比基线 + DB 完整性 # 输出 Doctor Score 0-100 分 <80 不建议发版
hira perf startup # 冷启动火焰图
hira perf ui --duration 60 # 60s UI FPS 与 卡顿统计
hira db integrity # 100 条完整性 SQL 检查
hira settings audit # settings 扁平 key / 脏键 / 未映射 key 报告
hira ipc audit # 80+ IPC 通道 Zod schema 覆盖率报告 # 列出所有 无schema通道 (必须是0)

---

- END -
  STAR Hira NG 规划 PART6 完成
  完整 6 份文档: PART1~PART6 总计 2000+ 行
  涵盖: 全量扫描 / RT分析 / 架构设计 / 存储设计 / 执行路线 / 风险验证
