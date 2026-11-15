# 垂直标签与外壳排布的架构spec（轴向无关）

> 本文回答两件事：
>
> 1. **外部浏览器（Edge / Vivaldi）怎么做垂直标签**，与 NG 现在的做法差在哪，该收敛到哪种范式；
> 2. **纵排宿主（侧栏）里导航栏的按钮/控件怎么排** —— 现在为什么乱，目标规格是什么。
>
> 落地拆解（每一步改哪个文件）见 §6。设计背景（功能全集、视觉规格、块级契约）见
> `docs/vertical-tabs-design.md`，本文是它的**架构续篇**，不重复其内容。

---

## 1. 三种范式

### 1.1 Edge / Chrome：一份视图 + 两套布局容器

Chromium 的标签条在 **views 层（C++ 原生控件）**，不是 web DOM。它被抽象成「区域视图」：

|      | 横向                      | 纵向                         |
| ---- | ------------------------- | ---------------------------- |
| 容器 | `TabStripRegionView`      | `VerticalTabStripRegionView` |
| 复用 | **同一份 `Tab` 视图对象** | 同上                         |

拖拽排序、右键菜单、hover 预览、关闭、标签组 —— 全部**不分横竖**，住在 `Tab` 视图里。
切换方向只是「把同一个 tab 集合塞进另一个容器 + 换一个排布方向」（`Ctrl+Shift+,`），
由策略 `VerticalTabsAllowed`（Win/macOS ≥ 88）控制可用性。

**结论：既不搬 DOM，也不独立写一份，而是第三种范式 ——「一份视图 + 两套布局适配器」。**

### 1.2 Vivaldi：Chromium 内核，UI 在 web 层

Vivaldi 的界面是  `window.html`（web 技术层），所以社区 CSS Mod 与 `custom.js` 能直接
改 `#browser` / `#switch` / `#panels-container` 这些 DOM —— 它的标签条**本身就在 DOM 里**。
垂直标签支持置左/置右 + full title，另有 **tree-style tabs**（父子层级树）与
**tab stacking**（手风琴折叠）。

但 Vivaldi 自己也**不是**把横向 DOM 搬到侧边：它同样是同一套 tab 组件 + 同一套
tree/stack 逻辑，只是换布局方向与呈现。多出来的树形/堆叠是**叠在布局之上的一层语义**。

### 1.3 NG 现状：两条平行实现

|        | 横向                                                                                           | 纵向                                  |
| ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| 包     | `ui/ui-tabbar`                                                                                 | `ui/ui-vertical-tabs`                 |
| 内核   | `components/Tab.js` + `view/renderer.js` + `view/dropController.js` + `view/stackLineLayer.js` | `@hira-ng/ui-common#createTabRowList` |
| 同源者 | 无                                                                                             | opentabs 面板、固定标签面板           |

即：**纵向那套与面板同源，与真正的横向标签条反而不同源。** 这是当前最大的架构债 ——
入参格式、拖拽规则、右键菜单、hover 预览要维护两份，改一处必漏一处。

---

## 2. 搬家 / 独立写 / 共享视图：为什么不选前两个

| 方案                                  | 代价                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **搬 DOM**（横向 DOM 挪到侧边）       | web 里代价最高。`-webkit-app-region`、拖拽监听、焦点、`data-*` 状态、滚动位置全丢；横向的 `gestures.js` / `dropController.js` 是重状态逻辑，搬迁 ≈ 重写。**排除。** |
| **独立写第二份**（现状）              | 两份实现长期漂移；每加一个标签能力（分屏预览、休眠置灰、tab search）都要写两遍。**停止扩散，逐步收敛。**                                                            |
| **一份视图 + 两套布局适配器**（目标） | 需要把标签行的**几何**从**语义**里剥出来。NG 已经具备条件 —— 见 §3。                                                                                                |

---

## 3. 目标架构：轴向无关的标签行

### 3.1 分层

```
┌── 语义层（轴向无关）────────────────────────────────────────────┐
│  投影项数据契约 · 意图词表 · keyed 复用 · 标签组语义 · 手势时序    │
│  · 取色守卫 · 菜单模板                                          │
└────────────────────────────────────────────────────────────────┘
                     ▲                          ▲
        ┌── 轴向适配器 ──┐            ┌── 轴向适配器 ──┐
        │  axis = 'row'  │            │ axis = 'column'│
        │  主轴=宽 / 指示线=竖线      │ 主轴=高 / 指示线=横线 │
        │  组连接线画在芯片下方 │            │  组连接线画在成员左侧 │
        └────────────────┘            └────────────────┘
                     ▲                          ▲
        ┌── 呈现 ──┐                 ┌── 呈现 ──┐
        │ ui-tabbar│                 │ui-vertical-tabs│
        └──────────┘                 └──────────┘
```

### 3.2 适配器契约（新）

一个轴向适配器回答**只有几何**的问题，不碰任何语义：

```ts
type AxisAdapter = {
  axis: 'row' | 'column';
  /** 主轴上的「前 / 尺寸」—— 拖拽落点判定与插入指示线定位都用它 */
  measure(
    el: HTMLElement,
    containerRect: DOMRect,
  ): { start: number; size: number };
  /** 插入指示线该画在哪条边、怎么定位（横线 / 竖线） */
  placeIndicator(
    indicator: HTMLElement,
    target: DOMRect,
    before: boolean,
    containerRect: DOMRect,
  ): void;
};
```

- **语义层**只问适配器「这两个矩形的先后关系」；
- **适配器**只回答坐标，不认识 tabId、不认识标签组、不认识菜单；
- **呈现**（`ui-tabbar` / `ui-vertical-tabs`）负责搭骨架 + 注入端口。

### 3.3 已经就位的部分

横向这一侧，`ui-tabbar` 的最小件**已经天然轴向无关**（上一轮拆分成果）——
它们已**上移到 `ui-common/src/tab/`**（横向标签条与纵向标签列 / 两个面板引用同一份）：

> **已经收敛的两件**：① 标签条的**滚动行为**（`ui-common#stripScroller`，模式 = `axis`
> 一个参数）；② 上述最小件的**归位**（从"横排私有"变成两端可达）。
> 它们是「两处实现 → 一处 + 参数」的样板，后面几件按同样口径走。

| 最小件（`ui-common/src/tab/`） | 为什么与轴无关                             |
| ------------------------------ | ------------------------------------------ |
| `iconArea.js`                  | favicon ↔ 无痕 ↔ 音频按钮 三态机，只造 DOM |
| `titleArea.js`                 | 一个容器 + 一行省略号文本                  |
| `closeButton.js`               | 吃冒泡 + 16px 命中区                       |
| `gestures.js`                  | 单击/双击/中键 + **模块级**双击计时        |
| `faviconTint.js`               | 异步取色 + 「这一行此刻代表哪张图」守卫    |
| `chipArrow.js`                 | 折叠箭头（只换 chevron）                   |
| `chipMenu.js`                  | 芯片菜单模板（零 DOM）                     |
| `renameSlot.js`                | 行内重命名（Enter/失焦/Esc）               |

**上移已完成**（它们只依赖 `ui-common` 自己的图标/取色/classnames ✓ 已落在 `src/tab/`），
且其中的**两条渲染规则已真正共用**（`renderAudioState` 音频三态 /
`createTabFavicon()` 交回的 `render()` —— 图标位三选一：favicon ⇄ 🕶 无痕 ⇄ **标题首字兜底**，
纵向列表已改调它们）。**图标位永远占 22px**（18px 图标本体 + 2px 白边，
即 `ui-common/src/tab/iconArea.ts` 的 `FAVICON_BOX`）且没有 favicon 时补标题首字：
少了这条，图标条形态下（用户折叠，或自动隐藏按折叠档唤出）标题也被隐藏 —— 那一行就只剩一条细缝。

**剩下的是「行 DOM 结构的采用」**：纵向列表
（`ui-common#tabRowList`，同时喂着侧栏与两个面板）目前仍自己造行内 DOM 与行内 CSS —
那属于渲染内核改动（§6 第 5 步的后半），按"逐件上移、每件单独构建验证"的规矩单独做。

---

