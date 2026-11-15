import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createHistoryEventRelay, HISTORY_EVENT_ROUTE } = require('./history-events.ts')

/**
 * 中继的职责在重构后收窄为「domain 事件 → 广播出口」的翻译。
 * 「谁能收到」由 broadcaster（infra-ipc 的登记制广播）决定，不再由本模块决定 ——
 * 因此这里只断言：翻译正确、订阅幂等、无服务/无出口时惰性安全。
 */
describe('history event relay', () => {
  it('把 domain 变更翻译成 history:changed 交给广播出口', () => {
    let listener
    const unsubscribe = vi.fn()
    const historyService = {
      subscribe: vi.fn((value) => {
        listener = value
        return unsubscribe
      })
    }
    const send = vi.fn().mockReturnValue(1)
    const relay = createHistoryEventRelay(historyService, { send })

    relay.start()
    relay.start() // 幂等：重复 start 不应重复订阅
    listener({ action: 'remove-before', count: 3, before: 100 })

    expect(historyService.subscribe).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(HISTORY_EVENT_ROUTE, {
      action: 'remove-before',
      count: 3,
      id: undefined,
      url: undefined,
      urls: undefined,
      before: 100
    })

    relay.stop()
    relay.stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('没有广播出口时静默降级，不抛错', () => {
    let listener
    const historyService = {
      subscribe: vi.fn((value) => {
        listener = value
        return () => {}
      })
    }
    const relay = createHistoryEventRelay(historyService)

    relay.start()
    expect(() => listener({ action: 'add', count: 1 })).not.toThrow()
  })

  it('domain 未暴露 subscribe 时完全惰性', () => {
    const relay = createHistoryEventRelay({}, { send: vi.fn() })

    expect(() => relay.start()).not.toThrow()
    expect(() => relay.stop()).not.toThrow()
  })
})
