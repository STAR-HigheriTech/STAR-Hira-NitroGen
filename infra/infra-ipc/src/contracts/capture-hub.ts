import { z } from 'zod'

const source = z.object({
  tabId: z.string(),
  url: z.string().url(),
  title: z.string().max(1000),
  selection: z.string().max(20000),
  kind: z.enum(['page', 'selection', 'link', 'image']).default('page'),
  referer: z.string().url().optional()
})

const captureHubSchemas = Object.freeze({
  open: Object.freeze({
    request: z.object({
      tabId: z.string().optional(),
      url: z.string().url().optional(),
      title: z.string().max(1000).optional(),
      selection: z.string().max(20000).optional(),
      kind: z.enum(['page', 'selection', 'link', 'image']).optional(),
      referer: z.string().url().optional()
    }).optional(),
    response: z.object({ ok: z.boolean(), reason: z.string().optional() })
  }),
  commit: Object.freeze({
    request: z.object({
      target: z.enum(['reading', 'notes', 'bookmark', 'easel']),
      title: z.string().max(200).optional(),
      text: z.string().max(20000).optional(),
      tags: z.array(z.string().max(80)).max(30).optional(),
      source
    }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional() })
  })
})

export { captureHubSchemas }