## 4. 侧栏（纵排宿主）的分区规格

### 4.1 现在为什么乱（几何硬账）

全功能侧栏模式（`vertical-all-in-one`：`tabbar` 与 `navbar` 都住侧栏）下，两块**各排各的**，
而导航栏把「导航簇」与「面板簇」挤在**同一行**里：

```
侧栏默认 200px → #navbar-toolbar 纵排内边距 8px×2 → 可用宽 184px
  rail 开关 + 后退 + 前进 + 刷新 + 主页 = 5 × 32px + 4 × 4px  = 176px
  面板簇（4 个面板 + 菜单）              ≈ 4 × 32px + 4 × 4px  = 144px
  ────────────────────────────────────────────────────────────────────
  两簇相加 ≈ 320px  ≫  184px  →  被 #navbar-toolbar 的 overflow:hidden 裁掉
```

侧栏拉到最小 150px（可用 **134px**）时，连**导航簇自己**（176px）都装不下。
再叠加空间切换器落在整列中间（它是 tabbar 的顶部槽，而 navbar 排在它前面）——
一进侧栏看不到「我在哪个空间」。于是就成了「上下左右七七八八四方大拉各处都有」。

**结论：这不是调 CSS 能救的，是分区归属错了。** 面板簇语义上属于「列表之下、
底行之上」那条工具行，而 navbar 块住在标签列表**上方** —— 它根本不该待在 navbar 块里。

### 4.2 目标规格（确定的行，与宽度无关）

```
┌─ 侧栏（#chrome-side，flex column）─────────┐
│ [— □ ✕][空间切换器]                ① 标题行 │  ┐
│ [         地址栏（全宽）        ]  ② 地址栏行│  │ navbar 块
│ [◉ ⛨ ☆ →]（站点控制件折在下面）            │  │ (#navbar-toolbar)
│ [← → ⟳ ⌂]                        ③ 导航行  │  ┘
│ ───────────────────────────────────────── │
│ 标签列表（flex:1，行两侧 8px 内缩）   ④ 列表体 │  ┐
│ ───────────────────────────────────────── │  │ tabbar 块
│ [▤][▥][▦][▧]              [☰]     ⑤ 面板行 │  │ (.vtabs)
│ ───────────────────────────────────────── │  │
│ [+ 新建标签]（列表自带的浮钮）       ⑥ 底部行 │  ┘
└───────────────────────────────────────────┘
```

| #   | 行       | 内容                                                      | 归属（DOM 实际所在）                                      |
| --- | -------- | --------------------------------------------------------- | --------------------------------------------------------- |
| ①   | 标题行   | 窗口控制按钮 + **拖拽手柄**（与窗控保持 6px，见下）+ 空间切换器 | navbar 块的 `.navbar-side-header`（整列顶部，故寄住在此） |
| ②   | 地址栏行 | `.navbar-bottom-center`（omnibox，全宽）：**输入框独占一行**，站点控制件（权限铃 / 内容拦截 / 收藏星 / 转到）折在第二行 | navbar 块 |
| ③   | 导航行   | `.navbar-actions-row` 里的**导航簇**（rail 开关恒在最前） | navbar 块                                                 |
| ④   | 列表体   | 标签列表（`flex: 1`）                                     | tabbar 块 `ui-vertical-tabs`                              |
| ⑤   | 面板行   | `.navbar-bottom-right`（面板簇 + 菜单）                   | **借住** tabbar 块的 `slots.dock`                         |
| ⑥   | 底部行   | **空**（`slots.bottom` 留着，当前没有搬运者）             | tabbar 块                                                 |

> 「新建标签」在侧栏下**不搬**：纵向标签列表自带常驻的「新建标签页」浮钮
> （ui-common 的 `.tabrow-add`），navbar 那颗 `#navbar-add-tab` 留在标签行即可
> —— 侧栏模式下标签行不在台上，随之自然不显示。否则同一条侧栏里会有两个新建入口。
> 见 `ui-navbar#row/sideColumnPlan` 的 ⑤ 判据。

**两条判据**：

- **「一块一个主人」**：同一颗节点在任一时刻只被一个搬运者主张。①⑤ 的落点各由
  一个专门的小块判定（`sideColumnPlan` / `sideDock` / `windowControlsPlacement`），
  不再散在三处（构造 / 布局回调 / 侧栏切换）。① 这一行有两位住客（窗口控制按钮 +
  空间切换器），各由自己的模块搬入：切换器 `append`、窗控 `insertBefore` 首位 ——
  「窗控在左、切换器在右」于是只是一个位置事实，两位住客互不认识。
- **⑤ 是跨块借位**：navbar 块在标签列表**上方**，面板行要在**下方** —— DOM 上只能
  借住到 tabbar 块里。`ui-vertical-tabs` 只开一个**空槽**（它不认识面板是什么），
  `sideDock` 只回答「搬不搬进去」（它不认识侧栏骨架长什么样），两边只共享「一个空槽」。
  横排与 Edge 型垂直标签下这一槽永远空着（`:empty` 不占位），视觉逐像素不变。

### 4.3 为什么用包裹行 + `order`，而不是靠 flex-wrap 排版

`flex-wrap` 的行数是**宽度决定的** —— 两段恰好挤得下就并成一行，形态随侧栏宽窄漂移。
而纵排规格是**确定的行**，与宽度无关。故：

- 横排：包裹行 `display: contents` 透明化，`bottomLeft` / `bottomCenter` / `bottomRight`
  靠 `order` 回到「左 / 中 / 右」；
- 纵排：包裹行是**真实的 flex 行**，靠 `order`（① -2 / ② -1 / ③ 0）排成确定的三行。

**`flex-wrap` 只在两个地方作为「降级护栏」保留**（它们防的是裁切，不是排版）：

- `#navbar-toolbar[data-host-axis="column"] > .navbar-actions-row` 与 `#toolbar-navigation-buttons`
  —— 侧栏 150px 时导航簇 176px 仍装不下，折成两行好过被裁掉两颗按钮；
- `.vtabs__bottom` 与 `.panel-buttons`
  —— 面板是插件、数量会生长；折行好过被裁掉几颗按钮。

**侧栏里的按钮间距、尺寸与高度都走独立口径**（窄列不是横排的等比缩小）：

- 间距：`--ng-navbar-column-gap`（**0px**）取代横排的 `--ng-navbar-bottom-row-gap`（4px），
  消费方是纵排的①②③三行（导航簇 / 侧栏标题行 / 底槽按钮簇）与地址栏内部
  —— 一处 token，两种形态各一条轴。0 是间距的底：按钮相邻，只剩各自圆角与内边距当留白；
- 地址栏行（②）在纵排下**折成两行**：`#address-input` 取 `flex-basis: 100%` 独占第一行，
  站点控制件（权限铃 / 内容拦截 / 收藏星 / 转到）折到第二行（`.omnibox` 开 `flex-wrap`）。
  134px 的栏里让输入框与四颗按钮挤同一行，等于两边都残废（输入框只剩几十像素）。
  为什么折行而不是把它们搬去别的行：这四件都是"**当前这个页面**"的动作，语义上该跟着地址栏走；
  一行的 `--ng-omnibox-gap`（8px）也随之换成 `--ng-navbar-column-gap`（0px）。
- 行距：纵排块自己的 `row-gap` 由设计稿 §3.2 的 6px 收到 **3px**、上下内边距 `6px → 4px`
  —— 常规宽度下的 6px 在窄列里比按钮本身还抢眼。行距不是按钮间距，故不并进上面那条 token；
- 尺寸：`--ng-navbar-action-btn-size-column`（29px）与 `--ng-navbar-action-btn-icon-size-column`（16px）——
  比横排的 32 / 18 收 3px。四档都试过：26、28 嫌小，30、32 嫌大。判据的**两个宿主写在同一条规则里**
  （纵排导航栏块内部 + `[data-dock="true"]` 的底槽按钮簇；后者不在导航栏块里，后代选择器命中不到）。
  图标是 svg 的 width/height **属性**，按标准行为可被 CSS 覆盖，故两态只差一份 CSS、不回 JS 改 size；
