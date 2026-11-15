// @ts-check
/**
 * plugin-capabilities.js —— 插件「开放世界」的**能力门面**（唯一实现处）。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────
 * 插件过去能拿到的 ctx 只有「扩展面」（providerRegistry / contributions /
 * extensionPoints / panelCatalog）。想读浏览器状态（标签、页面内容）、想开浮层、
 * 想加导航栏按钮、想调 AI、想跑自动化 —— 每一样都要主进程另开一条 IPC 或另写一份
 * 胶水，散落在各处。于是「能改什么」取决于「谁记得接哪根线」。
 *
 * 本文件把**全部可自定义面**收进一个 `browser` 对象：一级命名空间固定、方法名稳定，
 * 权限判定、错误形状、边界校验只在这里写一遍。插件作者只需要读命名空间，不需要知道
 * 主进程有几张表、几条 IPC。新增能力 = 在这里加一个方法（外加一个 scope），
 * 不动任何调用方。
 *
 * ── 三层职责（不要混） ──────────────────────────────────────────────────
 *   1. **本文件**：形状 + 鉴权 + 转调。不认识 Electron 窗口对象，全部经 getter 端口。
 *   2. **组合根**（main.js）：把真实实例装进端口（tabManager / layout / catalog / …）。
 *   3. **隔离宿主**（plugin-host-client）：只放行 `browser` 一个顶层键，方法调用走 RPC。
 *
 * ── 关键设计：纯数据贡献 ────────────────────────────────────────────────
 * 所有 UI 贡献（navbar / rail / tabAction / menu / overlay / command）都写成
 * **可序列化的纯数据**再进 contributions 表 —— 函数不跨进程，跨进程也能成立。
 * 需要行为时写 `action: { type: 'command' | 'page' | 'panel' | 'url' | 'slot' }`，
 * 由 plugin-surfaces#runAction 统一派发。这是「插件在独立进程里也能改 UI」的唯一正确形态。
 */

const {
  NAVBAR_BUTTONS_KIND,
  RAIL_BUTTONS_KIND,
  TAB_ACTIONS_KIND,
  OVERLAYS_KIND,
  PANEL_OVERRIDES_KIND,
  PAGE_PATCHES_KIND,
  COMMANDS_KIND,
  MENUS_KIND
} = require('./plugin-surfaces')

type UnknownRecord = Record<string, unknown>
type EventHandler = (payload: unknown, event: string) => unknown
type PortHandle = Record<string, unknown>

const PUBLIC_PLUGIN_EVENTS = new Set([
  'theme:changed',
  'plugins:changed',
  'plugins:chrome-changed',
  'panel:side-changed',
  'panel:transferred',
  'update:changed',
  'adblocker:changed'
])

const SCOPED_PLUGIN_EVENT_PREFIXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tab:', ['tabs:read', 'browser:control']],
  ['tabs:', ['tabs:read', 'browser:control']],
  ['bookmark:', ['bookmarks:read', 'browser:control']],
  ['history:', ['history:read', 'browser:control']],
  ['download:', ['downloads:read', 'browser:control']],
  ['settings:', ['settings:read', 'browser:control']],
  ['web-sidebar:', ['tabs:read', 'browser:control']],
  ['split:', ['tabs:read', 'browser:control']],
  ['glance:', ['tabs:read', 'browser:control']],
  ['layout:', ['tabs:read', 'browser:control']],
  ['window:', ['browser:control']],
  ['profile:', ['browser:control']],
  ['space:', ['browser:control']],
  ['pwa:', ['browser:control']]
]

interface LoggerPort {
  warn?(message?: unknown, ...args: unknown[]): void
}

interface PluginEventHub {
  on(name: string, handler: EventHandler): () => boolean
  off(name: string, handler: EventHandler): boolean
  once(name: string, handler: EventHandler): () => boolean
  emit(name: string, payload?: unknown): number
  removeAll(prefix?: string): void
}

interface CapabilityManifest {
  id?: unknown
  name?: unknown
  displayName?: unknown
  version?: unknown
  trustLevel?: unknown
  permissionLevel?: unknown
  isFirstParty?: unknown
  [key: string]: unknown
}

interface PluginCapabilitiesOptions {
  hub?: PluginEventHub
  logger?: LoggerPort
  getAppInfo?: () => unknown
  getThemeManager?: () => unknown
  getTabManager?: () => unknown
  getLayoutCoordinator?: () => unknown
  getPanelCatalog?: () => unknown
  getContributions?: () => unknown
  getPluginStorage?: () => unknown
  getPluginSurfaces?: () => unknown
  getExtensionPoints?: () => unknown
  getAutomation?: () => unknown
  getAppActions?: () => unknown
  getSettings?: () => unknown
  getPluginRoot?: (id: string) => unknown
  getOverlayHost?: () => unknown
  openUrl?: (url: string) => unknown
  notifySurfaces?: () => unknown
  listWindows?: () => unknown
  getCurrentWindowId?: () => unknown
  focusWindow?: (windowId: unknown) => unknown
  openWindow?: (opts: UnknownRecord) => unknown
  readClipboard?: () => unknown
  writeClipboard?: (text: string) => unknown
  [key: string]: unknown
}

interface CapabilityError extends Error {
  code?: string
  scope?: unknown
  scopes?: readonly string[]
  capability?: string
}

/**
 * 轻量事件中枢。
 *
 * 主进程原本没有全局事件总线，而插件需要「浏览器里发生了什么」的订阅面。
 * 这里只做名字 → 处理器集合的最小实现，支持 `'*'` 通配；不引入任何 broadcaster 依赖，
 * 组合根在 `emit`（广播出口）里顺手喂进来即可。
 */
