import { AUTOMATION_LIMITS, actionLabel, type AutomationChain, type GestureMap } from 'hira://shared/automation.mjs'
import {
  WORKSPACE_RULE_LIMITS,
  normalizeWorkspaceRules,
  type WorkspaceRule,
  type WorkspaceRuleTrigger
} from 'hira://shared/workspace-rules.mjs'

export interface AutomationAction { id: string; label: string; group: string }
export interface AutomationDirection { id: string; label: string }
export interface AutomationRuleTrigger { id: string; label: string }
export interface AutomationSnapshot {
  chains: AutomationChain[]
  gestures: GestureMap
  gesturesEnabled: boolean
  rules: WorkspaceRule[]
  rulesEnabled: boolean
  ruleTriggers: AutomationRuleTrigger[]
  actions: AutomationAction[]
  directions: AutomationDirection[]
}
export interface ChainDraft extends AutomationChain { isNew: boolean }
export interface RuleDraft extends WorkspaceRule { isNew: boolean }
export interface ActionGroup { label: string; actions: AutomationAction[] }
export interface SettingsChange { key?: string; scope?: string; value?: unknown }

export const CHAIN_LIMITS = Object.freeze({
  maxChains: Number(AUTOMATION_LIMITS.maxChains) || 50,
  maxSteps: Number(AUTOMATION_LIMITS.maxSteps) || 20,
  maxNameLength: Number(AUTOMATION_LIMITS.maxNameLength) || 60
})

export const AUTOMATION_SETTING_KEYS = Object.freeze([
  'automation.chains',
  'automation.gestures',
  'automation.gestures_enabled',
  'automation.workspace_rules',
  'automation.workspace_rules_enabled'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (!item.id || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function readAction(value: unknown): AutomationAction | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  if (!id) return null
  return { id, label: text(value.label) || actionLabel(id), group: text(value.group) || '其他' }
}

function readDirection(value: unknown): AutomationDirection | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  return id ? { id, label: text(value.label) || id } : null
}

function readChain(value: unknown): AutomationChain | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  const name = text(value.name).slice(0, CHAIN_LIMITS.maxNameLength)
  if (!id || !name) return null
  const steps = Array.isArray(value.steps)
    ? value.steps.map(text).filter(Boolean).slice(0, CHAIN_LIMITS.maxSteps)
    : []
  return steps.length ? { id, name, steps } : null
}

function readGestureMap(value: unknown): GestureMap {
  if (!isRecord(value)) return {}
  const output: GestureMap = {}
  for (const [direction, action] of Object.entries(value)) {
    const id = text(action)
    if (direction && id) output[direction] = id
  }
  return output
}

/** Main process is the source of truth; this only projects its IPC payload into page-owned shapes. */
export function readAutomationSnapshot(value: unknown): AutomationSnapshot {
  const source = isRecord(value) ? value : {}
  const chains = Array.isArray(source.chains)
    ? source.chains.map(readChain).filter((item): item is AutomationChain => Boolean(item))
    : []
  const actions = Array.isArray(source.actions)
    ? source.actions.map(readAction).filter((item): item is AutomationAction => Boolean(item))
    : []
  const directions = Array.isArray(source.directions)
    ? source.directions.map(readDirection).filter((item): item is AutomationDirection => Boolean(item))
    : []

  return {
    chains: uniqueById(chains).slice(0, CHAIN_LIMITS.maxChains),
    gestures: readGestureMap(source.gestures),
    gesturesEnabled: source.gesturesEnabled !== false,
    rules: normalizeWorkspaceRules(source.rules),
    rulesEnabled: source.rulesEnabled !== false,
    ruleTriggers: Array.isArray(source.ruleTriggers)
      ? source.ruleTriggers.map(readDirection).filter((item): item is AutomationRuleTrigger => Boolean(item))
      : [],
    actions: uniqueById(actions),
    directions: uniqueById(directions)
  }
}

export function createChainId(): string {
  try { return crypto.randomUUID() } catch {
    return `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function createChainDraft(chain?: AutomationChain | null): ChainDraft {
  return chain
    ? { id: chain.id, name: chain.name, steps: [...chain.steps], isNew: false }
    : { id: createChainId(), name: '', steps: [], isNew: true }
}

export function chainFromDraft(draft: ChainDraft): AutomationChain | null {
  const name = draft.name.trim().slice(0, CHAIN_LIMITS.maxNameLength)
  const steps = draft.steps.filter(Boolean).slice(0, CHAIN_LIMITS.maxSteps)
  return draft.id && name && steps.length ? { id: draft.id, name, steps } : null
}

export function upsertChain(chains: readonly AutomationChain[], chain: AutomationChain): AutomationChain[] {
  const index = chains.findIndex((item) => item.id === chain.id)
  if (index < 0) return [...chains, chain].slice(0, CHAIN_LIMITS.maxChains)
  const next = [...chains]
  next[index] = chain
  return next
}

export function createRuleId(): string {
  try { return crypto.randomUUID() } catch {
    return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function createRuleDraft(rule?: WorkspaceRule | null): RuleDraft {
  return rule
    ? { ...rule, actions: [...rule.actions], isNew: false }
    : {
        id: createRuleId(),
        name: '',
        enabled: true,
        trigger: 'open',
        match: '',
        actions: [],
        isNew: true
      }
}

export function ruleFromDraft(draft: RuleDraft): WorkspaceRule | null {
  const name = draft.name.trim().slice(0, WORKSPACE_RULE_LIMITS.maxNameLength)
  const match = draft.match.trim().slice(0, WORKSPACE_RULE_LIMITS.maxPatternLength)
  const trigger: WorkspaceRuleTrigger = draft.trigger.trim().slice(0, 80) || 'open'
  const actions = [...new Set(draft.actions)].slice(0, WORKSPACE_RULE_LIMITS.maxActions)
  return draft.id && name && match && actions.length
    ? { id: draft.id, name, match, trigger, actions, enabled: draft.enabled !== false }
    : null
}

export function upsertRule(rules: readonly WorkspaceRule[], rule: WorkspaceRule): WorkspaceRule[] {
  const index = rules.findIndex((item) => item.id === rule.id)
  if (index < 0) return [...rules, rule].slice(0, WORKSPACE_RULE_LIMITS.maxRules)
  const next = [...rules]
  next[index] = rule
  return next
}

export function workspaceActionOptions(actions: readonly AutomationAction[]): AutomationAction[] {
  return [
    { id: 'workspace:group-by-domain', label: '按当前站点收进标签栈', group: '工作区' },
    ...actions
  ]
}

export function groupActions(actions: readonly AutomationAction[]): ActionGroup[] {
  const groups = new Map<string, AutomationAction[]>()
  for (const action of actions) {
    const label = action.group || '其他'
    const list = groups.get(label)
    if (list) list.push(action)
    else groups.set(label, [action])
  }
  return Array.from(groups, ([label, items]) => ({ label, actions: items }))
}

export function actionSummary(steps: readonly string[], actions: readonly AutomationAction[] = []): string {
  if (!steps.length) return '尚未添加命令'
  const labels = new Map(actions.map((action) => [action.id, action.label]))
  return steps.map((step) => labels.get(step) || actionLabel(step)).join(' → ')
}

export function isAutomationSetting(key: unknown): boolean {
  return typeof key === 'string' && AUTOMATION_SETTING_KEYS.includes(key)
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (isRecord(error) && error.message !== undefined) return String(error.message)
  return String(error || '').trim() || fallback
}
