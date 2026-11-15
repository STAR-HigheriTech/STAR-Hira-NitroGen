#!/usr/bin/env node
/**
 * 标签栏（ui-tabbar）**视觉回归基线**的运行器。
 *
 *   pnpm test:ui-tabbar                 与基线对比（首次运行会自动生成基线）
 *   pnpm test:ui-tabbar -- --update     用本次结果覆盖基线（**改完确认没画坏才这么用**）
 *   pnpm test:ui-tabbar -- --case=003   只跑某一条
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是"真 Chromium 截图"而不是 jsdom / DOM 快照
 * ══════════════════════════════════════════════════════════════════════
 * 这份基线的全部价值就是**像素**。jsdom 不做布局、不做层叠、算不了
 * `getBoundingClientRect` —— 拿它跑出来的"视觉基线"测的是桩，不是渲染，
 * 而"标签变窄了 / 下划线画歪了 / 深色下糊成一片"这类问题恰恰只有真渲染才看得见。
 *
 * 所以链路是：esbuild 现场打包 `ui/ui-tabbar`（**与生产同一个源文件**）
 * → 本地 http 喂给一个真实 BrowserWindow → `capturePage` → 与基线比像素。
 * 参考实现见既有的 `scripts/verify-tab-close.cjs`（同一套思路，那次是验交互）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 数据怎么来的
 * ══════════════════════════════════════════════════════════════════════
 * 全部来自 `cases.ts` 的**纯数据**投影（`renderTabs()` 的入参形态）。
 * 不启动 app、不启插件、不连网络 —— 基线只应该反映"渲染器"，任何会随时间/网络
 * 变化的东西（真实 favicon、真实标题）都会让基线永远在飘。
 */

// ── 必须由 electron 运行（`require('electron')` 在纯 node 下只返回一个路径字符串）──
// 这里**刻意不自动 spawn electron 重跑**：在本项目的环境里那样起会带着
// ELECTRON_RUN_AS_NODE 的残留一路崩在 V8 初始化（isolate snapshot 断言），
// 报错完全指不到真正原因。直接说清楚"要用哪条命令"，比自动重试好排查得多。
if (!process.versions.electron) {
  console.error('[tabbar-baseline] 需要用 Electron 运行：pnpm test:ui-tabbar')
  process.exit(2)
}

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { BrowserWindow as BrowserWindowType } from 'electron'

interface PngImage { width: number; height: number; data: Buffer }
interface PngModule {
  new(options: { width: number; height: number }): PngImage
  sync: { read(buffer: Buffer): PngImage; write(png: PngImage): Buffer }
}
interface TabbarWindow extends BrowserWindowType { __port: number }
interface CaseResult {
  caseDef: TabbarCaseDefinition
  status: 'updated' | 'created' | 'pass' | 'fail'
  metrics?: TabbarMetrics | null
  prevMetrics?: TabbarMetrics | null
  matchRate?: number
  diffPixels?: number
}

const { app, BrowserWindow, screen } = require('electron') as typeof import('electron')
const pixelmatch = (require('pixelmatch') as { default: (a: Buffer, b: Buffer, output: Buffer, width: number, height: number, options?: { threshold?: number }) => number }).default
const { PNG } = require('pngjs') as { PNG: PngModule }

const CASES = require('./cases.ts') as TabbarCaseDefinition[]

// tests/ui/tabbar/run.cjs → 仓库根要往上三层
const ROOT = path.resolve(__dirname, '..', '..', '..')
const BASELINE_DIR = path.join(ROOT, 'docs-ng', 'ui-baseline', 'tabbar')
const RUN_ID = String(Date.now())
const OUTPUT_DIR = path.join(ROOT, 'tests', 'ui', 'output', 'tabbar', RUN_ID)
const TMP = path.join(os.tmpdir(), `hira-tabbar-baseline-${RUN_ID}`)

const TOKEN_CSS = ['tokens-base.css', 'layers.css', 'tokens-light.css', 'tokens-dark.css']
  .map((f) => path.join(ROOT, 'packages', 'shared-ui-tokens', f))

