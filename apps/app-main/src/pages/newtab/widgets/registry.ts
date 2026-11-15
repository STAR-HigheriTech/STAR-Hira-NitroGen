/**
 * 新标签页 · 小组件注册中心（插件化的那个"插口"）
 *
 * 一个组件 = 一份纯数据声明（id / 名称 / 默认尺寸 / 设置项 schema / create 工厂）。
 * 注册中心不认识任何具体组件，只做登记与查询；board 只认注册中心，不认具体组件。
 *
 * 于是「加一个新组件」= 新增一个 `defs/<name>.js`，在 newtab.js 的组件清单里加一行 import。
 * 三方无需任何一处改动，也不会互相耦合。
 *
 * create(ctx) 契约（组件作者只需实现这一个函数）：
 *   @param {WidgetContext} ctx
 *   @returns {{ destroy?: () => void } | void}
 *
 *   ctx.root       HTMLElement  组件的内容宿主（已按网格定位好；样式自己写）
 *   ctx.config     只读配置快照（已与 schema 默认值合并）
 *   ctx.setConfig  (patch) => void  改配置 → 由 board 统一下发（会重建本组件）
 *   ctx.instance   { i, widget }    本实例身份
 *   ctx.size       { w, h }         当前网格尺寸（供组件自适应）
 *   ctx.isEditing  () => boolean    是否处于自定义摆放模式
 *   ctx.openUrl    (url) => void    打开链接（内部页 → nav:go，兜底 window.open）
 *
 * 约定：组件**不碰 localStorage、不碰看板结构**。它只画自己那一块。
 */

import { appearanceKeysOf, appearanceOf } from './appearance.js'
import type {
  WidgetConfig,
  WidgetDefinition,
  WidgetDefinitionInput,
  WidgetSetting
} from './types.js'

export type { WidgetDefinition, WidgetDefinitionInput, WidgetSetting } from './types.js'

const registry = new Map<string, WidgetDefinition>()

/** 组件没声明尺寸时的兜底（按主断点 16 列给：约占四成宽、三行高）。 */
const FALLBACK_SIZE = { w: 6, h: 3 }

/**
 * 注册一个组件。
 */
export function defineWidget(def: WidgetDefinitionInput): WidgetDefinition {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error('defineWidget: 缺少 id')
  if (typeof def.create !== 'function') throw new Error(`defineWidget(${def.id}): 缺少 create()`)
  if (registry.has(def.id)) throw new Error(`defineWidget(${def.id}): 重复注册`)

  const own: WidgetSetting[] = Array.isArray(def.settings) ? def.settings : []
  // 通用外观项由板层统一提供（见 appearance.js）。组件若也声明同名键，
  // 两个 schema 会互相覆盖、值还会串到别的组件上 —— 这是注册期就该拦下的错误。
  const appearanceKeys = appearanceKeysOf(def)
  for (const s of own) {
    if (appearanceKeys.includes(s.key)) {
      throw new Error(`defineWidget(${def.id}): 设置项 "${s.key}" 是通用外观项，由板层统一提供，组件不要再声明`)
    }
  }

  const normalized: WidgetDefinition = {
    ...def,
    id: def.id,
    name: def.name,
    description: '',
    unique: false,
    hidden: false,
    removable: true,
    shape: def.shape === 'capsule' ? 'capsule' : '',
    defaultSize: { ...FALLBACK_SIZE },
    appearance: def.appearance,
    create: def.create,
    minSize: { w: 2, h: 1, ...(def.minSize || {}) },
    maxSize: { w: 16, h: 8, ...(def.maxSize || {}) },
    // 组件自带的设置项在前，通用外观在后 —— 于是每个组件天然都有这几个调节，
    // 不必各自声明，也不可能漏；范围/默认值由组件用自己的 `appearance` 收窄。
    settings: [...own, ...appearanceOf(def)]
  }
  // 默认尺寸必须先过一遍 min/max，否则一个手滑的声明会让新组件一放上去就被裁
  normalized.defaultSize = {
    w: clamp(normalized.defaultSize.w, normalized.minSize.w, normalized.maxSize.w),
    h: clamp(normalized.defaultSize.h, normalized.minSize.h, normalized.maxSize.h)
  }
  registry.set(normalized.id, normalized)
  return normalized
}

function clamp(v: number, lo: number, hi: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

export function getWidget(id: string): WidgetDefinition | null {
  return registry.get(id) || null
}

/** 注册表快照（选择器/设置项按此渲染，顺序 = 注册顺序）。 */
export function listWidgets() {
  return Array.from(registry.values()) as WidgetDefinition[]
}

/**
 * 配置 schema → 实际配置值（补默认值、丢 schema 里没有的键、把范围项夹进合法区间）。
 * 统一在这里做，组件拿到的 config 永远是"完整且合法"的。
 *
 * `default` 允许是函数：默认值可能依赖"注册中心里现在有什么"
 * （例如新闻组件的默认源 = 第一个已注册的源）。写成函数就与 import 顺序无关 ——
 * 否则组件模块必须先于新闻源模块被求值，那是一条看不见的隐式约束。
 *
 * 数值项一律**按 schema 夹取**：范围是老数据最容易失效的地方 ——
 * 组件把自己的档放宽 / 收紧之后（如时间卡底色下限 35 → 0），存下来的值
 * 不会自己变，于是"面板显示 X、实际按 Y 画"。夹一次就永久对齐。
 *
 * `staleDefault`：这一项的**旧默认值**。本项目的 configs 在实例创建时就把 schema 的
 * 全部默认值落库了，所以"用户从没动过"和"用户就是设成了这个值"在数据上无法区分 ——
 * 声明旧默认值后，存着它的实例被当作**从没动过**，直接吃新默认值。
 * 不这么做，改默认值只对新实例生效，既有卡片纹丝不动（观感：改了没反应）。
 */
export function resolveConfig(
  def: WidgetDefinition,
  saved?: WidgetConfig | null
): WidgetConfig {
  const cfg: WidgetConfig = {}
  const input = saved && typeof saved === 'object' ? saved : {}
  for (const s of def.settings) {
    const has = input[s.key] !== undefined && input[s.key] !== null
    const raw = has ? input[s.key] : settingDefault(s)
    // 存着"旧默认值" = 从没动过 ⇒ 换成新默认值（用户设过的其它值分毫不动）
    const stale = s.staleDefault !== undefined && Number(raw) === Number(s.staleDefault)
    const value = stale ? settingDefault(s) : raw
    cfg[s.key] = s.type === 'range' ? clampRange(value, s) : value
  }
  return cfg
}

function settingDefault(s: WidgetSetting): unknown {
  return typeof s.default === 'function' ? s.default() : s.default
}

/** range 项夹进 [min, max]；非数字则退回默认值（或 min）。 */
function clampRange(v: unknown, s: WidgetSetting): number {
  const lo = typeof s.min === 'number' && Number.isFinite(s.min) ? s.min : 0
  const hi = typeof s.max === 'number' && Number.isFinite(s.max) ? s.max : 100
  const n = Number(v)
  if (!Number.isFinite(n)) {
    const d = Number(settingDefault(s))
    return Number.isFinite(d) ? Math.max(lo, Math.min(hi, d)) : lo
  }
  return Math.max(lo, Math.min(hi, n))
}
