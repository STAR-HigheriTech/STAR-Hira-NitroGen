/**
 * Download 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 *
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { DownloadInputs, DownloadService, ServiceRuntimeContext } from './service-contracts'

module.exports = createServicePlugin<DownloadService, DownloadInputs, ServiceRuntimeContext>({
  domain: 'download',
  serviceName: 'downloadService',
  capabilities: {
    'download.create': (svc, input) => svc.create(input),
    'download.updateProgress': (svc, input) => svc.updateProgress(input.id, input.receivedBytes, input.totalBytes),
    'download.complete': (svc, input) => svc.complete(input.id, input.filePath),
    'download.cancel': (svc, input, ctx) => ctx.downloadController ? ctx.downloadController.cancel(input.id) : svc.cancel(input.id),
    'download.list': (svc) => svc.list(),
    'download.get': (svc, input) => svc.get(input.id),
    'download.remove': (svc, input) => svc.remove(input.id),
    'download.removeMany': (svc, input) => svc.removeMany(input.ids),
    'download.clearCompleted': (svc) => svc.clearCompleted(),
    'download.pause': (_svc, input, ctx) => ctx.downloadController ? ctx.downloadController.pause(input.id) : false,
    'download.resume': (_svc, input, ctx) => ctx.downloadController ? ctx.downloadController.resume(input.id) : false,
    'download.open': async (svc, input, ctx) => {
      const item = input.filePath ? input : svc.get(input.id)
      if (!item?.filePath || !ctx.shell) return false
      await ctx.shell.openPath(item.filePath)
      return true
    },
    'download.showInFolder': async (svc, input, ctx) => {
      const item = input.filePath ? input : svc.get(input.id)
      if (!item?.filePath || !ctx.shell) return false
      ctx.shell.showItemInFolder(item.filePath)
      return true
    }
  }
})
