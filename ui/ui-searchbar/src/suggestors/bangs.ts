// @ts-check
/**
 * Bangs suggestor：DuckDuckGo 风格 `!bang` 快捷入口。
 *
 * 三条输入形态（对齐 RT / Hira 的手感）：
 *   · `!`            → **列出全部** bangs（快捷动作在前、搜索引擎在后）；
 *   · `!<片段>`      → 前缀匹配的候选（`!bl` → 哔哩哔哩，`!bil` 也认别名）；
 *   · `!<片段> 关键词` → 直接给「用这个引擎搜索」那一条（回车即走）。
 *
 * 「快捷」= 两类**动作**，都复用现成的执行链，本文件不新造动作命名空间：
 *   · 内部页 / 浏览器操作 → 命令表（`COMMANDS`）的 id，走 `omnibox:action`；
 *   · 面板（插件目录）    → `panel:<id>`，由主进程转交宿主打开侧栏面板。
 *
 * 本文件**只剩一层壳**：bang 表、命令表、解析算法都在
 * `packages/shared-types/src/commands.mjs`（与命令表同一份真源）。
 * 除了内置表，还认**内置搜索引擎**（`!google` 这类）与**用户自定义 Bang** ——
 * 引擎表由编排层经 `ctx.getEngines()` 注入，自定义 Bang 经 `ctx.getCustomBangs()` 注入，
 * 面板目录经 `ctx.getPanels()` 注入（面板是插件，集合随启停变化，故必须是活引用）。
 * 自定义搜索引擎**不参与** `!` 解析：引擎不是 bang，只服务「默认搜索引擎」下拉。
 */

import { buildSearchUrl } from '@hira-ng/shared-types/src/search-url.mjs'
import {
  COMMANDS,
  matchBangs,
  matchCommands,
  matchCustomBangs,
  parseBangQuery,
  resolveBangEngine
} from '@hira-ng/shared-types/src/commands.mjs'

import type { CustomBangInfo, PanelInfo, SearchSuggestion, SuggestorContext, Suggestion } from '../types'
export { parseBangQuery }

/**
 * 量纲（与其它 suggestor 同处 0~700 这一档，见 core/ranking.ts 的合并排序）：
 *   快捷动作 620+ > 搜索 bang 540 > verbatim 501/502。
 * 刻意**低于** open-tab（780+）：输入 `!` 时"回到已打开的那一页"仍该排在最前。
 */
const QUICK_RELEVANCE = 620
const ENGINE_RELEVANCE = 540
/** `!` 单字符列全部时的上限 —— 卡片可滚动，给足；但不设上限会让每次输入都渲染上百行。 */
const ALL_LIMIT = 80
/** `!` 列全部时自定义 Bang 的上限：用户自己的入口应当排在内置搜索引擎之前。 */
const CUSTOM_ALL_LIMIT = 40
/** `!<片段>` 时候选的条数上限。 */
const FRAGMENT_LIMIT = 12

/**
 * 片段是否命中某个面板（id 前缀 / 标题子串）。
 * @param {string} fragment
 * @param {string} id
 * @param {string} title
 */
function matchesFragment(fragment: string, id: string, title: string): boolean {
  if (!fragment) return true
  const f = fragment.toLowerCase()
  return id.toLowerCase().startsWith(f) || title.toLowerCase().includes(f)
}

/** 面板目录（活引用；拿不到就当没有 —— 面板是插件，缺了不该让整个 bangs 失效）。 */
function panelsOf(ctx: SuggestorContext): PanelInfo[] {
  try {
    const list = typeof ctx.getPanels === 'function' ? ctx.getPanels() : null
    return Array.isArray(list) ? list : []
  } catch (_) {
    return []
  }
}

/**
 * 用户自定义 Bang（活引用；拿不到就当没有 —— 它只是用户数据，不该让内置 bangs 失效）。
 * 内置表在 shared-types，自定义在 SQLite（按 profile 分区），两者生命周期不同，
 * 但解析口径统一收在 `resolveBangEngine` / `matchCustomBangs`。
 */
function customBangsOf(ctx: SuggestorContext): CustomBangInfo[] {
  try {
    const list = typeof ctx.getCustomBangs === 'function' ? ctx.getCustomBangs() : null
    return Array.isArray(list) ? list : []
  } catch (_) {
    return []
  }
}

