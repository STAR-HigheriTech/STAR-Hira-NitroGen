/**
 * Domain: Download — 下载领域纯工具函数（零依赖）
 *
 * R3 合规：不 require fs/path/process；全部为纯字符串/数值逻辑。
 * 这些函数是下载记录展示与状态机的高频易用补充，逐条有 .test 覆盖。
 */

/** 计算下载进度百分比（clamp 0~100，total<=0 返回 0）。 */
export type DownloadState = 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed'

function computeProgressPercent(received: number | null | undefined, total: number | null | undefined): number {
  if (!total || total <= 0 || received == null) return 0
  let pct = (received / total) * 100
  if (pct < 0) pct = 0
  if (pct > 100) pct = 100
  return Math.round(pct * 10) / 10
}

/** 剩余待下载字节数（越界则归零）。 */
function computeBytesRemaining(received: number | null | undefined, total: number | null | undefined): number {
  if (total == null || received == null) return 0
  const rem = total - received
  return rem > 0 ? rem : 0
}

/** 是否为待开始状态。 */
function isPending(state: string | null | undefined): boolean { return state === 'pending' }

/** 是否为下载中状态。 */
function isDownloading(state: string | null | undefined): boolean { return state === 'in_progress' }

/** 是否为暂停状态。 */
function isPaused(state: string | null | undefined): boolean { return state === 'paused' }

/** 是否为已完成状态。 */
function isCompleted(state: string | null | undefined): boolean { return state === 'completed' }

/** 是否为用户取消。 */
function isCancelled(state: string | null | undefined): boolean { return state === 'cancelled' }

/** 是否为失败 / 中断。 */
function isInterrupted(state: string | null | undefined): boolean { return state === 'interrupted' || state === 'failed' }

/**
 * 解析 Content-Disposition 头取文件名。
 * 优先 RFC5987 的 filename*=，其次 filename=；均做解码。
 * @param {string|null|undefined} header
 * @returns {string} 空串表示无法解析
 */
function parseContentDisposition(header: string | null | undefined): string {
  if (!header) return ''
  let match = /filename\*\s*=\s*(?:UTF-8'')?([^;\r\n]+)/i.exec(header)
  if (match && match[1]) {
    try { return decodeURIComponent(match[1].trim().replace(/^"|"$/g, '')) } catch (_) { /* fallthrough */ }
  }
  match = /filename\s*=\s*"?([^";\r\n]+)"?/i.exec(header)
  if (match && match[1]) return match[1].trim()
  return ''
}

/** 从 URL 中提取最后一段路径作为候选文件名（解 URI 编码，去查询串/hash）。 */
function extractFilenameFromUrl(url: string | null | undefined): string {
  if (!url) return ''
  const withoutHash = url.split('#')[0]
  const withoutQuery = withoutHash.split('?')[0]
  let last = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1)
  if (!last) return ''
  try { last = decodeURIComponent(last) } catch (_) {}
  return last
}

/**
 * 决策最终候选文件名：Content-Disposition 文件名 → URL 末段 → 'download'。
 * @param {{ url: string, contentDisposition?: string }} opts
 */
function chooseFallbackFilename({ url, contentDisposition }: { url: string; contentDisposition?: string | null }): string {
  const fromCD = parseContentDisposition(contentDisposition)
  if (fromCD) return fromCD
  const fromUrl = extractFilenameFromUrl(url)
  if (fromUrl) return fromUrl
  return 'download'
}

/** 去掉文件名的最后一个扩展名（无扩展名则原样返回）。 */
function stripExtension(filename: string | null | undefined): string {
  if (!filename) return ''
  const s = String(filename)
  const dot = s.lastIndexOf('.')
  if (dot <= 0 || dot === s.length - 1) return s
  return s.slice(0, dot)
}

/** 对 URL 做稳定字符串散列（djb2），用于去重 / 键名。 */
function hashUrl(url: unknown): string {
  const s = String(url || '')
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i)
  }
  return String(hash >>> 0)
}

export {
  computeProgressPercent,
  computeBytesRemaining,
  isPending,
  isDownloading,
  isPaused,
  isCompleted,
  isCancelled,
  isInterrupted,
  parseContentDisposition,
  extractFilenameFromUrl,
  chooseFallbackFilename,
  stripExtension,
  hashUrl
}
