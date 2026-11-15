/**
 * Markdown → HTML（纯函数、零依赖、面板共用）。
 *
 * ── 为什么自己写 ────────────────────────────────────────────────────
 *   · 面板是**插件自带 UI**，它应该能独立打出去，不该在运行时 import 主包的 node_modules；
 *   · 我们需要的能力很小（标题 / 列表 / 围栏代码 / 引用 / 强调 / 链接 / 分隔线），
 *     引一个几十 KB 的解析器只为这几条，代价与"永远收不到安全更新"都不划算；
 *   · 输出**全部转义后再拼** —— 正文是用户自己（或模型）给的文本，Markdown 允许内联
 *     HTML，直接透传等于开了一个 XSS 口子（面板跑在特权渲染进程里）。
 *
 * ── 为什么放在 ui-common ────────────────────────────────────────────
 * 集锦面板与 AI 面板要**同一套**解析规则。两份实现必然漂移：一边修了围栏代码的
 * 语言标记，另一边还是老样子；更糟的是"某一边忘了转义"这种安全口径分叉。
 * 因此解析器只此一份，域特有的语法（如集锦的 `hira-note://` 内联引用）通过
 * `splitRefs` + `renderRef` 两个回调注入 —— 本文件不认识任何业务 URI。
 */

export interface MarkdownTextSegment {
  text: string
  refId?: never
}

export interface MarkdownRefSegment {
  refId: string
  text?: never
}

export type MarkdownSegment = MarkdownTextSegment | MarkdownRefSegment

export interface MarkdownOptions {
  splitRefs?: (text: string) => MarkdownSegment[]
  renderRef?: (refId: string) => string
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

/** 链接允许的协议（其余一律降级成纯文本，不生成可点击的 <a>）。 */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'hira:', 'hira-note:', 'hira-game:'])
/** 图片只允许网络图片与内联位图：`data:image/svg+xml` 能带脚本，不收。 */
const SAFE_IMAGE_SCHEMES = new Set(['http:', 'https:'])
const IMAGE_DATA_RE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i

/**
 * 清洗一个出现在 HTML 属性里的 URL。
 *
 * 只靠 `escapeHtml` 不够：`[点我](javascript:alert(1))` 里的引号会被转义，
 * 但 `javascript:` 协议本身仍然会留在 `href` 里 —— 面板跑在特权渲染进程，
 * 点一下就是在应用上下文里执行模型/网页给的代码。所以按用途白名单协议：
 *   · `link`  —— http/https/mailto + 站内协议；
 *   · `image` —— http/https + base64 位图（SVG 可执行脚本，拒绝）。
 * 相对地址（不含协议）照常放行 —— 面板里本来就允许 `#anchor` 与相对路径。
 *
 * @param {unknown} raw
 * @param {'link'|'image'} [kind]
 * @returns {string} 不安全时返回空串
 */
export function safeUrl(raw: unknown, kind: 'link' | 'image' = 'link'): string {
  const value = String(raw == null ? '' : raw).trim()
  if (!value) return ''
  // 浏览器解析 URL 时会忽略空白与控制字符（`java\tscript:` 等价于 `javascript:`）。
  const squeezed = value.replace(/[\u0000-\u0020\u007f]+/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(squeezed)
  if (!scheme) return value
  const protocol = `${scheme[1].toLowerCase()}:`
  if (kind === 'image') {
    if (protocol === 'data:') return IMAGE_DATA_RE.test(squeezed) ? value : ''
    return SAFE_IMAGE_SCHEMES.has(protocol) ? value : ''
  }
  return SAFE_LINK_SCHEMES.has(protocol) ? value : ''
}

/**
 * HTML 转义。调用方拼自定义片段（chip / 图片）时也必须用它，
 * 否则「我自己拼的 HTML 就安全」会成为这个模块唯一的漏口。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c] || c)
}

/**
 * 行内语法：代码 / 图片 / 链接 / 加粗 / 斜体 / 删除线 / 领域引用。
 * 先转义再替换，因此不可能把用户文本变成可执行标记。
 *
 * @param {string} text
 * @param {{
 *   splitRefs?: (text: string) => Array<{ text: string } | { refId: string }>,
 *   renderRef?: (refId: string) => string,
 * }} options
 * @returns {string}
 */
function renderInline(text: string, options?: MarkdownOptions): string {
  const splitRefs = options && typeof options.splitRefs === 'function' ? options.splitRefs : null
  const renderRef = options && typeof options.renderRef === 'function' ? options.renderRef : null

  const chips: string[] = []
  // 领域引用先切成片段：文本段照常转义，引用段收成 chip 占位符。
  // 用占位符而不是直接拼 HTML —— 否则 chip 标题里的 * _ ~ 会被下面的强调规则二次处理。
  let out = splitRefs && renderRef
    ? splitRefs(text).map((seg) => {
      if (seg.text != null) return escapeHtml(seg.text)
      chips.push(renderRef(seg.refId))
      return `\u0001${chips.length - 1}\u0001`
    }).join('')
    : escapeHtml(text)

  const codes: string[] = []
  // 行内代码先抽出占位，避免其中 * _ 被当成强调语法
  out = out.replace(/`([^`]+)`/g, (_m: string, code: string) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  // 协议白名单在转义之后、拼属性之前做：不安全的链接降级成纯文本，
  // 不安全的图片降级成 alt 文字 —— 绝不让 `javascript:` / SVG dataURL 进 DOM。
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m: string, alt: string, src: string) => {
    const safe = safeUrl(src, 'image')
    return safe ? `<img src="${safe}" alt="${alt}" loading="lazy">` : alt
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m: string, label: string, href: string) => {
    const safe = safeUrl(href, 'link')
    return safe ? `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>` : label
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  out = out.replace(/\u0000(\d+)\u0000/g, (_m: string, i: string) => `<code>${codes[Number(i)]}</code>`)
  out = out.replace(/\u0001(\d+)\u0001/g, (_m: string, i: string) => chips[Number(i)])
  return out
}

/** 块级语法判定（段落合并时用：遇到这些行必须断开上一段）。 */
const BLOCK_START = /^\s*(#{1,6}\s|>\s?|```|\|.*\||[-*+]\s+\S|\d+[.)]\s+\S|([-*_])(\s*\2){2,}\s*$)/

