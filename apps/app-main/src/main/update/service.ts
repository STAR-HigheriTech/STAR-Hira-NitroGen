/**
 * update/service.js — 自动更新服务（唯一真源）
 *
 * 设计目标（与产品口径一一对应）：
 *   · **静默、低频、不阻塞**：默认每 2 个月（1440h）检查一次，启动后延迟 60s 才首次联网，
 *     定时器全部 `unref()`，`electron-updater` **懒加载**（未打包的构建根本不 require）。
 *   · **双通道**：stable → `latest.yml`，preview → `preview.yml` + 预发布语义。
 *     发布侧必须在 release 资产里带上对应 yml（`electron-builder --publish never` 时也会生成；
 *     preview 通道打包需 `publish.channel=preview`，详见 scripts/pack-win.cjs 的说明）。
 *   · **原地覆盖升级**：`autoDownload=false` + `autoInstallOnAppQuit=false`，
 *     只有用户显式点「重启并安装」才 `quitAndInstall(false, true)` —— isSilent=false
 *     走 NSIS 交互式安装器（保留上次安装路径），isForceRunAfter=true 装完自动拉起。
 *
 * 分层：本文件只依赖 electron + 设置服务 + 一个广播出口，不认识 IPC/窗口/渲染层；
 * IPC 注册器（ipc/update.ts）与页面都只是它的消费者。
 *
 * 状态机（整体快照，订阅方不得轮询）：
 *   unsupported → idle → checking → { up-to-date | available → downloading → downloaded | error }
 */

import { app } from 'electron'
// 打包态 / 开发态唯一判据（见 app/runtime-mode.js）：更新只在正式包可用。
import { isPackagedRuntime } from '../app/runtime-mode'
import { IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
// 偏好键名 / 缺省值 / 通道 id / 周期护栏的唯一真源（域层默认值与关于页面板同源）。
import {
  UPDATE_SETTING_KEYS,
  UPDATE_CHANNEL_IDS,
  DEFAULT_UPDATE_SETTINGS,
  UPDATE_INTERVAL_LIMITS
} from '@hira-ng/shared-types/src/update-settings.mjs'

type AppUpdater = import('electron-updater').AppUpdater

/** 状态枚举（IPC 契约、设置页文案、页面渲染共用这一份取值）。 */
const STATUS = Object.freeze({
  unsupported: 'unsupported',
  idle: 'idle',
  checking: 'checking',
  upToDate: 'up-to-date',
  available: 'available',
  downloading: 'downloading',
  downloaded: 'downloaded',
  error: 'error'
} as const)

type UpdateStatus = (typeof STATUS)[keyof typeof STATUS]
type UpdateChannelId = (typeof UPDATE_CHANNEL_IDS)[keyof typeof UPDATE_CHANNEL_IDS]

interface UpdateState {
  supported: boolean
  status: UpdateStatus
  currentVersion: string
  channel: UpdateChannelId
  availableVersion: string
  progress: number
  transferred: number
  total: number
  bytesPerSecond: number
  lastCheckAt: number
  message: string
  error: string
}

interface SettingsChange { key?: string; value?: unknown }

export interface UpdateSettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
  subscribe?(listener: (change: SettingsChange | null | undefined) => void): (() => void) | void
}

export interface UpdateServiceDependencies {
  settingsService?: UpdateSettingsPort | null
  emit?(route: string, payload: unknown, options?: unknown): void
}

/**
 * 通道 → electron-updater 参数映射。
 *
 * 为什么 stable 要显式写 `channel='latest'`：GitHubProvider 的默认通道名就是 latest，
 * 但显式写死可以避免 `updater.channel` 残留上一次的 preview（切换通道时同一个实例复用）。
 * ⚠ `AppUpdater#set channel` 会把 `allowDowngrade` 强制置 true（防降级被顺手打开），
 *   所以每次设置完通道都要显式复位（见 applyChannel）。
 */
const CHANNEL_PROFILES: Readonly<Record<UpdateChannelId, Readonly<{
  id: UpdateChannelId
  updaterChannel: string
  allowPrerelease: boolean
}>>> = Object.freeze({
  [UPDATE_CHANNEL_IDS.stable]: Object.freeze({
    id: UPDATE_CHANNEL_IDS.stable, updaterChannel: 'latest', allowPrerelease: false
  }),
  [UPDATE_CHANNEL_IDS.preview]: Object.freeze({
    id: UPDATE_CHANNEL_IDS.preview, updaterChannel: 'preview', allowPrerelease: true
  })
})

