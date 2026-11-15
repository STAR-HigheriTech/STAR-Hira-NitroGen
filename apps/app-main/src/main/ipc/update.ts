/**
 * IPC · Update 域（TypeScript）—— 软件更新页的四条动作
 *
 * 四条刻意分开：读取快照 / 检查 / 下载 / 安装是四个不同粒度的用户动作。
 * 状态真源只有 `main/update/service.js` 一处；本文件**不持有任何状态**，
 * 只把调用转给服务，并在端口缺失时返回"不支持"的空壳（页面可降级渲染，不整页崩）。
 *
 * 分层：本域不认识 electron / 网络 / 磁盘；服务由 APPS 层注入（getter，晚绑定）。
 */

import type { IpcSchemas, IpcTypedMain } from './types'

interface UpdateSnapshot {
  supported: boolean
  status: string
  currentVersion: string
  channel: 'stable' | 'preview'
  availableVersion: string
  progress: number
  transferred: number
  total: number
  bytesPerSecond: number
  lastCheckAt: number
  message: string
  error: string
}

interface UpdateServicePort {
  getState: () => UpdateSnapshot
  check: (options?: { silent?: boolean }) => Promise<UpdateSnapshot>
  download: () => Promise<UpdateSnapshot>
  install: () => Promise<{ ok: boolean; message?: string }>
}

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['update']
  /** getter：更新服务在 post-ipc 阶段才创建，不能在这里把对象值固定下来。 */
  getUpdateService?: () => UpdateServicePort | null
}

/** 端口缺失时的空壳：字段与服务 getState() 严格同形（契约校验要求全部存在）。 */
const EMPTY_SNAPSHOT: UpdateSnapshot = {
  supported: false,
  status: 'unsupported',
  currentVersion: '',
  channel: 'stable',
  availableVersion: '',
  progress: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  lastCheckAt: 0,
  message: '更新服务未就绪。',
  error: ''
}

export function registerUpdateIpc(typedMain: IpcTypedMain, { routes, schemas, getUpdateService }: Deps): void {
  if (!routes?.updateState || !schemas?.state || !getUpdateService) return

  const resolve = (): UpdateServicePort | null => {
    try {
      return getUpdateService() || null
    } catch (_) {
      return null
    }
  }

  typedMain.handle(routes.updateState, {
    requestSchema: schemas.state.request,
    responseSchema: schemas.state.response,
    handler: async () => {
      const service = resolve()
      return service ? service.getState() : { ...EMPTY_SNAPSHOT }
    }
  })

  if (routes.updateCheck && schemas.check) {
    typedMain.handle(routes.updateCheck, {
      requestSchema: schemas.check.request,
      responseSchema: schemas.check.response,
      handler: async () => {
        const service = resolve()
        if (!service) return { ...EMPTY_SNAPSHOT }
        return service.check({ silent: false })
      }
    })
  }

  if (routes.updateDownload && schemas.download) {
    typedMain.handle(routes.updateDownload, {
      requestSchema: schemas.download.request,
      responseSchema: schemas.download.response,
      handler: async () => {
        const service = resolve()
        if (!service) return { ...EMPTY_SNAPSHOT }
        return service.download()
      }
    })
  }

  if (routes.updateInstall && schemas.install) {
    typedMain.handle(routes.updateInstall, {
      requestSchema: schemas.install.request,
      responseSchema: schemas.install.response,
      handler: async () => {
        const service = resolve()
        if (!service) return { ok: false, message: '更新服务未就绪。' }
        return service.install()
      }
    })
  }
}

