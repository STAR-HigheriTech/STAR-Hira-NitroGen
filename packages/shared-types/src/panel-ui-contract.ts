/**
 * panel-ui-contract.mjs —— 声明式面板（`panel.html` + `window.hira`）的**创作契约**。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * 「面板能调什么、能订阅什么、manifest 怎么写、HTML 长什么样」这套东西原来只存在于
 * `panel-ui-bridge.js` 的实现里 + 一份手写文档里。三个后果：
 *   1. 插件作者（尤其是 AI）不知道怎么写，只能猜；
 *   2. 文档与实现慢慢漂移（加了一条能力，文档没跟上）；
 *   3. 同一份知识要被抄三遍（桥 / 创作侧 / 文档）。
 *
 * 所以：**元信息只写在这里**，实现留在桥里，两边按 `method` 对齐（缺一条就启动抛错）。
 * 消费方：
 *   · `apps/app-main/src/renderer/shared/panel-ui-bridge.js` —— 合并实现，生成能力表；
 *   · `apps/app-main/plugins/ai/core/studio.cjs#capabilities()` —— 让 AI 一次读全；
 *   · `docs-ng/*` —— 文档照抄这里的字段，不再手写。
 *
 * ⚠ 本文件零依赖、零 IO、纯数据：主进程 / 渲染层 / 插件进程都能 require。
 */

import {
  PANEL_UI_BRIDGE_VERSION,
  PANEL_UI_HOST_DATA_ATTRS,
  PANEL_UI_KINDS,
  PANEL_UI_SCHEME,
  PANEL_UI_SANDBOX
} from './plugin-ui.js'
// 文档示例里的字体栈同样从唯一真源取（否则"照抄示例"又会抄出一套点阵宋体）。
import { uiFontVar } from './font-stack.js'

/**
 * 面板能调用的**全部**能力（`window.hira.<method>(...)`）。
 *
 * 字段：
 *   · `method`  —— 点分方法名，就是子侧调用路径；
 *   · `minLevel`—— 需要的最低 `permissionLevel`（目前全为 `ui`）；
 *   · `scope`   —— 额外授权（第三方插件必须在 manifest 里声明）；`null` = 不需要；
 *   · `summary` —— 一句话说明（`hira.capabilities()` 原样返回）；
 *   · `usage`   —— 可复制的调用示例（文档 / AI 用，不进运行时）。
 *
 * ⚠ 顺序即文档顺序；新增能力**只往后加**，不要重排（AI 与文档按位置引用）。
 *
 * @type {ReadonlyArray<{ method: string, minLevel: string, scope: string|null, summary: string, usage: string }>}
 */
