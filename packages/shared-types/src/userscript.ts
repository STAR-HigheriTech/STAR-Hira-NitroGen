/**
 * userscript —— UserScript（Tampermonkey / Greasemonkey 风格）的**唯一纯规则**。
 *
 * 本文件零依赖、无 IO、不 require electron，只做四件"必须有且只有一份"的事：
 *   1. 解析 `// ==UserScript==` 元数据头（`@match` / `@include` / `@exclude` / `@run-at` / `@grant` …）
 *   2. 判断一个脚本该不该在某 URL 上跑（Chrome 风格 match pattern + `<all_urls>` + 正则）
 *   3. 把一个脚本归一化成宿主认得的形状（`normalizeUserScript`）
 *   4. 生成注入用代码：GM API 垫片 + 独立 IIFE + 错误隔离（`buildUserScriptCode`）
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────
 * 解析与匹配是"用户脚本"这个概念的全部语义，宿主的安装器、注入点、插件贡献面都要用。
 * 若各自实现，`@match` 的通配口径迟早漂移成两套（一处 `*.a.com` 含裸域、另一处不含），
 * 用户看到的就是"同一脚本有的站点生效、有的不生效"。所以语义只在这里定义一次。
 *
 * ── 与 page-inject 的分工 ─────────────────────────────────────────
 * `page-inject.mjs` 管的是**按站点一条规则**的轻量注入（Boosts / 强制深色 / 一小段 JS）；
 * 用户脚本是**带元数据头的独立产物**（可安装、可启停、可列清单），归属插件生态。
 * 两者最终汇合在同一个执行点（`resolveInjection().js` + 用户脚本），但规则不混在一起。
 */

import { isHttpProtocol } from './url-protocols.js'

/** `@run-at` 的合法值（与 Tampermonkey 对齐）。 */
export const RUN_AT = Object.freeze({
  DOCUMENT_START: 'document-start',
  DOCUMENT_END: 'document-end',
  DOCUMENT_IDLE: 'document-idle'
})

/** 用户脚本插件的 `type`（manifest 里声明；注册中心对 type 无白名单，纯标识）。 */
export const USERSCRIPT_PLUGIN_TYPE = 'userscript-plugin'

/** 元数据头的起止标记（行首允许 `//` 后任意空白）。 */
const HEADER_START = /^\/\/\s*==UserScript==\s*$/i
const HEADER_END = /^\/\/\s*==\/UserScript==\s*$/i
/** 一条元数据行：`// @key value`（value 可缺省）。 */
const META_LINE = /^\/\/\s*@([A-Za-z][\w:.-]*)(?:\s+(.*))?$/

/** 会被**重复收集**的键（同名多行 = 数组）；其余键取第一条非空值。 */
const MULTI_KEYS = new Set([
  'match', 'include', 'exclude', 'grant', 'require', 'resource', 'connect', 'noframes'
])

const SCALAR_KEYS = new Set(['name', 'namespace', 'version', 'description', 'author', 'icon', 'homepage', 'license'])

export interface UserScriptMeta {
  hasHeader: boolean
  name: string
  namespace: string
  version: string
  description: string
  author: string
  icon: string
  homepage: string
  license: string
  runAt: string
  match: string[]
  include: string[]
  exclude: string[]
  grant: string[]
  require: string[]
  resource: string[]
  connect: string[]
  noframes: boolean
}

/** 空元数据（解析失败 / 无头部时的稳定形状，调用方不必判空）。 */
function emptyMeta(): UserScriptMeta {
  return {
    hasHeader: false,
    name: '',
    namespace: '',
    version: '',
    description: '',
    author: '',
    icon: '',
    homepage: '',
    license: '',
    runAt: '',
    match: [],
    include: [],
    exclude: [],
    grant: [],
    require: [],
    // `@resource` / `@connect` 与上面同属**多值**键：MULTI_KEYS 命中后会就地 push，
    // 若空表里没有这两个字段，`meta[key]` 就是 undefined → `list.includes` 当场 TypeError。
    resource: [],
    connect: [],
    noframes: false
  }
}

/**
 * 解析 `// ==UserScript==` 元数据头。
 *
 * 容错优先：头部缺失 / 未闭合都不抛异常 —— 安装器需要把"这不是用户脚本"作为
 * 可读的错误告诉用户，而不是抛一个栈。
 *
 * @param {unknown} source 脚本全文
 * @returns {ReturnType<typeof emptyMeta> & { error?: string }}
 */
