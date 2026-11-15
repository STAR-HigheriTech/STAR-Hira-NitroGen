/**
 * shared/core.js —— 主题 UI 的**编排内核**（零 DOM、零 IPC 细节，全靠端口注入）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它是什么 / 不是什么
 * ══════════════════════════════════════════════════════════════════════
 *   是：状态（目录 / 当前主题 / 调度 / 草稿）＋ 全部动作（换主题 / 编辑 / 保存 /
 *       删除 / 调调度 / 设私密主题）＋ 变更订阅（theme:changed）。
 *   不是：画任何东西。视图是一个**方法存在就被调用**的对象（见下方 VIEW 契约）。
 *
 * 两个形态（侧栏窄面板 / 主题页）共用这一个内核 —— 于是"面板里点一下换主题"
 * 与"窗口里点一下换主题"走的是**同一段代码**，不可能出现"窗口能换、面板换不了"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * VIEW 契约（全部可选 —— 谁需要谁实现）
 * ══════════════════════════════════════════════════════════════════════
 *   setCatalog({ themes, groups, activeId, privateId })
 *   setActive(theme|null)                       当前主题变了（含调度自动切换）
 *   setSchedule(schedule)                       调度配置
 *   setPrivate(id)                              私密窗口主题 id
 *   setDraft(draft, { session, dirty, editable })   编辑器草稿（视图一律全量对齐，
 *       控件自带幂等短路 —— 见 `editorMeta` 的说明）
 *   setPreview({ tokens, background })          草稿的即时配色（编辑器预览）
 *   setBusy(flag)
 *   setStatus(text, kind)                       'ok' | 'error'
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条必须写死的规则
 * ══════════════════════════════════════════════════════════════════════
 *  1. **目录不缓存**：主题集合随插件启停变化，所以每次 `load()` 都重取一遍
 *     （与 `panelsClient.catalog()` 同一条判据）。渲染层留一份 state 只是为了
 *     给视图传参，不作为权威。
 *  2. **`theme:changed` 是唯一的外部真相**：调度在半夜自动换了主题，本内核
 *     也必须立刻反映（否则面板上显示的还是旧主题名）。所以订阅它 → 重取目录。
 *  3. **预览是防抖的**：编辑器每动一个滑杆/取色器都会调 `previewDraft()`，
 *     而它是一次 IPC 往返 —— 拖颜色盘时每秒几十次。用一帧的合并窗口把它压到
 *     每个绘制帧最多一次（观感上仍是"实时"，主进程不再被刷屏）。
 *
 * 端口（`{ client, on, confirm }`）由宿主注入 —— 内核不认识 IPC 通道名，
 * 也不 import 任何 apps 层模块（CONTRACT-11：ui 不得依赖 apps）。
 */

import { groupThemes } from './format.js'
import type { ThemeData, ThemeSchedule } from '../theme.js'

/** 预览合并窗口：一帧（16ms）。拖颜色盘/滑杆时把它压到每帧最多一次 IPC。 */
const PREVIEW_COALESCE_MS = 16

interface ThemeRecord {
  id?: string
  name?: string
  source?: string
  [key: string]: unknown
}

interface ThemeMutationResult {
  ok?: boolean
  canceled?: boolean
  reason?: string
  themes?: ThemeRecord[]
  activeId?: unknown
  privateId?: unknown
  theme?: ThemeData
  draft?: ThemeData
  id?: unknown
  tokens?: Record<string, string>
  background?: unknown
  surface?: unknown
  mediaKind?: unknown
  key?: unknown
  schedule?: ThemeSchedule
  warnings?: string[]
  name?: string
  [key: string]: unknown
}

interface ThemeCatalogResult {
  themes?: ThemeRecord[]
  activeId?: unknown
  privateId?: unknown
}

interface ThemePreviewResult {
  tokens?: Record<string, string>
  background?: unknown
  surface?: unknown
}

