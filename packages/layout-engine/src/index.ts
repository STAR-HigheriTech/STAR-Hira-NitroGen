import type {
  LayoutBlockNode,
  LayoutContext,
  LayoutDocument,
  LayoutFrame,
  LayoutNode,
  LayoutVariant,
  NodeSizing
} from '@hira-ng/layout-model'
import { applyVariantPatches, getChildren, walkNodes } from '@hira-ng/layout-model'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutEnvironment {
  viewport: { width: number; height: number }
  context?: LayoutContext
  spaceId?: string
  metrics?: {
    nodeSizes?: Record<string, { width?: number; height?: number }>
    signature?: string
  }
  blockAvailability?: ReadonlySet<string>
}

export interface ResolvedNode {
  id: string
  type: LayoutNode['type']
  role?: LayoutFrame['role']
  blockId?: string
  rect: Rect
  visible: boolean
  depth: number
  children: ResolvedNode[]
}

export interface DropZone {
  nodeId: string
  role: LayoutFrame['role']
  axis: LayoutFrame['axis']
  rect: Rect
  index: number
}

export interface ResolvedLayout {
  document: LayoutDocument
  root: ResolvedNode
  nodes: Record<string, ResolvedNode>
  dropZones: DropZone[]
  warnings: Array<{ code: string; message: string; nodeId?: string }>
}

interface Size {
  width: number
  height: number
}

const DEFAULT_BLOCK_SIZE: Size = { width: 32, height: 32 }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height))
  }
}

function variantMatches(variant: LayoutVariant, environment: LayoutEnvironment): boolean {
  const { width, height } = environment.viewport
  const context = environment.context || 'normal'
  const when = variant.when || {}
  if (Number.isFinite(when.minWidth) && width < Number(when.minWidth)) return false
  if (Number.isFinite(when.maxWidth) && width > Number(when.maxWidth)) return false
  if (Number.isFinite(when.minHeight) && height < Number(when.minHeight)) return false
  if (Number.isFinite(when.maxHeight) && height > Number(when.maxHeight)) return false
  if (Array.isArray(when.context) && when.context.length && !when.context.includes(context)) return false
  return true
}

export function resolveDocumentForEnvironment(document: LayoutDocument, environment: LayoutEnvironment): LayoutDocument {
  let resolved = document
  for (const variant of document.variants || []) {
    if (variantMatches(variant, environment)) resolved = applyVariantPatches(resolved, variant.id)
  }
  return resolved
}

function baseSizeFor(node: LayoutNode, environment: LayoutEnvironment): Size {
  if (node.type === 'divider') {
    return node.axis === 'row' ? { width: 1, height: 24 } : { width: 24, height: 1 }
  }
  if (node.type === 'spacer') return { width: 8, height: 8 }
  if (node.type === 'block') {
    const measured = environment.metrics?.nodeSizes?.[node.id]
    const fallback = DEFAULT_BLOCK_SIZE
    const width = Math.max(1, Number(measured?.width) || Number(node.sizing?.basis) || fallback.width)
    const height = Math.max(1, Number(measured?.height) || (node.sizing?.unit === 'px' ? Number(node.sizing.basis) : fallback.height))
    return { width, height }
  }
  if (node.type !== 'frame') return { width: 1, height: 1 }
  const horizontal = node.axis === 'row'
  const gap = Math.max(0, Number(node.gap) || 0)
  const pad = Math.max(0, Number(node.padding) || 0)
  const childSizes = node.children.map((child) => baseSizeFor(child, environment))
  const fixedWidth = childSizes.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, childSizes.length - 1) + pad * 2
  const fixedHeight = childSizes.reduce((sum, item) => sum + item.height, 0) + gap * Math.max(0, childSizes.length - 1) + pad * 2
  return horizontal
    ? { width: Math.max(1, fixedWidth), height: Math.max(...childSizes.map((s) => s.height), 1) + pad * 2 }
    : { width: Math.max(...childSizes.map((s) => s.width), 1) + pad * 2, height: Math.max(1, fixedHeight) }
}

