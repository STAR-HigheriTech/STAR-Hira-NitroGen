/**
 * 快捷方式 —— 按平台驱动的原子能力（本期只实现 Windows）。
 *
 * 为什么做成 driver 表而不是 if (win32)：
 *  · macOS 的"应用快捷方式"是 `.app` 别名，Linux 是 `.desktop`，
 *    三者的参数结构完全不同；用驱动表能让调用方完全无感地扩平台。
 *  · 新增平台 = registerShortcutDriver('darwin', {...})，不改任何调用点。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import type { App, Shell, ShortcutDetails } from 'electron'

export interface ShortcutCreateOptions {
  filePath: string
  target: string
  args?: string
  cwd?: string
  icon?: string | null
  iconIndex?: number
  appUserModelId?: string
  description?: string
}

export interface ShortcutCreateResult {
  ok: true
  filePath: string
}

export interface ShortcutFailure {
  ok: false
  reason: string
}

export interface ShortcutDriver {
  id: string
  isSupported?(): boolean
  create(options: ShortcutCreateOptions): Promise<ShortcutCreateResult | ShortcutFailure>
  remove(options: { filePath: string; expectedTarget?: string }): Promise<{ ok: true; removed: boolean } | ShortcutFailure>
  exists(filePath: string): Promise<boolean>
  read(filePath: string): Promise<ShortcutDetails | null>
}

interface ElectronApi {
  app: App
  shell: Shell
}

const DRIVERS = new Map<string, ShortcutDriver>()

function getElectron(): ElectronApi {
  // 延迟取：本模块在 app ready 之前也可能被 require（只做字符串拼装时不需要 electron）。
  return require('electron') as ElectronApi
}

function isWindows() {
  return process.platform === 'win32'
}

/** 默认位置。appName 只影响开始菜单里的分组目录名。 */
export function resolveLocations(appName?: string): { desktop: string; startMenu: string; startup: string } {
  const { app } = getElectron()
  const appData = app.getPath('appData')
  const productName = String(appName || app.getName() || '应用').trim() || '应用'
  return {
    desktop: app.getPath('desktop'),
    startMenu: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', productName),
    startup: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  }
}

/** 同名快捷方式唯一化：`名称.lnk` → `名称 (2).lnk`。 */
export async function uniqueShortcutPath(dir: string, baseName: string): Promise<string> {
  const safe = String(baseName || '应用').trim() || '应用'
  for (let i = 1; i < 100; i += 1) {
    const name = i === 1 ? `${safe}.lnk` : `${safe} (${i}).lnk`
    const candidate = path.join(dir, name)
    try {
      await fs.access(candidate)
    } catch (_) {
      return candidate
    }
  }
  return path.join(dir, `${safe} (${Date.now()}).lnk`)
}

export const windowsDriver: ShortcutDriver = {
  id: 'windows',
  isSupported: () => isWindows(),

  /**
   * @param {{ filePath: string, target: string, args?: string, cwd?: string,
   *           icon?: string|null, iconIndex?: number, appUserModelId?: string,
   *           description?: string }} options
   * @returns {Promise<{ ok: true, filePath: string } | { ok: false, reason: string }>}
   */
  async create(options: ShortcutCreateOptions) : Promise<{ ok: true, filePath: string } | { ok: false, reason: string }> {
    const filePath = String(options && options.filePath ? options.filePath : '')
    const target = String(options && options.target ? options.target : '')
    if (!filePath || !target) return { ok: false, reason: '缺少快捷方式路径或目标' }

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const details: ShortcutDetails = {
      target,
      args: options.args || '',
      cwd: options.cwd || path.dirname(target),
      description: String(options.description || '').slice(0, 260),
      icon: options.icon || target,
      iconIndex: Number.isInteger(options.iconIndex) ? options.iconIndex : 0,
      appUserModelId: options.appUserModelId ? String(options.appUserModelId) : undefined
    }

    try {
      const { shell } = getElectron()
      const ok = shell.writeShortcutLink(filePath, 'create', details)
      return ok ? { ok: true, filePath } : { ok: false, reason: 'writeShortcutLink 返回失败' }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  /**
   * 删除前校验 target，避免误删用户自己建的、恰好同名的快捷方式。
   * @param {{ filePath: string, expectedTarget?: string }} options
   */
  async remove(options: { filePath: string; expectedTarget?: string }) {
    const filePath = String(options && options.filePath ? options.filePath : '')
    if (!filePath) return { ok: false, reason: '缺少快捷方式路径' }
    try {
      await fs.access(filePath)
    } catch (_) {
      return { ok: true, removed: false }
    }
    try {
      const { shell } = getElectron()
      const details = shell.readShortcutLink(filePath)
      const expected = String(options.expectedTarget || '')
      const actual = String(details?.target || '')
      if (expected && actual && path.win32.normalize(actual).toLowerCase() !== path.win32.normalize(expected).toLowerCase()) {
        return { ok: false, reason: '快捷方式目标不匹配，已跳过' }
      }
      await fs.unlink(filePath)
      return { ok: true, removed: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  async exists(filePath: string) {
    try {
      await fs.access(String(filePath))
      return true
    } catch (_) {
      return false
    }
  },

  /**
   * 读取快捷方式详情（扫描 startup / 校验归属用）。
   * 读不到（不存在、非 .lnk、权限）统一返回 null，不抛。
   * @returns {Promise<{ target: string, args: string, icon?: string } | null>}
   */
  async read(filePath: string) : Promise<{ target: string, args: string, icon?: string } | null> {
    try {
      const { shell } = getElectron()
      const details = shell.readShortcutLink(String(filePath))
      return details ? {
        target: String(details.target || ''),
        args: String(details.args || ''),
        icon: details.icon ? String(details.icon) : undefined
      } : null
    } catch (_) {
      return null
    }
  }
}

DRIVERS.set('win32', windowsDriver)

/** 扩展点：新增平台驱动。 */
export function registerShortcutDriver(platform: string, driver: ShortcutDriver): void {
  if (!platform || !driver || typeof driver.create !== 'function' || typeof driver.remove !== 'function') {
    throw new Error('registerShortcutDriver 需要 { create, remove }')
  }
  DRIVERS.set(String(platform), driver)
}

export function getShortcutDriver(platform = process.platform): ShortcutDriver | null {
  return DRIVERS.get(String(platform)) || null
}

/** 当前平台能否创建快捷方式（不能时安装仍应成功，只是没有快捷方式）。 */
export function isShortcutSupported(platform = process.platform): boolean {
  const driver = getShortcutDriver(platform)
  return !!(driver && (typeof driver.isSupported !== 'function' || driver.isSupported()))
}

