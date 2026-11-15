// 分屏比例预设的**中文名真源**（与设置页下拉共用一份，不在此手抄）。
import { SPLIT_RATIO_PRESET_OPTIONS } from '@hira-ng/shared-types/src/split-layout.mjs'
// 标签「种类」能力表（固定标签 = 特殊种类）—— 菜单可见性的**唯一裁决源**。
// 分屏 / 速览 / 复制 / 归档 / 按域名分组 / 出栈 / 堆叠 / 关闭其他 全部走同一份判据：
// 绝不在这里另写 `!t.pinned`，否则主进程与菜单会各说各话（"点了没反应"的经典来源）。
import {
  canSplit,
  canGlance,
  canDuplicate,
  canArchive,
  canGroupByDomain as canGroupTabsByDomain,
  canCloseWithOthers,
  canLeaveStack,
  canStackTogether
} from '@hira-ng/shared-types/src/tab-policy.mjs'
// 「算不算普通网页」的唯一判据（PWA 安装只对 http(s) 页面开放）。
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
// 音频按钮 / 菜单项的「静音 / 取消静音」文案与标签条、网格共用同一份。
import { audioToggleLabel } from './tab/audioLabel'
// 组名兜底 / 种类名词的唯一真源（与芯片菜单、纵向组行共用）。
import { pinnedFolderMenuLabel, stackKindLabel, NEW_PINNED_STACK_LABEL } from './tabStackActions'
import type { MenuItem, PopMenu } from './menuTypes'

export interface TabMenuTab {
  tabId?: string | number
  url?: string
  title?: string
  pinned?: boolean
  muted?: boolean
  isPlaying?: boolean
  incognito?: boolean
  active?: boolean
  stackId?: string | number | null
  splitId?: string | number | null
  glanceId?: string | number | null
  autoRefreshMs?: number
  canGoBack?: boolean
  canGoForward?: boolean
  type?: 'tab' | 'stack' | string
  [key: string]: unknown
}

export interface TabMenuLabels {
  stack: string
  tab: string
  split?: string
}

export interface PinnedFolderMenuItem {
  stackId: string | number
  label?: string
  count?: number
}

export interface PwaMenuState {
  state?: string
  appId?: string | null
}

export interface NavigationMenuState {
  canGoBack?: boolean
  canGoForward?: boolean
}

export interface ContainerProfile {
  id: string
  name?: string
}

export interface TabContextMenuHandlers {
  onBack?: (tabId: string) => void
  onForward?: (tabId: string) => void
  getNavigationState?: (tabId: string) => Promise<NavigationMenuState | null> | NavigationMenuState | null
  onReload?: (tabId: string) => void
  onDuplicate?: (tabId: string) => void
  onStackWith?: (tabId: string, nextItem: TabMenuTab | null) => void
  onNewTab?: () => void
  onTogglePin?: (tabId: string) => void
  onToggleMute?: (tabId: string) => void
  onPinToNewGroup?: (tabId: string) => void
  listPinnedFolders?: () => Promise<PinnedFolderMenuItem[]> | PinnedFolderMenuItem[]
  onPinToFolder?: (tabId: string, stackId: string) => void
  onAutoRefresh?: (tabId: string, ms: number) => void
  onSharePage?: (tab: TabMenuTab) => void
  listCollectionEntries?: () => Promise<Array<{ label?: string; action?: string; type?: string }>> | Array<{ label?: string; action?: string; type?: string }>
  onCollectionAction?: (tab: TabMenuTab, action: string) => void
  onCloseTab?: (tabId: string) => void
  onCloseOthers?: (tabId: string) => void
  onCloseRight?: (tabId: string) => void
  onUndoClose?: () => void
  onLeaveStack?: (tabId: string) => void
  onGroupByDomain?: (tabId: string) => void
  canGroupByDomain?: (tabId: string) => boolean
  onArchive?: (tabId: string) => void
  onSplitWith?: (tabId: string, nextItem: TabMenuTab | null) => void
  onToggleSplitLayout?: (splitId: string) => void
  onReverseSplit?: (splitId: string) => void
  onDissolveSplit?: (splitId: string) => void
  onCollapseSplit?: (splitId: string) => void
  onSplitRatio?: (splitId: string, preset: string) => void
  onRestoreSplit?: () => void
  canRestoreSplit?: () => Promise<boolean> | boolean
  onGlanceWith?: (tabId: string) => void
  onGlanceFront?: (glanceId: string, tabId: string) => void
  onDissolveGlance?: (glanceId: string) => void
  listContainerProfiles?: (tab: TabMenuTab) => Promise<ContainerProfile[]> | ContainerProfile[]
  onOpenInContainer?: (tab: TabMenuTab, profileId: string) => void
  getPwaMenuState?: (tabId: string) => Promise<PwaMenuState | null> | PwaMenuState | null
  onInstallPwa?: (tab: TabMenuTab) => void
  onOpenPwaApp?: (appId: string) => void
}

