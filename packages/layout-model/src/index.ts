export type LayoutAxis = 'row' | 'column'
export type FrameMode = 'flow' | 'wrap' | 'scroll' | 'stack' | 'tabs' | 'overlay'
export type NodeVisibility = 'always' | 'auto-hide' | 'collapsed' | 'hidden'
export type CollapseMode = 'off-canvas' | 'icon-strip' | 'accordion' | 'peek'
export type CollapseTrigger = 'manual' | 'edge-hover' | 'focus-mode' | 'width'

export interface NodeSizing {
  basis: number
  unit: 'px' | 'fraction' | 'content'
  min?: number
  max?: number
  grow?: number
  shrink?: number
}

export interface CollapsePolicy {
  enabled: boolean
  default: 'expanded' | 'collapsed' | 'hidden'
  mode: CollapseMode
  trigger: CollapseTrigger
  restoreWidth?: number
}

export interface LayoutFrame {
  type: 'frame'
  id: string
  role: 'root' | 'bar' | 'dock' | 'column' | 'panel-group' | 'toolbar-group' | 'tray' | 'custom-column'
  axis: LayoutAxis
  mode: FrameMode
  children: LayoutNode[]
  sizing: NodeSizing
  gap?: number
  padding?: number
  align?: 'start' | 'center' | 'end' | 'stretch'
  overflow?: 'grow' | 'scroll' | 'wrap' | 'drawer' | 'hide'
  collapse?: CollapsePolicy
  locked?: boolean
  label?: string
}

export interface LayoutBlockNode {
  type: 'block'
  id: string
  blockId: string
  children?: LayoutNode[]
  sizing?: Partial<NodeSizing>
  visibility?: NodeVisibility
  anchor?: 'start' | 'center' | 'end'
  locked?: boolean
  props?: Record<string, unknown>
}

export interface LayoutSpacer {
  type: 'spacer' | 'divider'
  id: string
  axis?: LayoutAxis
  sizing?: Partial<NodeSizing>
}

export type LayoutNode = LayoutFrame | LayoutBlockNode | LayoutSpacer

export interface LayoutPatch {
  op: 'set-sizing' | 'set-visibility' | 'set-collapse' | 'set-frame-mode' | 'set-props'
  nodeId: string
  value: unknown
}

export interface LayoutVariant {
  id: string
  label: string
  when: {
    minWidth?: number
    maxWidth?: number
    minHeight?: number
    maxHeight?: number
    context?: Array<'normal' | 'focus' | 'split' | 'immersive' | 'fullscreen'>
  }
  patches: LayoutPatch[]
}

export interface LayoutDocument {
  schemaVersion: 1
  id: string
  name: string
  root: LayoutFrame
  variants: LayoutVariant[]
  metadata: {
    createdAt: number
    updatedAt: number
    templateId?: string
    description?: string
  }
}

export type LayoutContext = 'normal' | 'focus' | 'split' | 'immersive' | 'fullscreen'

export type LayoutCommand =
  | { type: 'insert'; parentId: string; index: number; node: LayoutNode }
  | { type: 'remove'; nodeId: string }
  | { type: 'move'; nodeId: string; parentId: string; index: number }
  | { type: 'reorder'; parentId: string; orderedIds: string[] }
  | { type: 'resize'; nodeId: string; sizing: Partial<NodeSizing> }
  | { type: 'set-frame'; nodeId: string; patch: Partial<Pick<LayoutFrame, 'axis' | 'mode' | 'gap' | 'padding' | 'align' | 'overflow' | 'label'>> }
  | { type: 'set-props'; nodeId: string; patch: Record<string, unknown> }
  | { type: 'set-visibility'; nodeId: string; visibility: NodeVisibility }
  | { type: 'set-collapse'; nodeId: string; value: Partial<CollapsePolicy> }
  | { type: 'group'; nodeIds: string[]; frame: LayoutFrame }
  | { type: 'ungroup'; frameId: string }
  | { type: 'duplicate'; nodeId: string }
  | { type: 'rename-document'; name: string }

