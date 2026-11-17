import { z } from 'zod'

/**
 * 网页翻译（C3）契约。
 *
 * 页面引擎送一批文本取译文、读取插件页上下文，以及持久化目标语言。
 * 长度上限与 `shared-types/translate.mjs` 的 `TRANSLATE_LIMITS` 对齐 ——
 * 页面侧已经切过批，这里再卡一道，免得别的调用方一次性推整本书过来。
 */
const translateSchemas = Object.freeze({
  text: Object.freeze({
    request: z.object({
      texts: z.array(z.string().max(16000)).min(1).max(1200),
      from: z.string().max(32).optional(),
      to: z.string().min(2).max(12),
      url: z.string().max(4096).optional(),
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
  pageContext: Object.freeze({
    request: z.object({
      url: z.string().max(4096),
      title: z.string().max(1024),
      documentLanguage: z.string().max(32).optional(),
      textSample: z.string().max(4000).optional()
    }),
    response: z.object({
      sourceLanguage: z.string().max(32).nullable(),
      detector: z.object({
        language: z.string().max(32),
        confidence: z.number().min(0).max(1).optional(),
        id: z.string().max(128).optional(),
        label: z.string().max(128).optional()
      }).nullable(),
      policy: z.object({
        includeSelectors: z.array(z.string().max(512)).max(32),
        excludeSelectors: z.array(z.string().max(512)).max(32),
        attributes: z.array(z.enum(['title', 'placeholder', 'aria-label', 'alt'])).max(4),
        id: z.string().max(128).optional(),
        label: z.string().max(128).optional()
      })
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

