/**
 * verify-multiwindow-isolation.cjs — 多窗口隔离回归（纯 Node + 打桩 electron）
 *
 * ── 为什么需要它（真实 bug：多窗口「标签串台」）────────────────────────────
 *   症状（用户原话）：①「多窗口打架，每个窗口的标签必须互不互通」；
 *                    ②「一个窗口没有自主权、没有网页」。
 *   两条都指向同一类病根：**按窗口的状态被进程级地共用了**。
 *
 *   根因 A（标签互通）：事件出口是进程级广播。窗口 A 的 TabManager 发出
 *     `tab:changed`（载荷里就是 A 的整份标签列表）→ 广播器投给**所有**订阅了该
 *     route 的 webContents，包括窗口 B 的 ui-shell；而 ui-shell 是**直接拿推送
 *     载荷渲染**的（renderer/tabs-client → tab-session-controller）——
 *     于是 B 的标签条显示 A 的标签、B 的地址栏指向 A 的页面。
 *   根因 B（没有自主权）：`ipcMain.on` 注册的**裸通道**（浮层 show/hide/display、
 *     shell:focus…）从不进入「按发送方解析窗口」的 AsyncLocalStorage 上下文，
 *     于是它们下面用的 `scoped(...)` 代理一律回退主窗口：在 B 打开空间菜单 →
 *     铺满整窗的浮层出现在 A 上（A 被盖住且点不动）；在 B 聚焦地址栏 → 焦点被
 *     反复交给 A。
 *
 * ── 为什么用「打桩 electron」而不是起真实实例 ──────────────────────────────
 *   本探针直接加载**生产源码**（files below），只把 `electron` 换成最小实现，
 *   因此不需要构建产物（out/）、不需要真机、也不会干扰用户正在运行的实例。
 *   打桩里唯一「有语义」的部分是 `BrowserWindow.fromWebContents`：真实 Electron
 *   对 WebContentsView 也返回其宿主窗口 —— 整条「按窗口解析」链路都建立在它之上。
 *
 * 用法（项目根）：
 *   node scripts/verify-multiwindow-isolation.cjs
 * 退出码 0 = 全部通过。
 */
import * as path from 'node:path'
import * as Module from 'node:module'
import { EventEmitter } from 'node:events'
import { asRecord, errorMessage, isRecord } from './lib/type-guards'

interface Bounds { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }
interface SentMessage { channel: string; payload: unknown }
interface TestResult { name: string; ok: boolean; detail?: unknown }
interface IpcEvent { sender: FakeWebContents; [key: string]: unknown }
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown
interface BroadcastOptions { windowId?: number; [key: string]: unknown }
interface EmittedEvent { route: string; windowId?: unknown }

const ROOT = path.resolve(__dirname, '..')
// getAppRoot() 优先读这个环境变量，避免依赖 electron.app
process.env.HIRA_APP_ROOT = ROOT

// ══════════════════════════════════════════════════════════════════════════
//  electron 打桩（必须在 require 任何生产源码之前安装）
// ══════════════════════════════════════════════════════════════════════════
/** webContents → 宿主 BrowserWindow（对齐 Electron 的真实语义） */
const ownerOf = new WeakMap<object, FakeBrowserWindow>()

let nextWcId = 1
let nextWinId = 1

class FakeWebContents extends EventEmitter {
  id: number
  _destroyed: boolean
  _url: string
  _focused: boolean
  _sent: SentMessage[]
  navigationHistory: { getAllEntries(): unknown[]; getActiveIndex(): number }

