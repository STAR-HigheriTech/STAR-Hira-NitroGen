/**
 * 浏览器界面叠加编辑层。
 *
 * 默认体验不是“打开一个全屏后台管理界面”：真实标签、地址栏、网页、rail 与面板
 * 保持可见，叠加层只画可拖动克隆、局部虚线投放区、顶部小工具条和一个按需展开的抽屉。
 *
 * 跨 WebContentsView 的指针事件仍全部收在本 renderer 内。真实界面隐藏自己那一排按钮，
 * 叠加层按主进程换算后的窗口坐标逐像素重建，松手后再让真实界面重新量一次。
 */
import '@hira-ng/shared-ui-tokens/tokens-base.css'
import '@hira-ng/shared-ui-tokens/tokens-light.css'
import '@hira-ng/shared-ui-tokens/tokens-dark.css'
import { createThemeController } from '../shared/theme-controller.js'
import { getHiraBridge } from '../shared/bridge.js'
import { settingsClient } from '../shared/settings-client.js'
import { panelsClient, type PanelCatalogEntry } from '../shared/panels-client.js'
import { bookmarksClient } from '../shared/bookmarks-client.js'
import {
  createQuickLayoutEditor,
  type QuickLayoutBarDescriptor,
  type QuickLayoutBarSetting,
  type QuickLayoutBarSettingOption,
  type QuickLayoutEditor,
  type QuickLayoutItemDescriptor,
  type QuickLayoutState,
  type QuickLayoutSurface,
  type QuickLayoutZone
} from '@hira-ng/ui-layout-editor'
import {
  catalogFor,
  buildCatalog,
  resolvePanelOrder,
  FIRST_RUN_LAYOUT
} from '@hira-ng/ui-common'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { SHELL_BUTTON_SETTING_KEYS } from '@hira-ng/shared-types/src/shell-buttons.mjs'
import {
  CHROME_ROW_REGIONS,
  LAYOUT_SETTING_KEYS,
  LAYOUT_MODE_OPTIONS,
  RAIL_EXPAND_MODE_OPTIONS,
  RAIL_HORIZONTAL_ALIGN_OPTIONS,
  RAIL_POSITION_OPTIONS,
  RAIL_VERTICAL_ALIGN_OPTIONS,
  ROW_POSITION_OPTIONS,
  SIDEBAR_POSITION_OPTIONS,
  SIDEBAR_VISIBILITY_OPTIONS,
  WINDOW_CONTROLS_HOST_OPTIONS,
  normalizeRailPosition,
  normalizeWindowControlsStyle
} from '@hira-ng/shared-types/src/layout.mjs'
import {
  BOOKMARKBAR_MODE_OPTIONS,
  BOOKMARKBAR_SETTING_KEY,
  normalizeBookmarkbarMode,
  type BookmarkbarMode
} from '@hira-ng/shared-types/src/bookmarkbar.mjs'
import {
  createBlock,
  createDefaultLayoutDocument,
  createFrame
} from '@hira-ng/layout-model'

const bridge = getHiraBridge()
const themeController = createThemeController({ document, bridge })
void themeController.start().catch(() => {})

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing button editor root')
const root = rootElement

interface PendingSurfaceCommit {
  state: QuickLayoutState | null
  waiters: Array<{ resolve: () => void; reject: (reason?: unknown) => void }>
}

type CatalogItem = ReturnType<typeof buildCatalog>[number]

let editor: QuickLayoutEditor | null = null
let active = false
let catalog: CatalogItem[] = []
let surfaceCatalog: Record<'navbar' | 'rail', CatalogItem[]> = { navbar: [], rail: [] }
let chromeAreas: Record<'top' | 'bottom' | 'left' | 'right', string[]> = { top: [], bottom: [], left: [], right: [] }
let panelAreas: Record<'left' | 'right', string[]> = { left: [], right: [] }
let webSidebarAreas: Record<'left' | 'right', string[]> = { left: [], right: [] }
let layoutMode = 'default'
let chromeRowPositions: Record<ChromeRow, string> = {
  tabbar: 'top',
  navbar: 'top',
  titlebar: 'top',
  bookmarkbar: 'top'
}
let titlebarEnabled = false
let windowControlsHost = 'tabbar'
let windowControlsStyle = 'native'
let windowControlsPersistId = 0
let sideColumnVisibility = 'attached'
let sideColumnCollapsed = false
let sideColumnPosition = 'left'
let railPosition = 'left'
let railHorizontalAlign = 'left'
let railVerticalAlign = 'top'
let railExpandMode = 'auto'
let bookmarkbarMode: BookmarkbarMode = 'always'
let barSettingPersistId = 0
interface SurfaceOrderState { visible: string[]; hidden: string[]; drawer: string[]; segments?: Record<string, string> }
interface RailPin { id: string; url?: string; nickname?: string | null; title?: string | null; favicon?: string | null }

const orders: { navbar: SurfaceOrderState; rail: SurfaceOrderState; railPins: RailPin[] } = {
  navbar: { visible: [], hidden: [], drawer: [] },
  rail: { visible: [], hidden: [], drawer: [] },
  railPins: []
}
let layoutRecord: Record<string, unknown> | null = null
let saveTimer = 0
let generation = 0
let expectedChromeState: QuickLayoutState | null = null
let expectedChromeTimer = 0
let templateApplyId = 0
let templateApplyInFlight = 0
let templateQueue = Promise.resolve()
const pendingZones = new Map<string, QuickLayoutZone[]>()
const pendingSurfaceCommits = new Map<string, PendingSurfaceCommit>()
const persistenceIdleWaiters: Array<() => void> = []
let persistDrainTimer = 0
let persistDraining = false

const SURFACES: QuickLayoutSurface[] = [
  {
    id: 'navbar',
    label: '导航栏',
    areas: [
      { key: 'nav', label: '导航按钮' },
      { key: 'panel', label: '面板按钮' }
    ]
  },
  {
    id: 'rail',
    label: '侧栏按钮',
    areas: [
      { key: 'rail', label: '常驻区' },
      { key: 'drawer', label: '抽屉区' }
    ]
  },
  {
    id: 'rail-pins',
    label: '固定书签',
    areas: [
      { key: 'pins', label: 'Rail 固定区' }
    ]
  },
  {
    id: 'chrome',
    label: '布局层',
    areas: [
      { key: 'top', label: '顶部区域' },
      { key: 'bottom', label: '底部区域' },
      { key: 'left', label: '左侧栏' },
      { key: 'right', label: '右侧栏' }
    ]
  },
  {
    id: 'panels',
    label: '面板',
    areas: [
      { key: 'left', label: '左侧面板' },
      { key: 'right', label: '右侧面板' }
    ]
  },
  {
    id: 'web-sidebar',
    label: '网页栏',
    areas: [
      { key: 'left', label: '左侧网页栏' },
      { key: 'right', label: '右侧网页栏' }
    ]
  }
]

const CHROME_BLOCKS = [
  { id: 'chrome:tabbar', label: '标签栏', iconSpec: 'AppWindow', removable: false },
  { id: 'chrome:navbar', label: '导航栏', iconSpec: 'PanelTop', removable: false },
  { id: 'chrome:bookmarkbar', label: '书签栏', iconSpec: 'Star', removable: false },
  { id: 'chrome:titlebar', label: '标题栏', iconSpec: 'PanelTop' },
  { id: 'chrome:rail', label: '工具栏', iconSpec: 'PanelLeft', removable: false }
]
const CHROME_AREAS = ['top', 'bottom', 'left', 'right'] as const
type ChromeArea = typeof CHROME_AREAS[number]
type ChromeRow = 'tabbar' | 'navbar' | 'titlebar' | 'bookmarkbar'
type LayoutRect = { x: number; y: number; width: number; height: number }
type QuickTemplateId = 'classic' | 'sidebar' | 'all-in-one' | 'focus'
type LayoutWrite = readonly [string, unknown]