export interface ThemeClientPort {
  list(profileId?: string): Promise<ThemeCatalogResult>
  set(id: string): Promise<ThemeMutationResult>
  refresh(): Promise<ThemeMutationResult>
  scheduleGet(): Promise<ThemeSchedule>
  scheduleSet(schedule: unknown): Promise<ThemeMutationResult>
  draft(action: string, options?: { asNew?: boolean }): Promise<ThemeMutationResult>
  save(theme: ThemeData): Promise<ThemeMutationResult>
  remove(id: string): Promise<ThemeMutationResult>
  preview(theme: ThemeData): Promise<ThemePreviewResult>
  privateSet(id: string): Promise<ThemeMutationResult>
  pickAsset?(kind: string, current?: string): Promise<ThemeMutationResult>
  exportTheme?(id: string): Promise<ThemeMutationResult>
  importTheme?(): Promise<ThemeMutationResult>
  onChanged?(callback: () => void): (() => void) | void
}

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
}

interface ThemeViewPort {
  setStatus?: (text: string, kind?: 'ok' | 'error') => void
  setBusy?: (busy: boolean) => void
  [key: string]: unknown
}

export interface ThemesControllerOptions {
  client?: ThemeClientPort
  confirm?: (options: { title?: string; message?: string; confirmText?: string; danger?: boolean }) => Promise<boolean>
  view?: ThemeViewPort
}

interface ThemesState {
  themes: ThemeRecord[]
  activeId: string
  privateId: string
  schedule: ThemeSchedule | null
  draft: ThemeData | null
  draftSavedId: string
  dirty: boolean
  session: number
  busy: boolean
}

/**
 * @param {{
 *   client: {
 *     list: Function, set: Function, refresh: Function,
 *     scheduleGet: Function, scheduleSet: Function,
 *     draft: Function, save: Function, remove: Function, preview: Function,
 *     privateSet: Function, onChanged?: Function
 *   },
 *   confirm?: (opts: { title?: string, message?: string, confirmText?: string, danger?: boolean }) => Promise<boolean>,
 *   view?: object
 * }} deps
 */
