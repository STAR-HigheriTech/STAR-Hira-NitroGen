import {
  IPC_ROUTES,
  IPC_EVENTS,
  rpc,
  subscribe,
  el,
  hideOnError,
  renderEmpty,
  initTheme,
  type PageRpcRecord
} from 'hira://shared/runtime.js'
import { extensionStatusLabel } from 'hira://shared/extension-labels.mjs'
import { EXTENSIONS_SETTING_KEYS } from 'hira://shared/extensions-settings.mjs'

type ExtensionStatus = 'loaded' | 'disabled' | 'missing' | 'error'
type FeedbackType = 'info' | 'success' | 'error'

interface ExtensionInspectView {
  target: string
  label: string
  url: string
  inspectable: boolean
  note?: string
}

interface ExtensionDiagnostic {
  message?: string
}

interface ExtensionRecord extends PageRpcRecord {
  id: string
  name?: string
  version?: string
  description?: string
  enabled?: boolean
  pinned?: boolean
  runtimeStatus?: ExtensionStatus
  loadError?: string
  iconDataUrl?: string
  iconUrl?: string
  hasOptionsPage?: boolean
  hasPopup?: boolean
  storeUrl?: string
  permissions?: string[]
  inspectViews?: ExtensionInspectView[]
  diagnostics?: ExtensionDiagnostic[]
  size?: string
  path?: string
  source?: 'store' | 'local' | string
  isUnpacked?: boolean
  isV3?: boolean
  manifestVersion?: number
}

interface ActionOptions {
  disabled?: boolean
  title?: string
  danger?: boolean
  onClick?: (button: HTMLButtonElement) => void
}

interface SettingsChange {
  scope?: string
  key?: string
  value?: unknown
}

interface PageState {
  developerMode: boolean
  extensions: ExtensionRecord[]
  expandedId: string | null
  query: string
  loading: boolean
  loadError: string
  refreshSequence: number
  lastSignature: string
}

const DEV_MODE_KEY = EXTENSIONS_SETTING_KEYS.developerMode

function requiredElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`扩展页缺少 #${id}`)
  return node as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (isRecord(error) && error.message !== undefined && error.message !== null) return String(error.message)
  const text = String(error || '')
  return text || fallback
}

initTheme()

const searchInput = requiredElement<HTMLInputElement>('search')
const summaryEl = requiredElement<HTMLSpanElement>('summary')
const listHost = requiredElement<HTMLDivElement>('list')
const importBtn = requiredElement<HTMLButtonElement>('import-btn')
const refreshBtn = requiredElement<HTMLButtonElement>('refresh-btn')
const updateBtn = requiredElement<HTMLButtonElement>('update-btn')
const devModeBtn = requiredElement<HTMLButtonElement>('dev-mode-btn')
const storeBtn = document.getElementById('store-btn')
const CHROME_WEB_STORE_URL = storeBtn instanceof HTMLAnchorElement ? storeBtn.href : ''

const state: PageState = {
  developerMode: false,
  extensions: [],
  expandedId: null,
  query: '',
  loading: true,
  loadError: '',
  refreshSequence: 0,
  lastSignature: ''
}

const sizeCache = new Map<string, string>()
const sizePending = new Set<string>()
const togglingIds = new Set<string>()

let feedbackTimer = 0
let refreshTimer = 0

function showFeedback(message = '', type: FeedbackType = 'info'): void {
  const node = document.getElementById('feedback')
  if (!node) return
  node.textContent = message
  node.dataset.type = type
  node.hidden = false
  window.clearTimeout(feedbackTimer)
  feedbackTimer = window.setTimeout(() => { node.hidden = true }, 2600)
}

