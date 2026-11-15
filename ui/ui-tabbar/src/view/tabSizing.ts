// @ts-check
/**
 * 标签条的**密度压缩**（Edge 式）——标签多起来时先缩宽度，再收窄标签之间的缝，
 * 最后才滚动。
 *
 * ── 只压缩「标签之间」，不压缩「标签之内」──────────────────────────────
 * 宽度交给 **flex 布局**（`.tab-item { width: 偏好宽; min-width: 下限; flex-shrink: 1 }`）：
 * 它按比例把标签压到刚好放下，是**逐帧连续**的，不需要 JS 参与、也不会有一帧延迟。
 * 本模块只管 CSS 做不到的那一件事：**标签之间的缝**（--ng-tab-gap-x）。
 *
 * ⚠ **标签内部**（favicon ↔ 标题 ↔ 关闭键）的间距与**内边距**都不参与压缩：
 *   内边距曾经也随密度在 5~12px 之间变化，结果是「同一排标签，内容的前缘一会儿贴边、
 *   一会儿又缩回来」——用户实测：标签少时多出一截莫名奇妙的前方边距，标签多时反而紧贴。
 *   密度变化肉眼并不可预期，而"内容紧贴标签前缘"才是想要的常态，于是内边距固定为
 *   --ng-tab-padding-x（5px），只让 2px 级的缝去承担密度压力。
 *
 * ── 输入：strip 的内容盒宽，**不是** inner 的实测宽 ────────────────────
 * 曾经的写法是读滚动容器（#tabs-inner）的 getBoundingClientRect().width：它天然等于
 * 「放得下时 = 内容宽，放不下时 = 容器宽」，看起来省事，实际有两个致命坑：
 *   ① inner 是 shrink-to-fit（flex: 0 1 auto）。新标签入场 / 旧标签离场都有 180ms 的
 *      宽度动画，通知落在动画中间帧时读到的是**半截宽**（甚至 0）→ k 被算成 0；
 *      动画结束后没有任何信号再触发重算（外层 #tabs 的宽没变）→ 错误值一直留着。
 *   ② 缝变窄会让 inner 的内容宽跟着变小，下一次测量读到更小的值 → k 更低 → 只收不放（棘轮）。
 * 现在改量外层 #tabs 的**内容盒**（宽度只由窗口与侧栏决定，与标签内容无关），
 * 再减去不可压缩项（标签组芯片）的外宽 —— 这是唯一不随动画与自身写入变化的基准。
 *
 * ── 两道闸：先便宜的判据，再贵的测量 ──────────────────────────────────
 * 本模块的观察面覆盖整棵子树，而**拖动重排**时标签的 class 会被反复改写
 * （拖起 / 落点指示 / 进入动画…）。若每次通知都去读 getComputedStyle +
 * getBoundingClientRect，就是每帧一次强制布局 —— 拖动直接被拖垮（用户实测"重排很卡顿"）。
 * 于是分两步：
 *   ① **指纹**（排版槽位数 : 活动标签 id : 芯片数 : 芯片文本长度）——只读 classList 与
 *      textContent，**不触发布局**；指纹没变且尺寸没变（ResizeObserver）→ 立即返回；
 *   ② 真的算了才去读 token、容器宽与芯片宽，且写出的值**不变就不写**。
 *
 * ── 「槽位」而不是「标签数」（分屏合体标签）──────────────────────────────
 * 公式里的 n 是**排版槽位**：一条普通标签算 1 槽；一整段合体分屏（两半拼成
 * 一条标签 × --ng-tab-split-scale 的宽，见 styles.js 的 .in-split-run）也只算 **1 槽** ——
 * 后一半被负 margin 叠进前一半，既不额外吃宽、也不额外产生缝。基准宽与下限都取
 * 「普通档 × 同一个系数」，与 CSS 里那三条 calc 严格同口径。
 * 若仍按标签条数算，合体后基准宽会凭空多出一条标签，
 * k 被算小、缝被提前收窄（表现：本来放得下，却先把间距挤没了）。
 *
 * ⚠ 写完不回头：本模块**不观察自己写出的变化**（观察对象是外层 #tabs 的尺寸与
 *   子节点结构），因此不存在"改间距 → 触发重算 → 再改间距"的抖动环。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 * 不认识标签数据、不认识渲染引擎、不认识设置：只认两个元素（strip / inner）
 * 与一组 CSS 变量的名字。于是"再加一个随密度收窄的量"= 这里加一行映射。
 */

/** 压缩系数的量化档数：1/50 一档 —— 够细（看不出台阶），又不至于每次都写样式。 */
const K_STEPS = 50

