import type { PanelContext } from './panel-context.js'

export interface PanelInstance {
  element: HTMLElement
  refresh?(): unknown
  restore?(state: unknown): unknown
  serialize?(): unknown
  focusSearch?(): unknown
  dispose?(): unknown
}

export type PanelMountResult = PanelInstance | HTMLElement | void

export interface PanelDefinition {
  id: string
  source?: string
  entry?: string
  kind?: string
  mount(doc: Document, ctx: PanelContext): PanelMountResult | Promise<PanelMountResult>
  injectStyles?(doc: Document): void
  [key: string]: unknown
}
