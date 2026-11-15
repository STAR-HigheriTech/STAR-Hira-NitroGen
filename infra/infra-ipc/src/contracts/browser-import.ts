import { z } from 'zod'

/**
 * 浏览器一键迁移（Chrome / Edge → Hira）的 IPC 契约。
 *
 * 两条通道都是**主进程单点判定**：
 *   · sources —— 本机装了哪些浏览器、每个 profile 能搬什么（能力位由 adapter 声明）；
 *   · run     —— 复制 → 解析 → 写入，返回逐 profile 的计数与错误清单。
 * 渲染层不扫描任何目录，也不按浏览器名分支（能力位见 import/capabilities.js）。
 *
 * 响应里的 `ok` 表示「流程无错完成」，不代表「一定有新增」：
 * 重复导入时 imported = 0、skipped = 全部，这仍是成功。
 */
const counters = z.object({
  imported: z.number(),
  skipped: z.number()
})

const profileInfo = z.object({
  id: z.string(),
  name: z.string(),
  capabilities: z.number()
})

const sourceInfo = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  capabilities: z.number(),
  profiles: z.array(profileInfo)
})

const profileResult = z.object({
  id: z.string(),
  name: z.string(),
  bookmarks: counters,
  history: counters,
  extensions: counters
})

const browserImportSchemas = Object.freeze({
  /** 探测本机可用的浏览器与 profile（只读元信息，不读用户数据）。 */
  sources: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      ok: z.boolean(),
      sources: z.array(sourceInfo),
      error: z.string().optional()
    })
  }),
  /** 执行导入。profileIds / datasets 缺省 = 该源下全部。 */
  run: Object.freeze({
    request: z.object({
      sourceId: z.string().min(1),
      profileIds: z.array(z.string()).optional(),
      datasets: z.array(z.enum(['bookmarks', 'history', 'extensions'])).optional()
    }),
    response: z.object({
      ok: z.boolean(),
      sourceId: z.string().optional(),
      bookmarks: counters,
      history: counters,
      extensions: counters,
      profiles: z.array(profileResult).optional(),
      errors: z.array(z.string()).optional(),
      error: z.string().optional()
    })
  })
})

export { browserImportSchemas }

