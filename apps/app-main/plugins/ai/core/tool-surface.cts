/**
 * 模型可见工具面（纯逻辑）。
 *
 * 全部工具 schema 固定塞进每次请求，会让无关定义抢占上下文、拖慢首 token，
 * 也降低模型选工具的准确率。这里采用两层工具面：
 *   1. 高频浏览器能力直接提供，顺序固定，保证请求前缀稳定；
 *   2. 其余能力由 `tool_search` 按需展开，只把命中的 schema 追加到后续 step。
 *
 * 动态 schema 永远追加在稳定前缀之后；一轮内只增不减，避免工具顺序反复变化。
 */

import type { AiToolDefinition, JsonSchema } from '../types'

type ToolWire = Pick<AiToolDefinition, 'name' | 'description' | 'parameters'>

const TOOL_SEARCH_NAME = 'tool_search'

/**
 * 高频工具保持精简。这里不是“权限白名单”：完整工具仍可经 tool_search 展开，
 * 只是默认不把几十 KB 的无关 schema 发给模型。
 */
const CORE_TOOL_NAMES = Object.freeze([
  'agent_browser',
  'agent_delegate',
  'agent_delegate_batch',
  'agent_task',
  'app_logs',
  'bookmark_search',
  'browser_control',
  'file_edit',
  'file_list',
  'file_read',
  'file_search',
  'file_write',
  'history_search',
  'office_create_document',
  'office_create_presentation',
  'office_create_workbook',
  'office_read',
  'page_click',
  'page_find',
  'page_read',
  'page_screenshot',
  'page_scroll',
  'page_type',
  'panel_list',
  'panel_read',
  'plugin_author',
  'shell_run',
  'tab_close',
  'tab_list',
  'tab_open',
  'tab_switch',
  'web_fetch',
  'web_search',
  'workspace_current',
  'workspace_list',
  'workspace_open',
  'workspace_use'
])

const CORE_SET = new Set(CORE_TOOL_NAMES)

const TOOL_SEARCH_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '能力关键词，例如“插件”“主题”“下载”“书签批量操作”“工作室”'
    }
  },
  required: ['query'],
  additionalProperties: false
}

const TOOL_SEARCH_TOOL: ToolWire = Object.freeze({
  name: TOOL_SEARCH_NAME,
  description: '检索当前工具面中没有的能力。browser_control 与 plugin_author 已是核心工具；插件创作/浏览器设置不需要先搜它们。其它扩展能力才用本工具。',
  parameters: TOOL_SEARCH_PARAMETERS
})

function wireTool(tool: AiToolDefinition): ToolWire {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }
}

function normalize(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[\s._:/-]+/g, '')
}

function queryTerms(value: unknown): string[] {
  const raw = String(value || '').toLowerCase().trim()
  const words = raw.match(/[\p{L}\p{N}_-]+/gu) || []
  const chars = Array.from(raw).filter((ch) => /[\u3400-\u9fff\uf900-\ufaff]/u.test(ch))
  const grams: string[] = []
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars[i] + chars[i + 1])
  return [...new Set([...words, ...grams])].filter(Boolean)
}

/**
 * 依据名称、说明和中文二元词检索工具。评分保持可预测，不依赖模型二次判断。
 */
function searchTools(tools: AiToolDefinition[], query: unknown, limit = 8): {
  tools: Array<{ name: string; description: string }>
  total: number
} {
  const text = String(query || '').trim()
  const compact = normalize(text)
  const terms = queryTerms(text)
  if (!text) return { tools: [], total: 0 }

  const ranked = tools
    .filter((tool) => !!tool && !CORE_SET.has(tool.name) && tool.name !== TOOL_SEARCH_NAME)
    .map((tool) => {
      const name = tool.name.toLowerCase()
      const parts = name.split(/[_-]+/)
      const description = String(tool.description || '').toLowerCase()
      let score = name === compact ? 100 : name.includes(compact) ? 30 : 0
      for (const term of terms) {
        const bare = term.endsWith('s') ? term.slice(0, -1) : term
        if (name.includes(term)) score += 12
        else if (bare && parts.some((part) => part.includes(bare))) score += 8
        if (description.includes(term)) score += 4
      }
      return { tool, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))

  const cap = Math.max(1, Math.min(Number(limit) || 8, 12))
  return {
    total: ranked.length,
    tools: ranked.slice(0, cap).map(({ tool }) => ({
      name: tool.name,
      description: String(tool.description || '').slice(0, 180)
    }))
  }
}

function buildToolSurface(tools: AiToolDefinition[], expanded?: Set<string>): ToolWire[] {
  const available = new Map(
    (Array.isArray(tools) ? tools : [])
      .filter((tool) => !!tool && typeof tool.name === 'string')
      .map((tool) => [tool.name, tool])
  )
  const base = [...CORE_SET]
    .filter((name) => available.has(name))
    .sort()
    .map((name) => wireTool(available.get(name) as AiToolDefinition))
  const extra = [...(expanded || new Set<string>())]
    .filter((name) => name !== TOOL_SEARCH_NAME && !CORE_SET.has(name) && available.has(name))
    .map((name) => wireTool(available.get(name) as AiToolDefinition))
  return [...base, TOOL_SEARCH_TOOL, ...extra]
}

function isToolVisible(name: unknown, expanded?: Set<string>): boolean {
  const key = String(name || '')
  return key === TOOL_SEARCH_NAME || CORE_SET.has(key) || !!(expanded && expanded.has(key))
}

module.exports = {
  CORE_TOOL_NAMES,
  TOOL_SEARCH_NAME,
  buildToolSurface,
  searchTools,
  isToolVisible
}
