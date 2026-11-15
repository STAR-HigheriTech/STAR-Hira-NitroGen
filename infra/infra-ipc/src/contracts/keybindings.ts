import { z } from 'zod'

const keybindingsSchemas = Object.freeze({
  get: Object.freeze({
    request: z.unknown().optional(),
    response: z.record(z.string(), z.string())
  }),
  defaults: Object.freeze({
    request: z.unknown().optional(),
    response: z.record(z.string(), z.string())
  }),
  set: Object.freeze({
    request: z.object({ action: z.string(), combo: z.string() }),
    response: z.object({ ok: z.boolean(), combo: z.string() })
  }),
  resetOne: Object.freeze({
    request: z.object({ action: z.string() }),
    response: z.object({ ok: z.boolean(), combo: z.string() })
  }),
  reset: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  }),
  // 录制让位开关：true = 主进程暂停内置按键分发，把按键原样交给页面。
  // 无参（reset 之后自动恢复）。页面必须在保存 / 取消 / 卸载时置回 false ——
  // 主进程侧还有 destroyed / did-navigate 兜底，双保险。
  setRecording: Object.freeze({
    request: z.object({ recording: z.boolean() }),
    response: z.object({ ok: z.boolean() })
  })
})

export { keybindingsSchemas }

