# PART18 · 开放世界插件接口

> 目标：插件不是「挂在某个角落的小部件」，而是**与官方同权的一等公民**。
> 浏览器信息、页面内容、面板、菜单、navbar、标签、rail、内部页、浮层、AI、自动化
> —— 全部有稳定接口，既能**做加法**（新增），也能**做减法**（改写/隐藏现成的东西）。

## 1. 两条腿

| 通道 | 适合 | 实现位置 |
| --- | --- | --- |
| **能力门面** `ctx.browser.*` | 命令式：读写浏览器状态、开标签、操作面板、执行自动化、调 AI | `infra-plugin`（`plugin-capabilities.js` 工厂注入） |
| **声明式贡献** `hira-plugin.json → contributes.*` | 声明式：按钮、菜单、浮层、面板覆盖、页面补丁 | `apps/app-main/src/main/plugin-surfaces.js` |

两者共用同一套权限 scope：能力门面逐方法自鉴权；声明式贡献在**注册期**与**消费期**都按 scope 过滤。

## 2. 能力矩阵（`ctx.browser`）

每一行 = 一个命名空间，括号内为该命名空间需要的 scope。第一方插件（`isFirstParty`）全放行。

| 命名空间 | 关键方法 | scope |
| --- | --- | --- |
| `browser.info()` | `app`（版本/平台）、`window`（id/尺寸/焦点）、`profile`、`space` | — |
| `browser.tabs` | `list/listAll/active/get/new/navigate/switchTo/close/pin/mute/sleep/undoClose/reload/goBack/goForward/reorder` | `browser:control` |
| `browser.windows` | `list/active/open/close/focus/state` | `browser:control` |
| `browser.content` | `url/title/html/text/selection/screenshot/executeJavaScript/insertCSS` | `content:read` / `content:modify` |
| `browser.panels` | `list/open/close/toggle/show/hide/pin/prepare/sideOf/isPinned` | `panels:manage`（`list` 仅需 `ui:read`） |
| `browser.ui` | `navbar.add/remove`、`rail.add/remove`、`tabActions.add`、`overlay.show/hide/list`、`theme.get`、`setBadge` | `ui:chrome` / `ui:overlay` |
| `browser.menus` | `add(where, item)`、`remove(where, id)`、`open({x,y})` | `ui:chrome` |
| `browser.pages` | `register/list/patch/unregister`、`serveStatic` | `pages:manage` |
| `browser.actions` | `list/run(name, args)`（浏览器全部菜单动作的统一执行入口） | `actions:run` |
| `browser.automation` | `run(script)/stop/state` | `actions:run` |
| `browser.ai` | `invoke(prompt, opts)` / `tools()` / `registerTool(def)` | `ai:invoke` |
| `browser.events` | `on(event, fn)/off`（主进程事件总线，白名单） | `events:subscribe` |
| `browser.storage` | `get/set/remove/keys/clear`（按插件分区，SQLite） | `storage:read` / `storage:write` |
| `browser.clipboard` | `read/write` | `clipboard:read` / `clipboard:write` |
| `browser.settings` | `get/set`（插件自己的设置命名空间） | `storage:read` / `storage:write` |
| `browser.commands` | `register(def)/run(id, args)/list` | `actions:run` |

**鉴权失败**统一抛 `{ code: 'EP_MISSING_SCOPE', scope }`；能力未就绪（如 AI 没有实现者）抛 `{ code: 'EP_NOT_AVAILABLE', capability }`。

## 3. 声明式贡献类型

全部注册为 namespaced MULTI kind，由 `syncSurfaces()` 与 manifest 同步。

| `contributes.` 键 | 产出面 | 对应官方插槽 |
| --- | --- | --- |
| `navbarButtons[]` | 导航栏按钮 | `navbar.button-slot` |
| `railButtons[]` | rail 图标 | `side-panel.rail-icon-slot` |
| `tabActions[]` | 标签动作按钮 | `tab.action-slot` |
| `overlays[]` | 独立 iframe 浮层 | `overlay.slot` |
| `panelOverrides[]` | 面板改写 / 隐藏（`panel-catalog` 现取） | `browser.ui.panel` |
| `pagePatches[]` | 内部页 / 网页 CSS+JS 补丁 | `page.patch` |
| `commands[]` | 可被菜单/快捷键/AI/自动化调用的指令 | `browser.command` |
| `menus[]` / `bangs[]` / `pages[]` / `userscripts[]` | 既有四类 | 各自专用链路 |
| `panels[]` | 侧栏面板（rail / navbar / 按钮编辑 / 面板宿主四处共用） | `side-panel.panel-render-slot` |

**面板声明契约**（`contributes.panels[]`，唯一形状真源
`packages/shared-types/src/panel-entry.mjs`）：

- `id`（必填）/ `title` / `order` / `segment` / `bangs` / `presentation` 等字段同既有面板目录；
- `icon`：注册名（真源 `packages/shared-types/src/icon-names.mjs`，支持别名）或
  `data:image/…` / `hira-plugin://…` / `http(s)://…` / `<svg>…</svg>` 原文；
  未知名回落 `Puzzle`，不会留白；
