/**
 * 用户脚本 GM 桥（preload）—— `GM_xmlhttpRequest` 的页面侧入口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它做什么
 * ══════════════════════════════════════════════════════════════════════
 * 页面里的 GM 垫片（`shared-types/userscript.mjs#buildUserScriptCode`）把
 * `GM_xmlhttpRequest` 落到 `window.__hiraGm.request`。本文件就是那个桥：
 * 一次 `ipcRenderer.invoke` → 真正的请求在主进程发出。
 *
 * 为什么不在这里直接 fetch：
 *   · 页面跑在 `sandbox: true` 的独立渲染进程里，跨域受 CORS 约束 ——
 *     ​而用户脚本的价值恰恰是"绕开 CORS"；
 *   · 授权判定（`@grant GM_xmlhttpRequest` + `@connect` 白名单）必须由**主进程**
 *     按"发送方页面 URL"完成，页面传什么都**不能**当成授权依据。
 *
 * 与其它 preload 模块同一条纪律：顶部 ESM import 由打包器内联进 tab.js
 * （sandbox 下 preload 不能在运行时 require 本地文件）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'

const ROUTE = PRELOAD_ROUTES.userscriptGmRequest
const MAX_URL_CHARS = 8 * 1024
const MAX_BODY_CHARS = 2 * 1024 * 1024
const MAX_HEADER_CHARS = 64 * 1024

/** 只在这些协议的页面上暴露桥（与用户脚本能运行的页面同一范围）。 */
const GM_PAGE_SCHEMES = new Set(['http:', 'https:'])

/** 安全调用页面回调：脚本写错回调不应该把桥本身带崩。 */
function call(fn: unknown, arg: unknown): void {
  if (typeof fn !== 'function') return
  try { (fn as (value: unknown) => void)(arg) } catch (_) {}
}

/** 请求头归一成纯字符串映射（页面可能塞进任意值）。 */
function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.trim()) continue
    if (value == null) continue
    out[key] = String(value)
  }
  return out
}

/** 发送结果 → 页面回调（`onload` / `onerror` / `ontimeout` / `onreadystatechange`）。 */
interface UserScriptCallbacks {
  onload?: unknown
  onerror?: unknown
  ontimeout?: unknown
  onabort?: unknown
  onreadystatechange?: unknown
}

function dispatch(res: unknown, cb: UserScriptCallbacks): void {
  if (!res || typeof res !== 'object') {
    call(cb.onerror, { error: '宿主无响应' })
    return
  }
  const response = res as Record<string, unknown>
  if (response.ok === false) {
    const info = { error: String(response.error || '请求失败'), status: Number(response.status) || 0 }
    if (response.timeout) call(cb.ontimeout, info)
    else call(cb.onerror, info)
    return
  }
  const text = typeof response.responseText === 'string' ? response.responseText : ''
  const out = {
    readyState: 4,
    status: Number(response.status) || 0,
    statusText: String(response.statusText || ''),
    responseText: text,
    response: text,
    responseHeaders: response.responseHeaders && typeof response.responseHeaders === 'object' ? response.responseHeaders : {},
    finalUrl: String(response.finalUrl || '')
  }
  call(cb.onreadystatechange, out)
  call(cb.onload, out)
}

/**
 * 发起一次代理请求。返回 `{ abort }` —— 与 Tampermonkey 同形。
 *
 * `abort` 只丢弃页面侧回调；主进程的请求由它自己的超时兜底
 * （中止信号无法跨 contextBridge 传递，也不值得为此开第二条通道）。
 */
interface UserScriptDetails {
  url?: unknown
  method?: unknown
  headers?: unknown
  data?: unknown
  timeout?: unknown
  onload?: unknown
  onerror?: unknown
  ontimeout?: unknown
  onabort?: unknown
  onreadystatechange?: unknown
}

function request(details: unknown, label: unknown): { abort(): void } {
  const d = details && typeof details === 'object' ? details as UserScriptDetails : {}
  const cb: UserScriptCallbacks = {
    onload: d.onload,
    onerror: d.onerror,
    ontimeout: d.ontimeout,
    onabort: d.onabort,
    onreadystatechange: d.onreadystatechange
  }
  if (typeof d.url !== 'string' || !d.url) {
    call(cb.onerror, { error: 'GM_xmlhttpRequest 缺少 url' })
    return { abort() {} }
  }
  if (d.url.length > MAX_URL_CHARS) {
    call(cb.onerror, { error: 'GM_xmlhttpRequest URL 过长' })
    return { abort() {} }
  }
  if (typeof d.data === 'string' && d.data.length > MAX_BODY_CHARS) {
    call(cb.onerror, { error: 'GM_xmlhttpRequest 请求体过大' })
    return { abort() {} }
  }
  if (d.headers && typeof d.headers === 'object') {
    let headerChars = 0
    for (const [key, value] of Object.entries(d.headers)) {
      headerChars += key.length + String(value ?? '').length
      if (headerChars > MAX_HEADER_CHARS) {
        call(cb.onerror, { error: 'GM_xmlhttpRequest 请求头过大' })
        return { abort() {} }
      }
    }
  }
  let aborted = false
  const payload = {
    url: d.url,
    method: typeof d.method === 'string' ? d.method : 'GET',
    headers: normalizeHeaders(d.headers),
    data: typeof d.data === 'string' ? d.data : '',
    timeout: Number.isFinite(d.timeout) ? Number(d.timeout) : 0,
    label: typeof label === 'string' ? label : ''
  }
  ipcRenderer.invoke(`ngipc:invoke:${ROUTE}`, payload).then(
    (res: unknown) => { if (!aborted) dispatch(res, cb) },
    (err: unknown) => { if (!aborted) call(cb.onerror, { error: err instanceof Error ? err.message : '宿主无响应' }) }
  )
  call(cb.onreadystatechange, { readyState: 1 })
  return {
    abort() {
      if (aborted) return
      aborted = true
      call(cb.onabort, { error: 'aborted' })
    }
  }
}

const pageScheme = (() => {
  try { return String((window.location && window.location.protocol) || '') } catch (_) { return '' }
})()

if (GM_PAGE_SCHEMES.has(pageScheme)) {
  try {
    contextBridge.exposeInMainWorld('__hiraGm', { request })
  } catch (_) {
    // bridge 已暴露（热重载等情况），忽略
  }
}
