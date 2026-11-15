import {
  IPC_ROUTES,
  IPC_EVENTS,
  rpc,
  subscribe,
  el,
  renderEmpty,
  initTheme,
  fmtTime,
  faviconProxyUrl,
  type PageRpcRecord
} from 'hira://shared/runtime.js'
import {
  actionError,
  appSignature,
  filterApps,
  hostLabel,
  isRecord,
  isWebUrl,
  kindOf,
  readInstalledApps,
  sourceLabel,
  type InstalledApp
} from './model.js'

type FeedbackType = 'info' | 'success' | 'error'

interface ActionOptions {
  disabled?: boolean
  title?: string
  danger?: boolean
  onClick?: (button: HTMLButtonElement) => void
}

interface SwitchOptions {
  checked: boolean
  label: string
  title: string
  onChange: () => Promise<unknown>
}

interface CheckUpdatesResult extends PageRpcRecord {
  ok?: boolean
  updated?: unknown[]
}

interface PageState {
  apps: InstalledApp[]
  expandedId: string | null
  query: string
  loading: boolean
  loadError: string
  refreshSequence: number
  lastSignature: string
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`应用页缺少 #${id}`)
  return node as T
}

function button(label: string, className = 'btn'): HTMLButtonElement {
  const node = el('button', className, label)
  node.type = 'button'
  return node
}

initTheme()

const searchInput = requiredElement<HTMLInputElement>('search')
const summaryEl = requiredElement<HTMLSpanElement>('summary')
const listHost = requiredElement<HTMLDivElement>('list')
const feedbackEl = requiredElement<HTMLDivElement>('feedback')
const refreshBtn = requiredElement<HTMLButtonElement>('refresh-btn')
const checkBtn = requiredElement<HTMLButtonElement>('check-btn')

const state: PageState = {
  apps: [],
  expandedId: null,
  query: '',
  loading: true,
  loadError: '',
  refreshSequence: 0,
  lastSignature: ''
}

let feedbackTimer = 0
let refreshTimer = 0

function showFeedback(message: string, type: FeedbackType = 'info'): void {
  feedbackEl.textContent = message
  feedbackEl.dataset.type = type
  feedbackEl.hidden = !message
  window.clearTimeout(feedbackTimer)
  if (message) feedbackTimer = window.setTimeout(() => { feedbackEl.hidden = true }, 2800)
}

async function runAction(buttonEl: HTMLButtonElement, action: () => Promise<unknown>, successMessage: string): Promise<void> {
  if (buttonEl.disabled) return
  buttonEl.disabled = true
  buttonEl.dataset.busy = 'true'
  try {
    const result = await action()
    if (isRecord(result) && result.ok === false) {
      const failures = Array.isArray(result.failures) ? result.failures : []
      const firstFailure = failures.find(isRecord)
      throw new Error(String(result.reason || result.message || firstFailure?.message || '操作未完成'))
    }
    showFeedback(successMessage, 'success')
    scheduleRefresh(true)
  } catch (error) {
    showFeedback(actionError(error), 'error')
    scheduleRefresh(true)
  } finally {
    buttonEl.disabled = false
    delete buttonEl.dataset.busy
  }
}

function buildIcon(app: InstalledApp): HTMLElement {
  const wrap = el('span', 'item-icon-wrap')
  const fallback = (): void => {
    const initial = String(app.name || app.shortName || hostLabel(app.startUrl) || '?').trim().charAt(0).toUpperCase() || '?'
    wrap.replaceChildren(el('span', 'item-icon-fallback', initial))
  }
  const src = app.iconUrl || faviconProxyUrl(app.startUrl) || ''
  if (!src) {
    fallback()
    return wrap
  }
  const image = el('img')
  image.alt = ''
  image.decoding = 'async'
  image.loading = 'lazy'
  image.addEventListener('error', fallback, { once: true })
  image.src = src
  wrap.appendChild(image)
  return wrap
}

function buildAction(label: string, options: ActionOptions = {}): HTMLButtonElement {
  const node = button(label, `btn btn-mini${options.danger ? ' btn-danger' : ''}`)
  node.disabled = Boolean(options.disabled)
  if (options.title) {
    node.title = options.title
    node.setAttribute('aria-label', options.title)
  }
  if (options.onClick) node.addEventListener('click', () => options.onClick?.(node))
  return node
}

function buildSwitch(options: SwitchOptions): HTMLButtonElement {
  const node = button('', 'switch')
  node.setAttribute('role', 'switch')
  node.setAttribute('aria-checked', String(options.checked))
  node.setAttribute('aria-label', options.title)
  node.title = options.title
  node.addEventListener('click', () => { void runAction(node, options.onChange, options.label) })
  return node
}

function badge(label: string, variant?: string): HTMLElement {
  return el('span', `badge${variant ? ` badge-${variant}` : ''}`, label)
}

function buildUpdateBadge(app: InstalledApp): HTMLElement | null {
  if (app.updateState === 'available') return badge('有更新', 'accent')
  if (app.updateState === 'error') return badge('检查失败', 'danger')
  return null
}

