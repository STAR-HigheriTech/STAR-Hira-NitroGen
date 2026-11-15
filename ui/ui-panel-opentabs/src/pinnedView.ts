// @ts-check
/**
 * opentabs 面板的「已固定」分段 —— 固定标签（固定文件夹）的管理视图。
 *
 * 它原先是独立面板 `ui-panel-pinned`；IA 归并后并入「标签」面板，
 * 作为第二分段。归并的理由见 `index.js` 头注释：**固定标签就是打开中的标签的
 * 一个子集**，给它们各开一个 rail 入口只会让人分不清该点哪个。
 *
 * ── 两种视图，统一管理（不做两份实现）──────────────────────────────────────
 *   · **列表**：与 `ui-panel-opentabs`、`ui-vertical-tabs`、覆盖态悬浮列表**共用同一个
 *     实现**（`@hira-ng/ui-common#createTabListHost`）—— 同一套排版 / 样式令牌 / hover
 *     预览 / 右键菜单 / 拖拽排序 / 音频与关闭按钮；
 *   · **网格**（A4 / Pin Grid）：`@hira-ng/ui-common#createPinGrid` —— 大卡片平铺，
 *     文件夹是整行宽的抬头（与列表组行同一套动作：收展 / 双击改名 / 右键菜单 / 拖入）。
 * 两种形态吃**同一份文件夹模型**（`buildFolderModel`），差异只停留在**渲染形状**；
 * 模式偏好落设置项 `panels.pinned_view_mode`（随 profile 持久化，多窗口同步）。
 *
 * ── 解耦 ────────────────────────────────────────────────────────────────
 * 不直接调 IPC：数据走 `ctx.clients.tabs`，动作走 `@hira-ng/ui-common` 的纯原语；
 * 本视图是一个**哑组件**，由分段壳（index.js）决定何时装配 / 销毁。
 */

import type { PanelContext } from '@hira-ng/ui-common'
import type {
  MenuItem,
  PinGridController,
  PinGridInput,
  PinGridTab,
  PinReorderInfo,
  PinnedStackSource,
  TabListHostContext,
  TabListHostController,
  TabRowItem,
  TabRowMenuClient,
  TabRowTab,
  TabRowPreviewOverlay,
  StackMenuClient
} from '@hira-ng/ui-common'
import {
  injectPanelStyles,
  injectTabRowStyles,
  injectPinGridStyles,
  createTabListHost,
  createPinGrid,
  withBesideRowPreview,
  iconByName,
  TAB_MENU_LABELS,
  createPinnedFolder,
  pinTabToNewFolder,
  moveTabToPinnedFolder,
  listPinnedFolders,
  createStackChipMenu,
  createStackMenuHandlers,
  runStackMenuAction,
  STACK_MENU_RENAME,
  NEW_PINNED_STACK_LABEL,
  pinnedFolderMenuLabel
} from '@hira-ng/ui-common'
// 形态取值集合与设置键名的真源（域层默认值 / 设置页共用），见 panels.mjs。
import {
  PANELS_SETTING_KEYS, PINNED_VIEW_MODES, DEFAULT_PINNED_VIEW_MODE
} from '@hira-ng/shared-types/src/panels.mjs'

/** 视图模式设置键（默认值见 domain-settings 的 DEFAULT_SETTINGS）。 */
const VIEW_MODE_KEY = PANELS_SETTING_KEYS.pinnedViewMode

type PinnedViewMode = 'list' | 'grid'

interface SettingsPort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}

interface PinnedTabsPort {
  list(): Promise<TabRowItem[]>
  projection(): Promise<TabRowItem[]>
  onChanged(listener: (payload: TabChangedPayload) => void): () => void
  createStack(input: { tabIds: string[]; pinned: true; label?: string }): Promise<unknown>
  addToPinnedGroup?(tabId: string, stackId: string): Promise<unknown>
  setTabStack?(tabId: string, stackId: string): Promise<unknown>
  listStacks(): Promise<readonly PinnedStackSource[]>
  switchTab(tabId: string): unknown
  toggleMute(tabId: string): unknown
  reorder(payload: { draggedId: string; targetId: string; insertAfter: boolean }): Promise<unknown>
  toggleStack(stackId: string): unknown
  renameStack(stackId: string, label: string): unknown
}

