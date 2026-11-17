/**
 * 下载管理器（APPS 侧编排）
 *
 * 职责边界（refactor-main-sink-plan.md Step 4 之后）：
 *   - **本文件只做 Electron 编排**：will-download 事件订阅、DownloadItem 控制、
 *     对话框 / 通知 / shell 副作用。
 *   - 领域逻辑全部在 `@hira-ng/domain-download`：
 *     安全路径（Security）/ 速度估算（SpeedTracker）/ 限速（RateLimiter）/
 *     多线程下载（MultiConnection）/ 危险文件规则（DangerousFiles）。
 *   - 记录持久化在 `createDownloadService`（domain-download，SQLite）。
 */

import { app, BrowserWindow, dialog, net, Notification, shell, type BaseWindow, type DownloadItem, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createFilePort } from '@hira-ng/infra-fs'
import { onWebContentsDestroyed } from '@hira-ng/infra-window'
import {
  createDownloadSecurity,
  createSpeedTracker,
  getGlobalRateLimiter,
  createMcdFactory,
  shouldUseMultiThread,
  isDangerousFile,
  type DownloadRecord,
  type createDownloadService
} from '@hira-ng/domain-download'
import { isHttpUrl } from '@hira-ng/shared-types/src/url-protocols.mjs'
// 下载设置的真源（键名 / 缺省值 / 取值域 / 危险文件策略），见 downloads.mjs。
import {
  DOWNLOAD_SETTING_KEYS,
  DEFAULT_DOWNLOAD_SETTINGS,
  DOWNLOAD_CONNECTION_LIMITS,
  normalizeSafeBrowsing
} from '@hira-ng/shared-types/src/downloads.mjs'

type DownloadService = ReturnType<typeof createDownloadService>
type McdInstance = ReturnType<ReturnType<typeof createMcdFactory>>

interface DownloadSettingsPort {
  get(key: string): unknown
  set?(key: string, value: unknown): unknown
  subscribe?(listener: (change: { key?: string; value?: unknown; scope?: string }) => void): () => void
  on?(event: string, listener: (key: unknown, value: unknown) => void): unknown
}
interface DownloadGuardPayload { webContents: WebContents | null; url: string; filename: string }
interface DownloadStartedPayload extends DownloadGuardPayload { id: string }

interface DownloadManagerOptions {
  downloadsDir?: string
  emit?(route: string, payload: Record<string, unknown>): void
  settingsService?: DownloadSettingsPort | null
  parentWindow?: BrowserWindow | null
  guardDownload?(payload: DownloadGuardPayload): boolean
  onDownloadStarted?(payload: DownloadStartedPayload): void
  resolveSavePath?(input: {
    url: string
    filename: string
    mimeType?: string
    directory: string
  }): { directory: string; filename: string }
  onDownloadCompleted?(input: { id: string; filePath: string; url: string; filename: string }): void
}

interface ActiveDownloadEntry {
  item: DownloadItem | null
  savePath: string
  filename: string
  url: string
  mcd: McdInstance | null
  mcdTmpPath?: string | null
  refererUrl: string
  hostUrl: string
  userPaused: boolean
  userCancelled: boolean
  _finished?: boolean
  _lastReceived?: number
  _mcdDecision?: boolean | Promise<boolean>
  _progressEmittedAt?: number
  _progressLatest?: { received: number; total: number }
}

interface DownloadController {
  activeCount(): number
  pause(id: string): boolean
  resume(id: string): boolean
  cancel(id: string): boolean
  canResume(id: string): boolean
  getSpeedAndETA(id: string): { speed: number; eta: number }
  setRateLimit(bytesPerSec: number): void
  getRateLimit(): number
  getFileIcon(filePath: string, size?: number | string): Promise<string | null>
  retry(id: string): boolean
  dispose(): void
}

const registeredHandlers = new WeakMap<Session, { service: DownloadService; controller: DownloadController }>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 领域端口装配（本模块是 domain 纯逻辑与 Electron 世界之间唯一的桥）
const _filePort = createFilePort()
const _security = createDownloadSecurity({
  filePort: _filePort,
  platform: process.platform
})
const { sanitizeDownloadFilename, safeJoinDownloadPath, uniqueDownloadPath, writeMarkOfTheWeb } = _security

// MCD 端口装配：net → electron net；fileOps → fs fd 原语。
// will-download 里按需调用：先让 Electron 的 item 正常跑，异步 start() 探测；
// 探测通过才接管（改由 MCD 写临时文件），否则什么都不做、Electron 继续下完。
// writeAt 是每数据块一次的热路径：走 fs.write 回调（libuv 线程池），
// 绝不用 fs.writeSync —— 同步写盘会逐块卡主线程（domain 侧已内置串行写链 + 背压）。
const createMultiConnectionDownload = createMcdFactory({
  netPort: { request: (options: { method: string; url: string }) => net.request(options) },
  fileOps: {
    openWriteSync: (p: string) => fs.openSync(p, 'w'),
    truncateSync: (fd: number, len: number) => fs.ftruncateSync(fd, len),
    writeAt: (fd: number, chunk: Buffer, offset: number) => new Promise<void>((resolve, reject) => {
      fs.write(fd, chunk, 0, chunk.length, offset, (err) => (err ? reject(err) : resolve()))
    }),
    closeSync: (fd: number) => fs.closeSync(fd),
    unlinkSync: (p: string) => fs.unlinkSync(p)
  },
  markOfTheWeb: writeMarkOfTheWeb
})

