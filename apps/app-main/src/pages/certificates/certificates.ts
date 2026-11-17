/**
 * 证书页。
 *
 * 数据分两层：
 *   · 来源标签：从站点信息浮层打开时带 `tabId`，读取用户刚才正在看的站点；
 *   · 本会话快照：站点信息浮层每次成功读取证书都会留一份，侧栏直达时也有内容。
 *
 * Chromium 没有「列出本机全部证书」的 API；这里不伪造证书库，只展示实际读取到的
 * 站点证书与本会话发生过的校验失败。
 */
import { IPC_ROUTES, rpc, el, fmtTime, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, finiteNumber, isRecord, requiredById } from 'hira://shared/page-kit.js'

initTheme()

interface SiteCertificate {
  subjectName?: string | null
  issuerName?: string | null
  validStart?: number | null
  validExpiry?: number | null
  serialNumber?: string | null
  fingerprint?: string | null
  san?: string[]
}

interface SiteSecurity {
  secure?: boolean
  protocol?: string
  hostname?: string | null
  origin?: string | null
  tabId?: string | null
  certificate?: SiteCertificate | null
  certificateChain?: SiteCertificate[]
  error?: string | null
}

interface ObservedSite extends SiteSecurity {
  observedAt?: number
}

interface CertificateError extends SiteCertificate {
  url?: string
  error?: string
  at?: number
}

interface CertificateListResponse {
  certificates?: unknown
  siteCertificates?: unknown
}

const statusEl = requiredById<HTMLElement>('status')
const noticeEl = requiredById<HTMLElement>('notice')
const sourceSection = requiredById<HTMLElement>('source-section')
const sourceContent = requiredById<HTMLElement>('source-content')
const observedSection = requiredById<HTMLElement>('observed-section')
const observedCount = requiredById<HTMLElement>('observed-count')
const observedList = requiredById<HTMLElement>('observed-list')
const errorSection = requiredById<HTMLElement>('error-section')
const errorCount = requiredById<HTMLElement>('error-count')
const errorList = requiredById<HTMLElement>('error-list')
const refreshButton = requiredById<HTMLButtonElement>('refresh')

const sourceTabId = new URLSearchParams(location.search).get('tabId') || ''

function asSiteCertificate(value: unknown): SiteCertificate | null {
  return isRecord(value) ? value as SiteCertificate : null
}

function sameOrigin(left: unknown, right: unknown): boolean {
  try {
    return new URL(String(left || '')).origin === new URL(String(right || '')).origin
  } catch {
    return false
  }
}

function siteOrigin(value: unknown): string {
  try {
    const parsed = new URL(String(value || ''))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : ''
  } catch {
    return ''
  }
}

function errorText(error: unknown): string {
  switch (String(error || '')) {
    case 'tab-not-found':
    case 'no-active-tab':
      return '来源标签已关闭'
    case 'debugger-busy':
      return '开发者工具正在占用调试连接，暂时无法读取证书'
    case 'debugger-unavailable':
      return '当前运行时无法读取站点证书'
    case 'certificate-unparsable':
    case 'leaf-certificate-unparsable':
      return '证书格式无法解析'
    default:
      return error ? `暂时无法读取证书：${String(error)}` : '没有可展示的证书'
  }
}

function certificateState(certificate: SiteCertificate): { label: string; className: string } {
  const now = Date.now()
  const start = finiteNumber(certificate.validStart, 0)
  const expiry = finiteNumber(certificate.validExpiry, 0)
  if (expiry > 0 && expiry < now) return { label: '已过期', className: 'badge badge-danger' }
  if (start > 0 && start > now) return { label: '尚未生效', className: 'badge badge-danger' }
  return { label: '有效', className: 'badge badge-success' }
}

function addRow(grid: HTMLElement, label: string, value: unknown, mono = false): void {
  grid.appendChild(el('dt', undefined, label))
  const text = value === '' || value === null || value === undefined ? '—' : String(value)
  grid.appendChild(el('dd', mono ? 'mono' : undefined, text))
}

