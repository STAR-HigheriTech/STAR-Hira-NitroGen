/**
 * hira-game:// 外部 bundle（游戏）验证探针
 *
 * 用法（把本文件放到 1A-STAR_Hira_NG/scripts/ 下）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/.bin/electron scripts/verify-games.cjs 2>&1 | sed -n '/###REPORT###/,$p'
 *
 * 测的是**构建产物**（out/main/hira-protocol.js、out/main/external-games/*、out/preload/tab.js），
 * 覆盖四件事：
 *   1. 自描述 bundle 目录扫描（external/games/<id>/game.json → game:list DTO）
 *   2. hira-game:// 静态出文件：MIME 正确、未登记 host 404、目录遍历 404
 *   3. 三个游戏在**真实 tab preload + sandbox** 下能跑起来，且拿不到 window.hira
 *   4. 游戏库页 hira://games 渲染卡片，且它**有** window.hira（白名单没误伤）
 *
 * 坑：探针会反复 destroy 窗口，必须自己吃掉 window-all-closed，
 *     否则 Electron 在第一个窗口销毁后就直接退出，后续步骤全丢。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { errorMessage } from './lib/type-guards.ts'

const { app, BrowserWindow, ipcMain, session } = require('electron') as typeof import('electron')

interface GameMeta {
  id: string
  category: string
  variants: unknown[]
  url: string
}

interface GamesFeature {
  catalog: {
    root: string
    list: () => GameMeta[]
  }
}

interface ProbeStep {
  name: string
  ok: boolean
  detail: string
}

interface ProbeReport {
  steps: ProbeStep[]
  errors: string[]
}

interface LoadResult {
  value: Record<string, unknown>
  logs: string[]
  loadError: unknown
}

interface FetchResult {
  status: number
  type: string
  bytes: number
  error?: string
}

const NG = path.join(__dirname, '..')
const OUT = path.join(NG, 'out')
const HIRA_PROTOCOL = path.join(OUT, 'main', 'hira-protocol.js')
const GAMES_MODULE = path.join(OUT, 'main', 'external-games', 'index.js')
const TAB_PRELOAD = path.join(OUT, 'preload', 'tab.js')

for (const f of [HIRA_PROTOCOL, GAMES_MODULE, TAB_PRELOAD]) {
  if (!fs.existsSync(f)) {
    console.log('###FATAL### 缺少构建产物 ' + f + '，先跑 pnpm build')
    process.exit(1)
  }
}

const tmp = path.join(os.tmpdir(), 'hira-ng-verify-games-' + process.pid)
fs.mkdirSync(tmp, { recursive: true })
app.setPath('userData', tmp)
app.on('window-all-closed', () => { /* 不要退出，等报告打完 */ })

const { registerHiraProtocol } = require(HIRA_PROTOCOL) as { registerHiraProtocol: () => void }
const { createExternalGamesFeature } = require(GAMES_MODULE) as { createExternalGamesFeature: () => GamesFeature }
// 特权 scheme 只有**一处**登记（registerSchemesAsPrivileged 是覆盖语义，分两次调会互踩）
const { registerAppSchemes } = require(path.join(OUT, 'main', 'scheme-privileges.js')) as { registerAppSchemes: () => void }

registerAppSchemes()

const report: ProbeReport = { steps: [], errors: [] }
const step = (name: string, ok: unknown, detail: unknown): void => {
  const passed = Boolean(ok)
  report.steps.push({ name, ok: passed, detail: String(detail) })
  if (!passed) report.errors.push(name + ' :: ' + String(detail))
}

// Electron 自身的安全提示 / Chromium deprecation 噪音，不算页面错误
const NOISE = ['Electron Security Warning', 'non-JS module files deprecated', 'Insecure Content-Security-Policy']
const isNoise = (m: string): boolean => NOISE.some((n) => m.includes(n))

