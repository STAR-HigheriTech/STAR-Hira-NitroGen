/**
 * 标签组芯片的**右键菜单** —— 芯片最独特的资产：标签条自有的概念
 * （重命名 / 拆分 / 合并 / 配色），ui-common 的通用菜单表里没有它。
 *
 * 本模块只做「出题」：把状态翻译成菜单项、把被点中的动作**返回**出来。
 * 它**不改任何 DOM**、不认识行内重命名槽位、不认识装饰层 —— 点中 `renameStack`
 * 后由调用方（TabStack 装配器）接手开输入框，于是菜单可以独立替换（将来换成
 * ui-common 的通用菜单渲染也只需改这一个文件）。
 *
 * 为什么合并目标走**子菜单**而不是 prompt：旧实现在这里 `prompt('输入目标标签组 ID')`，
 * 而那串 uuid 用户根本看不到。列出同级标签组才是可用的做法。
 */

import { sameKind } from '@hira-ng/shared-types/src/tab-policy.mjs'
// 组名兜底 / 种类名词的唯一真源（与纵向组行、面板列表共用，不在此另抄一份）。
import { stackDisplayLabel, stackKindLabel } from '../tabStackActions'
import type { MenuItem, PopMenu } from '../menuTypes'

export interface StackMenuState {
  stackId?: string | number | null
  pinned?: boolean
  label?: unknown
  children?: readonly unknown[]
  [key: string]: unknown
}

export interface StackMenuSibling extends StackMenuState {
  stackId: string | number
}

export interface StackChipMenuContext {
  showMenu?: PopMenu | null
  getSiblings?: () => readonly StackMenuSibling[]
}

export interface StackMenuHandlers {
  dissolveStack?: (stackId: string) => unknown
  tileStack?: (stackId: string, tabIds: unknown[]) => unknown
  merge?: (sourceStackId: string, targetStackId: string) => unknown
  setColor?: (stackId: string, accent: string) => unknown
}

export interface StackMenuClient {
  dissolveStack?: (stackId: string) => Promise<unknown> | unknown
  createSplit?: (input: { tabIds: unknown[] }) => Promise<unknown> | unknown
  mergeStacks?: (sourceStackId: string, targetStackId: string) => Promise<unknown> | unknown
  setStackColor?: (stackId: string, accent: string) => Promise<unknown> | unknown
}

/** 配色动作 → 强调色（与旧实现逐字一致）。 */
export const STACK_COLOR_BY_ACTION = {
  stackColorBlue: '#1a73e8',
  stackColorPurple: '#9334e6',
  stackColorOrange: '#e8710a'
}

export const ACTION_RENAME_STACK = 'renameStack'
/**
 * 解散标签组：**整组恢复正常**（成员全部回到散标签状态，组元数据一并删掉）。
 *
 * 为什么要有它、且**取代**了原来的「拆分标签组」：那一项把**全部**成员迁到一个换过 id 的
 * 新栈里（label / accent / collapsed 全部继承）—— 外观与行为一字不变，用户点完的感受就是
 * **"点了没反应"**。而它本来的语义（拆出**部分**成员另起一组）在菜单里没有任何选择成员的
 * 入口，永远走不到。于是这里只留一个语义确定、结果可见的动作。
 */
export const ACTION_DISSOLVE_STACK = 'dissolveStack'
/** 标签组 → 分屏（I4 的可逆投影之一）：把整组平铺成并排的格。 */
export const ACTION_TILE_STACK = 'tileStack'
export const MERGE_ACTION_PREFIX = 'merge:'

/**
 * @param {{
 *   showMenu?: Function,
 *   getSiblings?: () => readonly StackMenuSibling[]
 * }} ctx
 * @returns {(x: number, y: number, state: StackMenuState) => Promise<string|null>}
 */
