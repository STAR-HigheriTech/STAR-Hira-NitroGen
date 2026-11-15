# 独立侧栏（Web Sidebar）设计

> 一次**彻底重写**：把"远程网页住侧栏"从**面板系统**里拆出来，做成一等公民的独立子系统。
> 前身（`docs/panel-web-panel-design.md` 描述的"网页面板"）已整体删除 —— 那份文档也删了。

---

## 0. 结论（先说）

**侧栏不是面板。** 它有：
自己的一套视图、自己的存储、自己的布局区域、自己的顶条、自己的 IPC 家族。

它与面板系统**唯一的关系**是：在纵向轨道上相邻（网页侧栏排在面板内侧、紧邻网页），
于是**两者可以同时开着** —— 共存不是"特例处理"，而是"两段宽度相加"这么自然。

```
同一侧由外到内：[侧栏区] → [rail] → [面板] → [网页侧栏] → [网页]
                                       └── 面板与网页侧栏各占各的宽度，互不知道对方存在 ──┘
```

---

## 1. 为什么要重写（前身错在哪）

前身把"远程网页"实现成面板目录里的 `kind:'web'` 条目，代价是**两边都被拖累**：

| 症状                                                                     | 根因                                                                                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 侧栏里的网页**什么功能都没有**（连链接光标、右键菜单、`confirm` 都没有） | 它走的是"面板"那条视图管道：`buildWebPanelPreferences`（`preload:false`）、没有 JS 对话框、没有快捷键、没有右键菜单 —— 只有一句"这是别人的页面，别给它我们的桥" |
| 它和面板抢**同一个槽**（`_panelSlots`，每侧只能有一个）                  | 面板槽的语义是"一个位置装一个面板"，与"侧栏是一个独立工作区"根本不匹配                                                                                          |
| 面板目录里混进了"不是面板的东西"                                         | 目录的消费方（rail / navbar / 按钮编辑浮层）被迫认识 `kind`；`PanelEntry` 多出 `web`/`kind` 两个字段                                                            |
| 一个功能要改 N 处                                                        | `panel-views` 里 app/web 两个分支、`panel-web-store` 一张表、`panel-catalog` 的运行时条目、顶条视图与渲染页…                                                    |

**这次的原则**：**一个板块一套系统**。面板回归"本地渲染页"，侧栏自成一家。

---

## 2. 参考实现（Hira `main/sidebarViewManager.js`）的三个关键做法

参考项目早就给出了正确的形状，这次是**照着学**：

1. **视图就是标签视图的同一套底层**
   `new WebContentsView({ webPreferences: getDefaultViewWebPreferences() })` ——
   与主浏览器的网页视图**逐项相同**（preload / session / 指纹 / 圆角 / 弹窗）。
   > 这就是"功能完整"的全部秘密：它不是被砍过的第二类容器。
2. **独立事件接线**：右键菜单、证书错误、JS 对话框、缩放、查找、`_blank`、
   外部协议、扩展注册…一条条挂在这个 webContents 上。
3. **它不是"面板"**：一个窗口一个侧栏视图，`addChildView` 到 contentView，bounds 由布局给。

NG 的差别只在**落地方式**（更彻底的解耦）：

| 维度     | 参考 Hira                        | NG                                                                                     |
| -------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| 视图创建 | 模块内直接 `new WebContentsView` | `WebContentsManager#createWebSidebarView`（唯一的视图工厂，与标签共用 session 解析链） |
| 摆放     | 渲染层算好 bounds 发 IPC         | `LayoutCoordinator` 的**独立区域**（与面板/rail 同一套几何，三段相加）                 |
| 右键菜单 | 转发给渲染层再弹                 | 直接复用 `infra-window#showWebContentMenu`（与标签同一份实现）                         |
| 持久化   | 无                               | 宽度落设置（`app.web_sidebar_width`）                                                  |

---

## 3. 分层与谁认识谁

```
UI（renderer/web-sidebar-header/）        ← 顶条哑壳：只发命令、只画状态
      ↕ IPC（web-sidebar:*）
apps/app-main/src/main/web-sidebar.js     ← 唯一认识"侧栏"的模块（视图/状态/命令/持久化）
      ↕ 端口（setWebSidebarViewPort）
infra/infra-window/LayoutCoordinator.js   ← 只认"一块矩形归谁"（不认识 URL / preload / 网页）
infra/infra-window/WebContentsManager.js  ← 视图工厂（只认 buildTabWebPreferences）
packages/shared-types/src/web-sidebar.mjs ← 纯规则：url 判据 + 标题回落（两端引同一份）
```

**不变式**