async function runAction(
  button: HTMLButtonElement,
  action: () => Promise<unknown>,
  successMessage: string
): Promise<void> {
  if (button.disabled) return
  button.disabled = true
  try {
    const result = await action()
    if (isRecord(result) && result.ok === false) throw new Error('操作未完成')
    showFeedback(successMessage, 'success')
    scheduleRefresh(true)
  } catch (error) {
    showFeedback(errorMessage(error, '操作失败'), 'error')
    scheduleRefresh(true)
  } finally {
    button.disabled = false
  }
}

function signatureOf(list: readonly ExtensionRecord[]): string {
  return list.map((ext) => [
    ext.id,
    ext.name,
    ext.enabled,
    ext.runtimeStatus,
    ext.loadError,
    ext.version,
    ext.pinned,
    ext.hasOptionsPage,
    ext.hasPopup,
    ext.inspectViews?.map((view) => `${view.target}:${view.url}`).join(',') || ''
  ].join('\u0001')).join('\u0002')
}

function manifestLabel(ext: ExtensionRecord): 'MV3' | 'MV2' | undefined {
  if (ext.isV3 === true || ext.manifestVersion === 3) return 'MV3'
  if (ext.manifestVersion === 2) return 'MV2'
  return undefined
}

function sourceLabel(ext: ExtensionRecord): string {
  const base = ext.source === 'store' ? '商店扩展' : '本地扩展'
  return ext.isUnpacked && ext.source !== 'store' ? `${base}（已解压）` : base
}

function rectOf(node: HTMLElement): { x: number; y: number; width: number; height: number } | null {
  try {
    const rect = node.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  } catch {
    return null
  }
}

function buildStoreLink(label: string, className?: string): HTMLAnchorElement {
  const link = el('a', className, label)
  link.href = CHROME_WEB_STORE_URL
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.title = '在标签页中打开 Chrome 网上应用店，浏览并安装扩展'
  return link
}

function buildPermissions(ext: ExtensionRecord): HTMLElement {
  const wrap = el('div', 'item-detail-value ext-perms')
  const names = Array.isArray(ext.permissions) ? ext.permissions.filter(Boolean) : []
  if (!names.length) {
    wrap.textContent = '无'
    return wrap
  }
  const list = el('ul', 'ext-perm-list')
  for (const name of names) list.appendChild(el('li', undefined, String(name)))
  wrap.appendChild(list)
  return wrap
}

function diagnosticsLabel(ext: ExtensionRecord): string {
  const messages = (Array.isArray(ext.diagnostics) ? ext.diagnostics : [])
    .map((item) => item.message)
    .filter((message): message is string => Boolean(message))
  return messages.length ? messages.join('；') : '无'
}

function buildInspectViewList(ext: ExtensionRecord, views: readonly ExtensionInspectView[]): HTMLElement {
  const wrap = el('div', 'ext-inspect-list')
  for (const view of views) {
    const row = el('div', 'ext-inspect-item')
    if (view.inspectable) {
      row.appendChild(buildAction(view.label, {
        title: `在开发者工具中打开“${view.label}”（${view.url}）`,
        onClick: (button) => {
          void runAction(
            button,
            () => rpc(IPC_ROUTES.extensionInspectView, { id: ext.id, target: view.target }),
            `已打开“${view.label}”的开发者工具`
          )
        }
      }))
    } else {
      const label = el('span', 'ext-inspect-static', view.label)
      label.title = view.note || `${view.label}无法在此打开开发者工具`
      row.appendChild(label)
    }
    if (view.url) row.appendChild(el('span', 'ext-inspect-url', view.url))
    if (view.note) row.appendChild(el('span', 'ext-inspect-note', view.note))
    wrap.appendChild(row)
  }
  return wrap
}

function sizeOf(ext: ExtensionRecord): string {
  return sizeCache.get(ext.id) || ''
}

