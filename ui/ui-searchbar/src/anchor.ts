import type { SuggestionAnchor } from './types'

export interface AnchorRect {
  left: number
  top: number
  width: number
  height: number
}

export interface AnchorInput {
  rect: AnchorRect
  viewportWidth: number
  viewportHeight?: number
  maxWidth?: number
  sideWidth?: number
  sideHostRect?: AnchorRect | null
}

const EDGE_GUTTER = 16
const OVERLAY_PAD_ALLOWANCE = 30
const FALLBACK_MAX_WIDTH = 720
const FALLBACK_SIDE_WIDTH = 600

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Resolve the dropdown anchor without touching DOM, IPC, or overlay state. */
export function resolveSuggestionAnchor(input: AnchorInput): SuggestionAnchor {
  const viewportWidth = Math.max(1, Math.round(finite(input.viewportWidth)))
  const viewportHeight = Math.max(0, Math.round(finite(input.viewportHeight)))
  const gutter = Math.min(EDGE_GUTTER, Math.max(4, Math.round(viewportWidth * 0.02)))
  const declaredMax = finite(input.maxWidth) || FALLBACK_MAX_WIDTH
  const maxWidth = Math.max(
    1,
    Math.min(declaredMax, viewportWidth - (gutter + OVERLAY_PAD_ALLOWANCE) * 2)
  )
  const inputWidth = Math.max(1, Math.round(finite(input.rect.width)))
  const left = Math.round(finite(input.rect.left))
  const top = Math.round(finite(input.rect.top))
  const height = Math.round(finite(input.rect.height))
  const host = input.sideHostRect
  const valign = viewportHeight > 0 && top + height / 2 > viewportHeight / 2 ? 'center' : 'below'
  const anchorRight = left + inputWidth
  const rightRoom = viewportWidth - gutter - left - OVERLAY_PAD_ALLOWANCE
  const leftRoom = anchorRight - gutter - OVERLAY_PAD_ALLOWANCE

  if (!host) {
    const preferredWidth = Math.max(inputWidth, Math.min(Math.round(inputWidth * 1.5), maxWidth))
    const align = rightRoom >= preferredWidth || rightRoom >= leftRoom ? 'left' : 'right'
    const directionalRoom = align === 'right' ? leftRoom : rightRoom
    return {
      left,
      top,
      width: Math.max(1, Math.min(preferredWidth, Math.max(inputWidth, directionalRoom))),
      height,
      align,
      valign
    }
  }

  const hostCenter = finite(host.left) + finite(host.width) / 2
  const align = hostCenter < viewportWidth / 2 ? 'left' : 'right'
  const sideTarget = Math.min(
    maxWidth,
    Math.max(inputWidth, Math.round(finite(input.sideWidth) || FALLBACK_SIDE_WIDTH))
  )
  const directionalRoom = align === 'left' ? rightRoom : leftRoom

  return {
    left,
    top,
    width: clamp(sideTarget, 1, Math.max(1, directionalRoom)),
    height,
    align,
    valign
  }
}