| #   | 断言                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 侧栏**不出现**在面板目录里（`panel:catalog` 里没有它），也不占 `_panelSlots`                                                                                                  |
| S2  | 侧栏与面板**可以同时可见**（`_panelSlots` 与 `_webSidebar` 互不影响，宽度相加）                                                                                               |
| S3  | 侧栏内容视图用的 webPreferences 与标签**同一份**（`buildTabWebPreferences`），身份（profile/无痕）走同一条 session 解析链 → 同登录态                                          |
| S4  | 布局层不认识 `kind` / URL / preload —— 它只拿到"两份视图 + 一个 headerHeight"                                                                                                 |
| S5  | `panel:web-*` 通道与 `web_panels` 表**不存在**（重写后已删除）                                                                                                                |
| S6  | 顶条命令只接受**顶条视图**发来的（远程页拿不到这条通道）                                                                                                                      |
| S7  | **窗口级能力（查找 / 缩放 / 悬停 URL）的靶子 = 当前聚焦的那块网页面**：侧栏内容页持焦 → 作用于侧栏；否则作用于活动标签。落位与靶子用**同一条判据**（`getFocusedWebBounds`）   |
| S8  | 错误页地址只有**一个构造点**（`shared-types#webErrorUrl`），标签与侧栏共用                                                                                                    |
| S9  | 侧栏里的**链接去向**只有一个出口（`web-sidebar.js#routeLink`）：同站留侧栏、站外去主浏览区开新标签。`will-navigate` / `setWindowOpenHandler` / 右键菜单三处都调它，不各写各的 |
| S10 | 焦点判据只有**一份**（`LayoutCoordinator#_webSidebarActive`，**显式活动面**，不是 `focus`/`blur` 事件派生）；浮层落位与"靶子解析"都问它，不各自轮询 `isFocused()`             |
| S11 | 活动面变化只推一条**独立通道** `web-sidebar:changed`（不复用 `split:changed`）—— 侧栏与分屏是两套系统，只是画框长得一样                                                       |
| S12 | 视图模式只有**两条 UA**（桌面端 = `getUserAgent()` 真源，手机端 = `buildMobileUserAgent` 由它推出）；模式只是呈现，**不改 session / 登录态**                                  |

---

## 4. 落地清单

### 4.1 新增

