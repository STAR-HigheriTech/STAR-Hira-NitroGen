import { z } from 'zod'

/**
 * BrowsingData 契约 —— 「立即清除浏览数据」。
 *
 * 与设置项 `privacy.clear_*_on_exit` 的分工：
 *   - 设置项 = 退出时自动清理（声明式，长期策略）
 *   - 本契约 = 用户点一下立刻清理（命令式，一次性动作）
 * 两者共享同一组类型名，避免界面上出现两套词汇。
 */
const BROWSING_DATA_TYPES = [
  'history',
  'downloads',
  'cache',
  'cookies',
  'siteData',
  'localStorage',
  'indexedDB',
  'serviceWorkers',
  'cacheStorage'
]

const browsingDataSchemas = Object.freeze({
  clear: Object.freeze({
    request: z.object({
      types: z.array(z.enum(BROWSING_DATA_TYPES)).min(1),
      /**
       * 「只清最近 N」的下界（毫秒时间戳）：只清除 **at/after** 该时刻产生的
       * history / downloads 记录；storage 类（cookie/缓存/站点数据）无时间维度，
       * 始终整体清空。缺省 = 全部清空。
       */
      since: z.number().optional(),
      /**
       * 站点级清理：只清该 origin 下的存储（如 `https://example.com`）。
       * 缺省 = 全局。history / downloads / cache 是全局语义，传 origin 时它们不参与
       * （调用方应只传 storage 类类型，见站点设置面板）。
       */
      origin: z.string().optional()
    }),
    response: z.object({
      ok: z.boolean(),
      /** 各类型是否清理成功（失败不阻断其它类型） */
      results: z.record(z.string(), z.boolean()),
      /** 失败类型的可读原因（仅失败项出现） */
      errors: z.record(z.string(), z.string()).optional()
    })
  })
})

export { browsingDataSchemas, BROWSING_DATA_TYPES }