- 高度：侧栏底槽的按钮网格有护栏 `--ng-navbar-dock-buttons-max-height`（30vh）。
  面板插件多到超过护栏时，**在按钮簇内部滚动**（`overflow-y: auto`），标签列表不会被一路挤没。
- 空间切换器：**窄栏（≤220px）只留图标、不留名字**——全功能模式下顶行还住着窗控簇（三颗 28px），
  200px 的侧栏留给它只剩 ~99px。判据是**容器查询**（`@container side-column`），
  容器 = 切换器所住那一行（同名两个，按它住哪决定用哪个）：
    · `.vtabs`（侧栏骨架，Edge 型：切换器住侧栏顶部槽）；
    · `.navbar-side-header`（全功能侧栏：切换器寄住在侧栏顶行）。
  两者宽度都 = 侧栏区宽度、**与内容无关**，所以藏掉名字不会反过来把"宽"判成"窄"
  （自测量写法会死锁：名字一藏，自身宽度再也回不去）。
  > ⚠ **容器不能声明在"侧栏区本身"上**（chrome 的 `#chrome-side`）——
  > 那两个是**玻璃带**（`background: --hira-chrome-bg` + `backdrop-filter`），而
  > `container-type` 带的 **layout containment 会让元素成为 backdrop root**：
  > 它自己的 `backdrop-filter` 从此**采不到底下那层壁纸** ⇒ 这一带静默失去毛玻璃，
  > 变成"遮罩压在没糊的壁纸上"，颜色与 navbar / 内容洞 / 底部条**对不上**
  > （2026-10 实测：用户报"垂直标签侧栏的模糊效果颜色和其他界面分裂根本不一样"）。
  > 结论：**玻璃带一律不写 contain / container**；要容器就挂在同宽、不带玻璃的内层元素上。
- 拖拽手柄：①标题行里「窗控簇 → 手柄 → 空间切换器」相邻，而按钮之间的缝在侧栏里是 0
  （`--ng-navbar-column-gap`）—— 手柄是 16px 宽、整行高的抓取区，紧贴关闭键（纵排下是 macOS 红绿灯）
  会一抓就点到关闭。故 `#navbar-drag-handle:not(:first-child) { margin-left: 6px }`
  （与它右侧 margin 同数）；横排下它恒是行首，这条不生效。

**菜单按钮与按钮网格分开**（借住底槽时）：`.navbar-bottom-right` 在底槽里改成竖排堆叠 ——
网格在上（可滚、可折行）、菜单在下（`flex: 0 0 auto`，不可压缩）。
不分开的话它在同一个折行队列里，插件一多就被推到折行末尾挤出可视区（用户实测「被挤掉」）。
形态由 `row/sideDock.js` 打的 `data-dock="true"` 通告 —— 样式不认侧栏骨架的类名
（两块分属不同的包），只认本块自己的标记。

CSS 能表达的交给 CSS，只有「DOM 归属」才走 JS（与 `docs/vertical-tabs-design.md` §2.8 同一口径）。

### 4.4 纵向轨道两段各有自己的侧（两条独立设置）

纵向轨道上相邻的两段**各有自己的一条位置设置**，可以各靠一边：

| 段     | 内容                                  | 设置键                     | 谁消费                                           |
| ------ | ------------------------------------- | -------------------------- | ------------------------------------------------ |
| 工具段 | rail 图标栏 + 侧边面板                | `app.sidebar_position`     | `LayoutCoordinator#_sidebarPosition` + 面板 slot |
| 标签段 | 垂直标签侧栏（标签列 / 地址栏那一列） | `app.side_column_position` | `LayoutCoordinator#_sideColumnSide`              |

- **几何**：`applyInitialLayout` 按「每一侧各自累加」写 —— 每一侧由外到内都是
  `[侧栏区] → [rail] → [面板]`，两段分居两侧时各算各的内缩与 x；同侧时退化成原来的
  单一 `laneWidth`（逐像素不变）。
- **渲染层**：`plan.side.position` 决定 `#chrome-side[data-side]`（flex `order` 表达左右，
  元素始终留在 DOM 里）。侧别随占宽一起经 `layout:setPageLayoutParams` 上报。
- **升级**：老 profile 两段共用 `app.sidebar_position`，新键缺省时由 settings 存储
  **一次性沿用旧键的值**（`domain-settings#legacyKeyOverrides`）—— 升级瞬间观感零变化。

**面板开在哪一侧**（同一套「入口自己声明」的范式）：

| 入口                                                 | 侧                                           |
| ---------------------------------------------------- | -------------------------------------------- |
| rail 图标                                            | rail 自己那一侧（= `app.sidebar_position`）  |
| 导航栏的面板按钮（横排 / Edge 型）                   | 右侧（按钮在右侧）                           |
| 导航栏的面板按钮（全功能侧栏，已借住到标签侧栏底槽） | **标签侧栏那一侧**（= `plan.side.position`） |

最后一条是**渲染侧唯一裁定处**（`app-shell#onPlan` 的 `panelOpenSide`）：判定事实是
「导航栏块自己是否住在侧栏」（= 工具按钮行已借住到 `slots.dock`，见 `row/sideDock.js`），
按钮的点击闭包只读这个值 —— 不去猜 DOM 归属，也不跟任何 CSS 判据重叠。

---

## 5. 模块地图（改完之后）

### 5.1 `ui/ui-navbar`

| 文件                             | 职责                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/chromeBlocks.js`     | 两块 + 四行（含**工具按钮包裹行**）的空容器骨架                                                                                                                               |
| `components/sideHeader.js`       | 侧栏标题行槽（纵排下才占位；空则 `:empty` 不显示）                                                                                                                            |
| `row/sideColumnPlan.js`          | **侧栏分区计划**：① 的寄住规则 + 标题行显隐；「新建标签」只在**横排**下钉回标签行末（侧栏下不搬，列表自带浮钮）                                                               |
| `row/sideDock.js`                | **侧栏底槽借位计划**：⑤ 面板簇（站点控制区）的落点（借 `slots.dock` / 回工具按钮行）                                                                                          |
| `row/tabRowLayout.js`            | 标签行内谁先谁后（横排）                                                                                                                                                      |
| `row/windowControlsPlacement.js` | 窗口控制按钮落点（唯一判定）：横排导航栏 → 整行最右（CSS `order`）；横排标签栏 → 标签行末 / 侧栏底槽；纵排（全功能侧栏）→ 侧栏顶行最前、空间切换器**左边**；宿主标题栏 → 让出 |
| `row/railButtonPlacement.js`     | rail 开关落点（侧边栏左/右 × 宿主轴；纵排恒留导航簇首位）                                                                                                                     |

> ①⑥ 与 ⑤ 分成两个文件，是因为判据不同：前者只问「标签栏在不在侧栏」，
> 后者还多问「本块自己在不在侧栏」。合成一个必然写成两组互不相干的 if。
>
> **形态事实只有一份**（`row/rowForm.js`，2026-10 收口）：轴 / 侧栏槽位 / 侧别 /
> 单行 / 窗控宿主五个事实全住在一个对象里，上面五个模块**只读**它、谁都不存副本。
> 从前每个模块各存各的 `axis`/`slots` 并各留一个 `setAxis`/`setSlots`，代价是两类病：
> 「换布局时少通知一条路径」→ 某个按钮凭空不动；以及**重摆时机互相错开** →
> 最终 DOM 顺序取决于哪条通知后到（不确定、不可复现）。现在编排层（`rowBinding`）
> 改一个事实后按**一处写死的顺序**（`placements`：侧栏分区 → 窗控 → 面板簇 →
> rail 开关 → 标签行）把所有落点重摆一遍 —— 顺序里那条"窗控插到最前 ⇒ 落在
> 手柄/切换器外侧"的依赖，读那一行就全知道。
> **加一个落点模块 = 加一个文件 + `placements` 里一行**，不必再去找第二条通知路径。
>
> 原 `row/slotPorter.js` 被 `row/sideColumnPlan.js` 取代：它只搬「空间切换器 / 新建标签」
> 两件，而标题行的寄住判定需要同时知道「本块的轴」——那是同一件事的另一半，
> 拆两个文件必然出现「一边搬过去、另一边按老规矩搬回来」。

### 5.2 `ui/ui-vertical-tabs`

| 文件            | 职责                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/styles.js` | 全部样式（骨架四段 / 固定钮 / 把手 / **图标条形态** / 最小基底）                                                                                         |
| `src/host.js`   | 骨架（`top` / `body` / `dock` / `bottom` 四段）+ 宽度把手 + 「图标条 / 展开」两态 + 固定/悬停切换按钮（**不认识标签**；按钮不占独立行，见下）              |
| `src/index.js`  | 装配器：host + 标签列表 → `createVerticalTabs` + `verticalTabsDefinition`                                                                                |

