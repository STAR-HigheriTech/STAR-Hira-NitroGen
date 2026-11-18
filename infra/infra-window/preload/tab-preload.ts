const { contextBridge, ipcRenderer, webUtils } = require('electron')
import { PRELOAD_ROUTES } from '@hira-ng/shared-types/src/ipc-channels-preload'
import { isHiraResourceHost } from '@hira-ng/shared-types/src/page-resource-hosts'
// JS Dialog 桥（alert/confirm/prompt/beforeunload）与面板共用同一份实现，见该文件头。
import { exposeJsDialogBridge } from './js-dialog-bridge.js'
import interactiveFeatureSource from 'virtual:tab-features-interactive'
import deferredFeatureSource from 'virtual:tab-features-deferred'
// 注：Break Mode（D5）的遮罩**不在这里** —— 它已经是整窗原生浮层
//（out/renderer/break-overlay，见 main/break-overlay.js）：页面内 DOM 盖不住原生视图。
// 用户脚本 GM 桥：`@grant GM_xmlhttpRequest` 的跨域请求代理入口（window.__hiraGm）。
// 只暴露给 http/https/file 页面 —— 授权判定在主进程做，见该文件头。
import './userscript/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// 应用桥注入白名单（默认拒绝）
// ─────────────────────────────────────────────────────────────────────────────
// 只有这些协议的页面才会拿到 window.hira / __jsDialogBridge。
// 目的：把「我们自己的页面 + 普通网页」和「第三方静态 bundle」隔开。
//   hira-game:// 承载移植进来的上游游戏（apps/app-main/src/external/games/），
//   属第三方代码，**一律不注入** —— 于是它们既触达不到主进程 domain 路由
//   （history/download/settings…），也省掉了 jsDialog 轮询等无谓开销。
// 新增外部 bundle 协议时不需要改这里：不在名单里就是默认拒绝。
// （协议名定义见 apps/app-main/src/main/external-games/catalog.js#GAME_SCHEME）
// 普通网页、扩展页、游戏 bundle 与插件内部页一律拿不到全量 app IPC。
// preload 内部功能（密码填充 / 下载 / 手势等）直接使用 ipcRenderer，不依赖主世界桥。
const APP_BRIDGE_SCHEMES = new Set(['hira:', 'hx:', 'hirax-internal:'])
const JS_DIALOG_SCHEMES = new Set([
  'http:', 'https:', 'file:', 'hira:', 'hx:', 'hirax-internal:', 'chrome-extension:', 'about:', 'data:', 'blob:'
])
const pageProtocol = (() => {
  try { return String((window.location && window.location.protocol) || '') } catch { return '' }
})()
const pageHost = (() => {
  try { return String((window.location && window.location.hostname) || '').toLowerCase() } catch { return '' }
})()
const isPluginPage = pageProtocol === 'hira:' && pageHost.startsWith('p-')
/**
 * These hira hosts serve resources (including user/remote SVG), not app documents.
 * Navigating to one top-level must never turn its content into a privileged page.
 */
const isResourceDocument = pageProtocol === 'hira:' && isHiraResourceHost(pageHost)
const isDocumentHost = /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(pageHost)
const injectAppBridge = APP_BRIDGE_SCHEMES.has(pageProtocol)
  && isDocumentHost
  && !isPluginPage
  && !isResourceDocument

function makeChannel(scope: string, kind: string, route?: string | null): string {
  const base = scope + ':' + kind
  if (!route) return base
  return base + ':' + route
}

const provider = {
  invoke(route: string, payload?: unknown): Promise<unknown> {
    const ch = makeChannel('ngipc', 'invoke', route)
    return ipcRenderer.invoke(ch, payload)
  }
}

// 订阅登记用的进程内唯一作用域（listenerId 必须跨 webContents 全局唯一，见 shell-preload）
const listenerScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
let listenerSeq = 0

