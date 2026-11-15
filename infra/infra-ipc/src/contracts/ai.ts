import { z } from 'zod'

/**
 * AI 助手 IPC 契约（PART15 §4）。
 *
 * 与其它域的差别：**实现不在核心**，而在第一方插件 `ai-engine` 里（禁用即撤销注册）。
 * 契约仍然放在这里，理由不变 —— 它是「渲染层与主进程之间的形状」的唯一事实源，
 * 不该因为"说话的一方是插件"就散落到插件目录里（那样换个人读就找不到）。
 *
 * 校验策略：**请求形状严格、响应宽松**。
 *   · 请求是本项目自己发的，形状必须钉死（少一个字段就当场炸，而不是到插件里才炸）；
 *   · 响应里带大量业务字段（消息块 / 工具卡 / 模型清单），逐字段声明只会造成
 *     "每加一个字段回来改契约"的摩擦 —— 那是另一种屎山。用 `passthrough()` 放行。
 */
const loose = z.object({}).passthrough()

/** 内容块：文本 / 图片引用 / 工具调用 / 工具结果（PART15 §4 AiContentBlock）。 */
const contentBlock = z.object({
  type: z.enum(['text', 'image', 'tool-call', 'tool-result']),
  text: z.string().optional(),
  ref: z.string().optional(),
  mime: z.string().optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional()
}).passthrough()

/** 上下文项（@ 引用 / 右键意图 / 截图 / 拖入）。 */
const contextItem = z.object({
  kind: z.enum(['page', 'selection', 'screenshot', 'workspace', 'bookmark', 'history', 'note', 'file', 'text', 'tab', 'closed-tab']),
  // 采集到的内容（页面快照 / 选区文本 / 文件路径…）。可以后到（provider 异步采集）。
  payload: z.unknown().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  favicon: z.string().optional(),
  // 显式标记"这是不可信内容"，渲染进提示词时会被 UNTRUSTED 包裹。
  untrusted: z.boolean().optional()
}).passthrough()

