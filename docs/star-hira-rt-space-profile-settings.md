# STARHiraRT 空间、配置文件与设置架构分析

> 对照对象：`1A-STAR_Hira_RT`
> 对齐项目：`1A-STAR_Hira_NG`
> 目的：记录 RT 的真实职责边界、数据关系、入口与切换语义，作为 NG 后续实现的唯一参考。

## 1. 核心结论

RT 中的 Profile 不是“设置页面中的一组设置项”，而是浏览器数据隔离边界；Space 是 Profile 下的可见工作空间。

关系是：

```text
Profile（配置文件 / 浏览器数据容器）
├── Chromium Session / Cookies / Storage / Extensions
├── Profile 元数据
└── Spaces（用户可见工作空间）
    ├── 标签状态
    ├── 活跃标签
    ├── 标签组投影
    ├── 名称
    ├── 图标
    ├── 背景渐变
    ├── 最近使用时间
    └── 排序
```

必须区分三类数据：

| 数据           | RT 作用域                                    | 典型内容                                                         |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Profile 元数据 | `main/profiles/<profileId>`                  | name、createdAt、internal、ephemeral                             |
| Space 元数据   | `main/profiles/<profileId>/spaces/<spaceId>` | name、profileId、icon、bgStartColor、bgEndColor、lastUsed、order |
| 基础浏览器设置 | 全局 `settings`                              | 新标签行为、主题、侧栏、下载、内容拦截等                         |

RT 没有把普通浏览器设置复制到每个 Profile，也没有把 Space 当成独立 Chromium Session。

## 2. Profile 的真实定位

Profile 是“配置文件”在产品层的用户概念，但它的核心不是设置项，而是浏览器运行数据隔离：

- Chromium 用户数据目录：`Profiles/<profileId>`
- Electron Session：`session.fromPath(profilePath)`
- 不同 Profile 之间隔离 Cookies、Storage、扩展会话等浏览器数据
- 创建普通 Profile 时自动创建同名默认 Space
- 删除 Profile 时连带删除其 Space 数据、Profile 目录与 Profile datastore
- `internal` Profile 不显示给普通用户
- `ephemeral` Profile 用于短生命周期场景，会在会话结束后清理

Profile 元数据本身只有少量字段。Profile 编辑器真正可编辑的主要字段是名称；RT 中“搜索引擎配置”只是未来占位，并不是已经存在的 Profile 设置存储系统。

因此，NG 不应把所有设置复制到 Profile 下，也不应把 `profileId` 当作普通 settings key 的前缀。Profile 的解耦方式应该是：

```text
ProfileService：管理 Profile 元数据与生命周期
SessionService：根据 profileId 提供独立 Chromium Session
SpaceService：管理 Profile 下的 Space 元数据
SettingsService：管理全局浏览器设置
APPS 编排层：协调 Profile / Session / Space / Settings 的运行时联动
```

## 3. Space 的真实定位

Space 是明面上的浏览器工作区，必须同时存在于浏览器主界面和 Settings 管理界面。

### 3.1 浏览器明面入口

RT 的用户日常操作入口包括：

- 侧栏 Space switcher
- 原生 Spaces 菜单
- 快捷键切换 Space
- 当前 Space 的主题背景与图标展示
- 当前 Space 对应的标签状态

侧栏切换只允许用户看到普通 Profile 的 Space。internal Profile 的 Space 不进入普通用户切换列表，也不能被普通用户切换。

### 3.2 Settings 管理入口

RT 的 Settings 有独立的 `Profiles` 与 `Spaces` 分区，而不是只放一个“打开空间管理页”的按钮。

Profiles 分区负责：

- Profile 列表
- 创建、重命名、删除 Profile
- 过滤 internal Profile
- 查看某个 Profile 的 Space 列表
- 从 Profile 页面新建 Space
- 点击某个 Space 跳转到全局 Spaces 编辑器

Spaces 分区负责：

- 跨 Profile 展示 Space
- 按 Profile 筛选，或展示所有普通 Profile
- 创建 Space 并选择所属 Profile
- 编辑 Space 名称、背景渐变、图标
- 删除 Space
- 拖拽排序
- 从 Profile 页面跳入时保留 `profileId` 筛选，并可自动打开指定 `spaceId`

这两个分区不是重复功能：

- Profiles 是以 Profile 为主的层级管理
- Spaces 是以 Space 为主的跨 Profile 管理

