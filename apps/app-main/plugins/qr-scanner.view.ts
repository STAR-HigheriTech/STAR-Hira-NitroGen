/**
 * 扫码器的**视图**（只读状态、只画、只把用户意图转成对模型的调用）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么这里没有预览画面（这是刻意的，不是省事）
 * ══════════════════════════════════════════════════════════════════════
 * 第一版做过「面板里放取景框显示实时画面」，对**摄像头**那是对的；但换成**抓屏幕**
 * 之后它会变成一面镜子：面板在被抓的那块屏上 → 预览里又有面板 → 面板里又有预览……
 * 无限套娃，既难看又费性能。
 *
 * 而"预览"在这里本来就没有信息量 —— 抓的**就是用户正看着的这块屏**，
 * 他抬眼就能看见。真正需要反馈的是"扫到了没有 / 扫到了什么"，所以这一块由
 * **状态条**（带脉冲指示 + 刚扫到的那一条）承担，而不是一面镜子。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条渲染路径（与模型的两条信号一一对应）
 * ══════════════════════════════════════════════════════════════════════
 *   · `render()`    —— 结构变化：开关扫描、记录增删、复制反馈。
 *   · `renderHit()` —— 命中：**只改状态条那一行**，新记录插到列表顶部。
 * 分开的理由是"不打断用户"：他可能正滚在列表中间看某一条，整块重建会让位置跳掉。
 */

import { QR_CONTENT } from '../src/renderer/shared/qr-scan/decoder.js'
import type { QrResult, QrScannerModel, QrScannerState } from './qr-scanner.model.js'

type TimerHandle = ReturnType<typeof setTimeout>

interface QrViewPorts {
  menu?: { popupMenu(options: unknown): unknown } | null
}

type QrMenuItem = {
  label?: string
  action?: string | null
  type?: string
  enabled?: boolean
}

/** 命中高亮持续多久（毫秒）。见 highlightHit 的说明。 */
const HIT_HIGHLIGHT_MS = 2200

