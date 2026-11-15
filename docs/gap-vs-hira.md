# 对比 Hira / HiraRT 的功能缺口盘点（Gap Analysis）

> 范围：`1A-STAR_Hira_NG`（Hira 浏览器插件化/模块化 fork）
> 基线：`.hira-ai/l1-functions.json` + `l1-coverage-tracker.json`，门禁 `scripts/check-function-coverage.cjs`
> 数据点：covered = 696 / 1234（56.4%），identified = 695 / 695（100%），errors = []（取自最近一次 `pnpm fn:coverage` 运行）
> 结论性质：基于「功能点登记 → NG 绑定 → 真实实现 + 测试」三态口径的静态盘点，以及 Hira/HiraRT 能力基线的差距映射。

---

## 1. 口径与方法

门禁将功能点按下述状态统计：

- **covered**：具备 `name/category/source`，并绑定真实 `ng`（服务方法、域方法、服务字段、IPC 或 provider），同时具备测试证据。
- **identified 未 covered**：已命名并完成 NG 绑定，但仍处于 `planned`、`partial` 或 `blocked`。
- **空槽**：catalog 中没有功能身份、来源或 NG 绑定；仅由 tracker 的空对象预留 ID。

因此「登记 ≠ 实现」。目前已登记的 695 项均已覆盖（covered=696 中另有 1 项已覆盖但无独立 catalog 身份）；余下 539 个槽位仍是待识别容量，不能将其误报为已知缺陷。

> **精确计数（本轮复核，只读统计）**：tracker 共 1234 槽位 → **528 个为空对象 `{}`**、**10 个仅 `{"status":"planned"}`**，合计 **538 个槽位从未被定义**（没有 name / source / category）；其余 696 个均为 `covered`（其中 695 个在 catalog 中有身份、1 个无身份）。catalog（`.hira-ai/l1-functions.json`）只定义了 **695** 个功能点，且这 695 个**全部已覆盖**（`identifiedPercentage: 100`）。

---

## 2. 已完成的关键垂直能力

### 2.1 主题 / 暗黑模式第一阶段

- 已实现亮色、暗色、跟随系统的主题解析与设置链路。
- renderer 已消费主题设置并使用统一 CSS 变量。
- ✅ **实时广播已补齐**：主进程 `apps/app-main/src/main/theme-runtime.js` 监听 `nativeTheme.updated`，经 `themeManager.onChange` 向全部 webContents 广播 `theme:changed`（原「尚待补齐」已失效，详见 §4.2）。
- 全部 rail/panel/overlay 的动态跟随仍按回归清单持续核查。

### 2.2 标签分组 / 堆栈第一阶段

- `domain-tabs` 已提供堆栈投影、折叠/展开规则。
- `TabManager` 已保存 stack metadata，并以 projection 方式输出给标签栏。
- 已具备 stack create、set、toggle 的 typed IPC、provider、renderer client 与 tabbar 消费链路。
- ✅ **重命名、颜色、合并/解散已补齐**：`domain/domain-tabs/src/TabStacks.js` 提供 `renameStack` / `setStackColor` / `mergeStacks` / `dissolveStack`，对应 IPC 见 `apps/app-main/src/main/ipc/tabs.js`（`tab:stack-rename` / `tab:stack-set-color` / `tab:stack-merge` / `tab:stack-dissolve`），通道注册于 `packages/shared-types/src/ipc-channels.mjs`。
  （domain 另有 `splitStack`＝把**部分**成员迁到另一个新组；它没有 UI 入口，因此也没有对应 IPC —— 菜单上曾经拿它冒充"拆分标签组"，点下去外观一字不变，表现为"点了没反应"，已换成上面的 `dissolveStack`。）
- ✅ **第二阶段已补齐（2026-10-17 核实）**：栈内排序 UI 拖拽、tab 与 stack 的拖拽加入/脱离、stack metadata 随 session 持久化 —— 三者在代码里**全部已存在**（原「尚待补齐」已失效，详见 §4.1）。
- ✅ **分屏 × 栈正交共存（2026-10-17 起）**：分屏标签可以加入标签栈（旧「分屏胜栈」裁决已废除，`detachSplitMembersFromStacks` 删除；菜单「并入/堆叠」对分屏成员照常出现）。分屏标签自 2026-10 起改为 **Edge 式合体**：横向是两半拼成一条宽（×`--ng-tab-split-scale` 1.45）、无缝隙无内圆角、不画连接带；纵向 / panel 同样并排合体（一整段 = 一条正常行宽，N 等分），旧的左/右缘指示条与 `splitBand` 整族删除。标签下方凹槽只归标签组下划线独享。详见 `docs/split-view-design.md` §10.10③、§10.19。

