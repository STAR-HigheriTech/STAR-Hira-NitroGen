/**
 * Domain: History — public facade.
 *
 * The named export surface remains CommonJS-compatible for the browser host,
 * while every implementation concern lives behind its own typed module.
 */

import * as HistoryUtil from './history-utils'
import { createHistoryService } from './history-service'

export * from './types'
export * from './history-utils'
export * from './drizzle-history-repository'
export * from './drizzle-page-text-repository'
export { createHistoryService }
export { HistoryUtil }

export default {
  createHistoryService,
  ...HistoryUtil
}
