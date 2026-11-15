/**
 * Hira CLI · 独立的 Agent 接入插件。
 *
 * 生命周期与传输、任务、后台浏览完全绑定：停用插件会立即撤销令牌、关闭监听、
 * 取消本插件发起的任务并释放外部 CLI 的后台上下文。
 */

const { app, BrowserWindow } = require('electron')
const { IPC_EVENTS } = require('@hira-ng/shared-types/src/ipc-channels.mjs')
const { createAgentBridge } = require('./hira-cli/bridge.cjs')
const { createCliTasks } = require('./hira-cli/tasks.cjs')
const { CLI_MIGRATIONS, runCliMigrations } = require('./hira-cli/schema.cjs')

interface CliPluginContext {
  kernel?: {
    sqlite: unknown
    userDataPath: string
    appRoot?: string
    emit?(route: string, payload: unknown): unknown
  }
  extensionPoints?: {
    callSync?(name: string, payload?: unknown): unknown
  }
}

interface BrowserPort extends Record<string, unknown> {
  open(input: Record<string, unknown>): unknown
  read(input: Record<string, unknown>): unknown
  readMany(input: Record<string, unknown>): unknown
  search(input: Record<string, unknown>): unknown
  click(input: Record<string, unknown>): unknown
  fill(input: Record<string, unknown>): unknown
  scroll(input: Record<string, unknown>): unknown
  screenshot(input: Record<string, unknown>): unknown
  list(): unknown[]
  listExternal?(): unknown[]
  close(id: string): boolean
  closeExternalContext?(id: string): boolean
  closeExternal?(): number
}

interface RuntimePort extends Record<string, unknown> {
  providerStatus(): {
    providers: Array<{ enabled?: boolean; models?: number }>
    ready: boolean
  }
  createSession(input?: Record<string, unknown>): { id: string } | null
  deleteSession(sessionId: string): void
  startTurn(input: Record<string, unknown>): { sessionId: string; turnId: string }
  stopTurn(sessionId: string): unknown
  waitTurn(sessionId: string, turnId: string): Promise<Record<string, unknown>>
  turnResult(sessionId: string, turnId: string): { text: string; sources: unknown[] }
}

let bridge: ReturnType<typeof createAgentBridge> | null = null
let tasks: ReturnType<typeof createCliTasks> | null = null
let activeBrowser: BrowserPort | null = null

function sqliteOf(ctx: CliPluginContext) {
  const sqlite = ctx && ctx.kernel && ctx.kernel.sqlite
  if (!sqlite) throw new Error('hira-cli 需要第一方 SQLite 端口')
  return sqlite as Parameters<typeof runCliMigrations>[0]
}

function extension(ctx: CliPluginContext, name: string): Record<string, unknown> {
  const callSync = ctx && ctx.extensionPoints && ctx.extensionPoints.callSync
  if (typeof callSync !== 'function') throw new Error(`hira-cli 缺少扩展点 ${name}`)
  const value = callSync.call(ctx.extensionPoints, name, { consumerId: 'hira-cli' })
  if (!value || typeof value !== 'object') throw new Error(`扩展点 ${name} 未返回可用服务`)
  return value as Record<string, unknown>
}

function doctor(runtime: RuntimePort, browser: BrowserPort) {
  const ai = runtime.providerStatus()
  const enabledProviders = ai.providers.filter((provider) => provider.enabled !== false)
  return {
    ok: true,
    service: 'hira-cli',
    state: 'ready',
    pluginId: 'hira-cli',
    app: { name: 'Hira', version: app.getVersion(), pid: process.pid },
    browser: {
      mode: 'background',
      pluginId: 'ai-agent-browser',
      sharesProfileSession: true,
      stealsFocus: false,
      contexts: browser.listExternal ? browser.listExternal() : [],
      visibleWindows: BrowserWindow.getAllWindows().filter((win: Electron.BrowserWindow) => {
        try { return win.isVisible() } catch (_) { return false }
      }).length,
      focusedWindowId: (() => {
        try {
          const focused = BrowserWindow.getFocusedWindow()
          return focused && !focused.isDestroyed() ? focused.id : null
        } catch (_) { return null }
      })()
    },
    ai: {
      enginePluginId: 'ai-engine',
      providers: ai.providers.length,
      enabledProviders: enabledProviders.length,
      ready: ai.ready
    },
    capabilities: [
      'browser.open',
      'browser.read',
      'browser.read_many',
      'browser.search',
      'browser.click',
      'browser.fill',
      'browser.scroll',
      'browser.screenshot',
      'task.start',
      'task.status',
      'task.result',
      'task.cancel'
    ]
  }
}

