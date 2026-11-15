# 拖标签到网页 → 落位预览块（Zen / Vivaldi 对照 + NG 适配）

> **落地状态（2026-10-17）：✅ 已完成**。实现：`apps/app-main/src/main/tab-drop-zone.js`（宿主）、
> `apps/app-main/src/renderer/dropzone-overlay/main.js`（预览浮层）、`browser-window-runtime.js`
> （`onPreviewShown/onPreviewHidden` 接 D7 切换 + `isOverOverlay` except 扩为
> `['dropzone-overlay', 'split-toolbar']`，治 30fps 自激闪烁）。验证：`scripts/verify-split.cjs` 第 ⑥ 组。

> 需求原话：**"学习 Zen、Vivaldi，实现拖动标签到网页这一块时有预览位置块，就是能决定拖动到不同区域
> 是上下排序还是左右排序，要在左边还是右边还是上面还是下面。"**
>
> 本文是**落地前的对照文档**：先拆两家怎么做，再定 NG 的分层与唯一真源，最后照着实现。

---

## 0. 一句话结论

两家都是「**拖动期间就把结果画出来**」：指针在内容区移动时，一个**半透明预览块**实时贴到
"新标签将要占用的那一半"上；松手 = 预览原样成立。方向由**指针在内容区里的相对位置**决定
（左右半边 / 上下半边），左右 → 横向并列，上下 → 纵向堆叠。

NG 的特殊约束只有一条：**网页是原生 `WebContentsView`，外壳（chrome）在它之下** ——
所以这个预览块**不能**用外壳 DOM 画（会被网页盖住），必须是一个**独立浮层视图**。
好消息是这套机制本项目已经有三份现成先例（查找栏 / 悬停 URL / 缩放条），照抄即可。

---

## 1. 逐家拆解

### 1.1 Zen（Firefox 系）

| 维度     | 做法                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 拖拽来源 | Firefox 原生 tab DnD（`tabContainer` 的 `dragstart/dragover/drop/dragend`）   |
| 预览宿主 | **浏览器 UI 层**的覆盖元素（chrome 文档里的一个 `xul:box`），不是网页里的 DOM |
| 方向判定 | 指针相对**内容区矩形**的位置：偏左/右 → 横向分屏，偏上/下 → 纵向分屏          |
| 预览形态 | 半透明强调色块，**只覆盖即将被新格占用的那半**（不是整片内容区）              |
| 松手     | 把两个标签并排：新格按方向落在左/右/上/下；两格之间生成分隔条                 |
| 无配对   | 只有一个标签时不出现预览（没有"另一格"可分）                                  |

**为什么 Zen 能把预览画在网页上**：Firefox 的页面与浏览器 UI 在**同一个合成器**里，
UI 层（`#browser` 之上的 XUL overlay）天然压得住 `browser` 元素。NG 没有这个前提。

### 1.2 Vivaldi（Chromium 系）

| 维度     | 做法                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| 形态     | Tab Tiling（平铺）+ 拖动落点覆盖层                                             |
| 预览宿主 | UI 层的覆盖块（`#tab-drag-overlay` 一族的元素），同样**不在网页里**            |
| 落点分区 | 明显分区：左 / 右 / 上 / 下（多格平铺时还有中央格）；指针进哪个区 → 那个区高亮 |
| 分区判据 | 指针落在**哪个区块的矩形**内（分区是显式的矩形集合，不是"算出来的方向"）       |
| 松手     | 按命中区执行平铺（左右 = 竖切，上下 = 横切；中央 = 网格）                      |
| 反馈粒度 | 每进一个区**立即**换高亮块；离开内容区 → 预览消失                              |

**与 Zen 的差别**：Vivaldi 把"分区"当作**显式数据**（一张区表），Zen 当作**算出来的方向**。
两者结果等价；显式区表更好扩展（将来要加"中央网格"只需往表里加一项）。

### 1.3 两家的共同点（这才是要学的东西）

