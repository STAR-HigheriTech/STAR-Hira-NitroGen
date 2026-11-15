import { isRenderModulePath } from '@hira-ng/shared-types/src/plugin-ui.mjs'
import type { PanelDefinition, PanelInstance } from './panel-definition.js'
import type { PanelContext } from './panel-context.js'
import { errorMessage } from './error-message.js'
/**
 * 渲染侧插件入口加载器 —— `entry.render`（插件自带 UI 的唯一加载口）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它解决什么（在此之前"插件声明面板"是**假象**）
 * ══════════════════════════════════════════════════════════════════════
 * 面板此前走的是 `panels/main.js` 里一条约定式 glob：
 *   `../../../../../ui/ui-panel-<name>/src/index.js`
 * 也就是说：**能声明面板的前提是仓库里先有一个 ui/ui-panel-* 包**。
 * 插件 manifest 写 `contributes.panels` 只是登记了一个 id，实现侧仍然硬编码在仓库里 ——
 * 第三方插件根本插不进来。
 *
 * 有了 `render` 字段，插件可以自带渲染侧代码。声明与实现这才真正闭合：
 *   manifest.contributes.panels[].id  ←→  渲染模块导出的面板 id
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一条加载路径，三种模块形态
 * ══════════════════════════════════════════════════════════════════════
 * 主进程为所有已启用插件下发 `renderUrl`（`hira-plugin://<id>/<file>?v=<mtime>`）。
 * 渲染层只认这一个协议入口，不再依赖 Vite 的 `import.meta.glob`：
 *   · 先按 **ESM** `import()`；
 *   · 失败（典型是作者把 `.cjs` 当渲染入口 —— `module is not defined`）→
 *     `fetch()` 源码，按 **CommonJS** 求值兜底；仍不行再包一层 Blob 当 ESM 试一次。
 *
 * 这条边界同时服务壳层、面板进程和静态内部页。构建器只负责把模块变成独立可加载的
 * 产物，加载规则不再反向污染宿主页面 —— 设置页的 `settings.custom-widget` 因此能在
 * 不迁入 renderer 构建的前提下复用同一套加载器。
 *
 * 为什么必须容错：渲染入口是**外部边界**，作者写 ESM / CJS / 默认导出函数都可能。
 * 在此之前任何一处不合约就是"面板声明了却永远白屏"，而报错只有一句笼统的
 * 「尚未实现」—— 用户与作者都无从下手。现在：**能跑的都跑起来，跑不了的给出原因**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 模块契约（三种写法任选，全部支持）
 * ══════════════════════════════════════════════════════════════════════
 *   1. `export const rendererPlugin = { panels: [...], slots?, activate?, deactivate? }`
 *   2. `export const panelDefinition = { id, mount }`（单面板简写）
 *   3. `export default function mount(input)` / `module.exports = function render(input)`
 *      —— **函数式单面板**：id 取 `loadPanelDefinitionFrom` 传入的 panelId。
 *
 * 面板定义本身也容错：有 `mount` 用 `mount`，没有就认 `render` / `create` / `factory`；
 * 都没有时保留一个**会说明原因**的 mount（宿主不再显示"尚未实现"，而是具体缺什么）。
 *
 * 生命周期：每个面板进程只加载**自己那一个**插件的模块（见 renderer/panels/main.js），
 * 不做全量激活 —— 否则同一插件会在 N 个面板进程里被激活 N 次。
 */

/** renderUrl → Promise<原始模块>。URL 带版本，插件热重载后自然拿到新缓存键。 */
const moduleCache = new Map<string, Promise<unknown>>()

/** pluginId → 当前 renderUrl 缓存键。热重载时移除上一版，避免模块表无限增长。 */
const moduleCacheKey = new Map<string, string>()

/** pluginId → 最后一次加载失败的原因（宿主拿它替换笼统的"尚未实现"）。 */
const loadErrors = new Map<string, string>()

/** pluginId → 归一化后导出的面板 id 列表（诊断用：manifest 的 id 与实现对不上时能直接看见）。 */
const panelIds = new Map<string, string[]>()

