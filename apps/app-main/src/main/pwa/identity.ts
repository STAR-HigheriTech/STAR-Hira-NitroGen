/**
 * PWA 身份 —— AUMID / 快捷方式参数 / 名称，**唯一生成点**。
 *
 * 三处必须逐字符一致，否则 Windows 会把同一个应用当成三个不同的东西：
 *   · 窗口 `win.setAppDetails({ appId })`   → 任务栏分组
 *   · 快捷方式 `.lnk` 的 `appUserModelId`   → 固定项 / 开始菜单归属
 *   · 冷启动 argv `--pwa-app=<id>`          → 回到同一个应用
 * 所以这里只写一遍，其它模块一律调用。
 */

import * as pwaArgs from '../app/pwa-args'
import { getRuntimeIdentity } from '../app/runtime-identity'

const { rules } = require('@hira-ng/domain-pwa') as {
  rules: { sanitizeShortcutName(name: unknown, startUrl: unknown): string }
}

interface PwaRecord {
  shortName?: unknown
  name?: unknown
  startUrl?: unknown
}

/** 正式应用级 AUMID 前缀（保留导出，兼容既有消费者）。 */
export const AUMID_PREFIX = 'com.starhigheritech.hira-ng.pwa.'

// 参数前缀与解析器**不在本文件重复定义**：唯一真源是 app/pwa-args.ts。
// 这里只做转出口，让「身份」这一侧仍能一处拿到全部常量。
const { APP_ARG, PROFILE_ARG, SPACE_ARG } = pwaArgs

export function toAumid(appId: unknown): string {
  return `${getRuntimeIdentity().pwaAumidPrefix}${String(appId || '')}`
}

/** 从 AUMID 反解 appId；同时兼容正式态与开发态历史前缀。 */
export function fromAumid(aumid: unknown): string | null {
  const value = String(aumid || '')
  const current = getRuntimeIdentity().pwaAumidPrefix
  if (value.startsWith(current)) return value.slice(current.length)
  return value.startsWith(AUMID_PREFIX) ? value.slice(AUMID_PREFIX.length) : null
}

/** 开发态用独立前缀，避免任务栏把应用窗与正式安装版合并。 */
export function currentAumidPrefix(): string {
  return getRuntimeIdentity().pwaAumidPrefix
}

/** 当前运行时的快捷方式目标；系统写入前仍必须经过 systemIntegrationEnabled 门禁。 */
export function shortcutTarget(): string {
  return getRuntimeIdentity().executablePath
}

/**
 * 快捷方式 / 冷启动共用的参数串。
 * dev 态由 buildPwaArgs 自动补上 appRoot（见 app/pwa-args.ts 文件头）。
 */
export function shortcutArgs(appId: string, profileId?: string | null, spaceId?: string | null): string {
  return pwaArgs.buildPwaArgString({ appId, profileId, spaceId })
}

/** 快捷方式显示名：优先 short_name，回落 name，再回落域名。 */
export function shortcutName(record: PwaRecord | null | undefined): string {
  const row: PwaRecord = record || {}
  return rules.sanitizeShortcutName(row.shortName || row.name, row.startUrl)
}

/**
 * 判断一组命令行参数是不是「启动某个 PWA 应用」。
 * 启动目录清理（开机启动）与单实例转发都用它 —— 解析口径统一在 app/pwa-args.ts。
 * @returns {{ appId: string, profileId: string|null, spaceId: string|null } | null}
 */
export const parsePwaArgs = pwaArgs.parsePwaArgs

/** 该参数列表是否指向某个 appId（清理开机启动快捷方式时用）。 */
export function matchesAppArg(argv: readonly string[], appId: unknown): boolean {
  const parsed = parsePwaArgs(argv)
  return !!parsed && !!parsed.appId && parsed.appId === String(appId)
}

export { APP_ARG, PROFILE_ARG, SPACE_ARG }
