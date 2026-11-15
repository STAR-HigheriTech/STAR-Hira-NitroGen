// @ts-check
/**
 * ui-download-bar — 底部下载管理条（完整版）
 *
 * 对齐 Hira downloadbar + downloadsPanel：
 *   - 底部下载进度条 + 展开/收起下载列表
 *   - 每个下载项：文件图标 + 名称 + 状态 + 暂停/恢复/取消/打开/文件夹按钮
 *   - 详情栏：名称 + 系统图标 + 百分比 + 速度 + ETA + 大小 + 线程数
 *   - 速度曲线图（Canvas 实时绘制，对齐 Hira _drawSpeedGraph）
 *   - 下载限速控制（UI 显示当前限速，可调整）
 *
 * 兼容旧 API：{ onOpen, onRemove } + refreshList(list)
 * 新增可选：{ invoke, subscribe } 用于直接 IPC 调用
 */

// 体积文本走共享真源（下载域口径：0→'0 B'、GB 两位小数），不再本地另写一份。
import { formatDownloadSize } from '@hira-ng/shared-types/src/format-size.mjs'
// 文件图标：与下载面板 / 内部下载页同一套取数器（缓存 + 并发合并 + 失败 TTL）。
import { createFileIcon, createFileIconLoader } from '@hira-ng/shared-types/src/file-icon.mjs'
// 「快照 + 实时进度」的合并口径只有一份（与下载面板共用）。
import {
  resolveDownloadView,
  isLiveDownloadState,
  downloadStateText
} from '@hira-ng/shared-types/src/download-view.mjs'
import type { DownloadView } from '@hira-ng/shared-types/src/download-view.mjs'

const MAX_SPEED_SAMPLES = 120 // 速度曲线图采样点（约 60s @ 500ms）

/**
 * 「进行中但还不知道百分比」时写的字（不另造文案：取下载状态文案真源）。
 * 三处提示（行内 / 详情 / 悬浮条）共用这一个值，避免一处改成「正在下载」另一处没跟上。
 */
const ACTIVE_DOWNLOAD_TEXT = downloadStateText('in_progress')

export type DownloadId = string | number

export interface DownloadItem {
  id: DownloadId
  filename?: string
  url?: string
  filePath?: string
  state?: string
  danger?: string
  multiThreaded?: boolean
  connections?: number
  [key: string]: unknown
}

export type DownloadInvoke = (route: string, payload?: unknown) => Promise<unknown>
export type DownloadSubscribe = (channel: string, listener: (payload: unknown) => void) => unknown

export interface DownloadBarOptions {
  doc?: Document
  invoke?: DownloadInvoke
  subscribe?: DownloadSubscribe
  onOpen?: (filePath: string) => void
  onRemove?: (id: DownloadId) => void
}

export interface DownloadBarController {
  readonly element: HTMLElement
  refreshList(items?: DownloadItem[]): void
  updateBar(): void
  drawSpeedGraph(): void
}

interface DownloadRowRefs {
  item: DownloadItem
  state: HTMLElement
  lastText?: string
  lastCls?: string
  lastTip?: string
}

