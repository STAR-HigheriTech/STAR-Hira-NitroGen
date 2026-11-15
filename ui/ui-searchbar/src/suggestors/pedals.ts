// @ts-check
/**
 * Pedal suggestor：**命令底座** —— 关键词直达浏览器动作（Quick Commands）。
 *
 * 本文件**只剩一层壳**：命令表与匹配算法都在
 * `packages/shared-types/src/commands.mjs`（全项目唯一真源）。
 * 改造前命令表在本文件与 `TabManager#omniboxAction` 各存一份，
 * "加一条命令 = 两处各一行"，漏一处就是"能搜到但点了没反应"。
 *
 * 本包仍然**不认识任何 IPC**：它只产出 `{ type:'pedal', action }`，
 * 动作由编排层转给主进程派发（`omnibox:action` → `TabManager#omniboxAction`）。
 */

import { matchCommands } from '@hira-ng/shared-types/src/commands.mjs'

/**
 * @param {import('../types').SuggestorContext} ctx
 * @returns {import('../types').Suggestion[]}
 */
import type { SuggestorContext, Suggestion } from '../types'
export function pedalSuggestor(ctx: SuggestorContext): Suggestion[] {
  // `!` 是 bangs 的命名空间：`!settings` / `!后退` 这类**快捷动作**由
  // `bangsSuggestor` 统一产出（它还把面板一起列出来）。这里再匹配一遍会出**重复行**
  // ——`matchCommands('!settings')` 靠「query 包含关键词」这一档同样命中 open_settings。
  if (String(ctx.query || '').trim().startsWith('!')) return []
  return matchCommands(ctx.query, 3).map((c) => ({
    type: /** @type {'pedal'} */ (('pedal') as 'pedal'),
    action: c.id,
    title: c.title,
    relevance: c.relevance,
    source: 'pedal'
  }))
}
