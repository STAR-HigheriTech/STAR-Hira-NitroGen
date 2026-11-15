import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogSink {
  write(line: string, level: LogLevel): void
  flush?(): void
}

export interface Logger {
  child(options?: { area?: string }): Logger
  debug(...parts: unknown[]): void
  info(...parts: unknown[]): void
  warn(...parts: unknown[]): void
  error(...parts: unknown[]): void
  flush(): void
}

export const LEVELS: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

export function stripAnsi(input: unknown): string {
  return String(input).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

interface LogLineInput {
  level: LogLevel
  area?: string
  message: string
  time?: number | string | Date
}

function formatLine({ level, area, message, time }: LogLineInput): string {
  const ts = (time ? new Date(time) : new Date()).toISOString()
  const a = area ? `[${area}]` : ''
  return `${ts} [${level}]${a} ${message}\n`
}

export function createConsoleSink({ useStderr = true }: { useStderr?: boolean } = {}): LogSink {
  return {
    write(line: string, level: LogLevel) {
      if (useStderr && (level === 'warn' || level === 'error')) process.stderr.write(line)
      else process.stdout.write(line)
    },
    flush() {}
  }
}

function rotateFiles({ filePath, maxFiles }: { filePath: string; maxFiles: number }): void {
  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    const src = `${filePath}.${i}`
    const dst = `${filePath}.${i + 1}`
    if (fs.existsSync(src)) fs.renameSync(src, dst)
  }
  if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`)
}

/**
 * 文件 sink —— **写入路径上零同步文件系统调用**。
 *
 * ── 为什么不是"每行 appendFileSync"（这是本函数最初的样子）────────────────
 * 那种写法每写一行要做**三次**同步系统调用：`existsSync`（它会存在吗）、
 * `statSync`（现在多大，要不要轮转）、`appendFileSync`（打开 + 写 + 关闭）。
 * 全部发生在**调用线程**上 —— 主进程里就是主线程，而日志恰恰在启动、
 * 切标签、设置变更这些最要紧的时刻最密集。一次 `appendFileSync` 的
 * open/close 在机械盘或被杀软扫描的目录下能到毫秒级，几十行日志就是几十毫秒的卡顿。
 *
 * ── 现在的口径 ──────────────────────────────────────────────────────────
 *   · **行只进内存缓冲**（一个数组 + 一个字节计数），不碰磁盘；
 *   · 攒够 `flushBytes` 或到 `flushMs` 才**异步** `appendFile` 一次 —— 调用方不等它；
 *   · 轮转判据用**内存里的字节计数**（创建时 stat 一次作为起点），不再每行 stat；
 *   · **单在途守卫**（`writing`）：同一时刻只允许一个异步写。这不只是为了省资源 ——
 *     `rotateFiles` 用的是 `renameSync`，若它与某个在途 `appendFile` 重叠，
 *     改名会抢在旧数据落盘之前发生（文件还不存在 ➜ 改名空转 ➜ 尺寸判据失真）。
 *     串行化之后，批次之间天然有序，轮转永远发生在"上一批已落地"之后；
 *   · `flush()` 收尾：空闲时走 `appendFileSync`（同步，换"关掉进程不丢日志"）；
 *     若恰好有在途写，则把这一批**挂到链尾异步落地**，绝不 `appendFileSync` 插队
 *     （插队会让新日志排到旧日志前面）。优雅退出会等这个异步写跑完。
 *
 * 代价如实写在明处：进程被强杀（SIGKILL / 断电）时，最多丢 `flushBytes` 或
 * `flushMs` 那一小段（干净退出走 `flush()` 不丢）。日志不该拿主线程流畅去换。
 *
 * 定时器一律 `unref()`：日志绝不能成为"进程关不掉"的理由（与全仓定时器同一纪律）。
 */
export function createFileSink({
  filePath,
  maxBytes = 1024 * 1024,
  maxFiles = 5,
  stripAnsi: strip = true,
  flushBytes = 16 * 1024,
  flushMs = 300
}: {
  filePath?: string
  maxBytes?: number
  maxFiles?: number
  stripAnsi?: boolean
  flushBytes?: number
  flushMs?: number
} = {}): LogSink {
  if (!filePath) throw new Error('filePath is required')
  const targetPath = filePath
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  /** 磁盘上已有的字节数（起点）。之后只靠内存累加，不再 stat。 */
  let bytes = 0
  try {
    if (fs.existsSync(targetPath)) bytes = fs.statSync(targetPath).size
  } catch (_) {}

  /** 待落盘的行（保持顺序；一次 appendFile 写一批）。 */
  let pending: string[] = []
  let pendingBytes = 0
  const MAX_PENDING_BYTES = Math.max(flushBytes * 4, 4 * 1024 * 1024)
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 是否有异步写在途 —— 保证同一时刻至多一个写操作，从而让轮转有序。 */
  let writing = false
  /** 收尾时若有在途写，把最后一批挂到它后面（见 flush()）。 */
  let tailFn: (() => void) | null = null
  let closed = false

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 轮转判据在**批**这一层做：一次多写十几行也不会漏过轮转。 */
  function account(chunkBytes: number): void {
    if (bytes + chunkBytes > maxBytes) {
      try { rotateFiles({ filePath: targetPath, maxFiles }) } catch (_) {}
      bytes = 0
    }
    bytes += chunkBytes
  }

  function onWritten(err: NodeJS.ErrnoException | null): void {
    writing = false
    if (err) process.stderr.write(`[logger] append failed: ${err.message}\n`)
    // 有挂尾的批次（收尾路径）优先，其次继续排空缓冲
    if (tailFn) {
      const fn = tailFn
      tailFn = null
      fn()
    } else if (pending.length) {
      flushNow()
    }
  }

  function flushNow(): void {
    clearTimer()
    // 有在途写：先不动磁盘，等它的回调里再排下一批（保证批次有序）
    if (writing || !pending.length) return
    const chunk = pending.join('')
    const chunkBytes = pendingBytes
    pending = []
    pendingBytes = 0
    writing = true
    account(chunkBytes)
    // 异步写：分配出去就返回，调用方（主线程）绝不等磁盘
    fs.appendFile(targetPath, chunk, onWritten)
  }

  function schedule(): void {
    if (timer || closed) return
    timer = setTimeout(flushNow, flushMs)
    // 日志不该拖住进程退出（退出前由 flush() 负责落盘）
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    write(line: string): void {
      if (closed) return
      const clean = strip ? stripAnsi(line) : line
      pending.push(clean)
      pendingBytes += Buffer.byteLength(clean)
      if (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) {
        // Disk stall must not turn logging into an unbounded memory leak. Keep the
        // newest half; diagnostics are more valuable than half-written old context.
        pending = pending.slice(-Math.ceil(pending.length / 2))
        pendingBytes = Buffer.byteLength(pending.join(''))
      }
      if (pendingBytes >= flushBytes) flushNow()
      else schedule()
    },
    /** 收尾落盘（只在退出流程被调一次）。之后本 sink 视为关闭。 */
    flush(): void {
      if (closed) return
      closed = true
      clearTimer()
      if (!pending.length) return
      const chunk = pending.join('')
      const chunkBytes = pendingBytes
      pending = []
      pendingBytes = 0
      if (writing) {
        // 在途写未归：挂到链尾异步落地，绝不同步插队（会颠倒日志顺序）
        tailFn = () => {
          account(chunkBytes)
          fs.appendFile(targetPath, chunk, onWritten)
        }
        return
      }
      try {
        account(chunkBytes)
        fs.appendFileSync(targetPath, chunk)
      } catch (err) {
        process.stderr.write(`[logger] final flush failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }
}

export function createLogger({ level = 'info', area = '', sinks }: { level?: LogLevel; area?: string; sinks?: LogSink[] } = {}): Logger {
  const min = LEVELS[level] ?? LEVELS.info
  const out: LogSink[] = sinks && sinks.length ? sinks : [createConsoleSink()]

  function emit(lvl: LogLevel, parts: unknown[]): void {
    if ((LEVELS[lvl] ?? 100) < min) return
    const message = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
    const line = formatLine({ level: lvl, area, message })
    out.forEach((s) => s.write(line, lvl))
  }

  return {
    child(opts: { area?: string } = {}) {
      return createLogger({ level, area: opts.area ?? area, sinks: out })
    },
    debug(...parts: unknown[]) {
      emit('debug', parts)
    },
    info(...parts: unknown[]) {
      emit('info', parts)
    },
    warn(...parts: unknown[]) {
      emit('warn', parts)
    },
    error(...parts: unknown[]) {
      emit('error', parts)
    },
    flush() {
      out.forEach((s) => (s.flush ? s.flush() : undefined))
    }
  }
}

