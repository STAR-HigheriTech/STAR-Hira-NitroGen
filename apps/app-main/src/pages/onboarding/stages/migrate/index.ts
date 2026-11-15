/**
 * 阶段 · 导入 / 迁移
 *
 * 两条来源流程复用同一实现，顺序只由 stages/index.ts 的 ORDER 决定。
 * 所有文件选择、浏览器导入、结果回填均绑定本次 mount；继续动作会等待
 * 在途任务完成，避免完成页提前丢掉刚导入的结果摘要。
 */

import {
  createBrowserImportCard,
  type BrowserImportCard,
  type BrowserImportResult,
  type BrowserSource
} from 'hira://shared/browser-import.js'
import { errorMessage } from 'hira://shared/page-kit.js'
import { MIGRATION_SOURCES } from './sources.js'
import type {
  MigrationResult,
  OnboardingContext,
  OnboardingStage,
  OnboardingStageView
} from '../types.js'

interface FileJob {
  source: (typeof MIGRATION_SOURCES)[number]
  item: HTMLElement
}

interface MigrateView extends OnboardingStageView {
  disposed: boolean
  input: HTMLInputElement | null
  card: BrowserImportCard | null
  pending: FileJob | null
  fileWork: Promise<void> | null
  browserGate: ReturnType<typeof createGate>
}

const migrate: OnboardingStage = {
  id: 'migrate',
  label: '导入',
  nextLabel: '继续',
  hint: '可以逐个导入，也可以直接跳过',

  mount (ctx: OnboardingContext) {
    const fromMin = ctx.draft.source === ctx.sources.MIN
    const root = ctx.el('section')
    root.appendChild(ctx.el('h1', 'oobe-title', fromMin ? '把 Hira Min 的数据搬过来' : '导入旧浏览器的数据'))
    root.appendChild(ctx.el('p', 'oobe-sub', '可直接读取 Chrome / Edge，也可以用导出的书签 HTML 或密码 CSV。'))

    ctx.draft.migration = ctx.draft.migration || {}
    const input = ctx.el('input') as HTMLInputElement
    input.type = 'file'
    input.hidden = true
    input.style.display = 'none'
    root.appendChild(input)

    const view: MigrateView = {
      el: root,
      disposed: false,
      input,
      card: null,
      pending: null,
      fileWork: null,
      browserGate: createGate(),
      destroy () {
        this.disposed = true
        this.pending = null
        this.card?.destroy()
        this.card = null
        this.input = null
      },
      async beforeNext () {
        await Promise.all([
          this.fileWork || Promise.resolve(),
          this.browserGate.wait()
        ])
      }
    }

    view.card = createBrowserImportCard({
      title: fromMin ? '也可以从 Chrome / Edge 一键导入' : '从 Chrome / Edge 一键导入',
      subtitle: '直接读取本机浏览器的书签、历史记录与扩展，不用先导出文件。',
      onDone: (result, source) => recordBrowserResult(ctx, result, source),
      onBusyChange: (busy) => {
        if (busy) view.browserGate.acquire()
        else view.browserGate.release()
      }
    })
    root.appendChild(view.card.el)

    const list = ctx.el('div', 'oobe-migrate')
    for (const source of MIGRATION_SOURCES) list.appendChild(buildItem(ctx, view, source))
    root.appendChild(list)

    input.addEventListener('change', (event) => void onChange(ctx, view, event))
    return view
  }
}

function buildItem (
  ctx: OnboardingContext,
  view: MigrateView,
  source: (typeof MIGRATION_SOURCES)[number]
): HTMLElement {
  const item = ctx.el('div', 'oobe-surface oobe-migrate-item')
  item.dataset.id = source.id

  const head = ctx.el('div', 'oobe-migrate-head')
  head.append(
    ctx.el('span', 'oobe-migrate-name', source.label),
    ctx.el('span', 'badge', '待导入')
  )

  const foot = ctx.el('div', 'oobe-migrate-foot')
  const status = ctx.el('span', 'oobe-migrate-status', source.pickHint)
  status.setAttribute('role', 'status')
  const button = ctx.el('button', 'btn btn-sm', '选择文件…') as HTMLButtonElement
  button.type = 'button'
  button.addEventListener('click', () => pick(view, source, item))
  foot.append(status, button)
  item.append(head, foot)

  paint(ctx.draft.migration[source.id], item, source.pickHint)
  return item
}

