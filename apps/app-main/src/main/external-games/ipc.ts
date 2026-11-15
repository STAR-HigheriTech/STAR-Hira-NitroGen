import { GAME_SCHEME, type GameCatalog, type GameEntry } from './catalog'

const { createProviderInvoker } = require('../ipc/provider-bridge.js') as {
  createProviderInvoker(providerRegistry: unknown): <T>(
    capability: string,
    fallback: () => T | Promise<T>,
    input: unknown,
    context: unknown
  ) => T | Promise<T>
}

interface ExternalGamesRequest { refresh?: boolean }

interface TypedMainPort {
  handle(route: string, definition: {
    requestSchema: unknown
    responseSchema: unknown
    handler: (event: unknown, request: ExternalGamesRequest | undefined) => Promise<{
      scheme: string
      games: GameEntry[]
    }>
  }): void
}

interface ExternalGamesIpcContext {
  routes: { gameList: string }
  schemas: { list: { request: unknown; response: unknown } }
  catalog: GameCatalog
  providerRegistry: unknown
}

export function registerExternalGamesIpc (
  typedMain: TypedMainPort | null | undefined,
  ctx: ExternalGamesIpcContext
): void {
  const { routes, schemas, catalog, providerRegistry } = ctx
  if (!typedMain || !catalog) return

  const invoke = createProviderInvoker(providerRegistry)

  typedMain.handle(routes.gameList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async (_e, req) => ({
      scheme: GAME_SCHEME,
      games: await invoke('external-games.list', () => catalog.list({ refresh: !!(req && req.refresh) }), req, undefined)
    })
  })
}

