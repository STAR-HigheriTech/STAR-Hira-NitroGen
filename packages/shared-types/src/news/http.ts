/**
 * 新闻源的 HTTP 取数小工具（各 provider 共用）
 *
 * 只做「发一个 GET、拿 JSON、不是 200 就抛」这一件事。
 * 超时/降级在 service.mjs，这里不做 —— 每层只管自己那一件事。
 */

const MAX_JSON_BYTES = 1024 * 1024

async function readJsonLimited(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_JSON_BYTES) throw new Error('新闻响应过大')
  const reader = res.body?.getReader()
  if (!reader) return res.json()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_JSON_BYTES) {
        try { await reader.cancel() } catch (_) {}
        throw new Error('新闻响应过大')
      }
      chunks.push(value)
    }
  } catch (error) {
    try { await reader.cancel() } catch (_) {}
    throw error
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * @param {string} url
 * @param {{ signal?:AbortSignal }} [opts]
 * @returns {Promise<any>}
 */
export async function getJson(url: string, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: 'GET',
    signal: opts.signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { accept: 'application/json, text/plain, */*' }
  })
  if (!res.ok) {
    try { await res.body?.cancel() } catch (_) {}
    throw new Error(`HTTP ${res.status}`)
  }
  return readJsonLimited(res)
}

/** 统一的"相对时间"格式化（列表里显示 xx 分钟前）。 */
export function relativeTime(ts: unknown): string {
  const timestamp = Number(ts)
  if (!Number.isFinite(timestamp)) return ''
  const diff = Date.now() - timestamp
  if (diff < 0) return ''
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return ''
}

/** 热度数值 → 紧凑文本（12345 → 1.2万）。非数值原样返回。 */
export function formatHot(hot: unknown): string {
  if (hot === undefined || hot === null || hot === '') return ''
  const s = String(hot).trim()
  if (!s) return ''
  const n = Number(s.replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return s
  if (/[万亿]/.test(s)) return s
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
  return String(Math.round(n))
}
