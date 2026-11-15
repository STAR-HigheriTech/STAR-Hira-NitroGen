/**
 * 下载可视量的**唯一口径**（下载面板 / 底部下载条 / 内部下载页共用）。
 *
 * 同一条下载有两个数据来源：
 *   · 持久化快照（DB 的静态字段：文件名、总量、状态、落盘路径）
 *   · 实时进度事件（received / total / state / speed / eta）
 *
 * 每个视图各自把两者"合一遍"就必然分叉 —— 表现是进度条在动、文字停在 0%，
 * 或者下载条显示"下载中"、面板已经显示"已完成"。所以合并规则只放在这里，
 * 视图层拿 `resolveDownloadView()` 的结果**只做 DOM 写入**。
 */

/** 状态词（跨视图统一用词；未知状态回落原始值） */
export const DOWNLOAD_STATE_TEXT = Object.freeze({
  pending: '等待中',
  in_progress: '下载中',
  progressing: '下载中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已失败',
  failed: '已失败'
})

/**
 * 正在跑的下载（paused 不算：它不产出进度，也不该让「有活动下载」的轮询空转）。
 * @param {string|null|undefined} state
 * @returns {boolean}
 */
export function isActiveDownloadState (state: string|null|undefined) : boolean {
  return state === 'in_progress' || state === 'progressing' || state === 'pending'
}

/**
 * 仍需占位/参与汇总的状态（活动 + 暂停）。
 * @param {string|null|undefined} state
 * @returns {boolean}
 */
export function isLiveDownloadState (state: string|null|undefined) : boolean {
  return isActiveDownloadState(state) || state === 'paused'
}

/**
 * 状态词。
 * @param {string|null|undefined} state
 * @returns {string}
 */
export function downloadStateText (state: string|null|undefined) : string {
  if (!state) return ''
  return DOWNLOAD_STATE_TEXT[state as keyof typeof DOWNLOAD_STATE_TEXT] || String(state)
}

/**
 * 一行的有效可视量：**持久化快照 + 实时进度覆盖** → 单一口径。
 *
 * @param {any} item 列表条目（DB 快照）
 * @param {any} [progress] 实时进度事件（可能没有）
 * @returns {{
 *   received: number,
 *   total: number,
 *   state: string,
 *   active: boolean,
 *   pct: number|null,
 *   speed: number,
 *   eta: number
 * }}
 */
export interface DownloadView {
  received: number
  total: number
  state: string
  active: boolean
  pct: number | null
  speed: number
  eta: number
}

export function resolveDownloadView (item: unknown, progress: unknown): DownloadView {
  const it = item && typeof item === 'object' ? item as Record<string, unknown> : {}
  const p = progress && typeof progress === 'object' ? progress as Record<string, unknown> : {}
  // 两个来源取"更靠前"的那个：
  //   · 进度事件的 totalBytes 在响应头到达前是 0（不能拿它把已知总量抹掉）；
  //   · 事件偶发漏投时，DB 落库值是唯一能追上进度的兜底（received 取 max）。
  const received = Math.max(Number(p.receivedBytes) || 0, Number(it.receivedBytes) || 0)
  const total = (Number(p.totalBytes) || 0) > 0 ? Number(p.totalBytes) : (Number(it.totalBytes) || 0)
  const state = String(p.state || it.state || '')
  const active = isActiveDownloadState(state)
  const speed = Number(p.speed) || 0
  const eta = Number(p.eta) || 0
  return {
    received,
    total,
    state,
    active,
    // 总量未知（无 Content-Length）时**不显示**百分比，而不是显示一个假的 0%
    pct: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
    speed: speed > 0 ? speed : 0,
    eta: eta > 0 ? eta : 0
  }
}
