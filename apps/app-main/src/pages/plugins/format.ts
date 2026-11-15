// @ts-check
/**
 * 纯数据层：归纳 / 格式化 / 判定规则。
 *
 * 硬约束：**零 DOM、零 IPC、零副作用**。这里只把「主进程下发的原始清单」
 * 翻译成「界面要说的那句话 / 那个判定结果」，谁去画、画在哪儿一概不管。
 *
 * 为什么判定必须收在一处：一句话该不该说、属于哪种状态、什么颜色 —— 这些是**事实**，
 * 谁在渲染就得跟它一致。插件中心只有一个形态（内部页 hira://plugins），
 * 但只要将来多一个入口（命令面板 / 设置页摘要…）要显示状态，它拿到的判定与措辞
 * 就是**现成的这一份** —— 不可能出现两份实现各自漂移成「一个说已停用、一个说失败」。
 */

// 信任级别的名称与顺序来自共享真源（与主进程信任目录、IPC 契约同一份），
// 这里只负责中文措辞 —— 真源加一级时不会出现「界面少一项」的静默漂移。
import { PLUGIN_TRUST_LEVELS } from 'hira://shared/plugin-trust.mjs'
import type { MarketEntryRecord, MarketSourceRecord, MarketState, PluginRecord } from './types.js'

/**
 * 插件类型 → 分组标题 + 说明。
 * key 是 hira-plugin.json 的 type 字段；缺省类型（旧 manifest）落到 feature-plugin。
 */
export const TYPE_SECTIONS = [
  ['core', '核心承载体', '浏览器最小可运行集合，不可禁用'],
  ['ai-skill-plugin', 'AI 技能', '可复用的提示词 / 只读脚本 / 自动指令；由插件贡献，可逐条启停'],
  ['feature-plugin', '功能插件', '提供业务能力，可单独停用'],
  ['ui-panel-plugin', '界面面板插件', '侧栏面板等纯 UI 组件'],
  ['provider-plugin', '能力提供者', '向宿主提供搜索、同步、AI 等可替换能力'],
  ['theme-plugin', '主题', '配色 / 背景等外观主题，可停用以临时禁用其换肤'],
  ['userscript-plugin', '用户脚本', 'Tampermonkey 风格的 .user.js，按 @match 在匹配的网页上自动执行'],
  ['community-mod', '社区 Mod', '第三方插件，受沙箱与权限约束']
]

export const TYPE_ORDER: string[] = TYPE_SECTIONS.map(([key]) => key)
const TYPE_INDEX = new Map(TYPE_SECTIONS.map(([key, title, hint]) => [key, { title, hint }]))

/** 插件内部页只允许由宿主协议生成的 p-* host，拒绝任意 hira:// 地址。 */
export function isPluginPageUrl(url?: unknown): boolean {
  return /^hira:\/\/p-[^/]+\/?(?:.*)?$/i.test(String(url || ''))
}

/** 信任级别 → 中文（界面上只出现这三个词）。 */
const TRUST_LEVEL_TEXT: Record<string, string> = { official: '官方', community: '社区', local: '本地' }
export const TRUST_LEVEL_LABEL: Record<string, string> = Object.fromEntries(
  PLUGIN_TRUST_LEVELS.map((level) => [level, TRUST_LEVEL_TEXT[level]])
)

/** 可从界面导入的两级：官方级随应用分发，不接受写入（主进程 addTrustedKey 同样拒绝）。 */
export const TRUST_IMPORT_LEVELS = PLUGIN_TRUST_LEVELS.filter((level) => level !== 'official')

/** 一条插件的分组键。未知类型保留原值，让新插件类型无需先改页面就能出现。 */
export function typeOf(plugin: unknown): string {
  const value = plugin && typeof plugin === 'object' ? (plugin as Record<string, unknown>).type : ''
  return String(value || '').trim() || 'feature-plugin'
}

/** 类型元数据。未知类型以“扩展类型 · id”展示，不静默塞进功能插件。 */
export function typeMeta(type?: unknown): { title: string; hint: string } {
  const key = String(type || 'feature-plugin')
  const hit = TYPE_INDEX.get(key)
  if (hit) return hit
  return {
    title: `扩展类型 · ${key}`,
    hint: '由插件声明的新类型，沿用同一套启停、依赖与权限模型'
  }
}

