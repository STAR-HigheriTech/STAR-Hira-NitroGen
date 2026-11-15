import { IPC_ROUTES, rpc, el, fmtSize, initTheme } from 'hira://shared/runtime.js'
// 一键迁移（Chrome / Edge）：与 OOBE 迁移步**同一份**组件，检测 / 勾选 / 结果全在卡片内。
import { createBrowserImportCard } from 'hira://shared/browser-import.js'
import { errorMessage, finiteNumber, isRecord, requiredById, stringValue } from 'hira://shared/page-kit.js'

type ImportKind = 'bookmarks' | 'passwords'

interface ImportKindSpec {
  label: string
  accept: string
}

interface ImportFormat {
  id: string
  label?: string
}

function isImportFormat(value: unknown): value is ImportFormat {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    (value.label === undefined || typeof value.label === 'string')
}

interface FormatsResponse {
  formats?: unknown
}

interface BookmarkImportResponse {
  error?: unknown
  imported?: unknown
  skipped?: unknown
}

interface PasswordImportResponse {
  imported?: unknown
  merged?: unknown
  skipped?: unknown
  total?: unknown
  unsupported?: unknown
  reason?: unknown
}

// 跟随 app.theme 三态（浅/深/系统）
initTheme()

// 一键迁移卡片挂在文件导入卡上方：两条通道并存，互不覆盖对方的结果区。
const browserImportHost = requiredById<HTMLElement>('browser-import')
browserImportHost.appendChild(createBrowserImportCard().el)

const fileInput = requiredById<HTMLInputElement>('file')
// 「选择文件」按钮：原生 input 已隐藏，点击项目统一的 .btn 转发给它。
// 选完文件后 input 自身仍会派发 change，下面的逻辑一行都不用改。
const chooseBtn = requiredById<HTMLButtonElement>('choose')
chooseBtn.addEventListener('click', () => fileInput.click())
const importBtn = requiredById<HTMLButtonElement>('import')
const fileNameEl = requiredById<HTMLElement>('file-name')
const statusEl = requiredById<HTMLElement>('status')
const resultSection = requiredById<HTMLElement>('result')
const resultGrid = requiredById<HTMLElement>('result-grid')
const resultHint = requiredById<HTMLElement>('result-hint')
// 插件贡献的导入格式（扩展点 bookmark.import-format）：空值 = 内建 Netscape HTML。
const formatSelect = requiredById<HTMLSelectElement>('format')
const formatsWrap = requiredById<HTMLElement>('formats-wrap')
// 数据类型：书签 HTML / 凭据 CSV。两种数据走各自的解析与入库路径。
const kindSelect = requiredById<HTMLSelectElement>('kind')

const KINDS: Readonly<Record<ImportKind, ImportKindSpec>> = Object.freeze({
  bookmarks: { label: '导入书签', accept: '.html,.htm,text/html' },
  passwords: { label: '导入密码', accept: '.csv,text/csv' }
})

let pickedFile: File | null = null
let pluginFormatsReady = false

function currentKind (): ImportKind {
  const value = kindSelect.value
  return value === 'passwords' ? 'passwords' : 'bookmarks'
}

/**
 * 拉取插件贡献的导入格式清单，填进下拉。
 *
 * 只有**至少有一个**插件格式时才显示这一行 —— 没有插件时页面与加入本功能之前
 * 完全一致（不给用户多一个无意义的选择）。清单来自各插件 manifest 的
 * `contributes.importFormats`（声明侧），所以这里不会执行任何插件代码。
 */
async function loadImportFormats (): Promise<void> {
  let formats: ImportFormat[] = []
  try {
    const res = await rpc<FormatsResponse>(IPC_ROUTES.bookmarkImportFormats, {})
    formats = Array.isArray(res?.formats) ? res.formats.filter(isImportFormat) : []
  } catch (_) {
    return // 拿不到就退回"只有内建 HTML"这一条路径，不是错误
  }
  if (!formats.length) return
  pluginFormatsReady = true

  const builtin = el('option', undefined, '书签 HTML（Netscape）')
  builtin.value = ''
  formatSelect.appendChild(builtin)
  for (const f of formats) {
    const opt = el('option', undefined, f.label || f.id)
    opt.value = f.id
    formatSelect.appendChild(opt)
  }
  applyKind()
}

