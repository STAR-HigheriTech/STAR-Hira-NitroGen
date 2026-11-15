# OOBE 首次启动引导窗口设计

参考实现：`1A-STAR_Hira_RT`（Electron + React + TS）。
落地项目：`1A-STAR_Hira_NG`（pnpm monorepo，主进程为 CJS JS，内部页为原生 ESM）。

本文只回答一件事：**NG 的 OOBE 窗口怎么做，接在哪，靠什么持久化，怎么扩展**。
原则沿用 RT 的骨架，但每一层都换成 NG 已有的机制，不新造第二套。

---

## 1. RT 是怎么做的（只记结论）

| 环节 | RT 实现 | 关键点 |
| --- | --- | --- |
| 启动判定 | `runOnboardingOrInitialWindow()` | 先查「是否已完成」，未完成 → 只开引导窗；完成 → 开浏览器窗 |
| 完成态存储 | `onboarding_version_completed = "v0"`（electron-store 类） | 存**版本号**而不是布尔值：升版即可重新触发 |
| 超时兜底 | 读取 10s 超时视为「未完成」 | 存储层卡死不能把用户挡在门外 |
| 窗口 | 1000×700、`frame:false`、`resizable:false`、`center:true`、`roundedCorners`、`titleBarStyle:'hidden'` | 自绘、居中、不可缩放 |
| 页面 | `hirax-internal://onboarding/` | 内部协议页 |
| 关闭语义 | `close → hide()` | 不销毁，完成时再 hide |
| 完成顺序 | **先 `createInitialWindow()` 再 hide 引导窗** | 否则非 macOS 下 `window-all-closed` 立刻 `app.quit()` |
| 阶段 | Welcome → InitialSpace → Icon → NewTab → Finish，`AnimatePresence mode="wait"` | 横向推进、单向动画 |
| 视觉 | 背景 `#050A20`、品牌 `#0066FF`、顶部 40px `app-drag` 条 | 暗色固定，不跟随主题 |
| IPC | `onboarding:finish` / `onboarding:reset` | 完成 / 重置 |

RT 的坑，NG 必须逐条对上：

1. **不能挂父窗**。RT 的引导窗是独立窗；NG 的 `createSubWindow` 一旦带 `parent` 就是 `modal`，而 OOBE 期间主窗还是 `show:false` 的空壳，父窗隐藏会把子窗一起藏掉。
2. **完成时必须先让主窗可见**，再关引导窗（顺序反了就是应用直接退出）。
3. **关窗 = 跳过 = 完成**，否则用户点 `×` 会进入「引导窗没了、主窗没 mount」的僵尸态。
4. **版本号存全局**，不能存 profile / 空间（换 profile 不该重新引导）。

---

## 2. NG 落点（全部复用既有机制）

### 2.1 窗口：登记一个新的窗口类型

真源：[window-config.js](../apps/app-main/src/main/window-config.js)

```js
ONBOARDING: 'onboarding'

[WINDOW_TYPES.ONBOARDING]: {
  page: 'onboarding',        // → hira://onboarding
  width: 1000, height: 700,
  independent: true,         // 不挂 parent：主窗此时是隐藏壳
  modal: false,
  frame: false,              // 自绘标题栏
  resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
  showOnReady: true,
  backgroundColor: '#050A20'
}
```

`page: 'onboarding'` 依赖 NG 的**磁盘扫描**：`pages/onboarding/` 存在即自动注册 `hira://onboarding`，
`electron.vite.config.js` 里 `copyMainSourcesPlugin` + `bundlePageEntriesPlugin` 已覆盖
「多文件 ESM + 相对 import → 单文件产物」，**新增页面零构建配置改动**。

`createSubWindow` 不支持 `center`，所以居中由控制器在拿到 `BrowserWindow` 后调用 `win.center()`。

页面型子窗口走 `buildWebPreferences()` 的默认值 → 注入 `shell` preload → 页面有 `window.hira` 桥，
`rpc()` 直接可用（`provider.invoke` 没有路由白名单，新路由不需要改 preload）。

### 2.2 持久化：一个全局键 + 版本号