| #      | 不变式                  | 说明                                                                        |
| ------ | ----------------------- | --------------------------------------------------------------------------- |
| **D1** | **预览先于松手**        | 拖动期间就给反馈。只有"松手那一刻才算"的实现等于**盲拖**（NG 现状正是如此） |
| **D2** | **预览块 = 新格那一块** | 不是整片内容区、也不是一个方向箭头 —— 直接画出"新标签会占哪里"              |
| **D3** | **所见即所得**          | 松手结果与预览**逐像素一致**；不一致比没有预览更糟                          |
| **D4** | **方向 → 布局是固定的** | 左/右 → 横向并列（row）；上/下 → 纵向堆叠（column）                         |
| **D5** | **无配对就不给预览**    | 只有一个标签时分屏无从谈起，此时**不要**画任何块（画了就是骗人）            |
| **D6** | **离开内容区即收**      | 指针回到标签条 / 窗口外 → 预览立刻消失，不留残影                            |
| **D7** | **框画在谁身上就显示谁** | 框画着 = 内容区显示**配对那一格**（不是被拖的那一格）。拖动一开始活动标签就被切成被拖的那个（Edge / Chrome 同口径），若不做这一条，用户对着网页拖时看到的是**被拖的页面**，而框说的是"和另一格分屏" —— 那一块预览就只剩一个半透明色块可看，看不出自己在跟哪一页配对。见 §3.5 |

---

## 2. NG 现状与差距（全部为实测代码事实）

| 环节     | 现状                                                                                                                | 差距                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 触发     | `tabRecord.js` / `tabRowList.ts` 的 `dragstart/dragend` → `tabs-client#dropTabOnContent` → `tab:drag-drop-content`  | 只在 **dragend** 报一次，拖动期间**零反馈**（D1 缺失）   |
| 落点判定 | `TabManager#dropTabOnContent` 读 `screen.getCursorScreenPoint()` − `win.getContentBounds()`，判断是否落在网页矩形内 | 只回答"在不在网页上"，**不回答"在哪一边"**（D2/D4 缺失） |
| 布局     | 固定取设置里的 `split.default_layout`                                                                               | 无法按落点决定左右/上下（D4 缺失）                       |
| 成员顺序 | 固定 `[pair, drag]`                                                                                                 | 无法决定新格在左还是右（D2 缺失）                        |
| 预览     | 无                                                                                                                  | 需要一个**独立浮层视图**（外壳 DOM 盖不住网页）          |
| 配对     | `baseTabId`（拖动前在看的）→ 兜底 `adjacentTabIdOf`                                                                 | **可复用**，不用改                                       |

**可复用的既有件（不需要新造）**：

| 件                                                                           | 用途                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| `LayerStack` 的 `FLOAT_NAMES` + `Z_INDEX` / `FOCUS_PRIORITY` 表              | 加一行即获得一条完整的浮层图层                       |
| `CursorEdgeMonitor#onTick`                                                   | **30fps** 光标采样，拖动期间才有定时器（空闲 0 CPU） |
| `LayoutCoordinator#setFloatBounds / noteFloatShow / hideFloat / sendToFloat` | 浮层的落位、可见性、消息下发                         |
| `LayoutCoordinator#getContentBounds()` / `getWindow()`                       | 网页矩形与窗口内容区（只有主进程知道）               |
| `shared-types#SPLIT_METRICS.paneGap`                                         | 预览块与最终格子之间的那道缝，同一个常量             |
| `TabManager#adjacentTabIdOf`                                                 | 配对兜底规则（与 `Ctrl+Shift+D` 同一条）             |

---

## 3. 目标架构（四层，各管一件事）

```
① 纯规则   shared-types/src/split-layout.mjs#resolveDropZone({ x, y, rect, gap })
           → { zone, layout, place, rect }        零 IO、可 headless 验证

② 主进程   apps/app-main/src/main/tab-drop-zone.js#createTabDropZone(deps)
           拖动期间 30fps 采样 → 调 ① → 推浮层；不认识 electron、不碰 DOM

③ 浮层     apps/app-main/src/renderer/dropzone-overlay/（宿主渲染页）
           ui/ui-drop-zone/（只画：半透明块 + 方向箭头 + 文案）

④ 提交     TabManager#dropTabOnContent({ tabId, baseTabId, zone })   ← 唯一决策点
           预览与提交**同源**（都用 ① 给出的 zone），因此 D3「所见即所得」是结构保证
```

### 3.1 ① 纯规则：落点 → 分屏意图

判据用**归一化距离**（除以内容区宽/高），而不是绝对像素：
宽窗口下"离左边 300px"与"离上边 300px"的视觉权重完全不同，只有占比才**与窗口形状无关**。

```
fLeft   = (x - rect.x) / rect.width
fRight  = (rect.x + rect.width - x) / rect.width
fTop    = (y - rect.y) / rect.height
fBottom = (rect.y + rect.height - y) / rect.height
zone = argmin(fLeft, fRight, fTop, fBottom)
```

