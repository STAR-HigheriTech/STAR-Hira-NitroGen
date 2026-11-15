/** Stable plugin identity rule shared by manifests, installers, market and storage. */
export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const PLUGIN_ID_MAX_LENGTH = 64

export function isPluginId(value: unknown): value is string {
  if (typeof value !== 'string' || !PLUGIN_ID_PATTERN.test(value) || value.endsWith('.')) return false
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
}

export function normalizePluginId(value: unknown): string | null {
  const id = String(value == null ? '' : value).trim()
  return isPluginId(id) ? id : null
}

