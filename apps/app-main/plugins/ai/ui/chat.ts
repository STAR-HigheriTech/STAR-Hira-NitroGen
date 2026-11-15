/**
 * AI 面板 · 消息区（唯一读取 store 状态并画聊天的视图）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条渲染纪律（直接对应 §17 的性能红线）
 * ══════════════════════════════════════════════════════════════════════
 * 1. **只重建尾部**：消息是追加式的，已有节点的 key 序列是不变前缀。
 *    每次更新只从"第一个 key 不匹配处"截断并重建 —— 不整段 `innerHTML = ''`
 *    （那会让整个会话在每帧流式里重排一遍，滚动位置也会跳）。
 * 2. **流式不跑 Markdown**：token 到达时只改一个文本节点的 `data`；
 *    落库后的 assistant 消息才交给 `renderMarkdown`（一场对话里最多渲染一次）。
 * 3. **贴底才跟随**：用户往上翻时停止自动滚动，只亮"回到底部"按钮 ——
 *    读历史时被强行拽回底部是最让人恼火的一种"流畅"。
 *
 * 工具卡 / 审批卡 / chip 各自有实现（tool-card.js / approval-card.js / chips.js），
 * 本文件只负责"把它们按时间顺序摆进去"。
 */

import { attach, h, icon, iconButton } from './dom.js'
import { chipElement } from './chips.js'
import { createApprovalCard } from './approval-card.js'
import { createToolCard, updateToolCard } from './tool-card.js'
import { createEmptyState } from './empty-state.js'
import { copyText } from '../../../src/renderer/shared/clipboard'
import { renderMarkdown } from '@hira-ng/ui-common/src/markdown'
import type { AiApproval, AiContextItem, AiStreamSource, AiUiError, AiUiState } from './types.js'
import type { AiStore } from './store.js'

type ChatItem = {
  type: string
  key: string
  text?: string
  chips?: AiContextItem[]
  error?: AiUiError
  payload?: unknown
  reasoning?: string
  sources?: AiStreamSource[]
  name?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: string
  caret?: boolean
  steering?: boolean
  canRetry?: boolean
  label?: string
  [key: string]: unknown
}

interface ChatRenderable {
  node: HTMLElement
  apply(item: ChatItem): void
}

interface ChatRecord extends ChatRenderable {
  key: string
  kind: string
}

/** 距底多少像素以内视为"贴底"（比 0 宽容一点：最后一行的行高不该让人失去跟随）。 */
const STICK_THRESHOLD = 80

/**
 * 错误码 → 一句"该怎么办"。
 * 文案只在这里维护一份：引擎给 `code`，界面负责翻译；两边都不再各自拼措辞。
 */
const ERROR_HINT: Record<string, string> = Object.freeze({
  auth: '密钥无效或没有权限，请到设置里核对 API Key。',
  rate_limit: '请求太频繁，稍等一会儿再试。',
  overloaded: '服务端负载过高，稍后重试即可。',
  context_overflow: '上下文超出模型窗口，去掉一些引用或新开一个会话。',
  timeout: '响应超时，重试一次通常就好。',
  network: '网络连不上，检查代理或网络后重试。',
  server: '服务端出错，稍后重试。',
  bad_request: '请求被拒绝，检查模型名称与参数。',
  aborted: '已中止。',
  AI_NO_MODEL: '还没选模型，去设置里添加一个模型服务。',
  AI_NO_ENGINE: 'AI 引擎不可用（插件可能已禁用）。',
  AI_INTERNAL: '这轮执行遇到内部异常，已保留进度。重试一次通常可以继续。',
  AI_EXPORT_CANCELED: '已取消导出。'
})

/** 消息里的块 → 可见文本（`hidden` 是引擎包裹的上下文，不属于用户输入）。 */
function textOfBlocks(blocks: unknown): string {
  const list = Array.isArray(blocks) ? blocks : []
  return list
    .filter((block): block is { type: string; hidden?: boolean; text?: unknown } => !!block && typeof block === 'object')
    .filter((block) => block.type === 'text' && !block.hidden && block.text)
    .map((block) => String(block.text))
    .join('\n\n')
}

