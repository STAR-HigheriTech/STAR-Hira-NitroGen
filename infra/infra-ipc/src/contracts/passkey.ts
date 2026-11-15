import { z } from 'zod'

const passkeySchemas = Object.freeze({
  capabilities: Object.freeze({
    request: z.object({}).optional(),
    response: z.object({
      platform: z.string(),
      configured: z.boolean(),
      accountPicker: z.boolean(),
      platformAuthenticator: z.boolean(),
      touchId: z.boolean(),
      error: z.string().optional()
    })
  }),
  select: Object.freeze({
    request: z.object({
      requestId: z.string().min(1).max(160),
      credentialId: z.string().max(2048).nullable().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional()
    })
  })
})

export { passkeySchemas }
