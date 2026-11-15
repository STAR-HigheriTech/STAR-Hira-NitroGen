import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAppRoot } from '@hira-ng/shared-utils'
import { isHiraResourceHost } from '@hira-ng/shared-types/src/page-resource-hosts.mjs'

type SenderFrameLike = {
  url?: unknown
  detached?: unknown
  parent?: unknown
  processId?: unknown
  routingId?: unknown
}
type SenderEventLike = {
  senderFrame?: SenderFrameLike | null
  sender?: { mainFrame?: SenderFrameLike | null } | null
}

export type IpcSenderSurface = 'trusted-ui' | 'web-preload' | 'web-preload-frame' | 'extension' | 'untrusted'

const FILE_RENDERER_ROOT = path.resolve(getAppRoot(), 'out', 'renderer')
const DEV_RENDERER_ORIGIN = (() => {
  const raw = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
  if (!raw) return ''
  try { return new URL(raw).origin } catch (_) { return '' }
})()

function isInside(root: string, candidate: string): boolean {
  const normalRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  return normalCandidate === normalRoot || normalCandidate.startsWith(normalRoot + path.sep)
}

/**
 * Renderer URLs that may call the application IPC surface.
 *
 * `hira://p-*` belongs to installable plugins and deliberately never reaches the
 * full application bridge. Community plugin UI uses the declarative sandboxed UI
 * channel instead. The file branch is restricted to compiled renderer documents,
 * not arbitrary local files a user may have saved on disk.
 */
export function isTrustedIpcUrl(raw: unknown): boolean {
  let url: URL
  try { url = new URL(String(raw || '')) } catch (_) { return false }

  if (url.protocol === 'hira:') {
    const host = String(url.hostname || '').toLowerCase()
    return /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(host)
      && !host.startsWith('p-')
      && !isHiraResourceHost(host)
  }

  if (url.protocol === 'file:') {
    try { return isInside(FILE_RENDERER_ROOT, path.resolve(fileURLToPath(url))) } catch (_) { return false }
  }

  return !!DEV_RENDERER_ORIGIN && url.origin === DEV_RENDERER_ORIGIN
}

function isSameFrame(frame: SenderFrameLike, mainFrame: SenderFrameLike): boolean {
  if (frame === mainFrame) return true
  return typeof frame.processId === 'number'
    && typeof frame.routingId === 'number'
    && frame.processId === mainFrame.processId
    && frame.routingId === mainFrame.routingId
}

/** Resolve the authenticated top-level frame without using the mutable webContents URL. */
function topLevelFrame(event: unknown): SenderFrameLike | null {
  if (!event || typeof event !== 'object') return null
  const input = event as SenderEventLike
  const frame = input.senderFrame
  // Never fall back to `sender.getURL()`: it can already point at a newer document
  // while the message originated in the previous document.
  if (!frame || frame.detached === true || !frame.url) return null
  const mainFrame = input.sender?.mainFrame
  if (mainFrame) return isSameFrame(frame, mainFrame) ? frame : null
  return frame.parent === null || frame.parent === undefined ? frame : null
}

function liveSenderFrame(event: unknown): SenderFrameLike | null {
  if (!event || typeof event !== 'object') return null
  const frame = (event as SenderEventLike).senderFrame
  return frame && frame.detached !== true && frame.url ? frame : null
}

/**
 * Classify the trusted boundary of an IPC sender. The application shell and the
 * web preload have intentionally different route audiences; both still require a
 * live top-level frame.
 */
export function ipcSenderSurface(event: unknown): IpcSenderSurface {
  const frame = liveSenderFrame(event)
  if (!frame) return 'untrusted'
  let url: URL
  try { url = new URL(String(frame.url || '')) } catch (_) { return 'untrusted' }
  const top = topLevelFrame(event)
  if (top && isTrustedIpcUrl(url.href)) return 'trusted-ui'
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return top ? 'web-preload' : 'web-preload-frame'
  }
  if (url.protocol === 'file:') return 'web-preload'
  if (url.protocol === 'chrome-extension:') return 'extension'
  return 'untrusted'
}

export function isTrustedIpcSender(event: unknown): boolean {
  return ipcSenderSurface(event) === 'trusted-ui'
}

export function isWebPreloadIpcSender(event: unknown): boolean {
  return ipcSenderSurface(event) === 'web-preload'
}

