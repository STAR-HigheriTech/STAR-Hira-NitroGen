import type {
  FocusSearchbarOptions,
  SearchBarController,
  SetQueryOptions,
  SearchBarOptions,
  SearchbarOverlayAdapter
} from '@hira-ng/ui-searchbar'

export type HostAxis = 'row' | 'column'
export type SidePosition = 'left' | 'right'
export type RailPosition = 'left' | 'right' | 'top' | 'bottom'
export type WindowControlsHost = 'tabbar' | 'navbar' | 'titlebar'
export type WindowControlsVariant = 'windows' | 'mac'
export type NavigationDirection = 'back' | 'forward'
export type NavigationIntent = 'new-tab'

export interface Point {
  x: number
  y: number
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface PopupAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AnchoredPoint extends Point {
  anchorRect: PopupAnchorRect
}

export interface IconOptions {
  size: number
}

export type IconRenderer = (doc: Document, options: IconOptions) => Element

export interface ActionButtonOptions {
  id?: string
  icon?: IconRenderer | null
  onClick?: (event: MouseEvent) => void | Promise<void>
  title?: string
  size?: number
}

export interface BookmarkStarState {
  visible?: boolean
  active?: boolean
  title?: string
}

export type PwaInstallStatus = 'none' | 'installable' | 'installed'

export interface PwaInstallState {
  state?: PwaInstallStatus
  appId?: string | null
  name?: string | null
  title?: string
}

export interface SiteIdentityState {
  visible?: boolean
  secure?: boolean
  host?: string
  pending?: number
  hasRules?: boolean
  open?: boolean
}

export interface NavStatePatch {
  canGoBack?: boolean
  canGoForward?: boolean
  loading?: boolean
}

export interface NavIntentPayload {
  direction: NavigationDirection
  intent: NavigationIntent
}

export interface NavContextMenuPayload extends Point {
  direction: NavigationDirection
  anchor: RectLike
}

export interface PanelCatalogEntry {
  id: string
  label?: string
  icon?: IconRenderer | null
  segment?: string
}

export type PanelToggleHandler = (panelId: string) => void | Promise<void>

export interface ExtensionActionEntry {
  id: string
  name: string
  icon?: string
  state?: 'active' | 'inactive'
  detail?: string
  badgeText?: string
  badgeColor?: string
}

export interface SideSlots {
  pin?: HTMLElement
  top?: HTMLElement
  dock?: HTMLElement
  bottom?: HTMLElement
}

export interface ToolbarCatalogEntry {
  id: string
  segment?: string
}

export interface ToolbarZoneItem {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface ToolbarZone {
  key: string
  grow: 'left' | 'right'
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
  items: ToolbarZoneItem[]
}

export interface WindowControls {
  readonly element: HTMLElement | null
  readonly minBtn?: HTMLElement | null
  readonly maxBtn: HTMLElement | null
  placeInto(target: Node | null, at?: 'start' | 'end'): void
  setVariant(next: WindowControlsVariant): void
  setMaximized(next: boolean): void
}

export interface NavClusterController {
  element: HTMLElement
  railBtn: HTMLElement
  setRailPosition(position: RailPosition): void
  setRailPinned(pinned: boolean): void
  setNavState(patch?: NavStatePatch): void
}

export interface RailToggleController {
  element: HTMLElement
  setRailPosition(position: RailPosition): void
  setPinned(pinned: boolean): void
}

export interface PanelClusterController {
  element: HTMLElement
  menuBtn: HTMLElement
  render(entries?: PanelCatalogEntry[], onToggle?: PanelToggleHandler): void
  setBadge(panelId: string, on: boolean): void
}

export interface ExtensionActionsController {
  element: HTMLElement
  render(entries?: ExtensionActionEntry[]): void
}

export interface OmniboxController {
  element: HTMLElement
  addressInput: HTMLInputElement
  searchBar: SearchBarController
  setAddress(url: string, options?: SetQueryOptions): void
  focusAddress(options?: FocusSearchbarOptions): void
  releaseAddressFocus(): void
  hideSuggestions(): void
  refreshSuggestions(): Promise<void>
  setBookmarkStar(state?: BookmarkStarState): void
  setPwaInstallState(state?: PwaInstallState): void
  setSiteInfo(state?: SiteIdentityState): void
  getSiteInfoAnchorRect(): RectLike | null
  getSiteInfoElement(): HTMLButtonElement
}

export interface NavbarHandlers {
  windowControlsEnabled?: boolean
  sidebarPosition?: SidePosition
  railPosition?: RailPosition
  searchBar?: Partial<Omit<SearchBarOptions, 'getOpenTabs' | 'onCommit' | 'onAction'>> & {
    getOpenTabs?: SearchBarOptions['getOpenTabs']
    onCommit?: SearchBarOptions['onCommit']
    onAction?: SearchBarOptions['onAction']
  }
  overlay?: SearchbarOverlayAdapter
  onNewTab?: () => void | Promise<void>
  onToggleRail?: () => Promise<{ visible?: boolean; pinned?: boolean } | void> | { visible?: boolean; pinned?: boolean } | void
  onBack?: () => void | Promise<void>
  onForward?: () => void | Promise<void>
  onReload?: () => void | Promise<void>
  onStop?: () => void | Promise<void>
  onHome?: () => void | Promise<void>
  onNavIntent?: (payload: NavIntentPayload) => void
  onNavContextMenu?: (payload: NavContextMenuPayload) => void
  onWindowMinimize?: () => void | Promise<void>
  onWindowMaximize?: () => void | Promise<void>
  onWindowClose?: () => void | Promise<void>
  onMenu?: (event: MouseEvent) => void | Promise<void>
  onPrepare?: (panelId: string) => void
  onExtensionActivate?: (entry: ExtensionActionEntry, position: AnchoredPoint) => void
  onExtensionContextMenu?: (entry: ExtensionActionEntry, position: AnchoredPoint) => void
  onSiteInfo?: () => void
  onSiteIntent?: () => void
  onToggleBookmark?: () => void
  onStarContextMenu?: (event: MouseEvent) => void
  onInstallPwa?: () => void
  onOpenPwa?: (appId: string | null) => void
}

export interface NavbarController {
  tabbar: HTMLElement
  toolbar: HTMLElement
  topRow: HTMLElement
  workspace: HTMLElement
  topRight: HTMLElement | null
  windowControls: WindowControls
  addTabBtn: HTMLButtonElement
  maxBtn: HTMLElement | null
  bottomRow: HTMLElement
  addressInput: HTMLInputElement
  panelButtons: HTMLElement
  searchBar: SearchBarController
  setAddress(url: string, options?: SetQueryOptions): void
  focusAddress(options?: FocusSearchbarOptions): void
  releaseAddressFocus(): void
  hideSuggestions(): void
  refreshSuggestions(): Promise<void>
  setBookmarkStar(state?: BookmarkStarState): void
  setPwaInstallState(state?: PwaInstallState): void
  setSiteInfo(state?: SiteIdentityState): void
  getSiteInfoAnchorRect(): RectLike | null
  getSiteInfoElement(): HTMLButtonElement
  extensionActions: HTMLElement
  renderExtensionActions(entries?: ExtensionActionEntry[]): void
  renderPanelButtons(entries?: PanelCatalogEntry[], onToggle?: PanelToggleHandler): void
  setPanelBadge(panelId: string, on: boolean): void
  setPanelButtonsEditing(active: boolean): void
  applyToolbarOrder(visibleIds: string[] | null | undefined, segments: Record<string, string> | null | undefined): void
  getToolbarZone(): ToolbarZone[]
  mountSpaceSwitcher(element: HTMLElement | null): void
  setLoading(loading: boolean): void
  setNavState(patch?: NavStatePatch): void
  setMaximized(maximized: boolean): void
  mountTabbar(element: HTMLElement | null): void
  setCompactLayout(on: boolean): void
  setSidebarPosition(position: string): void
  setRailPosition(position: string): void
  setRailPinned(pinned: boolean): void
  mountWindowControls(host: string): void
  mountSideTabs(slots: SideSlots | null): void
  setHostAxis(axis: HostAxis): void
}
