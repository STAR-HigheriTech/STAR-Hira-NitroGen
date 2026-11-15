/**
 * IPC · Bookmark 备份 —— 备份特性模块的路由面（见 ../bookmark-backup/）。
 * 与 main/ipc/<domain>.js 同构：只做契约校验 + 委托，零业务逻辑。
 */

import type {
  BookmarkBackupFeature,
  BookmarkBackupResult,
  BookmarkRestoreResult
} from './index'
import type { BackupListEntry } from './BackupStore'

const { createProviderInvoker } = require('../ipc/provider-bridge.js') as {
  createProviderInvoker(providerRegistry: unknown): <T>(
    capability: string,
    fallback: () => T | Promise<T>,
    input: unknown,
    context: unknown
  ) => T | Promise<T>
}

interface BookmarkBackupIpcContext {
  routes: {
    bookmarkBackupList: string
    bookmarkBackupNow: string
    bookmarkBackupRestore: string
  }
  schemas: {
    list: { request: unknown; response: unknown }
    now: { request: unknown; response: unknown }
    restore: { request: unknown; response: unknown }
  }
  bookmarkBackup?: BookmarkBackupFeature | null
  providerRegistry: unknown
}

interface TypedMainPort {
  handle<TResponse, TRequest = undefined>(route: string, definition: {
    requestSchema: unknown
    responseSchema: unknown
    handler: (event: unknown, request: TRequest) => TResponse | Promise<TResponse>
  }): void
}

export function registerBookmarkBackupIpc(
  typedMain: TypedMainPort,
  { routes, schemas, bookmarkBackup, providerRegistry }: BookmarkBackupIpcContext
): void {
  if (!bookmarkBackup) return

  const invoke = createProviderInvoker(providerRegistry)

  typedMain.handle(routes.bookmarkBackupList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => invoke<BackupListEntry[]>('bookmark-backup.list', () => bookmarkBackup.listBackups(), null, undefined)
  })

  typedMain.handle(routes.bookmarkBackupNow, {
    requestSchema: schemas.now.request,
    responseSchema: schemas.now.response,
    handler: async () => invoke<BookmarkBackupResult>('bookmark-backup.now', () => bookmarkBackup.backupNow('manual'), null, undefined)
  })

  typedMain.handle(routes.bookmarkBackupRestore, {
    requestSchema: schemas.restore.request,
    responseSchema: schemas.restore.response,
    handler: async (_event, request: { file: string }) => invoke<BookmarkRestoreResult>(
      'bookmark-backup.restore',
      () => bookmarkBackup.restore(request.file),
      request,
      undefined
    )
  })
}

