export interface RendererProvider {
  invoke<T = JsonRecord>(route: string, payload?: unknown): Promise<T>
  send(route: string, payload?: unknown): void
}

export interface RendererEvents {
  subscribe<T = JsonRecord>(route: string, listener: (payload: T) => void): () => void
}

export interface RendererFiles {
  pathFor(file: File): string
}

export interface RendererBridge {
  provider: RendererProvider
  on: RendererEvents
  files?: RendererFiles
}

export type JsonRecord = Record<string, unknown>

export function getHiraBridge(): RendererBridge {
  const bridge = (globalThis.window as unknown as { hira?: RendererBridge } | undefined)?.hira
  if (!bridge?.provider || typeof bridge.provider.invoke !== 'function' || !bridge.on) {
    throw new Error('window.hira.provider is unavailable')
  }
  return {
    provider: {
      invoke: <T = JsonRecord>(route: string, payload?: unknown): Promise<T> => bridge.provider.invoke<T>(route, payload),
      send: (route: string, payload?: unknown): void => {
        bridge.provider.send?.(route, payload)
      }
    },
    on: bridge.on,
    files: bridge.files
  }
}