export interface TabContextMenuOptions {
  popMenu?: PopMenu | null
  handlers?: TabContextMenuHandlers
  labels?: TabMenuLabels
  include?: { undoClose?: boolean }
}

export type TabContextMenu = (
  x: number,
  y: number,
  tab?: TabMenuTab | null,
  nextItem?: TabMenuTab | null
) => Promise<string | null>
/**
 * 标签行右键菜单 —— **唯一实现**（横向标签条 / 纵向标签列 / 面板列表共用）。
 *
 * 为什么必须只有一份：这三处的菜单项本来一字不差（只有「与右侧 / 下方标签堆叠」的
 * 方向文案不同），各写一份的结局必然是「加了一项、另外两处忘了加」—— 这正是标签功能
 * 反复漂移的老路。于是**模板、可见性判据、动作分发表**全部收在这里。
 *
 * 宿主只负责两件事，都是注入的纯函数：
 *   · `popMenu({ x, y, items, context })` → 弹出原生菜单并返回被点中的 action；
 *   · `handlers` → 每个 action 落到哪个业务调用（本模块不认识任何 IPC / 客户端）。
 *
 * 动作名是**本模块的内部契约**（`stackWithNext` 等），不要求宿主认识；
 * 本模块没有 handler 的 action 会原样返回，调用方可自行接手。
 */

/** 「与相邻项堆叠」的两个方向文案（横向列表 = 右侧；纵向列表 = 下方）。 */
const LABELS_RIGHT = Object.freeze({ stack: '并入右侧标签组', tab: '与右侧标签堆叠', split: '与右侧标签分屏' })
const LABELS_BELOW = Object.freeze({ stack: '并入下方标签组', tab: '与下方标签堆叠', split: '与下方标签分屏' })
/** 文案预设：宿主按自己的列表方向挑一个（也可以自己传一份同形状的对象）。 */
const TAB_MENU_LABELS: Readonly<{ right: TabMenuLabels; below: TabMenuLabels }> = Object.freeze({
  right: LABELS_RIGHT,
  below: LABELS_BELOW
})

/**
 * 造一个「标签行右键菜单」函数。
 *
 * @param {{
 *   popMenu: (payload: { x: number, y: number, items: Array<object>, context: object }) => Promise<string|null>,
 *   handlers?: {
 *     onBack?: (tabId: string) => void, onForward?: (tabId: string) => void, onReload?: (tabId: string) => void,
 *     onDuplicate?: (tabId: string) => void,
 *     onStackWith?: (tabId: string, nextItem: object|null) => void, onNewTab?: () => void,
 *     onTogglePin?: (tabId: string) => void, onToggleMute?: (tabId: string) => void,
 *     onPinToNewGroup?: (tabId: string) => void,
 *     listPinnedFolders?: () => Promise<Array<{stackId:string,label?:string,count?:number}>>|Array<{stackId:string,label?:string,count?:number}>,
 *     onPinToFolder?: (tabId: string, stackId: string) => void,
 *     onAutoRefresh?: (tabId: string, ms: number) => void,
 *     onSharePage?: (tab: object) => void, listCollectionEntries?: () => Array<object>, onCollectionAction?: (tab: object, action: string) => void,
 *     onCloseTab?: (tabId: string) => void, onCloseOthers?: (tabId: string) => void,
 *     onCloseRight?: (tabId: string) => void, onUndoClose?: () => void,
 *     onLeaveStack?: (tabId: string) => void,
 *     onGroupByDomain?: (tabId: string) => void,
 *     canGroupByDomain?: (tabId: string) => boolean,
 *     onArchive?: (tabId: string) => void,
 *     onSplitWith?: (tabId: string, nextItem: object|null) => void,
 *     onToggleSplitLayout?: (splitId: string) => void, onReverseSplit?: (splitId: string) => void,
 *     onDissolveSplit?: (splitId: string) => void, onCollapseSplit?: (splitId: string) => void,
 *     onSplitRatio?: (splitId: string, preset: string) => void,
 *     onRestoreSplit?: () => void,
 *     canRestoreSplit?: () => Promise<boolean>|boolean,
 *     onGlanceWith?: (tabId: string) => void,
 *     onGlanceFront?: (glanceId: string, tabId: string) => void,
 *     onDissolveGlance?: (glanceId: string) => void,
 *     listContainerProfiles?: (tabId: string) => Array<{id:string,name?:string}>,
 *     onOpenInContainer?: (tab: object, profileId: string) => void,
 *     getPwaMenuState?: (tabId: string) => Promise<{ state?: string, appId?: string|null }|null>|{ state?: string, appId?: string|null }|null,
 *     onInstallPwa?: (tab: object) => void,
 *     onOpenPwaApp?: (appId: string) => void
 *   },
 *   labels?: { stack: string, tab: string, split?: string },
 *   include?: { undoClose?: boolean }
 * }} opts
 *   `include.undoClose`：不是每个宿主都需要「恢复关闭的标签页」（如面板列表）——
 *   不开时**连菜单项都不出现**，不会留一个点了没反应的项。
 * @returns {(x: number, y: number, tab: object, nextItem: object|null) => Promise<string|null>}
 *   `nextItem` = 列表里**紧邻的下一个行项**（横向是右边那个、纵向是下一行）：
 *   决定「与相邻标签堆叠」这一项是否出现、以及文案用「标签组」还是「标签」。
 */
