/**
 * verify-isolation.cjs — profile / space 隔离回归探针（纯 Node + 打桩 electron）
 *
 * 待证伪的假设（H1/H2 的同一根因）：
 *   browser-window-assembly.ts 的 open() 把空间运行态以 **`context:` 这个键**
 *   传给 createBrowserWindowRuntime()，而后者是从 deps 里 **解构 `spaceRuntime`**。
 *   键名不一致 → TabManager 收到 `context: undefined` → 落到构造函数兜底
 *   `{ getCurrent: () => ({ profileId:'default', spaceId:'default' }) }`
 *   （TabManager.js:70）。后果：
 *     ① 每个标签记录都被打上 profileId/spaceId = 'default'；
 *     ② list() 恒按 default/default 过滤 = 返回全部标签 → space 标签不隔离；
 *     ③ createTab 反查 profileId 得 'default' → 所有标签都拿 profiles/default
 *        的会话 → profile 数据隔离失效。
 *
 * 直接加载**生产源码**，只打桩 electron。不做任何写操作。
 * 用法（项目根）：node scripts/verify-isolation.cjs
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as Module from 'node:module'
import { EventEmitter } from 'node:events'
import { asRecord, isRecord } from './lib/type-guards'

interface Bounds { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }
interface SpacePoint { profileId: string; spaceId: string }
interface TimedRecord { name: string; ok: boolean }

const ROOT = path.resolve(__dirname, '..')
process.env.HIRA_APP_ROOT = ROOT

// ── electron 打桩（必须在 require 生产源码之前装好）────────────────────────
const ownerOf = new WeakMap<object, FakeBrowserWindow>()
let nextWcId = 1
let nextWinId = 1
const allWebContents: FakeWebContents[] = []
const allWindows: FakeBrowserWindow[] = []

class FakeWebContents extends EventEmitter {
  id: number
  _destroyed: boolean
  _url: string
  _sent: Array<{ channel: string; payload: unknown }>
  navigationHistory: { getAllEntries(): unknown[]; getActiveIndex(): number }

  constructor() {
    super()
    this.id = nextWcId++
    this._destroyed = false
    this._url = 'about:blank'
    this._sent = []
    this.navigationHistory = { getAllEntries: () => [], getActiveIndex: () => 0 }
  }
  isDestroyed() { return this._destroyed }
  destroy() { if (this._destroyed) return; this._destroyed = true; this.emit('destroyed') }
  isFocused() { return false }
  focus() { return true }
  getURL() { return this._url }
  loadURL(url: string) { this._url = String(url); return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  setWindowOpenHandler(_handler: unknown) {}
  setAudioMuted() {}
  setIgnoreMouseEvents() {}
  setBackgroundColor() {}
  executeJavaScript() { return Promise.resolve(null) }
  inspectElement() {}
  downloadURL() {}
  send(channel: string, payload?: unknown) { this._sent.push({ channel, payload }) }
}

class FakeView {
  _webPreferences: Record<string, unknown> | null
  webContents: FakeWebContents | null
  _children: FakeView[]
  _bounds: Bounds
  _visible: boolean
  _ownerWin: FakeBrowserWindow | null

  constructor(arg?: unknown) {
    const source = asRecord(arg)
    // 记录 webPreferences —— 本探针据此读出「这个 tab 被分到哪个 session」
    this._webPreferences = isRecord(source.webPreferences) ? source.webPreferences : null
    if (arg instanceof FakeWebContents) this.webContents = arg
    else if (isRecord(source.webContents) && typeof source.webContents.on === 'function') this.webContents = source.webContents as unknown as FakeWebContents
    else this.webContents = this._webPreferences ? new FakeWebContents() : null
    if (this.webContents && !allWebContents.includes(this.webContents)) allWebContents.push(this.webContents)
    this._children = []
    this._bounds = { x: 0, y: 0, width: 0, height: 0 }
    this._visible = true
    this._ownerWin = null
  }
  addChildView(view: FakeView) {
    const i = this._children.indexOf(view)
    if (i >= 0) this._children.splice(i, 1)
    this._children.push(view)
    const win = ownerOf.get(this) || this._ownerWin
    if (win) { view._ownerWin = win; if (view.webContents) ownerOf.set(view.webContents, win) }
  }
  removeChildView(view: FakeView) { const i = this._children.indexOf(view); if (i >= 0) this._children.splice(i, 1) }
  setBounds(bounds: Bounds) { this._bounds = { ...bounds } }
  getBounds() { return { ...this._bounds } }
  setVisible(visible: boolean) { this._visible = Boolean(visible) }
  getVisible() { return this._visible }
  setBackgroundColor() {}
  setBorderRadius() {}
}

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
    allWindows.push(this)
  }
  static fromWebContents(webContents: FakeWebContents): FakeBrowserWindow | null { return webContents ? ownerOf.get(webContents) || null : null }
  static getFocusedWindow() { for (const w of allWindows) if (!w._destroyed && w._focused) return w; return null }
  static getAllWindows() { return allWindows.filter((w) => !w._destroyed) }
  isDestroyed() { return this._destroyed }
  destroy() { this._destroyed = true; this.emit('closed'); this.emit('destroyed') }
  close() { this.destroy() }
  focus() { for (const w of allWindows) w._focused = false; this._focused = true; this.emit('focus') }
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
  loadURL(url: string) { this.webContents.loadURL(url); return Promise.resolve() }
}

class FakeIpcMain {
  _handlers: Map<string, Array<(...args: unknown[]) => unknown>>
  constructor() { this._handlers = new Map() }
  on(channel: string, handler: (...args: unknown[]) => unknown) {
    const handlers = this._handlers.get(channel) || []
    handlers.push(handler)
    this._handlers.set(channel, handlers)
    return this
  }
  handle() { return this }
}

const electronStub = {
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeView,
  View: FakeView,
  BaseWindow: FakeBrowserWindow,
  ipcMain: new FakeIpcMain(),
  session: { fromPartition: () => ({}), fromPath: () => ({}), defaultSession: {} },
  nativeTheme: { shouldUseDarkColors: false, on() {}, removeListener() {} },
  Menu: { buildFromTemplate: () => ({ popup() {}, closePopup() {} }), setApplicationMenu() {} },
  clipboard: { writeText() {}, readText: () => '' },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  app: { getAppPath: () => ROOT, getPath: () => path.join(ROOT, '.tmp') },
  components: { whenReady: () => Promise.resolve() },
  webContents: { getFocusedWebContents: () => null },
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
const results: TimedRecord[] = []
function check(name: string, ok: unknown, detail?: unknown): void {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + String(detail)}`)
}

// ── ① 静态接线检查：键名是否对得上 ────────────────────────────────────────
console.log('\n── ① 静态接线检查（源文件键名契约）──')
const asmSrc = fs.readFileSync(path.join(ROOT, 'apps/app-main/src/main/browser-window-assembly.ts'), 'utf8')
const rtSrc = fs.readFileSync(path.join(ROOT, 'apps/app-main/src/main/browser-window-runtime.ts'), 'utf8')

const callIdx = asmSrc.indexOf('createBrowserWindowRuntime({')
const callArgs = callIdx >= 0 ? asmSrc.slice(callIdx, callIdx + 2600) : ''
const passesContextKey = /\n\s{4,6}context:\s*spaceRuntime\s*,/.test(callArgs)
const passesSpaceRuntimeKey = /\n\s{4,6}spaceRuntime\s*[,:]/.test(callArgs)
const runtimeDestructuresSpaceRuntime = /^\s*spaceRuntime,\s*$/m.test(rtSrc.split('= deps')[0])

console.log(`    browser-window-assembly.ts open() 传给 createBrowserWindowRuntime 的键：` +
  `${passesContextKey ? 'context' : ''}${passesSpaceRuntimeKey ? ' + spaceRuntime' : ''}`)
check('接线：open() 传的是 spaceRuntime（不是 context）', !passesContextKey && passesSpaceRuntimeKey,
  passesContextKey ? '→ 实为 `context: spaceRuntime`，键名不匹配' : '')
check('接线：browser-window-runtime 解构的是 spaceRuntime', runtimeDestructuresSpaceRuntime)

// ── ② 运行时：装配出的 TabManager 到底拿到什么 context ────────────────────
console.log('\n── ② 运行时（装配器 open()，注入真实 spaceRuntime）──')
const { createBrowserWindowAssembly } = require(path.join(ROOT, 'apps/app-main/src/main/browser-window-assembly.ts'))
const { TabManager, WindowRegistry } = require('@hira-ng/infra-window')
const { tabRules } = require('@hira-ng/domain-tabs')
const { createWindowRuntimeRegistry } = require(path.join(ROOT, 'apps/app-main/src/main/window-runtime-registry.ts'))
const ipcIpc = require(path.join(ROOT, 'infra/infra-ipc/src/index.ts'))

/** 复刻 main.js:406-412 的 spaceRuntime —— 当前身份是 work/spaceA */
let cur: SpacePoint = { profileId: 'work', spaceId: 'spaceA' }
const spaceRuntime = {
  getCurrent: () => ({ ...cur }),
  setCurrent: ({ profileId, spaceId }: Partial<SpacePoint> = {}) => {
    cur = { profileId: String(profileId || 'default'), spaceId: String(spaceId || 'default') }
    return { ...cur }
  }
}

