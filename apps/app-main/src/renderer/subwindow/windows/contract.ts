export interface WindowControlsOverlayPort {
  readonly native: boolean
  dispose(): void
}

export interface SubwindowMountContext {
  type: string
  params: URLSearchParams
  content: HTMLElement
  wco: WindowControlsOverlayPort | null
}

export type SubwindowMount = (context: SubwindowMountContext) => void
