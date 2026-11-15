# PART13 · NG 缺失功能补全清单

> 口径（用户指令）：
> 只盘点「**副本有、NG 现在没有**」的功能或细节。副本的架构缺陷、底层坏味道、
> 以及两版都有的功能 —— 一律不学、不改、不记录。
> 待做范围：**仅 C1 / R3 / R6**。
>
> **落地状态（2026-09-26）**：
> ✅ **C1 速览标签组 Glance** —— 全链路落地（domain 端口 → 契约 → 通道 → TabManager 编排 → LayoutCoordinator 双视图叠放 → 设置项 → IPC 门控 → tabs-client → tabbar 右键入口 → 撤销关闭复原）
> ✅ **R3 设为默认浏览器** —— 新增 `app:is-default-browser` / `app:set-default-browser` + 设置注册中心新增 `action` 字段类型
> ✅ **R6 外部应用关联设置** —— 新增 `open-external:list` / `open-external:unset` + `setPermissionRequestHandler` 前置分支 + 设置页 `list` 类型分区
> ✅ **D1 弹簧物理动画** —— `SpringBounds` 重新接线到 `LayoutCoordinator`
> ✅ **D2 PiP 可见性退出路径** —— 拆出 `onTabHidden` / `onTabShown`，并修正 `onTabSwitched` 中 `_tabId` 未定义导致 PiP 退出**从未生效**的实现错误
> ✅ **D3 休眠前抓帧** —— `TabManager#_notifyTabWillHide` 抽为唯一采帧入口，`switchTo` / `sleepTab` / `sleepInactive` 三路共用；截帧 TTL 120s → 10min
> ✅ **D4 autofill 日志闸门** —— `AUTOFILL_DEBUG = false`，`trace()` 与 `[ng-fill]` 默认零开销
> ✅ **D5 ui-shell 诊断闸门** —— `HIRA_UI_SHELL_DEBUG=1` 才注册 6 个监听（默认连 `on()` 都不调）
> ✅ **D6 js-dialog 注入去重** —— 只挂 `dom-ready`，删除 `did-finish-load` 重复注入
> ✅ **D7 按键名兜底** —— `event.key → code(KeyA→A) → keyCode` 逐级回退，不再产生 `Ctrl+`
> ✅ **D8 cursor-edge 清理** —— 窗口关闭 `forget(id)`；最后一个窗口退场时 `stop()` 停表
>
> 验证：`pnpm lint` ✅ / `pnpm build` ✅ / `pnpm layer:check` ✅（违规 0，未高于基线）

---

## 0. 前提事实（字节级取证，避免被"副本是更全的激进版"误导）

`1A-STAR_Hira_NG - 副本` = **NG 的早期快照**，不是功能更全的版本：

| 维度          | 结果                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 共有文件哈希  | `same=277  diff=99`                                                                                                                         |
| 仅 NG 有      | `56` 个文件（ts 迁移、新模块、新面板、新 IPC）                                                                                              |
| 仅副本有      | `4` 个文件（`tray-manager.js`、`ipc/cursor-edge.js`、`ipc/snapshot.js`、`js-dialog/dialog-preload.js` —— 全是 NG 已改名/重构/合并的旧形态） |
| IPC 通道      | NG `264` 条，副本 `229` 条；**副本独有 = 0**                                                                                                |
| 设置项        | 副本独有 1 个（`tabs.glance_enabled`）；NG 独有 25 个                                                                                       |
| 快捷键命令 id | 完全一致                                                                                                                                    |

**但那 99 个"内容不同"的文件里，确实藏着 NG 在重构中弄丢的、且对齐 RT 的行为。**
逐行 diff + 全库反查后，真正"副本有 · NG 无"的实质项共 **1 个大项（C1）+ 8 个细节（D1~D8）**，
外加 RT 侧 2 项（R3 / R6）。**D 系列是本轮深查的新增发现，价值普遍高于原清单。**

---

## 一、要做的三项

### C1 速览标签组 Glance（唯一的大功能缺口）

**副本侧已是全链路可用**，逐层取证：

