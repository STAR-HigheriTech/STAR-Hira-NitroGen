import { z } from 'zod'

/**
 * Capture Editor 域契约（截图标注窗口）。
 *
 * 三条路由围绕同一张图：
 *   load —— 编辑器挂载时取走底图（主进程暂存，取走即释放，见 main/capture-editor.js）
 *   copy —— 画布重新编码后的 PNG → 系统剪贴板
 *   save —— 画布重新编码后的 PNG → 「另存为」对话框 → 落盘
 *
 * 二进制统一用 `z.unknown()`：Electron 的结构化克隆把 Uint8Array 原样送达，
 * 逐字节校验一张 8MB 的整页图既没有意义、也会在每次复制/保存时白跑一遍。
 * 真正的形状约束在 handler 里（`toBuffer` 只接受几种确定的二进制形态）。
 */
const captureEditorSchemas = Object.freeze({
  load: Object.freeze({
    request: z.object({ captureId: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      bytes: z.unknown().optional(),
      reason: z.string().optional()
    })
  }),
  copy: Object.freeze({
    request: z.object({ bytes: z.unknown() }),
    response: z.object({ ok: z.boolean() })
  }),
  save: Object.freeze({
    request: z.object({
      bytes: z.unknown(),
      suggestedName: z.string().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      filePath: z.string().optional(),
      reason: z.string().optional()
    })
  })
})

export { captureEditorSchemas }

