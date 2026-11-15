/**
 * webPreferences —— 全库唯一的 WebPreferences 定义点（P0-04）。
 *
 * 安全基线（contextIsolation / sandbox / nodeIntegration）在此定义一次，
 * 所有窗口与 WebContentsView（主窗口 / 子窗口 / tab / panel / rail / 浮层）共用，
 * 仅以「preload 名 + 覆盖项」参数化。任何散落的 webPreferences 字面量都视为回归。
 *
 * **彻底解耦**：本模块是叶子模块，只依赖 path 与 appRoot，零 electron、零副作用。
 * 不 require 任何窗口/视图模块，故可被 WindowFactory 与 WebContentsManager 同时复用，
 * 不会形成环形依赖。
 */
import path from 'node:path'
import { getAppRoot } from '@hira-ng/shared-utils'

export type WebPreferenceOptions = Omit<
  Electron.WebPreferences,
  'preload' | 'contextIsolation' | 'nodeIntegration' | 'nodeIntegrationInWorker' | 'nodeIntegrationInSubFrames' | 'sandbox' |
  'webviewTag' | 'allowRunningInsecureContent' | 'webSecurity'
> & {
  preload?: string | false
}

/** out/preload/<name>.js 的绝对路径 */
export function defaultPreloadPath(name = 'shell'): string {
  return path.join(getAppRoot(), 'out', 'preload', `${name}.js`)
}

/**
 * 构造安全基线 WebPreferences。
 * @param {object} [options]
 * @param {string|false} [options.preload] 覆盖默认 preload（默认 out/preload/shell.js）；
 *   传 **false** 表示「明确不要任何 preload」（扩展弹窗这类非特权页面）
 * @param {object} [options.extra] 其余附加/覆盖字段（如 session / partition）
 * @returns {Electron.WebPreferences}
 */
export function buildWebPreferences(options: WebPreferenceOptions = {}): Electron.WebPreferences {
  const { preload, ...extra } = options
  return {
    ...extra,
    // 注意判等号而不是 `preload || 默认值`：`false` 是**有效取值**（表示不要 preload），
    // 用 `||` 判空会让 false 悄悄掉回默认 shell preload —— 那等于把 hira 桥
    // （window.hira）注入到扩展自己的页面里，既是安全口子也会污染扩展页。
    ...(preload === false ? {} : { preload: preload || defaultPreloadPath('shell') }),
    // Non-negotiable security invariants. They deliberately come after `extra`
    // so a caller cannot weaken the renderer boundary by forwarding a loose object.
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    webSecurity: true,
    /**
     * 拼写检查：Electron 默认 **true**。
     *
     * 基线服务的是**我们自己的**页面（ui-shell / rail / 全部面板 / 全部浮层 / 子窗口），
     * 其中没有需要拼写检查的正文输入 —— 少数输入框（设置搜索 / 笔记 / TOTP）
     * 本就在元素级写了 `spellcheck = false`。留着 true 等于每个外壳 renderer
     * 都白养一套拼写检查客户端、还会在会话里触发词典请求（多进程 × 常驻）。
     * 标签与独立侧栏承载真实网页，由 `buildTabWebPreferences` 显式开回 true。
     */
    spellcheck: false
  }
}

/**
 * 构造标签 WebContentsView 的 WebPreferences —— 对齐 RT tab.ts#createWebContentsView。
 *
 * 在安全基线之上补齐标签专属项，使内嵌页面行为与独立浏览器完全一致：
 *  - webSecurity：开启同源策略（默认即 true，显式声明）
 *  - scrollBounce：滚动回弹/惯性滚动（流畅手感来源）
 *  - safeDialogs：页面连续弹窗时自动加"阻止此页面创建更多对话框"
 *  - navigateOnDragDrop：拖放文件到页面即可导航
 *  - transparent：页面底透明，由 view 背景色决定（内嵌页 / 普通页分别处理）
 *  - spellcheck：**显式开回 true** —— 基线为了省掉外壳 renderer 的拼写客户端关掉了它，
 *    而标签 / 独立侧栏里是真实网页，输入框的拼写检查是功能，不能跟着一起关。
 *  - backgroundThrottling：**显式 true**（Electron 默认即 true，见下方注释）——
 *    后台降频不是"要不要开"，而是"绝对不能被关"。
 *  - nodeIntegrationInSubFrames：**显式 false**（不删，留作"为什么关"的注释载体）。
 *
 *   实测（含 14 个 iframe 的同一页面，交替顺序 3 轮取中位）：
 *   注入子框架 42.8MB / 不注入 32.8MB —— **每个 iframe ≈ 0.71MB**，真实网页 5–20 个
 *   iframe 就是每标签 3.5–14MB。开销的主体不是"执行"而是 **代码在每个 frame 里被
 *   V8 解析编译**：沙箱 preload 不能 require / 动态 import 本地文件，password-autofill
 *   等模块只能静态进 bundle，因此代码必然被每个 frame 编译一遍，无法靠惰性启动规避。
 *   代价（已确认接受）：iframe 内的 `alert/confirm/prompt` 不再走自定义对话框桥；
 *   iframe 内的密码自动填充失效。主框架完全不受影响（preload 照常注入主框架）。
 *
 * @param {object} [options] 同 buildWebPreferences（preload / 覆盖项）
 */
export function buildTabWebPreferences(options: WebPreferenceOptions = {}): Electron.WebPreferences {
  return buildWebPreferences({
    ...options,
    scrollBounce: true,
    safeDialogs: true,
    navigateOnDragDrop: true,
    transparent: true,
    spellcheck: true,
    /**
     * 后台降频：Electron 默认 **true**，这里显式写死。
     *
     * 标签切到后台走的是 `view.setVisible(false)`（不是 removeChildView），Chromium 收到
     * WasHidden 后自己就会：停掉渲染合成、停 rAF、把定时器降到约 1 次/秒 —— 也就是说
     * "后台降频"是**已经生效的默认行为**，本行不改变任何运行时表现。
     *
     * 显式声明是为了**防守**：Electron 文档写明"同一 BrowserWindow 内只要有**任一**
     * displayed webContents 关掉了 backgroundThrottling，整窗所有 webContents 的帧
     * 都会被持续绘制与交换"。面板 / 浮层为了"首帧不空白 + 秒开"确实关掉了它
     * （见 WebContentsManager 里的 0×0 + 保持 visible 那套）—— 一旦哪天有人图省事
     * 把标签也关掉，整窗的后台节流会一起失效，且症状是"风扇转 / GPU 占用高"这种
     * 极难归因的账。写在这里，改的人就得先读到这段话。
     *
     * 再往下压只有三条路，都不是"没影响"：暂停（进度断 / 直播断 / 站点统计失真）、
     * 静音（听觉语义变了）、降 playbackRate（变调变慢）。而"暂停后台静音媒体"还会
     * 和既有语义冲突 —— 静音媒体仍算媒体型标签、豁免休眠（TabRules#sleepCandidates）。
     * `webContents.setFrameRate` 只对 offscreen 渲染有效，标签不是 offscreen，套了无效；
     * 真正"停止任务"要冻结，走 web-contents-freeze.js 的 CDP 路线。
     */
    backgroundThrottling: true
  })
}

