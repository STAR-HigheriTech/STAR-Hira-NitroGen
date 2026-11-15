import { IPC_EVENTS, IPC_ROUTES, rpc, el, fmtSize, fileIconBadge, renderEmpty, initTheme, subscribe } from 'hira://shared/runtime.js'
// 状态词的真源（与下载面板 / 下载条同一份）—— 本页不再自己抄一张表。
// 改造前这里把 interrupted 说成「已取消」，而面板说的是「已失败」：同一条下载两处不同结局。
import { downloadStateText, isActiveDownloadState } from 'hira://shared/download-view.mjs'
import { errorMessage, requiredById } from 'hira://shared/page-kit.js'
import {
  DOWNLOAD_RULES_SETTING_KEY,
  DOWNLOAD_RULE_ACTION_OPTIONS,
  parseDownloadRules,
  serializeDownloadRules,
  type DownloadRule,
  type DownloadRuleAction
} from 'hira://shared/download-rules.mjs'

interface DownloadRecord {
  id: string
  url: string
  filename?: string | null
  filePath?: string | null
  receivedBytes?: number | null
  totalBytes?: number | null
  state?: string
  danger?: string | null
}

interface DownloadProgress {
  id?: string
  received?: number
  total?: number
  state?: string
}

interface DownloadVerification {
  id?: string
  sha256?: string
  duplicateOf?: string
}

interface RowHandle {
  row: HTMLElement
  fill: HTMLElement | null
  meta: HTMLElement
  badge: HTMLElement
  state: string
  total: number
}

interface RuleActionCatalogItem {
  id: string
  label: string
}

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

const rulesList = requiredById<HTMLElement>('rules-list')
const rulesBody = requiredById<HTMLElement>('rules-body')
const toggleRules = requiredById<HTMLButtonElement>('toggle-rules')
const addRule = requiredById<HTMLButtonElement>('add-rule')
const ruleInputs = {
  name: requiredById<HTMLInputElement>('rule-name'),
  domains: requiredById<HTMLInputElement>('rule-domains'),
  extensions: requiredById<HTMLInputElement>('rule-extensions'),
  keywords: requiredById<HTMLInputElement>('rule-keywords'),
  folder: requiredById<HTMLInputElement>('rule-folder'),
  template: requiredById<HTMLInputElement>('rule-template')
}
const ruleActions = requiredById<HTMLElement>('rule-actions')
let downloadRules: DownloadRule[] = []
const verificationById = new Map<string, DownloadVerification>()
let pluginRuleActions: RuleActionCatalogItem[] = []

function actionLabel(action: DownloadRuleAction): string {
  return pluginRuleActions.find((item) => item.id === action)?.label
    || DOWNLOAD_RULE_ACTION_OPTIONS.find((item) => item.id === action)?.label
    || action
}

function selectedRuleActions(): DownloadRuleAction[] {
  return Array.from(ruleActions.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((input) => input.checked)
    .map((input) => input.dataset.action as DownloadRuleAction)
    .filter(Boolean)
}

function mountRuleActions(): void {
  ruleActions.textContent = ''
  for (const option of [...DOWNLOAD_RULE_ACTION_OPTIONS, ...pluginRuleActions]) {
    const label = el('label', 'check rule-action-option')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.dataset.action = option.id
    label.append(input, document.createTextNode(option.label))
    ruleActions.appendChild(label)
  }
}

async function loadRuleActionCatalog(): Promise<void> {
  try {
    const result = await rpc<{ items?: Array<{ descriptor?: Record<string, unknown> }> }>(
      IPC_ROUTES.slotsRender,
      { slotId: 'download.rule-action', payload: {} }
    )
    pluginRuleActions = (result?.items || [])
      .map((item) => item.descriptor || {})
      .map((descriptor) => ({
        id: String(descriptor.id || '').trim(),
        label: String(descriptor.label || descriptor.title || '').trim()
      }))
      .filter((item) => item.id && item.label)
  } catch {
    pluginRuleActions = []
  }
  mountRuleActions()
}

function splitRuleList(value: string): string[] {
  return value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)
}

async function loadRules(): Promise<void> {
  try {
    const result = await rpc<{ value?: unknown }>(IPC_ROUTES.settingsGet, { key: DOWNLOAD_RULES_SETTING_KEY })
    downloadRules = parseDownloadRules(result?.value)
  } catch {
    downloadRules = []
  }
  renderRules()
}

