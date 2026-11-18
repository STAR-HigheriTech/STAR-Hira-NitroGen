/**
 * 证书兜底探针：只做一次 TLS 握手，不发 HTTP 请求。
 *
 * Electron 的 CDP `Network.getCertificate` 在部分定制构建 / 代理链路里会返回空表。
 * 证书页仍需要可读结果，因此用 Node 的 TLS 客户端读取同源服务器证书链。
 * `rejectUnauthorized:false` 只用于“读取已发生连接对应的证书”，不会放行或改变
 * 正在浏览页面的连接策略；这里也绝不发送页面数据。
 */

const net = require('node:net')
const tls = require('node:tls')

const TIMEOUT_MS = 5_000
const CHAIN_MAX = 16

interface TlsProbeResult {
  tableNames: string[]
  error: string | null
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'tls-failed'
  const code = String((error as { code?: unknown }).code || '').trim()
  return code ? `tls-${code.toLowerCase()}` : 'tls-failed'
}

function fetchCertificateTableViaTls(origin: string): Promise<TlsProbeResult> {
  let url: URL
  try {
    url = new URL(origin)
  } catch (_) {
    return Promise.resolve({ tableNames: [], error: 'invalid-origin' })
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    return Promise.resolve({ tableNames: [], error: null })
  }

  const host = url.hostname
  const port = Number(url.port || 443)

  return new Promise((resolve) => {
    let settled = false
    let socket: import('node:tls').TLSSocket | null = null

    const finish = (result: TlsProbeResult): void => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch (_) {}
      resolve(result)
    }

    try {
      const client = tls.connect({
        host,
        port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: false,
        ALPNProtocols: ['h2', 'http/1.1']
      }, () => {
        try {
          const tableNames: string[] = []
          const seen = new Set<string>()
          let current: import('node:tls').DetailedPeerCertificate | undefined =
            client.getPeerCertificate(true)
          while (current && current.raw && current.raw.length) {
            const encoded = current.raw.toString('base64')
            if (!encoded || seen.has(encoded)) break
            seen.add(encoded)
            tableNames.push(encoded)
            if (tableNames.length >= CHAIN_MAX) break
            const issuer = current.issuerCertificate
            if (!issuer || issuer === current) break
            current = issuer
          }
          finish({
            tableNames,
            error: tableNames.length ? null : 'tls-certificate-empty'
          })
        } catch (error) {
          finish({ tableNames: [], error: errorCode(error) })
        }
      })
      socket = client
      client.setTimeout(TIMEOUT_MS, () => finish({ tableNames: [], error: 'tls-timeout' }))
      client.once('error', (error) => finish({ tableNames: [], error: errorCode(error) }))
    } catch (error) {
      finish({ tableNames: [], error: errorCode(error) })
    }
  })
}

module.exports = { fetchCertificateTableViaTls }
