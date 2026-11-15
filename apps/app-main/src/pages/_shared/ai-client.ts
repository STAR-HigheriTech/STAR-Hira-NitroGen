/**
 * AI 设置 · 内部页数据入口（`hira://aisettings`）。
 *
 * 与渲染层的 `renderer/shared/ai-client.js` 是**同一份契约、两种宿主**：
 *   · 面板跑在打包后的渲染层里，能直接 import `renderer/shared`；
 *   · 内部页是「原样拷贝、不打包」的静态页，只能经 `hira://shared/*` 拿公共模块。
 * 所以这里只重复「路由 → invoke」这一层薄映射 —— 判定（谁能用、能不能改）一律不落在这里，
 * 真源仍是 `infra-ipc/src/contracts/ai.js` 与引擎实现。
 *
 * **技能不在这里**：它已经插件化，管理界面在 `hira://plugins` 的「AI 技能」大类，
 * 客户端由 `pages/plugins/plugins.js` 自带（同一批路由，多一个 `setEnabled`）。
 *
 * ⚠ 引擎是第一方插件：`ai-engine` 被禁用时这些通道**当场不存在**，调用一律 reject。
 * 页面按「不可用」处理（见 `pages/ai/ai.js` 的 boot），不要把 reject 当成普通操作失败。
 */
import { IPC_EVENTS, IPC_ROUTES, rpc, subscribe } from './runtime.js'

export interface AiActionResponse {
  ok?: boolean
  code?: string
  message?: string
}

export interface AiProviderModelRecord {
  id: string
  label?: string
  reasoning?: string
}

export interface AiProviderRecord {
  id: string
  label?: string
  protocol?: string
  baseUrl?: string
  enabled?: boolean
  hasKey?: boolean
  models?: AiProviderModelRecord[]
}

export interface AiProviderListResponse extends AiActionResponse {
  providers?: AiProviderRecord[]
}

export interface AiProviderTestResponse extends AiActionResponse {
  imported?: number
  models?: unknown[]
}

export interface AiProviderSaveResponse extends AiActionResponse {
  provider?: AiProviderRecord
}

export interface AiSessionSummary {
  id: string
  title?: string
}

export interface AiSessionListResponse {
  sessions?: AiSessionSummary[]
}

export interface AiSharedState {
  sessionId?: string | null
  modelChoice?: string | null
  reasoning?: string
  approvalMode?: string
}

export interface AiUiStateResponse {
  uiState?: AiSharedState
}

export interface AiUsageTotals {
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  turns?: number
  costUsd?: number
}

export interface AiUsageItem {
  sessionId?: string
  modelId?: string
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}

export interface AiUsageResponse extends AiActionResponse {
  totals?: AiUsageTotals
  items?: AiUsageItem[]
}

export interface AiStateChangedPayload {
  reason?: string
}

export interface AiUiStateChangedPayload {
  uiState?: AiSharedState
}

export interface AiProviderSavePayload {
  id: string
  label: string
  protocol: string
  baseUrl: string
  enabled?: boolean
  apiKey?: string
}

function invoke<T>(route: string, payload?: unknown): Promise<T> {
  return rpc<T>(route, payload)
}

export const aiClient = {
  /**
   * 跨宿主共享的界面状态（侧栏面板 / 独立窗口 / 内部页**同一份**）。
   * 本页只读展示：会话 / 模型 / 推理档位 / 审批模式。
   */
  uiState: {
    get(): Promise<AiUiStateResponse> {
      return invoke<AiUiStateResponse>(IPC_ROUTES.aiUiState, {})
    },
    set(patch: AiSharedState = {}): Promise<AiActionResponse> {
      return invoke<AiActionResponse>(IPC_ROUTES.aiUiStateSet, patch)
    }
  },

  /** 会话列表（只用于把共享状态里的 sessionId 翻译成标题）。 */
  sessions: {
    list(opts: Record<string, unknown> = {}): Promise<AiSessionListResponse> {
      return invoke<AiSessionListResponse>(IPC_ROUTES.aiSessionList, opts)
    }
  },

  providers: {
    list(): Promise<AiProviderListResponse> {
      return invoke<AiProviderListResponse>(IPC_ROUTES.aiProviderList, {})
    },
    save(payload: AiProviderSavePayload): Promise<AiProviderSaveResponse> {
      return invoke<AiProviderSaveResponse>(IPC_ROUTES.aiProviderSave, payload)
    },
    remove(id: string): Promise<AiActionResponse> {
      return invoke<AiActionResponse>(IPC_ROUTES.aiProviderRemove, { id })
    },
    test(id: string, model?: string): Promise<AiProviderTestResponse> {
      return invoke<AiProviderTestResponse>(IPC_ROUTES.aiProviderTest, model ? { id, model } : { id })
    },
    upsertModel(providerId: string, model: AiProviderModelRecord): Promise<AiActionResponse> {
      return invoke<AiActionResponse>(IPC_ROUTES.aiModelUpsert, { providerId, model })
    },
    removeModel(providerId: string, modelId: string): Promise<AiActionResponse> {
      return invoke<AiActionResponse>(IPC_ROUTES.aiModelRemove, { providerId, modelId })
    }
  },

  usage(range: Record<string, unknown> = {}): Promise<AiUsageResponse> {
    return invoke<AiUsageResponse>(IPC_ROUTES.aiUsage, range)
  },

  /** 审计日志导出（csv / json）。走系统「另存为」。 */
  auditExport(format?: string, limit?: number): Promise<AiActionResponse> {
    return invoke<AiActionResponse>(IPC_ROUTES.aiAuditExport, {
      ...(format ? { format } : {}),
      ...(limit ? { limit } : {})
    })
  },

  /** 彻底移除（清空全部 AI 数据）。必须显式 `{ confirm: true }`。 */
  purge(): Promise<AiActionResponse> {
    return invoke<AiActionResponse>(IPC_ROUTES.aiPurge, { confirm: true })
  },

  /**
   * 引擎广播（模型服务 / 技能 / 会话 / 清空…）。面板与本页共用同一条事件，
   * 于是「面板里改了一个模型服务，设置页里的卡片立刻跟着变」不需要任何轮询。
   */
  onStateChanged(fn: (payload: AiStateChangedPayload) => void): () => void {
    return subscribe(IPC_EVENTS.aiStateChanged, fn)
  },

  /** 跨宿主共享状态变化（任一宿主改了会话 / 模型 / 档位 / 审批）。 */
  onUiStateChanged(fn: (payload: AiUiStateChangedPayload) => void): () => void {
    return subscribe(IPC_EVENTS.aiUiStateChanged, fn)
  }
}
