import {
  applyLayoutCommand,
  cloneDocument,
  createBlock,
  createDefaultLayoutDocument,
  createFrame,
  findNode,
  findParent,
  getChildren,
  walkNodes,
  type LayoutCommand,
  type LayoutDocument,
  type LayoutFrame,
  type LayoutNode,
  type NodeVisibility
} from '@hira-ng/layout-model'
import { buildMiniMap, type ResolvedNode } from '@hira-ng/layout-engine'

export type StudioFamily =
  | 'templates'
  | 'layout'
  | 'controls'
  | 'tabs'
  | 'panels'
  | 'bookmarks'
  | 'content'

export interface StudioBlockDescriptor {
  id: string
  label: string
  description?: string
  family: StudioFamily
  icon?: (doc: Document, options: { size?: number }) => Node | null
  allowedParents?: LayoutFrame['role'][]
  singleton?: boolean
  available?: boolean
  source?: string
  legacy?: {
    surface?: 'navbar' | 'rail'
    itemId?: string
    segment?: string
  }
}

export interface LayoutStudioOptions {
  document: LayoutDocument
  blocks: StudioBlockDescriptor[]
  viewport?: { width: number; height: number }
  onChange?: (document: LayoutDocument, detail: { command: LayoutCommand | null; changedNodeIds: string[] }) => void
  onSave?: (document: LayoutDocument) => void | Promise<void>
  onExit?: () => void
  renderIcon?: (name: string, doc: Document, options: { size?: number }) => Node | null
}

export interface LayoutStudio {
  element: HTMLElement
  getDocument(): LayoutDocument
  setDocument(document: LayoutDocument): void
  setBlocks(blocks: StudioBlockDescriptor[]): void
  setStatus(text: string, tone?: 'neutral' | 'ok' | 'warn'): void
  undo(): boolean
  redo(): boolean
  destroy(): void
}

export interface QuickLayoutItemDescriptor {
  id: string
  label: string
  segment?: string
  removable?: boolean
  icon?: (doc: Document, options: { size?: number }) => Node | null
}

