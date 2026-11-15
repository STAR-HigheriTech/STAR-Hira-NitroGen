/**
 * 运行时插件（社区市场那一半）的端到端验证：**发现 → 授权 → 启用 → 渲染侧动态 import**。
 *
 * 用法：pnpm verify:plugin-runtime   （内部会用 electron 重跑自己）
 *
 * 为什么必须是 Electron 而不是纯 node：
 *   · 最后一条断言是"渲染层真的 `import('hira-plugin://…')` 成功了" ——
 *     那要真 Chromium 的模块加载器 + 我们注册的特权协议，node 里测不了；
 *   · 权限闸门 / 协议 403 / 404 这些也都要在真实 session 上才作数。
 *
 * 验证的六件事（从"发现"到"页面里真的能跑"的整条链）：
 *   ① 用户目录里的**目录形态**插件能被发现，且标着 `runtime: true`
 *   ② 第三方插件**未授权时停在 `awaitingConsent`**，一行代码都不跑
 *   ③ 授权后能启用，且 `getPluginRoot` 对它开放
 *   ④ 协议能把它的渲染文件取出来
 *   ⑤ **渲染进程里 `import()` 这个 URL 成功**（这是整条链的终点）
 *   ⑥ 三道安全边界：目录穿越 / 非白名单扩展名 / **禁用后立刻失效**
 */

// electron 在纯 node 下只是一个路径字符串 —— 用子进程换到 electron 跑。
if (!process.versions.electron) {
  const { spawnSync } = require('child_process')
  const path = require('path')
  /**
   * ⚠ `ELECTRON_RUN_AS_NODE` 必须**删掉**，不能设成空串。
   *
   * Electron 判定的是"这个键**在不在**"（不是它的值真假），所以 `''` 仍然会被读成
   * "以 node 模式启动" → 于是它带着自己的 node 快照去初始化 V8，直接断言崩溃：
   * `Assertion failed: (isolate_data->snapshot_data()) != nullptr`，
   * 退出码 134、堆栈全在 V8 里，完全指不到真正原因。
   * 同样地，**从 pnpm 的 shell 里继承来的残留值**也会造成这个现象，所以一律清掉。
   */
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const runner = path.join(__dirname, 'electron-tool.ts')
  const r = spawnSync(process.execPath, [runner, __filename], { stdio: 'inherit', env })
  process.exit(r.status == null ? 1 : r.status)
}

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { errorMessage } from './lib/type-guards.ts'

const { app, BrowserWindow } = require('electron') as typeof import('electron')

interface TestResult {
  name: string
  ok: boolean
}

const ROOT = path.resolve(__dirname, '..')
const { PluginRegistryV2 } = require('@hira-ng/infra-plugin') as typeof import('@hira-ng/infra-plugin')
const {
  registerPluginProtocol,
  buildPluginAssetUrl
} = require(path.join(ROOT, 'apps/app-main/src/main/plugin-protocol.ts')) as typeof import('../apps/app-main/src/main/plugin-protocol.ts')
// 特权 scheme 只有**一处**登记（registerSchemesAsPrivileged 是覆盖语义，分两次调会互踩）
const { registerAppSchemes } = require(path.join(ROOT, 'apps/app-main/src/main/scheme-privileges.ts')) as typeof import('../apps/app-main/src/main/scheme-privileges.ts')

const PLUGIN_ID = 'acme-demo'

