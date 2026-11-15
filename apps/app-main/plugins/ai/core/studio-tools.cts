/**
 * AI 工作室 · 工具声明（PART17 §4）。
 *
 * 一条工具 = 一份 JSON Schema + 一次服务调用。这里**不认识** fs / manifest / 安装器，
 * 所有规则都在 `core/studio.cjs`（规整）与 `main/studio.cjs`（安装）里。
 *
 * 审批策略：
 *   studio_create / studio_remove —— always（会往磁盘写东西 / 会删东西，每次都要点头）
 *   skill_save                    —— 按类型分档：prompt/agent = site（只存数据库）；
 *                                    script = always（脚本会在页面里执行，必须每次点头）
 *   其余只读                      —— never
 */

const { STUDIO_KINDS, GUIDE_SECTIONS } = require('./studio.cjs')

import type { AiToolDefinition, AiToolHost, JsonSchema, ToolArgs } from '../types'

const sections = GUIDE_SECTIONS as Array<{ id: string; title: string }>

/** 章节菜单文案 —— 从契约菜单生成，新增章节自动出现在工具描述里。 */
const GUIDE_MENU = sections.map((section) => `${section.id}（${section.title}）`).join(' / ')

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false }
}

/**
 * @param {{ studio?: any }} host
 */
function createStudioTools(host: AiToolHost): AiToolDefinition[] {
  const studio = host && host.studio

  function service() {
    if (!studio) throw new Error('AI 工作室未就绪')
    return studio
  }

  const tools: AiToolDefinition[] = [
    {
      name: 'studio_guide',
      description:
        '**【写任何带面板的插件前必读】** 返回《Hira 插件 · 声明式面板创作规范》——' +
        'manifest 里 contributes.panels[] 怎么写、panel.html / panel.js 骨架（hira:// 地址、base、CSP、type=module 全都由宿主注入，不用自己写）、' +
        'window.hira.* 能力与事件、data-hira-* 宿主约定、高频踩坑、提交前自检。' +
        '不要凭记忆写面板声明，否则最常见的后果是「面板一片空白」或「尚未实现」。' +
        '默认返回「快速上手」包（实现路径三选一 / manifest 示例 / panel.html / panel.js / 踩坑）；' +
        `需要其余章节时传 section，可选：${GUIDE_MENU}；` +
        '多个章节英文逗号分隔，all = 全本。',
      parameters: obj({
        section: {
          type: 'string',
          description: `章节 id（可多个，英文逗号分隔）：${sections.map((section) => section.id).join(' / ')}；all = 全本。不传 = 快速上手包`
        }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        return service().guide({ section: typeof args.section === 'string' ? args.section : undefined })
      }
    },
    {
      name: 'studio_capabilities',
      description:
        '查看 AI 工作室能产出什么：产物类型（插件 / 主题 / 用户脚本 / 技能）、可申请的权限 scope、' +
        '体积与文件数上限、插件目录、**面板契约（panels）与可用图标名（icons）**。' +
        '写带面板的插件前：先 `studio_guide` 读《声明式面板创作规范》（manifest 写法 / panel.html 骨架 / hira.* / data-* / 踩坑），' +
        '再用本工具取 icons 与权限 scope。icon 必须从 icons 里挑（否则回落 Puzzle），' +
        'contributes.panels[] 的每块面板必须由 manifest.render 或面板自己的 ui 实现。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        return service().capabilities()
      }
    },
    {
      name: 'studio_create',
      description:
        '生成并安装一份浏览器产物（用户明确要求"给我写个插件 / 主题 / 脚本 / 技能"时用）。' +
        'kind=plugin 时用 files 提供代码与资源（files 只放文件；manifest 用 manifest / contributes 参数传，manifest.main 是**可选**的主进程入口，只有需要后台能力时才写）；' +
        '**只做侧栏面板的插件不要写 main**：contributes.panels + manifest.ui 就够，type 会自动归为「界面面板插件」；' +
        '**要做面板时**：manifest.contributes.panels = [{ id, title, icon, ui? }]，' +
        '并在 manifest.render 指向可执行渲染模块（只认 .js/.mjs/.cjs，推荐 ESM，导出 rendererPlugin / panels[{ id, mount }]），' +
        '或改用声明式 ui: "panel.html"（插件内 HTML，宿主沙箱承载；也可只在 manifest 顶层写一次 ui，所有面板共用）。' +
        '两者都没有会被拒绝；' +
        'icon 取自 studio_capabilities().icons，未知名会回落 Puzzle；' +
        'kind=theme 时用 theme 提供 colors / style / background；' +
        'kind=userscript 时用 userscript 提供完整的 ==UserScript== 脚本；' +
        'kind=skill 时用 skill（或顶层 id / name / prompt / skillKind）。' +
        '安装成功后产物会立刻出现在插件列表 / 主题库 / 技能面板，并且可被用户启停与卸载。',
      parameters: obj({
        kind: { type: 'string', enum: [...STUDIO_KINDS], description: '产物类型' },
        id: { type: 'string', description: '可选；不给则由 name 派生。只能包含字母数字与 . _ -' },
        name: { type: 'string', description: '展示名称' },
        description: { type: 'string', description: '一句话说明' },
        version: { type: 'string', description: '版本号，默认 1.0.0' },
        overwrite: { type: 'boolean', description: '同 id 已存在时是否覆盖，默认 false' },
        manifest: {
          type: 'object',
          description: '可选，manifest 片段（与 files 里的 hira-plugin.json 等价，参数优先）；trustLevel / signature / permissionLevel / requestedPermissions 会被系统强制归一化'
        },
        files: {
          type: 'array',
          description: 'kind=plugin 的文件清单；也接受对象写法 { "main.js": "内容" }。别把 hira-plugin.json 放进来（它由系统生成；误放了会当作 manifest 输入）',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对路径，如 main.cjs / styles.css' },
              content: { type: 'string', description: '文件文本内容' }
            },
            required: ['path', 'content'],
            additionalProperties: false
          }
        },
        permissions: {
          type: 'array',
          description: '要申请的权限 scope（必须来自 studio_capabilities 的 permissions）',
          items: { type: 'string' }
        },
        contributes: {
          type: 'object',
          description:
            'kind=plugin 的声明式贡献。做面板时用 { panels: [{ id, title, icon, ui? }] }；' +
            '其它如 { bangs: [] }。面板的实现来源见 manifest.render'
        },
        theme: { type: 'object', description: 'kind=theme 的主题定义：{ mode, colors, style, background, icons }' },
        userscript: { type: 'string', description: 'kind=userscript 的完整脚本（含 ==UserScript== 元数据头）' },
        skill: {
          type: 'object',
          description: 'kind=skill 的技能对象：{ id, label, prompt, kind: prompt|script|agent, description }'
        }
      }, ['kind']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        return service().create(args)
      }
    },
    {
      name: 'studio_list',
      description:
        '列出用户目录里已安装的产物（AI 写的与用户自己装的都在内，不含内置插件）。卸载前先用它确认 id。' +
        '每项带 render 与 panels[] 自查信息：panels[].iconValid=false 表示图标名不在注册表（已回落 Puzzle），' +
        'panels[].implementation="none" 表示这块面板既没有 render 也没有 ui（打开会是「尚未实现」）。',
      parameters: obj({
        kind: { type: 'string', enum: ['plugin', 'theme', 'userscript'], description: '按类型过滤（theme / userscript 对应各自的插件 type）' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        const kind = String((args && args.kind) || '').toLowerCase()
        const wanted = kind === 'theme' ? 'theme-plugin' : kind === 'userscript' ? 'userscript-plugin' : kind
        return service().list(wanted ? { kind: wanted } : {})
      }
    },
    {
      name: 'studio_remove',
      description: '卸载一个用户安装的产物（插件 / 主题 / 用户脚本）。内置插件不可卸载。',
      parameters: obj({ id: { type: 'string', description: '产物的插件 id' } }, ['id']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        return service().remove({ id: args.id })
      }
    },
    {
      name: 'skill_list',
      description: '列出全部技能（插件贡献的 + 用户自建的），含 id / 名称 / 类型 / 是否启用。',
      parameters: obj({
        enabledOnly: { type: 'boolean', description: '只看已启用的' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs) {
        return service().skillList(args)
      }
    },
    {
      name: 'skill_save',
      description:
        '新建或更新一条用户技能（技能 = 一段可复用指令 / 脚本 / 子智能体提示词）。' +
        'kind=prompt 是最常见的；script 会在当前页面隔离世界执行；agent 会走子智能体。' +
        '插件贡献的技能不能改，可另存为新 id。',
      parameters: obj({
        id: { type: 'string', description: '技能 id（稳定标识）' },
        label: { type: 'string', description: '展示名称' },
        prompt: { type: 'string', description: '技能内容（模板 / 脚本 / 提示词）' },
        kind: { type: 'string', enum: ['prompt', 'script', 'agent'], description: '技能类型，默认 prompt' },
        icon: { type: 'string', description: '图标名（可选）' },
        description: { type: 'string', description: '一句话说明（可选）' }
      }, ['id', 'label', 'prompt']),
      risk: 'write',
      // script 技能 = 一段会在当前页面隔离世界执行的代码。写入成本必须与风险对齐：
      // 否则提示注入可以让模型「先存一条脚本技能，再诱导用户点运行」。
      approval: (args: ToolArgs) => (String(args.kind || 'prompt').toLowerCase() === 'script' ? 'always' : 'site'),
      async execute(args: ToolArgs) {
        return service().skillSave(args)
      }
    },
    {
      name: 'skill_remove',
      description: '删除一条用户技能（插件贡献的技能不可删除，只能停用）。',
      parameters: obj({ id: { type: 'string' } }, ['id']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs) {
        return service().skillRemove({ id: args.id })
      }
    },
    {
      name: 'skill_toggle',
      description: '启用或停用一条技能（插件技能也可以停用，状态存在本地）。',
      parameters: obj({
        id: { type: 'string' },
        enabled: { type: 'boolean', description: 'true 启用 / false 停用' }
      }, ['id', 'enabled']),
      risk: 'write',
      approval: 'never',
      async execute(args: ToolArgs) {
        return service().skillToggle({ id: args.id, enabled: args.enabled })
      }
    }
  ]

  tools.push({
    name: 'plugin_author',
    description:
      '编写浏览器插件/主题/用户脚本/技能的一体化入口。design 一次返回精简规范、权限和图标；validate 在写盘前检查 manifest、面板入口、文件路径与图标；install 校验后安装并返回启用状态；status 查看已安装产物；toggle/remove 管理产物。' +
      '优先用它完成整条创作链路，不要反复搜索 studio_* 工具。spec 与 studio_create 参数相同。',
    parameters: obj({
      command: {
        type: 'string',
        enum: ['design', 'validate', 'install', 'status', 'toggle', 'remove'],
        description: '要执行的创作步骤'
      },
      spec: {
        type: 'object',
        description: 'install/validate 的产物定义：kind、id、name、description、version、overwrite、manifest、files、permissions、contributes、theme、userscript、skill'
      },
      id: { type: 'string', description: 'status 过滤或 toggle/remove 的插件 id' },
      kind: { type: 'string', description: 'status 过滤类型，可选 plugin/theme/userscript' },
      enabled: { type: 'boolean', description: 'toggle 时目标状态' }
    }, ['command']),
    risk: 'write',
    approval: (args: ToolArgs) => {
      const command = String(args.command || '')
      if (command === 'install' || command === 'remove') return 'always'
      if (command === 'toggle') return 'site'
      return 'never'
    },
    async execute(args: ToolArgs) {
      const command = String(args.command || '').trim()
      const spec = args.spec && typeof args.spec === 'object' && !Array.isArray(args.spec)
        ? args.spec as Record<string, unknown>
        : {}
      if (command === 'design') {
        const guide = service().guide({}) as { markdown?: string; sections?: unknown[]; remaining?: unknown[] }
        const all = service().capabilities() as Record<string, unknown>
        const panels = all.panels && typeof all.panels === 'object' ? all.panels as Record<string, unknown> : {}
        return {
          ok: true,
          guide,
          capabilities: {
            kinds: all.kinds,
            permissions: all.permissions,
            panels: {
              where: panels.where,
              fields: panels.fields,
              aliases: panels.aliases,
              example: panels.example
            },
            icons: all.icons,
            limits: all.limits,
            permissionLevels: all.permissionLevels,
            manifestName: all.manifestName
          }
        }
      }
      if (command === 'validate') return service().prepare(spec)
      if (command === 'install') return service().create(spec)
      if (command === 'status') {
        const listed = service().list({ ...(args.kind ? { kind: String(args.kind) } : {}) }) as {
          [key: string]: unknown
          plugins?: Array<{ id?: string; [key: string]: unknown }>
        }
        if (!args.id || !listed || !Array.isArray(listed.plugins)) return listed
        const id = String(args.id)
        return { ...listed, total: listed.plugins.filter((plugin: { id?: string }) => plugin.id === id).length, plugins: listed.plugins.filter((plugin: { id?: string }) => plugin.id === id) }
      }
      if (command === 'toggle') {
        return service().toggle({ id: args.id, enabled: args.enabled !== false })
      }
      if (command === 'remove') return service().remove({ id: args.id })
      throw new Error(`不支持的 plugin_author.command：${command}`)
    }
  })
  return tools
}

module.exports = { createStudioTools }
