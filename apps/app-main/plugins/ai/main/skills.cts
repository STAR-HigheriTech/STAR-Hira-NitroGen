/**
 * AI 引擎 · 技能服务（PART15 §11 Phase 5）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它只做三件事
 * ══════════════════════════════════════════════════════════════════════
 *   1. **存**：清单 = 插件贡献（只读，随插件装卸自动增减）+ 用户自建（可改可删），
 *      另有 `ai_skill_state` 记录"哪条被关掉"；
 *   2. **搬**：导入导出 `.hira-ai-skill.json`（带 id 冲突重命名，绝不覆盖插件技能）；
 *   3. **跑**：按 kind 分派 —— 模板解析 / 沙箱脚本 / 外部 kind（`ai.skill.kind`）。
 *
 * 三条边界：
 *   · **源页面零改动、脚本进程隔离**：脚本只拿到页面 HTML 快照，在隐藏的
 *     sandbox BrowserWindow 里执行；无 Node、无真实页面、无网络、无持久存储。
 *   · **结果必须可裁剪**：脚本返回值形状未知，统一走 `formatScriptResult` 文本化 + 截断。
 *   · **外部 kind 不进 IPC**：`run` 是函数，结构化克隆会失败 —— `kinds()` 只回展示字段。
 */

const fs = require('fs/promises')
const { BrowserWindow, dialog, session } = require('electron')

const {
  normalizeKinds,
  normalizeSkill,
  toExportFile,
  parseImportFile,
  buildScriptCode,
  formatScriptResult,
  parseTemplate
} = require('../core/skills.cjs')
const { PAGE_WORLD_ID } = require('../core/page.cjs')
const { saveWithDialog } = require('./exporter.cjs')

import type { AiLogger, ExtensionPointPort, UnknownRecord } from '../types'

interface SkillError extends Error { code: string }
interface SkillKind { kind: string; label: string; icon: string; tone: string; external?: boolean }
interface SkillEntry extends UnknownRecord {
  id: string
  label: string
  icon: string
  kind: string
  prompt: string
  description: string
  builtin?: boolean
  source?: string
  pluginId?: string
  pluginName?: string
  group?: string
  sortOrder?: number
  enabled?: boolean
}
interface SkillStorePort {
  listSkillStates(): Record<string, boolean>
  listSkills(): SkillEntry[]
  setSkillEnabled(id: string, enabled: boolean): unknown
  upsertSkill(skill: SkillEntry): SkillEntry | null
  removeSkill(id: string): unknown
}
interface ContributionPort { list(type: string): unknown }
interface SkillTabManager {
  getActiveTabId?(): string | null
  getWebContents?(tabId: string): SkillWebContents | null
}
interface SkillWebContents {
  isDestroyed?(): boolean
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown>
  executeJavaScript?(code: string): Promise<unknown>
}
interface PageSnapshot {
  html: string
  url: string
  title: string
}
interface ExternalSkillImpl extends SkillKind { run?: (ctx: UnknownRecord) => unknown | Promise<unknown> }
interface PluginRegistryPort {
  describe?(): Array<{ id?: unknown; name?: unknown }>
}

function isSkillError(error: unknown): error is SkillError {
  return error instanceof Error && typeof (error as Partial<SkillError>).code === 'string'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

/** 脚本技能的执行上限：脚本是同步遍历 DOM，超过这个时间就是写坏了。 */
const SCRIPT_TIMEOUT = 3000
const SANDBOX_PARTITION = 'ai-skill-sandbox'
const SNAPSHOT_MAX_CHARS = 8 * 1024 * 1024
const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')
const SANDBOX_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"></head><body></body></html>`

function fail(code: string, message?: string): SkillError {
  const err = new Error(message || code) as SkillError
  err.code = code
  return err
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(fail(code, `执行超过 ${Math.round(ms / 1000)} 秒`)), ms)
    })
  ]).finally(() => { clearTimeout(timer) })
}