| 层           | 副本位置                                                                                                                                                         | 内容                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain       | `domain/domain-tabs/src/TabGroups.js`                                                                                                                            | 全套纯规则（见下方几何算法）                                                                                                                                                            |
| domain 出口  | `domain/domain-tabs/src/index.js:32 / 43 / 63`                                                                                                                   | `require('./TabGroups')` → `...TabGroups` 展开 → `tabGroups: TabGroups` 端口                                                                                                            |
| 端口注入     | `infra/infra-window/src/TabManager.js:92 / 104-105`                                                                                                              | 构造参数 `tabGroups` → `this._tabGroups` → `this._glance`                                                                                                                               |
| 主进程编排   | `TabManager.js:373 / 404 / 421 / 437 / 454 / 468`                                                                                                                | `_glanceRole` / `createGlance` / `setGlanceFront` / `dissolveGlance` / `_pruneGlance` / `_glanceRoleInfo`；`listAll()` 每个 tab 带 `glance: 'front'\|'back'` 角色                       |
| 生命周期钩子 | `TabManager.js:611 / 762-763 / 856-863 / 957 / 1019`                                                                                                             | 新标签打开即解散速览；切到组内成员→提升 front，切到组外→解散；成员被关闭→自动解散；**组内成员绝不休眠**（否则 back 视图被销毁 → 画面残缺）；撤销关闭用 `restoreGlanceMembership` 复原组 |
| 布局编排     | `LayoutCoordinator.js:75-78 / 156 / 302 / 452 / 477 / 501`                                                                                                       | `showGlance` / `hideGlance` / `_layoutGlanceTabViews`；front 走弹簧、back 直落，**同帧落位避免闪动**                                                                                    |
| 契约         | `infra/infra-ipc/src/contracts/tabs.js:43-45`                                                                                                                    | `glanceCreate / glanceFront / glanceDissolve`（zod，`tabIds` 长度锁定为 2）                                                                                                             |
| 通道         | `packages/shared-types/src/ipc-channels.mjs`                                                                                                                     | `tab:glance-create` / `tab:glance-front` / `tab:glance-dissolve`                                                                                                                        |
| 接线 + 门控  | `apps/app-main/src/main/main.js:20 / 103 / 358`、`snapshot-bootstrap.js:7 / 34 / 46`、`ipc/tabs.js:83-92`（设置开关 + 端口双重门控）、`settings/registry.js:210` | 完整                                                                                                                                                                                    |
| 渲染客户端   | `renderer/shared/tabs-client.js:99-107`                                                                                                                          | `createGlance / setGlanceFront / dissolveGlance`                                                                                                                                        |
| 渲染编排     | `renderer/controllers/tab-session-controller.js:28-35`                                                                                                           | `onGlanceWith / onGlanceFront / onGlanceDissolve`                                                                                                                                       |

**NG 现状**：`TabGroups.js` **与副本字节完全相同（均 4321 字节，零行差异）**，
但 `domain-tabs/src/index.js` 已不再 require 它 —— **整个特性被下架，只漏删了 domain 文件**，
留下的是**不可达的死代码**。`LayerStack.js:26-27 / 40-41 / 79` 还留着
`glance-front`（z=10 / focus=10）、`glance-back`（z=8 / focus=9）常量与 modalTo 名单，同样无生产者。
NG 全库 grep `glance` 仅命中这两处自身；`tabGroups / calculateGlanceBounds / projectGlance /
restoreGlanceMembership / shouldDissolveGlance` 零消费方。

**核心几何算法（`TabGroups.js:57-69`，与 RT 逐参数一致）**

```
width  = floor(max(0, pageW) * (isFront ? 0.85 : 0.95))
height = floor(max(0, pageH) * (isFront ? 1.00 : 0.975))
x = round(pageX + floor((pageW - width ) / 2))
y = round(pageY + floor((pageH - height) / 2))
```

- front：宽 85%（左右各留 7.5%），高 100%
- back：宽 95%（左右各留 2.5%），高 97.5%（上下各留 1.25%）
- 两者相对 `pageBounds` 居中叠放（front 略小在前，back 略大在后）

**解散条件**：`shouldDissolveGlance(tabIds)` → `new Set(tabIds).size !== 2` 即解散。

**撤销关闭复原**：`restoreGlanceMembership({closedRole, restoredTabId, peerTabId})` →
`frontTabId = closedRole === 'front' ? restoredTabId : peerTabId`。