- 键：`app.onboarding_version`，默认 `''`。
- 值：`'v1'`（`ONBOARDING_VERSION`）。判定 `实际值 !== 当前版本号` 即需要引导。
- 作用域：登记进 `packages/shared-types/src/settings-scope.mjs` 的 `GLOBAL_EXPLICIT_KEYS`，
  于是 `profileOverlay` 的 `get/set` **自动落到 `settings.global.json`**，
  且 `flush()` 已覆盖全局文件 —— 退出落盘不需要额外代码。
- 默认值：`domain/domain-settings/src/index.js#DEFAULT_SETTINGS`。

为什么不新建一个 JSON：设置层已经解决了「全局 / profile / 空间三层 + 防抖 + 退出 flush」，
再开一份存储就是第二套真源（用户规则明令禁止）。

### 2.3 主进程控制器：`main/onboarding/index.js`

单一状态真源，只做四件事，不认识 Electron 之外的任何业务：

```js
createOnboardingController({
  settings,          // { get(key), set(key, value) }
  openWindow,        // openSubWindowByType
  getWindow,         // (type) => BrowserWindow | null
  windowTypes,       // WINDOW_TYPES
  mountMainShell     // () => Promise<void>
})
```

对外 API：

| 方法 | 语义 |
| --- | --- |
| `needsOnboarding()` | `settings.get('app.onboarding_version') !== 'v1'` |
| `getState()` | `{ needsOnboarding, version, requiredVersion, open }` |
| `open()` | 开窗 + `center()` + `show()` + `focus()`；已开则前置（`opening` 防重入） |
| `complete()` | `await mountMainShell()` → 写版本 → `destroy()` 引导窗（`finishing` 防重入；mount 失败则保留引导窗且不记版本） |
| `reset()` | 版本置 `''` → `open()` |
| `markQuitting()` | 退出标记，跳过「关窗即完成」 |

关窗语义：

```js
win.on('close', (e) => {
  if (finishing || quitting) return          // 完成流程 / 真退出：放行
  e.preventDefault()
  complete()                                 // 点 × = 跳过，但同样收敛到「已引导」
})
```

`quitting` 由 `before-quit` 置位 —— 否则退出时 `preventDefault` 会把应用钉死。

**交接顺序（不可交换）**：mount 主窗 → 写版本 → 销毁引导窗。
`mountMainShell()` 本身幂等（`mainShellMounted`），重复调用无副作用。
反过来先写版本会在 mount 失败时留下「已引导但没主窗」的死局，因此版本只在 mount 成功后才落盘。

**控制器不认识「导入」**：导入是流程里的一屏（`stages/migrate`），和其它步骤一样在同一个
引导窗内推进。想加/挪一步只改 `stages/index.js` 的 `ORDER` 表，控制器与 IPC 零改动。

### 2.4 启动分流

[main.js](../apps/app-main/src/main/main.js) 现在只有两支：

```js
if (coldPwa) await launchColdPwaWindow()
else        await mountMainShell()
```

改成三支，且 OOBE 优先级最高（引导未完成时**绝不** mount 主窗）：

```js
if (onboarding.needsOnboarding()) await onboarding.open()
else if (coldPwa)                 await launchColdPwaWindow()
else                              await mountMainShell()
```

控制器实例化位置：`openSubWindowByType` 定义之后（约 2780）。
`mountMainShell`（2040）与 `openSubWindowByType`（2716）都是函数声明（提升），
所以该 `const` 同时能被 `registerCoreIpc`（约 5019）与启动分流（约 5188）引用。

### 2.5 IPC：三条路由，三层登记

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `onboarding:state` | 无 | `{ needsOnboarding, version, requiredVersion, open }` |
| `onboarding:complete` | 无 | `{ ok }` |
| `onboarding:reset` | 无 | `{ ok }` |

登记路径（与 `default-browser` 完全同构，照抄即可）：

1. `packages/shared-types/src/ipc-channels.mjs` → `IPC_ROUTES`
2. `infra/infra-ipc/src/contracts/onboarding.js`（zod）+ `contracts/index.js` 聚合
3. `apps/app-main/src/main/ipc/onboarding.js`（注册器）+ `ipc-routes.js` 接线

注册器纪律：`typedMain / routes / schemas / onboarding` 任一缺失直接 `return`，
不抛错、不影响其它路由注册（与 `registerDefaultBrowserIpc` 一致）。

