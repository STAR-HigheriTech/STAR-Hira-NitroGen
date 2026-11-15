# STAR Hira NG 大换血重写规划 PART 2 - RT 现代化架构抽取 (Flow 浏览器参考)

生成时间：2026-01-03

注意: 1A-STAR_Hira_RT 基于 Flow 浏览器改造 与本项目业务无关系
本章只抽取其"架构层面可学习的现代化模式" 不直接复用代码

=========================================
2.1 RT 技术栈全清单 (package.json分析)
=========================================

--- 运行时核心 ---
Electron: castlabs/electron-releases v41.1.1+wvcus (支持Widevine DRM)
数据库: better-sqlite3 + drizzle-orm + drizzle-kit
状态/通信: arktype (类型校验) + tldts (域名解析)
广告拦截: @ghostery/adblocker-electron v2.14.1
扩展: electron-chrome-extensions + electron-chrome-web-store
WebAuthn: electron-webauthn v1.3.1 (Passkey/FIDO2支持)
自动更新: electron-updater v6.8.3
上下文菜单: electron-context-menu v4.1.2
图片处理: sharp v0.34 (favicon处理/缩略图生成)

--- 渲染层 UI ---
React 19 + react-dom 19 (函数组件 + Hooks)
TailwindCSS 4 + @tailwindcss/vite (最新零配置v4)
Radix UI (无样式基础组件 可访问性保证)
Headless UI (弹窗菜单等)
motion (Framer Motion 动画)
@tanstack/react-query v5.99 (服务端状态缓存)
cmdk (命令面板组件库)
sonner (Toast通知组件)
Lucide + Phosphor 双图标库
@pdfslick/react (PDF视图渲染)
@atlaskit/pragmatic-drag-and-drop (企业级拖拽)

--- 构建/工程化 ---
构建工具: electron-vite v5 (main/preload/renderer三处统一)
打包发布: electron-builder 26.8.1
语言: TypeScript 6.0.2 (类型系统最新)
代码规范: ESLint 9 + Prettier 3.8
路径别名: @/main -> src/main ; @/renderer -> src/renderer/src
~/ -> src/shared (跨进程共享类型)
包管理: bun 或 pnpm (显示有 bun.lock + pnpm配置双支持)

=========================================
2.2 electron-vite 统一构建 (取代6套拼接)
=========================================

源文件: 1A-STAR_Hira_RT/electron.vite.config.ts

三段式配置 每段独立 alias:
main:
alias: { "@": src/main, "~": src/shared }
externalizeDeps: [hono, objcjs-types等特殊包]
minify: esbuild (生产)

preload:
alias: 同main
externalizeDeps: [electron-chrome-extensions]

renderer:
alias: { "@": src/renderer/src, "~": src/shared }
plugins: [
react(Vite官方) + babel(react compiler预设) + tailwindcss(vite插件)
]
rollupOptions.input: { ...routes } <- 自动扫描多页面多入口

=> Hira NG 学习点 A1: electron-vite 全链路统一构建
取代 buildMain/buildBrowser/buildPreload/buildStyles/buildIndexHtml
原生ESM 别名系统 自动Tree-shaking HMR增量构建 Sourcemap
6套脚本 变 -> 1 electron.vite.config.js 搞定

=========================================
2.3 Flow API 分层设计 (contextBridge强类型暴露)
=========================================

源文件: 1A-STAR_Hira_RT/src/shared/flow/flow.ts

全局注入 flow 对象 4层 20 API域:

[APP层 系统级] (跨窗口全局功能)
flow.app - 应用事件 退出重启 版本信息
flow.windows - 窗口创建 移动 最小化 布局
flow.extensions - 扩展安装 卸载 列表
flow.updates - 自动更新检查 下载 进度
flow.actions - 全局命令执行(菜单项对应Action)
flow.shortcuts - 快捷键注册 注销 绑定管理

[BROWSER层 浏览器级] (每窗口/每标签相关)
flow.browser - 浏览器整体事件 空闲状态
flow.tabs - 标签 CRUD 排序 分组 选择 切换
flow.pinnedTabs - 固定标签 位置管理
flow.page - 页面信息 标题 URL favicon 缩放 截图
flow.navigation - 前进后退 reload stop go 导航历史
flow.omnibox - 地址栏搜索建议 bangs 自动补全
flow.newTab - 新标签页配置 默认URL
flow.findInPage - 页面内查找 高亮 上下导航
flow.history - 浏览历史查询 清理 删除
flow.interface - UI状态 侧栏 rail 任务面板开关 布局切换
flow.prompts - 页面对话框 confirm/prompt/alert
flow.passkey - WebAuthn Passkey 认证

