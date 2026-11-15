/**
 * 固定扩展条 —— Chrome 式「地址栏右侧、面板按钮之前」的一排扩展图标。
 *
 * 职责边界（与面板按钮同一姿势，但内容来源完全不同）：
 *   · 本模块只吃 entries（`{ id, name, icon, state, detail }`）并画按钮；
 *   · 点击 / 右键只上抛 `{ entry, anchorRect, x, y }`，不认识扩展客户端、不认识 IPC；
 *   · 空列表时 `hidden`，**不占位**（没有固定扩展的窗口与以前完全一样）。
 *
 * 为什么**不进按钮账本**（toolbarRegistry）：
 *   账本管的是「用户可编辑的外壳按钮」（拖进拖出、显隐由 app.navbar_buttons 决定）；
 *   固定扩展是**运行时内容**，由扩展自己的「固定」意图驱动。混进账本会让
 *   「隐藏某个面板按钮」的编辑操作意外吞掉扩展图标，也会让编辑浮层里出现
 *   无法解释的格子。两者是两条正交的轴，故各有各的家。
 *
 * 为什么按 id 增量对齐而不是整条重建：
 *   固定态会随 toggle / pinned 广播刷新，重建会让正在悬停的图标闪一下、
 *   也让 `getBoundingClientRect()` 的锚点在弹窗打开前失效。复用节点后，
 *   只有**图标源**或文案变化时才替换按钮内容。
 */

import { createFaviconBadge } from '@hira-ng/ui-common'
import type {
  AnchoredPoint,
  ExtensionActionEntry,
  ExtensionActionsController
} from '../types'

export const EXT_ACTIONS_CSS = `
    /* 与面板按钮同一行、同一间距 —— 固定扩展是「地址栏右侧」这一簇的第一段。 */
    .extension-actions {
      display: flex;
      align-items: center;
      gap: var(--ng-navbar-bottom-row-gap);
      /* 宽度护栏：固定扩展会生长，容不下时折行，而不是被宿主裁掉。 */
      flex: 0 1 auto;
      flex-wrap: wrap;
      row-gap: var(--ng-navbar-bottom-row-gap);
      min-width: 0;
      /* 图标之间的缝不能落在窗口拖拽区，否则双击会误最大化。 */
      -webkit-app-region: no-drag;
    }

    /* 空态不占位（.extension-actions 的 inline-flex 会盖过 UA 的 [hidden]）。 */
    .extension-actions[hidden] {
      display: none;
    }

    /* 与右侧面板按钮之间的**隐分割线**（Chrome 的「扩展区 | 工具栏区」那道细缝）。
       它住在 .extension-actions 内部、恒为最后一个子元素 —— 所以：
         · 没有固定扩展时整块 hidden，分隔线跟着一起消失（不会留一条孤零零的线）；
         · 扩展数量变化时不用重新算位置，天然贴在最后一个图标之后。
       颜色取主题的 --hira-border-subtle（明暗两套各自定义），"隐"而不"无"。 */
    .extension-actions .extension-actions-divider {
      flex: 0 0 auto;
      align-self: center;
      width: 1px;
      height: 14px;
      /* 右侧紧邻面板按钮（.navbar-bottom-right 自身没有 gap），所以右留白只能自己补。 */
      margin: 0 2px;
      border-radius: 1px;
      background-color: var(--hira-border-subtle);
      /* 纯装饰：不吃点击、不吃拖拽，也不参与聚焦环。 */
      pointer-events: none;
    }

    /* 停用 / 加载失败：灰化但**仍可交互** —— 点击会去管理页，右键能启用或取消固定。
       刻意不用 disabled：那会连同右键一起吃掉，用户就没法把坏掉的扩展撤下来。 */
    .extension-actions .navbar-action-button[data-state="inactive"] {
      opacity: 0.45;
    }
    .extension-actions .navbar-action-button[data-state="inactive"]:hover {
      opacity: 0.72;
    }

    /* 图标由 favicon 徽标提供（<span><img></span>，失败时降级首字母）——
       统一按 18px 画，与面板按钮的图标同尺寸；按钮尺寸仍归 ACTION_BUTTON_CSS。 */
    .extension-actions .navbar-action-button > span {
      pointer-events: none;
    }
    .extension-actions .navbar-action-button { position: relative; }
    .extension-actions .navbar-action-button img {
      width: 18px;
      height: 18px;
      display: block;
    }
    .extension-actions .extension-action-badge {
      position: absolute;
      right: -2px;
      bottom: -1px;
      max-width: 28px;
      min-width: 10px;
      height: 12px;
      padding: 0 3px;
      overflow: hidden;
      border-radius: 6px;
      background: var(--hira-danger, #d93025);
      color: #fff;
      font-size: 8px;
      font-weight: 650;
      line-height: 12px;
      text-align: center;
      text-overflow: clip;
      white-space: nowrap;
      box-shadow: 0 0 0 1px var(--hira-surface, #fff);
    }

    /* 借住侧栏底槽时与面板簇同口径：间距收紧、可折行；数量过多在本段内滚动。 */
    .navbar-bottom-right[data-dock="true"] .extension-actions {
      gap: var(--ng-navbar-column-gap);
      row-gap: var(--ng-navbar-column-gap);
      max-height: var(--ng-navbar-dock-buttons-max-height);
      overflow-y: auto;
      min-width: 0;
    }
    /* 侧栏底槽是**竖排**（扩展图标行在上、面板网格在下），分隔线跟着转 90°：
       横贯可用宽的一条细线，作为「扩展区 / 面板区」的边界。
       100% 基宽 + wrap ⇒ 它自己独占一行、落在图标下方，不必改 DOM 顺序。 */
    .navbar-bottom-right[data-dock="true"] .extension-actions .extension-actions-divider {
      flex: 0 0 100%;
      width: 100%;
      height: 1px;
      margin: 4px 0 0;
    }
`

