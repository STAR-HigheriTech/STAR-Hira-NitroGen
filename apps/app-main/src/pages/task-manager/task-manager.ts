import { IPC_ROUTES, rpc, el, fmtSize, renderEmpty, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, finiteNumber, isRecord, requiredById } from 'hira://shared/page-kit.js'

interface ProcessMetric {
  pid: number
  type: string
  name: string
  owner: string | null
  cpuPercent: number
  memoryKB: number
}

interface MetricsResponse {
  metrics?: unknown
}

interface KillResponse {
  ok?: boolean
  reason?: string
}

type SortKey = 'type' | 'owner' | 'cpu' | 'memory'
type SortDirection = 'ascending' | 'descending'

interface Preferences {
  sortKey: SortKey
  sortDirection: SortDirection
  paused: boolean
  query: string
}

initTheme()

const POLL_MS = 2000
const PREF_KEY = 'hira.task-manager.preferences.v1'
const TYPE_LABELS: Readonly<Record<string, string>> = {
  browser: '浏览器主进程',
  renderer: '渲染进程',
  gpu: 'GPU 进程',
  utility: '工具进程',
  zygote: '辅助进程',
  'sandbox-helper': '沙箱辅助进程',
  'ppapi-plugin': 'PPAPI 插件进程',
  'pepper-plugin': 'Pepper 插件进程',
  'ppapi-broker': 'PPAPI 中介进程',
  'navigation-builder': '导航构建进程'
}

const list = requiredById<HTMLElement>('list')
const stamp = requiredById<HTMLElement>('stamp')
const refreshButton = requiredById<HTMLButtonElement>('refresh')
const pauseButton = requiredById<HTMLButtonElement>('pause')
const searchInput = requiredById<HTMLInputElement>('search')
const processCount = requiredById<HTMLElement>('process-count')
const cpuTotal = requiredById<HTMLElement>('cpu-total')
const memoryTotal = requiredById<HTMLElement>('memory-total')
const toast = requiredById<HTMLElement>('toast')
const sortButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sort]'))

function readPreferences(): Preferences {
  const defaults: Preferences = {
    sortKey: 'memory',
    sortDirection: 'descending',
    paused: false,
    query: ''
  }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    if (!isRecord(value)) return defaults
    const sortKey = value.sortKey
    const sortDirection = value.sortDirection
    return {
      sortKey: sortKey === 'type' || sortKey === 'owner' || sortKey === 'cpu' || sortKey === 'memory'
        ? sortKey
        : defaults.sortKey,
      sortDirection: sortDirection === 'ascending' || sortDirection === 'descending'
        ? sortDirection
        : defaults.sortDirection,
      paused: value.paused === true,
      query: typeof value.query === 'string' ? value.query : ''
    }
  } catch {
    return defaults
  }
}

const preferences = readPreferences()
let metrics: ProcessMetric[] = []
let timer: number | null = null
let inFlight: Promise<void> | null = null
let toastTimer: number | null = null

searchInput.value = preferences.query
syncPauseButton()
syncSortButtons()

function savePreferences(): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(preferences))
  } catch (_) {}
}

function processName(type: string): string {
  return TYPE_LABELS[type] || type || '未知进程'
}

function memoryText(kb: unknown): string {
  return fmtSize(finiteNumber(kb) * 1024) || '0 B'
}

function cpuText(percent: unknown): string {
  return finiteNumber(percent).toFixed(1) + '%'
}

function showToast(text: string, isError = false): void {
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  toast.textContent = text
  toast.classList.toggle('error', isError)
  toast.hidden = false
  toastTimer = window.setTimeout(() => {
    toast.hidden = true
    toastTimer = null
  }, 3000)
}

function syncPauseButton(): void {
  pauseButton.textContent = preferences.paused ? '继续' : '暂停'
  pauseButton.setAttribute('aria-pressed', String(preferences.paused))
  pauseButton.title = preferences.paused ? '继续自动刷新' : '暂停自动刷新'
}

function syncSortButtons(): void {
  for (const button of sortButtons) {
    const active = button.dataset.sort === preferences.sortKey
    if (active) button.setAttribute('aria-sort', preferences.sortDirection)
    else button.removeAttribute('aria-sort')
  }
}

function visibleMetrics(): ProcessMetric[] {
  const query = preferences.query.trim().toLocaleLowerCase()
  const direction = preferences.sortDirection === 'ascending' ? 1 : -1
  return metrics
    .filter((metric) => {
      if (!query) return true
      return [
        processName(metric.type),
        metric.type,
        metric.owner || '',
        String(metric.pid)
      ].some((value) => value.toLocaleLowerCase().includes(query))
    })
    .sort((a, b) => {
      if (preferences.sortKey === 'cpu') return (a.cpuPercent - b.cpuPercent) * direction
      if (preferences.sortKey === 'memory') return (a.memoryKB - b.memoryKB) * direction
      if (preferences.sortKey === 'owner') {
        return (a.owner || '').localeCompare(b.owner || '', 'zh-CN') * direction
      }
      return processName(a.type).localeCompare(processName(b.type), 'zh-CN') * direction
    })
}

