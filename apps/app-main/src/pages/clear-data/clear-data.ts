import { IPC_ROUTES, rpc, el, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, isRecord, requiredById, stringValue } from 'hira://shared/page-kit.js'

// 跟随 app.theme 三态（浅/深/系统），配色统一于设置页 → base.css 同源 token
initTheme()

/**
 * 可清除的数据类型 —— 取值必须是契约 BROWSING_DATA_TYPES 的子集，
 * 顺序即界面顺序，与主进程 clearStorageData 的分桶一一对应。
 * `checked: true` 是默认勾选项：用户点开面板就是一键可执行的状态，
 * 不必先逐项勾选（曾经全默认不勾 → 点按钮直接提示「请至少选择一项」，
 * 被当成「页面没效果」）。
 */
const TYPES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['history', '浏览记录', true],
  ['downloads', '下载记录', true],
  ['cache', '缓存的图片和文件', true],
  ['cookies', 'Cookie', true],
  ['siteData', '站点数据（含 Cookie、本地存储、Service Worker 等）', false],
  ['localStorage', '本地存储', false],
  ['indexedDB', 'IndexedDB', false],
  ['serviceWorkers', 'Service Worker', false],
  ['cacheStorage', '缓存存储', false]
]

/** 时间范围 → 毫秒回退量；'all' 表示不传 since。 */
const RANGES: ReadonlyArray<readonly [string, string, number]> = [
  ['all', '全部时间', 0],
  ['hour', '最近 1 小时', 3600000],
  ['day', '最近 24 小时', 86400000],
  ['week', '最近 7 天', 604800000]
]

const typeInputs = new Map<string, HTMLInputElement>()
let rangeKey: string = 'all'

const stateEl = requiredById<HTMLElement>('state')
const runBtn = requiredById<HTMLButtonElement>('run')
const selectAllBtn = requiredById<HTMLButtonElement>('select-all')
const selectNoneBtn = requiredById<HTMLButtonElement>('select-none')
const resultSection = requiredById<HTMLElement>('result-section')
const resultsEl = requiredById<HTMLElement>('results')

function buildTypes (): void {
  const host = requiredById<HTMLElement>('types')
  for (const [value, label, checked] of TYPES) {
    const wrap = el('label', 'check')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = value
    input.checked = Boolean(checked)
    input.onchange = syncRunState
    wrap.appendChild(input)
    wrap.appendChild(el('span', undefined, label))
    typeInputs.set(value, input)
    host.appendChild(wrap)
  }
}

function buildRanges (): void {
  const host = requiredById<HTMLElement>('ranges')
  for (const [value, label] of RANGES) {
    const btn = el('button', 'range', label)
    btn.type = 'button'
    btn.setAttribute('aria-pressed', String(value === rangeKey))
    btn.onclick = () => {
      rangeKey = value
      for (const other of host.children) {
        other.setAttribute('aria-pressed', String(other === btn))
      }
    }
    host.appendChild(btn)
  }
}

function setAll (checked: boolean): void {
  for (const input of typeInputs.values()) input.checked = checked
  syncRunState()
}

function selectedTypes (): string[] {
  return TYPES.map(([value]) => value).filter((value: string) => {
    const input = typeInputs.get(value)
    return Boolean(input && input.checked)
  })
}

function syncRunState (): void {
  const empty = selectedTypes().length === 0
  runBtn.disabled = empty
  runBtn.setAttribute('aria-disabled', String(empty))
  if (empty) stateEl.textContent = '请至少选择一项要清除的数据。'
  else if (stateEl.textContent === '请至少选择一项要清除的数据。') stateEl.textContent = ''
}

function labelOf (type: string): string {
  const found = TYPES.find(([value]) => value === type)
  return found ? found[1] : type
}

function renderResults (
  types: readonly string[],
  results: Readonly<Record<string, unknown>>,
  errors: Readonly<Record<string, unknown>> | null
): void {
  resultsEl.textContent = ''
  for (const type of types) {
    const ok = results[type] === true
    const row = el('div', 'result ' + (ok ? 'result-ok' : 'result-fail'))
    row.appendChild(el('span', 'mark', ok ? '\u2713' : '\u2715'))
    let text = labelOf(type) + '：' + (ok ? '已清除' : '清除失败')
    const reason = errors && stringValue(errors[type])
    if (!ok && reason) text += '（' + reason + '）'
    row.appendChild(el('span', undefined, text))
    resultsEl.appendChild(row)
  }
  resultSection.hidden = false
}

async function run (): Promise<void> {
  const types = selectedTypes()
  resultSection.hidden = true
  resultsEl.textContent = ''

  if (types.length === 0) {
    stateEl.textContent = '请至少选择一项要清除的数据。'
    return
  }
  if (!confirm('确定要立即清除所选数据吗？此操作不可撤销。')) return

  const range = RANGES.find(([value]) => value === rangeKey)
  const payload: { types: string[]; since?: number } = { types }
  const offset = range ? range[2] : 0
  if (offset > 0) payload.since = Date.now() - offset

  runBtn.disabled = true
  stateEl.textContent = '正在清除…'
  try {
    const res = await rpc<Record<string, unknown>>(IPC_ROUTES.browsingDataClear, payload)
    const results = isRecord(res?.results) ? res.results : {}
    const errors = isRecord(res?.errors) ? res.errors : null
    renderResults(types, results, errors)
    const failed = types.filter((type: string) => results[type] !== true)
    stateEl.textContent = failed.length
      ? `完成，但有 ${failed.length} 项未成功。`
      : '全部清除成功。'
  } catch (error) {
    stateEl.textContent = '清除失败：' + errorMessage(error)
  } finally {
    syncRunState()
  }
}

buildTypes()
buildRanges()
selectAllBtn.onclick = () => setAll(true)
selectNoneBtn.onclick = () => setAll(false)
runBtn.onclick = run
syncRunState()
