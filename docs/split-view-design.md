# 分屏浏览（Split View）的架构 spec —— 四家对标 · NG 适配 · 解耦与统一管理标准

> 本文回答三件事：
>
> 1. **Zen / Arc / Vivaldi / Edge 各自怎么做分屏**（行为事实 + 数据模型）；
> 2. **NG 该怎么适配**（NG 的网页是原生 `WebContentsView`，不是 DOM —— 这决定了整条路）；
> 3. **解耦 / 模块化 / 统一管理的标准**（哪一份是真源、哪四层边界、加东西加在哪）。
>
> 落地拆解（每一步改哪个文件、能不能单独构建）见 §6。创新增量见 §7。
> 关联文档：`docs/vertical-tabs-design.md`（外壳排布）、`docs/vertical-tabs-architecture.md`（轴向无关范式）。
> **本文只做规格与拆解，不含任何代码改动。**

---

## 0. 一句话结论

**四家在"分屏"上表面差异很大（两格/四格、横向/纵向/网格、标签对/超标签/格子），但底层只差三件事：**
① **分组的数据模型**（挂在标签上还是独立组）；
② **"活动格"的判定**（谁持有焦点与地址栏）；
③ **几何求解放在哪一层**（内核 Views / 原生窗口 / DOM）。

**NG 的正确答案是 Vivaldi/Chromium 那一支的"格子模型"，但把"几何求解"抽成一个跨进程纯函数真源** ——
因为 NG 的网页是**原生 WebContentsView**（见 `infra/infra-window/src/ChromeView.js` 的说明：chrome 是窗口本体、天然在所有子视图之下，DOM 的 `z-index` 对原生视图无效）。
所以「分屏」在 NG 里**不是 CSS grid，而是主进程的矩形切分**。

---

## 1. 逐家拆解

### 1.1 Firefox 149 / Zen（同一条脉络）

Zen 是 Firefox 分支，它的分屏**就是 Firefox 的 Split View**（Zen 1.19.9b 起把 `Alt/Option + 点击标签` 接上了同一实现）。

| 维度     | 事实                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| 格数     | **只有 2 格**（官方明确"currently supports only two tabs at a time"）                               |
| 方向     | 左右（横向分屏）                                                                                    |
| 入口     | 右键标签 → `Add Split View`；选中两个标签 → `Open in Split View`；`Alt/Option + 点击另一个标签`     |
| 归属模型 | **标签对**：分屏本身在标签条上占一格，两个成员是它的两侧                                            |
| 调节     | 拖动中间分隔线                                                                                      |
| 管理     | 地址栏图标 / 分屏页脚 `⋮` / 标签右键：`Separate Tabs`、`Reverse Tabs`、`Close Both Tabs`            |
| 解散     | **关掉任意一侧即解散**                                                                              |
| 与标签组 | 活动标签在组内 → 分屏建在该组内；另一侧在组内 → 把它**移出组**；两侧分属不同组 → 建在活动标签所在组 |
| 焦点     | `Ctrl/Cmd+F` 只作用于**活动格**                                                                     |
| 持久化   | 随窗口恢复；**不能用 Ctrl+Shift+T 恢复**（一个已知限制）                                            |
| 限制     | 固定标签不能进分屏                                                                                  |

**关键设计信号**：Firefox 把"分屏"当作**标签的一个属性/组合态**，而不是窗口的一等容器。缺点是格数被写死成 2、与标签组的关系要额外定义（三条规则），这正是"标签对模型"的固有成本。

### 1.2 Arc

| 维度     | 事实                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 方向     | **横向 + 纵向**都有（`Add Left/Right Split`、`Add Top/Bottom Split`）                                                                          |
| 格数     | 官方宣传可 2 格（扩展资料提到最多三列，按公开行为实际以 2 为主）                                                                               |
| 归属模型 | **超标签**：创建分屏后，它**成为侧边栏里的一个新标签项**，可随时回来                                                                           |
| 入口     | `Cmd/Ctrl+Shift+Plus`；把标签从侧栏**拖到屏幕中央**；`Cmd/Ctrl+T` 输入 `Add Right/Left/Top/Bottom Split`；`Option + 点击链接` 直接在分屏里打开 |
| 调节     | 拖拽分隔；`Cmd+Shift+←/→` 调整比例                                                                                                             |
| 换内容   | 选中某一格后 `Cmd/Ctrl+L` 改该格地址                                                                                                           |
| 解散     | 右键分屏标签 → `Separate All Tabs`；点某一格的 `X`；点侧栏里分屏标签的 `X`                                                                     |

**关键设计信号**：Arc 把「分屏」提升成**一等浏览单元**（它自己是一个"标签"），于是"分屏可以被收藏、被切回来、被命名"。代价是它必须修改"标签是什么"的定义 —— 这在 NG 里是**不能碰**的（`tabRecord` 是标签的唯一构造入口，见 §4.2 的红线）。

### 1.3 Vivaldi（Tab Tiling）

| 维度 | 事实                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 格数 | **最多 4 格**（网格）                                                                                                                                       |
| 布局 | 垂直 / 水平 / **网格**三种（`COMMAND_TAB_STACK_TILE_VERTICAL / HORIZONTAL / GRID`）                                                                         |
| 入口 | 选中多个标签 → 右键 `Tile N Tabs`；右键标签栈 → `Tile Tab Stack`；状态栏 `Page Tiling`；快捷键 `Ctrl+F7`(网格) / `F8`(水平) / `F9`(垂直)；命令链 / 鼠标手势 |
| 调节 | 拖拽分隔；在已平铺的标签拖到另一格边缘 → **再分**（嵌套平铺）                                                                                               |
| 解散 | 状态栏 Page Tiling / 命令                                                                                                                                   |

**数据模型（逆向资料，全四家里唯一有公开结构的）**：布局信息挂在**标签自己**身上：

```js
tab.vivExtData.tiling = {
  id: string, // 分屏组唯一标识（同组共享）
  index: number, // 在组内的位置
  layout: string, // row | column（+ grid 系列）
  type: string, // 'selection' 等
};
```

相关偏好：`M.kTabsTilingDragAndDrop`（开关拖放平铺）、`M.kTabsTilingShowTitlebar`、`M.kTabsTilingCollapseBorder`。

**关键设计信号**：Vivaldi 是**"组 + 成员序号 + 布局枚举"**的最小模型 —— 组有 id、成员带 index、布局是一个字段。
**这正是 NG 应该抄的模型**（改造成 `ratios` 数组以支持不等分），并且它与 NG 已有的 **标签栈模型几乎同构**（`tab.stackId` + `stacks` 元数据）。

### 1.4 Edge（Split screen）

| 维度     | 事实                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 格数     | **每个标签 2 个网站**                                                                       |
| 归属模型 | **一个标签 = 两个 page**（"in a single browser tab"）                                       |
| 入口     | 工具栏 `Split screen` 图标 / `Alt+F` 菜单                                                   |
| 退出     | `X` = 关闭分屏并关掉那个 page；`⋮ → Separate two tabs` = 退出分屏但**保留两个标签**         |
| 活动格   | **蓝色描边**高亮；标签描述会反映活动格的名字                                                |
| 方向     | 支持切换为**纵向**（`Switch to vertical`）                                                  |
| 换位     | `Swap left and right tabs`                                                                  |
| 链接路由 | `Open link in the current tab` / `Open link from left to right`（把左格的链接丢到右格打开） |
| 拖放     | 可以把链接从左格**拖到**右格                                                                |

**关键设计信号**：Edge 定义了分屏里最容易被忽略、但用户感知最强的一组"附属语义"：
**活动格高亮 + 标签标题跟随活动格 + 链接该去哪一格**。这三条不是装饰，是"两个页面在同一个标签里"必须回答的问题。

### 1.5 补充：内核层也在做这件事

Chromium 138 起上游引入了实验特性 `chrome://flags/#side-by-side`（分屏标签）。这意味着**未来 Chromium 系浏览器的分屏会逐步下沉到内核**。NG 用的是 Electron（Chromium 43 系内核），**当前不能用这个 flag** —— 所以 NG 必须自己在主进程做几何切分（也正因为要做自己的，才更要把"几何求解"抽干净，将来内核能用了可以整体替换）。_（该 flag 的情报来自浏览器论坛讨论，属"上游实验特性"级别，非稳定 API。）_

### 1.6 横向对比表

|          | Firefox / Zen           | Arc                   | Vivaldi                     | Edge                      | **NG（目标）**                      |
| -------- | ----------------------- | --------------------- | --------------------------- | ------------------------- | ----------------------------------- |
| 格数     | 2                       | 2（宣称可更多）       | **4**                       | 2                         | **可配，默认 ≤4**                   |
| 方向     | 横向                    | 横 + 纵               | 横 / 纵 / **网格**          | 横 + 纵                   | **横 / 纵 / 网格**                  |
| 数据模型 | 标签对                  | 超标签                | **组 id + index + layout**  | 标签内双 page             | **组 id + ratios 数组**             |
| 几何层   | Gecko（原生）           | 原生（非 DOM chrome） | Chromium Views + 自家 UI 层 | Chromium Views            | **主进程矩形切分**                  |
| 活动格   | 有（Find 只作用活动格） | 有（Cmd+L 改该格）    | 有                          | **有（蓝框 + 标题跟随）** | **有（`_activeTabId`）**            |
| 解散语义 | 关一个即解散            | Separate All Tabs     | 退出平铺                    | 关 / 分离两标签           | **自动解散 + 显式解散**（对齐两者） |
| 持久化   | 随窗口                  | 是（超标签）          | 是                          | 是                        | **session 持久化**                  |
| 链接路由 | —                       | Option+点链接进分屏   | —                           | **有（左→右）**           | **有（规则化，见 §7）**             |

> **出处与推断的边界**：1.1–1.4 的**行为**均有官方帮助中心 / 发布说明出处（见 §9）。
> Vivaldi 的数据结构来自社区逆向文档；**Arc / Zen / Edge 的"几何层在哪"是按所属内核与公开表现推断的**（文中已标注）。NG 侧全部为实测代码事实。

---

## 2. 归纳：三种范式 + 六条不变式

### 2.1 三种范式

| 范式                | 代表                   | 模型                                                       | 优点                          | 代价                                   |
| ------------------- | ---------------------- | ---------------------------------------------------------- | ----------------------------- | -------------------------------------- |
| **A. 格子模型**     | Vivaldi、Chromium 上游 | 窗口里的一组"格"容器，标签是格的成员；组有 id/layout/index | 格数/方向不受限，嵌套平铺天然 | 需要"组"这一新概念                     |
| **B. 标签组合模型** | Firefox/Zen、Edge      | 分屏是"两个标签的组合态"，组合体占标签条一格               | 不引入新概念，用户心智最简    | 格数被写死；与标签组的交互要额外定规则 |
| **C. 超标签模型**   | Arc                    | 分屏本身是一个新标签                                       | 可收藏/可命名/可切回          | **必须改写"标签是什么"**，侵入性最大   |

**NG 选 A**。理由：① 与 NG 已有的**标签栈**（`tab.stackId` + `stacks`）同构，是"再加一个正交分组"而不是"重定义标签"；
② NG 的标签视图本来就是主进程用矩形摆放的，格子模型只是把"1 个矩形"变成"N 个矩形"，**改动面最小**；
③ 格数不写死，创新空间（§7）才存在。

### 2.2 六条不变式（无论哪家都得回答，NG 逐条给答案）

| #   | 不变式                               | 四家的做法              | NG 的答案                                                              |
| --- | ------------------------------------ | ----------------------- | ---------------------------------------------------------------------- |
| N1  | 内容区被**几何切分**                 | 内核/原生布局           | `SplitLayout` 纯函数：`pageBounds + layout + ratios → rect[]`          |
| N2  | 有一个**活动格**，焦点与地址栏归属它 | 蓝框/红框高亮           | `_activeTabId` 即活动格；`LayerStack` 的 `TabHostLayer` 焦点代理改指它 |
| N3  | **分隔条可拖、有最小宽**             | 拖拽分隔线              | 分隔条是**独立浮层视图**（原生视图之间没有 DOM），拖拽逐帧 `setBounds` |
| N4  | **生命周期耦合**（关一个怎么办）     | 关一个即解散 / Separate | 成员 <2 → 自动解散；另提供"显式解散"（对齐 Edge 的"分离"）             |
| N5  | **持久化**（随会话恢复）             | 是                      | session schema **v3** 增 `splits`，恢复侧裁剪退化组                    |
| N6  | **入口**（怎么建、怎么换、怎么退）   | 右键/快捷键/拖拽/工具栏 | 一张**意图表**统一收口（§5.3），入口只声明意图                         |

---

## 3. NG 现状与差距（全部为实测代码事实）

### 3.1 现状：单视图模型

| 位置                                                                          | 现状                                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `infra/infra-window/src/LayoutCoordinator.js#applyInitialLayout`              | 先算出一条 `pageBounds`（已扣掉顶/底栏、侧栏区、rail、左右面板），再落到活动标签                                       |
| `#showTab(tabId)`                                                             | `_attachTabView(view)` 只挂一次，之后**只切 `setVisible`**；`_visibleTabView` **恒为 1 个**                            |
| `#_applyTabBounds(rect)`                                                      | 只作用于 `this._activeTabId` 那**一个** view                                                                           |
| `#_lastPageBounds` / `#getContentBounds()`                                    | 缓存的是**一个**矩形                                                                                                   |
| `#_ensureTabLayer()`                                                          | 一个铺满窗口的容器 `View`，所有标签 view 是它的子节点（**已具备多子视图能力**）                                        |
| `LayerStack` 的 `TabHostLayer`                                                | 焦点代理 `() => this._visibleTabView`（**单数**）                                                                      |
| `infra/infra-window/src/tabRecord.js`                                         | 记录字段：`position / pinned / stackId / preSleep / navHistory …`（**无分屏字段**，有 `stackId` 可参照）               |
| `domain/domain-session/src/schema.ts`                                         | `SESSION_VERSION = 2`，tabs 带 `stackId`，另有 `stacks[]`                                                              |
| `domain/domain-tabs/src/TabStacks.js` + `infra/infra-window/src/tabLayout.js` | 已有一套成熟的**"纯规则 + 宿主注入"**分组模块（栈 CRUD / 拖拽重排 / 空栈回收）                                         |
| `infra/infra-window/src/BoundsTween.js`                                       | 已有 bounds 补间动画（分隔条跟手可复用）                                                                               |
| `apps/app-main/src/main/ipc/layout.js`                                        | 已有 `FLOAT_NAMES` 浮层家族 + `floatBounds/floatInteractive` 通道 + `anchorFloatInContent`（"贴网页矩形内部"的落位器） |

