// @ts-check
/**
 * @hira-ng/ui-panel-profiles —— Spaces 面板（哑组件）
 *
 * 契约（与其它 ui-panel-* 一致）：
 *   上行 —— onIntent：create / manage / switch / rename / menu
 *   下行 —— setSpaces(spaces, activeId, activeProfileId)
 *
 * 组件自身不持数据、不发 IPC；图标由编排层注入（`renderIcon(name, size)`），
 * 与 navbar 图标同源（apps/app-main/src/pages/_shared/space-icons.js）。
 * 配置文件（Profile）的设置入口不在这里 —— 统一收敛到 hira://spaces（manage）。
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import { injectPanelStyles, openUrlPreferExistingTab } from '@hira-ng/ui-common'
import type { MenuItem } from '@hira-ng/ui-common'
import { THEME_SETTING_KEYS } from '@hira-ng/shared-types/src/theme.mjs'
// 内部页地址的唯一拼法（真源 pages.mjs）—— 面板不手写 `hira://spaces`。
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'

interface SpaceRowItem {
  id: string
  profileId: string
  name: string
  icon: string
  bgStartColor?: string
  bgEndColor?: string
  profileName?: string
}

interface SpaceIntent {
  type: 'create' | 'manage' | 'switch' | 'rename' | 'menu'
  id?: string
  profileId?: string
  name?: string
  x?: number
  y?: number
}

type IconRenderer = (name: string, size?: number) => Element | null

interface SpacePanelHandlers {
  onIntent?: (intent: SpaceIntent) => void
  renderIcon?: IconRenderer
  renderUiIcon?: IconRenderer
}

type SpaceMenuItem = MenuItem

interface SpaceMenuClient {
  popupMenu(payload: { x: number; y: number; items: SpaceMenuItem[] }): Promise<string | null>
}

interface ThemeChoice { id?: string; name?: string }

interface SpaceMenuDeps {
  menuClient?: SpaceMenuClient | null
  themeClient?: { list(profileId?: string): Promise<unknown> } | null
  settingsClient?: { setForSpace(spaceId: string, key: string, value: unknown, profileId?: string): Promise<unknown> } | null
  tabsClient?: { newTab(input: { url: string }): Promise<unknown> } | null
  spaceClient?: { remove(profileId: string, id: string): Promise<unknown> } | null
  onRename?: (id: string) => void
}

interface SpaceClient {
  listAll(): Promise<SpaceRowItem[]>
  getUsing(): Promise<{ id?: string; profileId?: string } | null>
  setUsing(profileId: string, id: string): Promise<unknown>
  update(profileId: string, id: string, patch: { name: string }): Promise<unknown>
  remove(profileId: string, id: string): Promise<unknown>
}

interface ProfilesClient {
  listVisible(): Promise<Array<{ id: string; name?: string }>>
}

interface SpacePanelContext {
  clients: {
    tabs: { newTab(input: { url: string }): Promise<unknown> }
    space: SpaceClient
    profiles: ProfilesClient
    settings: { setForSpace(spaceId: string, key: string, value: unknown, profileId?: string): Promise<unknown> }
    themes: { list(profileId?: string): Promise<{ themes?: ThemeChoice[] }> }
  }
  events: Record<string, string>
  on(route: string, listener: () => void): () => void
  icons: { space: IconRenderer; ui: IconRenderer }
}

const STYLE_ID = 'hira-panel-spaces-styles'

/**
 * 「空间主题」的动作契约（B1/B2 / J13）。
 *
 * 动作名里**带上主题 id**（`space-theme:<id>`）：菜单只有"点了哪个"这一个回值，
 * 用前缀 + 载荷表达取值，就不用为每个主题各注册一个动作名。
 * `INHERIT_THEME` 是特殊取值 —— 表示"这个空间不单独设"，写 `null` 让空间层覆盖被清掉。
 */
const SPACE_THEME_ACTION_PREFIX = 'space-theme:'
const INHERIT_THEME = '__inherit__'
/** 主题设置的键名（真源在 shared-types/theme.mjs；值 = 主题 id）。 */
const SPACE_THEME_KEY = THEME_SETTING_KEYS.active

