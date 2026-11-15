/**
 * PWA 更新器 —— 「manifest 变了没有」的**唯一判定点**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 更新 = 重新拉一次 manifest，与入库快照做 diff，有变化才覆盖安装
 * ══════════════════════════════════════════════════════════════════
 *  · **diff 只比 `manifest#toSnapshot`**：它是去掉 `raw` 的稳定形状，
 *    安装时写进 `pwaApps.manifest_json` 的也是同一个形状，两边天然可比。
 *    绝不在这里另写一套"哪些字段算变化"的规则（那必然与安装漂移）。
 *  · **覆盖安装复用 `installer.reinstall`**：图标下载、目录事务、DB、
 *    快捷方式全走同一条管线，更新与安装不存在两条路径。
 *  · **快捷方式 / 开机启动必须原样回传**：`shortcuts.sync` 是"收敛到目标状态"，
 *    options 里缺省为 false 的位置会被**删除**。把用户已有开关漏传，
 *    更新一次就会静默清掉桌面图标和开机启动。
 *
 * ══════════════════════════════════════════════════════════════════
 * 状态写回
 * ══════════════════════════════════════════════════════════════════
 * `pwaService.markChecked` 只写 `lastCheckedAt / updateState`，**不广播**
 * （域服务的变更订阅只覆盖 install/update/uninstall/flags）。因此这里
 * 每写完一次检查结果都补发一条 `pwa:changed`（action = checked），
 * 否则管理页的「上次检查」与失败徽标会一直停在旧值。
 *
 * 依赖注入：不 require electron / runtimeRegistry。session、profile、
 * 广播全部由组合根传入，插件与 IPC 走同一批实例。
 */

import type { Session } from 'electron'
import { manifest as manifestRules, type PwaManifestSnapshot } from '@hira-ng/domain-pwa'
import { fetchManifest } from '@hira-ng/infra-pwa'

interface PwaUpdateRecord {
  id: string
  installKind?: string
  manifestUrl?: string | null
  manifestJson?: string | null
  profileId?: string | null
  startUrl?: string | null
  name?: string | null
  desktopShortcut?: string | null
  startMenuShortcut?: string | null
  runOnStartup?: boolean
  lastCheckedAt?: number
  [key: string]: unknown
}

interface PwaUpdateService {
  getRecord(appId: string): PwaUpdateRecord | null | undefined
  get(appId: string): Record<string, unknown> | null | undefined
  list(): unknown[]
  markChecked(appId: string, state: { updateState: string }): unknown
}

interface PwaReinstaller {
  reinstall(record: PwaUpdateRecord, candidate: Record<string, unknown>, options: Record<string, unknown>): Promise<{
    ok: boolean
    reason?: string
    app?: Record<string, unknown>
    shortcutFailures?: unknown[]
  } | null | undefined> | {
    ok: boolean
    reason?: string
    app?: Record<string, unknown>
    shortcutFailures?: unknown[]
  } | null | undefined
}

export interface PwaUpdaterPorts {
  pwaService: PwaUpdateService
  pwaInstaller: PwaReinstaller
  getSession?(profileId: string): Session | null | undefined
  getProfileId?(): string
  emitChanged?(payload: { appId: string; action: string }): void
  logger?: { warn?(...args: unknown[]): void }
  now?(): number
  throttleMs?: number
  concurrency?: number
  timeoutMs?: number
}

interface PwaUpdateResult {
  ok: boolean
  reason?: string
  changed?: boolean
  app?: Record<string, unknown> | null
}

const HOUR = 60 * 60 * 1000
/** 后台检查的节流窗口（文档 §13：一天一次就够了）。 */
const DEFAULT_THROTTLE_MS = 24 * HOUR
/** manifest 并发拉取上限：再多也只是让首个应用的图标下载排队。 */
const DEFAULT_CONCURRENCY = 3
const DEFAULT_TIMEOUT_MS = 8000
/** 只有完整 PWA 有站点清单；站点快捷方式没有可更新的东西。 */
const UPDATABLE_KIND = 'full'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 已入库的 manifest 快照。
 * `null` 表示"没有可比对的旧版本"（历史记录 / 上次安装失败），按有变化处理。
 */
function previousSnapshot(manifestJson: unknown): PwaManifestSnapshot | null {
  if (typeof manifestJson !== 'string' || !manifestJson) return null
  try {
    return manifestRules.toSnapshot(JSON.parse(manifestJson))
  } catch (_) {
    return null
  }
}

/**
 * 稳定签名：图标顺序变化不应被当成一次更新。
 * 先按 (src, 尺寸, 类型) 排序，再序列化整份快照。
 */
