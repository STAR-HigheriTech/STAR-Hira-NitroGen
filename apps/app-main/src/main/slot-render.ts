/**
 * 渲染侧插槽宿主的主进程一半（`slots:render` / `slots:dispatch`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 问题：实现在主进程，产出面在渲染层
 * ══════════════════════════════════════════════════════════════════════
 * `side-panel.toolbar-action-slot` 这类插槽的产出物是一个**按钮**（画在渲染层），
 * 但它的实现是插件 `.cjs`（跑在主进程），`onSelect` 是个闭包 —— 函数过不了 IPC。
 *
 * 于是分工必须切成两半，`key` 是两半之间的唯一凭据：
 *
 *   渲染层  slots:render   →  主进程执行插槽 → 剥掉函数 → 回 [{ key, descriptor }]
 *   渲染层  slots:dispatch(key) → 主进程按 key 重新执行插槽、找到那个实现 → 调它的 onSelect
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么 dispatch 是「重新执行插槽」而不是「缓存描述符」
 * ══════════════════════════════════════════════════════════════════════
 * 缓存会引入失效问题（插件被禁用 / 面板换了 / 数据变了，缓存里还是旧闭包与旧 payload，
 * 于是点了一个已经不存在的项）。重新执行虽然多跑一次实现，但实现的语义就是
 * 「描述 + 带一个 onSelect」，执行它本来就该是纯的、廉价的 —— 这条约束同时也让
 * 插件作者不敢在描述阶段做重活（正是我们想要的压力）。
 */

import { errorMessage } from './ipc/types'

interface SlotExtensionPointsPort {
  callWithKeysSync(slotId: string, payload: unknown): unknown
}

interface SlotRendererLogger {
  warn?(message: string, detail?: unknown): void
  error?(message: string, detail?: unknown): void
}

interface SlotRendererOptions {
  extensionPoints?: SlotExtensionPointsPort | null
  logger?: SlotRendererLogger
}

interface SlotEntry { key: string; pluginId: string | null; value: unknown }

interface SlotItem { key: string; pluginId: string | null; descriptor: unknown }

interface SlotRenderer {
  hostedSlots(): string[]
  render(slotId: string, payload: unknown): { items: SlotItem[] }
  dispatch(slotId: string, key: string, payload: unknown): Promise<{ ok: boolean; reason?: string }>
}

/**
 * 允许被**渲染层**宿主的插槽白名单。
 *
 * 为什么必须白名单：`slots:render` 一旦允许渲染层自由指定 slotId，内部页就能触发
 * 任意插槽（`db.schema.migration`、`profile.on-before-switch`…）。
 * 这里只放行「产出面本来就在渲染层」的那几个。
 *
 * 新增一个渲染侧宿主插槽 = 这里加一项。
 */
export const RENDERER_HOSTED_SLOTS = Object.freeze(new Set([
  'side-panel.toolbar-action-slot',
  'side-panel.rail-icon-slot',
  // PART18 开放世界：外壳按钮 / 标签动作 / 浮层描述符
  // 三者的产出面同样在渲染层（按钮、动作图标、iframe 浮层），因此必须放行。
  'navbar.button-slot',
  'tab.action-slot',
  'overlay.slot',
  'download.rule-action'
]))

/**
 * 把任意实现返回值转成**可安全过 IPC** 的纯数据。
 *
 * 做两件事：
 *   · 剥掉函数 / symbol / bigint（结构化克隆会直接抛错，不剥就是整个 IPC 失败）
 *   · 限深（插件可能返回带环或极深的对象，IPC 会被它拖死）
 * 返回值里被剥掉的字段直接消失 —— 渲染层拿到的就是「只剩数据」的描述符。
 *
 * @param {any} value
 * @param {number} [depth]
 * @returns {any} 纯数据；不可序列化的部分为 undefined
 */
export function toSerializable (value: unknown, depth: number = 0): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') return undefined
  if (depth >= 6) return undefined
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const v of value) {
      const sv = toSerializable(v, depth + 1)
      if (sv !== undefined) out.push(sv)
    }
    return out
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object)) {
      const sv = toSerializable((value as Record<string, unknown>)[key], depth + 1)
      if (sv !== undefined) out[key] = sv
    }
    return out
  }
  return undefined
}

/**
 * 把某个实现返回值归一成描述符列表（**展平一层**）。
 *
 * 与 `slot-menu.js` 同一个坑、同一个结论：MULTI 把**每个实现的返回值**收成数组，
 * 实现自己返回数组就得到嵌套结构（`[[项,项]]`）。而「一个插件加 2~3 个按钮」
 * 正是工具栏场景的常态 —— 所以统一展平，让作者不必懂调度器的聚合细节。
 *
 * @returns {any[]}
 */
function toDescriptorList (value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value.flat(1) : [value]
}

