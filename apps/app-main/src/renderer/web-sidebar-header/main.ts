/**
 * 独立侧栏**顶条**的宿主渲染页（薄壳）。
 *
 * 与 `renderer/split-toolbar` 同构：真正的 DOM 在 ui 共用件里
 * （`ui-common#createWebSidebarHeader`），本页只做三件事：
 *   ① 把命令发回主进程；
 *   ② 订阅主进程推来的状态（标题 / 图标 / 加载态 / 前进后退可用性 / 视图模式）；
 *   ③ 跟主题。
 *
 * 为什么状态要**从主进程推**而不是自己算：标题与图标来自网页、加载态与导航历史来自
 * webContents —— 三样都只有主进程知道（本视图是被别处的 data 驱动的哑壳）。
 */

import { createWebSidebarHeader, injectWebSidebarHeaderStyles } from '@hira-ng/ui-common'
import { webSidebarClient } from '../shared/web-sidebar-client.js'
import { layoutClient } from '../shared/layout-client'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/layers.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'

const bridge = getHiraBridge()

/**
 * 跟主题 —— 与其它外壳渲染页同一份控制器、同一个调法。
 *
 * 顺带就是顶条那两个上圆角的来源：`--hira-theme-radius`（= 网页那同一个数）。
 * 原先这里把 `document` 当参数对象传了（`createThemeController(document)`），
 * 控制器拿到的 `deps.document` 是 undefined，于是**一个令牌都没落地** ——
 * 深色主题下这条一直是浅色，且半径只能吃 CSS 兜底。改成标准调法后一并修好。
 */
const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

injectWebSidebarHeaderStyles(document)
const header = createWebSidebarHeader(document, {
  // 唯一出口：本页不认识 IPC 协议之外的任何东西（更不认识侧栏状态机）
  onCommand: (command) => {
    try { webSidebarClient.command(command) } catch (_) {}
  },
  // 拖标题栏换边：拖动中只报指针位置（目标侧别与落位预览都由主进程算），
  // 松手才落定 —— 与分屏拖分隔条同一套"拖动中给预览、松手才生效"的节奏。
  onMovePreview: (viewX) => {
    try { webSidebarClient.movePreview(viewX) } catch (_) {}
  },
  onMoveEnd: (cancel) => {
    try { webSidebarClient.endMove(cancel) } catch (_) {}
  }
})

const root = document.getElementById('root')
if (root) root.appendChild(header.element)

let layoutEditing = false
async function reportEditorZone() {
  if (!layoutEditing) return
  try {
    const geometry = await layoutClient.webSidebarGeometry()
    if (!geometry || geometry.active === false) return
    const rect = header.element.getBoundingClientRect()
    const side = geometry.side === 'right' ? 'right' : 'left'
    getHiraBridge().provider.send('buttons-edit:zone', {
      surface: 'web-sidebar',
      segments: [{
        key: side,
        label: side === 'right' ? '右侧网页栏' : '左侧网页栏',
        rect: { x: 0, y: 0, width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) },
        axis: 'column',
        grow: 'down',
        items: [{
          id: 'web-sidebar:main',
          x: 0,
          y: Math.max(0, Math.round(rect.top)),
          width: Math.max(1, Math.round(window.innerWidth)),
          height: Math.max(28, Math.round(rect.height || 38))
        }]
      }]
    })
  } catch (_) {}
}

bridge.on.subscribe(IPC_EVENTS.buttonsEditActive, (payload) => {
  layoutEditing = !!(payload && payload.active)
  if (layoutEditing) requestAnimationFrame(reportEditorZone)
})
bridge.on.subscribe(IPC_EVENTS.buttonsEditRemeasure, () => {
  if (layoutEditing) reportEditorZone()
})

webSidebarClient.onState((payload) => {
  if (!payload || typeof payload !== 'object') return
  header.set(payload)
  reportEditorZone()
})
