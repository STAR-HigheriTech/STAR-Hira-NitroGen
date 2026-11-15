import { z } from 'zod'

const fileReferenceSchema = z.object({ id: z.string() }).or(z.object({ filePath: z.string() }))

const downloadsSchemas = Object.freeze({
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.unknown())
  }),
  remove: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  removeMany: Object.freeze({
    request: z.object({ ids: z.array(z.string()).min(1) }),
    response: z.object({ removed: z.number() })
  }),
  clearCompleted: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ cleared: z.number() })
  }),
  open: Object.freeze({
    request: fileReferenceSchema,
    response: z.object({ ok: z.boolean() })
  }),
  showInFolder: Object.freeze({
    request: fileReferenceSchema,
    response: z.object({ ok: z.boolean() })
  }),
  pause: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  resume: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  cancel: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  getFileIcon: Object.freeze({
    request: z.object({ filePath: z.string(), size: z.number().optional() }).optional(),
    response: z.object({ dataUrl: z.string().nullable() })
  }),
  setRateLimit: Object.freeze({
    request: z.object({ bytesPerSec: z.number() }),
    response: z.object({ ok: z.boolean() })
  }),
  getRateLimit: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ bytesPerSec: z.number() })
  }),
  retry: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  // 活动下载数（红点初始态）。只读、无参数。
  active: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ active: z.number() })
  })
})

export { downloadsSchemas }

