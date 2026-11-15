/**
 * xaml.mjs —— 极简 **XAML → HTML** 编译器（纯层、零依赖、零 IO）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 插件可以交一个 `.xaml` 当面板界面（见 `plugin-ui.mjs`）。XAML 是**声明式**的，
 * 与 `<div style="...">` 之间只差一层确定的翻译 —— 而这层翻译如果放在渲染层，
 * 校验器（安装前体检）就看不到它，于是"能不能渲染"要等用户点开面板才知道。
 * 放在纯层 = 安装器、校验器、渲染层 import 同一个函数，结论不可能不一致。
 *
 * ── 它输出什么 ──────────────────────────────────────────────────
 * 一段**语义化 HTML 片段**（不是完整文档）：
 *   · 常见布局面板（Grid / StackPanel / DockPanel / WrapPanel / Canvas / Border）；
 *   · 常见控件（TextBlock / Button / TextBox / CheckBox / ComboBox / ListView …）；
 *   · XAML 属性 → 内联 CSS（白名单映射，未知属性忽略，不认识的面板画成普通 div）；
 *   · `Click="OnFoo"` → `data-hira-click="OnFoo"`，由一小段固定运行时派发
 *     `hira-xaml` CustomEvent（**不做 eval**，插件自己监听即可）；
 *   · `Text="{Binding Foo}"` → `data-hira-bind="Foo"` + `window.__hiraXaml.bind(data)`。
 *
 * 最终文档由 `buildPanelUiDocument()` 组装（CSP / base / 桥脚本都在那边）——
 * 本文件**不产出 `<html>` / `<head>` / CSP**，也不产生任何网络请求。
 *
 * ── 安全不变量（改这个文件前先读）────────────────────────────────
 *   1. 拒绝 `<!DOCTYPE` / `<!ENTITY`：实体扩展是 XXE 的入口，而 XAML 不需要它；
 *   2. 深度 / 节点数 / 输出长度上限：一份几万层嵌套的文档能把编译器自己拖死；
 *   3. 属性值走 `safeCssValue()` 白名单：`;{}` `url(` `expression(` `javascript:` 一律丢弃
 *      —— 内联样式是我们给插件的自由度，也是唯一能把 `style` 变成脚本的地方；
 *   4. 未知标签降级为 `div`（保留内容），**绝不透传** `script` / `iframe` / `object` /
 *      `link` / `meta` / `base` / `style`：这些在 srcdoc 面板里没有正当用途，
 *      而 `script` 有专门的 `<Script>` 通道（见下）。
 *
 * ── `<Script>` 与内联脚本 ────────────────────────────────────────
 * XAML 本身没有脚本能力，但面板作者需要"点了按钮干点什么"。所以支持：
 *   ```xml
 *   <Script>window.addEventListener('hira-xaml', e => console.log(e.detail))</Script>
 * ```
 * 它被收集到末尾的 `<script>` 里。这不比直接交 `.html` 更危险 ——
 * 面板的 CSP 本来就允许内联脚本，沙箱也没有 `allow-same-origin`。
 */

import { escapeHtmlAttribute, escapeHtmlText } from './plugin-ui.js'
// 字体栈唯一真源（XAML 面板同样跑在插件 srcdoc 里，主题令牌可用）。
import { uiFontVar } from './font-stack.js'

/** 嵌套深度上限（防止恶意/事故性深嵌套把编译器递归栈打爆）。 */
export const XAML_MAX_DEPTH = 64
/** 节点数上限。 */
export const XAML_MAX_NODES = 4000
/** 编译产物长度上限（字符）。 */
export const XAML_MAX_OUTPUT_LENGTH = 4 * 1024 * 1024

export interface XamlNode {
  name: string
  attrs: Record<string, string>
  children: XamlNode[]
  value?: string
}

interface XamlRenderContext {
  scripts: string[]
  scriptSrcs: string[]
  bindings: number
  clicks: number
  title: string
}

interface XamlRenderOptions {
  collapse?: boolean
}

type XamlHandler = (node: XamlNode, context: XamlRenderContext, depth: number) => string

/** 直接丢弃的标签（不是"降级成 div"，是连内容一起不输出）。 */
const DROPPED_ELEMENTS = Object.freeze(new Set([
  // 注：`script` 刻意不在这一组 —— 它走 `<Script>` 专用通道（收集到末尾内联脚本），
  // 见 renderNode 里的单独分支。
  'style', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'param', 'webview', 'portal'
]))

/** 自闭合（无子节点）标签。 */
const VOID_TAGS = Object.freeze(new Set(['img', 'hr', 'input', 'br']))

/**
 * 控件默认皮肤 —— **静态串**，随编译产物一起下发。
 *
 * 为什么必须有：XAML 的价值是"只写声明就得到界面"，而浏览器给 `<button>` /
 * `<select>` 的是 UA 默认样式（浅灰、直角、与主题无关）。放在这里而不是让每个作者
 * 自己补：一份实现、所有 XAML 面板一致，且颜色走主题变量，深浅色自动跟随。
 *
 * 作者仍然可以覆盖：这段样式只命中 `.hira-xaml-*` 类，且内联 `style="…"`
 * （由 XAML 属性翻译而来）优先级天然更高。
 */
const XAML_BASE_STYLE = [
  '.hira-xaml-root{display:block;min-height:100%;',
  `color:var(--hira-text-primary,#e7e7ea);font:13px/1.5 ${uiFontVar()};`,
  '-webkit-font-smoothing:antialiased;}',
  '.hira-xaml-root *{box-sizing:border-box;}',
  '.hira-xaml-button{font:inherit;padding:6px 12px;border-radius:6px;cursor:pointer;',
  'color:inherit;border:1px solid var(--hira-border-subtle,#3a3a42);background:var(--hira-field-bg,rgba(127,127,127,.12));}',
  '.hira-xaml-button:hover:not(:disabled){background:var(--hira-hover-bg,rgba(127,127,127,.2));}',
  '.hira-xaml-button:active:not(:disabled){transform:translateY(1px);}',
  '.hira-xaml-button:disabled{cursor:default;}',
  '.hira-xaml-textbox,.hira-xaml-combo{font:inherit;color:inherit;padding:5px 8px;border-radius:6px;',
  'border:1px solid var(--hira-border-subtle,#3a3a42);background:var(--hira-field-bg,rgba(127,127,127,.12));}',
  '.hira-xaml-textbox:focus,.hira-xaml-combo:focus{outline:none;border-color:var(--hira-accent,#6aa1ff);}',
  '.hira-xaml-check-label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;}',
  '.hira-xaml-check,.hira-xaml-slider,.hira-xaml-progress{accent-color:var(--hira-accent,#6aa1ff);}',
  '.hira-xaml-slider{width:100%;}',
  '.hira-xaml-progress{width:100%;height:6px;}',
  '.hira-xaml-item:hover{background:var(--hira-hover-bg,rgba(127,127,127,.14));}',
  '.hira-xaml-expander>summary,.hira-xaml-tab>summary{cursor:pointer;padding:4px 0;}',
  '.hira-xaml-link{color:var(--hira-accent,#6aa1ff);text-decoration:none;}',
  '.hira-xaml-link:hover{text-decoration:underline;}',
  '.hira-xaml-image{max-width:100%;}'
].join('')

