import { BrowserWindow, dialog, type App, type Certificate, type Event, type WebContents } from 'electron'
import { onWebContentsDestroyed } from '@hira-ng/infra-window'

export interface CertificateErrorRecord {
  url: string
  error: string
  at: number
  subjectName: string | null
  issuerName: string | null
  serialNumber: string | null
  validStart: number | null
  validExpiry: number | null
  fingerprint: string | null
  /** 内部隔离键；IPC schema 不向渲染层暴露 */
  scopeKey?: string
}

interface TlsTrustOptions {
  onCertificateError?(record: CertificateErrorRecord, webContents: WebContents): void
}

const TEMP_TRUST_MS = 30_000
const MAX_CLIENT_CERTIFICATES = 10

function dateValue(value: unknown): number | null {
  if (!value) return null
  const parsed = new Date(value as string | number | Date).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function errorHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host
  } catch {
    return rawUrl
  }
}

function trustKey(url: string, error: string, certificate: Certificate | null): string {
  const fingerprint = certificate && certificate.fingerprint ? String(certificate.fingerprint) : ''
  return `${errorHost(url)}\n${error}\n${fingerprint}`
}

function ownerOf(webContents: WebContents | null | undefined): BrowserWindow | null {
  if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) return null
  try {
    return BrowserWindow.fromWebContents(webContents)
  } catch {
    return null
  }
}

function showMessageBox(win: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options)
}

function certificateButtons(certificates: Certificate[]): string[] {
  return certificates.map((certificate, index) => {
    const subject = String(certificate.subjectName || `证书 ${index + 1}`)
    const issuer = String(certificate.issuerName || '').trim()
    return issuer ? `${subject} — ${issuer}` : subject
  })
}

