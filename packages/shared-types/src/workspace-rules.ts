/**
 * 工作区规则：把站点上下文映射到浏览器动作的纯规则层。
 *
 * 触发器只描述“何时评估”，动作仍复用自动化动作表与现有 TabManager，
 * 不拥有第二套命令命名空间。
 */

import { isKnownAction } from './automation.js'

export const WORKSPACE_RULE_SETTING_KEYS = Object.freeze({
  rules: 'automation.workspace_rules',
  enabled: 'automation.workspace_rules_enabled',
  tasks: 'automation.workspace_tasks'
})

export const WORKSPACE_RULE_LIMITS = Object.freeze({
  maxRules: 80,
  maxActions: 8,
  maxNameLength: 60,
  maxPatternLength: 512
})

export type WorkspaceRuleTrigger = string

export interface WorkspaceRule {
  id: string
  name: string
  enabled: boolean
  trigger: WorkspaceRuleTrigger
  match: string
  actions: string[]
}

export interface WorkspaceRuleEvent {
  trigger: WorkspaceRuleTrigger
  tabId: string
  url: string
  title?: string
  active?: boolean
}

export interface WorkspaceRuleMatch {
  rule: WorkspaceRule
  actions: string[]
}

export interface WorkspaceTaskTab {
  url: string
  title: string
  pinned: boolean
}

export interface WorkspaceTask {
  id: string
  name: string
  createdAt: number
  tabs: WorkspaceTaskTab[]
}

const BUILTIN_ACTION_IDS = new Set([
  'workspace:group-by-domain',
  'tab:toggle-pin',
  'tab:toggle-mute',
  'tab:sleep',
  'tab:undo-close',
  'tab:reload',
  'view:reader-mode',
  'view:toggle-fullscreen',
  'bookmark:toggle'
])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function normalizeWorkspaceRule(raw: unknown): WorkspaceRule | null {
  const source = record(raw)
  const id = text(source.id, 160)
  const name = text(source.name, WORKSPACE_RULE_LIMITS.maxNameLength)
  const match = text(source.match, WORKSPACE_RULE_LIMITS.maxPatternLength)
  const trigger = text(source.trigger, 80) || 'open'
  const actions = Array.isArray(source.actions)
    ? [...new Set(source.actions.map((action) => text(action, 160)).filter((action) => {
      return BUILTIN_ACTION_IDS.has(action) || isKnownAction(action) || action.startsWith('chain:')
    }))].slice(0, WORKSPACE_RULE_LIMITS.maxActions)
    : []
  if (!id || !name || !match || !actions.length) return null
  return { id, name, match, trigger, actions, enabled: source.enabled !== false }
}

export function normalizeWorkspaceRules(raw: unknown): WorkspaceRule[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: WorkspaceRule[] = []
  for (const item of raw) {
    const rule = normalizeWorkspaceRule(item)
    if (!rule || seen.has(rule.id)) continue
    seen.add(rule.id)
    out.push(rule)
    if (out.length >= WORKSPACE_RULE_LIMITS.maxRules) break
  }
  return out
}

export function parseWorkspaceRules(value: unknown): WorkspaceRule[] {
  if (!value) return []
  try {
    return normalizeWorkspaceRules(typeof value === 'string' ? JSON.parse(value) : value)
  } catch {
    return []
  }
}

export function serializeWorkspaceRules(rules: unknown): string {
  return JSON.stringify(normalizeWorkspaceRules(rules))
}

export function workspacePatternMatches(pattern: unknown, url: unknown): boolean {
  const value = text(pattern, WORKSPACE_RULE_LIMITS.maxPatternLength)
  if (!value) return false
  const target = String(url || '')
  let source = ''
  for (const char of value) {
    source += char === '*' ? '.*' : char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(`^${source}$`, 'i').test(target)
  } catch {
    return false
  }
}

export function matchWorkspaceRules(
  rules: unknown,
  event: WorkspaceRuleEvent
): WorkspaceRuleMatch[] {
  return normalizeWorkspaceRules(rules)
    .filter((rule) => rule.enabled && rule.trigger === event.trigger && workspacePatternMatches(rule.match, event.url))
    .map((rule) => ({ rule, actions: [...rule.actions] }))
}

export function normalizeWorkspaceTask(raw: unknown): WorkspaceTask | null {
  const value = record(raw)
  const id = text(value.id, 160)
  const name = text(value.name, 80)
  if (!id || !name) return null
  const tabs = (Array.isArray(value.tabs) ? value.tabs : []).map((item) => {
    const tab = record(item)
    const url = text(tab.url, 2048)
    if (!/^https?:\/\//i.test(url)) return null
    return { url, title: text(tab.title, 300) || url, pinned: tab.pinned === true }
  }).filter((tab): tab is WorkspaceTaskTab => tab !== null).slice(0, 200)
  return tabs.length ? { id, name, createdAt: Number(value.createdAt) || Date.now(), tabs } : null
}

export function parseWorkspaceTasks(value: unknown): WorkspaceTask[] {
  if (!value) return []
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    return raw.map(normalizeWorkspaceTask).filter((task): task is WorkspaceTask => {
      if (!task || seen.has(task.id)) return false
      seen.add(task.id)
      return true
    }).slice(0, 50)
  } catch {
    return []
  }
}

export function serializeWorkspaceTasks(tasks: unknown): string {
  return JSON.stringify(parseWorkspaceTasks(tasks))
}

export const WORKSPACE_RULE_TEMPLATES = Object.freeze([
  {
    id: 'research',
    name: '研究模式',
    description: '论文和资料站点单独成栈，提醒稍后阅读。',
    rules: [
      { name: '研究站点按域名成组', match: '*://*.arxiv.org/*', trigger: 'open' as const, actions: ['workspace:group-by-domain'] },
      { name: 'PubMed 自动收藏', match: '*://pubmed.ncbi.nlm.nih.gov/*', trigger: 'open' as const, actions: ['bookmark:toggle', 'workspace:group-by-domain'] }
    ]
  },
  {
    id: 'development',
    name: '开发模式',
    description: '代码、文档和 CI 标签自动分组。',
    rules: [
      { name: 'GitHub 按域名成组', match: '*://github.com/*', trigger: 'open' as const, actions: ['workspace:group-by-domain'] },
      { name: '本地开发站点固定', match: 'http://localhost:*/*', trigger: 'navigate' as const, actions: ['tab:toggle-pin'] }
    ]
  },
  {
    id: 'focus',
    name: '专注模式',
    description: '打开娱乐站点时自动静音并降低打扰。',
    rules: [
      { name: '视频站点静音', match: '*://*.bilibili.com/*', trigger: 'open' as const, actions: ['tab:toggle-mute'] },
      { name: '短视频站点静音', match: '*://*.douyin.com/*', trigger: 'open' as const, actions: ['tab:toggle-mute'] }
    ]
  }
] as const)