/** HTML 文本转义沿用 plugin-ui 的同一份实现（两处各写必然漂移）。 */
const esc = escapeHtmlText
const escAttr = escapeHtmlAttribute

/** 折叠纯排版用的空白（XAML 源码里的缩进不该出现在界面上）。 */
function collapseText(value: unknown): string {
  return String(value).replace(/[ \t\r\n]+/g, ' ')
}

/**
 * 编译一份 XAML。
 *
 * @param {string} source
 * @param {{ title?: string }} [options]
 * @returns {{ html: string, title: string }}
 */
export function compileXaml(source: string, options: { title?: string } = {}) : { html: string, title: string } {
  const tree = parseXaml(source)
  const ctx: XamlRenderContext = {
    scripts: [],
    scriptSrcs: [],
    bindings: 0,
    clicks: 0,
    title: String(options.title || '')
  }
  const body = renderChildren(tree, ctx, 0, { collapse: true })
  // 默认样式随产物一起下发 —— XAML 作者只写声明，不该还要自己给每个控件补皮肤。
  // 颜色全部走 `--hira-*` 主题变量，深浅色切换自动跟随。
  const parts = [`<style>${XAML_BASE_STYLE}</style>`, `<div class="hira-xaml-root" data-hira-xaml-root>`, body, `</div>`]
  // 运行时**先于**作者脚本：无论绑定/事件有没有声明，只要作者有脚本，就必须
  // 先拿到 `__hiraXaml`（否则"外链脚本里调 set()"会变成 undefined 的运气问题）。
  if (ctx.bindings > 0 || ctx.clicks > 0 || ctx.scriptSrcs.length || ctx.scripts.length) {
    parts.push(XAML_RUNTIME_SCRIPT)
  }
  if (ctx.scriptSrcs.length) {
    // 外链脚本（`<Script src>`）—— 大段逻辑放独立文件，享受协议层的 ETag 缓存。
    // 不用 `defer`：外链与内联脚本来自同一位作者，按书写顺序同步执行才符合直觉。
    parts.push(ctx.scriptSrcs.map((src) => `<script src="${escAttr(src)}"></script>`).join(''))
  }
  if (ctx.scripts.length) {
    parts.push(`<script>\n${ctx.scripts.map((s) => s.replace(/<\/script/gi, '<\\/script')).join('\n')}\n</script>`)
  }
  const html = parts.join('')
  if (html.length > XAML_MAX_OUTPUT_LENGTH) {
    throw new Error(`XAML 编译产物超过 ${XAML_MAX_OUTPUT_LENGTH} 字符上限`)
  }
  return { html, title: ctx.title }
}

/** 编译并返回 HTML 字符串（绝大多数调用方只需要这个）。 */
export function xamlToHtml(source: string, options: { title?: string } = {}): string {
  return compileXaml(source, options).html
}

// ─────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────

/**
 * XAML → 轻量节点树。
 *
 * 只做 XML 的一个**受控子集**：元素 / 属性 / 文本 / 注释 / CDATA / 处理指令。
 * 不支持 DTD、不支持自定义实体、不校验命名空间（`xmlns` 直接忽略）。
 *
 * @param {string} source
 * @returns {{ name: string, attrs: Record<string, string>, children: any[] }}
 */
export function parseXaml(source: string): XamlNode {
  const text = String(source == null ? '' : source).replace(/^\uFEFF/, '')
  if (/<!doctype/i.test(text)) throw new Error('XAML 不允许 <!DOCTYPE>')
  if (/<!entity/i.test(text)) throw new Error('XAML 不允许 <!ENTITY>')

  const root: XamlNode = { name: '#document', attrs: {}, children: [] }
  const stack: XamlNode[] = [root]
  let i = 0
  let nodes = 0

  const pushText = (raw: unknown) => {
    if (!raw) return
    const value = collapseText(decodeEntities(raw))
    if (!value.trim()) return
    stack[stack.length - 1].children.push({ name: '#text', attrs: {}, children: [], value })
  }

  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      pushText(text.slice(i))
      break
    }
    if (lt > i) pushText(text.slice(i, lt))

    // 注释
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) throw new Error('XAML 注释未闭合')
      i = end + 3
      continue
    }
    // CDATA：原样文本（不再解实体）
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end < 0) throw new Error('XAML CDATA 未闭合')
      const raw = text.slice(lt + 9, end)
      if (raw) stack[stack.length - 1].children.push({ name: '#text', attrs: {}, children: [], value: raw })
      i = end + 3
      continue
    }
    // 处理指令（`<?xml …?>`）—— 忽略
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end < 0) throw new Error('XAML 处理指令未闭合')
      i = end + 2
      continue
    }
    // 结束标签
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) throw new Error('XAML 结束标签未闭合')
      const name = text.slice(lt + 2, end).trim()
      while (stack.length > 1) {
        const top = stack.pop()
        if (!top || top.name === name) break
      }
      i = end + 1
      continue
    }

    // 开始标签
    const end = findTagEnd(text, lt + 1)
    if (end < 0) throw new Error('XAML 开始标签未闭合')
    let body = text.slice(lt + 1, end)
    const selfClose = /\/\s*$/.test(body)
    if (selfClose) body = body.replace(/\/\s*$/, '')
    const space = body.search(/[\s]/)
    const name = (space < 0 ? body : body.slice(0, space)).trim()
    if (!name) throw new Error('XAML 标签名为空')
    const attrs = space < 0 ? {} : parseAttributes(body.slice(space))
    nodes += 1
    if (nodes > XAML_MAX_NODES) throw new Error(`XAML 节点数超过 ${XAML_MAX_NODES} 上限`)
    if (stack.length > XAML_MAX_DEPTH) throw new Error(`XAML 嵌套深度超过 ${XAML_MAX_DEPTH} 上限`)
    const node = { name, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
    i = end + 1
  }

  return root
}

