/**
 * theme-runtime.js —— 主题状态的**唯一发布出口**（主进程）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它把"主题变了"这件事接成一条链，只有这一条
 * ══════════════════════════════════════════════════════════════════════
 *   触发源（二选一）
 *     · themeService 的 active 变化（用户点主题 / 调度到点 / 插件目录刷新）
 *     · nativeTheme 的 updated（系统转深色）
 *          ↓
 *   publish(theme)
 *     ① service.decorate()      → 跑 theme.decorator 流水线（社区 Mod 可整体改写）
 *     ② tokensFor(theme)             → 令牌表（唯一真源在 shared-types/theme.mjs）
 *     ③ themeManager.setTheme(...)   → 静态 token 文件之上叠一层主题覆盖（overrides）
 *     ④ layout.setTabTheme(...)      → 原生表面（rail / 面板）+ 窗口缝的底色；**不碰网页画布色**
 *     ⑤ broadcast('theme:changed')   → 所有渲染进程（外壳 / 内部页 / 新标签页）
 *
 * ⚠ **不要订阅 themeManager.onChange 再回头 publish** —— ③ 本身会触发 onChange，
 *   那就成了自激循环（表现是主题变更时刷屏重算）。所以本模块**只**订阅
 *   themeService 与 nativeTheme；themeManager 是被推的一方，不是源。
 *
 * ── 为什么载荷里要带 tokens ───────────────────────────────────────────
 * 渲染层拿到令牌表就能直接写根变量（同步、幂等、可覆盖），不必各自去读
 * `packages/shared-ui-tokens/*.css` 再猜当前是哪套 —— 那正是改造前
 * "外壳变了、内部页没变"的成因。渲染侧的兜底仍在：拿不到 tokens 时用 data-theme +
 * token CSS 的默认值，界面不会没颜色。
 */

import type { BrowserWindow, NativeTheme } from 'electron'
import {
  derivePalette,
  isDarkTheme,
  glassSurface,
  windowMaterialSpec,
  type ThemeData
} from '@hira-ng/shared-types/src/theme.mjs'

export const THEME_CHANGED_EVENT = 'theme:changed'
// 能力探测（"这台机器支不支持原生材质"），与 infra-window/src/backdrop 是同一份真源。
const { getBackdropCapabilities } = require('@hira-ng/infra-window') as {
  getBackdropCapabilities(): { nativeMaterial: boolean; platform: string }
}
// 「非主窗口」的主题材质跟随（独立面板窗口等）：它们没有 LayoutCoordinator，
// 材质只能由本模块推下去。该模块不认识主题，只认 { material, fallbackColor }。
interface MaterialFollowResult { material: string; applied: boolean; supported: boolean; reason: string; message: string }
interface MaterialFollowPort {
  follow(win: BrowserWindow): MaterialFollowResult | null
  sync(spec: { material: string; fallbackColor: string }): void
  dispose(): void
}
const { createWindowMaterialFollow } = require('./window-material-follow') as {
  createWindowMaterialFollow(): MaterialFollowPort
}

interface ThemeSurface {
  material: string
  applied: boolean
  supported: boolean
  reason: string
  message: string
}

interface ThemePayload {
  themeId: string
  resolved: 'light' | 'dark'
  preference: 'light' | 'dark'
  tokens: Record<string, unknown>
  background: unknown
  surface: ThemeSurface | null
}

interface ThemeServicePort {
  getActiveThemeFor?(context: { incognito: boolean }): ThemeData | null | undefined
  getActiveTheme(): ThemeData | null | undefined
  decorate(theme: unknown): Promise<ThemeData | null | undefined> | ThemeData | null | undefined
  cssFor(theme: ThemeData): string
  tokensFor(theme: ThemeData): Record<string, unknown>
  backgroundFor(theme: ThemeData): unknown
  subscribe?(listener: (change: { topic?: string } | null) => void): () => void
}

interface ThemeManagerPort {
  setTheme(theme: unknown, options?: { prefersDark?: boolean; overrides?: string }): Promise<boolean> | boolean
}