interface RenderablePluginManifest {
  id: string
  render?: string|null
  renderUrl?: string|null
  isFirstParty?: boolean
}

/** @param {string} pluginId */
export function getRendererLoadError(pluginId: string) {
  return loadErrors.get(String(pluginId || '')) || ''
}

/** @param {string} pluginId @returns {string[]} */
export function getRendererPanelIds(pluginId: string) {
  return panelIds.get(String(pluginId || '')) || []
}

/**
 * 取一个插件的**原始渲染模块**（未归一化）。
 * @param {{ id: string, render?: string|null, renderUrl?: string|null }} manifest
 * @returns {Promise<unknown>}
 */
async function loadRendererModule(manifest: RenderablePluginManifest) : Promise<unknown> {
  if (manifest.isFirstParty !== true) {
    throw new Error(`插件 ${manifest.id} 的可执行 render 入口已禁用；社区插件必须使用声明式 ui/html 面`)
  }
  const pluginId = String((manifest && manifest.id) || '')
  const rel = String((manifest && manifest.render) || '').trim().replace(/^\.?\//, '')
  if (!rel) return null

  const url = manifest && manifest.renderUrl
  if (!url) {
    throw new Error(
      `找不到渲染入口 ${rel}：主进程没有下发 renderUrl（插件可能未启用或文件已删除）`
    )
  }

  // ① 先按标准 ESM 加载 —— 运行时插件的正路。
  let esmError: unknown = null
  try {
    return await import(/* @vite-ignore */ url)
  } catch (e) {
    esmError = e
  }

  // ② ESM 失败 → 取源码，按 CommonJS 求值。AI / 作者最常把 `main.cjs` 当 render 写。
  let source = ''
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    source = await res.text()
  } catch (e) {
    throw new Error(`渲染入口既不是可 import 的 ESM，也取不到源码：${errorMessage(e, String(e))}（原 ESM 错误：${errorMessage(esmError, String(esmError))}）`)
  }

  try {
    return evaluateCommonJs(source, pluginId)
  } catch (cjsError) {
    // ③ 还不是 CJS（例如语法上是 ESM 但 import 因别的原因失败）→ Blob 再试一次。
    try {
      return await importBlob(source, pluginId)
    } catch (blobError) {
      throw new Error(
        `渲染入口加载失败：ESM=${errorMessage(esmError, String(esmError))}；` +
        `CJS=${errorMessage(cjsError, String(cjsError))}；` +
        `Blob=${errorMessage(blobError, String(blobError))}`
      )
    }
  }
}

/**
 * 把 CommonJS 源码当模块求值（`module.exports = ...` / `exports.foo = ...`）。
 *
 * 只给 `module / exports / require` 三个形参；`require` 一律抛带说明的错误 ——
 * 渲染层拿不到 Node 模块，静默失败比明确报错更难查。
 */
function evaluateCommonJs(source: string, pluginId: string): unknown {
  const module = { exports: {} }
  const requireShim = (id: string) => {
    throw new Error(`渲染模块不能 require('${id}')：请把它写成自包含模块（ESM 或单文件 CJS）`)
  }
  const factory = new Function(
    'module', 'exports', 'require', 'globalThis',
    `"use strict";\n${source}\n//# sourceURL=hira-plugin://${pluginId}/render-entry.cjs`
  )
  factory.call(module.exports, module, module.exports, requireShim, globalThis)
  return module.exports
}

/** 把源码包成 Blob ESM 再 import（相对 import 会失效，但单文件插件可用）。 */
async function importBlob(source: string, pluginId: string): Promise<unknown> {
  const blob = new Blob([source], { type: 'text/javascript' })
  const href = URL.createObjectURL(blob)
  try {
    return await import(/* @vite-ignore */ href)
  } finally {
    // 模块求值已完成；延迟回收，避免个别实现仍在解析时被撤销。
    setTimeout(() => { try { URL.revokeObjectURL(href) } catch (_) {} }, 0)
    void pluginId
  }
}

