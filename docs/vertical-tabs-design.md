# 垂直标签页模式 · 功能与设计规划（Hira NG）

> 状态：**设计稿 v3（待评审，未开工）**
> 第一实现参考：**HiraRT（Flow Browser / STAR-HiraX）** —— 原生垂直标签（Arc / Zen 血统，地址栏在侧栏内）
> 范式参考：**Zen Browser**（它自己就有「单栏 / 多栏」两种垂直布局）· **Arc** · **Edge**（地址栏留在顶部那一型）· **Vivaldi**
> 读者：实现者 / 后续接手的模型。本文只回答「做成什么样、怎么落地」，不含代码。
> 相关既有文档：[docs/gap-vs-hira.md](./gap-vs-hira.md)、[docs/animation-language-vs-hira.md](./animation-language-vs-hira.md)

---

## 0. 结论先行

**① 垂直标签栏 = 侧栏（Sidebar）。**HiraRT 的原生垂直标签就是这么做的：标签列、固定标签网格、空间切换器、地址栏全住在一个侧栏里。

**② 「默认布局 vs 垂直布局」不应靠模式枚举区分，而应由「有没有块住在侧栏」自然得出。**
NG 现有模型是「**块**（tabbar/navbar/titlebar/bookmarkbar）+ **位置**（top/bottom）+ 同侧顺序」。
只要把「位置」这一维从 `top/bottom` 扩成 `top/bottom/side`，那么：

> **一个块都没选 side → 默认（经典）布局；有块选了 side → 垂直布局。**

不需要新的 mode 枚举，也不会出现「模式=垂直 但某块位置自相矛盾」的状态。

**③ 你要的两个垂直子模式 = 同一套「块→区域」映射的两个预设：**

| 子模式                           | 谁住侧栏            | 顶部还剩什么                                   | 对标                                                 |
| -------------------------------- | ------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| **V2 · 侧栏标签（Edge 型）**     | 只有 `tabbar`       | 地址栏那一行（navbar）完整保留                 | **Edge、Vivaldi、Zen 的 Multiple/Collapsed Toolbar** |
| **V1 · 全功能侧栏（All-in 型）** | `tabbar` + `navbar` | 只剩窗口控制条 / 标题栏 / 书签栏（按各自设置） | **HiraRT、Zen 的 Single Toolbar、Arc**               |

**④ 三条可实现性结论**（均有一手证据）：

- **零新增 IPC 通道**：`setPageLayoutParams` 已带 `sidebarWidth / sidebarSide / sidebarVisible / sidebarAnimating`（与 RT 的 `PageLayoutParams` 逐字段同构）。
- **标签列表可整套复用**：`ui/ui-common/src/tabRowList.ts#createTabRowList`（open-tabs / pinned 两个面板共用）。
- **侧栏两种显隐都有现成机制**：常驻 = 外壳内的区域容器；自动隐藏由计划里的
  `revealOverlay` 分成**两型**（判据只在 `plan.side` 的 `autoHide / restWidth /
  revealWidth / revealOverlay`）：
  · **Edge 型**（只住标签列）→ 静止是一条图标 rail（照常占位 56px），展开是**覆盖网页的
    独立浮层** `renderer/sidebar-float`（网页不缩进、不重排）；
  · **全功能型**（导航栏也住侧栏）→ 静止宽 0，唤出时同一块侧栏区域改宽、网页真让位。
  指针巡看在主进程（见 architecture §6.1）；两型共用**一份装配图**
  （`renderer/shared/sidebar-surface.js`），不存在各画一套。

---

## 1. 参考实现（一手核实）

### 1.1 HiraRT（Flow Browser）—— 原生垂直标签，地址栏在侧栏内

README 自述 **「Design inspired by Arc Browser and Zen Browser」**，Upcoming 里写着
`Topbar: Allow you to customise between a topbar or sidebar.`；源码注释原话：
`ephemeral?: boolean; // true for pinned-tab-associated tabs that shouldn't appear in the sidebar tab list`。

| 维度                | RT 的做法（文件 / 常量）                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 侧栏即标签栏        | `src/renderer/src/components/browser-ui/browser-sidebar/`（`component.tsx` / `inner.tsx` / `provider.tsx` / `floating-sidebar-trigger.ts`）                                                                                                                                                                                |
| 侧栏内分区（上→下） | 空间标题 `space-title.tsx` → 地址栏 `address-bar.tsx` + 导航 `navigation-controls.tsx` + 站点控制 `site-controls/` → **固定标签网格** `pin-grid/` → 标签列表（滚动区 `sidebar-scroll-area.tsx`，含 `tab-group.tsx` / `drop-indicator.tsx` / `tab-drop-target.tsx`）→ 底部 `bottom/{space-switcher,bottom-extras-menu}.tsx` |
| 五态模式机          | `'attached-left' \| 'attached-right' \| 'floating-left' \| 'floating-right' \| 'hidden'`（`provider.tsx:78`）；`forceFloating` = 强制浮出（Edge 的 unpin 语义）                                                                                                                                                            |
| 宽度（实测）        | `MIN 150` / `DEFAULT 200` / `MAX 500`（`provider.tsx:9-11`）；容器宽 = 面板宽 **+30px**（把手与呼吸区）                                                                                                                                                                                                                    |
| 宽度持久化          | `localStorage['BROWSER_SIDEBAR_SIZE']`，50ms 防抖 + `beforeunload` flush（`provider.tsx:31-74`）                                                                                                                                                                                                                           |
| 占位态              | `PixelBasedResizablePanel` 在 chrome 视图 DOM 内占位，收起用 **margin** 动画（`ml-0 ⇄ -ml-[var(--panel-size)]`）                                                                                                                                                                                                           |
| 覆盖态              | `PortalComponent`（独立浮层图层，`zIndexes.floatingSidebar = 30`）：`fixed; top:topbarHeight; left/right:0; width:size+30; height:calc(100vh - topbarHeight)`，`translate-x` 进出场，毛玻璃卡片                                                                                                                            |
| 动画                | `SIDEBAR_ANIMATION_DURATION_MS = 100` + `cubic-bezier(0.4,0,0.2,1)`；**主进程镜像插值**（~30fps tick，用渲染层 `Date.now()` 对齐时钟域）；浮出态取消插值                                                                                                                                                                   |
| 布局契约            | `PageLayoutParams = { topbarHeight, topbarVisible, sidebarWidth, sidebarSide, sidebarVisible, sidebarAnimating, contentTopOffset }`                                                                                                                                                                                        |
| 自适应顶栏          | `adaptive-topbar.tsx`：win/linux **30px**；darwin + 侧栏在右 34px；**darwin + 侧栏在左 0**（窗口按钮进侧栏）                                                                                                                                                                                                               |
| 固定标签            | `pin-grid/`：列数自适应 `use-pin-grid-columns.ts`、落点吸附最近格边缘 `find-closest-pin-edge.ts`、布局动画、老虎机插入动画                                                                                                                                                                                                 |
| 固定标签模型        | `PersistedPinnedTabData`（profile 级）+ `associatedTabIdsBySpace`（每空间一个活实例）；关联标签 `ephemeral`，不在列表里重复出现                                                                                                                                                                                            |
| 标签组              | `TabGroupMode = 'normal' \| 'glance' \| 'split'`（垂直侧栏里的「组」= 分屏 / 悬浮预览）                                                                                                                                                                                                                                    |
| 浮出锁定            | 侧栏内有 popover 打开时锁定浮出，鼠标移出也不收（`provider.tsx:186-197`）                                                                                                                                                                                                                                                  |
| 拖动期锁定浮出      | **拖动标签期间冻结唤出**（`LayoutCoordinator#setSideRevealHold`，由 `tab-drop-zone` 的 `onSessionChange` 驱动）：指针离开保持圈也不收 —— 拖拽源视图一旦被收成 0×0，原生拖拽会被系统取消、`dragend` 丢失，落位框与活动标签就"黏住"了（见 `docs/tab-drop-zone-design.md` §3.5b）                                                                                                       |
| 图层/焦点           | `shared/layers.ts`：`UILayer` + `zIndexes`（omnibox 100 / popover 99 / **floatingSidebar 30** / tab 10 / browserUI 0）+ `focusPriorities`（floatingSidebar = 0，不抢焦点）                                                                                                                                                 |
| 边缘唤出            | `LayoutCoordinator#_syncRailRevealWatch`（主进程轮询，与全功能侧栏占位唤出同源）                                                                                                                                                                          |

### 1.2 RT 踩过的坑（直接抄结论）

