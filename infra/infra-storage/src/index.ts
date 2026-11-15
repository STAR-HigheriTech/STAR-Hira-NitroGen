import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import chokidar, { type FSWatcher } from 'chokidar'
import writeFileAtomic from 'write-file-atomic'
import { z, type ZodType } from 'zod'

export interface JsonStoreOptions<T> {
  saveDelayMs?: number
  schema?: ZodType<T>
}

export interface CrossWinSyncerOptions {
  pollIntervalMs?: number
  stabilityThresholdMs?: number
  usePolling?: boolean
}

export type ChangeListener = () => void

async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true })
}

export async function readJsonFile<T>(filePath: string, fallbackValue: T): Promise<T>
export async function readJsonFile<T = unknown>(filePath: string): Promise<T>
export async function readJsonFile<T = unknown>(filePath: string, fallbackValue?: T): Promise<T> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (e) {
    if (fallbackValue !== undefined) return fallbackValue
    throw e
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown, { space = 2 }: { space?: number } = {}): Promise<void> {
  const text = JSON.stringify(value, null, space)
  await ensureDir(path.dirname(filePath))
  await writeFileAtomic(filePath, text, { encoding: 'utf8' })
}

export class JsonStore<T> {
  private readonly _filePath: string
  private readonly _saveDelayMs: number
  private readonly _schema: ZodType<T> | null
  private _pendingTimer: ReturnType<typeof setTimeout> | null = null
  private _pendingData: string | null = null
  private _lastSerialized: string | null = null
  private _lastValue: T | null = null
  /** 同一文件的异步落盘严格串行；否则旧快照可能晚于新快照完成并覆盖它。 */
  private _writeTail: Promise<void> = Promise.resolve()

  constructor(filePath: string, options: JsonStoreOptions<T> = {}) {
    if (!filePath) throw new Error('filePath is required')
    this._filePath = filePath
    this._saveDelayMs = options.saveDelayMs ?? 200
    this._schema = options.schema || null
  }

  async read({ fallback = null }: { fallback?: T | null } = {}): Promise<T | null> {
    const value = await readJsonFile<T | null>(this._filePath, fallback)
    const parsed = this._schema ? this._schema.parse(value) : value
    this._lastValue = parsed
    this._lastSerialized = JSON.stringify(parsed)
    return parsed
  }

  write(value: T): void {
    const parsed = this._schema ? this._schema.parse(value) : value
    const data = JSON.stringify(parsed)
    this._lastValue = parsed

    if (data === this._lastSerialized && this._pendingTimer == null) return

    this._pendingData = data
    if (this._pendingTimer) clearTimeout(this._pendingTimer)
    this._pendingTimer = setTimeout(() => {
      const toWrite = this._pendingData
      this._pendingData = null
      this._pendingTimer = null
      if (toWrite === null) return
      void this._enqueueWrite(toWrite).then(() => {
        this._lastSerialized = toWrite
      }).catch(() => {
        // flush() 会再次等待这条队列并向上报告；后台延迟写不能制造未处理拒绝。
      })
    }, this._saveDelayMs)
  }

  async flush(): Promise<void> {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer)
      this._pendingTimer = null
    }
    const pending = this._pendingData
    this._pendingData = null
    if (pending != null) {
      await this._enqueueWrite(pending)
      this._lastSerialized = pending
      return
    }
    await this._writeTail
  }

  private _enqueueWrite(serialized: string): Promise<void> {
    const task = this._writeTail.catch(() => {}).then(() => this._writeInternal(serialized))
    this._writeTail = task
    return task
  }

  private async _writeInternal(serialized: string): Promise<void> {
    await ensureDir(path.dirname(this._filePath))
    await writeFileAtomic(this._filePath, serialized, { encoding: 'utf8' })
  }
}

export class CrossWinSyncer {
  readonly ready: Promise<void>
  private readonly _filePath: string
  private readonly _listeners = new Set<ChangeListener>()
  private readonly _pollIntervalMs: number
  private _pollTimer: ReturnType<typeof setInterval> | null = null
  private _pollSignature: string | null = null
  private readonly _watcher: FSWatcher | null
  private _closed = false
  private _pollInFlight: Promise<void> | null = null
  private _resolveReady: (() => void) | null = null
  private _closePromise: Promise<void> | null = null