[SESSION层 会话级] (数据隔离维度)
flow.profiles - Profile空间 创建 删除 切换 列表 配置
flow.spaces - Tab空间 分组 (与Profile区分)

[SETTINGS层 配置级] (持久化用户偏好)
flow.settings - 设置读/写/订阅 批量导入导出
flow.icons - 图标主题 颜色 自定义图标
flow.openExternal- 外部打开方式 关联程序
flow.onboarding - 首次启动引导 步骤 状态

=> Hira NG 学习点 A2: 4层20域 Flow-API 统一IPC契约

- 完全强类型 TypeScript interface (arktype/Zod 运行时校验)
- 4层严格依赖: 上层API可调用下层 下层绝对不能调用上层
- preload contextBridge 仅暴露flow对象 不暴露ipcRenderer裸对象
- 渲染进程绝对不能直接 ipc.send/invoke 只许 flow.xxx.yyy()

=========================================
2.4 Drizzle SQLite 统一 Schema 设计
=========================================

源文件: 1A-STAR_Hira_RT/src/main/saving/db/schema.ts + drizzle.config.ts

drizzle.config.ts: dialect sqlite schema src/main/saving/db/schema.ts

已实现的核心表 (6张 全部强类型 全部带索引):

1. tabs 标签页表:
   unique_id(PK) schema_version created_at last_active_at position
   profile_id space_id window_group_id
   title url favicon_url muted(bool)
   nav_history(JSON[]) nav_history_index
   -> INDEX on window_group_id

2. tab_groups 标签组表:
   group_id(PK) mode profile_id space_id
   tab_unique_ids(JSON[] string)
   glance_front_tab_unique_id position

3. window_states 窗口状态表:
   window_group_id(PK) width height x y is_popup(bool)

4. pinned_tabs 固定标签表:
   unique_id(PK) profile_id default_url favicon_url position
   -> INDEX on profile_id

5. history_urls URL去重表 (Chromium设计风格):
   id(AUTO PK) profile_id url title visit_count typed_count last_visit_time
   -> UNIQUE(profile_id, url)

6. history_visits 每次访问事实表:
   id(AUTO PK) url_id(FK->history_urls cascade)
   visit_time typed(bool)
   -> INDEX on url_id + INDEX on visit_time

=> Hira NG 学习点 A3: SQLite + Drizzle 替代 Dexie+JSON混合存储

- 数据库放主进程 渲染进程只能通过 Flow API (IPC封装) 访问
- 全部表 profile_id 维度隔离 取代settings.json内嵌profileStore
- 历史记录使用 Chromium 成熟的 URL去重 + 访问事实分离设计
- drizzle-kit generate 自动迁移脚本 取代 Dexie.upgrade
- JSON字段只存非查询的动态数组 可索引字段一律独立列

=========================================
2.5 IPC模块注册系统 (import-side-effect模式)
=========================================

源文件: 1A-STAR_Hira_RT/src/main/ipc/index.ts

仅33行 全部 import side-effect:
// App APIs
import "@/ipc/app/app"
import "@/ipc/app/extensions"
import "@/ipc/app/updates"
import "@/ipc/app/shortcuts"
// Browser APIs
import "@/ipc/browser/browser" "@/ipc/browser/tabs" ...
// Session APIs
import "@/ipc/session/profiles" "@/ipc/session/spaces"
// Settings APIs
import "@/ipc/window/settings" "@/ipc/app/icons" ...
// Special
import "@/ipc/listeners-manager" "@/ipc/webauthn"