async function loadSize(ext: ExtensionRecord): Promise<void> {
  if (sizeCache.has(ext.id) || sizePending.has(ext.id)) return
  sizePending.add(ext.id)
  try {
    const value = await rpc<unknown>(IPC_ROUTES.extensionList, { includeSize: [ext.id] })
    const items = Array.isArray(value) ? value : []
    const found = items.find((item) => isRecord(item) && item.id === ext.id)
    const size = found && isRecord(found) && typeof found.size === 'string' ? found.size : ''
    if (size) {
      sizeCache.set(ext.id, size)
      if (state.expandedId === ext.id) render()
    }
  } catch {
    // 大小是增强信息，读取失败不阻塞详情。
  } finally {
    sizePending.delete(ext.id)
  }
}

function setSwitchVisual(sw: HTMLButtonElement, enabled: boolean, name: string): void {
  sw.setAttribute('aria-checked', String(enabled))
  sw.title = enabled ? `停用“${name}”` : `启用“${name}”`
  sw.setAttribute('aria-label', sw.title)
}

function buildSwitch(ext: ExtensionRecord): HTMLButtonElement {
  const enabled = ext.enabled !== false
  const name = ext.name || ext.id
  const sw = el('button', 'switch')
  sw.type = 'button'
  sw.setAttribute('role', 'switch')
  setSwitchVisual(sw, enabled, name)

  sw.addEventListener('click', () => {
    void (async () => {
      if (togglingIds.has(ext.id)) return
      togglingIds.add(ext.id)
      const next = sw.getAttribute('aria-checked') !== 'true'
      setSwitchVisual(sw, next, name)
      try {
        const result = await rpc<unknown>(IPC_ROUTES.extensionToggle, { id: ext.id, enabled: next })
        if (isRecord(result) && result.ok === false) throw new Error('操作未完成')
        showFeedback(next ? '扩展已启用' : '扩展已停用', 'success')
        scheduleRefresh(false)
      } catch (error) {
        setSwitchVisual(sw, !next, name)
        showFeedback(errorMessage(error, '操作失败'), 'error')
        scheduleRefresh(false)
      } finally {
        togglingIds.delete(ext.id)
      }
    })()
  })
  return sw
}

function buildAction(label: string, { disabled = false, title = '', danger = false, onClick }: ActionOptions = {}): HTMLButtonElement {
  const button = el('button', `btn btn-mini${danger ? ' btn-danger' : ''}`, label)
  button.type = 'button'
  button.title = title || label
  button.setAttribute('aria-label', button.title)
  button.disabled = disabled
  if (onClick) button.addEventListener('click', () => onClick(button))
  return button
}

function buildDetail(ext: ExtensionRecord): HTMLDivElement {
  const panel = el('div', 'item-detail')
  const addField = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return
    const line = el('div', 'item-detail-line')
    line.appendChild(el('span', 'item-detail-label', label))
    line.appendChild(el('span', 'item-detail-value', String(value)))
    panel.appendChild(line)
  }
  const addNode = (label: string, node: Node): void => {
    const line = el('div', 'item-detail-line')
    line.appendChild(el('span', 'item-detail-label', label))
    line.appendChild(node)
    panel.appendChild(line)
  }

  addField('扩展 ID', ext.id)
  addField('版本', ext.version)
  addField('来源', sourceLabel(ext))
  addField('大小', sizeOf(ext))
  addField('描述', ext.description)
  addField('清单版本', manifestLabel(ext))
  addField('安装路径', ext.path)
  addField('加载失败原因', ext.runtimeStatus === 'error' ? ext.loadError || '' : '')
  addNode('权限', buildPermissions(ext))

  if (state.developerMode) {
    const inspectViews = Array.isArray(ext.inspectViews) ? ext.inspectViews : []
    if (inspectViews.length) addNode('检查视图', buildInspectViewList(ext, inspectViews))
    addField('运行时诊断', diagnosticsLabel(ext))
    const reload = el('button', 'btn btn-mini ext-dev-reload', '重新加载')
    reload.type = 'button'
    reload.title = '重新加载该扩展（仅开发者模式）'
    reload.setAttribute('aria-label', `重新加载 ${ext.name || ext.id}`)
    reload.addEventListener('click', () => {
      void runAction(reload, () => rpc(IPC_ROUTES.extensionReload, { id: ext.id }), '扩展已重载')
    })
    panel.appendChild(reload)
  }
  return panel
}

