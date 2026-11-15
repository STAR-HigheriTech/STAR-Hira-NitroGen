/**
 * IPC · Security 域（TypeScript）—— 崩溃报告 + 证书错误
 *
 * 两件事共用一个性格：**数据只在主进程存在过**。
 *   · 崩溃记录在 Electron crashReporter 里；
 *   · 证书对象只在 `app.on('certificate-error')` 那一次回调里出现，之后只剩
 *     Electron 的证书错误页 —— 主进程必须在回调里把它记下来，否则永远拿不回来。
 *
 * 本文件只做「路由 → 采集端口」的映射：不 import electron、不持有状态。
 * 采集（crashReporter 启动 / certificate-error 监听）留在 APPS 组合根，
 * 因此这份代码在无 Electron 环境下也能单测。
 */

import type { IpcSchemas, IpcTypedMain } from './types'

interface Deps {
  routes?: Record<string, string>
  schemas?: Partial<IpcSchemas['crash'] & IpcSchemas['certificate']>
  isCrashReporterEnabled?: () => boolean
  getCrashReports?: () => Array<{ date: number | null; type: string | null; id: string | null }>
  getCertificateErrors?: () => unknown[]
  /** 站点安全探针（main/site-security.ts）的读取口；未装配时路由不注册 */
  getSiteSecurity?: (req: unknown) => Promise<unknown>
}

/** 崩溃报告：是否启用了 crashReporter + 已记录的崩溃条目。 */
export function registerCrashIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, isCrashReporterEnabled, getCrashReports }: Deps
): void {
  if (!routes?.crashList || !schemas?.list || !getCrashReports) return
  typedMain.handle(routes.crashList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => ({
      // 未启用时如实返回 false —— 页面据此说明「本构建未启用崩溃收集」，
      // 而不是显示一个空列表让用户以为「从没崩溃过」。
      enabled: isCrashReporterEnabled ? Boolean(isCrashReporterEnabled()) : false,
      reports: getCrashReports()
    })
  })
}

/** 证书错误：本会话内发生过的证书校验失败（含证书详情）。 */
export function registerCertificateIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, getCertificateErrors }: Deps
): void {
  if (!routes?.certificateList || !schemas?.list || !getCertificateErrors) return
  typedMain.handle(routes.certificateList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => ({ certificates: getCertificateErrors() })
  })
}

/**
 * 当前站点安全状态（`security:site`）。
 *
 * 与上面两条一样只做路由映射：真正的 CDP 查询在 `main/site-security.ts`，
 * 这里拿到的是「已经解析好的扁平事实」。请求里的 `tabId` 只用于渲染层丢弃
 * 切换标签后迟到的结果，主进程始终以**当前活动标签**为准。
 */
export function registerSiteSecurityIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, getSiteSecurity }: Deps
): void {
  if (!routes?.securitySite || !schemas?.site || !getSiteSecurity) return
  typedMain.handle(routes.securitySite, {
    requestSchema: schemas.site.request,
    responseSchema: schemas.site.response,
    handler: async (_event, req) => getSiteSecurity(req)
  })
}

