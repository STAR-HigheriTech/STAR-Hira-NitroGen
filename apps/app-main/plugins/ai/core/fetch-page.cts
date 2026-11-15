/**
 * AI 引擎 · 远程取页（PART15 §9.1 的 `page` provider 后半段）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它（而不只是读"当前标签"）
 * ══════════════════════════════════════════════════════════════════════
 * 用户从**书签 / 历史 / 链接右键**把一页加入上下文时，那一页往往**没开在标签里**。
 * 两条路可选：
 *   ① 偷偷开一个标签 / 隐藏窗口去渲染 —— 会改变用户看到的标签栏，或者引入一整
 *      套离屏 BrowserWindow 生命周期（新面、新泄漏点）；
 *   ② 直接 GET 一次 HTML，在主进程里剥成文本 —— 不碰窗口模型。
 * 这里选 ②：上下文只需要"这一页说了什么"，不需要执行页面 JS。
 *
 * 硬规矩：
 *   · 只收 `text/html` / `text/plain`；其它（PDF / 图片 / 二进制）直接放弃，交给截图或附件。
 *   · 下载硬上限 4MB（超了中断，绝不让一次"加入上下文"吃掉几十兆内存）。
 *   · 只读、无 cookie 依赖的**共享 session**：不带凭证，避免把登录态带进一个后台请求。
 *
 * 输出形状与 `readPage()` 对齐（title / text / links / truncated），
 * 这样 `snapshotToText()` 不必区分"本地读到的"与"远程取到的"。
 */

const { net } = require('electron')
const { assertSafeUrl } = require('./net-guard.cjs') as {
  assertSafeUrl(url: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }>
}

interface FetchHtmlSuccess { ok: true; html: string; mime: string }
interface FetchHtmlFailure { ok: false; reason: string }
interface FetchRedirect { redirect: string }
type RequestResult = FetchHtmlSuccess | FetchHtmlFailure | FetchRedirect

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resumeResponse(response: Electron.IncomingMessage): void {
  const resumable = response as Electron.IncomingMessage & { resume?: () => void }
  resumable.resume?.()
}

/** 下载硬上限（字节）。超过即中断 —— 上下文里塞不下一本电子书。 */
const MAX_BYTES = 4 * 1024 * 1024
/** 最多跟随几跳重定向（每一跳都要重新过 `assertSafeUrl`）。 */
const MAX_REDIRECTS = 5
/** 默认正文上限（字符），与 readPage 的默认口径一致。 */
const DEFAULT_MAX_CHARS = 60000
const DEFAULT_MAX_LINKS = 40

function decodeEntities(s: unknown): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–'
  }
  return String(s)
    .replace(/&#(\d+);/g, (_match: string, n: string) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_match: string, n: string) => String.fromCodePoint(parseInt(n, 16) || 32))
    .replace(/&([a-z]+);/gi, (match: string, name: string) => (named[name.toLowerCase()] != null ? named[name.toLowerCase()] : match))
}

function collapse(s: unknown): string {
  return String(s || '').replace(/[ \t\r\f\v\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** `<a href>` → `{text,url}`（限 N 条；相对地址按 base 补全）。 */
function extractLinks(html: string, baseUrl: string, maxLinks: number): Array<{ text: string; url: string }> {
  const out: Array<{ text: string; url: string }> = []
  if (maxLinks <= 0) return out
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) && out.length < maxLinks) {
    const raw = decodeEntities(m[1])
    const text = collapse(decodeEntities(m[2].replace(/<[^>]+>/g, ' '))).slice(0, 120)
    if (!text || !raw || raw.startsWith('#') || /^javascript:/i.test(raw)) continue
    let href = raw
    try { href = new URL(raw, baseUrl).toString() } catch (_) { /* 保持原样 */ }
    out.push({ text, url: href })
  }
  return out
}

/** HTML → 纯文本（无 DOM：剥标签 + 块级换行 + 解实体 + 折叠空白）。 */
function htmlToText(html: unknown): string {
  let s = String(html || '')
  // 整块剔除（连内容一起丢）：这些标签里的文字对模型只有噪声。
  s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, ' ')
  // 注释
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // 块级元素前后补换行（避免整页挤成一行）
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|header|footer|main|nav)\s*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // 其余标签直接去掉
  s = s.replace(/<[^>]+>/g, ' ')
  return collapse(decodeEntities(s))
}

/**
 * 单跳请求。**重定向不跟随**（`redirect: 'manual'`）：3xx 只回 `{ redirect }`，
 * 由 `fetchHtml` 重新过安全闸再决定要不要去 —— 否则「公网地址 302 到 127.0.0.1」
 * 就能把前面的地址校验整个绕过。
 */
