/**
 * AI 引擎 · 记忆类工具（PART15 §10.1「收藏自动摘要」）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么摘要由 AI 生成、但**落库**在收藏域
 * ══════════════════════════════════════════════════════════════════════
 * 收藏的 `summary / summaryAt` 是 domain-bookmark 的字段（书签页、搜索、导出都在读）。
 * 这里只做三件事：取正文 → 让模型压成一段 → 调域服务写回。
 * 不新建"AI 记忆表"：同一份摘要存两处，必然出现"AI 那边有、收藏页看不到"。
 *
 * 三条边界：
 *   · **已有摘要不重写**（除非 force）：摘要不是每次都要重算的消耗品；
 *   · **单次条数很少**（默认 2、上限 5）：每条一次网络取页 + 一次模型调用，
 *     多给会让"补摘要"变成一次几十秒的静默等待；
 *   · **失败只记原因**：单条取页失败 / 正文过短，不影响同批其它条目。
 */

const { fetchPage } = require('./fetch-page.cjs')

import type { Bookmark, BookmarkTreeNode } from '@hira-ng/domain-bookmark'
import type { BookmarkService } from '../../service-contracts'
import type { AiToolContext, AiToolDefinition, AiToolHost, JsonSchema, ToolArgs } from '../types'

/** 单次最多处理几条（每条 = 一次取页 + 一次模型调用）。 */
const MAX_ITEMS = 5
const DEFAULT_ITEMS = 2
/** 送进模型的正文上限（摘要不需要全文，1.2 万字足够判断"这一页讲什么"）。 */
const PROMPT_CHARS = 12000
/** 正文低于这个长度就不调用模型 —— 摘要一段导航条没有意义。 */
const MIN_CHARS = 200
/** 摘要落库上限（域层也会归一化，这里先收一次，避免模型写长文）。 */
const SUMMARY_LIMIT = 400

const SYSTEM_PROMPT = [
  '你是浏览器的收藏摘要助手。请阅读网页正文，为收藏夹写一段"日后能凭它想起这一页"的摘要。',
  '要求：',
  '· 60–120 字，一到三句话：先说这一页是什么，再说最值得记住的点；',
  '· 只陈述正文里的事实，不评价、不编造、不写"本文"开头的套话；',
  '· 正文不足或没有实质内容时，只回：正文过短，无法摘要；',
  '· 直接输出摘要正文，不要前缀，不要 Markdown，不要引号。'
].join('\n')

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

function clip(text: unknown, max: number): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 整棵书签树 → 扁平数组（文件夹也保留，调用方自己按 url 过滤）。 */
type FlatBookmark = BookmarkTreeNode & { depth: number }

function flatten(nodes: unknown, depth = 0): FlatBookmark[] {
  const out: FlatBookmark[] = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue
    const bookmarkNode = node as BookmarkTreeNode
    out.push({ ...bookmarkNode, depth })
    if (Array.isArray(bookmarkNode.children) && bookmarkNode.children.length) {
      out.push(...flatten(bookmarkNode.children, depth + 1))
    }
  }
  return out
}

/**
 * @param {{
 *   getServices?: () => any,
 *   complete?: Function
 * }} host
 */
