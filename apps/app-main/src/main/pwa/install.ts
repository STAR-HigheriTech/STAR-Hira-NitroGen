/**
 * 安装管线 —— 候选 → 图标资产 → 目录替换 → 数据库 → 快捷方式。
 *
 * ══════════════════════════════════════════════════════════════════
 * 事务边界（唯一需要理解的一点）
 * ══════════════════════════════════════════════════════════════════
 *  · **资产 + 数据库** 是一个事务：先写 `<appId>.tmp-<nonce>`，DB 成功后才把
 *    final→old、tmp→final、删 old；DB 失败则删 tmp，旧版本分毫未动。
 *  · **快捷方式**在事务之外：失败只进 failures（文档 §7.2 第 8 步），
 *    绝不因为"桌面不让写"就让安装失败。
 *
 * 为什么顺序与文档表格略有差异（DB 在快捷方式之前）：
 * 快捷方式的 DB 标记走 `pwaService.setFlags`，需要记录先存在；
 * 把它放在事务内也更符合"失败可回滚"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 依赖注入
 * ══════════════════════════════════════════════════════════════════
 * 不 require runtimeRegistry / BrowserWindow / ipcMain：进度与广播由调用方
 * 以函数端口传入，插件（pwa.install）与 IPC（pwa:install）走同一条管线。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Session } from 'electron'
import type { PwaApp, PwaRecord, PwaService } from '@hira-ng/domain-pwa'
import {
  installIconAssets,
  writeIconSet,
  type IconFailure,
  type InstalledIconAssets
} from '@hira-ng/infra-pwa'
import type { CandidateStore, PwaCandidate } from './candidate-store'
import type { PwaPaths } from './paths'
import type { PwaShortcutSyncOptions, PwaShortcutSyncResult } from './shortcuts'

const STAGES = Object.freeze({
  ICON: 'icon',
  SHORTCUT: 'shortcut',
  DB: 'db'
})

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface PwaInstallerPorts {
  candidateStore: CandidateStore
  pwaService: PwaService
  paths: PwaPaths
  shortcuts: { sync(record: PwaRecord, options: PwaShortcutSyncOptions): Promise<PwaShortcutSyncResult> }
  syncIntegrations?(record: PwaRecord): Promise<unknown> | unknown
  /** 站点图标全失败时的兜底图标；由组合根注入正式 exe 或开发态 build/icon.ico。 */
  fallbackIconPath?: string | null
  getProfileId(): string
  emitProgress?(payload: PwaInstallProgress): void
  emitChanged?(payload: { appId: string; action: 'install'; created: boolean }): void
  logger?: { warn?(...args: unknown[]): void }
}

export interface PwaInstallProgress {
  candidateId: string
  stage: string
  [key: string]: unknown
}

export interface PwaCommitInput {
  name?: unknown
  session?: Session | null
  options?: PwaShortcutSyncOptions
}

export interface PwaInstallInput extends PwaCommitInput {
  candidateId: string
}

export type PwaInstallResult =
  | {
      ok: true
      app: PwaApp
      created: boolean
      iconSource: string
      shortcutFailures: PwaShortcutSyncResult['failures']
    }
  | { ok: false; reason: string }

/**
 * @param {{
 *   candidateStore: object,
 *   pwaService: object,
 *   paths: ReturnType<typeof import('./paths').createPwaPaths>,
 *   shortcuts: ReturnType<typeof import('./shortcuts').createPwaShortcuts>,
 *   getProfileId: () => string,
 *   emitProgress?: (payload: object) => void,
 *   emitChanged?: (payload: object) => void,
 *   logger?: { warn?: Function }
 * }} ports
 */
