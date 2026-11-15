import { beforeEach, describe, expect, it, vi } from 'vitest'
import Module, { createRequire } from 'node:module'

const mocks = (() => {
  const state = {
    extensions: [],
    extensionListeners: new Map(),
    sessionListenersCleared: false,
    extensionListenersCleared: false,
    crxSessions: [],
    resolver: null,
    webStoreOptions: null,
    addedTabs: [],
    removedTabs: [],
    selectedTabs: [],
    contextMenuItems: [],
    blocker: null
  }

  const extensionApi = {
    getAllExtensions: vi.fn(() => state.extensions),
    loadExtension: vi.fn(async (extensionPath, options) => {
      const extension = {
        id: extensionPath.includes('broken') ? 'broken' : 'extension-1',
        name: extensionPath.includes('broken') ? 'Broken' : 'Example Extension',
        version: '1.0.0',
        path: extensionPath,
        manifest: {
          name: extensionPath.includes('broken') ? '' : 'Example Extension',
          version: '1.0.0',
          manifest_version: extensionPath.includes('broken') ? 1 : 3,
          permissions: ['tabs', 'storage'],
          optional_permissions: ['tabs', 'notifications'],
          host_permissions: ['https://example.com/*']
        }
      }
      state.extensions = state.extensions.filter((item) => item.id !== extension.id).concat(extension)
      return extension
    }),
    removeExtension: vi.fn(async (extension) => {
      // Electron 43 的真实签名是 removeExtension(extensionId: string)；
      // 兼容对象与 id 字符串两种入参，mock 才与运行时语义一致
      state.extensions = state.extensions.filter((item) => item !== extension && item.id !== extension)
    }),
    addListener: vi.fn((name, listener) => state.extensionListeners.set(name, listener)),
    removeAllListeners: vi.fn(() => {
      state.extensionListenersCleared = true
      state.extensionListeners.clear()
    })
  }

  const extSession = {
    extensions: extensionApi,
    removeAllListeners: vi.fn(() => { state.sessionListenersCleared = true })
  }

  const blocker = {
    on: vi.fn(),
    enableBlockingInSession: vi.fn(),
    disableBlockingInSession: vi.fn()
  }
  state.blocker = blocker

  return {
    state,
    extSession,
    extensionApi,
    blocker,
    ElectronChromeExtensions: class {
      constructor(options) {
        this.options = options
      }

      addTab(tab, window) {
        state.addedTabs.push([tab, window])
      }

      removeTab(tab) {
        state.removedTabs.push(tab)
      }

      selectTab(tab) {
        state.selectedTabs.push(tab)
      }

      getContextMenuItems(webContents, params) {
        return state.contextMenuItems.concat({ webContents, params })
      }

      static handleCRXProtocol(targetSession) {
        state.crxSessions.push(targetSession)
      }
    },
    reset() {
      state.extensions = []
      state.extensionListeners.clear()
      state.sessionListenersCleared = false
      state.extensionListenersCleared = false
      state.crxSessions = []
      state.resolver = null
      state.webStoreOptions = null
      state.addedTabs = []
      state.removedTabs = []
      state.selectedTabs = []
      state.contextMenuItems = []
      extensionApi.getAllExtensions.mockClear()
      extensionApi.loadExtension.mockClear()
      extensionApi.removeExtension.mockClear()
      extensionApi.addListener.mockClear()
      extensionApi.removeAllListeners.mockClear()
      extSession.removeAllListeners.mockClear()
      blocker.on.mockClear()
      blocker.enableBlockingInSession.mockClear()
      blocker.disableBlockingInSession.mockClear()
    }
  }
})()

const electron = {
  app: { getPath: vi.fn(() => 'C:\\Hira\\User Data') },
  session: { defaultSession: { id: 'default' }, fromPartition: vi.fn(() => mocks.extSession) },
  net: { fetch: vi.fn() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) }
}
const chromeExtensions = {
  ElectronChromeExtensions: mocks.ElectronChromeExtensions,
  setSessionPartitionResolver: vi.fn((resolver) => { mocks.state.resolver = resolver })
}
const webStore = {
  installChromeWebStore: vi.fn((options) => {
    mocks.state.webStoreOptions = options
    return { dispose: vi.fn() }
  }),
  // uninstall 的 crx 分支会调它（删运行时 + 删 <crxDir>/<id>）
  uninstallExtension: vi.fn(async () => {})
}
const adblocker = {
  ElectronBlocker: {
    fromPrebuiltAdsAndTracking: vi.fn(async () => mocks.blocker),
    fromPrebuiltAdsOnly: vi.fn(async () => mocks.blocker)
  }
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron
  if (request === '@iamevan/electron-chrome-extensions') return chromeExtensions
  if (request === '@iamevan/electron-chrome-web-store') return webStore
  if (request === '@ghostery/adblocker-electron') return adblocker
  return originalLoad.call(this, request, parent, isMain)
}
const require = createRequire(import.meta.url)
const { createExtensionService } = require('../dist/index.cjs')

const callbacks = {
  createTab: vi.fn(),
  selectTab: vi.fn(),
  removeTab: vi.fn(),
  createWindow: vi.fn(),
  removeWindow: vi.fn()
}

