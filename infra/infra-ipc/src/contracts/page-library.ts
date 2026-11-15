import { z } from 'zod'

const pageLibrarySchemas = Object.freeze({
  archiveList: Object.freeze({ request: z.object({ query: z.string().optional() }).optional(), response: z.array(z.unknown()) }),
  archiveSaveActive: Object.freeze({ request: z.object({}).optional(), response: z.unknown() }),
  archiveGet: Object.freeze({ request: z.object({ id: z.string().min(1) }), response: z.unknown() })
})

export { pageLibrarySchemas }
