/**
 * 导航按钮簇 —— rail 固定按钮 + 后退 / 前进 / 刷新 / 主页（**装配器**）。
 *
 * 分界线很清楚：
 *   · 本模块负责「有哪些按钮、摆在簇里什么位置、点了上抛什么意图」；
 *   · rail 固定按钮的图钉与按下态住自己的家（`nav/railToggle.ts`）；
 *   · 「这一簇摆在导航栏左区、还是被单行模式搬进标签行」以及固定按钮换到右下区 ——
 *     全是**行内顺序**，由 `rowBinding` 施加（本模块不认识 bottomRight / menuBtn）。
 *
 * 导航态的**唯一入口**是 `setNavState(patch)`（可否后退 / 前进、是否在加载）。
 * 状态本身不在这里产生 —— 编排层从标签投影（canGoBack/canGoForward）与
 * `tab:loading` 取，本模块只负责把状态映射成「置灰 / 换图标 / 换动作」。
 * 于是「导航按钮长什么样」与「导航态从哪来」各自可换，互不牵连。
 */

import { ArrowLeft, ArrowRight, RefreshCw, Home, X } from '@hira-ng/ui-common'
import { createActionButton, setActionButtonIcon } from './actionButton'
import { createRailToggle } from './nav/railToggle'
import type {
  IconRenderer,
  NavClusterController,
  NavContextMenuPayload,
  NavIntentPayload,
  NavStatePatch,
  NavigationDirection
} from '../types'

export const NAV_CLUSTER_CSS = `
    #toolbar-navigation-buttons {
      display: flex;
      align-items: center;
      gap: var(--ng-navbar-bottom-row-gap);
    }
`

/** 刷新键的两种形态：加载中 = 停止（✕），否则 = 刷新（⟳）。 */
const REFRESH_FORMS: Record<'refresh' | 'stop', { icon: IconRenderer; title: string }> = {
  refresh: { icon: RefreshCw, title: '刷新' },
  stop: { icon: X, title: '停止加载' }
}

/** 后退 / 前进按钮上修饰键的**语义标签**（本模块不认识具体行为，只做归类）。 */
export const NAV_INTENT = Object.freeze({
  /** Ctrl（macOS 上 Cmd）+ 点击：把目标历史页在新标签打开 */
  NEW_TAB: 'new-tab'
})

/**
 * 修饰键 → 意图。只有 Ctrl / Cmd 一档 —— 普通点击走按钮自身动作，
 * 右键走历史条目菜单（Alt 预览那一档已随导航预览能力一起删除）。
 */
function intentOf(event: MouseEvent): NavIntentPayload['intent'] | '' {
  if (event.ctrlKey || event.metaKey) return NAV_INTENT.NEW_TAB
  return ''
}