## 4. Profile 与 Space 的运行时关系

RT 的关键规则是：Space 从属于 Profile，但多个 Space 共享 Profile 的 Chromium Session。

```text
Space A ─┐
         ├── Profile P ── 一个 Electron Session
Space B ─┘
```

因此，同一 Profile 的不同 Space 共享：

- Cookies
- Local Storage
- IndexedDB
- 登录状态
- 扩展会话

Space 主要隔离的是浏览器工作区状态，而不是站点身份数据。窗口当前 Profile 由当前 Space 的 `profileId` 推导：

```text
window.currentSpaceId
    → Space.profileId
    → Profile
    → Electron Session
```

切换 Space 时，RT 的核心联动是：

1. 校验目标 Space 和 Profile
2. 更新窗口的 `currentSpaceId`
3. 更新 Space 最近使用时间
4. 通知 renderer 当前 Space 变化
5. 更新当前窗口标签映射
6. 显示目标 Space 的标签与活跃标签
7. 清理旧 Space 的远程标签占位/截图状态
8. 更新原生菜单与 Space 主题

不能把“切换 Space”简单实现成“关闭旧 Session、创建新 Session”。那会把 Space 错误地变成 Profile，破坏 RT 的父子语义。

## 5. Profile 页面与 Space 页面之间的导航状态

RT Settings 的导航不是静态跳转，而是带上下文的导航：

```text
Profile 页面
  ├── 查看该 Profile 的 Spaces
  ├── navigateToSpaces(profileId)
  └── navigateToSpace(profileId, spaceId)
          ↓
Spaces 页面
  ├── 自动选中 profileId
  ├── 可按 profileId 筛选
  └── 可自动打开 spaceId 编辑器
```

这意味着 NG 的内部页面或设置渲染器应支持可序列化的导航上下文，例如：

```text
hira://settings?section=spaces&profileId=p1
hira://settings?section=spaces&profileId=p1&spaceId=s1
```

也可以使用独立的 `hira://spaces` 页面，但必须保留 `profileId` / `spaceId` 上下文，而不是只有一个无上下文的管理入口。

## 6. Space 数据字段

RT Space 的完整数据字段为：

```js
{
  (id, name, profileId, bgStartColor, bgEndColor, icon, lastUsed, order);
}
```

字段职责：

- `id`：空间稳定标识
- `name`：用户可见名称
- `profileId`：归属 Profile，普通更新不可修改
- `bgStartColor` / `bgEndColor`：空间主题渐变
- `icon`：空间图标
- `lastUsed`：切换时由主进程更新
- `order`：同一 Profile 内的排序值

创建、更新、删除和排序必须通过 Space domain 与 IPC 契约完成，renderer 不直接读写 datastore。

## 7. NG 当前实现需要遵守的修正方向

### 7.1 必须保留的设计

- `domain-profile` 不直接依赖 `domain-space`
- 通过 `spacePort` 鸭子端口让 Profile 创建/删除联动默认 Space 和级联清理
- Space metadata 单独由 `domain-space` 管理
- UI 使用哑组件，业务编排放在 APP 层
- IPC 继续使用 routes → contracts → main ipc → renderer client 四段式
- internal / ephemeral Profile 不暴露给普通 Space 切换 UI

### 7.2 不能继续偏离 RT 的设计

- 不能只在 Settings 放一个“打开空间管理”的跳转按钮就视为完成
- 不能把 Space 与 Profile 组合成两个独立 Chromium Session
- 不能让 Space 切换依赖销毁并重建整个 Profile Session
- 不能把普通全局设置复制为每个 Profile 一份
- 不能允许普通用户跨 Profile 拖拽移动 Space
- 不能让 Settings 的 Profile 页面与 Spaces 页面失去 profileId / spaceId 上下文

### 7.3 NG 后续目标结构

```text
Profile
├── metadata service
├── Chromium session boundary
└── visible spaces
    ├── current window space
    ├── tab projection
    ├── ordering
    └── appearance

Settings
├── global browser settings
├── Profiles management section
└── Spaces management section
    ├── profile filter
    ├── create
    ├── edit
    ├── delete
    └── reorder
```

## 8. RT 原生菜单（Spaces 菜单）实现细节

> 源码：`src/main/controllers/app-menu-controller/menu/items/spaces.ts`

### 8.1 菜单在顶级菜单中的位置

`Spaces` 是顶级菜单之一（Windows 下排列在 View 与 Tabs 之间）。菜单在以下事件触发时整体重建：

