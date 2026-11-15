/**
 * 原生应用菜单（对齐 RT app-menu-controller）。
 *
 * NG 此前**完全没有**应用菜单：`Menu.setApplicationMenu` 全库零调用，唯一的
 * 弹出菜单只有网页右键。于是 Windows 上按 Alt 什么也弹不出来，
 * 「文件 / 编辑 / 视图 / 标签页 / 空间 / 帮助」这些浏览器最基础的入口全都缺失。
 *
 * ── 两条关键设计约束 ──────────────────────────────────────────────
 * 1. **加速键不重复注册**：NG 的快捷键由主进程 `before-input-event` 统一拦截
 *    （见 keybindings.js）。若菜单项也用 accelerator 注册同一个组合键，
 *    就会出现「一次按键触发两遍」。因此凡是 NG 已拥有的快捷键，一律用
 *    `registerAccelerator: false` —— **只显示、不注册**，按键仍由 keybindings 处理。
 *    标准编辑操作（撤销/复制/粘贴…）走 role，由 Electron 原生处理，NG 未占用。
 *
 * 2. **纯装配、零业务**：本模块不认识 TabManager / spaceService，只接受注入的
 *    actions 与 state 读取器；菜单项该不该勾选、标签叫什么，全部由调用方回答。
 *    这样新增一个菜单项 = 加一行，不需要动主进程的装配代码。
 */

import { app, Menu, dialog, type MenuItemConstructorOptions } from 'electron'
import { BOOKMARKBAR_MODE_OPTIONS, normalizeBookmarkbarMode } from '@hira-ng/shared-types/src/bookmarkbar.mjs'
import { buildCollectionMenuEntries, toNativeMenuItems } from '@hira-ng/shared-types/src/collection-menu.mjs'
// 内部页的叫法 / 背后功能面的唯一真源（工具菜单里那一串页面入口不再手写中文名，
// 「这一项该不该出现」也不再另抄一张 action → 引擎表）。
import { pageLabel, pageFeature } from '@hira-ng/shared-types/src/pages.mjs'
// 编辑 role → 中文菜单名的唯一真源（与网页右键、地址栏右键共用一份）。
import { editMenuItem } from '@hira-ng/shared-types/src/edit-menu.mjs'

type MenuAction = (...args: unknown[]) => unknown

interface PluginMenuAdapter {
  signature?: string
  itemsFor(where: string, state: AppMenuState): AppMenuItem[]
  roots(state: AppMenuState): AppMenuItem[]
}

interface AppMenuState extends Record<string, unknown> {
  windows?: Array<{ id: unknown; focused?: boolean; ordinal?: unknown; tabCount?: unknown; isPrimary?: unknown; incognito?: unknown }>
  bookmarkbarMode?: unknown
  canCollectCurrentPage?: unknown
  collections?: unknown
  recentlyClosed?: Array<{ title?: unknown; url?: unknown }>
  canInstallCurrentPage?: unknown
  canGoBack?: unknown
  canGoForward?: unknown
  railPinned?: unknown
  features?: Record<string, boolean>
}

interface AppMenuDependencies {
  actions?: Record<string, MenuAction>
  getState?(): AppMenuState
  onQuit?(): void
  getAccelerator?(action: string): string
  getKeybindingSignature?(): string
  getPluginMenus?(): PluginMenuAdapter | null
}

interface AppMenuItem {
  label?: string
  type?: string
  role?: string
  accelerator?: string
  registerAccelerator?: boolean
  enabled?: boolean
  checked?: boolean
  submenu?: AppMenuItem[]
  click?: MenuAction
  feature?: string
  [key: string]: unknown
}