| 文件                                                       | 层   | 职责                                                                                                                                          |
| ---------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-types/src/web-sidebar.mjs`                | 纯   | `normalizeSidebarUrl` / `sidebarTitleForUrl` / `isSameSidebarSite` + 视图模式规则（`isWebSidebarViewMode` / `buildMobileUserAgent`，见 §5.1） |
| `packages/shared-types/src/web-error.mjs`                  | 纯   | `webErrorUrl` / `isWebErrorUrl`（错误页地址的**唯一构造点**，标签与侧栏共用）                                                                 |
| `apps/app-main/src/main/web-sidebar.js`                    | apps | 按窗口的运行单元：open/close/command/navigate/状态/持久化 + 全功能事件接线                                                                    |
| `apps/app-main/src/renderer/shared/web-sidebar-client.js`  | 渲染 | 唯一的 IPC 门面（不认识布局与视图）                                                                                                           |
| `apps/app-main/src/renderer/web-sidebar-header/`           | 渲染 | 顶条宿主页（薄壳）                                                                                                                            |
| `apps/app-main/src/renderer/shared/web-sidebar-surface.js` | 渲染 | **聚焦框**外壳渲染点（与 `split-surface` 同款但独立一份，见 §5.1）                                                                            |
| `ui/ui-common/src/webSidebarHeader.ts`                     | UI   | 顶条控件（后退/前进/刷新/标题/在标签页打开/关闭 + 宽度把手）                                                                                  |
| `docs/web-sidebar-design.md`                               | 文档 | 本文                                                                                                                                          |

### 4.2 改动

| 文件                                                 | 改了什么                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/infra-window/LayoutCoordinator.js`            | 新区域 `_webSidebar` + `setWebSidebarViewPort` + `setWebSidebarVisible/Width/Side` + `getWebSidebarSide/Width` + `_placeWebSidebar`；`applyInitialLayout` 加入这段轨道                                                                         |
| `infra/infra-window/WebContentsManager.js`           | 新增 `createWebSidebarView`（**标签那一份 webPreferences** + 同一条 session 链）/ `createWebSidebarHeaderView` / `destroyWebSidebarViews`；`createPanel`/`loadPanel` 去掉 `spec`（面板只有本地页一种）                                         |
| `infra/infra-window/LayerStack.js`                   | 新增图层 `web-sidebar`（z=2，焦点优先级 5）                                                                                                                                                                                                    |
| `apps/app-main/src/main/browser-window-assembly.js`  | 装配侧栏运行单元 + 视图端口；页面右键项改为「在侧栏打开」                                                                                                                                                                                      |
| `apps/app-main/src/main/panel-views.js`              | 瘦身成"面板 = 本地渲染页"（web 分支/顶条/UA 覆盖全部移走）                                                                                                                                                                                     |
| `apps/app-main/src/main/panel-catalog.js`            | 删掉"运行时条目"（那是网页面板的遗留）                                                                                                                                                                                                         |
| `apps/app-main/src/main/settings/appliers/layout.js` | 新增 `createWebSidebarApplier`（宽度记忆）                                                                                                                                                                                                     |
| 书签右键 / 收藏面板右键 / rail 的 `+`                | 改调 `web-sidebar:open`（语义从"加为面板"变成"放进侧栏"）                                                                                                                                                                                      |
| `apps/.../main/browser-window-runtime.js`            | 新增"当前聚焦的网页面"解析（`focusedSurface` / `focusedWebContents`），查找栏 / 缩放 / 悬停 URL 三处改用它；`getExtensionMenuItems` 提成具名函数并对外暴露（侧栏右键复用）                                                                     |
| `apps/.../main/hover-url-bar.js`                     | 过滤判据从"活动标签 id"改成"聚焦网页面标识"（`'sidebar'` 或标签 id）；宽度按 `getFocusedWebBounds`                                                                                                                                             |
| `apps/.../main/find-bar.js`                          | 只是文档口径更新（靶子与"本页查询串"的键都变成"聚焦网页面标识"）                                                                                                                                                                               |
| `infra/.../LayoutCoordinator.js`                     | `getFocusedWebBounds` + `_lastWebSidebarRect`；`anchorFloatInContent` 改用"聚焦网页面"矩形                                                                                                                                                     |
| `infra/.../tabEvents.js`                             | 错误页地址改用 `shared-types#webErrorUrl`（与侧栏同一份）                                                                                                                                                                                      |
| `infra/.../LayoutCoordinator.js`（第三轮）           | 焦点判据由 `focus`/`blur` 改为**显式活动面** `_webSidebarActive`（只挂 `focus`，不挂 `blur`）；`WEB_SIDEBAR_GAP` 让位 + `_pushWebSidebarFrame` / `getWebSidebarFrameGeometry`（聚焦框几何）；标签 `focus` / `showTab` / 收起均把活动面收回标签 |
| `packages/shared-types/src/ipc-channels.mjs`         | 新增 `layout:web-sidebar-geometry`（几何快照）与 `web-sidebar:changed`（几何推送）                                                                                                                                                             |
| `apps/.../renderer/app-shell/main.js`                | 挂载 `web-sidebar-surface`（与 `split-surface` 并列，各自独立订阅）                                                                                                                                                                            |

### 4.3 删除（死代码一并清除）

`packages/shared-types/src/web-panel.mjs`、`apps/.../main/web-panel-open.js`、
`apps/.../main/panel-web-store.js`、`apps/.../renderer/panel-web-header/`、
`ui/ui-common/src/panelHeader.ts`、`web_panels` 表 DDL、
`panel:web-open` / `panel:web-command` / `panel:web-state` 三条通道、
`buildWebPanelPreferences`、`docs/panel-web-panel-design.md`。

---

## 5. 功能覆盖（"网页所有功能"到底接了什么）

侧栏内容视图与标签**同底层**，因此白拿到的：

- 正常交互与光标、滚动惯性、`window.hira` 桥、密码自动填充（tab preload）
- 同 session / 同 profile → **登录态与标签一致**；扩展注入同样生效（`addTab` 走同一条链）
- 下载（`session.on('will-download')` 按 session 生效）
- 权限请求（`session.setPermissionRequestHandler` 按 session 生效）

侧栏自己额外挂的（`web-sidebar.js#bind`）：