/** 设置键（只在这里出现一次，避免"某处写错一个字符串"）。 */
const KEYS = UPDATE_SETTING_KEYS
/** 合法键集合（设置变更入口按它过滤，避免 `startsWith('update.')` 这种松判定）。 */
const KEY_SET = new Set<string>(Object.values(KEYS))

const DEFAULT_INTERVAL_HOURS = DEFAULT_UPDATE_SETTINGS[KEYS.intervalHours]
const MIN_INTERVAL_HOURS = UPDATE_INTERVAL_LIMITS.min
const MAX_INTERVAL_HOURS = UPDATE_INTERVAL_LIMITS.max
const DEFAULT_CHANNEL = DEFAULT_UPDATE_SETTINGS[KEYS.channel]
/** 启动后首次检查的静默延迟：避开启动高峰（用户感知不到，也不和其它 IO 抢）。 */
const FIRST_CHECK_DELAY_MS = 60 * 1000
/** 下载进度广播节流：进度事件每秒可达几十次，全量转发会把渲染进程打满。 */
const PROGRESS_THROTTLE_MS = 250
/**
 * 单个 setTimeout 的上限（2^31-1 ms ≈ 24.8 天）。
 * 超过它 Node 只会给 TimeoutOverflowWarning 并把延时压到 1ms ——
 * 默认检查周期是两个月，必须分段排程（见 armSchedule）。
 */
const MAX_TIMER_DELAY_MS = 2147483647

/**
 * electron-updater 只在 Windows 打包态可用（本项目只发 NSIS x64 安装包）。
 *
 * ⚠ `app.isPackaged` 单独不可靠：实测本机 electron 二进制以脚本方式启动时
 * `process.defaultApp === true` 但 `app.isPackaged` 仍返回 `true`（Electron 150）。
 * 只看 isPackaged 会把开发态当成正式包 → dev 里也去读 `resources/app-update.yml`，
 * 于是每次检查都 ENOENT（见 armSchedule 的超长周期溢出问题）。两者必须同时成立。
 */
