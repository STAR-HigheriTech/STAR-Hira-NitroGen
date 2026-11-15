/**
 * main/file-open/policy.ts —— 「拖进来的这个文件该怎么打开」的**唯一判定点**。
 *
 * ── 为什么单独成层 ─────────────────────────────────────────────────
 * 「哪些类型浏览器能渲染」是会变的（新增 pdf 阅读器、内置压缩包预览……），
 * 而「拖入 → 新标签 / 系统默认」的搬运逻辑不该跟着改。于是：
 *   · 本文件只做**分类**（纯函数，不认识 electron / fs / 窗口）；
 *   · service.ts 只做**执行**（读 stat、开标签、调系统默认）。
 * 新增一类文件 = 注册一个 provider，不动 service，也不动 IPC / preload。
 *
 * ── provider 契约（插件扩展点）──────────────────────────────────────
 * {
 *   id: string,                 // 唯一标识；重复注册以后者为准（便于热重载）
 *   priority?: number,          // 大者优先，默认 0
 *   classify(info): 'tab' | 'external' | 'reveal' | null,
 *   open?(info, ctx): boolean | Promise<boolean>  // 可选：完全接管打开动作
 * }
 *
 * `info` = { path, name, ext, isDirectory, exists }，由 service 填好。
 *
 * 返回 null = 「我不认识，交给下一个 provider」；全部返回 null 时兜底 external。
 * provider 抛错只告警并跳过 —— 一个写坏的插件不能让别人连文件都拖不进来。
 */

import path from 'node:path'

export type FileOpenTarget = 'tab' | 'external' | 'reveal'

export interface FileOpenInfo {
  path: string
  name?: string
  ext?: string
  exists?: boolean
  isDirectory?: boolean
}

export interface InspectedFileInfo extends FileOpenInfo {
  name: string
  ext: string
  exists: boolean
  isDirectory: boolean
}

export interface FileOpenProviderContext {
  tabManager?: unknown
  openInBackground: boolean
}

export interface FileOpenProvider {
  id: string
  priority?: number
  classify?(info: FileOpenInfo): FileOpenTarget | null
  open?(info: InspectedFileInfo, context: FileOpenProviderContext): boolean | Promise<boolean>
}

export interface RegisteredFileOpenProvider {
  readonly id: string
  readonly priority: number
  readonly classify: ((info: FileOpenInfo) => FileOpenTarget | null) | null
  readonly open: ((info: InspectedFileInfo, context: FileOpenProviderContext) => boolean | Promise<boolean>) | null
  readonly seq: number
}

export interface FileOpenDecision {
  target: FileOpenTarget
  provider: RegisteredFileOpenProvider | null
}

export interface FileOpenPolicy {
  register(provider: FileOpenProvider | null | undefined): () => void
  unregister(id: string): void
  classify(info: FileOpenInfo): FileOpenDecision
  list(): Array<{ id: string; priority: number; canOpen: boolean }>
}

/** 浏览器能直接渲染的扩展名（小写、不带点）。 */
const RENDERABLE_EXTENSIONS = new Set([
  // 网页 / 文档
  'html', 'htm', 'xhtml', 'xht', 'shtml', 'mht', 'mhtml', 'pdf',
  // 图片
  'png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
  // 音视频
  'mp4', 'm4v', 'webm', 'ogv', 'ogg', 'oga', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'opus', 'weba',
  // 纯文本 / 源码（Chromium 以等宽文本渲染）
  'txt', 'text', 'log', 'md', 'markdown', 'mdx',
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson',
  'xml', 'xsl', 'xslt', 'csv', 'tsv',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env',
  'css', 'scss', 'sass', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'map',
  'sql', 'graphql', 'gql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua',
  'vue', 'svelte', 'astro',
  'patch', 'diff'
])

/**
 * 明确**可执行 / 可加载**的扩展名。
 *
 * 它们绝不能被 `shell.openPath` 打开 —— 那是「双击运行」。用户只是把文件拖进
 * 浏览器窗口，不该因此启动一个程序。这类文件走 'reveal'：在文件管理器里定位。
 * 这也是 Chrome 的语义（拖入 exe 不会执行，最多提示风险）。
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'com', 'bat', 'cmd', 'msi', 'msix', 'appx', 'msixbundle', 'appxbundle',
  'scr', 'pif', 'cpl', 'hta', 'vbs', 'vbe', 'wsf', 'wsh', 'lnk',
  'jar', 'ps1', 'ps1xml', 'psm1', 'psd1',
  'dll', 'sys', 'ocx', 'drv', 'so', 'dylib',
  'app', 'run', 'command', 'sh', 'bash', 'zsh', 'fish'
])

/**
 * 从绝对路径拆出判定所需的静态信息（不碰磁盘）。
 * `exists` / `isDirectory` 由 service 在 stat 之后补上。
 * @param {string} filePath
 */
