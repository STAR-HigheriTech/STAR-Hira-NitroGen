import { z } from 'zod'

const scopeSchema = z.object({
  profileId: z.string().min(1).optional(),
  spaceId: z.string().optional(),
  context: z.string().min(1).optional()
}).optional()

const layoutRecordSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  spaceId: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['custom', 'template', 'imported']),
  schemaVersion: z.number(),
  revision: z.number(),
  document: z.unknown(),
  createdAt: z.number(),
  updatedAt: z.number()
})

const dispatchResultSchema = z.object({
  ok: z.boolean(),
  layout: layoutRecordSchema,
  changedNodeIds: z.array(z.string()),
  conflict: z.boolean().optional()
})

const layoutDocumentSchemas = Object.freeze({
  snapshot: Object.freeze({
    request: z.object({ scope: scopeSchema }).optional(),
    response: z.object({
      layout: layoutRecordSchema,
      scope: z.object({
        profileId: z.string(),
        spaceId: z.string().optional(),
        context: z.string().optional()
      }),
      restoredDefault: z.boolean()
    })
  }),
  dispatch: Object.freeze({
    request: z.object({
      layoutId: z.string().min(1),
      baseRevision: z.number(),
      command: z.unknown()
    }),
    response: dispatchResultSchema
  }),
  replace: Object.freeze({
    request: z.object({
      layoutId: z.string().min(1),
      baseRevision: z.number(),
      document: z.unknown(),
      action: z.string().optional()
    }),
    response: dispatchResultSchema
  }),
  reset: Object.freeze({
    request: z.object({ scope: scopeSchema }).optional(),
    response: layoutRecordSchema
  }),
  restore: Object.freeze({
    request: z.object({ layoutId: z.string().min(1), revision: z.number() }),
    response: layoutRecordSchema.nullable()
  }),
  export: Object.freeze({
    request: z.object({ layoutId: z.string().min(1) }),
    response: z.object({ text: z.string() })
  }),
  import: Object.freeze({
    request: z.object({ scope: scopeSchema, text: z.string().min(2) }),
    response: layoutRecordSchema
  })
})

export { layoutDocumentSchemas }