export function parseUserScriptMeta(source: unknown) : ReturnType<typeof emptyMeta> & { error?: string } {
  const text = typeof source === 'string' ? source : ''
  const meta = emptyMeta()
  if (!text) return { ...meta, error: '脚本内容为空' }

  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (HEADER_START.test(lines[i].trim())) { start = i; break }
  }
  if (start < 0) return { ...meta, error: '缺少 ==UserScript== 元数据头' }

  meta.hasHeader = true
  let closed = false
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (HEADER_END.test(line)) { closed = true; break }
    // 头结束得比预期早（遇到非注释行）也算闭合 —— 别把正文当元数据继续啃。
    if (!line.startsWith('//')) break
    const hit = META_LINE.exec(line)
    if (!hit) continue
    const key = hit[1].toLowerCase()
    const value = String(hit[2] == null ? '' : hit[2]).trim()
    if (!value) continue

    const multiValues: Record<string, string[]> = {
      match: meta.match,
      include: meta.include,
      exclude: meta.exclude,
      grant: meta.grant,
      require: meta.require,
      resource: meta.resource,
      connect: meta.connect
    }
    if (MULTI_KEYS.has(key)) {
      if (key === 'noframes') { meta.noframes = true; continue }
      const list = multiValues[key]
      if (!list) continue
      if (!list.includes(value)) list.push(value)
      continue
    }
    // 标量：第一个非空值生效（Tampermonkey 也是这个口径）
    if (key === 'run-at') { if (!meta.runAt) meta.runAt = value; continue }
    if (SCALAR_KEYS.has(key)) {
      // `@name:zh-CN` 这类本地化键落到 `name:zh-cn`，但不能覆盖主键。
      const field = key as keyof Pick<UserScriptMeta, 'name' | 'namespace' | 'version' | 'description' | 'author' | 'icon' | 'homepage' | 'license'>
      if (!meta[field]) meta[field] = value
    }
  }

  if (!closed) return { ...meta, error: '元数据头没有以 ==/UserScript== 结束' }
  if (!meta.name) meta.name = ''
  if (meta.grant.length === 1 && meta.grant[0].toLowerCase() === 'none') meta.grant = []
  return meta
}

/** 把 glob 通配串转成正则源（`*` → `.*`，其余元字符转义）。 */
function globToRegExpSource(glob: unknown): string {
  return String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
}

/** `/regex/flags` 形态 → RegExp；非法返回 null。 */
function parseRegexPattern(text: unknown): RegExp | null {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(String(text))
  if (!m) return null
  try {
    return new RegExp(m[1], m[2].replace(/g/g, ''))
  } catch (_) {
    return null
  }
}

/** host 段匹配（`*` / `*.a.com`（含裸域）/ 普通域名 / 泛 glob）。 */
function hostMatches(pattern: unknown, hostname: unknown): boolean {
  const pat = String(pattern || '').toLowerCase()
  const host = String(hostname || '').toLowerCase()
  if (!pat) return false
  if (pat === '*') return !!host
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(2)
    return host === suffix || host.endsWith(`.${suffix}`)
  }
  if (pat.includes('*')) return new RegExp(`^${globToRegExpSource(pat)}$`, 'i').test(host)
  return host === pat
}

/**
 * 判断一条 match pattern 是否命中 URL。
 *
 * 支持四种写法：
 *   · `<all_urls>`                 —— 任意 http(s)/file/ftp 页面
 *   · `*://*.example.com/path*`    —— Chrome 风格（scheme/host/path 三段，path 支持 `*`）
 *   · `/^https?:\/\/a\.com\//`     —— 正则（Tampermonkey 的 `@include` 常用）
 *   · `*example.com*`              —— 无 scheme 的 glob，整串匹配 URL
 *
 * @param {unknown} pattern
 * @param {unknown} url
 * @returns {boolean}
 */
