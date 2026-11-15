# 01 · 现状分析与 Shift 对照

> 分析基于 2026-11-03 当前仓库。Shift 参考基于其官方 Builder 与 FAQ 在当日可见的公开产品说明，不把营销文案当实现细节。

## 1. 现有编辑模式到底做了什么

### 1.1 入口与承载

- 主壳菜单的「编辑按钮…」调用 `buttons-edit:set-active`。
- 主进程显示独立的 `buttons-edit-overlay`，铺满窗口并接管指针。
- navbar 与 rail 把自己的按钮暂时隐藏，上报真实几何；主进程补上各视图偏移，统一转成窗口坐标。
- 浮层按相同坐标克隆按钮，拖拽、命中、插入线、按钮池全部在浮层自己的 renderer 内完成。

这套方案解决了 Electron 中最难的问题：跨 `WebContentsView` 的真实 HTML 拖放不可靠。这个基础必须保留。

相关文件：

- `apps/app-main/src/renderer/buttons-edit-overlay/main.js`
- `apps/app-main/src/main/ipc/buttons-edit.js`
- `ui/ui-navbar/src/toolbarRegistry.js`
- `ui/ui-navbar/src/toolbar/ledger.js`
- `ui/ui-navbar/src/toolbar/zones.js`
- `apps/app-main/src/renderer/rail/main.js`

### 1.2 当前可编辑范围

| 面 | 当前能力 | 限制 |
| --- | --- | --- |
| navbar | 导航区 / 面板区排序、显隐、拖回按钮池 | 地址栏固定；不能把整条 navbar 改造成其它形态；不能嵌套分组 |
| rail | 常驻区 / 抽屉区排序、显隐、区内移动 | 不能创建第二个 rail，不能把其它内容放进 rail |
| 面板 | 左右普通位 + 钉住位，宽度记忆 | 每侧普通位和钉住位各最多一块；没有标签式面板组、不能任意增加面板列 |
| chrome 块 | tabbar / navbar / titlebar / bookmarkbar 可放 top / bottom / side | `side` 只有一个侧栏区；块内按钮与块所在区域是两套状态 |
| Web Sidebar | 独立远程页面区域，可左右切换 | 不参与统一布局编辑；与面板可以共存，但不能成为可组合 block |
| 特殊模式 | 紧凑单行、自动隐藏、悬停展开、沉浸等已有 | 各自由不同设置与运行期状态控制，没有统一变体模型 |

### 1.3 当前布局真源

现在至少存在四层布局事实：

1. `packages/shared-types/src/layout.mjs#planChromeLayout`：四块 chrome 的区域与顺序。
2. `ui/ui-chrome-layout`：把计划施加到 top / bottom / side DOM。
3. `apps/app-main/src/renderer/controllers/window-layout-controller.js`：从 DOM 量宽高，上报主进程。
4. `infra/infra-window/src/LayoutCoordinator.js`：根据结构参数计算页面、rail、面板、网页侧栏的 bounds。

这四层目前能工作，但不是一个统一模型：

- renderer 不是从完整布局文档求出主进程几何，而是“DOM 摆好后量给主进程”。
- 多个容器天生只能表达单侧栏。
- 面板槽是固定成员，不是布局树节点。
- 响应规则、上下文规则、隐藏规则散在设置与运行期判断中。

## 2. 可保留的资产

| 资产 | 继续承担什么 | 为什么不能丢 |
| --- | --- | --- |
| 跨视图克隆编辑 | 叠加编辑层的命中与拖拽坐标系 | HTML5 DnD 跨 view 不可靠；重做会再次踩同一坑 |
| `toolbar/ledger.js` 的窄接口思想 | 演化为 BlockRegistry / SurfaceAdapter | 状态、几何、目录分离的方向是对的 |
| `planChromeLayout` 的纯函数约束 | 迁入新 LayoutEngine 的 chrome compatibility adapter | 主进程与渲染层共用规则，避免漂移 |
| PanelCatalog | 向编辑器自动贡献 panel blocks | 插件启停已经全链路生效，不能再造第二份面板清单 |
| `ui-chrome-layout` 的 block 搬移 | 继续使用同一个 DOM 节点搬家 | 不重建标签条 / 地址栏，内部状态不会丢 |
| `LayoutCoordinator` 的端口注入 | 添加 panel group / custom column 的 native placement | 布局层仍只认识矩形与视图端口，不认识业务类型 |
| 新标签页 Board | 提供成熟的 pointer capture + rAF + transform 拖拽经验 | 同一产品内已有经过用户反馈打磨的手感 |

## 3. 真正的主缺口

### 3.1 缺统一文档

“按钮顺序”是 `app.navbar_buttons` / `app.rail_buttons`，“块位置”是 `app.*_position` / `app.chrome_row_order`，“面板宽度”又是另一组键。用户要做一次“工作布局”，实际上是在修改多份互不认识的数据。

需要一份可版本化、可撤销、可导出的 `LayoutDocument`。

### 3.2 缺浏览器级容器

目前只有 top / bottom / side 三个逻辑区域。要实现 Shift 式自由，需要至少以下容器原语：

