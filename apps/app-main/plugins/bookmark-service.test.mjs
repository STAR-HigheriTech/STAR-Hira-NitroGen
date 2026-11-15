import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../../../build/plugins/bookmark-service.cjs')

describe('bookmark-service plugin providers', () => {
  it('exposes one provider per bookmark capability and dispatches to the current service', () => {
    const first = {
      add: vi.fn(() => 'b1'),
      remove: vi.fn(() => true),
      update: vi.fn(() => 'u1'),
      search: vi.fn(() => []),
      move: vi.fn(() => true),
      reorder: vi.fn(() => true),
      importHtml: vi.fn(() => ({ imported: 1, skipped: 0 })),
      exportHtml: vi.fn(() => '<html/>')
    }
    let current = first
    const ctx = { getDomainServices: () => ({ bookmarkService: current }) }
    const providers = plugin.registerProviders(ctx)
    const byId = Object.fromEntries(providers.map((p) => [p.capability, p]))

    // 快照按**能力表**逐个列出：新增一个能力就必须同步这一行 ——
    // 它同时也是"能力 ↔ manifest.capabilities 一一对应"的守护（见 plugin:coverage）。
    expect(Object.keys(byId).sort()).toEqual([
      'bookmark.add', 'bookmark.autocompleteTags', 'bookmark.bulkSetPinned', 'bookmark.bulkSetRailPinned',
      'bookmark.bulkUpdateTags', 'bookmark.deleteTag', 'bookmark.exportHtml', 'bookmark.getByUrl',
      'bookmark.importHtml', 'bookmark.list', 'bookmark.listPinned', 'bookmark.listRailPinned',
      'bookmark.listTags', 'bookmark.move', 'bookmark.remove', 'bookmark.removeByUrl',
      'bookmark.reorderChildren', 'bookmark.reorderPinned', 'bookmark.reorderRailPinned',
      'bookmark.search', 'bookmark.setOpenInSidebar', 'bookmark.setPinned', 'bookmark.setRailPinned',
      'bookmark.snapshot', 'bookmark.suggestTags', 'bookmark.tree', 'bookmark.update'
    ])

    expect(byId['bookmark.add'].around({ title: 't', url: 'u' })).toBe('b1')
    expect(first.add).toHaveBeenCalledWith({ title: 't', url: 'u' })
    expect(byId['bookmark.remove'].around({ id: 'x' })).toBe(true)
    expect(first.remove).toHaveBeenCalledWith('x')
    expect(byId['bookmark.move'].around({ id: 'a', parentId: 'b' })).toBe(true)
    expect(first.move).toHaveBeenCalledWith('a', 'b')
    expect(byId['bookmark.exportHtml'].around(null)).toBe('<html/>')

    current = { ...first, search: vi.fn(() => ['fresh']) }
    expect(byId['bookmark.search'].around({ query: 'q', tag: 'system:pinned' })).toEqual(['fresh'])
    expect(current.search).toHaveBeenCalledWith('q', { tag: 'system:pinned' })

    current = { ...first, snapshot: vi.fn(() => ({ items: [] })) }
    expect(byId['bookmark.snapshot'].around({ parentId: 'f1', tag: 'read', query: 'q' })).toEqual({ items: [] })
    expect(current.snapshot).toHaveBeenCalledWith({ parentId: 'f1', tag: 'read', query: 'q' })
  })

  it('registers a bookmark.service extension point', () => {
    const service = { add: vi.fn() }
    const ctx = { getDomainServices: () => ({ bookmarkService: service }) }
    expect(plugin.registerExtensionPoints(ctx)).toEqual([{ name: 'bookmark.service', service }])
  })
})
