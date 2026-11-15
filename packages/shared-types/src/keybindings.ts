/**
 * 键盘快捷键 · 目录与组合键工具（**唯一真源**）
 *
 * ── 为什么要有这一份 ────────────────────────────────────────────────────
 * 快捷键有三处消费者，横跨两层：
 *   · 主进程（`apps/app-main/src/main/keybindings.js`）：默认键位、事件 → 组合串；
 *   · 内部页（`hira://shortcuts`）：分组、名称、默认值、录制时的键名归一；
 *   · 将来的命令面板 / 设置页搜索：同一份名称与分类。
 * 这三处各抄一份清单，必然出现"主进程能按、页面上查不到"或"改了名、页面上还是旧名"。
 * 所以清单与归一规则都只能在这里写一次：
 *   主进程 require 本文件（Electron 主进程可直接加载 .mjs）；
 *   内部页经 `hira://shared/keybindings.mjs` 读（构建期由 sync-shared-contracts 复制）。
 *
 * ── 结构 ────────────────────────────────────────────────────────────────
 * `KEYBINDING_GROUPS` 是**唯一**的清单：分组顺序 = 页面显示顺序；
 * 每条动作自带 `id / name / default`，默认键位映射（KEYBINDING_DEFAULTS）由它推导，
 * 不另写第二张表 —— 新增一条快捷键 = 在对应分组里加一行，主进程与页面同时生效。
 *
 * ⚠ 动作 id 是**持久化契约**：用户改过的键位以 `{ [id]: 'Ctrl+T' }` 存在设置里，
 *   改 id 等于让老用户的改键静默失效。给已有动作改名只动 `name`。
 */

/**
 * 分组 → 动作。组名沿用旧版 Hira 的「科学分类」口径（窗口 / 标签页 / 空间 / 分屏 /
 * 书签 / 导航与查找 / 页面 / 视图与布局 / 工具与面板）。
 */