interface TabChangedPayload {
  tabs?: TabRowItem[]
  projection?: TabRowItem[]
}

interface PinnedSettingsChange {
  key?: unknown
  value?: unknown
}

type PinnedViewContext = Omit<PanelContext, 'clients' | 'menu' | 'createTabRowMenu' | 'previewOverlay'> & {
  clients?: (PanelContext['clients'] & {
    tabs?: PinnedTabsPort
    settings?: SettingsPort
  }) | null
  menu?: TabRowMenuClient | null
  createTabRowMenu?: TabListHostContext['createTabRowMenu']
  previewOverlay?: TabRowPreviewOverlay | null
  events?: { settingsChanged?: string }
}

export interface PinnedFolderModel {
  stackId: string
  label: string
  accent: string
  collapsed: boolean
  children: PinGridTab[]
}

type PinnedViewController = TabListHostController | PinGridController

/** 偏好值是否合法（白名单来自 shared-types，拒绝手改文件里的野值）。 */
const isViewMode = (value: unknown): value is PinnedViewMode =>
  typeof value === 'string' && PINNED_VIEW_MODES.includes(value as PinnedViewMode)

const STYLE_ID = 'hira-pinned-panel-styles'

/** 「固定当前标签」选择菜单里的动作前缀（与标签右键菜单的 `pinnedFolder:` 同一口径）。 */
const FOLDER_ACTION_PREFIX = 'pinnedFolder:'
const FOLDER_ACTION_NEW = `${FOLDER_ACTION_PREFIX}new`

