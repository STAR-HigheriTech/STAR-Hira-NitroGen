import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { DEFAULT_SEARCH_SETTINGS } from '@hira-ng/shared-types/src/search-settings.mjs'
import { DEFAULT_SEARCH_ENGINE, DEFAULT_SEARCH_TEMPLATE } from '@hira-ng/shared-types/src/search-engines.mjs'
import { LAYOUT_SETTING_KEYS } from '@hira-ng/shared-types/src/layout.mjs'
import { canonicalPageHost, pageUrl } from '@hira-ng/shared-types/src/page-url.mjs'
import type { JsonRecord, RendererBridge } from '../shared/bridge.js'

const STORAGE_KEY = 'hira:ng:browser-preview:v1'
const PREVIEW_PROFILE = { id: 'preview', name: '浏览器预览', icon: 'user', color: '#4777c8' }
const PREVIEW_SPACE = {
  id: 'preview-space',
  profileId: PREVIEW_PROFILE.id,
  name: '预览空间',
  icon: 'layers',
  order: 0
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  ...DEFAULT_SEARCH_SETTINGS,
  [LAYOUT_SETTING_KEYS.mode]: 'default',
  [LAYOUT_SETTING_KEYS.preset]: 'classic',
  [LAYOUT_SETTING_KEYS.titlebarEnabled]: false,
  [LAYOUT_SETTING_KEYS.immersiveMode]: false,
  [LAYOUT_SETTING_KEYS.windowControlsHost]: 'tabbar',
  [LAYOUT_SETTING_KEYS.rowOrder]: ['tabbar', 'navbar', 'bookmarkbar', 'titlebar'],
  [LAYOUT_SETTING_KEYS.sideOrder]: ['tabbar', 'navbar', 'bookmarkbar', 'titlebar'],
  [LAYOUT_SETTING_KEYS.rowPosition.tabbar]: 'top',
  [LAYOUT_SETTING_KEYS.rowPosition.navbar]: 'top',
  [LAYOUT_SETTING_KEYS.rowPosition.titlebar]: 'top',
  [LAYOUT_SETTING_KEYS.rowPosition.bookmarkbar]: 'top',
  [LAYOUT_SETTING_KEYS.sideColumnPosition]: 'left',
  [LAYOUT_SETTING_KEYS.sideColumnVisibility]: 'attached',
  [LAYOUT_SETTING_KEYS.sideColumnWidth]: 200,
  [LAYOUT_SETTING_KEYS.sideColumnCollapsed]: false,
  [LAYOUT_SETTING_KEYS.webSidebarPosition]: 'auto',
  [LAYOUT_SETTING_KEYS.toolSidebarPosition]: 'left',
  [LAYOUT_SETTING_KEYS.toolRailHorizontalAlign]: 'left',
  [LAYOUT_SETTING_KEYS.toolRailVerticalAlign]: 'top',
  [LAYOUT_SETTING_KEYS.toolRailExpandMode]: 'auto',
  [LAYOUT_SETTING_KEYS.toolRailWidth]: 140,
  [LAYOUT_SETTING_KEYS.toolRailPinned]: true,
  'app.bookmarkbar_mode': 'newtab',
  'app.navbar_buttons': null
}

interface PreviewState {
  settings: Record<string, unknown>
}

interface PreviewTab {
  type: 'tab'
  tabId: string
  url: string
  title: string
  favicon: string
  active: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  pinned: boolean
  muted: boolean
  isPlaying: boolean
}

let installedBridge: RendererBridge | null = null

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function loadState(): PreviewState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as unknown
    return {
      settings: isPlainRecord(parsed) && isPlainRecord(parsed.settings) ? parsed.settings : {}
    }
  } catch {
    return { settings: {} }
  }
}

function saveState(state: PreviewState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 浏览器预览仍可继续工作；存储被禁用时只是不保留设置。
  }
}

function titleForUrl(url: string): string {
  if (!url || url === 'about:blank') return '新标签页'
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'hira:' && canonicalPageHost(parsed.hostname) === 'new-tab') return '新标签页'
    return parsed.hostname || parsed.protocol.replace(':', '') || url
  } catch {
    return url
  }
}

function createPreviewTab(tabId: string, url = pageUrl('newtab')): PreviewTab {
  return {
    type: 'tab',
    tabId,
    url,
    title: titleForUrl(url),
    favicon: '',
    active: true,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    muted: false,
    isPlaying: false
  }
}