module.exports = {
  install(ctx: CliPluginContext) {
    runCliMigrations(sqliteOf(ctx))
  },

  extensionPoints() {
    return {
      provides: [],
      extends: CLI_MIGRATIONS.map((migration: { id: string }) => ({
        to: 'db.schema.migration',
        key: migration.id,
        impl: () => migration
      }))
    }
  },

  async enable(ctx: CliPluginContext) {
    if (bridge) return
    const kernel = ctx.kernel
    if (!kernel) throw new Error('hira-cli 需要第一方内核端口')
    runCliMigrations(sqliteOf(ctx))

    const runtime = extension(ctx, 'ai.engine.runtime') as RuntimePort
    const browser = extension(ctx, 'ai.background-browser') as BrowserPort
    activeBrowser = browser
    tasks = createCliTasks({
      sqlite: sqliteOf(ctx),
      runtime,
      browser,
      notify: (payload: Record<string, unknown>) => {
        try { kernel.emit?.(IPC_EVENTS.aiStateChanged, payload) } catch (_) {}
      },
      logger: console
    })
    bridge = createAgentBridge({
      api: {
        doctor: () => doctor(runtime, browser),
        browser: {
          open: (input: Record<string, unknown>) => browser.open(input),
          read: (input: Record<string, unknown>) => browser.read(input),
          readMany: (input: Record<string, unknown>) => browser.readMany(input),
          search: (input: Record<string, unknown>) => browser.search(input),
          click: (input: Record<string, unknown>) => browser.click(input),
          fill: (input: Record<string, unknown>) => browser.fill(input),
          scroll: (input: Record<string, unknown>) => browser.scroll(input),
          screenshot: (input: Record<string, unknown>) => browser.screenshot(input),
          list: () => ({ contexts: browser.listExternal ? browser.listExternal() : [] }),
          close: (input: Record<string, unknown>) => ({
            ok: true,
            context: String(input.context || 'default'),
            closed: browser.closeExternalContext
              ? browser.closeExternalContext(String(input.context || 'default'))
              : false
          })
        },
        tasks: {
          start: (input: Record<string, unknown>) => tasks!.start(input),
          status: (input: Record<string, unknown>) => tasks!.status(input),
          result: (input: Record<string, unknown>) => tasks!.result(input),
          cancel: (input: Record<string, unknown>) => tasks!.cancel(input),
          list: (input: Record<string, unknown>) => tasks!.list(input)
        }
      },
      userDataPath: String(kernel.userDataPath || ''),
      appRoot: String(kernel.appRoot || ''),
      version: app.getVersion(),
      logger: console
    })

    try {
      await bridge.start()
    } catch (error) {
      try { tasks.dispose() } catch (_) {}
      try { bridge.stop({ disabled: true }) } catch (_) {}
      tasks = null
      bridge = null
      activeBrowser = null
      throw error
    }
  },

  disable() {
    if (bridge) {
      try { bridge.stop() } catch (_) {}
      bridge = null
    }
    if (tasks) {
      try { tasks.dispose() } catch (_) {}
      tasks = null
    }
    if (activeBrowser) {
      try { activeBrowser.closeExternal?.() } catch (_) {}
      activeBrowser = null
    }
  },

  uninstall() {
    module.exports.disable()
  }
}
