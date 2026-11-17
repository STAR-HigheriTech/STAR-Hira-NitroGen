/**
 * IPC 契约 · **preload 可见子集**（零依赖）
 *
 * ── 为什么单独一张表 ──────────────────────────────────────────────
 * preload 是沙箱（`sandbox: true`），只认相对路径 import；`@hira-ng/*` 包名会被
 * externalize 成运行时 require 而当场抛错。更要紧的是**体积**：preload 直接趴在
 * 每个顶层文档的首屏关键路径上（见 electron.vite.config.js#preloadSelfContainedPlugin）。
 * 而 `ipc-channels.mjs` 是主进程 / 渲染层的全量目录，压完仍有几十 KB ——
 * 为了 26 个名字让每个标签页都解析一遍，是纯浪费。
 *
 * 所以：**preload 需要自己拼通道名的那些条目，值只在这里定义一次**；
 * `ipc-channels.mjs` 用 `...PRELOAD_ROUTES` / `...PRELOAD_EVENTS` 把它们并回全量表，
 * 同名 key 会当场抛错（见那边的 withPreload）—— 不存在"两边各写一份、悄悄漂移"。
 *
 * ── 维护规则 ────────────────────────────────────────────────────
 *   · preload（tab / shell / panel / dialog）里需要某个通道 → 加到本表；
 *   · 只有主进程 / 渲染页面用 → 留在 ipc-channels.mjs；
 *   · **本文件必须零依赖** —— 任何 import 都会被打进每个标签页的 preload。
 */

export const PRELOAD_ROUTES = Object.freeze({
  // ── 框架通道（不属于任何业务域）────────────────────────────────
  /**
   * 事件订阅登记 / 退订：preload 直接 `on` 某个事件前要先发 add，主进程才把它
   * 算作"真订阅了"（见 ListenerRegistry）；取消订阅发 remove。
   * 两条都由 preload 自己拼（不走 ngipc provider），因此必须在这里定义。
   */
  listenersAdd: 'listeners:add',
  listenersRemove: 'listeners:remove',
  /**
   * 内容面里的可编辑元素明确拿到键盘（tab preload → main，单向 send）。
   * 主进程据此作废过期的“聚焦地址栏”重试链，并通知外壳 blur 地址栏 DOM。
   */
  contentFocus: 'content:focus',

  // Domain: Settings
  /** 读单个设置键（spatial-nav 引擎用它取开关初值；变更走 `IPC_EVENTS.spatialNav`）。 */
  settingsGet: 'settings:get',

  // Domain: Theme
  // 令牌表：内部页（hira://）与任何"没有 theme-controller 的渲染方"用它自取配色。
  // 与 theme:changed 的载荷是同一份 —— 前者给"加载时就要着色"的一次性读取，
  // 后者给"已经在了、等它变"的订阅方。
  themeTokens: 'theme:tokens',

  // Domain: Files —— 系统文件拖入窗口（外壳 / 面板 / 网页任意区域）。
  // 分流规则在主进程 file-open/policy.js：浏览器能渲染 → 本窗口新标签；
  // 不能渲染 → 系统默认程序；可执行文件 → 定位而不执行（见该文件说明）。
  filesDrop: 'files:drop',

  // Domain: History
  /**
   * E3 正文索引：tab preload 抽取到的页面正文上报给主进程（页面 → 主进程，invoke）。
   * 走 invoke 而非单向 send：写库失败要在页面控制台看得见（见 preload/page-text）。
   */
  pageTextCaptured: 'page-text:captured',

  // Domain: PWA —— tab-preload 上报安装线索（单向 send）。
  pwaCandidate: 'pwa:candidate',

  // Domain: Translate（C3 网页翻译）
  /** 页面翻译引擎请求一批文本的译文（页面 → 主进程，invoke），返回**等长同序**的译文。 */
  translateText: 'translate:text',
  /** 页面翻译引擎读取插件提供的语言检测与 DOM 策略。 */
  translatePageContext: 'translate:page-context',
  /** 翻译浮层切换目标语言（页面 → 主进程，invoke），同时持久化设置。 */
  translateTarget: 'translate:target',

  // Domain: BreakMode（D5 番茄钟 / 专注）
  // 浮层上的按钮（跳过本段 / 暂停恢复 / 退出专注）回传主进程。专注状态机全在主进程
  //（见 main/break-mode.js），页面侧只画倒计时并回传点击 —— 页面不认识"25 分钟"这件事。
  breakControl: 'break:control',

  // Domain: Automation（鼠标手势）
  /** 页面手势引擎上报方向序列（页面 → 主进程，invoke）。 */
  automationGesture: 'automation:gesture',
  /**
   * 方向序列 → 命令（页面 → 主进程，invoke）。
   * 页面引擎在空闲时/按下右键时取一次并缓存 —— 画的过程中据此**实时**显示
   * "这一笔会触发什么"（每帧都查主进程就谈不上即时了）。
   */
  automationGestureMap: 'automation:gesture-map',

  // Domain: FormFill（支付卡 / 地址）
  // 填充候选（页面侧 preload → 主进程）：按类型取可填条目（**带明文**）。
  // 唯一会把明文交给渲染层的一条 —— 主进程按 `privacy.form_autofill` 开关把关。
  formFillOptions: 'form-fill:options',

  // Domain: Password（S4-1）
  passwordBackends: 'password:backends',
  passwordGetSuggestions: 'password:get-suggestions',
  passwordSave: 'password:save',
  passwordNeverSaveAdd: 'password:never-save:add',
  passwordNeverSaveList: 'password:never-save:list',
  // Password 自动填充浮层（原生菜单窗口 + 保存提示卡，对齐 searchbar 下拉浮层）
  passwordAutofillMenu: 'password:autofill-menu',
  passwordCaptured: 'password:captured',
  passwordOverlayCommit: 'password:overlay-commit',

  // Domain: UserScripts
  /**
   * `GM_xmlhttpRequest` 的代理通道（页面 → 主进程，invoke）。
   *
   * 页面里的 GM 垫片只调 preload 桥 `window.__hiraGm.request`，真正的网络请求在主进程
   * 用 electron `net` 发出，**授权判定（`@grant` + `@connect`）也在主进程做** ——
   * 页面侧的脚本伪造不了自己的权限。见 main/userscript-runtime.js。
   */
  userscriptGmRequest: 'userscript:gm-request'
})