async function saveRules(): Promise<void> {
  await rpc(IPC_ROUTES.settingsSet, { key: DOWNLOAD_RULES_SETTING_KEY, value: serializeDownloadRules(downloadRules) })
  renderRules()
}

function renderRules(): void {
  rulesList.textContent = ''
  if (!downloadRules.length) {
    renderEmpty(rulesList, '还没有整理规则。下载会继续保存到默认目录。')
    return
  }
  const fragment = document.createDocumentFragment()
  for (const rule of downloadRules) {
    const row = el('div', 'row download-rule-row')
    const main = el('div', 'main')
    main.appendChild(el('div', 'title', rule.name))
    const parts = [
      rule.domains.length ? `域名 ${rule.domains.join(', ')}` : '',
      rule.extensions.length ? `扩展 ${rule.extensions.join(', ')}` : '',
      rule.keywords.length ? `关键词 ${rule.keywords.join(', ')}` : '',
      `保存到 ${rule.folder}`,
      rule.actions.length ? `完成后 ${rule.actions.map(actionLabel).join('、')}` : ''
    ].filter(Boolean)
    main.appendChild(el('div', 'summary', parts.join(' · ')))
    row.appendChild(main)
    const actions = el('div', 'actions')
    const enabled = el('button', 'btn', rule.enabled ? '已启用' : '已停用')
    enabled.onclick = async () => {
      downloadRules = downloadRules.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item)
      await saveRules()
    }
    const remove = el('button', 'icon-btn', '×')
    remove.title = '删除规则'
    remove.onclick = async () => {
      downloadRules = downloadRules.filter((item) => item.id !== rule.id)
      await saveRules()
    }
    actions.append(enabled, remove)
    row.appendChild(actions)
    fragment.appendChild(row)
  }
  rulesList.appendChild(fragment)
}

toggleRules.onclick = () => {
  rulesBody.hidden = !rulesBody.hidden
  toggleRules.textContent = rulesBody.hidden ? '展开' : '收起'
}