function signatureOf(snapshot: PwaManifestSnapshot | null): string {
  if (!snapshot) return ''
  const icons = ((snapshot.icons as Array<Record<string, unknown>> | undefined) || [])
    .map((icon) => `${icon.src}|${icon.width}x${icon.height}|${icon.type}|${icon.any ? 1 : 0}`)
    .sort()
  return JSON.stringify({
    name: snapshot.name,
    shortName: snapshot.shortName,
    display: snapshot.display,
    startUrl: snapshot.startUrl,
    scope: snapshot.scope,
    themeColor: snapshot.themeColor,
    backgroundColor: snapshot.backgroundColor,
    icons
  })
}

/**
 * @param {{
 *   pwaService: object,
 *   pwaInstaller: object,
 *   getSession?: (profileId: string) => Electron.Session|null,
 *   getProfileId?: () => string,
 *   emitChanged?: (payload: { appId: string, action: string }) => void,
 *   logger?: { warn?: Function },
 *   now?: () => number,
 *   throttleMs?: number,
 *   concurrency?: number,
 *   timeoutMs?: number
 * }} ports
 */
export function createPwaUpdater(ports: PwaUpdaterPorts) {
  const {
    pwaService,
    pwaInstaller,
    getSession,
    getProfileId,
    emitChanged,
    logger = console,
    now = Date.now,
    throttleMs = DEFAULT_THROTTLE_MS,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = ports

  if (!pwaService) throw new TypeError('createPwaUpdater 缺少 pwaService')
  if (!pwaInstaller) throw new TypeError('createPwaUpdater 缺少 pwaInstaller')

  /** 同一 appId 复用同一次进行中的检查（手动点击撞上后台 tick 不该拉两遍）。 */
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map<string, Promise<PwaUpdateResult>>()

  function warn(...args: unknown[]): void {
    if (logger && typeof logger.warn === 'function') logger.warn('[pwa-update]', ...args)
  }

  function currentProfile(): string {
    if (typeof getProfileId !== 'function') return 'default'
    try { return String(getProfileId() || 'default') } catch (_) { return 'default' }
  }

  /** 与安装管线同口径：先用该 profile 的会话，取不到再回落默认 session。 */
  function sessionFor(profileId: string): Session | null {
    if (typeof getSession === 'function') {
      try {
        const session = getSession(profileId)
        if (session) return session
      } catch (err) {
        warn('取会话失败：', errorMessage(err))
      }
    }
    try {
      const electron = require('electron') as typeof import('electron')
      return electron.session ? electron.session.defaultSession : null
    } catch (_) {
      return null
    }
  }

  function readRecord(appId: string): PwaUpdateRecord | null {
    try { return pwaService.getRecord(appId) ?? null } catch (err) {
      warn('读取应用记录失败：', errorMessage(err))
      return null
    }
  }

  function readApp(appId: string): Record<string, unknown> | null {
    try { return pwaService.get(appId) ?? null } catch (_) { return null }
  }

  /**
   * 写检查结果 + 补一条广播。
   * 广播只带 appId/action：页面订阅后自行重拉列表，不在这里拼 UI 形状。
   */
  function writeCheckState(appId: string, updateState: string): void {
    try { pwaService.markChecked(appId, { updateState }) } catch (err) {
      warn('写入检查状态失败：', errorMessage(err))
    }
    if (typeof emitChanged !== 'function') return
    try { emitChanged({ appId, action: 'checked' }) } catch (err) {
      warn('变更广播失败：', errorMessage(err))
    }
  }

  function markError(appId: string, reason: string): PwaUpdateResult {
    writeCheckState(appId, 'error')
    return { ok: false, reason }
  }

  /** 真正的检查 + 覆盖安装（已按 appId 去重）。 */
  async function runUpdate(appId: string): Promise<PwaUpdateResult> {
    const record = readRecord(appId)
    if (!record) return { ok: false, reason: '应用不存在' }
    if (record.installKind !== UPDATABLE_KIND) {
      // 不改 updateState：快捷方式永远不可更新，不该被标成"检查失败"。
      return { ok: false, reason: '快捷方式没有可更新的站点清单' }
    }

    const manifestUrl = String(record.manifestUrl || '')
    if (!manifestUrl) return markError(appId, '缺少 manifest 地址')

    const profileId = String(record.profileId || currentProfile())
    const session = sessionFor(profileId)

    const fetched = await fetchManifest(session, manifestUrl, { timeoutMs })
    if (!fetched || !fetched.ok) {
      return markError(appId, (fetched && fetched.reason) || 'manifest 拉取失败')
    }

    const normalized = manifestRules.normalizeManifest(fetched.manifest, {
      // documentUrl 用应用自己的 startUrl：跨源 start_url 一律判无效（与安装同一条规则）。
      documentUrl: String(record.startUrl || ''),
      manifestUrl: fetched.manifestUrl || manifestUrl,
      pageTitle: record.name
    })
    if (!normalized) return markError(appId, 'manifest 内容无效（start_url 缺失或跨源）')

    const next = manifestRules.toSnapshot(normalized)
    const prev = previousSnapshot(record.manifestJson)
    if (prev && signatureOf(prev) === signatureOf(next)) {
      writeCheckState(appId, 'idle')
      return { ok: true, changed: false, app: readApp(appId) }
    }

    const result = await pwaInstaller.reinstall(
      record,
      {
        ...normalized,
        profileId,
        kind: UPDATABLE_KIND,
        documentUrl: record.startUrl,
        manifestUrl: fetched.manifestUrl || manifestUrl,
        icons: normalized.icons,
        // 更新不再回落到 favicon：没有可用图标时由安装管线用内置兜底。
        faviconUrl: null,
        // 入库 / 快照写入的是**规范化后的** manifest（与 detect 产出的候选一致）。
        manifest: normalized
      },
      {
        session,
        options: {
          // ⚠ 必须原样回传：sync 会把缺失的开关当成"用户取消勾选"并删除快捷方式。
          createDesktopShortcut: !!record.desktopShortcut,
          createStartMenuShortcut: !!record.startMenuShortcut,
          runOnStartup: !!record.runOnStartup
        }
      }
    )

    if (!result || !result.ok) {
      return markError(appId, (result && result.reason) || '更新失败')
    }
    if (result.shortcutFailures && result.shortcutFailures.length) {
      warn('更新后快捷方式同步失败：', result.shortcutFailures.length, '项')
    }

    writeCheckState(appId, 'idle')
    return { ok: true, changed: true, app: result.app || readApp(appId) }
  }

  /**
   * 检查并更新单个应用。
   * @param {string} id
   * @returns {Promise<{ ok: boolean, reason?: string, changed?: boolean, app?: object }>}
   */
  function update(id: unknown): Promise<PwaUpdateResult> {
    const appId = String(id == null ? '' : id).trim()
    if (!appId) return Promise.resolve({ ok: false, reason: '缺少应用 id' })

    const running = inflight.get(appId)
    if (running) return running

    const task = runUpdate(appId)
      .catch((err) => {
        warn('检查更新异常：', errorMessage(err))
        return markError(appId, errorMessage(err))
      })
      .finally(() => { inflight.delete(appId) })

    inflight.set(appId, task)
    return task
  }

  function isFresh(app: PwaUpdateRecord | null | undefined): boolean {
    const last = Number(app && app.lastCheckedAt)
    if (!Number.isFinite(last) || last <= 0) return false
    const age = now() - last
    return age >= 0 && age < throttleMs
  }

  /**
   * 检查全部应用（管理页按钮 / 启动后后台 tick 共用）。
   *
   * @param {{ force?: boolean }} [options] force 绕过 24h 节流（手动点击）
   * @returns {Promise<{ ok: boolean, updated: string[], reason?: string }>}
   */
  async function checkAll(options: { force?: boolean } = {}) : Promise<{ ok: boolean, updated: string[], reason?: string }> {
    const force = !!options.force
    const due: PwaUpdateRecord[] = []
    try {
      for (const app of pwaService.list()) {
        const candidate = app && typeof app === 'object' ? app as PwaUpdateRecord : null
        if (!candidate || candidate.installKind !== UPDATABLE_KIND) continue
        if (!force && isFresh(candidate)) continue
        const record = readRecord(candidate.id)
        if (!record || !record.manifestUrl) continue
        due.push(record)
      }
    } catch (err) {
      return { ok: false, updated: [], reason: errorMessage(err) }
    }

    if (!due.length) return { ok: true, updated: [] }

    /** 有界并发：cursor 自增即"下一个任务"，不需要把数组切成批。 */
    const results: Array<PwaUpdateResult | undefined> = new Array(due.length)
    let cursor = 0
    const runners = Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, due.length))

    async function worker() {
      while (cursor < due.length) {
        const index = cursor
        cursor += 1
        const record = due[index]
        try {
          results[index] = await update(record.id)
        } catch (err) {
          results[index] = { ok: false, reason: errorMessage(err) }
        }
      }
    }

    await Promise.all(Array.from({ length: runners }, worker))

    const updated = []
    for (let i = 0; i < due.length; i += 1) {
      const result = results[i]
      const record = due[i]
      if (result && result.ok && result.changed && record) updated.push(record.id)
    }
    return { ok: true, updated }
  }

  return {
    update,
    checkAll,
    /** 诊断：正在检查的应用 id 快照。 */
    inflightIds: () => Array.from(inflight.keys())
  }
}