| 能力                            | 怎么接的                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 右键菜单                        | `showWebContentMenu`（与标签**同一份**实现：模型 / 扩展项 / 宿主项）                                                                                       |
| JS 对话框 alert/confirm/prompt  | `jsDialogManager.attachToWebContents(wc,'web-sidebar')`（装配层注入）                                                                                      |
| 快捷键（Ctrl+F / Ctrl+D…）      | `shared.keybindings.attach(wc)`                                                                                                                            |
| 链接悬停 URL 提示               | 复用窗口级 hover 端口（来源标识 `'sidebar'`，见不变式 S7）                                                                                                 |
| **查找栏 Ctrl+F**               | 靶子与落位都跟随**活动面**（`_webSidebarActive`，见 §5.1）—— 在侧栏里按 Ctrl+F 找的是侧栏那一页，查找栏也落在侧栏上                                        |
| **Ctrl+滚轮缩放 / 缩放条**      | 走同一个 `zoom-controller`（按 origin 记忆 → 同站点在标签与侧栏共享缩放）                                                                                  |
| **加载失败 → 我们的错误页**     | `did-fail-load` → `hira://error`（与标签**同一个构造点**，含重试 / 返回 / 搜索入口）                                                                       |
| **PDF 分流**                    | `will-navigate` → 内置查看器（与标签同一份 `isPdfUrl` / `wrapPdfUrl`，不是第二份判定）                                                                     |
| **链接去向分流**                | **同站**（主机名相同或互为子域）→ 留在侧栏；**站外** → 主浏览区开新标签。`_blank` / `window.open` / 普通点击 / 右键菜单四条路都走 `routeLink`（不变式 S9） |
| **右键菜单打哪个 URL**          | **链接优先**：`params.linkURL` 非空（对着链接右键）就打那条链接，否则退回 `params.pageURL`。判据只一份（`contextMenuTargetUrl`），标签的「在侧栏打开」与侧栏的「在标签页打开」共用 |
| 顶条上的快捷键                  | 顶条是我们自己的 chrome（`panel` preload），`Ctrl+F` 等键落在它身上 —— 装配端口里一并 `keybindings.attach`（shell 那份挂不到它）                           |
| 标题 / 图标 / 加载态 / 前进后退 | 主进程推 `web-sidebar:state` 给顶条与外壳                                                                                                                  |
| **视图模式（手机端 / 桌面端）** | 默认手机端；顶条按钮一键切桌面端。只换 UA，session 不变（见 §5.1）                                                                                         |
| 渲染进程崩溃                    | `render-process-gone` → 状态如实回落                                                                                                                       |
| 面板/侧栏共存                   | 布局两段各自占宽（不变式 S2）                                                                                                                              |

> 上面标**粗**的四条是第二轮补的：没有它们，侧栏就是"能看不能用"的半成品 ——
> 在标签里按 Ctrl+F 有查找栏、在侧栏里没有；标签点 .pdf 能看、侧栏只会下载。
> 同一件事两种结果，正是"不符合整个浏览器浏览体验标准"的定义。

---

## 5.1 活动面（聚焦框）与视图模式

### 活动面 = 显式状态，不是"此刻持焦"

窗口级能力（查找 / 缩放 / 悬停 URL）要回答一个问题：**靶子是侧栏还是标签页？**

一开始用 `focus`/`blur` 事件派生这个判据，结果是"在侧栏按 Ctrl+F 却搜到隔壁标签"：
查找栏是**自持焦浮层**（`SELF_FOCUS_FLOATS`），它一打开就把侧栏 `blur` 掉，于是判据
翻回标签。修法是**把它变成显式状态**（与分屏的活动格 `split.activeTabId` 同构）：

- `LayoutCoordinator#_webSidebarActive` —— 唯一真源；
- 只挂 `focus`（用户点了侧栏网页 → 置 true），**刻意不挂 `blur`**（自持焦浮层不该改活动面）；
- 点标签网页 / `showTab` 切标签 / 侧栏收起 → 显式置 false。

`isWebSidebarFocused()` 返回 `visible && _webSidebarActive`，`getFocusedWebBounds`
与浮层落位都问它（不变式 S7 / S10）。

### 面级动作：快捷键 / 菜单也认聚焦框

靶子 = 聚焦框标的那个面，这条原则必须贯穿**所有**面级动作，否则会出现"框在侧栏、
按 Ctrl+R 刷的却是隔壁标签"这种自相矛盾。分屏早就是这样（快捷键跟着活动格走），
侧栏只是同一原则的第二个面。

分两类，别混：

| 类别 | 判据 | 谁回答 | 例 |
| --- | --- | --- | --- |
| **靶子是哪个 webContents** | 需要"那块网页面"本身 | `getFocusedWebContents()`（装配层注入） | 查找栏、缩放、悬停 URL、缩放 Ctrl+滚轮 |
| **这条动作该谁执行** | 有些动作用 wc 表达不出来 | `surfaceCommand(action)`（装配层注入，返回"已处理"） | 关闭（关标签 ≠ 收起侧栏那两份视图）、收藏、刷新、后退 / 前进、开发者工具 |

