/**
 * AI 引擎 · 技能纯逻辑（PART15 §11 Phase 5）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三类技能，一套解析
 * ══════════════════════════════════════════════════════════════════════
 *   prompt —— 模板插入输入框；`{{page}}` 之类占位符由**上下文 chip** 承载
 *   script —— 在页面的**只读快照**上跑一段脚本，结果回填成 text chip
 *   agent  —— 与 prompt 同一套模板，但采集完直接发送
 *
 * 本文件不认识 Electron / 数据库 / IPC：只做「模板 → { 文本, 需要什么, 还要填什么 }」、
 * 「导入导出文件的形状」与「脚本结果的文本化」。上层（main/skills.cjs）负责落地。
 *
 * 占位符规则（**唯一事实源**，别在 UI 里再写一遍）：
 *   · `{{page}}` / `{{selection}}` / `{{context}}` —— 内置：从正文里抹掉并记入 `needs`，
 *     真正的正文由 chip 携带（模型看到的是结构化快照，不是这里拼的一坨字符串）；
 *   · 其它 `{{xxx}}` —— 保留在文本里，记入 `params`，让用户在输入框里自己填。
 */

/**
 * 内置技能类型（外部可通过 `ai.skill.kind` 追加）。
 * `tone` 只决定图标 / 徽标的色调，UI 侧认三种值（见 ui/styles.js）：
 *   accent（提示词）/ success（读页面）/ muted（自动发送）。
 */
type SkillTone = 'accent' | 'success' | 'muted'
interface SkillKind { kind: string; label: string; icon: string; tone: SkillTone; external?: boolean }
interface SkillRecord { id: string; label: string; icon: string; kind: string; prompt: string; description: string; sortOrder: number }
interface SkillError extends Error { code: string }

const SKILL_KINDS: readonly SkillKind[] = Object.freeze([
  Object.freeze({ kind: 'prompt', label: '提示词', icon: 'Zap', tone: 'accent' }),
  Object.freeze({ kind: 'script', label: '脚本', icon: 'Type', tone: 'success' }),
  Object.freeze({ kind: 'agent', label: '智能体', icon: 'Bot', tone: 'muted' })
])

/** 允许的色调（外部 kind 传错就回落 muted，别让 UI 拿到不存在的 class）。 */
const SKILL_TONES = Object.freeze(['accent', 'success', 'muted'])

/** 内置占位符 → 对应要自动采集的上下文类型（`context` 表示「用已有 chip」）。 */
const BUILTIN_PLACEHOLDER: Record<string, string> = Object.freeze({
  page: 'page',
  selection: 'selection',
  context: 'context'
})

/** 合法的 kind / 参数名：小写 + 数字 + `_` / `-`（限制长度，避免把提示词当代码注入）。 */
const TOKEN_RE = /^[a-z0-9_-]{1,32}$/
const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_-]{1,32})\s*\}\}/gi

/** 单条技能正文上限（与契约 `skillSave.prompt.max(20000)` 对齐）。 */
const PROMPT_MAX = 20000
/** 导出 / 导入一次最多多少条（防止一个 10MB 文件把设置页卡死）。 */
const SKILL_LIMIT = 200
/** 脚本结果回填的上限（再长就进不了 chip 预览，也没必要整段塞给模型）。 */
const SCRIPT_RESULT_MAX = 12000

/** 一条域错误（`code` 原样进 IPC 响应）。 */
function fail(code: string, message?: string): SkillError {
  const err = new Error(message || code) as SkillError
  err.code = code
  return err
}

