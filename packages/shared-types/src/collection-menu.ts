/**
 * collection-menu.mjs —— 「收进哪个集锦」这份菜单的**唯一真源**（纯数据 + 纯函数）
 *
 * ── 为什么必须只有一处 ────────────────────────────────────────────
 * 「把这一页 / 这张图 / 这段文字 / 这条标签收进集锦」这件事有**五个**入口，分住在**两个进程**：
 *   · 页面右键四项             —— 主进程（`browser-window-assembly.js`，原生菜单 submenu）
 *   · 标签右键「添加到集锦 ▸」 —— 渲染进程（`ui-common#tabContextMenu` 出描述符 → 原生 submenu）
 *   · 应用菜单「把当前页…」    —— 主进程（`app-menu.js`）
 *   · 面板「+ 添加当前页面」   —— 渲染进程（`plugins/panel-notes.*`，**不需要**选择器，见下）
 *   · 下载项右键「添加到集锦 ▸」 —— 渲染进程（`ui-panel-downloads` 出描述符 → 原生 submenu）
 * 如果每个入口各排一遍「稍后读 / 未归档 / 集锦列表 / 新建集锦」的顺序，它们必然漂移 ——
 * 用户看到的就是"右键有『未归档』、标签右键没有""两处集锦顺序还不一样"这类静默不一致。
 * 与 `notes.mjs` / `reading-list.mjs` 同一手法：**跨 bundle / 跨进程共用的口径一律下沉到这里**。
 *
 * ── 「稍后读」也是集锦子菜单里的一个落点 ───────────────────────────
 * 稍后读 = 笔记里的固定文件夹（`READING_LIST_FOLDER`），与集锦是**同一实体、不同落点**
 * （都是 `kind='page'` 卡，只是 `folder_id` 不同）。它排在第一位 —— 收藏动作最常见的那一下
 * 不必再往下找；列表段里同名的文件夹**不重复出现**（它就是这一项）。
 *
 * ── 落库编排也收在这里（`captureToCollectionTarget`）──────────────
 * "落点 → 建新集锦 → 抓取入库"这段流程同样只该有一份。它只需要 `notes` 客户端
 * （`folders / addFolder / capture`），由**宿主注入** —— 于是本文件仍然不依赖任何宿主实现。
 *
 * ── 本文件给出的是「描述符」，不是菜单项 ──────────────────────────────
 * 各宿主的菜单形态并不一样（Electron 原生 `Menu` 要 `{label, click}`；
 * 渲染层上报给主进程的菜单模型要 `{label, action}`）。
 * 若这里直接产出某一种，另一个宿主就得把它再翻译回去。因此这里产出**与宿主无关的描述符序列**
 * （`{kind:'reading'|'unfiled'|'folder'|'new'|'separator'}`），并提供两个极薄的映射器
 * （原生菜单 / 渲染层动作菜单）；**顺序 / 文案只有这一份**，各宿主只负责"怎么呈现"。
 *
 * ── 「未归档」= `folderId: null`（域层的既有三态语义）──────────────────
 * `domain-notes#addCaptured` 的 `folderId` 三态：**省略 / null = 根级（未归档）**、字符串 = 该
 * 文件夹。于是「未归档」这一项落库时**必须**传 `folderId: null` —— 传 `undefined` 会走
 * "调用方没给"的语义，虽然结果同样是根级，但语义含糊、以后加默认落点时就会被误伤。
 *
 * ⚠ 本文件必须保持「轻」：它同时被 Node（主进程 `require`）与浏览器（渲染层 / 面板 `import`）
 *   加载；只依赖**同包的纯常量模块**（`reading-list.mjs`），不引入任何客户端 / IPC。
 *   `captureToCollectionTarget` 只编排注入的端口，不自己取依赖。
 */

import { READING_LIST_FOLDER } from './reading-list.js'

