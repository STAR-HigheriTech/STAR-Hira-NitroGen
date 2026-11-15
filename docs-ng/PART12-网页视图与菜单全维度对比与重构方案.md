# PART12 · 网页视图 / 菜单 全维度对比与重构方案

> 对比对象：**NG**（`1A-STAR_Hira_NG`，四层架构 monorepo） vs **HiraRT**（`1A-STAR_Hira_RT`，Flow Browser 系） vs **旧 Hira**（`1A-STAR_Hira`，Electron `WebContentsView` 老实现）
> 结论先行：**NG 的网页视图「基座层」一开始就搭错了** —— 它把本该由「窗口自身 webContents」承担的浏览器外壳（chrome），拆成了若干独立 `WebContentsView`，而把窗口自身的 webContents 浪费在 `about:blank`。这与 Hira / HiraRT 的模型**方向相反**。本文给出证据、差异矩阵与分阶段重构方案。

---

## 0. 一句话根因（Root Cause）

|                      | 浏览器外壳（tabstrip/navbar/书签栏/侧栏/面板）由谁渲染                                      | 窗口自身 webContents                        |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **旧 Hira**          | ✅ **窗口自身 webContents**（`contentView.children[0]`，全窗口一个 renderer）               | 就是整个 chrome                             |
| **HiraRT**           | ✅ **窗口自身 webContents**（`FakeWebContentsViewLayer`，`zIndexes.browserUI = 0`，最底层） | 就是整个 chrome                             |
| **NG（初始）**       | ❌ 拆成 `ui-shell` / `rail` / `panels` 等**多个独立 WebContentsView**                       | ❌ `win.loadURL('about:blank')` —— **空转** |
| **NG（现状，已修）** | ✅ **窗口自身 webContents**（`ChromeView` 假视图，chrome 归一为窗口本体）                   | 就是整个 chrome                             |

NG 的模型是反的：**真正的网页内容（tab）反而成了「主体」，而 chrome 成了「一堆浮在窗口上的补丁 view」**。
由此派生出后续所有症状：z-order 手工 `_restack`、焦点无仲裁、IPC 广播要特判 `listChromeWebContents()`、窗口生命周期语义失真（`window-all-closed` 僵尸进程）、菜单 owner 解析绕圈、启动多起 N 个 renderer。

> **落地状态（已修复，本文其余章节保留原始诊断以作对照）**
>
> 下述缺陷已按 §4 的 P1–P4 落地修复，本节症状均已消除：
>
> - **F1（窗口 about:blank 空转）→ 已修**：`infra/infra-window/src/WindowFactory.js` 不再默认加载 `about:blank`，chrome 改由窗口自身 webContents 承载（`ChromeView`）。
> - **F2（chrome 拆成多个 view）→ 已修**：`infra/infra-window/src/ChromeView.js` 把 `win.webContents` 包装为同形「假视图」，chrome 归一为窗口本体，不再创建独立 `uiShellView`。
> - **F4（手工 `_restack`）→ 已修**：`infra/infra-window/src/LayerManager.js` + `LayerStack.js` 提供声明式 z 序 + 前缀跳过增量重排，取代全量 `_restack`。
> - **F5（无焦点仲裁）→ 已修**：`LayerStack.js` 的 `focusPriorities` / `createModalTo` + `LayerManager.reallocateFocus()` 统一焦点再分配。
> - **F3（ui-shell 只覆盖 topbarHeight）→ 已修**：chrome 归一后 `ChromeView.setBounds` 为 no-op，窗口本体天然铺满（`topbarHeight` 现仅用于 tab/panel/rail 内容区上沿）。

---

## 1. 三套模型总览

### 1.1 旧 Hira（用户口中「屎山但至少流畅」）

```
BrowserWindow
└─ contentView
   ├─ children[0]  = 窗口自身 webContents  ← 整个 UI（tabstrip+navbar+sidebar 全在这一个 renderer）
   ├─ children[1..] = 各 tab 的 WebContentsView（选中才 addChildView，切走 removeChildView + 静音）
   └─ sidebarViewManager 的 view（独立管理）
```

