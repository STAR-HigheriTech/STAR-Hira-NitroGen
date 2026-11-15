import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface FormFillVaultPort {
  list(): unknown
  add(request: unknown): unknown
  remove(id: unknown): unknown
  reveal(id: unknown): unknown
  options(kind: unknown): unknown
}

interface FormFillIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['app']
  formFillVault?: FormFillVaultPort | null
  isEnabled?: () => boolean
}

/**
 * IPC · 支付卡 / 地址保管库（N7）
 *
 * 四条路由都只是转调 `main/form-fill.js`：
 *   list   —— 只回**摘要**（掩码 / 前几段），渲染层看不到卡号明文
 *   add    —— 加密后落盘
 *   remove —— 删除
 *   reveal —— **显式揭示**单条明文（管理页点"显示 / 复制"时）
 * 明文纪律详见该文件头。
 */

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, formFillVault:any, isEnabled?: () => boolean }} ctx
 */
export function registerFormFillIpc(typedMain: IpcTypedMain, ctx: FormFillIpcContext): void {
  const { routes, schemas, formFillVault, isEnabled } = ctx || {}
  if (!typedMain || !formFillVault || !routes || !schemas) return
  if (!schemas.formFillList || !schemas.formFillAdd || !schemas.formFillRemove || !schemas.formFillReveal) return

  typedMain.handle(routes.formFillList, {
    requestSchema: schemas.formFillList.request,
    responseSchema: schemas.formFillList.response,
    handler: async () => formFillVault.list()
  })

  typedMain.handle(routes.formFillAdd, {
    requestSchema: schemas.formFillAdd.request,
    responseSchema: schemas.formFillAdd.response,
    handler: async (_e, req) => formFillVault.add(req)
  })

  typedMain.handle(routes.formFillRemove, {
    requestSchema: schemas.formFillRemove.request,
    responseSchema: schemas.formFillRemove.response,
    handler: async (_e, req) => formFillVault.remove(req && req.id)
  })

  typedMain.handle(routes.formFillReveal, {
    requestSchema: schemas.formFillReveal.request,
    responseSchema: schemas.formFillReveal.response,
    handler: async (_e, req) => formFillVault.reveal(req && req.id)
  })

  // 「填充候选」：页面侧的地址/卡字段被交互时来问一次。
  // 这是唯一会把**明文**交给渲染层的一条 —— 因此两道闸：设置开关 + 按类型收窄。
  if (!schemas.formFillOptions) return
  typedMain.handle(routes.formFillOptions, {
    requestSchema: schemas.formFillOptions.request,
    responseSchema: schemas.formFillOptions.response,
    handler: async (_e, req) => {
      // 「表单自动填充」关掉 → 一个值都不给（页面侧拿不到候选，自然不弹浮层）。
      if (typeof isEnabled === 'function') {
        let on = false
        try { on = isEnabled() !== false } catch (_) { on = false }
        if (!on) return { items: [] }
      }
      return formFillVault.options(req && req.kind)
    }
  })
}