function safeText(value: unknown, max = PROMPT_MAX): string {
  const text = String(value == null ? '' : value)
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 模板解析：抹掉内置占位符、留下用户参数。
 * @param {string} template
 * @returns {{ text: string, needs: string[], params: string[] }}
 */
function parseTemplate(template: string) : { text: string, needs: string[], params: string[] } {
  const needs: string[] = []
  const params: string[] = []
  const source = String(template == null ? '' : template)

  const text = source.replace(PLACEHOLDER_RE, (_whole: string, rawName: string) => {
    const name = String(rawName || '').toLowerCase()
    if (BUILTIN_PLACEHOLDER[name]) {
      if (!needs.includes(name)) needs.push(name)
      return ''
    }
    if (!params.includes(name)) params.push(name)
    return `{{${name}}}`
  })

  return {
    text: tidy(text),
    needs,
    params
  }
}

/** 占位符被抹掉后会留下空行与行尾空格；这里只做最小规整，不改用户措辞。 */
function tidy(text: unknown): string {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 内置 kind + 外部 kind（`ai.skill.kind`）合并去重。
 * 外部项的 `run` 函数**不在这层处理** —— 这里只保留展示字段。
 * @param {any[]} [external]
 */
function normalizeKinds(external?: unknown[]): SkillKind[] {
  const out: SkillKind[] = SKILL_KINDS.map((kind) => ({ ...kind, external: false }))
  const seen = new Set<string>(out.map((kind) => kind.kind))
  for (const raw of Array.isArray(external) ? external : []) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const kind = String(record.kind || '').toLowerCase()
    if (!TOKEN_RE.test(kind) || seen.has(kind)) continue
    seen.add(kind)
    out.push({
      kind,
      label: String(record.label || kind).slice(0, 40),
      icon: String(record.icon || 'Puzzle').slice(0, 64),
      tone: SKILL_TONES.includes(String(record.tone)) ? String(record.tone) as SkillTone : 'muted',
      external: true
    })
  }
  return out
}

function kindMeta(kinds: unknown, kind: string): SkillKind {
  const hit = (Array.isArray(kinds) ? kinds as SkillKind[] : []).find((candidate) => candidate.kind === kind)
  return hit || SKILL_KINDS[0]
}

/**
 * 校验并补齐一条技能（保存 / 导入共用）。
 * 未知 kind 回落 `kinds[0]`：宁可让它变成普通提示词，也不要存进一条跑不起来的记录。
 * @param {any} raw
 * @param {{ kinds?: any[] }} [opts]
 */
function normalizeSkill(raw: unknown, opts: { kinds?: SkillKind[] } = {}): SkillRecord {
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : SKILL_KINDS
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = String(item.id || '').trim().slice(0, 64)
  const label = String(item.label || '').trim().slice(0, 120)
  const prompt = safeText(item.prompt)
  if (!id) throw fail('AI_SKILL_INVALID', '缺少技能 id')
  if (!label) throw fail('AI_SKILL_INVALID', '缺乏技能名称')
  if (!prompt) throw fail('AI_SKILL_INVALID', '缺少技能内容')

  const wanted = String(item.kind || '').toLowerCase()
  const kind = kinds.some((candidate) => candidate.kind === wanted) ? wanted : kinds[0].kind
  const meta = kindMeta(kinds, kind)

  return {
    id,
    label,
    icon: String(item.icon || meta.icon || 'Zap').slice(0, 64),
    kind,
    prompt,
    description: String(item.description || '').trim().slice(0, 2000),
    sortOrder: Number(item.sortOrder) || 0
  }
}

/** 导出文件的内容（只保留可跨机器复用的字段；`builtin` / `sortOrder` 属于本地状态）。 */
function toExportFile(skills: unknown): string {
  const list = (Array.isArray(skills) ? skills : []).slice(0, SKILL_LIMIT).map((raw: unknown) => {
    const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      id: String(s.id || ''),
      label: String(s.label || ''),
      icon: String(s.icon || ''),
      kind: String(s.kind || 'prompt'),
      prompt: String(s.prompt || ''),
      description: String(s.description || '')
    }
  })
  return JSON.stringify({
    format: 'hira-ai-skill',
    version: 1,
    exportedAt: new Date().toISOString(),
    skills: list
  }, null, 2)
}

/**
 * 解析导入文件。容忍三种形状：完整 envelope、裸数组、单条对象。
 * **只做形状校验**（是否像一条技能），id 冲突与 kind 回落交给调用方。
 * @param {string} text
 * @returns {any[]}
 */
function parseImportFile(text: string): SkillRecord[] {
  let data: unknown
  try {
    data = JSON.parse(String(text || ''))
  } catch (_) {
    throw fail('AI_SKILL_IMPORT_INVALID', '文件不是合法的 JSON')
  }

  const envelope = data && typeof data === 'object' ? data as Record<string, unknown> : null
  const list = Array.isArray(data) ? data
    : envelope && Array.isArray(envelope.skills) ? envelope.skills
      : envelope ? [envelope]
        : []

  const out: SkillRecord[] = list
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && ((raw as Record<string, unknown>).prompt !== undefined || (raw as Record<string, unknown>).label !== undefined))
    .slice(0, SKILL_LIMIT)
    .map((s) => ({
      id: s.id ? String(s.id).slice(0, 64) : '',
      label: s.label ? String(s.label) : '',
      icon: s.icon ? String(s.icon) : '',
      kind: s.kind ? String(s.kind) : '',
      prompt: s.prompt ? String(s.prompt) : '',
      description: s.description ? String(s.description) : '',
      sortOrder: 0
    }))

  if (!out.length) throw fail('AI_SKILL_IMPORT_EMPTY', '文件里没有可导入的技能')
  return out
}

