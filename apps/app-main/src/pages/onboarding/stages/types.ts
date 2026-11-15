/**
 * Onboarding stage contract.
 *
 * The shell owns navigation and persistence boundaries. A stage owns only its
 * mount-scoped DOM and async work. Returning a disposable view keeps every
 * asynchronous operation tied to one mount, so stages can be remounted safely.
 */

import type { USER_SOURCES } from './user-source.js'

export type UserSource = (typeof USER_SOURCES)[keyof typeof USER_SOURCES]

export interface MigrationResult {
  ok: boolean
  count?: number
  cancelled?: boolean
  message: string
  file?: string
  sources?: Record<string, MigrationResult>
}

export interface OnboardingDraft {
  source: UserSource
  themeId: string
  themeName: string
  layout: null | {
    id: string
    label: string
    preset: string
    mode: string
  }
  startupMode: string
  migration: Record<string, MigrationResult | undefined>
}

export interface OnboardingContext {
  rpc: typeof import('hira://shared/runtime.js').rpc
  IPC_ROUTES: typeof import('hira://shared/runtime.js').IPC_ROUTES
  el: typeof import('hira://shared/runtime.js').el
  draft: OnboardingDraft
  sources: typeof USER_SOURCES
  enterFlow: (source?: string) => boolean
  next: () => Promise<void>
  back: () => Promise<void>
  close: () => void
  setBusy: (busy: boolean) => void
  toast: (message?: string) => void
  focusPrimary: () => void
  complete: () => Promise<void>
  /** Runs a stage interaction exclusively; duplicate clicks are ignored. */
  runExclusive: <T>(task: () => Promise<T> | T) => Promise<T | undefined>
}

export interface OnboardingStageView {
  el: HTMLElement
  /** Release listeners, timers and late async DOM writes for this mount. */
  destroy?: () => void
  /** Wait for in-flight work before the shell leaves this step. */
  beforeNext?: () => Promise<void> | void
}

export interface OnboardingStage {
  id: string
  label: string
  hint?: string
  nextLabel?: string
  mount: (context: OnboardingContext) => HTMLElement | OnboardingStageView
  onNext?: (context: OnboardingContext) => boolean | void | Promise<boolean | void>
}
