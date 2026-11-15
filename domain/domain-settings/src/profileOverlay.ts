// @ts-check
/**
 * profileOverlay — 按 profile × **空间** 的设置覆盖层（Steam 式多用户 + Arc 式多空间）
 *
 * ── 语义（三层，前者优先）─────────────────────────────────────────
 *   `profiles/<id>/spaces/<spaceId>/settings.json`  该空间的覆盖（只含**按空间**的键）
 *   `profiles/<id>/settings.json`                   该用户自己的覆盖（只存他真改过的键）
 *   `<userData>/settings.json`                      安装基线（升级前那份既有设置，原样保留）
 *
 * 读：空间层（仅限登记为「按空间」的键）→ 用户覆盖 → 基线。
 * 写：按空间隔离的键写空间层，其余写用户覆盖层。
 *
 * ── 为什么第三层只承接"按空间"的键 ────────────────────────────────
 * 见 domain-settings#SPACE_SCOPED_SETTING_KEYS 的说明：只有**上下文环境**（主题/代理/UA）
 * 才该按空间各存一份。若所有键都下沉到空间层，用户在设置页改的每一项都会变成
 * "只对这一空间有效"，切空间即"设置自己变回去了"—— 那是比不做隔离更糟的体验。
 * 于是空间层是**白名单驱动**的：不在清单里的键连读都不看空间层。
 *
 * ── 为什么是「覆盖层」而不是「每 profile/空间一份完整设置」────────────────
 *   · 升级不丢：老用户升级前调好的设置继续对所有 profile 生效，
 *     不会突然变回出厂值（若拆成完整副本就要写一份迁移，风险大）；
 *   · 磁盘小：只写用户真的改动过的项；
 *   · 隔离到位：任何写入都落在自己的文件里，**不可能**改到别的用户 / 空间。
 *
 * ── 为什么用组合（装饰）而不是改 createSettingsService 内部 ──────────
 * 覆盖层只依赖三件事：FilePort（读写 JSON）、「当前 profile」与「当前空间」两个端口。
 * 把这几件事注入进来，基础服务在单 profile / 单空间 / 单测场景保持**零感知**；
 * 反过来若把分支写进基础服务，每个 get/set 都要判一次「要不要走覆盖」，
 * 单用户路径也要付这份复杂度。
 *
 * 向后兼容：不注入 `getSpaceId` / `spaceDirOf` 时**完全退化为原来的两层**——
 * 行为一字不变（单窗口、未接入空间的调用方无需改动）。
 *
 * 型别护栏不在这里重写：一律走 base.normalize()（同一套型别强制 + number 夹界），
 * 避免两处规则漂移。
 */

import {
  filterBySection,
  missingDefaults,
  isDefaultValue,
  toCSSVarSuffix,
  presentSections
} from './settingsUtil'
import type { SettingsMap } from './settingsUtil'
import type { SettingsChange, SettingsFilePort, SettingsService } from './index'
const { isGlobalSettingKey } = require('@hira-ng/shared-types/src/settings-scope.mjs') as {
  isGlobalSettingKey: (key: unknown) => boolean
}

export interface ProfileSettingsOverlay extends SettingsService {
  currentProfile(): string
  currentSpace(): string
  isSpaceScoped(key: unknown): boolean
  setForSpace(spaceId: string, key: string, value: unknown, profileId?: string): boolean
  getForSpace(spaceId: string, key: string, profileId?: string): unknown
}
export interface ProfileSettingsOverlayOptions {
  base: SettingsService
  filePort: SettingsFilePort
  profileDirOf: (profileId: string) => string
  getProfileId?: () => string
  getSpaceId?: () => string
  spaceDirOf?: (profileId: string, spaceId: string) => string
  globalSettings?: SettingsService | null
}

/**
 * 「哪些键全局」的**唯一真源**（PART16 §3.2 / §5 步骤 6）。
 *
 * L2 后设置分两类：按 profile（存各自快照）与全局（插件 + 界面布局，存
 * `<userData>/settings.global.json`）。判据只有这一处，避免"这里一个规则那里一个变化"。
 */
