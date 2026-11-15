/**
 * SiteInfo Overlay Renderer —— 地址栏「站点信息」聚合浮层的独立渲染入口。
 *
 * ── 三层职责（刻意切成三个文件，互不认识对方的内部）────────────────────
 *   · `model.js`  —— 唯一 invoke IPC 的状态机：并发拉取、代际防迟到、乐观更新/回滚；
 *   · `view.js`   —— 卡片壳：几何、测量上报、Esc / 视图内点击收起；
 *   · `sections/*`—— 纯展示 + `emit(action, payload)`，不认识 IPC 通道名。
 *   本文件只做**接线**：把 bridge / theme / registry / model / view 串起来，
 *   不写业务规则、不写 DOM 细节。新增信息块只需在 `sections/index.js` 注册。
 *
 * ── IPC（独立通道，绝不与 searchbar / tabpreview 共用）───────────────────
 *   订阅：siteinfo-overlay:show / :hide
 *   调用：siteinfo-overlay:display（裸字符串，几何事实）
 *         siteinfo-overlay:ready
 *         overlay:commit { kind:'siteinfo-dismiss' | 'siteinfo-action' }
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge } from '../shared/bridge.js'
import { createThemeController } from '../shared/theme-controller.js'
import { createSiteInfoModel } from './model.js'
import { createSiteInfoView } from './view.js'
import { registerBuiltinSections } from './sections/index.js'
import { createSectionHost } from './sections/registry.js'

const bridge = getHiraBridge()
createThemeController({ document, bridge }).start()

const root = document.getElementById('root')
if (!root) throw new Error('[siteinfo] #root missing')

// `siteinfo-overlay:display` 尚未进 IPC_ROUTES 常量表（与 searchbar-overlay:display 同策略），
// 这里只留一处字面量，避免调用点散落。
const DISPLAY_CHANNEL = 'siteinfo-overlay:display'

/**
 * 收起浮层：只发事实（dismiss），由 app-shell 统一决定收起的副作用
 * （归还焦点、同步按钮状态）。浮层自己不调用 `siteinfo-overlay:hide`。
 */
function dismiss() {
  try {
    bridge.provider.send(IPC_ROUTES.overlayCommit, { kind: 'siteinfo-dismiss' })
  } catch {
    // 视图正在销毁时发送失败属正常，忽略。
  }
}

// ── model：唯一的数据 / 动作中枢 ─────────────────────────────────────────
const model = createSiteInfoModel({
  invoke: (channel, payload) => bridge.provider.invoke(channel, payload || {}),
  subscribe: (channel, handler) => bridge.on.subscribe(channel, handler),
  commit: (payload) => {
    try {
      bridge.provider.send(IPC_ROUTES.overlayCommit, payload)
    } catch {
      // 同上：发送失败不阻断本地状态。
    }
  }
})

// ── view：卡片壳 ─────────────────────────────────────────────────────────
const view = createSiteInfoView({
  doc: document,
  root,
  onLayout: (payload) => {
    try {
      bridge.provider.send(DISPLAY_CHANNEL, payload)
    } catch {
      // 主进程尚未就绪时忽略，下一次 measurement 会再报。
    }
  },
  onDismiss: dismiss
})

// ── 打开 / 收起 ──────────────────────────────────────────────────────────
// 必须**先于** sections 初始化建立订阅：任一信息块（含第三方扩展块）初始化抛错
// 都不能把主链路（show → 打开）一起带下去。show 回调只依赖 model / view。
let pendingFocusSection = ''

bridge.on.subscribe(IPC_EVENTS.siteinfoOverlayShow, (payload) => {
  const context = payload || {}
  pendingFocusSection = typeof context.focusSection === 'string' ? context.focusSection : ''
  // **视觉先行**：卡片先 `is-open`，`measure()` 才能量到真实尺寸并回传 display。
  // 反过来先 `model.open()` 时，任何一处同步异常都会让卡片停在 `display:none`：
  // 主进程收到的是 24×24 的「不可见浮层」，表现就是「点了按钮什么都没出现」。
  try {
    view.show(context)
  } catch (error) {
    console.error('[siteinfo] view.show failed', error)
  }
  try {
    model.open(context)
  } catch (error) {
    console.error('[siteinfo] model.open failed', error)
  }
})

bridge.on.subscribe(IPC_EVENTS.siteinfoOverlayHide, () => {
  model.close()
  view.hide()
})

// 权限、站点数据与身份都属于当前 profile；切换后旧卡片不能再停留。
bridge.on.subscribe(IPC_EVENTS.profileChanged, () => {
  model.close()
  view.hide()
  dismiss()
})

// ── sections：注册 → 建宿主 → 挂进卡片 ──────────────────────────────────
registerBuiltinSections()
const sectionHost = createSectionHost({
  doc: document,
  emit: (action, payload) => model.dispatch(action, payload),
  getState: () => model.getState()
})
view.mountSections(sectionHost.fragment)

// 待定位区块：待处理区是异步灌进来的，show 那一刻它还是 hidden，滚不动。
// 等它真有内容时再定位一次，然后清标记（之后用户滚到哪就是哪）。

// 状态单向流动：model → (view 的 notice / section 的内容)。
model.subscribe((state) => {
  view.render(state)
  sectionHost.update(state)
  if (pendingFocusSection) {
    const pending = (state && state.permissions && state.permissions.pending) || []
    if (pending.length > 0) {
      view.focusSection(pendingFocusSection)
      pendingFocusSection = ''
    }
  }
})

// 首帧先按空状态渲染一次，避免 section 的初始 DOM 在首个 show 时才懒加载（防闪）。
view.render(model.getState())
sectionHost.update(model.getState())

// 通知主进程本浮层 renderer 已就绪（主进程收到后才允许 show）。
;(async () => {
  try {
    await bridge.provider.invoke(IPC_ROUTES.siteinfoOverlayReady, {})
  } catch {
    // 开发态热重载时主进程可能已换代，忽略。
  }
})()

// 浮层视图销毁前释放订阅 / 观察者 / section 内部 timer。
window.addEventListener('beforeunload', () => {
  model.destroy()
  sectionHost.destroy()
  view.destroy()
})