- 单行 / 多行栏；
- 左右自定义列；
- 可折叠面板组；
- 标签式、堆叠式 Dock；
- 工具栏内分组；
- 溢出抽屉；
- 间隔、分隔线；
- 浮层 Dock。

### 3.3 缺编辑事务

现有按钮编辑每落一次点就写一次设置。它能工作，但无法提供：

- 撤销 / 重做；
- 应用前预览；
- 模板差异；
- 一次拖动造成多处几何变化时的原子提交；
- 插件消失后保留 dormant block；
- 文档 revision 回滚。

### 3.4 缺特殊模式语义

“紧凑、专注、分屏、沉浸、悬停展开”现在各有各的入口。用户需要的是可复用的 **Layout Variant**：

```text
基础布局
  ├─ 窄窗口变体
  ├─ 专注模式变体
  ├─ 分屏模式变体
  └─ 当前 Space 覆盖
```

变体由同一个求解器解释，不能再散落地写判断。

### 3.5 缺可视化素材层

当前编辑浮层只有按钮目录和投放框。没有：

- 模板缩略图；
- block 图文目录；
- 容器结构预览；
- 当前布局 minimap；
- 不同窗口宽度 / 不同模式的预览；
- 非法 drop 的原因提示。

## 4. Shift Builder 的真实可学点

Shift 官方 Builder 的公开界面提供这些构件：

| 分类 | 公开可见内容 |
| --- | --- |
| Templates | The Everyday Explorer、The Original Shiftie、The Creative、The Organizer、The Navigator、The Maverick |
| Bars | 可增删、拖放的 Bars |
| Controls | Back / Forward / Reload / Tabs / Search / Quick Settings / window controls 等 |
| Apps | Slack、Gmail、Facebook、Messenger、WhatsApp、YouTube 等固定入口 |
| Bookmarks | 浏览器书签栏 |
| Actions | Cancel、Apply Changes、Undo、Redo |

官方模板语言也说明了几个关键方向：

- “Original Shiftie”把 Apps 和 Spaces 固定在侧栏。
- “Creative”强调可收缩侧栏与专注工作区。
- “Organizer”以空白起步，突出自定义。
- “Navigator”以纵向组织最大化屏幕空间。
- “Maverick”允许把 Apps 和 Spaces 固定在底部。

### 4.1 应学

1. **四类构件进入同一个编辑器**：Bars、Controls、Apps、Bookmarks。
2. **模板是起点，不是锁定模式**：选中模板后仍可继续拆装。
3. **从成品开始拖动**：直接操作真实预览，不从表单里填坐标。
4. **跨边自由**：顶部、底部、左侧、右侧都能承载同类应用 / 控件。
5. **可清空克制**：用户能删掉不需要的控制，减少固定 chrome。
6. **预览与提交分离**：Apply Changes 与 Undo / Redo 是编辑器的核心，不是附属功能。

### 4.2 不能直接照搬

| Shift 的表层做法 | Hira NG 的正确落法 |
| --- | --- |
| 页面内 iframe 预览 | Hira 需要驱动真实 `WebContentsView`。编辑浮层仍必须是原生浮层，几何由主进程与纯引擎共同给出。 |
| 任意拖到窗口任何位置 | 浏览器存在响应式、安全区、原生视图遮挡和 WCO 限制。采用归一化容器树；视觉上自由，数据上有结构。 |
| 以 Apps 为核心 | Hira 的核心对象还包括 Space、面板、标签栈、Web Sidebar、AI 面板与插件内容；Block 协议必须比“App 图标”更通用。 |
| 模板可能绑定产品默认工作流 | Hira 模板只是 LayoutDocument 快照，应用后立即转成普通可编辑文档。 |
| 少量全局布局 | Hira 必须支持 profile / Space / 响应宽度 / 运行上下文的分层。 |

## 5. 产品判断

“和 Shift 一样自由”并不意味着给用户一个绝对定位画板。真正好用的高级自定义需要同时做到三件事：

1. **用户操作像拼积木**：拿起、放下、卡入、预览、撤销。
2. **底层结果像排好的布局系统**：窗口缩放、面板加载、网页边界始终正确。
3. **扩展像注册中心**：加一个面板或插件 block，不改编辑器核心。

因此最终产品不是“普通模式 + 全屏后台编辑器”，而是一套完整的浏览器叠加编辑体验：

- **直接编辑**：真实界面上的控件克隆可直接拖动、隐藏、折叠、改宽。
- **精修面板**：点击中央“更多按钮”，从顶部中央展开模板、构件库、隐藏按钮池和检查器。
- **边缘拼装**：拖动到浏览器窗口四边，可在真实界面边缘新建栏或列。
- **深层编辑**：双击工具栏组或面板组进入该容器，中央工具条显示面包屑，不切到全屏画布。
- **预览仍在真实界面中**：模板、响应宽度和特殊模式都作用到当前浏览器草稿，只用小型浮层补充说明。

所有层级共享同一个 `LayoutDocument`、同一个命令系统、同一个求解器和同一个撤销栈。