  constructor() {
    super()
    this.id = nextWcId++
    this._destroyed = false
    this._url = 'about:blank'
    this._focused = false
    this._sent = []
    this.navigationHistory = { getAllEntries: () => [], getActiveIndex: () => 0 }
  }
  isDestroyed() { return this._destroyed }
  destroy() { if (this._destroyed) return; this._destroyed = true; this.emit('destroyed') }
  isFocused() { return this._focused }
  focus() {
    for (const wc of allWebContents) wc._focused = false
    this._focused = true
    return true
  }
  getURL() { return this._url }
  loadURL(url: string) { this._url = String(url); return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  setWindowOpenHandler() {}
  setAudioMuted() {}
  setIgnoreMouseEvents() {}
  setBackgroundColor() {}
  executeJavaScript() { return Promise.resolve(null) }
  inspectElement() {}
  downloadURL() {}
  /** 记录「谁收到了哪条事件」—— 本探针的核心观测量 */
  send(channel: string, payload?: unknown) { this._sent.push({ channel, payload }) }
  sentOf(channel: string): SentMessage[] { return this._sent.filter((message) => message.channel === channel) }
}

/** contentView / 标签容器 / WebContentsView 统一的假 View */
class FakeView {
  webContents: FakeWebContents | null
  _children: FakeView[]
  _bounds: Bounds
  _visible: boolean
  _ownerWin: FakeBrowserWindow | null

  /** 真实 Electron 的形态：`new View()` 或 `new WebContentsView({ webPreferences, webContents? })` */
  constructor(arg?: unknown) {
    const source = asRecord(arg)
    if (arg instanceof FakeWebContents) this.webContents = arg
    else if (isRecord(source.webContents) && typeof source.webContents.on === 'function') this.webContents = source.webContents as unknown as FakeWebContents
    else this.webContents = source.webPreferences ? new FakeWebContents() : null
    if (this.webContents && !allWebContents.includes(this.webContents)) allWebContents.push(this.webContents)
    this._children = []
    this._bounds = { x: 0, y: 0, width: 0, height: 0 }
    this._visible = true
    /** 宿主窗口（由 contentView 向下传播，模拟 Electron 的 owner 关系） */
    this._ownerWin = null
  }
  addChildView(view: FakeView) {
    const i = this._children.indexOf(view)
    if (i >= 0) this._children.splice(i, 1)
    this._children.push(view)
    // 真实 Electron：视图挂进某个窗口后，其 webContents 归属该窗口（含 WebContentsView）
    const win = ownerOf.get(this) || this._ownerWin
    if (win) {
      ownerOf.set(this, win)
      if (view) {
        view._ownerWin = win
        if (view.webContents) ownerOf.set(view.webContents, win)
      }
    }
  }
  removeChildView(view: FakeView) {
    const i = this._children.indexOf(view)
    if (i >= 0) this._children.splice(i, 1)
  }
  setBounds(bounds: Bounds) { this._bounds = { ...bounds } }
  getBounds() { return { ...this._bounds } }
  setVisible(visible: boolean) { this._visible = Boolean(visible) }
  getVisible() { return this._visible }
  setBackgroundColor() {}
  setBorderRadius() {}
}

const allWebContents: FakeWebContents[] = []

class FakeBrowserWindow extends EventEmitter {
  id: number
  webContents: FakeWebContents
  contentView: FakeView
  _destroyed: boolean
  _focused: boolean
  _size: number[]
  _bounds: Bounds
  title: string