export const KEYBINDING_GROUPS = Object.freeze(
  [
    {
      id: 'window',
      label: '窗口',
      actions: [
        { id: 'window:new', name: '新建窗口', default: 'Ctrl+N' },
        { id: 'window:new-incognito', name: '新建无痕窗口', default: 'Ctrl+Shift+N' }
      ]
    },
    {
      id: 'tab',
      label: '标签页',
      actions: [
        { id: 'tab:new', name: '新建标签页', default: 'Ctrl+T' },
        // 无痕**标签页**（NG 特性）：Ctrl+Shift+N 已归「无痕窗口」（对齐 Chrome），
        // 因此这里挪到 Ctrl+Alt+N。
        { id: 'tab:new-incognito', name: '新建无痕标签页', default: 'Ctrl+Alt+N' },
        { id: 'tab:close', name: '关闭当前标签页', default: 'Ctrl+W' },
        { id: 'tab:reload', name: '重新加载', default: 'Ctrl+R' },
        // 强制重新加载（跳过缓存）：与 Ctrl+R 成对，语义只有一处（TabManager 的硬刷新）。
        { id: 'tab:force-reload', name: '强制重新加载（跳过缓存）', default: 'Ctrl+Shift+R' },
        { id: 'tab:back', name: '后退', default: 'Alt+Left' },
        { id: 'tab:forward', name: '前进', default: 'Alt+Right' },
        { id: 'tab:next', name: '下一个标签页', default: 'Ctrl+Tab' },
        { id: 'tab:prev', name: '上一个标签页', default: 'Ctrl+Shift+Tab' },
        { id: 'tab:1', name: '切换到第 1 个标签页', default: 'Ctrl+1' },
        { id: 'tab:2', name: '切换到第 2 个标签页', default: 'Ctrl+2' },
        { id: 'tab:3', name: '切换到第 3 个标签页', default: 'Ctrl+3' },
        { id: 'tab:4', name: '切换到第 4 个标签页', default: 'Ctrl+4' },
        { id: 'tab:5', name: '切换到第 5 个标签页', default: 'Ctrl+5' },
        { id: 'tab:6', name: '切换到第 6 个标签页', default: 'Ctrl+6' },
        { id: 'tab:7', name: '切换到第 7 个标签页', default: 'Ctrl+7' },
        { id: 'tab:8', name: '切换到第 8 个标签页', default: 'Ctrl+8' },
        { id: 'tab:9', name: '切换到第 9 个标签页（最后一个）', default: 'Ctrl+9' },
        { id: 'tab:undo-close', name: '恢复关闭的标签页', default: 'Ctrl+Shift+T' },
        { id: 'tab:sleep', name: '立即休眠后台标签页', default: 'Ctrl+Shift+S' },
        // 标签页搜索：打开聚合总览面板（空间 + 搜索框 + 打开的标签 + 最近关闭）。
        { id: 'tab:search', name: '标签页搜索', default: 'Ctrl+Shift+A' },
        { id: 'tab:split-toggle', name: '分屏 / 解散分屏', default: 'Ctrl+Shift+D' },
        { id: 'tab:glance-toggle', name: '速览 / 退出速览', default: 'Ctrl+Shift+G' }
      ]
    },
    {
      id: 'space',
      label: '空间',
      actions: [
        { id: 'space:1', name: '切换到第 1 个空间', default: 'Ctrl+Shift+1' },
        { id: 'space:2', name: '切换到第 2 个空间', default: 'Ctrl+Shift+2' },
        { id: 'space:3', name: '切换到第 3 个空间', default: 'Ctrl+Shift+3' },
        { id: 'space:4', name: '切换到第 4 个空间', default: 'Ctrl+Shift+4' },
        { id: 'space:5', name: '切换到第 5 个空间', default: 'Ctrl+Shift+5' },
        { id: 'space:6', name: '切换到第 6 个空间', default: 'Ctrl+Shift+6' },
        { id: 'space:7', name: '切换到第 7 个空间', default: 'Ctrl+Shift+7' },
        { id: 'space:8', name: '切换到第 8 个空间', default: 'Ctrl+Shift+8' },
        { id: 'space:9', name: '切换到第 9 个空间（最后一个）', default: 'Ctrl+Shift+9' }
      ]
    },
    {
      id: 'split',
      label: '分屏',
      actions: [
        { id: 'split:focus-left', name: '切换到左侧分屏格', default: 'Ctrl+Alt+Left' },
        { id: 'split:focus-right', name: '切换到右侧分屏格', default: 'Ctrl+Alt+Right' },
        { id: 'split:focus-up', name: '切换到上方分屏格', default: 'Ctrl+Alt+Up' },
        { id: 'split:focus-down', name: '切换到下方分屏格', default: 'Ctrl+Alt+Down' }
      ]
    },
    {
      id: 'bookmark',
      label: '书签',
      actions: [
        { id: 'bookmark:toggle', name: '编辑当前页面书签', default: 'Ctrl+D' },
        { id: 'bookmarkbar:toggle', name: '显示或隐藏书签栏', default: 'Ctrl+Shift+B' },
        { id: 'bookmarks:open', name: '打开书签管理', default: 'Ctrl+Shift+O' }
      ]
    },
    {
      id: 'nav',
      label: '导航与查找',
      actions: [
        { id: 'nav:focus-url', name: '聚焦地址栏', default: 'Ctrl+L' },
        // Alt+D（Chrome / Edge）与 F6（IE 传统）是同一动作的别名：一套 combo → action
        // 的映射里一个动作只能挂一个组合，所以各占一条，但指向同一个 handler。
        { id: 'nav:focus-url-alt', name: '聚焦地址栏（Alt+D）', default: 'Alt+D' },
        { id: 'nav:focus-url-f6', name: '聚焦地址栏（F6）', default: 'F6' },
        { id: 'find:open', name: '页内查找', default: 'Ctrl+F' },
        { id: 'find:next', name: '下一个匹配项', default: 'F3' },
        { id: 'find:prev', name: '上一个匹配项', default: 'Shift+F3' }
      ]
    },
    {
      id: 'page',
      label: '页面',
      actions: [
        { id: 'page:print', name: '打印页面', default: 'Ctrl+P' },
        { id: 'page:save', name: '保存网页', default: 'Ctrl+S' },
        { id: 'view:view-source', name: '查看源代码', default: 'Ctrl+U' }
      ]
    },
    {
      id: 'view',
      label: '视图与布局',
      actions: [
        // Ctrl+= 是"放大"那条键的下档；Ctrl+Shift+= 就是主键盘上标着 '+' 的那个键
        // （= 的上档）—— 不额外声明的话，用户按「Ctrl 和 +」会毫无反应。
        { id: 'zoom:in', name: '放大页面', default: 'Ctrl+=' },
        { id: 'zoom:in-plus', name: '放大页面（Shift+= 即 + 键）', default: 'Ctrl+Shift+=' },
        { id: 'zoom:out', name: '缩小页面', default: 'Ctrl+-' },
        { id: 'zoom:reset', name: '重置缩放', default: 'Ctrl+0' },
        { id: 'layout:toggle-vertical-tabs', name: '切换垂直标签布局', default: 'Ctrl+Shift+,' },
        { id: 'view:toggle-fullscreen', name: '切换全屏', default: 'F11' },
        { id: 'view:toggle-break', name: '专注模式（Break）', default: 'Ctrl+Alt+B' },
        { id: 'view:reader-mode', name: '阅读模式', default: 'F9' },
        { id: 'view:devtools', name: '开发者工具', default: 'Ctrl+Shift+I' }
      ]
    },
    {
      id: 'tools',
      label: '工具与面板',
      actions: [
        { id: 'capture:open-hub', name: '收集当前页面', default: 'Ctrl+Shift+U' },
        { id: 'panel:notes-collections', name: '打开集锦面板', default: 'Ctrl+Shift+Y' },
        { id: 'history:open', name: '打开历史记录', default: 'Ctrl+H' },
        { id: 'downloads:open', name: '打开下载', default: 'Ctrl+J' },
        { id: 'clear-data:open', name: '打开清除浏览数据', default: 'Ctrl+Shift+Delete' }
      ]
    }
  ].map((group) =>
    Object.freeze({
      ...group,
      actions: Object.freeze(group.actions.map((action) => Object.freeze({ group: group.id, ...action })))
    })
  )
)

