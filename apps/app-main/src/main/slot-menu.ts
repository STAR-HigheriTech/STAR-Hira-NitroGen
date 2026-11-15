/**
 * 插槽 → 原生菜单项 适配器。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 解决什么问题
 * ══════════════════════════════════════════════════════════════════════
 * 官方插槽里有一批是「往菜单里加一项」（`bookmark.context-menu` / `webview.context-menu.item`）。
 * 插槽实现跑在**主进程**，而菜单也是主进程弹的 —— 于是有一个关键设计选择：
 *
 *   ❌ 让实现返回描述符、过 IPC 到渲染层、渲染层再拼进它自己的菜单、点击后再回传 action。
 *      代价：一轮多余往返 + 函数无法序列化 + 每个菜单都得自己实现一遍"怎么把描述符变菜单项"。
 *
 *   ✅ 主进程自己把描述符编译成**原生菜单项**，并把实现的 `onSelect` 闭包直接挂在 click 上。
 *      代价：零。菜单本来就是主进程弹的，实现本来就在主进程里 —— 中间那一趟 IPC 纯属自找麻烦。
 *
 * 本文件就是上面 ✅ 那一步的**唯一实现**。所有菜单类插槽共用它，
 * 于是「插槽贡献的菜单项长什么样、点了怎么派发、坏实现怎么办」只有一处定义。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 实现契约（写给插件作者）
 * ══════════════════════════════════════════════════════════════════════
 * `impl(payload, ctx)` 返回**描述符**或**描述符数组**：
 *
 *   { label: '翻译此页', enabled?: true, accelerator?: 'Ctrl+T', onSelect?: (payload) => void }
 *   { type: 'separator' }        // 分段
 *
 * · 返回数组是推荐写法：一个插件常常想加 2~3 项，不必为每项单独注册一次实现。
 * · `onSelect` 可选但强烈建议给：**没有 onSelect 的项会被丢弃**（不显示），
 *   因为一个点了没反应的菜单项比没有这一项更糟。丢弃时会告警，便于作者发现。
 * · 返回的数组顺序即菜单中的顺序；多项请自行插 separator 分段。
 *
 * ⚠ 为什么要有「展平一层」这一步：MULTI 模式把**每个实现的返回值**收成一个数组，
 * 于是「一个实现返回数组」会自然得到嵌套结构（`[[项, 项]]`）。菜单场景下这是常态而非
 * 例外，所以在适配器里统一展平一层 —— 否则插件作者必须知道调度器的聚合细节，
 * 而那正是他们不该关心的事。
 */

/**
 * @param {{
 *   extensionPoints?: { callSync: Function, isDefined?: Function },
 *   logger?: { warn?: Function, error?: Function }
 * }} [options]
 */
interface SlotMenuOptions {
  extensionPoints?: { callSync: (slotId: string, payload: unknown) => unknown; isDefined?: (slotId: string) => boolean }
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
}

interface SlotMenuDescriptor { type?: string; label?: string; enabled?: boolean; accelerator?: string; onSelect?: (payload: unknown) => void }
interface NativeSlotMenuItem { type?: string; label?: string; enabled?: boolean; accelerator?: string; click?: () => void }

function createSlotMenuAdapter (options: SlotMenuOptions = {}) {
  const logger = options.logger || console
  const extensionPoints = options.extensionPoints
  const noop = () => []

  if (!extensionPoints || typeof extensionPoints.callSync !== 'function') {
    // 未接调度器（快照/测试路径）：静默返回空 —— 菜单少几项，但绝不因此崩掉整个右键菜单。
    return { items: noop }
  }
  const points = extensionPoints

  /**
   * 执行菜单类插槽并把结果编译成原生菜单项。
   *
   * 用 `callSync` 而不是 `call`：菜单模板必须在**同一个 tick 内**建好
   * （原生 `Menu.buildFromTemplate` 是同步 API）。调度器会把「在同步插槽里返回 Promise」
   * 判为致命错误并抛出 —— 这里捕获后降级为「没有插件项」，因为一个插件的写法错误
   * 不该让用户连"复制链接"都用不了。
   *
   * @param {string} slotId
   * @param {object} payload 传给插槽的纯数据快照
   * @returns {Array<object>} Electron 菜单项（含 click）
   */
  function items (slotId: string, payload: unknown): NativeSlotMenuItem[] {
    if (typeof points.isDefined === 'function' && !points.isDefined(slotId)) return []
    let raw
    try {
      raw = points.callSync(slotId, payload)
    } catch (error) {
      logger.warn?.(`[slot-menu] 插槽 ${slotId} 执行失败（已跳过全部插件项）：`, error instanceof Error ? error.message : error)
      return []
    }
    return compile(raw, slotId, payload, logger)
  }

  return { items }
}

/** 描述符 → Electron 菜单项。非法的项一律丢弃并告警，绝不把 undefined 塞进模板。 */
function compile (raw: unknown, slotId: string, payload: unknown, logger: { warn?: (...args: unknown[]) => void }): NativeSlotMenuItem[] {
  // 展平一层：MULTI 把每个实现的返回值收成数组，实现自己也返回数组时会得到嵌套结构
  // （见文件头 ⚠ 说明）。`flat(1)` 之后「一个实现一项」与「一个实现多项」写法统一。
  const list = Array.isArray(raw) ? raw.flat(1) : []
  const out: NativeSlotMenuItem[] = []
  for (const d of list) {
    if (!d || typeof d !== 'object') continue
    if (d.type === 'separator') {
      out.push({ type: 'separator' })
      continue
    }
    const label = typeof d.label === 'string' ? d.label.trim() : ''
    if (!label) {
      if (logger.warn) logger.warn(`[slot-menu] 插槽 ${slotId} 返回了没有 label 的项，已丢弃`)
      continue
    }
    const onSelect = typeof d.onSelect === 'function' ? d.onSelect : null
    if (!onSelect) {
      if (logger.warn) logger.warn(`[slot-menu] 插槽 ${slotId} 的「${label}」缺少 onSelect，已丢弃（点了不会有反应）`)
      continue
    }
    const item: NativeSlotMenuItem = { label, enabled: d.enabled !== false }
    if (d.accelerator) item.accelerator = String(d.accelerator)
    item.click = () => {
      // 单击失败只影响这一次点击：一条 try/catch 换来「一个坏 Mod 不会让菜单后续项失灵」。
      try {
        onSelect(payload)
      } catch (error) {
        logger.warn?.(`[slot-menu] 插槽 ${slotId} 的「${label}」执行失败：`, error instanceof Error ? error.message : error)
      }
    }
    out.push(item)
  }
  return out
}

module.exports = { createSlotMenuAdapter }