### 2.6 页面：`pages/onboarding/`

```
pages/onboarding/
  index.html            ← hira://shared/base.css + ./onboarding.css
  onboarding.css        ← 固定暗色（不跟随主题，避免切主题闪一下）
  onboarding.js         ← 外壳：流程解析 / 进度点 / 内容槽 / 上一步·下一步 / 关闭
  stages/index.js       ← REGISTRY（id → 模块）+ ORDER（来源 → id 列表），唯一扩展点
  stages/user-source.js ← 来源词汇表（other / min），stage 与 index 都读它，避免循环 import
  stages/welcome.js     ← 第 1 步：来源选择（其它浏览器 / Hira Min）
  stages/migrate/       ← 两条流程共用：导入 / 迁移一屏（按来源换文案，实现只有一份）
    index.js            ← 每个来源一行 UI + 文件选择 + 结果回填
    sources.js          ← 迁移源注册表（每条 = 一个真实导入通道）
  stages/appearance.js
  stages/layout.js      ← 四布局模式（写 LAYOUT_SETTING_KEYS，不手抄键名）
  stages/startup.js
  stages/default-browser.js
  stages/finish.js
```

**阶段契约（插件化核心）**：

```ts
// stages/index.ts
const REGISTRY = { welcome, migrate, appearance, layout, startup, 'default-browser': defaultBrowser, finish }

// 流程 = 来源 → 该走的 stage id 序列（顺序是编排，模块是实现）
const ORDER = {
  other: ['welcome', 'appearance', 'layout', 'startup', 'default-browser', 'migrate', 'finish'],
  min:   ['welcome', 'migrate', 'appearance', 'layout', 'startup', 'default-browser', 'finish']
}
resolveFlow(source) → [stage, ...]      // 未知来源回落 other；未登记的 id 静默跳过
```

`migrate` 在两条流程里都出现，但只有**一份实现**：位置不同只是 `ORDER` 表里的顺序不同
（Min 用户紧跟欢迎页、其它浏览器排在完成之前），stage 内部最多按来源换标题文案。

```ts
// 每个 stage 只描述自己。mount 可以直接返回 DOM，也可以返回带生命周期的视图：
{
  id: 'layout',
  label: '布局',                   // 进度点上的短词
  hint?: string,                   // 页脚左侧提示
  nextLabel?: string,              // 本阶段主按钮文案
  mount(ctx) → HTMLElement | {
    el: HTMLElement,
    destroy?(),                    // 取消监听 / 定时器，阻断迟到 DOM 写入
    beforeNext?()                  // 继续前等待本阶段在途任务
  },
  onNext?(ctx) → boolean | void | Promise<…>   // false = 停在原地
}
```

`ctx` 由外壳提供，stage 之间不互相认识。异步状态必须留在每次 `mount` 的闭包里，
不放在模块级全局变量中；这样返回再进入、快速切步和窗口重载都不会串状态：

```ts
{
  rpc, IPC_ROUTES, el,             // 复用 hira://shared/runtime.js
  sources: USER_SOURCES,           // other / min（stage 不 import index，避免循环依赖）
  enterFlow(source),               // 换流程：重算 flow + 重排进度点（欢迎页调用）
  draft: {
    source, themeId, themeName,
    layout: null,                  // { id, label, preset, mode }
    startupMode, migration: {}     // { [sourceId]: { ok, count, message, file } }
  },
  next(), back(), close(),
  setBusy(bool), toast(text), focusPrimary(), complete(),
  runExclusive(task)               // 页面级单任务锁：防双击 / 防写入乱序
}
```

新增一个引导步骤 = 在 `stages/` 加一个文件 + 在 `REGISTRY` 登记 + 在需要的 `ORDER` 行里插 id。
新增一类来源 = `user-source.ts` 加 id + `ORDER` 加一行。外壳、主进程、IPC 全部零改动。

各阶段内容（全部走既有路由，不新增业务接口）：

