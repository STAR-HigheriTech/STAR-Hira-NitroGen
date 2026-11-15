const { exportLayoutDocument } = require('@hira-ng/layout-model')
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface LayoutDocumentIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['layoutDocument']
  events?: { layoutDocumentChanged?: string }
  layoutService: MethodPort
  emitToWindow?: (route: string, payload: unknown) => unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/**
 * Layout Studio 文档 IPC。主进程只做作用域解析、持久化命令与窗口级通知；
 * 布局规则全部留在 domain-layout / layout-model。
 */
export function registerLayoutDocumentIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, events, layoutService, emitToWindow }: LayoutDocumentIpcContext
): void {
  if (!layoutService) return

  const changedEvent = (events && events.layoutDocumentChanged) || 'layout-document:changed'

  function notify(layoutValue: unknown, changedNodeIds: unknown[]): void {
    if (typeof emitToWindow !== 'function') return
    const layout = asRecord(layoutValue)
    try {
      emitToWindow(changedEvent, {
        layoutId: layout.id,
        revision: layout.revision,
        changedNodeIds
      })
    } catch (_) {}
  }

  typedMain.handle(routes.layoutDocumentSnapshot, {
    requestSchema: schemas.snapshot.request,
    responseSchema: schemas.snapshot.response,
    handler: async (_event, request) => layoutService.snapshot(request && request.scope)
  })

  typedMain.handle(routes.layoutDocumentDispatch, {
    requestSchema: schemas.dispatch.request,
    responseSchema: schemas.dispatch.response,
    handler: async (_event, request) => {
      const result = asRecord(layoutService.dispatch(request))
      if (result.ok && Array.isArray(result.changedNodeIds) && result.changedNodeIds.length) notify(result.layout, result.changedNodeIds)
      return result
    }
  })

  typedMain.handle(routes.layoutDocumentReplace, {
    requestSchema: schemas.replace.request,
    responseSchema: schemas.replace.response,
    handler: async (_event, request) => {
      const result = asRecord(layoutService.replaceDocument(request))
      if (result.ok) notify(result.layout, Array.isArray(result.changedNodeIds) ? result.changedNodeIds : [])
      return result
    }
  })

  typedMain.handle(routes.layoutDocumentReset, {
    requestSchema: schemas.reset.request,
    responseSchema: schemas.reset.response,
    handler: async (_event, request) => {
      const snapshot = asRecord(layoutService.snapshot(request && request.scope))
      const layout = layoutService.reset(snapshot.scope)
      notify(layout, [])
      return layout
    }
  })

  typedMain.handle(routes.layoutDocumentRestore, {
    requestSchema: schemas.restore.request,
    responseSchema: schemas.restore.response,
    handler: async (_event, request) => {
      const layout = layoutService.restoreRevision(request.layoutId, request.revision)
      if (layout) notify(layout, [])
      return layout
    }
  })

  typedMain.handle(routes.layoutDocumentExport, {
    requestSchema: schemas.export.request,
    responseSchema: schemas.export.response,
    handler: async (_event, request) => {
      const snapshot = asRecord(layoutService.snapshot())
      const snapshotLayout = asRecord(snapshot.layout)
      const target = request.layoutId === snapshotLayout.id
        ? snapshotLayout
        : (Array.isArray(layoutService.list(snapshot.scope)) ? layoutService.list(snapshot.scope) as unknown[] : [])
          .map(asRecord)
          .find((item) => item.id === request.layoutId)
      if (!target) throw new Error('Layout not found')
      return { text: (exportLayoutDocument as (document: unknown) => string)(target.document) }
    }
  })

  typedMain.handle(routes.layoutDocumentImport, {
    requestSchema: schemas.import.request,
    responseSchema: schemas.import.response,
    handler: async (_event, request) => {
      const snapshot = asRecord(layoutService.snapshot(request.scope))
      const layout = layoutService.importLayout(snapshot.scope, request.text)
      layoutService.setBinding(snapshot.scope, asRecord(layout).id)
      notify(layout, [])
      return layout
    }
  })
}