export function matchPatternMatches(pattern: unknown, url: unknown) : boolean {
  const raw = String(pattern == null ? '' : pattern).trim()
  const href = String(url == null ? '' : url).trim()
  if (!raw || !href) return false

  if (raw === '<all_urls>') return /^(?:https?|file|ftp):\/\//i.test(href)

  if (raw.startsWith('/')) {
    const re = parseRegexPattern(raw)
    if (re) return re.test(href)
  }

  const schemeHit = /^(\*|https?|file|ftp):\/\/(.*)$/i.exec(raw)
  if (!schemeHit) {
    // 没有 scheme 就当整串 glob（`@include *://a.com/*` 之外的宽松写法）
    return new RegExp(`^${globToRegExpSource(raw)}$`, 'i').test(href)
  }

  let parsed
  try {
    parsed = new URL(href)
  } catch (_) {
    return false
  }
  const scheme = schemeHit[1].toLowerCase()
  if (scheme === '*') {
    if (!isHttpProtocol(parsed.protocol)) return false
  } else if (parsed.protocol !== `${scheme}:`) {
    return false
  }

  const rest = schemeHit[2]
  const slash = rest.indexOf('/')
  const hostPart = slash < 0 ? rest : rest.slice(0, slash)
  const pathPart = slash < 0 ? '/*' : rest.slice(slash)
  if (!hostMatches(hostPart, parsed.hostname)) return false
  const target = `${parsed.pathname || '/'}${parsed.search || ''}`
  return new RegExp(`^${globToRegExpSource(pathPart)}$`, 'i').test(target)
}

/**
 * 某脚本是否应在该 URL 上运行：`@exclude` 优先，其次 `@match` 与 `@include` 任一命中。
 * 两者都没有声明 → 不运行（与 Tampermonkey 一致：没有作用域比"到处跑"安全得多）。
 *
 * @param {{ match?: string[], include?: string[], exclude?: string[] } | null | undefined} meta
 * @param {unknown} url
 * @returns {boolean}
 */
export function userScriptMatchesUrl(meta: { match?: string[], include?: string[], exclude?: string[] } | null | undefined, url: unknown) : boolean {
  if (!meta) return false
  const excludes = Array.isArray(meta.exclude) ? meta.exclude : []
  for (const pattern of excludes) {
    if (matchPatternMatches(pattern, url)) return false
  }
  const positives = [
    ...(Array.isArray(meta.match) ? meta.match : []),
    ...(Array.isArray(meta.include) ? meta.include : [])
  ]
  if (!positives.length) return false
  return positives.some((pattern) => matchPatternMatches(pattern, url))
}

/** `@run-at` 归一（未知值一律按 document-end —— 我们本来就在加载完成后注入）。 */
export function normalizeRunAt(value: unknown): string {
  const text = String(value == null ? '' : value).trim().toLowerCase()
  if (text === RUN_AT.DOCUMENT_START) return RUN_AT.DOCUMENT_START
  if (text === RUN_AT.DOCUMENT_IDLE || text === 'document-body') return RUN_AT.DOCUMENT_IDLE
  return RUN_AT.DOCUMENT_END
}