function isChromeRow(value: unknown): value is ChromeRow {
  return value === 'tabbar' || value === 'navbar' || value === 'titlebar' || value === 'bookmarkbar'
}


const QUICK_TEMPLATE_WRITES: Record<QuickTemplateId, readonly LayoutWrite[]> = {
  classic: [
    [LAYOUT_SETTING_KEYS.mode, 'default'],
    [LAYOUT_SETTING_KEYS.rowPosition.tabbar, 'top'],
    [LAYOUT_SETTING_KEYS.rowPosition.navbar, 'top'],
    [LAYOUT_SETTING_KEYS.sideColumnVisibility, 'attached']
  ],
  sidebar: [
    [LAYOUT_SETTING_KEYS.mode, 'default'],
    [LAYOUT_SETTING_KEYS.rowPosition.tabbar, 'side'],
    [LAYOUT_SETTING_KEYS.rowPosition.navbar, 'top'],
    [LAYOUT_SETTING_KEYS.sideColumnVisibility, 'attached'],
    [LAYOUT_SETTING_KEYS.sideColumnPosition, 'left'],
    [LAYOUT_SETTING_KEYS.toolSidebarPosition, 'left']
  ],
  'all-in-one': [
    [LAYOUT_SETTING_KEYS.mode, 'default'],
    [LAYOUT_SETTING_KEYS.rowPosition.tabbar, 'side'],
    [LAYOUT_SETTING_KEYS.rowPosition.navbar, 'side'],
    [LAYOUT_SETTING_KEYS.sideColumnVisibility, 'attached'],
    [LAYOUT_SETTING_KEYS.sideColumnPosition, 'left'],
    [LAYOUT_SETTING_KEYS.toolSidebarPosition, 'left']
  ],
  focus: [
    [LAYOUT_SETTING_KEYS.mode, 'compact'],
    [LAYOUT_SETTING_KEYS.rowPosition.tabbar, 'top'],
    [LAYOUT_SETTING_KEYS.rowPosition.navbar, 'top'],
    [LAYOUT_SETTING_KEYS.sideColumnVisibility, 'floating']
  ]
}

function itemCatalog(surface: 'navbar' | 'rail'): CatalogItem[] {
  return surfaceCatalog[surface] || []
}

function itemOf(surface: 'navbar' | 'rail', id: string): CatalogItem | null {
  return itemCatalog(surface).find((item) => item.id === id) || null
}

function quickCatalog(): QuickLayoutItemDescriptor[] {
  const seen = new Set()
  const out: QuickLayoutItemDescriptor[] = []
  for (const surface of ['navbar', 'rail'] as const) {
    for (const item of itemCatalog(surface)) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push({
        id: item.id,
        label: item.label,
        icon: item.icon,
        segment: item.segment,
        removable: item.removable !== false
      })
    }
  }
  for (const pin of orders.railPins) {
    out.push({
      id: `pin:${pin.id}`,
      label: pin.nickname || pin.title || pin.url || '固定书签',
      icon: (doc, opts) => {
        const size = opts?.size || 17
        const fallback = doc.createElement('span')
        fallback.textContent = String(pin.nickname || pin.title || pin.url || '?').trim().slice(0, 1).toUpperCase()
        fallback.style.fontWeight = '700'
        if (pin.favicon) {
          const image = doc.createElement('img')
          image.src = String(pin.favicon)
          image.alt = ''
          image.width = size
          image.height = size
          image.style.borderRadius = '3px'
          image.style.objectFit = 'contain'
          image.addEventListener('error', () => image.replaceWith(fallback))
          return image
        }
        return fallback
      }
    })
  }
  for (const item of CHROME_BLOCKS) {
    out.push({
      id: item.id,
      label: item.label,
      icon: (doc, opts) => {
        const fallback = doc.createElement('span')
        fallback.textContent = item.label.slice(0, 1)
        fallback.style.fontWeight = '700'
        fallback.style.color = 'var(--hira-accent, #0f766e)'
        fallback.style.fontSize = `${Math.max(11, (opts?.size || 17) - 3)}px`
        return fallback
      },
      removable: item.removable !== false
    })
  }
  return out
}

function quickStates(): Record<string, QuickLayoutState> {
  const navAreas: Record<'nav' | 'panel' | 'profile' | 'search', string[]> = {
    nav: [],
    panel: [],
    profile: [],
    search: []
  }
  for (const id of orders.navbar.visible) {
    const item = itemOf('navbar', id)
    const declared = item?.segment
    const requestedArea = orders.navbar.segments?.[id]
    const area = requestedArea === 'profile' || requestedArea === 'nav' || requestedArea === 'search'
      ? requestedArea
      : declared === 'profile' || declared === 'nav' || declared === 'search'
        ? declared
        : 'panel'
    navAreas[area].push(id)
  }
  return {
    navbar: { byArea: navAreas, hidden: orders.navbar.hidden.slice() },
    rail: {
      byArea: {
        rail: orders.rail.visible.slice(),
        drawer: orders.rail.drawer.slice()
      },
      hidden: orders.rail.hidden.slice()
    },
    chrome: {
      byArea: {
        top: chromeAreas.top.slice(),
        bottom: chromeAreas.bottom.slice(),
        left: chromeAreas.left.slice(),
        right: chromeAreas.right.slice()
      },
      compact: layoutMode === 'compact',
      hidden: CHROME_BLOCKS
        .map((item) => item.id)
        .filter((id) => ![
          ...chromeAreas.top,
          ...chromeAreas.bottom,
          ...chromeAreas.left,
          ...chromeAreas.right
        ].includes(id))
    },
    panels: {
      byArea: {
        left: panelAreas.left.slice(),
        right: panelAreas.right.slice()
      },
      hidden: []
    },
    'web-sidebar': {
      byArea: {
        left: webSidebarAreas.left.slice(),
        right: webSidebarAreas.right.slice()
      },
      hidden: []
    },
    'rail-pins': {
      byArea: {
        pins: orders.railPins.map((pin) => `pin:${pin.id}`)
      },
      hidden: []
    }
  }
}

function settingOptions(table: readonly (readonly unknown[])[]): QuickLayoutBarSettingOption[] {
  return table.map(([value, label]) => ({
    value: String(value),
    label: String(label)
  }))
}

function rowPositionSetting(row: ChromeRow): QuickLayoutBarSetting {
  const allowed = new Set(CHROME_ROW_REGIONS[row] || [])
  return {
    key: LAYOUT_SETTING_KEYS.rowPosition[row],
    label: '方位',
    type: 'select',
    value: chromeRowPositions[row],
    options: settingOptions(
      ROW_POSITION_OPTIONS.filter(([value]) => allowed.has(String(value)))
    )
  }
}

