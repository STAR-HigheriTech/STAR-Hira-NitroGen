// 目录是按钮的唯一事实源（NAVBAR_NAV_IDS 从 CHROME_BUTTONS 派生）；
// `export * from './icons'` 只做再导出、不建立本地绑定 —— 必须显式 import。
import { CHROME_BUTTONS } from './icons'
// 图标两条真源（与 hira:// 内部页引用的是**同一份文件**，见 packages/shared-types/src/）：
//   · favicon-src.mjs  站点图标来源解析（favicon.ts 用）
//   · file-icon.mjs    下载项文件图标（本文件用；内部页 runtime.js 用同一份）
import { createFileIcon as createFileIconElement } from '@hira-ng/shared-types/src/file-icon.mjs'
// 面板样式的**唯一串行入口**（common + 原子层 + 基底，顺序固定）在 `panelKit.ts`：
// 面板宿主因此可以深路径引它，而不必把本文件这四十多条 `export *` 一起求值。
// 这里只做转发（下面的 `export * from './panelKit'`）。

export interface PanelOrderLayout {
  visible: string[]
  hidden: string[]
  drawer: string[]
}

export type PanelFirstRunInput =
  | readonly string[]
  | { visible?: readonly string[]; drawer?: readonly string[] }

export interface PanelOrderCatalogItem {
  id: string
  removable?: boolean
}

export interface FileIconOptions {
  filePath?: string | null
  loadIcon?: ((filePath: string, size: number) => Promise<string | null>) | null
}

const classnames = (...parts: unknown[]): string => parts.filter(Boolean).join(' ')

const cssVars = {
  radiusSm: 'var(--radius-sm, 6px)',
  radiusMd: 'var(--radius-md, 8px)',
  radiusLg: 'var(--radius-lg, 12px)',
  transitionFast: 'var(--transition-fast, 0.15s ease)',
  border: 'var(--ui-border, var(--hira-border-subtle))',
  hover: 'var(--ui-hover, var(--hira-hover-bg))'
}

/**
 * 面板宿主（panel webContents view）的**完整**样式由 `panelKit.ts` 的
 * `injectPanelStyles` 提供（顺序：通用件 → 原子层 → 面板基底），本文件经由
 * `export * from './panelKit'` 转发。只想要"第一帧不白不跳"的宿主仍应引
 * `@hira-ng/ui-common/src/panelShell` 并调 `injectPanelBaseStyles`。
 */

// 壳 / 通用件 / 拖拽让位的**唯一实现**（不是副本）：本入口只做转发，
// 于是面板薄引导与重桶永远看到同一份行为。
export * from './panelShell'

/**
 * 下载项文件图标 —— 扩展名→图标字符的**唯一真源**在
 * `packages/shared-types/src/file-icon.mjs`（内部页 / 面板 / 下载栏共用同一张表）。
 * 这里转发，不再自留一份副本：两份映射必然漂移，而漂移的表现是
 * 「同一个 .exe 在下载栏是真实图标、在面板是箭头、在下载页又是另一个字符」。
 */
export { fileTypeIcon as fileIconFor } from '@hira-ng/shared-types/src/file-icon.mjs'

/**
 * 下载项文件图标元素（面板行首前缀）。
 *
 * **真实文件图标优先，扩展名类型图标兜底**（与内部页 `fileIconBadge` 同一套实现）：
 * 面板与下载页看同一个下载项时，图标必须长得一模一样。取图能力由宿主以
 * `opts.loadIcon` 注入 —— ui 层不认识 IPC（CONTRACT-11）。
 *
 * @param {Document} doc
 * @param {string} [filename]
 * @param {number} [size=16]
 * @param {{ filePath?: string|null, loadIcon?: (filePath: string, size: number) => Promise<string|null> }} [opts]
 * @returns {HTMLSpanElement}
 */