/** 从 `start` 起找标签的 `>`，跳过引号内的内容。 */
function findTagEnd(text: string, start: number): number {
  let quote = ''
  for (let j = start; j < text.length; j++) {
    const c = text[j]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '>') return j
  }
  return -1
}

/** 属性扫描正则 —— 提到模块级（每次 `parseAttributes` 新建一个 /g 正则会重编译）。 */
const ATTRIBUTE_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** `Grid.Row="1" Text='hi' Flag` → `{ 'Grid.Row': '1', Text: 'hi', Flag: '' }`。 */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTRIBUTE_RE.lastIndex = 0
  let m
  while ((m = ATTRIBUTE_RE.exec(source))) {
    const key = m[1]
    const value = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : ''
    attrs[key] = decodeEntities(value)
  }
  return attrs
}

/** XML 预定义实体表（模块级常量：之前每个实体匹配都新建一次对象）。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })

/** 解 XML 预定义实体 + 数字实体（其它原样保留，不做实体扩展）。 */
function decodeEntities(text: unknown): string {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw: string, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return raw
      try {
        return String.fromCodePoint(code)
      } catch (_) {
        return raw
      }
    }
    return NAMED_ENTITIES[body] != null ? NAMED_ENTITIES[body] : raw
  })
}

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

/**
 * @param {{ children: any[] }} node
 * @param {any} ctx
 * @param {number} depth
 * @param {{ collapse?: boolean }} [opts]
 */
function renderChildren(node: XamlNode, context: XamlRenderContext, depth: number, options: XamlRenderOptions = {}): string {
  if (depth > XAML_MAX_DEPTH) return ''
  const out: string[] = []
  for (const child of node.children || []) {
    out.push(renderNode(child, context, depth + 1, options))
  }
  return out.join('')
}

/**
 * @param {any} node
 * @param {any} ctx
 * @param {number} depth
 * @param {{ collapse?: boolean }} opts
 * @returns {string}
 */
function renderNode(node: XamlNode, context: XamlRenderContext, depth: number, options: XamlRenderOptions): string {
  if (!node) return ''
  if (node.name === '#text') return options.collapse ? esc(collapseText(node.value)) : esc(node.value)
  if (node.name === '#document') return renderChildren(node, context, depth, options)

  const rawName = String(node.name)
  // 属性元素（`Grid.RowDefinitions`）由父容器消费，漏到这里说明没人认领 —— 丢掉。
  if (rawName.includes('.')) return ''
  const local = localName(rawName)
  const lower = local.toLowerCase()

  if (DROPPED_ELEMENTS.has(lower)) return ''
  if (lower === 'script') {
    // `<Script src="panel.js" />` → 外链脚本（相对路径经 `<base>` 落回插件目录）。
    // 只接受插件目录内的相对路径：绝对路径 / `..` / 协议前缀一律当内联文本处理
    // （否则一个 `src="https://evil"` 就成了"声明式 XAML 里夹带远程代码"）。
    const src = String((node.attrs && node.attrs.src) || '').trim()
    const safeSrc = src &&
      !src.startsWith('/') && !src.startsWith('\\') && !src.includes('..') && !/^[a-z]+:/i.test(src)
    if (safeSrc) context.scriptSrcs.push(src.replace(/\\/g, '/'))
    else context.scripts.push(textContent(node))
    return ''
  }
  const handler = ELEMENT_BY_LOWER.get(lower)
  if (!handler) {
    // 开放兜底：不认识的控件画成容器，内容照常显示（插件可以先用 div 语义起步）
    return box(node, context, depth, {
      tag: 'div',
      className: 'hira-xaml-node hira-xaml-unknown',
      extraAttrs: ` data-hira-xaml-tag="${escAttr(rawName)}"`
    })
  }
  return handler(node, context, depth)
}

/** `controls:MyButton` → `MyButton`。 */
function localName(name: unknown): string {
  const idx = String(name).lastIndexOf(':')
  return idx >= 0 ? String(name).slice(idx + 1) : String(name)
}

/** 元素的纯文本内容（`<Script>` 用）。 */
function textContent(node: XamlNode): string {
  let out = ''
  for (const child of node.children || []) {
    if (child.name === '#text') out += child.value || ''
    else if (child.name !== '#document') out += textContent(child)
  }
  return out
}

function attr(node: XamlNode | null | undefined, name: string): string {
  const attrs = (node && node.attrs) || {}
  return attrs[name] != null ? String(attrs[name]) : ''
}