| 阶段 | 交互 | 复用路由 |
| --- | --- | --- |
| welcome | 两张来源卡：其它浏览器 / Hira Min（含「第一次使用」「升级迁移」标签） | 无 |
| migrate | 两条流程共用（位置见 ORDER）：Chrome / Edge 一键导入 + 书签 HTML / 密码 CSV 文件导入，可逐个执行或直接跳过；继续前等待在途导入 | `import:sources` / `import:browser-data` / `bookmark:import` / `password:list` / `password:import-csv` |
| appearance | 主题卡片（用 `swatch` 画预览），点选即应用 | `theme:list` / `theme:set` |
| layout | 四张线框卡：经典 / 紧凑 / 垂直标签 / 全功能侧栏 | `settings:get` / `settings:set` |
| startup | 四选一：空白 / 主页 / 自定义网页 / 恢复上次会话（保留现有 custom，不误画成 blank） | `settings:get` / `settings:set`（`app.startup_mode`） |
| default-browser | 三态：检查中 / 可设置 / 已设置；执行与焦点回归均回读 | `app:is-default-browser` / `app:set-default-browser` |
| finish | 回顾（来源 / 主题 / 布局 / 启动 / 迁移结果）+ 完成（**没有**导入勾选项） | `onboarding:complete` |

**布局四模式 → 真源字段**（`packages/shared-types/src/layout.mjs`，页面不手抄键名）：

| 卡片 | preset | mode | 实际摆放 |
| --- | --- | --- | --- |
| 经典 | `classic` | `default` | 标签栏、地址栏各一行（都在行区） |
| 紧凑 | `classic` | `compact` | 标签栏与地址栏合并成一行（`planChromeLayout.merged`） |
| 垂直标签 | `vertical-tabs` | `default` | 标签栏进侧栏，地址栏留在行区 |
| 全功能侧栏 | `vertical-all-in-one` | `default` | 标签栏与地址栏都进侧栏 |

读写用 `layoutPresetWrites(preset)` 生成 `[键, 值]`，用 `matchLayoutPreset(positions, titlebarEnabled)`
反推当前选中项：用户单独调过某块位置时返回 `null`，界面显示「自定义组合」而不是
硬套一个最接近的预设。写失败按读取时的快照整体回滚，保证「高亮 == 实际设置」。

**迁移向导边界**（必须如实，不能伪造能力）：

- 仓库 / RT 中都不存在「Hira Min 数据目录」的读取实现，因此**不扫描本机目录**，
  只用用户亲手选中的导出文件；UI 明写「只读取你挑的这个文件」。
- 只接两条真实通道：书签 Netscape HTML（`bookmark:import { html }`）、
  密码 CSV（`password:import-csv { content }`；已有凭据时先经 `password:list` 确认覆盖）。
- 每条源是一种可迁移数据，注册在 `migrate/sources.js`：
  `{ id, label, desc, accepts, pickHint, run(ctx, text) → { ok, count?, cancelled?, message } }`。
  新增一种数据只加一条，UI 自动多一行。
- 迁移不是关卡：不选文件也能「继续」；结果写进 `draft.migration`，来回切换阶段不丢。

无边框拖拽：顶部 48px 条 `-webkit-app-region: drag`，其中的按钮 `no-drag`（与
`subwindow/index.html`、`ui-titlebar` 同一约定）。

视觉：**不自建调色板**，一律复用 `pages/_shared/base.css` 的原语与令牌 ——
按钮 `.btn` / `.btn-primary` / `.btn-sm`、图标按钮 `.icon-btn`、徽标 `.badge`（含
`-success` / `-danger`）、提示块 `.notice`，以及 `--bg` / `--surface` / `--text*` /
`--accent` / `--hover-bg` / `--field-bg` / `--ring` / `--r-*`。
`onboarding.css` 只保留两类东西：① 整屏壳布局（覆盖 base 的 body 留白）；
② 两个本页原语——`.oobe-choice`（可选卡，`--media` / `--row` 两个 modifier 覆盖
主题卡 / 布局卡 / 单选行）与 `.oobe-surface`（静态面，迁移行 / 状态卡共用）。
新增阶段时**只组合这两个原语**，不得再写一套 `.oobe-xxx-card`。

**不调用 `initTheme()`**：OOBE 是全球首启第一屏，主题变量还没意义；固定暗色也避免
「页面先亮后被主题刷成暗」的闪烁。因此 `index.html` 上静态写 `data-theme="dark"`
（base.css 的暗色分支就是最终取值，不需要第二套分支）。

