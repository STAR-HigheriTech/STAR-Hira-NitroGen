/**
 * verify-smoke-main.cjs — 主进程冒烟启动探针
 *
 * 前几套探针（pages/games/tab-nav/tab-close）都是自建最小 app，**不经过 main.js**；
 * 而 Step 5/6 改的正是 main.js 的初始化编排（IPC 聚合器 + 模块拓扑启动）。
 * 所以这里真实启动整个应用，检查关键初始化里程碑是否全部到达：
 *   - core 模块（downloads/keybindings）拓扑启动成功
 *   - registerCoreIpc 完成（121 个 handle 挂载）
 *   - post-ipc 模块（settings.sync / tabs.auto-sleep）成功
 *   - app.plugins 成功
 *   - 会话恢复成功
 * 到达「plugins enabled」即视为通过，随后自杀退出。
 * 任一里程碑缺失 / 出现致命错误 → exit 1。
 */

const { app } = require('electron')
const path = require('path')
const os = require('os')

// 1) app-root 解析：electron <script> 方式下 getAppPath 是 scripts/，
//    必须显式指定项目根（shared-utils#getAppRoot 优先读此环境变量）
process.env.HIRA_APP_ROOT = path.resolve(__dirname, '..')
// 2) 用户数据隔离：冒烟启动不得触碰真实 %APPDATA%\hira-ng（会改写用户会话）
app.setPath('userData', path.join(os.tmpdir(), 'hira-ng-smoke-' + Date.now()))

const MARKERS = [
  '[main] core modules ready',
  '[main] init timing: registerCoreIpc took',
  '[main] settings feature ready',
  '[main] plugins enabled',
  '[main] restoring session'
]
const FATAL_PATTERNS = [
  /Cannot find module/,
  /is not a function/,
  /is not defined/,
  /circular dependency/i,
  /depends on ".*" which is not registered/,
  /Error: Cannot bootstrap/i
]

const found = new Set<string>()
const fatal: string[] = []
let done = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function finish(code: number): void {
  if (done) return
  done = true
  console.log('###SMOKE-RESULT###' + JSON.stringify({
    ok: code === 0,
    markersReached: Array.from(found),
    markersMissing: MARKERS.filter((m) => !found.has(m)),
    fatal
  }))
  setTimeout(() => app.exit(code), 50)
}

// 探针自己吃掉 window-all-closed，避免首窗销毁后进程退出
app.on('window-all-closed', () => {})

// 入口必须在 app ready 之前加载（main.js 顶层会调 registerSchemesAsPrivileged）——
// 与 `electron .` 的行为一致：package.json#main 在 ready 前被 require。
console.log = ((orig: (...args: unknown[]) => void) => (...args: unknown[]) => {
  const line = args.map(String).join(' ')
  for (const m of MARKERS) if (line.includes(m)) found.add(m)
  orig(...args)
})(console.log)
console.error = ((orig: (...args: unknown[]) => void) => (...args: unknown[]) => {
  const line = args.map(String).join(' ')
  if (FATAL_PATTERNS.some((re) => re.test(line))) fatal.push(line)
  orig(...args)
})(console.error)
process.on('uncaughtException', (error: unknown) => {
  fatal.push('uncaughtException: ' + errorMessage(error))
  finish(1)
})

try {
  require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
} catch (error: unknown) {
  fatal.push('entry load failed: ' + errorMessage(error))
  finish(1)
}

app.whenReady().then(() => {
  // 轮询里程碑，全部到齐或 60s 超时（首启含扩展系统初始化，比 dev 慢）
  const t0 = Date.now()
  const timer = setInterval(() => {
    if (MARKERS.every((m) => found.has(m))) {
      clearInterval(timer)
      finish(fatal.length ? 1 : 0)
    } else if (Date.now() - t0 > 60000) {
      clearInterval(timer)
      finish(1)
    }
  }, 300)
})
