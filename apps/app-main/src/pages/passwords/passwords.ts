import { el, fmtTime, initTheme, renderEmpty } from 'hira://shared/runtime.js'
import { mountTabs } from 'hira://shared/tabs.js'
import { createDisclosure } from 'hira://shared/disclosure.js'
import { requiredById } from 'hira://shared/page-kit.js'
import { generatePassword } from '@hira-ng/shared-types/src/password-generator.mjs'
import { buildBackendStatus } from './backend-status.js'
import { passwordsClient } from './client.js'
import type {
  CredentialSecret,
  KnownPasswordAuditKind,
  PasswordAuditKind,
  PasswordBackend,
  SavedCredential
} from './types.js'

const BACKEND_LABELS: Readonly<Record<string, string>> = {
  builtin: '内置保险库',
  bitwarden: 'Bitwarden',
  '1password': '1Password',
  keychain: '系统钥匙串'
}

const ISSUE_LABELS: Readonly<Record<KnownPasswordAuditKind, string>> = {
  empty: '没有可用密码',
  common: '常见弱密码',
  weak: '强度不足',
  reused: '重复使用',
  breached: '已泄漏'
}

const backendsHost = requiredById<HTMLElement>('backends')
const listHost = requiredById<HTMLElement>('list')
const neverHost = requiredById<HTMLElement>('never')
const auditHost = requiredById<HTMLElement>('audit-result')
const countEl = requiredById<HTMLElement>('count')
const backendCountEl = requiredById<HTMLElement>('backend-count')
const neverCountEl = requiredById<HTMLElement>('never-count')
const auditCountEl = requiredById<HTMLElement>('audit-count')
const sitesNoteEl = requiredById<HTMLElement>('sites-note')
const auditNoteEl = requiredById<HTMLElement>('audit-note')
const filterInput = requiredById<HTMLInputElement>('filter')
const neverInput = requiredById<HTMLInputElement>('never-input')
const neverAddButton = requiredById<HTMLButtonElement>('never-add')
const auditButton = requiredById<HTMLButtonElement>('audit')
const addButton = requiredById<HTMLButtonElement>('add-password')
const importButton = requiredById<HTMLButtonElement>('import-passwords')
const exportButton = requiredById<HTMLButtonElement>('export-passwords')
const importFile = requiredById<HTMLInputElement>('password-file')
const editor = requiredById<HTMLFormElement>('credential-editor')
const editorTitle = requiredById<HTMLElement>('editor-title')
const editorDomain = requiredById<HTMLInputElement>('editor-domain')
const editorUsername = requiredById<HTMLInputElement>('editor-username')
const editorPassword = requiredById<HTMLInputElement>('editor-password')
const editorStrength = requiredById<HTMLElement>('editor-strength')
const editorToggle = requiredById<HTMLButtonElement>('editor-toggle')
const editorGenerate = requiredById<HTMLButtonElement>('editor-generate')
const editorClose = requiredById<HTMLButtonElement>('editor-close')
const noticeEl = requiredById<HTMLElement>('password-notice')

const auditById = new Map<string, PasswordAuditKind[]>()
const openSites = new Set<string>()
let credentialItems: SavedCredential[] = []
let activeBackend: PasswordBackend | null = null
let filterText = ''
let editingId: string | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null
let revealedTimer: ReturnType<typeof setTimeout> | null = null
let revealedSecretEl: HTMLElement | null = null
let revealedToggle: HTMLButtonElement | null = null

initTheme()
mountTabs(
  requiredById<HTMLElement>('pw-tabs'),
  document.querySelectorAll<HTMLElement>('[data-panel]'),
  { initial: 'sites' }
)

function siteOf(credential: SavedCredential): string {
  return credential.domain || '(未知站点)'
}

function setNotice(message: string): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeEl.textContent = message
  if (message) noticeTimer = setTimeout(() => { noticeEl.textContent = '' }, 4000)
}