function arg(name: string, fallback: string | boolean): string | boolean {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  return process.argv.includes(`--${name}`) ? true : fallback
}

const UPDATE = arg('update', false) === true
const ONLY = arg('case', '')
const THRESHOLD = Number(arg('threshold', '0.1'))
const PASS_RATE = Number(arg('passRate', '0.99'))

/**
 * 硬超时兜底：无人值守时最怕的不是"失败"而是"卡住" —— 失败能看见原因，
 * 卡住只会白白吃掉整条流水线的时间（且没有任何线索）。
 * 正常路径会在 main() 收尾时清掉它。
 */
const HARD_TIMEOUT_MS = 90_000
const hardTimer = setTimeout(() => {
  console.error(`[tabbar-baseline] 超过 ${HARD_TIMEOUT_MS / 1000}s 未完成，强制退出`)
  app.exit(3)
}, HARD_TIMEOUT_MS)
if (typeof hardTimer.unref === 'function') hardTimer.unref()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** esbuild 现场打包：与生产同一个入口文件，不做任何"为测试特制"的替换。 */
async function bundle(): Promise<void> {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  fs.mkdirSync(TMP, { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'ui/ui-tabbar/src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(TMP, 'tabbar.mjs'),
    logLevel: 'silent'
  })
  const pageSource = fs.readFileSync(path.join(__dirname, 'page.ts'), 'utf8')
  const pageCode = esbuild.transformSync(pageSource, {
    loader: 'ts',
    format: 'esm',
    target: 'chrome128',
    sourcefile: 'tests/ui/tabbar/page.ts'
  }).code
  fs.writeFileSync(path.join(TMP, 'page.js'), pageCode)
}

/** 每个 case 一个 html：case 数据以字面量注入，页面侧不做任何解析。
 *
 *  ⚠ 这个模板串里**不能出现反引号**（注释里也不行）—— 那会直接把模板字符串截断，
 *  表现为「SyntaxError: Invalid left-hand side expression in postfix operation」，
 *  而且 Electron 的模块加载错误会弹一个错误框把进程**挂住**（不退出、不报错到 stdout）。
 *  引用标识符一律用「」。 */
function writeCaseHtml(caseDef: TabbarCaseDefinition, tokenCss: string): void {
  const html = `<!doctype html><html data-theme="${caseDef.theme}"><head><meta charset="utf-8">
<style>
${tokenCss}
/* 基线只截 #root 这块区域：去掉页面默认外边距，让 (0,0) 就是组件的左上角。
   ⚠ 背景与文字色**必须用主题变量**而不是硬编码颜色：
   · 背景 —— 标签栏自己是透明的（铺在窗口画布上），钉死 #ffffff 会让深色 case 拍出来
     还是浅底，那样的"深色基线"是假的；
   · 文字色 —— tokens 只定义了「--text-color」这个**变量**，没人把它消费成 color；
     真实界面里是 app-shell 的「html, body, #root { color: var(--text-color) }」
     补上这一环。缺了它，标签文字会落回浏览器默认黑，深色下整条标签都看不见 ——
     那不是组件的缺陷，是 harness 少了一层的假象。 */
html, body {
  margin: 0; padding: 0; overflow: hidden;
  background: var(--main-bg-color, #f9fafb);
  color: var(--text-color, #1a1a1a);
}
#root { position: relative; overflow: hidden; }
/* 标签栏在真实界面里铺满它那一行的高度 —— 这里保持一致，别用固定 36px 造出假象。 */
#tabs { width: 100%; height: 100%; }
</style></head><body>
<div id="root"></div>
<script>window.__CASE = ${JSON.stringify(caseDef)}</script>
<script type="module" src="./page.js"></script>
</body></html>`
  fs.writeFileSync(path.join(TMP, `case-${caseDef.id}.html`), html, 'utf8')
}

const MIME: Record<string, string> = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' }
function serveLocal(dir: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '') || 'index.html'
      const file = path.join(dir, rel)
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    // file:// 下 Chromium 会以 CORS 拒绝 ESM import（见 verify-tab-close.cjs 的同款说明）
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function readPng(file: string): PngImage { return PNG.sync.read(fs.readFileSync(file)) }
function writePng(file: string, png: PngImage): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, PNG.sync.write(png))
}

