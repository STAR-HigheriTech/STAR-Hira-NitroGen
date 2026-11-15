/**
 * theme-controller.js —— 渲染层的主题落地（**所有外壳渲染页共用一份**）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它做两件事，且只有两件
 * ══════════════════════════════════════════════════════════════════════
 *   ① 把主进程推来的**令牌表**写进根节点（同步、幂等、可覆盖）
 *   ② 写 `data-theme` 与 `body.dark` / `body.dark-mode` 类
 *      —— 这两个类**不是**配色来源，而是"兜底 + 原生控件配色"：
 *        `color-scheme: dark`、`<select>` 弹出列表、滚动条由它们驱动，
 *        而且 token CSS 文件里的 `:root` 默认值也在那一层。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么令牌要**同时**写在 html 与 body 上
 * ══════════════════════════════════════════════════════════════════════
 * token 样式表里存在 `body.dark-mode, html[data-theme='dark'] { --main-bg-color: #1e1e1e }`
 * 这类**选择器规则** —— 它们的优先级高于从 html 继承下来的值，于是会盖住主题。
 * 内联样式优先级高于任何样式表规则（无 `!important` 时），所以主题永远能赢。
 * 两处都写 = 无论某条规则挂在 html 还是 body 上，主题都盖得住。
 * 代价只有"换主题时多写一遍变量"（换主题是低频动作，不在滚动/悬停路径上）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不再自己判断"跟随系统"
 * ══════════════════════════════════════════════════════════════════════
 * 旧实现里渲染层用 `matchMedia('(prefers-color-scheme: dark)')` 兜底解析
 * `system` —— 那是**第二处**调度逻辑，与主进程的判定迟早不一致
 * （系统转深色时，主进程按调度换了主题，渲染层却还在自己算）。
 * 现在"当前该是什么主题"只有主进程一个答案，渲染层只负责落地它推来的结果。
 */

import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
// 背景层渲染器（图片 / 视频 / 无）—— 四个消费面共用**同一份**，见该文件的文件头。
import { applyThemeBackground } from '@hira-ng/shared-types/src/theme-background.mjs'
import { THEME_SETTING_KEYS, normalizeThemeMode } from '@hira-ng/shared-types/src/theme.mjs'
import type { RendererBridge } from './bridge'

type ThemeMode = 'light' | 'dark'
type ThemeTokens = Record<string, unknown>
type ThemeBackground = Record<string, Record<string, unknown> | undefined>
type ThemeSurface = Record<string, unknown>

