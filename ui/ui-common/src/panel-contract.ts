/**
 * Shared renderer contracts for side panels and panel-like windows.
 *
 * Runtime stays free of this module: `import type` consumers erase every symbol.
 * Hosts own transport and persistence; panels only receive the ports declared here.
 */

export type MaybePromise<T> = T | Promise<T>

export interface PanelIntent {
  type: string
  [key: string]: unknown
}

export interface PanelConfirmOptions {
  title?: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

/** Clients are opaque to the shared shell; each panel narrows the ports it consumes. */
export type PanelClientMethod = (...args: never[]) => unknown
export type PanelClient = Record<string, PanelClientMethod>
export type PanelClients = Record<string, PanelClient>

export interface PanelSlotsPort {
  call?: (slotId: string, payload?: unknown, fallback?: unknown) => unknown
}

export interface PanelContext {
  /** User intent leaves the view through this single port. */
  onIntent?: (intent: PanelIntent) => MaybePromise<void>
  /** Host-owned API clients. Panels never know IPC channel names. */
  clients?: PanelClients
  /** Renderer-side extension-point bridge. */
  slots?: PanelSlotsPort
  events?: Record<string, string>
  on?: (event: string, listener: (payload: unknown) => void) => (() => void) | void
  confirm?: (options: PanelConfirmOptions | string) => Promise<boolean> | boolean
  createIcon?: ((name: string, size?: number) => Element | null) | null
  loadFileIcon?: (filePath: string, size: number) => Promise<string | null>
  openPage?: (url: string) => unknown
  openWindow?: (type: string, payload?: unknown) => unknown
  [port: string]: unknown
}

export interface PanelInstance {
  element: HTMLElement
  refresh?: () => MaybePromise<void>
  setItems?: (items: unknown[]) => void
  focusSearch?: () => boolean
  dispose?: () => void
  [capability: string]: unknown
}

export interface PanelDefinition<
  TContext extends PanelContext = PanelContext,
  TInstance extends PanelInstance = PanelInstance
> {
  id: string
  injectStyles?: (doc: Document) => void
  mount: (doc: Document, ctx: TContext) => MaybePromise<TInstance>
}

export interface WindowDefinition {
  id: string
  injectStyles?: (doc: Document) => void
  mount: (doc: Document, ctx: PanelContext) => MaybePromise<PanelInstance>
}
