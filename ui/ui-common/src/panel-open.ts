/** 面板内打开页面的去向规则与执行适配。 */

export type PanelOpenTarget = 'tab' | 'sidebar'

export const PANEL_OPEN_TARGETS = Object.freeze(['tab', 'sidebar'] as const)

export interface PanelOpenModifiers {
  altKey?: boolean
}

/** 无修饰键开新标签，Alt 开独立侧栏。 */
export function resolvePanelOpenTarget(
  modifiers?: PanelOpenModifiers | null
): PanelOpenTarget {
  return modifiers?.altKey ? 'sidebar' : 'tab'
}

export interface PanelOpenPorts {
  url: string
  title?: string
  openTab?: (url: string) => void
  openSidebar?: (url: string, title: string) => void
}

export function openPanelTarget(target: PanelOpenTarget, ports: PanelOpenPorts): void {
  const url = ports?.url ? String(ports.url) : ''
  if (!url) return

  if (target === 'sidebar') {
    ports.openSidebar?.(url, ports.title || '')
    return
  }
  ports.openTab?.(url)
}
