/**
 * Domain: Search — public facade.
 *
 * Named exports preserve the existing CommonJS surface while the implementation
 * is split into typed, independently replaceable modules.
 */

import * as SearchUtil from './searchUtil'
import { createSearchService } from './search-service'

export * from './types'
export * from './searchUtil'
export * from './ranking'
export {
  createCustomEntryStore,
  normalizeTrigger,
  normalizeUrl,
  isValidUrlTemplate,
  triggerFromTitle,
  hostFromUrl
} from './custom-store'
export * from './custom-bangs'
export * from './custom-engines'
export * from './search-history-store'
export * from './provider-registry'
export * from './providers'
export { createSearchService }
export { SearchUtil }

export default {
  createSearchService,
  ...SearchUtil
}