function mountPreviewNotice(): void {
  requestAnimationFrame(() => {
    if (document.getElementById('hira-browser-preview-notice')) return
    const notice = document.createElement('div')
    notice.id = 'hira-browser-preview-notice'
    notice.textContent = '浏览器预览 · 设置保存在本机浏览器'
    notice.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'z-index:2147483647',
      'pointer-events:none',
      'padding:5px 9px',
      'border:1px solid rgba(127,127,127,.28)',
      'border-radius:6px',
      'background:var(--main-bg-color,#fff)',
      'color:var(--text-color,#333)',
      'font:11px/1.4 var(--hira-font-ui,Segoe UI,sans-serif)',
      'opacity:.82'
    ].join(';')
    document.body.appendChild(notice)
  })
}

function createBridge(): RendererBridge {
  const state = loadState()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let nextTabId = 2
  let tabs: PreviewTab[] = [createPreviewTab('preview-tab-1')]

  const emit = (route: string, payload: unknown): void => {
    const set = listeners.get(route)
    if (!set) return
    for (const listener of set) {
      try {
        listener(payload)
      } catch (error) {
        console.error(`[browser-preview] listener failed: ${route}`, error)
      }
    }
  }

  const settingValue = (key: string): unknown => (
    Object.prototype.hasOwnProperty.call(state.settings, key)
      ? state.settings[key]
      : DEFAULT_SETTINGS[key]
  )

  const emitTabs = (): void => {
    const projection = tabs.map((tab) => ({ ...tab }))
    emit(IPC_EVENTS.tabChanged, { projection, tabs: projection })
  }

  const activateTab = (tabId: string): void => {
    tabs = tabs.map((tab) => ({ ...tab, active: tab.tabId === tabId }))
    emitTabs()
  }

  const setActiveUrl = (url: string): void => {
    const active = tabs.find((tab) => tab.active) || tabs[0]
    if (!active) return
    tabs = tabs.map((tab) => tab.tabId === active.tabId
      ? {
          ...tab,
          url,
          title: titleForUrl(url),
          canGoBack: tab.url !== url || tab.canGoBack
        }
      : tab)
    emitTabs()
    emit(IPC_EVENTS.tabNavigated, { tabId: active.tabId, url, active: true })
  }

  const invoke = async <T = JsonRecord>(route: string, payload?: unknown): Promise<T> => {
    const request = isPlainRecord(payload) ? payload : {}

    switch (route) {
      case IPC_ROUTES.themeTokens:
        return {
          id: 'preview-light',
          mode: 'light',
          tokens: {},
          background: null,
          surface: { material: 'none', supported: false, applied: false }
        } as T

      case IPC_ROUTES.settingsGet:
        return { value: settingValue(String(request.key || '')) } as T

      case IPC_ROUTES.settingsSet: {
        const key = String(request.key || '')
        if (key) {
          state.settings[key] = request.value
          saveState(state)
          emit(IPC_EVENTS.settingsChanged, { key, value: request.value, scope: 'key' })
        }
        return { ok: true } as T
      }

      case IPC_ROUTES.settingsList:
        return (request.section === 'search'
          ? { ...DEFAULT_SEARCH_SETTINGS, ...state.settings }
          : { ...DEFAULT_SETTINGS, ...state.settings }) as T

      case IPC_ROUTES.featuresAvailability:
        return { available: {} } as T

      case IPC_ROUTES.panelCatalog:
        return { panels: [] } as T

      case IPC_ROUTES.panelList:
        return [] as T

      case IPC_ROUTES.panelSide:
        return { side: null, pinned: false } as T

      case IPC_ROUTES.panelToggle:
      case IPC_ROUTES.panelShow:
        return { open: false, panelId: String(request.panelId || '') } as T

      case IPC_ROUTES.slotsRender:
        return { items: [] } as T

      case IPC_ROUTES.slotsDispatch:
        return { ok: false, reason: 'browser preview' } as T

      case IPC_ROUTES.pluginsList:
        return { plugins: [] } as T

      case IPC_ROUTES.spaceList:
      case IPC_ROUTES.spaceListAll:
        return [PREVIEW_SPACE] as T

      case IPC_ROUTES.spaceGet:
      case IPC_ROUTES.spaceGetUsing:
      case IPC_ROUTES.spaceGetLastUsed:
        return PREVIEW_SPACE as T

      case IPC_ROUTES.profileList:
      case IPC_ROUTES.profileVisible:
        return [PREVIEW_PROFILE] as T

      case IPC_ROUTES.profileGetActive:
        return PREVIEW_PROFILE as T

      case IPC_ROUTES.tabProjection:
      case IPC_ROUTES.tabList:
        return tabs.map((tab) => ({ ...tab })) as T

      case IPC_ROUTES.tabStackList:
        return { stacks: [] } as T

      case IPC_ROUTES.navEntries:
        return {
          entries: [],
          activeIndex: -1,
          canGoBack: false,
          canGoForward: false
        } as T

      case IPC_ROUTES.tabNew: {
        const tab = createPreviewTab(`preview-tab-${nextTabId++}`, String(request.url || pageUrl('newtab')))
        tabs = [...tabs.map((item) => ({ ...item, active: false })), tab]
        emitTabs()
        return { tabId: tab.tabId } as T
      }

      case IPC_ROUTES.tabSwitch:
        activateTab(String(request.tabId || ''))
        return { ok: true } as T

      case IPC_ROUTES.tabClose: {
        const tabId = String(request.tabId || '')
        const wasActive = tabs.some((tab) => tab.tabId === tabId && tab.active)
        tabs = tabs.filter((tab) => tab.tabId !== tabId)
        if (wasActive && tabs[0]) tabs[0] = { ...tabs[0], active: true }
        emitTabs()
        return { ok: true } as T
      }

      case IPC_ROUTES.navGo:
        setActiveUrl(String(request.url || pageUrl('newtab')))
        return { ok: true } as T

      case IPC_ROUTES.bookmarkPinnedList:
      case IPC_ROUTES.bookmarkRailPinnedList:
      case IPC_ROUTES.bookmarkList:
      case IPC_ROUTES.downloadList:
      case IPC_ROUTES.extensionList:
      case IPC_ROUTES.permissionPendingList:
      case 'search:suggestions':
      case 'search:history':
      case 'search:instant-answer':
        return [] as T

      case IPC_ROUTES.downloadActive:
        return { active: 0 } as T

      case IPC_ROUTES.permissionGetSite:
        return {} as T

      case IPC_ROUTES.searchConfig:
        return {
          default: DEFAULT_SEARCH_ENGINE,
          engines: {},
          defaultTemplate: DEFAULT_SEARCH_TEMPLATE,
          pluginBangs: [],
          customBangs: []
        } as T

      case IPC_ROUTES.appInfo:
        return {
          version: '8.0.0-preview',
          packaged: false,
          isPackaged: false,
          platform: navigator.platform
        } as T

      case IPC_ROUTES.homeUrl:
        return { url: pageUrl('newtab'), newTabUrl: pageUrl('newtab') } as T

      case IPC_ROUTES.windowGetState:
        return { isMaximized: false, isFullscreen: false } as T

      case IPC_ROUTES.keybindingsGet:
        return {} as T

      case IPC_ROUTES.pwaList:
        return [] as T

      case IPC_ROUTES.pwaState:
        return { state: 'none', candidateId: null, appId: null, kind: null } as T

      default:
        return {} as T
    }
  }

  return {
    provider: {
      invoke,
      send(route, payload) {
        if (route.endsWith(':set-width')) {
          saveState(state)
          return
        }
        void invoke(route, payload).catch(() => {})
      }
    },
    on: {
      subscribe<T = JsonRecord>(route: string, listener: (payload: T) => void): () => void {
        let set = listeners.get(route)
        if (!set) {
          set = new Set()
          listeners.set(route, set)
        }
        const wrapped = (payload: unknown): void => listener(payload as T)
        set.add(wrapped)
        return () => {
          const current = listeners.get(route)
          if (!current) return
          current.delete(wrapped)
          if (current.size === 0) listeners.delete(route)
        }
      }
    }
  }
}

export function isBrowserPreviewRuntime(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (/Electron\//i.test(navigator.userAgent)) return false
  return window.location.protocol === 'http:' || window.location.protocol === 'https:'
}

export function getBrowserPreviewBridge(): RendererBridge | null {
  if (!isBrowserPreviewRuntime()) return null
  if (installedBridge) return installedBridge
  installedBridge = createBridge()
  try {
    Object.defineProperty(window, 'hira', {
      value: installedBridge,
      configurable: true,
      enumerable: false
    })
  } catch {
    // getHiraBridge 仍会返回同一个实例；这里只兼容直接读取 window.hira 的旧页面。
  }
  mountPreviewNotice()
  console.info('[browser-preview] 已启用浏览器预览桥；原生窗口与网页视图能力不可用。')
  return installedBridge
}