function createEventHub (): PluginEventHub {
  const listeners = new Map<string, Set<EventHandler>>()

  function on (name: unknown, handler: unknown): () => boolean {
    const key = String(name || '').trim()
    if (!key || typeof handler !== 'function') throw new Error('events.on(name, handler) 参数不合法')
    const listener = handler as EventHandler
    const bucket = listeners.get(key) || new Set<EventHandler>()
    bucket.add(listener)
    listeners.set(key, bucket)
    return () => off(key, listener)
  }

  function off (name: string, handler: unknown): boolean {
    const set = listeners.get(name)
    if (!set) return false
    const listener = handler as EventHandler
    const removed = set.delete(listener)
    if (!set.size) listeners.delete(name)
    return removed
  }

  function once (name: unknown, handler: unknown): () => boolean {
    const listener = handler as EventHandler
    if (typeof listener !== 'function') throw new Error('events.once(name, handler) 参数不合法')
    const unsub = on(name, (payload: unknown, event: string) => {
      unsub()
      return listener(payload, event)
    })
    return unsub
  }

  function emit (name: unknown, payload?: unknown): number {
    const key = String(name || '').trim()
    const exact = listeners.get(key)
    const wildcard = listeners.get('*')
    if (!exact && !wildcard) return 0
    let hits = 0
    for (const fn of Array.from(exact || [])) {
      try { fn(payload, key); hits += 1 } catch (_) {}
    }
    for (const fn of Array.from(wildcard || [])) {
      try { fn(payload, key); hits += 1 } catch (_) {}
    }
    return hits
  }

  function removeAll (prefix?: string): void {
    if (!prefix) { listeners.clear(); return }
    const head = String(prefix)
    for (const key of Array.from(listeners.keys())) {
      if (key.startsWith(head)) listeners.delete(key)
    }
  }

  return { on, off, once, emit, removeAll }
}

