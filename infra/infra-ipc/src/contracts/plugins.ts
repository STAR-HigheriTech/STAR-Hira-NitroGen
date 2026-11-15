import { z } from 'zod'
// 信任级别（official / community / local）的真源；主进程安装器与插件面板引同一份。
const { PLUGIN_TRUST_LEVELS } = require('@hira-ng/shared-types/src/plugin-trust.mjs')

/**
 * 插件中心（Harness Plugin Center）契约。
 *
 * 与其它域的唯一差别：本域返回的是「插件自身的元数据」，不是业务数据 ——
 * 因此字段形状直接对应 hira-plugin.json + PluginRegistryV2.describe()。
 * 这里给出一份显式 schema，作用有两层：
 *   1. 运行期校验：注册中心给不出 name/type 时（旧 manifest）归一化已兜底，
 *      但一旦形状漂移，IPC 边界会立刻报错而不是把 undefined 塞进 UI。
 *   2. 契约即文档：插件中心 UI 只认这份 schema，不反向猜注册中心内部结构。
 */
/**
 * 一条「HTML / XAML 面板 UI」声明（`contributes.panels[].ui`）。
 *
 * 形状与 `@hira-ng/shared-types/src/plugin-ui.mjs#normalizePanelUi` 逐字一致 ——
 * zod 会剥掉未声明字段，漏一个字段 = 渲染层永远拿不到 ui（表现为面板白屏）。
 *
 * `url` 由主进程算好（协议是 URL 形状的唯一权威），渲染层只管 `fetch(url)`：
 * 拼两份必然漂移，漂移的表现是"改了面板不生效"。
 */
const panelUiEntrySchema = z.object({
  // 面板 id（= contributes.panels[].id），用来把声明与面板条目对上。
  panelId: z.string(),
  // 插件目录内的相对路径（已归一化为 `a/b/c.html`，无 `..`、无绝对路径）。
  entry: z.string(),
  kind: z.enum(['html', 'xaml']),
  // 可加载 URL：`hira-plugin://<id>/<entry>?v=<mtime>`。
  url: z.string(),
  // 面板标题（panel.title → 插件 name 兜底），桥/调试用。
  title: z.string(),
  // 入口文件 mtime；`?v=` 已带上，单独回传便于 UI 判断"是否需要重载"。
  version: z.number().nullable()
})

/** 插件内部页：URL 由主进程解析，渲染层只负责打开。 */
const pluginPageSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  title: z.string(),
  entry: z.string(),
  dir: z.string(),
  host: z.string(),
  url: z.string(),
  order: z.number()
})

const pluginInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  trustLevel: z.string(),
  main: z.string().nullable(),
  // 渲染进程入口（相对 plugins 目录的路径，null = 该插件没有渲染侧代码）。
  // 渲染层用它动态 import 插件自带的 UI 模块 —— 见 §6 缺口的 entry.render。
  render: z.string().nullable(),
  /**
   * 渲染入口的**可加载 URL**（`hira-plugin://<id>/<file>?v=<mtime>`），`null` = 无渲染入口。
   *
   * 由主进程算好下发（APPS 的协议层是 URL 形状的唯一权威），渲染层只管
   * `import(item.renderUrl)` —— 绝不在渲染层自己拼：两份实现必然漂移，
   * 而漂移的表现是"改了代码不生效"或"插件 UI 整个加载不出来"，都极难查。
   *
   * 构建期打包（`import.meta.glob`）**未命中时**回落到它 —— 运行时安装的第三方插件
   * 本来就不在构建产物里，glob 永远不可能命中它们。
   */
  renderUrl: z.string().nullable(),
  /**
   * 渲染入口的版本号（= 文件 mtime）。拼在 `renderUrl` 的 `?v=` 上，
   * 于是"作者改了渲染代码"必定产生新 URL、必定重新加载；没改则命中缓存不重复解析。
   */
  renderVersion: z.number().nullable(),
  /**
   * manifest **顶层**声明的 UI 文档（`ui` / `html` / `view` / `entry` → `.html`/`.xaml`）。
   *
   * 与 `panelUi` 的区别：`panelUi` 是**逐面板**解析好的入口清单（已拼 URL），
   * 本字段是原始声明 —— 面板项只写了 id、入口写在顶层时，面板可继承它。
   * 清单自查（`plugin_list` 的 `panels[].implementation`）也要用它，
   * 否则会把"能渲染"的面板误报成 `none`。
   */
  uiEntry: z.object({
    entry: z.string(),
    kind: z.enum(['html', 'xaml'])
  }).nullable().optional(),
  /**
   * 该插件贡献的 HTML / XAML 面板（第三种面板来源：交付一个文件就是一块面板）。
   *
   * 空数组 = 它没有 UI 面声明。渲染层据此决定走哪条分支：
   *   `render`（JS 渲染模块） → `panelUi`（沙箱 iframe + srcdoc） → `ui-panel-*` 内置包。
   * 优先级顺序即上面的顺序，写死在 `panels/host.js#resolvePanelDefinition`。
   */
  panelUi: z.array(panelUiEntrySchema),
  /** `contributes.pages` 的可加载结果（已注册到 hira:// 协议层）。 */
  pages: z.array(pluginPageSchema),
  /**
   * manifest 的纯数据贡献（`contributes`）。
   *
   * 渲染进程据此**提前判定**要不要 import 这个插件的渲染模块：`panels` 决定
   * "是不是面板插件"、`rendererSlots` 决定"贡献了哪些渲染侧插槽"。没有这份声明，
   * 每个窗口只能"先全量 import 再丢弃"——浮层会白拉整块面板代码并误报插槽无人宿主
   * （见 apps/app-main/src/renderer/shared/plugin-slots.js）。
   */
  contributes: z.record(z.string(), z.unknown()),
  /** 是否来自**用户目录**（运行时安装的第三方插件）。UI 据此分组与提示。 */
  runtime: z.boolean(),
  capabilities: z.array(z.string()),
  // ── 依赖关系（§10.2「体现」的数据面）────────────────────────────────
  // 正向：「我依赖谁」。hard = 缺了就是配置错误；soft = 存在就用、不在也照装，
  //       是**降级**语义（PART7 §7.4）。两者在 UI 上必须分开呈现。
  dependsOn: z.array(z.string()),
  optionalDependsOn: z.array(z.string()),
  // 反向：「谁依赖我」。禁用前的连带范围就是这一栏 —— 少了它，用户只会看到
  // "这个开关关不掉"（依赖保护拒绝），却不知道为什么。
  requiredBy: z.array(z.string()),
  optionalRequiredBy: z.array(z.string()),
  conflictsWith: z.array(z.string()),
  installed: z.boolean(),
  enabled: z.boolean(),
  // 五态（见 PluginRegistryV2 的 _userDisabled / _autoDisabled / markFailed / markBlocked）：
  //   userDisabled —— 用户主动关的，会持久化
  //   autoDisabled —— 运行期连环出错被系统停用的，**也持久化**，但用户可一键恢复
  //   failed       —— 启用时抛错，不持久化、下次启动自动重试
  //   blocked      —— 硬前置未启用，它**一行代码都没跑**（根因在上游，不在它自己）
  //   error        —— 失败/停用/受阻原因（原文回传，供插件中心显示）
  userDisabled: z.boolean(),
  autoDisabled: z.boolean(),
  failed: z.boolean(),
  blocked: z.boolean(),
  blockedBy: z.array(z.string()),
  // 第 6 态：等用户授权（PART7 §7.5）。非第一方 + 声明了权限 + 尚未授权。
  awaitingConsent: z.boolean(),
  // 权限面：`requestedPermissions` 是它想要的，`grantedPermissions` 是用户给过的。
  // 两者分开呈现，否则"声明"会被误读成"已获得"。
  requestedPermissions: z.array(z.string()),
  grantedPermissions: z.array(z.string()),
  // scope → 中文名（只含本插件申请到的那些）。翻译表跟着 scope 的权威定义走，
  // 不让渲染层各抄一份 —— 否则加 scope 时必然漏改一处。
  requestedPermissionLabels: z.record(z.string(), z.string()),
  permissionLevel: z.string(),
  isFirstParty: z.boolean(),
  // 主动健康检查（PART7 §7.5 `lifecycle.healthCheck`）：null = 该插件没声明检查。
  // `healthCheckFailures` 是当前连续失败次数 —— 触顶（被自动停用）之前用户就该看得见。
  healthCheck: z.object({
    enabled: z.boolean(),
    intervalMs: z.number(),
    timeoutMs: z.number(),
    failures: z.number()
  }).nullable(),
  healthCheckFailures: z.number(),
  /**
   * 是否**不可禁用**（`trustLevel === 'core'` 或显式 `nonDisableable`）。
   *
   * 由主进程算好下发，而不是让 UI 自己拼那条判定 —— 它是**会演进**的
   * （将来可能再加第三类"不可禁用"），UI 自己拼必然漏改一处。
   * 典型成员：`tabs-service` / `settings-service`（核心）、
   * `panel-plugins` / `side-panel-skeleton`（唯一出口：关掉就没有回头路）。
   */
  nonDisableable: z.boolean(),
  error: z.string().nullable()
})

