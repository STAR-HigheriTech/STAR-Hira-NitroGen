/*
 * 地址与支付卡（N7）—— `hira://formfill`
 *
 * 静态内部页（无打包器）：只走标准 preload 桥 + `form-fill:*` 四条路由。
 *
 * 字段表**不手抄**：走 `hira://shared/form-fill.mjs`（与主进程同一份真源，
 * 由 electron.vite.config.js 的 sync-shared-contracts 从 `shared-types/src/` 复制）——
 * 页面画表单、主进程做摘要，字段键名必须逐字一致，抄两份必然漂移。
 *
 * ⚠ 路径必须是 `hira://shared/…` 这个**别名 origin**，不能写 `../_shared/form-fill.mjs`：
 *   本页的 URL 是 `hira://formfill/formfill.js`，同源相对跳转会解析成
 *   `hira://formfill/_shared/form-fill.mjs` —— 那是 formfill 自己的目录，文件不存在，
 *   整个模块（连带本页所有逻辑）直接 404 不执行。共享层只活在 `hira://shared/`。
 */
import { IPC_ROUTES, rpc, el, fmtTime, renderEmpty, initTheme } from 'hira://shared/runtime.js'
import { ADDRESS_FIELDS, CARD_FIELDS } from 'hira://shared/form-fill.mjs'
import { errorMessage, isRecord, requiredById, stringValue } from 'hira://shared/page-kit.js'

type FormField = readonly [key: string, label: string]

function toFormFields(fields: readonly (readonly string[])[]): ReadonlyArray<FormField> {
  return fields.flatMap(([key, label]) => key && label ? [[key, label] as const] : [])
}

const ADDRESS_FORM_FIELDS = toFormFields(ADDRESS_FIELDS)
const CARD_FORM_FIELDS = toFormFields(CARD_FIELDS)

interface FormFillItem {
  id: string
  kind?: string
  label?: string
  detail?: string
  updatedAt?: number | string
}

function isFormFillItem(value: unknown): value is FormFillItem {
  if (!isRecord(value) || typeof value.id !== 'string') return false
  return (value.kind === undefined || typeof value.kind === 'string') &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.detail === undefined || typeof value.detail === 'string') &&
    (value.updatedAt === undefined || typeof value.updatedAt === 'number' || typeof value.updatedAt === 'string')
}

interface FormFillOperation {
  ok?: boolean
  reason?: string
  kind?: string
  data?: Record<string, unknown>
}

interface FormFillListResponse {
  items?: unknown
}

initTheme()

const formHost = requiredById<HTMLElement>('fields')
const messageHost = requiredById<HTMLElement>('message')
const listHost = requiredById<HTMLElement>('list')
const countEl = requiredById<HTMLElement>('count')
const kindSelect = requiredById<HTMLSelectElement>('kind')
const labelInput = requiredById<HTMLInputElement>('label')
const filterInput = requiredById<HTMLInputElement>('filter')
const editor = requiredById<HTMLElement>('editor')
const editorTitle = requiredById<HTMLElement>('editor-title')
const addToggle = requiredById<HTMLButtonElement>('add-toggle')
const refreshButton = requiredById<HTMLButtonElement>('refresh')
const cancelButton = requiredById<HTMLButtonElement>('cancel')
const addButton = requiredById<HTMLButtonElement>('add')

/** 当前表单的输入框（键 → input 元素）。 */
let fieldInputs: Record<string, HTMLInputElement> = {}
/** 最近一次拉取的条目（搜索在本地过滤，不重复过 IPC）。 */
let items: FormFillItem[] = []
let filterText = ''

function fieldList(): ReadonlyArray<FormField> {
  return kindSelect.value === 'card' ? CARD_FORM_FIELDS : ADDRESS_FORM_FIELDS
}

/** 面板标题跟随类型切换：展开的是一块「新增地址 / 新增支付卡」工作区，不是泛泛的表单。 */
function syncEditorTitle(): void {
  editorTitle.textContent = kindSelect.value === 'card' ? '新增支付卡' : '新增收货地址'
}

/** 按当前类型重建表单（字段表来自共享真源）。 */
function renderForm(): void {
  syncEditorTitle()
  formHost.textContent = ''
  fieldInputs = {}
  const grid = el('div', 'form-grid')
  for (const [key, label] of fieldList()) {
    const wrap = el('label', 'field')
    wrap.appendChild(el('span', 'field-label', label))
    const input = document.createElement('input')
    input.type = 'text'
    input.autocomplete = 'off'
    input.dataset.key = key
    fieldInputs[key] = input
    wrap.appendChild(input)
    grid.appendChild(wrap)
  }
  formHost.appendChild(grid)
}

/** 新增区是折叠的：列表优先，只有主动点「新增」才展开，并聚焦到第一个字段。 */
function setEditorOpen(open: boolean): void {
  editor.hidden = !open
  addToggle.textContent = open ? '收起' : '新增'
  addToggle.setAttribute('aria-expanded', String(open))
  if (open) {
    messageHost.textContent = ''
    const first = Object.values(fieldInputs)[0] as HTMLElement | undefined
    if (first) first.focus()
  }
}