function buildRow(ext: ExtensionRecord): HTMLDivElement {
  const enabled = ext.enabled !== false
  const name = ext.name || ext.id || '未命名扩展'
  const status: ExtensionStatus = ext.runtimeStatus || (enabled ? 'loaded' : 'disabled')
  const row = el('div', `item-row ext-status-${status}`)
  row.dataset.extensionId = ext.id

  const icon = el('img', 'item-icon')
  icon.alt = ''
  const iconSrc = ext.iconDataUrl || ext.iconUrl || ''
  if (iconSrc) icon.src = iconSrc
  else icon.hidden = true
  hideOnError(icon)

  const body = el('div', 'item-body')
  const title = el('div', 'item-head')
  title.appendChild(el('div', 'item-name', name))
  if (ext.pinned === true) title.appendChild(el('span', 'badge badge-accent', '已固定'))
  title.appendChild(el('span', `badge ext-status-${status}`, extensionStatusLabel(status)))
  body.appendChild(title)

  const metaParts: string[] = []
  if (ext.version) metaParts.push(`v${ext.version}`)
  const manifest = manifestLabel(ext)
  if (manifest) metaParts.push(manifest)
  metaParts.push(sourceLabel(ext))
  body.appendChild(el('div', 'item-meta', metaParts.join(' · ')))
  if (ext.description) body.appendChild(el('div', 'item-desc', ext.description))

  const actions = el('div', 'item-actions')
  actions.appendChild(buildSwitch(ext))
  actions.appendChild(buildAction(ext.pinned ? '已固定' : '固定', {
    title: ext.pinned ? `取消固定“${name}”` : `固定“${name}”（显示在工具栏）`,
    onClick: (button) => {
      void runAction(
        button,
        () => rpc(IPC_ROUTES.extensionSetPinned, { id: ext.id, pinned: ext.pinned !== true }),
        ext.pinned ? '已取消固定' : '已固定'
      )
    }
  }))

  actions.appendChild(buildAction('设置', {
    disabled: !enabled || !ext.hasOptionsPage,
    title: !ext.hasOptionsPage
      ? `${name}未提供设置页面`
      : (!enabled ? '扩展已停用，先启用再打开设置页面' : `打开“${name}”的设置页面`),
    onClick: (button) => {
      void runAction(button, () => rpc(IPC_ROUTES.extensionOpenOptions, { id: ext.id }), `已打开“${name}”的设置页面`)
    }
  }))

  actions.appendChild(buildAction('弹窗', {
    disabled: !enabled || !ext.hasPopup,
    title: !ext.hasPopup
      ? `${name}未提供弹出窗口`
      : (!enabled ? '扩展已停用，先启用再打开弹出窗口' : `打开“${name}”的弹出窗口`),
    onClick: (button) => {
      const anchorRect = rectOf(button)
      void runAction(
        button,
        () => rpc(IPC_ROUTES.extensionOpenPopup, anchorRect
          ? { id: ext.id, anchorRect, alignment: 'bottom' }
          : { id: ext.id }),
        `已打开“${name}”的弹出窗口`
      )
    }
  }))

  if (ext.storeUrl) {
    actions.appendChild(buildAction('商店', {
      title: `在标签页中打开“${name}”的商店页面`,
      onClick: (button) => {
        void runAction(button, () => rpc(IPC_ROUTES.extensionOpenStore, { id: ext.id }), `已打开“${name}”的商店页面`)
      }
    }))
  }

  const expanded = state.expandedId === ext.id
  actions.appendChild(buildAction(expanded ? '收起' : '详情', {
    title: expanded ? `收起“${name}”的详情` : `查看“${name}”的详情`,
    onClick: () => {
      state.expandedId = expanded ? null : ext.id
      render()
      if (!expanded) void loadSize(ext)
    }
  }))

  actions.appendChild(buildAction('移除', {
    danger: true,
    title: `卸载“${name}”`,
    onClick: (button) => {
      if (!confirm(`确定卸载“${name}”吗？卸载后需要重新安装才能恢复。`)) return
      void runAction(button, () => rpc(IPC_ROUTES.extensionUninstall, { id: ext.id }), '扩展已卸载')
    }
  }))

  row.append(icon, body, actions)
  if (expanded) row.appendChild(buildDetail(ext))
  return row
}

