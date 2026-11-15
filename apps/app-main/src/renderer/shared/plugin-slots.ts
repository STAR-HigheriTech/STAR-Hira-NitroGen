/**
 * 渲染侧插槽注册表 —— 让插件的**渲染侧代码**（`entry.render` 的 `.renderer.js`）
 * 能往 UI 表面挂实现，且不需要任何 IPC 往返。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它补齐的是哪一块（此前渲染侧插槽只能"实现写在主进程 + 白名单"）
 * ══════════════════════════════════════════════════════════════════════
 * `slots-client.js` 那条路（`slots:render` / `slots:dispatch`）解决的是
 * **实现在主进程、产出面在渲染层**的插槽（`side-panel.toolbar-action-slot`）：
 * 主进程执行实现 → 剥掉函数 → 渲染层画描述符 → 点击时把 key 送回主进程派发。
 *
 * 但有一类插槽天生就在渲染层：`omnibar.result-item-renderer` 要返回 DOM、
 * `settings.custom-widget` 要挂控件、`tabbar.item-renderer` 要画标签。
 * 这些**过不了 IPC**（函数与 DOM 都不可结构化克隆），硬走描述符只会把它们
 * 降级成"只能传纯数据的阉割版"。
 *
 * 所以这里给它们第二条路：插件的 `.renderer.js` 直接在本进程注册实现，
 * 宿主组件直接调用 —— 闭包、DOM、事件全都在手，零往返、零降级。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 与主进程调度器（extension-points.js）的关系
 * ══════════════════════════════════════════════════════════════════════
 * **同构但不共库**：模式语义（SINGLE / MULTI / REDUCE / EVENT）、调用签名、
 * 错误策略（只告警不上抛）都刻意保持一致 —— 插件作者不必学第二套心智模型。
 * 但实现是各自独立的：渲染侧的注册表**不可能**用主进程那份（跨进程），
 * 而把调度器整个搬进渲染包会为一个几十行的容器引入一大片无关依赖。
 *
 * 官方插槽表（official-extension-points.js）里，哪几个走这条路由宿主决定：宿主声明它要宿主哪些插槽，
 * 插件就往同名插槽挂实现。**同一个插槽不会两处都走**（见 §3 接通状态表）。
 */

import { pluginsClient, type PluginManifestSummary } from './plugins-client.js'
import { loadRendererPlugin, hasRendererEntry } from './plugin-renderer.js'
import type { JsonRecord } from './bridge.js'
import { errorMessage } from './error-message.js'

type SlotImplementation = (...args: unknown[]) => unknown
interface SlotEntry { pluginId: string; impl: SlotImplementation }

/** slotId → Array<{ pluginId: string, impl: Function }>；按注册先后排序。 */
const registry = new Map<string, SlotEntry[]>()

/** 已声明要宿主哪些插槽（供诊断；也用于过滤掉"声明了却没人宿主"的实现）。 */
const hostedSlots = new Set<string>()

/**
 * 最近一次成功读到的插件清单。
 *
 * 面板宿主解析「这块面板的 render 入口在哪个插件里」时要用**同一份数据** ——
 * 再发一次 `plugins:list` 只是白等一趟 IPC（冷启动里每一趟都算在首帧上）。
 * 清单本身随插件启停变化，所以每次激活整体覆盖，不做增量。
 */
let activeManifests: PluginManifestSummary[] = []

/** 插槽内容变化（插件启停 / 首次激活）→ 通知宿主重画。 */
const listeners = new Set<() => void>()

/** 单次激活的并发合并（多个宿主同时 boot 时只跑一次）。 */
let inflight: Promise<void> | null = null

/** manifest 里声明的渲染侧插槽（`contributes.rendererSlots`），见 `activateRendererSlots`。 */
function declaredRendererSlots(manifest: PluginManifestSummary): string[] {
  const raw = manifest && manifest.contributes && manifest.contributes.rendererSlots
  if (!Array.isArray(raw)) return []
  return raw.map((id) => String(id || '').trim()).filter(Boolean)
}

/**
 * manifest 是否**拥有这一块**面板（只有渲染面板的窗口才需要它的渲染代码）。
 *
 * ⚠ 判据从「贡献过任何面板」收紧成「贡献的正是当前这块」：
 * 一个面板进程只画一块面板（一个 `WebContentsView` 一个 `?panelId=`），
 * 过去按"声明过 panels 就加载"会把笔记 162KB / 思维导图 108KB / 验证器 82KB /
 * 扫码器 37KB …… 全部 import 进来只为了丢弃其中 4 份 —— 那是面板冷启动最大的一笔白工。
 *
 * @param {object} manifest
 * @param {string} panelId 本进程要渲染的那一块（空 = 不知道 → 退回旧口径，宁多勿漏）
 */