拆分的判据与 `ui-tabbar` 完全一致：**能独立换掉的东西单独一个文件**。
`host.js` 换掉（例：换成网格型固定标签宿主）不影响标签列表；标签列表换掉
（例：换成网格型固定标签）不影响骨架与把手。

**它只负责「这块区域长什么样」**：常驻 / 折叠的宽度与自动隐藏的唤出宽度都由侧栏容器
按计划给（`plan.side.restWidth / revealWidth`），本组件不做策略判断 ——
所以「固定在位」与「悬停唤出」共用同一份骨架、同一个实例，见 §6.1。

**五槽的对外契约**（`createVerticalTabs(doc).slots`）：

| 槽       | 语义                                                        | 谁搬进来                                                                          |
| -------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pin`    | 「固定占位 / 悬停展开」切换按钮（骨架自造，**不占独立行**）  | 本组件交意图（`ctx.onTogglePin`）；落点由 `sideColumnPlan#placePin` 统一（见下）   |
| `top`    | 侧栏顶部槽                                                  | 编排层 / `sideColumnPlan`（Edge 型下空间切换器）                                  |
| `body`   | 标签列表（滚动区，`flex:1`）                                | 本组件自己                                                                        |
| `dock`   | 面板行（**空槽**，`:empty` 不占位）                         | `sideDock`（全功能侧栏下面板簇）                                                  |
| `bottom` | 底部行                                                      | **空槽**（当前没有搬运者：新建标签由列表自带的浮钮承担，窗控归侧栏顶行，见 §5.1） |

**`pin` 是槽位，不是一行**：它的语义就是切「固定占位 ↔ 悬停展开」（写
`app.sidebar_visibility`，与全功能侧栏同一份实现，见 §6.1），所以它必须长在
「空间切换器」旁边 —— 用户点它时看的是那条侧栏驻不驻留，不是某一块区域的局部开关。
因此骨架**不把它挂进 `host`**，只作为独立节点随 `slots` 交出去，由
`ui-navbar/src/row/sideColumnPlan.js#placePin(inSide)` 在每次重摆时落到
**空间切换器此刻的父节点**（Edge 型 → `.vtabs__top`；全功能侧栏 → `.navbar-side-header`），
并且一律 `insertBefore(pin, workspace)`：

- 两种布局下整行序都是 `[窗控簇][固定钮][切换器]`，同一行、同一 26px 高；
- 插在切换器**之前**（而不是 append），是为了不破坏全功能侧栏
  `sideHeader.lastChild === workspace` 这条幂等判据 —— 否则每帧重摆都会抖动；
- 横排（侧栏不在台上）时 `pin.remove()`，不给纵排导航栏留一颗孤钉。

尺寸：展开态 26×26（图标 14，与切换器 trigger / 侧栏标题行窗控同高），
图标条态 22×22（图标 13）；`.vtabs__top` 与切换器 trigger 的边距同时收到
`gap/padding 2px` 与 `padding 0 4px`，56px 图标条里 `22 + 2 + 22 + 4 = 50` 不溢出。

### 5.3 跨模式共用件（`ui/ui-common`）

上面两个包各自保留**只属于自己那一侧**的版式；凡是「两种模式行为本应一模一样」的能力，
一律收在这里，模式只作为一个**参数**（哪根轴 / 哪一侧）传进去 —— 否则必然出现
「横排修好了，纵排还是坏的」（这正是本轮滚动条那一串问题的成因）。

| 文件                                                                    | 职责                                                                                                                                                                                                             | 谁在用                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ui/ui-common/src/stripScroller.ts`                                     | **标签条滚动区**：主轴可滚 / 交叉轴彻底禁滚 / 滚动条外观与 hover 显隐 / 滚轮换算到主轴。模式 = `axis` 一个参数                                                                                                   | `ui-tabbar`（`#tabs-inner`, `'x'`）· `ui-vertical-tabs`（`.vtabs__body`, `'y'`）                |
| `ui/ui-common/src/hoverPreview.ts`                                      | **hover 预览状态机**：700ms 列表级计时 / 已可见立即换锚 / 320ms 重挂 / 项以外延迟收 与 离开列表即收 / 按下别处即收（五条规则只此一份，第 ⑤ 条由调用方注入 `document`）                                                                                          | `ui-tabbar#TabPreview`（锚点 = 标签）· `tabRowList`（锚点 = 行）· `pinGrid`（锚点 = 卡片）                                |
| `ui/ui-common/src/tabPreviewFacts.ts`                                   | **预览载荷形状**：锚点矩形 + 标签数据（含 `title \|\| url` 兜底）+ 可选的外侧边界（滚动容器右缘）                                                                                                                | `ui-tabbar#TabPreview` · `tabRowList`                                                           |
| `ui/ui-common/src/axisAdapter.ts`                                       | **落点几何**：中点判定 / 首尾外推 / 指示线贴边 / 指针取哪个轴。模式 = `axis` 一个参数，只吐数字不碰样式                                                                                                          | `ui-tabbar#dropController`（`'row'`）· `tabRowList`（`'column'`）                               |
| `ui/ui-common/src/tab/*.js`                                             | **标签行的最小件**（图标区 / 标题区 / 关闭按钮 / 手势 / 取色 / 芯片箭头 / 芯片菜单 / 重命名槽）—— "一张标签脸"只有一份                                                                                           | **两端均已采用**：横竖的行都取它造 DOM，各自只交类名与意图（重命名槽两端同一份）                |
| `ui/ui-common/src/tabRowList.ts`                                        | 纵向标签行列表的**渲染内核**（行 / 拖拽 / 菜单 / 预览 / 标签组），**不自带接线、不自注入样式**                                                                                                                   | 由 `tabListHost` 装配后供所有宿主使用                                                            |
| `ui/ui-common/src/tabListHost.ts`                                       | **纵向标签列表的统一装配件**：把 `createTabRowList` 与它需要的端口一次接好（意图映射 / 拖拽落库五条通道 / 右键菜单模板 / 标签组四出口 / 行外侧预览 / 自订阅或外部推入两条数据路）                                | 三个宿主**共用一份**：chrome 侧栏 · 打开标签面板 · 固定标签面板                                  |
| `apps/app-main/src/renderer/shared/tab-row-menu.js`                     | 标签行右键菜单的**动作分发表**（apps 层唯一一处：`onBack → tabsClient.back` …）。模板与文案仍在 `ui-common#createTabContextMenu`                                                                                 | app-shell · panels 宿主                                                                         |
| `packages/shared-types/src/preview-placement.mjs`                       | **悬浮预览卡的落位真源**：三种摆放（下方 / 面板外侧 / 行外侧）一套算术 + 三条不变式。**跨进程**共用（主进程有面板 bounds、渲染层有卡片实测尺寸）                                                                 | `tabpreview-overlay`（渲染）· `infra-window#LayoutCoordinator`（主进程）                        |
| `apps/app-main/src/renderer/shared/sidebar-surface.js`                  | **侧栏的装配图**（唯一一处回答"一条侧栏长什么样"）：骨架四段（`top` / `body` / `dock` / `bottom`）+ 一枚独立节点固定钮（`pin`）+ 调宽把手 + 「槽里放哪几件」（空间切换器 / 标签列表 / 窗控簇）。**造法一份，实例一份**                   | chrome 内的侧栏（`app-shell`）—— 常驻与悬停唤出共用同一个实例                                     |
| `ui/ui-common/src/windowControls.ts`                                    | **窗口控制按钮簇**（最小化/最大化/关闭 + 横排容器 + `placeInto` / `setMaximized`）。**从 ui-navbar 上移**：宿主可配（标签栏/导航栏/标题栏/侧栏底槽）                                                              | `ui-navbar#row/windowControlsPlacement`（搬节点）                                                |
| `apps/app-main/src/renderer/shared/space-commit.js`                     | 空间菜单 `overlay:commit` 的**唯一动作表**（`space:*` 五类 kind 各自落到 controller 的哪个动作）。菜单本体在共享浮层，宿主只有一个                                                                               | app-shell（外壳切换器 / 侧栏切换器）                                                            |
| `packages/shared-types/src/layout.mjs#windowControlsPlacementInSidebar` | **「窗控是否落在侧栏底槽」的两事实判据**（宿主设置 + 是否 Edge 型侧栏）。有 plan 的调用方传 `plan.windowControlsHost` / `plan.side` 是否只有标签列 —— 两边同一个答案。**Edge 型侧栏下恒 false**（用户口径：那种模式强制归导航栏） | `ui-navbar#row/windowControlsPlacement`（搬节点）                                               |

