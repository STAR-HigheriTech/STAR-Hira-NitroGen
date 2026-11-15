/**
 * 图片 → 二维码文本（截图、拍照、导出文件里的图）。
 *
 * 与相机会话的分工：这里**不需要摄像头**，只是一次性的像素 → 文本。
 * 两者共用 `detector.js` 的引擎与 `frame.js` 的取帧，所以"支不支持""准不准"
 * 在两条路径上完全一致。
 */

import { createFrameGrabber } from './frame.js'
import { createQrDetector } from './detector.js'

/**
 * 解码一批图片。
 *
 * @param {Document} doc
 * @param {FileList|File[]} files
 * @returns {Promise<{ texts: string[], failed: number, total: number, kind: string }>}
 *   `failed` = 认不出二维码的图片张数（模糊 / 裁切 / 根本不是二维码）
 */
export async function decodeQrImages(doc: Document, files: FileList|File[]) : Promise<{ texts: string[], failed: number, total: number, kind: string }> {
  const list = Array.from(files || [])
  const texts: string[] = []
  const seen = new Set<string>()
  let failed = 0

  if (!list.length) return { texts, failed, total: 0, kind: 'none' }

  const grabber = createFrameGrabber(doc)
  const detector = await createQrDetector()

  for (const file of list) {
    try {
      const frame = await grabber.fromBlob(file)
      if (!frame) { failed++; continue }
      const found = await detector.detect(frame)
      if (!found.length) { failed++; continue }
      for (const t of found) {
        const v = String(t || '').trim()
        // 去重是必要的：用户很容易把同一张图选两遍，而重复的链接在导入时
        // 会被判重跳过并报一堆"已存在"—— 那些噪音会掩盖真正的问题
        if (!v || seen.has(v)) continue
        seen.add(v)
        texts.push(v)
      }
    } catch (_) {
      failed++
    }
  }
  return { texts, failed, total: list.length, kind: detector.kind }
}

