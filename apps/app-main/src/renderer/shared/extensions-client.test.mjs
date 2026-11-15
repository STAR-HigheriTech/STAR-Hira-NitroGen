import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'

let invoke
let subscribe
let extensionsClient

beforeEach(async () => {
  invoke = vi.fn()
  subscribe = vi.fn()
  globalThis.window = {
    hira: {
      provider: { invoke },
      on: { subscribe }
    }
  }
  vi.resetModules()
  ;({ extensionsClient } = await import('./extensions-client.js'))
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('extensionsClient', () => {
  it('将所有扩展和广告拦截请求映射到对应 IPC 路由及参数', () => {
    extensionsClient.list()
    extensionsClient.install('C:/extensions/demo')
    extensionsClient.uninstall('extension-1')
    extensionsClient.toggle('extension-1', false)
    extensionsClient.importFolder()
    extensionsClient.adblockerStatus()
    extensionsClient.adblockerToggle(true)
    extensionsClient.adblockerBlockedCount()
    extensionsClient.runtimeStatus('extension-1')
    extensionsClient.reload('extension-1')
    extensionsClient.diagnostics('extension-1')
    extensionsClient.warnings('extension-1')

    expect(invoke.mock.calls).toEqual([
      [IPC_ROUTES.extensionList, undefined],
      [IPC_ROUTES.extensionInstall, { path: 'C:/extensions/demo' }],
      [IPC_ROUTES.extensionUninstall, { id: 'extension-1' }],
      [IPC_ROUTES.extensionToggle, { id: 'extension-1', enabled: false }],
      [IPC_ROUTES.extensionImportFolder, undefined],
      [IPC_ROUTES.adblockerStatus, undefined],
      [IPC_ROUTES.adblockerToggle, { enabled: true }],
      [IPC_ROUTES.adblockerBlockedCount, undefined],
      [IPC_ROUTES.extensionRuntimeStatus, { id: 'extension-1' }],
      [IPC_ROUTES.extensionReload, { id: 'extension-1' }],
      [IPC_ROUTES.extensionDiagnostics, { id: 'extension-1' }],
      [IPC_ROUTES.extensionWarnings, { id: 'extension-1' }]
    ])
  })

  it('复用桥订阅，隔离监听器异常，并在最后退订时释放桥订阅', () => {
    const unsubscribeBridge = vi.fn()
    let dispatch
    subscribe.mockImplementation((event, listener) => {
      expect(event).toBe(IPC_EVENTS.extensionChanged)
      dispatch = listener
      return unsubscribeBridge
    })
    const failingListener = vi.fn(() => { throw new Error('listener failure') })
    const healthyListener = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const stopFailing = extensionsClient.onChanged(failingListener)
    const stopHealthy = extensionsClient.onChanged(healthyListener)

    expect(subscribe).toHaveBeenCalledOnce()
    dispatch({ id: 'extension-1', type: 'reloaded' })

    expect(failingListener).toHaveBeenCalledWith({ id: 'extension-1', type: 'reloaded' })
    expect(healthyListener).toHaveBeenCalledWith({ id: 'extension-1', type: 'reloaded' })
    expect(error).toHaveBeenCalledOnce()

    stopFailing()
    expect(unsubscribeBridge).not.toHaveBeenCalled()
    stopHealthy()
    expect(unsubscribeBridge).toHaveBeenCalledOnce()

    error.mockRestore()
  })
})