/**
 * @typedef {Object} ExtensionActionEntry
 * @property {string} id
 * @property {string} name
 * @property {string} [icon] 图标地址（data URL / hira:// / 本地路径；空则降级首字母）
 * @property {'active'|'inactive'} [state] 交互态（inactive = 停用或加载失败）
 * @property {string} [detail] 状态说明（「已停用」/「加载失败」），拼进按钮提示
 */
/** 视口矩形 → 主进程 openPopup 契约需要的纯对象（DOMRect 自带的方法不可结构化克隆）。 */
function toAnchorRect(rect: DOMRect): AnchoredPoint['anchorRect'] {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  }
}

/**
 * 菜单坐标必须是**整数**。
 *
 * `getBoundingClientRect()` 在分数缩放 / 非整数布局下会给出 `72.5` 这类值，而
 * Electron 的 `menu.popup({ x, y })` 对 x/y 做的是 gin 的 int 转换 —— 拿到非 Int32
 * 会直接抛错，整条 IPC 被拒。渲染侧那层 catch 一吞，现象就是「右键毫无反应」。
 * 鼠标事件的 clientX/clientY 本身也是浮点（高 DPI），故统一在这里取整。
 */
function toMenuPoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) }
}

/** 按钮提示：名称 + 状态说明；停用态要让用户知道「为什么它灰着」。 */
function titleOf(entry: ExtensionActionEntry): string {
  const name = entry.name || entry.id
  return entry.detail ? `${name}（${entry.detail}）` : name
}

/**
 * @param {Document} doc
 * @param {{
 *   onActivate?: (entry: ExtensionActionEntry, pos: { anchorRect: object, x: number, y: number }) => void,
 *   onContextMenu?: (entry: ExtensionActionEntry, pos: { anchorRect: object, x: number, y: number }) => void
 * }} [ctx]
 * @returns {{ element: HTMLElement, render: (entries: ExtensionActionEntry[]) => void }}
 */
