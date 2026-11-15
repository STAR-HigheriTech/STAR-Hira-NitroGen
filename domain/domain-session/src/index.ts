import * as SessionUtil from './sessionUtil'
import { createSessionPersistence } from './sessionPersistence'
import {
  DEFAULT_FILE_NAME,
  DEFAULT_RESTORE_CAP,
  createSessionService
} from './sessionService'

export * from './types'
export * from './schema'
export * from './sessionStore'
export * from './sessionUtil'
export * from './sessionPersistence'
export * from './sessionService'
export { SessionUtil }

export default {
  createSessionService,
  createSessionPersistence,
  DEFAULT_FILE_NAME,
  DEFAULT_RESTORE_CAP,
  ...SessionUtil
}