export interface CommandResult {
  document: LayoutDocument
  changedNodeIds: string[]
  changed: boolean
}

const DEFAULT_SIZING: NodeSizing = Object.freeze({
  basis: 0,
  unit: 'content',
  min: 0,
  grow: 0,
  shrink: 1
})

const DEFAULT_COLLAPSE: CollapsePolicy = Object.freeze({
  enabled: false,
  default: 'expanded',
  mode: 'off-canvas',
  trigger: 'manual'
})

function now(): number {
  return Date.now()
}

export function createLayoutId(prefix = 'layout'): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`
  }
  return `${prefix}-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createNodeId(prefix = 'node'): string {
  return createLayoutId(prefix)
}

export function normalizeSizing(input?: Partial<NodeSizing> | null): NodeSizing {
  const basis = Number(input?.basis)
  const min = Number(input?.min)
  const max = Number(input?.max)
  const grow = Number(input?.grow)
  const shrink = Number(input?.shrink)
  const unit = input?.unit === 'px' || input?.unit === 'fraction' ? input.unit : 'content'
  return {
    basis: Number.isFinite(basis) ? Math.max(0, basis) : DEFAULT_SIZING.basis,
    unit,
    min: Number.isFinite(min) ? Math.max(0, min) : 0,
    max: Number.isFinite(max) ? Math.max(0, max) : undefined,
    grow: Number.isFinite(grow) ? Math.max(0, grow) : DEFAULT_SIZING.grow,
    shrink: Number.isFinite(shrink) ? Math.max(0, shrink) : DEFAULT_SIZING.shrink
  }
}

export function normalizeCollapse(input?: Partial<CollapsePolicy> | null): CollapsePolicy {
  const d = DEFAULT_COLLAPSE
  return {
    enabled: Boolean(input?.enabled),
    default:
      input?.default === 'collapsed' || input?.default === 'hidden'
        ? input.default
        : d.default,
    mode:
      input?.mode === 'icon-strip' ||
      input?.mode === 'accordion' ||
      input?.mode === 'peek'
        ? input.mode
        : d.mode,
    trigger:
      input?.trigger === 'edge-hover' ||
      input?.trigger === 'focus-mode' ||
      input?.trigger === 'width'
        ? input.trigger
        : d.trigger,
    restoreWidth: Number.isFinite(Number(input?.restoreWidth))
      ? Math.max(0, Math.round(Number(input?.restoreWidth)))
      : undefined
  }
}

export function createFrame(
  role: LayoutFrame['role'],
  axis: LayoutAxis,
  children: LayoutNode[] = [],
  options: Partial<Omit<LayoutFrame, 'type' | 'id' | 'role' | 'axis' | 'children'>> & { id?: string } = {}
): LayoutFrame {
  return {
    type: 'frame',
    id: options.id || createNodeId(role),
    role,
    axis,
    mode: options.mode || 'flow',
    children,
    sizing: normalizeSizing(options.sizing),
    gap: Number.isFinite(Number(options.gap)) ? Math.max(0, Number(options.gap)) : undefined,
    padding: Number.isFinite(Number(options.padding)) ? Math.max(0, Number(options.padding)) : undefined,
    align: options.align || 'stretch',
    overflow: options.overflow || 'grow',
    collapse: normalizeCollapse(options.collapse),
    locked: options.locked === true,
    label: options.label
  }
}

export function createBlock(
  blockId: string,
  options: Partial<Omit<LayoutBlockNode, 'type' | 'id' | 'blockId'>> & { id?: string } = {}
): LayoutBlockNode {
  return {
    type: 'block',
    id: options.id || createNodeId(blockId.replace(/[^a-z0-9-]+/gi, '-')),
    blockId,
    children: options.children ? options.children.map(cloneNode) : undefined,
    sizing: options.sizing ? normalizeSizing({ ...DEFAULT_SIZING, ...options.sizing }) : undefined,
    visibility: options.visibility || 'always',
    anchor: options.anchor || 'start',
    locked: options.locked === true,
    props: options.props ? { ...options.props } : {}
  }
}