/**
 * 加载并**归一化**一个插件的渲染模块。
 *
 * @param {{ id: string, render?: string|null, renderUrl?: string|null }} manifest
 * @param {string} [requestedPanelId] 函数式单面板的兜底 id（宿主在找哪块面板）
 * @returns {Promise<{
 *   pluginId: string, panels: object[], slots: Record<string, Function>,
 *   activate?: Function|null, deactivate?: Function|null
 * }|null>}
 */
export async function loadRendererPlugin(manifest: RenderablePluginManifest, requestedPanelId?: string) : Promise<{
  pluginId: string, panels: PanelDefinition[], slots: Record<string, (...args: unknown[]) => unknown>,
  activate?: ((...args: unknown[]) => unknown)|null, deactivate?: ((...args: unknown[]) => unknown)|null
}|null> {
  const pluginId = manifest && manifest.id
  const renderPath = manifest && manifest.render
  if (!pluginId || !renderPath) return null

  const cacheKey = `${pluginId}::${String(manifest.renderUrl || renderPath)}`
  if (!moduleCache.has(cacheKey)) {
    const previousKey = moduleCacheKey.get(String(pluginId))
    if (previousKey && previousKey !== cacheKey) moduleCache.delete(previousKey)
    const promise = (async () => {
      try {
        const mod = await loadRendererModule(manifest)
        if (mod != null) loadErrors.delete(pluginId)
        return mod
      } catch (e) {
        // 插件自己的渲染代码抛错**不能**拖垮宿主：面板进程还要显示"该面板加载失败"的占位。
        console.error(`[plugin-renderer] 加载 ${pluginId} 的渲染模块失败:`, e)
        loadErrors.set(pluginId, errorMessage(e, String(e)))
        return null
      }
    })()
    moduleCache.set(cacheKey, promise)
    moduleCacheKey.set(String(pluginId), cacheKey)
  }

  const mod = await moduleCache.get(cacheKey)
  if (!mod) {
    // 启动竞态 / 临时协议错误不应永久毒化缓存；下次 activate 允许原 URL 重试。
    moduleCache.delete(cacheKey)
    if (moduleCacheKey.get(String(pluginId)) === cacheKey) moduleCacheKey.delete(String(pluginId))
    return null
  }
  const normalized = normalizeModule(mod, String(pluginId), requestedPanelId ? String(requestedPanelId) : '')
  panelIds.set(String(pluginId), normalized.panels.map((def) => def.id))
  return normalized
}

/**
 * 三种导出形态 + 函数式模块 → 同一种描述对象。
 *
 * 兼容 AI 现场写的 CommonJS（`module.exports = render; module.exports.panels = [...]`）：
 * 函数本身是挂载器，函数上的 `panels` 属性仍然会被收集 —— 之前只看 `typeof mod === 'object'`，
 * 这类模块会被直接判成"没有面板"，于是必然回落 ui 包并报「尚未实现」。
 */
interface NormalizedRendererModule {
  pluginId: string
  panels: PanelDefinition[]
  slots: Record<string, (...args: unknown[]) => unknown>
  activate: ((...args: unknown[]) => unknown) | null
  deactivate: ((...args: unknown[]) => unknown) | null
}

