/**
 * 验证器面板的**视图**（只读状态、只画、只转译意图）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 两条渲染路径（与 model 的两条信号一一对应）
 * ══════════════════════════════════════════════════════════════════════
 *   · render()     —— 结构变化：重建列表 / 切换视图。频率低（用户操作时）。
 *   · renderCodes()—— 每秒一次：**只改每个条目的码文本与进度条宽度**，
 *                     不碰 DOM 结构。这是"倒计时不卡"的全部秘密：
 *                     一屏十几条若每秒重建，输入框会失焦、滚动会跳、点击会丢。
 *
 * 所以这里维护一份 `id → { codeEl, barEl, ringEl }` 的节点引用表 ——
 * 重建列表时同步更新，tick 时直接按 id 取。
 */

import {
  formatCode,
  formatClockOffset,
  type TotpModel,
  type TotpPanelState,
  type TotpPendingItem,
  type TotpScanState
} from './panel-totp.model.js'
// 算法 / 位数 / 周期三张下拉的取值与领域层是同一份真源（shared-types#totp.mjs）
import { TOTP_ALGORITHMS, TOTP_DIGITS, TOTP_PERIODS } from '@hira-ng/shared-types/src/totp.mjs'
// 二维码能力来自共享内核（`shared/qr-scan/`）—— 与独立「扫码器」插件同一份实现
import { isQrScanSupported } from '../src/renderer/shared/qr-scan/detector.js'
import type { TotpCode, TotpEntry } from '@hira-ng/domain-totp'

interface TotpViewPorts {
  menu?: {
    popupMenu(options: unknown): unknown
  }
}

/** 扫到一条时状态行的绿色高亮持续多久（与「扫码器」面板同一档）。 */
const HIT_HIGHLIGHT_MS = 2200