function lastUsedLabel(app: InstalledApp): string {
  if (app.lastLaunchedAt) return `上次打开 ${fmtTime(app.lastLaunchedAt)}`
  if (app.createdAt) return `安装于 ${fmtTime(app.createdAt)}`
  return '尚未打开'
}

function buildDetail(app: InstalledApp): HTMLElement {
  const panel = el('div', 'item-detail')
  const kind = kindOf(app)
  const addField = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return
    const line = el('div', 'item-detail-line')
    line.appendChild(el('span', 'item-detail-label', label))
    line.appendChild(el('span', 'item-detail-value', String(value)))
    panel.appendChild(line)
  }
  const addNode = (label: string, node: HTMLElement): void => {
    const line = el('div', 'item-detail-line')
    line.appendChild(el('span', 'item-detail-label', label))
    line.appendChild(node)
    panel.appendChild(line)
  }

  addField('网址', app.startUrl)
  addField('类型', kind.label)
  addField('来源', sourceLabel(app))
  addField('窗口模式', app.display)
  addField('安装时间', app.createdAt ? fmtTime(app.createdAt) : '')
  addField('上次打开', app.lastLaunchedAt ? fmtTime(app.lastLaunchedAt) : '从未打开')
  addField('打开次数', app.launchCount ?? 0)
  addField('上次检查更新', app.lastCheckedAt ? fmtTime(app.lastCheckedAt) : '尚未检查')

  addNode('桌面快捷方式', buildSwitch({
    checked: Boolean(app.hasDesktopShortcut),
    label: app.hasDesktopShortcut ? '已移除桌面快捷方式' : '已创建桌面快捷方式',
    title: app.hasDesktopShortcut ? '移除桌面快捷方式' : '创建桌面快捷方式',
    onChange: () => app.hasDesktopShortcut
      ? rpc(IPC_ROUTES.pwaRemoveShortcut, { id: app.id, location: 'desktop' })
      : rpc(IPC_ROUTES.pwaCreateShortcut, { id: app.id, location: 'desktop' })
  }))

  addNode('开始菜单快捷方式', buildSwitch({
    checked: Boolean(app.hasStartMenuShortcut),
    label: app.hasStartMenuShortcut ? '已移除开始菜单快捷方式' : '已创建开始菜单快捷方式',
    title: app.hasStartMenuShortcut ? '移除开始菜单快捷方式' : '创建开始菜单快捷方式',
    onChange: () => app.hasStartMenuShortcut
      ? rpc(IPC_ROUTES.pwaRemoveShortcut, { id: app.id, location: 'start-menu' })
      : rpc(IPC_ROUTES.pwaCreateShortcut, { id: app.id, location: 'start-menu' })
  }))

  addNode('开机启动', buildSwitch({
    checked: Boolean(app.runOnStartup),
    label: app.runOnStartup ? '已关闭开机启动' : '已开启开机启动',
    title: app.runOnStartup ? '关闭开机启动' : '登录系统时自动打开该应用',
    onChange: () => rpc(IPC_ROUTES.pwaSetRunOnStartup, { id: app.id, enabled: !app.runOnStartup })
  }))

  const footer = el('div', 'item-detail-actions')
  footer.appendChild(buildAction('检查更新', {
    disabled: !kind.updatable,
    title: kind.updatable ? `检查“${app.name}”是否有更新` : kind.updateHint,
    onClick: (node) => {
      void runAction(node, () => rpc(IPC_ROUTES.pwaUpdate, { id: app.id }), `已检查“${app.name}”的更新`)
    }
  }))
  footer.appendChild(buildAction('卸载', {
    danger: true,
    title: `卸载“${app.name}”（会删除应用窗口、快捷方式与本地缓存）`,
    onClick: (node) => {
      if (!window.confirm(`确定卸载“${app.name}”吗？卸载后需要重新安装才能恢复。`)) return
      void runAction(node, () => rpc(IPC_ROUTES.pwaUninstall, { id: app.id }), `已卸载“${app.name}”`)
    }
  }))
  panel.appendChild(footer)
  return panel
}

function buildRow(app: InstalledApp): HTMLElement {
  const kind = kindOf(app)
  const row = el('article', `item-row${kind.updatable ? '' : ' apps-row-shortcut'}`)
  row.dataset.appId = app.id

  const body = el('div', 'item-body')
  const title = el('div', 'item-head')
  title.appendChild(el('div', 'item-name', app.name))
  title.appendChild(badge(kind.label))
  const updateBadge = buildUpdateBadge(app)
  if (updateBadge) title.appendChild(updateBadge)
  body.appendChild(title)

  const meta = el('div', 'item-meta')
  meta.appendChild(el('span', 'apps-host', hostLabel(app.startUrl)))
  meta.appendChild(el('span', 'apps-meta-separator', '·'))
  meta.appendChild(el('span', '', lastUsedLabel(app)))
  body.appendChild(meta)

  const actions = el('div', 'item-actions')
  actions.appendChild(buildAction('打开', {
    title: `以应用窗口打开“${app.name}”`,
    onClick: (node) => {
      void runAction(node, () => rpc(IPC_ROUTES.pwaLaunch, { id: app.id }), `已打开“${app.name}”`)
    }
  }))

  if (isWebUrl(app.startUrl)) {
    const browserLink = el('a', 'btn btn-mini', '在浏览器中打开')
    browserLink.href = app.startUrl
    browserLink.target = '_blank'
    browserLink.rel = 'noopener noreferrer'
    browserLink.title = `在浏览器标签页中打开 ${app.startUrl}`
    actions.appendChild(browserLink)
  } else {
    actions.appendChild(buildAction('在浏览器中打开', { disabled: true, title: '应用网址无效' }))
  }

  const expanded = state.expandedId === app.id
  actions.appendChild(buildAction(expanded ? '收起' : '详情', {
    title: expanded ? `收起“${app.name}”的详情` : `查看“${app.name}”的详情`,
    onClick: () => {
      state.expandedId = expanded ? null : app.id
      render()
    }
  }))

  row.append(buildIcon(app), body, actions)
  if (expanded) row.appendChild(buildDetail(app))
  return row
}

