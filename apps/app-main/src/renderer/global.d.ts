import type { RendererBridge } from './shared/bridge'

declare global {
  interface Window {
    hira: RendererBridge
    __hiraPanelUiPluginId?: string
  }

  interface DetectedBarcode {
    rawValue: string
  }

  interface BarcodeDetectorInstance {
    detect(source: ImageData): Promise<DetectedBarcode[]>
  }

  interface BarcodeDetectorConstructor {
    new (options?: { formats?: string[] }): BarcodeDetectorInstance
    getSupportedFormats?(): Promise<string[]>
  }

  var BarcodeDetector: BarcodeDetectorConstructor | undefined

  interface WindowControlsOverlay extends EventTarget {
    readonly visible: boolean
    getTitlebarAreaRect(): DOMRect
  }

  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay
  }

  interface ImportMeta {
    glob<T = unknown>(
      pattern: string | string[],
      options?: { eager?: false; import?: string; query?: string }
    ): Record<string, () => Promise<T>>
  }
}

export {}
