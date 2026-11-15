'use strict'

/**
 * 阅读模式（Reader Mode）—— 页面内注入的唯一实现。
 *
 * ── 形态 ──────────────────────────────────────────────────────────
 * 不新开窗口 / 面板 / 浮层宿主：在**当前页面**上盖一层全屏阅读视图（fixed 覆盖层），
 * 退出即移除。页面保持原样（只读不改 DOM），因此刷新 / 前进后退天然一致。
 *
 * ── 能力 ──────────────────────────────────────────────────────────
 *   · 正文抽取：语义容器打分（文章长度 − 链接密度 + 段落数），无候选时回落 body；
 *   · 干净排版：剔除导航 / 广告 / 表单 / 脚本等噪音，图片懒加载属性回填；
 *   · 三套主题（浅色 / 米色 / 深色）+ 字号调节 + 阅读进度条；
 *   · 朗读：按段落分块交给 Web Speech（speechSynthesis），逐段高亮、暂停 / 继续 / 停止 / 语速。
 *   · 偏好持久化：主题 / 字号 / 语速写入页面 origin 的 localStorage（同站下次自动沿用）。
 *
 * ── 为什么用「函数 → 字符串」而不是手写一大段模板串 ─────────────────
 * 注入脚本要在页面主世界执行，只能传字符串。把实现写成一个**普通函数**再
 * `toString()`，既有语法高亮 / 可读性，又不会被模板串里的反引号与转义撕碎。
 *
 * ── 分层 ──────────────────────────────────────────────────────────
 * 本文件只认识一个 `webContents`（执行入口）+ 页面自身（覆盖层实现）。
 * 谁触发（右键菜单 / 快捷键 / 应用菜单）与阅读模式无关 —— 因此三个入口
 * 共用 `toggleReaderMode`，不存在第二套注入脚本。
 */

/** 页面主世界执行体。
 *
 * ⚠ 该函数会被 `toString()` 后注入页面，**不得**引用本文件任何外部变量
 *    （常量 / require / 闭包都不行）；需要的一切都在函数体内自备。
 *
 * @param {{ prefs?: { theme?: string, fontSize?: number, rate?: number } }} [rawOptions]
 * @returns {boolean} 本次是「打开」还是「关闭」（便于主进程调试）
 */
