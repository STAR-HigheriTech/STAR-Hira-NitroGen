import { z } from 'zod'

/**
 * Cookie 契约（对齐 Chromium 站点数据管理）。
 *
 * 渲染层只传「域名 / URL / cookie 名」，绝不接触 Session 对象 ——
 * 真正的 session.cookies 调用只发生在主进程 registrar 内。
 */
const cookieItem = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  session: z.boolean(),
  /** 秒级时间戳；session cookie 为 null */
  expirationDate: z.number().nullable()
})

const cookiesSchemas = Object.freeze({
  list: Object.freeze({
    request: z.object({ domain: z.string().optional() }).optional(),
    response: z.object({ cookies: z.array(cookieItem) })
  }),
  remove: Object.freeze({
    request: z.object({ url: z.string().min(1), name: z.string().min(1) }),
    response: z.object({ ok: z.boolean() })
  }),
  clear: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  })
})

export { cookiesSchemas }

