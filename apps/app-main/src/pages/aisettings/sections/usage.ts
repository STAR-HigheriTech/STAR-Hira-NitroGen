// @ts-check
/**
 * `hira://aisettings` · 用量与数据分区。
 *
 * 两件事：
 *   1. **用量**：按会话汇总的 token / 回合 / 成本（只读，数据来自引擎的 usage 表）；
 *   2. **数据**：审计日志导出（每次工具执行与审批裁决）与「彻底移除」。
 *
 * 边界：禁用或卸载 AI 插件**不会**删除任何数据（§5.2），所以这里不是"清理缓存"，
 * 而是唯一的销毁入口 —— 必须显式确认，且确认文案要说清楚"清了什么、不可恢复"。
 */
import { el } from 'hira://shared/runtime.js'
import type { AiUsageResponse } from 'hira://shared/ai-client.js'
import type { AiSettingsSection, AiSettingsSectionPort } from '../contracts.js'
import { actionRow, button, errorText, formatNumber, note } from '../kit.js'

export function createUsageSection(port: AiSettingsSectionPort): AiSettingsSection {
  const element = el('div', 'ai-view')

  let data: AiUsageResponse | null = null
  let loading = false
  let failed = ''

  async function load(): Promise<void> {
    if (loading) return
    loading = true
    if (!data) render()
    try {
      const res = await port.client.usage({})
      if (res && res.ok === false) throw new Error(res.message || res.code || '无法读取用量')
      data = {
        totals: (res && res.totals) || {},
        items: Array.isArray(res && res.items) ? res.items : []
      }
      failed = ''
    } catch (e) {
      failed = errorText(e)
    }
    loading = false
    render()
  }

  function activate(): void {
    if (data || loading) { render(); return }
    render()
    load()
  }

  function render(): void {
    element.textContent = ''

    const bar = el('div', 'toolbar')
    bar.appendChild(button('刷新', { onClick: () => load() }))
    element.appendChild(bar)

    if (failed) {
      element.appendChild(note(`读取用量失败：${failed}`, true))
      return
    }
    if (!data) {
      element.appendChild(el('div', 'empty', '统计中…'))
      return
    }

    const totals = data.totals ?? {}
    const grid = el('div', 'usage-grid')
    grid.appendChild(usageCell('输入 token', formatNumber(totals.promptTokens)))
    grid.appendChild(usageCell('缓存命中', formatNumber(totals.cachedTokens)))
    grid.appendChild(usageCell('输出 token', formatNumber(totals.completionTokens)))
    grid.appendChild(usageCell('回合', formatNumber(totals.turns)))
    if (totals.costUsd) grid.appendChild(usageCell('成本', `$${Number(totals.costUsd).toFixed(4)}`))
    element.appendChild(grid)

    const items = Array.isArray(data.items) ? data.items : []
    if (items.length) {
      const section = el('section', 'section')
      section.appendChild(el('div', 'section-title', '按会话 · 输入 / 缓存 / 输出'))
      const list = el('div', 'list')
      for (const item of items.slice(0, 50)) {
        const row = el('div', 'ai-usage-row')
        row.appendChild(el('span', 'ai-usage-name', String(item.sessionId || item.modelId || '全部')))
        row.appendChild(el('span', 'ai-usage-tokens mono',
          `${formatNumber(item.promptTokens)} / ${formatNumber(item.cachedTokens)} / ${formatNumber(item.completionTokens)}`))
        list.appendChild(row)
      }
      section.appendChild(list)
      element.appendChild(section)
    }

    // ── 数据：审计导出 + 彻底移除 ──────────────────────────────────────
    const dataSection = el('section', 'section ai-data-section')
    dataSection.appendChild(el('div', 'section-title', '数据'))
    dataSection.appendChild(note('禁用或卸载 AI 插件不会删除对话与配置。只有下面这个动作会真正清空全部 AI 数据。'))

    dataSection.appendChild(actionRow(
      button('导出审计日志 CSV', {
        small: true,
        onClick: async () => {
          const res = await port.request(() => port.client.auditExport('csv', 5000))
          if (res && res.ok) port.notify('已导出审计日志', true)
        }
      }),
      button('导出审计日志 JSON', {
        small: true,
        onClick: async () => {
          const res = await port.request(() => port.client.auditExport('json', 5000))
          if (res && res.ok) port.notify('已导出审计日志', true)
        }
      })
    ))

    dataSection.appendChild(note('彻底移除会清空全部会话、消息、模型服务与密钥、技能与用量统计，且无法恢复。', true))
    dataSection.appendChild(actionRow(
      button('彻底移除 AI 数据', {
        danger: true,
        onClick: async () => {
          if (!window.confirm('将清空全部 AI 数据（会话、消息、模型服务与密钥、自建技能、用量统计），且无法恢复。确定继续吗？')) return
          const res = await port.request(() => port.client.purge())
          if (!res) return
          port.notify('已清空全部 AI 数据', true)
          data = null
          await load()
        }
      })
    ))
    element.appendChild(dataSection)
  }

  function usageCell(label: string, value: unknown): HTMLElement {
    const cell = el('div', 'usage-cell')
    cell.appendChild(el('div', 'usage-value', String(value)))
    cell.appendChild(el('div', 'usage-label', label))
    return cell
  }

  /** @param {string} reason */
  function onStateChanged(reason?: string): void {
    if (reason === 'purged' || reason === 'turn-end') load()
  }

  return { element, activate, refresh: load, onStateChanged }
}
