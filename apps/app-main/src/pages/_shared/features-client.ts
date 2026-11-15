/**
 * 内部页 · 功能面可用性（`features:availability` 的只读投影）
 *
 * 与 `renderer/shared/features-client.js` 是**同一份契约、两种宿主**：
 *   · 渲染层是打包产物，直接 import 那份单例；
 *   · 内部页是「原样拷贝、不打包」的静态页，只能相对引用本目录的薄客户端。
 * 判定规则只有一处真源 —— `main/feature-map.js`（哪个功能面由哪些插件决定）。
 * 这里不重复任何"哪个插件叫什么"的知识，只回答「这个功能面现在可用吗」。
 *
 * 为什么收成单例：同一文档里的消费方（当前是外壳侧栏，将来可能是页面内入口）
 * 共用一份状态 + **一条**桥订阅；各自 subscribe 只会把同一条广播放大 N 倍。
 *
 * fail-open：桥不可用 / 首次请求未返回 / 请求出错（`available === null`）一律按
 * **可用**处理。隐藏入口是破坏性动作，必须建立在确定信息上，不确定时选可逆的一侧。
 *
 * 不 import `./runtime.js`：`runtime.js` → `shell.js` → 本文件，引回来会成环；
 * 通道名直接读同一份 `ipc-channels.mjs`，桥用法与 preload 暴露的 `window.hira` 一致。
 */
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'

/** `null` = 尚无答案（语义同"全可用"）。 */
let available: Record<string, boolean> | null = null
let inFlight: Promise<Record<string, boolean> | null> | null = null
const listeners = new Set<(available?: Record<string, boolean> | null) => void>()
let unsubscribePluginsChanged: (() => void) | null = null

function notify (): void {
  for (const fn of listeners) {
    try { fn(available) } catch (e) { console.error('[features] listener error', e) }
  }
}

/** 拉一次最新可用性；并发调用共用同一个在途请求（去重）。 */
function refresh (): Promise<Record<string, boolean> | null> {
  if (inFlight) return inFlight
  const bridge = window.hira
  if (!bridge || !bridge.provider || typeof bridge.provider.invoke !== 'function') {
    return Promise.resolve(available)
  }
  inFlight = bridge.provider.invoke<{ available?: Record<string, boolean> | null }>(IPC_ROUTES.featuresAvailability)
    .then((res?) => {
      const next: Record<string, boolean> = (res && res.available) || {}
      // 内容没变就不惊动订阅者 —— 侧栏重画不该由"没变"来付。
      const changed = JSON.stringify(next) !== JSON.stringify(available)
      available = next
      if (changed) notify()
      return available
    })
    .catch(() => available) // 出错保持上一次的答案（首次则是 null → 全可用）
    .finally(() => { inFlight = null })
  return inFlight
}

/**
 * 订阅可用性变化。返回退订函数。
 *
 * 挂第一个订阅者时才建立桥订阅与首次拉取；`plugins:changed` 是插件启停 / 自动停用 /
 * 连带禁用的同一条广播 —— 内部页跑在标签页里同样收得到（订阅即登记，见 tab-preload）。
 * @param {(available: Record<string, boolean>|null) => void} fn
 * @returns {() => void}
 */
export function onFeatureAvailability (fn?: (available?: Record<string, boolean> | null) => void): () => void {
  if (typeof fn !== 'function') return () => {}
  const first = listeners.size === 0
  listeners.add(fn)
  if (first) {
    const bridge = window.hira
    if (!unsubscribePluginsChanged && bridge && bridge.on && typeof bridge.on.subscribe === 'function') {
      unsubscribePluginsChanged = bridge.on.subscribe(IPC_EVENTS.pluginsChanged, () => { refresh() })
    }
    refresh()
  } else if (available) {
    // 已有答案 → 立即回灌一次，避免新订阅者先按"全可用"画一遍再被撤回。
    try { fn(available) } catch (_) {}
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && unsubscribePluginsChanged) {
      unsubscribePluginsChanged()
      unsubscribePluginsChanged = null
    }
  }
}

/**
 * 某个功能面当前是否可用。
 *
 * **缺键 = 可用**（fail-open）：新增功能面时，旧调用方拿不到键不该误隐藏自己的入口。
 * @param {string} featureId 见 `main/feature-map.js#FEATURES`
 * @returns {boolean}
 */
export function isFeatureAvailable (featureId?: string): boolean {
  if (!featureId) return true
  if (!available) return true
  return available[featureId] !== false
}

/** 当前快照（`null` = 尚无答案，语义同"全可用"）。诊断用。 */
export function getFeatureAvailability (): Record<string, boolean> | null {
  return available
}