  constructor(filePath: string, options: CrossWinSyncerOptions = {}) {
    if (!filePath) throw new Error('filePath is required')
    this._filePath = path.resolve(filePath)
    const pollIntervalMs = Number(options.pollIntervalMs)
    this._pollIntervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 100
    this._watcher = options.usePolling
      ? null
      : chokidar.watch(path.dirname(this._filePath), {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: options.stabilityThresholdMs ?? 100,
          pollInterval: this._pollIntervalMs
        }
      })
    const watcher = this._watcher
    this.ready = watcher
      ? new Promise<void>((resolve) => {
        const settle = (): void => {
          if (!this._resolveReady) return
          this._resolveReady = null
          resolve()
        }
        this._resolveReady = settle
        watcher.once('ready', settle)
        watcher.on('error', (error) => {
          if (this._closed) return
          this._report('watch failed', error)
          void watcher.close().catch(() => {})
          this._startPolling()
          settle()
        })
      })
      : this._startPolling()

    const onChange = (changedPath: string): void => {
      if (path.resolve(changedPath) !== this._filePath) return
      this._emitChange()
    }

    if (watcher) {
      watcher.on('add', onChange)
      watcher.on('change', onChange)
      watcher.on('unlink', onChange)
    }
  }

  private _report(label: string, error: unknown): void {
    console.warn(`[storage] ${label}:`, error instanceof Error ? error.message : error)
  }

  private _startPolling(): Promise<void> {
    if (this._closed || this._pollTimer) return Promise.resolve()
    return this._readSignature()
      .catch((error) => {
        this._report('read signature failed', error)
        return null
      })
      .then((signature) => {
        if (this._closed || this._pollTimer) return
        this._pollSignature = signature
        this._pollTimer = setInterval(() => {
          void this._poll()
        }, this._pollIntervalMs)
        this._pollTimer.unref?.()
      })
  }

  private async _readSignature(): Promise<string | null> {
    try {
      const [stat, content] = await Promise.all([
        fsp.stat(this._filePath),
        fsp.readFile(this._filePath)
      ])
      const hash = crypto.createHash('sha1').update(content).digest('hex')
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${hash}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private _poll(): Promise<void> {
    if (this._closed) return Promise.resolve()
    if (this._pollInFlight) return this._pollInFlight
    this._pollInFlight = (async () => {
      try {
        const signature = await this._readSignature()
        if (this._closed || signature === this._pollSignature) return
        this._pollSignature = signature
        this._emitChange()
      } catch (error) {
        this._report('poll failed', error)
      } finally {
        this._pollInFlight = null
      }
    })()
    return this._pollInFlight
  }

  private _emitChange(): void {
    if (this._closed) return
    for (const listener of Array.from(this._listeners)) {
      try {
        listener()
      } catch (error) {
        this._report('change listener failed', error)
      }
    }
  }

  subscribe(cb: ChangeListener): () => boolean {
    this._listeners.add(cb)
    return () => this._listeners.delete(cb)
  }

  close(): Promise<void> {
    if (this._closePromise) return this._closePromise
    if (this._closed) return Promise.resolve()
    this._closed = true
    this._closePromise = (async () => {
      this._resolveReady?.()
      this._resolveReady = null
      if (this._pollTimer) {
        clearInterval(this._pollTimer)
        this._pollTimer = null
      }
      if (this._watcher) {
        try {
          await this._watcher.close()
        } catch (error) {
          this._report('watcher close failed', error)
        }
      }
      if (this._pollInFlight) {
        try {
          await this._pollInFlight
        } catch (_) {}
      }
      this._listeners.clear()
    })()
    return this._closePromise
  }
}

export function zJson<T>(schema: ZodType<T>): ZodType<T> {
  return z.custom<T>((value) => schema.parse(value))
}

export { z }
