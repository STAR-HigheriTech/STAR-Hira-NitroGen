/**
 * 崩溃报告页。
 *
 * 数据全部来自主进程（Electron crashReporter）——渲染层无从获取。
 * 本项目 **不做崩溃上报**（没有服务端也没有上报依赖），所以：
 *   · 若宿主编译时未能启用 crashReporter，页面直说「未启用」，而不是显示空列表
 *     让用户误以为「从没崩溃过」；
 *   · 列表里的每一条都是本地留存的真实记录，不补任何占位字段。
 */
import { IPC_ROUTES, rpc, el, fmtTime, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, isRecord, requiredById, stringValue } from 'hira://shared/page-kit.js'

initTheme()

interface CrashReport {
  date?: number | string
  type?: string
  id?: string
}

interface CrashListResponse {
  enabled?: unknown
  reports?: unknown
}

const statusEl = requiredById<HTMLElement>('status')
const noticeEl = requiredById<HTMLElement>('notice')
const listEl = requiredById<HTMLElement>('list')
const refreshButton = requiredById<HTMLButtonElement>('refresh')

function setNotice (text?: string): void {
  if (!text) {
    noticeEl.hidden = true
    noticeEl.textContent = ''
    return
  }
  noticeEl.hidden = false
  noticeEl.textContent = text
}

async function refresh (): Promise<void> {
  statusEl.textContent = '读取中…'
  let data: CrashListResponse
  try {
    data = await rpc<CrashListResponse>(IPC_ROUTES.crashList, {})
  } catch (e) {
    statusEl.textContent = '读取失败'
    setNotice(`无法读取崩溃记录：${errorMessage(e)}`)
    listEl.replaceChildren()
    return
  }

  const reports = Array.isArray(data?.reports) ? data.reports.filter(isRecord) as CrashReport[] : []
  const enabled = Boolean(data?.enabled)

  statusEl.textContent = `崩溃收集：${enabled ? '已启用（仅本地留存）' : '未启用'} · 记录 ${reports.length} 条`

  if (!enabled) {
    setNotice(
      '崩溃收集在本机未能启用，因此这里不会出现任何记录 —— 这不代表浏览器从未崩溃过。' +
      '本项目没有崩溃上报服务端，即使启用也只在本机留存，不会上传。'
    )
  } else {
    setNotice(
      '这些记录仅保存在本机，不会上传到任何服务器。' +
      'Electron 的崩溃记录只提供时间与标识，不包含进程类型与堆栈，因此列表里也只有这两项。'
    )
  }

  listEl.replaceChildren()
  if (reports.length === 0) {
    const empty = el('div', 'empty', enabled ? '本机没有崩溃记录' : '（崩溃收集未启用，无记录可读）')
    listEl.appendChild(empty)
    return
  }

  for (const report of reports) {
    const row = el('div', 'row')
    const main = el('div', 'row-main')
    main.appendChild(el('div', 'row-title', report.date ? fmtTime(report.date) : '时间未知'))
    main.appendChild(el('div', 'row-sub', `进程类型：${stringValue(report.type, '未知（Electron 未提供）')} · 标识：${stringValue(report.id, '无')}`))
    row.appendChild(main)
    listEl.appendChild(row)
  }
}

refreshButton.addEventListener('click', refresh)
refresh()
