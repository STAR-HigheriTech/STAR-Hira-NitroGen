import type { BrowserImportService } from '../import'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface BrowserImportIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['browserImport']
  browserImport?: BrowserImportService | null
}

/**
 * ipc/browser-import.js — 浏览器一键迁移（Chrome / Edge → Hira）
 *
 * 两条通道都是薄转发：检测与导入的全部逻辑在 `main/import/index.js`。
 * 该服务本身永不抛异常（返回结构化 `{ ok, errors[] }`），这里仍兜一层 ——
 * 让最坏情况也只是「页面收到失败结果」，而不是 IPC 直接 reject。
 */

/**
 * @param {{ handle: Function }} typedMain
 * @param {{ routes: any, schemas: any, browserImport: any }} ctx
 */
export function registerBrowserImportIpc(typedMain: IpcTypedMain, ctx: BrowserImportIpcContext): void {
  const { routes, schemas, browserImport } = ctx || {}
  if (!typedMain || !routes || !schemas || !browserImport) return
  if (typeof browserImport.listSources !== 'function') return

  typedMain.handle(routes.browserImportSources, {
    requestSchema: schemas.sources.request,
    responseSchema: schemas.sources.response,
    handler: async () => {
      try {
        return await browserImport.listSources()
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error('[browser-import] 探测来源失败:', message)
        return { ok: false, sources: [], error: message }
      }
    }
  })

  typedMain.handle(routes.browserImportRun, {
    requestSchema: schemas.run.request,
    responseSchema: schemas.run.response,
    handler: async (_event, req) => {
      try {
        return await browserImport.importFrom(req)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error('[browser-import] 导入失败:', message)
        return {
          ok: false,
          bookmarks: { imported: 0, skipped: 0 },
          history: { imported: 0, skipped: 0 },
          extensions: { imported: 0, skipped: 0 },
          profiles: [],
          errors: [],
          error: message
        }
      }
    }
  })
}

