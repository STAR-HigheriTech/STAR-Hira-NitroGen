/**
 * AI Agent · 本地文件与办公能力插件。
 *
 * 工作区、文件读写、命令、Office 文档工具全部经由受限引擎端口取得，
 * 插件停用后这些工具会从模型工具面与执行表同时消失。
 */

const { createLocalTools } = require('./ai/core/local-tools.cjs')

interface LocalPluginContext {
  extensionPoints?: {
    callSync?(name: string, payload?: unknown): unknown
  }
}

function runtimePort(ctx: LocalPluginContext) {
  const callSync = ctx && ctx.extensionPoints && ctx.extensionPoints.callSync
  if (typeof callSync !== 'function') throw new Error('ai-agent-local 缺少扩展点调度器')
  const runtime = callSync.call(ctx.extensionPoints, 'ai.engine.runtime', { consumerId: 'ai-agent-local' })
  if (!runtime || typeof runtime !== 'object') throw new Error('ai-engine 运行时端口不可用')
  return runtime as Record<string, unknown>
}

module.exports = {
  extensionPoints(ctx: LocalPluginContext) {
    const runtime = runtimePort(ctx)
    if (!runtime.workspaces) throw new Error('本地工作区服务不可用')
    return {
      provides: [],
      extends: [
        {
          to: 'ai.tool.provider',
          key: 'ai-agent-local/tools',
          impl: () => createLocalTools({
            workspaces: runtime.workspaces,
            processRunner: runtime.processRunner || null
          })
        }
      ]
    }
  }
}