async function loadAndEval (
  url: string,
  expr: string,
  { preload = null }: { preload?: string | null } = {}
): Promise<LoadResult> {
  const logs: string[] = []
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    // 与 WebContentsManager.createTab 的 tab webPreferences 保持一致
    webPreferences: {
      preload: preload || undefined,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  const wc = win.webContents
  wc.on('console-message', (_e, level, message) => {
    const m = String(message)
    if (level >= 3 && !isNoise(m)) logs.push('[err] ' + m.slice(0, 220))
  })
  let value: Record<string, unknown> = {}
  let loadError: unknown = null
  try {
    await wc.loadURL(url)
  } catch (error) {
    loadError = errorMessage(error)
  }
  try {
    await new Promise((r) => setTimeout(r, 900))
    value = await wc.executeJavaScript(`(() => { ${expr} })()`, true)
  } catch (error) {
    value = { __evalError: errorMessage(error) }
  }
  try { win.destroy() } catch { /* ignore */ }
  return { value, logs, loadError }
}

async function fetchCheck (url: string): Promise<FetchResult> {
  try {
    const res = await session.defaultSession.fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, type: res.headers.get('content-type') || '', bytes: buf.length }
  } catch (error) {
    return { status: 0, type: '', bytes: 0, error: errorMessage(error) }
  }
}

