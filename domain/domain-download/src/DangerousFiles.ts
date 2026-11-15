/**
 * 危险文件类型规则 —— 纯函数（对齐 Chrome safe browsing 名单）
 *
 * 旧实现用 path.extname；R3 禁止 domain require('path')，
 * 这里用等价的纯字符串实现（本用例下行为完全一致：名单里没有 dotfile 条目）。
 */

// 危险文件扩展名（参考 Chrome safe browsing）
const DANGEROUS_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.com', '.scr', '.vbs', '.js', '.jar',
  '.msi', '.ps1', '.psm1', '.sh', '.so', '.dll', '.app'
]

/**
 * 取小写扩展名（含点）。与 path.extname 在本用例下行为一致。
 * @param {string} filename
 * @returns {string}
 */
function extOf(filename: unknown): string {
  if (!filename) return ''
  const i = String(filename).lastIndexOf('.')
  if (i <= 0 || i === String(filename).length - 1) return ''
  return String(filename).slice(i).toLowerCase()
}

/**
 * 判断文件是否为危险文件（基于扩展名）。
 * @param {string} filename
 * @returns {boolean}
 */
function isDangerousFile(filename: unknown): boolean {
  if (!filename) return false
  return DANGEROUS_EXTENSIONS.includes(extOf(filename))
}

export { DANGEROUS_EXTENSIONS, isDangerousFile, extOf }
