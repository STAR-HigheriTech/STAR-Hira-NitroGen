/**
 * hira:// hosts that serve resources rather than privileged application documents.
 * Top-level navigation to one of these must never receive the shell IPC bridge.
 */
export const HIRA_RESOURCE_HOSTS = Object.freeze([
  'favicon',
  'extension-icon',
  'page-icon',
  'pdfjs',
  'shared'
] as const)

const HIRA_RESOURCE_HOST_SET = new Set<string>(HIRA_RESOURCE_HOSTS)

export function isHiraResourceHost(host: unknown): boolean {
  return HIRA_RESOURCE_HOST_SET.has(String(host || '').toLowerCase())
}