- `space-created` / `space-updated` / `space-deleted`
- `shortcuts-changed`
- `recently-closed:changed`
- `window-focused`（主窗口聚焦是刷新选中态的事件源）

目前 RT 没有按 profile 分组显示空间，也没有 "Profiles" 菜单项。

### 8.2 如何列出所有 space

```text
spacesController.getAll()
  → 所有 profile 的全部 space 合集
  → 按 order 升序排序（持久化字段，默认 999）
  → 过滤：剔除属于 internal profile 的 space（如无痕）
```

`Spaces` 菜单的子菜单由可见 space 的菜单项 + 分隔线 + "Manage Spaces" 组成。没有任何 profile 分组子菜单。

### 8.3 快捷键编码

```text
accelerator: `Ctrl + ${index + 1}`
```

- `index` 是可见 space 列表（过滤 internal 之后、order 升序）中的位置
- 第 1 个可见 space = `Ctrl+1`，第 2 个 = `Ctrl+2`…
- 超 9 个 space 时会出现 `Ctrl+10`、`Ctrl+11`（RT 未做 1-9 上限裁剪）
- 硬编码 `Ctrl`（非 `CmdOrCtrl`），macOS 上也不是 ⌘+数字
- 顺序/数量变化会重新分配数字键，依赖菜单整体重建生效

### 8.4 选中态

每个菜单项使用 Electron 原生复选框类型：

```js
{
  type: 'checkbox',
  checked: space.id === focusedWindow.currentSpaceId,
  label: space.name,
  accelerator: `Ctrl+${index + 1}`,
  click: () => setUsingSpace(window, space.profileId, space.id)
}
```

菜单项的 `checked` 来自**焦点窗口**的 `currentSpaceId`，点击则调用 `setUsingSpace(profileId, spaceId)`。

### 8.5 菜单降级与守卫

- 无焦点浏览器窗口、焦点窗口是 popup、或当前 space 落在 internal profile 时，只呈现提升项 "Manage Spaces"（甚至只有该项）
- 图标转换 `space.icon → NativeImage`（SVG→PNG）仅在 macOS 生效，其他平台菜单不显示图标

### 8.6 对 NG 的约束

NG 的原生菜单（app shell 的 `ui:popup-menu` 或其他菜单实现）应至少具备：

- 用焦点窗口当前 space 做复选框选中
- Ctrl+数字快捷键按可见空间顺序分配
- 过滤 internal profile 的空间
- "Manage Spaces" 打开 Spaces 管理（设置页或独立页）
- 用户不可见 internal profile

同样是决策点：NG 是否要按 profile 分组显示原生菜单。RT 当前没有，但用户可接受按 profile 分组。

## 9. RT 侧栏 Space 切换器的真实语义

> 源码：`src/renderer/src/components/browser-ui/browser-sidebar/_components/bottom/space-switcher.tsx`
> 依赖：`src/renderer/src/components/providers/spaces-provider.tsx`

### 9.1 切换器渲染什么

RT 的侧栏切换器**只渲染图标**（Phosphor SpaceIcon），在侧栏收起时退化为圆点；不渲染名称、不渲染渐变、不按 profile 分组。空间名称与背景渐变实际由下面这些地方渲染：

- 侧栏顶部标题：`space-title.tsx`（显示 space.name，套用空间图标色）
- 设置页空间卡片：`space-card.tsx`（圆形底 `linear-gradient(to bottom right, bgStartColor, bgEndColor)`）
- 侧栏整体背景：通过 `--space-background-start/end` CSS 变量形成空间主题

RT 侧栏更像"空间图标栏"，NG 的 ui-space-switcher 当前渲染了名称/渐变，这是比 RT 更重、并非必须对齐的部分。如果 NG 追求与 RT 一致，应重点保留图标 + 点击切换 + 当前空间高亮；名称与管理入口仍然放在设置/空间管理页更符合 RT。

### 9.2 侧栏切换器对 internal profile 的处理

SpacesProvider 对外只暴露 `visibleSpaces`（过滤掉 internal profile 的空间）；当前空间如果是 internal，切换器整块不渲染（返回空占位）。

internal 过滤是**多层防线**：

1. Provider 层：可见列表与默认空间选择都跳过 internal
2. UI 层：当前空间是 internal 时不显示切换器
3. 主进程层：`canUserSwitchWindowSpace` 拒绝 popup、拒绝目标是 internal、拒绝当前是 internal 的切换
4. 切换器圆点/图标本身不被当作普通可切换空间

