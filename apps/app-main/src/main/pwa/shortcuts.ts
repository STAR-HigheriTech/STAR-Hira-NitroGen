/**
 * 快捷方式编排 —— 把「安装记录」翻译成三个位置的 .lnk，并把结果回写数据库。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一层，而不是塞进 install.js
 * ══════════════════════════════════════════════════════════════════
 *  · 安装、卸载、开机启动开关、管理页的「创建/删除快捷方式」四处都要用；
 *  · 失败语义统一：**快捷方式失败不影响安装成功**，只进 failures 列表；
 *  · 平台差异被 infra-pwa 的 driver 吃掉，这里只做"位置 → 目录"的映射。
 *
 * 位置只有三个（文档 §10.1）：start-menu / desktop / startup。
 * 前两个的路径入库（卸载/删除时不必扫目录），startup 不入库 —— 它由
 * `runOnStartup` 布尔值表达，实际文件按 `--pwa-app=<id>` 扫描得到。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  resolveLocations,
  uniqueShortcutPath,
  getShortcutDriver,
  isShortcutSupported,
  type ShortcutDriver
} from '@hira-ng/infra-pwa'
import * as identity from './identity'
import type { PwaPaths } from './paths'

interface PwaRecord {
  id: string
  profileId?: string
  desktopShortcut?: string | null
  startMenuShortcut?: string | null
  runOnStartup?: boolean
  iconIcoPath?: string | null
  name?: string
  shortName?: string
}

interface PwaShortcutService {
  getRecord(appId: string): PwaRecord | null | undefined
  setFlags(appId: string, flags: Record<string, unknown>): unknown
}

export interface SystemIntegrationPolicy {
  enabled: boolean
  reason?: string
}

export interface PwaShortcutsPorts {
  pwaService: PwaShortcutService
  paths: PwaPaths
  getProfileId(): string
  appName?: string
  /** 是否允许创建会落到 OS 的入口；缺省允许（测试/纯原子调用）。 */
  getSystemIntegrationPolicy?(): SystemIntegrationPolicy
  logger?: { warn?(...args: unknown[]): void }
}

interface ShortcutFailure { location?: string; filePath?: string; reason?: string }

type PwaShortcutLocation = 'start-menu' | 'desktop' | 'startup'

export interface PwaShortcutSyncOptions {
  createDesktopShortcut?: boolean
  createStartMenuShortcut?: boolean
  runOnStartup?: boolean
}

export interface PwaShortcutSyncResult {
  ok: boolean
  reason?: string
  /** true = 当前运行时不写系统，但历史开发态入口已收敛清理。 */
  suppressed?: boolean
  failures: ShortcutFailure[]
  desktop?: Record<string, unknown> | null
  startMenu?: Record<string, unknown> | null
  startup?: Record<string, unknown> | null
}

export const LOCATIONS = Object.freeze({
  START_MENU: 'start-menu',
  DESKTOP: 'desktop',
  STARTUP: 'startup'
})

/** 文档 §11.3 只允许这两个位置从 IPC 进来。 */
export const PUBLIC_LOCATIONS: readonly string[] = Object.freeze([LOCATIONS.DESKTOP, LOCATIONS.START_MENU])

export function isPublicLocation(location: unknown): boolean {
  return PUBLIC_LOCATIONS.includes(String(location))
}

/** Windows 命令行拆分：本项目生成的参数值里没有任何空白，直接按空白切即可。 */
function splitArgs(raw: unknown): string[] {
  return String(raw || '').trim().split(/\s+/).filter(Boolean)
}

/**
 * @param {{
 *   pwaService: object,
 *   paths: ReturnType<typeof import('./paths').createPwaPaths>,
 *   getProfileId: () => string,
 *   appName?: string,
 *   logger?: { warn?: Function }
 * }} ports
 */