/** 布尔属性：`True` / `true` / 有值且不是 False 都算真；绑定表达式不算（交给运行时）。 */
function boolAttr(node: XamlNode, name: string): boolean {
  const raw = attr(node, name)
  if (!raw) return false
  const v = raw.trim()
  if (/^\{(?:Binding|binding|x:Bind|X:Bind)\s/.test(v)) return false
  const lower = v.toLowerCase()
  return lower !== 'false' && lower !== '0' && lower !== 'no'
}

/** 属性元素里的重复子项（`Grid.RowDefinitions > RowDefinition`）。 */
function propertyElement(node: XamlNode, name: string): XamlNode | null {
  for (const child of node.children || []) {
    if (child.name === name) return child
  }
  return null
}

/**
 * 通用元素包装：类名 + id + 内联样式 + 子内容。
 *
 * @param {any} node
 * @param {any} ctx
 * @param {number} depth
 * @param {{ tag?: string, className?: string, baseStyle?: string, extraAttrs?: string, inner?: string|null }} opts
 */
function box(
  node: XamlNode,
  context: XamlRenderContext,
  depth: number,
  opts: { tag?: string; className?: string; baseStyle?: string; extraAttrs?: string; inner?: string | null } = {}
): string {
  const tag = opts.tag || 'div'
  const style = [opts.baseStyle || '', commonStyle(node)].filter(Boolean).join('')
  const attrs = [`class="${escAttr(opts.className || 'hira-xaml-node')}"`]
  const id = safeId(attr(node, 'x:Name') || attr(node, 'Name'))
  if (id) attrs.push(`id="${escAttr(id)}"`)
  if (style) attrs.push(`style="${escAttr(style)}"`)
  if (opts.extraAttrs) attrs.push(opts.extraAttrs.trim())
  const inner = opts.inner != null ? opts.inner : renderChildren(node, context, depth, { collapse: true })
  if (VOID_TAGS.has(tag)) return `<${tag} ${attrs.join(' ')}>`
  return `<${tag} ${attrs.join(' ')}>${inner}</${tag}>`
}

// ── 属性 → 内联 CSS（白名单）────────────────────────────────────

/** 长度类属性：裸数字补 `px`，逗号分隔符转空格（XAML 的 Thickness 写法）。 */
const LENGTH_PROPS = Object.freeze({
  Width: 'width',
  Height: 'height',
  MinWidth: 'min-width',
  MaxWidth: 'max-width',
  MinHeight: 'min-height',
  MaxHeight: 'max-height',
  Margin: 'margin',
  Padding: 'padding',
  FontSize: 'font-size',
  LineHeight: 'line-height',
  LetterSpacing: 'letter-spacing',
  CornerRadius: 'border-radius',
  Opacity: 'opacity'
})

/** 颜色类属性。 */
const COLOR_PROPS = Object.freeze({
  Background: 'background',
  Foreground: 'color',
  BorderBrush: 'border-color'
})

/**
 * 上面两张表的**展开形态** —— `Object.entries()` 每次调用都会新建数组与二元组。
 * 编译一份 XAML 要把 `commonStyle` 跑过每个节点，放在模块级只算一次。
 */
const LENGTH_PROP_PAIRS = Object.freeze(Object.entries(LENGTH_PROPS))
const COLOR_PROP_PAIRS = Object.freeze(Object.entries(COLOR_PROPS))

const FONT_WEIGHTS: Readonly<Record<string, string>> = Object.freeze({
  thin: '100',
  extralight: '200',
  ultralight: '200',
  light: '300',
  normal: '400',
  regular: '400',
  medium: '500',
  semibold: '600',
  demibold: '600',
  bold: '700',
  extrabold: '800',
  black: '900'
})

const TEXT_ALIGN: Readonly<Record<string, string>> = Object.freeze({
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify'
})

/**
 * 通用属性 → CSS 片段。
 *
 * **只翻译白名单里的属性**：XAML 的属性名成百上千，逐个支持是不可能的；
 * 白名单保证"写错了不会静默变成奇怪样式"，也让这个文件长期可维护。
 *
 * @param {any} node
 * @returns {string}
 */
function commonStyle(node: XamlNode): string {
  const a = (node && node.attrs) || {}
  const parts: string[] = []
  const push = (prop: string, value: unknown) => {
    const v = safeCssValue(value)
    if (v) parts.push(`${prop}:${v};`)
  }

  for (const [key, prop] of LENGTH_PROP_PAIRS) {
    if (a[key] == null) continue
    push(prop, toLength(a[key]))
  }
  for (const [key, prop] of COLOR_PROP_PAIRS) {
    if (a[key] == null) continue
    push(prop, a[key])
  }
  // 有边框宽度/颜色就必须有 border-style，否则 CSS 不画线（XAML 里默认实线）。
  if (a.BorderThickness != null || a.BorderBrush != null) parts.push('border-style:solid;')
  if (a.BorderThickness == null && a.BorderBrush != null) push('border-width', '1px')

  if (a.FontWeight != null) {
    const v = String(a.FontWeight).trim().toLowerCase()
    push('font-weight', FONT_WEIGHTS[v] || (/^\d+$/.test(v) ? v : ''))
  }
  if (a.FontStyle != null) {
    const v = String(a.FontStyle).trim().toLowerCase()
    if (v === 'italic' || v === 'oblique' || v === 'normal') parts.push(`font-style:${v};`)
  }
  if (a.FontFamily != null) push('font-family', a.FontFamily)
  if (a.TextAlignment != null) {
    const v = TEXT_ALIGN[String(a.TextAlignment).trim().toLowerCase()]
    if (v) parts.push(`text-align:${v};`)
  }
  if (a.TextTrimming === 'CharacterEllipsis' || a.TextTrimming === 'WordEllipsis') {
    parts.push('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')
  }
  if (a.TextWrapping === 'Wrap' || a.TextWrapping === 'WrapWithOverflow') parts.push('white-space:normal;')
  if (a.TextWrapping === 'NoWrap') parts.push('white-space:nowrap;')

  if (a.Visibility != null) {
    const v = String(a.Visibility).trim().toLowerCase()
    if (v === 'collapsed') parts.push('display:none;')
    else if (v === 'hidden') parts.push('visibility:hidden;')
  }
  if (a.IsEnabled === 'False' || a.IsEnabled === 'false') parts.push('opacity:.55;pointer-events:none;')

  // 对齐：用 auto 外边距实现（在 flex / grid 容器里都成立），比猜 align-self 稳。
  const ha = String(a.HorizontalAlignment || '').trim().toLowerCase()
  if (ha === 'center') parts.push('margin-left:auto;margin-right:auto;')
  else if (ha === 'right' || ha === 'far') parts.push('margin-left:auto;')
  else if (ha === 'stretch') parts.push('width:100%;')
  const va = String(a.VerticalAlignment || '').trim().toLowerCase()
  if (va === 'center') parts.push('margin-top:auto;margin-bottom:auto;')
  else if (va === 'bottom' || va === 'far') parts.push('margin-top:auto;')
  else if (va === 'stretch') parts.push('height:100%;')

  // Grid / Canvas 定位（这两个前缀属性写在**子元素**上）
  const row = Number.parseInt(attr(node, 'Grid.Row'), 10)
  const col = Number.parseInt(attr(node, 'Grid.Column'), 10)
  const rowSpan = Number.parseInt(attr(node, 'Grid.RowSpan'), 10)
  const colSpan = Number.parseInt(attr(node, 'Grid.ColumnSpan'), 10)
  if (Number.isFinite(row)) {
    parts.push(rowSpan > 1 ? `grid-row:${row + 1} / span ${rowSpan};` : `grid-row:${row + 1};`)
  } else if (rowSpan > 1) {
    parts.push(`grid-row:span ${rowSpan};`)
  }
  if (Number.isFinite(col)) {
    parts.push(colSpan > 1 ? `grid-column:${col + 1} / span ${colSpan};` : `grid-column:${col + 1};`)
  } else if (colSpan > 1) {
    parts.push(`grid-column:span ${colSpan};`)
  }
  const left = attr(node, 'Canvas.Left')
  const top = attr(node, 'Canvas.Top')
  const offset = []
  if (left) offset.push(`left:${toLength(left)};`)
  if (top) offset.push(`top:${toLength(top)};`)
  if (offset.length) parts.push(`position:absolute;${offset.join('')}`)

  return parts.join('')
}

/**
 * 事件属性 → `data-hira-*`（运行时据此派发 `hira-xaml` CustomEvent）。
 *
 * 只认两个最常用的事件名：`Click`/`Tapped`（点）与 `Change`/`TextChanged`（改值）。
 * 不做 eval —— 属性值来自不可信文档，任何"把字符串当代码跑"的捷径都是后门。
 */
function eventAttrs(node: XamlNode, context: XamlRenderContext): string {
  const out: string[] = []
  const click = attr(node, 'Click') || attr(node, 'Tapped')
  if (click) {
    context.clicks += 1
    out.push(`data-hira-click="${escAttr(click)}"`)
  }
  const change = attr(node, 'Change') || attr(node, 'TextChanged') || attr(node, 'SelectionChanged')
  if (change) {
    context.clicks += 1
    out.push(`data-hira-change="${escAttr(change)}"`)
  }
  return out.length ? ` ${out.join(' ')}` : ''
}

/** `{Binding X}` / `{Binding Path=X}` / `{x:Bind X}` —— 模块级：每次编译会调用上千次。 */
const BINDING_RE = /^\{(?:Binding|binding|x:Bind|X:Bind)\s+(?:Path\s*=\s*)?([^}]+)\}$/