function ownsPanel(manifest: Record<string, unknown>, panelId: string) {
  const contributes = manifest.contributes && typeof manifest.contributes === 'object'
    ? manifest.contributes as Record<string, unknown>
    : null
  const raw = contributes?.panels
  if (!Array.isArray(raw) || !raw.length) return false
  // 宿主没报上 id 时无从判定，只能保守加载（旧行为）。
  if (!panelId) return true
  return raw.some((p) => p && typeof p === 'object' && String((p as Record<string, unknown>).id) === String(panelId))
}

/**
 * 本窗口要不要 import 这个插件的渲染模块。
 *
 * 每个渲染进程（shell / rail / 面板 / 浮层）都有自己的一张宿主清单，而插件的
 * `.renderer.js` 可能是整块面板（几百 KB 的 model + view）。过去"先全量 import、
 * 再按宿主过滤"会让浮层窗口把笔记、扫码器的面板代码全拉一遍 —— 然后丢弃并告警，
 * 既慢又制造"无人宿主"的假告警。现在按 manifest 的声明**提前筛**：
 *   · 面板窗口（`withPanels`）：只加载**画当前这块面板**的那个插件（见 `ownsPanel`）；
 *   · 任何窗口：声明了 `contributes.rendererSlots` 且与本窗口宿主相交的，加载 ——
 *     插槽是"往别人的面板上补内容"，与它自己有没有面板无关，必须照旧全收。
 * 于是"这个槽没人宿主"的告警只会是**真的**问题（插件声明了、却没有任何窗口宿主）。
 */
function wantsRendererModule(manifest: PluginManifestSummary, withPanels: boolean, panelId: string): boolean {
  if (withPanels && ownsPanel(manifest, panelId)) return true
  const slots = declaredRendererSlots(manifest)
  if (!slots.length) return false
  if (!hostedSlots.size) return true
  return slots.some((id) => hostedSlots.has(id))
}

/**
 * 声明本进程要宿主哪些插槽。
 *
 * 必须在 `activateRendererSlots()` 之前调用：激活时据此**丢弃**没人宿主的实现，
 * 避免"插件以为挂了、其实永远问不到人"的静默失效。
 * @param {string[]} ids
 */
export function defineRendererSlots(ids: string[]) {
  for (const id of ids || []) if (id) hostedSlots.add(String(id))
}

/** 当前进程宿主中的插槽 id（诊断用）。 */
export function listHostedRendererSlots() {
  return Array.from(hostedSlots)
}

/**
 * 最近一次激活时读到的插件清单（只读快照）。
 *
 * 与激活共享同一次 `plugins:list`：宿主解析面板实现时直接用这份，
 * 不再自己发一次 IPC。**调用方必须先 await 过一次 `activateRendererSlots()`**，
 * 否则拿到的是空数组（那时清单确实还没到）。
 */
export function getActiveManifests(): PluginManifestSummary[] {
  return activeManifests
}

/**
 * 某个插槽当前的全部实现（按注册先后）。
 * @param {string} slotId
 * @returns {Array<{ pluginId: string, impl: Function }>}
 */
export function listRendererSlotImpls(slotId: string) : SlotEntry[] {
  const list = registry.get(String(slotId))
  return list ? list.slice() : []
}

/**
 * SINGLE：取第一个实现的返回值；没有实现或返回空 → `fallback`。
 * 与主进程调度器的 SINGLE 同义（先注册者优先）。
 */
export function callRendererSlot<T = unknown>(slotId: string, payload: unknown, fallback: T | null = null): unknown | T {
  const list = registry.get(String(slotId))
  if (!list || !list.length) return fallback
  try {
    const out = list[0].impl(payload, { slotId, pluginId: list[0].pluginId })
    return out === undefined || out === null ? fallback : out
  } catch (e) {
    console.warn(`[renderer-slots] 插槽 ${slotId} 执行失败（已回落默认实现）:`, errorMessage(e, String(e)))
    return fallback
  }
}

/**
 * MULTI：收集每个实现的返回值（**展平一层**）。
 *
 * 展平的理由与主进程 `slot-render.js#toDescriptorList` 一致：一个实现返回数组
 * 是常态（"我贡献 3 个按钮"），而调度器的聚合语义本来就是"每个实现一个值"。
 * @returns {unknown[]}
 */
export function callRendererSlotMulti(slotId: string, payload: unknown) : unknown[] {
  const list = registry.get(String(slotId))
  if (!list || !list.length) return []
  const out: unknown[] = []
  for (const entry of list.slice()) {
    try {
      out.push(entry.impl(payload, { slotId, pluginId: entry.pluginId }))
    } catch (e) {
      // 一个坏实现不该让整列按钮消失 —— 与主进程同一条错误策略。
      console.warn(`[renderer-slots] 插槽 ${slotId} 的 ${entry.pluginId} 执行失败（已跳过）:`, errorMessage(e, String(e)))
    }
  }
  return out.flat(1).filter((v) => v !== undefined && v !== null)
}

