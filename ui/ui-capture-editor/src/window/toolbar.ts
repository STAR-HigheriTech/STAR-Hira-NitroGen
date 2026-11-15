import {
  CAPTURE_COLORS,
  CAPTURE_TOOLS,
  CAPTURE_WIDTHS
} from '@hira-ng/shared-types/src/capture-annotate.mjs'
import { iconByName } from '@hira-ng/ui-common'

export interface CaptureToolbarSnapshot {
  tool: string
  color: string
  width: number
  zoom: number
  ready: boolean
  canUndo: boolean
  canRedo: boolean
  busy: boolean
}

export interface CaptureToolbarActions {
  tool(value: string): void
  color(value: string): void
  width(value: number): void
  resetZoom(): void
  undo(): void
  redo(): void
  copy(): void
  save(): void
  close(): void
}

export interface CaptureToolbarController {
  readonly element: HTMLElement
  update(snapshot: CaptureToolbarSnapshot): void
  flash(message: string, tone?: 'neutral' | 'success' | 'error'): void
  measure(): { width: number; height: number }
  destroy(): void
}

type IconFactory = (name: string, size?: number) => Node | null

interface ButtonParts {
  root: HTMLButtonElement
  label: HTMLSpanElement | null
}

function makeButton(
  doc: Document,
  icon: IconFactory,
  iconName: string,
  label: string,
  className: string,
  onClick: () => void
): ButtonParts {
  const root = doc.createElement('button')
  root.type = 'button'
  root.className = `hira-capture-button ${className}`.trim()
  root.setAttribute('aria-label', label)
  root.title = label
  const glyph = icon(iconName, 16)
  if (glyph) root.appendChild(glyph)

  let labelElement: HTMLSpanElement | null = null
  if (label) {
    labelElement = doc.createElement('span')
    labelElement.className = 'hira-capture-button__label'
    labelElement.textContent = label
    root.appendChild(labelElement)
  }
  root.addEventListener('click', onClick)
  return { root, label: labelElement }
}

function group(doc: Document, label: string, className: string): HTMLDivElement {
  const element = doc.createElement('div')
  element.className = `hira-capture-group ${className}`.trim()
  element.setAttribute('role', 'group')
  element.setAttribute('aria-label', label)
  return element
}

function divider(doc: Document): HTMLSpanElement {
  const element = doc.createElement('span')
  element.className = 'hira-capture-divider'
  element.setAttribute('aria-hidden', 'true')
  return element
}

