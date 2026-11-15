/**
 * 权限申请浮层 —— 渲染层（只画，不接线、不认识 IPC）。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 * 输入：`requests = [{ id, origin, type, sensitive }]`（主进程推来的**事实**）。
 * 输出：用户点了哪一档 → `onChoice(request, choice)`（**意图**，不含 persist 判据的
 *       解释权 —— 这里转发的就是 PERMISSION_CHOICES 里那四个纯数据字段）。
 * 本文件不 invoke 任何 IPC、不订阅事件、不知道外壳是谁。
 *
 * ── 一处真源 ─────────────────────────────────────────────────────────────
 * 权限中文名（`permissionLabel`）、图标键（`permissionIcons`）、站点可读化
 * （`hostOfOrigin`）、四档文案与 allow·persist 语义（`PERMISSION_CHOICES`）
 * **全部**来自 `@hira-ng/shared-types/src/permission-labels.mjs` ——
 * 与侧栏权限面板、hira:// 权限页共用同一份规格。
 * 本文件只做「把 key 映射成自己的样式类」，绝不另写一份文案或判据，
 * 否则三处界面迟早各说各话（"允许/拒绝" vs "允许一次/始终允许"）。
 */

// 深路径引用（避开 ui-common 重桶）—— 浮层启动只评估真正用到的模块。
import { iconByName } from '@hira-ng/ui-common/src/icons'
import { LIST_LIMITS, splitByLimit, createOverflowRow } from '@hira-ng/ui-common/src/listOverflow'
import {
  PERMISSION_CHOICES,
  permissionIcons,
  permissionLabel,
  hostOfOrigin
} from '@hira-ng/shared-types/src/permission-labels.mjs'

/** @param {Document} doc @param {string} tag @param {string} [className] @param {string} [text] */
function el<T extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: T,
  className?: string,
  text?: unknown
): HTMLElementTagNameMap[T] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  return node
}

/**
 * 图标组：`media` 这类合并类型会返回两个键名（摄像头 + 麦克风），都画出来 ——
 * 未知键名静默跳过，绝不因此让整行消失。
 * @param {Document} doc @param {string[]} names @param {number} [size]
 */
function iconStack(doc: Document, names: readonly string[] | null | undefined, size = 18): HTMLElement {
  const box = el(doc, 'span', 'hira-permission-icon')
  for (const name of names || []) {
    const svg = iconByName(name, doc, { size })
    if (svg) box.appendChild(svg)
  }
  box.hidden = box.childElementCount === 0
  return box
}

/**
 * 一条请求 = 一张卡：头部（图标 + 站点 + 请求说明 + 敏感标记）+ 四档决定。
 * @param {Document} doc
 * @param {{ id: string, origin?: string, type?: string, sensitive?: boolean }} request
 * @param {(request: unknown, choice: unknown) => void} onChoice
 */
interface PermissionRequest { id: string; origin?: string; type?: string; sensitive?: boolean }

function buildRequestCard(
  doc: Document,
  request: PermissionRequest,
  onChoice: (request: unknown, choice: unknown) => void
): HTMLElement {
  const card = el(doc, 'div', 'hira-overlay-card hira-permission-card')

  // ── 头部：两行 —— 第一行站点名（用户先要看清"是谁在问"），第二行请求说明 ──
  const head = el(doc, 'div', 'hira-permission-head')
  head.appendChild(iconStack(doc, permissionIcons(request.type || '')))

  const title = el(doc, 'div', 'hira-permission-title')
  const host = el(doc, 'span', 'hira-permission-host', hostOfOrigin(request.origin))
  // 完整 origin 进 title：卡片里那行常被省略号截断，悬停还能核对是哪个站点
  host.title = request.origin || hostOfOrigin(request.origin)
  title.appendChild(host)

  const desc = el(doc, 'span', 'hira-permission-desc', `请求使用「${permissionLabel(request.type || '')}」`)
  // 敏感标记来自主进程（与侧栏面板同一判据），渲染层不自创
  if (request.sensitive === true) {
    desc.appendChild(el(doc, 'span', 'hira-permission-sensitive', '敏感'))
  }
  title.appendChild(desc)
  head.appendChild(title)
  card.appendChild(head)

  // ── 四档决定：文案 / allow / persist 全部来自共享规格，这里只映射样式类 ──
  const choices = el(doc, 'div', 'hira-permission-choices')
  for (const choice of PERMISSION_CHOICES) {
    const button = el(doc, 'button', `hira-permission-btn hira-permission-btn--${choice.key}`, choice.label)
    button.type = 'button'
    button.title = choice.hint
    // mousedown 先阻止默认：浮层靠"点外部收起"判据工作，别让按钮抢走焦点后
    // 顺带把外层文档的默认行为跑起来（与浮层内其他动作同一处理）。
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => onChoice(request, choice))
    choices.appendChild(button)
  }
  card.appendChild(choices)

  return card
}

/**
 * @param {Document} doc
 * @param {{
 *   onChoice: (request: unknown, choice: unknown) => void,
 *   onOverflow?: () => void
 * }} options
 *   onOverflow：列表超过 `LIST_LIMITS.permission` 时，末尾那条「还有 N 项 · 转到权限面板」
 *   被点下的上报 —— 本层只报"我点了"，**去哪个面板由外壳裁定**（与站点信息浮层同一条纪律）。
 * @returns {{ element: HTMLElement, render: (requests: unknown[]) => void }}
 */
export function createPermissionView(
  doc: Document,
  { onChoice, onOverflow }: { onChoice: (request: unknown, choice: unknown) => void; onOverflow?: () => void }
) : { element: HTMLElement, render: (requests: PermissionRequest[]) => void } {
  const list = el(doc, 'div', 'hira-permission-list')

  /** @param {unknown[]} requests */
  function render(requests: PermissionRequest[]): void {
    const items = Array.isArray(requests) ? requests : []
    list.textContent = ''
    if (items.length === 0) {
      // 兜底：正常路径下外壳在列表清空时直接收起浮层，不会走到这里
      list.appendChild(el(doc, 'div', 'hira-overlay-card hira-permission-empty', '当前没有待处理的权限请求'))
      return
    }
    // 一屏最多摆 `LIST_LIMITS.permission` 条（额度只此一份，见 ui-common#listOverflow）——
    // 超出部分不铺满整屏，收成一行「还有 N 项 · 转到权限面板」。
    const { shown, hiddenCount } = splitByLimit(items, LIST_LIMITS.permission)
    for (const request of shown) list.appendChild(buildRequestCard(doc, request, onChoice))
    if (hiddenCount > 0) {
      list.appendChild(createOverflowRow(doc, {
        hiddenCount,
        targetLabel: '权限面板',
        onActivate: onOverflow
      }))
    }
  }

  return { element: list, render }
}


