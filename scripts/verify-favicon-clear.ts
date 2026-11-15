/**
 * verify-favicon-clear.cjs —— 标签 favicon「导航到无图标页面应清空」回归测试
 *
 * 真实 bug（用户原话）：
 *   从**有 favicon** 的页面导航到**没有 favicon** 的页面后，标签栏仍显示上一个页面的图标，
 *   应回归为「无图标」。
 *
 * 根因（infra/infra-window/src/tabEvents.js）：
 *   · page-favicon-updated 只在「有 favicon」时设置 t.favicon —— 空数组时什么都不做；
 *   · did-navigate / did-navigate-in-page / did-start-navigation 都不清 t.favicon。
 *   于是无图标页面不会发非空 favicon 事件，t.favicon 一直保留上一个站点的值，
 *   经 _projectTab 的 favicon 字段下发到渲染层继续显示。
 *
 * 本脚本直接加载**生产源码**（tabEvents.bindTabEvents + TabManager._projectTab），
 * 用真实 wc 事件序列重放，断言 t.favicon 与投影字段的清空语义。
 * 与 scripts/verify-tab-*.cjs 同构：纯 Node（无需 Electron 实例），退出码 0 = 全部通过。
 *
 * 用法（在项目根执行）：
 *   node scripts/verify-favicon-clear.cjs
 */
const path = require('path')
const { EventEmitter } = require('events')

const ROOT = path.join(__dirname, '..', 'infra', 'infra-window', 'src')
const { bindTabEvents } = require(path.join(ROOT, 'tabEvents.js'))
const { TabManager } = require(path.join(ROOT, 'TabManager.js'))

interface TestResult {
  name: string
  ok: boolean
  detail: string
}

const results: TestResult[] = []
function check (name: string, ok: unknown, detail?: unknown): void {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  if (!ok) process.exitCode = 1
}

function makeWc () {
  const wc = new EventEmitter()
  wc.setWindowOpenHandler = () => {}
  wc.isDestroyed = () => false
  wc.navigationHistory = { getAllEntries: () => [], getActiveIndex: () => 0 }
  wc.downloadURL = () => {}
  return wc
}

const wc = makeWc()
const host = {
  _tabs: new Map(),
  _boundTabIds: new Set(),
  _wcToTabId: new Map(),
  _emitCount: 0,
  _faviconHookCalls: [] as Array<[string, string]>,
  _wcm: { createTab: () => ({ webContents: wc }), getTab: () => ({ webContents: wc }) },
  _layout: { getWindow: () => null },
  _hooks: {},
  _onFaviconUpdated (url: string, fav: string) { host._faviconHookCalls.push([url, fav]) },
  _isCurrentWc (_id: string, w: unknown) { return w === wc },
  _createTabSync () { return { view: { webContents: wc } } },
  _scheduleEmitChanged () { host._emitCount++ },
  _emit () {},
  emit () {},
  newTab () { return Promise.resolve() }
}
host._tabs.set('tab-1', {
  tabId: 'tab-1', url: 'https://a.example/', favicon: '', title: '', navHistory: [], navHistoryIndex: 0
})

bindTabEvents(host, 'tab-1')
const t = host._tabs.get('tab-1')

// 1) 有 favicon 的页面 A → 写入
wc.emit('page-favicon-updated', {}, ['https://a.example/fav.ico'])
check('A 页 favicon 写入 t.favicon', t.favicon === 'https://a.example/fav.ico', t.favicon)
check('A 页 favicon 写历史(正向路径被调用)', host._faviconHookCalls.length === 1, JSON.stringify(host._faviconHookCalls))

// 2) A → B 跨文档主框架导航开始 → 清空（本 bug 核心）
const hookBefore = host._faviconHookCalls.length
wc.emit('did-start-navigation', {}, 'https://b.example/', false, true)
check('跨文档主框架导航开始 → t.favicon 清空', t.favicon === '', JSON.stringify(t.favicon))
check('清空路径不调用 _onFaviconUpdated(不污染历史)', host._faviconHookCalls.length === hookBefore, JSON.stringify(host._faviconHookCalls))

// 2b) 投影给渲染层的 favicon 为空
const fakeThis = { _layout: { getActiveTabId: () => 'tab-1' } }
const proj = TabManager.prototype._projectTab.call(fakeThis, 'tab-1', t, 'tab-1')
check('_projectTab 下发给渲染层的 favicon 为空串', proj.favicon === '', JSON.stringify(proj.favicon))
const projNoFav = TabManager.prototype._projectTab.call(fakeThis, 'tab-1', { favicon: undefined }, 'tab-1')
check('_projectTab 对缺失 favicon 也给空串', projNoFav.favicon === '', JSON.stringify(projNoFav.favicon))

