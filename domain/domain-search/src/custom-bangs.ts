import { customBangs } from '@hira-ng/infra-db/schema'
import { createCustomEntryStore } from './custom-store'
import { createDrizzleCustomEntryRepository } from './drizzle-custom-repository'
import type { CustomEntryStore, SearchDatabase } from './types'

export function createCustomBangStore(
  db: SearchDatabase,
  options: { profileId?: string } = {}
): CustomEntryStore {
  return createCustomEntryStore(
    createDrizzleCustomEntryRepository(db, customBangs),
    {
      mode: 'bang',
      idPrefix: 'cb',
      profileId: options.profileId || 'default'
    }
  )
}
