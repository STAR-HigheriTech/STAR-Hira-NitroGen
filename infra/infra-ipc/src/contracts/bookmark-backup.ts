import { z } from 'zod'

const bookmarkBackupSchemas = Object.freeze({
  list: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  now: Object.freeze({ request: z.unknown().optional(), response: z.unknown() }),
  restore: Object.freeze({ request: z.object({ file: z.string().min(1) }), response: z.unknown() })
})

export { bookmarkBackupSchemas }

