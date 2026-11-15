/**
 * panel-ui-bridge.js —— HTML / XAML 面板（沙箱 iframe）与宿主之间的**唯一通道**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要一条桥，而不是让插件直接用 `window.hira`
 * ══════════════════════════════════════════════════════════════════════
 * 面板内容跑在 `<iframe sandbox="allow-scripts allow-forms">` 里 —— 没有
 * `allow-same-origin`，文档停在 **opaque origin**：它拿不到父页面的任何对象，
 * 也读不到面板 preload 暴露的 `window.hira`（那是父窗口的）。
 *
 * 这正是安全模型的支点，所以"开放能力"只能走 `postMessage`：
 *   · 子侧拿到一个**泛化代理**（`window.hira.storage.get('k')` 这样调用即可），
 *     它不 import 任何东西、不知道 IPC 通道名，只认识"方法路径"；
 *   · 父侧用一张**能力表**逐条判定（权限级别 + scope 授权 + 参数上限 + 限流）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么能力表是单一端口
 * ══════════════════════════════════════════════════════════════════════
 * 过去"面板能做什么"散落在各面板自己的实现里。接口一开放，那必然变成
 * "这里放行一个、那里漏判一个"。所以：
 *   · **一个方法一条记录**，元信息 `{ minLevel, scope, summary }` 唯一真源在
 *     `panel-ui-contract.mjs`，实现 `run` 留在本文件，加载时合并并双向校验；
 *   · `hira.capabilities()` 直接把合并后的表回给插件 —— 文档与实现不可能漂移；
 *   · 新增能力 = 元信息加一条 + 实现加一条，父侧校验 / 子侧代理 / 权限闸门**都不需要改**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 不可削弱的硬约束（改这个文件前先读）
 * ══════════════════════════════════════════════════════════════════════
 *   1. `event.source === iframe.contentWindow` —— 只认这一扇窗，不认 origin 字符串；
 *   2. `event.origin` 必须是 opaque（srcdoc + 无 allow-same-origin 的必然结果）；
 *   3. 消息必须带 `__hira_panel_ui__ === 1` 标记（与页面其它 postMessage 隔离）；
 *   4. `args` 有 JSON 体积上限；超过直接拒（防止一条消息把主线程钉住）；
 *   5. 令牌桶限流 + 并发 pending 上限（防止插件写个 `while(true) hira.tabs.list()`）。
 *   6. 子侧 `window.hira` 用 `defineProperty` 钉死：不可写、不可配置 ——
 *      插件自己的脚本覆盖不掉，也就不存在"先骗过自己再骗宿主"的路径。
 */

import {
  PANEL_UI_BRIDGE_VERSION,
  normalizePermissionLevel,
  PANEL_UI_KINDS
} from '@hira-ng/shared-types/src/plugin-ui.mjs'
import {
  PANEL_UI_CAPABILITIES,
  PANEL_UI_EVENTS
} from '@hira-ng/shared-types/src/panel-ui-contract.mjs'
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import type { JsonRecord } from './bridge.js'
import type { PanelContext } from './panel-context.js'
import { errorMessage } from './error-message.js'

type PanelUiPermissionLevel = ReturnType<typeof normalizePermissionLevel>
type PanelUiArgs = readonly unknown[]

interface PanelUiBridgeEnvironment {
  pluginId: string
  panelId: string
  permissionLevel: PanelUiPermissionLevel
  isFirstParty: boolean
  themeTokens: () => Record<string, string>
  ctx: PanelContext
}

interface PanelUiCapabilityImplementation {
  run(args: PanelUiArgs, env: PanelUiBridgeEnvironment): unknown
}

interface PanelUiAccessPolicy {
  minLevel: string
  scope: string | null
}

interface PanelUiCapabilityDescriptor extends PanelUiAccessPolicy {
  summary: string
  run: PanelUiCapabilityImplementation['run']
}

interface PanelUiCapabilityInfo extends PanelUiAccessPolicy {
  method: string
  summary: string
}

interface PanelUiEventSubscriber {
  subscribe(ctx: PanelContext, listener: (payload: unknown) => void): unknown
}

interface PanelUiEventDescriptor extends PanelUiAccessPolicy {
  subscribe: PanelUiEventSubscriber['subscribe']
}

interface PanelUiSlotPort {
  call(slotId: string, payload: unknown, fallback?: unknown): unknown
  reduce(slotId: string, payload: unknown): unknown
}

interface PanelUiInvokeMessage {
  id: unknown
  method: string
  args: PanelUiArgs
}

interface ThemeCacheEntry {
  tokens: Record<string, string> | null
  css: string
  stamp: string
}

interface PanelUiPendingCall {
  resolve(value: unknown): void
  reject(reason?: unknown): void
}

type PanelUiBridgeNode = (...args: unknown[]) => Promise<unknown>

/** 子 → 父 消息标记（也用于父 → 子）。与页面里任何其它 `postMessage` 隔离。 */
const FLAG = '__hira_panel_ui__'

/** 单次调用的参数 JSON 上限（字符数，等价于字节量级的保守近似）。 */
const MAX_ARGS_CHARS = 256 * 1024

/** 同时在飞的调用上限。 */
const MAX_PENDING = 64
/** One panel cannot retain an unbounded listener set by varying subscription ids. */
const MAX_SUBSCRIPTIONS = 64