  constructor(options: Record<string, unknown> = {}) {
    super()
    this.id = nextWinId++
    this.webContents = new FakeWebContents()
    allWebContents.push(this.webContents)
    ownerOf.set(this.webContents, this)
    this.contentView = new FakeView()
    ownerOf.set(this.contentView, this)
    this._destroyed = false
    this._focused = false
    this._size = [Number(options.width) || 1100, Number(options.height) || 720]
    this._bounds = { x: 0, y: 0, width: this._size[0], height: this._size[1] }
    this.title = ''
  }
  static fromWebContents(webContents: FakeWebContents): FakeBrowserWindow | null { return webContents ? ownerOf.get(webContents) || null : null }
  static getFocusedWindow() {
    for (const win of allWindows) if (!win._destroyed && win._focused) return win
    return null
  }
  static getAllWindows() { return allWindows.filter((w) => !w._destroyed) }
  isDestroyed() { return this._destroyed }
  destroy() { this._destroyed = true; this.emit('closed'); this.emit('destroyed') }
  close() { this.destroy() }
  focus() {
    if (this._destroyed) return
    for (const w of allWindows) w._focused = false
    this._focused = true
    this.emit('focus')
  }
  isFocused() { return this._focused }
  getContentSize() { return this._size }
  setContentSize(size: number[] | Size) { this._size = Array.isArray(size) ? size : [size.width, size.height] }
  getBounds() { return { ...this._bounds } }
  setBounds(bounds: Bounds) { this._bounds = { ...bounds }; this._size = [bounds.width, bounds.height]; this.emit('resize') }
  isMaximized() { return false }
  isFullScreen() { return false }
  isVisible() { return true }
  isMinimized() { return false }
  setFullScreen() {}
  maximize() {}
  show() {}
  restore() {}
  setBackgroundColor() {}
  loadURL(url: string) { return this.webContents.loadURL(url) }
}

const allWindows: FakeBrowserWindow[] = []

class FakeIpcMain {
  _handlers: Map<string, IpcHandler[]>
  constructor() { this._handlers = new Map() }
  on(channel: string, handler: IpcHandler) {
    const bucket = this._handlers.get(channel) || []
    bucket.push(handler)
    this._handlers.set(channel, bucket)
    return this
  }
  handle() { return this }
  /** 探针专用：投递一条 IPC（event.sender = 发起方 webContents） */
  dispatch(channel: string, event: IpcEvent, ...args: unknown[]) {
    for (const handler of this._handlers.get(channel) || []) handler(event, ...args)
  }
  clear() { this._handlers.clear() }
}

const electronStub = {
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeView,
  View: FakeView,
  BaseWindow: FakeBrowserWindow,
  ipcMain: new FakeIpcMain(),
  session: { fromPartition: () => ({}), fromPath: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false, on() {}, removeListener() {} },
  Menu: { buildFromTemplate: () => ({ popup() {}, closePopup() {} }), setApplicationMenu() {} },
  clipboard: { writeText() {}, readText: () => '' },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  app: { getAppPath: () => ROOT, getPath: () => path.join(ROOT, '.tmp') },
  components: { whenReady: () => Promise.resolve() },
  webContents: { getFocusedWebContents: () => allWebContents.find((w) => w._focused) || null },
  shell: { openExternal: () => Promise.resolve() }
}

const moduleWithLoad = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown
}
const origLoad = moduleWithLoad._load.bind(moduleWithLoad)
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}

// ══════════════════════════════════════════════════════════════════════════
//  加载生产源码
// ══════════════════════════════════════════════════════════════════════════
const { createWindowRuntimeRegistry, ownerWindowOf } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'window-runtime-registry.js'))
const { createListenerRegistry, createBroadcaster } = require(path.join(ROOT, 'infra', 'infra-ipc', 'src', 'index.js'))
const { createBrowserWindowAssembly } = require(path.join(ROOT, 'apps', 'app-main', 'src', 'main', 'browser-window-assembly.ts'))
const { TabManager } = require('@hira-ng/infra-window')
const { tabRules } = require('@hira-ng/domain-tabs')
const { WindowRegistry } = require('@hira-ng/infra-window')