- 实现来源二选一（可并用）：
  - `manifest.render` 指向**可执行渲染模块**，扩展名只认 `.js` / `.mjs` / `.cjs`
    （ESM 优先，CJS 也可加载但不能 `require`）；写成 `.html` 会被判为声明式 UI 面；
  - **声明式 UI 面**：面板项或 manifest **顶层**的 `ui` 指向插件内 `.html` / `.htm` / `.xaml`，
    经主进程整理成 `panelUi[]` 后由沙箱 iframe 渲染。
    - 顶层声明可被**所有面板继承**（`{ "ui": "panel.html", "contributes": { "panels": [{ "id": "x" }] } }`）；
    - 字段别名同一套（真源 `plugin-ui.mjs#PANEL_UI_FIELD_ALIASES`）：
      `ui` / `uiEntry` / `entry` / `html` / `view` / `src` / `path` / `render`
      —— 但只有指向 `.html/.htm/.xaml` 时才认作 UI，`render.js` 不会被误判；
- **两者都没有会被拒绝**（创作侧 `STUDIO_PANEL_NO_IMPL`）—— 声明一块画不出来的面板没有意义；
- 运行期自愈（注册中心 `normalizeManifest`）：`render` 不是模块扩展名 → 置空并改判 UI 面；
  `render` 缺失但目录里存在 `render.js` / `<id>.renderer.js` 等候选 → 自动补上
  （候选顺序唯一真源 `plugin-ui.mjs#renderEntryCandidates`）；
- 自查口：`plugin_list` / `studio_list` 的每项返回 `render`、`uiEntry` 与 `panels[]`
  （`iconValid` / `ui` / `implementation: 'render'|'ui'|'none'`），AI 可据此判断
  「为什么没图标 / 为什么打开说尚未实现」。
- **界面内容怎么写**（`panel.html` 骨架、`hira.*` 调用、`<html data-hira-*>` 约定、宿主注入清单）
  的真源是 `packages/shared-types/src/panel-ui-contract.mjs`（`panelUiAuthoringGuide()`）：
  能力 / 事件元信息、可复制三段示例、7 段注入、6 个 data-* 全在里面，
  桥按 `method` 合并实现并双向校验。AI 侧从 `studio.capabilities().panelUi` 一次读全，
  照抄用的 Markdown 手册走 `studio_guide` 工具（按节下发，避免超工具结果上限）；
  逐段说明见《插件化落地现状与扩展指南》§4.1.1 ⑧。

动作统一形如 `{ type: 'url'|'page'|'panel'|'command'|'bang'|'slot'|'overlay', ... }`
（唯一真源：`plugin-surfaces.js#ACTION_TYPES`）。同插件的命令用 `{ type: 'command', command: '<id>' }`。

`panelOverrides` 条目：`{ id?, panelId, hide?: true, patch?: {...} }`。
`hide: true` 等价 `remove: true`；省略 `patch` 时行内字段（title / icon / order / segment …）
直接当 patch —— 归一化只在 `plugin-surfaces#listPanelOverrides` 一处，
可改写字段白名单只有 `panel-catalog#PATCHABLE_FIELDS` 一份。

### 3.1 面板数据面（命令式，`panel.data.provider`）

面板是视图，数据在别处。AI 要读"面板里到底摆着什么"（含书签的 `pinned` /
`railPinned` / `openInSidebar` 这类细节标签），走的是统一读取口，而不是给每个面板
各造一个 AI 工具：

```js
// 插件启用时
extensionPoints.implement('panel.data.provider', () => ({
  panelIds: ['my-panel'],        // 或 panelId: 'my-panel'
  kind: 'list',                  // list | tree | cards | rules | summary
  async read(args, ctx) {        // ctx = { services, layout, presentation, windowCount }
    return { items: [...], total: n, meta: {...} }
  }
}), { pluginId })
```

消费方是 `apps/app-main/src/main/panel-data.js`（内置 15 个 provider 同表，
覆盖总览 / 收藏 / 集锦 / 历史 / 下载 / 扩展 / 插件 / 主题 / 画板 / 注入 / 空间 / 会话 / 标签 / 权限 / 验证器），
输出给 AI 的 `panel_list`（`hasData` / `dataKind` / `dataSource`）与 `panel_read`。
同一 `panelId` 上插件实现优先于内置实现，插件停用后自然回落 —— 不需要注销。
`live-folders-panel`（渲染进程联网抓取）与 `qr-scanner-panel`（即时取景，不落盘）没有主进程数据面，
`panel_read` 会返回 `available:false` 并给出「改用什么工具」的说明；插件可以补上自己的 provider。

## 4. 安全模型

1. **scope 声明 + 用户授权**：manifest `requestedPermissions` → 设置页逐条授权 → `grantedPermissions`。
   未授权时能力门面抛错，声明式贡献被过滤。
2. **第一方豁免**：`isFirstParty`（官方 harness-core 等）不需要授权，但审计日志照打。
3. **进程隔离**：第三方插件跑在 `utilityProcess`，能力调用经 `plugin-host-client` 的
   权限闸门（`_assertCtxAllowed`）→ RPC → 主进程门面。`BASE_CTX_PATHS` 新增 `browser`。
4. **渲染侧白名单**：`slots:render` 只放行 `RENDERER_HOSTED_SLOTS`（toolbar / rail /
   navbar / tab.action / overlay）。新增宿主插槽必须显式登记。
5. **浮层内容沙箱**：插件浮层是 `hira://p-<plugin>-<page>` 内部页里的 iframe，
   不注入宿主 DOM，不继承外壳权限。

## 5. 新增一个扩展点的步骤

1. `OFFICIAL_EXTENSION_POINTS` 加一行（纯数据，写清调用签名）；
2. 需要渲染侧宿主 → `RENDERER_HOSTED_SLOTS` 登记；
3. 声明式形态 → `plugin-surfaces.js` 加 kind + `define()` + `list*()`；
4. 命令式 → `plugin-capabilities.js` 加命名空间方法 + scope；
5. 事件 → `ipc-channels.mjs` + `event-catalog.mjs` 同步登记。