function hideRevealedSecret(): void {
  if (revealedTimer) clearTimeout(revealedTimer)
  revealedTimer = null
  revealedSecretEl?.remove()
  if (revealedToggle) revealedToggle.textContent = '显示密码'
  revealedSecretEl = null
  revealedToggle = null
}

async function copyText(value: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    setNotice(success)
  } catch {
    const area = document.createElement('textarea')
    area.value = value
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    setNotice(success)
  }
}

function updateEditorStrength(): void {
  const value = editorPassword.value
  const score = value.length < 8 ? 0 : Math.min(4,
    (value.length >= 12 ? 1 : 0) +
    (/[a-z]/.test(value) && /[A-Z]/.test(value) ? 1 : 0) +
    (/\d/.test(value) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(value) ? 1 : 0))
  editorStrength.textContent = value ? `强度 ${['极弱', '弱', '中', '强', '极强'][score]} · ${value.length} 位` : ''
}

function closeEditor(): void {
  editingId = null
  editor.hidden = true
  editor.reset()
  editorPassword.type = 'password'
  editorToggle.textContent = '显示'
  editorStrength.textContent = ''
}

async function openEditor(credential?: SavedCredential): Promise<void> {
  editor.hidden = false
  editingId = credential?.id || null
  editorTitle.textContent = credential ? '编辑密码' : '新增密码'
  if (credential) {
    const secret = await passwordsClient.revealCredential(credential.id).catch(() => null)
    if (!secret) {
      closeEditor()
      setNotice('无法读取凭据，它可能已被删除或加密数据损坏。')
      return
    }
    editorDomain.value = secret.domain
    editorUsername.value = secret.username
    editorPassword.value = secret.password
  } else {
    editorDomain.value = ''
    editorUsername.value = ''
    editorPassword.value = generatePassword({ length: 20 })
  }
  editorPassword.type = 'password'
  editorToggle.textContent = '显示'
  updateEditorStrength()
  editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  editorDomain.focus()
}

async function readSecret(id: string): Promise<CredentialSecret | null> {
  const secret = await passwordsClient.revealCredential(id).catch(() => null)
  if (!secret) setNotice('无法读取密码，请刷新后重试。')
  return secret
}

function groupBySite(items: readonly SavedCredential[]): Array<[string, SavedCredential[]]> {
  const groups = new Map<string, SavedCredential[]>()
  for (const credential of items) {
    const site = siteOf(credential)
    const bucket = groups.get(site)
    if (bucket) bucket.push(credential)
    else groups.set(site, [credential])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([site, bucket]) => [
      site,
      bucket.sort((a, b) => a.username.localeCompare(b.username))
    ])
}

function buildBackendRow(backend: PasswordBackend, refresh: () => Promise<void>): HTMLElement {
  const row = el('div', 'row')
  const info = el('div', 'info')
  info.appendChild(el('div', 'name', BACKEND_LABELS[backend.name] || backend.name))

  const badges = el('div', 'backend-badges')
  const badge = el('span', 'badge' + (backend.active ? ' badge-accent' : '') + (!backend.available ? ' badge-danger' : ''))
  badge.textContent = backend.active ? '使用中' : !backend.available ? '不可用' : '可用'
  badges.appendChild(badge)

  if (!backend.writable) {
    const readOnly = el('span', 'badge', '只读')
    readOnly.title = '仅用于自动填充；保存与删除会写入内置保险库'
    badges.appendChild(readOnly)
  }
  info.appendChild(badges)

  const statusBlock = buildBackendStatus(backend, refresh)
  if (statusBlock) info.appendChild(statusBlock)
  row.appendChild(info)

  if (!backend.active && backend.available) {
    const use = el('button', 'btn', '启用')
    use.onclick = async () => {
      await passwordsClient.setActive(backend.name).catch(() => undefined)
      await refresh()
    }
    row.appendChild(use)
  }
  return row
}

