/**
 * icon-names.mjs —— 图标名的**唯一真源**（跨进程、零依赖、零 IO）。
 *
 * 为什么单独一个文件：manifest 里的 `icon` 是**字符串**（要过 IPC），于是有三处
 * 都需要回答"这个名字认不认识"：
 *   1. 渲染层 `ui/ui-common/src/icons.ts` —— 名字 → SVG 构造器；
 *   2. 主进程创作侧 `plugins/ai/core/studio.cjs` —— 生成插件时校验 / 归一图标名；
 *   3. AI 的 `studio_capabilities` —— 把合法名字直接摆给模型，避免它瞎编。
 *
 * 以前名单只活在渲染层：插件写 `bookmark` 得到一个**空白按钮**，而创作侧完全不知道
 * "哪些名字可用"。两份名单各自演化必然漂移，所以名字与别名放这里，绘制仍留在
 * `ui-common`（那里才有 SVG 模板函数）。
 *
 * ⚠ `ICON_NAMES` 必须与 `icons.js#ICON_REGISTRY` 的键**逐一对应**
 * （`icons.js` 在模块求值时自检，缺一个会告警）。
 */

/** 全部可用的注册名（= ICON_REGISTRY 的键）。 */
export const ICON_NAMES = Object.freeze([
  'ArrowLeft', 'ArrowRight', 'ArrowLeftRight', 'RefreshCw', 'Home', 'Plus', 'X', 'Minus', 'Square',
  'CopyPlus', 'GripVertical', 'ChevronRight', 'ChevronLeft', 'ChevronDown', 'Paperclip',
  'Volume2', 'VolumeX', 'Star', 'Clock', 'Download', 'Puzzle', 'Blocks', 'StickyNote', 'Palette',
  'Pin', 'Users', 'LayoutGrid', 'Layers', 'AppWindow', 'DetachWindow', 'Menu', 'Lock',
  'Smartphone', 'Monitor', 'MoreHorizontal', 'Settings', 'ExternalLink', 'PanelTop',
  'Shield', 'ShieldCheck', 'ShieldX', 'Bell', 'Check', 'XCircle', 'Camera', 'ScanLine', 'Mic',
  'Search', 'PanelRight', 'Paintbrush', 'Archive', 'Rss', 'List', 'Globe', 'Calculator', 'Zap',
  'Folder', 'FolderPlus',
  'MousePointer2', 'Pencil', 'ArrowUpRight', 'Circle', 'Spline', 'Eraser', 'Undo2', 'Trash2', 'Network',
  'Shapes',
  'TriangleAlert',
  'Info',
  'Type', 'Highlighter', 'Redo2', 'Droplet', 'Copy',
  'Bookmark',
  'Sparkles', 'Send', 'MessageSquare', 'Bot'
])

const KNOWN = new Set(ICON_NAMES)

/**
 * 插件作者惯用的「小写 / 连字符 / 语义别名」→ 注册名。
 *
 * 白名单本身不放开（仍只认 `ICON_NAMES`），这里只做名字归一 + 常见语义映射。
 */
export const ICON_ALIASES = Object.freeze({
  bookmark: 'Bookmark', bookmarks: 'Bookmark', favorite: 'Star', favourites: 'Star',
  favorites: 'Star', note: 'StickyNote', notes: 'StickyNote', collection: 'StickyNote',
  history: 'Clock', download: 'Download', downloads: 'Download',
  extension: 'Puzzle', extensions: 'Puzzle', plugin: 'Puzzle', plugins: 'Blocks',
  theme: 'Palette', themes: 'Palette', pin: 'Pin', pinned: 'Pin',
  shield: 'Shield', security: 'Shield', settings: 'Settings', gear: 'Settings',
  search: 'Search', globe: 'Globe', world: 'Globe', list: 'List',
  grid: 'LayoutGrid', layers: 'Layers', folder: 'Folder',
  ai: 'Sparkles', assistant: 'Sparkles', bot: 'Bot', chat: 'MessageSquare', message: 'MessageSquare',
  window: 'AppWindow', tabs: 'AppWindow', archive: 'Archive'
})

/**
 * 图标名归一：精确注册名 → 去掉非字母数字后不区分大小写 → 语义别名 → 空串。
 *
 * `bookmark` / `Bookmark` / `BOOKMARK` / `book-mark` 四种写法归一到同一颗；
 * 仍不认识的返回空串 —— 由调用方决定回落形态（渲染层回落 Puzzle）。
 * @param {unknown} name
 * @returns {string} 注册名；未知为空串
 */
export function normalizeIconName(name: unknown): string {
  const raw = String(name == null ? '' : name).trim()
  if (!raw) return ''
  if (KNOWN.has(raw)) return raw
  const compact = raw.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  if (!compact) return ''
  for (const key of ICON_NAMES) {
    if (key.toLowerCase() === compact) return key
  }
  return (ICON_ALIASES as Readonly<Record<string, string>>)[compact] || ''
}

/**
 * 这个名字能不能直接当图标用（注册名或别名）。
 * @param {unknown} name
 */
export function isKnownIcon(name: unknown): boolean {
  return normalizeIconName(name) !== ''
}

/**
 * 给作者 / AI 的合法图标清单（排序后的注册名）。
 * 提示词里直接列它，比让模型猜"有没有 bookmark"可靠得多。
 */
export const ICON_NAME_SUGGESTIONS = Object.freeze([...ICON_NAMES].sort())