export function groupByType(plugins?: readonly PluginRecord[]): Map<string, PluginRecord[]> {
  const groups = new Map<string, PluginRecord[]>()
  for (const p of Array.isArray(plugins) ? plugins : []) {
    const type = typeOf(p)
    const group = groups.get(type)
    if (group) group.push(p)
    else groups.set(type, [p])
  }
  return groups
}

/**
 * 汇总行文案。每个计数对应一种**需要用户做不同事**的状态 —— 所以宁可长一点也要分开说：
 * 「3 个启用失败」和「3 个已自动停用」在用户那边是两条完全不同的下一步。
 *
 * @param {unknown[]} items
 * @returns {string}
 */
export function summarize(items: readonly PluginRecord[] = []) : string {
  if (!items.length) return ''
  const count = (fn: (item: PluginRecord) => unknown): number => items.filter((item) => Boolean(fn(item))).length
  const enabled = count((plugin) => plugin.enabled)
  const failed = count((plugin) => plugin.failed)
  const auto = count((plugin) => plugin.autoDisabled)
  const blocked = count((plugin) => plugin.blocked)
  const consent = count((plugin) => plugin.awaitingConsent)
  const parts = [`已发现 ${items.length} 个插件`, `${enabled} 个启用`]
  // 第三方（运行时安装）单独列：它与「内置插件有几个」回答的是不同问题
  const runtime = count((plugin) => plugin.runtime)
  if (failed) parts.push(`${failed} 个启用失败`)
  if (auto) parts.push(`${auto} 个已自动停用`)
  if (blocked) parts.push(`${blocked} 个前置未就绪`)
  if (consent) parts.push(`${consent} 个待授权`)
  if (runtime) parts.push(`${runtime} 个已安装`)
  return parts.join(' · ')
}

/**
 * 源那一行的状态文案：成功显数量，**失败显它自己的原因**。
 *
 * 多源下这是最关键的一栏 —— 用一句笼统的「插件源不可用」代替逐条状态，
 * 等于把排查工作全丢给用户，而他配了 3 个源，根本不知道该动哪一个。
 */
export function sourceStateText(s: MarketSourceRecord): string {
  if (!s.ok) return s.reason || '不可用'
  const bits: string[] = []
  if (s.name) bits.push(s.name)
  bits.push(`${s.count} 个插件`)
  if (s.cached) bits.push('缓存')
  if (s.skipped) bits.push(`跳过 ${s.skipped} 条`)
  return bits.join(' · ')
}

/** 一条市场条目是否命中搜索词（id / 名称 / 描述 / 作者 / 源名任一包含）。 */
export function matchesMarketQuery(e: MarketEntryRecord, q: string): boolean {
  return [e.id, e.name, e.description, e.author, e.sourceName]
    .some((value) => String(value || '').toLowerCase().includes(q))
}

/**
 * 一条插件是否命中搜索词（名称 / id / 描述任一包含，忽略大小写）。
 *
 * 只搜这三样 —— 它们是**列表上已经看得见的字**。不搜权限、依赖、状态文案：
 * 那些是「打开某个插件才需要看」的东西，算进匹配只会让用户搜「收藏」出来一堆别的
 * （因为每个插件都「依赖 核心引擎」）。
 */
export function matchesPluginQuery(plugin: PluginRecord, q: string): boolean {
  return [plugin && plugin.name, plugin && plugin.id, plugin && plugin.description]
    .some((value) => String(value || '').toLowerCase().includes(q))
}

/**
 * 按搜索词过滤清单。空词**原样返回**（不复制、不重排）——
 * 这是列表每次重画都会走的那条路，没必要为「没在搜」再造一份数组。
 *
 * @param {unknown[]} items
 * @param {string} query
 */
export function filterPlugins(items: PluginRecord[] = [], query?: string): PluginRecord[] {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return items
  return items.filter((plugin) => matchesPluginQuery(plugin, q))
}

/**
 * 插件源区的状态行（一句总述；逐条原因在源列表里）。
 * @returns {{ text: string, bad: boolean }}
 */