export interface QuickLayoutZoneItem {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface QuickLayoutZone {
  key: string
  surface?: string
  label?: string
  rect: { x: number; y: number; width: number; height: number }
  hitRect?: { x: number; y: number; width: number; height: number }
  items?: QuickLayoutZoneItem[]
  grow?: string
  axis?: 'row' | 'column'
}

export interface QuickLayoutSurface {
  id: string
  label: string
  areas: Array<{ key: string; label: string }>
}

export interface QuickLayoutState {
  byArea: Record<string, string[]>
  hidden: string[]
  compact?: boolean
}

export interface QuickLayoutBarSettingOption {
  value: string
  label: string
}

export interface QuickLayoutBarSetting {
  key: string
  label: string
  type: 'select' | 'toggle'
  value: string | boolean
  options?: QuickLayoutBarSettingOption[]
  description?: string
  disabled?: boolean
  disabledReason?: string
}

export interface QuickLayoutBarDescriptor {
  id: string
  label: string
  description?: string
  settings: QuickLayoutBarSetting[]
}

export interface QuickLayoutEditorOptions {
  surfaces: QuickLayoutSurface[]
  catalog: QuickLayoutItemDescriptor[]
  states: Record<string, QuickLayoutState>
  bars?: QuickLayoutBarDescriptor[]
  onCommit: (surfaceId: string, state: QuickLayoutState) => void | Promise<void>
  onBarSettingChange?: (
    barId: string,
    settingKey: string,
    value: string | boolean
  ) => void | Promise<void>
  windowControlsHost?: string
  windowControlsHostOptions?: Array<{ value: string; label: string }>
  windowControlsHostHint?: string
  onWindowControlsHostChange?: (host: string) => void | Promise<void>
  onFinish: () => void
  onTemplate?: (templateId: 'classic' | 'sidebar' | 'all-in-one' | 'focus') => void | Promise<void>
  onDragState?: (dragging: boolean) => void
}

export interface QuickLayoutEditor {
  element: HTMLElement
  setZones(payload: { surface: string; segments: QuickLayoutZone[] }): void
  setState(surfaceId: string, state: QuickLayoutState): void
  setBarSettings(bars: QuickLayoutBarDescriptor[]): void
  setStatus(text: string, tone?: 'neutral' | 'ok' | 'warn'): void
  destroy(): void
}

interface QuickDropPosition {
  id: string
  x: number
  y: number
  width: number
  height: number
}

interface QuickDrag {
  surface: string
  id: string
  from: 'zone' | 'tray'
  zone: string | null
  chip: HTMLElement
  visual: HTMLElement
  ghost: HTMLElement | null
  startX: number
  startY: number
  x: number
  y: number
  offsetX: number
  offsetY: number
  pointerId: number
  active: boolean
  raf: number
  activationRaf: number
  caret: HTMLElement | null
  dropPreview: HTMLElement | null
  tray: HTMLElement | null
  trayRect: DOMRect | null
  previewStyleKey: string
  caretStyleKey: string
  positionsCache: Map<string, QuickDropPosition[]>
}

export function createQuickLayoutEditor(options: QuickLayoutEditorOptions): QuickLayoutEditor {
  const doc = document
  const root = html(doc, 'div', 'hqe')
  root.dataset.category = 'bars'
  const zones = new Map<string, QuickLayoutZone[]>()
  const surfaces = options.surfaces.map((surface) => ({
    ...surface,
    areas: surface.areas.map((area) => ({ ...area }))
  }))
  const states = Object.fromEntries(
    Object.entries(options.states).map(([key, value]) => [
      key,
      {
        byArea: Object.fromEntries(Object.entries(value.byArea).map(([area, ids]) => [area, ids.slice()])),
        hidden: value.hidden.slice(),
        compact: value.compact === true
      }
    ])
  ) as Record<string, QuickLayoutState>
  let catalog = new Map(options.catalog.map((item) => [item.id, item]))
  let barSettings = (options.bars || []).map((bar) => ({
    ...bar,
    settings: bar.settings.map((setting) => ({
      ...setting,
      options: setting.options?.map((option) => ({ ...option }))
    }))
  }))
  const initialStates = copyStates(states)
  const undoStack: Array<Record<string, QuickLayoutState>> = []
  const redoStack: Array<Record<string, QuickLayoutState>> = []
  let drag: QuickDrag | null = null
  let destroyed = false
  const drawerOpen = true
  let category: 'templates' | 'bars' | 'controls' = 'bars'
  let activeSurface = surfaces.some((surface) => surface.id === 'chrome') ? 'chrome' : 'navbar'
  const windowControlsHostOptions = options.windowControlsHostOptions?.length
    ? options.windowControlsHostOptions
    : [
        { value: 'tabbar', label: '标签栏' },
        { value: 'navbar', label: '导航栏' },
        { value: 'titlebar', label: '标题栏' }
      ]
  let windowControlsHost = windowControlsHostOptions.some((item) => item.value === options.windowControlsHost)
    ? String(options.windowControlsHost)
    : windowControlsHostOptions[0].value
  let windowControlsChangeId = 0
  let closeChoiceMenu: (() => void) | null = null
  let chipLayer: HTMLElement
  let panel: HTMLElement
  let trayHost: HTMLElement
  let statusText: HTMLElement
  let renderFrame = 0
  let trayFrame = 0
  let renderDeferred = false
  let lastTraySignature = ''
  let zoneRevision = 0
  let commitFrame = 0
  let commitTimer = 0
  const pendingCommitSurfaces = new Set<string>()
  const zoneSignatures = new Map<string, string>()
  const sceneItems = new Map<string, HTMLElement>()

  const style = html(doc, 'style')
  style.textContent = `
    .hqe{position:fixed;inset:0;z-index:var(--hira-z-max);isolation:isolate;pointer-events:none;user-select:none;color:var(--hira-text-primary,#17202a);font:12px/1.45 "Segoe UI",system-ui,sans-serif}
    .hqe button,.hqe__bar,.hqe__drawer,.hqe__chip{app-region:no-drag;-webkit-app-region:no-drag}
    .hqe *{box-sizing:border-box}.hqe button,.hqe input{font:inherit;color:inherit}
    .hqe__btn{height:30px;min-width:30px;border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:var(--hira-bg-elevated,#fff);padding:0 10px;cursor:pointer;white-space:nowrap}.hqe__btn:hover{border-color:var(--hira-accent,#0f766e);color:var(--hira-accent,#0f766e)}.hqe__btn--danger{color:#b42318}.hqe__btn--danger:hover{border-color:#f04438;color:#b42318;background:#fff5f4}.hqe__btn--done{background:var(--hira-accent,#0f766e);border-color:var(--hira-accent,#0f766e);color:#fff}.hqe__btn[aria-pressed="true"]{background:var(--hira-accent-soft,#e7f5f2);border-color:var(--hira-accent,#0f766e);color:var(--hira-accent,#0f766e)}
    .hqe__status{position:static;z-index:auto;flex:1;min-width:0;pointer-events:none;padding:0 10px;color:var(--hira-text-secondary,#667085);font-size:11px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hqe__status[data-tone="warn"]{color:#b42318}.hqe__status[data-tone="ok"]{color:var(--hira-accent,#0f766e)}
    .hqe__chip{position:fixed;z-index:var(--hira-z-controls);pointer-events:auto;display:grid;place-items:center;border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:var(--hira-bg-elevated,#fff);cursor:grab;touch-action:none;box-shadow:0 1px 4px rgba(17,24,39,.08);overflow:visible}.hqe__chip:hover{border-color:var(--hira-accent,#0f766e);color:var(--hira-accent,#0f766e)}.hqe__chip[data-dragging="true"]{opacity:.28}.hqe__chip svg{display:block;max-width:18px;max-height:18px;pointer-events:none}.hqe__chipMark{position:absolute;top:-5px;right:-5px;width:17px;height:17px;border-radius:50%;border:1.5px solid var(--hira-bg-elevated,#fff);color:#fff;display:grid;place-items:center;font-size:11px;font-weight:700;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .1s ease,transform .1s ease}.hqe__chip:hover .hqe__chipMark,.hqe__chip:focus-visible .hqe__chipMark,.hqe__tray .hqe__chipMark{opacity:1;pointer-events:auto}.hqe__chip:hover .hqe__chipMark{transform:scale(1.06)}.hqe__chipMark[data-act="remove"]{background:#c2413b}.hqe__chipMark[data-act="add"]{background:var(--hira-accent,#0f766e)}
    .hqe__chip--labeled{display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:0 9px;text-align:left;overflow:hidden}
    .hqe__chipLabel{display:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.2;color:var(--hira-text-primary,#17202a);pointer-events:none}
    .hqe__chip--labeled .hqe__chipLabel{display:block}
    .hqe__ghost{position:fixed;z-index:var(--hira-z-popover);pointer-events:none;display:flex;align-items:center;gap:7px;min-width:74px;height:32px;padding:0 9px;border:1px solid var(--hira-accent,#0f766e);border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:var(--hira-bg-elevated,#fff);box-shadow:0 10px 26px rgba(17,24,39,.22);will-change:transform}.hqe__ghost svg{max-width:18px;max-height:18px}
    .hqe__caret{position:fixed;z-index:var(--hira-z-tooltip);pointer-events:none;background:var(--hira-accent,#0f766e);border-radius:var(--hira-radius-2xs,4px);box-shadow:0 0 0 1px rgba(255,255,255,.55)}
    .hqe__dropPreview{position:fixed;z-index:var(--hira-z-popover);pointer-events:none;border:2px solid var(--hira-accent,#0f766e);border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:color-mix(in srgb,var(--hira-accent,#0f766e) 10%,transparent)}
    .hqe__drawer{position:fixed;z-index:var(--hira-z-max);left:50%;top:50%;transform:translate(-50%,-50%);width:min(1040px,calc(100vw - 48px));height:min(720px,calc(100vh - 48px));max-height:min(720px,calc(100vh - 48px));pointer-events:auto;display:none;grid-template-columns:156px minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;grid-template-areas:"head head" "nav tabs" "nav body" "footer footer";border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-xl,10px);background:var(--hira-bg-elevated,#fff);box-shadow:0 28px 80px rgba(17,24,39,.24);overflow:hidden}.hqe__drawer[data-open="true"]{display:grid}.hqe__drawerHead{grid-area:head;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px 14px;border-bottom:1px solid var(--hira-border-subtle,#d7dee7)}.hqe__drawerTitle{display:flex;min-width:0;flex-direction:column;gap:3px}.hqe__drawerHead strong{font-size:15px;letter-spacing:-.01em}.hqe__drawerSubtitle{color:var(--hira-text-secondary,#667085);font-size:11px}.hqe__drawerBadge{align-self:flex-start;padding:3px 7px;border-radius:var(--hira-radius-xs,6px);background:var(--hira-bg-subtle,#f3f5f8);color:var(--hira-text-tertiary,#98a2b3);font-size:10px}.hqe__categories{grid-area:nav;display:flex;flex-direction:column;gap:5px;padding:12px;border-right:1px solid var(--hira-border-subtle,#d7dee7);background:var(--hira-bg-subtle,#f7f8fa)}.hqe__category{width:100%;min-height:40px;padding:0 11px;border:0;border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:transparent;color:var(--hira-text-secondary,#667085);cursor:pointer;display:flex;align-items:center;justify-content:flex-start;gap:8px;text-align:left}.hqe__category b{width:16px;font-size:12px;text-align:center}.hqe__category span{font-size:11px}.hqe__category:hover{background:var(--hira-bg-elevated,#fff);color:var(--hira-text-primary,#17202a)}.hqe__category[aria-pressed="true"]{background:var(--hira-accent-soft,#e7f5f2);color:var(--hira-accent,#0f766e);font-weight:650}.hqe__tabs{grid-area:tabs;display:flex;gap:4px;padding:10px 18px;border-bottom:1px solid var(--hira-border-subtle,#d7dee7);background:var(--hira-bg-elevated,#fff)}.hqe__tab{flex:1;height:32px;border:1px solid transparent;border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:transparent;color:var(--hira-text-secondary,#667085);cursor:pointer}.hqe__tab:hover{color:var(--hira-text-primary,#17202a)}.hqe__tab[aria-pressed="true"]{border-color:var(--hira-border-subtle,#d7dee7);background:var(--hira-bg-subtle,#f7f8fa);color:var(--hira-text-primary,#17202a);font-weight:650}.hqe__drawerBody{grid-area:body;padding:18px;overflow:auto;min-height:0;scrollbar-gutter:stable}.hqe__section{margin-bottom:22px}.hqe__section h3{margin:0 0 10px;color:var(--hira-text-secondary,#667085);font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.07em}.hqe__tray{min-height:68px;display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:10px;border:1px dashed var(--hira-border-subtle,#cbd4df);border-radius:var(--hira-radius-md,10px);background:var(--hira-bg-subtle,#f5f7f9)}.hqe__tray[data-drop="true"]{border-color:var(--hira-accent,#0f766e);background:var(--hira-accent-soft,#e7f5f2)}.hqe__empty{color:var(--hira-text-secondary,#98a2b3);font-size:11px;padding:7px}.hqe__templates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.hqe__template{min-height:58px;border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-md,10px);background:var(--hira-bg-elevated,#fff);text-align:left;padding:10px 12px;cursor:pointer;line-height:1.45}.hqe__template:hover{border-color:var(--hira-accent,#0f766e);background:var(--hira-accent-soft,#e7f5f2)}.hqe__footer{grid-area:footer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;border-top:1px solid var(--hira-border-subtle,#d7dee7);background:var(--hira-bg-subtle,#f7f8fa)}
    .hqe__tip{position:fixed;pointer-events:none;padding:12px 16px;border-radius:var(--hira-radius-md,10px);background:var(--hira-bg-elevated,#fff);box-shadow:0 8px 26px rgba(17,24,39,.16);color:var(--hira-text-secondary,#667085);font-size:11px;border:1px solid var(--hira-border-subtle,#d7dee7)}
    @media(max-width:760px){.hqe__drawer{left:10px;right:10px;top:10px;bottom:10px;grid-template-columns:132px minmax(0,1fr);transform:none;width:auto;height:auto;max-height:none}.hqe__drawerSubtitle{display:none}.hqe__templates{grid-template-columns:1fr}.hqe__drawerHead{padding:14px 12px 10px}.hqe__categories{padding:10px 8px}.hqe__tabs{padding:8px 12px}.hqe__drawerBody{padding:12px}.hqe__footer{flex-wrap:wrap;padding:10px 12px}.hqe__status{order:3;flex-basis:100%;padding:2px 0 0;text-align:left}}
  `
  root.appendChild(style)
  const detailStyle = html(doc, 'style')
  detailStyle.textContent = `
    .hqe__barFrameButton{position:fixed;z-index:var(--hira-z-elevated);display:flex;align-items:stretch;border:1px solid color-mix(in srgb,var(--hira-border-subtle,#d7dee7) 86%,transparent);border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:transparent;pointer-events:none;overflow:hidden;color:var(--hira-text-secondary,#667085)}
    .hqe__barFrameButton[data-placeholder="true"]{border-style:dashed;opacity:.72}
    .hqe__barPosition{color:var(--hira-text-tertiary,#98a2b3);font-variant-numeric:tabular-nums}
    .hqe__catalogGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(68px,1fr));align-items:start;gap:14px 8px;padding:12px}
    .hqe__catalogItem{display:flex;min-width:0;flex-direction:column;align-items:center;gap:5px}
    .hqe__catalogLabel{width:100%;overflow:hidden;color:var(--hira-text-secondary,#667085);font-size:10px;line-height:1.25;text-align:center;text-overflow:ellipsis;white-space:nowrap}
    .hqe__sectionControl{display:flex;flex-direction:column;align-items:stretch;gap:7px;margin:0 0 14px;padding:9px 10px 10px;border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-sm,8px);background:var(--hira-bg-subtle,#f7f8fa);color:var(--hira-text-secondary,#667085)}
    .hqe__sectionControlRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .hqe__sectionControl strong{color:var(--hira-text-primary,#17202a);font-size:11px;font-weight:650}
    .hqe__sectionNote{margin:0;color:var(--hira-text-tertiary,#98a2b3);font-size:10px;line-height:1.45}
    .hqe__select{height:32px;min-width:126px;border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:var(--hira-bg-elevated,#fff);padding:0 30px 0 10px;color:var(--hira-text-primary,#17202a);cursor:pointer}
    .hqe__select:disabled{opacity:.5;cursor:not-allowed}
    .hqe__choice{position:relative;min-width:126px}
    .hqe__selectTrigger{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left}
    .hqe__selectTrigger::after{content:"⌄";color:var(--hira-text-tertiary,#98a2b3);font-size:12px;line-height:1}
    .hqe__choiceMenu{position:fixed;z-index:120;display:flex;flex-direction:column;gap:2px;min-width:160px;max-height:260px;padding:5px;border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-md,10px);background:var(--hira-bg-elevated,#fff);box-shadow:0 12px 32px rgba(17,24,39,.2);overflow:auto;pointer-events:auto}
    .hqe__choiceOption{min-height:30px;padding:0 9px;border:0;border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:transparent;color:var(--hira-text-primary,#17202a);font:inherit;text-align:left;cursor:pointer}
    .hqe__choiceOption:hover,.hqe__choiceOption[aria-selected="true"]{background:var(--hira-accent-soft,#e7f5f2);color:var(--hira-accent,#0f766e)}
    .hqe__barSettingsList{display:flex;flex-direction:column;gap:10px}
    .hqe__barOption{display:flex;flex-direction:column;align-items:stretch;gap:9px;width:100%;min-width:0;padding:12px 14px;border:1px solid var(--hira-border-subtle,#d7dee7);border-radius:var(--hira-radius-lg,12px);background:var(--hira-bg-elevated,#fff);box-shadow:0 1px 2px rgba(17,24,39,.035)}
    .hqe__barOptionHead{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .hqe__barOptionHead strong{font-size:13px;color:var(--hira-text-primary,#17202a)}
    .hqe__barOptionHead span{padding:3px 7px;border-radius:var(--hira-radius-xs,6px);background:var(--hira-bg-subtle,#f3f5f8);color:var(--hira-text-secondary,#667085);font-size:10px;white-space:nowrap}
    .hqe__barOptionFields{display:flex;flex-direction:column;gap:9px}
    .hqe__barField{display:flex;flex-direction:column;gap:5px}
    .hqe__barFieldRow{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .hqe__barFieldLabel{color:var(--hira-text-primary,#17202a);font-size:11px;font-weight:600}
    .hqe__barFieldNote{margin:0;color:var(--hira-text-tertiary,#98a2b3);font-size:10px;line-height:1.4}
    .hqe__barOptionNote{margin:0;color:var(--hira-text-tertiary,#98a2b3);font-size:10px;line-height:1.45}
    .hqe__toggle{position:relative;width:34px;height:20px;border:1px solid var(--hira-border-subtle,#cbd4df);border-radius:var(--hira-radius-control,var(--hira-theme-radius,6px));background:var(--hira-bg-subtle,#f3f5f8);cursor:pointer;transition:background .12s ease,border-color .12s ease}
    .hqe__toggle::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(17,24,39,.2);transition:transform .12s ease}
    .hqe__toggle[aria-pressed="true"]{border-color:var(--hira-accent,#0f766e);background:var(--hira-accent,#0f766e)}
    .hqe__toggle[aria-pressed="true"]::after{transform:translateX(14px)}
    .hqe__toggle:disabled{opacity:.45;cursor:not-allowed}
    .hqe__section{margin-bottom:12px}
    .hqe__section:last-child{margin-bottom:0}
  `
  root.appendChild(detailStyle)

  chipLayer = html(doc, 'div')
  const status = html(doc, 'div', 'hqe__status')
  statusText = html(doc, 'span')
  statusText.textContent = '拖动控件排序；拖进“更多按钮”即移除；栏位方位请在“栏位”中设置'
  status.appendChild(statusText)

  panel = html(doc, 'aside', 'hqe__drawer')
  const panelHead = html(doc, 'div', 'hqe__drawerHead')
  const panelTitleGroup = html(doc, 'div', 'hqe__drawerTitle')
  const panelTitle = html(doc, 'strong')
  panelTitle.textContent = '界面编辑器'
  const panelSubtitle = html(doc, 'span', 'hqe__drawerSubtitle')
  panelSubtitle.textContent = '设置栏位方位，拖动栏内控件调整顺序'
  const panelBadge = html(doc, 'span', 'hqe__drawerBadge')
  panelBadge.textContent = 'ESC 完成'
  panelTitleGroup.append(panelTitle, panelSubtitle)
  panelHead.append(panelTitleGroup, panelBadge)
  const categories = html(doc, 'div', 'hqe__categories')
  const categoryButtons = new Map<string, HTMLButtonElement>()
  for (const [id, icon, label] of [
    ['templates', '▣', '模板'],
    ['bars', '▭', '栏位'],
    ['controls', '☷', '控件']
  ] as const) {
    const button = html(doc, 'button', 'hqe__category')
    button.type = 'button'
    const mark = html(doc, 'b')
    mark.textContent = icon
    const name = html(doc, 'span')
    name.textContent = label
    button.append(mark, name)
    button.setAttribute('aria-pressed', String(category === id))
    button.addEventListener('click', () => {
      category = id
      root.dataset.category = id
      if (id === 'bars' && surfaces.some((surface) => surface.id === 'chrome')) activeSurface = 'chrome'
      if (id === 'controls' && surfaces.some((surface) => surface.id === 'navbar')) activeSurface = 'navbar'
      for (const [key, item] of categoryButtons) item.setAttribute('aria-pressed', String(key === category))
      for (const [key, item] of surfaceTabs) item.setAttribute('aria-pressed', String(key === activeSurface))
      renderTray()
    })
    categoryButtons.set(id, button)
    categories.appendChild(button)
  }
  const tabs = html(doc, 'div', 'hqe__tabs')
  const surfaceTabs = new Map<string, HTMLButtonElement>()
  for (const surface of surfaces.filter((item) => item.id === 'navbar' || item.id === 'rail')) {
    const tab = html(doc, 'button', 'hqe__tab')
    tab.type = 'button'
    tab.textContent = surface.label
    tab.setAttribute('aria-pressed', String(surface.id === activeSurface))
    tab.addEventListener('click', () => {
      activeSurface = surface.id
      for (const [id, item] of surfaceTabs) item.setAttribute('aria-pressed', String(id === activeSurface))
      renderTray()
    })
    surfaceTabs.set(surface.id, tab)
    tabs.appendChild(tab)
  }
  const panelBody = html(doc, 'div', 'hqe__drawerBody')
  trayHost = html(doc, 'div')
  panelBody.appendChild(trayHost)
  const footer = html(doc, 'footer', 'hqe__footer')
  const cancelFooter = html(doc, 'button', 'hqe__btn')
  cancelFooter.type = 'button'
  cancelFooter.textContent = '取消'
  const historyGroup = html(doc, 'div')
  historyGroup.style.display = 'flex'
  historyGroup.style.gap = '6px'
  const undoFooter = html(doc, 'button', 'hqe__btn')
  undoFooter.type = 'button'
  undoFooter.textContent = '撤销'
  undoFooter.disabled = true
  const redoFooter = html(doc, 'button', 'hqe__btn')
  redoFooter.type = 'button'
  redoFooter.textContent = '重做'
  redoFooter.disabled = true
  historyGroup.append(undoFooter, redoFooter)
  const saveFooter = html(doc, 'button', 'hqe__btn hqe__btn--done')
  saveFooter.type = 'button'
  saveFooter.textContent = '保存'
  footer.append(cancelFooter, status, historyGroup, saveFooter)
  panel.append(panelHead, categories, tabs, panelBody, footer)
  panel.dataset.open = 'true'
  root.append(chipLayer, panel)

  function descriptor(id: string): QuickLayoutItemDescriptor | null {
    return catalog.get(id) || null
  }

  function iconNode(id: string, size = 17): Node {
    const item = descriptor(id)
    try {
      const icon = item?.icon?.(doc, { size })
      if (icon) return icon
    } catch (_) {}
    const fallback = html(doc, 'span')
    fallback.textContent = (item?.label || id).slice(0, 1).toUpperCase()
    return fallback
  }

  function surfaceDef(id: string): QuickLayoutSurface | null {
    return surfaces.find((surface) => surface.id === id) || null
  }

  function areaKeys(surfaceId: string): string[] {
    return surfaceDef(surfaceId)?.areas.map((area) => area.key) || []
  }

  function copyStates(source: Record<string, QuickLayoutState> = states): Record<string, QuickLayoutState> {
    return Object.fromEntries(
      Object.entries(source).map(([key, value]) => [
        key,
        {
          byArea: Object.fromEntries(Object.entries(value.byArea).map(([area, ids]) => [area, ids.slice()])),
          hidden: value.hidden.slice(),
          compact: value.compact === true
        }
      ])
    )
  }

  function sameState(left: QuickLayoutState | null | undefined, right: QuickLayoutState | null | undefined): boolean {
    if (!left || !right) return left === right
    if ((left.compact === true) !== (right.compact === true)) return false
    if (left.hidden.length !== right.hidden.length) return false
    if (left.hidden.some((id, index) => id !== right.hidden[index])) return false
    const leftAreas = Object.keys(left.byArea)
    const rightAreas = Object.keys(right.byArea)
    if (leftAreas.length !== rightAreas.length) return false
    return leftAreas.every((area) => {
      const a = left.byArea[area] || []
      const b = right.byArea[area] || []
      return a.length === b.length && a.every((id, index) => id === b[index])
    })
  }

  function pushHistory(snapshot: Record<string, QuickLayoutState> = copyStates()): void {
    undoStack.push(snapshot)
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
    redoStack.length = 0
    updateHistoryButtons()
  }

  function updateHistoryButtons(): void {
    undoFooter.disabled = undoStack.length === 0
    redoFooter.disabled = redoStack.length === 0
  }

  async function commitAllChanged(previous: Record<string, QuickLayoutState>): Promise<void> {
    const tasks: Array<void | Promise<void>> = []
    for (const surface of surfaces) {
      const before = previous[surface.id]
      const after = states[surface.id]
      if (!before || !after) continue
      if (sameState(before, after)) continue
      tasks.push(Promise.resolve().then(() => options.onCommit(surface.id, {
        byArea: Object.fromEntries(Object.entries(after.byArea).map(([area, ids]) => [area, ids.slice()])),
        hidden: after.hidden.slice(),
        compact: after.compact === true
      })))
    }
    await Promise.all(tasks)
  }

  function applyHistory(target: Record<string, QuickLayoutState>): void {
    const previous = copyStates()
    for (const [key, value] of Object.entries(target)) states[key] = copyStates({ [key]: value })[key]
    render()
    void commitAllChanged(previous).catch((error) => setStatus(`应用失败：${error.message || error}`, 'warn'))
  }

  function undo(): void {
    const previous = undoStack.pop()
    if (!previous) return
    redoStack.push(copyStates())
    applyHistory(previous)
    updateHistoryButtons()
    setStatus('已撤销')
  }

  function redo(): void {
    const next = redoStack.pop()
    if (!next) return
    undoStack.push(copyStates())
    applyHistory(next)
    updateHistoryButtons()
    setStatus('已重做')
  }

  function areaOf(surfaceId: string, id: string): string | null {
    const state = states[surfaceId]
    if (!state) return null
    for (const [area, ids] of Object.entries(state.byArea)) {
      if (ids.includes(id)) return area
    }
    return null
  }

  function detachId(state: QuickLayoutState, id: string): boolean {
    let removed = false
    for (const ids of Object.values(state.byArea)) {
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        if (ids[index] !== id) continue
        ids.splice(index, 1)
        removed = true
      }
    }
    for (let index = state.hidden.length - 1; index >= 0; index -= 1) {
      if (state.hidden[index] !== id) continue
      state.hidden.splice(index, 1)
      removed = true
    }
    return removed
  }

  function containsId(state: QuickLayoutState, id: string): boolean {
    return state.hidden.includes(id) || Object.values(state.byArea).some((ids) => ids.includes(id))
  }

  function zoneIds(surfaceId: string, area: string): string[] {
    return Array.from(new Set(
      (states[surfaceId]?.byArea[area] || [])
        .filter((id) => surfaceId !== 'chrome' || id !== 'chrome:rail')
    ))
  }