function showMessage(text?: string, ok = false): void {
  messageHost.textContent = ''
  if (!text) return
  const row = el('div', 'row')
  row.appendChild(el('div', 'meta', (ok ? '' : '⚠ ') + text))
  messageHost.appendChild(row)
}

/** 一行条目：摘要 + 显示 / 复制 / 删除。 */
function buildRow(item: FormFillItem, refresh: () => Promise<void>): HTMLElement {
  const row = el('div', 'row')
  const info = el('div', 'info')
  info.appendChild(el('div', 'name', (item.kind === 'card' ? '💳 ' : '🏠 ') + (item.label || '(未命名)')))
  const meta: string[] = item.detail ? [item.detail] : []
  if (item.updatedAt) meta.push('更新于 ' + fmtTime(item.updatedAt))
  info.appendChild(el('div', 'meta', meta.filter(Boolean).join(' · ')))
  row.appendChild(info)

  // 「显示」= 显式揭示：明文只在这一刻取回，用完即弃（不写进 DOM 的 dataset）。
  const reveal = el('button', 'btn', '显示')
  reveal.onclick = async () => {
    try {
      const res = await rpc<FormFillOperation>(IPC_ROUTES.formFillReveal, { id: item.id })
      if (!res || !res.ok) {
        showMessage(res?.reason || '无法显示', false)
        return
      }
      const fields = res.kind === 'card' ? CARD_FORM_FIELDS : ADDRESS_FORM_FIELDS
      const data = isRecord(res.data) ? res.data : {}
      const text = fields.map(([key, label]) => `${label}：${stringValue(data[key])}`).join('\n')
      reveal.textContent = '复制'
      reveal.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text)
          reveal.textContent = '已复制'
          window.setTimeout(() => { reveal.textContent = '显示' }, 1200)
        } catch (error) {
          showMessage('复制失败：' + errorMessage(error), false)
        }
      }
      showMessage('已显示明文（再点一次「复制」可复制）。', true)
      // 明文只进这个临时提示区，不进任何持久位置。
      const box = el('div', 'row')
      const pre = document.createElement('pre')
      pre.style.cssText = 'white-space:pre-wrap;font-size:12px;opacity:.85;margin:0;'
      pre.textContent = text
      box.appendChild(pre)
      messageHost.appendChild(box)
    } catch (error) {
      showMessage('无法显示：' + errorMessage(error), false)
    }
  }
  row.appendChild(reveal)

  const remove = el('button', 'icon-btn', '\u2715')
  remove.title = '删除该条目'
  remove.onclick = async () => {
    await rpc(IPC_ROUTES.formFillRemove, { id: item.id })
    await refresh()
  }
  row.appendChild(remove)
  return row
}

/** 按名称 / 摘要本地过滤后重绘。计数同步显示「可见 / 总数」。 */
function renderList(): void {
  const query = filterText.toLowerCase()
  const visible = query
    ? items.filter((item: FormFillItem) =>
        `${item.label || ''} ${item.detail || ''}`.toLowerCase().includes(query))
    : items

  countEl.textContent = query
    ? `${visible.length}/${items.length}`
    : (items.length ? String(items.length) : '')

  listHost.textContent = ''
  if (!visible.length) {
    renderEmpty(listHost, items.length ? '没有匹配的条目。' : '还没有保存任何地址或支付卡。')
    return
  }
  for (const item of visible) listHost.appendChild(buildRow(item, refresh))
}

async function refresh(): Promise<void> {
  const response = await rpc<FormFillListResponse>(IPC_ROUTES.formFillList, {})
    .catch((): FormFillListResponse => ({}))
  items = Array.isArray(response.items) ? response.items.filter(isFormFillItem) : []
  renderList()
}

refreshButton.onclick = () => refresh()
addToggle.onclick = () => setEditorOpen(editor.hidden)
cancelButton.onclick = () => setEditorOpen(false)
kindSelect.addEventListener('change', renderForm)

filterInput.addEventListener('input', (event: Event) => {
  const target = event.currentTarget
  filterText = target instanceof HTMLInputElement ? target.value.trim() : ''
  renderList()
})

addButton.onclick = async () => {
  const data: Record<string, string> = {}
  for (const [key] of fieldList()) {
    const input = fieldInputs[key]
    const value = ((input && input.value) || '').trim()
    if (value) data[key] = value
  }
  if (!Object.keys(data).length) {
    showMessage('请至少填写一项内容', false)
    return
  }
  try {
    const res = await rpc<FormFillOperation>(IPC_ROUTES.formFillAdd, {
      kind: kindSelect.value,
      label: (labelInput.value || '').trim(),
      data
    })
    if (res && res.ok) {
      labelInput.value = ''
      for (const key of Object.keys(fieldInputs)) fieldInputs[key].value = ''
      setEditorOpen(false)
      showMessage('已加密保存。', true)
    } else {
      showMessage(res?.reason || '保存失败', false)
    }
  } catch (error) {
    showMessage('保存失败：' + errorMessage(error), false)
  }
  refresh()
}

renderForm()
refresh().catch((error?) => {
  console.error('[formfill] load failed:', errorMessage(error))
})