// ══════════════════════════════════════════════════════════════════════════
//  断言基建
// ══════════════════════════════════════════════════════════════════════════
const results: TestResult[] = []
function check(name: string, ok: unknown, detail?: unknown): void {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + String(detail)}`)
}

// ══════════════════════════════════════════════════════════════════════════
//  1. 事件按窗口投递（「标签互通」的根因与修法）
// ══════════════════════════════════════════════════════════════════════════
function testScopedEventDelivery() {
  // 与 main.js 完全同构的接线：登记表注入 scopeOf = 「这个 wc 属于哪个窗口 id」
  const listenerRegistry = createListenerRegistry({
    scopeOf: (wc: FakeWebContents) => {
      const owner = ownerWindowOf(wc)
      return owner ? owner.id : null
    }
  })
  const broadcaster = createBroadcaster(listenerRegistry)

  const winA = new FakeBrowserWindow()
  const winB = new FakeBrowserWindow()
  const shellA = winA.webContents
  const shellB = winB.webContents
  const panelB = new FakeWebContents() // 属于 B 面板的 chrome 层
  ownerOf.set(panelB, winB)

  // 两个窗口的 chrome 层都订阅了 tab:changed（生产里由 preload listeners:add 完成）
  listenerRegistry.add(shellA, 'tab:changed', 'a-shell')
  listenerRegistry.add(shellB, 'tab:changed', 'b-shell')
  listenerRegistry.add(panelB, 'tab:changed', 'b-panel')
  listenerRegistry.add(shellB, 'settings:changed', 'b-settings')

  // ① 窗口级事件带 windowId → 只投给该窗口
  const deliveredToA = broadcaster.send('tab:changed', { tabs: ['w1t1'] }, { windowId: winA.id })
  check('窗口级事件：只投给发起窗口的订阅者（A 收到 1 条）', deliveredToA === 1, `delivered=${deliveredToA}`)
  check('窗口级事件：A 的标签推送没有落到 B 的 ui-shell', shellB.sentOf('ngipc:event:tab:changed').length === 0)
  check('窗口级事件：A 自己的 ui-shell 收到了', shellA.sentOf('ngipc:event:tab:changed').length === 1)

  const deliveredToB = broadcaster.send('tab:changed', { tabs: ['w2t1'] }, { windowId: winB.id })
  check('窗口级事件：B 的推送同时覆盖它自己的面板层（同窗口多订阅者）', deliveredToB === 2, `delivered=${deliveredToB}`)
  check('窗口级事件：B 的推送没有落到 A 的 ui-shell', shellA.sentOf('ngipc:event:tab:changed').length === 1)

  // ② 应用级事件（不带 windowId）仍然广播 —— 不能把设置/书签同步一起改坏
  const broadcastCount = broadcaster.send('settings:changed', { key: 'app.theme' })
  check('应用级事件：仍广播给所有窗口（未被窗口化误伤）', broadcastCount === 1, `delivered=${broadcastCount}`)
  check('应用级事件：B 的 ui-shell 收到了', shellB.sentOf('ngipc:event:settings:changed').length === 1)

  // ③ 记录「改造前的行为」：不带 windowId 的 tab:changed 会跨窗口泄漏
  //    （这正是「标签串台」的机制；修复点是让「谁发的事件」带上自己的窗口）
  shellA._sent.length = 0
  shellB._sent.length = 0
  broadcaster.send('tab:changed', { tabs: ['w1t9'] })
  const leaked = shellB.sentOf('ngipc:event:tab:changed').length
  check('对照：tab:changed 若不带 windowId → 跨窗口泄漏（旧行为，已由装配器带窗修复）', leaked === 1, `B 收到 ${leaked} 条`)

  // ④ 作用域解析失败（不属于任何窗口的 wc）→ 不误投
  const orphan = new FakeWebContents()
  listenerRegistry.add(orphan, 'tab:changed', 'orphan')
  const deliveredWithOrphan = broadcaster.send('tab:changed', {}, { windowId: winA.id })
  check('作用域未知的订阅者不会被误投（孤儿 wc 收不到 A 的标签）', deliveredWithOrphan === 1 && orphan.sentOf('ngipc:event:tab:changed').length === 0)
}

// ══════════════════════════════════════════════════════════════════════════
//  2. scoped 代理：按发送方解析到正确的窗口（含「不回落主窗口」语义）
// ══════════════════════════════════════════════════════════════════════════
function testScopedResolution() {
  const registry = createWindowRuntimeRegistry()
  const winA = new FakeBrowserWindow()
  const winB = new FakeBrowserWindow()
  const rtA = { win: winA, tabManager: { list: () => ['A-tab'] } }
  const rtB = { win: winB, tabManager: { list: () => ['B-tab'] } }
  registry.setPrimary(rtA)
  registry.register(rtB)

  const scopedTabs = registry.scoped('tabManager')
  check('无上下文 → scoped 回退主窗口（单窗口语义，合理兜底）', scopedTabs.list().join() === 'A-tab')
  check('IPC 上下文来自 B → scoped 解析到 B 的实例', registry.runWithSender(winB.webContents, () => scopedTabs.list().join()) === 'B-tab')
  check('IPC 上下文来自 A → scoped 解析到 A 的实例', registry.runWithSender(winA.webContents, () => scopedTabs.list().join()) === 'A-tab')
  check('current() 无上下文时回落 primary（保留）', registry.current() === rtA)
  check('currentOrNull() 无上下文时返回 null（不回落，供「明确失败」用）', registry.currentOrNull() === null)
  check('currentOrNull() 在 B 的上下文里返回 B', registry.runWithSender(winB.webContents, () => registry.currentOrNull()) === rtB)

  // 子窗口的 webContents 不属于任何浏览器窗口 → 必须能识别为「解析不到」
  const subWindowWc = new FakeWebContents()
  ownerOf.set(subWindowWc, new FakeBrowserWindow())
  check(
    '子窗口发送方 → currentOrNull() 为 null（可明确失败，而不是静默改道主窗口）',
    registry.runWithSender(subWindowWc, () => registry.currentOrNull()) === null
  )
  check(
    '子窗口发送方 + current() → 才会静默落到主窗口（危险兜底，已从窗口级路径移除）',
    registry.runWithSender(subWindowWc, () => registry.current()) === rtA
  )
}

// ══════════════════════════════════════════════════════════════════════════
//  3. 裸通道（ipcMain.on）的发送方上下文（「没有自主权」的根因与修法）
// ══════════════════════════════════════════════════════════════════════════
function testRawChannelScoping() {
  const registry = createWindowRuntimeRegistry()
  const winA = new FakeBrowserWindow()
  const winB = new FakeBrowserWindow()
  const hit: string[] = []
  const rtA = { win: winA, layoutCoordinator: { focusShell: () => hit.push('A') } }
  const rtB = { win: winB, layoutCoordinator: { focusShell: () => hit.push('B') } }
  registry.setPrimary(rtA)
  registry.register(rtB)

  const scopedLayout = registry.scoped('layoutCoordinator')
  const ipcMain = new FakeIpcMain()

  // ── 未包装：裸通道不在上下文里 → scoped 回退主窗口（旧行为 = 串台）──
  ipcMain.on('ngipc:send:shell:focus', () => scopedLayout.focusShell())
  hit.length = 0
  ipcMain.dispatch('ngipc:send:shell:focus', { sender: winB.webContents })
  check('对照：裸通道未包装时，B 发起的 shell:focus 落到主窗口 A（旧行为）', hit.join() === 'A', `hit=${hit.join()}`)

  // ── 包装后（生产接线：runtimeRegistry.scopeRawIpcMain）→ 解析到发起方 ──
  const wrapped = new FakeIpcMain()
  const scopedIpcMain = registry.scopeRawIpcMain(wrapped)
  scopedIpcMain.on('ngipc:send:shell:focus', () => scopedLayout.focusShell())
  hit.length = 0
  wrapped.dispatch('ngipc:send:shell:focus', { sender: winB.webContents })
  check('修复后：B 发起的裸通道请求解析到 B（焦点/浮层不再跑到 A）', hit.join() === 'B', `hit=${hit.join()}`)
  hit.length = 0
  wrapped.dispatch('ngipc:send:shell:focus', { sender: winA.webContents })
  check('修复后：A 发起的裸通道请求仍解析到 A', hit.join() === 'A', `hit=${hit.join()}`)
  check('包装是透传的（其它成员仍可用）', typeof registry.scopeRawIpcMain(wrapped).handle === 'function')
}

// ══════════════════════════════════════════════════════════════════════════
//  4. 标签集合的隔离（每个窗口一份 TabManager / tabId 前缀）
// ══════════════════════════════════════════════════════════════════════════
function makeTabManagerHarness() {
  const views = new Map<string, FakeView>()
  const win = new FakeBrowserWindow()
  let activeId: string | null = null
  const wcm = {
    createTab(id: unknown) {
      const key = String(id)
      if (views.has(key)) return views.get(key)
      const v = new FakeView(new FakeWebContents())
      if (v.webContents) ownerOf.set(v.webContents, win)
      win.contentView.addChildView(v)
      views.set(key, v)
      return v
    },
    getTab(id: unknown) { return views.get(String(id)) || null },
    isTabSleeping() { return false },
    destroyTab(id: unknown) { views.delete(String(id)); return true },
    detachTab(id: unknown) {
      const v = views.get(String(id))
      if (!v) return null
      views.delete(String(id))
      win.contentView.removeChildView(v)
      return { view: v, options: {} }
    },
    adoptTab(id: unknown, view: FakeView) { views.set(String(id), view); return view },
    setTabProfileResolver() {}
  }
  const layout = {
    getActiveTabId: () => activeId,
    showTab(id: unknown) { activeId = String(id); for (const [key, view] of views) view.setVisible(key === String(id)); return { tabId: id } },
    hideTab() { activeId = null },
    applyInitialLayout() {},
    forgetView() {},
    resetTabBounds() {}
  }
  return { wcm, layout }
}

function testTabManagerIsolation() {
  const h1 = makeTabManagerHarness()
  const h2 = makeTabManagerHarness()
  const tm1 = new TabManager({ webContentsManager: h1.wcm, layoutCoordinator: h1.layout, emit: () => {}, hooks: {}, tabRules, tabIdPrefix: 'w1t' })
  const tm2 = new TabManager({ webContentsManager: h2.wcm, layoutCoordinator: h2.layout, emit: () => {}, hooks: {}, tabRules, tabIdPrefix: 'w2t' })
  check('两个窗口的 TabManager 是不同实例（互不共用）', tm1 !== tm2)
  check('两个窗口的 layoutCoordinator 是不同实例', tm1._layout !== tm2._layout)
  check('两个窗口的 webContentsManager 是不同实例', tm1._wcm !== tm2._wcm)
  check('两个窗口的标签 id 前缀全局唯一（不会互相盖键）', tm1._nextTabId() === 'w1t1' && tm2._nextTabId() === 'w2t1')

  const a1 = tm1._createTabSync({ url: 'https://a.test/1' }).tabId
  const a2 = tm1._createTabSync({ url: 'https://a.test/2' }).tabId
  const b1 = tm2._createTabSync({ url: 'https://b.test/1' }).tabId
  check('窗口 A 见到 2 个标签', tm1.listAll().length === 2)
  check('窗口 B 见到 1 个标签', tm2.listAll().length === 1)
  check('窗口 B 的集合里没有 A 的标签', !tm2.listAll().some((tab: { tabId: string }) => tab.tabId === a1 || tab.tabId === a2))
  check('窗口 A 的集合里没有 B 的标签', !tm1.listAll().some((tab: { tabId: string }) => tab.tabId === b1))

  // 在 A 关标签 / 切标签，B 完全不受影响
  tm1.switchTo(a2)
  tm1.close(a1)
  check('A 关闭标签后 B 的集合不变', tm2.listAll().length === 1 && tm2.getActiveTabId() !== null)
  check('A 的活动标签变化不写进 B 的 layout', tm2._layout.getActiveTabId() === b1)
  check('A 关闭标签后 A 的集合正确', tm1.listAll().length === 1 && tm1.listAll()[0].tabId === a2)

  // 跨窗口迁移能力保留（detach → adopt）
  const bundle = tm1.detachTab(a2)
  check('迁移：源窗口 detach 成功', !!bundle && tm1.listAll().length === 0)
  tm2.adoptTab(bundle)
  check('迁移：目标窗口 adopt 成功且不新增其它标签', tm2.listAll().length === 2)
  check('迁移：目标窗口两份标签 id 不冲突', new Set(tm2.listAll().map((tab: { tabId: string }) => tab.tabId)).size === 2)
}

// ══════════════════════════════════════════════════════════════════════════
//  5. 装配器端到端：新窗口自带初始标签 + 事件只发给本窗口
// ══════════════════════════════════════════════════════════════════════════
async function testAssembly() {
  const listenerRegistry = createListenerRegistry({
    scopeOf: (wc: FakeWebContents) => {
      const owner = ownerWindowOf(wc)
      return owner ? owner.id : null
    }
  })
  const broadcaster = createBroadcaster(listenerRegistry)

  const emitted: EmittedEvent[] = []
  const windowRegistry = new WindowRegistry()
  const extService = { addTab() {}, selectTab() {}, getContextMenuItems: () => [] }
  const shared = {
    runtimeRegistry: createWindowRuntimeRegistry(),
    windowRegistry,
    // 会话解析端口：探针里不落真实 session
    sessionsController: { resolve: () => null },
    // 与 main.js 的 emit 同构，但额外记录 windowId（用于断言装配器是否带上自己窗口）
    emit: (route: string, payload: unknown, opts?: BroadcastOptions) => {
      emitted.push({ route, windowId: opts && opts.windowId })
      return broadcaster.send(route, payload, opts)
    },
    tabRules,
    getPdfViewerEnabled: () => true,
    getNewTabUrl: () => 'hira://newtab',
    getAutoPictureInPictureEnabled: () => false,
    getFaviconService: () => ({ cacheAndSync() {}, get: () => null }),
    getHistoryService: () => ({ addVisit() {}, updateTitle() {} }),
    getExtensionService: () => extService,
    getSearchService: () => ({ buildSearchUrl: (query: string) => `https://search/?q=${encodeURIComponent(query)}` }),
    getExtraTabWebPreferences: () => ({}),
    snapshotService: { capture: async () => null, forget() {}, resolveRequest: () => null },
    openSubWindow: () => ({ ok: true }),
    onWindowMounted: () => {},
    onWindowClosed: () => {},
    onWindowTabsChanged: () => {}
  }

  const assembly = createBrowserWindowAssembly(shared)
  const runtimeA = assembly.open({ isPrimary: true })
  const runtimeB = await assembly.openNewWindow({ opener: runtimeA, focus: false })

  check('装配：两个窗口各有独立运行单元', runtimeA !== runtimeB)
  check('装配：两个窗口的 TabManager 不同实例', runtimeA.tabManager !== runtimeB.tabManager)
  check('装配：两个窗口的 LayoutCoordinator 不同实例', runtimeA.layoutCoordinator !== runtimeB.layoutCoordinator)
  check('装配：两个窗口的 WebContentsManager 不同实例', runtimeA.webContentsManager !== runtimeB.webContentsManager)
  check('装配：注册表里有两个运行单元', shared.runtimeRegistry.size === 2, `size=${shared.runtimeRegistry.size}`)
  check(
    '装配：按 sender 能精确解析到各自窗口',
    shared.runtimeRegistry.matchBySender(runtimeA.win.webContents) === runtimeA &&
      shared.runtimeRegistry.matchBySender(runtimeB.win.webContents) === runtimeB
  )

  // 新窗口必须**自带**自己的初始标签（不是空白，也不占用/接管别的窗口的标签）
  const tabsA = runtimeA.tabManager.listAll()
  const tabsB = runtimeB.tabManager.listAll()
  check('新窗口自带自己的初始标签（不空白）', tabsB.length === 1, `B tabs=${JSON.stringify(tabsB.map((tab: { tabId: string }) => tab.tabId))}`)
  check('主窗口不会被新窗口的初始标签接管', tabsA.length === 0, `A tabs=${JSON.stringify(tabsA.map((tab: { tabId: string }) => tab.tabId))}`)
  check('新窗口初始标签落在它自己的 id 前缀上', /^w2t/.test(tabsB[0].tabId), tabsB[0].tabId)
  check(
    '新窗口初始标签已在本窗口布局里可见（网页区不是空的）',
    runtimeB.tabManager.getActiveTabId() === tabsB[0].tabId &&
      runtimeB.layoutCoordinator.getActiveTabId() === tabsB[0].tabId
  )
  const bView = runtimeB.webContentsManager.getTab(tabsB[0].tabId)
  check('新窗口初始标签视图存在且已 setVisible(true)', !!bView && bView.getVisible() === true)
  const bBounds = bView ? bView.getBounds() : null
  check('新窗口初始标签拿到了非零 bounds（真的铺在窗口里）', !!bBounds && bBounds.width > 0 && bBounds.height > 0, JSON.stringify(bBounds))

  // 会话恢复路径：skipInitialTab 仍必须留空（否则恢复会把标签灌两遍）
  const runtimeC = await assembly.openNewWindow({ opener: runtimeB, focus: false, skipInitialTab: true })
  check('skipInitialTab：会话恢复专用路径仍然留空', runtimeC.tabManager.listAll().length === 0)

  // 事件出口必须带自己窗口的 windowId
  emitted.length = 0
  await runtimeB.tabManager.newTab({ url: 'https://b.test/2' })
  const tabChanged = emitted.filter((e) => e.route === 'tab:changed')
  check('装配：窗口 B 的 tab:changed 全部带上 B 的 windowId', tabChanged.length > 0 && tabChanged.every((e) => e.windowId === runtimeB.win.id), JSON.stringify(tabChanged.map((e) => e.windowId)))
  emitted.length = 0
  await runtimeA.tabManager.newTab({ url: 'https://a.test/1' })
  const aChanged = emitted.filter((e) => e.route === 'tab:changed')
  check('装配：窗口 A 的 tab:changed 全部带上 A 的 windowId', aChanged.length > 0 && aChanged.every((e) => e.windowId === runtimeA.win.id), JSON.stringify(aChanged.map((e) => e.windowId)))

  // 端到端：两个窗口的 ui-shell 都订阅了 tab:changed，A 的标签变化不得进 B
  listenerRegistry.add(runtimeA.win.webContents, 'tab:changed', 'a-shell')
  listenerRegistry.add(runtimeB.win.webContents, 'tab:changed', 'b-shell')
  const shellA = runtimeA.win.webContents
  const shellB = runtimeB.win.webContents
  shellA._sent.length = 0
  shellB._sent.length = 0
  await runtimeA.tabManager.newTab({ url: 'https://a.test/2' })
  await new Promise((r) => setTimeout(r, 10)) // _scheduleEmitChanged 走 queueMicrotask
  check('端到端：A 的标签变化只推给 A 的 ui-shell', shellA.sentOf('ngipc:event:tab:changed').length >= 1 && shellB.sentOf('ngipc:event:tab:changed').length === 0)
  shellA._sent.length = 0
  shellB._sent.length = 0
  await runtimeB.tabManager.newTab({ url: 'https://b.test/3' })
  await new Promise((r) => setTimeout(r, 10))
  check('端到端：B 的标签变化只推给 B 的 ui-shell', shellB.sentOf('ngipc:event:tab:changed').length >= 1 && shellA.sentOf('ngipc:event:tab:changed').length === 0)
  check('端到端：A 的标签条数据仍是 A 的（载荷来自 A 的 TabManager）', runtimeA.tabManager.listAll().every((tab: { tabId: string }) => /^w1t/.test(tab.tabId)) && runtimeA.tabManager.listAll().length === 2, JSON.stringify(runtimeA.tabManager.listAll().map((tab: { tabId: string }) => tab.tabId)))
  check('端到端：B 的标签条数据仍是 B 的（一个 A 的标签都没有）', runtimeB.tabManager.listAll().every((tab: { tabId: string }) => /^w2t/.test(tab.tabId)) && runtimeB.tabManager.listAll().length === 3, JSON.stringify(runtimeB.tabManager.listAll().map((tab: { tabId: string }) => tab.tabId)))

  // 窗口关闭 → 运行单元出表（解析不再命中），且不影响其它窗口
  runtimeB.win.destroy()
  check('关窗：已销毁窗口的运行单元不再被解析命中', shared.runtimeRegistry.matchBySender(runtimeB.win.webContents) === null && shared.runtimeRegistry.size === 2, `size=${shared.runtimeRegistry.size}`)
  check('关窗：不影响其它窗口的标签', runtimeA.tabManager.listAll().length === 2, `A tabs=${runtimeA.tabManager.listAll().length}`)
  check('关窗：其余窗口解析仍然正确', shared.runtimeRegistry.matchBySender(runtimeA.win.webContents) === runtimeA)
}

// ══════════════════════════════════════════════════════════════════════════
async function main() {
  try {
    testScopedEventDelivery()
    testScopedResolution()
    testRawChannelScoping()
    testTabManagerIsolation()
    await testAssembly()
  } catch (error) {
    check('探针异常', false, error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : errorMessage(error))
  }

  const failed = results.filter((r) => !r.ok)
  console.log('\n========================================')
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join(' | '))
  console.log('========================================')
  process.exit(failed.length ? 1 : 0)
}

main()
