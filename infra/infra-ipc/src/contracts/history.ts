import { z } from 'zod'
// 「算不算普通网页」的唯一判据（正文上报只接受 http(s) 地址）。
const { isHttpUrl } = require('@hira-ng/shared-types/src/url-protocols.mjs')

const historySchemas = Object.freeze({
  list: Object.freeze({
    request: z.object({ limit: z.number().int().positive().max(500).optional() }).optional(),
    response: z.array(z.unknown())
  }),
  search: Object.freeze({
    request: z.object({ query: z.string(), limit: z.number().int().positive().max(500).optional() }),
    response: z.array(z.unknown())
  }),
  queryRange: Object.freeze({
    request: z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500).optional()
    }).refine(({ from, to }: { from: number; to: number }) => from <= to),
    response: z.array(z.unknown())
  }),
  remove: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.boolean() })
  }),
  removeMany: Object.freeze({
    request: z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }),
    response: z.object({ removed: z.number().int().nonnegative() })
  }),
  removeBefore: Object.freeze({
    request: z.object({ before: z.number().int().nonnegative() }),
    response: z.object({ removed: z.number().int().nonnegative() })
  }),
  clear: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ cleared: z.number().int().nonnegative() })
  }),
  /**
   * 逐次访问日志（E1 双表）—— 按 historyId 或 url 过滤，游标分页。
   * `before` = 上一页最后一条的 visitedAt；响应的 nextCursor 为 null 表示到底。
   */
  visits: Object.freeze({
    request: z.object({
      historyId: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      limit: z.number().int().positive().max(500).optional(),
      before: z.number().int().nonnegative().optional()
    }).optional(),
    response: z.object({
      items: z.array(z.unknown()),
      nextCursor: z.number().int().nonnegative().nullable()
    })
  }),
  /**
   * E3 正文索引：preload 抽取到的正文上报（页面 → 主进程）。
   * `text` 上限与 preload 侧一致（200k），`url` 必须是普通网页 —— 引擎自己已过滤，
   * 这里仍卡一道，免得别的调用方塞进 hira:// 之类没有正文的地址。
   */
  pageTextCaptured: Object.freeze({
    request: z.object({
      url: z.string().min(1).max(4096).refine((u: string) => isHttpUrl(u)),
      title: z.string().max(2048).optional().default(''),
      text: z.string().min(1).max(200000)
    }),
    response: z.object({ ok: z.boolean() })
  })
})

export { historySchemas }