/** 触发词归一（与 domain / shared-types 同口径：小写 + 去空白）。 */
function normalizeTrigger(raw: unknown): string {
  return String(raw == null ? '' : raw).toLowerCase().replace(/\s+/g, '')
}

/**
 * 面板候选是否被这个片段命中 —— 看 id / 标题，也看**别名**（`bangs`）。
 *
 * 别名存在的理由：面板标题会改（笔记 → 集锦），而用户的肌肉记忆与旧文档里是「笔记」。
 * 复用 matchesFragment 那条「id 前缀」规则（别名与 id 同为"键"，不做标题那种子串匹配）——
 * 片段为空时 matchesFragment 恒真，语义（空 = 全部命中）不变。
 * @param {string} fragment 已小写的片段
 * @param {PanelInfo} panel
 */
function matchesPanel(fragment: string, id: string, title: string, panel: PanelInfo): boolean {
  if (matchesFragment(fragment, id, title)) return true
  const bangs = Array.isArray(panel.bangs) ? panel.bangs.map(String) : []
  return bangs.some((b) => String(b).toLowerCase().startsWith(fragment))
}

/** 「打开面板」候选（`panel:<id>`，执行侧由主进程转交宿主）。 */
function panelSuggestions(ctx: SuggestorContext, fragment: string): Suggestion[] {
  const out: Suggestion[] = []
  for (const p of panelsOf(ctx)) {
    const id = String((p && p.id) || '')
    if (!id) continue
    const title = String((p && p.title) || id)
    if (!matchesPanel(fragment, id, title, p)) continue
    out.push({
      type: 'pedal',
      action: `panel:${id}`,
      title,
      relevance: QUICK_RELEVANCE,
      source: 'panel'
    })
  }
  return out
}

/** 命令候选（内部页 / 浏览器操作；命中档位由 matchCommands 给出）。 */
function commandSuggestions(fragment: string, limit = 6): Suggestion[] {
  return matchCommands(fragment, limit).map((c) => ({
    type: /** @type {'pedal'} */ (('pedal') as 'pedal'),
    action: c.id,
    title: c.title,
    relevance: c.relevance,
    source: 'pedal'
  }))
}

/** 「用某引擎搜索」这一条。`meta` 携带自定义条目信息（记使用次数 / 样式区分）。 */
function engineSuggestion(
  name: string,
  template: string,
  keyword: string,
  fragment: string,
  meta: { custom?: boolean; id?: string } | null
): SearchSuggestion {
  const s: SearchSuggestion = {
    type: 'search',
    query: keyword ? `${name}: ${keyword}` : `在 ${name} 中搜索`,
    url: buildSearchUrl(template, keyword),
    relevance: QUICK_RELEVANCE + 20,
    source: meta && meta.custom ? `custom-bang:${fragment}` : `bang:${fragment}`
  }
  if (meta && meta.custom) {
    s.custom = true
    if (meta.id) s.bangId = meta.id
  }
  return s
}

/** 「用某个 bang 搜索」这一条（来自表里的条目，不是用户配置引擎）。 */
function bangEntrySuggestion(entry: { title: string; url: string; t: string; custom?: boolean; id?: string }, keyword: string): SearchSuggestion {
  const s: SearchSuggestion = {
    type: 'search',
    query: keyword ? `${entry.title}: ${keyword}` : `在 ${entry.title} 中搜索`,
    url: buildSearchUrl(entry.url, keyword),
    relevance: ENGINE_RELEVANCE,
    source: entry.custom ? `custom-bang:${entry.t}` : `bang:${entry.t}`
  }
  if (entry.custom) {
    s.custom = true
    if (entry.id) s.bangId = entry.id
  }
  return s
}

/**
 * 只输入 `!`：列出**全部** bangs —— 快捷动作在前（面板 + 命令），搜索引擎在后。
 *
 * 为什么快捷项必须靠前：用户敲 `!` 的意图多半是"干点什么"（开设置 / 开面板 / 后退），
 * 而不是"挑一个搜索引擎"；后者的候选多且长，排在后面才不会把前者挤出首屏。
 */
