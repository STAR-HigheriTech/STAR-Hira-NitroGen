/**
 * Section：本站权限 + 待处理请求。
 *
 * ── 为什么待处理请求放在权限区内部，而不是单独一个 section ──────────────────
 * 它和「本站权限」回答的是同一件事（这个站能做什么），只是状态不同（已决定 / 未决定）。
 * 拆成两个 section 会让「顶部优先展示待处理」这条展示规则散落到注册表排序里，
 * 未来新增权限类信息块时很难保证顺序。这里用一个 section 统一管理两种状态。
 *
 * ── 数据契约 ─────────────────────────────────────────────────────────────
 *   rules   = [{ type, setting: 'allow'|'block'|'ask' }]   ← permission:get-site
 *   pending = [{ id, type, origin, sensitive? }]           ← permission:pending-list（已按 origin 过滤）
 * 所有动作经 `emit` 交给 model，本文件不 invoke 任何 IPC。
 */

import {
  PERMISSION_CHOICES,
  PERMISSION_SETTING_LABELS,
  PERMISSION_SETTINGS,
  PERMISSION_TYPES,
  isValidPermissionSetting,
  permissionIcons,
  permissionLabel
} from '@hira-ng/shared-types/src/permission-labels.mjs'
import { createSection, el, iconStack, linkButton } from './shared.js'
import type { SiteInfoPendingPermission, SiteInfoPermissionRule } from '../model.js'

/**
 * 下拉里三档的**文案**：allow / block 直接取共享表，`ask` 在本视图改称「清除」。
 *
 * 顺序之所以是「允许 / 阻止 / 清除」：三档的语义强度是从"最明确地放行"到"最明确地拦下"，
 * 再到"不留规则"。「清除」= 原来的「询问」（`setting === 'ask'`）：下拉的 value 仍是 `ask`
 * （落库走 `permission:remove`，与权限面板的"清除"完全同一语义），只是把用户看到的词
 * 换成它真正做的事 —— 「询问」听起来像"每次都问一遍"的一种设置，而它其实是**把规则删掉**。
 *
 * 值集合与顺序都取自真源 `PERMISSION_SETTINGS`；本文件只负责这一套措辞。
 */
const SETTING_LABELS = Object.freeze({ ...PERMISSION_SETTING_LABELS, ask: '清除' })
const SETTING_ORDER = PERMISSION_SETTINGS
const MAX_PENDING = 3

/** 规范顺序直接取真源 `PERMISSION_TYPES`；未知类型（新版本 Chrome 引入、真源还没跟上的）排最后。 */
function typeRank(type: string) {
  const index = PERMISSION_TYPES.indexOf(type)
  return index < 0 ? PERMISSION_TYPES.length : index
}