/**
 * 切换数据类型时同步：按钮文案、文件选择器的过滤条件、插件格式行是否可见。
 * 换类型会清空已选文件 —— 防止把书签 HTML 当 CSV 递交（或反过来）后得到
 * 一句莫名其妙的"解析出 0 条"。
 */
function applyKind (): void {
  const kind = currentKind()
  const spec = KINDS[kind]
  fileInput.accept = spec.accept
  importBtn.textContent = spec.label
  formatsWrap.hidden = !(kind === 'bookmarks' && pluginFormatsReady)
}

function resetPickedFile (): void {
  pickedFile = null
  fileInput.value = ''
  importBtn.disabled = true
  fileNameEl.textContent = '尚未选择文件。'
  resetResult()
  setStatus('')
}

function setStatus (text: string, isError = false): void {
  statusEl.textContent = text
  statusEl.classList.toggle('importer-status--error', isError)
}

/** FileReader 读文本（写入一律走 textContent / el()，不拼 HTML 字符串）。 */
function readText (file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'))
    reader.readAsText(file)
  })
}

function addRow (label: string, value: unknown): void {
  resultGrid.appendChild(el('dt', undefined, label))
  resultGrid.appendChild(el('dd', undefined, String(value)))
}

function resetResult (): void {
  resultSection.hidden = true
  resultGrid.textContent = ''
  resultHint.textContent = ''
  resultHint.className = 'importer-hint'
}

fileInput.addEventListener('change', () => {
  pickedFile = fileInput.files?.[0] || null
  resetResult()
  importBtn.disabled = !pickedFile
  if (!pickedFile) {
    fileNameEl.textContent = '尚未选择文件。'
    setStatus('')
    return
  }
  const size = fmtSize(pickedFile.size)
  fileNameEl.textContent = `已选择：${pickedFile.name}${size ? `（${size}）` : ''}`
  setStatus('')
})

/** 书签：Netscape HTML 或插件格式（主进程侧翻译成 HTML）。 */
async function importBookmarks (text: string): Promise<void> {
  const file = pickedFile
  if (!file) return
  // 下拉为空 = 内建 Netscape HTML；否则把原文交给插件的格式解析器。
  const format = formatSelect.value
  const result = await rpc<BookmarkImportResponse>(
    IPC_ROUTES.bookmarkImport,
    format ? { format, content: text } : { html: text }
  )
  // 格式未知 / 解析器抛错：主进程回 error 而不是假装"0 条"（见 bookmarks.js）。
  if (result?.error) {
    resultSection.hidden = true
    setStatus(`导入失败：${stringValue(result.error, '未知错误')}`, true)
    return
  }
  const imported = finiteNumber(result?.imported)
  const skipped = finiteNumber(result?.skipped)

  resultGrid.textContent = ''
  addRow('源文件', file.name)
  if (format) addRow('格式', formatSelect.selectedOptions[0]?.textContent || format)
  addRow('成功导入', imported)
  addRow('跳过条目', skipped)
  resultSection.hidden = false

  if (imported === 0) {
    // 解析出 0 条 = 内容不是书签 HTML，如实告知且不谎报成功
    resultHint.className = 'importer-hint importer-hint--warn'
    resultHint.textContent = '解析出 0 条书签：该文件的内容不像 Netscape 书签 HTML（需要包含 <A HREF="…"> 或 <H3> 结构），因此没有写入任何数据。'
    setStatus('导入完成，但未解析到任何书签。', true)
  } else {
    resultHint.className = 'importer-hint'
    resultHint.textContent = skipped > 0
      ? `已写入 ${imported} 条，另有 ${skipped} 条因缺少链接地址被跳过。`
      : '全部条目已写入书签库。'
    setStatus('导入完成。')
  }
}

/**
 * 密码：CSV 原文交给域内解析（`credentialCsv.js`），页面不认表头也不做去重。
 *
 * 覆盖语义对齐旧版 Hira：同「网站 + 用户名」的现有凭据会被导入项覆盖。
 * 已有凭据时先确认一次，避免用户误把整库刷掉。
 */