function renderSummary(visibleCount = 0): void {
  if (state.loadError || !state.extensions.length) {
    summaryEl.textContent = ''
    return
  }
  const enabled = state.extensions.filter((ext) => ext.enabled !== false).length
  let text = `共 ${state.extensions.length} 个扩展 · 已启用 ${enabled} 个`
  if (state.query && visibleCount !== state.extensions.length) text += ` · 匹配 ${visibleCount} 个`
  summaryEl.textContent = text
}

function visibleExtensions(): ExtensionRecord[] {
  const needle = state.query.trim().toLowerCase()
  if (!needle) return state.extensions
  return state.extensions.filter((ext) => String(ext.name || '').toLowerCase().includes(needle))
}

function renderStoreEmpty(): void {
  listHost.textContent = ''
  const box = el('div', 'empty')
  box.appendChild(el('div', 'empty-title', '未安装扩展程序'))
  box.appendChild(el('div', 'empty-hint', '从 Chrome 网上应用店安装扩展，或加载已解压的扩展文件夹（需在设置里开启「允许加载未打包扩展」）。'))
  if (CHROME_WEB_STORE_URL) box.appendChild(buildStoreLink('浏览 Chrome 网上应用店', 'btn btn-primary'))
  listHost.appendChild(box)
}

function render(): void {
  listHost.setAttribute('aria-busy', state.loading ? 'true' : 'false')
  if (state.loading) {
    renderEmpty(listHost, '正在加载扩展…')
    renderSummary()
    return
  }
  if (state.loadError) {
    renderEmpty(listHost, state.loadError)
    renderSummary()
    return
  }
  if (!state.extensions.length) {
    renderStoreEmpty()
    renderSummary()
    return
  }
  const visible = visibleExtensions()
  if (!visible.length) {
    renderEmpty(listHost, '没有匹配的扩展')
    renderSummary()
    return
  }
  const fragment = document.createDocumentFragment()
  for (const ext of visible) fragment.appendChild(buildRow(ext))
  listHost.textContent = ''
  listHost.appendChild(fragment)
  renderSummary(visible.length)
}

async function loadDiagnostics(ext: ExtensionRecord): Promise<ExtensionRecord> {
  try {
    const diagnostics = await rpc<unknown>(IPC_ROUTES.extensionDiagnostics, { id: ext.id })
    return Array.isArray(diagnostics) ? { ...ext, diagnostics: diagnostics as ExtensionDiagnostic[] } : ext
  } catch {
    return ext
  }
}

function asExtensionRecords(value: unknown): ExtensionRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ExtensionRecord => isRecord(item) && typeof item.id === 'string')
}

async function refresh(force = false): Promise<void> {
  const sequence = ++state.refreshSequence
  if (!state.extensions.length) {
    state.loading = true
    render()
  }
  try {
    let items = asExtensionRecords(await rpc<unknown>(IPC_ROUTES.extensionList))
    if (state.developerMode) items = await Promise.all(items.map(loadDiagnostics))
    if (sequence !== state.refreshSequence) return
    state.extensions = items
    state.loadError = ''
  } catch (error) {
    if (sequence !== state.refreshSequence) return
    state.loadError = `加载扩展失败：${errorMessage(error, '未知错误')}`
  } finally {
    if (sequence !== state.refreshSequence) return
    state.loading = false
    const signature = state.loadError
      ? 'error'
      : `${signatureOf(state.extensions)}#${state.developerMode ? 1 : 0}`
    if (force || signature !== state.lastSignature) {
      state.lastSignature = signature
      render()
    } else {
      renderSummary(visibleExtensions().length)
    }
  }
}