/** 只保留 id 的合法字符，避免导入文件里的 id 变成奇怪的文件名 / SQL 值。 */
function cleanId(raw: unknown, fallback: string): string {
  const text = String(raw || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return text || fallback
}

function stamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * @param {{
 *   store: any,
 *   extensionPoints?: any,
 *   contributions?: any,
 *   getTabManager: () => any,
 *   notify?: (payload: any) => void,
 *   logger?: any
 * }} deps
 */
function createSkillService({ store, extensionPoints, contributions, getPluginRegistry, getTabManager, notify, logger = console }: {
  store: SkillStorePort
  extensionPoints?: ExtensionPointPort
  contributions?: ContributionPort
  getPluginRegistry?: () => PluginRegistryPort | null | undefined
  getTabManager: () => SkillTabManager | null | undefined
  notify?: (payload: unknown) => void
  logger?: AiLogger
}) {
  /** 外部 kind 的实现（含 `run`）；**只活在主进程**，绝不进 IPC。 */
  function externalImpls(): ExternalSkillImpl[] {
    if (!extensionPoints || typeof extensionPoints.callSync !== 'function') return []
    try {
      const out = extensionPoints.callSync('ai.skill.kind', {})
      return (Array.isArray(out) ? out : []).filter((raw): raw is ExternalSkillImpl => !!raw && typeof raw === 'object' && 'kind' in raw)
    } catch (e) {
      logger.warn?.('[ai] 读取 ai.skill.kind 失败：', errorMessage(e))
      return []
    }
  }

  /** 展示用 kind 列表（内置 + 外部，剥掉函数 —— 否则 IPC 结构化克隆会失败）。 */
  function kinds(): SkillKind[] {
    return normalizeKinds(externalImpls()) as SkillKind[]
  }

  /**
   * 插件贡献的技能（`contributes.skills`）。
   *
   * **单一真源**：不在数据库里对账，每次读取时把清单里的贡献项映射成同一种形状。
   * 好处是插件升级改文案自动生效、插件停用自动消失，零同步代码。
   * @returns {any[]}
   */
  function pluginSkills(): SkillEntry[] {
    if (!contributions || typeof contributions.list !== 'function') return []
    let items: unknown[] = []
    try {
      const contributed = contributions.list('skills')
      items = Array.isArray(contributed) ? contributed : []
    } catch (e) {
      logger.warn?.('[ai] 读取插件技能失败：', errorMessage(e))
      return []
    }
    const known: SkillKind[] = kinds() as SkillKind[]
    const pluginNames = new Map<string, string>()
    try {
      const registry = typeof getPluginRegistry === 'function' ? getPluginRegistry() : null
      for (const plugin of registry && typeof registry.describe === 'function' ? registry.describe() : []) {
        const id = String(plugin && plugin.id || '')
        if (id) pluginNames.set(id, String(plugin.name || id))
      }
    } catch (_) {}
    return (Array.isArray(items) ? items : [])
      .filter((raw): raw is UnknownRecord => {
        if (!raw || typeof raw !== 'object') return false
        const item = raw as Record<string, unknown>
        return !!item.id && (!!item.prompt || !!item.label)
      })
      .map((s, index) => {
        const wanted = String(s.kind || '').toLowerCase()
        const kind = known.some((candidate) => candidate.kind === wanted) ? wanted : 'prompt'
        const meta = known.find((candidate) => candidate.kind === kind) || { icon: 'Zap' }
        const pluginId = String(s.pluginId || '')
        return {
          id: String(s.id),
          label: String(s.label || s.id),
          icon: String(s.icon || meta.icon || 'Zap'),
          kind,
          prompt: String(s.prompt || ''),
          description: String(s.description || ''),
          builtin: true,
          source: 'plugin',
          pluginId,
          pluginName: pluginNames.get(pluginId) || pluginId,
          group: String(s.group || '通用'),
          sortOrder: Number(s.sortOrder) || index
        }
      })
  }

  /** 插件技能 + 用户自建，合并且带上单条启停状态（未记录 = 启用）。 */
  function allSkills(): SkillEntry[] {
    const states = store.listSkillStates()
    const merged = [...pluginSkills(), ...store.listSkills()]
    return merged.map((s) => ({ ...s, enabled: states[s.id] !== false }))
  }

  function findSkill(id: unknown): SkillEntry | null {
    return allSkills().find((s) => s.id === String(id || '')) || null
  }

  /** @param {{ enabledOnly?: boolean }} [req] */
  function list(req: { enabledOnly?: boolean } = {}) {
    const skills = allSkills()
    return {
      ok: true,
      skills: req.enabledOnly ? skills.filter((s) => s.enabled) : skills,
      kinds: kinds()
    }
  }

  /** 单条启停。插件贡献的技能不能改内容，但可以关掉（本地状态，落 `ai_skill_state`）。 */
  function setEnabled(req: UnknownRecord = {}) {
    const id = String(req.id || '')
    const existing = findSkill(id)
    if (!existing) throw fail('AI_SKILL_NOT_FOUND', '技能不存在')
    store.setSkillEnabled(id, req.enabled !== false)
    if (typeof notify === 'function') notify({ reason: 'skills' })
    return { ok: true, skill: findSkill(id) }
  }

  function save(req: UnknownRecord = {}) {
    const existing = findSkill(req.id)
    if (existing && existing.source === 'plugin') throw fail('AI_SKILL_BUILTIN', '插件贡献的技能不能修改（可以另存为新技能）')
    const skill = store.upsertSkill(normalizeSkill(req, { kinds: kinds() }))
    if (typeof notify === 'function') notify({ reason: 'skills' })
    return { ok: true, skill }
  }

  function remove(req: UnknownRecord = {}) {
    const existing = findSkill(req.id)
    if (existing && existing.source === 'plugin') throw fail('AI_SKILL_BUILTIN', '插件贡献的技能不能删除（停用插件或在技能里关掉它）')
    store.removeSkill(String(req.id || ''))
    if (typeof notify === 'function') notify({ reason: 'skills' })
    return { ok: true }
  }

  // ── 导入 / 导出 ──────────────────────────────────────────────────────
  async function exportFile(req: UnknownRecord = {}) {
    const ids = Array.isArray(req.ids) ? req.ids.map(String) : []
    const all = store.listSkills()
    const list = ids.length ? all.filter((s: SkillEntry) => ids.includes(s.id)) : all
    if (!list.length) throw fail('AI_SKILL_EMPTY', '没有可导出的技能')

    try {
      return await saveWithDialog({
        content: toExportFile(list),
        defaultName: 'hira-ai-skill.json',
        filters: [{ name: 'Hira 技能', extensions: ['json'] }]
      })
    } catch (e) {
      logger.warn?.('[ai] 技能导出失败：', errorMessage(e))
      throw fail('AI_EXPORT_FAILED', `导出失败：${errorMessage(e)}`)
    }
  }

  async function importFile() {
    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Hira 技能', extensions: ['json'] }]
    })
    if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths.length) {
      return { ok: false, code: 'AI_SKILL_IMPORT_CANCELED', message: '已取消导入' }
    }

    let text
    try {
      text = await fs.readFile(picked.filePaths[0], 'utf8')
    } catch (e) {
      throw fail('AI_SKILL_IMPORT_INVALID', `读取文件失败：${errorMessage(e)}`)
    }

    const incoming = parseImportFile(text)
    const known = kinds()
    const used = new Set(allSkills().map((s) => s.id))
    let imported = 0

    for (const raw of incoming) {
      const base = cleanId(raw.id, `k_${stamp()}`)
      let id = base
      let n = 2
      while (used.has(id)) id = `${base}-${n++}`
      used.add(id)
      store.upsertSkill(normalizeSkill({ ...raw, id }, { kinds: known }))
      imported++
    }

    if (typeof notify === 'function') notify({ reason: 'skills' })
    return { ok: true, imported, skills: list().skills }
  }

  // ── 执行 ────────────────────────────────────────────────────────────
  /** 活动标签的 webContents（脚本技能只能操作"眼前这一页"）。 */
  function activeWebContents(): SkillWebContents | null {
    let tm: SkillTabManager | null | undefined
    try { tm = getTabManager() } catch (_) { return null }
    if (!tm) return null
    const tabId = typeof tm.getActiveTabId === 'function' ? tm.getActiveTabId() : null
    return tabId && typeof tm.getWebContents === 'function' ? tm.getWebContents(tabId) : null
  }

  let sandboxBusy = false
  let sandboxConfigured = false

  function prepareSandboxSession() {
    const sandboxSession = session.fromPartition(SANDBOX_PARTITION)
    if (!sandboxConfigured) {
      sandboxSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*', 'ftp://*/*'] },
        (_details: unknown, callback: (response: { cancel: boolean }) => void) => callback({ cancel: true })
      )
      sandboxSession.setPermissionRequestHandler((
        _webContents: unknown,
        _permission: string,
        callback: (allowed: boolean) => void
      ) => callback(false))
      sandboxSession.setPermissionCheckHandler(() => false)
      sandboxConfigured = true
    }
    return sandboxSession
  }

  async function pageSnapshot(wc: SkillWebContents): Promise<PageSnapshot> {
    const raw = await withTimeout(
      wc.executeJavaScriptInIsolatedWorld(PAGE_WORLD_ID, [{
        code: `(() => {
          const root = document.documentElement;
          return {
            html: root ? "<!doctype html>\\n" + root.outerHTML : "",
            url: location.href,
            title: document.title
          };
        })()`
      }]),
      SCRIPT_TIMEOUT,
      'AI_SKILL_TIMEOUT'
    )
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const html = String(record.html || '')
    if (!html) throw fail('AI_SKILL_EMPTY_PAGE', '当前页面没有可读取的 DOM')
    if (html.length > SNAPSHOT_MAX_CHARS) {
      throw fail('AI_SKILL_PAGE_TOO_LARGE', `页面快照超过 ${Math.round(SNAPSHOT_MAX_CHARS / 1024 / 1024)}MB，脚本技能已拒绝执行`)
    }
    return {
      html,
      url: String(record.url || ''),
      title: String(record.title || '')
    }
  }

  /**
   * 在独立、隐藏、无网络的 sandbox renderer 里执行脚本技能。
   *
   * 源页面只负责导出 HTML；即使脚本拿到 `window`、`fetch` 或死循环，影响的也只是
   * 一个短暂存在的沙箱页面。超时会直接销毁 renderer，而不是留下一个卡死的标签页。
   */
  async function runScript(skill: SkillEntry, args: Record<string, unknown>) {
    const wc = activeWebContents()
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      throw fail('AI_SKILL_NO_TAB', '当前没有可执行的页面')
    }
    if (sandboxBusy) throw fail('AI_SKILL_BUSY', '另一个脚本技能正在执行，请稍后重试')
    sandboxBusy = true

    let sandbox: Electron.BrowserWindow | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const sandboxSession = prepareSandboxSession()
    try {
      const snapshot = await pageSnapshot(wc)
      await sandboxSession.clearStorageData()
      await sandboxSession.clearCache()

      const activeSandbox = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
          partition: SANDBOX_PARTITION,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: false,
          spellcheck: false,
          backgroundThrottling: false,
          webviewTag: false,
          disableDialogs: true
        }
      })
      sandbox = activeSandbox
      const work = (async () => {
        const contents = activeSandbox.webContents
        contents.setWindowOpenHandler(() => ({ action: 'deny' }))
        contents.on('will-navigate', (event: { preventDefault(): void }) => event.preventDefault())
        contents.on('will-redirect', (event: { preventDefault(): void }) => event.preventDefault())
        contents.on('will-attach-webview', (event: { preventDefault(): void }) => event.preventDefault())

        await activeSandbox.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SANDBOX_DOCUMENT)}`)
        const html = JSON.stringify(snapshot.html)
        const policy = JSON.stringify(SANDBOX_CSP)
        await contents.executeJavaScript(`(() => {
          for (const name of [
            "fetch", "XMLHttpRequest", "WebSocket", "WebTransport", "EventSource",
            "Worker", "SharedWorker", "RTCPeerConnection", "webkitRTCPeerConnection"
          ]) {
            try {
              Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false })
            } catch (_) {}
          }
          try {
            Object.defineProperty(Navigator.prototype, "sendBeacon", {
              value: undefined,
              writable: false,
              configurable: false
            })
          } catch (_) {}
          const parsed = new DOMParser().parseFromString(${html}, "text/html")
          parsed.querySelectorAll('script,meta[http-equiv="refresh" i],meta[http-equiv="content-security-policy" i],link[rel="preload" i],link[rel="prefetch" i]').forEach((node) => node.remove())
          const root = parsed.documentElement
          if (!root) throw new Error("页面快照缺少 documentElement")
          document.replaceChild(document.importNode(root, true), document.documentElement)
          const meta = document.createElement("meta")
          meta.httpEquiv = "Content-Security-Policy"
          meta.content = ${policy}
          document.head.appendChild(meta)
          return true
        })()`)
        return contents.executeJavaScript(buildScriptCode(skill.prompt, args))
      })()

      const guard = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try { sandbox?.destroy() } catch (_) {}
          reject(fail('AI_SKILL_TIMEOUT', `执行超过 ${Math.round(SCRIPT_TIMEOUT / 1000)} 秒`))
        }, SCRIPT_TIMEOUT)
      })
      const value = await Promise.race([work, guard])
      const text = formatScriptResult(value)
      if (!text) throw fail('AI_SKILL_EMPTY_RESULT', '脚本没有返回内容')
      return {
        ok: true,
        kind: 'script',
        text,
        title: skill.label,
        result: { text, title: skill.label }
      }
    } catch (e) {
      if (isSkillError(e)) throw e
      throw fail('AI_SKILL_SCRIPT_FAILED', `脚本执行失败：${errorMessage(e)}`)
    } finally {
      if (timer) clearTimeout(timer)
      try { sandbox?.destroy() } catch (_) {}
      try { await sandboxSession.clearStorageData() } catch (_) {}
      sandboxBusy = false
    }
  }

  /** 外部 kind：实现由别的插件提供（`{ kind, label, icon, run(ctx) }`）。 */
  async function runExternal(skill: SkillEntry, impl: ExternalSkillImpl, args: Record<string, unknown>) {
    if (typeof impl.run !== 'function') throw fail('AI_SKILL_NO_RUNNER', `技能类型「${skill.kind}」没有实现 run`)
    let out
    try {
      out = await impl.run({ skill, args: args || {}, getTabManager, logger })
    } catch (e) {
      if (isSkillError(e)) throw e
      throw fail('AI_SKILL_SCRIPT_FAILED', `执行失败：${errorMessage(e)}`)
    }
    const result = out && typeof out === 'object' ? out as Record<string, unknown> : {}
    const nested = result.result && typeof result.result === 'object' ? result.result as Record<string, unknown> : {}
    const text = typeof out === 'string' ? out : String(result.text || nested.text || '')
    if (!text) throw fail('AI_SKILL_EMPTY_RESULT', '技能没有返回内容')
    return {
      ok: true,
      kind: skill.kind,
      text,
      title: result.title || skill.label,
      autoSend: !!result.autoSend,
      result: { text, title: result.title || skill.label }
    }
  }

  /**
   * 执行一条技能。
   *   · `id`    —— 已保存的技能；
   *   · `draft` —— 设置页「试运行」：还没保存的那一条。
   * `prompt` / `agent` 只回模板（真正发送由渲染层收集 chip 后触发）。
   */
  async function run(req: UnknownRecord = {}) {
    const args: Record<string, unknown> = req.args && typeof req.args === 'object'
      ? req.args as Record<string, unknown>
      : {}
    const known = kinds()

    let skill = req.id ? findSkill(req.id) : null
    if (!skill && req.draft) {
      const draft = req.draft as Record<string, unknown>
      skill = normalizeSkill({ ...draft, id: cleanId(draft.id, 'draft') }, { kinds: known })
    }
    if (!skill) throw fail('AI_SKILL_NOT_FOUND', '技能不存在')

    if (skill.kind === 'script') return runScript(skill, args)

    const impl = externalImpls().find((x) => String(x.kind).toLowerCase() === skill.kind)
    if (impl) return runExternal(skill, impl, args)

    const parsed = parseTemplate(skill.prompt)
    return {
      ok: true,
      kind: skill.kind,
      text: parsed.text,
      needs: parsed.needs,
      params: parsed.params,
      autoSend: skill.kind === 'agent'
    }
  }

  return { kinds, list, save, remove, setEnabled, exportFile, importFile, run }
}

module.exports = { createSkillService }