/** 规范化到基线尺寸：不同 DPI 下 capturePage 的物理像素不同，必须先对齐再比。 */
function normalizePngToSize(src: PngImage, width: number, height: number): PngImage {
  const out = new PNG({ width, height })
  const copyW = Math.min(width, src.width)
  const copyH = Math.min(height, src.height)
  for (let y = 0; y < copyH; y += 1) {
    const srcStart = (y * src.width) * 4
    const srcEnd = (y * src.width + copyW) * 4
    out.data.copy(out.data, y * width * 4, srcStart, srcEnd)
  }
  return out
}

/**
 * 只保留最近 N 次运行的产物 —— 每次跑都会落一批 PNG，不清理会无声堆积
 * （`tests/ui/output/` 下本来就已经躺着二十多个历史运行目录）。
 */
function pruneOldRuns(keep = 10): void {
  const root = path.join(ROOT, 'tests', 'ui', 'output', 'tabbar')
  let ids: string[] = []
  try { ids = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)).sort() } catch (_) { return }
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
    try { fs.rmSync(path.join(root, id), { recursive: true, force: true }) } catch (_) {}
  }
}

function baselinePaths(caseDef: TabbarCaseDefinition): { png: string; meta: string } {
  const stem = `state-${caseDef.id}-${caseDef.name}`
  return {
    png: path.join(BASELINE_DIR, `${stem}.png`),
    meta: path.join(BASELINE_DIR, `${stem}.json`)
  }
}

async function capture(win: TabbarWindow, caseDef: TabbarCaseDefinition): Promise<{ png: PngImage; metrics: TabbarMetrics | null }> {
  await win.loadURL(`http://127.0.0.1:${win.__port}/case-${caseDef.id}.html`)
  // 等页面自报就绪（它内部等了两帧布局），再加一点缓冲给字体与 favicon 槽位。
  for (let i = 0; i < 40; i += 1) {
    const ready = await win.webContents.executeJavaScript('!!window.__ready').catch(() => false)
    if (ready) break
    await sleep(50)
  }
  await sleep(120)
  const metrics = await win.webContents.executeJavaScript('window.__metrics || null').catch(() => null)
  const image = await win.capturePage({ x: 0, y: 0, width: caseDef.width, height: caseDef.height })
  // 统一到 case 声明的 CSS 像素尺寸 —— 否则 125%/150% 缩放的机器上基线完全不可比。
  const resized = image.resize({ width: caseDef.width, height: caseDef.height, quality: 'best' })
  return { png: PNG.sync.read(resized.toPNG()), metrics }
}