/** 会话解析端口：探针只需知道「被解析成了哪个 profileId」 */
const sessionCalls: string[] = []
const sessionsController = {
  resolve: (options: { profileId?: string } = {}) => {
    const profileId = options.profileId || ''
    sessionCalls.push(profileId)
    return { __resolvedProfile: profileId }
  }
}

const extService = { addTab() {}, selectTab() {}, getContextMenuItems: () => [] }
const shared = {
  runtimeRegistry: createWindowRuntimeRegistry(),
  windowRegistry: new WindowRegistry(),
  sessionsController,
  tabRules,
  getPdfViewerEnabled: () => true,
  getNewTabUrl: () => 'hira://newtab',
  getAutoPictureInPictureEnabled: () => false,
  getFaviconService: () => ({ cacheAndSync() {}, get: () => null }),
  getHistoryService: () => ({ addVisit() {}, updateTitle() {} }),
  getExtensionService: () => extService,
  getSearchService: () => ({ buildSearchUrl: (query: string) => `https://search/?q=${query}` }),
  getExtraTabWebPreferences: () => ({}),
  snapshotService: { capture: async () => null, forget() {}, resolveRequest: () => null },
  // 事件出口：_scheduleEmitChanged 的 queueMicrotask 会调用它，必须是函数
  emit: () => 0,
  openSubWindow: () => ({ ok: true }),
  onWindowMounted: () => {},
  onWindowClosed: () => {},
  onWindowTabsChanged: () => {}
}

