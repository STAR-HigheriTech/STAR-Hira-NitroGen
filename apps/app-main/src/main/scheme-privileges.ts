/**
 * scheme-privileges.ts —— **全库唯一**的 `protocol.registerSchemesAsPrivileged` 调用点。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么必须只有一次调用（这是实测出来的，不是风格问题）
 * ══════════════════════════════════════════════════════════════════════
 * Electron 的这个 API **不是追加语义，而是覆盖语义**：
 * 第二次调用会把第一次登记的整份清单**替换**掉，只有最后一次生效。
 *
 * 曾经五个模块各自在 `main.js` 顶层调一次，按顺序是
 *   hira → hira-game → hira-plugin → hira-theme → hira-pwa
 * 于是最终**只有 `hira-pwa` 是特权协议**，其余四个全部退回「未登记」：
 *   · `hira-plugin://` 在渲染进程里 `fetch()` 直接抛
 *     `URL scheme "hira-plugin" is not supported` —— HTML / XAML 面板入口全白屏；
 *   · `hira-game://` 的 `localStorage` / ES module 失效（游戏存档丢失）；
 *   · `hira-theme://` 的视频背景拿不到流式响应；
 *   · `hira://` 的 `fetch()` 与 V8 code cache 一并失效。
 *
 * 共同特征是：**`protocol.handle()` 明明是好的**（导航、图片照常），只有
 * 「渲染进程发起的请求 / 存储 / 流」坏掉 —— 因此极难归因，看起来像协议没注册。
 *
 * 所以：**新增协议 = 往 `SCHEMES` 里加一行**。不要在任何别处再调那个 API。
 *
 * 另一个必须在这里的原因是「特权级别会演进」：加一条 `supportFetchAPI` 或收紧
 * `allowServiceWorkers`，只改一张表才不会漏改。
 */

const { protocol } = require('electron')
const { registerUrlScheme } = require('@hira-ng/infra-window') as {
  registerUrlScheme(scheme: string): void
}
const { HIRA_SCHEME } = require('./hira-protocol') as { HIRA_SCHEME: string }
const { PLUGIN_SCHEME } = require('./plugin-protocol') as { PLUGIN_SCHEME: string }
const { THEME_SCHEME } = require('./theme-asset-protocol') as { THEME_SCHEME: string }
const { PWA_SCHEME } = require('./hira-pwa-protocol') as { PWA_SCHEME: string }
const {
  RT_BROWSER_SCHEME,
  RT_INTERNAL_SCHEME,
  RT_EXTERNAL_SCHEME
} = require('./rt-protocol-constants') as {
  RT_BROWSER_SCHEME: string
  RT_INTERNAL_SCHEME: string
  RT_EXTERNAL_SCHEME: string
}
import { GAME_SCHEME } from './external-games/catalog'

interface SchemePrivileges {
  readonly standard: boolean
  readonly secure: boolean
  readonly supportFetchAPI: boolean
  readonly allowServiceWorkers: boolean
  readonly corsEnabled: boolean
  readonly stream: boolean
  readonly codeCache?: boolean
}

interface SchemeRegistration {
  readonly scheme: string
  readonly privileges: SchemePrivileges
}

/**
 * 各 scheme 的特权清单。
 *
 * 逐条都必须是**有意的**：
 *   · `standard`   —— 走 RFC 3986 的通用 URL 语法，相对路径能解析；
 *                     **也是 Web Storage / IndexedDB 可用的前提**（游戏存档依赖它）。
 *   · `secure`     —— 视为可信来源（不被当作混合内容拦掉），否则 ES module / fetch 受限。
 *   · `supportFetchAPI` —— 渲染进程的 `fetch()` 能请求它。没有这条就是本次那个白屏。
 *   · `corsEnabled`     —— 允许跨源读取（面板 iframe 是 opaque origin，必须能读）。
 *   · `stream`          —— `<video>` / `<audio>` 按流式处理（主题的视频背景）。
 *   · `codeCache`       —— V8 字节码缓存复用（内部页 / 插件模块冷启动）。
 *   · `allowServiceWorkers: false` —— 一律关：这批 scheme 全是只读静态资源，
 *     注册 Service Worker 只会变成一条绕过协议鉴权的持久化后门。
 */