function buildCredentialRow(credential: SavedCredential, refresh: () => Promise<void>): HTMLElement {
  const row = el('div', 'row pw-cred')
  const info = el('div', 'info')
  info.appendChild(el('div', 'name', credential.username || '(无用户名)'))
  const meta = [credential.manager]
  if (credential.lastUsedAt) meta.push('最近使用 ' + fmtTime(credential.lastUsedAt))
  info.appendChild(el('div', 'meta', meta.filter(Boolean).join(' · ')))

  const issues = auditById.get(credential.id)
  if (issues?.length) {
    const warn = el('span', 'badge badge-danger', '⚠ ' + issues.map((kind) => ISSUE_LABELS[kind as KnownPasswordAuditKind] || kind).join(' / '))
    warn.style.marginTop = '4px'
    info.appendChild(warn)
  }
  row.appendChild(info)

  const actions = el('div', 'pw-cred__actions')
  const copyUser = el('button', 'pw-action', '复制账号')
  copyUser.type = 'button'
  copyUser.onclick = () => { void copyText(credential.username, '账号已复制') }
  actions.appendChild(copyUser)

  const show = el('button', 'pw-action', '显示密码')
  show.type = 'button'
  show.onclick = () => {
    const current = info.querySelector('.pw-cred__secret')
    if (current) {
      hideRevealedSecret()
      return
    }
    void readSecret(credential.id).then((secret) => {
      if (!secret) return
      hideRevealedSecret()
      const value = el('div', 'pw-cred__secret', secret.password)
      info.appendChild(value)
      revealedSecretEl = value
      revealedToggle = show
      show.textContent = '隐藏密码'
      revealedTimer = setTimeout(hideRevealedSecret, 30000)
    })
  }
  actions.appendChild(show)

  const copyPassword = el('button', 'pw-action', '复制密码')
  copyPassword.type = 'button'
  copyPassword.onclick = () => {
    void readSecret(credential.id).then((secret) => {
      if (secret) void copyText(secret.password, '密码已复制')
    })
  }
  actions.appendChild(copyPassword)

  const edit = el('button', 'pw-action', '编辑')
  edit.type = 'button'
  edit.onclick = () => { void openEditor(credential) }
  actions.appendChild(edit)

  const remove = el('button', 'icon-btn', '\u2715')
  remove.title = '删除该凭据'
  remove.onclick = async () => {
    if (!window.confirm(`删除 ${credential.domain} 的账号 ${credential.username || '(无用户名)'}？`)) return
    const result = await passwordsClient.deleteCredential(credential.id).catch(() => null)
    setNotice(result?.ok ? '已删除凭据' : '删除失败，请重试')
    await refresh()
  }
  actions.appendChild(remove)
  row.appendChild(actions)
  return row
}

function buildNeverRow(hostname: string, refresh: () => Promise<void>): HTMLElement {
  const row = el('div', 'row')
  const info = el('div', 'info')
  info.appendChild(el('div', 'name', hostname))
  row.appendChild(info)
  const remove = el('button', 'icon-btn', '\u2715')
  remove.title = '不再忽略该站点'
  remove.onclick = async () => {
    await passwordsClient.removeNeverSave(hostname).catch(() => undefined)
    await refresh()
  }
  row.appendChild(remove)
  return row
}

function buildSiteGroup(
  site: string,
  bucket: SavedCredential[],
  open: boolean,
  refresh: () => Promise<void>
): HTMLElement {
  const group = createDisclosure({
    title: site,
    count: bucket.length,
    open,
    onToggle(next) {
      if (next) openSites.add(site)
      else openSites.delete(site)
    }
  })
  group.head.title = site
  for (const credential of bucket) group.body.appendChild(buildCredentialRow(credential, refresh))
  return group.root
}

