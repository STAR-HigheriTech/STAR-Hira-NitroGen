/**
 * hira:// 内部页验证探针
 *
 * 用法（在 1A-STAR_Hira_NG/ 下）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/.bin/electron scripts/verify-pages.cjs 2>&1 | sed -n '/###REPORT###/,$p'
 *
 * 做三件事：
 *   1. 直接 require out/main/hira-protocol.js（构建产物）注册协议 —— 测的是真实分发逻辑
 *   2. 给常用 ngipc 路由打桩并统计调用次数
 *   3. 逐个加载 hira://<host>，回读计算样式 / DOM / 控制台错误，同时探测 hira://shared/*
 *
 * 期望结果：所有页面 ok=true、errors 为空、共享资源 200、registry 含全部页面 host。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { errorMessage } from './lib/type-guards.ts'

const { app, BrowserWindow, ipcMain } = require('electron') as typeof import('electron')

interface HiraProtocol {
  registerHiraProtocol: () => void
  listHiraPages: () => string[]
}

interface PageProbe {
  host: string
  url: string
  ok: boolean
  error?: string
  errors: string[]
  [key: string]: unknown
}

interface PageReport {
  pages: PageProbe[]
  registry: string[]
  sharedAssets: Record<string, string>
  ipcRoutesCalled?: string[]
}

const NG = path.join(__dirname, '..')
const OUT_PAGES = path.join(NG, 'out', 'pages')
const PROTOCOL = path.join(NG, 'out', 'main', 'hira-protocol.js')

if (!fs.existsSync(PROTOCOL)) {
  console.log('###FATAL### 未找到 ' + PROTOCOL + '，先跑 pnpm build')
  process.exit(1)
}

const tmp = path.join(os.tmpdir(), 'hira-ng-verify-' + process.pid)
fs.mkdirSync(tmp, { recursive: true })
app.setPath('userData', tmp)

const hira = require(PROTOCOL) as HiraProtocol
;(require(path.join(NG, 'out', 'main', 'scheme-privileges.js')) as { registerAppSchemes: () => void }).registerAppSchemes()

// ── 打桩数据：按需增删 ────────────────────────────────────────────────────────
const STUB = {
  'history:list': [
    { id: 'h1', url: 'https://example.com/a', title: 'Example A', visitedAt: 1700000000000 },
    { id: 'h2', url: 'https://example.org/b', title: 'Example B', visitedAt: 1700000001000 }
  ],
  'history:search': [{ id: 'h9', url: 'https://s.example', title: 'S', visitedAt: 1700000002000 }],
  'history:remove': { ok: true },
  'history:clear': { ok: true },
  'bookmark:list': [
    { id: 'f1', title: 'Folder One', url: null },
    { id: 'b1', url: 'https://example.com', title: 'BM One' }
  ],
  'bookmark:search': [{ id: 'b2', url: 'https://s.example', title: 'BM S' }],
  'bookmark:add': { ok: true },
  'bookmark:remove': { ok: true },
  'bookmark:export': '<html></html>',
  'bookmark:import': { imported: 0, skipped: 0 },
  'bookmark:import-formats': { formats: [] },
  'download:list': [
    { id: 'd1', url: 'https://example.com/f.zip', filename: 'f.zip', receivedBytes: 512, totalBytes: 2048, state: 'in_progress' },
    { id: 'd2', url: 'https://example.com/g.pdf', filename: 'g.pdf', receivedBytes: 999, totalBytes: 999, state: 'completed', filePath: 'C:/tmp/g.pdf' }
  ],
  'download:pause': { ok: true },
  'download:resume': { ok: true },
  'download:cancel': { ok: true },
  'download:remove': { ok: true },
  'download:clear-completed': { ok: true },
  'extension:list': [{ id: 'e1', name: 'Ext One', version: '1.0.0', enabled: true, iconPath: '' }],
  'extension:toggle': { ok: true },
  'extension:uninstall': { ok: true },
  'extension:import-folder': { ok: true },
  'profile:list': [
    { id: 'default', name: 'Default', isActive: true, color: '#0a84ff' },
    { id: 'p2', name: 'Work', isActive: false, color: '#16a34a' }
  ],
  'profile:create': { ok: true },
  'profile:update': { ok: true },
  'profile:remove': { ok: true },
  'profile:set-active': { ok: true },
  'settings:schema': { sections: [] },
  'settings:list': { values: {} }
}

// ── 需要带 query 才能有意义地加载的页面 ──────────────────────────────────────
const URL_OVERRIDES: Record<string, string> = {
  error: 'hira://error/?errorCode=-105&url=https%3A%2F%2Fexample.com%2Fx'
}

const calls: string[] = []
function registerStubs () {
  for (const [route, value] of Object.entries(STUB)) {
    ipcMain.handle('ngipc:invoke:' + route, () => {
      calls.push(route)
      return value
    })
  }
}

const MEASURE = `(() => {
  const g = (sel, prop) => { const n = document.querySelector(sel); return n ? getComputedStyle(n)[prop] : null }
  return {
    title: document.title,
    bridge: !!(window.hira && window.hira.provider && typeof window.hira.provider.invoke === 'function'),
    bodyBg: g('body', 'backgroundColor'),
    bodyPad: g('body', 'padding'),
    h1Text: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
    h1Size: g('h1', 'fontSize'),
    btnPad: g('.btn', 'padding'),
    btnRadius: g('.btn', 'borderRadius'),
    rows: document.querySelectorAll('.row').length,
    rowPad: g('.row', 'padding'),
    rowCursor: g('.row', 'cursor'),
    emptyText: document.querySelector('.empty') ? document.querySelector('.empty').textContent : null
  }
})()`

async function main () {
  registerStubs()
  hira.registerHiraProtocol()

  const hosts = fs.readdirSync(OUT_PAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort()

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(NG, 'out', 'preload', 'tab.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  const errors: string[] = []
  win.webContents.on('console-message', (details, level, message) => {
    const effectiveLevel = details.level ?? level
    const text = details.message ?? message
    if (String(effectiveLevel) === '3' || String(effectiveLevel) === 'error') errors.push(String(text).slice(0, 160))
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    errors.push('DID_FAIL_LOAD ' + code + ' ' + desc + ' ' + url)
  })

  const report: PageReport = { pages: [], registry: hira.listHiraPages().sort(), sharedAssets: {} }

  for (const host of hosts) {
    const url = URL_OVERRIDES[host] || ('hira://' + host + '/')
    const before = calls.length
    errors.length = 0
    try {
      await win.loadURL(url)
      await new Promise((r) => setTimeout(r, 450))
      const m = await win.webContents.executeJavaScript(MEASURE, true) as Record<string, unknown>
      report.pages.push({ host, url, ok: true, ...m, ipcCalls: calls.length - before, errors: errors.slice(0, 4) })
    } catch (error) {
      report.pages.push({ host, url, ok: false, error: errorMessage(error).slice(0, 200), errors: errors.slice(0, 4) })
    }
  }

  for (const f of ['base.css', 'runtime.js']) {
    report.sharedAssets[f] = await win.webContents.executeJavaScript(
      `fetch('hira://shared/${f}').then(r => r.status + ' ' + r.headers.get('content-type')).catch(e => 'ERR ' + e.message)`, true
    )
  }

  report.ipcRoutesCalled = Array.from(new Set(calls)).sort()
  console.log('###REPORT###')
  console.log(JSON.stringify(report, null, 2))

  win.destroy()
  app.quit()
}

app.whenReady().then(main).catch((error: unknown) => {
  console.log('###FATAL###', error instanceof Error ? error.stack ?? error.message : String(error))
  app.quit()
})
