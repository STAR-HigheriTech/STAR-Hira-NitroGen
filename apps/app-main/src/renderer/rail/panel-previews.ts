import { IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { createFileIconLoader } from '@hira-ng/shared-types/src/file-icon.mjs'
import { getHiraBridge } from '../shared/bridge.js'
import { bookmarksClient } from '../shared/bookmarks-client.js'
import { profilesClient } from '../shared/profile-client.js'
import { spaceClient } from '../shared/space-client.js'
import { tabsClient } from '../shared/tabs-client.js'
import type { RailPointerModifiers } from '@hira-ng/ui-taskoverlay'
import { openRailBookmark } from './bookmark-activation.js'

export interface RailPreviewItem {
  id: string
  label: string
  meta?: string
  status?: string
  favicon?: string
  iconUrl?: string
  iconSrc?: string
  filename?: string
  action?: {
    kind: 'url' | 'bookmark' | 'download' | 'space' | 'recent'
    target: string
    profileId?: string
  }
}

export type RailPreviewProvider = (panelId: string) => Promise<RailPreviewItem[]>

const providers = new Map<string, RailPreviewProvider>()

/**
 * 注册一块面板的展开态摘要来源。
 *
 * rail 只认识 `{ label, value }`，不认识标签 / 书签 / 历史。后续新增面板只需在这里
 * 注册 provider，或者在插件宿主层接一份同类数据，不必修改 rail 组件。
 */
export function registerRailPreviewProvider(panelId: string, provider: RailPreviewProvider): void {
  const id = String(panelId || '').trim()
  if (!id || typeof provider !== 'function') return
  providers.set(id, provider)
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : []
}

function text(value: unknown): string {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
}

function hostOf(url: unknown): string {
  const raw = text(url)
  if (!raw) return ''
  try { return new URL(raw).hostname.replace(/^www\./i, '') } catch (_) { return raw }
}

function finish(items: RailPreviewItem[]): RailPreviewItem[] {
  return items
    .filter((item) => item && item.label && !!item.action?.target)
    .map((item) => ({
      id: String(item.id || item.label),
      label: item.label.slice(0, 44),
      ...(item.meta ? { meta: item.meta.slice(0, 180) } : {}),
      ...(item.status ? { status: item.status.slice(0, 24) } : {}),
      ...(item.favicon ? { favicon: item.favicon } : {}),
      ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
      ...(item.iconSrc ? { iconSrc: item.iconSrc } : {}),
      ...(item.filename ? { filename: item.filename } : {}),
      ...(item.action ? { action: item.action } : {})
    }))
    .slice(0, 2)
}

registerRailPreviewProvider('history-panel', async () => {
  const result = await tabsClient.recentlyClosed()
  const tabs = arrayOf(result && result.tabs)
  return finish(tabs.map((entry, index) => ({
    id: `${text(entry.closedAt)}:${index}:${text(entry.url)}`,
    label: text(entry.title) || hostOf(entry.url),
    meta: text(entry.url),
    favicon: text(entry.favicon),
    action: { kind: 'recent', target: String(index) }
  })))
})

registerRailPreviewProvider('favorites-panel', async () => {
  const bookmarks = arrayOf(await bookmarksClient.list())
  return finish(bookmarks.map((bookmark) => ({
    id: String(bookmark.id || bookmark.url || bookmark.title),
    label: text(bookmark.nickname) || text(bookmark.title) || hostOf(bookmark.url),
    favicon: text(bookmark.favicon),
    iconUrl: text(bookmark.url),
    action: { kind: 'bookmark', target: text(bookmark.url) }
  })))
})

registerRailPreviewProvider('spaces-panel', async () => {
  const [all, using, profiles] = await Promise.all([
    spaceClient.listAll(),
    spaceClient.getUsing().catch(() => null),
    profilesClient.listVisible().catch(() => [])
  ])
  const spaces = arrayOf(all)
  const profileNames = new Map(arrayOf(profiles).map((profile) => [
    text(profile.id),
    text(profile.name) || text(profile.id)
  ]))
  const profileId = text(using?.profileId) || text(spaces[0]?.profileId)
  const activeId = text(using?.id)
  return finish(spaces
    .filter((space) => !profileId || text(space.profileId) === profileId)
    .map((space) => {
      const id = text(space.id)
      return {
        id: `${text(space.profileId)}:${id}`,
        label: text(space.name) || id,
        meta: profileNames.get(text(space.profileId)) || text(space.profileId),
        status: id && id === activeId ? '当前' : '',
        action: {
          kind: 'space' as const,
          target: id,
          profileId: text(space.profileId)
        }
      }
    }))
})

const loadDownloadFileIcon = createFileIconLoader((filePath, size) =>
  getHiraBridge().provider.invoke(IPC_ROUTES.downloadGetFileIcon, { filePath, size }).then((result) => {
    if (!result || typeof result !== 'object') return null
    const dataUrl = (result as { dataUrl?: unknown }).dataUrl
    return typeof dataUrl === 'string' ? dataUrl : null
  })
)

registerRailPreviewProvider('downloads-panel', async () => {
  const downloads = arrayOf(await getHiraBridge().provider.invoke(IPC_ROUTES.downloadList))
  const items = await Promise.all(downloads.map(async (download): Promise<RailPreviewItem> => {
    const state = text(download.state)
    const stateLabel = state === 'in_progress'
      ? '下载中'
      : state === 'paused'
        ? '已暂停'
        : state === 'completed'
          ? '已完成'
          : state === 'cancelled'
            ? '已取消'
            : state === 'interrupted' || state === 'failed'
              ? '已中断'
              : ''
    return {
      id: String(download.id ?? download.filename ?? ''),
      label: text(download.filename) || text(download.name),
      meta: stateLabel,
      filename: text(download.filename),
      iconSrc: text(download.filePath)
        ? await loadDownloadFileIcon(text(download.filePath), 16).catch(() => null) || ''
        : '',
      action: { kind: 'download', target: String(download.id ?? '') }
    }
  }))
  return finish(items)
})

/** 执行一条真实摘要项；空目标直接忽略，行为由预览 provider 的 kind 唯一决定。 */
export function activateRailPreview(item: RailPreviewItem, modifiers: RailPointerModifiers): void {
  const action = item && item.action
  if (!action || !action.target) return
  if (action.kind === 'bookmark') {
    openRailBookmark({ url: action.target, title: item.label }, modifiers)
    return
  }
  if (action.kind === 'url') {
    tabsClient.navigate({ url: action.target }).catch(() => {})
    return
  }
  if (action.kind === 'recent') {
    const index = Number(action.target)
    if (Number.isInteger(index) && index >= 0) {
      tabsClient.restoreRecentlyClosed(index).catch(() => {})
    }
    return
  }
  if (action.kind === 'space') {
    if (action.profileId) spaceClient.setUsing(action.profileId, action.target).catch(() => {})
    return
  }
  getHiraBridge().provider.invoke(IPC_ROUTES.downloadOpen, { id: action.target }).catch(() => {})
}

export async function loadRailPreviews(panelIds: readonly string[]): Promise<Map<string, RailPreviewItem[]>> {
  const ids = [...new Set(panelIds.filter((id) => providers.has(id)))]
  const entries = await Promise.all(ids.map(async (id) => {
    try {
      const provider = providers.get(id)
      const items = provider ? await provider(id) : []
      return [id, finish(items)] as const
    } catch (_) {
      return [id, [] as RailPreviewItem[]] as const
    }
  }))
  return new Map(entries)
}