/** 令牌桶：10 秒 240 次（约 24 次/秒，足够任何界面交互）。 */
const RATE_CAPACITY = 240
const RATE_WINDOW_MS = 10_000

/** 权限级别排序 —— 唯一的比较口径。 */
const LEVEL_RANK = Object.freeze({ none: 0, ui: 1, network: 2, full: 3 })

/** 主题令牌的兜底清单（`getComputedStyle` 枚举不到时的最小集合）。 */
const CORE_TOKENS = Object.freeze([
  '--hira-bg',
  '--hira-bg-surface',
  '--hira-bg-elevated',
  '--hira-text-primary',
  '--hira-text-secondary',
  '--hira-text-tertiary',
  // 面板**自己**那一档前景（主题里可与工具栏分家）；面板作者应优先用它。
  '--hira-panel-fg',
  '--hira-panel-fg-soft',
  '--hira-panel-fg-muted',
  '--hira-panel-bg',
  '--hira-accent',
  '--hira-accent-bg',
  '--hira-accent-soft',
  '--hira-on-accent',
  '--hira-border-subtle',
  '--hira-hover-bg',
  '--hira-field-bg',
  '--hira-surface-soft',
  '--hira-chrome-bg',
  '--hira-chrome-fg',
  '--hira-danger',
  '--hira-warn',
  '--hira-success'
])

/**
 * 主题令牌缓存 —— `doc → { tokens, css, stamp }`。
 *
 * 为什么必须缓存：`collectThemeTokens()` 要枚举 `getComputedStyle(documentElement)`
 * 的**全部**属性并筛 `--hira-*`。每块面板每次渲染、每次 `hira.theme.tokens()` 都跑
 * 一遍，面板一多就是几十次全量样式枚举 —— 直接反映成打开面板时的掉帧。
 *
 * 失效判据是 `documentElement` 的内联 `style` 文本（`stamp`）：主题控制器
 * （`theme-controller.js#applyTokens`）就是往 `root.style.setProperty()` 写令牌，
 * 所以这份文本精确等于"当前主题令牌快照"。比较一个字符串属性（无布局、无样式计算）
 * 比每个面板都跑一次全量 `getComputedStyle` 便宜两个数量级。
 *
 * 为什么不用 MutationObserver：它是**微任务**回调。`themeClient.onChanged` 与
 * 主题控制器订阅的是同一条广播 —— 观察者回调还没跑时连桥就已经去读令牌，
 * 会拿到上一套颜色（切换主题后面板颜色慢一拍）。同步比对 `style` 属性没有这个问题。
 */
const themeCache = new WeakMap<Document, ThemeCacheEntry>()

/** @param {Document} doc */
function themeEntry(doc: Document | null | undefined): ThemeCacheEntry {
  // 没有文档（测试 / 极端时机）时给一个一次性空 entry，不写 WeakMap。
  if (!doc || typeof doc !== 'object') return { tokens: {}, css: '', stamp: '' }
  const hit = themeCache.get(doc)
  if (hit) return hit
  const entry: ThemeCacheEntry = {
    tokens: null,
    css: '',
    stamp: ''
  }
  themeCache.set(doc, entry)
  return entry
}

/** @param {Document} doc */
function themeStamp(doc: Document | null | undefined): string {
  const root = doc?.documentElement
  return root && typeof root.getAttribute === 'function' ? root.getAttribute('style') || '' : ''
}

/**
 * 收集宿主当前生效的主题令牌（`--hira-*`）。
 *
 * 为什么在**父侧**读、再作为字符串下发，而不是让 iframe 自己读：
 * opaque origin 的文档读不到父页面的 computed style；而把整张主题表当
 * `:root { … }` 注入 srcdoc，插件就能用与外壳完全一致的颜色（深色模式也自动跟随）。
 *
 * 结果按文档缓存；主题变化（`<html>` 内联样式变化）时同步失效。
 *
 * @param {Document} doc
 * @returns {Record<string, string>}
 */
export function collectThemeTokens(doc: Document) : Record<string, string> {
  const entry = themeEntry(doc)
  const stamp = themeStamp(doc)
  if (entry.tokens && entry.stamp === stamp) return entry.tokens

  const out: Record<string, string> = {}
  const root = doc && doc.documentElement
  const view = doc && doc.defaultView
  if (root && view && typeof view.getComputedStyle === 'function') {
    try {
      const style = view.getComputedStyle(root)
      for (let i = 0; i < style.length; i++) {
        const name = style[i]
        if (!name || name.indexOf('--hira-') !== 0) continue
        const value = style.getPropertyValue(name).trim()
        if (value) out[name] = value
      }
    } catch (_) {
      // 主题还没铺好（首帧）：走下面的兜底。
    }
  }
  for (const name of CORE_TOKENS) {
    if (out[name]) continue
    const value = root && typeof root.style?.getPropertyValue === 'function'
      ? root.style.getPropertyValue(name).trim()
      : ''
    if (value) out[name] = value
  }
  entry.tokens = out
  entry.stamp = stamp
  // 令牌变了 → 对应的 CSS 文本也作废（下次 `panelThemeStyle` 重拼一次）。
  entry.css = ''
  return out
}

