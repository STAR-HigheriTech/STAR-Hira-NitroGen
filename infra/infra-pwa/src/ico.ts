/**
 * PNG-in-ICO 容器 —— 自实现，不引第三方图像库。
 *
 * 现代 Windows（Vista+）支持 ICO 里直接塞 PNG 数据，所以"生成多尺寸图标"
 * 简化为：nativeImage 缩放出几张 PNG → 按 ICO 头拼起来。
 *
 * ICO 结构：
 *   ICONDIR      6 字节  (reserved=0, type=1, count)
 *   ICONDIRENTRY 16 字节 × count
 *   PNG 数据     按 entry 里登记的偏移依次排列
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(buffer: unknown): buffer is Buffer {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

/**
 * @param {Array<{ size: number, buffer: Buffer }>} images 尺寸 1..256
 * @returns {Buffer|null}
 */
export interface IcoImage {
  size: number
  buffer: Buffer
}

export function buildIco(images: IcoImage[]): Buffer | null {
  const entries = (Array.isArray(images) ? images : [])
    .filter((it) => it && isPng(it.buffer) && Number(it.size) > 0 && Number(it.size) <= 256)
    .map((it) => ({ size: Math.round(Number(it.size)), buffer: it.buffer }))
    // 大尺寸在前：Windows 挑图标时按尺寸匹配，顺序不影响正确性，但便于人工排查。
    .sort((a, b) => b.size - a.size)

  if (!entries.length) return null

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length

  entries.forEach((entry, index) => {
    const base = index * 16
    // 256 在 ICO 里用 0 表示（单字节存不下 256）
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1)
    dir.writeUInt8(0, base + 2) // colorCount
    dir.writeUInt8(0, base + 3) // reserved
    dir.writeUInt16LE(1, base + 4) // planes
    dir.writeUInt16LE(32, base + 6) // bitCount
    dir.writeUInt32LE(entry.buffer.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += entry.buffer.length
  })

  return Buffer.concat([header, dir, ...entries.map((entry) => entry.buffer)])
}

