/**
 * AI 引擎 · 页面读取（PART15 §9）。
 *
 * 两条硬规矩：
 *   1. **隔离世界**：抽取脚本跑在 worldId 999 的隔离世界，页面自己的 JS 看不到、
 *      也改不了我们用的对象 —— 页面往 `Array.prototype` 上打补丁不会影响抽取结果。
 *   2. **只读 + 限额**：不点按钮、不发请求；正文与链接都有硬上限，
 *      再大的页面也只付出一次 O(节点数) 的遍历。
 *
 * 剔除项（宁可少给，也不要让密码 / 卡号进模型）：
 *   script / style / noscript / svg / canvas / iframe / template、
 *   `display:none` / `visibility:hidden` 的子树、`input[type=password]`、
 *   `autocomplete` 以 `cc-` 开头的字段、`[data-ai-private]`。
 */

const WORLD_ID = 999

interface PageSnapshot {
  url: string
  title: string
  lang: string
  selection: string
  headings: Array<{ level: number; text: string }>
  text: string
  links: Array<{ text: string; url: string }>
  meta: Record<string, string>
  truncated: boolean
}

/**
 * 在页面里执行的抽取函数。**必须自包含**（会被 toString() 后注入隔离世界），
 * 不能引用本文件作用域里的任何变量。
 */
function extract(maxChars: number, maxLinks: number): PageSnapshot {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'TEMPLATE', 'VIDEO', 'AUDIO'])
  const hidden = (el: Element): boolean => {
    try {
      const s = window.getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true
      return false
    } catch (_) { return false }
  }
  const sensitive = (el: Element): boolean => {
    try {
      if (el.hasAttribute && el.hasAttribute('data-ai-private')) return true
      if (el.tagName === 'INPUT') {
        const type = String((el as HTMLInputElement).type || '').toLowerCase()
        if (type === 'password' || type === 'hidden') return true
      }
      const ac = el.getAttribute && el.getAttribute('autocomplete')
      if (ac && /^cc-/i.test(ac)) return true
    } catch (_) {}
    return false
  }

  const root = document.body || document.documentElement
  const chunks: string[] = []
  let length = 0
  let truncated = false

  const push = (text: unknown) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (!t) return
    if (length + t.length > maxChars) {
      const rest = maxChars - length
      if (rest > 0) { chunks.push(t.slice(0, rest)); length = maxChars }
      truncated = true
      return
    }
    chunks.push(t)
    length += t.length
  }

  const walk = (node: Node | null) => {
    if (truncated || !node) return
    if (node.nodeType === 3) { push(node.nodeValue); return }
    if (node.nodeType !== 1) return
    const element = node as Element
    const tag = element.tagName
    if (SKIP.has(tag) || sensitive(element)) return
    if (hidden(element)) return
    // 块级元素之间补一个换行，避免"两段粘成一句"
    chunks.push('\n')
    for (let child = node.firstChild; child && !truncated; child = child.nextSibling) walk(child)
    if (tag === 'P' || tag === 'DIV' || tag === 'LI' || tag === 'TR' || /^H[1-6]$/.test(tag) || tag === 'BLOCKQUOTE') {
      chunks.push('\n')
    }
  }
  if (root) walk(root)

  const text = chunks.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars)

  let selection = ''
  try { selection = String(window.getSelection() || '').slice(0, 4000) } catch (_) {}

  const headings: Array<{ level: number; text: string }> = []
  try {
    for (const h of Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 24)) {
      const t = String(h.textContent || '').replace(/\s+/g, ' ').trim()
      if (t) headings.push({ level: Number(h.tagName.slice(1)) || 2, text: t.slice(0, 200) })
    }
  } catch (_) {}

  const links: Array<{ text: string; url: string }> = []
  try {
    for (const element of Array.from(document.querySelectorAll('a[href]'))) {
      if (links.length >= maxLinks) break
      const a = element as HTMLAnchorElement
      const url = a.href || ''
      if (!/^https?:/i.test(url)) continue
      const t = String(a.textContent || '').replace(/\s+/g, ' ').trim()
      links.push({ text: t.slice(0, 120), url: url.slice(0, 500) })
    }
  } catch (_) {}

  const meta: Record<string, string> = {}
  try {
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (desc) meta.description = String(desc.content || '').slice(0, 500)
    const kw = document.querySelector<HTMLMetaElement>('meta[name="keywords"]')
    if (kw) meta.keywords = String(kw.content || '').slice(0, 300)
    const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')
    if (og) meta.ogTitle = String(og.content || '').slice(0, 300)
  } catch (_) {}

  return {
    url: String(location.href || ''),
    title: String(document.title || ''),
    lang: String(document.documentElement && document.documentElement.lang || ''),
    selection,
    headings,
    text,
    links,
    meta,
    truncated
  }
}

/**
 * 读一个 webContents 的页面快照。
 * @param {Electron.WebContents} webContents
 * @param {{ maxChars?: number, maxLinks?: number }} [opts]
 */
async function readPage(webContents: Electron.WebContents, opts: { maxChars?: number; maxLinks?: number } = {}): Promise<PageSnapshot> {
  if (!webContents || webContents.isDestroyed()) {
    throw new Error('页面不可用（标签已关闭或正在休眠）')
  }
  const maxChars = Math.min(Math.max(Number(opts.maxChars) || 12000, 500), 60000)
  const maxLinks = Math.min(Math.max(Number(opts.maxLinks) || 40, 0), 200)
  const code = `(${extract.toString()})(${maxChars}, ${maxLinks})`
  const raw = await webContents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }])
  if (!raw || typeof raw !== 'object') throw new Error('页面内容为空（可能是内置页或尚未加载完成）')
  return raw as PageSnapshot
}

/**
 * 截图：返回 data URL（渲染层可直接放进 <img>，也满足 contentBlock.image.ref）。
 * @param {Electron.WebContents} webContents
 * @param {{ x?: number, y?: number, width?: number, height?: number }} [rect]
 */
async function capturePage(webContents: Electron.WebContents, rect: { x?: number; y?: number; width?: number; height?: number } = {}) {
  if (!webContents || webContents.isDestroyed()) throw new Error('页面不可用（标签已关闭或正在休眠）')
  const width = Number(rect.width)
  const height = Number(rect.height)
  const hasRect = Number.isFinite(width) && Number.isFinite(height)
  const image = await webContents.capturePage(hasRect
    ? { x: Math.max(0, Math.round(rect.x || 0)), y: Math.max(0, Math.round(rect.y || 0)), width: Math.round(width), height: Math.round(height) }
    : undefined)
  const size = image.getSize()
  return { dataUrl: image.toDataURL(), mime: 'image/png', width: size.width, height: size.height }
}

module.exports = { readPage, capturePage, PAGE_WORLD_ID: WORLD_ID }
