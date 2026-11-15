// @ts-check
/**
 * 编排内核 —— 拥有全部状态与全部动作：拉清单 / 启停 / 安装 / 卸载 / 热重载 /
 * 插件源 / 签名公钥 / 授权。它**不拥有任何 DOM**：画什么完全由注入进来的 `view` 决定。
 *
 * 为什么状态与动作要收在这里、而不是散在页面脚本里：
 *   · 时序只有一个口径（先清单 → 再公钥 → 最后出网的插件源），不会出现两处
 *     refresh 各自决定「先拉哪个」的分叉；
 *   · 「卸载要不要二次确认」「连带禁用要不要先问」这种语义只有**一份**实现，
 *     改一次就全页面一致，不存在漏改某一个按钮的情况。
 *
 * 能力协商靠**鸭子类型**：`view.setMarket` 存在才去拉市场，`view.setTrustedKeys`
 * 存在才去拉公钥。（本页两者都实现；这个判据留给以后的精简形态复用。）
 *
 * 端口注入：`clients` / `on` / `confirm` 全部由宿主给 —— 本文件不认识 IPC，
 * 也不认识 DOM 之外的世界，于是换一个宿主（浮动小窗 / 命令面板里的列表）
 * 只是换一个 `view`，本文件一行都不用改。
 */
import { IPC_EVENTS } from 'hira://shared/runtime.js'
import { errorMessage, isRecord } from 'hira://shared/page-kit.js'
import { TRUST_LEVEL_LABEL, isPluginPageUrl, signatureSuffix } from './format.js'
import type {
  MarketState,
  PluginActionResult,
  PluginControllerPorts,
  PluginIntent,
  PluginRecord
} from './types.js'

/**
 * @param {{
 *   clients: unknown,
 *   on?: (event: string, handler: Function) => void,
 *   confirm?: (opts: unknown) => Promise<boolean>,
 *   view: {
 *     element: HTMLElement,
 *     setItems: (items: unknown[]) => void,
 *     setItemsError?: () => void,
 *     setNotice: (text: string, kind?: 'info'|'error') => void,
 *     setTrustedKeys?: (keys: unknown[]) => void,
 *     setMarket?: (state: unknown) => void,
 *     setSkills?: (skills: unknown[], kinds: unknown[]) => void,
 *     setSkillsError?: (message: string) => void,
 *     setUserScripts?: (scripts: unknown[]) => void,
 *     setUserScriptsError?: (message: string) => void
 *   }
 * }} ports
 */