export const PANEL_UI_CAPABILITIES: ReadonlyArray<{ method: string, minLevel: string, scope: string|null, summary: string, usage: string }> = Object.freeze([
  {
    method: 'capabilities',
    minLevel: 'ui',
    scope: null,
    summary: '列出本宿主开放的全部能力（含所需权限级别与 scope）',
    usage: "const caps = await hira.capabilities() // [{ method, minLevel, scope, summary }]"
  },
  {
    method: 'app.info',
    minLevel: 'ui',
    scope: null,
    summary: '当前插件 / 面板 / 权限级别等宿主信息',
    usage: "const info = await hira.app.info() // { pluginId, panelId, permissionLevel, firstParty, kinds, bridgeVersion }"
  },

  // ── 主题 ──────────────────────────────────────────────────────────────
  {
    method: 'theme.tokens',
    minLevel: 'ui',
    scope: null,
    summary: '读取宿主当前主题令牌（CSS 变量表）',
    usage: "const t = await hira.theme.tokens() // { '--hira-panel-fg': '#e7e7ea', ... }"
  },
  {
    method: 'theme.active',
    minLevel: 'ui',
    scope: null,
    summary: '当前主题 id',
    usage: 'const id = await hira.theme.active()'
  },

  // ── 插件存储（按 profile + 插件隔离，opaque origin 下唯一的持久化手段）──
  {
    method: 'storage.get',
    minLevel: 'ui',
    scope: 'storage:read',
    summary: '读取本插件自己的一条键值（不存在的键返回 null）',
    usage: "const pinned = await hira.storage.get('pinned')"
  },
  {
    method: 'storage.keys',
    minLevel: 'ui',
    scope: 'storage:read',
    summary: '列出本插件自己的全部键（[{ key, updatedAt }]）',
    usage: 'const keys = await hira.storage.keys()'
  },
  {
    method: 'storage.set',
    minLevel: 'ui',
    scope: 'storage:write',
    summary: '写入一条键值（任意可 JSON 序列化的值）',
    usage: "await hira.storage.set('pinned', ['https://example.com'])"
  },
  {
    method: 'storage.remove',
    minLevel: 'ui',
    scope: 'storage:write',
    summary: '删除一条键',
    usage: "await hira.storage.remove('pinned')"
  },
  {
    method: 'storage.clear',
    minLevel: 'ui',
    scope: 'storage:write',
    summary: '清空本插件的全部键',
    usage: 'await hira.storage.clear()'
  },

  // ── 标签 ──────────────────────────────────────────────────────────────
  {
    method: 'tabs.list',
    minLevel: 'ui',
    scope: 'tabs:read',
    summary: '当前窗口的标签列表',
    usage: 'const tabs = await hira.tabs.list()'
  },
  {
    method: 'tabs.projection',
    minLevel: 'ui',
    scope: 'tabs:read',
    summary: '标签的轻量投影（标题 / favicon / 激活态）',
    usage: 'const rows = await hira.tabs.projection()'
  },
  {
    method: 'tabs.open',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '打开一个新标签（hira.tabs.open(url)）',
    usage: "await hira.tabs.open('https://example.com')"
  },
  {
    method: 'tabs.activate',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '切换到指定标签',
    usage: 'await hira.tabs.activate(tabId)'
  },
  {
    method: 'tabs.close',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '关闭指定标签',
    usage: 'await hira.tabs.close(tabId)'
  },
  {
    method: 'tabs.reload',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '重新加载指定标签',
    usage: 'await hira.tabs.reload(tabId)'
  },
  {
    method: 'tabs.navigate',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '让当前活动标签导航到一个 URL',
    usage: "await hira.tabs.navigate('https://example.com')"
  },
  {
    method: 'tabs.pin',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '切换标签的固定状态',
    usage: 'await hira.tabs.pin(tabId)'
  },
  {
    method: 'tabs.mute',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '切换标签静音状态',
    usage: 'await hira.tabs.mute(tabId)'
  },
  {
    method: 'tabs.duplicate',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '复制一个标签',
    usage: 'await hira.tabs.duplicate(tabId)'
  },
  {
    method: 'tabs.undoClose',
    minLevel: 'ui',
    scope: 'tabs:modify',
    summary: '恢复最近关闭的标签',
    usage: 'await hira.tabs.undoClose()'
  },
  {
    method: 'tabs.stats',
    minLevel: 'ui',
    scope: 'tabs:read',
    summary: '标签统计（数量 / 固定 / 静音等）',
    usage: 'const stats = await hira.tabs.stats()'
  },

  // ── 书签 ──────────────────────────────────────────────────────────────
  {
    method: 'bookmarks.list',
    minLevel: 'ui',
    scope: 'bookmarks:read',
    summary: '某一层级的书签列表（缺省 = 根）',
    usage: 'const items = await hira.bookmarks.list(parentId)'
  },
  {
    method: 'bookmarks.tree',
    minLevel: 'ui',
    scope: 'bookmarks:read',
    summary: '完整书签树',
    usage: 'const tree = await hira.bookmarks.tree()'
  },
  {
    method: 'bookmarks.add',
    minLevel: 'ui',
    scope: 'bookmarks:write',
    summary: '新增一条书签（{ url, title, parentId, tags }）',
    usage: "await hira.bookmarks.add({ url: 'https://example.com', title: '示例' })"
  },
  {
    method: 'bookmarks.remove',
    minLevel: 'ui',
    scope: 'bookmarks:write',
    summary: '删除一条书签（传 id 或 { id }）',
    usage: 'await hira.bookmarks.remove(bookmarkId)'
  },
  {
    method: 'bookmarks.update',
    minLevel: 'ui',
    scope: 'bookmarks:write',
    summary: '修改一条书签（{ id, title, url, tags … }）',
    usage: "await hira.bookmarks.update({ id, title: '新标题' })"
  },
  {
    method: 'bookmarks.move',
    minLevel: 'ui',
    scope: 'bookmarks:write',
    summary: '把书签移动到另一个文件夹（{ id, parentId }）',
    usage: 'await hira.bookmarks.move({ id, parentId })'
  },

  // ── 设置 ──────────────────────────────────────────────────────────────
  {
    method: 'settings.get',
    minLevel: 'ui',
    scope: 'settings:read',
    summary: '读取一个浏览器设置项',
    usage: "const value = await hira.settings.get('theme')"
  },
  {
    method: 'settings.set',
    minLevel: 'ui',
    scope: 'settings:write',
    summary: '写入一个浏览器设置项（需用户显式授权 settings:write）',
    usage: "await hira.settings.set('theme', 'dark')"
  },

  // ── 剪贴板 ────────────────────────────────────────────────────────────
  {
    method: 'clipboard.read',
    minLevel: 'ui',
    scope: 'clipboard',
    summary: '读取文本剪贴板',
    usage: 'const text = await hira.clipboard.read()'
  },
  {
    method: 'clipboard.write',
    minLevel: 'ui',
    scope: 'clipboard',
    summary: '写入文本剪贴板',
    usage: "await hira.clipboard.write('hello')"
  },

  // ── 渲染侧插槽（插件面板也能往别人的位置挂东西）─────────────────────────
  {
    method: 'slots.call',
    minLevel: 'ui',
    scope: null,
    summary: '调用一个渲染侧插槽（slots.call(id, payload)）',
    usage: "const out = await hira.slots.call('tab-row:actions', { tab })"
  },
  {
    method: 'slots.reduce',
    minLevel: 'ui',
    scope: null,
    summary: '链式归约一个渲染侧插槽（slots.reduce(id, payload)）',
    usage: "const out = await hira.slots.reduce('tab-row:decorate', { tab })"
  },

  // ── 宿主自述（只读：让面板按"这台机器现在有什么"决定画什么）──────────
  {
    method: 'panels.list',
    minLevel: 'ui',
    scope: null,
    summary: '当前已挂载 / 可用的面板清单',
    usage: 'const panels = await hira.panels.list()'
  },
  {
    method: 'theme.list',
    minLevel: 'ui',
    scope: null,
    summary: '主题目录 + 当前主题 id',
    usage: 'const { themes, activeId } = await hira.theme.list()'
  },
  {
    method: 'features.available',
    minLevel: 'ui',
    scope: null,
    summary: '某个功能面是否可用（引擎被禁用时返回 false）',
    usage: "const { available } = await hira.features.available('ai')"
  },
  {
    method: 'page.open',
    minLevel: 'ui',
    scope: null,
    summary: '用新标签打开一个内部页（host 见 pages.mjs）',
    usage: "await hira.page.open('themes')"
  },

  // ── 宿主交互 ──────────────────────────────────────────────────────────
  {
    method: 'window.open',
    minLevel: 'ui',
    scope: null,
    summary: '打开一个宿主内置窗口（类型由主进程裁定）',
    usage: "await hira.window.open('settings')"
  },
  {
    method: 'ui.confirm',
    minLevel: 'ui',
    scope: null,
    summary: '弹宿主风格确认框，返回 boolean',
    usage: "if (await hira.ui.confirm({ title: '删除？', danger: true })) { /* … */ }"
  },
  {
    method: 'log',
    minLevel: 'ui',
    scope: null,
    summary: '在宿主控制台打一条带插件前缀的日志',
    usage: "await hira.log('state', { count: 3 })"
  }
])