addRule.onclick = async () => {
  const name = ruleInputs.name.value.trim()
  if (!name) {
    ruleInputs.name.focus()
    return
  }
  downloadRules = parseDownloadRules([...downloadRules, {
    id: `download-rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    enabled: true,
    domains: splitRuleList(ruleInputs.domains.value),
    extensions: splitRuleList(ruleInputs.extensions.value),
    keywords: splitRuleList(ruleInputs.keywords.value),
    folder: ruleInputs.folder.value.trim() || '其他',
    nameTemplate: ruleInputs.template.value.trim() || '{name}',
    actions: selectedRuleActions()
  }])
  for (const input of Object.values(ruleInputs)) input.value = ''
  for (const input of ruleActions.querySelectorAll<HTMLInputElement>('input')) input.checked = false
  await saveRules()
}

/**
 * 下载页 = **事件驱动**，不再 2 秒整表重建。
 *
 * 为什么改：轮询会把整张列表 `textContent = ''` 再重画一次，正在下载时用户看到的是
 * 每秒闪一下的列表（行被销毁、文件图标重取、进度条从 0 宽开始过渡）。
 * 主进程本来就广播 `download:progress` / `download:done`（下载栏在用的同一条链），
 * 于是本页也订阅它们：
 *   · progress → 只更新**那一行**的进度条与百分比（零重排、零图标重取）；
 *   · done     → 拉一次列表（完成项要补文件名 / 路径 / 完成态）。
 * 列表结构只在「新增 / 删除 / 完成」时变化，其余时候 DOM 原地推进。
 */

/** id → 行的可更新句柄（进度原地写回用）。 */
const rowHandles = new Map<string, RowHandle>()
/** 合并高频 progress：一帧内多次进度只排一次写回。 */
let progressFrame = 0
const pendingProgress = new Map<string, DownloadProgress>()

function stateLabel (download: Pick<DownloadRecord, 'state'>, received: number, total: number): string {
  // 活动状态下用百分比代替状态词（与改造前一致）；其余状态一律取真源文案。
  if (isActiveDownloadState(download.state) && total) return Math.round(received / total * 100) + '%'
  return downloadStateText(download.state) || downloadStateText('pending')
}

function buildActions (download: DownloadRecord, refresh: () => Promise<void>): HTMLElement {
  const actions = el('div', 'actions')
  const active = download.state === 'in_progress' || download.state === 'pending'

  if (active) {
    const pause = el('button', 'icon-btn btn-pause', '\u2759\u2759')
    pause.title = '暂停'
    pause.onclick = async () => { await rpc(IPC_ROUTES.downloadPause, { id: download.id }); await refresh() }
    actions.appendChild(pause)
  }

  if (download.state === 'paused') {
    const resume = el('button', 'icon-btn btn-resume', '\u25B6')
    resume.title = '继续'
    resume.onclick = async () => { await rpc(IPC_ROUTES.downloadResume, { id: download.id }); await refresh() }
    actions.appendChild(resume)
  }

  if (active || download.state === 'paused') {
    const cancel = el('button', 'icon-btn btn-cancel', '\u2715')
    cancel.title = '取消'
    cancel.onclick = async () => { await rpc(IPC_ROUTES.downloadCancel, { id: download.id }); await refresh() }
    actions.appendChild(cancel)
  }

  if (download.state === 'completed' && download.filePath) {
    const open = el('button', 'icon-btn', '\u2197')
    open.title = '打开文件'
    open.onclick = () => rpc(IPC_ROUTES.downloadOpen, { filePath: download.filePath })
    actions.appendChild(open)

    const folder = el('button', 'icon-btn', '\u{1F4C2}')
    folder.title = '在文件夹中显示'
    folder.onclick = () => rpc(IPC_ROUTES.downloadShowInFolder, { filePath: download.filePath })
    actions.appendChild(folder)
  }

  const del = el('button', 'icon-btn', '\u2715')
  del.title = '从列表移除'
  del.onclick = async () => {
    await rpc(IPC_ROUTES.downloadRemove, { id: download.id })
    await refresh()
  }
  actions.appendChild(del)

  return actions
}

function buildRow (download: DownloadRecord, refresh: () => Promise<void>): HTMLElement {
  const received = download.receivedBytes || 0
  const total = download.totalBytes || 0
  const row = el('div', 'row')
  const verification = verificationById.get(download.id)
  if (verification?.sha256) row.title = `SHA-256: ${verification.sha256}`

  const info = el('div', 'info')
  const meta = el('div', 'meta', fmtSize(received) + (total ? ' / ' + fmtSize(total) : ''))
  info.appendChild(el('div', 'name', download.filename || download.url))
  info.appendChild(meta)

  // 危险文件标记
  if (download.danger && download.danger !== 'safe') {
    const danger = el('span', 'badge badge-danger', '⚠ 不安全')
    danger.title = '此文件类型可能不安全'
    info.appendChild(danger)
  }
  if (verification?.duplicateOf) {
    const duplicate = el('span', 'badge badge-danger', '重复文件')
    duplicate.title = `与已有文件内容相同：${verification.duplicateOf}`
    info.appendChild(duplicate)
  }

  // 行首图标：优先向主进程要**真实文件图标**（老 Hira 同款做法），
  // 文件还没落盘 / 已删时退回按扩展名归类的类型图标 —— 行首永远不会是空的。
  row.appendChild(fileIconBadge(download))
  row.appendChild(info)

  const fill = download.state === 'in_progress' || download.state === 'pending' || download.state === 'paused'
    ? (() => {
        const bar = el('div', 'progress-bar')
        const node = el('div', 'progress-fill' + (download.state === 'paused' ? ' paused' : ''))
        node.style.width = total ? (received / total * 100) + '%' : '0%'
        bar.appendChild(node)
        row.appendChild(bar)
        return node
      })()
    : null

  const state = download.state || 'pending'
  const badge = el('span', 'badge state state-' + state, stateLabel(download, received, total))
  row.appendChild(badge)
  row.appendChild(buildActions(download, refresh))

  rowHandles.set(download.id, { row, fill, meta, badge, state, total })
  return row
}

/** 进度事件 → 只改那一行；行不存在（例如页面刚打开时的历史下载）→ 补一次列表。 */
function applyProgress (payload: DownloadProgress): void {
  if (!payload.id) return
  const handle = rowHandles.get(payload.id)
  // 行还不存在 = 这是一条刚刚开始的下载；补一次列表让它进 DOM。
  if (!handle) { scheduleRefresh(); return }
  const received = Number(payload.received) || 0
  const total = Number(payload.total) || handle.total || 0
  handle.total = total
  handle.meta.textContent = fmtSize(received) + (total ? ' / ' + fmtSize(total) : '')
  if (handle.fill) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, received / total)) : 0
    handle.fill.style.width = (ratio * 100) + '%'
    handle.fill.classList.toggle('paused', payload.state === 'paused')
  }
  if (payload.state && payload.state !== handle.state) {
    // 状态切换（暂停 / 继续）会换按钮，结构必须重画 —— 但只在真的切换时。
    handle.state = payload.state
    scheduleRefresh()
    return
  }
  handle.badge.textContent = stateLabel({ ...payload, state: payload.state || handle.state }, received, total)
}

function flushProgress (): void {
  progressFrame = 0
  for (const payload of pendingProgress.values()) applyProgress(payload)
  pendingProgress.clear()
}

function queueProgress (payload: DownloadProgress): void {
  if (!payload.id) return
  pendingProgress.set(payload.id, payload)
  if (progressFrame) return
  progressFrame = requestAnimationFrame(flushProgress)
}

let refreshTimer = 0
/** 结构变更（新增行 / 状态切换）合并成一小段，避免连开多个下载时多次重建。 */
function scheduleRefresh (): void {
  if (refreshTimer) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0
    refresh()
  }, 180)
}

const list = requiredById<HTMLElement>('list')
const downloadSearch = requiredById<HTMLInputElement>('download-search')
downloadSearch.value = new URLSearchParams(location.search).get('search') || ''

async function refresh (): Promise<void> {
  let items: DownloadRecord[] = []
  try {
    const [response, verificationResponse] = await Promise.all([
      rpc<unknown>(IPC_ROUTES.downloadList, {}),
      rpc<{ value?: unknown }>(IPC_ROUTES.settingsGet, { key: 'download.verification_index' }).catch(() => ({ value: '[]' }))
    ])
    verificationById.clear()
    try {
      const rows = JSON.parse(String(verificationResponse?.value || '[]'))
      if (Array.isArray(rows)) {
        for (const item of rows) {
          if (item && item.id && item.hash) {
            verificationById.set(String(item.id), { id: String(item.id), sha256: String(item.hash), duplicateOf: item.duplicateOf ? String(item.duplicateOf) : undefined })
          }
        }
      }
    } catch {}
    items = Array.isArray(response) ? response as DownloadRecord[] : []
  } catch (e) {
    list.textContent = ''
    rowHandles.clear()
    renderEmpty(list, '下载记录加载失败：' + errorMessage(e))
    return
  }

  // 先取数、后换 DOM：换表只发生一次，不会先清空再等 IPC 回来（那种写法每次刷新都闪一下白）。
  const query = downloadSearch.value.trim().toLowerCase()
  if (query) items = items.filter((item) => `${item.filename || ''} ${item.url || ''}`.toLowerCase().includes(query))
  rowHandles.clear()
  list.textContent = ''
  if (!items || items.length === 0) {
    renderEmpty(list, '暂无下载记录。')
    return
  }

  const frag = document.createDocumentFragment()
  for (const d of items) frag.appendChild(buildRow(d, refresh))
  list.appendChild(frag)
}

const refreshButton = requiredById<HTMLButtonElement>('refresh')
const clearButton = requiredById<HTMLButtonElement>('clear')
refreshButton.onclick = refresh
downloadSearch.addEventListener('input', () => { void refresh() })
clearButton.onclick = async () => {
  if (!confirm('确定清除已完成的下载记录吗？已下载的文件不会被删除。')) return
  await rpc(IPC_ROUTES.downloadClearCompleted, {})
  await refresh()
}

subscribe<DownloadProgress>(IPC_EVENTS.downloadProgress, queueProgress)
subscribe(IPC_EVENTS.downloadDone, scheduleRefresh)
subscribe<DownloadVerification>(IPC_EVENTS.downloadVerified, (payload) => {
  if (!payload?.id) return
  const handle = rowHandles.get(payload.id)
  if (!handle) return
  verificationById.set(payload.id, payload)
  if (payload.duplicateOf) {
    handle.badge.textContent = '重复文件'
    handle.badge.title = `与已有文件内容相同：${payload.duplicateOf}`
  }
})

// 回到前台时补一次：事件只覆盖"页面在的时候"，离开期间完成的那几条要补上。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh()
})

refresh()
void loadRuleActionCatalog()
void loadRules()