/**
 * 注册下载处理器。
 * @param {import('electron').Session} session
 * @param {object} downloadService  createDownloadService 返回的服务
 * @param {object} [options]
 * @param {string} [options.downloadsDir] 下载目录，默认 app.getPath('downloads')
 * @param {Function} [options.emit] 事件转发函数 (route, payload) => void
 * @param {object} [options.settingsService] 设置服务
 * @param {BrowserWindow} [options.parentWindow] 危险文件确认对话框的父窗口
 * @param {(payload:{webContents:object|null,url:string,filename:string})=>boolean} [options.guardDownload]
 *   站点守卫（自动下载策略）—— 返回 false 时**取消本次下载**。
 *   判定与询问的统一实现在 APPS 层 `site-guard.js`（这样"拦一次、问一次、写进权限表"
 *   与弹窗拦截是同一套规则，不会两处各写一份阈值）。
 * @param {(payload:{webContents:object|null,id:string,filename:string,url:string})=>void} [options.onDownloadStarted]
 *   下载真正开始（已建记录、已进活动表）时的回调 —— 主进程用它自动打开下载面板。
 *   刻意**不在这里直接碰布局**：本文件只认识"下载"，不认识窗口 / 面板（见文件头职责边界）。
 */
function registerDownloadHandler(session: Session, downloadService: DownloadService, options: DownloadManagerOptions = {}): DownloadController {
  const existing = registeredHandlers.get(session)
  if (existing && existing.service === downloadService) return existing.controller
  if (existing) existing.controller.dispose()

  const defaultDir = options.downloadsDir || app.getPath('downloads')
  /**
   * 当前生效的下载目录：优先用设置里的 `downloads.default_location`。
   * 每次下载重新读取 —— 用户在设置页改了目录，下一次下载即生效，无需重启。
   * @returns {string}
   */
  function downloadsDir(): string {
    let v: unknown = ''
    try { v = settingsService ? settingsService.get(DOWNLOAD_SETTING_KEYS.defaultLocation) : '' } catch (_) {}
    if (typeof v === 'string' && v.trim()) return v.trim()
    return defaultDir
  }
  const emit = typeof options.emit === 'function' ? options.emit : () => {}
  const settingsService = options.settingsService || null
  const parentWindow = options.parentWindow || null
  // 站点守卫（自动下载策略）：缺省不判定，行为与改造前一致。
  const guardDownload = typeof options.guardDownload === 'function' ? options.guardDownload : null
  // 下载开始回调（自动打开下载面板）：缺省不动作，本模块不依赖任何窗口/布局。
  const onDownloadStarted = typeof options.onDownloadStarted === 'function' ? options.onDownloadStarted : null
  const resolveSavePath = typeof options.resolveSavePath === 'function' ? options.resolveSavePath : null
  const onDownloadCompleted = typeof options.onDownloadCompleted === 'function' ? options.onDownloadCompleted : null

  // 活动下载项引用：id → { item, savePath, filename, url, mcd, mcdTmpPath, refererUrl, hostUrl, userPaused, userCancelled }
  const activeItems = new Map<string, ActiveDownloadEntry>()
  /**
   * 下载**活动态**广播（rail / navbar 下载红点的唯一数据源）。
   *
   * 只在"有 / 无活动下载"这条布尔**跃迁**时发一次 —— 不是每拍进度都发：
   *   · 第一个下载进活动表 → `{ active: true }`
   *   · 最后一个活动项收尾 → `{ active: false }`
   * 中途的字节进度照旧走 `download:progress`，与本事件互不干扰。
   * 渲染侧因此只需在**收到事件时**切一次 class，可以做到零轮询、零每帧开销。
   *
   * 暂停中的项**仍算活动**（用户口径："红点一直亮到下载完成"）。
   */
  let activityActive = false
  function syncActivity(): void {
    const active = activeItems.size > 0
    if (active === activityActive) return
    activityActive = active
    emit('download:activity', { active })
  }
  // 最近一次发起下载的 webContents：重试(interrupted/cancelled) 时用来重新触发下载，
  // 走同一 will-download → 新 DownloadItem → 新进度流。
  let lastDownloadWebContents: WebContents | null = null
  // 速度跟踪器
  const speedTracker = createSpeedTracker()
  // 全局限速器
  const rateLimiter = getGlobalRateLimiter()
  // MCD 临时文件后缀：MCD 只写这个文件，成功后 rename 覆盖目标，避免与 Electron 双写同一路径
  const MCD_TMP_SUFFIX = '.ngmcd'
  /**
   * 进度「落库 + 广播」的时间窗合并（**两条进度源共用同一口径**）。
   *
   * 两条源都很密：
   *   · MCD —— `resp.on('data')` 每收**一个数据块**就回调一次（几十~几千次/秒）；
   *   · Electron —— `item.on('updated')` 同样按块级频率触发。
   * 而每一次下面都要做两件重活：
   *   ① `downloadService.updateProgress` → better-sqlite3 是**同步**的，等于每块一笔事务；
   *   ② `emit('download:progress')` → 广播，扇出给**每个窗口**的订阅者（下载栏 / 下载面板）。
   * 块速率远高于人眼与数据库需要的量级 —— 按时间窗合并，只把最新值发出去。
   *
   * 记账写在 `entry` 上（下载结束随 `activeItems` 一起消失，无需额外清理）。
   * 状态类事件（started / paused / done / error）**不走这里**，各自即时发出。
   */
  const PROGRESS_EMIT_MIN_MS = 200
  function shouldEmitProgress(entry: ActiveDownloadEntry, received: number, total: number): boolean {
    // 不管这一拍发不发，都记下最新值 —— 完成前要用它补一次「最终值」：
    // 节流可能把最后一段字节吞掉，而下载面板是按 `receivedBytes / totalBytes` 算
    // 百分比的（`totalBytes > 0` 时读比值，不看 state），漏了就会一直显示 99%。
    entry._progressLatest = { received, total }
    const nowMs = Date.now()
    if (nowMs - (entry._progressEmittedAt || 0) < PROGRESS_EMIT_MIN_MS) return false
    entry._progressEmittedAt = nowMs
    return true
  }

  /**
   * 读取多线程下载配置（每次下载现读，改了设置下次下载即生效）。
   * @returns {{ enabled: boolean, connections: number }}
   */
  function readMcdConfig(): { enabled: boolean; connections: number } {
    let enabled = false
    let connections = Number(DEFAULT_DOWNLOAD_SETTINGS[DOWNLOAD_SETTING_KEYS.maxConnections])
    try {
      if (settingsService) {
        enabled = settingsService.get(DOWNLOAD_SETTING_KEYS.multiThreaded) !== false
        const n = Number(settingsService.get(DOWNLOAD_SETTING_KEYS.maxConnections))
        if (Number.isFinite(n) && n >= DOWNLOAD_CONNECTION_LIMITS.min) {
          connections = Math.min(Math.floor(n), DOWNLOAD_CONNECTION_LIMITS.max)
        }
      }
    } catch (_) {}
    return { enabled, connections }
  }

  /**
   * 幂等收尾：从活动表移除并清理速度采样。返回 true 表示本次是首次收尾。
   */
  function finishEntry(id: string, entry: ActiveDownloadEntry): boolean {
    if (entry._finished) return false
    entry._finished = true
    activeItems.delete(id)
    speedTracker.clear(id)
    // 最后一个活动项收尾 → 红点熄灭（内部按布尔跃迁去重，收尾多次也只发一次）。
    syncActivity()
    return true
  }

  /** 事件回调异常也必须收口，不能让 EventEmitter 回调留下永久活动项。 */
  function interruptEntry(id: string, entry: ActiveDownloadEntry, error: unknown): void {
    console.error('[download] handler failed:', errorMessage(error))
    if (!finishEntry(id, entry)) return
    try { downloadService.cancel(id, 'interrupted') } catch (recordError) {
      console.error('[download] failed to persist interruption:', errorMessage(recordError))
    }
    emit('download:done', {
      id,
      state: 'interrupted',
      filename: entry.filename,
      filePath: entry.savePath
    })
  }

  /**
   * Electron 的 DownloadItem 是否已自行结束（完成/取消/中断）。
   * 用于 MCD 探测返回后避免对已下完的任务重复接管。
   */
  function isItemFinished(item: DownloadItem): boolean {
    try {
      if (typeof item.getState === 'function') {
        const s = item.getState()
        if (s === 'completed' || s === 'cancelled' || s === 'interrupted') return true
      }
    } catch (_) {}
    return false
  }

  /**
   * 清理上次异常退出遗留的 MCD 临时文件（`*.ngmcd`）。
   * 仅扫一层目录，避免误删用户文件。
   */
  function sweepMcdTempFiles(dir: string): void {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(MCD_TMP_SUFFIX)) continue
        try { fs.unlinkSync(path.join(dir, name)) } catch (_) {}
      }
    } catch (_) {}
  }

  // 初始化限速配置
  if (settingsService) {
    let limit: unknown = 0
    try { limit = settingsService.get(DOWNLOAD_SETTING_KEYS.rateLimit) } catch (_) {}
    const numericLimit = Number(limit)
    if (Number.isFinite(numericLimit) && numericLimit > 0) rateLimiter.setRate(numericLimit)
  }

  // 确保下载目录存在；并清理上次异常退出遗留的 MCD 临时文件
  try {
    const d = downloadsDir()
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
    else sweepMcdTempFiles(d)
  } catch (e) {
    console.error('[download] failed to create downloads dir:', errorMessage(e))
  }

  let unsubscribeSettings: (() => void) | null = null
  if (settingsService) {
    const applyRateLimit = (): void => {
      let value: unknown = 0
      try { value = settingsService.get(DOWNLOAD_SETTING_KEYS.rateLimit) } catch (_) {}
      rateLimiter.setRate(Number(value) || 0)
    }
    if (typeof settingsService.subscribe === 'function') {
      const off = settingsService.subscribe((change) => {
        if (change.scope === 'all' || change.key === DOWNLOAD_SETTING_KEYS.rateLimit) applyRateLimit()
      })
      if (typeof off === 'function') unsubscribeSettings = off
    } else if (typeof settingsService.on === 'function') {
      const off = settingsService.on('change', (key: unknown) => {
        if (key === DOWNLOAD_SETTING_KEYS.rateLimit) applyRateLimit()
      })
      if (typeof off === 'function') unsubscribeSettings = off as () => void
    }
  }

  /**
   * 下载完成的统一副作用（Electron 单线程路径与 MCD 多线程路径共用）：
   * 落库完成 + 写 MotW + 通知面板 + clear_on_complete + 自动打开。
   */
  function handleDownloadCompleted(id: string, entry: ActiveDownloadEntry): void {
    const savePath = entry.savePath
    const safeName = entry.filename
    // 完成前补一次「最终值」：节流可能吞掉最后一段字节，而面板是按
    // receivedBytes/totalBytes 算百分比的 —— 不补就会停在 99%（见 shouldEmitProgress）。
    const latest = entry._progressLatest
    if (latest && latest.received > 0) {
      try { downloadService.updateProgress(id, latest.received, latest.total || undefined) } catch (_) {}
    }
    try { downloadService.complete(id, savePath) } catch (error) {
      console.error('[download] failed to persist completion:', errorMessage(error))
    }
    // 写 Mark-of-the-Web
    try {
      writeMarkOfTheWeb(savePath, { referrerUrl: entry.refererUrl, hostUrl: entry.hostUrl })
    } catch (error) {
      console.error('[download] failed to write mark-of-the-web:', errorMessage(error))
    }
    emit('download:done', { id, state: 'completed', filename: safeName, filePath: savePath })
    if (onDownloadCompleted) {
      try {
        onDownloadCompleted({
          id,
          filePath: savePath,
          url: entry.url,
          filename: entry.filename
        })
      } catch (error) {
        console.warn('[download] completion verification failed:', errorMessage(error))
      }
    }
    console.log(`[download] completed: ${safeName} -> ${savePath}`)
    // 完成后即时清理下载记录（设置项 downloads.clear_on_complete）。
    // 放在 emit 之后：先让面板收到完成事件，再把记录从库里摘掉，
    // 面板下一次重列时该条目自然消失 —— 语义就是「完成即从列表移除」。
    if (settingsService && settingsService.get(DOWNLOAD_SETTING_KEYS.clearOnComplete) === true) {
      try { downloadService.remove(id) } catch (e) {
        console.error('[download] clear_on_complete failed:', errorMessage(e))
      }
    }
    // 下载完成通知
    const showNotification = settingsService ? settingsService.get(DOWNLOAD_SETTING_KEYS.showNotification) : false
    if (showNotification && Notification.isSupported()) {
      try {
        const notif = new Notification({ title: '下载完成', body: safeName, silent: false })
        notif.on('click', () => {
          void shell.openPath(savePath).catch((error) => {
            console.error('[download] open completed file failed:', errorMessage(error))
          })
        })
        notif.show()
      } catch (e) {
        console.error('[download] notification failed:', errorMessage(e))
      }
    }
    // 自动打开
    const openWhenDone = settingsService ? settingsService.get(DOWNLOAD_SETTING_KEYS.openWhenDone) : false
    if (openWhenDone) {
      void shell.openPath(savePath).catch((error) => {
        console.error('[download] open completed file failed:', errorMessage(error))
      })
    }
  }

  /**
   * MCD 事件桥：把多连接引擎的事件翻译成与 Electron DownloadItem 完全一致的外部行为
   * （downloadService 落库 + download:progress / download:done 事件 + 完成副作用）。
   * MCD 写的是临时文件 `savePath + .ngmcd`，完成后原子 rename 覆盖目标路径。
   */
  function onMcdEvent(id: string, entry: ActiveDownloadEntry, event: string, payload: Record<string, unknown>): void {
    const tmpPath = entry.mcdTmpPath || ''
    if (event === 'started') {
      emit('download:progress', {
        id, url: entry.url, filename: entry.filename,
        receivedBytes: 0, totalBytes: (payload && payload.totalBytes) || 0,
        state: 'in_progress', speed: 0, eta: 0,
        connections: (payload && payload.connections) || 0
      })
      return
    }
    if (event === 'progress') {
      const received = Number(payload.receivedBytes) || 0
      const total = Number(payload.totalBytes) || 0
      if (payload && payload.state === 'paused') {
        downloadService.pause(id)
        emit('download:progress', {
          id, url: entry.url, filename: entry.filename,
          receivedBytes: received, totalBytes: total,
          state: 'paused', speed: 0, eta: 0
        })
        return
      }
      // 进度按时间窗合并（MCD 每块回调一次，见 shouldEmitProgress 的说明）
      if (!shouldEmitProgress(entry, received, total)) return
      speedTracker.updateSample(id, received)
      const etaInfo = speedTracker.getETA(id, received, total, entry.userPaused)
      downloadService.updateProgress(id, received, total || undefined)
      emit('download:progress', {
        id, url: entry.url, filename: entry.filename,
        receivedBytes: received, totalBytes: total,
        state: 'in_progress', speed: etaInfo.speed, eta: etaInfo.eta
      })
      return
    }
    if (event === 'done') {
      if (!finishEntry(id, entry)) return // 已收尾过，忽略重复事件
      if (payload && payload.state === 'completed') {
        // 临时文件原子替换到目标路径（NTFS 上 Zone.Identifier 随 rename 保留）
        try {
          fs.renameSync(tmpPath, entry.savePath)
        } catch (e) {
          console.error('[download] mcd rename failed:', errorMessage(e))
        }
        handleDownloadCompleted(id, entry)
      } else {
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        downloadService.cancel(id, 'cancelled')
        emit('download:done', { id, state: 'cancelled', filename: entry.filename, filePath: entry.savePath })
      }
      return
    }
    if (event === 'error') {
      if (!finishEntry(id, entry)) return
      try { fs.unlinkSync(tmpPath) } catch (_) {}
      downloadService.cancel(id, 'interrupted')
      emit('download:done', { id, state: 'interrupted', filename: entry.filename, filePath: entry.savePath })
    }
  }

  /**
   * 尝试用 MCD 接管下载。
   * 返回 true：已接管（Electron 的 item 已被取消，收尾交给 MCD 事件流）。
   * 返回 false：放弃接管，调用方按原流程继续（Electron 下完 / 或自行失败）。
   * 探测阶段把事件回调锁住（committed=false），避免放弃时误触发收尾事件。
   */
  async function takeoverMcd(id: string, entry: ActiveDownloadEntry, item: DownloadItem, connections: number): Promise<boolean> {
    const tmpPath = entry.savePath + MCD_TMP_SUFFIX
    let mcd = null
    let committed = false
    try {
      mcd = createMultiConnectionDownload({
        url: entry.url,
        savePath: tmpPath,
        connections,
        rateLimiter,
        emit: (ev, payload) => { if (committed) onMcdEvent(id, entry, ev, payload) }
      })
      const ok = await mcd.start()
      if (!ok) {
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        return false
      }
      // 探测期间 Electron 可能已自行下完/被取消：放弃接管，保留其成果
      // （cancel 返回 Promise：等写队列排空关 fd 后再删临时文件，避免句柄占用）
      if (entry.userCancelled || isItemFinished(item)) {
        try { await mcd.cancel() } catch (_) {}
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        return false
      }
      entry.mcd = mcd
      entry.mcdTmpPath = tmpPath
      committed = true
      // 停掉 Electron 侧下载，避免继续写目标路径（双写同一路径会互相破坏）
      try { item.cancel() } catch (_) {}
      return true
    } catch (e) {
      console.error('[download] mcd takeover failed:', errorMessage(e))
      if (mcd) { try { await mcd.cancel() } catch (_) {} }
      try { fs.unlinkSync(tmpPath) } catch (_) {}
      return false
    }
  }

  const onWillDownload = (_event: unknown, item: DownloadItem, webContents: WebContents | undefined): void => {
    let activeId: string | null = null
    let activeEntry: ActiveDownloadEntry | null = null
    void (async () => {
    const url = item.getURL()
    if (webContents && !webContents.isDestroyed && !webContents.isDestroyed()) {
      if (lastDownloadWebContents !== webContents) {
        lastDownloadWebContents = webContents
        try {
          onWebContentsDestroyed(webContents, () => {
            if (lastDownloadWebContents === webContents) lastDownloadWebContents = null
          })
        } catch (_) {}
      }
    }
    const originalFilename = item.getFilename()
    const totalBytes = item.getTotalBytes()
    const mimeType = item.getMimeType()
    const referrerUrl = (webContents && typeof webContents.getURL === 'function') ? webContents.getURL() : ''

    // 危险文件策略（downloads.safe_browsing）：off 不检查 / reject 自动拒绝 / prompt 仅标记。
    // 已按要求移除「是否继续下载」的二次确认对话框：prompt 与 off 一样直接下载
    // （仍会在记录里标记为危险文件），仅 reject 保留真正的「自动拒绝」拦截能力。
    // normalizeSafeBrowsing 一并兼容旧布尔值（true → prompt）与手改的非法值。
    const safeBrowsing = settingsService
      ? normalizeSafeBrowsing(settingsService.get(DOWNLOAD_SETTING_KEYS.safeBrowsing))
      : normalizeSafeBrowsing(undefined)
    const dangerousMime = /^application\/(?:x-msdownload|x-msi|x-msdos-program|x-dosexec|vnd\.microsoft\.portable-executable)$/i
      .test(String(mimeType || ''))
    const dangerousFile = isDangerousFile(originalFilename) || dangerousMime
    if (safeBrowsing === 'reject' && dangerousFile) {
      // 自动拒绝：拦截能力保留，直接取消危险下载
      item.cancel()
      return
    }
    if (safeBrowsing === 'prompt' && dangerousFile) {
      try { item.pause() } catch (_) {}
      const owner = webContents ? BrowserWindow.fromWebContents(webContents) : null
      let sourceHost = url
      try { sourceHost = new URL(url).hostname || url } catch {}
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '危险文件',
        message: `“${originalFilename}”可能危害你的设备`,
        detail: `来源：${sourceHost}\n请只在你明确信任文件来源时继续。`,
        buttons: ['取消下载', '仍然下载'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      let response = 0
      try {
        const result = owner && !owner.isDestroyed()
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options)
        response = result.response
      } catch {}
      if (response !== 1) {
        item.cancel()
        return
      }
      try { item.resume() } catch (_) {}
    }

    // ── 站点守卫（自动下载）────────────────────────────────────────────
    // 同一站点短时间内接连触发多次下载（脚本批量拉文件）→ 拦下本次并登记询问
    // （类型 `automatic-downloads`，进权限表、走同一个询问浮层）。
    // 位置刻意在危险文件之后：已判危险的文件无论如何都不下，不必再问一次。
    // 必须在**创建记录 / 选路径之前**：被拦下的下载不该在列表里留下一条"已取消"。
    if (guardDownload && !guardDownload({ webContents: webContents ?? null, url, filename: originalFilename })) {
      item.cancel()
      return
    }

    const dir = downloadsDir()
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
    // 安全文件名 + 安全路径拼接
    let resolved = safeJoinDownloadPath(dir, originalFilename)
    if (resolveSavePath) {
      try {
        const organized = resolveSavePath({ url, filename: originalFilename, mimeType, directory: dir })
        if (organized) {
          fs.mkdirSync(organized.directory, { recursive: true })
          resolved = safeJoinDownloadPath(organized.directory, organized.filename)
        }
      } catch (error) {
        console.warn('[download] organizer failed:', errorMessage(error))
      }
    }
    const safeName = resolved.safeName
    let savePath = resolved.path

    // 保存路径选择
    const askWhereToSave = settingsService ? settingsService.get(DOWNLOAD_SETTING_KEYS.askWhereToSave) : false
    if (askWhereToSave) {
      const ownerWindow = webContents && !webContents.isDestroyed() ? BrowserWindow.fromWebContents(webContents) : null
      const parent = (parentWindow || ownerWindow) as BaseWindow | null
      const dialogOptions = {
        title: '保存下载文件',
        defaultPath: safeName,
        filters: [{ name: '所有文件', extensions: ['*'] }]
      }
      const result = parent
        ? await dialog.showSaveDialog(parent, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      if (result.canceled || !result.filePath) {
        item.cancel()
        return
      }
      savePath = result.filePath
    } else {
      savePath = uniqueDownloadPath(path.dirname(resolved.path), safeName)
    }
    item.setSavePath(savePath)

    // 创建下载记录
    const id = downloadService.create({
      url,
      filename: safeName,
      totalBytes: totalBytes || undefined,
      mimeType
    })
    activeId = id

    // 危险文件标记
    if (dangerousFile || isDangerousFile(safeName)) {
      downloadService.setDanger(id, 'suspicious')
    }

    // 缓存 item 引用
    const entry: ActiveDownloadEntry = {
      item,
      savePath,
      filename: safeName,
      url,
      mcd: null,            // MCD 实例：非空 = 多线程已接管
      mcdTmpPath: '',       // MCD 落盘的临时文件路径（成功后 rename 覆盖 savePath）
      refererUrl: referrerUrl,
      hostUrl: url,
      userPaused: false,
      userCancelled: false  // 探测期间用户取消，takeoverMcd 据此放弃接管
    }
    activeEntry = entry
    activeItems.set(id, entry)
    // 活动态跃迁 → 红点亮起（首个下载才发，后续并发下载不重复广播）
    syncActivity()

    // 通知 renderer 下载开始
    emit('download:progress', {
      id,
      url,
      filename: safeName,
      receivedBytes: 0,
      totalBytes: totalBytes || 0,
      state: 'in_progress',
      speed: 0,
      eta: 0
    })

    // 下载面板自动打开（选边策略在 download-panel-opener.js，窗口/目录由 main.js 注入）。
    // 放在记录与活动态之后：面板打开时拉 `download:list` 一定能看到这一条。
    if (onDownloadStarted) {
      try { onDownloadStarted({ webContents: webContents ?? null, id, filename: safeName, url }) } catch (_) {}
    }

    // 多线程下载（MCD）：仅当开关开启 + 是 http(s) 直链 + 非「另存为」路径时尝试。
    // 关键：先让 Electron 的 item 正常跑，异步探测；探测未通过就什么都不做，
    // 由 Electron 继续下完 —— 避免重取丢 Referer/UA 导致 403。
    // 探测通过则接管（改由 MCD 写临时文件，成功后 rename 覆盖目标路径）。
    const mcdCfg = readMcdConfig()
    if (mcdCfg.enabled && !askWhereToSave && shouldUseMultiThread(url)) {
      entry._mcdDecision = takeoverMcd(id, entry, item, mcdCfg.connections)
    }

    // 限速背压：监听 updated，当令牌不足时 pause，下个 tick resume
    let throttled = false
    item.on('updated', (_e, state) => {
      try {
        if (entry.mcd) return // MCD 已接管，进度完全由 MCD 事件流驱动
        if (state === 'progressing') {
          const received = item.getReceivedBytes()
          const total = item.getTotalBytes()

          // 限速：尝试消费 delta 字节。
          // 这段**必须**每事件都算（delta 是差分，合并会漏消费 / 误判），所以放在节流之前。
          const lastReceived = entry._lastReceived || 0
          const delta = received - lastReceived
          entry._lastReceived = received
          if (delta > 0 && rateLimiter.getRate() > 0) {
            const res = rateLimiter.tryConsume(delta)
            if (res === 'throttle' && !throttled && !entry.userPaused) {
              throttled = true
              const canPause = (item as DownloadItem & { canPause?(): boolean }).canPause
              try {
                if (typeof canPause !== 'function' || canPause.call(item)) {
                  item.pause()
                  rateLimiter.onNextTick(() => {
                    try {
                      if (entry.userPaused || entry.item !== item) return
                      if (item.canResume()) item.resume()
                    } catch (error) {
                      console.error('[download] throttled resume failed:', errorMessage(error))
                    } finally {
                      throttled = false
                    }
                  }, Math.max(1, delta))
                } else {
                  throttled = false
                }
              } catch (_) {
                throttled = false
              }
            }
          }

          // 落库 + 广播按时间窗合并（与 MCD 那条源同一口径，见 shouldEmitProgress）
          if (!shouldEmitProgress(entry, received, total)) return
          speedTracker.updateSample(id, received)
          const etaInfo = speedTracker.getETA(id, received, total, entry.userPaused)
          downloadService.updateProgress(id, received, total || undefined)
          emit('download:progress', {
            id,
            url,
            filename: safeName,
            receivedBytes: received,
            totalBytes: total || 0,
            state: 'in_progress',
            speed: etaInfo.speed,
            eta: etaInfo.eta
          })
        } else if (state === 'interrupted') {
          if (!finishEntry(id, entry)) return
          try { downloadService.cancel(id, 'interrupted') } catch (error) {
            console.error('[download] failed to persist interruption:', errorMessage(error))
          }
          emit('download:done', { id, state: 'interrupted', filename: safeName, filePath: savePath })
        }
      } catch (error) {
        interruptEntry(id, entry, error)
      }
    })

    item.once('done', (_e, state) => {
      void (async () => {
        // MCD 已接管：忽略 Electron 的收尾，由 MCD 事件流负责
        if (entry.mcd) return
        // MCD 仍在探测：等决策结果，避免与 MCD 收尾相互打架
        if (entry._mcdDecision) {
          let taken = false
          try { taken = await entry._mcdDecision } catch (_) {}
          if (taken) return
        }
        if (!finishEntry(id, entry)) return
        if (state === 'completed') {
          handleDownloadCompleted(id, entry)
        } else {
          downloadService.cancel(id, state)
          emit('download:done', { id, state, filename: safeName, filePath: savePath })
          console.log(`[download] ${state}: ${safeName}`)
        }
      })().catch((error) => {
        if (entry._finished) {
          console.error('[download] completion handler failed:', errorMessage(error))
          return
        }
        interruptEntry(id, entry, error)
      })
    })
    })().catch((error) => {
      if (activeId && activeEntry) {
        interruptEntry(activeId, activeEntry, error)
        return
      }
      console.error('[download] will-download failed:', errorMessage(error))
      try { item.cancel() } catch (_) {}
    })
  }
  session.on('will-download', onWillDownload)

  console.log(`[download] handler registered, dir=${downloadsDir()}, rateLimit=${rateLimiter.getRate() || 'unlimited'}`)

  // 返回控制接口
  const controller: DownloadController = {
    /**
     * 当前活动下载数（>0 = 有下载在跑）。
     *
     * 给渲染侧做**启动初始态**用：事件（download:activity）只在跃迁时发，
     * 而 renderer 视图可能晚于下载开始才订阅 —— 订阅后补一次本函数即可收敛，
     * 不需要任何轮询。
     */
    activeCount() {
      return activeItems.size
    },
    /**
     * 暂停下载
     */
    pause(id: string) {
      const entry = activeItems.get(id)
      if (!entry) return false
      // MCD 接管：走 MCD 控制，进度 / 落库由 MCD 事件流回填
      if (entry.mcd) {
        try {
          entry.userPaused = true
          entry.mcd.pause()
          return true
        } catch (e) {
          console.error('[download] mcd pause failed:', errorMessage(e))
          return false
        }
      }
      if (!entry.item) return false
      try {
        entry.userPaused = true
        entry.item.pause()
        downloadService.pause(id)
        emit('download:progress', {
          id,
          url: entry.url,
          filename: entry.filename,
          receivedBytes: entry.item.getReceivedBytes(),
          totalBytes: entry.item.getTotalBytes() || 0,
          state: 'paused',
          speed: 0,
          eta: 0
        })
        return true
      } catch (e) {
        console.error('[download] pause failed:', errorMessage(e))
        return false
      }
    },

    /**
     * 恢复暂停的下载
     */
    resume(id: string) {
      const entry = activeItems.get(id)
      if (!entry) return false
      // MCD 接管
      if (entry.mcd) {
        try {
          if (!entry.mcd.isPaused()) return false
          entry.userPaused = false
          entry.mcd.resume()
          downloadService.resume(id)
          emit('download:progress', {
            id,
            url: entry.url,
            filename: entry.filename,
            receivedBytes: entry.mcd.getReceivedBytes(),
            totalBytes: entry.mcd.getTotalBytes() || 0,
            state: 'in_progress',
            speed: 0,
            eta: 0
          })
          return true
        } catch (e) {
          console.error('[download] mcd resume failed:', errorMessage(e))
          return false
        }
      }
      if (!entry.item) return false
      try {
        if (entry.item.canResume()) {
          entry.userPaused = false
          entry.item.resume()
          downloadService.resume(id)
          emit('download:progress', {
            id,
            url: entry.url,
            filename: entry.filename,
            receivedBytes: entry.item.getReceivedBytes(),
            totalBytes: entry.item.getTotalBytes() || 0,
            state: 'in_progress',
            speed: 0,
            eta: 0
          })
          return true
        }
        return false
      } catch (e) {
        console.error('[download] resume failed:', errorMessage(e))
        return false
      }
    },

    /**
     * 取消下载
     */
    cancel(id: string) {
      const entry = activeItems.get(id)
      if (!entry) return false
      // MCD 接管：mcd.cancel() 会触发 done 事件，收尾在事件流里完成
      if (entry.mcd) {
        try {
          entry.mcd.cancel()
          return true
        } catch (e) {
          console.error('[download] mcd cancel failed:', errorMessage(e))
          return false
        }
      }
      if (!entry.item) return false
      // 探测中：标记用户取消，takeoverMcd 会据此放弃接管
      entry.userCancelled = true
      try {
        entry.item.cancel()
        if (!finishEntry(id, entry)) return true
        downloadService.cancel(id, 'cancelled')
        emit('download:done', {
          id,
          state: 'cancelled',
          filename: entry.filename,
          filePath: entry.savePath
        })
        return true
      } catch (e) {
        console.error('[download] cancel failed:', errorMessage(e))
        return false
      }
    },

    /**
     * 判断下载项是否可恢复
     */
    canResume(id: string) {
      const entry = activeItems.get(id)
      if (!entry) return false
      if (entry.mcd) return !!(entry.mcd.canResume && entry.mcd.canResume())
      return !!(entry.item && entry.item.canResume && entry.item.canResume())
    },

    /**
     * 获取下载项的速度和 ETA
     */
    getSpeedAndETA(id: string) {
      const entry = activeItems.get(id)
      if (!entry) return { speed: 0, eta: 0 }
      const received = entry.mcd ? entry.mcd.getReceivedBytes() : (entry.item ? entry.item.getReceivedBytes() : 0)
      const total = entry.mcd ? entry.mcd.getTotalBytes() : (entry.item ? entry.item.getTotalBytes() : 0)
      return speedTracker.getETA(id, received, total, entry.userPaused)
    },

    /**
     * 设置全局下载限速
     */
    setRateLimit(bytesPerSec: number) {
      rateLimiter.setRate(bytesPerSec || 0)
      if (settingsService && typeof settingsService.set === 'function') {
        settingsService.set(DOWNLOAD_SETTING_KEYS.rateLimit, bytesPerSec || 0)
      }
    },

    /**
     * 获取当前限速
     */
    getRateLimit() {
      return rateLimiter.getRate()
    },

    /**
     * 为指定文件路径获取系统图标（PNG dataURL）
     *
     * `size` 对调用方仍是**像素数**（面板 / 下载栏都按 16 / 32 说话），
     * 到这一个函数里才翻译成 Electron 的枚举 —— Electron 只认
     * `'small' | 'normal' | 'large'`（FileIconOptions），传数字属于未定义输入：
     * 轻则静默回落到 normal（32×32 再被 CSS 缩到 16px，图标发虚），
     * 重则在版本升级后直接 reject。IPC 语义因此不必知道 Electron 的枚举词。
     */
    getFileIcon(filePath: string, size: number | string = 16) {
      if (!filePath) return Promise.resolve(null)
      const iconSize = typeof size === 'number' || /^\d+$/.test(String(size))
        ? (Number(size) <= 16 ? 'small' : (Number(size) <= 32 ? 'normal' : 'large'))
        : (size === 'normal' || size === 'large' ? size : 'small')
      try {
        // Electron 的 API 是 `app.getFileIcon(path, { size })`（返回 Promise<NativeImage>）——
        // 曾经写成不存在的 `getFileIconAsync`，同步抛出的 TypeError 被 catch 吞掉，
        // 于是所有下载项永远拿不到系统图标（面板只能回落到扩展名图标）。
        return Promise.resolve(app.getFileIcon(filePath, { size: iconSize }))
          .then((img) => (img && typeof img.toDataURL === 'function' ? img.toDataURL() : null))
          .catch(() => null)
      } catch (_) {
        return Promise.resolve(null)
      }
    },

    /**
     * 重试失败的下载：以原 URL 重新触发一次下载（走 will-download → 新记录）。
     * 仅对非活动记录（interrupted/cancelled）有意义；无可用 webContents 返回 false。
     */
    retry(id: string) {
      let rec = null
      try { rec = downloadService.get(id) } catch (_) { return false }
      const retryUrl = rec && rec.url ? String(rec.url) : ''
      if (!isHttpUrl(retryUrl)) return false
      const wc = lastDownloadWebContents
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false
      try {
        wc.downloadURL(retryUrl)
        return true
      } catch (e) {
        console.error('[download] retry failed:', errorMessage(e))
        return false
      }
    },

    /** 摘掉本 session 的 will-download 与设置订阅；不取消已经开始的下载。 */
    dispose() {
      try { session.removeListener('will-download', onWillDownload) } catch (_) {}
      try { unsubscribeSettings?.() } catch (_) {}
      unsubscribeSettings = null
      if (registeredHandlers.get(session)?.controller === controller) registeredHandlers.delete(session)
    }
  }
  registeredHandlers.set(session, { service: downloadService, controller })
  return controller
}

module.exports = {
  registerDownloadHandler,
  isDangerousFile
}