function certificateCard(
  credential: SiteCertificate,
  options: {
    url?: string | null
    title?: string
    meta?: string
    protocol?: string
    certificateChain?: SiteCertificate[]
  }
): HTMLElement {
  const card = el('section', 'card certificate-card')
  const head = el('div', 'certificate-card__head')
  const identity = el('div', 'certificate-card__identity')
  identity.appendChild(el('div', 'certificate-card__host', options.title || options.url || '站点证书'))
  if (options.url && options.title && options.title !== options.url) {
    identity.appendChild(el('div', 'certificate-card__url', options.url))
  }
  head.appendChild(identity)

  const badges = el('div', 'certificate-card__badges')
  if (options.protocol) badges.appendChild(el('span', 'badge badge-accent', options.protocol.toUpperCase()))
  const state = certificateState(credential)
  badges.appendChild(el('span', state.className, state.label))
  head.appendChild(badges)
  card.appendChild(head)

  if (options.meta) card.appendChild(el('div', 'certificate-card__meta', options.meta))

  const grid = el('dl', 'def-grid certificate-grid')
  addRow(grid, '颁发给', credential.subjectName)
  addRow(grid, '颁发者', credential.issuerName)
  addRow(
    grid,
    '有效期',
    credential.validStart || credential.validExpiry
      ? `${fmtTime(credential.validStart) || '—'} → ${fmtTime(credential.validExpiry) || '—'}`
      : ''
  )
  addRow(grid, '序列号', credential.serialNumber, true)
  addRow(grid, 'SHA-256 指纹', credential.fingerprint, true)
  const names = Array.isArray(credential.san) ? credential.san.filter(Boolean) : []
  addRow(grid, '覆盖域名', names.length ? names.join('\n') : '')
  card.appendChild(grid)

  const chain = Array.isArray(options.certificateChain)
    ? options.certificateChain.filter(isRecord) as SiteCertificate[]
    : []
  if (chain.length > 1) {
    const details = el('details', 'certificate-chain')
    details.appendChild(el('summary', 'certificate-chain__summary', `证书链 · ${chain.length} 张`))
    const list = el('div', 'certificate-chain__list')
    chain.forEach((item, index) => {
      const row = el('div', 'certificate-chain__item')
      row.appendChild(el('span', 'badge', index === 0 ? '叶证书' : `证书 ${index + 1}`))
      const text = el('div', 'certificate-chain__text')
      text.appendChild(el('div', 'certificate-chain__subject', item.subjectName || '—'))
      text.appendChild(el('div', 'certificate-chain__issuer', `签发者：${item.issuerName || '—'}`))
      row.appendChild(text)
      list.appendChild(row)
    })
    details.appendChild(list)
    card.appendChild(details)
  }
  return card
}

function renderSource(info: SiteSecurity | null, snapshot: ObservedSite | null): void {
  sourceContent.textContent = ''
  if (!sourceTabId) {
    sourceSection.hidden = true
    return
  }

  sourceSection.hidden = false
  const liveCertificate = asSiteCertificate(info?.certificate)
  const cachedCertificate = asSiteCertificate(snapshot?.certificate)
  const targetMissing = info?.error === 'tab-not-found' || info?.error === 'no-active-tab'
  const certificate = liveCertificate || (!targetMissing && info?.secure === false ? null : cachedCertificate)
  if (certificate) {
    sourceContent.appendChild(certificateCard(certificate, {
      url: info?.origin || snapshot?.origin || '',
      title: info?.hostname || snapshot?.hostname || '',
      protocol: info?.protocol || snapshot?.protocol || '',
      certificateChain: liveCertificate ? info?.certificateChain : snapshot?.certificateChain,
      meta: liveCertificate
        ? `刚刚读取 · ${info?.hostname || ''}`
        : `本会话读取于 ${fmtTime(snapshot?.observedAt)}`
    }))
    return
  }

  const empty = el('div', 'notice certificate-empty')
  empty.textContent = info?.secure === false
    ? '来源站点未使用 HTTPS，没有可读取的 TLS 证书。'
    : errorText(info?.error)
  sourceContent.appendChild(empty)
}

function renderObserved(items: ObservedSite[]): void {
  observedSection.hidden = false
  observedCount.textContent = String(items.length)
  observedList.textContent = ''

  if (items.length === 0) {
    observedList.appendChild(el(
      'div',
      'empty',
      sourceTabId
        ? '本会话还没有其它已读取的站点证书。'
        : '打开任意 HTTPS 站点的信息面板并查看证书详情后，这里会保留本次会话的读取记录。'
    ))
    return
  }

  for (const item of items) {
    const certificate = asSiteCertificate(item.certificate)
    if (!certificate) continue
    observedList.appendChild(certificateCard(certificate, {
      url: item.origin || '',
      title: item.hostname || item.origin || '站点证书',
      protocol: item.protocol || '',
      certificateChain: item.certificateChain,
      meta: `读取于 ${fmtTime(item.observedAt)}`
    }))
  }
}