### 2.3 快捷键设置

- 主进程是唯一快捷键执行源，支持格式校验、动作校验、冲突检测、热更新、单项重置和默认恢复。
- Shell 与标签 WebContents 均已接入。
- 已提供真实设置子窗口 UI，可录制快捷键、取消录制、提示冲突并恢复默认。
- 已补 handler 与 manager 回归测试。

### 2.4 Session 恢复与管理

- `SessionRestoreService` 已支持原子保存、sanitize、URL 去重、200 标签上限、固定标签和活动标签恢复。
- 已接入启动恢复、Profile 切换前保存/切换后恢复、标签变化防抖保存及退出保存。
- 已实现 renderer 不暴露 Profile 文件系统目录的 typed IPC：read、stats、save、restore、clear、exists。
- 已通过 session provider plugin 暴露能力，并在主界面菜单提供真实 Session 管理子窗口。
- 管理窗口支持查看标签/固定标签数量及当前 Profile 会话状态，执行立即保存、恢复、清除。

### 2.5 本轮新完成的垂直能力（均有代码依据）

- **原生应用菜单**：`apps/app-main/src/main/app-menu.js`（`createAppMenu`，加速键 `registerAccelerator:false`，按键仍由 keybindings 独占），在 `main.js` 装配并 `appMenu.install()`。
- **命令面板（已移除）**：曾位于 `apps/app-main/src/pages/command-palette/`（窗口类型 `command-palette`，快捷键 Ctrl+Shift+P）；因点击无响应已彻底移除，相关快捷键、窗口类型、页面目录与菜单入口全部清理。
- **内容拦截接线**：`infra/infra-extensions/src/index.js` 的 adblocker 后台初始化（`@ghostery/adblocker-electron`，就绪后与用户意图对齐），`main.js` 以 `enableAdblocker: true` 注入。
- **标签缩略图**：`infra/infra-window/src/SnapshotStore.js` + `apps/app-main/src/main/tab-snapshot.js`，通过 `hira://tab-snapshot?id=<id>` 提供内存 JPEG。
- **光标边缘唤出 / rail 占位唤出**：`infra/infra-window/src/LayoutCoordinator.ts#_syncRailRevealWatch`（主进程指针巡看，不依赖 renderer hover）。
- **更多窗口类型接真实内部页**：`apps/app-main/src/main/window-config.js` 的 `WINDOW_TYPES`（29 类）+ `apps/app-main/src/pages/**`（about/downloads/history/bookmarks/extensions/passwords/permissions/clear-data/task-manager/page-info/view-source/certificates/import-data/cookies/color-picker/update/crash-report 等真实页面）。
- **新 IPC 域**：cookies / browsing-data / app:metrics / app:info / page:info / page:view-source / crash:list / certificate:list（注册见 `apps/app-main/src/main/ipc-routes.js`）。
- **设置项入口与 applier 补齐 + 启动期开关接线**：硬件加速（`main.js` `app.disableHardwareAcceleration` 按设置）、平滑滚动（`performance.smooth_scrolling`）、启动页（`app.startup_mode` / `app.startup_page`）、无障碍（`accessibility.*`）、后台节流/内存回收（`settings/appliers/performance.js`）。
- **p0 验证脚本跨平台重写**：`apps/app-main/src/main/verification/p0-check.js`（11 项 P0 根除验证 V1–V11）。

### 2.6 本轮再新增的垂直能力（均有代码依据）

- **事件订阅登记制广播（架构变更）**：新增 `infra/infra-ipc/src/ListenerRegistry.js`（`createListenerRegistry`）与 `infra/infra-ipc/src/index.js`（`createBroadcaster`，`send(route, payload, { skipWebContentsId })`）；新增 `apps/app-main/src/main/ipc/listeners.js`（`registerListenerIpc`）、契约 `infra/infra-ipc/src/contracts/listeners.js`、通道 `listeners:add` / `listeners:remove`。三个 preload（`infra/infra-window/preload/{shell,panel,tab}-preload.js`）的 `on.subscribe` 发登记消息；`main.js` 的 `emit` 改为 `broadcaster.send`；`settings/sync.js`、`ipc/bookmark-events.js`、`ipc/history-events.js` 的广播接口从「传 webContents 列表」改为「注入 `send`」。
  - **顺带修掉的真 bug（此前文档未记录）**：过去「只广播 chrome 层」的过滤把内部页排除在外 —— 跑在**标签页**里的 `hira://bookmarks` / `hira://history` 订阅了 `bookmark:changed` / `history:changed` 却永远收不到事件；登记制后只要订阅就收得到。
