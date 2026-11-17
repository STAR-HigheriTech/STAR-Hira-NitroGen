/**
 * page-reload —— 「刷新」的**唯一语义实现**。
 *
 * 错误页与安全警告页都是过渡视图，不是用户要访问的页面：此刻
 * `webContents.getURL()` 是 `hira://error?...` / `hira://security-warning?...`，
 * 直接 `reload()` 只会把过渡页再加载一遍。用户按刷新想重试的是**原网址**。
 *
 * 所以「刷新」只有两条分支，且必须全项目同源：
 *   · 当前在错误页 / 安全警告页 → `loadURL(目标地址)`（= 重试 / 继续前往）；
 *   · 其余情况     → `reload()`（保留 POST / 滚动等原生语义）。
 *
 * 消费者：
 *   · `TabManager#reload`（工具栏 / 快捷键 / IPC）；
 *   · `showWebContentMenu`（标签、独立侧栏、PWA 窗口共用的右键菜单）；
 *   · 独立侧栏顶条的刷新命令。
 * 三处若各写一份 `wc.reload()`，错误页在任意一处仍会「刷新错误页」。
 *
 * 失败地址优先取宿主记录（标签的 `t.error.url`）：错误页自己 `replaceState`
 * 过之后 query 可能被裁剪，宿主记录才是权威；没有记录时才从 URL 解析。
 */

import type { WebContents } from 'electron'

const { isWebErrorUrl, failedUrlOfErrorPage } = require('@hira-ng/shared-types/src/web-error')
const { isSecurityWarningUrl, targetUrlOfSecurityWarning } =
  require('@hira-ng/shared-types/src/security-warning')

/**
 * 当前页面地址（webContents 不可用时返回 ''）。
 * @param {Electron.WebContents|null|undefined} wc
 * @returns {string}
 */
function liveUrlOf(wc: WebContents | null | undefined): string {
  try {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return ''
    return String(wc.getURL() || '')
  } catch {
    return ''
  }
}

/**
 * 当前是否停在错误页；是 → 返回应该重试的地址，否则返回 ''。
 * @param {Electron.WebContents|null|undefined} wc
 * @param {string} [fallbackUrl] 宿主记录的失败地址（优先于 URL 解析）
 * @returns {string}
 */
export function retryUrlOf(wc: WebContents | null | undefined, fallbackUrl: string = ''): string {
  const current = liveUrlOf(wc)
  if (isSecurityWarningUrl(current)) return targetUrlOfSecurityWarning(current)
  if (!isWebErrorUrl(current)) return ''
  const recorded = String(fallbackUrl == null ? '' : fallbackUrl).trim()
  if (recorded && !isWebErrorUrl(recorded)) return recorded
  return failedUrlOfErrorPage(current)
}

/**
 * 刷新一个 webContents：错误页 → 重试失败地址；普通页 → 原生 reload。
 * @param {Electron.WebContents|null|undefined} wc
 * @param {string} [fallbackUrl] 宿主记录的失败地址
 * @param {{ ignoreCache?: boolean }} [options] `ignoreCache` = 强制刷新（Ctrl+Shift+R）。
 *   错误页没有缓存可绕过，因此重试分支与普通刷新一致（都是 loadURL 原网址）。
 * @returns {'retry'|'reload'|'noop'}
 */
export function reloadOrRetry(
  wc: WebContents | null | undefined,
  fallbackUrl: string = '',
  options: { ignoreCache?: boolean } = {}
): 'retry' | 'reload' | 'noop' {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return 'noop'
  const retryUrl = retryUrlOf(wc, fallbackUrl)
  if (retryUrl) {
    wc.loadURL(retryUrl).catch((error: unknown) => {
      const msg = String((error && typeof error === 'object' && 'message' in error ? error.message : error) || '')
      if (msg.includes('ERR_ABORTED')) return
      console.error(`[reload] retry failed: ${retryUrl}`, msg)
    })
    return 'retry'
  }
  if (options && options.ignoreCache && typeof wc.reloadIgnoringCache === 'function') {
    wc.reloadIgnoringCache()
  } else {
    wc.reload()
  }
  return 'reload'
}

