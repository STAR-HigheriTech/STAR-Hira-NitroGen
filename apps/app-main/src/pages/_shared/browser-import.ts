/**
 * hira://shared/browser-import.js · 「从 Chrome / Edge 一键导入」卡片
 *
 * 两个入口共用**同一份**实现（OOBE 迁移步 / 导入数据页）：
 *   · 只调两条通道：`import:sources`（检测结果）与 `import:browser-data`（执行导入）；
 *   · 源、能力差异全部由主进程下发的**能力位**决定（CAPABILITY_*），
 *     这里没有任何「Chrome 这样、Edge 那样」的分支 —— 新增浏览器只要主进程多一个源；
 *   · 结果一律按结构化字段渲染，失败不抛异常、不吞掉错误原因。
 *
 * 状态持久化：模块级 `store` 按 sourceId 记住「勾了哪些 profile / 哪些数据集 / 上次结果」。
 * 页面切阶段、重新 mount 都不会丢；离开页面即随模块卸载（数据本身已写进库，无需再存盘）。
 *
 * 用法：
 *   import { createBrowserImportCard } from 'hira://shared/browser-import.js'
 *   const card = createBrowserImportCard({ onDone: (result) => {} })
 *   container.appendChild(card.el)
 *   // 卸载时 card.destroy()
 */

import { IPC_ROUTES, rpc, el } from 'hira://shared/runtime.js'

export interface BrowserProfile {
  id: string
  name?: string
  capabilities?: number
}

export interface BrowserSource {
  id: string
  label: string
  capabilities: number
  profiles: BrowserProfile[]
  available?: boolean
}

export interface ImportCounters { imported?: number; skipped?: number }

export interface BrowserImportResult {
  ok?: boolean
  error?: unknown
  errors?: unknown[]
  bookmarks?: ImportCounters
  history?: ImportCounters
  extensions?: ImportCounters
}

export interface BrowserImportSourcesResponse {
  ok?: boolean
  error?: unknown
  sources?: BrowserSource[]
}

interface BrowserImportState {
  profileIds: Set<string>
  datasets: Set<string>
  result: BrowserImportResult | null
}

interface BrowserImportView {
  wrap: HTMLElement
  done: boolean
  badge: HTMLElement
  status: HTMLElement
  runBtn: HTMLButtonElement
  datasetBoxes: HTMLInputElement[]
  chipBoxes: HTMLInputElement[]
  syncAction(): void
}

export interface BrowserImportCardOptions {
  title?: string
  subtitle?: string
  onDone?: (result?: BrowserImportResult, source?: BrowserSource) => void
  /** Increments/decrements host-side pending work; may be called after destroy. */
  onBusyChange?: (busy: boolean) => void
}

export interface BrowserImportCard {
  el: HTMLElement
  destroy(): void
  refresh(): Promise<void>
}

/** 能力位（与主进程 main/import/capabilities.js 同一套语义）。 */
const CAPABILITY_BOOKMARKS = 1 << 0
const CAPABILITY_HISTORY = 1 << 1
const CAPABILITY_EXTENSIONS = 1 << 2

/** 数据集目录：新增一类数据 = 在这里加一行 + 主进程给能力位，UI 不需要再改。 */
const DATASETS = Object.freeze([
  { id: 'bookmarks', label: '书签', capability: CAPABILITY_BOOKMARKS },
  { id: 'history', label: '历史记录', capability: CAPABILITY_HISTORY },
  { id: 'extensions', label: '扩展', capability: CAPABILITY_EXTENSIONS }
])

/** sourceId → { profileIds:Set, datasets:Set, result }（跨 mount 保活）。 */
const store = new Map<string, BrowserImportState>()

/**
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {(result: object, source: object) => void} [options.onDone] 每次导入结束回调（含部分失败）
 * @returns {{ el: HTMLElement, destroy: () => void, refresh: () => Promise<void> }}
 */