export function injectPinnedViewStyles(doc: Document): void {
  injectPanelStyles(doc)
  injectTabRowStyles(doc)
  injectPinGridStyles(doc)
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .pinned-root { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; min-height: 0; }
    .pinned-toolbar {
      display: flex; align-items: center; gap: 4px; flex-shrink: 0;
      padding: 0 0 8px; margin-bottom: 4px;
    }
    .pinned-toolbar__spacer { flex: 1 1 auto; }
    .pinned-count {
      font-size: 11.5px; color: var(--hira-text-tertiary, #8b8b8b);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      user-select: none; min-width: 0;
    }
    .pinned-seg { display: inline-flex; align-items: center; gap: 1px; }
    .pinned-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: var(--hira-control-height, 32px); height: var(--hira-control-height, 32px);
      padding: 0; border: none; border-radius: var(--hira-radius-sm, 8px);
      /* 顶部图标按钮走「次文本」档（与 .hp-btn / 刷新类按钮同档）：tertiary 在浅色
         面板底上只有 2.4:1，32px 的线性图标读起来发灰；secondary 约 4.9:1。 */
      background: transparent; color: var(--hira-text-secondary, #6b7280);
      cursor: pointer;
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .pinned-btn:hover:not(:disabled) { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    .pinned-btn:disabled { opacity: 0.4; cursor: default; }
    .pinned-btn--active { color: var(--hira-accent, #3b82f6); background: var(--hira-accent-soft, rgba(59,130,246,0.14)); }
    .pinned-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  `
  doc.head.appendChild(style)
}

/**
 * 把「投影 + 扁平标签」合成**唯一文件夹模型**（两种视图共用）。
 *
 * 只认 `type:'stack' && pinned` 的投影项 —— 顺序 / 名称 / 配色 / 收展由它给；
 * 成员按 `tab.stackId` 从扁平列表里分组（投影对折叠组只补发活动成员，
 * 网格展开时必须拿到全部成员，所以不能直接吃投影里的 children）。
 *
 * @param {readonly TabRowItem[]} projection
 * @param {readonly TabRowItem[]} flat
 * @returns {PinnedFolderModel[]}
 */
export function buildFolderModel(projection: readonly TabRowItem[], flat: readonly TabRowItem[]): PinnedFolderModel[] {
  const folders: PinnedFolderModel[] = []
  const byId = new Map<string, PinnedFolderModel>()
  for (const item of Array.isArray(projection) ? projection : []) {
    if (!item || item.type !== 'stack' || !item.pinned || item.stackId == null) continue
    const folder: PinnedFolderModel = {
      stackId: String(item.stackId),
      label: typeof item.label === 'string' ? item.label : '',
      accent: typeof item.accent === 'string' ? item.accent : '',
      collapsed: !!item.collapsed,
      children: []
    }
    folders.push(folder)
    byId.set(folder.stackId, folder)
  }
  for (const tab of Array.isArray(flat) ? flat : []) {
    if (!tab || tab.type === 'stack' || tab.tabId == null || tab.stackId == null) continue
    const folder = byId.get(String(tab.stackId))
    if (folder) folder.children.push(tab as PinGridTab)
  }
  return folders
}

/**
 * @param {Document} doc
 * @param {PinnedViewContext} [ctx] 面板宿主端口（clients / menu / createTabRowMenu / previewOverlay / on / events …）
 * @returns {{ element: HTMLElement, refresh: () => Promise<void>, dispose: () => void }}
 */
export function createPinnedView(doc: Document, ctx: PanelContext = {}) : { element: HTMLElement, refresh: () => Promise<void>, dispose: () => void } {
  injectPinnedViewStyles(doc)
  const viewCtx = ctx as PinnedViewContext
  const tabs = viewCtx.clients?.tabs || null
  const settings = viewCtx.clients?.settings || null
  const labels = TAB_MENU_LABELS.below
  /** 文件夹动作表（解散 / 平铺 / 合并 / 配色）—— 与标签组芯片、纵向列表**同一份**。 */
  const stackHandlers = createStackMenuHandlers(tabs as StackMenuClient | null)

  /**
   * 三份数据，全部来自**同一根真源**（`tabs.list()` + `tabs.projection()`）：
   *   · `allTabs`     —— 当前空间的全部标签（找活动待固定标签 / 分组用）；
   *   · `folders`     —— 唯一文件夹模型（见 buildFolderModel）；
   *   · `listItems`   —— 列表形态要的投影切片（固定组行 + 展开成员）；
   *   · `gridItems`   —— 网格形态要的混排条目（folder 抬头 + 散固定标签）。
   */
  let allTabs: TabRowItem[] = []
  let flatItems: TabRowTab[] = []
  let listItems: TabRowItem[] = []
  let folders: PinnedFolderModel[] = []
  let gridItems: PinGridInput[] = []
  /** 当前模式：'list' | 'grid'。 */
  let mode: PinnedViewMode = (isViewMode(DEFAULT_PINNED_VIEW_MODE) ? DEFAULT_PINNED_VIEW_MODE : 'list')
  let disposed = false
  /** 当前装配的视图控制器（列表宿主或网格），切换模式时整体换掉。 */
  let view: PinnedViewController | null = null
  /** 新建后等待进入行内改名的文件夹 id（空串表示没有待办）。 */
  let pendingRenameId = ''
  let unsubscribeTabs: (() => void) | null = null
  let unsubscribeSettings: (() => void) | null = null

  const root = doc.createElement('div')
  root.className = 'pinned-root'

  const toolbar = doc.createElement('div')
  toolbar.className = 'pinned-toolbar'

  /** 左侧：数量提示（固定的价值是"常驻"，先让人看见现在有几个常驻页）。 */
  const countLabel = doc.createElement('span')
  countLabel.className = 'pinned-count'

  /** 右侧：列表 / 网格 分段切换。 */
  const seg = doc.createElement('div')
  seg.className = 'pinned-seg'
  const listBtn = doc.createElement('button')
  listBtn.type = 'button'
  listBtn.className = 'pinned-btn'
  listBtn.title = '列表视图'
  listBtn.setAttribute('aria-label', '列表视图')
  const listIcon = iconByName('List', doc, { size: 15 })
  if (listIcon) listBtn.appendChild(listIcon)
  const gridBtn = doc.createElement('button')
  gridBtn.type = 'button'
  gridBtn.className = 'pinned-btn'
  gridBtn.title = '网格视图'
  gridBtn.setAttribute('aria-label', '网格视图')
  const gridIcon = iconByName('LayoutGrid', doc, { size: 15 })
  if (gridIcon) gridBtn.appendChild(gridIcon)
  seg.append(listBtn, gridBtn)

  /**
   * 「新建文件夹」：收藏夹的第一动作 —— 先有一个空文件夹，再把标签加进去。
   * 建完立刻让抬头进入行内改名（两种视图都支持），避免停在默认名上。
   */
  const newFolderBtn = doc.createElement('button')
  newFolderBtn.type = 'button'
  newFolderBtn.className = 'pinned-btn'
  newFolderBtn.title = NEW_PINNED_STACK_LABEL
  newFolderBtn.setAttribute('aria-label', NEW_PINNED_STACK_LABEL)
  const folderPlusIcon = iconByName('FolderPlus', doc, { size: 15 })
  if (folderPlusIcon) newFolderBtn.appendChild(folderPlusIcon)

  /**
   * 「固定当前标签」：固定这件事最自然的入口是**正在看的这一页**。
   * 点击弹文件夹选择菜单（已有文件夹 / 新建文件夹…）—— 而不是闷头塞进默认组。
   * 没有活动可固定标签时禁用（而不是点了没反应）—— 面板里不出现"哑按钮"。
   */
  const pinCurrentBtn = doc.createElement('button')
  pinCurrentBtn.type = 'button'
  pinCurrentBtn.className = 'pinned-btn'
  pinCurrentBtn.title = '固定当前标签…'
  pinCurrentBtn.setAttribute('aria-label', '固定当前标签')
  const pinIcon = iconByName('Pin', doc, { size: 15 })
  if (pinIcon) pinCurrentBtn.appendChild(pinIcon)

  /** 手动重取：面板平时靠 `tabs.onChanged` 自更新，这个按钮只用于"我不确定现在是不是最新"。 */
  const refreshBtn = doc.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.className = 'pinned-btn'
  refreshBtn.title = '刷新'
  refreshBtn.setAttribute('aria-label', '刷新')
  const refreshIcon = iconByName('RefreshCw', doc, { size: 15 })
  if (refreshIcon) refreshBtn.appendChild(refreshIcon)

  const spacer = doc.createElement('div')
  spacer.className = 'pinned-toolbar__spacer'

  toolbar.append(countLabel, spacer, newFolderBtn, pinCurrentBtn, refreshBtn, seg)

  const body = doc.createElement('div')
  body.className = 'pinned-body'

  root.append(toolbar, body)

  /**
   * 网格里的标签卡片右键菜单 —— 与纵向列表**同一个菜单定义**（`ctx.createTabRowMenu`），
   * `getItems` 供「按域名分组」判据用。晚绑定到扁平的固定标签（每次弹菜单现读）。
   */
  const showMenu = typeof viewCtx.createTabRowMenu === 'function'
    ? viewCtx.createTabRowMenu({ labels, getItems: () => flatItems })
    : null

  const overlay = withBesideRowPreview(viewCtx.previewOverlay, () => root)

  /**
   * 文件夹抬头的右键菜单 —— 模板与动作分派都来自 `tab/chipMenu.ts`（与标签组芯片、
   * 纵向组行同一份）；本视图只提供「同级文件夹」与「开行内改名」两件宿主侧的事。
   */
  const folderMenu = createStackChipMenu({
    showMenu: viewCtx.menu && typeof viewCtx.menu.popupMenu === 'function'
      ? async (payload) => Promise.resolve(viewCtx.menu!.popupMenu!(payload))
      : null,
    getSiblings: () => folders.map((folder) => ({ stackId: folder.stackId, label: folder.label, pinned: true }))
  })

  function switchTab(tab: PinGridTab) {
    if (tabs && typeof tabs.switchTab === 'function' && tab) tabs.switchTab(String(tab.tabId))
  }

  /**
   * 空态文案是**固定语义的唯一说明处**：第一次打开这一栏时用户往往还没固定过任何页，
   * 这时最该回答的就是"固定有什么用 / 从哪开始"。（列表 / 网格共用同一句。）
   */
  const EMPTY_TEXT = '还没有固定标签。新建一个固定标签组，或右键标签选择「固定标签 ▸ 添加到固定标签组」。'

  function mountListView() {
    return createTabListHost(doc, {
      clients: viewCtx.clients as TabListHostContext['clients'],
      createTabRowMenu: viewCtx.createTabRowMenu,
      // 「与谁相邻」的判据喂扁平的固定标签（投影里的组行不是标签，不参与相邻判断）。
      getMenuItems: () => flatItems,
      menu: viewCtx.menu,
      previewOverlay: viewCtx.previewOverlay,
      labels,
      dragKind: 'pinned',
      showAddButton: false,
      // 默认 projection：固定标签在列表里就是**固定标签组行**（可收起 / 可改名），
      // 与 tabbar / 垂直标签 / opentabs 三处同一形态。
      emptyText: EMPTY_TEXT
    })
  }

  function mountGridView() {
    return createPinGrid(doc, {
      emptyText: EMPTY_TEXT,
      overlay,
      onActivate: (tab: PinGridTab) => switchTab(tab),
      onToggleMute: (tab: PinGridTab) => { if (tabs && tab) tabs.toggleMute(String(tab.tabId)) },
      onReorder: (info: PinReorderInfo) => {
        if (tabs && typeof tabs.reorder === 'function') {
          tabs.reorder({ draggedId: info.draggedId, targetId: info.targetId, insertAfter: info.insertAfter })
        }
      },
      onContextMenu: (tab: PinGridTab, ev: MouseEvent, nextItem?: PinGridTab) => {
        if (showMenu) showMenu(ev.clientX, ev.clientY, tab, nextItem || null)
      },
      // ── 文件夹动作（与列表组行的能力一一对应）──
      onToggleFolder: (stackId: string) => {
        if (tabs && typeof tabs.toggleStack === 'function') tabs.toggleStack(String(stackId))
      },
      onRenameFolder: (stackId: string, label: string) => {
        if (tabs && typeof tabs.renameStack === 'function') tabs.renameStack(String(stackId), label)
      },
      onMoveToFolder: (tabId: string, stackId: string) => {
        // 与右键「放到固定文件夹」同源：普通标签 → 固定文件夹是 pin 动作，不能走 setTabStack。
        if (tabs) moveTabToPinnedFolder(tabs, tabId, stackId)
      },
      onFolderMenu: (stackId: string, ev: MouseEvent, api: { beginRename: () => void }) => openFolderMenu(stackId, ev, api)
    })
  }

  /**
   * 文件夹抬头菜单的完整流程：出菜单 → 分派动作 → 重命名交给视图开输入框。
   * 数据落库后由 `tab:changed` 推送刷新视图，这里不手动重取（少一次 IPC）。
   */
  async function openFolderMenu(stackId: string, ev: MouseEvent, api: { beginRename: () => void }) {
    const id = String(stackId)
    const folder = folders.find((candidate) => candidate.stackId === id)
    if (!folder) return
    const action = await folderMenu(ev.clientX, ev.clientY, {
      stackId: id,
      pinned: true,
      label: folder.label,
      accent: folder.accent,
      children: folder.children
    })
    if (disposed || !action) return
    const outcome = runStackMenuAction(action, {
      stackId: id,
      children: folder.children.map((tab) => String(tab.tabId))
    }, stackHandlers)
    if (outcome === STACK_MENU_RENAME) api.beginRename()
  }

  /** 活动且**未固定**的标签 —— 「固定当前标签」唯一的候选。 */
  function findPinCandidate() {
    const candidate = allTabs.find((tab) => tab.type !== 'stack' && tab.active === true && !tab.pinned)
    return candidate && candidate.type !== 'stack' ? candidate : null
  }

  /** 当前模式该吃的那一份数据。 */
  function currentItems() {
    return mode === 'grid' ? gridItems : listItems
  }

  /** 新建文件夹后：数据就位的那一刻让对应抬头进入改名。 */
  function flushPendingRename() {
    if (!pendingRenameId) return
    const begin = view && ('beginRenameFolder' in view ? view.beginRenameFolder : view.beginRenameStack)
    if (typeof begin !== 'function') { pendingRenameId = ''; return }
    if (begin.call(view, pendingRenameId)) pendingRenameId = ''
  }

  /** 把当前模式对应的数据推给已装配的视图。 */
  function pushToView() {
    if (!view) return
    if (mode === 'grid') (view as PinGridController).setItems(gridItems)
    else (view as TabListHostController).setItems(listItems)
    flushPendingRename()
  }

  /** 工具栏是**两种模式共用的那一份状态**（数量 / 可固定性 / 模式高亮）。 */
  function renderToolbar() {
    const count = flatItems.length
    countLabel.textContent = count ? `固定标签 ${count}` : '未固定标签'
    countLabel.title = count
      ? `${count} 个固定标签，分布在 ${folders.length} 个组里`
      : '固定标签会常驻在标签条最前'
    pinCurrentBtn.disabled = !findPinCandidate()
    listBtn.classList.toggle('pinned-btn--active', mode === 'list')
    gridBtn.classList.toggle('pinned-btn--active', mode === 'grid')
  }

  function stackIdFrom(result: unknown): string {
    if (!result || typeof result !== 'object') return ''
    const stackId = (result as { stackId?: unknown }).stackId
    return stackId == null ? '' : String(stackId)
  }

  /** 用当前模式（重新）装配视图，并把已有数据灌进去。 */
  function mountView() {
    view?.dispose()
    body.replaceChildren()
    view = mode === 'grid' ? mountGridView() : mountListView()
    if (view) body.appendChild(view.element)
    pushToView()
    renderToolbar()
  }

  function setMode(next: unknown, persist: boolean) {
    const normalized: PinnedViewMode = isViewMode(next) ? next : 'list'
    if (normalized === mode) return
    mode = normalized
    mountView()
    if (persist && settings && typeof settings.set === 'function') {
      settings.set(VIEW_MODE_KEY, mode).catch(() => {})
    }
  }

  listBtn.addEventListener('click', () => setMode('list', true))
  gridBtn.addEventListener('click', () => setMode('grid', true))

  /** 新建一个空固定文件夹（默认名由领域原语给），随后进入改名。 */
  async function createFolder() {
    if (!tabs) return
    newFolderBtn.disabled = true
    try {
      const res = await createPinnedFolder(tabs)
      const stackId = stackIdFrom(res)
      if (stackId) pendingRenameId = stackId
      await load()
    } catch (_) {}
    newFolderBtn.disabled = false
  }

  /**
   * 「固定当前标签」→ 选文件夹。
   *
   * 菜单由**本视图现弹**（而不是复用标签右键菜单）：这里要回答的是"放进哪个文件夹"，
   * 列表来自 `listPinnedFolders`（与右键子菜单同一份数据源），空文件夹也在列。
   */
  async function pinCurrentWithFolder(anchorEl: HTMLElement) {
    const candidate = findPinCandidate()
    if (!candidate || !tabs) return
    const menuClient = viewCtx.menu
    if (!menuClient || typeof menuClient.popupMenu !== 'function') {
      // 没有菜单端口（极简宿主）→ 退回"新建一个文件夹并放进去"，仍然不会进默认组。
      const res = await pinTabToNewFolder(tabs, String(candidate.tabId))
      const stackId = stackIdFrom(res)
      if (stackId) pendingRenameId = stackId
      void load({})
      return
    }
    const existing = await listPinnedFolders(tabs)
    if (disposed) return
    const items: MenuItem[] = existing.map((f) => ({
      label: pinnedFolderMenuLabel(f),
      action: `${FOLDER_ACTION_PREFIX}${f.stackId}`
    }))
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: `${NEW_PINNED_STACK_LABEL}…`, action: FOLDER_ACTION_NEW })

    const rect = anchorEl && typeof anchorEl.getBoundingClientRect === 'function'
      ? anchorEl.getBoundingClientRect()
      : { left: 0, bottom: 0 }
    const action = await menuClient.popupMenu({ items, x: rect.left, y: rect.bottom + 2 })
    if (disposed || !action) return

    pinCurrentBtn.disabled = true
    try {
      if (action === FOLDER_ACTION_NEW) {
        const res = await pinTabToNewFolder(tabs, String(candidate.tabId))
        const stackId = stackIdFrom(res)
        if (stackId) pendingRenameId = stackId
      } else if (String(action).startsWith(FOLDER_ACTION_PREFIX)) {
        const stackId = String(action).slice(FOLDER_ACTION_PREFIX.length)
        if (stackId) await moveTabToPinnedFolder(tabs, String(candidate.tabId), stackId)
      }
      await load()
    } catch (_) {}
    pinCurrentBtn.disabled = false
  }

  newFolderBtn.addEventListener('click', () => { createFolder() })

  pinCurrentBtn.addEventListener('click', () => { pinCurrentWithFolder(pinCurrentBtn) })

  refreshBtn.addEventListener('click', () => { void load() })

  /**
   * 投影 → 列表形态该显示的那一份。
   *
   * 只保留**与固定相关**的项：固定文件夹组行 + 其（展开的）成员。
   * `pinned ⟺ 属于 pinned 栈` 是数据层的不变式（见 tabLayout 的固定分组原语），
   * 所以投影里不会出现游离的固定标签：组行带 `pinned`，成员也带 `pinned`。
   */
  function filterPinnedList(projection: readonly TabRowItem[]) {
    const list = Array.isArray(projection) ? projection : []
    return list.filter((item) => !!item && !!item.pinned)
  }

  /** 文件夹模型 → 网格条目（folder 抬头携带全部成员；兜底收编前的游离固定标签排在后面）。 */
  function buildGridItems(model: readonly PinnedFolderModel[], pinnedTabs: readonly TabRowTab[]): PinGridInput[] {
    const inFolder = new Set<string>()
    const items: PinGridInput[] = model.map((folder) => {
      for (const tab of folder.children) inFolder.add(String(tab.tabId))
      return {
        type: 'folder',
        stackId: folder.stackId,
        label: folder.label,
        accent: folder.accent,
        collapsed: folder.collapsed,
        children: folder.children
      }
    })
    for (const tab of pinnedTabs) {
      if (!inFolder.has(String(tab.tabId))) items.push(tab)
    }
    return items
  }

  /**
   * 一次取回**两份**原始数据（`tabs` 扁平 + `projection` 投影），再合成三份视图数据。
   *
   * `payload` 为 `tab:changed` 的推送载荷时直接复用（它同时带两份），免得每次变更都多跑 IPC。
   */
  async function load(payload?: TabChangedPayload) {
    if (disposed || !tabs) return
    try {
      let flat: TabRowItem[] | null = Array.isArray(payload?.tabs) ? payload.tabs : null
      let projection: TabRowItem[] | null = Array.isArray(payload?.projection) ? payload.projection : null
      if (!flat) flat = await tabs.list()
      if (disposed) return
      allTabs = Array.isArray(flat) ? flat : []
      flatItems = allTabs.filter((tab): tab is TabRowTab => tab.type !== 'stack' && tab.pinned === true)
      if (!projection) projection = await tabs.projection()
      if (disposed) return
      listItems = filterPinnedList(projection)
      folders = buildFolderModel(projection, allTabs)
      gridItems = buildGridItems(folders, flatItems)
      pushToView()
      renderToolbar()
    } catch (_) {}
  }

  // 启动：先装配（默认列表），再读模式偏好，最后拉数据。
  mountView()
  if (settings && typeof settings.get === 'function') {
    settings.get(VIEW_MODE_KEY).then((value) => {
      if (disposed) return
      if (isViewMode(value)) {
        mode = value
        mountView()
      }
    }).catch(() => {})
  }
  void load()

  // 标签变化 → 直接用推送里的两份数据（tabs 扁平 + projection 投影），不额外跑 IPC。
  if (tabs) {
    unsubscribeTabs = tabs.onChanged((payload) => { void load(payload) })
  }
  // 模式偏好变化（别的窗口改了 / 设置页改了）→ 本窗口跟随
  if (typeof viewCtx.on === 'function' && viewCtx.events && viewCtx.events.settingsChanged) {
    const unsubscribe = viewCtx.on(viewCtx.events.settingsChanged, (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const change = payload as PinnedSettingsChange
      if (change.key !== VIEW_MODE_KEY || !isViewMode(change.value)) return
      if (isViewMode(change.value)) {
        mode = change.value
        mountView()
      }
    })
    if (typeof unsubscribe === 'function') unsubscribeSettings = unsubscribe
  }

  return {
    element: root,
    refresh() {
      return load()
    },
    dispose() {
      disposed = true
      if (unsubscribeTabs) unsubscribeTabs()
      if (unsubscribeSettings) unsubscribeSettings()
      unsubscribeTabs = null
      unsubscribeSettings = null
      view?.dispose()
      view = null
      root.remove()
    }
  }
}
