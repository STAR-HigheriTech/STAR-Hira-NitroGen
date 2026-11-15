import type { LinkIntentEvent } from 'hira://shared/link-intent.mjs'

export interface SectionActionSpec {
  id: string
  label: string
  onClick: () => void
}

export interface SectionAction {
  el: HTMLButtonElement
  setLabel: (label: string) => void
  setHidden: (hidden: boolean) => void
  setActive: (active: boolean) => void
  remove: () => void
}

export interface SectionTabbar {
  addAction: (spec: SectionActionSpec) => SectionAction
}

export interface SectionContext {
  root: HTMLElement
  openUrl: (url: string, event?: LinkIntentEvent) => void
  isActive: () => boolean
  tabbar: SectionTabbar
}

export interface SectionLifecycle {
  destroy?: () => void
  onShow?: () => void
  onHide?: () => void
}

export interface SectionDefinition extends SectionLifecycle {
  id: string
  name: string
  description: string
  mount: (ctx: SectionContext) => SectionLifecycle | void
}

export interface SectionDefinitionInput {
  id: string
  name: string
  mount: SectionDefinition['mount']
  description?: string
  destroy?: () => void
  onShow?: () => void
  onHide?: () => void
}

export interface DeclaredSection {
  id: string
  name: string
  description: string
  load?: () => Promise<unknown>
  mount: SectionDefinition['mount'] | null
}
