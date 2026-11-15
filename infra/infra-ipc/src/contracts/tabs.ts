import { z } from 'zod'

/**
 * 栈的完整快照（查询接口统一形状）：元数据 + 成员。
 * 单列一份是为了让 get / of-tab / list 三个响应**形状一致**，
 * 调用方不必按接口记三种字段组合。
 */
const stackItemSchema = z.object({
  stackId: z.string(),
  label: z.string(),
  accent: z.string(),
  collapsed: z.boolean(),
  // 固定分组（Zen Essentials）：栈级标记，成员标签的 pinned 与它恒等。
  pinned: z.boolean().optional(),
  count: z.number(),
  children: z.array(z.string())
})

/** 通用 patch 的白名单字段（与 domain#TabStacks.updateStack 逐字一致）。 */
const stackPatchSchema = z.object({
  label: z.string().optional(),
  accent: z.string().optional(),
  collapsed: z.boolean().optional()
})

const tabsSchemas = Object.freeze({
  list: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  projection: Object.freeze({ request: z.unknown().optional(), response: z.array(z.unknown()) }),
  // 建栈：固定文件夹（pinned）允许 0 成员（先建文件夹、后添加标签）；
  // 普通标签组仍要求至少一个已存在成员 —— 该裁决在 infra#tabLayout.createStack，
  // schema 只负责类型，避免"同一个规则在两层各写一遍"。
  createStack: Object.freeze({ request: z.object({ tabIds: z.array(z.string()).optional().default([]), label: z.string().optional(), accent: z.string().optional(), collapsed: z.boolean().optional(), pinned: z.boolean().optional() }), response: z.object({ stackId: z.string(), label: z.string(), accent: z.string(), collapsed: z.boolean(), pinned: z.boolean().optional(), count: z.number(), children: z.array(z.string()) }) }),
  setStack: Object.freeze({ request: z.object({ tabId: z.string(), stackId: z.string().nullable().optional() }), response: z.object({ tabId: z.string(), stackId: z.string().nullable() }) }),
  toggleStack: Object.freeze({ request: z.object({ stackId: z.string() }), response: z.object({ stackId: z.string(), collapsed: z.boolean() }) }),
  renameStack: Object.freeze({ request: z.object({ stackId: z.string(), label: z.string() }), response: z.object({ stackId: z.string(), label: z.string() }) }),
  setStackColor: Object.freeze({ request: z.object({ stackId: z.string(), accent: z.string() }), response: z.object({ stackId: z.string(), accent: z.string() }) }),
  mergeStacks: Object.freeze({ request: z.object({ sourceStackId: z.string(), targetStackId: z.string() }), response: z.object({ sourceStackId: z.string(), targetStackId: z.string(), count: z.number() }) }),
  // 解散标签组：成员全部回到散标签（组元数据删掉）。响应回成员表，便于调用方给回执文案。
  //（domain 里另有 `splitStack`＝把**部分**成员迁到新组，那是规则能力、当前没有 UI 入口，
  //  所以这里也不留它的 IPC —— 菜单上曾经拿它冒充"拆分标签组"，点了外观不变＝没反应。）
  dissolveStack: Object.freeze({ request: z.object({ stackId: z.string() }), response: z.object({ stackId: z.string(), count: z.number(), children: z.array(z.string()) }) }),
  // ── 栈查询与通用 patch：把「查一个 / 查所属 / 查全部 / 是否在栈里」收成同形响应，
  //    并让「一次改多项」只产生一次 tab:changed（见 tabLayout#updateStack）。
  stackGet: Object.freeze({ request: z.object({ stackId: z.string() }), response: stackItemSchema.nullable() }),
  stackOfTab: Object.freeze({ request: z.object({ tabId: z.string() }), response: stackItemSchema.nullable() }),
  stackList: Object.freeze({ request: z.unknown().optional(), response: z.object({ stacks: z.array(stackItemSchema) }) }),
  stackIsTabInAny: Object.freeze({
    request: z.object({ tabId: z.string() }),
    response: z.object({ tabId: z.string(), inStack: z.boolean() })
  }),
  stackUpdate: Object.freeze({
    request: z.object({ stackId: z.string(), patch: stackPatchSchema }),
    response: z.object({
      stackId: z.string(),
      label: z.string(),
      accent: z.string(),
      collapsed: z.boolean(),
      changed: z.array(z.string())
    })
  }),
  // ── 分屏（Split View）—— 与标签栈**正交**（栈是收纳、分屏是并列）。
  //    所有"不合法"一律以 `null` 回应（成员 <2 / 超上限 / 目标组不存在），
  //    绝不用"空对象"或"静默成功"—— UI 据此给出原因，不出现"点了没反应"。
  splitItem: Object.freeze({
    splitId: z.string(),
    layout: z.string(),
    ratios: z.array(z.number()),
    members: z.array(z.string()),
    activeTabId: z.string().nullable()
  }),
  splitCreate: Object.freeze({
    request: z.object({
      tabIds: z.array(z.string()).min(2),
      layout: z.string().optional(),
      activeTabId: z.string().optional()
    }),
    response: z.object({ splitId: z.string(), layout: z.string(), count: z.number(), children: z.array(z.string()) }).nullable()
  }),
  // 「与当前活动标签分屏」：只收被点的那个标签，另一个由主进程解析（活动标签只有主进程权威）。
  splitWith: Object.freeze({
    request: z.object({ tabId: z.string() }),
    response: z.object({ splitId: z.string(), layout: z.string(), count: z.number(), children: z.array(z.string()) }).nullable()
  }),
  splitDissolve: Object.freeze({
    request: z.object({ splitId: z.string() }),
    response: z.object({ splitId: z.string() }).nullable()
  }),
  splitSet: Object.freeze({
    request: z.object({ tabId: z.string(), splitId: z.string().nullable() }),
    response: z.object({ tabId: z.string(), splitId: z.string().nullable() }).nullable()
  }),
  splitLayout: Object.freeze({
    request: z.object({ splitId: z.string(), layout: z.string() }),
    response: z.object({ splitId: z.string(), layout: z.string() }).nullable()
  }),
  splitActive: Object.freeze({
    request: z.object({ splitId: z.string(), tabId: z.string() }),
    response: z.object({ splitId: z.string(), tabId: z.string() }).nullable()
  }),
  splitReverse: Object.freeze({
    request: z.object({ splitId: z.string() }),
    response: z.object({ splitId: z.string(), members: z.array(z.string()) }).nullable()
  }),
  splitRatioPreset: Object.freeze({
    request: z.object({ splitId: z.string(), preset: z.string() }),
    response: z.object({ splitId: z.string(), ratios: z.array(z.number()) }).nullable()
  }),
  splitFocus: Object.freeze({
    request: z.object({ direction: z.enum(['left', 'right', 'up', 'down']) }),
    response: z.object({ splitId: z.string(), tabId: z.string() }).nullable()
  }),
  splitRestore: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ splitId: z.string(), count: z.number() }).nullable()
  }),
  splitList: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      splits: z.array(z.object({
        splitId: z.string(),
        layout: z.string(),
        ratios: z.array(z.number()),
        members: z.array(z.string()),
        activeTabId: z.string().nullable()
      })),
      // 有没有"最近解散的分屏"可复原。放进同一次响应而不是新开一条通道：
      // 消费方（标签右键菜单）本来就要在弹出前问一次组清单，顺路带回这个布尔，
      // 于是"复原"菜单项可以**精确地**只在真有东西可复原时出现（不出现点了没反应的项）。
      canRestoreSplit: z.boolean().default(false)
    })
  }),
  // ── 速览（Glance，A1）—— 第三条正交维度（栈收纳 / 分屏并列 / **速览叠放**）。
  //    恰好两张卡；"不合法"一律以 `null` 回应（成员数 ≠2 / 标签不存在），由 UI 给原因。
  glanceItem: Object.freeze({
    glanceId: z.string(),
    members: z.array(z.string()),
    frontTabId: z.string()
  }),
  glanceCreate: Object.freeze({
    request: z.object({
      tabIds: z.array(z.string()).min(2),
      frontTabId: z.string().optional()
    }),
    response: z.object({ glanceId: z.string(), count: z.number(), children: z.array(z.string()), frontTabId: z.string() }).nullable()
  }),
  // 「与被点的标签叠成速览」：另一个成员由主进程解析（活动标签只有主进程权威）。
  glanceWith: Object.freeze({
    request: z.object({ tabId: z.string() }),
    response: z.object({ glanceId: z.string(), count: z.number(), children: z.array(z.string()), frontTabId: z.string() }).nullable()
  }),
  glanceDissolve: Object.freeze({
    request: z.object({ glanceId: z.string() }),
    response: z.object({ glanceId: z.string() }).nullable()
  }),
  glanceFront: Object.freeze({
    request: z.object({ glanceId: z.string(), tabId: z.string() }),
    response: z.object({ glanceId: z.string(), tabId: z.string() }).nullable()
  }),
  glanceList: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      glances: z.array(z.object({
        glanceId: z.string(),
        members: z.array(z.string()),
        frontTabId: z.string()
      }))
    })
  }),
  new: Object.freeze({ request: z.object({
    url: z.string().optional(),
    // 容器标签（N10）：用**另一个 profile 的身份**开这个标签（cookie / 存储走它的 Session），
    // 但标签仍归属当前空间。可选 —— 不传就是普通标签。
    containerProfileId: z.string().optional(),
    // 后台新标签：Ctrl/Cmd/中键点击链接时创建、**不切过去**（口径见 shared-types#link-intent）。
    // 缺省 false = 前台新标签，与旧行为一致。
    openInBackground: z.boolean().optional()
  }).optional(), response: z.object({ tabId: z.string(), url: z.string() }) }),
  newIncognito: Object.freeze({ request: z.object({ url: z.string().optional() }).optional(), response: z.object({ tabId: z.string(), url: z.string() }) }),
  switch: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ tabId: z.string() }) }),
  close: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ closed: z.boolean(), tabId: z.string() }) }),
  closeOthers: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ closed: z.number() }) }),
  closeRight: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ closed: z.number() }) }),
  reorder: Object.freeze({ request: z.object({ draggedId: z.string(), targetId: z.string().optional(), insertAfter: z.boolean().optional(), targetStackId: z.string().optional() }).refine((value: { targetId?: string; targetStackId?: string }) => Boolean(value.targetId || value.targetStackId), { message: 'targetId or targetStackId is required' }), response: z.object({ ok: z.boolean() }) }),
  togglePin: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ tabId: z.string(), pinned: z.boolean() }) }),
  // 放进固定文件夹 = pin 动作（跨种类，不能走 setStack）。`stackId` 省略 → 默认固定组。
  pinnedGroupAdd: Object.freeze({
    request: z.object({ tabId: z.string(), stackId: z.string().nullable().optional() }),
    response: z.object({ tabId: z.string(), stackId: z.string().nullable(), pinned: z.boolean(), created: z.boolean() })
  }),
  toggleMute: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ tabId: z.string(), muted: z.boolean() }) }),
  // 周期性自动刷新（C7）：intervalMs = 0 表示关闭。响应回写下后的真实间隔
  //（服务端有下界夹取 —— 客户端据此显示"实际生效的档位"，而不是它请求的那个数字）。
  autoRefresh: Object.freeze({ request: z.object({ tabId: z.string(), intervalMs: z.number() }), response: z.object({ tabId: z.string(), autoRefreshMs: z.number() }) }),
  duplicate: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ tabId: z.string(), url: z.string() }) }),
  undoClose: Object.freeze({ request: z.unknown().optional(), response: z.object({ tabId: z.string(), url: z.string() }).nullable() }),
  stats: Object.freeze({ request: z.unknown().optional(), response: z.object({ total: z.number(), pinned: z.number(), audio: z.number() }) }),
  visibleAfter: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.array(z.string()) }),
  sleep: Object.freeze({ request: z.object({ tabId: z.string() }), response: z.object({ tabId: z.string(), sleeping: z.boolean() }) }),
  // 归档单个标签（J9）：与自动归档走同一条引擎（tabLifecycle.archiveTab）。
  archive: Object.freeze({
    request: z.object({ tabId: z.string() }),
    response: z.object({ tabId: z.string(), archived: z.boolean(), reason: z.string().optional() })
  }),
  omniboxAction: Object.freeze({
    request: z.object({ action: z.string() }),
    response: z.object({ ok: z.boolean(), reason: z.string().optional() })
  }),
  // typed=true：地址栏手动提交（影响历史的 typedCount，不改变导航语义）。
  navGo: Object.freeze({ request: z.object({ url: z.string(), tabId: z.string().optional(), typed: z.boolean().optional() }), response: z.object({ tabId: z.string(), url: z.string() }) }),
  navBack: Object.freeze({ request: z.object({ tabId: z.string().optional() }).optional(), response: z.object({ ok: z.boolean() }) }),
  navForward: Object.freeze({ request: z.object({ tabId: z.string().optional() }).optional(), response: z.object({ ok: z.boolean() }) }),
  // 导航历史条目（右键前进/后退菜单）：entries 的 index 即 navigationHistory 下标，
  // 菜单点击后原样回传给 navGoToEntry。
  navEntries: Object.freeze({
    request: z.object({ tabId: z.string().optional() }).optional(),
    response: z.object({
      entries: z.array(z.object({ index: z.number(), url: z.string(), title: z.string() })),
      activeIndex: z.number(),
      canGoBack: z.boolean(),
      canGoForward: z.boolean()
    })
  }),
  navGoToEntry: Object.freeze({
    request: z.object({ tabId: z.string().optional(), index: z.number().int().min(0) }),
    response: z.object({ ok: z.boolean() })
  }),
  navReload: Object.freeze({ request: z.object({ tabId: z.string().optional() }).optional(), response: z.object({ ok: z.boolean() }) }),
  // 中止加载（刷新按钮的「加载中」形态）。与 navBack / navForward / navReload 同形状。
  navStop: Object.freeze({ request: z.object({ tabId: z.string().optional() }).optional(), response: z.object({ ok: z.boolean() }) }),
  // 已关闭标签列表（对齐 RT recently-closed）：纯内存栈，重启即清空 ——
  // 因此契约里不含任何「持久化」语义，只有「列出 / 清空」两件事。
  recentlyClosed: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      tabs: z.array(
        z.object({
          url: z.string(),
          title: z.string(),
          favicon: z.string().nullable(),
          pinned: z.boolean(),
          /** 关闭时所处的原始位置，用于 Ctrl+Shift+T 还原到原位 */
          index: z.number(),
          stackId: z.string().nullable(),
          closedAt: z.number()
        })
      )
    })
  }),
  recentlyClosedClear: Object.freeze({ request: z.unknown().optional(), response: z.object({ cleared: z.number() }) }),
  // 恢复「最近关闭」列表里的指定一项。index 口径与 recentlyClosed 的返回顺序一致
  // （0 = 最近关闭的第一个）；越界时 ok:false（不抛错，UI 只需重拉列表）。
  recentlyClosedRestore: Object.freeze({
    request: z.object({ index: z.number().int().min(0) }),
    response: z.object({ ok: z.boolean(), tabId: z.string().optional(), url: z.string().optional() })
  })
})

export { tabsSchemas }

