import type { Suggestor, SuggestorFn, SuggestorPhase } from '../types'

export interface DefineSuggestorOptions {
  phase?: SuggestorPhase
  id?: string
}

/** Typed plugin factory. Keeps phase/id metadata attachable without function-property casts. */
export function defineSuggestor(
  suggestor: SuggestorFn,
  options: DefineSuggestorOptions = {}
): Suggestor {
  return Object.assign(suggestor, options)
}
