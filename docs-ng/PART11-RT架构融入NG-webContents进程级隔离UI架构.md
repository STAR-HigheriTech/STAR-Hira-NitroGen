# STAR Hira NG · PART 11

## RT webContents 架构融入 NG：UI 进程级隔离 + 面板热重启 + 标签独立渲染

## —— 从 DOM 单进程 UI 到 webContents 多进程 UI 的架构升级

生成时间: 2026-09-04
前置: PART2 (RT 架构抽取) + PART3 (4 层架构) + PART7 (插件系统) + PART8 (执行计划) + PART10 (CONTRACT)

> ⚠️ 本文件是对 PART3/PART7/PART8 的架构增强补充，不是替代。
> 当本文件与 PART3/PART7/PART8 原文冲突时，以本文件为准（因为原文写在 PART11 之前）。
> CONTRACT 20 条不受影响——RT 架构强化了 C06（WindowFactory 唯一入口）和 C07（面板骨架前置依赖）。

> **⚠️ 状态更新（2026-09）**：本文「类型 A：UI Shell = 独立 WebContentsView」的模型已被 **PART12 的 P1 chrome 归一**取代 —— NG 现用 `infra/infra-window/src/ChromeView.js` 把 `win.webContents` 作为 chrome 基座（`createUiShell()` 返回 `ChromeView` 假视图，不再创建独立 `uiShellView`；窗口本体天然铺满、位于所有子视图之下）。类型 B（独立 Panel webContents）与类型 C（独立 Tab WebContentsView）仍然有效。

---

=========================================
11.0 为什么要融入 RT webContents 架构（一句话 + 5 条理由）
=========================================

一句话：旧 Hira 全部 UI（标签栏/导航栏/8 面板/webview）都在同一个 renderer 进程的 DOM 里 → 一个面板 JS 报错可能导致整个浏览器 UI 挂掉 → 和 CONTRACT「模块崩溃自动禁用不影响整体」矛盾。

5 条理由：

理由 1：进程级隔离 > DOM 级隔离
旧方案 ErrorBoundary 在同进程内捕获异常 → 如果异常发生在 DOM 渲染循环中（比如 Tab 列表渲染时 throw），ErrorBoundary 可能也挂。
RT 方案：每个面板 = 独立 webContents = 独立进程 → 面板进程崩溃不影响 UI shell / 其他面板 / 网页内容。

理由 2：面板热重启天然实现
旧方案：面板插件崩溃 → DOM 删了重建 → 状态全丢 + 可能连环触发其他依赖该 DOM 的模块。
RT 方案：面板 webContents.dispose() + 重新 createWebContents + reload → 面板从干净状态重启，其他面板无感知。

理由 3：CONTRACT-07 天然落地
side-panel-skeleton 的 install() 创建 8 个 panel webContents → 面板插件 mount 到 skeleton 分配的 webContents → 不装 skeleton = 没有 webContents = 面板物理上无法挂载。

理由 4：标签页更安全
旧方案：`<webview>` 标签嵌在 renderer DOM 里 → webview 的 preload 和 renderer 共享部分上下文。
RT 方案：每个 tab = 独立 WebContentsView → 网页进程和 UI 进程完全隔离 → 网页崩溃不拖 UI。

理由 5：和 Provider-Service 架构互补不冲突
面板间通信 = 强制走 Provider IPC（因为不同进程不能直接调） → 物理强制了「面板不直接调面板」的架构约束 → 比靠 Linter 规则更可靠。

=========================================
11.1 RT webContents 架构全图（NG 版）
=========================================