**RT 佐证**：`tab-groups/glance.ts:3`（`GlanceTabGroup`，恒 2 标签、`setFrontTab`）、
`glance.ts:10-15`（`tab-removed` → `tabIds.length !== 2` → `destroy()`，与副本语义一致）、
`tab-layout.ts:159-164 / 196-212`（0.85 / 0.95、1 / 0.975 + `floor` + 居中取整，**与副本完全一致**）、
`recently-closed.ts:44-64`（撤销关闭时 front 归位）、`saving/tabs/{serialization,restore,index}.ts`
（`glanceFrontTabUniqueId` 持久化）、`modules/flags.ts:12 / 36-37`（`GLANCE_ENABLED`，**RT 默认 false**）。

**两点落地前须知**

1. RT 默认关闭该特性（`GLANCE_ENABLED = false`），属实验能力。
2. **副本自身也没有 UI 触发入口**：`ui/**` 全域零 `glance` 命中，`tab-session-controller.js` 传进去的
   三个 `onGlance*` 回调**没有任何消费方（死回调）**。且 RT 的语义是「前台新标签打开时成组」
   （`tabs-controller/index.ts:516-534`：源标签已在速览组 → 新标签入组并置 front；否则以
   「源标签 + 新标签」建组），不是右键菜单。要落地必须**连入口一起补**。

**NG 落点（沿用四层，不新增架构；新文件按 TS 写）**

| 落点                                                                                         | 动作                                                                         |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `domain/domain-tabs/src/index.js`                                                            | 恢复 `require('./TabGroups')`、`...TabGroups` 展开、`tabGroups` 端口         |
| `infra/infra-ipc/src/contracts/tabs.js`                                                      | 补 `glanceProjection` + 三个 schema                                          |
| `packages/shared-types/src/ipc-channels.mjs`                                                 | 补 3 条 `tab:glance-*`                                                       |
| `infra/infra-window/src/TabManager.js`                                                       | 补 6 个方法 + 关闭/切换/休眠/撤销关闭四处钩子                                |
| `infra/infra-window/src/LayoutCoordinator.js`                                                | 补 `showGlance / hideGlance / _layoutGlanceTabViews / _exitGlanceForShowTab` |
| `apps/app-main/src/main/{main.js, snapshot-bootstrap.js, ipc/tabs.js, settings/registry.js}` | 端口注入 + 3 条 route + `tabs.glance_enabled`                                |
| `renderer/shared/tabs-client.js`                                                             | 补 3 个方法                                                                  |
| `renderer/controllers/tab-session-controller.js` + `ui/ui-tabbar`                            | **补 UI 入口**（前台新标签成组语义），把死回调接通                           |
| `domain/domain-session`                                                                      | 速览归属随会话持久化 + 撤销关闭复原                                          |

---

### R3 设为默认浏览器

- RT：`controllers/default-browser`、`ipc/app`（set-default-browser）、
  `settings/sections/general/set-as-default-browser-setting`。
- NG：全库 `setDefaultBrowser | set-default-browser` **零命中**；通用设置里无此入口。
- 落点：主进程新增 `app:set-default-browser` 路由 + `settings/registry.js` 的 `general` 分区新增开关项
  （走注册中心 schema 驱动，不硬编码）。Windows 侧用 `app.setAsDefaultProtocolClient`。
- 优先级：P2。

### R6 外部应用关联设置

- RT：`ipc/app/open-external.ts`（get / unset）、`settings/sections/external-apps`。
- NG：`open-external` 仅在 `node_modules/electron/electron.d.ts` 出现（Electron 原生结构类型），
  NG 自有代码零命中。
- 落点：主进程 `open-external:get / unset` 两条路由 + 设置页新分区（列出已允许的外部协议处理器）。
- 优先级：P3。

---

## 二、深查补充：D 系列（副本有 · NG 无，且对齐 RT）

> 本轮逐行 diff 99 个文件后新捞出的真缺口。**按价值排序，D1 / D2 属于"极致流畅/正确性"核心项。**

### D1 标签 bounds 的弹簧物理动画（NG 里 SpringBounds 成了死 import）

