/**
 * ai-client.js —— AI 助手面板的**渲染侧端口**（薄封装，零业务）。
 *
 * 与其它 `*-client.js` 同一条分工：这里只有"路由常量 → invoke"的映射，
 * 一切判定（谁能用、该不该发、发什么）都在主进程的引擎里。理由有两条：
 *   · 契约的唯一事实源是 `infra-ipc/src/contracts/ai.js`，渲染层复制一份规则必然漂移；
 *   · 引擎住在第一方插件里，禁用即撤销注册 —— 渲染层不该缓存任何"AI 一定有"的假设。
 *     所有调用都可能 reject（通道不存在），调用方按「不可用」处理即可。
 *
 * ⚠ **不要**在这里 import 任何 UI：面板包通过 `ctx.clients.ai` 拿到本对象
 * （见 `shared/panel-context.js`），ui 包对 apps 层保持零依赖（CONTRACT-11）。
 */

import { IPC_EVENTS, IPC_ROUTES } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

/** 订阅一条主进程事件；返回订阅句柄（桥的实现原样透传，通常是取消函数）。 */
function subscribe<T extends JsonRecord = JsonRecord>(route: string, handler: (payload: T) => void): () => void {
  return getHiraBridge().on.subscribe<T>(route, handler)
}

export const aiClient = {
  /**
   * 打开面板 / 窗口 / 内部页时的**唯一快照**：会话、消息、模型、待决意图、进行中的回合。
   * `host` 决定读哪一格"当前会话"（侧栏 / 窗口 / 内部页各自记忆，见 main/ui-state.cjs）。
   * `consumePending` 只由面板挂载那一次传 true —— 待补发的右键意图是一次性的。
   * @param {{ host?: 'panel'|'window'|'page', sessionId?: string, consumePending?: boolean }} [opts]
   */
  state(opts?: JsonRecord) {
    return invoke(IPC_ROUTES.aiState, opts || {})
  },

  /**
   * 跨宿主共享的界面状态（侧栏面板 / 独立窗口 / 内部页**同一份**）。
   *
   * 谁改谁报：本地先乐观更新，再 `set(patch)` 上报；主进程落库后广播，
   * 其余宿主收到 `onUiStateChanged` 各自对齐 —— 不存在"每处一套设置"。
   */
  uiState: {
    get() {
      return invoke(IPC_ROUTES.aiUiState, {})
    },
    set(patch: JsonRecord) {
      return invoke(IPC_ROUTES.aiUiStateSet, patch || {})
    }
  },

  sessions: {
    list(opts?: JsonRecord) {
      return invoke(IPC_ROUTES.aiSessionList, opts || {})
    },
    /** 新建会话；`host` = 哪个宿主把它设为当前会话（其它宿主保持原对话）。 */
    create(title?: string, host?: 'panel' | 'window' | 'page') {
      return invoke(IPC_ROUTES.aiSessionCreate, {
        ...(title ? { title } : {}),
        ...(host ? { host } : {})
      })
    },
    rename(sessionId: string, title: string) {
      return invoke(IPC_ROUTES.aiSessionRename, { sessionId: String(sessionId), title: String(title) })
    },
    remove(sessionId: string) {
      return invoke(IPC_ROUTES.aiSessionDelete, { sessionId: String(sessionId) })
    },
    /** 全文检索（FTS 命中不足时引擎自己退回 LIKE，中文可用）。 */
    search(query: string, limit?: number) {
      return invoke(IPC_ROUTES.aiSessionSearch, {
        query: String(query),
        ...(limit ? { limit } : {})
      })
    },
    /** 导出会话（md / json）。弹主进程的保存框；用户取消回 `AI_EXPORT_CANCELED`。 */
    export(sessionId: string, format?: 'md' | 'json') {
      return invoke(IPC_ROUTES.aiSessionExport, {
        sessionId: String(sessionId),
        ...(format ? { format } : {})
      })
    },
    /** 审计导出（csv / json）。 */
    exportAudit(format?: 'csv' | 'json', limit?: number) {
      return invoke(IPC_ROUTES.aiAuditExport, {
        ...(format ? { format } : {}),
        ...(limit ? { limit } : {})
      })
    }
  },

  /**
   * 事件日志的**投影**（分页读）。
   * `after` 是已读到的 seq —— 增量优先，不整段搬（§17 第二条红线）。
   */
  messages(sessionId: string, opts?: JsonRecord) {
    return invoke(IPC_ROUTES.aiSessionMessages, {
      sessionId: String(sessionId),
      ...(opts || {})
    })
  },

  /** 开始一个回合（text 与 blocks 至少一个）。 */
  send(payload: JsonRecord) {
    return invoke(IPC_ROUTES.aiSend, payload)
  },

  /** 回合进行中追加一句（不新开回合）。 */
  steer(payload: JsonRecord) {
    return invoke(IPC_ROUTES.aiSteer, payload)
  },

  /** 重试 / 重生成（复用最后一条用户消息，旧输出由投影层丢弃）。 */
  retry(payload: JsonRecord) {
    return invoke(IPC_ROUTES.aiRetry, payload)
  },

  /** 中止当前回合（已流出的内容保留，settlement 由引擎负责）。 */
  stop(sessionId: string) {
    return invoke(IPC_ROUTES.aiStop, { sessionId: String(sessionId) })
  },

  /** 审批卡的裁决回传。 */
  approval(payload: JsonRecord) {
    return invoke(IPC_ROUTES.aiApproval, payload)
  },

  /** 右键菜单意图（面板未开时主进程先存 pending，挂载后补发）。 */
  invokeIntent(intent: string, payload?: unknown, sessionId?: string) {
    return invoke(IPC_ROUTES.aiIntentInvoke, {
      intent: String(intent),
      ...(payload === undefined ? {} : { payload }),
      ...(sessionId ? { sessionId: String(sessionId) } : {})
    })
  },

  /** 显式采集一项上下文（`@` 面板 / 截图按钮 / 拖入文件）。 */
  capture(kind: string, payload?: unknown) {
    return invoke(IPC_ROUTES.aiContextCapture, {
      kind: String(kind),
      ...(payload === undefined ? {} : { payload })
    })
  },

  /**
   * `@` 面板的来源候选（打开的标签 / 已关闭 / 书签 / 历史）。
   * 只取一屏的量；面板里的打字过滤在本地做（见 ui/composer.js）。
   */
  candidates(kind: string, query?: string, limit?: number) {
    return invoke(IPC_ROUTES.aiContextCandidates, {
      kind: String(kind),
      ...(query ? { query: String(query) } : {}),
      ...(limit ? { limit } : {})
    })
  },

  /** 引用回跳：已开就切标签，没开就新标签打开。 */
  reveal(url: string) {
    return invoke(IPC_ROUTES.aiContextReveal, { url: String(url) })
  },

  providers: {
    list() {
      return invoke(IPC_ROUTES.aiProviderList, {})
    },
    save(payload: JsonRecord) {
      return invoke(IPC_ROUTES.aiProviderSave, payload)
    },
    remove(id: string) {
      return invoke(IPC_ROUTES.aiProviderRemove, { id: String(id) })
    },
    test(id: string, model?: string) {
      return invoke(IPC_ROUTES.aiProviderTest, model ? { id: String(id), model } : { id: String(id) })
    },
    upsertModel(providerId: string, model: JsonRecord) {
      return invoke(IPC_ROUTES.aiModelUpsert, { providerId: String(providerId), model })
    },
    removeModel(providerId: string, modelId: string) {
      return invoke(IPC_ROUTES.aiModelRemove, { providerId: String(providerId), modelId: String(modelId) })
    }
  },

  skills: {
    list() {
      return invoke(IPC_ROUTES.aiSkillList, {})
    },
    save(payload: JsonRecord) {
      return invoke(IPC_ROUTES.aiSkillSave, payload)
    },
    remove(id: string) {
      return invoke(IPC_ROUTES.aiSkillRemove, { id: String(id) })
    },
    /** 单条启停（插件贡献的技能也可关，状态落本地库）。 */
    setEnabled(id: string, enabled: boolean) {
      return invoke(IPC_ROUTES.aiSkillSetEnabled, { id: String(id), enabled: enabled === true })
    },
    /** 导出为 `.hira-ai-skill.json`（`ids` 省略 = 全部自定义技能）。 */
    exportFile(ids?: readonly string[]) {
      return invoke(IPC_ROUTES.aiSkillExport, Array.isArray(ids) ? { ids: ids.map(String) } : {})
    },
    importFile() {
      return invoke(IPC_ROUTES.aiSkillImport, {})
    },
    /** 运行一条技能：`{ id }` 或 `{ draft }`；`args` 填模板参数。 */
    run(payload?: JsonRecord) {
      return invoke(IPC_ROUTES.aiSkillRun, payload || {})
    }
  },

  usage(range?: JsonRecord) {
    return invoke(IPC_ROUTES.aiUsage, range || {})
  },

  /** 彻底移除（清空全部 AI 数据）。必须显式 `{ confirm: true }`。 */
  purge() {
    return invoke(IPC_ROUTES.aiPurge, { confirm: true })
  },

  // ── 事件订阅 ─────────────────────────────────────────────────────
  // 面板是**冷进程**：挂载后自己拉一次 `state()`，随后只吃增量。
  onStateChanged(fn: (payload: JsonRecord) => void) {
    return subscribe(IPC_EVENTS.aiStateChanged, fn)
  },
  /** 共享界面状态变更 `{ uiState: { sessionId, modelChoice, reasoning, approvalMode } }`。 */
  onUiStateChanged(fn: (payload: JsonRecord) => void) {
    return subscribe(IPC_EVENTS.aiUiStateChanged, fn)
  },
  /** 流式帧 `{ sessionId, turnId, frame: 'start'|'chunk'|'end', … }`。 */
  onStream(fn: (payload: JsonRecord) => void) {
    return subscribe(IPC_EVENTS.aiStream, fn)
  },
  /** 右键菜单意图（面板已开时的实时投递）。 */
  onIntent(fn: (payload: JsonRecord) => void) {
    return subscribe(IPC_EVENTS.aiIntent, fn)
  },
  onApprovalRequest(fn: (payload: JsonRecord) => void) {
    return subscribe(IPC_EVENTS.aiApprovalRequest, fn)
  },
  onUsageTick(fn: (payload: JsonRecord) => void) {
    return subscribe(IPC_EVENTS.aiUsageTick, fn)
  }
}


