/** 书签打开去向与动作映射的唯一实现。 */

export type BookmarkOpenTarget = 'current' | 'tab' | 'tab-or-existing' | 'sidebar'

export const BOOKMARK_OPEN_TARGETS = Object.freeze([
  'current',
  'tab',
  'tab-or-existing',
  'sidebar'
] as const)

export interface BookmarkOpenModifiers {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export interface BookmarkModifierSnapshot {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** Shift 优先侧栏，Alt 优先转到已有标签，Ctrl/Cmd 开新标签，最后才看书签偏好。 */
export function resolveBookmarkOpenTarget(
  modifiers?: BookmarkOpenModifiers | null,
  preferSidebar?: boolean
): BookmarkOpenTarget {
  const current = modifiers || {}
  if (current.shiftKey) return 'sidebar'
  if (current.altKey) return 'tab-or-existing'
  if (current.ctrlKey || current.metaKey) return 'tab'
  if (preferSidebar === true) return 'sidebar'
  return 'current'
}

export function modifiersFromEvent(
  event?: BookmarkOpenModifiers | null
): BookmarkModifierSnapshot {
  return {
    shiftKey: !!event?.shiftKey,
    ctrlKey: !!event?.ctrlKey,
    metaKey: !!event?.metaKey,
    altKey: !!event?.altKey
  }
}

export interface BookmarkOpenPorts {
  url: string
  openCurrent?: (url: string) => void
  openTab?: (url: string) => void
  openSidebar?: (url: string) => void
  findTabId?: (url: string) => string | number | null | undefined | Promise<string | number | null | undefined>
  switchTab?: (tabId: string | number) => void
}

export interface PreferExistingTabPorts {
  list?(): Promise<unknown> | unknown
  newTab(input: { url: string }): Promise<unknown> | unknown
  switchTab?(tabId: string | number): Promise<unknown> | unknown
}

/** URL 匹配键：忽略末尾斜杠与 hash，保留 query（不同查询是不同内部页状态）。 */
export function tabUrlMatchKey(value: unknown): string {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString()
  } catch (_) {
    return raw.replace(/#.*$/, '').replace(/\/+$/, '')
  }
}

/**
 * 打开 URL：当前空间已有同地址标签时直接切过去，否则新开一个。
 * 返回 `existing` / `new`，空 URL 返回 `none`。
 */
export async function openUrlPreferExistingTab(
  rawUrl: string,
  tabs: PreferExistingTabPorts
): Promise<'existing' | 'new' | 'none'> {
  const url = String(rawUrl == null ? '' : rawUrl).trim()
  if (!url) return 'none'
  const target = tabUrlMatchKey(url)
  try {
    const listed = typeof tabs.list === 'function' ? await tabs.list() : []
    const items = Array.isArray(listed) ? listed : []
    const found = items.find((item) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : null
      return row != null && tabUrlMatchKey(row.url) === target
    }) as Record<string, unknown> | undefined
    const tabId = found && (found.id ?? found.tabId)
    if (tabId != null && tabId !== '') {
      if (typeof tabs.switchTab === 'function') {
        await tabs.switchTab(tabId as string | number)
        return 'existing'
      }
    }
  } catch (_) {}
  await tabs.newTab({ url })
  return 'new'
}

export function openBookmarkTarget(target: BookmarkOpenTarget, ports: BookmarkOpenPorts): void {
  const url = ports?.url ? String(ports.url) : ''
  if (!url) return

  if (target === 'sidebar') {
    ports.openSidebar?.(url)
    return
  }
  if (target === 'tab') {
    ports.openTab?.(url)
    return
  }
  if (target === 'tab-or-existing') {
    const openNew = (): void => ports.openTab?.(url)
    if (typeof ports.findTabId !== 'function') {
      openNew()
      return
    }

    Promise.resolve(ports.findTabId(url))
      .then((tabId) => {
        if (tabId !== null && tabId !== undefined && tabId !== '') ports.switchTab?.(tabId)
        else openNew()
      })
      .catch(openNew)
    return
  }
  ports.openCurrent?.(url)
}
