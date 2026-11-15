/**
 * findbar-overlay —— 页内查找栏的**宿主渲染页**（独立原生视图，浮在网页上方）
 *
 * ── 为什么必须是独立视图 ──────────────────────────────────────────────
 * 网页是原生 `WebContentsView`，天然盖在 chrome（窗口本体）之上 —— 画在 chrome DOM 里的
 * 查找栏会被网页整个遮住。所以它与建议下拉、标签预览一样，是一条独立图层。
 *
 * ── 本文件的职责边界（薄宿主）──────────────────────────────────────────
 *   · 外框：reset + 令牌样式 + 主题控制器；
 *   · 端口：把 `@hira-ng/ui-findbar`（哑组件）的意图搬成 IPC，把 IPC 结果搬回组件；
 *   · 几何：量胶囊尺寸后上报，**位置由主进程按网页矩形算**
 *     （`position: 'in-content'` + align right / valign top → 网页右上角）。
 * 组件本身不认识 IPC，本文件不做任何查找逻辑 —— 真正的 `findInPage` 调用在
 * `apps/app-main/src/main/find-bar.js`（它才拿得到标签的 webContents）。
 *
 * IPC（路由由 `shared/overlay-scope.js` 统一决定 —— 主窗口 / PWA 应用窗两套）：
 *   订阅 find:show { query } / find:focus / find:result（渐进计数）
 *   发送 find:query { text, forward, findNext } / find:stop { action } / find:close
 *   单向 display（上报视图尺寸 + 落位请求）
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createFindbar, injectFindbarStyles, FINDBAR_SHADOW_PAD } from '@hira-ng/ui-findbar'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { resolveOverlayScope } from '../shared/overlay-scope.js'

const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

injectFindbarStyles(document)

/** 本浮层的通道名（`:show` / `:hide` / `:display` 由主进程按名注册，见 ipc/layout.js）。 */
const OVERLAY = 'findbar-overlay'

/** 主窗口 / PWA 应用窗两套路由的唯一差分点。 */
const scope = resolveOverlayScope(OVERLAY, provider)

/** 与网页边缘的间距（px）。查找栏落网页右上角，这一个值同时管上边与右边。 */
const CONTENT_MARGIN = 10

const findbar = createFindbar(document, {
  // 输入变化 = 一段**新的搜索**：不带 `findNext`（主进程照 Hira 走 `findInPage(text)`，
  // 即 Electron 默认的"开启新会话"）。语义细节见 main/find-bar.js 文件头那张表。
  onQuery: (text, opts) => {
    if (!text) {
      // 清空输入 = 结束本次会话并去掉高亮，但**查找栏保持打开**（Chrome 同款）
      scope.findStop({ action: 'clearSelection' })
      return
    }
    scope.findQuery({ text, forward: !!opts.forward, findNext: !!opts.findNext })
  },
  // 上/下一个 = **步进**（`findNext:true` 在本项目契约里表示"这是步进"，方向由 forward 决定；
  // 主进程会把它翻成 Chromium 的 `{ forward, findNext:false }`，见 find-bar.js 的 runQuery 说明）
  onNext: (text) => scope.findQuery({ text, forward: true, findNext: true }),
  onPrev: (text) => scope.findQuery({ text, forward: false, findNext: true }),
  // 关闭：请主进程收起浮层并结束查找会话（清高亮在那边统一收口，见 main/find-bar.js）
  onClose: () => scope.findClose()
})

// 组件是 `position: fixed`，视图尺寸 = 胶囊 + 四周留白（给投影），所以胶囊要按留白内缩。
findbar.element.style.left = `${FINDBAR_SHADOW_PAD}px`
findbar.element.style.top = `${FINDBAR_SHADOW_PAD}px`
const root = document.getElementById('root')
if (!root) throw new Error('Findbar overlay root is unavailable')
root.appendChild(findbar.element)

/** 显示中：把胶囊尺寸报给主进程，由它按网页矩形落位。 */
function reportDisplay() {
  const { width, height } = findbar.measure()
  if (!width || !height) return
  scope.display({
    width: width + FINDBAR_SHADOW_PAD * 2,
    height: height + FINDBAR_SHADOW_PAD * 2,
    // in-content：贴在**网页矩形**内（不是窗口内）—— 网页右上角，浮在网页之上、不挤网页
    position: 'in-content',
    align: 'right',
    valign: 'top',
    margin: CONTENT_MARGIN,
    interactive: true
  })
}

bridge.on.subscribe(IPC_EVENTS.findShow, (payload: Record<string, unknown>) => {
  const p = payload || {}
  const query = typeof p.query === 'string' ? p.query : ''
  findbar.setQuery(query)
  // 起始态 = "还不知道有没有命中"（`…`）：`finalUpdate:false` 即"等待中"。
  // 少了它，恢复上次查询串的那一帧会闪一下"无结果"。
  findbar.setResult({ matches: 0, activeMatchOrdinal: 0, finalUpdate: false })
  findbar.setShown(true)
  // 先落位再要焦点：视图尺寸为 0 时焦点要不过来（Windows/macOS 都会忽略）。
  reportDisplay()
  findbar.focus({ select: true })
  // 恢复上次查询时**重跑一次**：高亮与计数都随页面刷新没了，不重跑就是"显示 3/17 但页面上没高亮"。
  if (query) {
    scope.findQuery({ text: query, forward: true, findNext: false })
  }
})

/** 只把焦点召回输入框（连按 Ctrl+F：不是新会话，不重跑搜索、不重置匹配位置）。 */
bridge.on.subscribe(IPC_EVENTS.findFocus, () => {
  reportDisplay()
  findbar.focus({ select: true })
})

// 计数是**渐进**的：每条 found-in-page 都带着 finalUpdate 标记，原样交给组件
//（组件据此区分"还没扫完的 0"与"扫完确实没有"）。
bridge.on.subscribe(IPC_EVENTS.findResult, (payload: Record<string, unknown>) => {
  const r = payload || {}
  findbar.setResult({
    matches: Number(r.matches) || 0,
    activeMatchOrdinal: Number(r.activeMatchOrdinal) || 0,
    finalUpdate: !!r.finalUpdate
  })
})