function normalizeModule(mod: unknown, pluginId: string, requestedPanelId: string): NormalizedRendererModule {
  const panels: PanelDefinition[] = []
  /** 去重键：同一个 id 只留第一份（更具体的声明优先）。 */
  const seen = new Set<string>()

  const pushPanel = (def: unknown) => {
    const normalized = normalizePanelDefinition(def, pluginId, requestedPanelId)
    if (!normalized) return
    if (seen.has(normalized.id)) return
    seen.add(normalized.id)
    panels.push(normalized)
  }

  const visit = (container: unknown) => {
    if (!container) return
    if (typeof container === 'function') {
      const functionRecord = container as unknown as Record<string, unknown>
      // CJS 常见写法：`module.exports = render; module.exports.panels = [...]`。
      // 函数上的静态属性同样是导出，先收它们；没有面板声明时才把函数本身当单面板。
      if (Array.isArray(functionRecord.panels)) {
        for (const def of functionRecord.panels) pushPanel(def)
        return
      }
      if (functionRecord.panelDefinition) {
        pushPanel(functionRecord.panelDefinition)
        return
      }
      // 函数式单面板：id 取宿主正在找的 panelId（没有就退到插件 id）。
      pushPanel({ id: requestedPanelId || pluginId, mount: container })
      return
    }
    if (typeof container !== 'object') return
    const record = container as Record<string, unknown>
    if (Array.isArray(record.panels)) for (const def of record.panels) pushPanel(def)
    if (record.panelDefinition) pushPanel(record.panelDefinition)
    if (record.id && (record.mount || record.render || record.create || record.factory)) {
      pushPanel(container)
    }
  }

  // 顺序 = 具体程度：rendererPlugin > default > 模块本身。
  const moduleRecord = mod && (typeof mod === 'object' || typeof mod === 'function')
    ? mod as Record<string, unknown>
    : null
  visit(moduleRecord?.rendererPlugin)
  visit(moduleRecord?.default)
  visit(mod)
  // `module.exports.panelDefinition` / `module.exports.render` 这类扁平写法也认。
  if (moduleRecord?.panelDefinition) pushPanel(moduleRecord.panelDefinition)

  const declared = moduleRecord?.rendererPlugin || (moduleRecord?.default && typeof moduleRecord.default === 'object' ? moduleRecord.default : null) || mod
  return {
    pluginId,
    panels,
    // 渲染侧插槽实现表。只做形状过滤（key 非空、值是函数），
    // "这个槽有没有宿主"由 plugin-slots.js 在激活时判定。
    slots: normalizeSlots(declared),
    activate: (declared && typeof declared === 'object' && typeof (declared as Record<string, unknown>).activate === 'function')
      ? (declared as Record<string, unknown>).activate as (...args: unknown[]) => unknown
      : null,
    deactivate: (declared && typeof declared === 'object' && typeof (declared as Record<string, unknown>).deactivate === 'function')
      ? (declared as Record<string, unknown>).deactivate as (...args: unknown[]) => unknown
      : null
  }
}

/**
 * 一份面板定义 → 宿主可用的 `{ id, mount(doc, ctx), injectStyles? }`。
 *
 * 缺 `mount` 时依次尝试 `render` / `create` / `factory`；一个都没有就返回 null，
 * 由调用方决定报什么 —— 但**能识别出的面板定义一律带上**，不再整块丢掉。
 */
function normalizePanelDefinition(def: unknown, pluginId: string, requestedPanelId: string): PanelDefinition | null {
  if (!def) return null
  if (typeof def === 'function') {
    return { id: requestedPanelId || pluginId, mount: adaptMount(def as AdaptableMount) }
  }
  if (typeof def !== 'object') return null
  const record = def as Record<string, unknown>
  const id = String(record.id || requestedPanelId || pluginId || '').trim()
  if (!id) return null

  const fn = [record.mount, record.render, record.create, record.factory].find((f): f is (...args: unknown[]) => unknown => typeof f === 'function')
  const mount = fn
    ? adaptMount(fn as AdaptableMount)
    : () => { throw new Error(`面板 ${id} 的插件模块没有提供 mount / render 函数`) }
  const out: Record<string, unknown> & Pick<PanelDefinition, 'id' | 'mount'> = { ...record, id, mount }
  return out
}

/**
 * 挂载函数双签名适配。
 *
 * 两种作者写法都支持：
 *   · `mount(doc, ctx)`  —— 第一方面板 / 有文档的人（仓库内全部是这个）；
 *   · `render(input)`    —— 插件作者直觉写法：`input.container / input.document / input.hira`。
 *
 * 判据是**形参个数**（≥2 视作旧签名）。返回值三种都接：DOM 节点 / `{ element }` / undefined
 * （自己写进 `input.container`）。
 */