/**
 * 面板文档要注入的 `:root{ … }` 文本（缓存版）。
 *
 * `themeTokensToCss()` 每次都做一次 `Object.entries` + `map` + `join`；而它在
 * **每次面板重渲**都会跑。把结果跟着令牌一起缓存在同一个 entry 里，
 * 主题不变时重渲就是纯字符串拼接。
 *
 * @param {Document} doc
 * @returns {string}
 */
export function panelThemeStyle(doc: Document) : string {
  const entry = themeEntry(doc)
  const tokens = collectThemeTokens(doc)
  if (!entry.css) entry.css = themeTokensToCss(tokens)
  return entry.css
}

/**
 * 令牌表 → `:root{ … }` 文本（注入进 srcdoc 的可信 CSS）。
 * @param {Record<string, string>} tokens
 * @returns {string}
 */
export function themeTokensToCss(tokens: Record<string, string>) : string {
  const pairs = Object.entries(tokens || {}).filter(([k, v]) => k && v)
  if (!pairs.length) return ''
  return `:root{${pairs.map(([k, v]) => `${k}:${String(v)}`).join(';')}}`
}

/**
 * 子侧运行时 —— **必须是自包含的纯函数**（会被 `.toString()` 内联进 srcdoc）。
 *
 * 设计要点（每一条都对应一类"面板作者会踩、宿主会崩"的问题）：
 *   · 泛化代理：任何 `hira.a.b.c(...)` 都映射成方法路径，宿主加能力不必改这里；
 *   · `then` / `toJSON` / `valueOf` … 一律返回 `undefined` —— 否则
 *     `await hira.storage` 会把代理当成 thenable，**永久挂起**；
 *   · `on(channel, fn)` 是唯一的本地特例：订阅要能拿到退订函数；
 *   · `Object.defineProperty(window, 'hira', …)` 钉死，插件覆盖不掉。
 */
function panelUiBridgeRuntime(): void {
  const FLAG = '__hira_panel_ui__'
  const STOP: Readonly<Record<string, number>> = {
    then: 1, toJSON: 1, valueOf: 1, toString: 1, constructor: 1,
    inspect: 1, nodeType: 1, prototype: 1, __proto__: 1
  }
  let seq = 0
  const pending = new Map<number, PanelUiPendingCall>()
  const listeners = new Map<string, (payload: unknown) => void>()

  function post(msg: unknown): void {
    try { window.parent.postMessage(msg, '*') } catch (_) {}
  }

  function call(path: readonly string[], args: readonly unknown[]): Promise<unknown> {
    return new Promise<unknown>(function (resolve, reject) {
      if (!path.length) { reject(new Error('hira: 需要调用一个方法，例如 hira.storage.get("k")')); return }
      const id = ++seq
      pending.set(id, { resolve: resolve, reject: reject })
      post({ [FLAG]: 1, type: 'invoke', id: id, method: path.join('.'), args: args })
    })
  }

  function node(path: readonly string[]): PanelUiBridgeNode {
    const fn = function (...args: unknown[]): Promise<unknown> { return call(path, args) }
    return new Proxy(fn, {
      get: function (_target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (STOP[prop]) return undefined
        if (prop === 'name') return path.join('.') || 'hira'
        if (prop === 'length') return 0
        if (prop === 'call' || prop === 'apply' || prop === 'bind') {
          const member: unknown = Reflect.get(fn, prop)
          if (typeof member === 'function') return member.bind(fn)
        }
        if (!path.length && prop === 'on') return subscribe
        if (!path.length && prop === 'pluginId') return window.__hiraPanelUiPluginId || ''
        return node(path.concat(String(prop)))
      },
      apply: function (_target, _thisArg, args) { return call(path, Array.prototype.slice.call(args)) },
      set: function () { return false },
      defineProperty: function () { return false },
      deleteProperty: function () { return false }
    })
  }

  function subscribe(channel: unknown, handler: unknown): () => void {
    if (typeof handler !== 'function') throw new TypeError('hira.on(channel, handler) 的第二个参数必须是函数')
    const id = 'sub' + (++seq)
    listeners.set(id, handler as (payload: unknown) => void)
    post({ [FLAG]: 1, type: 'subscribe', id: id, channel: String(channel) })
    return function () {
      if (!listeners.delete(id)) return
      post({ [FLAG]: 1, type: 'unsubscribe', id: id, channel: String(channel) })
    }
  }

  /**
   * 主题热更新：父侧把新的 `:root{…}` 推下来，**只换一段样式**，不重渲文档。
   *
   * 为什么不在主题切换时 `refresh()` 整块面板：重新组装 srcdoc 会让 iframe
   * 重新解析整份文档 —— 面板里的滚动位置、输入焦点、已展开的折叠项全丢，
   * 而用户只是切了个主题。换样式表是 O(样式长度)，重建文档是 O(整份界面)。
   */
  function applyTheme(css: unknown): void {
    if (typeof css !== 'string' || !css) return
    let style: HTMLElement | null = document.getElementById('__hira_theme__')
    if (!style) {
      style = document.createElement('style')
      style.id = '__hira_theme__'
      // 追加到 `head` 末尾 = 晚于宿主注入的 `:root{…}`，同特异性下后者胜出。
      ;(document.head || document.documentElement).appendChild(style)
    }
    style.textContent = css
  }

  window.addEventListener('message', function (event: MessageEvent<unknown>) {
    if (event.source !== window.parent) return
    if (!event.data || typeof event.data !== 'object') return
    const data = event.data as Record<string, unknown>
    if (data[FLAG] !== 1) return
    if (data.type === 'theme') {
      applyTheme(data.css)
      return
    }
    if (data.type === 'result') {
      if (typeof data.id !== 'number') return
      const slot = pending.get(data.id)
      if (!slot) return
      pending.delete(data.id)
      if (data.ok) slot.resolve(data.value)
      else slot.reject(new Error(String(data.error || 'hira 调用失败')))
      return
    }
    if (data.type === 'event') {
      if (typeof data.id !== 'string') return
      const fn = listeners.get(data.id)
      if (!fn) return
      try { fn(data.payload) } catch (_) {}
    }
  })

  const api = node([])
  try {
    Object.defineProperty(window, 'hira', {
      value: api,
      writable: false,
      configurable: false,
      enumerable: false
    })
  } catch (_) {
    // 已被定义（重复注入）：保留先到的那一个，绝不覆盖。
  }
}