export function createQrScannerView(doc: Document, model: QrScannerModel, ports: QrViewPorts = {}) {
  const menu = ports.menu ?? null
  const root = el(doc, 'div', 'qrscanner-panel')

  // ── 工具条：一个主按钮 + 一个「⋯」──
  //
  // 侧栏很窄：**常显的按钮每多一个，内容就少一行**。"重新扫描"与"清空"是低频动作，
  // 收进 ⋯ 的原生菜单（与标签行菜单/笔记面板同一套），工具条只留唯一的主动作。
  const toolbar = el(doc, 'div', 'qrscanner-panel__toolbar')
  const scanBtn = el(doc, 'button', 'qrscanner-panel__btn is-primary qrscanner-panel__scan-btn', '扫描屏幕')
  scanBtn.type = 'button'
  scanBtn.addEventListener('click', () => {
    if (model.state.scanning) model.stopScan()
    else model.startScan()
  })
  const moreBtn = el(doc, 'button', 'qrscanner-panel__icon-btn', '⋯')
  moreBtn.type = 'button'
  moreBtn.title = '更多'
  moreBtn.addEventListener('click', () => openMoreMenu(moreBtn))
  toolbar.append(scanBtn, moreBtn)

  /** 「⋯」菜单（原生）：低频动作都在这里，工具条因此不拥挤。 */
  async function openMoreMenu(anchor: HTMLElement): Promise<void> {
    const st = model.state
    const items: QrMenuItem[] = [
      { label: '重新扫描', action: 'rescan', enabled: !!st.scanning },
      { type: 'separator' },
      { label: '清空记录', action: 'clear', enabled: st.results.length > 0 }
    ]
    const r = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null
    let action = null
    try {
      action = await (menu ? menu.popupMenu({ items, ...(r ? { x: Math.round(r.left), y: Math.round(r.bottom) } : {}) }) : null)
    } catch (_) { action = null }
    if (action === 'rescan') model.runScan()
    else if (action === 'clear') model.clearResults()
  }

  // ── 状态条：扫描中 / 刚扫到一条 ──
  const status = el(doc, 'div', 'qrscanner-panel__status')
  status.hidden = true

  const notice = el(doc, 'div', 'qrscanner-panel__notice')
  notice.hidden = true

  const body = el(doc, 'div', 'qrscanner-panel__body')
  root.append(toolbar, status, notice, body)

  /** 记录 id → 该行要单独改的节点（重复命中时只改计数）。重建列表时刷新。 */
  const rowNodes = new Map<string, { rowEl: HTMLElement; countEl: HTMLElement }>()
  /** 记录列表容器（命中时往顶部插一行用）。空态/不支持态下为 null。 */
  let listEl: HTMLElement | null = null
  /** 状态条里那一行文字。 */
  let statusTextEl: HTMLElement | null = null
  /** 命中高亮的截止时间 + 褪色定时器（见 highlightHit）。 */
  let hitUntil = 0
  let hitTimer: TimerHandle | null = null
  /**
   * "最新扫到的那一条"的 id —— 它一直带着高亮色。
   *
   * 为什么不是"闪一下就完"：用户的目光在取景框上，等他回到面板时那一闪早没了。
   * 常驻高亮 + 只保留一条（下一条命中时把上一条的标记摘掉）才是能用的指引。
   */
  let newestId: string | null = null
  const flashTimers = new WeakMap<HTMLElement, TimerHandle>()

  // ══════════════════════════════════════════════════════════
  // 渲染入口
  // ══════════════════════════════════════════════════════════

  function render(): void {
    const st = model.state
    renderToolbar(st)
    renderStatus(st)
    renderNotice(st)
    rowNodes.clear()
    listEl = null
    body.textContent = ''
    const showList = st.results.length > 0 || !st.screenSupported
    body.appendChild(showList ? renderList(st) : renderEmpty())
  }

  /** 命中：只改状态条那行，并把新记录插到列表顶部 / 更新重复计数。 */
  function renderHit(): void {
    const st = model.state
    const hit = st.lastHit
    if (!hit) return
    // ⚠ 这里**不调 renderStatus**：那会重建整条状态条，把多屏切换的下拉框也一起重建 ——
    // 用户正拉着它选屏幕时被重建会直接打断。只改文字 + 加高亮类。
    // 顺序也重要：先开高亮（`hitUntil`），文字才对得上"只显示命中"那一版。
    highlightHit()
    updateStatusText()
    if (!listEl) { render(); return }   // 之前在空态：整块切过去即可（记录只有一条）
    const entry = st.results.find((r) => r.id === hit.id)
    if (!entry) return
    if (hit.isNew) {
      clearNewestMark()
      newestId = entry.id
      const row = renderRow(st, entry)
      // 入场动画（一次性）；常驻高亮由 `is-new` 承担，见 renderRow 的说明
      row.classList.add('is-pop')
      listEl.insertBefore(row, listEl.firstChild)
    } else {
      const nodes = rowNodes.get(entry.id)
      if (nodes && nodes.countEl) nodes.countEl.textContent = `×${entry.count}`
    }
    flash(root)
  }

  /** 把上一条"最新"的高亮摘掉（同时只有一条最新）。 */
  function clearNewestMark(): void {
    for (const n of rowNodes.values()) {
      if (n.rowEl) n.rowEl.classList.remove('is-new')
    }
  }

  /**
   * 命中高亮（状态条变绿 + 脉冲一圈），`HIT_HIGHLIGHT_MS` 后自己褪掉。
   *
   * 为什么要"自己褪掉"而不是留着：状态条上"刚才扫到了"是**瞬时事件**，
   * 一直亮着会让下一次命中失去对比（用户分不清是新扫到的还是上次那条）。
   * 用时间戳记 `hitUntil`，这样中途若有 `renderStatus()` 重建也不会把高亮弄丢。
   */
  function highlightHit(): void {
    hitUntil = Date.now() + HIT_HIGHLIGHT_MS
    applyHitClass()
    if (hitTimer) clearTimeout(hitTimer)
    hitTimer = setTimeout(() => {
      hitTimer = null
      hitUntil = 0
      status.classList.remove('is-hit')
      // 高亮褪去 → 文字换回"安静"那一版（否则会一直挂着上一次的命中）
      updateStatusText()
    }, HIT_HIGHLIGHT_MS)
  }

  function applyHitClass(): void {
    const on = hitUntil > Date.now()
    status.classList.toggle('is-hit', on)
  }

  // ══════════════════════════════════════════════════════════
  // 工具条 / 状态条
  // ══════════════════════════════════════════════════════════

  function renderToolbar(st: QrScannerState): void {
    /**
     * 引擎不在（或被用户关掉）时**整条工具条收起**。
     *
     * 面板与引擎是两个插件：关掉引擎后这个面板还在，但"扫描屏幕"点下去只可能失败 ——
     * 一个按不动的按钮比"没有按钮"更糟（用户会反复点）。理由写在空态那句话里（见 renderUnsupported）。
     */
    toolbar.hidden = !st.screenSupported
    scanBtn.textContent = st.scanning ? '停止扫描' : '扫描屏幕'
    scanBtn.className = 'qrscanner-panel__btn qrscanner-panel__scan-btn'
      + (st.scanning ? ' is-stop' : ' is-primary')
    scanBtn.disabled = !st.screenSupported
    moreBtn.hidden = !st.results.length && !st.scanning
  }

  /**
   * 状态条。
   * 三种形态：扫描中（脉冲点 + 说明）/ 刚扫到 / 都没有（整条收起）。
   */
  function renderStatus(st: QrScannerState): void {
    statusTextEl = null
    status.textContent = ''
    status.className = 'qrscanner-panel__status'
    const hit = st.lastHit
    if (!st.scanning && !hit) { status.hidden = true; return }
    status.hidden = false

    if (st.scanning) {
      status.appendChild(el(doc, 'span', 'qrscanner-panel__pulse'))
      status.classList.add('is-scanning')
    }
    statusTextEl = el(doc, 'span', 'qrscanner-panel__status-text', statusTextOf(st))
    status.appendChild(statusTextEl)
    // 重建后把命中高亮补回来（时间戳还在高亮期内就继续亮）—— 见 highlightHit
    applyHitClass()
  }

  /**
   * 状态条文字。**命中与平时是两套完全不同的文案**（上一版把它们拼在一起，
   * 结果"对准二维码 · 放下即识别 ✓ 已扫到「网址」"一长串，又乱又看不出重点）。
   *   命中（高亮期内）：只显示命中内容 —— 此刻用户只需要知道"认出了什么"；
   *   平时：一句极短的提示。
   */
  function statusTextOf(st: QrScannerState): string {
    const hit = st.lastHit
    if (hit && hitUntil > Date.now()) {
      return hit.count > 1 ? `✓ 又扫到「${hit.label}」（第 ${hit.count} 次）` : `✓ 已扫到「${hit.label}」`
    }
    if (!st.scanning) return st.results.length ? '已停止扫描' : ''
    if (st.capturing) return '识别中…'
    // 触发式扫描：静止时它什么都不做，所以要把"怎么让它扫"说清楚（但要短）
    return st.lastScanEmpty === true ? '没认出来 · 点 ⋯ 重新扫描' : '对准二维码 · 放下即识别'
  }

  /** 只更新状态条那行文字（命中时用，避免重建整条状态条）。 */
  function updateStatusText(): void {
    if (!statusTextEl) return
    statusTextEl.textContent = statusTextOf(model.state)
  }

  function renderNotice(st: QrScannerState): void {
    const n = st.error ? { text: st.error, kind: 'error' } : st.notice
    if (!n) { notice.hidden = true; notice.textContent = ''; return }
    notice.hidden = false
    notice.className = 'qrscanner-panel__notice' + (n.kind === 'error' ? ' is-error' : '')
    notice.textContent = n.text
  }

  // ══════════════════════════════════════════════════════════
  // 列表 / 空态
  // ══════════════════════════════════════════════════════════

  function renderList(st: QrScannerState): HTMLElement {
    const wrap = el(doc, 'div', 'qrscanner-panel__list')
    if (!st.screenSupported) return renderUnsupported()
    listEl = wrap
    for (const r of st.results) wrap.appendChild(renderRow(st, r))
    return wrap
  }

  /**
   * 扫不了 —— 两种原因合成同一句话（细节留在 title 里）：
   *   · 大多数情况是**引擎插件没启用**（面板与引擎是两个插件，用户能单独关掉引擎）；
   *   · 少数是宿主没给抓屏端口（接线问题）。
   * 措辞指向"引擎"，用户才知道去哪恢复 —— 而不是以为系统不支持、就此放弃。
   */
  function renderUnsupported(): HTMLElement {
    const box = el(doc, 'div', 'qrscanner-panel__empty')
    const title = el(doc, 'div', 'qrscanner-panel__empty-title', '扫码器引擎未启用')
    title.title = '抓屏能力由「扫码器引擎」插件提供：在插件管理里启用即可（验证器面板的扫码也用同一个引擎）。'
      + '若它已启用仍看到这一句，则是宿主没有提供抓屏端口 —— 那是接线问题。'
    box.appendChild(title)
    return box
  }

  function renderEmpty(): HTMLElement {
    const box = el(doc, 'div', 'qrscanner-panel__empty')
    box.appendChild(el(doc, 'div', 'qrscanner-panel__empty-title', '还没有扫到二维码'))
    const actions = el(doc, 'div', 'qrscanner-panel__empty-actions')
    const go = el(doc, 'button', 'qrscanner-panel__btn is-primary', '扫描屏幕')
    go.type = 'button'
    go.addEventListener('click', () => model.startScan())
    actions.appendChild(go)
    box.appendChild(actions)
    return box
  }

  /**
   * 一条识别记录。
   *
   * 面板窄 → **每条只给一个主动作 + 一个「⋯」**（复制/删除进原生菜单）。
   * 第一版把"打开 / 存入验证器 / 复制 / 删除"四个按钮平铺，一行按钮就把内容挤没了。
   */
  function renderRow(st: QrScannerState, r: QrResult): HTMLElement {
    const row = el(doc, 'div', 'qrscanner-panel__row')
    // 最新扫到的那一条常驻高亮（见 newestId 的说明）—— 视图整体重建后也保持
    if (r.id === newestId) row.classList.add('is-new')
    const head = el(doc, 'div', 'qrscanner-panel__head')
    head.appendChild(el(doc, 'span', `qrscanner-panel__chip is-${r.kind}`, r.label))
    const countEl = el(doc, 'span', 'qrscanner-panel__chip is-count', `×${r.count}`)
    countEl.hidden = r.count <= 1
    head.appendChild(countEl)
    const copied = el(doc, 'span', 'qrscanner-panel__copied', '已复制')
    copied.hidden = st.copiedId !== r.id
    head.appendChild(copied)

    const more = el(doc, 'button', 'qrscanner-panel__icon-btn', '⋯')
    more.type = 'button'
    more.title = '更多'
    more.addEventListener('click', () => openRowMenu(r, more))
    head.appendChild(more)
    row.appendChild(head)

    if (r.title) {
      const title = el(doc, 'div', 'qrscanner-panel__title', r.title)
      title.title = r.title
      row.appendChild(title)
    }
    // 原始内容：**单行省略**，全文在悬停提示里（窄面板里放不下多行）
    const detail = el(doc, 'div', 'qrscanner-panel__detail', r.text)
    detail.title = r.text
    row.appendChild(detail)

    // 主动作只有一个：能打开就"打开"，否则只能复制
    if (r.href) row.appendChild(actionBtn(doc, '打开', 'is-primary', () => model.openResult(r.id)))
    else if (r.kind === QR_CONTENT.OTPAUTH && st.totpAvailable) {
      row.appendChild(actionBtn(doc, '存入验证器', 'is-primary', () => model.addToTotp(r.id)))
    }

    rowNodes.set(r.id, { rowEl: row, countEl })
    return row
  }

  /** 行内「⋯」（原生菜单）：把行上那些低频动作收起来。 */
  async function openRowMenu(r: QrResult, anchor: HTMLElement): Promise<void> {
    const st = model.state
    const items: QrMenuItem[] = [{ label: '复制内容', action: 'copy' }]
    if (r.kind === QR_CONTENT.OTPAUTH && st.totpAvailable && !r.href) {
      items.push({ label: '存入验证器', action: 'totp' })
    }
    items.push({ type: 'separator' }, { label: '从记录中移除', action: 'remove' })
    const rect = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null
    let action = null
    try {
      action = await (menu ? menu.popupMenu({ items, ...(rect ? { x: Math.round(rect.left), y: Math.round(rect.bottom) } : {}) }) : null)
    } catch (_) { action = null }
    if (action === 'copy') model.copyResult(r.id)
    else if (action === 'totp') model.addToTotp(r.id)
    else if (action === 'remove') model.removeResult(r.id)
  }

  /** 命中闪光：加类 → 下一帧摘掉；用 reflow 强制重放（连续命中也能看到闪）。 */
  function flash(node: HTMLElement): void {
    node.classList.remove('is-hit')
    void node.offsetWidth
    node.classList.add('is-hit')
    const previous = flashTimers.get(node)
    if (previous) clearTimeout(previous)
    flashTimers.set(node, setTimeout(() => node.classList.remove('is-hit'), 340))
  }

  return { element: root, render, renderHit }
}

// ── 小工具（本文件专用）────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: unknown
): HTMLElementTagNameMap[K] {
  const n = doc.createElement(tag)
  if (className) n.className = className
  if (text != null) n.textContent = String(text)
  return n
}

function actionBtn(
  doc: Document,
  label: string,
  extraClass: string,
  onClick: (event: MouseEvent) => void
): HTMLButtonElement {
  const b = el(doc, 'button', `qrscanner-panel__action${extraClass ? ` ${extraClass}` : ''}`, label)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}