/** `Text="{Binding Foo}"` → `data-hira-bind="Foo"`；普通文本原样返回。 */
function textBinding(value: unknown, context: XamlRenderContext): { text: string; attr: string } {
  const raw = String(value == null ? '' : value)
  const m = BINDING_RE.exec(raw.trim())
  if (!m) return { text: raw, attr: '' }
  context.bindings += 1
  // `Path=` 与嵌套路径（`User.name`）都原样写进属性，运行时按点号取值。
  return { text: '', attr: ` data-hira-bind="${escAttr(m[1].trim())}"` }
}

/** 裸数字补 px；`1,2,3,4` → `1px 2px 3px 4px`。 */
function toLength(value: unknown): string {
  return String(value == null ? '' : value)
    .split(',')
    .map((part) => {
      const s = part.trim()
      if (!s) return '0'
      if (/^-?\d*\.?\d+$/.test(s)) return `${s}px`
      return s
    })
    .join(' ')
}

/**
 * 单个 CSS 值的白名单净化。
 *
 * 允许：颜色/尺寸/字体名/`var(--x)` 这类正常值。
 * 拒绝：任何能把声明块提前闭合或引入外部资源的写法。
 *
 * @param {any} value
 * @returns {string} 合法值；非法返回空串（调用方据此跳过该声明）
 */
export function safeCssValue(value: unknown) : string {
  const v = String(value == null ? '' : value).trim()
  if (!v || v.length > 512) return ''
  if (/[;{}<>\\\u0000-\u001f]/.test(v)) return ''
  const lower = v.toLowerCase()
  if (lower.includes('url(') || lower.includes('expression(') || lower.includes('javascript:')) return ''
  if (lower.includes('@import') || lower.includes('behavior:')) return ''
  return v
}

/** `x:Name` → 合法 id（只留字母数字与 `-_:.`）。 */
function safeId(value: unknown): string {
  const v = String(value == null ? '' : value).trim()
  if (!v) return ''
  return v.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 128)
}

/** `Image.Source` / `Hyperlink.NavigateUri` 的地址白名单。 */
function safeUrl(value: unknown): string {
  const v = String(value == null ? '' : value).trim()
  if (!v) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    return /^(https?|data|hira-plugin|mailto|blob):/i.test(v) ? v : ''
  }
  return v // 相对路径 → 由 <base href="hira-plugin://<id>/"> 解析
}

// ─────────────────────────────────────────────────────────────
// 元素表 —— 一个标签一条，新增控件只在这里加
// ─────────────────────────────────────────────────────────────

