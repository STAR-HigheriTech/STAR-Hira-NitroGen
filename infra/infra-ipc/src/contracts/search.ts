import { z } from 'zod'

const searchSchemas = Object.freeze({
  suggestions: Object.freeze({
    request: z.object({ query: z.string(), limit: z.number().optional() }),
    response: z.array(z.unknown())
  }),
  history: Object.freeze({
    request: z.object({ query: z.string(), limit: z.number().optional() }),
    response: z.array(z.unknown())
  }),
  record: Object.freeze({
    request: z.object({ query: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  removeHistoryEntry: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ removed: z.boolean() })
  }),
  clearHistory: Object.freeze({
    request: z.unknown().optional(),
    // 与设置页 action 字段的返回值约定一致：`{ ok, message }` / `{ ok:false, error }`。
    // 旧的 `{ cleared: n }` 无法直接显示结果提示（设置页只认 ok/message/error）。
    response: z.object({ ok: z.boolean(), message: z.string().optional(), error: z.string().optional() })
  }),
  config: Object.freeze({
    request: z.unknown().optional(),
    response: z.unknown()
  }),
  // 自定义 Bang：`id` 为空即新建；trigger 归一化在 domain 层做（IPC 只约束形状）。
  customBangs: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.unknown())
  }),
  customBangSave: Object.freeze({
    request: z.object({
      id: z.string().optional(),
      trigger: z.string(),
      title: z.string().optional(),
      url: z.string(),
      showSuggestions: z.boolean().optional()
    }),
    // `{ ok:true, entry }` / `{ ok:false, error }` —— 校验失败要就地回显文案
    response: z.object({ ok: z.boolean(), entry: z.unknown().optional(), error: z.string().optional() })
  }),
  customBangRemove: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ removed: z.boolean() })
  }),
  customBangUsed: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.boolean() })
  }),
  // 自定义搜索引擎：与 customBang 结构相似，但**没有 trigger** ——
  // 引擎不是 bang（没有触发词、不进 `!` 列表），入参只有「名称 + URL」。
  engines: Object.freeze({
    request: z.unknown().optional(),
    // `[[id, label], …]`：默认引擎下拉的选项源（`optionsRoute` 消费这个形状）。
    response: z.array(z.array(z.string()))
  }),
  customEngines: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(z.unknown())
  }),
  customEngineSave: Object.freeze({
    request: z.object({
      id: z.string().optional(),
      title: z.string(),
      url: z.string()
    }),
    response: z.object({ ok: z.boolean(), entry: z.unknown().optional(), error: z.string().optional() })
  }),
  customEngineRemove: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    // `defaultReset`：删掉的正好是默认引擎 → 域层回落 google，IPC 额外广播一次默认引擎变更。
    response: z.object({ removed: z.boolean(), defaultReset: z.boolean().optional() })
  }),
  // 即时答案（F-0771~F-0773）：上游失败时 handler 返回空数组，所以 response 恒为数组。
  instantAnswer: Object.freeze({
    request: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(10).optional()
    }),
    response: z.array(z.object({
      kind: z.enum(['answer', 'abstract', 'related']),
      title: z.string(),
      text: z.string().optional(),
      url: z.string().optional(),
      icon: z.string().optional(),
      provider: z.string().optional()
    }))
  })
})

export { searchSchemas }