export const PRIVILEGES = Object.freeze({
  /** 应用自己的内部页（settings / history / 新标签页…）。 */
  app: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: true,
    codeCache: true
  }),
  /** 第三方静态 bundle（移植进来的游戏）。 */
  game: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: true,
    codeCache: true
  }),
  /** 插件目录（渲染模块 / 面板入口 / 主题包背景图 / 字体）。 */
  plugin: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: true,
    codeCache: true
  }),
  /** 用户主题自己的背景图片（与插件目录刻意分开，只发图片 / 视频）。 */
  themeAsset: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: true
  }),
  /** 已安装 PWA 的图标资产（只发 4 个白名单图片）。 */
  pwaAsset: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: true
  }),
  /** RT 兼容页：与 RT 保持相同的 fetch / Service Worker 限制。 */
  rtBrowser: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: false,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: false,
    codeCache: true
  }),
  /** RT 浏览器内部页。 */
  rtInternal: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: false,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: false,
    codeCache: true
  }),
  /** RT 外部静态 bundle：保留流式媒体。 */
  rtExternal: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: false,
    allowServiceWorkers: false,
    corsEnabled: true,
    stream: true,
    codeCache: true
  })
})

/**
 * 全部特权 scheme —— **一张表就是全部事实**。
 * 顺序无关（一次性提交），但保持「内部页 → 外部 bundle → 插件 → 主题 → PWA」的阅读顺序。
 */
export const SCHEMES: readonly SchemeRegistration[] = Object.freeze([
  { scheme: HIRA_SCHEME, privileges: PRIVILEGES.app },
  { scheme: GAME_SCHEME, privileges: PRIVILEGES.game },
  { scheme: PLUGIN_SCHEME, privileges: PRIVILEGES.plugin },
  { scheme: THEME_SCHEME, privileges: PRIVILEGES.themeAsset },
  { scheme: PWA_SCHEME, privileges: PRIVILEGES.pwaAsset },
  { scheme: RT_BROWSER_SCHEME, privileges: PRIVILEGES.rtBrowser },
  { scheme: RT_INTERNAL_SCHEME, privileges: PRIVILEGES.rtInternal },
  { scheme: RT_EXTERNAL_SCHEME, privileges: PRIVILEGES.rtExternal }
])

/**
 * 需要被 `TabManager#normalizeUrl` 认成「可浏览地址」的 scheme。
 *
 * 与「特权」是两件事：特权决定**能不能**被 fetch / 存储，这里决定用户把它输进地址栏时
 * 该不该补 `https://`。少了这一步，`hira-game://dino/index.html` 会被补成
 * `https://hira-game://…`（ERR_NAME_NOT_RESOLVED）。
 */
export const BROWSABLE_SCHEMES: readonly string[] = Object.freeze([
  HIRA_SCHEME,
  GAME_SCHEME,
  RT_BROWSER_SCHEME,
  RT_INTERNAL_SCHEME,
  RT_EXTERNAL_SCHEME
])

let done = false

/**
 * 注册全部应用 scheme（特权 + 可浏览）。**必须在 `app.ready` 之前调用一次**。
 *
 * 幂等：重复调用直接返回 —— 防的是"某个模块顺手又调了一次"把清单覆盖掉的老坑。
 * （真正的保险是调用点只有 `main.js` 顶层一处，见文件头。）
 */
export function registerAppSchemes(): void {
  if (done) return
  done = true
  protocol.registerSchemesAsPrivileged(SCHEMES.map(({ scheme, privileges }) => ({ scheme, privileges })))
  for (const scheme of BROWSABLE_SCHEMES) registerUrlScheme(scheme)
}

