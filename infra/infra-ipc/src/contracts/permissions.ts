import { z } from 'zod'

const permissionsSchemas = Object.freeze({
  get: Object.freeze({
    request: z.object({ origin: z.string(), permissionType: z.string() }),
    response: z.object({ setting: z.string() })
  }),
  resolveRequest: Object.freeze({
    request: z.object({ origin: z.string(), permissionType: z.string() }),
    response: z.object({ decision: z.enum(['allow', 'block', 'ask', 'unsupported']) })
  }),
  setSite: Object.freeze({
    request: z.object({ origin: z.string(), rules: z.record(z.string(), z.string()) }),
    response: z.object({ ok: z.boolean() })
  }),
  resetSite: Object.freeze({
    request: z.object({ origin: z.string() }),
    response: z.object({ cleared: z.number() })
  }),
  set: Object.freeze({
    request: z.object({ origin: z.string(), permissionType: z.string(), setting: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  remove: Object.freeze({
    request: z.object({ origin: z.string(), permissionType: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  listAll: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.unknown())
  }),
  getSite: Object.freeze({
    request: z.object({ origin: z.string() }),
    response: z.unknown()
  }),
  clearSite: Object.freeze({
    request: z.object({ origin: z.string() }),
    response: z.object({ cleared: z.number() })
  }),
  // ── 类型级默认规则（全局"默认行为"）──
  defaults: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.object({
      permissionType: z.string(),
      setting: z.string(),
      sensitive: z.boolean().optional()
    }))
  }),
  setDefault: Object.freeze({
    request: z.object({ permissionType: z.string(), setting: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  // ── 批量（按类型批量 / 多站点批量清理）──
  setByType: Object.freeze({
    request: z.object({ permissionType: z.string(), setting: z.string() }),
    response: z.object({ changed: z.number() })
  }),
  clearByType: Object.freeze({
    request: z.object({ permissionType: z.string() }),
    response: z.object({ cleared: z.number() })
  }),
  clearSites: Object.freeze({
    request: z.object({ origins: z.array(z.string()) }),
    response: z.object({ cleared: z.number() })
  }),
  respond: Object.freeze({
    request: z.object({ id: z.string(), allow: z.boolean(), persist: z.boolean().optional() }),
    response: z.object({ ok: z.boolean() })
  }),
  pendingList: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.object({
      id: z.string(),
      origin: z.string(),
      type: z.string(),
      sensitive: z.boolean().optional(),
      // 请求归属的标签/窗口（宿主解析 scopeId 得出；无法归属时为 null）。
      // 为什么必须显式声明：zod 默认 strip 未知键，未声明会把归属信息在 IPC 边界丢掉。
      tabId: z.string().nullable().optional(),
      windowId: z.number().nullable().optional()
    }))
  })
})

export { permissionsSchemas }