export function createStackChipMenu(ctx: StackChipMenuContext = {}) : (x: number, y: number, state: StackMenuState) => Promise<string|null> {
  const showMenu = ctx.showMenu
  const getSiblings = typeof ctx.getSiblings === 'function' ? ctx.getSiblings : () => []

  /**
   * 弹出某标签组的右键菜单。
   * @returns {Promise<string|null>} 被点中的动作字符串
   */
  return async (x: number, y: number, state: StackMenuState): Promise<string | null> => {
    if (typeof showMenu !== 'function') return null
    const selfId = state && state.stackId != null ? String(state.stackId) : ''
    const children = Array.isArray(state.children) ? state.children : []
    // 固定分组（Zen Essentials）：成员恒为固定标签、整组常驻，与"分屏"互斥（进组即退分屏），
    // 所以「平铺成分屏」对它一律不出现 —— 出现也只能点了被拒。
    const pinned = !!state.pinned
    // 「除自己以外」+「同种类」的过滤**在这里做**（不在宿主）：它是菜单自身的不变式 ——
    // 把"我合并到我自己"列出来是个明显的坏项，而宿主很容易漏（纵向列表曾整份列出）。
    // 种类裁决走 tab-policy：固定文件夹只能并入固定文件夹，普通组只能并入普通组
    //（引擎会拒绝跨种类），菜单提前筛掉才不至于"点了没反应"。
    const selfKind = { pinned }
    const siblings = (getSiblings() || []).filter(
      (s) => s && s.stackId != null && String(s.stackId) !== selfId && sameKind(s, selfKind)
    )
    const noun = stackKindLabel(pinned)
    // 合并目标用子菜单列出「其它标签组」（固定组按用户起的名字 / 兜底名显示，不露出 uuid）
    const submenu = siblings.length
      ? siblings.map((s) => ({ label: stackDisplayLabel(s), action: `${MERGE_ACTION_PREFIX}${s.stackId}` }))
      : [{ label: `（没有其它${noun}）`, enabled: false }]
    return showMenu({
      x,
      y,
      items: [
        { label: `重命名${noun}`, action: ACTION_RENAME_STACK },
        { label: `解散${noun}`, action: ACTION_DISSOLVE_STACK },
        // 平铺成分屏：与「收拢为标签组」互为逆操作（分屏里那一项在标签右键菜单）。
        // 上限 4 与分屏硬上限同源 —— 超了就不出现，而不是点了被拒。
        { label: '平铺成分屏', action: ACTION_TILE_STACK, visible: !pinned, enabled: children.length >= 2 && children.length <= 4 },
        { label: pinned ? '合并到…' : `合并${noun}`, enabled: siblings.length > 0, submenu },
        { type: 'separator' },
        { label: '蓝色', action: 'stackColorBlue' },
        { label: '紫色', action: 'stackColorPurple' },
        { label: '橙色', action: 'stackColorOrange' }
      ] as MenuItem[]
    })
  }
}

/** `runStackMenuAction` 的返回值：这次是"请宿主开行内重命名"。 */
export const STACK_MENU_RENAME = 'rename'

/**
 * **动作分派**（模板与分派同住一个文件，两端一行接通）。
 *
 * 菜单只有两个消费者（横向芯片 `TabStack.js`、纵向组行 `tabRowList.ts`），而它们的
 * DOM 结构完全不同 —— 唯一必须各自实现的是"开行内输入框"（重命名槽位挂在各自的节点上）。
 * 其余四个动作（解散 / 平铺 / 合并 / 配色）**一个字符都不该在两端各写一遍**：
 * 上一版就是两端各写一份分派，横向有"拆分标签组"（点了没反应的那个坏项）、纵向也有，
 * 改一处漏一处。这里把分派收成一份，两端只剩：
 *
 *     const outcome = runStackMenuAction(action, stack, stackMenu)
 *     if (outcome === STACK_MENU_RENAME) startRename(rowOrChip, ...)
 *
 * @param {string|null} action 菜单返回的动作名
 * @param {{ stackId: string, children?: string[] }} stack 该组的当前态
 * @param {{ dissolveStack?: Function, tileStack?: Function, merge?: Function, setColor?: Function }} handlers
 *   由宿主注入（apps 层的 `createStackMenuHandlers(tabsClient)`）；缺哪个就跳过哪个。
 * @returns {'rename'|'handled'|null} `'rename'` = 调用方接手开输入框；null = 不认识的动作
 */
