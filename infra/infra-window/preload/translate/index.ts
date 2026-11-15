/**
 * 页面侧翻译引擎：收集可见文本、按字符批量请求、原位回填并保留原文。
 *
 * 网络调度属于主进程；这里只负责 DOM 与交互。每批都有独立上限，顶层还有总时限，
 * 因此上游断网、令牌失效或某个来源限流时，页面会明确结束并给出可重试状态。
 */

import { ipcRenderer } from 'electron'
import {
  batchByChars,
  LANGUAGES,
  normalizeLanguageTag,
  shouldSkipText,
  TRANSLATE_LIMITS
} from '@hira-ng/shared-types/src/translate'
import { PRELOAD_EVENTS, PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
import { uiFontVar } from '@hira-ng/shared-types/src/font-stack'
import { applyAccentVars, subscribeAccent } from '../theme-accent.js'

const ROUTE = PRELOAD_ROUTES.translateText
const TARGET_ROUTE = PRELOAD_ROUTES.translateTarget
const EVENT_CHANNEL = `ngipc:event:${PRELOAD_EVENTS.translatePage}`
const BATCH_TIMEOUT_MS = 13_000
const TOTAL_TIMEOUT_MS = 45_000
const TARGET_TIMEOUT_MS = 3_000
const MAX_PARALLEL_BATCHES = 1
const DOM_WRITE_CHUNK = 24
const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'textarea', 'input', 'select', 'option',
  'code', 'pre', 'kbd', 'samp', 'svg', 'canvas', 'iframe', 'video', 'audio', 'math',
  '[data-hira-ui="translate"]', '[aria-hidden="true"]', '[contenteditable="true"]', '[contenteditable=""]'
].join(',')

interface TranslateBar {
  host: HTMLDivElement
  shadow: ShadowRoot
  wrap: HTMLDivElement
}

interface TranslationResponse {
  texts?: unknown
  provider?: unknown
  providerLabel?: unknown
  translatedCount?: unknown
  cachedCount?: unknown
  elapsedMs?: unknown
  error?: {
    code?: unknown
    message?: unknown
    failures?: Array<{ label?: unknown; message?: unknown }>
  }
}

const originals = new Map<Text, string>()
let bar: TranslateBar | null = null
let statusEl: HTMLSpanElement | null = null
let actionBtn: HTMLButtonElement | null = null
let languageSelect: HTMLSelectElement | null = null
let running = false
let translated = false
let lastTarget = 'zh'
let actionMode: 'toggle' | 'retry' = 'toggle'
let generation = 0
let dismissTimer: ReturnType<typeof setTimeout> | null = null

function isTopFrame(): boolean {
  try { return window.top === window } catch (_) { return false }
}

