/**
 * verify-tab-nav.cjs — 标签导航 URL 归一化回归测试（无头 Electron）
 *
 * 为什么需要它（真实 bug，2026-09-13）：
 *   点游戏库卡片后，地址变成了
 *       https://hira-game//dino/index.html   → ERR_NAME_NOT_RESOLVED (-105)
 *   根因：TabManager#normalizeUrl 用**硬编码协议白名单**判断「这已经是完整 URL，
 *   别补 https://」。它不认识后加的 hira-game://，于是补成 https://hira-game://…
 *   Chromium 把 hira-game 当域名解析 → DNS 失败 → 错误页。
 *
 *   修法：协议集合改为注册中心（infra/infra-window/src/url-schemes.js），
 *   谁定义协议谁注册；infra 不再认识具体业务协议。
 *
 * 为什么旧探针没抓到：
 *   旧探针用主进程 `loadURL('hira-game://…')` 直接加载，绕过了
 *   渲染侧点击 → setWindowOpenHandler → TabManager#newTab#normalizeUrl 这条链路。
 *   本脚本用**真实 TabManager + 真实 tab preload + 真实鼠标输入事件**（trusted）重放。
 *
 * 用法（在项目根执行）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/.bin/electron scripts/verify-tab-nav.cjs
 * 退出码 0 = 全部通过。
 */
import * as os from 'node:os'
import * as path from 'node:path'

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron') as typeof import('electron')

interface GameMeta {
  id: string
  url: string
}

interface GamesCatalog {
  list: () => GameMeta[]
}

interface StepResult {
  name: string
  ok: boolean
  detail: string
}

interface TabInfo {
  tabId: string
  url: string
}

interface TabManagerLike {
  list: () => TabInfo[]
  newTab: (options: { url: string }) => Promise<TabInfo>
  navigate: (options: { tabId: string; url: string }) => Promise<unknown>
}

type TabManagerConstructor = new (options: Record<string, unknown>) => TabManagerLike

app.setPath('userData', path.join(os.tmpdir(), 'ng-verify-tabnav-' + Date.now()))
app.on('window-all-closed', () => {})

const OUT = path.join(__dirname, '..', 'out')
const { registerHiraProtocol } = require(path.join(OUT, 'main', 'hira-protocol.js')) as { registerHiraProtocol: () => void }
const EG = require(path.join(OUT, 'main', 'external-games', 'index.js')) as {
  createExternalGamesFeature: () => { catalog: GamesCatalog }
}
const { TabManager, listRegisteredSchemes, hasKnownScheme } = require('@hira-ng/infra-window') as {
  TabManager: TabManagerConstructor
  listRegisteredSchemes: () => string[]
  hasKnownScheme: (url: string) => boolean
}
const { tabRules } = require('@hira-ng/domain-tabs') as { tabRules: unknown }

// 特权 scheme 只有**一处**登记（registerSchemesAsPrivileged 是覆盖语义，分两次调会互踩）
;(require(path.join(OUT, 'main', 'scheme-privileges.js')) as { registerAppSchemes: () => void }).registerAppSchemes()

const steps: StepResult[] = []
const errors: string[] = []
function check (name: string, ok: unknown, detail?: unknown): void {
  steps.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail).slice(0, 400) })
  if (!ok) errors.push(name)
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitUntil (fn: () => boolean | Promise<boolean>, timeout = 8000, interval = 100): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try { v = await fn() } catch { v = false }
    if (v) return true
    if (Date.now() - t0 > timeout) return false
    await sleep(interval)
  }
}

