export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureSize {
  width: number
  height: number
}

export interface CaptureInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface CaptureLayoutInput {
  viewport: CaptureSize
  place?: CaptureRect | null
  insets?: CaptureInsets
  image: CaptureSize
  zoom: number
  panX: number
  panY: number
  fitMode: 'contain' | 'width'
}

export interface CaptureLayoutResult {
  box: CaptureRect
  image: CaptureRect
  fit: CaptureRect
  panX: number
  panY: number
  scale: number
}

export interface ToolbarPositionInput {
  viewport: CaptureSize
  image: CaptureRect | null
  toolbar: CaptureSize
  edgeGap?: number
  gap?: number
}

export interface ToolbarPosition {
  left: number
  top: number
  placement: 'below' | 'above' | 'overlay' | 'center'
}

export function clampNumber(value: number, lo: number, hi: number): number {
  const min = Math.min(lo, hi)
  const max = Math.max(lo, hi)
  return Math.min(max, Math.max(min, value))
}

function positive(value: number, fallback = 1): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0
}

export function resolveCaptureBox(
  viewport: CaptureSize,
  place?: CaptureRect | null,
  insets?: CaptureInsets
): CaptureRect {
  const width = positive(viewport.width)
  const height = positive(viewport.height)
  if (!place || !(Number(place.width) > 0) || !(Number(place.height) > 0)) {
    const left = Math.min(finiteNonNegative(insets?.left), width - 1)
    const right = Math.min(finiteNonNegative(insets?.right), width - left - 1)
    const top = Math.min(finiteNonNegative(insets?.top), height - 1)
    const bottom = Math.min(finiteNonNegative(insets?.bottom), height - top - 1)
    return {
      x: left,
      y: top,
      width: Math.max(1, width - left - right),
      height: Math.max(1, height - top - bottom)
    }
  }
  const x = Math.max(0, Math.min(Number(place.x) || 0, width - 1))
  const y = Math.max(0, Math.min(Number(place.y) || 0, height - 1))
  return {
    x,
    y,
    width: Math.max(1, Math.min(Number(place.width), width - x)),
    height: Math.max(1, Math.min(Number(place.height), height - y))
  }
}

export function computeCaptureLayout(input: CaptureLayoutInput): CaptureLayoutResult {
  const box = resolveCaptureBox(input.viewport, input.place, input.insets)
  const imageWidth = positive(input.image.width)
  const imageHeight = positive(input.image.height)
  const fitScale = input.fitMode === 'width'
    ? box.width / imageWidth
    : Math.min(box.width / imageWidth, box.height / imageHeight)
  const fit = {
    x: input.fitMode === 'width' ? box.x : box.x + (box.width - imageWidth * fitScale) / 2,
    y: input.fitMode === 'width' ? box.y : box.y + (box.height - imageHeight * fitScale) / 2,
    width: Math.max(1, imageWidth * fitScale),
    height: Math.max(1, imageHeight * fitScale)
  }
  const zoom = positive(input.zoom)
  const width = Math.max(1, fit.width * zoom)
  const height = Math.max(1, fit.height * zoom)
  const minX = Math.min(box.x, box.x + box.width - width)
  const maxX = Math.max(box.x, box.x + box.width - width)
  const minY = Math.min(box.y, box.y + box.height - height)
  const maxY = Math.max(box.y, box.y + box.height - height)
  const panX = clampNumber(input.panX, minX - fit.x, maxX - fit.x)
  const panY = clampNumber(input.panY, minY - fit.y, maxY - fit.y)

  return {
    box,
    image: { x: fit.x + panX, y: fit.y + panY, width, height },
    fit,
    panX,
    panY,
    scale: width > 0 ? imageWidth / width : 1
  }
}

/**
 * Places the control dock in four deterministic positions. The last two always
 * remain inside the viewport, which is the guarantee edge-to-edge screenshots need.
 */
export function computeToolbarPosition(input: ToolbarPositionInput): ToolbarPosition {
  const viewportWidth = positive(input.viewport.width)
  const viewportHeight = positive(input.viewport.height)
  const edge = Math.max(0, input.edgeGap ?? 12)
  const gap = Math.max(0, input.gap ?? 10)
  const toolbarWidth = Math.min(positive(input.toolbar.width), Math.max(1, viewportWidth - edge * 2))
  const toolbarHeight = Math.min(positive(input.toolbar.height), Math.max(1, viewportHeight - edge * 2))
  const image = input.image
  const centeredLeft = image
    ? image.x + (image.width - toolbarWidth) / 2
    : (viewportWidth - toolbarWidth) / 2
  const left = Math.round(clampNumber(
    centeredLeft,
    edge,
    Math.max(edge, viewportWidth - toolbarWidth - edge)
  ))

  if (!image) {
    return {
      left,
      top: Math.round(clampNumber((viewportHeight - toolbarHeight) / 2, edge, Math.max(edge, viewportHeight - toolbarHeight - edge))),
      placement: 'center'
    }
  }

  const below = image.y + image.height + gap
  if (below + toolbarHeight <= viewportHeight - edge) {
    return { left: Math.round(clampNumber(centeredLeft, edge, Math.max(edge, viewportWidth - toolbarWidth - edge))), top: Math.round(below), placement: 'below' }
  }

  const above = image.y - gap - toolbarHeight
  if (above >= edge) {
    return { left, top: Math.round(above), placement: 'above' }
  }

  return {
    left,
    top: Math.round(clampNumber(viewportHeight - toolbarHeight - edge, edge, Math.max(edge, viewportHeight - toolbarHeight - edge))),
    placement: 'overlay'
  }
}