function requestOnce(url: string, timeoutMs: number): Promise<RequestResult> {
  return new Promise<RequestResult>((resolve) => {
    let req: Electron.ClientRequest
    try {
      req = net.request({ method: 'GET', url, redirect: 'manual' })
    } catch (e) {
      resolve({ ok: false, reason: `request-failed: ${errorMessage(e)}` })
      return
    }

    let settled = false
    const finish = (result: RequestResult) => { if (!settled) { settled = true; resolve(result) } }
    const timer = setTimeout(() => {
      try { req.abort() } catch (_) {}
      finish({ ok: false, reason: 'timeout' })
    }, timeoutMs)

    req.on('response', (res: Electron.IncomingMessage) => {
      const status = Number(res.statusCode) || 0
      if (status >= 300 && status < 400) {
        clearTimeout(timer)
        try { resumeResponse(res) } catch (_) {}
        const rawLocation = res.headers && res.headers.location
        const location = String(Array.isArray(rawLocation) ? rawLocation[0] : (rawLocation || '')).trim()
        let next = ''
        try { next = location ? new URL(location, url).toString() : '' } catch (_) { next = '' }
        finish(next ? { redirect: next } : { ok: false, reason: `http-${status}` })
        return
      }
      if (status < 200 || status >= 300) {
        clearTimeout(timer)
        try { resumeResponse(res) } catch (_) {}
        finish({ ok: false, reason: `http-${status}` })
        return
      }
      const rawType = res.headers && res.headers['content-type']
      const mime = String(Array.isArray(rawType) ? rawType[0] : (rawType || '')).split(';')[0].trim().toLowerCase()
      if (mime && !/^text\/html|^text\/plain|^application\/xhtml/.test(mime)) {
        clearTimeout(timer)
        try { resumeResponse(res) } catch (_) {}
        finish({ ok: false, reason: `unsupported-type:${mime}` })
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BYTES) {
          clearTimeout(timer)
          try { req.abort() } catch (_) {}
          finish({ ok: false, reason: 'too-large' })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        clearTimeout(timer)
        finish({ ok: true, html: Buffer.concat(chunks).toString('utf8'), mime })
      })
      res.on('error', (e: Error) => {
        clearTimeout(timer)
        finish({ ok: false, reason: `stream-failed: ${errorMessage(e)}` })
      })
    })
    req.on('error', (e: Error) => {
      clearTimeout(timer)
      finish({ ok: false, reason: `request-failed: ${errorMessage(e)}` })
    })
    req.end()
  })
}

/**
 * 取一份远程 HTML（**已过 SSRF 安全闸 + 逐跳重定向校验**）。
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, html: string, mime: string } | { ok: false, reason: string }>}
 */
async function fetchHtml(url: string, { timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<FetchHtmlSuccess | FetchHtmlFailure> {
  const deadline = Date.now() + timeoutMs
  let current = String(url || '').trim()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await assertSafeUrl(current)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }

    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, reason: 'timeout' }

    const res = await requestOnce(verdict.url, remaining)
    if ('redirect' in res) {
      current = res.redirect
      continue
    }
    if ('ok' in res) return res
    return { ok: false, reason: 'invalid-response' }
  }
  return { ok: false, reason: 'too-many-redirects' }
}

/**
 * 取一个远程页面的结构化快照（形状与 `page.cjs#readPage` 对齐）。
 *
 * @param {string} url
 * @param {{ maxChars?: number, maxLinks?: number }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string, url?: string, title?: string,
 *   text?: string, links?: Array<{text:string,url:string}>, truncated?: boolean }>}
 */
async function fetchPage(url: string, { maxChars = DEFAULT_MAX_CHARS, maxLinks = DEFAULT_MAX_LINKS }: { maxChars?: number; maxLinks?: number } = {}) : Promise<{ ok: boolean, reason?: string, url?: string, title?: string,
  text?: string, links?: Array<{text:string,url:string}>, truncated?: boolean }> {
  const verdict = await assertSafeUrl(url)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const target = verdict.url

  const res = await fetchHtml(target)
  if (!res.ok) return { ok: false, reason: res.reason }

  const html = res.html
  if (/^text\/plain/.test(res.mime || '')) {
    const text = html.slice(0, maxChars)
    return { ok: true, url: target, title: '', text, links: [], truncated: html.length > text.length }
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' '))) : ''
  const full = htmlToText(html)
  const text = full.slice(0, maxChars)
  return {
    ok: true,
    url: target,
    title,
    text,
    links: extractLinks(html, target, maxLinks),
    truncated: full.length > text.length
  }
}

// `fetchHtml` 必须导出：联网检索（web-search.cjs）要拿原始 HTML 去解析结果页，
// 而不是先被剥成正文。`decodeEntities` / `collapse` 同理 —— 搜索结果的标题与
// 摘要需要与正文一套解码规则，避免两处各写一遍实体表。
module.exports = { fetchPage, fetchHtml, htmlToText, decodeEntities, collapse, MAX_BYTES }