/**
 * 面板可以订阅的事件通道（`hira.on(channel, handler)` → 返回退订函数）。
 *
 * **白名单**，不是任意 IPC 事件名 —— 桥只转发这里列出的通道。
 *
 * @type {ReadonlyArray<{ channel: string, minLevel: string, scope: string|null, summary: string }>}
 */
export const PANEL_UI_EVENTS: ReadonlyArray<{ channel: string, minLevel: string, scope: string|null, summary: string }> = Object.freeze([
  { channel: 'theme:changed', minLevel: 'ui', scope: null, summary: '主题切换（宿主令牌已更新）' },
  { channel: 'tabs:changed', minLevel: 'ui', scope: 'tabs:read', summary: '标签增删 / 切换 / 更新' },
  { channel: 'bookmarks:changed', minLevel: 'ui', scope: 'bookmarks:read', summary: '书签变更' },
  { channel: 'plugins:changed', minLevel: 'ui', scope: null, summary: '插件启用 / 禁用 / 安装 / 卸载' },
  { channel: 'panels:changed', minLevel: 'ui', scope: null, summary: '面板显示 / 隐藏 / 重排 / 标题变更' }
])

/**
 * 宿主在面板文档里**自动注入**的东西（按出现顺序）。
 * 面板作者不需要、也不应该自己写这些 —— 大部分写了也会被 CSP 拒。
 *
 * @type {ReadonlyArray<{ order: number, what: string, detail: string }>}
 */
