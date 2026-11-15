/**
 * asset-response.js —— 「把本地文件变成一个协议响应」的**唯一实现**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件
 * ══════════════════════════════════════════════════════════════════════
 * 有两个特权协议要从磁盘发文件：`hira-theme://`（用户主题的资产）与
 * `hira-plugin://`（插件包里的资产 / 代码）。它们的安全边界**不同**（各自的
 * 白名单与目录守卫都在自己文件里，也必须留在那里），但"字节怎么发出去"这件事
 * **完全相同** —— 各写一遍的结果就是：给视频补 `Range` 时只补了一处，
 * 于是"用户主题的动态壁纸能播、插件主题的播不了"，而这类问题极难查。
 *
 * ══════════════════════════════════════════════════════════════════════
 * `Range` 支持：是硬要求，不是优化
 * ══════════════════════════════════════════════════════════════════════
 * `<video>` 会发 `Range: bytes=0-`，并在拿到 `200`（而不是 `206 + Content-Range`）
 * 时**可能直接放弃加载** —— Chromium 的媒体管线按段取流，它期待的就是 206。
 * 所以：
 *   · `Accept-Ranges: bytes` 必须发（不发这个头，客户端连试都不试）；
 *   · 有 Range → `206` + `Content-Range`，且**流式**（`fs.createReadStream`）——
 *     视频几十 MB，一次性 `readFile` 再包 Response 会把整段内容驻留在内存里；
 *   · 无 Range → `200` + `Content-Length`（图片 / 代码走的就是这条，与改造前一致）。
 *
 * **为什么不透传 `net.fetch('file://…')`**：那要赌 Chromium 的 file 协议实现是否
 * 支持 Range、以及它返回的头能否原样复用；而这里是**安全边界所在的链路**，
 * "文件怎么发出去"只该有一份实现、且必须是确定的。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const { Readable } = require('stream')

/** 字节区间请求头（唯一支持的形式：`bytes=` 单段）。 */
const RANGE_RE = /^bytes=(\d*)-(\d*)$/

type ParsedRange = { start: number; end: number } | { unsatisfiable: true } | null

interface FileResponseOptions {
  mime?: string
  maxBytes?: number
  cacheControl?: string
  headers?: Record<string, string>
}

/**
 * 解析 `Range` 头。
 *
 * 支持三种写法（HTTP 规范里的三种）：
 *   · `bytes=100-200` 闭区间；`bytes=100-` 到结尾；`bytes=-500` **最后** 500 字节。
 * 解析不出 / 多段（`bytes=0-1,5-6`）→ 返回 `null` = **当成没有 Range**（回 200 全量）。
 * 范围完全越界（`bytes=99999-` 而文件只有 100 字节）→ 返回 `{ unsatisfiable: true }`，
 * 由调用方回 `416` —— 这是规范要求，也让"文件被换小了"这类情况能被看出来。
 *
 * @param {string|undefined|null} header
 * @param {number} size 文件字节数
 * @returns {{ start: number, end: number } | { unsatisfiable: true } | null}
 */
function parseRangeHeader(header: string | null | undefined, size: number): ParsedRange {
  const raw = String(header == null ? '' : header).trim()
  if (!raw) return null
  const m = RANGE_RE.exec(raw)
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return null

  if (!hasStart) {
    // `bytes=-N`：最后 N 字节（N=0 按规范是"满足不了"）
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true }
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(m[1])
  if (!Number.isFinite(start) || start >= size) return { unsatisfiable: true }
  let end = hasEnd ? Number(m[2]) : size - 1
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true }
  if (end > size - 1) end = size - 1
  return { start, end }
}

/** 一段字节 → 可流式消费的 web ReadableStream（`fs.createReadStream` 的包装）。 */
function streamOf(abs: string, start: number | null, end: number | null): ReadableStream<Uint8Array> | null {
  // Node 18+ 有 Readable.toWeb；拿不到就退回"整块读"（慢一点，但不至于发不出去）。
  if (typeof Readable.toWeb !== 'function') return null
  const nodeStream = fs.createReadStream(abs, start == null ? undefined : { start, end })
  return Readable.toWeb(nodeStream)
}

/**
 * 一个本地文件 → 协议 Response（唯一出口）。
 *
 * **调用方负责安全**：传入的 `abs` 必须已经过目录守卫与扩展名白名单
 * （见 theme-asset-protocol.js / plugin-protocol.js 的文件头）。本函数只做
 * "文件系统 → HTTP 语义"的翻译，不认识任何白名单。
 *
 * @param {Request} request 协议请求（只用到它的 `headers`）
 * @param {string} abs 已通过守卫的绝对路径
 * @param {{ mime?: string, maxBytes?: number, cacheControl?: string, headers?: Record<string, string> }} [opts]
 *   `maxBytes` 由调用方按扩展名分档给出（见各协议的 asset/comic 额度说明）。
 *   `headers` 是调用方追加的安全响应头（如 `nosniff` / 派生 CSP），**逐条合并**进
 *   所有分支（含 206/416），不会被 Range 分支覆盖 —— 否则"分段取一次就把安全头丢了"。
 * @returns {Promise<Response>}
 */
