/** Shared type boundaries for the new-tab widget system. */

import type { LinkIntentEvent } from 'hira://shared/link-intent.mjs'

export interface Size {
  w: number
  h: number
}

export interface Rect extends Size {
  x: number
  y: number
}

export interface PixelSize {
  w: number
  h: number
  pxW: number
  pxH: number
}

export type BreakpointId = 'wide' | 'narrow'
export type WidgetConfig = Record<string, unknown>
export type LayoutBucket = Record<string, Rect>
export type LayoutMap = Record<BreakpointId, LayoutBucket>

export interface WidgetInstance {
  i: string
  widget: string
}

export interface WidgetState {
  version: number
  seeded: boolean
  instances: WidgetInstance[]
  configs: Record<string, WidgetConfig>
  layouts: LayoutMap
}

export interface WidgetSettingOption {
  value: unknown
  label: string
}

export interface WidgetSetting {
  key: string
  label: string
  type: 'boolean' | 'select' | 'range' | 'number' | 'text'
  default?: unknown | (() => unknown)
  options?: WidgetSettingOption[] | (() => WidgetSettingOption[])
  min?: number
  max?: number
  step?: number
  unit?: string
  hint?: string
  staleDefault?: unknown
}

export interface AppearanceOverride {
  omit?: string[]
  [key: string]: unknown
}

export interface WidgetInstanceHandle {
  destroy?: () => void
  resize?: (size: PixelSize) => void
}

export interface WidgetContext {
  root: HTMLElement
  config: WidgetConfig
  setConfig: (patch: WidgetConfig) => void
  instance: WidgetInstance
  size: PixelSize
  isEditing: () => boolean
  openUrl: (url: string, event?: LinkIntentEvent) => void
}

export interface WidgetDefinition {
  id: string
  name: string
  description: string
  unique: boolean
  hidden: boolean
  removable: boolean
  shape: '' | 'capsule'
  defaultSize: Size
  minSize: Size
  maxSize: Size
  settings: WidgetSetting[]
  appearance?: AppearanceOverride
  create: (ctx: WidgetContext) => WidgetInstanceHandle | void
}

export interface WidgetDefinitionInput {
  id: string
  name: string
  create: WidgetDefinition['create']
  description?: string
  unique?: boolean
  hidden?: boolean
  removable?: boolean
  shape?: '' | 'capsule'
  defaultSize?: Size
  minSize?: Size
  maxSize?: Size
  settings?: WidgetSetting[]
  appearance?: AppearanceOverride
}

export interface BoardPresetItem {
  widget: string
  rect: Rect
}

export interface BoardPreset {
  revision: number
  layout: BoardPresetItem[]
}