┌──────────────────────────────────────────────────────────────────────────┐
│ BrowserWindow (主窗口物理容器) │
│ ┌─ WindowFactory 创建 ──────────────────────────┐ │
│ │ 1 个 BrowserWindow + 安全 webPreferences 模板 │ │
│ └────────────────────────────────────────────────┘ │
│ │
│ ┌─ WebContentsManager 管理三类 webContents ─────────────────────────┐ │
│ │ │ │
│ │ 类型 A：UI Shell webContents（1 个，永远存在） │ │
│ │ ┌────────────────────────────────────────────────┐ │ │
│ │ │ 渲染: 标签栏 + 导航栏 + 搜索栏 + 侧栏 rail 容器 │ │ │
│ │ │ preload: @hira-ng/shell-preload.js │ │ │
│ │ │ 职责: UI 骨架渲染 + 用户事件捕获 + 调用 Provider │ │ │
│ │ │ 崩溃: UI shell 挂 = 整个窗口挂（但网页面板不受影响）│ │ │
│ │ │ 热重启: 不支持（UI shell 是主壳，重启 = 窗口重启）│ │ │
│ │ └────────────────────────────────────────────────┘ │ │
│ │ ↑ setBounds(layout) │ │
│ │ 类型 B：Panel webContents（0~~8 个，按需创建/销毁） │ │
│ │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │ │
│ │ │ 收藏面板 │ │ 历史面板 │ │ 下载面板 │ │ 扩展面板 │ ... │ │
│ │ │ webContents│ │ webContents│ │ webContents│ │ webContents│ │ │
│ │ │ 独立进程 │ │ 独立进程 │ │ 独立进程 │ │ 独立进程 │ │ │
│ │ │ preload: │ │ preload: │ │ preload: │ │ preload: │ │ │
│ │ │ panel- │ │ panel- │ │ panel- │ │ panel- │ │ │
│ │ │ preload │ │ preload │ │ preload │ │ preload │ │ │
│ │ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │ │
│ │ 崩溃: 单个面板挂 → 其他面板 + UI shell + 网页 都不受影响 │ │
│ │ 热重启: webContents.reload() 或 dispose()+重建 → 面板从干净状态恢复 │ │
│ │ │ │
│ │ 类型 C：Tab webContents（0~~N 个，标签页数 = webContents 数） │ │
│ │ ┌──────────┐ ┌──────────┐ ┌──────────┐ │ │
│ │ │ Tab 1 │ │ Tab 2 │ │ Tab 3 │ ... │ │
│ │ │ 网页内容 │ │ 网页内容 │ │ 网页内容 │ │ │
│ │ │ 独立进程 │ │ 独立进程 │ │ 独立进程 │ │ │
│ │ │ preload: │ │ preload: │ │ preload: │ │ │
│ │ │ tab- │ │ tab- │ │ tab- │ │ │
│ │ │ preload │ │ preload │ │ preload │ │ │
│ │ └──────────┘ └──────────┘ └──────────┘ │ │
│ │ 崩溃: 单个网页挂 → 其他标签 + UI + 面板 全部不受影响 │ │
│ │ 热重启: webContents.reload() → 网页重新加载 │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ │
│ WebContentsView attach: 每个 webContents 通过 WebContentsView 附加到 │
│ BrowserWindow.contentView，用 setBounds 布局（不是 <webview> 标签！） │
│ │
│ 通信: 全部走 IPC → Provider-Service 洋葱（CONTRACT-04 Zod 契约强制） │
└──────────────────────────────────────────────────────────────────────────┘

=========================================
11.2 三类 webContents 详细规格
=========================================

--- 类型 A：UI Shell webContents
创建者: infra-window/WebContentsManager.createUiShell()
创建时机: WindowFactory.createMainWindow() 内，BrowserWindow 创建后立即创建
preload: packages/infra-window/src/preload/shell-preload.js
contextBridge 暴露: window.hira = { provider: ProviderProxy, on: EventProxy }
（ProviderProxy = 通过 IPC 调用主进程 Provider Service 的代理对象）
加载内容: app-shell/index.html → 加载 ui-tabbar + ui-navbar + ui-searchbar + ui-taskoverlay(rail 容器)
生命周期: 和 BrowserWindow 同生命周期，不单独销毁
崩溃处理: 如果 UI shell 崩溃 → 主进程监听 'render-process-gone' → 提示用户 + 重建窗口
bounds: 占满 BrowserWindow contentView 全部区域，Panel/Tab webContents 覆盖在上方

★ UI Shell 不再是「什么都往里塞的 renderer」
UI Shell 只负责：标签栏 + 导航栏 + 搜索栏 + 侧栏 rail 容器 + 布局协调
面板内容、网页内容 都不在 UI Shell 的 DOM 里 → UI Shell 轻量、不会因为面板 bug 挂