/** 「稍后读」这一项的文案（与文件夹名同源：改名只需动 `reading-list.mjs`）。 */
const READING_LABEL = READING_LIST_FOLDER
/** 「未归档」的文案（域层 `folderId: null` 那一态的用户说法 —— 别处不得再写第二种）。 */
const UNFILED_LABEL = '未归档'
/**
 * 「新建集锦…」的文案。
 * ⚠ 已知限制：**原生菜单收不了文本输入**，所以新集锦的名字只能用当前页标题兜底
 *   （用户随后可在面板里重命名）。这条限制在五个入口都成立，因此写在这里而不是各写一遍。
 */
const NEW_COLLECTION_LABEL = '新建集锦…'
/** 集锦动作串的统一前缀（渲染层菜单只回传一个 action 字符串，编码规则必须只有这一份）。 */
const COLLECTION_ACTION_PREFIX = 'collection:'

/** 共享的分隔线描述符（宿主映射时通常会换成自己的分隔线字面量）。 */
const COLLECTION_MENU_SEPARATOR = Object.freeze({ kind: 'separator' })

interface CollectionMenuEntry {
  kind: string
  id?: string
  label?: string
}

export interface NativeCollectionMenuItem {
  label?: string
  type?: string
  click?: () => void
  [key: string]: unknown
}

export interface CollectionTarget {
  kind: 'reading' | 'unfiled' | 'folder' | 'new'
  folderId: string | null
}

/**
 * 在一份文件夹列表里找出「稍后读」文件夹的 id（没有 → null）。
 *
 * 需要这个判定"哪个文件夹算稍后读"的地方一律走这里 —— 别处不得再手写
 * `f.name === '稍后读'`（改名 / 多语言时必然只改一处）。
 *
 * @param {Array<{id?: string, name?: string}>|null|undefined} folders
 * @returns {string|null}
 */
function findReadingFolderId(folders: Array<{ id?: string, name?: string }>|null|undefined) : string|null {
  const found = (Array.isArray(folders) ? folders : [])
    .find((f) => f && f.id && String(f.name || '') === READING_LIST_FOLDER)
  return found ? String(found.id) : null
}

/**
 * 菜单描述符 → 落点目标（宿主点击后实际上只关心这个）。
 * @param {{kind: string, id?: string}} entry
 * @returns {{kind:'reading'|'unfiled'|'folder'|'new', folderId: string|null}|null}
 */
function collectionEntryTarget(entry: CollectionMenuEntry | null | undefined): CollectionTarget | null {
  if (!entry || typeof entry !== 'object') return null
  if (entry.kind === 'reading') return { kind: 'reading', folderId: null }
  if (entry.kind === 'unfiled') return { kind: 'unfiled', folderId: null }
  if (entry.kind === 'new') return { kind: 'new', folderId: null }
  if (entry.kind === 'folder' && entry.id) return { kind: 'folder', folderId: String(entry.id) }
  return null
}

/**
 * 生成「收进集锦」的**菜单描述符序列** —— 顺序即五个入口的共同约定：
 *
 * ```
 * 稍后读
 * 未归档
 * ─────────
 * 集锦 A
 * 集锦 B
 * …（按传入顺序，即 listFolders 的既有排序）
 * ─────────
 * 新建集锦…
 * ```
 *
 * 「稍后读」就是那个固定文件夹，因此列表段里与它同名的文件夹会被跳过（不出现两次）。
 * 一个集锦都没有时，中间的列表段连同它上面那条分隔线一起省掉（不留一条悬空的分隔线）。
 * @param {Array<{id?: string, name?: string}>|null|undefined} folders
 * @returns {Array<{kind:string, id?:string, label?:string}>}
 */
function buildCollectionMenuEntries(folders: Array<{ id?: string, name?: string }>|null|undefined): CollectionMenuEntry[] {
  const list = (Array.isArray(folders) ? folders : [])
    .filter((f) => f && f.id)
    .filter((f) => String(f.name || '') !== READING_LIST_FOLDER)
  const out: CollectionMenuEntry[] = [
    { kind: 'reading', label: READING_LABEL },
    { kind: 'unfiled', label: UNFILED_LABEL }
  ]
  if (list.length) out.push(COLLECTION_MENU_SEPARATOR)
  for (const f of list) {
    out.push({ kind: 'folder', id: String(f.id), label: String(f.name || f.id) })
  }
  out.push(COLLECTION_MENU_SEPARATOR, { kind: 'new', label: NEW_COLLECTION_LABEL })
  return out
}