interface ThemeControllerOptions {
  document?: Document
  bridge?: RendererBridge
  backgroundTarget?: HTMLElement | null
  backgroundOverlay?: HTMLElement | null
  backgroundScope?: 'window' | 'newtab'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

export interface ThemeController {
  start(): Promise<void>
  apply(mode: unknown, tokens: ThemeTokens, background: ThemeBackground | null, surface: ThemeSurface | null): void
  getResolved(): ThemeMode
  dispose(): void
}

/** 兜底：拿不到任何令牌时的 base token（与 tokens-base.css 的 :root 同源）。 */
const FALLBACK_BASE = {
  '--hira-bg-surface': '#f9fafb',
  '--hira-bg-elevated': '#f7f9fc',
  '--hira-text-primary': '#1a1a1a',
  '--hira-text-secondary': '#6b7280',
  '--hira-border-subtle': 'rgba(0, 0, 0, 0.1)'
}

/**
 * @param {{
 *   document?: Document,
 *   bridge?: unknown,
 *   backgroundTarget?: HTMLElement|null,
 *   backgroundOverlay?: HTMLElement|null,
 *   backgroundScope?: 'window'|'newtab'
 * }} [deps]
 *   `backgroundTarget` 非空时，控制器会**顺带**把主题背景画到那一层上。
 *   为什么由同一个控制器做：背景与配色来自**同一次发布**（主进程的 theme:changed），
 *   拆成第二个订阅者就多了一层"两个订阅者时序不一致"的可能（切主题时背景比配色慢一拍）。
 *   多数外壳渲染页（面板 / rail / 各浮层）没有背景层，不传即完全不参与。
 */
export function createThemeController({
  document,
  bridge,
  backgroundTarget = null,
  backgroundOverlay = null,
  backgroundScope = 'window'
}: ThemeControllerOptions = {}): ThemeController {
  /** 当前主题（'light' | 'dark'），供外部查询。 */
  let resolved: ThemeMode = 'light'
  /**
   * 上一次**真正写进 DOM** 的令牌（键 → 字符串）。
   *
   * 为什么记值而不是只记键：一次发布约 60 个键 × html/body 两处 = 120 次样式写入，
   * 而其中绝大多数与上一次完全相同（编辑器拖动时通常只变 1~2 个键，整份重发）。
   * 每次写入都会让样式失效重算 —— 与"极致跟手"直接冲突。值没变就一个都不碰。
   * 它同时承担"上一批有、这一批没有的键要清掉"的差集（用 Map 而不是数组的 indexOf，
   * 免得 60×60 的线性查找）。
   */
  let appliedTokens = new Map<string, string>()
  /** 上一次写过的遮罩底色（`style.background` 读回来未必与写入串相同，只能自己记）。 */
  let appliedOverlay: string | null = null
  let unsubscribeSettings: () => void = () => {}
  let unsubscribeTheme: () => void = () => {}
  /**
   * 主题拉取的代际与同拍合并。
   *
   * 一次 profile/space 切换可能先后收到「按空间设置变更」和「profile:changed / all」
   * 两条通知；两条都发 IPC 会把同一份主题拉两次。同拍合并只保留一次请求；
   * 代际则保证快速连切时，迟到的旧响应绝不能把已经切好的新主题盖回去。
   */
  let pullRevision = 0
  let pullTimer: ReturnType<typeof setTimeout> | null = null

  const getBridge = () => bridge || (typeof window !== 'undefined' ? window.hira : null)

  /** 把令牌表落到根节点；只写"值真变了"的键，并清掉上一批里这一批没有的键。 */
  const applyTokens = (tokens: ThemeTokens): void => {
    const root = document && document.documentElement
    if (!root || !tokens || typeof tokens !== 'object') return
    const body = document.body
    const next = new Map<string, string>()
    for (const key in tokens) {
      const value = tokens[key]
      if (value == null || value === '') continue
      const text = String(value)
      next.set(key, text)
      if (appliedTokens.get(key) === text) continue
      root.style.setProperty(key, text)
      if (body) body.style.setProperty(key, text)
    }
    // 上一批里有、这一批没有的键必须显式移除 —— 否则切到"更少覆盖"的主题时会留下残影
    // （例如从带背景的主题切回纯色主题，`--hira-theme-blur` 还挂着旧值）。
    for (const key of appliedTokens.keys()) {
      if (next.has(key)) continue
      root.style.removeProperty(key)
      if (body) body.style.removeProperty(key)
    }
    appliedTokens = next
  }

  /**
   * 把主题背景画到背景层上。样式（含"该不该显示"）由主进程按面算好推来
   * （`background[scope]`）—— 这里只做纯赋值，不重判任何条件。
   *
   * 真正的赋值（含"图片用 background-image、视频用 `<video>`"这条分叉）在**共享的
   * 背景层渲染器**里（`shared-types/src/theme-background.mjs`）—— 四个消费面
   * （外壳 / 新标签页 / 编辑器预览 / 内部页）共用同一份，改一处四处同时改。
   */
  const applyBackground = (background: ThemeBackground | null, surface: ThemeSurface | null): void => {
    const s = background && background[backgroundScope] ? background[backgroundScope] : null
    const visible = !!(s && s.visible)
    if (backgroundTarget) {
      applyThemeBackground(backgroundTarget, s)
      if (backgroundOverlay) {
        const overlayColor = visible ? String(s.overlayColor || 'transparent') : 'transparent'
        // 背景层在每个主题发布时都会被重算一次，但遮罩色通常一个值都不变 —— 记一下上次的串。
        if (overlayColor !== appliedOverlay) {
          appliedOverlay = overlayColor
          backgroundOverlay.style.background = overlayColor
        }
      }
    }
    /**
     * 玻璃判据（渲染层的唯一一处）：**有壁纸铺在这个面**，或**开了窗口材质**（亚克力 / Mica）。
     *
     * 两者都需要 chrome 把底色让开 —— 否则会盖住壁纸 / 系统模糊，材质等于白开
     * （用户原话："和现在的一样没有垃圾的不透明图层阻碍"）。
     * 用 data 属性而不是让 CSS 去猜 `background-image` 是否为空；
     * 材质不支持时（Win10）原生窗口仍是不透明的主题底色，这里照样让开 ——
     * 退化成"染色玻璃"，观感一致且不会黑屏。
     *
     * ⚠ 它**与"本视图画不画背景层"无关**：玻璃不玻璃是主题（+ 材质能力）的事实，
     *   盖在网页上的独立浮层（sidebar-float）自己不画背景层，同样要知道这件事
     *   （见 sidebar-float/index.html：玻璃面时底色必须回落不透明主题色）。
     *   所以判据算在 `backgroundTarget` 那段之外。
     */
    const material = surface && typeof surface === 'object' ? surface.material : ''
    const glass = visible || (!!material && material !== 'none')
    const root = document && document.documentElement
    if (root) {
      const flag = glass ? '1' : '0'
      if (root.dataset.themeBackground !== flag) root.dataset.themeBackground = flag
      /**
       * **壁纸**与「玻璃」是两件事，必须分开表达：
       *   · `data-theme-background`（glass）= 这是不是一块玻璃 —— 开了壁纸**或**窗口材质；
       *   · `data-theme-wallpaper`（visible）= 本视图**真的画着一张背景**。
       *
       * 为什么需要后者：外壳的壁纸层（`#chrome-theme-background`）是全窗固定层，
       * 它只在"真有壁纸"时才需要 `filter: blur()` / `will-change` —— 而这两条都会
       * 让元素被提升成**全窗尺寸的合成层**（并常驻一张全窗纹理）。只按 glass 判的话，
       * 亚克力 / Mica 用户（有材质、没壁纸）也会白白背着那一层：合成器每帧多一块
       * 全窗 quad，标签动画 / 进度条动画就更容易掉帧，显存也白占几十 MB。
       * 判据只有这里能算（只有它知道 background 到底可见不可见），所以在这里落属性，
       * CSS 侧只管照它开合，不再自己猜。
       */
      const wallpaper = visible ? '1' : '0'
      if (root.dataset.themeWallpaper !== wallpaper) root.dataset.themeWallpaper = wallpaper
    }
  }

  const apply = (mode: unknown, tokens: ThemeTokens, background: ThemeBackground | null, surface: ThemeSurface | null): void => {
    const next = normalizeThemeMode(mode) as ThemeMode
    resolved = next
    const root = document && document.documentElement
    const body = document && document.body
    if (root) {
      if (root.dataset.theme !== next) root.dataset.theme = next
      try {
        if (root.style.colorScheme !== next) root.style.colorScheme = next
      } catch (_) {}
    }
    if (body) {
      body.classList.toggle('dark', next === 'dark')
      body.classList.toggle('dark-mode', next === 'dark')
      // 浅色预设类已不再是配色来源（配色来自令牌），保留它只为兼容
      // tokens-light.css 里那份"出厂浅色"的兜底值。
      body.classList.toggle('light-theme-softWhite', next === 'light')
    }
    applyTokens(tokens)
    applyBackground(background, surface)
  }

  /** 主动向主进程取一次当前主题（加载时着色用；拿不到就用兜底）。 */
  const pull = async () => {
    const revision = ++pullRevision
    const b = getBridge()
    if (!b || !b.provider || typeof b.provider.invoke !== 'function') {
      if (revision === pullRevision) apply('light', FALLBACK_BASE, null, null)
      return
    }
    try {
      const res = await b.provider.invoke(IPC_ROUTES.themeTokens, {})
      if (revision !== pullRevision) return
      const payload = asRecord(res) || {}
      apply(
        payload.mode,
        asRecord(payload.tokens) || {},
        asRecord(payload.background) as ThemeBackground | null,
        asRecord(payload.surface)
      )
    } catch (_) {
      if (revision === pullRevision) apply('light', FALLBACK_BASE, null, null)
    }
  }

  const schedulePull = (): void => {
    if (pullTimer) return
    // 8ms 足以把同一轮切换里的 per-key 与 scope:all 合并成一次拉取，
    // 又不影响用户感知；避免主进程广播几条就回查几次。
    pullTimer = setTimeout(() => {
      pullTimer = null
      void pull()
    }, 8)
  }

  const onSettingsChanged = (change: Record<string, unknown>): void => {
    if (!change) return
    // 主题 id 的写入会紧跟一条 theme:changed 广播（主进程发布链保证），
    // 但"设置文件被外部改了、广播丢了"这种情况也要能自愈 —— 所以这里补一次主动拉取。
    if (change.scope === 'all' || !change.key || change.key === THEME_SETTING_KEYS.active) {
      schedulePull()
    }
  }

  const onThemeChanged = (change: Record<string, unknown>): void => {
    if (!change) return
    // 广播携带完整令牌，是比主动拉取更新鲜的权威结果：取消同拍拉取并作废在途响应。
    pullRevision += 1
    if (pullTimer) {
      clearTimeout(pullTimer)
      pullTimer = null
    }
    apply(
      change.resolved,
      asRecord(change.tokens) || {},
      asRecord(change.background) as ThemeBackground | null,
      asRecord(change.surface)
    )
  }

  return {
    async start() {
      const b = getBridge()
      if (b && b.on && typeof b.on.subscribe === 'function') {
        unsubscribeSettings = b.on.subscribe(IPC_EVENTS.settingsChanged, onSettingsChanged)
        unsubscribeTheme = b.on.subscribe(IPC_EVENTS.themeChanged, onThemeChanged)
      }
      // 先订阅再拉首帧：两者之间发生的主题变更不会被漏掉；代际保证拉取响应
      // 不会覆盖刚收到的广播。
      await pull()
    },
    /** 手动应用（测试 / 特殊页面需要直接指定时用）。 */
    apply,
    getResolved() {
      return resolved
    },
    dispose() {
      pullRevision += 1
      if (pullTimer) clearTimeout(pullTimer)
      pullTimer = null
      unsubscribeSettings()
      unsubscribeTheme()
    }
  }
}