**结论：地基比想象中好** —— 容器已支持多子视图、分组模块有现成范式、浮层家族和动画件都齐。缺的是"格"这个概念本身。

### 3.2 差距清单

| #   | 差距                                                                      | 影响                                                         |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D1  | 没有"格/分屏组"数据模型                                                   | 无法表达"这两个标签同时可见"                                 |
| D2  | `_visibleTabView` 是单值                                                  | 第二格永远 `setVisible(false)`                               |
| D3  | `_tabBounds` / `_lastPageBounds` 是单矩形                                 | 无法给两个 view 各自落位                                     |
| D4  | 焦点层 `TabHostLayer` 代理到单体                                          | 第二格无法成为键盘焦点目标                                   |
| D5  | `pageBounds` 之后直接落 view，没有"切分"这一步                            | 缺 N1 的求解器                                               |
| D6  | 分隔条没有宿主                                                            | 原生视图之间**没有 DOM 层**可用（DOM 会被网页盖住）          |
| D7  | `anchorFloatInContent` 一族（查找栏 / 缩放条 / 悬停 URL）按"整页矩形"锚定 | 分屏后必须改为按**活动格矩形**锚定，否则查找栏会横跨两格居中 |
| D8  | session 无分屏                                                            | 重启后分屏丢失                                               |
| D9  | 无任何入口（右键/快捷键/拖拽/工具栏）                                     | 用户碰不到                                                   |
| D10 | 标签条上无法把"分屏"显示成一格                                            | 用户看不出哪几个标签是一组                                   |

---

## 4. 目标架构与 NG 适配

### 4.1 三层切分（这是整篇文档的核心）

```
┌── ① 数据层（纯规则，零 electron，可单测）─────────────────────────┐
│  domain/domain-tabs/src/TabSplits.js                              │
│    createSplit / addMember / removeMember / setLayout /           │
│    setRatio / setActive / reorder / dissolve / pruneDegenerate    │
│  宿主注入（同 TabStacks）：_tabs / _splits / 变更通知 / domain 端口 │
└───────────────────────────────────────────────────────────────────┘
                              ▲
┌── ② 几何层（跨进程纯函数真源）──────────────────────────────────┐
│  packages/shared-types/src/split-layout.mjs                      │
│    solveSplitPanes({ rect, layout, ratios, gap, minSize })        │
│      → { panes:[{x,y,w,h}], divider:[{x,y,w,h}], clamped }        │
│  主进程用它落 bounds；渲染层用同一份画分隔条与热区                │
└───────────────────────────────────────────────────────────────────┘
                              ▲
┌── ③ 宿主层（唯一持有 Electron 副作用）───────────────────────────┐
│  infra/infra-window/src/SplitHost.js（新，或并入 LayoutCoordinator）│
│    · 把 ② 的结果逐格 setBounds 到对应 WebContentsView              │
│    · 建/管分隔条浮层视图（复用 FLOAT 家族范式）                    │
│    · 把焦点交给活动格（对接 LayerStack）                          │
└───────────────────────────────────────────────────────────────────┘
```

**为什么必须这么切**：

- ①纯规则 → 能被 `verify-split.cjs` 在**没有整机**的情况下跑（NG 已有 `verify-*.cjs` 的传统）；
- ②跨进程真源 → 主进程要"落位"、渲染层要"画分隔条/算热区"，两处各写一份算术必然漂移（这正是仓库里 `preview-placement.mjs` 存在的理由，同款问题同款解法）；
- ③Electron 只在最外层 → 将来内核原生支持（§1.5）时，只换 ③，①②原样保留。

### 4.2 数据模型（放哪、为什么不放哪）

**红线（不许碰）**：`tabRecord` 是标签记录的**唯一构造入口**（`apps/app-main` 侧注释已明确：三条路径各写一份子集，曾直接造成 webContents 泄漏与"标签秒睡"）。**不给标签加"它是分屏的一部分"这种身份字段去改变标签语义** —— 只加一个**归属指针**，与 `stackId` 同性质：

```js
// tabRecord 新增（与 stackId 并列，语义正交）
splitId: null; // 属哪个分屏组；null = 不参与分屏
```

**组元数据独立存**（与 `stacks` 对称）：

```js
split = {
  splitId: string,
  layout: 'row' | 'column' | 'grid',   // 方向/形态是数据，不是代码路径
  ratios: number[],                     // 各格占比，和为 1；长度 = 成员数
  activeTabId: string | null            // 活动格（N2 的唯一真源）
}
```

**为什么分屏与标签栈必须分开（不能合并成一个分组概念）**：

|        | 标签栈 `stack`                                 | 分屏 `split`                 |
| ------ | ---------------------------------------------- | ---------------------------- |
| 可见性 | **一次只见一个成员**（收纳/折叠）              | **全部成员同时可见**（并列） |
| 语义   | 组织/去噪                                      | 并行对照                     |
| 正交性 | 一个标签可以**同时在**某个栈里、又参与某个分屏 | 同左                         |

把两者塞进一个字段 = 以后每加一个分组维度都要改这一个字段的语义（正是用户 rule 里点名的"松松垮垮、最后无法维护"）。**两个正交维度 = 两个字段 + 两组元数据。**

### 4.3 几何：与外壳轨道的关系（唯一正确的分层）

```
applyInitialLayout
  ├─ 1. 算 topbar / bottombar / 侧栏区 / rail / 面板  ── 得到 pageBounds   （已有，不动）
  ├─ 2. solveSplitPanes(pageBounds, layout, ratios)  ── 得到 panes[]      （新）
  └─ 3. 逐 panes 落 view bounds + 落分隔条           ── 副作用            （新）
```

**顺序不可颠倒**：分屏是**内容区内部**的事，绝不能去重算外壳。（唯一例外：chrome 收起/沉浸态的分支在步骤 1，`pageBounds` 怎么变，分屏都跟着变 —— 天然正确，因为切分吃的是它的输出。）

**分隔条（N3）—— 落地时纠正的一处判断（比原方案更简单，且去掉了整个浮层家族）**：

- 原方案写的是"新增一个 `split-divider` 独立浮层视图"。**实现时发现这是多余的**：
  两格之间那条缝（`divider` 像素）里**没有任何网页 view** —— 网页只占各自的格矩形，而
  标签容器 `View` 本身不绘制。于是缝里露出的是 chrome（窗口本体）的背景，缝里收到的
  指针事件也归 chrome。**分隔条画在外壳 DOM 里天然可见、天然可交互。**
  （这正是本项目"网页是原生 WebContentsView、chrome 在它之下"这一模型的正面用法：
  凡是**不被网页覆盖**的区域，chrome 都拿得回来。）
- 于是分隔条 = `#chrome-root` 里一个绝对定位层（`#split-layer`）中的若干 `div`：
  **零新增原生视图、零新增 IPC 家族、零额外渲染进程**。几何由主进程推
  （`split:changed` / `layout:split-geometry`），坐标是窗口内容区坐标，减去根元素矩形即可落位。
- 拖拽用 **`setPointerCapture`**：指针移出 6px 细条也不会丢事件（这是细条能拖的前提）。
  拖动期间**本地即时移动**被拖那一条（不等 IPC 往返），并按 rAF 把最新位置交给主进程
  重算比例并重排格；主进程回推的新几何**不覆盖正在拖的那一条**（否则一帧抖动）。
- 分隔条自身**不参与网格布局**（绝对定位 + 父层 `pointer-events:none`，只有它自己 `auto`）——
  根级图层若默认为吃指针，一次写坏就是"整个浏览器点不动"。

### 4.4 活动格与焦点（N2）

| 现状                                                   | 改法                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `_visibleTabView`（单值）                              | → `_paneViews: Map<tabId, view>` + `_activeTabId` 仍为**唯一**活动格 |
| `TabHostLayer(..., () => this._visibleTabView)`        | → 代理到 `getPaneView(this._activeTabId)`                            |
| `#_applyTabBounds(rect)`                               | → 拆成"按格落位"，活动格与非活动格走**同一条**落位路径（不搞特例）   |
| `#getActiveTabViewOffset()` / `getViewContentOffset()` | 保持语义：**相对活动格**（浮层锚定要用）                             |

**规则收口**：所有"作用于当前浏览中标签"的动作（地址栏导航、书签星标、菜单、快捷键、Find、缩放）一律只问 `getActiveTabId()`。**这是唯一判据** —— 不要在 UI 里各判各的"是不是分屏"。

### 4.5 生命周期（N4）

| 事件                       | 行为                                                     | 对齐                                  |
| -------------------------- | -------------------------------------------------------- | ------------------------------------- |
| 关闭一个成员，组内还剩 ≥2  | 只关那个成员，`ratios` 归一化                            | Vivaldi                               |
| 关闭一个成员，只剩 1       | **自动解散**（剩的那个独占内容区）                       | Firefox（"closing either dissolves"） |
| 显式解散                   | 全部成员保留，回到普通标签                               | Edge（`Separate two tabs`）           |
| 成员被休眠/归档            | 非活动格允许休眠；**活动格永不休眠**（否则用户眼前白屏） | NG `tabLifecycle` 既有口径            |
| 成员被拖出（拖到内容区外） | 退出该组并归一化                                         | Vivaldi 拖放语义                      |
| 跨 space / 跨窗口          | **拒绝**并给原因（不出现"点了没反应"）                   | 四家均不做跨窗口                      |

### 4.6 持久化（N5）

`domain-session/src/schema.ts`：`SESSION_VERSION` 2 → **3**，新增 `splits[]`（与 `stacks[]` 对称），并在 `parseSessionFile` 里：

- 逐条 `SessionSplitSchema.safeParse` → 坏一条丢一条（**旧规矩，绝不为一条脏数据丢整个会话**）；
- 新增 `pruneDegenerateSplits`（成员 <2 / 引用不存在的 tab / `ratios` 长度不匹配 → 丢弃组并把成员 `splitId` 置 null），与既有 `pruneDegenerateStacks` 同款；
- 版本 2 的旧文件**天然没有 `splits`** → 走默认空数组，无需迁移代码（"宽进严出"）。

### 4.7 入口（N6）

| 入口                                                   | 意图                                                                  | 对齐谁                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------- |
| 标签右键 → `与右侧/下方标签分屏`                       | `split:create`                                                        | Firefox / Zen / Edge                          |
| `Alt/Option + 点击另一个标签`                          | **`tab:split-with`**：只报被点的那个，**另一个格子由主进程解析**      | **Firefox / Zen 同款**                        |
| 标签右键（已在分屏里）→ 切换方向 / 反转格序 / 解散分屏 | `split:layout` / `split:reverse` / `split:dissolve`                   | Edge / Firefox                                |
| `Ctrl+Shift+D`                                         | 与**相邻**标签分屏 / 已在分屏里则解散                                 | Arc（快捷键位）                               |
| 标签条成员标记（6px 方块）                             | —                                                                     | Edge 的活动格提示的等价物                     |
| **拖标签到网页区域松手**                               | `tab:drag-drop-content`（单向）→ 主进程按视图 bounds + 内容区矩形判定 | **Arc / Edge 的拖动式分屏；五个标签宿主全通** |
| 命令面板 / 工具栏按钮                                  | `split:create`                                                        | Vivaldi 命令链 / Edge                         |

> **"另一个格子由主进程解析"这条为什么重要**：标签有 5 个宿主（横向标签条、纵向标签列、
> 打开标签面板、固定标签面板、侧栏覆盖层）。若让每个宿主各记一份"谁是当前标签"，
> 就是 5 份会漂移的状态。**活动标签只有主进程是权威**，因此入口只报"被点的那个"。

---

## 5. 解耦 / 模块化 / 统一管理标准

> 这一节是用户明确要求的"标准"。它约束的是**以后加东西的方式**，不是这一次要写多少代码。

### 5.1 四条硬约束

| #      | 约束                                                                                    | 违反的后果（都是真实踩过的形态）                                                              |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **S1** | **单一真源**：数据只住 `TabSplits.js`，几何只住 `split-layout.mjs`，入口只住一张意图表  | "UI 里各判各的" → 改一处漏一处（`vertical-tabs-architecture.md` §5.3 的台账就是为这个存在的） |
| **S2** | **布局是数据，不是代码路径**：`row / column / grid` 走**同一个求解器**，不是三个 `if`   | 加第四种形态要改 N 处（对标：外壳布局用 `planChromeLayout` 的"推导"而非"模式枚举"）           |
| **S3** | **与既有机制正交**：不改标签语义、不改图层语义、不改栈语义；不动 `tabRecord` 的身份定义 | 分组维度互相污染 = 用户 rule 里点名的"屎山"                                                   |
| **S4** | **失败可解释**：任何不合法（成员 <2、跨 space、跨窗口、比例非法）→ 拒绝 + 原因原文      | 违反插件中心早就定过的规矩："不出现点了没反应"                                    |

### 5.2 模块清单

| 层     | 文件                                                            | 新增/改动 | 职责                                                                    |
| ------ | --------------------------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| domain | `domain/domain-tabs/src/TabSplits.js`                           | **新**    | 分屏组 CRUD 纯规则（照 `TabStacks.js` 的模子）                          |
| domain | `domain/domain-tabs/src/index.js`                               | 改        | 导出 `tabSplits` 端口                                                   |
| 跨进程 | `packages/shared-types/src/split-layout.mjs`                    | **新**    | 切分算术（主/渲染共用）                                                 |
| 跨进程 | `packages/shared-types/src/split-constants.mjs`（或并入上一条） | **新**    | 最小格宽、分隔条宽、默认 ratios、最大格数（**设置项与主进程读同一份**） |
| infra  | `infra/infra-window/src/tabLayout.js`                           | 改        | 加分屏 CRUD 的宿主侧（与栈并列，同一套"host 注入"范式）                 |
| infra  | `infra/infra-window/src/SplitHost.js`                           | **新**    | 落 bounds + 分隔条浮层 + 焦点对接（唯一 Electron 副作用）               |
| infra  | `infra/infra-window/src/LayoutCoordinator.js`                   | 改        | `applyInitialLayout` 步骤 2/3 接线；浮层锚定改按活动格                  |
| infra  | `infra/infra-window/src/tabRecord.js`                           | 改        | 加 `splitId: null`（**只加指针，不改身份**）                            |
| infra  | `infra/infra-window/src/SplitPane.js`（可选）                   | **新**    | 若"格"要支持非网页内容（§7）才拆出来                                    |
| APPS   | `apps/app-main/src/main/ipc/tabs.js`（或新 `ipc/split.js`）     | 改/新     | `split:*` 通道注册                                                      |
| APPS   | `apps/app-main/src/main/settings/registry.js`                   | 改        | 设置项（最大格数 / 默认布局 / 自动解散开关）                            |
| APPS   | `packages/shared-types/src/ipc-channels.mjs`                    | 改        | 通道名（**唯一命名表**）                                                |
| APPS   | `apps/app-main/src/renderer/shared/split-client.js`             | **新**    | 渲染侧客户端（照既有 `*-client.js`）                                    |
| UI     | `ui/ui-tabbar`（标签条一格 + badge）                            | 改        | 分屏组在标签条上显示为一格（D10）                                       |
| UI     | `ui/ui-common/src/icons.ts`                                     | 改        | 分屏图标（`SplitSquareHorizontal` / `Vertical`）                        |
| 页面   | 标签右键菜单模板                                                | 改        | 加 `分屏打开 / 与当前分屏 / 解散分屏 / 反转左右`                        |

