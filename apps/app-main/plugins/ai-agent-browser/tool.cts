/**
 * 模型侧的后台浏览入口。
 *
 * 和 tab_* / page_* 的区别只有落点：这组动作固定进入隐藏 BrowserWindow，
 * 适合“读一批网页再回来总结”的研究型任务；用户正在看的标签不受影响。
 */

import type { AiToolContext, AiToolDefinition, JsonSchema, ToolArgs } from '../ai/types'

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

interface BackgroundBrowserPort {
  open(input: Record<string, unknown>): unknown
  read(input: Record<string, unknown>): unknown
  readMany(input: Record<string, unknown>): unknown
  search(input: Record<string, unknown>): unknown
  click(input: Record<string, unknown>): unknown
  fill(input: Record<string, unknown>): unknown
  scroll(input: Record<string, unknown>): unknown
  screenshot(input: Record<string, unknown>): unknown
  close(id: string): unknown
}

function createBackgroundTools(browser: BackgroundBrowserPort): AiToolDefinition[] {
  const bg = browser

  function call(action: string, args: ToolArgs, context: AiToolContext) {
    const input = {
      aiSessionId: context.sessionId,
      url: args.url,
      urls: args.urls,
      query: args.query,
      selector: args.selector,
      text: args.text,
      submit: args.submit === true,
      direction: args.direction,
      amount: args.amount,
      maxChars: args.maxChars,
      maxLinks: args.maxLinks,
      engine: args.engine,
      allowActions: true
    }
    if (action === 'open') return bg.open(input)
    if (action === 'read') return bg.read(input)
    if (action === 'read_many') return bg.readMany(input)
    if (action === 'search') return bg.search(input)
    if (action === 'click') return bg.click(input)
    if (action === 'fill') return bg.fill(input)
    if (action === 'scroll') return bg.scroll(input)
    if (action === 'screenshot') return bg.screenshot(input)
    if (action === 'close') return bg.close(`ai:${String(context.sessionId || '')}`)
    throw new Error(`不支持的 agent_browser 动作：${action}`)
  }

  return [{
    name: 'agent_browser',
    description: '在隐藏浏览器里打开、搜索、阅读、点击、填写或截图，不切换用户标签、不抢焦点。一次任务需要阅读多个网页时优先用它；读取结果含正文、标题和链接。点击/提交前确认符合用户当前意图。',
    parameters: obj({
      action: {
        type: 'string',
        enum: ['open', 'read', 'read_many', 'search', 'click', 'fill', 'scroll', 'screenshot', 'close'],
        description: 'open=打开网址；read=读当前页；read_many=顺序读多个网址；search=网页搜索并读取；click=按 CSS 选择器或可见文字点击；fill=填写；scroll=滚动；screenshot=截图到本地；close=释放该会话的后台页'
      },
      url: { type: 'string', description: 'http/https 地址；open/read 可传' },
      urls: { type: 'array', items: { type: 'string' }, description: 'read_many 的网址列表，最多 12 个' },
      query: { type: 'string', description: 'search 的搜索词' },
      engine: { type: 'string', description: '可选搜索地址模板，必须含 {query}' },
      selector: { type: 'string', description: 'click/fill 的 CSS 选择器' },
      text: { type: 'string', description: 'click 的可见文字，或 fill 要写入的文字' },
      submit: { type: 'boolean', description: 'fill 后是否提交，默认否' },
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
      amount: { type: 'number' },
      maxChars: { type: 'number', description: '正文上限，默认 12000，最高 60000' },
      maxLinks: { type: 'number', description: '链接上限，默认 40，最高 200' }
    }, ['action']),
    risk: 'write',
    approval: (args: ToolArgs) => args.action === 'click' || args.action === 'fill'
      ? (args.submit === true ? 'always' : 'site')
      : 'never',
    execute(args, context) {
      return call(String(args.action || ''), args, context)
    }
  }]
}

module.exports = { createBackgroundTools }
