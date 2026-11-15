# STAR Hira NitroGen

**模块化、快速、现代的 AI 浏览器。**

STAR Hira NitroGen 是一次从零重写的浏览器工程。它没有在旧版 Hira 的页面上继续打补丁，而是以新的四层架构、统一的用户数据模型、插件运行时和浏览器内 Agent Runtime 重新建立了整个产品。

当前版本：**8.0.0 正式版**

[下载 Windows 安装包](https://github.com/STAR-HigheriTech/STAR-Hira-NitroGen/releases/download/v8.0.0/STAR-Hira-NitroGen-Setup-8.0.0.exe) ·
[查看 Release](https://github.com/STAR-HigheriTech/STAR-Hira-NitroGen/releases/tag/v8.0.0) ·
[工程文档](docs-ng/README.md)

## 为什么是 NitroGen

旧版浏览器功能完整，但全局单例、字符串 IPC、分散存储和互相直接依赖的视图，让每次新增能力都可能牵动整个系统。NitroGen 解决的不是几个零散缺陷，而是重新建立了浏览器继续长大的边界：

- 业务对象不再挂在 `window` 或 `global`；
- IPC、设置键和事件名进入共享契约；
- UI、领域、基础设施与应用装配只能按固定方向依赖；
- 用户数据统一进入 SQLite + Drizzle；
- 网页、面板、侧栏和浮层拥有各自的视图语义；
- 插件通过稳定能力、声明式贡献和公共插槽接入；
- AI 使用浏览器事实、工具、审批和审计，而不是另建一套旁路。

## 核心能力

### 浏览与工作区

- 横向、纵向标签与统一标签身份模型
- 标签栈、重命名、颜色、合并、排序与持久化
- 横向、纵向及最多四格的分屏布局
- 标签拖入网页时的实时落位预览
- 多 Profile、独立 Session、独立数据库与完整设置快照
- Profile 下的多 Space 工作区
- 容器标签、MRU 切换、空间导航与专注模式
- Glance 速览、标签预览、最近关闭、PiP 与休眠恢复

### 界面与定制

- 浏览器内叠加式积木布局编辑器
- 自定义列、面板组、模板、检查器与布局 revision
- 顶部、底部、侧栏和完整侧栏布局
- 网页侧栏、独立面板、站点信息浮层与聚合总览
- 命令面板式地址栏、可扩展搜索建议与 bangs
- 新标签页小组件、新闻源、背景与快捷入口
- 插件化主题、令牌系统与跨内部页换肤

### 数据与生产力

- SQLite + Drizzle 统一持久化
- 书签、历史、下载、权限、PWA、笔记与布局数据
- 分层 Profile 数据库和可回退迁移
- 集锦、文件夹、全文搜索、Markdown 与自动保存
- DOCX、XLSX、PPTX、PDF 导出
- 浏览器一键迁移：书签、历史、自动填充、密码、Cookie 与扩展
- PWA 安装、独立应用窗口与任务栏身份
- TOTP、屏幕扫码、密码自动填充和 Office 工具

### 开放插件系统

- ProviderRegistry：能力实现与四级洋葱钩子
- ContributionRegistry：面板、页面、菜单、bangs 与用户脚本贡献
- ExtensionPointRegistry：公共插槽与多模式调度
- PanelCatalog：所有界面入口共享的运行时面板目录
- 插件依赖、权限、启停、热重载、健康检查与状态持久化
- 第三方主进程插件运行在 `utilityProcess`
- 社区插件能力按 scope 逐方法鉴权
- 插件市场、安装器、签名、SDK、脚手架与发布工具
- 当前内置 47 个官方插件 manifest

### 浏览器内 AI Runtime

- 侧栏助手与独立窗口双形态
- 用户自带 API、Base URL、协议、模型和推理等级
- 当前标签、DOM、选区、截图、收藏、历史与本地文件上下文
- 浏览器操作、本地文件、命令、Git 与办公文档工具
- turn / step、流式输出、取消、审批和审计
- SQLite 事件溯源会话与上下文压缩
- 内置、研究与业务运营技能
- AI Studio 生成功能插件、主题、用户脚本和技能
- Hira CLI 为外部 Agent 提供统一浏览器执行协议

### 安全与流畅

- 普通网页、第一方 UI、社区插件与内置页分层授权
- IPC audience 默认拒绝与窄 preload 白名单
- 原型链、目录穿越、符号链接、ZIP 资源耗尽与 SSRF 防护
- `hira://` 页面统一 CSP
- 主进程单次同步执行目标 `≤ 8ms`
- 渲染帧目标 `≤ 16.7ms`
- 声明式图层、前缀增量重排与焦点仲裁
- 视图切换优先修改可见性和 bounds，避免反复拆挂
- 用户操作首帧、闪烁、稳态抖动和空闲内存均有明确约束

## 架构

```text
┌──────────────────────────────────────────────┐
│                    apps                      │
│       应用装配、窗口、启动与进程边界         │
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────┐
│              ui              │
│  标签、导航、侧栏、面板、浮层 │
└───────────────┬──────────────┘
                │
┌───────────────▼──────────────┐
│            domain            │
│  业务规则、模型与用户数据    │
└───────────────┬──────────────┘
                │
┌───────────────▼──────────────┐
│             infra            │
│ DB、窗口、IPC、插件、安全能力 │
└──────────────────────────────┘
```

依赖规则：

- `apps` 可以依赖 `ui`、`domain`、`infra`；
- `ui` 可以依赖 `domain`、`infra`；
- `domain` 只能依赖 `infra`；
- `infra` 不包含业务规则；
- UI 不直接写数据库；
- 主进程与渲染层共享同一份类型化 IPC 契约；
- 所有业务状态只有一个 canonical 写入路径。

`packages` 提供跨层共享的类型、布局模型、布局引擎、UI token 与通用工具。

## 仓库结构

```text
.
├─ apps/                    # 主应用、设置、管理窗口与子窗口
├─ ui/                      # 36 个界面与面板包
├─ domain/                  # 19 个领域模型与服务包
├─ infra/                   # 16 个基础设施包
├─ packages/                # 共享类型、布局与工具
├─ docs/                    # 早期浏览器运行时与交互文档
├─ docs-new/                # 差距、Profile、性能与工程红线
├─ docs-ng/                 # 架构、插件、AI 与功能设计
├─ scripts/                 # 构建、检查、发布与验证工具
├─ tests/                   # 回归、UI 快照与验证夹具
├─ electron.vite.config.ts  # Electron/Vite 构建配置
├─ drizzle.config.ts        # 数据库迁移配置
└─ package.json             # workspace 根入口
```

当前工程包含约 **80 个 workspace 模块**，界面、领域和基础设施均按独立包管理。

## 本地开发

### 环境

- Node.js LTS
- pnpm `9.0.0`
- Windows 10/11 用于生成 Windows 安装包

如果本机尚未启用 Corepack：

```bash
corepack enable
```

安装依赖并启动开发环境：

```bash
pnpm install
pnpm dev
```

### 构建

```bash
pnpm build
```

生成 Windows 安装包：

```bash
pnpm pack:win
```

构建产物输出到 `dist/`。

### 常用工程命令

```bash
pnpm typecheck          # TypeScript 与多套运行环境检查
pnpm lint               # ESLint
pnpm layer:check        # 分层依赖检查
pnpm check:methods      # 方法契约检查
pnpm plugin:coverage    # 插件扩展覆盖检查
pnpm test:ui-tabbar     # 标签栏视觉回归
pnpm verify:split       # 分屏与拖拽预览验证
```

## 插件开发

内置插件位于：

```text
apps/app-main/plugins/*.hira-plugin.json
```

创建并校验一个插件：

```bash
pnpm plugin:new
pnpm plugin:validate
```

运行时插件安装在用户数据目录：

```text
userData/plugins/<plugin-id>/
```

插件可以贡献面板、内部页、菜单、搜索指令、用户脚本、主题、布局 block、AI 技能和浏览器能力实现。详细机制、生命周期、权限和 SDK 用法见：

- [插件化落地现状与扩展指南](docs-ng/插件化落地现状与扩展指南.md)
- [开放世界插件接口](docs-ng/PART18-开放世界插件接口-能力矩阵与贡献扩展点.md)
- [Harness 风格插件系统](docs-ng/PART7-DeepSeekHarness风格插件系统-功能面板全插件化与社区ModSDK.md)

## 数据与隐私

NitroGen 使用本地 SQLite 保存应用业务数据。Profile 隔离采用独立数据库和独立 Chromium Session：

```text
userData/
├─ global.db
└─ profiles/
   └─ <profile-id>/
      └─ hira-ng.db
```

- 密码与 TOTP 密钥依赖操作系统安全存储能力；
- AI 模型由用户自行配置，不内置模型额度或代充；
- 会话、页面上下文和本地文件不会因为默认配置被上传到第三方服务；
- 社区插件在独立进程或无同源 UI 中运行；
- 插件能力、事件订阅和敏感页面路由均经过 scope 检查。

## 文档

- [NG 总文档索引](docs-ng/README.md)
- [四层架构与 Monorepo](docs-ng/PART3-NG四层架构设计与Monorepo清单.md)
- [网页视图与菜单重构](docs-ng/PART12-网页视图与菜单全维度对比与重构方案.md)
- [统一存储设计](docs-ng/PART4-统一存储SQLite-Drizzle设计.md)
- [性能标准与优化手册](docs-new/11-性能标准与优化手册.md)
- [安全边界审计](docs-ng/PART18安全边界审计-2026-11.md)
- [编辑模式重构](docs-ng/编辑模式重构/README.md)
- [AI 助手引擎与双形态插件](docs-ng/PART15-NG-AI助手引擎与双形态插件完整规划.md)
- [Hira CLI 与后台浏览 Agent](docs-ng/PART20-Hira-CLI与后台浏览Agent.md)

## 开发原则

提交新能力前，至少确认：

1. 依赖方向没有反转；
2. 没有恢复 `window` / `global` 业务单例；
3. IPC、设置键和事件名来自共享契约；
4. 用户数据只有一个写入真源；
5. 新视图有明确创建、隐藏、休眠和释放路径；
6. 零散入口优先复用现有插件与面板机制；
7. 安全能力遵循默认拒绝；
8. 不留下被替代的平行实现和死代码。

## 发布

正式版发布需要包含：

- 安装包；
- `latest.yml` 自动更新清单；
- blockmap；
- 与 `package.json` 一致的版本标签；
- 正式、非草稿、非预发布的 GitHub Release。

当前发布入口：

<https://github.com/STAR-HigheriTech/STAR-Hira-NitroGen/releases>

## 反馈与安全

- Bug 与功能建议：[GitHub Issues](https://github.com/STAR-HigheriTech/STAR-Hira-NitroGen/issues)
- 安全问题：[GitHub Security Advisories](https://github.com/STAR-HigheriTech/STAR-Hira-NitroGen/security/advisories/new)

---

**STAR Hira NitroGen 8.0.0 是从零重写后的第一个正式版本。**