### 5.3 统一管理：一张意图表 + 一份能力段

**意图表（唯一入口收敛点）**：所有入口（右键 / 快捷键 / 拖拽 / 命令面板 / 工具栏）都只产出同一种**意图**，由一个 dispatcher 落到 `split:*`：

```
意图                      → IPC                     → 语义
split:create(paneA,paneB,layout?)  tab:split-create   建组（已存在则并入）
split:dissolve                     tab:split-dissolve 解散（保留全部成员）
split:reverse                      tab:split-reverse  交换格序
split:set-layout(layout)           tab:split-layout   改形态（row/column/grid）
split:set-ratio(index,value)       tab:split-ratio    改比例（拖分隔条）
split:set-active(tabId)            tab:split-active   换活动格
split:add(tabId) / split:remove    tab:split-add/remove
```

**能力段（为插件化留的口子，但本轮不做）**：分屏最终应是一个 capability（`tabs.split.*`），归属 `tabs-service`；渲染侧分隔条可作为一类新插槽。**但按 `插件化落地现状与扩展指南.md` §9 的教训，先不登记** —— 只登记 capability、不给插槽，避免出现"开关一拨净效果为零"的假生效。理由与边界写在这里，等 §9 的地基（真禁用）在分屏上复现后再说。

### 5.4 门禁

- 既有：`pnpm lint` / `pnpm build` / `pnpm layer:check` / `pnpm plugin:coverage`（**不许回退**）。
- 新增：`scripts/verify-split.cjs`（`pnpm verify:split`）—— **headless、无整机**，只测①②两层：
  切分算术（2 格 / 3 格网格 / 非等分 / 最小宽夹取 / 退化 ratios）、组规则（建/加/删/解散/反转/归一化）、退化裁剪（成员 <2 / 悬空引用）、**跨 space 拒绝**。
  对齐 `verify-plugin-*.cjs` 的传统：**它们测的不是"再测一遍各层"，而是"连起来对不对"**。

---

## 6. 落地拆解（每步可独立构建验证，禁止一次性重写）

| 步  | 改哪里                                                               | 目标                                   | 可独立验证                    |
| --- | -------------------------------------------------------------------- | -------------------------------------- | ----------------------------- |
| 1   | 本文 + `docs/split-view-design.md`                                   | 规格留档                               | —                             |
| 2   | `packages/shared-types/src/split-layout.mjs` + `split-constants.mjs` | **几何真源**（纯函数）                 | ✅ `verify:split` 第 1 组     |
| 3   | `domain/domain-tabs/src/TabSplits.js` + `index.js`                   | **组规则真源**（纯函数）               | ✅ `verify:split` 第 2 组     |
| 4   | `infra-window`：`tabRecord.splitId` + `tabLayout` 分屏 CRUD          | 运行态接入（仍无 UI）                  | ✅ 单测 + 手写 IPC 调用       |
| 5   | `SplitHost.js` + `LayoutCoordinator` 步骤 2/3                        | **两格真正并排可见**（无分隔条、等分） | ✅ 手动：两格各出一个网页     |
| 6   | 分隔条浮层（`split-divider`）+ 拖拽                                  | 可调比例（N3）                         | ✅ 手动拖拽                   |
| 7   | 活动格 + 焦点 + `anchorFloatInContent` 改按活动格                    | 查找栏/缩放/悬停 URL 锚定正确（D7）    | ✅ 手动对照                   |
| 8   | session v3 + `pruneDegenerateSplits`                                 | 重启恢复（N5）                         | ✅ `verify:split` 第 3 组     |
| 9   | 入口：右键 / Alt+点击 / 快捷键 / 标签条 badge                        | 用户可达（N6 + D10）                   | ✅ 手动                       |
| 10  | 网格（`grid`）+ 设置项（最大格数 / 默认布局）                        | 形态扩展（S2 的验收）                  | ✅ `verify:split` 第 1 组扩容 |

> 第 5 步是整个功能的"可见里程碑"：**两格并排**。第 6 步之前都可用等分验证，风险最低。
> 第 7 步容易漏 —— 分屏一旦上线，所有"贴网页矩形"的浮层都会错位，这是**回归面最大的地方**。

---

## 7. 创新增量（在四家之上）

> 这些是"格子模型"选对了之后天然长出来的东西。**2026-10 已落地 I2 / I4 / I6 / I3 的剩余部分**
> （见 §10.7）；I1 / I5 / I7 见下表的"为什么不做"。

| #   | 创新                           | 状态                    | 说明                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | **格内不只放网页**             | ⚠️ 大部分**本来就成立** | 格 = 一个标签，而标签本就承载 PDF / 游戏（`hira-game://`）/ 各种内部页 / 扩展页 —— 这一条不需要改代码，是 `_placeSplitPanes` 只认"格矩形 ↔ 标签视图"的直接结果。**剩下的缺口只是"把侧边面板当一格"**：面板有自己的停靠位与骨架，把它搬进格要动面板宿主与安全区，收益（多一个可选内容源）远小于代价，且会让"面板在哪"出现两个答案。**不做。** |
| I2  | **主从比例预设 + 归位**        | ✅ 已落地               | `ratiosForPreset`（均分 / 主格 70% / 主格 30%）+ 标签菜单三项 + **双击分隔条归位到均分**                                                                                                                                                                                                                                                     |
| I3  | **分屏组是可恢复的"空间资产"** | ✅ 已落地               | 随会话持久化（§10.1 步 8）**已有**；本轮补"**最近解散的分屏**一键复原"（`_splitUndoStack` + 菜单项，且菜单项按"**真能复原**"精确出现）                                                                                                                                                                                                       |
| I4  | **栈 ↔ 分屏 可逆投影**         | ✅ 已落地               | 标签组芯片菜单「平铺成分屏」→ 分屏；标签菜单「收拢为标签组」→ 栈（先解散再建栈的**显式转换**）。2026-10-17 起两者改为**正交共存**（§10.10③）：平常可同挂一张标签，转换只在这两条命令被显式触发时发生 |
| I5  | **格间链接路由**               | ✅ **做了确定的那一条** | 已落地 Edge / Zen 的 "Open links in the other pane"：某格点开的 `target=_blank` / `window.open` 改为**在按格序循环的下一格**打开并切过去（设置项，默认关）。**完整"规则引擎"（按域名/正则 + 插件插槽）仍不做** —— 规则从哪来、冲突怎么办、用户怎么看出是哪条生效，这三问没有答案之前，规则化只会变成一层没人看得懂的策略                     |
| I6  | **键盘驱动的格导航**           | ✅ 已落地               | `neighborPaneIndex`（投影重叠优先、再比距离）+ `Ctrl+Alt+方向`（可在设置里重绑）+ 快捷键设置页可见                                                                                                                                                                                                                                           |
| I7  | **分屏即工作区**               | ❌ 不做                 | 它是 I1 + I3 的组合态（分屏 + 空间 + 笔记一起被"一键唤起"）。I1 已判定不做，I7 就没有承载体。**等真有人要"工作区"这个产品概念时再谈。**                                                                                                                                                                                                      |

---

## 8. 边界与"明确不做"

| 不做                                          | 原因                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| 跨窗口分屏                                    | 四家都不做；跨窗口涉及 session/焦点/空间仲裁，收益远小于成本                           |
| 无限格                                        | WebContentsView 有内存成本 + 最小可读宽度；**默认上限 4**（可设置），超限拒绝并说明    |
| 用 CSS/DOM 画分隔条                           | 原生视图之间没有 DOM 层（`ChromeView` 已写明：chrome 在子视图之下，DOM 盖不住网页）    |
| 修改 `tabRecord` 的身份语义（Arc 式"超标签"） | 会侵蚀"标签是什么"，且 `tabRecord` 是唯一构造入口，历史上被绕过就出过 webContents 泄漏 |
| 本轮登记插件插槽                              | §5.3 的取舍：地基（真禁用）未在分屏上复现前不登记，避免假生效                          |

---

## 9. 出处

- Firefox / Zen 行为：Mozilla 帮助 `Split View in Firefox`、Mozilla 博客 `Split View in Firefox`（Firefox 149，2026-03-24 起）；Zen 发布说明（1.19.9b，2026-04-24，`Alt/Option + 点击标签分屏`）。
- Arc 行为：Arc Help Center `Split View: View Multiple Tabs at Once`；Arc for Windows 发布说明（Vertical Split）。
- Vivaldi 行为与数据模型：Vivaldi 帮助 `标签页平铺`（Tab Tiling）；社区逆向文档 `Awesome-Vivaldi / Doc/BundleReverse/tile.md`（`vivExtData.tiling = {id,index,layout,type}` 与 `M.kTabsTiling*` 偏好）。
- Edge 行为：Microsoft Edge 官方 `Split screen` 功能页（双页/纵向/左右互换/链接左→右/活动格蓝框）。
- Chromium 上游：`chrome://flags/#side-by-side`（Chromium 138 起实验特性，来源于浏览器论坛讨论，非稳定 API）。
- NG 侧：全部为仓库实测代码（`infra/infra-window/src/{LayoutCoordinator,ChromeView,LayerStack,tabRecord,BoundsTween}.js`、`domain/domain-tabs/src/TabStacks.js`、`domain/domain-session/src/schema.ts`、`apps/app-main/src/main/ipc/layout.js`、`packages/shared-types/src/layout.mjs`）。

---

## 10. 落地状态（本轮实现，2026-10）

> 逐条对应 §6 的 10 步。**这一步是真的写进代码并跑过门禁的**，不是计划。

### 10.1 已落地

| 步   | 内容                                                                               | 落点                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | 几何真源（切分求解器 + 度量常量 + 拖拽算术 + 命中判定）                            | `packages/shared-types/src/split-layout.mjs`                                                                                                                                                                                                              |
| 3    | 组规则真源（建/加/删/解散/反转/换形态/裁剪/投影）                                  | `domain/domain-tabs/src/TabSplits.js` + `src/index.js` 导出 `tabSplits` 端口                                                                                                                                                                              |
| 4    | 标签归属指针 + 宿主侧 CRUD                                                         | `infra/infra-window/src/tabRecord.js`（`splitId`）+ `src/tabLayout.js`                                                                                                                                                                                    |
| 5    | 分屏状态 ↔ 几何的桥 + 逐格落 bounds + 可见集合按组算                               | `infra/infra-window/src/LayoutCoordinator.js`（`setActiveSplit` / `_placeSplitPanes` / `_setVisibleTabs` / `_pushSplitGeometry` / `applySplitDrag`）+ `src/TabManager.js`（`_syncActiveSplit` + 7 个委托方法）                                            |
| 6    | 分隔条（外壳 DOM 层 + `setPointerCapture` 拖拽 + rAF 上报）                        | `apps/app-main/src/renderer/shared/split-surface.js` + `ui/ui-chrome-layout/src/index.js`（`#chrome-root{position:relative}`）                                                                                                                            |
| 7    | 活动格锚定（查找栏 / 缩放条 / 悬停 URL 跟随活动格）                                | `LayoutCoordinator#_activePaneBounds` → `anchorFloatInContent` / `getContentBounds` / `getActiveTabViewOffset`                                                                                                                                            |
| 8    | 会话 v3（落盘 / 读取 / 恢复 / 退化裁剪 / 二次校验）                                | `domain/domain-session/src/{schema,SessionStore,sessionUtil,SessionRestoreService}.js` + `infra-window/src/sessionTabPort.js`                                                                                                                             |
| 9    | 契约 + 通道 + 处理器 + 渲染侧客户端                                                | `infra/infra-ipc/src/contracts/{tabs,layout}.js`、`packages/shared-types/src/ipc-channels.mjs`、`apps/app-main/src/main/ipc/{tabs,layout}.js`、`renderer/shared/tabs-client.js`                                                                           |
| 9    | 入口：标签右键菜单（4 项，横竖两个宿主共用一份动作表）                             | `ui/ui-common/src/tabContextMenu.ts` + `renderer/shared/tab-split-actions.js` + `controllers/tab-session-controller.js` + `renderer/shared/tab-row-menu.js`                                                                                               |
| 9    | 入口：快捷键 `Ctrl+Shift+D`（分屏 / 解散）                                         | `main/keybindings.js` + `main/main.js` 动作表 + `packages/shared-types/src/keybindings.mjs`（键位目录，页面 `hira://shortcuts` 同源）                                                                                                                                                                 |
| 9    | 入口：**Alt/Option + 点击标签**（与当前活动标签分屏，5 个标签宿主共用）            | `ui-common/src/tab/gestures.ts#isSplitModifier` + `ui-tabbar/{view/tabRecord,view/renderer,index}.js` + `ui-common/src/{tabRowList,tabListHost}.js` + 新通道 `tab:split-with`（另一格由主进程解析）                                                       |
| 9    | 入口：标签条成员标记（6px 方块，只在成员上出现）                                   | `ui/ui-tabbar/src/components/Tab.js` + `src/styles.js`                                                                                                                                                                                                    |
| 10   | **设置项**：分屏默认方向 / 最多格数（真源 `SPLIT_SETTING_KEYS`，只约束新建与加入） | `packages/shared-types/src/split-layout.mjs`（键名+选项）+ `main/settings/registry.js` + `main/main.js#splitOptionsPort` + `infra-window/src/tabLayout.js#splitOptionsOf`                                                                                 |
| 10   | 验证脚本                                                                           | `scripts/verify-split.cjs`（`pnpm verify:split`）                                                                                                                                                                                                         |
| 增补 | **格间链接路由**（I5）：某格点开的新窗口链接改为在下一格打开                       | `tabEvents.js#setWindowOpenHandler` 前置接管（`deny`）+ `TabManager.routeSplitLink` / `nextSplitPaneOf` + 设置项                                                                                                                                          |
| 增补 | **拖标签到网页区域分屏**（Arc / Edge 拖动式入口，横纵五个宿主）                    | 单向通道 `tab:drag-drop-content` + `TabManager#dropTabOnContent`（主进程判定） + `ui-common/src/tab/gestures.ts#{createDragHintWatch,currentActiveTabIdFromDom}` + `tabRecord` / `tabRowList`（各自 dragstart/dragend）+ `ui-tabbar/index.js#setDropHint` |