function quickBarSettings(): QuickLayoutBarDescriptor[] {
  const toolHorizontal = railPosition === 'top' || railPosition === 'bottom'
  const sideVisible = chromeRowPositions.tabbar === 'side' || chromeRowPositions.navbar === 'side'
  return [
    {
      id: 'chrome:tabbar',
      label: '标签栏',
      description: '标签栏方位与垂直标签侧栏的显示规则。',
      settings: [
        {
          key: LAYOUT_SETTING_KEYS.mode,
          label: '布局密度',
          type: 'select',
          value: layoutMode,
          options: settingOptions(LAYOUT_MODE_OPTIONS),
          description: '紧凑模式只调整间距；标签栏与导航栏仍是独立栏位。'
        },
        rowPositionSetting('tabbar'),
        {
          key: LAYOUT_SETTING_KEYS.sideColumnVisibility,
          label: '垂直标签侧栏显示方式',
          type: 'select',
          value: sideColumnVisibility,
          options: settingOptions(SIDEBAR_VISIBILITY_OPTIONS),
          disabled: !sideVisible,
          disabledReason: '标签栏或导航栏位于垂直标签侧栏时生效。'
        },
        {
          key: LAYOUT_SETTING_KEYS.sideColumnPosition,
          label: '垂直标签侧栏位于',
          type: 'select',
          value: sideColumnPosition,
          options: settingOptions(SIDEBAR_POSITION_OPTIONS),
          disabled: !sideVisible,
          disabledReason: '标签栏或导航栏位于垂直标签侧栏时生效。'
        },
        {
          key: LAYOUT_SETTING_KEYS.sideColumnCollapsed,
          label: '折叠垂直标签侧栏（仅图标）',
          type: 'toggle',
          value: sideColumnCollapsed,
          disabled: !sideVisible,
          disabledReason: '标签栏或导航栏位于垂直标签侧栏时生效。'
        }
      ]
    },
    {
      id: 'chrome:navbar',
      label: '导航栏',
      description: '地址栏、导航按钮和菜单容器的宿主栏位。',
      settings: [rowPositionSetting('navbar')]
    },
    {
      id: 'chrome:titlebar',
      label: '标题栏',
      description: '网页标题栏；关闭后其内部内容不再占位。',
      settings: [
        {
          key: LAYOUT_SETTING_KEYS.titlebarEnabled,
          label: '显示标题栏',
          type: 'toggle',
          value: titlebarEnabled
        },
        {
          ...rowPositionSetting('titlebar'),
          disabled: !titlebarEnabled,
          disabledReason: '先打开显示标题栏。'
        }
      ]
    },
    {
      id: 'chrome:bookmarkbar',
      label: '书签栏',
      description: '书签栏显示策略与方位。',
      settings: [
        {
          key: BOOKMARKBAR_SETTING_KEY,
          label: '显示方式',
          type: 'select',
          value: bookmarkbarMode,
          options: settingOptions(BOOKMARKBAR_MODE_OPTIONS)
        },
        rowPositionSetting('bookmarkbar')
      ]
    },
    {
      id: 'chrome:rail',
      label: '工具栏',
      description: '工具侧栏位置、排列方向与展开状态。',
      settings: [
        {
          key: LAYOUT_SETTING_KEYS.toolSidebarPosition,
          label: '方位',
          type: 'select',
          value: railPosition,
          options: settingOptions(RAIL_POSITION_OPTIONS)
        },
        {
          key: LAYOUT_SETTING_KEYS.toolRailHorizontalAlign,
          label: '横向按钮起始边',
          type: 'select',
          value: railHorizontalAlign,
          options: settingOptions(RAIL_HORIZONTAL_ALIGN_OPTIONS),
          disabled: !toolHorizontal,
          disabledReason: '工具栏位于顶部或底部时生效。'
        },
        {
          key: LAYOUT_SETTING_KEYS.toolRailVerticalAlign,
          label: '纵向按钮起始边',
          type: 'select',
          value: railVerticalAlign,
          options: settingOptions(RAIL_VERTICAL_ALIGN_OPTIONS),
          disabled: toolHorizontal,
          disabledReason: '工具栏位于左侧或右侧时生效。'
        },
        {
          key: LAYOUT_SETTING_KEYS.toolRailExpandMode,
          label: '起始状态',
          type: 'select',
          value: railExpandMode,
          options: settingOptions(RAIL_EXPAND_MODE_OPTIONS)
        }
      ]
    }
  ]
}

function canonicalChromeItemId(id: unknown): string {
  const value = String(id || '')
  if (!value) return ''
  return value.startsWith('chrome:') ? value : `chrome:${value}`
}

function inflateRect(rect: LayoutRect, padding: number): LayoutRect {
  const pad = Math.max(0, Number(padding) || 0)
  const x = Number(rect?.x) || 0
  const y = Number(rect?.y) || 0
  const width = Math.max(0, Number(rect?.width) || 0)
  const height = Math.max(0, Number(rect?.height) || 0)
  const viewportWidth = Math.max(1, window.innerWidth)
  const viewportHeight = Math.max(1, window.innerHeight)
  const left = Math.max(0, Math.min(viewportWidth, x - pad))
  const top = Math.max(0, Math.min(viewportHeight, y - pad))
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.min(viewportWidth - left, width + pad * 2)),
    height: Math.max(0, Math.min(viewportHeight - top, height + pad * 2))
  }
}

function sanitizeRect(rect: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!rect || typeof rect !== 'object') return null
  const record = rect as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const width = Number(record.width)
  const height = Number(record.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  const safeWidth = Math.max(0, Math.min(100_000, width))
  const safeHeight = Math.max(0, Math.min(100_000, height))
  if (safeWidth <= 0 || safeHeight <= 0) return null
  return {
    x: Math.round(Math.max(-100_000, Math.min(100_000, x))),
    y: Math.round(Math.max(-100_000, Math.min(100_000, y))),
    width: Math.round(safeWidth),
    height: Math.round(safeHeight)
  }
}

function sanitizeZoneSegment(segment: unknown): QuickLayoutZone | null {
  if (!segment || typeof segment !== 'object') return null
  const record = segment as Record<string, unknown>
  const rect = sanitizeRect(record.rect)
  if (!rect) return null
  const items: NonNullable<QuickLayoutZone['items']> = []
  if (Array.isArray(record.items)) {
    for (const rawCandidate of record.items) {
      const candidate = rawCandidate as Record<string, unknown>
      const itemRect = sanitizeRect(candidate)
      const id = String(candidate.id || '').slice(0, 256)
      if (!id || !itemRect) continue
      items.push({ id, ...itemRect })
    }
  }
  return {
    key: String(record.key || 'default').slice(0, 64),
    label: String(record.label || '').slice(0, 128),
    rect,
    items,
    grow: typeof record.grow === 'string' ? record.grow.slice(0, 24) : '',
    axis: record.axis === 'row' ? 'row' : 'column'
  }
}

function normalizeChromeSegments(segments: QuickLayoutZone[]): QuickLayoutZone[] {
  const known = new Set(CHROME_BLOCKS.map((item) => item.id))
  const byKey = new Map<string, QuickLayoutZone>()
  const viewportWidth = Math.max(1, window.innerWidth)
  const viewportHeight = Math.max(1, window.innerHeight)

  const upsert = (key: ChromeArea, segment: QuickLayoutZone) => {
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, {
        key,
        label: segment.label || '',
        rect: { ...segment.rect },
        items: (segment.items || []).slice(),
        grow: segment.grow,
        // chrome 的每个 bar 都是独立行：顶部/底部内部沿 y 排序，侧栏也沿 y。
        axis: 'column'
      })
      return
    }
    const left = Math.min(current.rect.x, segment.rect.x)
    const top = Math.min(current.rect.y, segment.rect.y)
    const right = Math.max(
      current.rect.x + current.rect.width,
      segment.rect.x + segment.rect.width
    )
    const bottom = Math.max(
      current.rect.y + current.rect.height,
      segment.rect.y + segment.rect.height
    )
    current.rect = { x: left, y: top, width: right - left, height: bottom - top }
    const items = current.items ?? []
    items.push(...(segment.items || []))
    current.items = Array.from(new Map(items.map((item) => [item.id, item] as const)).values())
  }

  for (const segment of segments) {
    let key = segment.key
    if (key === 'top-main') key = 'top'
    if (key === 'bottom-main') key = 'bottom'
    if (key === 'side') {
      key = segment.rect.x + segment.rect.width / 2 < viewportWidth / 2 ? 'left' : 'right'
    }
    if (!CHROME_AREAS.includes(key as ChromeArea)) continue
    const areaKey = key as ChromeArea
    const area = SURFACES.find((surface) => surface.id === 'chrome')?.areas.find((item) => item.key === key)
    upsert(areaKey, {
      ...segment,
      label: area?.label || segment.label,
      items: (segment.items || [])
        .map((item) => ({ ...item, id: canonicalChromeItemId(item.id) }))
        .filter((item) => known.has(item.id))
    })
  }

  // 只在目标边缘完全没有 bar 时使用。真实 bar 仍使用它自己的实测占位尺寸。
  const fallbackHeight = 96
  const fallbackSideWidth = 64
  if (!byKey.has('top')) {
    byKey.set('top', {
      key: 'top',
      label: '顶部区域',
      rect: { x: 0, y: 0, width: viewportWidth, height: fallbackHeight },
      items: [],
      grow: 'right',
      axis: 'row'
    })
  }
  if (!byKey.has('bottom')) {
    byKey.set('bottom', {
      key: 'bottom',
      label: '底部区域',
      rect: { x: 0, y: viewportHeight - fallbackHeight, width: viewportWidth, height: fallbackHeight },
      items: [],
      grow: 'right',
      axis: 'row'
    })
  }
  for (const key of ['left', 'right']) {
    if (byKey.has(key)) continue
    byKey.set(key, {
      key,
      label: key === 'left' ? '左侧栏' : '右侧栏',
      rect: {
        x: key === 'left' ? 0 : viewportWidth - fallbackSideWidth,
        y: 0,
        width: fallbackSideWidth,
        height: viewportHeight
      },
      items: [],
      grow: key === 'left' ? 'left' : 'right',
      axis: 'column'
    })
  }
  const topZone = byKey.get('top')
  const bottomZone = byKey.get('bottom')
  const topHitHeight = Math.max(64, Math.min(140, (topZone?.rect.height || 0) + 24))
  const bottomHitHeight = Math.max(64, Math.min(140, (bottomZone?.rect.height || 0) + 24))
  return CHROME_AREAS.map((key) => {
    const zone = byKey.get(key)
    if (zone) {
      zone.hitRect = inflateRect(zone.rect, 4)
      if (key === 'top') {
        zone.hitRect = {
          x: 0,
          y: 0,
          width: viewportWidth,
          height: topHitHeight
        }
      } else if (key === 'bottom') {
        zone.hitRect = {
          x: 0,
          y: Math.max(0, viewportHeight - bottomHitHeight),
          width: viewportWidth,
          height: bottomHitHeight
        }
      } else {
        const topInset = topHitHeight
        const bottomInset = bottomHitHeight
        const sideHitWidth = Math.max(48, zone.rect.width + 8)
        zone.hitRect = {
          x: key === 'left' ? 0 : Math.max(0, viewportWidth - sideHitWidth),
          y: topInset,
          width: sideHitWidth,
          height: Math.max(0, viewportHeight - topInset - bottomInset)
        }
      }
    }
    return zone
  }).filter((zone): zone is QuickLayoutZone => zone != null)
}

