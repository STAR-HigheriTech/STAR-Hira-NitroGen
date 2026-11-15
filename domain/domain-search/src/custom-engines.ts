import { customEngines } from '@hira-ng/infra-db/schema'
import { createCustomEntryStore } from './custom-store'
import { createDrizzleCustomEntryRepository } from './drizzle-custom-repository'
import type { CustomEntryStore, SearchDatabase } from './types'

export function createCustomEngineStore(
  db: SearchDatabase,
  options: { profileId?: string } = {}
): CustomEntryStore {
  return createCustomEntryStore(
    createDrizzleCustomEntryRepository(db, customEngines),
    {
      mode: 'engine',
      idPrefix: 'ce',
      profileId: options.profileId || 'default'
    }
  )
}
