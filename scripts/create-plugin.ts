#!/usr/bin/env node
/**
 * 插件脚手架（PART7 §7.8 的「SDK」那一半：脚手架）。
 *
 *   pnpm plugin:new my-plugin                      最小可用插件（无能力、无界面）
 *   pnpm plugin:new my-plugin --cap a.b,c.d        声明并注册两个能力
 *   pnpm plugin:new my-panel --type ui-panel-plugin --render --panel my-panel:我的面板:Star
 *   pnpm plugin:new my-thing --third-party         第三方形态（trustLevel: community）
 *
 * 三类**声明式扩展面**（纯数据，第三方运行时插件同样生效，不需要 `render`）：
 *   pnpm plugin:new my-plugin --page "home:我的首页"      内部页（hira://p-my-plugin-home/）
 *   pnpm plugin:new my-plugin --bang "my:我的搜索"        地址栏 bang（`!my 关键词`）
 *   pnpm plugin:new my-plugin --menu                      往主菜单 / 标签右键各加一项（指向 page/bang/panel）
 *
 * 设计取向：**生成的是能跑的真插件，不是占位桩**。
 *   · 声明的能力一定在 `registerProviders()` 里逐条注册（否则 `pnpm plugin:coverage`
 *     会立刻报"声明了却没注册"—— 那正是本仓库已有的门禁，脚手架不该生成一个
 *     一出生就违规的东西）；
 *   · 生成后 `pnpm plugin:validate <id>` 应当**零错误**通过；
 *   · manifest 字段全部按当前规范写（`main` / `render` / `capabilities` /
 *     `dependsOn` / `trustLevel` / `contributes`），不用作者再去翻文档猜。
 *
 * 为什么写在 `apps/app-main/plugins/`：那是 `discover()` 唯一扫描的目录。
 * 目录可用 `--dir=` 覆盖（移植到别的发行版时用）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { errorMessage } from './lib/type-guards'

const { SEARCH_ENGINES, DEFAULT_SEARCH_ENGINE } = require('@hira-ng/shared-types/src/search-engines.mjs')
// 模板里两处字体栈都从唯一真源取（生成器本身不手抄字体串）。
const { UI_FONT_STACK, uiFontVar } = require('@hira-ng/shared-types/src/font-stack.mjs')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_DIR = path.join(ROOT, 'apps/app-main/plugins')

/** `--bang` 省略 URL 时的兜底模板 —— 与仓库缺省搜索引擎同源，不手抄引擎地址。 */
const DEFAULT_BANG_URL = `${SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE].template}{query}`

const VALID_TYPES = new Set(['feature-plugin', 'ui-panel-plugin', 'service-plugin', 'community-mod'])

interface PluginCliOptions {
  _: string[]
  caps: string[]
  panel: string | null
  page: string | null
  bang: string | null
  render: boolean
  thirdParty: boolean
  menu: boolean
  dir?: string
  type?: string
  name?: string
  desc?: string
  depends?: string[]
}

interface PanelSpec { id: string; title: string; icon: string }
interface PageSpec { id: string; title: string; dir: string; entry: string }
interface BangSpec { id: string; trigger: string; title: string; url: string; showSuggestions: boolean }
interface PluginManifest {
  id: string
  name: string
  version: string
  type: string
  trustLevel: string
  description: string
  main: string
  render?: string
  capabilities?: string[]
  dependsOn?: string[]
  contributes?: Record<string, unknown>
}

/** 列表类参数：逗号 / 加号 / 空格都当分隔符（PowerShell 会把 `a,b` 拆成 `a b`）。 */
function parseList(value: unknown): string[] {
  return String(value || '').split(/[,+\s]+/).map((s) => s.trim()).filter(Boolean)
}

/** 需要取值的开关（`--cap=x` 与 `--cap x` 两种写法都收）。 */
const VALUE_FLAGS = new Set(['dir', 'type', 'cap', 'panel', 'name', 'desc', 'depends', 'page', 'bang'])