/** 内联进 srcdoc 的桥脚本（静态串 —— 不含任何插件可控内容）。 */
export const PANEL_UI_BRIDGE_SCRIPT = `(${panelUiBridgeRuntime.toString()})();`

// ─────────────────────────────────────────────────────────────
// 父侧：能力表
// ─────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

/** 把参数里的第一个值归一成"要打开的 URL"。 */
function pickUrl(args: PanelUiArgs): string {
  const first = args[0]
  if (typeof first === 'string') return first
  const record = asRecord(first)
  if (typeof record?.url === 'string') return record.url
  return ''
}

/** 把参数里的第一个值归一成标签 id。 */
function pickTabId(args: PanelUiArgs): string {
  const first = args[0]
  if (typeof first === 'string') return first
  const record = asRecord(first)
  if (record?.tabId != null) return String(record.tabId)
  return ''
}

/**
 * 把参数里的第一个值归一成"插件存储键"。
 *
 * 空键在 IPC 契约里就是非法值（`z.string().min(1)`），在这里提前拦比让
 * 主进程回一句 `{ ok:false }` 更接近"调用方写错了"的语义。
 */
function pickKey(args: PanelUiArgs): string {
  const raw = args[0]
  const key = raw == null ? '' : String(raw)
  if (!key) throw new Error('storage 需要一个非空的键')
  if (key.length > 256) throw new Error('storage 键过长（上限 256 字符）')
  return key
}

/** 拆 IPC 信封：`ok:false` 抛错，成功时把整条结果交给调用方自己取字段。 */
function unwrapResult(result: JsonRecord | null | undefined, what: string): JsonRecord {
  if (result?.ok === false) {
    throw new Error(result.reason ? `${what} 失败：${result.reason}` : `${what} 失败`)
  }
  return result || {}
}

function errorText(value: unknown): string {
  const record = asRecord(value)
  if (record?.message != null) return String(record.message)
  return value == null ? '' : String(value)
}

function panelSlotPort(ctx: PanelContext): PanelUiSlotPort {
  const slots = asRecord(ctx.slots)
  if (!slots || typeof slots.call !== 'function' || typeof slots.reduce !== 'function') {
    throw new Error('当前宿主没有注入渲染侧插槽端口')
  }
  return slots as unknown as PanelUiSlotPort
}

/**
 * 能力**实现**表 —— 只放"怎么做"，不放"是什么"。
 *
 * `minLevel` / `scope` / `summary` 是元信息，唯一真源在
 * `@hira-ng/shared-types/src/panel-ui-contract.mjs#PANEL_UI_CAPABILITIES`；
 * 这里只按 `method` 提供 `run`（只允许调 `ctx` 里已有的客户端，不新开 IPC 通道）。
 *
 * 合并与校验见下面的 `CAPABILITIES`：缺实现 / 多实现都会在模块加载时抛错。
 */
