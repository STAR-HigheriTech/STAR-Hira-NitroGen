import { z } from 'zod'

const profileSchemas = Object.freeze({
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.unknown())
  }),
  getActive: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown()
  }),
  create: Object.freeze({
    request: z.object({ name: z.string(), icon: z.string().optional(), color: z.string().optional() }),
    response: z.unknown()
  }),
  update: Object.freeze({
    request: z.object({ id: z.string(), name: z.string().optional(), icon: z.string().optional(), color: z.string().optional() }),
    response: z.unknown()
  }),
  setActive: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.unknown()
  }),
  remove: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  // 创建无痕 profile（internal + ephemeral，对齐 RT createIncognito）
  incognito: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown()
  }),
  // 可见 profile 列表（过滤 internal —— 无痕等的空间不外露）
  visible: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.unknown())
  })
})

export { profileSchemas }