async function importPasswords (text: string): Promise<void> {
  const file = pickedFile
  if (!file) return
  let existing = 0
  try {
    const listed = await rpc(IPC_ROUTES.passwordList, {})
    if (Array.isArray(listed)) existing = listed.length
  } catch (_) { /* 查不到数量不阻断导入 */ }

  if (existing > 0) {
    const ok = window.confirm(
      `当前已保存 ${existing} 条密码。\n导入会覆盖「同网站 + 同用户名」的旧密码，其余条目保持不变。\n是否继续？`
    )
    if (!ok) {
      setStatus('已取消导入。')
      return
    }
  }

  setStatus('正在导入…')
  const result = await rpc<PasswordImportResponse>(IPC_ROUTES.passwordImportCsv, { content: text })
  const imported = finiteNumber(result?.imported)
  const merged = finiteNumber(result?.merged)
  const skipped = finiteNumber(result?.skipped)
  const total = finiteNumber(result?.total, imported + merged + skipped)

  resultGrid.textContent = ''
  addRow('源文件', file.name)
  addRow('新增', imported)
  addRow('覆盖更新', merged)
  addRow('跳过条目', skipped)
  resultSection.hidden = false

  if (result?.unsupported) {
    resultHint.className = 'importer-hint importer-hint--warn'
    resultHint.textContent = '当前密码后端不支持批量导入（例如外部密码管理器后端）。请切换到内置密码库后再导入。'
    setStatus('导入失败：当前后端不支持批量导入。', true)
    return
  }
  if (result?.reason === 'encryption-unavailable') {
    resultHint.className = 'importer-hint importer-hint--warn'
    resultHint.textContent = '本机加密组件不可用，无法安全写入密码。已放弃本次导入，未写入任何数据。'
    setStatus('导入失败：加密组件不可用。', true)
    return
  }
  if (total === 0) {
    resultHint.className = 'importer-hint importer-hint--warn'
    resultHint.textContent = '解析出 0 条密码：需要包含 url/username/password 三列表头（或按此顺序的三列数据）。'
    setStatus('导入完成，但未解析到任何密码。', true)
    return
  }
  if (imported + merged === 0) {
    resultHint.className = 'importer-hint importer-hint--warn'
    resultHint.textContent = `共 ${total} 条记录，但都缺少网站地址 / 用户名 / 密码，没有写入任何数据。`
    setStatus('导入完成，但没有可写入的条目。', true)
    return
  }

  resultHint.className = 'importer-hint'
  const parts = [`新增 ${imported} 条`]
  if (merged > 0) parts.push(`覆盖 ${merged} 条`)
  if (skipped > 0) parts.push(`跳过 ${skipped} 条（缺少字段或文件内重复）`)
  resultHint.textContent = `${parts.join('，')}。`
  setStatus('导入完成。')
}

async function runImport () {
  if (!pickedFile) return
  importBtn.disabled = true
  resetResult()
  setStatus('正在读取文件…')

  let text = ''
  try {
    text = String(await readText(pickedFile))
  } catch (error) {
    setStatus(`读取文件失败：${errorMessage(error)}`, true)
    importBtn.disabled = false
    return
  }

  if (!text.trim()) {
    setStatus('文件内容为空，没有可导入的数据。', true)
    importBtn.disabled = false
    return
  }

  try {
    if (currentKind() === 'passwords') await importPasswords(text)
    else await importBookmarks(text)
  } catch (error) {
    setStatus(`导入失败：${errorMessage(error)}`, true)
  } finally {
    importBtn.disabled = !pickedFile
  }
}

importBtn.addEventListener('click', runImport)

// 切类型：清空已选文件，防止把书签 HTML 当 CSV 递交（或反过来）。
if (kindSelect) {
  kindSelect.addEventListener('change', () => {
    resetPickedFile()
    applyKind()
  })
}

applyKind()
// 启动：拉一次插件贡献的导入格式清单（没有插件时不显示这一行）。
loadImportFormats()
