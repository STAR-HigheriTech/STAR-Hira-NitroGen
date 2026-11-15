/**
 * Note 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 *
 * 与 bookmark-service.cjs 同构：域方法为事实源，provider 只做「能力 → 方法」的薄映射。
 * 引擎被禁用时，这些能力会被 `blockedCapabilities` 拦下，依赖它的面板插件（如
 * panel-notes）因 dependsOn 落 blocked → 从目录消失（§10.4 的既有机制）。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { NoteService } from '@hira-ng/domain-notes'
import type { NotesInputs } from './service-contracts'

module.exports = createServicePlugin<NoteService, NotesInputs>({
  domain: 'notes',
  serviceName: 'notesService',
  capabilities: {
    // 笔记
    'notes.list': (svc, input) => svc.list(input || {}),
    'notes.get': (svc, input) => svc.get(input.id),
    'notes.add': (svc, input) => svc.add(input),
    'notes.update': (svc, input) => svc.update(input.id, input),
    'notes.remove': (svc, input) => svc.remove(input.id),
    'notes.search': (svc, input) => svc.search(input.query),
    'notes.move': (svc, input) => svc.move(input.id, input.folderId),
    'notes.setPinned': (svc, input) => svc.setPinned(input.id, input.pinned),
    'notes.reorder': (svc, input) => svc.reorder(input.folderId, input.orderedIds),
    // 文件夹
    'notes.listFolders': (svc) => svc.listFolders(),
    'notes.addFolder': (svc, input) => svc.addFolder(input),
    'notes.renameFolder': (svc, input) => svc.renameFolder(input.id, input.name),
    'notes.removeFolder': (svc, input) => svc.removeFolder(input.id),
    'notes.moveFolder': (svc, input) => svc.moveFolder(input.id, input.parentId),
    'notes.reorderFolders': (svc, input) => svc.reorderFolders(input.parentId, input.orderedIds),
    'notes.folderCounts': (svc) => svc.folderCounts(),
    // 集锦（经典 Edge Collections 完全体）
    'notes.addCaptured': (svc, input) => svc.addCaptured(input),
    // 回收站
    'notes.restore': (svc, input) => svc.restore(input.id),
    'notes.purge': (svc, input) => svc.purge(input.id),
    'notes.listTrash': (svc) => svc.listTrash(),
    'notes.emptyTrash': (svc) => svc.emptyTrash(),
    // 引用 / 反链
    'notes.backlinks': (svc, input) => svc.backlinks(input.id),
    'notes.refCounts': (svc) => svc.refCounts()
  }
})