const on = {
  subscribe(route: string, listener: (payload: unknown) => void): () => void {
    const ch = makeChannel('ngipc', 'event', route)
    const fn = (_e: Electron.IpcRendererEvent, payload: unknown) => {
      try {
        listener(payload)
      } catch (error) {
        console.error(`[preload] event listener failed: ${route}`, error)
      }
    }
    ipcRenderer.on(ch, fn)
    // 登记给主进程：事件只发给登记过的 webContents（见 infra-ipc/ListenerRegistry）。
    // 内部页（hira:// 页跑在标签页里）过去被「只广播 chrome 层」过滤掉，就是靠这一步修好的。
    const listenerId = `${listenerScope}#${++listenerSeq}`
    ipcRenderer.send(makeChannel('ngipc', 'send', PRELOAD_ROUTES.listenersAdd), { channel: route, listenerId })
    return () => {
      ipcRenderer.removeListener(ch, fn)
      ipcRenderer.send(makeChannel('ngipc', 'send', PRELOAD_ROUTES.listenersRemove), { listenerId })
    }
  }
}

/**
 * 文件的**真实路径**（拖入 / 文件选择之后要用）。
 *
 * Electron 43 起 `File.path` 已移除，唯一正路是 `webUtils.getPathForFile`。
 * 需要它的是「把文件内容当作上下文」的内部页（AI 助手页 `hira://ai` 的拖入与 `@` 文件）：
 * 渲染层只拿到 `File`，读盘在主进程，所以第一步得把路径交出去。
 *
 * **只给 `hira:` 页面**：普通网页拿到这个能力等于把用户磁盘路径交给站点，
 * 而它们本来也不需要（第三方 bundle 走 hira-game://，压根不进 APP_BRIDGE_SCHEMES）。
 * 取不到（虚拟文件 / 非文件条目）返回空串，由调用方决定退化成读文本还是忽略。
 */
const files =
  pageProtocol === 'hira:' && webUtils && typeof webUtils.getPathForFile === 'function'
    ? {
        pathFor(file: File): string {
          try { return file ? (webUtils.getPathForFile(file) || '') : '' } catch (_) { return '' }
        }
      }
    : null

if (injectAppBridge) {
  contextBridge.exposeInMainWorld('hira', files ? { provider, on, files } : { provider, on })
}

// ── JS Dialog 拦截（alert/confirm/prompt/beforeunload）──
// 实现收在 `js-dialog-bridge.js`（与面板共用同一份；契约见该文件头）。
// 第三方 bundle（hira-game://）不注入：省掉无谓的同步 IPC 开销。
const allowJsDialogBridge = JS_DIALOG_SCHEMES.has(pageProtocol)
  && (pageProtocol !== 'hira:' || (isDocumentHost && !isResourceDocument))
if (allowJsDialogBridge) {
  exposeJsDialogBridge(ipcRenderer, contextBridge)
}

// ─────────────────────────────────────────────────────────────────────────────
// 页面能力按关键路径分层装载
// ─────────────────────────────────────────────────────────────────────────────
// 数据与手势、自动填充这些能力都不参与首屏绘制，却会把几十 KB 代码塞进每个文档的
// document-start。Chromium 必须先读完、编译完 preload 才会跑页面脚本，页面 DOM 越大，
// 这段固定税越容易被感知成“加载完成那一下卡住”。
//
// 这里只保留安全桥、对话框和用户脚本桥在关键路径；其余能力由构建期生成成独立函数体，
// 在首帧之后按需求值。仍然留在同一个 sandbox preload 上下文，所以 ipcRenderer 等能力
// 与原先完全一致，不引入额外进程、IPC 注册表或第二份安全边界。
type FeatureScope = Record<string, unknown> & {
  require(id: string): unknown
  module: { exports: unknown }
  exports: unknown
}

const featureElectron = { contextBridge, ipcRenderer, webUtils }
let interactiveFeaturesLoaded = false
let deferredFeaturesLoaded = false

function runFeatureSource(source: string, tag: string): void {
  try {
    const module = { exports: {} as unknown }
    const scope = {
      require: (id: string) => id === 'electron' ? featureElectron : require(id),
      module,
      exports: module.exports
    } as FeatureScope
    const install = new Function('require', 'module', 'exports', source)
    install.call(scope, scope.require, module, module.exports)
  } catch (error) {
    console.error(`[tab-preload] ${tag} features failed:`, error instanceof Error ? error.message : error)
  }
}