> 记账口径：**「同一件事两处实现」出现一次就收一次**。已收（16 项）：
> 滚动行为 · hover 预览状态机 · 预览载荷形状 · 落点几何 · 预览落位（跨进程真源） ·
> 音频三态与 favicon 两条渲染规则 · 标签行最小件归位 · 单击/双击计时判据 ·
> "一张标签脸"全套 DOM · 行内重命名机制 · **纵向列表的整套接线（`tabListHost`，收掉
> `ui-vertical-tabs` 与 `ui-panel-opentabs` / `-pinned` 的三份抄写）** ·
> **标签行菜单的动作分发表（`shared/tab-row-menu.js`，收掉三份抄写）** ·
> **「折叠态 = 图标条」的两套规则（折叠 / 悬停覆盖共用一个 `data-collapsed`）** ·
> **侧栏装配图（`shared/sidebar-surface.js`）** ·
> **窗口控制按钮簇（`ui-common#windowControls`，从 ui-navbar 上移）** ·
> **空间菜单动作表 + commit 回发起方路由（`shared/space-commit.js` + `COMMIT_OWNER`）**。
>
> **当前没有已知的同类重复。** 下一次再发现时按同一口径收，但先问一句：
> 「这是同一件事，还是两件**形状本就不同**的事？」—— 判据见下面这一条。
>
> **已判定「不是同一件事」的一处**（记下来免得后人反复想合并）：标签组**连接线**的绘制。
> 两轴都各自有一个绘制层（`ui-tabbar#view/stackLineLayer` / `ui-common#tab/stackRailLayer`），
> 都是「量真实矩形 + 有界 rAF 跟踪」，因为行/芯片带 `contain: paint`，线不能画在行内：
> 横排是「一条横线跨过芯片与成员、贴在标签下方的凹槽里，且必须逐帧让开横向滚动条」；
> 纵排是「展开的组行 + 成员（含合体容器）整体缩进让出左侧槽，一组一条竖向圆头线，
> 从组行顶端一直连到末成员下沿 —— 组项与标签是同一根脊，组行内部不再有自己的短色条」。
> 两者的**形状由
> 几何决定、本就不会一样**，唯一可共用的"组跨了哪几项"已经由投影（`projectTabStacks`）
> 算好了（`tab/stackMarks.js`）—— 强行合并只会把两种坐标写进同一个文件。
>
> 旧版纵向那条「贴面板最外缘、逐行 ::before」的竖条已整层删除（用户明确否掉：离行太远、
> 逐行断开）；随之删除的还有 `--tabrow-edge-inset-*`、`syncEdgeInset`、`data-stack-tail /
> data-stack-last` 与 `:root.panel-on-right` 换边镜像 —— 槽固定在行的左侧，与面板挂哪边无关。

---

## 6. 落地拆解

### 6.1 侧栏两种显隐：常驻占位 与 自动隐藏（悬停唤出）

这是垂直侧栏最容易被做歪的一处，一次写清楚。

|          | 常驻占位（含手动折叠）                                                                                                                                                | 自动隐藏（悬停唤出，Edge 的 unpin）                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 触发     | `app.sidebar_visibility = attached`（或手动折叠）                                                                                                                     | `app.sidebar_visibility = floating`（**任何**侧栏形态都成立）                                                                                                                                                      |
| 宽度     | `plan.side.restWidth`（展开 = 用户宽度；折叠 = 图标条 56）                                                                                                            | 静止 = `restWidth` 恒 0（侧栏完全消失、网页铺满）；唤出 = `plan.side.revealWidth`（折叠着就是图标条宽）                                                                                                            |
| 承载     | **chrome**（窗口本体）里的 `#chrome-side` + `ui-vertical-tabs`                                                                                                        | **同一块 `#chrome-side`**（只改 `--ng-side-width`）—— 没有独立视图、没有第二份 DOM                                                                                                                                |
| 内容     | 由 **`shared/sidebar-surface.js`** 装配：`pin`=固定/悬停按钮（**不占独立行**，插在空间切换器之前）· `top`=空间切换器（导航栏的节点搬进来）· `body`=标签列表 · `dock`=面板簇（全功能侧栏才有）· `bottom`=窗控簇（**Edge 型下恒空**——见下） | **同一份装配图、同一个实例**（侧栏一直都在文档流里，唤出只是变宽）                                                                                                                                                 |
| 上沿     | **窗口顶边**（`#chrome-side` 与主列在 `#chrome-root` 上并排，顶底两区住主列里 → 侧栏整列从顶到底）                                                                     | 同左                                                                                                                                                                                                               |
| 网页     | **让位** `restWidth`（`contentX/contentWidth` 含 `sideColumnWidth`）                                                                                                  | 静止不让位（宽 0）；唤出**真让位** `revealWidth` —— 判据只有 `getSideColumnWidth(params, revealed)` 一处                                                                                                          |
| 开合判定 | —                                                                                                                                                                     | 主进程贴边巡看（`_tickSideReveal`）→ `layout:side-column-reveal` → 渲染层 `chromeLayout#setSideReveal`                                                                                                             |
| 空间菜单 | 外壳自身的 `spaceController`；菜单浮层是独立视图                                                                                                                      | **同一个**（侧栏就在外壳里，不存在"第二宿主"）                                                                                                                                                                    |

六条不可动摇的约束（每一条都是别处踩过的坑）：

1. **不做浮层，"盖在网页上"这条路本就不该走**。网页是原生 `WebContentsView`，天然在
   chrome 之上，chrome 里的 DOM 再高的 z-index 也盖不住它（见 `infra-window/src/ChromeView.js`）；
   改成独立原生视图则要维护"第二份侧栏"，必然与常驻态越走越远。自动隐藏的正解是
   **同一块区域改宽** —— 网页让位、视觉连续、只有一份状态。
2. **静止宽 0 是静止态本身，不是折叠态**。`restWidth = 0`，唤出只改 `--ng-side-width`，
   绝不回写 `restWidth`（"平时占多宽"只有一个事实）。收起时**连分隔线一起收掉**
   （`#chrome-side[data-revealed="false"]` 去 border）—— 否则窗缘留 1px 线，看着像
   "侧栏还在、只是窄了"。`collapsed`（用户手动点出的图标条）与自动隐藏是正交的两件事：
   自动隐藏时展开仍按 `collapsed` 决定露出图标条还是完整侧栏。
3. **判定必须在主进程**：静止时侧栏宽 0，窗边那一竖条下面是网页原生视图，渲染层收不到
   任何指针事件 —— "该不该展开"只能读屏幕指针。复用沉浸模式的同一组常量：
   `IMMERSIVE_TICK_MS = 80`（`setInterval` + `unref`，且只在需要时起表）、
   `IMMERSIVE_EDGE_PX = 3`。**触发圈** = 窗缘那一条；**保持圈** = 已唤出的侧栏自身
   （+3 容差）—— 所以指针从边缘往里移进侧栏不会立刻被收起，移出侧栏才收。