async function loadCatalog() {
  let entries: PanelCatalogEntry[] = []
  try {
    entries = await panelsClient.catalog()
  } catch (error) {
    console.error('[layout-overlay] panel catalog failed:', error)
  }
  catalog = buildCatalog(entries)
  surfaceCatalog = {
    navbar: catalogFor('navbar', catalog),
    rail: catalogFor('rail', catalog)
  }
}

async function loadOrders(catalogReady: Promise<void> | null = null) {
  const [
    navbarSetting,
    railSetting,
    tabbarPos,
    navbarPos,
    titlebarPos,
    bookmarkbarPos,
    titlebarOn,
    toolPosition,
    sidePosition,
    rowOrder,
    sideOrder,
    mode,
    controlsHost,
    controlsStyle,
    sideVisibility,
    sideCollapsed,
    bookmarkMode,
    railHorizontal,
    railVertical,
    railExpand
  ] = await Promise.all([
    settingsClient.get(SHELL_BUTTON_SETTING_KEYS.navbar).catch(() => undefined),
    settingsClient.get(SHELL_BUTTON_SETTING_KEYS.rail).catch(() => undefined),
    settingsClient.get(LAYOUT_SETTING_KEYS.rowPosition.tabbar).catch(() => 'top'),
    settingsClient.get(LAYOUT_SETTING_KEYS.rowPosition.navbar).catch(() => 'top'),
    settingsClient.get(LAYOUT_SETTING_KEYS.rowPosition.titlebar).catch(() => 'top'),
    settingsClient.get(LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar).catch(() => 'top'),
    settingsClient.get(LAYOUT_SETTING_KEYS.titlebarEnabled).catch(() => false),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolSidebarPosition).catch(() => 'left'),
    settingsClient.get(LAYOUT_SETTING_KEYS.sideColumnPosition).catch(() => 'left'),
    settingsClient.get(LAYOUT_SETTING_KEYS.rowOrder).catch(() => []),
    settingsClient.get(LAYOUT_SETTING_KEYS.sideOrder).catch(() => []),
    settingsClient.get(LAYOUT_SETTING_KEYS.mode).catch(() => 'default'),
    settingsClient.get(LAYOUT_SETTING_KEYS.windowControlsHost).catch(() => 'tabbar'),
    settingsClient.get(LAYOUT_SETTING_KEYS.windowControlsStyle).catch(() => 'native'),
    settingsClient.get(LAYOUT_SETTING_KEYS.sideColumnVisibility).catch(() => 'attached'),
    settingsClient.get(LAYOUT_SETTING_KEYS.sideColumnCollapsed).catch(() => false),
    settingsClient.get(BOOKMARKBAR_SETTING_KEY).catch(() => 'always'),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailHorizontalAlign).catch(() => 'left'),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailVerticalAlign).catch(() => 'top'),
    settingsClient.get(LAYOUT_SETTING_KEYS.toolRailExpandMode).catch(() => 'auto')
  ])
  layoutMode = mode === 'compact' ? 'compact' : 'default'
  chromeRowPositions = {
    tabbar: String(tabbarPos),
    navbar: String(navbarPos),
    titlebar: String(titlebarPos),
    bookmarkbar: String(bookmarkbarPos)
  }
  titlebarEnabled = titlebarOn === true
  sideColumnPosition = sidePosition === 'right' ? 'right' : 'left'
  railPosition = normalizeRailPosition(toolPosition)
  railHorizontalAlign = railHorizontal === 'right' ? 'right' : 'left'
  railVerticalAlign = railVertical === 'bottom' ? 'bottom' : 'top'
  railExpandMode = railExpand === 'rail' || railExpand === 'expanded' ? railExpand : 'auto'
  bookmarkbarMode = normalizeBookmarkbarMode(bookmarkMode)
  windowControlsHost = WINDOW_CONTROLS_HOST_OPTIONS.some(([value]) => value === controlsHost)
    ? String(controlsHost)
    : 'tabbar'
  windowControlsStyle = normalizeWindowControlsStyle(controlsStyle)
  if (catalogReady) await catalogReady
  sideColumnVisibility = sideVisibility === 'floating' || sideVisibility === 'hidden'
    ? sideVisibility
    : 'attached'
  sideColumnCollapsed = sideCollapsed === true
  const resolvedNavbar = resolvePanelOrder(navbarSetting, surfaceCatalog.navbar, FIRST_RUN_LAYOUT.navbar)
  const navbarSegments: Record<string, string> = {}
  const savedNavbarSegments = navbarSetting && typeof navbarSetting === 'object'
    ? (navbarSetting as Record<string, unknown>).segments as Record<string, string> | undefined
    : null
  for (const id of resolvedNavbar.visible) {
    const saved = savedNavbarSegments?.[id]
    const declared = itemOf('navbar', id)?.segment
    navbarSegments[id] = saved === 'nav' || saved === 'panel'
      ? saved
      : (declared === 'nav' ? declared : 'panel')
  }
  orders.navbar = {
    ...resolvedNavbar,
    segments: navbarSegments
  }
  orders.rail = resolvePanelOrder(railSetting, surfaceCatalog.rail, FIRST_RUN_LAYOUT.rail)
  chromeAreas = { top: [], bottom: [], left: [], right: [] }
  const addChrome = (id: string, position: unknown) => {
    const area = position === 'side'
      ? (sideColumnPosition === 'right' ? 'right' : 'left')
      : position === 'bottom'
        ? 'bottom'
        : position === 'right'
          ? 'right'
          : position === 'left'
            ? 'left'
            : 'top'
    chromeAreas[area].push(id)
  }
  const positions: Record<ChromeRow, unknown> = {
    tabbar: tabbarPos,
    navbar: navbarPos,
    titlebar: titlebarPos,
    bookmarkbar: bookmarkbarPos
  }
  const enabledRows: ChromeRow[] = (['tabbar', 'navbar', 'titlebar', 'bookmarkbar'] as const)
    .filter((id) => id !== 'titlebar' || titlebarEnabled)
  const normalizedRowOrder: ChromeRow[] = [
    ...(Array.isArray(rowOrder) ? rowOrder.filter(isChromeRow) : []),
    ...enabledRows
  ].filter((id, index, list) => enabledRows.includes(id as ChromeRow) && list.indexOf(id) === index) as ChromeRow[]
  const normalizedSideOrder = [
    ...(Array.isArray(sideOrder) ? sideOrder.filter(isChromeRow) : []),
    ...enabledRows
  ].filter((id, index, list) => enabledRows.includes(id) && list.indexOf(id) === index)
  for (const row of normalizedRowOrder) {
    if (positions[row] === 'side') continue
    addChrome(`chrome:${row}`, positions[row])
  }
  for (const row of normalizedSideOrder) {
    if (positions[row] !== 'side') continue
    addChrome(`chrome:${row}`, 'side')
  }
  addChrome('chrome:rail', railPosition)
}

