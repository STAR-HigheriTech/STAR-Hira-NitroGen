/**
 * verify-jsdialog-window-isolation.cjs — JS 对话框（alert/confirm/prompt/beforeunload）
 * 多窗口隔离回归（纯 Node + 打桩 electron，不起真实 Electron、不干扰正在运行的实例）。
 *
 * ── 要证明的缺陷（多窗口「弹窗串台」）──────────────────────────────────────
 *   js-dialog/index.js 的 `createJsDialogManager` 在 `browser-window-assembly.mount()`
 *   里**每开一个窗口就被调用一次**，而它内部直接 `ipcMain.on('jsDialog:show' | …)`。
 *   `ipcMain.on` 同一通道重复注册**不报错**，于是两个窗口时：
 *     · 同一次弹窗事件被**两套 handler**各处理一遍 → 建出**两个浮层**
 *       （A 发起的 alert 同时挂在 A 与 B 上）；
 *     · confirm/prompt 的应答（response / poll-result）被两套状态竞争处理；
 *     · 「阻止此页面创建更多弹窗」的状态被**跨窗口共享**。
 *
 * ── 为什么用「打桩 electron」而不是起真实实例 ──────────────────────────────
 *   本探针直接加载**生产源码**（见下方 require），只把 `electron` 与
 *   `./dialog-overlay` 换成最小实现，因此不需要构建产物（out/）、不需要真机。
 *   打桩里唯一「有语义」的部分是 `BrowserWindow.fromWebContents`：真实 Electron
 *   对 WebContentsView 也返回其宿主窗口 —— 整条「按窗口解析」链路都建立在它之上。
 *
 * 用法（项目根）：
 *   node scripts/verify-jsdialog-window-isolation.cjs
 * 退出码 0 = 全部通过。
 */
import * as path from 'node:path'
import * as Module from 'node:module'
import { EventEmitter } from 'node:events'
import { errorMessage } from './lib/type-guards'

interface TestResult { name: string; ok: boolean }
interface IpcReturnValue { action?: string; value?: unknown; [key: string]: unknown }
interface IpcEvent { sender: FakeWebContents; returnValue?: IpcReturnValue }
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown
interface FakeOverlay {
  parentWindow: FakeBrowserWindow
  type: string | null
  destroyed: boolean
  wc: FakeWebContents
  show(type: string): FakeWebContents
  getWebContents(): FakeWebContents
  sendInit(): void
  sendTheme(): void
  destroy(): void
  isDestroyed(): boolean
}
interface RuntimeUnit { win: FakeBrowserWindow; jsDialogManager?: unknown }
interface TwoWindowHarness {
  registry: unknown
  winA: FakeBrowserWindow
  winB: FakeBrowserWindow
  rtA: RuntimeUnit
  rtB: RuntimeUnit
  mgrA: unknown
  mgrB: unknown
}

const ROOT = path.resolve(__dirname, '..')
process.env.HIRA_APP_ROOT = ROOT
const MAIN = path.join(ROOT, 'apps', 'app-main', 'src', 'main')

// ══════════════════════════════════════════════════════════════════════════
//  electron 打桩（必须在 require 任何生产源码之前安装）
// ══════════════════════════════════════════════════════════════════════════
/** webContents → 宿主 BrowserWindow（对齐 Electron 的真实语义） */
const ownerOf = new WeakMap<object, FakeBrowserWindow>()
let nextId = 1

class FakeWebContents extends EventEmitter {
  id: number
  _destroyed: boolean
  __ngTabId?: string
  constructor () {
    super()
    this.id = nextId++
    this._destroyed = false
  }
  isDestroyed () { return this._destroyed }
  destroy () { if (this._destroyed) return; this._destroyed = true; this.emit('destroyed') }
  send (_channel?: string, _payload?: unknown) {}
  executeJavaScript () { return Promise.resolve(null) }
}

class FakeBrowserWindow extends EventEmitter {
  id: number
  webContents: FakeWebContents
  _destroyed: boolean
  constructor () {
    super()
    this.id = nextId++
    this.webContents = new FakeWebContents()
    ownerOf.set(this.webContents, this)
    this._destroyed = false
  }
  static fromWebContents (webContents: FakeWebContents) { return webContents ? (ownerOf.get(webContents) || null) : null }
  static getFocusedWindow () { return null }
  static getAllWindows () { return [] }
  isDestroyed () { return this._destroyed }
  destroy () { this._destroyed = true; this.emit('closed') }
}