const DOWNLOAD_BAR_STYLE = `
.download-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 0;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--downloadbar-bg, #f5f5f5);
  border-top: 1px solid var(--border-color, rgba(0,0,0,0.08));
  transition: height 0.2s ease;
  font-size: 12px;
}
.download-bar.visible { height: 36px; }
.download-bar__icon { width: 16px; height: 16px; flex-shrink: 0; }
.download-bar__text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-color, var(--hira-text-primary, #1a1a1a));
}
.download-bar__progress {
  width: 100px;
  height: 4px;
  background: var(--progress-bg, rgba(0,0,0,0.1));
  border-radius: 2px;
  overflow: hidden;
}
.download-bar__progress-fill {
  height: 100%;
  background: var(--hira-accent, #3b82f6);
  transition: width 0.3s ease;
}
.download-bar__percent {
  min-width: 40px;
  text-align: right;
  color: var(--hira-text-secondary, #6b7280);
}
.download-bar__btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--hira-radius-2xs, 4px);
  font-size: 12px;
  color: var(--hira-text-secondary, #6b7280);
  transition: background 0.1s;
}
.download-bar__btn:hover { background: var(--button-hover-bg, rgba(0,0,0,0.06)); }
.download-bar__btn--toggle { font-size: 14px; }
.download-bar__rate {
  font-size: 11px;
  color: var(--hira-text-tertiary, #9ca3af);
  padding: 2px 6px;
  border: 1px solid var(--border-color, rgba(0,0,0,0.1));
  border-radius: var(--hira-radius-2xs, 4px);
  cursor: pointer;
}
.download-list {
  max-height: 0;
  overflow-y: auto;
  background: var(--panel-bg, #fff);
  border-top: 1px solid var(--border-color, rgba(0,0,0,0.08));
  transition: max-height 0.2s ease;
}
.download-list.expanded { max-height: 60vh; }
.download-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  gap: 8px;
  font-size: 12px;
}
.download-item:hover { background: var(--list-hover-bg, rgba(0,0,0,0.04)); }
.download-item__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  object-fit: contain;
}
.download-item__name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.download-item__state { color: var(--hira-text-secondary, #6b7280); }
.download-item__state--done { color: var(--hira-success, #4caf50); }
.download-item__state--error { color: var(--hira-danger, #e53935); }
.download-item__btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--hira-text-tertiary, #9ca3af);
  opacity: 0;
  transition: opacity 0.1s;
}
.download-item:hover .download-item__btn { opacity: 1; }
.download-item__btn:hover { color: var(--hira-danger, #e53935); }

/* 详情栏 */
.download-detail {
  border-top: 1px solid var(--border-color, rgba(0,0,0,0.08));
  padding: 12px;
  display: none;
  background: var(--panel-bg, #fff);
}
.download-detail.visible { display: flex; gap: 12px; align-items: stretch; }
.download-detail__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.download-detail__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.download-detail__icon { width: 24px; height: 24px; object-fit: contain; }
.download-detail__name {
  flex: 1;
  font-weight: 500;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.download-detail__pct {
  font-size: 18px;
  font-weight: 600;
  color: var(--hira-accent, #3b82f6);
}
.download-detail__progress {
  height: 6px;
  background: var(--progress-bg, rgba(0,0,0,0.1));
  border-radius: 3px;
  overflow: hidden;
}
.download-detail__progress-bar {
  height: 100%;
  background: var(--hira-accent, #3b82f6);
  transition: width 0.3s ease;
}
.download-detail__metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.download-detail__metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.download-detail__metric-label {
  font-size: 10px;
  color: var(--hira-text-tertiary, #9ca3af);
  text-transform: uppercase;
}
.download-detail__metric-value {
  font-size: 13px;
  color: var(--text-color, var(--hira-text-primary, #1a1a1a));
  font-variant-numeric: tabular-nums;
}
.download-detail__graph {
  width: 220px;
  height: 90px;
  background: var(--surface-muted, #f5f5f5);
  border-radius: var(--hira-radius-2xs, 4px);
  flex-shrink: 0;
}
`

export function injectDownloadBarStyles(doc: Document): void {
  // 幂等：避免重复注入
  if (doc.getElementById('hira-download-bar-styles')) return
  const style = doc.createElement('style')
  style.id = 'hira-download-bar-styles'
  style.textContent = DOWNLOAD_BAR_STYLE
  doc.head.appendChild(style)
}

