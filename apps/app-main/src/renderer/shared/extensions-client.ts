import { IPC_ROUTES, IPC_EVENTS } from '@hira-ng/shared-types/src/ipc-channels.mjs'
import { getHiraBridge, type JsonRecord } from './bridge.js'

const listeners = new Set<(payload: JsonRecord) => void>()
let bridgeSubscription: (() => void) | null = null

function ensureBridgeSubscription() {
  if (bridgeSubscription) return
  bridgeSubscription = getHiraBridge().on.subscribe<JsonRecord>(IPC_EVENTS.extensionChanged, (payload) => {
    for (const listener of listeners) {
      try { listener(payload) } catch (error) { console.error('[extensions-client] listener error', error) }
    }
  })
}

// 扩展域客户端 —— 与 tabs-client / bookmarks-client 同构：
// invoke 全走 IPC_ROUTES 枚举，不留裸字符串通道。
// 列表返回项已由 main 侧拼入 buildExtensionMeta 展示字段
// （permissionNames/permissions/isV3/manifestVersion/...），渲染端零 N+1 直接消费。

function invoke<T extends JsonRecord = JsonRecord>(route: string, arg?: unknown): Promise<T> {
  return getHiraBridge().provider.invoke<T>(route, arg)
}

export const extensionsClient = {
  /**
   * 扩展列表（已带本地化名称 / 中文权限 / 来源 / 商店地址等展示字段）。
   *
   * `opts.includeSize` 是**按需**入口：传 `[id]` 才会为这些扩展算目录大小并把
   * `size`（可读文本，如 `1.2 MB`）写进对应列表项 —— 目录大小是磁盘递归操作，
   * 不随每次刷新下发。走既有 `extension:list` 通道，没有新增 IPC 通道。
   */
  list(opts?: JsonRecord) {
    return invoke(IPC_ROUTES.extensionList, opts)
  },
  install(path: string) {
    return invoke(IPC_ROUTES.extensionInstall, { path })
  },
  uninstall(id: string) {
    return invoke(IPC_ROUTES.extensionUninstall, { id })
  },
  toggle(id: string, enabled: boolean) {
    return invoke(IPC_ROUTES.extensionToggle, { id, enabled })
  },
  /**
   * 固定 / 取消固定扩展 → `{ ok }`
   *
   * 纯用户意图（持久化在安装记录里、随 profile 隔离），**不改变启停状态**：
   * 停用 / 加载失败的扩展同样可以固定。列表项的 `pinned` 由主进程下发。
   */
  setPinned(id: string, pinned: boolean) {
    return invoke(IPC_ROUTES.extensionSetPinned, { id, pinned })
  },
  importFolder() {
    return invoke(IPC_ROUTES.extensionImportFolder)
  },
  adblockerStatus() {
    return invoke(IPC_ROUTES.adblockerStatus)
  },
  adblockerToggle(enabled: boolean) {
    return invoke(IPC_ROUTES.adblockerToggle, { enabled })
  },
  adblockerBlockedCount() {
    return invoke(IPC_ROUTES.adblockerBlockedCount)
  },
  runtimeStatus(id: string) {
    return invoke(IPC_ROUTES.extensionRuntimeStatus, { id })
  },
  reload(id: string) {
    return invoke(IPC_ROUTES.extensionReload, { id })
  },
  diagnostics(id: string) {
    return invoke(IPC_ROUTES.extensionDiagnostics, { id })
  },
  warnings(id: string) {
    return invoke(IPC_ROUTES.extensionWarnings, { id })
  },
  /** 打开扩展自己的选项页（新标签页承载）→ `{ ok }` */
  openOptions(id: string) {
    return invoke(IPC_ROUTES.extensionOpenOptions, { id })
  },
  /**
   * 打开扩展的弹出窗口（popup）→ `{ ok }`
   *
   * `opts.anchorRect` 是**被点按钮在渲染层自己视图内**的矩形（调用方用
   * getBoundingClientRect() 现算，对齐 RT 的 browserActionProvider）。整窗页面报的
   * 就是窗口内容区坐标；面板 / 浮层是独立 WebContentsView，报的是视图内坐标 ——
   * 由主进程按发送方视图补上偏移（渲染层不需要、也不该知道偏移量）。传了它，
   * 弹窗才会锚到按钮下方；不传则退到窗口右上角。
   * `opts.alignment` 语义与 ECE 一致：含 'top' 向上展开，含 'right' 向右展开。
   */
  openPopup(id: string, opts?: { anchorRect?: unknown; alignment?: unknown }) {
    const payload: Record<string, unknown> = { id }
    if (opts && opts.anchorRect) payload.anchorRect = opts.anchorRect
    if (opts && opts.alignment) payload.alignment = opts.alignment
    return invoke(IPC_ROUTES.extensionOpenPopup, payload)
  },
  /** 在标签页里打开该扩展的商店详情页（清单 homepage_url 优先）→ `{ ok }` */
  openStore(id: string) {
    return invoke(IPC_ROUTES.extensionOpenStore, { id })
  },
  /**
   * 打开扩展后台上下文的开发者工具（「检查视图」）→ `{ ok }`
   *
   * `target` 直接取自列表项 `inspectViews[].target`（**不要在前端自己拼**）：
   * 该字段由主进程产出，也就意味着「哪些 target 真的能调试」只有主进程说了算。
   * 目前仅 'background-page' 会返回 ok:true；'service-worker' 底层没有开发者工具入口，
   * 对应列表项自带 `inspectable:false`，UI 应当置灰、不调用本方法。
   */
  inspectView(id: string, target: string) {
    return invoke(IPC_ROUTES.extensionInspectView, { id, target })
  },
  /** 立即检查并安装所有扩展的可用更新（对齐 RT 开发者模式工具条的「更新」）→ `{ ok }` */
  updateAll() {
    return invoke(IPC_ROUTES.extensionUpdateAll)
  },
  onChanged(listener: (payload: JsonRecord) => void) {
    listeners.add(listener)
    ensureBridgeSubscription()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && bridgeSubscription) {
        bridgeSubscription()
        bridgeSubscription = null
      }
    }
  }
}