async function loadRailPins() {
  try {
    const pins = await bookmarksClient.railPinnedList()
    orders.railPins = Array.isArray(pins) ? pins.filter((pin) => pin && pin.id && pin.url) : []
  } catch (error) {
    console.warn('[layout-overlay] rail pinned bookmarks unavailable:', error)
    orders.railPins = []
  }
}

function buildDocumentFromOrders() {
  const navBlocks = orders.navbar.visible.map((id) => {
    const item = itemOf('navbar', id)
    return createBlock(`legacy:navbar:${id}`, {
      props: {
        legacy: {
          surface: 'navbar',
          itemId: id,
          segment: orders.navbar.segments?.[id] || item?.segment || 'panel'
        }
      },
      sizing: { basis: 30, unit: 'px', min: 24, max: 44, shrink: 0 }
    })
  })
  const railBlocks = orders.rail.visible.map((id) => {
    const item = itemOf('rail', id)
    return createBlock(`legacy:rail:${id}`, {
      props: { legacy: { surface: 'rail', itemId: id, segment: item?.segment || 'panel' } },
      sizing: { basis: 30, unit: 'px', min: 24, max: 44, shrink: 0 }
    })
  })
  const drawerBlocks = orders.rail.drawer.map((id) => {
    const item = itemOf('rail', id)
    return createBlock(`legacy:rail:${id}`, {
      props: { legacy: { surface: 'rail', itemId: id, segment: item?.segment || 'panel' } },
      sizing: { basis: 30, unit: 'px', min: 24, max: 44, shrink: 0 }
    })
  })
  const navGroup = createFrame('toolbar-group', 'row', navBlocks, {
    id: 'quick-navbar-buttons',
    label: '导航按钮',
    gap: 5,
    padding: 0,
    sizing: { basis: 0, unit: 'content', grow: 0, shrink: 1 }
  })
  const address = createBlock('layout.address', {
    id: 'quick-address',
    sizing: { basis: 1, unit: 'fraction', min: 160, grow: 1 }
  })
  const top = createFrame('bar', 'row', [navGroup, address], {
    id: 'quick-top-bar',
    label: '顶部栏',
    gap: 8,
    padding: 8,
    sizing: { basis: 52, unit: 'px', min: 42, max: 82, shrink: 0 }
  })
  const railGroup = createFrame('toolbar-group', 'column', railBlocks, {
    id: 'quick-rail',
    label: '工具',
    gap: 6,
    padding: 8,
    sizing: { basis: 56, unit: 'px', min: 48, max: 76, shrink: 0 }
  })
  const drawer = createFrame('tray', 'column', drawerBlocks, {
    id: 'quick-drawer',
    label: '抽屉',
    gap: 6,
    padding: 8,
    sizing: { basis: 52, unit: 'px', min: 44, max: 72, shrink: 0 }
  })
  const left = createFrame('dock', 'column', [railGroup, drawer], {
    id: 'quick-left',
    label: '左侧工具区',
    gap: 6,
    padding: 4,
    sizing: { basis: 56, unit: 'px', min: 0, max: 72, shrink: 0 }
  })
  const content = createBlock('content.main', {
    id: 'content-main',
    sizing: { basis: 1, unit: 'fraction', min: 1, grow: 1 },
    locked: true
  })
  const main = createFrame('column', 'column', [top, content], {
    id: 'quick-main',
    label: '主内容',
    sizing: { basis: 1, unit: 'fraction', min: 240, grow: 1 }
  })
  const right = createFrame('custom-column', 'column', [], {
    id: 'quick-right',
    label: '右侧栏',
    gap: 6,
    padding: 4,
    sizing: { basis: 300, unit: 'px', min: 0, max: 620, shrink: 0 },
    collapse: { enabled: true, default: 'collapsed', mode: 'off-canvas', trigger: 'manual', restoreWidth: 300 }
  })
  const doc = createDefaultLayoutDocument('当前界面')
  doc.root = createFrame('root', 'row', [left, main, right], {
    id: 'layout-root',
    label: '窗口',
    sizing: { basis: 1, unit: 'fraction', grow: 1 }
  })
  return doc
}

async function ensureLayoutRecord() {
  try {
    const snapshot = await bridge.provider.invoke(IPC_ROUTES.layoutDocumentSnapshot, { scope: {} })
    layoutRecord = (snapshot.layout || null) as Record<string, unknown> | null
  } catch (error) {
    console.warn('[layout-overlay] document service unavailable, using settings only:', error)
    layoutRecord = null
  }
}

function cloneSurfaceState(state: QuickLayoutState): QuickLayoutState {
  return {
    byArea: Object.fromEntries(
      Object.entries(state.byArea || {}).map(([area, ids]) => [area, Array.isArray(ids) ? ids.slice() : []])
    ),
    hidden: Array.isArray(state.hidden) ? state.hidden.slice() : [],
    compact: state.compact === true
  }
}

function sameSurfaceState(left: QuickLayoutState | null | undefined, right: QuickLayoutState | null | undefined): boolean {
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

function clearExpectedChromeState() {
  if (expectedChromeTimer) {
    window.clearTimeout(expectedChromeTimer)
    expectedChromeTimer = 0
  }
  expectedChromeState = null
}

function armExpectedChromeState(state: QuickLayoutState): void {
  clearExpectedChromeState()
  expectedChromeState = cloneSurfaceState(state)
  // 外壳若因平台差异回传了不同顺序，不能让一段旧状态永久锁住编辑层。
  expectedChromeTimer = window.setTimeout(() => {
    expectedChromeTimer = 0
    expectedChromeState = null
  }, 360)
}

function schedulePersistenceDrain(delayMs = 0) {
  if (persistDrainTimer || persistDraining) return
  persistDrainTimer = window.setTimeout(() => {
    persistDrainTimer = 0
    void drainSurfaceCommits()
  }, Math.max(0, delayMs))
}

async function persistSurface(surfaceId: string, state: QuickLayoutState): Promise<void> {
  if (surfaceId === 'chrome') armExpectedChromeState(state)
  await new Promise<void>((resolve, reject) => {
    let batch = pendingSurfaceCommits.get(surfaceId)
    if (!batch) {
      batch = { state: null, waiters: [] }
      pendingSurfaceCommits.set(surfaceId, batch)
    }
    // 连续快速落位只持久化最后一组状态；界面本身已经用本地状态即时反馈。
    batch.state = cloneSurfaceState(state)
    batch.waiters.push({ resolve, reject })
    // 编辑层已经把 onCommit 排到首帧之后，这里只做任务级合批；
    // 再叠一段人为延时会让真实布局反馈变慢。
    schedulePersistenceDrain(0)
  })
}

function settlePersistenceIdle() {
  for (const resolve of persistenceIdleWaiters.splice(0)) resolve()
}

function waitForPersistenceIdle() {
  if (!persistDraining && !persistDrainTimer && pendingSurfaceCommits.size === 0) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => persistenceIdleWaiters.push(() => resolve()))
}