--- 类型 B：Panel webContents
创建者: side-panel-skeleton 插件 install() → 调用 WebContentsManager.createPanel(id)
创建时机: side-panel-skeleton 启动时预创建 0 个（按需），面板插件 mount 时创建
preload: packages/infra-window/src/preload/panel-preload.js
（和 shell-preload 相同的 ProviderProxy，但权限可能更受限）
加载内容: panels/{panel-id}/index.html → 加载对应面板插件 UI
生命周期:
mount: WebContentsView 附加到 BrowserWindow contentView，setBounds 到侧栏展开区
unmount: WebContentsView 从 contentView 移除，webContents 保持存活（下次展开快）
destroy: 面板插件卸载时 dispose() → 彻底销毁
崩溃处理: 'render-process-gone' → WebContentsManager 自动 dispose + 重建 + 通知 skeleton
热重启: 面板插件 stop() + start() → webContents.reload() → 面板从干净状态恢复
bounds: 由 side-panel-skeleton 根据展开状态 setBounds

★ 面板插件不再「共享 renderer」
每个面板 = 独立进程 → 面板 A 的内存泄漏不影响面板 B → 面板 A 的 JS 异常不影响 UI shell
这就是 CONTRACT-07 的物理落地：skeleton 创建 webContents → 面板挂载 → 不装 skeleton = 无 webContents = 面板物理上无法运行

--- 类型 C：Tab webContents
创建者: domain-tabs 的 TabService.createTab() → 调用 WebContentsManager.createTab(tabId)
创建时机: 用户新建标签 / 恢复标签 / 窗口打开第一个标签
preload: packages/infra-window/src/preload/tab-preload.js
（暴露 ProviderProxy + webview 特有的 navigation/audio/gesture API）
加载内容: 用户输入的 URL / about:blank / about:newtab
生命周期:
create: 创建 webContents + WebContentsView attach 到 contentView
active: setBounds 到主内容区（覆盖 UI shell 的标签栏下方）
background: setBounds 到 0x0 或移出可视区（保持存活，不渲染但不销毁）
close: webContents.destroy() → 从 TabService 移除
崩溃处理: 'render-process-gone' → 通知 domain-tabs 显示崩溃页 → 用户可重新加载
热重启: webContents.reload() → 重新加载当前 URL
bounds: 由 domain-tabs + WindowFactory 协调 setBounds

★ 不再用 `<webview>` 标签
`<webview>` 是 Electron 的渲染层 API，webContents 还是挂在 renderer 进程下
RT 方案: WebContentsView = 主进程级别直接管理 → 更强的隔离 + 更精确的 bounds 控制
这和旧 Hira 的 `<webview>` 行为差异：- 用户层面完全一样（网页能正常加载、导航、交互）- 开发层面更好（主进程直接管 webContents lifecycle，不走 renderer 间接层）- PART8 UI 像素保真不影响（网页内容区域的像素由 webContents 自己渲染，pixelmatch 不检查网页内容）

=========================================
11.3 WebContentsManager 完整接口设计（infra-window 包增强）
=========================================

infra-window 包在 PART3 §3.3 基础上增加 WebContentsManager：

