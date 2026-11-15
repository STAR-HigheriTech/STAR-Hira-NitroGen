# 笔记面板：Vivaldi 对照与重构方案

> 目标：以 Vivaldi 的 Notes 面板为参照，把 NG 侧栏笔记面板从「localStorage 里存一个
> 数组 + 一个 textarea」升级为**有域层、有文件夹、可搜索、可排序、带 Markdown、
> 数据落 SQLite** 的完整功能面；同时不破坏本仓库既定的分层与插件契约。

---

## 1. Vivaldi 笔记面板到底有什么（对照基线）

| 能力 | Vivaldi | NG 现状（改造前） |
| --- | --- | --- |
| 存储 | 随账号同步（服务端 + 本地） | `localStorage['hira-notes']`，一个裸 JSON 数组 |
| 组织 | **文件夹树**（可嵌套）+ 「全部笔记」+ 未归档 | 无 |
| 搜索 | 顶部搜索框，标题 + 正文全文匹配 | 无 |
| 排序 | 按创建时间 / 修改时间 / 标题 | 固定按数组顺序 |
| 编辑器 | 标题 + 正文；**Markdown 开关**（写 / 预览两态） | 标题 input + textarea + 保存按钮 |
| 来源 | 笔记记录创建时的页面 URL；可跳回 | 无 |
| 截图/附件 | 从当前页插入截图 | 无 |
| 复制 | 一键复制正文到剪贴板 | 无 |
| 右键菜单 | 编辑 / 移动 / 删除 / 复制 | 无 |
| 自动保存 | 有（输入即存） | 手动点「Save」 |
| 置顶/颜色 | 无（Vivaldi 靠文件夹分类） | 无 |

关键差异不是「功能多少」，而是**数据层的缺失**：NG 的 `notes` 表早在
`infra-db/schema.js` 里定义好了，却**没有任何域服务与 IPC 通道**，面板只能退回
localStorage —— 于是数据不随 profile 走、不进备份、和其余九个域完全两个世界。

---

## 2. 落地架构（对齐本仓库既有分层）

```
panel-notes.renderer.js  （插件自带 UI，只画界面）
        │  ctx.clients.notes
        ▼
renderer/shared/notes-client.js ──IPC──▶ main/ipc/notes.js ──invoke──▶ notes-service 插件
                                                                          │ capability
                                                                          ▼
                                                             domain/domain-notes（唯一写入口）
                                                                          │ Drizzle
                                                                          ▼
                                                        infra-db：notes / note_folders（SQLite）
```

- **域层 `domain-notes`** 是唯一数据事实源：增删改查 + 搜索 + 排序 + 文件夹树 + 置顶 + 变更事件。
- **`notes-service` 插件** 只做「能力 → 域方法」的薄映射，与 `bookmark-service` 同构；
  引擎被禁用时，`panel-notes` 因 `dependsOn` 落 `blocked`，面板从目录里消失 —— 这就是
  §10.4「UI 与引擎联动禁用」的既有机制，**本方案零新增联动代码**。
- **面板 UI 拆成四块**（都在 `apps/app-main/plugins/`，与 manifest 同一份资产）：
  - `panel-notes.renderer.js` —— 插件入口：`panelDefinition` + 装配
  - `panel-notes.model.js` —— 纯状态与客户端调用（不含 DOM）
  - `panel-notes.view.js` —— DOM 渲染（不含数据来源）
  - `panel-notes.markdown.js` —— Markdown → HTML（纯函数）
- **数据模型**：`notes` 扩列（`folder_id` / `url` / `tags` / `pinned` / `sort_order` /
  `profile_id` / `color`），新增 `note_folders`（`parent_id` 自引用 → 支持嵌套）。

### 为什么 `profile_id` 也补上

书签 / 历史 / 下载 / favicon 全部按 profile 分区，唯独 notes 没有。不改的话会出现
「切了用户，笔记还是上一个用户的」——这正是本仓库反复强调的一类隐蔽错误。
老库通过 `ALTER TABLE ADD COLUMN ... DEFAULT 'default'` 补列，既有数据自动归 default。

---

## 3. 面板交互设计（窄栏 200~600px）

**列表态**

```
┌ 搜索笔记…                         ＋   📁   ⇅ ┐
├ 全部笔记 (12)                                 │   ← 面包屑 / 返回上级
│ ▸ 工作 (4)                                    │   ← 文件夹行（可展开、计数）
│ ▾ 读书 (3)                                    │
│    ○ 《人月神话》        snippet…   8/12 ★    │   ← 笔记行：色点 + 标题 + 摘要 + 日期
│    ○ Rust 笔记           snippet…             │
└───────────────────────────────────────────────┘
```

**编辑态**

```
┌ ←   [标题输入框]                    ⧉  M↓  ⋮ ┐
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │ 正文（Markdown 可切换预览）             │  │
│  └─────────────────────────────────────────┘  │
│  修改于 8/12 14:03 · 来源 example.com · 归入…  │
└───────────────────────────────────────────────┘
```