- 注入点在 [browser-window-assembly.js](file:///e:/Desktop/OTHER/1A-STAR_Hira/1A-STAR_Hira_NG/apps/app-main/src/main/browser-window-assembly.js)：
  `runSurfaceCommand` 与 `sidebarFocusedContents` 同源（判据只有一份），命令词汇里
  `reload / back / forward / close` 与 `web-sidebar#command` **同名同义** → 只转发、不抄第二遍。
- 消费点在 [main.js](file:///e:/Desktop/OTHER/1A-STAR_Hira/1A-STAR_Hira_NG/apps/app-main/src/main/main.js)：
  `runSurfaceCommand()` **先问一句，没人认领再走标签那条老路**。缺省（未注入 / 活动面就是标签）
  返回 false，于是行为与改造前**一字不差** —— 新增一个面不需要动标签那条链。
- 快捷键与应用菜单**走同一条** `runSurfaceCommand`：菜单是"另一条调用路径"，
  只接快捷键会让菜单成为下一个不一致。
- 运行时（[browser-window-runtime.js](file:///e:/Desktop/OTHER/1A-STAR_Hira/1A-STAR_Hira_NG/apps/app-main/src/main/browser-window-runtime.js)）
  只把端口带在窗口对象上，**不认识任何具体的面** —— 业务名词（"侧栏"）始终只活在装配层。

### 聚焦框：让"活动面"看得见

内容四周留一圈与**主视图网页同一份**的呼吸空（`_contentInset*`），网页收在这圈呼吸空里、
带**与主视图同一个圆角**；外壳 DOM（`web-sidebar-surface.js`）把淡蓝框画在**槽矩形**上、
线朝**内**画，线宽取 `SPLIT_METRICS.paneGap`（与分屏活动格同一条真源，两道框粗细天然一致）。

⚠ 框**不能**画在"内容块向外扩一圈"上 —— 槽的外面紧挨着面板 / 底栏这些**原生视图**
（它们盖在 chrome DOM 之上），框越出槽一步，靠内那一侧与底部的线就被吃掉一角。
两个都踩过的坑，一并记下：
  · 框外扩 + 网页方角 → 框的圆角弯进网页矩形被盖住（"圆角缺一块"）；
  · 框外扩 + 网页有圆角 → 外扩部分越过槽、被隔壁原生视图吃掉（"靠 panel 一侧与底部被裁"）。
结论：**框必须整体落在槽内**，网页也要有自己的圆角（两者同心）。

几何由主进程推 `web-sidebar:changed`（独立通道，不复用 `split:changed`，不变式 S11）；
挂载时先拉一次 `layout:web-sidebar-geometry` 快照（推送首帧可能早于订阅）。

### 调宽：整条边都能拖（不只是顶条那一小条）

宽度把手原来只长在顶条的 32px 里（6px 宽），用户既找不到也抓不稳 —— 观感就是
"侧栏的网页不能调宽"。现在**沿着侧栏与网页之间那道缝，整条边都能拖**：

| 环节 | 落点 |
| --- | --- |
| 矩形 | `LayoutCoordinator#_webSidebarResizeHandleRect`（**主进程算**：缝 = 内容块的内侧沿 → 网页的外侧沿），结果存进 `_webSidebarHandleRect` |
| 绘制与拖拽 | `renderer/shared/web-sidebar-surface.js` 的 `.web-sidebar-resize`（外壳 DOM） |
| 落库 | 复用 `web-sidebar:set-width`（与顶条那条把手**同一条通道**，区间校验 200~600 留在主进程） |

**踩过的坑（第一版就是这么错的）**：把手矩形的两个来源 —— 侧栏槽与网页矩形 —— 在**同一趟布局里是先后写上的**
（侧栏先落位、页码范围在后面），而几何推送当时挂在 `_placeWebSidebar` 末尾，**早于** `pageBounds` 的赋值 →
调到的是**上一趟**的网页矩形。侧栏刚打开那一趟，上一趟的网页还是"没有侧栏"的满宽矩形，于是算出来的缝
横跨大半个侧栏 → 把手落在侧栏中间、**压在侧栏自己的网页视图底下**（现象："宽度调节被网页视图遮挡"）。

两条修法（都已落地，缺一不可）：
· **把手矩形在布局末尾算一次并存下来**（与 `_webSidebarSlotBySide` 同一条口径：主进程算好、留一份）；
· **推送时机与 `_pushSplitGeometry()` 并列收在 `applyInitialLayout` 末尾** —— 两个几何推送同一个发送时机，
  不再有"一个早一个晚"这类只在首次布局暴露的坑。
（`_placeWebSidebar` 里那一次推送已删；"收起"分支上保留了一次，那是必须立刻生效的转移，且幂等。）

为什么这条缝里画得上、也点得着 —— 与**分屏分隔条**是同一条道理：网页只占自己那一块矩形，
缝里**没有任何网页 view**，露出来的是 chrome，于是 chrome DOM 既可见、也天然收得到指针事件。
这正是 §0 那条铁律的正面用法（"chrome DOM 只能画在网页让出来的缝里"）。

细节：
- 把手**正好铺满那道缝**（呼吸空 4 + 4 ⇒ 8px 宽）：压到网页/侧栏视图底下的部分点不着，
  而缝里的每一像素都收得到指针 —— 只取 6px 会在缝两侧各留 1px「死边」，指针恰好落在那里就什么都不发生。
- **高亮线平时不上色，`hover` / 拖动才亮**（2px，贴内容块那一侧，与聚焦框同色）。颜色令牌**只能**用
  `--hira-split-focus-ring`（颜色令牌）：`--hira-focus-ring` 是 **box-shadow 列表**（`0 0 0 2px rgba(...)`），
  拿它当 `background` 的颜色会让该声明「计算值非法」→ 落回 `initial`（`transparent`）且**不报错** ——
  这正是"线死活不显示、怎么调透明度都没用"的真因。
- 竖跨**整个槽高**（含顶条那一段）：顶条视图只占内容块的 x 范围，不会盖住缝里这一条。
- 拖拽用 `screenX` + `setPointerCapture` + rAF 合帧，与顶条那条把手、与分屏分隔条同一套写法。
  必须用 `screenX`：拖右侧时把手自己的 x 会随宽度改变，`clientX` 算出来的 delta 恒接近 0。
- 缝宽由**两个真实矩形相减**得到（`_placeWebSidebar` 的内容块 / 布局结果的网页矩形），
  不在本地重推轨道算术 —— 那种复刻迟早漂移，而漂移的表现是"把手压在网页上，看不见也点不着"。

### 顶条的圆角：上圆下平（接缝处一个圆角都没有）

侧栏是**一整块**：顶条（我们自己的 chrome）在上、网页在下，两者之间那条边是**连着的**，
不该有圆角 —— 四个角都圆时，顶条下边的内凹弧与网页上边的内凹弧正对着，接缝处看着像被掐了一下。

问题在于**原生做不到"上圆下平"**：`View.setBorderRadius` 只能给四角**同一个值**
（`electron.d.ts` 里还有一句"被切掉的角仍然会捕获点击"）。所以这条只能改由 DOM 画：

| 环节 | 落点 |
| --- | --- |
| 原生顶条 | `LayoutCoordinator#_placeWebSidebar`：`setBorderRadius(0)`；底色改**透明**（`WebContentsManager#createWebSidebarHeaderView`） |
| DOM 画角 | `.hira-ws-header` 的 `border-radius: R R 0 0`（`ui-common#webSidebarHeader`） |
| 网页上圆角 | 网页视图**向上多留 `R`**：`y = inner.y + headerHeight - R`、`height = … + R`，那一条藏进顶条底下 |

- **为什么要让网页视图多留 `R`**：网页的原生圆角也是四角同值，它的上面两个圆角落在**自己的顶边**，
  而那条边正好是接缝 —— 不处理就照样露出两个内凹弧。上移 `R` 把这两个角挪到接缝**之上**、
  被顶条那张不透明面盖住；顶条的下边是平的，网页露出来的上边于是也是平的。
  代价只有"网页顶部 `R` 像素藏在顶条底下"，而**网页可见区域的位置一点没动**
  （`getFocusedWebBounds` 那份算术仍是"槽收进呼吸空、再去掉顶条那一条"，
  查找栏 / 悬停 URL / 调宽把手贴的仍是网页真正露出来的那一块）。
- **`R` 从哪来**：顶条与网页必须是**同一个数**，否则上下两端的圆角一眼看得出不对称。
  这个数两处同源 —— 主进程是 `_tabBorderRadius`（`theme.style.cornerRadius`，见 theme-runtime → `setTabTheme`），
  DOM 那边直接读主题令牌 `--hira-theme-radius`（同一个字段，见 shared-types#themeTokens）。
  **刻意不走"宿主推半径"**：那需要一次额外的状态推送才能在换主题时同步，而令牌是主题控制器
  本来就铺到每个渲染页的，零时差、零管道。
  ⚠ 主进程**没有**"0 当未设置"的钳制：`theme.style.cornerRadius` 原样下发，`0` 就是直角。
  早先这里有一条 `max(…, 6px)` 跟着主进程把 0 抬回 6，属于旧口径，已删除 ——
  否则主题把圆角拉到 0 时网页是直角、顶条却还是圆的，上下角对不上。
- 顺带修好的一件事：`renderer/web-sidebar-header/main.js` 原先把 `document` 当参数对象传
  （`createThemeController(document)`，而签名收的是 `{ document, bridge }`）且从不 `start()` ——
  于是**一个令牌都没落地**，顶条在深色主题下一直是浅色。改成与其它外壳页同一个调法后一并解决。

### 拖动顶条换边（原生浮层预览 + 松手落位）

顶条可拖（按钮与宽度把手除外）：指针越过**窗口内容区中线**就点亮目标侧 —— 与"把窗口拖到
屏幕另一半"同一个直觉。松手把结果写进设置（钉住显式 `left`/`right`），中途取消
（Esc / 指针丢失）撤掉预览、位置不动。

**拖动途中只改预览，松手才真的换边。** 两个理由：

1. 预览**必须由原生浮层画**。网页是原生 `WebContentsView`，永远盖在 chrome DOM 之上 ——
   画在外壳里的半透明带会被网页整个吃掉。这就是"预览错位 / 被遮挡"的由来。
   实现上**复用分屏那套 `dropzone-overlay` 浮层**（它本来就是"落位预览"的宿主），
   给它一个 `cover` 形态（只画半透明块 + 边框，不要分屏的箭头与 zone 文案）。
2. **不能实时换边**：换边会让顶条视图当场挪到另一侧，"指针在顶条视图内的坐标"随即失去
   参照，中线判据来回翻转 —— 表现为侧栏在两跳之间抖。

预览矩形取 `_webSidebarSlotBySide`（`applyInitialLayout` 每次重排时把**两侧**的槽矩形都留
一份）—— **预览与落点是同一个矩形**，所见即所得由结构保证，不是两边各算一遍。

铁律：**凡是覆盖在网页区域上的视觉，都必须由原生视图来画；chrome DOM 只能画在网页让出来的缝里。**

判据只在主进程（窗口中线只有它知道），渲染层只报"指针在哪"。

### 侧栏落在哪一侧：`auto` 跟着工具区走

设置项 `app.web_sidebar_position` 三值：`auto`（默认）/ `left` / `right`；解析在纯层
（`shared-types#web-sidebar.mjs#resolveWebSidebarSide`），主进程与设置页引**同一份**。

- `auto` = **工具区（rail + 面板）在哪侧，侧栏就在哪侧**。侧栏本来就是从工具区点出来的
  （rail 上固定的书签 / rail 贴底的「放进侧栏」/ 收藏面板），从左边点开却出现在右边缘
  是"手感错位"—— 这正是用户报告的那一条。"跟着工具区走"也是 `auto` 这个名字唯一说得通的解释。
- `left` / `right` = 用户显式钉死（设置里选，或拖顶条换边后落库）。想要"错开一侧"的人
  在这里显式决定 —— 不该由默认值替他做。
- 代价（明确写下来）：与工具区同侧时两段宽度相加，网页会被推窄。这是可感知、可自主取舍的
  （钉到对面 / 拖顶条 / 调窄任一段），比"从哪边点却出现在另一边"的错位好。

### 视图模式：一个视图、两种呈现

窄栏里很多站点在桌面版 UA 下会横向铺满（滚动条满天飞），所以**默认以手机端打开**：

- 规则在纯层（`shared-types#web-sidebar.mjs`）：`WEB_SIDEBAR_VIEW_MODES` / `isWebSidebarViewMode`
  / `buildMobileUserAgent`；主进程与顶条引**同一份**。
- 施加点是唯一一处（`web-sidebar.js#applyViewMode`）：桌面 UA 真源 = 视图创建时
  `getUserAgent()`（**只抓一次** —— 切成手机端后它就不再是桌面端了），手机 UA 由它**推出**
  （沿用同一 Chrome 主版本，两模式版本一致，站点看不出"同一客户端演两套"）。
- 切换即重载一次（UA 只对之后的请求生效）+ 落设置 `app.web_sidebar_view_mode`；**延迟读**
  （设置服务在窗口装配之后才就绪），非法值回落默认。
- 只换 UA：**session / cookie / 登录态 / 扩展注入全不变**（不变式 S12）。

### 收起之后：先冻结、再回收（面板与侧栏共用同一条链）

"关掉"不等于"销毁"。一个收起的面板/侧栏若只做 `setVisible(false)`，Chromium 只是把它
标成 hidden（**节流**到约 1 次/秒），任务照样在跑 —— 常驻着下载/历史/书签三个面板，
"关了还占 CPU"就是必然。于是走**两段式**：

| 阶段 | 动作 | 代价 | 状态 |
| --- | --- | --- | --- |
| ① 立刻 | **冻结**：CDP `Page.setWebLifecycleState: frozen` | 任务**完全停掉**，后台开销归零 | DOM / JS 堆 / 会话 / 滚动位置**全留** |
| ② 5 分钟后 | **回收**：`destroy()` 掉视图 | 释放渲染进程（真正还内存） | 重开时**重建**，代价是一次加载 |

- 实现只有一份：[`web-contents-freeze.js`](file:///e:/Desktop/OTHER/1A-STAR_Hira/1A-STAR_Hira_NG/infra/infra-window/src/web-contents-freeze.js)
  的 `freezeWebContents` / `thawWebContents`；侧栏在 [web-sidebar.js](file:///e:/Desktop/OTHER/1A-STAR_Hira/1A-STAR_Hira_NG/apps/app-main/src/main/web-sidebar.js) 的
  `close()` / `open()` 调它，面板在 [LayoutCoordinator.js](file:///e:/Desktop/OTHER/1A-STAR_Hira/1A-STAR_Hira_NG/infra/infra-window/src/LayoutCoordinator.js)
  的 `_detachPanel()` / `_placePanel()` 调它 —— **面板的显隐只经这两处**，所以接线只需一处。
- 顺序铁律：**先 `setVisible(false)` 再冻结**（Chromium 只允许不可见页面进入 frozen）；
  重开**先 `setVisible(true)` 再解冻**。
- **只冻 5 分钟**（侧栏；`RETIRE_AFTER_CLOSE_MS`）：收起往往只是"先放一放"，立刻销毁等于
  每次都重新加载（白屏 + 丢滚动）。5 分钟足够走过"随手关一下"的窗口，又不至于让一个关掉的
  东西常驻一辈子。面板不设回收 —— 面板是用户显式的"工作位"，重开频率高，留视图更划算。
- **尽力而为**：Electron 一个 webContents 同时只容一个调试器，**DevTools 打开时 `attach` 会失败**
  → 静默跳过，不报错、不改行为。本模块用一张 `owned` 弱表记"哪些是我们冻的"，`thaw` 只动在册
  的那份 —— **绝不 detach 别人的调试器**（面板与侧栏共用实现的前提）。

---

## 6. 明确不做（本轮）

- **多条目列表**（Vivaldi 的 web panel 列表）：当前侧栏同时只住**一个页面**，靠"在侧栏打开"
  切换。子系统是解耦的（视图/存储/布局各自独立），加"多条目"只需在 `web-sidebar.js`
  内部加一层列表，**不改布局与 IPC 形态**。
- `webview.lifecycle.will-navigate` 官方插槽：那条插槽的载荷是按 `tabId` 的（插件按标签
  决定是否放行），侧栏暂不参与 —— 要参与得先给"非标签网页面"一个稳定身份，属于接口设计问题，
  不是接线遗漏。
- 独立侧栏自己的缩放记忆：当前**刻意**与标签共用（按 origin），同一站点在侧栏与标签
  同一个缩放值 —— 这是想要的行为，不是缺口。

---

## 7. 验收（怎么确认这次是对的）

1. 书签右键「在侧栏打开」→ 侧栏出现、页面**能点能滚能输**、链接有光标、右键有菜单、`alert/confirm` 能弹。
2. 侧栏里登录某站点 → 标签打开同站点 → **已登录**（同 session）。
3. 打开一个面板 + 侧栏 → **两块同时显示**，互不挤掉（S2）。
4. 拖侧栏顶条的把手 → 宽度跟手；**拖侧栏与网页之间那条边（任意高度）→ 同样跟手**；
   鼠标压在那条边上时光标变 `col-resize` 并显出一条与聚焦框同色的高亮线；重启后宽度还在。
5. 顶条「在标签页打开」→ 该页在新标签打开；「关闭」→ 侧栏收起、页面状态保留（再打开还在滚动位置）。
6. `grep panelWeb` 在源码里零命中（只有 `out/` 残留与历史注释）。
7. 点侧栏里的网页 → 四周出现**淡蓝聚焦框**；在侧栏按 `Ctrl+F` → 查找栏落在侧栏上、搜的是侧栏那一页；点回标签网页 → 框熄灭、`Ctrl+F` 回到标签页。
8. 侧栏默认**手机端**版式；点顶条模式按钮 → 切**桌面端**并重载；重启后模式仍在（`app.web_sidebar_view_mode`）。
9. 顶条**只有上面两个角是圆的**，它与网页之间那条接缝处**一个圆角都没有**；
   把主题的「圆角」调到 6 / 10 / 12 → 侧栏整块上下两端的圆角同步变化（顶条跟主题令牌走，不是固定 6px）。