export function createBrowserImportCard (options: BrowserImportCardOptions = {}): BrowserImportCard {
  const {
    title = '从 Chrome / Edge 一键导入',
    subtitle = '无需导出文件：直接读取本机浏览器里的书签、历史记录与扩展。',
    onDone,
    onBusyChange
  } = options

  let alive = true

  const root = el('section', 'bi-card')

  const head = el('div', 'bi-head')
  const headText = el('div', 'bi-head-text')
  headText.appendChild(el('h2', 'bi-title', title))
  headText.appendChild(el('p', 'bi-subtitle', subtitle))
  const headBadge = el('span', 'badge bi-head-badge', '检测中…')
  head.appendChild(headText)
  head.appendChild(headBadge)
  root.appendChild(head)

  const body = el('div', 'bi-body', '正在检测浏览器…')
  root.appendChild(body)

  const sourceViews = new Map<string, BrowserImportView>()

  function setHeadBadge (text = '', tone = ''): void {
    headBadge.textContent = text
    headBadge.classList.toggle('is-ok', tone === 'ok')
    headBadge.classList.toggle('is-bad', tone === 'bad')
  }

  /** 首次见到某个源时给出默认勾选：全部 profile + 它支持的每一种数据。 */
  function stateOf (source: BrowserSource): BrowserImportState {
    let state = store.get(source.id)
    if (!state) {
      state = { profileIds: new Set(), datasets: new Set(), result: null }
      store.set(source.id, state)
    }
    const ids = new Set(source.profiles.map((p) => p.id))
    // profile 列表变了（新建 / 删除过用户）：只保留仍存在的；首次或全失效时全选。
    state.profileIds = new Set([...state.profileIds].filter((id) => ids.has(id)))
    if (!state.profileIds.size) state.profileIds = new Set(ids)

    const supported = DATASETS.filter((d) => source.capabilities & d.capability)
    state.datasets = new Set(
      [...state.datasets].filter((id) => supported.some((d) => d.id === id))
    )
    if (!state.datasets.size) state.datasets = new Set(supported.map((d) => d.id))
    return state
  }

  function buildSource (source: BrowserSource): BrowserImportView {
    const state = stateOf(source)

    const wrap = el('div', 'bi-source')
    wrap.dataset.sourceId = source.id

    const row = el('div', 'bi-source-head')
    row.appendChild(el('span', 'bi-source-name', source.label))
    const badge = el('span', 'badge', state.result ? '已导入' : '待导入')
    row.appendChild(badge)
    wrap.appendChild(row)

    // 数据集：能力位里有的才出现（没有历史记录的源就不会有「历史」这一项）
    const datasetRow = el('div', 'bi-datasets')
    const datasetBoxes: HTMLInputElement[] = []
    let view: BrowserImportView | null = null
    const syncAction = (): void => view?.syncAction()
    for (const meta of DATASETS) {
      if (!(source.capabilities & meta.capability)) continue
      const label = el('label', 'bi-check')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = state.datasets.has(meta.id)
      box.addEventListener('change', () => {
        if (box.checked) state.datasets.add(meta.id)
        else state.datasets.delete(meta.id)
        syncAction()
      })
      label.appendChild(box)
      label.appendChild(el('span', undefined, meta.label))
      datasetRow.appendChild(label)
      datasetBoxes.push(box)
    }
    wrap.appendChild(datasetRow)

    // 用户配置（多 profile 机器：Chrome 的「个人资料 1 / 工作」等）
    const chipRow = el('div', 'bi-chips')
    const chipBoxes: HTMLInputElement[] = []
    for (const profile of source.profiles) {
      const chip = el('label', 'bi-chip')
      chip.title = describeProfile(profile)
      const box = el('input')
      box.type = 'checkbox'
      box.checked = state.profileIds.has(profile.id)
      box.addEventListener('change', () => {
        if (box.checked) state.profileIds.add(profile.id)
        else state.profileIds.delete(profile.id)
        syncAction()
      })
      chip.appendChild(box)
      chip.appendChild(el('span', undefined, profile.name || profile.id))
      chipRow.appendChild(chip)
      chipBoxes.push(box)
    }
    if (source.profiles.length > 1) wrap.appendChild(chipRow)

    // 动作行：状态文案在左，按钮在右
    const foot = el('div', 'bi-foot')
    const status = el('span', 'bi-status', state.result ? '' : '将导入所选用户配置中的所选数据')
    const runBtn = el('button', 'btn btn-sm', '一键导入')
    runBtn.type = 'button'
    foot.appendChild(status)
    foot.appendChild(runBtn)
    wrap.appendChild(foot)

    view = {
      wrap,
      done: Boolean(state.result && state.result.ok),
      badge,
      status,
      runBtn,
      datasetBoxes,
      chipBoxes,
      /** 至少选中一个 profile 且至少一类数据，才允许点。 */
      syncAction () {
        const ready = state.profileIds.size > 0 && state.datasets.size > 0
        runBtn.disabled = !ready
        if (!state.profileIds.size) setStatus(status, '请至少选择一个用户配置。', 'bad')
        else if (!state.datasets.size) setStatus(status, '请至少选择一类数据。', 'bad')
      }
    }

    runBtn.addEventListener('click', () => run(source, state, view))

    if (state.result) paintResult(state.result, view)
    else view.syncAction()

    return view
  }

  async function loadSources (): Promise<void> {
    let res: BrowserImportSourcesResponse
    try {
      res = await rpc<BrowserImportSourcesResponse>(IPC_ROUTES.browserImportSources, {})
    } catch (error) {
      res = { ok: false, error: error instanceof Error && error.message ? error.message : String(error) }
    }
    if (!alive) return

    const sources = res && Array.isArray(res.sources) ? res.sources : []
    const usable = sources.filter((s) => s && s.available && Array.isArray(s.profiles))

    sourceViews.clear()
    body.textContent = ''

    if (!usable.length) {
      setHeadBadge('未检测到', '')
      body.appendChild(
        el(
          'p',
          'bi-empty',
          (res && res.error) ? `检测失败：${res.error}` : '未检测到 Chrome 或 Edge 的用户数据。'
        )
      )
      return
    }

    for (const source of usable) {
      const view = buildSource(source)
      sourceViews.set(source.id, view)
      body.appendChild(view.wrap)
    }

    const done = [...sourceViews.values()].filter((v) => v.done).length
    setHeadBadge(done ? `已导入 ${done}` : '可导入', done ? 'ok' : '')
  }

  /** 执行导入：请求 → 回填结果 → 通知宿主。 */
  async function run (source: BrowserSource, state: BrowserImportState, view: BrowserImportView): Promise<void> {
    const profileIds = [...state.profileIds]
    const datasets = [...state.datasets]
    if (!profileIds.length || !datasets.length) return

    view.runBtn.disabled = true
    view.runBtn.textContent = '导入中…'
    setStatus(view.status, '正在读取浏览器数据…', '')
    setControlsDisabled(view, true)
    notifyBusy(true)

    try {
      let result: BrowserImportResult
      try {
        result = await rpc<BrowserImportResult>(IPC_ROUTES.browserImportRun, { sourceId: source.id, profileIds, datasets })
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (!result || typeof result !== 'object') result = { ok: false, error: '没有收到导入结果。' }

      state.result = result
      view.done = Boolean(result.ok)
      if (alive) paintResult(result, view)
      if (typeof onDone === 'function') {
        try { onDone(result, source) } catch (_) { /* 宿主回调异常不影响本卡片 */ }
      }
    } finally {
      setControlsDisabled(view, false)
      notifyBusy(false)
      if (alive) {
        view.runBtn.textContent = '重新导入'
        view.syncAction()
      }
    }
  }

  function setControlsDisabled (view: BrowserImportView, disabled: boolean): void {
    for (const box of view.datasetBoxes) box.disabled = disabled
    for (const box of view.chipBoxes) box.disabled = disabled
    if (disabled) view.runBtn.disabled = true
  }

  function notifyBusy (busy: boolean): void {
    if (typeof onBusyChange !== 'function') return
    try {
      onBusyChange(busy)
    } catch (_) {
      // Host lifecycle callbacks must not break the importer.
    }
  }

  /** 结果 → 徽标 / 状态行 / 按钮文案。 */
  function paintResult (result: BrowserImportResult, view: BrowserImportView): void {
    const { badge, status, runBtn } = view
    if (runBtn) {
      runBtn.disabled = false
      runBtn.textContent = '重新导入'
    }
    if (!badge || !status) return

    const counts = summarize(result)

    if (result.error) {
      paintBadge(badge, '失败', 'bad')
      setStatus(status, `导入失败：${result.error}`, 'bad')
      return
    }

    const errors = Array.isArray(result.errors) ? result.errors : []
    if (errors.length) {
      paintBadge(badge, counts.imported ? '部分导入' : '失败', 'bad')
      const tail = counts.imported ? counts.text : ''
      setStatus(status, `${errors[0]}${tail ? `（已写入：${tail}）` : ''}`, 'bad')
      return
    }

    if (counts.imported > 0) {
      paintBadge(badge, '已导入', 'ok')
      setStatus(status, counts.text ? `已导入 ${counts.text}。` : '导入完成。', 'ok')
      return
    }

    paintBadge(badge, '无新数据', '')
    setStatus(
      status,
      counts.skipped > 0
        ? `没有新增数据（${counts.skipped} 条已存在，自动跳过）。`
        : '没有可导入的数据。',
      ''
    )
  }

  function paintBadge (badge: HTMLElement, text: string, tone: string): void {
    badge.textContent = text
    badge.classList.toggle('badge-success', tone === 'ok')
    badge.classList.toggle('badge-danger', tone === 'bad')
  }

  function destroy (): void {
    alive = false
    root.remove()
  }

  async function refresh (): Promise<void> {
    await loadSources()
  }

  loadSources()

  return { el: root, destroy, refresh }
}

/** profile 的可用数据摘要（chip 的 title）。 */
function describeProfile (profile: BrowserProfile): string {
  const parts = DATASETS
    .filter((d) => (profile.capabilities || 0) & d.capability)
    .map((d) => d.label)
  return parts.length ? `${profile.name || profile.id}：${parts.join(' / ')}` : (profile.name || profile.id)
}

/** 状态行：文本 + 色调（is-ok / is-bad）。 */
function setStatus (node: HTMLElement, text: string, tone: string): void {
  node.textContent = text
  node.classList.toggle('is-ok', tone === 'ok')
  node.classList.toggle('is-bad', tone === 'bad')
}

/** 结构化结果 → 计数与一句话摘要文案。 */
function summarize (result: BrowserImportResult = {}): { imported: number; skipped: number; text: string } {
  const bookmarks = result.bookmarks || {}
  const history = result.history || {}
  const extensions = result.extensions || {}
  const imported =
    (bookmarks.imported || 0) + (history.imported || 0) + (extensions.imported || 0)
  const skipped =
    (bookmarks.skipped || 0) + (history.skipped || 0) + (extensions.skipped || 0)

  const parts: string[] = []
  if (bookmarks.imported || bookmarks.skipped) parts.push(`书签 ${bookmarks.imported || 0} 条`)
  if (history.imported || history.skipped) parts.push(`历史记录 ${history.imported || 0} 条`)
  if (extensions.imported || extensions.skipped) parts.push(`扩展 ${extensions.imported || 0} 个`)

  return { imported, skipped, text: parts.join('、') }
}
