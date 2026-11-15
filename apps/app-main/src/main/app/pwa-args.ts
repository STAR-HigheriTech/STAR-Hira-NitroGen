/**
 * PWA 命令行参数 —— **唯一真源**。
 *
 * 同一条参数串要在四个地方逐字符一致，否则"双击快捷方式"与"从界面启动"会走到
 * 两个不同的应用（或干脆什么都没发生）：
 *   · 快捷方式 `.lnk` 的 `args`
 *   · 窗口 `setAppDetails({ relaunchCommand })`（任务栏固定 / 重新启动）
 *   · 冷启动 `parsePwaArgs(process.argv)`
 *   · 单实例转发 `second-instance` 的 commandLine
 *
 * ── dev 态为什么首位是 appRoot ────────────────────────────────────
 * 快捷方式的目标永远是 `process.execPath`（dev 下就是 electron.exe）。Electron 只有在
 * 收到「应用目录」时才会加载我们的 main；只给 `--pwa-app=` 会得到一个**空的 Electron
 * 壳**（没有窗口、没有代码）。打包态的可执行文件自带应用，故不需要这个位置参数。
 *
 * ── 为什么 profileId / spaceId 要 encodeURIComponent ───────────────
 * 它们是用户可命名的字符串，可能含空格。`.lnk` 的 args 是一整条字符串、按空格切分，
 * 不编码就会把 `My Work` 拆成两个参数。解码在 parsePwaArgs 里做，两端口径一致。
 */

import { app } from 'electron'
import { getAppRoot } from '@hira-ng/shared-utils'
import { isPackagedRuntime } from './runtime-mode'
import { getRuntimeIdentity } from './runtime-identity'

export interface PwaLaunchArgs {
  appId: string
  profileId: string | null
  spaceId: string | null
  file: string | null
  url: string | null
}

export interface PwaArgInput {
  appId: string
  profileId?: string | null
  spaceId?: string | null
  isPackaged?: boolean
  appRoot?: string
  file?: string | null
  url?: string | null
}

export interface PwaRelaunchInput extends PwaArgInput {
  execPath?: string
}

export const APP_ARG = '--pwa-app='
export const PROFILE_ARG = '--pwa-profile='
export const SPACE_ARG = '--pwa-space='
export const FILE_ARG = '--pwa-file='
export const URL_ARG = '--pwa-url='

/**
 * 当前进程是否打包态。必须与 OS 集成门禁共用同一判据；不能直接看 app.isPackaged，
 * Electron 以脚本方式启动时该值可能误报为 true，从而把 electron.exe 写进快捷方式。
 */
export function isPackaged(): boolean {
  return isPackagedRuntime()
}

/** 应用根目录（dev 态作为 Electron 的首位位置参数）。 */
export function resolveAppRoot(): string {
  try { return getRuntimeIdentity().appRoot } catch (_) {
    try { return getAppRoot(app) } catch (_) { return process.cwd() }
  }
}

function encodeValue(value: unknown): string {
  return encodeURIComponent(String(value == null ? '' : value))
}

function decodeValue(raw: string): string {
  try { return decodeURIComponent(raw) } catch (_) { return raw }
}

/**
 * 解析一组命令行参数。
 * @param {string[]} argv
 * @returns {{ appId: string, profileId: string|null, spaceId: string|null } | null}
 *   没有 `--pwa-app=` 时返回 null（普通启动 / 普通 URL 转发）。
 */
export function parsePwaArgs(argv: readonly string[] | null | undefined): PwaLaunchArgs | null {
  const list = Array.isArray(argv) ? argv : []
  let appId: string | null = null
  let profileId: string | null = null
  let spaceId: string | null = null
  let file: string | null = null
  let url: string | null = null
  for (const raw of list) {
    const arg = String(raw == null ? '' : raw)
    if (arg.startsWith(APP_ARG)) appId = arg.slice(APP_ARG.length) || null
    else if (arg.startsWith(PROFILE_ARG)) {
      profileId = decodeValue(arg.slice(PROFILE_ARG.length)) || null
    } else if (arg.startsWith(SPACE_ARG)) {
      spaceId = decodeValue(arg.slice(SPACE_ARG.length)) || null
    } else if (arg.startsWith(FILE_ARG)) {
      file = decodeValue(arg.slice(FILE_ARG.length)) || null
    } else if (arg.startsWith(URL_ARG)) {
      url = decodeValue(arg.slice(URL_ARG.length)) || null
    }
  }
  if (!appId) return null
  return { appId, profileId, spaceId, file, url }
}

/**
 * 生成 PWA 启动参数数组（已按平台规则决定是否带 appRoot）。
 * @param {{
 *   appId: string,
 *   profileId?: string|null,
 *   spaceId?: string|null,
 *   isPackaged?: boolean,
 *   appRoot?: string
 * }} input
 * @returns {string[]}
 */
export function buildPwaArgs(input: PwaArgInput): string[] {
  const out: string[] = []
  const packaged = input.isPackaged == null ? isPackaged() : !!input.isPackaged
  if (!packaged) out.push(String(input.appRoot || resolveAppRoot()))
  out.push(`${APP_ARG}${input.appId}`)
  if (input.profileId) out.push(`${PROFILE_ARG}${encodeValue(input.profileId)}`)
  if (input.spaceId) out.push(`${SPACE_ARG}${encodeValue(input.spaceId)}`)
  if (input.file) out.push(`${FILE_ARG}${encodeValue(input.file)}`)
  if (input.url) out.push(`${URL_ARG}${encodeValue(input.url)}`)
  return out
}

/** 参数里含空白或引号时必须加引号（`.lnk` / relaunchCommand 都是一条字符串）。 */
export function quoteArg(value: unknown): string {
  const text = String(value == null ? '' : value)
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

/**
 * 快捷方式 args 字符串（`.lnk` 用）。
 * @param {{ appId: string, profileId?: string|null, spaceId?: string|null, isPackaged?: boolean, appRoot?: string }} input
 * @returns {string}
 */
export function buildPwaArgString(input: PwaArgInput): string {
  return buildPwaArgs(input).map(quoteArg).join(' ')
}

/**
 * `setAppDetails({ relaunchCommand })` 用的完整命令行。
 * @param {{ appId: string, profileId?: string|null, spaceId?: string|null, isPackaged?: boolean, appRoot?: string, execPath?: string }} input
 * @returns {string}
 */
export function buildRelaunchCommand(input: PwaRelaunchInput): string {
  const exec = input.execPath || getRuntimeIdentity().executablePath
  return [exec, ...buildPwaArgs(input)].map(quoteArg).join(' ')
}

