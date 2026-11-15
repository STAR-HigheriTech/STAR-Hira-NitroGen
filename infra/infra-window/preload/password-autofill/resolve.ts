/**
 * resolve.js — 凭据字段解析策略链（DeepSeekHarness 风格 Provider）
 *
 * ── 为什么需要这一层 ──────────────────────────────────
 * Hira 原版把「这次该填 usernameField / passwordField 中的哪两个」硬编码在
 * fillCredentials 内部。NG 把它抽成独立的**可插拔策略层**，于是：
 *
 *   fields.js   —— “页面上谁是候选字段”      （识别 + 评分 + 缓存 + observer）
 *   resolve.js  —— “本次操作填哪两个字段”    （策略链，Mod/插件可注册/替换）
 *   fill.js     —— “把值怎么写进去”          （纯写入器，零字段决策）
 *
 * 三层之间只传纯数据与 DOM 引用，互不反向依赖，可单独替换任意一层。
 *
 * ── 策略契约 ──────────────────────────────────────────
 *   fn(draft) -> draft
 *
 *   draft = {
 *     usernameField: HTMLInputElement|null,
 *     passwordField: HTMLInputElement|null,
 *     anchor:        HTMLInputElement|null,  // 用户实际交互的那个框（可空）
 *     context:       Object                  // 调用方透传的附加信息
 *   }
 *
 * 策略链按注册顺序依次 refine。任一策略抛错都会被吞掉，不影响填充主流程
 * （策略是增强，不能成为故障点）。
 *
 * ── 基线行为 ──────────────────────────────────────────
 * 未注册任何外部策略时，基线 = Hira 原版评分法（getBestUsernameField /
 * getBestPasswordField），并叠加内置的 `anchor-first` 策略：
 * 用户点了哪个框就优先填哪个框（NG 的钥匙按钮按字段触发，需要这个能力）。
 */

/**
 * 创建字段解析器实例。
 * @param {Object} scanner  fields.js 的扫描器（只读取，不修改其状态）
 * @returns {Object} 解析器 API
 */
interface FieldResolverScanner {
  getBestUsernameField(): HTMLInputElement | null
  getBestPasswordField(): HTMLInputElement | null
  isConnectedInput?(input: HTMLInputElement): boolean
  isPasswordLikeField(input: HTMLInputElement): boolean
  isUsernameLikeField(input: HTMLInputElement): boolean
  getAllPasswordFields?(): HTMLInputElement[]
  getAllUsernameFields?(): HTMLInputElement[]
}
interface FieldResolverContext { anchor?: HTMLInputElement | null; [key: string]: unknown }
interface FieldResolverDraft {
  usernameField: HTMLInputElement | null
  passwordField: HTMLInputElement | null
  anchor: HTMLInputElement | null
  context: FieldResolverContext
}
type FieldResolverStrategy = (draft: FieldResolverDraft) => FieldResolverDraft | null | undefined

function createFieldResolver(scanner: FieldResolverScanner) {
  const strategies: Array<{ name: string; fn: FieldResolverStrategy }> = []

  function registerStrategy(name: string, fn: FieldResolverStrategy): () => void {
    if (typeof fn !== 'function') return () => {}
    strategies.push({ name, fn })
    return function unregister() {
      unregisterStrategy(name)
    }
  }

  function unregisterStrategy(name: string): void {
    const i = strategies.findIndex((s) => s.name === name)
    if (i >= 0) strategies.splice(i, 1)
  }

  function listStrategies(): string[] {
    return strategies.map((s) => s.name)
  }

  /**
   * 基线解析：Hira 原版评分法，不做任何重试/补填。
   * 注意调用顺序与 Hira 一致 —— 先 username 再 password（username 解析会
   * 触发 refreshCache 并把 password 缓存一并填好）。
   */
  function resolveBaseline(context?: FieldResolverContext): FieldResolverDraft {
    return {
      usernameField: scanner.getBestUsernameField() || null,
      passwordField: scanner.getBestPasswordField() || null,
      anchor: (context && context.anchor) || null,
      context: context || {}
    }
  }

  /**
   * 解析本次填充目标。
   * @param {Object} [context]
   * @param {HTMLInputElement} [context.anchor] 用户实际交互的输入框（钥匙按钮锚点）
   * @returns {{usernameField:*, passwordField:*, anchor:*, context:Object}}
   */
  function resolve(context?: FieldResolverContext): FieldResolverDraft {
    let draft = resolveBaseline(context)
    for (const strategy of strategies) {
      try {
        const next = strategy.fn(draft)
        if (next && typeof next === 'object') draft = next
      } catch (_) {
        // 策略失败不应阻断填充
      }
    }
    return draft
  }

  // ── 内置策略：锚点优先 ──────────────────────────────
  // 用户点击钥匙按钮时，锚点就是他面前那个输入框。锚点仍然挂在文档里才生效，
  // 避免 Hira 场景下不存在的“缓存到已脱离文档的旧节点”问题。
  // 该策略可被 unregisterStrategy('anchor-first') 移除，恢复纯评分行为。
  registerStrategy('anchor-first', function anchorFirstStrategy(draft: FieldResolverDraft): FieldResolverDraft {
    const anchor = draft && draft.anchor
    if (!anchor) return draft
    if (typeof scanner.isConnectedInput === 'function' && !scanner.isConnectedInput(anchor)) {
      return draft
    }
    if (scanner.isPasswordLikeField(anchor)) draft.passwordField = anchor
    else if (scanner.isUsernameLikeField(anchor)) draft.usernameField = anchor
    return draft
  })

  // ── 内置策略：可见性优先 ────────────────────────────
  // Hira 的评分法只看 DOM 顺序，若页面里第一个 input[type=password] 是
  // 隐藏的诱饵框（不少站点有），凭据会填进看不见的框 → 表现为“填了没反应”。
  // 本策略只在当前选中项确实不可见时，才换成第一个可见候选；
  // 若当前项可见则完全不动，保证不偏离 Hira 基线行为。
  registerStrategy('prefer-visible', function preferVisibleStrategy(draft: FieldResolverDraft): FieldResolverDraft {
    upgradeToVisible(draft, 'passwordField', 'getAllPasswordFields')
    upgradeToVisible(draft, 'usernameField', 'getAllUsernameFields')
    return draft
  })

  function upgradeToVisible(
    draft: FieldResolverDraft,
    key: 'usernameField' | 'passwordField',
    listMethod: 'getAllUsernameFields' | 'getAllPasswordFields'
  ): void {
    const current = draft && draft[key]
    if (!current || isVisible(current)) return
    if (typeof scanner[listMethod] !== 'function') return
    let candidates: HTMLInputElement[] = []
    try {
      const list = scanner[listMethod]
      candidates = list ? list.call(scanner) || [] : []
    } catch (_) {
      return
    }
    const visible = candidates.find(isVisible)
    if (visible) draft[key] = visible
  }

  function isVisible(el: Element | null | undefined): boolean {
    try {
      if (!el || !el.getBoundingClientRect) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    } catch (_) {
      return false
    }
  }

  return {
    resolve,
    registerStrategy,
    unregisterStrategy,
    listStrategies
  }
}

export { createFieldResolver }
