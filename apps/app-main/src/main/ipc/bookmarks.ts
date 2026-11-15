import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import type { SlotCaller } from '../slot-call'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface ContributionPort { list(kind: string): unknown }
interface BookmarkIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['bookmarks']
  bookmarkService: MethodPort
  providerRegistry?: ProviderRegistryPort | null
  slots?: SlotCaller
  contributions?: ContributionPort | null
}

export function registerBookmarkIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, bookmarkService, providerRegistry, slots, contributions }: BookmarkIpcContext
): void {
  if (!bookmarkService) return

  const invoke = createProviderInvoker(providerRegistry)

  // ── 插件贡献的导入格式（扩展点 `bookmark.import-format`，MULTI）──────────
  //
  // 契约：实现返回 `{ format, label?, toHtml(content) }`，**产出 Netscape Bookmark HTML**。
  // 为什么让插件产出 HTML 而不是"直接写库"：
  //   · 写库需要把 domain 的增删改查整套暴露给插件 —— 那是把数据层的边界拆了；
  //   · 产出 HTML 则**复用**既有的 `importHtml` 解析/层级/去重/变更广播，插件只负责
  //     "把陌生格式翻译成我认识的格式"，职责单一且天然不会绕过既有语义。
  /**
   * @returns {string|null} 解析后的 HTML；null = 没有能处理该格式的实现
   */
  function parseWithPluginFormat(format: unknown, content: unknown): string | null {
    if (!slots || typeof slots.multi !== 'function') return null
    const impls = slots.multi('bookmark.import-format', { format, content })
    const wanted = String(format).toLowerCase()
    const hit = impls
      .flat(1)
      .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {})
      .find((item) => typeof item.toHtml === 'function' &&
        (!item.format || String(item.format).toLowerCase() === wanted))
    if (!hit) return null
    return (hit.toHtml as (value: string) => string)(content == null ? '' : String(content))
  }

  /**
   * 可用格式清单 —— 取**声明侧**（manifest 的 `contributes.importFormats`），
   * 而不是去跑一遍插槽：列个下拉不该以"执行所有插件的解析器"为代价。
   */
  function listImportFormats(): Array<{ id: string; label: string }> {
    if (!contributions || typeof contributions.list !== 'function') return []
    try {
      const formats = contributions.list('importFormats')
      return (Array.isArray(formats) ? formats : [])
        .map((value) => {
          const f = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          return {
            id: String(f.id || '').trim(),
            label: String(f.label || f.name || f.id || '').trim()
          }
        })
        .filter((f) => f.id)
    } catch (_) {
      return []
    }
  }

  typedMain.handle(routes.bookmarkList, { requestSchema: schemas.list.request, responseSchema: schemas.list.response, handler: async (_e, req) => invoke('bookmark.list', () => bookmarkService.list(req?.parentId ?? null), req) })
  typedMain.handle(routes.bookmarkAdd, { requestSchema: schemas.add.request, responseSchema: schemas.add.response, handler: async (_e, req) => invoke('bookmark.add', () => bookmarkService.add(req), req) })
  typedMain.handle(routes.bookmarkRemove, { requestSchema: schemas.remove.request, responseSchema: schemas.remove.response, handler: async (_e, req) => ({ ok: await invoke('bookmark.remove', () => bookmarkService.remove(req.id), req) }) })
  typedMain.handle(routes.bookmarkUpdate, { requestSchema: schemas.update.request, responseSchema: schemas.update.response, handler: async (_e, req) => invoke('bookmark.update', () => bookmarkService.update(req.id, req), req) })
  typedMain.handle(routes.bookmarkSearch, { requestSchema: schemas.search.request, responseSchema: schemas.search.response, handler: async (_e, req) => invoke('bookmark.search', () => bookmarkService.search(req.query, { tag: req.tag ?? null }), req) })
  typedMain.handle(routes.bookmarkMove, { requestSchema: schemas.move.request, responseSchema: schemas.move.response, handler: async (_e, req) => invoke('bookmark.move', () => bookmarkService.move(req.id, req.parentId), req) })
  typedMain.handle(routes.bookmarkReorder, { requestSchema: schemas.reorder.request, responseSchema: schemas.reorder.response, handler: async (_e, req) => ({ ok: await invoke('bookmark.reorderChildren', () => bookmarkService.reorderChildren(req.parentId, req.orderedIds), req) }) })
  typedMain.handle(routes.bookmarkExport, { requestSchema: schemas.export.request, responseSchema: schemas.export.response, handler: async () => invoke('bookmark.exportHtml', () => bookmarkService.exportHtml(), null) })
  typedMain.handle(routes.bookmarkImport, {
    requestSchema: schemas.import.request,
    responseSchema: schemas.import.response,
    handler: async (_e, req) => {
      const format = typeof req?.format === 'string' ? req.format.trim() : ''
      let html = typeof req?.html === 'string' ? req.html : ''
      if (format) {
        // 插件格式：先把陌生文本翻译成 Netscape HTML，再走**同一条**入库路径。
        try {
          const converted = parseWithPluginFormat(format, req?.content)
          if (converted === null) return { imported: 0, skipped: 0, error: `未知的导入格式：${format}` }
          html = converted
        } catch (e) {
          // 解析器是插件的代码，它崩了不能让导入页看到"0 条"这种误导性结果。
          return { imported: 0, skipped: 0, error: `导入格式「${format}」的解析器执行失败：${errorMessage(e)}` }
        }
      }
      return invoke('bookmark.importHtml', () => bookmarkService.importHtml(html), { ...req, html })
    }
  })
  if (routes.bookmarkImportFormats) {
    typedMain.handle(routes.bookmarkImportFormats, {
      requestSchema: schemas.importFormats.request,
      responseSchema: schemas.importFormats.response,
      handler: async () => ({ formats: listImportFormats() })
    })
  }
  typedMain.handle(routes.bookmarkGetByUrl, { requestSchema: schemas.getByUrl.request, responseSchema: schemas.getByUrl.response, handler: async (_e, req) => invoke('bookmark.getByUrl', () => bookmarkService.getByUrl(req.url), req) })
  typedMain.handle(routes.bookmarkRemoveByUrl, { requestSchema: schemas.removeByUrl.request, responseSchema: schemas.removeByUrl.response, handler: async (_e, req) => { const removed = Number(await invoke('bookmark.removeByUrl', () => bookmarkService.removeByUrl(req.url), req)); return { ok: removed > 0, removed } } })
  typedMain.handle(routes.bookmarkTree, { requestSchema: schemas.tree.request, responseSchema: schemas.tree.response, handler: async () => invoke('bookmark.tree', () => bookmarkService.tree(), null) })
  // 聚合快照：一次 SELECT 取齐 items/pinned/folders/tags（首屏唯一入口）。
  // `tag` 非空时 items 变成**跨文件夹的标签视图**；`query` 与之正交，
  // 一次 IPC 同时返回搜索结果、完整树与标签计数，页面不再并发发 search。
  typedMain.handle(routes.bookmarkSnapshot, {
    requestSchema: schemas.snapshot.request,
    responseSchema: schemas.snapshot.response,
    handler: async (_e, req) => invoke('bookmark.snapshot', () => bookmarkService.snapshot({
      parentId: req?.parentId ?? null,
      tag: req?.tag ?? null,
      query: req?.query ?? null
    }), req)
  })
  typedMain.handle(routes.bookmarkPinnedList, { requestSchema: schemas.pinnedList.request, responseSchema: schemas.pinnedList.response, handler: async () => invoke('bookmark.listPinned', () => bookmarkService.listPinned(), null) })
  typedMain.handle(routes.bookmarkPinnedSet, { requestSchema: schemas.pinnedSet.request, responseSchema: schemas.pinnedSet.response, handler: async (_e, req) => invoke('bookmark.setPinned', () => bookmarkService.setPinned(req.id, req.pinned), req) })
  typedMain.handle(routes.bookmarkPinnedReorder, { requestSchema: schemas.pinnedReorder.request, responseSchema: schemas.pinnedReorder.response, handler: async (_e, req) => ({ ok: await invoke('bookmark.reorderPinned', () => bookmarkService.reorderPinned(req.orderedIds), req) }) })
  // rail 固定位（独立于书签栏 pinned）：capability 名与 domain 方法名一致，
  // 插件的 provider 映射见 plugins/bookmark-service.cjs。
  typedMain.handle(routes.bookmarkRailPinnedList, { requestSchema: schemas.railPinnedList.request, responseSchema: schemas.railPinnedList.response, handler: async () => invoke('bookmark.listRailPinned', () => bookmarkService.listRailPinned(), null) })
  // 标签热度榜（只读）—— 书签编辑器的标签自动补全用。
  typedMain.handle(routes.bookmarkTags, { requestSchema: schemas.tags.request, responseSchema: schemas.tags.response, handler: async () => invoke('bookmark.listTags', () => bookmarkService.listTags(), null) })
  // 标签索引（F-0756~F-0760）：按页面推荐标签 / 已选标签的共现补全。
  typedMain.handle(routes.bookmarkTagSuggestions, {
    requestSchema: schemas.tagSuggestions.request,
    responseSchema: schemas.tagSuggestions.response,
    handler: async (_e, req) => invoke('bookmark.suggestTags', () => bookmarkService.suggestTags(req || {}), req || {})
  })
  typedMain.handle(routes.bookmarkTagAutocomplete, {
    requestSchema: schemas.tagAutocomplete.request,
    responseSchema: schemas.tagAutocomplete.response,
    handler: async (_e, req) => invoke('bookmark.autocompleteTags', () => bookmarkService.autocompleteTags(req.tags, { limit: req.limit }), req)
  })
  typedMain.handle(routes.bookmarkRailPinnedSet, { requestSchema: schemas.railPinnedSet.request, responseSchema: schemas.railPinnedSet.response, handler: async (_e, req) => invoke('bookmark.setRailPinned', () => bookmarkService.setRailPinned(req.id, req.pinned), req) })
  // rail 固定区拖拽重排：**只写 rail 自己的顺序**（与书签栏 pinnedReorder 是两条链）
  typedMain.handle(routes.bookmarkRailPinnedReorder, { requestSchema: schemas.railPinnedReorder.request, responseSchema: schemas.railPinnedReorder.response, handler: async (_e, req) => ({ ok: await invoke('bookmark.reorderRailPinned', () => bookmarkService.reorderRailPinned(req.orderedIds), req) }) })
  // 批量打标签 / 批量固定：多选模式的统一写通道（单事务 + 单次广播）。
  // 批量打标签也能挂系统标签 —— UI 因此不需要为"批量固定"再写一套请求形状。
  typedMain.handle(routes.bookmarkTagBulk, {
    requestSchema: schemas.tagBulk.request,
    responseSchema: schemas.tagBulk.response,
    handler: async (_e, req) => invoke('bookmark.bulkUpdateTags', () => bookmarkService.bulkUpdateTags(req.ids, {
      addTags: req.addTags || [],
      removeTags: req.removeTags || []
    }), req)
  })
  typedMain.handle(routes.bookmarkPinnedBulk, {
    requestSchema: schemas.pinnedBulk.request,
    responseSchema: schemas.pinnedBulk.response,
    handler: async (_e, req) => invoke('bookmark.bulkSetPinned', () => bookmarkService.bulkSetPinned(req.ids, req.pinned), req)
  })
  typedMain.handle(routes.bookmarkRailPinnedBulk, {
    requestSchema: schemas.railPinnedBulk.request,
    responseSchema: schemas.railPinnedBulk.response,
    handler: async (_e, req) => invoke('bookmark.bulkSetRailPinned', () => bookmarkService.bulkSetRailPinned(req.ids, req.pinned), req)
  })
  // 删除一个用户标签（全库摘除该标签；系统标签由 domain 拒绝）
  typedMain.handle(routes.bookmarkTagDelete, {
    requestSchema: schemas.tagDelete.request,
    responseSchema: schemas.tagDelete.response,
    handler: async (_e, req) => invoke('bookmark.deleteTag', () => bookmarkService.deleteTag(req.tag), req)
  })
  // 打开偏好（默认在独立侧栏打开）：书签自己的属性，与固定位无关
  typedMain.handle(routes.bookmarkOpenInSidebarSet, { requestSchema: schemas.openInSidebarSet.request, responseSchema: schemas.openInSidebarSet.response, handler: async (_e, req) => invoke('bookmark.setOpenInSidebar', () => bookmarkService.setOpenInSidebar(req.id, req.value), req) })
}

