import * as pdfjsLib from 'hira://pdfjs/pdf.min.mjs'
import type { PDFDocumentProxy } from 'hira://pdfjs/pdf.min.mjs'
import { rpc } from 'hira://shared/runtime.js'
import { PDF_SETTING_KEYS, DEFAULT_PDF_ZOOM } from 'hira://shared/pdf.mjs'
import { errorMessage, isRecord, requiredById } from 'hira://shared/page-kit.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = 'hira://pdfjs/pdf.worker.min.mjs'

// 内置默认缩放（拿不到设置时的回退值）—— 取自 shared-types 真源，与 registry 同源。
const DEFAULT_SCALE = parseFloat(DEFAULT_PDF_ZOOM)

const params = new URLSearchParams(location.search)
const pdfUrl = params.get('url') || ''
const viewer = requiredById<HTMLElement>('viewer')
const pageInput = requiredById<HTMLInputElement>('page')
const zoomLabel = requiredById<HTMLElement>('zoom')
const fileNameEl = requiredById<HTMLElement>('filename')
const totalEl = requiredById<HTMLElement>('total')
const canvas = document.createElement('canvas')
const ctx = canvas.getContext('2d')
let pdfDoc: PDFDocumentProxy | null = null
let pageNum = 1
let scale = DEFAULT_SCALE
let rendering = false
let pending: number | null = null

/**
 * 读取设置 PDF_SETTING_KEYS.defaultZoom 作为初始缩放。
 * 档位集合来自 shared-types/pdf.mjs（与 settings/registry.js 的下拉同源）；
 * 本页缩放机制就是 pdfjs 的 viewport scale，这里只设初值，不改动既有缩放逻辑。
 * @returns {Promise<number>}
 */
async function readDefaultZoom () : Promise<number> {
  try {
    const res = await rpc<unknown>('settings:get', { key: PDF_SETTING_KEYS.defaultZoom })
    const v = isRecord(res) && 'value' in res ? res.value : res
    const n = parseFloat(String(v))
    if (Number.isFinite(n) && n > 0) return n
  } catch (_) {}
  return DEFAULT_SCALE
}

function showLoading (): void {
  const root = document.createElement('div')
  root.className = 'loading'
  const spinner = document.createElement('div')
  spinner.className = 'spinner'
  const label = document.createElement('span')
  label.textContent = 'Loading PDF…'
  root.append(spinner, label)
  viewer.replaceChildren(root)
}

function showError (message: string): void {
  const root = document.createElement('div')
  root.className = 'error'
  const title = document.createElement('div')
  title.textContent = '⚠ Failed to load PDF'
  const detail = document.createElement('div')
  detail.style.fontSize = '12px'
  detail.textContent = message
  root.append(title, detail)
  viewer.replaceChildren(root)
}

async function renderPage (num: number): Promise<void> {
  if (rendering) { pending = num; return }
  const documentProxy = pdfDoc
  if (!documentProxy || !ctx) return
  rendering = true
  try {
    const page = await documentProxy.getPage(num)
    const viewport = page.getViewport({ scale })
    canvas.height = viewport.height
    canvas.width = viewport.width
    await page.render({ canvasContext: ctx, viewport }).promise
    viewer.replaceChildren(canvas)
    pageInput.value = String(num)
    zoomLabel.textContent = Math.round(scale * 100) + '%'
  } catch (e) {
    console.error('[pdf] render error:', e)
  }
  rendering = false
  if (pending !== null) { const n = pending; pending = null; renderPage(n) }
}

async function loadPdf (): Promise<void> {
  if (!pdfUrl) { showError('No PDF URL provided'); return }
  let filename = pdfUrl
  try { filename = decodeURIComponent(pdfUrl.split('/').pop() || pdfUrl) } catch (_) {}
  fileNameEl.textContent = filename
  try {
    const task = pdfjsLib.getDocument({ url: pdfUrl })
    pdfDoc = await task.promise
    totalEl.textContent = '/ ' + pdfDoc.numPages
    pageInput.max = String(pdfDoc.numPages)
    for (const id of ['prev', 'next', 'zoomin', 'zoomout', 'fit', 'page'] as const) {
      requiredById<HTMLButtonElement | HTMLInputElement>(id).disabled = false
    }
    await renderPage(1)
  } catch (e) {
    console.error('[pdf] load error:', e)
    showError(errorMessage(e))
  }
}

const previousButton = requiredById<HTMLButtonElement>('prev')
const nextButton = requiredById<HTMLButtonElement>('next')
const zoomInButton = requiredById<HTMLButtonElement>('zoomin')
const zoomOutButton = requiredById<HTMLButtonElement>('zoomout')
const fitButton = requiredById<HTMLButtonElement>('fit')

previousButton.addEventListener('click', () => {
  if (pageNum <= 1) return
  pageNum--
  renderPage(pageNum)
})
nextButton.addEventListener('click', () => {
  if (!pdfDoc || pageNum >= pdfDoc.numPages) return
  pageNum++
  renderPage(pageNum)
})
pageInput.addEventListener('change', () => {
  const n = parseInt(pageInput.value, 10)
  if (n >= 1 && pdfDoc && n <= pdfDoc.numPages) { pageNum = n; renderPage(pageNum) }
})
zoomInButton.addEventListener('click', () => {
  scale = Math.min(scale * 1.2, 5)
  renderPage(pageNum)
})
zoomOutButton.addEventListener('click', () => {
  scale = Math.max(scale / 1.2, 0.25)
  renderPage(pageNum)
})
fitButton.addEventListener('click', async () => {
  if (!pdfDoc) return
  const page = await pdfDoc.getPage(pageNum)
  const viewport = page.getViewport({ scale: 1 })
  const containerWidth = viewer.clientWidth - 32
  scale = containerWidth / viewport.width
  renderPage(pageNum)
})

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.target instanceof Element && e.target.tagName === 'INPUT') return
  if (e.key === 'ArrowLeft') previousButton.click()
  else if (e.key === 'ArrowRight') nextButton.click()
  else if (e.key === '+' || e.key === '=') zoomInButton.click()
  else if (e.key === '-') zoomOutButton.click()
})

// 启动：先取设置里的初始缩放，再加载 PDF（取不到即用 DEFAULT_SCALE）。
async function start (): Promise<void> {
  const zoom = await readDefaultZoom()
  scale = zoom
  zoomLabel.textContent = Math.round(scale * 100) + '%'
  await loadPdf()
}

start()