export function createPluginsController({ clients, on, confirm, view }: PluginControllerPorts) {
  /** 最近一次拉到手的清单。卸载确认框要写**插件名**而不是 id（「删除 panel-xxx」对用户没有意义）。 */
  let currentItems: PluginRecord[] = []
  /**
   * 最近一次拉到手的**市场状态**（含已配的源列表）。
   *
   * 为什么留一份：增 / 删源走的是「**整表提交**」（顺序即优先级，只有整表能表达），
   * 所以「加一条」必须先知道当前有哪些源。从 DOM 里读那串 URL 等于让编排层依赖渲染细节。
   */
  interface RefreshOptions { forceMarket?: boolean }
  let currentMarket: MarketState = { ok: false, sources: [], entries: [] }
  let itemsRequest = 0
  let trustRequest = 0
  let marketRequest = 0
  let skillsRequest = 0
  let scriptsRequest = 0
  let reconcileTimer = 0

  function scheduleReconcile(): void {
    clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => { refresh() }, 48) as unknown as number
  }

  /**
   * 只重拉技能（不碰插件清单 / 公钥 / 插件源）。
   *
   * 技能动作不需要出网，也不该顺带刷新整张插件页 —— 一次「关掉一条技能」
   * 触发四五次 IPC 与一次市场网络请求，是没必要的卡顿。
   */
  async function refreshSkills(): Promise<void> {
    const setSkills = view.setSkills
    if (typeof setSkills !== 'function') return
    const request = ++skillsRequest
    try {
      const res = await clients.aiSkillList()
      if (request !== skillsRequest) return
      if (res && res.ok === false) throw new Error(res.message || '无法读取技能')
      setSkills(Array.isArray(res.skills) ? res.skills : [], Array.isArray(res.kinds) ? res.kinds : [])
    } catch (_) {
      if (request !== skillsRequest) return
      if (typeof view.setSkillsError === 'function') {
        view.setSkillsError('AI 引擎不可用（ai-engine 插件可能被停用）')
      }
    }
  }

  /** 用户脚本与插件清单是两级粒度：只重拉脚本，不惊动插件源与技能。 */
  async function refreshUserScripts(): Promise<void> {
    const setUserScripts = view.setUserScripts
    if (typeof setUserScripts !== 'function') return
    const request = ++scriptsRequest
    try {
      const scripts = await clients.listUserScripts()
      if (request === scriptsRequest) setUserScripts(scripts)
    } catch (_) {
      if (request !== scriptsRequest) return
      if (typeof view.setUserScriptsError === 'function') {
        view.setUserScriptsError('无法读取用户脚本（插件表面层可能尚未就绪）')
      }
    }
  }

  async function refreshItems(): Promise<void> {
    const request = ++itemsRequest
    try {
      const items = await clients.list()
      if (request !== itemsRequest) return
      currentItems = items
      view.setItems(items)
    } catch (_) {
      if (request === itemsRequest) {
        if (typeof view.setItemsError === 'function') view.setItemsError()
        view.setNotice('加载插件清单失败', 'error')
      }
    }
  }

  async function refreshTrustedKeys(): Promise<void> {
    const setTrustedKeys = view.setTrustedKeys
    if (typeof setTrustedKeys !== 'function') return
    const request = ++trustRequest
    try {
      const keys = await clients.listTrustedKeys()
      if (request === trustRequest) setTrustedKeys(keys)
    } catch (_) {
      // 拉不到公钥是“没有公钥”的可继续状态，不抢插件列表的错误提示。
      if (request === trustRequest) setTrustedKeys([])
    }
  }

  async function refreshMarket(force = false): Promise<void> {
    const setMarket = view.setMarket
    if (typeof setMarket !== 'function') return
    const request = ++marketRequest
    try {
      const next = await clients.marketList({ force })
      if (request !== marketRequest) return
      currentMarket = {
        ok: next.ok === true,
        sources: next.sources || [],
        entries: next.entries || [],
        reason: next.reason
      }
    } catch (error) {
      if (request !== marketRequest) return
      currentMarket = { ok: false, sources: [], entries: [], reason: errorMessage(error, '插件源不可用') }
    }
    setMarket(currentMarket)
  }

  async function refresh(opts: RefreshOptions = {}): Promise<void> {
    const jobs = [refreshItems(), refreshSkills(), refreshUserScripts()]
    if (typeof view.setTrustedKeys === 'function') jobs.push(refreshTrustedKeys())
    if (typeof view.setMarket === 'function') jobs.push(refreshMarket(!!opts.forceMarket))
    await Promise.all(jobs)
  }

  /** 整表提交源列表（增 / 删都走它），成功后重拉一次。 */
  function submitSources(nextUrls: string[]): Promise<void> {
    view.setNotice('正在保存插件源…')
    return clients.marketSetSources(nextUrls)
      .then((res) => {
        if (!res || res.ok !== true) {
          view.setNotice((res && res.reason) || '插件源列表保存失败', 'error')
          return refresh()
        }
        view.setNotice('')
        return refresh()
      })
      .catch((error) => {
        view.setNotice(errorMessage(error, '插件源列表保存失败'), 'error')
        return refresh()
      })
  }

  /**
   * 执行一次启停，并把失败原因回显。
   * @param {string} id
   * @param {boolean} enabled
   * @param {{ cascade?: boolean }} [opts]
   */
  function applyToggle(id: string, enabled: boolean, opts: { cascade?: boolean } = {}): Promise<PluginActionResult> {
    return clients.setEnabled(id, enabled, opts).then((res) => {
      if (res && res.ok !== true) {
        view.setNotice(res.reason || '操作未能生效', 'error')
      } else if (res && Array.isArray(res.restored) && res.restored.length) {
        // 顺带恢复的前置要**告知**：用户没点名要开它们，但这次启用隐含了。
        // 静默恢复会让人下次看到「我明明关过的东西怎么开着」—— 那是信任问题，不是信息问题。
        view.setNotice(`已一并启用前置：${res.restored.map((item) => item).join('、')}`)
      }
      refresh()
      return res
    })
  }

  /** 安装结果 → 一句话（签名状态是「这个包的来路」的唯一线索）。 */
  function announceInstall(prefix: string, res: PluginActionResult, extra = ''): void {
    const sigText = signatureSuffix(isRecord(res.signature) && typeof res.signature.status === 'string' ? res.signature : null)
    const warn = Array.isArray(res.warnings) && res.warnings.length ? `（跳过 ${res.warnings.length} 项，见日志）` : ''
    const ver = res.version ? ` ${res.version}` : ''
    view.setNotice(`${prefix} ${res.name || res.id}${ver}${extra || ''}${sigText}${warn}`)
  }

  const fail = (error: unknown, fallback = '操作失败'): void => view.setNotice(errorMessage(error, fallback), 'error')

  /** 技能错误码 → 人话。空串 = 用户取消，保持沉默。 */
  const SKILL_ERROR: Readonly<Record<string, string>> = Object.freeze({
    AI_EXPORT_CANCELED: '',
    AI_SKILL_IMPORT_CANCELED: '',
    AI_SKILL_IMPORT_INVALID: '文件格式不对，需要 Hira 技能文件（.hira-ai-skill.json）',
    AI_SKILL_IMPORT_EMPTY: '文件里没有可导入的技能',
    AI_SKILL_EMPTY: '没有可导出的技能（插件贡献的技能不参与导出）',
    AI_SKILL_BUILTIN: '插件贡献的技能不能修改',
    AI_SKILL_INVALID: '技能内容不完整（名称与内容都不能为空）',
    AI_SKILL_NOT_FOUND: '技能不存在',
    AI_SKILL_NO_TAB: '当前没有可执行的页面',
    AI_SKILL_TIMEOUT: '脚本执行超时（3 秒）',
    AI_SKILL_SCRIPT_FAILED: '脚本执行出错',
    AI_SKILL_EMPTY_RESULT: '脚本没有返回内容',
    AI_EXPORT_FAILED: '导出失败'
  })

  /**
   * 技能动作的统一收尾：成功提示 + 只刷新技能（不惊动插件源 / 市场）。
   *
   * 成功与失败走**两条完全不同的取文案路径**：成功用 `okText`（失败文案在这时候
   * 是错的），失败才查错误码表。合并成一个 `fallback` 参数会让「导出成功」显示成
   * 「导出失败」—— 这类文案错位比不提示更糟。
   */
  function settleSkill(res: PluginActionResult | null | undefined, okText = '', failText = ''): Promise<PluginActionResult> {
    const result: PluginActionResult = res || {}
    const ok = result.ok !== false && !result.canceled
    const code = String(result.code || '')
    if (ok) {
      view.setNotice(String(result.message || '') || okText || '')
    } else if (code in SKILL_ERROR) {
      const text = SKILL_ERROR[code]
      // 空串 = 用户取消：清掉上一条提示，但不弹红字
      view.setNotice(text, text ? 'error' : 'info')
    } else {
      view.setNotice(String(result.message || '') || failText || '操作失败', 'error')
    }
    return refreshSkills().then(() => result)
  }

  /**
   * 唯一的意图入口。视图把点击翻译成意图丢进来，这里负责**语义**。
   * 视图没画出来的动作自然到不了这里 —— 这是能力的天然边界，不需要白名单。
   */
  function dispatch(intent: PluginIntent = {}): unknown {
    const type = String(intent.type || '')
    const id = String(intent.id || '')
    const enabled = intent.enabled === true
    const scopes = typeof intent.scopes === 'string' ? intent.scopes : ''
    const source = typeof intent.source === 'string' ? intent.source : ''
    const key = typeof intent.key === 'string' ? intent.key : ''
    const keyId = typeof intent.keyId === 'string' ? intent.keyId : ''
    const url = typeof intent.url === 'string' ? intent.url : ''
    const level = typeof intent.level === 'string' ? intent.level : ''
    const direction = Number(intent.direction) || 0
    if (!type) return

    if (type === 'refresh-all') {
      view.setNotice('正在刷新…')
      return refresh({ forceMarket: true }).then(() => view.setNotice('已刷新'))
    }

    if (type === 'userscript-refresh') {
      return refreshUserScripts()
    }

    if (type === 'page-open') {
      const target = String(url || '')
      if (!isPluginPageUrl(target)) {
        view.setNotice('页面地址无效', 'error')
        return Promise.resolve(null)
      }
      const owner = currentItems.find((plugin) => plugin.id === intent.pluginId)
      if (owner && owner.enabled !== true) {
        view.setNotice('所属插件已停用，页面当前不可用', 'error')
        return Promise.resolve(null)
      }
      view.setNotice('正在打开页面…')
      return clients.openPage(target)
        .then(() => view.setNotice(`已打开${intent.title ? `「${intent.title}」` : '插件页面'}`))
        .catch((e) => { fail(e, '无法打开插件页面'); return null })
    }

    if (type === 'userscript-toggle') {
      view.setNotice('')
      return clients.setUserScriptEnabled(key, enabled)
        .then((res) => {
          if (!res || res.ok !== true) view.setNotice((res && res.reason) || '脚本状态未能保存', 'error')
          else view.setNotice(enabled ? '已启用脚本（下一次页面加载生效）' : '已关闭脚本')
          return refreshUserScripts().then(() => res)
        })
        .catch((e) => {
          fail(e, '脚本状态未能保存')
          return refreshUserScripts()
        })
    }

    // ── AI 技能（插件贡献 + 用户自建）────────────────────────────────
    // 返回值统一交给视图：试运行 / 保存要拿 `res` 决定「输出什么、表单关不关」。
    if (type === 'skill-refresh') {
      refreshSkills()
      return
    }

    if (type === 'skill-toggle') {
      view.setNotice('')
      return clients.aiSkillSetEnabled(id, enabled)
        .then((res) => settleSkill(res, ''))
        .catch((e) => { fail(e, '操作未能生效'); return refreshSkills() })
    }

    if (type === 'skill-save') {
      return clients.aiSkillSave({
        id,
        label: intent.label,
        description: intent.description,
        prompt: intent.prompt,
        kind: intent.kind,
        icon: intent.icon
      })
        .then((res) => settleSkill(res, '已保存', '保存失败'))
        .catch((e) => { fail(e, '保存失败'); return null })
    }

    if (type === 'skill-remove') {
      if (typeof confirm !== 'function') return
      const name = intent.label || id
      return confirm({
        title: '删除技能',
        message: `删除「${name}」？这条技能的内容会一并移除，此操作不可撤销。`,
        danger: true,
        confirmLabel: '删除'
      }).then((ok) => {
        if (!ok) return null
        return clients.aiSkillRemove(id)
          .then((res) => settleSkill(res, '已删除', '删除失败'))
          .catch((e) => { fail(e, '删除失败'); return null })
      })
    }

    if (type === 'skill-export') {
      return clients.aiSkillExport(intent.ids)
        .then((res) => settleSkill(res, '已导出技能文件', '导出失败'))
        .catch((e) => { fail(e, '导出失败'); return null })
    }

    if (type === 'skill-import') {
      return clients.aiSkillImport()
        .then((res) => settleSkill(
          res,
          res && res.imported ? `已导入 ${Number(res.imported) || 0} 条技能` : '导入完成',
          '导入失败'
        ))
        .catch((e) => { fail(e, '导入失败'); return null })
    }

    if (type === 'skill-run') {
      return clients.aiSkillRun({ draft: intent.draft })
        .catch(() => ({ ok: false, message: '运行失败' }))
    }

    if (type === 'userscript-install-text') {
      const text = String(intent.text || '').trim()
      if (!text) {
        view.setNotice('脚本内容不能为空', 'error')
        return Promise.resolve({ ok: false, reason: '脚本内容不能为空' })
      }
      view.setNotice('正在安装用户脚本…')
      const install = (overwrite = false) => clients.installUserscript({ text, overwrite })
      const settle = (res: PluginActionResult | null | undefined) => {
        if (!res || res.ok !== true) {
          view.setNotice((res && res.reason) || '安装失败', 'error')
          return res
        }
        announceInstall('已安装用户脚本', res)
        return refresh().then(() => res)
      }
      return install(false).then((res) => {
        const reason = String((res && res.reason) || '')
        if (!res || res.ok === true || !/已安装|已存在|覆盖安装/i.test(reason) || typeof confirm !== 'function') {
          return settle(res)
        }
        return confirm({
          title: '覆盖用户脚本',
          message: `${reason}\n\n覆盖会替换同 ID 的现有脚本。确定继续吗？`,
          danger: true,
          confirmLabel: '覆盖安装'
        }).then((ok) => {
          if (!ok) { view.setNotice(''); return res }
          view.setNotice('正在覆盖安装…')
          return install(true).then(settle)
        })
      }).catch((e) => { fail(e, '安装失败'); return { ok: false, reason: '安装失败' } })
    }

    /**
     * 安装（社区市场）：**主进程弹系统选择框**（渲染层不做文件对话框）。
     * 三种结果必须分开说，因为下一步完全不同：
     *   · `canceled` —— 用户自己取消了，**不是错误**（弹红字会让人以为出了问题）；
     *   · `ok:true`  —— 装好了，顺带把签名状态报出来；
     *   · 其余       —— 失败，原因原样回显（体检不过 / 撞名 / 压缩包坏 / 目录穿越…）。
     */
    if (type === 'install') {
      view.setNotice('正在安装…')
      const install = (overwrite = false) => source === 'userscript'
        ? clients.installUserscript({ overwrite })
        : clients.installPlugin({ source, overwrite })
      const settle = (res: PluginActionResult | null | undefined) => {
        if (res && res.canceled) { view.setNotice(''); return null }
        if (!res || res.ok !== true) {
          view.setNotice((res && res.reason) || '安装失败', 'error')
          refresh()
          return res
        }
        announceInstall('已安装', res)
        return refresh().then(() => res)
      }
      install(false).then((res) => {
        const reason = String((res && res.reason) || '')
        if (!res || res.ok === true || !/已安装|已存在|覆盖安装/i.test(reason) || typeof confirm !== 'function') {
          return settle(res)
        }
        return confirm({
          title: '覆盖安装',
          message: `${reason}\n\n覆盖会替换同 ID 插件的现有文件。确定继续吗？`,
          danger: true,
          confirmLabel: '选择文件并覆盖'
        }).then((ok) => {
          if (!ok) { view.setNotice(''); return null }
          view.setNotice('正在覆盖安装…')
          return install(true).then(settle)
        })
      }).catch((e) => { fail(e, '安装失败'); refresh() })
      return
    }

    // 打开用户插件目录（安装失败的兜底路径 / 想手工看一眼时用）
    if (type === 'open-dir') {
      view.setNotice('正在打开插件目录…')
      clients.openPluginDir()
        .then((res) => {
          if (!res || res.ok !== true) view.setNotice('无法打开插件目录', 'error')
          else view.setNotice(`已打开：${res.path}`)
        })
        .catch(() => view.setNotice('无法打开插件目录', 'error'))
      return
    }

    /**
     * 卸载：**必须二次确认**。
     *
     * 它不可撤销（文件被删了），而它在界面上的邻居是「重建的重新加载」与「随时能开回来的开关」——
     * 三者挨在一起，用户按错一下的代价却完全不同。确认框里把插件名写出来。
     */
    if (type === 'uninstall') {
      const name = (currentItems.find((p) => p.id === id) || {}).name || id
      if (typeof confirm !== 'function') return
      confirm({
        title: '卸载插件',
        message: `将从用户插件目录里删除「${name}」及其全部文件，此操作不可撤销。确定继续吗？`,
        danger: true,
        confirmLabel: '卸载'
      }).then((ok) => {
        if (!ok) return undefined
        view.setNotice('正在卸载…')
        return clients.uninstallPlugin(id)
          .then((res) => {
            if (!res || res.ok !== true) view.setNotice((res && res.reason) || '卸载失败', 'error')
            else view.setNotice(`已卸载 ${name}`)
            return refresh()
          })
      }).catch((e) => { fail(e, '卸载失败'); refresh() })
      return
    }

    // ── 插件源（社区市场）：增 / 删 / 刷新 / 一键安装或更新 ──────────────
    if (type === 'market-add-source') {
      const next = currentMarket.sources.map((s) => s.url)
      const target = String(url || '').trim()
      if (!target) return
      // 已经配过就**不重复添加**：静默成功会让人以为「加了两遍也许更快」
      if (next.includes(target)) {
        view.setNotice('这个插件源已经在列表里了')
        return
      }
      next.push(target)
      submitSources(next)
      return
    }

    if (type === 'market-move-source') {
      const next = currentMarket.sources.map((item) => item.url).filter(Boolean)
      const from = next.indexOf(url)
      const to = from + (Number(direction) || 0)
      if (from < 0 || to < 0 || to >= next.length) return
      const moved = next.splice(from, 1)[0]
      next.splice(to, 0, moved)
      submitSources(next)
      return
    }

    if (type === 'market-remove-source') {
      const next = currentMarket.sources.map((s) => s.url).filter((u) => u !== url)
      submitSources(next)
      return
    }

    if (type === 'market-refresh') {
      view.setNotice('正在刷新插件源…')
      refresh({ forceMarket: true })
      return
    }

    if (type === 'market-install') {
      view.setNotice('正在安装…')
      clients.marketInstall(id)
        .then((res) => {
          if (!res || res.ok !== true) {
            view.setNotice((res && res.reason) || '安装失败', 'error')
            return refresh()
          }
          // 校验和是「从市场装」相对「自己下载」多出来的那道保证，值得单独说一句
          announceInstall('已安装', res, res.verified ? '，校验和已核对' : '（索引未提供校验和）')
          return refresh()
        })
        .catch((e) => { fail(e, '安装失败'); refresh() })
      return
    }

    /**
     * 受信任公钥的导入 / 移除（`signature` 验签的另一半）。
     *
     * 导入后**要重拉一次清单**：不是为了插件列表（它没变），而是为了公钥区自己 ——
     * 那一块的数据也走同一次 refresh，避免出现两个数据源、两种刷新时机。
     */
    if (type === 'trust-import') {
      view.setNotice('正在导入公钥…')
      // 级别来自下拉框（社区 / 本地）。官方级界面上不给选 —— 那是「随应用分发」的同义词。
      const trustLevel = level || 'community'
      const importKey = (overwrite = false) => clients.addTrustedKey({ level: trustLevel, overwrite })
      const settle = (res: PluginActionResult | null | undefined) => {
        if (res && res.canceled) { view.setNotice(''); return null }
        if (!res || res.ok !== true) {
          view.setNotice((res && res.reason) || '导入公钥失败', 'error')
          return refresh()
        }
        const responseLevel = typeof res.level === 'string' ? res.level : ''
        const lv = TRUST_LEVEL_LABEL[responseLevel] || responseLevel || '社区'
        view.setNotice(`已导入${lv}公钥 ${res.keyId}${res.fingerprint ? `（指纹 ${res.fingerprint}）` : ''}`)
        return refresh()
      }
      importKey(false).then((res) => {
        const reason = String((res && res.reason) || '')
        if (!res || res.ok === true || !/已存在|同名公钥|覆盖/i.test(reason) || typeof confirm !== 'function') {
          return settle(res)
        }
        return confirm({
          title: '覆盖公钥',
          message: `${reason}\n\n覆盖会替换该信任级别下的同名公钥。确定继续吗？`,
          danger: true,
          confirmLabel: '选择文件并覆盖'
        }).then((ok) => {
          if (!ok) { view.setNotice(''); return null }
          view.setNotice('正在覆盖公钥…')
          return importKey(true).then(settle)
        })
      }).catch((e) => { fail(e, '导入公钥失败'); refresh() })
      return
    }

    if (type === 'trust-remove') {
      view.setNotice('')
      // 级别必须一起传：不同级别允许同名公钥，只给 keyId 无法确定删的是哪一个
      clients.removeTrustedKey(keyId, level)
        .then((res) => {
          if (!res || res.ok !== true) view.setNotice((res && res.reason) || '移除公钥失败', 'error')
          else view.setNotice(`已移除公钥 ${keyId}`)
          return refresh()
        })
        .catch((e) => { fail(e, '移除公钥失败'); refresh() })
      return
    }

    // ── 第三方插件授权（PART7 §7.5）─────────────────────────────
    if (type === 'grant') {
      view.setNotice('')
      // scopes 原样回传（主进程会与 manifest 取交集）；解析失败就发空数组 ——
      // 空数组会被主进程理解为「撤销授权」，绝不会有「解析失败反而给了全权」这种事。
      let list = []
      try { list = JSON.parse(scopes || '[]') } catch (_) { list = [] }
      if (!Array.isArray(list)) list = []
      clients.grantPermissions(id, list)
        .then((res) => {
          if (!res || res.ok !== true) view.setNotice((res && res.reason) || '授权未能生效', 'error')
          else view.setNotice('已授权并启用')
          refresh()
        })
        .catch((e) => { fail(e, '授权未能生效'); refresh() })
      return
    }

    /**
     * 「暂不」= 把它按**用户主动停用**处理（而不是弹窗消失、状态不明）：
     * 插件留在关闭态、不再显示授权提示；用户之后想用，点开关会再问一次。
     * 这正是 userDisabled 的语义（用户意图），所以复用它而不是新造一个状态。
     */
    if (type === 'deny') {
      view.setNotice('')
      applyToggle(id, false)
      return
    }

    /**
     * 热重载：改完插件代码不必重启整个浏览器。
     *
     * 失败**必须回显原因**（「模块无法加载：xxx」）—— 悄悄失败会让作者以为改动生效了，
     * 然后在完全错误的方向上调试。这正是这条通知存在的唯一理由。
     */
    if (type === 'reload') {
      view.setNotice('正在重新加载…')
      clients.reload(id)
        .then((res) => {
          if (!res || res.ok !== true) view.setNotice((res && res.reason) || '重新加载失败', 'error')
          else view.setNotice(`已重新加载${res.enabled ? '并重新启用' : ''}`)
          refresh()
        })
        .catch((e) => { fail(e, '重新加载失败'); refresh() })
      return
    }

    if (type !== 'toggle') return
    // 主进程可能因 CORE 锁定 / 前置未启用 / 连带确认而拒绝 —— reason 必须回显，
    // 否则用户只看到开关弹回去，不知道为什么。
    view.setNotice('')
    applyToggle(id, enabled)
      .then((res) => {
        /**
         * 连带禁用（§10.3 方案 b 的**两段式**）：主进程不替用户做决定，
         * 先把「会一并关掉谁」回过来。这里弹确认，用户同意才带 `cascade: true` 重发。
         *
         * 为什么必须让用户看见名单、而不是静默级联：用户按下的是一次点击，
         * 不该顺手关掉他看不见的一串东西 —— 那些下游会连同面板一起消失，
         * 而「我的面板怎么没了」是极难倒推回「因为刚才关了一个引擎」的。
         */
        if (!res || res.requiresCascade !== true) return
        if (typeof confirm !== 'function') return
        const names = (res.dependents || []).map((d) => d.name).join('、')
        view.setNotice('')
        confirm({
          title: '一并禁用依赖它的插件',
          message: `关闭后将同时禁用：${names}。这些插件的面板与入口会一并消失，确定继续吗？`,
          danger: true,
          confirmLabel: '一并禁用'
        }).then(async (ok: boolean): Promise<void> => {
          if (!ok) { await refresh(); return } // 取消 → 回到原样（开关是自绘的，刷新即复位）
          await applyToggle(id, false, { cascade: true })
        }).catch(() => refresh())
      })
      .catch((e) => { fail(e, '操作未能生效'); refresh() })
  }

  return {
    /** 视图的根元素 —— 宿主只要这一个东西。 */
    element: view.element,
    dispatch,
    refresh,
    /** 首次拉取 + 订阅变更广播。 */
    start() {
      refresh()
      // 插件是**后台启动**的：首次 list 很可能早于注册中心就绪（返回空）。
      // 这条订阅是补齐的唯一路径 —— 启动完成 / 任一插件被启停时主进程都会广播。
      if (typeof on === 'function') on(IPC_EVENTS.pluginsChanged, scheduleReconcile)
    }
  }
}