export const PANEL_UI_HOST_INJECTS: ReadonlyArray<{ order: number, what: string, detail: string }> = Object.freeze([
  { order: 1, what: '<meta charset="utf-8">', detail: 'srcdoc 没有响应头可带编码，中文靠它' },
  { order: 2, what: '<meta http-equiv="Content-Security-Policy">', detail: '按 permissionLevel 派生（default-src none；script-src 只有 hira-plugin: 与 inline）' },
  { order: 3, what: '<base href="hira-plugin://<插件id>/">', detail: '相对路径（./panel.js、./a.png）自动指向插件目录；自己写 <base> 会被 base-uri 拦掉' },
  { order: 4, what: '主题变量 <style>:root{--hira-*:…}</style>', detail: '颜色直接写 var(--hira-panel-fg) 等，深色模式自动跟随' },
  { order: 5, what: '身份脚本', detail: 'window.__hiraPanelUiPluginId + <html data-hira-*>（见 PANEL_UI_HOST_DATA_ATTRS）' },
  { order: 6, what: '桥脚本', detail: '定义 window.hira（不可写、不可配置）；一定在插件自己的脚本之前执行' },
  { order: 7, what: '最小基础样式', detail: 'margin:0 / 系统字体 / 透明背景 / box-sizing' }
])

/**
 * `<html>` 上的 data-* 约定（与 `PANEL_UI_HOST_DATA_ATTRS` 一一对应）。
 * 纯 CSS 分支 / 调试面板 / 截图工具都靠它，不用去问宿主。
 */
export const PANEL_UI_DATA_ATTRIBUTES = Object.freeze([
  { name: PANEL_UI_HOST_DATA_ATTRS.pluginId, value: '插件 id（小写目录名）', example: 'pinned-bookmarks' },
  { name: PANEL_UI_HOST_DATA_ATTRS.panelId, value: '面板 id（= contributes.panels[].id）', example: 'pinned' },
  { name: PANEL_UI_HOST_DATA_ATTRS.panelKind, value: `文档种类（${PANEL_UI_KINDS.join(' / ')}）`, example: 'html' },
  { name: PANEL_UI_HOST_DATA_ATTRS.permissionLevel, value: 'none / ui / network / full', example: 'ui' },
  { name: PANEL_UI_HOST_DATA_ATTRS.firstParty, value: '"true" / "false"（第一方免逐个 scope 授权）', example: 'false' },
  { name: PANEL_UI_HOST_DATA_ATTRS.bridgeVersion, value: `桥协议版本（当前 ${PANEL_UI_BRIDGE_VERSION}）`, example: String(PANEL_UI_BRIDGE_VERSION) }
])

/**
 * manifest 里面板那一段的**完整可复制示例**。
 * 除 `contributes.panels[]` 外的字段都要按插件实际情况改。
 */
const MANIFEST_EXAMPLE = `{
  "id": "pinned-bookmarks",
  "name": "固定书签",
  "version": "1.0.0",
  "description": "把常用书签钉在侧栏",
  "author": "you",
  "permissionLevel": "ui",
  "requestedPermissions": ["bookmarks:read", "storage:read", "storage:write", "tabs:modify"],
  "contributes": {
    "panels": [
      {
        "id": "pinned",
        "title": "固定书签",
        "icon": "Bookmark",
        "ui": "panel.html"
      }
    ]
  }
}`

/**
 * `panel.html` 骨架 —— 直接复制改名即可。
 *
 * 三件事是刻意的：
 *   · 不写 `<base>` / CSP / hira:// 脚本地址（宿主注入，写了也会被 CSP 拒）；
 *   · 脚本用**经典脚本**（不能 `type="module"` —— opaque origin + 无 CORS 头）；
 *   · 只引用**包内相对路径**（不能引 CDN，script-src 不含 https）。
 */
const PANEL_HTML_EXAMPLE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>固定书签</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; padding: 12px;
      font: 13px/1.5 ${uiFontVar()};
      color: var(--hira-panel-fg, var(--hira-text-primary));
      background: transparent;
    }
    .row { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; }
    .row:hover { background: var(--hira-hover-bg); }
    /* 只给第一方插件看的元素 —— 纯 CSS 分支，不写 JS */
    .first-party-only { display: none; }
    html[data-hira-first-party="true"] .first-party-only { display: block; }
  </style>
