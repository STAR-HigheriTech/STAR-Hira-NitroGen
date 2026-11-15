import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface ShareServicePort { qrSvg(text: unknown): string }
interface ShareIpcContext { routes: IpcRoutes; schemas: IpcSchemas['app']; shareService?: ShareServicePort | null }

/**
 * IPC · 分享 / 二维码（N15）
 *
 * 一条只读路由：文本进、SVG 出。分享页（`hira://share`）拿它把当前地址画成二维码。
 * 规则（怎么编码）在 `main/share.js`，这里只做"路由 → 服务方法"的映射 ——
 * 与 default-browser 同一种分工。
 */

/**
 * @param {{ handle:Function }} typedMain
 * @param {{ routes:any, schemas:any, shareService:any }} ctx
 */
export function registerShareIpc(typedMain: IpcTypedMain, ctx: ShareIpcContext): void {
  const { routes, schemas, shareService } = ctx || {}
  if (!typedMain || !shareService || !routes || !schemas || !schemas.qr) return

  typedMain.handle(routes.shareQr, {
    requestSchema: schemas.qr.request,
    responseSchema: schemas.qr.response,
    handler: async (_e, req) => ({ svg: shareService.qrSvg(req && req.text) })
  })
}