function renderCredentials(): void {
  hideRevealedSecret()
  const query = filterText.toLowerCase()
  const visible = query
    ? credentialItems.filter((credential) =>
        `${siteOf(credential)} ${credential.username} ${credential.manager}`.toLowerCase().includes(query))
    : credentialItems

  countEl.textContent = credentialItems.length ? String(credentialItems.length) : ''
  const siteCount = new Set(visible.map(siteOf)).size
  sitesNoteEl.textContent = query
    ? `显示 ${visible.length} / 共 ${credentialItems.length} 条 · ${siteCount} 个站点`
    : credentialItems.length ? `共 ${credentialItems.length} 条 · ${siteCount} 个站点` : ''

  const live = new Set(credentialItems.map(siteOf))
  for (const site of openSites) {
    if (!live.has(site)) openSites.delete(site)
  }

  listHost.textContent = ''
  if (visible.length === 0) {
    if (query) renderEmpty(listHost, '没有匹配的密码。')
    else if (activeBackend && !activeBackend.writable) {
      renderEmpty(listHost, '当前后端为只读集成，只用于自动填充；新保存的密码会进入内置保险库。')
    } else {
      renderEmpty(listHost, '还没有保存任何密码。')
    }
    return
  }

  const fragment = document.createDocumentFragment()
  for (const [site, bucket] of groupBySite(visible)) {
    fragment.appendChild(buildSiteGroup(site, bucket, query ? true : openSites.has(site), refresh))
  }
  listHost.appendChild(fragment)
}

async function refresh(): Promise<void> {
  const [backends, credentials, neverDomains] = await Promise.all([
    passwordsClient.listBackends().catch((): PasswordBackend[] => []),
    passwordsClient.listCredentials().catch((): SavedCredential[] => []),
    passwordsClient.listNeverSave().catch((): string[] => [])
  ])

  backendCountEl.textContent = backends.length ? String(backends.length) : ''
  backendsHost.textContent = ''
  if (backends.length === 0) {
    renderEmpty(backendsHost, '没有可用的密码后端')
  } else {
    for (const backend of backends) backendsHost.appendChild(buildBackendRow(backend, refresh))
  }

  credentialItems = credentials
  activeBackend = backends.find((backend) => backend.active) || null
  renderCredentials()

  neverCountEl.textContent = neverDomains.length ? String(neverDomains.length) : ''
  neverHost.textContent = ''
  if (neverDomains.length === 0) {
    renderEmpty(neverHost, '没有忽略任何站点。')
  } else {
    for (const hostname of neverDomains) neverHost.appendChild(buildNeverRow(hostname, refresh))
  }
}

async function runAudit(): Promise<void> {
  auditButton.disabled = true
  auditButton.textContent = '检查中…'
  try {
    const result = await passwordsClient.audit()
    auditById.clear()
    for (const issue of result.issues) auditById.set(issue.id, issue.kinds)

    auditHost.textContent = ''
    if (result.unsupported) {
      auditCountEl.textContent = ''
      auditNoteEl.textContent = ''
      renderEmpty(auditHost, '当前密码后端不支持本地检查。')
    } else if (result.issues.length === 0) {
      auditCountEl.textContent = ''
      auditNoteEl.textContent = result.checked > 0
        ? `已检查 ${result.checked} 条，未发现问题。`
        : '还没有可检查的密码。'
      renderEmpty(auditHost, result.checked > 0 ? '未发现问题。' : '还没有可检查的密码。')
    } else {
      auditCountEl.textContent = String(result.issues.length)
      auditNoteEl.textContent = `发现 ${result.issues.length} 条问题`
      for (const issue of result.issues) {
        const row = el('div', 'row')
        const info = el('div', 'info')
        info.appendChild(el('div', 'name', issue.domain || '(未知站点)'))
        const kinds = issue.kinds.map((kind) => ISSUE_LABELS[kind as KnownPasswordAuditKind] || kind).join(' / ')
        info.appendChild(el('div', 'meta', [issue.username || '(无用户名)', kinds].filter(Boolean).join(' · ')))
        row.appendChild(info)
        auditHost.appendChild(row)
      }
    }
  } catch {
    auditById.clear()
    auditCountEl.textContent = ''
    auditNoteEl.textContent = ''
    renderEmpty(auditHost, '检查失败，请稍后重试。')
  } finally {
    auditButton.disabled = false
    auditButton.textContent = '开始检查'
  }
  await refresh()
}

