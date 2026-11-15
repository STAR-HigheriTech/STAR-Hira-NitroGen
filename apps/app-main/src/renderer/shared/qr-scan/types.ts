export interface QrRect {
  x: number
  y: number
  width: number
  height: number
}

export interface QrFrameGeometry {
  ok: boolean
  open?: boolean
  crop?: QrRect | null
  display?: QrRect | null
  reason?: string
}

export interface QrCaptureFrame {
  ok: boolean
  reason?: string
  width?: number
  height?: number
  data?: Uint8Array
  framed?: boolean
  busy?: boolean
}

export interface QrDetector {
  kind: 'native' | 'library'
  detect(img: ImageData): Promise<string[]>
}

export interface QrScanResult {
  ok: boolean
  texts?: string[]
  busy?: boolean
  reason?: string
}

export interface QrFrameClient {
  frameGeometry(): Promise<QrFrameGeometry>
  captureScreen(options?: { displayId?: string }): Promise<QrCaptureFrame>
}

export interface QrScanner {
  start(): Promise<QrScanResult>
  stop(): void
  readonly isReady: boolean
  readonly isStreaming?: boolean
  scanOnce(displayId?: string): Promise<QrScanResult>
}