/** chip 列表的廉价签名（同一组引用不重复重建 DOM）。 */
function chipsSignature(items: unknown): string {
  const list = Array.isArray(items) ? items : []
  return list.map((c) => {
    const item = c && typeof c === 'object' ? c as Record<string, unknown> : {}
    const p = item.payload && typeof item.payload === 'object' ? item.payload as Record<string, unknown> : {}
    return `${item.kind || ''}|${item.url || p.url || ''}|${p.path || ''}|${p.name || ''}|${String(p.text || '').slice(0, 24)}`
  }).join('~')
}

/** 历史消息里的推理块 → 可见文本（`{text, field, signature}`；兼容纯字符串）。 */
function reasoningTextOf(reasoning: unknown): string {
  if (!reasoning) return ''
  if (typeof reasoning === 'string') return reasoning.trim()
  const value = reasoning as { text?: unknown }
  return String(value.text || '').trim()
}

/** 能画出来的来源（只留 http/https；标题缺省回落到地址）。 */
function usableSources(sources: unknown): AiStreamSource[] {
  return (Array.isArray(sources) ? sources : [])
    .filter((source): source is Record<string, unknown> => !!source && typeof source === 'object')
    .filter((source) => /^https?:\/\//i.test(String(source.url || '')))
    .map((source) => ({
      title: String(source.title || source.url || ''),
      url: String(source.url),
      kind: String(source.kind || 'page')
    }))
}

/**
 * 「思考过程」折叠块（深度思考才出现）。
 *
 * 历史消息默认**收起**（一段回答前堵一大坨推理很吵），流式时默认**展开**
 * （用户要看到"它正在想什么"）。字数只作摘要，不解析推理内容。
 */
function createReasoningBlock(doc: Document, opts: { stream?: boolean; open?: boolean } = {}) {
  const node = h(doc, 'details', `ai-reasoning${opts.stream ? ' ai-reasoning--stream' : ''}`)
  node.open = !!opts.open
  node.hidden = true
  const summary = h(doc, 'summary', 'ai-reasoning__summary')
  summary.appendChild(h(doc, 'span', 'ai-reasoning__title', opts.stream ? '正在思考' : '思考过程'))
  const meta = h(doc, 'span', 'ai-reasoning__meta', '')
  summary.appendChild(meta)
  const body = h(doc, 'div', 'ai-reasoning__body')
  const data = doc.createTextNode('')
  body.appendChild(data)
  node.appendChild(summary)
  node.appendChild(body)
  let last = ''
  return {
    node,
    apply(value: unknown) {
      const text = String(value || '')
      if (text === last) return
      last = text
      node.hidden = !text
      if (data.data !== text) data.data = text
      meta.textContent = text ? `${text.length} 字` : ''
    }
  }
}

/** 单条来源：整行可点（跳回原页面 / 无标签时新开）。 */
function sourceRow(doc: Document, item: AiStreamSource, onReveal?: (url: string) => void): HTMLButtonElement {
  const row = h(doc, 'button', 'ai-sources__item')
  row.type = 'button'
  row.title = item.url
  row.appendChild(h(doc, 'span', 'ai-sources__name', item.title || item.url))
  let host = ''
  try { host = new URL(item.url).hostname.replace(/^www\./, '') } catch (_) { /* 非法地址就不显示域名 */ }
  if (host) row.appendChild(h(doc, 'span', 'ai-sources__host', host))
  row.addEventListener('click', () => { if (typeof onReveal === 'function') onReveal(item.url) })
  return row
}

/** 「参考来源」列表（本回合联网检索 / 读页的执行事实，不是模型自述）。 */
function createSourcesBlock(doc: Document, onReveal?: (url: string) => void) {
  const node = h(doc, 'div', 'ai-sources')
  node.hidden = true
  const title = h(doc, 'div', 'ai-sources__title', '参考来源')
  const list = h(doc, 'div', 'ai-sources__list')
  node.appendChild(title)
  node.appendChild(list)
  let sig = ''
  return {
    node,
    apply(sources: unknown) {
      const items = usableSources(sources)
      const next = items.map((s) => s.url).join('|')
      if (next === sig) return
      sig = next
      list.textContent = ''
      node.hidden = !items.length
      for (const item of items) list.appendChild(sourceRow(doc, item, onReveal))
    }
  }
}

/**
 * 把 store 状态摊平成"要画的一行行"。
 * 历史消息与流式片段共用同一套节点类型 —— 用户看不出哪段已经落库。
 * @param {any} state
 */
function buildItems(state: AiUiState): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ChatItem>()

  if (state.unavailable) {
    items.push({ type: 'error', key: `unavailable:${state.unavailable.code || ''}`, error: state.unavailable })
  }

  for (const m of Array.isArray(state.messages) ? state.messages : []) {
    if (!m) continue
    if (m.role === 'user') {
      const text = textOfBlocks(m.blocks)
      const chips = Array.isArray(m.context) ? m.context : []
      if (!text && !chips.length) continue
      items.push({ type: 'user', key: `u${m.seq}`, text, chips })
    } else if (m.role === 'assistant') {
      const text = textOfBlocks(m.blocks)
      const reasoning = reasoningTextOf(m.reasoning)
      const sources = usableSources(m.sources)
      // 纯工具步的 assistant（只有推理 / 只有来源）同样要画：思考过程与来源
      // 是用户明确要求的"透明可视化"，不能因为没正文就被丢掉。
      if (!text && !reasoning && !sources.length) continue
      items.push({ type: 'assistant', key: `a${m.seq}`, text, reasoning, sources })
    } else if (m.role === 'tool-call') {
      const id = m.id ? String(m.id) : ''
      const existing = id ? tools.get(id) : null
      if (existing) {
        existing.name = m.name || existing.name
        existing.args = m.args !== undefined ? m.args : existing.args
        continue
      }
      const item = {
        type: 'tool',
        key: `t${m.id || m.seq}`,
        id,
        name: m.name,
        args: m.args,
        status: 'running'
      }
      if (m.id) tools.set(m.id, item)
      items.push(item)
    } else if (m.role === 'tool-result') {
      const existing = m.id ? tools.get(m.id) : null
      if (existing) {
        existing.result = m.result
        existing.isError = !!m.isError
        existing.status = m.isError ? 'error' : 'ok'
      } else {
        const item = {
          type: 'tool',
          key: `t${m.id || m.seq}`,
          id: m.id ? String(m.id) : '',
          name: m.name,
          args: null,
          result: m.result,
          isError: !!m.isError,
          status: m.isError ? 'error' : 'ok'
        }
        if (item.id) tools.set(item.id, item)
        items.push(item)
      }
    }
  }

  if (state.pendingUser) {
    items.push({
      type: 'user',
      key: 'pending',
      text: state.pendingUser.text,
      chips: state.pendingUser.chips || [],
      steering: !!(state.pendingUser.steering)
    })
  }

  const stream = state.streaming
  if (stream) {
    const parts = Array.isArray(stream.parts) ? stream.parts : []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!part) continue
      if (part.type === 'text') {
        items.push({
          type: 'stream',
          key: part.key,
          text: part.text,
          caret: !stream.done && i === parts.length - 1
        })
      } else if (part.type === 'reasoning') {
        // 思考过程按到达顺序占位（可能在工具卡之前），默认展开 —— 正在想就要看得见。
        items.push({ type: 'reasoning', key: part.key, text: part.text })
      } else {
        const id = part.id ? String(part.id) : ''
        const existing = id ? tools.get(id) : null
        if (existing) {
          existing.name = part.name || existing.name
          existing.args = part.args !== undefined ? part.args : existing.args
          existing.result = part.result
          existing.isError = !!part.isError
          existing.status = part.status || (part.isError ? 'error' : (part.result === undefined ? 'running' : 'ok'))
        } else {
          const item = { ...part, type: 'tool', key: part.key }
          if (id) tools.set(id, item)
          items.push(item)
        }
      }
    }
    // 工具一返回来源就登记在 streaming.sources 上：先于最终答案出现在界面上。
    const streamSources = usableSources(stream.sources)
    if (streamSources.length) items.push({ type: 'sources', key: 'stream:sources', sources: streamSources })
    if (!parts.length && !stream.done && !streamSources.length) items.push({ type: 'thinking', key: 'thinking', label: '正在思考…' })
  }

  for (const approval of Array.isArray(state.approvals) ? state.approvals : []) {
    if (!approval || !approval.approvalId) continue
    if (approval.sessionId && approval.sessionId !== state.sessionId) continue
    items.push({ type: 'approval', key: `ap:${approval.approvalId}`, payload: approval })
  }

  if (state.error && !state.unavailable) {
    items.push({ type: 'error', key: `err:${state.error.message}`, error: state.error })
  }

  // 重生成：只在「最后一条 assistant + 当前没有回合在跑 + 没有未完片段」时出现。
  // 重试复用最后一条用户消息（引擎侧按 `retryOf` 作废旧输出），所以只给最后一条。
  const running = !!(state.sessionId && state.running && state.running.has(state.sessionId))
  if (!running && !stream && !state.pendingUser) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === 'approval' || items[i].type === 'error') continue
      if (items[i].type === 'assistant') items[i].canRetry = true
      break
    }
  }

  return items
}

