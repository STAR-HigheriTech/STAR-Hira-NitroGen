/**
 * 下载安全（路径穿越防御 + Mark-of-the-Web）
 *
 * 对齐旧 main/download-security.js 的完整行为，逐字下沉：
 *   1. sanitizeDownloadFilename — 清洗服务器返回的文件名（去目录穿越/非法字符/保留名）
 *   2. safeJoinDownloadPath      — 确保拼接后仍在下载目录内（防盘符逃逸）
 *   3. uniqueDownloadPath        — 同名文件追加 (1)(2) 不覆盖
 *   4. writeMarkOfTheWeb         — Windows NTFS ADS 写入 Zone.Identifier
 *
 * 端口注入（R3：domain 不得 require fs/path/process）：
 *   - filePort：infra-fs#createFilePort()（需要 basename/sep/join/resolve/
 *     existsSync/mkdirSync/writeFileSync）
 *   - platform：调用方传 process.platform（APPS 侧注入，domain 不碰 process）
 */

/**
 * 创建下载安全函数集。
 * @param {{ filePort: object, platform: string }} deps
 */
interface DownloadFilePort {
  basename(path: string): string
  dirname(path: string): string
  sep: string
  join(...parts: string[]): string
  resolve(...parts: string[]): string
  existsSync(path: string): boolean
  mkdirSync(path: string): void
  writeFileSync(path: string, content: string): void
}

interface DownloadSecurityDeps {
  filePort: DownloadFilePort
  platform: string
}

interface MarkOfTheWebMeta {
  referrerUrl?: string
  hostUrl?: string
}

function createDownloadSecurity({ filePort, platform }: DownloadSecurityDeps) {
  if (!filePort) throw new Error('[domain-download] createDownloadSecurity: filePort is required')
  const {
    basename,
    sep,
    join,
    resolve,
    existsSync,
    mkdirSync,
    writeFileSync
  } = filePort

  /**
   * 清洗文件名：basename + 去非法字符 + 处理 Windows 保留名 + 长度限制。
   * 防止服务器通过 Content-Disposition: filename="../../x" 污染路径。
   * @param {string} filename
   * @returns {string}
   */
  function sanitizeDownloadFilename(filename: unknown): string {
    let raw = filename == null ? '' : String(filename)
    if (!raw) return 'download'
    // 只保留 basename（去掉前置目录）
    try {
      raw = basename(raw) || 'download'
    } catch (_) {
      raw = 'download'
    }
    // Windows 非法字符 + 控制字符 → 下划线
    raw = raw.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_')
    // Windows 保留名：CON PRN AUX NUL COM1..9 LPT1..9 → 前缀下划线
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(raw)) {
      raw = '_' + raw
    }
    // 兜底
    if (raw === '.' || raw === '..' || raw.trim() === '') raw = 'download'
    // Windows 单文件名 <= 255 UTF-16 码元
    if (raw.length > 240) raw = raw.substring(0, 240)
    return raw
  }

  /**
   * 安全拼接下载路径：保证 (downloadsDir + filename) 的结果仍在 downloadsDir 内。
   * 防止盘符穿越：join('C:\\Downloads', 'D:\\a.exe') → 'D:\\a.exe' 逃逸。
   * @param {string} downloadsDir
   * @param {string} filename
   * @returns {{ path: string, safeName: string }}
   */
  function safeJoinDownloadPath(downloadsDir: string, filename: unknown): { path: string; safeName: string } {
    const safeName = sanitizeDownloadFilename(filename)
    let joined
    try {
      joined = join(downloadsDir, safeName)
    } catch (_) {
      joined = ''
    }
    if (!joined) {
      return { path: (downloadsDir || '') + sep + safeName, safeName }
    }
    try {
      const normalizedDir = resolve(downloadsDir)
      let normalizedJoined = resolve(joined)
      if (normalizedJoined === normalizedDir) {
        joined = join(normalizedDir, safeName)
        normalizedJoined = resolve(joined)
      }
      const startsWith = normalizedJoined.length >= normalizedDir.length &&
        normalizedJoined.substring(0, normalizedDir.length) === normalizedDir
      if (!startsWith) {
        joined = resolve(normalizedDir, safeName)
      } else {
        const expected = resolve(normalizedDir, safeName)
        if (expected !== normalizedJoined) joined = expected
      }
    } catch (_) {}
    return { path: joined, safeName }
  }

  /**
   * 同名文件不覆盖：尝试 file.ext, file (1).ext, file (2).ext ...
   * @param {string} downloadsDir
   * @param {string} filename
   * @returns {string} 不存在的最终路径
   */
  function uniqueDownloadPath(downloadsDir: string, filename: unknown): string {
    const safeName = sanitizeDownloadFilename(filename) || 'download'
    let tryPath = ''
    try { tryPath = join(downloadsDir, safeName) } catch (_) { tryPath = '' }
    if (!tryPath) return resolve(downloadsDir || '.', safeName)
    if (typeof existsSync !== 'function') return tryPath
    const dir = filePort.dirname(tryPath)
    try { mkdirSync(dir) } catch (_) {}
    if (!existsSync(tryPath)) return tryPath
    let ext = ''
    let stem = safeName
    const dotIdx = safeName.lastIndexOf('.')
    if (dotIdx > 0 && dotIdx < safeName.length - 1) {
      stem = safeName.substring(0, dotIdx)
      ext = safeName.substring(dotIdx)
    }
    for (let n = 1; n <= 9999; n++) {
      const cand = ext ? `${stem} (${n})${ext}` : `${stem} (${n})`
      const candPath = join(dir, cand)
      if (!existsSync(candPath)) return candPath
    }
    return tryPath
  }

  /**
   * Mark-of-the-Web：为下载完成的 Internet 文件写入 NTFS ADS Zone.Identifier。
   * 让 Windows 识别"来自 Internet"，触发 SmartScreen / "此文件来自另一台计算机"警告。
   * FAT/exFAT/网络盘不支持 ADS，失败静默。
   * @param {string} filePath
   * @param {{ referrerUrl?: string, hostUrl?: string }} [meta]
   */
  function writeMarkOfTheWeb(filePath: string, meta: MarkOfTheWebMeta = {}): void {
    if (!filePath) return
    if (platform !== 'win32') return
    if (typeof writeFileSync !== 'function') return
    const zonePath = String(filePath) + ':Zone.Identifier'
    const content =
      '[ZoneTransfer]\r\n' +
      'ZoneId=3\r\n' +
      `ReferrerUrl=${meta.referrerUrl || ''}\r\n` +
      `HostUrl=${meta.hostUrl || ''}\r\n`
    try {
      writeFileSync(zonePath, content)
    } catch (_) {
      // 文件系统可能不支持 ADS，静默失败
    }
  }

  return {
    sanitizeDownloadFilename,
    safeJoinDownloadPath,
    uniqueDownloadPath,
    writeMarkOfTheWeb
  }
}

export { createDownloadSecurity }
