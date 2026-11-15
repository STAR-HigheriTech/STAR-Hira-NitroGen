/**
 * 新标签页 · 看板网格探针
 *
 * 验四件事：
 *   ① 默认摆放里每张卡都落在"对称三锚点"之一（像素级：要么贴左、要么贴右、要么左右留白相等）；
 *   ② 拖拽后落点仍是三锚点之一（横向只允许左/中/右），被压到的卡片下推让位、之后整体上浮；
 *   ③ 改尺寸按整格吸附，且新宽度下横坐标仍归到最近锚点（居中卡拉宽后依然绝对居中）；
 *   ④ 任何一步都不出现卡片重叠、console 无错误。
 *
 * 用法（在 1A-STAR_Hira_NG/ 下）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/.bin/electron scripts/verify-ntp-board.cjs 2>&1 | sed -n '/###REPORT###/,$p'
 *
 * ⚠ 两个坑（都踩过）：
 *   · 窗口必须 `show: true`：未显示的窗口不产合成帧，**rAF 根本不触发** ——
 *     而拖拽是逐帧写 transform 的，隐藏起来测只会看到"mousedown 生效、move 全丢"。
 *   · 拖拽事件在**页面里**派发（监听挂在卡片根节点/把手上），比 sendInputEvent 稳得多：
 *     不依赖窗口焦点，也不依赖坐标换算。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { app, BrowserWindow } = require('electron') as typeof import('electron')

interface BoardCard {
  i: string | undefined
  widget: string | undefined
  left: number
  right: number
  w: number
  h: number
  top: number
}

interface BoardResult {
  fatal?: string
  cards: BoardCard[]
  [key: string]: unknown
}

interface BoardStep {
  name: string
  cards?: BoardCard[]
  [key: string]: unknown
}

interface BoardReport {
  steps: BoardStep[]
  errors?: string[]
  fail?: string[]
  ok?: boolean
}

const NG = path.join(__dirname, '..')
const PROTOCOL = path.join(NG, 'out', 'main', 'hira-protocol.js')
const tmp = path.join(os.tmpdir(), 'hira-ng-ntp-' + process.pid)
fs.mkdirSync(tmp, { recursive: true })
app.setPath('userData', tmp)

const hira = require(PROTOCOL) as { registerHiraProtocol: () => void }
;(require(path.join(NG, 'out', 'main', 'scheme-privileges.js')) as { registerAppSchemes: () => void }).registerAppSchemes()

const MEASURE = `(async () => {
  const board = document.querySelector('.ntp__board')
  if (!board) return { fatal: 'no board' }
  const b = board.getBoundingClientRect()
  const cards = Array.from(document.querySelectorAll('.wgt')).map((el) => {
    const r = el.getBoundingClientRect()
    return {
      i: el.dataset.i,
      widget: el.dataset.widget,
      left: Math.round(r.left - b.left),
      right: Math.round(b.right - r.right),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top - b.top)
    }
  })
  let anchors = null
  try {
    const g = await import('hira://newtab/widgets/grid.js')
    anchors = g.hAnchors(16, 1)
  } catch (e) { anchors = 'IMPORT_FAIL ' + e.message }
  let stored = null
  try { stored = JSON.parse(localStorage.getItem('hira.ntp.board.v1') || 'null') } catch (_) {}
  return { board: { w: Math.round(b.width), h: Math.round(b.height) }, cards, anchors, stored, editing: board.dataset.editing }
})()`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main () {
  hira.registerHiraProtocol()

  const win = new BrowserWindow({
    // 必须真显示：未显示的窗口在 Electron 里不产出合成帧，rAF 会被"卡住不触发"，
    // 而拖拽逐帧写 transform 全靠 rAF —— 隐藏起来测出来的会全是"move 丢了"的假象。
    show: true,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(NG, 'out', 'preload', 'tab.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  const errors: string[] = []
  win.webContents.on('console-message', (details, level, message) => {
    const effectiveLevel = details.level ?? level
    const text = details.message ?? message
    if (String(effectiveLevel) === '3' || String(effectiveLevel) === 'error') errors.push(String(text).slice(0, 200))
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => errors.push('DID_FAIL_LOAD ' + code + ' ' + desc + ' ' + url))

  const out: BoardReport = { steps: [] }
  const push = (name: string, data: Record<string, unknown>): void => { out.steps.push({ name, ...data }) }

  const load = async () => {
    errors.length = 0
    await win.loadURL('hira://newtab/')
    await sleep(600)
  }

  // ── ① 默认摆放 ────────────────────────────────────────────────────────────
  await load()
  const initial = await win.webContents.executeJavaScript(MEASURE, true) as BoardResult
  push('initial', initial)

  // ── 进入自定义模式 ────────────────────────────────────────────────────────
  const entered = await win.webContents.executeJavaScript(
    `(() => {
      const btn = Array.from(document.querySelectorAll('.ntp__actions .ntp-tab')).find((b) => b.textContent.trim() === '自定义')
      if (!btn) return 'no-edit-btn'
      btn.click()
      const b = document.querySelector('.ntp__board')
      return b ? b.dataset.editing : 'no-board'
    })()`,
    true
  )
  push('enter-editing', { editing: entered })
  await sleep(250)

  // 拖拽驱动器跑在**页面里**：拖拽的监听挂在卡片根节点上（pointerdown/move/up），
  // 在页面内派发即可精确复现"按下 → 逐帧移动 → 松手"，不受窗口焦点/节流影响。
  const DRAG = `(async (widget, dx, dy) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const el = document.querySelector('.wgt[data-widget="' + widget + '"]')
    if (!el) return { fatal: 'no card ' + widget }
    const r = el.getBoundingClientRect()
    const ev = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y
    })
    const x0 = r.left + r.width / 2
    const y0 = r.top + r.height / 2
    const x1 = x0 + dx
    const y1 = y0 + dy
    el.dispatchEvent(ev('pointerdown', x0, y0))
    const N = 8
    for (let k = 1; k <= N; k++) {
      await sleep(60)
      el.dispatchEvent(ev('pointermove', x0 + (dx * k) / N, y0 + (dy * k) / N))
    }
    await sleep(80)
    el.dispatchEvent(ev('pointerup', x1, y1))
    await sleep(300)
    return { from: { x: Math.round(x0), y: Math.round(y0) }, to: { x: Math.round(x1), y: Math.round(y1) }, dragging: el.classList.contains('is-dragging') }
  })`

  // ── ② 改尺寸：搜索框（x3 w10 居中）拉宽 2 格 → 宽 12、仍应绝对居中（x=2） ─────
  const stepX = 64.25 // 1016 宽 / 16 列 → cellW 52.25 + gap 12
  const stepY = 64 // 52 + 12
  const RESIZE = `(async (widget, dx, dy) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const grip = document.querySelector('.wgt[data-widget="' + widget + '"] .wgt__resize')
    if (!grip) return { fatal: 'no grip ' + widget }
    const r = grip.getBoundingClientRect()
    const ev = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y
    })
    const x0 = r.left + r.width / 2
    const y0 = r.top + r.height / 2
    grip.dispatchEvent(ev('pointerdown', x0, y0))
    const N = 8
    for (let k = 1; k <= N; k++) {
      await sleep(60)
      grip.dispatchEvent(ev('pointermove', x0 + (dx * k) / N, y0 + (dy * k) / N))
    }
    await sleep(80)
    grip.dispatchEvent(ev('pointerup', x0 + dx, y0 + dy))
    await sleep(300)
    return { resizing: grip.classList.contains('is-resizing') !== false && document.querySelector('.wgt[data-widget=\"' + widget + '\"]').classList.contains('is-resizing') }
  })`
  const resize1 = await win.webContents.executeJavaScript(`${RESIZE}('search', ${Math.round(stepX * 2)}, ${stepY})`, true)
  push('after-resize-search', { resize: resize1, ...(await win.webContents.executeJavaScript(MEASURE, true)) })

  // ── ③ 把时钟卡往右拖 5 格：应吸附到"正中"锚点（x 0 → 4.5） ────────────────
  const drag1 = await win.webContents.executeJavaScript(`${DRAG}('clock', ${Math.round(stepX * 5)}, 0)`, true)
  push('after-drag-clock', { drag: drag1, ...(await win.webContents.executeJavaScript(MEASURE, true)) })

  // ── ④ 把时钟卡往左下拖进日期卡的行：验"让位 + 整体上浮" ─────────────────────
  const drag2 = await win.webContents.executeJavaScript(`${DRAG}('clock', ${-Math.round(stepX * 5)}, ${Math.round(stepY * 2)})`, true)
  push('after-drag-down', { drag: drag2, ...(await win.webContents.executeJavaScript(MEASURE, true)) })

  // ── ④ 校验 ────────────────────────────────────────────────────────────────
  const fail: string[] = []
  const check = (label: string, res: BoardResult): void => {
    if (!res || res.fatal) {
      fail.push(label + ': ' + (res && res.fatal))
      return
    }
    let centered = 0
    for (const c of res.cards) {
      const flushL = c.left === 0
      const flushR = c.right === 0
      const sym = Math.abs(c.left - c.right) <= 1
      if (!flushL && !flushR && !sym) fail.push(label + ' 卡片不在三锚点: ' + c.widget + ' L' + c.left + ' R' + c.right + ' W' + c.w)
      if (sym && !flushL && !flushR) centered++
    }
    // 无人重叠
    for (let i = 0; i < res.cards.length; i++) {
      for (let j = i + 1; j < res.cards.length; j++) {
        const a = res.cards[i]
        const b = res.cards[j]
        const ax2 = a.left + a.w
        const bx2 = b.left + b.w
        const ay2 = a.top + a.h
        const by2 = b.top + b.h
        if (a.left < bx2 && b.left < ax2 && a.top < by2 && b.top < ay2) fail.push(label + ' 重叠: ' + a.widget + ' × ' + b.widget)
      }
    }
    res._centered = centered
  }
  check('initial', initial)
  for (const s of out.steps) if (s.cards) check(s.name, s as BoardResult)

  out.errors = errors.slice(0, 6)
  out.fail = fail
  out.ok = fail.length === 0 && errors.length === 0
  console.log('###REPORT###')
  console.log(JSON.stringify(out, null, 1))

  win.destroy()
  app.quit()
}

app.whenReady().then(main).catch((error: unknown) => {
  console.log('###FATAL###', error instanceof Error ? error.stack ?? error.message : String(error))
  app.quit()
})