export function createPwaInstaller(ports: PwaInstallerPorts) {
  const {
    candidateStore,
    pwaService,
    paths,
    shortcuts,
    fallbackIconPath,
    getProfileId,
    emitProgress,
    emitChanged,
    logger = console
  } = ports

  if (!candidateStore || !pwaService || !paths || !shortcuts) {
    throw new TypeError('createPwaInstaller 缺少 candidateStore / pwaService / paths / shortcuts')
  }
  if (typeof getProfileId !== 'function') throw new TypeError('createPwaInstaller 缺少 getProfileId')

  /** 同一 appId 串行化：双击安装按钮不应该跑两遍管线。 */
  const inflight = new Set<string>()

  function warn(...args: unknown[]): void {
    if (logger && typeof logger.warn === 'function') logger.warn('[pwa-install]', ...args)
  }

  function currentProfile(): string {
    try { return String(getProfileId() || 'default') } catch (_) { return 'default' }
  }

  function progress(candidateId: unknown, stage: string, extra: Record<string, unknown> = {}): void {
    // 覆盖安装（updater.reinstall）没有候选 id：页面订阅者靠 candidateId 过滤，
    // 发一条没有归属的进度纯属浪费，直接跳过。
    if (!candidateId || typeof emitProgress !== 'function') return
    try { emitProgress({ candidateId: String(candidateId), stage, ...extra }) } catch (e) { warn('进度推送失败：', errorMessage(e)) }
  }

  function changed(payload: { appId: string; action: 'install'; created: boolean }): void {
    if (typeof emitChanged !== 'function') return
    try { emitChanged(payload) } catch (e) { warn('变更广播失败：', errorMessage(e)) }
  }

  function resolveSession(session: Session | null | undefined): Session | null {
    if (session) return session
    try {
      const electron = require('electron') as typeof import('electron')
      return electron.session ? electron.session.defaultSession : null
    } catch (_) {
      return null
    }
  }

  /**
   * 图标全失败时的内置兜底：主程序自己的文件图标。
   * 有总比空白方块强，且不需要额外打包资源。
   */
  async function fallbackIcon(stagingDir: string): Promise<InstalledIconAssets | null> {
    try {
      const { app } = require('electron') as typeof import('electron')
      const source = String(fallbackIconPath || '').trim()
      if (!source) return null
      const image = await app.getFileIcon(source, { size: 'large' })
      if (!image || image.isEmpty()) return null
      const result = await writeIconSet(stagingDir, image.toPNG(), 'image/png')
      return result.ok ? { ...result, source: 'manifest' } : null
    } catch (_) {
      return null
    }
  }

  /** manifest.json 快照 —— 更新 diff 的唯一依据（文档 §7.2 第 7 步）。 */
  async function writeManifestSnapshot(stagingDir: string, candidate: PwaCandidate): Promise<void> {
    const snapshot = {
      capturedAt: Date.now(),
      documentUrl: candidate.documentUrl || null,
      manifestUrl: candidate.manifestUrl || null,
      manifest: candidate.manifest || null
    }
    await fs.writeFile(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(snapshot, null, 2),
      'utf8'
    )
  }

  /**
   * 把暂存目录换成正式目录。
   * 覆盖安装：final → old → 删 old；任何一步失败都尽量把 old 换回来。
   */
  async function swapDirectory(stagingDir: string, finalDir: string, backupDir: string): Promise<void> {
    let hadOld = false
    try {
      await fs.access(finalDir)
      hadOld = true
    } catch (_) {}

    if (!hadOld) {
      await fs.rename(stagingDir, finalDir)
      return
    }

    await fs.rename(finalDir, backupDir)
    try {
      await fs.rename(stagingDir, finalDir)
    } catch (err) {
      // 新目录没换上去：把旧版本换回来，避免应用目录整个消失。
      try { await fs.rename(backupDir, finalDir) } catch (_) {}
      throw err
    }
    // 旧版本删除失败不影响安装结果（下次安装会再次尝试覆盖）。
    try { await fs.rm(backupDir, { recursive: true, force: true }) } catch (_) {}
  }

  /**
   * 执行一条安装（候选已确定）。
   * @param {object} candidate detect 产出的候选
   * @param {{ session?: Electron.Session, options?: object }} input
   */
  async function commit(candidate: PwaCandidate, input: PwaCommitInput = {}): Promise<PwaInstallResult> {
    const options = input.options || {}
    const profileId = currentProfile()
    const appId = String(candidate.appId || '')
    if (!appId) return { ok: false, reason: '安装信息已过期，请刷新页面重试' }

    // 用户可在安装界面改名：空白视为「沿用站点名称」，交给候选回落。
    // 这里是全管线唯一消费 `input.name` 的地方 —— 覆盖安装（reinstall）也经过它。
    const userName = String(input.name == null ? '' : input.name).trim().slice(0, 120)
    const displayName = userName || String(candidate.name || '').trim() || '应用'

    // ── 选项三态收敛 ─────────────────────────────────────────
    // undefined = 沿用该应用已有设置（覆盖安装 / 插件调用时前端可能不传）；
    // 显式布尔才代表用户这次的选择。否则 `!!undefined` 会把用户的开机启动、
    // 桌面 / 开始菜单快捷方式在「检查更新 → 覆盖安装」时静默抹掉。
    const previous = pwaService.getRecord(appId) || null
    const pickOption = (key: keyof PwaShortcutSyncOptions, fallback: unknown): boolean =>
      typeof options[key] === 'boolean' ? options[key] : !!fallback
    const desired = {
      createDesktopShortcut: pickOption('createDesktopShortcut', previous && previous.desktopShortcut),
      createStartMenuShortcut: pickOption('createStartMenuShortcut', previous && previous.startMenuShortcut),
      runOnStartup: pickOption('runOnStartup', previous && previous.runOnStartup)
    }

    if (inflight.has(appId)) return { ok: false, reason: '该应用正在安装，请稍候' }
    inflight.add(appId)

    const nonce = randomUUID().replace(/-/g, '').slice(0, 12)
    const stagingDir = paths.stagingDir(profileId, appId, nonce)
    const finalDir = paths.assetDir(profileId, appId)
    const backupDir = paths.backupDir(profileId, appId, nonce)

    let swapped = false
    try {
      await fs.mkdir(stagingDir, { recursive: true })

      // ── 4/5/6 图标：manifest 候选 → favicon → 内置 ──────────
      progress(candidate.candidateId, STAGES.ICON)
      const session = resolveSession(input.session)
      let icon: InstalledIconAssets | IconFailure | null = null
      if (session) {
        try {
          icon = await installIconAssets({
            assetDir: stagingDir,
            session,
            icons: candidate.icons || [],
            faviconUrl: candidate.faviconUrl || undefined
          })
        } catch (e) {
          warn('图标下载异常：', errorMessage(e))
        }
      }
      if (!icon || !icon.ok) icon = await fallbackIcon(stagingDir)

      // ── 7 manifest 快照 ────────────────────────────────────
      await writeManifestSnapshot(stagingDir, candidate)

      // ── 目录替换（事务的"写"阶段）──────────────────────────
      await swapDirectory(stagingDir, finalDir, backupDir)
      swapped = true

      // ── 9 数据库 ───────────────────────────────────────────
      progress(candidate.candidateId, STAGES.DB)
      const upsert = pwaService.upsert({
        id: appId,
        name: displayName,
        // 改名后 shortName 必须跟着走：快捷方式文件名与开始菜单项取的就是它，
        // 否则会出现「安装界面叫 A、桌面图标叫 B」的割裂。
        shortName: userName ? displayName : (candidate.shortName || null),
        startUrl: candidate.startUrl,
        scope: candidate.scope || null,
        manifestUrl: candidate.manifestUrl || null,
        manifestJson: candidate.manifest ? JSON.stringify(candidate.manifest) : null,
        display: candidate.display || 'standalone',
        themeColor: candidate.themeColor || null,
        backgroundColor: candidate.backgroundColor || null,
        iconPath: icon && icon.ok ? icon.iconPath : null,
        iconSmallPath: icon && icon.ok ? icon.iconSmallPath : null,
        iconIcoPath: icon && icon.ok ? icon.iconIcoPath : null,
        installKind: candidate.kind === 'full' ? 'full' : 'shortcut',
        source: candidate.kind === 'full' ? 'manifest' : 'shortcut',
        runOnStartup: desired.runOnStartup ? 1 : 0
      })

      if (!upsert || !upsert.ok) {
        throw new Error((upsert && upsert.reason) || '写入应用记录失败')
      }

      // ── 8 快捷方式（事务外，失败不进 ok）───────────────────
      progress(candidate.candidateId, STAGES.SHORTCUT)
      const record = pwaService.getRecord(appId)
      let shortcutResult: PwaShortcutSyncResult = { ok: true, failures: [] }
      if (record) {
        try {
          shortcutResult = await shortcuts.sync(record as PwaRecord, desired)
        } catch (e) {
          warn('快捷方式同步异常：', errorMessage(e))
          shortcutResult = { ok: false, failures: [{ reason: errorMessage(e) }] }
        }
      }
      if (record && typeof ports.syncIntegrations === 'function') {
        try {
          await ports.syncIntegrations(record)
        } catch (e) {
          warn('文件 / 协议关联同步失败：', errorMessage(e))
        }
      }

      // 开机启动请求了但快捷方式没建成 → 把标记落回 false，避免 UI 说谎。
      if (desired.runOnStartup && shortcutResult && shortcutResult.startup &&
          shortcutResult.startup.ok === false) {
        pwaService.setFlags(appId, { runOnStartup: false })
      }

      const app = pwaService.get(appId) || upsert.app
      changed({ appId, action: 'install', created: !!upsert.created })
      return {
        ok: true,
        app,
        created: !!upsert.created,
        iconSource: icon && icon.ok ? (icon.source || 'manifest') : 'default',
        shortcutFailures: (shortcutResult && shortcutResult.failures) || []
      }
    } catch (err) {
      // 还没换目录：删掉暂存，旧版本完好。
      if (!swapped) {
        try { await fs.rm(stagingDir, { recursive: true, force: true }) } catch (_) {}
      } else {
        // 已换目录但 DB 失败：把新目录撤掉，尽量恢复旧版本。
        try { await fs.rm(finalDir, { recursive: true, force: true }) } catch (_) {}
        try {
          await fs.access(backupDir)
          await fs.rename(backupDir, finalDir)
        } catch (_) {}
      }
      warn('安装失败：', errorMessage(err))
      return { ok: false, reason: errorMessage(err) }
    } finally {
      inflight.delete(appId)
    }
  }

  /**
   * IPC / 插件入口。
   * @param {{ candidateId: string, session?: Electron.Session, options?: object }} input
   */
  async function install(input: PwaInstallInput): Promise<PwaInstallResult> {
    const candidateId = String(input.candidateId || '')
    if (!candidateId) return { ok: false, reason: '缺少安装信息' }

    const entry = candidateStore.get(candidateId)
    if (!entry) return { ok: false, reason: '安装信息已过期，请刷新页面重试' }
    if (entry.profileId !== currentProfile()) {
      return { ok: false, reason: '安装信息已过期，请刷新页面重试' }
    }

    return commit({ ...entry.candidate, candidateId }, input)
  }

  /**
   * 覆盖安装 / 更新入口（P6 updater 复用）：候选可由页面重新探测得到。
   */
  async function reinstall(record: PwaRecord, candidate: PwaCandidate, input: PwaCommitInput = {}): Promise<PwaInstallResult> {
    if (!record || !candidate) return { ok: false, reason: '缺少应用或安装信息' }
    return commit({ ...candidate, appId: record.id }, input)
  }

  return {
    STAGES,
    install,
    commit,
    reinstall
  }
}
