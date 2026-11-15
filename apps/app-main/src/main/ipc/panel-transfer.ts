/**
 * IPC · 面板换宿主（`panel:transfer` / `panel:transfer-state`）
 *
 * 薄注册器：只做参数搬运，裁决全在 `main/panel-presentation.js`。
 * 与 layout 域分开成文件，是因为它服务的是**任何面板**（下载 / 历史 / AI…），
 * 不是布局自身的职责 —— 布局只管"面板摆在侧栏哪儿"。
 */

import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface PanelPresentationPort {
  detach(panelId: string, state: unknown): { ok?: boolean; windowId?: number; error?: unknown } | null | undefined
  dock(panelId: string, state: unknown): { ok?: boolean; windowId?: number; error?: unknown } | null | undefined
  takeState(panelId: string): unknown
}

interface PanelTransferIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['layout']
  panelPresentation: PanelPresentationPort
}

/**
 * @param {{ handle: Function }} typedMain
 * @param {{
 *   routes: any,
 *   schemas: any,
 *   panelPresentation: { detach: Function, dock: Function, takeState: Function }
 * }} deps
 */
export function registerPanelTransferIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, panelPresentation }: PanelTransferIpcContext
): void {
  typedMain.handle(routes.panelTransfer, {
    requestSchema: schemas.panelTransfer.request,
    responseSchema: schemas.panelTransfer.response,
    handler: async (_e, req) => {
      const panelId = String((req && req.panelId) || '')
      const direction = req && req.direction === 'dock' ? 'dock' : 'detach'
      const res = direction === 'detach'
        ? panelPresentation.detach(panelId, req && req.state)
        : panelPresentation.dock(panelId, req && req.state)
      const out: { ok: boolean; panelId: string; direction: 'dock' | 'detach'; windowId?: number; error?: string } = {
        ok: !!(res && res.ok), panelId, direction
      }
      if (res && typeof res.windowId === 'number') out.windowId = res.windowId
      if (res && res.error) out.error = String(res.error)
      return out
    }
  })

  typedMain.handle(routes.panelTransferState, {
    requestSchema: schemas.panelTransferState.request,
    responseSchema: schemas.panelTransferState.response,
    handler: async (_e, req) => {
      const state = panelPresentation.takeState(String((req && req.panelId) || ''))
      return state == null ? {} : { state }
    }
  })
}

