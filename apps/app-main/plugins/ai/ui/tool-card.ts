/**
 * AI 面板 · 工具卡（流式与历史共用）。
 *
 * 折叠态只占一行：`[点] 工具名 … 状态`。展开才画参数/结果 ——
 * 目的是"让用户知道它在干什么"，而不是把模型看到的 JSON 全摊在聊天流里。
 * 流式与历史用**同一个** `updateToolCard`：两套画法必然漂移（历史里能展开，
 * 流式里展不开这种）。
 */

import { attach, h, prettyJson } from './dom.js'

/**
 * 卡片上一次渲染的签名。
 *
 * ⚠ 刻意用模块级 `WeakMap` 而不是往节点上挂 `__aiPart`：
 * 后者要写成 `(card).__aiPart = …` 这种「以括号开头的语句」，打包器会把它和上一行
 * 接成调用链（`card.appendChild(body)(card).__aiPart = …`），运行时抛
 * `card.appendChild(...) is not a function` —— 正是"这条内容没能渲染出来"的根因。
 * @type {WeakMap<HTMLElement, {signature: string, name: string}>}
 */
const CARD_STATE: WeakMap<HTMLElement, {signature: string, name: string}> = new WeakMap()

/** 工具名 → 人话（读不到就退回原始名，别让卡片变空）。 */
type ToolPartView = {
  name?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: string
}

const TOOL_LABEL: Record<string, string> = Object.freeze({
  tab_list: '读取标签页',
  tab_open: '打开页面',
  tab_switch: '切换标签',
  tab_close: '关闭标签',
  page_read: '读取页面',
  page_find: '页内查找',
  page_scroll: '滚动页面',
  page_click: '点击元素',
  page_type: '输入文字',
  page_screenshot: '页面截图',
  bookmark_search: '搜索书签',
  bookmark_add: '添加书签',
  history_search: '搜索历史',
  download_file: '下载文件',
  workspace_open: '选择本地工作区',
  workspace_list: '读取工作区列表',
  workspace_use: '切换本地工作区',
  workspace_current: '读取当前工作区',
  file_list: '浏览本地文件',
  file_search: '搜索本地文件',
  file_read: '读取本地文件',
  file_write: '写入本地文件',
  file_edit: '编辑本地文件',
  file_mkdir: '创建目录',
  file_move: '移动本地文件',
  file_delete: '删除本地文件',
  office_read: '读取办公文档',
  office_create_document: '创建 Word 文档',
  office_create_workbook: '创建 Excel 工作簿',
  office_create_presentation: '创建演示文稿',
  shell_run: '执行本地命令',
  // 上下文闸（不是工具，但审批卡与工具共用同一个渲染器）
  'context:page': '读取页面内容'
})

const STATUS_TEXT: Record<string, string> = Object.freeze({
  running: '执行中',
  ok: '完成',
  error: '失败'
})

export function toolLabel(name: unknown): string {
  const key = String(name || '')
  return TOOL_LABEL[key] || key || '工具'
}

/**
 * 建卡。返回的节点与渲染签名一起记进 `CARD_STATE`，供 `updateToolCard` 做增量。
 * @param {Document} doc
 * @param {any} part
 * @returns {HTMLElement}
 */
export function createToolCard(doc: Document, part: ToolPartView): HTMLElement {
  const card = h(doc, 'div', 'ai-tool')
  const head: HTMLButtonElement = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'ai-tool__head'))
  head.type = 'button'

  const dot = h(doc, 'span', 'ai-tool__dot')
  const name = h(doc, 'span', 'ai-tool__name')
  const spacer = h(doc, 'span', 'ai-tool__spacer')
  const status = h(doc, 'span', 'ai-tool__status')
  // 挂载一律走 attach（内部就是 appendChild）：`ParentNode.append` 在宿主的旧文档 /
  // 被替换过原型的节点上会缺失，抛出的 TypeError 会顺着 reconcile 把整次消息更新带崩。
  attach(head, dot, name, spacer, status)

  const body = h(doc, 'div', 'ai-tool__body')
  body.hidden = true

  head.addEventListener('click', () => { body.hidden = !body.hidden })

  attach(card, head, body)
  CARD_STATE.set(card, { signature: '', name: '' })
  updateToolCard(card, part)
  return card
}

/**
 * 就地更新（流式 result 到达 / 历史首帧）。
 * @param {HTMLElement} card
 * @param {any} part `{ name, args, result, isError, status }`
 */