### 9.3 切换后的派生状态

`currentSpace` 变化会触发：

- 主题变量更新：`bgStartColor/bgEndColor` → OKLCH → `:root` 的 `--space-background-start/end`
- 明暗判定：`hex_is_light(bgStartColor)` → 侧栏注入 `dark` 类，决定侧栏文本/图标颜色族
- 加载 Profile：`flow.browser.loadProfile(currentSpace.profileId)`
- 收起 omnibox（首次切换空间时）
- 轮播滚动到对应空间页
- 原生菜单重建（主进程侧）

**这直接说明 NG 的一个待办**：`space:set-using` 后 renderer 不仅要刷新切换器列表，还要按当前空间的渐变更新窗口主题（背景色/文字色），并刷新当前空间相关的标题与图标。

### 9.4 标签拖拽到空间按钮

侧栏拖拽有**三条硬约束**：

1. 拖拽源必须是 `tab-group` 类型
2. 源 profile 与目标 space 的 profile 必须相同（禁止跨 profile 移动）
3. 不能放进自己的空间

拖拽经过空间按钮时还有 **100ms 悬停自动切换**，拖到空间内则把该标签组主标签移动到目标空间并追加到末尾。

因此 UI 上的拖拽排序可留可不留，但 "tab-group 挂到空间上" 的能力是 RT 已经存在的行为。

## 10. 设置页的导航上下文（关键）

RT 的 Settings 支持以下导航上下文：

```text
Settings → Spaces 分区
  ├── selectedProfile（过滤当前 profile）
  └── selectedSpace (spaceId)（自动打开对应编辑器）

从 Profiles 分区进入：
  navigateToSpaces(profileId)
  navigateToSpace(profileId, spaceId)
```

这要求 NG 的 Spaces 管理页（`hira://spaces`）必须支持可序列化上下文：

```text
hira://spaces?profileId=p1
hira://spaces?profileId=p1&spaceId=s1
```

当前 NG 的 `hira://spaces` 页只按 profile 分组展示，没有 filter 上下文。空间管理页应接受这些查询参数。

## 11. 关键结论（更新）

1. **Profile 是 Chromium Session 边界，Space 是工作区**，同一 Profile 的多个 Space 共享 Session。NG 当前的 `sessionDirFor(profileId, spaceId)` 是按 space 隔离 Session 文件，与 RT 的 `session.fromPath(profilePath)` 仅按 profile 不一致 —— 需要评估并决定是否回退到"按 profile 一个 Session、Session 内按 space 存标签"的模型。

2. **切换 Space 不应销毁重建 Session**。~~NG 需要确认 `switchSpace` 的实现是否保持了"同一个 window 内 Session 复用"的语义。~~ ✅ **已确认（原顾虑失效）**：`main.js` 的 `switchSpace` 现在保留其它空间标签、只切可见投影（`tabManager.setCurrentSpace`）；同 profile 内切空间不再重建 extension session。

3. **RT 的侧栏切换器不渲染名称/渐变/分组**，只渲染图标；NG 的 ui-space-switcher 可以保持更丰富的形式，但要在设置页把 name/颜色/图标/排序作为管理项。

4. **NG 设置页需要真正的 Spaces 管理分区**（创建/编辑/删除/排序/profile 筛选/上下文导航），而不是只有跳转按钮。

5. **原生菜单 Spaces 项**（Ctrl+数字、checkbox 选中态、internal 过滤）是 RT 的可感知入口，NG 应推送到实际菜单实现中。

6. **internal / ephemeral 过滤必须多层**：Provider 层、UI 层、主进程层逐层拦截，最后防线在主进程。

## 12. 对照文件索引

### STARHiraRT

- `src/main/controllers/profiles-controller/raw.ts`
- `src/main/controllers/spaces-controller/raw.ts`
- `src/main/controllers/sessions-controller/index.ts`
- `src/main/controllers/tabs-controller/index.ts`
- `src/main/ipc/session/spaces.ts`
- `src/main/saving/settings.ts`
- `src/renderer/src/components/providers/spaces-provider.tsx`
- `src/renderer/src/components/settings/settings-layout.tsx`
- `src/renderer/src/components/settings/sections/profiles/section.tsx`
- `src/renderer/src/components/settings/sections/spaces/section.tsx`
- `src/renderer/src/components/settings/sections/spaces/space-editor.tsx`
- `src/renderer/src/components/browser-ui/browser-sidebar/_components/bottom/space-switcher.tsx`

