export const DOWNLOAD_RULES_SETTING_KEY = 'download.rules'

export type DownloadRuleAction = string

export const DOWNLOAD_RULE_ACTION_OPTIONS = Object.freeze([
  { id: 'open-file' as const, label: '完成后打开文件' },
  { id: 'show-in-folder' as const, label: '在文件夹中显示' },
  { id: 'collect' as const, label: '收进集锦' },
  { id: 'read-later' as const, label: '加入稍后读' }
])

export interface DownloadRule {
  id: string
  name: string
  enabled: boolean
  domains: string[]
  extensions: string[]
  keywords: string[]
  folder: string
  nameTemplate: string
  actions: DownloadRuleAction[]
}

export interface DownloadRuleInput {
  url: string
  filename: string
  mimeType?: string
}

export interface DownloadRuleResult {
  ruleId: string
  folder: string
  filename: string
  actions: DownloadRuleAction[]
}

export const DOWNLOAD_RULE_LIMITS = Object.freeze({
  maxRules: 60,
  maxList: 64
})

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, DOWNLOAD_RULE_LIMITS.maxList)
    : []
}

function actionList(value: unknown): DownloadRuleAction[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map(String)
    .map((item) => item.trim())
    .filter((item) => /^[a-z0-9][a-z0-9._:-]{0,120}$/i.test(item)))]
}

export function normalizeDownloadRule(raw: unknown): DownloadRule | null {
  const value = record(raw)
  const id = String(value.id || '').trim()
  const name = String(value.name || '').trim().slice(0, 80)
  if (!id || !name) return null
  return {
    id,
    name,
    enabled: value.enabled !== false,
    domains: list(value.domains),
    extensions: list(value.extensions).map((ext) => ext.startsWith('.') ? ext : `.${ext}`),
    keywords: list(value.keywords),
    folder: String(value.folder || '其他').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 80) || '其他',
    nameTemplate: String(value.nameTemplate || '{name}').slice(0, 200),
    actions: actionList(value.actions)
  }
}

export function normalizeDownloadRules(raw: unknown): DownloadRule[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const output: DownloadRule[] = []
  for (const item of raw) {
    const rule = normalizeDownloadRule(item)
    if (!rule || seen.has(rule.id)) continue
    seen.add(rule.id)
    output.push(rule)
    if (output.length >= DOWNLOAD_RULE_LIMITS.maxRules) break
  }
  return output
}

export function parseDownloadRules(value: unknown): DownloadRule[] {
  if (!value) return []
  try {
    return normalizeDownloadRules(typeof value === 'string' ? JSON.parse(value) : value)
  } catch {
    return []
  }
}

export function serializeDownloadRules(rules: unknown): string {
  return JSON.stringify(normalizeDownloadRules(rules))
}

export function resolveDownloadRule(rules: unknown, input: DownloadRuleInput): DownloadRuleResult | null {
  const fileName = String(input.filename || '')
  const lowerName = fileName.toLowerCase()
  const ext = /\.[a-z0-9]+$/i.exec(fileName)?.[0]?.toLowerCase() || ''
  let hostname = ''
  try { hostname = new URL(input.url).hostname.toLowerCase() } catch {}
  for (const rule of normalizeDownloadRules(rules)) {
    if (!rule.enabled) continue
    if (rule.domains.length && !rule.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) continue
    if (rule.extensions.length && !rule.extensions.includes(ext)) continue
    if (rule.keywords.length && !rule.keywords.some((keyword) => lowerName.includes(keyword))) continue
    const base = fileName.replace(/\.[^.]+$/, '')
    const date = new Date().toISOString().slice(0, 10)
    const renamed = rule.nameTemplate
      .replace(/\{name\}/g, base)
      .replace(/\{ext\}/g, ext)
      .replace(/\{domain\}/g, hostname)
      .replace(/\{date\}/g, date)
    const clean = renamed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim()
    return {
      ruleId: rule.id,
      folder: rule.folder,
      filename: clean && /\.[^.]+$/.test(clean) ? clean : `${clean || base}${ext}`,
      actions: [...rule.actions]
    }
  }
  return null
}