- **副本实现**：`infra/infra-window/src/LayoutCoordinator.js:82`
  `new SpringBounds({ applyBounds: rect => this._applyTabBounds(rect), canAnimate: () => Boolean(this._activeTabId) && !this._win.isDestroyed() })`；
  `:315` 用 `this._tabSpring.setBounds(next, opts.immediate === true)` 驱动标签视图几何；
  `:180` 窗口 resize → `applyInitialLayout({ immediate: true })`（逐帧跟手、零延迟）；
  `:359-360` 休眠/唤醒后 `stop()` + `resetLastAppliedBounds()`；`:514` 速览 front 走同一弹簧；`:916` 销毁时 `destroy()`。
  → **结构性变化（开关面板、切侧栏、全屏、进出速览）走弹簧平滑过渡；resize / 拖拽走 immediate 瞬时落位。**
- **NG 现状**：`LayoutCoordinator.js:47` 仍 `require('./SpringBounds')`，但全库
  `new SpringBounds` / `createSpringBounds` / `_tabSpring` **零命中**；
  `applyInitialLayout()`（`:576`）无 `opts` 参数，直接 `tabView.setBounds(next)`（`:668`）。
  → 弹簧模块（含已对齐 RT 的常量）**完全不可达**。
- **对齐 RT**：是。RT `controllers/tabs-controller/bounds.ts:50` `TabBoundsController`
  （stiffness 300 / damping 30 / 60fps / 阈值 0.01，与 NG `SpringBounds.js` 现有常量逐一对得上）；
  `:114 setBounds`（弹簧）/ `:136 setBoundsImmediate`（瞬时）；调用点 `tab-layout.ts:184-188`。
- **价值**：开关面板、切侧栏、切全屏、进出速览时网页区域是**平滑滑入**还是**生硬跳变** ——
  直接决定"极致流畅"的观感，是本次深查里对体验影响最大的一条。

### D2 「标签可见性变化 → 自动画中画」被合并进单一 hook，丢掉一条退出路径

- **副本实现**：`TabManager.js:140-141` 声明 `onTabHidden` / `onTabShown` 两个独立 hook；
  `:150 _notifyTabVisibility(tabId, visible)` 经它们广播；`switchTo` 里 `:786` 广播旧标签 hidden、`:793` 广播新标签 shown；
  **`close()` 里 `:872` 对接替后变可见的接替标签显式广播 shown**；
  主进程 `main.js:412-417` 分别接 `pipController.enter` / `.exit`。
- **NG 现状**：`onTabVisibility / _notifyTabVisibility / onTabHidden / onTabShown` **全库零命中**。
  NG 把 PiP 折进唯一 hook `onTabWillHide`：`browser-window-runtime.js:221-226` 借此 enter，
  `:192-207` 靠 `onTabSwitched` 才 exit。→ 切标签路径等价，但
  **"关闭活动标签 → 接替标签变可见"这条路径不会触发 PiP 退出**
  （NG 的 `close()` / `_showTab()` 不派发 `onTabSwitched`）。
- **对齐 RT**：是。RT `tab-layout.ts:75-110` 注释即 "PiP enter/exit on **visibility transitions**"：
  `show → exitPictureInPicture()`、`hide → enterPictureInPicture()`（含跨标签互斥 +
  `isTabVisibleInAnotherWindow` 守卫）；实现 `tab-lifecycle.ts:219 / 248`。
- **价值**：关闭正在播放视频的活动标签后，接替标签若此前进入过 PiP，会在**可见状态下仍挂着系统 PiP 小窗**（双重显示，需手动关）。

### D3 休眠销毁 webContents 前先抓一帧（供 hover 缩略图）

- **副本实现**：`TabManager.js:906-907` 在 `this._wcm.sleepTab(id)` **之前**调
  `this._notifyTabWillHide(id)`，注释明确「休眠会销毁 webContents（画面随之消失）→ 销毁前先抓一帧留存」；
  `sleepInactive` 批量休眠同样在销毁前广播。
  主进程 `main.js:405-407` 的 `onTabWillHide` 即 `snapshotService.capture(tabId, wc)`。
- **NG 现状**：`tabLifecycle.js:102-117 sleepTab` 只做 `captureSnapshot`（抓的是 **url + 导航历史**，
  不是画面帧），**不调用** `onTabWillHide`；NG 的 `onTabWillHide` 只在 `TabManager.js:716`（switchTo）触发。
  且 NG 截图仓库 TTL = 120s（`main.js:595`）—— 闲置 5 分钟被休眠的标签，切走时那一帧早已过期。