### 10.2 验证结果（实测）

- `pnpm verify:split` → **103 / 103 通过**（几何不变式 I1/I2/I3、拖拽算术、组规则全谱、
  会话 v3 宽进严出、**宿主侧"用户口径上限 × 硬上限"交汇**、**创新增量 I2/I6 的两条纯判据**、
  **I5 的 linkRouting 归一化**）。
- `npx eslint .` → **0 问题**（顺带修掉两处 `prefer-const`，其中一处是既有）。
- `pnpm check:methods` → **546 个文件，0 处**未定义的方法调用（新增门禁，见 §10.9）。
- **启动冒烟**（`npx electron .`，独立 userData）：`main window created` → `loadUiShell` →
  `rail finished` → `enableAppPlugins` → `Widevine ready`，**全程无 FATAL / 无 error 行**。
- `node scripts/check-layers.cjs` → **0 违规**（domain → packages 的依赖方向合法）。
- `npx electron-vite build` → **通过**（新增文件全部进产物）。
- `verify:settings-page` → **11 / 11**（新增两个 `select` 设置项能被设置页正常渲染）。
- `verify-tab-close` → **13 / 14**。唯一失败项（「双击 ✕ 仅按钮语义」）**是既有失败**：
  把本次新增的元素/接线全部去掉后**同样复现**，且标签几何逐像素未变（`{t1:{x:50,w:69}, …}` 一致）。
  同一支脚本还顺带证明 `ui-common` 新增的 `@hira-ng/shared-types` import 在 esbuild 侧也能解析
  （右键菜单照常构建出全部条目）—— 这正是那条边界的回归点。
- `test:ui-tabbar` → **7/7 100%**。⚠ 首次运行 7/7 全飘，逐图核对后确认：基线是**旧的**
  —— 它缺少图标位的"标题首字兜底"（`标`），那是**此前会话**就已落地的改动、当时没重采基线
  （见 `vertical-tabs-architecture.md` §3.3）。已按文档流程 `--update` 重采，并连跑两次确认
  **7/7 全 0 差异**（可复现）。**与本次改动无关**（去掉新增元素后同样复现，且标签几何逐像素未变）。

### 10.3 实现期发现的三件事（都已修）

1. **`createSplit` 的成员判据写错**（真 bug，被 `verify-split` 当场抓住）：
   原判据 `tab.splitId != null && 是本次成员` —— 全新标签的 `splitId` 本来就是 `null`，
   于是"从零建组"整组拿不到指针，紧跟其后的退化裁剪立刻把组丢掉。
   表现是「建组返回成功、但什么都没发生」——最坏的一类静默错误。已改为只看"是否本次成员"。
2. **`getActiveTabViewOffset` 的 `wc` 未定义**（既有 bug，在分屏路径上被顺带暴露）：
   全屏 / 沉浸分支里引用了不存在的变量 `wc` → 那条分支一调必抛 `ReferenceError`。
   改为**直接读活动标签 view 的 bounds**（同时天然支持"活动格"语义），并删掉那段与
   `applyInitialLayout` 会漂移的"按各段宽度累加"重算。
3. **分隔条不需要原生浮层**（见 §4.3 的纠正）：两格之间的缝没有网页覆盖 → chrome 拿得回来。
   这一条把原本的"新增浮层视图 + 新 IPC 家族"整块省掉了。

### 10.4 与计划的偏差（如实记录）

| 计划里写的                                | 实际                                   | 原因                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 分隔条 = 独立浮层视图                     | 改为**外壳 DOM 层**                    | 见 §4.3：缝里没有网页覆盖，浮层是多余的（更简单、更快、少一个渲染进程）                                                                                                                                |
| `SplitHost.js` 单独一个文件               | 并入 `LayoutCoordinator` + `tabLayout` | 它需要的全部上下文（`pageBounds` / `win.contentView` / 标签 view 表）都在 LayoutCoordinator 手里；单独一个文件只能靠回调把状态来回复制                                                                 |
| 步骤 10 的"设置项（最大格数 / 默认布局）" | ✅ **已做**                            | 见 §10.1 最后两行：键名与选项在 shared-types 真源，主进程延迟端口现读；**只约束新建与加入**，不改已建好的组                                                                                            |
| §5.3 的"能力段 / 渲染侧插槽"              | **未登记**（仍按原计划不做）           | 与计划一致：地基（真禁用）未在分屏上复现前不登记                                                                                                                                                       |
| 拖标签到内容区边缘建分屏（Arc 式）        | ✅ **已做**（见 §10.8）                | 原判断（"前置子系统未接线"）是真的 —— `tab-drag-controller.js` 确实全仓无调用方。但**不需要它**：落点判定可以完全走渲染侧（`elementFromPoint` 命中 `#chrome-content`，见 §10.8），不必先接完跨窗口拖动 |

### 10.5 已知边界（不是缺陷，是刻意的）

- 单个窗口同一时刻只有**一个活动分屏组**（切到组外标签即退出分屏显示，组本身保留在标签条上，
  点回任一成员即恢复）。这与 Firefox "分屏是标签的组合态" 一致。
- 非活动格可被休眠，**活动格永不休眠**（`_syncActiveSplit` 会先唤醒组内其余成员，
  否则那一格会是一个没有 view 的黑洞）。
- 网格形态在三格以上才有意义（2 格时"网格"与"上下"逐像素相同，故菜单轮换会跳过它）。

### 10.6 设置项的两条口径（记下来免得后人改歪）

- **两层上限，各管一件事**：`SPLIT_METRICS.maxPanes`（shared-types 真源，= 4）是**物理硬上限**
  （domain 按它兜底）；`app.split_max_panes`（2..4）是**用户口径**，夹取在
  `infra-window/src/tabLayout.js#splitOptionsOf` 一处完成（设置文件可手改，非法值必须回落）。
  用户口径永远不得超过硬上限 —— 这一条由夹取保证，不是靠"表单里只有三个选项"。
- **设置只约束"新建 / 加入"，不改已存在的组**：改一次设置就把用户正看着的分屏当场重排，
  属于"设置项动了我没碰的东西"。因此 `createSplitGroup` 用新口径裁剪入参、
  `setTabSplit` 在入组前查目标组是否已满，而已有的 `splits` 一个字段都不动。

### 10.7 创新增量批次（I2 / I4 / I6 / I3 剩余）

| 项          | 新增的**纯判据**（真源）                                          | 接线                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I2 比例预设 | `split-layout.mjs#ratiosForPreset` + `SPLIT_RATIO_PRESET_OPTIONS` | 通道 `tab:split-ratio-preset` → `TabManager.setSplitRatioPreset`；标签菜单三项；**分隔条双击 → 'even'**（`split-surface` 的 `dblclick`）                               |
| I6 格导航   | `split-layout.mjs#neighborPaneIndex`                              | 通道 `tab:split-focus` → `TabManager.focusSplitPane`（向布局层要格矩形）；快捷键 `Ctrl+Alt+方向` ×4 + 设置页可见                                                       |
| I4 栈↔分屏  | 无（复用既有两条通道）                                            | 芯片菜单「平铺成分屏」→`createSplit`；标签菜单「收拢为标签组」→ 先 `dissolveSplit` 再 `createStack`（`tab-split-actions.js#collapseSplitIntoStack`，横竖两个宿主共用） |
| I3 剩余     | 无                                                                | `TabManager._splitUndoStack`（+`canRestoreSplit()`）+ 通道 `tab:split-restore` + 标签菜单项                                                                            |

**两条实现期定下的口径**（免得后人改歪）：

- **"格导航"的判定必须是"投影重叠优先、再比距离"**：只比距离会让"左侧更远的同列格"输给
  "左侧更近的错行格"——用户按 ← 却跳到了下方，与编辑器里格导航的直觉相反。
  重叠为零的候选仍可入选（排在后面），否则网格里上下方向会"没有邻居"。
- **"复原上次解散的分屏"的菜单项按"真能复原"出现**，不是按"撤销栈非空"：栈里的成员可能
  已被关闭，那条记录永远复原不了。判定收在 `TabManager.canRestoreSplit()` 一处，与
  `restoreLastSplit()` 用**同一判据** —— 两处不一致就会得到"菜单项在、点了没反应"。
  `restoreLastSplit()` 本身也逐条往下翻并丢弃过期记录（否则按一次没反应、再按还是没反应）。

**验证**：`pnpm verify:split` 从 79 项扩到 **100 项**（新增比例预设 7 项 + 格邻接 14 项）。
格邻接的用例覆盖：row/column/grid 三个形态的四个方向、边界（最左/最上无邻居）、
**grid 里"同列优先于错行"**、以及非法入参（不存在的格 / 非法方向）。

### 10.8 增补两项（I5 的确定版 + 拖动式入口）

#### 格间链接路由（I5，`app.split_link_routing`，默认 **off**）

- 接入点是 `tabEvents.js#setWindowOpenHandler` 的 `foreground-tab` / `background-tab` /
  `new-window` 分支**之前**。接管时必须 `deny` —— 一旦落进 `allow` 分支，Electron 会真的
  建出新标签，结果是"下一格导航了，同时还多出一个标签"。
- **只接前台语义**：`background-tab` 不参与（它本就不该抢占任何一格）。
- 落点规则 = **按格序循环的下一格**。为什么不是"另一格"：3~4 格时没有唯一的"另一边"；
  按格序循环是确定、可预期、且与**格序**（不是标签条顺序）一致的规则。
- 默认 **off**：这是唯一一个"会改变网页里点击结果去向"的分屏开关。默认改掉它，用户会遇到
  "点了链接，另一格换了页面"而我方没有任何提示 —— 与 Edge 把 "Open links in the other pane"
  做成 opt-in 同口径。
- 目标格会**导航过去并成为活动格**（"我要看这个新页面"是点击者的意图）。

#### 拖标签到网页区域分屏（Arc / Edge 拖动式入口，**五个标签宿主全通**）

- **判定在主进程，不在渲染层**。理由很硬：标签有 5 个宿主，其中 4 个（侧栏 view /
  侧栏覆盖层 / 打开标签面板 / 固定标签面板）跑在**各自独立的渲染进程**里 —— 那些文档里
  没有主窗口的外壳 DOM，任何"在渲染层量一量"的做法（例如命中 `#chrome-content`）
  只会在横向标签条这一个宿主成立。而主进程手里两样都齐：**发送者视图的 bounds**
  （`findViewByWebContents(sender).view.getBounds()`，它自己摆的）与**内容区矩形**
  （布局层算的）。渲染层只报 `{ tabId, baseTabId, x, y }`（本视口坐标），
  主进程一次加法即得结论 —— **一个出口、一套判据、五个宿主共用**（`tab:drag-drop-content`，
  单向 `send`，dragend 不需要回值）。
- **坐标口径**：渲染层给的是自己视口的 CSS 像素，`getBounds()` 是窗口内 DIP；两者在
  Electron 里 1:1，所以直接相加，没有缩放 / 多屏 / 外框换算。
- **配对的"另一格"= 拖动开始前正在看的那一格**（Arc 同款语义），在 `dragstart` 里读一次：
  横向读 `.tab-item.active`、纵向读 `.tabrow-row--active` —— 各宿主最清楚自己的标记，
  硬凑一个通用选择器只会更脆。刻意不读宿主的 `activeTabId`：那个值在 `tab:changed`
  回推后才更新，依赖"此刻还没更新"是一种隐式时序耦合。
- 纵向宿主**必须把两个 id 单独存**，不能复用现有的 `dragId`：`drop` 处理器（落进列表内）
  会先把 `dragId` 清空，到 `dragend` 时已经读不到了。
- 被拖的标签**本来就是活动标签**时安静地什么都不做（没有可配对的"另一格"）。
  **不退回"与相邻标签分屏"**：那会让同一个手势在不同情况下得到两个不同结果。
- 提示是**能力提示**（"松手在网页区域可分屏"）而不是状态指示：外壳收不到"指针是否压在
  网页上"的事件（指针一进网页原生视图就离开了本视口），所以只能表达"你已经拖到视口之外，
  那正是可以分屏的地方"。措辞用"可以"而不是"即将"——拖向另一个窗口时后者是错的。
  观察器 `createDragHintWatch` **横纵共用一份**，且只在拖拽期间 `arm()`、结束立刻 `disarm()`
  （标签条/列表都是最热路径，常态必须零监听器零开销）。横向的提示在标签条右端，
  纵向的在列表左下。
- 顺带记一条踩过的坑：`WebContentsManager#findViewByWebContents` 返回的是
  **`{ kind, id, view }` 而不是 view**。本项目早先有一段代码写成 `typeof found.getBounds === 'function'`
  来判断，那个条件**永远为假** —— 于是它那条分支从来没生效过（该段代码已在 §10.3 第 2 条被替换）。

#### 本轮验证补充

- `pnpm verify:split` → **103 / 103**（+3：`linkRouting` 的缺省/开启/非法回落）。
- `pnpm check:methods` → **546 文件 / 0 处**（判定搬到主进程后仍全绿）。
- `verify:settings-page` → **11 / 11**（第三个分屏设置项也能被设置页渲染）。
- `test:ui-tabbar` → **7/7 0 差异像素**（改动后复跑确认）。
- **启动冒烟** → `main window created` → `ui-shell[dom-ready]` → `rail finished` →
  `enableAppPlugins`，无 FATAL 无 error 行。
- ⚠ 判定搬到主进程后，"纵向宿主是否也触发"只能在**带真实拖拽**的交互里确认
  （headless 无法模拟原生 HTML5 拖拽的 `dragend` 坐标）—— 这是本轮唯一没有自动化覆盖的点，
  已按 §10.9 的规矩用启动冒烟 + 逐条静态核对（`check:methods` + 五个宿主的 port 链）替代。

### 10.9 一次启动崩溃 + 新增的一道门禁（重要教训）

**现象**（用户实机）：

