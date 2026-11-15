/**
 * AI 工作室 · 编排（PART17 §2 / §5）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这一层只做「把纯逻辑的产物交给唯一安装链路」
 * ══════════════════════════════════════════════════════════════════════
 *   core/studio.cjs#prepareArtifact   模型参数 → manifest + 文件清单
 *   main/studio.cjs（本文件）          写暂存目录 → services.studio.install
 *   ipc/plugins.js#installFromPath    体检 / 复制 / rename / afterInstallHook
 *
 * 为什么必须经过 `services.studio`：那条链路已经带着插件列表刷新、启停、面板对账、
 * 语言包 / 迁移 / 主题源刷新、广播。绕开它自己写一遍，等于把"装完为什么没生效"
 * 变成一类只能靠复现排查的问题。
 *
 * 暂存目录命名为 `.install-studio-*`：安装器只认「父目录 === 用户插件目录」且
 * 「名字以 `.install-` 开头」的暂存目录（见 plugin-installer 的 isOwnStaging 守卫）。
 * 装完（无论成败）都在 finally 里清掉。
 */

const fs = require('fs')
const path = require('path')

const studio = require('../core/studio.cjs')
const { summarizePanelContribution, panelUiFromManifest, isRenderModulePath } = require('@hira-ng/shared-types/src/plugin-ui.mjs')

const { MANIFEST_NAME, STUDIO_KINDS, prepareArtifact, capabilities: coreCapabilities, guide: coreGuide } = studio

import type { AiLogger, AiServicesPort, UnknownRecord } from '../types'

interface StudioError extends Error { code: string }
interface SkillItem extends UnknownRecord { id: string; label: string; kind: string; prompt: string; description?: string; enabled?: boolean; source?: string; pluginId?: string }
interface SkillServicePort {
  list(options?: { enabledOnly?: boolean }): { skills: SkillItem[]; kinds: unknown[] }
  save(payload: UnknownRecord): { skill: SkillItem }
  remove(payload: UnknownRecord): unknown
  setEnabled(payload: UnknownRecord): unknown
}
interface StudioInstallApi {
  install(staging: string, options: { overwrite: boolean }): Promise<UnknownRecord>
  uninstall(id: string): Promise<UnknownRecord>
  userDir?(): string
}
interface ArtifactFile { path: string; content: string }
interface PreparedArtifact { id: string; manifest: UnknownRecord; files: ArtifactFile[]; warnings?: string[] }
interface StudioLogger extends AiLogger { log?(...args: unknown[]): void }

