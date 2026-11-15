/**
 * Bookmark 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 *
 * 域方法为事实源，provider 只做「能力 → 方法」的薄映射；无副作用、无状态，
 * 服务实例经 ctx.getDomainServices() 懒解析（profile 热切换后仍取到当前实例）。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { BookmarkInputs, BookmarkService } from './service-contracts'

module.exports = createServicePlugin<BookmarkService, BookmarkInputs>({
  domain: 'bookmark',
  serviceName: 'bookmarkService',
  capabilities: {
    'bookmark.list': (svc, input) => svc.list(input?.parentId ?? null),
    'bookmark.add': (svc, input) => svc.add(input),
    'bookmark.remove': (svc, input) => svc.remove(input.id),
    'bookmark.update': (svc, input) => svc.update(input.id, input),
    'bookmark.search': (svc, input) => svc.search(input.query, { tag: input.tag ?? null }),
    'bookmark.move': (svc, input) => svc.move(input.id, input.parentId),
    'bookmark.exportHtml': (svc) => svc.exportHtml(),
    'bookmark.importHtml': (svc, input) => svc.importHtml(input.html),
    'bookmark.getByUrl': (svc, input) => svc.getByUrl(input.url),
    'bookmark.removeByUrl': (svc, input) => svc.removeByUrl(input.url),
    'bookmark.tree': (svc) => svc.tree(),
    'bookmark.listPinned': (svc) => svc.listPinned(),
    'bookmark.setPinned': (svc, input) => svc.setPinned(input.id, input.pinned),
    'bookmark.reorderPinned': (svc, input) => svc.reorderPinned(input.orderedIds),
    // rail 固定位（与书签栏 pinned 相互独立）
    'bookmark.listRailPinned': (svc) => svc.listRailPinned(),
    'bookmark.setRailPinned': (svc, input) => svc.setRailPinned(input.id, input.pinned),
    'bookmark.reorderRailPinned': (svc, input) => svc.reorderRailPinned(input.orderedIds),
    // 打开偏好（默认在独立侧栏打开）
    'bookmark.setOpenInSidebar': (svc, input) => svc.setOpenInSidebar(input.id, input.value),
    // 同级拖拽重排（能力名与 domain 方法名一致，避免"声明一个、调用另一个"的错位）
    'bookmark.reorderChildren': (svc, input) => svc.reorderChildren(input.parentId, input.orderedIds),
    // 标签热度榜（只读聚合）—— 编辑器自动补全
    'bookmark.listTags': (svc) => svc.listTags(),
    // 标签索引：按页面推荐标签 / 已选标签的共现补全（F-0756~F-0760）
    'bookmark.suggestTags': (svc, input) => svc.suggestTags(input || {}),
    'bookmark.autocompleteTags': (svc, input) => svc.autocompleteTags(input?.tags || [], { limit: input?.limit }),
    'bookmark.bulkUpdateTags': (svc, input) => svc.bulkUpdateTags(input.ids, {
      addTags: input.addTags || [],
      removeTags: input.removeTags || []
    }),
    'bookmark.bulkSetPinned': (svc, input) => svc.bulkSetPinned(input.ids, input.pinned),
    'bookmark.bulkSetRailPinned': (svc, input) => svc.bulkSetRailPinned(input.ids, input.pinned),
    'bookmark.deleteTag': (svc, input) => svc.deleteTag(input.tag),
    // 聚合快照 —— 收藏面板一次取齐 items/pinned/folders
    'bookmark.snapshot': (svc, input) => svc.snapshot(input || {})
  }
})