/**
 * REDUCE：串行折叠。`acc` 初值是 `payload` 本身（与主进程一致：未声明 initialValue 时
 * 以 payload 为初值，于是"过滤一串数据"可以直接写成 `(acc) => acc.filter(...)`）。
 */
export function reduceRendererSlot<T>(slotId: string, payload: T): T {
  const list = registry.get(String(slotId))
  if (!list || !list.length) return payload
  return list.reduce((acc, entry) => {
    try {
      const next = entry.impl(acc, payload, { slotId, pluginId: entry.pluginId })
      return next === undefined || next === null ? acc : next as T
    } catch (e) {
      console.warn(`[renderer-slots] 插槽 ${slotId} 的 ${entry.pluginId} 执行失败（已跳过）:`, errorMessage(e, String(e)))
      return acc
    }
  }, payload) as T
}

/** 订阅"插槽内容已变化"（插件启停）→ 宿主据此重画。返回退订函数。 */
export function onRendererSlotsChanged(handler: () => void): () => void {
  if (typeof handler !== 'function') return () => {}
  listeners.add(handler)
  return () => listeners.delete(handler)
}

function notifyChanged() {
  for (const fn of Array.from(listeners)) {
    try { fn() } catch (e) { console.warn('[renderer-slots] 监听器执行失败:', errorMessage(e, String(e))) }
  }
}

/**
 * 激活：把**本窗口需要的**插件 `rendererPlugin.slots` 灌进本进程的注册表。
 *
 * 幂等且可重入：并发调用合并成一次；插件启停后由宿主再调一次即可（每次都整体重建，
 * 于是"禁用插件 → 它的实现消失"是天然成立的，不需要增量摘除逻辑）。
 *
 * 为什么必须在渲染侧做而不是复用主进程的登记：主进程只知道"这个插件启用了"，
 * 不知道**本进程**要不要它 —— 每个渲染进程（shell / rail / 面板 / 浮层）都跑一份
 * 自己的注册表，各自 `defineRendererSlots` 自己关心的那几个。
 *
 * @param {{ withPanels?: boolean, panelId?: string }} [options]
 *   `withPanels` = 本窗口渲染插件面板（面板进程）；`panelId` = **本进程要画的那一块**
 *   （面板宿主必须给 —— 缺了会退回"加载一切面板插件"的旧口径，见 `ownsPanel`）。
 *   其余窗口只加载与本窗口宿主插槽相交的渲染模块（见 `wantsRendererModule`）。
 */
export function activateRendererSlots(options: JsonRecord = {}): Promise<void> {
  if (inflight) return inflight
  const withPanels = options.withPanels === true
  const panelId = options.panelId ? String(options.panelId) : ''
  inflight = (async () => {
    let manifests: PluginManifestSummary[] = []
    try {
      manifests = await pluginsClient.list()
    } catch (e) {
      // 主进程还没就绪（插件后台启动）：不是错误路径，宿主下次插件变更事件会再来一次。
      return
    }
    activeManifests = manifests
    const loaded = await Promise.all(
      manifests
        .filter((m) => m && m.enabled === true && hasRendererEntry(m) && wantsRendererModule(m, withPanels, panelId))
        .map(async (m) => ({ manifest: m, mod: await loadRendererPlugin(m, panelId) }))
    )

    registry.clear()
    const unhosted = new Set<string>()
    for (const { manifest, mod } of loaded) {
      if (!mod || !mod.slots) continue
      const declared = declaredRendererSlots(manifest)
      for (const [slotId, impl] of Object.entries(mod.slots)) {
        if (typeof impl !== 'function') continue
        // manifest 没声明 → 别的窗口（非面板窗口）根本不会加载它，插件作者会以为"我挂了"。
        // 在这里点名，比让他猜为什么某个窗口里不生效好。
        if (!declared.includes(slotId)) {
          console.warn(`[renderer-slots] ${mod.pluginId} 的渲染模块导出了插槽 ${slotId}，但 manifest 未声明 contributes.rendererSlots —— 非面板窗口不会加载它`)
        }
        // 没有宿主声明这一槽 → 收下但告警：静默丢弃会让插件作者完全无从查起。
        if (hostedSlots.size && !hostedSlots.has(slotId)) { unhosted.add(slotId); continue }
        const entries = registry.get(slotId) || []
        entries.push({ pluginId: mod.pluginId, impl })
        registry.set(slotId, entries)
      }
    }
    if (unhosted.size) {
      console.warn(`[renderer-slots] 以下插槽的实现无人宿主，已忽略：${Array.from(unhosted).join(', ')}（宿主需先 defineRendererSlots）`)
    }
    notifyChanged()
  })().finally(() => { inflight = null })
  return inflight
}



