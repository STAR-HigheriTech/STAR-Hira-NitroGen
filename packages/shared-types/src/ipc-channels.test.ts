import { describe, it, expect } from 'vitest'
import { IPC_ROUTES, IPC_EVENTS } from './ipc-channels.js'

/**
 * 通道契约测试 —— 这张表是主/渲染两侧的协议，坏一条比坏一段代码更糟。
 * 只测「结构不变量」，不测具体条目数（条目随功能增长，硬编码数字只会制造噪音）。
 */

const entries = (table) => Object.entries(table)

describe('IPC 通道契约', () => {
  it('两张表都非空', () => {
    expect(entries(IPC_ROUTES).length).toBeGreaterThan(100)
    expect(entries(IPC_EVENTS).length).toBeGreaterThan(10)
  })

  it('每条通道都符合 namespace:action 格式（段内允许连字符，允许多段）', () => {
    const RE = /^[a-z][a-z0-9-]*(?::[a-zA-Z0-9-]+)+$/
    for (const [key, val] of [...entries(IPC_ROUTES), ...entries(IPC_EVENTS)]) {
      expect(val, `通道 ${key}`).toMatch(RE)
    }
  })

  it('IPC_ROUTES 内无重复通道值', () => {
    const vals = entries(IPC_ROUTES).map(([, v]) => v)
    expect(new Set(vals).size).toBe(vals.length)
  })

  it('IPC_EVENTS 内无重复通道值', () => {
    const vals = entries(IPC_EVENTS).map(([, v]) => v)
    expect(new Set(vals).size).toBe(vals.length)
  })

  it('请求通道与事件通道不相交 —— 转发器 / 单向通道家族除外', () => {
    // overlay:* 是「转发器」通道：renderer A invoke → main 转手 send 给 renderer B。
    // buttons-edit:* 的 zone 等通道同时登记为 send + event：同名是有意的一来一往协议。
    // 除此之外的任何重叠都是事故，直接失败。
    const FORWARDED_NS = ['overlay:', 'searchbar-overlay:', 'tabpreview-overlay:', 'siteinfo-overlay:', 'buttons-edit:']
    const routes = new Set(entries(IPC_ROUTES).map(([, v]) => v))
    const badOverlap = entries(IPC_EVENTS).filter(
      ([, v]) => routes.has(v) && !FORWARDED_NS.some((prefix) => v.startsWith(prefix))
    )
    expect(badOverlap).toEqual([])
  })

  it('键名是合法标识符（驼峰、无空格）', () => {
    const RE = /^[a-z][a-zA-Z0-9]*$/
    for (const [key] of [...entries(IPC_ROUTES), ...entries(IPC_EVENTS)]) {
      expect(key).toMatch(RE)
    }
  })

  it('关键通道存在（删改这些会静默断掉对应功能）', () => {
    // 生命线通道：每个对应一个核心用户功能
    const lifelines = {
      tabList: '标签列表',
      tabStats: '标签统计（固定/播放数）',
      tabVisibleAfter: '活动标签之后的可见范围',
      tabClose: '关标签',
      navGo: '地址栏导航',
      historyList: '历史页',
      bookmarkList: '书签页',
      downloadList: '下载页',
      settingsGet: '设置页'
    }
    for (const [key, feature] of Object.entries(lifelines)) {
      expect(IPC_ROUTES[key], `功能「${feature}」`).toBeTruthy()
    }
    expect(IPC_EVENTS.tabChanged).toBeTruthy()
    expect(IPC_EVENTS.settingsChanged).toBeTruthy()
  })
})