4. **同一帧让位，靠主进程先算**。`getSideColumnWidth(params, revealed)` 是唯一宽度判据：
   网页内缩取它、渲染层宽度也取它。唤出时主进程直接返回 `revealWidth`，网页**同帧**
   让位，不等渲染层回环；渲染层随后按同一事实收放 —— 不会出现"侧栏被网页盖住"或
   "网页已让位、侧栏还没出现"的错帧。
5. **两种侧栏共用一套实现**：Edge 型（只有标签列）与全功能型（标签栏 + 导航栏）只差
   "侧栏里住哪几块"。旧版曾有 `railCapable`（只有标签列才能收起）这种前置条件，
   根因是浮层搬不动 chrome 原生部件 —— 改成占位改宽后，这个限制**从根上不存在**。
6. **一份 DOM，一份骨架**。`shared/sidebar-surface.js` 的骨架**四段**（`top` / `body` /
   `dock` / `bottom`）+ 调宽把手只造一次，固定钮（`pin`）作为独立节点随槽交出、
   由 `sideColumnPlan#placePin` 落位。曾经为了浮出层把同一张装配图造了
   第二份实例，带来了"悬停后蹦出一个长得完全不一样的小面板"以及"菜单状态要双投递"
   这类只在复制品上才会有的问题 —— 随整条浮层链路一起删除。
   · **侧栏内容区三态一律不吃窗口拖拽区**（踩过三次：先是"整条侧栏都是拖动区、行与
   切换器全点不动"，再是"浮层里点标签只有几条缝点得动、往旁边一拖还把窗口拖走"，
   最后是"rail / 展开态里连行内边距都点不动"）。根子只有一条：`-webkit-app-region`
   命中的是**非客户区**，指针事件根本不进渲染进程 —— 只要侧栏根上留着 drag，
   行间隙、wrap 的 6px 槽、列表下方空白就全变成"标题栏"（判定区只剩标题与图标），
   而且 drag 命中区由 Chromium 按**整个窗口**合并所有 WebContentsView，
   **上层浮层盖不住下层声明的 drag**。
   现在的口径（唯一一处，`ui-vertical-tabs/styles.js` 的 `.vtabs` 根）：
   **rail / 悬停展开 / 固定占位三种形态都是 `no-drag`**，一条声明覆盖三态，
   不许某个形态再单独开一小块拖拽区。竖排模式拖窗口由侧栏**之外**的行承担
   （顶部导航栏 / 标题栏 / 书签栏；全功能侧栏里 sideHeader 也不吃 drag）。
   于是只剩一条需要让位：**压在 chrome 拖拽带上的浮层**仍然让 `rail` 与 `panel` 放弃
   drag（那两块是真 drag 区，走 `overlay:modal` + `ui-common#setOverlayDragSuppressed`）。
   判据是纯几何的：`LayoutCoordinator` 每趟布局算出 chrome 拖拽带（`_chromeDragBands`：
   顶栏带 / 底栏带 / rail 列 / 面板列），浮层矩形与它相交就广播（`_syncFloatDragGuard`）；
   **没有浮层名单** —— 交互式浮层（侧栏浮出层 / 空间菜单）与穿透式浮层（标签预览卡）
   同一套规则，新增浮层自动覆盖。曾经那条"浮出层开着 → 常驻侧栏放弃 drag"
   的让位机制（`.vtabs--drag-yield`）已随浮层一起删除。
   代价：侧栏里没有"空白处拖窗口"这条手感，换来的是**看到什么就能点什么**。
   · **三态位置对齐**（"有滚动条 / 图标条 / 展开 / 固定"四种情形下，同一件东西待在同一个位置）：
   · **图标条宽 56px**（`shared-types#SIDEBAR_COLLAPSED_WIDTH`，三种形态同读这一处）。
   48px 时图标两侧几乎没有留白，行 hover 块挤在一起看过去就是"一条细缝"。
   · **展开态对齐 rail 的图标列（rail 是基准，不反过来改 rail）**：
   rail 里可用宽 = **56px 内容**（图标条宽；`#chrome-side` 是 content-box，那 1px 分隔线
   画在内容之外）→ `.tabrow-wrap` 左右各 6 → 行宽 **44px**（x = 6..50）→ 22px 图标块
   （`FAVICON_BOX`：18 本体 + 2×2 白边）在行内居中 → 图标 x = **17**、中心 28 = 竖条内容中心。
   展开态行变宽但左内边距取 **11px**（6 + 11 = 17），图标回到同一个 x。
   ⚠ 行的边框是 **0**（`--tabrow-rail-frame: 0px`），所以这里**不加**行边框那 1px。
   ⚠ 图标块边长是**一处常量**（`ui-common/src/tab/iconArea.ts` 的 `FAVICON_BOX`）：
   横向标签条、纵向三态、首字兜底块、无痕标识全部由它派生 —— 改一个数，上面的
   11 / 7 / 4 三个左内边距按「左缘 = 中心 − 块宽/2」同步重算即可。
   组内成员 / 组头在 rail 里是"缩进 8 + 在收窄后的行（36px）内居中" → x = **21**；
   展开态把左内边距收到 **7px**（6 + 8 缩进 + 7 = 21），同样回到 21。
   rail 自身的行布局（`justify-content:center`、行内 `padding:0`、8px 组缩进）
   保持原样，不被展开态反推。两态行高 / 图标尺寸本就相同（`min-height:34px`、图标槽 22px）。
   · ⚠ **rail 里不预留滚动条槽**（`scrollbar-gutter: auto` + `::-webkit-scrollbar{width:0}`）：
   56px 再被 `stable` 永久吃掉 4px，行就从 6..50 缩成 6..46，图标中心落到 26、
   而竖条中心是 28 ⇒ **整列系统性左偏 2px**（用户原话"favicon 在白底色中偏左上"）。
   图标条宽度固定，没有"滚动条一出现行就横跳"的顾虑，所以直接归零（同 Hira rail）。
   展开态仍保留 `stable`（那里确实会横跳），故两态的槽宽不同是**有意的**。
   · 宿主差异（展开态 12px / 组内 8px / 分屏内半 5px）只允许在**骨架**
   `ui-vertical-tabs/styles.js`
   里写一条；**装配图绝不能补写 `.vtabs .tabrow-row`** —— 它后注入、天然压过骨架值，
   曾把指示条槽压回 3.5px，favicon 取色条直接压在图标上。
   · **指示条槽同轴**：favicon 色条与标签组连线条共用 `--tabrow-rail-inset` /
   `--tabrow-rail-width` / `--tabrow-rail-frame`（声明在 `.tabrow-wrap`，绘制层读同一组
   变量），两条竖线永远落在同一条 x 上，且贴着内容左缘（inset 2px；行边框为 0）；
   行左内边距（侧栏 12px / 面板 16px）让 favicon 与色条之间留出一格呼吸
   （更早是 8px + 行内 1px 色条，用户原话"贴太紧"）。
   · 标签组缩进 **8px**（原 14）：成员行只需让出连线条那一格 —— 14px 在窄侧栏里
   看起来"陷进去"（用户原话"缩进不要这么厉害"）。
   · **图标条里也画组连线条**，且成员行**保留同一份 8px 缩进**：成员图标随行右移
   到与展开态同一个 x（22），组线仍留在缩进槽里 —— 线不会贴到/压住图标。
   · 窗控簇在窄条里**三颗并排**（各 1/3）：折成竖排会把这一行从 38px 变成 114px，
   下方整条列表连「新建标签页」一起跳 76px；
   · 列表滚动区在**展开态永远预留滚动条那条槽**（`scrollbar-gutter: stable`），否则
   滚动条一出现内容宽少 4px，行与按钮一起横跳；**图标条形态例外**（见上，槽必须归零）。
   · **唤出不设"驻留延迟"**：静止宽 0，指针不贴边时侧栏根本不存在，划过侧栏这件事
   本身不可能发生 —— 旧的 `HOVER_OPEN_DELAY_MS`（300ms 防误触）随浮层一起删除。
   贴边即开、离手即收，手感才是"边缘抽出来"。
   · **唤出/收起是瞬时的，不做插值**：贴边是即时动作，缓动只会让"打开"落后于指针；
   两档宽度直接写 `--ng-side-width`，主进程与网页在同一帧改。
   · **悬停预览卡的 z 高于侧栏两件**（`float:tabpreview-overlay` = 38 > rail 20 > panel 1）
   —— 卡片是浮在空中的信息层，被侧栏切掉半张都算画错。它**不吃指针**
   （恒 `interactive:false` → `setIgnoreMouseEvents(true,{forward:true})`），
   所以抬高 z 不会把指针从侧栏手里抢走；键盘焦点仍不抢（`focusPriority` 0）。

