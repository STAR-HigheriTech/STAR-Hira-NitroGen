/**
 * 打印服务（主进程）—— 整个打印体系的**唯一状态源**。
 *
 * ── 为什么要有 job ────────────────────────────────────────────────
 * 打印预览是一个**独立窗口**（hira://print-preview），它拿不到标签页的
 * WebContents。于是「要打印的那一页」必须先由主进程登记成一个 job，
 * 预览窗口只持有 jobId —— 预览页永远不认识标签、标签也不知道预览窗口存在。
 *
 * ── 职责边界（彻底解耦）──────────────────────────────────────────
 *   · 本文件只做三件事：登记 job、把 job 渲染成 PDF、把 PDF 交给系统打印。
 *   · 不认识菜单 / 快捷键 / 窗口 / IPC 通道 —— 那些分别在 app-menu、
 *     keybindings、window-config、ipc/print.ts 里，各自只接线。
 *   · 因此将来加「打印为图片 / 批量打印 / 打印页眉页脚」只动本文件的能力，
 *     不会牵动任何调用方。
 *
 * ── 生命周期 ─────────────────────────────────────────────────────
 * job 保存在内存 Map 里，带上限（MAX_JOBS）与 TTL：打印预览关掉后没人
 * 会来取，不能让它一直攥着源 WebContents（那会让整页渲染进程无法休眠）。
 *
 * 渲染结果（PDF Buffer）按 `rev` 缓存：预览页每次改选项都会要一份新的 PDF，
 * 同一个 rev 反复取（比如窗口重载）不再重复 printToPDF。
 */

const fs = require('fs/promises')
const { dialog } = require('electron')
import type {
  BrowserWindow as BrowserWindowType,
  PrintToPDFOptions,
  WebContents,
  WebContentsPrintOptions
} from 'electron'
// 纸张 / 边距词表与缺省值的唯一真源（IPC 契约与预览页下拉共用同一份）。
const {
  PRINT_PAGE_SIZES,
  DEFAULT_PRINT_PAGE_SIZE,
  DEFAULT_PRINT_MARGIN_MODE
} = require('@hira-ng/shared-types/src/print.mjs')

/**
 * 纸张名 / 边距模式：**合法取值不在这里枚举** —— 词表真源是 shared-types/print.mjs，
 * 由 `normalizePrintOptions` 在边界上按 `PRINT_PAGE_SIZES` / `PRINT_MARGIN_MODES` 收口。
 * 再写一份字面量联合类型就是同一份词表的第二个真相（新增纸张时必然漏改）。
 */
type PageSize = string
type MarginMode = string

export interface PrintOptions {
  pageSize: PageSize
  landscape: boolean
  printBackground: boolean
  margins: MarginMode
  scale: number
}

export interface PrintJobMeta {
  id: string
  title: string
  url: string
  createdAt: number
  rev: number
}

interface PrintJob extends PrintJobMeta {
  webContents: WebContents | null
  targetDestroyed: (() => void) | null
  dropped: boolean
  pdf: Buffer | null
  /** 缓存 PDF 对应的选项键（选项变了就必须重渲染） */
  pdfKey: string | null
  /** 在途渲染：同选项的并发请求共享它 */
  rendering: { key: string; promise: Promise<Buffer> } | null
}

/** 同时存在的打印任务上限（超过就淘汰最旧的）。 */
const MAX_JOBS = 8
/** 任务存活时间：预览窗口关掉后最多再留这么久。 */
const JOB_TTL_MS = 10 * 60 * 1000
/** 所有缓存 PDF 的总字节上限。 */
const MAX_PDF_BYTES_TOTAL = 128 * 1024 * 1024
/** 与 Chrome 一致的边距（英寸）。 */
const DEFAULT_MARGIN_IN = 0.4

const DEFAULT_PRINT_OPTIONS: PrintOptions = Object.freeze({
  pageSize: DEFAULT_PRINT_PAGE_SIZE,
  landscape: false,
  printBackground: true,
  margins: DEFAULT_PRINT_MARGIN_MODE,
  scale: 1
})