requiredById<HTMLButtonElement>('refresh').onclick = () => { void refresh() }
filterInput.addEventListener('input', (event: Event) => {
  const target = event.currentTarget
  filterText = target instanceof HTMLInputElement ? target.value.trim() : ''
  renderCredentials()
})
neverAddButton.onclick = async () => {
  const hostname = neverInput.value.trim()
  if (!hostname) {
    neverInput.focus()
    return
  }
  await passwordsClient.addNeverSave(hostname).catch(() => undefined)
  neverInput.value = ''
  await refresh()
}
neverInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') neverAddButton.click()
})
auditButton.onclick = () => { void runAudit() }

addButton.onclick = () => { void openEditor() }
editorClose.onclick = closeEditor
editorPassword.addEventListener('input', updateEditorStrength)
editorToggle.onclick = () => {
  editorPassword.type = editorPassword.type === 'password' ? 'text' : 'password'
  editorToggle.textContent = editorPassword.type === 'password' ? '显示' : '隐藏'
}
editorGenerate.onclick = () => {
  try {
    editorPassword.value = generatePassword({ length: 20 })
    editorPassword.type = 'text'
    editorToggle.textContent = '隐藏'
    updateEditorStrength()
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error))
  }
}
editor.addEventListener('submit', (event) => {
  event.preventDefault()
  const hostname = editorDomain.value.trim()
  const username = editorUsername.value.trim()
  const password = editorPassword.value
  if (!hostname || !username) {
    setNotice('请填写网站和用户名。')
    ;(hostname ? editorUsername : editorDomain).focus()
    return
  }
  const saveButton = requiredById<HTMLButtonElement>('editor-save')
  saveButton.disabled = true
  const wasEditing = Boolean(editingId)
  const request = editingId
    ? passwordsClient.updateCredential({ id: editingId, hostname, username, password })
    : passwordsClient.saveCredential({ hostname, username, password })
  void request.then(async (result) => {
    if (!result.ok) {
      setNotice('保存失败；请检查网站域名和本机加密能力。')
      return
    }
    closeEditor()
    setNotice(wasEditing ? '密码已更新' : '密码已保存')
    await refresh()
  }).catch(() => setNotice('保存失败，请稍后重试。')).finally(() => {
    saveButton.disabled = false
  })
})

importButton.onclick = () => importFile.click()
importFile.addEventListener('change', () => {
  const file = importFile.files && importFile.files[0]
  importFile.value = ''
  if (!file) return
  void file.text().then(async (content) => {
    if (!window.confirm(`从 ${file.name} 导入密码？同网站、同用户名的记录会被覆盖。`)) return
    const result = await passwordsClient.importCsv(content)
    if (!result || typeof result !== 'object') throw new Error('invalid import response')
    const data = result as Record<string, unknown>
    if (data.unsupported === true || data.ok === false) {
      setNotice(String(data.reason || '当前后端不支持导入。'))
      return
    }
    const imported = Number(data.imported) || 0
    const merged = Number(data.merged) || 0
    setNotice(`导入完成：新增 ${imported} 条，更新 ${merged} 条`)
    await refresh()
  }).catch(() => setNotice('导入失败；请确认文件是包含 url、username、password 的 CSV。'))
})

exportButton.onclick = () => {
  exportButton.disabled = true
  void passwordsClient.exportCsv().then((result) => {
    if (result.canceled) return
    setNotice(result.ok ? `已导出 ${result.count || 0} 条密码` : '没有可导出的内置密码。')
  }).catch(() => setNotice('导出失败，请稍后重试。')).finally(() => {
    exportButton.disabled = false
  })
}

void refresh().catch((error) => {
  console.error('[passwords] load failed:', error)
})
