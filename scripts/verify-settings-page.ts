#!/usr/bin/env node
/**
 * 设置页冒烟 —— `pnpm verify:settings-page`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它（以及它为什么必须跑**构建产物**）
 * ══════════════════════════════════════════════════════════════════════
 * 设置页是 `hira://settings` 下的**静态内部页**（`pages/settings/` → `out/pages/settings/`，
 * 与 history / bookmarks 同构），由协议层的**磁盘发现**自动注册。
 * 为承载 `settings.custom-widget`，只有入口模块从源码打成 ESM；HTML/CSS 与协议路由不变。
 *
 * 静态页也有"只在真 Chromium 里才看得见"的坏法：
 *   · HTML 里某个 src/href 拼错 → 那个资源静默 404（缺样式或缺脚本）；
 *   · CSS 链错（`<link>` 路径不对、或它没被拷进 out/）→ "有 DOM 无样式"；
 *   · 脚本报错 → 页面只剩空壳，而 HTTP 全是 200。
 * 这三条在 node 里一条都测不出来，所以本脚本刻意加载 `out/` 里的**构建产物**，
 * 而不是 `src/` 源码 —— 要验的就是"构建出来的东西能跑"。
 *
 * 覆盖：
 *   ① `hira://settings` 返回 200 HTML
 *   ② HTML 里**每一个** src/href 都能取到（这条直接证明磁盘分发对了）
 *   ③ 页面真的渲染出内容（导航项 / 标题 / 卡片 / 控件）
 *   ④ settings.css 生效（不是"有 DOM 无样式"）
 *   ⑤ 没有 console 错误
 *   ⑥/⑦ `settings.custom-widget` 端到端 —— 待补运行时插件夹具后恢复（见 §15.11）
 *
 * 用法：pnpm verify:settings-page（需要先 `pnpm build`；脚本会自检）
 */

// electron 在纯 node 下只是一个路径字符串 —— 用子进程换到 electron 跑。
if (!process.versions.electron) {
  const { spawnSync } = require('child_process')
  const path = require('path')
  // ELECTRON_RUN_AS_NODE 必须**删掉**（设成空串仍会被读成 node 模式 → V8 快照断言崩溃）
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const runner = path.join(__dirname, 'electron-tool.ts')
  const r = spawnSync(process.execPath, [runner, __filename], { stdio: 'inherit', env })
  process.exit(r.status == null ? 1 : r.status)
}

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { errorMessage } from './lib/type-guards.ts'

const { app, BrowserWindow, net } = require('electron') as typeof import('electron')

interface TestResult {
  name: string
  ok: boolean
}

interface ResourceProbe {
  url: string
  code: number | string
}

const ROOT = path.resolve(__dirname, '..')

/**
 * ⚠ 刻意 require **out/** 里的产物（不是 src/ 源码）。
 *
 * 要验的就是"构建产物能跑" —— 设置页是原样拷到 out/pages/settings/ 的静态页，
 * 只有从 out/ 起的那一份才带真实的磁盘布局（从源码位置 require 会绕过这个风险点）。
 */
const OUT_MAIN = path.join(ROOT, 'out', 'main')
const HIRA_PROTOCOL = path.join(OUT_MAIN, 'hira-protocol.js')

if (!fs.existsSync(HIRA_PROTOCOL)) {
  console.error('[verify:settings-page] 找不到构建产物，请先跑 `pnpm build`')
  console.error(`  期望：${HIRA_PROTOCOL}`)
  process.exit(2)
}

const { registerHiraProtocol } = require(HIRA_PROTOCOL) as { registerHiraProtocol: () => void }
// 特权 scheme 只有**一处**登记（registerSchemesAsPrivileged 是覆盖语义，分两次调会互踩）
const { registerAppSchemes } = require(path.join(OUT_MAIN, 'scheme-privileges.js')) as { registerAppSchemes: () => void }

