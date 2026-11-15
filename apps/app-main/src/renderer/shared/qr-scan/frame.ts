/**
 * 帧抓取：把"能画的东西"（video 元素 / 图片 Blob）取成 `ImageData`。
 *
 * 两个引擎都吃 `{width, height, data}`，所以这是它们**唯一的共同上游** ——
 * 把取帧收敛在这里，两条引擎的输入就不可能长得不一样。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两个真实的性能陷阱（都不是微优化）
 * ══════════════════════════════════════════════════════════════════════
 * 1. **必须 `willReadFrequently: true`**。默认 canvas 放在 GPU 显存里，
 *    每次 `getImageData` 都要把整帧从 GPU 读回 CPU —— 在相机循环里
 *    （每 300ms 一次）这个回读会明显拖慢并让风扇转起来。
 *    声明这个标志会让 Chromium 把它放在 CPU 内存里。
 *
 * 2. **必须限尺寸**。1920x1080 一帧的 `ImageData` 是 8.3MB，每 300ms 拷一份
 *    既费内存也费带宽，而二维码不需要那么高的分辨率。缩到长边 1280 以内，
 *    拷贝量降一个数量级，解码成功率几乎不变。
 */

/** 长边上限。见文件头第 2 点。 */
const MAX_SIDE = 1280

export interface FrameGrabber {
  fromVideo(video: HTMLVideoElement | null | undefined): ImageData | null
  fromBlob(blob: Blob): Promise<ImageData | null>
  readonly _fit: (width: number, height: number) => { w: number; h: number } | null
}

/**
 * 建一个帧抓取器（复用一个离屏 canvas —— 绝不每帧新建）。
 * @param {Document} doc
 */
export function createFrameGrabber(doc: Document): FrameGrabber {
  const canvas = doc.createElement('canvas')
  // 见文件头第 1 点：不加这个，getImageData 每帧都要从 GPU 回读
  const context = (() => {
    const value = canvas.getContext('2d', { willReadFrequently: true })
    if (!value) throw new Error('无法创建 2D 画布上下文')
    return value
  })()

  /** 目标尺寸：等比缩放到长边 ≤ MAX_SIDE；已经够小就原样。 */
  function fit(width: number, height: number): { w: number; h: number } | null {
    const longest = Math.max(width, height)
    if (!longest) return null
    const scale = longest > MAX_SIDE ? MAX_SIDE / longest : 1
    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) }
  }

  function grab(source: CanvasImageSource, srcWidth: number, srcHeight: number): ImageData | null {
    const size = fit(srcWidth, srcHeight)
    if (!size) return null
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w
      canvas.height = size.h
    }
    context.drawImage(source, 0, 0, size.w, size.h)
    return context.getImageData(0, 0, size.w, size.h)
  }

  return {
    /**
     * 从正在播放的 video 取一帧。
     * 还没出画面（`videoWidth` 为 0）时返回 null —— 这不是错误，只是"还没准备好"。
     */
    fromVideo(video: HTMLVideoElement | null | undefined) {
      if (!video || !video.videoWidth || !video.videoHeight) return null
      try {
        return grab(video, video.videoWidth, video.videoHeight)
      } catch (_) {
        // 极端情况下 drawImage 会因"视频尚未就绪"抛错；当这一帧没准备好即可
        return null
      }
    },

    /** 从图片 Blob（文件 / 截图粘贴）取像素。 */
    async fromBlob(blob: Blob) {
      if (typeof createImageBitmap !== 'function') throw new Error('当前环境不支持解码图片')
      const bitmap = await createImageBitmap(blob)
      try {
        return grab(bitmap, bitmap.width, bitmap.height)
      } finally {
        // 大图占的是显存/系统内存，及时释放 —— 用户可能一次选十几张
        if (typeof bitmap.close === 'function') bitmap.close()
      }
    },

    /** 目标尺寸（测试与调试用）。 */
    _fit: fit
  }
}

