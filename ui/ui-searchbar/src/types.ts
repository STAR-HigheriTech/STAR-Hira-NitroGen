/** Shared searchbar contracts. Runtime UI code depends on these types only. */

export interface SuggestionBase {
  type: string
  id?: string
  title?: string
  query?: string
  url?: string
  relevance: number
  source?: string
}

export interface SearchSuggestion extends SuggestionBase {
  type: 'search'
  query: string
  url: string
  custom?: boolean
  bangId?: string
}

export interface SearchHistorySuggestion extends SuggestionBase {
  type: 'search-history'
  id: string
  query: string
}

export interface MatchMeta {
  matchField?: 'url' | 'title'
  urlMatch?: string
}

export interface WebsiteSuggestion extends SuggestionBase, MatchMeta {
  type: 'website'
  title: string
  url: string
  displayUrl?: string
  favicon?: string
  historyId?: string
}

export interface OpenTabSuggestion extends SuggestionBase, MatchMeta {
  type: 'open-tab'
  tabId: string
  title: string
  url: string
  displayUrl?: string
  favicon?: string
}

export interface CalcSuggestion extends SuggestionBase {
  type: 'calc'
  expression: string
  result: string
}

export interface PedalSuggestion extends SuggestionBase {
  type: 'pedal'
  action: string
  title: string
}

export interface InstantAnswerSuggestion extends SuggestionBase {
  type: 'instant-answer'
  kind: 'answer' | 'abstract' | 'related'
  id: string
  title: string
  text?: string
  icon?: string
  provider?: string
  query: string
}

export interface DevModeSuggestion extends SuggestionBase {
  type: 'dev-mode'
  title: string
}

export interface PluginSuggestion extends SuggestionBase {
  type: string
  title: string
  favicon?: string
}

export type Suggestion =
  | SearchSuggestion
  | SearchHistorySuggestion
  | WebsiteSuggestion
  | OpenTabSuggestion
  | CalcSuggestion
  | PedalSuggestion
  | InstantAnswerSuggestion
  | DevModeSuggestion
  | PluginSuggestion

export interface OpenTabInfo {
  tabId: string
  title: string
  url: string
  favicon?: string
}

export interface CustomBangInfo {
  id: string
  trigger: string
  title: string
  url: string
  showSuggestions?: boolean
  hitCount?: number
}

export interface PanelInfo {
  id: string
  title: string
  bangs?: string[]
}

export interface InstantAnswerFact {
  kind: 'answer' | 'abstract' | 'related'
  title: string
  text?: string
  url?: string
  icon?: string
  provider?: string
}

export interface RemoteSuggestionInput {
  type?: string
  id?: string
  title?: string
  query?: string
  url?: string
  action?: string
  relevance?: number
  source?: string
  [key: string]: unknown
}

export interface SuggestorContext {
  query: string
  getOpenTabs: () => OpenTabInfo[]
  navigate: (url: string) => void
  openUrl: (url: string, newTab?: boolean) => void
  searchUrl: (query: string) => string
  getEngines?: () => Record<string, string>
  getCustomBangs?: () => CustomBangInfo[]
  getPanels?: () => PanelInfo[]
  isDevelopmentMode?: () => boolean
  getInstantAnswers?: (query: string, limit?: number) => Promise<InstantAnswerFact[]>
  getDefaultEngine?: () => string
  getRemoteSuggestions?: (query: string) => Promise<RemoteSuggestionInput[]>
}

export type SuggestorPhase = 'fast' | 'slow'
export type SuggestorFn = (context: SuggestorContext) => Suggestion[] | Promise<Suggestion[]>

export type Suggestor = SuggestorFn & {
  readonly phase?: SuggestorPhase
  readonly id?: string
}

export interface SearchSettings {
  suggestionsEnabled?: boolean
  bangsEnabled?: boolean
}

export interface SuggestionAnchor {
  left: number
  top: number
  width: number
  height: number
  align: 'left' | 'right'
}

export interface SearchbarOverlayPayload {
  anchor: SuggestionAnchor
  suggestions: Suggestion[]
  selectedIndex: number
  query: string
}

export interface HideSearchbarOptions {
  keepFocus?: boolean
}

export interface SearchbarOverlayAdapter {
  showSearchbar(payload: SearchbarOverlayPayload): void
  hideSearchbar?: (options?: HideSearchbarOptions) => void
  updateSelection?: (selectedIndex: number) => void
  warmSearchbar?: () => void
}

export interface SearchBarOptions {
  getOpenTabs: () => OpenTabInfo[]
  onCommit: (url: string, openInNewTab?: boolean) => void
  onAction: (action: string) => void
  overlay?: SearchbarOverlayAdapter
  getSearchUrl?: (query: string) => string
  getEngines?: () => Record<string, string>
  getCustomBangs?: () => CustomBangInfo[]
  onBangUsed?: (id: string) => void
  onSearch?: (query: string) => void
  getPanels?: () => PanelInfo[]
  getRemoteSuggestions?: (query: string) => Promise<RemoteSuggestionInput[]>
  onActivateTab?: (tabId: string) => void
  searchSettings?: SearchSettings
  onPasteAndGo?: () => void
  getInstantAnswers?: (query: string, limit?: number) => Promise<InstantAnswerFact[]>
  getDefaultEngine?: () => string
  isDevelopmentMode?: () => boolean
  suggestors?: readonly Suggestor[]
}

export interface FocusSearchbarOptions {
  openSuggestions?: boolean
}

export interface SetQueryOptions {
  /** 标签切换 / 真实导航：允许覆盖仍在保护中的 IME 草稿。 */
  force?: boolean
}

export interface SearchBarController {
  readonly shortcuts: Readonly<{ pasteAndGo: string }>
  setQuery(query: string | null | undefined, options?: SetQueryOptions): void
  submit(text: string): boolean
  focus(options?: FocusSearchbarOptions): void
  releaseFocus(): void
  hide(): void
  refreshSuggestions(): Promise<void>
  getSuggestions(): readonly Suggestion[]
  addSuggestor(suggestor: Suggestor): () => void
  removeSuggestor(suggestor: Suggestor): boolean
  destroy(): void
}
