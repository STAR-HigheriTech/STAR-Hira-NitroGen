/**
 * Central authorization policy for renderer IPC routes.
 *
 * Sender trust and route admission are deliberately separate decisions:
 * a first-party renderer is not automatically allowed to address an arbitrary
 * channel, and a channel listed in the contract is not reachable from an
 * untrusted frame. Keeping both checks here gives every transport (typed
 * invoke, raw send, event subscription) the same fail-closed rule.
 */

import { isKnownEvent } from '@hira-ng/shared-types/src/event-catalog.mjs'
import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { PRELOAD_EVENTS, PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload.mjs'
import { ipcSenderSurface, type IpcSenderSurface } from './ipc-sender-trust'

type SenderClassifier = (event: unknown) => IpcSenderSurface

export interface IpcRoutePolicyOptions {
  classifySender?: SenderClassifier
  invokeRoutes?: Iterable<unknown>
  webPreloadInvokeRoutes?: Iterable<unknown>
  webPreloadEventRoutes?: Iterable<unknown>
  eventRouteExists?: (route: string) => boolean
}

export interface IpcRoutePolicy {
  authorizeSender(event: unknown): boolean
  authorizeInvoke(event: unknown, route: string): boolean
  authorizeEventSubscription(event: unknown, route: string): boolean
  normalizeInvokeRequest(event: unknown, route: string, request: unknown): unknown
}

function routeSet(routes: Iterable<unknown>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const route of routes) {
    if (typeof route === 'string' && route.trim()) out.add(route)
  }
  return out
}

/**
 * Routes invoked by the tab preload itself. They are not a public page bridge:
 * the page cannot reach ipcRenderer across context isolation. Keep this list
 * explicit so adding an internal route never silently grants it to every site.
 */
const WEB_PRELOAD_INVOKE_ROUTES = routeSet([
  PRELOAD_ROUTES.settingsGet,
  PRELOAD_ROUTES.themeTokens,
  PRELOAD_ROUTES.filesDrop,
  PRELOAD_ROUTES.pageTextCaptured,
  PRELOAD_ROUTES.translateText,
  PRELOAD_ROUTES.translateTarget,
  PRELOAD_ROUTES.automationGesture,
  PRELOAD_ROUTES.automationGestureMap,
  PRELOAD_ROUTES.formFillOptions,
  PRELOAD_ROUTES.passwordBackends,
  PRELOAD_ROUTES.passwordGetSuggestions,
  PRELOAD_ROUTES.passwordSave,
  PRELOAD_ROUTES.passwordNeverSaveAdd,
  PRELOAD_ROUTES.passwordNeverSaveList,
  PRELOAD_ROUTES.passwordAutofillMenu,
  PRELOAD_ROUTES.passwordCaptured,
  PRELOAD_ROUTES.passwordOverlayCommit,
  PRELOAD_ROUTES.userscriptGmRequest
])

/** Events consumed by tab-injected preload engines; application/UI events stay internal. */
const WEB_PRELOAD_EVENT_ROUTES = routeSet([
  PRELOAD_EVENTS.themeChanged,
  PRELOAD_EVENTS.translatePage,
  PRELOAD_EVENTS.spatialNav,
  PRELOAD_EVENTS.passwordAutofillMenuSelect,
  PRELOAD_EVENTS.passwordOverlayHidden,
  PRELOAD_EVENTS.automationGesturesConfig,
  PRELOAD_EVENTS.generatePassword
])

/** Routes whose hostname must come from the sender document, never from page input. */
const WEB_PRELOAD_HOSTNAME_ROUTES = routeSet([
  PRELOAD_ROUTES.passwordGetSuggestions,
  PRELOAD_ROUTES.passwordSave,
  PRELOAD_ROUTES.passwordNeverSaveAdd,
  PRELOAD_ROUTES.passwordAutofillMenu,
  PRELOAD_ROUTES.passwordCaptured
])

/**
 * Build the policy from ports so callers/tests can replace the transport
 * authenticator without coupling this module to Electron.
 */
export function createIpcRoutePolicy(options: IpcRoutePolicyOptions = {}): IpcRoutePolicy {
  const classifySender = options.classifySender || ipcSenderSurface
  const invokeRoutes = routeSet(options.invokeRoutes || Object.values(IPC_ROUTES))
  const webInvokeRoutes = routeSet(options.webPreloadInvokeRoutes || WEB_PRELOAD_INVOKE_ROUTES)
  const webEventRoutes = routeSet(options.webPreloadEventRoutes || WEB_PRELOAD_EVENT_ROUTES)
  const eventRouteExists = options.eventRouteExists || isKnownEvent

  function senderSurface(event: unknown): IpcSenderSurface {
    try {
      return classifySender(event)
    } catch (_) {
      return 'untrusted'
    }
  }

  function senderFrameUrl(event: unknown): string {
    if (!event || typeof event !== 'object') return ''
    const frame = (event as { senderFrame?: { url?: unknown; detached?: unknown } | null }).senderFrame
    return frame && frame.detached !== true ? String(frame.url || '') : ''
  }

  return {
    authorizeSender(event) {
      const surface = senderSurface(event)
      return surface === 'trusted-ui' || surface === 'web-preload'
    },
    authorizeInvoke(event, route) {
      if (typeof route !== 'string' || !invokeRoutes.has(route)) return false
      const surface = senderSurface(event)
      if (surface === 'trusted-ui') return true
      return surface === 'web-preload' && webInvokeRoutes.has(route)
    },
    authorizeEventSubscription(event, route) {
      if (typeof route !== 'string') return false
      try {
        if (eventRouteExists(route) !== true) return false
      } catch (_) {
        return false
      }
      const surface = senderSurface(event)
      if (surface === 'trusted-ui') return true
      return surface === 'web-preload' && webEventRoutes.has(route)
    },
    normalizeInvokeRequest(event, route, request) {
      if (senderSurface(event) !== 'web-preload' || !WEB_PRELOAD_HOSTNAME_ROUTES.has(route)) return request
      let hostname = ''
      try {
        const url = new URL(senderFrameUrl(event))
        if (url.protocol === 'http:' || url.protocol === 'https:') hostname = url.hostname.toLowerCase()
      } catch (_) {}
      if (!hostname) throw new Error(`IPC route ${route} requires an http(s) sender origin`)
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error(`IPC route ${route} requires an object payload`)
      }
      return { ...(request as Record<string, unknown>), hostname }
    }
  }
}

export const ipcRoutePolicy = createIpcRoutePolicy()
