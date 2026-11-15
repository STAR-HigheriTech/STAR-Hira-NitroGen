import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { z, ipcSchemas, createTypedIpcMain, createTypedIpcRenderer } = require('../dist/index.cjs')

describe('infra-ipc', () => {
  it('validates request and response with zod', async () => {
    const handlers = new Map()

    const ipcMain = {
      handle(channel, fn) {
        handlers.set(channel, fn)
      }
    }

    const ipcRenderer = {
      invoke(channel, payload) {
        const fn = handlers.get(channel)
        if (!fn) throw new Error('missing handler')
        return fn({ sender: { id: 'test' } }, payload)
      }
    }

    const main = createTypedIpcMain(ipcMain)
    const renderer = createTypedIpcRenderer(ipcRenderer)

    main.handle('sum', {
      requestSchema: z.object({ a: z.number(), b: z.number() }),
      responseSchema: z.object({ s: z.number() }),
      handler: async (_event, req) => ({ s: req.a + req.b })
    })

    const ok = await renderer.invoke(
      'sum',
      { requestSchema: z.object({ a: z.number(), b: z.number() }), responseSchema: z.object({ s: z.number() }) },
      { a: 1, b: 2 }
    )

    expect(ok).toEqual({ s: 3 })
    await expect(
      renderer.invoke(
        'sum',
        { requestSchema: z.object({ a: z.number(), b: z.number() }), responseSchema: z.object({ s: z.number() }) },
        { a: '1', b: 2 }
      )
    ).rejects.toBeTruthy()
  })

  it('exports R1 domain contracts while preserving route payload semantics', () => {
    expect(ipcSchemas.history.list.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.history.list.request.parse({ limit: 25 })).toEqual({ limit: 25 })
    expect(() => ipcSchemas.history.search.request.parse({ query: 1 })).toThrow()
    expect(ipcSchemas.history.remove.response.parse({ ok: true })).toEqual({ ok: true })
    expect(ipcSchemas.history.clear.response.parse({ cleared: 0 })).toEqual({ cleared: 0 })

    expect(ipcSchemas.search.suggestions.request.parse({ query: 'hira' })).toEqual({ query: 'hira' })
    expect(ipcSchemas.search.history.request.parse({ query: 'hira', limit: 10 })).toEqual({ query: 'hira', limit: 10 })
    expect(ipcSchemas.search.removeHistoryEntry.request.parse({ id: 'sh-1' })).toEqual({ id: 'sh-1' })
    expect(ipcSchemas.search.removeHistoryEntry.response.parse({ removed: true })).toEqual({ removed: true })
    expect(() => ipcSchemas.search.record.request.parse({})).toThrow()
    expect(ipcSchemas.search.customBangs.response.parse([])).toEqual([])
    expect(ipcSchemas.search.config.response.parse({ default: 'google', engines: {} })).toEqual({ default: 'google', engines: {} })

    expect(ipcSchemas.keybindings.get.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.keybindings.set.request.parse({ action: 'newTab', combo: 'Ctrl+T' })).toEqual({ action: 'newTab', combo: 'Ctrl+T' })
    expect(() => ipcSchemas.keybindings.set.request.parse({ action: 'newTab' })).toThrow()
    expect(ipcSchemas.keybindings.reset.response.parse({ ok: true })).toEqual({ ok: true })

    expect(ipcSchemas.profile.list.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.profile.create.request.parse({ name: 'Work', icon: 'briefcase', color: '#fff' })).toEqual({ name: 'Work', icon: 'briefcase', color: '#fff' })
    expect(() => ipcSchemas.profile.update.request.parse({ name: 'Work' })).toThrow()
    expect(ipcSchemas.profile.remove.response.parse({ ok: true })).toEqual({ ok: true })
    expect(ipcSchemas.profile.sorted.response.parse([{ id: 'a' }])).toEqual([{ id: 'a' }])
    expect(ipcSchemas.profile.pickActive.response.parse({ id: 'a' })).toEqual({ id: 'a' })
    expect(ipcSchemas.profile.isDefault.response.parse(false)).toBe(false)
    expect(ipcSchemas.profile.merge.request.parse({ id: 'a', patch: { name: 'M' } })).toEqual({ id: 'a', patch: { name: 'M' } })
    expect(ipcSchemas.profile.normalize.request.parse({ id: 'a' })).toEqual({ id: 'a' })

    expect(ipcSchemas.permissions.get.request.parse({ origin: 'https://hira.example', permissionType: 'notifications' })).toEqual({ origin: 'https://hira.example', permissionType: 'notifications' })
    expect(() => ipcSchemas.permissions.set.request.parse({ origin: 'https://hira.example', permissionType: 'camera' })).toThrow()
    expect(ipcSchemas.permissions.clearSite.response.parse({ cleared: 2 })).toEqual({ cleared: 2 })
    expect(ipcSchemas.permissions.respond.request.parse({ id: 'request-1', allow: true })).toEqual({ id: 'request-1', allow: true })
    expect(ipcSchemas.permissions.pendingList.request.parse(undefined)).toBeUndefined()

    expect(ipcSchemas.downloads.list.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.downloads.removeMany.request.parse({ ids: ['download-1'] })).toEqual({ ids: ['download-1'] })
    expect(() => ipcSchemas.downloads.removeMany.request.parse({ ids: [] })).toThrow()
    expect(ipcSchemas.downloads.open.request.parse({ id: 'download-1' })).toEqual({ id: 'download-1' })
    expect(ipcSchemas.downloads.showInFolder.request.parse({ filePath: 'C:\\Downloads\\hira.zip' })).toEqual({ filePath: 'C:\\Downloads\\hira.zip' })
    expect(() => ipcSchemas.downloads.open.request.parse({})).toThrow()
    expect(ipcSchemas.downloads.getFileIcon.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.downloads.getFileIcon.response.parse({ dataUrl: null })).toEqual({ dataUrl: null })
    expect(ipcSchemas.downloads.getSpeed.response.parse({ speed: 0, eta: 0 })).toEqual({ speed: 0, eta: 0 })

    expect(ipcSchemas.bookmarks.list.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.bookmarks.add.request.parse({ title: 'Hira', tags: ['browser'] })).toEqual({ title: 'Hira', tags: ['browser'] })
    expect(() => ipcSchemas.bookmarks.removeByUrl.request.parse({ url: '' })).toThrow()
    expect(ipcSchemas.bookmarks.pinnedReorder.response.parse({ ok: true })).toEqual({ ok: true })

    expect(ipcSchemas.tabs.new.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.tabs.stats.response.parse({ total: 3, pinned: 1, audio: 2 })).toEqual({ total: 3, pinned: 1, audio: 2 })
    expect(ipcSchemas.tabs.visibleAfter.request.parse({ tabId: 'a' })).toEqual({ tabId: 'a' })
    expect(ipcSchemas.tabs.visibleAfter.response.parse(['b', 'c'])).toEqual(['b', 'c'])
    expect(() => ipcSchemas.tabs.visibleAfter.request.parse({})).toThrow()
    expect(ipcSchemas.tabs.reorder.request.parse({ draggedId: 'a', targetId: 'b', insertAfter: true })).toEqual({ draggedId: 'a', targetId: 'b', insertAfter: true })
    expect(ipcSchemas.tabs.sleepInactive.response.parse({ slept: ['tab-1'] })).toEqual({ slept: ['tab-1'] })

    expect(ipcSchemas.layout.panelList.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.layout.setHeaderHeight.request.parse({ height: 64 })).toEqual({ height: 64 })
    expect(() => ipcSchemas.layout.floatInteractive.request.parse({})).toThrow()
    expect(ipcSchemas.layout.floatBounds.response.parse({ ok: true })).toEqual({ ok: true })

    expect(ipcSchemas.extensions.install.request.parse({ path: 'C:\\extensions\\hira.crx' })).toEqual({ path: 'C:\\extensions\\hira.crx' })
    expect(() => ipcSchemas.extensions.toggle.request.parse({ id: 'hira' })).toThrow()
    expect(ipcSchemas.extensions.adblockerStatus.response.parse({ enabled: true })).toEqual({ enabled: true })

    expect(ipcSchemas.passwords.save.request.parse({ hostname: 'hira.example', username: 'user', password: 'secret' })).toEqual({ hostname: 'hira.example', username: 'user', password: 'secret' })
    expect(() => ipcSchemas.passwords.captured.request.parse({ hostname: 'hira.example', username: 'user' })).toThrow()
    expect(ipcSchemas.passwords.generate.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.passwords.save.response.parse({ ok: true, strength: 3 })).toEqual({ ok: true, strength: 3 })
    expect(ipcSchemas.passwords.save.response.parse({ ok: true })).toEqual({ ok: true })
    expect(ipcSchemas.passwords.lowStrength.request.parse({ password: 'weak' })).toEqual({ password: 'weak' })
    expect(ipcSchemas.passwords.lowStrength.response.parse({ weak: true })).toEqual({ weak: true })

    expect(ipcSchemas.window.popupMenu.request.parse({ items: [{ label: '复制', type: 'normal', action: 'copy' }] })).toEqual({ items: [{ label: '复制', type: 'normal', action: 'copy' }] })
    expect(() => ipcSchemas.window.open.request.parse({})).toThrow()
    expect(ipcSchemas.window.getState.response.parse({ isMaximized: false, isFullscreen: false })).toEqual({ isMaximized: false, isFullscreen: false })

    expect(ipcSchemas.settings.list.request.parse(undefined)).toBeUndefined()
    expect(ipcSchemas.settings.set.request.parse({ key: 'theme', value: 'dark' })).toEqual({ key: 'theme', value: 'dark' })
    expect(() => ipcSchemas.settings.get.request.parse({})).toThrow()
    expect(ipcSchemas.settings.changedKeys.response.parse(['app.theme', 'tabs.autoSleep'])).toEqual(['app.theme', 'tabs.autoSleep'])
    expect(ipcSchemas.settings.cssVars.response.parse({ theme: 'light', sidebar_position: 'left' })).toEqual({ theme: 'light', sidebar_position: 'left' })

    expect(ipcSchemas.externalGames.list.request.parse({ refresh: true })).toEqual({ refresh: true })
    expect(ipcSchemas.externalGames.list.response.parse({ scheme: 'hira-game', games: [] })).toEqual({ scheme: 'hira-game', games: [] })

    expect(ipcSchemas.bookmarkBackup.restore.request.parse({ file: 'bookmarksBackup-20260917-120000.html' })).toEqual({ file: 'bookmarksBackup-20260917-120000.html' })
    expect(() => ipcSchemas.bookmarkBackup.restore.request.parse({ file: '' })).toThrow()
    expect(ipcSchemas.bookmarkBackup.list.request.parse(undefined)).toBeUndefined()
  })
})