const results: TestResult[] = []
function check (name: string, ok: unknown, extra?: unknown): void {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 特权 scheme 必须在 app.ready **之前**注册
registerAppSchemes()

/** 冒烟用的假分区 —— 刻意用**虚构的 key**：脚本不该依赖"真实设置里恰好有哪几项"。 */
const DEMO_SECTION = {
  id: 'demo',
  label: '验证分区',
  blurb: '冒烟脚本的临时分区',
  fields: [{ key: 'verify.demo', type: 'toggle', label: '一个开关', desc: '冒烟用' }]
}

/** 生成给冒烟窗口用的 preload：一个最小但形状正确的 `window.hira` 假桥。 */
function writeFakeBridge (file: string): void {
  const fake = {
    'settings:schema': [DEMO_SECTION],
    'settings:list': { 'verify.demo': true },
    'settings:changed-keys': [],
    'settings:css-vars': {},
    // 基础冒烟不装插件；宿主仍会拉一次清单，空数组是合法的“没有自定义控件”状态。
    'plugins:list': { plugins: [] }
  }
  fs.writeFileSync(file, `
const { contextBridge } = require('electron')
const FAKE = ${JSON.stringify(fake, null, 2)}
contextBridge.exposeInMainWorld('hira', {
  provider: { invoke: (route) => Promise.resolve(Object.prototype.hasOwnProperty.call(FAKE, route) ? FAKE[route] : null) },
  on: { subscribe: () => () => {} }
})
`, 'utf8')
}

/**
 * 从 HTML 里抠出所有 `src=` / `href=`，逐个取它的状态码。
 * 这是本脚本**最有价值的那条断言**：它不关心路径长什么样，只要求"页面引用的东西都能取到" ——
 * 于是协议层的分发规则写错时，它一定失败。
 *
 * 为什么用**主进程的 `net.fetch`**：探针不该依赖"某个渲染进程恰好还活着 / 它的 origin
 * 恰好被 CORS 放行"，主进程这一侧拿到的是协议处理的**最终结果**，最接近事实。
 *
 * ⚠ 别被历史结论误导：渲染进程里 `fetch('hira://…')` 报
 * `URL scheme "hira" is not supported` **不是**"Fetch API 不支持自定义 scheme"，
 * 而是 `protocol.registerSchemesAsPrivileged()` 的**覆盖语义**导致该 scheme 没被登记
 * （五个模块各调一次 → 只有最后一个生效）。现已在
 * `apps/app-main/src/main/scheme-privileges.js` 收成唯一一次调用。
 */
async function probeHtmlResources (html: string): Promise<ResourceProbe[]> {
  const refs: string[] = []
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g
  let m
  while ((m = re.exec(html)) !== null) {
    const raw = m[1]
    if (!raw || raw.startsWith('data:') || raw.startsWith('http')) continue
    // 相对路径按文档位置解析（与浏览器一致），`..` 由 URL 规范化吃掉
    refs.push(new URL(raw, 'hira://settings/index.html').href)
  }
  const out: ResourceProbe[] = []
  for (const url of refs) {
    try {
      const r = await net.fetch(url)
      out.push({ url, code: r.status })
    } catch (error) {
      out.push({ url, code: 'ERR:' + errorMessage(error) })
    }
  }
  return out
}

async function main () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hira-settings-smoke-'))

  registerHiraProtocol()

  const bridgeFile = path.join(tmp, 'bridge.cjs')
  writeFakeBridge(bridgeFile)

  const consoleErrors: string[] = []
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { preload: bridgeFile, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  app.on('window-all-closed', () => {})
  win.webContents.on('console-message', (details, level, message) => {
    const effectiveLevel = details.level ?? level
    const text = details.message ?? message
    if (effectiveLevel === 'error' || String(effectiveLevel) === '3') consoleErrors.push(String(text))
  })

  await win.webContents.loadURL('hira://settings')
  await sleep(900) // 等 schema 拉取 + 渲染（都是 async，且没有可 await 的信号）

  // ── ① 文档本身 ────────────────────────────────────────────────────
  // 状态码从 `net.fetch` 取（`loadURL` 的返回形状在 Electron 版本间变过，
  // 拿它判状态码会把"页面好好的"误报成失败）
  const docResp = await net.fetch('hira://settings')
  check('① hira://settings 返回 200（协议层认得这个 host）', docResp.status === 200, docResp.status)
  const html = await docResp.text()
  check('① 返回的是设置页文档（标题与侧栏都在）',
    /<title>设置<\/title>/.test(html) && html.includes('id="nav"'))
  // 真窗口里那一份也必须是对的（协议层返回 200 不代表窗口加载的就是它）
  const liveTitle = await win.webContents.executeJavaScript('document.title')
  check('① 真窗口里加载的就是设置页（而非错误页 / 空白页）', liveTitle === '设置', liveTitle)

  // ── ② 引用的资源全部可取 ──────────────────────────────────────────
  const resources = await probeHtmlResources(html)
  const bad = resources.filter((r) => r.code !== 200)
  check(`② HTML 引用的 ${resources.length} 个资源全部可取（磁盘分发正确）`,
    resources.length > 0 && bad.length === 0, bad.length ? bad : resources.map((r) => r.code))
  // 设置页是静态页，两件套是同目录平级的 `./settings.js` 与 `./settings.css`
  //（与 history / bookmarks 同构；不是 Vite 的 `/assets/` 产物）
  check('② 其中确实包含平级的 settings.js 与 settings.css',
    resources.some((r) => r.url === 'hira://settings/settings.js') &&
    resources.some((r) => r.url === 'hira://settings/settings.css'))

  // ── ③ 页面渲染 ────────────────────────────────────────────────────
  const dom = await win.webContents.executeJavaScript(`(() => {
    const nav = document.getElementById('nav')
    const title = document.getElementById('page-title')
    return {
      navItems: nav ? nav.children.length : -1,
      title: title ? title.textContent : null,
      cards: document.querySelectorAll('#content .card').length,
      hasToggle: !!document.querySelector('#content .toggle'),
      toggleOn: (function () {
        const t = document.querySelector('#content .toggle')
        return t ? t.getAttribute('aria-checked') : null
      })()
    }
  })()`)
  check('③ 侧栏渲染出分区项', dom.navItems === 1, dom)
  check('③ 标题取自当前分区', dom.title === '验证分区', dom.title)
  check('③ 内容区渲染出卡片与控件', dom.cards >= 1 && dom.hasToggle, dom)
  check('③ 控件反映了值（toggle = true）', dom.toggleOn === 'true', dom.toggleOn)

  // ── ④ CSS 生效 ───────────────────────────────────────────────────
  const style = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#content .card')
    const cs = getComputedStyle(card)
    return { bg: cs.backgroundColor, padding: cs.padding, radius: cs.borderTopLeftRadius }
  })()`)
  const bgApplied = style.bg && style.bg !== 'rgba(0, 0, 0, 0)' && style.bg !== 'transparent'
  check('④ settings.css 生效（卡片有背景色与圆角，不是"有 DOM 无样式"）',
    !!bgApplied && style.radius !== '0px', style)

  // ── ⑤ 无 console 错误 ─────────────────────────────────────────────
  check('⑤ 加载与渲染期间没有 console 错误', consoleErrors.length === 0, consoleErrors)

  // ⑥/⑦ 的宿主已经接通，但本脚本还没有构造临时渲染插件夹具。
  // 恢复时应覆盖卡片挂载、空结果不画卡、切分区派发 `hira:dispose`、禁用后无残影。

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}

  const failed = results.filter((r) => !r.ok)
  console.log('\n========================================')
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join(' | '))
  console.log('========================================')
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('[verify:settings-page] 异常：', (e && e.stack) || e)
    app.exit(2)
  })
)