/** 与基础服务同一档防抖：设置在 UI 上可能被连续拖动（滑块），不必每次落盘。 */
const SAVE_DEBOUNCE_MS = 120

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
}

function snapshotSettings(map: SettingsMap): SettingsMap {
  try {
    return structuredClone(map)
  } catch (_) {
    return { ...map }
  }
}

/**
 * 「按空间」设置键的清单 + 唯一判据。
 *
 * ⚠ 这里**必须**从 index.js 拿同一份：`SPACE_SCOPED_SETTING_KEYS` 是"哪些键按空间隔离"
 * 的**唯一真源**，本文件若自己再列一遍，设置页的标记、存储路由、切空间重放三处就会漂移。
 * 环状 require 是安全的：index.js 先 require 本模块、之后才定义并导出该常量，而这里
 * 是**延迟到运行时**才 require（那时 index.js 已加载完）；首次取到后缓存 —— 清单是
 * 冻结常量，且 `get()` 是热路径，不该每次都走一遍 require 缓存。
 */
let cachedSpaceScopedKeys: readonly string[] | null = null
function spaceScopedKeysOf(): readonly string[] {
  if (cachedSpaceScopedKeys) return cachedSpaceScopedKeys
  let keys: readonly string[] = []
  try {
    const mod = require('./index')
    if (Array.isArray(mod.SPACE_SCOPED_SETTING_KEYS)) keys = mod.SPACE_SCOPED_SETTING_KEYS
  } catch (_) { /* 未导出 → 视为"没有任何按键空间隔离"，退化为原两层行为 */ }
  cachedSpaceScopedKeys = keys
  return keys
}

/**
 * @param {object} options
 * @param {object} options.base       createSettingsService() 的返回值（安装基线）
 * @param {object} options.filePort   与基础服务同一个 FilePort（domain 不 import fs）
 * @param {(profileId: string) => string} options.profileDirOf  profileId → 该用户的目录
 * @param {() => string} [options.getProfileId]  当前 profile（缺省 'default'）
 * @param {() => string} [options.getSpaceId]    当前空间（缺省不启用空间层）
 * @param {(profileId: string, spaceId: string) => string} [options.spaceDirOf]
 *   空间目录（缺省不启用空间层）。与 profileDirOf 同款：目录口径由 APPS 决定。
 * @param {object} [options.globalSettings]
 *   全局设置存储（`settings.global.json` 的同一套设置服务）。
 *   注入后，命中 `isGlobalSettingKey` 的键**完全交给它**（读、写、重置、订阅）——
 *   插件状态与界面布局跨 profile 共享（PART16 §3.2）。缺省 = 不启用全局路由（行为不变）。
 * @returns {object} 与基础服务**同形**的服务（可直接原样注入给原有消费者）
 */