</head>
<body>
  <h1 id="title">加载中…</h1>
  <div id="list"></div>

  <!-- 普通脚本：路径相对插件目录（宿主已注入 base 标签，指向 hira-plugin://<插件id>/） -->
  <!-- 不能写 type="module"：opaque origin 下会被 CORS 拦；也不能引 CDN -->
  <script src="./panel.js"></script>
</body>
</html>`

/**
 * `panel.js` 骨架 —— 展示 `hira.*` 的四类用法（身份 / 能力自查 / 持久化 / 事件）。
 * 用 async IIFE 包住：经典脚本没有顶层 await。
 */
const PANEL_SCRIPT_EXAMPLE = `(async function () {
  // window.hira 在宿主桥脚本里已经就位（一定早于本文件执行）。
  const info = await hira.app.info()
  document.title = '固定书签 · ' + info.panelId

  // 1) 我有哪些能力？（运行时自报，不用背文档）
  const caps = await hira.capabilities()
  console.log('可用能力', caps.map((c) => c.method))

  // 2) 持久化：沙箱是 opaque origin —— 没有 localStorage / cookie / IndexedDB，
  //    一律走宿主存储（按 profile + 插件隔离）。
  const pinned = (await hira.storage.get('pinned')) || []
  await hira.storage.set('pinned', pinned)

  // 3) 主题：直接读宿主令牌（也可以纯 CSS 用 var(--hira-*)）
  const tokens = await hira.theme.tokens()
  document.body.style.background = tokens['--hira-panel-bg'] || 'transparent'

  // 4) 事件：返回退订函数，卸载时一定要调，否则桥会一直往死 iframe 里发消息。
  const off = hira.on('bookmarks:changed', () => refresh())
  window.addEventListener('pagehide', () => off())

  await refresh()

  async function refresh() {
    const items = await hira.bookmarks.list()
    const list = document.getElementById('list')
    list.textContent = ''
    for (const item of items) {
      if (!item || !item.url) continue // 文件夹 / 分隔项跳过
      const row = document.createElement('div')
      row.className = 'row'
      row.textContent = item.title || item.url
      row.onclick = () => hira.tabs.open(item.url)
      list.appendChild(row)
    }
  }
})()`

/** 面板作者最容易踩的坑（顺序 = 踩坑频率）。 */
const AUTHORING_NOTES = Object.freeze([
  '<script type="module"> 不可用：srcdoc iframe 是 opaque origin，模块脚本按 CORS 取，而 hira-plugin:// 不发 Access-Control-Allow-Origin。用经典脚本 + async IIFE。',
  '不能引用 CDN / 外链脚本或样式：CSP 的 script-src 只有 hira-plugin: 与 inline，即使 permissionLevel=network 也不放开（network 只放开 img/media/connect）。',
  '不需要、也不应该自己写 <base> 或 CSP：宿主已在 head 最前面注入；自己写的 <base> 会被 base-uri 拦掉。',
  '相对路径直接写 ./panel.js / ./icon.svg：宿主注入了 <base href="hira-plugin://<插件id>/">。',
  '不要跨插件共享状态：storage 按 profile + 插件隔离，读不到别人的键。',
  'manifest 里只写 requestedPermissions（想用什么），不要写已授权 scope —— 授权由用户在插件中心确认。',
  'render 与 ui 是两条不同实现路径：render 必须是 .js/.mjs/.cjs 模块；panel.html 这类文档只能写 ui。',
  '实现来源三者取一：manifest.render（代码画界面）/ contributes.panels[].ui（声明式 HTML/XAML）/ 宿主内置 ui-panel-* 包。',
  'hira.on() 返回退订函数，页面卸载时必须调用（否则桥会持续向已销毁的 iframe 发事件）。',
  'window.hira 被 defineProperty 钉死（不可写 / 不可配置），插件脚本无法覆盖或伪造。'
])

/**
 * 一次性拿到「怎么写一块声明式面板」的全部答案。
 *
 * 返回的对象是**新副本**（调用方可以安全地裁剪 / 序列化进 JSON 响应）。
 *
 * @returns {{
 *   scheme: string,
 *   sandbox: string,
 *   bridgeVersion: number,
 *   manifestExample: string,
 *   panelHtml: string,
 *   panelScript: string,
 *   hostInjects: Array<{ order: number, what: string, detail: string }>,
 *   dataAttributes: Array<{ name: string, value: string, example: string }>,
 *   capabilities: Array<{ method: string, minLevel: string, scope: string|null, summary: string, usage: string }>,
 *   events: Array<{ channel: string, minLevel: string, scope: string|null, summary: string }>,
 *   notes: string[]
 * }}
 */
export function panelUiAuthoringGuide() : {
  scheme: string,
  sandbox: string,
  bridgeVersion: number,
  manifestExample: string,
  panelHtml: string,
  panelScript: string,
  hostInjects: Array<{ order: number, what: string, detail: string }>,
  dataAttributes: Array<{ name: string, value: string, example: string }>,
  capabilities: Array<{ method: string, minLevel: string, scope: string|null, summary: string, usage: string }>,
  events: Array<{ channel: string, minLevel: string, scope: string|null, summary: string }>,
  notes: string[]
} {
  return {
    scheme: PANEL_UI_SCHEME,
    sandbox: PANEL_UI_SANDBOX,
    bridgeVersion: PANEL_UI_BRIDGE_VERSION,
    manifestExample: MANIFEST_EXAMPLE,
    panelHtml: PANEL_HTML_EXAMPLE,
    panelScript: PANEL_SCRIPT_EXAMPLE,
    hostInjects: PANEL_UI_HOST_INJECTS.map((row) => ({ ...row })),
    dataAttributes: PANEL_UI_DATA_ATTRIBUTES.map((row) => ({ ...row })),
    capabilities: PANEL_UI_CAPABILITIES.map((row) => ({ ...row })),
    events: PANEL_UI_EVENTS.map((row) => ({ ...row })),
    notes: AUTHORING_NOTES.slice()
  }
}

/** Markdown 表格单元格转义（说明里可能出现 `|` 或换行）。 */
function cell(value: unknown): string {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * 手册分节定义 —— **唯一编排点**。
 *
 * 为什么分节：一次工具结果进模型有 6KB 上限（`turn-runner#TOOL_RESULT_LIMIT`），
 * 整本约 10KB 会被硬截断，模型读到的反而是残句。按「一次只给用得上的那几节」下发，
 * 既不超限，也不白占上下文。
 *
 * 加内容 = 往对应 `build` 里加，或在数组末尾加一节；`studio_guide` 会自动看见。
 * `build(g, add)`：`g` 是 `panelUiAuthoringGuide()`，`add()` 往当前节追加一行。
 */
