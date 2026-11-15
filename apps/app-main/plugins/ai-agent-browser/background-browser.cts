/**
 * Hira Agent CLI · 后台浏览器。
 *
 * 每个逻辑会话拥有一只隐藏 BrowserWindow，复用当前 profile 的 Session：
 * 登录态、Cookie、代理和站点权限与用户可见标签一致，但窗口从不 show/focus，
 * 也不注册进标签条。页面脚本只通过隔离世界执行，避免站点改写隔离变量。
 */

const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const { BrowserWindow } = require('electron')
const { readPage, capturePage } = require('../ai/core/page.cjs')

import type { BrowserWindow as BrowserWindowType, Session, WebContents } from 'electron'

interface BrowserContext {
  id: string
  aiSessionId: string | null
  kind: 'ai' | 'external'
  win: BrowserWindowType
  wc: WebContents
  createdAt: number
  lastUsedAt: number
  title: string
  url: string
  operation: Promise<void>
  pending: number
}

interface BackgroundBrowserDeps {
  getSession(): Session
  userDataPath: string
  logger?: Pick<Console, 'warn' | 'info' | 'error'>
}

interface OpenInput {
  context?: unknown
  aiSessionId?: unknown
  url: unknown
  timeoutMs?: unknown
}

interface ReadInput {
  context?: unknown
  aiSessionId?: unknown
  url?: unknown
  maxChars?: unknown
  maxLinks?: unknown
  timeoutMs?: unknown
}

interface ReadManyInput extends Omit<ReadInput, 'url'> {
  urls: unknown
}

interface ActionInput {
  context?: unknown
  aiSessionId?: unknown
  allowActions?: unknown
}

interface ClickInput extends ActionInput {
  selector?: unknown
  text?: unknown
}

interface FillInput extends ActionInput {
  selector: unknown
  text: unknown
  submit?: unknown
}

interface ScrollInput extends Omit<ReadInput, 'url' | 'timeoutMs'> {
  direction?: unknown
  amount?: unknown
}

interface ScreenshotInput extends Omit<ReadInput, 'url' | 'maxChars' | 'maxLinks' | 'timeoutMs'> {
  url?: unknown
  fullPage?: unknown
}

const CONTEXT_ID = /^[a-zA-Z0-9:_-]{1,96}$/
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 90_000
const IDLE_TTL_MS = 30 * 60_000
const MAX_READ_MANY = 12
const MAX_CONTEXTS = 16
const WORLD_ID = 999

function errorWithCode(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function contextId(value: unknown): string {
  const id = String(value || 'default').trim() || 'default'
  if (!CONTEXT_ID.test(id)) throw errorWithCode('CLI_BAD_CONTEXT', 'context 只能包含字母、数字、冒号、下划线与短横线')
  return id
}

function aiContextId(aiSessionId: unknown): string {
  const id = String(aiSessionId || '').trim()
  if (!id) throw errorWithCode('CLI_NO_SESSION', '缺少 AI 会话 id')
  return contextId(`ai:${id}`)
}

function httpUrl(value: unknown): string {
  let url: URL
  try {
    url = new URL(String(value || '').trim())
  } catch (_) {
    throw errorWithCode('CLI_BAD_URL', '需要完整的 http/https 地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw errorWithCode('CLI_BAD_URL', '后台浏览器只允许 http/https 地址')
  }
  if (url.username || url.password) throw errorWithCode('CLI_BAD_URL', 'URL 不能内嵌用户名或密码')
  return url.toString()
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const timer = setTimeout(() => {
      try { onTimeout?.() } catch (_) {}
      done(() => reject(errorWithCode(code, message)))
    }, timeoutMs)
    try { timer.unref?.() } catch (_) {}
    promise.then(
      (value) => done(() => resolve(value)),
      (error) => done(() => reject(error))
    ).finally(() => clearTimeout(timer))
  })
}

function contextView(ctx: BrowserContext) {
  return {
    context: ctx.id,
    aiSessionId: ctx.aiSessionId,
    kind: ctx.kind,
    title: ctx.title,
    url: ctx.url,
    createdAt: ctx.createdAt,
    lastUsedAt: ctx.lastUsedAt
  }
}