// 速度格式化（字节/秒 → KB/s / MB/s）
function formatSpeed(bytesPerSec: number) {
  if (!bytesPerSec || bytesPerSec <= 0) return '—'
  if (bytesPerSec < 1024) return bytesPerSec + ' B/s'
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s'
  if (bytesPerSec < 1024 * 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s'
  return (bytesPerSec / (1024 * 1024 * 1024)).toFixed(2) + ' GB/s'
}
function formatETA(seconds: number) {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return Math.ceil(seconds) + ' 秒'
  if (seconds < 3600) return Math.ceil(seconds / 60) + ' 分'
  return Math.floor(seconds / 3600) + ' 时 ' + Math.ceil((seconds % 3600) / 60) + ' 分'
}
/** 体积文本（下载域口径真源的本地别名：非法输入显示占位符 '—'）。 */
function formatSize(bytes: number) {
  return formatDownloadSize(bytes, '—') || '—'
}

/** 创建下载管理条；IPC 与旧回调模式都通过端口适配。 */
export function createDownloadBar(options: DownloadBarOptions = {}): DownloadBarController {
  const doc = options.doc || document
  // 兼容两种模式：新 IPC 模式 / 旧回调模式
  const invoke = typeof options.invoke === 'function'
    ? options.invoke
    : (async (route: string, payload?: unknown) => {
        // 旧 API 模式下没有 invoke，用 onOpen / onRemove 兜底
        const data = payload as { filePath?: string; id?: DownloadId } | undefined
        if (route === 'download:open' && options.onOpen && data?.filePath) options.onOpen(data.filePath)
        if (route === 'download:remove' && options.onRemove && data?.id != null) options.onRemove(data.id)
        return null
      })
  const subscribe = typeof options.subscribe === 'function'
    ? options.subscribe
    : () => {} // 旧模式无订阅，依靠 refreshList 主动拉取

  const container = doc.createElement('div')

  const bar = doc.createElement('div')
  bar.className = 'download-bar'
  container.appendChild(bar)

  const icon = doc.createElement('span')
  icon.className = 'download-bar__icon'
  icon.textContent = '⬇'
  bar.appendChild(icon)

  const text = doc.createElement('span')
  text.className = 'download-bar__text'
  text.textContent = ''
  bar.appendChild(text)

  const progress = doc.createElement('div')
  progress.className = 'download-bar__progress'
  const progressFill = doc.createElement('div')
  progressFill.className = 'download-bar__progress-fill'
  progressFill.style.width = '0%'
  progress.appendChild(progressFill)
  bar.appendChild(progress)

  const percent = doc.createElement('span')
  percent.className = 'download-bar__percent'
  percent.textContent = ''
  bar.appendChild(percent)

  const rateBtn = doc.createElement('button')
  rateBtn.className = 'download-bar__rate'
  rateBtn.textContent = '不限速'
  rateBtn.title = '点击设置下载限速'
  rateBtn.style.display = (typeof options.invoke === 'function') ? '' : 'none' // 旧 API 无 IPC 时隐藏
  bar.appendChild(rateBtn)

  const toggleBtn = doc.createElement('button')
  toggleBtn.className = 'download-bar__btn download-bar__btn--toggle'
  toggleBtn.textContent = '▲'
  toggleBtn.title = '展开/收起'
  bar.appendChild(toggleBtn)

  const clearBtn = doc.createElement('button')
  clearBtn.className = 'download-bar__btn'
  clearBtn.textContent = '清除已完成'
  clearBtn.title = '清除已完成的下载'
  bar.appendChild(clearBtn)

  const list = doc.createElement('div')
  list.className = 'download-list'
  container.appendChild(list)

  // 详情栏
  const detail = doc.createElement('div')
  detail.className = 'download-detail'
  container.appendChild(detail)

  let expanded = false
  const activeDownloads = new Map<string, DownloadItem>()
  let lastList: DownloadItem[] = []
  let selectedId: string | null = null
  let speedSamples: Array<{ t: number; s: number }> = []

  // 真实文件图标取数器：失败结果按 TTL 过期（下载中的目标文件尚未落盘，
  // 永久缓存会让"下载完成那一刻"仍命中空缓存、画不出图标）。
  // 旧回调模式没有 IPC，直接给 null —— 行首保留类型 emoji。
  const loadFileIcon = createFileIconLoader((filePath, size) => {
    if (typeof options.invoke !== 'function') return Promise.resolve(null)
    return invoke('download:get-file-icon', { filePath, size }).then((result) => {
      if (!result || typeof result !== 'object') return null
      const dataUrl = (result as { dataUrl?: unknown }).dataUrl
      return typeof dataUrl === 'string' ? dataUrl : null
    })
  })

  /** 行内待改节点（id → refs）：进度事件原地刷新，不重建整个列表 */
  const rowRefs = new Map<string, DownloadRowRefs>()

  function toggleExpand() {
    expanded = !expanded
    list.classList.toggle('expanded', expanded)
    toggleBtn.textContent = expanded ? '▼' : '▲'
    updateDetailVisibility()
  }

  /** 刷新下载列表（兼容旧 API 的入口）。 */
  function refreshList(items?: DownloadItem[]) {
    if (Array.isArray(items)) {
      lastList = items
      // 快照是"已落库的事实"：新条目补进来；快照已到终态就覆盖实时缓存，
      // 否则丢失的 done 事件会让顶栏一直停在"下载中"。已消失的条目一并清掉。
      const seen = new Set<string>()
      for (const it of items) {
        const key = String(it.id)
        seen.add(key)
        const live = activeDownloads.get(key)
        if (!live || !isLiveDownloadState(it.state)) activeDownloads.set(key, it)
      }
      for (const key of Array.from(activeDownloads.keys())) {
        if (!seen.has(key)) activeDownloads.delete(key)
      }
    }
    renderList(lastList)
    updateBar()
  }

  /** 行的有效可视量：快照 + 实时进度（合并规则见 shared-types/download-view）。 */
  function viewOf(item: DownloadItem) {
    return resolveDownloadView(item, activeDownloads.get(String(item.id)))
  }

  /** 只改状态文字/色调，不重建行 —— 200ms 级的进度事件不能带起列表重排。 */
  function applyRowView(refs: DownloadRowRefs, view: DownloadView) {
    const text = view.active
      ? (view.pct != null ? `${view.pct}%` : ACTIVE_DOWNLOAD_TEXT)
      : downloadStateText(view.state)
    if (refs.lastText !== text) {
      refs.state.textContent = text
      refs.lastText = text
    }
    const tone = view.state === 'completed' ? 'done'
      : (view.state === 'cancelled' || view.state === 'interrupted' || view.state === 'failed') ? 'error'
      : ''
    const cls = 'download-item__state' + (tone ? ` download-item__state--${tone}` : '')
    if (refs.lastCls !== cls) {
      refs.state.className = cls
      refs.lastCls = cls
    }
    // 速度 / ETA 进 tooltip：行内空间只够一个百分比，但数值不丢
    const tip = view.speed > 0 ? `${formatSpeed(view.speed)} · ${formatETA(view.eta)}` : ''
    if (refs.lastTip !== tip) {
      refs.state.title = tip
      refs.lastTip = tip
    }
  }

  // 内部渲染
  function renderList(items: DownloadItem[]) {
    list.textContent = ''
    rowRefs.clear()
    if (!items || items.length === 0) {
      const empty = doc.createElement('div')
      empty.style.cssText = 'padding: 12px; text-align: center; color: var(--hira-text-tertiary, #999);'
      empty.textContent = '暂无下载'
      list.appendChild(empty)
      return
    }
    for (const item of items) {
      const key = String(item.id)
      const view = viewOf(item)
      const row = doc.createElement('div')
      row.className = 'download-item'

      // 文件图标：真实图标可用时原位换成 <img>，否则保留类型 emoji（绝不空着）
      row.appendChild(createFileIcon(doc, {
        filename: item.filename,
        url: item.url,
        filePath: item.filePath
      }, { size: 16, className: 'download-item__icon', fontSize: 14, loadIcon: loadFileIcon }))

      const name = doc.createElement('span')
      name.className = 'download-item__name'
      name.textContent = item.filename || item.url || ''
      row.appendChild(name)

      const state = doc.createElement('span')
      row.appendChild(state)
      const refs: DownloadRowRefs = { item, state }
      rowRefs.set(key, refs)
      applyRowView(refs, view)

      // 危险文件标记
      if (item.danger && item.danger !== 'safe') {
        const danger = doc.createElement('span')
        danger.className = 'download-item__state'
        danger.style.color = 'var(--hira-danger, #e53935)'
        danger.textContent = '⚠'
        danger.title = '此文件类型可能不安全'
        row.appendChild(danger)
      }

      // 暂停/恢复按钮（状态取合并后的 view：暂停事件可能先于列表快照到达）
      if (view.active) {
        const pauseBtn = doc.createElement('button')
        pauseBtn.className = 'download-item__btn'
        pauseBtn.textContent = '❚❚'
        pauseBtn.title = '暂停'
        pauseBtn.addEventListener('click', async (e) => {
          e.stopPropagation()
          try { await invoke('download:pause', { id: item.id }) } catch (_) {}
        })
        row.appendChild(pauseBtn)
      } else if (view.state === 'paused') {
        const resumeBtn = doc.createElement('button')
        resumeBtn.className = 'download-item__btn'
        resumeBtn.textContent = '▶'
        resumeBtn.title = '恢复'
        resumeBtn.style.color = 'var(--hira-accent, #3b82f6)'
        resumeBtn.addEventListener('click', async (e) => {
          e.stopPropagation()
          try { await invoke('download:resume', { id: item.id }) } catch (_) {}
        })
        row.appendChild(resumeBtn)
      }

      // 取消按钮
      if (view.active || view.state === 'paused') {
        const cancelBtn = doc.createElement('button')
        cancelBtn.className = 'download-item__btn'
        cancelBtn.textContent = '✕'
        cancelBtn.title = '取消'
        cancelBtn.addEventListener('click', async (e) => {
          e.stopPropagation()
          try { await invoke('download:cancel', { id: item.id }) } catch (_) {}
        })
        row.appendChild(cancelBtn)
      }

      // 完成项：打开/文件夹
      if (view.state === 'completed') {
        const openBtn = doc.createElement('button')
        openBtn.className = 'download-item__btn'
        openBtn.textContent = '打开'
        openBtn.style.color = 'var(--hira-accent, #3b82f6)'
        openBtn.addEventListener('click', async (e) => {
          e.stopPropagation()
          try { await invoke('download:open', { id: item.id }) } catch (_) {}
          // 兼容旧 onOpen 回调
          if (options.onOpen && item.filePath) options.onOpen(item.filePath)
        })
        row.appendChild(openBtn)

        const folderBtn = doc.createElement('button')
        folderBtn.className = 'download-item__btn'
        folderBtn.textContent = '文件夹'
        folderBtn.title = '在文件夹中显示'
        folderBtn.addEventListener('click', async (e) => {
          e.stopPropagation()
          try { await invoke('download:show-in-folder', { id: item.id }) } catch (_) {}
        })
        row.appendChild(folderBtn)
      }

      const delBtn = doc.createElement('button')
      delBtn.className = 'download-item__btn'
      delBtn.textContent = '×'
      delBtn.title = '删除'
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        try { await invoke('download:remove', { id: item.id }) } catch (_) {}
        if (options.onRemove) options.onRemove(item.id)
      })
      row.appendChild(delBtn)

      // 点击行选中并显示详情栏
      row.addEventListener('click', () => {
        selectedId = key
        speedSamples = []
        updateDetail(item)
      })

      list.appendChild(row)
    }
  }

  // ── 详情栏 ──
  const detailHead = doc.createElement('div')
  detailHead.className = 'download-detail__head'
  const detailIcon = doc.createElement('img')
  detailIcon.className = 'download-detail__icon'
  detailIcon.alt = ''
  detailIcon.style.display = 'none'
  const detailName = doc.createElement('div')
  detailName.className = 'download-detail__name'
  const detailPct = doc.createElement('div')
  detailPct.className = 'download-detail__pct'
  detailPct.textContent = '0%'
  detailHead.appendChild(detailIcon)
  detailHead.appendChild(detailName)
  detailHead.appendChild(detailPct)

  const detailProgress = doc.createElement('div')
  detailProgress.className = 'download-detail__progress'
  const detailProgressBar = doc.createElement('div')
  detailProgressBar.className = 'download-detail__progress-bar'
  detailProgressBar.style.width = '0%'
  detailProgress.appendChild(detailProgressBar)

  const detailMetrics = doc.createElement('div')
  detailMetrics.className = 'download-detail__metrics'
  const metricLabels: Record<string, string> = { speed: '速度', eta: '剩余', size: '大小', conn: '线程' }
  const metrics = ['speed', 'eta', 'size', 'conn'].map((k) => {
    const m = doc.createElement('div')
    m.className = 'download-detail__metric'
    const label = doc.createElement('div')
    label.className = 'download-detail__metric-label'
    label.textContent = metricLabels[k] || ''
    const value = doc.createElement('div')
    value.className = 'download-detail__metric-value'
    value.textContent = '—'
    m.appendChild(label)
    m.appendChild(value)
    detailMetrics.appendChild(m)
    return value
  })
  const [metricSpeed, metricETA, metricSize, metricConn] = metrics

  const detailGraph = doc.createElement('canvas')
  detailGraph.className = 'download-detail__graph'
  detailGraph.width = 220
  detailGraph.height = 90

  const detailMain = doc.createElement('div')
  detailMain.className = 'download-detail__main'
  detailMain.appendChild(detailHead)
  detailMain.appendChild(detailProgress)
  detailMain.appendChild(detailMetrics)

  detail.appendChild(detailMain)
  detail.appendChild(detailGraph)

  /** 详情栏当前展示的 filePath（迟到的图标结果不能画到别的条目上） */
  let detailIconKey = ''

  function updateDetail(item: DownloadItem | null | undefined) {
    if (!item) {
      detail.classList.remove('visible')
      return
    }
    detail.classList.add('visible')
    const view = viewOf(item)
    detailName.textContent = item.filename || item.url || ''
    // 总量未知时不写假的 0%：活动项写"下载中"，其余写占位符
    detailPct.textContent = view.pct != null ? `${view.pct}%` : (view.active ? ACTIVE_DOWNLOAD_TEXT : '—')
    detailProgressBar.style.width = view.pct != null ? `${Math.max(2, view.pct)}%` : '0%'
    metricSize.textContent = view.total > 0
      ? `${formatSize(view.received)} / ${formatSize(view.total)}`
      : `已接收 ${formatSize(view.received)}`
    metricConn.textContent = item.multiThreaded ? `${item.connections || 8} 线程` : '单线程'
    metricSpeed.textContent = view.speed > 0 ? formatSpeed(view.speed) : '—'
    metricETA.textContent = view.eta > 0 ? formatETA(view.eta) : '—'

    const iconKey = item.filePath ? String(item.filePath) : ''
    detailIconKey = iconKey
    if (!iconKey) {
      detailIcon.style.display = 'none'
      return
    }
    loadFileIcon(iconKey, 16).then((dataUrl: string | null) => {
      if (detailIconKey !== iconKey) return
      if (dataUrl) {
        detailIcon.src = dataUrl
        detailIcon.style.display = ''
      } else {
        detailIcon.style.display = 'none'
      }
    }).catch(() => {
      if (detailIconKey === iconKey) detailIcon.style.display = 'none'
    })
  }

  function updateDetailVisibility() {
    if (!expanded || !selectedId) {
      detail.classList.remove('visible')
      return
    }
    // 以列表快照为主（文件名/线程数等静态字段只在快照里），实时量由 viewOf 合并
    const snapshot = lastList.find(i => String(i.id) === selectedId)
    const live = snapshot || activeDownloads.get(selectedId)
    if (live) updateDetail(live)
  }

  // ── 速度曲线图绘制 ──
  /**
   * canvas 不认 CSS 变量：每帧把当前令牌取成**真值**再喂给 2D 上下文，
   * 这样主题一换，下一帧曲线颜色就跟着换（不需要重建任何东西）。
   * 令牌由 theme-controller 同时写在 html 与 body 上，两处都探一次。
   */
  function tokenColor(name: string, fallback: string) {
    const read = (el: Element | null) => (el ? getComputedStyle(el).getPropertyValue(name).trim() : '')
    return read(doc.documentElement) || read(doc.body) || fallback
  }

  function drawSpeedGraph() {
    const ctx = detailGraph.getContext('2d')
    if (!ctx) return
    const W = detailGraph.width
    const H = detailGraph.height
    const accent = tokenColor('--hira-accent', '#3b82f6')
    ctx.clearRect(0, 0, W, H)
    if (speedSamples.length < 2) {
      ctx.fillStyle = tokenColor('--hira-text-tertiary', '#9ca3af')
      ctx.font = '11px system-ui'
      ctx.fillText('暂无速度数据', 60, 48)
      return
    }
    let maxSpeed = 1
    for (const s of speedSamples) if (s.s > maxSpeed) maxSpeed = s.s
    maxSpeed = Math.max(maxSpeed, 1024)
    ctx.strokeStyle = accent
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const n = speedSamples.length
    for (let i = 0; i < n; i++) {
      const x = (i / (MAX_SPEED_SAMPLES - 1)) * W
      const y = H - (speedSamples[i].s / maxSpeed) * (H - 10) - 4
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.lineTo((n - 1) / (MAX_SPEED_SAMPLES - 1) * W, H)
    ctx.lineTo(0, H)
    ctx.closePath()
    // 面积用同一强调色 + alpha（令牌可能不是 rgb() 字面量，不能靠字符串拼 rgba）。
    ctx.globalAlpha = 0.15
    ctx.fillStyle = accent
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = tokenColor('--hira-border-subtle', 'rgba(0,0,0,0.08)')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, H - 0.5)
    ctx.lineTo(W, H - 0.5)
    ctx.stroke()
    ctx.fillStyle = tokenColor('--hira-text-secondary', '#6b7280')
    ctx.font = '10px system-ui'
    ctx.fillText(formatSpeed(maxSpeed), 4, 12)
  }

  toggleBtn.addEventListener('click', toggleExpand)
  clearBtn.addEventListener('click', async () => {
    try { await invoke('download:clear-completed') } catch (_) {}
  })

  // 限速按钮：仅 IPC 模式下可用
  if (typeof options.invoke === 'function') {
    rateBtn.addEventListener('click', async () => {
      let current = 0
      try {
        const result = await invoke('download:get-rate-limit')
        const rate = result && typeof result === 'object' ? (result as { bytesPerSec?: unknown }).bytesPerSec : 0
        current = Number(rate) || 0
      } catch (_) {}
      const input = prompt(
        '设置下载限速（KB/s，0=不限速）',
        current ? String(Math.round(current / 1024)) : '0'
      )
      if (input == null) return
      const kb = parseInt(input, 10)
      if (isNaN(kb) || kb < 0) return
      const bytes = kb * 1024
      try { await invoke('download:set-rate-limit', { bytesPerSec: bytes }) } catch (_) {}
      updateRateLabel(bytes)
    })

    function updateRateLabel(bytes: number) {
      if (!bytes || bytes <= 0) rateBtn.textContent = '不限速'
      else rateBtn.textContent = formatSpeed(bytes).replace('/s', '')
    }

    invoke('download:get-rate-limit').then((result) => {
      const rate = result && typeof result === 'object' ? (result as { bytesPerSec?: unknown }).bytesPerSec : 0
      if (Number(rate) > 0) updateRateLabel(Number(rate))
    }).catch(() => {})

    // 订阅下载进度事件（IPC 模式下）：行内原地刷新 + 详情栏，不重建列表
    subscribe('download:progress', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const next = payload as DownloadItem
      const key = String(next.id)
      activeDownloads.set(key, next)

      const refs = rowRefs.get(key)
      if (refs) {
        const snapshot = lastList.find(i => String(i.id) === key) || refs.item
        refs.item = snapshot
        applyRowView(refs, resolveDownloadView(snapshot, payload))
      }
      updateBar()

      if (key === selectedId) {
        const snapshot = lastList.find(i => String(i.id) === key)
        const view = resolveDownloadView(snapshot || {}, payload)
        detailPct.textContent = view.pct != null ? `${view.pct}%` : (view.active ? ACTIVE_DOWNLOAD_TEXT : '—')
        detailProgressBar.style.width = view.pct != null ? `${Math.max(2, view.pct)}%` : '0%'
        metricSpeed.textContent = view.speed > 0 ? formatSpeed(view.speed) : '—'
        metricETA.textContent = view.eta > 0 ? formatETA(view.eta) : '—'
        metricSize.textContent = view.total > 0
          ? `${formatSize(view.received)} / ${formatSize(view.total)}`
          : `已接收 ${formatSize(view.received)}`
        speedSamples.push({ t: Date.now(), s: view.speed })
        if (speedSamples.length > MAX_SPEED_SAMPLES) speedSamples.shift()
        drawSpeedGraph()
      }
    })

    subscribe('download:done', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const key = String((payload as DownloadItem).id)
      activeDownloads.delete(key)
      updateBar()
      if (key === selectedId) {
        metricSpeed.textContent = '—'
        metricETA.textContent = '—'
        drawSpeedGraph()
      }
    })
  }

  function updateBar() {
    // 仅汇总进行中/暂停的下载（键统一为字符串，进度事件与列表快照不会各存一份）
    let active = 0
    let firstActive: DownloadItem | null = null
    for (const [, d] of activeDownloads) {
      if (!isLiveDownloadState(d.state)) continue
      active++
      if (!firstActive) firstActive = d
    }
    if (active === 0) {
      bar.classList.remove('visible')
      return
    }
    bar.classList.add('visible')
    if (!firstActive) return
    text.textContent = active === 1 ? (firstActive.filename || '') : `${active} 个下载中`

    // 顶栏百分比同样用合并口径：进度事件的 totalBytes 在响应头前是 0，
    // 直接拿它算会显示 0%，只能靠快照补总量。
    const snapshot = lastList.find(i => String(i.id) === String(firstActive.id))
    const view = resolveDownloadView(snapshot || {}, firstActive)
    if (view.pct != null) {
      progressFill.style.width = `${view.pct}%`
      percent.textContent = `${view.pct}%`
    } else {
      progressFill.style.width = '35%'
      percent.textContent = view.active ? ACTIVE_DOWNLOAD_TEXT : ''
    }
  }

  return {
    element: container,
    refreshList,
    updateBar,
    drawSpeedGraph
  }
}

export default { injectDownloadBarStyles, createDownloadBar }
