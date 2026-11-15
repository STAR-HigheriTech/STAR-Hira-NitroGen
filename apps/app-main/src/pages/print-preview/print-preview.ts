/**
 * 打印预览（hira://print-preview）
 *
 * 本页只持有 jobId，通过 print IPC 获取元数据、渲染 PDF 并提交打印。
 * 页内不推导打印策略；纸张与边距词表来自 shared-types/print。
 */

import * as pdfjsLib from 'hira://pdfjs/pdf.min.mjs'
import type { PDFDocumentProxy, PDFPageViewport } from 'hira://pdfjs/pdf.min.mjs'
import { IPC_ROUTES, rpc, initTheme } from 'hira://shared/runtime.js'
import {
  PRINT_PAGE_SIZES,
  DEFAULT_PRINT_PAGE_SIZE,
  PRINT_MARGIN_MODES,
  PRINT_MARGIN_LABELS,
  DEFAULT_PRINT_MARGIN_MODE
} from 'hira://shared/print.mjs'

interface PrintOptions {
  pageSize: string
  landscape: boolean
  printBackground: boolean
  margins: string
  scale: number
}

interface PrintJobMeta {
  id: string
  title: string
  url: string
  createdAt: number
  rev: number
}

interface PrintJobResponse {
  job: PrintJobMeta | null
}

interface PrintRenderResponse {
  ok: boolean
  pdfUrl?: string
  job?: PrintJobMeta
  reason?: string
}

interface PrintActionResponse {
  ok: boolean
  canceled?: boolean
  filePath?: string
  reason?: string
}

interface PageSlot {
  index: number
  el: HTMLDivElement
  rendered: boolean
  rendering: boolean
}

interface PreviewState {
  meta: PrintJobMeta | null
  options: PrintOptions
  doc: PDFDocumentProxy | null
  baseViewport: PDFPageViewport | null
  fitScale: number
  zoom: number
  slots: PageSlot[]
  observer: IntersectionObserver | null
  renderToken: number
  loadToken: number
  busy: boolean
}

const VIEWER_PADDING = 24
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2

function requiredElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`打印预览缺少 #${id}`)
  return node as T
}

const ui = {
  title: requiredElement<HTMLSpanElement>('doc-title'),
  prev: requiredElement<HTMLButtonElement>('prev'),
  next: requiredElement<HTMLButtonElement>('next'),
  page: requiredElement<HTMLInputElement>('page'),
  total: requiredElement<HTMLSpanElement>('total'),
  zoomin: requiredElement<HTMLButtonElement>('zoomin'),
  zoomout: requiredElement<HTMLButtonElement>('zoomout'),
  zoom: requiredElement<HTMLSpanElement>('zoom'),
  fit: requiredElement<HTMLButtonElement>('fit'),
  viewer: requiredElement<HTMLDivElement>('viewer'),
  pageSize: requiredElement<HTMLSelectElement>('opt-page-size'),
  landscape: requiredElement<HTMLSelectElement>('opt-landscape'),
  margins: requiredElement<HTMLSelectElement>('opt-margins'),
  scale: requiredElement<HTMLInputElement>('opt-scale'),
  scaleValue: requiredElement<HTMLElement>('opt-scale-value'),
  background: requiredElement<HTMLInputElement>('opt-background'),
  cancel: requiredElement<HTMLButtonElement>('cancel'),
  save: requiredElement<HTMLButtonElement>('save'),
  print: requiredElement<HTMLButtonElement>('print'),
  status: requiredElement<HTMLSpanElement>('status')
} as const

pdfjsLib.GlobalWorkerOptions.workerSrc = 'hira://pdfjs/pdf.worker.min.mjs'
initTheme()

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (message !== undefined && message !== null && message !== '') return String(message)
  }
  return String(error)
}

function fillSelect(select: HTMLSelectElement, ids: readonly string[], labels?: Readonly<Record<string, string>>): void {
  select.textContent = ''
  for (const id of ids) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = labels?.[id] || id
    select.appendChild(option)
  }
}

fillSelect(ui.pageSize, PRINT_PAGE_SIZES)
fillSelect(ui.margins, PRINT_MARGIN_MODES, PRINT_MARGIN_LABELS)
ui.pageSize.value = DEFAULT_PRINT_PAGE_SIZE
ui.margins.value = DEFAULT_PRINT_MARGIN_MODE