type AuthoringGuide = ReturnType<typeof panelUiAuthoringGuide>
type AuthoringAdd = (text?: string) => void

interface AuthoringSectionDefinition {
  id: string
  title: string
  summary: string
  build: (guide: AuthoringGuide, add: AuthoringAdd) => void
}

const AUTHORING_SECTIONS: readonly AuthoringSectionDefinition[] = [
  {
    id: 'path',
    title: '先选实现路径（三选一）',
    summary: '声明式 UI / 渲染模块 / 内置包怎么选',
    build(g, add) {
      add('| 路径 | 写什么 | 什么时候用 |')
      add('| --- | --- | --- |')
      add('| **声明式 UI**（本规范重点） | `contributes.panels[].ui` 指向插件内 `.html` / `.xaml` | 只要一块界面 + `hira.*`；零构建、改完刷新即见 |')
      add('| 渲染模块 | `manifest.render` 指向 `.js` / `.mjs` / `.cjs`，导出 `rendererPlugin` 或 `panels[{ id, mount }]` | 要复用 `ui/` 组件、直接操作 DOM |')
      add('| 宿主内置包 | `ui-panel-*` | 官方面板，第三方不用管 |')
      add()
      add('**两条路径都没有 = 声明了一块画不出来的面板**，会被拒绝（`STUDIO_PANEL_NO_IMPL`）。')
    }
  },
  {
    id: 'manifest',
    title: 'manifest：`contributes.panels[]` 完整示例',
    summary: '可直接复制的 hira-plugin.json',
    build(g, add) {
      add('```json')
      add(g.manifestExample)
      add('```')
      add()
      add('- `ui` 是**契约字段**；`uiEntry` / `entry` / `html` / `view` / `page` / `file` / `src` / `path` / `render` 指向插件内 `.html`/`.xaml` 时也会被识别，创作侧会改写成 `ui` 并给一条 warning。')
      add('- `icon` 从 `studio_capabilities().icons` 里挑；也接受 `data:image/…`、`hira-plugin://…`、`<svg>…</svg>` 原文。')
      add('  认不出来的名字会回落 `Puzzle` 并给出 warning（不会留白）。')
      add('- `permissionLevel`：面板插件写 `ui`；`network` 只放开 `img/media/connect`，**永远不放开脚本外链**。')
      add('- `requestedPermissions` 写「想用什么 scope」。没声明就调用 `hira.storage.*` 等会直接 reject。')
      add('- 生成时 manifest 走 `studio_create` 的 `manifest` / `contributes` 参数（`files` 只放代码与资源）；`files` 里误放的 `hira-plugin.json` 会被当作 manifest 输入，但最终仍由系统重建。')
      add('- 顶层也可以写一次 `ui`，所有面板继承；面板项里只留 `id`。')
    }
  },
  {
    id: 'html',
    title: '`panel.html` 骨架（可直接复制）',
    summary: 'HTML 骨架 + 「什么不用写」对照表',
    build(g, add) {
      add('```html')
      add(g.panelHtml)
      add('```')
      add()
      add('### 什么**不用**写')
      add()
      add('| 你可能想写的 | 实际做法 |')
      add('| --- | --- |')
      add('| `hira-plugin://<id>/panel.js` 的脚本地址 | 写 `./panel.js`：宿主已注入 `<base href="hira-plugin://<插件id>/">` |')
      add('| `<base>` | **不要写**。宿主已注入，且 `base-uri` 只允许自身 —— 自己写的会被 CSP 拦掉 |')
      add('| `<meta http-equiv="Content-Security-Policy">` | **不要写**。宿主按 `permissionLevel` 派生并放在最前面 |')
      add('| `<script type="module">` | **不可用**。opaque origin 下模块按 CORS 取，而 `hira-plugin://` 不发 ACAO |')
      add('| CDN 的 `<script>` / `<link>` | **不可用**。`script-src` 只有 `hira-plugin:` 与 inline |')
      add('| `localStorage` / `cookie` / `IndexedDB` | **不存在**。持久化一律 `hira.storage.*` |')
    }
  },
  {
    id: 'script',
    title: '`panel.js` 骨架（可直接复制）',
    summary: '怎么拿 window.hira、怎么写事件',
    build(g, add) {
      add('```js')
      add(g.panelScript)
      add('```')
      add()
      add('`window.hira` 由宿主桥脚本定义，**一定早于插件自己的脚本执行**；经典脚本没有顶层 `await`，用 async IIFE。')
    }
  },
  {
    id: 'capabilities',
    title: '能力表（`window.hira.*`）',
    summary: '每条能力的方法 / 最低级别 / scope / 用法',
    build(g, add) {
      add(`共 ${g.capabilities.length} 条，全部经权限闸门校验。`)
      add()
      add('| 方法 | 最低级别 | scope | 说明 | 用法 |')
      add('| --- | --- | --- | --- | --- |')
      for (const cap of g.capabilities) {
        add(`| \`${cap.method}\` | ${cap.minLevel} | ${cap.scope ? `\`${cap.scope}\`` : '—'} | ${cell(cap.summary)} | \`${cell(cap.usage)}\` |`)
      }
      add()
      add('调用是 Promise：宿主 `ok:false` 时**直接 reject**，`try/catch` 或 `await` 即可。')
    }
  },
  {
    id: 'events',
    title: '事件订阅（`hira.on(channel, fn)`）',
    summary: '白名单事件 / scope / 退订约定',
    build(g, add) {
      add(`共 ${g.events.length} 条白名单。`)
      add()
      add('| 通道 | scope | 触发时机 |')
      add('| --- | --- | --- |')
      for (const ev of g.events) {
        add(`| \`${ev.channel}\` | ${ev.scope ? `\`${ev.scope}\`` : '—'} | ${cell(ev.summary)} |`)
      }
      add()
      add('返回**退订函数**；`pagehide` 时必须调用，否则桥会一直往已销毁的 iframe 发消息。')
    }
  },
  {
    id: 'injects',
    title: '宿主自动注入（7 段，按顺序；插件不写、也写不了）',
    summary: 'charset / CSP / base / 主题变量 / 身份脚本 / 桥 / 样式',
    build(g, add) {
      add('| # | 注入内容 | 作用 |')
      add('| --- | --- | --- |')
      for (const row of g.hostInjects) add(`| ${row.order} | ${cell(row.what)} | ${cell(row.detail)} |`)
    }
  },
  {
    id: 'data',
    title: '`<html>` 上的 `data-hira-*`（可以直接用）',
    summary: '宿主写入的 6 个属性 + 纯 CSS 分支示例',
    build(g, add) {
      add('| 属性 | 值 | 例子 |')
      add('| --- | --- | --- |')
      for (const row of g.dataAttributes) add(`| \`${row.name}\` | ${cell(row.value)} | \`${cell(row.example)}\` |`)
      add()
      add('由可信内联脚本写入，插件源码无法伪造。纯 CSS 分支最有用：')
      add()
      add('```css')
      add('html[data-hira-first-party="true"] .first-party-only { display: block; }')
      add('```')
    }
  },
  {
    id: 'notes',
    title: '高频踩坑（按频率排序）',
    summary: '照抄也会踩的坑',
    build(g, add) {
      g.notes.forEach((note, index) => add(`${index + 1}. ${note}`))
    }
  },
  {
    id: 'checklist',
    title: '提交前自检',
    summary: '逐条打勾，避免装完才发现空白',
    build(g, add) {
      add('- [ ] `contributes.panels[].ui` 指向的文件确实在 `files` 里，**大小写一致**。')
      add('- [ ] 用到 `hira.storage.*` / `hira.tabs.*` 等就声明了对应 scope。')
      add('- [ ] HTML 里没有 `<base>` / CSP / `type="module"` / CDN。')
      add('- [ ] 事件订阅在 `pagehide` 里退订。')
      add('- [ ] 插件 id 与面板 id 只含字母数字与 `. _ -`，以字母或数字开头。')
      add('- [ ] `icon` 来自 `studio_capabilities().icons`，或是一段可用的 SVG / data URL。')
    }
  }
]