function detectSourceLanguage(): string {
  try {
    return normalizeLanguageTag(
      document.documentElement.lang ||
      document.body?.getAttribute('lang') ||
      ''
    ) || 'auto'
  } catch (_) {
    return 'auto'
  }
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    task.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

function ensureBar(): TranslateBar {
  if (bar?.host?.isConnected) return bar
  const host = document.createElement('div')
  host.id = 'hira-translate-bar'
  host.setAttribute('data-hira-ui', 'translate')
  host.style.cssText = 'all:initial;position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;'

  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    .hira-translate-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px 8px 16px;
      border-radius: var(--hira-theme-radius, 12px);
      font: 14px/1.5 ${uiFontVar()};
      color: var(--hira-text-primary, #1a1a1a);
      background: var(--hira-bg-surface, rgba(255, 255, 255, 0.98));
      box-shadow: 0 9px 28px rgba(0, 0, 0, 0.22);
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.12));
      -webkit-font-smoothing: antialiased;
    }
    .hira-translate-bar__status {
      max-width: min(60vw, 600px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-height: 38px;
      display: flex;
      align-items: center;
    }
    .hira-translate-bar__action,
    .hira-translate-bar__language,
    .hira-translate-bar__close {
      flex-shrink: 0;
      cursor: pointer;
      font: inherit;
      border-radius: var(--hira-radius-control, var(--hira-theme-radius, 9px));
      transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
    }
    .hira-translate-bar__action {
      min-height: 38px;
      padding: 0 16px;
      border: 1px solid var(--hira-accent-soft-strong, rgba(0, 0, 0, 0.16));
      background: var(--hira-accent-soft, transparent);
      color: var(--hira-accent, inherit);
      font-weight: 600;
      white-space: nowrap;
    }
    .hira-translate-bar__action:hover {
      border-color: var(--hira-accent, rgba(0, 0, 0, 0.28));
    }
    .hira-translate-bar__action:disabled { cursor: default; opacity: 0.55; }
    .hira-translate-bar__language {
      height: 38px;
      min-width: 138px;
      max-width: 166px;
      padding: 0 32px 0 12px;
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.14));
      background:
        linear-gradient(45deg, transparent 50%, var(--hira-text-secondary, #667085) 50%) calc(100% - 15px) 16px / 6px 6px no-repeat,
        linear-gradient(135deg, var(--hira-text-secondary, #667085) 50%, transparent 50%) calc(100% - 10px) 16px / 6px 6px no-repeat,
        var(--hira-bg-surface, rgba(255, 255, 255, 0.8));
      color: var(--hira-text-primary, inherit);
      appearance: none;
      cursor: pointer;
      font-weight: 550;
    }
    .hira-translate-bar__language:disabled { cursor: default; opacity: 0.55; }
    .hira-translate-bar__close {
      width: 38px;
      height: 38px;
      border: 0;
      background: transparent;
      color: var(--hira-text-secondary, inherit);
      font-size: 21px;
      line-height: 1;
    }
    .hira-translate-bar__close:hover {
      background: var(--hira-hover-bg, rgba(0, 0, 0, 0.06));
      color: var(--hira-text-primary, inherit);
    }
    .hira-translate-bar__action:focus-visible,
    .hira-translate-bar__language:focus-visible,
    .hira-translate-bar__close:focus-visible {
      outline: 2px solid var(--hira-accent, #3b82f6);
      outline-offset: 2px;
    }
    @media (max-width: 680px) {
      .hira-translate-bar {
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        width: calc(100vw - 24px);
        padding: 10px;
      }
      .hira-translate-bar__status {
        order: 1;
        width: 100%;
        max-width: none;
        justify-content: center;
      }
      .hira-translate-bar__language { order: 2; flex: 1; max-width: 210px; }
      .hira-translate-bar__action { order: 3; flex: 1; max-width: 160px; padding: 0 12px; }
      .hira-translate-bar__close { order: 4; }
    }
  `
  const wrap = document.createElement('div')
  wrap.className = 'hira-translate-bar'

  statusEl = document.createElement('span')
  statusEl.className = 'hira-translate-bar__status'
  statusEl.setAttribute('role', 'status')
  statusEl.setAttribute('aria-live', 'polite')
  statusEl.setAttribute('aria-atomic', 'true')
  statusEl.textContent = '正在准备翻译…'

  languageSelect = document.createElement('select')
  languageSelect.className = 'hira-translate-bar__language'
  languageSelect.setAttribute('aria-label', '翻译目标语言')
  for (const language of LANGUAGES) {
    const option = document.createElement('option')
    option.value = language.id
    option.textContent = language.label
    languageSelect.appendChild(option)
  }
  languageSelect.value = lastTarget
  languageSelect.onchange = () => {
    void switchTarget(languageSelect?.value || lastTarget).catch((error) => {
      console.warn('[translate] target switch failed:', error)
    })
  }

  actionBtn = document.createElement('button')
  actionBtn.type = 'button'
  actionBtn.className = 'hira-translate-bar__action'
  actionBtn.textContent = '显示原文'
  actionBtn.onclick = () => {
    if (actionMode === 'retry') {
      void translatePage(lastTarget).catch((error) => {
        console.warn('[translate] retry failed:', error)
      })
    } else if (translated) {
      restore()
    }
  }

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'hira-translate-bar__close'
  close.setAttribute('aria-label', '关闭翻译工具栏')
  close.textContent = '×'
  close.onclick = () => {
    generation += 1
    running = false
    if (translated) restore()
    else removeBar()
  }

  wrap.append(statusEl, languageSelect, actionBtn, close)
  shadow.append(style, wrap)
  ;(document.documentElement || document.body).appendChild(host)
  try { applyAccentVars(host) } catch (_) {}
  bindTheme()
  bar = { host, shadow, wrap }
  return bar
}

let themeBound = false
function bindTheme(): void {
  if (themeBound) return
  themeBound = true
  subscribeAccent((vars: Record<string, string>) => {
    const target = bar?.host
    if (!target) return
    for (const [key, value] of Object.entries(vars)) {
      try { target.style.setProperty(key, value) } catch (_) {}
    }
  })
}

function removeBar(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }
  try {
    if (bar?.host?.parentNode) bar.host.parentNode.removeChild(bar.host)
  } catch (_) {}
  bar = null
  statusEl = null
  actionBtn = null
  languageSelect = null
}

function setStatus(text: unknown): void {
  if (statusEl) statusEl.textContent = String(text)
}

function scheduleBarDismiss(delayMs: number): void {
  if (dismissTimer) clearTimeout(dismissTimer)
  dismissTimer = setTimeout(() => {
    dismissTimer = null
    if (!translated && !running) removeBar()
  }, delayMs)
}

function setAction(mode: 'toggle' | 'retry', label: string, disabled = false): void {
  actionMode = mode
  if (!actionBtn) return
  actionBtn.textContent = label
  actionBtn.disabled = disabled
  actionBtn.style.opacity = disabled ? '0.55' : '1'
}

interface TextEntry {
  node: Text
  score: number
}

function visibleTextEntry(node: Text): TextEntry | null {
  const parent = node.parentElement
  if (!parent) return null
  if (parent.closest(SKIP_SELECTOR)) return null
  if (parent.isContentEditable) return null

  const checkVisibility = (parent as HTMLElement & {
    checkVisibility?: (options?: {
      checkOpacity?: boolean
      checkVisibilityCSS?: boolean
      contentVisibilityAuto?: boolean
      opacityProperty?: boolean
      visibilityProperty?: boolean
    }) => boolean
  }).checkVisibility
  if (typeof checkVisibility === 'function') {
    try {
      if (!checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: false,
        visibilityProperty: true
      })) return null
    } catch (_) {}
  } else if (parent.getClientRects().length === 0) {
    return null
  }

  const rect = parent.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const score = rect.bottom < 0
    ? rect.bottom
    : rect.top <= window.innerHeight
      ? rect.top
      : window.innerHeight + rect.top
  return { node, score }
}

function collectTextNodes(targetLang: string, sourceLang: string): Text[] {
  const root = document.body
  if (!root) return []
  const entries: TextEntry[] = []
  const visitedRoots = new Set<Node>()

  function visitTree(scope: Node, depth: number): void {
    if (entries.length >= TRANSLATE_LIMITS.maxTexts || depth > 8 || visitedRoots.has(scope)) return
    visitedRoots.add(scope)
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && entries.length < TRANSLATE_LIMITS.maxTexts) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const shadow = (node as Element).shadowRoot
        if (shadow) visitTree(shadow, depth + 1)
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || ''
        if (!shouldSkipText(text, targetLang, sourceLang)) {
          const entry = visibleTextEntry(node as Text)
          if (entry) entries.push(entry)
        }
      }
      node = walker.nextNode()
    }
  }

  visitTree(root, 0)
  // 每个节点只读取一次布局，避免排序比较器重复触发布局抖动。
  entries.sort((left, right) => left.score - right.score)
  return entries.map((entry) => entry.node)
}

function preserveOuterWhitespace(original: string, translated: string): string {
  const leading = original.match(/^\s*/)?.[0] || ''
  const trailing = original.match(/\s*$/)?.[0] || ''
  const core = translated.trim()
  if (!core) return original
  return `${leading}${core}${trailing}`
}

async function applyBatch(nodes: Text[], indices: number[], translations: string[]): Promise<number> {
  let changed = 0
  for (let offset = 0; offset < indices.length; offset += 1) {
    const nodeIndex = indices[offset]
    const node = nodes[nodeIndex]
    const translatedText = translations[offset]
    if (node?.isConnected && typeof translatedText === 'string' && translatedText) {
      const current = node.nodeValue || ''
      const next = preserveOuterWhitespace(current, translatedText)
      if (next && next !== current) {
        if (!originals.has(node)) originals.set(node, current)
        try {
          node.nodeValue = next
          changed += 1
        } catch (_) {}
      }
    }
    if ((offset + 1) % DOM_WRITE_CHUNK === 0) await yieldToPage()
  }
  return changed
}

function responseError(response: TranslationResponse): string {
  const message = String(response.error?.message || '翻译服务不可用')
  const failed = response.error?.failures
    ?.map((failure) => String(failure.message || ''))
    .filter(Boolean)
    .slice(0, 2)
  return failed?.length ? `${message}（${failed.join('；')}）` : message
}

function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> }
  }).scheduler
  if (scheduler && typeof scheduler.yield === 'function') return scheduler.yield()
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      resolve()
    }
    requestAnimationFrame(finish)
    // 后台标签会暂停 rAF；有限兜底避免翻译永远不开始。
    timer = setTimeout(finish, 50)
  })
}

async function switchTarget(to: string): Promise<void> {
  if (!LANGUAGES.some((language) => language.id === to)) throw new Error('不支持的翻译目标语言')
  const previous = lastTarget
  if (languageSelect) languageSelect.disabled = true
  setStatus('正在切换翻译语言…')
  try {
    const response = await withTimeout(
      ipcRenderer.invoke(`ngipc:invoke:${TARGET_ROUTE}`, { to }) as Promise<{ to?: unknown }>,
      TARGET_TIMEOUT_MS,
      '保存翻译目标语言超时'
    )
    const saved = String(response?.to || to)
    generation += 1
    running = false
    if (originals.size > 0) restore()
    lastTarget = saved
    await translatePage(saved)
  } catch (error) {
    lastTarget = previous
    if (languageSelect?.isConnected) languageSelect.value = previous
    setStatus(`切换语言失败：${error instanceof Error ? error.message : '未知错误'}`)
    setAction('retry', '重试')
  } finally {
    if (languageSelect?.isConnected) languageSelect.disabled = false
  }
}

async function translatePage(to: string): Promise<void> {
  if (running) return
  if (translated) restore()
  if (dismissTimer) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }

  const runToken = ++generation
  running = true
  translated = false
  lastTarget = to || 'zh'
  ensureBar()
  if (languageSelect && languageSelect.value !== lastTarget) languageSelect.value = lastTarget
  setAction('toggle', '显示原文', true)
  setStatus('正在识别页面文本…')
  const startedAt = Date.now()
  const deadlineAt = Date.now() + TOTAL_TIMEOUT_MS

  try {
    await nextPaint()
    if (runToken !== generation) return
    const source = detectSourceLanguage()
    const nodes = collectTextNodes(lastTarget, source)
    if (nodes.length === 0) {
      setStatus('没有需要翻译的文本')
      setAction('retry', '重试')
      running = false
      scheduleBarDismiss(1_400)
      return
    }

    const texts = nodes.map((node) => node.nodeValue || '')
    const batches = batchByChars(texts)
    let done = 0
    let changed = 0
    let providerLabel = ''
    let batchCursor = 0
    let fatalError: Error | null = null

    const translateWorker = async (): Promise<void> => {
      while (!fatalError && batchCursor < batches.length) {
        if (runToken !== generation) return
        if (Date.now() >= deadlineAt) throw new Error('翻译超过总时限，已停止等待')
        const batchIndex = batchCursor++
        const indices = batches[batchIndex]
        const payload = {
          texts: indices.map((index) => texts[index]),
          from: source,
          to: lastTarget,
          force: true
        }
        try {
          const response = await withTimeout(
            ipcRenderer.invoke(`ngipc:invoke:${ROUTE}`, payload) as Promise<TranslationResponse>,
            Math.min(BATCH_TIMEOUT_MS, Math.max(1_000, deadlineAt - Date.now())),
            '本批翻译超时'
          )
          if (runToken !== generation) return
          const translations = Array.isArray(response?.texts)
            ? response.texts.map((text) => String(text ?? ''))
            : []
          if (translations.length !== indices.length) throw new Error('翻译结果数量不一致')
          if (response?.error) throw new Error(responseError(response))

          changed += await applyBatch(nodes, indices, translations)
          if (response?.providerLabel) providerLabel = String(response.providerLabel)
          done += indices.length
          setStatus(`正在翻译 ${done} / ${texts.length}`)
        } catch (error) {
          fatalError = error instanceof Error ? error : new Error(String(error))
          return
        }
      }
    }

    const workerCount = Math.min(MAX_PARALLEL_BATCHES, batches.length)
    await Promise.all(Array.from({ length: workerCount }, () => translateWorker()))
    if (runToken !== generation) return
    if (fatalError) throw fatalError

    translated = originals.size > 0
    if (translated) {
      const elapsed = ((Date.now() - startedAt) / 1_000).toFixed(1)
      setStatus(`已翻译 ${changed} 段${providerLabel ? ` · ${providerLabel}` : ''} · ${elapsed}s`)
      setAction('toggle', '显示原文')
    } else {
      setStatus('页面内容已经是目标语言')
      setAction('retry', '重试')
      scheduleBarDismiss(1_600)
    }
  } catch (error) {
    if (runToken !== generation) return
    translated = originals.size > 0
    const message = error instanceof Error ? error.message : '未知错误'
    setStatus(translated ? `翻译未完成：${message}` : `翻译失败：${message}`)
    setAction(translated ? 'toggle' : 'retry', translated ? '显示原文' : '重试')
  } finally {
    if (runToken === generation) running = false
  }
}

function restore(): void {
  for (const [node, text] of originals) {
    try {
      if (node.isConnected) node.nodeValue = text
    } catch (_) {}
  }
  originals.clear()
  translated = false
  removeBar()
}

try {
  if (isTopFrame()) {
    ipcRenderer.on(EVENT_CHANNEL, (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const record = payload && typeof payload === 'object' ? payload as { to?: unknown } : null
      const to = String(record?.to || 'zh')
      if (translated) {
        restore()
        return
      }
      void translatePage(to).catch((error) => {
        console.warn('[translate] page translation failed:', error)
      })
    })
  }
} catch (_) {}