function readJobId(): string {
  try {
    const raw = new URLSearchParams(location.search).get('payload')
    if (!raw) return ''
    const payload: unknown = JSON.parse(raw)
    if (!payload || typeof payload !== 'object') return ''
    const jobId = (payload as { jobId?: unknown }).jobId
    return jobId ? String(jobId) : ''
  } catch {
    return ''
  }
}

const jobId = readJobId()

const state: PreviewState = {
  meta: null,
  options: {
    pageSize: DEFAULT_PRINT_PAGE_SIZE,
    landscape: false,
    printBackground: true,
    margins: DEFAULT_PRINT_MARGIN_MODE,
    scale: 1
  },
  doc: null,
  baseViewport: null,
  fitScale: 1,
  zoom: 1,
  slots: [],
  observer: null,
  renderToken: 0,
  loadToken: 0,
  busy: false
}

function setStatus(text = '', isError = false): void {
  ui.status.textContent = text
  ui.status.classList.toggle('error', isError)
}

function setBusy(busy: boolean): void {
  state.busy = busy
  ui.save.disabled = busy
  ui.print.disabled = busy
}

function showError(message = ''): void {
  state.doc = null
  state.slots = []
  state.observer?.disconnect()
  state.observer = null
  ui.viewer.textContent = ''

  const box = document.createElement('div')
  box.className = 'error'
  const head = document.createElement('div')
  head.textContent = '⚠ 无法生成打印预览'
  const detail = document.createElement('div')
  detail.className = 'error-detail'
  detail.textContent = message
  box.append(head, detail)
  ui.viewer.appendChild(box)
  setStatus(message || '预览失败', true)
}

function syncOptionsFromUi(): void {
  state.options = {
    pageSize: ui.pageSize.value,
    landscape: ui.landscape.value === 'landscape',
    printBackground: ui.background.checked,
    margins: ui.margins.value,
    scale: Number(ui.scale.value) / 100
  }
  ui.scaleValue.textContent = `${ui.scale.value}%`
}

let applyTimer = 0

function scheduleApply(delay = 0): void {
  syncOptionsFromUi()
  window.clearTimeout(applyTimer)
  applyTimer = window.setTimeout(() => { void applyOptions() }, delay)
}

async function applyOptions(): Promise<void> {
  if (!jobId) return
  const token = ++state.renderToken
  setStatus('正在生成预览…')
  try {
    const result = await rpc<PrintRenderResponse>(IPC_ROUTES.printRender, {
      jobId,
      options: state.options
    })
    if (token !== state.renderToken) return
    if (!result?.ok) {
      setStatus(`预览生成失败：${result?.reason || '未知错误'}`, true)
      return
    }
    const pdfUrl = result.pdfUrl || ''
    if (!pdfUrl) {
      setStatus('预览生成失败：主进程未返回 PDF 地址', true)
      return
    }
    await loadPdf(pdfUrl, result.job?.rev ?? Date.now())
  } catch (error) {
    if (token !== state.renderToken) return
    setStatus(`预览生成失败：${errorText(error)}`, true)
  }
}

function releaseDocument(): void {
  const doc = state.doc
  state.doc = null
  if (!doc) return
  void doc.destroy().catch(() => {})
}

async function loadPdf(url: string, rev: number): Promise<void> {
  const token = ++state.loadToken
  const keepPage = currentPage()

  releaseDocument()
  state.slots = []
  state.observer?.disconnect()
  state.observer = null
  ui.viewer.textContent = ''

  const loading = document.createElement('div')
  loading.className = 'loading'
  const spinner = document.createElement('div')
  spinner.className = 'spinner'
  const label = document.createElement('span')
  label.textContent = '正在生成预览…'
  loading.append(spinner, label)
  ui.viewer.appendChild(loading)

  try {
    const doc = await pdfjsLib.getDocument({ url: `${url}?rev=${rev}` }).promise
    if (token !== state.loadToken) {
      await doc.destroy()
      return
    }
    state.doc = doc
    ui.total.textContent = `/ ${doc.numPages}`
    ui.page.max = String(doc.numPages)
    for (const button of [ui.prev, ui.next, ui.page, ui.zoomin, ui.zoomout, ui.fit]) {
      button.disabled = false
    }
    await rebuildSlots()
    if (token !== state.loadToken) return
    scrollToPage(Math.min(Math.max(1, keepPage), doc.numPages), false)
    setStatus('')
  } catch (error) {
    if (token !== state.loadToken) return
    showError(errorText(error))
  }
}

