/**
 * 浏览器源注册表（唯一真源）
 *
 * 新增一个浏览器 = 在 SOURCES 里加一个 adapter 工厂的返回值；
 *   · IPC 响应结构不变（id / label / available / capabilities / profiles）；
 *   · 导入管线不变（resolveProfile → copy → parse → write）；
 *   · 页面不变（按能力位渲染数据项）。
 * 任何「如果是 Edge 就……」的分支都不应该出现在注册表之外。
 */
import {
  createChromiumSource,
  windowsUserDataDirs,
  type BrowserProfileSummary,
  type ChromiumSource
} from './chromium'

export interface DetectedSource {
  id: string
  label: string
  available: boolean
  capabilities: number
  profiles: BrowserProfileSummary[]
}

export interface DetectedSourceList {
  ok: boolean
  sources: DetectedSource[]
}

export const SOURCES: ChromiumSource[] = [
  createChromiumSource({
    id: 'chrome',
    label: 'Google Chrome',
    userDataDirs: [
      ...windowsUserDataDirs('Google', 'Chrome'),
      ...windowsUserDataDirs('Chromium')
    ]
  }),
  createChromiumSource({
    id: 'edge',
    label: 'Microsoft Edge',
    userDataDirs: [
      ...windowsUserDataDirs('Microsoft', 'Edge'),
      ...windowsUserDataDirs('Microsoft', 'Edge Beta')
    ]
  })
]

export function findSource(sourceId: unknown): ChromiumSource | null {
  const id = String(sourceId || '').trim()
  return SOURCES.find((source) => source.id === id) || null
}

/**
 * 探测本机可用的浏览器源。
 * 单个源探测失败不影响其它源 —— 每个 adapter 自己兜住异常。
 *
 * @returns {{ ok: boolean, sources: Array<{id:string,label:string,available:boolean,capabilities:number,profiles:Array<{id:string,name:string,capabilities:number}>}> }}
 */
export function listDetectedSources(): DetectedSourceList {
  const sources: DetectedSource[] = SOURCES.map((source) => {
    const detected = source.listProfiles()
    return {
      id: source.id,
      label: source.label,
      capabilities: source.capabilities,
      available: Boolean(detected.ok && detected.profiles.length > 0),
      profiles: detected.ok ? detected.profiles : []
    }
  })
  return { ok: true, sources }
}