export function updateToolCard(card: HTMLElement, part: ToolPartView): void {
  const prev = CARD_STATE.get(card)
  const signature = `${part.status}|${part.result === undefined ? 0 : 1}|${part.isError ? 1 : 0}`
  if (prev && prev.signature === signature && prev.name === (part.name || '')) return
  CARD_STATE.set(card, { signature, name: part.name || '' })

  const head = card.querySelector<HTMLElement>('.ai-tool__head')
  const dot = card.querySelector<HTMLElement>('.ai-tool__dot')
  const name = card.querySelector<HTMLElement>('.ai-tool__name')
  const status = card.querySelector<HTMLElement>('.ai-tool__status')
  const body = card.querySelector<HTMLElement>('.ai-tool__body')
  if (!head || !dot || !name || !status || !body) return

  const state = part.status || (part.isError ? 'error' : (part.result === undefined ? 'running' : 'ok'))
  name.textContent = toolLabel(part.name)
  name.title = part.name || ''
  dot.className = `ai-tool__dot${state === 'running' ? ' is-running' : state === 'error' ? ' is-error' : ' is-ok'}`
  status.textContent = STATUS_TEXT[state] || ''

  body.textContent = ''
  if (part.args !== undefined && part.args !== null) {
    body.appendChild(h(doc(card), 'div', 'ai-tool__label', '参数'))
    body.appendChild(h(doc(card), 'pre', 'ai-tool__pre', prettyJson(part.args, 1200)))
  }
  if (part.result !== undefined) {
    body.appendChild(h(doc(card), 'div', 'ai-tool__label', part.isError ? '错误' : '结果'))
    appendResult(doc(card), body, part)
  }
  if (!body.childNodes.length) {
    body.appendChild(h(doc(card), 'div', 'ai-tool__label', state === 'running' ? '等待结果…' : '（无输出）'))
  }
  // 失败默认展开：用户需要立刻知道为什么没成
  if (state === 'error') body.hidden = false
}

function appendResult(document: Document, body: HTMLElement, part: ToolPartView): void {
  const value = part.result
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!record) {
    body.appendChild(h(document, 'pre', 'ai-tool__pre', prettyJson(value, 2400)))
    return
  }

  const path = String(record.path || record.from || record.to || '')
  if (path) body.appendChild(h(document, 'div', 'ai-tool__meta', path))

  if (['file_write', 'file_edit', 'file_mkdir', 'file_move', 'file_delete', 'office_create_document', 'office_create_workbook', 'office_create_presentation'].includes(String(part.name || ''))) {
    const details = [
      record.replacements ? `${record.replacements} 处替换` : '',
      record.bytes ? `${record.bytes} 字节` : '',
      record.ok === true ? '已写入工作区' : ''
    ].filter(Boolean)
    if (details.length) body.appendChild(h(document, 'div', 'ai-tool__meta', details.join(' · ')))
    return
  }

  if (part.name === 'shell_run') {
    const command = [record.command, ...(Array.isArray(record.args) ? record.args : [])].filter(Boolean).join(' ')
    if (command) body.appendChild(h(document, 'div', 'ai-tool__meta mono', command))
    if (record.stdout) {
      body.appendChild(h(document, 'div', 'ai-tool__label', 'stdout'))
      body.appendChild(h(document, 'pre', 'ai-tool__pre', String(record.stdout).slice(0, 5000)))
    }
    if (record.stderr) {
      body.appendChild(h(document, 'div', 'ai-tool__label', record.ok === false ? '错误输出' : 'stderr'))
      body.appendChild(h(document, 'pre', 'ai-tool__pre', String(record.stderr).slice(0, 5000)))
    }
    return
  }

  if (part.name === 'file_read' && record.content) {
    body.appendChild(h(document, 'pre', 'ai-tool__pre', String(record.content).slice(0, 12_000)))
    return
  }

  if (part.name === 'office_read' && record.text) {
    body.appendChild(h(document, 'pre', 'ai-tool__pre', String(record.text).slice(0, 8000)))
    return
  }

  if (part.name === 'file_search' && Array.isArray(record.results)) {
    const list = h(document, 'div', 'ai-tool__meta')
    for (const item of record.results.slice(0, 20)) {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      list.appendChild(h(document, 'div', 'mono', String(row.path || '')))
    }
    body.appendChild(list)
    return
  }

  if (part.name === 'file_list' && Array.isArray(record.entries)) {
    const list = h(document, 'div', 'ai-tool__meta')
    for (const item of record.entries.slice(0, 40)) {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      list.appendChild(h(document, 'div', 'mono', `${row.type === 'dir' ? '▸' : '·'} ${String(row.path || '')}`))
    }
    body.appendChild(list)
    return
  }

  if (part.name === 'workspace_list' && Array.isArray(record.workspaces)) {
    const list = h(document, 'div', 'ai-tool__meta')
    for (const item of record.workspaces.slice(0, 20)) {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      list.appendChild(h(document, 'div', 'mono', `${String(row.name || '工作区')} · ${String(row.rootPath || '')}`))
    }
    body.appendChild(list)
    return
  }

  const summary = record.workspace && typeof record.workspace === 'object'
    ? record.workspace as Record<string, unknown>
    : record.cleared === true
      ? { name: '已解除工作区绑定' }
      : null
  if (summary) {
    body.appendChild(h(document, 'div', 'ai-tool__meta', String(summary.name || summary.rootPath || '工作区')))
    return
  }

  body.appendChild(h(document, 'pre', 'ai-tool__pre', prettyJson(value, 2400)))
}

/** 从节点所属的 document 取（面板可能在独立窗口，不能用全局 document）。 */
function doc(node: Node): Document {
  return node.ownerDocument || document
}
