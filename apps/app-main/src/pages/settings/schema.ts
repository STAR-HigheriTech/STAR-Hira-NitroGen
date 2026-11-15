/**
 * 设置 schema 的纯函数投影。
 *
 * 主进程只提供可序列化的 JSON；这里集中完成索引、分组、显隐、选项归一化与
 * 搜索匹配。页面渲染器因此不必知道字段来自哪条插件，也不需要在每次输入时
 * 重新遍历整棵 schema。
 */

export type SettingsOption = [unknown, string]

export interface SettingsFieldDefinition extends Record<string, unknown> {
  name?: string
  key?: string
  type?: string
  label?: string
  placeholder?: string
  prefix?: string
  hint?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: SettingsOption[]
}

export interface SettingsListConfig extends Record<string, unknown> {
  route?: string
  primary?: string
  secondary?: string
  removeRoute?: string
  removeLabel?: string
  emptyText?: string
}

export interface SettingsRecordSpec extends Record<string, unknown> {
  fields?: SettingsFieldDefinition[]
  summary?: Array<string | { name?: string; suffix?: string }>
  generate?: string
  generateLabel?: string
  applyLabel?: string
  emptyText?: string
}

export interface SettingsItemSchema extends Record<string, unknown> {
  badge?: string
  badgePrefix?: string
  title?: string
  subtitle?: string
  usage?: boolean | string
  tagWhen?: string
  tagInvert?: boolean
  tagLabel?: string
  fields?: SettingsFieldDefinition[]
  toggles?: SettingsFieldDefinition[]
}

export interface SettingsActionSpec extends Record<string, unknown> {
  runRoute?: string
  checkRoute?: string
  runLabel?: string
  doneLabel?: string
  poll?: number
  resultHint?: boolean
  label?: string
  toast?: string
}

export interface SettingsField extends Record<string, unknown> {
  key: string
  label?: string
  type?: string
  effect?: string
  group?: string
  subtab?: string
  description?: string
  hint?: string
  placeholder?: string
  unit?: string
  addLabel?: string
  emptyText?: string
  inactiveLabel?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  scale?: number
  optionsRoute?: string
  when?: { key?: string; value?: unknown }
  options?: SettingsOption[]
  list?: SettingsListConfig
  routes?: Record<string, string>
  record?: SettingsRecordSpec
  toast?: { saved?: string; removed?: string }
  action?: SettingsActionSpec
  itemSchema?: SettingsItemSchema
  bucketOf?: Record<string, string>
  bucketLabels?: Record<string, string>
  disabledWhen?: Record<string, { key?: string; value?: unknown; values?: unknown[] }>
}

export interface SettingsSection extends Record<string, unknown> {
  id: string
  label?: string
  icon?: string
  description?: string
  entry?: unknown
  subtabs?: Array<{ id: string; label?: string }>
  group?: string
  groupLabel?: string
  groupIcon?: string
  groupHref?: string
  fields?: SettingsField[]
}

export interface SettingsGroupView {
  id: string
  name: string
  icon: string
  href: string
  sections: SettingsSection[]
}

export interface SettingsSchemaIndex {
  fieldByKey: Record<string, SettingsField>
  sectionByFieldKey: Record<string, SettingsSection>
  restartKeys: Record<string, true>
  dependKeys: Record<string, true>
  repaintKeys: Record<string, string[]>
}

export function createSettingsSchemaIndex(sections: SettingsSection[]): SettingsSchemaIndex {
  const fieldByKey: Record<string, SettingsField> = {}
  const sectionByFieldKey: Record<string, SettingsSection> = {}
  const restartKeys: Record<string, true> = {}
  const dependKeys: Record<string, true> = {}
  const repaintKeys: Record<string, string[]> = {}

  for (const section of sections) {
    for (const field of section.fields || []) {
      fieldByKey[field.key] = field
      sectionByFieldKey[field.key] = section
      if (field.when && field.when.key) dependKeys[field.when.key] = true
      if (field.effect === 'restart') restartKeys[field.key] = true
      if (field.type === 'order') {
        const watched = new Set<string>()
        for (const key of Object.values(field.bucketOf || {})) if (key) watched.add(key)
        for (const condition of Object.values(field.disabledWhen || {})) {
          const key = condition && condition.key
          if (typeof key === 'string' && key) watched.add(key)
        }
        for (const key of watched) (repaintKeys[key] ||= []).push(field.key)
      }
    }
  }

  return { fieldByKey, sectionByFieldKey, restartKeys, dependKeys, repaintKeys }
}

export function isFieldVisible(field: SettingsField, values: Record<string, unknown>): boolean {
  if (!field.when || !field.when.key) return true
  return String(values[field.when.key]) === String(field.when.value)
}

export function normalizeSettingOptions(raw: unknown): Array<[unknown, string]> {
  const out: Array<[unknown, string]> = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw) ? raw : []) {
    let id: unknown
    let label: unknown
    if (Array.isArray(item)) {
      id = item[0]
      label = item[1]
    } else if (item && typeof item === 'object') {
      const value = item as Record<string, unknown>
      id = value.id != null ? value.id : value.value
      label = value.label != null ? value.label : value.name
    } else {
      id = item
      label = item
    }
    if (id == null || id === '') continue
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    out.push([id, label == null || label === '' ? key : String(label)])
  }
  return out
}

export function buildSettingsGroups(sections: SettingsSection[]): SettingsGroupView[] {
  const out: SettingsGroupView[] = []
  const byId = new Map<string, SettingsGroupView>()
  for (const section of sections) {
    const id = section.group || 'other'
    let group = byId.get(id)
    if (!group) {
      group = {
        id,
        name: section.groupLabel || (id === 'other' ? '其他' : id),
        icon: section.groupIcon || '',
        href: section.groupHref || '',
        sections: []
      }
      byId.set(id, group)
      out.push(group)
    }
    group.sections.push(section)
  }
  return out
}

export function groupIdForSection(groups: SettingsGroupView[], section: SettingsSection | null): string {
  if (!section) return ''
  for (const group of groups) if (!group.href && group.sections.includes(section)) return group.id
  return ''
}

export function matchesSettingQuery(field: SettingsField, query: string, section?: SettingsSection | null): boolean {
  if (!query) return true
  const parts: unknown[] = [field.label, field.key, field.description, field.hint, field.placeholder]
  for (const option of field.options || []) if (Array.isArray(option)) parts.push(option[1])
  const itemSchema = field.itemSchema || {}
  parts.push(itemSchema.title, itemSchema.subtitle)
  const itemFields = Array.isArray(itemSchema.fields) ? itemSchema.fields : []
  for (const item of itemFields) {
    if (item && typeof item === 'object') {
      const value = item as Record<string, unknown>
      parts.push(value.label || value.key)
    }
  }
  if (section) parts.push(section.label, section.groupLabel)
  return parts.filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase())
}

export function toSettingEntries(entry: unknown): Array<Record<string, unknown>> {
  if (!entry) return []
  return (Array.isArray(entry) ? entry : [entry]).filter((item): item is Record<string, unknown> => {
    return !!item && typeof item === 'object' && !!(item as Record<string, unknown>).label &&
      !!((item as Record<string, unknown>).href || (item as Record<string, unknown>).route)
  })
}