**两种侧栏为什么能共用一套实现**：自动隐藏只依赖两件事 —— ①这块区域能不能改宽
（能，它本来就在文档流里）；②指针在不在窗缘（主进程读得到）。两者都与"侧栏里住了哪几块"
无关，所以全功能侧栏（含地址栏这类 chrome 原生部件）不需要任何特殊分支。
旧版 `railCapable` 的前提是"只有标签列才搬得进浮层"，浮层没了，前提也就不存在。

被收掉的两条同语义口径（避免自相矛盾）：

- `app.sidebar_pinned`（"折叠时仍占位"）—— 与 `visibility = floating` 表达同一件事，已删。
- `--ng-side-hover-width` —— 见上，已删。

> 进度：第 1–4 步**已完成**（规格留档 / 侧栏分区计划 / 三行形态 / 视图三件拆分）。
> 第 4.5 步（面板簇下移 + 排版渲染再拆一层）**已完成**：`row/sideDock.js` 落地，
> `slots.dock` 加入，窗控纵排归侧栏顶行（空间切换器左边），编辑态判据上移到 `body.hira-buttons-editing`。
> **另**：跨模式共用件陆续落地 ——
> ① `ui-common#stripScroller` 收掉「标签条怎么滚」的两份实现（§5.3），横竖两条此后共用一份，
> 模式只作参数；
> ② 悬浮预览的**落位**收成跨进程真源 `shared-types#preview-placement`（三种摆放一套算术 +
> 三条不变式），渲染层与主进程各喂自己的事实；
> ③ 标签行的 8 个最小件已上移到 `ui-common/src/tab/`，其中音频三态 / favicon 两条**渲染规则**
> 已真正两端共用（纵向列表已改调）；
> ④ `ui-common#hoverPreview` 收掉 hover 预览状态机（700/320/120 与六条规则只此一份，
> 第 ⑤ 条「按下别处即收」、第 ⑥ 条「锚点消失即收并锁到指针动过」由调用方注入 `document`），横向 `TabPreview` 与纵向
> `tabRowList` / `pinGrid` 各自只交出「锚点是谁」与「显示什么」；
> ⑤ `ui-common#axisAdapter` 收掉落点几何（中点判定 / 首尾外推 / 指示线贴边），
> 横向 `dropController` 与纵向 `tabRowList` 只交出「我是哪根轴」；
> ⑥ 单击/双击的**计时判据**收进 `tab/gestures.ts`（`noteTabPrimaryClick` / `isFastDoubleClick`），
> 横向整条挂手势、纵向委托在容器上，但"够不够快"的 250ms 判定只有一份；
> ⑦ 图标区拆成 `createTabFavicon` / `createTabAudioButton` / `createTabIconArea` 三件，
> 纵向列表的行已采用前两件（音频按钮位置仍归它自己 —— 在行右端）；
> ⑧ **"一张标签脸"收官**：标题区（`createTabTitleArea`，容器类名可注入、内层 `.title` 是
> 编辑器锚点故不可注入）与关闭按钮（`createTabCloseButton`，统一成 X 图标 + 中文 aria）
> 也被纵向行采用 —— 至此 `tabRowList` 的行内 DOM **全部**来自共用最小件，
> 它自己只剩「摆在哪」。随之删掉纵向的 `[data-action]` 委托分支与一条失效的 hover 规则；
> ⑨ 行内重命名收成一份：`tab/renameSlot.js` 的槽位加 `extraClasses` / `inputStyle` / `placeholder`
> 三个注入点，纵向列表的 `startStackRename` 从 30 行变成 5 行（并在列表重建前 `commit()`
> 收尾正在编辑的那一条）；输入框的行为标记类改成中性的 `tab-rename-input`（原来叫
> `tab-stack-chip-rename`，是横向私有命名）；
> ⑩ 预览载荷形状收成 `ui-common#tabPreviewFacts`（锚点矩形 + 标签数据 + 可选外侧边界）——
> 两端各拼一遍时，漏一个字段（如 `title || url` 兜底）就会让同一预览在两种模式下表现不同。
> ⑪ **侧栏装配图落地**：`shared/sidebar-surface.js` 一处回答"一条侧栏长什么样"
> （骨架四段 `top` / `body` / `dock` / `bottom` + 固定钮 `pin` + 调宽把手 + 槽里放哪几件 +
> 该注入哪几份样式）。常驻占位与悬停唤出挂的是**同一次装配、同一个实例**
> —— 同一块 `#chrome-side` 只改宽，第 5 条约束从"约定"变成"结构上不可能走偏"；
> ⑫ **窗口控制按钮簇上移 `ui-common`**（`createWindowControlCluster` + `WINDOW_CONTROLS_CSS`，
> 中文 aria/提示），`ui-navbar/src/components/windowControls.ts` 改为纯转出 ——
> 侧栏骨架与外壳要画同一簇，但不该为此把整个 ui-navbar 拖进 `ui-vertical-tabs` 包；
> ⑬ **空间菜单的 commit 回传路由**：动作表收成 `shared/space-commit.js#routeSpaceCommit`，
> 只此一份；主进程的 `COMMIT_OWNER` 表把 `overlay:commit` 送回**打开它的那个视图**，
> 修的是"回送错了宿主 ⇒ 宿主以为已关、发起方 `menuOpen` 常真 ⇒ 菜单再也关不掉"；
> ⑭ **`overlay:closed` 回到发起方**（`window-chrome.js`：外壳 + 发起方各一次），否则任意
> 一侧的 `menuOpen` 常真 → `requestClose()` 被永久挡住 → 菜单再也收不起来；
> ⑮ `shared-types#windowControlsPlacementInSidebar` 改成**两事实签名**
> （`windowControlsHost` + `edgeSidebar`），让"没有完整 plan 的调用方"也能问同一个问题
> （原先吃 plan 且全仓零调用方）。
> ⑯ **书签右键菜单收成一份**：`ui-common#createBookmarkContextMenu` 收掉「书签项菜单长什么样」
> ——菜单结构 / 可见性判据（文件夹没有 url 就不出现"打开"那三项，不留点了没反应的项）/
> 插件插槽快照（`kind:'bookmark'` + `source`）只此一处；**书签栏**与 **rail 固定项**只各交
> 一份 `handlers` 与那条只有自己才对的文案（「从书签栏取消固定」/「从 rail 取消固定」）。
> 配套：`ui-taskoverlay` 新增 `onItemContextMenu` 上抛（返回真值才 `preventDefault`，
> 没配菜单的项右键保持原样）；rail 的固定项描述符因此多带一条 `bookmark`（整条记录）。
> 与 `#createTabContextMenu` 是同一个套路（见 §5.3 的"唯一实现"口径）。
> ⑰ **rail 固定书签的拖拽重排复用纵向落点几何**：`ui-taskoverlay` 的 `.hira-rail-drop`
> 指示条与"中点判定 / 首尾外推 / 指示线贴边"三条规则全走 `ui-common#axisAdapter('column')`
> ——与侧栏纵向标签列**同一份**（连"2px 压在行边界上"的 -1 也同款）；拖拽期用
> `ui-common#dragRegion` 中和窗口 drag 区（rail 整列是 app-region: drag，不中和就收不到
> dragover）。落库是**独立的一条链**：`bookmarks.rail_pinned_order` + `reorderRailPinned`
>（与书签栏 `pinned_order` / `reorderPinned` 互不影响 —— 在 rail 上拖不该动到书签栏）。
> 构建与分层门禁均绿。§5.3 的台账：**已收 18 项，无已知同类重复**。
>
> 注：本轮排查过一处**假故障**（留个记性）：产物里 `windowControlsPlacementInSidebar(hostValue, true)`
> 的第二个实参在 bundle 里消失、被调函数里的 `if (edgeSidebar)` 也被折成 `true` —— 那是 Rollup 的
> **常量传播**（唯一调用点传字面量 `true`）：把参数折成常量后该参数变为未使用，调用点的死实参
> 随之被删。语义等价，**不是构建快照过期**（用 `treeshake:false` 复核过）。

