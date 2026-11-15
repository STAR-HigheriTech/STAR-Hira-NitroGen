/**
 * 证书页。
 *
 * ⚠ 重要前提：Chromium **没有**「列出本机全部证书」的 API。
 * 唯一能拿到 Certificate 对象的时机是 `app.on('certificate-error')` 那一次回调，
 * 因此本页展示的是**本会话内实际发生过的证书校验失败**（主进程已把它们记下来），
 * 而不是一个凭空的「证书列表」。
 *
 * 所有字段都是记录时的原样值；拿不到的项显示「未提供」，不编造。
 */
import { IPC_ROUTES, rpc, el, fmtTime, initTheme } from 'hira://shared/runtime.js'
import { errorMessage, isRecord, requiredById } from 'hira://shared/page-kit.js'

initTheme()

interface CertificateError {
  url?: string
  error?: string
  subjectName?: string
  issuerName?: string
  serialNumber?: string
  validStart?: number
  validExpiry?: number
  fingerprint?: string
  at?: number
}

interface CertificateListResponse {
  certificates?: unknown
}

const statusEl = requiredById<HTMLElement>('status')
const noticeEl = requiredById<HTMLElement>('notice')
const listEl = requiredById<HTMLElement>('list')
const refreshButton = requiredById<HTMLButtonElement>('refresh')

noticeEl.textContent =
  'Chromium 未提供「列出全部证书」的接口，因此本页只记录本会话内实际发生过的证书校验失败。' +
  '校验失败时浏览器一律**拒绝连接**并显示错误页，这里的记录不会改变该行为。'

async function refresh (): Promise<void> {
  statusEl.textContent = '读取中…'
  let data: CertificateListResponse
  try {
    data = await rpc<CertificateListResponse>(IPC_ROUTES.certificateList, {})
  } catch (e) {
    statusEl.textContent = '读取失败'
    listEl.replaceChildren(el('div', 'empty', `无法读取证书记录：${errorMessage(e)}`))
    return
  }

  const items = Array.isArray(data?.certificates)
    ? data.certificates.filter(isRecord) as CertificateError[]
    : []
  statusEl.textContent = `本会话证书校验失败：${items.length} 条`

  listEl.replaceChildren()
  if (items.length === 0) {
    listEl.appendChild(el('div', 'empty', '本会话尚未发生证书校验失败'))
    return
  }

  for (const item of items) {
    const card = el('div', 'card')
    card.appendChild(el('div', 'card-host', item.url || '（无地址）'))
    card.appendChild(el('div', 'card-error', item.error || '（无错误码）'))

    const grid = el('dl', 'card-grid')
    const add = (label: string, value: unknown): void => {
      grid.appendChild(el('dt', undefined, label))
      grid.appendChild(el('dd', undefined, value ? String(value) : '未提供'))
    }
    add('主体', item.subjectName)
    add('签发者', item.issuerName)
    add('序列号', item.serialNumber)
    add('生效时间', item.validStart ? fmtTime(item.validStart) : '')
    add('过期时间', item.validExpiry ? fmtTime(item.validExpiry) : '')
    add('指纹', item.fingerprint)
    add('记录时间', item.at ? fmtTime(item.at) : '')
    card.appendChild(grid)

    listEl.appendChild(card)
  }
}

refreshButton.addEventListener('click', refresh)
refresh()