/** 章节菜单（不含正文，体积很小）：用于索引展示与 `section` 参数校验。 */
export const PANEL_UI_AUTHORING_MENU = Object.freeze(
  AUTHORING_SECTIONS.map(({ id, title, summary }) => Object.freeze({ id, title, summary }))
)

/**
 * 「快速上手」包：一次工具结果（6KB 上限）内装得下的最常用几节。
 * 其余章节按需取 —— 见 `studio_guide` 的 `section` 参数。
 */
export const PANEL_UI_AUTHORING_DIGEST = Object.freeze(['path', 'manifest', 'html', 'script', 'notes'])

const AUTHORING_HEADER = [
  '# Hira 插件 · 声明式面板创作规范',
  '',
  '> 本文与运行时**同源**：`packages/shared-types/src/panel-ui-contract.mjs`。',
  '> 改契约 = 同时改这里、`hira.capabilities()` 与 `studio_capabilities().panelUi`。'
].join('\n')

/** 单节渲染：标题 + 正文，去掉尾部空行（节之间由调用方拼空行）。 */
function buildSection(section: AuthoringSectionDefinition, guide: AuthoringGuide): string {
  const lines: string[] = []
  const add: AuthoringAdd = (text = '') => { lines.push(text) }
  add(`## ${section.title}`)
  add()
  section.build(guide, add)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * 手册分节（含 id / 标题 / 一句话说明 / 正文）。
 * @returns {Array<{ id: string, title: string, summary: string, markdown: string }>}
 */
export function panelUiAuthoringSections() : Array<{ id: string, title: string, summary: string, markdown: string }> {
  const g = panelUiAuthoringGuide()
  return AUTHORING_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    summary: section.summary,
    markdown: buildSection(section, g)
  }))
}

