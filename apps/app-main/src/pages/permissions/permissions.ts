import { IPC_EVENTS, initTheme, renderEmpty, rpc, subscribe, el } from 'hira://shared/runtime.js'
import {
  hostOfOrigin,
  PERMISSION_CHOICES,
  PERMISSION_SETTING_ACTIONS,
  PERMISSION_SETTING_LABELS,
  PERMISSION_SETTINGS,
  permissionFilterOptions,
  permissionLabel
} from 'hira://shared/permission-labels.mjs'
import { requiredById } from 'hira://shared/page-kit.js'
import { permissionsClient } from './client.js'
import type {
  PendingPermissionRequest,
  PermissionDefault,
  PermissionRule,
  PermissionSetting
} from './types.js'

const SETTING_ORDER: readonly PermissionSetting[] = [
  'ask',
  ...PERMISSION_SETTINGS.filter((value): value is PermissionSetting => value !== 'ask')
]
const STATE_VARIANT: Readonly<Record<PermissionSetting, string>> = {
  allow: ' badge-success',
  block: ' badge-danger',
  ask: ''
}
const FILTER_ALL = 'all'

const siteSearch = requiredById<HTMLInputElement>('site-search')
const typeFilterEl = requiredById<HTMLSelectElement>('type-filter')
const listHost = requiredById<HTMLElement>('list')
const pendingHost = requiredById<HTMLElement>('pending')
const pendingSection = requiredById<HTMLElement>('pending-section')
const pendingCount = requiredById<HTMLElement>('pending-count')
const rulesCount = requiredById<HTMLElement>('rules-count')
const defaultsHost = requiredById<HTMLElement>('defaults')
const defaultsCount = requiredById<HTMLElement>('defaults-count')
const bulkBar = requiredById<HTMLElement>('bulk-bar')
const selectAll = requiredById<HTMLInputElement>('select-all')
const bulkCount = requiredById<HTMLElement>('bulk-count')
const bulkButtons = [
  requiredById<HTMLButtonElement>('bulk-allow'),
  requiredById<HTMLButtonElement>('bulk-block'),
  requiredById<HTMLButtonElement>('bulk-clear'),
  requiredById<HTMLButtonElement>('bulk-clear-sites')
] as const

let rules: PermissionRule[] = []
let pending: PendingPermissionRequest[] = []
let defaults: PermissionDefault[] = []
let siteQuery = ''
let typeFilter = FILTER_ALL
const selected = new Set<string>()

initTheme()

