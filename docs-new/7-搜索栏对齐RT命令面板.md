# 7 · 搜索栏 → 命令面板：对齐 RT

> 口径：**命令面板 = 扩地址栏，不是新窗口**（`docs-new/4` :67/:71 已定；NG 曾删掉过独立命令面板，
> 全库 `commandPalette` 0 命中）。所以本方案**不新建面板**，把现有地址栏下拉补成真正的命令面板。

参考项目：`e:\Desktop\OTHER\1A-STAR_Hira\1A-STAR_Hira_RT`
权威口径：`RT/src/renderer/src/lib/omnibox-new/README.md`（新版；`docs/references/omnibox.md` 是**旧版**，勿照抄）

---

## 一、RT 的关键数值与做法（照抄目标）

### 1. 定位（**最要紧的差距**）
RT 的命令面板是独立透明窗口，**由主进程按点击时地址栏的 rect 落位**：

- `RT/src/renderer/src/components/browser-ui/browser-sidebar/_components/address-bar.tsx:38-49`
  点地址栏时上报 `{ x: rect.x, y: rect.y, width: rect.width * 1.8, height: rect.height * 8 }`；
- `RT/src/main/controllers/windows-controller/utils/browser/omnibox.ts:21-30`
  默认 `750 × 335`，四周再扩 `30px` 作为阴影留白；`normalizeBounds` 按窗口裁剪。

**NG 现状（错）**：`ui-searchbar#getDropdownRect` 算出的 `x/y` 是**死数据** ——
overlay 丢掉它、写死 `left/top = OVERLAY_PADDING`，主进程走 `centerFloat`
（`LayoutCoordinator.js:4773`）把下拉**在整窗口水平+垂直居中**。所以它不贴地址栏。

**改法**：渲染层量**锚点矩形**（地址栏，外壳 CSS px = 窗口 content px，1:1），
主进程新增一条锚定策略 `anchor-below`，与既有 `center` / `beside-panel` /
`below-topbar` / `in-content` 并列（`apps/app-main/src/main/ipc/layout.js:394-430` 就是这族）。

### 2. 外观（NG → RT）
| 指标 | NG 现值 | RT 目标 |
|---|---|---|
| 圆角 | 8px | **13px** |
| 阴影 | 单层 `0 8px 24px .2` | **四层堆叠**（见下） |
| 宽度 | `max(input, 560)`，水平居中 | **`input.width × 1.8`**，贴输入框左缘 |
| 最大高度 | 固定 320 | **按可用空间夹住**（RT 窗口高 335） |
| 列表内边距 | 0 | **8px**，行间距 4px |
| 行 | padding 8/12，圆角 0 | **padding 10/12，圆角 10px，gap 10px** |
| 主/次字号 | 13 / 11 | **14 / 12** |
| 图标 | emoji（🔍🌐📑🕘🧮⚡） | **真图标**（站点用 favicon，其余用 SVG） |
| 选中 / 悬停 | 仅选中 `accent-bg` | **选中 `black/8`、悬停 `black/4`**（深色底换白） |
| 滚动条 | 显示 | **隐藏但可滚**（`no-scrollbar`） |

RT 阴影（`components/omnibox/main.tsx:28-29` 常量逐字）：
```
0 10px 25px -10px rgba(0,0,0,.52), 0 6px 14px -8px rgba(0,0,0,.3),
0 2px 6px rgba(0,0,0,.16), 0 1px 0 rgba(255,255,255,.08)
```

### 3. 数据源（RT 的十类与分值）
| 类别 | 触发 | 上限 | 分值 |
|---|---|---|---|
| verbatim（URL / 默认引擎搜索） | 非空 | 2 | 502 / 501 |
| quick history | 非空 | 3 | ≤690 |
| open tabs | 非空且 ≥3 字符 | 3 | 300–500 |
| pedal（命令） | 非空 | 5 | 300–700 |
| 远端搜索建议 | 非空 | 5 | 100–400 |
| **zero-suggest**：打开标签 | **空输入** | 3 | 780–840 |
| **zero-suggest**：历史 | **空输入** | 5 | ≤760 |

历史打分（`suggestors/quick-history.ts:146-166` 的口径，NG 照抄）：
`300 + matchTier + min(typed*12,180) + min(visit*3,120) + recency(140/100/60/20)`
零输入历史：`min(760, 240 + min(typed*18,250) + min(visit*4,180) + recency(210/170/115/35))`

**NG 缺口**：`domain-search#search` 的历史行只有「子串位置」一个因子，
**完全没用 `visitCount` / `typedCount` / 最近访问时间**（这三列库里都有）；且**没有零输入建议**
（空输入时 `requestSuggestions` 直接 `hidePassive`，地址栏一聚焦空着就什么都不给）。

### 4. 命令（pedal）
RT 只硬编码 5 条；NG 有 23 条（更全）。但 NG 的命令表**散在三处**：
`ui-searchbar/suggestors/pedals.js`（建议）+ `TabManager#omniboxAction`（执行）+ `main.js#keybindingActions`（快捷键）。
文档自己写着「加一条命令 = 两处各一行」（`docs-new/4`:299）—— 这是要收的债。

---

## 二、落地清单（本次施工顺序）

1. **定位**：新增 `anchor-below` 锚定 + ui-searchbar 上报锚点矩形（宽度 `×1.8`，高度按可用空间夹）。
2. **外观**：overlay 按上表重写（13px 圆角、四层阴影、14/12 字号、隐藏滚动条、hover/选中两态）。
3. **图标**：站点用 favicon；其余按 `type` 走一份**共用** SVG 表（不再用 emoji）。
4. **历史**：`domain-search` 引入 RT 的 typed/visit/recency 打分；新增**零输入建议**（最近历史 + 已开标签）。
5. **命令**：新建纯数据模块 `packages/shared-types/src/commands.mjs`（**唯一真源**：
   id / 中文名 / 关键词 / 目标页面），`pedals.js` 与 `TabManager#omniboxAction` 都从它读 —— 加一条命令 = 一处一行；
   同时把两份不一致的 bangs 表（UI 30 条 vs 主进程 10 条）收成一份。
6. **清死代码**：`createSearchBar` 里 `suggestors` 数组与 `addSuggestor` 是死的（真实列表硬编码在
   `requestSuggestions`）—— 改成**真的从数组派生**，插件才注册得进来；`remoteSuggestor` 漏导出，补上。

## 三、验收（重启后手测）
- 点地址栏 / Ctrl+L：下拉**贴在地址栏正下方**（不再是窗口正中），宽度约地址栏的 1.8 倍。
- 地址栏空着聚焦：出现「已打开的标签 + 最近历史」（零输入建议）。
- 输入中文/英文关键词：历史、书签、已开标签、命令、`!bang` 混合出现且排序合理。
- 输入 `设置`／`历史`：命令行出现，回车打开对应内部页。
- 长列表：滚动条**不可见但可滚**；上下键高亮跟着走。
