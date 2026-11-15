export const CAPTURE_HUB_TARGETS = Object.freeze([
  ['reading', '稍后读'],
  ['notes', '集锦'],
  ['bookmark', '书签'],
  ['easel', '画板']
])

export type CaptureHubTarget = 'reading' | 'notes' | 'bookmark' | 'easel'
export type CaptureHubSourceKind = 'page' | 'selection' | 'link' | 'image'

export interface CaptureHubSource {
  tabId: string
  url: string
  title: string
  selection: string
  kind: CaptureHubSourceKind
  referer?: string
}

export interface CaptureHubPayload extends CaptureHubSource {
  suggestedTitle?: string
}

export interface CaptureHubCommit {
  target: CaptureHubTarget
  title?: string
  text?: string
  tags?: string[]
  source: CaptureHubSource
}
