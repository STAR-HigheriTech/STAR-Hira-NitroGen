/**
 * 集锦面板 —— 由**插件自带**的渲染侧实现（`entry.render` 的用例）。
 *
 * 本文件只做「装配」这一件事，三块实现各自独立：
 *   · `panel-notes.model.js`    状态与数据来源（IPC 客户端的语义化封装）
 *   · `panel-notes.view.js`     DOM 渲染与用户意图转译
 *   · `panel-notes.markdown.js` Markdown → HTML（纯函数）
 *
 * 集锦 / 稍后读 / 回收站是**同一个面板的四个分段**（分段栏由视图自带），
 * 与「收藏」（书签树）分开：书签是导航，集锦是素材。
 *
 * 本文件还持有两条**跨窗口投递**的唯一入口：
 *   · `note:open-view` 事件（面板已开时）
 *   · `clients.notes.takeOpenView()`（面板本次才打开时，主进程留的 pending 槽）
 * 两条路径落到同一处 `applyOpenView`，语义必须完全一致。
 *
 * 契约（见 renderer/shared/plugin-renderer.js）：
 *   export const rendererPlugin = { panels: [panelDefinition] }
 * `panels[].id` 必须等于 manifest `contributes.panels[].id`（这里都是 `notes-panel`）。
 */

import { createNotesPanelContent, injectNotesPanelStyles, type NotesPanelContentContext } from './panel-notes.panel.js'

interface NotesRendererContext {
  clients?: { notes?: { takeOpenView?(): Promise<unknown> } }
  events?: { noteOpenView?: string }
  on?(route: string, handler: (payload: unknown) => void): () => void
}

/** 插件自带的面板定义（宿主按 id 对齐 manifest 的 contributes.panels）。 */
export const panelDefinition = {
  id: 'notes-panel',
  injectStyles: injectNotesPanelStyles,
  mount(doc: Document, ctx: NotesRendererContext) {
    const content = createNotesPanelContent(doc, ctx as unknown as NotesPanelContentContext)

    let unsubscribe: (() => void) | null = null
    if (typeof ctx.on === 'function' && ctx.events && ctx.events.noteOpenView) {
      unsubscribe = ctx.on(ctx.events.noteOpenView, (payload) => content.applyOpenView(payload))
    }
    // 面板**本次才打开**时，订阅挂上之前事件已经发过了（每个面板是独立 renderer，关掉即销毁）
    // → 主进程把载荷留在本窗口的 pending 槽，这里主动取一次，取完即清。
    const notesClient = ctx.clients?.notes
    if (notesClient && typeof notesClient.takeOpenView === 'function') {
      Promise.resolve(notesClient.takeOpenView())
        .then((payload) => { if (payload) content.applyOpenView(payload) })
        .catch(() => {})
    }

    // 面板被宿主销毁时收口（renderer 按面板隔离，不做跨面板复用）。
    const win = doc.defaultView
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', () => {
        if (typeof unsubscribe === 'function') unsubscribe()
        content.dispose()
      }, { once: true })
    }

    return {
      element: content.element,
      focusSearch: content.focusSearch,
      refresh: content.refresh
    }
  }
}

export const rendererPlugin = {
  panels: [panelDefinition]
}