const CAPABILITY_IMPLS: Readonly<Record<string, PanelUiCapabilityImplementation>> = Object.freeze({
  capabilities: {
    // 能力表是**静态**的：每次调用都重新遍历 30+ 条元信息只为了回一份 JSON。
    // 预计算一次即可 —— `postMessage` 会做结构化克隆，插件拿到的永远是副本，
    // 不可能反向污染宿主这张表。
    run: () => CAPABILITIES_LIST
  },
  'app.info': {
    run: (_args, env) => ({
      pluginId: env.pluginId,
      panelId: env.panelId,
      permissionLevel: env.permissionLevel,
      firstParty: env.isFirstParty,
      kinds: PANEL_UI_KINDS.slice(),
      bridgeVersion: PANEL_UI_BRIDGE_VERSION
    })
  },

  // ── 主题 ─────────────────────────────────────────────────────────────
  'theme.tokens': {
    run: (_args, env) => ({ ...(env.themeTokens() || {}) })
  },
  'theme.active': {
    run: (_args, env) => env.ctx.clients.themes.active()
  },

  // ── 插件存储（按 profile + 插件隔离）────────────────────────────────
  //
  // 这里**拆信封**：`plugins.storage*` 返回 `{ ok, ... }`（渲染层还要判断 IPC 成败），
  // 而插件作者想要的是"值本身"。两条语义在这里收口一次，别处不再各拆一遍。
  'storage.get': {
    run: async (args, env) => {
      const key = pickKey(args)
      const res = unwrapResult(await env.ctx.clients.plugins.storageGet(env.pluginId, key), 'storage.get')
      return res.value === undefined ? null : res.value
    }
  },
  'storage.keys': {
    run: async (_args, env) => {
      const res = unwrapResult(await env.ctx.clients.plugins.storageKeys(env.pluginId), 'storage.keys')
      return Array.isArray(res.keys) ? res.keys : []
    }
  },
  'storage.set': {
    run: async (args, env) => {
      const key = pickKey(args)
      const res = unwrapResult(await env.ctx.clients.plugins.storageSet(env.pluginId, key, args[1]), 'storage.set')
      return { ok: true, key, keys: res.keys == null ? null : Number(res.keys), bytes: res.bytes == null ? null : Number(res.bytes) }
    }
  },
  'storage.remove': {
    run: async (args, env) => {
      const key = pickKey(args)
      const res = unwrapResult(await env.ctx.clients.plugins.storageRemove(env.pluginId, key), 'storage.remove')
      return { removed: res.removed === true || Number(res.removed) > 0 }
    }
  },
  'storage.clear': {
    run: async (_args, env) => {
      const res = unwrapResult(await env.ctx.clients.plugins.storageClear(env.pluginId), 'storage.clear')
      return { removed: Number(res.removed) || 0 }
    }
  },

  // ── 标签 ─────────────────────────────────────────────────────────────
  'tabs.list': {
    run: (_args, env) => env.ctx.clients.tabs.list()
  },
  'tabs.projection': {
    run: (_args, env) => env.ctx.clients.tabs.projection()
  },
  'tabs.open': {
    run: (args, env) => {
      const url = pickUrl(args)
      if (!url) throw new Error('tabs.open 需要一个 URL')
      return env.ctx.clients.tabs.newTab({ url })
    }
  },
  'tabs.activate': {
    run: (args, env) => {
      const tabId = pickTabId(args)
      if (!tabId) throw new Error('tabs.activate 需要一个 tabId')
      return env.ctx.clients.tabs.switchTab(tabId)
    }
  },
  'tabs.close': {
    run: (args, env) => {
      const tabId = pickTabId(args)
      if (!tabId) throw new Error('tabs.close 需要一个 tabId')
      return env.ctx.clients.tabs.closeTab(tabId)
    }
  },
  'tabs.reload': {
    run: (args, env) => {
      const tabId = pickTabId(args)
      if (!tabId) throw new Error('tabs.reload 需要一个 tabId')
      return env.ctx.clients.tabs.reload(tabId)
    }
  },
  'tabs.navigate': {
    run: (args, env) => {
      const url = pickUrl(args)
      if (!url) throw new Error('tabs.navigate 需要一个 URL')
      return env.ctx.clients.tabs.navigate({ url })
    }
  },
  'tabs.pin': {
    run: (args, env) => {
      const tabId = pickTabId(args)
      if (!tabId) throw new Error('tabs.pin 需要一个 tabId')
      return env.ctx.clients.tabs.togglePin(tabId)
    }
  },
  'tabs.mute': {
    run: (args, env) => {
      const tabId = pickTabId(args)
      if (!tabId) throw new Error('tabs.mute 需要一个 tabId')
      return env.ctx.clients.tabs.toggleMute(tabId)
    }
  },
  'tabs.duplicate': {
    run: (args, env) => {
      const tabId = pickTabId(args)
      if (!tabId) throw new Error('tabs.duplicate 需要一个 tabId')
      return env.ctx.clients.tabs.duplicate(tabId)
    }
  },
  'tabs.undoClose': {
    run: (_args, env) => env.ctx.clients.tabs.undoClose()
  },
  'tabs.stats': {
    run: (_args, env) => env.ctx.clients.tabs.stats()
  },

  // ── 书签 ─────────────────────────────────────────────────────────────
  'bookmarks.list': {
    run: (args, env) => env.ctx.clients.bookmarks.list(args[0] == null ? undefined : String(args[0]))
  },
  'bookmarks.tree': {
    run: (_args, env) => env.ctx.clients.bookmarks.tree()
  },
  'bookmarks.add': {
    run: (args, env) => {
      const item = asRecord(args[0])
      if (!item?.url) throw new Error('bookmarks.add 需要 { url }')
      return env.ctx.clients.bookmarks.add({
        url: String(item.url),
        title: item.title == null ? undefined : String(item.title),
        nickname: item.nickname == null ? undefined : String(item.nickname),
        parentId: item.parentId == null ? undefined : String(item.parentId),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : undefined
      })
    }
  },
  'bookmarks.remove': {
    run: (args, env) => {
      const raw = args[0]
      const item = asRecord(raw)
      const id = typeof raw === 'string' ? raw : (item?.id != null ? String(item.id) : '')
      if (!id) throw new Error('bookmarks.remove 需要一个书签 id')
      return env.ctx.clients.bookmarks.remove(id)
    }
  },
  'bookmarks.update': {
    run: (args, env) => {
      const item = asRecord(args[0])
      if (!item || item.id == null) throw new Error('bookmarks.update 需要 { id, … }')
      return env.ctx.clients.bookmarks.update({ ...item, id: String(item.id) })
    }
  },
  'bookmarks.move': {
    run: (args, env) => {
      const item = asRecord(args[0])
      if (!item || item.id == null) throw new Error('bookmarks.move 需要 { id, parentId }')
      return env.ctx.clients.bookmarks.move(String(item.id), item.parentId == null ? null : String(item.parentId))
    }
  },

  // ── 设置 ─────────────────────────────────────────────────────────────
  'settings.get': {
    run: (args, env) => env.ctx.clients.settings.get(String(args[0] == null ? '' : args[0]))
  },
  'settings.set': {
    run: (args, env) => env.ctx.clients.settings.set(String(args[0] == null ? '' : args[0]), args[1])
  },

  // ── 剪贴板 ───────────────────────────────────────────────────────────
  'clipboard.read': {
    run: (_args, env) => env.ctx.bridge.provider.invoke(IPC_ROUTES.clipboardReadText)
  },
  'clipboard.write': {
    run: async (args) => {
      const text = String(args[0] == null ? '' : args[0])
      await navigator.clipboard.writeText(text)
      return { ok: true }
    }
  },

  // ── 渲染侧插槽（扩展点复用：插件面板也能"往别人的位置挂东西"）────────
  'slots.call': {
    run: (args, env) => panelSlotPort(env.ctx).call(String(args[0] == null ? '' : args[0]), args[1], null)
  },
  'slots.reduce': {
    run: (args, env) => panelSlotPort(env.ctx).reduce(String(args[0] == null ? '' : args[0]), args[1])
  },

  // ── 宿主自述（只读，帮助面板按实际情况决定画什么）───────────────────
  'panels.list': {
    // 用 `catalog()` 而不是 `list()`：作者需要的是「有哪些面板、它们叫什么、
    // 属于哪个插件」，光一串 id 还得再查一次。
    run: (_args, env) => env.ctx.clients.panels.catalog()
  },
  'theme.list': {
    run: (_args, env) => env.ctx.clients.themes.list()
  },
  'features.available': {
    run: (args, env) => {
      const id = String(args[0] == null ? '' : args[0]).trim()
      if (!id) throw new Error('features.available 需要一个 featureId')
      return { id, available: env.ctx.isFeatureAvailable(id) === true }
    }
  },
  'page.open': {
    run: (args, env) => {
      const host = String(args[0] == null ? '' : args[0]).trim()
      if (!host) throw new Error('page.open 需要一个内部页 host')
      return env.ctx.openPage(host)
    }
  },

  // ── 宿主交互 ─────────────────────────────────────────────────────────
  'window.open': {
    run: (args, env) => {
      const record = asRecord(args[0])
      const type = typeof args[0] === 'string' ? args[0] : String(record?.type || '')
      if (!type) throw new Error('window.open 需要一个窗口类型')
      return env.ctx.openWindow(type)
    }
  },
  'ui.confirm': {
    run: (args, env) => {
      const opts = asRecord(args[0]) || {}
      return env.ctx.confirm({
        title: opts.title == null ? undefined : String(opts.title),
        message: opts.message == null ? undefined : String(opts.message),
        danger: opts.danger === true,
        confirmLabel: opts.confirmLabel == null ? undefined : String(opts.confirmLabel),
        cancelLabel: opts.cancelLabel == null ? undefined : String(opts.cancelLabel)
      })
    }
  },
  log: {
    run: (args, env) => {
      console.log(`[panel-ui:${env.pluginId}]`, ...(Array.isArray(args) ? args : []))
      return { ok: true }
    }
  }
})