export function createFileIcon(
  doc: Document,
  filename?: string,
  size: number = 16,
  opts: FileIconOptions = {}
): HTMLSpanElement {
  return createFileIconElement(doc, { filename, filePath: opts.filePath }, {
    size,
    // 不加类名 + 字号跟尺寸走：保持面板行首图标既有的 DOM 与像素（C02）
    className: '',
    fontSize: Math.round(size * 0.9),
    loadIcon: opts.loadIcon ?? undefined
  }) as HTMLSpanElement
}

/**
 * 统一的二次确认（实现见 `confirm.ts` —— 平台原语，与重桶无关的那一小块）。
 * @param {Document} doc
 * @param {{ title?: string, message?: string, danger?: boolean, confirmLabel?: string, cancelLabel?: string }} [options]
 * @returns {Promise<boolean>}
 */
export { confirm } from './confirm'

/**
 * 按「偏好顺序 + 隐藏集」算出可见按钮序列。
 * @param {unknown} preferred 偏好顺序（数组；可为空/无效）
 * @param {string[]} ids 目录 id（顺序即未指定时的默认顺序）
 * @param {Set<string>} hiddenSet
 * @returns {string[]}
 */
function orderedVisible(
  preferred: unknown,
  ids: readonly string[],
  hiddenSet: ReadonlySet<string>
): string[] {
  const known = new Set(ids)
  const out: string[] = []
  if (Array.isArray(preferred)) {
    for (const id of preferred) {
      if (typeof id === 'string' && known.has(id) && !hiddenSet.has(id) && !out.includes(id)) out.push(id)
    }
  }
  // 偏好里没提到的目录项补在末尾 —— 新加入目录的按钮默认**可见**，不会凭空消失。
  for (const id of ids) {
    if (!hiddenSet.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 各界面「第一次启动」的出厂布局。
 *
 * 只在设置**从未写入**时生效（`value` 为空）；用户一旦动过编辑界面，
 * 设置里就有 `{ order, hidden, drawer }`，这里的默认值即彻底退场 —— 不做任何迁移 / 合并，
 * 避免"用户删掉的按钮被默认值复活"。
 *
 * 形状与 resolvePanelOrder 的返回值同构：
 *   · visible 省略 = 目录里除 drawer 外全部可见
 *   · drawer  省略 = 没有抽屉项
 *
 * navbar 的默认值 = **导航区全部** + 面板区首屏：AI 助手 + 下载 / 收藏 / 历史。
 * 导航区（后退/前进/刷新/主页）是浏览器的骨架件，默认值若不带上它们，
 * 第一次启动会是一个"没法后退、没法刷新"的窗口 —— 那是把「首屏只放四颗面板按钮」
 * 误读成「首屏只留四颗按钮」。面板区的其余按钮默认收进按钮池，用户想用再拖出来。
 *
 * rail 的默认值 = 目录全常驻，**主题 / 会话出厂就收进抽屉**：
 * 这两项是低频调整项（偶尔换一次主题、恢复一次会话），不占常驻列的呼吸；
 * 用户随时能把它们拖回常驻（编辑界面里抽屉是独立投放区）。
 */
const NAVBAR_NAV_IDS = CHROME_BUTTONS.filter((b) => b.navbar && b.segment === 'nav').map((b) => b.id)
export const FIRST_RUN_LAYOUT = Object.freeze({
  navbar: Object.freeze({
    // AI 助手是出厂首屏的固定入口（面板区第一颗），其余三颗是浏览高频件。
    visible: Object.freeze([
      ...NAVBAR_NAV_IDS,
      'ai-panel',
      'downloads-panel',
      'favorites-panel',
      'history-panel'
    ])
  }),
  rail: Object.freeze({
    drawer: Object.freeze(['themes-panel', 'sessions-panel'])
  })
})

/**
 * 把「出厂布局」归一成 resolvePanelOrder 的返回形状。
 * 兼容历史形态：直接给数组 = 只列可见集（其余进按钮池）。
 *
 * @param {string[]|{visible?: string[], drawer?: string[]}|null|undefined} firstRun
 * @param {string[]} ids 该界面目录的 id 顺序
 * @returns {{visible:string[], hidden:string[], drawer:string[]}|null}
 */
function normalizeFirstRun(
  firstRun: PanelFirstRunInput | null | undefined,
  ids: readonly string[]
): PanelOrderLayout | null {
  const known = new Set(ids)
  const spec: { visible?: readonly string[]; drawer?: readonly string[] } | null | undefined =
    Array.isArray(firstRun)
      ? { visible: firstRun as readonly string[] }
      : firstRun as { visible?: readonly string[]; drawer?: readonly string[] } | null | undefined
  if (!spec || typeof spec !== 'object') return null

  const drawer = (Array.isArray(spec.drawer) ? spec.drawer : [])
    .filter((id): id is string => typeof id === 'string' && known.has(id))
  const drawerSet = new Set(drawer)

  if (Array.isArray(spec.visible)) {
    const visible = spec.visible.filter(
      (id): id is string => typeof id === 'string' && known.has(id) && !drawerSet.has(id)
    )
    const visibleSet = new Set(visible)
    return {
      visible,
      hidden: ids.filter((id) => !visibleSet.has(id) && !drawerSet.has(id)),
      drawer
    }
  }
  if (drawer.length === 0) return null
  return { visible: ids.filter((id) => !drawerSet.has(id)), hidden: [], drawer }
}

/**
 * 把按钮顺序 / 显隐 / 抽屉设置解析成 { visible, hidden, drawer }
 * （面板按钮与 navbar 工具按钮的单一口径）。
 *
 * 存储形态：`{ order: string[], hidden: string[], drawer?: string[] }`
 *   · order  —— 用户排过的顺序（可只含一部分；未提到的按目录顺序补在末尾）
 *   · hidden —— 被移除出界面的按钮（保留编辑浮层里的排列顺序）
 *   · drawer —— 仅 rail 用：收进抽屉的按钮（既不算常驻、也不算隐藏）
 * 「可见 = 目录 − hidden − drawer」且顺序按 order 优先 —— 于是**新增按钮默认可见**，
 * 不需要任何迁移逻辑。
 *
 * 兼容：历史值曾是「纯可见顺序数组」，这里只当排序提示、不当作隐藏清单
 * （否则升级后新加入目录的按钮会被判成隐藏，用户会看到按钮凭空消失）。
 *
 * @param {unknown} value 设置里的 app.navbar_buttons / app.rail_buttons
 * @param {Array<{id:string}>} catalog 该界面可编辑的目录（navbar/rail 各自过滤后，**必传**）
 * @param {string[]|{visible?: string[], drawer?: string[]}|null} [firstRun] 设置从未写入时的出厂布局（见 FIRST_RUN_LAYOUT）
 * @returns {{ visible: string[], hidden: string[], drawer: string[] }}
 */
export function resolvePanelOrder(
  value: unknown,
  catalog: readonly PanelOrderCatalogItem[] | null | undefined,
  firstRun: PanelFirstRunInput | null = null
): PanelOrderLayout {
  const items = Array.isArray(catalog) ? catalog : []
  const ids = items.map((p) => p.id)
  const known = new Set(ids)
  const required = new Set(items.filter((item) => item && item.removable === false).map((item) => item.id))
  const stabilizeRequired = (visible: string[], preferred?: unknown): string[] => {
    const explicitlyOrdered = new Set(Array.isArray(preferred) ? preferred : [])
    for (const id of required) {
      if (explicitlyOrdered.has(id)) continue
      const current = visible.indexOf(id)
      if (current >= 0) visible.splice(current, 1)
      const targetCatalogIndex = ids.indexOf(id)
      let insertAt = visible.length
      for (let index = 0; index < visible.length; index += 1) {
        if (ids.indexOf(visible[index]) > targetCatalogIndex) {
          insertAt = index
          break
        }
      }
      visible.splice(insertAt, 0, id)
    }
    return visible
  }
  if (Array.isArray(value)) {
    return { visible: stabilizeRequired(orderedVisible(value, ids, new Set()), value), hidden: [], drawer: [] }
  }
  if (!value || typeof value !== 'object') {
    const defaults = normalizeFirstRun(firstRun, ids)
    const preferred = Array.isArray(firstRun)
      ? firstRun as readonly string[]
      : (firstRun as { visible?: readonly string[] } | null | undefined)?.visible
    if (defaults) return { ...defaults, visible: stabilizeRequired(defaults.visible.slice(), preferred) }
    return { visible: ids.slice(), hidden: [], drawer: [] }
  }
  const stored = value as { hidden?: unknown; drawer?: unknown; order?: unknown }
  const hidden = (Array.isArray(stored.hidden) ? stored.hidden : [])
    .filter((id): id is string => typeof id === 'string' && known.has(id) && !required.has(id))
  const hiddenSet = new Set(hidden)
  // 抽屉项：目录内、未隐藏、且不与常驻重复（同 id 以 drawer 优先，避免两处同时出现）
  const drawer = (Array.isArray(stored.drawer) ? stored.drawer : []).filter(
    (id): id is string => typeof id === 'string' && known.has(id) && !hiddenSet.has(id) && !required.has(id)
  )
  const drawerSet = new Set(drawer)
  const visible = stabilizeRequired(
    orderedVisible(stored.order, ids, hiddenSet).filter((id) => !drawerSet.has(id)),
    stored.order
  )
  return { visible, hidden, drawer }
}

// 只列**本文件内的局部绑定**。`injectCommonStyles` 住在 panelShell.ts，
// 已由上面的 `export * from './panelShell'` 转发 —— 写进这里会变成
// 「导出一个不存在的本地变量」，rollup 在打包期直接报错（不是运行期软失败）。
export {
  classnames,
  cssVars
}
// 窗口控制件（通用容器 + 三颗按钮的簇）单独一个文件：它是**跨视图共用件**
// （导航栏 / 标签栏 / 标题栏 / 侧栏槽位 / 侧栏悬停浮出层都要画同一簇），
// 见 docs/vertical-tabs-architecture.md §5.3 的跨模式共用件台账。
export * from './windowControls'
// 面板原子层：injectPanelKitStyles 已由 injectPanelStyles 自动带上；
// 这里再导出一次，供**不经过面板基底**的宿主（如独立设置窗口）按需复用自己的控件语言。
export * from './panelKit'
export * from './bookmark-open'
export * from './panel-open'
// 「可固定到书签栏的节点」判据的真源在 shared-types#bookmarkbar.mjs（跨进程共享）——
// 这里转发一次，ui 包（收藏面板 / 书签栏）即无需各自声明 shared-types 依赖。
export { isPinnableToBookmarkbar } from '@hira-ng/shared-types/src/bookmarkbar.mjs'
// 跨视图拖放协议的**唯一入口**（shared-types#drag-item）：ui 包一律从这里拿，
// 不各自深路径 import —— 换 MIME / 换载荷时只改真源一处，所有落点自动跟随。
export {
  DRAG_ITEM_MIME, DRAG_ITEM_PREFIX, DRAG_DOMAINS, DRAG_KINDS,
  normalizeDragItem, isDragItem, setDragItem, getDragItem, hasDragItem, pickDropEffect, dragItemToLink
} from '@hira-ng/shared-types/src/drag-item.mjs'
// 文件夹图标（收藏面板树 / 书签栏文件夹项）—— **唯一一份**，见该文件头。
export * from './folderIcon'
export * from './icons'
export * from './favicon'
export * from './faviconColor'
export * from './domainGroup'
export * from './tabRowList'
export * from './tabListHost'
// 固定标签的**网格视图**（A4 / Pin Grid）—— 与纵向列表并列的第二种形态，面板按模式装配其一
export * from './pinGrid'
export * from './stripScroller'
// 中键自动滚动守卫：一条规则，两种挂载粒度（区域根 / 单个标签行）—— 见该文件头。
export * from './middleClickGuard'
export * from './hoverPreview'
export * from './tabPreviewFacts'
export * from './axisAdapter'
/**
 * 标签行的**最小件**（"一张标签脸"：图标区 / 标题区 / 关闭按钮 / 手势 / 取色）。
 *
 * 住在 ui-common 而不是 ui-tabbar：它们与轴无关（只造 DOM、只上抛无参意图），
 * 横向标签条与纵向标签列/两个面板**引用同一份** —— 于是"一个标签行内部长什么样"
 * 只有一处实现，改一处不会漏另一处（见 docs/vertical-tabs-architecture.md §3.3、§5.3）。
 */
export * from './tab/iconArea'
export * from './tab/titleArea'
export * from './tab/closeButton'
export * from './tab/gestures'
export * from './tab/faviconTint'
export * from './tab/chipArrow'
export * from './tab/chipMenu'
export * from './tab/renameSlot'
// 分屏「连接判据」的共用件：哪些项连成一段 / 哪两对相邻项连着同组伙伴（横向与纵向共用一份）。
export * from './tab/splitLink'
// 分屏「回形针」的共用件：外观只此一份，横向标签条与纵向列表共用
//（两端只各自负责"摆在哪"——横向落两条标签之间那条缝，纵向落合体容器的接缝正中）。
export * from './tab/splitClip'
// 标签组「成员标记」：哪些标签属于哪个可见组 / 谁是最后一个 / 组行后面是否续接成员 ——
// 横向（.in-tab-stack）与纵向（data-stack-*）**共用同一份判据**，宿主只留摆放。
export * from './tab/stackMarks'
// 共享帧泵：所有「装饰绘制层」共用的一条 rAF（一帧一次布局结算：先全员 measure、再全员 paint）。
// 新增绘制层 = register 一个 sink，不再新增循环 —— 见 tab/framePump.ts 的说明。
export * from './tab/framePump'
// 标签「权限请求」标记：图标键名 → SVG、显隐口径、点击不选中标签 —— 横向标签条与纵向列表共用。
export * from './tab/permissionMark'
export * from './dragRegion'
export * from './webSidebarHeader'
export * from './tabContextMenu'
// 书签项右键菜单：书签栏项与 rail 固定项**共用同一份**（只有"从哪取消固定"的文案不同）
export * from './bookmarkContextMenu'
// 「后退 / 前进」右键历史菜单：模板 + 动作解析**同一份**（宿主只注入 popMenu / getHistory / onPick）
export * from './navHistoryMenu'
// 固定扩展图标的右键菜单 + 交互可用性判据（图标条与菜单共用同一份三态判定）
export * from './extensionActionMenu'
export * from './tabStackActions'
// 固定文件夹（= pinned 标签栈）的领域原语：建空文件夹 / 放标签进新文件夹 / 移入已有文件夹 /
// 列出文件夹 —— 右键菜单（apps 层）与固定面板（ui 层）取**同一份**，见该文件头。
export * from './tab/pinnedFolders'
export * from './transitions'
export * from './flip'
// 浮层卡片：视觉词汇 + 「点空白处收起」判据 —— 空间菜单与书签夹浮层**共用同一份**，
// 见该文件头（避免两处各写一份必然漂移的样式 / 收起逻辑）。
export * from './overlayCard'
// 「列表项过多 → 省略 + 转到面板」：上限表 / 截断判据 / 省略行的**唯一一份**实现 ——
// 权限申请浮层、空间切换菜单、书签夹下拉共用同一份额度与文案，见该文件头。
export * from './listOverflow'
export type * from './menuTypes'
export type * from './panel-contract'
export type * from './tabRowTypes'