function computeFitScale(): number {
  const base = state.baseViewport
  if (!base) return 1
  const available = ui.viewer.clientWidth - VIEWER_PADDING * 2
  if (available <= 0) return 1
  return Math.min(3, Math.max(0.1, available / base.width))
}

async function rebuildSlots(): Promise<void> {
  const doc = state.doc
  if (!doc) return
  const first = await doc.getPage(1)
  state.baseViewport = first.getViewport({ scale: 1 })
  state.fitScale = computeFitScale()
  const scale = state.fitScale * state.zoom

  state.observer?.disconnect()
  state.slots = []
  ui.viewer.textContent = ''

  const observer = new IntersectionObserver((entries) => onIntersect(entries), {
    root: ui.viewer,
    rootMargin: '800px 0px'
  })
  state.observer = observer

  const ratio = `${state.baseViewport.width} / ${state.baseViewport.height}`
  const width = Math.round(state.baseViewport.width * scale)

  for (let index = 1; index <= doc.numPages; index++) {
    const el = document.createElement('div')
    el.className = 'page-slot'
    el.style.aspectRatio = ratio
    el.style.width = `${width}px`
    const slot: PageSlot = { index, el, rendered: false, rendering: false }
    state.slots.push(slot)
    ui.viewer.appendChild(el)
    observer.observe(el)
  }

  updateZoomLabel()
  updatePageIndicator()
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    const slot = state.slots.find((item) => item.el === entry.target)
    if (slot) void renderSlot(slot)
  }
  updatePageIndicator()
}

async function renderSlot(slot: PageSlot): Promise<void> {
  const doc = state.doc
  if (!doc || slot.rendered || slot.rendering) return
  slot.rendering = true
  try {
    const page = await doc.getPage(slot.index)
    if (state.doc !== doc) return
    const scale = state.fitScale * state.zoom
    const viewport = page.getViewport({ scale })
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('无法创建预览画布')
    const params: Parameters<typeof page.render>[0] = {
      canvasContext: context,
      viewport,
      ...(dpr === 1 ? {} : { transform: [dpr, 0, 0, dpr, 0, 0] })
    }
    await page.render(params).promise
    if (state.doc !== doc) return
    slot.el.style.aspectRatio = `${viewport.width} / ${viewport.height}`
    slot.el.replaceChildren(canvas)
    slot.rendered = true
  } catch (error) {
    console.error('[print-preview] render page failed:', error)
  } finally {
    slot.rendering = false
  }
}

function currentPage(): number {
  if (!state.slots.length) return 1
  const viewerTop = ui.viewer.getBoundingClientRect().top + VIEWER_PADDING
  let best = 1
  let bestDistance = Infinity
  for (const slot of state.slots) {
    const distance = Math.abs(slot.el.getBoundingClientRect().top - viewerTop)
    if (distance < bestDistance) {
      bestDistance = distance
      best = slot.index
    }
  }
  return best
}

function updatePageIndicator(): void {
  if (!state.slots.length) {
    ui.page.value = '1'
    ui.prev.disabled = true
    ui.next.disabled = true
    return
  }
  const page = currentPage()
  if (document.activeElement !== ui.page) ui.page.value = String(page)
  ui.prev.disabled = page <= 1
  ui.next.disabled = page >= state.slots.length
}

function updateZoomLabel(): void {
  ui.zoom.textContent = `${Math.round(state.zoom * 100)}%`
}

function scrollToPage(page: number, smooth = true): void {
  const slot = state.slots[page - 1]
  if (!slot) return
  const delta = slot.el.getBoundingClientRect().top - ui.viewer.getBoundingClientRect().top
  ui.viewer.scrollTo({
    top: Math.max(0, ui.viewer.scrollTop + delta - VIEWER_PADDING),
    behavior: smooth ? 'smooth' : 'auto'
  })
  updatePageIndicator()
}