- `left` / `top` → 新格在**前**（`place='start'`，成员顺序 `[drag, pair]`）
- `right` / `bottom` → 新格在**后**（`place='end'`，成员顺序 `[pair, drag]`）
- `layout`：`left|right → 'row'`，`top|bottom → 'column'`

**没有"中央死区"**：任意落点都归最近的边。理由 —— D1/D2 要求"拖动期间一直有反馈"，
若中央什么都不显示，用户会以为功能坏了（Zen 也是全区域响应）。

### 3.2 ② 主进程控制器：拖动期间的一条采样回路

```
begin({ tabId, baseTabId })  ← 渲染层 dragstart
   ├─ 启动 30fps 采样（复用 CursorEdgeMonitor#onTick）
   └─ 每个 tick：
        page = getPageRect()                       ← 只有主进程知道
        local = cursor − 内容区屏幕原点
        不在 page 内            → hideOverlay()，intent = null        （D6）
        在 page 内：
          pair = base 或 adjacentTabIdOf(drag)     ← 复用既有规则
          没有 pair → hideOverlay()，intent = null                     （D5）
          mode = pair 已在分屏里 ? 'join' : 'split'
          ① resolveDropZone(local, page, gap) → zone/layout/place/rect
          落位矩形变了才 setFloatBounds（省掉无意义的原生调用）
          zone / mode 变了才推 payload 给浮层（拖动期最低开销）
end()   ← 渲染层 dragend
   ├─ 停表、收起浮层
   └─ 返回最后一次 intent（= 用户看到的那个），交给 ④ 提交
```

**为什么 intent 由主进程记着、而不是 dragend 再算一次**：D3。再算一次是**第二次判定**，
中间任何一次采样抖动都会让"松手的结果"与"刚才看到的预览"不一致。

### 3.3 ③ 浮层：`dropzone-overlay`

- 图层：`FLOAT_NAMES` 加一行；`Z_INDEX` 取 36（高于 rail / 侧栏浮出 / 悬停预览卡；
  地址栏下拉 40 仍在其上）；`FOCUS_PRIORITY` = **0**（拖动中绝不能抢键盘焦点）。
- **不吃鼠标**：`interactive:false` → `setIgnoreMouseEvents(true, {forward:true})`。
  拖动中的落点判定在**源窗口**（`dragend` 一定回到源元素），浮层只需被看见。
- 视图 bounds **就是**预览块矩形（不是整片内容区）：既不白合成一大块透明层，
  也让"这一格"的语义由几何本身表达 —— 渲染页只需填满自己的视口。
- 三种形态（都由 payload 的 `mode` 决定）：
  | mode      | 视觉                             | 文案                            |
  | --------- | -------------------------------- | ------------------------------- |
  | `split`   | 强调色半透明块 + 边框 + 方向箭头 | 在左侧 / 右侧 / 上方 / 下方分屏 |
  | `join`    | 同色系、无方向箭头               | 加入分屏（第 N 格）             |
  | `blocked` | 中性灰 + 斜线                    | 分屏已满（最多 N 格）           |

### 3.4 ④ 唯一提交点

`TabManager#dropTabOnContent({ tabId, baseTabId, zone })`：

- `zone` 有值 → `layout` 与成员顺序由 zone 决定（覆盖设置里的默认方向）；
- **`zone` 为空 → 一律不分屏**（`reason: 'no-preview'`）。口径（用户定，2026-10）：
  "**不是拖过来就分屏，是等落位框显示才能开始判定，他们是一起的**" —— 落位框是唯一判据
  （含 250ms 停留门禁与"不在浮层里"两条），用户没看到框就说明这一下**不算数**。
  ⚠ 曾经这里有一条"松手时再读一次光标"的**降级路径**，已删除：它正是"只把标签拖过去
  松了个手，却凭空分屏"的来源，而且与预览用的是两套时刻的坐标（松手那一瞬 vs 最后一拍），
  "预览还在、松手却没反应"也由它而来。**所见即所得**从此是真的同一条数据。
- 落点那格已在分屏里 → **加入**那一组（不重建，见 §10.10③）。

### 3.5 内容区跟着框走（D7）

落位框一画出来，就把**活动标签**切到配对那一格 —— 用户于是在**真实的配对页面**上判断
左右上下，而不是在一块盖住被拖页面的色块上猜。