/**
 * 跨进程的项键：`<实现键>#<该实现产出的第几项>`。
 *
 * 为什么不能只用实现键：一个实现可能产出多项（见上），必须能区分到"第几项"。
 * 序号取自描述符顺序 —— 因此**实现必须稳定排序**（同一 payload 下顺序一致），
 * 否则第 0 项可能在不同调用间指向不同的按钮。这是插件作者的契约。
 */
function composeKey (implKey: string, index: number): string {
  return `${implKey}#${index}`
}

function parseKey (key: unknown): { implKey: string; index: number } {
  const raw = String(key || '')
  const at = raw.lastIndexOf('#')
  if (at <= 0) return { implKey: raw, index: 0 }
  const n = Number(raw.slice(at + 1))
  return { implKey: raw.slice(0, at), index: Number.isInteger(n) && n >= 0 ? n : 0 }
}

/**
 * @param {{
 *   extensionPoints?: object,
 *   logger?: { warn?: Function, error?: Function }
 * }} [options]
 */
export function createSlotRenderer (options: SlotRendererOptions = {}): SlotRenderer {
  const logger = options.logger || console
  const extensionPoints = options.extensionPoints
  const usable = !!extensionPoints && typeof extensionPoints.callWithKeysSync === 'function'

  function denyReason (slotId: string): string | null {
    if (!RENDERER_HOSTED_SLOTS.has(slotId)) return `插槽 ${slotId} 不允许由渲染层宿主`
    if (!usable) return '插槽调度器未就绪'
    return null
  }

  /** 执行插槽并取出「实现键 + 描述符列表」，失败一律降级为空。 */
  function collect (slotId: string, payload: unknown): SlotEntry[] | null {
    try {
      return extensionPoints?.callWithKeysSync(slotId, payload) as SlotEntry[]
    } catch (e) {
      // 含「同步插槽塞了异步实现」这类致命错误：降级为空，UI 少几个按钮但不崩。
      if (logger.warn) logger.warn(`[slot-render] 插槽 ${slotId} 执行失败（已跳过）：`, errorMessage(e))
      return null
    }
  }

  return {
    /** 供 UI / 诊断：当前允许渲染层宿主的插槽。 */
    hostedSlots () {
      return Array.from(RENDERER_HOSTED_SLOTS)
    },

    /**
     * 执行插槽并返回可序列化描述符。
     * @returns {{ items: Array<{ key: string, pluginId: string|null, descriptor: any }> }}
     */
    render (slotId: string, payload: unknown): { items: SlotItem[] } {
      if (denyReason(slotId)) return { items: [] }
      const entries = collect(slotId, payload)
      if (!entries) return { items: [] }
      const items: SlotItem[] = []
      for (const entry of entries) {
        toDescriptorList(entry.value).forEach((descriptor, index) => {
          const serializable = toSerializable(descriptor)
          // 实现没返回可用描述符（忘了 return / 返回了函数）时跳过：
          // 把 undefined 塞给渲染层只会画出空按钮。
          if (serializable === undefined || serializable === null) return
          items.push({ key: composeKey(entry.key, index), pluginId: entry.pluginId, descriptor: serializable })
        })
      }
      return { items }
    },

    /**
     * 按 key 派发。重新执行插槽以拿到该实现当下产出的那一项（见文件头说明）。
     * @returns {{ ok: boolean, reason?: string }}
     */
    async dispatch (slotId: string, key: string, payload: unknown): Promise<{ ok: boolean; reason?: string }> {
      const denied = denyReason(slotId)
      if (denied) return { ok: false, reason: denied }
      const entries = collect(slotId, payload)
      if (!entries) return { ok: false, reason: '插槽执行失败' }
      const { implKey, index } = parseKey(key)
      const hit = entries.find((entry) => entry.key === implKey)
      if (!hit) return { ok: false, reason: `该实现已不存在（插件可能已被禁用）：${implKey}` }
      const list = toDescriptorList(hit.value)
      const descriptor = list[index]
      if (!descriptor) return { ok: false, reason: `该实现当前没有第 ${index} 项（实现产出的顺序可能变了）：${key}` }
      const descriptorRecord = descriptor && typeof descriptor === 'object' ? descriptor as Record<string, unknown> : {}
      const onSelect = typeof descriptorRecord.onSelect === 'function' ? descriptorRecord.onSelect : null
      if (!onSelect) return { ok: false, reason: `该插槽项没有提供 onSelect：${key}` }
      try {
        await onSelect(payload)
        return { ok: true }
      } catch (e) {
        const message = errorMessage(e)
        if (logger.warn) logger.warn(`[slot-render] 插槽 ${slotId} 的 ${key} 执行 onSelect 失败：`, message)
        return { ok: false, reason: message }
      }
    }
  }
}