export function createTabContextMenu({
  popMenu,
  handlers = {},
  labels = LABELS_RIGHT,
  include = {}
}: TabContextMenuOptions = {}): TabContextMenu {
  const H = handlers || {}
  const run = (operation: () => unknown): void => {
    try {
      Promise.resolve(operation()).catch((error) => {
        console.warn('[tab-menu] action failed:', error)
      })
    } catch (error) {
      console.warn('[tab-menu] action failed:', error)
    }
  }

  return async function showTabContextMenu(x, y, tab, nextItem) {
    if (typeof popMenu !== 'function') return null
    const t = tab || {}
    const tabId = t.tabId != null ? String(t.tabId) : ''
    let navigation: NavigationMenuState = {
      canGoBack: typeof t.canGoBack === 'boolean' ? t.canGoBack : true,
      canGoForward: typeof t.canGoForward === 'boolean' ? t.canGoForward : true
    }
    if (tabId && typeof H.getNavigationState === 'function') {
      try {
        navigation = await H.getNavigationState(tabId) || {
          canGoBack: false,
          canGoForward: false
        }
      } catch {
        navigation = { canGoBack: false, canGoForward: false }
      }
    }
    const nextIsStack = !!(nextItem && nextItem.type === 'stack')
    const nextStackId = nextItem && nextItem.stackId != null ? String(nextItem.stackId) : null
    // 已在同一组内时「并入」无意义（拖拽那边也是这个判据，保持一致）
    const sameGroup = !!(nextItem && t.stackId != null && nextStackId === String(t.stackId))
    /**
     * 「并入/堆叠」对**分屏成员照常出现**。
     *
     * 分屏 × 标签栈已改为正交共存（2026-10-17 起，见 infra-window#tabLayout 的
     * enforceSplitRuns 说明）：同一张标签可以既在栈里又参与分屏，点这一项
     * 真的进得去、也不会被谁悄悄摘出来 —— 不再是"点了没反应"的项。
     */
    const canStackNext = !!nextItem && !sameGroup && canStackTogether(t, nextItem)

    /**
     * 「按域名分组标签」是否出现：**由宿主回答**。
     *
     * 菜单模板不认识"当前列表"（它只拿到被点的这一类快照），而"同域名是否 ≥2 条"
     * 只能由持有列表的宿主判断。宿主不提供判据 → 连项都不出现（不留"点了没反应"的项）。
     * 这与 `canRestoreSplit` 同款：能力由宿主声明，模板只负责渲染。
     */
    const canGroupByDomain = canGroupTabsByDomain(t) &&
      (typeof H.canGroupByDomain === 'function' ? !!H.canGroupByDomain(String(t.tabId || '')) : false)

    /**
     * PWA（安装为应用）——「这一页能不能装 / 是不是已经装过」是**宿主的知识**
     * （apps 层查 pwa:state），模板只按宿主给的结论渲染，自己不认识任何 IPC。
     * 宿主不接这段（没有 `getPwaMenuState`）→ 整段不出现（S4：不留点了没反应的项）。
     * 与 `canRestoreSplit` 同款：判据允许异步，菜单弹出前只多一次本地态查询。
     * 无痕标签不出现 —— 主进程的安装管线本就拒绝隐身标签。
     */
    let pwaMenu: PwaMenuState | null = null
    const pwaEligible = isHttpUrl(t.url) && !t.incognito &&
      typeof H.getPwaMenuState === 'function' && typeof H.onInstallPwa === 'function'
    if (pwaEligible) {
      try { pwaMenu = await H.getPwaMenuState!(String(t.tabId || '')) } catch { pwaMenu = null }
    }
    const pwaInstalled = !!(pwaMenu && pwaMenu.state === 'installed' && pwaMenu.appId)

    /**
     * 「固定标签组 ▸」的子菜单 —— 与「添加到集锦 ▸」同一套交互范式：
     * 已存在的标签组平铺 + 末尾「新建固定标签组…」。
     *
     * 宿主只提供**数据**（`listPinnedFolders`）与**落点**（`onPinToFolder` /
     * `onPinToNewGroup`）；标签组长什么样、怎么建、怎么命名，本模块一概不认识。
     * 已经在某个固定标签组里的标签，把当前组从候选里剔掉 —— 否则那一项点了没反应。
     */
    const currentFolderId = t.stackId != null && t.pinned ? String(t.stackId) : null
    let pinnedFolders: PinnedFolderMenuItem[] = []
    const canPinToFolder = typeof H.onPinToFolder === 'function' && typeof H.listPinnedFolders === 'function'
    if (canPinToFolder) {
      try { pinnedFolders = (await H.listPinnedFolders!()) || [] } catch { pinnedFolders = [] }
    }
    if (!Array.isArray(pinnedFolders)) pinnedFolders = []
    const pinnedFolderItems: MenuItem[] = []
    for (const folder of pinnedFolders) {
      if (!folder || folder.stackId == null) continue
      const stackId = String(folder.stackId)
      if (stackId === currentFolderId) continue
      pinnedFolderItems.push({ label: pinnedFolderMenuLabel(folder), action: `pinnedFolder:${stackId}` })
    }
    // 「新建固定标签组…」是子菜单的**最后一项**，语义 = 建一个新固定标签组并把这个标签放进去。
    // 没有它，一个固定标签组都没有的新用户会看到空子菜单 —— 那等于没有入口。
    if (typeof H.onPinToNewGroup === 'function') {
      if (pinnedFolderItems.length > 0) pinnedFolderItems.push({ type: 'separator' })
      pinnedFolderItems.push({ label: `${NEW_PINNED_STACK_LABEL}…`, action: 'pinToNewGroup' })
    }

    let collectionItems: Array<{ label?: string; action?: string; type?: string }> = []
    if (isHttpUrl(t.url) && typeof H.listCollectionEntries === 'function') {
      try { collectionItems = await H.listCollectionEntries() || [] } catch { collectionItems = [] }
    }

    /**
     * 菜单的**三桶分组**（本模块唯一一份分类真源）。
     *
     * 为什么必须分组：这张菜单已经长到二十多项，平铺时用户得逐行读完才知道哪项是
     * 「改这条标签」、哪项是「把它留下来接着用」。而整个应用的 IA 本来就是三桶 ——
     *   标签（临时的） / 继续工作（跨会话存在的） / 收藏（收进库里的）；
     * 菜单沿用同一套心智模型，用户在标签条、面板、右键里看到的是同一套分类。
     *
     * 实现约束：**渲染顺序 = 本数组顺序**；空桶不出现（项全被 visible 判据隐掉时连分隔符
     * 一起折叠）。新增菜单项只需 `put('<桶>', …)`，不再手工数分隔符 —— 那正是以前
     * "加一项就错位一次"的来源。
     */
    const GROUP_ORDER = ['tab', 'work', 'collect'] as const
    const buckets: Record<(typeof GROUP_ORDER)[number], MenuItem[]> = { tab: [], work: [], collect: [] }
    /** 往某个桶里追加项（`null` / `false` 跳过，便于按条件塞一项）。 */
    const put = (group: (typeof GROUP_ORDER)[number], ...entries: Array<MenuItem | null | false | undefined>) => {
      for (const entry of entries) if (entry) buckets[group].push(entry)
    }

    // ── 桶一：标签 —— 对"这一条标签"本身的即时操作（不改变它是否被留存）──────────
    // 「复制标签」：固定标签不出现 —— 复制出来的必然是**普通**标签（不属于任何固定
    // 标签组），既不是原件的同类，也不是用户「固定住这一页」时想要的结果。
    put('tab',
      { label: '后退', action: 'back', enabled: navigation.canGoBack !== false && typeof H.onBack === 'function' },
      { label: '前进', action: 'forward', enabled: navigation.canGoForward !== false && typeof H.onForward === 'function' },
      { label: '刷新', action: 'reload' },
      { label: '复制标签', action: 'duplicate', visible: canDuplicate(t) },
      // 与「修饰键 + 拖到另一个标签上」完全等价的一条入口 —— 拖拽不是人人都会用，
      // 而且拖拽没法在标签很少时精确落在目标上。
      { label: nextIsStack ? labels.stack : labels.tab, action: 'stackWithNext', visible: canStackNext },
      // 「移出标签组」：**单个标签**脱离它所在的组（组还在，其余成员照旧）。
      // 与芯片菜单的「解散标签组」是两件事：那是整组都没了，这是这一个走人。
      // 固定标签「出栈」= 取消固定，只能走「取消固定标签」，不走这条普通出栈通道。
      { label: '移出标签组', action: 'leaveStack', visible: t.stackId != null && canLeaveStack(t) },
      // 「按域名分组」：把同一站点的全部标签收进一个新组（复用既有 stack-create）。
      // 只在宿主确认"该域名 ≥2 条"时出现。
      { label: '按域名分组标签', action: 'groupByDomain', visible: canGroupByDomain },
      { label: '新标签页', action: 'newTab' },
      { label: audioToggleLabel(!!t.muted), action: 'toggleMute', visible: !!(t.muted || t.isPlaying) },
      // 关闭组固定压在桶尾 —— 常用但不可逆，离上面的即时操作留一步距离。
      { type: 'separator' },
      { label: '关闭标签', action: 'closeTab' },
      // 「关闭其他 / 右侧」对**固定标签不出现**：它常驻标签条最前，"右侧"就是全部普通
      // 标签 —— 从这个位置提供"一键清空整个空间"不是它该有的入口（能力表见 tab-policy
      // 的 closeWithOthers，主进程 TabRules 也照同一位置过滤被带走的人）。
      { label: '关闭其他标签', action: 'closeOthers', visible: canCloseWithOthers(t) },
      { label: '关闭右侧标签', action: 'closeRight', visible: canCloseWithOthers(t) }
    )
    // 「恢复关闭的标签页」是"标签"这一桶的兜底：它不是每个宿主都需要（面板列表不接）。
    if (include.undoClose) put('tab', { label: '恢复关闭的标签页', action: 'undoClose' })

    // ── 桶二：继续工作 —— 让这一页**跨过本次会话**继续存在 ──────────────────────
    // 固定标签组（Zen Essentials 的收藏夹语义）—— 与集锦同款两段式：
    //   · 「固定标签」= 一键落进默认标签组（沿用既有 togglePin，不新增通道）；
    //   · 「添加到 / 移动到固定标签组 ▸」= 显式挑目标，或就地新建一个。
    // 已固定时文案换成「移动到…」：固定标签必在某个标签组里，没有"再固定一次"这回事。
    put('work',
      { label: t.pinned ? '取消固定标签' : '固定标签', action: 'togglePin' },
      {
        label: `${t.pinned ? '移动到' : '添加到'}${stackKindLabel(true)}`,
        submenu: pinnedFolderItems,
        visible: pinnedFolderItems.length > 0
      },
      // 「归档标签」（J9）：关闭 + 记入归档区（可在历史面板的「已归档」段恢复）。
      // 是否可归档由种类能力裁决（固定标签 = 用户的常驻承诺，引擎侧也拒绝）。
      { label: '归档标签', action: 'archiveTab', visible: canArchive(t) },
      // 「定时刷新」（C7）：盯盘 / 抢票 / 看后台状态。档位收进一个子菜单 ——
      // 四项不再平铺占位；"当前档位"仍从**哪一项不出现**一眼可辨。
      // 没有 URL 的标签（新标签页）整项不出现 —— 刷新一个空白页没有意义。
      {
        label: '定时刷新',
        visible: !!t.url,
        submenu: [
          { label: '关闭', action: 'autoRefreshOff', visible: (t.autoRefreshMs || 0) > 0 },
          { label: '每 1 分钟', action: 'autoRefresh1m', visible: t.autoRefreshMs !== 60000 },
          { label: '每 5 分钟', action: 'autoRefresh5m', visible: t.autoRefreshMs !== 300000 },
          { label: '每 30 分钟', action: 'autoRefresh30m', visible: t.autoRefreshMs !== 1800000 }
        ]
      },
      // 「安装为应用…」：与 Edge 的「将此站点安装为应用」同一条入口。完整 PWA（有
      // manifest）与站点应用（无 manifest，开独立窗口）在这里**不区分** —— 主进程的
      // 候选会把两种形态归一，用户看到的都是"装成一个应用"（= 让它常驻，属本桶语义）。
      // 已装过 → 换成「在应用中打开」，不再让他重复走一遍安装确认。
      { label: '安装为应用…', action: 'installPwa', visible: !!pwaMenu && !pwaInstalled },
      { label: '在应用中打开', action: 'openPwaApp', visible: pwaInstalled && typeof H.onOpenPwaApp === 'function' }
    )

    // ── 桶三：收藏 —— 把这一页存进收藏库 / 带出去 ──────────────────────────────
    put('collect',
      {
        label: '收集此页',
        submenu: collectionItems,
        visible: isHttpUrl(t.url) && collectionItems.length > 0
      },
      // 「分享 / 生成二维码」（N15）：把这一页丢给分享页（`hira://share`）画成二维码，
      // 手机扫一下就在手机上打开。没有 URL 的标签不出现（没有可分享的地址）。
      { label: '分享 / 生成二维码', action: 'sharePage', visible: !!t.url }
    )

    // ── 分屏（Split View）────────────────────────────────────────────────
    // 与标签栈一样是"对相邻项"的操作：拖拽是更快的入口，菜单是不可发现性兜底。
    // 「分屏」只在**还不是分屏**且相邻项是个普通标签时出现；已在分屏里则换成
    // 「比例 / 方向 / 反转 / 收拢 / 解散」—— 菜单永远反映"此刻能做什么"。
    // 固定标签是常驻单体（永远排在标签条最前），与"分屏成员必须相邻"互斥 ——
    // 它自己不能入分屏，也不能作为相邻项被拉进去。
    const canSplitNext = !!nextItem && nextItem.type !== 'stack' && !!nextItem.tabId &&
      !t.splitId && canSplit(t) && canSplit(nextItem)
    const inSplit = !!t.splitId
    // 「有没有可复原的分屏」由宿主探一次（**精确**判定而不是"栈非空"）——
    // 只在"不在分屏里"时需要问：在分屏里菜单给的是解散/比例那几项。
    let canRestoreSplit = false
    if (!inSplit && typeof H.canRestoreSplit === 'function') {
      try { canRestoreSplit = !!(await H.canRestoreSplit!()) } catch { canRestoreSplit = false }
    }
    if (canSplitNext || inSplit || canRestoreSplit) {
      put('work', { type: 'separator' })
      if (canSplitNext) put('work', { label: labels.split || '与相邻标签分屏', action: 'splitWithNext' })
      if (inSplit) {
        put('work',
          { label: '切换分屏方向（左右 / 上下）', action: 'toggleSplitLayout' },
          { label: '反转分屏格序', action: 'reverseSplit' },
          // 比例预设：换算在主进程（格数是变量），这里只报预设名与中文名。
          ...SPLIT_RATIO_PRESET_OPTIONS.map(([preset, label]) => ({
            label: `分屏比例：${label}`,
            action: `splitRatio:${preset}`
          })),
          // 「收拢为标签组」：分屏 → 标签栈（I4 的可逆投影之一）。
          // 与"解散分屏"的区别：解散只是各回各的，收拢是**把它们收进一个栈**。
          { label: '收拢为标签组', action: 'collapseSplit' },
          { label: '解散分屏', action: 'dissolveSplit' }
        )
      }
      if (canRestoreSplit) put('work', { label: '复原上次解散的分屏', action: 'restoreSplit' })
    }

    // ── 速览（Glance，A1）────────────────────────────────────────────────
    // 第三条正交维度：叠放两张卡（front 压 back）。与分屏互斥（分屏胜），故分屏成员不出现。
    // 入口语义 = "把这一条与**当前活动标签**叠起来"（另一个成员由主进程解析，与分屏同款）。
    const inGlance = !!t.glanceId
    // 活动标签自己不能"与自己叠" —— 少了这条会得到一个点了没反应的项。
    const canGlanceWith = canGlance(t) && !inGlance && !t.splitId && !t.active && !!t.tabId
    if (canGlanceWith || inGlance) {
      put('work', { type: 'separator' })
      if (canGlanceWith) put('work', { label: '速览（与当前标签叠放）', action: 'glanceWithActive' })
      if (inGlance) {
        put('work',
          { label: '置于速览前台', action: 'glanceFront' },
          { label: '退出速览', action: 'dissolveGlance' }
        )
      }
    }

    let action: string | null = null
    // ── 容器标签（N10）──────────────────────────────────────────────────
    // 「用另一个 profile 的身份打开这一页」：cookie / 存储走那个 profile 的 Session，
    // 但**不切空间** —— 标签照常留在当前空间，只是"身份"是别人（多账户同时在线）。
    // 一条身份一项、平铺（身份通常一两个，比子菜单少一次悬停）—— profile 通常一两个，够用。
    // 没有"别的 profile"时**整段不出现**（S4：不留点了没反应的项）。
    let containerProfiles: ContainerProfile[] = []
    if (typeof H.listContainerProfiles === 'function') {
      // 允许异步（宿主可能要向主进程要 profile 目录）—— 与上面的 canRestoreSplit 同款。
      try { containerProfiles = (await H.listContainerProfiles!(t)) || [] } catch { containerProfiles = [] }
    }
    if (!Array.isArray(containerProfiles)) containerProfiles = []
    if (t.url && containerProfiles.length > 0) {
      put('work', { type: 'separator' })
      for (const p of containerProfiles) {
        if (!p || !p.id) continue
        put('work', { label: `以「${p.name || p.id}」的身份打开`, action: `container:${p.id}` })
      }
    }

    /**
     * 三桶 → 平铺模板：桶间一个分隔符，空桶整段不出现。
     * 桶内允许自带分隔符（例如"关闭"前的留白）—— 连续/首尾分隔符由消费端
     * `normalizeMenuItems` 统一折叠，模块本身不重复实现那一遍裁剪。
     * @type {Array<object>}
     */
    const items: MenuItem[] = []
    for (const group of GROUP_ORDER) {
      const list = buckets[group]
      if (list.length === 0) continue
      if (items.length > 0) items.push({ type: 'separator' })
      items.push(...list)
    }

    try {
      action = await popMenu({
        x,
        y,
        items,
        /**
         * 「这是哪一类菜单」+ 纯数据快照 —— 主进程据此把官方插槽
         * `tabbar.context-menu-item` 贡献的菜单项追加进来。
         *
         * 只传种类与**可序列化的窄快照**，不传插槽 id：种类→插槽的映射在主进程白名单里，
         * 否则渲染层能借这条通道触发任意插槽。
         */
        context: {
          kind: 'tab',
          snapshot: {
            tabId: t.tabId,
            url: t.url || '',
            title: t.title || '',
            pinned: !!t.pinned,
            muted: !!t.muted,
            active: !!t.active
          }
        }
      })
    } catch {
      action = null
    }

    switch (action) {
      case 'back': if (tabId && H.onBack) run(() => H.onBack!(tabId)); break
      case 'forward': if (tabId && H.onForward) run(() => H.onForward!(tabId)); break
      case 'reload': if (tabId && H.onReload) run(() => H.onReload!(tabId)); break
      case 'duplicate': if (tabId && H.onDuplicate) run(() => H.onDuplicate!(tabId)); break
      case 'stackWithNext': if (tabId && H.onStackWith) run(() => H.onStackWith!(tabId, nextItem ?? null)); break
      case 'leaveStack': if (tabId && H.onLeaveStack) run(() => H.onLeaveStack!(tabId)); break
      case 'groupByDomain': if (tabId && H.onGroupByDomain) run(() => H.onGroupByDomain!(tabId)); break
      case 'archiveTab': if (tabId && H.onArchive) run(() => H.onArchive!(tabId)); break
      // 「分享 / 二维码」（N15）：同样交整条快照（宿主据此拼分享页地址）。
      case 'sharePage': if (H.onSharePage) run(() => H.onSharePage!(t)); break
      // 「安装为应用…」：整条快照交给宿主（tabId / url 都在里面），它复用地址栏按钮
      // 同一条 prepare → 确认窗流程（apps 层 shared/pwa-actions 是唯一实现）。
      case 'installPwa': if (H.onInstallPwa) run(() => H.onInstallPwa!(t)); break
      // 「在应用中打开」：appId 来自上面的探测结论，宿主只负责唤起。
      case 'openPwaApp':
        if (pwaInstalled && H.onOpenPwaApp) run(() => H.onOpenPwaApp!(String(pwaMenu?.appId || '')))
        break
      case 'newTab': if (H.onNewTab) run(() => H.onNewTab!()); break
      case 'togglePin': if (tabId && H.onTogglePin) run(() => H.onTogglePin!(tabId)); break
      case 'pinToNewGroup': if (tabId && H.onPinToNewGroup) run(() => H.onPinToNewGroup!(tabId)); break
      case 'toggleMute': if (tabId && H.onToggleMute) run(() => H.onToggleMute!(tabId)); break
      // 定时刷新（C7）：档位 → 毫秒；0 = 关闭。
      case 'autoRefreshOff': if (tabId && H.onAutoRefresh) run(() => H.onAutoRefresh!(tabId, 0)); break
      case 'autoRefresh1m': if (tabId && H.onAutoRefresh) run(() => H.onAutoRefresh!(tabId, 60000)); break
      case 'autoRefresh5m': if (tabId && H.onAutoRefresh) run(() => H.onAutoRefresh!(tabId, 300000)); break
      case 'autoRefresh30m': if (tabId && H.onAutoRefresh) run(() => H.onAutoRefresh!(tabId, 1800000)); break
      case 'closeTab': if (tabId && H.onCloseTab) run(() => H.onCloseTab!(tabId)); break
      case 'closeOthers': if (tabId && H.onCloseOthers) run(() => H.onCloseOthers!(tabId)); break
      case 'closeRight': if (tabId && H.onCloseRight) run(() => H.onCloseRight!(tabId)); break
      case 'undoClose': if (H.onUndoClose) run(() => H.onUndoClose!()); break
      // ── 分屏 ──
      case 'splitWithNext': if (tabId && H.onSplitWith) run(() => H.onSplitWith!(tabId, nextItem ?? null)); break
      case 'toggleSplitLayout':
        if (H.onToggleSplitLayout && t.splitId) run(() => H.onToggleSplitLayout!(String(t.splitId)))
        break
      case 'reverseSplit':
        if (H.onReverseSplit && t.splitId) run(() => H.onReverseSplit!(String(t.splitId)))
        break
      case 'dissolveSplit':
        if (H.onDissolveSplit && t.splitId) run(() => H.onDissolveSplit!(String(t.splitId)))
        break
      case 'collapseSplit':
        if (H.onCollapseSplit && t.splitId) run(() => H.onCollapseSplit!(String(t.splitId)))
        break
      case 'restoreSplit':
        if (H.onRestoreSplit) run(() => H.onRestoreSplit!())
        break
      // ── 速览 ──
      case 'glanceWithActive': if (tabId && H.onGlanceWith) run(() => H.onGlanceWith!(tabId)); break
      case 'glanceFront':
        if (tabId && t.glanceId && H.onGlanceFront) run(() => H.onGlanceFront!(String(t.glanceId), tabId))
        break
      case 'dissolveGlance':
        if (t.glanceId && H.onDissolveGlance) run(() => H.onDissolveGlance!(String(t.glanceId)))
        break
      default:
        // 比例预设：动作名带参数（`splitRatio:main-70`），一条 case 收口，避免三项各写一遍。
        if (typeof action === 'string' && action.startsWith('splitRatio:') && t.splitId && H.onSplitRatio) {
          run(() => H.onSplitRatio!(String(t.splitId), action.slice('splitRatio:'.length)))
        } else if (typeof action === 'string' && action.startsWith('container:') && t.url && H.onOpenInContainer) {
          // 容器标签（N10）：`container:<profileId>` —— 与比例预设同款"带参数的动作名"。
          run(() => H.onOpenInContainer!(t, action.slice('container:'.length)))
        } else if (typeof action === 'string' && action.startsWith('pinnedFolder:') && tabId && H.onPinToFolder) {
          // 固定标签组子菜单：`pinnedFolder:<stackId>` —— 把这条标签放进用户挑中的标签组。
          // 「新建固定标签组…」走 pinToNewGroup（上面已收口），两条路径最终都是移动，不改固定态。
          run(() => H.onPinToFolder!(tabId, action.slice('pinnedFolder:'.length)))
        } else if (typeof action === 'string' && action.startsWith('collection:') && H.onCollectionAction) {
          run(() => H.onCollectionAction!(t, action))
        }
        break
    }
    // 返回动作：本模块没有 handler 的动作由调用方接手。
    return action
  }
}

export { TAB_MENU_LABELS }
