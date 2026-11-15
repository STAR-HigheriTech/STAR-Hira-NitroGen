/**
 * AI 引擎 · 插件生态工具（PART18 开放世界）。
 *
 * 与 `browser-tools.cjs` / `app-tools.cjs` 的分工：那边操作**浏览器自带**的设施，
 * 这边操作**插件贡献出来**的设施 —— 插件清单、插件命令、插件内部页、插件浮层。
 *
 * 三条纪律（与其它工具文件一致）：
 *   1. 不另建一套实现 —— 命令走 `plugin-surfaces#runAction`，浮层走
 *      `plugin-overlays#show/hide`，页面 URL 走 `plugin-surfaces#pageUrl`。
 *      否则「用户点菜单」与「AI 调工具」会慢慢漂移成两种行为；
 *   2. 不直接认识 Electron 窗口模型 —— 标签管理器经 `host.getTabManager` 注入；
 *   3. 结果必须短 —— 清单一律截断 + 只给模型需要的字段。
 */

const { summarizePanelContribution, isRenderModulePath } = require('@hira-ng/shared-types/src/plugin-ui.mjs')

import type {
  AiToolDefinition,
  AiToolHost,
  JsonSchema,
  PluginCommand,
  PluginDescriptorPort,
  PluginOverlayDescriptor,
  PluginSurfacesPort,
  PluginOverlayHostPort,
  ToolArgs,
  UnknownRecord
} from '../types'

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/** 单行摘录（压掉换行与连续空白，超长截断）。 */
function clip(text: unknown, max: number): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * @param {{
 *   getPluginRegistry?: () => any,
 *   pluginSurfaces?: any,
 *   pluginOverlayHost?: any,
 *   extensionPoints?: any,
 *   getTabManager?: () => any
 * }} host
 */
