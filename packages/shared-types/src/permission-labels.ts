/**
 * 权限类型 → 中文名（单一真源）
 *
 * ── 为什么放在 packages/shared-types ────────────────────────────────────
 * 这份文件被**三层、三种加载方式**同时引用，放在任何单一 app 里都会造成依赖倒挂：
 *   · ui 层哑组件（ui/ui-panel-permissions）：vite 打包，直接 `import` 本文件；
 *   · 站点信息聚合浮层（apps/app-main/src/renderer/siteinfo-overlay）：vite 打包，同上；
 *   · hira:// 内部页（apps/app-main/src/pages/permissions）：无打包器的静态页，
 *     只能 import 静态文件 —— 由 `electron.vite.config.js` 的 sync-shared-contracts
 *     插件按原样复制到 `out/pages/_shared/permission-labels.mjs`，页面用
 *     `hira://shared/permission-labels.mjs` 引用（与 ipc-channels.mjs 同一机制、同一目录）。
 *
 * ── 本文件同时是「权限**展示规格**」的唯一真源（不止中文名）────────────
 * 权限请求出现在三处界面（浮层 / 侧栏面板 / 内部页），它们的**选项集合**必须逐字一致 ——
 * 否则用户会在两处看到两套说法（"允许/拒绝" vs "允许一次/始终允许"），而这类不一致
 * 每次都要改三遍、必然漏一处。因此下面两样也住在这里：
 *   · `PERMISSION_CHOICES` —— 四档决定（允许一次 / 始终允许 / 阻止一次 / 始终阻止）；
 *   · `hostOfOrigin` —— 站点可读化（只给 hostname，绝不裸露协议 / 端口 / 路径）。
 * 三处界面只负责"把这份规格画出来 + 落自己的样式类"，**不得各写一份文案或判据**。
 *
 * 为什么**不能**留在 `apps/`：`ui/` 层不允许反向依赖 `apps/`（依赖方向必须是
 * ui → packages，不能是 ui → apps）。放在本包与管理层同目录的先例
 * `ipc-channels.mjs` 一致 —— PACKAGES 层各层都可依赖。
 *
 * 用 **`.mjs`** 而不是 `.js`，与 ipc-channels.mjs 同因：本包入口 `src/index.js` 是 CJS，
 * 若本文件是 `.js` 就会被 Node 按 CJS 解析，`export const` 直接语法错误；
 * `.mjs` 不依赖任何 package.json 的 `type` 字段，Node 与 vite/rollup 都一律按 ESM 处理。
 *
 * ── 类型清单（不是自创，来源可追溯；**本文件就是唯一真源**）──────────────
 * `PERMISSION_TYPES` 同时供两层消费：
 *   · `domain/domain-permission/src/permissionUtil.ts` —— 判定"某类型能不能落库"；
 *   · 权限页 / 浮层 / 侧栏面板 —— 决定"怎么显示、筛选项有哪些"。
 * 领域层曾经自己抄了一份同名同序的数组，于是"领域层加了新类型、权限页永远看不到"
 * （显示成「其它权限（…）」）或反之（页面列得出来、判定却 unsupported）都不会报错。
 * 现在两边 require 同一个数组，清单变更只有一处。
 *
 * 清单内容承接自旧 Hira permissionManager 的真实处理清单：
 *   · pagePermissionRequestHandler 显式分支：notifications / push / media / pointerLock /
 *     geolocation / clipboard-sanitized-write / fullscreen
 *   · isSupportedSitePermission 白名单：midi / midiSysex / hid / serial / bluetooth /
 *     usb / sensors / idle-detection / idleDetection / clipboard-read / clipboard-write /
 *     display-capture / window-management / storage-access / top-level-storage-access /
 *     local-fonts / fileSystem
 *   · Electron 43 新增（领域层补录）：mediaKeySystem / keyboardLock / speaker-selection /
 *     deprecated-sync-clipboard-read
 *   · NG 独立链路：openExternal
 *   · NG 站点守卫（APPS 侧判定，不是 Electron 权限名）：popup（一次弹多个窗口）/
 *     automatic-downloads（同一站点连续触发多次下载）
 *     —— `popup` 曾经只是历史落库别名，现已升为规范类型
 *   · 历史落库别名：notification（单数）/ camera / microphone
 *
 * 新增类型只改这一处：加进 PERMISSION_TYPES 再来 LABELS / ICON_KEYS 各补一行。
 *
 * ── 兜底纪律 ─────────────────────────────────────────────────────────
 * 未识别的类型一律渲染成「其它权限（<原始值>）」—— 代码名只能出现在括号里作为补充，
 * 绝不作为主标签裸露给用户。
 */

