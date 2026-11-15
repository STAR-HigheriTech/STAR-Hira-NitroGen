/**
 * page-inject —— 「网页注入」的**唯一纯规则**（零依赖、无 IO、不 require electron）。
 *
 * 一条通道服务三件事（J10 的"三合一"关键）：
 *   · **Boosts** —— 每站点自定义 CSS（隐藏元素、换配色…）
 *   · **强制深色** —— 站点没做深色时给它套一层
 *   · **UserScripts** —— 每站点一小段 JS
 * 三者都是"某站点加载完成后，往这一页加一点东西"，差异只在**载荷**，
 * 所以规则模型、匹配、载荷拼装全部收在这一份里；
 * 真正"往页面上加"（`insertCSS` / `executeJavaScript`）是 infra 的哑通道（见 infra-window/page-inject.js）。
 *
 * 规则形状（一条 = 一个站点）：
 *   { id, host, enabled, forceDark: 'on'|'off'|null, css, js }
 *   · forceDark `on`/`off` 是**按站点**覆盖全局开关；null = 跟随全局
 *
 * 存储形态：设置项 `webview.inject_rules`（JSON 字符串）——先不建新表，
 * 规则数量级是"几十条"，且天然随 profile 走（设置本就按 profile 隔离）。
 */

import { siteKeyOf } from './url-protocols.js'

/**
 * 设置键名真源：主进程注入运行时、域层默认值、设置页下拉 / 注入面板共用。
 * 任何一个字抄错都表现为「设置页能改、页面没反应」的静默失效。
 */
export const PAGE_INJECT_SETTING_KEYS = Object.freeze({
  forceDark: 'webview.force_dark',
  rules: 'webview.inject_rules',
  /** 注入编辑器上次打开的站点（面板 → 独立窗口的交接键）。 */
  editorHost: 'webview.inject_editor_host'
})

/** 全局强制深色的两态（按站点覆盖也用同一对取值，见规则形状）。 */
export const FORCE_DARK_MODES = Object.freeze(['off', 'on'])
export const DEFAULT_FORCE_DARK = 'off'
export const FORCE_DARK_OPTIONS = Object.freeze([
  ['off', '关闭'],
  ['on', '始终强制']
])

/**
 * **按站点**覆盖的下拉选项：`''` = 不覆盖（跟随全局），其余取值同 `FORCE_DARK_MODES`。
 * 面板与独立编辑器窗口共用这一份，避免两处各抄一遍"跟随全局 / 强开 / 强关"。
 */
export const SITE_FORCE_DARK_OPTIONS = Object.freeze([
  ['', '深色：跟随全局'],
  ['on', '深色：强开'],
  ['off', '深色：强关']
])

/** 「强制深色」预设样式表：智能反色（媒体再反一次还原）。 */
export const FORCE_DARK_CSS = `
html { background:#121212 !important; }
html { filter: invert(0.92) hue-rotate(180deg) !important; }
img, video, picture, canvas, svg image, iframe, embed, object,
[style*="background-image"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
`.trim()

/**
 * 归一化一条规则；非法（没有 host）返回 null。
 * @param {any} input
 * @returns {{ id: string, host: string, enabled: boolean, forceDark: 'on'|'off'|null, css: string, js: string }|null}
 */
export interface InjectRule {
  id: string
  host: string
  enabled: boolean
  forceDark: 'on' | 'off' | null
  css: string
  js: string
}

export function normalizeInjectRule(input: unknown): InjectRule | null {
  if (!input || typeof input !== 'object') return null
  const source = input as Record<string, unknown>
  const host = siteKeyOf(source.host) || siteKeyOf(source.url) || String(source.host || '').trim().toLowerCase()
  if (!host) return null
  const forceDark = typeof source.forceDark === 'string' && (FORCE_DARK_MODES as readonly string[]).includes(source.forceDark)
    ? source.forceDark as 'on' | 'off'
    : null
  return {
    id: String(source.id || host),
    host,
    enabled: source.enabled !== false,
    forceDark,
    css: typeof source.css === 'string' ? source.css : '',
    js: typeof source.js === 'string' ? source.js : ''
  }
}

/**
 * 解析设置里的 JSON 串 → 规则数组（任何异常都退化为空数组，绝不抛）。
 * @param {unknown} raw
 * @returns {Array<{id:string,host:string,enabled:boolean,forceDark:'on'|'off'|null,css:string,js:string}>}
 */
export function parseInjectRules(raw: unknown): InjectRule[] {
  if (!raw) return []
  let list = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch (_) {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return list.map(normalizeInjectRule).filter((rule): rule is InjectRule => rule !== null)
}

/**
 * 规则数组 → 设置用的 JSON 串。空数组序列化为空串（保持"没有规则"与"默认值"一致）。
 * @param {any[]} rules
 * @returns {string}
 */
export function serializeInjectRules(rules: readonly unknown[] | null | undefined): string {
  const list = (Array.isArray(rules) ? rules : []).map(normalizeInjectRule).filter((rule): rule is InjectRule => rule !== null)
  if (list.length === 0) return ''
  return JSON.stringify(list)
}

/**
 * 为某个站点**新建**一条空规则；已存在同站点规则则原样返回它。
 *
 * 面板里的「＋ 为当前站点新建规则」与后续任何"从站点快捷建规则"的入口共用这一处 ——
 * host 归一、去重、默认值三者只能有一份实现，否则两处迟早给出不同结果
 * （例如一处按 `www.` 去重、另一处不去重，就会出现两条同站规则互相打架）。
 *
 * @param {any[]} rules 现有规则（任意形态，内部会归一）
 * @param {string} hostOrUrl 站点 host 或完整 URL
 * @returns {{ rules: any[], rule: any|null, created: boolean }}
 */
export function upsertRuleForHost(rules: readonly unknown[] | null | undefined, hostOrUrl: string) : { rules: InjectRule[], rule: InjectRule|null, created: boolean } {
  const list = (Array.isArray(rules) ? rules : []).map(normalizeInjectRule).filter((rule): rule is InjectRule => rule !== null)
  const created = normalizeInjectRule({ host: hostOrUrl })
  if (!created) return { rules: list, rule: null, created: false }
  const existing = list.find((r) => r.host === created.host)
  if (existing) return { rules: list, rule: existing, created: false }
  return { rules: list.concat(created), rule: created, created: true }
}

/**
 * 解析某个 URL 该注入什么 —— **三合一的汇合点**。
 *
 * @param {{ rules?: any[], url?: string, globalForceDark?: boolean }} input
 * @returns {{ css: string, js: string }}
 *   `css` = 强制深色样式表（需要时） + 该站点的自定义 CSS；`js` = 该站点的用户脚本。
 *   都没有时返回空载荷，调用方据此**跳过注入**（不做无谓的 insertCSS 往返）。
 */
export function resolveInjection(input: { rules?: readonly unknown[]; url?: string; globalForceDark?: boolean } = {}) : { css: string, js: string } {
  const url = String(input.url || '')
  const host = siteKeyOf(url)
  const rule = host ? parseInjectRules(input.rules).find((r) => r.enabled && r.host === host) : null
  // 优先级：**站点显式覆盖** > 全局开关。
  const forceDark = rule && rule.forceDark ? rule.forceDark === 'on' : input.globalForceDark === true

  const parts = []
  if (forceDark) parts.push(FORCE_DARK_CSS)
  if (rule && rule.css) parts.push(rule.css)
  return {
    css: parts.join('\n'),
    js: rule && rule.js ? rule.js : ''
  }
}
