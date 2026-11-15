import { z } from 'zod'

/**
 * NTP 快速拨号契约。
 * 单个站点：{ id, title, url }。数据以数组形式持久化在设置键 app.speed_dial 下，
 * 由主进程 domain-settings 统一存储（本契约只描述 IPC 通道形状，不含业务）。
 */
const siteSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string()
})

const ntpSchemas = Object.freeze({
  list: Object.freeze({ request: z.object({}).optional(), response: z.array(siteSchema) }),
  add: Object.freeze({ request: z.object({ title: z.string(), url: z.string() }), response: z.object({ ok: z.boolean(), id: z.string() }) }),
  remove: Object.freeze({ request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) }),
  rename: Object.freeze({ request: z.object({ id: z.string(), title: z.string() }), response: z.object({ ok: z.boolean() }) })
})

export { ntpSchemas }
