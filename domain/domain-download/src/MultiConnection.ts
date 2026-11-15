/**
 * 多线程下载器 (Multi-Connection Downloader, MCD) —— 端口注入版
 *
 * 逐字下沉自 main/multi-connection-downloader.js，算法与状态机原样保留，
 * 只有 IO 换成了注入端口（R3：domain 不得 require electron/fs）：
 *   - netPort.request({ method, url })  → Electron net.request 同形接口
 *     （on/abort/setHeader/end），APPS 侧注入 `(...a) => net.request(...a)` 的包装
 *   - fileOps                           → 分段落盘原语：
 *       openWriteSync / truncateSync / closeSync / unlinkSync
 *         一次性同步操作（启动/收尾各调一次，量级可忽略）；
 *       writeAt(fd, chunk, offset) → Promise
 *         **每数据块一次**的热路径，必须异步 —— 同步写盘会逐块卡主线程。
 *         domain 内置单 fd 串行写链：块只入队，落盘在微任务里逐块 await。
 *   - markOfTheWeb(savePath, meta)      → 完成时写 Zone.Identifier
 *
 *   - HEAD 探测 Content-Length + Accept-Ranges
 *   - 支持 Range → 分 N 段 → N 个并发 net.request(Range) → 按位置写
 *   - 不支持 Range 或文件太小 → 回退单线程（返回 false，调用方走 Electron 默认）
 *   - 共享全局令牌桶，保证总下载速度上限
 */

const MIN_MULTITHREAD_SIZE = 5 * 1024 * 1024 // 5MB 以下走单线程
const DEFAULT_CONNECTIONS = 8
// 写队列背压水位：待落盘字节超过 HIGH 即断流该分片（abort，按 r.received 续传），
// 回落到 LOW 以下再唤醒 —— 网速远快于盘速时，内存不会无界堆积。
const WRITE_QUEUE_HIGH_WATER = 64 * 1024 * 1024
const WRITE_QUEUE_LOW_WATER = 16 * 1024 * 1024

type HeaderValue = string | string[] | undefined

interface NetResponse {
  statusCode: number
  headers: Record<string, HeaderValue>
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'end', listener: () => void): void
}