/**
 * 可以不给值的开关：不给时按默认规格生成。
 * 区分「`--page` 就够用」（走默认 id / 标题）与「`--dir` 必须给值」—— 后者漏值时
 * 猜一个目录只会把文件写到作者没想到的地方。
 */
const OPTIONAL_VALUE_FLAGS = new Set(['page', 'bang'])

function parseArgs(argv: readonly string[]): PluginCliOptions {
  const out: PluginCliOptions = {
    _: [], caps: [], panel: null, page: null, bang: null,
    render: false, thirdParty: false, menu: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--render') { out.render = true; continue }
    if (arg === '--third-party') { out.thirdParty = true; continue }
    if (arg === '--menu') { out.menu = true; continue }
    if (!arg.startsWith('--')) { out._.push(arg); continue }

    // ① `--key=value`
    let key: string
    let value: string | null = null
    const eq = /^--([a-z-]+)=(.*)$/.exec(arg)
    if (eq) {
      key = eq[1]
      value = eq[2]
    } else {
      // ② `--key value`（取下一个非 -- 开头的参数）
      key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { value = next; i++ }
    }
    if (!VALUE_FLAGS.has(key)) throw new Error(`未知参数：--${key}`)
    if (value === null) {
      if (!OPTIONAL_VALUE_FLAGS.has(key)) throw new Error(`--${key} 需要一个值`)
      value = ''
    }

    if (key === 'dir') out.dir = value
    else if (key === 'type') out.type = value
    else if (key === 'cap') out.caps = out.caps.concat(parseList(value))
    else if (key === 'panel') out.panel = value
    else if (key === 'page') out.page = value
    else if (key === 'bang') out.bang = value
    else if (key === 'name') out.name = value
    else if (key === 'desc') out.desc = value
    else if (key === 'depends') out.depends = (out.depends || []).concat(parseList(value))
  }
  return out
}

/** `--panel "id:标题:图标"` → `{ id, title, icon }`；缺项走默认。 */
function parsePanelSpec(spec: unknown, fallbackId: string): PanelSpec {
  const [id, title, icon] = String(spec || '').split(':')
  return {
    id: (id || '').trim() || `${fallbackId}-panel`,
    title: (title || '').trim() || '新面板',
    icon: (icon || '').trim() || 'Star'
  }
}

/**
 * `--page "id:标题"` → 内部页声明。id 同时是目录名（`pages/<id>/index.html`），
 * 所以规则比标题严：与插件 id 同一套（小写字母 / 数字 / 连字符）。
 */
function parsePageSpec(spec: unknown): PageSpec {
  const [id, title] = String(spec || '').split(':')
  const pageId = (id || '').trim() || 'home'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pageId)) {
    throw new Error(`页面 id 只能是小写字母、数字与连字符，且以字母/数字开头：${pageId}`)
  }
  return {
    id: pageId,
    title: (title || '').trim() || '首页',
    dir: `pages/${pageId}`,
    entry: 'index.html'
  }
}

/**
 * `--bang "trigger:标题:URL 模板"` → bang 声明。
 * URL 自带 `:`，所以只把前两段当 trigger / 标题，其余整体拼回 URL。
 */
function parseBangSpec(spec: unknown, fallbackId: string): BangSpec {
  const parts = String(spec || '').split(':')
  const trigger = (parts[0] || '').trim().toLowerCase().replace(/\s+/g, '') || fallbackId
  const title = (parts[1] || '').trim() || trigger
  const url = parts.slice(2).join(':').trim() || DEFAULT_BANG_URL
  return { id: trigger, trigger, title, url, showSuggestions: true }
}

/** 页面模板里的用户文案要转义 —— 标题来自命令行，不该能破坏 HTML。 */
function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 内部页模板。
 *
 * 页面运行在**独立 origin**（`hira://p-<plugin>-<page>/`），所以这里刻意不引任何
 * 外部资源：插件作者往同目录加 `style.css` / `app.js`，用相对路径即可（协议层按
 * 插件根目录分发，见 `main/plugin-surfaces.js#resolvePageDirs`）。
 */
