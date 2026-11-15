/**
 * split-toolbar —— hover 在分屏上浮出的那排小按钮的**宿主渲染页**（独立原生视图）。
 *
 * 薄宿主：`@hira-ng/ui-split-toolbar` 只管画，本文件只做两件事 ——
 *   ① 订阅主进程推来的形态（`split-toolbar:update` / `:hide`）交给组件渲染；
 *   ② 把用户在按钮上触发的命令经裸通道发回主进程（`split-toolbar:command`）。
 * **它不认识标签、不认识分屏、不知道 hover 为什么发生。**
 *
 * ── 与其它浮层最大的不同：本页从不决定自己的位置与大小 ──────────────────
 * 查找栏 / 悬停 URL / 缩放条是"渲染页量好尺寸 → 上报 display → 主进程落位"。
 * 本页反过来：**视图的 bounds 就是工具条矩形本身**（hover 态）或**整片分屏区域**
 *（拖动重排态），都由主进程按屏幕光标 + 格矩形算出（见 main/split-toolbar.js）。
 * 本页只需把自己铺满（CSS `inset: 0`），一个几何字段都不上报 ——
 * 因为指针一进网页原生视图，本视图就收不到指针事件，"指针在哪一格"只能在主进程判定。
 *
 * ── 数据流（单向，命令反向走裸通道）──────────────────────────────────
 *   主进程 split-toolbar（30fps 采样光标）
 *     → `split-toolbar:update { layout, count, memberIndex, panes, dragging, dropIndex, … }`
 *     → 本页 setShown(true) + set(payload)
 *   离开分屏 / 分屏消失 / 窗口失焦
 *     → `split-toolbar:hide` → setShown(false)
 *   用户点按钮 / 拖手柄
 *     → `split-toolbar:command { type:'action'|'drag-begin'|'drag-end', … }` → 主进程执行
 *
 * ── 为什么"显示"不由 payload 决定 ─────────────────────────────────────
 * 显隐的主进程真源是视图 bounds（0×0 = 收起）——`update` 到了就是该显示，
 * `hide` 到了就是该收起。本页不维护第二份"该不该显示"的判断。
 *
 * IPC：
 *   订阅 split-toolbar:update / split-toolbar:hide
 *   发送 split-toolbar:command（裸通道，单向）
 *   调用 split-toolbar:ready（报告渲染页就绪）
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createSplitToolbar, injectSplitToolbarStyles } from '@hira-ng/ui-split-toolbar'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'

const bridge = getHiraBridge()
const provider = bridge.provider

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

injectSplitToolbarStyles(document)

const OVERLAY = 'split-toolbar'

const toolbar = createSplitToolbar(document, {
  // 命令的唯一出口：fire-and-forget（拖动/点击都是高频一次性消息，失败由下一次覆盖）。
  onCommand: (cmd) => {
    try { provider.send(IPC_ROUTES.splitToolbarCommand, cmd) } catch (_) {}
  }
})
document.getElementById('root')!.appendChild(toolbar.element)

bridge.on.subscribe(IPC_EVENTS.splitToolbarUpdate, (payload) => {
  // 先套形态再显示：反过来的话会出现一帧"上一个格 / 上一次拖动"的残影。
  toolbar.set(payload || {})
  toolbar.setShown(true)
})

// 收起：主进程收起时用的就是这条通道名（与 FLOAT_NAMES 循环转发的 `:hide` 同一条）。
bridge.on.subscribe(IPC_EVENTS.splitToolbarHide, () => toolbar.setShown(false))

;(async () => {
  try { await provider.invoke(`${OVERLAY}:ready`, {}) } catch (_) {}
})()
