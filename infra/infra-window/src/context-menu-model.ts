import type { ContextMenuParams } from 'electron'

const { stripTrackingParams } = require('@hira-ng/shared-types/src/clean-url')
// 搜索项文案兜底：引擎名的唯一真源（不在这里写死 "Bing"）。
const { defaultSearchLabel } = require('@hira-ng/shared-types/src/search-engines')
// 编辑 role → 中文菜单名的唯一真源（与应用菜单、地址栏右键共用一份）。
const { editMenuItem } = require('@hira-ng/shared-types/src/edit-menu')

/**
 */
export interface ContextMenuItem {
  type?: 'separator'
  label?: string
  role?: string
  accelerator?: string
  command?: string
  enabled?: boolean
  section?: string
  submenu?: ContextMenuItem[]
}

interface ContextMenuOptions {
  searchLabel?: (text: string) => string
  nav?: { canGoBack?: boolean; canGoForward?: boolean; loading?: boolean }
  accelerator?: (command: string) => string
}

/**
 * @param {import('electron').ContextMenuParams} params
 * @param {{
 *   searchLabel?: (text: string) => string,
 *   nav?: { canGoBack?: boolean, canGoForward?: boolean, loading?: boolean },
 *   accelerator?: (command: string) => string
 * }} [options]
 *   nav：**当前页的导航态**，由调用方在构菜单那一刻现取（对齐主流浏览器：
 *   后退 / 前进在无历史时置灰不可点，加载中时「重新加载」变成「停止加载」）。
 *   缺省（未提供）= 全部按可用处理，与加入本参数之前的行为一致。
 *   accelerator：`command` → Electron accelerator 的解析器（**唯一真源**见
 *   shared-types#keybindings.mjs 的 `menuAccelerator`）。本模块不写任何组合键字面量 ——
 *   那正是四个菜单面各自漂移的来源。缺省 = 不显示快捷键提示。
 * @returns {ContextMenuItem[]}
 */
