/**
 * 面板按钮区 —— 面板（下载 / 历史 / 书签 / 插件…）的开关按钮，外加常驻的菜单按钮。
 *
 * 面板是**插件**：名称 / 图标 / 段都随主进程下发的面板目录走（见 ui-common#buildCatalog），
 * 因此本模块对「有哪些面板」零知识 —— 它只负责把给它的东西画出来。
 *
 * 「建全量 + 显隐交给登记表」是刻意的：被隐藏的按钮必须仍有 DOM，
 * 否则按钮编辑浮层里那一格就再也拖不回来。
 *
 * 菜单按钮放在本模块：它是「站点控制行」的固定尾项，也是空面板区投放区的参照物
 * （见 toolbarRegistry 的 refs.panel）—— 与面板按钮同属一行，故同属一个模块。
 */

import { Menu } from '@hira-ng/ui-common'
import { createActionButton } from './actionButton'
import type {
  PanelCatalogEntry,
  PanelClusterController,
  PanelToggleHandler
} from '../types'

export const PANEL_BUTTONS_CSS = `
    .panel-buttons {
      display: flex;
      align-items: center;
      gap: var(--ng-navbar-bottom-row-gap);
      /* 宽度护栏：面板是插件，数量会生长 —— 容不下时折行，而不是被宿主裁掉几颗按钮。
         纵排时本簇住在侧栏底行的 dock 槽（高度自适应 → 折行可见）。 */
      flex-wrap: wrap;
      row-gap: var(--ng-navbar-bottom-row-gap);
    }

    /* 横排时菜单固定为本簇最后一颗，面板再多也不能越过它。 */
    .navbar-bottom-right:not([data-dock="true"]) #menu-button {
      order: 9999;
      margin-left: auto;
    }

    .navbar-bottom-right:not([data-dock="true"]) .panel-buttons {
      min-width: 0;
    }

    /* ── 借住侧栏底槽（落点由 row/sideDock.ts 判定，它打 data-dock）─────────
       窄列里只留三件事：**竖排堆叠**（按钮网格在上、菜单在下）、**间距收紧**
       （--ng-navbar-column-gap）、**装不下时在本簇内部滚动**。

       为什么菜单必须与按钮网格分开：菜单是常驻入口，若和面板按钮同处一个折行队列，
       插件一多它就会被推到折行末尾、挤出可视区（用户实测「菜单按钮被挤掉」）。
       分开之后网格可滚、菜单不可压缩 —— 面板再多，菜单也永远在。 */
    .navbar-bottom-right[data-dock="true"] {
      flex-direction: column;
      align-items: stretch;
      gap: var(--ng-navbar-column-gap);
      margin-left: 0;
      min-width: 0;
      width: 100%;
    }
    .navbar-bottom-right[data-dock="true"] .panel-buttons {
      gap: var(--ng-navbar-column-gap);
      row-gap: var(--ng-navbar-column-gap);
      /* 高度护栏：面板插件再多，最多长到这儿；多出来的在本簇内滚动，
         标签列表因此不会被一路挤没（见 tokens 的同名变量）。 */
      max-height: var(--ng-navbar-dock-buttons-max-height);
      overflow-y: auto;
    }
    /* 菜单按钮不吃压缩：它是这一行的**固定尾项**，不许被上面的按钮网格挤掉。 */
    .navbar-bottom-right[data-dock="true"] #menu-button {
      flex: 0 0 auto;
    }

    /* ── 红点（未读 / 进行中这类"该看一眼"的静态提示，由编排层 setPanelBadge 挂 class）──
       只画一个 ::after 小圆点：不新增元素、absolute 定位不参与布局、无动画/过渡 ——
       稳态下它只是这笔绘制。position:relative **只挂在红点态上**，
       不给所有动作按钮白白建一个定位上下文。 */
    .navbar-action-button.has-badge {
      position: relative;
    }
    .navbar-action-button.has-badge::after {
      content: '';
      position: absolute;
      top: 3px;
      right: 3px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--hira-badge-bg, #e5484d);
      /* 一圈极淡的暗边：浅色主题的 toolbar 上红点也不至于糊成一团。 */
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18);
      pointer-events: none;
    }
`

/**
 * @param {Document} doc
 * @param {{
 *   registry: object,
 *   onMenu?: Function,
 *   onPrepare?: (panelId: string) => void
 * }} ctx
 *   onPrepare：入口**意图**（指针进入 / 按下）—— 编排层据此在后台预热面板。
 *   组件不认识"预热"是什么，只把 id 交出去；点击语义仍只走 onToggle。
 * @returns {{
 *   element: HTMLElement,
 *   menuBtn: HTMLElement,
 *   render: (entries: Array<object>, onToggle: Function) => void
 * }}
 */