function paint (result: MigrationResult | undefined, item: HTMLElement, idleText: string): void {
  const badge = item.querySelector<HTMLElement>('.badge')
  const status = item.querySelector<HTMLElement>('.oobe-migrate-status')
  const button = item.querySelector<HTMLButtonElement>('.btn')
  if (!badge || !status) return

  const base = 'oobe-migrate-status'
  if (!result) {
    badge.textContent = '待导入'
    badge.classList.remove('badge-success', 'badge-danger')
    status.className = base
    status.textContent = idleText
    status.removeAttribute('title')
    if (button) button.textContent = '选择文件…'
    return
  }

  badge.classList.toggle('badge-success', Boolean(result.ok))
  badge.classList.toggle('badge-danger', !result.ok && !result.cancelled)
  badge.textContent = result.ok ? '已导入' : (result.cancelled ? '未导入' : '失败')
  status.className = result.ok ? `${base} is-ok` : (result.cancelled ? base : `${base} is-bad`)
  status.textContent = result.message
  if (result.file) status.title = result.file
  else status.removeAttribute('title')
  if (button) button.textContent = '重新选择…'
}

function pick (
  view: MigrateView,
  source: (typeof MIGRATION_SOURCES)[number],
  item: HTMLElement
): void {
  if (!view.input || view.disposed) return
  view.pending = { source, item }
  view.input.accept = source.accepts
  view.input.value = ''
  view.input.click()
}

async function onChange (ctx: OnboardingContext, view: MigrateView, event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  const job = view.pending
  view.pending = null
  const file = input?.files && input.files[0] ? input.files[0] : null
  if (input) input.value = ''
  if (!job || !file) return

  const work = importFile(ctx, view, job, file)
  view.fileWork = work
  try {
    await work
  } finally {
    if (view.fileWork === work) view.fileWork = null
  }
}

async function importFile (
  ctx: OnboardingContext,
  view: MigrateView,
  job: FileJob,
  file: File
): Promise<void> {
  const button = job.item.querySelector<HTMLButtonElement>('.btn')
  const status = job.item.querySelector<HTMLElement>('.oobe-migrate-status')
  if (button) {
    button.disabled = true
    button.textContent = '导入中…'
  }
  if (status) {
    status.className = 'oobe-migrate-status'
    status.textContent = `正在读取 ${file.name}…`
  }

  let result: MigrationResult
  try {
    const text = String(await readText(file))
    result = text.trim()
      ? await job.source.run(ctx, text)
      : { ok: false, message: '文件内容为空，没有可导入的数据。' }
  } catch (error) {
    result = { ok: false, message: `导入失败：${errorMessage(error)}` }
  }
  result.file = file.name
  ctx.draft.migration[job.source.id] = result
  if (view.disposed) return

  if (button) button.disabled = false
  paint(result, job.item, job.source.pickHint)
}

function readText (file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'))
    reader.readAsText(file)
  })
}

function recordBrowserResult (
  ctx: OnboardingContext,
  result: BrowserImportResult | undefined,
  source: BrowserSource | undefined
): void {
  if (!source || !source.id) return
  const previous = ctx.draft.migration['browser-import']
  const sources = { ...(previous?.sources || {}) }
  sources[source.id] = summarizeBrowserResult(result, source)
  const values = Object.values(sources)
  const count = values.reduce((sum, entry) => sum + (entry.count || 0), 0)
  const failures = values.filter((entry) => !entry.ok)
  const labels = values.map((entry) => entry.file).filter(Boolean).join('、')
  const ok = failures.length === 0
  const message = failures.length
    ? `${failures[0].message}${count > 0 ? `；本次共写入 ${count} 项` : ''}`
    : count > 0
      ? `已从 ${labels || '浏览器'} 导入 ${count} 项。`
      : '没有新增数据，已自动跳过重复条目。'

  ctx.draft.migration['browser-import'] = {
    ok,
    count,
    message,
    file: labels,
    sources
  }
}

function summarizeBrowserResult (
  result: BrowserImportResult | undefined,
  source: BrowserSource
): MigrationResult {
  const counters = [result?.bookmarks, result?.history, result?.extensions]
  const count = counters.reduce((sum, entry) => sum + Number(entry?.imported || 0), 0)
  const errors = Array.isArray(result?.errors) ? result.errors : []
  const failed = Boolean(result?.error) || errors.length > 0 || result?.ok === false
  const message = result?.error
    ? `导入失败：${result.error}`
    : errors.length
      ? String(errors[0])
      : count > 0
        ? `已导入 ${count} 项`
        : '没有新增数据'
  return {
    ok: !failed,
    count,
    message,
    file: source.label || source.id
  }
}

function createGate () {
  let count = 0
  let waiters: Array<() => void> = []
  return {
    acquire () {
      count += 1
    },
    release () {
      count = Math.max(0, count - 1)
      if (count > 0) return
      const pending = waiters
      waiters = []
      for (const resolve of pending) resolve()
    },
    wait (): Promise<void> {
      if (count === 0) return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
    }
  }
}

export default migrate