/**
 * 功能面可用性（§10.4「UI 与引擎的联动禁用」的查询面）。
 *
 * 为什么单独一条路由而不是塞进 `plugins:list`：
 *  · 语义不同 —— `plugins:list` 是"有哪些插件"，这里是"哪些功能面现在能用"；
 *  · 消费方不同且多得多 —— 书签栏 / 星标 / ⋮ 菜单 / 下载条… 约二十个入口只关心后者，
 *    不该为了一个布尔值去解析 25 份 manifest（那也等于把映射逻辑复制二十份）。
 *
 * `available` 的键是功能面 id（见 `apps/app-main/src/main/feature-map.js`），
 * 值为 `false` 表示"提供它的引擎被显式关掉了 → UI 入口应当隐藏"。
 * 缺键一律按**可用**处理（fail-open）：新增功能面时旧调用方不会因为拿不到键而误隐藏。
 *
 * 订阅复用既有的 `plugins:changed`（启停/自动停用/连带禁用都会广播）——
 * 不新增事件，这就是 §10.4 说的"一处订阅"。
 */
const featureAvailabilitySchema = z.object({
  available: z.record(z.string(), z.boolean())
})

const pluginsSchemas = Object.freeze({
  // 列出全部已发现插件（manifest + 运行态）。
  // 注册中心尚未就绪时（插件后台启动中）返回空清单而非报错 —— 插件中心会在
  // 收到 plugins:changed 广播后自动补齐，不会卡在「加载中」。
  list: Object.freeze({
    request: z.object({}).optional(),
    response: z.object({ plugins: z.array(pluginInfoSchema) })
  }),
  /**
   * 启用 / 禁用单个插件。禁用后插件注册的 provider 与扩展点被摘除。
   *
   * `cascade`（§10.3 的连锁语义，选定方案 b「确认后一起禁用」）：
   *   禁用时若存在**已启用的下游**，主进程**不直接照做**，而是回一条
   *   `requiresCascade: true` + `dependents: [...]` —— UI 拿它弹确认（"将同时禁用 X、Y"），
   *   用户确认后带 `cascade: true` 再发一次。两段式而不是"静默级联"：
   *   用户按下的是一次点击，不该顺手关掉他自己看不见的一串东西。
   */
  setEnabled: Object.freeze({
    request: z.object({
      id: z.string().min(1),
      enabled: z.boolean(),
      // 用户在确认框里点了"一起禁用"→ 才会带上它
      cascade: z.boolean().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.string(),
      enabled: z.boolean(),
      // 失败原因（如「核心插件不可禁用」「前置未启用」）—— 带回 UI 显示，
      // 不让用户面对一个点了没反应的开关。
      reason: z.string().optional(),
      // 需要用户确认的连带禁用（见上方说明）：不带 cascade 时由主进程回填
      requiresCascade: z.boolean().optional(),
      dependents: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      // 启用时**顺带恢复的前置**（用户此前关掉、但这次启用必须用到的）。
      // 回传给 UI 是为了"告知"而不是"请示"：恢复是这次意图的必然含义，
      // 但用户有权知道他关过的东西被重新打开了。
      restored: z.array(z.object({ id: z.string(), name: z.string() })).optional()
    })
  }),
  /**
   * 功能面可用性查询 —— 见上方 `featureAvailabilitySchema` 的说明。
   * 无入参：它答的是"此刻"，不是"某个插件的"。
   */
  features: Object.freeze({
    request: z.object({}).optional(),
    response: featureAvailabilitySchema
  }),
  /**
   * 授权第三方插件声明的权限（PART7 §7.5 的授权弹窗）。
   *
   * `scopes` 必须**原样回传**插件声明的那份清单（UI 无权自行增减）——
   * 否则一个被篡改的渲染层就能给插件塞进它没申请的权限。
   * 传空数组 = 撤销授权（插件回到"等待授权"态）。
   */
  grantPermissions: Object.freeze({
    request: z.object({
      id: z.string().min(1),
      scopes: z.array(z.string())
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.string(),
      enabled: z.boolean(),
      reason: z.string().optional()
    })
  }),
  /**
   * 热重载一个插件（重读 manifest + 重新编译模块代码，原本在跑的重启）。
   *
   * 为什么要有它：改一行插件代码就要重启整个浏览器，是这个系统最大的开发体验缺口。
   * 失败**必须把原因带回 UI**（新代码加载不了 → 插件停在停用态），
   * 不让作者误以为"我的改动已经生效了"。
   */
  reload: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      id: z.string(),
      enabled: z.boolean(),
      reason: z.string().optional()
    })
  }),
  /**
   * 在系统文件管理器里打开**用户插件目录**（`userData/plugins`）。
   *
   * 为什么它属于"社区市场"那一半：安装一个第三方插件，在当前阶段就是
   * "把插件目录拷进这个位置"。先把这个入口给出来，用户才知道该往哪放；
   * 真正的市场（下载 / 校验 / 解包 / 版本管理）是建立在这条路之上的后续工作。
   * 目录不存在时会先创建 —— 打开一个不存在的路径在 Windows 上是静默失败。
   */
  openDir: Object.freeze({
    request: z.object({}).optional(),
    response: z.object({ ok: z.boolean(), path: z.string().nullable() })
  }),
  /**
   * 安装一个插件（社区市场的落盘那一步）。
   *
   * `source` 决定"用户选的是什么"：
   *   · `directory` —— 一个插件文件夹（里面直接躺着 `hira-plugin.json`）
   *   · `archive`   —— 一个 zip 包（解出来应是同样形态）
   * `path` **省略**时由主进程弹系统选择框（目录 / zip 文件），于是渲染层
   * 不需要为了"选个文件"再学一套 API，也不会拿到任何本地路径能力。
   *
   * `overwrite` 默认 false：同 id 已存在时**先报错**，而不是悄悄替换 ——
   * 替换一个已经装好的插件（可能带着用户的授权与数据）必须是用户明确点的那一下。
   *
   * 返回的 `signature` 四态（`none` / `unknown-key` / `valid` / `invalid`）是**提示**，
   * 不参与是否安装的判定（见 plugin-installer.js 文件头的说明）。
   */
  install: Object.freeze({
    request: z.object({
      source: z.enum(['directory', 'archive']),
      path: z.string().optional(),
      overwrite: z.boolean().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      // 用户在选择框里取消了 —— 不是失败，UI 不该报错
      canceled: z.boolean().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      version: z.string().optional(),
      signature: z.object({
        status: z.string(),
        keyId: z.string().optional(),
        reason: z.string().optional()
      }).optional(),
      warnings: z.array(z.string()).optional(),
      reason: z.string().optional()
    })
  }),
  /**
   * 安装一个**用户脚本**（`.user.js`）。
   *
   * 用户脚本在本项目里**就是插件**（`type: "userscript-plugin"`）：落盘走同一条
   * 安装器（体检 / 撞名 / 安全边界），收尾走同一个 `afterInstallHook`。于是
   * 启停开关、卸载、广播、失败原因全部复用插件中心，不存在第二套生命周期。
   *
   * `text` 给"粘贴脚本"用；`path` 省略且无 `text` 时由主进程弹选择框
   * （渲染层永远不碰本地路径 API）。
   */
  installUserscript: Object.freeze({
    request: z.object({
      // 粘贴进来的脚本全文（优先于 path）
      text: z.string().optional(),
      path: z.string().optional(),
      overwrite: z.boolean().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      version: z.string().optional(),
      signature: z.object({
        status: z.string(),
        keyId: z.string().optional(),
        reason: z.string().optional()
      }).optional(),
      warnings: z.array(z.string()).optional(),
      reason: z.string().optional()
    })
  }),
  /**
   * 用户脚本清单 + 单脚本启停。
   *
   * 为什么粒度是**脚本**而不是插件：一个插件可以一次贡献多条 `contributes.userscripts`
   * （AI 工作室生成的插件就可能这样）。按插件开关会让"关掉一条"顺手关掉同一插件的其它条。
   *
   * `key` 是主进程算好的稳定键（`<pluginId>/<scriptId>`），UI 只负责回传 ——
   * 让 UI 自己拼，等于把"怎么拼"复制到第二处，迟早和存储层对不上。
   * **不含源码**：面板只需要元数据；源码只流向注入点。
   */
  listUserScripts: Object.freeze({
    request: z.object({}).optional(),
    response: z.object({
      scripts: z.array(z.object({
        key: z.string(),
        id: z.string(),
        pluginId: z.string(),
        name: z.string(),
        namespace: z.string(),
        version: z.string(),
        description: z.string(),
        author: z.string(),
        icon: z.string(),
        homepage: z.string(),
        license: z.string(),
        runAt: z.string(),
        match: z.array(z.string()),
        include: z.array(z.string()),
        exclude: z.array(z.string()),
        grant: z.array(z.string()),
        require: z.array(z.string()),
        connect: z.array(z.string()),
        order: z.number(),
        file: z.string(),
        enabled: z.boolean()
      }))
    })
  }),
  setUserscriptEnabled: Object.freeze({
    request: z.object({
      key: z.string().min(1),
      enabled: z.boolean()
    }),
    response: z.object({
      ok: z.boolean(),
      key: z.string(),
      enabled: z.boolean(),
      reason: z.string().optional()
    })
  }),
  /**
   * 卸载一个**运行时安装**的插件（删掉 `userData/plugins/<id>/`）。
   *
   * 与「禁用」是两件事：禁用只是不跑（资产还在、随时能开回来），卸载是把资产拿掉。
   * 主进程会先 `disable` 再删文件 —— 反过来会出现"代码没了但插件还启用着"的窗口。
   * 内置插件一律拒绝（它们的目录在应用安装目录里，删掉等于自毁）。
   */
  uninstall: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      id: z.string(),
      reason: z.string().optional()
    })
  }),
  /**
   * 受信任的签名公钥（验签的**另一半**）。
   *
   * 为什么这三条是必需的：验签逻辑早就在（见 §15.6），但"信任谁"只能靠用户手工把
   * `.pem` 丢进 `plugin-trust` 目录 —— 那等于这个功能对普通用户不存在。
   * 有了列出 / 导入 / 移除，签名才是**可用**的，而不是一个只在文档里存在的能力。
   *
   * **`level` 是三级信任分级**（见 `main/plugin-installer.js` 信任那一节）：
   *   · `official`  随应用分发，用户**不能导入也不能移除**（`removable: false`）；
   *   · `community` 用户在界面导入的作者公钥（默认级别）；
   *   · `local`     用户自己生成 / 开发用的。
   * 导入 / 移除都必须带级别：不同级别允许同名公钥，只给 keyId 无法确定动的是哪一个。
   */
  trustList: Object.freeze({
    request: z.object({}).optional(),
    response: z.object({
      keys: z.array(z.object({
        keyId: z.string(),
        fileName: z.string(),
        level: z.string(),
        // 官方级不可移除（它在应用资源目录里，而且"官方签名"不该被一次误操作搞没）
        removable: z.boolean(),
        // 公钥指纹（SPKI 的 sha256 前 16 位）：用户唯一能拿去和作者公布值核对的东西
        fingerprint: z.string(),
        algo: z.string(),
        // 解析失败的 `.pem` 也会列出来并标 false —— 否则用户会一直奇怪"签名为什么不生效"
        readable: z.boolean()
      }))
    })
  }),
  trustAdd: Object.freeze({
    request: z.object({
      // 省略 = 由主进程弹系统选择框挑一个 `.pem`
      path: z.string().optional(),
      // `official` 一律会被主进程拒绝（那是"随应用分发"的同义词）
      level: z.enum(PLUGIN_TRUST_LEVELS).optional(),
      overwrite: z.boolean().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      canceled: z.boolean().optional(),
      keyId: z.string().optional(),
      level: z.string().optional(),
      fingerprint: z.string().optional(),
      reason: z.string().optional()
    })
  }),
  trustRemove: Object.freeze({
    request: z.object({
      keyId: z.string().min(1),
      level: z.enum(PLUGIN_TRUST_LEVELS).optional()
    }),
    response: z.object({
      ok: z.boolean(),
      keyId: z.string().optional(),
      level: z.string().optional(),
      reason: z.string().optional()
    })
  }),
  /**
   * 插件源（社区市场的**索引那一半**）。
   *
   * 索引就是一个静态 JSON（条目形状见 `main/plugin-market.js` 文件头），所以这一层
   * **不需要服务端**：作者把索引与 zip 丢到任意静态托管上，用户填一个地址即可。
   * **可以配多个源**，顺序即优先级（同 id 靠前的胜出）。
   *
   * 每个源的状态**逐条回报**（`sources[]`）：一条源失败只影响它自己，
   * 界面上要能指出"坏的是哪个、坏在哪"，否则用户面对 3 个源只有一句笼统的失败。
   *
   * `updateAvailable` 由主进程算（本地 manifest 版本 vs 索引版本），UI 不自己比 ——
   * 版本号的比较口径只该有一处。
   */
  marketList: Object.freeze({
    request: z.object({
      // 跳过 60s 的短期缓存，强制出网（用户点"刷新"时用）
      force: z.boolean().optional()
    }).optional(),
    response: z.object({
      ok: z.boolean(),
      // 一个源都没有时的提示（源级原因在 sources[i].reason 里）
      reason: z.string().optional(),
      sources: z.array(z.object({
        url: z.string(),
        ok: z.boolean(),
        name: z.string(),
        reason: z.string(),
        cached: z.boolean(),
        // 被跳过的坏条目数（id/url 不合法或重复）—— 逐条隔离，一条坏不该让整个源打不开
        skipped: z.number(),
        count: z.number()
      })),
      // 同 id 在多个源里出现的次数：静默取靠前那个会让人以为另一个源没生效
      duplicates: z.number(),
      entries: z.array(z.object({
        id: z.string(),
        name: z.string(),
        version: z.string(),
        description: z.string(),
        author: z.string(),
        homepage: z.string(),
        url: z.string(),
        sha256: z.string(),
        // 这一条来自哪个源（同 id 在多源出现时，用户需要知道"装的是哪个源的包"）
        sourceUrl: z.string(),
        sourceName: z.string(),
        installed: z.boolean(),
        installedVersion: z.string(),
        updateAvailable: z.boolean()
      }))
    })
  }),
  /**
   * 设置**整个**源列表（增 / 删 / 排序都走这一条）。
   *
   * 为什么不做 add/remove 两条：界面上的"增删改"最终都是一次提交，
   * 拆成三条 IPC 会让"两条相继失败"产生一个界面上看不到的中间态。
   * 顺序即优先级，所以顺序也必须能被设置 —— 那就只有"整表提交"这一种语义是对的。
   */
  marketSetSources: Object.freeze({
    request: z.object({ sources: z.array(z.string()) }),
    response: z.object({
      ok: z.boolean(),
      sources: z.array(z.string()).optional(),
      reason: z.string().optional()
    })
  }),
  marketInstall: Object.freeze({
    request: z.object({
      id: z.string().min(1),
      // 默认允许覆盖（"从市场更新"就是要覆盖旧版本）；传 false 则只在未安装时安装
      overwrite: z.boolean().optional(),
      force: z.boolean().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.string(),
      version: z.string().optional(),
      name: z.string().optional(),
      // 索引声明了 sha256 且校验通过 —— 这是"从市场装"相对"自己下载"多出来的保证
      verified: z.boolean().optional(),
      signature: z.object({
        status: z.string(),
        keyId: z.string().optional(),
        reason: z.string().optional()
      }).optional(),
      warnings: z.array(z.string()).optional(),
      reason: z.string().optional()
    })
  }),
  // ── 插件键值存储（开放 API 的持久化面）────────────────────────────────
  //
  // 为什么需要这一组：HTML / XAML 面板跑在**无同源**的沙箱 iframe 里，`localStorage`
  // 随 opaque origin 每次加载都可能不同（等于没有持久化）；而 `settings:*` 有 schema
  // 校验，插件拿不到任意键。于是"我能存点东西"就成了插件开发的第一道墙。
  //
  // 为什么键名带 `pluginId` 而不是由主进程从调用方推断：沙箱 iframe 没有可信身份，
  // 主进程无法区分"插件 A 的面板"和"插件 B 的面板" —— 但**父侧桥**知道自己是替谁
  // 转发（`createPanelUiBridge` 的 pluginId 是构造参数）。桥负责用自己的 pluginId 覆写，
  // 渲染层传入值只是"契约形状"，越权请求在桥那一层就被替换掉。
  //
  // 隔离与配额全部在 `main/plugin-storage.js` 里强制（主键含 plugin_id，删除即清空），
  // 这里只做形状校验 —— 规则只写一处。
  storageGet: Object.freeze({
    request: z.object({ pluginId: z.string().min(1), key: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      // null = 该键不存在（与"存在但值为空串"区分开：前者不该覆盖调用方的默认值）
      value: z.string().nullable(),
      updatedAt: z.number().nullable(),
      reason: z.string().optional()
    })
  }),
  storageSet: Object.freeze({
    request: z.object({ pluginId: z.string().min(1), key: z.string().min(1), value: z.string() }),
    response: z.object({
      ok: z.boolean(),
      // 写入后的用量（键数 / 字节数），UI 可以据此提示"快满了"
      keys: z.number().optional(),
      bytes: z.number().optional(),
      reason: z.string().optional()
    })
  }),
  storageRemove: Object.freeze({
    request: z.object({ pluginId: z.string().min(1), key: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), removed: z.number(), reason: z.string().optional() })
  }),
  storageKeys: Object.freeze({
    request: z.object({ pluginId: z.string().min(1), prefix: z.string().optional() }),
    response: z.object({
      ok: z.boolean(),
      keys: z.array(z.object({ key: z.string(), updatedAt: z.number() })),
      reason: z.string().optional()
    })
  }),
  storageClear: Object.freeze({
    request: z.object({ pluginId: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), removed: z.number(), reason: z.string().optional() })
  }),
  // ── 插件浮层关闭（PART18）───────────────────────────────────────────
  // 渲染侧把"用户关掉了这个浮层"回报给主进程：浮层宿主据此释放记录，并让插件
  // 通过 `ctx.browser.events` 收到 `overlay:closed`（插件据此清理自己的状态）。
  overlayClose: Object.freeze({
    request: z.object({ key: z.string().min(1) }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional() })
  })
})

export { pluginsSchemas, pluginInfoSchema, featureAvailabilitySchema }