/** 把外部传来的选项夹成合法值 —— 选项来自渲染层，必须在这里收口一次。 */
function normalizePrintOptions(input: unknown): PrintOptions {
  const src = input !== null && typeof input === 'object'
    ? input as Record<string, unknown>
    : {}
  const pageSize: PageSize = typeof src.pageSize === 'string' && (PRINT_PAGE_SIZES as string[]).includes(src.pageSize)
    ? src.pageSize
    : DEFAULT_PRINT_OPTIONS.pageSize
  const scaleRaw = Number(src.scale)
  const scale = Number.isFinite(scaleRaw) ? Math.min(2, Math.max(0.5, scaleRaw)) : 1
  return {
    pageSize,
    landscape: src.landscape === true,
    printBackground: src.printBackground !== false,
    margins: src.margins === 'none' ? 'none' : DEFAULT_PRINT_MARGIN_MODE,
    scale
  }
}

/** 预览页与打印动作共用的 printToPDF 参数（选项 → Electron 的唯一换算点）。 */
function toPdfOptions(o: PrintOptions): PrintToPDFOptions {
  const m = o.margins === 'none' ? 0 : DEFAULT_MARGIN_IN
  return {
    printBackground: o.printBackground,
    landscape: o.landscape,
    pageSize: o.pageSize as PrintToPDFOptions['pageSize'],
    scale: o.scale,
    margins: { top: m, bottom: m, left: m, right: m },
    preferCSSPageSize: false
  }
}

/** 系统打印对话框的参数（预览页点「打印」）。 */
function toPrintOptions(o: PrintOptions): WebContentsPrintOptions {
  return {
    silent: false,
    printBackground: o.printBackground,
    landscape: o.landscape,
    pageSize: o.pageSize as WebContentsPrintOptions['pageSize'],
    scaleFactor: o.scale,
    margins: { marginType: o.margins === 'none' ? 'none' : 'default' }
  }
}

export interface PrintJobSource {
  webContents?: WebContents | null
  title?: unknown
  url?: unknown
}

export interface PrintRenderResult { job: PrintJobMeta; pdf: Buffer }
export interface PrintActionResult { ok: boolean; reason?: string }
export interface PrintSaveResult extends PrintActionResult { canceled?: boolean; filePath?: string }
export interface PrintService {
  createJob(source: PrintJobSource): PrintJobMeta
  getJob(id: string): PrintJobMeta | null
  render(id: string, optionsInput: unknown): Promise<PrintRenderResult>
  commit(id: string, optionsInput: unknown): Promise<PrintActionResult>
  savePdf(id: string, optionsInput: unknown, ownerWindow?: BrowserWindowType | null): Promise<PrintSaveResult>
  servePdf(url: URL): Promise<Response>
  closeJob(id: string): void
  dispose(): void
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function createPrintService(): PrintService {
  /** @type {Map<string, PrintJob>} */
  const jobs: Map<string, PrintJob> = new Map()
  let seq = 0
  let sweeper: ReturnType<typeof setInterval> | null = null
  let totalPdfBytes = 0

  function storePdf(job: PrintJob, pdf: Buffer): void {
    if (pdf.length > MAX_PDF_BYTES_TOTAL || totalPdfBytes - (job.pdf?.length || 0) + pdf.length > MAX_PDF_BYTES_TOTAL) {
      throw new Error('PRINT_MEMORY_BUDGET')
    }
    if (job.pdf) totalPdfBytes -= job.pdf.length
    job.pdf = pdf
    totalPdfBytes += pdf.length
  }

  // 周期性回收：预览窗口被系统 X 关掉时 renderer 未必来得及调 closeJob，
  // 不能永远攥着源 WebContents（那会让整页渲染进程无法休眠）。
  // 只在有 job 时开表；unref → 不阻止进程退出。
  function startSweeper(): void {
    if (sweeper || jobs.size === 0) return
    sweeper = setInterval(() => sweep(), 60 * 1000)
    if (typeof sweeper.unref === 'function') sweeper.unref()
  }

  function stopSweeper(): void {
    if (!sweeper) return
    clearInterval(sweeper)
    sweeper = null
  }

  function sweep() {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (now - job.createdAt <= JOB_TTL_MS) continue
      drop(id)
    }
    if (jobs.size === 0) stopSweeper()
  }

