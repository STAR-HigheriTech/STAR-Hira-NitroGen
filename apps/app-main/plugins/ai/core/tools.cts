/**
 * AI 引擎 · 内置工具（PART15 §10）。
 *
 * 每个工具是一条**声明**：名字、给模型看的描述、JSON Schema、风险等级、审批策略、执行体。
 * 风险等级只影响审批与审计，不影响执行路径 —— 执行路径只有一条
 * （见 turn-runner 的 `runTool`），免得"只读工具走 A 路、写工具走 B 路"这种双轨。
 *
 * 审批策略（`approval`）：
 *   never  —— 只读操作，直接执行
 *   site   —— 同一站点在本次会话内首次执行时问一次（记住后不再问）
 *   always —— 每次都问（下载、关闭标签这类不可逆动作）
 *
 * 所有工具都**不认识 Electron 窗口模型**：标签操作走注入的 `getTabManager()`，
 * 页面操作走 `getWebContents()`，域服务走 `getServices()`。
 */

const { readPage, capturePage } = require('./page.cjs')
// 浏览器本体操作（设置 / 内部页 / 面板 / 历史 / 集锦 / 书签）—— 单独一份，注册出口仍只有本文件。
const { createBrowserTools } = require('./browser-tools.cjs')
// 记忆与增强（收藏摘要）与子智能体（研究 / 操作 / 写作）—— 同样各自一份，见各文件头。
const { createMemoryTools } = require('./memory-tools.cjs')
const { createAgentTools } = require('./agent-tools.cjs')
// 应用动作表（菜单 / 插件命令 / JumpList 的唯一执行表）—— 让 AI 能触达**所有内部页面**，
// 而不是只认得设置项；动作清单本身由 APPS 层的 app-actions.js 提供，这里只做转发。
const { createAppTools } = require('./app-tools.cjs')
// 域数据面（历史清理 / 下载控制 / 扩展 / 权限 / 空间 / 密码元数据 / PWA / 命名会话 / 集锦 / 书签）。
// 动作表覆盖不到的是"数据"，这里按域服务补；不重写业务，只做"服务方法 → 工具声明"。
const { createDomainTools } = require('./domain-tools.cjs')
// 联网（web_search / web_fetch）：结果自带 sources，供界面做来源透明化展示。
const { createWebTools } = require('./web-tools.cjs')
// AI 工作室（PART17）：让助手自己写插件 / 主题 / 用户脚本 / 技能，并装进浏览器。
const { createStudioTools } = require('./studio-tools.cjs')
// 插件生态（PART18）：列出 / 执行插件命令、打开插件内部页与浮层。
// 全部复用主进程既有端口（pluginSurfaces / pluginOverlayHost），不另建一套实现。
const { createPluginTools } = require('./plugin-tools.cjs')
// 感知（运行日志 / 面板数据）：让 AI 能复盘"刚才发生了什么"、读到每个面板里的完整字段。
const { createInsightTools } = require('./insight-tools.cjs')

import type {
  AiToolContext,
  AiToolDefinition,
  AiToolHost,
  AiToolRegistry,
  AiPreExecuteDecision,
  ApprovalPolicy,
  JsonObject,
  JsonSchema,
  ToolArgs,
  ToolRisk,
  UnknownRecord
} from '../types'

const EMPTY_TOOL_CONTEXT: AiToolContext = { sessionId: '' }

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

/** 取当前窗口的活动标签页 webContents（没有就抛 —— 让模型看到明确原因）。 */
function activeWebContents(getTabManager: AiToolHost['getTabManager']) {
  const tm = getTabManager()
  if (!tm) throw new Error('标签管理器不可用')
  const tabId = tm.getActiveTabId()
  const wc = tabId ? tm.getWebContents(tabId) : null
  if (!wc) throw new Error('当前标签没有可读页面（可能在休眠或尚未加载）')
  return wc
}

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/**
 * @param {{
 *   getTabManager: () => any,
 *   getServices: () => any,
 *   getLayout?: () => any,
 *   getPanelPresentation?: () => any,
 *   listPanels?: () => any[],
 *   appActions?: any,
 *   complete?: Function,
 *   runAgent?: Function
 * }} host
 */