| 时机 | 动作 | 谁做 |
| --- | --- | --- |
| 框画出来（`present()` 里首次 `showOverlay` 之后） | `switchTo(pairId)` | 宿主（`browser-window-runtime` 的 `onPreviewShown`） |
| 框收起（拖开 / 判不出落点） | `switchTo(tabId)` —— 回到被拖的那一格 | 同上，`onPreviewHidden` |
| 整场结束（`end()` / `cancel()` 的静默路） | **什么都不做** | 松手之后归谁由 ④ 提交侧决定（`dropTabOnContent` 建的组以 `pair` 为活动格），多通报一次会在同一拍里白切两趟 |

两条判据为什么这样切：

- **切 `pairId` 而不是 `baseTabId`**：拖**当前活动的那一个**标签（最常见的动作）时，
  `baseTabId` 会是空的（渲染层读 DOM 得空 / 它自己就是被拖的那个），配对对象退到
  `adjacentTabIdOf` —— 而框正是画在那一格上的。"框画在谁身上就显示谁"这一条判据
  在两种情形下都成立（拖后台标签时 `pairId` 就等于拖前那一格）。
- **边沿触发**：拖动期间每秒 30 拍，`present()` 会被反复调用；只有**翻转**那一拍才通报，
  宿主那侧天然是"切一次、切回来一次"（见 `main/tab-drop-zone.js` 的 `previewNotified`）。
- **由宿主切、不由控制器切**：`tab-drop-zone.js` 不认识标签世界，它只把
  `{ tabId, baseTabId, pairId }` 交出去（与 `describePair` 同一条解耦口径）。

**踩过的坑（D7 上线后立刻暴露）**：拖第 3、4 个标签进**已有分屏**时，在别的格上会**闪个不停**。

机制是一条 **30fps 自激闭环**，两半都是 D7 自己造出来的：

```
预览显 → switchTo(pair) → 切进分屏 → 分屏工具条出现（贴在被 hover 的那格角上）
       → 光标正压在那条工具条上 → isOverOverlay 判"在浮层里" → 预览收起
       → switchTo(tabId) → 切出分屏 → 工具条消失 → 预览又能显 → ……
```

关键在于**两半都是真切换**（活动标签在两格之间来回），所以每次翻转都会再触发一次
`tab:changed → splitToolbar.sync()`，闭环自我维持。**根因不是 D7，而是"落点判据里混进了
一个可见性由布局决定的浮层"**：`isOverOverlay` 本来只该排除"与布局无关、压在网页上的外来浮层"
（rail 收起态的标签列浮层）。分屏工具条属于**分屏自己**（144×30、贴在某一格的角上），
它的显隐本来就跟"有没有活动分屏"走 —— 把它算进落点判据，就等于让落点判据依赖自己的副作用。

修法：`isOverOverlay` 的 `except` 从 `'dropzone-overlay'` 扩到
`['dropzone-overlay', 'split-toolbar']`（见 `browser-window-runtime` 那段注释）。
⚠ 往这条 `except` 里加任何浮层之前，先问一句：**它的可见性会不会被 D7 那次切换改变？**
会 → 必然自激。

### 3.5b 拖动期间冻结侧栏唤出（不误触分屏 / 不黏住）

拖动标签时**指针必然离开侧栏保持圈**（从 Edge 型悬停浮层里把标签拖到网页上）。侧栏巡看
（`LayoutCoordinator#_tickSideReveal`）本来只认"指针在不在圈内"，照常跑就会在拖动中途
把**拖拽源视图**收成 0×0 / 压回静止宽，后果是一对孪生故障：

| 现象 | 机制 |
| --- | --- |
| **分屏黏住** | 视图在被拖动时改变尺寸/消失 → 系统取消原生拖拽 → 渲染层 `dragend` 丢失 → `tab-drop-zone` 采样表与落位框永久残留；活动标签还停在 D7 切过去的 `pairId` 上 |
| **误触分屏** | 侧栏一收，指针就"落"在网页上 → 不在浮层里（`isPointOverFloat` 已无对象可命中）→ 250ms 停留门禁一过浮出预览 → 松手真空分屏 |

唯一修法：**整场拖动期间冻结唤出**，且只有一条实现 ——

- `tab-drop-zone.js` 的 `onSessionChange(active)` 通报"手还按着没按着"（边沿触发，与
  `onPreviewShown/Hidden` 的"框画着没画着"是两件事）；`begin()` 置真，`end() / cancel()`
  一律经 `cancelSession()` 置假。
