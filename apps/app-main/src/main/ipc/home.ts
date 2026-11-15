/**
 * ipc/home.ts — 主页 / 新标签页地址域路由（自包含，不在 ipc-routes.ts 里散布）
 *
 * 地址解析唯一收敛在 `main/home-url.js`：
 *   · `resolveHomeUrl`   —— 纯净设置口径（「主页」语义）；
 *   · `resolveNewTabUrl` —— 真正落进新标签的地址（含扩展的 `chrome_url_overrides.newtab`）。
 *
 * 为什么必须有一条专用通道：壳层「主页」按钮若在渲染层用 settings 自行拼一遍
 * 地址，就会出现「按钮跳的地址和启动页不一致」的两套真源。这里只把主进程
 * 解析出的结果以 `home:url` 暴露出去 —— 本注册器不含任何业务逻辑。
 *
 * `newTabUrl` 单列一个字段（而不是直接替换 `url`）的原因：
 *   · `url` 是「主页」语义，地址栏「这一页算不算新标签页」的比对基准要用它；
 *   · `newTabUrl` 是运行时事实（扩展覆盖随安装 / 启停变化），地址栏留空与主页按钮要用它。
 * 两者的差别恰好就是「有没有扩展覆盖」，所以必须分别下发，不能让渲染层去猜。
 */

import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

const { resolveHomeUrl, resolveNewTabUrl } = require('../home-url.js') as {
  resolveHomeUrl(settings: HomeSettingsPort): string
  resolveNewTabUrl(settings: HomeSettingsPort, options?: { incognito?: boolean; profileId?: string }): string
}

interface HomeSettingsPort { get(key: string): unknown }
interface HomeIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['home']
  settingsService: HomeSettingsPort
  isIncognito?(): boolean
}

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, settingsService:any, isIncognito?:() => boolean }} ctx
 *   `isIncognito` 由 ipc-routes 注入（按**发起窗口**解析）。无痕窗口的新标签页
 *   必须是内置页 —— 它的会话不加载扩展，覆盖地址在那里只会报 ERR_FILE_NOT_FOUND。
 */
export function registerHomeIpc(typedMain: IpcTypedMain, ctx: HomeIpcContext): void {
  const { routes, schemas, settingsService, isIncognito } = ctx
  if (!typedMain || !settingsService) return

  typedMain.handle(routes.homeUrl, {
    requestSchema: schemas.url.request,
    responseSchema: schemas.url.response,
    handler: () => {
      let incognito = false
      try { incognito = typeof isIncognito === 'function' ? Boolean(isIncognito()) : false } catch (_) {}
      return {
        url: resolveHomeUrl(settingsService),
        newTabUrl: resolveNewTabUrl(settingsService, { incognito })
      }
    }
  })
}

