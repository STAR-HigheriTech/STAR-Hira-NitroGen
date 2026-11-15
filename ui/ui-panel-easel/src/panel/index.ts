// @ts-check
/**
 * 画板（D4）· **窄面板形态**。
 *
 * 窄栏里做不了"无限画布"（宽度不够、拖不动），所以面板只承担**导航**：
 * 列出所有画板、新建 / 重命名 / 删除、点一下把某块板在**独立窗口**里打开。
 * 真正的画布在 `../window/index.js`，两者共用同一份存取内核（`../shared/store.js`）。
 *
 * 分层：本包属 `ui`，只 import `ui-common` 与 `shared-types`（纯规则）；
 * 外部能力（设置读写、开窗口）一律由宿主经 `ctx` 注入。
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import { injectPanelStyles, iconByName } from '@hira-ng/ui-common'
import { createBoard, EASEL_ACTIVE_BOARD_SETTING_KEY } from '@hira-ng/shared-types/src/easel.mjs'
import type { EaselBoard } from '@hira-ng/shared-types/src/easel.mjs'
import { createEaselStore } from "../shared/store"
import { injectEaselStyles, PANEL_CSS } from "../shared/styles"

interface EaselSettingsPort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<unknown>
}

type EaselPanelContext = Omit<PanelContext, 'clients' | 'openWindow' | 'confirm'> & {
  clients?: (PanelContext['clients'] & { settings?: EaselSettingsPort }) | null
  openWindow?: (type: string) => unknown
  confirm?: (options: { title?: string; message?: string }) => Promise<boolean> | boolean
}

export function injectEaselPanelStyles(doc: Document): void {
  // 与其它面板同一条基座（html/body/#root reset + 滚动条 / 输入框等共用件）——
  // 少了它，面板里的滚动条与聚焦态会和别的面板不一致。
  injectPanelStyles(doc)
  injectEaselStyles(doc, PANEL_CSS)
}

/**
 * @param {Document} doc
 * @param {EaselPanelContext} [ctx]
 */
export function createEaselPanel(doc: Document, ctx: PanelContext = {}) {
  const panelCtx = ctx as EaselPanelContext
  const settings = panelCtx.clients?.settings || null
  const store = createEaselStore(settings || { get: async () => null, set: async () => ({}) })

  /**
   * ⚠ **不要在这里再建一个 `createPanelShell`。**
   *
   * 宿主（`renderer/panels/main.js`）**已经**建好了面板外壳（含标题栏与关闭键），并把
   * 本函数返回的元素塞进那个外壳的 `content` 里。再建一层壳就会得到：
   *   · **双标题栏**（宿主一个「画板」、面板自己又一个）；
   *   · **双份内边距** —— 外壳 content 的 `8px 10px` 之上再叠一层的 `8px 10px`，
   *     于是列表项的左右缩进比别的面板**多一倍**。
   * 正确形状与 `ui-panel-profiles`（空间面板）逐字一致：**只返回裸 body**，
   * 标题/外壳交给宿主，内边距交给宿主那一层。
   */
  const root = doc.createElement('div')
  root.className = 'hira-easel-panel'
  const list = doc.createElement('div')
  list.className = 'hira-easel-list'
  const bar = doc.createElement('div')
  bar.className = 'hira-easel-bar'
  root.appendChild(list)
  root.appendChild(bar)

  /**
   * 打开独立窗口。**先把"要看哪块板"写进设置**再由窗口读 ——
   * `window:open` 的载荷不进子窗口的 URL，与其为它单开一条传参通道，
   * 不如用一条设置项当"当前画板"（窗口每次挂载都读它）。
   */
  function openBoard(boardId: string) {
    try { settings && settings.set(EASEL_ACTIVE_BOARD_SETTING_KEY, boardId) } catch (_) {}
    if (typeof panelCtx.openWindow === 'function') panelCtx.openWindow('easel-window')
  }

  function boardRow(board: EaselBoard) {
    const row = doc.createElement('div')
    row.className = 'hira-easel-board'
    const meta = doc.createElement('div')
    meta.className = 'meta'
    const name = doc.createElement('div')
    name.className = 'name'
    name.textContent = board.name
    const sub = doc.createElement('div')
    sub.className = 'sub'
    sub.textContent = `${board.cards.length} 卡片 · ${board.strokes.length} 笔迹`
    meta.appendChild(name)
    meta.appendChild(sub)
    row.appendChild(meta)
    row.onclick = () => openBoard(board.id)

    const del = doc.createElement('button')
    del.className = 'hira-easel-btn icon'
    del.title = '删除画板'
    del.setAttribute('aria-label', '删除画板')
    const removeIcon = iconByName('Trash2', doc, { size: 15 })
    if (removeIcon) del.appendChild(removeIcon)
    del.onclick = (event: MouseEvent) => {
      event.stopPropagation()
      const ok = typeof panelCtx.confirm === 'function'
        ? panelCtx.confirm({ title: '删除画板', message: `删除画板「${board.name}」？其中的卡片会一起删除。` })
        : true
      Promise.resolve(ok).then((yes) => {
        if (!yes) return
        store.replace(store.boards.filter((candidate) => candidate.id !== board.id))
        render()
      })
    }
    row.appendChild(del)
    return row
  }

  function render() {
    list.textContent = ''
    if (store.boards.length === 0) {
      const empty = doc.createElement('div')
      empty.className = 'hira-easel-empty'
      empty.textContent = '还没有画板。'
      list.appendChild(empty)
      return
    }
    for (const board of store.boards) list.appendChild(boardRow(board))
  }

  const newBtn = doc.createElement('button')
  newBtn.className = 'hira-easel-btn primary icon'
  newBtn.title = '新建画板'
  newBtn.setAttribute('aria-label', '新建画板')
  const addIcon = iconByName('Plus', doc, { size: 16 })
  if (addIcon) newBtn.appendChild(addIcon)
  newBtn.onclick = () => {
    const count = store.boards.length + 1
    store.replace([...store.boards, createBoard(`画板 ${count}`)])
    render()
  }
  bar.appendChild(newBtn)

  async function refresh() {
    await store.load()
    render()
  }

  refresh().catch((error) => {
    console.error('[easel-panel] 载入失败:', error)
  })

  return {
    // 裸 body（见上面的 ⚠）：宿主会把它塞进自己的面板外壳 content 里。
    element: root,
    refresh,
    dispose() { store.flush() }
  }
}

/** 面板插件定义（宿主按 `contributes.panels[].id` 约定发现并挂载）。 */
export const panelDefinition: PanelDefinition = {
  id: 'easel-panel',
  injectStyles: injectEaselPanelStyles,
  mount(doc, ctx) {
    return createEaselPanel(doc, ctx)
  }
}