### 2.7 重置入口

`main/settings/registry.js` 的 `general` 分区加一个 `type:'action'` 字段：

```js
{
  key: 'app.onboarding_reset', label: '重新运行首次启动引导', type: 'action', effect: 'live',
  desc: '重新走一遍来源、外观、启动方式、布局与默认浏览器；不会清除书签、历史或已改过的设置。',
  action: { runRoute: 'onboarding:reset', runLabel: '重新运行' }
}
```

**位置纪律**：设置页导航的大类是 `section.group`（「启动与行为 / 外观 / 系统与数据 …」），
`general` 只是「启动与行为」组里第一张**卡**的名字（卡标题显示为「常规」）。
因此：
- 用户路径应写成 **设置 → 启动与行为 → 常规（第一张卡）→ 重新运行首次启动引导**，
  不要写成「设置 → 常规」（导航上不存在这个大类）；
- 这个入口**不标 `group:'advanced'`** —— 一旦落进「高级」卡就等于被藏起来，
  而它是用户主动回来找的恢复入口。

设置页的 action 语义：**没有 `checkRoute` 的按钮恒为可点**（`refresh()` 只在有
`checkRoute` 时回读状态），所以这里天然不需要额外状态查询。
点一下 → `reset()` → 版本清空 → 立即开引导窗（主窗保持原样，不销毁）。

### 2.8 导入一屏与「设置 → 导入数据」的关系

两者**实现不同、职责不同**，不要合并：

| | 引导里的导入一屏 | 设置里的导入数据 |
| --- | --- | --- |
| 载体 | `pages/onboarding/stages/migrate/`（引导窗内的一步） | `pages/import-data`（独立窗口 / 标签页） |
| 粒度 | 每类数据一行，「选择文件…」就地导入，可整体跳过 | 一次一个文件 + 结果明细 + 插件格式下拉 |
| 位置 | 由 `ORDER` 决定（Min 紧跟欢迎页 / 其它浏览器在完成前） | 设置 → 导入数据 |

引导窗是 `frame:false` 且不可缩放，把 600×500 的独立页塞进来只会得到两种形态的分支
（拖拽区、自带关闭、`?from=` 判定）—— 这正是被否掉的方案。引导只保留「一屏、一步、
一个继续按钮」的心智，重导入这类需要慢慢做的事继续由设置里的独立页承担。

---

## 3. 时序图

```
app ready
  └─ settings/ipc/registry 就绪
       └─ onboarding = createOnboardingController(...)
            └─ needsOnboarding() === true
                 ├─ openSubWindowByType('onboarding')
                 │    └─ createSubWindow({ page:'onboarding', independent:true, frame:false })
                 │         └─ win.center() / show() / focus()
                 │              └─ hira://onboarding（shell preload → window.hira）
                 │                   └─ ORDER[source] → 逐屏推进（含 migrate）
                 │
                 └─ [用户点「开始使用」/ 点 ×]
                      ├─ await mountMainShell()        ← 主窗 loadUiShell + show（失败则中止，保留引导窗）
                      ├─ settings.set('app.onboarding_version', 'v1')
                      └─ onboardingWin.destroy()       ← 此时已有可见主窗
```

---

## 4. 死代码 / 边界纪律

- 不新建窗口工厂：一律走 `openSubWindowByType`。
- 不新建存储：一律走 `settings`（全局键）。
- 不新增 preload：`provider.invoke` 无白名单。
- 不在渲染层推导「是否已完成」：状态只从 `onboarding:state` 来。
- 阶段模块只依赖 `ctx`，不 import 其它阶段；外壳不认识任何具体阶段 id（进度点按 `resolveFlow(source)` 生成）。
- 流程分叉（走哪些步骤）只写在 `stages/index.js` 的 `ORDER` 表里：新来源加一行，不在 stage 里增删步骤；
  stage 内最多按来源换文案（如迁移页标题），不改变流程本身。
- OOBE 期间主窗保持 `show:false`，但**必须已存在**（`primaryWindow` 在更早的地方 `open()`），
  否则 `mountMainShell()` 无窗可挂。