function recordOf(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function fail(code: string, message?: string): StudioError {
  const err = new Error(message || code) as StudioError
  err.code = code
  return err
}

/**
 * manifest → 面板摘要。
 *
 * 模型最常问的两句是「为什么没图标」「为什么打开说尚未实现」，答案全在摘要里：
 *   · iconValid = false        → 图标名不在注册表（运行时已回落 Puzzle）
 *   · implementation = 'none'  → 既没有 render 也没有 ui，等于声明了一块画不出来的面板
 * 判定本身在 shared-types，创作侧与清单侧共用同一份。
 */
function summarizePanels(manifest: UnknownRecord): unknown[] {
  const contributes = recordOf(manifest.contributes)
  const list = contributes.panels
  if (!Array.isArray(list)) return []
  // 实现来源要按**同一套判定**算：顶层 ui 可被面板继承，HTML 不能算 render。
  const hasRender = !!manifest.render && isRenderModulePath(manifest.render)
  const manifestUi = panelUiFromManifest(manifest)
  return list.map((panel) => summarizePanelContribution(panel, { hasRender, manifestUi }))
}

/**
 * 把相对路径安全地拼到暂存目录下（写盘前的最后一道守卫）。
 * core 已经校验过，这里是纵深防御：真出问题也是 fail-closed。
 */
function inside(root: string, rel: string): string | null {
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  return abs.startsWith(base + path.sep) ? abs : null
}

/**
 * @param {{
 *   getServices: () => any,
 *   skillService: any,
 *   logger?: any
 * }} deps
 */
function createStudioService({ getServices, skillService, logger = console }: {
  getServices(): AiServicesPort | null | undefined
  skillService: SkillServicePort
  logger?: StudioLogger
}) {
  const services = (): AiServicesPort => (typeof getServices === 'function' ? (getServices() || {}) : {}) as AiServicesPort

  /** 安装端口（未就绪时给出明确原因，而不是静默成功）。 */
  function port(): StudioInstallApi {
    const api = recordOf(services().studio)
    if (!api || typeof api.install !== 'function') {
      throw fail('STUDIO_PORT_MISSING', '插件安装通道尚未就绪，请稍后重试')
    }
    return api as unknown as StudioInstallApi
  }

  function userDir() {
    const api = recordOf(services().studio)
    const dir = api && typeof api.userDir === 'function' ? String(api.userDir() || '') : ''
    if (!dir) throw fail('STUDIO_PORT_MISSING', '用户插件目录不可用')
    return dir
  }

  function capabilities() {
    const base = coreCapabilities()
    let dir = ''
    try { dir = userDir() } catch (_) {}
    return { ...base, userDir: dir }
  }

  /** 固定创作手册：纯静态文本，不需要任何端口就绪。 */
  function guide(req: { section?: string } = {}) {
    return coreGuide(req)
  }

  /** 只做创作规整与面板/文件自检，不写用户插件目录。 */
  function prepare(req: UnknownRecord = {}) {
    const kind = String(req.kind || 'plugin').toLowerCase()
    if (!STUDIO_KINDS.includes(kind)) {
      throw fail('STUDIO_KIND_UNKNOWN', `不支持的产物类型「${kind}」，可选：${STUDIO_KINDS.join(' / ')}`)
    }
    if (kind === 'skill') {
      const skill = req.skill && typeof req.skill === 'object' ? req.skill as UnknownRecord : req
      if (!skill.id || !(skill.label || skill.name) || !skill.prompt) {
        throw fail('STUDIO_SKILL_INVALID', '技能需要 id、label 与 prompt')
      }
      return { ok: true, kind, id: String(skill.id), ready: true }
    }
    const prepared = prepareArtifact(req) as PreparedArtifact
    return {
      ok: true,
      kind,
      id: prepared.id,
      name: prepared.manifest.name || prepared.id,
      ready: true,
      warnings: Array.isArray(prepared.warnings) ? prepared.warnings : [],
      panels: summarizePanels(prepared.manifest),
      files: prepared.files.map((file: ArtifactFile) => file.path)
    }
  }

  /** kind = skill 走技能服务（存数据库，不进插件目录）。 */
  function saveSkill(req: UnknownRecord = {}) {
    const nested = req.skill && typeof req.skill === 'object' ? req.skill as UnknownRecord : null
    const payload = nested || {
      id: req.id,
      label: req.label || req.name,
      prompt: req.prompt,
      kind: req.skillKind || 'prompt',
      icon: req.icon,
      description: req.description
    }
    const out = skillService.save(payload)
    return {
      ok: true,
      kind: 'skill',
      id: out.skill.id,
      name: out.skill.label,
      skillKind: out.skill.kind
    }
  }

  /**
   * 生成并安装一份产物。
   *
   * @param {any} req `studio_create` 的参数（见 PART17 §4）
   */
  async function create(req: UnknownRecord = {}) {
    const input = req
    const kind = String(input.kind || 'plugin').toLowerCase()
    if (!STUDIO_KINDS.includes(kind)) {
      throw fail('STUDIO_KIND_UNKNOWN', `不支持的产物类型「${kind}」，可选：${STUDIO_KINDS.join(' / ')}`)
    }
    if (kind === 'skill') return saveSkill(input)

    const prepared = prepareArtifact(input) as PreparedArtifact
    const root = userDir()
    const staging = path.join(root, `.install-studio-${process.pid}-${Date.now().toString(36)}`)
    fs.mkdirSync(staging, { recursive: true })

    try {
      for (const file of prepared.files) {
        const abs = inside(staging, file.path)
        if (!abs) throw fail('STUDIO_FILE_PATH', `文件路径「${file.path}」越界`)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, file.content, 'utf8')
      }
      fs.writeFileSync(
        path.join(staging, MANIFEST_NAME),
        `${JSON.stringify(prepared.manifest, null, 2)}\n`,
        'utf8'
      )

      const api = port()
      const result = recordOf(await api.install(staging, { overwrite: !!input.overwrite }))
      if (!result.ok) {
        return {
          ok: false,
          kind,
          id: result.id || prepared.id,
          reason: result.reason || '安装失败'
        }
      }
      logger.log?.(`[ai studio] 已安装 ${kind} ${result.id || prepared.id}`)
      const pluginHostPort = recordOf(services().pluginHost)
      const installed = typeof pluginHostPort.list === 'function'
        ? (pluginHostPort.list() as unknown[])
          .map(recordOf)
          .find((item) => String(item.id || '') === String(result.id || prepared.id))
        : null
      return {
        ok: true,
        kind,
        id: result.id || prepared.id,
        name: result.name || prepared.manifest.name || prepared.id,
        version: result.version || prepared.manifest.version || '',
        installed: true,
        // 创作侧的非致命提示（图标回落 / 别名映射 / 入口建议）+ 安装器的提示。
        warnings: [
          ...(Array.isArray(prepared.warnings) ? prepared.warnings : []),
          ...(Array.isArray(result.warnings) ? result.warnings : [])
        ],
        panels: summarizePanels(prepared.manifest),
        files: prepared.files.map((file: ArtifactFile) => file.path),
        enabled: installed ? installed.enabled === true : null,
        failed: installed ? installed.failed === true : null,
        error: installed ? String(installed.error || '') : ''
      }
    } finally {
      // 安装器复制的是暂存目录的副本；暂存目录本身始终要清。
      try { fs.rmSync(staging, { recursive: true, force: true }) } catch (_) {}
    }
  }

  /**
   * 卸载用户安装的产物。内置插件由 `uninstallPlugin` 拒绝（runtime === false），
   * 这里不重复判断 —— 唯一实现只留一处。
   */
  async function remove(req: UnknownRecord = {}) {
    const id = String((req && req.id) || '').trim()
    if (!id) throw fail('STUDIO_ID', '缺少要卸载的 id')
    const api = recordOf(services().studio)
    if (!api || typeof api.uninstall !== 'function') {
      throw fail('STUDIO_PORT_MISSING', '插件卸载通道尚未就绪，请稍后重试')
    }
    const result = recordOf(await api.uninstall(id))
    if (!result.ok) {
      return { ok: false, id, reason: result.reason || '卸载失败' }
    }
    return { ok: true, id, uninstalled: true }
  }

  /**
   * 用户目录里已安装的产物（不含内置）。
   * 只回模型需要的字段 —— `contributes` 有几十 KB，全给会白白吃掉上下文。
   */
  function list(req: UnknownRecord = {}) {
    const api = recordOf(services().pluginHost)
    if (!api || typeof api.list !== 'function') throw fail('STUDIO_PORT_MISSING', '插件目录不可用')
    const kind = String((req && req.kind) || '').toLowerCase()
    const listed = api.list()
    const rows = (Array.isArray(listed) ? listed : [])
      .filter((raw): raw is UnknownRecord => !!raw && typeof raw === 'object' && raw.runtime === true)
      .map((p) => ({
        id: p.id,
        name: p.name || p.id,
        version: p.version || '',
        type: p.type || 'feature-plugin',
        description: p.description || '',
        enabled: !!p.enabled,
        trustLevel: p.trustLevel || 'local',
        permissionLevel: p.permissionLevel || 'ui',
        requestedPermissions: Array.isArray(p.requestedPermissions) ? p.requestedPermissions : [],
        // 面板自查：有 render 入口吗？顶层 ui 是什么？每块面板的 icon 可用吗？靠什么实现？
        render: !!p.render,
        uiEntry: p.uiEntry || null,
        panels: summarizePanels(p)
      }))
      .filter((p) => !kind || p.type === kind ||
        (kind === 'plugin' && (p.type === 'feature-plugin' || p.type === 'ui-panel-plugin')))
    return { ok: true, total: rows.length, plugins: rows }
  }

  // ── 技能（委托 skillService，工具层不碰存储） ────────────────────────
  function skillList(req: UnknownRecord = {}) {
    const out = skillService.list({ enabledOnly: !!(req && req.enabledOnly) })
    return {
      ok: true,
      skills: out.skills.map((s: SkillItem) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        description: s.description || '',
        enabled: s.enabled !== false,
        source: s.source || 'user',
        pluginId: s.pluginId || ''
      })),
      kinds: out.kinds
    }
  }

  function skillSave(req: UnknownRecord = {}) {
    const nested = req.skill && typeof req.skill === 'object' ? req.skill as UnknownRecord : null
    const payload = nested || {
      id: req.id,
      label: req.label || req.name,
      prompt: req.prompt,
      kind: req.skillKind || 'prompt',
      icon: req.icon,
      description: req.description
    }
    return skillService.save(payload)
  }

  function skillRemove(req: UnknownRecord = {}) {
    return skillService.remove({ id: req.id })
  }

  function skillToggle(req: UnknownRecord = {}) {
    return skillService.setEnabled({ id: req.id, enabled: req.enabled !== false })
  }

  function toggle(req: UnknownRecord = {}) {
    const id = String(req.id || '').trim()
    if (!id) throw fail('STUDIO_ID', '缺少插件 id')
    const api = recordOf(services().pluginHost)
    if (!api || typeof api.setEnabled !== 'function') {
      throw fail('STUDIO_PORT_MISSING', '插件启停通道尚未就绪')
    }
    return api.setEnabled(id, req.enabled !== false, false)
  }

  return {
    capabilities,
    guide,
    prepare,
    create,
    remove,
    list,
    skillList,
    skillSave,
    skillRemove,
    skillToggle,
    toggle
  }
}

module.exports = { createStudioService }