```
// packages/infra-window/src/WebContentsManager.js

/**
 * @ts-check
 * WebContentsManager - 管理三类 webContents 生命周期
 * 唯一入口：所有 webContents 创建/销毁/布局 必须经过本类
 * 违反 CONTRACT-06 的直接 new BrowserWindow() 一样，
 *   直接 session.defaultSession.createWebContents() 也不允许
 */

class WebContentsManager {
  constructor(window, pluginRegistry) {
    this.window = window          // BrowserWindow 宿主
    this.pluginRegistry = pluginRegistry
    this.uiShell = null          // 类型 A
    this.panels = new Map()      // 类型 B: panelId -> { webContents, view, state }
    this.tabs = new Map()        // 类型 C: tabId -> { webContents, view, state }
    this._layoutDirty = true
  }

  // ─── 类型 A：UI Shell ───────────────────────────────
  async createUiShell() {
    // 创建 UI shell webContents + WebContentsView
    // preload: shell-preload.js (ProviderProxy)
    // loadURL: app-shell/index.html
    // attach 到 BrowserWindow contentView 最底层
    // setBounds 占满全屏（面板和标签覆盖在其上方）
  }

  getUiShell() { return this.uiShell }

  // ─── 类型 B：Panel webContents ─────────────────────
  async createPanel(panelId, options) {
    // 创建面板 webContents
    // preload: panel-preload.js
    // loadURL: panels/{panelId}/index.html
    // 创建 WebContentsView 但先不 attach（等 side-panel-skeleton 决定布局）
    // 返回 { webContents, view } 给 side-panel-skeleton 管理
  }

  showPanel(panelId) {
    // attach WebContentsView 到 contentView
    // setBounds 到侧栏展开区域
  }

  hidePanel(panelId) {
    // detach WebContentsView（webContents 保持存活）
  }

  destroyPanel(panelId) {
    // webContents.destroy() + 从 Map 移除
  }

  reloadPanel(panelId) {
    // webContents.reload() — 面板热重启
  }

  // ─── 类型 C：Tab webContents ───────────────────────
  async createTab(tabId, options) {
    // 创建标签 webContents
    // preload: tab-preload.js
    // 创建 WebContentsView attach 到 contentView
    // loadURL: options.url || 'about:blank'
  }

  activateTab(tabId) {
    // setBounds 到主内容区（覆盖 UI shell 标签栏下方）
    // 其他 background tabs setBounds 到 {x:0,y:0,w:0,h:0} 隐藏
  }

  destroyTab(tabId) {
    // webContents.destroy() + 从 Map 移除
  }

  // ─── 布局协调 ─────────────────────────────────────
  setLayout(layout) {
    // layout = { shell: {x,y,w,h}, panelArea: {x,y,w,h}, tabArea: {x,y,w,h} }
    // 分别 setBounds 三类 webContents 的 WebContentsView
    // 在 window resize / panel expand/collapse / zen mode 切换 时调用
  }

  // ─── 崩溃处理 ─────────────────────────────────────
  _onRenderProcessGone(webContents, details) {
    // 判断是 UI shell / panel / tab
    // UI shell 崩 → 通知 WindowFactory 重建窗口
    // Panel 崩 → 通知 side-panel-skeleton + 自动重建
    // Tab 崩 → 通知 domain-tabs + 显示崩溃页
  }

  // ─── 清理 ─────────────────────────────────────────
  destroy() {
    // 窗口关闭时：逐个 destroy 所有 webContents → 释放资源
  }
}
```

=========================================
11.4 对 PART3 4 层架构的影响（infra-window 包增强）
=========================================

PART3 §3.3 infra-window 包原内容：
WindowFactory.js / WindowTemplate.js / WindowRegistry.js / WindowLifecycle.js / ViewManager.js

PART11 更新后 infra-window 包：
WindowFactory.js # 唯一 BrowserWindow 创建入口（不变，但内部调 WebContentsManager）
WindowTemplate.js # 标准 webPreferences 模板（不变）
WindowRegistry.js # 窗口注册表（不变）
WindowLifecycle.js # 统一 show/hide/destroy（不变，但 destroy 时先清 WebContentsManager）
WebContentsManager.js # ★新增：三类 webContents 生命周期 + 布局 + 崩溃处理
preload/
shell-preload.js # ★新增：UI shell 的 contextBridge (ProviderProxy)
panel-preload.js # ★新增：面板的 contextBridge (ProviderProxy, 可能权限受限)
tab-preload.js # ★新增：标签页的 contextBridge (ProviderProxy + webview API)
LayoutCoordinator.js # ★新增：协调 shell/panel/tab 的 setBounds 布局
（在窗口 resize / 面板展开 / zen mode 切换时计算各区域 bounds → 调 WebContentsManager.setLayout）