function createMemoryTools(host: AiToolHost): AiToolDefinition[] {
  const getServices = host.getServices || (() => ({}))
  const complete = host.complete

  function bookmarkPort() {
    const svc = (getServices() || {}).bookmarkService
    if (!svc || typeof svc.get !== 'function' || typeof svc.update !== 'function') {
      throw new Error('收藏服务不可用')
    }
    return svc
  }

  /** 按 ids / scope 挑出这一批要处理的收藏。 */
  async function pickTargets(
    svc: BookmarkService,
    args: ToolArgs,
    limit: number
  ): Promise<{ rows: Bookmark[]; missing: number }> {
    const ids = Array.isArray(args.ids)
      ? args.ids.map((x) => String(x || '').trim()).filter(Boolean)
      : (args.id ? [String(args.id).trim()] : [])

    if (ids.length) {
      const rows: Bookmark[] = []
      for (const id of ids.slice(0, limit)) {
        const row = typeof svc.get === 'function' ? svc.get(id) : null
        if (row) rows.push(row)
      }
      return { rows, missing: ids.length - rows.length }
    }

    const tree = typeof svc.tree === 'function' ? svc.tree() : []
    const links = flatten(tree).filter((node) => node.url && /^https?:\/\//i.test(String(node.url)))
    const scope = String(args.scope || 'missing')
    const pool = scope === 'recent'
      ? links.slice().sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      : links
    const wanted = args.force ? pool : pool.filter((n) => !n.summary)
    return { rows: wanted.slice(0, limit), missing: 0 }
  }

  /** 一条收藏：取页 → 摘要 → 写回。任何一步失败都只是"这一条跳过"。 */
  async function digestOne(
    svc: BookmarkService,
    row: Bookmark,
    { force, sessionId }: { force: boolean; sessionId: string }
  ) {
    const base = { id: row.id, title: row.title || '', url: row.url || '' }
    if (row.summary && !force) return { ...base, skipped: '已有摘要（如需重写传 force: true）' }

    const page = await fetchPage(row.url, { maxChars: PROMPT_CHARS, maxLinks: 0 })
    if (!page || !page.ok) return { ...base, skipped: `取页失败：${(page && page.reason) || 'unknown'}` }

    const body = String(page.text || '').trim()
    if (body.length < MIN_CHARS) return { ...base, skipped: '正文过短，无法摘要' }
    if (typeof complete !== 'function') return { ...base, skipped: '模型调用不可用（尚未配置模型服务）' }

    const res = await complete({
      sessionId,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        blocks: [{ type: 'text', text: `标题：${row.title || page.title || '(无标题)'}\n地址：${row.url}\n\n${body}` }]
      }],
      maxOutputTokens: 500
    })

    const summary = clip(res && res.text, SUMMARY_LIMIT)
    if (!summary) return { ...base, skipped: '模型没有返回摘要' }
    if (/正文过短，无法摘要/.test(summary)) return { ...base, skipped: '正文过短，无法摘要' }

    svc.update(row.id, { summary })
    return { ...base, summary }
  }

  const tools: AiToolDefinition[] = [
    {
      name: 'bookmark_digest',
      description: [
        '为收藏生成 AI 摘要（写入收藏的"摘要"字段，收藏页会直接显示）。',
        '默认只处理"还没有摘要"的收藏；传 ids 或 id 可指定条目；force=true 重写已有摘要。',
        '每条都要联网取页 + 调用一次模型，所以一次最多 5 条（默认 2 条）。'
      ].join(' '),
      parameters: obj({
        id: { type: 'string', description: '单条收藏 id' },
        ids: { type: 'array', items: { type: 'string' }, description: '多条收藏 id' },
        scope: { type: 'string', enum: ['missing', 'recent'], description: 'missing=还缺摘要的（默认）；recent=最近收藏的' },
        limit: { type: 'number', description: '本次最多处理几条（默认 2，上限 5）' },
        force: { type: 'boolean', description: '重写已有摘要' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const a = args
        const svc = bookmarkPort()
        const limit = Math.min(Math.max(Math.round(Number(a.limit) || DEFAULT_ITEMS), 1), MAX_ITEMS)
        const { rows, missing } = await pickTargets(svc, a, limit)

        if (!rows.length) {
          return { ok: true, total: 0, items: [], hint: '没有需要处理的收藏（都已有摘要，或用 force: true 重写）' }
        }

        const items: Array<Record<string, unknown>> = []
        for (const row of rows) {
          try {
            items.push(await digestOne(svc, row, { force: !!a.force, sessionId: (ctx && ctx.sessionId) || '' }))
          } catch (e) {
            items.push({
              id: row.id, title: row.title || '', url: row.url || '',
              skipped: e instanceof Error ? e.message : '处理失败'
            })
          }
        }

        const done = items.filter((item) => !!item.summary).length
        const hints: string[] = []
        if (missing > 0) hints.push(`有 ${missing} 条 id 找不到对应收藏`)
        if (done < items.length) hints.push('没成功的条目看 skipped 原因；可再次调用继续补')
        if (!a.force && done && done === items.length) hints.push('如需继续补后面的收藏，再调用一次即可')
        return {
          ok: true,
          total: items.length,
          digested: done,
          skipped: items.length - done,
          items,
          ...(hints.length ? { hint: hints.join('；') } : {})
        }
      }
    }
  ]
  return tools
}

module.exports = { createMemoryTools }