export function createSpacer(kind: 'spacer' | 'divider' = 'spacer', sizing?: Partial<NodeSizing>): LayoutSpacer {
  return {
    type: kind,
    id: createNodeId(kind),
    sizing: normalizeSizing(sizing)
  }
}

export function createDefaultLayoutDocument(name = '当前布局'): LayoutDocument {
  const content = createBlock('content.main', {
    id: 'content-main',
    sizing: { basis: 1, unit: 'fraction', min: 1, grow: 1 },
    locked: true
  })
  const top = createFrame('bar', 'row', [
    createBlock('tabs.strip', { id: 'tabs-strip', sizing: { basis: 1, unit: 'fraction', grow: 1 } }),
    createBlock('tabs.new', { id: 'tabs-new', sizing: { basis: 32, unit: 'px', min: 32, max: 40 } }),
    createBlock('navbar.address', { id: 'navbar-address', sizing: { basis: 1, unit: 'fraction', grow: 1 } }),
    createBlock('navbar.menu', { id: 'navbar-menu', sizing: { basis: 32, unit: 'px', min: 28, max: 40 } })
  ], {
    id: 'top-bar',
    label: '顶部栏',
    mode: 'flow',
    gap: 8,
    padding: 8,
    sizing: { basis: 54, unit: 'px', min: 42, max: 96, shrink: 0 }
  })
  const leftDock = createFrame('dock', 'column', [
    createFrame('toolbar-group', 'column', [
      createBlock('rail.panel.favorites', { id: 'rail-favorites', sizing: { basis: 32, unit: 'px', min: 28, max: 40 } }),
      createBlock('rail.panel.history', { id: 'rail-history', sizing: { basis: 32, unit: 'px', min: 28, max: 40 } }),
      createBlock('rail.panel.downloads', { id: 'rail-downloads', sizing: { basis: 32, unit: 'px', min: 28, max: 40 } }),
      createBlock('rail.panel.notes', { id: 'rail-notes', sizing: { basis: 32, unit: 'px', min: 28, max: 40 } })
    ], {
      id: 'rail-primary',
      label: '工具',
      gap: 6,
      padding: 8,
      sizing: { basis: 56, unit: 'px', min: 48, max: 72, shrink: 0 },
      collapse: {
        enabled: true,
        default: 'expanded',
        mode: 'icon-strip',
        trigger: 'manual',
        restoreWidth: 232
      }
    })
  ], {
    id: 'dock-left',
    label: '左侧栏',
    gap: 6,
    padding: 4,
    sizing: { basis: 56, unit: 'px', min: 0, max: 620, shrink: 0 }
  })
  const rightDock = createFrame('custom-column', 'column', [
    createFrame('panel-group', 'column', [
      createBlock('panel.notes-panel', { id: 'panel-notes', sizing: { basis: 1, unit: 'fraction', grow: 1 } })
    ], {
      id: 'panel-group-right',
      label: '研究面板',
      mode: 'tabs',
      gap: 6,
      padding: 8,
      sizing: { basis: 320, unit: 'px', min: 220, max: 620, shrink: 0 },
      collapse: {
        enabled: true,
        default: 'expanded',
        mode: 'off-canvas',
        trigger: 'manual',
        restoreWidth: 320
      }
    })
  ], {
    id: 'dock-right',
    label: '右侧栏',
    gap: 6,
    padding: 4,
    sizing: { basis: 320, unit: 'px', min: 0, max: 760, shrink: 0 }
  })
  const center = createFrame('column', 'column', [top, content], {
    id: 'main-column',
    label: '主内容',
    gap: 0,
    sizing: { basis: 1, unit: 'fraction', min: 240, grow: 1 }
  })
  const root = createFrame('root', 'row', [leftDock, center, rightDock], {
    id: 'layout-root',
    label: '窗口',
    gap: 0,
    sizing: { basis: 1, unit: 'fraction', grow: 1 }
  })
  const timestamp = now()
  return {
    schemaVersion: 1,
    id: createLayoutId('layout'),
    name,
    root,
    variants: [
      {
        id: 'narrow',
        label: '窄窗口',
        when: { maxWidth: 1080 },
        patches: [{ op: 'set-visibility', nodeId: 'dock-right', value: 'collapsed' }]
      },
      {
        id: 'focus',
        label: '专注模式',
        when: { context: ['focus'] },
        patches: [
          { op: 'set-visibility', nodeId: 'dock-left', value: 'collapsed' },
          { op: 'set-visibility', nodeId: 'dock-right', value: 'collapsed' }
        ]
      }
    ],
    metadata: { createdAt: timestamp, updatedAt: timestamp }
  }
}

