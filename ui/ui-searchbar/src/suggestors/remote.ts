// @ts-check
/**
 * Remote suggestor：主进程统一搜索（历史 + 书签 + 标签合并，domain-search）。
 *
 * UI 包不摸 IPC —— 数据获取函数由编排层注入（ctx.getRemoteSuggestions），
 * 这里只做形状归一与防御。异步 suggestor：返回 Promise 即可，
 * 外层 requestSuggestions 用 Promise.all + requestSeq 处理竞态。
 */

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {Promise<import('../types').Suggestion[]>}
 */
import type { SuggestorContext, Suggestion } from '../types'
import { defineSuggestor } from '../core/define-suggestor'

function remoteSearch(ctx: SuggestorContext): Promise<Suggestion[]> {
  const getSuggestions = ctx.getRemoteSuggestions
  if (typeof getSuggestions !== 'function') return Promise.resolve([])
  const q = ctx.query.trim()
  // 空输入 = **零输入建议**（已打开标签 + 最近历史）—— 这正是"点开地址栏空着就该看到
  // 回到刚才那几页"的来源，主进程 `domain-search` 的 `search('')` 就返回它。
  // 只有"恰好一个字符"没意义（连子串搜索都算不上），跳过以免每次都白跑一趟 IPC。
  if (q.length === 1) return Promise.resolve([])

  return Promise.resolve()
    .then(() => getSuggestions(q))
    .then((results) => {
      if (!Array.isArray(results)) return []
      return results
        // 直通项：`pedal` 是**命令入口**（如 D2 命令链 `chain:<id>`），由主进程给出完整形状，
        // 这里原样放行 —— 硬塞进 website 会让它变成"打开一个网址"，语义就错了。
        .filter((r) => r && (r.url || r.type === 'search-history' || r.type === 'pedal'))
        .slice(0, 8)
        .map((r) => {
          if (r.type === 'pedal') {
            const action = r.action || r.id || ''
            return {
              id: r.id,
              type: 'pedal',
              action,
              title: r.title || action,
              relevance: typeof r.relevance === 'number' ? r.relevance : 400,
              source: r.source || 'remote'
            }
          }
          // **先摊平数据源给出的原样字段**，再覆盖"宿主必须兜底"的那几个。
          //
          // 这里曾是一张手抄的字段清单：每加一个字段都得记得回来补一行，漏了不会报错，
          // 只会**静默失效** —— 浏览历史的 `historyId` 就是这么丢的（下拉因此拿不到
          // 可删的那一行 id，「×」永远不出现）。摊平之后，数据源（domain / 插件）新增
          // 的任何字段都自动透传，UI 包只对"自己必须有默认值"的字段负责。
          //
          // 类型同理由提供方声明：`ai-ask` 这类插件行曾经被白名单压成 'website'，
          // 图标/默认选中规则一起走样。宿主不改别人的类型。
          return {
            ...r,
            id: r.id,
            type: typeof r.type === 'string' && r.type ? r.type : 'website',
            title: r.title || r.query || r.url || '',
            // domain-search 侧已按来源加权（书签 > 历史 > 标签），这里只兜底
            relevance: typeof r.relevance === 'number' ? r.relevance : 300,
            source: r.source || 'remote'
          }
        })
    })
    .catch(() => [])
}

// 本地 IPC 仍是异步链路，放到慢相，先渲染真正毫秒级的本地建议。
export const remoteSuggestor = defineSuggestor(remoteSearch, { phase: 'slow', id: 'remote' })
