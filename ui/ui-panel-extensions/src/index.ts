// @ts-check
/**
 * @hira-ng/ui-panel-extensions —— 扩展侧边面板
 *
 * 哑组件：状态上行 setItems() / setNotice()，意图下行 onIntent。
 * 能力（与内部页 hira://extensions 同能力，只是更紧凑）：
 *   - 搜索（按名称本地过滤，零 IPC、输入即筛）
 *   - 开关：启用 / 停用（role=switch）
 *   - 打开扩展自己的设置页（options）
 *   - 打开扩展的弹出窗口（popup）
 *   - 详情：名称 / 版本 / 来源（商店 / 本地）/ 大小（按需取，见下）/ 描述 /
 *     权限清单（中文）/ 扩展 ID / 路径
 *   - 检查视图（仅开发者模式下发该字段）：点击在开发者工具里打开扩展的后台上下文
 *   - 在标签页里打开商店详情页
 *   - 移除（卸载）
 *   - 导入已解压扩展 / 浏览 Chrome 网上应用店 / 打开扩展管理页（均在新标签页）
 *
 * 能力判据全部来自主进程下发的列表项（hasOptionsPage / hasPopup / storeUrl），
 * 本组件**不做任何扩展语义推导** —— 没有设置页 / 弹窗的扩展，按钮直接置灰并给出中文原因，
 * 而不是让用户点一下再失败（老 Hira 是点了才弹「该扩展未提供弹窗」）。
 *
 * 关于 popup 定位：本组件上报被点按钮的 **视图内**矩形（getBoundingClientRect），
 * 但**不做任何坐标系换算** —— 面板是一个独立的 WebContentsView，其视图内坐标与主进程
 * 锚定弹窗用的「窗口内容区」差一个视图偏移，而这个偏移只有主进程查得到（按发送方
 * webContents 反查视图落点）。因此链路是：组件只报视图内矩形 → 主进程补偏移 →
 * 弹窗贴着按钮下方展开（越界时由弹窗按显示器 workArea 夹边）。组件因此保持「哑」：
 * 它不认识偏移量，也不关心面板在窗口里的落点。内部管理页是整窗页面，
 * 坐标系同一，那边上报的矩形可直接用（主进程查不到偏移，自然原样透传）。
 *
 * 关于「大小」：目录大小是磁盘递归操作，不能随每次列表刷新对每个扩展算一遍。
 * 本组件只在用户**展开详情**且该项还没有 size 时，向编排层发一次
 * `{ type: 'request-size', id }`；编排层取回后重推列表，展开态保持不变，
 * 详情自然带上大小。取不到（目录不存在 / 无权限 / 已停用且原目录被删）就不显示
 * 这一行 —— 绝不显示假的 `0 B`。
 */

import type { PanelDefinition, PanelContext } from '@hira-ng/ui-common'
import {
  injectPanelStyles,
  openUrlPreferExistingTab,
  createFaviconBadge,
  FolderPlus,
  Puzzle,
  Settings,
  Pin,
  PanelTop,
  RefreshCw,
  ExternalLink,
  Info,
  ChevronDown,
  Trash2,
  Search
} from '@hira-ng/ui-common'
import { extensionStatusLabel } from '@hira-ng/shared-types/src/extension-labels.mjs'
// 内部页地址的唯一拼法（真源 pages.mjs）—— 面板不手写 `hira://extensions`。
import { pageUrl } from '@hira-ng/shared-types/src/pages.mjs'

const STYLE_ID = 'hira-panel-extensions-styles'

interface ExtensionInspectView {
  target?: string
  label?: string
  url?: string
  inspectable?: boolean
  note?: string
}

interface ExtensionView {
  id: string
  name?: string
  version?: string
  source?: string
  size?: string
  description?: string
  path?: string
  permissions?: string[]
  inspectViews?: ExtensionInspectView[]
  enabled?: boolean
  runtimeStatus?: string
  isV3?: boolean
  hasOptionsPage?: boolean
  hasPopup?: boolean
  storeUrl?: string
  pinned?: boolean
  iconDataUrl?: string
  iconUrl?: string
  iconPath?: string
  loadError?: unknown
  [key: string]: unknown
}

interface ExtensionAnchorRect { x: number; y: number; width: number; height: number }

interface ExtensionIntent {
  type: string
  id?: string
  target?: string
  enabled?: boolean
  pinned?: boolean
  anchorRect?: ExtensionAnchorRect | null
}

type IconFactory = (doc: Document, opts?: { size?: number }) => Element

interface IconActionOptions {
  label: string
  disabled?: boolean
  title?: string
  danger?: boolean
  quiet?: boolean
  active?: boolean
}

interface ExtensionActionResult {
  ok?: boolean
  canceled?: boolean
  size?: string
  [key: string]: unknown
}

interface ExtensionsClientPort {
  list(opts?: Record<string, unknown>): Promise<ExtensionView[]>
  importFolder(): Promise<ExtensionActionResult>
  reload(id: string): Promise<ExtensionActionResult>
  openOptions(id: string): Promise<ExtensionActionResult>
  openPopup(id: string, opts?: { anchorRect?: ExtensionAnchorRect }): Promise<ExtensionActionResult>
  openStore(id: string): Promise<ExtensionActionResult>
  inspectView(id: string, target: string): Promise<ExtensionActionResult>
  uninstall(id: string): Promise<ExtensionActionResult>
  toggle(id: string, enabled: boolean): Promise<ExtensionActionResult>
  setPinned(id: string, pinned: boolean): Promise<ExtensionActionResult>
  onChanged(listener: (payload: unknown) => void): () => void
}

interface ExtensionTabsPort {
  newTab(input?: { url?: string }): Promise<unknown>
}