export function marketStatus(state: MarketState | null | undefined, query?: string) : { text: string, bad: boolean } {
  const st: MarketState = state || { ok: false, sources: [], entries: [] }
  const sources = Array.isArray(st.sources) ? st.sources : []
  const all = Array.isArray(st.entries) ? st.entries : []
  const q = String(query || '').trim().toLowerCase()

  if (!sources.length) {
    return { text: '还没有配置插件源。你也可以到「安装插件」板块从文件夹或压缩包安装。', bad: false }
  }
  if (!all.length) {
    const failed = sources.filter((source) => !source.ok).length
    const allBad = failed === sources.length
    return {
      text: allBad ? '所有插件源都不可用（原因见上面每一条）' : '插件源里没有可安装的插件',
      bad: allBad
    }
  }
  const visible = q ? all.filter((entry) => matchesMarketQuery(entry, q)) : all
  const bits = [`${all.length} 个插件`]
  if (q) bits.push(`匹配 ${visible.length}`)
  // 被跳过的坏条目要**说出来**：作者少打一个字符，症状是「我明明发布了却没显示」
  const skipped = sources.reduce((total, source) => total + (source.skipped || 0), 0)
  if (skipped) bits.push(`· 跳过 ${skipped} 条不合法条目`)
  // 同 id 撞车：不提示的话，用户会以为另一个源根本没生效
  if (st.duplicates) bits.push(`· ${st.duplicates} 条在多个源里重复（按顺序取靠前的）`)
  return { text: bits.join(' · '), bad: false }
}

/**
 * 安装成功时要缀在后面的签名说明。
 *
 * 四态各有各的话：不知道 = 说不知道，「验不过」必须明确说重话。
 * 纯文本（写进 textContent），不要 Markdown 记号 —— 那会原样显示出来。
 */
export function signatureSuffix(sig?: { status?: string } | null): string {
  const status = (sig || {}).status
  if (status === 'valid') return '，签名已校验'
  if (status === 'invalid') return '，但签名校验未通过（内容与签名不符，请谨慎使用）'
  if (status === 'unknown-key') return '，带有签名但本机没有对应公钥'
  return ''
}

/**
 * 开关的可用性与提示语。
 *
 * 判定用主进程下发的 `nonDisableable`（= core || 显式 nonDisableable），
 * **不在这里自己拼** —— 将来加第三类「不可禁用」时才不会漏改这一处。
 *
 * 四种不可切换的情况各有各的理由，必须分别说：
 *   · core / 不可禁用 —— 设计如此（关掉就没有回头路）
 *   · 未安装         —— 没有可运行的入口
 *   · 等授权         —— 「开关」表达不了「同意什么」，授权必须走写明清单的那一块
 *
 * @param {unknown} plugin
 * @returns {{ locked: boolean, title: string }}
 */
export function switchState(plugin: PluginRecord) : { locked: boolean, title: string } {
  const locked = plugin.nonDisableable === true || !plugin.installed || plugin.awaitingConsent
  if (locked) {
    if (plugin.nonDisableable) {
      return {
        locked: true,
        title: plugin.trustLevel === 'core' ? '核心插件不可禁用' : '该插件不可禁用（关掉后无法再从界面打开）'
      }
    }
    return { locked: true, title: plugin.awaitingConsent ? '需先授权才能启用' : '插件未安装' }
  }
  if (plugin.enabled) {
    const hasDependents = Array.isArray(plugin.requiredBy) && plugin.requiredBy.length > 0
    return { locked: false, title: hasDependents ? '停用（会连带禁用依赖它的插件）' : '停用' }
  }
  return {
    locked: false,
    title: plugin.autoDisabled ? '重新启用（已自动停用）' : (plugin.blocked ? '启用（会先启用它的前置）' : '启用')
  }
}

/**
 * 依赖关系行（§10.2「体现」）—— 只产出数据，由视图决定怎么画。
 *
 * 两条设计约束：
 *  1. **显示中文名，不显示 id。** 一串 `panel-favorites` 对用户等于没信息 ——
 *     他脑子里记的是「收藏面板」。名字由 manifest 提供，主进程已随清单一起下发。
 *  2. **「谁依赖我」是解释，不是列表。** 这一栏存在的唯一理由是回答
 *     「为什么这个开关关不掉」：IPC 的依赖保护会拒绝禁用，用户却看不到原因。
 *     所以把「**已启用**的依赖方」标出来 —— 它们才是真正会挡住这次操作的那几个。
 *
 * 硬依赖（缺了是配置错误）与软依赖（缺了只是降级）分开成两行：
 * 合并会让「缺了会废」和「缺了没关系」看起来一样，那正是 §10.2 要避免的。
 *
 * @param {unknown} plugin
 * @param {Map<string, unknown>} index id → 清单项（用于把 id 还原成中文名）
 * @returns {{ label: string, kind: 'hard'|'soft'|'reverse', text: string, emphasis: boolean }[]}
 */
