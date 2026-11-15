/**
 * 集锦面板的 Markdown 入口 —— **薄包装**。
 *
 * 解析器本体在 `@hira-ng/ui-common/src/markdown`：AI 面板与集锦面板要同一套
 * 转义 / 块级规则。两份各写必然漂移（一边补了围栏代码的语言标记，另一边还是老样子；
 * 更糟的是"某一边忘了转义"这种安全口径分叉），所以本体只此一份。
 *
 * 本文件只负责**集锦域独有的那一件事**：把正文里的 `hira-note://<id>`
 * （正文内联引用）画成可点 chip —— 切片段走共享真源 `splitNoteRefs`
 *（与域层抽边表**同一个正则**，见 shared-types/src/notes.mjs），
 * 目标标题由调用方经 `options.resolveRef` 提供（本文件是纯函数，不认识笔记库）。
 */

import { splitNoteRefs, plainTextSnippet } from '@hira-ng/shared-types/src/notes.mjs'
import { renderMarkdown as renderShared, escapeHtml } from '@hira-ng/ui-common/src/markdown'

// 摘要提取（去 Markdown 标记）已下沉到 shared-types：主进程的 `note:*` 动作
// 与面板必须用同一套规则（见 notes.mjs 的「展示 / 导出纯函数」段）。
// 这里原样转出，视图仍从 markdown 模块取，导入路径不变。
export { plainTextSnippet }

/**
 * Markdown → HTML 字符串（集锦语法：额外认 `hira-note://` 内联引用）。
 * @param {string} src
 * @param {{ resolveRef?: (id: string) => ({ title?: string|null, missing?: boolean }|null) }} [options]
 *   `resolveRef` 用来把正文里的引用 URI 画成带目标标题的 chip（拿不到目标 → 灰 chip）。
 * @returns {string}
 */
export function renderMarkdown(src: string, options?: { resolveRef?: (id: string) => ({ title?: string|null, missing?: boolean }|null) }) : string {
  const resolveRef = options && typeof options.resolveRef === 'function' ? options.resolveRef : null
  return renderShared(src, {
    splitRefs: splitNoteRefs,
    renderRef(refId) {
      const info = (resolveRef ? resolveRef(refId) : null) || {}
      const label = info.title ? String(info.title) : '引用'
      return `<span class="notes-panel__ref-chip${info.missing ? ' is-missing' : ''}"` +
        ` data-note-ref="${escapeHtml(refId)}" title="${escapeHtml(label)}">↩ ${escapeHtml(label)}</span>`
    }
  })
}