export function createPanelCluster(
  doc: Document,
  ctx: {
    registry: {
      declare(id: string, segment?: string): void
      add<T extends HTMLElement>(id: string, element: T): T
      pruneGroup(segment: string, liveIds: Set<string>): void
      applyOrder(): void
    }
    onMenu?: (event: MouseEvent) => void | Promise<void>
    onPrepare?: (panelId: string) => void
  }
): PanelClusterController {
  const { registry, onMenu, onPrepare } = ctx

  const element = doc.createElement('div')
  element.className = 'panel-buttons'

  const menuBtn = createActionButton(doc, {
    id: 'menu-button',
    icon: Menu,
    title: 'Menu',
    onClick: (e) => { if (typeof onMenu === 'function') onMenu(e) }
  })

  /**
   * 挂红点的按钮 id（视图态，**由编排层驱动**：本组件不认识"下载"这种业务）。
   *
   * 与 rail 同一套做法：`render` 会整体重建按钮，因此状态必须存在这里，
   * 重建时按 id 复原 —— 否则"下载中恰好面板目录刷新一次，红点就没了"。
   * 稳态代价 = 每次渲染一个 Set.has。
   */
  const badgeIds = new Set<string>()

  /**
   * 按面板目录重建按钮。
   *
   * 参数是**目录项数组**（`{ id, label, icon, segment }`）而不是 id 数组 ——
   * 段归属也随目录更新：新面板插件可能带来新的段，编辑浮层要能识别它。
   * @param {Array<{id:string,label?:string,icon?:Function|null,segment?:string}>} entries
   * @param {(panelId: string) => void} onToggle
   */
  function render(entries: PanelCatalogEntry[] = [], onToggle?: PanelToggleHandler): void {
    element.textContent = ''
    const uniqueEntries = Array.from(
      new Map((entries || []).filter((entry) => entry && entry.id).map((entry) => [entry.id, entry])).values()
    )
    for (const entry of uniqueEntries) {
      if (!entry || !entry.id) continue
      const id = entry.id
      registry.declare(id, entry.segment || 'panel')

      const btn = doc.createElement('button')
      btn.className = 'navbar-action-button'
      btn.id = id
      btn.title = entry.label || id
      // 红点态在重建时复原（见 badgeIds 的说明）。
      if (badgeIds.has(id)) btn.classList.add('has-badge')
      if (typeof entry.icon === 'function') {
        btn.appendChild(entry.icon(doc, { size: 18 }))
      }
      // 意图预取：指针已在按钮上 = "下一拍就点它"，此刻预热比点下去才冷启动快一拍。
      // pointerenter 覆盖悬停；pointerdown 覆盖"直接按下"（触屏/快速点击不经过悬停）。
      if (typeof onPrepare === 'function') {
        const prepare = (): void => {
          try {
            onPrepare(id)
          } catch (error) {
            console.error('[navbar] panel prepare failed:', error)
          }
        }
        btn.addEventListener('pointerenter', prepare)
        btn.addEventListener('pointerdown', prepare, { passive: true })
      }
      btn.addEventListener('click', async () => {
        try {
          if (typeof onToggle === 'function') await onToggle(id)
        } catch (error) {
          console.error('[navbar] panel toggle failed:', error)
        }
      })
      element.appendChild(btn)
      registry.add(id, btn)
    }
    // 目录变化后，原先登记的面板按钮若已不在目录里（插件被禁用），必须从登记表移除，
    // 否则 applyOrder 仍会把它当"可显示项"，编辑浮层里也会留下一个拖不动的幽灵。
    const liveIds = new Set(uniqueEntries.map((entry) => entry.id))
    liveIds.add('menu-button')
    registry.pruneGroup('panel', liveIds)
    registry.applyOrder()
  }

  /**
   * 给某个面板按钮挂 / 摘红点（**幂等**：同值重复调用不碰 DOM）。
   *
   * 由编排层驱动（例如"下载进行中"→ `setBadge('downloads-panel', true)`）；
   * 组件只认 id + 布尔。按钮此刻可能还没渲染出来（目录未到）——
   * 状态先记下，`render` 重建时会补上。
   * @param {string} panelId
   * @param {boolean} on
   */
  function setBadge(panelId: string, on: boolean): void {
    const id = String(panelId || '')
    if (!id) return
    const next = !!on
    if (badgeIds.has(id) === next) return
    if (next) badgeIds.add(id)
    else badgeIds.delete(id)
    // 直接查当前 DOM（按钮不归本模块的动态表管理，registry 里是同一个元素引用）。
    const btn = element.querySelector(`#${CSS.escape(id)}`)
    if (btn) btn.classList.toggle('has-badge', next)
  }

  return { element, menuBtn, render, setBadge }
}