/** 带错误码的异常 —— 调用方（宿主/插件作者）据此区分"没授权"与"真出错"。 */
function capabilityError (code: string, message: string, extra?: UnknownRecord): CapabilityError {
  const err = new Error(message) as CapabilityError
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

function isHttpLike (url: unknown): boolean {
  return /^(https?|file|hira|about|data|blob|chrome-extension):/i.test(String(url || ''))
}

function isRecord (value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function asRecord (value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unavailable (capability: string): CapabilityError {
  return capabilityError('EP_NOT_AVAILABLE', `能力 "${capability}" 当前不可用（宿主未接线或插件未启用）`, { capability })
}

/** 全部为 getter 端口 —— 组合根可能晚于本模块创建实例。 */
function createPluginCapabilities (options: PluginCapabilitiesOptions = {}) {
  const hub = options.hub || createEventHub()
  const log: LoggerPort = options.logger || console
  const warn = (message: string, error?: unknown): void => {
    if (log.warn) log.warn(`[plugin-capabilities] ${message}`, error)
  }

  const get = (name: string): unknown => {
    const fn = options[name]
    if (typeof fn !== 'function') return null
    try { return fn() } catch (e) { warn(`端口 ${name} 取值失败：`, errorMessage(e)); return null }
  }

  function requirePort (name: string, capability: string): PortHandle {
    const value = get(name)
    if (!isRecord(value)) throw unavailable(capability)
    return value
  }

  function hasMethod (port: PortHandle, name: string): boolean {
    return typeof port[name] === 'function'
  }

  function callPort (port: PortHandle, name: string, capability: string, ...args: unknown[]): unknown {
    const fn = port[name]
    if (typeof fn !== 'function') throw unavailable(capability)
    return fn.apply(port, args)
  }

  function optionalCall (port: PortHandle | null, name: string, ...args: unknown[]): unknown {
    if (!port) return null
    const fn = port[name]
    return typeof fn === 'function' ? fn.apply(port, args) : null
  }

  /** 每个插件一份运行时 AI 工具表（`pluginId → Map<name, def>`）。 */
  const runtimeTools = new Map<string, Map<string, UnknownRecord>>()
  /** 已按插件登记过 `ai.tool.provider` 聚合实现的集合（实现只能登记一次，否则重复）。 */
  const toolImplRegistered = new Set<string>()
  /** Factual main-event listeners, tracked per plugin so revoke/disable is immediate. */
  const pluginEventBindings = new Map<string, Set<{ name: string; handler: EventHandler }>>()

  function trackEventBinding (pluginId: string, binding: { name: string; handler: EventHandler }): () => void {
    const set = pluginEventBindings.get(pluginId) || new Set()
    set.add(binding)
    pluginEventBindings.set(pluginId, set)
    return () => {
      set.delete(binding)
      if (!set.size) pluginEventBindings.delete(pluginId)
    }
  }

  function releasePluginEvents (pluginId: string): void {
    const set = pluginEventBindings.get(pluginId)
    if (!set) return
    pluginEventBindings.delete(pluginId)
    for (const binding of set) {
      try { hub.off(binding.name, binding.handler) } catch (_) {}
    }
  }

  function contributionsOf (): PortHandle | null {
    const value = get('getContributions')
    return isRecord(value) ? value : null
  }

  function surfacesOf (): PortHandle | null {
    const value = get('getPluginSurfaces')
    return isRecord(value) ? value : null
  }

  function notifySurfaces (): void {
    const notify = options.notifySurfaces
    if (typeof notify !== 'function') return
    try { notify() } catch (e) { warn('notifySurfaces 失败：', errorMessage(e)) }
  }

  /**
   * 建一个插件的能力门面。
   *
   * manifest 为归一化后的插件描述；grantedScopes 为用户已授权 scope（第一方忽略）。
   */
  function createFor (manifest: CapabilityManifest, grantedScopes: readonly unknown[] = []) {
    const pluginId = String(manifest && manifest.id || '').trim()
    if (!pluginId) throw new Error('[plugin-capabilities] manifest.id 缺失')
    // A capability cache invalidation (permission grant/revoke) must also drop
    // subscriptions owned by the previous facade instance.
    releasePluginEvents(pluginId)
    const isFirstParty = manifest && manifest.isFirstParty === true
    const granted = new Set(Array.isArray(grantedScopes) ? grantedScopes.map((s) => String(s)) : [])

    /** 任一命中即放行；第一方全放行。 */
    function need (...scopes: string[]): void {
      if (isFirstParty) return
      if (!scopes.length) return
      for (const s of scopes) {
        if (granted.has(s)) return
      }
      throw capabilityError(
        'EP_MISSING_SCOPE',
        `插件 "${pluginId}" 缺少权限 scope：${scopes.join(' / ')}。请在 manifest 的 requestedPermissions 中声明，并在插件中心授权。`,
        { scope: scopes[0], scopes }
      )
    }

    // ── 浏览器底层访问器 ─────────────────────────────────────────────

    function tabManager (): PortHandle | null {
      const value = get('getTabManager')
      return isRecord(value) ? value : null
    }

    function wcFor (tabId?: unknown): PortHandle {
      const tm = tabManager()
      if (!tm) throw unavailable('browser.tabs')
      let wc: unknown = null
      if (tabId != null) {
        wc = optionalCall(tm, 'getWebContents', tabId)
      } else {
        wc = optionalCall(tm, 'getActiveWebContents')
      }
      if (!isRecord(wc) || (hasMethod(wc, 'isDestroyed') && callPort(wc, 'isDestroyed', 'browser.tabs') === true)) {
        throw capabilityError('EP_NO_TARGET', `找不到可操作的标签页：${tabId == null ? '活动标签' : tabId}`)
      }
      let targetProtocol = ''
      try { targetProtocol = new URL(String(optionalCall(wc, 'getURL') || '')).protocol } catch (_) {}
      if (targetProtocol !== 'http:' && targetProtocol !== 'https:') {
        throw capabilityError('EP_FORBIDDEN', 'content 能力只允许操作普通 http(s) 页面')
      }
      return wc
    }

    /** 只保留可克隆的标签字段（Electron 的 WebContents 绝不能漏出去）。 */
    function tabView (tab: unknown): UnknownRecord | null {
      if (!isRecord(tab)) return null
      return {
        id: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        pinned: tab.pinned === true,
        muted: tab.muted === true,
        sleeping: tab.sleeping === true,
        active: tab.active === true,
        index: typeof tab.index === 'number' && Number.isFinite(tab.index) ? tab.index : undefined
      }
    }

    function tabList (): UnknownRecord[] {
      const tm = tabManager()
      if (!tm) throw unavailable('browser.tabs')
      const raw = hasMethod(tm, 'list')
        ? callPort(tm, 'list', 'browser.tabs')
        : optionalCall(tm, 'listAll')
      return (Array.isArray(raw) ? raw : []).map(tabView).filter((tab): tab is UnknownRecord => tab !== null)
    }

    function activeTabId (): unknown {
      const tm = tabManager()
      if (!tm) throw unavailable('browser.tabs')
      return optionalCall(tm, 'getActiveTabId')
    }

    // ── 命名空间 ─────────────────────────────────────────────────────

    const info = {
      app () {
        const appInfo = asRecord(get('getAppInfo'))
        return {
          name: String(appInfo.name || 'Hira'),
          version: String(appInfo.version || '0.0.0'),
          platform: String(appInfo.platform || process.platform),
          locale: String(appInfo.locale || ''),
          packaged: appInfo.packaged === true
        }
      },
      plugin () {
        return {
          id: pluginId,
          name: String(manifest.name || manifest.displayName || pluginId),
          version: String(manifest.version || '0.0.0'),
          trustLevel: String(manifest.trustLevel || 'community'),
          permissionLevel: String(manifest.permissionLevel || 'ui'),
          firstParty: isFirstParty,
          root: String(options.getPluginRoot ? (options.getPluginRoot(pluginId) || '') : '')
        }
      },
      theme () {
        const tm = asRecord(get('getThemeManager'))
        if (!Object.keys(tm).length) return null
        const activeValue = optionalCall(tm, 'getActiveTheme')
        const active = isRecord(activeValue) ? activeValue : null
        return active ? { id: String(active.id || ''), name: String(active.name || '') } : null
      }
    }

    const tabs = {
      list () { need('tabs:read', 'browser:control'); return tabList() },
      active () { need('tabs:read', 'browser:control'); return activeTabId() },
      get (tabId: unknown) { need('tabs:read', 'browser:control'); const t = tabList().find((x) => x.id === tabId); return t || null },
      byUrl (url: unknown) {
        need('tabs:read', 'browser:control')
        const tm = tabManager()
        if (tm && hasMethod(tm, 'findTabByUrl')) return tabView(callPort(tm, 'findTabByUrl', 'browser.tabs.byUrl', String(url || ''))) || null
        return tabList().find((t) => t.url === String(url || '')) || null
      },
      open (input: unknown) {
        need('tabs:modify', 'browser:control')
        const tm = requirePort('getTabManager', 'browser.tabs.open')
        const opts: UnknownRecord = typeof input === 'string' ? { url: input } : asRecord(input)
        const url = String(opts.url || '').trim()
        if (url && !isHttpLike(url)) throw capabilityError('EP_INVALID_ARGS', `不支持的地址协议：${url.slice(0, 32)}`)
        return tabView(callPort(tm, 'newTab', 'browser.tabs.open', url ? { ...opts, url } : opts)) || null
      },
      close (tabId: unknown) {
        need('tabs:modify', 'browser:control')
        const tm = requirePort('getTabManager', 'browser.tabs.close')
        return callPort(tm, 'close', 'browser.tabs.close', tabId) !== false
      },
      activate (tabId: unknown) {
        need('tabs:modify', 'browser:control')
        const tm = requirePort('getTabManager', 'browser.tabs.activate')
        return callPort(tm, 'switchTo', 'browser.tabs.activate', tabId) !== false
      },
      navigate (input: unknown) {
        need('tabs:modify', 'browser:control')
        const tm = requirePort('getTabManager', 'browser.tabs.navigate')
        const args = typeof input === 'string'
          ? { url: input }
          : asRecord(input)
        const tabId = args.tabId != null ? args.tabId : activeTabId()
        if (tabId == null) throw capabilityError('EP_NO_TARGET', '没有可导航的活动标签')
        const url = String(args.url || '').trim()
        if (!url || !isHttpLike(url)) throw capabilityError('EP_INVALID_ARGS', `不支持的地址：${url.slice(0, 64)}`)
        return callPort(tm, 'navigate', 'browser.tabs.navigate', { tabId, url, typed: args.typed === true })
      },
      reload (tabId: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.reload'), 'reload', 'browser.tabs.reload', tabId) !== false },
      back (tabId: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.back'), 'goBack', 'browser.tabs.back', tabId) !== false },
      forward (tabId: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.forward'), 'goForward', 'browser.tabs.forward', tabId) !== false },
      stop (tabId: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.stop'), 'stop', 'browser.tabs.stop', tabId) !== false },
      pin (tabId: unknown, pinned: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.pin'), 'togglePin', 'browser.tabs.pin', tabId, { pinned: pinned === true }) !== false },
      mute (tabId: unknown, muted: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.mute'), 'toggleMute', 'browser.tabs.mute', tabId, { muted: muted === true }) !== false },
      sleep (tabId: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.sleep'), 'sleepTab', 'browser.tabs.sleep', tabId) !== false },
      wake (tabId: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.wake'), 'wakeTab', 'browser.tabs.wake', tabId) !== false },
      archive (tabId: unknown) { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.archive'), 'archiveTab', 'browser.tabs.archive', tabId) !== false },
      recentlyClosed () { need('tabs:read', 'browser:control'); const tm = requirePort('getTabManager', 'browser.tabs.recentlyClosed'); return optionalCall(tm, 'listRecentlyClosed') || [] },
      reopenClosed () { need('tabs:modify', 'browser:control'); return callPort(requirePort('getTabManager', 'browser.tabs.reopen'), 'undoClose', 'browser.tabs.reopen') || null },
      stats () { need('tabs:read', 'browser:control'); const tm = requirePort('getTabManager', 'browser.tabs.stats'); return hasMethod(tm, 'stats') ? callPort(tm, 'stats', 'browser.tabs.stats') : tm.stats || null }
    }

    const windows = {
      list () {
        need('tabs:read', 'browser:control')
        const fn = options.listWindows
        if (typeof fn !== 'function') return []
        const raw = fn() || []
        return (Array.isArray(raw) ? raw : []).map((window) => {
          const w = asRecord(window)
          return { id: w.id, title: w.title || '', focused: w.focused === true }
        })
      },
      current () {
        need('tabs:read', 'browser:control')
        const fn = options.getCurrentWindowId
        return typeof fn === 'function' ? fn() : null
      },
      focus (windowId: unknown) {
        need('tabs:modify', 'browser:control')
        const fn = options.focusWindow
        if (typeof fn !== 'function') throw unavailable('browser.windows.focus')
        return fn(windowId) !== false
      },
      open (input: unknown) {
        need('tabs:modify', 'browser:control')
        const fn = options.openWindow
        if (typeof fn !== 'function') throw unavailable('browser.windows.open')
        const opts: UnknownRecord = typeof input === 'string' ? { url: input } : asRecord(input)
        return fn(opts)
      }
    }

    const content = {
      async url (tabId?: unknown) { need('content:read', 'browser:control'); return callPort(wcFor(tabId), 'getURL', 'browser.content.url') },
      async title (tabId?: unknown) { need('content:read', 'browser:control'); return callPort(wcFor(tabId), 'getTitle', 'browser.content.title') },
      async text (tabId?: unknown) {
        need('content:read', 'browser:control')
        const wc = wcFor(tabId)
        return String(await callPort(wc, 'executeJavaScript', 'browser.content.text', 'document.body ? document.body.innerText : ""', true))
      },
      async html (tabId?: unknown) { need('content:read', 'browser:control'); const wc = wcFor(tabId); return String(await callPort(wc, 'executeJavaScript', 'browser.content.html', 'document.documentElement.outerHTML', true)) },
      async selection (tabId?: unknown) { need('content:read', 'browser:control'); const wc = wcFor(tabId); return String(await callPort(wc, 'executeJavaScript', 'browser.content.selection', 'String(window.getSelection ? window.getSelection() : "")', true)) },
      async query (selector: unknown, tabId?: unknown) {
        need('content:read', 'browser:control')
        const wc = wcFor(tabId)
        const sel = String(selector || '')
        if (!sel) throw capabilityError('EP_INVALID_ARGS', 'query(selector) 需要选择器')
        const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName, text: el.innerText || el.textContent || '', x: r.x, y: r.y, width: r.width, height: r.height }; })()`
        return await callPort(wc, 'executeJavaScript', 'browser.content.query', code, true)
      },
      async injectCss (css: unknown, tabId?: unknown) {
        need('content:modify', 'browser:control')
        const rule = String(css || '')
        if (!rule) return false
        const wc = wcFor(tabId)
        await callPort(wc, 'insertCSS', 'browser.content.injectCss', rule)
        return true
      },
      async injectJs (code: unknown, tabId?: unknown) {
        need('content:modify', 'browser:control')
        const source = String(code || '')
        if (!source) return false
        const wc = wcFor(tabId)
        return await callPort(wc, 'executeJavaScript', 'browser.content.injectJs', source, true)
      },
      async click (selector: unknown, tabId?: unknown) {
        need('content:modify', 'browser:control')
        const wc = wcFor(tabId)
        const sel = String(selector || '')
        if (!sel) throw capabilityError('EP_INVALID_ARGS', 'click(selector) 需要选择器')
        const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`
        return (await callPort(wc, 'executeJavaScript', 'browser.content.click', code, true)) === true
      },
      async fill (selector: unknown, value: unknown, tabId?: unknown) {
        need('content:modify', 'browser:control')
        const wc = wcFor(tabId)
        const sel = String(selector || '')
        if (!sel) throw capabilityError('EP_INVALID_ARGS', 'fill(selector, value) 需要选择器')
        const code = `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return false;
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, ${JSON.stringify(String(value == null ? '' : value))});
          else el.value = ${JSON.stringify(String(value == null ? '' : value))};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`
        return (await callPort(wc, 'executeJavaScript', 'browser.content.fill', code, true)) === true
      },
      async screenshot (tabId?: unknown) {
        need('content:read', 'browser:control')
        const wc = wcFor(tabId)
        const image = await callPort(wc, 'capturePage', 'browser.content.screenshot')
        if (!isRecord(image)) throw unavailable('browser.content.screenshot')
        const png = await callPort(image, 'toPNG', 'browser.content.screenshot')
        if (!Buffer.isBuffer(png)) throw capabilityError('EP_CAPTURE_FAILED', '截图未返回 PNG 数据')
        return `data:image/png;base64,${png.toString('base64')}`
      }
    }

    const panels = {
      list () { const catalog = asRecord(get('getPanelCatalog')); return optionalCall(catalog, 'list') || [] },
      ids () { const catalog = asRecord(get('getPanelCatalog')); return optionalCall(catalog, 'ids') || [] },
      has (id: unknown) { const catalog = asRecord(get('getPanelCatalog')); return optionalCall(catalog, 'has', id) === true },
      entry (id: unknown) { const catalog = asRecord(get('getPanelCatalog')); return optionalCall(catalog, 'entry', id) },
      show (id: unknown, side?: unknown) {
        need('panels:manage')
        const layout = requirePort('getLayoutCoordinator', 'browser.panels.show')
        if (!panels.has(id)) return false
        const method = hasMethod(layout, 'showPanel') ? 'showPanel' : 'togglePanel'
        if (!hasMethod(layout, method)) return false
        callPort(layout, method, 'browser.panels.show', id, side ? { side } : undefined)
        return true
      },
      hide (side?: unknown) {
        need('panels:manage')
        const layout = requirePort('getLayoutCoordinator', 'browser.panels.hide')
        if (!hasMethod(layout, 'hidePanel')) return false
        callPort(layout, 'hidePanel', 'browser.panels.hide', side)
        return true
      },
      close (id: unknown) {
        need('panels:manage')
        const layout = requirePort('getLayoutCoordinator', 'browser.panels.close')
        if (!hasMethod(layout, 'closePanel')) return false
        return callPort(layout, 'closePanel', 'browser.panels.close', id) !== false
      },
      toggle (id: unknown, side?: unknown) {
        need('panels:manage')
        const layout = requirePort('getLayoutCoordinator', 'browser.panels.toggle')
        if (!hasMethod(layout, 'togglePanel')) return false
        return callPort(layout, 'togglePanel', 'browser.panels.toggle', id, side ? { side } : {}) !== false
      },
      pin (id: unknown, pinned: unknown) {
        need('panels:manage')
        const layout = requirePort('getLayoutCoordinator', 'browser.panels.pin')
        if (!hasMethod(layout, 'pinPanel')) return false
        return callPort(layout, 'pinPanel', 'browser.panels.pin', id, { pinned: pinned === true }) !== false
      },
      switchTo (id: unknown, side?: unknown) {
        need('panels:manage')
        const layout = requirePort('getLayoutCoordinator', 'browser.panels.switchTo')
        if (!hasMethod(layout, 'switchPanel')) return false
        return callPort(layout, 'switchPanel', 'browser.panels.switchTo', id, side) !== false
      },
      swapSides (id: unknown) {
        need('panels:manage')
        const layout = requirePort('getLayoutCoordinator', 'browser.panels.swapSides')
        if (!hasMethod(layout, 'swapPanelSides')) return false
        return callPort(layout, 'swapPanelSides', 'browser.panels.swapSides', id) !== false
      },
      slots () {
        const layout = asRecord(get('getLayoutCoordinator'))
        return optionalCall(layout, 'getPanelSlots')
      }
    }

    /**
     * UI 贡献统一入口：纯数据进 contributions，随后通知表面同步。
     * 返回归一化后的条目（含 pluginId），插件可据此保存 id。
     */
    function addContribution (kind: string, item: unknown): unknown {
      const registry = requirePort('getContributions', `browser.ui.${kind}`)
      if (!isRecord(item)) throw capabilityError('EP_INVALID_ARGS', `${kind} 贡献必须是对象`)
      const id = String(item.id || '').trim()
      if (!id) throw capabilityError('EP_INVALID_ARGS', `${kind} 贡献缺少 id`)
      const entry = callPort(registry, 'contribute', `browser.ui.${kind}`, kind, { ...item, id }, { pluginId, order: Number(item.order) || 0 })
      notifySurfaces()
      return entry
    }

    function removeContribution (kind: string, id: unknown): boolean {
      const registry = requirePort('getContributions', `browser.ui.${kind}`)
      if (!hasMethod(registry, 'remove')) return false
      const ok = callPort(registry, 'remove', `browser.ui.${kind}`, kind, id, pluginId) === true
      if (ok) notifySurfaces()
      return ok
    }

    function listContributions (kind: string): UnknownRecord[] {
      const registry = get('getContributions')
      if (!isRecord(registry) || !hasMethod(registry, 'list')) return []
      const raw = callPort(registry, 'list', `browser.ui.${kind}`, kind)
      return (Array.isArray(raw) ? raw : [])
        .filter(isRecord)
        .filter((entry) => String(entry.pluginId || '') === pluginId)
    }

    const ui = {
      navbar: {
        add (item: unknown) { need('ui:chrome'); return addContribution(NAVBAR_BUTTONS_KIND, item) },
        remove (id: unknown) { need('ui:chrome'); return removeContribution(NAVBAR_BUTTONS_KIND, id) },
        list () { need('ui:chrome'); return listContributions(NAVBAR_BUTTONS_KIND) }
      },
      rail: {
        add (item: unknown) { need('ui:chrome'); return addContribution(RAIL_BUTTONS_KIND, item) },
        remove (id: unknown) { need('ui:chrome'); return removeContribution(RAIL_BUTTONS_KIND, id) },
        list () { need('ui:chrome'); return listContributions(RAIL_BUTTONS_KIND) }
      },
      tabAction: {
        add (item: unknown) { need('ui:chrome'); return addContribution(TAB_ACTIONS_KIND, item) },
        remove (id: unknown) { need('ui:chrome'); return removeContribution(TAB_ACTIONS_KIND, id) },
        list () { need('ui:chrome'); return listContributions(TAB_ACTIONS_KIND) }
      },
      menu: {
        add (item: unknown) { need('contextMenus', 'ui:chrome'); return addContribution(MENUS_KIND, item) },
        remove (id: unknown) { need('contextMenus', 'ui:chrome'); return removeContribution(MENUS_KIND, id) },
        list () { need('contextMenus', 'ui:chrome'); return listContributions(MENUS_KIND) }
      },
      /**
       * 现有面板的改写 / 删除（做加法 / 做减法）。
       *
       * 与 `browser.panels`（开关 / 切换 / 停靠）的分工：那边是「用面板」，
       * 这边是「改面板本身」—— 改标题 / 图标 / 排序 / 分段，或 `hide: true`
       * （等价 `remove: true`）直接摘掉。字段可直接写在条目上，也可包进 `patch`。
       * 数据走 `contributes.panelOverrides` 同一张表（归一化见 plugin-surfaces.js），
       * 因此不用另建一套，插件卸载时随其它贡献一起被摘除。
       */
      panel: {
        override (item: unknown) {
          need('panels:manage')
          const src = asRecord(item)
          // 省略 `id` 时用目标面板 id 兜底：一个插件对同一面板通常只有一条改写，
          // 让作者少写一个与目标重复的键（`remove(id)` 仍按这个 id 摘）。
          const id = String(src.id || src.panelId || '').trim()
          return addContribution(PANEL_OVERRIDES_KIND, { ...src, id })
        },
        remove (id: unknown) { need('panels:manage'); return removeContribution(PANEL_OVERRIDES_KIND, id) },
        list () { need('panels:manage'); return listContributions(PANEL_OVERRIDES_KIND) }
      },
      overlay: {
        add (item: unknown) { need('ui:overlay'); return addContribution(OVERLAYS_KIND, item) },
        remove (id: unknown) { need('ui:overlay'); return removeContribution(OVERLAYS_KIND, id) },
        list () { need('ui:overlay'); return listContributions(OVERLAYS_KIND) },
        show (descriptor: unknown) {
          need('ui:overlay')
          const host = requirePort('getOverlayHost', 'browser.ui.overlay.show')
          return callPort(host, 'show', 'browser.ui.overlay.show', asRecord(descriptor), pluginId)
        },
        hide (id: unknown) {
          need('ui:overlay')
          const host = asRecord(get('getOverlayHost'))
          if (!hasMethod(host, 'hide')) return false
          return callPort(host, 'hide', 'browser.ui.overlay.hide', id, pluginId) !== false
        }
      }
    }

    const pages = {
      list () { const s = surfacesOf(); return optionalCall(s, 'listPages') || [] },
      url (ref: unknown) { const s = surfacesOf(); return s ? optionalCall(s, 'pageUrl', ref, pluginId) : '' },
      open (ref: unknown) {
        const url = pages.url(ref)
        if (!url) return false
        const open = options.openUrl
        if (typeof open !== 'function') throw unavailable('browser.pages.open')
        open(String(url))
        return true
      },
      patch (item: unknown) {
        need('pages:manage')
        const entry = addContribution(PAGE_PATCHES_KIND, item)
        return entry
      },
      unpatch (id: unknown) { need('pages:manage'); return removeContribution(PAGE_PATCHES_KIND, id) },
      patches () { need('pages:manage'); return listContributions(PAGE_PATCHES_KIND) }
    }

    const actions = {
      list () {
        const appActions = asRecord(get('getAppActions'))
        if (!hasMethod(appActions, 'list')) return []
        const raw = callPort(appActions, 'list', 'browser.actions.list')
        return Array.isArray(raw) ? raw : []
      },
      run (name: unknown, args?: unknown) {
        need('actions:run')
        const appActions = requirePort('getAppActions', 'browser.actions.run')
        return callPort(appActions, 'run', 'browser.actions.run', String(name || ''), asRecord(args))
      },
      targets () {
        const appActions = asRecord(get('getAppActions'))
        return optionalCall(appActions, 'targets') || []
      },
      groups () {
        const appActions = asRecord(get('getAppActions'))
        return optionalCall(appActions, 'groups') || []
      }
    }

    const automation = {
      config () {
        need('actions:run')
        const ctl = requirePort('getAutomation', 'browser.automation')
        return optionalCall(ctl, 'getConfig')
      },
      save (config: unknown) {
        need('actions:run')
        const ctl = requirePort('getAutomation', 'browser.automation')
        return hasMethod(ctl, 'save') ? callPort(ctl, 'save', 'browser.automation.save', config) : false
      },
      run (input: unknown) {
        need('actions:run')
        const ctl = requirePort('getAutomation', 'browser.automation')
        return callPort(ctl, 'run', 'browser.automation.run', asRecord(input))
      },
      runAction (name: unknown) {
        need('actions:run')
        const ctl = requirePort('getAutomation', 'browser.automation')
        return callPort(ctl, 'runAction', 'browser.automation.runAction', String(name || ''))
      },
      runChain (id: unknown) {
        need('actions:run')
        const ctl = requirePort('getAutomation', 'browser.automation')
        return callPort(ctl, 'runChain', 'browser.automation.runChain', String(id || ''))
      }
    }

    const ai = {
      async invoke (input: unknown, invokeOptions?: unknown) {
        need('ai:invoke')
        const ep = asRecord(get('getExtensionPoints'))
        if (!hasMethod(ep, 'call')) throw capabilityError('EP_AI_UNAVAILABLE', 'AI 引擎不可用（未安装 AI 插件）')
        try {
          return await callPort(ep, 'call', 'ai.invoke', 'ai.invoke', { input, options: asRecord(invokeOptions), pluginId })
        } catch (e) {
          if (isRecord(e) && e.code === 'EP_NOT_FOUND') throw capabilityError('EP_AI_UNAVAILABLE', 'AI 引擎不可用（未安装 AI 插件）')
          throw e
        }
      },
      tools () {
        need('ai:invoke')
        return Array.from((runtimeTools.get(pluginId) || new Map()).values())
      },
      registerTool (definition: unknown) {
        need('ai:invoke')
        const def = asRecord(definition)
        const name = String(def.name || '').trim()
        if (!name) throw capabilityError('EP_INVALID_ARGS', 'ai.registerTool 需要 name')
        const bucket = runtimeTools.get(pluginId) || new Map<string, UnknownRecord>()
        bucket.set(name, { ...def, name, pluginId })
        runtimeTools.set(pluginId, bucket)
        const ep = asRecord(get('getExtensionPoints'))
        if (hasMethod(ep, 'implement') && !toolImplRegistered.has(pluginId)) {
          try {
            // 注册与消费**必须是同一个扩展点**（引擎在 ai.tool.provider 上列工具，
            // 见 plugins/ai/core/tools.cjs#pluginTools）。这里曾写成 'ai.tool'，
            // 结果插件工具永远不会进入模型视野。
            callPort(ep, 'implement', 'ai.tool.provider', 'ai.tool.provider', () => Array.from(bucket.values()), { pluginId, key: '__runtime' })
            toolImplRegistered.add(pluginId)
          } catch (e) {
            warn(`登记 ai.tool.provider 聚合实现失败（${pluginId}）：`, errorMessage(e))
          }
        }
        return true
      },
      unregisterTool (name: unknown) {
        need('ai:invoke')
        const bucket = runtimeTools.get(pluginId)
        return bucket ? bucket.delete(String(name || '')) : false
      }
    }

    /** Main-event subscriptions are capability-gated; unknown events are denied. */
    const eventWrappers = new Map<string, Map<EventHandler, EventHandler>>()
    function eventScopes (name: string): readonly string[] | null {
      if (PUBLIC_PLUGIN_EVENTS.has(name)) return []
      for (const [prefix, scopes] of SCOPED_PLUGIN_EVENT_PREFIXES) {
        if (name.startsWith(prefix)) return scopes
      }
      if (name.startsWith('overlay:')) return []
      return null
    }

    function checkedEventHandler (name: string, handler: EventHandler): EventHandler {
      if (isFirstParty) return handler
      if (name === '*') throw capabilityError('EP_EVENT_FORBIDDEN', '社区插件不能订阅通配事件')
      if (name.startsWith(`plugin:${pluginId}:`)) return handler
      const scopes = eventScopes(name)
      if (scopes === null) {
        throw capabilityError('EP_EVENT_FORBIDDEN', `插件不能订阅主进程事件：${name}`)
      }
      if (scopes.length) need(...scopes)
      if (!name.startsWith('overlay:')) return handler
      return (payload, event) => {
        const owner = asRecord(payload).pluginId
        return owner == null || String(owner) === pluginId ? handler(payload, event) : undefined
      }
    }

    function onEvent (name: unknown, handler: EventHandler, once: boolean): () => boolean {
      const key = String(name || '').trim()
      if (!key || typeof handler !== 'function') throw new Error('events 参数不合法')
      const wrapped = checkedEventHandler(key, handler)
      const binding = { name: key, handler: wrapped }
      const untrack = trackEventBinding(pluginId, binding)
      if (once) {
        const offOnce = hub.once(key, wrapped)
        return () => {
          const removed = offOnce()
          untrack()
          return removed
        }
      }
      const table = eventWrappers.get(key) || new Map<EventHandler, EventHandler>()
      table.set(handler, wrapped)
      eventWrappers.set(key, table)
      const off = hub.on(key, wrapped)
      return () => {
        const removed = off()
        untrack()
        table.delete(handler)
        if (!table.size) eventWrappers.delete(key)
        return removed
      }
    }

    const events = {
      on (name: unknown, handler: EventHandler) { return onEvent(name, handler, false) },
      once (name: unknown, handler: EventHandler) { return onEvent(name, handler, true) },
      off (name: unknown, handler: EventHandler) {
        const key = String(name || '').trim()
        const table = eventWrappers.get(key)
        const wrapped = table ? table.get(handler) : undefined
        if (!table || !wrapped) return false
        table.delete(handler)
        if (!table.size) eventWrappers.delete(key)
        const removed = hub.off(key, wrapped)
        const bindings = pluginEventBindings.get(pluginId)
        if (bindings) {
          for (const binding of bindings) if (binding.name === key && binding.handler === wrapped) bindings.delete(binding)
          if (!bindings.size) pluginEventBindings.delete(pluginId)
        }
        return removed
      },
      emit (name: unknown, payload?: unknown) {
        const key = String(name || '').trim()
        const prefix = `plugin:${pluginId}:`
        if (!key.startsWith(prefix)) {
          throw capabilityError('EP_FORBIDDEN', `插件只能广播自己的私域事件（前缀 ${prefix}）`)
        }
        return hub.emit(key, payload)
      }
    }

    const storage = {
      get (key: unknown) {
        need('storage:read')
        const result = asRecord(callPort(requirePort('getPluginStorage', 'browser.storage'), 'get', 'browser.storage.get', pluginId, key))
        return result.ok ? result.value : null
      },
      keys (prefix: unknown) {
        need('storage:read')
        const result = asRecord(callPort(requirePort('getPluginStorage', 'browser.storage'), 'keys', 'browser.storage.keys', pluginId, prefix))
        return result.ok && Array.isArray(result.keys) ? result.keys : []
      },
      usage () { need('storage:read'); return callPort(requirePort('getPluginStorage', 'browser.storage'), 'usage', 'browser.storage.usage', pluginId) },
      set (key: unknown, value: unknown) { need('storage:write'); return callPort(requirePort('getPluginStorage', 'browser.storage'), 'set', 'browser.storage.set', pluginId, key, value) },
      remove (key: unknown) { need('storage:write'); return callPort(requirePort('getPluginStorage', 'browser.storage'), 'remove', 'browser.storage.remove', pluginId, key) },
      clear () { need('storage:write'); return callPort(requirePort('getPluginStorage', 'browser.storage'), 'clear', 'browser.storage.clear', pluginId) }
    }

    const clipboard = {
      read () {
        need('clipboard')
        const fn = options.readClipboard
        if (typeof fn !== 'function') throw unavailable('browser.clipboard.read')
        return String(fn() || '')
      },
      write (text: unknown) {
        need('clipboard')
        const fn = options.writeClipboard
        if (typeof fn !== 'function') throw unavailable('browser.clipboard.write')
        fn(String(text == null ? '' : text))
        return true
      }
    }

    const settings = {
      get (key: unknown) {
        need('settings:read')
        return callPort(requirePort('getSettings', 'browser.settings.get'), 'get', 'browser.settings.get', String(key || ''))
      },
      set (key: unknown, value: unknown) {
        need('settings:write')
        return callPort(requirePort('getSettings', 'browser.settings.set'), 'set', 'browser.settings.set', String(key || ''), value)
      }
    }

    const commands = {
      register (item: unknown) { return addContribution(COMMANDS_KIND, item) },
      unregister (id: unknown) { return removeContribution(COMMANDS_KIND, id) },
      list () { return listContributions(COMMANDS_KIND) },
      run (id: unknown) {
        need('actions:run')
        const hit = commands.list().find((c) => c.id === String(id || ''))
        const surfaces = requirePort('getPluginSurfaces', 'browser.commands.run')
        if (!hit || !hasMethod(surfaces, 'runAction')) return false
        return callPort(surfaces, 'runAction', 'browser.commands.run', hit.action, { pluginId, payload: {} }) === true
      }
    }

    return {
      info,
      tabs,
      windows,
      content,
      panels,
      ui,
      pages,
      actions,
      automation,
      ai,
      events,
      storage,
      clipboard,
      settings,
      commands
    }
  }

  /** 插件停用 / 卸载时的运行时清理（贡献表由注册中心统一 clearPlugin）。 */
  function disposePlugin (pluginId: unknown): void {
    const id = String(pluginId || '')
    if (!id) return
    runtimeTools.delete(id)
    toolImplRegistered.delete(id)
    releasePluginEvents(id)
    hub.removeAll(`plugin:${id}:`)
  }

  return { hub, createFor, disposePlugin }
}

export { createPluginCapabilities, createEventHub, capabilityError }
