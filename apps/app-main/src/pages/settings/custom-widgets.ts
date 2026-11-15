import { getActiveManifests, listRendererSlotImpls } from '../../renderer/shared/plugin-slots.js'

export const CUSTOM_WIDGET_SLOT = 'settings.custom-widget'

interface WidgetValue {
  node: Node
  title: string
  blurb: string
}

interface WidgetCard {
  element: HTMLElement
  node: Node
}

function pluginDisplayName(pluginId: string): string {
  const manifest = getActiveManifests().find((item) => String(item?.id) === pluginId)
  const name = manifest?.name
  if (typeof name === 'string' && name.trim()) return name.trim()
  if (name && typeof name === 'object') {
    const localizedName = name as Record<string, unknown>
    const localized = localizedName['zh-CN'] || localizedName['en-US']
    if (typeof localized === 'string' && localized.trim()) return localized.trim()
  }
  return pluginId || '插件'
}

function isWidgetNode(value: unknown): value is Node {
  if (!value || typeof value !== 'object') return false
  const node = value as Node
  return typeof node.nodeType === 'number'
    && typeof node.dispatchEvent === 'function'
    && node.nodeType !== 9
}

function normalizeWidgetValue(value: unknown, fallbackTitle: string): WidgetValue | null {
  if (isWidgetNode(value)) return { node: value, title: fallbackTitle, blurb: '' }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!isWidgetNode(record.element)) return null
  return {
    node: record.element,
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : fallbackTitle,
    blurb: typeof record.blurb === 'string' ? record.blurb.trim() : ''
  }
}

function buildWidgetCard(doc: Document, widget: WidgetValue): WidgetCard | null {
  try {
    const card = doc.createElement('section')
    card.className = 'card plugin-widget'
    if (widget.title) {
      const head = doc.createElement('div')
      head.className = 'card-head plugin-widget__head'
      const title = doc.createElement('h2')
      title.textContent = widget.title
      head.appendChild(title)
      card.appendChild(head)
    }
    if (widget.blurb) {
      const blurb = doc.createElement('p')
      blurb.className = 'plugin-widget__blurb'
      blurb.textContent = widget.blurb
      card.appendChild(blurb)
    }
    const body = doc.createElement('div')
    body.className = 'plugin-widget__body'
    body.appendChild(widget.node)
    card.appendChild(body)
    return { element: card, node: widget.node }
  } catch (error) {
    console.warn('[settings] 插件控件挂载失败（已跳过）:', error)
    return null
  }
}

function disposeWidget(node: Node): () => void {
  return () => {
    try {
      node.dispatchEvent(new CustomEvent('hira:dispose'))
    } catch (error) {
      console.warn('[settings] 插件控件 dispose 失败:', error)
    }
  }
}

/**
 * 把 `settings.custom-widget` 的当前实现挂到分区尾部。
 *
 * 返回的清理函数与生成节点一一对应；调用方在整页重绘前统一执行即可。
 * 每个插件独占一张宿主卡片，插件只能控制卡片正文，不能污染设置页外框。
 */
export function mountCustomWidgets(doc: Document, parent: HTMLElement, sectionId: string): Array<() => void> {
  const disposers: Array<() => void> = []
  for (const entry of listRendererSlotImpls(CUSTOM_WIDGET_SLOT)) {
    let produced: unknown
    try {
      produced = entry.impl(
        { section: sectionId },
        { slotId: CUSTOM_WIDGET_SLOT, pluginId: entry.pluginId }
      )
    } catch (error) {
      console.warn('[settings] 插件控件执行失败（已跳过）:', entry.pluginId, error)
      continue
    }

    const values = Array.isArray(produced) ? produced : [produced]
    for (const value of values) {
      try {
        const widget = normalizeWidgetValue(value, pluginDisplayName(entry.pluginId))
        if (!widget) continue
        const card = buildWidgetCard(doc, widget)
        if (!card) continue
        parent.appendChild(card.element)
        disposers.push(disposeWidget(card.node))
      } catch (error) {
        console.warn('[settings] 插件控件结果无效（已跳过）:', entry.pluginId, error)
      }
    }
  }
  return disposers
}