/**
 * 描述符 → 渲染层菜单的动作串（`collection:reading` / `collection:folder:<id>`…）。
 *
 * 为什么需要编码：渲染层自绘菜单 → 主进程原生 `Menu` 这条通道只能回传**一个字符串**
 * （`ui:popup-menu-selected` 的 `action`），拿不到结构化落点对象。编码 / 解码都放在本文件，
 * 是为了让"稍后读 / 未归档 / 新建 / 某个集锦"这四种落点的写法**只有一份** ——
 * 否则渲染层拼串、宿主解串，两边各写一遍必然对不上。
 *
 * @param {{kind:string, id?:string}} entry
 * @returns {string|null} 无法识别的描述符 → null（菜单映射时该项会被丢弃）
 */
function collectionEntryAction(entry: { kind:string, id?:string }) : string|null {
  if (!entry || typeof entry !== 'object') return null
  if (entry.kind === 'reading') return `${COLLECTION_ACTION_PREFIX}reading`
  if (entry.kind === 'unfiled') return `${COLLECTION_ACTION_PREFIX}unfiled`
  if (entry.kind === 'new') return `${COLLECTION_ACTION_PREFIX}new`
  if (entry.kind === 'folder' && entry.id) {
    return `${COLLECTION_ACTION_PREFIX}folder:${encodeURIComponent(String(entry.id))}`
  }
  return null
}

/**
 * 渲染层菜单的动作串 → 落点目标；不是集锦动作 → null。
 * @param {string|null|undefined} action
 * @returns {{kind:'reading'|'unfiled'|'folder'|'new', folderId: string|null}|null}
 */
function collectionTargetFromAction(action: string|null|undefined) : {kind:'reading'|'unfiled'|'folder'|'new', folderId: string|null}|null {
  if (typeof action !== 'string' || !action.startsWith(COLLECTION_ACTION_PREFIX)) return null
  const rest = action.slice(COLLECTION_ACTION_PREFIX.length)
  if (rest === 'reading') return { kind: 'reading', folderId: null }
  if (rest === 'unfiled') return { kind: 'unfiled', folderId: null }
  if (rest === 'new') return { kind: 'new', folderId: null }
  if (rest.startsWith('folder:')) {
    try {
      const id = decodeURIComponent(rest.slice('folder:'.length))
      return id ? { kind: 'folder', folderId: id } : null
    } catch (_) {
      return null
    }
  }
  return null
}

/**
 * Electron 原生菜单的项形态（`{label, click}` / `{type:'separator'}`）。
 * @param {Array<{kind:string, id?:string, label?:string}>} entries
 * @param {(target:{kind:'reading'|'unfiled'|'folder'|'new', folderId:string|null}) => void} onSelect
 * @returns {NativeCollectionMenuItem[]}
 */
function toNativeMenuItems(entries: CollectionMenuEntry[], onSelect: (target: CollectionTarget) => void) : NativeCollectionMenuItem[] {
  const select = typeof onSelect === 'function' ? onSelect : () => {}
  return (Array.isArray(entries) ? entries : []).map((e) => {
    if (!e || e.kind === 'separator') return { type: 'separator' }
    const target = collectionEntryTarget(e)
    return { label: e.label || '', click: () => { if (target) select(target) } }
  })
}

/**
 * 渲染层菜单模型（`ui:popup-menu` 的 `items`）的项形态：`{label, action}` / `{type:'separator'}`。
 *
 * 与 `toNativeMenuItems` 的区别只在"怎么把点击送回去"：主进程原生菜单直接挂 `click` 闭包，
 * 而渲染层菜单只有一个 action 字符串通道 —— 于是这里产出 {@link collectionEntryAction}
 * 编码好的动作串，由宿主在 `default` 分支用 {@link collectionTargetFromAction} 解回来。
 *
 * @param {Array<{kind:string, id?:string, label?:string}>} entries
 * @returns {Array<{label?:string, action?:string, type?:string}>}
 */
