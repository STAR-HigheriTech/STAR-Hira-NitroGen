import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

interface PasskeyControllerPort {
  capabilities(): {
    platform: string
    configured: boolean
    accountPicker: boolean
    platformAuthenticator: boolean
    touchId: boolean
    error?: string
  }
  select(requestId: unknown, credentialId: unknown): { ok: boolean; reason?: string }
}

interface PasskeyIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['passkey']
  passkeys?: PasskeyControllerPort | null
}

export function registerPasskeyIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, passkeys }: PasskeyIpcContext
): void {
  if (!passkeys) return

  typedMain.handle(routes.passkeyCapabilities, {
    requestSchema: schemas.capabilities.request,
    responseSchema: schemas.capabilities.response,
    handler: async () => passkeys.capabilities()
  })

  typedMain.handle(routes.passkeySelect, {
    requestSchema: schemas.select.request,
    responseSchema: schemas.select.response,
    handler: async (_event, req) => passkeys.select(req.requestId, req.credentialId)
  })
}