const assembly = createBrowserWindowAssembly(shared)
const runtime = assembly.open({ isPrimary: true, spaceRuntime })
const tm = runtime.tabManager

const ctx = tm._context.getCurrent()
console.log(`    主进程注入的当前身份 = work/spaceA；TabManager._context.getCurrent() = ${ctx.profileId}/${ctx.spaceId}`)
check('TabManager 拿到注入的空间运行态（应为 work/spaceA）', ctx.profileId === 'work' && ctx.spaceId === 'spaceA',
  `实为 ${ctx.profileId}/${ctx.spaceId}`)
check('TabManager._context 具备 setCurrent（能真正切空间）', typeof tm._context.setCurrent === 'function')

// 新标签记录被打上什么身份
const rec = tm._createTabSync({ url: 'https://a.test/1' })
const t1 = tm._tabs.get(rec.tabId)
check('新标签记录带正确 profileId/spaceId（应为 work/spaceA）', t1.profileId === 'work' && t1.spaceId === 'spaceA',
  `实为 ${t1.profileId}/${t1.spaceId}`)

// 该标签被分到哪个 profile 的 session
const view = runtime.webContentsManager.getTab(rec.tabId)
const sess = view && view._webPreferences && view._webPreferences.session
console.log(`    sessionResolver 收到 profileId=${JSON.stringify(sessionCalls)}，tab 落到 profile=${sess && sess.__resolvedProfile}`)
check('标签会话按自己的 profile 解析（应为 work）', !!sess && sess.__resolvedProfile === 'work',
  `实为 ${sess && sess.__resolvedProfile}`)

// ── ③ space 标签隔离：两个空间的标签会不会串 ─────────────────────────────
console.log('\n── ③ space 标签隔离（切空间后 list() 是否过滤）──')
// 再补两个标签，模拟「在 spaceA 开了 3 个」
tm._createTabSync({ url: 'https://a.test/2' })
tm._createTabSync({ url: 'https://a.test/3' })
check('listAll() 见 3 个标签', tm.listAll().length === 3, `实为 ${tm.listAll().length}`)
check('spaceA 的 list() 见 3 个标签', tm.list().length === 3, `实为 ${tm.list().length}`)

// 切到同 profile 的另一个空间 spaceB：本空间没有标签 → 必须为空
tm.setCurrentSpace('work', 'spaceB')
check('切到 spaceB 后 list() 应为 0（spaceB 没有标签）', tm.list().length === 0, `实为 ${tm.list().length}`)

// 在 spaceB 新建 2 个：应只属于 spaceB，且不影响 spaceA
tm._createTabSync({ url: 'https://b.test/1' })
tm._createTabSync({ url: 'https://b.test/2' })
check('spaceB 的 list() 见 2 个标签', tm.list().length === 2, `实为 ${tm.list().length}`)
check('listAll() 合计 5 个（两空间相加，未互相覆盖）', tm.listAll().length === 5, `实为 ${tm.listAll().length}`)

// 两个空间来回切：各自只看得见自己的标签
tm.setCurrentSpace('work', 'spaceA')
check('切回 spaceA → 只见本空间 3 个标签', tm.list().length === 3, `实为 ${tm.list().length}`)
tm.setCurrentSpace('work', 'spaceB')
check('再切到 spaceB → 只见本空间 2 个标签', tm.list().length === 2, `实为 ${tm.list().length}`)

// 跨 profile：另一 profile 的标签一条都不该出现在本 profile 的投影里
tm._createTabSync({ url: 'https://c.test/', profileId: 'other', spaceId: 'main' })
check('跨 profile：other profile 的标签不混入 work 的投影',
  tm.list().every((tab: { profileId?: string }) => tab.profileId === 'work'), `实为 ${JSON.stringify(tm.list().map((tab: { profileId?: string }) => tab.profileId))}`)
check('跨 profile：listAll() 仍能看见 6 个（隔离只作用于投影，不丢标签）', tm.listAll().length === 6, `实为 ${tm.listAll().length}`)

// ── 汇总 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok).length
console.log(`\n════ 结果：${results.length - failed}/${results.length} 通过，${failed} 条 FAIL ════`)
console.log(failed > 0
  ? 'FAIL 即为「隔离失效」的确证：根因见 ①（键名不匹配）+ ②③（下游后果）。'
  : '全部通过 —— 隔离接线正确。')
process.exitCode = failed > 0 ? 1 : 0
