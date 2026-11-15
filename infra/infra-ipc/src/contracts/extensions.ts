import { z } from 'zod'
// 变更类型 / 运行时状态真源（主进程、面板渲染与契约校验共用一份，见该文件顶部说明）。
const { EXTENSION_CHANGE_TYPES, EXTENSION_STATUSES } = require('@hira-ng/shared-types/src/extension-labels.mjs')
// 拦截级别（off / ads / ads+tracking）真源：infra 装配、设置 applier 与契约校验同一份。
const { ADBLOCKER_LEVELS } = require('@hira-ng/shared-types/src/adblocker.mjs')

const extensionChangeSchema = z.object({
  // load-failed：启动恢复 / 重试加载失败时上报（载荷带 message），让已打开的管理页/面板刷新出错误行
  type: z.enum(EXTENSION_CHANGE_TYPES),
  id: z.string(),
  profileId: z.string().optional(),
  enabled: z.boolean().optional(),
  // pinned：固定 / 取消固定（纯用户意图，不改变运行时）。随 extension:changed 下发，
  // 让已打开的管理页 / 面板即时对账。
  pinned: z.boolean().optional(),
  message: z.string().optional(),
  extension: z.unknown().optional()
})

const extensionsSchemas = Object.freeze({
  change: extensionChangeSchema,
  list: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  install: Object.freeze({ request: z.object({ path: z.string() }), response: z.unknown() }),
  uninstall: Object.freeze({ request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) }),
  toggle: Object.freeze({ request: z.object({ id: z.string(), enabled: z.boolean() }), response: z.object({ ok: z.boolean() }) }),
  // 「固定」是纯用户意图（对齐 RT 的 set-extension-pinned）：只写安装记录的 pinned 位，
  // **不碰运行时**。所以它与 toggle 是两条独立通道，不能合并 —— 合并会让
  // 「固定一个已停用的扩展」被迫先启用再固定。
  setPinned: Object.freeze({ request: z.object({ id: z.string(), pinned: z.boolean() }), response: z.object({ ok: z.boolean() }) }),
  importFolder: Object.freeze({ request: z.unknown().optional(), response: z.unknown() }),
  // level：生效中的拦截级别（off / ads / ads+tracking）。`enabled` 是它的布尔投影，
  // 保留是为了盾牌按钮等既有调用方；新调用方按 level 展示「拦截强度」。
  adblockerStatus: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      enabled: z.boolean(),
      level: z.enum(ADBLOCKER_LEVELS).optional()
    })
  }),
  adblockerToggle: Object.freeze({ request: z.object({ enabled: z.boolean() }), response: z.object({ ok: z.boolean() }) }),
  adblockerBlockedCount: Object.freeze({ request: z.unknown().optional(), response: z.number() }),
  // 内容拦截状态变更（main → renderer）：blocker 就绪/开关切换/级别切换都会推一条，
  // 盾牌图标据此刷新 —— 否则「启动时读一次状态」会永远停在 blocker 尚未就绪的 false 上。
  adblockerChange: Object.freeze({
    enabled: z.boolean(),
    level: z.enum(ADBLOCKER_LEVELS).optional(),
    profileId: z.string().optional()
  }),
  // error：启动恢复失败 / 重试失败（记录仍在、原因在 loadErrors 注册表，列表项随带 loadError）
  runtimeStatus: Object.freeze({ request: z.object({ id: z.string() }), response: z.enum(EXTENSION_STATUSES) }),
  reload: Object.freeze({ request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) }),
  diagnostics: Object.freeze({ request: z.object({ id: z.string() }), response: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })) }),
  warnings: Object.freeze({ request: z.object({ id: z.string() }), response: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })) }),
  // 打开扩展自身的页面。两项能力是否具备由**列表项**的 hasOptionsPage / hasPopup 表达
  // （infra 侧从运行时清单派生），所以响应只需回答「这一跳有没有真的发起」——
  // 拿不到地址（扩展没有该页 / 已停用而不在运行时）一律 ok:false，由调用方给中文提示。
  openOptions: Object.freeze({ request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) }),
  // 弹出窗口的 request 比选项页多两样东西，都是**渲染层才知道**的信息：
  //   · anchorRect —— 被点按钮在**发起方窗口内容区**里的矩形（对齐 RT：
  //     browserActionProvider 用 element.getBoundingClientRect() 现算）。ECE 的
  //     PopupView 就按这个矩形把弹窗锚到按钮下方；不传则退回窗口右上角。
  //   · alignment —— 对齐方式（'bottom' / 'top' / 'right bottom'…），语义与 ECE 一致：
  //     含 'top' 向上展开，含 'right' 向右展开，默认向右下对齐（弹窗左边贴按钮左边）。
  // 两者都可选：不传就是「没能力锚定」的安全默认值，不会让请求校验失败。
  openPopup: Object.freeze({
    request: z.object({
      id: z.string(),
      anchorRect: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number()
      }).partial().optional(),
      alignment: z.string().optional()
    }),
    response: z.object({ ok: z.boolean() })
  }),
  // 在标签页里打开该扩展的商店详情页（`homepage_url` / 商店详情路由，见 domain-extension
  // 的 storeUrlOf）。列表项已带 storeUrl，因此请求只传 id，主进程负责取地址并开新标签。
  openStore: Object.freeze({ request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) }),
  // 「检查视图」：把某个扩展的后台上下文交给开发者工具（对齐 Chrome / RT 的 inspectViews）。
  // target 由列表项 `inspectViews[].target` 原样回传；当前只有 'background-page' 真的能
  // 打开 DevTools，'service-worker' 底层没有入口（列表项会带 inspectable:false，UI 置灰），
  // 主进程对不支持的 target 一律如实返回 ok:false。
  inspectView: Object.freeze({
    request: z.object({ id: z.string(), target: z.string() }),
    response: z.object({ ok: z.boolean() })
  }),
  // 「更新」：立即检查并安装所有扩展的可用更新（对齐 RT 开发者模式工具条的「更新」）。
  // 无入参 —— 更新源只可能来自商店，筛选由库按 `update_url` 自己做。
  updateAll: Object.freeze({ request: z.unknown().optional(), response: z.object({ ok: z.boolean() }) })
})

export { extensionsSchemas }