function toActionMenuItems(entries: Array<{ kind:string, id?:string, label?:string }>) : Array<{label?:string, action?:string, type?:string}> {
  const out: Array<{ label?: string; action?: string; type?: string }> = []
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.kind === 'separator') {
      out.push({ type: 'separator' })
      continue
    }
    const action = collectionEntryAction(e)
    if (action) out.push({ label: e.label || '', action })
  }
  return out
}

/**
 * 「收进集锦」的落库编排：落点 → （必要时）建新集锦 / 找稍后读 → 抓取入库。
 *
 * 与旧 `captureToCollection` 的区别：**不再负责弹菜单**。各入口（主进程原生菜单 /
 * 渲染层动作子菜单）各自负责取落点，落点之后的这一段只有这一份。
 *
 * 落点四态：`reading` → 「稍后读」文件夹（没有就建一个）、`unfiled` → **null**
 * （域层"根级/未归档"那一态，绝不传 undefined）、`folder` → 集锦 id、
 * `new` → 先按条目标题建一个再落进去（原生菜单收不了文本输入）。
 *
 * 去重不在这里做：`domain-notes#addCaptured` 已保证"同一文件夹下同 URL 的 page 卡只留一张"，
 * 判重规则一旦分裂就再也对不齐。
 *
 * @param {{ folders:Function, addFolder:Function, capture:Function }} notes
 * @param {{ url?: string, title?: string, tabId?: string }} item
 * @param {{kind:'reading'|'unfiled'|'folder'|'new', folderId?: string|null}|null} target
 * @returns {Promise<boolean>} 是否写入成功
 */
export interface CollectionNotesPort {
  folders(): Promise<unknown>
  addFolder(input: { name: string }): Promise<unknown>
  capture(input: Record<string, unknown>): Promise<unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function captureToCollectionTarget(
  notes: CollectionNotesPort,
  item: { url?: string; title?: string; tabId?: string },
  target: { kind: 'reading' | 'unfiled' | 'folder' | 'new'; folderId?: string | null } | null
): Promise<boolean> {
  const url = item && item.url ? String(item.url).trim() : ''
  if (!notes || !target || !url) return false
  try {
    let folderId: string | null = null
    if (target.kind === 'new') {
      const name = String((item && item.title) || '').trim() || '新集锦'
      const folder = await notes.addFolder({ name }) as Record<string, unknown> | string | null
      folderId = folder && typeof folder === 'object' && folder.id ? String(folder.id) : null
    } else if (target.kind === 'folder') {
      folderId = target.folderId ? String(target.folderId) : null
    } else if (target.kind === 'reading') {
      // 稍后读是固定文件夹：已有就用，没有才建（与集锦走同一个 addFolder 端口）。
      const folders = await notes.folders()
      folderId = findReadingFolderId(Array.isArray(folders) ? folders as Array<{ id?: string; name?: string }> : [])
      if (!folderId) {
        const folder = await notes.addFolder({ name: READING_LIST_FOLDER })
        folderId = typeof folder === 'string'
          ? folder
          : (folder && typeof folder === 'object' && 'id' in folder ? String((folder as { id: unknown }).id) : null)
      }
      if (!folderId) return false
    }

    // 落库走**抓取入口**（note:capture → domain-notes#addCaptured）：同集锦内同页去重由域负责，
    // 这里不自己判重（判重规则一旦分裂就再也对不齐）。
    // 带 `tabId` 时，主进程据它从**被点那个标签**取权威 url/title 与画面来源（缩略图）。
    await notes.capture({
      kind: 'page',
      url,
      title: item && item.title,
      ...(item && item.tabId ? { tabId: String(item.tabId) } : {}),
      folderId
    })
    return true
  } catch (e) {
    console.error('[collections] capture failed:', errorMessage(e))
    return false
  }
}

export {
  READING_LABEL,
  UNFILED_LABEL,
  NEW_COLLECTION_LABEL,
  COLLECTION_ACTION_PREFIX,
  COLLECTION_MENU_SEPARATOR,
  findReadingFolderId,
  buildCollectionMenuEntries,
  collectionEntryTarget,
  collectionEntryAction,
  collectionTargetFromAction,
  toNativeMenuItems,
  toActionMenuItems,
  captureToCollectionTarget
}