function listAll(ctx: SuggestorContext): Suggestion[] {
  const out: Suggestion[] = []
  // 1) 面板（插件目录，顺序即 rail 上的顺序）—— 排在最前，它就是"干点什么"里最常用的一档。
  out.push(...panelSuggestions(ctx, ''))
  // 2) 命令表全部（内部页 + 浏览器操作）；面板条数不同也要保证它们紧随面板之后。
  COMMANDS.forEach((c, i) => {
    out.push({
      type: /** @type {'pedal'} */ (('pedal') as 'pedal'),
      action: c.id,
      title: c.title,
      relevance: QUICK_RELEVANCE - i,
      source: 'pedal'
    })
  })
  // 3) 用户自定义 Bang —— 排在内置搜索引擎之前：这是"我自己定义的入口"，
  //    比"内置站点列表"更接近当前用户的意图。`showSuggestions:false` 的条目
  //    不会出现在这里（只保留回车直搜能力）。
  for (const entry of matchCustomBangs('', customBangsOf(ctx), CUSTOM_ALL_LIMIT)) {
    out.push(bangEntrySuggestion(entry, ''))
  }
  // 4) 内置搜索引擎（表顺序 = 内置表的声明顺序，稳定可预期）。
  for (const entry of matchBangs('', ALL_LIMIT)) {
    out.push(bangEntrySuggestion(entry, ''))
  }
  return out
}

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {import('../types').Suggestion[]}
 */
export function bangsSuggestor(ctx: SuggestorContext): Suggestion[] {
  const q = String(ctx.query || '').trim()
  if (!q.startsWith('!')) return []

  // `!` 之后、第一个空白之前 = bang 片段；其后 = 关键词。
  const rest = q.slice(1)
  const spaceIdx = rest.search(/\s/)
  const fragment = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase()
  const keyword = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim()

  // ① 只输入 `!` → 全部 bangs。
  if (!fragment) return listAll(ctx)

  let engines
  try { engines = typeof ctx.getEngines === 'function' ? ctx.getEngines() : undefined } catch (_) { engines = undefined }
  const customs = customBangsOf(ctx)

  // ② 片段精确命中内置表 / 用户配置引擎 / 自定义 bang → 直接给"用它搜索"那一条
  //    （有具体关键词时仅此一条，回车语义绝对确定）。
  //    自定义条目的 `showSuggestions` **只控制"被发现"**（`!` 列表与片段浏览），
  //    不控制"我已经把触发词打全了"：否则 `!secret foo` 会落到 verbatim 的默认搜索上，
  //    用户以为自己定义的快捷搜索坏了。精确命中 + 有关键词 → 永远给这一条。
  const engine = resolveBangEngine(fragment, engines ?? {}, customs)
  if (engine && keyword) {
    return [engineSuggestion(engine.name, engine.template, keyword, fragment, engine.custom ? engine : null)]
  }

  const out: Suggestion[] = []
  if (engine) {
    const matchedCustom = engine.custom
      ? customs.find((e) => normalizeTrigger(e.trigger) === fragment) || null
      : null
    // 用户主动隐藏的自定义条目：仅在"打全触发词"时保留一条（此时无关键词 = 点一下看它怎么搜）。
    const hidden = matchedCustom && matchedCustom.showSuggestions === false
    if (!hidden) out.push(engineSuggestion(engine.name, engine.template, '', fragment, engine.custom ? engine : null))
  }
  // ③ 快捷动作（面板 / 命令）—— 「快捷为首先」，排在所有搜索候选之前。
  out.push(...panelSuggestions(ctx, fragment))
  out.push(...commandSuggestions(fragment))
  // ④ 其余前缀/标题命中的自定义 bang（用户自己的入口优先于内置站点）。
  for (const entry of matchCustomBangs(fragment, customs, FRAGMENT_LIMIT)) {
    if (engine && engine.custom && normalizeTrigger(entry.t) === fragment) continue // 已由 ② 覆盖
    out.push(bangEntrySuggestion(entry, keyword))
  }
  // ⑤ 其余前缀/别名命中的内置搜索引擎。
  for (const entry of matchBangs(fragment, FRAGMENT_LIMIT)) {
    if (engine && !engine.custom && entry.t === fragment) continue // 已由 ② 那条精确引擎项覆盖
    out.push(bangEntrySuggestion(entry, keyword))
  }
  return out
}