| 步  | 改哪里                                                             | 目标                                                                                   |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1   | `docs/vertical-tabs-architecture.md`（本文）                       | 规格留档                                                                               |
| 2   | `ui-navbar`：`row/sideColumnPlan.js` + `components/sideHeader.js`  | 分区唯一判定处                                                                         |
| 3   | `ui-navbar`：`chromeBlocks.js` + `styles.js`                       | ① ② ③ 三行的确定形态                                                                   |
| 4   | `ui-vertical-tabs`：拆 `styles.js` / `host.js` / `index.js`        | 视图解耦                                                                               |
| 4.5 | `ui-vertical-tabs` 加 `dock` 槽 + `ui-navbar` 加 `row/sideDock.js` | ⑤ 面板行跨块借位；③ 只剩导航簇；`flex-wrap` 护栏                                       |
| 5   | `ui-common`：标签行最小件上移（§3.3）                              | 一份标签行内部实现（**已完成**：最小件归位 + 横竖两端的行 DOM 全部采用，各自只交类名） |
| 6   | `ui-tabbar` / `ui-vertical-tabs` 各提供一个 `AxisAdapter`          | 轴向适配器（**已完成**：`ui-common#axisAdapter`，两端各交一个轴参数）                  |

> 第 5、6 步动的是**渲染内核**，风险高于 2–4.5：必须先有 2–4.5 稳住呈现层，
> 再逐件上移，每一步都能单独构建验证。禁止一次性重写。

---

### 6.2 沉浸模式与全屏：chrome 整体收起 + 贴边唤出

**一条判据**：`LayoutCoordinator#_chromeHidden()` = 全屏（`_tabIsFullscreen` / `win.isFullScreen()`）
**或**设置 `app.immersive_mode`。沉浸模式（学 HiraRT）与全屏在呈现上是同一件事 ——
界面整体收起、网页铺满窗口、鼠标贴到窗口边缘才把对应那一块唤出来。写成两个布尔必然漂移
（症状就是"全屏时界面唤不出来"），所以 `applyInitialLayout` 里所有"要不要让位"的决定
（`sidebarVisible` / `sideColumnWidth` / 面板宽 / `bottombarHeight` / `floatingRail` / `railShown`
/ `panelTop` / `pageBounds` / `setBorderRadius` / `getViewContentOffset` / 各浮层锚定的
`topbarHeight`）**一律改吃它**，不再各自去看全屏。

**唤出必须由主进程判**：chrome 是窗口本体，天然在所有子视图**之下**；界面收起时网页
（原生 `WebContentsView`）铺满整窗 → 渲染层这时**收不到任何指针事件**，"悬停唤出"在那里
无从判定。故由 `LayoutCoordinator` 在收起态开一条 80ms 的指针巡看（`_syncImmersiveWatch`
/ `_tickImmersive`，读 `screen.getCursorScreenPoint()` 减窗口内容区原点）：

**唤出是"整套一起"（一个状态，不按方向记两份）**：指针贴到窗口**任一条边缘**
（上 / 下 / 侧栏那一侧）→ 整套界面一起回来：顶栏 + 底部栏 + 侧栏区 + rail + 面板
（`_immersiveRevealed` 一个布尔，`applyInitialLayout` 里 `revealed` 一处分发）。
指针离开"这套界面自己占的那一圈"（顶栏条 / 底部条 / 侧栏那一叠，见 `_immersiveSideStackWidth`）
再一起收起。用户原话：「应全都一起展开而不是只展开一个方向」—— 按边各记一份必然出现
"贴上缘只出顶栏、贴侧缘只出侧栏"，而沉浸模式的语义是 **UI 收起 ↔ UI 全出** 的二态切换。

判据两半（`_tickImmersive`）：**触发** = 贴到任一条边缘（≤3px）；**保持** = 指针仍在这套界面
所占的区域里（含 3px 容差）。指针移出本窗口时不动作（可能只是去了别的窗口 / 另一块屏幕）。

**"界面收起"不等于"网页铺满"—— 沉浸如此，全屏不是**：两种状态共用同一条 chrome 显隐
流程（`chromeHidden`），但**表面形态**分开派生：

- **沉浸模式**：网页仍保留内边距（chrome 收起时 `topbarHeight` 本身就是那点内边距）与**圆角**。
  用户原话：「沉浸模式下要保留这个网页和 navbar 之间的间距以及圆角边」。
- **真实全屏（F11 / HTML5 全屏）**：网页**铺满整窗** —— 四边内缩、页面圆角、分屏格间距
  全部归零。用户原话：「全屏的时候，网页不应该保留边距与圆角边框」。
  （早先「全屏时的各种展开规则、模式都要完全和沉浸模式一样」说的是 **chrome 的收起/唤出流程**，
  不含表面形态。）

判据集中在 `_isEdgeToEdge()`（`_tabIsFullscreen || win.isFullScreen()`）与派生的
`_pageRadius()`；`pageBounds` 仍然只有**一条**写法，内缩项按 `edgeToEdge ? 0 : inset` 取值 ——
不写"纯全屏铺满"的第二条分支。

**与之配套的三处**：

- **自动隐藏侧栏的唤出巡看在 chrome 收起态不单独起表**（`_syncSideRevealWatch` 的
  `need` 排除 `_chromeHidden()`）：收起态的贴边唤出交给下面那条沉浸巡看**整套**唤回
  （侧栏本就在"整套"里），两套巡看不会抢同一条窗缘。
- **渲染层那条 `setRailReveal` 在收起态一律忽略**（`setRailReveal` 内判 `_chromeHidden()`
  → 转 `_applyRailReveal`，主进程巡看走内部路径）：否则渲染层那声"指针走了"
  （它这时根本收不到事件，只有陈旧的残留判定）会在下一帧把刚唤出的 rail 收回去。
- **收尾时收敛**：`_syncImmersiveWatch()` 在 `applyInitialLayout` **末尾**调用 ——
  中途调用会在退出收起态时清 rail 唤出态，而那要再排一次布局，与正在跑的那一趟抢同一个
  收敛点（外层算出的 `revealedRail` 会覆盖内层结果）。退出收起态的那次重排因此推到下一拍。

**F11 退出全屏后界面不恢复（已修）**：症状是网页仍铺满 —— 说明 `leave-full-screen` 那一次
没能把状态改回来（事件丢失，或它到达时 `win.isFullScreen()` 还没翻转）。退出全屏**必然**
伴随一次窗口尺寸变化，故在 `leave-full-screen` 里临时挂一个 `resize` 兜底调
`setTabFullscreenFromWindow()`（幂等：状态没变立即返回，不重排、不广播；2s 后自摘）。

---

## 7. 扩展点（这样拆完，加东西加在哪）

| 想加什么                               | 加在哪                                                 | 不用碰              |
| -------------------------------------- | ------------------------------------------------------ | ------------------- |
| 侧栏里再多一行（例：标签搜索行）       | `sideColumnPlan` 的一行规则 + 一个部件文件             | 标签列表、容器、IPC |
| 侧栏底部再多一条工具行（例：会话管理） | 仿 `sideDock` 写一个「借位计划」+ `slots` 再加一个空槽 | 面板簇、导航簇、IPC |
| 侧栏内分区换序                         | 计划里的行序表                                         | 任何部件内部        |
| 一种新轴向（例：底部悬浮标签条）       | 一个 `AxisAdapter` + 一个呈现包                        | 语义层、其它呈现    |
| 标签行里多一个状态角标                 | `components/tab/` 一个最小件                           | 渲染引擎、适配器    |
| 标签组多一种操作                       | `components/stack/chipMenu.js` 的项表 + 一个意图出口   | 菜单宿主、DOM       |