/**
 * 运行时能力表 = 元信息（唯一真源 `panel-ui-contract.mjs`）+ 实现（本文件）。
 *
 * 缺实现 / 多实现都在这里直接抛错 —— 宁可启动就失败，也不要出现
 * 「文档里写着一个能力、真调时回未知能力」这种漂移。
 */
const CAPABILITIES: Readonly<Record<string, PanelUiCapabilityDescriptor>> = Object.freeze(Object.fromEntries(
  PANEL_UI_CAPABILITIES.map((meta) => {
    const impl = CAPABILITY_IMPLS[meta.method]
    if (!impl || typeof impl.run !== 'function') {
      throw new Error(`[panel-ui-bridge] 能力「${meta.method}」缺少实现`)
    }
    return [meta.method, {
      minLevel: meta.minLevel,
      scope: meta.scope || null,
      summary: meta.summary,
      run: impl.run
    }]
  })
))
for (const method of Object.keys(CAPABILITY_IMPLS)) {
  if (!(method in CAPABILITIES)) {
    throw new Error(`[panel-ui-bridge] 能力「${method}」没有元信息（panel-ui-contract.mjs#PANEL_UI_CAPABILITIES）`)
  }
}

/**
 * `hira.capabilities()` 的返回值 —— **模块加载时算一次**。
 *
 * 之前每次调用都遍历整张表再 `map` 出一份新数组；能力表是静态的，
 * 这份开销没有理由重复付。`postMessage` 的结构化克隆会让插件拿到副本。
 */
const CAPABILITIES_LIST: readonly PanelUiCapabilityInfo[] = Object.freeze(
  Object.entries(CAPABILITIES).map(([method, cap]) => Object.freeze({
    method,
    minLevel: cap.minLevel,
    scope: cap.scope || null,
    summary: cap.summary
  }))
)

