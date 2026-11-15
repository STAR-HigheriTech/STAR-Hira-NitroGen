import { z } from 'zod'

/**
 * PWA（把站点安装为应用）IPC 契约。
 *
 * ── 为什么请求里只有 candidateId ─────────────────────────────────────
 * 应用名、start_url、图标、manifest 全部是**主进程探测出来的**。渲染层只负责
 * 「用户点了哪一个候选」，绝不把候选内容再回传一遍 —— 否则渲染层就成了可信输入，
 * 一个被注入的页面就能伪造 start_url 装出一个指向别处的"应用"。
 *
 * ── 为什么响应里没有绝对路径 ─────────────────────────────────────────
 * `toApp()` 只给 `hasXxx` 布尔；快捷方式路径、资产目录都留在主进程。
 * 这里再钉一遍形状，domain 哪天多回一个字段也会在 IPC 闸门被剥掉。
 *
 * ── 唯一的路径例外：iconUrl ─────────────────────────────────────────
 * 图标**必须**由主进程给出 `hira-pwa://` 地址（`paths.iconUrl` 是拼 URL 的唯一真源）：
 * 渲染层既拿不到资产目录，也不该自己拼协议串。`iconUrl` 只是可展示的 URL，
 * 不带磁盘路径，因此不违反上面的收敛原则。
 */

const pwaAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string().nullable(),
  startUrl: z.string(),
  scope: z.string().nullable(),
  display: z.string(),
  themeColor: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  installKind: z.string(),
  source: z.string(),
  hasIcon: z.boolean(),
  /** `hira-pwa://` 图标地址；无图标时为 null。由主进程 `paths.iconUrl` 生成。 */
  iconUrl: z.string().nullable(),
  hasSmallIcon: z.boolean(),
  hasIco: z.boolean(),
  hasStartMenuShortcut: z.boolean(),
  hasDesktopShortcut: z.boolean(),
  runOnStartup: z.boolean(),
  windowState: z.unknown().nullable(),
  updateState: z.string(),
  lastCheckedAt: z.number().nullable(),
  lastLaunchedAt: z.number().nullable(),
  launchCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

const okSchema = z.object({ ok: z.boolean(), reason: z.string().optional() })

const previewSchema = z.object({
  appId: z.string(),
  name: z.string(),
  shortName: z.string().nullable(),
  kind: z.string(),
  origin: z.string(),
  startUrl: z.string(),
  themeColor: z.string().nullable(),
  iconUrl: z.string().nullable(),
  installedId: z.string().nullable()
})

const shortcutFailureSchema = z.object({
  location: z.string().optional(),
  filePath: z.string().optional(),
  reason: z.string()
})

/** 快捷方式位置：只允许用户可见的两个（startup 由开机启动开关管理）。 */
const shortcutLocation = z.enum(['desktop', 'start-menu'])

