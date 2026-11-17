/**
 * dropzone-overlay —— 「拖标签到网页区域」的**落位预览**宿主渲染页（独立原生视图）
 *
 * 薄宿主：`@hira-ng/ui-drop-zone` 只管画，本文件只做一件事 —— 订阅主进程推来的形态，
 * 交给组件去渲染。**它不认识标签、不认识分屏、不知道拖动为什么发生。**
 *
 * ── 与其它浮层最大的不同：本页从不决定自己的位置与大小 ──────────────────
 * 查找栏 / 悬停 URL / 缩放条都是"渲染页量好尺寸 → 上报 display → 主进程落位"。
 * 本页反过来：**视图的 bounds 就是预览块矩形本身**（主进程按分屏求解器同源算出，
 * 见 shared-types#dropZonePaneRect），所以本页只需把自己铺满（CSS `inset: 0`），
 * 一个几何字段都不上报。这样"预览的那一块"与"松手后那一格"必然是同一个矩形 ——
 * 所见即所得由结构保证，而不是靠两边各算一遍保持一致。
 *
 * ── 数据流（单向）────────────────────────────────────────────────────
 *   主进程 tab-drop-zone（30fps 采样光标）
 *     → `dropzone-overlay:update { mode, zone, layout, count, maxPanes }`（形态）
 *     → 本页 setShown(true) + set(state)
 *   拖动结束 / 离开网页 / 窗口失焦
 *     → `dropzone-overlay:hide` → setShown(false)
 *
 * ── 为什么"显示"不由 payload 决定 ─────────────────────────────────────
 * 显隐的主进程真源是视图 bounds（0×0 = 收起）——`update` 到了就是该显示，
 * `hide` 到了就是该收起。本页不维护第二份"该不该显示"的判断。
 *
 * IPC：
 *   订阅 dropzone-overlay:update / dropzone-overlay:hide
 *   调用 dropzone-overlay:ready（报告渲染页就绪，主进程据此知道首帧不会打在空白页上）
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createDropZonePreview, injectDropZoneStyles } from '@hira-ng/ui-drop-zone'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'

const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

injectDropZoneStyles(document)

const OVERLAY = 'dropzone-overlay'

const preview = createDropZonePreview(document)
const root = document.getElementById('root')
if (!root) throw new Error('Dropzone overlay root is unavailable')
root.appendChild(preview.element)

bridge.on.subscribe(IPC_EVENTS.dropzoneUpdate, (payload) => {
  // 先套形态再显示：反过来的话会出现一帧"上一个方向的块"（拖动换边时肉眼可见）。
  preview.set(payload || {})
  preview.setShown(true)
  const previewId = payload && typeof payload === 'object'
    ? String((payload as Record<string, unknown>).previewId || '')
    : ''
  if (!previewId) return
  // 连续两帧再确认：首个 rAF 只保证 class 已套上，第二个 rAF 才跨过上一帧的绘制。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!preview.isShown()) return
      try { provider.send(IPC_ROUTES.tabDragDropShown, { previewId }) } catch (_) {}
    })
  })
})

// 收起：主进程收起时用的就是这条通道名（与 FLOAT_NAMES 循环转发的 `:hide` 同一条）。
bridge.on.subscribe(IPC_EVENTS.dropzoneHide, () => preview.setShown(false))

;(async () => {
  try { await provider.invoke(`${OVERLAY}:ready`, {}) } catch (_) {}
})()