function flushScheduledPersistence() {
  if (persistDrainTimer) {
    window.clearTimeout(persistDrainTimer)
    persistDrainTimer = 0
  }
  if (!persistDraining && pendingSurfaceCommits.size) void drainSurfaceCommits()
}

async function drainSurfaceCommits() {
  persistDrainTimer = 0
  if (persistDraining) return
  if (!pendingSurfaceCommits.size) {
    settlePersistenceIdle()
    return
  }
  persistDraining = true
  const batch = Array.from(pendingSurfaceCommits)
  pendingSurfaceCommits.clear()
  try {
    for (const [surfaceId, entry] of batch) {
      try {
        if (entry.state) await applySurfaceState(surfaceId, entry.state)
        for (const waiter of entry.waiters) waiter.resolve()
      } catch (error) {
        for (const waiter of entry.waiters) waiter.reject(error)
      }
    }
  } finally {
    persistDraining = false
    if (pendingSurfaceCommits.size) {
      schedulePersistenceDrain(0)
    } else {
      settlePersistenceIdle()
    }
  }
}

async function applySurfaceState(surfaceId: string, state: QuickLayoutState) {
  const surface = SURFACES.find((item) => item.id === surfaceId)
  if (!surface) return
  if (surfaceId === 'rail-pins') {
    const ids = (state.byArea.pins || [])
      .filter((id) => id.startsWith('pin:'))
      .map((id) => id.slice('pin:'.length))
    const byId = new Map<string, RailPin>(orders.railPins.map((pin) => [String(pin.id), pin]))
    const nextPins = ids.map((id) => byId.get(id)).filter((pin): pin is RailPin => !!pin)
    await bookmarksClient.railPinnedReorder(ids)
    orders.railPins = nextPins
    await remeasureAfterChange()
    return
  }
  if (surfaceId === 'chrome') {
    const rowPositionKey: Record<string, string> = {
      'chrome:tabbar': LAYOUT_SETTING_KEYS.rowPosition.tabbar,
      'chrome:navbar': LAYOUT_SETTING_KEYS.rowPosition.navbar,
      'chrome:titlebar': LAYOUT_SETTING_KEYS.rowPosition.titlebar,
      'chrome:bookmarkbar': LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar
    }
    const writes: Array<[string, unknown]> = []
    const sameList = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((value, index) => value === right[index])
    const currentAreaOf = (id: string): ChromeArea | undefined => CHROME_AREAS
      .find((area) => (chromeAreas[area] || []).includes(id))
    const currentSideArea = currentAreaOf('chrome:rail')
    const currentSideBarArea = ['chrome:tabbar', 'chrome:navbar', 'chrome:titlebar', 'chrome:bookmarkbar']
      .map((id) => currentAreaOf(id))
      .find((area) => area === 'left' || area === 'right') || null
    const rowOrder: string[] = []
    const sideOrder: string[] = []
    let sideColumnPosition: 'left' | 'right' | null = null
    let railPosition: ChromeArea | null = null
    for (const area of CHROME_AREAS) {
      for (const id of state.byArea[area] || []) {
        if (id === 'chrome:rail') {
          railPosition = area
          continue
        }
        if (rowPositionKey[id]) {
          const rowPosition = area === 'left' || area === 'right' ? 'side' : area
          if (currentAreaOf(id) !== area) writes.push([rowPositionKey[id], rowPosition])
        }
        if (area === 'left' || area === 'right') {
          sideOrder.push(id.replace('chrome:', ''))
          sideColumnPosition = area
        } else {
          rowOrder.push(id.replace('chrome:', ''))
        }
      }
    }
    if (railPosition && railPosition !== currentSideArea) {
      writes.push([LAYOUT_SETTING_KEYS.toolSidebarPosition, railPosition])
    }
    if (sideColumnPosition) {
      if (sideColumnPosition !== currentSideBarArea) {
        writes.push([LAYOUT_SETTING_KEYS.sideColumnPosition, sideColumnPosition])
      }
      // 拖入侧栏就是明确要求“侧栏现在可见”。只在缓存确实不是常驻展开时补写，
      // 避免每次按钮排序都额外触发一轮设置 IPC 与真实外壳重排。
      if (sideColumnVisibility !== 'attached') {
        writes.push([LAYOUT_SETTING_KEYS.sideColumnVisibility, 'attached'])
      }
      if (sideColumnCollapsed) {
        writes.push([LAYOUT_SETTING_KEYS.sideColumnCollapsed, false])
      }
    }
    const nextLayoutMode = state.compact === true ? 'compact' : 'default'
    if (layoutMode !== nextLayoutMode) writes.push([LAYOUT_SETTING_KEYS.mode, nextLayoutMode])
    const titlebarEnabled = [
      ...(state.byArea.top || []),
      ...(state.byArea.bottom || []),
      ...(state.byArea.left || []),
      ...(state.byArea.right || [])
    ].includes('chrome:titlebar')
    if ((currentAreaOf('chrome:titlebar') != null) !== titlebarEnabled) {
      writes.push([LAYOUT_SETTING_KEYS.titlebarEnabled, titlebarEnabled])
    }
    const currentRowOrder = (['top', 'bottom'] as const)
      .flatMap((area) => (chromeAreas[area] || []).filter((id) => id !== 'chrome:rail'))
      .map((id) => id.replace('chrome:', ''))
    const currentSideOrder = (['left', 'right'] as const)
      .flatMap((area) => (chromeAreas[area] || []).filter((id) => id !== 'chrome:rail'))
      .map((id) => id.replace('chrome:', ''))
    if (!sameList(currentRowOrder, rowOrder)) writes.push([LAYOUT_SETTING_KEYS.rowOrder, rowOrder])
    if (!sameList(currentSideOrder, sideOrder)) writes.push([LAYOUT_SETTING_KEYS.sideOrder, sideOrder])
    await Promise.all(writes.map(([key, value]) => settingsClient.set(key, value)))
    layoutMode = nextLayoutMode
    if (sideColumnPosition) {
      sideColumnVisibility = 'attached'
      sideColumnCollapsed = false
    }
    chromeAreas = {
      top: (state.byArea.top || []).slice(),
      bottom: (state.byArea.bottom || []).slice(),
      left: (state.byArea.left || []).slice(),
      right: (state.byArea.right || []).slice()
    }
    await remeasureAfterChange()
    scheduleLayoutSave()
    return
  }
  if (surfaceId === 'panels') {
    const moves: Array<Promise<unknown>> = []
    for (const area of ['left', 'right'] as const) {
      for (const id of state.byArea[area] || []) {
        moves.push(
          panelsClient.getSide(id)
            .then((current) => current.side && current.side !== area
              ? panelsClient.toggle(id, { side: area })
              : null)
        )
      }
    }
    const results = await Promise.allSettled(moves)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    panelAreas = {
      left: (state.byArea.left || []).slice(),
      right: (state.byArea.right || []).slice()
    }
    await remeasureAfterChange()
    return
  }
  if (surfaceId === 'web-sidebar') {
    const side = (state.byArea.right || []).includes('web-sidebar:main') ? 'right' : 'left'
    await settingsClient.set(LAYOUT_SETTING_KEYS.webSidebarPosition, side)
    webSidebarAreas = {
      left: (state.byArea.left || []).slice(),
      right: (state.byArea.right || []).slice()
    }
    await remeasureAfterChange()
    return
  }
  const order = surface.areas
    .filter((area) => area.key !== 'drawer')
    .flatMap((area) => state.byArea[area.key] || [])
  const drawer = state.byArea.drawer ? state.byArea.drawer.slice() : []
  const hidden = state.hidden.slice()
  let segments: Record<string, string> | null = null
  if (surfaceId === 'navbar') {
    segments = {}
    for (const area of Object.keys(state.byArea)) {
      for (const id of state.byArea[area] || []) segments[id] = area
    }
  }
  const key = surfaceId === 'navbar' ? SHELL_BUTTON_SETTING_KEYS.navbar : SHELL_BUTTON_SETTING_KEYS.rail
  const value = surfaceId === 'rail'
    ? { order, hidden, drawer }
    : {
        order,
        hidden,
        segments: segments || {}
      }
  await settingsClient.set(key, value)
  if (surfaceId !== 'navbar' && surfaceId !== 'rail') return
  if (surfaceId === 'navbar') {
    orders.navbar = { visible: order, hidden, drawer, segments: segments || {} }
  } else if (surfaceId === 'rail') {
    orders.rail = { visible: order, hidden, drawer }
  }
  await remeasureAfterChange()
  scheduleLayoutSave()
}