- 源码：[viewManager.js:591 setView](../../1A-STAR_Hira/main/viewManager.js#L591)，注释在 [viewManager.js:621](../../1A-STAR_Hira/main/viewManager.js#L621) 明确写：`index 0 是渲染进程窗口自身 webContents，保留`。
- 切标签：**移除**旧 view + `safeSetViewAudioMuted(child,true)`（[viewManager.js:624-639](../../1A-STAR_Hira/main/viewManager.js#L624-L639)）。
- 关键：**chrome 永远不动**，动的只有 tab view。所以「至少流畅」。
- session 铁律：**从不手动替换 session**，完全交给 Electron 按 `partition` 字符串管理（[viewManager.js:191-195](../../1A-STAR_Hira/main/viewManager.js#L191-L195)），保证多 profile 隔离。

### 1.2 HiraRT（现代基准）

```
BrowserWindow.browserWindow.contentView
└─ LayerManager（按 zIndex 排序，minimal reorder）
   ├─ Layer(FakeWebContentsViewLayer, window.webContents, z=0)     ← chrome（browserUI）
   ├─ Layer(WebContentsView tab,  z=10)  ← 每个 tab 一个真实 view，setVisible 切换
   ├─ Layer(findInPage, z=20) / webPrompt z=22 / popover z=99 / omnibox z=100
   └─ Layer(floatingSidebar, z=30)
```

- chrome = `FakeWebContentsViewLayer(browserWindow.webContents, zIndexes.browserUI)`：[browser.ts:180-188](../../1A-STAR_Hira_RT/src/main/controllers/windows-controller/types/browser.ts#L180-L188) + [fake-webcontentsview-layer.ts:3-38](../../1A-STAR_Hira_RT/src/main/controllers/windows-controller/layer-manager/fake-webcontentsview-layer.ts#L3-L38)。
- **声明式 z 表**：[layers.ts:49-67](../../1A-STAR_Hira_RT/src/shared/layers.ts#L49-L67)（`browserUI:0 / tab:10 / tabBack:9 / findInPage:20 / webPrompt:22 / floatingSidebar:30 / popover:99 / omnibox:100`）。
- **焦点仲裁**：[layers.ts:71-89 focusPriorities](../../1A-STAR_Hira_RT/src/shared/layers.ts#L71-L89) + [layers.ts:91-120 createModalTo](../../1A-STAR_Hira_RT/src/shared/layers.ts#L91-L120) + [layer-manager/index.ts:166-176 reallocateFocus](../../1A-STAR_Hira_RT/src/main/controllers/windows-controller/layer-manager/index.ts#L166-L176)。
- 挂载模型：`setVisible` 幂等（[layer-manager/index.ts:73-80](../../1A-STAR_Hira_RT/src/main/controllers/windows-controller/layer-manager/index.ts#L73-L80)）；`_layersChanged` 只从「首个顺序分歧点」重排（[index.ts:128-161](../../1A-STAR_Hira_RT/src/main/controllers/windows-controller/layer-manager/index.ts#L128-L161)）—— 切标签零重排。
- tab view：`createWebContentsView`（[tab.ts:111](../../1A-STAR_Hira_RT/src/main/controllers/tabs-controller/tab.ts#L111)）、`initializeView`（[tab.ts:352](../../1A-STAR_Hira_RT/src/main/controllers/tabs-controller/tab.ts#L352)）、`teardownView`（[tab.ts:409](../../1A-STAR_Hira_RT/src/main/controllers/tabs-controller/tab.ts#L409)）、`setWindow`（[tab.ts:750](../../1A-STAR_Hira_RT/src/main/controllers/tabs-controller/tab.ts#L750)）。

### 1.3 NG（初始现状 = 待重构；下列结构已按 §4 修复）

```
BrowserWindow(about:blank!)           ← 窗口自身 renderer 空转
└─ contentView
   ├─ _tabLayer（空 View 容器，铺满窗口） ← 所有 tab view 的父级
   │   └─ 各 tab 的 WebContentsView（mount-once + setVisible 切换）✅ 这部分是对的
   ├─ panel view（每个面板一个 WebContentsView）
   ├─ rail view（独立 WebContentsView）
   ├─ ui-shell view（独立 WebContentsView，只覆盖顶部 topbarHeight≈140px）❌
   ├─ float views（searchbar/tabpreview/permission/findbar 各一个）
   └─ password-overlay view
```

- 证据：[WindowFactory.js:33 `win.loadURL('about:blank')`](../../1A-STAR_Hira_NG/infra/infra-window/src/WindowFactory.js#L33) + [WindowFactory.js:38-44 attachUiShell/attachRail/attachFloatView/attachPasswordOverlay](../../1A-STAR_Hira_NG/infra/infra-window/src/WindowFactory.js#L38-L44)。
- ui-shell 是**独立 view**：[WebContentsManager.js:90 createUiShell](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L90)，且只覆盖顶栏：[LayoutCoordinator.js:338](../../1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js#L338) `height: fullscreen ? 0 : topbarHeight`。
- NG 已部分「学到」RT 的 tab 挂载模型（[LayoutCoordinator.js:4-39 挂载模型注释](../../1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js#L4-L39)、[showTab:531](../../1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js#L531)、[_attachTabView:146](../../1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js#L146)）—— **但只学了一半：tab 对了，chrome 反了。**

> ✅ **现状**：`WindowFactory.js` 已不再 `about:blank` 空转，chrome 归一为窗口本体（`ChromeView`），图层与焦点由 `LayerManager` + `LayerStack` 接管（详见 §0 落地状态与 §4）。

---

## 2. 维度对比矩阵

### 维度 A · chrome 归属（★根因）

| 项               | 旧 Hira          | HiraRT                         | NG（现状）                                       | NG 应有                     |
| ---------------- | ---------------- | ------------------------------ | ------------------------------------------------ | --------------------------- |
| chrome 载体      | 窗口 webContents | 窗口 webContents（Fake layer） | 独立 `uiShellView` 等多个 view                   | **窗口 webContents**        |
| 窗口 webContents | = chrome         | = chrome                       | `about:blank`                                    | = chrome                    |
| chrome 进程数    | 1                | 1                              | N（shell+rail+panel×9+float×4+password）         | 1                           |
| chrome 布局      | CSS 全权         | CSS 全权                       | 主进程算 `topbarHeight` 像素 + renderer 回报参数 | CSS 全权                    |
| 底层可见性       | chrome 在底      | `browserUI:0` 在底             | 需 `_restack` 手工保证                           | 天然在底（不是 child view） |

**后果**：

1. **多 renderer 空转**：窗口自身 renderer 跑 `about:blank` 白占一份进程；chrome 又被拆成多份。启动即多起数个 renderer。
2. **z-order 沦为手工维护**：[`_restack()`](../../1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js#L199) + `_zOrderDirty` 标志，每新增一类浮层都要改重排顺序；`raiseFloatView` / `raisePasswordOverlay` / `addChildView(view)` 都是「靠重挂抬层」的补丁。
3. **焦点无仲裁**：NG 没有 `focusPriority`/`modalTo`。焦点靠「事后补」：关查找栏后 `wc.focus()`（[main.js:416-421](../../1A-STAR_Hira_NG/apps/app-main/src/main/main.js#L416-L421)）、切标签 `webContents.focus()`。RT 是声明式 + `reallocateFocus()` 统一重分配。
4. **IPC 广播被迫特判**：[`listChromeWebContents()`](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L371) 存在的唯一原因，就是 chrome 是「多个 webContents」。chrome 归一后该方法退化为「一个 webContents」。
5. **生命周期语义失真**：窗口自身 webContents 是 `about:blank`，`window-all-closed`/关闭语义与真实 UI 脱节（此前僵尸进程冻结的根因链之一）。
6. **菜单 owner 解析绕圈**：`findOwnerWindow` 需沿 `webContents.hostWebContents` 上溯（[context-menu.js:73-87](../../1A-STAR_Hira_NG/infra/infra-window/src/context-menu.js#L73-L87)）；chrome 归一后 chrome 菜单的 owner 恒为窗口自身。

> ✅ 以上 1–6 已随 §4 的 P1–P4 修复（见 §0 落地状态）：chrome 归一为窗口本体、声明式图层取代手工 `_restack`、焦点由 `LayerManager.reallocateFocus()` 仲裁。

### 维度 B · WebContentsView 挂载模型

| 项            | 旧 Hira                                     | HiraRT                             | NG                                           |
| ------------- | ------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| tab view 挂载 | 选中 `addChildView`，切走 `removeChildView` | `push` 一次，`setVisible` 切换     | `_attachTabView` 一次，`setVisible` 切换 ✅  |
| 重排          | 无                                          | `_layersChanged` 最小重排          | `_restack`（仅 Chrome 层变动时） ✅          |
| 隐藏方式      | 移除 + 静音                                 | `setVisible(false)`                | `setVisible(false)` ✅                       |
| 销毁前摘除    | `removeChildView`                           | `pop` → `removeThisFromParentView` | `_removeViewFromHost` → `removeChildView` ✅ |

> ⚠️ 澄清一处**看似矛盾实为正确**的点：[LayoutCoordinator 头部](../../1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js#L9) 说「绝不 removeChildView 隐藏」，而 [WebContentsManager._removeViewFromHost:65-74](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L65-L74) 在 destroy/sleep 时确实 removeChildView —— 这是**销毁前必须的摘除**（否则原生宿主残留 → 合成器崩溃/泄漏，见 [forgetView:422](../../1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js#L422)），与 RT `teardownView` 一致。**不是缺陷**，文档保留以正视听。

### 维度 C · 多标签

| 项           | 旧 Hira                            | HiraRT                                      | NG                                                                                                                          |
| ------------ | ---------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| tab 实体     | `viewMap[id]` + `viewStateMap[id]` | `Tab` 类（identity/state/view/layer 分离）  | `TabManager` + `_tabViews`                                                                                                  |
| 视图代际校验 | 无                                 | 靠 `Tab` 实例生命周期                       | `_tabViewGen`（[WebContentsManager.js:33/418](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L418)） ✅ |
| 切标签       | remove/add + 静音                  | `setVisible`                                | `setVisible` + 缓存 pageBounds ✅                                                                                           |
| 关闭最后一个 | 由渲染层处理                       | TabsController                              | 替换 URL（[TabManager.close](../../1A-STAR_Hira_NG/infra/infra-window/src/TabManager.js#L750)）                             |
| 关后选谁     | —                                  | —                                           | 优先左邻（[TabManager.close:779-784](../../1A-STAR_Hira_NG/infra/infra-window/src/TabManager.js#L779-L784)）                |
| 分屏/glance  | split view ids                     | `tabGroup.mode=glance/split` + `tabBack` 层 | ❌ 无                                                                                                                       |
| 拖拽成组     | —                                  | 有                                          | ❌ 无                                                                                                                       |

NG 的 tab 生命周期基本健康，缺的是 **tab 分组/分屏**与 **图层类型（tab / tabBack）**。

### 维度 D · 生命周期（创建/休眠/唤醒/关闭/退出）

| 项         | 旧 Hira              | HiraRT                                                                                                                                           | NG                                                                                                                                 |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 休眠       | —                    | `putToSleep` → `teardownView`（销毁 view+wc，保留 state/历史）                                                                                   | `sleepTab` → destroy wc（[WebContentsManager.js:453](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L453)） ✅ |
| 唤醒       | —                    | `wakeUp` → `initializeView` + `restoreNavigationHistory`（[tab.ts:429](../../1A-STAR_Hira_RT/src/main/controllers/tabs-controller/tab.ts#L429)） | `_wakeInternal` 重建 wc + loadURL（[TabManager.js:727](../../1A-STAR_Hira_NG/infra/infra-window/src/TabManager.js#L727)）          |
| 休眠候选   | —                    | 策略注入                                                                                                                                         | `tabRules.sleepCandidates`（注入，解耦） ✅                                                                                        |
| 退出       | `windowLifecycle.js` | `QuitController` 状态机（idle/running/completed）                                                                                                | `window-all-closed → app.quit()`（已修）                                                                                           |
| 关闭到托盘 | 有                   | 无                                                                                                                                               | 已移除（[main.js:151](../../1A-STAR_Hira_NG/apps/app-main/src/main/main.js#L151)） ✅                                              |

NG 缺 **QuitController 状态机**（退出时序无显式状态，容易与异步落盘竞争）。

### 维度 E · 多 profile / session（★隔离铁律）

| 项       | 旧 Hira                                                                    | HiraRT                                      | NG                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 隔离方式 | `partition='persist:webcontent'`（字符串，**绝不替换 session**）           | `Profiles/<id>` 目录 + `session.fromPath()` | `sessionDirFor(profileId, spaceId)` → session                                                                                                         |
| 铁律     | [viewManager.js:191-195](../../1A-STAR_Hira/main/viewManager.js#L191-L195) | sessions-controller `fromPath`              | —                                                                                                                                                     |
| 无痕     | —                                                                          | 独立 profile                                | `memory:incognito-<id>` partition（[WebContentsManager.js:406-413](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L406-L413)） ✅ |
| 空间     | —                                                                          | `spaceId`                                   | profile+space 双层 session 目录 ✅                                                                                                                    |

> ⚠️ NG 的 `_tabSession` 注入 + `setTabSession(extensionService.session)`（[main.js:263](../../1A-STAR_Hira_NG/apps/app-main/src/main/main.js#L263)）**把 tab 强制绑到扩展 session**。旧 Hira 的教训（[viewManager.js:191-195](../../1A-STAR_Hira/main/viewManager.js#L191-L195)）正是：**手动把 partition 映射到扩展 session 会破坏 Electron 的 partition→session 映射，导致多 profile 串味**。NG 需要复核：扩展 session 是否按 profile 独立；无痕是否真的不落盘。

### 维度 F · z-order / 焦点仲裁

| 项     | 旧 Hira               | HiraRT                                            | NG                   |
| ------ | --------------------- | ------------------------------------------------- | -------------------- |
| z 定义 | 隐式（children 顺序） | 声明式 `zIndexes` 表                              | 隐式 `_restack` 顺序 |
| 焦点   | 隐式                  | `focusPriorities` + `reallocateFocus` + `modalTo` | 无（事后补）         |
| 模态   | 无                    | `modalTo(zIndex)` 谓词                            | 无                   |

**这是 NG 第二大结构缺陷**：没有「层」这一等公民，只有「一堆 view + 手工顺序」。

### 维度 G · 菜单运行时

| 项            | 旧 Hira                                                                                    | HiraRT                                                      | NG                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 网页右键      | `remoteMenu.js`：renderer DOM contextmenu → ipc → 主进程 popup（**popup 不在原生回调栈**） | `tabs-controller/context-menu.ts` + `electron-context-menu` | `context-menu.js`：快照 + `setImmediate` 延迟 popup ✅                                                                  |
| 三硬规则      | popup 不在原生栈 / Menu 引用活到 `menu-will-close` / 不 `closePopup`                       | 库内部保证                                                  | [context-menu.js:13-30](../../1A-STAR_Hira_NG/infra/infra-window/src/context-menu.js#L13-L30) 显式声明 ✅               |
| 菜单模型      | 三层（页面/网页菜单/webviewMenu）                                                          | 库 + 扩展项                                                 | `context-menu-model.js` 纯数据模型 + 命令端口 ✅                                                                        |
| chrome 区右键 | renderer 自管                                                                              | chrome 是窗口 renderer，自管                                | `tab:context-menu` → ui-shell（[main.js:422-424](../../1A-STAR_Hira_NG/apps/app-main/src/main/main.js#L422-L424)）      |
| owner 解析    | —                                                                                          | 直接窗口                                                    | 上溯 `hostWebContents`（[context-menu.js:73-87](../../1A-STAR_Hira_NG/infra/infra-window/src/context-menu.js#L73-L87)） |

> NG 的菜单**运行时**（三条硬规则）已经对齐旧 Hira 教训，是好的。问题在**归属**：因为 chrome 是独立 view，`tab:context-menu` 要绕一圈发回 ui-shell；chrome 归一后 bookmarkbar 等右键可本地处理。

### 维度 H · IPC 广播

| 项       | NG 现状                                                          | 应有                     |
| -------- | ---------------------------------------------------------------- | ------------------------ |
| 广播目标 | `listChromeWebContents()`（shell+rail+panel×N+float×N+password） | chrome（1 个）+ 必要浮层 |
| 原因     | chrome 拆成多 view                                               | —                        |

> **⚠ 本节描述已失效（已更新）**：事件广播已从「按 chrome 层列表无条件 send」改为**订阅登记制** —— 渲染层在 `hira.on.subscribe()` 时发 `listeners:add` 登记，主进程 `ListenerRegistry` 记账，`createBroadcaster().send(route, payload, { skipWebContentsId })` 只发给登记过该 route 的 webContents。因此广播目标不再是「chrome 层列表」，而是**订阅者集合**；`listChromeWebContents()` 已退化为聚合工具，不再用作广播目标。实现见 `infra/infra-ipc/src/ListenerRegistry.js`、`infra/infra-ipc/src/index.js`、`apps/app-main/src/main/ipc/listeners.js`、`infra/infra-window/preload/{shell,panel,tab}-preload.js`。

---

## 3. NG 缺陷清单（带证据）

| #      | 缺陷                                                                                                                                                                                                                                                                                     | 证据                                                                                                                                                                                                                                | 影响                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **F1** | ~~窗口自身 webContents 空转 `about:blank`~~ **✅ 已修**：不再空转，chrome 由窗口自身 webContents 承载                                                                                                                                                                                    | [WindowFactory.js](../../1A-STAR_Hira_NG/infra/infra-window/src/WindowFactory.js)、[ChromeView.js](../../1A-STAR_Hira_NG/infra/infra-window/src/ChromeView.js)                                                                      | 少一份 renderer 进程；生命周期语义回归                                |
| **F2** | ~~chrome 被拆成多个独立 WebContentsView~~ **✅ 已修**：`createUiShell()` 返回 `ChromeView`（窗口本体假视图）                                                                                                                                                                             | [WindowFactory.js:38-44](../../1A-STAR_Hira_NG/infra/infra-window/src/WindowFactory.js#L38-L44)、[WebContentsManager.js:171](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L171)                               | chrome 归一，启动更快                                                 |
| **F3** | ~~ui-shell 只覆盖 topbarHeight 像素，布局靠主进程算~~ **✅ 已修**：`ChromeView.setBounds` 为 no-op，窗口本体天然铺满                                                                                                                                                                     | [ChromeView.js](../../1A-STAR_Hira_NG/infra/infra-window/src/ChromeView.js)                                                                                                                                                         | chrome 布局不再脆弱                                                   |
| **F4** | ~~z-order 手工 `_restack` + dirty 标志~~ **✅ 已修**：声明式 z 序 + 前缀跳过增量重排                                                                                                                                                                                                     | [LayerManager.js](../../1A-STAR_Hira_NG/infra/infra-window/src/LayerManager.js)、[LayerStack.js](../../1A-STAR_Hira_NG/infra/infra-window/src/LayerStack.js)                                                                        | 浮层增删仅重排分歧后缀                                                |
| **F5** | ~~无焦点仲裁（focusPriority/modalTo）~~ **✅ 已修**：`LayerStack` 提供 `focusPriorities`/`createModalTo`，`LayerManager.reallocateFocus()` 统一再分配                                                                                                                                    | [LayerStack.js](../../1A-STAR_Hira_NG/infra/infra-window/src/LayerStack.js)、[LayerManager.js](../../1A-STAR_Hira_NG/infra/infra-window/src/LayerManager.js)                                                                        | 模态浮层可阻止下层抢焦点                                              |
| **F6** | ~~IPC 广播仍走 `listChromeWebContents()`（chrome 已归一为 1 项，列表退化为 chrome + rail + panels + floats + password）~~ **✅ 已修**：改为**订阅登记制广播**（`ListenerRegistry` + `createBroadcaster`，只发给登记过该 route 的 webContents）；`listChromeWebContents()` 保留作聚合工具 | [ListenerRegistry.js](../../1A-STAR_Hira_NG/infra/infra-ipc/src/ListenerRegistry.js)、[index.js](../../1A-STAR_Hira_NG/infra/infra-ipc/src/index.js)、[listeners.js](../../1A-STAR_Hira_NG/apps/app-main/src/main/ipc/listeners.js) | 广播目标收敛为订阅者集合；内部页（标签页里的 hira:// 页）也能收到事件 |
| **F7** | ~~tab 强制绑扩展 session，profile 隔离需复核~~ **✅ 已修**：扩展 session 已按 profile 独立（`sessionsController.get(id)`），无痕走 `memory:incognito-*`                                                                                                                                  | [main.js:263](../../1A-STAR_Hira_NG/apps/app-main/src/main/main.js#L263)、[WebContentsManager.js:411-413](../../1A-STAR_Hira_NG/infra/infra-window/src/WebContentsManager.js#L411-L413)                                             | 多 profile 已隔离                                                     |
| **F8** | ~~无退出状态机~~ **✅ 已修**：新增 `QuitController`（idle→running→completed）                                                                                                                                                                                                            | [QuitController.js](../../1A-STAR_Hira_NG/infra/infra-window/src/QuitController.js)                                                                                                                                                 | 退出与落盘已串行化                                                    |
| **F9** | 无 tab 分组/分屏/图层类型                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                   | 功能缺失                                                              |

---

## 4. 重构方案（分阶段、可落地）

> **落地状态**：P1 ✅ ｜ P2 ✅ ｜ P3 ✅ ｜ P4 ✅（全部完成）
>
> - P1：`infra-window/src/ChromeView.js` 新增，`WindowFactory` 不再 `about:blank` 空转，chrome 归一为窗口本体。
> - P2：`infra-window/src/LayerManager.js` + `LayerStack.js` 新增，声明式 z 表 + 焦点仲裁。
> - P3：菜单归属归一，主进程非阻塞 `ui:popup-menu`（invoke 立即返回 + `ui:popup-menu-selected` 事件按 `requestId` 回传，通道前缀 `ngipc:event:`），6 处调用方统一走 `menuClient.popupMenu`。
> - P4：扩展 session 已按 profile 独立；新增 `infra-window/src/QuitController.js`（idle→running→completed），`main.js` 两处零散 `before-quit` 收敛为单次 `register()`。

### P1 · chrome 归一到窗口自身 webContents（★核心，先做）✅

目标：让 `window.webContents` 成为 chrome 基座层，删掉独立 `uiShellView`。

1. **新增 `ChromeView` 适配器**（对齐 RT `FakeWebContentsViewLayer`）：
   - `infra-window/src/ChromeView.js`：把 `win.webContents` 包成 `{ webContents, setVisible:noop, setBounds:noop, isFake:true }`。
2. **WindowFactory**：
   - `win.loadURL('about:blank')` → 不加载（保留空 renderer 作为 chrome，稍后由 `loadUiShell` 载入 app-shell）。
   - `attachUiShell()` 不再创建独立 view，而是登记 `ChromeView`。
3. **WebContentsManager**：
   - `createUiShell()` 返回 `ChromeView(win.webContents)`；`loadUiShell()` 改为 `win.webContents.loadURL/loadFile(app-shell)`。
   - `listChromeWebContents()` 退化为「chrome + rail + panels + floats + password」（chrome 只 1 项）。
4. **LayoutCoordinator**：
   - ui-shell 不再 `addChildView`、不再 `setBounds`（它是窗口本体，天然铺满且在 child view 之下）。
   - `_restack` 移除 ui-shell；保留 tabLayer→panel→rail→floats→password。
   - `getUiShellWebContents()` 返回 `win.webContents`。
5. **main.js**：`uiShellWebContents` 取 `win.webContents`，其余 IPC 不变。
6. **app-shell renderer**：body 全窗口透明，顶栏区域自绘（CSS），下方透明（被 tab view 覆盖）。

收益：少 1 个 renderer；`window-all-closed`/关闭语义回归；z-order 基座天然正确；IPC 广播目标收敛。

### P2 · 声明式图层 + 焦点仲裁（对齐 RT `layers.ts`）✅

- 新增 `infra-window/src/layers.js`：`zIndexes` / `focusPriorities` / `createModalTo` 常量表。
- LayoutCoordinator 改为按 `zIndexes` 排序（把 tabLayer 视作 tab 层的父容器），删除手工顺序。
- 新增 `reallocateFocus()`：层级隐藏后统一重分配焦点；替换「事后 `wc.focus()`」补丁。

### P3 · 菜单归属归一 ✅

- chrome 归一后，bookmarkbar 等右键在 chrome renderer 本地处理，删除 `tab:context-menu` 绕行（或仅保留给非 chrome 区）。
- `findOwnerWindow` 简化：chrome 菜单 owner 恒为窗口。

### P4 · profile/session 铁律复核 + 退出状态机 ✅

- ✅ 复核扩展 session 按 profile 独立（`main.js` 用 `createSessionsController({resolveProfileDir})`，扩展服务复用 `sessionsController.get(id)`）；无痕走 `memory:incognito-*` 不落盘。
- ✅ 引入 `QuitController` 状态机（对齐 RT，`infra-window/src/QuitController.js`），`main.js` 两处零散 `before-quit` 收敛为单次 `register()`，串行化退出与落盘（回调抛错仍强制退出，显式 `false` 可取消）。

---

## 5. 判定与取舍

- **必须做（P1）**：这是「网页视图逻辑一开始就错」的根因，且改动集中在 infra-window 3 文件 + main.js 1 处 + app-shell 样式，风险可控、收益最大。
- **应做（P2）**：图层与焦点是 NG 与 RT 的结构性差距，做完才谈得上「流畅跟手」。
- **缓做（P3/P4）**：菜单绕行与退出状态机，属打磨。

> ✅ **落地状态**：P1 / P2 / P3 / P4 均已完成（见本章各节标题与 §4 开头）。
>
> 原则：**tab 用 WebContentsView + setVisible（NG 已对）**；**chrome 用窗口自身 webContents（NG 已修）**；**图层声明化 + 焦点仲裁（NG 已补）**。