export function injectSpacesPanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .spaces-panel__wrap { display: flex; flex-direction: column; height: 100%; }
    /* 当前空间：聚合软面，与 themes / permissions 的当前卡同一材质与几何 */
    .spaces-panel__current {
      display: flex; align-items: center; gap: 10px;
      padding: 10px; margin-bottom: 10px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-surface-soft, rgba(0,0,0,0.035));
      border: 0;
    }
    .spaces-panel__current-label { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spaces-panel__actions { display: flex; gap: 2px; margin-bottom: 10px; }
    .spaces-panel__add {
      flex: 0 0 auto;
      width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px);
      box-sizing: border-box;
      padding: 0; display: inline-flex; align-items: center; justify-content: center;
      border: 0;
      background: var(--hira-surface-soft, rgba(0,0,0,0.04));
      color: var(--hira-text-primary, #1a1a1a);
      border-radius: var(--hira-radius-sm, 8px); cursor: pointer;
      font-size: 12px; font-weight: 500; font-family: inherit;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .spaces-panel__add:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    /* ⚠ 三件套缺一不可：flex: 1 吃剩余高度、min-height: 0 允许真的塌到
       剩余高度（否则按内容撑开）、overflow-y: auto 才是滚动容器。
       少了 min-height，窗口一矮列表就被 #root（overflow: hidden）裁掉、滚轮无效。 */
    .spaces-panel__list { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; padding-bottom: 8px; }
    .spaces-panel__row {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 10px; min-height: var(--hira-row-height, 36px); box-sizing: border-box;
      border-radius: var(--hira-radius-md, 10px); cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
      contain: layout style;
    }
    .spaces-panel__row--active, .spaces-panel__row--active:hover { background: var(--hira-accent-soft, rgba(59,130,246,0.14)); }
    .spaces-panel__row:hover { background: var(--hira-hover-bg, rgba(0,0,0,0.06)); }
    .spaces-panel__icon {
      width: 18px; height: 18px; display: grid; place-items: center; flex-shrink: 0;
      color: var(--hira-text-tertiary, #8b8b8b);
    }
    .spaces-panel__row--active .spaces-panel__icon { color: var(--hira-accent, #3b82f6); }
    .spaces-panel__dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .spaces-panel__swatch {
      width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0;
      border: 0;
      background: var(--hira-hover-bg, rgba(0,0,0,0.06));
    }
    .spaces-panel__labels { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .spaces-panel__label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; font-weight: 500; line-height: 18px; color: var(--hira-text-primary, #1a1a1a);
    }
    .spaces-panel__row--active .spaces-panel__label { color: var(--hira-accent, #3b82f6); }
    .spaces-panel__profile {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; line-height: 15px; color: var(--hira-text-tertiary, #8b8b8b);
    }
    .spaces-panel__edit {
      flex: 1; min-width: 0; height: 28px; box-sizing: border-box;
      padding: 0 10px; border: 0; border-radius: var(--hira-radius-xs, 6px);
      background: var(--hira-field-bg, rgba(0,0,0,0.05));
      color: var(--hira-text-primary, #1a1a1a); font-size: 12px; font-family: inherit;
      outline: none; box-shadow: var(--hira-focus-ring, 0 0 0 2px rgba(59,130,246,0.35));
    }
  `
  doc.head.appendChild(style)
}

/** 空间配色 → CSS 渐变（无色时返回空串，交给 CSS 兜底）。 */
function gradientOf(space: SpaceRowItem) {
  const start = typeof space.bgStartColor === 'string' ? space.bgStartColor : ''
  const end = typeof space.bgEndColor === 'string' && space.bgEndColor ? space.bgEndColor : start
  if (!start) return ''
  return `linear-gradient(135deg, ${start}, ${end})`
}

/** 图标注入的统一取法（renderIcon / renderUiIcon 同一个形状）。 */
function makeIconRenderer(handlers: SpacePanelHandlers, key: 'renderIcon' | 'renderUiIcon'): IconRenderer {
  return (name: string, size?: number) => {
    const fn = handlers[key]
    if (typeof fn !== 'function') return null
    try {
      return fn(name, size)
    } catch (_) {
      return null
    }
  }
}

/**
 * 空间**行的唯一实现**（空间面板 / 聚合总览共用）。
 *
 * ── 为什么抽出来 ──────────────────────────────────────────────────
 * 「空间这一行长什么样、点了干什么」原先只有空间面板一处。聚合总览也要同一份
 * —— 复制一份就是两条会各自漂移的实现（改一处漏一处）。抽成组件后两处共用**同一套 class**，
 * 因此 `injectSpacesPanelStyles` 一份样式同时管住两处，外观不可能分叉。
 * 右键菜单同理走 `createSpaceMenu`（同一个函数造出来）。
 *
 * 哑件：不持数据、不发 IPC —— 动作经 onIntent 上行，图标由编排层注入。
 *
 * @param {Document} doc
 * @param {SpacePanelHandlers} [handlers]
 * @returns {{
 *   element: HTMLElement,
 *   setSpaces: (spaces: readonly SpaceRowItem[], activeId: string, activeProfileId: string) => void,
 *   startRename: (id: string) => void
 * }}
 */
export function createSpaceRows(doc: Document, handlers: SpacePanelHandlers = {}) : {
  element: HTMLElement,
  setSpaces: (spaces: readonly SpaceRowItem[], activeId: string, activeProfileId: string) => void,
  startRename: (id: string) => void
} {
  const emit = (intent: SpaceIntent) => {
    if (typeof handlers.onIntent === 'function') handlers.onIntent(intent)
  }
  /** 图标由编排层注入（navbar 同源图标集）；缺省回退为无图标。 */
  const renderIcon = makeIconRenderer(handlers, 'renderIcon')

  const list = doc.createElement('div')
  list.className = 'spaces-panel__list'
  let spaces: SpaceRowItem[] = []
  let activeId = ''
  let activeProfileId = ''
  let editingId = ''

  function startRename(id: string) {
    editingId = id
    render()
    const input = list.querySelector('input.spaces-panel__edit')
    if (input instanceof HTMLInputElement) { input.focus(); input.select() }
  }

  function render() {
    list.textContent = ''
    const frag = doc.createDocumentFragment()
    for (const space of spaces) {
      const isActive = space.id === activeId && space.profileId === activeProfileId
      const row = doc.createElement('div')
      row.className = 'spaces-panel__row' + (isActive ? ' spaces-panel__row--active' : '')

      const icon = doc.createElement('span')
      icon.className = 'spaces-panel__icon'
      const svg = renderIcon(space.icon, 18)
      if (svg) icon.appendChild(svg)
      row.appendChild(icon)

      if (editingId === space.id) {
        const input = doc.createElement('input')
        input.className = 'spaces-panel__edit'
        input.type = 'text'
        input.value = space.name || space.id
        const commit = () => {
          const name = (input.value || '').trim()
          editingId = ''
          if (name && name !== space.name) emit({ type: 'rename', id: space.id, profileId: space.profileId, name })
          else render()
        }
        input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); editingId = ''; render() }
        })
        input.addEventListener('blur', commit)
        row.appendChild(input)
        frag.appendChild(row)
        continue
      }

      // 所选颜色：独立的色块（不压在图标上，避免图标被无关底色污染）
      const swatch = doc.createElement('span')
      swatch.className = 'spaces-panel__swatch'
      const gradient = gradientOf(space)
      if (gradient) swatch.style.background = gradient
      row.appendChild(swatch)

      const labels = doc.createElement('span')
      labels.className = 'spaces-panel__labels'
      const label = doc.createElement('span')
      label.className = 'spaces-panel__label'
      label.textContent = (space.name || space.id) + (isActive ? ' ✓' : '')
      const profile = doc.createElement('span')
      profile.className = 'spaces-panel__profile'
      profile.textContent = space.profileName || space.profileId || ''
      labels.append(label, profile)
      row.appendChild(labels)

      row.addEventListener('click', () => { if (!isActive) emit({ type: 'switch', id: space.id, profileId: space.profileId }) })
      row.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault()
        // 只交坐标：弹菜单那件事（含主题子菜单）归 createSpaceMenu —— 两处共用同一份
        emit({ type: 'menu', id: space.id, profileId: space.profileId, x: e.clientX, y: e.clientY })
      })
      frag.appendChild(row)
    }
    list.appendChild(frag)
  }

  function setSpaces(next: readonly SpaceRowItem[], nextActiveId: string, nextActiveProfileId: string) {
    spaces = Array.isArray(next) ? next.slice() : []
    activeId = nextActiveId || ''
    activeProfileId = nextActiveProfileId || ''
    if (editingId && !spaces.some((space) => space.id === editingId)) editingId = ''
    render()
  }

  render()
  return { element: list, setSpaces, startRename }
}

/**
 * 空间右键菜单的**唯一实现**（空间面板 / 聚合总览共用）。
 *
 * 返回「在 (x, y) 处为某个空间弹菜单」的函数。菜单项里除「空间主题」（B1/B2 / J13：
 * 空间的外观锚点 —— 切到它时界面随之换主题）之外，**改名 / 删除 / 管理**都在这里收口；
 * 主题目录是**数据**（随插件增删），故弹菜单前现取一次，不写死任何主题 id；
 * 取不到目录 → 整个子菜单不出现（不留"点了没反应的项"）。
 *
 * ⚠ `onRename` 是**必给**的：改名要在**行内**原地开输入框（那是行组件的状态），
 * 而菜单这一侧拿不到行节点，只能回调进去。缺了它，「重命名」就是一条点了没反应的死项。
 *
 * @param {SpaceMenuDeps} deps
 * @returns {(arg: { id: string, profileId: string, x: number, y: number }) => Promise<void>}
 */
export function createSpaceMenu(deps: SpaceMenuDeps = {}) : (arg: { id: string, profileId: string, x: number, y: number }) => Promise<void> {
  const { menuClient, themeClient, settingsClient, tabsClient, spaceClient, onRename } = deps
  return async function openSpaceMenu({ id, profileId, x, y }: { id: string, profileId: string, x: number, y: number }) {
    if (!menuClient || !id || !profileId) return
    const themeSubmenu: SpaceMenuItem[] = []
    try {
      const res = themeClient ? await themeClient.list(profileId) : null
      const record = res && typeof res === 'object' ? res as { themes?: unknown } : null
      const themes: ThemeChoice[] = Array.isArray(record?.themes) ? record.themes as ThemeChoice[] : []
      if (themes.length) {
        themeSubmenu.push({ label: '跟随用户设置', action: SPACE_THEME_ACTION_PREFIX + INHERIT_THEME })
        themeSubmenu.push({ type: 'separator' })
        for (const t of themes) {
          if (!t || !t.id) continue
          themeSubmenu.push({ label: t.name || t.id, action: SPACE_THEME_ACTION_PREFIX + t.id })
        }
      }
    } catch (_) { /* 主题域不可用 → 不出现这一项 */ }
    menuClient.popupMenu({
      x,
      y,
      items: [
        { label: '重命名', action: 'rename' },
        ...(id === 'default' ? [] : [{ label: '删除空间', action: 'remove' }]),
        { type: 'separator' },
        { label: '管理空间', action: 'manage' },
        ...(themeSubmenu.length ? [{ type: 'separator' }, { label: '空间主题', type: 'submenu', submenu: themeSubmenu }] : [])
      ]
    }).then((action: string | null) => {
      if (action === 'rename') { if (typeof onRename === 'function') onRename(id) }
      else if (action === 'manage' && tabsClient) openUrlPreferExistingTab(pageUrl('spaces'), tabsClient).catch(() => {})
      else if (action === 'remove') spaceClient?.remove(profileId, id).catch(() => {})
      else if (action?.startsWith(SPACE_THEME_ACTION_PREFIX)) {
        // null = 清掉该空间的覆盖（落回用户设置）；否则写主题 id。
        const value = action.slice(SPACE_THEME_ACTION_PREFIX.length)
        settingsClient?.setForSpace(id, SPACE_THEME_KEY, value === INHERIT_THEME ? null : value, profileId).catch(() => {})
      }
    }).catch(() => {})
  }
}

/**
 * Spaces 面板 = 「当前空间」条 + 新建/管理按钮 + `createSpaceRows` 的行列表。
 * 面板特有的两件（当前空间摘要、新建/管理入口）留在这里；行与行菜单都来自上面的共用件。
 */
export function createSpacesPanel(doc: Document, handlers: SpacePanelHandlers = {}) {
  const emit = (intent: SpaceIntent) => {
    if (typeof handlers.onIntent === 'function') handlers.onIntent(intent)
  }
  const renderUiIcon = makeIconRenderer(handlers, 'renderUiIcon')

  const wrap = doc.createElement('div')
  wrap.className = 'spaces-panel__wrap'
  const currentEl = doc.createElement('div')
  currentEl.className = 'spaces-panel__current'
  wrap.appendChild(currentEl)
  const actions = doc.createElement('div')
  actions.className = 'spaces-panel__actions'
  const addBtn = doc.createElement('button')
  addBtn.className = 'spaces-panel__add'
  addBtn.type = 'button'
  addBtn.title = '新建空间'
  addBtn.setAttribute('aria-label', addBtn.title)
  const addIcon = renderUiIcon('plus', 16)
  if (addIcon) addBtn.appendChild(addIcon)
  addBtn.addEventListener('click', () => emit({ type: 'create' }))
  const manageBtn = doc.createElement('button')
  manageBtn.className = 'spaces-panel__add'
  manageBtn.type = 'button'
  manageBtn.title = '管理空间'
  manageBtn.setAttribute('aria-label', manageBtn.title)
  const manageIcon = renderUiIcon('settings', 16)
  if (manageIcon) manageBtn.appendChild(manageIcon)
  manageBtn.addEventListener('click', () => emit({ type: 'manage' }))
  actions.append(addBtn, manageBtn)
  wrap.appendChild(actions)

  const rows = createSpaceRows(doc, handlers)
  wrap.appendChild(rows.element)

  let spaces: SpaceRowItem[] = []
  let activeId = ''
  let activeProfileId = ''

  function renderCurrent() {
    const active = spaces.find((space) => space.id === activeId && space.profileId === activeProfileId) || spaces[0] || null
    currentEl.textContent = ''
    if (!active) return
    const dot = doc.createElement('span')
    dot.className = 'spaces-panel__dot'
    dot.style.background = gradientOf(active) || 'var(--hira-border-subtle, rgba(0,0,0,0.15))'
    const label = doc.createElement('span')
    label.className = 'spaces-panel__current-label'
    label.textContent = `当前空间：${active.name || active.id}`
    currentEl.append(dot, label)
  }

  function setSpaces(next: readonly SpaceRowItem[], nextActiveId: string, nextActiveProfileId: string) {
    spaces = Array.isArray(next) ? next.slice() : []
    activeId = nextActiveId || ''
    activeProfileId = nextActiveProfileId || ''
    renderCurrent()
    rows.setSpaces(spaces, activeId, activeProfileId)
  }

  renderCurrent()
  return { element: wrap, setSpaces, startRename: rows.startRename }
}

export const injectProfilesPanelStyles = injectSpacesPanelStyles
export const createProfilesPanel = createSpacesPanel

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'spaces-panel',
  injectStyles: injectSpacesPanelStyles,

  mount(doc, ctx) {
    const panelCtx = ctx as PanelContext & SpacePanelContext
    const { clients, events, on, icons } = panelCtx
    const menuClient = ctx.menu as SpaceMenuClient | null | undefined
    const tabsClient = clients.tabs
    const spaceClient = clients.space
    const profilesClient = clients.profiles
    // 空间级设置（B2 / J13）：给"具名空间"写按空间隔离的键（目前只有主题）。
    const settingsClient = clients.settings
    // 主题目录源（B1 的"空间换装"要选主题；目录是数据，弹菜单前现取，不写死 id）。
    const themeClient = clients.themes

    const panel = createSpacesPanel(doc, {
      // 图标注入：面板保持零图标依赖，与 rail/navbar 同一装配方式
      renderIcon: (name: string, size?: number) => icons.space(name, size || 18),
      renderUiIcon: (name: string, size?: number) => icons.ui(name, size || 14),
      async onIntent(intent) {
        const { type, id, profileId, name } = intent
        // 面板里「新建 / 管理」都落到 hira://spaces 页；已有同页标签优先切换，否则新开。
        if (type === 'create') {
          openUrlPreferExistingTab(pageUrl('spaces'), tabsClient).catch(() => {})
        } else if (type === 'manage') {
          openUrlPreferExistingTab(pageUrl('spaces'), tabsClient).catch(() => {})
        } else if (type === 'switch' && id && profileId) {
          spaceClient.setUsing(profileId, id).catch(() => {})
        } else if (type === 'rename' && id && profileId && name) {
          spaceClient.update(profileId, id, { name }).then(refresh).catch(() => {})
        } else if (type === 'menu' && id && profileId) {
          // 弹菜单归共用件（聚合总览用的是同一份）；改名要在这一行上原地开输入框，
          // 故把「行组件的状态」经 onRename 回填进去。
          openSpaceMenu({
            id: String(id),
            profileId: String(profileId),
            x: typeof intent.x === 'number' ? intent.x : 0,
            y: typeof intent.y === 'number' ? intent.y : 0
          })
        }
      }
    })

    const openSpaceMenu = createSpaceMenu({
      menuClient,
      themeClient,
      settingsClient,
      tabsClient,
      spaceClient,
      onRename: (id: string) => panel.startRename(id)
    })

    let refreshRevision = 0
    async function refresh() {
      const revision = ++refreshRevision
      try {
        const [items, active, profiles] = await Promise.all([
          spaceClient.listAll(),
          spaceClient.getUsing().catch(() => null),
          profilesClient.listVisible().catch(() => [])
        ])
        const profileNames = new Map((Array.isArray(profiles) ? profiles : []).map((p) => [p.id, p.name || p.id]))
        if (revision !== refreshRevision) return
        const enriched = (Array.isArray(items) ? items : []).map((space) => ({
          ...space,
          profileName: profileNames.get(space.profileId) || space.profileId
        }))
        panel.setSpaces(enriched, active?.id || '', active?.profileId || '')
      } catch (e) {
        if (revision !== refreshRevision) return
        console.error('[panels] spaces refresh failed:', e)
      }
    }

    void refresh().catch(() => {})
    on(events.spaceChanged, refresh)
    on(events.spaceWindowChanged, refresh)

    return { element: panel.element, refresh }
  }
}