async function remeasureAfterChange() {
  await bridge.provider.invoke(IPC_ROUTES.buttonsEditRemeasure, {}).catch(() => {})
}

function scheduleLayoutSave() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    saveTimer = 0
    if (!layoutRecord) return
    const saveGeneration = generation
    try {
      const result = await bridge.provider.invoke(IPC_ROUTES.layoutDocumentReplace, {
        layoutId: layoutRecord.id,
        baseRevision: layoutRecord.revision,
        document: buildDocumentFromOrders(),
        action: 'quick-edit'
      })
      if (saveGeneration !== generation) return
      if (result?.layout) layoutRecord = result.layout as Record<string, unknown>
    } catch (error) {
      console.warn('[layout-overlay] layout document save failed:', error)
    }
  }, 180)
}

function applyTemplate(templateId: QuickTemplateId) {
  const requestId = ++templateApplyId
  const editorSession = generation
  const task = templateQueue
    .catch(() => {})
    .then(() => runTemplate(templateId, requestId, editorSession))
  templateQueue = task
  return task
}

async function runTemplate(templateId: QuickTemplateId, requestId: number, editorSession: number) {
  await waitForPersistenceIdle()
  if (!active || editorSession !== generation || requestId !== templateApplyId) return
  templateApplyInFlight += 1
  try {
    clearExpectedChromeState()
    const writes = QUICK_TEMPLATE_WRITES[templateId] || []
    await Promise.all(writes.map(([key, value]) => settingsClient.set(key, value)))
    if (!active || editorSession !== generation || requestId !== templateApplyId) return
    await loadOrders()
    if (!active || editorSession !== generation || requestId !== templateApplyId) return
    const next = quickStates()
    armExpectedChromeState(next.chrome)
    editor?.setState('chrome', next.chrome)
    editor?.setBarSettings(quickBarSettings())
    await remeasureAfterChange()
  } finally {
    templateApplyInFlight = Math.max(0, templateApplyInFlight - 1)
  }
}

async function persistWindowControlsHost(host: string) {
  const persistId = ++windowControlsPersistId
  const editorSession = generation
  const next = WINDOW_CONTROLS_HOST_OPTIONS.some(([value]) => value === host) ? String(host) : 'tabbar'
  await settingsClient.set(LAYOUT_SETTING_KEYS.windowControlsHost, next)
  if (persistId !== windowControlsPersistId || editorSession !== generation || !active) return
  windowControlsHost = next
  await remeasureAfterChange()
}

async function persistBarSetting(
  barId: string,
  settingKey: string,
  value: string | boolean
): Promise<void> {
  const bar = quickBarSettings().find((item) => item.id === barId)
  const setting = bar?.settings.find((item) => item.key === settingKey)
  if (!setting || setting.disabled) throw new Error('该栏位设置当前不可用')
  if (setting.type === 'select') {
    if (typeof value !== 'string' || !(setting.options || []).some((option) => option.value === value)) {
      throw new Error('无效的栏位选项')
    }
  } else if (typeof value !== 'boolean') {
    throw new Error('无效的开关值')
  }
  const persistId = ++barSettingPersistId
  const editorSession = generation
  await settingsClient.set(settingKey, value)
  if (persistId !== barSettingPersistId || editorSession !== generation || !active) return
  await loadOrders()
  if (persistId !== barSettingPersistId || editorSession !== generation || !active) return
  const next = quickStates()
  editor?.setBarSettings(quickBarSettings())
  editor?.setState('chrome', next.chrome)
  editor?.setState('navbar', next.navbar)
  editor?.setState('rail', next.rail)
  await remeasureAfterChange()
}

function status(text: string, tone: 'neutral' | 'ok' | 'warn' = 'neutral') {
  editor?.setStatus(text, tone)
}

let startTask: Promise<void> | null = null
let queuedStart = false
let finishTask: Promise<unknown> | null = null

