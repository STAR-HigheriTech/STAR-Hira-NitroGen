// @ts-check
/**
 * 「一条标签」的渲染记录 —— 造一次 DOM、接一次事件，之后靠 `update(next)` 增量更新。
 *
 * 这是**记录（record）**，不是组件实例：它由渲染引擎按 key（`tab:<id>`）创建一次并复用，
 * 内部持有可变 `state`，因此所有事件闭包读到的永远是**最新**值 ——
 * 这是 keyed 复用能成立的前提（闭包读旧对象 = 重命名/静音后行为错位）。
 *
 * 能力全部来自端口（`ports`），本模块**不认识**：宿主是谁、拖拽怎么解释、菜单谁弹、
 * 编辑器谁管、预览浮层住在哪。它只做四件事：造行、更新行、上报意图、把事件转给端口。
 */

import { createTab } from '../components/Tab.js'
import { currentActiveTabIdFromDom } from '@hira-ng/ui-common'
import { setDragItem } from '@hira-ng/shared-types/src/drag-item.mjs'
import type {
  RenderRecord,
  TabDecorator,
  TabPatch,
  TabPreviewController,
  TabViewState
} from '../types.js'

interface TabRecordPorts {
  onSelect?: (tabId: string) => unknown
  onSplitWithActive?: (tabId: string) => unknown
  onClose?: (tabId: string) => unknown
  onDropOnContent?: (tabId: string, baseTabId: string) => unknown
  onDropOnContentBegin?: (tabId: string, baseTabId: string) => unknown
  onToggleAudio?: (tabId: string) => unknown
  onPermissionClick?: (tabId: string) => unknown
  decorate?: TabDecorator | null
  preview?: TabPreviewController
  drag?: { begin: (tabId: string) => void; end: () => void }
  openMenu?: (x: number, y: number, tab: TabViewState) => Promise<string | null>
}

/**
 * @param {Document} doc
 * @param {TabViewState} item 投影项（tab）
 * @param {{
 *   onSelect?: Function, onClose?: Function, onToggleAudio?: Function,
 *   onDropOnContent?: (tabId: string, baseTabId: string) => void,
 *   decorate?: Function|null,
 *   preview?: { show: Function, hide: Function, hideIfTab: Function },
 *   drag?: { begin: Function, end: Function },
 *   openMenu?: (x: number, y: number, tab: TabViewState) => Promise<string|null>
 * }} ports
 *   `onSelect` / `onClose` / `onToggleAudio` 都是**无参意图**（见 components/tab/gestures.ts）：
 *   「是哪条标签」由**本记录**补 —— 它持有可变的 `state`，keyed 复用后永远是最新值。
 * @returns {RenderRecord<TabViewState>}
 */
