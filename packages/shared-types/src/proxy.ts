/**
 * proxy.mjs —— 网络代理设置的**唯一真源**（键名 + 取值 + 到 Electron `ProxyConfig` 的转换）
 *
 * ── 为什么必须是一份 ──────────────────────────────────────────────
 * 三处都要用同一套口径：
 *   1. 主进程 applier（把设置灌进 `session.setProxy`）；
 *   2. 设置页（渲染层的"选手动才显示规则输入框"联动）；
 *   3. 校验（`base.normalize()` 归一非法值）。
 * 任何一处自己写一遍 mode 取值或 rules 拼法，就会出现"设置页显示手动、主进程却按系统走"。
 *
 * ── 参考实现 ──────────────────────────────────────────────────────
 * 本仓库遗留项目 `js/util/proxy.js`（`{ type, proxyRules, proxyBypassRules, pacScript }`
 * → Electron ProxyConfig）是唯一有代理实现的地方；RT 与 NG 此前都没有。
 * 这里沿用它的四态模型（系统 / 直连 / 手动 / PAC），只把 `type: 0..3` 换成
 * **可读字符串**（数字魔法值在设置文件里没法排查，且将来加第五态要重排）。
 *
 * 纯模块：零依赖、零 IO、不 require electron —— 主进程与渲染层读同一份。
 */

/**
 * 四种模式的**具名取值**——设置页字段的 `when` 联动、运行时判据与下面的选项表
 * 都引这一份。`when.value` 写错一个字不会报错，只会让字段永远不出现。
 */
const PROXY_MODE_VALUES = Object.freeze({
  system: 'system',
  direct: 'direct',
  fixedServers: 'fixed_servers',
  pacScript: 'pac_script'
})

/** 四种模式。`system` 是默认（= 不改变任何既有行为）。 */
const PROXY_MODES = Object.freeze(Object.values(PROXY_MODE_VALUES))

/** 设置键名（键名的主人是本模块，设置页 options 与 applier 共用，不各抄一遍中文名）。 */
const PROXY_SETTING_KEYS = Object.freeze({
  mode: 'network.proxy_mode',
  /** 手动模式的规则串，形如 `http=host:port;https=host:port;socks=socks5://host:port`。 */
  rules: 'network.proxy_rules',
  /** 不走代理的地址（分号或逗号分隔）。 */
  bypassRules: 'network.proxy_bypass_rules',
  /** PAC 脚本地址（`http(s)://…` 或 `file://…`）。 */
  pacUrl: 'network.proxy_pac_url'
})

/** 模式下拉的 [值, 中文名]（值是字符串，与设置存储一致）。 */
const PROXY_MODE_OPTIONS = Object.freeze([
  [PROXY_MODE_VALUES.system, '使用系统代理'],
  [PROXY_MODE_VALUES.direct, '不使用代理（直连）'],
  [PROXY_MODE_VALUES.fixedServers, '手动配置代理'],
  [PROXY_MODE_VALUES.pacScript, '自动配置脚本（PAC）']
])

/** 默认模式 = 系统代理 —— 与"没做过任何设置"完全等价，不改变既有行为。 */
const DEFAULT_PROXY_MODE = PROXY_MODE_VALUES.system

/**
 * 四项缺省值（键 = 真实设置键）—— 域层默认值与设置页兜底显示**共用这一份**。
 * 改动这里就等于同时改了"新装用户的行为"和"设置页显示的空值"，不会再漂移。
 */
const DEFAULT_PROXY_SETTINGS = Object.freeze({
  [PROXY_SETTING_KEYS.mode]: DEFAULT_PROXY_MODE,
  [PROXY_SETTING_KEYS.rules]: '',
  [PROXY_SETTING_KEYS.bypassRules]: '<local>',
  [PROXY_SETTING_KEYS.pacUrl]: ''
})

type ProxyMode = 'system' | 'direct' | 'fixed_servers' | 'pac_script'

/** 归一化模式取值（设置文件可手改 / 旧数据可能缺字段）。 */
function normalizeProxyMode(value: unknown): ProxyMode {
  const v = String(value == null ? '' : value)
  return (PROXY_MODES as readonly string[]).includes(v) ? v as ProxyMode : DEFAULT_PROXY_MODE
}

/** 归一化一个自由文本设置（去首尾空白；非字符串一律空串）。 */
function normalizeProxyText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 设置值 → Electron `session.setProxy()` 的入参。
 *
 * 三条"空值兜底"都是刻意的，为的是**绝不让用户把网络配成不通**：
 *   · 手动模式但没填规则 → 直连（= 没有代理）。若原样交给 Electron，
 *     `fixed_servers` + 空 `proxyRules` 的行为不属于稳定契约；
 *   · PAC 模式但没填地址 → 回到系统代理（没有脚本可执行，跟随系统最不意外）；
 *   · 旁路规则为空 → **不带上这个字段**（空串与"不设置"在 Chromium 里不是一回事）。
 *
 * @param {{ mode?: unknown, rules?: unknown, bypassRules?: unknown, pacUrl?: unknown }} input
 * @returns {{ mode: string, proxyRules?: string, proxyBypassRules?: string, pacScript?: string }}
 */
function toProxyConfig(input: { mode?: unknown, rules?: unknown, bypassRules?: unknown, pacUrl?: unknown }) : { mode: string, proxyRules?: string, proxyBypassRules?: string, pacScript?: string } {
  const src = input || {}
  const mode = normalizeProxyMode(src.mode)
  if (mode === PROXY_MODE_VALUES.system) return { mode: PROXY_MODE_VALUES.system }
  if (mode === PROXY_MODE_VALUES.direct) return { mode: PROXY_MODE_VALUES.direct }

  if (mode === PROXY_MODE_VALUES.fixedServers) {
    const rules = normalizeProxyText(src.rules)
    if (!rules) return { mode: PROXY_MODE_VALUES.direct }
    const config: { mode: ProxyMode; proxyRules: string; proxyBypassRules?: string } = {
      mode: PROXY_MODE_VALUES.fixedServers,
      proxyRules: rules
    }
    const bypass = normalizeProxyText(src.bypassRules)
    if (bypass) config.proxyBypassRules = bypass
    return config
  }

  // pac_script
  const pacUrl = normalizeProxyText(src.pacUrl)
  if (!pacUrl) return { mode: PROXY_MODE_VALUES.system }
  return { mode: PROXY_MODE_VALUES.pacScript, pacScript: pacUrl }
}

/** 从"设置读取函数"直接算出 ProxyConfig（applier 与设置页共用同一条路）。 */
function proxyConfigFromSettings(getSetting: unknown): ReturnType<typeof toProxyConfig> {
  const read = typeof getSetting === 'function' ? getSetting : () => undefined
  return toProxyConfig({
    mode: read(PROXY_SETTING_KEYS.mode),
    rules: read(PROXY_SETTING_KEYS.rules),
    bypassRules: read(PROXY_SETTING_KEYS.bypassRules),
    pacUrl: read(PROXY_SETTING_KEYS.pacUrl)
  })
}

export {
  PROXY_MODES,
  PROXY_MODE_VALUES,
  PROXY_SETTING_KEYS,
  PROXY_MODE_OPTIONS,
  DEFAULT_PROXY_MODE,
  DEFAULT_PROXY_SETTINGS,
  normalizeProxyMode,
  normalizeProxyText,
  toProxyConfig,
  proxyConfigFromSettings
}