export function createTotpView(doc: Document, model: TotpModel, ports: TotpViewPorts = {}) {
  const menu = ports.menu || null
  const root = el(doc, 'div', 'totp-panel')
  const toolbar = el(doc, 'div', 'totp-panel__toolbar')
  const notice = el(doc, 'div', 'totp-panel__notice')
  const body = el(doc, 'div', 'totp-panel__body')

  // ── 工具条：搜索 + 新建 + 导入 ──────────────────────────────
  //
  // ⚠ 这里刻意用**文字**而不是图标符号（`＋` / `⇥`）。试过符号版：用户根本认不出
  // `⇥` 是"导入"，只能靠 hover 的 title 才知道 —— 而"要点一下试试"本身就是失败。
  // 侧栏虽窄，两个两字按钮挤得住（搜索框会自己收缩）。
  //
  // 主次是刻意的：**「导入」是这块面板的主入口**（新用户的第一件事就是把手上的
  // 验证器搬进来），所以给它填充色（`is-primary`）—— 「新建」手动敲密钥是少数派，
  // 保持安静的次级样式。反过来会让"手动输入"看起来像推荐做法。
  const search = el(doc, 'input', 'totp-panel__search')
  search.type = 'search'
  search.placeholder = '搜索…'
  search.spellcheck = false
  search.addEventListener('input', () => model.setQuery(search.value))

  /**
   * 三个入口分两行：**搜索框独占第一行**，第二行是「扫码」（大按钮）+ 「新建」+「截图导入」。
   *
   * 为什么换行：侧栏太窄，四个东西挤一行时搜索框只剩几十像素（输不了几个字），
   * 而按钮也被压成小方块。拆成两行后搜索框满宽可用，扫码作为主入口给足点击面积。
   * 命名跟着用户的说法走：「导入」→ **「截图导入」**（它管的就是截图 / 图片文件）。
   */
  const scanBtn = toolBtn(doc, '扫码', '扫描屏幕上的二维码', () => model.openScan())
  scanBtn.classList.add('is-primary', 'is-main')
  const addBtn = toolBtn(doc, '新建', '手动输入一条', () => model.openForm(null))
  const importBtn = toolBtn(doc, '截图导入', '粘贴链接 / 粘贴截图 / 选择图片文件', () => model.openImport())
  toolbar.append(search, scanBtn, addBtn, importBtn)

  /**
   * 时钟校准（状态行，常驻列表页）。
   *
   * 为什么单独一行而不是挤进工具条：工具条第二行已经有「扫码 / 新建 / 截图导入」，
   * 再加一个就把搜索框以外的东西全挤成小方块。更重要的是这条是**状态**——
   * 验证码不对时用户需要一眼看到"我现在用的是本机时间还是校准过的时间"，
   * 状态与动作（校准 / 恢复）放一起才说得清。
   *
   * 校准**不改系统时间**，只把偏移叠加到算码上（见 domain-totp 的 calibrate）。
   */
  const clockBar = el(doc, 'div', 'totp-panel__clock')
  const clockText = el(doc, 'span', 'totp-panel__clock-text')
  const calibrateBtn = el(doc, 'button', 'totp-panel__link', '校准')
  calibrateBtn.type = 'button'
  calibrateBtn.title = '联网校准本机时钟：只影响验证码，不改系统时间'
  calibrateBtn.addEventListener('click', () => model.calibrate())
  const resetClockBtn = el(doc, 'button', 'totp-panel__link', '恢复')
  resetClockBtn.type = 'button'
  resetClockBtn.title = '清除校准偏移，回到本机时间'
  resetClockBtn.addEventListener('click', () => model.resetClock())
  clockBar.append(clockText, calibrateBtn, resetClockBtn)

  notice.hidden = true
  root.append(toolbar, clockBar, notice, body)

  /** id → 该行里要逐秒改的节点。重建列表时刷新。 */
  const nodes = new Map<string, {
    codeEl: HTMLElement | null
    barEl: HTMLElement | null
    countEl: HTMLElement | null
    copiedEl: HTMLElement | null
  }>()

  /** 命中提示的时标与定时器（见 renderScanStatus）。 */
  let hitUntil = 0
  let hitTimer: ReturnType<typeof setTimeout> | null = null
  /** 上一次已经提示过的那条 id —— 用它判断"这是新扫到的"，避免重建时重放动画。 */
  let lastHitId: string | null = null

  // ══════════════════════════════════════════════════════════
  // 渲染入口
  // ══════════════════════════════════════════════════════════

  function render() {
    const st = model.state
    renderNotice(st)
    // 表单/导入/扫码下搜索框没有意义（那几屏的内容不受它影响），收起来省一行
    toolbar.hidden = st.mode !== 'list'
    // 「扫码」需要抓屏能力（取景框端口 + 「扫码器」插件在）：不可用就不给这个按钮
    scanBtn.hidden = !st.scanSupported
    renderClock(st)
    search.value = st.query
    body.textContent = ''
    nodes.clear()

    if (st.mode === 'form') { body.appendChild(renderForm(st)); return }
    if (st.mode === 'scan') { body.appendChild(renderScanScreen(st)); return }
    if (st.mode === 'import') { body.appendChild(renderImport(st)); return }
    // 导出框排在列表之前：它是临时的、要用户立刻处理的东西（复制走）
    const revealed = renderReveal(st)
    if (revealed) body.appendChild(revealed)
    renderList(st)
  }

  /**
   * 进度条：用 transform: scaleX 而不是改 width —— 合成器能直接处理，不触发布局。
   *
   * ⚠ 首帧与逐秒**必须走同一个函数**：只在 tick 里设值的话，渲染后有整整一秒
   * 进度条处于"没有 transform"的状态（= 满格），看起来像"这条刚刷新过"。
   * HOTP 没有时间窗 → 整条填满且永不推进（表达"它不会自己变"）。
   */
  function applyProgress(bar: HTMLElement | null, code: TotpCode | undefined) {
    if (!bar) return
    const remaining = code?.remaining
    const ratio = !code || code.period == null || remaining == null ? 1 : remaining / code.period
    bar.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`
    bar.classList.toggle('is-expiring', !!code && code.period != null && remaining != null && remaining <= 5)
  }

  /**
   * 剩余秒数（跟在验证码右边的小字）。
   *
   * 为什么除了进度条还要给数字：条形只能看出"大概还剩多少"，而**照着念/手输**的时候
   * 需要的是确切判断"还来得及吗"（剩 3 秒就该等下一轮，别念到一半失效）。
   * HOTP 没有时间窗 → 整块隐藏（不是显示 0，那会让人以为要过期了）。
   * 取值用 `Math.floor`：宁可保守（显示 3 秒时至少还有 3 秒可用），多显示的那 1 秒会误事。
   */
  function applyCountdown(node: HTMLElement | null, code: TotpCode | undefined) {
    if (!node) return
    const secs = code && code.period != null && code.remaining != null && Number.isFinite(code.remaining)
      ? Math.max(0, Math.floor(code.remaining))
      : null
    node.hidden = secs == null
    if (secs == null) return
    const text = `${secs}s`
    if (node.textContent !== text) node.textContent = text
    node.classList.toggle('is-expiring', secs <= 5)
  }

  /**
   * 每秒一次：**只改数字，不重建结构**。
   * 「已复制」的反馈也走这条（它是 1.2 秒的瞬时态，重建整张列表太浪费）。
   */
  function renderCodes() {
    const st = model.state
    if (st.mode !== 'list') return
    for (const [id, n] of nodes) {
      const c = st.codes.get(id)
      if (!c || !n.codeEl) continue
      const text = formatCode(c.code)
      if (n.codeEl.textContent !== text) n.codeEl.textContent = text
      n.codeEl.classList.remove('is-pending')
      applyProgress(n.barEl, c)
      applyCountdown(n.countEl, c)
      if (n.copiedEl) n.copiedEl.hidden = st.copiedId !== id
    }
  }

  // ══════════════════════════════════════════════════════════
  // 列表
  // ══════════════════════════════════════════════════════════

  function renderList(st: TotpPanelState) {
    if (!st.loaded) { body.appendChild(el(doc, 'div', 'totp-panel__empty', '正在读取…')); return }

    const visible = model.visibleEntries()
    if (!st.entries.length) {
      body.appendChild(renderEmptyState())
      return
    }
    if (!visible.length) {
      body.appendChild(el(doc, 'div', 'totp-panel__empty', `没有匹配「${st.query.trim()}」的条目`))
      return
    }

    const frag = doc.createDocumentFragment()
    for (const e of visible) frag.appendChild(renderRow(st, e))
    body.appendChild(frag)
  }

  function renderRow(st: TotpPanelState, entry: TotpEntry) {
    const row = el(doc, 'div', 'totp-panel__row')
    const main = el(doc, 'div', 'totp-panel__main')

    /**
     * 服务名与账号**同一行**（左名右号），下面只放验证码 —— 每条 2 行。
     *
     * 第一版是"服务名 / 账号 / 验证码"三行：侧栏一屏只放得下四五条，
     * 而账号本来就不需要跟服务名一样大（它只是用来区分同名条目的）。
     */
    const head = el(doc, 'div', 'totp-panel__head')
    const issuer = el(doc, 'span', 'totp-panel__issuer', entry.issuer || '未命名')
    issuer.title = entry.issuer || ''
    head.appendChild(issuer)
    if (entry.account) {
      const account = el(doc, 'span', 'totp-panel__account', entry.account)
      account.title = entry.account
      head.appendChild(account)
    }
    // 算法/位数非默认时才标出来 —— 默认的 6 位 SHA1 是绝大多数，标了等于噪音
    if (entry.digits !== 6 || entry.period !== 30 || entry.type === 'HOTP') {
      const bits = [entry.type === 'HOTP' ? 'HOTP' : `${entry.period}s`, `${entry.digits} 位`]
      const tag = el(doc, 'span', 'totp-panel__tag', bits.join(' · '))
      tag.title = `算法 ${entry.algorithm}`
      head.appendChild(tag)
    }
    main.appendChild(head)

    const code = st.codes.get(entry.id)
    // 逐秒要改的就是这个节点 —— 直接持有引用，不回头 querySelector：
    // 那等于把类名当成对外契约，类名一改就静默失效。
    let codeEl = null
    let countEl = null
    if (st.unavailable.has(entry.id)) {
      // 解不开 ≠ 丢了：如实说是哪一台机器的问题，用户才知道要去哪儿找密钥
      main.appendChild(el(doc, 'div', 'totp-panel__broken', '本机无法解出密钥'))
    } else if (code) {
      // 验证码 + 剩余秒数同一行（码在前、秒数贴在右边）
      const codeRow = el(doc, 'div', 'totp-panel__code-row')
      codeEl = el(doc, 'div', 'totp-panel__code', formatCode(code.code))
      codeEl.title = '点击复制'
      countEl = el(doc, 'span', 'totp-panel__countdown')
      applyCountdown(countEl, code)
      codeRow.append(codeEl, countEl)
      main.appendChild(codeRow)
    } else {
      codeEl = el(doc, 'div', 'totp-panel__code is-pending', '—— —— ——')
      main.appendChild(codeEl)
    }

    row.appendChild(main)

    const actions = el(doc, 'div', 'totp-panel__actions')
    const copiedEl = el(doc, 'span', 'totp-panel__copied', '已复制')
    copiedEl.hidden = st.copiedId !== entry.id
    const menuBtn = iconBtn(doc, '⋯', '更多')
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      openRowMenu(entry, menuBtn)
    })
    actions.append(copiedEl, menuBtn)
    row.appendChild(actions)

    // 进度条：贴在这行的底边，首帧就把真实剩余量设上（见 applyProgress）
    const bar = el(doc, 'div', 'totp-panel__bar')
    applyProgress(bar, code)
    row.appendChild(bar)

    // 整行点击 = 复制（这是这个面板最高频的动作，别让用户去找小按钮）
    row.addEventListener('click', () => model.copyCode(entry.id))
    // 右键 = 同一份行菜单（与「⋯」同一个入口，不各写一套）——
    // 对准条目上任何一个位置都能右键，比每次都去够右上角那个小按钮顺手。
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      openRowMenu(entry, null)
    })

    nodes.set(entry.id, { codeEl, barEl: bar, copiedEl, countEl })
    return row
  }

  // ══════════════════════════════════════════════════════════
  // 行菜单（复制 / 编辑 / 导出 / 删除）
  // ══════════════════════════════════════════════════════════

  /**
   * 行菜单 —— **走宿主的原生菜单端口**（`ctx.menu.popupMenu`），不自绘。
   *
   * 第一版是自绘的（一个 `position:fixed` 的 div），代价清单正好是"为什么不该自绘"：
   *   · **层级要自己抢**：面板内容区有自己的层叠上下文，菜单会被压在下面 ——
   *     看得见却点不动，而这类问题只在某些面板布局下出现（最难复现的那种 bug）；
   *   · 挂 body 才不被滚动容器裁掉，点外面关闭要自己兜（`setTimeout` + 一次性监听）；
   *   · 样式要自己跟主题、自己写 hover … 而原生菜单是**系统行为**（Edge / 系统右键都这样，
   *     带键盘导航、快捷键提示、屏幕边缘自动翻转）—— 自绘永远差一层。
   *
   * 项目里已经有统一端口（`renderer/shared/menu-client.js` → 主进程 `Menu.popup`），
   * 与标签行菜单 / 笔记面板同一个东西。**入口只有这一处**：「⋯」按钮与行内右键都调它。
   */
  async function openRowMenu(entry: TotpEntry, anchor: HTMLElement | null) {
    if (!menu) return
    const items = [
      { label: '复制验证码', action: 'copy' },
      { label: '编辑', action: 'edit' },
      { label: '导出链接（含密钥）', action: 'export' },
      { type: 'separator' },
      { label: '删除', action: 'delete' }
    ]
    /**
     * 坐标：只有「⋯」按钮需要给（贴着它的左下角展开）；
     * 右键不给坐标 —— 主进程用**鼠标位置**弹（最准，见 space-controller 的说明：
     * 渲染层量到的局部坐标与原生 popup 用的窗口坐标不同源，鼠标位置反而没有换算误差）。
     */
    const r = anchor && typeof anchor.getBoundingClientRect === 'function'
      ? anchor.getBoundingClientRect()
      : null
    let action = null
    try {
      action = await menu.popupMenu({
        items,
        ...(r ? { x: Math.round(r.left), y: Math.round(r.bottom) } : {})
      })
    } catch (_) {
      action = null   // 菜单不可用（宿主没接端口等）不该弹错误 —— 什么都不做是最合理的
    }
    if (!action) return
    if (action === 'copy') model.copyCode(entry.id)
    else if (action === 'edit') model.openForm(entry)
    else if (action === 'export') model.revealEntry(entry.id)
    else if (action === 'delete') model.removeEntry(entry.id)
  }

  // ══════════════════════════════════════════════════════════
  // 表单（新增 / 编辑）
  // ══════════════════════════════════════════════════════════

  function renderForm(st: TotpPanelState) {
    const editing = st.editing
    const wrap = el(doc, 'div', 'totp-panel__form')
    wrap.appendChild(formHeader(editing ? '编辑条目' : '添加条目'))

    const issuer = field(doc, '服务名', 'GitHub / Google', editing ? editing.issuer : '')
    const account = field(doc, '账号', 'alice@example.com', editing ? editing.account : '')
    const secret = field(
      doc, '密钥',
      editing ? '留空则不改' : 'Base32 密钥',
      ''
    )
    wrap.append(issuer.row, account.row, secret.row)

    // 高级项折起来：绝大多数条目是 SHA1/6/30，摊开只会让人以为必须填
    const advanced = el(doc, 'details', 'totp-panel__advanced')
    advanced.appendChild(el(doc, 'summary', '', '高级（算法 / 位数 / 周期）'))
    const algo = select(doc, '算法', TOTP_ALGORITHMS, editing ? editing.algorithm : 'SHA1')
    const digits = select(doc, '位数', TOTP_DIGITS.map(String), String(editing ? editing.digits : 6))
    const period = select(doc, '周期（秒）', TOTP_PERIODS.map(String), String(editing ? editing.period : 30))
    advanced.append(algo.row, digits.row, period.row)
    wrap.appendChild(advanced)

    const err = el(doc, 'div', 'totp-panel__form-error')
    err.hidden = true
    wrap.appendChild(err)

    const actions = el(doc, 'div', 'totp-panel__form-actions')
    const cancel = el(doc, 'button', 'totp-panel__btn', '取消')
    cancel.type = 'button'
    cancel.addEventListener('click', () => model.backToList())
    const save = el(doc, 'button', 'totp-panel__btn is-primary', editing ? '保存' : '添加')
    save.type = 'button'
    save.addEventListener('click', () => {
      if (!editing && !secret.input.value.trim()) {
        err.textContent = '请填写密钥'
        err.hidden = false
        return
      }
      err.hidden = true
      model.saveEntry({
        issuer: issuer.input.value,
        account: account.input.value,
        secret: secret.input.value,
        algorithm: algo.input.value,
        digits: Number(digits.input.value),
        period: Number(period.input.value)
      })
    })
    actions.append(cancel, save)
    wrap.appendChild(actions)
    return wrap
  }

  // ══════════════════════════════════════════════════════════
  // 扫码界面（只有扫码 —— 粘贴/选图是另一个界面）
  // ══════════════════════════════════════════════════════════

  /**
   * 屏幕扫码界面。
   *
   * 与「导入」界面**刻意分开**：这是两个不同的任务 ——
   * 扫码要盯着**屏幕上的取景框**（面板只是余光），粘贴要盯着**这个框**。
   * 挤在一个界面里时，两个任务的元素（扫码卡 + 粘贴框 + 选择图片 + 两个主按钮）
   * 互相分心，且"扫码"这个小众路径占掉了导入界面最显眼的位置。
   */
  function renderScanScreen(st: TotpPanelState) {
    const sc = st.scan
    const wrap = el(doc, 'div', 'totp-panel__form')
    wrap.appendChild(formHeader('扫描二维码'))

    const status = renderScanStatus(sc)
    if (status) wrap.appendChild(status)

    /**
     * 扫到的令牌**一条一项、每项自带按钮**（与「扫码器」面板完全同一套行结构）。
     *
     * 为什么不是顶部一张卡统管：扫到的每一条都是**独立的**东西 ——
     * 用户可能只要其中一条（"这张是给我的，那张是同事的"），逐项给按钮才谈得上确认；
     * 顶部的"清空 / 导入"是在替用户做"这一批一起处理"的决定。
     * 批量入口只在**多于一条**时出现在状态行右侧（分批迁移码必须一起解析，见 model）。
     */
    if (sc.pending.length) {
      const list = el(doc, 'div', 'totp-panel__pending-list')
      sc.pending.forEach((item, index) => list.appendChild(renderPendingRow(item, index)))
      wrap.appendChild(list)
    } else if (sc.open) {
      wrap.appendChild(el(doc, 'div', 'totp-panel__hint', '把取景框拖到二维码上，它会自动识别'))
    }

    /**
     * 底部**平时一个按钮都没有**：
     *   · 「返回」在标题行已经有了（formHeader 的链接）；
     *   · 「重新扫描」在**取景框自己的提示条**上（扫描时用户的眼睛在那儿）；
     *   · 「收起取景框」是多余的 —— 框上就有 ✕，返回列表时也会自动收。
     * 只有"框没打开"这一种情况才需要一个按钮把框叫回来。
     */
    if (!sc.open) {
      const actions = el(doc, 'div', 'totp-panel__form-actions')
      const open = el(doc, 'button', 'totp-panel__btn is-primary', '打开取景框')
      open.type = 'button'
      open.addEventListener('click', () => model.scanScreen())
      actions.appendChild(open)
      wrap.appendChild(actions)
    }
    return wrap
  }

  /**
   * 扫码状态行（还在不在扫 / 出错 / 已扫到几张）。
   *
   * **扫到一条时整行变绿 2.2 秒**（与「扫码器」面板同一条规矩：命中必须"跳出来"）——
   * 用户的目光在取景框上，面板只是余光；不闪这一下，他根本不知道刚扫到了东西。
   */
  function renderScanStatus(sc: TotpScanState) {
    const warned = !sc.pending.length && sc.lastWasUsable === false && !!sc.message
    if (!sc.error && !sc.open && !sc.message) return null

    // 新命中 → 开一次绿色高亮（用 id 判断"是不是新的一条"，重建列表不会重放）
    if (sc.lastAddedId && sc.lastAddedId !== lastHitId) {
      lastHitId = sc.lastAddedId
      hitUntil = Date.now() + HIT_HIGHLIGHT_MS
      if (hitTimer) clearTimeout(hitTimer)
      hitTimer = setTimeout(() => {
        hitTimer = null
        hitUntil = 0
        // 直接摘类（不重新渲染）：这一下只是为了让人看见，不值得整屏重建
        const row = body.querySelector('.totp-panel__scan-status')
        if (row) row.classList.remove('is-hit')
      }, HIT_HIGHLIGHT_MS)
    }

    const hit = hitUntil > Date.now()
    const row = el(doc, 'div', 'totp-panel__scan-status'
      + (sc.error ? ' is-error' : (warned ? ' is-warn' : (hit ? ' is-hit' : ''))))
    row.appendChild(el(doc, 'span', 'totp-panel__scan-dot'))
    row.appendChild(el(doc, 'span', 'totp-panel__scan-text', scanCardText(sc)))
    // 批量入口：只在**多于一条**时给（分批迁移码要一起解析才能合并，逐条会不完整）
    if (sc.pending.length > 1) {
      const all = el(doc, 'button', 'totp-panel__link', '全部导入')
      all.type = 'button'
      all.title = '把这 N 张一起导入（分批二维码需要一起解析）'
      all.addEventListener('click', () => model.importScanned())
      row.appendChild(all)
    }
    return row
  }

  /**
   * 一条待导入的令牌 —— **与「扫码器」面板的记录行完全同一套结构**（换行显示）：
   *
   * ```
   *   [验证器密钥]                      [⋯]
   *   GitHub:alice@example.com              ← 标题（核对用）
   *   otpauth://totp/GitHub:alice…          ← 原文（单行省略，悬停看全）
   *   [导入]                                 ← 主动作**另起一行**
   * ```
   * 一行挤着显示是不行的：窄侧栏里"标签 + 导入 + ⋯"一挤，用户既看不清扫到的是什么、
   * 也点不准按钮。两个面板的同一种东西长得一样，用户不必学两遍。
   */
  function renderPendingRow(item: TotpPendingItem, index: number) {
    const row = el(doc, 'div', 'totp-panel__pending')

    const head = el(doc, 'div', 'totp-panel__pending-head')
    head.appendChild(el(doc, 'span', 'totp-panel__pending-chip', item.chip))
    const more = iconBtn(doc, '⋯', '更多')
    more.addEventListener('click', () => openPendingMenu(item, index, more))
    head.appendChild(more)
    row.appendChild(head)

    if (item.title) {
      const title = el(doc, 'div', 'totp-panel__pending-title', item.title)
      title.title = item.title
      row.appendChild(title)
    }
    const detail = el(doc, 'div', 'totp-panel__pending-detail', item.text)
    detail.title = item.text
    row.appendChild(detail)

    // 导入失败的原因**贴在这一条上** —— 而不是丢一句"见下方"（扫码界面没有那个结果框）
    if (item.error) {
      const err = el(doc, 'div', 'totp-panel__pending-error', item.error)
      err.title = item.error
      row.appendChild(err)
    }

    const go = el(doc, 'button', 'totp-panel__btn is-primary', '导入')
    go.type = 'button'
    go.title = '导入这一条'
    go.addEventListener('click', () => model.importPendingAt(index))
    row.appendChild(go)
    return row
  }

  /** 行内「⋯」（原生菜单）：复制原文 / 从清单里移除。 */
  async function openPendingMenu(item: TotpPendingItem, index: number, anchor: HTMLElement | null) {
    if (!menu) return
    const items = [
      { label: '复制内容', action: 'copy' },
      { type: 'separator' },
      { label: '移除', action: 'remove' }
    ]
    const r = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null
    let action = null
    try {
      action = await menu.popupMenu({ items, ...(r ? { x: Math.round(r.left), y: Math.round(r.bottom) } : {}) })
    } catch (_) { action = null }
    if (action === 'copy') model.copyText(item.text)
    else if (action === 'remove') model.removePendingAt(index)
  }

  /** 状态行文案（一行、极短）。 */
  function scanCardText(sc: TotpScanState) {
    if (sc.error) return sc.error
    if (sc.pending.length) return `已扫到 ${sc.pending.length} 张`
    if (!sc.open) return sc.message || ''
    if (sc.capturing) return '识别中…'
    return '对准二维码'
  }

  // ══════════════════════════════════════════════════════════
  // 导入界面（粘贴 / 截图 / 选图）—— **不含任何扫码元素**
  // ══════════════════════════════════════════════════════════

  function renderImport(st: TotpPanelState) {
    const wrap = el(doc, 'div', 'totp-panel__form')
    wrap.appendChild(formHeader('导入'))

    const ta = el(doc, 'textarea', 'totp-panel__paste')
    ta.rows = 4
    // placeholder 承担"这里能放什么"的说明 —— 不再另起一段小字（侧栏很窄，那种段落最占地方）
    ta.placeholder = '粘贴 otpauth 链接，或直接 Ctrl+V 粘贴二维码截图'
    ta.spellcheck = false
    /**
     * **粘贴图片**：这是最顺的一条路 —— 用户截图 Google 的导出二维码后
     * 本能就是 Ctrl+V，而不是"先存成文件再点选择图片"。
     * 只在剪贴板里真的有图片时拦截；纯文本粘贴照常走默认行为。
     */
    ta.addEventListener('paste', (ev) => {
      const files = (ev.clipboardData && ev.clipboardData.files) || []
      const images = Array.from(files).filter((f) => f.type && f.type.startsWith('image/'))
      if (!images.length) return
      ev.preventDefault()
      model.importImages(images)
    })
    wrap.appendChild(ta)

    // ── 选图入口（扫码是**另一个界面**的事，这里只做"我手上有一张图"）──
    const entryRow = el(doc, 'div', 'totp-panel__entry-row')
    if (isQrScanSupported()) {
      const fileInput = el(doc, 'input', 'totp-panel__file')
      fileInput.type = 'file'
      fileInput.accept = 'image/*'
      fileInput.multiple = true
      fileInput.hidden = true
      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files.length) model.importImages(fileInput.files)
        fileInput.value = ''   // 清空，否则再选同一张图不触发 change
      })
      const pick = el(doc, 'button', 'totp-panel__btn', '选择图片…')
      pick.type = 'button'
      pick.addEventListener('click', () => fileInput.click())
      entryRow.append(fileInput, pick)
      wrap.appendChild(entryRow)
    } else {
      wrap.appendChild(el(doc, 'div', 'totp-panel__hint', '此环境不支持二维码识别，请粘贴链接文本。'))
    }

    // 只有「导入」一个按钮：**返回**已经在顶部那行标题里（formHeader 的链接），
    // 底部再放一个是重复 —— 侧栏里每一行都算钱。
    const actions = el(doc, 'div', 'totp-panel__form-actions')
    const go = el(doc, 'button', 'totp-panel__btn is-primary', '导入')
    go.type = 'button'
    go.addEventListener('click', () => {
      model.importText(ta.value).then(() => {
        // 成功导入后直接回列表 —— 用户最想看的是"进来了没有"
        const st2 = model.state
        if (st2.importResult && st2.importResult.added && st2.importResult.added.length) model.backToList()
      })
    })
    actions.appendChild(go)
    wrap.appendChild(actions)

    const res = st.importResult
    if (res) {
      const box = el(doc, 'div', 'totp-panel__import-result')
      box.appendChild(el(doc, 'div', '', `识别为「${res.label}」：成功 ${res.added.length} 条，跳过 ${res.skipped.length} 条`))
      // 适配器自己的提醒（分批二维码没给全、缺密钥的条目…）要原样带出来
      for (const w of res.warnings || []) box.appendChild(el(doc, 'div', 'totp-panel__import-warn', w))
      if (res.skipped.length) {
        const list = el(doc, 'ul', 'totp-panel__import-list')
        // 逐条报"第几条、为什么" —— 批量导入最怕"整体失败"这种没有线索的结果
        for (const s of res.skipped.slice(0, 10)) {
          list.appendChild(el(doc, 'li', '', `第 ${s.index + 1} 条：${s.reason}`))
        }
        if (res.skipped.length > 10) list.appendChild(el(doc, 'li', '', `…还有 ${res.skipped.length - 10} 条`))
        box.appendChild(list)
      }
      wrap.appendChild(box)
    }
    return wrap
  }

  // ══════════════════════════════════════════════════════════
  // 导出（唯一会把密钥显示出来的地方）
  // ══════════════════════════════════════════════════════════

  /**
   * 导出（唯一会把密钥显示出来的地方）。
   *
   * 不再写标题行：红框 + 只读链接 + 「复制」已经说明这是什么 —— 那行"（含密钥，请勿外传）"
   * 是说明文，而说明文在窄面板里就是噪音。
   */
  function renderReveal(st: TotpPanelState) {
    const rev = st.revealed
    if (!rev) return null
    const box = el(doc, 'div', 'totp-panel__reveal')
    const input = el(doc, 'input', 'totp-panel__reveal-input')
    input.type = 'text'
    input.readOnly = true
    input.value = rev.uri
    input.title = '导出链接（含密钥）'
    input.addEventListener('focus', () => input.select())
    const actions = el(doc, 'div', 'totp-panel__form-actions')
    const copy = el(doc, 'button', 'totp-panel__btn is-primary', '复制链接')
    copy.type = 'button'
    copy.addEventListener('click', () => model.copyText(rev.uri))
    const close = el(doc, 'button', 'totp-panel__btn', '关闭')
    close.type = 'button'
    close.addEventListener('click', () => model.closeReveal())
    actions.append(close, copy)
    box.append(input, actions)
    return box
  }

  // ══════════════════════════════════════════════════════════
  // 小块
  // ══════════════════════════════════════════════════════════

  function renderNotice(st: TotpPanelState) {
    const n = st.error ? { text: st.error, kind: 'error' } : st.notice
    if (!n) { notice.hidden = true; notice.textContent = ''; return }
    notice.hidden = false
    notice.className = 'totp-panel__notice' + (n.kind === 'error' ? ' is-error' : '')
    notice.textContent = n.text
  }

  /**
   * 时钟状态行：未校准只说"使用本机时间"（不吓人），校准后把偏移**说成人话**。
   * 校准时按钮禁用 + 换文案 —— 联网测一次要几秒，不禁用就会连点出几次请求。
   */
  function renderClock(st: TotpPanelState) {
    // 与工具条同一条规矩：表单/扫码/导入屏上它没有意义
    clockBar.hidden = st.mode !== 'list'
    if (clockBar.hidden) return
    const clock = st.clock || {}
    const calibrated = !!clock.measuredAt
    const busy = st.calibrating === true
    clockBar.classList.toggle('is-off', !calibrated)
    clockBar.classList.toggle('is-busy', busy)
    clockText.textContent = busy
      ? '正在联网校准…'
      : calibrated ? `已校准 · ${formatClockOffset(clock.offsetMs)}` : '使用本机时间'
    calibrateBtn.textContent = busy ? '校准中…' : calibrated ? '重新校准' : '校准'
    calibrateBtn.disabled = busy
    resetClockBtn.hidden = !calibrated
    resetClockBtn.disabled = busy
  }

  function formHeader(text: string) {
    const head = el(doc, 'div', 'totp-panel__form-head')
    head.appendChild(el(doc, 'span', 'totp-panel__form-title', text))
    const back = el(doc, 'button', 'totp-panel__link', '返回')
    back.type = 'button'
    back.addEventListener('click', () => model.backToList())
    head.appendChild(back)
    return head
  }

  /**
   * 空态。第一次用面板的人第一眼看到的就是它 —— 所以这里**必须放真按钮**，
   * 而不是一段"请点右上角的 XX"式的文字说明：后者要求用户先去界面里找一遍，
   * 而"找不到"正是这个面板最可能被放弃的地方。
   */
  function renderEmptyState() {
    const box = el(doc, 'div', 'totp-panel__empty')
    box.appendChild(el(doc, 'div', 'totp-panel__empty-title', '还没有验证器条目'))

    // 三个入口**对应用户手上的三种东西**：屏幕上的二维码 / 已存的截图或链接 / 一串密钥。
    // 扫码不可用时（抓屏能力不在）它就不出现，主按钮落到「粘贴 / 选图」上。
    const scanSupported = model.state.scanSupported
    const actions = el(doc, 'div', 'totp-panel__empty-actions')
    if (scanSupported) {
      const scanBtn = el(doc, 'button', 'totp-panel__btn is-primary', '扫码导入')
      scanBtn.type = 'button'
      scanBtn.addEventListener('click', () => model.openScan())
      actions.appendChild(scanBtn)
    }
    const importBtn = el(doc, 'button', 'totp-panel__btn' + (scanSupported ? '' : ' is-primary'), '粘贴 / 选图')
    importBtn.type = 'button'
    importBtn.addEventListener('click', () => model.openImport())
    const manualBtn = el(doc, 'button', 'totp-panel__btn', '手动输入密钥')
    manualBtn.type = 'button'
    manualBtn.addEventListener('click', () => model.openForm(null))
    actions.append(importBtn, manualBtn)
    box.appendChild(actions)
    return box
  }

  return { element: root, render, renderCodes }
}

// ── 小工具（本文件专用，不进 shared）──────────────────────────

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

function iconBtn(doc: Document, glyph: string, title: string): HTMLButtonElement {
  const b = el(doc, 'button', 'totp-panel__icon-btn', glyph)
  b.type = 'button'
  b.title = title
  return b
}

/**
 * 工具条上的**文字**按钮。
 *
 * 与 `iconBtn` 的分工：工具条用文字（新用户要能看懂），行内用符号
 * （行内空间紧、且 `⋯` 是通用惯例，见 renderRow）。
 */
function toolBtn(
  doc: Document,
  label: string,
  title: string,
  onClick: (event: MouseEvent) => void
): HTMLButtonElement {
  const b = el(doc, 'button', 'totp-panel__tool-btn', label)
  b.type = 'button'
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

/**
 * 一行一个字段：**标签与输入框同一行**。
 *
 * 标签单独占一行时，三个字段就是六行 —— 在窄侧栏里这等于把"高级"和按钮全推到屏幕外。
 * 标签固定宽度（样式里 44px）后左对齐成一条竖线，读起来一样清楚，行数砍半。
 * 同时把标签写进 `title` / `aria-label`：placeholder 输入后会消失，得留一条后路。
 */
function field(
  doc: Document,
  label: string,
  placeholder: string,
  value: unknown
): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = el(doc, 'label', 'totp-panel__field')
  row.appendChild(el(doc, 'span', 'totp-panel__field-label', label))
  const input = el(doc, 'input', 'totp-panel__field-input')
  input.type = 'text'
  input.placeholder = placeholder
  input.title = label
  input.setAttribute('aria-label', label)
  input.value = value == null ? '' : String(value)
  input.spellcheck = false
  row.appendChild(input)
  return { row, input }
}

function select(
  doc: Document,
  label: string,
  options: readonly (string | number)[],
  value: string | number
): { row: HTMLLabelElement; input: HTMLSelectElement } {
  const row = el(doc, 'label', 'totp-panel__field')
  row.appendChild(el(doc, 'span', 'totp-panel__field-label', label))
  const input = el(doc, 'select', 'totp-panel__field-input')
  input.title = label
  input.setAttribute('aria-label', label)
  for (const opt of options) {
    const o = el(doc, 'option', '', opt)
    o.value = String(opt)
    input.appendChild(o)
  }
  input.value = String(value)
  row.appendChild(input)
  return { row, input }
}