export function createPwaShortcuts(ports: PwaShortcutsPorts) {
  const {
    pwaService,
    paths,
    getProfileId,
    appName = '',
    getSystemIntegrationPolicy,
    logger = console
  } = ports
  if (!pwaService) throw new TypeError('createPwaShortcuts 缺少 pwaService')
  if (!paths) throw new TypeError('createPwaShortcuts 缺少 paths')
  if (typeof getProfileId !== 'function') throw new TypeError('createPwaShortcuts 缺少 getProfileId')

  function warn(...args: unknown[]): void {
    if (logger && typeof logger.warn === 'function') logger.warn('[pwa-shortcut]', ...args)
  }

  function currentProfile(): string {
    try { return String(getProfileId() || 'default') } catch (_) { return 'default' }
  }

  function profileOf(record: PwaRecord): string {
    return (record && record.profileId) || currentProfile()
  }

  /** 目录只有这里算一次；resolveLocations 依赖 electron.app，必须运行时调用。 */
  function dirFor(location: PwaShortcutLocation): string {
    const locs = resolveLocations(appName)
    if (location === LOCATIONS.DESKTOP) return locs.desktop
    if (location === LOCATIONS.STARTUP) return locs.startup
    return locs.startMenu
  }

  /** 只回答“当前平台有没有驱动”；读/删历史入口不受开发态写入门禁影响。 */
  function driver(): ShortcutDriver | null {
    if (!isShortcutSupported()) return null
    return getShortcutDriver()
  }

  function systemPolicy(): SystemIntegrationPolicy {
    try {
      const value = typeof getSystemIntegrationPolicy === 'function'
        ? getSystemIntegrationPolicy()
        : { enabled: true }
      return { enabled: value?.enabled === true, reason: value?.reason }
    } catch (_) {
      return { enabled: false, reason: '无法确认系统集成状态' }
    }
  }

  /** 入参既可以是记录，也可以是 appId。 */
  function resolveRecord(input: PwaRecord | string | null | undefined): PwaRecord | null {
    if (!input) return null
    if (typeof input === 'object' && input.id) return input
    try { return pwaService.getRecord(String(input)) || null } catch (_) { return null }
  }

  /**
   * 快捷方式图标：优先 icon.ico（Windows 最认），没有就回落主程序图标。
   * 图标缺失只影响观感，绝不阻断创建。
   */
  async function iconFor(record: PwaRecord): Promise<string> {
    const drv = driver()
    if (record && record.iconIcoPath && drv && typeof drv.exists === 'function') {
      try {
        // 用 DB 里记录的真实文件名（而不是写死 icon.ico）—— 资产命名将来变化时
        // 这里不会静默失配成"快捷方式永远是默认图标"。
        const file = paths.assetPath(profileOf(record), record.id, record.iconIcoPath)
        if (await drv.exists(file)) return file
      } catch (_) {}
    }
    return identity.shortcutTarget()
  }

  /**
   * 扫一个目录里指向某个应用的 .lnk（startup 清理、以及 DB 路径丢失时的兜底）。
   * @returns {Promise<string[]>} 绝对路径
   */
  async function scan(dir: string, appId: string): Promise<string[]> {
    const drv = driver()
    if (!drv || typeof drv.read !== 'function') return []
    let names
    try {
      names = await fs.readdir(dir)
    } catch (_) {
      return []
    }
    // Windows 路径大小写不敏感（`C:\APP\App.exe` 与 `c:\app\app.exe` 是同一个文件），
    // 直接 === 比较会把用户自己启动过一次、被系统重写盘符大小写的 .lnk 判成"别人的"。
    const target = String(identity.shortcutTarget()).toLowerCase()
    const out: string[] = []
    for (const name of names) {
      if (!/\.lnk$/i.test(name)) continue
      const file = path.join(dir, name)
      const details = await drv.read(file)
      if (!details) continue
      if (details.target && String(details.target).toLowerCase() !== target) continue
      if (!identity.matchesAppArg(splitArgs(details.args), appId)) continue
      out.push(file)
    }
    return out
  }

  /**
   * 该记录在某个位置现有的 .lnk。
   *
   * DB 里存的是"上次创建时的路径"，**不是事实**：用户完全可能在资源管理器里
   * 直接把桌面图标拖进回收站。此时若照搬 DB 路径，`sync` 会认为"已存在"而
   * 跳过创建 —— UI 勾着、磁盘上空着，这正是重装后快捷方式消失的那类投诉。
   * 所以 DB 路径必须先验存在性，失效就回落扫目录。
   */
  async function existingPaths(record: PwaRecord, location: PwaShortcutLocation): Promise<string[]> {
    const stored =
      location === LOCATIONS.DESKTOP ? record.desktopShortcut :
      location === LOCATIONS.START_MENU ? record.startMenuShortcut :
      null
    const drv = driver()
    const found: string[] = []
    if (stored && drv && typeof drv.exists === 'function' && await drv.exists(stored)) {
      found.push(stored)
    }
    if (location === LOCATIONS.STARTUP || found.length === 0) {
      const scanned = await scan(dirFor(location), record.id)
      for (const file of scanned) if (!found.includes(file)) found.push(file)
    }
    return found
  }

  async function removePaths(files: string[]): Promise<{ ok: boolean; removed: number; failures: ShortcutFailure[] }> {
    const drv = driver()
    if (!drv) return { ok: true, removed: 0, failures: [] }
    let removed = 0
    const failures: ShortcutFailure[] = []
    for (const file of files) {
      const result = await drv.remove({ filePath: file, expectedTarget: identity.shortcutTarget() })
      if (result.ok) {
        if (result.removed) removed += 1
      } else {
        failures.push({ filePath: file, reason: result.reason })
      }
    }
    return { ok: failures.length === 0, removed, failures }
  }

  /**
   * 把「该位置是否还有 .lnk」写回数据库。
   *
   * 三个位置都必须收敛：startup 之前不入库，导致自动清理/失败后
   * `runOnStartup` 仍是 true —— UI 说"开机启动已开"，磁盘上却没有文件。
   * 现在文件是唯一事实源，标记只是它的投影。
   */
  async function persistFlag(record: PwaRecord, location: PwaShortcutLocation, filePath: string | null): Promise<void> {
    if (location === LOCATIONS.DESKTOP) pwaService.setFlags(record.id, { desktopShortcut: filePath })
    else if (location === LOCATIONS.START_MENU) pwaService.setFlags(record.id, { startMenuShortcut: filePath })
    else if (location === LOCATIONS.STARTUP) pwaService.setFlags(record.id, { runOnStartup: !!filePath })
  }

  /**
   * 在指定位置创建快捷方式。
   * @param {object|string} input 记录或 appId
   * @param {'start-menu'|'desktop'|'startup'} [location]
   * @returns {Promise<{ ok: true, filePath: string, location: string }
   *                  | { ok: false, reason: string }>}
   */
  async function create(input: PwaRecord | string, location: PwaShortcutLocation = LOCATIONS.START_MENU) : Promise<{ ok: true, filePath: string, location: string }
                 | { ok: false, reason: string }> {
    const drv = driver()
    if (!drv) return { ok: false, reason: '当前平台不支持快捷方式' }
    const policy = systemPolicy()
    if (!policy.enabled) return { ok: false, reason: policy.reason || '当前运行时不允许写入系统快捷方式' }
    const record = resolveRecord(input)
    if (!record) return { ok: false, reason: '应用不存在' }

    const dir = dirFor(location)
    const filePath = await uniqueShortcutPath(dir, identity.shortcutName(record))
    const result = await drv.create({
      filePath,
      target: identity.shortcutTarget(),
      args: identity.shortcutArgs(record.id, profileOf(record)),
      icon: await iconFor(record),
      iconIndex: 0,
      appUserModelId: identity.toAumid(record.id),
      description: String(record.name || record.shortName || '').slice(0, 260)
    })
    if (!result.ok) return result

    await persistFlag(record, location, filePath)
    return { ok: true, filePath, location }
  }

  /**
   * 删除指定位置的快捷方式。找不到也算成功（幂等）。
   */
  async function remove(input: PwaRecord | string, location: PwaShortcutLocation = LOCATIONS.START_MENU) {
    const record = resolveRecord(input)
    if (!record) return { ok: false, reason: '应用不存在' }
    const files = await existingPaths(record, location)
    const result = await removePaths(files)
    // 只在真的删干净后清标记：删失败还清，下次就找不到这个文件了。
    if (result.ok) await persistFlag(record, location, null)
    if (!result.ok) warnings(result.failures)
    return { ok: result.ok, removed: result.removed, failures: result.failures }
  }

  function warnings(failures: readonly ShortcutFailure[]): void {
    for (const f of failures || []) warn('删除失败：', f.location || '', f.filePath, f.reason)
  }

  /** 删除三个位置的**全部**快捷方式（卸载 / 关闭开机启动时用）。 */
  async function removeAll(input: PwaRecord | string) {
    const record = resolveRecord(input)
    if (!record) return { ok: false, reason: '应用不存在' }
    const failures: ShortcutFailure[] = []
    for (const location of Object.values(LOCATIONS)) {
      const files = await existingPaths(record, location)
      const result = await removePaths(files)
      // 每个位置独立收敛：某个目录没权限，不该把别的位置的标记也清掉。
      if (result.ok) await persistFlag(record, location, null)
      if (result.failures && result.failures.length) {
        failures.push(...result.failures.map((f) => ({ ...f, location })))
      }
    }
    warnings(failures)
    return { ok: failures.length === 0, failures }
  }

  /**
   * 开机启动开关（独立于安装：管理页可以随时切换）。
   *
   * 标记与文件在**同一个方法里**一起收敛 —— 开关的 UI 状态必须等于磁盘事实，
   * 否则用户重启后才发现"开着却没启动"（或反过来）。调用方（IPC / 插件）
   * 不需要再各自 setFlags 一遍。
   */
  async function setStartup(input: PwaRecord | string, enabled: boolean) {
    const record = resolveRecord(input)
    if (!record) return { ok: false, reason: '应用不存在' }
    if (!enabled) {
      const files = await existingPaths(record, LOCATIONS.STARTUP)
      const result = await removePaths(files)
      if (result.ok) pwaService.setFlags(record.id, { runOnStartup: false })
      return { ok: result.ok, enabled: false, failures: result.failures }
    }
    if (!driver()) {
      return { ok: false, reason: '当前平台不支持开机启动快捷方式' }
    }
    const policy = systemPolicy()
    if (!policy.enabled) {
      const files = await existingPaths(record, LOCATIONS.STARTUP)
      if (files.length) await removePaths(files)
      pwaService.setFlags(record.id, { runOnStartup: false })
      return { ok: false, enabled: false, reason: policy.reason || '当前运行时不允许写入开机启动项' }
    }
    const files = await existingPaths(record, LOCATIONS.STARTUP)
    if (files.length) {
      pwaService.setFlags(record.id, { runOnStartup: true })
      return { ok: true, enabled: true, filePath: files[0] }
    }
    const result = await create(record, LOCATIONS.STARTUP)
    // create → persistFlag 已经把 runOnStartup 落成 true，这里不再重复写库。
    return result.ok
      ? { ok: true, enabled: true, filePath: result.filePath }
      : { ok: false, enabled: false, reason: result.reason }
  }

  /**
   * 安装管线第 8 步：按用户勾选同步三个位置。
   *
   * 语义刻意做成"收敛到目标状态"：
   *  · 勾选且已存在 → 保留（覆盖安装不产生 `应用 (2).lnk`）；
   *  · 未勾选 → 删除（覆盖安装时取消勾选能真正清掉）。
   *
   * 永不抛异常：任何一项失败都进 failures，安装照样成功。
   *
   * @param {object} input 记录
   * @param {{ createDesktopShortcut?: boolean, createStartMenuShortcut?: boolean, runOnStartup?: boolean }} options
   */
  async function sync(input: PwaRecord | string, options: PwaShortcutSyncOptions = {}): Promise<PwaShortcutSyncResult> {
    const record = resolveRecord(input)
    if (!record) return { ok: false, reason: '应用不存在', failures: [] }
    const failures: ShortcutFailure[] = []
    const results: Record<'desktop' | 'startMenu' | 'startup', Record<string, unknown> | null> = { desktop: null, startMenu: null, startup: null }

    if (!driver()) {
      return { ok: false, reason: '当前平台不支持快捷方式', failures: [], ...results }
    }

    // 开发态不新增任何系统入口，但会清掉 DB 记录的旧开发快捷方式。
    // 这是“收敛”而不是“安装失败”：PWA 本身仍可运行，UI 不会收到假故障。
    const policy = systemPolicy()
    if (!policy.enabled) {
      for (const location of Object.values(LOCATIONS)) {
        const files = await existingPaths(record, location)
        const removed = files.length ? await removePaths(files) : { ok: true, removed: 0, failures: [] }
        if (removed.ok) await persistFlag(record, location, null)
        if (removed.failures && removed.failures.length) {
          failures.push(...removed.failures.map((f) => ({ ...f, location })))
        }
      }
      warnings(failures)
      return {
        ok: failures.length === 0,
        suppressed: true,
        reason: policy.reason || '当前运行时不写入系统快捷方式',
        failures,
        desktop: { ok: true, suppressed: true },
        startMenu: { ok: true, suppressed: true },
        startup: { ok: true, suppressed: true }
      }
    }

    const desired = {
      [LOCATIONS.DESKTOP]: !!options.createDesktopShortcut,
      [LOCATIONS.START_MENU]: !!options.createStartMenuShortcut,
      [LOCATIONS.STARTUP]: !!options.runOnStartup
    }

    for (const [location, enabled] of Object.entries(desired) as Array<[PwaShortcutLocation, boolean]>) {
      const files = await existingPaths(record, location)
      const key = location === LOCATIONS.START_MENU ? 'startMenu' : location
      if (enabled) {
        if (files.length) {
          results[key] = { ok: true, filePath: files[0] }
          await persistFlag(record, location, files[0])
          continue
        }
        const created = await create(record, location)
        results[key] = created
        if (!created.ok) failures.push({ location, reason: created.reason })
      } else {
        // 即使没找到文件也要收敛标记：用户取消勾选后，DB 里不能留着旧路径 /
        // runOnStartup=true。删失败时才保留标记（否则下次再也找不到它）。
        const removed = files.length ? await removePaths(files) : { ok: true, removed: 0, failures: [] }
        if (removed.ok) await persistFlag(record, location, null)
        results[key] = { ok: removed.ok, removed: removed.removed }
        if (removed.failures && removed.failures.length) {
          failures.push(...removed.failures.map((f) => ({ ...f, location })))
        }
      }
    }

    warnings(failures)
    return {
      ok: failures.length === 0,
      failures,
      desktop: results.desktop,
      startMenu: results.startMenu,
      startup: results.startup
    }
  }

  return {
    LOCATIONS,
    isPublicLocation,
    dirFor,
    create,
    remove,
    removeAll,
    setStartup,
    sync,
    scan
  }
}