export function createTlsTrustController(options: TlsTrustOptions = {}) {
  let attached = false
  const temporaryTrust = new Map<number, Map<string, number>>()
  const watchedContents = new Map<number, () => void>()

  function clearTemporaryTrust(contentsId: number): void {
    temporaryTrust.delete(contentsId)
  }

  function watchWebContents(webContents: WebContents): void {
    let id = -1
    try { id = webContents.id } catch { return }
    if (watchedContents.has(id)) return

    const onNavigate = (
      _event: Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame !== false && isInPlace !== true) clearTemporaryTrust(id)
    }
    let offDestroyed = (): void => {}
    const cleanup = (): void => {
      watchedContents.delete(id)
      clearTemporaryTrust(id)
      try { webContents.removeListener('did-start-navigation', onNavigate) } catch {}
      offDestroyed()
      offDestroyed = () => {}
    }
    try {
      webContents.on('did-start-navigation', onNavigate)
      offDestroyed = onWebContentsDestroyed(webContents, cleanup)
      watchedContents.set(id, cleanup)
    } catch {
      try { webContents.removeListener('did-start-navigation', onNavigate) } catch {}
      offDestroyed()
    }
  }

  function isTemporarilyTrusted(webContents: WebContents, key: string): boolean {
    let id = -1
    try { id = webContents.id } catch { return false }
    const grants = temporaryTrust.get(id)
    const trustedUntil = grants?.get(key) || 0
    if (trustedUntil > Date.now()) return true
    if (grants && trustedUntil) grants.delete(key)
    if (grants && grants.size === 0) temporaryTrust.delete(id)
    return false
  }

  function trustTemporarily(webContents: WebContents, key: string): void {
    let id = -1
    try { id = webContents.id } catch { return }
    watchWebContents(webContents)
    let grants = temporaryTrust.get(id)
    if (!grants) {
      grants = new Map()
      temporaryTrust.set(id, grants)
    }
    grants.set(key, Date.now() + TEMP_TRUST_MS)
  }

  function onceCallback<T>(callback: (value?: T) => void): (value?: T) => void {
    let settled = false
    return (value?: T): void => {
      if (settled) return
      settled = true
      try { callback(value) } catch {}
    }
  }

  const handleCertificateError = (
    event: Event,
    webContents: WebContents,
    url: string,
    error: string,
    certificate: Certificate,
    callback: (trusted: boolean) => void
  ): void => {
    if (!webContents || webContents.isDestroyed()) {
      try { event.preventDefault() } catch {}
      try { callback(false) } catch {}
      return
    }
    const record: CertificateErrorRecord = {
      url: String(url || ''),
      error: String(error || ''),
      at: Date.now(),
      subjectName: certificate && certificate.subjectName ? String(certificate.subjectName) : null,
      issuerName: certificate && certificate.issuerName ? String(certificate.issuerName) : null,
      serialNumber: certificate && certificate.serialNumber ? String(certificate.serialNumber) : null,
      validStart: certificate ? dateValue(certificate.validStart) : null,
      validExpiry: certificate ? dateValue(certificate.validExpiry) : null,
      fingerprint: certificate && certificate.fingerprint ? String(certificate.fingerprint) : null
    }
    try {
      options.onCertificateError?.(record, webContents)
    } catch {}

    const key = trustKey(url, error, certificate)
    if (isTemporarilyTrusted(webContents, key)) {
      event.preventDefault()
      try { callback(true) } catch {}
      return
    }

    event.preventDefault()
    watchWebContents(webContents)
    let offDestroyed = (): void => {}
    const settle = onceCallback<boolean>((trusted) => {
      offDestroyed()
      offDestroyed = () => {}
      callback(trusted === true)
    })
    offDestroyed = onWebContentsDestroyed(webContents, () => settle(false))
    const host = errorHost(String(url || ''))
    let prompt: Promise<Electron.MessageBoxReturnValue>
    try {
      prompt = showMessageBox(ownerOf(webContents), {
        type: 'warning',
        title: '证书不受信任',
        message: `${host} 的安全证书无效`,
        detail: [
          `原因：${String(error || '证书验证失败')}`,
          record.issuerName ? `签发者：${record.issuerName}` : '',
          '继续访问会降低连接安全性，只应在你信任该网络和站点时使用。'
        ].filter(Boolean).join('\n'),
        buttons: ['返回安全页面', '仅本次继续'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
    } catch {
      settle(false)
      return
    }
    void prompt.then((result) => {
      if (result.response !== 1) {
        settle(false)
        return
      }
      trustTemporarily(webContents, key)
      settle(true)
    }).catch(() => settle(false))
  }

  const handleSelectClientCertificate = (
    event: Event,
    webContents: WebContents,
    url: string,
    certificates: Certificate[],
    callback: (certificate?: Certificate) => void
  ): void => {
    if (!webContents || webContents.isDestroyed()) {
      try { event.preventDefault() } catch {}
      try { callback() } catch {}
      return
    }
    const list = Array.isArray(certificates) ? certificates.slice(0, MAX_CLIENT_CERTIFICATES) : []
    if (list.length === 0) {
      event.preventDefault()
      try { callback() } catch {}
      return
    }
    event.preventDefault()
    let offDestroyed = (): void => {}
    const settle = onceCallback<Certificate>((certificate) => {
      offDestroyed()
      offDestroyed = () => {}
      callback(certificate)
    })
    offDestroyed = onWebContentsDestroyed(webContents, () => settle())
    const labels = certificateButtons(list)
    const buttons = [...labels, '取消']
    let prompt: Promise<Electron.MessageBoxReturnValue>
    try {
      prompt = showMessageBox(ownerOf(webContents), {
        type: 'question',
        title: '选择客户端证书',
        message: `${errorHost(String(url || ''))} 请求验证你的身份`,
        detail: list.length > 1 ? '请选择用于本次连接的证书。' : '将使用下列证书完成身份验证。',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true
      })
    } catch {
      settle()
      return
    }
    void prompt.then((result) => {
      const selected = list[result.response]
      settle(selected)
    }).catch(() => settle())
  }

  function attach(app: App): void {
    if (attached) return
    attached = true
    app.on('certificate-error', handleCertificateError)
    app.on('select-client-certificate', handleSelectClientCertificate)
  }

  function dispose(app: App): void {
    if (!attached) return
    attached = false
    app.removeListener('certificate-error', handleCertificateError)
    app.removeListener('select-client-certificate', handleSelectClientCertificate)
    temporaryTrust.clear()
    for (const cleanup of [...watchedContents.values()]) {
      try { cleanup() } catch {}
    }
    watchedContents.clear()
  }

  return { attach, dispose }
}
