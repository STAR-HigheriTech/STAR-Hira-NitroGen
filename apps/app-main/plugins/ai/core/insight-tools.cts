/**
 * AI 引擎 · 感知工具（运行日志 / 面板数据）。
 *
 * 为什么单独一份：`browser-tools.cjs` 操作的是「看得见的浏览器」，本文件提供的是
 * 「**看不见但真实存在**的状态」——
 *   · `app_logs`   —— 主进程 console、每个页面 / 内部页的 console-message、加载失败、
 *                     渲染进程崩溃、preload 报错……全部收在 `log-hub` 的环形缓冲里；
 *   · `panel_read` —— 每个侧栏面板背后的数据面（书签 / 笔记 / 历史 / 下载 / 权限 / TOTP …），
 *                     含「固定」「置顶」「在侧栏打开」这类**细节标签**，而不是只给标题和 URL。
 *
 * 有了这两件，AI 才算真正把浏览器当工作台：能复盘自己刚做了什么、能读到用户眼前的
 * 每一个面板里到底摆着什么。
 *
 * 三条纪律（与其它工具文件一致）：
 *   1. 不另建实现 —— 日志只读 `host.getLogHub()`，面板只读 `host.panelData`，
 *      与界面 / 其它消费者看到的完全是同一份数据；
 *   2. 不认识 Electron —— 两者都是注入端口，本文件不 require electron；
 *   3. 结果必须短 —— 日志逐条截断、面板分页 limit，绝不把整份缓冲倒进上下文。
 */

import type {
  AiToolDefinition,
  AiToolHost,
  JsonSchema,
  LogRecord,
  ToolArgs,
  UnknownRecord
} from '../types'

interface ModelLogItem {
  time: string
  level: string
  source: string
  message: string
  scope?: string
  url?: string
  line?: number
  extra?: unknown
}

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/** 整数夹取：模型给的 limit 不可信，越界一律夹到区间内。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), min), max)
}

/** 单行摘录（压掉换行与连续空白，超长截断）。 */
function clip(text: unknown, max: number): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 一条日志 → 给模型看的最短形态（时间用 ISO，模型不需要自己算毫秒差）。 */
function logItem(record: LogRecord): ModelLogItem {
  const item: ModelLogItem = {
    time: new Date(record.at).toISOString(),
    level: record.level,
    source: record.source,
    message: clip(record.message, 600)
  }
  if (record.scope) item.scope = clip(record.scope, 200)
  if (record.url) item.url = clip(record.url, 300)
  if (record.line != null) item.line = record.line
  if (record.extra) item.extra = record.extra
  return item
}

/**
 * @param {{
 *   getLogHub?: () => any,
 *   panelData?: { list: Function, read: Function, summary: Function, ids: Function } | null
 * }} host
 */
function createInsightTools(host: AiToolHost): AiToolDefinition[] {
  const logHubOf = () => {
    const hub = typeof host.getLogHub === 'function' ? host.getLogHub() : host.getLogHub
    return hub && typeof hub.query === 'function' ? hub : null
  }
  const panelDataOf = () => {
    const data = host.panelData
    return data && typeof data.read === 'function' ? data : null
  }

  const tools: AiToolDefinition[] = [
    {
      name: 'app_logs',
      description:
        '读取浏览器运行日志（主进程 console、各页面 / 内部页的 console 输出、加载失败、' +
        '渲染进程崩溃、preload 报错、子进程退出）。排查「为什么没反应 / 刚才报了什么错」' +
        '时先调它。可用 level（该级别及以上）、source、scope、contains 过滤，' +
        'withinMinutes 只看最近 N 分钟。stats=true 时只返回按级别 / 来源的分布摘要。',
      parameters: obj({
        level: { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error'], description: '最低级别（含）' },
        source: { type: 'string', description: '来源，如 main / webContents / renderer / navigation / preload / process' },
        scope: { type: 'string', description: '作用域（通常是页面 URL 或固定标识）' },
        contains: { type: 'string', description: '消息或 URL 中包含的关键字（不区分大小写）' },
        withinMinutes: { type: 'number', description: '只看最近多少分钟的日志' },
        since: { type: 'number', description: '起始时间戳（毫秒），与 withinMinutes 二选一' },
        until: { type: 'number', description: '截止时间戳（毫秒）' },
        limit: { type: 'number', description: '最多返回条数（默认 60，最多 300，取最近的那批）' },
        stats: { type: 'boolean', description: 'true 时只返回分布摘要，不返回具体条目' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const hub = logHubOf()
        if (!hub) throw new Error('日志中心不可用（主进程尚未装配 log-hub）')
        const stats = hub.stats()
        if (args.stats) return stats
        const minutes = Number(args.withinMinutes)
        const since = Number.isFinite(Number(args.since))
          ? Number(args.since)
          : (Number.isFinite(minutes) && minutes > 0 ? Date.now() - minutes * 60000 : 0)
        const result = hub.query({
          level: args.level,
          source: args.source,
          scope: args.scope,
          contains: args.contains,
          since,
          until: Number.isFinite(Number(args.until)) ? Number(args.until) : 0,
          limit: clampInt(args.limit, 60, 1, 300)
        })
        return {
          capacity: result.capacity,
          buffered: result.size,
          matched: result.total,
          returned: result.items.length,
          truncated: result.total > result.items.length,
          levels: stats.byLevel,
          sources: stats.bySource,
          items: result.items.map((record) => logItem(record))
        }
      }
    },
    {
      name: 'panel_read',
      description:
        '读取侧栏面板里的真实数据（不是截图，是完整字段）。例如书签面板给出每条的 ' +
        'pinned（固定在书签栏）/ railPinned（固定在图标栏）/ openInSidebar（点击在侧栏打开）' +
        '/ tags / summary；标签面板给出休眠、静音、分组、分屏等状态；画板面板给出每块板上的 ' +
        '卡片（便签文字 / 链接 / 图片体积）与连线条数；笔记、历史、下载、' +
        '权限、TOTP、注入规则、空间、命名会话、扩展、主题、插件同理。' +
        '不传 panelId 时返回面板清单与各自是否有可读数据；' +
        '个别面板（实时更新 / 扫码器）没有主进程数据，会返回 available=false 并说明该改用哪个工具。',
      parameters: obj({
        panelId: { type: 'string', description: '面板 id，如 favorites-panel / open-tabs-panel' },
        limit: { type: 'number', description: '最多返回条数（默认 30，最多 100）' },
        args: {
          type: 'object',
          description: '面板专有参数，如书签的 parentId、笔记的 folderId',
          additionalProperties: true
        }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const data = panelDataOf()
        if (!data) throw new Error('面板数据面不可用（主进程尚未装配 panel-data）')
        const panelId = String(args.panelId == null ? '' : args.panelId).trim()
        if (!panelId) {
          return { panels: data.list(), hint: '把上面面板的 panelId 传给 panel_read 即可读取内容' }
        }
        const extra = args.args && typeof args.args === 'object' ? args.args as UnknownRecord : {}
        const result = await data.read(panelId, {
          ...extra,
          limit: clampInt(args.limit, 30, 1, 100)
        })
        // provider 自身抛错时 read() 已把它收敛成 `{ available:true, error }`（面板存在、只是这次读失败），
        // 模型看到 error 就会换路 —— 不再在这里二次判断，避免写一条永远走不到的分支。
        return result
      }
    }
  ]
  return tools
}

module.exports = { createInsightTools }
