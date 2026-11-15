/**
 * 权限申请浮层 —— **独立原生视图**（旧架构回滚）。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 *   · 只认「事实」：payload = `{ requests }`（id / origin / type / sensitive）。
 *   · 只发「意图」：四档决定 → `overlay:commit { kind:'permission', id, allow, persist }`，
 *     由外壳转成 `permission:respond`（浮层不知道权限服务、不知道持久化怎么落库）。
 *   · 落位只报「自己的尺寸」：主进程按 `position:'in-content'` + 左上对齐摆到
 *     **内容区左上角**（网页矩形的 x/y 只有主进程知道）。
 *
 * ── 观感：与侧栏权限面板同规格 ──────────────────────────────────────────
 * 一条请求 = 一张卡（站点 + 一句请求说明 + 敏感标记），下面是**四个带字大按钮**：
 * 允许一次 / 始终允许 / 阻止一次 / 始终阻止。文案与 allow·persist 语义来自共享的
 * `PERMISSION_CHOICES`，配色来自共享的样式文件（styles.js）—— 见那两个文件头的说明。
 * 渲染细节全在 view.js，样式全在 styles.js，本文件只负责**装配与事件接线**。
 *
 * ── 开合的真源在外壳 ────────────────────────────────────────────────────
 * 本视图不判断"该不该弹"（那要看窗口是否在前台、待处理列表是否为空），
 * 只认外壳推来的 show / hide。点击某一档后本地先移除（跟手），随后外壳推新列表
 * 或 hide 覆盖 —— 死请求不会挂在浮层上。
 */
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { dismissOnOutsidePointerDown } from '@hira-ng/ui-common/src/overlayCard'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { PERMISSION_METRICS, injectPermissionStyles } from './styles.js'
import { createPermissionView } from './view.js'

createThemeController({ document, bridge: getHiraBridge() }).start()
injectPermissionStyles(document)

const root = ((): HTMLElement => {
  const element = document.getElementById('root')
  if (!element) throw new Error('Permission overlay root is unavailable')
  return element
})()

const popover = document.createElement('div')
popover.className = 'hira-permission-popover'
// 留白值只从 PERMISSION_METRICS 来（CSS 侧读同一个变量）—— 免得 CSS 写 28、JS 写 24。
popover.style.setProperty('--pp-pad', `${PERMISSION_METRICS.pad}px`)
root.appendChild(popover)

/** 是否在屏上（外壳推 show 且有请求）。 */
let visible = false
/** 本地渲染副本：点击某一档后先本地移除，主进程随后推来的真值会覆盖它。 */
let requests: Array<{ id: string; origin?: string; type?: string; sensitive?: boolean }> = []

const view = createPermissionView(document, {
  onChoice: (request, choice) => respond(
    request as { id: string; origin?: string; type?: string; sensitive?: boolean },
    choice as { allow?: unknown; persist?: unknown }
  ),
  onOverflow: openPermissionsPanel
})
popover.appendChild(view.element)

/**
 * 测量并上报：视图尺寸 + 交互态一起走**一次**单向 IPC，
 * 落位（内容区左上角）由主进程按 position:'in-content' 计算。
 */
function reportLayout() {
  const rect = popover.getBoundingClientRect()
  display({
    position: 'in-content',
    align: 'left',
    valign: 'top',
    margin: 0,
    width: Math.ceil(rect.width + PERMISSION_METRICS.pad * 2),
    height: Math.ceil(rect.height + PERMISSION_METRICS.pad),
    interactive: true
  })
}

/** 重画 + 重测。 */
function paint() {
  view.render(requests)
  // **同步量一次**：`getBoundingClientRect()` 会强制同步布局，不依赖绘制帧；
  // 首次打开时原生视图还是 0×0，rAF 可能永远不触发，不在这里先报一次，
  // 主进程就永远拿不到尺寸 —— 用户看到的就是「浮层弹了但点不动」。
  if (visible) reportLayout()
}

/** 外壳推来的真值列表（空列表 = 没有待处理请求，直接收起）。 */
function show(next: unknown) {
  const list = Array.isArray(next)
    ? next as Array<{ id: string; origin?: string; type?: string; sensitive?: boolean }>
    : []
  requests = list
  visible = list.length > 0
  popover.classList.toggle('is-open', visible)
  paint()
}

/** 收起（无副作用：bounds 由主进程收；这里只清本地表现）。 */
function hide() {
  visible = false
  requests = []
  popover.classList.remove('is-open')
  view.render([])
}

/**
 * 用户主动放弃本次弹窗（Esc / 点卡片外留白）。
 *
 * 只清 DOM 是不够的：视图这一刻仍是 interactive 的矩形，透明留白会**吃掉**
 * 页面左上角的点击。所以要回传 hide 给主进程 —— 那一条会收起 bounds 并
 * 关闭交互态。请求本身不被取消：下一次权限事件（或窗口重新聚焦）仍会再弹。
 */
function dismiss() {
  if (!visible) return
  hide()
  try {
    getHiraBridge().provider.send('permission-overlay:hide', {})
  } catch (_) {}
}

/**
 * 「还有 N 项 · 转到权限面板」被点下：本层只报一个**动作**，
 * 面板 id 与展开侧全由外壳裁定（见 app-shell#openPanelFromOverlay）——
 * 浮层不认识面板目录，也不该认识（与站点信息浮层的 siteinfo-action 同一条纪律）。
 *
 * 先按普通收起处理：本地清空 + 报 `permission-overlay:hide`，
 * 让主进程把这块 interactive 矩形收掉（否则透明留白会吃掉页面左上角的点击）。
 */
function openPermissionsPanel() {
  dismiss()
  try {
    getHiraBridge().provider.send('overlay:commit', { kind: 'permission-open-panel' })
  } catch (_) {}
}

/**
 * 某一档被按下：**先本地移除**（点下去那张卡立刻消失，不等 IPC 往返 —— 跟手优先），
 * 再报意图。列表清空则顺手收起（外壳随后也会推 hide，两条路径都收敛到同一状态）。
 */
function respond(
  request: { id: string; origin?: string; type?: string; sensitive?: boolean },
  choice: { allow?: unknown; persist?: unknown }
) {
  try {
    getHiraBridge().provider.send('overlay:commit', {
      kind: 'permission',
      id: request.id,
      allow: choice.allow,
      persist: choice.persist
    })
  } catch (_) {}
  requests = requests.filter((item) => item.id !== request.id)
  if (requests.length === 0) {
    dismiss()
    return
  }
  paint()
}

function display(payload: Record<string, unknown>): void {
  try {
    getHiraBridge().provider.send('permission-overlay:display', payload)
  } catch (_) {}
}

// 「点卡片外留白 → 收起」用共享判据（ui-common#dismissOnOutsidePointerDown）——
// 与选择目标 / 站点信息浮层同一份实现，不在这里另写一条 mousedown 判据。
dismissOnOutsidePointerDown(document, {
  isOpen: () => visible,
  element: popover,
  onDismiss: dismiss
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismiss()
})

const bridge = getHiraBridge()
bridge.on.subscribe('permission-overlay:show', (payload) => show(payload && payload.requests))
bridge.on.subscribe('permission-overlay:hide', hide)
bridge.on.subscribe(IPC_EVENTS.profileChanged, dismiss)

;(async () => {
  try { await bridge.provider.invoke('permission-overlay:ready', {}) } catch (_) {}
})()