/** 动作 id → 元信息（含分组 id）。扁平索引，查一次 O(1)。 */
export const KEYBINDING_META = Object.freeze(
  (() => {
    const map: Record<string, (typeof KEYBINDING_GROUPS)[number]['actions'][number]> = Object.create(null)
    for (const group of KEYBINDING_GROUPS) {
      for (const action of group.actions) map[action.id] = action
    }
    return map
  })()
)

/** 默认键位表（由上面那张目录推导 —— 不另写第二份清单）。 */
export const KEYBINDING_DEFAULTS = Object.freeze(
  (() => {
    const map: Record<string, string> = {}
    for (const group of KEYBINDING_GROUPS) {
      for (const action of group.actions) map[action.id] = action.default
    }
    return map
  })()
)

/**
 * 动作 id → 中文名。未知 id 原样返回（协议端点 / 插件动作也能显示）。
 * @param {string} action
 * @returns {string}
 */
export function keybindingActionName (action: string) : string {
  const meta = KEYBINDING_META[String(action || '')]
  return meta ? meta.name : String(action || '')
}

/** 修饰键在组合串里的固定顺序（Ctrl / Shift / Alt / Meta）。 */
export const MODIFIER_ORDER = Object.freeze(['Ctrl', 'Shift', 'Alt', 'Meta'])

/** 浏览器键名别名 → 组合串里的规范键名（与 EVENT_CODE_KEYS 一起构成归一规则）。 */
export const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ' ': 'Space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc'
})

/**
 * 物理键名（KeyboardEvent.code）→ 组合键里的键名。
 *
 * 为什么标点必须按 code 而不是 key：按住 Shift 时 `key` 会变成**上档字符**
 * （Shift + , 是 '<'、Shift + / 是 '?'）—— 只按 key 记，声明好的 `Ctrl+Shift+,`
 * 永远匹配不上，而且换键盘布局也会失效。标点一律记**物理键**。
 */
export const EVENT_CODE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '='
})

/**
 * 单个键名归一：别名 → 规范名，F1–F12 统一大写，单字符统一大写。
 * @param {string} key
 * @returns {string}
 */