export function createExtensionActions(
  doc: Document,
  ctx: {
    onActivate?: (entry: ExtensionActionEntry, position: AnchoredPoint) => void
    onContextMenu?: (entry: ExtensionActionEntry, position: AnchoredPoint) => void
  } = {}
): ExtensionActionsController {
  const { onActivate, onContextMenu } = ctx

  const element = doc.createElement('div')
  element.className = 'extension-actions'
  element.hidden = true
  element.setAttribute('role', 'toolbar')
  element.setAttribute('aria-label', '固定扩展')

  /**
   * 分隔线：把「固定扩展」这一簇与右侧面板按钮隔开。
   *
   * 创建时**一次**追加、此后永不重排 —— render 的插入点永远是「在 prev 之后 /
   * 在 firstChild 之前」，而它是末尾子节点，所以每个新图标都会自然落到它前面。
   * 视觉与语义都只是装饰：`aria-hidden` + `pointer-events: none`。
   */
  const divider = doc.createElement('span')
  divider.className = 'extension-actions-divider'
  divider.setAttribute('aria-hidden', 'true')
  element.appendChild(divider)

  const buttons = new Map<string, {
    btn: HTMLButtonElement
    iconKey: string
    entry: ExtensionActionEntry
  }>()

  /**
   * 造一颗按钮并绑定「读当前 entry」的监听器。
   *
   * 监听器里不闭包 entry 本身：同一个 id 的 entry 会被后续 render 替换
   * （启停 / 图标 / 名称都可能变），闭包旧对象会让点击用到过期数据。
   */
  function createButton(id: string): HTMLButtonElement {
    const btn = doc.createElement('button')
    btn.type = 'button'
    btn.className = 'navbar-action-button'
    btn.dataset.extensionId = id

    btn.addEventListener('click', (event) => {
      const current = buttons.get(id)
      if (!current || typeof onActivate !== 'function') return
      const rect = btn.getBoundingClientRect()
      onActivate(current.entry, {
        anchorRect: toAnchorRect(rect),
        ...toMenuPoint(rect.left, rect.bottom)
      })
    })

    // 右键：坐标取**鼠标位置**（与 navCluster / 地址栏编辑菜单同一范式）。
    // 不用 rect：菜单该贴着光标，而不是贴着按钮左下角；按钮在侧栏窄槽里时
    // rect 的几何还会因折行/滚动与实际落点偏差很大。
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const current = buttons.get(id)
      if (!current || typeof onContextMenu !== 'function') return
      onContextMenu(current.entry, {
        anchorRect: toAnchorRect(btn.getBoundingClientRect()),
        ...toMenuPoint(event.clientX, event.clientY)
      })
    })

    return btn
  }

  /**
   * 重建固定扩展条（按 id 增量对齐）。
   * @param {ExtensionActionEntry[]} entries
   */
  function render(entries: ExtensionActionEntry[] = []): void {
    const seen = new Set<string>()
    let prev: Element | null = null

    for (const entry of entries) {
      if (!entry || !entry.id) continue
      seen.add(entry.id)

      let record = buttons.get(entry.id)
      if (!record) {
        record = { btn: createButton(entry.id), iconKey: '', entry }
        buttons.set(entry.id, record)
      }
      record.entry = entry

      // 内容只在真变了的时候替换：状态 / 提示文字的更新不该触发图标重绘。
      const badgeText = String(entry.badgeText || '')
      const badgeColor = String(entry.badgeColor || '')
      const iconKey = `${entry.icon || ''}\u0000${entry.name || ''}\u0000${badgeText}\u0000${badgeColor}`
      if (record.iconKey !== iconKey) {
        const content = doc.createDocumentFragment()
        content.appendChild(createFaviconBadge(doc, entry.icon, entry.name || entry.id, 18))
        if (badgeText) {
          const badge = doc.createElement('span')
          badge.className = 'extension-action-badge'
          badge.textContent = badgeText
          if (badgeColor) badge.style.background = badgeColor
          content.appendChild(badge)
        }
        record.btn.replaceChildren(content)
        record.iconKey = iconKey
      }

      const title = titleOf(entry)
      if (record.btn.title !== title) record.btn.title = title
      record.btn.setAttribute('aria-label', title)
      const state = entry.state === 'inactive' ? 'inactive' : 'active'
      if (record.btn.dataset.state !== state) record.btn.dataset.state = state

      // 按目标顺序就位（insertBefore 对「已在正确位置」的元素是 no-op）。
      element.insertBefore(record.btn, prev ? prev.nextSibling : element.firstChild)
      prev = record.btn
    }

    // 已被取消固定 / 卸载的扩展：连节点一起撤，避免幽灵按钮。
    for (const [id, record] of buttons) {
      if (seen.has(id)) continue
      record.btn.remove()
      buttons.delete(id)
    }

    element.hidden = seen.size === 0
  }

  return { element, render }
}
