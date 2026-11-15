/**
 * AI 面板 · 空态（一条会话还没有任何消息时占位）。
 *
 * 空态只做一件事：**给第一次使用的人三个能立刻点的动作**。
 * 它不发消息、不认识引擎 —— 点击一律上抛成动作 id，由面板决定"先采集再发送"。
 * 于是空态与 composer 的 `@` 菜单走同一条采集路径，不会出现"空态截的图没进上下文"。
 */

import { attach, h, icon } from './dom.js'

/** 快捷卡：`{ id, icon, title, hint }`。 */
const CARDS = Object.freeze([
  { id: 'summarize-page', icon: 'Sparkles', title: '总结当前页面', hint: '读取正在看的这一页，给出要点' },
  { id: 'explain-selection', icon: 'MessageSquare', title: '解释选中的文字', hint: '先在网页上选中一段再点这里' },
  { id: 'screenshot', icon: 'Camera', title: '截图提问', hint: '把当前视图截下来加进上下文' },
  { id: 'deep-research', icon: 'Search', title: '深度研究', hint: '多来源查证后给出结论' }
])

/**
 * @param {Document} doc
 * @param {{ onAction: (id: string) => void }} handlers
 * @returns {{ element: HTMLElement }}
 */
export function createEmptyState(doc: Document, handlers: { onAction: (id: string) => void }) : { element: HTMLElement } {
  const root = h(doc, 'div', 'ai-empty')

  root.appendChild(h(doc, 'div', 'ai-empty__title', '有什么可以帮你？'))
  root.appendChild(h(
    doc,
    'div',
    'ai-empty__text',
    '用 @ 引用页面、截图或文件，或在网页上右键发送选中内容。'
  ))

  for (const card of CARDS) {
    const btn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-empty__card'))
    btn.type = 'button'

    const glyph = h(doc, 'span', 'ai-empty__glyph')
    const svg = icon(doc, card.icon, 15)
    if (svg) glyph.appendChild(svg)
    else glyph.textContent = '·'

    const body = h(doc, 'span', 'ai-empty__body')
    body.appendChild(h(doc, 'span', 'ai-empty__card-title', card.title))
    body.appendChild(h(doc, 'span', 'ai-empty__hint', card.hint))

    attach(btn, glyph, body)
    btn.addEventListener('click', () => handlers.onAction(card.id))
    root.appendChild(btn)
  }

  return { element: root }
}
