import { z } from 'zod'

const sessionSchemas = Object.freeze({
  read: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown().nullable()
  }),
  stats: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      tabs: z.number(),
      pinned: z.number(),
      activeIndex: z.number()
    })
  }),
  save: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  }),
  restore: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      restored: z.boolean(),
      activeTabId: z.string().nullable().optional(),
      trimmed: z.boolean().optional()
    })
  }),
  clear: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  }),
  exists: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ exists: z.boolean() })
  }),
  // 「上次关闭」：启动时把上一轮的 session.json 归档成 last-closed.json（同一目录）。
  // 与自动快照的区别是**语义**：自动快照是用户手动的当前镜像，这条是"上次退出时的那一份"。
  lastClosed: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      exists: z.boolean(),
      savedAt: z.number(),
      tabs: z.number(),
      pinned: z.number(),
      items: z.array(z.object({
        title: z.string(),
        url: z.string(),
        favicon: z.string()
      }))
    })
  }),
  lastClosedRestore: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      restored: z.boolean(),
      activeTabId: z.string().nullable().optional(),
      trimmed: z.boolean().optional()
    })
  }),
  lastClosedClear: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean() })
  }),
  // 命名会话 / 会话模板（N14）：把当前标签集存成有名字的快照，之后一键恢复。
  // 存储是设置项 `sessions.named`（随 profile 隔离，不建新表）；恢复是**追加打开**。
  namedList: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ sessions: z.array(z.unknown()) })
  }),
  namedSave: Object.freeze({
    request: z.object({ name: z.string() }),
    response: z.object({
      ok: z.boolean(),
      session: z.unknown().optional(),
      reason: z.string().optional()
    })
  }),
  namedRestore: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({
      ok: z.boolean(),
      opened: z.number().optional(),
      reason: z.string().optional()
    })
  }),
  namedRemove: Object.freeze({
    request: z.object({ id: z.string() }),
    response: z.object({ ok: z.boolean() })
  })
})

export { sessionSchemas }