export const PRELOAD_EVENTS = Object.freeze({
  /**
   * 主题变更（main → renderer）：载荷 = 一次发布的完整内容
   * （`{ themeId, resolved, preference, tokens, background }`）。
   *
   * 收件方有三类，全部靠这一条：外壳（写根变量）、内部页（同）、新标签页（+背景层）。
   * 私密窗口会**额外**收到一条定向推送（私密主题），语义与这条完全一样 ——
   * 渲染层不需要知道"自己是不是私密窗口"（见 main/theme-runtime.js）。
   */
  themeChanged: 'theme:changed',
  /**
   * C3 网页翻译：主进程 → **某一页的 preload 引擎**（定向 `wc.send`，不是广播）。
   * payload = `{ to: string }`（目标语言）。再发一次 = 收起（回到原文）。
   */
  translatePage: 'translate:page',
  /**
   * N9 空间导航**开关**：主进程 → 各标签 preload（设置变更时广播）。
   * payload = `{ enabled: boolean }`。页面侧引擎据此即时开/关，**不用重进页面**。
   * 与 `translate:page` 同为"主进程 → preload 引擎"的一条线，只是这条是广播式。
   */
  spatialNav: 'input:spatial-nav',
  /**
   * D5 Break Mode 的推送线**不在这里**：它已经改成整窗原生浮层
   * （`IPC_EVENTS.breakOverlayShow / Update / Hide` → `out/renderer/break-overlay`），
   * 不再注入网页 preload —— 旧 `break:overlay` 页面覆盖层已删除。
   */
  // 密码浮层回传（main → tab 页面）：多凭据菜单选中 → 该标签页自动填充
  passwordAutofillMenuSelect: 'password:autofill-menu-select',
  // 主进程权威收起密码浮层（main → 发起页）：切标签 / 导航 / 窗口失焦时同步页内会话状态，
  // 避免 preload 侧 menuOpen 残留导致"点两次才弹"。
  passwordOverlayHidden: 'password:overlay-hidden',
  /**
   * 鼠标手势配置热更新（main → 每个标签页的 preload 手势引擎）。
   * payload = `{ enabled, map }` —— 关掉「启用鼠标手势」后，页面必须**立刻**停止
   * 画轨迹、也不再吞那一次右键菜单；只靠主进程丢弃上报会让开关看起来毫无作用。
   */
  automationGesturesConfig: 'automation:gestures-config',
  // 主进程推送：触发标签页生成/填充密码
  generatePassword: 'password:generate-request'
})
