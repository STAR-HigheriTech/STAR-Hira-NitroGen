/**
 * AI 引擎 · 导出（PART15 §10：会话导出 / 审计导出）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件
 * ══════════════════════════════════════════════════════════════════════
 * 「投影 → 文本」是一段纯函数，跟引擎的状态机、IPC、模型都无关。放进 engine.cjs
 * 会让那个文件继续膨胀，也让"导出长什么样"散落在业务分支里。这里只有两件事：
 *   1. 把投影渲染成 md / json / csv；
 *   2. 弹保存框把文本写下去。
 * 不查库（数据由调用方给）、不 emit、不认识会话生命周期。
 */

const fs = require('fs/promises')
const { dialog } = require('electron')
const { projectMessages } = require('../core/store.cjs')

interface SessionMeta { id: string; title?: string }
interface MessageBlock { type?: string; text?: unknown; ref?: unknown; hidden?: boolean }
interface MessageRow { role?: string; blocks?: MessageBlock[]; name?: unknown; args?: unknown; result?: unknown; isError?: unknown }
interface AuditRow { createdAt?: unknown; sessionId?: unknown; toolName?: unknown; decision?: unknown; reason?: unknown; args?: unknown }
interface SessionStore { getSession(id: string): SessionMeta | null; listAllEvents(id: string): unknown[] }
interface AuditStore { listAudit(options: { limit?: number }): AuditRow[] }
interface ExporterLogger { warn?(...args: unknown[]): void }

/** 文本块拼成一段（隐藏的上下文块不导出 —— 那是给模型看的脚手架，不是对话内容）。 */
function visibleText(blocks: unknown): string {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block): block is MessageBlock => !!block && typeof block === 'object')
    .filter((block) => block.type === 'text' && block.text && !block.hidden)
    .map((block) => String(block.text))
    .join('\n')
}

function imageLines(blocks: unknown): string[] {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block): block is MessageBlock => !!block && typeof block === 'object')
    .filter((block) => block.type === 'image' && block.ref)
    .map((block) => (String(block.ref).startsWith('data:') ? '（图片已省略）' : `![图片](${String(block.ref)})`))
}

function fmtTime(ts: unknown): string {
  const d = new Date(Number(ts) || Date.now())
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function oneLine(value: unknown, limit: number = 600): string {
  let text
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch (_) { text = String(value) }
  text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 投影 → Markdown。工具调用按"一对"渲染：调用 + 结果（结果截断）。 */
function toMarkdown(session: SessionMeta, messages: MessageRow[]): string {
  const lines: string[] = []
  lines.push(`# ${session.title || '未命名会话'}`)
  lines.push('')
  lines.push(`> 导出于 ${fmtTime(Date.now())} · 会话 ${session.id}`)
  lines.push('')

  for (const m of messages) {
    if (m.role === 'user') {
      lines.push('## 我')
      lines.push('')
      if (m.blocks && m.blocks.length) lines.push(visibleText(m.blocks))
      const imgs = imageLines(m.blocks)
      if (imgs.length) lines.push('', ...imgs)
      lines.push('')
    } else if (m.role === 'assistant') {
      lines.push('## AI')
      lines.push('')
      const text = visibleText(m.blocks)
      if (text) lines.push(text)
      const imgs = imageLines(m.blocks)
      if (imgs.length) lines.push('', ...imgs)
      lines.push('')
    } else if (m.role === 'tool-call') {
      lines.push(`- 调用工具 \`${m.name || 'tool'}\`：\`${oneLine(m.args, 300)}\``)
    } else if (m.role === 'tool-result') {
      const flag = m.isError ? '失败' : '完成'
      lines.push(`  - ${flag}：\`${oneLine(m.result)}\``)
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function escapeCsv(value: unknown): string {
  const s = String(value == null ? '' : value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toAuditCsv(rows: AuditRow[]): string {
  const head = ['时间', '会话', '工具', '裁决', '原因', '参数']
  const body = rows.map((r) => [
    fmtTime(r.createdAt), r.sessionId || '', r.toolName || '', r.decision || '', r.reason || '', oneLine(r.args, 500)
  ].map(escapeCsv).join(','))
  return `\ufeff${[head.join(','), ...body].join('\r\n')}\r\n`
}

/** 文件名里的路径分隔符与保留字符要换掉，否则保存框会把它当目录。 */
function safeName(name: unknown, fallback: string): string {
  const base = String(name || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (base || fallback).slice(0, 80)
}

async function saveWithDialog({ content, defaultName, filters }: {
  content: string
  defaultName: string
  filters: Array<{ name: string; extensions: string[] }>
}) {
  const picked = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters,
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (!picked || picked.canceled || !picked.filePath) {
    return { ok: false, code: 'AI_EXPORT_CANCELED', message: '已取消导出' }
  }
  await fs.writeFile(picked.filePath, content, 'utf8')
  return { ok: true, path: picked.filePath }
}

/**
 * @param {{ logger?: any }} [deps]
 */
function createExporter({ logger = console }: { logger?: ExporterLogger } = {}) {
  /**
   * 会话导出。`format` 只影响文本形态；数据都来自同一份投影。
   * @param {{ getSession: Function, listAllEvents: Function }} store
   */
  async function session(store: SessionStore, sessionId: string, format: 'md' | 'json' = 'md') {
    const meta = store.getSession(sessionId)
    if (!meta) {
      const err = new Error('会话不存在') as Error & { code: string }
      err.code = 'AI_NO_SESSION'
      throw err
    }
    const events = store.listAllEvents(sessionId)
    const projected = projectMessages(events)
    const json = format === 'json'
    const content = json
      ? JSON.stringify({
        session: meta,
        exportedAt: Date.now(),
        messages: projected.messages,
        events
      }, null, 2)
      : toMarkdown(meta, projected.messages)
    const name = safeName(meta.title || sessionId, 'ai-session')
    try {
      return await saveWithDialog({
        content,
        defaultName: `${name}${json ? '.json' : '.md'}`,
        filters: json ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : '未知原因'
      logger.warn?.('[ai] 会话导出失败：', message)
      const err = new Error(`导出失败：${message}`) as Error & { code: string }
      err.code = 'AI_EXPORT_FAILED'
      throw err
    }
  }

  /** 审计导出：一次最多 5000 条（更早的审计意义有限，且不该拖住主进程）。 */
  async function audit(store: AuditStore, { format = 'csv', limit }: { format?: 'csv' | 'json'; limit?: number } = {}) {
    const rows = store.listAudit({ limit })
    const json = format === 'json'
    const content = json
      ? JSON.stringify({ exportedAt: Date.now(), items: rows }, null, 2)
      : toAuditCsv(rows)
    const stamp = fmtTime(Date.now()).replace(/[-:]/g, '').replace(' ', '-')
    try {
      return await saveWithDialog({
        content,
        defaultName: `ai-audit-${stamp}${json ? '.json' : '.csv'}`,
        filters: json ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'CSV', extensions: ['csv'] }]
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : '未知原因'
      logger.warn?.('[ai] 审计导出失败：', message)
      const err = new Error(`导出失败：${message}`) as Error & { code: string }
      err.code = 'AI_EXPORT_FAILED'
      throw err
    }
  }

  return { session, audit }
}

module.exports = { createExporter, toMarkdown, toAuditCsv, saveWithDialog }