function createBackgroundBrowser({ getSession, userDataPath, logger = console }: BackgroundBrowserDeps) {
  const contexts = new Map<string, BrowserContext>()
  const artifactDir = path.join(userDataPath, 'cli', 'artifacts')

  function isAlive(ctx: BrowserContext | null | undefined): ctx is BrowserContext {
    return !!ctx && !ctx.win.isDestroyed() && !ctx.wc.isDestroyed()
  }

  function touch(ctx: BrowserContext): void {
    ctx.lastUsedAt = Date.now()
    try { ctx.title = ctx.win.getTitle() || ctx.title } catch (_) {}
    try { ctx.url = ctx.wc.getURL() || ctx.url } catch (_) {}
  }

  function close(id: string): boolean {
    const ctx = contexts.get(id)
    if (!ctx) return false
    contexts.delete(id)
    try { if (!ctx.win.isDestroyed()) ctx.win.destroy() } catch (_) {}
    return true
  }

  function create(id: string, aiSessionId: string | null, kind: 'ai' | 'external'): BrowserContext {
    for (const [key, current] of contexts) {
      if (!isAlive(current)) contexts.delete(key)
    }
    if (contexts.size >= MAX_CONTEXTS) {
      throw errorWithCode('CLI_TOO_MANY_CONTEXTS', `后台上下文已达到 ${MAX_CONTEXTS} 个；先关闭不再使用的上下文`)
    }
    const session = getSession()
    if (!session) throw errorWithCode('CLI_NO_PROFILE', '当前 profile 的浏览器会话不可用')
    const win = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 1280,
      height: 900,
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
        backgroundThrottling: false
      }
    })
    const wc = win.webContents
    try { wc.setBackgroundThrottling(false) } catch (_) {}
    try { wc.setAudioMuted(true) } catch (_) {}

    wc.setWindowOpenHandler(({ url }: { url: string }) => {
      if (/^https?:\/\//i.test(url)) {
        setImmediate(() => {
          if (!wc.isDestroyed()) wc.loadURL(url).catch((error: unknown) => {
            logger.warn?.('[hira-cli] popup navigation failed:', error instanceof Error ? error.message : String(error))
          })
        })
      }
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event: Electron.Event, url: string) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault()
    })
    wc.on('will-attach-webview', (event: Electron.Event) => event.preventDefault())

    const now = Date.now()
    const ctx: BrowserContext = {
      id,
      aiSessionId,
      kind,
      win,
      wc,
      createdAt: now,
      lastUsedAt: now,
      title: '',
      url: '',
      operation: Promise.resolve(),
      pending: 0
    }
    contexts.set(id, ctx)
    wc.once('destroyed', () => {
      if (contexts.get(id) === ctx) contexts.delete(id)
    })
    logger.info?.(`[hira-cli] background context ready: ${id}`)
    return ctx
  }

  function ensure(rawId: unknown, rawAiSessionId?: unknown): BrowserContext {
    const id = contextId(rawId)
    const current = contexts.get(id)
    if (isAlive(current)) {
      touch(current)
      return current
    }
    if (current) contexts.delete(id)
    const aiSessionId = rawAiSessionId == null ? null : String(rawAiSessionId || '') || null
    return create(id, aiSessionId, aiSessionId ? 'ai' : 'external')
  }

  function contextFor(input: { context?: unknown; aiSessionId?: unknown }): BrowserContext {
    if (input && input.aiSessionId) return ensure(aiContextId(input.aiSessionId), input.aiSessionId)
    return ensure(input && input.context, null)
  }

  async function exclusive<T>(ctx: BrowserContext, task: () => Promise<T>): Promise<T> {
    if (ctx.pending >= 8) throw errorWithCode('CLI_CONTEXT_BUSY', '同一后台上下文排队操作过多，请稍后重试')
    ctx.pending += 1
    const previous = ctx.operation.catch(() => {})
    let release!: () => void
    ctx.operation = new Promise<void>((resolve) => { release = resolve })
    try {
      await previous
      if (!isAlive(ctx)) throw errorWithCode('CLI_CONTEXT_CLOSED', '后台上下文已关闭')
      return await task()
    } finally {
      ctx.pending = Math.max(0, ctx.pending - 1)
      release()
    }
  }

  function assertLoaded(ctx: BrowserContext): void {
    let url = ''
    try { url = String(ctx.wc.getURL() || '') } catch (_) {}
    if (!/^https?:\/\//i.test(url)) {
      throw errorWithCode('CLI_NO_PAGE', '该后台上下文还没有打开网页；先运行 open 或给 read 传入网址')
    }
  }

  function waitForLoad(ctx: BrowserContext, url: string, timeoutMs?: unknown): Promise<void> {
    const timeout = boundedInt(timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.wc.removeListener('did-finish-load', onFinish)
        ctx.wc.removeListener('did-fail-load', onFail)
        ctx.wc.removeListener('render-process-gone', onGone)
        ctx.wc.removeListener('destroyed', onDestroyed)
        if (error) reject(error)
        else {
          touch(ctx)
          resolve()
        }
      }
      const onFinish = () => finish()
      const onFail = (
        _event: Electron.Event,
        code: number,
        description: string,
        failedUrl: string,
        isMainFrame: boolean
      ) => {
        if (!isMainFrame) return
        // Redirects and a newer navigation supersede the old request with -3.
        if (code === -3) return
        finish(errorWithCode('CLI_NAVIGATION_FAILED', `打开页面失败（${code}）：${description || failedUrl}`))
      }
      const onGone = () => finish(errorWithCode('CLI_RENDERER_GONE', '后台页面渲染进程已退出'))
      const onDestroyed = () => finish(errorWithCode('CLI_CONTEXT_CLOSED', '后台上下文在加载期间已关闭'))
      const timer = setTimeout(() => {
        finish(errorWithCode('CLI_NAVIGATION_TIMEOUT', `页面加载超过 ${timeout}ms`))
      }, timeout)
      try { timer.unref?.() } catch (_) {}
      ctx.wc.once('did-finish-load', onFinish)
      ctx.wc.on('did-fail-load', onFail)
      ctx.wc.once('render-process-gone', onGone)
      ctx.wc.once('destroyed', onDestroyed)
      ctx.wc.loadURL(url).catch((error: unknown) => finish(error))
    })
  }

  async function waitUntilIdle(ctx: BrowserContext, timeoutMs = 2_000): Promise<void> {
    // 点击后的导航事件通常晚一拍才开始；先让出一次事件循环再判断 isLoading，
    // 否则会在 loadURL 尚未启动时立刻返回旧 URL。
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (!ctx.wc.isLoading()) {
      return
    }
    if (ctx.wc.isDestroyed()) return
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        ctx.wc.removeListener('did-stop-loading', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      try { timer.unref?.() } catch (_) {}
      ctx.wc.once('did-stop-loading', finish)
    })
  }

  async function openUnlocked(ctx: BrowserContext, input: OpenInput) {
    const url = httpUrl(input.url)
    await waitForLoad(ctx, url, input.timeoutMs)
    return { ok: true, ...contextView(ctx) }
  }

  async function open(input: OpenInput) {
    const ctx = contextFor(input)
    return exclusive(ctx, () => openUnlocked(ctx, input))
  }

  async function readUnlocked(ctx: BrowserContext, input: ReadInput) {
    if (input.url) await waitForLoad(ctx, httpUrl(input.url), input.timeoutMs)
    assertLoaded(ctx)
    const snapshot = await withDeadline(
      readPage(ctx.wc, { maxChars: input.maxChars, maxLinks: input.maxLinks }) as Promise<Record<string, unknown>>,
      20_000,
      'CLI_READ_TIMEOUT',
      '页面读取超过 20 秒',
      () => close(ctx.id)
    )
    touch(ctx)
    return {
      ok: true,
      context: ctx.id,
      ...snapshot,
      sources: [{ title: snapshot.title || snapshot.url, url: snapshot.url, kind: 'background-page' }]
    }
  }

  async function read(input: ReadInput) {
    const ctx = contextFor(input)
    return exclusive(ctx, () => readUnlocked(ctx, input))
  }

  async function readMany(input: ReadManyInput) {
    const urls = (Array.isArray(input.urls) ? input.urls : [])
      .map((url) => String(url || '').trim())
      .filter(Boolean)
      .slice(0, MAX_READ_MANY)
    if (!urls.length) throw errorWithCode('CLI_BAD_ARGS', '至少提供一个网址')
    const ctx = contextFor(input)
    return exclusive(ctx, async () => {
      const items: Array<Record<string, unknown>> = []
      for (const url of urls) {
        try {
          items.push(await readUnlocked(ctx, { ...input, url }))
        } catch (error) {
          items.push({
            ok: false,
            url,
            error: error instanceof Error ? error.message : String(error),
            code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'CLI_READ_FAILED'
          })
        }
      }
      const sources = items
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && item.ok === true)
        .map((item) => ({ title: String(item.title || item.url || ''), url: String(item.url || ''), kind: 'background-page' }))
      return { ok: true, count: items.length, items, sources }
    })
  }

  async function search(input: ReadInput & { query: unknown; engine?: unknown }) {
    const query = String(input.query || '').trim()
    if (!query) throw errorWithCode('CLI_BAD_ARGS', '搜索词不能为空')
    const template = String(input.engine || 'https://www.bing.com/search?q={query}')
    if (!template.includes('{query}')) throw errorWithCode('CLI_BAD_ARGS', '搜索地址模板必须包含 {query}')
    const url = httpUrl(template.replace('{query}', encodeURIComponent(query)))
    const ctx = contextFor(input)
    return exclusive(ctx, async () => {
      const opened = await openUnlocked(ctx, { ...input, url })
      const page = await readUnlocked(ctx, { ...input, url: undefined })
      return { ...opened, ...page, ok: true, query, context: opened.context }
    })
  }

  async function click(input: ClickInput) {
    if (input.allowActions !== true) {
      throw errorWithCode('CLI_ACTION_NOT_AUTHORIZED', '点击属于写操作；确认用户意图后加 --allow-actions')
    }
    const ctx = contextFor(input)
    assertLoaded(ctx)
    const selector = String(input.selector || '').trim()
    const text = String(input.text || '').replace(/\s+/g, ' ').trim()
    if (!selector && !text) throw errorWithCode('CLI_BAD_ARGS', 'selector 与 text 至少提供一个')
    const code = `(() => {
      const selector = ${JSON.stringify(selector)};
      const needle = ${JSON.stringify(text)};
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      let el = selector ? document.querySelector(selector) : null;
      if (!el && needle) {
        const nodes = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"],summary,label'));
        const exact = nodes.find((node) => visible(node) && (node.textContent || node.value || '').replace(/\\s+/g, ' ').trim() === needle);
        const partial = nodes.find((node) => visible(node) && (node.textContent || node.value || '').replace(/\\s+/g, ' ').trim().includes(needle));
        el = exact || partial || null;
      }
      if (!el) return { ok: false, reason: 'not-found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return {
        ok: true,
        tag: el.tagName,
        text: String(el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
      };
    })()`
    return exclusive(ctx, async () => {
      const result = await withDeadline(
        ctx.wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]),
        8_000,
        'CLI_ACTION_TIMEOUT',
        '页面点击超过 8 秒',
        () => close(ctx.id)
      )
      touch(ctx)
      if (result && result.ok) await waitUntilIdle(ctx)
      return { ...result, context: ctx.id, url: ctx.wc.getURL(), title: ctx.win.getTitle() }
    })
  }

  async function fill(input: FillInput) {
    if (input.allowActions !== true) {
      throw errorWithCode('CLI_ACTION_NOT_AUTHORIZED', '填写属于写操作；确认用户意图后加 --allow-actions')
    }
    const ctx = contextFor(input)
    assertLoaded(ctx)
    const selector = String(input.selector || '').trim()
    if (!selector) throw errorWithCode('CLI_BAD_ARGS', 'selector 不能为空')
    const text = String(input.text == null ? '' : input.text)
    const submit = input.submit === true
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not-found' };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = ${JSON.stringify(text)};
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
      } else {
        return { ok: false, reason: 'not-editable', tag: el.tagName };
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (${submit ? 'true' : 'false'}) {
        if (el.form && typeof el.form.requestSubmit === 'function') {
          el.form.requestSubmit();
        } else {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        }
      }
      return { ok: true, tag: el.tagName, submitted: ${submit ? 'true' : 'false'} };
    })()`
    return exclusive(ctx, async () => {
      const result = await withDeadline(
        ctx.wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]),
        8_000,
        'CLI_ACTION_TIMEOUT',
        '页面填写超过 8 秒',
        () => close(ctx.id)
      )
      touch(ctx)
      if (result && result.ok && submit) await waitUntilIdle(ctx, 3_000)
      return { ...result, context: ctx.id, url: ctx.wc.getURL(), title: ctx.win.getTitle() }
    })
  }

  async function scroll(input: ScrollInput) {
    const ctx = contextFor(input)
    assertLoaded(ctx)
    const direction = ['up', 'down', 'top', 'bottom'].includes(String(input.direction))
      ? String(input.direction)
      : 'down'
    const amount = boundedInt(input.amount, 0, 0, 100_000)
    const code = `(() => {
      const direction = ${JSON.stringify(direction)};
      const amount = ${amount};
      const step = amount > 0 ? amount : Math.round(innerHeight * 0.9);
      if (direction === 'top') scrollTo({ top: 0, behavior: 'smooth' });
      else if (direction === 'bottom') scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      else scrollBy({ top: direction === 'up' ? -step : step, behavior: 'smooth' });
      return { x: scrollX, y: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight };
    })()`
    return exclusive(ctx, async () => {
      const result = await withDeadline(
        ctx.wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]),
        8_000,
        'CLI_ACTION_TIMEOUT',
        '页面滚动超过 8 秒',
        () => close(ctx.id)
      )
      touch(ctx)
      return { ok: true, context: ctx.id, ...result }
    })
  }

  async function screenshot(input: ScreenshotInput) {
    const ctx = contextFor(input)
    return exclusive(ctx, async () => {
      if (input.url) await waitForLoad(ctx, httpUrl(input.url), DEFAULT_TIMEOUT_MS)
      assertLoaded(ctx)
      const image = await withDeadline(
        capturePage(ctx.wc) as Promise<{
          dataUrl: string
          mime: string
          width: number
          height: number
        }>,
        20_000,
        'CLI_SCREENSHOT_TIMEOUT',
        '页面截图超过 20 秒',
        () => close(ctx.id)
      )
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(String(image.dataUrl || ''))
      if (!match) throw errorWithCode('CLI_SCREENSHOT_FAILED', '页面截图编码失败')
      await fs.mkdir(artifactDir, { recursive: true })
      const filename = `${ctx.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`
      const outputPath = path.join(artifactDir, filename)
      await fs.writeFile(outputPath, Buffer.from(match[1], 'base64'))
      touch(ctx)
      return {
        ok: true,
        context: ctx.id,
        path: outputPath,
        mime: image.mime,
        width: image.width,
        height: image.height,
        url: ctx.wc.getURL(),
        title: ctx.win.getTitle()
      }
    })
  }

  function list() {
    return Array.from(contexts.values())
      .filter(isAlive)
      .map((ctx) => contextView(ctx))
  }

  function closeExternal(): number {
    let closed = 0
    for (const [id, ctx] of Array.from(contexts.entries())) {
      if (ctx.kind !== 'external') continue
      if (close(id)) closed += 1
    }
    return closed
  }

  function listExternal() {
    return Array.from(contexts.values())
      .filter(isAlive)
      .filter((ctx) => ctx.kind === 'external')
      .map((ctx) => contextView(ctx))
  }

  function closeExternalContext(id: unknown): boolean {
    const target = contexts.get(contextId(id))
    if (!target || target.kind !== 'external') return false
    return close(target.id)
  }

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const [id, ctx] of contexts) {
      if (!isAlive(ctx) || now - ctx.lastUsedAt > IDLE_TTL_MS) close(id)
    }
  }, 60_000)
  try { reaper.unref?.() } catch (_) {}
  /**
   * 最后一个可见 Hira 窗口关闭后，隐藏窗口会阻止 `window-all-closed` 触发。
   * 留 5 秒给“关一窗再开一窗”的迁移路径，期间仍没有可见窗口就释放上下文，
   * 让应用按既有生命周期正常退出，而不是留下无托盘的后台僵尸进程。
   */
  const visibleWindowGuard = setInterval(() => {
    if (!contexts.size) return
    let visible = false
    try {
      visible = BrowserWindow.getAllWindows().some((win: BrowserWindowType) => {
        try { return !win.isDestroyed() && win.isVisible() } catch (_) { return false }
      })
    } catch (_) {}
    if (!visible) {
      for (const id of Array.from(contexts.keys())) close(id)
    }
  }, 5_000)
  try { visibleWindowGuard.unref?.() } catch (_) {}

  function dispose(): void {
    clearInterval(reaper)
    clearInterval(visibleWindowGuard)
    for (const id of Array.from(contexts.keys())) close(id)
  }

  return {
    ensure,
    ensureAi: (aiSessionId: unknown) => ensure(aiContextId(aiSessionId), aiSessionId),
    open,
    read,
    readMany,
    search,
    click,
    fill,
    scroll,
    screenshot,
    list,
    listExternal,
    closeExternalContext,
    closeExternal,
    close,
    dispose
  }
}

module.exports = { createBackgroundBrowser }