/** @type {import('./registry.js').SiteInfoSection} */
export const permissionsSection: import('./registry.js').SiteInfoSection = {
  id: 'permissions',
  order: 30,
  create(ctx) {
    const { doc, emit } = ctx

    const shell = createSection(doc, {
      id: 'permissions',
      title: '本站权限',
      action: { label: '全部设置', onActivate: () => emit('open-permissions') }
    })

    const pendingWrap = el(doc, 'div', 'si-pending')
    // 定位标记：view#focusSection('pending') 用同一份契约滚动，section 之间不必互相认识。
    pendingWrap.dataset.siteinfoFocus = 'pending'
    const pendingHead = el(doc, 'div', 'si-subhead')
    const pendingTitle = el(doc, 'span', 'si-subhead-title', '待处理请求')
    const pendingMeta = el(doc, 'span', 'si-subhead-meta')
    pendingHead.appendChild(pendingTitle)
    pendingHead.appendChild(pendingMeta)

    const pendingList = el(doc, 'div', 'si-pending-list')
    const pendingMore = el(doc, 'div', 'si-pending-more')
    pendingWrap.appendChild(pendingHead)
    pendingWrap.appendChild(pendingList)
    pendingWrap.appendChild(pendingMore)

    const note = el(doc, 'div', 'si-note')
    const rows = el(doc, 'div', 'si-rows')

    shell.body.appendChild(pendingWrap)
    shell.body.appendChild(note)
    shell.body.appendChild(rows)

    let rulesSignature = ''
    let pendingSignature = ''

    /** 一条待处理请求：标题 + 四档决定。 */
    function renderPendingRequest(request: SiteInfoPendingPermission, busyId: string | null) {
      const card = el(doc, 'div', 'si-pending-card')

      const head = el(doc, 'div', 'si-pending-head')
      head.appendChild(iconStack(doc, permissionIcons(request.type), 14))
      head.appendChild(el(doc, 'span', 'si-pending-label', permissionLabel(request.type)))
      card.appendChild(head)

      const choices = el(doc, 'div', 'si-choices')
      for (const choice of PERMISSION_CHOICES) {
        const button = el(doc, 'button', `si-choice si-choice--${choice.key}`, choice.label) as HTMLButtonElement
        button.type = 'button'
        button.title = choice.hint
        button.disabled = !!busyId && busyId === request.id
        button.addEventListener('mousedown', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (button.disabled) return
          emit('permission-respond', { id: request.id, allow: choice.allow, persist: choice.persist })
        })
        choices.appendChild(button)
      }
      card.appendChild(choices)
      return card
    }

    function renderRules(rules: SiteInfoPermissionRule[], busyType: string | null, loading: boolean) {
      rows.textContent = ''
      if (loading && !rules.length) {
        note.hidden = false
        note.textContent = '正在读取权限…'
        return
      }
      if (!rules.length) {
        note.hidden = false
        note.textContent = '此站点尚未设置任何权限。'
        return
      }
      note.hidden = true

      const sorted = rules.slice().sort((a, b) => typeRank(a.type) - typeRank(b.type))
      for (const rule of sorted) {
        const row = el(doc, 'div', 'hira-overlay-row si-row')
        row.appendChild(iconStack(doc, permissionIcons(rule.type), 15))
        row.appendChild(el(doc, 'span', 'hira-overlay-label si-row-label', permissionLabel(rule.type)))

        const select = el(doc, 'select', 'si-select') as HTMLSelectElement
        select.setAttribute('aria-label', `${permissionLabel(rule.type)} 权限`)
        for (const setting of SETTING_ORDER) {
          const label = (SETTING_LABELS as Record<string, string>)[setting] || setting
          const option = el(doc, 'option', '', label) as HTMLOptionElement
          option.value = setting
          select.appendChild(option)
        }
        select.value = isValidPermissionSetting(rule.setting) ? rule.setting : 'ask'
        select.disabled = !!busyType && busyType === rule.type
        select.addEventListener('change', () => {
          emit('permission-set', { type: rule.type, setting: select.value })
        })
        row.appendChild(select)
        rows.appendChild(row)
      }
    }

    return {
      element: shell.root,
      update(state) {
        const permissions = state.permissions
        const rules = Array.isArray(permissions.rules) ? permissions.rules : []
        const pending = Array.isArray(permissions.pending) ? permissions.pending : []
        const busyType = permissions.busyType || null
        const busyId = permissions.busyRequestId || null

        // 权限能力不可用（插件禁用 / IPC 失败）→ 整区隐藏，而不是展示一堆空状态。
        const available = permissions.available !== false
        shell.root.hidden = !available
        if (!available) return

        // ── 待处理请求 ──
        const pendingKey = pending.map((item) => `${item.id}:${item.type}`).join('|') + `#${busyId || ''}`
        if (pendingKey !== pendingSignature) {
          pendingSignature = pendingKey
          pendingList.textContent = ''
          const shown = pending.slice(0, MAX_PENDING)
          for (const request of shown) {
            pendingList.appendChild(renderPendingRequest(request, busyId))
          }
          const rest = pending.length - shown.length
          pendingMore.textContent = ''
          pendingMore.hidden = rest <= 0
          if (rest > 0) {
            pendingMore.appendChild(linkButton(doc, `还有 ${rest} 条请求，前往权限面板 →`, () => emit('open-permissions')))
          }
        }
        pendingWrap.hidden = pending.length === 0
        pendingMeta.textContent = pending.length ? `${pending.length} 条` : ''

        // ── 已设置规则 ──
        const rulesKey = rules.map((rule) => `${rule.type}:${rule.setting}`).join('|') + `#${busyType || ''}`
        if (rulesKey !== rulesSignature) {
          rulesSignature = rulesKey
          renderRules(rules, busyType, permissions.loading)
        }

        shell.setActionVisible(true)
      }
    }
  }
}