export function createCaptureToolbar(
  doc: Document,
  actions: CaptureToolbarActions
): CaptureToolbarController {
  const icon: IconFactory = (name, size = 16) => {
    try {
      return iconByName(name, doc, { size }) || null
    } catch (_) {
      return null
    }
  }

  const element = doc.createElement('section')
  element.className = 'hira-capture-toolbar'
  element.setAttribute('role', 'toolbar')
  element.setAttribute('aria-label', '截图标注工具')

  const tools = group(doc, '标注工具', 'hira-capture-tools')
  const toolButtons = new Map<string, HTMLButtonElement>()
  for (const item of CAPTURE_TOOLS) {
    const parts = makeButton(doc, icon, item.icon, '', 'hira-capture-tool', () => actions.tool(item.id))
    parts.root.setAttribute('aria-label', item.label)
    parts.root.title = item.label
    parts.root.setAttribute('aria-pressed', 'false')
    parts.root.dataset.tool = item.id
    toolButtons.set(item.id, parts.root)
    tools.appendChild(parts.root)
  }

  const styleGroup = group(doc, '颜色与线宽', 'hira-capture-style')
  const colors = group(doc, '标注颜色', 'hira-capture-colors')
  const colorButtons = new Map<string, HTMLButtonElement>()
  for (const value of CAPTURE_COLORS) {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'hira-capture-swatch'
    button.style.setProperty('--capture-swatch', value)
    button.setAttribute('aria-label', `颜色 ${value}`)
    button.setAttribute('aria-pressed', 'false')
    button.title = value
    button.addEventListener('click', () => actions.color(value))
    colorButtons.set(value, button)
    colors.appendChild(button)
  }

  const widths = group(doc, '线宽', 'hira-capture-widths')
  const widthButtons = new Map<number, HTMLButtonElement>()
  for (const value of CAPTURE_WIDTHS) {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'hira-capture-width'
    button.setAttribute('aria-label', `线宽 ${value}`)
    button.setAttribute('aria-pressed', 'false')
    button.title = `线宽 ${value}`
    const dot = doc.createElement('span')
    dot.className = 'hira-capture-width__dot'
    const size = value + 2
    dot.style.width = `${size}px`
    dot.style.height = `${size}px`
    button.appendChild(dot)
    button.addEventListener('click', () => actions.width(value))
    widthButtons.set(value, button)
    widths.appendChild(button)
  }
  styleGroup.append(colors, widths)

  const spacer = doc.createElement('span')
  spacer.className = 'hira-capture-spacer'

  const viewGroup = group(doc, '视图与历史', 'hira-capture-view-actions')
  const zoom = doc.createElement('button')
  zoom.type = 'button'
  zoom.className = 'hira-capture-zoom'
  zoom.title = '恢复到适应视图（Ctrl+0）'
  zoom.setAttribute('aria-label', '恢复到适应视图')
  zoom.textContent = '100%'
  zoom.addEventListener('click', actions.resetZoom)
  const undo = makeButton(doc, icon, 'Undo2', '', 'hira-capture-undo', actions.undo)
  undo.root.setAttribute('aria-label', '撤销')
  undo.root.title = '撤销（Ctrl+Z）'
  const redo = makeButton(doc, icon, 'Redo2', '', 'hira-capture-redo', actions.redo)
  redo.root.setAttribute('aria-label', '重做')
  redo.root.title = '重做（Ctrl+Shift+Z / Ctrl+Y）'
  viewGroup.append(zoom, undo.root, redo.root)

  const delivery = group(doc, '保存与关闭', 'hira-capture-delivery')
  const copy = makeButton(doc, icon, 'Copy', '复制', 'hira-capture-copy hira-capture-button--primary', actions.copy)
  const save = makeButton(doc, icon, 'Download', '保存', 'hira-capture-save', actions.save)
  const close = makeButton(doc, icon, 'X', '', 'hira-capture-close hira-capture-button--quiet', actions.close)
  close.root.setAttribute('aria-label', '关闭')
  close.root.title = '关闭（Esc）'
  delivery.append(copy.root, save.root, close.root)

  const status = doc.createElement('div')
  status.className = 'hira-capture-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  element.append(tools, divider(doc), styleGroup, spacer, viewGroup, divider(doc), delivery, status)

  let statusTimer = 0
  let current: CaptureToolbarSnapshot | null = null
  const view = doc.defaultView

  function update(next: CaptureToolbarSnapshot): void {
    current = next
    for (const [id, button] of toolButtons) {
      const active = id === next.tool
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    }
    for (const [value, button] of colorButtons) {
      const active = value === next.color
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    }
    for (const [value, button] of widthButtons) {
      const active = value === next.width
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    }
    zoom.textContent = `${Math.round(next.zoom * 100)}%`
    zoom.classList.toggle('is-fit', Math.abs(next.zoom - 1) < 0.005)
    undo.root.disabled = !next.canUndo
    redo.root.disabled = !next.canRedo
    copy.root.disabled = !next.ready || next.busy
    save.root.disabled = !next.ready || next.busy
    copy.root.classList.toggle('is-busy', next.busy)
    if (copy.label) copy.label.textContent = next.busy ? '处理中' : '复制'
  }

  function flash(message: string, tone: 'neutral' | 'success' | 'error' = 'neutral'): void {
    if (!view) return
    status.textContent = message
    status.dataset.tone = tone
    status.classList.remove('is-visible')
    void status.offsetWidth
    status.classList.add('is-visible')
    if (statusTimer) view.clearTimeout(statusTimer)
    statusTimer = view.setTimeout(() => {
      status.classList.remove('is-visible')
      statusTimer = 0
    }, 1800)
  }

  function measure(): { width: number; height: number } {
    const rect = element.getBoundingClientRect()
    return {
      width: Math.ceil(rect.width || 1),
      height: Math.ceil(rect.height || 1)
    }
  }

  return {
    element,
    update,
    flash,
    measure,
    destroy() {
      if (statusTimer && view) view.clearTimeout(statusTimer)
      statusTimer = 0
      current = null
      element.remove()
    }
  }
}