const PAGE_TEMPLATE = ({ pluginId, page }: { pluginId: string; page: PageSpec }): string => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(page.title)}</title>
    <style>
      /* 插件面板文档：字体栈取唯一真源（shared-types/font-stack.mjs#UI_FONT_STACK），
         否则小字号中文会按系统默认回退成宋体点阵。 */
      :root { color-scheme: light dark; font-family: ${UI_FONT_STACK}; }
      body { margin: 0; padding: 40px clamp(20px, 6vw, 72px); line-height: 1.7; }
      h1 { font-size: 24px; margin: 0 0 8px; }
      p { margin: 8px 0; opacity: .82; }
      code { padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, currentColor 10%, transparent); }
      .card { max-width: 720px; padding: 24px 28px; border-radius: 14px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${escapeHtml(page.title)}</h1>
      <p>这是插件 <code>${escapeHtml(pluginId)}</code> 的内部页，运行在独立 origin：</p>
      <p><code>hira://p-${escapeHtml(pluginId)}-${escapeHtml(page.id)}/</code></p>
      <p>同目录放 <code>style.css</code> / <code>app.js</code>，用相对路径引用即可。</p>
    </main>
  </body>
</html>
`

const MODULE_TEMPLATE = ({ id, caps, hasRender }: { id: string; caps: string[]; hasRender: boolean }): string => {
  const capLines = caps.length
    ? caps.map((c) => `    {
      // id 必须全局唯一；capability 必须与 manifest.capabilities 里那一条逐字一致。
      id: '${id}:${c}',
      capability: '${c}',
      /**
       * 能力实现。两个参数（见 infra-plugin#service-plugin 的同款签名）：
       *   input      调用方传进来的入参对象
       *   execution  本次调用的执行上下文 —— 运行时手柄在 execution.context 上
       *              （如窗口级的 getUsingSpace），**不要**把它与下面闭包里的 ctx 搞混
       */
      around(input, execution) {
        // TODO: 把 input 翻成对域服务的调用。
        // 服务对象来自下面闭包里的 svc；运行时手柄取 execution.context。
        throw new Error('${c} 尚未实现')
      }
    }`).join(',\n')
    : ''
  return `/**
 * ${id} —— 插件实现（主进程侧）。
 *
 * 生命周期 hook（全部可选，按调用顺序）：
 *   preInstall / install / postInstall      只在首次安装时跑一次
 *   preEnable  / enable  / postEnable       每次启用都跑（禁用后重新启用会再跑）
 *   preDisable / disable                    停用时跑（任何清理都写这里）
 *   uninstall                               卸载时跑
 *   healthCheck(ctx)                        主动健康检查（需在 manifest 声明 healthCheck）
 *   extensionPoints(ctx) / registerProviders(ctx) / registerServices(ctx) / injectStyles(ctx)
 *
 * ctx 里有什么，见 docs-ng/插件化落地现状与扩展指南.md §4.4 / §4.6。
 */
module.exports = {
${caps.length ? `  /**
   * 能力实现。**每一条 manifest.capabilities 都必须在这里注册对应 provider** ——
   * 否则 \`pnpm plugin:coverage\` 会报「声明了却没注册」，而禁用开关也会因为
   * 「能力清单来自 manifest、provider 却不存在」出现难以理解的行为。
   */
  registerProviders(ctx) {
    const svc = ctx && typeof ctx.getDomainServices === 'function'
      ? ctx.getDomainServices().myService
      : null
    return [
${capLines}
    ]
  },
` : ''}  /** 安装：只在首次安装时跑一次（建表、写默认配置…）。 */
  async install(ctx) {},

  /** 启用：把定时器 / 订阅挂在这里。 */
  async enable(ctx) {
    // this._timer = setInterval(() => {}, 60000)
  },

  /** 停用：**必须**把 enable 里挂的一切收干净（否则禁用只是"看起来"生效）。 */
  async disable(ctx) {
    // if (this._timer) { clearInterval(this._timer); this._timer = null }
  }
}
${hasRender ? '\n// ⚠ 渲染侧代码请写在 ' + id + '.renderer.ts 里（本文件是主进程侧的）。' : ''}
`
}

const RENDERER_TEMPLATE = ({ id, panel }: { id: string; panel: PanelSpec | null }): string => `/**
 * ${id} —— 渲染侧入口（\`entry.render\`）。
 *
 * 这是独立构建的渲染模块，运行时经 \`hira-plugin://\` 动态加载：
 *   · 构建器会把依赖打进单文件，运行时不依赖 Vite 的 glob；
 *   · 文件名必须以 \`.renderer.ts\` 结尾；构建后对应 manifest 的 \`render\` .js 入口。
 *
 * 两种用法（可同时用）：
 *   1. \`panels\` —— 贡献侧栏面板（manifest 的 contributes.panels[].id 必须与这里一致）
 *   2. \`slots\`  —— 贡献渲染侧插槽实现（宿主必须先 defineRendererSlots 声明它）
 */
export const rendererPlugin = {
${panel
    ? `  panels: [{
    id: ${JSON.stringify(panel.id)},
    // 挂载契约：mount(doc, ctx) 返回 { element, refresh?, serialize?, restore?, focusSearch? }。
    // ctx 里有 tabs / panels / bookmarks / notes / settings / events / confirm / icons …
    mount(doc, ctx) {
      const root = doc.createElement('div')
      root.style.cssText = 'padding:16px;font:13px/1.6 ${uiFontVar()};color:inherit'
      const title = doc.createElement('h3')
      title.style.cssText = 'margin:0 0 8px;font-size:14px'
      title.textContent = ${JSON.stringify(panel.title)}
      const hint = doc.createElement('p')
      hint.style.cssText = 'margin:0;opacity:.7'
      hint.textContent = '面板已接通：把这段替换成你的界面即可。'
      root.append(title, hint)
      return { element: root }
    }
  }],`
    : `  // 没有声明面板时留空即可；声明后用 manifest.contributes.panels[].id 对齐：
  // panels: [{ id: '${id}-panel', mount(doc, ctx) { return { element: doc.createElement('div') } } }],`}

  slots: {
    // 'omnibar.result-item-renderer': (payload) => {
    //   const el = document.createElement('div')
    //   el.textContent = payload.suggestion.title || ''
    //   return el
    // }
  }
}
`

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const id = String(args._[0] || '').trim()
  if (!id) {
    console.error('用法：pnpm plugin:new <plugin-id> [--type=…] [--cap=a.b,c.d] [--render] [--panel=id:标题:图标] [--third-party] [--depends=x,y] [--dir=…]')
    process.exit(2)
  }
  // id 规则与 discover() 无强绑定，但保持 kebab-case 能让文件名/manifest id 永远一致，
  // 而"文件名与 id 不一致"是排查插件问题时最容易多绕一圈的坑。
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    console.error(`插件 id 只能是小写字母、数字与连字符，且以字母/数字开头：${id}`)
    process.exit(2)
  }

  const dir = args.dir ? path.resolve(ROOT, args.dir) : DEFAULT_DIR
  const type = args.type || (args.render ? 'ui-panel-plugin' : 'feature-plugin')
  if (!VALID_TYPES.has(type)) {
    console.error(`未知插件类型：${type}（可选：${Array.from(VALID_TYPES).join(' / ')}）`)
    process.exit(2)
  }

  const manifestPath = path.join(dir, `${id}.hira-plugin.json`)
  const modulePath = path.join(dir, `${id}.cts`)
  const rendererPath = path.join(dir, `${id}.renderer.ts`)
  const existing = [manifestPath, modulePath, rendererPath].filter((p) => fs.existsSync(p))
  if (existing.length) {
    console.error(`已存在同名文件，拒绝覆盖：\n  ${existing.join('\n  ')}`)
    process.exit(1)
  }

  const manifest: PluginManifest = {
    id,
    name: args.name || id,
    version: '0.0.1',
    type,
    trustLevel: args.thirdParty ? 'community' : 'internal',
    description: args.desc || `${id} 插件（脚手架生成，待补描述）`,
    main: `./${id}.cjs`
  }
  if (args.render) manifest.render = `./${id}.renderer.js`
  if (args.caps.length) manifest.capabilities = args.caps
  if (args.depends && args.depends.length) manifest.dependsOn = args.depends

  const panel = args.render && args.panel ? parsePanelSpec(args.panel, id) : null
  const page = args.page !== null ? parsePageSpec(args.page) : null
  const bang = args.bang !== null ? parseBangSpec(args.bang, id) : null

  /*
   * 三类声明式扩展面 + 面板，全部写进同一个 contributes。
   * 顺序（panels → pages → bangs → menus）不是随意的：编辑器里读起来刚好是
   * "界面 → 页面 → 搜索 → 菜单入口"的因果顺序，作者顺着读就知道菜单指向谁。
   */
  const contributes: Record<string, unknown> = {}
  if (panel) {
    contributes.panels = [{ id: panel.id, title: panel.title, icon: panel.icon, order: 200, segment: 'panel' }]
  }
  if (page) {
    contributes.pages = [{ id: page.id, title: page.title, dir: page.dir, entry: page.entry, order: 100 }]
  }
  if (bang) contributes.bangs = [bang]

  /*
   * `--menu` 生成的菜单项**必须有真实去处**（点了不能没反应）：
   * 页面 → bang → 面板 → 兜底 URL，按这个优先级挑选。where 同时挂三处，
   * 一次生成就能在主菜单 / 网页右键 / 标签右键看到它 —— 这正是本轮的扩展面演示。
   */
  if (args.menu) {
    let action: Record<string, string>
    let label: string
    if (page) {
      action = { type: 'page', page: page.id }
      label = `打开 ${page.title}`
    } else if (bang) {
      action = { type: 'bang', trigger: bang.trigger }
      label = `用 ${bang.title} 搜索`
    } else if (panel) {
      action = { type: 'panel', panel: panel.id }
      label = `打开 ${panel.title}`
    } else {
      action = { type: 'url', url: 'https://example.com' }
      label = `打开 ${manifest.name}`
    }
    contributes.menus = [{
      id: 'entry',
      where: ['app.tools', 'webview.context', 'tabbar.context'],
      label,
      order: 100,
      action
    }]
  }
  if (Object.keys(contributes).length) manifest.contributes = contributes

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(modulePath, MODULE_TEMPLATE({ id, caps: args.caps, hasRender: !!args.render }), 'utf8')
  if (args.render) fs.writeFileSync(rendererPath, RENDERER_TEMPLATE({ id, panel }), 'utf8')
  if (page) {
    const pageDir = path.join(dir, page.dir)
    fs.mkdirSync(pageDir, { recursive: true })
    fs.writeFileSync(path.join(pageDir, page.entry), PAGE_TEMPLATE({ pluginId: id, page }), 'utf8')
  }

  console.log(`已生成插件 ${id}：`)
  console.log(`  ${path.relative(ROOT, manifestPath)}`)
  console.log(`  ${path.relative(ROOT, modulePath)}`)
  if (args.render) console.log(`  ${path.relative(ROOT, rendererPath)}`)
  if (page) console.log(`  ${path.relative(ROOT, path.join(dir, page.dir, page.entry))}`)
  console.log('')
  console.log(`下一步：pnpm plugin:validate ${id}`)
  if (args.render) console.log('提示：面板由插件自带实现（entry.render），manifest 的 contributes.panels[].id 必须与 renderer 里的 panels[].id 一致。')
  if (page) console.log(`提示：内部页地址 hira://p-${id}-${page.id}/（重启应用后生效）。`)
  if (bang) console.log(`提示：地址栏输入 !${bang.trigger} 关键词 即可用这条 bang。`)
  if (args.menu) console.log('提示：菜单项已同时挂到主菜单「工具」、网页右键与标签右键；where / action 词汇表见 docs-ng/插件化落地现状与扩展指南.md。')
}

try {
  main()
  } catch (error) {
  console.error('脚手架失败：', errorMessage(error))
  process.exit(1)
}