const results: TestResult[] = []
function check(name: string, ok: unknown, extra?: unknown): void {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 特权 scheme 必须在 app.ready **之前**注册
registerAppSchemes()

/** 造一个"用户运行时安装"的插件：目录形态 + 第三方信任级 + 声明了权限。 */
function createRuntimePlugin(userDir: string): void {
  const dir = path.join(userDir, PLUGIN_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'hira-plugin.json'), JSON.stringify({
    id: PLUGIN_ID,
    name: 'Acme 演示插件',
    version: '1.2.3',
    type: 'feature-plugin',
    trustLevel: 'community',
    description: '运行时安装的第三方插件（验证用）',
    main: './main.cjs',
    render: './ui.renderer.js',
    capabilities: ['acme.ping'],
    requestedPermissions: ['bookmarks:read']
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'main.cjs'), `
module.exports = {
  async install () {},
  async enable () {},
  async disable () {},
  registerProviders () {
    return [{ id: 'acme-demo:acme.ping', capability: 'acme.ping', around: () => 'pong' }]
  }
}
`)
  fs.writeFileSync(path.join(dir, 'ui.renderer.js'), `
export const rendererPlugin = { slots: {} }
export const MARKER = 'acme-demo-renderer-ok'
`)
  // 白名单之外的文件：协议层必须拒绝它（插件目录里可能躺着作者的笔记 / 密钥）
  fs.writeFileSync(path.join(dir, 'notes.secret'), 'SHOULD-NEVER-BE-READABLE')
}

const MIME: Record<string, string> = { '.html': 'text/html' }
function serveLocal(dir: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html'
      const file = path.join(dir, rel)
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hira-rt-plugin-'))
  const userDir = path.join(tmp, 'plugins')
  const emptyBuiltinDir = path.join(tmp, 'builtin') // 空的内置目录：本次只验运行时那一半
  fs.mkdirSync(emptyBuiltinDir, { recursive: true })
  createRuntimePlugin(userDir)

  const registry = new PluginRegistryV2({
    pluginDir: emptyBuiltinDir,
    pluginUserDir: userDir
  })
  registry.discover()
  await registry.installAll({})

  // ── ① 发现 ────────────────────────────────────────────────────────
  const found = registry.getManifests().find((m) => m.id === PLUGIN_ID)
  check('① 用户目录里的目录形态插件被发现', !!found, found && { id: found.id, render: found.render })
  const snap0 = registry.describe().find((p) => p.id === PLUGIN_ID)
  check('① 标着 runtime: true（来自用户目录，而非随应用分发）', snap0 && snap0.runtime === true)
  check('① 渲染入口版本号已算出（用于 URL 的 ?v=，保证改了代码会重新加载）',
    snap0 && typeof snap0.renderVersion === 'number' && snap0.renderVersion > 0)
  if (!found || !snap0) throw new Error('运行时插件未被发现')

  // ── ② 授权闸门 ───────────────────────────────────────────────────
  await registry.enableAll({})
  const st1 = registry.getState(PLUGIN_ID)
  check('② 未授权 → 停在 awaitingConsent（而不是被启用）', st1?.awaitingConsent === true && st1?.enabled !== true)
  check('② 未授权时能力不可用（它一行代码都没跑）', registry.getProviderRegistry().list().filter((p) => p.pluginId === PLUGIN_ID).length === 0)
  check('② 未授权时协议层不给路径（没启用 → 拿不到插件目录）', registry.getPluginRoot(PLUGIN_ID) === null)

  // ── ③ 授权 → 启用 ────────────────────────────────────────────────
  registry.setGrantedPermissions(PLUGIN_ID, ['bookmarks:read'])
  await registry.enableWithPrerequisites(PLUGIN_ID, {})
  const st2 = registry.getState(PLUGIN_ID)
  check('③ 授权后启用成功', st2?.enabled === true)
  check('③ 能力已注册', registry.getProviderRegistry().list().some((p) => p.pluginId === PLUGIN_ID))
  const root = registry.getPluginRoot(PLUGIN_ID)
  check('③ getPluginRoot 对已启用插件开放，且指向它自己的目录', root === path.resolve(userDir, PLUGIN_ID), root)

  // ── 协议注册到默认 session ────────────────────────────────────────
  registerPluginProtocol(undefined, {
    getPluginRoot: (id) => registry.getPluginRoot(id)
  })

  // 起一个本地页（真实 origin，才能验跨源 import 与 CORS）
  const pageDir = path.join(tmp, 'page')
  fs.mkdirSync(pageDir, { recursive: true })
  fs.writeFileSync(path.join(pageDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body>probe</body></html>')
  const server = await serveLocal(pageDir)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地探针服务未监听 TCP 端口')
  const port = address.port

  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 200,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false }
  })
  app.on('window-all-closed', () => {})
  await win.loadURL(`http://127.0.0.1:${port}/index.html`)
  await sleep(150)

  const renderUrl = buildPluginAssetUrl(PLUGIN_ID, found.render, snap0.renderVersion)

  // ── ④ 协议取文件 ─────────────────────────────────────────────────
  const fetched = await win.webContents.executeJavaScript(
    `fetch(${JSON.stringify(renderUrl)}).then(r => r.status).catch(e => 'ERR:' + e.message)`
  )
  check('④ 协议能取出渲染文件（200）', fetched === 200, fetched)

  // ── ⑤ 渲染进程真的能 import 它（整条链的终点）────────────────────
  const imported = await win.webContents.executeJavaScript(
    `import(${JSON.stringify(renderUrl)}).then(m => m.MARKER || 'no-marker').catch(e => 'ERR:' + e.message)`
  )
  check('⑤ 渲染进程动态 import 成功（社区市场的插件 UI 能跑起来）',
    imported === 'acme-demo-renderer-ok', imported)

  // ── ⑥ 三道安全边界 ───────────────────────────────────────────────
  const traversal = await win.webContents.executeJavaScript(
    `fetch('hira-plugin://${PLUGIN_ID}/' + encodeURIComponent('../../notes.secret')).then(r => r.status).catch(e => 'ERR')`
  )
  check('⑥ 目录穿越被拒（403/404，绝不返回内容）', traversal === 403 || traversal === 404, traversal)

  const whitelist = await win.webContents.executeJavaScript(
    `fetch('hira-plugin://${PLUGIN_ID}/notes.secret').then(r => r.status).catch(e => 'ERR')`
  )
  check('⑥ 白名单外的扩展名被拒（403）', whitelist === 403, whitelist)

  // 禁用后：URL 立刻失效（否则"禁用了但代码还在页面里跑"）
  await registry.disable(PLUGIN_ID, {})
  const afterDisable = await win.webContents.executeJavaScript(
    `fetch(${JSON.stringify(renderUrl)}).then(r => r.status).catch(e => 'ERR')`
  )
  check('⑥ 禁用后同一个 URL 立刻 404（禁用是真的停掉了代码，不只是摘了 provider）',
    afterDisable === 404, afterDisable)

  try { server.close() } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {}

  const failed = results.filter((r) => !r.ok)
  console.log('\n========================================')
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join(' | '))
  console.log('========================================')
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() =>
  main().catch((error: unknown) => {
    console.error('验证脚本异常：', error instanceof Error ? error.stack ?? error.message : errorMessage(error))
    app.exit(2)
  })
)