/**
 * 脚本源码 → 可注入隔离世界的代码。
 *
 * 隔离世界**共享同一棵 DOM**，所以在里面直接跑脚本是能改到真实页面的。
 * 为了守住"源页面零改动"，这里把脚本绑到一个**脱离文档的快照**上：
 *   1. 用 `createHTMLDocument` 造一个不挂载的 document；
 *   2. 把当前页面的 `documentElement.innerHTML` 拷进去（脚本标签不会执行）；
 *   3. 用户源码以 `document` 形参接收这份快照 —— 删订阅栏 / 改属性都只发生在副本里。
 * 代价是拿不到布局与计算样式（`innerText` / `getComputedStyle` 不可用），
 * 这也是内置脚本统一用 `textContent` 的原因。
 *
 * 用户源码里可以直接 `return`（被函数包住），所以「最后一行表达式」也能当结果。
 * `\u2028/\u2029` 必须转义：它们在 JS 里是换行符，原样塞进字符串字面量会断行。
 * @param {string} source
 * @param {any} [args]
 */
function buildScriptCode(source: string, args?: unknown) {
  const json = JSON.stringify(args && typeof args === 'object' ? args : {})
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return [
    '(() => {',
    `  const args = ${json};`,
    '  const snapshot = (() => {',
    '    const live = document;',
    '    const doc = live.implementation.createHTMLDocument("hira-snapshot");',
    '    if (live.documentElement) doc.documentElement.innerHTML = live.documentElement.innerHTML;',
    '    return doc;',
    '  })();',
    '  return (function (document) {',
    String(source == null ? '' : source),
    '  })(snapshot);',
    '})()'
  ].join('\n')
}

/** 超长文本截断（保留头部，明确告知已截断 —— 静默截断会让模型以为内容就这么多）。 */
function truncate(text: unknown, max = SCRIPT_RESULT_MAX): string {
  const value = String(text == null ? '' : text)
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…（已截断）`
}

/**
 * 脚本返回值 → 可读文本。
 * 支持：字符串原样、标量转字符串、`{level,text}[]`（标题树）、字符串数组（列表）、其它 JSON。
 * @param {any} value
 * @param {{ maxChars?: number }} [opts]
 */
function formatScriptResult(value: unknown, opts: { maxChars?: number } = {}): string {
  const max = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : SCRIPT_RESULT_MAX
  if (value == null) return ''
  if (typeof value === 'string') return truncate(tidy(value), max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    const lines = []
    for (const item of value) {
      if (item == null) continue
      if (typeof item === 'string') {
        if (item.trim()) lines.push(`- ${item.trim()}`)
      } else if (typeof item === 'object' && ((item as Record<string, unknown>).text || (item as Record<string, unknown>).label)) {
        const record = item as Record<string, unknown>
        const level = Math.max(1, Math.min(6, Number(record.level) || 1))
        lines.push(`${'  '.repeat(level - 1)}- ${String(record.text || record.label).trim()}`)
      } else {
        lines.push(`- ${oneLine(item)}`)
      }
      if (lines.length >= 400) { lines.push('…（更多条目已省略）'); break }
    }
    return truncate(tidy(lines.join('\n')), max)
  }

  if (typeof value === 'object') {
    let json: string
    try { json = JSON.stringify(value, null, 2) } catch (_) { json = String(value) }
    return truncate(json, max)
  }
  return truncate(String(value), max)
}

/** 单行化（条目里混进对象时用）。 */
function oneLine(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  } catch (_) {
    return String(value)
  }
}

// 只导出真正被上层用到的：常量与内部小函数留在本文件，别让它们变成第二套事实源。
module.exports = {
  parseTemplate,
  normalizeKinds,
  normalizeSkill,
  toExportFile,
  parseImportFile,
  buildScriptCode,
  formatScriptResult
}
