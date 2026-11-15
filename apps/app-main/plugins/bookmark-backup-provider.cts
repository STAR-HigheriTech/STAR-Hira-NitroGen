import type { BookmarkBackupServicePort, ServiceRuntimeContext } from './service-contracts'
import type { ProviderExecution } from '@hira-ng/infra-plugin'

function resolveBookmarkBackup(ctx: ServiceRuntimeContext): BookmarkBackupServicePort {
  const services = typeof ctx.getDomainServices === 'function' ? ctx.getDomainServices() : ctx.domainServices
  const bookmarkBackup = services && services.bookmarkBackup
  if (!bookmarkBackup) throw new Error('bookmarkBackup is required by plugin bookmark-backup-provider')
  return bookmarkBackup
}

function createProvider(
  pluginContext: ServiceRuntimeContext,
  capability: string,
  invoke: (bookmarkBackup: BookmarkBackupServicePort, input: unknown) => unknown
) {
  return {
    id: `bookmark-backup.provider.${capability.slice('bookmark-backup.'.length)}`,
    capability,
    metadata: { domain: 'bookmark-backup', plugin: 'bookmark-backup-provider' },
    around(input: unknown, execution?: ProviderExecution) {
      const runtimeContext = execution && execution.context && typeof execution.context === 'object'
        ? { ...pluginContext, ...execution.context }
        : pluginContext
      return invoke(resolveBookmarkBackup(runtimeContext as ServiceRuntimeContext), input)
    }
  }
}

function stopBookmarkBackup(ctx: ServiceRuntimeContext): unknown {
  const bookmarkBackup = resolveBookmarkBackup(ctx)
  bookmarkBackup.flush()
  return bookmarkBackup.stop()
}

module.exports = {
  install(ctx: ServiceRuntimeContext) {
    resolveBookmarkBackup(ctx)
  },
  registerProviders(ctx: ServiceRuntimeContext) {
    return [
      createProvider(ctx, 'bookmark-backup.list', (bookmarkBackup) => bookmarkBackup.listBackups()),
      createProvider(ctx, 'bookmark-backup.now', (bookmarkBackup) => bookmarkBackup.backupNow('manual')),
      createProvider(ctx, 'bookmark-backup.restore', (bookmarkBackup, input) =>
        bookmarkBackup.restore((input as { file: string }).file))
    ]
  },
  registerExtensionPoints(ctx: ServiceRuntimeContext) {
    return [{ name: 'bookmark-backup.service', service: resolveBookmarkBackup(ctx) }]
  },
  enable(ctx: ServiceRuntimeContext) {
    return resolveBookmarkBackup(ctx).start()
  },
  disable(ctx: ServiceRuntimeContext) {
    return stopBookmarkBackup(ctx)
  },
  uninstall(ctx: ServiceRuntimeContext) {
    return stopBookmarkBackup(ctx)
  }
}