/** 按钮的外接矩形（右键菜单的锚点；纯几何，不含任何定位策略）。 */
function anchorRect(el: Element): NavContextMenuPayload['anchor'] {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function runIntent(intent: () => void | Promise<void>): void {
  try {
    Promise.resolve(intent()).catch((error) => {
      console.error('[navbar] navigation action failed:', error)
    })
  } catch (error) {
    console.error('[navbar] navigation action failed:', error)
  }
}

/**
 * @param {Document} doc
 * @param {{
 *   handlers?: object,
 *   useItem: (id: string, el: HTMLElement) => HTMLElement
 * }} ctx
 * @returns {{
 *   element: HTMLElement,
 *   railBtn: HTMLElement,
 *   setRailPosition: (position: 'left'|'right'|'top'|'bottom') => void,
 *   setNavState: (patch: { canGoBack?: boolean, canGoForward?: boolean, loading?: boolean }) => void
 * }}
 */
export function createNavCluster(
  doc: Document,
  ctx: {
    handlers?: {
      onToggleRail?: () => Promise<{ visible?: boolean; pinned?: boolean } | void> | { visible?: boolean; pinned?: boolean } | void
      onBack?: () => void | Promise<void>
      onForward?: () => void | Promise<void>
      onReload?: () => void | Promise<void>
      onStop?: () => void | Promise<void>
      onHome?: () => void | Promise<void>
      onNavIntent?: (payload: NavIntentPayload) => void
      onNavContextMenu?: (payload: NavContextMenuPayload) => void
    }
    useItem: <T extends HTMLElement>(id: string, element: T) => T
  }
): NavClusterController {
  const { handlers = {}, useItem } = ctx

  const element = doc.createElement('div')
  element.id = 'toolbar-navigation-buttons'

  const railToggle = createRailToggle(doc, { onToggleRail: handlers.onToggleRail })
  const railBtn = useItem('rail-toggle-button', railToggle.element)

  const backBtn = useItem(
    'back-button',
    createActionButton(doc, { id: 'back-button', icon: ArrowLeft, title: '后退' })
  )
  const forwardBtn = useItem(
    'forward-button',
    createActionButton(doc, { id: 'forward-button', icon: ArrowRight, title: '前进' })
  )

  // ── 后退 / 前进：普通点击 = 默认行为；Ctrl = 新标签；右键 = 历史菜单 ──
  // 全部在这一个函数里定序，避免"默认点击走按钮自己的 onClick、修饰键走另一条路"造成双份判断。
  function bindHistoryButton(
    btn: HTMLElement,
    direction: NavigationDirection,
    onDefault?: () => void | Promise<void>
  ): void {
    btn.addEventListener('click', (event) => {
      const intent = intentOf(event)
      if (intent) {
        // 修饰键语义由编排层承接（新标签），组件自身不认识页面。
        event.preventDefault()
        if (typeof handlers.onNavIntent === 'function') {
          runIntent(() => handlers.onNavIntent!({ direction, intent }))
        }
        return
      }
      if (typeof onDefault === 'function') runIntent(onDefault)
    })
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (typeof handlers.onNavContextMenu === 'function') {
        runIntent(() => handlers.onNavContextMenu!({
          direction,
          x: event.clientX,
          y: event.clientY,
          anchor: anchorRect(btn)
        }))
      }
    })
  }

  bindHistoryButton(backBtn, 'back', handlers.onBack)
  bindHistoryButton(forwardBtn, 'forward', handlers.onForward)

  // 刷新键形态（'refresh' | 'stop'）：同一颗按钮，两种图标 + 两种动作。
  // 为什么不是两颗按钮互相显隐：按钮在编辑浮层里有自己的顺序 / 显隐状态，
  // 换元素等于把那份状态在两种形态间来回搬 —— 就地改图标与意图才是不变量最少的做法。
  let refreshForm: 'refresh' | 'stop' = 'refresh'
  const refreshBtn = useItem(
    'refresh-button',
    createActionButton(doc, {
      id: 'refresh-button',
      icon: REFRESH_FORMS.refresh.icon,
      title: REFRESH_FORMS.refresh.title,
      // 点击时**现读**当前形态再决定动作（对齐 Hira/wexond：加载中点刷新 = 停止加载）
      onClick: () => {
        const fn = refreshForm === 'stop' ? handlers.onStop : handlers.onReload
        if (typeof fn === 'function') fn()
      }
    })
  )

  function setRefreshForm(next: 'refresh' | 'stop'): void {
    const form = next === 'stop' ? 'stop' : 'refresh'
    if (form === refreshForm) return
    refreshForm = form
    const spec = REFRESH_FORMS[form]
    setActionButtonIcon(refreshBtn, spec.icon)
    refreshBtn.title = spec.title
    refreshBtn.setAttribute('aria-label', spec.title)
  }

  // 主页按钮：普通可编辑成员（目录 id = home-button）—— 顺序 / 显隐与后退·前进·刷新
  // 同一条设置管，可在按钮编辑浮层里排序或被拖走隐藏；设置页不再有「显示主页按钮」开关。
  // 点击只上抛意图（onHome），跳转地址由编排层向主进程 home:url 取 —— 组件零地址逻辑。
  const homeBtn = useItem(
    'home-button',
    createActionButton(doc, { id: 'home-button', icon: Home, title: '主页', onClick: handlers.onHome })
  )

  // 初始顺序：rail 固定按钮在最前（可编辑成员的重排由行内顺序统一施加）。
  element.appendChild(railBtn)
  element.appendChild(backBtn)
  element.appendChild(forwardBtn)
  element.appendChild(refreshBtn)
  element.appendChild(homeBtn)

  // 初始不可用：新标签页没有历史，后退 / 前进本就该是灰的。
  // 不指望「第一份 tab:changed 一定会来」—— 首帧到第一份投影之间也有一段可见时间。
  setNavState({ canGoBack: false, canGoForward: false, loading: false })

  /**
   * 增量更新导航态。**patch 语义**：只改传进来的字段，未提及的保持原状 ——
   * 于是「按投影整体校正」（切换标签 / 任何一次投影）与「tab:loading 快路径」
   * 两条来源可以并存，谁都不会把对方没提到的状态清掉。
   * @param {{ canGoBack?: boolean, canGoForward?: boolean, loading?: boolean }} [patch]
   */
  function setNavState(patch: NavStatePatch = {}): void {
    if (patch.canGoBack !== undefined) backBtn.disabled = !patch.canGoBack
    if (patch.canGoForward !== undefined) forwardBtn.disabled = !patch.canGoForward
    if (patch.loading !== undefined) setRefreshForm(patch.loading ? 'stop' : 'refresh')
  }

  return {
    element,
    railBtn,
    setRailPosition: railToggle.setRailPosition,
    setRailPinned: railToggle.setPinned,
    setNavState
  }
}