function createBuiltinTools(host: AiToolHost): AiToolDefinition[] {
  const getTabManager = host.getTabManager
  const getServices = host.getServices || (() => ({}))

  const tools: AiToolDefinition[] = [
    {
      name: 'tab_list',
      description: '列出当前窗口的所有标签，含标题、地址、是否活动，以及休眠 / 静音 / 正在播放 / 无痕 / 分组 / 分屏 / 先后退前进等完整状态。需要知道用户开了哪些页面时先调它。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const tm = getTabManager()
        const active = tm.getActiveTabId()
        return tm.list().map((t) => ({
          tabId: t.tabId,
          title: t.title || '',
          url: t.url || '',
          active: t.tabId === active,
          pinned: !!t.pinned,
          muted: !!t.muted,
          playing: !!t.isPlaying,
          sleeping: !!t.sleeping,
          loading: !!t.loading,
          incognito: !!t.incognito,
          position: Number.isFinite(t.position) ? t.position : null,
          ...(t.containerProfileId ? { containerProfileId: t.containerProfileId } : {}),
          ...(t.spaceId ? { spaceId: t.spaceId } : {}),
          ...(t.stackId ? { stackId: t.stackId } : {}),
          ...(t.splitId ? { splitId: t.splitId } : {}),
          ...(t.glanceId ? { glanceId: t.glanceId, glanceFront: !!t.glanceFront } : {}),
          canGoBack: !!t.canGoBack,
          canGoForward: !!t.canGoForward,
          ...(t.favicon ? { favicon: t.favicon } : {}),
          ...(t.autoRefreshMs ? { autoRefreshMs: t.autoRefreshMs } : {}),
          lastActivated: t.lastActivated || null
        }))
      }
    },
    {
      name: 'tab_open',
      description: '在新标签打开一个 http/https 地址，返回新标签 id。不要用它打开本地文件或非 http 协议。',
      parameters: obj({ url: { type: 'string', description: '完整地址' } }, ['url']),
      risk: 'write',
      approval: 'site',
      async execute(args) {
        const url = String((args && args.url) || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('只允许 http/https 地址')
        const res = await getTabManager().newTab({ url })
        return { tabId: res && res.tabId, url }
      }
    },
    {
      name: 'tab_switch',
      description: '切换到指定标签。',
      parameters: obj({ tabId: { type: 'string' } }, ['tabId']),
      risk: 'write',
      approval: 'never',
      async execute(args) {
        getTabManager().switchTo(String(args.tabId))
        return { ok: true, tabId: String(args.tabId) }
      }
    },
    {
      name: 'tab_close',
      description: '关闭指定标签（可在"最近关闭"里恢复，属于可撤销动作）。',
      parameters: obj({ tabId: { type: 'string' } }, ['tabId']),
      risk: 'write',
      approval: 'never',
      async execute(args) {
        return getTabManager().close(String(args.tabId))
      }
    },
    {
      name: 'page_read',
      description: '读取当前标签的页面内容（标题、地址、小标题、正文、链接、用户选中的文字）。需要总结 / 翻译 / 回答关于页面的问题时先调它。',
      parameters: obj({
        maxChars: { type: 'number', description: '正文最大字符数，默认 12000' }
      }),
      risk: 'read',
      approval: 'site',
      async execute(args) {
        const snap = await readPage(activeWebContents(getTabManager), { maxChars: args && args.maxChars })
        return snap
      }
    },
    {
      name: 'page_find',
      description: '在当前页面内查找一段文字，返回是否找到与匹配数量。',
      parameters: obj({ text: { type: 'string' } }, ['text']),
      risk: 'read',
      approval: 'never',
      async execute(args) {
        const wc = activeWebContents(getTabManager)
        const text = String((args && args.text) || '')
        if (!text) throw new Error('text 不能为空')
        return new Promise<unknown>((resolve) => {
          let done = false
          const finish = (value: unknown) => {
            if (done) return
            done = true
            try { wc.removeListener('found-in-page', onFound) } catch (_) {}
            clearTimeout(timer)
            resolve(value)
          }
          const onFound = (_e: Electron.Event, result: Electron.FoundInPageResult) => {
            if (result && result.finalUpdate) finish({ found: result.matches > 0, matches: result.matches })
          }
          const timer = setTimeout(() => finish({ found: false, matches: 0, timedOut: true }), 3000)
          wc.on('found-in-page', onFound)
          try { wc.findInPage(text) } catch (e) { finish({ found: false, matches: 0, error: errorMessage(e) }) }
        })
      }
    },
    {
      name: 'page_scroll',
      description: '滚动当前页面。direction 为 up/down/top/bottom，amount 为像素（默认一屏）。',
      parameters: obj({
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount: { type: 'number' }
      }, ['direction']),
      risk: 'read',
      approval: 'never',
      async execute(args) {
        const wc = activeWebContents(getTabManager)
        const direction = String(args.direction || 'down')
        const amount = Number(args.amount) || 0
        const code = `(() => {
          const d = ${JSON.stringify(direction)}, a = ${amount};
          const step = a > 0 ? a : Math.round(window.innerHeight * 0.9);
          if (d === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
          else if (d === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          else window.scrollBy({ top: d === 'up' ? -step : step, behavior: 'smooth' });
          return { y: window.scrollY, height: document.body.scrollHeight };
        })()`
        const res = await wc.executeJavaScriptInIsolatedWorld(999, [{ code }])
        return { ok: true, ...res }
      }
    },
    {
      name: 'page_click',
      description: '点击页面中匹配 CSS 选择器的第一个元素。只能在用户明确要求操作页面时使用。',
      parameters: obj({ selector: { type: 'string' } }, ['selector']),
      risk: 'write',
      approval: 'site',
      async execute(args) {
        const wc = activeWebContents(getTabManager)
        const selector = String((args && args.selector) || '')
        if (!selector) throw new Error('selector 不能为空')
        const code = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, reason: 'not-found' };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
        })()`
        return wc.executeJavaScriptInIsolatedWorld(999, [{ code }])
      }
    },
    {
      name: 'page_type',
      description: '在页面输入框中填写文字（不自动提交）。只能在用户明确要求填写表单时使用。',
      parameters: obj({
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: '填写后是否按回车提交，默认否' }
      }, ['selector', 'text']),
      risk: 'write',
      approval: 'site',
      async execute(args) {
        const wc = activeWebContents(getTabManager)
        const selector = String(args.selector || '')
        const text = String(args.text == null ? '' : args.text)
        const submit = args.submit === true
        if (!selector) throw new Error('selector 不能为空')
        const code = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, reason: 'not-found' };
          if (el.isContentEditable) {
            el.focus(); el.textContent = ${JSON.stringify(text)};
          } else {
            el.focus();
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, ${JSON.stringify(text)});
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (${submit ? 'true' : 'false'}) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
          }
          return { ok: true };
        })()`
        return wc.executeJavaScriptInIsolatedWorld(999, [{ code }])
      }
    },
    {
      name: 'page_screenshot',
      description: '截取当前页面可视区域，返回图片（渲染层会直接显示给用户）。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        return capturePage(activeWebContents(getTabManager))
      }
    },
    {
      name: 'bookmark_search',
      description: '在用户的收藏夹里按关键词搜索书签。',
      parameters: obj({ query: { type: 'string' } }, ['query']),
      risk: 'read',
      approval: 'never',
      async execute(args) {
        const svc = getServices().bookmarkService
        if (!svc || typeof svc.search !== 'function') throw new Error('书签服务不可用')
        const rows = await svc.search(String(args.query || ''))
        return (Array.isArray(rows) ? rows : []).slice(0, 30).map((b) => ({
          id: b.id,
          title: b.title,
          url: b.url,
          // 有摘要的收藏直接带上（模型据此判断还需不需要 bookmark_digest）。
          summary: b.summary ? String(b.summary).replace(/\s+/g, ' ').trim().slice(0, 80) : ''
        }))
      }
    },
    {
      name: 'bookmark_add',
      description: '把当前页面（或给定地址）加入收藏夹。',
      parameters: obj({
        title: { type: 'string' },
        url: { type: 'string' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args) {
        const svc = getServices().bookmarkService
        if (!svc || typeof svc.add !== 'function') throw new Error('书签服务不可用')
        let url = String((args && args.url) || '')
        let title = String((args && args.title) || '')
        if (!url) {
          const snap = await readPage(activeWebContents(getTabManager), { maxChars: 200, maxLinks: 0 })
          url = snap.url
          title = title || snap.title
        }
        if (!/^https?:\/\//i.test(url)) throw new Error('只能收藏 http/https 页面')
        const item = await svc.add({ title: title || url, url })
        return { ok: true, id: item && item.id, title: title || url, url }
      }
    },
    {
      name: 'history_search',
      description: '在浏览历史里按关键词搜索访问过的页面（标题 / 网址，命中正文时附 excerpt 摘录）。',
      parameters: obj({ query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
      risk: 'read',
      approval: 'never',
      async execute(args) {
        const svc = getServices().historyService
        if (!svc || typeof svc.search !== 'function') throw new Error('历史服务不可用')
        const limit = Math.min(Math.max(Math.round(Number(args.limit) || 20), 1), 40)
        const rows = await svc.search(String(args.query || ''), limit)
        const list = Array.isArray(rows) ? rows : []
        return {
          total: list.length,
          items: list.slice(0, limit).map((h) => ({
            // id 是后续 history_remove 的唯一抓手：不给的话模型只能"再搜一次"猜。
            id: h.id || '',
            title: h.title || '',
            url: h.url || '',
            visitedAt: h.lastVisitAt || null,
            visitCount: h.visitCount || 0,
            // 正文命中（FTS）才有 snippet；标题/网址命中时为空 —— 不要伪造。
            excerpt: h.snippet ? String(h.snippet).replace(/\s+/g, ' ').trim().slice(0, 160) : ''
          })),
          ...(list.length >= limit ? { hint: '结果已到上限，缩小关键词或改用更具体的词' } : {})
        }
      }
    },
    {
      name: 'download_file',
      description: '让浏览器下载一个 http/https 地址（会进下载列表，用户可在下载面板看到）。',
      parameters: obj({ url: { type: 'string' } }, ['url']),
      risk: 'write',
      approval: 'always',
      async execute(args) {
        const url = String((args && args.url) || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('只允许 http/https 地址')
        const wc = activeWebContents(getTabManager)
        wc.downloadURL(url)
        return { ok: true, url }
      }
    }
  ]

  return tools
    .concat(createBrowserTools(host))
    .concat(createMemoryTools(host))
    .concat(createAgentTools(host))
    .concat(createAppTools(host))
    .concat(createDomainTools(host))
    .concat(createWebTools(host))
    .concat(createStudioTools(host))
    .concat(createPluginTools(host))
    .concat(createInsightTools(host))
}

/** 风险 / 审批的严格程度排序：合并同名工具时只取更严的一档。 */
const RISK_LEVEL = { read: 0, write: 1, destructive: 2 }
const APPROVAL_LEVEL = { never: 0, site: 1, always: 2 }

function isToolRisk(value: unknown): value is ToolRisk {
  return value === 'read' || value === 'write' || value === 'destructive'
}

function stricterRisk(a: unknown, b: unknown): ToolRisk {
  const left: ToolRisk = isToolRisk(a) ? a : 'write'
  const right: ToolRisk = isToolRisk(b) ? b : 'write'
  return RISK_LEVEL[left] >= RISK_LEVEL[right] ? left : right
}

/**
 * 审批档位合并：返回更严的一档。
 *
 * 动态档（函数）无法与字符串比大小 —— 只要有一方是函数就保留函数
 * （函数本身已是"按参数决定"，由声明方负责返回合法值，闸门侧会兜底成 always）。
 */
function stricterApproval(
  a: ApprovalPolicy | ((args: ToolArgs) => ApprovalPolicy),
  b: ApprovalPolicy | ((args: ToolArgs) => ApprovalPolicy)
): ApprovalPolicy | ((args: ToolArgs) => ApprovalPolicy) {
  if (typeof a === 'function') return a
  if (typeof b === 'function') return b
  const left: ApprovalPolicy = a === 'never' || a === 'site' || a === 'always' ? a : 'always'
  const right: ApprovalPolicy = b === 'never' || b === 'site' || b === 'always' ? b : 'always'
  return APPROVAL_LEVEL[left] >= APPROVAL_LEVEL[right] ? left : right
}

/**
 * 工具注册表：内置工具 + 插件贡献（`ai.tool.provider`）+ 执行前裁决（`ai.tool.pre-execute`）。
 */
function createToolRegistry({ extensionPoints, builtin }: {
  extensionPoints?: AiToolHost['extensionPoints']
  builtin: AiToolDefinition[]
}): AiToolRegistry {
  const builtinTools: AiToolDefinition[] = Array.isArray(builtin) ? builtin : []

  /** 插件工具：MULTI，可能一个实现返回一个工具或一个数组。 */
  function pluginTools(ctx: AiToolContext): AiToolDefinition[] {
    if (!extensionPoints || typeof extensionPoints.callSync !== 'function') return []
    if (typeof extensionPoints.isDefined === 'function' && !extensionPoints.isDefined('ai.tool.provider')) return []
    let raw: unknown = []
    try { raw = extensionPoints.callSync('ai.tool.provider', {}, ctx) } catch (_) { return [] }
    return (Array.isArray(raw) ? raw.flat(1) : [])
      .filter((tool): tool is UnknownRecord => !!tool && typeof tool === 'object' && typeof tool.name === 'string' && typeof tool.execute === 'function')
      .map((tool) => ({
        name: String(tool.name),
        description: String(tool.description || ''),
        parameters: (tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} }) as JsonSchema,
        risk: isToolRisk(tool.risk) ? tool.risk : 'read',
        approval: (tool.approval === 'never' || tool.approval === 'site' || tool.approval === 'always'
          ? tool.approval
          : tool.risk === 'read' ? 'never' : 'site') as ApprovalPolicy,
        execute: tool.execute as AiToolDefinition['execute']
      }))
  }

  function list(ctx: AiToolContext = EMPTY_TOOL_CONTEXT): AiToolDefinition[] {
    const byName = new Map(builtinTools.map((t) => [t.name, t]))
    for (const extra of pluginTools(ctx)) {
      const base = byName.get(extra.name)
      if (!base) { byName.set(extra.name, extra); continue }
      // 同名 = 插件替代内置实现，但**风险与审批只能收紧、不能放宽**：
      // 否则一个插件只要声明一个同名的 `download_file`（read/never），
      // 就能把内置的 always 审批整个抹掉 —— 这是审批体系最廉价的绕过口。
      byName.set(extra.name, {
        ...extra,
        risk: stricterRisk(base.risk, extra.risk),
        approval: stricterApproval(base.approval, extra.approval)
      })
    }
    return Array.from(byName.values())
  }

  function get(name: string, ctx: AiToolContext = EMPTY_TOOL_CONTEXT): AiToolDefinition | null {
    return list(ctx).find((t) => t.name === name) || null
  }

  /**
   * 执行前裁决（REDUCE，初值 null）。
   * 返回值约定：`{ decision: 'allow'|'deny', reason?, args? }`；null/undefined = 未裁决。
   */
  async function preExecute(call: UnknownRecord, ctx: AiToolContext = EMPTY_TOOL_CONTEXT): Promise<AiPreExecuteDecision | null> {
    if (!extensionPoints || typeof extensionPoints.call !== 'function') return null
    if (typeof extensionPoints.isDefined === 'function' && !extensionPoints.isDefined('ai.tool.pre-execute')) return null
    let raw: unknown
    try { raw = await extensionPoints.call('ai.tool.pre-execute', call, ctx) } catch (_) { return null }
    if (!raw || typeof raw !== 'object') return null
    // 裁决结果来自插件：只接受白名单形状。`args` 必须是对象 —— 否则原样透传下去，
    // 工具执行体会拿着字符串/数组当参数对象用，错误会以"工具内部异常"的面目出现。
    const result = raw as UnknownRecord
    const decision = result.decision === 'deny' ? 'deny' : result.decision === 'allow' ? 'allow' : undefined
    const args = result.args && typeof result.args === 'object' && !Array.isArray(result.args)
      ? result.args as JsonObject
      : undefined
    return {
      ...(decision ? { decision } : {}),
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
      ...(args ? { args } : {})
    }
  }

  return { list, get, preExecute }
}

module.exports = { createBuiltinTools, createToolRegistry }
