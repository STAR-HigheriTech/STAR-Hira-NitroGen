import os from 'node:os'
import path from 'node:path'

const platform = process.platform
const arch = process.arch

export function isWin(): boolean {
  return platform === 'win32'
}

export function isMac(): boolean {
  return platform === 'darwin'
}

export function isLinux(): boolean {
  return platform === 'linux'
}

export function getHomeDir(): string {
  return os.homedir()
}

export function getAppDataDir(appName?: string): string {
  const name = appName || 'hira-ng'

  if (isWin()) {
    const base = process.env.APPDATA || path.join(getHomeDir(), 'AppData', 'Roaming')
    return path.join(base, name)
  }

  if (isMac()) return path.join(getHomeDir(), 'Library', 'Application Support', name)

  const xdg = process.env.XDG_CONFIG_HOME || path.join(getHomeDir(), '.config')
  return path.join(xdg, name)
}

export { platform, arch }
export default {
  platform,
  arch,
  isWin,
  isMac,
  isLinux,
  getHomeDir,
  getAppDataDir
}