async function fileResponse(request: Request, abs: string, opts: FileResponseOptions = {}): Promise<Response> {
  const mime = opts.mime || 'application/octet-stream'
  const maxBytes = Number.isFinite(opts.maxBytes) ? Number(opts.maxBytes) : Infinity
  // 默认「缓存但每次校验」：字节留在客户端缓存里，命中时只回 304（见下方 ETag 段）。
  // 调用方要更激进（`?v=` 版本化 → immutable）或更保守（`no-store`）都可显式覆盖。
  const cacheControl = opts.cacheControl || 'no-cache'

  /** 调用方追加的安全头（仅字符串值；非字符串一律忽略，避免把对象拼进 Headers）。 */
  const extraHeaders: Record<string, string> = {}
  if (opts.headers && typeof opts.headers === 'object') {
    for (const [key, value] of Object.entries(opts.headers) as Array<[string, unknown]>) {
      if (typeof value === 'string' && value) extraHeaders[key] = value
    }
  }

  /** 跨源取本协议是常态（渲染层 origin 是 hira://xxx / http://localhost）—— 必须放行。 */
  const baseHeaders = {
    ...extraHeaders,
    'Content-Type': mime,
    'Cache-Control': cacheControl,
    'Access-Control-Allow-Origin': '*',
    // 没有它，客户端不会尝试分段取（`<video>` 直接不播）。
    'Accept-Ranges': 'bytes'
  }

  let st
  try {
    st = await fsp.stat(abs)
  } catch (_) {
    return new Response('Not Found', { status: 404, headers: baseHeaders })
  }
  if (!st.isFile()) return new Response('Not Found', { status: 404, headers: baseHeaders })
  if (st.size > maxBytes) return new Response('Payload Too Large', { status: 413, headers: baseHeaders })

  /* ── ETag / 条件请求 ─────────────────────────────────────────────
     为什么必须有：协议层的默认缓存策略是 `no-store`，于是面板里的一张图标、
     一段 CSS，**每次重开/重建面板都要重新读一遍磁盘**。可如果直接改成
     `max-age=…`，插件更新后旧图会带缓存继续显示（用户会以为更新没生效）。

     `ETag = mtime + size` + `Cache-Control: no-cache`（缓存但每次都校验）同时解决两件事：
       · 字节留在 Chromium 的缓存里，命中时只回一个**空的 304**（不读文件）；
       · 文件一改，mtime/size 变，ETag 变 → 下一次请求自然拿到新内容。
     `?v=` 版本化 URL 的调用方可以再传更激进的 `cacheControl`（见 plugin-protocol.js）。 */
  const etag = `"${Math.trunc(st.mtimeMs).toString(36)}-${st.size.toString(36)}"`
  const headersWithEtag = { ...baseHeaders, ETag: etag }

  let ifNoneMatch = ''
  try {
    ifNoneMatch = request && request.headers ? (request.headers.get('if-none-match') || '') : ''
  } catch (_) {
    ifNoneMatch = ''
  }
  if (ifNoneMatch) {
    const candidates = ifNoneMatch.split(',').map((segment: string) => segment.trim().replace(/^W\//, ''))
    if (candidates.includes(etag)) {
      return new Response(null, { status: 304, headers: headersWithEtag })
    }
  }

  let rangeHeader: string | null = ''
  try {
    rangeHeader = request && request.headers ? request.headers.get('range') : ''
  } catch (_) {
    rangeHeader = ''
  }
  const range = parseRangeHeader(rangeHeader, st.size)

  if (range && 'unsatisfiable' in range && range.unsatisfiable) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { ...headersWithEtag, 'Content-Range': `bytes */${st.size}` }
    })
  }

  if (range && 'start' in range) {
    const length = range.end - range.start + 1
    const body = streamOf(abs, range.start, range.end) || await fsp.readFile(abs).then((data: Buffer) => data.subarray(range.start, range.end + 1))
    return new Response(body, {
      status: 206,
      headers: {
        ...headersWithEtag,
        'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
        'Content-Length': String(length)
      }
    })
  }

  const body = streamOf(abs, null, null) || await fsp.readFile(abs)
  return new Response(body, {
    status: 200,
    headers: { ...headersWithEtag, 'Content-Length': String(st.size) }
  })
}

module.exports = { fileResponse, parseRangeHeader }
