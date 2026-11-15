import { z } from 'zod'

const externalGamesVariantSchema = z.object({
  name: z.string(),
  entry: z.string(),
  icon: z.string(),
  url: z.string()
})

const externalGamesGameSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  icon: z.string(),
  accent: z.string(),
  tags: z.array(z.string()),
  entry: z.string(),
  url: z.string(),
  variants: z.array(externalGamesVariantSchema),
  source: z.string(),
  license: z.string()
})

const externalGamesSchemas = Object.freeze({
  list: Object.freeze({
    request: z.object({ refresh: z.boolean().optional() }).optional(),
    response: z.object({ scheme: z.string(), games: z.array(externalGamesGameSchema) })
  })
})

export { externalGamesSchemas }