  function drop(id: string) {
    const job = jobs.get(String(id))
    if (!job) return
    jobs.delete(String(id))
    job.dropped = true
    if (job.pdf) totalPdfBytes = Math.max(0, totalPdfBytes - job.pdf.length)
    job.pdf = null
    job.pdfKey = null
    job.rendering = null
    if (job.webContents && job.targetDestroyed) {
      try { job.webContents.removeListener('destroyed', job.targetDestroyed) } catch (_) {}
    }
    job.targetDestroyed = null
    // 只放引用，不销毁：源 WebContents 归标签页管，打印服务无权销毁它。
    job.webContents = null
    if (jobs.size === 0) stopSweeper()
  }

  function evictIfNeeded() {
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value
      if (!oldest) break
      drop(oldest)
    }
  }

  /**
   * 登记一个待打印页面。
   *
   * @param {PrintJobSource} src
   * @returns {PrintJobMeta}
   */
  function createJob(src: PrintJobSource): PrintJobMeta {
    sweep()
    const id = `p${++seq}-${Date.now().toString(36)}`
    const job: PrintJob = {
      id,
      title: String(src?.title || ''),
      url: String(src?.url || ''),
      createdAt: Date.now(),
      rev: 0,
      webContents: src?.webContents || null,
      targetDestroyed: null,
      dropped: false,
      pdf: null,
      pdfKey: null,
      rendering: null
    }
    jobs.set(id, job)
    if (job.webContents && typeof job.webContents.once === 'function') {
      job.targetDestroyed = () => drop(id)
      job.webContents.once('destroyed', job.targetDestroyed)
    }
    startSweeper()
    evictIfNeeded()
    return toMeta(job)
  }

  function toMeta(job: PrintJob): PrintJobMeta {
    return { id: job.id, title: job.title, url: job.url, createdAt: job.createdAt, rev: job.rev }
  }

  /** @returns {PrintJobMeta|null} */
  function getJob(id: string): PrintJobMeta | null {
    const job = jobs.get(String(id))
    if (!job) return null
    return toMeta(job)
  }

  /**
   * 把 job 渲染成 PDF（带 rev 缓存）。
   *
   * 同一个 rev 的并发请求共享同一条 Promise —— 预览页改一次选项可能触发
   * 两次请求（选项回填 + 窗口首帧），不能让它渲染两遍。
   */
  async function render(id: string, optionsInput: unknown): Promise<PrintRenderResult> {
    const job = jobs.get(String(id))
    if (!job) throw new Error('PRINT_JOB_NOT_FOUND')
    const options = normalizePrintOptions(optionsInput)
    const wc = job.webContents
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      throw new Error('PRINT_TARGET_GONE')
    }
    const key = JSON.stringify(options)
    if (job.pdf && job.pdfKey === key) return { job: toMeta(job), pdf: job.pdf }
    if (job.rendering && job.rendering.key === key) {
      const pdf = await job.rendering.promise
      return { job: toMeta(job), pdf }
    }

    const previousRender = job.rendering?.promise.catch(() => null) || null
    const promise = (async () => {
      if (previousRender) await previousRender
      if (job.pdf && job.pdfKey === key) return job.pdf
      const data = await wc.printToPDF(toPdfOptions(options))
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (job.dropped) return buf
      storePdf(job, buf)
      job.pdfKey = key
      // rev 只作 hira://print-pdf 的缓存击穿参数：新 PDF 落地才递增。
      job.rev++
      return buf
    })()
    job.rendering = { key, promise }
    try {
      const pdf = await promise
      return { job: toMeta(job), pdf }
    } finally {
      if (job.rendering && job.rendering.promise === promise) job.rendering = null
    }
  }

  /**
   * 让 job 的**源页面**走系统打印对话框。
   *
   * 为什么不在预览页里打印那份 PDF：Electron 的 `webContents.print` 直接打在
   * 源页面上，保真度与「文件 → 打印」完全一致（分页、链接、表单都是原生的）；
   * 而把 PDF 再喂给系统打印要多绕一层、还得依赖系统打印机支持 PDF 直出。
   */
  async function commit(id: string, optionsInput: unknown): Promise<PrintActionResult> {
    const job = jobs.get(String(id))
    if (!job) return { ok: false, reason: 'PRINT_JOB_NOT_FOUND' }
    const wc = job.webContents
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { ok: false, reason: 'PRINT_TARGET_GONE' }
    }
    const options = normalizePrintOptions(optionsInput)
    return await new Promise((resolve) => {
      try {
        wc.print(toPrintOptions(options), (success: boolean, failureReason?: string) => {
          resolve({ ok: !!success, reason: success ? undefined : (failureReason || 'PRINT_FAILED') })
        })
      } catch (error) {
        resolve({ ok: false, reason: errorMessage(error, 'PRINT_FAILED') })
      }
    })
  }

  /**
   * 渲染并另存为 PDF。保存对话框的父窗口由调用方给（预览窗口自己）。
   *
   * @returns {Promise<{ok:boolean, canceled?:boolean, filePath?:string, reason?:string}>}
   */
  async function savePdf(id: string, optionsInput: unknown, ownerWindow?: BrowserWindowType | null): Promise<PrintSaveResult> {
    const meta = getJob(id)
    if (!meta) return { ok: false, reason: 'PRINT_JOB_NOT_FOUND' }
    let pdf: Buffer
    try {
      pdf = (await render(id, optionsInput)).pdf
    } catch (error) {
      return { ok: false, reason: errorMessage(error, 'PRINT_RENDER_FAILED') }
    }
    const safeTitle = String(meta.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'page'
    const parent = ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : null
    const res = await dialog.showSaveDialog(parent, {
      title: '另存为 PDF',
      defaultPath: `${safeTitle}.pdf`,
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      await fs.writeFile(res.filePath, pdf)
      return { ok: true, filePath: res.filePath }
    } catch (error) {
      return { ok: false, reason: errorMessage(error, 'PRINT_SAVE_FAILED') }
    }
  }

  /**
   * hira://print-pdf/<jobId> 的解析器 —— 直接吐当前缓存的 PDF。
   *
   * `rev` 只是缓存击穿参数（预览页换选项后 URL 带新 rev），服务端始终取最新缓存；
   * 取不到就当场渲染一次默认选项，保证窗口重载后仍能显示。
   */
  async function servePdf(url: URL): Promise<Response> {
    const id = String(url.pathname ? url.pathname.slice(1) : '').replace(/[^a-zA-Z0-9-]/g, '')
    if (!id) return new Response('Bad request', { status: 400 })
    const job = jobs.get(id)
    if (!job) return new Response('Not Found', { status: 404 })
    try {
      const pdf = job.pdf || (await render(id, DEFAULT_PRINT_OPTIONS)).pdf
      return new Response(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      })
    } catch (error) {
      return new Response(`Render failed: ${errorMessage(error, 'unknown error')}`, { status: 500 })
    }
  }

  /** 预览窗口关闭时调用：立刻释放源 WebContents 引用（缓存 PDF 也一并丢掉）。 */
  function closeJob(id: string) {
    drop(id)
  }

  function dispose() {
    stopSweeper()
    for (const id of Array.from(jobs.keys())) drop(id)
  }

  return { createJob, getJob, render, commit, savePdf, servePdf, closeJob, dispose }
}

/** 兼容 CJS require（本文件被 esbuild 转成 CJS 后被 main.js require）。 */
module.exports = { createPrintService, normalizePrintOptions, DEFAULT_PRINT_OPTIONS }