/** 规范类型顺序（筛选下拉与领域层判定共用这一份；新增类型只改这里）。 */
export const PERMISSION_TYPES = Object.freeze([
  // 核心（Hira pagePermissionRequestHandler 显式分支）
  'notifications',
  'push',
  'media',
  'pointerLock',
  'geolocation',
  'clipboard-sanitized-write',
  'fullscreen',
  'openExternal',
  // Hira isSupportedSitePermission 白名单
  'midi',
  'midiSysex',
  'hid',
  'serial',
  'bluetooth',
  'usb',
  'sensors',
  'idle-detection',
  'idleDetection',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'window-management',
  'storage-access',
  'top-level-storage-access',
  'local-fonts',
  'fileSystem',
  // Electron 43 新增 / 旧清单漏项
  'mediaKeySystem',
  'keyboardLock',
  'speaker-selection',
  'deprecated-sync-clipboard-read',
  // NG 独立链路：这两个类型**不是** Electron 的权限名，而是 APPS 侧站点守卫
  // （main/site-guard.js）判定的事实 —— 页面一次弹多个窗口 / 连续触发多次下载。
  // `popup` 曾只是历史落库别名，现在升为**规范类型**：拦截询问、规则持久化
  // （允许 / 阻止 / 询问）与其它权限走同一张表、同一套 UI，不再另开一条路。
  'popup',
  'automatic-downloads',
  // 兼容别名（历史落库 / 询问弹窗展示）
  'notification',
  'camera',
  'microphone'
])

/**
 * 类型 → 中文名。
 * 两处容易被抄错、这里刻意写清语义：
 *   · `display-capture` 是「屏幕共享」（getDisplayMedia 抓屏），**不是**位置信息；
 *   · `media` 是 getUserMedia 的合并类型（摄像头 + 麦克风），**不是**「媒体自动播放」。
 */
const LABELS = Object.freeze({
  notifications: '通知',
  push: '推送通知',
  notification: '通知',
  media: '摄像头和麦克风',
  camera: '摄像头',
  microphone: '麦克风',
  geolocation: '位置信息',
  pointerLock: '指针锁定',
  fullscreen: '全屏',
  openExternal: '打开外部应用',
  'clipboard-sanitized-write': '剪贴板写入',
  'clipboard-write': '剪贴板写入',
  'clipboard-read': '剪贴板读取',
  'display-capture': '屏幕共享',
  'idle-detection': '空闲检测',
  idleDetection: '空闲检测',
  'storage-access': '存储访问',
  'top-level-storage-access': '顶级存储访问',
  'window-management': '窗口管理',
  'local-fonts': '本地字体',
  fileSystem: '文件系统',
  mediaKeySystem: '受保护媒体（DRM）',
  keyboardLock: '键盘锁定',
  'speaker-selection': '扬声器选择',
  'deprecated-sync-clipboard-read': '剪贴板读取（旧版同步）',
  hid: 'HID 设备',
  serial: '串行设备',
  usb: 'USB 设备',
  bluetooth: '蓝牙设备',
  sensors: '传感器',
  midi: 'MIDI 设备',
  midiSysex: 'MIDI 系统独占',
  popup: '弹出窗口',
  'automatic-downloads': '自动下载'
})

/** 未识别类型的兜底前缀：后面拼原始值，保证可追溯但不当主标签。 */
const FALLBACK_PREFIX = '其它权限'

/**
 * 类型 → 图标键名（**纯数据，不产生任何 DOM 依赖**）。
 *
 * 键名取自 `ui/ui-common/src/icons.ts` 的 ICON_REGISTRY。为什么不在本文件直接引用
 * 那份实现：shared-types 被主进程 / hira:// 静态页 / vite 三处加载，其中静态页没有
 * 打包器，引入 ui 层会把 DOM 依赖带进纯数据层。视图侧只需 `iconByName(key)` 一次转换。
 *
 * 为什么返回**数组**：`media` 是 getUserMedia 的合并类型（摄像头 + 麦克风），
 * 只画一个图标会让用户分不清页面到底要哪个；旧 Hira 按 `details.mediaTypes` 拆开，
 * NG 不携带该细分信息，因此两个都画（宁可多一目了然，也不要少得让用户猜）。
 *
 * 未识别 → 空数组（视图据此不画图标区），与"代码名绝不当主标签"同一纪律。
 * @param {string} type
 * @returns {string[]}
 */