- **UA 去 Electron 痕迹**：`apps/app-main/src/main/user-agent.ts`（`buildSpoofedUserAgent` / `applySpoofedUserAgent`），`main.js` 在 app ready 前设 `app.userAgentFallback`，去掉 `Electron/…`、`hira-ng/…` token。
- **标签归档（RT 的第二条回收腿）**：`infra/infra-window/src/tabLifecycle.js`（`archiveTab` / `archiveInactive`）+ `TabManager.close(id, { skipUndoStack })` + `module-bootstrap.js` 的 auto-sleep 定时器「先归档后休眠」+ 设置键 `tabs.archiveAfter`（默认 `never`，取值 never/12h/1d/7d/30d）。
- **标签栈**：`domain/domain-session/src/sessionUtil.ts`（`pruneDegenerateStacks` / `MIN_STACK_MEMBERS`，恢复侧丢弃成员 <2 或引用不存在标签的栈）+ `SessionRestoreService` 二次校验 + `renderer/controllers/tab-session-controller.js` 拖拽分流（拖 `.tab-stack-chip` → `tab:stack-set`；拖间隙 → `tab:reorder`）。
- **HTTP Basic / 代理认证弹窗**：`apps/app-main/src/main/http-auth.js`（`createHttpAuthManager`，注册 `app.on('login')`）+ `ipc/http-auth.ts` + `pages/http-auth/**` + 窗口类型 `HTTP_AUTH`（`window-config.js`）+ 通道 `http-auth:ready|submit|cancel`。非 modal、FIFO 一次一个、90s 超时、关窗即取消、requestId 防并发串号。
- **UI 层级门禁**：`packages/shared-ui-tokens/layers.css`（`--hira-z-*` 8 档语义层）+ 包入口 `UILayer`（`packages/shared-ui-tokens/src/index.js`）+ `scripts/check-z-index.cjs` / `pnpm layer:styles`（0 违规）。
- **托盘契约变更（按用户决定）**：`apps/app-main/src/main/tray-manager.js` 已删除；`CONTRACT-18` 已改为「关闭窗口红按钮 = 关闭即退出进程」。

---

## 3. 分域覆盖总览

| 域              | 已识别（catalog） | 判读                                                             |
| --------------- | ----------------: | ---------------------------------------------------------------- |
| download        |               100 | 成熟，保守维护并补极少边界                                       |
| bookmark        |                76 | 主体与备份链路均已登记                                           |
| tabs            |                99 | 第二阶段全部完成（栈内排序拖拽/拖入拖出/session 持久化）+ 分屏 × 栈正交共存 |
| password        |                83 | 保存、建议、遮罩、自动填充、强度已接线，待边界补齐               |
| permission      |                65 | 站点汇总与敏感标记已接线，待批量能力                             |
| search          |                55 | 主体可用，待边界与测试扩展                                       |
| session         |                31 | 完整保存/恢复/管理链路已接线，待会话命名和搜索等增强             |
| history         |                38 | IPC 与 panel 已登记，待服务事件与批量能力                        |
| extensions      |                47 | 加载规则与基础内容拦截（adblocker）已接线，待真实运行面完善      |
| profile         |                32 | 数据分区已实现；UA/指纹伪隔离按当前优先级后置                    |
| settings        |                32 | 类型化设置、主题与启动期开关已接线                               |
| keybindings     |                 3 | 功能已完成但历史 ID 段无剩余空槽可用于补登记                     |
| bookmark-backup |                 3 | 备份特性模块已接线                                               |
| external-games  |                 1 | 外部 bundle 协议与目录读取已接线                                 |
| infra           |                30 | IPC 契约与基础设施相对完整                                       |

> 数字取自最近一次 `pnpm fn:coverage` 的 `identifiedByCategory`（identified 合计 695、errors=[]）；各域槽位容量见 `.hira-ai/l1-functions.json` 的 `segments`（多数域 99 槽，keybindings 3、bookmark-backup 3、external-games 1、infra 35）。

---

## 4. 当前高优先级缺口

### 4.1 标签堆栈第二阶段（✅ 已完成，2026-10-17 核实并补齐）

已在既有 domain → TabManager → typed IPC/provider → renderer 投影链路上完成：

- ✅ stack 重命名与颜色（`tab:stack-rename` / `tab:stack-set-color`）；
- ✅ stack 合并、解散（`tab:stack-merge` / `tab:stack-dissolve`）；
- ✅ 栈内顺序调整的 UI 拖拽 —— `ui-tabbar/src/view/dropController.js` 同栈互拖走插入排序
  （domain `reorderTabs` 同栈重排保留 stackId），经既有 `tab:reorder` IPC，无需新通道；
