/**
 * IPC · History 域 —— 自 ipc-routes.js 原样搬入（Step 5，语义零改动）。
 */

import { createProviderInvoker } from './provider-bridge'
import type { ProviderRegistryPort } from './provider-bridge'
import { createSlotCaller, type SlotCaller } from '../slot-call'
import { errorMessage } from './types'
import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'

type MethodPort = Record<string, (...args: unknown[]) => unknown>
interface PageTextInput { url: string; text: string; [key: string]: unknown }
interface HistoryIpcContext {
  routes: IpcRoutes
  schemas: IpcSchemas['history']
  historyService: MethodPort
  providerRegistry?: ProviderRegistryPort | null
  slots?: SlotCaller
}

export function registerHistoryIpc(
  typedMain: IpcTypedMain,
  { routes, schemas, historyService, providerRegistry, slots }: HistoryIpcContext
): void {
  if (!historyService) return

  const invoke = createProviderInvoker(providerRegistry)
  // 缺省 = 没有调度器（本注册器可被单独使用，既有单测就是如此）
  const slotCall = slots || createSlotCaller(null, { label: 'history-ipc' })

  typedMain.handle(routes.historyList, {
    requestSchema: schemas.list.request,
    responseSchema: schemas.list.response,
    handler: async (_e, req) => invoke('history.listRecent', () => historyService.listRecent(req?.limit ?? 100), req)
  })

  typedMain.handle(routes.historySearch, {
    requestSchema: schemas.search.request,
    responseSchema: schemas.search.response,
    handler: async (_e, req) => {
      const rows = await invoke('history.search', () => historyService.search(req.query, req.limit), req)
      /**
       * `history.search-filter`（REDUCE）—— 插件串行过滤 / 重排历史结果。
       *
       * 调用签名 `impl(acc, payload, ctx)`：`acc`/`payload` 都是那串历史行
       * （未声明 `initialValue` → 流水线初值 = payload），所以实现写
       * `(rows) => rows.filter(...)` 即可；没有插件参与时原样返回那一串。
       * `{ query, limit }` 走**第三参 `ctx`** —— 过滤规则常常依赖"用户搜的是什么"。
       */
      return slotCall.reduce('history.search-filter', rows, { query: req.query, limit: req.limit })
    }
  })

  typedMain.handle(routes.historyQueryRange, {
    requestSchema: schemas.queryRange.request,
    responseSchema: schemas.queryRange.response,
    handler: async (_e, req) => invoke('history.queryRange', () => historyService.queryRange(req.from, req.to, req.limit), req)
  })

  typedMain.handle(routes.historyRemove, {
    requestSchema: schemas.remove.request,
    responseSchema: schemas.remove.response,
    handler: async (_e, req) => ({ ok: await invoke('history.remove', () => historyService.remove(req.id), req) })
  })

  typedMain.handle(routes.historyRemoveMany, {
    requestSchema: schemas.removeMany.request,
    responseSchema: schemas.removeMany.response,
    handler: async (_e, req) => ({ removed: await invoke('history.removeMany', () => historyService.removeMany(req.ids), req) })
  })

  typedMain.handle(routes.historyRemoveBefore, {
    requestSchema: schemas.removeBefore.request,
    responseSchema: schemas.removeBefore.response,
    handler: async (_e, req) => ({ removed: await invoke('history.removeBefore', () => historyService.removeBefore(req.before), req) })
  })

  typedMain.handle(routes.historyClear, {
    requestSchema: schemas.clear.request,
    responseSchema: schemas.clear.response,
    handler: async () => ({ cleared: await invoke('history.clearAll', () => historyService.clearAll(), null) })
  })

  // E1 双表：逐次访问日志（游标分页）—— 只读。
  typedMain.handle(routes.historyVisits, {
    requestSchema: schemas.visits.request,
    responseSchema: schemas.visits.response,
    handler: async (_e, req) => invoke('history.listVisits', () => historyService.listVisits(req || {}), req || null)
  })

  /**
   * E3 正文索引写入：tab preload 抽取到的正文上报。
   *
   * **刻意不走 `invoke()`（provider 能力）**：这不是"可被插件替换的业务查询"，
   * 而是**页面引擎的一次事实上报**（和 `listeners:add` 同类）—— 没有"换个实现"的语义，
   * 也没有插件该冒充它。写失败返回 `{ ok: false }`，不抛（页面侧不必处理异常）。
   *
   * ── 为什么**延迟合批**而不是当场写 ──────────────────────────────────
   * 正文快照是一条 up-to-200KB 的 upsert + FTS5 倒排写入，而 better-sqlite3 是
   * **同步**的 —— 它会在主进程里连续占住几毫秒到几十毫秒。它又恰好发生在页面
   * `load` 之后（`requestIdleCallback` 报上来），正是用户开始滚动、视频正在播放的那一拍；
   * 主进程一卡，**所有** WebContentsView 的合成与输入都会被拖住。
   *
   * 现在：先入队并立刻回执（页面侧本来就是 fire-and-forget），`PAGE_TEXT_FLUSH_MS`
   * 之后攒成**一次事务**写（见 domain-history#savePageTexts）。同 URL 后者覆盖前者；
   * 队列按条数与总字数两道上限兜底，防止一次性涌入时占用无界内存。
   */
  const pendingPageTexts = new Map<string, PageTextInput>()
  let pendingPageTextChars = 0
  let pageTextFlushTimer: NodeJS.Timeout | null = null
  /** 合批窗口：足够把"同一波页面加载"收进一次事务，又短到索引几乎无感延迟。 */
  const PAGE_TEXT_FLUSH_MS = 400
  /** 单批上限（条数 / 总字数）：超了立刻落一次，避免队列无界增长。 */
  const PAGE_TEXT_BATCH_MAX = 32
  const PAGE_TEXT_CHARS_MAX = 1_500_000

  function flushPageTexts() {
    if (pageTextFlushTimer) {
      clearTimeout(pageTextFlushTimer)
      pageTextFlushTimer = null
    }
    if (pendingPageTexts.size === 0) return 0
    const batch = Array.from(pendingPageTexts.values())
    pendingPageTexts.clear()
    pendingPageTextChars = 0
    try {
      if (typeof historyService.savePageTexts === 'function') {
        return historyService.savePageTexts(batch)
      }
      // 兼容只实现了单条写法的历史服务（旧注入 / 单测替身）。
      let n = 0
      for (const item of batch) if (historyService.savePageText(item)) n++
      return n
    } catch (e) {
      console.warn('[history] flush page texts failed:', errorMessage(e))
      return 0
    }
  }

  function enqueuePageText(req: PageTextInput | null | undefined): void {
    if (!req || !req.url || !req.text) return
    const key = String(req.url)
    const prev = pendingPageTexts.get(key)
    if (prev) pendingPageTextChars -= String(prev.text || '').length
    pendingPageTexts.set(key, req)
    pendingPageTextChars += String(req.text).length
    // 涌入保护：条数或总字数超限 → 立刻落一批（不等 400ms）
    if (pendingPageTexts.size >= PAGE_TEXT_BATCH_MAX || pendingPageTextChars >= PAGE_TEXT_CHARS_MAX) {
      flushPageTexts()
      return
    }
    if (pageTextFlushTimer) return
    pageTextFlushTimer = setTimeout(() => {
      pageTextFlushTimer = null
      flushPageTexts()
    }, PAGE_TEXT_FLUSH_MS)
    // 这个定时器不该成为"进程退不掉"的最后一个抓手。
    if (typeof pageTextFlushTimer.unref === 'function') pageTextFlushTimer.unref()
  }

  typedMain.handle(routes.pageTextCaptured, {
    requestSchema: schemas.pageTextCaptured.request,
    responseSchema: schemas.pageTextCaptured.response,
    // 回执只表示"已收下"：真正的落库在合批窗口之后（页面侧不等这个结果）。
    handler: async (_e, req) => {
      try {
        enqueuePageText(req)
        return { ok: true }
      } catch (_) {
        return { ok: false }
      }
    }
  })
}

