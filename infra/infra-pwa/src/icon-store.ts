/**
 * 图标资产：下载 → 校验 → 缩放 → 落盘。
 *
 * 产物（相对 assetDir）：
 *   source.png|jpg|webp|svg   原始字节（排查用，不参与展示）
 *   icon-512.png / icon-192.png / icon-32.png
 *   icon.ico                  多尺寸容器（快捷方式用）
 *
 * 约束：
 *  · 只认图片魔数，不认 Content-Type（服务端经常给 application/octet-stream）；
 *  · 文件名全部由本模块生成，manifest 里的路径只用于**下载**，绝不用于落盘命名；
 *  · 失败不抛异常，返回 { ok:false } 让调用方回落到 favicon / 默认图标。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type * as Electron from 'electron'
import { fetchBinary, decodeDataUrl, MAX_ICON_BYTES } from './manifest-fetch'
import { buildIco } from './ico'
import { rasterizeSvg } from './svg-raster'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00])

function getElectron(): typeof Electron {
  return require('electron') as typeof Electron
}

/** 按魔数判断图片类型；不认识返回 null。 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml' | 'image/x-icon'

export function sniffImage(buffer: Buffer): ImageMime | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buffer.subarray(0, 4).equals(ICO_SIGNATURE)) return 'image/x-icon'
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).trimStart().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return 'image/svg+xml'
  return null
}

const EXT_BY_MIME: Readonly<Record<ImageMime, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico'
})

export const PNG_SIZES = Object.freeze([512, 192, 32] as const)
export const ICO_SIZES = Object.freeze([256, 128, 64, 48, 32, 16] as const)

function resizeToPng(image: Electron.NativeImage, size: number): Buffer | null {
  const resized = image.resize({ width: size, height: size, quality: 'best' })
  return resized.isEmpty() ? null : resized.toPNG()
}

/**
 * 把一份图片字节写成完整图标集。
 *
 * SVG 会先落 `icon.svg`（chrome 侧矢量最清晰），再**栅格化一次**补齐 PNG / ICO ——
 * 没有位图，Windows 任务栏与桌面快捷方式就只能是默认图标，这是「图标不一致」的根。
 *
 * @returns {Promise<{ ok: true, iconPath: string, iconSmallPath: string, iconIcoPath: string|null, mime: string }
 *                  | { ok: false, reason: string }>}
 */
export interface IconSetSuccess {
  ok: true
  iconPath: string
  iconSmallPath: string
  iconIcoPath: string | null
  mime: ImageMime
}

export interface IconFailure {
  ok: false
  reason: string
}

export async function writeIconSet(assetDir: string, buffer: Buffer, declaredMime?: string): Promise<IconSetSuccess | IconFailure> {
  const mime = sniffImage(buffer) ?? (String(declaredMime || '').startsWith('image/') ? declaredMime as ImageMime : null)
  if (!mime) return { ok: false, reason: '不是可识别的图片' }
  if (buffer.byteLength > MAX_ICON_BYTES) return { ok: false, reason: '图标过大' }

  const ext = EXT_BY_MIME[mime] || 'bin'
  await fs.writeFile(path.join(assetDir, `source.${ext}`), buffer)

  // SVG：先落矢量原件，再尝试栅格化。
  let bitmap = buffer
  if (mime === 'image/svg+xml') {
    await fs.writeFile(path.join(assetDir, 'icon.svg'), buffer)
    const raster = await rasterizeSvg(buffer)
    if (!raster) {
      // 栅格化失败（无 GUI / 渲染超时）：保留矢量可用，位图留给调用方回落。
      return {
        ok: true,
        iconPath: 'icon.svg',
        iconSmallPath: 'icon.svg',
        iconIcoPath: null,
        mime
      }
    }
    bitmap = raster
  }

  const image = getElectron().nativeImage.createFromBuffer(bitmap)
  if (!image || image.isEmpty()) {
    if (mime === 'image/svg+xml') {
      return {
        ok: true,
        iconPath: 'icon.svg',
        iconSmallPath: 'icon.svg',
        iconIcoPath: null,
        mime
      }
    }
    return { ok: false, reason: '图片解码失败' }
  }

  const written: Partial<Record<(typeof PNG_SIZES)[number], Buffer>> = {}
  for (const size of PNG_SIZES) {
    const png = resizeToPng(image, size)
    if (!png) continue
    const name = `icon-${size}.png`
    await fs.writeFile(path.join(assetDir, name), png)
    written[size] = png
  }
  if (!written[512] && !written[192]) return { ok: false, reason: '图标缩放失败' }

  const icoImages = []
  for (const size of ICO_SIZES) {
    const png = resizeToPng(image, size)
    if (png) icoImages.push({ size, buffer: png })
  }
  const ico = buildIco(icoImages)
  if (ico) await fs.writeFile(path.join(assetDir, 'icon.ico'), ico)

  return {
    ok: true,
    iconPath: written[512] ? 'icon-512.png' : 'icon-192.png',
    iconSmallPath: written[32] ? 'icon-32.png' : written[192] ? 'icon-192.png' : 'icon-512.png',
    iconIcoPath: ico ? 'icon.ico' : null,
    mime
  }
}