function scheduleRefresh(force = false): void {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => { void refresh(force) }, 80)
}

function importFailureHint(error: unknown): string {
  const raw = errorMessage(error, '')
  const hint = /manifest/i.test(raw)
    ? '所选文件夹里没有有效的 manifest.json，请选择扩展的根目录（含 manifest.json 的那一层）'
    : '无法加载该扩展，请确认「设置 → 扩展与插件 → 允许加载未打包扩展」已开启，且所选文件夹是有效的扩展目录'
  return `加载扩展失败：${hint}（${raw}）`
}

function renderDevToggle(): void {
  devModeBtn.textContent = state.developerMode ? '开发者模式：开' : '开发者模式：关'
  devModeBtn.setAttribute('aria-pressed', state.developerMode ? 'true' : 'false')
  updateBtn.hidden = !state.developerMode
}

async function loadDeveloperMode(): Promise<void> {
  try {
    const result = await rpc<PageRpcRecord>(IPC_ROUTES.settingsGet, { key: DEV_MODE_KEY })
    const value = result && typeof result === 'object' && 'value' in result ? result.value : result
    state.developerMode = value === true
  } catch {
    state.developerMode = false
  }
  renderDevToggle()
}

importBtn.addEventListener('click', () => {
  void (async () => {
    if (importBtn.disabled) return
    importBtn.disabled = true
    try {
      const result = await rpc<PageRpcRecord>(IPC_ROUTES.extensionImportFolder)
      if (result?.canceled) return
      showFeedback('扩展已加载', 'success')
      scheduleRefresh(true)
    } catch (error) {
      showFeedback(importFailureHint(error), 'error')
    } finally {
      importBtn.disabled = false
    }
  })()
})

refreshBtn.addEventListener('click', () => { void refresh(true) })
updateBtn.addEventListener('click', () => {
  void runAction(updateBtn, () => rpc(IPC_ROUTES.extensionUpdateAll), '已检查并安装扩展更新')
})

searchInput.addEventListener('input', () => {
  state.query = searchInput.value
  render()
})

devModeBtn.addEventListener('click', () => {
  void (async () => {
    if (devModeBtn.disabled) return
    const next = !state.developerMode
    devModeBtn.disabled = true
    state.developerMode = next
    renderDevToggle()
    try {
      await rpc(IPC_ROUTES.settingsSet, { key: DEV_MODE_KEY, value: next })
    } catch (error) {
      state.developerMode = !next
      renderDevToggle()
      showFeedback(errorMessage(error, '切换开发者模式失败'), 'error')
    } finally {
      devModeBtn.disabled = false
    }
    await refresh(true)
  })()
})

const unsubscribeChanged = subscribe(IPC_EVENTS.extensionChanged, (payload) => {
  const event = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  // 动作徽标 / 当前标签的动态 popup 不改变安装列表；工具栏单独消费，页面不跟着重拉全量。
  if (event.type === 'action-updated') return
  scheduleRefresh(false)
})
const unsubscribeSettings = subscribe<SettingsChange>(IPC_EVENTS.settingsChanged, (change) => {
  if (!change) return
  if (change.scope !== 'all' && change.key !== DEV_MODE_KEY) return
  const next = change.scope === 'all' ? false : change.value === true
  if (next === state.developerMode) return
  state.developerMode = next
  renderDevToggle()
  void refresh(true)
})

window.addEventListener('beforeunload', () => {
  unsubscribeChanged()
  unsubscribeSettings()
  window.clearTimeout(refreshTimer)
  window.clearTimeout(feedbackTimer)
})

void loadDeveloperMode().then(() => refresh(true))