  function stateSnapshot(surfaceId: string): QuickLayoutState | null {
    const state = states[surfaceId]
    if (!state) return null
    return {
      byArea: Object.fromEntries(Object.entries(state.byArea).map(([area, ids]) => [area, ids.slice()])),
      hidden: state.hidden.slice(),
      compact: state.compact === true
    }
  }

  function flushPendingCommits(): void {
    if (commitFrame) {
      cancelAnimationFrame(commitFrame)
      commitFrame = 0
    }
    if (commitTimer) {
      window.clearTimeout(commitTimer)
      commitTimer = 0
    }
    if (!pendingCommitSurfaces.size) return
    const surfaceIds = Array.from(pendingCommitSurfaces)
    pendingCommitSurfaces.clear()
    const tasks = surfaceIds.map((surfaceId) => {
      const state = stateSnapshot(surfaceId)
      if (!state) return Promise.resolve()
      try {
        return Promise.resolve(options.onCommit(surfaceId, state))
      } catch (error) {
        return Promise.reject(error)
      }
    })
    void Promise.allSettled(tasks).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        const reason = failed.reason as { message?: string } | undefined
        setStatus(`保存失败：${reason?.message || reason || '未知错误'}`, 'warn')
      } else {
        setStatus('已应用', 'ok')
      }
    })
  }

  function emit(surfaceId: string): void {
    if (!states[surfaceId]) return
    pendingCommitSurfaces.add(surfaceId)
    if (commitFrame || commitTimer) return
    // 先让本地状态与落位 DOM 在这一帧完成绘制，再用下一轮任务落库。
    // 直接 setTimeout(0) 会和 pointerup / 首帧重排争同一段主线程，表现为松手顿一下。
    commitFrame = requestAnimationFrame(() => {
      commitFrame = 0
      if (destroyed) return
      commitTimer = window.setTimeout(flushPendingCommits, 0)
    })
  }

  async function changeWindowControlsHost(host: string): Promise<void> {
    if (host === windowControlsHost) return
    const changeId = ++windowControlsChangeId
    const previous = windowControlsHost
    windowControlsHost = host
    if (!options.onWindowControlsHostChange) {
      windowControlsHost = previous
      lastTraySignature = ''
      setStatus('窗口控制按钮位置暂不可修改', 'warn')
      scheduleRender()
      return
    }
    const label = windowControlsHostOptions.find((item) => item.value === host)?.label || host
    try {
      await options.onWindowControlsHostChange(host)
      if (changeId !== windowControlsChangeId) return
      setStatus(`窗口控制按钮已设置为${label}`, 'ok')
    } catch (error) {
      if (changeId !== windowControlsChangeId) return
      windowControlsHost = previous
      lastTraySignature = ''
      scheduleRender()
      setStatus(`窗口控制按钮位置保存失败：${(error as Error)?.message || error}`, 'warn')
    }
  }

  async function changeBarSetting(
    barId: string,
    settingKey: string,
    value: string | boolean
  ): Promise<void> {
    const bar = barSettings.find((item) => item.id === barId)
    const setting = bar?.settings.find((item) => item.key === settingKey)
    if (!bar || !setting || setting.disabled) return
    if ((setting.type === 'select' && typeof value !== 'string') ||
        (setting.type === 'toggle' && typeof value !== 'boolean')) return
    const previous = setting.value
    if (previous === value) return
    setting.value = value
    lastTraySignature = ''
    scheduleTrayRender()
    if (!options.onBarSettingChange) {
      setting.value = previous
      lastTraySignature = ''
      scheduleTrayRender()
      setStatus('布局设置暂不可修改', 'warn')
      return
    }
    try {
      await options.onBarSettingChange(barId, settingKey, value)
      setStatus(`${bar.label}设置已应用`, 'ok')
    } catch (error) {
      setting.value = previous
      lastTraySignature = ''
      scheduleTrayRender()
      setStatus(`${bar.label}设置保存失败：${(error as Error)?.message || error}`, 'warn')
    }
  }

  function createChoiceControl(input: {
    value: string
    options: QuickLayoutBarSettingOption[]
    disabled?: boolean
    title?: string
    label: string
    onChange: (value: string) => void
  }): HTMLElement {
    let current = input.options.some((option) => option.value === input.value)
      ? input.value
      : (input.options[0]?.value || input.value)
    const wrap = html(doc, 'div', 'hqe__choice')
    const trigger = html(doc, 'button', 'hqe__select hqe__selectTrigger')
    trigger.type = 'button'
    trigger.setAttribute('aria-label', input.label)
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.disabled = input.disabled === true
    trigger.title = input.title || ''
    const valueText = html(doc, 'span')
    trigger.appendChild(valueText)
    wrap.appendChild(trigger)

    let menu: HTMLElement | null = null
    let detach = (): void => {}

    const close = (): void => {
      detach()
      detach = () => {}
      menu?.remove()
      menu = null
      trigger.setAttribute('aria-expanded', 'false')
      if (closeChoiceMenu === close) closeChoiceMenu = null
    }

    const paintValue = (): void => {
      valueText.textContent = input.options.find((option) => option.value === current)?.label || current
    }
    paintValue()

    const open = (): void => {
      if (trigger.disabled || menu) return
      closeChoiceMenu?.()
      menu = html(doc, 'div', 'hqe__choiceMenu')
      menu.setAttribute('role', 'listbox')
      menu.setAttribute('aria-label', input.label)
      for (const option of input.options) {
        const item = html(doc, 'button', 'hqe__choiceOption')
        item.type = 'button'
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(option.value === current))
        item.textContent = option.label
        item.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (option.value === current) {
            close()
            return
          }
          current = option.value
          paintValue()
          close()
          input.onChange(current)
        })
        menu.appendChild(item)
      }
      root.appendChild(menu)
      const rect = trigger.getBoundingClientRect()
      const width = Math.max(160, Math.round(rect.width))
      menu.style.width = `${width}px`
      const height = menu.offsetHeight
      const below = rect.bottom + 4
      const top = below + height <= window.innerHeight - 8
        ? below
        : Math.max(8, rect.top - height - 4)
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, Math.round(rect.left)))}px`
      menu.style.top = `${Math.round(top)}px`
      trigger.setAttribute('aria-expanded', 'true')
      closeChoiceMenu = close

      const onOutside = (event: PointerEvent): void => {
        const target = event.target
        if (!(target instanceof Node) || wrap.contains(target) || menu?.contains(target)) return
        close()
      }
      const onViewportChange = (): void => close()
      window.addEventListener('pointerdown', onOutside, true)
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
      detach = () => {
        window.removeEventListener('pointerdown', onOutside, true)
        window.removeEventListener('resize', onViewportChange)
        window.removeEventListener('scroll', onViewportChange, true)
      }
    }

    trigger.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (menu) close()
      else open()
    })
    return wrap
  }

  function setStatus(text: string, tone: 'neutral' | 'ok' | 'warn' = 'neutral'): void {
    if (statusText.textContent === text && status.dataset.tone === tone) return
    statusText.textContent = text
    status.dataset.tone = tone
  }

  function chip(
    id: string,
    surfaceId: string,
    area: string,
    zone?: QuickLayoutZone,
    visual?: HTMLElement
  ): HTMLElement {
    const item = descriptor(id)
    const node = html(doc, 'button', 'hqe__chip')
    node.type = 'button'
    node.title = item?.label || id
    node.dataset.id = id
    node.dataset.surface = surfaceId
    node.dataset.area = area
    if (zone) node.dataset.zone = zone.key
    node.appendChild(iconNode(id, area === 'tray' ? 19 : 17))
    if ((surfaceId === 'rail' || surfaceId === 'rail-pins') && item?.label) {
      const label = html(doc, 'span', 'hqe__chipLabel')
      label.textContent = item.label
      node.appendChild(label)
    }
    if (surfaceId !== 'rail-pins' && (area === 'tray' || item?.removable !== false)) {
      const mark = html(doc, 'span', 'hqe__chipMark')
      mark.dataset.act = area === 'tray' ? 'add' : 'remove'
      mark.textContent = area === 'tray' ? '+' : '−'
      mark.title = area === 'tray' ? '添加回界面' : '移到更多按钮'
      mark.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (area === 'tray') restore(surfaceId, id)
        else remove(surfaceId, id, area)
      })
      node.appendChild(mark)
    }
    node.addEventListener('pointerdown', (event) => beginDrag(
      event,
      node,
      surfaceId,
      id,
      area === 'tray' ? 'tray' : 'zone',
      zone?.key || null,
      visual
    ))
    return node
  }

  function placedBarFrame(
    id: string,
    placeholder = false
  ): HTMLElement {
    const button = html(doc, 'div', 'hqe__barFrameButton')
    button.dataset.barId = id
    if (placeholder) button.dataset.placeholder = 'true'
    button.title = descriptor(id)?.label || id
    return button
  }

  function restore(surfaceId: string, id: string): void {
    const state = states[surfaceId]
    if (!state) return
    const index = state.hidden.indexOf(id)
    if (index < 0) return
    const before = copyStates()
    detachId(state, id)
    const area = surfaceId === 'navbar'
      ? (areaKeys(surfaceId).includes('panel') ? 'panel' : areaKeys(surfaceId)[0])
      : (areaKeys(surfaceId).find((key) => key === 'rail') || areaKeys(surfaceId)[0])
    if (area) state.byArea[area].push(id)
    pushHistory(before)
    scheduleRender()
    emit(surfaceId)
  }

  function remove(surfaceId: string, id: string, _area: string): void {
    if (descriptor(id)?.removable === false) {
      setStatus('固定控件不可移除，只能调整位置。', 'warn')
      return
    }
    const state = states[surfaceId]
    if (!state) return
    const before = copyStates()
    const removed = detachId(state, id)
    if (!removed) return
    if (!state.hidden.includes(id)) state.hidden.push(id)
    pushHistory(before)
    scheduleRender()
    emit(surfaceId)
  }

  function layoutOfZone(zone: QuickLayoutZone, ids: string[]): QuickDropPosition[] {
    const actual = new Map((zone.items || []).map((item) => [item.id, item]))
    const ordered = ids.filter((id) => actual.has(id)).map((id) => actual.get(id)!)
    const horizontal = (zone.axis || 'row') === 'row'
    const size = horizontal ? 30 : 30
    const railRects = (zones.get('rail') || []).map((item) => item.rect)
    const avoidRail = (rect: { id: string; x: number; y: number; width: number; height: number }) => {
      if (rect.id !== 'chrome:bookmarkbar' || !railRects.length) return rect
      const blocked = railRects.some((rail) =>
        rect.x < rail.x + rail.width && rail.x < rect.x + rect.width &&
        rect.y < rail.y + rail.height && rail.y < rect.y + rect.height
      )
      if (!blocked) return rect
      const railTop = Math.min(...railRects.map((rail) => rail.y))
      const railBottom = Math.max(...railRects.map((rail) => rail.y + rail.height))
      const bottomHalf = rect.y >= window.innerHeight / 2
      return {
        ...rect,
        y: Math.max(2, bottomHalf ? railTop - rect.height - 4 : railBottom + 4)
      }
    }
    const fallback = (id: string, index: number) => ({
      ...avoidRail({
        id,
        x: zone.surface === 'chrome' ? zone.rect.x : zone.rect.x + (horizontal ? index * (size + 5) : 5),
        y: zone.surface === 'chrome' ? zone.rect.y + index * 42 : zone.rect.y + (horizontal ? 5 : index * (size + 5)),
        width: zone.surface === 'chrome' ? zone.rect.width : size,
        height: zone.surface === 'chrome' ? 38 : size
      })
    })
    if (!ordered.length) return ids.map(fallback)

    // 真实 surface 只会上报“当前已渲染”的块；空书签栏等会主动隐身，但它仍必须
    // 在编辑模式里有完整占位图形。保留真实块，并为缺失块补一行真实宽度的占位。
    const result = ordered.slice()
    let nextY = Math.max(
      zone.rect.y,
      ...ordered.map((item) => item.y + item.height)
    )
    for (const id of ids) {
      if (actual.has(id)) continue
      result.push(avoidRail({ id, x: zone.rect.x, y: nextY, width: zone.rect.width, height: 38 }))
      nextY += 42
    }
    return result
  }

  function renderZones(surface: QuickLayoutSurface, itemNodes: HTMLElement[]): void {
    const surfaceZones = zones.get(surface.id) || []
    for (const zone of surfaceZones) {
      const ids = zoneIds(surface.id, zone.key)
      const actualIds = new Set((zone.items || []).map((item) => item.id))
      for (const item of layoutOfZone(zone, ids)) {
        const isMissingBookmarkGraphic = item.id === 'chrome:bookmarkbar' && !actualIds.has(item.id)
        const itemKey = `${surface.id}\n${zone.key}\n${item.id}`
        let node = sceneItems.get(itemKey)
        if (!node) {
          node = surface.id === 'chrome' && item.id.startsWith('chrome:')
            ? placedBarFrame(item.id, isMissingBookmarkGraphic)
            : chip(item.id, surface.id, 'zone', zone)
          sceneItems.set(itemKey, node)
        }
        if (node.dataset.placeholder === 'true' && !isMissingBookmarkGraphic) {
          delete node.dataset.placeholder
        } else if (node.dataset.placeholder !== 'true' && isMissingBookmarkGraphic) {
          node.dataset.placeholder = 'true'
        }
        node.style.cssText = `position:fixed;left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;`
        node.classList.toggle(
          'hqe__chip--labeled',
          (surface.id === 'rail' || surface.id === 'rail-pins') &&
          item.width >= 72 &&
          item.height >= 24
        )
        itemNodes.push(node)
      }
    }
  }

  function zoneSignature(segments: QuickLayoutZone[]): string {
    return JSON.stringify(segments.map((zone) => ({
      key: zone.key,
      surface: zone.surface,
      label: zone.label,
      rect: zone.rect,
      hitRect: zone.hitRect,
      grow: zone.grow,
      axis: zone.axis,
      items: (zone.items || []).map((item) => [item.id, item.x, item.y, item.width, item.height])
    })))
  }

  function traySignature(): string {
    const stateSignature = Object.entries(states)
      .map(([surfaceId, value]) => `${surfaceId}:${value.compact === true ? 1 : 0}:${value.hidden.join(',')}:${Object.entries(value.byArea)
        .map(([area, ids]) => `${area}=${ids.join(',')}`)
        .join(';')}`)
      .join('|')
    const barSettingSignature = barSettings
      .map((bar) => `${bar.id}:${bar.settings.map((setting) =>
        `${setting.key}=${String(setting.value)}:${setting.disabled === true ? 1 : 0}`
      ).join(',')}`)
      .join('|')
    const geometryRevision = category === 'controls' ? zoneRevision : 0
    return `${category}|${activeSurface}|${windowControlsHost}|${geometryRevision}|${stateSignature}|${barSettingSignature}`
  }

  function renderTray(): void {
    const state = states[activeSurface]
    if (!state) return
    const nextSignature = traySignature()
    if (nextSignature === lastTraySignature) {
      tabs.style.display = category === 'controls' ? 'flex' : 'none'
      return
    }
    const scrollTop = panelBody.scrollTop
    closeChoiceMenu?.()
    trayHost.replaceChildren()
    renderTrayContent(state)
    lastTraySignature = nextSignature
    panelBody.scrollTop = scrollTop
  }

  function renderTrayContent(state: QuickLayoutState): void {
    tabs.style.display = category === 'controls' ? 'flex' : 'none'

    if (category === 'templates' && options.onTemplate) {
      const templates = html(doc, 'section', 'hqe__section')
      const title = html(doc, 'h3')
      title.textContent = '快速布局'
      const list = html(doc, 'div', 'hqe__templates')
      for (const [id, label, note] of [
        ['classic', '经典顶栏', '标签与导航保持在顶部'],
        ['sidebar', '垂直标签', '标签栏进入左侧，导航栏留在顶部'],
        ['all-in-one', '全功能侧栏', '标签栏与导航栏进入同一侧栏'],
        ['focus', '专注布局', '自动收起次要栏位']
      ] as const) {
        const button = html(doc, 'button', 'hqe__template')
        button.type = 'button'
        button.textContent = `${label} · ${note}`
        button.addEventListener('click', () => {
          setStatus('正在应用布局…')
          Promise.resolve(options.onTemplate?.(id)).then(() => setStatus('布局已应用', 'ok')).catch((error) => setStatus(`应用失败：${error.message || error}`, 'warn'))
        })
        list.appendChild(button)
      }
      templates.append(title, list)
      trayHost.appendChild(templates)
      return
    }

    if (category === 'controls') {
      const section = html(doc, 'section', 'hqe__section')
      const heading = html(doc, 'h3')
      heading.textContent = `${surfaceDef(activeSurface)?.label || activeSurface} · 可用控件`
      const tray = html(doc, 'div', 'hqe__tray hqe__catalogGrid')
      tray.dataset.surface = activeSurface
      const allIds = [
        ...Object.values(state.byArea).flat(),
        ...state.hidden
      ]
      if (!allIds.length) {
        const empty = html(doc, 'div', 'hqe__empty')
        empty.textContent = '当前界面还没有可拖动构件'
        tray.appendChild(empty)
      } else {
        for (const id of Array.from(new Set(allIds))) {
          const area = areaOf(activeSurface, id)
          const zone = area ? (zones.get(activeSurface) || []).find((item) => item.key === area) || null : null
          const item = html(doc, 'div', 'hqe__catalogItem')
          const label = html(doc, 'span', 'hqe__catalogLabel')
          label.textContent = descriptor(id)?.label || id
          label.title = label.textContent
          const control = area && zone
            ? chip(id, activeSurface, 'zone', zone, item)
            : chip(id, activeSurface, 'tray', undefined, item)
          control.style.position = 'relative'
          control.style.left = 'auto'
          control.style.top = 'auto'
          control.style.width = '38px'
          control.style.height = '38px'
          item.append(control, label)
          tray.appendChild(item)
        }
      }
      section.append(heading, tray)
      trayHost.appendChild(section)
      return
    }

    const samples = html(doc, 'section', 'hqe__section')
    const sampleTitle = html(doc, 'h3')
    sampleTitle.textContent = '栏位设置'
    samples.appendChild(sampleTitle)
    const controlsRow = html(doc, 'div', 'hqe__sectionControl')
    const controlsLine = html(doc, 'div', 'hqe__sectionControlRow')
    const controlsLabel = html(doc, 'strong')
    controlsLabel.textContent = '窗口控制按钮位置'
    const controlsSelect = createChoiceControl({
      value: windowControlsHost,
      options: windowControlsHostOptions,
      disabled: !options.onWindowControlsHostChange,
      label: '窗口控制按钮位置',
      onChange: (value) => {
        void changeWindowControlsHost(value)
      }
    })
    const controlsNote = html(doc, 'p', 'hqe__sectionNote')
    controlsNote.textContent = options.windowControlsHostHint ||
      '标题栏未显示时会自动回退；Edge 型垂直标签布局固定使用导航栏。'
    controlsLine.append(controlsLabel, controlsSelect)
    controlsRow.append(controlsLine, controlsNote)
    samples.appendChild(controlsRow)
    const chromeBars = options.catalog.filter((item) => item.id.startsWith('chrome:'))
    if (!chromeBars.length) {
      const empty = html(doc, 'div', 'hqe__empty')
      empty.textContent = '栏位目录尚未就绪'
      samples.appendChild(empty)
    } else {
      const settingsList = html(doc, 'div', 'hqe__barSettingsList')
      for (const item of chromeBars) {
        const currentArea = areaOf('chrome', item.id)
        const barDescriptor = barSettings.find((bar) => bar.id === item.id)
        const card = html(doc, 'article', 'hqe__barOption')
        card.dataset.barId = item.id
        const head = html(doc, 'div', 'hqe__barOptionHead')
        const name = html(doc, 'strong')
        name.textContent = barDescriptor?.label || item.label
        const location = html(doc, 'span', 'hqe__barPosition')
        const areaLabel = surfaceDef('chrome')?.areas.find((area) => area.key === currentArea)?.label
        location.textContent = currentArea ? `位于${areaLabel || currentArea}` : '未显示'
        head.append(name, location)
        card.append(head)
        if (barDescriptor?.description) {
          const note = html(doc, 'p', 'hqe__barOptionNote')
          note.textContent = barDescriptor.description
          card.appendChild(note)
        }
        const fields = html(doc, 'div', 'hqe__barOptionFields')
        for (const setting of barDescriptor?.settings || []) {
          const field = html(doc, 'div', 'hqe__barField')
          const fieldRow = html(doc, 'div', 'hqe__barFieldRow')
          const fieldLabel = html(doc, 'span', 'hqe__barFieldLabel')
          fieldLabel.textContent = setting.label
          if (setting.type === 'toggle') {
            const toggle = html(doc, 'button', 'hqe__toggle')
            toggle.type = 'button'
            toggle.setAttribute('role', 'switch')
            toggle.setAttribute('aria-label', setting.label)
            toggle.setAttribute('aria-pressed', String(setting.value === true))
            toggle.disabled = setting.disabled === true
            toggle.title = setting.disabledReason || setting.description || ''
            toggle.addEventListener('click', () => {
              if (toggle.disabled) return
              void changeBarSetting(item.id, setting.key, setting.value !== true)
            })
            fieldRow.append(fieldLabel, toggle)
          } else {
            const select = createChoiceControl({
              value: String(setting.value),
              options: setting.options || [],
              disabled: setting.disabled === true,
              title: setting.disabledReason || setting.description || '',
              label: setting.label,
              onChange: (value) => {
                void changeBarSetting(item.id, setting.key, value)
              }
            })
            fieldRow.append(fieldLabel, select)
          }
          field.appendChild(fieldRow)
          const noteText = setting.disabled ? setting.disabledReason : setting.description
          if (noteText) {
            const note = html(doc, 'p', 'hqe__barFieldNote')
            note.textContent = noteText
            field.appendChild(note)
          }
          fields.appendChild(field)
        }
        if (fields.childElementCount) card.appendChild(fields)
        settingsList.appendChild(card)
      }
      samples.appendChild(settingsList)
    }
    trayHost.appendChild(samples)
  }

  function scheduleTrayRender(): void {
    if (destroyed || trayFrame) return
    trayFrame = requestAnimationFrame(() => {
      trayFrame = 0
      if (drag) {
        // 抽屉里的拖动源持有 pointer capture，不能在手势中摘节点。
        renderDeferred = true
        return
      }
      renderTray()
    })
  }

  function renderScene(): void {
    if (destroyed) return
    if (drag) {
      renderDeferred = true
      return
    }
    const itemNodes: HTMLElement[] = []
    for (const surface of surfaces) renderZones(surface, itemNodes)
    chipLayer.replaceChildren(...itemNodes)
    for (const [key, node] of sceneItems) if (!node.isConnected) sceneItems.delete(key)
  }

  function render(): void {
    if (destroyed) return
    if (drag) {
      renderDeferred = true
      return
    }
    if (renderFrame) {
      cancelAnimationFrame(renderFrame)
      renderFrame = 0
    }
    renderScene()
    scheduleTrayRender()
  }

  function scheduleSceneRender(): void {
    if (destroyed || renderFrame) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0
      if (drag) {
        renderDeferred = true
        return
      }
      renderScene()
    })
  }

  function scheduleRender(): void {
    if (destroyed) return
    if (renderFrame) {
      cancelAnimationFrame(renderFrame)
      renderFrame = 0
    }
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0
      if (drag) {
        // 拖拽期间替换 DOM 会让持有 pointer capture 的源节点被摘掉，
        // 表现为指针还在移动但拖动突然失效。几何更新延后到本次手势结束。
        renderDeferred = true
        return
      }
      render()
    })
  }

  function beginDrag(
    event: PointerEvent,
    source: HTMLElement,
    surface: string,
    id: string,
    from: 'zone' | 'tray',
    zone: string | null,
    visualSource?: HTMLElement
  ): void {
    if (event.button !== 0 || drag) return
    const visual = visualSource || source
    const sourceRect = visual.getBoundingClientRect()
    const state: QuickDrag = {
      surface,
      id,
      from,
      zone,
      chip: source,
      visual,
      ghost: null,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - sourceRect.left,
      offsetY: event.clientY - sourceRect.top,
      pointerId: event.pointerId,
      active: false,
      raf: 0,
      activationRaf: 0,
      caret: null,
      dropPreview: null,
      tray: null,
      trayRect: null,
      previewStyleKey: '',
      caretStyleKey: '',
      positionsCache: new Map()
    }
    drag = state
    doc.body.style.cursor = 'grabbing'
    try { source.setPointerCapture(event.pointerId) } catch (_) {}
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('resize', onWindowBlur)
  }

  function beginVisual(state: QuickDrag): void {
    state.active = true
    try { options.onDragState?.(true) } catch (_) {}
    state.tray = panel.querySelector<HTMLElement>('.hqe__tray')
    state.trayRect = state.tray?.getBoundingClientRect() || null
    const sourceRect = state.visual.getBoundingClientRect()
    const ghost = state.visual.cloneNode(true) as HTMLElement
    ghost.classList.add('hqe__ghost')
    ghost.removeAttribute('data-dragging')
    for (const mark of ghost.querySelectorAll('.hqe__chipMark')) mark.remove()
    ghost.style.position = 'fixed'
    ghost.style.width = `${Math.round(sourceRect.width)}px`
    ghost.style.height = `${Math.round(sourceRect.height)}px`
    ghost.style.minWidth = `${Math.round(sourceRect.width)}px`
    ghost.style.maxWidth = 'none'
    ghost.style.left = '0'
    ghost.style.top = '0'
    ghost.style.transform = `translate3d(${Math.round(sourceRect.left)}px,${Math.round(sourceRect.top)}px,0)`
    root.appendChild(ghost)
    state.ghost = ghost
    state.chip.dataset.dragging = 'true'
    mountDropIndicators(state)
  }

  function mountDropIndicators(state: QuickDrag): void {
    const caret = html(doc, 'div', 'hqe__caret')
    const preview = html(doc, 'div', 'hqe__dropPreview')
    caret.style.display = 'none'
    preview.style.display = 'none'
    root.append(preview, caret)
    state.caret = caret
    state.dropPreview = preview
  }

  function updateGhostPosition(state: QuickDrag): void {
    if (!state.ghost) return
    const x = Math.round(state.x - state.offsetX)
    const y = Math.round(state.y - state.offsetY)
    state.ghost.style.transform = `translate3d(${x}px,${y}px,0)`
  }

  function onMove(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    if (event.buttons === 0) {
      onCancel(event)
      return
    }
    state.x = event.clientX
    state.y = event.clientY
    if (
      !state.active &&
      !state.activationRaf &&
      Math.hypot(state.x - state.startX, state.y - state.startY) >= 5
    ) {
      state.activationRaf = requestAnimationFrame(() => {
        state.activationRaf = 0
        if (drag !== state || state.active) return
        try {
          beginVisual(state)
          updateGhostPosition(state)
          renderCaret(state)
        } catch (error) {
          endDrag()
          setStatus(`无法开始拖动：${(error as Error)?.message || error}`, 'warn')
        }
      })
    }
    if (!state.active || state.raf) return
    state.raf = requestAnimationFrame(() => {
      state.raf = 0
      if (!drag || !drag.ghost) return
      updateGhostPosition(drag)
      renderCaret(drag)
    })
  }

  function hit(
    x: number,
    y: number,
    preferredSurface?: string,
    interaction?: QuickDrag
  ): { zone: QuickLayoutZone; surface: QuickLayoutSurface } | { tray: HTMLElement } | null {
    const tray = interaction?.tray || panel.querySelector<HTMLElement>('.hqe__tray')
    if (drawerOpen && tray) {
      const rect = interaction?.trayRect || tray.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { tray }
    }
    // 一次拖动只服务一个 surface。跨 surface 的命中必须交给将来的显式桥接，
    // 不能因为面板全高命中区恰好覆盖中央空地，就把“拖到空白处分离”吞成无效投放。
    const orderedSurfaces = preferredSurface
      ? surfaces.filter((surface) => surface.id === preferredSurface)
      : surfaces
    for (const surface of orderedSurfaces) {
      for (const zone of zones.get(surface.id) || []) {
        const rect = zone.hitRect || zone.rect
        if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return { zone, surface }
      }
    }
    return null
  }

  function renderCaret(state: QuickDrag): void {
    const target = hit(state.x, state.y, state.surface, state)
    if (!state.caret || !state.dropPreview) return
    const caretElement = state.caret
    const dropPreviewElement = state.dropPreview
    const hideIndicators = (): void => {
      if (state.tray && state.tray.dataset.drop !== 'false') state.tray.dataset.drop = 'false'
      if (caretElement.style.display !== 'none') caretElement.style.display = 'none'
      if (dropPreviewElement.style.display !== 'none') dropPreviewElement.style.display = 'none'
      state.previewStyleKey = ''
      state.caretStyleKey = ''
    }
    if (!target) {
      hideIndicators()
      return
    }
    if ('tray' in target) {
      if (state.tray && state.tray.dataset.drop !== 'true') state.tray.dataset.drop = 'true'
      if (caretElement.style.display !== 'none') caretElement.style.display = 'none'
      if (dropPreviewElement.style.display !== 'none') dropPreviewElement.style.display = 'none'
      state.previewStyleKey = ''
      state.caretStyleKey = ''
      return
    }
    if (state.tray && state.tray.dataset.drop !== 'false') state.tray.dataset.drop = 'false'
    const preview = state.dropPreview
    const axis = target.zone.axis || 'row'
    const ids = zoneIds(target.surface.id, target.zone.key)
    const positionsKey = `${target.surface.id}\n${target.zone.key}`
    let positions = state.positionsCache.get(positionsKey)
    if (!positions) {
      positions = layoutOfZone(target.zone, ids)
      state.positionsCache.set(positionsKey, positions)
    }
    let index = positions.length
    for (let i = 0; i < positions.length; i += 1) {
      const item = positions[i]
      const center = axis === 'row' ? item.x + item.width / 2 : item.y + item.height / 2
      if ((axis === 'row' ? state.x : state.y) < center) {
        index = i
        break
      }
    }
    const ref = positions[index] || positions[index - 1]
    const fallbackSize = 30
    const previewWidth = Math.max(24, Math.min(
      target.zone.rect.width,
      axis === 'row' ? (ref?.width || fallbackSize) : target.zone.rect.width
    ))
    const previewHeight = Math.max(24, Math.min(
      target.zone.rect.height,
      axis === 'column' ? (ref?.height || fallbackSize) : target.zone.rect.height
    ))
    const previewRect = axis === 'row'
      ? {
          x: Math.max(target.zone.rect.x, Math.min(
            target.zone.rect.x + target.zone.rect.width - previewWidth,
            ref
              ? (index < positions.length ? ref.x : ref.x + ref.width + 5)
              : target.zone.rect.x + 6
          )),
          y: Math.max(target.zone.rect.y, Math.min(
            target.zone.rect.y + target.zone.rect.height - previewHeight,
            ref?.y ?? target.zone.rect.y + 6
          )),
          width: previewWidth,
          height: previewHeight
        }
      : {
          x: Math.max(target.zone.rect.x, Math.min(
            target.zone.rect.x + target.zone.rect.width - previewWidth,
            ref?.x ?? target.zone.rect.x + 6
          )),
          y: Math.max(target.zone.rect.y, Math.min(
            target.zone.rect.y + target.zone.rect.height - previewHeight,
            ref
              ? (index < positions.length ? ref.y : ref.y + ref.height + 5)
              : target.zone.rect.y + 6
          )),
          width: previewWidth,
          height: previewHeight
        }
    const previewKey = `${Math.round(previewRect.x)}:${Math.round(previewRect.y)}:${Math.round(previewRect.width)}:${Math.round(previewRect.height)}`
    if (state.previewStyleKey !== previewKey) {
      preview.style.cssText = `left:${Math.round(previewRect.x)}px;top:${Math.round(previewRect.y)}px;width:${Math.round(previewRect.width)}px;height:${Math.round(previewRect.height)}px;`
      preview.style.display = 'block'
      state.previewStyleKey = previewKey
    }
    const caret = state.caret
    let caretCss: string
    if (axis === 'row') {
      caretCss = `left:${Math.round(ref ? (index < positions.length ? ref.x - 3 : ref.x + ref.width + 2) : target.zone.rect.x + 6)}px;top:${Math.round(ref?.y || target.zone.rect.y + 4)}px;width:2px;height:${Math.max(22, (ref?.height || target.zone.rect.height) - 8)}px;`
    } else {
      caretCss = `left:${Math.round(ref?.x || target.zone.rect.x + 4)}px;top:${Math.round(ref ? (index < positions.length ? ref.y - 3 : ref.y + ref.height + 2) : target.zone.rect.y + 6)}px;width:${Math.max(22, (ref?.width || target.zone.rect.width) - 8)}px;height:2px;`
    }
    if (state.caretStyleKey !== caretCss) {
      caret.style.cssText = caretCss
      caret.style.display = 'block'
      state.caretStyleKey = caretCss
    }
  }

  function onUp(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    // 极快甩动可能在首次 rAF 之前就松手。此时仍按同一套落点逻辑提交，
    // 不能在动画帧尚未执行时把手势静默丢掉。
    if (!state.active && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) >= 5) {
      if (state.activationRaf) {
        cancelAnimationFrame(state.activationRaf)
        state.activationRaf = 0
      }
      try {
        beginVisual(state)
      } catch (error) {
        endDrag()
        setStatus(`无法完成拖动：${(error as Error)?.message || error}`, 'warn')
        return
      }
    }
    if (state.active) {
      const target = hit(event.clientX, event.clientY, state.surface, state)
      endDrag()
      if (target && 'tray' in target) {
        if (state.surface === 'rail-pins') {
          setStatus('固定书签只调整顺序；取消固定请使用右键菜单。', 'warn')
        } else if (state.from === 'zone') remove(state.surface, state.id, state.zone || '')
        else setStatus('这个按钮已经在“更多按钮”中')
      } else if (target && 'zone' in target) {
        moveToZone(state, target.zone, event.clientX, event.clientY)
      } else {
        setStatus('未落入可放置的控件区域')
      }
      return
    }
    endDrag()
  }

  function onCancel(event?: PointerEvent): void {
    const state = drag
    if (!state || (event && event.pointerId !== state.pointerId)) return
    endDrag()
    setStatus('拖动已取消')
  }

  function onWindowBlur(): void {
    onCancel()
  }

  function moveToZone(
    state: QuickDrag,
    zone: QuickLayoutZone,
    x: number,
    y: number
  ): void {
    if (zone.surface !== state.surface) return
    const current = states[state.surface]
    if (!current || !containsId(current, state.id)) return
    const before = copyStates()
    const ids = current.byArea[zone.key] || (current.byArea[zone.key] = [])
    const positions = layoutOfZone(zone, zoneIds(state.surface, zone.key))
    const axis = zone.axis || 'row'
    let index = positions.length
    for (let i = 0; i < positions.length; i += 1) {
      const item = positions[i]
      const center = axis === 'row' ? item.x + item.width / 2 : item.y + item.height / 2
      if ((axis === 'row' ? x : y) < center) {
        index = i
        break
      }
    }
    const previousIndex = ids.indexOf(state.id)
    if (previousIndex >= 0 && previousIndex < index) index -= 1
    detachId(current, state.id)
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, state.id)
    if (sameState(before[state.surface], current)) {
      setStatus('位置未变化')
      return
    }
    pushHistory(before)
    scheduleRender()
    emit(state.surface)
  }

  function endDrag(): void {
    const state = drag
    drag = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('resize', onWindowBlur)
    if (!state) return
    if (state.active) {
      try { options.onDragState?.(false) } catch (_) {}
    }
    doc.body.style.cursor = ''
    if (state.raf) cancelAnimationFrame(state.raf)
    if (state.activationRaf) cancelAnimationFrame(state.activationRaf)
    state.ghost?.remove()
    state.caret?.remove()
    state.dropPreview?.remove()
    state.chip.dataset.dragging = 'false'
    if (state.tray) state.tray.dataset.drop = 'false'
    try { state.chip.releasePointerCapture(state.pointerId) } catch (_) {}
    if (renderDeferred) {
      renderDeferred = false
      scheduleRender()
    }
  }

  const finishEditing = (): void => {
    closeChoiceMenu?.()
    flushPendingCommits()
    options.onFinish()
  }
  saveFooter.addEventListener('click', finishEditing)
  undoFooter.addEventListener('click', undo)
  redoFooter.addEventListener('click', redo)
  const cancelEditing = (): void => {
    closeChoiceMenu?.()
    if (commitFrame) {
      cancelAnimationFrame(commitFrame)
      commitFrame = 0
    }
    if (commitTimer) {
      window.clearTimeout(commitTimer)
      commitTimer = 0
    }
    pendingCommitSurfaces.clear()
    const previous = copyStates()
    for (const [key, value] of Object.entries(initialStates)) states[key] = copyStates({ [key]: value })[key]
    render()
    void commitAllChanged(previous).finally(() => options.onFinish())
  }
  cancelFooter.addEventListener('click', cancelEditing)

  const onKey = (event: KeyboardEvent): void => {
    const modifier = event.ctrlKey || event.metaKey
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
      return
    }
    if (event.key !== 'Escape') return
    if (closeChoiceMenu) {
      event.preventDefault()
      closeChoiceMenu()
      return
    }
    if (drag?.active) {
      endDrag()
      setStatus('已取消拖动')
      return
    }
    finishEditing()
  }
  window.addEventListener('keydown', onKey)
  render()
  updateHistoryButtons()

  return {
    element: root,
    setZones(payload): void {
      const nextZones = payload.segments.map((zone) => ({
        ...zone,
        surface: payload.surface
      }))
      const nextSignature = zoneSignature(nextZones)
      if (zoneSignatures.get(payload.surface) === nextSignature) return
      zoneSignatures.set(payload.surface, nextSignature)
      zoneRevision += 1
      zones.set(payload.surface, nextZones)
      drag?.positionsCache.clear()
      scheduleSceneRender()
      if (category === 'controls') scheduleTrayRender()
    },
    setState(surfaceId, state): void {
      const nextState = {
        byArea: Object.fromEntries(Object.entries(state.byArea).map(([area, ids]) => [area, ids.slice()])),
        hidden: state.hidden.slice(),
        compact: state.compact === true
      }
      if (sameState(states[surfaceId], nextState)) return
      states[surfaceId] = nextState
      const surface = surfaces.find((item) => item.id === surfaceId)
      if (surface) {
        for (const area of Object.keys(state.byArea)) {
          if (!surface.areas.some((item) => item.key === area)) {
            surface.areas.push({ key: area, label: area })
          }
        }
      }
      scheduleRender()
    },
    setBarSettings(nextBars): void {
      barSettings = nextBars.map((bar) => ({
        ...bar,
        settings: bar.settings.map((setting) => ({
          ...setting,
          options: setting.options?.map((option) => ({ ...option }))
        }))
      }))
      lastTraySignature = ''
      if (category === 'bars') scheduleTrayRender()
    },
    setStatus,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      closeChoiceMenu?.()
      endDrag()
      flushPendingCommits()
      if (renderFrame) cancelAnimationFrame(renderFrame)
      if (trayFrame) cancelAnimationFrame(trayFrame)
      if (commitFrame) {
        cancelAnimationFrame(commitFrame)
        commitFrame = 0
      }
      if (commitTimer) {
        window.clearTimeout(commitTimer)
        commitTimer = 0
      }
      pendingCommitSurfaces.clear()
      sceneItems.clear()
      zoneSignatures.clear()
      window.removeEventListener('keydown', onKey)
      saveFooter.removeEventListener('click', finishEditing)
      undoFooter.removeEventListener('click', undo)
      redoFooter.removeEventListener('click', redo)
      cancelFooter.removeEventListener('click', cancelEditing)
      root.remove()
    }
  }
}

interface DragState {
  startX: number
  startY: number
  x: number
  y: number
  pointerId: number
  nodeId?: string
  descriptor?: StudioBlockDescriptor
  sourceEl: HTMLElement
  active: boolean
  ghost: HTMLElement | null
  zoneEl: HTMLElement | null
  caret: HTMLElement | null
  raf: number
}

interface TaskTemplate {
  id: string
  name: string
  note: string
  tags: string[]
  create: () => LayoutDocument
}

const FAMILY_LABELS: Array<[StudioFamily, string]> = [
  ['templates', '模板'],
  ['layout', '栏与列'],
  ['controls', '控件'],
  ['tabs', '标签'],
  ['panels', '面板'],
  ['bookmarks', '收藏'],
  ['content', '内容']
]

const ICON_FALLBACK: Record<StudioFamily, string> = {
  templates: 'T',
  layout: 'L',
  controls: 'C',
  tabs: '≡',
  panels: 'P',
  bookmarks: 'B',
  content: 'W'
}

const HISTORY_LIMIT = 60
function html<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag)
  if (className) element.className = className
  return element
}

function templateDocument(id: string): LayoutDocument {
  const doc: LayoutDocument = createDefaultLayoutDocument()
  const left = findNode(doc.root, 'dock-left')
  const right = findNode(doc.root, 'dock-right')
  const main = findNode(doc.root, 'main-column')
  if (id === 'blank') {
    doc.name = '空白布局'
    if (left) (left as LayoutFrame).children = []
    if (right) (right as LayoutFrame).children = []
    if (main && main.type === 'frame') {
      const content = main.children.find((node) => node.type === 'block' && node.blockId === 'content.main')
      main.children = content ? [content] : []
    }
  } else if (id === 'sidebar') {
    doc.name = '原味侧栏'
    if (left) (left as LayoutFrame).sizing = { basis: 72, unit: 'px', min: 56, max: 96, shrink: 0 }
    if (right) (right as LayoutFrame).children = []
  } else if (id === 'vertical') {
    doc.name = '竖向导航'
    if (left) {
      ;(left as LayoutFrame).sizing = { basis: 248, unit: 'px', min: 168, max: 420, shrink: 0 }
      ;(left as LayoutFrame).children.push(createBlock('navbar.address', {
        sizing: { basis: 1, unit: 'fraction', grow: 1 }
      }))
    }
    if (right) (right as LayoutFrame).children = []
  } else if (id === 'research') {
    doc.name = '研究工作区'
    if (right) {
      ;(right as LayoutFrame).sizing = { basis: 340, unit: 'px', min: 240, max: 620, shrink: 0 }
    }
  } else if (id === 'focus') {
    doc.name = '极简专注'
    if (left) (left as LayoutFrame).collapse = { ...(left as LayoutFrame).collapse!, default: 'collapsed' }
    if (right) (right as LayoutFrame).collapse = { ...(right as LayoutFrame).collapse!, default: 'hidden' }
  } else if (id === 'bottom') {
    doc.name = '底部应用坞'
    if (left) (left as LayoutFrame).children = []
    if (main && main.type === 'frame') {
      main.children.push(createFrame('bar', 'row', [
        createBlock('rail.panel.favorites', { sizing: { basis: 32, unit: 'px' } }),
        createBlock('rail.panel.history', { sizing: { basis: 32, unit: 'px' } }),
        createBlock('rail.panel.downloads', { sizing: { basis: 32, unit: 'px' } }),
        createBlock('rail.panel.notes', { sizing: { basis: 32, unit: 'px' } })
      ], {
        id: `bottom-dock-${Date.now()}`,
        label: '底部应用坞',
        gap: 8,
        padding: 8,
        sizing: { basis: 48, unit: 'px', min: 40, max: 72, shrink: 0 },
        collapse: { enabled: true, default: 'expanded', mode: 'off-canvas', trigger: 'manual' }
      }))
    }
  } else {
    doc.name = '经典布局'
  }
  doc.metadata.templateId = id
  return doc
}

const TEMPLATES: TaskTemplate[] = [
  { id: 'classic', name: '经典', note: '顶部标签与导航，左右工具区按需展开。', tags: ['顶部导航', '通用'], create: () => templateDocument('classic') },
  { id: 'sidebar', name: '原味侧栏', note: '工具与应用固定在左侧，内容区更宽。', tags: ['左栏', '应用'], create: () => templateDocument('sidebar') },
  { id: 'vertical', name: '竖向导航', note: '导航与标签收进左侧，适合长时间阅读。', tags: ['竖向', '专注'], create: () => templateDocument('vertical') },
  { id: 'research', name: '研究工作区', note: '左侧工具、中央内容、右侧固定研究面板。', tags: ['双栏', '面板'], create: () => templateDocument('research') },
  { id: 'focus', name: '极简专注', note: '两侧默认收起，只保留内容与一条顶部栏。', tags: ['专注', '极简'], create: () => templateDocument('focus') },
  { id: 'bottom', name: '底部应用坞', note: '把常用工具放到内容下方，释放横向空间。', tags: ['底栏', '应用'], create: () => templateDocument('bottom') },
  { id: 'blank', name: '空白布局', note: '从内容区开始，自行决定每一栏。', tags: ['自定义', '空白'], create: () => templateDocument('blank') }
]

export function createLayoutStudio(options: LayoutStudioOptions): LayoutStudio {
  const doc = document
  const root = html(doc, 'div', 'hse')
  const undoStack: LayoutDocument[] = []
  const redoStack: LayoutDocument[] = []
  let current = cloneDocument(options.document)
  let descriptors = [...options.blocks]
  let viewport = options.viewport || { width: 1440, height: 900 }
  let selectedId: string | null = null
  let filter = ''
  let family: StudioFamily = 'layout'
  let drag: DragState | null = null
  let destroyed = false

  const style = html(doc, 'style')
  style.textContent = `
    .hse{--hse-bg:#edf1f5;--hse-panel:#fbfcfd;--hse-card:#fff;--hse-text:#17202a;--hse-sub:#667085;--hse-faint:#98a2b3;--hse-line:#d9e0e7;--hse-soft:#f2f5f8;--hse-accent:#0f766e;--hse-accent-soft:#e7f5f2;--hse-warn:#b45309;position:fixed;inset:0;z-index:var(--hira-z-max);background:var(--hse-bg);color:var(--hse-text);font:13px/1.45 "Segoe UI",system-ui,sans-serif;display:grid;grid-template-rows:68px minmax(0,1fr) 42px;user-select:none;overflow:hidden}
    html[data-theme="dark"] .hse{--hse-bg:#161a1f;--hse-panel:#1c2127;--hse-card:#222830;--hse-text:#eef2f6;--hse-sub:#a6b0bd;--hse-faint:#748090;--hse-line:#333c47;--hse-soft:#252c34;--hse-accent:#58b5a8;--hse-accent-soft:#1f3b38}
    .hse *{box-sizing:border-box}.hse button,.hse input,.hse select{font:inherit}.hse button{color:inherit}
    .hse__head{display:grid;grid-template-columns:minmax(220px,1fr) auto minmax(260px,1fr);align-items:center;gap:20px;padding:12px 20px;background:var(--hse-panel);border-bottom:1px solid var(--hse-line)}
    .hse__brand{display:flex;align-items:center;gap:10px;min-width:0}.hse__mark{width:34px;height:34px;border-radius:9px;background:var(--hse-accent);display:grid;place-items:center;color:#fff;font-weight:800}.hse__brand strong{display:block;font-size:14px}.hse__brand span{display:block;color:var(--hse-sub);font-size:11px}
    .hse__modes{display:flex;background:var(--hse-soft);padding:3px;border-radius:10px}.hse__mode{border:0;background:transparent;border-radius:8px;padding:7px 13px;color:var(--hse-sub);cursor:pointer}.hse__mode[aria-pressed="true"]{background:var(--hse-card);color:var(--hse-text);box-shadow:0 1px 3px rgba(16,24,40,.08)}
    .hse__actions{display:flex;justify-content:flex-end;gap:8px}.hse__btn{height:34px;border:1px solid var(--hse-line);background:var(--hse-card);border-radius:9px;padding:0 12px;cursor:pointer;white-space:nowrap}.hse__btn:hover{border-color:var(--hse-accent)}.hse__btn:disabled{opacity:.42;cursor:default}.hse__btn--primary{background:var(--hse-accent);border-color:var(--hse-accent);color:#fff}
    .hse__body{min-height:0;display:grid;grid-template-columns:286px minmax(0,1fr) 304px}.hse__side{min-height:0;background:var(--hse-panel);overflow:auto}.hse__side--left{border-right:1px solid var(--hse-line)}.hse__side--right{border-left:1px solid var(--hse-line)}
    .hse__sideHead{position:sticky;top:0;z-index:var(--hira-z-elevated);background:var(--hse-panel);padding:16px 18px 12px;border-bottom:1px solid var(--hse-line)}.hse__sideHead h2{margin:0 0 3px;font-size:14px}.hse__sideHead p{margin:0;color:var(--hse-sub);font-size:11px}
    .hse__search{margin-top:12px;position:relative}.hse__search input{width:100%;height:34px;border:1px solid var(--hse-line);border-radius:9px;background:var(--hse-soft);padding:0 30px 0 10px;outline:none}.hse__search input:focus{border-color:var(--hse-accent);background:var(--hse-card)}.hse__search:after{content:'⌕';position:absolute;right:10px;top:7px;color:var(--hse-faint);font-size:16px}
    .hse__filters{display:flex;gap:4px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--hse-line)}.hse__filter{border:0;background:transparent;border-radius:7px;padding:5px 8px;color:var(--hse-sub);cursor:pointer}.hse__filter[aria-pressed="true"]{background:var(--hse-accent-soft);color:var(--hse-accent);font-weight:650}
    .hse__library{padding:12px}.hse__group{margin-bottom:18px}.hse__group h3{margin:0 0 8px;color:var(--hse-sub);font-size:11px;letter-spacing:.04em;text-transform:uppercase}.hse__blockGrid{display:grid;gap:7px}.hse__blockCard{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:9px;width:100%;min-height:48px;border:1px solid var(--hse-line);background:var(--hse-card);border-radius:10px;padding:7px 9px;text-align:left;cursor:grab;touch-action:none}.hse__blockCard:hover{border-color:var(--hse-accent)}.hse__blockCard[data-unavailable="true"]{opacity:.5}.hse__blockIcon{width:32px;height:32px;border-radius:8px;background:var(--hse-soft);display:grid;place-items:center;color:var(--hse-accent);font-weight:750;overflow:hidden}.hse__blockIcon svg{display:block}.hse__blockName{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hse__blockNote{font-size:11px;color:var(--hse-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hse__dragHint{color:var(--hse-faint);font-size:16px}
    .hse__canvasHost{min-width:0;min-height:0;padding:22px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:12px;overflow:auto}.hse__canvasHead{display:flex;align-items:center;justify-content:space-between;gap:12px}.hse__canvasHead h1{margin:0;font-size:16px}.hse__canvasHead p{margin:2px 0 0;color:var(--hse-sub);font-size:11px}.hse__viewBadges{display:flex;gap:6px}.hse__badge{border:1px solid var(--hse-line);background:var(--hse-card);border-radius:999px;padding:5px 9px;color:var(--hse-sub);font-size:10px}
    .hse__canvasFrame{min-height:430px;background:#dce3ea;border-radius:15px;padding:18px;display:flex;align-items:center;justify-content:center;overflow:hidden}.hse__browser{background:var(--hse-card);border:1px solid #c9d2dc;border-radius:13px;box-shadow:0 12px 34px rgba(32,44,58,.14);overflow:hidden;width:100%;height:100%;min-height:390px;max-width:1120px;max-height:720px}.hse__tree{height:100%;display:flex;min-width:0;min-height:0}
    .hse__frame{position:relative;display:flex;min-width:0;min-height:0;border:1px solid transparent;transition:border-color .12s ease,background .12s ease}.hse__frame[data-selected="true"]{border-color:var(--hse-accent);background:rgba(15,118,110,.035)}.hse__frame[data-drop="true"]{border-color:var(--hse-accent);background:var(--hse-accent-soft)}.hse__frame--row{flex-direction:row}.hse__frame--column{flex-direction:column}.hse__frameLabel{position:absolute;top:3px;left:5px;z-index:var(--hira-z-elevated);background:var(--hse-panel);color:var(--hse-sub);font-size:9px;padding:2px 5px;border-radius:4px;pointer-events:none;opacity:.85}.hse__frame[data-role="root"]{border:0}.hse__frame[data-role="dock"],.hse__frame[data-role="custom-column"]{background:#f8fafb}.hse__frame[data-role="bar"]{background:#f5f8fa}.hse__frame[data-role="panel-group"]{background:#f8fafb}
    .hse__node{position:relative;min-width:22px;min-height:22px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border:1px solid var(--hse-line);border-radius:8px;background:var(--hse-card);color:var(--hse-sub);cursor:grab;touch-action:none;overflow:hidden}.hse__node:hover{border-color:var(--hse-accent);color:var(--hse-accent)}.hse__node[data-selected="true"]{border-color:var(--hse-accent);box-shadow:0 0 0 2px var(--hse-accent-soft);color:var(--hse-accent)}.hse__node[data-block="content.main"]{flex:1;border-radius:9px;border-style:dashed;background:linear-gradient(180deg,#f7f9fb,#eef2f6);align-items:flex-start;justify-content:flex-start;padding:24px;min-width:120px;min-height:120px}.hse__node[data-block="tabs.strip"]{flex:1;justify-content:flex-start;padding:0 9px}.hse__node[data-block="navbar.address"]{flex:1;justify-content:flex-start;padding:0 10px;background:var(--hse-soft)}.hse__node[data-block^="panel."]{flex:1;align-self:stretch;align-items:flex-start;justify-content:flex-start;padding:14px;background:var(--hse-card)}.hse__node[data-block^="rail."]{width:38px;height:38px}.hse__node svg{max-width:18px;max-height:18px}.hse__nodeText{font-size:10px;color:var(--hse-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.hse__contentPreview{display:flex;flex-direction:column;gap:8px;width:100%;color:var(--hse-sub)}.hse__contentTitle{font-size:13px;font-weight:700;color:var(--hse-text)}.hse__skeleton{height:8px;border-radius:4px;background:#e6ebf0}.hse__skeleton--wide{width:82%}.hse__skeleton--medium{width:64%}
    .hse__empty{display:grid;place-items:center;min-height:76px;min-width:56px;border:1px dashed var(--hse-line);border-radius:8px;margin:5px;color:var(--hse-faint);font-size:10px;pointer-events:none;flex:1}
    .hse__inspector{padding:16px 16px 28px}.hse__selection{margin:14px 0 16px;padding:11px;border:1px solid var(--hse-line);border-radius:10px;background:var(--hse-soft)}.hse__selection strong{display:block;font-size:12px}.hse__selection span{display:block;margin-top:2px;color:var(--hse-sub);font-size:10px;word-break:break-all}
    .hse__field{margin-bottom:12px}.hse__field label{display:flex;justify-content:space-between;gap:8px;margin-bottom:5px;color:var(--hse-sub);font-size:10px}.hse__field input,.hse__field select{width:100%;height:34px;border:1px solid var(--hse-line);border-radius:8px;background:var(--hse-card);padding:0 9px;outline:none}.hse__field input:focus,.hse__field select:focus{border-color:var(--hse-accent)}.hse__segmented{display:flex;gap:3px;padding:3px;background:var(--hse-soft);border-radius:9px}.hse__segmented button{flex:1;height:28px;border:0;border-radius:7px;background:transparent;color:var(--hse-sub);cursor:pointer}.hse__segmented button[aria-pressed="true"]{background:var(--hse-card);color:var(--hse-text);box-shadow:0 1px 2px rgba(16,24,40,.08)}
    .hse__hint{border-top:1px solid var(--hse-line);margin-top:18px;padding-top:14px;color:var(--hse-sub);font-size:11px;line-height:1.7}.hse__danger{width:100%;height:34px;border:1px solid var(--hse-line);border-radius:8px;background:var(--hse-card);cursor:pointer;color:#b42318}
    .hse__foot{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 18px;background:var(--hse-panel);border-top:1px solid var(--hse-line);color:var(--hse-sub);font-size:11px}.hse__status{display:flex;align-items:center;gap:7px}.hse__statusDot{width:6px;height:6px;border-radius:50%;background:var(--hse-accent)}.hse__status[data-tone="warn"] .hse__statusDot{background:var(--hse-warn)}.hse__ghost{position:fixed;z-index:var(--hira-z-max);pointer-events:none;min-width:76px;height:32px;border:1px solid var(--hse-accent);border-radius:8px;background:var(--hse-card);color:var(--hse-text);display:flex;align-items:center;gap:7px;padding:0 9px;box-shadow:0 10px 26px rgba(16,24,40,.2);transform:scale(1.02)}.hse__ghost svg{max-width:18px;max-height:18px}.hse__caret{position:fixed;z-index:var(--hira-z-max);background:var(--hse-accent);border-radius:2px;pointer-events:none}
    .hse__templateGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.hse__template{border:1px solid var(--hse-line);background:var(--hse-card);border-radius:10px;padding:8px;text-align:left;cursor:pointer}.hse__template:hover{border-color:var(--hse-accent)}.hse__mini{width:100%;height:74px;border-radius:7px;background:var(--hse-soft);display:block;margin-bottom:7px}.hse__template strong{display:block;font-size:11px}.hse__template span{display:block;color:var(--hse-sub);font-size:10px;margin-top:2px;line-height:1.35}
    @media(max-width:1120px){.hse__body{grid-template-columns:250px minmax(0,1fr) 272px}.hse__head{grid-template-columns:minmax(180px,1fr) auto auto}.hse__canvasHost{padding:16px}.hse__browser{min-height:330px}}
    @media(max-width:860px){.hse__body{grid-template-columns:220px minmax(0,1fr)}.hse__side--right{display:none}.hse__head{grid-template-columns:1fr auto}.hse__modes{display:none}.hse__canvasHost{padding:12px}.hse__templateGrid{grid-template-columns:1fr}}
  `
  root.appendChild(style)

  const head = html(doc, 'header', 'hse__head')
  const brand = html(doc, 'div', 'hse__brand')
  const mark = html(doc, 'div', 'hse__mark')
  mark.textContent = 'H'
  const titleWrap = html(doc, 'div')
  const title = html(doc, 'strong')
  title.textContent = '布局工坊'
  const subtitle = html(doc, 'span')
  subtitle.textContent = `正在编辑：${current.name}`
  titleWrap.append(title, subtitle)
  brand.append(mark, titleWrap)
  const modes = html(doc, 'div', 'hse__modes')
  modes.innerHTML = '<button class="hse__mode" type="button" aria-pressed="true">设计画布</button><button class="hse__mode" type="button">结构</button><button class="hse__mode" type="button">预览</button>'
  const headActions = html(doc, 'div', 'hse__actions')
  const undoBtn = html(doc, 'button', 'hse__btn')
  undoBtn.type = 'button'
  undoBtn.textContent = '撤销'
  undoBtn.disabled = true
  const redoBtn = html(doc, 'button', 'hse__btn')
  redoBtn.type = 'button'
  redoBtn.textContent = '重做'
  redoBtn.disabled = true
  const resetBtn = html(doc, 'button', 'hse__btn')
  resetBtn.type = 'button'
  resetBtn.textContent = '恢复默认'
  const saveBtn = html(doc, 'button', 'hse__btn hse__btn--primary')
  saveBtn.type = 'button'
  saveBtn.textContent = '保存布局'
  headActions.append(undoBtn, redoBtn, resetBtn, saveBtn)
  head.append(brand, modes, headActions)

  const body = html(doc, 'div', 'hse__body')
  const leftSide = html(doc, 'aside', 'hse__side hse__side--left')
  const leftHead = html(doc, 'div', 'hse__sideHead')
  leftHead.innerHTML = '<h2>构件库</h2><p>拖动到画布中的可用区域</p>'
  const searchWrap = html(doc, 'div', 'hse__search')
  const searchInput = html(doc, 'input')
  searchInput.type = 'search'
  searchInput.placeholder = '搜索构件'
  searchInput.setAttribute('aria-label', '搜索构件')
  searchWrap.appendChild(searchInput)
  leftHead.appendChild(searchWrap)
  const filterBar = html(doc, 'div', 'hse__filters')
  for (const [id, label] of FAMILY_LABELS) {
    const button = html(doc, 'button', 'hse__filter')
    button.type = 'button'
    button.dataset.family = id
    button.textContent = label
    button.setAttribute('aria-pressed', String(family === id))
    button.addEventListener('click', () => {
      family = id
      for (const item of filterBar.querySelectorAll<HTMLElement>('.hse__filter')) {
        item.setAttribute('aria-pressed', String(item.dataset.family === id))
      }
      renderLibrary()
    })
    filterBar.appendChild(button)
  }
  const library = html(doc, 'div', 'hse__library')
  leftSide.append(leftHead, filterBar, library)

  const canvasHost = html(doc, 'main', 'hse__canvasHost')
  const canvasHead = html(doc, 'div', 'hse__canvasHead')
  const canvasTitle = html(doc, 'div')
  const h1 = html(doc, 'h1')
  h1.textContent = '浏览器布局'
  const p = html(doc, 'p')
  p.textContent = '拖入、重排、改尺寸；保存后应用到当前窗口。'
  canvasTitle.append(h1, p)
  const viewBadges = html(doc, 'div', 'hse__viewBadges')
  const viewportBadge = html(doc, 'span', 'hse__badge')
  viewportBadge.textContent = `${viewport.width} × ${viewport.height}`
  const safeBadge = html(doc, 'span', 'hse__badge')
  safeBadge.textContent = '本地草稿'
  viewBadges.append(viewportBadge, safeBadge)
  canvasHead.append(canvasTitle, viewBadges)
  const canvasFrame = html(doc, 'section', 'hse__canvasFrame')
  const browser = html(doc, 'div', 'hse__browser')
  const treeHost = html(doc, 'div', 'hse__tree')
  browser.appendChild(treeHost)
  canvasFrame.appendChild(browser)
  canvasHost.append(canvasHead, canvasFrame)

  const rightSide = html(doc, 'aside', 'hse__side hse__side--right')
  const rightHead = html(doc, 'div', 'hse__sideHead')
  rightHead.innerHTML = '<h2>检查器</h2><p>只显示当前构件真正支持的选项</p>'
  const inspector = html(doc, 'div', 'hse__inspector')
  rightSide.append(rightHead, inspector)
  body.append(leftSide, canvasHost, rightSide)

  const foot = html(doc, 'footer', 'hse__foot')
  const status = html(doc, 'div', 'hse__status')
  const statusDot = html(doc, 'span', 'hse__statusDot')
  const statusText = html(doc, 'span')
  statusText.textContent = '布局草稿已就绪'
  status.append(statusDot, statusText)
  const shortcuts = html(doc, 'div')
  shortcuts.textContent = 'Esc 退出 · Ctrl+Z 撤销 · 拖动时按 Esc 取消'
  foot.append(status, shortcuts)
  root.append(head, body, foot)

  const onSearch = (): void => {
    filter = searchInput.value.trim().toLowerCase()
    renderLibrary()
  }
  searchInput.addEventListener('input', onSearch)

  const onModeClick = (event: Event): void => {
    const button = (event.target as Element).closest<HTMLElement>('.hse__mode')
    if (!button) return
    for (const item of modes.querySelectorAll<HTMLElement>('.hse__mode')) {
      item.setAttribute('aria-pressed', String(item === button))
    }
    const mode = button.textContent || ''
    if (mode === '结构') root.dataset.view = 'structure'
    else if (mode === '预览') root.dataset.view = 'preview'
    else delete root.dataset.view
  }
  modes.addEventListener('click', onModeClick)

  function descriptorOf(blockId: string): StudioBlockDescriptor | null {
    return descriptors.find((item) => item.id === blockId) || null
  }

  function labelOf(node: LayoutNode): string {
    if (node.type === 'block') return descriptorOf(node.blockId)?.label || node.blockId
    if (node.type === 'divider') return '分隔线'
    if (node.type === 'spacer') return '间隔'
    if (node.type !== 'frame') return ''
    if (node.label) return node.label
    const roleLabels: Record<LayoutFrame['role'], string> = {
      root: '窗口',
      bar: '栏',
      dock: '停靠区',
      column: '列',
      'panel-group': '面板组',
      'toolbar-group': '工具组',
      tray: '抽屉',
      'custom-column': '自定义列'
    }
    return roleLabels[node.role]
  }

  function makeIcon(descriptor: StudioBlockDescriptor | null, size = 18): Node {
    if (descriptor?.icon) {
      try {
        const icon = descriptor.icon(doc, { size })
        if (icon) return icon
      } catch (_) {}
    }
    const fallback = html(doc, 'span')
    fallback.textContent = ICON_FALLBACK[descriptor?.family || 'layout'] || '·'
    fallback.style.fontSize = `${Math.max(11, size - 3)}px`
    return fallback
  }

  function blockCard(descriptor: StudioBlockDescriptor): HTMLElement {
    const card = html(doc, 'button', 'hse__blockCard')
    card.type = 'button'
    card.dataset.blockId = descriptor.id
    card.dataset.unavailable = String(descriptor.available === false)
    const icon = html(doc, 'span', 'hse__blockIcon')
    icon.appendChild(makeIcon(descriptor))
    const copy = html(doc, 'span')
    const name = html(doc, 'span', 'hse__blockName')
    name.textContent = descriptor.label
    const note = html(doc, 'span', 'hse__blockNote')
    note.textContent = descriptor.description || descriptor.source || '拖入布局'
    copy.append(name, note)
    const hint = html(doc, 'span', 'hse__dragHint')
    hint.textContent = '⋮⋮'
    card.append(icon, copy, hint)
    card.addEventListener('pointerdown', (event) => beginDrag(event, card, null, descriptor))
    return card
  }

  function templateMini(document: LayoutDocument): HTMLElement {
    const wrap = html(doc, 'span', 'hse__mini')
    try {
      const resolved = buildMiniMap(document, 180, 74)
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 180 74')
      svg.setAttribute('width', '100%')
      svg.setAttribute('height', '100%')
      const paint = (node: ResolvedNode): void => {
        const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect')
        rect.setAttribute('x', String(node.rect.x / Math.max(1, resolved.root.rect.width) * 180 + 1))
        rect.setAttribute('y', String(node.rect.y / Math.max(1, resolved.root.rect.height) * 74 + 1))
        rect.setAttribute('width', String(Math.max(1, node.rect.width / Math.max(1, resolved.root.rect.width) * 180 - 2)))
        rect.setAttribute('height', String(Math.max(1, node.rect.height / Math.max(1, resolved.root.rect.height) * 74 - 2)))
        rect.setAttribute('rx', '2')
        rect.setAttribute('fill', node.type === 'block' && node.blockId === 'content.main' ? '#dce8e5' : node.type === 'frame' ? '#c8d2dc' : '#9eb0bf')
        rect.setAttribute('opacity', String(node.type === 'frame' ? 0.55 : 0.9))
        svg.appendChild(rect)
        node.children.forEach(paint)
      }
      resolved.root.children.forEach(paint)
      wrap.appendChild(svg)
    } catch (_) {}
    return wrap
  }

  function renderTemplates(): void {
    const section = html(doc, 'section', 'hse__group')
    const heading = html(doc, 'h3')
    heading.textContent = '从模板开始'
    const grid = html(doc, 'div', 'hse__templateGrid')
    for (const template of TEMPLATES) {
      if (filter && !`${template.name} ${template.note} ${template.tags.join(' ')}`.toLowerCase().includes(filter)) continue
      const button = html(doc, 'button', 'hse__template')
      button.type = 'button'
      button.appendChild(templateMini(template.create()))
      const name = html(doc, 'strong')
      name.textContent = template.name
      const note = html(doc, 'span')
      note.textContent = template.note
      button.append(name, note)
      button.addEventListener('click', () => {
        replaceDocument(template.create(), '模板：' + template.name)
      })
      grid.appendChild(button)
    }
    if (grid.childElementCount) section.append(heading, grid)
    if (section.childElementCount) library.appendChild(section)
  }

  function renderLibrary(): void {
    library.replaceChildren()
    if (family === 'templates') {
      renderTemplates()
      return
    }
    const visible = descriptors.filter((descriptor) => {
      if (descriptor.family !== family) return false
      if (!filter) return true
      return `${descriptor.label} ${descriptor.description || ''} ${descriptor.source || ''}`.toLowerCase().includes(filter)
    })
    if (!visible.length && filter) {
      renderTemplates()
      if (!library.childElementCount) {
        const empty = html(doc, 'div', 'hse__hint')
        empty.textContent = '没有匹配的构件。'
        library.appendChild(empty)
      }
      return
    }
    const section = html(doc, 'section', 'hse__group')
    const heading = html(doc, 'h3')
    heading.textContent = FAMILY_LABELS.find(([id]) => id === family)?.[1] || '构件'
    const grid = html(doc, 'div', 'hse__blockGrid')
    for (const descriptor of visible) grid.appendChild(blockCard(descriptor))
    section.append(heading, grid)
    library.appendChild(section)
  }

  function frameElement(node: LayoutFrame): HTMLElement {
    const element = html(doc, 'div', `hse__frame hse__frame--${node.axis}`)
    element.dataset.layoutFrame = node.id
    element.dataset.layoutNode = node.id
    element.dataset.role = node.role
    element.dataset.axis = node.axis
    element.style.flexDirection = node.axis === 'row' ? 'row' : 'column'
    element.style.gap = `${Math.max(0, Number(node.gap) || 0)}px`
    element.style.padding = `${Math.max(0, Number(node.padding) || 0)}px`
    if (node.role === 'root') {
      element.style.width = '100%'
      element.style.height = '100%'
    } else if (node.role === 'dock' || node.role === 'custom-column' || node.role === 'panel-group' || node.role === 'toolbar-group') {
      const basis = Number(node.sizing?.basis) || 56
      if (node.axis === 'row') {
        element.style.width = `${basis}px`
        element.style.height = '100%'
      } else {
        element.style.width = '100%'
        element.style.height = basis > 80 ? '100%' : `${Math.max(44, basis)}px`
      }
      element.style.flexShrink = '0'
    } else if (node.role === 'bar') {
      element.style.height = `${Math.max(36, Number(node.sizing?.basis) || 54)}px`
      element.style.width = '100%'
      element.style.flexShrink = '0'
    } else if (node.role === 'column') {
      element.style.flex = '1 1 0'
      element.style.height = '100%'
    }
    element.dataset.selected = String(selectedId === node.id)
    const label = html(doc, 'span', 'hse__frameLabel')
    label.textContent = labelOf(node)
    element.appendChild(label)
    element.addEventListener('pointerdown', (event) => {
      if (event.target === element || (event.target as Element).classList.contains('hse__frameLabel')) {
        selectedId = node.id
        renderCanvas()
        renderInspector()
      }
    })
    for (const child of node.children) element.appendChild(renderNode(child))
    if (!node.children.length && node.role !== 'root') {
      const empty = html(doc, 'div', 'hse__empty')
      empty.textContent = node.role === 'panel-group' ? '拖入面板' : '拖入构件'
      element.appendChild(empty)
    }
    return element
  }

  function blockElement(node: Extract<LayoutNode, { type: 'block' }>): HTMLElement {
    const descriptor = descriptorOf(node.blockId)
    const element = html(doc, 'button', 'hse__node')
    element.type = 'button'
    element.dataset.layoutNode = node.id
    element.dataset.block = node.blockId
    element.dataset.selected = String(selectedId === node.id)
    element.title = labelOf(node)
    if (node.blockId === 'content.main') {
      const preview = html(doc, 'div', 'hse__contentPreview')
      const previewTitle = html(doc, 'div', 'hse__contentTitle')
      previewTitle.textContent = '网页内容区'
      const line1 = html(doc, 'div', 'hse__skeleton hse__skeleton--wide')
      const line2 = html(doc, 'div', 'hse__skeleton hse__skeleton--medium')
      preview.append(previewTitle, line1, line2)
      element.appendChild(preview)
    } else {
      element.appendChild(makeIcon(descriptor, node.blockId.startsWith('panel.') ? 20 : 16))
      if (node.blockId.startsWith('tabs.strip') || node.blockId.startsWith('navbar.address') || node.blockId.startsWith('panel.')) {
        const text = html(doc, 'span', 'hse__nodeText')
        text.style.marginLeft = '6px'
        text.textContent = labelOf(node)
        element.appendChild(text)
      }
    }
    if (node.visibility === 'collapsed') element.style.opacity = '.55'
    element.addEventListener('click', (event) => {
      event.stopPropagation()
      selectedId = node.id
      renderCanvas()
      renderInspector()
    })
    element.addEventListener('pointerdown', (event) => beginDrag(event, element, node.id, descriptor || undefined))
    return element
  }

  function spacerElement(node: Extract<LayoutNode, { type: 'spacer' | 'divider' }>): HTMLElement {
    const element = html(doc, 'div', 'hse__node')
    element.dataset.layoutNode = node.id
    element.dataset.selected = String(selectedId === node.id)
    element.style[element.style.width ? 'width' : 'height'] = node.type === 'divider' ? '1px' : '8px'
    element.style.minWidth = node.type === 'divider' ? '1px' : '8px'
    element.style.minHeight = node.type === 'divider' ? '1px' : '8px'
    element.style.background = node.type === 'divider' ? 'var(--hse-line)' : 'transparent'
    element.style.border = node.type === 'divider' ? '0' : '1px dashed var(--hse-line)'
    element.addEventListener('pointerdown', (event) => beginDrag(event, element, node.id, undefined))
    element.addEventListener('click', (event) => {
      event.stopPropagation()
      selectedId = node.id
      renderCanvas()
      renderInspector()
    })
    return element
  }

  function renderNode(node: LayoutNode): HTMLElement {
    if (node.type === 'frame') return frameElement(node)
    if (node.type === 'block') return blockElement(node)
    return spacerElement(node)
  }

  function renderCanvas(): void {
    treeHost.replaceChildren(renderNode(current.root))
    subtitle.textContent = `正在编辑：${current.name}`
    viewportBadge.textContent = `${viewport.width} × ${viewport.height}`
  }

  function renderInspector(): void {
    inspector.replaceChildren()
    const selection = selectedId ? findNode(current.root, selectedId) : null
    if (!selection) {
      const intro = html(doc, 'div', 'hse__selection')
      intro.innerHTML = '<strong>选择一个构件</strong><span>点击画布中的栏、按钮或面板，在这里调整它的行为。</span>'
      inspector.appendChild(intro)
      const hint = html(doc, 'div', 'hse__hint')
      hint.textContent = '从左侧拖入新构件；拖动已有构件可重排。所有更改都可以撤销。'
      inspector.appendChild(hint)
      return
    }
    const descriptor = selection.type === 'block' ? descriptorOf(selection.blockId) : null
    const summary = html(doc, 'div', 'hse__selection')
    const strong = html(doc, 'strong')
    strong.textContent = labelOf(selection)
    const code = html(doc, 'span')
    code.textContent = selection.type === 'block' ? selection.blockId : selection.id
    summary.append(strong, code)
    inspector.appendChild(summary)

    if (selection.type === 'frame') {
      addSegmented('方向', selection.axis, [['row', '横向'], ['column', '纵向']], (value) => {
        dispatch({ type: 'set-frame', nodeId: selection.id, patch: { axis: value as 'row' | 'column' } })
      })
      addNumber('间距', Number(selection.gap) || 0, (value) => {
        dispatch({ type: 'set-frame', nodeId: selection.id, patch: { gap: value } })
      })
      addNumber('内边距', Number(selection.padding) || 0, (value) => {
        dispatch({ type: 'set-frame', nodeId: selection.id, patch: { padding: value } })
      })
      addSelect('溢出', selection.overflow || 'grow', [
        ['grow', '保留空间'],
        ['scroll', '滚动'],
        ['wrap', '换行'],
        ['drawer', '抽屉'],
        ['hide', '隐藏']
      ], (value) => {
        dispatch({ type: 'set-frame', nodeId: selection.id, patch: { overflow: value as LayoutFrame['overflow'] } })
      })
      addToggle('允许收起', selection.collapse?.enabled === true, (value) => {
        dispatch({ type: 'set-collapse', nodeId: selection.id, value: { enabled: value } })
      })
    } else if (selection.type === 'block') {
      addSelect('可见性', selection.visibility || 'always', [
        ['always', '始终显示'],
        ['auto-hide', '自动隐藏'],
        ['collapsed', '默认收起'],
        ['hidden', '从运行布局隐藏']
      ], (value) => {
        dispatch({ type: 'set-visibility', nodeId: selection.id, visibility: value as NodeVisibility })
      })
      addSegmented('锚点', selection.anchor || 'start', [['start', '起始'], ['center', '居中'], ['end', '末尾']], (value) => {
        dispatch({ type: 'set-props', nodeId: selection.id, patch: { anchor: value } })
        const target = findNode(current.root, selection.id)
        if (target?.type === 'block') target.anchor = value as 'start' | 'center' | 'end'
      })
      addNumber('基础尺寸', Number(selection.sizing?.basis) || 32, (value) => {
        dispatch({ type: 'resize', nodeId: selection.id, sizing: { basis: value, unit: 'px' } })
      }, 'px')
      addSelect('尺寸单位', selection.sizing?.unit || 'px', [
        ['px', '固定像素'],
        ['fraction', '弹性占比'],
        ['content', '跟随内容']
      ], (value) => {
        dispatch({ type: 'resize', nodeId: selection.id, sizing: { unit: value as 'px' | 'fraction' | 'content' } })
      })
      addToggle('锁定位置', selection.locked === true, (value) => {
        const target = findNode(current.root, selection.id)
        if (target?.type === 'block') {
          target.locked = value
          emitReplacement('锁定：' + labelOf(selection))
        }
      })
      if (descriptor?.description) {
        const hint = html(doc, 'div', 'hse__hint')
        hint.textContent = descriptor.description
        inspector.appendChild(hint)
      }
    }

    if (selection.type !== 'frame' || selection.role !== 'root') {
      const remove = html(doc, 'button', 'hse__danger')
      remove.type = 'button'
      remove.textContent = '从布局移除'
      remove.addEventListener('click', () => dispatch({ type: 'remove', nodeId: selection.id }))
      inspector.appendChild(remove)
    }
  }

  function addField(labelText: string): HTMLElement {
    const field = html(doc, 'div', 'hse__field')
    const label = html(doc, 'label')
    const text = html(doc, 'span')
    text.textContent = labelText
    label.appendChild(text)
    field.appendChild(label)
    inspector.appendChild(field)
    return field
  }

  function addNumber(label: string, value: number, commit: (value: number) => void, unit = ''): void {
    const field = addField(label)
    const input = html(doc, 'input')
    input.type = 'number'
    input.min = '0'
    input.step = '1'
    input.value = String(Math.round(value))
    if (unit) input.dataset.unit = unit
    let timer = 0
    input.addEventListener('input', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => commit(Number(input.value) || 0), 120)
    })
    field.appendChild(input)
  }

  function addSelect(
    label: string,
    value: string,
    items: Array<[string, string]>,
    commit: (value: string) => void
  ): void {
    const field = addField(label)
    const select = html(doc, 'select')
    for (const [id, text] of items) {
      const option = html(doc, 'option')
      option.value = id
      option.textContent = text
      option.selected = id === value
      select.appendChild(option)
    }
    select.addEventListener('change', () => commit(select.value))
    field.appendChild(select)
  }

  function addSegmented(
    label: string,
    value: string,
    items: Array<[string, string]>,
    commit: (value: string) => void
  ): void {
    const field = addField(label)
    const group = html(doc, 'div', 'hse__segmented')
    for (const [id, text] of items) {
      const button = html(doc, 'button')
      button.type = 'button'
      button.textContent = text
      button.setAttribute('aria-pressed', String(id === value))
      button.addEventListener('click', () => commit(id))
      group.appendChild(button)
    }
    field.appendChild(group)
  }

  function addToggle(label: string, value: boolean, commit: (value: boolean) => void): void {
    const field = addField(label)
    field.querySelector('label')?.remove()
    const button = html(doc, 'button', 'hse__btn')
    button.type = 'button'
    button.style.width = '100%'
    button.textContent = value ? '已开启 · 点击关闭' : '已关闭 · 点击开启'
    button.addEventListener('click', () => commit(!value))
    field.appendChild(button)
  }

  function updateUndoButtons(): void {
    undoBtn.disabled = undoStack.length === 0
    redoBtn.disabled = redoStack.length === 0
  }

  function emit(command: LayoutCommand | null, changedNodeIds: string[]): void {
    options.onChange?.(cloneDocument(current), { command, changedNodeIds })
    updateUndoButtons()
    setStatus(command ? `已应用：${command.type}` : '布局已更新', 'ok')
  }

  function dispatch(command: LayoutCommand): boolean {
    const result = applyLayoutCommand(current, command)
    if (!result.changed) return false
    undoStack.push(cloneDocument(current))
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
    redoStack.length = 0
    current = result.document
    renderCanvas()
    renderInspector()
    emit(command, result.changedNodeIds)
    return true
  }

  function emitReplacement(action: string): void {
    undoStack.push(cloneDocument(current))
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
    redoStack.length = 0
    current.metadata.updatedAt = Date.now()
    renderCanvas()
    renderInspector()
    options.onChange?.(cloneDocument(current), { command: null, changedNodeIds: [] })
    updateUndoButtons()
    setStatus(action, 'ok')
  }

  function replaceDocument(next: LayoutDocument, action: string): void {
    undoStack.push(cloneDocument(current))
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
    redoStack.length = 0
    current = cloneDocument(next)
    selectedId = null
    renderCanvas()
    renderInspector()
    options.onChange?.(cloneDocument(current), { command: null, changedNodeIds: [] })
    updateUndoButtons()
    setStatus(action, 'ok')
  }

  function hasBlock(blockId: string): boolean {
    let found = false
    walkNodes(current.root, (node) => {
      if (node.type === 'block' && node.blockId === blockId) found = true
    })
    return found
  }

  function canDrop(descriptor: StudioBlockDescriptor, frame: LayoutFrame): boolean {
    if (descriptor.available === false) return false
    if (descriptor.allowedParents?.length && !descriptor.allowedParents.includes(frame.role)) return false
    if (descriptor.singleton && hasBlock(descriptor.id)) return false
    return frame.role !== 'root'
  }

  function findTargetFrame(x: number, y: number): HTMLElement | null {
    const element = doc.elementFromPoint(x, y)
    return element?.closest<HTMLElement>('[data-layout-frame]') || null
  }

  function childNodesOf(frameEl: HTMLElement): HTMLElement[] {
    return Array.from(frameEl.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        Boolean(child.dataset.layoutNode) &&
        !child.classList.contains('hse__frameLabel')
    )
  }

  function dropIndex(frameEl: HTMLElement, x: number, y: number): number {
    const horizontal = frameEl.dataset.axis === 'row'
    const nodes = childNodesOf(frameEl)
    for (let i = 0; i < nodes.length; i += 1) {
      const rect = nodes[i].getBoundingClientRect()
      const center = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2
      if ((horizontal ? x : y) < center) return i
    }
    return nodes.length
  }

  function beginDrag(
    event: PointerEvent,
    sourceEl: HTMLElement,
    nodeId: string | null,
    descriptor?: StudioBlockDescriptor
  ): void {
    if (event.button !== 0 || (nodeId && findNode(current.root, nodeId)?.type === 'block' && (findNode(current.root, nodeId) as Extract<LayoutNode, { type: 'block' }>).locked)) return
    const state: DragState = {
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      nodeId: nodeId || undefined,
      descriptor,
      sourceEl,
      active: false,
      ghost: null,
      zoneEl: null,
      caret: null,
      raf: 0
    }
    drag = state
    try { sourceEl.setPointerCapture(event.pointerId) } catch (_) {}
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  function startVisualDrag(state: DragState): void {
    state.active = true
    const ghost = html(doc, 'div', 'hse__ghost')
    const descriptor = state.descriptor || (() => {
      const node = state.nodeId ? findNode(current.root, state.nodeId) : null
      return node?.type === 'block' ? descriptorOf(node.blockId) || undefined : undefined
    })()
    ghost.appendChild(makeIcon(descriptor || null, 17))
    const name = html(doc, 'span')
    const node = state.nodeId ? findNode(current.root, state.nodeId) : null
    name.textContent = descriptor?.label || (node ? labelOf(node) : '构件')
    ghost.appendChild(name)
    doc.body.appendChild(ghost)
    state.ghost = ghost
    sourceElOpacity(state.sourceEl, 0.38)
  }

  function sourceElOpacity(element: HTMLElement, opacity: number): void {
    element.style.opacity = String(opacity)
  }

  function flushDrag(): void {
    const state = drag
    if (!state) return
    state.raf = 0
    if (!state.active) return
    const ghost = state.ghost
    if (ghost) {
      ghost.style.left = `${Math.round(state.x - 38)}px`
      ghost.style.top = `${Math.round(state.y - 16)}px`
    }
    const target = findTargetFrame(state.x, state.y)
    if (state.zoneEl && state.zoneEl !== target) state.zoneEl.dataset.drop = 'false'
    state.zoneEl = target
    if (target) target.dataset.drop = 'true'
    updateCaret(target)
  }

  function updateCaret(target: HTMLElement | null): void {
    const state = drag
    if (!state) return
    if (!target) {
      state.caret?.remove()
      state.caret = null
      return
    }
    const horizontal = target.dataset.axis === 'row'
    const nodes = childNodesOf(target)
    const index = dropIndex(target, state.x, state.y)
    const ref = nodes[index] || nodes[index - 1]
    const rect = ref?.getBoundingClientRect() || target.getBoundingClientRect()
    if (!state.caret) {
      state.caret = html(doc, 'div', 'hse__caret')
      doc.body.appendChild(state.caret)
    }
    if (horizontal) {
      state.caret.style.left = `${Math.round(index < nodes.length ? rect.left - 3 : rect.right + 2)}px`
      state.caret.style.top = `${Math.round(rect.top + 3)}px`
      state.caret.style.width = '2px'
      state.caret.style.height = `${Math.max(20, rect.height - 6)}px`
    } else {
      state.caret.style.left = `${Math.round(rect.left + 3)}px`
      state.caret.style.top = `${Math.round(index < nodes.length ? rect.top - 3 : rect.bottom + 2)}px`
      state.caret.style.width = `${Math.max(20, rect.width - 6)}px`
      state.caret.style.height = '2px'
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    state.x = event.clientX
    state.y = event.clientY
    if (!state.active && Math.hypot(state.x - state.startX, state.y - state.startY) >= 5) startVisualDrag(state)
    if (state.active && !state.raf) state.raf = requestAnimationFrame(flushDrag)
  }

  function onPointerUp(event: PointerEvent): void {
    const state = drag
    if (!state || event.pointerId !== state.pointerId) return
    state.x = event.clientX
    state.y = event.clientY
    if (state.active) finishDrop(state)
    endDrag()
  }

  function finishDrop(state: DragState): void {
    const targetEl = findTargetFrame(state.x, state.y)
    if (!targetEl) return
    const frameId = targetEl.dataset.layoutFrame
    if (!frameId) return
    const frame = findNode(current.root, frameId)
    if (!frame || frame.type !== 'frame') return
    if (!state.nodeId && state.descriptor && !canDrop(state.descriptor, frame)) {
      setStatus('这个构件不能放在该区域。', 'warn')
      return
    }
    const index = dropIndex(targetEl, state.x, state.y)
    if (state.nodeId) {
      dispatch({ type: 'move', nodeId: state.nodeId, parentId: frame.id, index })
    } else if (state.descriptor) {
      const node = createBlock(state.descriptor.id, {
        sizing: state.descriptor.family === 'panels'
          ? { basis: 1, unit: 'fraction', min: 160, grow: 1 }
          : { basis: 32, unit: 'px', min: 24, max: 96, shrink: 0 }
      })
      dispatch({ type: 'insert', parentId: frame.id, index, node })
      selectedId = node.id
      renderCanvas()
      renderInspector()
    }
  }

  function onPointerCancel(): void {
    if (!drag) return
    if (drag.active) setStatus('已取消拖动。')
    endDrag()
  }

  function endDrag(): void {
    const state = drag
    drag = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    if (!state) return
    if (state.raf) cancelAnimationFrame(state.raf)
    state.ghost?.remove()
    state.caret?.remove()
    if (state.zoneEl) state.zoneEl.dataset.drop = 'false'
    sourceElOpacity(state.sourceEl, 1)
    try { state.sourceEl.releasePointerCapture(state.pointerId) } catch (_) {}
  }

  function undo(): boolean {
    const previous = undoStack.pop()
    if (!previous) return false
    redoStack.push(cloneDocument(current))
    current = previous
    selectedId = selectedId && findNode(current.root, selectedId) ? selectedId : null
    renderCanvas()
    renderInspector()
    options.onChange?.(cloneDocument(current), { command: null, changedNodeIds: [] })
    updateUndoButtons()
    setStatus('已撤销')
    return true
  }

  function redo(): boolean {
    const next = redoStack.pop()
    if (!next) return false
    undoStack.push(cloneDocument(current))
    current = next
    selectedId = selectedId && findNode(current.root, selectedId) ? selectedId : null
    renderCanvas()
    renderInspector()
    options.onChange?.(cloneDocument(current), { command: null, changedNodeIds: [] })
    updateUndoButtons()
    setStatus('已重做')
    return true
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (drag?.active) {
        event.preventDefault()
        setStatus('已取消拖动。')
        endDrag()
        return
      }
      if (selectedId) {
        selectedId = null
        renderCanvas()
        renderInspector()
        return
      }
      options.onExit?.()
      return
    }
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
      event.preventDefault()
      dispatch({ type: 'remove', nodeId: selectedId })
    }
  }

  undoBtn.addEventListener('click', undo)
  redoBtn.addEventListener('click', redo)
  resetBtn.addEventListener('click', () => {
    replaceDocument(createDefaultLayoutDocument('当前布局'), '已恢复默认布局')
  })
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    setStatus('正在保存…')
    try {
      await options.onSave?.(cloneDocument(current))
      setStatus('布局已保存', 'ok')
    } catch (error) {
      setStatus(`保存失败：${(error as Error).message || error}`, 'warn')
    } finally {
      saveBtn.disabled = false
    }
  })
  window.addEventListener('keydown', onKeyDown)

  renderLibrary()
  renderCanvas()
  renderInspector()
  updateUndoButtons()

  function setStatus(text: string, tone: 'neutral' | 'ok' | 'warn' = 'neutral'): void {
    statusText.textContent = text
    status.dataset.tone = tone
  }

  return {
    element: root,
    getDocument: () => cloneDocument(current),
    setDocument(next): void {
      current = cloneDocument(next)
      selectedId = selectedId && findNode(current.root, selectedId) ? selectedId : null
      renderCanvas()
      renderInspector()
    },
    setBlocks(next): void {
      descriptors = [...next]
      renderLibrary()
      renderCanvas()
      renderInspector()
    },
    setStatus,
    undo,
    redo,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      endDrag()
      window.removeEventListener('keydown', onKeyDown)
      searchInput.removeEventListener('input', onSearch)
      modes.removeEventListener('click', onModeClick)
      root.remove()
    }
  }
}

