/**
 * panel-ui-frame.js —— 把一份 `.html` / `.xaml` 变成一块**可挂载的面板实现**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它在整条链路里的位置
 * ══════════════════════════════════════════════════════════════════════
 *   manifest.contributes.panels[].ui   ← 作者只写一个相对路径
 *     → 主进程 `plugins:list` 下发 `panelUi[]`（含 `hira-plugin://` URL）
 *       → **本文件** fetch 源码 → 组装安全文档 → `iframe.srcdoc`
 *         → `panel-ui-bridge.js` 提供 `window.hira`
 *
 * 关键决定：面板视图**永远不 `loadURL` 插件 HTML**。
 * 面板 WebContentsView 带着 `panel-preload.js`，那里的 `window.hira` 是**未沙箱**的
 * 全量 IPC 端口 —— 一旦把插件文档直接当页面加载，等于把整台浏览器交出去。
 * 所以插件界面只能以「内嵌沙箱 iframe + srcdoc」的形态出现，能力走消息桥。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么 XAML 在**这里**编译（而不是主进程 / 插件自己）
 * ══════════════════════════════════════════════════════════════════════
 * `xaml.mjs` 是纯层（零 DOM、零 IO），所以同一份编译器可以同时服务：
 *   · 渲染层（本文件）—— 真正生成界面；
 *   · 校验器（`scripts/validate-plugin.cjs`）—— 安装前就能说"这份 XAML 编不出来"。
 * 若放到主进程编译、再把 HTML 下发，则"能不能渲染"的结论会分裂成两份实现。
 */

import {
  PANEL_UI_MAX_ENTRY_BYTES,
  PANEL_UI_SANDBOX,
  buildPanelUiDocument
} from '@hira-ng/shared-types/src/plugin-ui.mjs'
import { compileXaml } from '@hira-ng/shared-types/src/xaml.mjs'
import {
  PANEL_UI_BRIDGE_SCRIPT,
  collectThemeTokens,
  panelThemeStyle,
  createPanelUiBridge
} from './panel-ui-bridge.js'
import type { PanelContext } from './panel-context.js'
import { errorMessage } from './error-message.js'
import type { PanelDefinition } from './panel-definition.js'

/** 错误提示的统一外观（与宿主其它失败态一致）。 */
const ERROR_STYLE = 'padding:32px 16px;text-align:center;color:var(--hira-text-secondary,#6b7280);font-size:12px;line-height:1.7;'

/**
 * 入口源码缓存 —— **重开面板 / 主题重渲都不再走一次协议读取**。
 *
 * 面板 URL 形如 `hira-plugin://<id>/panel.xaml?v=<mtime>`：`v` 就是内容版本，
 * 所以按整个 URL 缓存是安全的（文件一改，URL 就变，旧条目自然不再命中）。
 * 没有版本参数的 URL **不缓存**（宁可多读一次，也不能显示旧界面）。
 *
 * 为什么必须有：打开面板 → 关掉 → 再打开 是最高频的操作之一，
 * 而每次都要 `fetch` 协议 + 重新解析/编译 XAML（可能上千个节点）。
 */
const SOURCE_CACHE_MAX_ENTRIES = 48
const SOURCE_CACHE_MAX_CHARS = 8 * 1024 * 1024
const sourceCache = new Map<string, { compiled: string; size: number }>()
const pendingSources = new Map()
let sourceCacheChars = 0

/** URL 是否带内容版本（`?v=` / `&v=`）—— 只有带版本才允许长期缓存。 */
function versionedUrl(url: string): boolean {
  return /[?&]v=/.test(url)
}

/** @param {string} url @returns {{ compiled: string, size: number }|null} */
function cachedSource(url: string) {
  const hit = sourceCache.get(url)
  if (!hit) return null
  // LRU：命中后移到队尾（Map 的迭代顺序就是淘汰顺序）。
  sourceCache.delete(url)
  sourceCache.set(url, hit)
  return hit
}

