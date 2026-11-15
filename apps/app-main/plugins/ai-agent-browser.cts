/**
 * AI Agent · 后台浏览器能力插件。
 *
 * 对外只贡献两样东西：
 *   · `ai.background-browser` 服务端口，供 CLI / 研究等能力插件复用；
 *   · `agent_browser` 工具，供 AI 在隐藏窗口里读取与操作网页。
 */

const { createBackgroundBrowser } = require('./ai-agent-browser/background-browser.cjs')
const { createBackgroundTools } = require('./ai-agent-browser/tool.cjs')

interface BrowserPluginContext {
  kernel?: {
    getCurrentSession?(): unknown
    userDataPath: string
  }
  extensionPoints?: {
    call?(name: string, payload?: unknown): unknown
  }
}

let browser: ReturnType<typeof createBackgroundBrowser> | null = null

function ensureBrowser(ctx: BrowserPluginContext) {
  if (browser) return browser
  const kernel = ctx && ctx.kernel
  if (!kernel || typeof kernel.getCurrentSession !== 'function') {
    throw new Error('ai-agent-browser 需要第一方内核会话端口')
  }
  browser = createBackgroundBrowser({
    getSession: () => {
      const session = kernel.getCurrentSession?.()
      if (!session) throw Object.assign(new Error('当前 profile 的浏览器会话不可用'), { code: 'AI_NO_BROWSER_SESSION' })
      return session as Electron.Session
    },
    userDataPath: String(kernel.userDataPath || ''),
    logger: console
  })
  return browser
}

module.exports = {
  install(ctx: BrowserPluginContext) {
    ensureBrowser(ctx)
  },

  extensionPoints(ctx: BrowserPluginContext) {
    const service = ensureBrowser(ctx)
    return {
      provides: [],
      extends: [
        {
          to: 'ai.background-browser',
          key: 'ai-agent-browser/service',
          impl: () => service
        },
        {
          to: 'ai.tool.provider',
          key: 'ai-agent-browser/tools',
          impl: () => createBackgroundTools(service)
        }
      ]
    }
  },

  enable(ctx: BrowserPluginContext) {
    ensureBrowser(ctx)
  },

  disable() {
    if (browser) {
      try { browser.dispose() } catch (_) {}
      browser = null
    }
  },

  uninstall() {
    module.exports.disable()
  }
}