/** djb2 字符串散列（只用于"没名字的脚本"生成稳定 id，不做安全用途）。 */
function hashText(text: unknown): string {
  let h = 5381
  const s = String(text || '')
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 把任意文案压成 id 片段：只留 `a-z0-9-`。 */
export function slugifyUserScriptName(value: unknown): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * 归一化一个用户脚本（安装器、贡献面、注入点共用同一形状）。
 *
 * @param {any} input
 * @returns {{
 *   id: string, pluginId: string, name: string, namespace: string, version: string,
 *   description: string, author: string, icon: string, homepage: string, license: string,
 *   runAt: string, match: string[], include: string[], exclude: string[], grant: string[],
 *   require: string[], resource: string[], connect: string[], noframes: boolean,
 *   file: string, order: number, enabled: boolean, source: string
 * }}
 */
export function normalizeUserScript(input: unknown = {}) : {
  id: string, pluginId: string, name: string, namespace: string, version: string,
  description: string, author: string, icon: string, homepage: string, license: string,
  runAt: string, match: string[], include: string[], exclude: string[], grant: string[],
  require: string[], resource: string[], connect: string[], noframes: boolean,
  file: string, order: number, enabled: boolean, source: string
} {
  const data = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const source = typeof data.source === 'string' ? data.source : ''
  const meta = data.meta && typeof data.meta === 'object'
    ? data.meta as Record<string, unknown>
    : parseUserScriptMeta(source)
  const pluginId = String(data.pluginId || '').trim()
  const namespace = String(data.namespace || meta.namespace || '').trim()
  const name = String(data.name || meta.name || '').trim()
  const rawId = String(data.id || '').trim()
  const id = rawId || `${slugifyUserScriptName(name) || 'script'}-${hashText(`${namespace}\u0000${source}`)}`

  return {
    id,
    pluginId,
    name: name || id,
    namespace,
    version: String(data.version || meta.version || '').trim(),
    description: String(data.description || meta.description || '').trim(),
    author: String(meta.author || '').trim(),
    icon: String(data.icon || meta.icon || '').trim(),
    homepage: String(meta.homepage || '').trim(),
    license: String(meta.license || '').trim(),
    runAt: normalizeRunAt(data.runAt || meta.runAt),
    match: (Array.isArray(meta.match) ? meta.match : []).map(String),
    include: (Array.isArray(meta.include) ? meta.include : []).map(String),
    exclude: (Array.isArray(meta.exclude) ? meta.exclude : []).map(String),
    grant: (Array.isArray(meta.grant) ? meta.grant : []).map(String),
    require: (Array.isArray(meta.require) ? meta.require : []).map(String),
    resource: (Array.isArray(meta.resource) ? meta.resource : []).map(String),
    connect: (Array.isArray(meta.connect) ? meta.connect : []).map(String),
    noframes: meta.noframes === true,
    file: String(data.file || '').trim(),
    order: Number.isFinite(data.order) ? Number(data.order) : 0,
    enabled: data.enabled !== false,
    source
  }
}

/**
 * 从一批脚本里挑出该 URL 需要执行的那些（已按 order / id 稳定排序，已去重）。
 *
 * @param {{ scripts?: any[], url?: unknown }} input
 * @returns {ReturnType<typeof normalizeUserScript>[]}
 */
export function resolveUserScripts(input: { scripts?: unknown[]; url?: unknown } = {}) : ReturnType<typeof normalizeUserScript>[] {
  const url = String(input.url == null ? '' : input.url)
  const list = Array.isArray(input.scripts) ? input.scripts : []
  if (!url || !list.length) return []
  const out: Array<ReturnType<typeof normalizeUserScript>> = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const script = normalizeUserScript(raw)
    if (!script || script.enabled === false || !script.source) continue
    const key = `${script.pluginId || ''}\u0000${script.id || ''}`
    if (seen.has(key)) continue
    if (!userScriptMatchesUrl(script, url)) continue
    seen.add(key)
    out.push(script)
  }
  out.sort((a, b) => {
    const d = (a.order || 0) - (b.order || 0)
    return d !== 0 ? d : String(a.id || '').localeCompare(String(b.id || ''))
  })
  return out
}

/** 生成脚本清单（安装器写 manifest 用；纯数据、可直接 JSON.stringify）。 */
export function buildUserScriptPluginManifest(meta: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  const scriptId = String(opts.scriptId || meta.name || 'script').trim() || 'script'
  const id = String(opts.id || `userscript-${slugifyUserScriptName(meta.name) || hashText(scriptId)}`).trim()
  const version = String(meta.version || opts.version || '1.0.0').trim()
  const description = String(meta.description || '').trim()
  return {
    id,
    name: String(meta.name || scriptId),
    version,
    type: USERSCRIPT_PLUGIN_TYPE,
    trustLevel: String(opts.trustLevel || 'community'),
    description: description || '用户脚本（UserScript）',
    contributes: {
      userscripts: [
        {
          id: scriptId,
          name: String(meta.name || scriptId),
          file: String(opts.file || 'script.user.js'),
          order: Number.isFinite(opts.order) ? Number(opts.order) : 0
        }
      ]
    }
  }
}

/**
 * `@grant` 里代表「可以发起跨域请求」的那几个名字（GM4 的 `GM.xmlHttpRequest` 同义）。
 */
export const GM_REQUEST_GRANTS = Object.freeze(['GM_xmlhttpRequest', 'GM.xmlHttpRequest'])

/**
 * 脚本是否声明了跨域请求能力（`@grant GM_xmlhttpRequest`）。
 * 宿主侧据此决定要不要替它代理请求 —— 没声明一律拒绝，不看 `@connect`。
 */
