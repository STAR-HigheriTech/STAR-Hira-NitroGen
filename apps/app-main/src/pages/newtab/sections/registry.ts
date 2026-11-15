/**
 * 分区注册中心。
 *
 * "分区" = 起始页上的一个页面（首页 / 推广 / 新闻），顶部小选项卡负责切换。
 * 与 widgets/registry.js **同构**：模块自己 defineSection 自注册，
 * 页面只在清单里 import 一行。「再加一个分区」不用改切换器、不用改外壳。
 *
 * 分区与组件的区别：组件是**用户能摆的格子**（有尺寸、位置、配置）；
 * 分区是**页面本身**（整屏，用户不可编排）。所以两套注册中心 + 两套 store。
 *
 * mount(ctx) 契约：
 *   ctx.root       HTMLElement   本分区的内容宿主（已铺满内容区）
 *   ctx.openUrl    (url)=>void   打开链接（内部页 → nav:go，兜底 window.open）
 *   ctx.isActive   ()=>boolean   本分区当前是否激活
 *   ctx.tabbar.addAction(spec)   往**顶部选项卡栏最右侧**挂一个动作项
 *                 （不是分区：点了不切页，只借用选项卡栏的位置与样式，见 switcher.js）
 *
 * 分区**不认识选项卡栏/外壳的 DOM** —— 要往外壳上放东西一律走 ctx，
 * 于是"布局长什么样"只归外壳管，分区只声明"我要一个动作项"。
 */

import type {
  DeclaredSection,
  SectionDefinitionInput
} from './types.js'

export type {
  DeclaredSection,
  SectionAction,
  SectionContext,
  SectionDefinition,
  SectionDefinitionInput,
  SectionLifecycle,
  SectionTabbar
} from './types.js'

const sections = new Map<string, DeclaredSection>()

/**
 * 登记一个**懒加载分区**：只给选项卡要用的元数据，代码等首次切过去才下载。
 *
 * 为什么需要它：起始页每次开新标签都是新的渲染进程，三个分区全静态 import
 * 等于"永远用不到的两个分区也要下载 + 解析"。清单（`newtab.js`）只声明
 * 「id / 名字 / 去哪取模块」，真正的 `mount()` 仍由分区模块自己 defineSection 注册 ——
 * 于是仍然只有**一份**分区定义，这里不复制任何分区内容。
 *
 */
export function declareSection(def: { id: string; name: string; description?: string; load: () => Promise<unknown> }): string {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error('declareSection: 缺少 id')
  if (typeof def.load !== 'function') throw new Error(`declareSection(${def.id}): 缺少 load()`)
  if (sections.has(def.id)) throw new Error(`declareSection(${def.id}): 重复登记`)
  sections.set(def.id, {
    id: def.id,
    name: def.name || def.id,
    description: def.description || '',
    load: def.load,
    mount: null
  })
  return def.id
}

/**
 * 把懒加载分区变成"可挂载"的分区；已经注册过的直接返回（幂等）。
 * @param {string} id
 */
export async function ensureSection(id: string): Promise<DeclaredSection | null> {
  const def = sections.get(id)
  if (!def) return null
  if (typeof def.mount === 'function') return def
  if (typeof def.load === 'function') await def.load()
  return sections.get(id) || null
}

/**
 */
export function defineSection(def: SectionDefinitionInput): string {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error('defineSection: 缺少 id')
  if (typeof def.mount !== 'function') throw new Error(`defineSection(${def.id}): 缺少 mount()`)
  const existing = sections.get(def.id)
  if (existing && typeof existing.mount === 'function') {
    throw new Error(`defineSection(${def.id}): 重复注册`)
  }
  // 懒加载占位（declareSection）就地升级：`Map.set` 保序 → 选项卡顺序不变。
  sections.set(def.id, {
    id: def.id,
    name: def.name,
    description: def.description || '',
    load: existing?.load,
    mount: def.mount
  })
  return def.id
}

export function getSection(id: string): DeclaredSection | null {
  return sections.get(id) || null
}

/** 注册顺序 = 选项卡顺序。 */
export function listSections() {
  return Array.from(sections.values()) as DeclaredSection[]
}