- **对齐 RT**：否（副本自创，RT `tab-lifecycle.ts:47 putToSleep` 也只抓 url/navHistory）。
- **价值**：休眠标签（内存优化后最容易被 hover 到的一类）能否显示缩略图，还是回落到 favicon。

### D4 autofill 取证日志的「默认关闭」总开关

- **副本实现**：`infra/infra-window/preload/password-autofill/index.js:35`
  `const AUTOFILL_DEBUG = false`；`:127 if (!AUTOFILL_DEBUG) return` —— `trace()` 默认构建下直接短路，
  注释写明「每次事件都会 JSON.stringify + console.log，在页面主线程上是一笔可观开销（DevTools 打开时尤甚）」。
- **NG 现状**：`AUTOFILL_DEBUG` **全库零命中**；`index.js:123-127 trace()` 无门控，
  且 `fillWith` 每次填充都无条件 `console.log('[ng-fill]', JSON.stringify({...}))`（`:166-174`）。
- **对齐 RT**：否（副本自创）。
- **价值**：登录页/表单站点的页面主线程日志噪声与序列化开销（默认构建应当关掉）。

### D5 UI shell 诊断钩子的「默认关闭」闸门

- **副本实现**：`apps/app-main/src/main/ui-shell-diagnostics.js:3`
  `const ENABLED = process.env.HIRA_UI_SHELL_DEBUG === '1'`；`:6 if (!ENABLED || !webContents) return`；
  注释「默认关闭（避免每条 console 消息都走一遍主进程日志造成阻塞）」。挂 6 个监听。
- **NG 现状**：同文件 `:1-2` 已无 `ENABLED`，退化为 `if (!webContents) return`；
  `main.js:46` require、`:578 attachUiShellDiagnostics(uiShellWebContents)` **无条件调用**；
  全库 `HIRA_UI_SHELL_DEBUG` 零命中。
- **对齐 RT**：RT 无此钩子，无对应实现。
- **价值**：NG 下 ui-shell 渲染进程的**每条** console + 每次加载事件都经主进程 stdout 串行打印。

### D6 js-dialog 注入去重（去掉 `did-finish-load` 兜底注入）

- **副本实现**：`js-dialog/dialog-inject.js:95-99` 只挂 `dom-ready` 一次，并写明理由：
  同一文档 `did-finish-load` 会**再跑一次** `executeJavaScript`，脚本内 `__jsDialogOverridden`
  自守卫只挡重复改写、挡不住这次多余注入。
- **NG 现状**：`dialog-inject.js:95-102` 同时挂 `dom-ready` 与 `did-finish-load`，
  两处都调 `injectNow → webContents.executeJavaScript(code, true)`（见 `:76`）。
- **对齐 RT**：RT 无 js-dialog 注入实现。
- **价值**：每个可弹原生对话框的文档多做一次主世界脚本解析 + 执行。

### D7 主进程按键组合的键名兜底

- **副本实现**：`keybindings.js:93-94`
  `const key = event.key || event.code?.replace(/^Key/, '') || event.keyCode`，再 `normalizeKey(key)`。
- **NG 现状**：`keybindings.js:102` 仅 `normalizeKey(event.key)`；
  `normalizeKey`（`:52-57`）对空值回落到空串 → 退化成 `Ctrl+` 这类永不匹配的串。
- **对齐 RT**：RT 无按键映射实现。
- **价值**：`event.key` 缺失/为空（IME、部分键盘布局、合成事件）时，快捷键静默失效。

### D8 cursor-edge monitor 在窗口关闭时不清理

- **副本实现**：`main.js:292-296`
  `win.on('closed', () => { cursorEdgeMonitor.forget(win.id); cursorEdgeMonitor.stop() })`，
  注释「窗口关闭即停轮询并清理该窗口状态，避免 Map 悬挂 / 定时器泄漏」。
- **NG 现状**：`main.js:610-624` 建 monitor，除 `ipc/cursor-edge.ts:43-44`（渲染层开关）外
  **再无 `forget / stop` 调用**；`infra/infra-window/src/CursorEdgeMonitor.js:119-122` 的 `forget(windowId)`
  文档写着「窗口关闭时清理其状态，避免 Map 无限增长」→ **该 API 在 NG 已是死代码**
  （`tab-drag-controller.js:284` 的 `monitor.forget` 是另一个独立实例，只管拖动）。