interface NetRequest {
  setHeader(name: string, value: string): void
  on(event: 'response', listener: (response: NetResponse) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  abort(): void
  end(): void
}

interface NetPort { request(options: { method: string; url: string }): NetRequest }

interface DownloadFileOps {
  openWriteSync(path: string): number
  truncateSync(fd: number, size: number): void
  writeAt(fd: number, chunk: Buffer, offset: number): Promise<void>
  closeSync(fd: number): void
  unlinkSync(path: string): void
}

interface RateLimiterPort {
  tryConsume(bytes: number): 'ok' | 'throttle'
  onNextTick(callback: () => void, bytesNeeded?: number): () => boolean
}

interface McdFactoryDeps {
  netPort?: NetPort | null
  fileOps?: Partial<DownloadFileOps> | null
  markOfTheWeb?: (savePath: string, meta: { referrerUrl: string; hostUrl: string }) => void
}

export interface MCDOptions {
  url: string
  savePath: string
  connections?: number
  emit?: (event: string, payload: Record<string, unknown>) => void
  rateLimiter?: RateLimiterPort | null
}

export interface MultiConnectionDownload {
  start(): Promise<boolean>
  pause(): void
  resume(): boolean
  cancel(): Promise<void>
  isPaused(): boolean
  getReceivedBytes(): number
  getTotalBytes(): number
  getActiveConnections(): number
  canResume(): boolean
}

export type McdFactory = (options: MCDOptions) => MultiConnectionDownload

interface RangeSegment {
  start: number
  end: number
  received: number
  req: NetRequest | null
  done: boolean
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

function headerText(value: HeaderValue): string {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

/**
 * 创建 MCD 工厂。
 * @param {{ netPort: object, fileOps: object, markOfTheWeb?: Function }} deps
 * @returns {McdFactory} createMultiConnectionDownload(opts)
 */
function createMcdFactory({ netPort, fileOps, markOfTheWeb }: McdFactoryDeps) : McdFactory {
  if (!netPort || typeof netPort.request !== 'function') {
    throw new Error('[domain-download] createMcdFactory: netPort.request is required')
  }
  if (!fileOps) {
    throw new Error('[domain-download] createMcdFactory: fileOps is required')
  }
  if (typeof fileOps.writeAt !== 'function') {
    throw new Error('[domain-download] createMcdFactory: fileOps.writeAt(fd, chunk, offset) → Promise is required')
  }
  const net = netPort as NetPort
  const { openWriteSync, truncateSync, writeAt, closeSync, unlinkSync } = fileOps as DownloadFileOps
  const motw = typeof markOfTheWeb === 'function' ? markOfTheWeb : (_savePath: string, _meta: { referrerUrl: string; hostUrl: string }) => {}

  /**
   * 创建一个多线程下载实例。
   * @param {{ url: string, savePath: string, connections?: number, emit?: Function, rateLimiter?: object }} opts
   */
  function createMultiConnectionDownload(opts: MCDOptions): MultiConnectionDownload {
    const targetUrl = opts.url
    const savePath = opts.savePath
    const connections = Math.min(Math.max(opts.connections || DEFAULT_CONNECTIONS, 1), 16)
    const emit: (event: string, payload: Record<string, unknown>) => void = typeof opts.emit === 'function'
      ? opts.emit
      : () => {}
    const rateLimiter = opts.rateLimiter || null

    let totalBytes = 0
    let receivedBytes = 0
    let ranges: RangeSegment[] = []
    let fd = -1
    let paused = false
    let cancelled = false
    let done = false
    let refererUrl = ''
    const hostUrl = targetUrl

    // ---- 异步写队列（MCD 写盘改造核心）----
    // 单 fd 串行写链：网络块只入队（received 记账以「已入队」为准），
    // 落盘在微任务里逐块 await，主线程零同步写。
    // 分片续传按绝对 offset 重取，与仍在排队的写不重叠 —— 它们的 offset
    // 全部小于 r.start + r.received；同一片内保序由链保证。
    let writeChain: Promise<void> = Promise.resolve()
    let pendingWriteBytes = 0  // 已入队未落盘字节（背压水位用）
    let writeFailed: unknown | null = null     // 首个写盘错误（fail-fast：后续块全部跳过落盘）
    let failEmitted = false    // error 事件只发一次
    const drainWaiters: Array<() => void> = []    // 低水位唤醒回调（背压恢复续传）

    /**
     * 入队一次异步写（串行链保序，错误统一收口到 failAll）。
     * @param {Buffer} chunk @param {number} offset
     */
    function enqueueWrite(chunk: Buffer, offset: number): void {
      if (writeFailed || cancelled) return
      pendingWriteBytes += chunk.length
      writeChain = writeChain.then(async () => {
        try {
          if (writeFailed || cancelled) return // 失败/取消后不再落盘
          await writeAt(fd, chunk, offset)
        } catch (e) {
          writeFailed = writeFailed || e
          failAll('write failed: ' + errorMessage(e))
        } finally {
          pendingWriteBytes -= chunk.length
          notifyDrain()
        }
      })
    }

    /** 注册低水位唤醒（背压恢复用）。 */
    function waitForDrain(cb: () => void): void { drainWaiters.push(cb) }

    function notifyDrain() {
      if (pendingWriteBytes > WRITE_QUEUE_LOW_WATER || drainWaiters.length === 0) return
      const cbs = drainWaiters.splice(0)
      for (const cb of cbs) { try { cb() } catch (_) {} }
    }

    /**
     * 全部已入队写落盘完毕。链内已吞错（收口 failAll），返回的 promise 永不 reject。
     */
    function flushWrites() { return writeChain }

    /**
     * 写盘失败统一收口：断流所有分片 → 等队列排空 → 关 fd → 发 error。
     * error 延迟到 fd 关闭后再发：调用方紧接着删临时文件才不会撞上「句柄未关」。
     */
    function failAll(message: string): void {
      if (done || cancelled || failEmitted) return
      failEmitted = true
      for (const r of ranges) {
        if (r.req) { try { r.req.abort() } catch (_) {} r.req = null }
      }
      flushWrites().then(() => {
        try { if (fd >= 0) closeSync(fd); fd = -1 } catch (_) {}
        emit('error', { message })
      }).catch(() => {})
    }

    /**
     * 探测：先 HEAD，失败则 GET Range: bytes=0-0
     */
    function probe(): Promise<boolean> {
      return new Promise((resolve) => {
        const headReq = net.request({
          method: 'HEAD',
          url: targetUrl
        })
        headReq.on('response', (resp) => {
          const headers = resp.headers || {}
          const len = parseInt(headerText(headers['content-length']) || '0', 10)
          const acceptRanges = headerText(headers['accept-ranges']).toLowerCase()
          const refer = headerText(headers['referer']) || headerText(headers['origin'])
          if (refer) refererUrl = refer
          if (len > 0 && acceptRanges.includes('bytes')) {
            totalBytes = len
            headReq.abort()
            resolve(true)
          } else if (len > 0) {
            totalBytes = len
            headReq.abort()
            resolve(false) // 不支持 Range
          } else {
            headReq.abort()
            resolve(false)
          }
        })
        headReq.on('error', () => resolve(false))
        headReq.end()
      })
    }

    /**
     * 备用探测：GET Range: bytes=0-0（大部分 CDN 拒绝 HEAD 但支持 Range）
     */
    function probeRange(): Promise<boolean> {
      return new Promise((resolve) => {
        const req = net.request({
          method: 'GET',
          url: targetUrl
        })
        req.setHeader('Range', 'bytes=0-0')
        req.on('response', (resp) => {
          const status = resp.statusCode
          const headers = resp.headers || {}
          const cr = String(headers['content-range'] || '')
          // content-range: bytes 0-0/12345
          const m = cr.match(/bytes\s+\d+-\d+\/(\d+)/i)
          if (status === 206 && m) {
            totalBytes = parseInt(m[1], 10)
            req.abort()
            resolve(true)
          } else {
            const len = parseInt(headerText(headers['content-length']) || '0', 10)
            if (len > 0) totalBytes = len
            req.abort()
            resolve(false)
          }
        })
        req.on('error', () => resolve(false))
        req.end()
      })
    }

    /**
     * 启动多线程下载
     */
    async function start(): Promise<boolean> {
      let supported = await probe()
      if (!supported) supported = await probeRange()
      if (!supported || totalBytes < MIN_MULTITHREAD_SIZE) {
        return false // 调用方回退单线程
      }
      // 分段
      const chunkSize = Math.floor(totalBytes / connections)
      ranges = []
      for (let i = 0; i < connections; i++) {
        const start = i * chunkSize
        const end = (i === connections - 1) ? totalBytes - 1 : (start + chunkSize - 1)
        ranges.push({ start, end, received: 0, req: null, done: false })
      }
      // 打开文件
      try {
        fd = openWriteSync(savePath)
        // 预分配空间（可选，避免并发写越界）
        truncateSync(fd, totalBytes)
      } catch (e) {
        emit('error', { message: 'open file failed: ' + errorMessage(e) })
        return false
      }
      // 启动每个段
      for (let i = 0; i < ranges.length; i++) {
        startRange(i)
      }
      emit('started', { totalBytes, connections: ranges.length })
      return true
    }

    function startRange(idx: number): void {
      const r = ranges[idx]
      if (r.done || paused || cancelled) return
      const req = net.request({
        method: 'GET',
        url: targetUrl
      })
      req.setHeader('Range', `bytes=${r.start + r.received}-${r.end}`)
      req.on('response', (resp) => {
        if (resp.statusCode !== 206 && resp.statusCode !== 200) {
          emit('error', { message: `range ${idx} status ${resp.statusCode}` })
          return
        }
        resp.on('data', (chunk) => {
          if (cancelled || paused) {
            try { req.abort() } catch (_) {}
            return
          }
          // 限速：尝试消费
          if (rateLimiter && typeof rateLimiter.tryConsume === 'function') {
            const res = rateLimiter.tryConsume(chunk.length)
            if (res === 'throttle') {
              // 暂停请求：先 abort，等下个 tick 重新发起
              try { req.abort() } catch (_) {}
              r.req = null
              rateLimiter.onNextTick(() => {
                if (!paused && !cancelled && !r.done) {
                  startRange(idx) // 从 r.received 续传
                }
              }, chunk.length)
              return
            }
          }
          if (writeFailed) {
            try { req.abort() } catch (_) {}
            return
          }
          // 入队异步写（不阻塞主线程；记账以「已入队」为准，见写队列说明）
          enqueueWrite(chunk, r.start + r.received)
          r.received += chunk.length
          receivedBytes += chunk.length
          emitProgress()
          // 背压：落盘速度跟不上网速时断流该分片，队列回落后从 r.received 续传
          if (pendingWriteBytes > WRITE_QUEUE_HIGH_WATER) {
            try { req.abort() } catch (_) {}
            r.req = null
            waitForDrain(() => {
              if (!paused && !cancelled && !r.done && !writeFailed) {
                startRange(idx)
              }
            })
          }
        })
        resp.on('end', () => {
          r.done = true
          checkAllDone()
        })
      })
      req.on('error', (e) => {
        if (!cancelled && !paused) {
          emit('error', { message: `range ${idx} error: ${e.message}` })
        }
      })
      r.req = req
      req.end()
    }

    function emitProgress(): void {
      emit('progress', {
        receivedBytes,
        totalBytes,
        state: 'in_progress'
      })
    }

    function checkAllDone(): void {
      if (done || cancelled || writeFailed) return
      if (!ranges.every(r => r.done)) return
      done = true
      // 完成前必须把所有已入队写冲刷落盘再关 fd —— 否则文件尾部缺块
      flushWrites().then(() => {
        try { if (fd >= 0) closeSync(fd); fd = -1 } catch (_) {}
        // 写入 MotW
        motw(savePath, { referrerUrl: refererUrl, hostUrl })
        emit('done', { state: 'completed', receivedBytes, totalBytes })
      }).catch(() => {})
    }

    function pause(): void {
      paused = true
      for (const r of ranges) {
        if (r.req) {
          try { r.req.abort() } catch (_) {}
          r.req = null
        }
      }
      emit('progress', { receivedBytes, totalBytes, state: 'paused' })
    }

    function resume(): boolean {
      if (cancelled || done) return false
      paused = false
      for (let i = 0; i < ranges.length; i++) {
        if (!ranges[i].done) startRange(i)
      }
      return true
    }

    /**
     * 取消下载。返回 Promise：等写队列排空 → 关 fd → 删临时文件 → done(cancelled)，
     * 避免「写已关闭句柄」与「句柄占用删不掉」。promise 永不 reject。
     */
    function cancel(): Promise<void> {
      if (cancelled) return Promise.resolve()
      cancelled = true
      for (const r of ranges) {
        if (r.req) {
          try { r.req.abort() } catch (_) {}
          r.req = null
        }
      }
      // 取消后排队的块全部跳过落盘（enqueueWrite / 链内均有 cancelled 守卫），
      // 但仍在链上的节点要跑完才能安全关 fd。
      return flushWrites().then(() => {
        try { if (fd >= 0) closeSync(fd); fd = -1 } catch (_) {}
        try { unlinkSync(savePath) } catch (_) {}
        emit('done', { state: 'cancelled' })
      }).catch(() => {})
    }

    function isPaused() { return paused }
    function getReceivedBytes() { return receivedBytes }
    function getTotalBytes() { return totalBytes }
    function getActiveConnections() {
      return ranges.filter(r => r.req && !r.done).length
    }
    function canResume() { return !done && !cancelled }

    return {
      start,
      pause,
      resume,
      cancel,
      isPaused,
      getReceivedBytes,
      getTotalBytes,
      getActiveConnections,
      canResume
    }
  }

  return createMultiConnectionDownload
}

/**
 * 判断 URL 是否应该走多线程下载（HTTPS/HTTP，非 data: 非 blob: 非 file:）
 * @param {string} targetUrl
 */
function shouldUseMultiThread(targetUrl: unknown): boolean {
  if (!targetUrl) return false
  const lower = String(targetUrl).toLowerCase()
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return false
  if (lower.startsWith('file:')) return false
  return lower.startsWith('http:') || lower.startsWith('https:')
}

export {
  createMcdFactory,
  shouldUseMultiThread,
  DEFAULT_CONNECTIONS,
  MIN_MULTITHREAD_SIZE
}