app.whenReady().then(async () => {
  try {
    registerHiraProtocol()
    const feature = createExternalGamesFeature()
    const catalog = feature.catalog

    let listCalls = 0
    ipcMain.handle('ngipc:invoke:game:list', async () => {
      listCalls++
      return { scheme: 'hira-game', games: catalog.list() }
    })

    // 1) 目录扫描
    const games = catalog.list()
    step('catalog.list', games.length > 0,
      `root=${catalog.root} · ${games.length} games · ${games.map((g) => g.id + '/' + g.category).join(', ')}`)
    const dinoMeta = games.find((g) => g.id === 'dino')
    step('catalog.dto', !!dinoMeta && dinoMeta.variants.length === 5 && dinoMeta.url === 'hira-game://dino/index.html',
      `dino.url=${dinoMeta && dinoMeta.url} variants=${dinoMeta && dinoMeta.variants.length}`)

    // 2) 协议出文件（含 MIME / 未登记 host / 目录遍历）
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ['hira-game://dino/index.html', 200, 'text/html'],
      ['hira-game://dino/scripts/offline.js', 200, 'application/javascript'],
      ['hira-game://dino/images/default_100_percent/offline/100-offline-sprite.png', 200, 'image/png'],
      ['hira-game://dino/1_hurdling.html', 200, 'text/html'],
      ['hira-game://surf-v1/index.html', 200, 'text/html'],
      ['hira-game://surf-v1/resources/js/surf.bundle.js', 200, 'application/javascript'],
      ['hira-game://surf-v1/resources/surf/player.png', 200, 'image/png'],
      ['hira-game://surf-v2/index.html', 200, 'text/html'],
      ['hira-game://surf-v2/surf-iframe.html', 200, 'text/html'],
      ['hira-game://surf-v2/js/surf-untrusted.js', 200, 'application/javascript'],
      ['hira-game://nope/index.html', 404, 'text/html'],
      ['hira-game://dino/../../../../package.json', 404, 'text/html']
    ]
    for (const [url, wantStatus, wantType] of cases) {
      const r = await fetchCheck(url)
      step('fetch ' + url, r.status === wantStatus && (r.type || '').startsWith(wantType),
        `status=${r.status} type=${r.type} bytes=${r.bytes}${r.error ? ' err=' + r.error : ''}`)
    }

    // 3) 游戏真的能跑，且拿不到应用桥
    const dino = await loadAndEval('hira-game://dino/index.html',
      `return { hira: typeof window.hira, jsDialog: typeof window.__jsDialogBridge,
                origin: location.origin, canvas: !!document.querySelector('canvas'),
                runner: typeof window.Runner, title: document.title }`,
      { preload: TAB_PRELOAD })
    step('game dino boots',
      !dino.loadError && dino.value.canvas && dino.value.runner === 'function' &&
      dino.value.hira === 'undefined' && dino.logs.length === 0,
      JSON.stringify(dino.value) + ' loadError=' + dino.loadError + ' logs=' + JSON.stringify(dino.logs))

    const v1 = await loadAndEval('hira-game://surf-v1/index.html',
      `return { hira: typeof window.hira, chromeObj: typeof window.chrome,
                hamburgerChildren: (document.getElementById('hamburger-container') || {children:[]}).children.length,
                modalRoot: !!document.getElementById('modal-root') }`,
      { preload: TAB_PRELOAD })
    step('game surf-v1 boots',
      !v1.loadError && v1.value.hira === 'undefined' && v1.value.chromeObj === 'object' && v1.value.modalRoot,
      JSON.stringify(v1.value) + ' loadError=' + v1.loadError + ' logs=' + JSON.stringify(v1.logs))
    step('surf-v1 console noise is upstream-only',
      v1.logs.every((l) => l.includes("Failed to construct 'URL'")),
      'logs=' + JSON.stringify(v1.logs))

    const v2 = await loadAndEval('hira-game://surf-v2/index.html',
      `const f = document.getElementById('untrusted-iframe');
       let inner = null, innerHira = null, innerCanvas = false;
       try {
         inner = f && f.contentDocument ? f.contentDocument.readyState : 'no-doc';
         innerHira = (f && f.contentWindow) ? typeof f.contentWindow.hira : 'no-win';
         innerCanvas = !!(f && f.contentDocument && f.contentDocument.querySelector('canvas'));
       } catch (e) { inner = 'err:' + e.message }
       return { hira: typeof window.hira, hasIframe: !!f, inner, innerHira, innerCanvas }`,
      { preload: TAB_PRELOAD })
    step('game surf-v2 boots',
      !v2.loadError && v2.value.hira === 'undefined' && v2.value.hasIframe && v2.value.innerHira === 'undefined',
      JSON.stringify(v2.value) + ' loadError=' + v2.loadError + ' logs=' + JSON.stringify(v2.logs))

    // 4) 游戏库页（hira:// 侧，必须有 window.hira）
    const lib = await loadAndEval('hira://games/index.html',
      `return { hira: typeof window.hira,
                cards: document.querySelectorAll('.game-card').length,
                sections: [...document.querySelectorAll('.section-title')].map(n => n.textContent),
                names: [...document.querySelectorAll('.game-name')].map(n => n.textContent),
                variants: document.querySelectorAll('.chip').length,
                primaryHref: (document.querySelector('.btn.primary') || {}).href || '',
                primaryBg: getComputedStyle(document.querySelector('.btn.primary')).backgroundColor,
                cardRadius: getComputedStyle(document.querySelector('.game-card')).borderRadius,
                bodyBg: getComputedStyle(document.body).backgroundColor }`,
      { preload: TAB_PRELOAD })
    step('games library renders',
      !lib.loadError && lib.value.cards === games.length && lib.value.hira === 'object',
      JSON.stringify(lib.value) + ' loadError=' + lib.loadError + ' logs=' + JSON.stringify(lib.logs))
    step('game:list called exactly once', listCalls === 1, 'calls=' + listCalls)

    // 5) 回归
    const nf = await fetchCheck('hira://definitely-not-a-page/index.html')
    step('hira unknown host still falls back', nf.status === 200 && nf.type.startsWith('text/html'),
      `status=${nf.status} type=${nf.type}`)

    const web = await loadAndEval('data:text/html,<h1>hi</h1>', 'return { hira: typeof window.hira }', { preload: TAB_PRELOAD })
    step('data: page keeps app bridge (whitelist not over-broad)', web.value.hira === 'object', JSON.stringify(web.value))
  } catch (error) {
    step('probe crash', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }

  console.log('###REPORT###')
  console.log(JSON.stringify(report, null, 2))
  console.log('###END###')
  app.exit(report.errors.length ? 1 : 0)
})