- 输入即存（180ms 防抖），无需「保存」按钮。
- 右键菜单走原生菜单（`ctx.menu.popupMenu`）：编辑 / 置顶 / 复制正文 / 移动到文件夹 /
  打开来源 / 删除。
- 新建笔记自动挂到「当前所在文件夹」；新建文件夹同理。

---

## 4. 数据迁移（不许丢用户数据）

1. **老 `notes.json`**（legacy Hira）：既有 `migration/adapters/notes.js` 已覆盖，
   补上新列的默认值即可（新列有 DEFAULT，插入时不必显式给）。
2. **NG 过渡期 `localStorage['hira-notes']`**：面板首次挂载时，若数据库为空且该键存在，
   逐条 `notes.add` 导入，成功后删除该键。只做一次，失败保持原样（下次再试）。

---

## 5. 本次不做（明确留白，避免"半成品"）

- **页面截图附件**：需要主进程截图 + 二进制存储，属独立一刀（Vivaldi 的 attachments）。
- **跨设备同步**：无服务端。
- **网页右键「添加为笔记」**：属于 webview 上下文菜单插槽
  （`webview.context-menu.item`），等 UI 侧接通后再挂。

---

## 6. 第二轮：学收藏面板的「文件夹 / 标签」+ 学空间面板的「颜色球」

第一轮把面板立起来了，但文件夹只能"点进去看"，标签字段有库无 UI。这一轮**照抄两个
成熟面板的做法**，而不是自创：

### 6.1 文件夹 —— 学 `ui-panel-favorites`（收藏面板）

| 收藏面板的做法 | 笔记面板的落地 |
| --- | --- |
| 行级 `draggable`，事件**全部委托在容器**上 | 同（`body` 上委托 `dragstart/dragover/drop/dragend`） |
| 落点三分带：上 1/4 插前、下 1/4 插后、文件夹行中间放进其内 | 同（`zoneOf()`：文件夹行中段 28%~72% = `into`） |
| 拖进自身/自身后代 → 拦下，不成环 | 同（`descendantFolderIds` + 数据层 `moveFolder` 二次拦截） |
| 回传「该父级下**全部**子节点的新顺序」给 reorder | 同（`siblingNoteIds` / `siblingFolderIds`） |
| 落点视觉：`drop-into` / `drop-before` / `drop-after` / `dragging` | 同（同一套类名与配色） |

新增数据能力：`notes.moveFolder` / `notes.reorderFolders`（域层 + 能力插件 + IPC 契约
一处不漏），并顺带把 `removeFolder` 的"后代收集"抽成 `descendantFolders` 复用。

额外一条收藏面板没有的：**把笔记拖到列表空白 = 落到当前这一层的末尾**（`body.drop-root`）。

### 6.1.1 层级语义：笔记只出现在它所属的那一层（关键修正）

第一版顶层（scope = 未进入任何文件夹）把**所有**笔记铺平显示 —— 于是放进文件夹的笔记
同时出现在根目录，看起来就是「全在根目录放着」。这既不符合收藏面板的架构，也让
"文件夹"形同虚设。现在按收藏面板的口径改成：

| 视图 | 显示什么 |
| --- | --- |
| 顶层（根目录） | 本层的子文件夹 + **只有** `folderId === null` 的笔记 |
| 进入某文件夹 | 该文件夹的子文件夹 + **只有**归属该文件夹的笔记（根目录的东西不再显示） |

- 去掉了「全部笔记 / 未归档」两个作用域 chip —— 根目录就是"未归档"，没有第二个概念。
- 顶部只在**进入文件夹之后**出现面包屑（`← 工作 / 项目`），返回键逐级后退（`goUp()`），
  不是一步跳回根目录。
- 文件夹行两种手势：**三角** = 就地展开/折叠；**点名字** = 进入该文件夹。
- 搜索是唯一的"跨文件夹"入口（显式动作），结果行标出它属于哪个文件夹（`notes-panel__noteloc`）。


### 6.2 标签 —— 学书签编辑器的约定

- 书签的标签是「编辑器里一个逗号分隔的输入框」（见 `renderer/subwindow/windows/bookmark-editor.js`），
  笔记面板照此约定：编辑器内联 `标签，逗号分隔` 输入框，`change` 时提交数组。
- 面板是窄的，所以**多给一层**：笔记行显示最多 2 个 `#tag` 徽标 + `+n`；
  列表顶部按标签出筛选条（多选 = 交集）。搜索框也把标签计入匹配。
- 域层 `search` 一并把 `tags` 纳入匹配，插件走 IPC 时行为一致。

### 6.3 颜色球 —— 学 `spaces-panel`（空间面板）

空间面板的"颜色"是 `spaces-panel__dot` + `gradientOf()` 产出的 **135° 双色渐变小球**，
不是一块死平的色点。笔记只有单色，于是由它推出「亮 → 本色」的渐变
（`ballGradient()`：`lighten(hex, 0.42)` → `hex`），列表行的颜色标记与编辑器的色板
按钮都换成这种球。

