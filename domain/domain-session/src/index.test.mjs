/**
 * domain-session 单测 —— 完全脱离 Electron / 真实磁盘（除最后一组走真 FilePort）。
 *
 * 断言重点不在"能跑通"，而在**下沉时最容易走样的三条行为**：
 *   1. 活动标签必须按「位置」恢复，不能用旧 tabId 去比对（重启后 id 是新的）
 *   2. save 必须**同步**落盘（before-quit 里调用，异步会丢）
 *   3. 磁盘上出现脏数据时只丢脏的那条，绝不整份会话作废
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSessionService, parseSessionFile, SESSION_VERSION, DEFAULT_FILE_NAME, DEFAULT_RESTORE_CAP, toRecord, toRestorePlan } = require('../dist/index.cjs')

/** 内存假端口：记录写入内容，读回同内容 —— 用来验证服务逻辑本身 */
function fakeFilePort(initial = {}) {
  const files = { ...initial }
  return {
    files,
    join: (...p) => p.join('/'),
    existsSync: (f) => f in files,
    readJsonSync: (f) => files[f],
    writeJsonAtomicSync: (f, v) => { files[f] = JSON.parse(JSON.stringify(v)) }
  }
}

/** 假 TabManager：newTab 返回 {tabId:'n1','n2'...}，与磁盘里的旧 id 完全不同 */
function fakeTabPort() {
  const calls = []
  let n = 0
  const created = []
  return {
    calls,
    created,
    list: () => created,
    getActiveTabId: () => (created.find((t) => t.active) || {}).tabId || null,
    newTab: async (payload) => {
      calls.push(['newTab', payload])
      const tabId = `n${++n}`
      created.push({ tabId, ...payload })
      return { tabId }
    },
    switchTo: (tabId) => { calls.push(['switchTo', tabId]) }
  }
}

describe('SessionStore · 纯转换', () => {
  it('丢掉没有 url 的标签，并保留 pinned', () => {
    const r = toRecord([
      { tabId: 'a', url: 'https://a.test', pinned: true },
      { tabId: 'b', url: '' },
      { tabId: 'c' },
      { tabId: 'd', url: 'about:blank' }
    ], 'a', 111)
    expect(r.version).toBe(SESSION_VERSION)
    expect(r.savedAt).toBe(111)
    expect(r.tabs.map((t) => t.url)).toEqual(['https://a.test', 'about:blank'])
    expect(r.tabs[0].pinned).toBe(true)
    expect(r.tabs[1].pinned).toBe(false)
    expect(r.activeTabId).toBe('a')
  })

  it('活动标签不在列表里（已被关掉）→ 记为 null，而不是留一个悬空 id', () => {
    const r = toRecord([{ tabId: 'a', url: 'https://a.test' }], 'ghost', 1)
    expect(r.activeTabId).toBeNull()
  })

  it('toRestorePlan 把 activeTabId 换算成 activeIndex（重启后 id 会变）', () => {
    const plan = toRestorePlan({
      activeTabId: 'old-2',
      tabs: [{ tabId: 'old-1', url: 'u1', pinned: false }, { tabId: 'old-2', url: 'u2', pinned: true }]
    })
    expect(plan.tabs).toEqual([{ url: 'u1', pinned: false }, { url: 'u2', pinned: true }])
    expect(plan.activeIndex).toBe(1)
  })

  it('toRestorePlan 容忍 null / 空', () => {
    expect(toRestorePlan(null)).toEqual({ tabs: [], activeIndex: -1 })
    expect(toRestorePlan({ tabs: [] })).toEqual({ tabs: [], activeIndex: -1 })
  })
})

describe('parseSessionFile · 宽进严出', () => {
  it('非对象 / 数组 / null 一律作废', () => {
    for (const bad of [null, undefined, 42, 'x', [], [1, 2]]) {
      expect(parseSessionFile(bad)).toBeNull()
    }
  })

  it('单条标签脏 → 只丢那一条，其余照常恢复', () => {
    const rec = parseSessionFile({
      version: 1,
      savedAt: 5,
      activeTabId: 'ok',
      tabs: [{ tabId: 'ok', url: 'https://ok.test' }, null, { url: 123 }, { tabId: 'x' }, 'garbage']
    })
    expect(rec).not.toBeNull()
    expect(rec.tabs).toHaveLength(1)
    expect(rec.tabs[0].url).toBe('https://ok.test')
  })

  it('一条有效标签都没有 → 当作没有会话（避免启动后空窗）', () => {
    expect(parseSessionFile({ tabs: [null, { foo: 1 }] })).toBeNull()
    expect(parseSessionFile({ tabs: [] })).toBeNull()
  })

  it('activeTabId 指向不存在的标签 → 清成 null', () => {
    const rec = parseSessionFile({ tabs: [{ tabId: 'a', url: 'u' }], activeTabId: 'zzz' })
    expect(rec.activeTabId).toBeNull()
  })
})

