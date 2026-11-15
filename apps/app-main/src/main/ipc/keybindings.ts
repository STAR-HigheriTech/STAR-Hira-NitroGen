import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

const { createProviderInvoker } = require('./provider-bridge.js') as {
  createProviderInvoker(registry: unknown): <T>(capability: string, fallback: () => T | Promise<T>, input: unknown) => T | Promise<T>
}

interface KeybindingsService {
  getKeybindings(): unknown
  getDefaults(): unknown
  setKeybinding(action: unknown, combo: unknown): unknown
  resetKeybinding(action: unknown): unknown
  reset(): unknown
  setRecording(recording: unknown, sender: unknown): unknown
}

interface KeybindingsIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['keybindings']
  keybindings?: KeybindingsService | null
  providerRegistry: unknown
}

export function registerKeybindingsIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, keybindings, providerRegistry }: KeybindingsIpcContext
): void {
  if (!keybindings) return

  const invoke = createProviderInvoker(providerRegistry)

  typedMain.handle(routes.keybindingsGet, {
    requestSchema: schemas.get.request,
    responseSchema: schemas.get.response,
    handler: async () => invoke('keybindings.get', () => keybindings.getKeybindings(), null)
  })

  typedMain.handle(routes.keybindingsDefaults, {
    requestSchema: schemas.defaults.request,
    responseSchema: schemas.defaults.response,
    handler: async () => invoke('keybindings.defaults', () => keybindings.getDefaults(), null)
  })

  typedMain.handle(routes.keybindingsSet, {
    requestSchema: schemas.set.request,
    responseSchema: schemas.set.response,
    handler: async (_event, req) => {
      const combo = await invoke(
        'keybindings.set',
        () => keybindings.setKeybinding(req.action, req.combo),
        req
      )
      return { ok: true, combo }
    }
  })

  typedMain.handle(routes.keybindingsResetOne, {
    requestSchema: schemas.resetOne.request,
    responseSchema: schemas.resetOne.response,
    handler: async (_event, req) => {
      const combo = await invoke(
        'keybindings.reset-one',
        () => keybindings.resetKeybinding(req.action),
        req
      )
      return { ok: true, combo }
    }
  })

  typedMain.handle(routes.keybindingsReset, {
    requestSchema: schemas.reset.request,
    responseSchema: schemas.reset.response,
    handler: async () => {
      await invoke('keybindings.reset', () => keybindings.reset(), null)
      return { ok: true }
    }
  })

  // 录制让位：把「按键分发暂停」绑定到**发起请求的那个 webContents** 上 ——
  // 页面关掉 / 跳走时由管理器自动复位，不会留下"全局快捷键永久失灵"的幽灵状态。
  typedMain.handle(routes.keybindingsSetRecording, {
    requestSchema: schemas.setRecording.request,
    responseSchema: schemas.setRecording.response,
    handler: async (event, req) => {
      await invoke(
        'keybindings.set-recording',
        () => keybindings.setRecording(req.recording, event && typeof event === 'object' && 'sender' in event ? event.sender : null),
        req
      )
      return { ok: true }
    }
  })
}