function requiredSize(node: LayoutNode, environment: LayoutEnvironment): number {
  const size = baseSizeFor(node, environment)
  if (node.type === 'frame') {
    const horizontal = node.axis === 'row'
    return horizontal ? size.width : size.height
  }
  if (node.type === 'divider') return node.axis === 'row' ? 1 : 1
  const basis = Number(node.sizing?.basis)
  const resolved = Number.isFinite(basis) && basis > 0
    ? basis
    : node.type === 'block' && node.blockId === 'content.main'
      ? 1
      : (node.type === 'block' ? 32 : 1)
  return Math.max(1, resolved)
}

function sizeForChild(node: LayoutNode, crossSize: number, environment: LayoutEnvironment): Size {
  const base = baseSizeFor(node, environment)
  if (node.type === 'frame') {
    const axisSize = Number(node.sizing?.basis)
    return node.axis === 'row'
      ? { width: axisSize > 0 ? axisSize : base.width, height: crossSize }
      : { width: crossSize, height: axisSize > 0 ? axisSize : base.height }
  }
  if (node.type === 'divider') {
    return node.axis === 'row' ? { width: 1, height: crossSize } : { width: crossSize, height: 1 }
  }
  if (node.type === 'spacer') {
    return { width: base.width, height: base.height }
  }
  const block = node as LayoutBlockNode
  const fraction = block.blockId === 'content.main' || block.sizing?.unit === 'fraction'
  if (fraction) return { width: base.width, height: base.height }
  const basis = Number(block.sizing?.basis)
  if (basis > 0 && block.sizing?.unit === 'px') {
    return {
      width: Math.min(crossSize, Math.max(1, basis)),
      height: Math.min(crossSize, Math.max(1, basis))
    }
  }
  return base
}

function distributeChildren(
  parent: LayoutFrame,
  content: Rect,
  environment: LayoutEnvironment
): Array<{ node: LayoutNode; rect: Rect }> {
  const children = parent.children.filter((child) => {
    if (child.type === 'block' && child.visibility === 'hidden') return false
    if (child.type === 'block' && environment.blockAvailability && !environment.blockAvailability.has(child.blockId)) return false
    return true
  })
  if (!children.length) return []
  const horizontal = parent.axis === 'row'
  const axisStart = horizontal ? content.x : content.y
  const axisTotal = horizontal ? content.width : content.height
  const crossStart = horizontal ? content.y : content.x
  const crossTotal = horizontal ? content.height : content.width
  const gap = Math.max(0, Number(parent.gap) || 0)
  const available = Math.max(1, axisTotal - gap * Math.max(0, children.length - 1))
  const required = children.map((child) => Math.min(available, requiredSize(child, environment)))
  const fixed = children.reduce((sum, child, index) => {
    const sizing = child.sizing as Partial<NodeSizing> | undefined
    return sum + (sizing?.unit === 'px' || sizing?.grow ? required[index] : 0)
  }, 0)
  const flexChildren = children.filter((child, index) => {
    const sizing = child.sizing as Partial<NodeSizing> | undefined
    return !(sizing?.unit === 'px' || sizing?.grow)
  })
  const remainder = Math.max(0, available - fixed)
  const equal = flexChildren.length ? remainder / flexChildren.length : 0
  let cursor = axisStart
  return children.map((child, index) => {
    const sizing = child.sizing as Partial<NodeSizing> | undefined
    const isFlex = !(sizing?.unit === 'px' || sizing?.grow)
    const desired = isFlex ? equal : required[index]
    const min = Number(sizing?.min)
    const max = Number(sizing?.max)
    const axisLength = clamp(
      Math.round(desired),
      Number.isFinite(min) ? Math.max(0, min) : 0,
      Number.isFinite(max) ? Math.min(available, Math.max(0, max)) : available
    )
    const measured = sizeForChild(child, crossTotal, environment)
    const rect: Rect = horizontal
      ? { x: cursor, y: crossStart, width: axisLength, height: measured.height }
      : { x: crossStart, y: cursor, width: measured.width, height: axisLength }
    cursor += axisLength + gap
    return { node: child, rect: roundRect(rect) }
  })
}