export function createThemesController({ client, confirm, view: initialView }: ThemesControllerOptions = {}) {
  const view = initialView || {}

  /** 内核状态（只用于传给视图；权威始终在主进程）。 */
  const state: ThemesState = {
    themes: [],
    activeId: '',
    privateId: '',
    schedule: null,
    /** 编辑器草稿（未保存的编辑内容）。null = 不在编辑。 */
    draft: null,
    /** 草稿对应的用户主题 id：'' = 还没保存过（新建 / 副本）。 */
    draftSavedId: '',
    /** 草稿是否偏离了已保存的版本。 */
    dirty: false,
    /** 编辑器会话号：`setDraft` 靠它区分"另开一份草稿"与"同一份草稿的值变化"。 */
    session: 0,
    busy: false
  }

  let previewTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe = () => {}
  let loadRevision = 0

  const call = (name: string, ...args: unknown[]): unknown => {
    const fn = view[name]
    if (typeof fn !== 'function') return undefined
    try {
      return fn.apply(view, args)
    } catch (e) {
      // 视图方法抛错不能只 warn 一句 message：曾经有个闭包作用域错误就是这样被吞掉的，
      // 表现成"点了主题没反应"。这里保留原错误对象与调用栈，并**就地摆到状态条**——
      // 用户看不到控制台，界面必须自己说出"坏了"。
      console.error(`[themes] view.${name} 抛错：`, e)
      try {
        if (typeof view.setStatus === 'function') {
          view.setStatus(`界面更新失败（${name}）：${errorMessage(e)}`, 'error')
        }
      } catch (_) {
        // 状态条本身也坏了就不再递归
      }
      return undefined
    }
  }

  const setBusy = (flag: unknown) => {
    state.busy = !!flag
    call('setBusy', state.busy)
  }

  const setStatus = (text: unknown, kind?: 'ok' | 'error') => call('setStatus', String(text || ''), kind || 'ok')

  /** 当前主题对象（目录里查；查不到返回 null）。 */
  function activeTheme(): ThemeRecord | null {
    return state.themes.find((t) => t && t.id === state.activeId) || null
  }

  /** 把目录灌进视图（分组在纯层算好，两个形态的库长得一样）。 */
  function pushCatalog() {
    call('setCatalog', {
      themes: state.themes,
      groups: groupThemes(state.themes),
      activeId: state.activeId,
      privateId: state.privateId
    })
    call('setActive', activeTheme())
    call('setPrivate', state.privateId)
  }

  /**
   * 重取目录 + 当前主题 + 调度。**不缓存**（见文件头规则 1）。
   * @param {{ silent?: boolean }} [opts] `silent` 时不动 busy / 不清状态条（订阅自愈用）
   */
  async function load(opts: { silent?: boolean } = {}) {
    if (!client || typeof client.list !== 'function') return
    const revision = ++loadRevision
    if (!opts.silent) setBusy(true)
    try {
      const [catalog, schedule] = await Promise.all([
        client.list(),
        typeof client.scheduleGet === 'function' ? client.scheduleGet().catch(() => null) : Promise.resolve(null)
      ])
      if (revision !== loadRevision) return
      const data = catalog && typeof catalog === 'object' ? catalog as Record<string, unknown> : {}
      state.themes = Array.isArray(data.themes) ? data.themes as ThemeRecord[] : []
      state.activeId = data.activeId ? String(data.activeId) : ''
      state.privateId = data.privateId ? String(data.privateId) : ''
      if (schedule) state.schedule = schedule
      pushCatalog()
      call('setSchedule', state.schedule)
    } catch (e) {
      if (revision !== loadRevision) return
      setStatus(`主题目录读取失败：${errorMessage(e)}`, 'error')
    } finally {
      if (!opts.silent && revision === loadRevision) setBusy(false)
    }
  }

  // ── 换主题 ───────────────────────────────────────────────────────────
  /**
   * 应用一条主题（点卡片 / 点色卡都会走这条）。
   *
   * 为什么成功后要**重取目录**而不是本地改 activeId：主进程在用户手选时会顺手把
   * 调度切回 `none`（"我选的浅色不能被调度顶回去"）—— 那是主进程的事实，本地改
   * 会让调度页显示的还是旧档位。一次 IPC 换一份一致的界面，比省这一趟更值。
   */
  async function applyTheme(id: unknown) {
    const target = String(id == null ? '' : id)
    if (!target || !client || typeof client.set !== 'function') return
    if (target === state.activeId) {
      setStatus(`「${(activeTheme() || {}).name || target}」已是当前主题`)
      return
    }
    setBusy(true)
    try {
      const res = await client.set(target)
      if (res && res.ok === false) {
        setStatus(res.reason || '切换失败', 'error')
        return
      }
      await load({ silent: true })
      setStatus(`已切换到「${(activeTheme() || {}).name || target}」`)
    } catch (e) {
      setStatus(`切换失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 重新扫描来源（装了主题插件后不必重启）。 */
  async function refreshSources() {
    if (!client || typeof client.refresh !== 'function') return
    setBusy(true)
    try {
      await client.refresh()
      await load({ silent: true })
      setStatus('已重新扫描主题来源')
    } catch (e) {
      setStatus(`刷新失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  // ── 编辑器 ───────────────────────────────────────────────────────────
  /**
   * 打开编辑器：以某条主题为起点取草稿。
   *   · 传 `baseId` = 点某张卡片进编辑器；
   *   · 不传 = 以当前主题新建。
   * 内置 / 插件主题会被主进程复制成**用户主题草稿**（id 留空，保存时生成）——
   * 所以"编辑"对它们永远是"另存为副本"，出厂主题不可能被改坏。
   *
   * @param {string} [baseId]
   * @param {{ asNew?: boolean }} [opts] `asNew` = 「新建主题」按钮：即使起点是自建主题，
   *   也另起一份 id 为空的新草稿（否则原地编辑同一份，界面看起来毫无变化）。
   */
  async function openEditor(baseId: string, opts: { asNew?: boolean } = {}) {
    if (!client || typeof client.draft !== 'function') return
    const asNew = opts.asNew === true
    setBusy(true)
    try {
      const res = await client.draft(baseId || '', { asNew })
      const draft = res && res.draft ? res.draft : null
      if (!draft) {
        setStatus((res && res.reason) || '无法创建草稿', 'error')
        return
      }
      state.draft = draft
      state.draftSavedId = draft.id ? String(draft.id) : ''
      state.dirty = false
      state.session += 1
      call('setDraft', state.draft, editorMeta())
      await previewDraft(true)
      // 成功也要说话：按钮"看起来没反应"往往就是这里缺一句反馈
      setStatus(
        asNew
          ? `已新建草稿「${draft.name || '主题'}」：调好参数后点「保存为新主题」`
          : `正在编辑「${draft.name || '主题'}」`
      )
    } catch (e) {
      setStatus(`打开编辑器失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 编辑器元信息。
   *
   * 只带"会话 / 脏 / 能不能覆盖保存"三件事实 —— **不带"哪一段变了"**：
   * 草稿各段之间存在派生关系（主题明暗会改调色板、背景会改「自动前景」的取值、
   * 材质会改遮罩不透明度…），视图若按 section 分段回写就必然要再维护一张
   * 跨段依赖表 —— 那正是"这里一条规则、那里一条规则"的来源。视图改为一律全量
   * 对齐，靠**控件自身的幂等短路**（值没变就零 DOM 写入）把开销压到可忽略。
   */
  function editorMeta() {
    return {
      session: state.session,
      dirty: state.dirty,
      /** 能不能覆盖保存（草稿本身已是用户主题）。内置/插件主题的草稿只能"另存为"。 */
      editable: !!state.draftSavedId
    }
  }

  /**
   * 改草稿的一段。
   * @param {'name'|'mode'|'colors'|'style'|'background'} section
   * @param {string} key
   * @param {any} value
   */
  function patchDraft(section: 'name'|'mode'|'colors'|'style'|'background', key: string, value: unknown) {
    if (!state.draft) return
    if (section === 'name' || section === 'mode') {
      state.draft = { ...state.draft, [section]: value }
    } else {
      patchDraftMany(section, { [key]: value })
      return
    }
    state.dirty = true
    call('setDraft', state.draft, editorMeta())
    previewDraft()
  }

  /**
   * 一次改草稿里**同一段**的多个键（如「套用材质推荐值」要同时写三个 style 字段）。
   * 合并成一次 setDraft + 一次 preview，避免连发三次预览让界面抖三下。
   * @param {'colors'|'style'|'background'} section
   * @param {Record<string, any>} patch
   */
  function patchDraftMany(section: 'colors' | 'style' | 'background', patch: Record<string, unknown>) {
    if (!state.draft || !patch || typeof patch !== 'object') return
    const bucket = state.draft[section] && typeof state.draft[section] === 'object' ? state.draft[section] as Record<string, unknown> : {}
    state.draft = { ...state.draft, [section]: { ...bucket, ...patch } }
    state.dirty = true
    call('setDraft', state.draft, editorMeta())
    previewDraft()
  }

  /**
   * 草稿 → 令牌表（**不落盘**）。
   * @param {boolean} [immediate] 立刻算（打开编辑器时用），否则合并到当前帧
   */
  function previewDraft(immediate: boolean = false) {
    if (!state.draft || !client || typeof client.preview !== 'function') return
    if (previewTimer) {
      clearTimeout(previewTimer)
      previewTimer = null
    }
    const run = () => {
      previewTimer = null
      const draft = state.draft
      if (!draft) return
      client.preview(draft)
        .then((res) => {
          // 期间草稿可能又变了（用户还在拖）→ 丢弃这次结果，等下一帧
          if (!res || state.draft !== draft) return
          call('setPreview', {
            tokens: res.tokens || {},
            background: res.background || null,
            // 窗口材质状态：视图据此提示"这台机器支不支持亚克力"（草稿的 applied 恒假）
            surface: res.surface || null
          })
        })
        .catch(() => {})
    }
    if (immediate) run()
    else previewTimer = setTimeout(run, PREVIEW_COALESCE_MS)
  }

  /**
   * 保存草稿。
   *   · 草稿没有 id（新建 / 副本）→ 主进程生成一个用户主题 id；
   *   · 草稿有 id（编辑自建主题）→ 覆盖它。
   * 保存成功后**留在编辑器里**（用户常要接着微调），只是 dirty 清零、id 落定。
   *
   * @param {{ apply?: boolean }} [opts] `apply` 为真时保存后立刻切到它 ——
   *   这是"改完就想用上"的主路径（否则用户得保存 → 再去库里找到它 → 点一下）。
   */
  async function saveDraft(opts: { apply?: boolean } = {}) {
    if (!state.draft || !client || typeof client.save !== 'function') return
    setBusy(true)
    try {
      const res = await client.save(state.draft)
      if (!res || res.ok === false) {
        setStatus((res && res.reason) || '保存失败', 'error')
        return
      }
      if (res.themes) {
        state.themes = res.themes
        state.activeId = res.activeId ? String(res.activeId) : state.activeId
        state.privateId = res.privateId ? String(res.privateId) : state.privateId
        pushCatalog()
      }
      // 用主进程归一化后的那份回填草稿：这样"我改了什么"与"存下去了什么"立刻对齐，
      // 不会出现"保存后草稿里还是旧值，再点一次保存又存了另一份"。
      state.draft = res.theme || state.draft
      state.draftSavedId = res.id ? String(res.id) : state.draftSavedId
      state.dirty = false
      call('setDraft', state.draft, editorMeta())
      // 保存后重新算一次预览：主进程会夹取越界值（圆角 0~24、模糊 0~60…），
      // 预览必须显示**真正存下去的那份**，而不是刚才那个被夹取前的输入。
      previewDraft(true)
      setStatus(`已保存「${state.draft.name || res.id}」`)
    } catch (e) {
      setStatus(`保存失败：${errorMessage(e)}`, 'error')
      return
    } finally {
      setBusy(false)
    }
    if (opts && opts.apply && state.draftSavedId) await applyTheme(state.draftSavedId)
  }

  /**
   * 另存为副本：把当前草稿变成一份**新**主题（清掉 id，名字加后缀）。
   * 会话号 +1 → 编辑器会重建表单（这是"另开一份草稿"，不是"同一份的值变化"）。
   */
  function duplicateDraft() {
    if (!state.draft) return
    state.draft = { ...state.draft, id: '', name: `${state.draft.name || '主题'} 副本` }
    state.draftSavedId = ''
    state.dirty = true
    state.session += 1
    call('setDraft', state.draft, editorMeta())
    previewDraft(true)
    setStatus('已另存为副本（尚未落盘，点「保存」生效）')
  }

  /** 关掉编辑器（丢弃未保存的改动 —— 草稿本来就只在内存里）。 */
  function closeEditor() {
    state.draft = null
    state.draftSavedId = ''
    state.dirty = false
    state.session += 1
    call('setDraft', null, editorMeta())
  }

  /**
   * 删除一条用户主题（内置 / 插件主题由主进程拒绝）。
   * 确认框只有一处（宿主注入的 `confirm`）—— 与插件中心的删除同一条观感。
   */
  async function deleteTheme(id: unknown) {
    const key = String(id == null ? '' : id)
    if (!key || !client || typeof client.remove !== 'function') return
    const theme = state.themes.find((t) => t && t.id === key)
    const name = (theme && theme.name) || key
    let ok = true
    if (typeof confirm === 'function') {
      ok = await confirm({
        title: '删除主题',
        message: `「${name}」将从「我的主题」中移除，此操作不可撤销。`,
        confirmText: '删除',
        danger: true
      })
    }
    if (!ok) return
    setBusy(true)
    try {
      const res = await client.remove(key)
      if (!res || res.ok === false) {
        setStatus((res && res.reason) || '删除失败', 'error')
        return
      }
      if (res.themes) {
        state.themes = res.themes
        state.activeId = res.activeId ? String(res.activeId) : ''
        state.privateId = res.privateId ? String(res.privateId) : state.privateId
        pushCatalog()
      } else {
        await load({ silent: true })
      }
      // 删掉的正是正在编辑的那条 → 编辑器里的草稿已经不存在了，一并收起来
      if (state.draftSavedId === key) closeEditor()
      setStatus(`已删除「${name}」`)
    } catch (e) {
      setStatus(`删除失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  // ── 调度 ─────────────────────────────────────────────────────────────
  /**
   * 改调度。**合并式**：只传要改的字段（`{ mode }` / `{ light, dark }` / `{ entries }`），
   * 其余保持 —— 否则每加一个下拉都要把整份配置重拼一遍，漏一个字段就静默丢设置。
   */
  async function patchSchedule(patch: unknown) {
    if (!client || typeof client.scheduleSet !== 'function') return
    const changes = patch && typeof patch === 'object' ? patch as Partial<ThemeSchedule> : {}
    const next: ThemeSchedule = { ...(state.schedule || { mode: 'none', light: '', dark: '', entries: [] }), ...changes }
    setBusy(true)
    try {
      const res = await client.scheduleSet(next)
      if (res && res.ok === false) {
        setStatus(res.reason || '调度保存失败', 'error')
        return
      }
      state.schedule = (res && res.schedule) || next
      call('setSchedule', state.schedule)
      // 调度一变，主进程会立刻按新档位判一次（可能顺手换了主题）→ 目录重取一次。
      await load({ silent: true })
      setStatus('调度已更新')
    } catch (e) {
      setStatus(`调度保存失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 手动时段表：整表替换（增删一行就是整表换一份，语义最直白）。 */
  function patchScheduleEntries(entries: unknown) {
    return patchSchedule({ entries: Array.isArray(entries) ? entries : [] })
  }

  // ── 背景媒体（"选择图片 / 选择视频"落进主题资产库）──────────────────
  /**
   * 选择背景**图片 / 视频**：主进程弹**系统文件对话框**、把选中的文件**拷进**主题资产库，
   * 回来一个 key（写进 `background.path`）。
   *
   * `kind` 只是给对话框选标题与过滤器的**提示**（用户能切到"所有文件"选到别的）；
   * 真正写进 `background.kind` 的是主进程按**实际扩展名**判出来的 `mediaKind` ——
   * 于是不可能出现"kind=video 却指向一张 jpg"这种背景一片空白的主题。
   *
   * 拿到 key 顺手把 `kind` 切过去 —— 用户点"选择视频…"的意图就是"我要用视频当背景"，
   * 还让他再去下拉里选一次「来源」是多余的一步，而且很容易忘
   *（表现就是"选了却什么都没变"，正是这一栏原来最像坏了的地方）。
   *
   * 取消是**安静路径**（不在状态条上留痕）；真失败必须说出来 ——
   * 选了文件却什么都没发生，比报一句"不支持这个格式"难查得多。
   *
   * @param {'image'|'video'} [kind] 对话框的过滤器提示（缺省 = 图片）
   */
  async function pickAsset(kind: 'image'|'video') {
    if (!client || typeof client.pickAsset !== 'function') return
    const wanted = kind === 'video' ? 'video' : 'image'
    const what = wanted === 'video' ? '视频' : '图片'
    setBusy(true)
    try {
      const res = await client.pickAsset(wanted)
      if (!res || res.ok === false) {
        if (res && res.canceled) return
        setStatus((res && res.reason) || `选择${what}失败`, 'error')
        return
      }
      const picked = res.mediaKind === 'video' || res.mediaKind === 'image' ? res.mediaKind : wanted
      /* path 与 kind 必须**一次**写下去：分两次会先出现"kind=video 但 path 还是空的"这一帧，
         预览会闪一下空背景；同时也就少一次 setDraft + 预览。 */
      patchDraftMany('background', { path: res.key, kind: picked })
      setStatus(`已选择背景${picked === 'video' ? '视频' : '图片'}`)
    } catch (e) {
      setStatus(`选择${what}失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 清除背景媒体：只把 `background.path` 清掉。
   *
   * **不动资产库里的文件**：判据见 main/theme-assets.js 文件头 —— 一个刚选好、还没保存的
   * 草稿也在引用那个文件，按"还有没有主题引用它"去扫会删掉用户刚选的东西。
   * 这里同时把 kind 退回 `color`：留着 `image` / `video` + 空 path 会得到一块
   * "什么都不显示"的背景。
   */
  function clearAsset() {
    patchDraftMany('background', { path: '', kind: 'color' })
    setStatus('已清除背景文件')
  }

  // ── 主题包（导入 / 导出）────────────────────────────────────────────
  /**
   * 导出主题为 `.zip`（主进程弹保存框并写盘）。
   *
   * 默认导出**当前主题**：这条功能最常见的诉求就是"把我现在用的这套发给别人"。
   * 取消不是失败 —— 状态条上不能出现"导出失败"，那会让用户以为出了问题。
   */
  async function exportTheme(id: unknown) {
    const target = id == null ? '' : String(id)
    if (!client || typeof client.exportTheme !== 'function') return
    setBusy(true)
    try {
      const res = await client.exportTheme(target)
      if (!res || res.ok === false) {
        if (res && res.canceled) return
        setStatus((res && res.reason) || '导出失败', 'error')
        return
      }
      const warnings = Array.isArray(res.warnings) ? res.warnings : []
      setStatus(warnings.length ? `已导出（${warnings[0]}）` : '主题已导出')
    } catch (e) {
      setStatus(`导出失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 导入一个主题包（zip）。
   *
   * 导入会**装出一个主题插件**并启用它，所以成功之后必须重取目录 ——
   * 否则用户看不到刚导入的主题（它不在本地 state 里），会以为导入没成功。
   */
  async function importTheme() {
    if (!client || typeof client.importTheme !== 'function') return
    setBusy(true)
    try {
      const res = await client.importTheme()
      if (!res || res.ok === false) {
        if (res && res.canceled) return
        setStatus((res && res.reason) || '导入失败', 'error')
        return
      }
      await load({ silent: true })
      const warnings = Array.isArray(res.warnings) ? res.warnings : []
      setStatus(warnings.length ? `已导入「${res.name}」：${warnings.join('；')}` : `已导入「${res.name}」`)
    } catch (e) {
      setStatus(`导入失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  // ── 私密窗口主题 ─────────────────────────────────────────────────────
  async function setPrivate(id: unknown) {
    if (!client || typeof client.privateSet !== 'function') return
    const key = id == null ? '' : String(id)
    setBusy(true)
    try {
      const res = await client.privateSet(key)
      if (res && res.ok === false) {
        setStatus(res.reason || '设置失败', 'error')
        return
      }
      state.privateId = res && res.id ? String(res.id) : key
      call('setPrivate', state.privateId)
      setStatus(state.privateId ? '私密窗口主题已更新' : '私密窗口将使用普通主题')
    } catch (e) {
      setStatus(`设置失败：${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return {
    state,
    /** 启动：拉一次目录 + 订阅变更（变更后重取，见文件头规则 2）。 */
    async start() {
      await load()
      // 订阅口由**客户端**给（它才知道事件通道名）—— 内核不认识任何路由字符串。
      if (client && typeof client.onChanged === 'function') {
        unsubscribe = client.onChanged(() => {
          load({ silent: true })
          /**
           * 主题事件也可能只是"**背景的取值**变了" —— 具体是「每日一图」那张远程图
           * **异步拉到**了（首次使用 / 跨天）。草稿正开着就顺手重算一次预览，
           * 否则编辑器里会一直停在空白底上，直到用户碰巧再动一下别的控件。
           */
          if (state.draft) previewDraft(true)
        }) || (() => {})
      }
    },
    dispose() {
      if (previewTimer) clearTimeout(previewTimer)
      previewTimer = null
      try { unsubscribe() } catch (_) {}
    },
    // 动作
    load,
    applyTheme,
    refreshSources,
    openEditor,
    patchDraft,
    patchDraftMany,
    saveDraft,
    duplicateDraft,
    closeEditor,
    deleteTheme,
    patchSchedule,
    patchScheduleEntries,
    setPrivate,
    pickAsset,
    clearAsset,
    exportTheme,
    importTheme,
    /** 当前主题对象（只读用途）。 */
    activeTheme
  }
}