依赖关系不变（CONTRACT-11 4 层方向不受影响）：
infra-window 仍然在 INFRA 层 → DOMAIN 层调它（domain-tabs 调 WebContentsManager.createTab）
UI 层不直接调 WebContentsManager → 通过 DOMAIN 层的 Provider 间接调用

=========================================
11.5 对 PART7 插件系统的影响（3 处改动）
=========================================

--- 改动 1：CORE 插件 C2 infra-window 增强
原 PART7 §7.2 C2:
C2 infra-window: BrowserWindow / View 管理 + window-factory EP
更新后:
C2 infra-window: BrowserWindow + WebContentsManager 三类 webContents 管理 + window-factory EP + webcontents-lifecycle EP
install() 增强: 创建 WebContentsManager 实例 → 暴露 getWebContentsManager() 给上层
暴露新 Extension Points:
EP: webcontents.panel-created (面板 webContents 创建后触发)
EP: webcontents.panel-destroyed (面板 webContents 销毁前触发)
EP: webcontents.tab-created (标签 webContents 创建后触发)
EP: webcontents.tab-destroyed (标签 webContents 销毁前触发)

--- 改动 2：CORE 插件 C7 harness-ui-core 增强
原 PART7 §7.2 C7:
C7 harness-ui-core: DOM 挂载点 + web-component 注册中心
更新后:
C7 harness-ui-core: UI Shell webContents 加载 + web-component 注册中心 + shell-layout EP
install() 增强:
① 调用 C2 的 WebContentsManager.createUiShell() 创建 UI shell webContents
② UI shell 加载 app-shell/index.html → 内含 ui-tabbar + ui-navbar + ui-searchbar + ui-taskoverlay(rail 容器)
③ 注册 shell-layout EP（让其他插件可以影响 UI shell 布局：标签栏高度/导航栏宽度等）
暴露新 Extension Points:
EP: shell.layout-slot (UI shell 布局插槽 — rail 容器宽度/标签栏高度等)
EP: shell.component-mount-slot (UI shell 内挂载额外组件的位置)

--- 改动 3：side-panel-skeleton (P01) 增强
原 PART7 §7.3 P01:
P01 side-panel-skeleton: 渲染左侧 rail 容器 + 侧边栏展开区域 DOM 骨架
更新后:
P01 side-panel-skeleton: 创建面板 webContents 池 + 管理 panel layout + rail 容器
install() 增强:
① 从 C2 获取 WebContentsManager
② 不预创建面板 webContents（按需创建，节省内存）
③ 注册 rail 图标管理逻辑（在 UI shell 的 rail 容器内渲染图标）
④ 暴露 Panel API:
createPanelWebContents(panelId) → 调 WebContentsManager.createPanel()
showPanel(panelId) → WebContentsManager.showPanel() + LayoutCoordinator 布局
hidePanel(panelId) → WebContentsManager.hidePanel() + LayoutCoordinator 布局
reloadPanel(panelId) → WebContentsManager.reloadPanel() ← 面板热重启
⑤ 监听 webcontents.panel-destroyed EP → 清理面板注册
暴露 Extension Points (不变，但实现改为 webContents 方式):
EP1: side-panel.rail-icon-slot (在 UI shell 的 rail 容器注册图标)
EP2: side-panel.panel-render-slot (注册面板 → skeleton 调 createPanelWebContents 创建 webContents → 加载面板 index.html)
EP3: side-panel.toolbar-action-slot (面板 webContents 内的工具栏加按钮)

→ 面板插件（P02~P09）的 dependsOn 不变：仍然 dependsOn [P01 side-panel-skeleton]
→ 面板插件 mount 时：skeleton 调 createPanelWebContents → 面板 UI 在独立 webContents 渲染
→ 面板插件 unmount 时：skeleton 调 hidePanel → webContents 存活但不显示
→ 面板插件崩溃时：webContents 'render-process-gone' → skeleton 自动重建
→ 面板插件热重启时：stop() → reloadPanel() → start()

=========================================
11.6 对 PART8 执行计划的影响（Day3 + Week3-4 改动）
=========================================