### HiraNG

- `domain/domain-profile/src/index.js`
- `domain/domain-space/src/index.js`
- `apps/app-main/src/main/main.js`
- `apps/app-main/src/main/ipc/profile.js`
- `apps/app-main/src/main/ipc/space.js`
- `apps/app-main/src/renderer/controllers/space-controller.js`
- `apps/app-main/src/renderer/shared/profile-client.js`
- `apps/app-main/src/renderer/shared/space-client.js`
- `apps/app-main/src/pages/spaces/spaces.js`
- `apps/app-main/src/pages/settings/settings.js`
- `apps/app-main/src/main/settings/registry.js`

## 13. 实施优先级

1. 先修正运行时语义：同一 Profile 的多个 Space 应共享一个 Chromium Session（RT `session.fromPath(profilePath)`，Session 按 Profile 缓存复用）。
2. 再补齐窗口级 Space 标签投影和切换状态（RT 保留标签实例、切换 = show/hide），而不是销毁重建全部标签 + reload UI。
3. 将标签持久化对齐 RT：标签清单集中管理（中央 DB 或等价存储），每条记录带 `profileId / spaceId`，删除 Space 时清理孤儿标签。
4. 将 Settings 的 Spaces 做成真正的独立管理分区，支持 profile 筛选和上下文导航（`initialSelectedProfile` / `initialSelectedSpace`）。
5. 将 Profiles 页面增加 Profile 内 Space 列表，并支持跳转到指定 Space 编辑器。
6. 最后补齐图标、渐变、排序、internal/ephemeral 过滤和原生菜单/快捷键联动。

> **落地进度**：第 2 项（切换 Space = 视图层 show/hide，不销毁重建）、第 4 项的管理页主体（`hira://spaces` 列表/创建/编辑/删除/拖拽）、第 5 项（`pages/profiles/profiles.js` 已含 Profile 内 Space 列表与新建）均已完成。仍待做：第 1 项（按 profile 单 Session 的语义决策）、第 3 项（标签清单集中存储）、Spaces 页的 `profileId`/`spaceId` 上下文导航、原生菜单 Ctrl+数字与 internal 过滤。

这份文档是后续 NG 实现的约束：如果实现选择与本文冲突，应优先回到 RT 源码重新确认，而不是继续沿用简化模型。

---

## 14. RT Session 运行时模型（Profile = Session 边界）

> 源码：`sessions-controller/index.ts`、`loaded-profiles-controller/index.ts`

### 14.1 SessionsController：按 Profile 缓存 Session

```text
sessions: Map<profileId, Session>
get(profileId)
  → 命中缓存直接返回
  → 否则 _create：
      profileSessionPath = profilesController.getProfilePath(profileId)
                        = FLOW_DATA_DIR/Profiles/<profileId>
      profileSession = session.fromPath(profileSessionPath)
      注册协议 hx / hirax-external
      注册 handlers / preload scripts / intercept rules
```

- Session 的磁盘根是 **Profile 目录**（Chromium 数据 + Session 存储一体）。
- `session.fromPath` 打开的是持久化用户数据目录，天然把 Cookies / Storage / 扩展 / UA 归整在 Profile 下。
- **同一 Profile 的所有 Space 复用同一个 Session 对象**，因为 Tab 构造时显式传入 `loadedProfile.session`。

### 14.2 LoadedProfilesController：Profile 懒加载与生命周期

```text
loadedProfiles: Map<profileId, LoadedProfile>
LoadedProfile = { profileId, profileData, session,
                  extensions, extensionsManager, newTabUrl, unload }
```

`load(profileId)`：

1. 已加载 → 直接返回；正在加载 → 等待同一 promise（防并发重复实例化）。
2. `_load`：`profilesController.get(profileId)` → `sessionsController.get(profileId)`。
3. 设置 User-Agent（去掉 Electron 痕迹，模拟 Chrome UA）。
4. 创建 `ElectronChromeExtensions({ session: profileSession, ... })`，扩展系统与 Session 绑定。
5. `new ExtensionManager(profileId, profileSession, extensionsPath)` 加载扩展、安装 Web Store。
6. 缓存进 `loadedProfiles` 并发出 `profile-loaded`。

`unload(profileId)`：