interface ThemeLayoutPort {
  setTabTheme(payload: Record<string, unknown>): Partial<ThemeSurface> | null | undefined
}

export interface ThemeRuntimeDependencies {
  nativeTheme?: NativeTheme | null
  themeService?: ThemeServicePort | null
  themeManager?: ThemeManagerPort | null
  broadcast?(route: string, payload: unknown, options?: { windowId: number }): unknown
  getLayoutCoordinator?(): ThemeLayoutPort | null | undefined
  getIncognitoWindowIds?(): number[]
  scheduler?: { refresh?(): unknown } | null
  getProfileId?(): string
  runWithProfile?<T>(profileId: string, task: () => T): T
  logger?: { warn?(...args: unknown[]): void }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{
 *   nativeTheme?: object,
 *   themeService?: object,
 *   themeManager?: object,
 *   broadcast?: Function,
 *   getLayoutCoordinator?: Function,
 *   getIncognitoWindowIds?: () => number[],
 *   scheduler?: { refresh?: Function },
 *   logger?: { warn?: Function }
 * }} [deps]
 */
export function createThemeRuntime(deps: ThemeRuntimeDependencies = {}) {
  const nativeTheme = deps.nativeTheme || null
  const themeService = deps.themeService || null
  const themeManager = deps.themeManager || null
  const broadcast = deps.broadcast
  const getLayoutCoordinator = deps.getLayoutCoordinator
  /** 私密窗口的窗口 id 列表 —— 只用来把那**一份**私密皮肤的载荷定向发过去。 */
  const getIncognitoWindowIds = deps.getIncognitoWindowIds
  const scheduler = deps.scheduler || null
  const getProfileId = deps.getProfileId
  const runWithProfile = deps.runWithProfile
  const logger = deps.logger || console

  if (!themeService) {
    return {
      start() {},
      stop() {},
      broadcastCurrent() {},
      publish() {},
      /** 无主题服务时也要有这一口 —— 调用方按 `null` 处理，不必到处判空。 */
      describeSurface() {
        return null
      },
      /** 同上：没有主题就没有材质可跟随，窗口保持出厂行为。 */
      followWindowMaterial() {
        return null
      }
    }
  }

  /**
   * 跟随主题材质的**非主窗口**（独立面板窗口等）。
   *
   * 主窗口那条链在 `applyNativeSurface → layout.setTabTheme` 上；这里补的是
   * "没有 LayoutCoordinator 的窗口"—— 它们只是裸 BrowserWindow，材质必须显式推。
   */
  const service = themeService

  const materialFollow = createWindowMaterialFollow()

  function runForActiveProfile<T>(task: () => T): T {
    let profileId = ''
    try { profileId = typeof getProfileId === 'function' ? String(getProfileId() || '') : '' } catch (_) {}
    return profileId && typeof runWithProfile === 'function'
      ? runWithProfile(profileId, task)
      : task()
  }

  /** 最近一次发布的载荷（供后加载的 webContents 主动补取）。 */
  let lastPayload: ThemePayload | null = null
  /**
   * 最近一次发布的**主题对象**。
   *
   * 载荷里只有令牌表与背景描述，推不出 palette —— 而"补设原生表面"（见
   * `broadcastCurrent`）需要 palette。存这一份，是为了让晚加入的**窗口**也能被补上。
   */
  let lastTheme: ThemeData | null = null
  /** 私密窗口那一份载荷（与 `lastPayload` 同主题时为 null）。 */
  let lastPrivatePayload: ThemePayload | null = null
  /** 最近一次的令牌指纹 —— 用来挡掉"同一次变化被两条路径各推一遍"的重复广播。 */
  let lastFingerprint = ''
  /** 发布代际：快速连切时只允许最后一次发布落地。 */
  let publishRevision = 0
  /** themeManager 的覆盖写入必须串行，否则旧主题的异步 CSS 读取可能后完成。 */
  let managerChain: Promise<void> = Promise.resolve()

  const prefersDark = () => Boolean(nativeTheme && nativeTheme.shouldUseDarkColors)

  /**
   * 原生窗口表面：标签栏底、标题栏底、网页四周那圈圆角遮罩的底色、以及窗口材质都来自这里。
   *
   * @returns {{ material: string, applied: boolean, supported: boolean, reason: string, message: string }}
   *   `surface` 载荷 —— 渲染层据此判断"窗口是不是真的透了"（决定 chrome 要不要留透明底）。
   */
  function applyNativeSurface(theme: ThemeData): ThemeSurface {
    /**
     * `nativeTheme.themeSource` 决定**原生**部分的明暗：系统右键菜单、原生对话框、
     * 表单控件的 UA 默认样式。它必须与主题的实际明暗一致 —— 主题是深色而 OS 认为是浅色时，
     * 那几处会突兀地亮着。
     *
     * 为什么落在这里而不是设置生效器里：这里才是"当前主题是什么"的唯一出口；
     * 放在生效器里会出现两个地方各自决定 themeSource（迟早互相覆盖）。
     */
    const mode = isDarkTheme(theme) ? 'dark' : 'light'
    try {
      if (nativeTheme && nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode
    } catch (_) {}

    const caps = getBackdropCapabilities()
    const spec = windowMaterialSpec(theme)
    const palette = derivePalette(theme)
    /**
     * 跟随主题材质的**其它窗口**（OOBE / 独立面板窗口等）先同步 —— 它们不经过 layout fanout，
     * 材质只能由这条链推给 `window-material-follow`。
     *
     * `palette.bg` 是降级底色：材质不可用（Win10 / Build 过低 / 调用失败）时，
     * 原生窗口背景必须回到主题底色，否则会停在上一轮被置透明的状态 —— 渲染层
     * 那层半透明染色下面是"什么都没铺"的原生白，深色主题下就是一块刺眼的亮块。
     *
     * 放在"有没有 layout"的判空之前：主窗口关掉、独立窗口还开着时，材质同步仍要工作。
     */
    materialFollow.sync({ material: spec.material, fallbackColor: palette.bg })
    /** 没有窗口可落时，仍要如实回答"这台机器支不支持"，供编辑器提示。 */
    const idleSurface = {
      material: spec.material,
      applied: false,
      supported: caps.nativeMaterial,
      reason: '',
      message: ''
    }

    const layout = typeof getLayoutCoordinator === 'function' ? getLayoutCoordinator() : null
    if (!layout || typeof layout.setTabTheme !== 'function') return idleSurface
    /**
     * 主题圆角：**0 是合法值**（= 直角），不能拿它当"没设置"再回落 6。
     * 曾经这里写的是 `radius > 0 ? radius : 6`，于是用户在编辑器里把圆角拉到 0，
     * 网页/面板仍然是 6px 的默认圆角 —— 与主题面板显示的数字对不上。
     */
    const radius = Number(theme && theme.style && theme.style.cornerRadius)
    /** 视图边距（网页/面板与 chrome 之间的呼吸空）。0 = 贴边、无边框。 */
    const inset = Number(theme && theme.style && theme.style.contentInset)
    /**
     * 主题带**窗口壁纸**或**窗口材质**时，面板 / rail 这些"表面型"子视图的原生底必须是
     * **透明**的 —— 半透明的面板页只有叠在"透明的原生底 + 外壳那层壁纸/系统模糊"上才看得见；
     * 原生底要是不透明，两者的混色只会得到一块平色（壁纸 / 材质等于白设了）。
     * 判据是唯一的 `glassSurface`（壁纸或材质任一成立）。
     *
     * 标签视图**不在此列** —— 网页的画布色固定为白纸（`WebContentsManager#TAB_CANVAS_COLOR`），
     * 主题**不得**参与：大量站点不写 body 背景，视图底色就是它们看到的页面背景；
     * 一旦跟随主题，那些"本来是白纸"的网页会整页染上主题色。
     *
     * 这里只给三样东西：
     *   · `surfaceBackgroundColor` —— rail / 面板（chrome）；
     *   · `frameBackgroundColor`   —— 窗口底，也就是网页外圈那 4px 缝的颜色；
     *   · `windowMaterial`         —— 窗口级材质（亚克力）。
     */
    const applied = layout.setTabTheme({
      surfaceBackgroundColor: glassSurface(theme) ? '#00000000' : palette.bg,
      frameBackgroundColor: palette.bg,
      /** 速览卡片间聚焦框要把它带进注入的网页样式里（那一页没有 CSS 令牌）。 */
      accentColor: palette.accent,
      radius: Number.isFinite(radius) ? Math.max(0, radius) : 6,
      /** 0 也合法（= 网页/面板贴边，没有那一圈呼吸空与边框）。 */
      inset: Number.isFinite(inset) ? Math.max(0, inset) : 4,
      windowMaterial: spec.material
    })
    /**
     * `setTabTheme` 经 `layoutFanout` 后返回的是**最后一个窗口**的结果，
     * "这台机器支不支持"永远以能力探测为准（`supported`），`applied` 只代表最后一次调用。
     */
    if (!applied || typeof applied !== 'object') return idleSurface
    return {
      material: applied.material || spec.material,
      applied: !!applied.applied,
      supported: caps.nativeMaterial,
      reason: applied.reason || '',
      message: applied.message || ''
    }
  }

  /**
   * 取（并跑完装饰器流水线的）某个窗口语境下的主题。
   * `incognito` 为真时走 `service.getActiveThemeFor` —— 私密窗口可另有皮肤。
   */
  async function resolveTheme(incognito: boolean): Promise<ThemeData | null> {
    let theme: ThemeData | null = null
    try {
      const base = typeof service.getActiveThemeFor === 'function'
        ? service.getActiveThemeFor({ incognito: Boolean(incognito) })
        : service.getActiveTheme()
      theme = (await service.decorate(base)) ?? null
    } catch (e) {
      logger.warn?.('[theme] decorate 失败：', errorMessage(e))
      theme = null
    }
    if (!theme) theme = service.getActiveTheme() ?? null
    return theme
  }

  /**
   * 一份主题 → 一次发布的载荷（渲染层拿到的就是这一份）。
   *
   * @param {object} theme
   * @param {{ material: string, applied: boolean, supported: boolean, reason: string, message: string }|null} [surface]
   *   `applyNativeSurface` 的结果。**必须随载荷下发** —— 渲染层只有知道"窗口真的透了"
   *   才敢把 chrome 的底色让开（否则会在亚克力上盖一层不透明底，材质等于失效）。
   */
  function buildPayload(theme: ThemeData, surface: ThemeSurface | null): ThemePayload {
    const mode = isDarkTheme(theme) ? 'dark' : 'light'
    return {
      /** 主题 id（渲染层据此判断"是不是同一主题"，不必比整张令牌表）。 */
      themeId: theme.id,
      /** 'light' | 'dark' —— 渲染层用它写 data-theme 与 color-scheme。 */
      resolved: mode,
      /** 兼容既有订阅方（theme-controller 的 onThemeChanged 读这个字段）。 */
      preference: mode,
      /** 令牌表：三套消费面的同一批值（见 shared-types/theme.mjs#themeToTokens）。 */
      tokens: service.tokensFor(theme),
      /** 背景描述（可直接落 `background-*` / 不透明度 / 模糊 / 遮罩）。 */
      background: service.backgroundFor(theme),
      /** 窗口材质状态（原生窗口是否真的透出系统模糊）。 */
      surface: surface || null
    }
  }

  /**
   * 发布当前主题。
   *
   * **幂等**：同一个主题（载荷逐字相同）被重复触发时直接返回上一次的载荷，
   * 不重算、不重广播。必要性在于触发源不止一处 —— 用户的显式切换会同时经过
   * "themeService 的 active 事件"与"settings:changed 订阅"两条路，
   * 没有这道去重就会推两遍（渲染层重写两遍根变量、原生表面重设两次）。
   *
   * ── 私密窗口（Vivaldi 特性）为什么在这条链上一起处理 ────────────────
   * 私密主题是"同一时刻、不同窗口用不同皮肤"，而 `publish` 是**唯一**的发布出口 ——
   * 把它做成"两次广播"（先全局、再定向私密窗口）而不是给每个窗口各开一条发布链：
   *   · 全局那次让非私密窗口与所有应用级视图保持原状；
   *   · 定向那次只改私密窗口的最终状态（后到者胜，不会互相打架）。
   * 设置里没配私密主题时**一次多余的广播都不发**（`priv` 为 null）。
   */
  async function publishUnscoped(): Promise<ThemePayload | null> {
    const revision = ++publishRevision
    const theme = await resolveTheme(false)
    if (!theme || revision !== publishRevision) return lastPayload
    const privateTheme = await resolveTheme(true)
    if (revision !== publishRevision) return lastPayload
    lastTheme = theme

    /**
     * ★ **原生表面必须在指纹去重之前应用** —— 这是"新窗口的 rail 变成默认不透明"那个
     * 报告的正解。
     *
     * 原生表面（rail / 面板 / 浮层这些子视图的底色，见
     * `theme-runtime#applyNativeSurface` → `LayoutCoordinator#setTabTheme` →
     * `WebContentsManager#setSurfaceBackgroundColor`；窗口材质同一处）的正确性
     * **不取决于"主题变了没有"**，而取决于**"此刻有哪些窗口"**：
     *   · 每个窗口各有一份 `WebContentsManager`，它的表面底色**默认是出厂浅色**
     *     （`#f9fafb`，见 WebContentsManager 的构造）；
     *   · rail 页自己几乎是透明的，所以它显示的就是这个原生底色 ——
     *     出厂浅色 = 用户看到的"rail 变成默认的不透明"；
     *   · 带壁纸 / 开材质时主题要把它刷成 `#00000000`，只有把当前主题**再铺一次**才会生效。
     *
     * 放在去重之后的话，"主题没变、只是新开了一个窗口"这条路径**永远走不到这一行**
     * （指纹相同 → 提前 return），于是新窗口的 rail 永远停在出厂底色上。
     * 而它本身极便宜：几个幂等 setter（LayoutCoordinator 内部有变化检测）。
     *
     * 它的**返回值就是载荷里的 `surface`** —— 渲染层据此决定 chrome 要不要让出透明底，
     * 所以必须先生效、再建载荷（顺序不能换）。
     *
     * ℹ 原生表面是**进程级**的（`nativeTheme` 与 layout fanout 都没有按窗口定位的口），
     * 所以它始终跟随**普通主题** —— 私密窗口的差异体现在令牌与背景上，
     * 那才是"一眼能分辨"的部分（`broadcastCurrent` 已经能把私密那一份定向推过去）。
     */
    const surface = applyNativeSurface(theme)
    const payload = buildPayload(theme, surface)
    // 私密窗口拿到的主题与普通窗口**不是同一个**时，才需要单独一份载荷。
    // `surface` 是进程级的（窗口材质不分私密/普通），两边共用同一份。
    const priv = privateTheme && privateTheme.id !== theme.id ? buildPayload(privateTheme, surface) : null

    const fingerprint = `${theme.id}\u0001${JSON.stringify(payload)}\u0002${priv ? JSON.stringify(priv) : ''}`

    if (fingerprint === lastFingerprint && lastPayload) return lastPayload

    if (themeManager && typeof themeManager.setTheme === 'function') {
      const managerRevision = revision
      managerChain = managerChain.then(async () => {
        if (managerRevision !== publishRevision) return
        try {
          await themeManager.setTheme(payload.resolved, {
            prefersDark: prefersDark(),
            // 静态 token 文件之上叠主题覆盖：insertCSS 那条路径（外壳/面板视图）
            // 也能拿到当前主题，而不是永远停在出厂配色。
            overrides: service.cssFor(theme)
          })
        } catch (e) {
          logger.warn?.('[theme] 应用 token 覆盖失败：', errorMessage(e))
        }
      }).catch(() => {})
      await managerChain
      // 等异步 token 覆盖期间用户可能又切了目标：旧一代到此为止，绝不能补发。
      if (revision !== publishRevision) return lastPayload
    }

    lastFingerprint = fingerprint
    lastPayload = payload
    lastPrivatePayload = priv

    if (typeof broadcast === 'function') broadcast(THEME_CHANGED_EVENT, payload)
    if (priv && typeof broadcast === 'function') {
      const ids = typeof getIncognitoWindowIds === 'function' ? getIncognitoWindowIds() : []
      for (const id of Array.isArray(ids) ? ids : []) {
        broadcast(THEME_CHANGED_EVENT, priv, { windowId: id })
      }
    }
    return payload
  }

  /**
   * 主题是应用级事实，必须按**当前 active profile** 解析。
   * 进程级触发（调度器 / 原生外观 / 每日一图）没有 IPC sender；不显式钉作用域时，
   * 设置覆盖层会回落到主窗口 profile，在多窗口下把别的 profile 的主题重新发布回来。
   */
  async function publish(): Promise<ThemePayload | null> {
    return runForActiveProfile(() => publishUnscoped())
  }

  // 系统外观变化：交给调度器判（它才知道当前是不是"跟随系统/夜间"档），
  // 判完若有变化，themeService 会发 active 事件 → 本模块 publish。
  const onNativeUpdated = (): void => {
    if (scheduler && typeof scheduler.refresh === 'function') {
      Promise.resolve(scheduler.refresh()).catch((error: unknown) => {
        logger.warn?.('[theme] native refresh failed:', errorMessage(error))
      })
      return
    }
    void publish().catch((error: unknown) => {
      logger.warn?.('[theme] publish failed:', errorMessage(error))
    })
  }

  let offService: () => void = () => {}
  let started = false

  return {
    start() {
      if (started) return
      started = true
      if (nativeTheme && typeof nativeTheme.on === 'function') {
        nativeTheme.on('updated', onNativeUpdated)
      }
      if (typeof service.subscribe === 'function') {
        offService = service.subscribe((change) => {
          if (!change) return
          /**
           * 两个主题事件都要重发一次广播：
           *   · `active`     —— 换了主题；
           *   · `background` —— 主题没换，但**背景的取值变了**：具体是「每日一图」
           *     那张远程图**是异步拉到**的（首次使用 / 跨天时第一帧还没有图）。
           *     少了这一条，用户切到"每日一图"后会一直停在空白底上，直到碰巧再触发一次
           *     别的广播 —— 也就是"选了没反应"。
           */
          if (change.topic === 'active' || change.topic === 'background') {
            void publish().catch((error: unknown) => {
              logger.warn?.('[theme] publish failed:', errorMessage(error))
            })
          }
        })
      }
    },
    stop() {
      if (!started) return
      started = false
      if (nativeTheme && typeof nativeTheme.removeListener === 'function') {
        nativeTheme.removeListener('updated', onNativeUpdated)
      }
      try { offService() } catch (_) {}
      materialFollow.dispose()
    },
    /**
     * 主动补推：给"晚于初始推送才创建"的 webContents（浮层、面板、**新开的独立窗口**）
     * 补一次当前主题。不重算 —— 直接重发上一次的载荷，除非还没发布过。
     *
     * ⚠ **原生表面也要补一次**：新窗口带回一份"出厂表面底色"的 WebContentsManager
     * （rail / 面板的底色默认 `#f9fafb`），而它只能靠 `applyNativeSurface` 刷成透明。
     * 少了这一步，"新窗口的 rail 是不透明的出厂色、而老窗口好好的"——
     * 正是这个报告（详见 `publish` 里那段说明）。
     *
     * @param {{ incognito?: boolean, windowId?: number }} [opts] 私密窗口补推时要拿**私密那一份**，
     *   否则新开的私密窗口会先被刷成普通皮肤（用户会看到"开了个私密窗口，皮肤一闪"）。
     *   `windowId` 给出时只把广播推给那个窗口（新窗口建窗时用，避免全场重收一遍）。
     */
    broadcastCurrent(opts: { incognito?: boolean; windowId?: number } = {}) {
      // 新窗口的材质刚被补上，`surface.applied` 可能与上次广播时不同 ——
      // 合并进这一份载荷，渲染层才不会拿着过期的"没开材质"去铺不透明底。
      const surface = lastTheme ? applyNativeSurface(lastTheme) : null
      const base = opts && opts.incognito && lastPrivatePayload ? lastPrivatePayload : lastPayload
      if (base) {
        const payload = surface ? { ...base, surface } : base
        if (typeof broadcast === 'function') {
          const windowId = opts && opts.windowId
          broadcast(THEME_CHANGED_EVENT, payload, windowId != null ? { windowId } : undefined)
        }
        return payload
      }
      return publish()
    },
    publish,
    getCurrentPayload() {
      return lastPayload
    },
    /**
     * 让一只**非主窗口**（独立面板窗口等）跟随主题的窗口材质（亚克力 / Mica）。
     *
     * 为什么由 theme-runtime 出面而不是调用方自己调 `applyWindowBackdrop`：
     * "当前主题的材质是什么"只有这里知道（含装饰器流水线 / 私密皮肤），
     * 各窗口若自己算一遍，迟早与主窗口的材质漂移。
     *
     * 调用时机：窗口建好、`loadURL` 之后立刻调 —— 原生材质是窗口级效果，
     * 不需要等页面加载完；早一步开，首帧就能透出系统模糊（少一次"先实心再变玻璃"的闪）。
     * 窗口 `closed` 时自动注销；主题后续变化由 `applyNativeSurface` 统一重放。
     *
     * @param {Electron.BrowserWindow} win
     * @returns {{ material: string, applied: boolean, supported: boolean, reason: string, message: string }|null}
     */
    followWindowMaterial(win: BrowserWindow): MaterialFollowResult | null {
      const result = materialFollow.follow(win)
      // 主题可能还没发布过（极端启动时序）：补一次当前值，保证"登记即生效"。
      if (!lastTheme) return result
      materialFollow.sync({
        material: windowMaterialSpec(lastTheme).material,
        fallbackColor: derivePalette(lastTheme).bg
      })
      return result
    },
    /**
     * 某个主题（**可以是编辑器草稿**）对应的窗口材质状态 —— 只回答，不落地。
     *
     * 为什么需要它：`theme:active` / `theme:tokens` / `theme:preview` 这几条读口
     * 不经过 `publish()`（它们要按**发起窗口**解析主题，还可能是一份没保存的草稿），
     * 拿不到 `lastPayload.surface`。少了这一口，晚加载的内部页会以为"窗口没开材质"
     * 而给 chrome 铺一层不透明底 —— 亚克力就被自己盖住了。
     *
     * `applied` 只在"这份主题就是当前生效的那一份、且材质一致"时才可能为真；
     * 草稿预览一律 `false`（草稿并没有被应用到窗口上，谎报会让编辑器提示失真）。
     * `supported` 永远来自能力探测 —— 那是这台机器的属性，与主题无关。
     *
     * @param {object} theme
     * @returns {{ material: string, applied: boolean, supported: boolean, reason: string, message: string }}
     */
    describeSurface(theme: ThemeData): ThemeSurface {
      const caps = getBackdropCapabilities()
      const spec = windowMaterialSpec(theme)
      const live = lastPayload && lastPayload.surface ? lastPayload.surface : null
      const isLive = !!(live && live.material === spec.material)
      const supported = caps.nativeMaterial
      return {
        material: spec.material,
        applied: isLive ? !!live.applied : false,
        supported,
        reason: isLive ? live.reason || '' : (supported ? '' : (caps.platform !== 'win32' ? 'unsupported-platform' : 'unsupported-build')),
        message: isLive ? live.message || '' : ''
      }
    }
  }
}