function readerMain(rawOptions?: { prefs?: { theme?: string; fontSize?: number; rate?: number } }): boolean {
  const OVERLAY_ID = '__hira_reader_overlay'
  const STYLE_ID = '__hira_reader_style'
  const PREFS_KEY = '__hira_reader_prefs'

  // 已在阅读模式 → 再点一次 = 退出（右键菜单 / F9 / 应用菜单都走同一个开关语义）。
  const existing = document.getElementById(OVERLAY_ID) as (HTMLElement & { __hiraExit?: () => void }) | null
  if (existing && typeof existing.__hiraExit === 'function') {
    existing.__hiraExit()
    return false
  }
  if (existing) {
    try { existing.remove() } catch (_) {}
  }

  // ── 偏好 ────────────────────────────────────────────────────────
  const THEMES = ['light', 'sepia', 'dark']
  const THEME_LABELS = { light: '浅色', sepia: '米色', dark: '深色' }
  const RATES = [0.75, 1, 1.25, 1.5, 2]
  const prefs: { theme: 'light' | 'sepia' | 'dark'; fontSize: number; rate: number } = { theme: 'light', fontSize: 19, rate: 1 }

  function mergePrefs(source: unknown): void {
    if (!source || typeof source !== 'object') return
    const record = source as { theme?: unknown; fontSize?: unknown; rate?: unknown }
    if (typeof record.theme === 'string' && THEMES.includes(record.theme)) prefs.theme = record.theme as typeof prefs.theme
    const size = Number(record.fontSize)
    if (size >= 15 && size <= 30) prefs.fontSize = Math.round(size)
    const rate = Number(record.rate)
    if (RATES.includes(rate)) prefs.rate = rate
  }

  try { mergePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')) } catch (_) {}
  mergePrefs(rawOptions && typeof rawOptions === 'object' ? rawOptions.prefs : null)

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch (_) {}
  }

  // ── 正文抽取 ────────────────────────────────────────────────────
  const NOISE_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'video', 'audio', 'nav', 'footer', 'header', 'aside', 'form',
    'button', 'select', 'input', 'textarea',
    '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]', '[role="complementary"]',
    '.ad', '.ads', '.advert', '.advertisement', '.share', '.sharing', '.social',
    '.comments', '.comment-list', '.sidebar', '.related', '.recommend',
    '.newsletter', '.cookie-banner', '.popup', '.modal'
  ].join(',')

  const CANDIDATES = [
    'article', 'main', '[role="main"]',
    '.post', '.article', '.article-content', '.post-content',
    '.entry', '.entry-content', '.markdown-body',
    '#content', '#main', '#article', '#post'
  ]

  function pickContainer(): Element | null {
    let best: Element | null = null
    let bestScore = 0
    for (const selector of CANDIDATES) {
      let nodes: NodeListOf<Element>
      try { nodes = document.querySelectorAll(selector) } catch (_) { continue }
      for (const el of nodes) {
        if (el.closest('#' + OVERLAY_ID)) continue
        // innerText 会触发布局；候选数量有限（通常 0~3 个），可接受。
        const text = (el as HTMLElement).innerText || ''
        if (text.length < 200) continue
        let linkLength = 0
        const links = el.querySelectorAll('a')
        for (let i = 0; i < links.length && i < 300; i++) {
          linkLength += ((links[i] as HTMLElement).innerText || '').length
        }
        const paragraphs = el.querySelectorAll('p').length
        // 长度越大越像正文；链接文字占比越高越像导航 / 目录；段落数给正向权重。
        const score = text.length - linkLength * 0.9 + Math.min(paragraphs, 40) * 25
        if (score > bestScore) {
          bestScore = score
          best = el
        }
      }
      // 已经找到足够像正文的块就不再试更弱的候选（省一次布局）。
      if (bestScore > 2000) break
    }
    return best || document.body
  }

  function buildContent(container: Element): Element | null {
    let clone: Node
    try { clone = container.cloneNode(true) } catch (_) { return null }
    if (!(clone instanceof Element)) return null

    try { clone.querySelectorAll(NOISE_SELECTOR).forEach((node: Element) => node.remove()) } catch (_) {}

    // 清掉会影响阅读排版的属性；顺带掐掉内联事件与 javascript: 链接。
    try {
      clone.querySelectorAll('*').forEach((el: Element) => {
        const attrs = Array.prototype.slice.call(el.attributes || [])
        for (const attr of attrs) {
          const name = String(attr.name || '').toLowerCase()
          if (name === 'style' || name === 'class' || name === 'id' || name.indexOf('on') === 0) {
            el.removeAttribute(attr.name)
            continue
          }
          if ((name === 'href' || name === 'src' || name === 'srcset') &&
            /^\s*(javascript|data:text\/html)/i.test(attr.value || '')) {
            el.removeAttribute(attr.name)
          }
        }
        if (el.tagName === 'IMG') {
          // 懒加载图片：真实地址常放在 data-* 上；src 只是占位图。
          const lazy = el.getAttribute('data-src') ||
            el.getAttribute('data-original') ||
            el.getAttribute('data-lazy-src') ||
            el.getAttribute('data-actualsrc')
          const src = el.getAttribute('src') || ''
          if (lazy && (!src || src.length < 12 || /^data:image\/gif/i.test(src))) {
            try { el.setAttribute('src', lazy) } catch (_) {}
          }
          el.removeAttribute('srcset')
        }
      })
    } catch (_) {}

    return clone
  }

  function readingMinutes(text: string): number {
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
    const rest = text.replace(/[\u3400-\u9fff]/g, ' ')
    const words = rest.split(/\s+/).filter(Boolean).length
    return Math.max(1, Math.round(cjk / 400 + words / 220))
  }

  const container = pickContainer()
  const root = container ? buildContent(container) : null
  const bodyText = root ? String(root.textContent || '').replace(/\s+/g, ' ').trim() : ''
  const hasContent = !!root && bodyText.length >= 80

  const host = String(location.hostname || location.host || '')
  const title = String(document.title || '').trim() || '未命名页面'
  const minutes = readingMinutes(bodyText)

  // ── 覆盖层 DOM ──────────────────────────────────────────────────
  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', '阅读模式')
  overlay.dataset.theme = prefs.theme
  overlay.style.setProperty('--reader-font-size', prefs.fontSize + 'px')
  overlay.style.colorScheme = prefs.theme === 'dark' ? 'dark' : 'light'
  overlay.tabIndex = -1

  const progress = document.createElement('div')
  progress.className = '__hira_r_progress'
  const progressBar = document.createElement('div')
  progressBar.className = '__hira_r_progress-bar'
  progress.appendChild(progressBar)

  const bar = document.createElement('div')
  bar.className = '__hira_r_bar'

  const info = document.createElement('div')
  info.className = '__hira_r_info'
  const hostEl = document.createElement('span')
  hostEl.className = '__hira_r_host'
  hostEl.textContent = host || '本页'
  const metaEl = document.createElement('span')
  metaEl.className = '__hira_r_meta'
  metaEl.textContent = hasContent ? `${minutes} 分钟阅读 · 约 ${bodyText.length} 字符` : ''
  info.appendChild(hostEl)
  info.appendChild(metaEl)

  const tools = document.createElement('div')
  tools.className = '__hira_r_tools'

  function makeButton(label: string, hint: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = '__hira_r_btn'
    button.textContent = label
    if (hint) button.title = hint
    return button
  }

  const fontDown = makeButton('A−', '缩小字号')
  const fontUp = makeButton('A+', '放大字号')
  const themeBtn = makeButton(THEME_LABELS[prefs.theme], '切换阅读主题')
  const playBtn = makeButton('朗读', '朗读正文')
  const stopBtn = makeButton('停止', '停止朗读')
  stopBtn.disabled = true

  const rateSelect = document.createElement('select')
  rateSelect.className = '__hira_r_select'
  rateSelect.title = '朗读语速'
  for (const rate of RATES) {
    const option = document.createElement('option')
    option.value = String(rate)
    option.textContent = rate + '×'
    rateSelect.appendChild(option)
  }
  rateSelect.value = String(prefs.rate)

  const closeBtn = makeButton('退出', '退出阅读模式（Esc）')

  tools.appendChild(fontDown)
  tools.appendChild(fontUp)
  tools.appendChild(themeBtn)
  tools.appendChild(playBtn)
  tools.appendChild(stopBtn)
  tools.appendChild(rateSelect)
  tools.appendChild(closeBtn)
  bar.appendChild(info)
  bar.appendChild(tools)

  const article = document.createElement('article')
  article.className = '__hira_r_article'
  const heading = document.createElement('h1')
  heading.className = '__hira_r_title'
  heading.textContent = title
  const content = document.createElement('div')
  content.className = '__hira_r_content'
  if (hasContent) {
    content.innerHTML = root.innerHTML
  } else {
    const empty = document.createElement('div')
    empty.className = '__hira_r_empty'
    empty.textContent = '没有识别出可阅读的正文。可以退出后换一个页面再试。'
    content.appendChild(empty)
    playBtn.disabled = true
  }
  article.appendChild(heading)
  article.appendChild(content)

  overlay.appendChild(progress)
  overlay.appendChild(bar)
  overlay.appendChild(article)

  // ── 样式（全部挂在覆盖层作用域内，绝不污染页面）──────────────────
  // CSP 严格的站点会拦掉内联 <style>；构造式样式表不受 style-src 约束，优先用它。
  const CSS_TEXT = `
#__hira_reader_overlay{position:fixed;inset:0;z-index:2147483647;overflow-y:auto;overflow-x:hidden;background:var(--r-bg);color:var(--r-fg);font-family:"Segoe UI Variable Text","Segoe UI Variable","Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;text-align:left;letter-spacing:normal;word-spacing:normal;--r-bg:#fbfbfa;--r-fg:#1f2328;--r-bar:rgba(251,251,250,.92);--r-border:#e6e8eb;--r-muted:#6b7280;--r-accent:#2563eb;--r-btn:#f2f3f5;--r-btn-hover:#e7e9ec;--r-hl:rgba(37,99,235,.14);--r-code:#f3f4f6;--reader-font-size:19px}
#__hira_reader_overlay[data-theme="sepia"]{--r-bg:#f7f1e5;--r-fg:#3b3226;--r-bar:rgba(247,241,229,.92);--r-border:#e3d8c3;--r-muted:#8a7a63;--r-accent:#a35b2a;--r-btn:#efe6d5;--r-btn-hover:#e6dac5;--r-hl:rgba(163,91,42,.16);--r-code:#efe6d5}
#__hira_reader_overlay[data-theme="dark"]{--r-bg:#16181c;--r-fg:#e6e6e6;--r-bar:rgba(22,24,28,.92);--r-border:#2a2e34;--r-muted:#9aa1a9;--r-accent:#7aa2ff;--r-btn:#23272d;--r-btn-hover:#2c3138;--r-hl:rgba(122,162,255,.18);--r-code:#23272d}
#__hira_reader_overlay .__hira_r_progress{position:fixed;top:0;left:0;right:0;height:3px;background:transparent;z-index:6;pointer-events:none}
#__hira_reader_overlay .__hira_r_progress-bar{height:100%;width:0;background:var(--r-accent)}
#__hira_reader_overlay .__hira_r_bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 24px;background:var(--r-bar);border-bottom:1px solid var(--r-border);backdrop-filter:saturate(1.4) blur(14px)}
#__hira_reader_overlay .__hira_r_info{display:flex;align-items:center;gap:10px;min-width:0}
#__hira_reader_overlay .__hira_r_host{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34vw}
#__hira_reader_overlay .__hira_r_meta{font-size:12px;color:var(--r-muted);white-space:nowrap}
#__hira_reader_overlay .__hira_r_tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
#__hira_reader_overlay .__hira_r_btn{appearance:none;border:0;background:var(--r-btn);color:var(--r-fg);font:inherit;font-size:13px;line-height:1;padding:8px 12px;border-radius:8px;cursor:pointer;transition:background .12s ease}
#__hira_reader_overlay .__hira_r_btn:hover{background:var(--r-btn-hover)}
#__hira_reader_overlay .__hira_r_btn:active{transform:translateY(1px)}
#__hira_reader_overlay .__hira_r_btn:disabled{opacity:.45;cursor:default}
#__hira_reader_overlay .__hira_r_select{appearance:none;border:0;background:var(--r-btn);color:var(--r-fg);font:inherit;font-size:13px;padding:8px 10px;border-radius:8px;cursor:pointer}
#__hira_reader_overlay .__hira_r_article{max-width:720px;margin:0 auto;padding:48px 28px 120px}
#__hira_reader_overlay .__hira_r_title{font-size:1.85em;line-height:1.3;margin:0 0 18px;font-weight:700;letter-spacing:-.01em}
#__hira_reader_overlay .__hira_r_content{font-size:var(--reader-font-size);line-height:1.9;word-break:break-word;overflow-wrap:anywhere}
#__hira_reader_overlay .__hira_r_content p{margin:0 0 1.15em}
#__hira_reader_overlay .__hira_r_content h1,#__hira_reader_overlay .__hira_r_content h2,#__hira_reader_overlay .__hira_r_content h3,#__hira_reader_overlay .__hira_r_content h4,#__hira_reader_overlay .__hira_r_content h5,#__hira_reader_overlay .__hira_r_content h6{line-height:1.35;margin:1.8em 0 .7em;font-weight:700}
#__hira_reader_overlay .__hira_r_content h1{font-size:1.5em}
#__hira_reader_overlay .__hira_r_content h2{font-size:1.3em}
#__hira_reader_overlay .__hira_r_content h3{font-size:1.15em}
#__hira_reader_overlay .__hira_r_content ul,#__hira_reader_overlay .__hira_r_content ol{margin:0 0 1.15em;padding-left:1.5em}
#__hira_reader_overlay .__hira_r_content li{margin:.35em 0}
#__hira_reader_overlay .__hira_r_content img{max-width:100%;height:auto;border-radius:6px;display:block;margin:1.2em auto}
#__hira_reader_overlay .__hira_r_content figure{margin:1.4em 0}
#__hira_reader_overlay .__hira_r_content figcaption{font-size:.82em;color:var(--r-muted);text-align:center;margin-top:.5em}
#__hira_reader_overlay .__hira_r_content a{color:var(--r-accent);text-decoration:underline;text-underline-offset:2px}
#__hira_reader_overlay .__hira_r_content pre{background:var(--r-code);padding:14px 16px;border-radius:8px;overflow-x:auto;font-size:.85em;line-height:1.6}
#__hira_reader_overlay .__hira_r_content code{background:var(--r-code);padding:.15em .35em;border-radius:4px;font-size:.9em}
#__hira_reader_overlay .__hira_r_content pre code{background:none;padding:0;font-size:1em}
#__hira_reader_overlay .__hira_r_content blockquote{margin:1.2em 0;padding:.2em 0 .2em 1em;border-left:3px solid var(--r-border);color:var(--r-muted)}
#__hira_reader_overlay .__hira_r_content table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:.92em}
#__hira_reader_overlay .__hira_r_content th,#__hira_reader_overlay .__hira_r_content td{border:1px solid var(--r-border);padding:8px 10px;text-align:left}
#__hira_reader_overlay .__hira_r_content hr{border:0;border-top:1px solid var(--r-border);margin:2em 0}
#__hira_reader_overlay .__hira_r_speaking{background:var(--r-hl);box-shadow:0 0 0 4px var(--r-hl);border-radius:4px;transition:background .15s ease,box-shadow .15s ease}
#__hira_reader_overlay .__hira_r_empty{padding:80px 0;text-align:center;color:var(--r-muted)}
@media (max-width:640px){#__hira_reader_overlay .__hira_r_bar{padding:10px 14px;gap:8px}#__hira_reader_overlay .__hira_r_host{max-width:40vw}#__hira_reader_overlay .__hira_r_article{padding:32px 18px 96px}}
`
  let sheet: CSSStyleSheet | null = null
  try {
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document &&
      typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      sheet = new CSSStyleSheet()
      sheet.replaceSync(CSS_TEXT)
      document.adoptedStyleSheets = Array.from(document.adoptedStyleSheets || []).concat([sheet])
    }
  } catch (_) { sheet = null }
  const style = document.createElement('style')
  style.id = STYLE_ID
  if (!sheet) {
    style.textContent = CSS_TEXT
    document.head.appendChild(style)
  }
  document.documentElement.appendChild(overlay)

  // ── 阅读偏好 ────────────────────────────────────────────────────
  function applyPrefs() {
    overlay.dataset.theme = prefs.theme
    overlay.style.colorScheme = prefs.theme === 'dark' ? 'dark' : 'light'
    overlay.style.setProperty('--reader-font-size', prefs.fontSize + 'px')
    themeBtn.textContent = THEME_LABELS[prefs.theme]
    rateSelect.value = String(prefs.rate)
    savePrefs()
  }

  fontDown.addEventListener('click', () => {
    prefs.fontSize = Math.max(15, prefs.fontSize - 1)
    applyPrefs()
  })
  fontUp.addEventListener('click', () => {
    prefs.fontSize = Math.min(30, prefs.fontSize + 1)
    applyPrefs()
  })
  themeBtn.addEventListener('click', () => {
    const index = THEMES.indexOf(prefs.theme)
    prefs.theme = THEMES[(index + 1) % THEMES.length] as typeof prefs.theme
    applyPrefs()
  })
  rateSelect.addEventListener('change', () => {
    const rate = Number(rateSelect.value)
    prefs.rate = RATES.indexOf(rate) >= 0 ? rate : 1
    applyPrefs()
  })

  // ── 朗读（Web Speech）──────────────────────────────────────────
  const synth = typeof window.speechSynthesis !== 'undefined' ? window.speechSynthesis : null
  if (!synth) {
    playBtn.disabled = true
    playBtn.title = '当前环境不支持语音朗读'
  }

  const lang = String(
    (document.documentElement && document.documentElement.lang) ||
    (navigator && navigator.language) ||
    'zh-CN'
  )
  const langRoot = lang.toLowerCase().split('-')[0]
  let voices: SpeechSynthesisVoice[] = []
  let voice: SpeechSynthesisVoice | null = null

  function pickVoice() {
    voice = null
    if (!voices.length) return
    const exact = voices.find((item) => String(item.lang || '').toLowerCase() === lang.toLowerCase())
    const partial = voices.find((item) => String(item.lang || '').toLowerCase().split('-')[0] === langRoot)
    voice = exact || partial || null
  }

  function refreshVoices() {
    if (!synth) return
    try { voices = synth.getVoices() || [] } catch (_) { voices = [] }
    pickVoice()
  }

  function onVoicesChanged() {
    refreshVoices()
  }

  if (synth && typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', onVoicesChanged)
  }
  refreshVoices()

  function cleanText(value: unknown): string {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  /** 把长段落切成 ≤400 字的块（部分平台对单条 utterance 的长度/时长有限制）。 */
  function chunkText(text: string): string[] {
    const chunks: string[] = []
    let rest = text
    while (rest.length > 400) {
      let cut = -1
      for (let i = 380; i > 120; i--) {
        if (/[。！？.!?；;]/.test(rest.charAt(i))) {
          cut = i + 1
          break
        }
      }
      if (cut < 0) cut = 400
      chunks.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) chunks.push(rest)
    return chunks
  }

  /**
   * 朗读队列：按块元素切分，并剔掉「父块包含子块」的重复
   * （如 `<li><p>…</p></li>` 只读 p，避免同一句念两遍）。
   */
  function buildQueue() {
    const nodes = Array.prototype.slice.call(
      content.querySelectorAll('h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,td,th')
    )
    const withText = []
    for (const el of nodes) {
      const text = cleanText(el.textContent)
      if (text.length >= 2) withText.push({ el, text })
    }
    const items = []
    for (const item of withText) {
      let covered = false
      for (const other of withText) {
        if (other === item) continue
        if (item.el.contains(other.el) && other.text.length >= item.text.length * 0.7) {
          covered = true
          break
        }
      }
      if (covered) continue
      for (const chunk of chunkText(item.text)) items.push({ el: item.el, text: chunk })
    }
    return items
  }

  let speaking = false
  let paused = false
  let canceled = false
  let queue: Array<{ el: HTMLElement; text: string }> = []
  let cursor = 0
  let highlighted: HTMLElement | null = null

  function paintSpeech() {
    playBtn.textContent = speaking ? (paused ? '继续' : '暂停') : '朗读'
    stopBtn.disabled = !speaking
  }

  function clearHighlight() {
    if (highlighted && highlighted.classList) highlighted.classList.remove('__hira_r_speaking')
    highlighted = null
  }

  function highlight(el: HTMLElement): void {
    if (highlighted === el) return
    clearHighlight()
    highlighted = el
    if (el && el.classList) el.classList.add('__hira_r_speaking')
    try {
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    } catch (_) {}
  }

  function speakNext() {
    if (canceled || !synth) return
    if (cursor >= queue.length) {
      finishSpeaking()
      return
    }
    const item = queue[cursor++]
    let utterance: SpeechSynthesisUtterance
    try {
      utterance = new SpeechSynthesisUtterance(item.text)
    } catch (_) {
      finishSpeaking()
      return
    }
    utterance.lang = lang
    utterance.rate = prefs.rate
    if (voice) utterance.voice = voice
    utterance.onstart = () => { highlight(item.el) }
    utterance.onend = () => { if (!canceled) speakNext() }
    utterance.onerror = () => { if (!canceled) speakNext() }
    try { synth.speak(utterance) } catch (_) { finishSpeaking() }
  }

  function finishSpeaking() {
    canceled = true
    speaking = false
    paused = false
    queue = []
    cursor = 0
    clearHighlight()
    paintSpeech()
  }

  function stopSpeaking() {
    canceled = true
    try { if (synth) synth.cancel() } catch (_) {}
    speaking = false
    paused = false
    queue = []
    cursor = 0
    clearHighlight()
    paintSpeech()
  }

  function toggleSpeaking() {
    if (!synth) return
    if (speaking) {
      if (paused) {
        try { synth.resume() } catch (_) {}
        paused = false
      } else {
        try { synth.pause() } catch (_) {}
        paused = true
      }
      paintSpeech()
      return
    }
    queue = buildQueue()
    cursor = 0
    if (!queue.length) return
    canceled = false
    speaking = true
    paused = false
    paintSpeech()
    speakNext()
  }

  playBtn.addEventListener('click', toggleSpeaking)
  stopBtn.addEventListener('click', stopSpeaking)

  // ── 进度条 / 退出 ───────────────────────────────────────────────
  function updateProgress() {
    const max = overlay.scrollHeight - overlay.clientHeight
    const ratio = max > 0 ? Math.min(1, Math.max(0, overlay.scrollTop / max)) : 1
    progressBar.style.width = (ratio * 100).toFixed(2) + '%'
  }
  overlay.addEventListener('scroll', updateProgress, { passive: true })
  updateProgress()

  const previousOverflow = document.body ? document.body.style.overflow : ''
  if (document.body) document.body.style.overflow = 'hidden'

  let exited = false
  function exitReader() {
    if (exited) return
    exited = true
    stopSpeaking()
    try { document.removeEventListener('keydown', onKeydown, true) } catch (_) {}
    if (synth && typeof synth.removeEventListener === 'function') {
      try { synth.removeEventListener('voiceschanged', onVoicesChanged) } catch (_) {}
    }
    try { overlay.remove() } catch (_) {}
    if (sheet) {
      try {
        document.adoptedStyleSheets = Array.prototype.slice
          .call(document.adoptedStyleSheets || [])
          .filter((item) => item !== sheet)
      } catch (_) {}
    } else {
      try { style.remove() } catch (_) {}
    }
    if (document.body) document.body.style.overflow = previousOverflow
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      exitReader()
      return
    }
    // 焦点陷阱：覆盖层是模态视图，Tab 不能跑到后面的页面上去。
    if (event.key === 'Tab') {
      const focusables = Array.from(overlay.querySelectorAll<HTMLElement>('button:not([disabled]),select'))
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!overlay.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      }
    }
  }

  document.addEventListener('keydown', onKeydown, true)
  closeBtn.addEventListener('click', exitReader)
  ;(overlay as HTMLDivElement & { __hiraExit?: () => void }).__hiraExit = exitReader

  try { overlay.focus({ preventScroll: true }) } catch (_) {}
  return true
}

/**
 * 生成注入脚本字符串（`executeJavaScript` 的唯一入参形态）。
 *
 * @param {{ prefs?: { theme?: string, fontSize?: number, rate?: number } }} [options]
 * @returns {string}
 */
export function createReaderScript(options?: { prefs?: { theme?: string; fontSize?: number; rate?: number } }): string {
  return '(' + readerMain.toString() + ')(' + JSON.stringify(options || {}) + ')'
}

/**
 * 在指定页面上开关阅读模式。
 *
 * @param {Electron.WebContents} webContents
 * @param {{ prefs?: { theme?: string, fontSize?: number, rate?: number } }} [options]
 * @returns {Promise<boolean>} true = 打开，false = 关闭；页面不可用时返回 false
 */
export function toggleReaderMode(
  webContents: Electron.WebContents | null | undefined,
  options?: { prefs?: { theme?: string; fontSize?: number; rate?: number } }
): Promise<boolean> {
  if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) {
    return Promise.resolve(false)
  }
  return Promise.resolve(webContents.executeJavaScript(createReaderScript(options)))
    .then((result) => result === true)
    .catch((error: unknown) => {
      console.warn('[reader-mode] inject failed:', error instanceof Error ? error.message : error)
      return false
    })
}

