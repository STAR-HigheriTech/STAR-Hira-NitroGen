/**
 * AI 面板 · 审批卡（PART15 §10.3）。
 *
 * 一条硬约束：**卡片是回合的唯一放行口**。用户不点，回合就停在 `approvals.request()` 里。
 * 因此这里不做"稍后处理"这类中间态 —— 只有三个出口：
 *   · 允许一次：只放行这一条，模式不变；
 *   · 始终允许：记住这个工具在当前站点的授权（落库，重启也免问）；
 *   · 拒绝。
 */

import { attach, h, icon, prettyJson } from './dom.js'
import { toolLabel } from './tool-card.js'

interface ApprovalCardPayload {
  approvalId: string
  toolName: string
  risk?: string
  site?: string
  hint?: string
  argsPreview?: unknown
}

const RISK_TEXT: Record<string, string> = Object.freeze({
  read: '只读',
  write: '会修改页面',
  destructive: '破坏性操作'
})

/**
 * @param {Document} doc
 * @param {any} payload `{ approvalId, sessionId, toolName, risk, site, hint, argsPreview }`
 * @param {{
 *   onResolve: (approvalId: string, decision: 'allow'|'deny', remember?: boolean) => void,
 *   onAlways: (approvalId: string) => void
 * }} handlers `onAlways` 由宿主实现完整语义：记住工具在当前站点的授权 + 放行本条。
 * @returns {HTMLElement}
 */
export function createApprovalCard(doc: Document, payload: ApprovalCardPayload, handlers: {
  onResolve: (approvalId: string, decision: 'allow'|'deny', remember?: boolean) => void,
  onAlways: (approvalId: string) => void
}) : HTMLElement {
  const card = h(doc, 'div', 'ai-approval')

  const title = h(doc, 'div', 'ai-approval__title')
  const glyph = icon(doc, 'Settings', 13)
  if (glyph) title.appendChild(glyph)
  title.appendChild(h(doc, 'span', '', `需要授权：${toolLabel(payload.toolName)}`))
  card.appendChild(title)

  const parts = []
  if (payload.risk) parts.push(RISK_TEXT[payload.risk] || payload.risk)
  if (payload.site) parts.push(payload.site === 'local' ? '本机页面' : payload.site)
  if (payload.hint) parts.push(String(payload.hint))
  if (parts.length) card.appendChild(h(doc, 'div', 'ai-approval__meta', parts.join(' · ')))

  if (payload.argsPreview !== undefined && payload.argsPreview !== null && payload.argsPreview !== '') {
    const pre = h(doc, 'pre', 'ai-tool__pre', prettyJson(payload.argsPreview, 800))
    card.appendChild(pre)
  }

  const actions = h(doc, 'div', 'ai-approval__actions')

  const deny: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-btn'))
  deny.type = 'button'
  deny.textContent = '拒绝'
  deny.addEventListener('click', () => handlers.onResolve(payload.approvalId, 'deny'))

  const allow: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-btn is-primary'))
  allow.type = 'button'
  allow.textContent = '允许一次'
  allow.title = '只放行这一条，下次调用这个工具仍会先询问'
  allow.addEventListener('click', () => handlers.onResolve(payload.approvalId, 'allow'))

  const always: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-btn is-success'))
  always.type = 'button'
  always.textContent = '始终允许'
  always.title = '记住这个工具在当前站点的授权（重启后也免问）'
  always.addEventListener('click', () => handlers.onAlways(payload.approvalId))

  attach(actions, deny, allow, always)
  card.appendChild(actions)
  card.appendChild(h(doc, 'div', 'ai-approval__hint', '仅记住这个工具在当前站点的授权；全局允许模式仍需在输入栏单独开启。'))
  return card
}