function createPluginTools(host: AiToolHost): AiToolDefinition[] {
  const surfacesOf = () => host.pluginSurfaces || null
  const overlaysOf = () => host.pluginOverlayHost || null
  const registryOf = () => {
    try { return typeof host.getPluginRegistry === 'function' ? host.getPluginRegistry() : null } catch (_) { return null }
  }
  const tabsOf = () => {
    const tm = typeof host.getTabManager === 'function' ? host.getTabManager() : null
    if (!tm || typeof tm.newTab !== 'function') throw new Error('标签管理器不可用')
    return tm
  }

  function requireSurfaces(): PluginSurfacesPort {
    const s = surfacesOf()
    if (!s) throw new Error('插件表面不可用（插件系统尚未就绪）')
    return s
  }

  function requireOverlays(): PluginOverlayHostPort {
    const o = overlaysOf()
    if (!o) throw new Error('插件浮层宿主不可用（插件系统尚未就绪）')
    return o
  }

  /** 贡献数量摘要：`{ panels: 2, commands: 1 }` —— 只给数字，不给整份 manifest。 */
  function contributionCounts(contributes: unknown): Record<string, number> {
    const out: Record<string, number> = {}
    if (!contributes || typeof contributes !== 'object') return out
    for (const [key, value] of Object.entries(contributes)) {
      if (Array.isArray(value)) {
        if (value.length) out[key] = value.length
      } else if (value && typeof value === 'object') {
        out[key] = 1
      }
    }
    return out
  }

  /**
   * 每块面板的实现摘要 —— 让模型能自查「为什么没图标 / 为什么打开说尚未实现」。
   * 判定与创作侧共用 shared-types 的同一函数，不在这里再写一套。
   */
  function panelSummaries(p: PluginDescriptorPort): unknown[] {
    const list = p && p.contributes && p.contributes.panels
    if (!Array.isArray(list)) return []
    // 实现来源按同一套判定：顶层 ui 可被面板继承，HTML 不能算 render。
    const hasRender = !!p.render && isRenderModulePath(p.render)
    const manifestUi = p.uiEntry || null
    return list.map((panel) => summarizePanelContribution(panel, { hasRender, manifestUi }))
  }

  /**
   * 扩展点命令（`browser.command`）：`{ id, label, run(ctx) }`。
   * 声明式命令（contributes.commands）走 surfaces；这里补上「插件用扩展点注册」的那一半。
   */
  function extensionCommands(): PluginCommand[] {
    const ep = host.extensionPoints
    if (!ep || typeof ep.callSync !== 'function') return []
    if (typeof ep.isDefined === 'function' && !ep.isDefined('browser.command')) return []
    let raw: unknown = []
    try { raw = ep.callSync('browser.command', {}, {}) } catch (_) { return [] }
    return (Array.isArray(raw) ? raw.flat(1) : [])
      .filter((command): command is UnknownRecord => !!command && typeof command === 'object' && typeof command.id === 'string' && typeof command.run === 'function')
      .map((command) => ({
        id: String(command.id),
        pluginId: String(command.pluginId || ''),
        label: String(command.label || command.title || command.id),
        description: String(command.description || ''),
        keywords: Array.isArray(command.keywords) ? command.keywords.map(String) : [],
        action: null,
        source: 'extension' as const,
        run: command.run as PluginCommand['run']
      }))
  }

  /** 插件命令总表（声明式 + 扩展点），按 `pluginId:id` 去重（声明式优先）。 */
  function allCommands(): { declared: PluginCommand[]; extension: PluginCommand[] } {
    const s = surfacesOf()
    const declared = s && typeof s.listCommands === 'function' ? s.listCommands() : []
    const seen = new Set(declared.map((c) => `${c.pluginId}:${c.id}`))
    const extra = extensionCommands().filter((c) => {
      const key = `${c.pluginId}:${c.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { declared, extension: extra }
  }

  /** `pluginId:id` 或裸 id（唯一命中才算，避免删错插件）→ 命令项。 */
  function resolveCommand(ref: unknown): PluginCommand | null {
    const { declared, extension } = allCommands()
    const text = String(ref || '').trim()
    if (!text) return null
    const all = [...declared, ...extension]
    const exact = all.find((c) => `${c.pluginId}:${c.id}` === text)
    if (exact) return exact
    const bare = all.filter((c) => c.id === text)
    return bare.length === 1 ? bare[0] : null
  }

  /** 浮层引用解析：`pluginId:id` / 裸 id（唯一命中）。 */
  function resolveOverlay(ref: unknown): PluginOverlayDescriptor | null {
    const s = requireSurfaces()
    const list = typeof s.listOverlays === 'function' ? s.listOverlays() : []
    const text = String(ref || '').trim()
    if (!text) return null
    const exact = list.find((o) => `${o.pluginId}:${o.id}` === text)
    if (exact) return exact
    const bare = list.filter((o) => o.id === text)
    return bare.length === 1 ? bare[0] : null
  }

  function urlWithQuery(url: string, query: unknown): string {
    if (!query || typeof query !== 'object') return url
    const pairs: string[] = []
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
    if (!pairs.length) return url
    return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`
  }

  const tools: AiToolDefinition[] = [
    // ── 插件清单 ─────────────────────────────────────────────────────────
    {
      name: 'plugin_list',
      description:
        '列出已安装的插件（id / 名称 / 版本 / 是否启用 / 是否第一方），以及每个插件贡献了几项什么' +
        '（面板 / 命令 / 页面 / 浮层 / 按钮…）。默认只返回精简清单；需要排查实现时传 detailed=true，' +
        '会额外带 render 与 panels[] 自查信息：' +
        'panels[].iconValid=false 表示图标名不在注册表（已回落 Puzzle），' +
        'panels[].implementation="none" 表示这块面板既没有 render 也没有 ui（打开会是「尚未实现」）。' +
        '想调用插件能力前先用它确认插件 id 与贡献存在。',
      parameters: obj({
        enabledOnly: { type: 'boolean', description: '只看已启用的插件，默认是' },
        detailed: { type: 'boolean', description: '附带 render / uiEntry / panels 实现诊断，默认否' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const reg = registryOf()
        if (!reg || typeof reg.describe !== 'function') throw new Error('插件注册中心尚未就绪')
        const enabledOnly = args.enabledOnly !== false
        const detailed = args.detailed === true
        const rows = reg.describe()
        const items = (Array.isArray(rows) ? rows : [])
          .filter((p) => !enabledOnly || p.enabled !== false)
          .map((p) => {
            const contributes = contributionCounts(p.contributes)
            const panels = panelSummaries(p)
            return {
              id: String(p.id || ''),
              name: String(p.name || p.id || ''),
              version: String(p.version || ''),
              enabled: p.enabled !== false,
              firstParty: p.isFirstParty === true,
              ...(detailed || Object.keys(contributes).length ? { contributes } : {}),
              ...(detailed || panels.length ? {
                render: !!p.render,
                uiEntry: p.uiEntry || null,
                panels
              } : {})
            }
          })
        return { total: items.length, items }
      }
    },

    // ── 插件命令 ─────────────────────────────────────────────────────────
    {
      name: 'plugin_command_list',
      description:
        '列出插件贡献的命令（id / 所属插件 / 中文名 / 关键词）。这些是插件自己暴露的「一键动作」，' +
        '执行用 plugin_command_run。',
      parameters: obj({
        query: { type: 'string', description: '按关键词过滤（id / 名称 / 描述）' },
        limit: { type: 'number', description: '最多返回多少条，默认 60' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const { declared, extension } = allCommands()
        const query = String(args.query || '').trim().toLowerCase()
        const limit = Math.min(Math.max(Math.round(Number(args.limit) || 60), 1), 120)
        const match = (c: PluginCommand) => {
          if (!query) return true
          const hay = `${c.id} ${c.label} ${c.description} ${(c.keywords || []).join(' ')}`.toLowerCase()
          return hay.includes(query)
        }
        const items = [...declared, ...extension].filter(match).slice(0, limit).map((c) => ({
          id: c.id,
          ref: `${c.pluginId}:${c.id}`,
          pluginId: c.pluginId,
          label: c.label,
          description: clip(c.description, 120),
          keywords: c.keywords || [],
          runnable: c.source === 'extension' ? true : !!(c.action && typeof c.action === 'object')
        }))
        return { total: items.length, items }
      }
    },
    {
      name: 'plugin_command_run',
      description:
        '执行一个插件命令（id 取自 plugin_command_list）。ref 支持 `pluginId:id` 精确写法，' +
        '也支持裸 id（全库唯一时才接受）。',
      parameters: obj({
        ref: { type: 'string', description: '命令引用：`pluginId:id` 或唯一的 id' }
      }, ['ref']),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const ref = String(args.ref || '').trim()
        if (!ref) throw new Error('ref 不能为空')
        const cmd = resolveCommand(ref)
        if (!cmd) throw new Error(`没有匹配的插件命令：${ref}。先用 plugin_command_list 查看可用命令`)
        if (cmd.source === 'extension') {
          // 扩展点命令的 `run` 只活在主进程，直接调用即可（与用户点同一份实现）。
          if (typeof cmd.run !== 'function') throw new Error(`命令「${cmd.label}」没有可执行实现`)
          const result = await cmd.run({})
          return { ok: true, ref: `${cmd.pluginId}:${cmd.id}`, result: result === undefined ? null : result }
        }
        if (!cmd.action || typeof cmd.action !== 'object') {
          throw new Error(`命令「${cmd.label}」没有可执行动作`)
        }
        const s = requireSurfaces()
        const ok = s.runAction(cmd.action, { pluginId: cmd.pluginId, payload: {} })
        return { ok: ok === true, ref: `${cmd.pluginId}:${cmd.id}`, label: cmd.label }
      }
    },

    // ── 插件内部页 ───────────────────────────────────────────────────────
    {
      name: 'plugin_page_list',
      description: '列出插件提供的内部页（标题 / 所属插件 / hira:// 地址）。打开用 plugin_page_open。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const s = requireSurfaces()
        const rows = typeof s.listPages === 'function' ? s.listPages() : []
        const items = rows.map((p) => ({
          id: p.id,
          ref: `${p.pluginId}:${p.id}`,
          pluginId: p.pluginId,
          title: p.title,
          url: p.url
        }))
        return { total: items.length, items }
      }
    },
    {
      name: 'plugin_page_open',
      description:
        '在新标签打开一个插件内部页。ref 支持 `pluginId:pageId` 或裸 pageId（需要同时给 pluginId）。',
      parameters: obj({
        ref: { type: 'string', description: '页面引用：`pluginId:pageId` 或 pageId' },
        pluginId: { type: 'string', description: 'ref 只给 pageId 时必填' },
        query: { type: 'object', description: '可选查询参数（键值对）' }
      }, ['ref']),
      risk: 'write',
      approval: 'never',
      async execute(args: ToolArgs) {
        const ref = String(args.ref || '').trim()
        if (!ref) throw new Error('ref 不能为空')
        const s = requireSurfaces()
        const selfId = String(args.pluginId || '').trim()
        const url = urlWithQuery(String(s.pageUrl(ref, selfId) || ''), args.query)
        if (!url) throw new Error(`没有这个插件页面：${ref}。先用 plugin_page_list 查看`)
        const res = await tabsOf().newTab({ url })
        return { ok: true, url, tabId: res && res.tabId }
      }
    },

    // ── 插件浮层 ─────────────────────────────────────────────────────────
    {
      name: 'plugin_overlay_list',
      description:
        '查看插件浮层：声明式浮层（overlay 贡献，可用 plugin_overlay_show 打开）与当前已打开的浮层。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        const s = requireSurfaces()
        const declared = typeof s.listOverlays === 'function' ? s.listOverlays() : []
        const o = overlaysOf()
        const open = o && typeof o.listAll === 'function' ? o.listAll() : []
        return {
          declared: declared.map((x) => ({
            id: x.id,
            ref: `${x.pluginId}:${x.id}`,
            pluginId: x.pluginId,
            title: x.title,
            page: x.page,
            anchor: x.anchor,
            width: x.width,
            height: x.height,
            modal: x.modal
          })),
          open: open.map((x) => ({ key: x.key, pluginId: x.pluginId, id: x.id, title: x.title, url: x.url }))
        }
      }
    },
    {
      name: 'plugin_overlay_show',
      description:
        '打开一个插件浮层。要么给 overlay（声明式浮层的 `pluginId:id` 或唯一 id），' +
        '要么给 pluginId + page/url 临时开一个。浮层内容由插件页面提供（iframe 容器由外壳绘制）。',
      parameters: obj({
        overlay: { type: 'string', description: '声明式浮层引用（`pluginId:id` 或唯一 id）' },
        pluginId: { type: 'string', description: '插件 id（临时浮层必填）' },
        id: { type: 'string', description: '浮层 id（同一 id 重复 show 会覆盖），默认 ai-overlay' },
        title: { type: 'string', description: '浮层标题（省略则不画标题栏）' },
        page: { type: 'string', description: '插件页面引用（pageId 或 pluginId:pageId）' },
        url: { type: 'string', description: '直接给绝对地址（与 page 二选一）' },
        anchor: { type: 'string', description: '锚点：center / top-left / bottom-right …，默认 center' },
        width: { type: 'number' },
        height: { type: 'number' },
        modal: { type: 'boolean' }
      }),
      risk: 'write',
      approval: 'site',
      async execute(args: ToolArgs) {
        const o = requireOverlays()
        const ref = String(args.overlay || '').trim()
        let descriptor
        let pluginId
        if (ref) {
          const hit = resolveOverlay(ref)
          if (!hit) throw new Error(`没有匹配的声明式浮层：${ref}。先用 plugin_overlay_list 查看`)
          pluginId = String(hit.pluginId || '')
          descriptor = {
            id: hit.id,
            title: hit.title,
            page: hit.page,
            anchor: hit.anchor,
            width: hit.width,
            height: hit.height,
            modal: hit.modal
          }
        } else {
          pluginId = String(args.pluginId || '').trim()
          if (!pluginId) throw new Error('临时浮层需要 pluginId（或改用 overlay 引用）')
          descriptor = {
            id: String(args.id || 'ai-overlay'),
            title: args.title === undefined ? '' : String(args.title),
            page: args.page ? String(args.page) : '',
            url: args.url ? String(args.url) : '',
            anchor: args.anchor ? String(args.anchor) : 'center',
            width: Number(args.width) || 0,
            height: Number(args.height) || 0,
            modal: args.modal === true
          }
        }
        const res = o.show(descriptor, pluginId)
        if (!res || res.ok !== true) throw new Error(`浮层打开失败：${(res && res.reason) || '未知原因'}`)
        return { ok: true, key: res.key, url: res.url }
      }
    },
    {
      name: 'plugin_overlay_hide',
      description: '关闭一个插件浮层。给 key（plugin_overlay_list 的 open[].key）或 pluginId + id。',
      parameters: obj({
        key: { type: 'string', description: '完整 key（pluginId:id）' },
        pluginId: { type: 'string' },
        id: { type: 'string' }
      }),
      risk: 'write',
      approval: 'never',
      async execute(args: ToolArgs) {
        const o = requireOverlays()
        const key = String(args.key || '').trim()
        if (key) {
          const closed = o.hide(key)
          return { ok: closed === true, key }
        }
        const pluginId = String(args.pluginId || '').trim()
        const id = String(args.id || '').trim()
        if (!pluginId || !id) throw new Error('需要 key，或 pluginId + id')
        const closed = o.hide(id, pluginId)
        return { ok: closed === true, key: `${pluginId}:${id}` }
      }
    }
  ]
  return tools
}

module.exports = { createPluginTools }