function loadInteractiveFeatures(): void {
  if (interactiveFeaturesLoaded) return
  interactiveFeaturesLoaded = true
  runFeatureSource(interactiveFeatureSource, 'interactive')
}

function loadDeferredFeatures(): void {
  if (deferredFeaturesLoaded) return
  deferredFeaturesLoaded = true
  runFeatureSource(deferredFeatureSource, 'deferred')
}

function afterFirstPaint(callback: () => void): void {
  try {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(callback)
    })
  } catch (_) {
    setTimeout(callback, 0)
  }
}

function inIdle(callback: () => void, timeout = 1200): void {
  try {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(callback, { timeout })
      return
    }
  } catch (_) {}
  setTimeout(callback, 0)
}

function scheduleInteractiveFeatures(): void {
  afterFirstPaint(() => inIdle(loadInteractiveFeatures))
}

function scheduleDeferredFeatures(): void {
  let armed = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null

  const disarm = (): void => {
    if (!armed) return
    armed = false
    try { window.removeEventListener('focusin', onIntent, true) } catch (_) {}
    try { window.removeEventListener('submit', onIntent, true) } catch (_) {}
    try { document.removeEventListener('visibilitychange', onVisibility, true) } catch (_) {}
    if (fallbackTimer) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  const activate = (): void => {
    disarm()
    loadDeferredFeatures()
  }

  function onIntent(event: Event): void {
    if (!event.isTrusted) return
    if (event.type === 'submit') {
      activate()
      return
    }
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) activate()
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') activate()
  }

  armed = true
  try { window.addEventListener('focusin', onIntent, true) } catch (_) {}
  try { window.addEventListener('submit', onIntent, true) } catch (_) {}
  try { document.addEventListener('visibilitychange', onVisibility, true) } catch (_) {}

  // 用户长期不碰表单也必须完成正文索引与安装线索：等首帧、再等一段稳定空闲。
  // 这不是首屏功能，晚几秒没有用户损失；真正离开页面时 visibilitychange 会立即接走。
  const beginFallback = (): void => {
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null
      if (!armed) return
      inIdle(activate, 3000)
    }, 4000)
  }
  if (document.readyState === 'complete') afterFirstPaint(beginFallback)
  else window.addEventListener('load', () => afterFirstPaint(beginFallback), { once: true })
}

/**
 * 内容面里的输入框一旦被用户点中，就明确宣告“键盘归内容面”。
 *
 * 为什么不能只等主进程的视图 focus 事件：新标签页创建初期，外壳仍可能挂着
 * 地址栏聚焦重试链；用户点进页内搜索框后，那条旧意图必须立刻作废，且外壳地址栏
 * 的 DOM activeElement 也要主动 blur。否则之后任意一次原生 focus 重放都会把
 * 光标重新送回地址栏，看起来就是“刚输入一个字就被地址栏抢走”。
 *
 * pointerdown 与 focusin 都听：输入框已经是 DOM activeElement 时再次点击不会再发
 * focusin，但键盘焦点仍可能刚被外壳拿回；这一拍只能靠 pointerdown 补声明。
 */
function installContentFocusClaim(): void {
  let lastClaimAt = 0
  const editableSelector = [
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]'
  ].join(',')

  const claim = (event: Event): void => {
    if (!event.isTrusted) return
    const target = event.target
    if (!(target instanceof Element)) return
    let editable: Element | null = null
    try { editable = target.closest(editableSelector) } catch (_) { editable = null }
    if (!editable) return
    const now = Date.now()
    if (now - lastClaimAt < 120) return
    lastClaimAt = now
    try {
      ipcRenderer.send(makeChannel('ngipc', 'send', PRELOAD_ROUTES.contentFocus), {
        reason: 'content-editable-focus'
      })
    } catch (_) {}
  }

  try { window.addEventListener('pointerdown', claim, true) } catch (_) {}
  try { window.addEventListener('focusin', claim, true) } catch (_) {}
}

installContentFocusClaim()

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleInteractiveFeatures, { once: true })
} else {
  scheduleInteractiveFeatures()
}
scheduleDeferredFeatures()