export function cloneNode<T extends LayoutNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T
}

export function cloneDocument(document: LayoutDocument): LayoutDocument {
  return JSON.parse(JSON.stringify(document)) as LayoutDocument
}

export function walkNodes(root: LayoutNode, visit: (node: LayoutNode, parent: LayoutFrame | null) => void): void {
  const stack: Array<{ node: LayoutNode; parent: LayoutFrame | null }> = [{ node: root, parent: null }]
  while (stack.length) {
    const item = stack.pop()!
    visit(item.node, item.parent)
    const children = getChildren(item.node)
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], parent: item.node.type === 'frame' ? item.node : item.parent })
    }
  }
}

export function getChildren(node: LayoutNode): LayoutNode[] {
  if (node.type === 'frame') return node.children
  if (node.type === 'block') return node.children || []
  return []
}

export function findNode(root: LayoutNode, nodeId: string): LayoutNode | null {
  if (root.id === nodeId) return root
  for (const child of getChildren(root)) {
    const found = findNode(child, nodeId)
    if (found) return found
  }
  return null
}

export function findParent(root: LayoutNode, nodeId: string): LayoutFrame | null {
  if (root.type === 'frame') {
    for (const child of root.children) {
      if (child.id === nodeId) return root
      const nested = findParent(child, nodeId)
      if (nested) return nested
    }
  } else if (root.type === 'block' && root.children) {
    for (const child of root.children) {
      if (child.id === nodeId) return null
      const nested = findParent(child, nodeId)
      if (nested) return nested
    }
  }
  return null
}

export function collectNodeIds(root: LayoutNode): string[] {
  const ids: string[] = []
  walkNodes(root, (node) => ids.push(node.id))
  return ids
}

function removeById(root: LayoutNode, nodeId: string): LayoutNode | null {
  if (root.type === 'frame') {
    const index = root.children.findIndex((child) => child.id === nodeId)
    if (index >= 0) return root.children.splice(index, 1)[0]
    for (const child of root.children) {
      const removed = removeById(child, nodeId)
      if (removed) return removed
    }
  } else if (root.type === 'block' && root.children) {
    const index = root.children.findIndex((child) => child.id === nodeId)
    if (index >= 0) return root.children.splice(index, 1)[0]
    for (const child of root.children) {
      const removed = removeById(child, nodeId)
      if (removed) return removed
    }
  }
  return null
}

function reidTree(node: LayoutNode): LayoutNode {
  const clone = cloneNode(node)
  const assign = (current: LayoutNode): void => {
    current.id = createNodeId(current.type)
    for (const child of getChildren(current)) assign(child)
  }
  assign(clone)
  return clone
}