async function main(): Promise<void> {
  const tokenCss = TOKEN_CSS.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

  console.log(`[tabbar-baseline] 打包 ui/ui-tabbar …`)
  await bundle()

  const cases = CASES.filter((c) => (ONLY ? c.id === String(ONLY) || c.name === String(ONLY) : true))
  if (!cases.length) {
    console.error(`没有匹配的 case：${ONLY}`)
    app.exit(2)
    return
  }
  for (const c of cases) writeCaseHtml(c, tokenCss)

  const server = await serveLocal(TMP)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地快照服务未监听 TCP 端口')
  const port = address.port
  const scaleFactor = screen.getPrimaryDisplay()?.scaleFactor || 1

  const win = new BrowserWindow({
    show: true,
    frame: false,
    skipTaskbar: true,
    width: 1100,
    height: 260,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false }
  }) as TabbarWindow
  win.__port = port
  app.on('window-all-closed', () => {})

  const results: CaseResult[] = []
  for (const caseDef of cases) {
    const { png, metrics } = await capture(win, caseDef)
    const paths = baselinePaths(caseDef)
    const actualPng = path.join(OUTPUT_DIR, 'actual', path.basename(paths.png))
    writePng(actualPng, png)

    if (UPDATE || !fs.existsSync(paths.png)) {
      fs.mkdirSync(BASELINE_DIR, { recursive: true })
      fs.writeFileSync(paths.png, PNG.sync.write(png))
      fs.writeFileSync(paths.meta, JSON.stringify({
        caseId: caseDef.id,
        name: caseDef.name,
        theme: caseDef.theme,
        width: caseDef.width,
        height: caseDef.height,
        scaleFactor,
        metrics
      }, null, 2))
      results.push({ caseDef, status: UPDATE ? 'updated' : 'created', metrics })
      console.log(`  ${UPDATE ? '↻' : '+'} ${caseDef.id} ${caseDef.name}（${UPDATE ? '已更新基线' : '首次生成基线'}）`)
      continue
    }

    const baseline = readPng(paths.png)
    const actual = (baseline.width === png.width && baseline.height === png.height)
      ? png
      : normalizePngToSize(png, baseline.width, baseline.height)
    const diff = new PNG({ width: baseline.width, height: baseline.height })
    const diffPixels = pixelmatch(baseline.data, actual.data, diff.data, baseline.width, baseline.height, { threshold: THRESHOLD })
    const totalPixels = baseline.width * baseline.height
    const matchRate = totalPixels ? 1 - diffPixels / totalPixels : 0
    const pass = matchRate >= PASS_RATE

    let prevMetrics: TabbarMetrics | null = null
    try { prevMetrics = JSON.parse(fs.readFileSync(paths.meta, 'utf8')).metrics || null } catch (_) {}

    if (!pass) writePng(path.join(OUTPUT_DIR, 'diff', path.basename(paths.png)), diff)
    fs.mkdirSync(path.join(OUTPUT_DIR, 'report'), { recursive: true })
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'report', `${caseDef.id}-${caseDef.name}.json`),
      JSON.stringify({ caseId: caseDef.id, name: caseDef.name, diffPixels, totalPixels, matchRate, pass, metrics, prevMetrics }, null, 2)
    )
    results.push({ caseDef, status: pass ? 'pass' : 'fail', matchRate, diffPixels, metrics, prevMetrics })
    console.log(`  ${pass ? '✓' : '✗'} ${caseDef.id} ${caseDef.name}  matchRate=${(matchRate * 100).toFixed(2)}%  差异像素=${diffPixels}`)
  }

  try { server.close() } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) {}
  clearTimeout(hardTimer)
  pruneOldRuns()

  const failed = results.filter((r) => r.status === 'fail')
  const created = results.filter((r) => r.status === 'created')

  console.log('')
  console.log(`基线目录：${path.relative(ROOT, BASELINE_DIR)}`)
  console.log(`本次产物：${path.relative(ROOT, OUTPUT_DIR)}`)

  if (failed.length) {
    console.log('')
    console.log(`✗ ${failed.length}/${results.length} 条与基线不一致 —— 打开 diff 图确认是"画坏了"还是"有意改的"：`)
    for (const failure of failed) {
      const metricNote = failure.prevMetrics && failure.metrics
        ? `（标签数 ${failure.prevMetrics.tabCount}→${failure.metrics.tabCount}，芯片 ${failure.prevMetrics.stackCount}→${failure.metrics.stackCount}，装饰 ${failure.prevMetrics.decorationCount ?? '-'}→${failure.metrics.decorationCount ?? '-'}）`
        : ''
      console.log(`   · ${failure.caseDef.id} ${failure.caseDef.name} ${metricNote}`)
      console.log(`     ${path.relative(ROOT, path.join(OUTPUT_DIR, 'diff', `state-${failure.caseDef.id}-${failure.caseDef.name}.png`))}`)
    }
    console.log('')
    console.log('确认为有意改动 → pnpm test:ui-tabbar -- --update')
  }
  if (created.length) {
    console.log('')
    console.log(`已生成 ${created.length} 条新基线。**请人工看一眼这些图**再提交 ——`)
    console.log('基线一旦错误地生成，之后它会一直"通过"，等于没有基线。')
  }
  if (!failed.length && !created.length) console.log('\n✓ 全部与基线一致。')

  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() =>
  main().catch((error: unknown) => {
    console.error('[tabbar-baseline] 运行失败：', error)
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) {}
    app.exit(2)
  })
)