function createProfileSettingsOverlay({ base, filePort, profileDirOf, getProfileId, getSpaceId, spaceDirOf, globalSettings }: ProfileSettingsOverlayOptions): ProfileSettingsOverlay {
  if (!base) throw new Error('[domain-settings] profileOverlay 需要 base 设置服务')
  if (!filePort) throw new Error('[domain-settings] profileOverlay 需要 filePort')
  if (typeof profileDirOf !== 'function') throw new Error('[domain-settings] profileOverlay 需要 profileDirOf 端口')

  /** 空间层是否启用：两个端口齐备才算（缺一即退回原两层行为）。 */
  const spaceEnabled = typeof getSpaceId === 'function' && typeof spaceDirOf === 'function'
  /** 全局路由是否启用：需注入全局设置存储（缺省 → 全部走按 profile 层，行为不变）。 */
  const globalEnabled = !!globalSettings && typeof globalSettings.get === 'function'
  /** 该键是否走全局存储（唯一判据来自 shared-types#settings-scope）。 */
  function isGlobal(key: unknown): boolean {
    return globalEnabled && isGlobalSettingKey(key)
  }

  // 默认值全表 / CSS 变量 section 口径**向 base 要**（单一来源，避免环状 require）
  const DEFAULTS: SettingsMap = typeof base.defaults === 'function' ? base.defaults() : {}
  const CSS_VAR_SECTIONS = typeof base.cssVarSections === 'function'
    ? base.cssVarSections()
    : new Set(['app', 'ui'])

  /** profileId → 已加载的覆盖值 */
  const overlays: Map<string, SettingsMap> = new Map<string, SettingsMap>()
  /** @type {Set<string>} 有未落盘改动的 profile */
  const dirty: Set<string> = new Set<string>()
  /** profileId → 防抖定时器 */
  const timers: Map<string, ReturnType<typeof setTimeout>> = new Map<string, ReturnType<typeof setTimeout>>()
  /** `profileId\u0000spaceId` → 已加载的空间覆盖值 */
  const spaceOverlays: Map<string, SettingsMap> = new Map<string, SettingsMap>()
  /** @type {Set<string>} 有未落盘改动的空间（键同上） */
  const spaceDirty: Set<string> = new Set<string>()
  /** 空间键 → 防抖定时器 */
  const spaceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map<string, ReturnType<typeof setTimeout>>()
  /** 覆盖层自己产生的变更订阅者 */
  const ownListeners = new Set<(change: SettingsChange) => void>()
  /** 所有覆盖文件共用同一写队列，旧快照不能晚于新快照落盘。 */
  let writeTail: Promise<void> = Promise.resolve()
  const writeRevisions = new Map<string, number>()

  /** 当前 profile；端口缺失/抛错一律回落 'default'（绝不能「拿不到就不过滤」）。 */
  function currentProfile(): string {
    if (typeof getProfileId !== 'function') return 'default'
    try {
      const v = getProfileId()
      return v ? String(v) : 'default'
    } catch (_) {
      return 'default'
    }
  }

  /** 当前空间；端口缺失/抛错 → 空串（= 该次读写不落空间层）。 */
  function currentSpace(): string {
    if (!spaceEnabled) return ''
    try {
      const v = getSpaceId()
      return v ? String(v) : ''
    } catch (_) {
      return ''
    }
  }

  /** 空间层的缓存键（profile 与空间都要参与，缺一不可）。 */
  function spaceKey(profileId: string, spaceId: string): string {
    return `${profileId}\u0000${spaceId}`
  }

  function filePathOf(profileId: string): string {
    return filePort.join(profileDirOf(profileId), 'settings.json')
  }

  function spaceFilePathOf(profileId: string, spaceId: string): string {
    return filePort.join(spaceDirOf!(profileId, spaceId), 'settings.json')
  }

  /** 该键是否按空间隔离（清单唯一真源在 domain-settings#SPACE_SCOPED_SETTING_KEYS）。 */
  function isSpaceScoped(key: unknown): boolean {
    return spaceEnabled && spaceScopedKeysOf().includes(String(key))
  }

  /**
   * 取（并在首次访问时加载）某 profile 的覆盖值。
   * 加载失败 → 空覆盖（= 完全走基线），绝不让设置读取因磁盘问题而整体不可用。
   */
  function overlayOf(profileId: string): SettingsMap {
    const cached = overlays.get(profileId)
    if (cached) return cached
    const loaded = readJsonObject(filePathOf(profileId), `profile 覆盖(${profileId})`)
    overlays.set(profileId, loaded)
    return loaded
  }

  /** 取（首次访问时加载）某 profile×空间 的空间层覆盖值（只保留登记为按空间的键）。 */
  function spaceOverlayOf(profileId: string, spaceId: string): SettingsMap {
    const key = spaceKey(profileId, spaceId)
    const cached = spaceOverlays.get(key)
    if (cached) return cached
    const raw = readJsonObject(spaceFilePathOf(profileId, spaceId), `空间覆盖(${profileId}/${spaceId})`)
    const scoped = spaceScopedKeysOf()
    const row: SettingsMap = {}
    for (const k of Object.keys(raw)) {
      if (scoped.includes(k)) row[k] = raw[k]
    }
    spaceOverlays.set(key, row)
    return row
  }

  /** 读一个 JSON 对象；不存在 / 坏掉 / 不是对象 → 空对象（宽进，绝不抛）。 */
  function readJsonObject(filePath: string, label: string): SettingsMap {
    try {
      if (!filePort.existsSync(filePath)) return {}
      const parsed = filePort.readJsonSync(filePath)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...(parsed as SettingsMap) }
    } catch (e) {
      console.error(`[settings] ${label} 读取失败:`, errorMessage(e))
    }
    return {}
  }

  function writeSync(profileId: string): void {
    try {
      filePort.writeJsonAtomicSync(filePathOf(profileId), overlayOf(profileId), { space: 2 })
      dirty.delete(profileId)
    } catch (e) {
      console.error(`[settings] profile 覆盖落盘失败 (${profileId}):`, errorMessage(e))
    }
  }

  function writeSpaceSync(profileId: string, spaceId: string): void {
    const key = spaceKey(profileId, spaceId)
    try {
      filePort.writeJsonAtomicSync(spaceFilePathOf(profileId, spaceId), spaceOverlayOf(profileId, spaceId), { space: 2 })
      spaceDirty.delete(key)
    } catch (e) {
      console.error(`[settings] 空间覆盖落盘失败 (${profileId}/${spaceId}):`, errorMessage(e))
    }
  }

  function bumpWriteRevision(filePath: string): number {
    const next = (writeRevisions.get(filePath) || 0) + 1
    writeRevisions.set(filePath, next)
    return next
  }

  function enqueueJsonWrite(filePath: string, snapshot: SettingsMap, markClean: () => void): void {
    const revision = writeRevisions.get(filePath) || 0
    const task = writeTail
      .catch(() => {})
      .then(() => filePort.writeJsonAtomic(filePath, snapshot, { space: 2 }))
    writeTail = task.catch(() => {})
    void task
      .then(() => {
        if ((writeRevisions.get(filePath) || 0) === revision) markClean()
      })
      .catch((e: unknown) => console.error('[settings] 覆盖异步落盘失败:', errorMessage(e)))
  }

  function scheduleSave(profileId: string): void {
    dirty.add(profileId)
    const filePath = filePathOf(profileId)
    bumpWriteRevision(filePath)
    if (timers.has(profileId)) return
    timers.set(profileId, setTimeout(() => {
      timers.delete(profileId)
      enqueueJsonWrite(filePath, snapshotSettings(overlayOf(profileId)), () => dirty.delete(profileId))
    }, SAVE_DEBOUNCE_MS))
  }

  function scheduleSpaceSave(profileId: string, spaceId: string): void {
    const key = spaceKey(profileId, spaceId)
    spaceDirty.add(key)
    const filePath = spaceFilePathOf(profileId, spaceId)
    bumpWriteRevision(filePath)
    if (spaceTimers.has(key)) return
    spaceTimers.set(key, setTimeout(() => {
      spaceTimers.delete(key)
      enqueueJsonWrite(
        filePath,
        snapshotSettings(spaceOverlayOf(profileId, spaceId)),
        () => spaceDirty.delete(key)
      )
    }, SAVE_DEBOUNCE_MS))
  }

  /**
   * 广播一次变更。
   * 形态与基础服务的 emit 一致（{scope,key,value,previous,originId}）——
   * APPS 侧那条「settings:changed 按窗口广播」的订阅者无需知道值来自哪一层。
   */
  function notify(change: SettingsChange): void {
    for (const fn of ownListeners) {
      try {
        fn(change)
      } catch (e) {
        console.error('[settings] 覆盖层订阅者失败:', errorMessage(e))
      }
    }
  }

  /**
   * 合并视图：基线打底 → 当前 profile 的覆盖 → 当前空间的**按空间键**覆盖。
   * 空间层只盖登记过的键（白名单），非登记键即使手写进空间文件也不生效。
   */
  function mergedOf(profileId: string, spaceId: string): SettingsMap {
    const merged = { ...base.list(), ...overlayOf(profileId) }
    if (spaceEnabled && spaceId) {
      const spaceRow = spaceOverlayOf(profileId, spaceId)
      for (const k of Object.keys(spaceRow)) merged[k] = spaceRow[k]
    }
    // 全局键最后覆盖：它们**不属于**任何 profile，值只来自全局文件（§3.2）。
    // 放在最后一步而不是与 base 合并，是为了让"全局文件里没写的键"也保持出厂默认 ——
    // 若先合并会被某个 profile 快照里的同名残留盖掉。
    if (globalEnabled) {
      const globalAll = globalSettings.list()
      for (const k of Object.keys(globalAll)) {
        if (isGlobalSettingKey(k)) merged[k] = globalAll[k]
      }
    }
    return merged
  }

  /**
   * 解析某个键的**写入层**：按空间隔离且当前有空间 → 空间层；否则 profile 层。
   * @returns {{ kind:'space', profileId:string, spaceId:string, row:object, save:Function } | { kind:'profile', profileId:string, row:object, save:Function }}
   */
  type TargetLayer = {
    kind: 'space'
    profileId: string
    spaceId: string
    row: SettingsMap
    save: () => void
  } | {
    kind: 'profile'
    profileId: string
    row: SettingsMap
    save: () => void
  }
  function targetLayerOf(key: string): TargetLayer {
    const pid = currentProfile()
    const sid = currentSpace()
    if (isSpaceScoped(key) && sid) {
      return {
        kind: 'space',
        profileId: pid,
        spaceId: sid,
        row: spaceOverlayOf(pid, sid),
        save: () => scheduleSpaceSave(pid, sid)
      }
    }
    return { kind: 'profile', profileId: pid, row: overlayOf(pid), save: () => scheduleSave(pid) }
  }

  /** @param {string} key */
  function get(key: string): unknown {
    // 全局键（插件状态 / 界面布局）：值只在全局文件里，与当前 profile 无关。
    if (isGlobal(key)) return globalSettings!.get(key)
    const pid = currentProfile()
    if (isSpaceScoped(key)) {
      const sid = currentSpace()
      if (sid) {
        const row = spaceOverlayOf(pid, sid)
        if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
      }
      // 空间层没有 → 落回用户覆盖 → 基线（**不能**直接 base.get，否则用户级覆盖被跳过）
      const ov = overlayOf(pid)
      return Object.prototype.hasOwnProperty.call(ov, key) ? ov[key] : base.get(key)
    }
    const ov = overlayOf(pid)
    return Object.prototype.hasOwnProperty.call(ov, key) ? ov[key] : base.get(key)
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {number} [originId]
   * @returns {boolean}
   */
  function set(key: string, value: unknown, originId?: number): boolean {
    // 全局键直接写全局文件（不落任何 profile 的快照）。
    if (isGlobal(key)) return globalSettings!.set(key, value, originId)
    const next = typeof base.normalize === 'function' ? base.normalize(key, value) : value
    const layer = targetLayerOf(key)
    const previous = get(key)
    if (previous === next) return true
    layer.row[key] = next
    layer.save()
    notify({ scope: 'one', key, value: next, previous, originId })
    return true
  }

  /**
   * 当前 profile（+ 当前空间）的全部设置，可按 section 前缀过滤。
   * @param {string} [section]
   */
  function list(section?: string): SettingsMap {
    const merged = mergedOf(currentProfile(), currentSpace())
    return section ? filterBySection(merged, section) : merged
  }

  /**
   * 相对出厂默认发生差异的键（缺省键 + 非默认值键的并集）。
   * 基于**合并视图**计算：只看基线会让「本用户 / 本空间改过的项」漏判。
   * @returns {string[]}
   */
  function changedKeys(): string[] {
    const merged = mergedOf(currentProfile(), currentSpace())
    const missing = missingDefaults(merged, DEFAULTS)
    const nonDefault = Object.keys(merged).filter(
      (k) => k in DEFAULTS && !isDefaultValue(k, merged[k], DEFAULTS)
    )
    return Array.from(new Set([...missing, ...nonDefault]))
  }

  /** 展示型 section（app/ui）→ CSS 变量映射（同样基于合并视图）。 */
  function cssVars(): Record<string, unknown> {
    const merged = mergedOf(currentProfile(), currentSpace())
    const out: Record<string, unknown> = {}
    for (const sec of presentSections(merged)) {
      if (!CSS_VAR_SECTIONS.has(sec)) continue
      for (const k of Object.keys(filterBySection(merged, sec))) {
        out[toCSSVarSuffix(k)] = merged[k]
      }
    }
    return out
  }

  /**
   * 恢复默认。
   *
   * 语义（与「三层」一致）：**删掉对应层的覆盖** → 落回下一层。
   * 按空间的键删空间层（落回用户覆盖 / 基线）；其余删用户覆盖（落回基线）。
   * 为什么不顺手把基线也重置：那会一次点击改掉**所有其他用户**的设置 ——
   * 与「每个用户的数据互不干扰」直接冲突。出厂默认由基线文件自身承担。
   * @param {string} [key]
   * @param {number} [originId]
   * @returns {boolean}
   */
  function reset(key?: string, originId?: number): boolean {
    if (key) {
      // 全局键：只在全局文件里可能有覆盖，直接交给它重置（落回出厂默认）。
      if (isGlobal(key)) return globalSettings!.reset(key, originId)
      /**
       * 逐层往下找：按空间键先看空间层、再看用户覆盖层（该键可能是空间层出现之前写下的），
       * 找到就删那一层并落盘。两层都没有 = 本来就是默认值 → 直接返回成功。
       */
      const layer = targetLayerOf(key)
      const candidates = layer.kind === 'space'
        ? [
            { row: layer.row, save: layer.save },
            { row: overlayOf(layer.profileId), save: () => scheduleSave(layer.profileId) }
          ]
        : [{ row: layer.row, save: layer.save }]
      for (const candidate of candidates) {
        if (!Object.prototype.hasOwnProperty.call(candidate.row, key)) continue
        const previous = candidate.row[key]
        delete candidate.row[key]
        candidate.save()
        notify({ scope: 'one', key, value: get(key), previous, originId })
        return true
      }
      return true
    }
    // 整体重置：**只清当前层**（当前空间存在 → 清空间层；否则清 profile 层）。
    const pid = currentProfile()
    const sid = currentSpace()
    // 全局文件是独立的一层：它不属于任何 profile / 空间，"恢复默认"应当把它也清掉，
    // 否则用户点完"恢复默认"会发现布局/插件开关纹丝不动（那正是最难解释的一类残留）。
    if (globalEnabled) {
      try { globalSettings.reset(undefined, originId) } catch (_) {}
    }
    if (spaceEnabled && sid) {
      const previousMerged = mergedOf(pid, sid)
      spaceOverlays.set(spaceKey(pid, sid), {})
      scheduleSpaceSave(pid, sid)
      notify({ scope: 'all', key: undefined, value: undefined, previous: previousMerged, originId })
      return true
    }
    const previousMerged = mergedOf(pid, '')
    overlays.set(pid, {})
    scheduleSave(pid)
    notify({ scope: 'all', key: undefined, value: undefined, previous: previousMerged, originId })
    return true
  }

  /**
   * 订阅变更：**两层都订**。
   * 基线自身的写入（例如某个 applier 直接改基线）也必须让 UI 得到通知，
   * 否则会出现「值变了但界面不动」的黑洞。
   * @param {Function} fn
   * @returns {() => void}
   */
  function subscribe(fn: (change: SettingsChange) => void): () => void {
    if (typeof fn !== 'function') return () => {}
    ownListeners.add(fn)
    const unsubscribeBase = typeof base.subscribe === 'function' ? base.subscribe(fn) : () => {}
    // 全局文件是独立存储：它自己的写入也必须让 UI 得到通知（否则改布局界面不动）。
    const unsubscribeGlobal = globalEnabled && typeof globalSettings.subscribe === 'function'
      ? globalSettings.subscribe(fn)
      : () => {}
    return () => {
      ownListeners.delete(fn)
      unsubscribeBase()
      unsubscribeGlobal()
    }
  }

  /** 退出前落盘：基线 + 所有有改动的 profile 覆盖 + 所有有改动的空间覆盖 + 全局文件。 */
  async function flush(): Promise<void> {
    for (const [pid, timer] of timers) {
      clearTimeout(timer)
      timers.delete(pid)
    }
    for (const [key, timer] of spaceTimers) {
      clearTimeout(timer)
      spaceTimers.delete(key)
    }
    await writeTail
    for (const pid of Array.from(dirty)) writeSync(pid)
    for (const key of Array.from(spaceDirty)) {
      const split = key.indexOf('\u0000')
      if (split < 0) continue
      writeSpaceSync(key.slice(0, split), key.slice(split + 1))
    }
    await Promise.all([
      typeof base.flush === 'function' ? Promise.resolve(base.flush()) : Promise.resolve(),
      globalEnabled && typeof globalSettings.flush === 'function'
        ? Promise.resolve(globalSettings.flush())
        : Promise.resolve()
    ])
  }

  return {
    get,
    set,
    list,
    reset,
    subscribe,
    flush,
    changedKeys,
    cssVars,
    normalize: typeof base.normalize === 'function' ? base.normalize : (_key: string, value: unknown) => value,
    getDefault: (key: string) => base.getDefault(key),
    defaults: () => DEFAULTS,
    cssVarSections: () => CSS_VAR_SECTIONS,
    /** 诊断/管理用：当前 profile / 空间（跟随注入端口） */
    currentProfile,
    currentSpace,
    /** 某个键此刻是否按空间隔离（设置页据此给输入框打「按空间」标记）。 */
    isSpaceScoped,
    /**
     * 把某个**按空间**的键写到**指定空间**（不依赖当前空间）。
     *
     * 用途：空间编辑器里给"别的空间"配主题 —— 那时当前空间不是目标空间，
     * 走 `set()` 会写错地方。非按空间的键一律拒绝（返回 false），
     * 避免调用方误以为"随便什么键都能按空间写"。
     * @param {string} spaceId
     * @param {string} key
     * @param {unknown} value
     * @param {string} [profileId] 目标 profile；缺省沿用当前上下文（兼容旧调用）
     * @returns {boolean}
     */
    setForSpace(spaceId: string, key: string, value: unknown, profileId?: string): boolean {
      if (!spaceEnabled || !isSpaceScoped(key)) return false
      const sid = spaceId ? String(spaceId) : ''
      if (!sid) return false
      const pid = profileId ? String(profileId) : currentProfile()
      const row = spaceOverlayOf(pid, sid)
      // `null` / `undefined` = **清掉该空间对这一项的覆盖**（落回用户设置 / 基线）。
      // 为什么复用同一个入参而不另开一条 reset 通道：对调用方而言"给这个空间设成取值 X"
      // 与"这个空间不再单独设"是同一个动作的两个取值，分成两条通道只会多一处要同步。
      if (value == null) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) return true
        delete row[key]
        scheduleSpaceSave(pid, sid)
        if (pid === currentProfile() && sid === currentSpace()) notify({ scope: 'one', key, value: get(key) })
        return true
      }
      const next = typeof base.normalize === 'function' ? base.normalize(key, value) : value
      if (row[key] === next) return true
      row[key] = next
      scheduleSpaceSave(pid, sid)
      // 只有当目标就是当前空间时才广播 —— 否则会把"别的空间的改动"当成当前状态推给 UI。
      if (pid === currentProfile() && sid === currentSpace()) notify({ scope: 'one', key, value: next })
      return true
    },
    /** 读取**指定空间**下某个按空间键的值（空间编辑器回显用）。 */
    getForSpace(spaceId: string, key: string, profileId?: string): unknown {
      if (!spaceEnabled || !isSpaceScoped(key)) return undefined
      const sid = spaceId ? String(spaceId) : ''
      if (!sid) return undefined
      const row = spaceOverlayOf(profileId ? String(profileId) : currentProfile(), sid)
      if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
      return undefined
    }
  }
}

export { createProfileSettingsOverlay }
export default { createProfileSettingsOverlay }
