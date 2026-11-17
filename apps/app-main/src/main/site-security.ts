/**
 * 站点安全探针（主进程）—— 活动标签或证书页来源标签的传输协议与证书链。
 *
 * ── 为什么单独成一个服务，而不是塞进 IPC 注册器 ────────────────────────
 * 证书数据的采集方式（CDP debugger + X509 解析）与「谁在问、问哪条路由」无关。
 * 把它放在 IPC 层会让注册器认识 Electron 的 debugger，既难替换也难复用
 * （未来「页面信息」页 / 开发者工具面板 / 导出诊断包都可能要同一份数据）。
 * 因此这里只暴露一个 `read()`：输入一个 webContents 形状的对象，输出扁平事实。
 *
 * ── 数据来源 ──────────────────────────────────────────────────────────
 * Chromium 把当前页面的证书链放在 CDP `Network.getCertificate({ origin })` 里，
 * 返回 base64(DER) 数组（叶子证书在前）。Node 的 `X509Certificate` 负责解析 ——
 * 渲染层永远拿不到 PEM，也不需要认识 ASN.1。
 *
 * ── 降级策略（重要）───────────────────────────────────────────────────
 * 证书查询失败**绝不能**让站点信息浮层不可用：
 *   · DevTools 已 attach → debugger 抢不到，返回 `certificate: null` + error；
 *   · 老 Chromium / 方法缺失 → 同上；
 *   · 解析失败 → 同上。
 * `secure` / `protocol` / `hostname` 永远由 URL 直接得出，不受证书链路影响。
 */

const { X509Certificate } = require('node:crypto')
const { fetchCertificateTableViaTls } = require('./certificate-tls-probe') as {
  fetchCertificateTableViaTls(origin: string): Promise<{ tableNames: string[]; error: string | null }>
}

interface DebuggerLike {
  isAttached?: () => boolean
  attach: (protocolVersion?: string) => void
  detach: () => void
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

interface WebContentsLike {
  id?: number
  debugger?: DebuggerLike
  getURL?: () => string
  isDestroyed?: () => boolean
}

interface SiteCertificateInfo {
  subjectName: string | null
  issuerName: string | null
  validStart: number | null
  validExpiry: number | null
  serialNumber: string | null
  fingerprint: string | null
  san: string[]
}

interface SiteSecurityInfo {
  secure: boolean
  protocol: string
  hostname: string | null
  origin: string | null
  tabId: string | null
  certificate: SiteCertificateInfo | null
  certificateChain: SiteCertificateInfo[]
  error: string | null
}

interface ObservedSiteCertificate extends SiteSecurityInfo {
  origin: string
  observedAt: number
}

interface StoredSiteCertificate extends ObservedSiteCertificate {
  scopeKey: string
}

interface Deps {
  /** 当前窗口的活动网页（scoped：按 IPC 发送方解析到对应窗口） */
  getActiveWebContents?: () => WebContentsLike | null
  getActiveTabId?: () => string | null
  /** 按标签 id 取网页（证书页查看来源标签时用；不传则只支持活动标签） */
  getWebContents?: (tabId: string) => WebContentsLike | null | undefined
  /** profile + space 隔离键；内存快照绝不跨账号 / 空间复用 */
  getScopeKey?: () => string
  /** 证书缓存时长（同一 URL 反复开关浮层不重复问 CDP） */
  cacheTtlMs?: number
  now?: () => number
}

const DEFAULT_TTL = 60_000
const CACHE_MAX = 256
const OBSERVED_MAX = 64
const CERTIFICATE_CHAIN_MAX = 16
const CERTIFICATE_SAN_MAX = 64
/** 历史页 / 内部页不会带 TLS 证书，先按协议挡掉，省一次 debugger attach。 */
const CERT_PROTOCOLS = new Set(['https:'])

interface CacheEntry {
  url: string
  at: number
  value: SiteSecurityInfo
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol.replace(/:$/, '')
  } catch (_) {
    return ''
  }
}

function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return host || null
  } catch (_) {
    return null
  }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch (_) {
    return null
  }
}