const ELEMENTS: Readonly<Record<string, XamlHandler>> = {
  // ── 布局 ────────────────────────────────────────────────────
  Grid(node, ctx, depth) {
    const rows = gridDefinitions(node, 'Grid.RowDefinitions', 'RowDefinition', 'Height')
    const cols = gridDefinitions(node, 'Grid.ColumnDefinitions', 'ColumnDefinition', 'Width')
    const style = [
      'display:grid;',
      rows.length ? `grid-template-rows:${rows.join(' ')};` : '',
      cols.length ? `grid-template-columns:${cols.join(' ')};` : 'grid-auto-flow:row;',
      attr(node, 'RowSpacing') ? `row-gap:${toLength(attr(node, 'RowSpacing'))};` : '',
      attr(node, 'ColumnSpacing') ? `column-gap:${toLength(attr(node, 'ColumnSpacing'))};` : ''
    ].join('')
    return box(node, ctx, depth, { className: 'hira-xaml-grid', baseStyle: style })
  },
  StackPanel(node, ctx, depth) {
    const horizontal = String(attr(node, 'Orientation')).toLowerCase() === 'horizontal'
    const gap = attr(node, 'Spacing')
    const style = [
      'display:flex;',
      `flex-direction:${horizontal ? 'row' : 'column'};`,
      gap ? `gap:${toLength(gap)};` : '',
      horizontal ? 'align-items:center;' : ''
    ].join('')
    return box(node, ctx, depth, { className: 'hira-xaml-stack', baseStyle: style })
  },
  DockPanel(node, ctx, depth) {
    const style = `display:flex;flex-direction:${String(attr(node, 'Orientation')).toLowerCase() === 'horizontal' ? 'row' : 'column'};`
    return box(node, ctx, depth, { className: 'hira-xaml-dock', baseStyle: style })
  },
  WrapPanel(node, ctx, depth) {
    const gap = attr(node, 'ItemWidth') ? `gap:${toLength(attr(node, 'ItemWidth'))};` : ''
    return box(node, ctx, depth, { className: 'hira-xaml-wrap', baseStyle: `display:flex;flex-wrap:wrap;${gap}` })
  },
  Canvas(node, ctx, depth) {
    return box(node, ctx, depth, { className: 'hira-xaml-canvas', baseStyle: 'position:relative;display:block;' })
  },
  Border(node, ctx, depth) {
    const brush = attr(node, 'BorderBrush')
    const thickness = attr(node, 'BorderThickness')
    const style = [
      brush || thickness ? 'border-style:solid;' : '',
      thickness ? `border-width:${toLength(thickness)};` : '',
      brush ? `border-color:${safeCssValue(brush)};` : '',
      attr(node, 'CornerRadius') ? `border-radius:${toLength(attr(node, 'CornerRadius'))};` : '',
      attr(node, 'Background') ? `background:${safeCssValue(attr(node, 'Background'))};` : '',
      attr(node, 'Padding') ? `padding:${toLength(attr(node, 'Padding'))};` : ''
    ].join('')
    return box(node, ctx, depth, { className: 'hira-xaml-border', baseStyle: style, extraAttrs: eventAttrs(node, ctx) })
  },
  ScrollViewer(node, ctx, depth) {
    const vertical = String(attr(node, 'VerticalScrollBarVisibility')).toLowerCase()
    const horizontal = String(attr(node, 'HorizontalScrollBarVisibility')).toLowerCase()
    const style = [
      'overflow-y:' + (vertical === 'disabled' ? 'hidden' : 'auto') + ';',
      'overflow-x:' + (horizontal === 'disabled' ? 'hidden' : 'auto') + ';',
      'min-height:0;'
    ].join('')
    return box(node, ctx, depth, { className: 'hira-xaml-scroll', baseStyle: style })
  },
  Viewbox(node, ctx, depth) {
    return box(node, ctx, depth, { className: 'hira-xaml-viewbox', baseStyle: 'display:flex;align-items:center;justify-content:center;' })
  },
  ContentControl(node, ctx, depth) {
    return box(node, ctx, depth, { className: 'hira-xaml-content' })
  },
  UserControl(node, ctx, depth) {
    return box(node, ctx, depth, { className: 'hira-xaml-content' })
  },
  Page(node, ctx, depth) {
    if (!ctx.title) ctx.title = attr(node, 'Title')
    return box(node, ctx, depth, { className: 'hira-xaml-content' })
  },
  Window(node, ctx, depth) {
    if (!ctx.title) ctx.title = attr(node, 'Title')
    return box(node, ctx, depth, { className: 'hira-xaml-content' })
  },

  // ── 文本 ────────────────────────────────────────────────────
  TextBlock(node, ctx, depth) {
    const bound = textBinding(attr(node, 'Text'), ctx)
    const inner = bound.text
      ? esc(bound.text)
      : renderChildren(node, ctx, depth, { collapse: true })
    return box(node, ctx, depth, {
      tag: 'div',
      className: 'hira-xaml-text',
      baseStyle: 'white-space:pre-wrap;',
      extraAttrs: bound.attr + eventAttrs(node, ctx),
      inner
    })
  },
  Run(node, ctx) {
    const bound = textBinding(attr(node, 'Text'), ctx)
    const style = commonStyle(node)
    const parts = ['<span class="hira-xaml-run"']
    if (style) parts.push(` style="${escAttr(style)}"`)
    if (bound.attr) parts.push(bound.attr)
    parts.push('>', bound.text ? esc(bound.text) : esc(textContent(node)), '</span>')
    return parts.join('')
  },
  Span(node, ctx, depth) {
    return ELEMENTS.Run(node, ctx, depth)
  },
  Hyperlink(node, ctx, depth) {
    const url = safeUrl(attr(node, 'NavigateUri') || attr(node, 'Uri'))
    const inner = renderChildren(node, ctx, depth, { collapse: true }) || esc(textContent(node))
    const attrs = [`class="hira-xaml-link"`]
    if (url) attrs.push(`href="${escAttr(url)}"`)
    if (!url) attrs.push('role="link"')
    const style = commonStyle(node)
    if (style) attrs.push(`style="${escAttr(style)}"`)
    const click = eventAttrs(node, ctx)
    if (click) attrs.push(click.trim())
    return `<a ${attrs.join(' ')}>${inner}</a>`
  },
  Separator(node, ctx, depth) {
    // 作者样式**叠加**在默认线之上（用 `||` 会让「只想改个 margin」的分隔线直接消失）。
    const style = `border:0;border-top:1px solid var(--hira-border-subtle,#3a3a42);margin:6px 0;${commonStyle(node)}`
    return `<hr class="hira-xaml-separator" style="${escAttr(style)}">`
  },

  // ── 输入 ────────────────────────────────────────────────────
  Button(node, ctx, depth) {
    const bound = textBinding(attr(node, 'Content') || attr(node, 'Text'), ctx)
    const inner = bound.text
      ? esc(bound.text)
      : renderChildren(node, ctx, depth, { collapse: true })
    const attrs = ['class="hira-xaml-button"', 'type="button"']
    const style = commonStyle(node)
    if (style) attrs.push(`style="${escAttr(style)}"`)
    if (boolAttr(node, 'IsDefault')) attrs.push('data-hira-default="1"')
    if (attr(node, 'IsEnabled') && !boolAttr(node, 'IsEnabled')) attrs.push('disabled')
    attrs.push(bound.attr.trim())
    attrs.push(eventAttrs(node, ctx).trim())
    return `<button ${attrs.filter(Boolean).join(' ')}>${inner}</button>`
  },
  TextBox(node, ctx, depth) {
    const bound = textBinding(attr(node, 'Text'), ctx)
    const attrs = ['class="hira-xaml-textbox"']
    if (boolAttr(node, 'AcceptsReturn')) {
      attrs.push(bound.attr.trim(), maybeAttr('placeholder', attr(node, 'PlaceholderText')))
      attrs.push(boolAttr(node, 'IsReadOnly') ? 'readonly' : '')
      attrs.push(styleAttr(node))
      attrs.push(eventAttrs(node, ctx).trim())
      return `<textarea ${attrs.filter(Boolean).join(' ')}>${esc(bound.text)}</textarea>`
    }
    attrs.push('type="text"')
    const value = bound.text ? ` value="${escAttr(bound.text)}"` : ''
    attrs.push(value.trim())
    attrs.push(maybeAttr('placeholder', attr(node, 'PlaceholderText')))
    attrs.push(bound.attr.trim())
    if (boolAttr(node, 'IsReadOnly')) attrs.push('readonly')
    attrs.push(styleAttr(node))
    attrs.push(eventAttrs(node, ctx).trim())
    return `<input ${attrs.filter(Boolean).join(' ')}>`
  },
  PasswordBox(node, ctx) {
    const attrs = ['class="hira-xaml-textbox"', 'type="password"']
    attrs.push(maybeAttr('placeholder', attr(node, 'PlaceholderText')))
    if (boolAttr(node, 'IsReadOnly')) attrs.push('readonly')
    attrs.push(styleAttr(node))
    attrs.push(eventAttrs(node, ctx).trim())
    return `<input ${attrs.filter(Boolean).join(' ')}>`
  },
  CheckBox(node, ctx, depth) {
    const label = attr(node, 'Content') || attr(node, 'Text')
    const inner = label ? esc(label) : renderChildren(node, ctx, depth, { collapse: true })
    const attrs = ['class="hira-xaml-check"', 'type="checkbox"']
    // `IsChecked="{Binding Done}"` → 运行时按绑定值写 `.checked`（静态 `IsChecked="True"` 走另一边）。
    if (boolAttr(node, 'IsChecked')) attrs.push('checked')
    else attrs.push(valueBinding(attr(node, 'IsChecked'), ctx))
    if (attr(node, 'IsEnabled') && !boolAttr(node, 'IsEnabled')) attrs.push('disabled')
    attrs.push(styleAttr(node))
    attrs.push(eventAttrs(node, ctx).trim())
    return `<label class="hira-xaml-check-label"><input ${attrs.filter(Boolean).join(' ')}><span>${inner}</span></label>`
  },
  RadioButton(node, ctx, depth) {
    const label = attr(node, 'Content') || attr(node, 'Text')
    const inner = label ? esc(label) : renderChildren(node, ctx, depth, { collapse: true })
    const attrs = ['class="hira-xaml-check"', 'type="radio"']
    const group = attr(node, 'GroupName')
    if (group) attrs.push(`name="${escAttr(safeId(group))}"`)
    if (boolAttr(node, 'IsChecked')) attrs.push('checked')
    attrs.push(styleAttr(node))
    attrs.push(eventAttrs(node, ctx).trim())
    return `<label class="hira-xaml-check-label"><input ${attrs.filter(Boolean).join(' ')}><span>${inner}</span></label>`
  },
  ComboBox(node, ctx) {
    const options = []
    let index = 0
    for (const child of node.children || []) {
      if (child.name === '#text') continue
      const local = localName(child.name).toLowerCase()
      if (local !== 'comboboxitem') continue
      const label = attr(child, 'Content') || attr(child, 'Text') || textContent(child)
      const selected = boolAttr(child, 'IsSelected') || index === Number.parseInt(attr(node, 'SelectedIndex'), 10)
      options.push(`<option${selected ? ' selected' : ''}>${esc(label)}</option>`)
      index += 1
    }
    // 没有子项时允许用 ItemsSource 之外的 Items 简写（`Items="a|b|c"`）
    if (!options.length && attr(node, 'Items')) {
      for (const item of attr(node, 'Items').split('|')) options.push(`<option>${esc(item.trim())}</option>`)
    }
    const attrs = ['class="hira-xaml-combo"']
    attrs.push(styleAttr(node))
    attrs.push(eventAttrs(node, ctx).trim())
    return `<select ${attrs.filter(Boolean).join(' ')}>${options.join('')}</select>`
  },
  Slider(node, ctx) {
    const attrs = ['class="hira-xaml-slider"', 'type="range"']
    attrs.push(maybeAttr('min', attr(node, 'Minimum')))
    attrs.push(maybeAttr('max', attr(node, 'Maximum')))
    const value = textBinding(attr(node, 'Value'), ctx)
    attrs.push(value.attr.trim() || maybeAttr('value', value.text))
    attrs.push(styleAttr(node))
    attrs.push(eventAttrs(node, ctx).trim())
    return `<input ${attrs.filter(Boolean).join(' ')}>`
  },
  ProgressBar(node, ctx) {
    const attrs = ['class="hira-xaml-progress"']
    const value = textBinding(attr(node, 'Value'), ctx)
    attrs.push(value.attr.trim() || maybeAttr('value', value.text))
    attrs.push(maybeAttr('max', attr(node, 'Maximum')))
    attrs.push(styleAttr(node))
    return `<progress ${attrs.filter(Boolean).join(' ')}></progress>`
  },
  ToggleSwitch(node, ctx, depth) {
    const label = attr(node, 'Header') || attr(node, 'Content')
    const inner = label ? esc(label) : renderChildren(node, ctx, depth, { collapse: true })
    const attrs = ['class="hira-xaml-check"', 'type="checkbox"', 'role="switch"']
    if (boolAttr(node, 'IsOn')) attrs.push('checked')
    else attrs.push(valueBinding(attr(node, 'IsOn'), ctx))
    attrs.push(eventAttrs(node, ctx).trim())
    return `<label class="hira-xaml-check-label"><input ${attrs.filter(Boolean).join(' ')}><span>${inner}</span></label>`
  },

  // ── 列表 / 容器型控件 ───────────────────────────────────────
  ListView(node, ctx, depth) {
    return listBox(node, ctx, depth, 'ListViewItem')
  },
  ListBox(node, ctx, depth) {
    return listBox(node, ctx, depth, 'ListBoxItem')
  },
  ListViewItem(node, ctx, depth) {
    const text = attr(node, 'Content') || attr(node, 'Text')
    const inner = text ? esc(text) : renderChildren(node, ctx, depth, { collapse: true })
    return box(node, ctx, depth, {
      className: 'hira-xaml-item',
      baseStyle: 'padding:6px 8px;border-radius:6px;cursor:pointer;',
      extraAttrs: eventAttrs(node, ctx),
      inner
    })
  },
  ListBoxItem(node, ctx, depth) {
    return ELEMENTS.ListViewItem(node, ctx, depth)
  },
  Expander(node, ctx, depth) {
    const header = esc(attr(node, 'Header') || '')
    const open = boolAttr(node, 'IsExpanded') ? ' open' : ''
    return `<details class="hira-xaml-expander"${open}><summary>${header}</summary>${renderChildren(node, ctx, depth, { collapse: true })}</details>`
  },
  TabControl(node, ctx, depth) {
    const items = []
    for (const child of node.children || []) {
      if (localName(child.name).toLowerCase() !== 'tabitem') continue
      const header = esc(attr(child, 'Header') || '')
      const open = boolAttr(child, 'IsSelected') ? ' open' : ''
      items.push(`<details class="hira-xaml-tab"${open}><summary>${header}</summary>${renderChildren(child, ctx, depth + 1, { collapse: true })}</details>`)
    }
    return `<div class="hira-xaml-tabs">${items.join('')}</div>`
  },
  TabItem(node, ctx, depth) {
    return box(node, ctx, depth, { className: 'hira-xaml-content' })
  },

  // ── 媒体 ────────────────────────────────────────────────────
  Image(node, ctx) {
    const src = safeUrl(attr(node, 'Source') || attr(node, 'Src'))
    const attrs = ['class="hira-xaml-image"', 'alt=""']
    if (src) attrs.push(`src="${escAttr(src)}"`)
    const style = commonStyle(node) || 'max-width:100%;'
    attrs.push(`style="${escAttr(style)}"`)
    attrs.push(eventAttrs(node, ctx).trim())
    return `<img ${attrs.filter(Boolean).join(' ')}>`
  }
}