/**
 * @param {object} deps
 * @param {Record<string, () => void>} deps.actions  菜单动作表（键即动作名）
 * @param {() => object} deps.getState 读取当前状态（spaces / currentSpaceId / 勾选项）
 * @param {() => void} [deps.onQuit] 退出（走 QuitController，不直接 app.quit）
 * @param {(action: string) => string} [deps.getAccelerator]
 *   动作名 → 当前显示用的 Electron 组合键（`keybindings.mjs#menuAccelerator` +
 *   管理员当前键位的合并结果）。菜单**不接受**组合键字面量，见 `boundItem`。
 * @param {() => string} [deps.getKeybindingSignature]
 *   键位快照（用于 `install()` 的状态签名）。改键后签名变化 → 菜单重建，
 *   否则菜单里的组合键会停留在旧值（"显示"与"真实按键"对不上）。
 * @param {() => ({ signature?: string, itemsFor: Function, roots: Function } | null)} [deps.getPluginMenus]
 *   插件菜单适配器（plugin-surfaces.js#getPluginMenus）。菜单模块**不认识插件**，
 *   只按 where 索要已经编译好的 Electron 菜单项 —— 保持「纯装配、零业务」。
 */
export function createAppMenu(deps: AppMenuDependencies = {}) {
  const actions = deps.actions || {}
  const getState = typeof deps.getState === 'function' ? deps.getState : () => ({})
  const onQuit = typeof deps.onQuit === 'function' ? deps.onQuit : () => app.quit()
  const getAccelerator = typeof deps.getAccelerator === 'function' ? deps.getAccelerator : () => ''
  const getKeybindingSignature = typeof deps.getKeybindingSignature === 'function' ? deps.getKeybindingSignature : () => ''
  const getPluginMenus = typeof deps.getPluginMenus === 'function' ? deps.getPluginMenus : () => null

  /**
   * 顶级菜单 label → 插件 `where` 的固定映射。
   *
   * 为什么用 label 做键：菜单是硬编码的中文文案，`where` 是给插件作者的稳定词汇。
   * 两者必须一一对得上，否则插件写 `app.tools` 却挂不到「工具」下面。新增顶级菜单时
   * **必须在这里补一行**（与 `buildTemplate` 的顶级项一一对应）。
   */
  const WHERE_BY_TOP_LABEL: Readonly<Record<string, string>> = Object.freeze({
    文件: 'app.file',
    编辑: 'app.edit',
    视图: 'app.view',
    标签页: 'app.tabs',
    历史记录: 'app.history',
    书签: 'app.bookmarks',
    工具: 'app.tools',
    帮助: 'app.help'
  })

  /** 取动作；缺失时返回 undefined，让菜单项自然禁用而不是点了报错。 */
  const act = (name: string): MenuAction | undefined => {
    const handler = actions[name]
    if (typeof handler !== 'function') return undefined
    return (...args: unknown[]) => {
      try {
        Promise.resolve(handler(...args)).catch((error) => {
          console.error(`[app-menu] ${name} failed:`, error)
        })
      } catch (error) {
        console.error(`[app-menu] ${name} failed:`, error)
      }
    }
  }

  /**
   * 构造一个「NG 已占用快捷键」的菜单项：显示组合键但不注册，避免双触发。
   *
   * ⚠ accelerator **不接受字面量**。组合键的真源是
   * `keybindings.mjs#MENU_ACTION_KEYBINDINGS`（动作名 → 键位 id）加上用户当前键位，
   * 由 `getAccelerator` 注入。改造前这里手抄了 31 处 `CmdOrCtrl+…`：
   * 用户一改键菜单就开始撒谎，且「放大」写成 `CmdOrCtrl+Plus` 而真实键是 `Ctrl+=`。
   * 新增菜单项只需要一个动作名 —— 快捷键自动跟着键位表走。
   */
  function boundItem(label: string, actionName: string, featureId?: string): AppMenuItem {
    const accelerator = getAccelerator(actionName)
    const handler = act(actionName)
    const item: AppMenuItem = { label, registerAccelerator: false, enabled: !!handler, click: handler }
    // 空串会被 Electron 当成"非法 accelerator"警告，未绑定键位的项干脆不写这个字段。
    if (accelerator) item.accelerator = accelerator
    // `feature` 是本模块自己的标记（安装前会被摘掉，不进 Electron）：见 applyFeatureGate。
    const feature = featureId || ''
    if (feature) item.feature = feature
    return item
  }

  /** 「集锦」功能面 id —— 它不是内部页，只能在这里点名（页面型一律走 pageFeature）。 */
  const NOTES_FEATURE = 'notes'

  /**
   * 按功能面可用性过滤菜单树（§10.4 表达层）。
   *
   * 可用性来自 `getState().features`（主进程 `feature-map.js` 的唯一答案），
   * 本模块**不认识插件** —— 它只做"标了 feature 且该功能面不可用 ⇒ 不出现"。
   *
   * 三个必须一起做的收尾（否则菜单会出现奇怪的缝隙）：
   *   · 摘掉 `feature` 标记：那是本模块的内部字段，不能透给 Electron；
   *   · 折叠被删项两侧的分隔线（含开头 / 结尾的孤立线）；
   *   · 子菜单被清空 ⇒ 整个顶级菜单消失（例如书签引擎被关掉时的「书签」菜单）。
   *
   * 注意**不能原地改**：`editMenuItem()` / 常量表返回的对象可能被多个调用方共用，
   * 所以一律构造新对象。
   *
   * @param {Array<object>} items
   * @param {Record<string, boolean>} features
   * @returns {Array<object>}
   */
  function applyFeatureGate(items: readonly AppMenuItem[], features: Record<string, boolean>): AppMenuItem[] {
    const kept: AppMenuItem[] = []
    for (const item of items || []) {
      if (!item || typeof item !== 'object') continue
      if (item.feature && features[item.feature] === false) continue
      let next = item
      if ('feature' in item) {
        const { feature, ...rest } = item
        next = rest
      }
      if (Array.isArray(next.submenu)) {
        const submenu = applyFeatureGate(next.submenu, features)
        // 子菜单项全被藏掉 = 这一项什么都做不了，整项一起消失（不留一个空壳子菜单）。
        if (!submenu.length) continue
        next = { ...next, submenu }
      }
      if (next.type === 'separator' && (!kept.length || kept[kept.length - 1].type === 'separator')) continue
      kept.push(next)
    }
    while (kept.length && kept[kept.length - 1] && kept[kept.length - 1].type === 'separator') kept.pop()
    return kept
  }

  function buildTemplate(state: AppMenuState = getState() || {}): AppMenuItem[] {

    /**
     * 「移动到其他窗口」子菜单：列出**除当前窗口之外**的浏览器窗口。
     *
     * 为什么用序号而不是标题：窗口没有稳定的用户可见标题（当前标签的标题会一直变，
     * 用它当标识反而认不出是哪个窗口）。序号 + 标签数 + 是否有焦点，足以让用户定位。
     * 只有一个窗口时整项禁用 —— 显示出来但点不动，比凭空消失更容易理解。
     */
    function moveTabToWindowItem(state: AppMenuState): AppMenuItem {
      const all = Array.isArray(state.windows) ? state.windows : []
      const others = all.filter((w) => !w.focused)
      const move = act('tabMoveToWindow')
      const build = (w: NonNullable<AppMenuState['windows']>[number]): AppMenuItem => ({
        label: `窗口 ${w.ordinal}（${w.tabCount} 个标签）${w.isPrimary ? ' · 主窗口' : ''}${w.incognito ? ' · 无痕' : ''}`,
        click: move ? () => move(w.id) : undefined
      })
      return {
        label: '移动到其他窗口',
        enabled: others.length > 0,
        submenu: others.length > 0
          ? others.map(build)
          : [{ label: '（没有其它窗口）', enabled: false }]
      }
    }

    /**
     * 「显示书签栏」：三态 radio 子菜单（始终 / 仅新标签页 / 从不），对齐 Edge。
     *
     * 为什么不是原来的 checkbox：选项本身就是三档，而 checkbox 的勾选态无法表达
     * 「已启用、但当前这一页不显示」—— `newtab` 模式在普通网页上恰好是这个状态，
     * 于是会出现「勾着却看不见 / 没勾却看得见」的自相矛盾。radio 子菜单与设置页一一对应。
     * 取值与中文名都取自 shared-types 真源，不在这里手抄。
     */
    function bookmarkbarItem(state: AppMenuState): AppMenuItem {
      const mode = normalizeBookmarkbarMode(state.bookmarkbarMode)
      const setMode = act('setBookmarkbarMode')
      return {
        label: '显示书签栏',
        submenu: BOOKMARKBAR_MODE_OPTIONS.map((option: readonly string[]) => {
          const value = String(option[0] || '')
          const label = String(option[1] || value)
          return {
            label,
            type: 'radio',
            checked: mode === value,
            click: setMode ? () => setMode(value) : undefined
          }
        })
      }
    }

    function collectCurrentPageItem(state: AppMenuState): AppMenuItem {
      const onSelect = act('collectCurrentPage')
      return {
        label: '收集此页',
        enabled: !!onSelect && state.canCollectCurrentPage === true,
        feature: NOTES_FEATURE,
        submenu: toNativeMenuItems(
          buildCollectionMenuEntries(Array.isArray(state.collections) ? state.collections : []),
          (target: unknown) => { if (onSelect) onSelect(target) }
        )
      }
    }

    /**
     * 「最近关闭的标签页」子菜单：列出最近关闭的标签（最近关闭在前），
     * 点一条即按列表下标恢复（index 口径与 `tabs:recently-closed` 返回顺序一致）。
     * 列表与「恢复关闭的标签页 / Ctrl+Shift+T」共用同一份内存栈 —— 这里只是把
     * 栈的**全部**内容摆出来，让用户能跳过最近一条直接恢复更早的页面。
     * 数据来自 `getState().recentlyClosed`（本模块不认识 TabManager）。
     */
    function recentlyClosedItem(state: AppMenuState): AppMenuItem {
      const items = Array.isArray(state.recentlyClosed) ? state.recentlyClosed : []
      const restore = act('tabRestoreRecentlyClosed')
      const clear = act('tabClearRecentlyClosed')
      const entryLabel = (entry: { title?: unknown; url?: unknown }): string => {
        const title = String((entry && entry.title) || '').trim() || String((entry && entry.url) || '')
        if (!title) return '（无标题）'
        return title.length > 64 ? `${title.slice(0, 64)}…` : title
      }
      const submenu: AppMenuItem[] = items.map((entry, index) => ({
        label: entryLabel(entry),
        click: restore ? () => restore(index) : undefined
      }))
      if (items.length) {
        submenu.push({ type: 'separator' }, { label: '清空最近关闭列表', click: clear })
      } else {
        submenu.push({ label: '（暂无最近关闭的标签页）', enabled: false })
      }
      return { label: '最近关闭的标签页', enabled: items.length > 0, submenu }
    }

    const template: AppMenuItem[] = [
      {
        label: '文件',
        submenu: [
          boundItem('新建窗口', 'windowNew'),
          boundItem('新建无痕窗口', 'windowNewIncognito'),
          { type: 'separator' },
          boundItem('新建标签页', 'tabNew'),
          boundItem('新建无痕标签页', 'tabNewIncognito'),
          { type: 'separator' },
          boundItem('关闭标签页', 'tabClose'),
          { type: 'separator' },
          // 页面入口的叫法来自 pages.mjs：「打开书签 / 打开历史记录 / 打开下载」。
          // 第三个参数是页面背后的功能面 —— 引擎被关掉时整项消失（而不是点了报错）。
          boundItem(`打开${pageLabel('bookmarks')}`, 'openBookmarks', pageFeature('bookmarks')),
          boundItem(`打开${pageLabel('history')}`, 'openHistory', pageFeature('history')),
          boundItem(`打开${pageLabel('downloads')}`, 'openDownloads', pageFeature('downloads')),
          { type: 'separator' },
          // 保存 / 打印：按键已由 keybindings 接管（Ctrl+S / Ctrl+P），这里只显示。
          boundItem('保存网页…', 'pageSave'),
          boundItem('打印…', 'pagePrint'),
          { type: 'separator' },
          // 「安装本页为应用」：判据与动作实现同一处（main.js#installCurrentPage）——
          // 内部页 / 无痕页上整项置灰（S4：宁可不出现，也不要点了没反应）。
          // 完整 PWA 与「站点应用」都成立（见 pwa/detect.js 的 shortcut 态说明）。
          {
            label: '将本页安装为应用…',
            enabled: state.canInstallCurrentPage === true && !!act('installCurrentPage'),
            click: act('installCurrentPage'),
            // PWA 引擎被关掉 → `pwa.*` 真的会失败，入口应当消失（不是置灰）。
            feature: pageFeature('apps')
          },
          { type: 'separator' },
          // 退出是**唯一**保留字面量组合键的项：它不在 keybindings 里（快捷键表只登记
          // 浏览器动作，退出交给 Electron 注册），所以不存在「显示值 vs 真实按键」漂移。
          { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => onQuit() }
        ]
      },
      {
        // 标准编辑操作交给 Electron 原生 role：它们作用于当前聚焦的 webContents，
        // NG 的 keybindings 没有占用这些组合键，因此走 role 不会双触发。
        label: '编辑',
        submenu: [
          editMenuItem('undo'),
          editMenuItem('redo'),
          { type: 'separator' },
          editMenuItem('cut'),
          editMenuItem('copy'),
          editMenuItem('paste'),
          editMenuItem('selectAll')
        ]
      },
      {
        label: '视图',
        submenu: [
          boundItem('重新加载', 'tabReload'),
          // 强制重新加载也走 boundItem：Ctrl+Shift+R 已进入 DEFAULT_KEYBINDINGS，
          // 再让 Electron 注册一次加速键就会「一次按键刷两遍」。
          boundItem('强制重新加载', 'tabForceReload'),
          { type: 'separator' },
          // 查找 / 阅读模式 / 缩放：按键已由 keybindings 统一拦截，这里只显示。
          // 若让 Electron 再注册一次，一次 Ctrl+F / Ctrl+= 会触发两遍
          // （查找在"打开"与"关闭"之间来回跳，缩放一次走两档）。
          boundItem('在页面中查找', 'findInPage'),
          boundItem('阅读模式', 'readerMode'),
          { type: 'separator' },
          boundItem('放大', 'zoomIn'),
          boundItem('缩小', 'zoomOut'),
          boundItem('实际大小', 'zoomReset'),
          { type: 'separator' },
          {
            label: '固定侧边栏',
            type: 'checkbox',
            checked: state.railPinned !== false,
            click: act('toggleRail')
          },
          bookmarkbarItem(state),
          { type: 'separator' },
          boundItem('切换全屏', 'toggleFullscreen'),
          // 开发者工具此前用裸 `accelerator` —— Ctrl+Shift+I 同时被 keybindings 接管，
          // 点一次菜单之外按一次键会开/关两遍。改走 boundItem 后只显示不注册。
          boundItem('切换开发者工具', 'toggleDevTools')
        ]
      },
      {
        label: '标签页',
        submenu: [
          // 标签页搜索（Ctrl+Shift+A，对齐 Chrome / Edge）：打开已开标签面板并聚焦搜索。
          boundItem('搜索标签页…', 'tabSearch'),
          { type: 'separator' },
          boundItem('下一个标签页', 'tabNext'),
          boundItem('上一个标签页', 'tabPrev'),
          { type: 'separator' },
          boundItem('固定标签 / 取消固定标签', 'tabTogglePin'),
          boundItem('静音 / 取消静音', 'tabToggleMute'),
          boundItem('休眠当前标签页', 'tabSleep'),
          { type: 'separator' },
          boundItem('移动标签页到新窗口', 'tabMoveToNewWindow'),
          moveTabToWindowItem(state),
          { type: 'separator' },
          boundItem('恢复关闭的标签页', 'tabUndoClose'),
          recentlyClosedItem(state),
          boundItem('关闭其他标签页', 'tabCloseOthers')
        ]
      },
      {
        label: '历史记录',
        submenu: [
          { ...boundItem('后退', 'navBack'), enabled: state.canGoBack === true && !!act('navBack') },
          { ...boundItem('前进', 'navForward'), enabled: state.canGoForward === true && !!act('navForward') },
          { type: 'separator' },
          boundItem(`打开${pageLabel('history')}`, 'openHistory', pageFeature('history'))
        ]
      },
      {
        label: '书签',
        submenu: [
          boundItem('收藏 / 编辑当前页面', 'bookmarkToggle', pageFeature('bookmarks')),
          boundItem(`打开${pageLabel('bookmarks')}`, 'openBookmarks', pageFeature('bookmarks'))
        ]
      },
      {
        // 「工具」：把所有**面向用户的窗口 / 内部页**集中成一处入口。
        // 此前这些能力只存在于内部页与 navbar 菜单里，应用菜单栏够不着 ——
        // 新增窗口类型时也必须在这里补一条，否则就是「做了但没人能找到」。
        label: '工具',
        submenu: [
          boundItem('归档此页到本地', 'archiveCurrent'),
          // 集锦（经典 Edge Collections）：与三点菜单 → 更多工具 → 集锦同一落点。
          // 「集锦」= 打开/收起集锦面板（Ctrl+Shift+Y 同一条 API，见 main.js 的动作实现）；
          // 集锦 / 收进集锦都属于 notes 功能面（引擎 notes-service + 面板 panel-notes）。
          boundItem('集锦', 'openCollections', NOTES_FEATURE),
          collectCurrentPageItem(state),
          { type: 'separator' },
          // 以下页面入口的叫法一律取自 pages.mjs —— 与公共侧栏、⋮ 菜单、设置页同词；
          // 它们背后的引擎同样从这张表取（引擎被关掉 → 入口消失）。
          boundItem(pageLabel('extensions'), 'openExtensions', pageFeature('extensions')),
          // 已安装应用（PWA 管理页）：与内部页一一对应，走 hira://apps。
          boundItem(pageLabel('apps'), 'openApps', pageFeature('apps')),
          boundItem(pageLabel('passwords'), 'openPasswords', pageFeature('passwords')),
          // 生成密码浮层：与页面内右键「生成密码」同一实现（password:generate 路由）。
          boundItem('生成密码', 'generatePassword', pageFeature('passwords')),
          boundItem(pageLabel('permissions'), 'openPermissions', pageFeature('permissions')),
          boundItem(`${pageLabel('cookies')} 管理`, 'openCookies'),
          { type: 'separator' },
          boundItem(pageLabel('clear-data'), 'openClearData'),
          boundItem(pageLabel('import-data'), 'openImportData'),
          boundItem(pageLabel('sessions'), 'openSessionsPanel', pageFeature('sessions')),
          boundItem(pageLabel('spaces'), 'openSpaces', pageFeature('spaces')),
          { type: 'separator' },
          boundItem(pageLabel('task-manager'), 'openTaskManager'),
          boundItem(pageLabel('certificates'), 'openCertificates'),
          boundItem(pageLabel('page-info'), 'openPageInfo'),
          boundItem(pageLabel('view-source'), 'openViewSource'),
          { type: 'separator' },
          // 更新已是「关于 Hira」页里的选项卡（hira://about?tab=update），
          // 所以这里刻意不叫「关于 Hira」——同一张页面不该在菜单里出现两次同名项。
          boundItem('软件更新', 'openUpdate'),
          boundItem(pageLabel('crash-report'), 'openCrashReport')
        ]
      },
      {
        label: '帮助',
        submenu: [
          boundItem(pageLabel('shortcuts'), 'openShortcuts'),
          { type: 'separator' },
          {
            label: '关于 Hira',
            click: act('openAbout') || (() => {
              // 没有注入 openAbout 时退化为原生对话框，至少不该是个死按钮
              dialog.showMessageBox({
                type: 'info',
                title: '关于',
                message: `${app.getName()} ${app.getVersion()}`,
                detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`
              }).catch(() => {})
            })
          }
        ]
      }
    ]

    // ── 插件扩展面（contributes.menus + `app-menu.item` 插槽）─────────────
    // 内置菜单一字不动：插件项一律追加在各自顶级菜单的最底部（前面隔一条分隔线），
    // 这样"原生长什么样"永远是确定的，不会因为装了插件而把常用项挤走。
    // `app.root` 的项则作为新的顶级菜单追加在最后。
    const pm = getPluginMenus()
    if (pm && typeof pm.itemsFor === 'function') {
      for (const top of template) {
        const where = top.label ? WHERE_BY_TOP_LABEL[top.label] : undefined
        if (!where || !Array.isArray(top.submenu)) continue
        const extra = pm.itemsFor(where, state)
        if (Array.isArray(extra) && extra.length) {
          top.submenu.push({ type: 'separator' }, ...extra)
        }
      }
      if (typeof pm.roots === 'function') {
        const roots = pm.roots(state)
        if (Array.isArray(roots) && roots.length) template.push(...roots)
      }
    }

    // ── 功能面门禁（§10.4 表达层）────────────────────────────────────────
    // 放在插件项合并**之后**：插件没有 feature 标记，永远原样通过；而某个内置顶级菜单
    // 若因引擎关闭被清空，它连同挂在它下面的插件项一起消失（没有菜单可挂）。
    // 可用性只从 state 读（`features` 已并入安装签名 → 插件启停后自动重建，见 install）。
    const features = state && state.features && typeof state.features === 'object' ? state.features : {}
    const gated = []
    for (const top of template) {
      if (!top || typeof top !== 'object') continue
      if (!Array.isArray(top.submenu)) { gated.push(top); continue }
      const submenu = applyFeatureGate(top.submenu, features)
      // 子菜单被清空 = 这个顶级菜单已经没有任何可用入口，整条消失。
      if (!submenu.length) continue
      gated.push({ ...top, submenu })
    }
    /**
     * Last-mile safety net for host and plugin contributions: a leaf without
     * click or a native role is not executable and must never look actionable.
     */
    const sanitize = (items: AppMenuItem[]): AppMenuItem[] => {
      const out: AppMenuItem[] = []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        let next = item
        if (Array.isArray(item.submenu)) {
          const submenu = sanitize(item.submenu)
          next = {
            ...item,
            submenu,
            ...(submenu.length === 0 && typeof item.click !== 'function' ? { enabled: false } : {})
          }
        } else if (!item.role && typeof item.click !== 'function') {
          next = { ...item, enabled: false }
        }
        out.push(next)
      }
      return out
    }
    return sanitize(gated)
  }

  /** 插件菜单签名：插槽项没有静态数据，用适配器自带签名兜住"内容变了"。 */
  function pluginMenuSignature(): string {
    try {
      const pm = getPluginMenus()
      return pm && pm.signature ? String(pm.signature) : ''
    } catch (_) {
      return ''
    }
  }

  /**
   * 上一次安装时的**状态签名**（`null` = 还没装过）。
   *
   * 菜单的全部动态内容都来自 `getState()` —— 这是本模块「纯装配、零业务」的契约
   * （文件头写明：菜单项该不该勾选、标签叫什么，全部由调用方回答，本模块不认识
   * TabManager / spaceService）。所以一份 JSON 就足以判断"这次重建有没有意义"：
   * 导航换个页面时 `tab:changed` 照样会来，但**活动标签的标题 / 网址根本不进菜单**
   * （"固定 / 静音"是 `boundItem`，没有 checked），重建纯属白烧 —— 而最后那步
   * `Menu.setApplicationMenu` 是**原生**调用，会重建窗口菜单栏。
   *
   * ⚠ 维护约束：新增菜单项时，**它的动态取值必须来自 `getState()`**。若有人在
   * `buildTemplate` 里直接读设置 / 窗口 / 标签，这个签名就看不见那个变化，
   * 表现为"改了设置菜单不更新"。届时要么把值并入 state，要么去掉这个跳过。
   */
  let lastSignature: string | null = null

  /**
   * 安装（首次或整体刷新）。setApplicationMenu 会替换旧菜单，无需手动销毁。
   * 状态与上次完全一致时**直接跳过**（返回 null），见 `lastSignature` 的说明。
   */
  function install() {
    const state = getState() || {}
    let signature: string | null = null
    // 键位快照必须进签名：菜单里的组合键是「显示值」，改键后不重建就会一直显示旧键。
    try { signature = JSON.stringify([state, pluginMenuSignature(), getKeybindingSignature()]) } catch (_) {}
    // 算不出签名（异常）时**不跳过**：宁可多重建一次，不可漏更新。
    if (signature !== null && signature === lastSignature) return null
    lastSignature = signature
    const menu = Menu.buildFromTemplate(buildTemplate(state) as MenuItemConstructorOptions[])
    Menu.setApplicationMenu(menu)
    return menu
  }

  return { install, refresh: install }
}