| 坑                             | 结论                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 浮层视图里进场动画不动         | 用**元素所属 window 的 rAF**（主窗口 rAF 与浮层 paint 不同步）＋ 强制 reflow ＋ **双 rAF** 才打开 transition |
| 主进程 bounds 只 snap 不 tween | `setVisible` 与 `startAnimation` 必须**同一次同步调用**发生，否则 `isAnimating` 与新宽度分两帧到达           |
| 浮出态还在插值                 | 浮出态**取消插值**（覆盖层零布局影响，bounds 应瞬间到位）                                                    |
| resize 节奏                    | 重站点每次 viewport resize 都贵 → 主进程 **~30fps** 采样插值即可，chrome 在 CSS 层继续平滑                   |
| 新旧动画互相打断               | 动画用 **uuid 计数**，`stopAnimation(id)` 只清自己那条                                                       |
| 两态交接闪烁                   | `skipEntryAnimation`：`attached ⇄ floating` 是**原地交接**，不播进场动画、不插值                             |
| 每帧上报尺寸                   | 只在 `resize` + `pointerup` + 一次 `rAF` 触发，不轮询                                                        |

### 1.3 逐家形态对照（**这就是两个子模式的来源**）

| 家                          | 标签在哪                 | 地址栏在哪                         | 顶部还剩什么                                     | 归类    |
| --------------------------- | ------------------------ | ---------------------------------- | ------------------------------------------------ | ------- |
| **HiraRT（Flow）**          | 侧栏                     | **侧栏内**                         | 30px 窗口条（mac 侧栏在左时为 0）                | **V1**  |
| **Zen · Single Toolbar**    | 侧栏                     | **侧栏内（紧凑地址栏，点击展开）** | 几乎无（书签栏默认隐藏，**悬停顶部边缘才出现**） | **V1**  |
| **Zen · Multiple Toolbar**  | 侧栏                     | 单独一条水平工具栏                 | 完整工具栏 + 书签栏在其下                        | **V2**  |
| **Zen · Collapsed Toolbar** | 侧栏（图标态）           | 同上的水平工具栏                   | 同上（标签折叠为图标）                           | **V2**  |
| **Arc**                     | 侧栏（+ 固定/收藏/空间） | 内容区顶部一条（不在侧栏内）       | 极简（几乎只有地址栏那条）                       | V1 变体 |
| **Edge**                    | 侧栏                     | **顶部完整工具栏**                 | 地址栏 / 前后 / 刷新 / 收藏 / 扩展 / 头像 / 菜单 | **V2**  |
| **Vivaldi**                 | 侧栏                     | 顶部工具栏                         | 完整工具栏                                       | **V2**  |

> 关键发现：**Zen 自己就把垂直标签分成「Single Toolbar（地址栏进侧栏）」与「Multiple Toolbar（地址栏留在顶部）」两种布局** ——
> 你要的两个模式不是我们发明的折衷，而是行业已有的一等公民。
> 另有一个可直接借鉴的细节：Zen 的 Single Toolbar 模式下 **书签栏默认隐藏、悬停顶部边缘才滑出** —— 正是 V1 下「顶部的其余栏」应有的处理方式。

### 1.4 三家一致的行业基线（可当验收底线）

**① 标签列可折叠；② 折叠后悬停/边缘唤出且不改变网页布局；③ 固定标签与普通标签分区；④ 与分组/空间协作；⑤ 一键切回水平标签。**

### 1.5 legacy Hira / wexond

两者**都没有**垂直标签实现（legacy Hira 全库搜 `vertical` 只命中手势/对齐/拖拽方向）。
仅贡献可复用资产：legacy Hira 的侧栏交互、Zen 模式的悬停时序、`sortablejs direction:'vertical'` 的拖拽手感。

Sources：

