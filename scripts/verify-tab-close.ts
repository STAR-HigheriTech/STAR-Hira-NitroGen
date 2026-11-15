/**
 * 标签栏交互回归：中键关闭 / 双击关闭
 *
 * 为什么用无头 Electron 而不是 jsdom：
 *   auxclick / dblclick 的派发细节（以及中键 mousedown 的 preventDefault 与
 *   auxclick 是否互相影响）只有真实 Blink 才作数，所以这里用真实渲染进程 +
 *   webContents.sendInputEvent 投递 **trusted** 鼠标事件。
 *
 * 用法：unset ELECTRON_RUN_AS_NODE && ./node_modules/.bin/electron scripts/verify-tab-close.cjs
 */
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

const { app, BrowserWindow } = require('electron') as typeof import('electron')

interface TestResult {
  name: string
  ok: boolean
  extra?: unknown
}

type TabCall = [string, string]

interface Point {
  x: number
  y: number
  w?: number
}

type RectMap = Record<string, Point>

const ROOT = path.resolve(__dirname, '..')
const TMP = path.join(os.tmpdir(), `hira-tabclose-${Date.now()}`)

const results: TestResult[] = []
function check(name: string, ok: unknown, extra?: unknown): void {
  results.push({ name, ok: !!ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`)
}

async function bundleTabbar() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild')) as typeof import('esbuild')
  fs.mkdirSync(TMP, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'ui/ui-tabbar/src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: path.join(TMP, 'tabbar.mjs'),
    logLevel: 'silent'
  })
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%}
  body{background:#f5f5f5}
  #tabs{height:36px}
</style></head><body>
<div id="root"></div>
<script type="module">
import { injectTabbarStyles, createTabbar } from './tabbar.mjs'
window.__calls = []
window.__menuCall = 0
injectTabbarStyles(document)
const tabbar = createTabbar(document, {
  onCloseTab: (id) => window.__calls.push(['close', id]),
  onSwitchTab: (id) => window.__calls.push(['switch', id]),
  onToggleMute: (id) => window.__calls.push(['mute', id]),
  showMenu: async (req) => {
    window.__menuCall++
    window.__menuActions = req.items.map(i => i.action || i.type)
    return window.__nextMenuAction || null
  }
})
document.getElementById('root').appendChild(tabbar.element)
tabbar.renderTabs([
  { tabId: 't1', title: 'One', url: 'https://a.test/1', active: true },
  { tabId: 't2', title: 'Two', url: 'https://b.test/2' },
  { tabId: 't3', title: 'Three', url: 'https://c.test/3' }
])
window.__tabbar = tabbar
window.__ready = true
</script>
</body></html>`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// file:// 下 Chromium 会以 CORS 拒绝 ESM import，所以起个本地 http 服务喂页面
const MIME: Record<string, string> = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' }
function serveLocal(dir: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html'
      const file = path.join(dir, rel)
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function main(): Promise<void> {
  await bundleTabbar()
  fs.writeFileSync(path.join(TMP, 'index.html'), HTML, 'utf8')
  const server = await serveLocal(TMP)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('标签关闭探针服务未监听 TCP 端口')
  const port = address.port

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 200,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false }
  })
  // 探针窗口销毁后不要让进程直接退出（否则后续步骤全丢）
  app.on('window-all-closed', () => {})

  await win.loadURL(`http://127.0.0.1:${port}/index.html`)
  await sleep(250)
  const ready = await win.webContents.executeJavaScript('!!window.__ready')
  check('tabbar 渲染完成', ready)

  const rects = await win.webContents.executeJavaScript(`
    Object.fromEntries([...document.querySelectorAll('.tab-item')].map(el => {
      const r = el.getBoundingClientRect()
      return [el.dataset.tabId, { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width) }]
    }))
  `) as RectMap
  check('渲染出 3 个标签订阅', Object.keys(rects).length === 3, rects)

  const reset = () => win.webContents.executeJavaScript('window.__calls = []; true')
  const calls = (): Promise<TabCall[]> => win.webContents.executeJavaScript('window.__calls') as Promise<TabCall[]>

  // ── 1. 中键单击关闭 ────────────────────────────────────────
  await reset()
  const p2 = rects.t2
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p2.x, y: p2.y, button: 'middle', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p2.x, y: p2.y, button: 'middle', clickCount: 1 })
  await sleep(150)
  let c = await calls()
  check('中键关闭：触发 onClose(t2)', c.some((x) => x[0] === 'close' && x[1] === 't2'), c)
  check('中键关闭：不触发 onSwitch（不会先切过去）', !c.some((x) => x[0] === 'switch'), c)
  check('中键关闭：只关一个', c.filter((x) => x[0] === 'close').length === 1, c)

  // 中键落在关闭按钮上同样关闭（与 Chrome 一致）
  await reset()
  const btnRect = await win.webContents.executeJavaScript(`
    (() => { const r = document.querySelector('.tab-item[data-tab-id="t3"] .tab-close-button').getBoundingClientRect()
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()
  `) as Point
  win.webContents.sendInputEvent({ type: 'mouseDown', x: btnRect.x, y: btnRect.y, button: 'middle', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: btnRect.x, y: btnRect.y, button: 'middle', clickCount: 1 })
  await sleep(150)
  c = await calls()
  check('中键落在 ✕ 上：关闭该标签且不重复触发', c.filter((x) => x[0] === 'close' && x[1] === 't3').length === 1, c)

  // ── 2. 双击关闭 ────────────────────────────────────────────
  await reset()
  const p1 = rects.t1
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p1.x, y: p1.y, button: 'left', clickCount: 2 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p1.x, y: p1.y, button: 'left', clickCount: 2 })
  await sleep(200)
  c = await calls()
  check('双击关闭：触发 onClose(t1)', c.some((x) => x[0] === 'close' && x[1] === 't1'), c)
  check('双击关闭：只关一次（不重复）', c.filter((x) => x[0] === 'close').length === 1, c)

  // 单击仍然只是切换，不关闭
  await reset()
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  await sleep(150)
  c = await calls()
  check('单击：只切换不关闭', c.length === 1 && c[0][0] === 'switch' && c[0][1] === 't1', c)

  // 慢双击（间隔 400ms > 阈值 250ms）：即便 Blink 仍按 clickCount=2 派发 dblclick，
  // 间隔过滤层也要把它当成两次普通单击，不关闭 —— 防误触关错标签。
  await reset()
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p1.x, y: p1.y, button: 'left', clickCount: 1 })
  await sleep(400)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p1.x, y: p1.y, button: 'left', clickCount: 2 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p1.x, y: p1.y, button: 'left', clickCount: 2 })
  await sleep(150)
  c = await calls()
  check('慢双击：间隔超阈值 → 不关闭，只两次 switch',
    !c.some((x) => x[0] === 'close') && c.filter((x) => x[0] === 'switch').length === 2, c)

  // 真实场景：两次 click 之间主进程会广播 tabs:changed → renderTabs 重建整个 DOM。
  // dblclick 不能被「节点被换掉」打掉，否则双击关标签在真机上时灵时不灵。
  await reset()
  const p3 = rects.t3
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p3.x, y: p3.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p3.x, y: p3.y, button: 'left', clickCount: 1 })
  await win.webContents.executeJavaScript(`
    window.__tabbar.renderTabs([
      { tabId: 't1', title: 'One', url: 'https://a.test/1', active: true },
      { tabId: 't2', title: 'Two', url: 'https://b.test/2' },
      { tabId: 't3', title: 'Three', url: 'https://c.test/3' }
    ]); true
  `)
  await sleep(50)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p3.x, y: p3.y, button: 'left', clickCount: 2 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p3.x, y: p3.y, button: 'left', clickCount: 2 })
  await sleep(200)
  c = await calls()
  check('双击关闭：DOM 中途被重建（模拟 tabs:changed）仍能关闭', c.some((x) => x[0] === 'close' && x[1] === 't3'), c)

  // 双击 ✕：按钮自身的两次 click 各关一次（这是原生按钮语义，不叠加），
  // 关键是标签级 dblclick 被守卫拦下 —— 否则会出现第 3 次 close，
  // 且按钮的 stopPropagation 保证不会顺带触发 switch。
  await reset()
  win.webContents.sendInputEvent({ type: 'mouseDown', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 2 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: btnRect.x, y: btnRect.y, button: 'left', clickCount: 2 })
  await sleep(200)
  c = await calls()
  check('双击 ✕：仅按钮自身语义（2 次 click），不叠加标签级 dblclick',
    c.filter((x) => x[0] === 'close').length === 2 && c.every((x) => x[0] === 'close' && x[1] === 't3'), c)

  // ── 3. 右键菜单不再提供「重命名标签」（该项已移除）───────────
  const failed = results.filter((r) => !r.ok)
  console.log('\n========================================')
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join(' | '))
  console.log('========================================')

  try { server.close() } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() =>
  main().catch((error: unknown) => {
    console.error('探针异常:', error)
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
    app.exit(2)
  })
)