describe('SessionService · 保存 / 恢复', () => {
  it('缺少 filePort 直接报错（防止有人绕过端口直接用 fs）', () => {
    expect(() => createSessionService({})).toThrow(/filePort is required/)
  })

  it('save 必须同步落盘 —— 返回时磁盘上已经是最新内容（before-quit 前提）', () => {
    const fp = fakeFilePort()
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    const tp = {
      list: () => [{ tabId: 't1', url: 'https://a.test', pinned: true }],
      getActiveTabId: () => 't1'
    }
    expect(svc.save('/u/p1', tp)).toBe(true)
    // 没有 await，也不该需要 await
    expect(fp.files['/u/p1/session.json'].tabs[0].url).toBe('https://a.test')
  })

  it('恢复时按位置切回原活动标签（旧 tabId 早已失效）', async () => {
    const fp = fakeFilePort({
      '/u/p1/session.json': {
        version: 1, savedAt: 1, activeTabId: 'old-2',
        tabs: [{ tabId: 'old-1', url: 'https://one.test', pinned: false },
          { tabId: 'old-2', url: 'https://two.test', pinned: true }]
      }
    })
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    const tp = fakeTabPort()

    const res = await svc.restore('/u/p1', tp)

    expect(res).toEqual({ restored: true, activeTabId: 'n1', trimmed: false })
    // capSessionTabs 会把固定标签排到最前，故顺序为 [two(pinned), one(plain)]
    expect(tp.calls.filter((c) => c[0] === 'newTab').map((c) => [c[1].url, c[1].openInBackground, c[1].pinned]))
      .toEqual([['https://two.test', true, true], ['https://one.test', true, false]])
    // 只切一次，且切到固定标签（已在最前，也是 plan.activeIndex=0）
    expect(tp.calls.filter((c) => c[0] === 'switchTo')).toEqual([['switchTo', 'n1']])
  })



  it('保存并恢复 stack metadata，且使用重建后的 tabId 归属成员', async () => {
    const fp = fakeFilePort()
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    const source = {
      list: () => [
        { tabId: 'old-a', url: 'https://a.test', stackId: 's1' },
        { tabId: 'old-b', url: 'https://b.test', pinned: true, stackId: 's1' }
      ],
      listStacks: () => [{ stackId: 's1', label: '工作', accent: '#336699', collapsed: true }],
      getActiveTabId: () => 'old-b'
    }
    expect(svc.save('/u/p', source)).toBe(true)
    expect(fp.files['/u/p/session.json']).toMatchObject({ version: SESSION_VERSION, stacks: [{ stackId: 's1', label: '工作', accent: '#336699', collapsed: true }] })

    const tp = fakeTabPort()
    tp.createStack = vi.fn()
    const result = await svc.restore('/u/p', tp)
    expect(result).toMatchObject({ restored: true, activeTabId: 'n1' })
    expect(tp.calls.filter((call) => call[0] === 'newTab').map((call) => call[1].url))
      .toEqual(['https://b.test', 'https://a.test'])
    expect(tp.createStack).toHaveBeenCalledWith({ tabIds: ['n1', 'n2'], label: '工作', accent: '#336699', collapsed: true })
    expect(tp.calls.filter((call) => call[0] === 'switchTo')).toEqual([['switchTo', 'n1']])
  })

  it('没有记录活动标签 → 退回第一个标签', async () => {
    const fp = fakeFilePort({
      '/u/p/session.json': { version: 1, savedAt: 1, activeTabId: null, tabs: [{ tabId: 'a', url: 'u1' }, { tabId: 'b', url: 'u2' }] }
    })
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    const tp = fakeTabPort()
    await svc.restore('/u/p', tp)
    expect(tp.calls.filter((c) => c[0] === 'switchTo')).toEqual([['switchTo', 'n1']])
  })

  it('没有会话文件 → 不创建任何标签（由调用方决定开 about:blank）', async () => {
    const svc = createSessionService({ filePort: fakeFilePort(), logger: { warn() {} } })
    const tp = fakeTabPort()
    expect(await svc.restore('/u/p', tp)).toEqual({ restored: false })
    expect(tp.calls).toHaveLength(0)
  })

  it('磁盘上是坏 JSON → 不抛异常，只是恢复失败', async () => {
    const fp = fakeFilePort()
    fp.readJsonSync = () => { throw new SyntaxError('Unexpected token') }
    const svc = createSessionService({ filePort: fp, logger: { warn: vi.fn() } })
    const tp = fakeTabPort()
    expect(await svc.restore('/u/p', tp)).toEqual({ restored: false })
    expect(tp.calls).toHaveLength(0)
    expect(svc.read('/u/p')).toBeNull()
  })

  it('save 失败（磁盘满/权限）不抛出，只是返回 false', () => {
    const fp = fakeFilePort()
    fp.writeJsonAtomicSync = () => { throw new Error('ENOSPC') }
    const svc = createSessionService({ filePort: fp, logger: { warn: vi.fn() } })
    const tp = { list: () => [{ tabId: 't', url: 'u' }], getActiveTabId: () => 't' }
    expect(svc.save('/u/p', tp)).toBe(false)
  })

  it('clear 写一份空会话', () => {
    const fp = fakeFilePort()
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    svc.clear('/u/p')
    expect(fp.files['/u/p/session.json'].tabs).toEqual([])
  })
})