interface IconSource {
  src: string
  mime?: string
  type?: string
}

async function loadIconBuffer(session: Electron.Session | null | undefined, source: IconSource): Promise<
  { ok: true; buffer: Buffer; mime: string } | IconFailure
> {
  if (!source || typeof source !== 'object' || !source.src) return { ok: false, reason: '缺少图标地址' }
  if (/^data:image\//i.test(source.src)) {
    const decoded = decodeDataUrl(source.src)
    if (!decoded) return { ok: false, reason: 'data URL 解码失败' }
    return { ok: true, buffer: decoded.buffer, mime: decoded.contentType }
  }
  const fetched = await fetchBinary(session, source.src, { maxBytes: MAX_ICON_BYTES })
  if (!fetched.ok) return fetched
  return { ok: true, buffer: fetched.buffer, mime: fetched.contentType }
}

/**
 * 安装图标资产：**favicon 优先**，manifest 图标作为回落。
 *
 * 用户口径：应用图标就是「网页那个图标」—— 浏览器标签上显示什么，任务栏与
 * 桌面快捷方式就该是什么。manifest 的 512 图标常常与站点 favicon 不是同一张
 * （甚至只是品牌占位图），所以不能让它抢在前面。
 *
 * @param {{ assetDir: string, session: Electron.Session, icons?: Array<object>, faviconUrl?: string }} input
 */
export interface InstallIconAssetsInput {
  assetDir: string
  session: Electron.Session | null | undefined
  icons?: IconSource[]
  faviconUrl?: string
}

export interface InstalledIconAssets extends IconSetSuccess {
  source: 'favicon' | 'manifest'
}

export async function installIconAssets(input: InstallIconAssetsInput): Promise<InstalledIconAssets | IconFailure> {
  const { assetDir, session } = input || {}
  if (!assetDir) return { ok: false, reason: '缺少资产目录' }
  await fs.mkdir(assetDir, { recursive: true })

  const seen = new Set<string>()
  const candidates: Array<IconSource & { source: 'favicon' | 'manifest' }> = []

  const addCandidate = (entry: IconSource | null, source: 'favicon' | 'manifest'): void => {
    if (!entry || !entry.src || seen.has(entry.src)) return
    seen.add(entry.src)
    candidates.push({ src: entry.src, mime: entry.mime || entry.type, source })
  }

  // 1) favicon（页面 `<link rel="icon">` 里最大的那张，或 /favicon.ico）
  addCandidate(input.faviconUrl ? { src: input.faviconUrl } : null, 'favicon')
  // 2) manifest icons（favicon 下载/解码失败时的回落）
  for (const icon of input.icons ?? []) addCandidate(icon, 'manifest')

  let lastReason = '没有可用图标'
  for (const candidate of candidates) {
    const loaded = await loadIconBuffer(session, candidate)
    if (!loaded.ok) {
      lastReason = loaded.reason
      continue
    }
    const result = await writeIconSet(assetDir, loaded.buffer, loaded.mime)
    if (result.ok) return { ...result, source: candidate.source }
    lastReason = result.reason
  }

  return { ok: false, reason: lastReason }
}

