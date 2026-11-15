import { shell as electronShell, type Shell } from 'electron'
import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}
interface DownloadIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['downloads']
  downloadService: MethodPort
  downloadController?: MethodPort | null
  getDownloadController?: () => MethodPort | null
  providerRegistry?: ProviderRegistryPort | null
  shell?: Shell
}

export function registerDownloadIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, downloadService, downloadController, getDownloadController, providerRegistry, shell = electronShell }: DownloadIpcContext
): void {
  if (!downloadService) return

  // 控制器会随 profile / session 切换被重建（main.js 的 switchProfile）：
  // IPC 只持有「取当前控制器」的端口，绝不能把注册那一刻的实例钉死在闭包里，
  // 否则切换后图标 / 暂停 / 恢复 / 取消 / 重试都会打到已销毁的旧实例。
  const controller = typeof getDownloadController === 'function'
    ? getDownloadController
    : () => downloadController

  /**
   * 按调用时刻取当前控制器并调它的方法。
   *
   * 这些路由因此**可以无条件注册**：注册阶段只关心「路由/契约在不在」，
   * 不关心「此刻控制器建好没有」—— 拿不到实例就返回中性结果。
   * （用实例做注册门控的旧写法会把「图标/暂停能不能用」绑死在启动时序上。）
   *
   * @param {string} method
   * @param {...any} args
   * @returns {Promise<any>}
   */
  const callController = (method: string, ...args: unknown[]): Promise<unknown> => {
    const current = controller()
    if (!current || typeof current[method] !== 'function') return Promise.resolve(false)
    try {
      return Promise.resolve(current[method]?.(...args)).catch(() => false)
    } catch (_) {
      return Promise.resolve(false)
    }
  }

  const invoke = createProviderInvoker(providerRegistry)

  typedMain.handle(routes.downloadList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => invoke('download.list', () => downloadService.list(), null)
  })

  typedMain.handle(routes.downloadRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => ({ ok: await invoke('download.remove', () => downloadService.remove(req.id), req) })
  })

  if (routes.downloadRemoveMany && schemas.removeMany) {
    typedMain.handle(routes.downloadRemoveMany, {
      requestSchema: schemas.removeMany.request,
      responseSchema: schemas.removeMany.response,
      handler: async (_e, req) => ({ removed: await invoke('download.removeMany', () => downloadService.removeMany(req.ids), req) })
    })
  }

  typedMain.handle(routes.downloadClearCompleted, {
    requestSchema: schemas.clearCompleted.request,
    responseSchema: schemas.clearCompleted.response,
    handler: async () => ({ cleared: await invoke('download.clearCompleted', () => downloadService.clearCompleted(), null) })
  })

  typedMain.handle(routes.downloadOpen, {
    requestSchema: schemas.open.request,
    responseSchema: schemas.open.response,
    handler: async (_e, req) => {
      const ok = await invoke('download.open', async () => {
        const request = req as Record<string, unknown>
        let filePath = typeof request.filePath === 'string' ? request.filePath : ''
        if (!filePath && typeof request.id === 'string') {
          const item = asRecord(await invoke('download.get', () => downloadService.get(request.id), { id: request.id }))
          filePath = typeof item.filePath === 'string' ? item.filePath : ''
        }
        if (!filePath) return false
        await shell.openPath(filePath)
        return true
      }, req, { shell })
      return { ok: Boolean(ok) }
    }
  })

  typedMain.handle(routes.downloadShowInFolder, {
    requestSchema: schemas.showInFolder.request,
    responseSchema: schemas.showInFolder.response,
    handler: async (_e, req) => {
      const ok = await invoke('download.showInFolder', async () => {
        const request = req as Record<string, unknown>
        let filePath = typeof request.filePath === 'string' ? request.filePath : ''
        if (!filePath && typeof request.id === 'string') {
          const item = asRecord(await invoke('download.get', () => downloadService.get(request.id), { id: request.id }))
          filePath = typeof item.filePath === 'string' ? item.filePath : ''
        }
        if (!filePath) return false
        shell.showItemInFolder(filePath)
        return true
      }, req, { shell })
      return { ok: Boolean(ok) }
    }
  })

  typedMain.handle(routes.downloadPause, {
    requestSchema: schemas.pause.request,
    responseSchema: schemas.pause.response,
    handler: async (_e, req) => ({ ok: Boolean(await invoke('download.pause', () => callController('pause', req.id), req, { downloadController: controller() })) })
  })

  typedMain.handle(routes.downloadResume, {
    requestSchema: schemas.resume.request,
    responseSchema: schemas.resume.response,
    handler: async (_e, req) => ({ ok: Boolean(await invoke('download.resume', () => callController('resume', req.id), req, { downloadController: controller() })) })
  })

  typedMain.handle(routes.downloadCancel, {
    requestSchema: schemas.cancel.request,
    responseSchema: schemas.cancel.response,
    handler: async (_e, req) => ({ ok: Boolean(await invoke('download.cancel', () => callController('cancel', req.id), req, { downloadController: controller() })) })
  })

  typedMain.handle(routes.downloadGetFileIcon, {
    requestSchema: schemas.getFileIcon.request,
    responseSchema: schemas.getFileIcon.response,
    handler: async (_e, req) => {
      if (!req || !req.filePath) return { dataUrl: null }
      const dataUrl = await callController('getFileIcon', req.filePath, req.size || 16)
      return { dataUrl: typeof dataUrl === 'string' && dataUrl ? dataUrl : null }
    }
  })

  typedMain.handle(routes.downloadSetRateLimit, {
    requestSchema: schemas.setRateLimit.request,
    responseSchema: schemas.setRateLimit.response,
    handler: async (_e, req) => {
      await callController('setRateLimit', req.bytesPerSec)
      return { ok: true }
    }
  })

  typedMain.handle(routes.downloadGetRateLimit, {
    requestSchema: schemas.getRateLimit.request,
    responseSchema: schemas.getRateLimit.response,
    handler: async () => ({ bytesPerSec: Number(await callController('getRateLimit')) || 0 })
  })

  if (routes.downloadRetry && schemas.retry) {
    typedMain.handle(routes.downloadRetry, {
      requestSchema: schemas.retry.request,
      responseSchema: schemas.retry.response,
      handler: async (_e, req) => ({ ok: Boolean(await invoke('download.retry', () => callController('retry', req.id), req, { downloadController: controller() })) })
    })
  }

  // 活动下载数：红点初始态。事件只在跃迁时发，视图晚订阅时靠这一次读数收敛（无轮询）。
  if (routes.downloadActive && schemas.active) {
    typedMain.handle(routes.downloadActive, {
      requestSchema: schemas.active.request,
      responseSchema: schemas.active.response,
      handler: async () => ({ active: Math.max(0, Number(await callController('activeCount')) || 0) })
    })
  }
}

