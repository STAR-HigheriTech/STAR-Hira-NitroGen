import { z } from 'zod'

/**
 * 网页翻译（C3）契约。
 *
 * 只有一条路由：页面引擎送一批文本，主进程回一批译文。
 * 长度上限与 `shared-types/translate.mjs` 的 `TRANSLATE_LIMITS` 对齐 ——
 * 页面侧已经切过批，这里再卡一道，免得别的调用方一次性推整本书过来。
 */
const translateSchemas = Object.freeze({
  text: Object.freeze({
    request: z.object({
      texts: z.array(z.string().max(16000)).min(1).max(300),
      from: z.string().max(32).optional(),
      to: z.string().min(2).max(12),
      force: z.boolean().optional()
    }),
    // 返回**与入参等长同序**的译文；状态字段只描述本次调度，不改回填协议。
    response: z.object({
      texts: z.array(z.string()),
      provider: z.string().nullable().optional(),
      providerLabel: z.string().nullable().optional(),
      translatedCount: z.number().int().nonnegative().optional(),
      cachedCount: z.number().int().nonnegative().optional(),
      elapsedMs: z.number().nonnegative().optional(),
      error: z.object({
        code: z.string(),
        message: z.string(),
        failures: z.array(z.object({
          provider: z.string(),
          label: z.string(),
          message: z.string()
        }))
      }).optional()
    })
  }),
  target: Object.freeze({
    request: z.object({
      to: z.string().min(2).max(12)
    }),
    response: z.object({
      to: z.string().min(2).max(12)
    })
  })
})

export { translateSchemas }