const ICON_KEYS = Object.freeze({
  notifications: ['Bell'],
  push: ['Bell'],
  notification: ['Bell'],
  media: ['Camera', 'Mic'],
  camera: ['Camera'],
  microphone: ['Mic'],
  geolocation: ['Globe'],
  pointerLock: ['MousePointer2'],
  fullscreen: ['Square'],
  openExternal: ['ArrowUpRight'],
  'clipboard-sanitized-write': ['CopyPlus'],
  'clipboard-write': ['CopyPlus'],
  'clipboard-read': ['CopyPlus'],
  'display-capture': ['Monitor'],
  'idle-detection': ['Clock'],
  idleDetection: ['Clock'],
  'storage-access': ['Layers'],
  'top-level-storage-access': ['Layers'],
  'window-management': ['AppWindow'],
  'local-fonts': ['Pencil'],
  fileSystem: ['Archive'],
  mediaKeySystem: ['Lock'],
  keyboardLock: ['Lock'],
  'speaker-selection': ['Volume2'],
  'deprecated-sync-clipboard-read': ['CopyPlus'],
  hid: ['MousePointer2'],
  serial: ['Network'],
  usb: ['Blocks'],
  bluetooth: ['Zap'],
  sensors: ['ScanLine'],
  midi: ['Volume2'],
  midiSysex: ['Volume2'],
  popup: ['AppWindow'],
  'automatic-downloads': ['Download']
})

/** @param {string} type @returns {string[]} */
export function permissionIcons (type: string) {
  const raw = typeof type === 'string' ? type.trim() : ''
  if (!raw) return []
  return ICON_KEYS[raw as keyof typeof ICON_KEYS] || []
}

/**
 * 类型 → 中文名（**永不返回空、永不返回代码名当主标签**）。
 * 未识别 → 「其它权限（<原始值>）」；空值 → 「其它权限」。
 * @param {string} type
 * @returns {string}
 */
export function permissionLabel (type: string) : string {
  const raw = typeof type === 'string' ? type.trim() : ''
  if (!raw) return FALLBACK_PREFIX
  return LABELS[raw as keyof typeof LABELS] || `${FALLBACK_PREFIX}（${raw}）`
}

/**
 * 筛选下拉的中文选项（不含「全部权限」，那一项由调用方自己加）。
 *
 * 为什么按中文名去重、而不是按类型逐个列：`notifications` 与历史别名
 * `notification`、`idle-detection` 与 `idleDetection`、`clipboard-sanitized-write`
 * 与 `clipboard-write` 的中文名相同，逐个列会出现多个一模一样的选项。
 * 去重只影响「下拉里显示几行」，不影响覆盖范围 —— 筛选命中判据是同名即命中，
 * 所以每个语义都被覆盖到，**一个类型也不会漏**。
 * @returns {string[]}
 */
export function permissionFilterOptions () : string[] {
  const seen = new Set<string>()
  const options: string[] = []
  for (const type of PERMISSION_TYPES) {
    const label = LABELS[type as keyof typeof LABELS]
    if (!label || seen.has(label)) continue
    seen.add(label)
    options.push(label)
  }
  return options
}

/**
 * 权限决定的**四档**（浮层 / 侧栏面板 / 内部页三处共用同一份规格）。
 *
 * 为什么要四档而不是"允许 / 拒绝"两个按钮：`persist` 是**语义不同**的两种决定 ——
 * 「一次」只回答当前请求，不生成可复用的授权；「始终」会写进权限库，
 * 之后同站点不再询问。合成两个按钮就等于替用户默认选了"始终"，
 * 那是一个用户没做过的决定（对齐 Chrome / Edge 的 once / always 两轴）。
 *
 * 字段是**纯数据**，不含任何界面细节（类名 / 图标 / 布局各视图自己定）：
 *   · key     稳定标识（视图据此映射自己的样式类，如 `--${key}`）
 *   · allow   true = 允许，false = 阻止
 *   · persist true = 写库（始终），false = 仅本次（一次）
 *   · label   按钮主标签（中文，唯一真源）
 *   · hint    该档的完整解释（按钮 title / aria-label，也是浮层里那句说明的来源）
 */
export const PERMISSION_CHOICES = Object.freeze([
  Object.freeze({ key: 'allow-once', allow: true, persist: false, label: '允许一次', hint: '允许本次使用，不记住该站点' }),
  Object.freeze({ key: 'allow-always', allow: true, persist: true, label: '始终允许', hint: '允许并记住该站点，之后不再询问' }),
  Object.freeze({ key: 'deny-once', allow: false, persist: false, label: '阻止一次', hint: '仅本次阻止，不记住该站点' }),
  Object.freeze({ key: 'deny-always', allow: false, persist: true, label: '始终阻止', hint: '阻止并记住该站点，之后不再询问' })
])