- 删除缓存、把 session 移出 `loadedProfileSessions`。
- **销毁该 Profile 的全部标签**（`tabsController.getTabsInProfile(profileId).forEach(tab.destroy())`）。

### 14.3 对 NG 的约束

- NG 现在用 `persist:profile-<id>` partition + 按 Profile 缓存 ECE 实例，**边界方向是对的**。
- ~~但 NG 没有"LoadedProfile"这样的统一运行单元~~ **已失效**：`infra/infra-window/src/LoadedProfilesController.js` 已存在并接线 —— `main.js` 用它包住 `getOrCreateExtensionService(profileId)` 做按 profile 单飞（复用 `sessionsController.get(id)` 的 session），避免 ECE/会话被重复实例化。
- 仍待收敛的部分：UA、权限处理器、下载控制器等仍在 `main.js` 里逐步切换；完整 **Profile 级运行时对象**（`{ session, extensions, ... }`）尚未成型。

## 15. RT 标签运行时模型（窗口 × 空间复合键）

> 源码：`tabs-controller/index.ts`

### 15.1 标签是全局注册的，Space 只是标签的一个属性

```text
tabs: Map<tabId, Tab>
每个 Tab 同时携带 profileId + spaceId + windowId
    tab.getWindow().id
    tab.profileId
    tab.spaceId
    session = profileSession（按 profile 共享）
```

### 15.2 三个窗口 × 空间复合键 Map

RT 用 `WindowSpaceReference = \`${windowId}-${spaceId}\`` 作为键：

```text
spaceActiveTabMap      : `${windowId}-${spaceId}` → 当前活跃 Tab | TabGroup
spaceFocusedTabMap     : `${windowId}-${spaceId}` → 当前聚焦 Tab
spaceActivationHistory : `${windowId}-${spaceId}` → 激活历史（关标签找下一个）
```

激活/关闭标签、判断 `isTabActive` 全走复合键，**与"该窗口当前空间"无关**——每个窗口的每个空间都保有独立状态。

### 15.3 切换 Space 不销毁标签

`setWindowSpace(window, spaceId)` 只做两件事：

```text
window.setCurrentSpace(spaceId)
window.sendMessage("spaces:on-set-window-space", spaceId)
```

真正改界面的逻辑在 TabsController 的 `processActiveTabChange(windowId, spaceId)`：

```text
遍历窗口内所有标签：
  tab.spaceId === spaceId
    ├── 活跃且未显示 → layout.show()
    ├── 不活跃且显示 → 退出全屏 + layout.hide()
    └── 其它 → layout.updateLayout()
  tab.spaceId !== spaceId
    └── 退出全屏 + layout.hide()
```

**标签实例、WebContents、Session 全部保留**，切换只是布局层 show/hide。这对 NG 意味着：

- ~~NG 切换 Space 时"关闭全部标签 → reload UI shell → 恢复 JSON"的整窗重建路径是错误的~~ **已失效**：NG 的 `switchSpace` 已改为保留其它空间标签、只切运行时可见投影（`tabManager.setCurrentSpace`），不再整窗重建。
- NG 沿用 WebContentsView 模型，等价实现为：标签 view 持续存在，切换空间时按 `spaceId` 过滤可见集合并显示/隐藏。

### 15.4 删除 Space 时清理孤儿标签

```text
spacesController.on("space-deleted", (_profileId, spaceId)) {
  tabsController.getTabsInSpace(spaceId).forEach(tab => tab.destroy())
}
```

独立删除 Space（如从 Settings）后，仍引用它的标签必须销毁，否则残留内存与状态。

### 15.5 Popup 窗口跟随 Space

- popup 新建时 `setWindowSpace(popupWindow, sourceTab.spaceId)`，让它接管源标签空间。
- `reconcilePopupWindow` 保证 popup 始终显示与它当前空间匹配的活跃标签；popup 空标签会自关。
- NG 目前是单窗口，暂无 popup 需求，但 `canUserSwitchWindowSpace` 对 popup 直接拒绝切换的逻辑要在窗口模型出现后补上。

## 16. RT 标签持久化模型（中央存储，非 per-space 文件）

> 源码：`saving/tabs/index.ts`、`saving/tabs/restore.ts`

### 16.1 存储结构：三张表，Space 只是标签的一列

```text
tabs        (PK uniqueId)  profileId | spaceId | windowGroupId | title | url | navHistory | …
tabGroups   (PK groupId)   profileId | spaceId | tabUniqueIds | mode | position
windowStates(PK windowGroupId) width | height | x | y | isPopup
```