/**
 * 元素名 → 处理器，**大小写不敏感**的唯一索引。
 *
 * 为什么需要它：`ELEMENTS` 的键是 XAML 惯例的 PascalCase，而作者完全可能写
 * `<textblock>` / `<STACKPANEL>`；`renderNode` 得到的又是小写名。曾经直接
 * `ELEMENTS[lower]` 去查，于是**每一个** PascalCase 标签都查不到 —— 整份 XAML
 * 静默降级成 `hira-xaml-unknown`：界面能显示、内容也在，但**一条皮肤都没有**，
 * 绑定（`data-hira-bind`）与事件（`data-hira-click`）也全不生成，看起来像
 * "面板加载到一半卡住"。索引一次比每次调用都做两轮查找更快，也不会再漏。
 */
const ELEMENT_BY_LOWER = new Map(
  Object.entries(ELEMENTS).map(([name, handler]) => [name.toLowerCase(), handler])
)

/** 列表类控件（ListView / ListBox）共用一条实现 —— 两处各写必然分叉。 */
function listBox(node: XamlNode, context: XamlRenderContext, depth: number, itemName: string): string {
  const items: string[] = []
  const wanted = String(itemName).toLowerCase()
  const itemHandler = ELEMENT_BY_LOWER.get(wanted)
  for (const child of node.children || []) {
    if (child.name === '#text') continue
    if (localName(child.name).toLowerCase() !== wanted) continue
    items.push(itemHandler ? itemHandler(child, context, depth + 1) : '')
  }
  return box(node, context, depth, {
    className: 'hira-xaml-list',
    baseStyle: 'display:flex;flex-direction:column;gap:2px;overflow:auto;',
    inner: items.join('')
  })
}