/** 记录「每条通道上挂了几个 handler」——本探针的核心观测量之一 */
class FakeIpcMain {
  _handlers: Map<string, IpcHandler[]>
  constructor () { this._handlers = new Map() }
  on (channel: string, handler: IpcHandler) {
    const bucket = this._handlers.get(channel) || []
    bucket.push(handler)
    this._handlers.set(channel, bucket)
    return this
  }
  handle () { return this }
  off () { return this }
  handlerCount (channel: string): number { return (this._handlers.get(channel) || []).length }
  /** 探针专用：投递一条 IPC（event.sender = 发起方 webContents） */
  dispatch (channel: string, event: IpcEvent, ...args: unknown[]) {
    for (const handler of (this._handlers.get(channel) || []).slice()) handler(event, ...args)
  }
}

const ipcMain = new FakeIpcMain()

const electronStub = {
  ipcMain,
  nativeTheme: { shouldUseDarkColors: false, on () {}, removeListener () {} },
  BrowserWindow: FakeBrowserWindow,
  screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  app: { getAppPath: () => ROOT, getPath: () => path.join(ROOT, '.tmp') }
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
//  打桩 ./dialog-overlay（拦住真实窗口创建，记录每次浮层创建挂到了哪个窗口）
// ══════════════════════════════════════════════════════════════════════════
const createdOverlays: FakeOverlay[] = []
const overlayPath = path.join(MAIN, 'js-dialog', 'dialog-overlay.js')
require.cache[overlayPath] = {
  id: overlayPath,
  filename: overlayPath,
  loaded: true,
  exports: {
    getJsDialogWindowPosition: () => ({ x: 0, y: 0 }),
    createOverlay: ({ parentWindow }: { parentWindow: FakeBrowserWindow }): FakeOverlay => {
      const overlay: FakeOverlay = {
        parentWindow,
        type: null,
        destroyed: false,
        // 浮层自身的 webContents：不属于任何浏览器窗口运行单元（对齐真实 Electron）
        wc: new FakeWebContents(),
        show (type: string) { this.type = type; return this.wc },
        getWebContents () { return this.wc },
        sendInit () {},
        sendTheme () {},
        destroy () { this.destroyed = true },
        isDestroyed () { return this.destroyed }
      }
      createdOverlays.push(overlay)
      return overlay
    }
  }
} as unknown as NodeModule

// ══════════════════════════════════════════════════════════════════════════
//  加载生产源码
// ══════════════════════════════════════════════════════════════════════════
const { createJsDialogManager } = require(path.join(MAIN, 'js-dialog', 'index.js'))
const { createWindowRuntimeRegistry } = require(path.join(MAIN, 'window-runtime-registry.js'))

// ══════════════════════════════════════════════════════════════════════════
//  断言基建
// ══════════════════════════════════════════════════════════════════════════
const results: TestResult[] = []
function check (name: string, ok: unknown, detail?: unknown): void {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + String(detail)}`)
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

/** 造一个「属于某窗口」的标签 webContents */
function tabOf (win: FakeBrowserWindow, tabId?: string | number): FakeWebContents {
  const wc = new FakeWebContents()
  ownerOf.set(wc, win)
  if (tabId !== undefined) wc.__ngTabId = String(tabId)
  return wc
}

/** 与 browser-window-assembly.mount() 完全同构的接线：每窗口一个 manager + 回填 runtime */
function setupTwoWindows (): TwoWindowHarness {
  const registry = createWindowRuntimeRegistry()
  const winA = new FakeBrowserWindow()
  const winB = new FakeBrowserWindow()
  const rtA: RuntimeUnit = { win: winA }
  const rtB: RuntimeUnit = { win: winB }
  registry.setPrimary(rtA)
  registry.register(rtB)
  const mgrA = createJsDialogManager({
    runtimeRegistry: registry,
    getParentWindow: () => winA,
    getAccentThemeInfo: () => null
  })
  rtA.jsDialogManager = mgrA
  const mgrB = createJsDialogManager({
    runtimeRegistry: registry,
    getParentWindow: () => winB,
    getAccentThemeInfo: () => null
  })
  rtB.jsDialogManager = mgrB
  return { registry, winA, winB, rtA, rtB, mgrA, mgrB }
}

function overlaysOn (win: FakeBrowserWindow): FakeOverlay[] { return createdOverlays.filter((overlay) => overlay.parentWindow === win) }

// ══════════════════════════════════════════════════════════════════════════
//  1. 对照组：旧接线「每窗口各注册一遍」→ 同一事件被处理两次（根因机制）
// ══════════════════════════════════════════════════════════════════════════
function testLegacyDoubleRegistration () {
  const legacyIpc = new FakeIpcMain()
  let handled = 0
  // 旧实现里 createJsDialogManager 每窗口调用一次，每次都在同一通道上注册 handler
  legacyIpc.on('jsDialog:show', () => { handled++ })
  legacyIpc.on('jsDialog:show', () => { handled++ })
  legacyIpc.dispatch('jsDialog:show', { sender: new FakeWebContents() }, { type: 'alert' })
  check('对照（旧接线）：每窗口各注册一遍 → 同一次 show 被处理两次', handled === 2, `handled=${handled}`)
  check('对照（旧接线）：同一次 show 会驱动两套 handler → 两个窗口各建一个浮层', handled === 2)
}

// ══════════════════════════════════════════════════════════════════════════
//  2. 通道注册收敛：多个窗口共用一条（进程级只注册一次）
// ══════════════════════════════════════════════════════════════════════════
function testSingleRegistration (harness: TwoWindowHarness) {
  check('通道收敛：jsDialog:show 只有 1 个 handler', ipcMain.handlerCount('jsDialog:show') === 1, `count=${ipcMain.handlerCount('jsDialog:show')}`)
  check('通道收敛：jsDialog:show-async 只有 1 个 handler', ipcMain.handlerCount('jsDialog:show-async') === 1, `count=${ipcMain.handlerCount('jsDialog:show-async')}`)
  check('通道收敛：jsDialog:response 只有 1 个 handler', ipcMain.handlerCount('jsDialog:response') === 1, `count=${ipcMain.handlerCount('jsDialog:response')}`)
  check('通道收敛：jsDialog:poll-result 只有 1 个 handler', ipcMain.handlerCount('jsDialog:poll-result') === 1, `count=${ipcMain.handlerCount('jsDialog:poll-result')}`)
  check('通道收敛：jsDialog:get-theme-info 只有 1 个 handler', ipcMain.handlerCount('jsDialog:get-theme-info') === 1, `count=${ipcMain.handlerCount('jsDialog:get-theme-info')}`)
  void harness
}

// ══════════════════════════════════════════════════════════════════════════
//  3. 浮层归属：A 的 alert 只挂在 A 上（不得出现在 B 上）
// ══════════════════════════════════════════════════════════════════════════
async function testAlertOwning (h: TwoWindowHarness): Promise<void> {
  createdOverlays.length = 0
  const tabA = tabOf(h.winA, 'w1t1')
  ipcMain.dispatch('jsDialog:show', { sender: tabA }, { type: 'alert', message: 'A 的提示', url: 'https://a.test/' })
  await tick()
  check('A 的 alert：只创建一个浮层', createdOverlays.length === 1, `n=${createdOverlays.length}`)
  check('A 的 alert：浮层挂在 A 上', createdOverlays[0] && createdOverlays[0].parentWindow === h.winA)
  check('A 的 alert：B 上没有任何浮层（不串台）', overlaysOn(h.winB).length === 0, `B=${overlaysOn(h.winB).length}`)
  // 收尾：用户点确定，A 的浮层销毁
  if (createdOverlays[0]) ipcMain.dispatch('jsDialog:response', { sender: createdOverlays[0].wc }, { action: 'ok' })
}

// ══════════════════════════════════════════════════════════════════════════
//  4. confirm/prompt 真同步：两窗口各自的 pending poll 互不干扰
// ══════════════════════════════════════════════════════════════════════════
async function testConfirmCrossTalk (h: TwoWindowHarness): Promise<void> {
  createdOverlays.length = 0
  const tabA = tabOf(h.winA, 'w1t1')
  ipcMain.dispatch('jsDialog:show-async', { sender: tabA }, { type: 'confirm', message: 'A?', url: 'https://a.test/' })
  await tick()
  check('A 的 confirm：创建 1 个浮层且挂在 A 上', createdOverlays.length === 1 && createdOverlays[0].parentWindow === h.winA, `n=${createdOverlays.length}`)
  const pollA: IpcEvent = { sender: tabA }
  ipcMain.dispatch('jsDialog:poll-result', pollA)
  check('A 的 confirm：结果未就绪时 poll 被挂起（未写 returnValue）', pollA.returnValue === undefined)

  const tabB = tabOf(h.winB, 'w2t1')
  ipcMain.dispatch('jsDialog:show-async', { sender: tabB }, { type: 'confirm', message: 'B?', url: 'https://b.test/' })
  await tick()
  check('B 的 confirm：B 也创建自己的浮层（不被 A 的浮层挡住/共享）', overlaysOn(h.winB).length === 1, `B=${overlaysOn(h.winB).length}`)
  const pollB: IpcEvent = { sender: tabB }
  ipcMain.dispatch('jsDialog:poll-result', pollB)
  check('B 的 confirm：B 的 poll 也各自挂起', pollB.returnValue === undefined)

  // 用户只在 B 的浮层上点了「确定」
  const overlayB = overlaysOn(h.winB)[0]
  if (!overlayB) { check('B 的应答：B 的 poll 拿到结果', false, 'B 无浮层'); }
  else {
    ipcMain.dispatch('jsDialog:response', { sender: overlayB.wc }, { action: 'ok', value: 'B-answer' })
    check('B 的应答：B 的 poll 拿到结果', pollB.returnValue && pollB.returnValue.action === 'ok' && pollB.returnValue.value === 'B-answer', JSON.stringify(pollB.returnValue))
    check('B 的应答：A 的挂起 poll 完全不受影响（仍未有 returnValue）', pollA.returnValue === undefined, `A.returnValue=${JSON.stringify(pollA.returnValue)}`)
  }

  // 现在 A 的用户才点「取消」
  const overlayA = overlaysOn(h.winA)[0]
  if (overlayA) {
    ipcMain.dispatch('jsDialog:response', { sender: overlayA.wc }, { action: 'cancel' })
    check('A 的应答：A 的 poll 拿到 cancel', pollA.returnValue && pollA.returnValue.action === 'cancel', JSON.stringify(pollA.returnValue))
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  5. 「阻止此页面创建更多弹窗」状态不跨窗口
// ══════════════════════════════════════════════════════════════════════════
async function testSuppressionIsolation (h: TwoWindowHarness): Promise<void> {
  createdOverlays.length = 0
  const tabA = tabOf(h.winA, 'w1t7')
  ipcMain.dispatch('jsDialog:show-async', { sender: tabA }, { type: 'confirm', message: 'A?', url: 'https://a.test/' })
  await tick()
  const overlayA = overlaysOn(h.winA)[0]
  if (!overlayA) { check('阻止更多弹窗：先在 A 上起一个浮层', false); return }
  // A 的用户勾选「阻止此页面创建更多弹窗」
  ipcMain.dispatch('jsDialog:response', { sender: overlayA.wc }, { action: 'cancel', suppress: true })

  createdOverlays.length = 0
  ipcMain.dispatch('jsDialog:show', { sender: tabA }, { type: 'alert', message: 'again', url: 'https://a.test/' })
  await tick()
  check('阻止更多弹窗：A 上被阻止的标签不再弹', createdOverlays.length === 0, `n=${createdOverlays.length}`)

  const tabB = tabOf(h.winB, 'w2t7')
  ipcMain.dispatch('jsDialog:show', { sender: tabB }, { type: 'alert', message: 'B', url: 'https://b.test/' })
  await tick()
  check('阻止更多弹窗：B 的弹窗不受 A 的阻止状态影响（只挂在 B 上）', createdOverlays.length === 1 && createdOverlays[0].parentWindow === h.winB, `n=${createdOverlays.length}`)
  if (createdOverlays[0]) ipcMain.dispatch('jsDialog:response', { sender: createdOverlays[0].wc }, { action: 'ok' })
}

// ══════════════════════════════════════════════════════════════════════════
//  6. 归属不可解析 → 明确告警 + 丢弃（绝不静默落到主窗口）
// ══════════════════════════════════════════════════════════════════════════
async function testUnresolvable (h: TwoWindowHarness): Promise<void> {
  createdOverlays.length = 0
  const orphanWin = new FakeBrowserWindow() // 未注册进 runtimeRegistry
  const orphanTab = tabOf(orphanWin, 'x1')
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (message: string) => warnings.push(String(message))
  try {
    ipcMain.dispatch('jsDialog:show', { sender: orphanTab }, { type: 'alert', message: 'orphan', url: 'https://o.test/' })
    await tick()
  } finally {
    console.warn = origWarn
  }
  check('归属不可解析：不创建任何浮层（不做主窗口兜底）', createdOverlays.length === 0, `n=${createdOverlays.length}`)
  check('归属不可解析：明确告警', warnings.some((w) => w.includes('jsDialog')), JSON.stringify(warnings))
  void h
}

// ══════════════════════════════════════════════════════════════════════════
//  7. 单窗口等价性（回归红线）：全新进程 + 只有一个窗口 + 不注入注册表
// ══════════════════════════════════════════════════════════════════════════
async function testSingleWindowEquivalence (): Promise<void> {
  // 换一个干净的 ipcMain 并重新加载模块 —— 模拟「单窗口、首次启动」的全新进程。
  // 必须在 require 之前替换 electronStub.ipcMain（模块加载时就解构了 ipcMain）。
  const freshIpc = new FakeIpcMain()
  const prevIpc = electronStub.ipcMain
  electronStub.ipcMain = freshIpc
  const indexPath = require.resolve(path.join(MAIN, 'js-dialog', 'index.js'))
  delete require.cache[indexPath]
  try {
    const fresh = require(indexPath)
    const win = new FakeBrowserWindow()
    // 单窗口：**不注入 runtimeRegistry**（模拟无注册表时的回落路径）
    const mgr = fresh.createJsDialogManager({ getParentWindow: () => win, getAccentThemeInfo: () => null })
    check('单窗口：jsDialog:show 只有 1 个 handler', freshIpc.handlerCount('jsDialog:show') === 1, `count=${freshIpc.handlerCount('jsDialog:show')}`)

    createdOverlays.length = 0
    const tab = tabOf(win, 'w1t1')
    freshIpc.dispatch('jsDialog:show', { sender: tab }, { type: 'alert', message: 'solo', url: 'https://s.test/' })
    await tick()
    check('单窗口：alert 正常弹出且挂在唯一窗口上', createdOverlays.length === 1 && createdOverlays[0].parentWindow === win, `n=${createdOverlays.length}`)

    // 浮层自身 webContents 发来的应答 / 主题查询 → 靠「浮层→manager」映射路由回唯一窗口
    const overlay = createdOverlays[0]
    const themeEvt: IpcEvent = { sender: overlay.wc }
    freshIpc.dispatch('jsDialog:get-theme-info', themeEvt)
    check('单窗口：jsDialog:get-theme-info 同步应答（浮层路由生效）', 'returnValue' in themeEvt, `rv=${JSON.stringify(themeEvt.returnValue)}`)
    freshIpc.dispatch('jsDialog:response', { sender: overlay.wc }, { action: 'ok' })
    check('单窗口：浮层应答后已销毁', overlay.destroyed === true)
    void mgr
  } finally {
    electronStub.ipcMain = prevIpc
  }
}

// ══════════════════════════════════════════════════════════════════════════
async function main (): Promise<void> {
  const h = setupTwoWindows()
  const sections: Array<[string, () => unknown | Promise<unknown>]> = [
    ['legacy', () => testLegacyDoubleRegistration()],
    ['single-registration', () => testSingleRegistration(h)],
    ['alert-owning', () => testAlertOwning(h)],
    ['confirm-cross-talk', () => testConfirmCrossTalk(h)],
    ['suppression-isolation', () => testSuppressionIsolation(h)],
    ['unresolvable', () => testUnresolvable(h)],
    ['single-window', () => testSingleWindowEquivalence()]
  ]
  for (const [name, fn] of sections) {
    try {
      await fn()
    } catch (error) {
      check(`探针异常(${name})`, false, errorMessage(error))
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log('\n========================================')
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join(' | '))
  console.log('========================================')
  process.exit(failed.length ? 1 : 0)
}

main()