- 标签不按空间分目录、不按空间拆 JSON 文件，而是 **Space 仅为行上的 `spaceId` 列**。
- 这样"列出某空间的标签"是 `WHERE spaceId = ?` 的一条查询，删除 Space 是 `DELETE WHERE spaceId = ?`。

### 16.2 TabPersistenceManager：脏标记 + 批量 flush

```text
dirtyTabs   : Map<uniqueId, PersistedTabData>    // 变更待写
removedTabs : Set<uniqueId>                       // 删除待写
FLUSH_INTERVAL_MS = 2000                          // 周期 flush
flush(): 快照脏集合 → 清空 → 单个事务批量 upsert/delete → 失败回填重试
```

- `markDirty(uniqueId, data)` / `markRemoved(uniqueId)`：内存里累计，2 秒批量落库。
- `shouldPersistTab`：ephemeral 标签 / ephemeral Profile 标签 / popup 窗口标签一律不持久化。
- 退出时 `stop()` 做最终 flush，保证不丢数据。

### 16.3 恢复：一次性读库、按窗口分组、全部以 asleep 创建

```text
restoreSession()
  → loadAllTabs() → 过滤 shouldArchiveTab 的旧标签（直接从库里删）
  → 按 windowGroupId 分组 → 逐组创建窗口
  → tabsController.createTab(window.id, tabData.profileId, tabData.spaceId,
       { asleep: true, navHistory, navHistoryIndex, position, uniqueId, ... })
  → restoreTabGroups 按 uniqueId→tabId 映射重建标签组
```

启动恢复不关心"上次用哪个空间"，**所有空间的所有标签一次全部重建**（以 asleep 占位），切换空间只是 show/hide。这也是"每个窗口每个空间状态常驻"能成立的原因。

### 16.4 对 NG 的含义

NG 当前的 `sessionDirFor(profileId, spaceId)` 把标签会话按 `userData/profiles/<pid>/spaces/<sid>/session.json` 落盘。这不是错，但带来三个问题：

1. **切换语义被迫是"换文件 + 重建"**：因为标签清单按空间独立成文件，切换时必须先保存 A、再恢复 B，天然引导出销毁重建。
2. **无法表达跨窗口/跨空间共存**：空间是整包切换，而非"某个窗口当前看哪个空间"。
3. **删除空间时的孤儿清理要靠文件删除**，不如"删行"直观。

NG 的整改方向（保持解耦、不改每包职责）：

- 把标签清单集中到一个会话存储（中央 DB 或单一 `sessions.json`），记录带 `profileId/spaceId` 列；`domain-session` 的 save/restore 接口签名不变，只改落点与粒度。
- 若短期想最小改动，至少把 `sessionDirFor` 的粒度从 `profile×space` 收敛到 **profile 级**，Space 间的差异只体现在 `activeSpace.id` 上，切换时按空间过滤渲染而不再整窗重建。

## 17. 设置分区 UI 对照（Profiles / Spaces section 真实结构）

> 源码：`settings/sections/spaces/section.tsx`、`settings/sections/profiles/section.tsx`

### 17.1 SpacesSettings：导航上下文 Props + 完整管理

```tsx
interface SpacesSettingsProps {
  initialSelectedProfile?: string | null; // 从 Profiles 列表跳入时筛选
  initialSelectedSpace?: string | null; // 跳入时自动打开对应编辑器
}
```

数据流：

```text
fetchData():
  [profiles, spaces] = await Promise.all([getProfiles(), getSpaces()])
  internalProfileIds = profiles.filter(p => p.internal).map(p => p.id)
  setProfiles(过滤掉 internal)
  setSpaces(spaces.filter(s => !internalProfileIds.has(s.profileId)))
  // initialSelectedSpace 命中 → setActiveSpace(选中空间)（自动打开编辑器）
```

- `selectedProfile` state 驱动筛选下拉。
- 创建对话框：`name + bgStartColor + bgEndColor + icon`，默认配色 `#4285F4 → #34A853`、`icon: "Globe"`，调 `flow.spaces.createSpace(selectedProfile, name)`。
- 拖拽排序用 `motion/react` 的 `Reorder` + `GripVertical` 手柄。
- 编辑走 `SpaceEditor`（SpaceCard 呈现渐变色圆点，见第 9 节）。