function siteQueryKey(text?: string): string {
  let value = typeof text === 'string' ? text.trim().toLowerCase() : ''
  if (!value) return ''
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.split(/[/:?#]/)[0]
  return value.replace(/^www\./, '')
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.domain}::${rule.permissionType}`
}

function visibleRules(): PermissionRule[] {
  const query = siteQueryKey(siteQuery)
  return rules.filter((rule) => {
    if (query && !rule.domain.toLowerCase().includes(query)) return false
    if (typeFilter !== FILTER_ALL && permissionLabel(rule.permissionType) !== typeFilter) return false
    return true
  })
}

function buildTypeFilter(): void {
  typeFilterEl.textContent = ''
  const all = document.createElement('option')
  all.value = FILTER_ALL
  all.textContent = '全部权限'
  typeFilterEl.appendChild(all)
  for (const label of permissionFilterOptions()) {
    const option = document.createElement('option')
    option.value = label
    option.textContent = label
    typeFilterEl.appendChild(option)
  }
}

function buildRuleRow(rule: PermissionRule): HTMLElement {
  const row = el('div', 'row perm-row')
  const key = ruleKey(rule)
  const check = el('input', 'perm-check')
  check.type = 'checkbox'
  check.checked = selected.has(key)
  check.setAttribute('aria-label', `选择 ${rule.domain} 的「${permissionLabel(rule.permissionType)}」规则`)
  check.onchange = () => {
    if (check.checked) selected.add(key)
    else selected.delete(key)
    syncBulkBar()
  }
  row.appendChild(check)

  row.appendChild(el('span', 'col-site', rule.domain))
  const typeCell = el('span', 'col-type', permissionLabel(rule.permissionType))
  if (rule.sensitive) typeCell.appendChild(el('span', 'badge badge-danger', '敏感'))
  row.appendChild(typeCell)
  row.appendChild(el('span', `badge${STATE_VARIANT[rule.setting]}`, PERMISSION_SETTING_LABELS[rule.setting]))

  const actions = el('div', 'actions')
  for (const [setting, label] of PERMISSION_SETTING_ACTIONS) {
    if (setting !== 'allow' && setting !== 'block') continue
    const button = el('button', `btn btn-mini${rule.setting === setting ? ' is-active' : ''}`, label)
    button.title = `设为${label}`
    button.onclick = () => { void applySetting(rule, setting) }
    actions.appendChild(button)
  }
  const clear = el('button', 'btn btn-mini', '清除')
  clear.title = '清除该规则（回到「询问」）'
  clear.onclick = () => { void clearRule(rule) }
  actions.appendChild(clear)
  row.appendChild(actions)
  return row
}

function renderRules(): void {
  const visible = visibleRules()
  rulesCount.textContent = rules.length === 0
    ? ''
    : visible.length === rules.length
      ? `共 ${rules.length} 条`
      : `显示 ${visible.length} / 共 ${rules.length} 条`

  if (visible.length === 0) {
    let message = '还没有任何已保存的站点权限'
    if (typeFilter !== FILTER_ALL) message = '没有符合筛选条件的权限记录'
    else if (siteQueryKey(siteQuery)) message = '该站点没有已保存的权限'
    renderEmpty(listHost, message)
    syncBulkBar()
    return
  }

  listHost.textContent = ''
  const fragment = document.createDocumentFragment()
  for (const rule of visible) fragment.appendChild(buildRuleRow(rule))
  listHost.appendChild(fragment)
  syncBulkBar()
}

function buildPendingRow(request: PendingPermissionRequest): HTMLElement {
  const row = el('div', 'row pending-row')
  const text = el('span', 'pending-text', `${hostOfOrigin(request.origin)} 请求使用「${permissionLabel(request.type)}」`)
  text.title = `${request.origin || hostOfOrigin(request.origin)} 请求使用「${permissionLabel(request.type)}」`
  if (request.sensitive) text.appendChild(el('span', 'badge badge-danger', '敏感'))
  row.appendChild(text)

  const actions = el('div', 'actions')
  for (const choice of PERMISSION_CHOICES) {
    const button = el('button', `btn btn-mini btn-mini--${choice.key}`, choice.label)
    button.type = 'button'
    button.title = choice.hint
    button.onclick = () => { void respondToRequest(request, choice.allow, choice.persist) }
    actions.appendChild(button)
  }
  row.appendChild(actions)
  return row
}

function renderPending(): void {
  const hasPending = pending.length > 0
  pendingSection.hidden = !hasPending
  pendingCount.textContent = hasPending ? String(pending.length) : ''
  pendingHost.textContent = ''
  if (!hasPending) return
  const fragment = document.createDocumentFragment()
  for (const request of pending) fragment.appendChild(buildPendingRow(request))
  pendingHost.appendChild(fragment)
}

function buildDefaultRow(item: PermissionDefault): HTMLElement {
  const row = el('div', 'row default-row')
  const name = el('span', 'default-name', permissionLabel(item.permissionType))
  if (item.sensitive) name.appendChild(el('span', 'badge badge-danger', '敏感'))
  row.appendChild(name)

  const select = el('select', 'perm-select default-select')
  select.setAttribute('aria-label', `「${permissionLabel(item.permissionType)}」的默认行为`)
  for (const value of SETTING_ORDER) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = PERMISSION_SETTING_LABELS[value]
    option.selected = item.setting === value
    select.appendChild(option)
  }
  select.onchange = () => {
    const setting = SETTING_ORDER.find((value) => value === select.value)
    if (setting) void applyDefault(item, setting)
  }
  row.appendChild(select)
  return row
}

function renderDefaults(): void {
  defaultsCount.textContent = defaults.length > 0 ? String(defaults.length) : ''
  defaultsHost.textContent = ''
  const fragment = document.createDocumentFragment()
  for (const item of defaults) fragment.appendChild(buildDefaultRow(item))
  defaultsHost.appendChild(fragment)
}

async function applyDefault(item: PermissionDefault, setting: PermissionSetting): Promise<void> {
  if (item.sensitive && setting === 'allow') {
    const ok = window.confirm(
      `「${permissionLabel(item.permissionType)}」属于敏感权限。\n\n` +
      '设为「允许」后，所有未单独设置的站点都将直接使用该权限、不再询问。确定继续吗？'
    )
    if (!ok) {
      renderDefaults()
      return
    }
  }

  const previous = item.setting
  item.setting = setting
  renderDefaults()
  try {
    const result = await permissionsClient.setDefault(item.permissionType, setting)
    if (!result.ok) throw new Error('permission setting rejected')
  } catch {
    item.setting = previous
    await refreshDefaults()
  }
}

function syncBulkBar(): void {
  const visible = visibleRules()
  const visibleKeys = visible.map(ruleKey)
  const selectedVisible = visibleKeys.filter((key) => selected.has(key))
  bulkCount.textContent = `已选 ${selected.size} 条`
  bulkBar.hidden = selected.size === 0
  selectAll.disabled = visibleKeys.length === 0
  selectAll.checked = visibleKeys.length > 0 && selectedVisible.length === visibleKeys.length
  selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleKeys.length
  const hasSelection = selected.size > 0
  for (const button of bulkButtons) button.disabled = !hasSelection
}

function toggleSelectVisible(): void {
  const keys = visibleRules().map(ruleKey)
  const allSelected = keys.length > 0 && keys.every((key) => selected.has(key))
  for (const key of keys) {
    if (allSelected) selected.delete(key)
    else selected.add(key)
  }
  renderRules()
}

function selectedRules(): PermissionRule[] {
  return rules.filter((rule) => selected.has(ruleKey(rule)))
}

async function bulkSet(setting: 'allow' | 'block'): Promise<void> {
  const targets = selectedRules()
  if (targets.length === 0) return
  if (setting === 'allow') {
    const sensitiveCount = targets.filter((rule) => rule.sensitive).length
    if (sensitiveCount > 0 && !window.confirm(
      `所选规则包含 ${sensitiveCount} 条敏感权限（如摄像头和麦克风、位置信息）。\n\n` +
      '确定将它们全部设为「允许」吗？'
    )) return
  }

  for (const rule of targets) rule.setting = setting
  renderRules()
  await Promise.allSettled(targets.map((rule) => permissionsClient.setRule(rule, setting)))
  await refreshRules()
}

async function bulkClear(): Promise<void> {
  const targets = selectedRules()
  if (targets.length === 0) return
  const keys = new Set(targets.map(ruleKey))
  rules = rules.filter((rule) => !keys.has(ruleKey(rule)))
  selected.clear()
  renderRules()
  await Promise.allSettled(targets.map((rule) => permissionsClient.removeRule(rule)))
  await refreshRules()
}

async function bulkClearSites(): Promise<void> {
  const targets = selectedRules()
  if (targets.length === 0) return
  const domains = [...new Set(targets.map((rule) => rule.domain))]
  if (!window.confirm(
    `将清除 ${domains.length} 个站点名下的全部权限规则（不限于当前勾选的条目）。\n\n确定继续吗？`
  )) return

  selected.clear()
  renderRules()
  await permissionsClient.clearSiteRules(domains).catch(() => undefined)
  await refreshRules()
}

async function applySetting(rule: PermissionRule, setting: 'allow' | 'block'): Promise<void> {
  const previous = rule.setting
  rule.setting = setting
  renderRules()
  try {
    const result = await permissionsClient.setRule(rule, setting)
    if (!result.ok) throw new Error('permission setting rejected')
  } catch {
    rule.setting = previous
    await refreshRules()
  }
}

async function clearRule(rule: PermissionRule): Promise<void> {
  rules = rules.filter((item) => item !== rule)
  selected.delete(ruleKey(rule))
  renderRules()
  try {
    const result = await permissionsClient.removeRule(rule)
    if (!result.ok) throw new Error('permission removal rejected')
  } catch {
    await refreshRules()
  }
}

async function respondToRequest(request: PendingPermissionRequest, allow: boolean, persist: boolean): Promise<void> {
  let accepted = false
  try {
    const result = await permissionsClient.respond(request, allow, persist)
    accepted = result.ok
  } catch (error) {
    console.error('[permissions] respond failed:', error)
  } finally {
    await refreshPending()
    if (accepted) await refreshRules()
  }
}

async function refreshRules(): Promise<void> {
  try {
    rules = await permissionsClient.listRules()
    const alive = new Set(rules.map(ruleKey))
    for (const key of selected) {
      if (!alive.has(key)) selected.delete(key)
    }
  } catch (error) {
    console.error('[permissions] load rules failed:', error)
    rules = []
  }
  renderRules()
}

async function refreshPending(): Promise<void> {
  try {
    pending = await permissionsClient.listPending()
  } catch (error) {
    console.error('[permissions] load pending failed:', error)
    pending = []
  }
  renderPending()
}

async function refreshDefaults(): Promise<void> {
  try {
    defaults = await permissionsClient.listDefaults()
  } catch (error) {
    console.error('[permissions] load defaults failed:', error)
    defaults = []
  }
  renderDefaults()
}

async function refresh(): Promise<void> {
  await Promise.all([refreshRules(), refreshPending(), refreshDefaults()])
}

siteSearch.addEventListener('input', (event) => {
  siteQuery = (event.currentTarget as HTMLInputElement).value
  renderRules()
})
typeFilterEl.addEventListener('change', (event) => {
  typeFilter = (event.currentTarget as HTMLSelectElement).value || FILTER_ALL
  renderRules()
})
requiredById<HTMLButtonElement>('refresh').onclick = () => { void refresh() }
selectAll.onchange = toggleSelectVisible
bulkButtons[0].onclick = () => { void bulkSet('allow') }
bulkButtons[1].onclick = () => { void bulkSet('block') }
bulkButtons[2].onclick = () => { void bulkClear() }
bulkButtons[3].onclick = () => { void bulkClearSites() }

subscribe(IPC_EVENTS.permissionRequest, () => { void refreshPending() })
subscribe(IPC_EVENTS.permissionCleared, () => { void refresh() })

buildTypeFilter()
void refresh()
