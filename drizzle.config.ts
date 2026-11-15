import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './infra/infra-db/src/schema.ts',
  out: './migrations/drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'file:./data/hira-ng.sqlite'
  }
})
