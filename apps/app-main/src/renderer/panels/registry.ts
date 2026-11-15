/**
 * panels/registry.js —— 面板实现的**约定式发现**（零依赖）。
 *
 * 这一份只做"名字 ↔ 模块"的解析，不认识 IPC、不认识 UI 库、不认识宿主：
 * 于是它既能被薄引导在**第一帧之前**静态引入（只是查表 + 起一次 import），
 * 也能被宿主在稍后复用。拆出来的理由就是**首帧时序** ——
 * 面板视图关闭即销毁，每开一次都要重新付一次模块求值成本。
 *
 * 约定：任何 `ui/ui-panel-<name>/src/index.ts`（插件包仍可用 `.js`）都是面板 UI 包，导出 `panelDefinition`
 * （`{ id, injectStyles?, mount(doc, ctx) }`）。`id` 必须等于插件 manifest 里
 * `contributes.panels[].id` —— 两者是同一块面板的「UI 侧」与「声明侧」。
 *
 * 用 glob 而不是静态 import 表：静态表意味着每加一个面板都要回来改这一行，
 * 那就还是"编译期装配"。glob 让目录结构本身成为注册表。
 *
 * ⚠ **只 import 当前这一块**（本进程一个 `?panelId=` 只画一块面板）。
 * 旧实现把 glob 里**全部**面板都 import 一遍再建索引：每开一次面板 = 加载
 * ~818KB 面板代码（含书签树 / 标签列表宿主等重模块），只为了拿到其中一个
 * `panelDefinition`。面板视图"关闭即销毁"，所以这不是一次性开销，而是**每开一次付一次**。
 * 现在按 id 直接命中一个键（见 `panelModuleKeys`），命中不了才退回全量索引。
 */

import type { PanelDefinition } from '../shared/panel-definition.js'

interface PanelModule { panelDefinition?: PanelDefinition | null }

const PANEL_MODULES = import.meta.glob<PanelModule>('../../../../../ui/ui-panel-*/src/index.{js,ts}')

/**
 * 面板 id → ui 包名 的**兜底别名**（只登记"名字对不上"的那几条）。
 *
 * 命名约定是 `ui-panel-<name>` ↔ `<name>-panel`（连字符可有可无：
 * `open-tabs-panel` ↔ `opentabs`）。绝大多数面板都自动命中，只有这里列出的例外
 * 需要人工牵线 —— 它只是**加速用的提示**，不是注册表：glob 仍然是唯一事实源，
 * 提示错了/漏了只会让那一条走全量索引（慢一点，但结果仍正确）。
 */
const PANEL_MODULE_ALIASES: Record<string, string> = { 'spaces-panel': 'profiles' }

/** 归一化名字：去连字符、统一小写（`open-tabs` → `opentabs`）。 */
function normalizeName(value: unknown): string {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 该面板 id 可能对应的 glob 键（正常 1 个；对不上 → 空数组 → 走全量索引）。
 *
 * **纯字符串运算，不 import 任何模块** —— 键表是构建期常量，读它就是查表。
 * 薄引导靠它决定"要不要提前开拉实现"（插件自带 render 的面板没有 ui 包，
 * 预取会白跑一趟全量索引）。
 *
 * @param {string} panelId
 * @returns {string[]}
 */
export function panelModuleKeys(panelId: string) : string[] {
  // 自有属性判定：panelId 来自 URL，直接下标取 `__proto__` 会拿到原型对象，
  // 随后 normalizeName 得到一段无意义的名字、白白走一趟全量索引。
  const alias = Object.prototype.hasOwnProperty.call(PANEL_MODULE_ALIASES, panelId)
    ? PANEL_MODULE_ALIASES[panelId]
    : null
  const target = normalizeName(alias || String(panelId).replace(/-panel$/i, ''))
  if (!target) return []
  const keys: string[] = []
  for (const key of Object.keys(PANEL_MODULES)) {
    const m = /ui-panel-([^/]+)\//.exec(key)
    if (m && normalizeName(m[1]) === target) keys.push(key)
  }
  return keys
}

/**
 * **全量**索引：只作为「id 与包名对不上」时的兜底，不再出现在正常路径上。
 *
 * 保留它的唯一理由是正确性 —— 命名约定之外的 ui 包（第三方 / 未来改名）仍要能打开，
 * 而"打不开"比"慢一点"糟得多。正常路径见 `loadPanelDefinitionById`。
 */
let panelIndexPromise: Promise<Map<string, PanelDefinition>> | null = null
export function loadFullPanelIndex(): Promise<Map<string, PanelDefinition>> {
  if (!panelIndexPromise) {
    panelIndexPromise = Promise.all(
      Object.values(PANEL_MODULES).map(async (load) => {
        try {
          const mod = await load()
          return mod && mod.panelDefinition ? mod.panelDefinition : null
        } catch (e) {
          console.error('[panels] panel module failed to load:', e)
          return null
        }
      })
    ).then((defs) => {
      const index = new Map<string, PanelDefinition>()
      for (const def of defs) {
        if (!def || !def.id) continue
        if (index.has(def.id)) console.warn(`[panels] duplicate panel id: ${def.id}`)
        index.set(def.id, def)
      }
      return index
    })
  }
  return panelIndexPromise
}

/**
 * 取**这一块**面板的 `panelDefinition`：先按约定直取单个模块，取不到才全量扫描。
 *
 * 为什么值得这么写：面板进程**关闭即销毁**，所以每次点开都是一次冷启动，
 * 全量索引等于每次都把十几个面板包（含它们各自的重依赖）编译一遍。
 * 直取时通常只落地 1 个 chunk —— 冷启动路径上省掉的是**每一次**，不是第一次。
 *
 * @param {string} panelId
 * @returns {Promise<object|null>}
 */
export async function loadPanelDefinitionById(panelId: string) : Promise<PanelDefinition|null> {
  for (const key of panelModuleKeys(panelId)) {
    try {
      const mod = await PANEL_MODULES[key]()
      const def = mod && mod.panelDefinition
      if (def && def.id === panelId) return def
    } catch (e) {
      console.error('[panels] panel module failed to load:', key, e)
    }
  }
  const index = await loadFullPanelIndex()
  return index.get(panelId) || null
}