export function normalizeKeyName (key: string) : string {
  const value = KEY_ALIASES[key] || EVENT_CODE_KEYS[/** @type {keyof typeof EVENT_CODE_KEYS} */ ((key) as keyof typeof EVENT_CODE_KEYS)] || String(key || '').trim()
  if (/^f(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase()
  if (value.length === 1) return value.toUpperCase()
  return value
}

/** 数值 keyCode 的最后兜底（老式 Electron 载荷 / 合成事件可能只有这个字段）。 */
function keyFromKeyCode(keyCode: unknown): string {
  const code = Number(keyCode)
  if (!Number.isInteger(code)) return ''
  if (code >= 65 && code <= 90) return String.fromCharCode(code)
  if (code >= 48 && code <= 57) return String.fromCharCode(code)
  if (code >= 112 && code <= 123) return `F${code - 111}`
  const named: Readonly<Record<number, string>> = {
    8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Esc', 32: 'Space',
    33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
    37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 45: 'Insert',
    186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
    219: '[', 220: '\\', 221: ']', 222: "'"
  }
  return named[code] || ''
}

/**
 * 「按键状态」→ 组合串。主进程的 `before-input-event` 与页面里的 DOM `keydown`
 * 只是字段名不同（control / ctrlKey），归一规则在这里只有一份。
 *
 * @param {{ ctrl?: boolean, shift?: boolean, alt?: boolean, meta?: boolean,
 *          key?: string, code?: string, keyCode?: number }} input
 * @returns {string} 例如 'Ctrl+Shift+,'；只按了修饰键时返回 'Ctrl+Shift+'
 */
export interface KeyComboParts {
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
  key?: string
  code?: string
  keyCode?: number
}

export function comboFromParts(input: KeyComboParts): string {
  const parts = []
  if (input.ctrl) parts.push('Ctrl')
  if (input.shift) parts.push('Shift')
  if (input.alt) parts.push('Alt')
  if (input.meta) parts.push('Meta')
  // 标点优先按**物理键**（见 EVENT_CODE_KEYS）。
  const punctuation = EVENT_CODE_KEYS[/** @type {keyof typeof EVENT_CODE_KEYS} */ ((String(input.code || '')) as keyof typeof EVENT_CODE_KEYS)]
  // `key` 在部分输入法 / 合成事件（以及老式 before-input-event 载荷）里为空：
  // 只喂 key 会拼出 'Ctrl+' —— 一个永远不可能命中的组合，快捷键静默失灵。
  // 逐级退到物理键名（KeyA → A），最后 keyCode。
  const raw = input.key || (input.code && String(input.code).replace(/^Key/, '')) || keyFromKeyCode(input.keyCode)
  return [...parts, punctuation || normalizeKeyName(String(raw || ''))].join('+')
}

/** 显示用的键名符号（方向键换成箭头，和 RT / Chrome 的观感一致）。 */
const DISPLAY_KEYS: Readonly<Record<string, string>> = { Left: '←', Right: '→', Up: '↑', Down: '↓' }

/**
 * 组合串 → 展示文本：`Ctrl+Shift+,` → `Ctrl + Shift + ,`。
 * 空串返回空串（页面据此画"未设置"）。
 * @param {string} combo
 * @returns {string}
 */
export function formatKeybindingCombo (combo: string) : string {
  const parts = String(combo || '').split('+').filter(Boolean)
  return parts.map((part) => DISPLAY_KEYS[part] || part).join(' + ')
}

/**
 * 菜单动作名 → 快捷键 id —— **所有菜单面共用的唯一对应表**。
 *
 * 为什么必须有一张共用表：同一个菜单项会在四个地方出现（应用菜单、
 * 网页右键、PWA 应用窗的 ⋮、浏览器外壳的 ⋮），各自手抄 `'Ctrl+T'`
 * 的结果是四份会漂移的副本（已经漂过：`CmdOrCtrl+Plus`、`F12` 与
 * `Ctrl+Shift+I` 冲突），且用户改键后菜单还在撒谎。
 *
 * 各菜单面的**动作名是自己的命名空间**（插件 `command` 派发也用应用菜单这套名字），
 * 所以这里按"动作名 → 键位 id"登记，不要求四个面共用同一套动作名。
 * 只登记「本身有快捷键」的项：设置 / 扩展 / 密码… 本来没有键位，
 * 自然不显示提示，不需要再写"不显示"的分支。
 *
 * ⚠ 新增菜单项时：动作名在这里补一行即可，**不要**再写字面量组合键。
 */
export const MENU_ACTION_KEYBINDINGS: Readonly<Record<string, string>> = Object.freeze({
  // ── 应用菜单（main/app-menu.js）／插件 `command` 派发 ──────────────────
  windowNew: 'window:new',
  windowNewIncognito: 'window:new-incognito',
  tabNew: 'tab:new',
  tabNewIncognito: 'tab:new-incognito',
  tabClose: 'tab:close',
  openBookmarks: 'bookmarks:open',
  openHistory: 'history:open',
  openDownloads: 'downloads:open',
  pageSave: 'page:save',
  pagePrint: 'page:print',
  tabReload: 'tab:reload',
  tabForceReload: 'tab:force-reload',
  findInPage: 'find:open',
  readerMode: 'view:reader-mode',
  zoomIn: 'zoom:in',
  zoomOut: 'zoom:out',
  zoomReset: 'zoom:reset',
  toggleFullscreen: 'view:toggle-fullscreen',
  toggleDevTools: 'view:devtools',
  tabSearch: 'tab:search',
  tabNext: 'tab:next',
  tabPrev: 'tab:prev',
  tabSleep: 'tab:sleep',
  tabUndoClose: 'tab:undo-close',
  navBack: 'tab:back',
  navForward: 'tab:forward',
  bookmarkToggle: 'bookmark:toggle',
  openCollections: 'panel:notes-collections',
  captureHub: 'capture:open-hub',
  openClearData: 'clear-data:open',
  openViewSource: 'view:view-source',
  // ── 网页右键（infra-window#context-menu-model 的 command 名）──────────
  reload: 'tab:reload',
  back: 'tab:back',
  forward: 'tab:forward',
  print: 'page:print',
  'view-source': 'view:view-source',
  inspect: 'view:devtools',
  // ── PWA 应用窗 ⋮（renderer/subwindow/windows/pwa-app.js）─────────────
  find: 'find:open',
  'zoom-in': 'zoom:in',
  'zoom-out': 'zoom:out',
  'zoom-reset': 'zoom:reset',
  devtools: 'view:devtools',
  // ── 浏览器外壳 ⋮（renderer/app-shell/main.js）────────────────────────
  newTab: 'tab:new',
  newTabIncognito: 'tab:new-incognito',
  newWindow: 'window:new',
  newWindowIncognito: 'window:new-incognito',
  history: 'history:open',
  bookmarks: 'bookmarks:open',
  downloads: 'downloads:open',
  collections: 'panel:notes-collections'
})

/** 组合串里的键名 → Electron accelerator 的写法（`=` 即主键盘的 `+` 键）。 */
const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({ '=': 'Plus', '+': 'Plus' })

/**
 * 组合串 → Electron accelerator：`Ctrl+Shift+,` → `CommandOrControl+Shift+,`。
 *
 * `formatKeybindingCombo` 是**给人看的**（带空格、方向键画成箭头），
 * 直接喂 Electron 会被当成非法 accelerator —— 两者不能混用，所以分开两个函数。
 * `Ctrl` 统一写成 `CommandOrControl`：Windows / Linux 显示 Ctrl，macOS 显示 ⌘。
 *
 * @param {string} combo
 * @returns {string} 空串 = 没有键位（调用方据此不显示提示）
 */
export function toElectronAccelerator (combo: string) : string {
  const parts = String(combo || '').split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  return parts.map((part) => {
    if (part === 'Ctrl') return 'CommandOrControl'
    if (part === 'Meta') return 'Command'
    if (part === 'Esc') return 'Escape'
    return ELECTRON_KEY_NAMES[part] || part
  }).join('+')
}

/**
 * 菜单动作 → Electron accelerator（`''` = 这项没有快捷键，不显示）。
 *
 * 三个菜单面（应用菜单 / 右键 / ⋮）都走这一个入口读**当前生效**的键位，
 * 用户改键后菜单立刻跟随 —— 菜单里不允许再出现组合键字面量。
 *
 * @param {string} action 菜单动作名（见 `MENU_ACTION_KEYBINDINGS`）
 * @param {Record<string, string>} bindings 当前生效键位（`keybindings:get` 的结果）
 * @returns {string}
 */
export function menuAccelerator (action: string, bindings: Record<string, string>) : string {
  const id = MENU_ACTION_KEYBINDINGS[String(action || '')]
  const combo = id && bindings ? bindings[id] : ''
  return combo ? toElectronAccelerator(combo) : ''
}
