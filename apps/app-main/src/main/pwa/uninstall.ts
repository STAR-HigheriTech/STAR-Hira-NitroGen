/**
 * 卸载编排 —— 关闭窗口 → 清快捷方式 → 删记录 → 删资产目录。
 *
 * ══════════════════════════════════════════════════════════════════
 * 顺序为什么是这样（唯一需要理解的一点）
 * ══════════════════════════════════════════════════════════════════
 *  1. **快捷方式**：`shortcuts.removeAll` 内部会 `pwaService.setFlags`，
 *     因此必须**在删除数据库记录之前**调用，否则标记无处可写。
 *     失败只 warn —— 桌面不让写不该把卸载卡死（文档 §13.3）。
 *  2. **数据库**：唯一必须成功的步骤。删不掉就直接返回失败，保留资产目录，
 *     用户还能看到应用并重试。
 *  3. **资产目录**：数据库已删，这里失败只 warn（残留目录不影响正确性，
 *     下次同 appId 安装会覆盖它）。
 *  4. **关窗放在最后**：PWA-only 模式下关闭最后一个应用窗会触发 `app.quit()`，
 *     若先关窗，删除流程可能被进程退出打断（留下"假卸载"记录）。
 *     关窗时窗口 flush 几何写的是已删除的记录 → 域服务自然空操作，无副作用。
 *
 * ── profile 口径 ──────────────────────────────────────────────────
 * 整个流程包在 `runWithProfile(profileId, …)` 里：pwaService 按当前 profile
 * 分区，卸载必须显式指定（IPC 传入 / 冷启动上下文解析），不能靠默认值。
 */

import fs from 'node:fs/promises'
import type { PwaPaths } from './paths'

interface PwaRecord {
  [key: string]: unknown
}

interface PwaUninstallService {
  getRecord(appId: string): PwaRecord | null | undefined
  remove(appId: string): { ok?: boolean; reason?: string } | null | undefined
}

interface PwaUninstallShortcuts {
  removeAll(record: PwaRecord): Promise<{ failures?: unknown[] } | void> | { failures?: unknown[] } | void
}

interface PwaUninstallRuntime { close(appId: string): void }
interface PwaUninstallIntegrations { remove(record: PwaRecord): Promise<unknown> | unknown }

interface ProfileRuntimeRegistry {
  runWithProfile?<T>(profileId: string, task: () => T): T
}

export interface PwaUninstallerPorts {
  pwaService: PwaUninstallService
  pwaRuntime: PwaUninstallRuntime
  pwaShortcuts: PwaUninstallShortcuts
  pwaIntegrations?: PwaUninstallIntegrations
  paths: PwaPaths
  runtimeRegistry?: ProfileRuntimeRegistry
  getProfileId(): string
  logger?: { warn?(...args: unknown[]): void }
}

export type PwaUninstallResult = { ok: true } | { ok: false; reason: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * @param {{
 *   pwaService: object,
 *   pwaRuntime: object,
 *   pwaShortcuts: object,
 *   paths: ReturnType<typeof import('./paths').createPwaPaths>,
 *   runtimeRegistry?: { runWithProfile?: Function },
 *   getProfileId: () => string,
 *   logger?: { warn?: Function }
 * }} ports
 */
export function createPwaUninstaller(ports: PwaUninstallerPorts): { uninstall(id: unknown, profileId?: string): Promise<PwaUninstallResult> } {
  const { pwaService, pwaRuntime, pwaShortcuts, paths, getProfileId, logger = console } = ports
  if (!pwaService || !pwaRuntime || !pwaShortcuts || !paths) {
    throw new TypeError('createPwaUninstaller 缺少 pwaService / pwaRuntime / pwaShortcuts / paths')
  }
  if (typeof getProfileId !== 'function') throw new TypeError('createPwaUninstaller 缺少 getProfileId')

  function warn(...args: unknown[]): void {
    if (logger && typeof logger.warn === 'function') logger.warn('[pwa-uninstall]', ...args)
  }

  function resolveProfile(profileId: string | undefined): string {
    if (profileId) return String(profileId)
    try {
      return String(getProfileId() || 'default')
    } catch (_) {
      return 'default'
    }
  }

  function withProfile<T>(profileId: string, fn: () => T): T {
    const registry = ports.runtimeRegistry
    if (registry && typeof registry.runWithProfile === 'function') {
      try {
        return registry.runWithProfile(profileId, fn)
      } catch (_) {
        // 注册表未就绪：退化为直接执行（pwaService 会回落 default）。
      }
    }
    return fn()
  }

  /**
   * @param {string} id
   * @param {string} [profileId] 缺省 = 当前上下文 profile
   * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
   */
  async function uninstall(id: unknown, profileId?: string): Promise<PwaUninstallResult> {
    const appId = String(id == null ? '' : id).trim()
    if (!appId) return { ok: false, reason: '缺少应用 id' }
    const pid = resolveProfile(profileId)

    return withProfile(pid, async () => {
      const record = pwaService.getRecord(appId)
      if (!record) return { ok: false, reason: '应用不存在' }

      // 1. 快捷方式（失败只 warn）
      try {
        const result = await pwaShortcuts.removeAll(record)
        if (result && result.failures && result.failures.length) {
          warn('部分快捷方式删除失败：', result.failures.length, '个')
        }
      } catch (err) {
        warn('清理快捷方式异常：', errorMessage(err))
      }

      // 2. 数据库记录（唯一必需成功的步骤）
      if (ports.pwaIntegrations) {
        try { await ports.pwaIntegrations.remove(record) } catch (err) {
          warn('清理文件 / 协议关联失败：', errorMessage(err))
        }
      }
      const removed = pwaService.remove(appId)
      if (!removed || !removed.ok) {
        return { ok: false, reason: (removed && removed.reason) || '删除应用记录失败' }
      }

      // 3. 资产目录（失败只 warn）
      try {
        await fs.rm(paths.assetDir(pid, appId), { recursive: true, force: true })
      } catch (err) {
        warn('删除应用文件失败：', errorMessage(err))
      }

      // 4. 关窗（未打开 → 忽略；PWA-only 下最后一个窗口关闭会退出进程，
      //    所以必须是最后一步，见文件头）
      try {
        pwaRuntime.close(appId)
      } catch (err) {
        warn('关闭应用窗口失败：', errorMessage(err))
      }

      return { ok: true }
    })
  }

  return { uninstall }
}