export function fileInfoOf(filePath: string): { path: string; name: string; ext: string } {
  const base = path.basename(filePath)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  return { path: filePath, name: base, ext }
}

/** 内置 provider —— 顺序即优先级（数字越大越先问）。 */
export function createBuiltinProviders(): FileOpenProvider[] {
  return [
    {
      id: 'core.directory',
      priority: 100,
      // 目录交给系统文件管理器；浏览器没有可靠的目录列表视图（Electron 下是空白/报错）。
      classify: (info) => (info.isDirectory ? 'external' : null)
    },
    {
      id: 'core.executable',
      priority: 90,
      classify: (info) => (info.ext && EXECUTABLE_EXTENSIONS.has(info.ext) ? 'reveal' : null)
    },
    {
      id: 'core.renderable',
      priority: 80,
      classify: (info) => (info.ext && RENDERABLE_EXTENSIONS.has(info.ext) ? 'tab' : null)
    },
    {
      id: 'core.no-extension-text',
      priority: 10,
      // 无扩展名（LICENSE / Makefile / README …）按文本打开，这是浏览器的既有行为。
      // 目录已在最高优先级被拦走，所以这里不会误伤。
      classify: (info) => (!info.ext ? 'tab' : null)
    },
    {
      id: 'core.system-default',
      priority: 0,
      classify: () => 'external'
    }
  ]
}

const VALID_TARGETS = new Set<FileOpenTarget>(['tab', 'external', 'reveal'])

function isFileOpenTarget(value: unknown): value is FileOpenTarget {
  return typeof value === 'string' && VALID_TARGETS.has(value as FileOpenTarget)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 */
export function createFileOpenPolicy({ providers }: { providers?: readonly FileOpenProvider[] } = {}): FileOpenPolicy {
  let entries: RegisteredFileOpenProvider[] = []
  let seq = 0
  /** 排序缓存：注册表变化时失效。classify 在每次拖放里被调用 N 次，不值得每帧重排。 */
  let ordered: RegisteredFileOpenProvider[] | null = null

  function invalidate() {
    ordered = null
  }

  function orderedEntries(): RegisteredFileOpenProvider[] {
    if (!ordered) {
      ordered = entries.slice().sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq))
    }
    return ordered
  }

  /**
   * 注册 / 覆盖一个 provider。
   * @returns {() => void} 撤销注册（若期间被同 id 覆盖，则只撤销自己那一份）
   */
  function register(provider: FileOpenProvider | null | undefined): () => void {
    if (!provider || !provider.id) return () => {}
    const entry = {
      id: String(provider.id),
      priority: Number.isFinite(provider.priority) ? Number(provider.priority) : 0,
      classify: typeof provider.classify === 'function' ? provider.classify : null,
      open: typeof provider.open === 'function' ? provider.open : null,
      seq: ++seq
    }
    entries = entries.filter((e) => e.id !== entry.id)
    entries.push(entry)
    invalidate()
    return () => {
      const before = entries.length
      entries = entries.filter((e) => e !== entry)
      if (entries.length !== before) invalidate()
    }
  }

  function unregister(id: string): void {
    const before = entries.length
    entries = entries.filter((e) => e.id !== String(id))
    if (entries.length !== before) invalidate()
  }

  /**
   * 判定一个文件。
   * @param {{ path:string, name?:string, ext?:string, isDirectory?:boolean }} info
   * @returns {{ target: 'tab'|'external'|'reveal', provider: any|null }}
   */
  function classify(info: FileOpenInfo): FileOpenDecision {
    const probe = info || { path: '' }
    for (const entry of orderedEntries()) {
      if (!entry.classify) continue
      let target: unknown = null
      try {
        target = entry.classify(probe)
      } catch (e) {
        console.warn(`[file-open] provider "${entry.id}" 判定失败（已跳过）:`, errorMessage(e))
        continue
      }
      if (target == null) continue
      if (!isFileOpenTarget(target)) {
        console.warn(`[file-open] provider "${entry.id}" 返回了未知目标 "${target}"（已跳过）`)
        continue
      }
      return { target, provider: entry }
    }
    return { target: 'external', provider: null }
  }

  /** 当前注册的 provider 摘要（诊断 / 插件列表用）。 */
  function list(): Array<{ id: string; priority: number; canOpen: boolean }> {
    return orderedEntries().map((e) => ({ id: e.id, priority: e.priority, canOpen: Boolean(e.open) }))
  }

  // 内置 provider 先注册；外部（插件）后注册同 id 会自然覆盖。
  const builtins = createBuiltinProviders()
  for (const provider of (Array.isArray(providers) ? providers : [])) builtins.push(provider)
  for (const provider of builtins) register(provider)

  return { register, unregister, classify, list }
}