function renderSummary(): void {
  processCount.textContent = String(metrics.length)
  const cpu = metrics.reduce((sum, metric) => sum + metric.cpuPercent, 0)
  const memory = metrics.reduce((sum, metric) => sum + metric.memoryKB, 0)
  cpuTotal.textContent = cpuText(cpu)
  memoryTotal.textContent = memoryText(memory)
}

async function terminate(metric: ProcessMetric): Promise<void> {
  const label = metric.owner || processName(metric.type)
  if (!window.confirm(`结束「${label}」？\n\nPID ${metric.pid} · ${processName(metric.type)}\n未保存的数据可能丢失。`)) return
  try {
    const result = await rpc<KillResponse>(IPC_ROUTES.appKillProcess, { pid: metric.pid })
    if (!result?.ok) {
      showToast(result?.reason || '结束进程失败', true)
      return
    }
    showToast(`已结束 ${label}`)
    metrics = metrics.filter((item) => item.pid !== metric.pid)
    render()
    await refresh()
  } catch (error) {
    showToast('结束进程失败：' + errorMessage(error), true)
  }
}

function buildRow(metric: ProcessMetric): HTMLElement {
  const row = el('div', 'row')
  row.dataset.pid = String(metric.pid)

  const type = el('span', 'col-type')
  const dot = el('span', 'type-dot')
  dot.dataset.type = metric.type
  type.appendChild(dot)
  type.appendChild(document.createTextNode(processName(metric.type)))
  row.appendChild(type)

  const owner = el('span', 'col-owner', metric.owner || '系统进程')
  owner.title = metric.owner || processName(metric.type)
  row.appendChild(owner)
  row.appendChild(el('span', 'col-pid', metric.pid))
  row.appendChild(el('span', 'col-cpu', cpuText(metric.cpuPercent)))
  row.appendChild(el('span', 'col-mem', memoryText(metric.memoryKB)))

  const action = el('span', 'row-action')
  const button = el('button', 'kill-btn', '结束')
  button.type = 'button'
  button.title = `结束 PID ${metric.pid}`
  button.setAttribute('aria-label', `结束 ${metric.owner || processName(metric.type)}，PID ${metric.pid}`)
  button.addEventListener('click', () => { void terminate(metric) })
  action.appendChild(button)
  row.appendChild(action)
  return row
}

function render(): void {
  renderSummary()
  const visible = visibleMetrics()
  list.replaceChildren()
  if (visible.length === 0) {
    const message = metrics.length === 0
      ? '主进程没有返回任何进程指标。'
      : '没有符合筛选条件的进程。'
    renderEmpty(list, message)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const metric of visible) fragment.appendChild(buildRow(metric))
  list.appendChild(fragment)
}

async function refresh(): Promise<void> {
  if (inFlight) return inFlight
  refreshButton.disabled = true
  stamp.textContent = '正在更新…'
  inFlight = (async () => {
    try {
      const response = await rpc<MetricsResponse>(IPC_ROUTES.appMetrics, {})
      metrics = Array.isArray(response?.metrics)
        ? response.metrics
            .filter(isRecord)
            .map((metric) => ({
              pid: finiteNumber(metric.pid),
              type: String(metric.type || 'unknown'),
              name: String(metric.name || metric.type || 'unknown'),
              owner: typeof metric.owner === 'string' ? metric.owner : null,
              cpuPercent: finiteNumber(metric.cpuPercent),
              memoryKB: finiteNumber(metric.memoryKB)
            }))
            .filter((metric) => metric.pid > 0)
        : []
      render()
      stamp.textContent = '更新于 ' + new Date().toLocaleTimeString()
    } catch (error) {
      metrics = []
      renderSummary()
      list.replaceChildren()
      renderEmpty(list, '读取进程指标失败：' + errorMessage(error))
      stamp.textContent = '更新失败'
    } finally {
      refreshButton.disabled = false
      inFlight = null
    }
  })()
  return inFlight
}

function stopPolling(): void {
  if (timer === null) return
  window.clearInterval(timer)
  timer = null
}

function startPolling(): void {
  stopPolling()
  if (preferences.paused || document.hidden) return
  timer = window.setInterval(() => { void refresh() }, POLL_MS)
}

pauseButton.addEventListener('click', () => {
  preferences.paused = !preferences.paused
  savePreferences()
  syncPauseButton()
  startPolling()
  if (!preferences.paused) void refresh()
})

refreshButton.addEventListener('click', () => { void refresh() })

searchInput.addEventListener('input', () => {
  preferences.query = searchInput.value
  savePreferences()
  render()
})

for (const button of sortButtons) {
  button.addEventListener('click', () => {
    const key = button.dataset.sort as SortKey
    if (preferences.sortKey === key) {
      preferences.sortDirection = preferences.sortDirection === 'ascending' ? 'descending' : 'ascending'
    } else {
      preferences.sortKey = key
      preferences.sortDirection = key === 'cpu' || key === 'memory' ? 'descending' : 'ascending'
    }
    savePreferences()
    syncSortButtons()
    render()
  })
}

document.addEventListener('keydown', (event: KeyboardEvent) => {
  const target = event.target
  const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  if (event.key === '/' && !editing) {
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  } else if (event.key === 'Escape' && document.activeElement === searchInput && searchInput.value) {
    searchInput.value = ''
    preferences.query = ''
    savePreferences()
    render()
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling()
  else {
    void refresh()
    startPolling()
  }
})

startPolling()
void refresh()