```
[main] FATAL error during startup: TypeError: this._hideSplitDivider is not a function
    at LayoutCoordinator.applyInitialLayout (LayoutCoordinator.js:1102:12)
```

主进程在 `createMainWindow` 里就致命退出 —— **整个应用起不来**。

**根因**：分隔条方案从"独立浮层视图"改成"外壳 DOM"（§4.3）时，那个 `_hideSplitDivider()`
方法随之删掉了，但 `applyInitialLayout` 里**三处调用点漏删**。其中一处落在
`else if (this._activeTabId)` 这个**每次启动必走**的分支上。

**为什么四道门禁一道都没拦住** —— 每一条都是已知的边界，叠起来正好是个洞：

| 门禁                  | 为什么漏过                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eslint`              | `no-undef` 只查**标识符**，不查"类方法的成员访问"。`this._xxx()` 里的 `xxx` 在语法上是一个属性名，永远不是未定义标识符 |
| 类型检查              | 仓库是纯 JS，`@ts-check` 只是注释标记，**不参与构建**，因此 `tsc` 这一层不存在                                         |
| `verify:split` 等     | 它们只测**纯函数层**（几何 / 规则 / 会话契约）—— 而那三处调用在 Electron 宿主里，headless 测不到                       |
| `electron-vite build` | 只做打包。成员访问是**运行时**解析的属性，打包器不会（也不该）为它报错                                                 |

**修复**：删掉三处调用（分隔条的显隐统一由末尾的 `_pushSplitGeometry()` 下发 `{active:false}`），
并顺手清掉随之成为死代码的 `_splitDividerKey` 字段。

**新增门禁 `pnpm check:methods`**（`scripts/check-methods.cjs`）：静态检查"直接调在 `this` 上的
私有方法是否真的有定义"。判据收得很紧，因此**零误报**：

- 只匹配 `this._name(`（左括号紧跟）→ `this._wcm.getTab()`、`this._layers.reallocateFocus()`
  这类"别的对象的成员"天然不在射程内；
- 定义形式接受类方法 `  _name(`、构造里挂的 `this._name =`、以及对象字面量里的 `_name:` / `_name =`；
- 跳过 vendored 第三方 bundle（`external/`，例如游戏用的压缩 React chunk —— 那 8 处命中全出自它，
  不是我们的代码）。

实测：**546 个文件、0 处**。这条经验值得单独记着 —— **"纯函数层全绿"不等于"应用能起来"**；
恰恰是那些"接线处"（方法调用、字段名、事件名）既没有类型也没有测试覆盖，
而它们的失败模式是"整机不可用"。接线类改动做完后，**至少要真启动一次**。

### 10.10 焦点、回形针、成员相邻（2026-10，用户三项要求）

用户原话：**"引入类似 Edge 的焦点功能（操作哪一边就切到那个标签 + 淡蓝色框）；分屏的两个标签
必须一起连着、不可分离、中间不许夹别的标签，两者之间有一个回形针图标；垂直标签的侧栏 tabbar
也要有完全与 tabbar 一样的完整行为体系。"**

#### ① Edge 焦点（点哪一格 → 哪一格成为活动标签 + 淡蓝框）

| 环节         | 落点                                                                                                                                                        | 说明                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 网页侧触发   | `infra-window/src/tabEvents.js` 的 `wc.on('focus')`                                                                                                         | 三条判据全中才 **`host.switchTo(id)`**：当前确实在分屏 + 它是这个可见组的成员 + 它不是活动标签。少了第三道闸，任何一次 webContents 拿到焦点（窗口重新激活 / 页面自己 `focus()`）都会切标签 |
| 标签条侧跟随 | `LayoutCoordinator#showTab`（**既有**）                                                                                                                     | 成员标签被切换时同步 `split.activeTabId`；与上面一条互补，两侧都跟得上                                                                                                                     |
| 淡蓝框       | `shared-types#SPLIT_METRICS.paneGap = 2` + `LayoutCoordinator._placeSplitPanes`（每格收缩 gap）+ `app-shell/shared/split-surface.js`（`.split-pane-frame`） | 框落在**每格让出的那圈空隙**里 —— 那里没有任何网页 view，外壳 DOM 天然画得上。**几何恒定**（gap 是常量、切活动格不动任何 bounds）→ 换框只是一次类名切换，网页不重排                        |

「每格让出一圈空隙」是这套实现的关键：web view 只占"格矩形收进 gap 之后"的部分，
于是那一圈属于 chrome —— 与分隔条（§4.3）是**同一个原理**，不需要再开一个原生浮层视图。

#### ② 回形针 + "成员必须相邻、不可分离"

顺序不变式（domain 纯函数 → 唯一强制点 → 两个渲染器只读判据）：

```
domain-tabs#TabSplits.coalesceSplitRuns(order, splits)   ← 规则本体（纯函数，可单测）
infra-window#tabLayout.enforceSplitRuns(host)            ← 唯一强制点（逐位写回 position）
TabManager#_emitTabChanged()                             ← 唯一调用出口（覆盖全部 5 处写 position 的地方）
TabManager#_markSplitLinks(items)                        ← 派生布尔字段 splitLinkAfter（原地写入投影）
ui-tabbar / ui-common#tabRowList                         ← 只读这个布尔字段画回形针
```

- **合拢锚点 = 组内成员在现行顺序里最靠前的位置** —— 于是"远隔的两个人建组"不会把整组搬到列表末尾
  （标签条大跳一次），而是在靠前那个人处就地合拢。
- **回形针判据在主进程算**（`splitLinkAfter` = "我之后紧跟着同组伙伴"）：两个渲染进程各写一遍
  "下一个是不是同组"必然漂移（本项目已有多次先例），所以只给一个布尔字段。
- **判据、外观**两样都收在共用件里（判据 `ui-common/src/tab/splitLink.ts`，外观
  `ui-common/src/tab/splitClip.ts`，见 §10.12 的修正）：`splitMarks`（投影 → 每段成员 / 每一对相邻项）、
  `createSplitClip`（元素 + 图标 + 尺寸）。两端只负责"摆在哪、什么时候有这一枚"。
- **横向**（`ui-tabbar/src/view/splitClipLayer.js`）：回形针画在**两条相邻标签之间那道缝的正中**
  （跨在边界上，左右各半）。它必须是一层绘制层 —— `.tab-item` 带 `overflow: hidden`
  （关闭时要塌宽裁住内容），标签内部画不出越过自身边界的东西。
- **纵向**（`ui-common/tabRowList.ts`）：分屏段整体收进一个 `.tabrow-pair` 容器（并排合体，见 §10.19⑥），
  回形针钉在**容器接缝的 k/N 正中**。行带 `contain: layout style paint`（跨缝的绝对定位子元素会被裁掉），
  容器没有裁剪 —— 这是"挂在容器上"能成立的前提，也让旧的抬层（`--split-head`）整套删除。
- 纵向列表是**四个宿主共用一份**（侧栏 / 打开标签面板 / 固定标签面板 / 悬停浮出层），
  于是这一条自动四处生效 —— 这正是"一份实现"的价值。
- 旧的那个 6px 分屏方块标记（`.tab-split-mark`）**已删除**：回形针把"这一对连着"说得更清楚，
  两个指示器叠在一个 140px 的标签上只是噪音。

#### ③ 分屏 vs 标签栈：~~冲突裁决~~ → **正交共存**（2026-10-17 起改写）

> **历史（已废除）**：曾设「分屏胜」裁决 —— `tabLayout#detachSplitMembersFromStacks`
> 在强制点里把成员的 `stackId` 清掉。当时的顾虑是：标签栈是"收纳"、分屏是"并列"，
> 折叠组会把分屏成员藏起来、回形针画不出来。

**现行口径：两者正交共存，互不摘除。** 重新推演后发现旧顾虑可由机制自身消化，
不必动用裁决：

- 归属字段本就正交（`tab.stackId` / `tab.splitId`，domain 设计如此）；
- 「分屏成员必须相邻」这条不变式算在**扁平顺序**上（`coalesceSplitRuns`），
  与投影是否把成员收进芯片**无关**；
- 折叠组藏起分屏成员时，`splitLinkAfter` 是在扁平列表上算的、投影重排不破坏
  伙伴相邻性；被藏成员的回形针在投影里取不到节点 → **自然不画**（优雅降级），
  没有任何错误视觉（横向连接带已于合体标签上线时整体下线，见 §10.19）。

因此 `detachSplitMembersFromStacks` 已整体删除，`enforceSplitRuns` 只剩
「把成员合拢」一件事。连带解除的三处入口限制：

- `TabManager#dropTabOnContent`：拖到网页做分屏**不再**顺带清掉 `stackId`
  （离组手势另有其位：拖到标签条空白处 → `leaveStack`）；
- `tabContextMenu` 的 `canStackNext`：分屏成员**照常出现**「并入/堆叠」项
  （真的进得去，不再是"点了没反应"）；
- 凹槽归属：横向标签下方的凹槽**只归标签组下划线**所有（分屏连接带随合体标签下线，
  见 §10.19）；纵向同理 —— 分屏竖线整族删除后，列里只剩组下划线这一条。

`collapseSplitIntoStack`（收拢为标签组）保留，但语义改为**显式转换动作**
（用户点了这个命令 = 不要分屏了、改成收纳），不再是冲突裁决。

#### ④ 验证

- `pnpm verify:split` 新增第 ⑤ 组「相邻不变式」共 10 项：`coalesceSplitRuns` 四条纯规则 +
  宿主侧四条（远隔建组即相邻、不丢标签、锚点位置、插到中间被挤出）+ 摘栈两条。
  **113/113 通过**。
- `check:layers` 0 违规；`check:methods` 0 处；`eslint` 干净。
- `check:z-index`：顺手清掉三处裸数值（两处拖拽提示 `60` → `--hira-z-tooltip`，
  分隔条 `1` → `--hira-z-elevated`），现 **0 违规**。

#### ⑤ 明确未做（记录边界，不是遗漏）

- **插件装饰插槽**（`tabbar.item-renderer`）目前只挂在横向标签条上，纵向列表尚未接
  —— 那需要把 `ui-tabbar/src/components/decoration.js` 上移到 `ui-common` 并在 apps 侧
  把插槽端口接进侧栏装配。与分屏无关，单独一批做。

### 10.11 拖到网页区域时的**落位预览块**（Zen / Vivaldi 同款，2026-10）

用户原话：**"学习 Zen、Vivaldi，实现拖动标签到网页这一块时有预览位置块，就是能决定拖动到
不同区域是上下排序还是左右排序，要在左边还是右边还是上面还是下面。"**

完整对照与分层设计另见 **[tab-drop-zone-design.md](./tab-drop-zone-design.md)**（拆解两家的做法、
归纳 D1–D6 六条不变式、给出四层落点）。本节只记**落地事实**。

§10.8 那条拖动式入口此前只做到了"松手算结果"（**盲拖**：拖动期间零反馈，且方向固定取设置里的
`split.default_layout`）。本轮补齐两件事：**过程可见**、**方向由落点决定**。

| 层       | 落点                                                                        | 职责                                                                                               |
| -------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ① 纯规则 | `shared-types#resolveDropZone` / `dropZonePaneRect` / `splitMembersForDrop` | 光标 + 网页矩形 → 方向、形态、**预览块矩形**、成员顺序。零 IO、可 headless 验                      |
| ② 主进程 | `apps/app-main/src/main/tab-drop-zone.js#createTabDropZone`                 | 拖动期间 30fps 采样（复用 `CursorEdgeMonitor#onTick`）→ 调 ① → 推浮层；松手交出**最后一次意图**    |
| ③ 浮层   | `renderer/dropzone-overlay/` + `ui/ui-drop-zone/`                           | 独立原生视图（与查找栏 / 悬停 URL / 缩放条同族）。**视图 bounds 就是预览块矩形**，渲染页只填满自己 |
| ④ 提交   | `TabManager#dropTabOnContent({ tabId, baseTabId, zone })`                   | 方向 → `layout` + 成员顺序。**`zone` 为空（= 松手时没画着落位框）一律不分**（见下第 6 条）          |

关键取舍（每条都有代价，记下来免得后人改歪）：

1. **预览块必须走独立浮层**。网页是原生 `WebContentsView`、外壳在其**之下** —— 外壳 DOM 里
   画不出任何压得住网页的东西。这与分隔条/淡蓝框"落在缝隙里"是两种不同的解法：那两者利用的是
   **不被网页覆盖的区域**，而预览块要盖在网页**正中**，只能另起一层视图。
2. **拖动期间只能由主进程算**。指针一进网页原生视图就离开了外壳视口 —— 渲染层收不到任何
   `dragover`。因此新增一条单向通道 `tab:drag-drop-begin`（dragstart 那一拍上报），
   主进程据此起 30fps 采样。**"拖动开始"这个信号只有渲染层知道**，省不掉。
3. **判据用归一化距离**（除以宽/高），不用像素。否则"拖到偏左处"在 2000px 宽与 400px 宽的
   窗口里会判出不同方向 —— 同一种手势两种结果。verify-split 专门守这一条。
4. **轴级可切性判断**：某条轴放不下两格（`< 2×minPane + divider`）时**不给**那两个方向的落点。
   否则预览块会是个不足 `minPane` 的窄条，而落位时 `applyMinSize` 会把它夹回去 ——
   预览与实际差一截，正好踩中"所见即所得"这条底线。
5. **预览矩形与最终那一格逐像素同式**。`dropZonePaneRect` 的第二格用"总数减第一格"
   （与 `distribute` 逐字同式），而不是"再四舍五入一次" —— `avail` 为奇数时后者差 1px。
   verify-split 用**奇数尺寸**的矩形专门验这一条（8 个方向）。
6. **落位框是唯一判据（"他们是一起的"）**：提交时**只认拖动期间采样算出的 `zone`** ——
   没有 zone（没画过框）就一律不分（`reason: 'no-preview'`）。用户口径："不是拖过来就分屏，
   是等落位框显示才能开始判定"。原先那条"松手时再读一次光标 + 用默认方向"的**降级路径已删除**：
   它既会用两套时刻的坐标做决定（松手那一瞬 vs 最后一拍 ⇒"预览还在、松手却没反应"），
   也正是"只把标签拖过去松了个手，却凭空分屏"的来源；连它的 `trusted` 开关一并去掉。
7. **浮层预热**：`browser-window-assembly` 的 chrome 级浮层预热名单里加了它 —— 它的视图是在
   **拖动进行中**才第一次显示，那时才建 view + 拉渲染进程既慢又可能打扰正在进行的那次原生拖拽。
   预热之后拖动期只剩一次 `setBounds`。
8. **顺带修掉一个既有缺陷**：`tab:drag-drop-content` 是裸 `ipcMain.on`，不进「按发送方解析窗口」
   的上下文，于是多窗口下 B 窗口拖标签会把落点提交到 **A 窗口**的 TabManager。现在两条拖动
   通道都走了 `senderScopedIpcMain`（begin / end 必须落在同一个窗口上，只包一条会更糟）。

验证：`verify:split` 新增第 ⑥ 组「拖动落点」共 16 项（129/129 通过）；`eslint` / `check:layers` /
`check:z-index` / `check:methods` 全绿；`electron-vite build` 通过（`out/renderer/dropzone-overlay/`
与 `out/main/tab-drop-zone.js` 均已产出）。

### 10.12 回形针的两处修正 + "一套规则管两种呈现"（2026-10，用户实测反馈）

用户原话：**"回形针不是在某个标签的末尾，而是在两个标签之间！垂直标签为什么普通标签也一直
显示回形针，很错误，而且也并没有接入很多分屏新出的特性，你显然只给横向 tabbar 做了适配"**。

#### 两个现象与根因

| 现象                                                   | 根因                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 横向：回形针挂在**第一个标签的末尾**（不是"两个之间"） | 它被塞进了 `.tab-item` 的右内边距。而 `.tab-item` 带 `overflow: hidden`（关闭时要塌宽裁住内容）—— **标签内部画不出任何越过自身边界的东西**，所以"跨在两条标签之间"在那个位置上物理上做不到 |
| 纵向：**每一行**都挂着回形针                           | 两端各写了一套外观 + 各写了一条显隐规则：横向写了 `display: none` + `.split-link-after` 时显示；纵向只写了外观，**漏了"默认隐藏"**，于是 `.tabrow-clip { display: flex }` 对每一行都生效   |

#### 修正：判据 / 外观 两样各只留一份

判据独立在 **`ui-common/src/tab/splitLink.ts`**，外观在 **`ui-common/src/tab/splitClip.ts`**，
横向标签条与纵向标签列都从它们读：

| 共用件导出                     | 管什么                                                                             | 两端各自的活                |
| ------------------------------ | ---------------------------------------------------------------------------------- | --------------------------- |
| `splitMarks(items, keyOf)`     | **判据**（`tab/splitLink.js`）：投影 → `runs`（每段连续成员）/ `pairs`（每一对相邻项），纯函数，读主进程的 `splitLinkAfter` | 各自把自己的 key 规则传进来 |
| `splitLinkPairs(items, keyOf)` | 上面 `pairs` 的薄封装（横向回形针用）                                              | ——                          |
| `createSplitClip(doc, opts)`   | **外观**：元素 + 图标 + 尺寸（`--split-clip-size` 一并暴露给定位用）               | 只附加一个定位类名          |
| `injectSplitClipStyles(doc)`   | 外观的 CSS                                                                         | 两端各调一次注入            |

**没有"显隐"这一项**：两端现在都是"有就建、没有就删"—— 横向是绘制层里的浮标（逐帧增删），
纵向回形针挂在合体容器上（与成员同寿命）。旧版的 `setSplitClipVisible` + `[hidden]` 规则
随之删除：少一套状态，就不会再出现"忘了切显隐"。

**横向改为绘制层**（`ui-tabbar/src/view/splitClipLayer.js`）：层挂在 `#tabs-inner` 里，
不属于任何标签，于是能**居中跨在两条标签之间那道缝上**；位置只量**真实矩形**
（`(前一条.right + 后一条.left)/2`），动效期间逐帧跟着走（与标签组下划线层同源，
理由也一样：开合/让位/选中换宽都是 180ms 的逐帧动画，`offset*` 是"布局最终值"）。
`Tab.js` 从此不再产出回形针，标签结构回归干净。

> 合体标签（§10.19）之后，横向两半之间的**缝就是接缝本身**：负 `margin-left` 让两条边
> 重合，`(right + left)/2` 仍然落在接缝上 —— 定位公式一行未改。

**纵向判据也换成共用函数**：`setItems` 里一次 `splitMarks(list, rowKey)` 拿到 `runs`，
据此把连续成员收进合体容器（见 §10.19⑥）—— 纵向不自己读 `splitLinkAfter`
去推"下一个是不是同组"，两端判据同源。

#### 关于"只给横向做了适配"

逐项核对了纵向（`ui-common#tabRowList` / `#tabListHost`）与横向在**分屏**上的能力面，
两者本就是同一份实现，并不缺项：Alt+点击分屏、拖到网页区域分屏（含本轮的 `drag-drop-begin`
起点）、拖动落位预览、右键菜单四项（与相邻分屏 / 切方向 / 反转格序 / 比例 / 收拢为标签组 /
解散 / 复原）、相邻不可分离、活动格跟随 —— 全部走同一条链路。纵向的"每行都显示回形针"
是显隐规则漏写造成的观感，修正后即与横向一致。

两处的差异只剩**几何**：横向落"两条标签之间的缝"（必须用绘制层，因为标签裁内容），
纵向落"合体容器的接缝"（行也裁内容，所以挂在容器上）。同一张对照表记在
`ui-common/src/tab/splitClip.ts` 的文件头。

### 10.13 右键菜单"点了没反应"与标签组的四项修正（2026-10，用户实测反馈）

用户原话：**"分屏相关的右键菜单项都没反应，请修复；标签组堆栈也有很多 bug，请给标签组堆栈
加个解散标签组（全部恢复正常状态）；另外标签拖拽出去也要算脱离标签组；另外标签组内单个标签
也加个脱离标签组的菜单项"**。

#### ① 分屏菜单为什么"能看见、点了没反应"

三跳端口链**断在中间**（两端都在、看不出来）：apps 侧的 `createSplitMenuHandlers(tabsClient)`
早就造好了整包，`tab-session-controller` 也把它**摊在 `createTabbar` 的 options 顶层** ——
但 `ui-tabbar/src/index.js` **没有解构它**，`createTabbarContextMenu` 的 intent 里当然也没有，
于是 `action` 命中后 `H.onSplitWith` 是 undefined，菜单项照样出现（可见性判据只读数据）、
点下去什么都不发生。**七项**（与相邻分屏 / 切方向 / 反转格序 / 三个比例 / 收拢 / 解散 / 复原）全哑。

修法不是补七行，而是**整包透传**：`createTabbar` 新增 `splitMenu` 选项，
contextMenu 的 intent 用 `...(splitMenu || {})` 展开。宿主侧加一项，这里自动跟随 ——
逐项列正是漏接的成因。列表宿主（纵向）本来就走 `createTabRowMenuFactory` 的整包，一直是好的。

> 教训：**"菜单项出现了"不等于"动作接上了"**。菜单项的可见性判据与动作 handler 是两套查找，
> 前者命中而后者缺失时，表现恰好就是"点了没反应"。所以动作一律**整包传递**，
> 让"有没有接上"在结构上只有一处可能出错。

#### ② 标签组：解散 / 移出 / 拖出（三项补齐 + 一个坏项）

| 项                         | 语义                                                                                                               | 落点                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **解散标签组**（新）       | 成员全部回到散标签、组元数据删掉（"全部恢复正常状态"）                                                             | domain `TabStacks.dissolveStack` → `tabLayout.dissolveStack` → IPC `tab:stack-dissolve`                                                                                                               |
| **移出标签组**（新）       | **单个**标签脱离它所在的组（组还在，其余成员照旧）                                                                 | 标签行菜单（`tabContextMenu`）在 `t.stackId != null` 时出现 → `setTabStack(tabId, null)`                                                                                                              |
| **拖出去＝出栈**（~~补齐~~ **已回退**） | ~~拖到标签条**之外**（网页区域）也算离开标签组~~ 2026-10-17 起**不再**清 `stackId`：分屏 × 栈正交共存后，分屏手势只表达"我要分屏"；离组手势归「拖到标签条空白处」一条 | `TabManager#dropTabOnContent` 的出栈块已删（见 §10.10③） |
| ~~拆分标签组~~（**删除**） | 它把**全部**成员迁到换过 id 的新组（label/accent/collapsed 全继承）—— 外观与行为一字不变，用户感受就是"点了没反应" | 菜单项删除；domain 的 `splitStack` 是"迁**部分**成员到新组"，规则能力保留（有单测），但**没有 UI 入口就不留 IPC**，连带清掉 schema / handler / client / tabLayout / TabManager 与插件能力表那一整条链 |

顺带修掉两个同类坏项：

- **合并子菜单曾把自己也列出来**（纵向那份是就地手抄的菜单）→ "除自己以外"的过滤移进共用件
  `createStackChipMenu`（它是菜单自身的不变式，宿主容易漏）。
- **分屏成员不再出现**「并入/堆叠」项（~~互斥~~ **已回退**）：2026-10-17 起分屏 × 栈
  正交共存（§10.10③），这一项对分屏成员**照常出现** —— 真的进得去、也不会被谁摘出来。

#### ③ 顺手把"两份菜单"合成一份

纵向列表的标签组菜单原本是**就地手抄**的（注释里还写着"与 TabStack.js 同一套做法"），
于是两端各改一处、各坏一处。现在：

```
ui-common/src/tab/chipMenu.ts
  createStackChipMenu()     模板（含配色子菜单、合并子菜单）
  runStackMenuAction()      动作分派（只有 'rename' 交回宿主开输入框）
  createStackMenuHandlers() 动作表（唯一一份；纵向列表自己就地构建，横向由宿主注入同一份）
```

两端各自只剩"重命名要在自己的节点上开输入框"这一件 DOM 事。

#### ④ 验证

- `vitest`：`TabStacks` 12/12（新增 `dissolveStack` 三条）、`TabManager.wiring` 11/11
  （用 `dissolveStack` 换掉 splitStack 的接线断言）、`r1-registrars`、`tabs-service` 全绿。
  其中 `TabManager.wiring` 与 `tabs-service` 原先各有**夹具腐坏**（漏 `profileId/spaceId`、
  漏 `isTabSleeping`、写死"共 35 个能力"），一并修掉：测试断言改成不随数量过期的写法。
- `eslint` / `check:layers` / `check:z-index` / `check:methods` / `verify:split`(143) 全绿，
  `electron-vite build` 通过。
- 仓库里仍有 **5 个与本次无关的既有红灯**（domain-password ×3 / domain-permission /
  domain-settings / infra-extensions / ipc-channels 的 `buttonsEditZone` 撞车）——
  项目自身的 `.hira-ai/current-milestone.md` 已把它们记为既往问题。

### 10.14 分屏 hover 工具条（Zen / Edge 同款，2026-10，用户实测反馈）

用户原话：**"hover 在一个分屏上有个悬浮的小控件，就是一个关闭按钮，一个拖拽按钮，可以拖拽
进行重排，然后还有几个小工具按钮，就是相当于右键菜单中的一些操作项。总之就和 Zen、Edge 一样"**。

这是 §10.7 里那批"创新增量"之外的**对齐型**能力：四家（尤其 Zen / Edge）在分屏上都有一条
"指针停在某一格 → 角落浮出一排小按钮"的快路径。本节记录它的落地与为此新增的三条不变式。

#### ① 五个按钮 = 右键菜单的一个子集（快路径，不是新语义）

按钮表**只在 ui 包里有一份**（`ui/ui-split-toolbar/src/index.js` 的 `BUTTONS`），从左到右：

| #   | id         | 图标             | 动作                  | 语义                                             |
| --- | ---------- | ---------------- | --------------------- | ------------------------------------------------ |
| 1   | `grip`     | `GripVertical`   | `drag-begin/drag-end` | 拖拽手柄：按住拖动重排格序                       |
| 2   | `layout`   | `LayoutGrid`     | `toggle-layout`       | 切换分屏方向（左右 ⇄ 上下）；column 时图标转 90° |
| 3   | `reverse`  | `ArrowLeftRight` | `reverse`             | 反转格序                                         |
| 4   | `collapse` | `Layers`         | `collapse`            | 收拢为标签组                                     |
| 5   | `dissolve` | `X`（danger）    | `dissolve`            | 解散分屏（用户口中的"关闭按钮"）                 |

后四个动作与标签右键菜单里的分屏项**是同一批宿主方法**（`runAction` 直接映射到
`TabManager#toggleSplitLayout / reverseSplit / collapseSplitIntoStack / dissolveSplit / moveSplitMember`），
所以"菜单里怎么变，工具条就怎么变"——**不存在第二套分屏规则**。
菜单是"可发现性兜底"，这排按钮是"已经在分屏里时的快路径"。

> 动作集合在主进程侧是**白名单**（`split-toolbar.js#TOOLBAR_ACTIONS`）：浮层是独立渲染进程，
> 传上来的字符串一律先过 `Set` 再执行，不做"猜动作名"的模糊映射。

#### ② 为什么"hover 判定"必须在主进程（本模块存在的唯一理由）

指针一旦进入网页原生视图，外壳渲染层**收不到任何指针事件**；浮层自己也不可能靠 CSS `:hover`
知道"指针进了分屏"——它要么整块吃掉鼠标（挡住网页）、要么整块穿透（收不到事件）。Electron 的
视图命中是**矩形级**的，没有"按元素命中"。所以"指针此刻在哪一格"这个事实只能由主进程按
`screen.getCursorScreenPoint()` + `win.getContentBounds()` + `getSplitGeometry().panes` 算出：

```
local = 屏幕光标 - 窗口内容区原点          （换算成内容区坐标）
index = splitPaneAtPoint(geo.panes, local)  （纯几何，见 shared-types#split-layout）
rect  = toolbarRectForPane(geo.panes[index])（贴在该格右上角，格太窄则退回左侧）
```

这决定了整个模块的形状：**主进程驱动**的浮层（与 dropzone 同族），而不是渲染层驱动的
（查找栏 / 缩放条那一族）。采样用 `CursorEdgeMonitor` 30fps，只在**当前确实有分屏**时才起表
（`sync()` 的开关），空闲 0 CPU；窗口失焦即停表。

#### ③ 拖动重排：浮层临时铺满整片 + 只报"格下标"

拖动期间浮层**铺满整片分屏区域**并保持 interactive：用户这时不会去点网页，所以"挡住网页"是
安全的，换来的是它能在自己视图里画出"目标格高亮"（渲染层量不到原生视图的位置）。
流程：

```
pointerdown(手柄) → command{drag-begin, memberIndex} → 控制器铺满 + 高亮 fromIndex
每个 tick         → splitPaneAtPoint 得到"要插到第几格" → push{dragging, dropIndex}
pointerup         → command{drag-end, toIndex} → moveMemberToIndex 判"位置没变就不提交"
                → runAction('move-member') → TabManager#moveSplitMember
```

两条刻意的设计：

- **坐标系修正（本轮踩到并修掉）**：浮层渲染页只知道**自己视图的局部坐标**（视图矩形 = 工具条
  那一小块，贴在格的右上角，`rect.x` 很大），而 `geo.panes` 是**内容区坐标**。若把前者当后者
  去 `splitPaneAtPoint`，会误命中第 0 格。**修法**：渲染层只上报 `memberIndex`（"我正显示在
  哪一格"——确定、且无需换算），坐标命中仅作兜底。
- **"没变就不提交"**：原地松手时 `moveMemberToIndex` 返回 null → 直接返回 `{moved:false}`，
  不调 `moveSplitMember`。否则整片网页会重排一次，用户看到的是"抖"。

手柄用 `setPointerCapture`，因此按钮排在拖动期是 `opacity:0` 而**不是 `display:none`**
（后者会让指针捕获失效、收不到 `pointerup`/`pointercancel`）；`pointercancel` 也当 `drag-end`
处理，兜底强制主进程退出拖动模式。

#### ④ 指针停在工具条自己身上（否则按钮点不到）

工具条贴在格的角落，但它是一块**独立视图**。指针从网页移进工具条时，`local` 仍落在同一格里，
一般不会命中别的格；但边界情况（格被压到很小、工具条溢出格）会命中 `-1` → 触发 `hideNow()`，
于是"手指刚移到按钮上，工具条就消失"。修法：记住 `lastShownRect`，指针还在这个矩形里时
**沿用 `lastPaneIndex`**，不当作离开。

#### ⑤ 生命周期（三处入口，一处兜底）

| 时机                                                 | 调用                                                                              | 文件                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------- |
| 分屏状态变化（切格 / 加格 / 减格 / 切方向…）         | `tabManager.on('tab:changed', …) → splitToolbar.sync()`                           | `browser-window-runtime.js`  |
| 窗口重新聚焦（纯切窗口回来，没有任何 `tab:changed`） | `win.on('focus', …) → splitToolbar.sync()`                                        | 同上                         |
| 窗口失焦                                             | `runtime.splitToolbar.cancel()`（无 runtime 时退回 `hideFloat('split-toolbar')`） | `browser-window-assembly.js` |
| 窗口关闭                                             | `splitToolbar.cancel()`                                                           | `browser-window-runtime.js`  |

> `focus` → `sync()` 这一条是**对称补漏**：失焦会停表，如果之后只切窗口回来而不发生任何标签
> 事件，采样表就再没机会启动——工具条会"永久失效直到你点了别的标签"。焦点与失焦必须成对。

#### ⑥ 三处名称一致性 + 图层

浮层名 `split-toolbar` 必须在**三处逐字一致**（这是浮层家族的通则）：`electron.vite.config.js`
的 renderer input、`main/ipc/layout.js#FLOAT_NAMES`、`renderer/split-toolbar/` 目录名。
图层登记在 `LayerStack`：`Z_INDEX['float:split-toolbar']=32`、`FOCUS_PRIORITY['float:split-toolbar']=0`
（低于查找栏 / 权限这类"夺焦"浮层，分屏工具条是"陪衬"）。预热名单
（`browser-window-assembly.js`）已把 `split-toolbar` 加进去，避免首次 hover 才现建视图。

#### ⑦ 文件与解耦边界

```
ui/ui-split-toolbar/src/index.js          纯 UI（只画，不认识标签/分屏/IPC）：按钮表 + 拖动高亮 + 样式 + splitToolbarDefinition
apps/app-main/src/renderer/split-toolbar/ 薄宿主渲染页（index.html + main.js）：订阅 UPDATE/HIDE、把命令 provider.send 回去
apps/app-main/src/main/split-toolbar.js   主进程控制器（不 require electron）：采样 + 命中 + 拖动会话，全由宿主注入 deps
```

新增通道（`shared-types/src/ipc-channels.mjs` 已登记）：`split-toolbar:command`（send，浮层→主进程）、
`split-toolbar:update` / `split-toolbar:hide`（event，主进程→浮层）、`split-toolbar:{setBounds,setInteractive,ready}`（invoke）。
命令通道是**裸通道**（`ipc/tabs.js` 内 `ipcMainScoped.on(sendCh(...))`），与 `split-toolbar.js` 的
白名单双重过滤。

#### ⑧ 验证

`eslint`（无输出）、`check-z-index.cjs`（违规 0）、`check-layers.cjs`（违规 0）、
`check-methods.cjs`（未定义方法 0）全绿；`electron-vite build` 成功产出
`out/renderer/split-toolbar/index.html` 与 `split-toolbar-*.js`。

### 10.15 「标签组时分屏无法正常运作」——两处真因（2026-10，用户实测反馈）

用户原话：**"标签组时分屏无法正常运作"**。查下来是**两个独立缺陷**，都被"有标签组"这个场景
放大（标签组是用户最常右键的入口），但根因都不在"标签组"本身。

#### ① 横向标签条的**分屏菜单整包被静默丢掉**（§10.13① 的修法只修了一半）

§10.13① 把"分屏七项点了没反应"记成"宿主没把 `splitMenu` 传进 `intent`"，于是修法是
`ui-tabbar/src/index.js` 的 `intent` 里 `...(splitMenu || {})`。**但那一跳是转手，不是终点**：

```
index.js         intent: { onGoBack, …, ...splitMenu }      ← 整包只到这里
contextMenu.js   handlers: { onBack: call('onBack'), … }     ← 固定几项，没有分屏
                 ↑ createTabContextMenu({ handlers }) 的 H 就是这个对象
tabContextMenu.ts  case 'splitWithNext': if (tabId && H.onSplitWith) …   ← H.onSplitWith 恒 undefined
```

`intent` 要经 `call(name)` 取用，而 `handlers` 是**写死的对象字面量** —— 名字没列进去，
`H.onSplitWith` 就永远是 `undefined`。表现与 §10.13① 一字不差：**菜单项都在、点下去没反应**。
纵向列表（`tab-row-menu.js` 里 `...createSplitMenuHandlers(tabsClient)`）一直是好的，
所以只有**横向标签条**哑掉 —— 而横向标签条正是"标签组展开后右键组内成员"的地方。

**修法（整包直送，去掉那道转手）**：

```
ui-tabbar/src/index.js         createTabbarContextMenu({ intent: {固定别名那一批}, splitMenu })
ui-tabbar/src/view/contextMenu.js  handlers: { …, ...splitMenu }
```

与纵向列表取的是**同一份** `createSplitMenuHandlers(tabsClient)`，于是"菜单多一项、少一项"
只需要改 ui-common 的模板与 apps 的动作表 —— **结构上不再有第二个可能漏接的地方**。

#### ② 建出的分屏"看不见"：活动格不在组里（`平铺成分屏` / `复原上次解散的分屏`）

布局层的显示判据是 **"活动标签属于哪个组"**（`TabManager#_syncActiveSplit`）——活动标签不在
组里就 `setActiveSplit(null)`（退出分屏）。而 `createSplitGroup` 建完只做
`_syncActiveSplit(getActiveTabId())`：**活动标签在组外时，等于刚建完就立刻退出分屏**，
屏幕上一动不动，只有标签条上多了一枚回形针。命中两个入口：

| 入口                                               | 为什么活动标签常在组外                       |
| -------------------------------------------------- | -------------------------------------------- |
| 芯片菜单「平铺成分屏」（标签组 → 分屏，I4 的一支） | 它只报"这一组的孩子"，与"此刻在看哪一条"无关 |
| 标签菜单「复原上次解散的分屏」                     | 撤销记录里是**上一次**解散的那几个标签       |

**修法（单一收口）**：`TabManager#createSplitGroup` 成功后交给新的
`_focusCreatedSplit(created)`：

- 活动标签本来就是成员 → `_syncActiveSplit(active)`（`Alt+点击标签分屏`、拖到网页分屏
  这两条既有入口行为**一字不变**）；
- 否则把活动格交给组自己声明的 `activeTabId`（拖拽式分屏声明的是"拖动前正在看的那一格"），
  它不可用再退到第一个仍存在的成员；
- 走 `switchTo` 而不是自己拼一套 —— 那是"让这个标签成为当前页"的**唯一**路径
  （顺带唤醒休眠成员、给旧标签采帧、通知可见性、发一次事件），不新增第二条显示路径。

> 规则口径：**建分屏 = 把活动格给它**（Edge / Zen 同款：新建的分屏立刻在屏幕上）。
> 于是"创建成功"与"用户看得见"是同一件事，不会再出现"数据建好了、屏幕没反应"。

#### ③ 验证

- 新增的一条接线断言（临时用例，验完即删）直接跑**真实的** `createTabbarContextMenu`：
  `splitWithNext` / `dissolveSplit` / `toggleSplitLayout` 都能调到 `splitMenu` 的接线，
  同时 `intent → call(name)` 那条既有路径（如 `back`）不受影响 —— 3/3 通过。
- `eslint`（无输出）、`check:layers` 0、`check:z-index` 0、`check:methods` 0 全绿；
  `verify:split` **143/143**；`vitest` 700 通过 / 7 失败，**7 条全部是既有的仓库红灯**
  （domain-password ×3、domain-permission、domain-settings、infra-extensions、
  ipc-channels 的 `buttonsEditZone` 撞车），与本次改动无关；`pnpm build` 通过。
- 刻意**没有**改的两条（避免自说自话改规则）：单成员标签组在**运行期**允许短暂存在
  （`sessionUtil.js` 明确写了"CRUD 期间允许，落盘时按 ≥2 收紧"）；分屏成员仍然**胜出**于
  标签栈（`detachSplitMembersFromStacks`，§10.10③）。
  **（2026-10-17 追记：后一条已废除 —— 分屏 × 栈改为正交共存，见 §10.10③ 的现行口径。）**

### 10.16 「收拢为标签组后彻底崩坏」——退出分屏那一步漏了两件事（2026-10，用户实测反馈）

用户原话：**"就是收起为标签组堆栈后，没法正常切换焦点，焦点的蓝色框消失，切换焦点会卡为
正常全屏视图，导致彻底崩坏"**。这是 §10.15 之外的**第三个**独立缺陷，而且是最严重的一个。

复现：建分屏（A | B）→ 点击「收拢为标签组」→ 屏幕立刻不可用。

`dissolveSplit` 之后走的是 **`_syncActiveSplit(活动标签)` → `setActiveSplit(null)` → `applyInitialLayout()`**。
这条退出路径只买了"分隔条与淡蓝框收起"（末尾 `_pushSplitGeometry` 以 `{active:false}` 下发，
所以用户看到**框消失**），却漏了两件与原生视图有关的事 —— 两件缺一不可，合起来就是"崩坏"：

| #   | 漏掉的事                                                                                                                                                     | 用户看到什么                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | **非活动格的 view 没收起来**。`applyInitialLayout` 的单视图分支只把活动格铺满，它不知道屏幕上还挂着谁；"收起来"是**集合差**的事，只在 `showTab` 那条路里做过 | 被解散的那一格**留在原来的半屏矩形里继续可见**，盖在新页面之上。它已不属于任何活动分屏 → 点它不会切标签（`tabEvents` 的「点哪格切哪格」要求它在活动组里）→ **焦点切不动** |
| ②   | **单视图几何去重缓存没作废**。`_tabBounds / _tabBoundView` 记的是"单视图几何"，而格矩形由 `_placeSplitPanes` 直接落、**不经过它**                            | 缓存仍停在"进分屏之前那一份"，与新的满屏矩形**恰好相等** → 单视图分支判定"没变化"而**跳过 setBounds** → 活动格**卡在半屏矩形**里不动                                      |

于是屏幕停在"看起来还是分屏、但框没了、点哪都不动"的状态；此时再点一次标签条，`showTab`
顺手把几何与集合都收干净 → 画面变成"正常全屏视图"——这就是用户说的
**"切换焦点会卡为正常全屏视图"**。

**修法（单一收口，一条路径管到底）**：`LayoutCoordinator#setActiveSplit` 在**真的从分屏退出**时
调一次新的 `_exitSplitToSingleView()`：

```
setActiveSplit(split)
  wasSplit = 当前确实有活动分屏（≥2 成员）        ← 判据是"真的发生退出"，不是"参数是 null"
  if (退出) { _activeSplit = null; _lastSplitSolved = null; if (wasSplit) _exitSplitToSingleView() }
  applyInitialLayout()                            ← 由它把活动格铺满（这时缓存已作废，必然重排）

_exitSplitToSingleView()
  ① this._tabBounds = null; this._tabBoundView = null          // 作废去重缓存
  ② _setVisibleTabs([活动标签], 活动标签)                        // 复用集合差那条唯一实现
     （活动格没有视图时退化为"把别的格全收起来"，绝不留残影）
```

三条刻意的取舍：

- **只在"真的发生退出"时收**：普通切标签也会走 `setActiveSplit(null)`（`_showTab` → 本方法），
  那种情况下收格子是白做（`showTab` 紧接着自己会收），不该多加一次原生可见性往返 ——
  所以判据是 `wasSplit`，不是"参数为 null"。
- **缓存的作废口径与 `showTab` 进/出分屏那一对重置逐字一致**（`_tabBounds/_tabBoundView = null`
  → 走 `resetLastAppliedBounds()` + `setBoundsImmediate`），不新增第二套"立即落位"的说法。
- **不放进 `applyInitialLayout`**：那里是全量布局的收敛点（窗口 resize / 面板开关都走），
  每次都比对一轮 `setVisible` 是纯浪费 —— 退出是**一次性事件**，就该只在事件那一点处理。
  单视图分支的注释已改成指向 `_exitSplitToSingleView`，免得后人在热路径上再补一遍。

> 这条同时修掉了**所有**退出分屏的路径（菜单「解散分屏」、hover 工具条的 ✕、关掉一格、
> 切到组外标签后再切回），不只是「收拢为标签组」——后者只是最容易撞上②（`_tabBounds` 还没被
> `showTab` 重置过）的那一条：建完分屏直接收拢，正好命中"缓存与满屏矩形相等"。

#### 验证

`eslint`（无输出）、`check:methods` 0、`check:layers` 0、`verify:split` **143/143**、
`pnpm build` 通过。`LayoutCoordinator` 的这条路径要真起 Electron 才验得到，故未加自动化用例
（与既有 `tests/ui` 的定位一致：几何/规则在纯函数层验，原生视图收放靠手动冒烟）。

### 10.17 「解散标签组」无效 —— 同一族缺陷的**第三处**（2026-10，用户实测反馈）

用户原话：**"解散标签组菜单项 无效"**。

`chipMenu.js#runStackMenuAction` 读的是 `handlers.stackMenu.dissolveStack`（整包，见 §10.10 的
"四项动作共用一份"），而横向标签条**芯片**的端口转发 `stackRecord.js` 还在逐项转发**旧名字**：

```
renderer.js#stackPortsFor   { onToggle, onRename, stackMenu, showMenu, getSiblings }   ✅ 整包在
stackRecord.js              createTabStack(…, { onToggle, onRename,                       ✗ 丢了
                                                 onSetColor, onMerge, onSplit, onTile, … })
TabStack.js                 runStackMenuAction(action, state, handlers.stackMenu || {})  → 恒为空对象
```

那四个旧键（`onSetColor / onMerge / onSplit / onTile`）是芯片改用整包**之前**的遗留，
芯片现在一个都不读 —— 于是四种动作（解散 / 平铺成分屏 / 合并 / 配色）在横向芯片上**全都接不到**，
用户最先撞上的是「解散标签组」。纵向组行一直是对的（`tabListHost.ts` 直接注入整包）。

**修法**：`stackRecord.js` 改为 `stackMenu: ports.stackMenu` 整包直通，并**删掉四个死端口**
（没有任何消费方 —— 按"死代码及时清除"）。

> **这一族的共同形状**（已在三处出现，值得记牢）：菜单项的**可见性判据只读数据**（所以项一定画得
> 出来），而**动作走另一套名字查找**（`handlers.*`）—— 两者对不上时，表现永远一样：
> **菜单项在、点下去没反应**，且没有任何报错。三次分别是 §10.13①（整包只进了 `intent` 那道转手）、
> §10.15①（`handlers` 是写死的对象字面量、没摊整包）、本节（端口转发还在用旧名字）。
> 结论不变：**动作一律整包直送 handlers，中间不许有第二道名字映射。**

#### 验证

用 vitest 把"造 DOM"那一层换成探针（`vi.mock`），直接跑**真实的** `createStackRecord` +
真实的 `runStackMenuAction`：`dissolveStack / tileStack / merge:s2 / stackColorBlue` 四种动作
都能命中整包里的接线 —— 2/2 通过（临时用例，验完即删）。
`eslint`（无输出）、`check:methods` 0、`check:layers` 0、`pnpm build` 通过。

### 10.18 工具条四改：✕ 语义、方向键哑、去掉收拢、手柄图标空白（2026-10，用户实测反馈）

用户原话：**"分屏 hover 工具条中点关闭，为什么变成全部退出分屏了？不应该是关闭那个分屏然后回到
前一个视图吗？是只有只剩一个视图的时候才退出啊；上下左右方向按钮没反应没用；去掉收拢为标签组
按钮；拖拽按钮图标不显示"**。四条各自独立，全部落地。**本节取代 §10.14① 的按钮表**。

#### ① ✕ 改为「关闭这一格」（不再解散整片分屏）

按 Edge / Zen 的口径：**✕ 只关掉指针所在那一格的标签**；组里还剩 ≥2 格就继续分屏（自动重排），
只剩 1 格时自然退出、那一个标签铺满。原先 `dissolve`（解散整组）与它不是一件事 ——
混成一个按钮就会出现"只想关掉一格、结果整片没了"。

| 环       | 落点                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 按钮     | `ui-split-toolbar#BUTTONS`：`{ id:'close', icon:X, action:'close-pane', danger:true }`（`dissolve` 那一枚删除）                            |
| 白名单   | `main/split-toolbar.js#TOOLBAR_ACTIONS` = `toggle-layout / reverse / close-pane`（**去掉 dissolve 与 collapse**）                          |
| 命令载荷 | 控制器按 hover 到的 `lastPaneIndex` 补上**那一格的 tabId**（浮层只报格下标）→ `runAction(action, { splitId, tabId, memberIndex })`         |
| 执行     | `browser-window-runtime#runAction`：`close-pane` → `tabManager.close(info.tabId)`（其余两项仍映射到 `toggleSplitLayout` / `reverseSplit`） |

关闭后的收尾全在 `TabManager` 里，**两条新规则**：

1. **接替格钉在同组内**（`_splitSuccessorAfterClose`）：`close` 的既有规则是"左邻优先"，
   但分屏成员的左邻可能是**组外标签** —— `_showTab(组外标签)` 会经 `_syncActiveSplit` 判定
   "活动标签不属于任何组"而把整片分屏收掉。取"顶上被关那一格位置"的那一枚（越界取最后一枚），
   与视觉上滑进那个空位的格子是同一个。
2. **关掉非活动格时补一次同步**：那条路既不切标签、也没人重排，而布局层手里的 `members`
   已经少了一格 —— 不补 `_syncActiveSplit(活动格)` 就会留下"那一格的矩形还在界面上"。
   2 格关 1 格时组散 → `setActiveSplit(null)` → 走 §10.16 的退出路径（收格子 + 作废缓存）。

#### ② 「切换方向」点了没反应：`listSplits()` 的形状读错

`TabManager#toggleSplitLayout` 写的是 `const res = this.listSplits()` 然后 `res.splits.find(...)` ——
但 `listSplits()` 返回的是**数组**（只有 IPC 那条路才包成 `{ splits, canRestoreSplit }`，
见 `ipc/tabs.js`）。于是 `res.splits` 恒为 `undefined` → 找不到组 → **静默返回 null**。
修法：直接 `this.listSplits().find(...)`。同一族"同名两形状"缺陷（IPC 面包屑 vs 领域数组）。

#### ③ 去掉「收拢为标签组」按钮

`collapse` 从按钮表、白名单、`runAction` 映射三处一并删除（死代码及时清除）。
`TOOLBAR_BUTTON_COUNT` 4 → `TOOLBAR_SIZE.width = 30×4 + 8×3 + 12 = 156`，
与 ui 包 CSS（gap 8 / padding 0 6px / 按钮 30）逐项对齐。
**能力本身没丢**：仍是标签右键菜单里的「收拢为标签组」/ 芯片菜单的「平铺成分屏」（I4 的一对）。

#### ④ 拖拽手柄图标空白：`strokeWidth: 0` + `fill: none` = 什么都不画

`icons.js#GripVertical` 曾经写成 `createSvg(doc, '<circle r="1">×6', { strokeWidth: 0, ...o })`
—— 想画"实心点"却没给 `fill`，而 `createSvg` 固定 `fill="none"`：描边被归零、填充又是 none，
**六个点一个都不画**，按钮整个空白。修法：去掉 `strokeWidth: 0`，回到 Lucide 原样
（`fill="none"` 下靠描边把 r=1 的小圆画成实心点），并在原处留一行"别再动这一行"的告警注释。

#### 验证

无头 vitest（`createRequire` 起真实 `TabManager` + 真实 domain `tabSplits`，假布局层记账）：

- 切换方向：2 格 `row → column` 真的落到 `_splits` 与布局层（修掉②之前这条恒为 null）；
- 关掉 3 格里的**非活动**格：组剩 `[a,b]`、活动格不变、末次灌给布局层的成员就是这两枚；
- 关掉 2 格里的**活动**格：组解散、接替的是同组那一个、末次灌入 `null`（退出分屏）；
- 关掉 3 格里的**活动**格（左邻是组外标签 `x`）：接替格是 `b` 而**不是** `x`、组剩 `[b,c]`。

4/4 通过（临时用例，验完即删）。`eslint`、`check:methods` 0、`check:layers` 0、
`check:z-index` 0、`verify:split` 143/143、`pnpm build` 通过；产物里
`TOOLBAR_ACTIONS = ['toggle-layout','reverse','close-pane']`、按钮表 4 枚均已确认。

### 10.19 横向分屏标签改为 Edge 式「合体」（2026-10，用户实测反馈）

用户原话：**"大改分屏的标签的样式，改为类似 edge 的，两个标签连在一起，都缩小形成一个标签的宽度，
之间没有缝隙或者圆角，是合体的，然后去掉原有的下划线"**。

#### ① 形态定义（一条标签宽 = 两半）

| 项     | 规则                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| 总宽   | 一整段合体 = 一条普通标签 × `--ng-tab-split-scale`（**1.45**）：两半各 `calc(var(--ng-tab-width) * 1.45 / 2)`。1.0 时半宽标题只剩一个字符，1.25 仍被用户判为"太挤"—— 1.45 是"两半都读得清、整段又明显比两条普通标签窄"的取值 |
| 压缩   | `min/max` 同乘该系数，`flex-shrink` 与普通标签同一条曲线（槽位算 1，见 ②）            |
| 圆角   | 段内全 `border-radius: 0`；只有**首成员**给左两角、**末成员**给右两角（标签圆角 token） |
| 接缝   | 非首成员 `margin-left: calc(-1 * var(--ng-tab-gap-x, 2px))` + `border-left-width: 0` |
| 选中   | 合体段**不再**套 `--ng-tab-active-width`（否则整段会被撑宽、两半不齐）              |
| 下划线 | 段内标签的 `::after` 全部 `display: none`（分隔竖线 + favicon 色条一并消失）        |
| 连接带 | 横向 `splitBandLayer` **整体删除** —— 合体之后接缝本身就是分屏语义，不需要额外下划线 |

CSS 全部落在 `ui/ui-tabbar/src/styles.js` 一段 `#tabs-inner > .tab-item.in-split-run …` 里，
**不新增绘制层**：合体是标签自身外形，必须跟着 180ms 宽度动画逐帧走，挂在外面的图层做不到。

#### ② 三个类名 = 唯一写入口（判据复用 `splitLink`）

`renderer.js` 新增纯函数 `splitRunRoles(items)`，直接吃 `splitMarks(items, keyOf).runs`，
产出 `key → 'first' | 'last' | 'middle'`，在增量渲染的同一处写：

```js
rec.node.classList.toggle('in-split-run', role != null)
rec.node.classList.toggle('split-run-first', role === 'first')
rec.node.classList.toggle('split-run-last', role === 'last')
```

判据仍然只有 `ui-common/src/tab/splitLink.ts` 一处 —— 合体、回形针、相邻不变式三者同源。

#### ③ `tabSizing` 从「标签数」改成「槽位数」

合体段在排版上只占 **1 个槽位**，但宽度按「普通档 × `--ng-tab-split-scale`」折算（与 CSS 同系数）。
`survey()` / `applyFor()` 都跳过 `in-split-run` 的非首成员：
基准宽、下限、活动标签（`active = !merged && …`）、`gapCount = slots + chipCount - 1` 全部按槽位算。
不改这一处会凭空多算一条标签，`k` 被算小、间距提前收窄，两半还没缩就被压扁。

#### ④ 两个容易踩的顺序坑

1. **合体规则必须排在 `#tabs-inner > .tab-item.is-tab-closing` 之前**：两者特异度相同
   `(1,2,0)`，排在后面会把关闭态的 `width: 0` 覆盖掉，关闭动画直接卡住。
   所以插在 `.tab-item.has-audio.active` 之后、`@keyframes ng-tab-enter` 之前。
2. **负 margin 必须引同一个 gap 变量**（`var(--ng-tab-gap-x)`）：密度压缩会把 2px 压到 0，
   写死 `-2px` 会在压缩态把两半推开/拉叠。

#### ⑤ 连带清理

- `ui-tabbar/src/view/splitBandLayer.js` 删除，`index.js` 的装配、`renderer` 的 ctx 端口同步摘除；
- `styles.js` 的 `.tab-split-bands` 规则与 `injectSplitBandStyles` 调用删除；
- `splitBandLayer` 下线后 `stackLineLayer.js` 里的 `hasSplit` / `bandH` / `SPLIT_BAND_THICKNESS`
  变成死代码，一并清除 —— **凹槽现在归组下划线独享**。

#### ⑥ 纵向 / panel 也是合体（2026-10-20，用户实测反馈）

用户原话：**"两个和起来的长度，其实可以放宽一点的不用这么挤；；垂直、panel也是，去掉指示条，
改为和现在tabbar一样的两个标签并排合体，只不过垂直就是两个合起来的宽度按正常宽度来啦"**。

| 项     | 规则                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 形态   | 与横向**同构**：一段连续分屏链 = 并排贴在一起的行，内缘无圆角无边框、外缘收 8px 圆角     |
| 总宽   | 一整段 = **一条正常行宽**（不乘 `--ng-tab-split-scale`）；段内 N 等分（`flex: 1 1 0`）    |
| 行高   | 不变（`align-items: stretch`，同一段的行自然等高）                                       |
| 接缝   | 内缘 `border-*-width: 0` + 圆角归零，无缝隙、无分隔线                                    |
| 回形针 | 挂在**合体容器**上，落在接缝 `k / N` 正中（N 员 → N-1 枚），`pointer-events: none`        |
| 指示条 | 旧的 `[data-split-member]::before` 竖线（行左/右缘的连接带）**整族删除**；`tab/splitBand.js` 整文件删除 |

**为什么必须有容器 `.tabrow-pair`**：`tabrow-wrap` 是纵向列，底部「新建标签页」靠
`margin-top: auto` 吸底 + `position: sticky` 钉在滚动容器底 —— 改成 `flex-wrap` / grid
就会同时失去这两件。于是"一段合体"收成 wrap 的**一个直接子节点**（一个排版槽位），
成员行并排塞进容器：顺序、FLIP、插入锚点都按槽根（容器或单行）算，行仍是增量复用与动效的单位。

**回形针为什么搬出所在行**：`.tabrow-row` 带 `contain: layout style paint`，钉在行内、
跨两行边界的绝对定位子元素会被裁掉一半（旧实现因此要给前一行抬 `--split-head`）。
容器没有裁剪 → 挂在容器接缝正中即可，抬层那套整体删除。

**槽位模型**：`buildSlots(list, splitMarks(...).runs)` 把连续 run 成员合成一槽，其余每项各一槽。
就位两段式：先把成员塞进各自容器，再把槽根按目标顺序摆进 wrap（单行槽会顺带把行从容器里搬回来，
于是"解散分屏"零特判）。容器按链头复用键标识，成员换了不重建；空容器由 `removeRow` / `prunePairs` 回收。

**判据依旧只有一处**：横向合体与纵向合体读的都是 `splitMarks(...).runs`；
回形针读 `pairs`。`splitLink.js` 不再导出无人使用的 `splitLinkRuns` / `splitMemberKeys`，
`splitMarks` 也不再产出 `memberKeys` / `headTabIds`（死视图一并删除）。