function start(): void {
  if (active) return
  if (startTask) {
    queuedStart = true
    return
  }
  const session = ++generation
  active = true
  clearExpectedChromeState()
  pendingZones.clear()
  root.inert = false
  root.style.display = ''
  startTask = (async () => {
    try {
      // 上一次会话的持久化必须先落地，否则延迟写入会在新会话里覆盖刚读到的布局。
      await waitForPersistenceIdle()
      if (!active || session !== generation) return
      // 设置读取与面板目录并行；顺序解算必须等目录就绪，否则会静默按空目录回退。
      const catalogReady = loadCatalog()
      await Promise.all([loadOrders(catalogReady), loadRailPins()])
      await ensureLayoutRecord()
      if (!active || session !== generation) return
      const initialState = quickStates()
      root.replaceChildren()
      editor = createQuickLayoutEditor({
        surfaces: SURFACES,
        catalog: quickCatalog(),
        states: initialState,
        bars: quickBarSettings(),
        onCommit: persistSurface,
        onBarSettingChange: persistBarSetting,
        onFinish: finish,
        onTemplate: applyTemplate,
        windowControlsHost,
        windowControlsHostOptions: WINDOW_CONTROLS_HOST_OPTIONS.map(([value, label]) => ({ value, label })),
        windowControlsHostHint: windowControlsStyle === 'native'
          ? '当前窗口使用系统原生窗控；这里保存的栏位位置会在切换为“应用自绘”后生效。'
          : '标题栏未显示时会自动回退；Edge 型垂直标签布局固定使用导航栏。',
        onWindowControlsHostChange: persistWindowControlsHost
      })
      root.appendChild(editor.element)
      if (!pendingZones.has('chrome')) {
        editor.setZones({ surface: 'chrome', segments: normalizeChromeSegments([]) })
      }
      for (const [surface, segments] of pendingZones) {
        editor.setZones({ surface, segments })
      }
      await bridge.provider.invoke(IPC_ROUTES.buttonsEditRemeasure, {}).catch(() => {})
      status('栏位方位用设置调整；栏内控件可拖动排序和增删')
    } catch (error) {
      if (!active || session !== generation) return
      console.error('[layout-overlay] start failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      status(`打开编辑界面失败：${message}`, 'warn')
      finish()
    }
  })().finally(() => {
    startTask = null
    if (queuedStart && !active) {
      queuedStart = false
      start()
    } else if (!queuedStart && !active) {
      queuedStart = false
    }
  })
}

function teardown() {
  if (!active) return
  active = false
  generation += 1
  window.clearTimeout(saveTimer)
  saveTimer = 0
  editor?.destroy()
  editor = null
  clearExpectedChromeState()
  flushScheduledPersistence()
  pendingZones.clear()
  root.replaceChildren()
  root.inert = false
  root.style.display = 'none'
}

function finish() {
  if (!active) return
  if (finishTask) return finishTask
  const session = generation
  root.inert = true
  status('正在保存布局…')
  let timeoutId = 0
  const deadline = new Promise((resolve) => {
    timeoutId = window.setTimeout(resolve, 800)
  })
  finishTask = Promise.race([
    Promise.all([waitForPersistenceIdle(), templateQueue.catch(() => {})]),
    deadline
  ])
    .catch(() => {})
    .then(() => {
      if (!active || session !== generation) return
      teardown()
      return bridge.provider.invoke(IPC_ROUTES.buttonsEditSetActive, { active: false }).catch(() => {})
    })
    .finally(() => {
      window.clearTimeout(timeoutId)
      finishTask = null
    })
  return finishTask
}

bridge.on.subscribe(IPC_EVENTS.buttonsEditActive, (payload) => {
  if (payload?.active) start()
  else teardown()
})

bridge.on.subscribe(IPC_EVENTS.buttonsEditZone, (payload: Record<string, unknown>) => {
  if (!active || !payload) return
  // 模板会连续改多条布局键，期间外壳报告的是中间态。等最终设置读回后
  // 再用一次 remeasure 获取最终几何，避免中间帧把界面来回拉扯。
  if (payload.surface === 'chrome' && templateApplyInFlight > 0) return
  const allowed = new Set(['navbar', 'rail', 'rail-pins', 'chrome', 'panels', 'web-sidebar'])
  const surface = typeof payload.surface === 'string' ? payload.surface : ''
  if (!allowed.has(surface)) return
  const segments = Array.isArray(payload.segments) ? payload.segments as QuickLayoutZone[] : []
  const normalized: { surface: string; segments: QuickLayoutZone[] } = {
    surface,
    segments: segments
      .map(sanitizeZoneSegment)
      .filter((segment) => segment !== null)
      .map((segment) => ({
        ...segment,
        hitRect: inflateRect(
          segment.rect,
          surface === 'navbar' || surface === 'rail' ? 8 : 2
        )
      }))
  }
  if (surface === 'chrome') {
    try {
      normalized.segments = normalizeChromeSegments(normalized.segments)
    } catch (error) {
      console.warn('[layout-overlay] invalid chrome geometry ignored:', error)
      return
    }
    const previousRailArea: ChromeArea = CHROME_AREAS
      .find((key) => (chromeAreas[key] || []).includes('chrome:rail')) || 'left'
    const previousBookmarkArea: ChromeArea = CHROME_AREAS
      .find((key) => (chromeAreas[key] || []).includes('chrome:bookmarkbar')) || 'top'
    const reportedAreas: Record<ChromeArea, string[]> = { top: [], bottom: [], left: [], right: [] }
    const reportedBars = new Set<string>()
    const expectedAreaOf = (id: string): ChromeArea | null => CHROME_AREAS
      .find((area) => expectedChromeState?.byArea?.[area]?.includes(id)) || null
    for (const segment of normalized.segments) {
      if (!CHROME_AREAS.includes(segment.key as ChromeArea)) continue
      const area = segment.key as ChromeArea
      reportedAreas[area] = (segment.items || [])
        .map((item) => canonicalChromeItemId(item.id))
        .filter((id) => CHROME_BLOCKS.some((item) => item.id === id))
        .filter((id) => {
          if (reportedBars.has(id)) return false
          reportedBars.add(id)
          return true
        })
    }
    // rail 是独立 WebContentsView，不一定会出现在 chromeLayout 的行块里。
    // 只有本次报告真的包含它时才采纳新位置；否则沿用上一个可信位置，且绝不重复注入。
    if (!reportedBars.has('chrome:rail')) {
      reportedAreas[expectedAreaOf('chrome:rail') || previousRailArea].push('chrome:rail')
      reportedBars.add('chrome:rail')
    }
    // 空书签栏会在真实界面里隐身，但编辑层必须保留可拖动的占位图形。
    if (!reportedBars.has('chrome:bookmarkbar')) {
      reportedAreas[expectedAreaOf('chrome:bookmarkbar') || previousBookmarkArea].push('chrome:bookmarkbar')
      reportedBars.add('chrome:bookmarkbar')
    }
    const reportedState: QuickLayoutState = {
      byArea: {
        top: reportedAreas.top.slice(),
        bottom: reportedAreas.bottom.slice(),
        left: reportedAreas.left.slice(),
        right: reportedAreas.right.slice()
      },
      compact: layoutMode === 'compact',
      hidden: CHROME_BLOCKS
        .map((item) => item.id)
        .filter((id) => !reportedBars.has(id))
    }
    // 设置写入和 DOM 重排不是同一拍完成的。落位后的第一份旧几何必须丢掉，
    // 否则会把本地已落位状态倒回旧位置，再被新报告拉回，形成一次可见闪烁。
    if (expectedChromeState && !sameSurfaceState(expectedChromeState, reportedState)) return
    if (expectedChromeState) clearExpectedChromeState()
    chromeAreas = reportedAreas
    editor?.setState('chrome', reportedState)
  }
  pendingZones.set(surface, normalized.segments)
  if (surface === 'panels') {
    panelAreas = { left: [], right: [] }
    for (const segment of normalized.segments) {
      if (segment.key === 'left' || segment.key === 'right') {
        panelAreas[segment.key] = (segment.items || []).map((item) => item.id).filter(Boolean)
      }
    }
    const half = Math.max(160, Math.round(window.innerWidth / 2))
    for (const key of ['left', 'right']) {
      if (!normalized.segments.some((segment) => segment.key === key)) {
        const rect = {
          x: key === 'left' ? 0 : half,
          y: 0,
          width: half,
          height: Math.max(1, Math.round(window.innerHeight))
        }
        normalized.segments.push({
          key,
          label: key === 'left' ? '左侧面板区' : '右侧面板区',
          rect,
          hitRect: rect,
          items: [],
          grow: 'down',
          axis: 'column'
        })
      }
    }
    editor?.setState('panels', {
      byArea: {
        left: panelAreas.left.slice(),
        right: panelAreas.right.slice()
      },
      hidden: []
    })
  } else if (surface === 'web-sidebar') {
    webSidebarAreas = { left: [], right: [] }
    for (const segment of normalized.segments) {
      if (segment.key === 'left' || segment.key === 'right') {
        webSidebarAreas[segment.key] = (segment.items || []).map((item) => item.id).filter(Boolean)
      }
    }
    const half = Math.max(160, Math.round(window.innerWidth / 2))
    for (const key of ['left', 'right']) {
      if (!normalized.segments.some((segment) => segment.key === key)) {
        const rect = {
          x: key === 'left' ? 0 : half,
          y: 0,
          width: half,
          height: Math.max(1, Math.round(window.innerHeight))
        }
        normalized.segments.push({
          key,
          label: key === 'left' ? '左侧网页栏' : '右侧网页栏',
          rect,
          hitRect: rect,
          items: [],
          grow: 'down',
          axis: 'column'
        })
      }
    }
    editor?.setState('web-sidebar', {
      byArea: {
        left: webSidebarAreas.left.slice(),
        right: webSidebarAreas.right.slice()
      },
      hidden: []
    })
  }
  editor?.setZones(normalized)
})

const offOverlayHide = bridge.on.subscribe(IPC_EVENTS.buttonsEditOverlayHide, () => {
  if (active) finish()
})

// profile 切换会让固定书签、插件按钮和可用面板换一套；编辑层继续保留上一套
// 几何就是悬空占位。直接结束编辑，等真实界面完成刷新后用户可重新打开。
const offProfileChanged = bridge.on.subscribe(IPC_EVENTS.profileChanged, () => {
  if (active) finish()
})

// The document may be changed by another window or a command while this editor
// stays open. Track the new revision so the next local save does not submit a
// permanently stale baseRevision.
const offLayoutDocumentChanged = bridge.on.subscribe<{ layoutId?: unknown; revision?: unknown }>(
  IPC_EVENTS.layoutDocumentChanged,
  (payload) => {
    if (!active || !layoutRecord || !payload) return
    if (String(payload.layoutId || '') !== String(layoutRecord.id || '')) return
    const revision = Number(payload.revision)
    if (Number.isInteger(revision) && revision >= 0) {
      layoutRecord = { ...layoutRecord, revision }
    }
  }
)

window.addEventListener('pagehide', () => {
  offOverlayHide()
  offProfileChanged()
  offLayoutDocumentChanged()
}, { once: true })

root.style.display = 'none'


