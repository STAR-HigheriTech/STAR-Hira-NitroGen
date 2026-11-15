import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

/**
 * 功能面可用性 —— 渲染层**唯一**的"某个引擎还在不在"入口（§10.4）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么是单例 store，而不是又一个"每个组件自己 subscribe"的 client
 * ════════════════════════════════════════════════════════════════════
 * 这个数据的消费方特别多（书签栏 / 星标 / ⋮ 菜单 / 下载条 / 各内部页入口…约二十处），
 * 而它变化频率极低（只在插件启停时）。若每个组件各自 `onChanged` + 各自 invoke：
 *   · 二十条桥订阅 → 主进程每次广播被放大二十倍；
 *   · 二十次并发 invoke → 二十份同样的答案。
 * 所以这里收成 **一份状态 + 一条桥订阅 + 一次去重请求**，组件只做
 * `onFeaturesChanged(cb)` 与 `isFeatureAvailable(id)` 两件事。
 *
 * ════════════════════════════════════════════════════════════════════
 * fail-open：拿不到答案时一律"可用"
 * ════════════════════════════════════════════════════════════════════
 * 首次查询尚未返回、注册中心还没就绪、IPC 出错 —— 全都按**可用**处理。
 * 理由：隐藏 UI 是**破坏性**动作（入口消失、用户找不到），而"该藏没藏"只是难看。
 * 破坏性动作必须建立在**确定**的信息上，不确定时选可逆的那一侧。
 */

let available: Record<string, boolean> | null = null
let inFlight: Promise<Record<string, boolean> | null> | null = null
const listeners = new Set<(available: Record<string, boolean> | null) => void>()
let bridgeSubscription: (() => void) | null = null

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(available) } catch (e) { console.error('[features-client] listener error', e) }
  }
}

/** 拉一次最新可用性；并发调用共用同一个在途请求（去重）。 */
function refresh(): Promise<Record<string, boolean> | null> {
  if (inFlight) return inFlight
  inFlight = invoke(IPC_ROUTES.featuresAvailability)
    .then((res) => {
      const next = (res && res.available) as Record<string, boolean> | undefined || {}
      // 内容没变就不惊动订阅者 —— 二十个入口的重挂代价不该由"没变"来付。
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
 * 挂第一个订阅者时才建立桥订阅与首次拉取 —— 无消费方的界面（如浮层窗口）
 * 不会为此多花一次 IPC。
 * @param {(available: Record<string, boolean>|null) => void} fn
 */
export function onFeaturesChanged(fn: (available: Record<string, boolean>|null) => void) {
  if (typeof fn !== 'function') return () => {}
  const first = listeners.size === 0
  listeners.add(fn)
  if (first) {
    if (!bridgeSubscription) {
      // **一处订阅**：复用插件变更广播（启停 / 自动停用 / 连带禁用都会发），不新增事件。
      bridgeSubscription = getHiraBridge().on.subscribe(IPC_EVENTS.pluginsChanged, () => { refresh() })
    }
    refresh()
  } else if (available) {
    // 已有答案 → 立即回灌一次，避免新订阅者停在"未知"（那意味着它先渲染成可用再被隐藏）
    try { fn(available) } catch (_) {}
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && bridgeSubscription) {
      bridgeSubscription()
      bridgeSubscription = null
    }
  }
}

/**
 * 某个功能面当前是否可用。
 *
 * **缺键 = 可用**（fail-open）：新增功能面时，旧调用方拿不到键不该误隐藏自己的入口。
 * @param {string} featureId 见 apps/app-main/src/main/feature-map.js
 * @returns {boolean}
 */
export function isFeatureAvailable(featureId: string) : boolean {
  if (!featureId) return true
  if (!available) return true
  return available[featureId] !== false
}

/** 当前快照（`null` = 尚无答案，语义同"全可用"）。调试/测试用。 */
export function getFeatureAvailability() {
  return available
}

export const featuresClient = {
  availability: refresh,
  onChanged: onFeaturesChanged,
  isAvailable: isFeatureAvailable,
  snapshot: getFeatureAvailability,
  refresh
}