/**
 * 同一份契约的 **Markdown 全文** —— 给「正在干活」的 AI / 作者当固定手册。
 *
 * 为什么不直接让调用方读 `panelUiAuthoringGuide()` 的 JSON：
 *   · JSON 里能力表的 `usage` 混在字段里，模型容易漏读；
 *   · 代码示例需要围栏才可直接复制；
 *   · 表格比嵌套对象更适合"照着做"。
 *
 * 内容全部来自上面的常量 —— **不存在第二份手写文档**。
 * 消费方：`studio_guide` 工具（分节取用）、文档导出。
 *
 * @param {string[]} [ids] 只要这几节（按传入顺序）；不传 = 全本。
 * @returns {string}
 */
export function panelUiAuthoringMarkdown(ids: string[]) : string {
  const wanted = Array.isArray(ids) && ids.length ? ids : null
  const picked = wanted
    ? wanted.map((id) => AUTHORING_SECTIONS.find((section) => section.id === id)).filter((section): section is AuthoringSectionDefinition => section !== undefined)
    : AUTHORING_SECTIONS
  const g = panelUiAuthoringGuide()
  const blocks = picked.map((section) => buildSection(section, g))
  return `${AUTHORING_HEADER}\n\n${blocks.join('\n\n')}\n`
}
