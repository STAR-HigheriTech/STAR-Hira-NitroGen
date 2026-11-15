/**
 * capture-editor —— 截图标注的**浏览器窗口内浮层**（独立原生视图，不是应用子窗口）。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────
 * 三种截图（可见区域 / 整页 / 选区）拿到的 PNG 都送到这里：淡暗铺满整块网页视图、
 * 图像按选区原位显示、工具栏浮在图像下方 —— 用户感受是"截完就地标注"，
 * 而不是"又弹出一个应用窗口"（对齐 QQ / Snipaste）。
 *
 * ── 为什么是独立原生视图 ──────────────────────────────────────────
 * 网页跑在 WebContentsView 里，天然盖住外壳 DOM；标注画布只能画在**另一块同样大小的
 * 原生视图**上（与查找栏 / 框选层同一条理由）。因此本页只是那个视图的内容，
 * bounds 与摆放全由主进程给（见 `main/capture-editor-overlay.js`）。
 *
 * ── 数据流 ───────────────────────────────────────────────────────
 *   主进程 `capture-editor:show { captureId, place }` → 本页挂载编辑器
 *   本页 `capture-editor:load/copy/save`（invoke）→ 底图 / 剪贴板 / 另存为
 *   本页 `capture-editor:close`（单向）→ 主进程收起
 *   主进程 `capture-editor:hide` → 本页释放画布
 *
 * `place` = 选区在目标视图里的矩形。浮层与视图逐像素重合，因此它直接就是
 * 画布在浮层里的位置 —— 中间没有任何坐标换算（换算必然出现"图被搬走一截"）。
 */

import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import {
  captureEditorDefinition,
  type CaptureEditorContext,
  type CaptureEditorController,
  type CaptureLoadResult
} from '@hira-ng/ui-capture-editor'
import { getHiraBridge } from '../shared/bridge.js'
import { createThemeController } from '../shared/theme-controller.js'

const bridge = getHiraBridge()
const provider = bridge.provider
const root = ((): HTMLElement => {
  const element = document.getElementById('root')
  if (!element) throw new Error('Capture editor root is unavailable')
  return element
})()

const themeController = createThemeController({ document, bridge })
themeController.start()
window.addEventListener('pagehide', () => themeController.dispose(), { once: true })

/** 当前挂载的编辑器实例（hide 事件 / 下一次 show 之前释放）。 */
let mounted: CaptureEditorController | null = null
const PREFERENCES_KEY = 'hira.capture-editor.preferences.v1'

function readPreferences(): { tool?: string; color?: string; width?: number } | null {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    return {
      tool: typeof value.tool === 'string' ? value.tool : undefined,
      color: typeof value.color === 'string' ? value.color : undefined,
      width: typeof value.width === 'number' ? value.width : undefined
    }
  } catch (_) {
    return null
  }
}

function writePreferences(value: { tool: string; color: string; width: number }): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value))
  } catch (_) {}
}

function dispose(): void {
  const instance = mounted
  mounted = null
  if (instance && typeof instance.dispose === 'function') {
    try { instance.dispose() } catch (_) {}
  }
  root.textContent = ''
}

/**
 * 挂载一次标注会话。
 * @param {{ captureId?: string, place?: {x:number,y:number,width:number,height:number} }} payload
 */
function mount(payload: { captureId?: unknown; place?: { x: number; y: number; width: number; height: number } }): void {
  dispose()
  const captureId = String((payload && payload.captureId) || '')
  const place = payload && payload.place && typeof payload.place === 'object' ? payload.place : null
  if (!captureId) return

  /** 端口契约（与 `ui/ui-capture-editor` 文件头逐项对应）。 */
  const ctx: CaptureEditorContext = {
    place,
    load: async () => (await provider.invoke(IPC_ROUTES.captureEditorLoad, { captureId })) as unknown as CaptureLoadResult | null,
    copy: async (bytes) => {
      const res = await provider.invoke(IPC_ROUTES.captureEditorCopy, { bytes })
      return !!(res && res.ok)
    },
    save: async (bytes, suggestedName) => await provider.invoke(
      IPC_ROUTES.captureEditorSave,
      { bytes, suggestedName }
    ) as unknown as { ok: boolean } | null,
    // 收起由主进程做（几何归零 + 通知本页复位）：本页不是窗口，不能自己关自己。
    close: () => {
      try { provider.send(IPC_ROUTES.captureEditorClose, {}) } catch (_) {}
    },
    /**
     * 首帧已画出来（编辑器在**显示自己之前**调一次）。
     *
     * 主进程拿到这条才会收起下层的框选层 —— 早收一步就是"页面亮回来再压暗"的闪跳。
     * 只发一次：编辑器内部用 `reveal()` 去重，重复调用无副作用（这里也不做额外节流）。
     */
    ready: () => {
      try { provider.send(IPC_ROUTES.captureEditorReady, {}) } catch (_) {}
    },
    preferences: { read: readPreferences, write: writePreferences }
  }

  if (typeof captureEditorDefinition.injectStyles === 'function') {
    captureEditorDefinition.injectStyles(document)
  }
  const instance = captureEditorDefinition.mount(document, ctx)
  mounted = instance
  root.appendChild(instance.element)
  // 先入 DOM 再 start：编辑器要量真实尺寸来摆画布与工具栏（未挂载时全是 0）。
  if (typeof instance.start === 'function') instance.start()
}

bridge.on.subscribe(IPC_EVENTS.captureEditorShow, (payload) => mount(payload || {}))
bridge.on.subscribe(IPC_EVENTS.captureEditorHide, () => dispose())

