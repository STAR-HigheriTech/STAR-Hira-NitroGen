/**
 * 「出厂默认关闭」播种的单测 —— 真实 plugin-state-store + 桩注册中心。
 *
 * 这条机制只有 6 行逻辑，但错法都很隐蔽（写盘时机、标记漏记、整表覆盖写丢数据），
 * 而且错了之后的表现是"用户把它打开了，重启又关回去"—— 用户查不出来，只会觉得
 * 这软件在跟他作对。所以逐条钉死。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { seedDefaultDisabled } = require('./plugin-bootstrap.js')
const { createPluginStateStore } = require('./plugin-state-store.js')

/** 内存版 settingsService（契约与 domain-settings 的 get/set 一致）。 */
function fakeSettings() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value) },
    _map: map
  }
}

/**
 * 桩注册中心 —— 只实现 seedDefaultDisabled 用到的四个方法，语义照抄 PluginRegistryV2：
 * `setUserDisabled` 对不可禁用者返回 false 且不写入。
 */
function stubRegistry(manifests, nonDisableableIds = []) {
  const disabled = new Set()
  return {
    getManifests: () => manifests,
    isNonDisableable: (id) => nonDisableableIds.includes(id),
    setUserDisabled: (id, on) => {
      if (on && nonDisableableIds.includes(id)) return false
      if (on) disabled.add(id)
      else disabled.delete(id)
      return true
    },
    listUserDisabled: () => Array.from(disabled),
    _disabled: disabled
  }
}

const optional = { id: 'totp-service', defaultDisabled: true }
const normal = { id: 'notes-service' }

let warnSpy
beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { warnSpy.mockRestore() })

describe('出厂默认关闭 · 播种', () => {
  it('首次启动：声明 defaultDisabled 的插件被写成"用户禁用"，并落盘', () => {
    const settings = fakeSettings()
    const store = createPluginStateStore({ getSettingsService: () => settings })
    const registry = stubRegistry([optional, normal])

    const res = seedDefaultDisabled(registry, store)

    expect(res.newlySeeded).toEqual(['totp-service'])
    expect(registry._disabled.has('totp-service')).toBe(true)   // enableAll 会跳过它
    expect(registry._disabled.has('notes-service')).toBe(false) // 没声明的照旧启用
    expect(store.loadDisabled()).toEqual(['totp-service'])
    expect(store.loadDefaultsSeeded()).toEqual(['totp-service'])
  })

  it('⚠ 用户手动打开后重启：不再被关回去（seeded 标记的全部意义）', () => {
    const settings = fakeSettings()
    const store = createPluginStateStore({ getSettingsService: () => settings })
    const registry = stubRegistry([optional, normal])

    seedDefaultDisabled(registry, store)
    // 模拟用户在插件中心把它打开：磁盘上移除、注册中心移除
    registry.setUserDisabled('totp-service', false)
    store.saveDisabled(registry.listUserDisabled())

    // 重启：新的注册中心 + 同一份磁盘状态
    const registry2 = stubRegistry([optional, normal])
    for (const id of store.loadDisabled()) registry2.setUserDisabled(id, true)
    const res2 = seedDefaultDisabled(registry2, store)

    expect(res2.newlySeeded).toEqual([])                        // 什么都没做
    expect(registry2._disabled.has('totp-service')).toBe(false) // 用户的选择被尊重
    expect(store.loadDisabled()).toEqual([])
  })

  it('已播种过但插件仍未开（用户没管）→ 幂等，不重复写盘', () => {
    const settings = fakeSettings()
    const store = createPluginStateStore({ getSettingsService: () => settings })
    const registry = stubRegistry([optional])
    seedDefaultDisabled(registry, store)

    const writeSpy = vi.spyOn(settings, 'set')
    const res = seedDefaultDisabled(registry, store)
    expect(res).toEqual({ newlySeeded: [], marked: [] })
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('不可禁用 + defaultDisabled → 记标记但不写 disabled（没有"关"这个状态）', () => {
    const settings = fakeSettings()
    const store = createPluginStateStore({ getSettingsService: () => settings })
    const locked = { id: 'side-panel-skeleton', defaultDisabled: true }
    const registry = stubRegistry([locked], ['side-panel-skeleton'])

    const res = seedDefaultDisabled(registry, store)

    expect(res.marked).toEqual(['side-panel-skeleton'])
    expect(res.newlySeeded).toEqual([])
    expect(registry._disabled.size).toBe(0)
    expect(store.loadDisabled()).toEqual([])
    // 标记照记：否则每次启动都要重算一遍
    expect(store.loadDefaultsSeeded()).toEqual(['side-panel-skeleton'])
  })

  it('整表覆盖写入不会丢掉"之前就禁用着的"其它插件', () => {
    const settings = fakeSettings()
    const store = createPluginStateStore({ getSettingsService: () => settings })
    store.saveDisabled(['old-one', 'old-two'])
    const registry = stubRegistry([optional])
    for (const id of ['old-one', 'old-two']) registry.setUserDisabled(id, true)

    seedDefaultDisabled(registry, store)

    expect(store.loadDisabled().sort()).toEqual(['old-one', 'old-two', 'totp-service'])
  })

  it('没有插件声明 defaultDisabled → 一个字节都不写', () => {
    const settings = fakeSettings()
    const store = createPluginStateStore({ getSettingsService: () => settings })
    const writeSpy = vi.spyOn(settings, 'set')

    const res = seedDefaultDisabled(stubRegistry([normal]), store)

    expect(res).toEqual({ newlySeeded: [], marked: [] })
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('注册中心/storage 缺失时安全退化，不抛', () => {
    expect(seedDefaultDisabled(null, null)).toEqual({ newlySeeded: [], marked: [] })
    expect(seedDefaultDisabled({}, {})).toEqual({ newlySeeded: [], marked: [] })
  })
})