function visibleApps(): InstalledApp[] {
  return filterApps(state.apps, state.query)
}

function renderSummary(visibleCount = visibleApps().length): void {
  if (state.loadError || !state.apps.length) {
    summaryEl.textContent = ''
    return
  }
  const counts = new Map<string, number>()
  for (const app of state.apps) {
    const label = kindOf(app).label
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  const breakdown = Array.from(counts, ([label, count]) => `${label} ${count} 个`).join(' · ')
  let text = `共 ${state.apps.length} 个 · ${breakdown}`
  if (state.query && visibleCount !== state.apps.length) text += ` · 匹配 ${visibleCount} 个`
  summaryEl.textContent = text
}

function renderLoadError(message: string): void {
  listHost.textContent = ''
  const empty = el('div', 'empty')
  empty.appendChild(el('div', 'empty-title', '应用列表暂时不可用'))
  empty.appendChild(el('div', 'empty-hint', message))
  const retry = button('重新载入', 'btn')
  retry.addEventListener('click', () => { void refresh(true) })
  empty.appendChild(retry)
  listHost.appendChild(empty)
}

function render(): void {
  listHost.setAttribute('aria-busy', String(state.loading))
  if (state.loading) {
    renderEmpty(listHost, '正在加载应用…')
    renderSummary(0)
    return
  }
  if (state.loadError) {
    renderLoadError(state.loadError)
    renderSummary(0)
    return
  }
  if (!state.apps.length) {
    renderEmpty(listHost, '还没有安装任何应用。可在网页里点地址栏的“安装应用”，或从菜单安装本页。')
    renderSummary(0)
    return
  }
  const visible = visibleApps()
  if (!visible.length) {
    renderEmpty(listHost, '没有匹配的应用')
    renderSummary(0)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const app of visible) fragment.appendChild(buildRow(app))
  listHost.textContent = ''
  listHost.appendChild(fragment)
  renderSummary(visible.length)
}

async function refresh(force = false): Promise<void> {
  const sequence = ++state.refreshSequence
  if (!state.apps.length) {
    state.loading = true
    render()
  }
  try {
    const payload = await rpc<unknown>(IPC_ROUTES.pwaList)
    if (sequence !== state.refreshSequence) return
    state.apps = readInstalledApps(payload)
    state.loadError = ''
  } catch (error) {
    if (sequence !== state.refreshSequence) return
    state.loadError = `加载应用失败：${actionError(error)}`
  } finally {
    if (sequence !== state.refreshSequence) return
    state.loading = false
    const signature = state.loadError ? 'error' : appSignature(state.apps)
    if (force || signature !== state.lastSignature) {
      state.lastSignature = signature
      render()
    } else {
      renderSummary(visibleApps().length)
    }
  }
}

function scheduleRefresh(force = false): void {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => { void refresh(force) }, 80)
}

refreshBtn.addEventListener('click', () => { void refresh(true) })
checkBtn.addEventListener('click', () => {
  void (async () => {
    if (checkBtn.disabled) return
    checkBtn.disabled = true
    checkBtn.dataset.busy = 'true'
    try {
      const result = await rpc<CheckUpdatesResult>(IPC_ROUTES.pwaCheckUpdates, { force: true })
      if (result?.ok === false) throw new Error(String(result.reason || result.message || '检查更新失败'))
      const updated = Array.isArray(result?.updated) ? result.updated.length : 0
      showFeedback(updated ? `已更新 ${updated} 个应用` : '所有应用都是最新的', 'success')
      scheduleRefresh(true)
    } catch (error) {
      showFeedback(actionError(error), 'error')
    } finally {
      checkBtn.disabled = false
      delete checkBtn.dataset.busy
    }
  })()
})

searchInput.addEventListener('input', () => {
  state.query = searchInput.value
  render()
})

const unsubscribeChanged = subscribe(IPC_EVENTS.pwaChanged, () => scheduleRefresh(false))

window.addEventListener('beforeunload', () => {
  unsubscribeChanged()
  window.clearTimeout(refreshTimer)
  window.clearTimeout(feedbackTimer)
})

render()
void refresh(true)
