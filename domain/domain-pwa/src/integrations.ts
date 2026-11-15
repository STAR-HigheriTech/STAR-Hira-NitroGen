/**
 * PWA 文件 / 协议处理器的纯解析与启动 URL 解析。
 * 系统注册属于 APPS 层；这里只认识 manifest 形状与同源约束。
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function resolvedUrl(value: unknown, baseUrl: string): string {
  try {
    const url = new URL(String(value || ''), baseUrl)
    return url.origin === new URL(baseUrl).origin ? url.href : ''
  } catch {
    return ''
  }
}

export interface PwaFileHandler {
  action: string
  extensions: string[]
  mimeTypes: string[]
}

export interface PwaProtocolHandler {
  protocol: string
  url: string
}

export interface PwaIntegrations {
  files: PwaFileHandler[]
  protocols: PwaProtocolHandler[]
}

const BLOCKED_FILE_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.scr', '.ps1', '.psm1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.lnk', '.reg', '.jar',
  '.dll', '.cpl', '.hta', '.pif', '.application'
])

const RESERVED_PROTOCOLS = new Set([
  'http', 'https', 'file', 'javascript', 'data', 'blob', 'about',
  'hira', 'chrome-extension', 'devtools', 'view-source'
])

export function manifestSource(manifestJson: unknown): Record<string, unknown> {
  const parsed = record(manifestJson)
  return record(parsed.raw || parsed.manifest || parsed)
}

export function parsePwaIntegrations(manifestJson: unknown, startUrl: string): PwaIntegrations {
  const raw = manifestSource(manifestJson)
  const files: PwaFileHandler[] = []
  for (const item of Array.isArray(raw.file_handlers) ? raw.file_handlers : []) {
    const value = record(item)
    const action = resolvedUrl(value.action, startUrl)
    if (!action) continue
    const accept = record(value.accept)
    const extensions = new Set<string>()
    const mimeTypes = new Set<string>()
    for (const [mime, list] of Object.entries(accept)) {
      mimeTypes.add(mime.toLowerCase())
      for (const extValue of Array.isArray(list) ? list : []) {
        const ext = String(extValue || '').trim().toLowerCase()
        if (/^\.[a-z0-9][a-z0-9.+-]{0,31}$/.test(ext) && !BLOCKED_FILE_EXTENSIONS.has(ext)) extensions.add(ext)
      }
    }
    if (extensions.size) files.push({ action, extensions: [...extensions].slice(0, 64), mimeTypes: [...mimeTypes].slice(0, 32) })
  }
  const protocols: PwaProtocolHandler[] = []
  for (const item of Array.isArray(raw.protocol_handlers) ? raw.protocol_handlers : []) {
    const value = record(item)
    const protocol = String(value.protocol || '').trim().toLowerCase().replace(/:$/, '')
    if (!/^[a-z][a-z0-9+.-]{1,31}$/.test(protocol) || RESERVED_PROTOCOLS.has(protocol)) continue
    const url = resolvedUrl(value.url, startUrl)
    if (url) protocols.push({ protocol, url })
  }
  return { files: files.slice(0, 32), protocols: protocols.slice(0, 32) }
}

export function resolvePwaFileLaunch(manifestJson: unknown, startUrl: string, file: string): string | null {
  const target = String(file || '')
  const ext = /\.[a-z0-9]+$/i.exec(target)?.[0]?.toLowerCase() || ''
  const handler = parsePwaIntegrations(manifestJson, startUrl).files
    .find((item) => item.extensions.includes(ext))
  if (!handler) return null
  const fileUrl = `file:///${target.replace(/\\/g, '/').replace(/^\/+/, '')}`
  try {
    if (handler.action.includes('%s')) {
      return new URL(handler.action.replace('%s', encodeURIComponent(fileUrl))).href
    }
    const url = new URL(handler.action)
    url.searchParams.set('file', fileUrl)
    return url.href
  } catch {
    return null
  }
}

export function resolvePwaProtocolLaunch(manifestJson: unknown, startUrl: string, protocolUrl: string): string | null {
  let protocol = ''
  try { protocol = new URL(protocolUrl).protocol.replace(/:$/, '').toLowerCase() } catch { return null }
  const handler = parsePwaIntegrations(manifestJson, startUrl).protocols.find((item) => item.protocol === protocol)
  if (!handler) return null
  try {
    if (handler.url.includes('%s')) {
      return new URL(handler.url.replace('%s', encodeURIComponent(protocolUrl))).href
    }
    const url = new URL(handler.url)
    url.searchParams.set('url', protocolUrl)
    return url.href
  } catch {
    return null
  }
}