function ensureUniqueContent(root: LayoutFrame): void {
  let seen = false
  walkNodes(root, (node, parent) => {
    if (node.type !== 'block' || node.blockId !== 'content.main') return
    if (!seen) {
      seen = true
      return
    }
    if (parent) parent.children = parent.children.filter((child) => child.id !== node.id)
  })
  if (!seen) {
    const content = createBlock('content.main', {
      id: 'content-main',
      sizing: { basis: 1, unit: 'fraction', min: 1, grow: 1 },
      locked: true
    })
    const insertion = root.children[Math.min(1, root.children.length)] as LayoutFrame | undefined
    if (insertion?.type === 'frame' && insertion.axis === 'column') insertion.children.push(content)
    else root.children.push(createFrame('column', 'column', [content], { id: 'safe-main-column', sizing: { basis: 1, unit: 'fraction', grow: 1 } }))
  }
}

export function normalizeLayoutDocument(input: unknown): LayoutDocument {
  const raw = input && typeof input === 'object' ? (input as Partial<LayoutDocument>) : {}
  const fallback = createDefaultLayoutDocument()
  const root = raw.root && typeof raw.root === 'object' && raw.root.type === 'frame'
    ? (cloneNode(raw.root as LayoutFrame) as LayoutFrame)
    : fallback.root
  const stamp = now()
  const variants = Array.isArray(raw.variants)
    ? raw.variants.filter((item): item is LayoutVariant => Boolean(item && typeof item === 'object' && item.id)).slice(0, 32)
    : []
  const document: LayoutDocument = {
    schemaVersion: 1,
    id: typeof raw.id === 'string' && raw.id ? raw.id : createLayoutId('layout'),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : '当前布局',
    root,
    variants: variants.map((variant) => ({
      ...variant,
      when: { ...variant.when },
      patches: Array.isArray(variant.patches) ? variant.patches.slice(0, 64) : []
    })),
    metadata: {
      createdAt: Number(raw.metadata?.createdAt) || stamp,
      updatedAt: Number(raw.metadata?.updatedAt) || stamp,
      templateId: typeof raw.metadata?.templateId === 'string' ? raw.metadata.templateId : undefined,
      description: typeof raw.metadata?.description === 'string' ? raw.metadata.description.slice(0, 240) : undefined
    }
  }
  walkNodes(document.root, (node) => {
    if (node.type === 'frame') {
      node.mode = node.mode === 'wrap' || node.mode === 'scroll' || node.mode === 'stack' || node.mode === 'tabs' || node.mode === 'overlay' ? node.mode : 'flow'
      node.children = Array.isArray(node.children) ? node.children : []
      node.sizing = normalizeSizing(node.sizing)
      node.collapse = normalizeCollapse(node.collapse)
    } else if (node.type === 'block') {
      node.children = Array.isArray(node.children) ? node.children : undefined
      node.sizing = node.sizing ? normalizeSizing(node.sizing) : undefined
      node.visibility = node.visibility || 'always'
      node.props = node.props && typeof node.props === 'object' ? node.props : {}
    }
  })
  ensureUniqueContent(document.root)
  return document
}