--- PART8 Day3 改动（§8.0 Day3 Step 6~8）
原 Day3: 6. 实现 infra-plugin/src/PluginRegistry-minimal.js 7. 实现 infra-window/WindowFactory.js (只做 createMainWindow + 最小安全 webPreferences) 8. 跑起来: pnpm dev → 空白窗口显示 "Hira NG v0.0.1"

更新后 Day3: 6. 实现 infra-plugin/src/PluginRegistry-minimal.js（不变）7. 实现 infra-window/WindowFactory.js + WebContentsManager.js
WindowFactory.createMainWindow():
① 创建 BrowserWindow（安全 webPreferences 模板）
② const wcm = new WebContentsManager(window, pluginRegistry)
③ wcm.createUiShell() → 创建 UI shell webContents → 加载 app-shell/index.html
④ LayoutCoordinator 初始布局：shell 全屏，panel/tab 区域 0x0
三个 preload 文件骨架:
shell-preload.js: contextBridge 暴露 window.hira = { provider: {}, on: {} } (空壳)
panel-preload.js: 同上（空壳，后续 Week5 填充）
tab-preload.js: 同上（空壳，后续 Week4 填充）8. 跑起来: pnpm dev → BrowserWindow 内 UI shell webContents 显示 "Hira NG v0.0.1"
★ 不再是 renderer 直接渲染空白页，而是 UI shell webContents 渲染空白页
★ 验证 WebContentsView attach + setBounds 正常

--- PART8 Week3-4 增强（新增 "RT webContents 骨架" 任务）
原 Week3-4: 核心 DOMAIN 实现 (domain-tabs / domain-bookmark)
增强 Week3-4 新增任务:
W3-D1: WebContentsManager 完整实现 - createPanel / showPanel / hidePanel / destroyPanel / reloadPanel - createTab / activateTab / destroyTab - _onRenderProcessGone 崩溃处理 - 基础布局 LayoutCoordinator: shell + panel + tab 三区域 setBounds
W3-D2: UI Shell preload 填充 - shell-preload.js: contextBridge 暴露 ProviderProxy（通过 IPC 调主进程 Provider）- 验证 UI shell webContents 能通过 ProviderProxy 调到 domain-tabs 的 mock
W3-D3: Panel preload + 第一个 mock 面板验证 - panel-preload.js: 同 ProviderProxy - 创建一个 mock 面板 webContents → 验证它能独立渲染 + 独立崩溃不影响 UI shell - 验证 reloadPanel() 热重启
W4-D1: Tab preload + 第一个 mock 标签验证 - tab-preload.js: ProviderProxy + navigation/audio 基础 API - 创建一个 mock tab webContents → 加载 https://example.com → 验证独立渲染 - 验证 activateTab setBounds 切换 + 标签崩溃不影响 UI shell
W4-D2: LayoutCoordinator 完整布局 - 窗口 resize 时 shell/panel/tab 三区域自动重布局 - 面板展开/收起时 panel 区域 bounds 变化 - Zen mode 切换时布局变化

--- PART8 里程碑影响
M0 空壳版（W2末）: 验收标准改为
原: 空白窗口显示标题
新: BrowserWindow 内 UI shell webContents 显示标题 + WebContentsView attach 正常 + DRM 验证
M1 最小可用（W6末）: 验收标准改为
原: 标签栏 + 导航栏骨架
新: UI shell webContents 渲染标签栏+导航栏 + 第一个 tab webContents 能加载网页 + 标签崩溃不影响 UI

=========================================
11.7 对 CONTRACT 的影响（0 条违反 + 2 条强化）
=========================================