- ✅ tab 与 stack 的拖拽加入、脱离 —— dropController 五通道（空白=出栈 / 组外散标签=先出栈
  再重排 / 芯片或组内标签=并入 / 修饰键=堆叠 / 间隙=reorder），接线于
  `apps/app-main/src/renderer/controllers/tab-session-controller.js` 的 `onDragEnd`；
- ✅ stack metadata 随 session 保存与恢复 —— `SessionRestoreService` 保存时带
  `listStacks()`（label/accent/collapsed），恢复时 `createStack({tabIds, label, accent, collapsed})`，
  `sessionUtil.sanitizeSessionRecord` 保留 stackId 并按 MIN_STACK_MEMBERS=2 收紧；
- ✅ **分屏标签可加入标签栈**（本轮新做）—— 废除「分屏胜栈」裁决，两者正交共存；
  解除点：`tabLayout#enforceSplitRuns`（摘除函数删除）、`TabManager#dropTabOnContent`（出栈块删除）、
  `tabContextMenu#canStackNext`（`!t.splitId` 守卫删除）；渲染侧横向分屏改为合体标签
  （`in-split-run` 三段类名 + 半宽/无内圆角/负 margin 消缝，横向连接带下线），
  标签下方凹槽归组下划线独享。详见 `docs/split-view-design.md` §10.10③、§10.19。

验收：标签可被拖入/拖出栈，组名和颜色可编辑，折叠状态及分组在 Profile session 恢复后保持；
分屏标签可正常入栈，合体标签与标签组下划线互不干扰。

### 4.2 系统主题动态同步（✅ 已完成）

- ✅ 监听 Electron `nativeTheme.updated`（`apps/app-main/src/main/theme-runtime.js`）。
- ✅ 当设置为 system 时向所有 webContents 广播解析后的主题（`theme:changed`）。
- ⏳ 让 subwindow、rail、panel、overlay 共用 renderer theme helper 的逐窗口回归仍待持续核查。

验收：系统主题改变时，无需刷新即可同步主窗口和已打开子窗口。

### 4.3 Extensions / History / Permission 的运行面与边界

- extensions：扩展列表/开关/移除之外，完善加载、注入和运行状态反馈。
- history：最近 N 天、分组、批量清理与事件一致性。
- permission：站点维度批量授权、危险权限提示与默认规则管理。

---

## 5. 后置项

- ~~命令面板。~~ ❌ **已移除**：曾实现的原生菜单入口 + 命令面板内部窗口（`apps/app-main/src/pages/command-palette/`，Ctrl+Shift+P）因点击无响应已彻底移除，快捷键 `command-palette:open`、窗口类型 `COMMAND_PALETTE`、页面目录与菜单项全部清理。
- ~~全局 UA 去 Electron 痕迹~~ ✅ **已实现**：`apps/app-main/src/main/user-agent.ts`（`buildSpoofedUserAgent` / `applySpoofedUserAgent`）+ `main.js` 设 `app.userAgentFallback`（一处设置对所有 session 生效）。
- Profile 的**逐 Profile** UA / 指纹伪隔离（全局去 Electron 痕迹已完成；此处指按 Profile 切换 UA / 指纹）。

Profile 的逐 Profile UA / 指纹伪隔离按当前产品优先级不作为核心阻塞项；Profile 基础数据分区继续保持可用。

---

## 6. 登记与验证规则

1. 新增真实能力必须同时具备 domain/service/provider 或 IPC 的可追溯绑定及真实测试。
2. 未识别的容量保持空槽；已经识别但未完成的能力登记为 `planned` 或 `partial`，不伪造 covered。
3. IPC 登记采用按功能段分配最低可用 ID 的批次方式；历史上曾补登记现有 typed IPC 使覆盖由 571 提升（当前已增至 covered=696，见文首数据点）。
4. 每个功能批次完成后运行：
   - `pnpm test`
   - `pnpm lint`
   - `pnpm build`
   - `pnpm layer:check`
   - `pnpm fn:coverage`

当前 `fn:coverage` 仍因总目录尚有未识别空槽而非零退出；其数据校验 `errors` 保持为空，且所有已识别项覆盖率为 100%。

> **闸门不可达的事实（如实记录，不要粉饰）**：该闸门要求 **1234 全部覆盖**，但 1234 个槽位里 **538 个从未被定义**（528 个空对象 `{}` + 10 个仅 `{"status":"planned"}`，都没有 name / source / category），catalog 只定义了 **695** 个且**全部已覆盖**。也就是说缺的是 538 条功能点**定义**，不是 538 个**实现** —— 故语义上无法靠「补齐实现」达成。
>
> **待决策（由用户决定，本文档不代做选择）：改写闸门口径（按已识别数计算）或补齐 538 条功能点定义。**