export function applyLayoutCommand(document: LayoutDocument, command: LayoutCommand): CommandResult {
  const next = cloneDocument(normalizeLayoutDocument(document))
  let changedNodeIds: string[] = []
  switch (command.type) {
    case 'insert': {
      const parent = findNode(next.root, command.parentId)
      if (!parent || parent.type !== 'frame') return unchanged(document)
      parent.children.splice(Math.max(0, Math.min(command.index, parent.children.length)), 0, cloneNode(command.node))
      changedNodeIds = [parent.id, command.node.id]
      break
    }
    case 'remove': {
      const node = findNode(next.root, command.nodeId)
      if (!node || node.type === 'frame' && node.role === 'root') return unchanged(document)
      if (node.type === 'block' && (node.locked || node.blockId === 'content.main')) return unchanged(document)
      const parent = findParent(next.root, command.nodeId)
      if (!removeById(next.root, command.nodeId)) return unchanged(document)
      changedNodeIds = [command.nodeId, ...(parent ? [parent.id] : [])]
      break
    }
    case 'move': {
      if (!findNode(next.root, command.nodeId)) return unchanged(document)
      const target = findNode(next.root, command.parentId)
      if (!target || target.type !== 'frame') return unchanged(document)
      if (command.nodeId === command.parentId || isDescendant(next.root, command.nodeId, command.parentId)) return unchanged(document)
      const moved = removeById(next.root, command.nodeId)
      if (!moved) return unchanged(document)
      target.children.splice(Math.max(0, Math.min(command.index, target.children.length)), 0, moved)
      changedNodeIds = [command.nodeId, command.parentId]
      break
    }
    case 'reorder': {
      const parent = findNode(next.root, command.parentId)
      if (!parent || parent.type !== 'frame') return unchanged(document)
      const byId = new Map(parent.children.map((child) => [child.id, child]))
      const ordered = command.orderedIds.map((id) => byId.get(id)).filter((child): child is LayoutNode => Boolean(child))
      for (const child of parent.children) if (!command.orderedIds.includes(child.id)) ordered.push(child)
      parent.children = ordered
      changedNodeIds = [parent.id]
      break
    }
    case 'resize': {
      const node = findNode(next.root, command.nodeId)
      if (!node) return unchanged(document)
      const current = normalizeSizing(node.type === 'frame' ? node.sizing : node.sizing)
      const patch = { ...current, ...command.sizing }
      const sizing = normalizeSizing(patch)
      if (node.type === 'frame') node.sizing = sizing
      else node.sizing = sizing
      changedNodeIds = [node.id]
      break
    }
    case 'set-props': {
      const node = findNode(next.root, command.nodeId)
      if (!node || node.type !== 'block') return unchanged(document)
      node.props = { ...(node.props || {}), ...command.patch }
      changedNodeIds = [node.id]
      break
    }
    case 'set-frame': {
      const node = findNode(next.root, command.nodeId)
      if (!node || node.type !== 'frame') return unchanged(document)
      if (command.patch.axis === 'row' || command.patch.axis === 'column') node.axis = command.patch.axis
      if (command.patch.mode) node.mode = command.patch.mode
      if (command.patch.gap != null) node.gap = Math.max(0, Math.round(Number(command.patch.gap) || 0))
      if (command.patch.padding != null) node.padding = Math.max(0, Math.round(Number(command.patch.padding) || 0))
      if (command.patch.align) node.align = command.patch.align
      if (command.patch.overflow) node.overflow = command.patch.overflow
      if (command.patch.label != null) node.label = String(command.patch.label).slice(0, 80)
      changedNodeIds = [node.id]
      break
    }
    case 'set-visibility': {
      const node = findNode(next.root, command.nodeId)
      if (!node || node.type !== 'block') return unchanged(document)
      node.visibility = command.visibility
      changedNodeIds = [node.id]
      break
    }
    case 'set-collapse': {
      const node = findNode(next.root, command.nodeId)
      if (!node) return unchanged(document)
      if (node.type === 'frame') node.collapse = normalizeCollapse({ ...node.collapse, ...command.value })
      else if (node.type === 'block') node.props = { ...(node.props || {}), collapse: { ...(node.props?.collapse as object || {}), ...command.value } }
      changedNodeIds = [node.id]
      break
    }
    case 'group': {
      if (!command.nodeIds.length) return unchanged(document)
      const parent = findParent(next.root, command.nodeIds[0])
      if (!parent) return unchanged(document)
      const ids = new Set(command.nodeIds)
      const selected = parent.children.filter((child) => ids.has(child.id))
      if (!selected.length) return unchanged(document)
      const insertAt = parent.children.findIndex((child) => ids.has(child.id))
      parent.children = parent.children.filter((child) => !ids.has(child.id))
      const frame = cloneNode(command.frame)
      frame.children = selected.map(cloneNode)
      parent.children.splice(Math.max(0, insertAt), 0, frame)
      changedNodeIds = [parent.id, frame.id, ...selected.map((node) => node.id)]
      break
    }
    case 'ungroup': {
      const frame = findNode(next.root, command.frameId)
      const parent = findParent(next.root, command.frameId)
      if (!frame || frame.type !== 'frame' || frame.role === 'root' || !parent) return unchanged(document)
      const index = parent.children.findIndex((child) => child.id === frame.id)
      parent.children.splice(index, 1, ...frame.children)
      changedNodeIds = [frame.id, parent.id]
      break
    }
    case 'duplicate': {
      const parent = findParent(next.root, command.nodeId)
      const source = parent?.children.find((child) => child.id === command.nodeId)
      if (!parent || !source) return unchanged(document)
      const copy = reidTree(source)
      const index = parent.children.findIndex((child) => child.id === command.nodeId)
      parent.children.splice(index + 1, 0, copy)
      changedNodeIds = [copy.id, parent.id]
      break
    }
    case 'rename-document': {
      const name = command.name.trim().slice(0, 80)
      if (!name || name === next.name) return unchanged(document)
      next.name = name
      changedNodeIds = []
      break
    }
  }
  next.metadata.updatedAt = now()
  return { document: next, changedNodeIds, changed: changedNodeIds.length > 0 || next.name !== document.name }
}