| CONTRACT                    | 影响      | 说明                                                          |
| --------------------------- | --------- | ------------------------------------------------------------- |
| C01 不重写 A 档库           | ✅ 不影响 | RT webContents 是 Electron 原生 API，不是 npm 库              |
| C02 UI 快照 ≥95%            | ✅ 不影响 | pixelmatch 比对最终截图，不关心渲染进程数                     |
| C03 写功能先列 F 号         | ✅ 不影响 | 本架构改动不涉及功能点                                        |
| C04 Zod 契约                | ✅ 强化   | 面板间通信强制走 IPC = 强制 Zod 契约                          |
| C05 0 业务全局              | ✅ 强化   | 面板独立进程 = 物理不可能 window.xxx 共享                     |
| C06 WindowFactory 唯一入口  | ✅ 强化   | WebContentsManager 也是唯一 webContents 入口                  |
| C07 面板 dependsOn skeleton | ✅ 强化   | skeleton 创建 webContents = 物理前置依赖                      |
| C08~C09 行为/阈值           | ✅ 不影响 | UI 行为由 Provider 保证，不关心渲染方式                       |
| C10 扩展/拦截原库           | ✅ 不影响 | 扩展和拦截库在 tab webContents 上运行，和 UI webContents 无关 |
| C11 4 层单向依赖            | ✅ 不影响 | infra-window 仍在 INFRA 层                                    |
| C12 Provider 4 Hook         | ✅ 不影响 | Provider 在主进程，webContents 通过 IPC 调                    |
| C13 SQLite 唯一存储         | ✅ 不影响 |                                                               |
| C14 npm 三档                | ✅ 不影响 | 不新增 npm 依赖                                               |
| C15~C20                     | ✅ 不影响 |                                                               |

→ 0 条违反，2 条强化（C06/C07）。RT webContents 架构和 CONTRACT 完全兼容。

=========================================
11.8 对 UI 像素保真的影响（关键：不影响）
=========================================

担心：UI 拆成多个 webContents 后，像素还能和原版一致吗？

答案：能。原因：

1. UI shell webContents 渲染的内容（标签栏/导航栏/搜索栏/rail 容器）
   = 和原版相同的 HTML + CSS + CSS Tokens
   = pixelmatch 截图对比的是最终渲染结果，不管是在 1 个进程还是 N 个进程里渲染
   → UI shell 的快照和原版一致

2. 面板 webContents 渲染的内容（收藏/历史/下载面板）
   = 每个面板独立截图对比基线快照
   = 面板 A 的快照只对比面板 A 区域的截图
   → 面板快照和原版一致

3. Tab webContents 渲染的内容（网页）
   = 网页内容不在 UI 像素保真范围内（PART8 附录 A 100 快照不包含网页内容截图）
   → 不影响

4. 布局衔接（shell 和 panel 之间的间距/边框/圆角）
   = LayoutCoordinator 精确 setBounds 到像素级
   = 衔接处的视觉差异（比如 panel 左边框和 rail 右边框之间的 1px gap）由 CSS Tokens 保证
   → 像素一致

→ PART8 三铁律不受影响。GPT-5.2/Claude 写 UI 代码时仍然走 CSS Tokens + pixelmatch 验证。

=========================================
11.9 旧 Hira `<webview>` 标签 → WebContentsView 的行为差异表
=========================================

| 行为      | 旧 Hira `<webview>`                     | NG WebContentsView                   | 差异                 |
| --------- | --------------------------------------- | ------------------------------------ | -------------------- |
| 网页加载  | `<webview src="url">`                   | webContents.loadURL(url)             | 用户无感知差异       |
| 前进/后退 | webview.goBack()                        | webContents.navigationHistory.back() | API 变，行为一致     |
| 音频控制  | webview.setAudioMuted()                 | webContents.setAudioMuted()          | 行为一致             |
| 缩放      | webview.setZoomFactor()                 | webContents.setZoomFactor()          | 行为一致             |
| 截图      | webview.capturePage()                   | webContents.capturePage()            | 行为一致             |
| 查找      | webview.findInPage()                    | webContents.findInPage()             | 行为一致             |
| 手势      | renderer 内监听                         | tab-preload 注入 + IPC 转发          | 行为一致，实现方式变 |
| 崩溃      | renderer 内 webview crash               | 独立进程 crash → 不影响 UI           | ★更安全              |
| 进程隔离  | webview 和 renderer 共享进程上下文      | 完全独立进程                         | ★更强隔离            |
| 扩展注入  | electron-chrome-extensions 注入 webview | 注入 tab webContents                 | A 档库行为不变       |

→ CONTRACT-10（扩展 A 档原库）不受影响：electron-chrome-extensions 注入的是 tab webContents，不是 UI shell webContents

--- EOF ---