/** 表格行拆分：支持 `\|` 转义，并忽略首尾装饰竖线。 */
function tableCells(line: string): string[] {
  const source = String(line || '').trim()
  if (!source.includes('|')) return []
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\\' && source[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  if (source.startsWith('|')) cells.shift()
  if (source.endsWith('|') && !source.endsWith('\\|')) cells.pop()
  return cells
}

function tableAlignments(line: string): Array<'left' | 'center' | 'right' | ''> | null {
  const cells = tableCells(line)
  if (!cells.length || !cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))) return null
  return cells.map((cell) => {
    const value = cell.replace(/\s+/g, '')
    if (value.startsWith(':') && value.endsWith(':')) return 'center'
    if (value.endsWith(':')) return 'right'
    if (value.startsWith(':')) return 'left'
    return ''
  })
}

/**
 * Markdown → HTML 字符串。
 *
 * @param {string} src
 * @param {{
 *   splitRefs?: (text: string) => Array<{ text: string } | { refId: string }>,
 *   renderRef?: (refId: string) => string,
 * }} [options]
 *   `splitRefs` / `renderRef` 是领域内联引用的注入点（集锦的 `hira-note://` 等）。
 *   两者**必须同时给**才生效，只给一个按"没有引用语法"处理。
 * @returns {string}
 */
export function renderMarkdown(src: string | null | undefined, options?: MarkdownOptions): string {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/)
    if (fence) {
      closeList()
      const lang = fence[1]
      const buf = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 吃掉收尾的 ```
      out.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    // 标题
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2].trim(), options)}</h${level}>`)
      i++
      continue
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList()
      out.push('<hr>')
      i++
      continue
    }

    // GFM 表格：目前不支持单元格内换行与嵌套块，但能稳定覆盖总结 / 对比 / 来源清单。
    const headerCells = tableCells(line)
    const alignments = i + 1 < lines.length ? tableAlignments(lines[i + 1]) : null
    if (headerCells.length && alignments && alignments.length === headerCells.length) {
      closeList()
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = tableCells(lines[i])
        if (!cells.length) break
        rows.push(cells)
        i += 1
      }
      const cell = (tag: 'th' | 'td', value: string, column: number): string => {
        const align = alignments[column]
        const attr = align ? ` style="text-align:${align}"` : ''
        return `<${tag}${attr}>${renderInline(value, options)}</${tag}>`
      }
      const head = `<thead><tr>${headerCells.map((value, column) => cell('th', value, column)).join('')}</tr></thead>`
      const body = rows.length
        ? `<tbody>${rows.map((row) => `<tr>${headerCells.map((_value, column) => cell('td', row[column] || '', column)).join('')}</tr>`).join('')}</tbody>`
        : ''
      out.push(`<div class="md-table"><table>${head}${body}</table></div>`)
      continue
    }

    // 引用（递归：引用块内部照常解析）
    if (/^\s*>\s?/.test(line)) {
      closeList()
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), options)}</blockquote>`)
      continue
    }

    // 列表（不嵌套：面板窄栏里嵌套列表的缩进收益远小于可读性损失）
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (list !== want) {
        closeList()
        out.push(`<${want}>`)
        list = want
      }
      out.push(`<li>${renderInline((ul?.[1] ?? ol?.[1] ?? '').trim(), options)}</li>`)
      i++
      continue
    }

    // 空行
    if (/^\s*$/.test(line)) {
      closeList()
      i++
      continue
    }

    // 段落（连续非空且非块起始的行合并，内部软换行 → <br>）
    closeList()
    const buf = [line]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !BLOCK_START.test(lines[i])) {
      buf.push(lines[i])
      i++
    }
    out.push(`<p>${buf.map((l) => renderInline(l.trim(), options)).join('<br>')}</p>`)
  }

  closeList()
  return out.join('\n')
}