/** @param {string} url @param {string} compiled */
function rememberSource(url: string, compiled: string): void {
  const old = sourceCache.get(url)
  if (old) {
    sourceCacheChars -= old.size
    sourceCache.delete(url)
  }
  const entry = { compiled, size: compiled.length }
  sourceCache.set(url, entry)
  sourceCacheChars += entry.size
  while (sourceCache.size > SOURCE_CACHE_MAX_ENTRIES || sourceCacheChars > SOURCE_CACHE_MAX_CHARS) {
    const oldestKey = sourceCache.keys().next().value
    if (oldestKey == null) break
    const evicted = sourceCache.get(oldestKey)
    if (evicted) sourceCacheChars -= evicted.size
    sourceCache.delete(oldestKey)
  }
}

/**
 * 取（并缓存）一块面板的最终 HTML 片段。
 *
 * 同一 URL 的并发请求共享一个 Promise（两个面板同时打开 / 宿主一次刷新多块）
 * —— 否则 N 个面板就是 N 次协议读取 + N 次 XAML 编译。
 *
 * @param {string} url
 * @param {'html'|'xaml'} kind
 * @param {string} title
 * @returns {Promise<string>}
 */
async function loadPanelSource(url: string, kind: 'html'|'xaml', title: string) : Promise<string> {
  const hit = versionedUrl(url) ? cachedSource(url) : null
  if (hit) return hit.compiled

  const pending = pendingSources.get(url)
  if (pending) return pending

  const task = (async () => {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`入口读取失败：HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > PANEL_UI_MAX_ENTRY_BYTES) {
      throw new Error(`入口文件超过 ${Math.round(PANEL_UI_MAX_ENTRY_BYTES / 1024)} KiB 上限`)
    }
    const source = new TextDecoder('utf-8').decode(buf)
    const compiled = kind === 'xaml' ? compileXaml(source, { title }).html : source
    if (versionedUrl(url)) rememberSource(url, compiled)
    return compiled
  })()

  pendingSources.set(url, task)
  try {
    return await task
  } finally {
    pendingSources.delete(url)
  }
}

/**
 * 建一块「UI 面」面板实现。
 *
 * 返回值形状与 `ui-panel-*` / `.renderer.js` 完全一致（`{ id, mount }`），
 * 所以宿主的挂载逻辑**一行都不用改** —— 这是"三种实现来源共用一条装配路径"的收口点。
 *
 * @param {{
 *   pluginId: string,
 *   panelId: string,
 *   entry: string,
 *   kind: 'html'|'xaml',
 *   url: string,
 *   title?: string,
 *   permissionLevel?: unknown,
 *   grantedPermissions?: string[],
 *   isFirstParty?: boolean
 * }} options
 */
export function createPanelUiDefinition(options: {
  pluginId: string,
  panelId: string,
  entry: string,
  kind: 'html'|'xaml',
  url: string,
  title?: string,
  permissionLevel?: unknown,
  grantedPermissions?: string[],
  isFirstParty?: boolean
}): PanelDefinition {
  const pluginId = String(options.pluginId || '')
  const panelId = String(options.panelId || '')
  const entry = String(options.entry || '')
  const kind = options.kind === 'xaml' ? 'xaml' : 'html'
  const url = String(options.url || '')
  const title = String(options.title || '')

  return {
    id: panelId,
    /** 供宿主 / 调试面板识别实现来源（不参与渲染逻辑）。 */
    source: 'panel-ui',
    entry,
    kind,

    /**
     * @param {Document} doc
     * @param {unknown} ctx 宿主端口（见 panels/host.js#ctx）
     */
    async mount(doc: Document, ctx: PanelContext) {
      const wrapper = doc.createElement('div')
      wrapper.className = 'hira-panel-ui'
      wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;'

      const iframe = doc.createElement('iframe')
      iframe.className = 'hira-panel-ui__frame'
      iframe.style.cssText = 'flex:1;width:100%;height:100%;border:0;background:transparent;display:block;'
      // 安全模型的支点：**永远**不含 allow-same-origin（见 plugin-ui.mjs 的说明）。
      iframe.setAttribute('sandbox', PANEL_UI_SANDBOX)
      iframe.setAttribute('referrerpolicy', 'no-referrer')
      iframe.setAttribute('allow', '')
      iframe.title = title || panelId
      wrapper.appendChild(iframe)

      // 桥必须在 srcdoc 之前就位：子侧脚本第一帧就可能调 `hira.*`。
      const bridge = createPanelUiBridge({
        iframe,
        pluginId,
        panelId,
        permissionLevel: options.permissionLevel,
        grantedPermissions: options.grantedPermissions,
        isFirstParty: options.isFirstParty,
        // 惰性函数：主题切换后只要 bridge 还活着，`hira.theme.tokens()` 就得是新值。
        themeTokens: () => collectThemeTokens(doc),
        ctx
      })

      /** 渲染状态：同一时刻只允许一次在执行；期间的 refresh 合并成一次补跑。 */
      let rendering = false
      let rerun = false
      let disposed = false
      /** 上一次真正写进 iframe 的文档 —— 内容没变就不重设 srcdoc（保住滚动 / 焦点 / 状态）。 */
      let lastDocumentHtml = ''

      /** 失败态：把原因摆出来（白屏是最差的失败态）。 */
      function showError(message: string): void {
        iframe.style.display = 'none'
        let box = wrapper.querySelector<HTMLElement>('.hira-panel-ui__error')
        if (!box) {
          box = doc.createElement('div')
          box.className = 'hira-panel-ui__error'
          box.style.cssText = ERROR_STYLE
          wrapper.appendChild(box)
        }
        box.textContent = message
      }

      /** 一次完整渲染：取源码（缓存）→ 组装安全文档 → srcdoc。 */
      async function render() {
        if (disposed) return
        // 已经在渲染：记一笔补跑，而不是并发再来一次（并发只会在同一个 iframe 上抢写 srcdoc）。
        if (rendering) { rerun = true; return }
        rendering = true
        try {
          const compiled = await loadPanelSource(url, kind, title)
          if (disposed) return

          // 主题走缓存（主题切换时由 `<html>` 属性变化自动失效）。
          const documentHtml = buildPanelUiDocument({
            source: compiled,
            pluginId,
            panelId,
            firstParty: options.isFirstParty === true,
            kind,
            permissionLevel: options.permissionLevel,
            title: title || panelId,
            bridgeScript: PANEL_UI_BRIDGE_SCRIPT,
            themeStyle: panelThemeStyle(doc)
          })
          const box = wrapper.querySelector('.hira-panel-ui__error')
          if (box) box.remove()
          // 文档没变（例如重复刷新 / 同一 profile 切换）就**不重设 srcdoc**：
          // 重新解析整份文档会把滚动位置、输入焦点、展开状态全部清掉。
          if (documentHtml === lastDocumentHtml && iframe.style.display !== 'none') return
          lastDocumentHtml = documentHtml
          iframe.style.display = 'block'
          iframe.srcdoc = documentHtml
        } catch (e) {
          if (disposed) return
          const reason = errorMessage(e, String(e))
          console.error(`[panel-ui:${pluginId}] ${panelId} 渲染失败:`, e)
          showError(kind === 'xaml' ? `XAML 编译失败：${reason}` : `面板入口加载失败：${reason}`)
        } finally {
          rendering = false
          if (rerun && !disposed) {
            rerun = false
            render()
          }
        }
      }

      // 不 await：界面容器先上屏，文档在后台取 —— 与"壳先出、内容后到"同一条时序。
      render()

      return {
        element: wrapper,
        /** profile / 插件变更后宿主会调它（见 host.js#profileChanged 的订阅）。 */
        refresh() {
          if (disposed) return
          render()
        },
        dispose() {
          if (disposed) return
          disposed = true
          bridge.dispose()
          try { iframe.srcdoc = '' } catch (_) {}
        }
      }
    }
  }
}