/**
 * 面板可以订阅的事件通道 —— **白名单**，不是"任意 IPC_EVENTS 键"。
 *
 * 为什么必须白名单：`bridge.on.subscribe()` 能订阅的通道是全局的（含跨窗口、
 * 含隐私相关的推送）。若把通道名原样透传给插件，"沙箱"就只剩一层窗户纸。
 */
const EVENT_SUBSCRIBERS: Readonly<Record<string, PanelUiEventSubscriber>> = Object.freeze({
  'theme:changed': {
    subscribe: (ctx, fn) => ctx.clients.themes.onChanged(fn)
  },
  'tabs:changed': {
    subscribe: (ctx, fn) => ctx.clients.tabs.onChanged(fn)
  },
  'bookmarks:changed': {
    subscribe: (ctx, fn) => ctx.clients.bookmarks.onChanged(fn)
  },
  'plugins:changed': {
    subscribe: (ctx, fn) => ctx.clients.plugins.onChanged(fn)
  },
  'panels:changed': {
    subscribe: (ctx, fn) => ctx.clients.panels.onChanged(fn)
  }
})

/**
 * 运行时事件表 = 元信息（`PANEL_UI_EVENTS`）+ 订阅实现（本文件），校验规则同上。
 */
const EVENT_CHANNELS: Readonly<Record<string, PanelUiEventDescriptor>> = Object.freeze(Object.fromEntries(
  PANEL_UI_EVENTS.map((meta) => {
    const impl = EVENT_SUBSCRIBERS[meta.channel]
    if (!impl || typeof impl.subscribe !== 'function') {
      throw new Error(`[panel-ui-bridge] 事件通道「${meta.channel}」缺少订阅实现`)
    }
    return [meta.channel, {
      minLevel: meta.minLevel,
      scope: meta.scope || null,
      subscribe: impl.subscribe
    }]
  })
))
for (const channel of Object.keys(EVENT_SUBSCRIBERS)) {
  if (!(channel in EVENT_CHANNELS)) {
    throw new Error(`[panel-ui-bridge] 事件通道「${channel}」没有元信息（panel-ui-contract.mjs#PANEL_UI_EVENTS）`)
  }
}

/**
 * 建一条面板桥。
 *
 * @param {{
 *   iframe: HTMLIFrameElement,
 *   pluginId: string,
 *   panelId: string,
 *   permissionLevel?: unknown,
 *   grantedPermissions?: string[]|Set<string>,
 *   isFirstParty?: boolean,
 *   themeTokens?: Record<string, string>|(() => Record<string, string>),
 *   ctx: unknown
 * }} options
 * @returns {{ dispose: () => void }}
 */
