/**
 * AI 引擎 · 应用动作工具（浏览器「所有角落」的统一入口）。
 *
 * 与 `browser-tools.cjs` 的分工：那边是**数据面**（设置项 / 内部页清单 / 面板），
 * 这边是**动作面** —— 直接调主进程 `appMenuActions`（经 `host.appActions` 注入）。
 * 原生菜单、插件菜单、AI 走的是同一张执行表，所以这里不可能出现
 * 「AI 关标签走 A 实现、用户点菜单走 B 实现」的漂移。
 *
 * 只有两个工具：
 *   · `app_action_list` —— 按分组列出动作（名字 / 中文名 / 参数简写 / 是否可用）；
 *   · `app_action_run`  —— 按名字执行一个动作。
 * 新增浏览器能力不需要改这里，只改 `main/app-actions.js` 的元数据表。
 */

import type { AiToolDefinition, AiToolHost, JsonSchema, ToolArgs } from '../types'

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/**
 * @param {{ appActions?: any }} host
 */
function createAppTools(host: AiToolHost): AiToolDefinition[] {
  const port = () => host.appActions || null

  function requirePort() {
    const actions = port()
    if (!actions || typeof actions.run !== 'function') throw new Error('应用动作端口不可用（主进程尚未装配动作表）')
    return actions
  }

  const tools: AiToolDefinition[] = [
    {
      name: 'app_action_list',
      description:
        '列出浏览器可以执行的全部界面动作（新建/关闭标签、前进后退、缩放、阅读模式、全屏、开发者工具、' +
        '打开各个内部页面、收藏、收进集锦、安装应用、切换空间…）。group 可只看一组，' +
        '分组 id：window / navigation / view / page / web / library / settings / pwa / space。',
      parameters: obj({
        group: { type: 'string', description: '只看某一组；不传 = 全部' },
        query: { type: 'string', description: '按动作名 / 中文名 / 说明搜索，例如“阅读”“全屏”“打开历史”' },
        includeUnavailable: { type: 'boolean', description: '是否包含当前不可用的动作，默认否' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const actions = requirePort()
        const groups = actions.list(args.group, {
          availableOnly: !(args && args.includeUnavailable === true),
          query: args && args.query
        })
        return { groups }
      }
    },
    {
      name: 'app_action_run',
      description:
        '执行一个浏览器界面动作（动作名来自 app_action_list）。这是操作浏览器本身的唯一入口：' +
        '需要打开某个内部页面、切换空间、开关侧栏/阅读模式/全屏、前进后退、缩放、恢复关闭的标签等，都用它。',
      parameters: obj({
        name: { type: 'string', description: '动作名，逐字取自 app_action_list 的 name' },
        args: { type: 'object', description: '动作参数（键名见 app_action_list 的 args 简写）' }
      }, ['name']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const actions = requirePort()
        const payload = args.args && typeof args.args === 'object' ? args.args as Record<string, unknown> : {}
        return actions.run(String(args.name || ''), payload)
      }
    },
    {
      name: 'app_state_read',
      description:
        '读取浏览器当前的界面状态：可切换的空间、当前空间、打开的窗口、集锦列表、书签栏模式，' +
        '以及「当前页能否收藏 / 能否安装为应用」。切换空间或收进集锦前先用它取 id。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const actions = requirePort()
        if (typeof actions.targets !== 'function') return {}
        return actions.targets()
      }
    }
  ]
  return tools
}

module.exports = { createAppTools }
