/** 页面翻译 UI 与 IPC 宿主；DOM 扫描、可见性和动态内容由 dom-session 独立管理。 */

import { ipcRenderer } from 'electron'
import {
  LANGUAGES,
  normalizeLanguageTag
} from '@hira-ng/shared-types/src/translate'
import { PRELOAD_EVENTS, PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
import type { TranslatePageContext } from '@hira-ng/shared-types/src/translate-plugin'
import { uiFontVar } from '@hira-ng/shared-types/src/font-stack'
import { applyAccentVars, subscribeAccent } from '../theme-accent.js'
import { createDomTranslationSession, type DomTranslationSession } from './dom-session.js'

const ROUTE = PRELOAD_ROUTES.translateText
const PAGE_CONTEXT_ROUTE = PRELOAD_ROUTES.translatePageContext
const TARGET_ROUTE = PRELOAD_ROUTES.translateTarget
const EVENT_CHANNEL = `ngipc:event:${PRELOAD_EVENTS.translatePage}`
const BATCH_TIMEOUT_MS = 22_000
const PAGE_CONTEXT_TIMEOUT_MS = 1_200
const PAGE_CONTEXT_CACHE_MS = 30_000
const TARGET_TIMEOUT_MS = 3_000
const SAMPLE_SKIP_SELECTOR = 'script,style,noscript,template,svg,canvas,code,pre'

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
let session: DomTranslationSession | null = null
let sessionTarget = ''
let providerLabel = ''
let pageContextCache: {
  key: string
  at: number
  task: Promise<TranslatePageContext | null>
} | null = null

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

function pageTextSample(limit = 4_000): string {
  const root = document.body
  if (!root) return ''
  const parts: string[] = []
  let length = 0
  let visited = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && length < limit && visited < 6_000) {
    visited += 1
    const parent = node.parentElement
    const value = (node.nodeValue || '').replace(/\s+/g, ' ').trim()
    if (value && !parent?.closest(SAMPLE_SKIP_SELECTOR)) {
      parts.push(value)
      length += value.length + 1
    }
    node = walker.nextNode()
  }
  return parts.join(' ').slice(0, limit)
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
  host.style.cssText = 'all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;'

  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    .hira-translate-bar {
      display: flex;
      align-items: center;
      width: min(520px, calc(100vw - 24px));
      box-sizing: border-box;
      gap: 7px;
      padding: 5px 6px 5px 9px;
      border-radius: var(--hira-theme-radius, 12px);
      font: 13px/1.45 ${uiFontVar()};
      color: var(--hira-text-primary, #1a1a1a);
      background: var(--hira-bg-surface, rgba(255, 255, 255, 0.98));
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.12));
      -webkit-font-smoothing: antialiased;
    }
    .hira-translate-bar__status {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-height: 32px;
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
      min-width: 82px;
      min-height: 32px;
      padding: 0 11px;
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
      height: 32px;
      width: 118px;
      flex: 0 0 118px;
      padding: 0 28px 0 9px;
      border: 1px solid var(--hira-border-subtle, rgba(0, 0, 0, 0.14));
      background:
        linear-gradient(45deg, transparent 50%, var(--hira-text-secondary, #667085) 50%) calc(100% - 13px) 12px / 5px 5px no-repeat,
        linear-gradient(135deg, var(--hira-text-secondary, #667085) 50%, transparent 50%) calc(100% - 8px) 12px / 5px 5px no-repeat,
        var(--hira-bg-surface, rgba(255, 255, 255, 0.8));
      color: var(--hira-text-primary, inherit);
      appearance: none;
      cursor: pointer;
      font-weight: 550;
    }
    .hira-translate-bar__language:disabled { cursor: default; opacity: 0.55; }
    .hira-translate-bar__close {
      width: 32px;
      height: 32px;
      border: 0;
      background: transparent;
      color: var(--hira-text-secondary, inherit);
      font-size: 18px;
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
        width: min(520px, calc(100vw - 24px));
        padding: 7px;
      }
      .hira-translate-bar__status {
        order: 1;
        width: 100%;
        max-width: none;
        justify-content: center;
      }
      .hira-translate-bar__language { order: 2; width: 128px; flex: 0 0 128px; }
      .hira-translate-bar__action { order: 3; flex: 1; max-width: 150px; padding: 0 10px; }
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
      void translatePage(lastTarget, true).catch((error) => {
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
    session?.pause()
    running = false
    translated = (session?.translatedCount() || 0) > 0
    removeBar()
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

function responseError(response: TranslationResponse): string {
  const message = String(response.error?.message || '翻译服务不可用')
  const failed = response.error?.failures
    ?.map((failure) => String(failure.message || ''))
    .filter(Boolean)
    .slice(0, 2)
  return failed?.length ? `${message}（${failed.join('；')}）` : message
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
    if (session) restore()
    lastTarget = saved
    await translatePage(saved, true)
  } catch (error) {
    lastTarget = previous
    if (languageSelect?.isConnected) languageSelect.value = previous
    setStatus(`切换语言失败：${error instanceof Error ? error.message : '未知错误'}`)
    setAction('retry', '重试')
  } finally {
    if (languageSelect?.isConnected) languageSelect.disabled = false
  }
}

async function requestBatch(
  texts: string[],
  source: string,
  target: string,
  runToken: number,
  probeProviders: boolean
): Promise<{ texts: string[]; providerLabel: string }> {
  if (runToken !== generation) throw new DOMException('翻译已取消', 'AbortError')
  const response = await withTimeout(
    ipcRenderer.invoke(`ngipc:invoke:${ROUTE}`, {
      texts,
      from: source,
      to: target,
      url: location.href,
      ...(probeProviders ? { force: true } : {})
    }) as Promise<TranslationResponse>,
    BATCH_TIMEOUT_MS,
    '本批翻译超时'
  )
  if (runToken !== generation) throw new DOMException('翻译已取消', 'AbortError')
  if (!Array.isArray(response?.texts) || response.texts.length !== texts.length) {
    throw new Error('翻译结果数量不一致')
  }
  if (response.error) throw new Error(responseError(response))
  return {
    texts: response.texts.map((text) => String(text ?? '')),
    providerLabel: String(response.providerLabel || '')
  }
}

async function requestPageContext(runToken: number): Promise<TranslatePageContext | null> {
  if (runToken !== generation) return null
  const key = `${location.href}\u0000${document.title}\u0000${document.documentElement.lang || ''}`
  const cached = pageContextCache
  let task: Promise<TranslatePageContext | null>
  if (cached && cached.key === key && Date.now() - cached.at < PAGE_CONTEXT_CACHE_MS) {
    task = cached.task
  } else {
    const nextTask = withTimeout(
      ipcRenderer.invoke(`ngipc:invoke:${PAGE_CONTEXT_ROUTE}`, {
        url: location.href,
        title: document.title,
        documentLanguage: document.documentElement.lang || undefined,
        textSample: pageTextSample()
      }) as Promise<TranslatePageContext>,
      PAGE_CONTEXT_TIMEOUT_MS,
      '读取翻译插件配置超时'
    ).then((response) => response && typeof response === 'object' ? response : null)
      .catch((error) => {
        if (pageContextCache?.task === nextTask) pageContextCache = null
        throw error
      })
    task = nextTask
    pageContextCache = { key, at: Date.now(), task: nextTask }
  }
  const response = await task
  if (runToken !== generation) return null
  return response
}

async function translatePage(to: string, probeProviders = false): Promise<void> {
  const target = to || 'zh'
  if (session && sessionTarget === target) {
    if (probeProviders) {
      session.restore()
      session = null
    } else {
      session.resume()
      ensureBar()
      setStatus(translated ? `已翻译为${LANGUAGES.find((language) => language.id === target)?.label || target}` : '正在继续翻译可见内容…')
      if (translated) setAction('toggle', '显示原文')
      return
    }
  }
  if (session) session.restore()
  session = null
  if (dismissTimer) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }

  const runToken = ++generation
  running = true
  translated = false
  providerLabel = ''
  lastTarget = target
  sessionTarget = target
  ensureBar()
  if (languageSelect && languageSelect.value !== target) languageSelect.value = target
  setAction('toggle', '显示原文', true)
  setStatus('正在识别页面语言…')

  let pageContext: TranslatePageContext | null = null
  try {
    pageContext = await requestPageContext(runToken)
  } catch (_) {}
  if (runToken !== generation) return

  let idleHandled = false
  const source = normalizeLanguageTag(pageContext?.sourceLanguage || '') ||
    detectSourceLanguage()
  const policy = pageContext?.policy || {}
  setStatus('正在识别并翻译可见内容…')
  let probeRemaining = probeProviders

  const currentSession = createDomTranslationSession({
    from: source,
    to: target,
    policy,
    translateBatch: (texts) => {
      const probe = probeRemaining
      probeRemaining = false
      return requestBatch(texts, source, target, runToken, probe)
    },
    onProgress: (progress) => {
      if (runToken !== generation) return
      running = progress.scanning || progress.pendingCount > 0
      translated = progress.translatedCount > 0
      if (progress.providerLabel) providerLabel = progress.providerLabel
      if (translated) {
        setAction('toggle', '显示原文')
        setStatus(running
          ? `已翻译 ${progress.translatedCount} 段 · 正在继续翻译…`
          : `已翻译 ${progress.translatedCount} 段${providerLabel ? ` · ${providerLabel}` : ''} · 滚动自动翻译`)
      } else if (running) {
        setStatus('正在识别并翻译可见内容…')
      } else if (!idleHandled) {
        idleHandled = true
        setStatus('页面内容已经是目标语言')
        setAction('retry', '重试')
        scheduleBarDismiss(1_600)
      }
    },
    onError: (error) => {
      if (runToken !== generation) return
      setStatus(`翻译暂时失败，正在重试：${error.message}`)
      setAction(translated ? 'toggle' : 'retry', translated ? '显示原文' : '重试')
    }
  })
  session = currentSession
  void nextPaint().then(() => {
    if (runToken === generation) currentSession.start()
  })
}

function restore(): void {
  generation += 1
  session?.restore()
  session = null
  sessionTarget = ''
  translated = false
  running = false
  providerLabel = ''
  removeBar()
}

try {
  if (isTopFrame()) {
    ipcRenderer.on(EVENT_CHANNEL, (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const record = payload && typeof payload === 'object' ? payload as { to?: unknown } : null
      const to = String(record?.to || 'zh')
      if (translated) {
        if (to !== lastTarget) {
          restore()
          void translatePage(to, true).catch((error) => {
            console.warn('[translate] page translation failed:', error)
          })
          return
        }
        ensureBar()
        session?.resume()
        setStatus(`已翻译为${LANGUAGES.find((language) => language.id === lastTarget)?.label || lastTarget}`)
        setAction('toggle', '显示原文')
        return
      }
      void translatePage(to, true).catch((error) => {
        console.warn('[translate] page translation failed:', error)
      })
    })
  }
} catch (_) {}