export function createPanelUiBridge(options: {
  iframe: HTMLIFrameElement,
  pluginId: string,
  panelId: string,
  permissionLevel?: unknown,
  grantedPermissions?: string[]|Set<string>,
  isFirstParty?: boolean,
  themeTokens?: Record<string, string>|(() => Record<string, string>),
  ctx: PanelContext
}) : { dispose: () => void } {
  const { iframe, pluginId, panelId, ctx } = options
  const level = normalizePermissionLevel(options.permissionLevel)
  const isFirstParty = options.isFirstParty === true
  const granted = options.grantedPermissions instanceof Set
    ? options.grantedPermissions
    : new Set(Array.isArray(options.grantedPermissions) ? options.grantedPermissions : [])
  const themeTokens = options.themeTokens

  const env: PanelUiBridgeEnvironment = {
    pluginId: String(pluginId || ''),
    panelId: String(panelId || ''),
    permissionLevel: level,
    isFirstParty,
    // 统一成函数：调用方给快照或给取值函数都行，能力表只认 `env.themeTokens()`。
    themeTokens: typeof themeTokens === 'function' ? themeTokens : () => (themeTokens || {}),
    ctx
  }

  /** 子 → 父 订阅：(subId) → 退订函数 */
  const subscriptions = new Map<string, () => void>()
  /** 在飞调用数 */
  let pendingCount = 0
  /** 令牌桶 */
  let tokens = RATE_CAPACITY
  let refilledAt = Date.now()
  let disposed = false

  function takeToken(): boolean {
    const now = Date.now()
    const elapsed = now - refilledAt
    if (elapsed > 0) {
      tokens = Math.min(RATE_CAPACITY, tokens + (elapsed / RATE_WINDOW_MS) * RATE_CAPACITY)
      refilledAt = now
    }
    if (tokens < 1) return false
    tokens -= 1
    return true
  }

  /** 权限闸门 —— 能力表里的 `minLevel` / `scope` 在这里被落实。 */
  function assertAllowed(cap: PanelUiAccessPolicy, what: string): void {
    const need = LEVEL_RANK[normalizePermissionLevel(cap.minLevel)] ?? LEVEL_RANK.ui
    const have = LEVEL_RANK[level] ?? LEVEL_RANK.ui
    if (have < need) throw new Error(`${what} 需要权限级别 ${cap.minLevel}（当前 ${level}）`)
    if (cap.scope && !isFirstParty && !granted.has(cap.scope)) {
      throw new Error(`${what} 需要授权 ${cap.scope}`)
    }
  }

  function reply(id: unknown, ok: boolean, valueOrError: unknown): void {
    if (disposed) return
    const msg = ok
      ? { [FLAG]: 1, type: 'result', id, ok: true, value: valueOrError }
      : { [FLAG]: 1, type: 'result', id, ok: false, error: errorText(valueOrError) }
    try { iframe.contentWindow?.postMessage(msg, '*') } catch (_) {}
  }

  async function handleInvoke(data: PanelUiInvokeMessage): Promise<void> {
    const id = data.id
    const method = data.method
    const args = data.args

    if (!takeToken()) { reply(id, false, 'hira 调用过于频繁，请稍后重试'); return }
    if (pendingCount >= MAX_PENDING) { reply(id, false, 'hira 并发调用过多'); return }

    const cap = CAPABILITIES[method]
    if (!cap) { reply(id, false, `未知能力：${method}`); return }
    try { assertAllowed(cap, method) } catch (e) { reply(id, false, e); return }

    pendingCount += 1
    try {
      const value = await cap.run(args, env)
      reply(id, true, value)
    } catch (e) {
      console.warn(`[panel-ui:${pluginId}] ${method} 失败:`, errorMessage(e, String(e)))
      reply(id, false, e)
    } finally {
      pendingCount -= 1
    }
  }

  function handleSubscribe(id: string, channel: string): void {
    if (subscriptions.has(id)) return
    if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
      reply(id, false, '事件订阅数量已达上限')
      return
    }
    if (!takeToken()) {
      reply(id, false, '事件订阅过于频繁，请稍后重试')
      return
    }
    const entry = EVENT_CHANNELS[channel]
    if (!entry) { reply(id, false, `未知事件通道：${channel}`); return }
    try { assertAllowed(entry, `订阅 ${channel}`) } catch (e) { reply(id, false, e); return }
    try {
      const off = entry.subscribe(ctx, (payload) => {
        if (disposed) return
        try { iframe.contentWindow?.postMessage({ [FLAG]: 1, type: 'event', id, payload }, '*') } catch (_) {}
      })
      subscriptions.set(id, typeof off === 'function' ? off as () => void : () => {})
      reply(id, true, { channel })
    } catch (e) {
      reply(id, false, e)
    }
  }

  function handleUnsubscribe(id: string): void {
    const off = subscriptions.get(id)
    if (!off) return
    subscriptions.delete(id)
    try { off() } catch (_) {}
  }

  function onMessage(event: MessageEvent<unknown>): void {
    if (disposed) return
    // ① 只认这一扇 iframe（**不是**按 origin 字符串判断 —— 那可以被伪造/为空）
    if (!iframe.contentWindow || event.source !== iframe.contentWindow) return
    // ② opaque origin：srcdoc + sandbox 无 allow-same-origin 的必然结果
    if (event.origin !== 'null' && event.origin !== '') return
    const data = asRecord(event.data)
    if (!data || data[FLAG] !== 1) return
    if (data.type === 'invoke') {
      if (typeof data.method !== 'string' || !data.method) return
      if (!Array.isArray(data.args)) return
      let json = ''
      try { json = JSON.stringify(data.args) } catch (_) { reply(data.id, false, '参数不可序列化'); return }
      if (json.length > MAX_ARGS_CHARS) { reply(data.id, false, '参数过大'); return }
      handleInvoke({ id: data.id, method: data.method, args: data.args as unknown[] })
      return
    }
    if (data.type === 'subscribe') {
      if (typeof data.channel !== 'string' || !data.channel) return
      handleSubscribe(String(data.id), data.channel)
      return
    }
    if (data.type === 'unsubscribe') {
      handleUnsubscribe(String(data.id))
    }
  }

  window.addEventListener('message', onMessage)

  /**
   * 主题热更新（父侧）：主题一变就把新的 `:root{…}` 推给 iframe。
   *
   * 这是**唯一**由宿主主动推、而不是由面板 `hira.on()` 订阅的消息类型 ——
   * 面板即使一行 JS 都没写（纯 XAML 声明），颜色也必须跟着宿主走。
   * 与 `theme:changed` 事件不冲突：那条是给面板 JS 做逻辑响应用的。
   */
  let offTheme: (() => void) | null = null
  try {
    const themes = ctx && ctx.clients && ctx.clients.themes
    if (themes && typeof themes.onChanged === 'function') {
      offTheme = themes.onChanged(() => {
        // 延到微任务：主题广播的**所有**同步监听先跑完（控制器正是在自己的监听里
        // 把令牌写进 `documentElement.style`），此刻读到的才是新一套颜色。
        queueMicrotask(() => {
          if (disposed) return
          let css = ''
          try { css = themeTokensToCss(env.themeTokens()) } catch (_) { return }
          if (!css) return
          try {
            iframe.contentWindow?.postMessage({ [FLAG]: 1, type: 'theme', css }, '*')
          } catch (_) {}
        })
      })
    }
  } catch (_) {
    // 没有主题客户端（嵌入式 / 测试环境）：首帧注入的主题仍然有效，只是不热更。
  }

  return {
    dispose() {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', onMessage)
      if (typeof offTheme === 'function') {
        try { offTheme() } catch (_) {}
      }
      offTheme = null
      for (const off of subscriptions.values()) {
        try { off() } catch (_) {}
      }
      subscriptions.clear()
    }
  }
}


