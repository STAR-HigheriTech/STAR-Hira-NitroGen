import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface TotpIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['totp']
  totpService: MethodPort
  providerRegistry?: ProviderRegistryPort | null
}

/**
 * TOTP 域 IPC 注册器 —— 与 ipc/notes.js 同构：
 * 每个 handler 走 `invoke(capability, fallback)`，缺插件时回落到域服务直连。
 *
 * ⚠ `invoke` 的第一个参数（能力名）与 `plugins/totp-service.cjs` 的
 * `registerProviders()` 键、以及该插件 manifest 的 `capabilities` 数组**必须逐字一致**。
 * 前两者不一致 → 能力注册了却不生效；与 manifest 不一致 → `plugin:coverage` 会报错
 * （而且"插件被禁用后能力仍可用"——那条脚本的注释解释了为什么这很危险）。
 *
 * ── 关于「插件被禁用时会发生什么」────────────────────────────────────
 * 本注册器的 fallback 只能在**没有任何插件声明该能力**时生效。
 * `totp-service` 一旦被用户（或出厂默认）禁用，`isCapabilityBlocked` 为真 →
 * provider-bridge 直接抛"能力不可用"，**不会**回落到域服务。
 * 这正是想要的语义：**禁用 = 功能真的没了**，而不是"界面入口没了但 IPC 还能调"。
 * 而验证器面板 `dependsOn: totp-service`，服务被禁 → 面板落 blocked → 贡献被摘，
 * 连入口都不会出现在 rail 上。两处合起来 = 一个干净的"可选插件"。
 */
export function registerTotpIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, totpService, providerRegistry }: TotpIpcContext
): void {
  if (!totpService) return

  const invoke = createProviderInvoker(providerRegistry)

  typedMain.handle(routes.totpList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async () => invoke('totp.list', () => totpService.list(), null)
  })

  typedMain.handle(routes.totpCode, {
    requestSchema: schemas.code.request,
    responseSchema: schemas.code.response,
    handler: async (_e, req) => invoke('totp.code', () => totpService.code(req || {}), req || {})
  })

  typedMain.handle(routes.totpAdd, {
    requestSchema: schemas.add.request,
    responseSchema: schemas.add.response,
    handler: async (_e, req) => invoke('totp.add', () => totpService.add(req || {}), req || {})
  })

  typedMain.handle(routes.totpUpdate, {
    requestSchema: schemas.update.request,
    responseSchema: schemas.update.response,
    handler: async (_e, req) => {
      // `id` 是定位，其余都是要改的字段 —— 与 notes 的 `{ id, ...patch }` 同一手法
      const { id, ...patch } = req
      return invoke('totp.update', () => totpService.update(id, patch), req)
    }
  })

  typedMain.handle(routes.totpRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => invoke('totp.remove', () => totpService.remove(req.id), req)
  })

  typedMain.handle(routes.totpImport, {
    requestSchema: schemas.import.request,
    responseSchema: schemas.import.response,
    handler: async (_e, req) => invoke('totp.import', () => totpService.importUris(req || {}), req || {})
  })

  /**
   * ⚠ 这是本域里**唯一**会把密钥交给渲染层的路由（返回含 secret 的 otpauth URI）。
   * 它单独成一条、单独一个响应形状、单独一个能力名 —— 就是为了让它可审计、
   * 将来可单独收紧（例如加二次确认）。改这一支时请保持这个边界。
   */
  typedMain.handle(routes.totpExportUri, {
    requestSchema: schemas.exportUri.request,
    responseSchema: schemas.exportUri.response,
    handler: async (_e, req) => invoke('totp.exportUri', () => totpService.exportUri(req.id), req)
  })

  /**
   * 联网校准本机时钟偏差。`{ reset: true }` = 清掉已保存的偏移。
   * 偏移由主进程保管并持久化，算码时叠加 —— 只影响验证码，不改系统时间。
   */
  typedMain.handle(routes.totpCalibrate, {
    requestSchema: schemas.calibrate.request,
    responseSchema: schemas.calibrate.response,
    handler: async (_e, req) => invoke('totp.calibrate', () => totpService.calibrate(req || {}), req || {})
  })
}

