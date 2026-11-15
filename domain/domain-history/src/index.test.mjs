import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { createHistoryService } from './index.ts'

const require = createRequire(import.meta.url)
const { createDb } = require('@hira-ng/infra-db')

function makeService () {
  const { db, close } = createDb(':memory:')
  const service = createHistoryService(db)
  return { service, close }
}

describe('domain-history · 访问写入', () => {
  it('同一 URL 重复访问累加 visitCount 且不新增行', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      service.addVisit({ url: 'https://a.example.com/', title: 'A2' })

      const all = service.listRecent()
      expect(all.length).toBe(1)
      expect(all[0].visitCount).toBe(2)
      expect(all[0].title).toBe('A2')
    } finally {
      close()
    }
  })

  it('首次访问写入 firstVisitAt 与 lastVisitAt', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/' })
      const [entry] = service.listRecent()
      expect(entry.firstVisitAt).toBeGreaterThan(0)
      expect(entry.lastVisitAt).toBeGreaterThanOrEqual(entry.firstVisitAt)
    } finally {
      close()
    }
  })
})

describe('domain-history · 标题回填', () => {
  it('updateTitle 只改标题，不动 visitCount 与 lastVisitAt', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: '旧' })
      const before = service.listRecent()[0]

      expect(service.updateTitle({ url: 'https://a.example.com/', title: '新' })).toBe(true)

      const after = service.listRecent()[0]
      expect(after.title).toBe('新')
      expect(after.visitCount).toBe(before.visitCount)
      expect(after.lastVisitAt).toBe(before.lastVisitAt)
    } finally {
      close()
    }
  })

  it('updateTitle 对未知 URL / 空标题返回 false 且不抛错', () => {
    const { service, close } = makeService()
    try {
      expect(service.updateTitle({ url: 'https://none.example.com/', title: 'X' })).toBe(false)
      expect(service.updateTitle({ url: 'https://a.example.com/' })).toBe(false)
      expect(service.updateTitle(null)).toBe(false)
    } finally {
      close()
    }
  })
})

describe('domain-history · 查询与清理', () => {
  it('listRecent 按 lastVisitAt 倒序并受 limit 约束', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      service.addVisit({ url: 'https://b.example.com/', title: 'B' })
      service.addVisit({ url: 'https://c.example.com/', title: 'C' })

      expect(service.listRecent(2).length).toBe(2)
      expect(service.listRecent().length).toBe(3)
    } finally {
      close()
    }
  })

  it('search 命中标题子串', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'Hira 浏览器' })
      service.addVisit({ url: 'https://b.example.com/', title: '其他' })

      const hits = service.search('Hira')
      expect(hits.length).toBe(1)
      expect(hits[0].url).toBe('https://a.example.com/')
    } finally {
      close()
    }
  })

  it('search 命中 URL 子串', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://url-match.example.com/path', title: '其他' })
      expect(service.search('url-match.example.com')).toHaveLength(1)
    } finally {
      close()
    }
  })

  it('写操作通过 subscribe 广播动作与数量', () => {
    const { service, close } = makeService()
    try {
      const changes = []
      const unsubscribe = service.subscribe((change) => changes.push(change))
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      const [entry] = service.listRecent()
      service.updateTitle({ url: entry.url, title: 'A2' })
      service.remove(entry.id)
      unsubscribe()
      service.addVisit({ url: 'https://b.example.com/', title: 'B' })
      expect(changes.map((change) => change.action)).toEqual([
        'add', 'update-title', 'remove'
      ])
      expect(changes.every((change) => change.count === 1)).toBe(true)
    } finally {
      close()
    }
  })
  it('queryRange 闭区间过滤并受 limit 约束', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      service.addVisit({ url: 'https://b.example.com/', title: 'B' })
      const entries = service.listRecent()
      const timestamps = entries.map((entry) => entry.lastVisitAt)
      const fromTs = Math.min(...timestamps)
      const toTs = Math.max(...timestamps)

      expect(service.queryRange(fromTs, toTs).length).toBe(2)
      expect(service.queryRange(fromTs, toTs, 1).length).toBe(1)
      expect(service.queryRange(toTs + 1, toTs + 10).length).toBe(0)
    } finally {
      close()
    }
  })

  it('removeBefore 删除含边界时刻的旧记录并返回条数', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      service.addVisit({ url: 'https://b.example.com/', title: 'B' })
      const cutoff = service.listRecent()[0].lastVisitAt

      expect(service.removeBefore(cutoff)).toBe(2)
      expect(service.listRecent().length).toBe(0)
      expect(service.removeBefore(cutoff)).toBe(0)
    } finally {
      close()
    }
  })

  it('remove 按 ID 删除，未知 ID 返回 false', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      const [entry] = service.listRecent()

      expect(service.remove(entry.id)).toBe(true)
      expect(service.remove(entry.id)).toBe(false)
    } finally {
      close()
    }
  })

  it('removeMany 去重后删除已知 ID 并返回实际删除条数', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      service.addVisit({ url: 'https://b.example.com/', title: 'B' })
      service.addVisit({ url: 'https://c.example.com/', title: 'C' })
      const [first, second] = service.listRecent()

      expect(service.removeMany([first.id, first.id, second.id, 'unknown'])).toBe(2)
      expect(service.listRecent()).toHaveLength(1)
      expect(service.removeMany([])).toBe(0)
    } finally {
      close()
    }
  })

  it('clearAll 清空并返回删除条数', () => {
    const { service, close } = makeService()
    try {
      service.addVisit({ url: 'https://a.example.com/', title: 'A' })
      service.addVisit({ url: 'https://b.example.com/', title: 'B' })

      expect(service.clearAll()).toBe(2)
      expect(service.listRecent().length).toBe(0)
    } finally {
      close()
    }
  })
})