/** `RowDefinitions="Auto,*"` 或 `<Grid.RowDefinitions><RowDefinition Height="*"/>` 两种写法。 */
function gridDefinitions(node: XamlNode, propertyName: string, itemName: string, sizeAttr: string): string[] {
  const direct = attr(node, sizeAttr === 'Height' ? 'RowDefinitions' : 'ColumnDefinitions')
  const fromAttr = direct ? parseGridDefinitions(direct) : []
  if (fromAttr.length) return fromAttr
  const property = propertyElement(node, propertyName)
  if (!property) return []
  const out: string[] = []
  for (const child of property.children || []) {
    if (localName(child.name).toLowerCase() !== itemName.toLowerCase()) continue
    const size = attr(child, sizeAttr) || '*'
    out.push(...parseGridDefinitions(size))
  }
  return out
}

/** `Auto,*,2*,120` → `auto 1fr 2fr 120px`。 */
function parseGridDefinitions(value: unknown): string[] {
  return String(value == null ? '' : value)
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => {
      if (part === 'auto') return 'auto'
      const star = /^([\d.]+)?\*$/.exec(part)
      if (star) return star[1] ? `${star[1]}fr` : '1fr'
      const px = /^([\d.]+)(px)?$/.exec(part)
      if (px) return `${px[1]}px`
      return 'auto'
    })
}

/** `style="…"` 或空串（统一在这里，避免每个元素各拼一遍）。 */
function styleAttr(node: XamlNode): string {
  const style = commonStyle(node)
  return style ? `style="${escAttr(style)}"` : ''
}

/** `name="value"` 或空串。 */
function maybeAttr(name: string, value: unknown): string {
  const v = String(value == null ? '' : value).trim()
  return v ? `${name}="${escAttr(v)}"` : ''
}

/**
 * 值型绑定：`Value="{Binding X}"` / `IsChecked="{Binding Done}"`。
 * 解析规则与文本绑定完全一样（同一份正则、同一个计数器），只是这里只需要属性本身。
 */
function valueBinding(value: unknown, context: XamlRenderContext): string {
  return textBinding(value, context).attr.trim()
}

/**
 * XAML 事件/绑定运行时 —— **固定字符串**，只在产物确实用到时才追加。
 *
 * 为什么不做 eval：`Click="Foo()"` 这种写法看起来方便，但它等于把
 * "属性值"变成"代码"，而属性值来自不可信文档。改成派发事件后，插件仍然
 * 能拿到"谁被点了"，只是必须自己写监听（能力不减，攻击面收敛）。
 *
 * 绑定语义（与 WPF 的常用子集对齐，实现刻意小）：
 *   · 支持嵌套路径（`{Binding User.name}`）与 `{Binding Path=…}`；
 *   · 目标节点按**控件类型**写值：输入框写 `value`、勾选写 `checked`、进度写 `value`、
 *     其余写 `textContent` —— 只写 `textContent` 会让 TextBox 的绑定**永远显示空白**；
 *   · 正在编辑的那个输入框不会被 `bind()` 打断（否则玩家打字到一半会被旧值覆盖）；
 *   · `__hiraXaml.set(key, value)` 局部更新：面板不必为改一个字重新 `bind(整份状态)`。
 */
const XAML_RUNTIME_SCRIPT = `<script>
(function(){
  'use strict';
  var root = document.querySelector('[data-hira-xaml-root]') || document.body;
  var state = {};
  function fire(name, el, type, extra) {
    if (!name) return;
    var detail = { handler: name, element: el, event: type };
    if (extra) for (var k in extra) detail[k] = extra[k];
    try { root.dispatchEvent(new CustomEvent('hira-xaml', { detail: detail, bubbles: true })); } catch (_) {}
  }
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-hira-click]') : null;
    if (el) fire(el.getAttribute('data-hira-click'), el, 'click');
  }, true);
  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (!el) return;
    fire(el.getAttribute('data-hira-change'), el, 'change', { value: el.value, checked: !!el.checked });
  }, true);
  function resolve(data, path) {
    var segs = String(path).split('.');
    var cur = data;
    for (var i = 0; i < segs.length; i++) {
      if (cur == null) return undefined;
      cur = cur[segs[i]];
    }
    return cur;
  }
  function applyValue(el, value) {
    var tag = el.tagName;
    if (tag === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') { el.checked = !!value; return; }
      el.value = value == null ? '' : String(value);
      return;
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') { el.value = value == null ? '' : String(value); return; }
    if (tag === 'PROGRESS' || tag === 'METER') { el.value = Number(value) || 0; return; }
    el.textContent = value == null ? '' : String(value);
  }
  function render() {
    var nodes = document.querySelectorAll('[data-hira-bind]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-hira-bind');
      if (!key) continue;
      // 用户正在这个输入框里打字：不覆盖（否则每帧回到旧值）。
      if (el === document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
      applyValue(el, resolve(state, key));
    }
  }
  function write(path, value) {
    var segs = String(path).split('.');
    var cur = state;
    for (var i = 0; i < segs.length - 1; i++) {
      if (cur[segs[i]] == null || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  }
  window.__hiraXaml = {
    bind: function (data) {
      if (!data || typeof data !== 'object') return;
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) state[k] = data[k];
      render();
    },
    set: function (key, value) { write(key, value); render(); },
    get: function (key) { return resolve(state, key); },
    state: state
  };
})();
</script>`