export function relationLines(plugin: PluginRecord, index: Map<string, PluginRecord>) : { label: string, kind: 'hard'|'soft'|'reverse', text: string, emphasis: boolean }[] {
  const nameOf = (id: string): string => {
    const hit = index.get(id)
    return hit ? (hit.name || hit.id) : `${id}（未安装）`
  }
  const lines: { label: string; kind: 'hard'|'soft'|'reverse'; text: string; emphasis: boolean }[] = []
  const add = (label: string, ids: unknown, kind: 'hard'|'soft'|'reverse', emphasisIds?: string[]): void => {
    if (!Array.isArray(ids) || !ids.length) return
    const emphasis = Array.isArray(emphasisIds) && emphasisIds.length > 0
    lines.push({ label, kind, text: ids.map(nameOf).join('、'), emphasis })
  }

  add('依赖', plugin.dependsOn, 'hard')
  add('可选', plugin.optionalDependsOn, 'soft')
  // 反向：谁依赖我。标出来的是**已启用**的那些 —— 它们才是会挡住禁用的。
  const enabledRequiredBy = (plugin.requiredBy || []).filter((id) => {
    const hit = index.get(id)
    return hit && hit.enabled
  })
  add('被依赖', plugin.requiredBy, 'reverse', enabledRequiredBy)
  add('可选被依赖', plugin.optionalRequiredBy, 'soft')
  return lines
}

/**
 * 「没在跑」的原因 —— 五种状态必须各自说清，因为**下一步完全不同**：
 *
 *   failed         自动自愈，用户**不需要**做任何事
 *   autoDisabled   系统因连环出错把它关了，**只能由用户**点开关恢复
 *   blocked        它自己没坏，只是上游没起来（分「可一并启用」与「前置也被停用」两种）
 *   consent        唯一一个「等用户做决定」的状态
 *   health         还没到停用线，但已经在连续失败
 *
 * 若把它们并成一句「出错了」，用户会去等一个不会发生的结果、或去修一个没坏的东西。
 *
 * @param {unknown} plugin
 * @param {Map<string, unknown>} index
 * @returns {{ kind: 'failed'|'autoDisabled'|'blocked'|'consent'|'health', text: string, scopes?: string[] } | null}
 */
export function stateNotice(plugin: PluginRecord, index: Map<string, PluginRecord>) : { kind: 'failed'|'autoDisabled'|'blocked'|'consent'|'health', text: string, scopes?: string[] } | null {
  if (plugin.autoDisabled) {
    return { kind: 'autoDisabled', text: `已自动停用：${plugin.error || '连续出错'}（点右侧开关可重新启用）` }
  }
  if (plugin.failed) {
    return { kind: 'failed', text: `启用失败：${plugin.error || '未知错误'}（下次启动会自动重试）` }
  }
  if (plugin.awaitingConsent) {
    return { kind: 'consent', text: '', scopes: Array.isArray(plugin.requestedPermissions) ? plugin.requestedPermissions : [] }
  }
  if (plugin.blocked) {
    // 「可修」分成两种，下一步完全不同，不能给同一句话：
    //   · 前置只是没开 → 点开关会**一并把它启用**（注册中心按拓扑序恢复）；
    //   · 前置是**被自动停用的**（连环坏）→ 点开关**不会**复活它（复活等于重燃崩溃循环）。
    const blockedIds = plugin.blockedBy || []
    const stuck = blockedIds.some((bid) => {
      const hit = index.get(bid)
      return hit && hit.autoDisabled
    })
    const suffix = stuck ? '（前置已被自动停用，请先处理它）' : '（点开关会一并启用前置）'
    return { kind: 'blocked', text: `${plugin.error || '前置未启用'}${suffix}` }
  }
  // 主动健康检查：只在**已经有失败**时出现（`healthCheckFailures > 0` 是「它现在不太对」的唯一信号）
  if (plugin.healthCheck && (plugin.healthCheckFailures || 0) > 0) {
    return {
      kind: 'health',
      text: `健康检查未通过 ${plugin.healthCheckFailures || 0}/${plugin.healthCheck.failures || 0} 次（连续未通过会被自动停用）`
    }
  }
  return null
}