每个 ipc/*.ts 文件内部:
ipcMain.handle('flow.tabs.get', typed_handler<FlowTabsAPI.get>(zSchema, fn))
ipcMain.on('flow.tabs.changed', typed_event(zSchema, fn))
-> 全部通过统一的 listeners-manager 注册 自动:

- 应用 Zod schema payload校验
- 错误自动捕获 日志
- window/webContents销毁时自动 off listener

=> Hira NG 学习点 A4: IPC集中注册 + 自动listener管理

- 用 import 副作用 替换 67文件build顺序数组
- 每个 handler 强制 Zod schema 校验 (不写schema不让注册)
- listeners-manager 自动生命周期 杜绝监听泄漏
- channel名 = flow.{域}.{方法} 自动生成 杜绝字符串硬编码

=========================================
2.6 Controller 层模式 (业务编排 不跨层调用)
=========================================

RT目录: src/main/controllers/*Controller

WindowsController / SpacesController / ProfilesController
AppMenuController / DefaultBrowserController / HandoffController
AutoUpdateController / PinnedTabsController / LoadedProfilesController

Controller职责:

- 订阅 IPC 请求 (Flow API入口)
- 调用 Saving层 (DB读写) + Modules层 (基础能力)
- 跨域数据组合编排 (比如切空间=写DB + 通知ViewManager更新视图)
- 不直接操作 BrowserView/webContents (那是ViewManager层职责)

Modules层 (单例基础能力):
logs, paths, queue, prompts, icons, favicons, flags, user-agent,
content-blocker, extensions, typed-event-emitter, pdf-cache

Saving层 (持久化 ORM层):
tabs, history, settings, shortcuts, pinned-tabs, onboarding, db

=> Hira NG 学习点 A5: Controller > Modules > Saving 三层主进程结构

- 取代 主进程72文件扁平平铺 (main.js 一行行import)
- Controller只编排 直接禁止互相调用 -> 杜绝global.xxx跨文件引用
- Modules无状态 纯功能 可单元测试
- Saving纯DB CRUD 无业务逻辑 DB表1对1

=========================================
2.7 渲染层架构 (React 19 + 响应式数据流)
=========================================

RT目录: src/renderer/src/

React Query (TanStack) 管服务端状态:
const tabs = useQuery({ queryKey: ['tabs'], queryFn: flow.tabs.list })
flow.tabs.onChanged(() => queryClient.invalidate(['tabs']))
-> IPC状态变化自动全UI刷新 但仅刷新依赖该query的组件 (细粒度!)

组件分层:
components/browser-ui/* - 纯展示组件 接收props不调Flow API
hooks/* - 自定义Hooks 封装Flow API调用
lib/* - 纯函数:omnibox搜索算法 URL处理 CSS工具
routes/* - 多页面路由 (PDF视图等独立页面自动生成)

CSS: Tailwind 4 零 JS配置 + @tailwindcss/vite插件
不再需要手写31个CSS文件 类名原子化 无全局冲突 无重复样式
面板之间完全独立 class-name 不会撞 (前缀已由 Tailwind utility隔离)

=> Hira NG 学习点 A6: 渲染层响应式状态管理 + 组件化
注意: 本项目约束 UI不做大改动 (要求像素对齐原外观)
所以: React/Tailwind作为选项B 选项A为 vanilla JS + Web Components
无论选哪个核心原则:

- 不允许模块直接 getElementById('#xxx') -> 必须通过组件refs
- 不允许 window.xxx 跨模块传数据 -> 必须通过 事件总线 / props
- settings.listen 广播 -> 细粒度订阅 store hook 只有依赖组件重渲染

=========================================
2.8 RT可学习 vs 不可学习清单 (重要!)
=========================================

--- 可以100%学习的 (纯架构模式 无版权问题) ---
✅ electron-vite 三段式统一构建 + alias系统
✅ Drizzle + better-sqlite3 主进程DB方案 含历史记录6表设计
✅ Flow API 4层20域分法 + contextBridge 只暴露 flow 对象
✅ IPC import-side-effect 注册 + listeners-manager 自动清理
✅ Controller/Modules/Saving 三层主进程职责划分
✅ WindowFactory 统一BrowserWindow创建 参数标准化模板
✅ typed-event-emitter 强类型事件 + Zod schema校验
✅ JsonStore 单文件存储抽象 + settings分表(不嵌settings.json)
✅ drizzle-kit 迁移系统 取代手动 schema version 升级
✅ renderer 路由自动生成 (pages/* 自动发现为 entry)

--- 需要完全不同实现的 (不能直接抄) ---
❌ React 19 + Tailwind 4 (RT是React UI 本项目要像素对齐原Min UI
技术栈不兼容 -> Hira NG 选项A: 原生JS模块化 Web Components 方案)
❌ RT的具体UI组件 (浏览器外观不同)
❌ RT的 onboarding/welcome flow 具体步骤
❌ RT的扩展具体实现细节 (我们已有 electron-chrome-extensions)
❌ RT的 omnibox 搜索算法 (我们已有 bangsPlugin + 12个 searchbar插件)
❌ RT的特定快捷键绑定 (要保留原有Min Hira快捷键习惯)
❌ RT的具体图标系统 (我们用iconfont + 自定义SVG)