/**
 * @param {{ strip: HTMLElement, inner: HTMLElement }} ctx
 *   strip = 外层标签条（#tabs，宽度由布局决定，不受标签内容影响 → 观察它不会自激）
 *   inner = 滚动容器（#tabs-inner，标签与芯片们的 flex 容器）
 * @returns {{ sync: () => void }}
 */
interface TabSizingContext {
  strip: HTMLElement
  inner: HTMLElement
}

interface TabSizingSurvey {
  slots: number
  activeKey: string
  chipCount: number
  chipKey: string
}

export function createTabSizing({ strip, inner }: TabSizingContext): { sync: () => void } {
  if (!strip || !inner) return { sync() {} }

  /** 上一次写出去的缝宽：值没变就一次样式都不写（避免无谓的样式重算）。 */
  let lastGapX: number | null = null
  let pending = false
  /** 上次算用的输入指纹（见文件头「两道闸」的说明）。 */
  let lastSignature: string | null = null
  /** 外层尺寸真的变了才置位（ResizeObserver / window resize）—— 与指纹共同决定"要不要算"。 */
  let geometryDirty = true

  /**
   * 读一个 token 的数值（缺失时用兜底值，绝不 NaN 进计算）。
   * 长度 token 是 px、比例 token 是无单位数，两者都走 parseFloat。
   * @param {CSSStyleDeclaration} cs
   * @param {string} name
   * @param {number} fallback
   */
  const num = (cs: CSSStyleDeclaration, name: string, fallback: number): number => {
    const n = parseFloat(cs.getPropertyValue(name))
    return Number.isFinite(n) ? n : fallback
  }

  /** 把缝宽按需写回（值没变就跳过）。 */
  function apply(gapX: number) {
    if (gapX === lastGapX) return
    lastGapX = gapX
    inner.style.setProperty('--ng-tab-gap-x', `${gapX}px`)
  }

  /**
   * 闸①：数**排版槽位** / 找活动标签 / 数芯片。**只读 classList 与 textContent，不触发布局**。
   * 槽位 = 一条普通标签、或一整段合体分屏（非首成员不占槽，见文件头「槽位」说明）。
   * 正在关闭的那条已经塌成 0 宽、马上离场，算进来会把系数算歪，故排除。
   * 芯片宽度随名称与计数变：用文本长度当指纹，改名 / 计数变化时才会重新测量。
   * @returns {{ slots: number, activeKey: string, chipCount: number, chipKey: string }}
   */
  function survey() : { slots: number, activeKey: string, chipCount: number, chipKey: string } {
    let slots = 0
    let activeKey = ''
    let chipCount = 0
    let chipKey = ''
    for (const child of inner.children) {
      const el = child as HTMLElement
      const cl = el.classList
      if (!cl) continue
      if (cl.contains('tab-item')) {
        if (cl.contains('is-tab-closing')) continue
        // 合体段的后续半边：叠在前一半里，不占槽、不产生缝
        if (cl.contains('in-split-run') && !cl.contains('split-run-first')) continue
        slots += 1
        if (cl.contains('active')) activeKey = String(el.dataset.tabId || 'active')
      } else if (cl.contains('tab-stack-chip')) {
        chipCount += 1
        chipKey += `${el.dataset.stackId || ''}#${el.textContent.length};`
      }
    }
    return { slots, activeKey, chipCount, chipKey }
  }

  function sync() {
    pending = false
    const { slots, activeKey, chipCount, chipKey } = survey()
    const signature = `${slots}:${activeKey}:${chipCount}:${chipKey}`
    if (signature === lastSignature && !geometryDirty) return
    lastSignature = signature
    geometryDirty = false
    applyFor(chipCount)
  }

  /** 闸②：真的需要重算时才读 token、容器宽与芯片宽，然后写变量。 */
  function applyFor(chipCount: number) {
    // ⚠ 读 token 一律读 **strip**，写一律写 **inner.style** —— 读写分离是硬约束：
    //   本模块把压缩值写成 inner 的行内变量，若同时又从 inner 读基准值，
    //   下一次同步就会读到自己刚写下的压缩值 → 只收不放（棘轮）。
    //   strip 是 inner 的父元素、且没有任何人会往它身上写这些变量 → 永远读到出厂值。
    const cs = getComputedStyle(strip)
    const width = num(cs, '--ng-tab-width', 140)
    const activeWidth = num(cs, '--ng-tab-active-width', 160)
    const minWidth = num(cs, '--ng-tab-min-width', 90)
    const activeMinWidth = num(cs, '--ng-tab-active-min-width', 122)
    const gapX0 = num(cs, '--ng-tab-gap-x', 2)
    const gapXMin = num(cs, '--ng-tab-gap-x-min', 0)
    // 合体分屏整段 = 普通档 × 该系数（styles.js 的三条 calc 用同一个 token）
    const splitScale = num(cs, '--ng-tab-split-scale', 1.45)
    const splitWidth = width * splitScale
    const splitMinWidth = minWidth * splitScale

    // 选中那条的基准宽与下限都另有一套（它压到最后仍要比邻居宽，见 tokens 说明）。
    // ⚠ 这里算的是**近似**下限：真实下限由 CSS 决定，且个别标签会更宽
    //   （例：带音频/静音按钮的标签，见 styles.js 的 .has-audio 规则）。少算的那一截
    //   只会让 k 略微偏大（缝少收窄一两像素），宽度本身由 flex 负责，不受影响。
    // ⚠ 合体分屏整段按**一条标签 × splitScale** 计（与 CSS 同口径：半宽 ×2，选中也不再加宽），
    //   否则基准宽与缝数会同时多算一条，k 被算小、间距提前收窄。
    let slots = 0
    let baseSum = 0
    let floorSum = 0
    for (const el of inner.children) {
      if (!el.classList || !el.classList.contains('tab-item')) continue
      if (el.classList.contains('is-tab-closing')) continue
      const merged = el.classList.contains('in-split-run')
      if (merged && !el.classList.contains('split-run-first')) continue
      slots += 1
      const active = !merged && el.classList.contains('active')
      baseSum += merged ? splitWidth : active ? activeWidth : width
      floorSum += merged ? splitMinWidth : active ? activeMinWidth : minWidth
    }

    // 0~1 个槽位且没有芯片：没有邻接关系，缝不可见，直接给满值（幂等）。
    if (slots + chipCount <= 1) {
      apply(Math.round(gapX0))
      return
    }

    // 可用宽 = #tabs 的**内容盒**（稳定，不随标签动画与自身写入变化）
    //        − 芯片这类不可压缩 flex 项的外宽（含左右 margin）。
    const stripRect = strip.getBoundingClientRect()
    let available = stripRect.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
    if (chipCount > 0) {
      for (const el of inner.children) {
        if (!el.classList || !el.classList.contains('tab-stack-chip')) continue
        const chipCs = getComputedStyle(el)
        available -= el.getBoundingClientRect().width
        available -= (parseFloat(chipCs.marginLeft) || 0) + (parseFloat(chipCs.marginRight) || 0)
      }
    }
    if (!(available > 0)) return // 还没布局（隐藏中）→ 保持现状，等下一次同步

    // 解 k：available = baseSum - (1-k)*S + gap(k)*gapCount，其中
    //   S        = 所有槽位从偏好宽压到**各自的下限**能腾出的总宽
    //   gap(k)   = gapXMin + (gapX0 - gapXMin) * k
    //   gapCount = 槽位之间的缝数（标签之间 + 标签与芯片之间）
    const shrinkRoom = baseSum - floorSum
    const gapSpan = gapX0 - gapXMin
    const gapCount = Math.max(0, slots + chipCount - 1)
    const denom = shrinkRoom + gapSpan * gapCount
    let k = denom > 0
      ? (available - baseSum + shrinkRoom - gapXMin * gapCount) / denom
      : (baseSum + gapX0 * gapCount <= available ? 1 : 0)
    k = Math.min(1, Math.max(0, k))
    // 量化：避免浮点导致的"每次同步差 0.0001 就写一次样式"。
    k = Math.round(k * K_STEPS) / K_STEPS

    apply(Math.round(gapX0 - gapSpan * (1 - k)))
  }

  /** 合帧：一次布局/一批 DOM 变化只算一次（标签批量恢复会话时会连续插入几十条）。 */
  function schedule() {
    if (pending) return
    pending = true
    requestAnimationFrame(sync)
  }

  // ① 尺寸变化：#tabs 的宽由布局决定（与标签内容无关）→ 观察它不会自我触发。
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      geometryDirty = true
      schedule()
    })
    ro.observe(strip)
  } else {
    window.addEventListener('resize', () => {
      geometryDirty = true
      schedule()
    })
  }

  // ② 结构变化：标签增删（childList）与状态变化（class：active / entering / closing）。
  //    刻意**不**观察 style —— 本模块自己写的就是 inline style，观察它必然自激。
  //    这些通知大多会被闸①的指纹挡掉（拖动期的 class 抖动即属此类）。
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(schedule)
    mo.observe(inner, { childList: true, attributes: true, attributeFilter: ['class'] })
  }

  sync()
  return { sync }
}