export function createTabRecord(
  doc: Document,
  item: TabViewState,
  ports: TabRecordPorts = {}
): RenderRecord<TabViewState> {
  /**
   * 「拖动开始前正在看的那一格」（Arc 式分屏落点要配对的格）。
   * 存在闭包里而不是 DOM 上：它只在"一次拖拽"的生命周期内有意义，拖完即弃。
   * @type {string|null}
   */
  let dragBaseTabId: string | null = null
  const preview = ports.preview
  const drag = ports.drag

  // 可变状态：复用后事件闭包必须读最新值（见文件头）
  const state: TabViewState = { ...item }
  const tab = createTab(doc, item, {
    // ⚠ 手势层调的是**无参**回调，参数在这里由 state 补上。写成 `(tabId) => ports.onSelect(tabId)`
    //   转发"收到的参数"会让 tabId 恒为 undefined —— 切换/关闭/静音会被 IPC 契约全部拦下。
    onSelect: () => { if (typeof ports.onSelect === 'function') ports.onSelect(state.tabId) },
    // Alt/Option + 单击 = 与当前活动标签分屏（对齐 Firefox / Zen）。
    // 与 onSelect 同款：手势层无参，tabId 由本记录从可变 state 补上。
    onAltSelect: () => { if (typeof ports.onSplitWithActive === 'function') ports.onSplitWithActive(state.tabId) },
    onClose: () => { if (typeof ports.onClose === 'function') ports.onClose(state.tabId) },
    // Arc 式入口：拖到网页区域松手 = 与"拖动前正在看的那一格"分屏（落点判定在主进程）
    onDropOnContent: (tabId: string, baseTabId: string) => {
      if (typeof ports.onDropOnContent === 'function') ports.onDropOnContent(tabId, baseTabId)
    },
    // 同一条链的**开始**：主进程据此起 30fps 光标采样，拖动期间把"这一格会落在哪"
    // 推给落点预览浮层（拖动期间渲染层收不到指针事件，只有主进程能算）。
    onDropOnContentBegin: (tabId: string, baseTabId: string) => {
      if (typeof ports.onDropOnContentBegin === 'function') ports.onDropOnContentBegin(tabId, baseTabId)
    },
    onToggleAudio: () => { if (typeof ports.onToggleAudio === 'function') ports.onToggleAudio(state.tabId) },
    // 权限请求标记：与上三条同款 —— 标记件只报「点了」，是哪条标签由本记录补。
    onPermissionClick: () => {
      if (typeof ports.onPermissionClick === 'function') ports.onPermissionClick(state.tabId)
    }
  }, { decorate: ports.decorate })

  const el = tab.element
  el.draggable = true
  el.dataset.tabId = item.tabId

  // hover 预览：mouseover/mouseout 绑在 tab element 上（子元素间移动不算离开）
  el.addEventListener('mouseover', (e: MouseEvent) => {
    if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return
    if (preview) preview.show(el, state)
  })
  el.addEventListener('mouseout', (e: MouseEvent) => {
    if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return
    // 只要鼠标仍在标签条内（另一条标签 / 标签之间的缝隙 / 滚动条 / 标签右侧那块空白），
    // 就不算「离开标签条」—— 那只是沿标签条横向巡视，预览应保持并随鼠标换内容。
    // 判据取整条标签条（#tabs）而不是滚动容器（#tabs-inner）：右侧空白是 #tabs 自己的
    // 拖拽区（见 styles.js 的 #tabs::after），它不在滚动容器里。
    // 700ms 的等待是标签栏级的：跨标签不重新计时（见 TabPreview 的注释）。
    const rt = e.relatedTarget as Element | null
    const inStrip = rt && typeof rt.closest === 'function' ? rt.closest('#tabs') : null
    if (inStrip) return
    // 其余情况（移到 navbar / 网页 / 空白 / 移出窗口）→ 立即收起，不留延迟。
    if (preview) preview.hide()
  })

  // 拖拽排序（原生 HTML5 DnD）。生命周期交给落点控制器：它只管「开始 / 结束」，
  // 落点语义全部由那边的六条规则解释（本模块不解释任何手势）。
  el.addEventListener('dragstart', (e: DragEvent) => {
    const dataTransfer = e.dataTransfer
    if (!dataTransfer) return
    // 先记下「拖动前正在看的那一格」——分屏落点要配对的正是它。
    // 必须**在下面的切换之前**取：拖拽会把当前标签切到被拖的这个（Edge / Chrome 同口径），
    // 切完再问就只剩被拖的那个了（见 gestures.js#currentActiveTabIdFromDom 的说明）。
    dragBaseTabId = currentActiveTabIdFromDom(el)
    // 先切到被拖的标签、再开始重排 —— 与 Edge / Chrome 同口径：从后台标签起拖时它当场成为
    // 当前标签（"我要搬的这个就是我要看的那个"），松手前页面已经切过去了。
    // 判据读 state.active（渲染引擎每轮 Object.assign 保鲜，不会读到上一轮的旧值）。
    if (!state.active && typeof ports.onSelect === 'function') ports.onSelect(state.tabId)
    if (drag) drag.begin(state.tabId)
    // ── 报"开始拖了"（落位预览的起点）──────────────────────────────────────
    // 为什么必须在 dragstart 这一拍报：拖动期间渲染层**收不到任何指针事件**（指针一进
    // 网页原生视图就离开了外壳视口），所以"这一格会落在哪"的预览只能由主进程按屏幕光标算，
    // 而它需要一个起点信号（见 main/tab-drop-zone.js）。
    // ⚠ 第二个参数必须是**切换之前**那一刻的活动标签（上面刚取到的 dragBaseTabId）——
    //   它就是"拖动前正在看的那一格"，也是分屏要配对的那一格。切换之后再问就只剩被拖的了。
    if (typeof ports.onDropOnContentBegin === 'function' && !state.pinned) {
      ports.onDropOnContentBegin(state.tabId, dragBaseTabId || '')
    }
    // copyMove：条内排序用 move，拖到别的面板（集锦 / 画板 / 书签栏）用 copy ——
    // 只写 'move' 会让落点的 dropEffect='copy' 被判成"禁止落下"（drop 不派发）。
    dataTransfer.effectAllowed = 'copyMove'
    // 统一拖拽协议（shared-types#drag-item）：`{ domain:'tab', id, kind:'page', url, title }`。
    // 跨视图落点（集锦 / 画板 / 书签栏）按 domain 分发，不再各自解析私有 MIME。
    // `plain:'none'`：绝不能写 text/plain —— 网页会把它当文本/搜索词接走。
    // `application/x-ng-tab` 保留给旧落点（标签栏自身只读闭包变量，写它无副作用）。
    try { dataTransfer.setData('application/x-ng-tab', state.tabId) } catch {}
    setDragItem(dataTransfer, {
      domain: 'tab',
      id: state.tabId,
      kind: 'page',
      tabId: state.tabId,
      url: state.url || '',
      title: state.title || ''
    }, { plain: 'none' })
    el.style.opacity = '0.4'
  })
  el.addEventListener('dragend', () => {
    el.style.opacity = ''
    if (drag) drag.end()
    // ── Arc 式入口：拖到**网页区域**松手 = 与"拖动前正在看的那一格"分屏 ─────────
    // 这里只报两个 id（"拖前在看哪个"可能为空）—— **落点与判定全在主进程**：
    //   · 四个纵向宿主的渲染进程里没有主窗口外壳 DOM，判据必须在主进程才能五处共用；
    //   · 原生拖拽离开源视口后 `dragend` 的 clientX/clientY 已不是"松手在哪"
    //     （是源视口内的最后位置），主进程改读 screen.getCursorScreenPoint()。
    // 见 TabManager#dropTabOnContent。
    const base = dragBaseTabId
    dragBaseTabId = null
    if (typeof ports.onDropOnContent !== 'function') return
    // 固定标签不参与分屏（真源 tab-policy#canSplit）—— 拖到网页上松手也不该有任何动作。
    if (state.pinned) return
    ports.onDropOnContent(state.tabId, base || '')
  })

  // 右键菜单：弹层与动作分发都在菜单模块里，本行只上报坐标与快照
  el.addEventListener('contextmenu', async (e: MouseEvent) => {
    e.preventDefault()
    if (typeof ports.openMenu !== 'function') return
    await ports.openMenu(e.clientX, e.clientY, state)
  })

  return {
    key: `tab:${item.tabId}`,
    node: el,
    state,
    item,
    update(next: TabPatch) { tab.update(next) }
  }
}