export function runStackMenuAction(
  action: string | null | undefined,
  stack: StackMenuState | null | undefined,
  handlers: StackMenuHandlers = {}
): 'rename' | 'handled' | null {
  const id = action == null ? '' : String(action)
  if (!id) return null
  if (id === ACTION_RENAME_STACK) return STACK_MENU_RENAME
  const stackId = stack && stack.stackId != null ? String(stack.stackId) : ''
  if (!stackId) return null
  const children = stack && Array.isArray(stack.children) ? stack.children.slice() : []
  if (id === ACTION_DISSOLVE_STACK) {
    if (typeof handlers.dissolveStack === 'function') handlers.dissolveStack(stackId)
    return 'handled'
  }
  if (id === ACTION_TILE_STACK) {
    // 固定文件夹不能平铺成分屏（真源 tab-policy#canSplit）—— 菜单已隐藏该项，
    // 这里再拦一道：动作字符串可能来自别的调用方（快捷键 / 旧菜单缓存）。
    if (stack?.pinned) return 'handled'
    if (children.length >= 2 && typeof handlers.tileStack === 'function') handlers.tileStack(stackId, children)
    return 'handled'
  }
  if (id.startsWith(MERGE_ACTION_PREFIX)) {
    const targetStackId = id.slice(MERGE_ACTION_PREFIX.length)
    if (targetStackId && typeof handlers.merge === 'function') handlers.merge(stackId, targetStackId)
    return 'handled'
  }
  const accent = STACK_COLOR_BY_ACTION[id as keyof typeof STACK_COLOR_BY_ACTION]
  if (accent) {
    if (typeof handlers.setColor === 'function') handlers.setColor(stackId, accent)
    return 'handled'
  }
  return null
}

/**
 * 标签组动作的**唯一动作表** —— 把上面四个动作落到具体的标签客户端调用上。
 *
 * 为什么住在 ui-common（而不是某个宿主里）：这张表的两个消费者一个是"ui 包内的纵向列表"
 * （`tabRowList` 由 `tabListHost` 装配，自己握着 tabsClient），另一个是"ui 包外的横向标签条"
 * （`ui-tabbar` 不认识 tabsClient，只能由宿主把整包注入）。放在这里，两边取的是**同一份**；
 * 放任意一边都会让另一边各抄一遍（这正是「拆分标签组」在两端同时写坏的原因）。
 *
 * @param {{ dissolveStack: Function, createSplit: Function, mergeStacks: Function, setStackColor: Function }} tabsClient
 * @returns {{ dissolveStack: Function, tileStack: Function, merge: Function, setColor: Function }}
 */
export function createStackMenuHandlers(tabsClient?: StackMenuClient | null): Required<StackMenuHandlers> {
  const client = tabsClient || {}
  /** 落库失败（组已被合走 / 标签已销毁）不冒泡成未处理的 Promise 拒绝。 */
  const fire = (request: unknown): unknown => {
    if (request && typeof (request as { catch?: unknown }).catch === 'function') {
      ;(request as { catch: (handler: () => void) => unknown }).catch(() => {})
    }
    return request
  }
  return {
    /** 解散标签组：成员全部回到散标签。 */
    dissolveStack: (stackId: string) => fire(typeof client.dissolveStack === 'function' ? client.dissolveStack(String(stackId)) : null),
    /** 平铺成分屏：整组并排成格，格序 = 组内顺序（与「收拢为标签组」互为逆操作）。 */
    tileStack: (stackId: string, tabIds: unknown[]) => fire(typeof client.createSplit === 'function' ? client.createSplit({ tabIds }) : null),
    /** 合并到另一个标签组。 */
    merge: (sourceStackId: string, targetStackId: string) => fire(typeof client.mergeStacks === 'function' ? client.mergeStacks(String(sourceStackId), String(targetStackId)) : null),
    /** 改配色。 */
    setColor: (stackId: string, accent: string) => fire(typeof client.setStackColor === 'function' ? client.setStackColor(String(stackId), String(accent)) : null)
  }
}