### 17.2 ProfilesSettings：卡片列表 + 三 Tab 编辑器

```text
ProfileCard 列表（鼠标悬停放大，点击进入编辑）
ProfileEditor 内部三个 Tab：
  ├── BasicSettingsTab  唯一可编辑字段 = name；profile ID 只读展示
  ├── SearchSettingsTab 搜索引擎 = "即将推出" 占位（未实现，不是真存储）
  └── SpacesTab         列出该 Profile 的 Spaces、包内新建、navigateToSpace 跳转
```

导航出参：

```text
navigateToSpaces(profileId)
navigateToSpace(profileId, spaceId)
```

这两个函数经 props 下传，落地后就是 SpacesSettings 的 `initialSelectedProfile / initialSelectedSpace`。

### 17.3 对 NG 的落地建议

- `hira://spaces` 页面接受 `?profileId=&spaceId=` 查询参数，对应 `initialSelectedProfilespace`。
- 设置里 spaces 分区的 `entry` 跳转按钮保持，但目标页面必须实现完整的列表/创建/编辑/删除/排序，而不是占位。
- Profile 编辑器：名称编辑 + Space 子列表 + 跳转。搜索引擎可先留占位（与 RT 一致）。

## 18. NG 当前实现与 RT 的精确差距清单

| 维度                    | RT                                                                | NG 现状                                                                                                                                                                                        | 整改                                                    |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Session 边界            | `session.fromPath(Profiles/<profileId>)`，Session 按 Profile 缓存 | ✅ 已引入 `LoadedProfilesController` 单飞加载器（`infra/infra-window/src/LoadedProfilesController.js`，`main.js` 用它包住 per-profile 扩展系统，复用 `sessionsController.get(id)` 的 session） | 完整 Profile 级运行时对象（UA/权限/下载一并收敛）仍待做 |
| 标签归属                | Tab 携带 `profileId + spaceId`，全局注册                          | TabManager 全局；切换只变可见投影（不再全量重建）                                                                                                                                              | 保留 Tab 实例，切换只变视图可见性（已完成）             |
| 切换 Space 成本         | 改 `currentSpaceId` + show/hide                                   | ✅ 保留其它空间标签、只切可见投影（`switchSpace` → `tabManager.setCurrentSpace`，`main.js`）                                                                                                   | 已完成                                                  |
| 标签持久化              | 中央表，space 是列；脏标记 2s 批量 flush                          | `profiles/<pid>/spaces/<sid>/session.json` 按空间拆文件                                                                                                                                        | 收敛按 Profile 级或集中存储                             |
| 孤儿清理                | `space-deleted` 遍历销毁该空间标签                                | ✅ `space:remove` 已调用 `destroySpaceTabs`（`apps/app-main/src/main/ipc/space.js`）                                                                                                           | 已完成                                                  |
| 窗口概念                | `currentSpaceId` 每窗口一个，多窗口复合键                         | 单窗口全局 `activeSpace`                                                                                                                                                                       | 预留 windowId 维度                                      |
| 设置 Spaces 分区        | 真管理页（筛选/创建/编辑/删除/拖拽/上下文导航）                   | ✅ `hira://spaces`（`pages/spaces/spaces.js`）已有列表/创建/编辑/删除/拖拽排序/渐变/图标；❌ 缺 `profileId`/`spaceId` 上下文导航                                                               | 补上下文导航（查询参数）                                |
| 设置 Profiles 分区      | 卡片列表 + 三 Tab 编辑器 + 跳转                                   | ✅ 已实现（`pages/profiles/profiles.js`：列表/创建/重命名/删除/设当前 + Profile 内 Space 列表与新建）                                                                                          | 已完成（搜索引擎 Tab 仍为占位）                         |
| 原生菜单                | Ctrl+数字 / checkbox / internal 过滤                              | ✅ 原生应用菜单已有 Spaces 子菜单（checkbox 选中当前空间 + 切换 + 「管理空间…」入口，`apps/app-main/src/main/app-menu.js`）；❌ 未见 Ctrl+数字快捷键分配                                       | 补 Ctrl+数字与 internal 过滤                            |
| internal/ephemeral 过滤 | Provider/UI/主进程三层                                            | 未见完整链路                                                                                                                                                                                   | 三层防线补全                                            |

这份文档是后续 NG 实现的约束：如果实现选择与本文冲突，应优先回到 RT 源码重新确认，而不是继续沿用简化模型。