export function resolveLayout(document: LayoutDocument, environment: LayoutEnvironment): ResolvedLayout {
  const resolvedDocument = resolveDocumentForEnvironment(document, environment)
  const warnings: ResolvedLayout['warnings'] = []
  const nodes: Record<string, ResolvedNode> = {}
  const dropZones: DropZone[] = []
  const viewport = environment.viewport
  const rootRect: Rect = {
    x: 0,
    y: 0,
    width: Math.max(1, Math.round(viewport.width)),
    height: Math.max(1, Math.round(viewport.height))
  }

  const visit = (node: LayoutNode, rect: Rect, depth: number): ResolvedNode => {
    const visible = !(node.type === 'block' && node.visibility === 'hidden')
    const result: ResolvedNode = {
      id: node.id,
      type: node.type,
      role: node.type === 'frame' ? node.role : undefined,
      blockId: node.type === 'block' ? node.blockId : undefined,
      rect: roundRect(rect),
      visible,
      depth,
      children: []
    }
    nodes[node.id] = result
    if (node.type === 'block' && environment.blockAvailability && !environment.blockAvailability.has(node.blockId)) {
      warnings.push({ code: 'block-unavailable', message: `构件 ${node.blockId} 当前不可用`, nodeId: node.id })
    }
    if (node.type === 'frame' && visible) {
      const pad = Math.max(0, Number(node.padding) || 0)
      const content: Rect = {
        x: rect.x + pad,
        y: rect.y + pad,
        width: Math.max(0, rect.width - pad * 2),
        height: Math.max(0, rect.height - pad * 2)
      }
      const children = distributeChildren(node, content, environment)
      result.children = children.map((child) => visit(child.node, child.rect, depth + 1))
      if (node.role !== 'root') {
        dropZones.push({
          nodeId: node.id,
          role: node.role,
          axis: node.axis,
          rect: result.rect,
          index: node.children.length
        })
      }
    }
    return result
  }

  const root = visit(resolvedDocument.root, rootRect, 0)
  sortDropZones(dropZones)
  return { document: resolvedDocument, root, nodes, dropZones, warnings }
}

function sortDropZones(zones: DropZone[]): void {
  zones.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
}

export function hitTestDropZones(layout: ResolvedLayout, x: number, y: number): DropZone | null {
  for (const zone of layout.dropZones) {
    if (
      x >= zone.rect.x &&
      x <= zone.rect.x + zone.rect.width &&
      y >= zone.rect.y &&
      y <= zone.rect.y + zone.rect.height
    ) {
      return zone
    }
  }
  return null
}

export function insertionIndex(
  frame: LayoutFrame,
  zone: DropZone,
  x: number,
  y: number,
  layout: ResolvedLayout
): number {
  const children = frame.children
    .map((child) => layout.nodes[child.id])
    .filter(Boolean)
  if (!children.length) return 0
  const horizontal = frame.axis === 'row'
  for (let i = 0; i < children.length; i += 1) {
    const rect = children[i].rect
    const center = horizontal ? rect.x + rect.width / 2 : rect.y + rect.height / 2
    if ((horizontal ? x : y) < center) return i
  }
  return zone.index
}

export function buildMiniMap(document: LayoutDocument, width: number, height: number): ResolvedLayout {
  return resolveLayout(document, { viewport: { width, height }, context: 'normal' })
}

export function countNodes(document: LayoutDocument): number {
  let count = 0
  walkNodes(document.root, () => { count += 1 })
  return count
}

export function nodeHasChildren(node: LayoutNode): boolean {
  return getChildren(node).length > 0
}

