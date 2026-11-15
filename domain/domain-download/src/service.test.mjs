/**
 * domain-download 记录服务单测 —— 真实 SQLite（:memory:）+ Drizzle，零 Electron。
 *
 * MCD / Security / SpeedTracker / RateLimiter 的纯逻辑已由 index.test.mjs 覆盖，
 * 本文件只盯「下载记录状态机」这一条线：pending → in_progress → paused →
 * in_progress → completed / cancelled，以及 listActive 的可见性边界与危险级别标记。
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { createDownloadService } from './index.ts'

const require = createRequire(import.meta.url)
const { createDb } = require('@hira-ng/infra-db')

function makeService() {
  const { db, close } = createDb(':memory:')
  const service = createDownloadService(db)
  return { service, close }
}

const sample = { url: 'https://a.example.com/f.zip', filename: 'f.zip', totalBytes: 1000 }

describe('domain-download · 记录创建与查询', () => {
  it('create 返回 ID，初始状态为 pending 且已接收字节为 0', () => {
    const { service, close } = makeService()
    try {
      const id = service.create(sample)
      const record = service.get(id)

      expect(typeof id).toBe('string')
      expect(record.state).toBe('pending')
      expect(record.receivedBytes).toBe(0)
      expect(record.danger).toBe('safe')
      expect(record.completedAt).toBe(null)
    } finally {
      close()
    }
  })

  it('get 对未知 ID 返回 null 而不是 undefined', () => {
    const { service, close } = makeService()
    try {
      expect(service.get('dl_not_exist')).toBe(null)
    } finally {
      close()
    }
  })

  it('list 按开始时间倒序并受 limit 约束', () => {
    const { service, close } = makeService()
    try {
      service.create(sample)
      service.create({ ...sample, filename: 'g.zip' })

      expect(service.list().length).toBe(2)
      expect(service.list(1).length).toBe(1)
    } finally {
      close()
    }
  })
})

describe('domain-download · 状态机', () => {
  it('updateProgress 写入已接收字节并切到 in_progress', () => {
    const { service, close } = makeService()
    try {
      const id = service.create(sample)
      service.updateProgress(id, 300)

      const record = service.get(id)
      expect(record.state).toBe('in_progress')
      expect(record.receivedBytes).toBe(300)
    } finally {
      close()
    }
  })

  it('updateProgress 可补写此前未知的总字节数', () => {
    const { service, close } = makeService()
    try {
      const id = service.create({ url: sample.url, filename: sample.filename })
      expect(service.get(id).totalBytes).toBe(null)

      service.updateProgress(id, 100, 2000)
      expect(service.get(id).totalBytes).toBe(2000)
    } finally {
      close()
    }
  })

  it('pause / resume 往返切换状态', () => {
    const { service, close } = makeService()
    try {
      const id = service.create(sample)
      service.updateProgress(id, 100)

      service.pause(id)
      expect(service.get(id).state).toBe('paused')

      service.resume(id)
      expect(service.get(id).state).toBe('in_progress')
    } finally {
      close()
    }
  })

  it('complete 写入落盘路径与完成时间', () => {
    const { service, close } = makeService()
    try {
      const id = service.create(sample)
      service.complete(id, 'C:/Downloads/f.zip')

      const record = service.get(id)
      expect(record.state).toBe('completed')
      expect(record.filePath).toBe('C:/Downloads/f.zip')
      expect(record.completedAt).toBeGreaterThan(0)
    } finally {
      close()
    }
  })

  it('cancel 默认写 cancelled，可指定 interrupted', () => {
    const { service, close } = makeService()
    try {
      const a = service.create(sample)
      const b = service.create(sample)

      service.cancel(a)
      service.cancel(b, 'interrupted')

      expect(service.get(a).state).toBe('cancelled')
      expect(service.get(b).state).toBe('interrupted')
    } finally {
      close()
    }
  })
})

describe('domain-download · 活动队列与危险级别', () => {
  it('listActive 只含 pending / in_progress', () => {
    const { service, close } = makeService()
    try {
      const pending = service.create(sample)
      const running = service.create(sample)
      const paused = service.create(sample)
      const done = service.create(sample)

      service.updateProgress(running, 10)
      service.pause(paused)
      service.complete(done, 'C:/Downloads/f.zip')

      const activeIds = service.listActive().map((item) => item.id).sort()
      expect(activeIds).toEqual([pending, running].sort())
    } finally {
      close()
    }
  })

  it('setDanger 标记危险级别且不影响状态', () => {
    const { service, close } = makeService()
    try {
      const id = service.create({ ...sample, filename: 'setup.exe' })
      service.setDanger(id, 'dangerous')

      const record = service.get(id)
      expect(record.danger).toBe('dangerous')
      expect(record.state).toBe('pending')
    } finally {
      close()
    }
  })
})

describe('domain-download · 记录清理', () => {
  it('clearCompleted 只删已完成并返回条数', () => {
    const { service, close } = makeService()
    try {
      const done = service.create(sample)
      const running = service.create(sample)
      service.complete(done, 'C:/Downloads/f.zip')
      service.updateProgress(running, 10)

      expect(service.clearCompleted()).toBe(1)
      expect(service.list().map((item) => item.id)).toEqual([running])
      expect(service.clearCompleted()).toBe(0)
    } finally {
      close()
    }
  })

  it('remove 按 ID 删除，未知 ID 返回 false', () => {
    const { service, close } = makeService()
    try {
      const id = service.create(sample)

      expect(service.remove(id)).toBe(true)
      expect(service.remove(id)).toBe(false)
    } finally {
      close()
    }
  })

  it('removeMany 批量删除并返回实际删除条数', () => {
    const { service, close } = makeService()
    try {
      const first = service.create(sample)
      const second = service.create({ ...sample, filename: 'g.zip' })

      expect(service.removeMany([first, second, 'dl_missing'])).toBe(2)
      expect(service.list()).toEqual([])
      expect(service.removeMany([])).toBe(0)
    } finally {
      close()
    }
  })
})