const pwaSchemas = Object.freeze({
  list: Object.freeze({
    request: z.unknown().optional(),
    response: z.array(pwaAppSchema)
  }),

  get: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: pwaAppSchema.nullable()
  }),

  /**
   * 准备安装：返回 candidateId + 预览。**不落盘、不写库**。
   * 候选过期（10 分钟）或标签已导航，一律 `ok:false`。
   */
  prepare: Object.freeze({
    request: z.object({ tabId: z.string().optional() }).optional(),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      candidateId: z.string().optional(),
      preview: previewSchema.optional()
    })
  }),

  /** 切标签时回放状态：不创建候选，纯查询。 */
  state: Object.freeze({
    request: z.object({ tabId: z.string().min(1) }),
    response: z.object({
      state: z.string(),
      candidateId: z.string().nullable(),
      appId: z.string().nullable(),
      kind: z.string().nullable()
    })
  }),

  install: Object.freeze({
    request: z.object({
      candidateId: z.string().min(1),
      // 用户在安装确认框里改过的名称；缺省则用 manifest / 页面标题
      name: z.string().trim().min(1).max(120).optional(),
      createDesktopShortcut: z.boolean().optional(),
      createStartMenuShortcut: z.boolean().optional(),
      runOnStartup: z.boolean().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      app: pwaAppSchema.optional(),
      created: z.boolean().optional(),
      iconSource: z.string().optional(),
      shortcutFailures: z.array(shortcutFailureSchema).optional()
    })
  }),

  uninstall: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: okSchema
  }),

  launch: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: okSchema
  }),

  update: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: okSchema
  }),

  checkUpdates: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      updated: z.array(z.string()).optional()
    })
  }),

  setRunOnStartup: Object.freeze({
    request: z.object({ id: z.string().min(1), enabled: z.boolean() }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional(), app: pwaAppSchema.optional() })
  }),

  createShortcut: Object.freeze({
    request: z.object({ id: z.string().min(1), location: shortcutLocation }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional(), filePath: z.string().optional() })
  }),

  removeShortcut: Object.freeze({
    request: z.object({ id: z.string().min(1), location: shortcutLocation }),
    response: okSchema
  }),

  /**
   * 应用窗导航（chrome 按钮 / 菜单）。
   *
   * `action` 的取值由**应用窗控制器**（`pwa/window.js`）定义 —— 这里刻意不写 enum：
   * 动作集合属于窗口能力，契约只负责"是个字符串"。若在此再列一遍，加一个动作就要
   * 改两处，迟早漂移；未知动作由控制器回 `{ok:false, reason:'未知动作'}`。
   */
  navigate: Object.freeze({
    request: z.object({
      appId: z.string().min(1),
      action: z.string().min(1).optional(),
      url: z.string().optional(),
      zoom: z.number().optional()
    }),
    response: okSchema
  }),

  getWindowState: Object.freeze({
    request: z.object({ appId: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), state: z.unknown().optional() })
  }),

  /** 单向 send：chrome 高度上报（无 response）。 */
  chrome: Object.freeze({
    request: z.object({ appId: z.string().min(1), height: z.number() })
  }),

  // ── PWA 应用窗运行时能力（查找 / 缩放 / 浮层）──────────────────────────
  // 全部是单向 send：这些通道由应用窗自己的 chrome / 浮层发出，主进程按
  // `event.sender` 反查所属应用窗（PWA 窗不在 runtimeRegistry 里，泛用路由会串台）。
  // appId 只是冗余校验，真正定位靠 sender。
  findQuery: Object.freeze({
    request: z.object({
      appId: z.string().min(1),
      text: z.string().optional(),
      forward: z.boolean().optional(),
      findNext: z.boolean().optional()
    })
  }),

  findStop: Object.freeze({
    request: z.object({ appId: z.string().min(1), action: z.string().optional() })
  }),

  findClose: Object.freeze({
    request: z.object({ appId: z.string().min(1) })
  }),

  /** 菜单「查找」：等价于 Ctrl+F（已开且可见时只聚焦，不重复开栏）。 */
  findToggle: Object.freeze({
    request: z.object({ appId: z.string().min(1) })
  }),

  zoomStep: Object.freeze({
    request: z.object({ appId: z.string().min(1), delta: z.number().optional() })
  }),

  zoomReset: Object.freeze({
    request: z.object({ appId: z.string().min(1) })
  }),

  /** 浮层布局上报：与主窗口 `findbar-overlay / zoom-overlay` 共用渲染页，靠 scope 分流。 */
  overlayDisplay: Object.freeze({
    request: z.object({
      appId: z.string().min(1),
      name: z.string().min(1),
      width: z.number(),
      height: z.number(),
      position: z.string().optional(),
      align: z.string().optional(),
      valign: z.string().optional(),
      margin: z.number().optional(),
      interactive: z.boolean().optional()
    })
  }),

  overlayHide: Object.freeze({
    request: z.object({ appId: z.string().min(1), name: z.string().min(1) })
  }),

  overlayReady: Object.freeze({
    request: z.object({ appId: z.string().min(1), name: z.string().min(1) })
  }),

  /**
   * 单向 send：tab-preload 上报安装线索。
   * manifestUrl 可为 null（站点应用档），但 documentUrl 必须是 http(s)。
   * 这里不校验协议 —— 探测层要做「静默丢弃」，校验失败不应在渲染层报错。
   */
  candidate: Object.freeze({
    request: z.object({
      documentUrl: z.string(),
      manifestUrl: z.string().nullable(),
      title: z.string(),
      themeColor: z.string().nullable(),
      faviconUrl: z.string().nullable().optional()
    })
  })
})

export { pwaSchemas, pwaAppSchema }

