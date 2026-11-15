/**
 * IPC · AppInfo 域（TypeScript）—— 关于页 / 更新页所需的「应用自身事实」
 *
 * 为什么必须由主进程提供：渲染进程只能从 navigator.userAgent 反推 Chromium/Electron
 * 版本，反推不出**应用自身版本**、userData 目录、是否打包运行这些信息。
 * 之前在渲染层「反推 UA」只能得到一半事实，页面上还得写「需要主进程支持」。
 *
 * 全部字段都是只读事实，不做任何推断；端口由 APPS 层注入（本域不认识 electron）。
 */

import type { IpcSchemas, IpcTypedMain } from './types'

interface AppInfoSnapshot {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  osVersion: string
  isPackaged: boolean
  /** 开发态标记：渲染层据此隐藏一切会写系统的关联能力（判据见 app/runtime-mode.js）。 */
  isDevelopment: boolean
  userDataPath: string
  defaultUserAgent: string
}

interface Deps {
  routes?: Record<string, string>
  schemas?: IpcSchemas['app']
  getAppInfo?: () => AppInfoSnapshot | null
}

export function registerAppInfoIpc(typedMain: IpcTypedMain, { routes, schemas, getAppInfo }: Deps): void {
  if (!routes?.appInfo || !schemas?.info || !getAppInfo) return

  typedMain.handle(routes.appInfo, {
    requestSchema: schemas.info.request,
    responseSchema: schemas.info.response,
    handler: async () => {
      const info = getAppInfo()
      // 端口缺失时返回空壳而不是抛错：关于页应能降级渲染，而不是整页崩掉
      return (
        info || {
          name: '',
          version: '',
          electron: '',
          chrome: '',
          node: '',
          v8: '',
          platform: '',
          arch: '',
          osVersion: '',
          isPackaged: false,
          isDevelopment: true,
          userDataPath: '',
          defaultUserAgent: ''
        }
      )
    }
  })
}