- **整场拖动的收尾不能挂在"有没有落点"上**：`tab:drag-drop-content`（commit）只在"可能落在
  网页上"时才发，而最常见的拖动（在列表里排序 / 成组）根本不发 —— 会话与冻结会永远留着。
  故另有 `tab:drag-drop-cancel`（渲染层 `dragend` 一律收尾：有落点走 commit，没有走这条；
  列表内 `drop` 也立刻报一次，因为随后的重排可能让 `dragend` 不再冒泡到源容器）。
- 宿主把它接到 `LayoutCoordinator#setSideRevealHold(on)`：冻结期间 `_tickSideReveal` 直接返回
  （不展开、不收起、不记时），已落定的唤出态**原地不动**；`_syncSideRevealWatch` 的
  `!need` 分支也不强制收起。解冻时重跑一趟 `_syncSideRevealWatch()` 重新收敛。
- `sidebar-float` **不进** `isOverOverlay` 的 `except`：拖动中被冻住的那块浮层正是"压在网页上的
  外来层"，它的可见性与 D7 无关（不像 `split-toolbar` 会自激），必须照常排除。

**`dragend` 丢失的自愈**：`blur` → `cancel()` 盖不住全部情形（同应用内切窗口 / 拖拽源被系统
回收）。故 `tab-drop-zone` 另有一条纯时间判据：指针在窗口外持续 `DRAG_ABANDON_MS = 600ms`
→ 按兜底取消（正常通报：收起预览、切回被拖那一格、解除唤出冻结）。拖出去又回来不受影响。

### 3.6 光标：经过网页 / 浮层时仍然是「拖拽光标」

拖动标签的外壳（标签条）是 chrome 的 WebContents，而网页是**另一个** WebContentsView。
指针一进网页，HTML5 的 `dragover` 就由那一格网页接管；网页没写过 drop 处理 →
`dropEffect='none'` → Windows 画**禁止圈叉**。用户实测口径：

> "把标签拖动到网页中央，鼠标指针还是禁用状态样式……不应该是拖动的那种带小方框的鼠标样式吗？"

落位框浮出来以后更糟：浮层也是独立 WebContentsView（指针进它以后事件归它），
外壳那套 `preventDefault()` 完全够不着，于是**框一出现光标当场变禁止**。

修法与 `file-drop`（系统文件拖入）**同一条机制、同一个位置**：
`infra-window/preload/internal-drag/`，在 `tab-preload` / `shell-preload` / `panel-preload`
三处无条件引入。

- 判据只读 `dataTransfer.types`（`dragover` 阶段唯一可靠的东西）：带
  `application/x-hira-item`（统一拖拽协议）/ `application/x-ng-tab`（旧标签 MIME）
  → 认成我们自己的拖拽项。
- `dragenter` / `dragover`：`preventDefault()` + 在源端 `effectAllowed` 允许的集合里挑
  `dropEffect`（标签条是 `copyMove` → 取 `move`；只许 `copy` 的源必须取 `copy`，
  否则 Chromium 判成"不许放下"，光标依旧禁止）。
- 边界与 `file-drop` 一致：监听在 `window` **冒泡**阶段，只在
  `defaultPrevented === false` 时接管 —— 网页自带 drop zone（上传框 / 编辑器）保持绝对优先。
- `drop`：吃掉网页的默认动作。**落点语义不在这里** —— 仍是主进程按松手时的屏幕光标算，
  提交在拖拽源的 `dragend`（见 ③ / ④）。

这样三条路（网页 / 落位框 / 分屏工具条）的光标是同一套判据，不再各自决定"能不能放"。

---

## 4. 明确不做（记下来，免得后面被当成漏做）

1. **中央网格落点**（Vivaldi 的 2×2 平铺）—— 那是"多选平铺"的入口，与"拖一个标签"不同语义；
2. **把预览做成真实排版**（拖动期间真的把网页分成两半）—— 会让目标页在拖动中反复重排
   （视频/表单/滚动位置都会受影响），也把"未提交的状态"塞进布局层。预览只做**盖在上面的块**；
3. **跨窗口落点** —— 那是 `tab-drag-controller` 那条线（另一件事）。

---

## 5. 验证

- `scripts/verify-split.cjs` 新增第 ⑥ 组「拖放落点」：`resolveDropZone` 的四方向、
  归一化判据（同一相对位置在宽/窄窗口下结果一致）、`place`/`layout` 映射、
  越界返回 null、预览矩形与最终分屏第一格**同形**（D3 的纯函数级保证）。
- 门禁：`eslint` / `check:layers` / `check:z-index` / `check:methods` / `electron-vite build`。