type AdaptableMount = ((...args: unknown[]) => unknown) & { __hiraAdapted?: boolean }

function adaptMount(fn: AdaptableMount): (doc: Document, ctx: PanelContext) => Promise<PanelInstance> {
  const adapted = Object.assign(async (doc: Document, ctx: PanelContext): Promise<PanelInstance> => {
    const legacy = fn.length >= 2
    const container = doc.createElement('div')
    container.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column;'
    const input = {
      // ctx 的字段摊平到第一层：`panelId / clients / on / events` 直接可用。
      ...(ctx || {}),
      doc,
      document: doc,
      container,
      root: container,
      mount: container,
      panelId: (ctx && ctx.panelId) || '',
      bridge: ctx && ctx.bridge,
      // 作者最常写的 `hira.bookmarks.list(...)` —— 把客户端全表挂到 `hira` 上。
      hira: {
        ...((ctx && ctx.clients) || {}),
        on: ctx && ctx.on,
        events: ctx && ctx.events,
        bridge: ctx && ctx.bridge,
        openWindow: ctx && ctx.openWindow,
        openPage: ctx && ctx.openPage
      }
    }
    const out = legacy ? await fn(doc, ctx) : await fn(input)
    if (out instanceof HTMLElement) return { element: out }
    if (out && typeof out === 'object' && 'element' in out && (out as { element?: unknown }).element instanceof HTMLElement) {
      return out as PanelInstance
    }
    return { element: container }
  }, { __hiraAdapted: true })
  return adapted
}

/** `rendererPlugin.slots` → 只保留 `{ 非空字符串: 函数 }` 的干净表。 */
function normalizeSlots(declared: unknown): Record<string, (...args: unknown[]) => unknown> {
  const slots: Record<string, (...args: unknown[]) => unknown> = {}
  const raw = declared && typeof declared === 'object' ? (declared as Record<string, unknown>).slots : null
  if (!raw || typeof raw !== 'object') return slots
  for (const [slotId, impl] of Object.entries(raw)) {
    const id = String(slotId || '').trim()
    if (!id || typeof impl !== 'function') continue
    slots[id] = impl as (...args: unknown[]) => unknown
  }
  return slots
}

/**
 * 取某个插件贡献的**某一个**面板定义（找不到返回 null）。
 *
 * `panelId` 同时用于函数式单面板的兜底 id —— 因此 `(input)` / `(doc, ctx)` 的简写模块
 * 也能被正确认领。
 *
 * @param {{ id: string, render?: string|null, renderUrl?: string|null }} manifest
 * @param {string} panelId
 */
export async function loadPanelDefinitionFrom(manifest: RenderablePluginManifest, panelId: string) {
  const loaded = await loadRendererPlugin(manifest, panelId)
  if (!loaded) return null
  const exact = loaded.panels.find((def) => def.id === panelId)
  if (exact) return exact
  /**
   * 单面板插件的 **id 写法差异**：manifest 登记的是 `contributes.panels[].id`，
   * 而模块里可能写成别的名字（AI 生成的插件尤其常见）。只有一个候选时不存在歧义，
   * 按登记 id 认领 —— 否则「声明了面板」会永远落到「尚未实现」。
   */
  if (loaded.panels.length === 1) return { ...loaded.panels[0], id: String(panelId) }
  return null
}

/**
 * 该 manifest 是否带**可加载的**渲染侧入口（供宿主在"要不要去问实现"时先短路）。
 *
 * 只判 `render` 非空是不够的：`"render": "panel.html"` 是常见误写（把声明式文档
 * 当模块），非空会让我们去 `import()` 一个 HTML 并必然失败，**反而挡住**后面
 * 那条本来能成功的 `ui` 声明式路径。判定口径与注册中心 / 创作侧共用
 * `isRenderModulePath`。
 */
export function hasRendererEntry(manifest: { render?: unknown } | null | undefined): boolean {
  return !!(manifest && isRenderModulePath(manifest.render))
}


