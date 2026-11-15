/**
 * 外部密码 CLI 的「一键安装」—— 主进程侧的唯一入口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不再是"请把文件拖到 …"
 * ══════════════════════════════════════════════════════════════════════
 * 旧版把安装成本丢给用户：自己在文件管理器里找 tools 目录、自己复制、自己
 * 改名。这里把这一步收进应用：弹系统文件选择框 → 复制到
 * `userData/tools/<toolFileName>` → POSIX 补执行位 → 自动重新探测。
 *
 * 后端决定"怎么装"（见 domain 的 getStatus().installMode）：
 *   'file'     —— 选中解压出来的二进制（bw / op）
 *   'download' —— 官方只发安装包（mac 的 op .pkg）→ 打开下载页
 * 本模块不认识任何具体厂商，只按契约执行。
 */

const fs = require('fs')
const path = require('path')
const { app, dialog, shell } = require('electron')
import type { PasswordBackendStatus, PasswordService } from '@hira-ng/domain-password'

const ARCHIVE_RE = /\.(zip|pkg|tar|gz|tgz|7z|dmg)$/i

/** 用户选文件时的过滤器（只做引导，不做真实校验）。 */
function fileFilters(platform: string) {
  if (platform === 'win32') return [{ name: '可执行文件', extensions: ['exe'] }]
  return [{ name: '所有文件', extensions: ['*'] }]
}

/**
 * @param {Object} passwordService  domain-password 的服务实例（需要 getBackendStatus）
 * @param {string} name             后端名（bitwarden / 1password）
 * @param {{ platform?: string }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, message?: string, path?: string, downloadLink?: string }>}
 */
interface PasswordToolResult { ok: boolean; reason?: string; message?: string; path?: string; downloadLink?: string }

async function installPasswordTool(
  passwordService: Pick<PasswordService, 'getBackendStatus'> | null | undefined,
  name: string,
  options: { platform?: string } = {}
): Promise<PasswordToolResult> {
  const platform = options.platform || process.platform
  const status: PasswordBackendStatus | null = passwordService && typeof passwordService.getBackendStatus === 'function'
    ? passwordService.getBackendStatus(name)
    : null
  if (!status) {
    return { ok: false, reason: 'unsupported-backend', message: '该后端不支持 CLI 安装。' }
  }

  // 官方只提供安装包（mac 的 op）→ 打开下载页，装完回来点「重新检测」。
  if (status.installMode === 'download') {
    try {
      const protocol = new URL(String(status.downloadLink || '')).protocol
      if (protocol !== 'https:' && protocol !== 'http:') {
        return { ok: false, reason: 'invalid-download-link', message: '下载链接不是 http(s) 地址，已拒绝打开。' }
      }
      await shell.openExternal(status.downloadLink)
      return {
        ok: true,
        reason: 'download-opened',
        message: '已打开官方下载页；安装完成后点「重新检测」即可。',
        downloadLink: status.downloadLink
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'open-download-failed',
        message: String(error instanceof Error ? error.message : '无法打开下载页').slice(0, 300),
        downloadLink: status.downloadLink
      }
    }
  }

  const fileName = status.toolFileName
  const targetDir = path.join(app.getPath('userData'), 'tools')
  const targetPath = path.join(targetDir, fileName)

  const picked = await dialog.showOpenDialog({
    title: `选择 ${fileName}`,
    buttonLabel: '安装',
    properties: ['openFile'],
    filters: fileFilters(platform)
  })
  if (picked.canceled || !picked.filePaths || !picked.filePaths.length) {
    return { ok: false, reason: 'cancelled' }
  }

  const source = picked.filePaths[0]
  // 用户选到压缩包：与其复制过去再探测失败，不如当场说清楚。
  if (ARCHIVE_RE.test(source)) {
    return {
      ok: false,
      reason: 'archive-selected',
      message: `请先解压压缩包，再选择其中的 ${fileName}。`
    }
  }

  try {
    await fs.promises.mkdir(targetDir, { recursive: true })
    if (path.resolve(source) !== path.resolve(targetPath)) {
      await fs.promises.copyFile(source, targetPath)
    }
    if (platform !== 'win32') {
      await fs.promises.chmod(targetPath, 0o755)
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'copy-failed',
      message: String(error instanceof Error ? error.message : '复制失败（目标文件可能正在被占用）').slice(0, 300)
    }
  }

  return { ok: true, path: targetPath }
}

module.exports = { installPasswordTool }