async function setZoom(next: number): Promise<void> {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
  if (Math.abs(zoom - state.zoom) < 0.001) return
  state.zoom = zoom
  const page = currentPage()
  await rebuildSlots()
  scrollToPage(page, false)
}

async function doPrint(): Promise<void> {
  if (state.busy) return
  setBusy(true)
  setStatus('正在打开打印对话框…')
  try {
    const result = await rpc<PrintActionResponse>(IPC_ROUTES.printCommit, {
      jobId,
      options: state.options
    })
    if (result?.ok) {
      closePreview()
      return
    }
    setStatus(`打印失败：${result?.reason || '未知错误'}`, true)
  } catch (error) {
    setStatus(`打印失败：${errorText(error)}`, true)
  }
  setBusy(false)
}

async function doSave(): Promise<void> {
  if (state.busy) return
  setBusy(true)
  setStatus('正在准备 PDF…')
  try {
    const result = await rpc<PrintActionResponse>(IPC_ROUTES.printSavePdf, {
      jobId,
      options: state.options
    })
    if (result?.ok) {
      setStatus(`已保存到 ${result.filePath || ''}`)
    } else if (result?.canceled) {
      setStatus('')
    } else {
      setStatus(`保存失败：${result?.reason || '未知错误'}`, true)
    }
  } catch (error) {
    setStatus(`保存失败：${errorText(error)}`, true)
  } finally {
    setBusy(false)
  }
}

function closePreview(): void {
  void rpc(IPC_ROUTES.printClose, { jobId }).catch(() => {})
  window.close()
}

ui.pageSize.addEventListener('change', () => scheduleApply())
ui.landscape.addEventListener('change', () => scheduleApply())
ui.margins.addEventListener('change', () => scheduleApply())
ui.background.addEventListener('change', () => scheduleApply())
ui.scale.addEventListener('input', () => scheduleApply(260))

ui.prev.addEventListener('click', () => scrollToPage(Math.max(1, currentPage() - 1)))
ui.next.addEventListener('click', () => scrollToPage(Math.min(state.slots.length, currentPage() + 1)))
ui.page.addEventListener('change', () => {
  const page = Number.parseInt(ui.page.value, 10)
  if (Number.isFinite(page) && page >= 1 && page <= state.slots.length) scrollToPage(page)
})
ui.zoomin.addEventListener('click', () => { void setZoom(state.zoom * 1.15) })
ui.zoomout.addEventListener('click', () => { void setZoom(state.zoom / 1.15) })
ui.fit.addEventListener('click', () => { void setZoom(1) })

ui.cancel.addEventListener('click', closePreview)
ui.print.addEventListener('click', () => { void doPrint() })
ui.save.addEventListener('click', () => { void doSave() })

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return
  if (event.key === 'Escape') {
    event.preventDefault()
    closePreview()
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    void doPrint()
  }
})

let scrollTick = 0
ui.viewer.addEventListener('scroll', () => {
  if (scrollTick) return
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0
    updatePageIndicator()
  })
})

let resizeTimer = 0
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    void (async () => {
      if (!state.doc) return
      const page = currentPage()
      await rebuildSlots()
      scrollToPage(page, false)
    })()
  }, 180)
})

window.addEventListener('beforeunload', () => {
  try {
    void rpc(IPC_ROUTES.printClose, { jobId }).catch(() => {})
  } catch {
    // 主进程还有 job TTL 兜底。
  }
  releaseDocument()
})

async function start(): Promise<void> {
  syncOptionsFromUi()
  if (!jobId) {
    showError('缺少打印任务信息，请重新从页面发起打印。')
    return
  }
  try {
    const result = await rpc<PrintJobResponse>(IPC_ROUTES.printJob, { jobId })
    state.meta = result?.job || null
  } catch (error) {
    showError(`读取打印任务失败：${errorText(error)}`)
    return
  }
  const meta = state.meta
  if (!meta) {
    showError('打印任务已失效，请重新发起打印。')
    return
  }
  ui.title.textContent = meta.title || meta.url || '打印预览'
  ui.title.title = meta.url || meta.title || ''
  document.title = `${meta.title ? `${meta.title} - ` : ''}打印预览`
  await applyOptions()
}

void start()
