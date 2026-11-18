import { protocol, type Session } from 'electron'
import {
  RT_BROWSER_SCHEME,
  RT_COMPAT_SCHEMES,
  RT_EXTERNAL_SCHEME,
  RT_INTERNAL_SCHEME
} from './rt-protocol-constants'

type RequestHandler = (request: Request) => Promise<Response>

interface RtProtocolCompatibilityOptions {
  serveHira(request: Request): Promise<Response>
  serveGame(request: Request): Promise<Response>
}

export interface RtProtocolCompatibility {
  registerOn(session?: Session): void
}

const PAGE_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  'new-tab': 'new-tab',
  error: 'error',
  about: 'about',
  games: 'games',
  extensions: 'extensions',
  history: 'history',
  'pdf-viewer': 'pdf-viewer',
  omnibox: 'command-palette'
})

const INTERNAL_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  settings: 'settings',
  onboarding: 'onboarding',
  omnibox: 'command-palette'
})

const GAME_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  'dino.chrome.game': 'dino',
  'v1.surf.edge.game': 'surf-v1',
  'v2.surf.edge.game': 'surf-v2'
})

function requestHeaders(request: Request): Headers {
  try {
    return new Headers(request.headers)
  } catch (_) {
    return new Headers()
  }
}

function copyAliasHeader(response: Response, target: string): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Hira-RT-Alias', target)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function mappedUrl(source: URL, targetScheme: string, targetHost: string): string {
  const target = new URL(`${targetScheme}://${targetHost}${source.pathname}`)
  target.search = source.search
  target.hash = source.hash
  return target.href
}

function createPageAliasHandler(
  hosts: Readonly<Record<string, string>>,
  serveHira: RequestHandler
): RequestHandler {
  return async function handlePageAlias(request: Request): Promise<Response> {
    const source = new URL(request.url)
    const targetHost = hosts[source.hostname.toLowerCase()]
    if (!targetHost) {
      const error = new URL('hira://error')
      error.searchParams.set('errorCode', '-300')
      error.searchParams.set('url', request.url)
      error.searchParams.set('initial', '1')
      const response = await serveHira(new Request(error.href, {
        method: 'GET',
        headers: requestHeaders(request)
      }))
      return copyAliasHeader(response, error.href)
    }
    const target = mappedUrl(source, 'hira', targetHost)
    const response = await serveHira(new Request(target, {
      method: 'GET',
      headers: requestHeaders(request)
    }))
    return copyAliasHeader(response, target)
  }
}

function createGameAliasHandler(
  serveGame: RequestHandler
): RequestHandler {
  return async function handleGameAlias(request: Request): Promise<Response> {
    const source = new URL(request.url)
    const gameId = GAME_HOSTS[source.hostname.toLowerCase()]
    if (!gameId) return new Response('Not Found', { status: 404 })
    const target = mappedUrl(source, 'hira-game', gameId)
    const response = await serveGame(new Request(target, {
      method: 'GET',
      headers: requestHeaders(request)
    }))
    return copyAliasHeader(response, target)
  }
}

export function createRtProtocolCompatibility(
  options: RtProtocolCompatibilityOptions
): RtProtocolCompatibility {
  const handlers: Readonly<Record<string, RequestHandler>> = Object.freeze({
    [RT_BROWSER_SCHEME]: createPageAliasHandler(PAGE_HOSTS, options.serveHira),
    [RT_INTERNAL_SCHEME]: createPageAliasHandler(INTERNAL_HOSTS, options.serveHira),
    [RT_EXTERNAL_SCHEME]: createGameAliasHandler(options.serveGame)
  })
  const registeredSessions = new WeakMap<Session, Set<string>>()
  const registeredDefault = new Set<string>()

  function registerOn(session?: Session): void {
    if (session) {
      let registered = registeredSessions.get(session)
      if (!registered) {
        registered = new Set()
        registeredSessions.set(session, registered)
      }
      for (const scheme of RT_COMPAT_SCHEMES) {
        if (registered.has(scheme)) continue
        registered.add(scheme)
        session.protocol.handle(scheme, handlers[scheme])
      }
      return
    }
    for (const scheme of RT_COMPAT_SCHEMES) {
      if (registeredDefault.has(scheme)) continue
      registeredDefault.add(scheme)
      protocol.handle(scheme, handlers[scheme])
    }
  }

  return { registerOn }
}
