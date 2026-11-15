/** 插件浮层在主进程与渲染宿主之间传递的稳定记录。 */
export interface PluginOverlayRecord {
  key: string
  pluginId: string
  id: string
  title: string
  url: string
  anchor: string
  width: number
  height: number
  modal: boolean
}

export interface PluginOverlaySnapshot {
  items: PluginOverlayRecord[]
}

export interface PluginOverlayHidePayload {
  key?: string
}

export function isPluginOverlayRecord(value: unknown): value is PluginOverlayRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<PluginOverlayRecord>
  return typeof record.key === 'string' && record.key !== '' && typeof record.url === 'string' && record.url !== ''
}