export function userScriptNeedsGmRequest(script: unknown): boolean {
  const source = script && typeof script === 'object' ? script as Record<string, unknown> : {}
  const grants = Array.isArray(source.grant) ? source.grant : []
  return grants.some((g: unknown) => GM_REQUEST_GRANTS.includes(String(g || '').trim()))
}

/** URL 的默认端口（`@connect example.com:8443` 的端口比较要用）。 */
function defaultPort(protocol: string): string {
  if (protocol === 'https:') return '443'
  if (protocol === 'http:') return '80'
  return ''
}

/**
 * 一条 `@connect` 是否放行目标 URL。
 * 支持：`*` / `self` / `example.com` / `*.example.com` / `example.com:8443` / 带 scheme 的整串
 * （scheme 只作说明，不参与比较 —— 与 Tampermonkey 同口径）。
 */
function connectEntryMatches(entry: unknown, target: URL, pageUrl: unknown): boolean {
  const raw = String(entry == null ? '' : entry).trim().toLowerCase()
  if (!raw) return false
  if (raw === '*') return true
  if (raw === 'self') {
    try { return new URL(String(pageUrl)).origin === target.origin } catch (_) { return false }
  }
  const stripped = raw.replace(/^[a-z][\w+.-]*:\/\//, '')
  const slash = stripped.indexOf('/')
  const hp = slash < 0 ? stripped : stripped.slice(0, slash)
  const colon = hp.lastIndexOf(':')
  let host = hp
  let port = ''
  if (colon > 0 && /^\d+$/.test(hp.slice(colon + 1))) {
    host = hp.slice(0, colon)
    port = hp.slice(colon + 1)
  }
  if (port && port !== (target.port || defaultPort(target.protocol))) return false
  const hostname = target.hostname.toLowerCase()
  if (!host) return true
  if (host === '*') return !!hostname
  if (host.startsWith('*.')) {
    const suffix = host.slice(2)
    return hostname === suffix || hostname.endsWith(`.${suffix}`)
  }
  if (host.includes('*')) return new RegExp(`^${globToRegExpSource(host)}$`, 'i').test(hostname)
  return hostname === host
}

/**
 * 脚本的 `@connect` 白名单是否允许它请求 `targetUrl`。
 *
 * **没有 `@connect` = 不允许** —— 与 Tampermonkey 的默认拒绝一致：少写一行的代价
 * 应该是"请求被拒且日志里看得见"，而不是"随便哪个域都能打"。
 *
 * @param {{ connect?: string[] } | null | undefined} script
 * @param {unknown} targetUrl
 * @param {unknown} pageUrl 脚本所在页面的 URL（`@connect self` 用它比对同源）
 * @returns {boolean}
 */
export function userScriptConnectAllows(script: { connect?: string[] } | null | undefined, targetUrl: unknown, pageUrl: unknown) : boolean {
  const entries = script && Array.isArray(script.connect) ? script.connect : []
  if (!entries.length) return false
  let target
  try { target = new URL(String(targetUrl)) } catch (_) { return false }
  if (!isHttpProtocol(target.protocol)) return false
  return entries.some((entry) => connectEntryMatches(entry, target, pageUrl))
}

/**
 * 生成注入用代码：GM API 垫片 + `@require` 前置 + 独立 IIFE + 错误隔离。
 *
 * 每个脚本各自一个 IIFE —— 一个脚本抛错不能带走同页其它脚本（Tampermonkey 同口径）。
 * GM 存储落在 `localStorage`（按 `插件:脚本` 命名空间隔离），所以刷新页面仍在、
 * 且与 Tampermonkey 的 `GM_setValue` 一样是"按域隔离"的直觉行为。
 *
 * `@require` 的代码由宿主取回后通过 `options.requires` 传进来，**与本脚本同一个函数作用域**
 * 内联执行 —— 这正是 Tampermonkey 的语义：`@require` 里 `var` / `function` 声明对脚本可见。
 * 取不到的 require 由宿主过滤掉（脚本仍会跑，只是少了那个库）。
 *
 * `GM_xmlhttpRequest` 走 preload 桥 `window.__hiraGm.request`：请求本身在主进程发出，
 * 授权判定（`@grant` + `@connect`）也在主进程做 —— 页面侧伪造不了。
 *
 * @param {ReturnType<typeof normalizeUserScript>} script
 * @param {{ requires?: string[] }} [options]
 * @returns {string} 可直接 executeJavaScript 的代码（空串 = 没有可执行内容）
 */
export function buildUserScriptCode(script: ReturnType<typeof normalizeUserScript>, options: { requires?: string[] } = {}) : string {
  const source = script && typeof script.source === 'string' ? script.source : ''
  if (!source) return ''
  const label = String((script && script.name) || (script && script.id) || 'UserScript').replace(/\*\//g, '* /')
  const ns = `${(script && script.pluginId) || 'plugin'}:${(script && script.id) || 'script'}`
  const requiresInput = options.requires
  const requires = Array.isArray(requiresInput)
    ? requiresInput.filter((code): code is string => typeof code === 'string' && code.trim().length > 0)
    : []
  const info = {
    script: {
      name: label,
      namespace: String((script && script.namespace) || ''),
      version: String((script && script.version) || ''),
      description: String((script && script.description) || ''),
      matches: (script && script.match) || [],
      includes: (script && script.include) || [],
      grants: (script && script.grant) || [],
      runAt: String((script && script.runAt) || RUN_AT.DOCUMENT_END)
    },
    scriptHandler: 'Hira UserScripts',
    version: '1.0.0'
  }

  return [
    `/* ===== Hira UserScript · ${label} ===== */`,
    '(function () {',
    `  var __hiraNs = ${JSON.stringify(`hira:gm:${ns}:`)};`,
    `  var __hiraLabel = ${JSON.stringify(label)};`,
    '  function __hiraKey(k) { return __hiraNs + String(k); }',
    '  function GM_getValue(k, d) {',
    '    try { var v = window.localStorage.getItem(__hiraKey(k));',
    '      return v === null ? d : JSON.parse(v); } catch (e) { return d; }',
    '  }',
    '  function GM_setValue(k, v) {',
    '    try { window.localStorage.setItem(__hiraKey(k), JSON.stringify(v)); return true; } catch (e) { return false; }',
    '  }',
    '  function GM_deleteValue(k) {',
    '    try { window.localStorage.removeItem(__hiraKey(k)); } catch (e) {}',
    '  }',
    '  function GM_listValues() {',
    '    var out = [];',
    '    try {',
    '      for (var i = 0; i < window.localStorage.length; i += 1) {',
    '        var full = window.localStorage.key(i);',
    '        if (full && full.indexOf(__hiraNs) === 0) out.push(full.slice(__hiraNs.length));',
    '      }',
    '    } catch (e) {}',
    '    return out;',
    '  }',
    '  function GM_addStyle(css) {',
    '    try {',
    '      var el = document.createElement("style");',
    '      el.textContent = String(css == null ? "" : css);',
    '      (document.head || document.documentElement).appendChild(el);',
    '      return el;',
    '    } catch (e) { return null; }',
    '  }',
    '  function GM_log() {',
    '    try { console.log.apply(console, ["[Hira UserScript] " + __hiraLabel].concat([].slice.call(arguments))); } catch (e) {}',
    '  }',
    '  function GM_setClipboard(text) {',
    '    try { return navigator.clipboard.writeText(String(text == null ? "" : text)); } catch (e) { return null; }',
    '  }',
    '  function GM_openInTab(url) {',
    '    try { window.open(String(url), "_blank"); } catch (e) {}',
    '  }',
    '  function GM_xmlhttpRequest(details) {',
    '    var noop = { abort: function () {} };',
    '    try {',
    '      var bridge = window.__hiraGm;',
    '      if (!bridge || typeof bridge.request !== "function") {',
    '        try { if (details && typeof details.onerror === "function") details.onerror({ error: "GM_xmlhttpRequest 不可用（宿主桥未注入）" }); } catch (e) {}',
    '        return noop;',
    '      }',
    '      return bridge.request(details || {}, __hiraLabel) || noop;',
    '    } catch (e) { return noop; }',
    '  }',
    `  var GM_info = ${JSON.stringify(info)};`,
    '  var unsafeWindow = window;',
    '  try {',
    '    (function () {',
    // @require：与脚本同作用域内联（Tampermonkey 语义），失败由外层 try/catch 统一报出。
    ...requires,
    source,
    '    }).call(window);',
    '  } catch (err) {',
    '    try { console.error("[Hira UserScript] " + __hiraLabel + " 执行失败", err); } catch (e) {}',
    '  }',
    '})();'
  ].join('\n')
}
