import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface CaptureHubPort {
  open(input?: unknown): Promise<{ ok: boolean; reason?: string }>
  commit(input: unknown): Promise<{ ok: boolean; reason?: string }>
}

export function registerCaptureHubIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, captureHub }: {
    routes: IpcRoutes
    schemas: IpcSchemas['captureHub']
    captureHub?: CaptureHubPort | null
  }
): void {
  if (!captureHub) return
  typedMain.handle(routes.captureHubOpen, {
    requestSchema: schemas.open.request,
    responseSchema: schemas.open.response,
    handler: async (_event, req) => captureHub.open(req || {})
  })
  typedMain.handle(routes.captureHubCommit, {
    requestSchema: schemas.commit.request,
    responseSchema: schemas.commit.response,
    handler: async (_event, req) => captureHub.commit(req)
  })
}
