export { createSearchBar, ADDRESS_BAR_SHORTCUTS } from './searchbar'
export { resolveSuggestionAnchor } from './anchor'
export { resolveVerbatimTarget, suggestionToUrl } from './core/navigation'
export { createPhaseGate } from './core/phase-gate'
export { defineSuggestor } from './core/define-suggestor'
export {
  MAX_BANG_SUGGESTIONS,
  MAX_SUGGESTIONS,
  mergeSuggestions,
  sameSuggestion,
  sameSuggestionList,
  selectionKey,
  suggestionTier
} from './core/ranking'
export { createSuggestorRegistry } from './core/registry'
export { collectSuggestions, partitionSuggestors } from './core/suggestor-runner'
export { suggestionField } from './core/suggestion-field'

export { bangsSuggestor, parseBangQuery } from './suggestors/bangs'
export { calcSuggestor } from './suggestors/calc'
export { developmentModeSuggestor } from './suggestors/development-mode'
export { instantAnswerSuggestor } from './suggestors/instant-answer'
export { openTabsSuggestor } from './suggestors/open-tabs'
export { pedalSuggestor } from './suggestors/pedals'
export { remoteSuggestor } from './suggestors/remote'
export { looksLikeUrl, verbatimSuggestor } from './suggestors/verbatim'

export type {
  CalcSuggestion,
  CustomBangInfo,
  DevModeSuggestion,
  FocusSearchbarOptions,
  HideSearchbarOptions,
  InstantAnswerFact,
  InstantAnswerSuggestion,
  MatchMeta,
  OpenTabInfo,
  OpenTabSuggestion,
  PanelInfo,
  PedalSuggestion,
  PluginSuggestion,
  RemoteSuggestionInput,
  SearchBarController,
  SearchBarOptions,
  SearchHistorySuggestion,
  SearchSettings,
  SearchSuggestion,
  SearchbarOverlayAdapter,
  SearchbarOverlayPayload,
  SetQueryOptions,
  Suggestor,
  SuggestorContext,
  SuggestorFn,
  SuggestorPhase,
  Suggestion,
  SuggestionAnchor,
  SuggestionBase,
  WebsiteSuggestion
} from './types'

export type { PhaseGate } from './core/phase-gate'
export type { DefineSuggestorOptions } from './core/define-suggestor'
export type { SuggestorPartition } from './core/suggestor-runner'
export type { SuggestorRegistry } from './core/registry'
export type { AnchorInput, AnchorRect } from './anchor'
