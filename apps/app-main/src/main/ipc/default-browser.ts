import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface DefaultBrowserService {
  isDefaultBrowser(): Promise<boolean>
  registerDefaultClient(options: { force: boolean }): Promise<boolean>
  adoptFileAssociationsQuietly(): Promise<{ adopted: string[]; skipped: string[] }>
  openDefaultAppsSettings(): Promise<boolean>
}

interface DefaultBrowserIpcContext { routes: IpcRoutes; schemas: IpcSchemas['app'] }

/**
 * ipc/default-browser.js — 默认浏览器域路由（自包含，不在 ipc-routes.js 里散布）
 *
 * 只有两条通道：查询「是不是系统默认浏览器」、把本应用登记为系统默认浏览器。
 *
 * ── 为什么必须由主进程做 ─────────────────────────────────────────
 * 默认程序 / 文件关联只存在于操作系统里：渲染进程既查不到、也改不了。
 * 真正的实现收在 `main/app/default-client.js`（唯一写入点），这里只做薄转发。
 *
 * ── 为什么 set 返回的是回读结果而不是 true ────────────────────────
 * 点一次按钮会做两件事：把本应用登记成候选（注册表 schema），以及给 `UserChoice`
 * 写合法 Hash **静默接管** `.htm/.html/http/https` 等类型（算法在
 * `main/app/user-choice.js`）。接管可能被组策略 / UCPD 拦掉，所以不能乐观地
 * 宣布成功 —— 登记完 + 接管完，最后如实回读 UserChoice 再返回。
 * 系统设置页照旧打开（用户看得见的确认入口），但不是生效的必要条件。
 *
 * 任何异常都不向渲染层抛出（IPC 抛异常会让设置页整块渲染失败），统一降级为 false。
 */

const {
  isDefaultBrowser,
  registerDefaultClient,
  adoptFileAssociationsQuietly,
  openDefaultAppsSettings
} = require('../app/default-client') as DefaultBrowserService

/**
 * 设置页、AI 与 IPC 共用的默认浏览器动作。
 * 保留原有的“先登记、再打开系统确认入口、最后静默接管并回读”顺序。
 */
export async function applyDefaultBrowser(): Promise<boolean> {
  try {
    await registerDefaultClient({ force: true })
  } catch (e) {
    console.error('[default-browser] 登记默认浏览器失败:', e instanceof Error ? e.message : String(e))
    return false
  }
  await openDefaultAppsSettings()
  try {
    const result = await adoptFileAssociationsQuietly()
    if (result.skipped.length) {
      console.warn('[default-browser] 未能接管:', result.skipped.join(', '))
    }
  } catch (e) {
    console.warn('[default-browser] 静默接管失败:', e instanceof Error ? e.message : String(e))
  }
  try {
    return await isDefaultBrowser()
  } catch (_) {
    return false
  }
}

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any }} ctx
 */
export function registerDefaultBrowserIpc(typedMain: IpcTypedMain, ctx: DefaultBrowserIpcContext): void {
  const { routes, schemas } = ctx || {}
  if (!typedMain || !routes || !schemas || !schemas.isDefaultBrowser) return

  typedMain.handle(routes.appIsDefaultBrowser, {
    requestSchema: schemas.isDefaultBrowser.request,
    responseSchema: schemas.isDefaultBrowser.response,
    handler: async () => {
      try {
        return await isDefaultBrowser()
      } catch (_) {
        return false
      }
    }
  })

  typedMain.handle(routes.appSetDefaultBrowser, {
    requestSchema: schemas.setDefaultBrowser.request,
    responseSchema: schemas.setDefaultBrowser.response,
    handler: () => applyDefaultBrowser()
  })
}