function unchanged(document: LayoutDocument): CommandResult {
  return { document, changedNodeIds: [], changed: false }
}

function isDescendant(root: LayoutNode, ancestorId: string, candidateId: string): boolean {
  const ancestor = findNode(root, ancestorId)
  if (!ancestor) return false
  let found = false
  walkNodes(ancestor, (node) => {
    if (node.id === candidateId) found = true
  })
  return found
}

export function applyVariantPatches(document: LayoutDocument, variantId: string): LayoutDocument {
  const next = cloneDocument(normalizeLayoutDocument(document))
  const variant = next.variants.find((item) => item.id === variantId)
  if (!variant) return next
  for (const patch of variant.patches) {
    const node = findNode(next.root, patch.nodeId)
    if (!node) continue
    if (patch.op === 'set-sizing') {
      const sizing = normalizeSizing({ ...(node.sizing || DEFAULT_SIZING), ...(patch.value as Partial<NodeSizing>) })
      node.sizing = sizing
    } else if (patch.op === 'set-visibility' && node.type === 'block') {
      node.visibility = patch.value as NodeVisibility
    } else if (patch.op === 'set-collapse' && node.type === 'frame') {
      node.collapse = normalizeCollapse({ ...node.collapse, ...(patch.value as Partial<CollapsePolicy>) })
    } else if (patch.op === 'set-frame-mode' && node.type === 'frame') {
      node.mode = patch.value as FrameMode
    } else if (patch.op === 'set-props' && node.type === 'block') {
      node.props = { ...(node.props || {}), ...(patch.value as Record<string, unknown>) }
    }
  }
  return next
}

export interface ExportEnvelope {
  format: 'hira-layout'
  formatVersion: 1
  exportedAt: number
  document: LayoutDocument
}

export function exportLayoutDocument(document: LayoutDocument): string {
  const envelope: ExportEnvelope = {
    format: 'hira-layout',
    formatVersion: 1,
    exportedAt: now(),
    document: normalizeLayoutDocument(document)
  }
  return JSON.stringify(envelope, null, 2)
}

export function importLayoutDocument(text: string): LayoutDocument {
  const parsed = JSON.parse(text) as Partial<ExportEnvelope> | Partial<LayoutDocument>
  const source = 'document' in parsed && parsed.document ? parsed.document : parsed
  const document = normalizeLayoutDocument(source)
  document.id = createLayoutId('layout')
  return document
}