- **对齐 RT**：RT src 未含 cursor-edge-monitor，无对应可证。
- **价值**：`cursorInside` Map 按 windowId 只增不减；窗口全关后 30fps 轮询不再被停。

---

## 附录 A · 取证方法（可复现）

1. **全库字节级对比**：范围 `apps/app-main/src/{main,renderer,pages}`、`domain`、`infra`、`ui`、`packages`，
   `Get-FileHash -Algorithm MD5` 逐文件比对（排除 `node_modules/out/dist`）→ `same=277 diff=99`。
2. **IPC 通道对比**：抽 `packages/shared-types/src/ipc-channels.mjs` 的值集合 → NG 264 / 副本 229，副本独有为空。
3. **逐行 diff 取「副本独有行」**：
   `Compare-Object (Get-Content -LiteralPath <NG>) (Get-Content -LiteralPath <副本>) -CaseSensitive |
 Where-Object SideIndicator -eq '=>'`
   → 得到 99 个文件的副本独有行（TabManager 653 / main.js 348 / LayoutCoordinator 288 /
   context-menu 238 / spaces.js 145 / WebContentsManager 81 …）。
4. **反查**：对每处候选在 NG 全库 grep（函数名、注释关键词、字符串常量、通道名、设置 key）确认
   "真没有"还是"已搬迁但语义变了"；必要时读搬迁目标文件核对语义。
5. **RT 佐证**：在 `1A-STAR_Hira_RT/src` 定位对应实现，比对参数/阈值/注释语义。

## 附录 B · 已核实为非缺失（NG 有意移除或已超越，无需处理）

一行一条：

- `warmupPanels()` → NG 有意删除（`WebContentsManager.js:417` 注释「启动期绝不预热任何面板 renderer」）
- `peekTabWebContents()` → 现有查询路径 + 休眠回收替代
- `TabPreview.HIDE_DELAY_MS=400` 宽限期 → NG 有意改成立即关闭（跟手性优先）
- `refreshTabInsights()`（每次变更 2 次 IPC）→ NG 改为本地派生统计
- `resolveSnapshot / snapshotUrl` → NG 改为 16:9 裁切 + 代际守卫 + 异步取帧
- `LayerStack#pickFocusTarget / modalBlockers / computeRestackPlan` → 搬入 `LayerManager.js` 并升级
- `WindowFactory` 启动期 eager 建浮层 → NG 改为惰性创建（省 5 个启动渲染进程）
- `contracts/window.js` 阻塞式 popupMenu → NG 改为即时 ack + `ui:popup-menu-selected` 事件
- `download-manager.js` MCD 空壳 → NG 已真正启用多线程下载（含原子 rename 与崩溃清扫）
- `settings/appliers/privacy.js` 常驻钩子 → NG 改为按需安装/拆除
- `verification/p0-check.js` 的 `execSync grep` → NG 改为纯 Node 遍历（副本在 Windows 上静默全绿）
- `dialog-overlay.js` 裸 `new BrowserWindow` → NG 改走 `createSubWindow`/WindowFactory
- `js-dialog/index.js` → 两版都实现了 promise-hold，差异仅在注释
- `domain-session`（navHistory 落盘、`saveAsync`、`MIN_STACK_MEMBERS`、过度栈裁剪）、
  `domain-password`（真 keychain 后端 + `isOsKeychain()`）、`domain-bookmark`（`faviconPort`）、
  `domain-favicon`（`removeBefore` 淘汰）、`domain-space`（`move`）、`domain-tabs/TabRules`（audio 豁免）
  → 全部是 NG **新增**能力（反向差异）
- `ui-panel-profiles` 配置文件行内编辑 → NG 有意收敛到 `hira://spaces` 管理页，
  且 RT 同样是独立管理页（`settings/sections/spaces/space-editor.tsx`），NG 方向与 RT 一致
- 空间色块「渐变双色」→ **NG 才是双色方**（`gradientOf()` + 8 组 PALETTES），副本是单色；
  RT 数据模型 `spaces-controller/raw.ts:31-32` 即 `bgStartColor/bgEndColor`，NG 对齐 RT
- `ui/**` 其余差异 → 均为 z-index 硬编码 → `--hira-z-*` token 化（纯风格）
- `packages/shared-types/ipc-channels.mjs` 副本独有 2 行 → 同一通道重复声明，NG 已去重