export function buildContextMenuModel(params: ContextMenuParams, options: ContextMenuOptions = {}): ContextMenuItem[] {
  /**
   * 菜单分组（`{ id, items }`）。
   *
   * 为什么每段必须带 id：宿主 / 插件贡献的项可以声明 `group`（"请把我插到链接那一组里"），
   * 而落地只能在**本文件**做 —— 只有这里知道"链接组"是哪几项、最后一项在哪个下标。
   * 若由装配层自己去数下标，每加一条内置项都会错位一次（正是要避免的耦合）。
   * @type {Array<{ id: string, items: ContextMenuItem[] }>}
   */
  const sections: Array<{ id: string; items: ContextMenuItem[] }> = []
  const section = (id: string, items: ContextMenuItem[]): number => sections.push({ id, items })
  const editFlags = params.editFlags || {}
  const selection = String(params.selectionText || '').trim()
  const nav = options.nav || {}
  const searchLabel = typeof options.searchLabel === 'function'
    ? options.searchLabel(selection)
    : defaultSearchLabel(selection)
  const accel = typeof options.accelerator === 'function' ? options.accelerator : () => ''

  /**
   * 给带快捷键的项挂上 accelerator。空串**不写字段**：Electron 收到
   * `accelerator: ''` 会告警，还会渲染一个空提示位。
   * @param {ContextMenuItem} item
   * @returns {ContextMenuItem}
   */
  const withAccelerator = (item: ContextMenuItem): ContextMenuItem => {
    let accelerator = ''
    try { accelerator = accel(item.command || '') || '' } catch (_) { accelerator = '' }
    return accelerator ? { ...item, accelerator } : item
  }

  if (params.isEditable) {
    if (params.misspelledWord && Array.isArray(params.dictionarySuggestions)) {
      section('spelling', params.dictionarySuggestions.map((suggestion) => ({
        label: suggestion,
        command: 'replace-misspelling'
      })))
      section('dictionary', [{ label: '添加到词典', command: 'add-to-dictionary' }])
    } else {
      // `role` 项**刻意不写 accelerator**：Electron 的 role 自带平台正确的默认组合键
      //（见 Electron 的 roles 表，macOS / Windows / Linux 各不相同）。手抄一份的结局
      // 就是 Linux 上「重做」显示成 Ctrl+Y（真值是 Ctrl+Shift+Z）这类漂移。
      section('edit-history', [
        editMenuItem('redo', { enabled: editFlags.canRedo !== false }),
        editMenuItem('undo', { enabled: editFlags.canUndo !== false })
      ])
    }
    section('edit-clipboard', [
      editMenuItem('cut', { enabled: editFlags.canCut !== false }),
      editMenuItem('copy', { enabled: editFlags.canCopy !== false }),
      editMenuItem('paste', { enabled: editFlags.canPaste !== false }),
      editMenuItem('delete', { enabled: editFlags.canDelete !== false }),
      editMenuItem('selectAll', { enabled: editFlags.canSelectAll !== false })
    ])
  } else if (selection) {
    section('selection', [
      editMenuItem('copy', { enabled: editFlags.canCopy !== false }),
      { label: searchLabel, command: 'search-selection' }
    ])
  }

  if (params.linkURL) {
    const link = String(params.linkURL)
    // 只在**真的能去掉点什么**时才给「复制干净链接」——否则就是一个点了没反应的项。
    const cleaned = stripTrackingParams(link)
    section('link', [
      { label: '在新标签页中打开链接', command: 'open-link' },
      // 小窗预览（N1）：链接菜单里**最轻的那一档** —— 不占标签栏、也不占一整个窗口
      //（520×560 置顶小窗），看完即关；觉得值得留时 `Ctrl+Enter` 直接收为正式标签。
      // 排序刻意按"由轻到重"：新标签页 → 小窗 → 新窗口，用户一眼就能挑到最省的那档。
      { label: '在小窗中预览链接', command: 'peek-link' },
      { label: '在新窗口中打开链接', command: 'open-link-window' },
      { label: '复制链接地址', command: 'copy-link' },
      ...(cleaned !== link ? [{ label: '复制干净链接（去除跟踪参数）', command: 'copy-clean-link' }] : []),
      { label: '将链接另存为...', command: 'save-link' }
    ])
  } else if (params.mediaType === 'image' && params.srcURL) {
    section('image', [
      { label: '在新标签页中打开图片', command: 'open-media' },
      { label: '复制图片', command: 'copy-image' },
      { label: '复制图片地址', command: 'copy-media' },
      { label: '将图片另存为...', command: 'save-image' }
    ])
  } else if (params.mediaType && params.mediaType !== 'none' && params.srcURL) {
    section('media', [
      { label: '在新标签页中打开媒体', command: 'open-media' },
      { label: '复制媒体地址', command: 'copy-media' },
      { label: '将媒体另存为...', command: 'save-media' }
    ])
  }

  if (params.mediaType === 'video' && params.srcURL) {
    section('video', [{ label: '画中画', command: 'picture-in-picture' }])
  }

  if (!params.isEditable) {
    // 刷新 / 停止同槽位互斥（对齐 Edge/Chrome）：加载中给「停止加载」，否则给「重新加载」。
    // 用两个命令而不是一个带状态的命令 —— 命令层保持「一命令一动作」，
    // 状态判定留在模型层（这里），命令表无需认识加载态。
    const reloadOrStop = nav.loading
      ? { label: '停止加载', command: 'stop' }
      : withAccelerator({ label: '重新加载', command: 'reload' })
    section('nav', [
      withAccelerator({ label: '后退', command: 'back', enabled: nav.canGoBack === true }),
      withAccelerator({ label: '前进', command: 'forward', enabled: nav.canGoForward === true }),
      reloadOrStop
    ])
  }

  section('tools', [
    // 三种方式收进同一个父项的子菜单，菜单顶层只留一个「截图」。
    {
      label: '截图',
      submenu: [
        { label: '截取可见区域', command: 'capture-viewport' },
        { label: '截取整页', command: 'capture-fullpage' },
        // 框选一块截：宿主会先盖一层框选图层，拖出矩形后截那一块。
        { label: '截取选区…', command: 'capture-region' }
      ]
    },
    // C3 网页翻译：把这一页翻成目标语言（顶部出现一条"已翻译 / 显示原文"的小条）。
    { label: '翻译此页', command: 'translate-page' },
    { label: '阅读模式', command: 'reader-mode' },
    withAccelerator({ label: '打印...', command: 'print' })
  ])

  // 「查看源代码」与「检查元素」同属开发者向操作 —— 放在同一分组里。
  // 可编辑区域里没有"检查元素"的意义，但仍可查看源代码。
  const viewSource = withAccelerator({ label: '查看源代码', command: 'view-source' })
  section('inspect', params.isEditable
    ? [viewSource]
    : [
        // 顺序对齐开发者工具的习惯：先看源码，再进检查器。
        viewSource,
        withAccelerator({ label: '检查元素', command: 'inspect' })
      ])

  /** @type {ContextMenuItem[]} */
  const result: ContextMenuItem[] = []
  for (const group of sections) {
    // 每一项带上所属分组的 id：宿主 / 插件的 `group` 插入点靠它定位（见 context-menu.js）。
    const items = group.items.filter(Boolean).map((item) => ({ ...item, section: group.id }))
    if (items.length === 0) continue
    if (result.length > 0) result.push({ type: 'separator' } satisfies ContextMenuItem)
    for (const item of items) result.push(item)
  }
  return result
}

