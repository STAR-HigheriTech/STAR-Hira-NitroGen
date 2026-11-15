export {}

declare global {
  interface HiraPageProvider {
    invoke<T = unknown>(route: string, payload?: unknown): Promise<T>
    send?(route: string, payload?: unknown): void
  }

  interface HiraPageEvents {
    subscribe<T = unknown>(route: string, listener: (payload: T) => void): () => void
  }

  interface HiraPageFiles {
    pathFor(file: File): string
  }

  interface HiraPageBridge {
    provider: HiraPageProvider
    on: HiraPageEvents
    files?: HiraPageFiles
  }

  interface Window {
    hira?: HiraPageBridge
  }

  class EyeDropper {
    open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>
  }
}