const aiSchemas = Object.freeze({
  /**
   * 打开面板 / 窗口 / 内部页时的**唯一快照**：会话、模型、待决意图、进行中的回合。
   *
   * `host` 决定读哪一格"当前会话"：侧栏 / 独立窗口 / 内部页各自记忆（见
   * `plugins/ai/main/ui-state.cjs#sessionIdByHost`），因此三者可以同时停在不同对话上。
   * `sessionId` 用于换宿主时**继承**来源宿主的会话（拆窗 / 停靠），避免落在旧对话上。
   */
  state: Object.freeze({
    request: z.object({
      sessionId: z.string().optional(),
      host: z.enum(['panel', 'window', 'page']).optional()
    }).passthrough(),
    response: loose
  }),

  sessionList: Object.freeze({
    request: z.object({ cursor: z.number().optional(), limit: z.number().int().min(1).max(200).optional() }).passthrough(),
    response: loose
  }),

  /**
   * 跨宿主界面状态（侧栏面板 / 独立窗口 / 内部页）。
   *
   * 一条 schema 同时服务「读」与「写」：读发 `{}`，写发要改的字段（其余原样）。
   * **会话按 `host` 分槽**（`panel|window|page` 各记各的）；不带 host 的 `sessionId`
   * 只用于旧调用方 / 兜底。模型 / 推理 / 审批三宿主共用一份；`null` = 还没有。
   */
  uiState: Object.freeze({
    request: z.object({
      host: z.enum(['panel', 'window', 'page']).optional(),
      sessionId: z.string().min(1).nullable().optional(),
      modelChoice: z.string().max(300).nullable().optional(),
      reasoning: z.enum(['auto', 'low', 'medium', 'high']).optional(),
      approvalMode: z.enum(['allow', 'ask']).optional()
    }).passthrough(),
    response: loose
  }),
  sessionCreate: Object.freeze({
    request: z.object({
      title: z.string().max(200).optional(),
      /** 哪个宿主把新会话设为当前（其它宿主保持原对话）。 */
      host: z.enum(['panel', 'window', 'page']).optional()
    }).passthrough(),
    response: loose
  }),
  sessionRename: Object.freeze({
    request: z.object({ sessionId: z.string().min(1), title: z.string().min(1).max(200) }),
    response: loose
  }),
  sessionDelete: Object.freeze({
    request: z.object({ sessionId: z.string().min(1) }),
    response: loose
  }),
  sessionMessages: Object.freeze({
    request: z.object({
      sessionId: z.string().min(1),
      // 事件日志分页：`after` 是**已读到的 seq**（增量优先，不整段搬）
      after: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional()
    }),
    response: loose
  }),

  send: Object.freeze({
    request: z.object({
      sessionId: z.string().min(1),
      /** 发起方宿主：在哪个宿主说话，就把该宿主的"当前会话"指向这条（其它宿主不动）。 */
      host: z.enum(['panel', 'window', 'page']).optional(),
      text: z.string().max(200000).optional(),
      blocks: z.array(contentBlock).max(200).optional(),
      context: z.array(contextItem).max(100).optional(),
      model: z.string().optional(),
      // 推理等级（`auto` = 交给服务端默认；其余三档才真正下发）
      reasoning: z.enum(['auto', 'low', 'medium', 'high']).optional(),
      // 网页内容审批模式：`allow` = 所有站点直接读，`ask` = 每站点首次前询问（默认）
      approvalMode: z.enum(['allow', 'ask']).optional()
    }).refine((v: { text?: string; blocks?: unknown[] }) => Boolean((v.text && v.text.length) || (v.blocks && v.blocks.length)), {
      message: 'text 与 blocks 至少要有一个'
    }),
    response: loose
  }),
  // 回合进行中追加一句（Tabbit 的"边跑边补"）：不新开回合，落进当前 turn 的事件日志。
  steer: Object.freeze({
    request: z.object({
      sessionId: z.string().min(1),
      text: z.string().max(200000).optional(),
      blocks: z.array(contentBlock).max(200).optional(),
      context: z.array(contextItem).max(100).optional(),
      approvalMode: z.enum(['allow', 'ask']).optional()
    }).refine((v: { text?: string; blocks?: unknown[] }) => Boolean((v.text && v.text.length) || (v.blocks && v.blocks.length)), {
      message: 'text 与 blocks 至少要有一个'
    }),
    response: loose
  }),
  // 重试 / 重生成：复用最后一条用户消息，新回合 + `assistant/attempt` 标记，
  // 投影层据此丢弃上一次尝试的输出（事件只追加，不删不改）。
  retry: Object.freeze({
    request: z.object({
      sessionId: z.string().min(1),
      host: z.enum(['panel', 'window', 'page']).optional(),
      model: z.string().optional(),
      reasoning: z.enum(['auto', 'low', 'medium', 'high']).optional(),
      approvalMode: z.enum(['allow', 'ask']).optional()
    }),
    response: loose
  }),
  sessionSearch: Object.freeze({
    request: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }),
    response: loose
  }),
  sessionExport: Object.freeze({
    request: z.object({ sessionId: z.string().min(1), format: z.enum(['md', 'json']).optional() }),
    response: loose
  }),
  auditExport: Object.freeze({
    request: z.object({ format: z.enum(['csv', 'json']).optional(), limit: z.number().int().min(1).max(5000).optional() }).passthrough(),
    response: loose
  }),
  stop: Object.freeze({
    request: z.object({ sessionId: z.string().min(1), reason: z.string().max(200).optional() }),
    response: loose
  }),
  approval: Object.freeze({
    request: z.object({
      sessionId: z.string().min(1),
      approvalId: z.string().min(1),
      decision: z.enum(['allow', 'deny']),
      remember: z.boolean().optional()
    }),
    response: loose
  }),

  intentInvoke: Object.freeze({
    request: z.object({
      intent: z.enum([
        'explain', 'translate', 'summarize',
        'ask-about-page', 'ask-about-selection',
        'add-page-to-context', 'add-selection-to-context', 'add-screenshot-to-context',
        // 模板类意图：不带上下文项，直接把一条技能提示词发出去（收藏页 / 面板空态卡用到）。
        'digest-bookmarks', 'deep-research'
      ]),
      payload: z.unknown().optional(),
      sessionId: z.string().optional(),
      windowId: z.number().optional()
    }).passthrough(),
    response: loose
  }),

  contextCapture: Object.freeze({
    request: z.object({
      kind: z.enum(['page', 'selection', 'screenshot', 'workspace', 'file', 'text', 'tab', 'closed-tab', 'bookmark', 'history']),
      payload: z.unknown().optional()
    }).passthrough(),
    response: loose
  }),

  /** `@` 面板的来源候选（打开的标签 / 已关闭 / 书签 / 历史）。 */
  contextCandidates: Object.freeze({
    request: z.object({
      kind: z.enum(['tab', 'closed-tab', 'bookmark', 'history']),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).optional()
    }).passthrough(),
    response: loose
  }),

  /** 把一条引用跳回原标签（已开就切过去，没开就新标签打开）。 */
  contextReveal: Object.freeze({
    request: z.object({ url: z.string().max(4000) }).passthrough(),
    response: loose
  }),

  providerList: Object.freeze({
    request: z.object({}).passthrough(),
    response: loose
  }),
  providerSave: Object.freeze({
    request: z.object({
      id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'provider id 只允许字母数字与 . _ -'),
      label: z.string().max(120).optional(),
      protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
      baseUrl: z.string().url(),
      apiKey: z.string().optional(),
      enabled: z.boolean().optional(),
      models: z.array(z.object({ id: z.string().min(1), label: z.string().optional() }).passthrough()).max(200).optional()
    }),
    response: loose
  }),
  providerRemove: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: loose
  }),
  providerTest: Object.freeze({
    request: z.object({ id: z.string().min(1), model: z.string().optional() }),
    response: loose
  }),
  modelUpsert: Object.freeze({
    request: z.object({
      providerId: z.string().min(1),
      model: z.object({
        id: z.string().min(1),
        label: z.string().optional(),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        reasoning: z.enum(['none', 'low', 'medium', 'high']).optional()
      }).passthrough()
    }),
    response: loose
  }),
  modelRemove: Object.freeze({
    request: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }),
    response: loose
  }),

  skillList: Object.freeze({
    request: z.object({}).passthrough(),
    response: loose
  }),
  skillSave: Object.freeze({
    request: z.object({
      id: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      icon: z.string().max(64).optional(),
      kind: z.string().max(64).optional(),
      prompt: z.string().max(20000).optional(),
      description: z.string().max(2000).optional()
    }).passthrough(),
    response: loose
  }),
  skillRemove: Object.freeze({
    request: z.object({ id: z.string().min(1) }),
    response: loose
  }),
  // 单条启停：插件贡献的技能不能改内容，但可以关掉（本地状态落 ai_skill_state）。
  skillSetEnabled: Object.freeze({
    request: z.object({ id: z.string().min(1), enabled: z.boolean() }),
    response: loose
  }),
  // 导出：`ids` 省略 = 导出全部可导出的（内置的不导出，导入时会撞 id）。
  // 走系统「另存为」对话框，返回 `{ ok, canceled? , path? }`。
  skillExport: Object.freeze({
    request: z.object({ ids: z.array(z.string().min(1)).max(200).optional() }).passthrough(),
    response: loose
  }),
  // 导入：无参数（走「打开文件」对话框），返回 `{ ok, imported, skills }`。
  skillImport: Object.freeze({
    request: z.object({}).passthrough(),
    response: loose
  }),
  // 运行：`id` 取已存的，`draft` 用于设置页「试运行」尚未保存的编辑。
  // 两者至少要有一个（`draft.prompt` 对脚本型就是脚本源码）。
  skillRun: Object.freeze({
    request: z.object({
      id: z.string().min(1).max(64).optional(),
      draft: z.object({
        id: z.string().max(64).optional(),
        kind: z.string().max(64).optional(),
        label: z.string().max(120).optional(),
        prompt: z.string().max(20000).optional()
      }).passthrough().optional(),
      args: z.record(z.string(), z.unknown()).optional()
    }).passthrough().refine((v: { id?: string; draft?: { prompt?: string } }) => Boolean(v.id || (v.draft && typeof v.draft.prompt === 'string')), {
      message: 'id 与 draft.prompt 至少要有一个'
    }),
    response: loose
  }),

  usage: Object.freeze({
    request: z.object({ from: z.number().optional(), to: z.number().optional(), sessionId: z.string().optional() }).passthrough(),
    response: loose
  }),
  purge: Object.freeze({
    request: z.object({ confirm: z.literal(true) }),
    response: loose
  })
})

export { aiSchemas }