describe('SessionService · 路径与存在性', () => {
  it('sessionPath 默认拼 session.json；fileName 可覆盖（多 profile 并存的前提）', () => {
    const fp = fakeFilePort()
    expect(createSessionService({ filePort: fp }).sessionPath('/u/p1')).toBe(`/u/p1/${DEFAULT_FILE_NAME}`)
    expect(DEFAULT_FILE_NAME).toBe('session.json')
    expect(createSessionService({ filePort: fp, fileName: 'last.json' }).sessionPath('/u/p1')).toBe('/u/p1/last.json')
  })

  it('exists 只看这份 profile 自己的文件，不被别的 profile 干扰', () => {
    const svc = createSessionService({ filePort: fakeFilePort({ '/u/p1/session.json': { tabs: [] } }) })
    expect(svc.exists('/u/p1')).toBe(true)
    expect(svc.exists('/u/p2')).toBe(false)
  })

  it('existsSync 抛错（目录被删/无权限）→ exists 当作 false，不冒泡', () => {
    const fp = fakeFilePort()
    fp.existsSync = () => { throw new Error('EACCES') }
    expect(createSessionService({ filePort: fp }).exists('/u/p')).toBe(false)
  })

  it('read 命中磁盘时返回归一化记录（版本与标签契约字段都补齐）', () => {
    const svc = createSessionService({
      filePort: fakeFilePort({ '/u/p/session.json': { tabs: [{ tabId: 'a', url: 'https://a.test' }] } })
    })
    const rec = svc.read('/u/p')
    expect(rec.version).toBe(SESSION_VERSION)
    expect(rec.tabs).toEqual([{ tabId: 'a', url: 'https://a.test', pinned: false }])
  })
})

describe('sessionUtil · 接线（restore 限额 / 去重 / stats）', () => {
  it('restore 超出 $200 上限时裁剪，且返回 trimmed:true', async () => {
    const tabCount = 250
    const tabs = Array.from({ length: tabCount }, (_, i) => ({ tabId: `old-${i}`, url: `https://t${i}.test/`, pinned: false }))
    const fp = fakeFilePort({
      '/u/p/session.json': { version: 1, savedAt: 1, activeTabId: null, tabs }
    })
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    const tp = fakeTabPort()

    const res = await svc.restore('/u/p', tp)

    const newTabs = tp.calls.filter((c) => c[0] === 'newTab')
    expect(newTabs.length).toBeLessThanOrEqual(DEFAULT_RESTORE_CAP)
    expect(newTabs.length).toBe(DEFAULT_RESTORE_CAP)
    expect(res.trimmed).toBe(true)
  })

  it('restore 对完全重复 url 去重后只 newTab 一次', async () => {
    const fp = fakeFilePort({
      '/u/p/session.json': {
        version: 1, savedAt: 1, activeTabId: null,
        tabs: [
          { tabId: 'old-1', url: 'https://dup.test/', pinned: false },
          { tabId: 'old-2', url: 'https://dup.test/', pinned: false }
        ]
      }
    })
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    const tp = fakeTabPort()

    const res = await svc.restore('/u/p', tp)

    const newTabs = tp.calls.filter((c) => c[0] === 'newTab')
    expect(newTabs).toHaveLength(1)
    expect(newTabs[0][1].url).toBe('https://dup.test/')
    expect(res.trimmed).toBe(false)
  })

  it('stats(dir) 返回 {tabs,pinned,activeIndex}', () => {
    const fp = fakeFilePort({
      '/u/p/session.json': {
        version: 1, savedAt: 1, activeTabId: 'old-2',
        tabs: [
          { tabId: 'old-1', url: 'https://one.test/', pinned: true },
          { tabId: 'old-2', url: 'https://two.test/', pinned: false }
        ]
      }
    })
    const svc = createSessionService({ filePort: fp, logger: { warn() {} } })
    expect(svc.stats('/u/p')).toEqual({ tabs: 2, pinned: 1, activeIndex: 1 })
  })

  it('stats(dir) 无会话文件时返回全 0 统计', () => {
    const svc = createSessionService({ filePort: fakeFilePort(), logger: { warn() {} } })
    expect(svc.stats('/u/p')).toEqual({ tabs: 0, pinned: 0, activeIndex: -1 })
  })
})

describe('与真实 infra-fs FilePort 对接（契约一致性）', () => {
  it('createFilePort() 提供的能力足够支撑本服务，且真的落到磁盘', async () => {
    const { createFilePort } = require('@hira-ng/infra-fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hira-ng-session-'))
    const svc = createSessionService({ filePort: createFilePort(), logger: { warn() {} } })

    expect(svc.save(dir, {
      list: () => [{ tabId: 't1', url: 'https://real.test', pinned: true }],
      getActiveTabId: () => 't1'
    })).toBe(true)

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'))
    expect(onDisk.tabs[0].url).toBe('https://real.test')

    const tp = fakeTabPort()
    const res = await svc.restore(dir, tp)
    expect(res.restored).toBe(true)
    expect(tp.calls[0][1].url).toBe('https://real.test')

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