app.whenReady().then(async () => {
  const logLines: string[] = []
  const origError = console.error
  console.error = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')) }

  try {
    registerHiraProtocol()
    const catalog = EG.createExternalGamesFeature().catalog
    const games = catalog.list()
    if (!games.length) throw new Error('没有发现任何游戏 bundle，无法验证点击链路')

    // ── 1. 注册中心语义（纯函数）───────────────────────────────────────────
    const schemes = listRegisteredSchemes()
    check('scheme 已登记到注册中心', schemes.includes('hira') && schemes.includes('hira-game'), JSON.stringify(schemes))
    check('自定义协议不被补 https://', hasKnownScheme('hira-game://x/index.html') === true, 'hasKnownScheme=false')
    check('裸域名仍补 https://（地址栏输入未被破坏）', hasKnownScheme('example.com') === false, 'hasKnownScheme=true')
    check('host:port 仍补 https://', hasKnownScheme('localhost:3000') === false, 'hasKnownScheme=true')
    check('about/file/chrome 等内建协议不受影响',
      hasKnownScheme('about:blank') && hasKnownScheme('file:///C:/x') && hasKnownScheme('chrome://settings'), 'builtin=false')

    // ── 2. 真实窗口 + 真实 TabManager ─────────────────────────────────────
    let gameListCalls = 0
    ipcMain.handle('ngipc:invoke:game:list', () => { gameListCalls++; return { games: catalog.list() } })

    const win = new BrowserWindow({ show: false, width: 1000, height: 700 })
    const views = new Map<string, InstanceType<typeof WebContentsView>>()
    let activeId: string | null = null
    const wcm = {
      createTab (id: string) {
        if (views.has(id)) return views.get(id)
        const v = new WebContentsView({
          webPreferences: {
            preload: path.join(OUT, 'preload', 'tab.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false
          }
        })
        win.contentView.addChildView(v)
        v.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
        views.set(id, v)
        return v
      },
      isTabSleeping () { return false },
      destroyTab (id: string) { views.delete(String(id)); return true }
    }
    const layout = {
      getActiveTabId: () => activeId,
      showTab (id: string) { activeId = id; for (const [k, v] of views) { try { v.setVisible(k === id) } catch {} } },
      hideTab () {}, applyInitialLayout () {}
    }
    const tm = new TabManager({ webContentsManager: wcm, layoutCoordinator: layout, emit: () => {}, hooks: {}, tabRules })

    // ── 3. 打开游戏库并点击卡片 ───────────────────────────────────────────
    const { tabId: libId } = await tm.newTab({ url: 'hira://games' })
    const libView = views.get(libId)
    if (!libView) throw new Error('游戏库标签视图未创建')
    const libWc = libView.webContents
    await waitUntil(() => !libWc.isLoading())
    const rendered = await waitUntil(async () => (await libWc.executeJavaScript('document.querySelectorAll(".game-main").length')) > 0)
    check('游戏库渲染出卡片', rendered, rendered ? '' : 'cards=0')
    check('game:list 只调用一次', gameListCalls === 1, 'calls=' + gameListCalls)
    check('内部页仍有 window.hira（桥未被误伤）', (await libWc.executeJavaScript('typeof window.hira')) === 'object', 'typeof=' + await libWc.executeJavaScript('typeof window.hira'))

    const info = await libWc.executeJavaScript(`(() => {
      const a = document.querySelector('.game-main')
      if (!a) return null
      const r = a.getBoundingClientRect()
      return { raw: a.getAttribute('href'), resolved: a.href, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`) as { raw: string | null; resolved: string; x: number; y: number } | null
    check('卡片 href 是自定义协议', info && info.raw === games[0].url, info && info.raw)
    check('Blink 解析后协议未被改写', info && info.resolved.startsWith('hira-game://'), info && info.resolved)
    if (!info) throw new Error('游戏库卡片不可见')

    libWc.focus()
    libWc.sendInputEvent({ type: 'mouseDown', x: info.x, y: info.y, button: 'left', clickCount: 1 })
    libWc.sendInputEvent({ type: 'mouseUp', x: info.x, y: info.y, button: 'left', clickCount: 1 })

    const opened = await waitUntil(() => tm.list().length === 2, 6000)
    check('点击后新开一个标签', opened, 'tabs=' + tm.list().length)
    const gameTab = tm.list().find((t) => t.tabId !== libId)
    check('新标签 URL 未被补成 https://（本次 bug 的核心断言）', gameTab && gameTab.url === games[0].url, gameTab && gameTab.url)

    if (gameTab) {
      const gameView = views.get(gameTab.tabId)
      if (!gameView) throw new Error('游戏标签视图未创建')
      const gameWc = gameView.webContents
      await waitUntil(() => !gameWc.isLoading())
      const finalUrl = gameWc.getURL()
      check('游戏页加载成功（未落错误页）', finalUrl.startsWith('hira-game://') && !finalUrl.startsWith('hira://error'), finalUrl)
      const state = await gameWc.executeJavaScript('({ hira: typeof window.hira, canvas: document.querySelectorAll("canvas").length })')
      check('第三方 bundle 拿不到 window.hira', state.hira === 'undefined', 'typeof=' + state.hira)
      check('游戏真的跑起来了（有 canvas）', state.canvas > 0, 'canvas=' + state.canvas)
    }

    // ── 4. 地址栏输入回归 ─────────────────────────────────────────────────
    const bare = await tm.newTab({ url: 'example.com' })
    check('裸域名输入仍补成 https://', bare.url === 'https://example.com', bare.url)

    // ── 5. 导航失败：只切一次错误页、无假报错噪音、重试不被去重挡住 ────────
    const BAD = 'https://no-such-host-hira-verify.invalid/'
    const { tabId: failId } = await tm.newTab({ url: BAD })
    const failView = views.get(failId)
    if (!failView) throw new Error('失败导航标签视图未创建')
    const failWc = failView.webContents
    let errorNavCount = 0
    failWc.on('did-start-navigation', (_e, navUrl, inPlace, mf) => {
      if (mf && !inPlace && String(navUrl).startsWith('hira://error')) errorNavCount++
    })
    await waitUntil(() => failWc.getURL().startsWith('hira://error'))
    await sleep(700)
    check('失败后停在错误页', failWc.getURL().startsWith('hira://error'), failWc.getURL())
    check('一次失败只切一次错误页（provisional+did-fail 重复上报已去重）', errorNavCount === 1, 'errorNavCount=' + errorNavCount)

    await tm.navigate({ tabId: failId, url: BAD })
    await waitUntil(() => failWc.getURL().startsWith('hira://error'))
    await sleep(700)
    check('重试后仍回到错误页（去重不影响重试）', failWc.getURL().startsWith('hira://error'), failWc.getURL())
    check('重试同样只切一次', errorNavCount === 2, 'errorNavCount=' + errorNavCount)

    const noise = logLines.filter((l) => l.includes('load error page failed')).length
    check('无 "load error page failed" 假报错', noise === 0, 'count=' + noise)
    const errState = await failWc.executeJavaScript('({ title: document.title, n: document.querySelectorAll("button, a").length })')
    check('错误页内容渲染正常', errState.title.length > 0 && errState.n > 0, JSON.stringify(errState))

    console.error = origError
  } catch (error: unknown) {
    console.error = origError
    errors.push('EXCEPTION: ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
  }

  console.log('###REPORT###')
  console.log(JSON.stringify({ steps, errors }, null, 2))
  console.log('###END###')
  console.log(`[verify-tab-nav] ${steps.filter((s) => s.ok).length}/${steps.length} passed, ${errors.length} failed`)
  for (const s of steps) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.ok ? '' : '  >>> ' + s.detail}`)
  app.exit(errors.length ? 1 : 0)
})