beforeEach(() => {
  mocks.reset()
  for (const callback of Object.values(callbacks)) callback.mockReset()
})

describe('infra-extensions', () => {
  it('installs the web store and adblocker, exposes adblocker state, and forwards tab lifecycle operations', async () => {
    const service = await createExtensionService({ callbacks, partition: 'persist:test', extensionsPath: 'C:\\Extensions' })
    const tab = { id: 1 }
    const window = { id: 2 }

    expect(mocks.state.webStoreOptions).toMatchObject({
      session: mocks.extSession,
      // crx 子树：与安装记录同一个扩展根（<extDir>/crx），不是第三个目录
      extensionsPath: 'C:\\Extensions\\crx',
      autoUpdate: true,
      // 必须为 false：加载权归 restore()，否则同一扩展被加载两遍、停用也会被拉回来
      loadExtensions: false,
      allowUnpackedExtensions: true
    })
    expect(typeof mocks.state.webStoreOptions.beforeInstall).toBe('function')
    expect(typeof mocks.state.webStoreOptions.afterInstall).toBe('function')
    // 不传 minimumManifestVersion = 库默认 3（仅 MV3，对齐 RT 默认口径）
    expect(mocks.state.webStoreOptions.minimumManifestVersion).toBeUndefined()
    expect(mocks.state.crxSessions).toEqual([{ id: 'default' }, mocks.extSession])
    expect(service.isAdblockerEnabled()).toBe(true)
    expect(service.setAdblockerEnabled(false)).toBe(true)
    expect(mocks.blocker.disableBlockingInSession).toHaveBeenCalledWith(mocks.extSession)
    expect(service.setAdblockerEnabled(true)).toBe(true)
    expect(mocks.blocker.enableBlockingInSession).toHaveBeenCalledTimes(2)

    service.addTab(tab, window)
    service.removeTab(tab)
    service.selectTab(tab)
    expect(mocks.state.addedTabs).toEqual([[tab, window]])
    expect(mocks.state.removedTabs).toEqual([tab])
    expect(mocks.state.selectedTabs).toEqual([tab])
  })

  it('installs, disables, enables, lists registry state, and reloads extensions with lifecycle events', async () => {
    const service = await createExtensionService({ callbacks, extensionsPath: 'C:\\Extensions', enableAdblocker: false })
    const events = []
    for (const type of ['installed', 'toggled', 'reloaded', 'loaded', 'unloaded']) {
      service.events.on(type, (payload) => events.push({ type, payload }))
    }

    await expect(service.installFromPath('C:\\Extensions\\example')).resolves.toMatchObject({ id: 'extension-1', enabled: true, isUnpacked: true })
    expect(service.getRuntimeStatus('extension-1')).toBe('loaded')
    expect(await service.toggle('extension-1', false)).toBe(true)
    expect(service.getRuntimeStatus('extension-1')).toBe('disabled')
    expect(service.listExtensions()).toEqual([expect.objectContaining({ id: 'extension-1', enabled: false, runtimeStatus: 'disabled' })])
    expect(await service.toggle('extension-1', true)).toBe(true)
    expect(service.getRuntimeStatus('extension-1')).toBe('loaded')
    expect(await service.reload('extension-1')).toBe(true)
    expect(mocks.extensionApi.loadExtension).toHaveBeenCalledWith('C:\\Extensions\\example', { allowFileAccess: true })

    const loaded = mocks.state.extensions[0]
    mocks.state.extensionListeners.get('extension-loaded')({}, loaded)
    mocks.state.extensionListeners.get('unloaded')({}, loaded)
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['installed', 'toggled', 'reloaded', 'loaded', 'unloaded']))
    expect(service.getRuntimeStatus('extension-1')).toBe('disabled')
  })

  it('reports diagnostics and permission warnings, supports missing statuses, and destroys listeners', async () => {
    const service = await createExtensionService({ callbacks, enableAdblocker: false })

    expect(service.getRuntimeStatus('missing')).toBe('missing')
    expect(service.getDiagnostics('missing')).toEqual([{ code: 'missing', severity: 'error', message: '扩展未在当前运行时加载' }])
    expect(service.getWarnings('missing')).toEqual([])
    expect(await service.reload('missing')).toBe(false)

    await service.installFromPath('C:\\Extensions\\broken')
    mocks.state.extensions[0].path = ''
    expect(service.getDiagnostics('broken')).toEqual([
      { code: 'invalid-manifest', severity: 'error', message: '扩展清单无效或不受支持' },
      { code: 'runtime-path-unavailable', severity: 'warning', message: '运行时未提供扩展路径，无法执行路径级重载' }
    ])
    expect(service.getWarnings('broken')).toEqual([
      { code: 'tabs', severity: 'warning', message: 'tabs' },
      { code: 'storage', severity: 'warning', message: 'storage' },
      { code: 'notifications', severity: 'warning', message: 'notifications' },
      { code: 'https://example.com/*', severity: 'warning', message: 'https://example.com/*' }
    ])

    service.destroy()
    expect(mocks.state.sessionListenersCleared).toBe(true)
    expect(mocks.state.extensionListenersCleared).toBe(true)
  })
})