type ExtensionsPanelContext = Omit<PanelContext, 'onIntent' | 'clients' | 'confirm'> & {
  onIntent?: (intent: ExtensionIntent) => void
  clients?: (PanelContext['clients'] & {
    extensions?: ExtensionsClientPort
    tabs?: ExtensionTabsPort
  }) | null
  confirm?: (options: { title?: string; message?: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean> | boolean
}

/**
 * 元素在**本视图内**的矩形（对齐内部页 pages/extensions 的 rectOf）。
 * 拿不到（元素已卸载 / 极端时序）返回 null → 调用方退到默认锚点，绝不抛错。
 * @param {HTMLElement|null} node
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function rectOf(node: Element | null): ExtensionAnchorRect | null {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null
  try {
    const r = node.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  } catch (_) {
    return null
  }
}

export function injectExtensionsPanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  injectPanelStyles(doc)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .extensions-panel__wrap { display: flex; flex-direction: column; height: 100%; }
    .extensions-panel__toolbar {
      display: flex; flex-direction: column; gap: 8px;
      padding: 0 0 8px; margin-bottom: 2px;
      flex-shrink: 0;
    }
    .extensions-panel__search {
      display: flex; align-items: center; gap: 8px;
      height: var(--hira-control-height, 32px); padding: 0 12px;
      border-radius: var(--hira-radius-md, 10px);
      background: var(--hira-field-bg, rgba(0,0,0,0.04));
      border: 0;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  box-shadow var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .extensions-panel__search:focus-within { background: var(--hira-field-bg-focus, rgba(0,0,0,0.05)); box-shadow: var(--hira-focus-ring); }
    .extensions-panel__search input {
      flex: 1; min-width: 0; border: none; outline: none; background: transparent;
      color: var(--hira-text-primary, #1a1a1a); font-size: 12px; padding: 0;
    }
    .extensions-panel__search input::placeholder { color: var(--hira-text-tertiary, #8b8b8b); }
    /* 工具条动作：**纯图标方键**，文字只留在 title / aria-label 里 */
    .extensions-panel__actions { display: flex; gap: 2px; align-items: center; flex-wrap: wrap; }
    .extensions-panel__actions button {
      border: 0; background: transparent; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: var(--hira-control-height, 36px); height: var(--hira-control-height, 36px); padding: 0;
      border-radius: var(--hira-radius-sm, 8px);
      cursor: pointer;
      color: var(--hira-text-secondary, #6b7280);
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .extensions-panel__actions button:hover:not(:disabled) { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.05)); }
    .extensions-panel__notice {
      margin: 0 0 10px; padding: 10px 12px; border-radius: var(--hira-radius-md, 10px); font-size: 11px; line-height: 17px;
      background: var(--hira-surface-soft, rgba(0,0,0,0.04)); color: var(--hira-text-secondary, #6b7280);
    }
    .extensions-panel__notice--error { background: var(--hira-danger-bg, rgba(220,38,38,0.08)); color: var(--hira-danger, #dc2626); }
    .extensions-panel__notice[hidden] { display: none; }
    /* ⚠ min-height: 0 是滚动的前提（见 downloads 面板同一处注释）：
       缺它时 flex column 的子项按内容高度撑开，溢出被 #root 裁掉、滚轮无效。 */
    .extensions-panel__list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 0 0 8px; }
    /* 扩展行：**无框**软面行 —— 一条描边卡会把"一行信息"抬成"一张卡片"，密度就上去了。
       行内只留三件事：图标 / 名称 / 开关；其余动作全部图标化并降为次级对比。 */
    .extensions-panel__row {
      display: flex; flex-direction: column; gap: 6px;
      padding: 10px;
      border: 0;
      border-radius: var(--hira-radius-md, 10px);
      background: transparent;
      transition: background var(--hira-dur-base, 180ms) var(--hira-ease-standard, ease); contain: layout style;
    }
    .extensions-panel__row:hover {
      background: var(--hira-hover-bg, rgba(0,0,0,0.045));
    }
    .extensions-panel__row--disabled .extensions-panel__label { opacity: 0.6; }
    .extensions-panel__top { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .extensions-panel__label {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12.5px; line-height: 18px; font-weight: 500; color: var(--hira-text-primary, #1a1a1a);
    }
    .extensions-panel__status {
      flex: 0 0 auto; font-size: 10.5px; color: var(--hira-text-tertiary, #8b8b8b);
    }
    .extensions-panel__status--error { color: var(--hira-danger, #dc2626); }
    /* 加载失败原因行：与 meta 行同缩进，危险色、可折行（原因可能很长） */
    .extensions-panel__error {
      padding-left: 28px; font-size: 10.5px; color: var(--hira-danger, #dc2626);
      line-height: 1.6; word-break: break-word;
    }
    /* 元信息行：版本 / MV / 来源 / 运行状态 —— 一条小字，与图标左缘对齐 */
    .extensions-panel__meta {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      padding-left: 28px; font-size: 10.5px; line-height: 16px; color: var(--hira-text-tertiary, #8b8b8b);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 动作行：清一色图标按钮（28px 见方），互相只隔 2px —— 一排方块的节奏本身就是分隔 */
    .extensions-panel__buttons { display: flex; align-items: center; gap: 2px; padding-left: 28px; }
    .extensions-panel__buttons button {
      width: 28px; height: 28px; padding: 0; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; background: transparent;
      border-radius: var(--hira-radius-sm, 8px);
      color: var(--hira-text-tertiary, #8b8b8b); cursor: pointer;
      transition: color var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease),
                  opacity var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .extensions-panel__buttons button:hover:not(:disabled) { color: var(--hira-text-primary, #1a1a1a); background: var(--hira-surface-soft, rgba(0,0,0,0.06)); }
    .extensions-panel__buttons button:disabled { opacity: 0.3; cursor: default; }
    .extensions-panel__buttons .extensions-panel__danger:hover:not(:disabled) { color: var(--hira-danger, #dc2626); background: var(--hira-danger-bg, rgba(220,38,38,0.08)); }
    /* 低频动作（商店 / 详情 / 移除）：默认淡出，hover 或键盘聚焦到行内时提亮 ——
       这样一屏里"看见的字"只剩名称与一条小字，第一眼不再被一排按钮压满。 */
    .extensions-panel__buttons .is-quiet { opacity: 0; }
    .extensions-panel__row:hover .extensions-panel__buttons .is-quiet,
    .extensions-panel__row:focus-within .extensions-panel__buttons .is-quiet { opacity: 1; }
    /* 已激活的动作（当前固定）：图标换 accent 色 + 软底 —— 一眼可辨，不再是灰按钮 */
    .extensions-panel__buttons .is-active,
    .extensions-panel__buttons .is-active:hover:not(:disabled) {
      color: var(--hira-accent, #3b82f6); background: var(--hira-accent-soft, rgba(59,130,246,0.14));
    }
    /* 详情块：软底嵌入式，不描边（它在行内部，已经是第二层，再加线就是三层）。
       标签列固定宽度 → 所有值垂直对齐，扫读时不再是一段段"标签: 值"的散句。 */
    .extensions-panel__detail {
      padding: 10px; margin-left: 28px; border-radius: var(--hira-radius-md, 10px);
      border: 0;
      background: var(--hira-surface-soft, rgba(0,0,0,0.035));
      display: flex; flex-direction: column; gap: 8px;
    }
    .extensions-panel__detailLine { display: flex; gap: 10px; font-size: 11px; line-height: 18px; }
    .extensions-panel__detailLabel { flex: 0 0 44px; color: var(--hira-text-tertiary, #8b8b8b); }
    .extensions-panel__detailValue { flex: 1; min-width: 0; color: var(--hira-text-secondary, #6b7280); word-break: break-all; }
    .extensions-panel__perms { margin: 0; padding-left: 14px; color: var(--hira-text-secondary, #6b7280); }
    .extensions-panel__perms li { word-break: break-word; }
    /* 检查视图（只有主进程下发了 inspectViews 时才出现）：
       可调试的是下划线式小按钮，底层没有开发者工具入口的是划线静态文本 ——
       两者外观刻意不同，「能调」与「只能看」一眼可辨。 */
    .extensions-panel__inspect { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .extensions-panel__inspectItem { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .extensions-panel__inspectItem button {
      align-self: flex-start; padding: 0; border: none; background: none;
      color: var(--hira-accent, #3b82f6); font-size: 11px; line-height: 16px;
      text-decoration: underline; cursor: pointer;
    }
    .extensions-panel__inspectStatic {
      align-self: flex-start; font-size: 11px; line-height: 16px;
      color: var(--hira-text-tertiary, #8b8b8b); text-decoration: line-through;
    }
    .extensions-panel__inspectUrl { font-size: 10.5px; line-height: 15px; color: var(--hira-text-tertiary, #8b8b8b); word-break: break-all; }
    .extensions-panel__inspectNote { font-size: 11px; color: var(--hira-text-tertiary, #8b8b8b); line-height: 1.55; }
    /* 启用开关（role=switch）：轨道 + 滑块，跟手靠 background/transform 的短过渡 */
    .extensions-panel__switch {
      margin-left: auto; flex: 0 0 auto;
      width: 32px; height: 18px; padding: 0; border: none; border-radius: 999px;
      background: var(--hira-switch-off, var(--hira-track-bg, rgba(0,0,0,0.16))); position: relative; cursor: pointer;
      transition: background var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .extensions-panel__switch::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%; background: var(--hira-surface, #fff);
      box-shadow: 0 1px 2px rgba(0,0,0,0.18);
      transition: transform var(--hira-dur-fast, 120ms) var(--hira-ease-standard, ease);
    }
    .extensions-panel__switch[aria-checked='true'] { background: var(--hira-accent, #3b82f6); }
    .extensions-panel__switch[aria-checked='true']::after { transform: translateX(14px); }
    .extensions-panel__empty {
      padding: 48px 20px; text-align: center;
      color: var(--hira-text-tertiary, #8b8b8b); font-size: 12px; line-height: 19px;
    }
  `
  doc.head.appendChild(style)
}

/**
 * @param {Document} doc
 * @param {ExtensionsPanelContext} [ctx]
 * @returns {{ element: HTMLDivElement, setItems: (items: readonly ExtensionView[]) => void, setNotice: (text?: string, kind?: 'info'|'error') => void }}
 */
export function createExtensionsPanel(doc: Document, ctx: PanelContext = {}) : { element: HTMLDivElement, setItems: (items: readonly ExtensionView[]) => void, setNotice: (text?: string, kind?: 'info'|'error') => void } {
  const panelCtx = ctx as ExtensionsPanelContext
  const onIntent = typeof panelCtx.onIntent === 'function' ? panelCtx.onIntent : () => {}
  const wrap = doc.createElement('div')
  wrap.className = 'extensions-panel__wrap'

  // ── 工具栏：搜索 + 导入 / 管理页 ──
  const toolbar = doc.createElement('div')
  toolbar.className = 'extensions-panel__toolbar'

  const searchBox = doc.createElement('div')
  searchBox.className = 'extensions-panel__search'
  const searchIcon = doc.createElement('span')
  searchIcon.style.cssText = 'display:flex; align-items:center; color: var(--hira-text-tertiary,#8b8b8b); flex-shrink:0;'
  searchIcon.appendChild(Search(doc, { size: 15 }))
  const searchInput = doc.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '搜索扩展'
  searchBox.append(searchIcon, searchInput)

  const actions = doc.createElement('div')
  actions.className = 'extensions-panel__actions'
  const importBtn = doc.createElement('button')
  importBtn.appendChild(FolderPlus(doc, { size: 16 }))
  importBtn.title = '导入扩展（加载一个已解压的扩展文件夹）'
  importBtn.setAttribute('aria-label', importBtn.title)
  importBtn.addEventListener('click', () => onIntent({ type: 'import' }))
  const manageBtn = doc.createElement('button')
  manageBtn.appendChild(Settings(doc, { size: 16 }))
  manageBtn.title = '在标签页中打开扩展管理页面'
  manageBtn.setAttribute('aria-label', manageBtn.title)
  manageBtn.addEventListener('click', () => onIntent({ type: 'open-manager' }))
  // 「应用店」：开店是**外部 URL 的新标签页**动作。
  // 面板不是标签页 —— 标签的 setWindowOpenHandler 只挂在标签 webContents 上，
  // 面板里写 `<a target="_blank">` 没有那条链路兜着；而面板本身是哑组件，
  // 不认识地址、也不该认识。因此这里只上报一个语义意图，由编排层用既有的
  // 标签通道开新标签（不新增 IPC 通道）。
  const storeBtn = doc.createElement('button')
  storeBtn.appendChild(Puzzle(doc, { size: 16 }))
  storeBtn.title = '在标签页中打开 Chrome 网上应用店，浏览并安装扩展'
  storeBtn.setAttribute('aria-label', storeBtn.title)
  storeBtn.addEventListener('click', () => onIntent({ type: 'open-web-store' }))
  actions.append(importBtn, storeBtn, manageBtn)

  toolbar.append(searchBox, actions)
  wrap.appendChild(toolbar)

  // 状态行（加载失败 / 动作失败的提示；空文本即隐藏，不占位）
  const notice = doc.createElement('div')
  notice.className = 'extensions-panel__notice'
  notice.hidden = true
  wrap.appendChild(notice)

  const list = doc.createElement('div')
  list.className = 'extensions-panel__list'
  wrap.appendChild(list)

  let items: ExtensionView[] = []
  let query = ''
  /** 详情展开的是哪一项（同一时刻只展开一项，列表更稳、更好扫）。 */
  let expandedId: string | null = null

  // 搜索是**本地过滤**：面板拿到的就是全量列表，输入即筛，不必往返主进程
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase()
    render()
  })

  // 事件委托：一个监听覆盖全部行，行数变化不重挂监听
  list.addEventListener('click', (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const btn = target?.closest<HTMLElement>('[data-action]')
    if (!btn) return
    e.stopPropagation()
    const action = btn.getAttribute('data-action')
    const id = btn.getAttribute('data-id') || ''
    if (action === 'toggle') {
      const enabled = btn.getAttribute('aria-checked') === 'true'
      // 先就地翻转开关（乐观点，只为「点下去立刻有反馈」），再上报意图。
      // 只碰被点的这一行：**不重排、不重建列表** —— 排序由主进程的永久顺序位
      // 决定，开关与位置彻底解耦；真值以随后的 extension:changed 对账为准。
      applyToggleVisual(btn, !enabled, id)
      onIntent({ type: 'toggle', id, enabled: !enabled })
    } else if (action === 'pin') {
      // 目标态从按钮上取（`data-pinned` 是当前态）：纯视图态，无本地乐观更新 ——
      // 主进程落盘成功后会推 extension:changed，列表随即对账。
      onIntent({ type: 'pin', id, pinned: btn.getAttribute('data-pinned') !== 'true' })
    } else if (action === 'open-options') {
      onIntent({ type: 'open-options', id })
    } else if (action === 'open-popup') {
      // 上报被点按钮的**视图内**矩形；视图偏移由主进程按发送方 webContents 补
      // （见文件头「关于 popup 定位」）—— 组件不认识偏移，也不该认识。
      onIntent({ type: 'open-popup', id, anchorRect: rectOf(btn) })
    } else if (action === 'open-store') {
      onIntent({ type: 'open-store', id })
    } else if (action === 'inspect-view') {
      // target 由**主进程下发的列表项**原样回传（data-target）：面板不认识视图类型，
      // 只负责把「用户点了哪一条」如实上报。
      onIntent({ type: 'inspect-view', id, target: btn.getAttribute('data-target') || '' })
    } else if (action === 'uninstall') {
      onIntent({ type: 'uninstall', id })
    } else if (action === 'retry') {
      onIntent({ type: 'retry', id })
    } else if (action === 'details') {
      // 展开 / 收起本身是纯视图态：本地切换 + 就地重排，不惊动编排层。
      expandedId = expandedId === id ? null : id
      render()
      // 唯独「大小」要惊动编排层：它是磁盘递归操作，只在真正展开详情时按需取一次
      // （编排层走既有 extension:list 的 includeSize，不算新通道）。已经取到过就不问。
      if (expandedId === id) {
        const item = items.find((candidate) => String(candidate.id) === id)
        if (item && !item.size) onIntent({ type: 'request-size', id })
      }
    }
  })

  /**
   * 就地翻转一行的启用开关（乐观反馈）。
   *
   * 只改这一行的开关呈现，**不重排、不重建列表**：顺序由主进程的永久顺序位决定，
   * 与启停无关，所以开关永远只改行内状态、不改行间次序。行内的状态文案 / 按钮
   * 可用性不在这里推演（太容易和主进程口径漂移），交给成功后的 extension:changed
   * 整行对账；失败时由编排层 refresh() 回读真值纠正这个乐观态。
   */
  function applyToggleVisual(sw: HTMLElement, enabled: boolean, id: string) {
    sw.setAttribute('aria-checked', String(enabled))
    const item = items.find((candidate) => String(candidate.id) === String(id))
    const name = (item && item.name) || id
    sw.title = enabled ? `停用“${name}”` : `启用“${name}”`
    sw.setAttribute('aria-label', sw.title)
    const row = sw.closest('.extensions-panel__row')
    if (row) row.classList.toggle('extensions-panel__row--disabled', !enabled)
  }

  function visibleItems() {
    // 顺序**只由主进程下发的安装顺序**（`order`）决定：固定 / 取消固定是「放到工具栏」
    // 的意图，不是排序意图 —— 若在这里按 pinned 置顶，用户点一下固定，列表行就会当着他的面
    // 跳走，下一次点击很容易落空。固定态只体现在行内按钮与徽标上。
    if (!query) return items
    return items.filter((item) => String(item.name || '').toLowerCase().includes(query))
  }

  /**
   * 图标动作按钮：统一 title / 禁用 / 数据属性，避免每行手写 8 行。
   * 行内动作一律是图标（28px 方块），文字只在 title / aria-label 里 ——
   * 界面上"看得见的字"越少，扫读越快（移动端的做法）。
   */
  function iconActionButton(icon: IconFactory, action: string, item: ExtensionView, {
    label,
    disabled = false,
    title = '',
    danger = false,
    quiet = false,
    active = false
  }: IconActionOptions) {
    const btn = doc.createElement('button')
    btn.appendChild(icon(doc, { size: 16 }))
    btn.title = title || label
    btn.setAttribute('aria-label', title || label)
    btn.setAttribute('data-action', action)
    btn.setAttribute('data-id', String(item.id))
    btn.disabled = disabled
    if (danger) btn.classList.add('extensions-panel__danger')
    if (quiet) btn.classList.add('is-quiet')
    if (active) btn.classList.add('is-active')
    return btn
  }

  function renderEmpty(message: string) {
    list.textContent = ''
    const empty = doc.createElement('div')
    empty.className = 'extensions-panel__empty'
    empty.textContent = message
    list.appendChild(empty)
  }

  /** 详情块：来源 / 版本 / 大小（按需取回）/ 描述 / 权限（中文逐条）/ 扩展 ID / 安装路径。 */
  function renderDetail(item: ExtensionView) {
    const box = doc.createElement('div')
    box.className = 'extensions-panel__detail'
    function addLine(label: string, value: unknown) {
      if (value === undefined || value === null || value === '') return
      const line = doc.createElement('div')
      line.className = 'extensions-panel__detailLine'
      const l = doc.createElement('span')
      l.className = 'extensions-panel__detailLabel'
      l.textContent = label
      const v = doc.createElement('span')
      v.className = 'extensions-panel__detailValue'
      v.textContent = String(value)
      line.append(l, v)
      box.appendChild(line)
    }
    addLine('来源', item.source === 'store' ? '商店扩展' : '本地扩展')
    addLine('版本', item.version ? `v${item.version}` : '')
    // 大小由编排层按需取回（`extension:list` 带 includeSize），取不到就不显示这一行 ——
    // 详情是哑组件，不自己发 IPC，也不把「测不出来」显示成假的 0 B。
    addLine('大小', item.size)
    addLine('描述', item.description)
    addLine('扩展 ID', item.id)
    addLine('安装路径', item.path)
    // 权限逐条列：列表项里的 permissions 已由主进程翻译成中文（domain-extension），
    // 这里只负责排版 —— 面板不做任何权限名翻译。
    const perms = Array.isArray(item.permissions) ? item.permissions.filter(Boolean) : []
    const permLine = doc.createElement('div')
    permLine.className = 'extensions-panel__detailLine'
    const label = doc.createElement('span')
    label.className = 'extensions-panel__detailLabel'
    label.textContent = '权限'
    permLine.appendChild(label)
    if (!perms.length) {
      const none = doc.createElement('span')
      none.className = 'extensions-panel__detailValue'
      none.textContent = '无'
      permLine.appendChild(none)
    } else {
      const ul = doc.createElement('ul')
      ul.className = 'extensions-panel__perms'
      for (const perm of perms) {
        const li = doc.createElement('li')
        li.textContent = perm
        ul.appendChild(li)
      }
      permLine.appendChild(ul)
    }
    box.appendChild(permLine)

    // 「检查视图」：**只在主进程下发了该字段时才出现**（开发者模式专属，关闭时主进程
    // 不下发 —— 面板不自己判断开发者模式，也不认识任何视图类型）。
    //   · inspectable: true  → 小按钮，点击 → 编排层走 extension:inspect-view；
    //   · inspectable: false → 划线静态文本 + note（底层没有开发者工具入口），
    //     但地址照常显示出来 —— 如实呈现「拿得到、但只能看」。
    const views = Array.isArray(item.inspectViews) ? item.inspectViews : []
    if (views.length) {
      const inspectLine = doc.createElement('div')
      inspectLine.className = 'extensions-panel__detailLine'
      const inspectLabel = doc.createElement('span')
      inspectLabel.className = 'extensions-panel__detailLabel'
      inspectLabel.textContent = '检查视图'
      inspectLine.appendChild(inspectLabel)
      const inspectBox = doc.createElement('span')
      inspectBox.className = 'extensions-panel__inspect'
      for (const view of views) {
        const row = doc.createElement('span')
        row.className = 'extensions-panel__inspectItem'
        if (view && view.inspectable) {
          const btn = doc.createElement('button')
          btn.textContent = view.label || view.target || '视图'
          btn.title = `在开发者工具中打开“${view.label || view.target}”（${view.url}）`
          btn.setAttribute('data-action', 'inspect-view')
          btn.setAttribute('data-id', String(item.id))
          btn.setAttribute('data-target', String(view.target || ''))
          row.appendChild(btn)
        } else {
          const label = doc.createElement('span')
          label.className = 'extensions-panel__inspectStatic'
          label.textContent = (view && view.label) || '视图'
          label.title = (view && view.note) || `${label.textContent}无法在此打开开发者工具`
          row.appendChild(label)
        }
        if (view && view.url) {
          const url = doc.createElement('span')
          url.className = 'extensions-panel__inspectUrl'
          url.textContent = view.url
          row.appendChild(url)
        }
        if (view && view.note) {
          const note = doc.createElement('span')
          note.className = 'extensions-panel__inspectNote'
          note.textContent = view.note
          row.appendChild(note)
        }
        inspectBox.appendChild(row)
      }
      inspectLine.appendChild(inspectBox)
      box.appendChild(inspectLine)
    }
    return box
  }

  function renderRow(item: ExtensionView) {
    const enabled = item.enabled !== false
    const isError = item.runtimeStatus === 'error'
    const row = doc.createElement('div')
    row.className = `extensions-panel__row${enabled ? '' : ' extensions-panel__row--disabled'}`
    row.setAttribute('data-id', String(item.id))

    // 第一行：图标 + 名称 + 启用开关 —— 只留这三件事
    const top = doc.createElement('div')
    top.className = 'extensions-panel__top'
    // 扩展图标：主进程已内联为 iconDataUrl（参考实现同款做法），优先它；
    // 读盘失败才退回协议地址。加载失败由 C02 原语降级为首字母徽标（不出现破图/空位）。
    // 清单里的 iconPath 只是扩展目录内的相对路径，当 src 用必然 404（见主进程 attachIconUrls）。
    top.appendChild(createFaviconBadge(doc, item.iconDataUrl || item.iconUrl || item.iconPath || null, item.name || item.id, 20))
    const label = doc.createElement('span')
    label.className = 'extensions-panel__label'
    label.textContent = item.name || item.id || '未命名扩展'
    label.title = item.description || item.name || ''
    top.appendChild(label)

    const sw = doc.createElement('button')
    sw.className = 'extensions-panel__switch'
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(enabled))
    sw.setAttribute('data-action', 'toggle')
    sw.setAttribute('data-id', String(item.id))
    sw.title = enabled ? `停用“${item.name || item.id}”` : `启用“${item.name || item.id}”`
    sw.setAttribute('aria-label', sw.title)
    top.appendChild(sw)
    row.appendChild(top)

    // 第二行：版本 / 清单版本 / 来源 + **仅异常时**的运行状态。
    // 「运行中」与开关表达的是同一件事，重复一遍就是纯噪音；停用 / 未加载 / 失败才值得占字。
    const metaParts: string[] = []
    if (item.version) metaParts.push(`v${item.version}`)
    if (item.isV3) metaParts.push('MV3')
    else if (item.manifestVersion) metaParts.push(`MV${item.manifestVersion}`)
    metaParts.push(item.source === 'store' ? '商店扩展' : '本地扩展')

    const runtimeStatus = item.runtimeStatus || (enabled ? 'loaded' : 'disabled')
    const showStatus = runtimeStatus !== 'loaded'
    if (metaParts.length || showStatus) {
      const meta = doc.createElement('div')
      meta.className = 'extensions-panel__meta'
      if (metaParts.length) {
        const facts = doc.createElement('span')
        facts.textContent = metaParts.join(' · ')
        facts.title = metaParts.join(' · ')
        meta.appendChild(facts)
      }
      if (showStatus) {
        const status = doc.createElement('span')
        status.className = `extensions-panel__status${isError ? ' extensions-panel__status--error' : ''}`
        status.textContent = extensionStatusLabel(runtimeStatus)
        if (isError && item.loadError) status.title = String(item.loadError)
        meta.appendChild(status)
      }
      row.appendChild(meta)
    }

    // 加载失败原因行：失败不是「没加载」就完事 —— 原因必须随行可见，
    // 否则用户只能看到一行红字却完全不知道要修什么
    if (isError && item.loadError) {
      const errorLine = doc.createElement('div')
      errorLine.className = 'extensions-panel__error'
      errorLine.textContent = `加载失败：${item.loadError}`
      row.appendChild(errorLine)
    }

    // 第三行：动作 —— 全部图标（28px 方块）。停用时「设置/弹窗」置灰：
    // 已停用的扩展没有运行时页面；加载失败同理（清单能力位还在，运行时页面根本不存在）。
    const buttons = doc.createElement('div')
    buttons.className = 'extensions-panel__buttons'
    const name = item.name || item.id
    // 固定 / 取消固定：与启停无关（停用 / 加载失败也能固定），因此**永不置灰**。
    const pinBtn = iconActionButton(Pin, 'pin', item, {
      label: item.pinned ? '取消固定' : '固定',
      title: item.pinned
        ? `取消固定“${name}”`
        : `固定“${name}”（固定在列表顶部）`,
      active: item.pinned === true
    })
    pinBtn.setAttribute('data-pinned', String(item.pinned === true))
    buttons.appendChild(pinBtn)
    buttons.appendChild(iconActionButton(Settings, 'open-options', item, {
      label: '设置',
      disabled: !enabled || isError || !item.hasOptionsPage,
      title: !item.hasOptionsPage
        ? `${name || '该扩展'}未提供设置页面`
        : (isError
          ? '扩展加载失败，先重试加载再打开设置页面'
          : (!enabled ? '扩展已停用，先启用再打开设置页面' : `打开“${name}”的设置页面`))
    }))
    buttons.appendChild(iconActionButton(PanelTop, 'open-popup', item, {
      label: '弹窗',
      disabled: !enabled || isError || !item.hasPopup,
      title: !item.hasPopup
        ? `${name || '该扩展'}未提供弹出窗口`
        : (isError
          ? '扩展加载失败，先重试加载再打开弹出窗口'
          : (!enabled ? '扩展已停用，先启用再打开弹出窗口' : `打开“${name}”的弹出窗口`))
    }))
    // 加载失败专属动作：重试加载（走 extension:reload，主进程按安装记录重载）
    if (isError) {
      buttons.appendChild(iconActionButton(RefreshCw, 'retry', item, {
        label: '重试',
        title: `重新加载“${name}”`
      }))
    }
    // 商店按钮只在有地址时出现（清单 homepage_url → 商店详情路由回落，由主进程算好）
    if (item.storeUrl) {
      buttons.appendChild(iconActionButton(ExternalLink, 'open-store', item, {
        label: '商店',
        quiet: true,
        title: `在标签页中打开“${name}”的商店页面`
      }))
    }
    const expanded = expandedId === String(item.id)
    buttons.appendChild(iconActionButton(expanded ? ChevronDown : Info, 'details', item, {
      label: expanded ? '收起' : '详情',
      title: `查看“${name}”的详细信息`
    }))
    buttons.appendChild(iconActionButton(Trash2, 'uninstall', item, {
      label: '移除',
      danger: true,
      quiet: true,
      title: `卸载“${name}”`
    }))
    row.appendChild(buttons)

    if (expandedId === String(item.id)) row.appendChild(renderDetail(item))
    return row
  }

  function render() {
    if (!items.length) {
      renderEmpty('暂无扩展。可点「应用店」安装，或用「导入扩展」加载已解压的扩展文件夹')
      return
    }
    const shown = visibleItems()
    if (!shown.length) {
      renderEmpty('没有匹配的扩展')
      return
    }
    const frag = doc.createDocumentFragment()
    for (const item of shown) frag.appendChild(renderRow(item))
    list.textContent = ''
    list.appendChild(frag)
  }

  /** 全量重列（编排层从 IPC 拿到列表后推入）。 */
  function setItems(next: readonly ExtensionView[]) {
    items = Array.isArray(next) ? next.slice() : []
    // 展开项被卸载 / 消失时清掉展开态，否则会残留一个永不展开的 id（下次同 id 又会出现）
    if (expandedId && !items.some((item) => String(item.id) === expandedId)) expandedId = null
    render()
  }

  /**
   * 状态行：本地动作结果 / 加载失败的提示。传空串即隐藏。
   * 由编排层调用 —— 哑组件不发 IPC，也不知道失败原因该怎么说。
   */
  function setNotice(text = '', kind: 'info' | 'error' = 'info') {
    const message = text
    notice.textContent = message
    notice.hidden = !message
    notice.classList.toggle('extensions-panel__notice--error', kind === 'error')
  }

  return { element: wrap, setItems, setNotice }
}

/** 面板插件定义（宿主按约定发现并挂载；端口由 ctx 注入）。 */
export const panelDefinition: PanelDefinition = {
  id: 'extensions-panel',
  injectStyles: injectExtensionsPanelStyles,

  mount(doc, ctx) {
    const panelCtx = ctx as ExtensionsPanelContext
    const extensionsClient = panelCtx.clients?.extensions
    const tabsClient = panelCtx.clients?.tabs
    const confirm = panelCtx.confirm
    if (!extensionsClient) throw new Error('extensions panel requires extensions client')
    const extensionStore = extensionsClient

    // 当前列表（卸载确认要显示扩展名，避免只报一个 id）
    let panelItems: ExtensionView[] = []
    /**
     * 已按需取回的目录大小（id → `1.2 MB` 这样的可读文本）。
     *
     * 为什么要本层缓存：大小**不随每次列表下发**（磁盘递归操作），而列表整体被替换
     * 是常态（任何扩展变更都会 refresh），不缓存的话展开一次、刷新一下大小就没了。
     * 主进程侧另有同键缓存（含失效规则），所以这里只是「别丢显示」，不是第二份真源。
     */
    const sizeCache = new Map<string, string>()

    const panel = createExtensionsPanel(doc, {
      onIntent({ type, id, enabled, pinned, anchorRect, target }: ExtensionIntent) {
        if (type === 'import') {
          extensionsClient.importFolder()
            .then((res) => {
              // 用户在系统选择框里点了取消 —— 不是失败，也不该给「已加载」的假成功提示
              if (res && res.canceled) return
              panel.setNotice('扩展已加载')
              refresh()
            })
            .catch(() => panel.setNotice('导入扩展失败', 'error'))
        } else if (type === 'open-manager') {
          // 管理页放在标签页里：侧栏只有几百像素，详情 / 权限 / 诊断在那儿撑不开。
          // 已有同页标签优先切换，否则新开 —— 不顶掉用户正在看的页面。
          if (tabsClient) openUrlPreferExistingTab(pageUrl('extensions'), tabsClient).catch(() => {})
        } else if (type === 'open-web-store') {
          // 「浏览 Chrome 网上应用店」：**新标签页**打开外部地址（与 RT <a target="_blank"> 同语义）
          tabsClient?.newTab({ url: CHROME_WEB_STORE_URL })
            .catch(() => panel.setNotice('未能打开 Chrome 网上应用店', 'error'))
        } else if (type === 'toggle' && id != null) {
          // 开关是**行内状态**，不改行间次序（顺序由主进程的永久顺序位决定）。
          // 成功时不再主动 refresh()：主进程会广播 extension:changed，一次开关只
          // 重建一次列表；之前「主动刷 + 广播刷」会让整表闪两下。失败则 refresh()
          // 回读真值，把点击时的乐观翻转纠正回来。
          extensionsClient.toggle(id, enabled === true)
            .then((res) => {
              if (res && res.ok === false) throw new Error('toggle failed')
              panel.setNotice('')
            })
            .catch(() => {
              panel.setNotice(enabled ? '启用扩展失败' : '停用扩展失败', 'error')
              refresh()
            })
        } else if (type === 'pin' && id != null) {
          // 固定是纯意图（不启停扩展）：成功与否都以主进程的安装记录为准，
          // 这里只发起 + 提示；列表由 extension:changed 自动对账，另外再刷一次兜底。
          extensionsClient.setPinned(id, pinned === true)
            .then((res) => {
              if (res && res.ok === false) throw new Error('pin failed')
              panel.setNotice(pinned ? '已固定' : '已取消固定')
              refresh()
            })
            .catch(() => panel.setNotice(pinned ? '固定扩展失败' : '取消固定失败', 'error'))
        } else if (type === 'request-size' && id != null) {
          // 用户展开了详情且该项还没有大小 → 按需算一次。走既有 extension:list 的
          // includeSize 入参（**不新增 IPC 通道**）：主进程只为点名的这些扩展做目录
          // 递归并进缓存；取到后就地写回列表项重推，面板保持展开态重绘详情。
          if (sizeCache.has(String(id))) return
          extensionsClient.list({ includeSize: [id] })
            .then((list) => {
              const found = Array.isArray(list) ? list.find((it) => it && String(it.id) === String(id)) : null
              if (!found || !found.size) return
              sizeCache.set(String(id), found.size)
              const hit = panelItems.find((item) => String(item.id) === String(id))
              if (!hit) return
              hit.size = found.size
              panel.setItems(panelItems)
            })
            .catch(() => { /* 取不到就不显示「大小」那一行，不打扰详情其余内容 */ })
        } else if (type === 'open-options' && id != null) {
          extensionsClient.openOptions(id)
            .then((res) => panel.setNotice(res.ok === true ? '' : '未能打开该扩展的设置页面', 'error'))
            .catch(() => panel.setNotice('未能打开该扩展的设置页面', 'error'))
        } else if (type === 'open-popup' && id != null) {
          // anchorRect 是面板**视图内**坐标（面板是独立 WebContentsView）。
          // 与弹窗定位所用的窗口内容区坐标差一个视图偏移 —— 偏移由主进程按发送方
          // webContents 反查视图落点后补上（apps/app-main/src/main/ipc/extensions.js
          // 的 toWindowContentRect）。本层只做透传，不碰坐标系。
          extensionsClient.openPopup(id, anchorRect ? { anchorRect } : undefined)
            .then((res) => panel.setNotice(res.ok === true ? '' : '未能打开该扩展的弹出窗口', 'error'))
            .catch(() => panel.setNotice('未能打开该扩展的弹出窗口', 'error'))
        } else if (type === 'open-store' && id != null) {
          extensionsClient.openStore(id)
            .then((res) => panel.setNotice(res.ok === true ? '' : '未能打开该扩展的商店页面', 'error'))
            .catch(() => panel.setNotice('未能打开该扩展的商店页面', 'error'))
        } else if (type === 'inspect-view' && id != null) {
          // 「检查视图」：把扩展的后台上下文交给主进程的开发者工具。
          // target 由面板从**主进程下发的列表项**原样带回来（面板不认识视图类型）。
          extensionsClient.inspectView(id, String(target || ''))
            .then((res) => panel.setNotice(res.ok === true ? '' : '未能打开该视图的开发者工具', 'error'))
            .catch(() => panel.setNotice('未能打开该视图的开发者工具', 'error'))
        } else if (type === 'uninstall' && id != null) {
          const extensionToUninstall = panelItems.find((item) => String(item.id) === String(id))
          const confirmation = confirm ? confirm({
            title: '卸载扩展',
            message: `确定卸载“${extensionToUninstall?.name || id}”吗？卸载后需要重新安装才能恢复。`,
            danger: true,
            confirmLabel: '卸载'
          }) : true
          Promise.resolve(confirmation).then((ok) => {
            if (!ok) return
            extensionsClient.uninstall(id)
              .then(() => { panel.setNotice('扩展已卸载'); refresh() })
              .catch(() => panel.setNotice('卸载扩展失败', 'error'))
          }).catch(() => {})
        } else if (type === 'retry' && id != null) {
          // 重试加载（加载失败的扩展）：主进程按安装记录里的路径重新 loadExtension，
          // 成败都会推 lifecycle 事件 → onChanged 自动刷新，这里只管发起与兜底提示
          extensionsClient.reload(id)
            .then((res) => {
              if (res.ok === true) { panel.setNotice('扩展已重新加载'); return }
              panel.setNotice('重新加载失败，请确认扩展目录仍在原位置', 'error')
            })
            .catch(() => panel.setNotice('重新加载失败，请确认扩展目录仍在原位置', 'error'))
            .finally(() => refresh())
        }
      }
    })

    let refreshRevision = 0
    async function refresh() {
      const revision = ++refreshRevision
      try {
        // 列表项已自带 runtimeStatus / hasOptionsPage / hasPopup（main 侧一次算完），
        // 面板因此只需 1 次 IPC —— 不再为每一行各发一次状态查询。
        const next = await extensionStore.list()
        if (revision !== refreshRevision) return
        panelItems = next
        // 已按需取过大小的项就地回填：大小不随列表下发，不回填的话每次刷新都会丢
        for (const item of panelItems) {
          const cachedSize = sizeCache.get(String(item.id))
          if (cachedSize) item.size = cachedSize
        }
        panel.setItems(panelItems)
      } catch (e) {
        if (revision !== refreshRevision) return
        panel.setNotice('加载扩展列表失败', 'error')
      }
    }

    refresh()
    // 任何来源的扩展变更（启用/停用/安装/卸载）→ 实时对账刷新
    extensionsClient.onChanged((payload) => {
      const event = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      if (event.type === 'action-updated') return
      refresh()
    })

    return { element: panel.element, refresh }
  }
}

/**
 * Chrome 网上应用店的「浏览」入口（与 HiraRT `extensions/page.tsx:14` 的
 * CHROME_WEB_STORE_URL 逐字符相同，连同 utm_source）。
 *
 * 由本面板自带而不是从宿主取：它是这一个面板的业务常量，别的面板用不到。
 * （内部管理页 hira://extensions 走的是标签页的 setWindowOpenHandler；
 * 面板是独立 WebContentsView 没有那条链路，所以「开新标签」只能用标签通道。）
 */
const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/category/extensions?utm_source=ext_sidebar'