/**
 * 权限落库值（`setting` 列）的**三值真源**：允许 / 阻止 / 询问。
 *
 * 它与上面的 `PERMISSION_CHOICES` 不是一回事：那是"请求弹窗的四档决定"，
 * 这里只描述**已落库的状态**。三个消费方都必须引用这一份：
 *   · domain-permission#isValidSetting / sanitizeSetting —— 校验与归一；
 *   · 迁移适配器（migration/adapters/permissions.js）—— 旧数据入库前校验；
 *   · 权限页 / 站点信息浮层 —— 下拉遍历与"库里有脏值"判定。
 *
 * **顺序**是规范顺序（allow → block → ask），但**标签与展示顺序不在这里**：
 * 权限页叫「询问」（它是可设置的默认行为）、浮层叫「清除」（它实际做的事是删规则），
 * 两种措辞各有理由，强行统一反而会让其中一处说谎。
 */
export const PERMISSION_SETTINGS = Object.freeze(['allow', 'block', 'ask'])

/**
 * 落库三态 → 中文名（**权限页 / 权限面板**的措辞）。
 *
 * 站点信息浮层的 `ask` 叫「清除」是刻意的另一套措辞（它实际做的事是删规则），
 * 浮层以本表为基础只覆盖那一档，不再各抄一遍 allow / block。
 */
export const PERMISSION_SETTING_LABELS = Object.freeze({
  allow: '允许',
  block: '阻止',
  ask: '询问'
})

/**
 * 规则行内「设为…」的两个动作（`ask` 不在这里：清除走 `permission:remove`）。
 * 值集合仍是 `PERMISSION_SETTINGS` 的子集，标签取自上面同一份表。
 */
export const PERMISSION_SETTING_ACTIONS = Object.freeze([
  ['allow', PERMISSION_SETTING_LABELS.allow],
  ['block', PERMISSION_SETTING_LABELS.block]
])

/**
 * 扩展清单（manifest）里三个**声明权限的字段** —— 唯一真源。
 *
 * MV3 把权限分成三类，语义不同、判定也不同：
 *   · `permissions`           必选 API 权限（缺了扩展起不来）；
 *   · `optional_permissions`  运行期可选（`chrome.permissions.request` 时才要）；
 *   · `host_permissions`      站点 / 主机模式（匹配范围，不是 API 权限）。
 *
 * 两个消费方的用法**刻意不同**，各自在调用点注明原因：
 *   · domain-extension#collectPermissions —— 三类全取（清单体检要看全部声明）；
 *   · infra-extensions#getWarnings       —— 三类全取（同上）；
 *   · infra-extensions#collectPermissionNames —— 只取活动权限（见该处注释）。
 */
export const MANIFEST_PERMISSION_KEYS = Object.freeze([
  'permissions',
  'optional_permissions',
  'host_permissions'
])

/** 判定 setting 是否合法（库值 / 旧数据 / UI 取值都走这一处）。 */
export function isValidPermissionSetting (setting: unknown): boolean {
  return typeof setting === 'string' && PERMISSION_SETTINGS.some((value) => value === setting)
}

/** 归一：非法值一律回落 `'ask'`（"没有规则"才是安全的默认）。 */
export function normalizePermissionSetting (setting: unknown): 'allow' | 'block' | 'ask' {
  return isValidPermissionSetting(setting) ? setting as 'allow' | 'block' | 'ask' : 'ask'
}

/**
 * 站点可读化：只给用户看 hostname，绝不裸露完整 URL / origin。
 *
 * 为什么不用 origin 原文：origin 带着 `https://` 与端口（请求来源本身就是 origin，
 * 见 main.js#originOf），对"哪个站点在要权限"这件事全是噪声；hostname 才是用户认得出来的名字。
 * URL 解析失败（裸域名 / 内部页）时退回原值并剥掉协议与路径。
 * @param {unknown} origin
 * @returns {string} 空值 → 「当前页面」（宁可给一句人话，也不留空白）
 */
export function hostOfOrigin (origin: unknown) : string {
  const raw = typeof origin === 'string' ? origin.trim() : ''
  if (!raw) return '当前页面'
  try {
    const u = new URL(raw)
    if (u.hostname) return u.hostname
    return raw
  } catch {
    return raw.replace(/^[a-zA-Z][\w+.-]*:\/\//, '').split(/[/?#]/)[0] || raw
  }
}