function renderErrors(items: CertificateError[]): void {
  errorSection.hidden = false
  errorCount.textContent = String(items.length)
  errorList.textContent = ''
  if (items.length === 0) {
    errorList.appendChild(el('div', 'empty', '本会话尚未发生证书校验失败。'))
    return
  }

  for (const item of items) {
    const card = el('section', 'card certificate-error-card')
    const head = el('div', 'certificate-card__head')
    const identity = el('div', 'certificate-card__identity')
    identity.appendChild(el('div', 'certificate-card__host', siteOrigin(item.url) || '（无地址）'))
    identity.appendChild(el('div', 'certificate-card__url', item.error || '（无错误码）'))
    head.appendChild(identity)
    head.appendChild(el('span', 'badge badge-danger', '校验失败'))
    card.appendChild(head)

    const grid = el('dl', 'def-grid certificate-grid')
    addRow(grid, '主体', item.subjectName)
    addRow(grid, '签发者', item.issuerName)
    addRow(grid, '序列号', item.serialNumber, true)
    addRow(grid, '生效时间', item.validStart ? fmtTime(item.validStart) : '')
    addRow(grid, '过期时间', item.validExpiry ? fmtTime(item.validExpiry) : '')
    addRow(grid, 'SHA-256 指纹', item.fingerprint, true)
    addRow(grid, '记录时间', item.at ? fmtTime(item.at) : '')
    card.appendChild(grid)
    errorList.appendChild(card)
  }
}

function siteItems(value: unknown): ObservedSite[] {
  return Array.isArray(value) ? value.filter(isRecord) as ObservedSite[] : []
}

function errorItems(value: unknown): CertificateError[] {
  return Array.isArray(value) ? value.filter(isRecord) as CertificateError[] : []
}

async function refresh(): Promise<void> {
  refreshButton.disabled = true
  statusEl.textContent = '读取中…'
  noticeEl.hidden = true
  noticeEl.textContent = ''

  const [securityResult, listResult] = await Promise.allSettled([
    sourceTabId ? rpc<SiteSecurity>(IPC_ROUTES.securitySite, { tabId: sourceTabId }) : Promise.resolve(null),
    rpc<CertificateListResponse>(IPC_ROUTES.certificateList, {})
  ])

  const security = securityResult.status === 'fulfilled' ? securityResult.value : null
  const listed = listResult.status === 'fulfilled' ? listResult.value : null
  const observed = siteItems(listed?.siteCertificates)
  const failures = errorItems(listed?.certificates)
  const sourceSnapshot = sourceTabId
    ? observed.find((item) => (
        String(item.tabId || '') === sourceTabId &&
        (!security?.origin || sameOrigin(item.origin, security.origin))
      )) || null
    : null
  const sourceFingerprint = String(
    asSiteCertificate(security?.certificate)?.fingerprint ||
    asSiteCertificate(sourceSnapshot?.certificate)?.fingerprint ||
    ''
  )
  const otherObserved = observed.filter((item) => !(
    sourceTabId &&
    String(item.tabId || '') === sourceTabId &&
    String(asSiteCertificate(item.certificate)?.fingerprint || '') === sourceFingerprint
  ))

  renderSource(security, sourceSnapshot)
  renderObserved(otherObserved)
  renderErrors(failures)

  if (listResult.status === 'rejected') {
    noticeEl.hidden = false
    noticeEl.textContent = `无法读取本会话证书记录：${errorMessage(listResult.reason)}`
  } else if (sourceTabId && securityResult.status === 'rejected') {
    noticeEl.hidden = false
    noticeEl.textContent = `无法读取来源站点：${errorMessage(securityResult.reason)}`
  } else if (!sourceTabId) {
    noticeEl.hidden = false
    noticeEl.textContent =
      '从地址栏左端的站点信息面板点击「查看详情」，可直接检查当前站点；侧栏入口展示本次会话已读取的站点证书。'
  }

  const sourceMissing = security?.error === 'tab-not-found' || security?.error === 'no-active-tab'
  const sourceAvailable = security?.certificate ||
    (!sourceMissing && security?.secure !== false ? sourceSnapshot?.certificate : null)
  const sourceState = sourceAvailable ? '来源站点已读取' : '来源站点未读取'
  statusEl.textContent = `${sourceTabId ? sourceState : '本会话'} · 校验失败 ${failures.length} 条`
  refreshButton.disabled = false
}

refreshButton.addEventListener('click', () => { void refresh() })
void refresh()