function isSupported() {
  return process.platform === 'win32' && isPackagedRuntime()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 创建更新服务。 */
export function createUpdateService({ settingsService, emit }: UpdateServiceDependencies = {}) {
  const supported = isSupported()

  /** electron-updater 的 `autoUpdater` 单例；懒加载（未打包时永远为 null）。 */
  let updater: AppUpdater | null = null
  let started = false
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribeSettings: (() => void) | null = null
  let onAllWindowsClosed: (() => void) | null = null

  /** 是否正在检查（并发调用合并为一次，不重复联网）。 */
  let checking = false
  /** 下载是否在途（避免重复触发 downloadUpdate）。 */
  let downloading = false
  let lastProgressEmitAt = 0
  /** 上一次广播的快照签名：状态没变就不重复推（进度除外，进度自己有节流）。 */
  let lastSignature = ''

  const readSetting = (key: string, fallback: unknown): unknown => {
    try {
      if (!settingsService || typeof settingsService.get !== 'function') return fallback
      const value = settingsService.get(key)
      return value === undefined || value === null ? fallback : value
    } catch (_) {
      return fallback
    }
  }
  const writeSetting = (key: string, value: unknown): void => {
    try {
      if (settingsService && typeof settingsService.set === 'function') settingsService.set(key, value)
    } catch (_) {}
  }

  const readChannelId = (): UpdateChannelId => {
    const id = String(readSetting(KEYS.channel, DEFAULT_CHANNEL) || '') as UpdateChannelId
    return CHANNEL_PROFILES[id] ? id : DEFAULT_CHANNEL as UpdateChannelId
  }
  const readIntervalMs = () => {
    const hours = Number(readSetting(KEYS.intervalHours, DEFAULT_INTERVAL_HOURS))
    const safe = Number.isFinite(hours) ? Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, hours)) : DEFAULT_INTERVAL_HOURS
    return safe * 60 * 60 * 1000
  }
  const readLastCheckAt = () => {
    const at = Number(readSetting(KEYS.lastCheckAt, DEFAULT_UPDATE_SETTINGS[KEYS.lastCheckAt]))
    return Number.isFinite(at) && at > 0 ? at : 0
  }
  const autoCheckEnabled = () =>
    readSetting(KEYS.autoCheck, DEFAULT_UPDATE_SETTINGS[KEYS.autoCheck]) !== false

  /** 当前状态快照（IPC 契约 ipc/update.ts 的 responseSchema 就是这张表的镜像）。 */
  const state: UpdateState = {
    supported,
    status: supported ? STATUS.idle : STATUS.unsupported,
    currentVersion: safeVersion(),
    channel: readChannelId(),
    availableVersion: '',
    progress: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    lastCheckAt: readLastCheckAt(),
    message: supported ? '' : '当前为开发模式或非 Windows 构建，不提供自动更新。',
    error: ''
  }

  function safeVersion() {
    try {
      return String(app.getVersion() || '')
    } catch (_) {
      return ''
    }
  }

  function getState(): UpdateState {
    return { ...state }
  }

  /** 合并状态并广播（签名去重，避免同一快照反复推）。 */
  function setState(patch: Partial<UpdateState>): UpdateState {
    if (patch && typeof patch === 'object') Object.assign(state, patch)
    broadcast()
    return getState()
  }

  function broadcast(): void {
    if (typeof emit !== 'function') return
    const snapshot = getState()
    let signature = ''
    try {
      signature = JSON.stringify(snapshot)
    } catch (_) {
      signature = ''
    }
    if (signature && signature === lastSignature) return
    lastSignature = signature
    try {
      emit(IPC_EVENTS.updateChanged, snapshot)
    } catch (error) {
      console.warn('[update] broadcast failed:', errorMessage(error))
    }
  }

  /**
   * 把错误翻译成「状态 + 人话」。
   *
   * 关键一条：仓库还没有任何发布 / 通道 yml 缺失（404）**不算错误** ——
   * 新仓库第一次检查必然遇到，弹红只会让人以为坏了。归为 up-to-date 并附说明。
   * @returns {{ kind: 'no-release'|'network'|'other', message: string }}
   */
  function classifyError(error: unknown): { kind: 'no-release' | 'network' | 'other'; message: string } {
    const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
    const code = String(record?.code || '')
    const raw = String(record?.message || error || '未知错误')
    if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
      return { kind: 'no-release', message: '当前发布渠道还没有可用的更新清单（可能尚未发布任何版本）。' }
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT|net::/i.test(raw)) {
      return { kind: 'network', message: '无法连接更新服务器，请检查网络后重试。' }
    }
    return { kind: 'other', message: raw }
  }

  /** 让 updater 的通道与当前设置对表（每次检查前都调一次，改设置即时生效）。 */
  function applyChannel(target: AppUpdater): void {
    const profile = CHANNEL_PROFILES[readChannelId()] || CHANNEL_PROFILES.stable
    try {
      target.channel = profile.updaterChannel
      target.allowPrerelease = profile.allowPrerelease
      // `set channel` 会把 allowDowngrade 置 true（见文件头注释）—— 这里必须复位。
      target.allowDowngrade = false
    } catch (error) {
      console.warn('[update] apply channel failed:', errorMessage(error))
    }
    state.channel = profile.id
  }

  /** electron-updater 只认 `{ info, warn, error }`，这里接 console（无 electron-log 依赖）。 */
  const logger = {
    info: (message?: unknown) => console.log('[update]', message),
    warn: (message?: unknown) => console.warn('[update]', message),
    error: (message?: unknown) => console.error('[update]', message),
    debug: () => {}
  }

  /** 懒加载 + 事件接线。返回 null 表示当前构建没有更新能力。 */
  function ensureUpdater(): AppUpdater | null {
    if (!supported) return null
    if (updater) return updater
    let autoUpdater: AppUpdater
    try {
      ;({ autoUpdater } = require('electron-updater') as { autoUpdater: AppUpdater })
    } catch (error) {
      setState({ status: STATUS.error, error: '更新模块加载失败：' + errorMessage(error) })
      return null
    }

    // 全手动：检查由我们排程，下载与安装必须由用户显式触发（原地覆盖升级的口径）。
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.autoRunAppAfterInstall = true
    autoUpdater.logger = logger

    autoUpdater.on('checking-for-update', () => {
      if (state.status !== STATUS.checking) setState({ status: STATUS.checking, error: '', message: '' })
    })
    autoUpdater.on('update-available', (info) => {
      setState({
        status: STATUS.available,
        availableVersion: String((info && info.version) || ''),
        error: '',
        message: ''
      })
    })
    autoUpdater.on('update-not-available', () => {
      setState({ status: STATUS.upToDate, availableVersion: '', error: '', message: '已是最新版本。' })
    })
    autoUpdater.on('download-progress', (progress) => {
      if (!progress) return
      const patch = {
        status: STATUS.downloading,
        progress: Number(progress.percent) || 0,
        transferred: Number(progress.transferred) || 0,
        total: Number(progress.total) || 0,
        bytesPerSecond: Number(progress.bytesPerSecond) || 0,
        error: '',
        message: ''
      }
      Object.assign(state, patch)
      // 节流：只限制「广播频率」，内存里的进度永远是新的（页面下次取值即最新）。
      const now = Date.now()
      if (now - lastProgressEmitAt < PROGRESS_THROTTLE_MS) return
      lastProgressEmitAt = now
      broadcast()
    })
    autoUpdater.on('update-downloaded', (info) => {
      downloading = false
      setState({
        status: STATUS.downloaded,
        availableVersion: String((info && info.version) || state.availableVersion || ''),
        progress: 100,
        error: '',
        message: '更新包已下载完成，重启即可安装。'
      })
    })
    autoUpdater.on('error', (error) => {
      downloading = false
      const info = classifyError(error)
      if (info.kind === 'no-release') {
        setState({ status: STATUS.upToDate, availableVersion: '', error: '', message: info.message })
      } else if (info.kind === 'network' && state.status === STATUS.checking) {
        // 静默检查遇到断网不弹红：回到 idle + 说明，用户下次打开更新页能看到原因。
        setState({ status: STATUS.idle, error: '', message: info.message })
      } else {
        setState({ status: STATUS.error, error: info.message, message: '' })
      }
    })

    updater = autoUpdater
    applyChannel(updater)
    return updater
  }

  /**
   * 检查更新。
   * @param {{ silent?: boolean }} [options]  silent=true 时不把「网络失败」升级成红色错误
   */
  async function check(options: { silent?: boolean } = {}) {
    const silent = options && options.silent === true
    if (!supported) return getState()
    if (checking || downloading) return getState()
    const target = ensureUpdater()
    if (!target) return getState()

    checking = true
    setState({ status: STATUS.checking, channel: readChannelId(), error: '', message: '' })
    try {
      applyChannel(target)
      await target.checkForUpdates()
    } catch (error) {
      const info = classifyError(error)
      if (info.kind === 'no-release') {
        setState({ status: STATUS.upToDate, availableVersion: '', error: '', message: info.message })
      } else if (info.kind === 'network' && silent) {
        setState({ status: STATUS.idle, error: '', message: info.message })
      } else {
        setState({ status: STATUS.error, error: info.message, message: '' })
      }
    } finally {
      checking = false
      // 持久化检查时刻：重启后不会立刻再查一遍（2 个月一次的语义靠它跨进程成立）。
      const at = Date.now()
      state.lastCheckAt = at
      writeSetting(KEYS.lastCheckAt, at)
      broadcast()
    }
    return getState()
  }

  /** 下载更新包（仅在 available / error 后允许；已下载则直接返回）。 */
  async function download() {
    if (!supported) return getState()
    if (state.status === STATUS.downloaded) return getState()
    if (state.status !== STATUS.available && state.status !== STATUS.error) return getState()
    const target = ensureUpdater()
    if (!target) return getState()
    if (downloading) return getState()

    downloading = true
    lastProgressEmitAt = 0
    setState({
      status: STATUS.downloading,
      progress: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      error: '',
      message: ''
    })
    try {
      await target.downloadUpdate()
    } catch (error) {
      downloading = false
      const info = classifyError(error)
      setState({ status: STATUS.error, error: info.message, message: '' })
    }
    return getState()
  }

  /**
   * 重启并安装。返回 `{ ok, message }`（页面据此提示；失败不抛给渲染层）。
   * isSilent=false → 走 NSIS 交互式安装器，保留用户上次选择的安装路径（原地覆盖）。
   */
  async function install() {
    if (!supported) return { ok: false, message: '当前构建不支持自动更新。' }
    if (state.status !== STATUS.downloaded) return { ok: false, message: '还没有下载完成的更新包。' }
    const target = ensureUpdater()
    if (!target) return { ok: false, message: '更新模块不可用。' }
    // 让 IPC 的响应先回到页面，再真正退出（否则页面看不到任何反馈）。
    setImmediate(() => {
      try {
        target.quitAndInstall(false, true)
      } catch (error) {
        const info = classifyError(error)
        setState({ status: STATUS.error, error: info.message })
      }
    })
    return { ok: true }
  }

  /** 定时器链：单一 setTimeout（非 interval），每次触发后按「上次检查 + 周期」重排。 */
  function clearSchedule() {
    if (scheduleTimer) {
      clearTimeout(scheduleTimer)
      scheduleTimer = null
    }
  }

  function armSchedule() {
    clearSchedule()
    if (!started || !supported) return
    if (!autoCheckEnabled()) return
    const remaining = readLastCheckAt() + readIntervalMs() - Date.now()
    // 未到点 → 到点再查；已过点（或从未查过）→ 启动后 FIRST_CHECK_DELAY_MS 再查。
    const delay = remaining > FIRST_CHECK_DELAY_MS ? remaining : FIRST_CHECK_DELAY_MS
    scheduleTimer = setTimeout(async () => {
      scheduleTimer = null
      // 默认周期两个月（5184000000 ms）远超 setTimeout 的 32 位上限，上面只能截到上限；
      // 闹钟响了若还没到点，就再排一段 —— 否则会被宿主降到 1ms，变成
      // 「检查 → 重排 → 立即再检查」的死循环（会把日志和主进程打满）。
      if (readLastCheckAt() + readIntervalMs() - Date.now() > 0) {
        armSchedule()
        return
      }
      try {
        await check({ silent: true })
      } catch (error) {
        console.warn('[update] scheduled check failed:', errorMessage(error))
      }
      armSchedule()
    }, Math.min(delay, MAX_TIMER_DELAY_MS))
    if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref()
  }

  /** 设置变更：通道改了要对表；开关/周期改了要重排定时器。 */
  function handleSettingsChange(change: SettingsChange | null | undefined): void {
    const key = change && change.key
    if (!key || !KEY_SET.has(key)) return
    if (key === KEYS.channel) {
      const nextChannel = readChannelId()
      if (state.channel !== nextChannel) {
        state.channel = nextChannel
        // 通道变了，旧的「发现新版本」结论作废（下载中的不动，electron-updater 没有取消下载）。
        if (state.status === STATUS.available || state.status === STATUS.upToDate || state.status === STATUS.downloaded) {
          state.status = STATUS.idle
          state.availableVersion = ''
          state.progress = 0
          state.transferred = 0
          state.total = 0
          state.bytesPerSecond = 0
          state.error = ''
          state.message = ''
        }
        if (updater) applyChannel(updater)
        broadcast()
      }
    }
    if (key === KEYS.autoCheck || key === KEYS.intervalHours) {
      armSchedule()
      broadcast()
    }
  }

  function start() {
    if (started) return
    started = true
    state.currentVersion = safeVersion()
    state.channel = readChannelId()
    state.lastCheckAt = readLastCheckAt()
    if (settingsService && typeof settingsService.subscribe === 'function') {
      const unsubscribe = settingsService.subscribe(handleSettingsChange)
      unsubscribeSettings = typeof unsubscribe === 'function' ? unsubscribe : null
    }
    // 进程级收尾：定时器不属于某个窗口，只在应用收尾时清（与 module-bootstrap 其它定时器一致）。
    onAllWindowsClosed = () => clearSchedule()
    try {
      app.on('window-all-closed', onAllWindowsClosed)
    } catch (_) {}
    armSchedule()
  }

  function stop() {
    started = false
    clearSchedule()
    if (unsubscribeSettings) {
      try {
        unsubscribeSettings()
      } catch (_) {}
      unsubscribeSettings = null
    }
    if (onAllWindowsClosed) {
      try {
        app.removeListener('window-all-closed', onAllWindowsClosed)
      } catch (_) {}
      onAllWindowsClosed = null
    }
  }

  return { start, stop, getState, check, download, install, STATUS, CHANNELS: CHANNEL_PROFILES }
}

export const UPDATE_STATUS = STATUS
export const UPDATE_CHANNELS = CHANNEL_PROFILES