// 3) 真实时序：did-navigate 提交新 URL → 再收到 B 的 favicon
wc.emit('did-navigate', {}, 'https://b.example/')
check('did-navigate 后 t.url=B', t.url === 'https://b.example/', t.url)
check('did-navigate 不清 favicon（清空只发生在导航开始）', t.favicon === '', JSON.stringify(t.favicon))
wc.emit('page-favicon-updated', {}, ['https://b.example/fav.ico'])
check('B 页 favicon 写入 t.favicon', t.favicon === 'https://b.example/fav.ico', t.favicon)
check('favicon 写历史用的是提交后的新 URL(无张冠李戴)',
  host._faviconHookCalls.length === 2 && host._faviconHookCalls[1][0] === 'https://b.example/',
  JSON.stringify(host._faviconHookCalls))

// 3a) 同文档（哈希 / SPA，isInPlace=true）不清 —— 站内导航不闪
wc.emit('did-start-navigation', {}, 'https://b.example/#sec', true, true)
check('同文档导航(isInPlace=true) 不清 favicon', t.favicon === 'https://b.example/fav.ico', t.favicon)

// 3b) did-navigate-in-page 不清
wc.emit('did-navigate-in-page', {}, 'https://b.example/#x')
check('did-navigate-in-page 不清 favicon', t.favicon === 'https://b.example/fav.ico', t.favicon)

// 4) 空数组 favicon 事件 → 清空（且不写历史）
const hookBefore2 = host._faviconHookCalls.length
wc.emit('page-favicon-updated', {}, [])
check('page-favicon-updated 空数组 → 清空', t.favicon === '', JSON.stringify(t.favicon))
check('空数组清空不写历史', host._faviconHookCalls.length === hookBefore2, JSON.stringify(host._faviconHookCalls))

// 4b) 首元素为空串也清
wc.emit('page-favicon-updated', {}, ['https://b.example/fav.ico'])
wc.emit('page-favicon-updated', {}, [''])
check('首元素为空串 → 清空', t.favicon === '', JSON.stringify(t.favicon))

// 5) 非主框架导航不清
wc.emit('page-favicon-updated', {}, ['https://c.example/fav.ico'])
wc.emit('did-start-navigation', {}, 'https://c.example/iframe', false, false)
check('非主框架导航不清 favicon', t.favicon === 'https://c.example/fav.ico', t.favicon)

// 6) 去错误页不清（既有早退分支不被破坏）
wc.emit('did-start-navigation', {}, 'hira://error?errorCode=-105&url=x', false, true)
check('导航到 hira://error 不清 favicon（既有分支保持）', t.favicon === 'https://c.example/fav.ico', t.favicon)

// 7) 同站点刷新 / 站内跳转 → **保留** favicon
//    实测（Electron 探针）：Chromium 只在图标首次到达时发一次 page-favicon-updated，
//    同 URL 刷新**不会再发**。所以刷新时清空 = 图标永久消失（用户报的 bug）。
wc.emit('did-navigate', {}, 'https://d.example/')
wc.emit('page-favicon-updated', {}, ['https://d.example/fav.ico'])
check('D 页 favicon 写入', t.favicon === 'https://d.example/fav.ico', t.favicon)
wc.emit('did-start-navigation', {}, 'https://d.example/', false, true)
check('同站点刷新(同 host) → favicon 保留', t.favicon === 'https://d.example/fav.ico', t.favicon)
wc.emit('did-start-navigation', {}, 'https://d.example/other', false, true)
check('同 host 站内跳转 → favicon 保留', t.favicon === 'https://d.example/fav.ico', t.favicon)
wc.emit('did-start-navigation', {}, 'https://e.example/', false, true)
check('换 host → 仍清空', t.favicon === '', JSON.stringify(t.favicon))

// 7b) 跳到非 http(s) 页面（hira://newtab 等）算换站 → 清空
wc.emit('did-navigate', {}, 'https://f.example/')
wc.emit('page-favicon-updated', {}, ['https://f.example/fav.ico'])
wc.emit('did-start-navigation', {}, 'hira://newtab', false, true)
check('跳到 hira:// 页面 → 清空', t.favicon === '', JSON.stringify(t.favicon))

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`)
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
