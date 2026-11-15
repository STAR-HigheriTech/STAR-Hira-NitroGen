/**
 * domain-bookmark 单测 —— 真实 SQLite（:memory:）+ Drizzle，零 Electron。
 *
 * 断言重点在星标同步机制的三条关键行为：
 *   1. getByUrl 任意层级命中、文件夹永不命中（星标状态查询的正确性根基）
 *   2. removeByUrl 同一 URL 多处收藏时全部移除（收藏=布尔状态的用户心智）
 *   3. 所有写路径都发 changed 事件、且监听器异常不拖垮写路径
 *     （domain 是唯一变更事实源，APPS 中继靠它驱动全 UI 刷新）
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createBookmarkService } = require('../dist/index.cjs')
const { createDb } = require('@hira-ng/infra-db')

function makeService() {
  const { db, close } = createDb(':memory:')
  const service = createBookmarkService(db)
  return { service, close }
}

describe('domain-bookmark · 星标状态查询', () => {
  it('getByUrl 命中任意层级的书签（含文件夹内）', () => {
    const { service, close } = makeService()
    try {
      const folder = service.add({ title: '开发', url: null })
      service.add({ title: '根下', url: 'https://a.example.com/' })
      service.add({ title: '夹内', url: 'https://b.example.com/', parentId: folder.id })

      expect(service.getByUrl('https://a.example.com/').title).toBe('根下')
      expect(service.getByUrl('https://b.example.com/').parentId).toBe(folder.id)
    } finally {
      close()
    }
  })

  it('getByUrl 对文件夹与未知 URL 返回 null', () => {
    const { service, close } = makeService()
    try {
      service.add({ title: '文件夹', url: null })
      expect(service.getByUrl(null)).toBeNull()
      expect(service.getByUrl('')).toBeNull()
      expect(service.getByUrl('https://not-there.example.com/')).toBeNull()
    } finally {
      close()
    }
  })

  it('同一 URL 多处收藏时返回最近修改的一条', () => {
    const { service, close } = makeService()
    try {
      const first = service.add({ title: '旧', url: 'https://dup.example.com/' })
      const second = service.add({ title: '新', url: 'https://dup.example.com/' })
      expect(second.id).not.toBe(first.id)
      expect(service.getByUrl('https://dup.example.com/').id).toBe(second.id)
    } finally {
      close()
    }
  })
})

describe('domain-bookmark · removeByUrl', () => {
  it('同一 URL 多处收藏全部移除，并返回移除条数', () => {
    const { service, close } = makeService()
    try {
      const folder = service.add({ title: '夹', url: null })
      service.add({ title: 'A', url: 'https://kill.example.com/' })
      service.add({ title: 'B', url: 'https://kill.example.com/', parentId: folder.id })
      service.add({ title: '保留', url: 'https://keep.example.com/' })

      const removed = service.removeByUrl('https://kill.example.com/')
      expect(removed).toBe(2)
      expect(service.getByUrl('https://kill.example.com/')).toBeNull()
      expect(service.getByUrl('https://keep.example.com/')).not.toBeNull()
    } finally {
      close()
    }
  })

  it('未知 URL / 空 URL 返回 0，不抛错', () => {
    const { service, close } = makeService()
    try {
      expect(service.removeByUrl('https://nope.example.com/')).toBe(0)
      expect(service.removeByUrl(null)).toBe(0)
    } finally {
      close()
    }
  })
})

describe('domain-bookmark · 变更事件（唯一事实源）', () => {
  it('add/update/remove/move/reorder/importHtml 均发对应事件', () => {
    const { service, close } = makeService()
    try {
      const events = []
      service.subscribe((c) => events.push(c))

      const bm = service.add({ title: 'x', url: 'https://ev.example.com/' })
      service.update(bm.id, { title: 'y' })
      service.move(bm.id, null)
      service.reorderChildren(null, [bm.id])
      const imported = service.importHtml('<DL><p><DT><A HREF="https://imp.example.com/">i</A></DL><p>')
      expect(imported.imported).toBeGreaterThan(0)

      const reasons = events.map((e) => e.reason)
      expect(reasons).toContain('add')
      expect(reasons).toContain('update')
      expect(reasons).toContain('move')
      expect(reasons).toContain('reorder')
      expect(reasons).toContain('import')

      const addEv = events.find((e) => e.reason === 'add')
      expect(addEv.id).toBe(bm.id)
      expect(addEv.url).toBe('https://ev.example.com/')
    } finally {
      close()
    }
  })

  it('导入单引号链接并还原 HTML 实体', () => {
    const { service, close } = makeService()
    try {
      const result = service.importHtml("<DL><p><DT><H3>研发 &amp; 产品</H3><DL><p><DT><A HREF='https://example.com/?a=1&amp;b=2'>A &amp; B</A></DL><p></DL><p>")
      expect(result).toEqual({ imported: 2, skipped: 0 })
      const folder = service.list(null)[0]
      expect(folder.title).toBe('研发 & 产品')
      const bookmark = service.list(folder.id)[0]
      expect(bookmark.title).toBe('A & B')
      expect(bookmark.url).toBe('https://example.com/?a=1&b=2')
      expect(service.exportHtml()).toContain('https://example.com/?a=1&amp;b=2')
    } finally {
      close()
    }
  })
  it('removeByUrl 聚合为一条 remove 事件（url 为键）', () => {
    const { service, close } = makeService()
    try {
      const events = []
      service.subscribe((c) => events.push(c))
      service.add({ title: 'A', url: 'https://ev2.example.com/' })
      service.add({ title: 'B', url: 'https://ev2.example.com/' })

      service.removeByUrl('https://ev2.example.com/')
      const removeEvents = events.filter((e) => e.reason === 'remove' && e.url === 'https://ev2.example.com/')
      // add 也发事件，但 remove 按 URL 聚合只发一条
      expect(removeEvents.length).toBe(1)
    } finally {
      close()
    }
  })

  it('监听器抛异常不影响写路径、不影响其他监听器', () => {
    const { service, close } = makeService()
    try {
      const good = []
      service.subscribe(() => { throw new Error('坏监听器') })
      service.subscribe((c) => good.push(c.reason))

      const bm = service.add({ title: 'x', url: 'https://ev3.example.com/' })
      expect(service.getByUrl('https://ev3.example.com/')).not.toBeNull()
      expect(good).toContain('add')
      expect(bm.id).toBeTruthy()
    } finally {
      close()
    }
  })

  it('subscribe 返回退订函数', () => {
    const { service, close } = makeService()
    try {
      const events = []
      const off = service.subscribe((c) => events.push(c.reason))
      off()
      service.add({ title: 'x', url: 'https://ev4.example.com/' })
      expect(events.length).toBe(0)
    } finally {
      close()
    }
  })
})

describe('domain-bookmark · 书签栏 pinned + tags + tree', () => {
  it('setPinned 固定时自动追加到末尾，取消固定清零', () => {
    const { service, close } = makeService()
    try {
      const a = service.add({ title: 'A', url: 'https://pin-a' })
      const b = service.add({ title: 'B', url: 'https://pin-b' })
      service.setPinned(a.id, true)
      service.setPinned(b.id, true)
      let pinned = service.listPinned()
      expect(pinned.map((x) => x.id)).toEqual([a.id, b.id])
      expect(pinned[0].pinned).toBe(true) // 归一化：布尔

      service.setPinned(a.id, false)
      pinned = service.listPinned()
      expect(pinned.length).toBe(1)
      expect(service.get(a.id).pinned).toBe(false)
    } finally {
      close()
    }
  })

  it('reorderPinned 整体重排', () => {
    const { service, close } = makeService()
    try {
      const a = service.add({ title: 'A', url: 'https://r-a' })
      const b = service.add({ title: 'B', url: 'https://r-b' })
      const c = service.add({ title: 'C', url: 'https://r-c' })
      ;[a, b, c].forEach((x) => service.setPinned(x.id, true))
      service.reorderPinned([c.id, a.id, b.id])
      expect(service.listPinned().map((x) => x.id)).toEqual([c.id, a.id, b.id])
    } finally {
      close()
    }
  })

  it('tags 存储归一化：出口是数组、存储是 JSON 字符串', () => {
    const { service, close } = makeService()
    try {
      const bm = service.add({ title: 'T', url: 'https://tags', tags: ['dev', ' tools', ''] })
      expect(bm.tags).toEqual(['dev', 'tools']) // 空串被过滤
      service.update(bm.id, { tags: [] })
      expect(service.get(bm.id).tags).toEqual([])
      service.update(bm.id, { tags: undefined }) // undefined = 不改
      expect(service.get(bm.id).tags).toEqual([])
    } finally {
      close()
    }
  })

  it('tree 返回嵌套结构且子节点带归一化字段', () => {
    const { service, close } = makeService()
    try {
      const folder = service.add({ title: '夹', url: null })
      service.add({ title: '子', url: 'https://in-folder', parentId: folder.id, tags: ['x'] })
      const roots = service.tree()
      const node = roots.find((r) => r.id === folder.id)
      expect(node.children.length).toBe(1)
      expect(node.children[0].tags).toEqual(['x'])
      expect(node.children[0].pinned).toBe(false)
    } finally {
      close()
    }
  })

  it('clearAll 清空并聚合为一条 clear 事件', () => {
    const { service, close } = makeService()
    try {
      service.add({ title: 'A', url: 'https://c-a' })
      service.add({ title: 'B', url: 'https://c-b' })
      const events = []
      service.subscribe((c) => events.push(c.reason))
      expect(service.clearAll()).toBe(2)
      expect(service.listAll().length).toBe(0)
      expect(events.filter((r) => r === 'clear').length).toBe(1)
    } finally {
      close()
    }
  })
})