/**
 * @param {Document} doc
 * @param {{
 *   store: any,
 *   onQuickAction?: (id: string) => void,
 *   onAtBottomChange?: (atBottom: boolean) => void
 * }} deps
 */
export function createChat(doc: Document, deps: {
  store: AiStore,
  onQuickAction?: (id: string) => void,
  onAtBottomChange?: (atBottom: boolean) => void
}) {
  const { store } = deps

  /** 已发送消息里的引用 chip 点一下 → 跳回原页面（切标签或新开）。 */
  const revealChip = (url: unknown): void => { store.revealSource(url) }

  /**
   * 消息下方的「复制」按钮 —— 用户消息 / AI 消息 / 流式片段共用这一份实现。
   *
   * 为什么自带 `getText` 而不是在点击时读 DOM：流式片段只改一个文本节点，
   * 读 DOM 会把渲染过程带进剪贴板路径；这里各自闭包自己那份"当前文本"。
   * 复制结果就地反馈（「已复制」1.4s），不弹全局提示 —— 连续复制多条时提示条很吵。
   *
   * @param {() => string} getText
   */
  function createCopyControl(getText: () => string) {
    const btn = h(doc, 'button', 'ai-msg__action ai-msg__action--copy')
    btn.type = 'button'
    btn.title = '复制这条内容'
    btn.setAttribute('aria-label', '复制')
    const glyph = icon(doc, 'Copy', 13)
    if (glyph) btn.appendChild(glyph)
    const label = h(doc, 'span', 'ai-msg__action-label', '复制')
    btn.appendChild(label)

    let timer = 0
    const flash = (text: string, done: boolean): void => {
      label.textContent = text
      btn.classList.toggle('is-done', !!done)
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => {
        label.textContent = '复制'
        btn.classList.remove('is-done')
        timer = 0
      }, 1400)
    }

    btn.addEventListener('click', async () => {
      const text = getText()
      if (!text) return
      const ok = await copyText(text, doc)
      flash(ok ? '已复制' : '复制失败', ok)
    })
    return btn
  }

  const element = h(doc, 'div', 'ai-chat')
  const inner = h(doc, 'div', 'ai-chat__inner')
  element.appendChild(inner)

  const empty = createEmptyState(doc, {
    onAction: (id) => { if (typeof deps.onQuickAction === 'function') deps.onQuickAction(id) }
  })
  inner.appendChild(empty.element)

  /** @type {Array<{ key: string, kind: string, node: HTMLElement, apply: (item: any) => void }>} */
  let records: ChatRecord[] = []
  /** 用户是否在贴底位置（决定要不要跟随新内容）。 */
  let stick = true
  let lastReported = true

  function isAtBottom() {
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight
    return gap <= STICK_THRESHOLD
  }

  function report(atBottom = isAtBottom()) {
    if (atBottom === lastReported) return
    lastReported = atBottom
    if (typeof deps.onAtBottomChange === 'function') deps.onAtBottomChange(atBottom)
  }

  element.addEventListener('scroll', () => {
    stick = isAtBottom()
    report(stick)
  }, { passive: true })

  // ── 各类节点的构造器：返回壳子，内容由 apply 填（首次与更新走同一条路径）──
  function createUser(): ChatRenderable {
    const node = h(doc, 'div', 'ai-msg ai-msg--user')
    const chipsBox = h(doc, 'div', 'ai-chips')
    chipsBox.hidden = true
    const bubble = h(doc, 'div', 'ai-msg__bubble')
    const text = h(doc, 'div', 'ai-msg__text')
    bubble.appendChild(text)
    // 「回合进行中追加的一句」—— 与普通消息只差一行提示，复用同一套气泡
    const meta = h(doc, 'div', 'ai-msg__meta', '追加中…')
    meta.hidden = true
    const actions = h(doc, 'div', 'ai-msg__actions')
    actions.appendChild(createCopyControl(() => text.textContent || ''))
    attach(node, chipsBox, bubble, meta, actions)
    let signature = ''

    return {
      node,
      apply(item: ChatItem) {
        const next = String(item.text || '')
        if (text.textContent !== next) text.textContent = next
        bubble.hidden = !next
        // 只有引用 chip、没有文字时没什么可复制的，别留一个点了没反应的按钮
        actions.hidden = !next

        const steering = !!item.steering
        if (meta.hidden === steering) meta.hidden = !steering

        const sig = chipsSignature(item.chips)
        if (sig === signature) return
        signature = sig
        chipsBox.textContent = ''
        for (const chip of Array.isArray(item.chips) ? item.chips : []) {
          chipsBox.appendChild(chipElement(doc, chip, null, revealChip))
        }
        chipsBox.hidden = !chipsBox.childNodes.length
      }
    }
  }

  function createAssistant(): ChatRenderable {
    const node = h(doc, 'div', 'ai-msg ai-msg--assistant')
    const bubble = h(doc, 'div', 'ai-msg__bubble')
    // 顺序 = 阅读顺序：思考过程（可折叠）→ 回答正文 → 参考来源 → 操作。
    const reasoning = createReasoningBlock(doc, { open: false })
    bubble.appendChild(reasoning.node)
    const body = h(doc, 'div', 'ai-msg__body')
    bubble.appendChild(body)
    const sources = createSourcesBlock(doc, revealChip)
    bubble.appendChild(sources.node)
    const actions = h(doc, 'div', 'ai-msg__actions')
    /** @type {string|null} */
    let rendered: string|null = null
    // 复制常驻（AI 输出最常见的动作）；重生成只给最后一条
    actions.appendChild(createCopyControl(() => rendered || ''))
    const regen = iconButton(doc, {
      iconName: 'RefreshCw',
      label: '重新生成',
      className: 'ai-msg__action',
      size: 13,
      onClick: () => { store.retry() }
    })
    regen.hidden = true
    actions.appendChild(regen)
    bubble.appendChild(actions)
    node.appendChild(bubble)

    return {
      node,
      apply(item: ChatItem) {
        const next = String(item.text || '')
        if (next !== rendered) {
          rendered = next
          body.innerHTML = renderMarkdown(next)
        }
        // 只有推理的回合没有正文：气泡不能留一块空白。
        body.hidden = !next
        reasoning.apply(item.reasoning)
        sources.apply(item.sources)
        const canRetry = !!item.canRetry
        if (regen.hidden === canRetry) regen.hidden = !canRetry
      }
    }
  }

  function createStream(): ChatRenderable {
    const node = h(doc, 'div', 'ai-msg ai-msg--assistant')
    const bubble = h(doc, 'div', 'ai-msg__bubble')
    const textEl = h(doc, 'div', 'ai-msg__text')
    // 文本节点与光标是**兄弟**：更新只写 data，不重建元素（不引起重排）
    const data = doc.createTextNode('')
    const caret = h(doc, 'span', 'ai-msg__caret')
    attach(textEl, data, caret)
    bubble.appendChild(textEl)
    // 流式中也能复制"当前已有的一段"（不必等落库）
    const actions = h(doc, 'div', 'ai-msg__actions')
    actions.appendChild(createCopyControl(() => data.data || ''))
    bubble.appendChild(actions)
    node.appendChild(bubble)
    let lastCaret = true

    return {
      node,
      apply(item: ChatItem) {
        const next = String(item.text || '')
        if (data.data !== next) data.data = next
        actions.hidden = !next
        const show = !!item.caret
        if (show !== lastCaret) {
          lastCaret = show
          caret.hidden = !show
        }
      }
    }
  }

  function createTool(item: ChatItem): ChatRenderable {
    const node = createToolCard(doc, item)
    return { node, apply(part: ChatItem) { updateToolCard(node, part) } }
  }

  function createThinking(): ChatRenderable {
    const node = h(doc, 'div', 'ai-msg ai-msg--assistant')
    const row = h(doc, 'div', 'ai-msg__meta')
    row.appendChild(h(doc, 'span', 'ai-msg__caret'))
    const label = h(doc, 'span', '', '正在思考…')
    row.appendChild(label)
    node.appendChild(row)
    return {
      node,
      apply(item) {
        const next = String(item.label || '正在思考…')
        if (label.textContent !== next) label.textContent = next
      }
    }
  }

  function createApproval(item: ChatItem): ChatRenderable {
    const node = createApprovalCard(doc, item.payload as AiApproval, {
      onResolve: (approvalId, decision) => store.resolveApproval(approvalId, decision),
      // 「始终允许」= 记住这个工具（落库，重启也免问）+ 把模式切到 allow + 放行本条。
      onAlways: (approvalId) => store.allowAlways(approvalId)
    })
    return { node, apply() { /* 同一 approvalId 的内容不可变 */ } }
  }

  function createError(item: ChatItem): ChatRenderable {
    const node = h(doc, 'div', 'ai-error')
    const glyph = icon(doc, 'XCircle', 14)
    if (glyph) node.appendChild(glyph)
    const main = h(doc, 'div', 'ai-error__main')
    const text = h(doc, 'div', 'ai-error__text')
    const hint = h(doc, 'div', 'ai-error__hint')
    attach(main, text, hint)
    node.appendChild(main)

    // 「重试」只在引擎标了 `retryable`（超时 / 限流 / 5xx）时出现 —— 认证错重试也没用
    const retryBtn: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-error__retry', '重试'))
    retryBtn.type = 'button'
    retryBtn.hidden = true
    retryBtn.addEventListener('click', () => { store.retry() })
    node.appendChild(retryBtn)

    const close = iconButton(doc, {
      iconName: 'X',
      label: '关闭',
      className: 'ai-error__close',
      size: 12,
      onClick: () => store.dismissError()
    })
    node.appendChild(close)

    function paint(error: AiUiError | undefined): void {
      const code = String((error && error.code) || '')
      const message = String((error && error.message) || '出错了')
      if (text.textContent !== message) text.textContent = message
      const line = ERROR_HINT[code] || ''
      if (hint.textContent !== line) hint.textContent = line
      hint.hidden = !line
      const canRetry = !!(error && error.retryable)
      if (retryBtn.hidden === canRetry) retryBtn.hidden = !canRetry
    }
    paint(item.error)

    return {
      node,
      apply(next: ChatItem) { paint(next.error) }
    }
  }

  /** @param {any} item */
  function makeRecord(item: ChatItem): ChatRecord {
    switch (item.type) {
      case 'user': return { key: item.key, kind: item.type, ...createUser() }
      case 'assistant': return { key: item.key, kind: item.type, ...createAssistant() }
      case 'stream': return { key: item.key, kind: item.type, ...createStream() }
      case 'tool': return { key: item.key, kind: item.type, ...createTool(item) }
      case 'thinking': return { key: item.key, kind: item.type, ...createThinking() }
      case 'approval': return { key: item.key, kind: item.type, ...createApproval(item) }
      case 'reasoning': {
        // 流式推理：默认展开，跟 token 一起长；落库后由 assistant 气泡接管。
        const block = createReasoningBlock(doc, { open: true, stream: true })
        return { key: item.key, kind: item.type, node: block.node, apply: (it) => block.apply(it.text) }
      }
      case 'sources': {
        const block = createSourcesBlock(doc, revealChip)
        return { key: item.key, kind: item.type, node: block.node, apply: (it) => block.apply(it.sources) }
      }
      default: return { key: item.key, kind: item.type, ...createError(item) }
    }
  }

  /**
   * 只重建尾部：已有节点是"key 不变的前缀"。
   * @param {any[]} items
   */
  function reconcile(items: ChatItem[]): void {
    let i = 0
    for (; i < records.length; i++) {
      const rec = records[i]
      const item = items[i]
      if (!item || item.key !== rec.key || item.type !== rec.kind) break
    }

    for (let j = records.length - 1; j >= i; j--) {
      const rec = records[j]
      if (rec.node.parentNode === inner) inner.removeChild(rec.node)
    }
    if (records.length > i) records.length = i

    for (; i < items.length; i++) {
      const item = items[i]
      // 单条内容画不出来**不能**中断整次 reconcile：records 与 items 的下标一旦错开，
      // 之后每一帧都会从这里抛错，消息流看起来就是"永远停在原地不更新"。
      let rec: ChatRecord
      try {
        rec = makeRecord(item)
      } catch (e) {
        console.error('[ai-panel] 消息渲染失败：', e)
        rec = createFallback(item, e)
      }
      inner.appendChild(rec.node)
      records.push(rec)
      try { rec.apply(item) } catch (e) { console.error('[ai-panel] 消息渲染失败：', e) }
    }
  }

  /** 渲染失败时的占位（保持下标对齐；内容不可变，后续帧不再重试以免刷屏）。 */
  function createFallback(item: ChatItem, error: unknown): ChatRecord {
    const node = h(doc, 'div', 'ai-error')
    const main = h(doc, 'div', 'ai-error__main')
    main.appendChild(h(doc, 'div', 'ai-error__text', '这条内容没能渲染出来'))
    const reason = error instanceof Error ? error.message : ''
    if (reason) main.appendChild(h(doc, 'div', 'ai-error__hint', reason))
    node.appendChild(main)
    return { key: item.key, kind: item.type, node, apply() {} }
  }

  function scrollToBottom() {
    stick = true
    element.scrollTop = element.scrollHeight
    report(true)
  }

  /** 距底距离（独立窗口重新挂载时用它还原阅读位置）。 */
  function anchor() {
    return Math.max(0, element.scrollHeight - element.scrollTop)
  }

  function restoreAnchor(value: unknown): void {
    const n = Number(value) || 0
    element.scrollTop = Math.max(0, element.scrollHeight - n)
    stick = isAtBottom()
    report(stick)
  }

  /**
   * @param {any} state
   */
  function update(state: AiUiState): void {
    const items = buildItems(state)
    reconcile(items)
    for (let i = 0; i < records.length; i++) {
      try { records[i].apply(items[i]) } catch (e) { console.error('[ai-panel] 消息更新失败：', e) }
    }
    empty.element.hidden = items.length > 0
    if (stick) {
      element.scrollTop = element.scrollHeight
      report(true)
    }
  }

  function dispose() {
    records = []
    if (element.parentNode) element.parentNode.removeChild(element)
  }

  return {
    element,
    update,
    scrollToBottom,
    anchor,
    restoreAnchor,
    get scrollTop() { return element.scrollTop },
    dispose
  }
}