/** `C=US\nO=Let's Encrypt\nCN=R11` → `R11`（CN 优先，缺失时退回第一个字段）。 */
function describeName(name: string | null | undefined): string | null {
  if (!name) return null
  const parts = String(name)
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
  const cn = parts.find((part) => part.startsWith('CN='))
  const chosen = cn || parts[0]
  if (!chosen) return null
  return chosen.replace(/^CN=/, '')
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** CDP 给的是裸 base64(DER)，X509Certificate 只吃 PEM。 */
function toPem(base64Der: string): string {
  const body = String(base64Der).replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) || [body]
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

/**
 * `DNS:example.com, IP Address:1.2.3.4` → `['example.com', '1.2.3.4']`
 * 只保留可读值：浮层用它回答「这张证书覆盖了哪些域名」。
 */
function parseSan(raw: string | null | undefined): string[] {
  if (!raw) return []
  return String(raw)
    .split(/,\s*/)
    .map((part) => part.replace(/^DNS:/, '').replace(/^IP Address:/, '').trim())
    .filter(Boolean)
    .slice(0, CERTIFICATE_SAN_MAX)
}

function parseCertificate(base64Der: string): SiteCertificateInfo | null {
  try {
    const x509 = new X509Certificate(toPem(base64Der))
    return {
      subjectName: describeName(x509.subject),
      issuerName: describeName(x509.issuer),
      validStart: timeOf(x509.validFrom),
      validExpiry: timeOf(x509.validTo),
      serialNumber: x509.serialNumber || null,
      // SHA-256 更适合展示与核对（SHA-1 只用于兼容旧书；两者都只是指纹，不是秘密）。
      fingerprint: x509.fingerprint256 || x509.fingerprint || null,
      san: parseSan(x509.subjectAltName)
    }
  } catch (_) {
    return null
  }
}

/**
 * 问 CDP 要证书链，解析全部可读成员。
 * 只在本函数内 attach/detach —— 绝不长期占用 debugger（会挡住 DevTools）。
 */
async function fetchCertificate(
  wc: WebContentsLike,
  origin: string
): Promise<{ certificate: SiteCertificateInfo | null; certificateChain: SiteCertificateInfo[]; error: string | null }> {
  const debuggerApi = wc.debugger
  if (!debuggerApi || typeof debuggerApi.attach !== 'function') {
    return { certificate: null, certificateChain: [], error: 'debugger-unavailable' }
  }

  let attachedHere = false
  try {
    const alreadyAttached = typeof debuggerApi.isAttached === 'function' ? debuggerApi.isAttached() : false
    // 已被别人 attach（DevTools / 另一个探针）时不要抢，也不要 detach ——
    // 那是别人的连接，我们只借用不了就降级。
    if (alreadyAttached) return { certificate: null, certificateChain: [], error: 'debugger-busy' }

    debuggerApi.attach('1.3')
    attachedHere = true

    try {
      // 部分 Chromium 构建只有在 Network 域启用后才初始化证书表。
      await debuggerApi.sendCommand('Network.enable', {})
    } catch (_) {}
    const result = await debuggerApi.sendCommand('Network.getCertificate', { origin })
    const table = result !== null && typeof result === 'object' && Array.isArray((result as { tableNames?: unknown }).tableNames)
      ? (result as { tableNames: unknown[] }).tableNames
      : []
    if (!table.length) {
      return { certificate: null, certificateChain: [], error: 'certificate-table-empty' }
    }

    // 叶子证书在第一位。链成员逐张解析，但绝不把中间证书冒充叶证书。
    const limitedTable = table.slice(0, CERTIFICATE_CHAIN_MAX)
    const leaf = parseCertificate(String(limitedTable[0]))
    const certificateChain: SiteCertificateInfo[] = leaf ? [leaf] : []
    for (const der of limitedTable.slice(1)) {
      const parsed = parseCertificate(String(der))
      if (parsed) certificateChain.push(parsed)
    }
    if (!leaf) return { certificate: null, certificateChain, error: 'leaf-certificate-unparsable' }
    return { certificate: leaf, certificateChain, error: null }
  } catch (error) {
    return {
      certificate: null,
      certificateChain: [],
      error: error instanceof Error && error.message ? error.message : 'certificate-query-failed'
    }
  } finally {
    if (attachedHere) {
      try {
        debuggerApi.detach()
      } catch (_) {
        // 页面在查询途中被销毁时 detach 会抛 —— 无意义，忽略。
      }
    }
  }
}

function shouldUseTlsFallback(error: string | null): boolean {
  return error !== 'leaf-certificate-unparsable' && error !== 'certificate-unparsable'
}

async function fetchCertificateWithFallback(
  wc: WebContentsLike,
  origin: string
): Promise<{ certificate: SiteCertificateInfo | null; certificateChain: SiteCertificateInfo[]; error: string | null }> {
  const primary = await fetchCertificate(wc, origin)
  if (primary.certificate || !shouldUseTlsFallback(primary.error)) return primary

  const fallback = await fetchCertificateTableViaTls(origin)
  if (!fallback.tableNames.length) {
    return {
      certificate: null,
      certificateChain: [],
      error: fallback.error || primary.error
    }
  }

  const leaf = parseCertificate(fallback.tableNames[0])
  const certificateChain: SiteCertificateInfo[] = leaf ? [leaf] : []
  for (const der of fallback.tableNames.slice(1)) {
    const parsed = parseCertificate(der)
    if (parsed) certificateChain.push(parsed)
  }
  return {
    certificate: leaf,
    certificateChain,
    error: leaf ? null : 'leaf-certificate-unparsable'
  }
}

/**
 * 创建站点安全探针。
 *
 * 缓存按 **webContents.id + URL** 命中：同一页面反复开关浮层不会重复 attach
 * debugger；导航到新 URL 自动失效（URL 变了即视为新条目）。
 */
function createSiteSecurity(deps: Deps = {}) {
  const cache = new Map<number, CacheEntry>()
  const inFlight = new Map<string, Promise<SiteSecurityInfo>>()
  const observed = new Map<string, StoredSiteCertificate>()
  const ttl = Number.isFinite(deps.cacheTtlMs) ? Number(deps.cacheTtlMs) : DEFAULT_TTL
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  function currentScopeKey(): string {
    try {
      return typeof deps.getScopeKey === 'function' ? deps.getScopeKey() : 'default'
    } catch (_) {
      return 'default'
    }
  }

  function cacheResult(key: number, value: CacheEntry): void {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  function remember(value: SiteSecurityInfo, origin: string): void {
    if (!value.certificate || !value.hostname) return
    const scopeKey = currentScopeKey()
    const key = `${scopeKey}\n${value.tabId || ''}\n${value.hostname}\n${value.certificate.fingerprint || ''}`
    observed.delete(key)
    observed.set(key, {
      ...value,
      origin,
      observedAt: now(),
      scopeKey
    })
    while (observed.size > OBSERVED_MAX) {
      const oldest = observed.keys().next()
      if (oldest.done) break
      observed.delete(oldest.value)
    }
  }

  function targetInfo(requestedTabId: string | null): { value: SiteSecurityInfo; wc: WebContentsLike | null } {
    const wc = (requestedTabId
      ? (typeof deps.getWebContents === 'function' ? deps.getWebContents(requestedTabId) : null)
      : (typeof deps.getActiveWebContents === 'function' ? deps.getActiveWebContents() : null)) || null
    const tabId = requestedTabId ||
      (typeof deps.getActiveTabId === 'function' ? deps.getActiveTabId() : null)
    const url = wc && typeof wc.getURL === 'function' ? wc.getURL() : ''
    return {
      wc,
      value: {
        secure: false,
        protocol: protocolOf(url),
        hostname: hostnameOf(url),
        origin: originOf(url),
        tabId: tabId ? String(tabId) : null,
        certificate: null,
        certificateChain: [],
        error: null
      }
    }
  }

  async function read(req?: { tabId?: string }): Promise<SiteSecurityInfo> {
    const requestedTabId = req && req.tabId ? String(req.tabId) : null
    const { wc, value } = targetInfo(requestedTabId)

    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { ...value, error: requestedTabId ? 'tab-not-found' : 'no-active-tab' }
    }

    const url = typeof wc.getURL === 'function' ? wc.getURL() : ''
    const parsedProtocol = protocolOf(url)
    const secure = parsedProtocol === 'https'
    const hostname = hostnameOf(url)
    const base: SiteSecurityInfo = { ...value, secure, protocol: parsedProtocol, hostname }

    // 非 https / 没有主机名：没有证书可查，直接给出确定答案（不当作错误）。
    if (!hostname || !CERT_PROTOCOLS.has(`${parsedProtocol}:`)) return base

    const key = typeof wc.id === 'number' ? wc.id : 0
    const cached = cache.get(key)
    if (cached) {
      if (cached.url === url && now() - cached.at < ttl) {
        cache.delete(key)
        cache.set(key, cached)
        return { ...cached.value, tabId: base.tabId }
      }
      cache.delete(key)
    }

    let origin = ''
    try {
      origin = new URL(url).origin
    } catch (_) {
      return { ...base, error: 'invalid-origin' }
    }

    const flightKey = `${key}\n${url}`
    const running = inFlight.get(flightKey)
    if (running) return running

    // 同一标签同一 URL 的并发读取共用一次 CDP attach，避免双击 / 重开浮层时互相抢连接。
    const task = fetchCertificateWithFallback(wc, origin).then(({ certificate, certificateChain, error }) => {
      const result: SiteSecurityInfo = { ...base, certificate, certificateChain, error }

      // 只缓存"确定的事实"（成功解析或协议层已确认无证书的页面），
      // 失败不入缓存：下次打开浮层时重试，避免一次 DevTools 占用把结果钉死一分钟。
      if (certificate) {
        cacheResult(key, { url, at: now(), value: result })
        remember(result, origin)
      }
      return result
    })
    inFlight.set(flightKey, task)
    try {
      return await task
    } finally {
      if (inFlight.get(flightKey) === task) inFlight.delete(flightKey)
    }
  }

  /** 本次进程内实际读取成功的站点证书快照；按读取时间倒序、同标签同证书去重。 */
  function list(): ObservedSiteCertificate[] {
    const scopeKey = currentScopeKey()
    return Array.from(observed.values())
      .filter((item) => item.scopeKey === scopeKey)
      .sort((a, b) => b.observedAt - a.observedAt)
      .map((item) => ({
        secure: item.secure,
        protocol: item.protocol,
        hostname: item.hostname,
        origin: item.origin,
        tabId: item.tabId,
        certificate: item.certificate,
        certificateChain: item.certificateChain,
        error: item.error,
        observedAt: item.observedAt
      }))
  }

  /** 标签关闭 / 导航时清掉对应缓存，避免 id 复用后命中旧页面。 */
  function forget(webContentsId?: number): void {
    if (typeof webContentsId === 'number') cache.delete(webContentsId)
    else cache.clear()
  }

  return { read, list, forget }
}

module.exports = { createSiteSecurity, parseCertificate }