- [Zen 用户手册 · Bookmarks](https://docs.zen-browser.app/user-manual/bookmarks)（**两种垂直布局：Single toolbar（地址栏集成进垂直标签栏）/ Multiple toolbars（地址栏在独立水平工具栏）**；Single Toolbar 下书签栏悬停顶部才出现）
- [Zen 用户手册 · Compact Mode](https://docs.zen-browser.app/user-manual/compact-mode)（三种工具栏模式；隐藏后悬停边缘唤出；`Alt+Ctrl+S` 持久浮出）
- [Zen 高级配置](https://docs.zen-browser.app/guides/about-config-flags)（`zen.urlbar.show-domain-only-in-sidebar`：Single Toolbar 时侧栏地址栏只显示域名）
- [Zen Browser 官网](https://zen-browser.app/)（Workspaces / Compact Mode / Glance / Split View）
- [Zen Browser Review 2026](https://go.tabbit.ai/zen-browser-review)（侧栏滑出 **without layout shift**）
- [GeekChamp · Edge 垂直标签](https://geekchamp.com/how-to-enable-and-use-vertical-tabs-in-microsoft-edge-browser/)（**顶部仍保留地址栏与工具栏，只有标签行消失**）
- [TechYorker · Edge 垂直标签](https://techyorker.com/how-to-enable-and-use-vertical-tabs-on-microsoft-edge/)（地址栏上移到窗口顶端）
- [Microsoft Edge · Vertical tabs](https://www.microsoft.com/en-us/edge/features/vertical-tabs)（收起 / unpin 悬停展开 / `Ctrl+Shift+,`）
- [Arc Help Center · Split View](https://resources.arc.net/hc/en-us/articles/19335393146775-Split-View-View-Multiple-Tabs-at-Once)
- [Arc Browser Review 2026](https://thesoftwarefeatures.com/arc-browser-review-2026/)（垂直标签 + Spaces + 侧栏承载 pinned/favorites/Today）
- [Vivaldi Help · 标签栏](https://help.vivaldi.com/zh-hans/desktop-zh-hans/tabs-zh-hans/tab-bar/)（标签栏位置：顶部/左侧/右侧/底部；**标签栏移到侧边后，标题栏会显示活动标签页标题，并包含菜单按钮与最小化/最大化/关闭** → 与 NG 的 titlebar + windowControlsHost 同构）
- [Vivaldi Tips #382 · 面板位置](https://tips.vivaldi.net/tip-382/)（**垂直标签时必须决定"标签与面板同侧还是各占一侧"**，面板位置是设置项 → §4.8 的设计依据）
- [Vivaldi Tips（面板宽度可单独调整）](https://tips.vivaldi.net/tag/web-panels/)（Web Panel 可加宽而不改变其它面板尺寸）
- [Vivaldi 8.0 Unified frame 讨论](https://31.209.137.6/topic/118156/vivaldi-8.0-our-biggest-design-overhaul-ever/125?lang=en-US)（工具栏合成"单一连续平面"；**用户抱怨装饰性边框造成边缘 deadzone、滚不动** → §4.8 的反面教材）
- [Vivaldi · 标签管理](https://vivaldi.com/zh-hans/features/tab-management/) / [Vivaldi 功能年表](https://fr.vivaldi.net/chronologie-des-fonctionnalites-de-vivaldi/)
- RT 自述：`1A-STAR_Hira_RT/README.md`

---

## 2. 布局模式体系（本轮核心设计）

### 2.1 为什么不能继续用「模式枚举」

现状是 `app.layout_mode: default | compact`（"四块各自成行" / "标签栏与导航栏合并单行"）。
如果把垂直也塞进这个枚举，会立刻出现组合爆炸与矛盾态：

```
default × 水平 / compact × 水平 / 垂直V1 × ... / 垂直V2 × ...
   ↑ 还要再回答：V2 下 compact 还生效吗？V1 下 titlebar/书签栏去哪？
```

**正确做法：把「模式」拆成互不相干的维度，让状态由数据推导，而不是由枚举分支。**

### 2.2 四个正交维度

| 维度                                | 取值                                                                     | 归属                             | 现状               |
| ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------- | ------------------ |
| **D1 块 → 区域**                    | 每块：`top` / `bottom` / `side`                                          | 每块一条（`app.<row>_position`） | 现有键，取值扩一项 |
| **D2 区域轴**（区域自己的排列方向） | 行区（top/bottom）= **横排**；侧栏（side）= **纵排**                     | 容器决定，不可配                 | 侧栏为新增区域     |
| **D3 区域内顺序**                   | 行区：`app.chrome_row_order`（现有）；侧栏：`app.side_row_order`（新增） | 每个区域一张表                   | 新增一张           |
| **D4 侧栏状态**                     | `hidden` / `attached` / `floating` × `left/right` × 宽度/折叠            | 侧栏自己的设置                   | 全新               |

**行区合并（原 `compact`）不是独立维度，而是 D2 的自然结果**：
行区是横排 → 同一行里的多个块会被「合并成一行」（现有 `data-merged` 机制）；
侧栏是纵排 → 侧栏内的块只会**上下堆叠**，不存在"合并成一行"这回事。
于是：**`compact` 的生效条件 = 标签栏与导航栏恰好落在同一个行区** —— 不需要任何特判，
它们不在同一行区时（例如标签栏进了侧栏）合并自然无从发生。

> 这一条把 v2 文档里那句「compact 在垂直模式下不生效」的**特例**消掉了 —— 变成**推导结果**。

### 2.3 「默认 vs 垂直」的唯一判据

```
D1 里没有任何块 = 'side'   →  默认（经典）布局，侧栏区域不渲染（零宽零高度）
D1 里存在块 = 'side'       →  垂直布局，侧栏区域激活
```

推论（都无需特判）：

- 用户可以只把**书签栏**放进侧栏（那就是"侧栏书签栏"，一种合法的新布局）——体系天然支持。
- 侧栏里放两块以上时，它们按 D3（侧栏顺序表）自上而下堆叠。
- 侧栏放在窗口哪一侧，用**它自己的设置** `app.side_column_position`（与工具图标栏那一段的 `app.sidebar_position` 相互独立，两段可以各靠一边）。

### 2.4 两个垂直子模式 = 两个预设（写成键值，不是新逻辑）

| 预设（`app.layout_preset`）                 | `tabbar_position` | `navbar_position` | titlebar / bookmarkbar                            | 对标                          |
| ------------------------------------------- | ----------------- | ----------------- | ------------------------------------------------- | ----------------------------- |
| `classic`（默认布局）                       | `top`             | `top`             | 各自原设置                                        | 现状                          |
| `vertical-tabs`（**V2 · Edge 型**）         | **`side`**        | `top`             | 各自原设置                                        | Edge / Vivaldi / Zen Multiple |
| `vertical-all-in-one`（**V1 · All-in 型**） | **`side`**        | **`side`**        | 各自原设置（默认建议 `top`，V1 下可悬停顶部唤出） | HiraRT / Zen Single / Arc     |

- **预设键不是真源，只是一个宏**：它一次性写入 D1 的几个位置键；真源永远是 D1/D3/D4。
  用户微调任何一块之后，设置页把预设显示为「自定义」（与现有「偏离默认值徽标」同一思路）。
- 「一键切回水平」= 写回 `classic` 预设；也可以只把某一块从 `side` 挪回 `top`（细粒度）。
- 设置页的「位置」下拉：`ROW_POSITION_OPTIONS` 从 `[顶部, 底部]` 扩为 `[顶部, 底部, 侧栏]`
  —— **改动只是一张 options 表**，渲染逻辑（`select`）零改动。

### 2.5 区域 × 块 能力矩阵（声明式，决定下拉里出现哪些选项）

```js
// 真源：一块能住哪些区域（不给的选项不出现在下拉里）
const CHROME_ROW_REGIONS = {
  tabbar: ['top', 'bottom', 'side'],
  navbar: ['top', 'bottom', 'side'],
  titlebar: ['top', 'bottom', 'side'],
  bookmarkbar: ['top', 'bottom'],   // 横条不进侧栏（见下）
};
```

> **书签栏为什么不给「侧栏」**（用户口径："书签栏不应该在侧栏头上，而是侧栏撑满到窗口顶端，
> 书签栏让位"）：它是一条**横条**，塞进侧栏列就占掉整列的顶（用户一拖到最前，"侧栏顶边"当场失效），
> 而垂直标签列必须从窗口顶边一路到底。所以它让位 —— 只能住行区（顶部 / 底部），
> 存量设置里写着 `side` 也会被归一化回顶部。这是**能力矩阵**的一条，不是特判：
> 设置页的下拉直接少一项，摆放计划照旧做回落。

- **新增一块** = 在 `CHROME_ROWS` 加 id、在这张矩阵加一行、在编排层交出元素 → 三处，块之外零改动。
- **新增一个区域**（例如未来的 `overlay` 悬浮工具条）= 在矩阵里给相关块加一项 + 在容器里加一个区域实现 + 加一张顺序表。
- 某块被设成它不支持的选项时，归一化回落（与现有 `normalizeRowPosition` 同款容错）。

### 2.6 组合矩阵（含"自然退化"，无冲突态）

| 场景                                                   | 结果                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 全部块 = top/bottom                                    | 与现状**逐像素一致**（侧栏区域 `display:none`）                              |
| V2（tabbar=side，navbar=top）                          | 顶部保留 navbar 行；侧栏内是标签列表                                         |
| V1（tabbar=side，navbar=side）                         | 顶部只剩 titlebar/bookmarkbar（若也在 top）；侧栏内按顺序堆叠 navbar、tabbar |
| V1 + titlebar=top                                      | 顶部是标题栏（可承载窗口控制按钮），与 RT「mac 侧栏在左 → 顶栏 0」等价的选择 |
| tabbar=side 且 navbar=top，且原 `layout_mode=compact`  | 两者不同区域 → 合并无对象 → 自动等价于 default（**不是特判**）               |
| tabbar=side 且 navbar=side，且原 `layout_mode=compact` | 两者同在侧栏 → 侧栏是纵排 → 仍按 D3 顺序堆叠，不合并（同样不是特判）         |
| 侧栏状态 = floating/hidden                             | 侧栏不占位：网页 bounds 不让位（覆盖时浮在网页之上）                         |
| 侧栏状态 = attached + 折叠                             | 侧栏占位 = 折叠宽（图标条）；V1 下顶部仍可空着                               |
| 只把 bookmarkbar 放进侧栏                              | 合法的"侧栏书签栏"，按侧栏顺序表排位                                         |
| 全屏                                                   | 侧栏宽 = 0（chrome 整体隐藏）                                                |

### 2.7 侧栏内的分区顺序（V1 的目标形态，学 RT / Arc）

侧栏（纵排）里各块自上而下，默认顺序 `app.side_row_order = ['navbar', 'tabbar', 'bookmarkbar', 'titlebar']`：

| 顺序位 | 块            | 侧栏内的形态（块内部自适应，见 §2.8）                                                                                                                       |
| ------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `navbar`      | V1（全功能侧栏）时**顶行 = 窗口控制按钮 + 空间切换器**（见下注）→ 地址栏一行 → 导航按钮一行 → 站点控制/面板按钮一行（Arc/RT 的侧栏工具栏）；V2 时它不在侧栏 |
| 2      | `tabbar`      | V2 时**顶行 = 空间切换器**（含空间名）→ 标签列表（`flex:1` 吃剩余高度）→ 底部工具区：新建标签；V1 时顶行归 navbar，本块只剩标签列表 + 底部新建标签          |
| 3      | `bookmarkbar` | 书签栏改成纵向列表（若不希望纵向，就把它留在行区）                                                                                                          |
| 4      | `titlebar`    | 网页标题 + 图标（垂直居中的一条）                                                                                                                           |

> **空间切换器的落点（两处规格的对齐）**：本表的「顶部」与 §3.2「底部工具区」曾各写一次。
> 实现口径以**本表**为准：NG 只有一个空间元素（它既显示当前空间名、又是切换入口），
> 与 RT 顶部的 `space-title`（显示名）而非底部的 `space-switcher`（切换入口）对齐时，
> 放在**顶部**同时满足「一进侧栏就知道自己在哪个空间」与「顶部有一条拖拽区」（见 §3.3）。
> 底部工具区因此只剩 `[+ 新建标签]`（窗口控制按钮在**顶行**，见下注）。
>
> **窗口控制按钮的落点（两条空间事实，宿主只在横排时说话）**：
> · **纵排**（= 全功能侧栏，navbar 自己也在侧栏）→ 一律归**整列最顶行的最前**，即
> 左上角、空间切换器**左边**（承载它的是 navbar 的 `sideHeader`；空间切换器是后
> append 进去的，故「插在最前」= 它左边）。与宿主配的是 tabbar 还是 navbar 无关 ——
> 纵排下真正决定位置的是「整列最顶那一行」这一个空间事实；
> · **横排** → 宿主为 `navbar` 时钉在导航栏**整行最右**（CSS 的 `order` 高于面板簇；
> 若不显式给 order，按钮会落到缺省的 0、排到导航簇之前 = 跑到最左边）；宿主为 `tabbar`
> 时钉在标签行末（新建标签之后）。
> 收口在 `ui-navbar/src/row/windowControlsPlacement.js` 一处（块级契约的另一半见 §2.8）——
> CSS 看不出「按钮该去哪一行」，故 DOM 结构这部分必须走 JS。
>
> **归属权（同一颗节点的三方交接）**：三颗窗口按钮是**同一个 DOM 节点**（搬移而非复制，
> 监听与状态因此不丢），宿主可在 `tabbar` / `navbar` / `titlebar` 之间切换。因此宿主为
> `titlebar` 时，导航栏那块必须**显式放手**（`mountWindowControls('titlebar')`），否则它
> 之后任何一次内部重摆（换布局 / 换宿主轴）都会把节点从标题栏里抢回来 ——
> 表现就是「设成标题栏后又自己跑回标签栏」。

而 **V2** 下侧栏里只有 `tabbar`，它内部的纵向形态同上表的第 2 行 —— 与 V1 共用同一份实现。

### 2.8 块级契约：容器只通知「宿主轴」，块自己变形态

这是「无耦合」的关键：**容器不认识任何块的内部**，只告诉它「你现在住在什么区域、该区域是什么轴」。

```
容器 → 块：  setHostAxis('row' | 'column')     // 行区=横排宿主，侧栏=纵排宿主
```

- `ui-navbar`：`row` → 现状（一行）；`column` → 内部子项重排为**确定的三行**（顶行标题行、地址栏一行、导航一行、站点控制一行）。视觉形态由 CSS 看 `data-host-axis` 直接完成（`flex-direction: column` + `order`），**只有窗口控制按钮的落点需要 JS**（纵排下要归整列最顶行、插在空间切换器左边，否则它会自成侧栏里的一行或落到侧栏最底下）—— 这正是 `setHostAxis` 存在的理由：CSS 能表达的交给 CSS，DOM 结构决定的才走这条契约。
- `ui-tabbar`：`row` → 现状（横排标签条）；`column` → 交给 `ui/ui-vertical-tabs`（复用 `createTabRowList`）。
  **两块互不认识**：`ui-navbar` 只负责把「空间切换器 / 新建标签槽」在纵向宿主下搬进侧栏对应的槽位（与现有 `setCompactLayout` 同一范式）。
- 尺寸分配也由**块自己的样式**决定（容器不特判）：例如标签列表在纵排宿主里 `flex:1`，写法是块自己的 CSS（`#navbar-tabbar[data-host-axis="column"] { flex: 1 }`），容器只负责打 `data-host-axis` 标记。

### 2.9 插件化 / 扩展点清单（不冲突、可生长）

| 想加什么                                  | 要改的地方                                                | 不需要改的地方                                |
| ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| 一种新布局预设（例：`sidebar-bookmarks`） | 预设表加一行（写入若干位置键）                            | 任何块、容器、IPC                             |
| 一个新区域（例：底部悬浮工具条）          | `CHROME_ROW_REGIONS` 加一项 + 容器加一个区域 + 一张顺序表 | 任何块内部（块只需实现 `setHostAxis` 的分支） |
| 一个新块（例：下载条）                    | `CHROME_ROWS` + 能力矩阵 + 编排层 `setBlock`              | 容器渲染逻辑、其它块                          |
| 侧栏的一种新状态（例：`pinned-floating`） | 侧栏状态机 + 主进程 bounds 分支                           | 块内部                                        |
| 侧栏内部加分区（例：今日标签）            | 该块（tabbar）内部的 sections                             | 容器与其它块                                  |

**与原有系统的关系**：四块模型、位置、顺序、窗口控制按钮宿主、书签栏三态、标题栏开关、命令面板、按钮编辑、面板/rail —— **全部照旧生效**；垂直布局只是给 `tabbar`/`navbar` 多了一个可去的地方。

---

## 3. 功能全集与 UI 规格（对标：RT / Zen / Arc / Vivaldi / Edge）

图例：**●** 原生 ｜ **◐** 部分 ｜ **○** 无 ｜ **落地**：NG 的做法

| 功能                                                   | RT                          | Zen                 | Arc                    | Vivaldi          | Edge                | 落地                                        |
| ------------------------------------------------------ | --------------------------- | ------------------- | ---------------------- | ---------------- | ------------------- | ------------------------------------------- |
| 垂直标签（侧栏承载标签）                               | ●                           | ●                   | ●                      | ●                | ●                   | 侧栏区域 + 纵向标签行列表                   |
| 地址栏进侧栏（V1）                                     | ●                           | ●（Single）         | ◐（内容区顶部）        | ○                | ○                   | 预设 `vertical-all-in-one`                  |
| 地址栏留顶部（V2）                                     | ○                           | ●（Multiple）       | ○                      | ●                | ●                   | 预设 `vertical-tabs`                        |
| 一键切回水平                                           | ●                           | ●                   | ○                      | ●                | ●（`Ctrl+Shift+,`） | 预设 + 快捷键                               |
| 侧栏左/右                                              | ●                           | ●                   | ○                      | ●                | ○                   | 沿用现有侧边栏位置                          |
| 宽度可拖 + 记忆                                        | ●（150/200/500）            | ●                   | ●                      | ●                | ◐                   | 把手（夹取 150–500），走 NG 设置持久化      |
| 折叠 / 展开                                            | ●（五态）                   | ●                   | ●                      | ●                | ●                   | 折叠宽 = 图标条                             |
| 悬停唤出且**不重排网页**                               | ●（floating）               | ●                   | ●                      | ●（Auto-hide）   | ●（unpin）          | 自动隐藏占位（真让位，非浮层）              |
| 持久浮出                                               | ●（`forceFloating`）        | ●（`Alt+Ctrl+S`）   | ◐                      | ●                | ●（pin）            | 设置 / 快捷键                               |
| 顶栏自适应                                             | ●（win 30px；mac 侧栏左 0） | ●（三种工具栏模式） | ●（极简）              | ◐                | ◐                   | §4.6                                        |
| 固定标签分区（网格）                                   | ●                           | ●                   | ●                      | ●                | ●                   | 一期单列；二期网格（列数自适应 + 落点吸附） |
| 标签组（组行 / 展开）                                  | ●（split/glance）           | ●                   | ●（Split View 成一项） | ●（两级/手风琴） | ●                   | 一期用现有「标签栈 + 组行」；分屏二期       |
| 标签搜索 / 过滤                                        | ◐                           | ◐                   | ●（命令栏）            | ●                | ●                   | 二期：侧栏顶部搜索（`Ctrl+Shift+E`）        |
| 休眠置灰 / 音频 / 双击中键关闭 / hover 预览 / 右键菜单 | ●                           | ●                   | ●                      | ●                | ●                   | **全部复用 NG 现有实现**                    |
| 全屏 / 窄窗自动收起                                    | ●/○                         | ●/●                 | ●/○                    | ●/●              | ●/○                 | 一期                                        |

### 3.1 视觉规格（全部走现有 token，禁硬编码）

| 项                | 值                                                                                            | 理由 / 来源                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 侧栏宽            | 展开 **200**（150–500）、折叠 **48**                                                          | RT 实测值；折叠宽 = rail 同宽，两列并排成一条                                   |
| 侧栏内边距        | 容器 `padding: 8px`；分区之间 `margin: 6px 0`                                                 | RT 浮出卡片用 `p-2`（8px）；与面板内边距同档                                    |
| 底色              | 一律 `var(--main-bg-color)`（与 navbar 同色）                                                 | 一份 DOM：自动隐藏只是同一块侧栏宽 0 ⇄ 唤出，不换皮（没有浮起卡片）             |
| 描边              | 内侧 1px `var(--border-color)`；收起（宽 0）时不画边框                                         | 与网页的分界必须看得见；**不加装饰性粗边框**（见 §4.8 的 deadzone 教训）        |
| 圆角              | 行 9px（= `--ng-tab-radius`）；容器 10px                                                      | 与水平标签同圆角                                                                |
| 行高              | **32px**（= `--ng-tab-height`）                                                               | 与水平标签完全一致 → 同一个标签在两种模式下"看起来一样"                         |
| 行内边距 / 行间距 | `4px 8px 4px 7px` / `1px`（复用 row list）                                                    | 不另立一套                                                                      |
| 字号              | 标签标题 12px、分区标题 11px、空间名 12px/600                                                 | 与面板列表同档                                                                  |
| 图标              | favicon 18 + 2px 白边 = 22 格（关闭 16、音频 14、工具按钮 18）                                | 与 tabbar 共用 `ui-common/tab/iconArea.ts` 的 `FAVICON_*` 常量；panel 的 16 是"满格无白底"，视觉同档 |
| 强调色            | `var(--accent-color)`（拖拽指示线、焦点环、选中描边）                                         | 与全局一致                                                                      |
| hover / 选中      | hover `var(--hira-hover-bg)`；选中 = favicon 取色底 + 对比文字                                | 复用 `applyFaviconColor`，与 tabbar / 面板同一套                                |
| 滚动条            | 4px、hover 才显（`--ng-tabs-scrollbar-*`）                                                    | 与标签条同款                                                                    |

### 3.2 分区与行的视觉（自上而下）

| 分区                          | 视觉规则                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **空间标题行**                | 空间图标 + 名称（12px/600）+ 右侧「更多」；下方 1px 分隔线                                                                                      |
| **地址栏行**（V1）            | 一行输入框（`--ng-omnibox-height` / `--ng-omnibox-radius`）→ 导航按钮一行 → 站点控制一行；行间 6px 留白                                         |
| **固定标签区**                | 单列图标格（22px 图标块居中）；**不参与滚动**（学 Vivaldi：固定标签不随列表滚走）；与列表之间 8px 留白 + 1px 分隔线                              |
| **标签列表**（`flex:1` 滚动） | 复用 `createTabRowList`：行 = favicon + 标题（单行省略）+ 音频/关闭                                                                             |
| **组行**                      | 折叠箭头 14 + 组色点 8 + 组名 + 计数徽标 `+N`；展开后组内标签**缩进 12px**                                                                      |
| **底部工具区**                | 上方 1px 分隔线；`[+ 新建标签] [窗口控制按钮（宿主为标签栏时，最右）]` 横排；空间切换器不在这里（它是顶部的「空间标题行」，见 §2.7 的落点说明） |
| **空态**                      | 居中「没有打开的标签」+ 「新建标签」按钮（复用 row list 的 `emptyText`）                                                                        |

### 3.3 状态、拖拽与动效

| 场景                     | 视觉                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拖拽排序                 | 插入指示线 2px 强调色（现有 `tabrow-drop`）；被拖行降透明；其余行 FLIP 让位                                                                                                                                                                   |
| 拖到组行                 | 整行高亮为"并入"态（复用 `is-stack-target`）                                                                                                                                                                                                  |
| 拖到网页区（拆窗）       | 侧栏内侧 1px 强调描边 + 提示「松开在新窗口打开」                                                                                                                                                                                              |
| 折叠态                   | 只显 favicon（22px 白底块）居中；选中项左侧 2px 指示条 + 轻底                                                                                                                                                                                          |
| 浮出（floating）         | 距窗口边缘 8px 的浮起卡片；`translate-x` 进出场；100ms `cubic-bezier(0.4,0,0.2,1)`                                                                                                                                                            |
| 宽度拖拽                 | 把手命中区 4px；拖动中 `col-resize` + 把手高亮；**拖动期间关过渡**（跟手）                                                                                                                                                                    |
| 动效降级                 | 尊重 `prefers-reduced-motion: reduce`：宽度变化与滑出改为瞬时                                                                                                                                                                                 |
| **窗口拖拽（垂直模式）** | 侧栏**三态一律不吃拖拽区**（rail / 悬停展开 / 固定占位都 `no-drag`，2026-10 用户口径「都不要有拖动区域出现」）。drag 区是非客户区，指针事件不进渲染进程 —— 侧栏里只要有一块拖拽区，行内边距 / 行缝 / wrap 两侧的槽就全部变成「点不动 + 误拖窗口」的洞。竖排时的拖窗口由侧栏**之外**的行承担（顶部导航栏 / 标题栏 / 书签栏） |

### 3.4 可访问性

- 列表 `role="listbox"`、行 `role="option"` + `aria-selected`、组行 `aria-expanded`（**DOM 语义一期就位**）。
- 键盘：`↑/↓` 移动、`Enter` 切换、`Delete` 关闭、`←/→` 折叠/展开组（三期完整实现）。
- 焦点环用 `var(--focus)`（与设置页同款）；折叠态每个图标都有含标题的 `aria-label`。

---

## 4. 架构设计（NG 落地）

### 4.1 复用清单

| 能力                         | 现有实现                                                                                                                                                        | 复用方式                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 纵向标签行列表（全套）       | `ui/ui-common/src/tabListHost.ts#createTabListHost`（把 `createTabRowList` 与全部接线一次接好）                                                                 | **直接复用**（四个宿主共用：chrome 侧栏 / 侧栏覆盖层 / 两个面板）                                                                             |
| 装配范式（自描述定义）       | `ui/ui-panel-opentabs/src/index.js#panelDefinition`：`{ id, injectStyles(doc), mount(doc, ctx) }` —— 宿主只交端口                                               | **垂直标签逐项对齐**（`verticalTabsDefinition`）                                                                                              |
| 标签投影 / 标签栈域逻辑      | `domain/domain-tabs/src/{TabRules,TabStacks}.js`                                                                                                                | 直接复用                                                                                                                                      |
| 标签行右键菜单               | `ui/ui-common/src/tabContextMenu.ts#createTabContextMenu`（**唯一实现**：横向标签条 / 纵向标签列 / 两个面板四处共用；宿主只注入「怎么弹菜单」与「动作落到哪」） | **直接复用**（已落地）                                                                                                                        |
| hover 预览浮层               | `ui/ui-tabbar/src/components/TabPreview.js` + `tabpreview-overlay`                                                                                              | 复用，只改锚点矩形                                                                                                                            |
| 拖拽落库（重排/并组/出组）   | `ui/ui-panel-opentabs/src/index.js#L61-L73`                                                                                                                     | 直接复用                                                                                                                                      |
| 跨窗口拖拽                   | `tab:move-to-window` + `TabManager#detachTab / adoptTab`；横向标签条与纵向列表共用统一 drag-item 载荷                                                            | ✅ **已接线**：目标窗口按 `tabId` 找回源窗口并整体迁移 webContents；支持目标标签前后落位，跨 profile 明确拒绝（不串数据）                    |
| 侧栏宽度 / 让位 / 动画参数   | `setPageLayoutParams`（`infra/infra-ipc/src/contracts/layout.js#L53-L68`）                                                                                      | **已具备**                                                                                                                                    |
| 悬停唤出（自动隐藏、真占位） | 同一块 `#chrome-side` 两档宽度（`restWidth` 0 ⇄ `revealWidth`）+ `LayoutCoordinator#setSideColumnReveal` 指针巡看 + `layout:side-column-reveal` 回推           | **已落地**（见 architecture §6.1）                                                                                                            |
| 边缘唤出                     | `LayoutCoordinator#_syncRailRevealWatch` / 窗口边缘窄判定 + 展开后保持区巡看                                                                                         | 已统一                                                                                                                                        |
| 布局计划 / 容器 / 施加       | `layout.mjs#planChromeLayout`、`ui/ui-chrome-layout`、`chrome-layout-controller`                                                                                | **扩展**（§4.2–§4.4）                                                                                                                         |

### 4.2 容器结构（行区→区域体系）

```
#chrome-root (flex row)
├─ #chrome-side      ← 侧栏区域（纵排 flex；无块入住时 display:none）
│                       高度 = **整窗**（顶边到底边）
└─ #chrome-main (flex column)
   ├─ #chrome-top    ← 行区（横排）—— 只占主列的宽（侧栏右边那一段）
   ├─ #chrome-content
   └─ #chrome-bottom ← 行区（横排）—— 同上
```

- **侧栏与顶底两区平级**（侧栏 = 一整列，顶底两区住主列里）：垂直标签型布局里侧栏要
  **顶到窗口上下边**（用户口径："标签侧栏应该顶边"），于是书签栏 / 导航栏那一行只占
  主列的宽 —— 不再横跨到侧栏头顶（那正是"书签栏压在标签侧栏之上、侧栏被截掉一截"的成因）。
  代价是侧栏与 rail 的上沿不再对齐（rail 仍从 topbar 之下开始）—— 与 Edge 的
  「垂直标签整列 + 面板在工具栏之下」是同一形态。
- `ui-chrome-layout` 内部把「区域」抽象成同一件事：**一个区域 = 一个轴 + 一张行数组**。
  现有 `renderRows(host, rows)` 增加 `axis` 参数，侧栏区域用 `axis='column'`；`applyPlan` 按 `plan.side` 决定侧栏是否渲染。
- 每个入住块被标上 `data-block="<id>"` 与宿主的 `data-host-axis`，块的样式与内部重排据此生效（§2.8）。
- **水平模式（无块入住侧栏）渲染结果与现状逐像素一致** —— 侧栏区域 `display:none`，
  主列独占整宽 → 顶底两区随之横跨整窗（与历史结构逐像素一致）。

### 4.3 布局模型扩展（`packages/shared-types/src/layout.mjs`）

```js
planChromeLayout(state) → {
  mode, titlebarEnabled, windowControlsHost, navbarSide,
  top: [...], bottom: [...],          // 现状不变（行区）
  side: {                             // 新增：侧栏区域
    rows: string[][],                 // 侧栏内的块（纵排，按 side_row_order）
    position: 'left' | 'right',
    visibility: 'hidden' | 'attached' | 'floating',
    autoHide: boolean,                // 实际生效：visibility === 'floating'（静止宽 0、贴边唤出）
    width: number,                    // 用户拖的宽度（展开口径）
    collapsed: boolean,               // 折叠为图标条
    restWidth: number,                // 静止占位宽度（网页平时让出多少）—— 常驻态唯一宽度口径
    revealWidth: number               // 唤出宽度（贴边展开时占多宽）
  } | null                            // null = 没有块入住 → 不渲染
}
```

- `side` 由 D1 推导：`Object.entries(regions).filter(([,r]) => r==='side')` 非空则返回对象，否则 `null`。
- `autoHide` 只出「形态」这一个事实；**什么时候展开是运行期状态**，由主进程贴边巡看
  决定并推给渲染层（`layout:side-column-reveal`）。计划是纯函数，不掺指针位置。
- 自动隐藏对**任何**侧栏形态都成立，但展开方式由 `revealOverlay` 一分为二：
  · Edge 型 → `restWidth = 56`（图标 rail 常驻占位），展开是覆盖网页的**独立浮层**，
    网页**不缩进、不重排**；
  · 全功能型 → `restWidth = 0`（网页铺满），唤出就是把同一块 `#chrome-side` 改成
    `revealWidth` —— 网页真让位；因此不存在「全功能侧栏里住着原生部件、搬不进浮层」这类限制
    （它压根不走浮层）。
- 归一化沿用现有容错风格（未知取值回落默认）。
- 纯函数、不碰 DOM —— 四种组合的推导可用几行自检脚本验证。

### 4.4 主进程 bounds

- 复用现成字段：`sidebarWidth / sidebarSide / sidebarVisible / sidebarAnimating`
  → 垂直模式下这三个字段描述的就是侧栏（现描述的是 rail 图标栏）。
  **合并策略**：`rail` 与侧栏同侧时，侧栏在外（贴窗口外缘）、rail 在其内侧；两侧宽度相加为网页的左/右内缩。
- 动画：渲染层上报 `sidebarAnimating: true` 时主进程按 **100ms** 插值（照 RT：~30fps 采样；唤出/收起切换不做插值）。
- 全屏：`sidebarWidth = 0`。
- 自动隐藏（`floating`）：网页内缩**恒按 `restWidth`** 算（判据同一处 `getSideColumnWidth`）——
  Edge 型是 56（rail），全功能型是 0；Edge 型的展开由独立浮层盖在网页上、**不参与内缩**，
  所以不存在「浮层与网页内缩各说各话」的抖动。

### 4.5 设置项清单

| 键                               | 取值                                              | 默认                                           | 说明                                                                                                                                 |
| -------------------------------- | ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `app.layout_preset`              | `classic \| vertical-tabs \| vertical-all-in-one` | `classic`                                      | **预设（宏，非真源）**                                                                                                               |
| `app.tabbar_position` 等四块位置 | `top \| bottom \| side`                           | 现状                                           | **真源 D1**（取值扩一项）                                                                                                            |
| `app.chrome_row_order`           | 块 id 数组                                        | 现状                                           | 行区顺序 D3                                                                                                                          |
| `app.side_row_order`             | 块 id 数组                                        | `['navbar','tabbar','bookmarkbar','titlebar']` | **侧栏顺序 D3（新增）**                                                                                                              |
| `app.sidebar_visibility`         | `hidden \| attached \| floating`                  | `attached`                                     | D4（`floating` = 自动隐藏：静止**完全消失**（网页铺满），指针贴到窗口边缘才把**同一块占位侧栏**展开（网页真让位），移开又消失；展开态同位置有「固定」按钮；Edge 型与全功能型同一套实现 —— 见 §4.3 `autoHide`） |
| `app.sidebar_width`              | number(px)                                        | **200**                                        | 夹取 150–500（RT 实测值）；两态共用这一条记忆                                                                                        |
| `app.sidebar_collapsed`          | boolean                                           | `false`                                        | 折叠为图标条（仅占位态有意义）                                                                                                       |
| ~~`app.sidebar_pinned`~~         | —                                                 | —                                              | **已删除**：与 `visibility = floating` 表达同一件事（两条同语义口径必然互相矛盾）                                                    |

持久化：走 NG 现有 `settings:set` + DB（**不用 RT 的 localStorage**）；拖拽期间只改 DOM 变量，松手落库。

### 4.6 顶栏高度（垂直模式下）

| 平台            | 顶栏                                               |
| --------------- | -------------------------------------------------- |
| Windows / Linux | 30px 窗口条（拖拽区 + 窗口控制按钮，宿主规则不变） |
| macOS           | 侧栏在左 0；侧栏在右 34px                          |

**实现口径（已落地）**：NG 的 `--control-space-top` 在 Windows 下就是 `0px`（横向布局的拖拽由标签条自身承担，从不额外加一条 30px 的条）—— 若为垂直模式单独加一条，反而会平白把网页压下一行。因此这里取**同一口径的等价做法**：
侧栏（`.vtabs`）**三态整块 no-drag**（见 §3.3）：内容区整个让给标签交互，看到什么就能点什么；窗口控制按钮沿用既有宿主规则（`tabbar` 时落侧栏底部工具区）。竖排时的拖窗口交给侧栏之外的行（顶部导航栏 / 标题栏 / 书签栏）。顶部区若无块入驻则仍**整条不渲染**（`#chrome-top:empty`），不留空行。

V1 下顶部的 `titlebar` / `bookmarkbar` 若也在顶部，可学 Zen：**默认收起、悬停顶部边缘滑出**（二期 —— 需要独立浮层图层才不会把网页反复推来推去，与本项目网页是原生 `WebContentsView` 的边界一致，见 §4.1 的浮出态口径）。

### 4.7 事件与 IPC

| 用途                                 | 现有                                                                                       | 新增   |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------ |
| 布局参数上报                         | `layout:set-page-layout-params`（字段已齐）                                                | **无** |
| 标签数据 / 拖拽 / 预览 / 菜单 / 设置 | `tabs:*`、`tab:drag-*`、`tabbar:rect`、`tabpreview-overlay`、`ui:popup-menu`、`settings:*` | **无** |

> **零新增 IPC 通道。**

### 4.8 三条纵向区块的共存（学 Vivaldi：垂直标签栏 × rail × panel）

NG 现状（设计的地基）：

- **rail**（48px 图标栏）：独立 WebContentsView，主进程摆放，`railX = side==='right' ? W - railW : 0` —— **恒贴窗口外缘**，y 从 `topbarHeight` 开始；
- **panel**（左/右各一位）：独立 WebContentsView，宽度按 `app.panel_width_left/_right` 记忆；
- **chrome 外壳**（navbar / tabbar / 侧栏区域）：窗口本体，铺满整窗，z 最低。

三条纵向轨道一旦同侧，必须回答四个问题：

| 挑战                     | 答案（学 Vivaldi + 复用 NG 现状）                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **同侧还是各占一侧？**   | **Vivaldi 把它交给用户选**（官方 Tips：垂直标签时"要想清楚标签与面板同侧、还是各占一侧"，面板位置是设置项）。NG 照做，且**两段各有独立键**：`app.side_column_position` 决定垂直标签侧栏在左/右，`app.sidebar_position` 决定工具图标栏（rail）+ 面板那一段在左/右 —— 两者可以各靠一边。面板沿用现有左右两个 slot，且**开在「打开它的入口」那一侧**（rail 图标跟随 rail 的设置；导航栏的面板按钮在全功能侧栏下随工具按钮行借住到标签侧栏，于是就地开在侧栏那一侧）。 |
| **同侧时谁在外谁在内？** | **外侧 → 内侧：`[垂直标签栏] [rail] [panel] [网页]`**。标签栏最高频、最需要"贴边甩鼠标就到"（Fitts）；rail 是它的图标入口，紧邻；panel 由内容驱动、频率最低，最靠内。                                                                                                                                                                                                                                                                                              |
| **宽度怎么算？**         | 三者宽度之和即网页的左右内缩。**NG 已经这么做**（`leftBlocks = sidebarWidth + leftPanelWidth`）→ 只需把侧栏标签宽度并进 `sidebarWidth` 这一项，**`pageBounds` 公式一行不改**。                                                                                                                                                                                                                                                                                     |
| **rail 的 x 要让位**     | 现状 `railX` 只有 `0` / `W - railW` 两种取值 → **必须改**为「轨道起点 + 已占用宽度」。这是本轮发现的**主进程必改点**（新增 `sideLane` 起点与占用宽度的计算）。                                                                                                                                                                                                                                                                                                     |

四个"看不见但一定会踩"的挑战：

| 挑战                               | 规则                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **同一时刻只能有一个区块悬停展开** | 折叠态 hover 热区互不重叠（按轨道顺序各占 48px 窄条）；都启用悬停唤出时**后来者夺权**（鼠标进谁的热区就展开谁，另一个立即收回）→ 否则两个抽屉同时弹出把网页挤没。                                            |
| **popover 锁定**                   | 区块内有菜单/下拉打开时，该区块**锁定展开**（不收起、不被夺权）——学 RT `activePopovers`。                                                                                                                    |
| **动画不能跳两次**                 | 任一区块宽度变化 → **由 lane 统一重算一次**所有区块的起点与网页内缩，**同一次上报**里给出最终值；禁止各区块单独改自己的 x（否则先跳一次、再跳一次）。                                                        |
| **不要制造 deadzone**              | Vivaldi 8.0 的 Unified frame 因装饰性边框被用户抱怨"屏幕边缘点不到、滚不动"——**反面教材**。NG 规则：区块之间只用 1px 分隔线 + 既有 4px 内缩，**不加不可点的粗边框/阴影区**；网页边缘的滚动条与拖拽必须可点。 |

Vivaldi 另两条可直接复用的实证：

- **标签栏在侧边时，活动标签标题与窗口按钮跟着进侧栏**（官方 help：标题栏会显示活动标签页标题，并包含菜单按钮与最小化/最大化/关闭）→ 与 NG 的 `titlebar` 块 + `windowControlsHost` **完全同构，零新机制**。
- **固定标签不随滚动消失**（长期用户诉求）→ 已写入 §3.2。

### 4.9 模块边界：与 rail / panel / navbar 一样独立

落成**五条契约 + 一张轨道注册表**：

| 契约           | 内容                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **模块边界**   | 独立包 `ui/ui-vertical-tabs`（自带样式、自带槽位、不 import 任何具体块）；只依赖 `ui-common` 通用件（row list / 右键菜单 / 标签栈动作）                                                                                                           |
| **装配契约**   | 导出**自描述定义** `verticalTabsDefinition = { id, injectStyles(doc), mount(doc, ctx) }` —— 与 `ui-panel-opentabs` 的 `panelDefinition` **同一范式**（见 §4.1）。宿主只交出端口，组件自己的知识（意图映射、拖拽五条通道、右键菜单模板）留在组件里 |
| **数据契约**   | `mount` 只吃 `{ clients:{tabs}, createTabRowMenu, menu, previewOverlay, widthRange, onResize }`；**不认识 app-shell、不认识 rail / panel / navbar**，也不碰 IPC                                                                                   |
| **样式契约**   | 谁挂载谁注入：`injectStyles(doc)` 由宿主调一次，内部含 `injectTabRowStyles`（行样式是共享件，**组件不自注入**是硬约定 —— 漏调的表现就是"标签列表全是裸 DOM"）                                                                                     |
| **布局契约**   | 只声明 `{ region:'side', axis:'column', minWidth, maxWidth, defaultWidth, collapsible }` 交给轨道排布；**不知道自己旁边是 rail 还是 panel**                                                                                                       |
| **持久化契约** | 只读写自己的 `app.sidebar_*` 键                                                                                                                                                                                                                   |
| **失败域**     | 自身异常不回灌其它区块（内部错误边界 + 上报），不影响网页与 chrome                                                                                                                                                                                |

**轨道注册表（插件化的关键）**：

```js
// 唯一真源：谁住在纵向轨道上、按什么顺序、占多宽
const SIDE_LANE_BLOCKS = [
  {
    id: 'vertical-tabs',
    side: 'left',
    order: 10,
    view: 'in-chrome',
    widths: {/* 150–500，默认 200 */},
  },
  { id: 'rail', side: 'left', order: 20, view: 'own-view', widths: {/* 48 */} },
  {
    id: 'panel-left',
    side: 'left',
    order: 30,
    view: 'own-view',
    widths: {/* 记忆宽度 */},
  },
  {
    id: 'panel-right',
    side: 'right',
    order: 10,
    view: 'own-view',
    widths: {/* 记忆宽度 */},
  },
];
```

- **轨道只按 `id / order / widths` 排布，不认识任何区块的业务** → 这才是"平级 + 解耦"。
- **`view: 'in-chrome' | 'own-view'` 允许两种承载并存**：垂直标签栏一期走 `in-chrome`（同进程 → 拖拽/预览/菜单全走既有可靠路径），rail / panel 保持 `own-view`，**同一套轨道模型里平级**；将来若要升级为独立视图，只改这一行。
- **插件化**：第三方要加自己的侧栏区块（AI 助手栏 / 会话栏…）= 这张表加一行 + 实现 `mount()`；轨道排布、bounds、z 序、折叠与悬停唤出、宽度持久化**自动生效**，与 NG 现有「插件贡献设置分区 / 命令 / 面板」的扩展哲学一致。

---

## 5. 分阶段实施计划

### P0 · 区域体系（先立骨架，不改任何块的内部）

1. `shared-types/layout.mjs`：`CHROME_ROW_REGIONS` 能力矩阵 + 位置取值扩 `side` + `planChromeLayout` 返回 `side`。
2. `ui-chrome-layout`：`#chrome-side` + `#chrome-main` 嵌套 + `renderRows(host, rows, axis)` + `data-host-axis` 标记（水平模式零像素变化）。
3. `chrome-layout-controller`：按区域注册块 + 调用块的 `setHostAxis`。
4. **纵向轨道注册表**（§4.9）：`SIDE_LANE_BLOCKS` 落成真源；主进程按轨道算各区块起点与宽度 → **`railX` 从「恒贴窗缘」改为「轨道起点 + 已占用宽度」**（§4.8 的必改点）。
5. 设置页：位置下拉多出「侧栏」一项 + 新增「侧栏顺序」order 字段（复用现有 `type:'order'` + 分组徽标）+ 预设三选一 + 侧栏组（宽度 / 折叠 / 状态）。
6. 预设写入逻辑（宏 → 位置键）。

**验收**：任意块设成「侧栏」→ 侧栏出现、网页正确让位、**rail 自动让开不重叠**；设回顶部 → 像素与现状一致。
书签栏的下拉里**没有「侧栏」**（能力矩阵只给 top/bottom，见 §2 的说明）；手改设置文件写 `side` → 归一化回顶部。

### P1 · V2（Edge 型，最小可用垂直标签）—— ✅ 已落地（除标注项）

7. ✅ `ui/ui-vertical-tabs`（新包）：`createTabRowList` 宿主 + 顶部/底部槽 + 折叠态 + 调宽把手（`--ng-side-drag-width` 临时宽度、松手落库）+ §3.1 视觉规格（行高/圆角/字号/图标/滚动条/空态）。
8. ✅ `ui-navbar#mountSideTabs`：空间切换器 → 侧栏顶（= 空间标题行）、新建标签 → 侧栏底、窗口控制按钮跟随（含切回横排的回归路径）；纵排 CSS（§2.7 的三行）。宿主切换由 `chrome-layout-controller#setBlockElement` + `onHostAxis` 完成。
9. ✅ **悬停唤出已落地**（Edge 的 unpin）：`app.sidebar_visibility = floating` → `plan.side.autoHide`，
   展开方式由 `plan.side.revealOverlay` 分成两型（用户口径：「固定就是占位，取消固定就是
   标签 rail + 展开浮层」）：
   · **Edge 型（`revealOverlay = true`）** → 静止 `restWidth = 56`：这条侧栏画成**图标 rail**
     照常占位；指针贴上那一侧窗口边缘时，主进程把**独立浮层** `renderer/sidebar-float`
     （WebContentsView，图层 `float:sidebar-float` = 21）从窗口外缘铺到 `revealWidth`
     盖在网页上 —— 网页**不缩进、不重排**。浮层与外壳里的侧栏用**同一份装配图**
     （`renderer/shared/sidebar-surface.js`），只是浮层开 `autoSubscribe` 自己拉标签数据。
     展开动效在浮层**渲染层**做（`#root` 上一条 `clip-path` 划开，180ms /
     `cubic-bezier(.4,0,.2,1)`，与 `--ng-anim-base` 同口径）：view 一次就是最终矩形，
     不补间原生 bounds（逐帧改 view 宽 = 标签行每帧重排，字会跳）。静息态由
     critical CSS 定成**闭合**，主进程收起时补发 `sidebar-float:hide` 复位 ——
     否则 show 事件到达前会先闪一帧全开。收起不播动画（Edge 型立即关）。
     **浮层不可拖宽**：它的宽度**只**来自布局计划（`app.sidebar_width` → `revealWidth`
     → 原生视图 bounds），内缘那 4px 把手在浮层里被藏掉（拖它改不动视图，
     还会吃掉轨道区的命中带）。要改宽度请切到**固定占位**态拖把手 —— 同一个设置键，
     再取消固定后浮层就按新宽度展开。
   · **全功能型（`revealOverlay = false`）** → 静止 `restWidth = 0`（网页铺满），唤出把
     同一块 `#chrome-side` 改成 `revealWidth` —— **实际占位**，网页真让位。
   指针巡看在主进程（`LayoutCoordinator#_syncSideRevealWatch / _tickSideReveal`，
   `IMMERSIVE_EDGE_PX = 3`、采样 `SIDE_REVEAL_TICK_MS = 40`）；**展开方向**：Edge 型要
   指针**贴边驻留 280ms**（`SIDE_REVEAL_ENTER_DELAY_MS`，浮层一出现就整块盖住网页，
   掠过窗缘不该把面板砸下来），全功能型贴边**立即**展开（只挤开一条、无遮挡）；
   **关闭方向**：出圈后**全功能型宽限 200ms**（`SIDE_REVEAL_HIDE_DELAY_MS`，指针移出
   窗口则立即收起），**Edge 型不享这份宽限** —— 指针一离开展开区就立即收起
   （浮层盖着网页，多留一拍就是多挡一眼）；唤出态经 `layout:side-column-reveal`
   回推渲染层同步收放。
   · **静止宽是形态事实，不是实测**：`restWidth` 由 `_sideRevealRestWidth()` 按形态回答
     （Edge = rail 实测；全功能型 = 0；常驻 = 实测）。巡看判据若拿**展开后的实测**
     `sideColumnWidth`（= `revealWidth`）去比，`revealWidth > restWidth` 恒 false →
     停表收起 → 外壳报回 0 → 又开表展开……**无限闪烁重排**（全功能侧栏"hover 抖个不停"
     的根因就在这）。
   · **固定/悬停切换按钮**：侧栏骨架自造的一颗独立节点（`slots.pin`，标签侧栏与全功能
     侧栏共用同一份骨架），**不占独立行** —— 由 `ui-navbar#row/sideColumnPlan#placePin`
     落到「空间切换器所在的那一行」的**最右端**（Edge 型 → `.vtabs__top`；全功能侧栏 →
     `.navbar-side-header`，整行序 `[窗控簇][切换器] … [固定钮]`，固定钮靠 `margin-left:auto`
     推到行尾；图标条 56px 里不推、两件图标居中并排）。尺寸 26×26（图标条态
     22×22，与切换器 trigger 同高）；点它写 `app.sidebar_visibility`（`attached ⇄ floating`），
     这就是用户要的「固定占位 ↔ 悬停展开」本身，不是第二种功能。
     浮层自己也挂一颗（它整块盖住了 chrome 的 rail），点它同样是"固定"。
   · **图标条不是折叠态**：`collapsed` 是用户手动折叠（仅常驻态可点出）；Edge 型静止的
     rail 是 `revealOverlay` 的形态结果，两者在编排层折成一个 `collapsed` 输入给骨架
     （`collapsed || revealOverlay`），骨架本身不判形态。
    ✅ 跨窗口拖拽走统一 drag-item 与目标窗口落点，不再依赖源窗口渲染层上报矩形。
10. ✅ 悬停唤出的**互斥仲裁**与 popover 锁定：侧栏区在台上时窗口外缘归侧栏 → rail 的边缘唤出停表（`syncCursorEdge`，一条明确的归属规则优于运行时仲裁）；**唤出态里弹出右键菜单时自锁**（菜单存续期间指针在系统菜单上，不锁就会被当场收起 —— 见 `shared/tab-row-menu.js#onMenuState`，对齐 RT 的 `activePopovers`）。
11. ✅ `Ctrl+Shift+,` 切换预设（`layout:toggle-vertical-tabs`；顺带让快捷键系统认识标点键 —— 按 `event.code` 归一化，解决 Shift 下 `event.key` 是上档字符导致声明永远匹配不上的问题）。

**验收**：标签操作、预览、右键菜单与水平模式逐项一致 —— ✅（右键菜单与横向标签条/面板共用同一份实现 `createTabContextMenu`；「重命名标签」在纵向列表未提供，与面板口径一致）。

### P2 · V1（All-in 型）—— ✅ 已落地（除标注项）

12. ✅ `ui-navbar` 的纵向形态：`data-host-axis="column"` 下用 `flex-direction: column` 让三段各占一行（**地址栏一行 → 导航按钮一行 → 站点控制一行**），行间 6px。不用「换行 + 独占行」的近似 —— 那种行数是宽度决定的、会随侧栏宽窄漂移；纵排形态是确定的三行。顺带修正：`setCompactLayout` 的判据从 `plan.mode` 改为 `plan.merged`（否则 `layout_mode=compact` + 垂直时，导航按钮会被搬进已不在台上的标签行而凭空消失）。
13. ✅ 侧栏内分区顺序与底部工具区：`app.side_row_order` 决定侧栏内自下而上的堆叠顺序；底部工具区 = `[+ 新建标签] [窗口控制按钮（宿主为标签栏时）]`；空间切换器在**顶部**槽（= §3.2 的「空间标题行」，落点说明见 §2.7）。`.vtabs` 由 `height:100%` 改为 `flex:1`，与同列的导航栏块共存时不再溢出。**顺带补齐一个必改项**：垂直模式下标签条不在顶部，横向的拖拽区随之消失 —— 拖窗口改由侧栏**之外**的行承担（顶部导航栏 / 标题栏 / 书签栏）；侧栏内容区三态**整块 no-drag**（§3.3 / §4.6），不再出现任何拖动区域。
14. ✅ 预设 `vertical-all-in-one`（标签栏 + 导航栏同时进侧栏）已在设置页可选并正确写入区域键；**全功能侧栏的悬停唤出走自动隐藏占位**（`revealOverlay = false`：静止 0、唤出时同一块 `#chrome-side` 改宽、网页真让位 —— 这一型不建浮层）；Edge 型才走「rail + 独立浮层」，两型共用同一份 `planChromeLayout` 判据。

**验收**：设「导航栏位置 = 侧栏」（或选预设「垂直标签（全功能侧栏）」）→ 侧栏自上而下为「地址栏 / 导航按钮 / 站点控制」三行 + 空间标题行 + 标签列表 + 底部工具区；网页按侧栏宽让位；**侧栏内任何位置都不出现拖动区域**（整块 no-drag），拖窗口走侧栏之外的行；切回顶部 → 像素与现状一致。`pnpm build` 通过 + `node scripts/check-layers.cjs` 0 违规。

### P3 · 打磨

浮出态毛玻璃卡片、`forceFloating` 快捷键、窄窗自动收起、Compact Mode 合并、侧栏内标签搜索、固定标签网格化、按域名自动堆叠、树状父子标签、分屏 / 悬浮预览组。

---

## 6. 风险与回滚

| 风险                           | 触发 | 缓解                                                                                        | 回滚                       |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------- | -------------------------- |
| 容器结构改造影响水平模式       | P0   | 无块入住侧栏时 `#chrome-side { display:none }`，`#chrome-main` 结构等价现状；构建后目视比对 | 恢复原三段结构             |
| 「位置」取值扩展破坏旧值       | P0   | 归一化函数保留 `top/bottom` 语义，未知值回落（与现有一致）                                  | 还原 options 表            |
| 预设与逐块微调不一致           | P0   | 预设是**单向宏**；不匹配时 UI 显示「自定义」，不反向覆盖用户选择                            | 去掉预设键，仅保留位置下拉 |
| 开合动画期间 bounds 抖动       | P1   | 照 RT：100ms 同源插值 + 30fps 采样 + 覆盖态不占位                                           | 关闭插值（瞬变）           |
| V1 下顶栏空得难看              | P2   | 顶部其余栏默认保留；可选「悬停顶部唤出」（Zen 做法）                                        | 强制 titlebar=top          |
| 两个标签渲染路径漂移           | 全程 | 规定：**标签级功能一律先进 `ui-common`**；`ui-tabbar` 只保留横向专有视觉                    | —                          |
| 浮层视图首帧动画不动           | P1   | 本视图 rAF + 双 rAF + 强制 reflow；两态交接 skip 动画                                       | 关入场动画                 |
| 侧栏与 rail/panel 同侧时重叠   | P0   | 轨道单点计算（§4.9）+ `railX` 让位；目视三区块与网页边界                                    | 侧栏与 rail 强制异侧       |
| 多个区块同时悬停展开把网页挤没 | P1   | 悬停展开互斥仲裁 + popover 锁定（§4.8）                                                     | 关闭悬停唤出，仅手动展开   |
| 宽度变化两次跳动               | P1   | lane 统一重算并**一次上报**最终值，禁止区块各自改 x                                         | 关过渡（瞬变）             |
| 垂直列表与水平标签视觉漂移     | P1   | 共用 token 与 `ui-common`；§3.1 规定行高/圆角/字号与水平模式**完全一致**                    | —                          |
| 边缘出现不可点的 deadzone      | 全程 | Vivaldi 8.0 的反面教材（§4.8）：只留 1px 分隔线，不做装饰性粗边框                           | —                          |

---

## 7. 验收清单

- [ ] **判据成立**：无块选 `side` → 侧栏区域零宽零高，渲染与改造前逐像素一致
- [ ] 位置下拉含「侧栏」；四块任意组合（含"只把书签栏放侧栏"）都不产生矛盾态
- [ ] 预设三选一：`classic` / `vertical-tabs`（V2）/ `vertical-all-in-one`（V1）一键切换且可微调
- [ ] V2：侧栏标签 + 顶部完整 navbar 行；V1：侧栏含地址栏与标签，顶部只剩窗口条/标题栏/书签栏
- [ ] 侧栏顺序表生效（纵排堆叠），行区顺序表不受影响
- [ ] 原 `layout_mode=compact` 在两种垂直形态下均**自然无效果**（不报错、不留残影）
- [ ] 侧栏状态（`hidden` / `attached`×展开·折叠 / `floating`）行为符合 §4.5 与 architecture §6.1；宽度夹取 150–500、默认 200、重启保持
- [ ] 折叠态 = 图标条；`floating` 下悬停浮出完整列表且**不重排网页**（覆盖层是独立视图）；覆盖层内弹出右键菜单时不收起
- [ ] 标签操作全绿：切换 / 关闭 / 新建 / 静音 / 双击 / 中键 / 拖拽排序 / 并组 / 出组 / 跨窗口
- [ ] hover 预览、右键菜单与水平模式**逐项一致**
- [ ] 块级契约：`setHostAxis('column')` 后 navbar 与 tabbar 各自正确变形，且**互不引用**
- [ ] **UI 规格**（§3.1–§3.2）：行高 32 / 圆角 9 / 标题 12px / favicon 18+2×2=22 / 滚动条 4px / 分区顺序与空态符合规格；与水平模式"同一个标签看起来一样"
- [ ] **可访问性**（§3.4）：`role="listbox/option"` + `aria-selected` + `aria-expanded` 齐备；焦点环用 `var(--focus)`
- [ ] **`prefers-reduced-motion: reduce`** 下宽度变化与浮出改为瞬时
- [ ] **轨道**（§4.8）：侧栏与 rail/panel 同侧时顺序为 `[垂直标签栏][rail][panel][网页]`，无重叠、无缝隙，rail 自动让位
- [ ] 同一时刻只有一个区块悬停展开；区块内有 popover 打开时该区块锁定不收起
- [ ] 宽度变化只有**一次**位移（无二次跳动）；区块之间无不可点 deadzone
- [ ] **模块边界**（§4.9）：`ui/ui-vertical-tabs` 不 import 任何具体块（可用 grep 校验）；轨道注册表加一行即可接入一个新侧栏区块
- [ ] 零新增 IPC 通道（对照 §4.7）
- [ ] `node scripts/check-layers.cjs` 无新增违规
