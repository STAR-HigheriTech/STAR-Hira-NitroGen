/**
 * external-games/catalog.ts — 外部 bundle 目录（插件点）
 *
 * 扫描 out/external/games/<id>/game.json，生成游戏目录索引。
 *
 * 「自描述 bundle」约定：一个游戏 = 一个目录 + 一个 game.json
 *   external/games/<id>/
 *     ├── game.json     ← 元数据（本文件读取）
 *     └── index.html    ← 入口（entry 可指定其它文件）
 *
 * 因此**新增一个游戏不需要改任何代码**：丢目录即可被自动发现。
 *
 * game.json 字段（除 name 外全部可选，缺省有兜底）：
 *   id          唯一标识，默认取目录名；也是 hira-game://<id>/ 的 host
 *   name        显示名（缺失则跳过该 bundle）
 *   description 一句话描述
 *   category    分组名，默认「其他」
 *   icon        卡片图标（emoji 或文字）
 *   accent      卡片强调色（CSS 颜色）
 *   entry       入口 HTML，默认 index.html
 *   tags        string[]，展示用标签
 *   variants    [{ name, entry, icon }]，同一 bundle 内的多个玩法/关卡
 *   source      来源出处（署名）
 *   license     许可证
 */

import fs from 'node:fs'
import path from 'node:path'

const fsp = fs.promises

const { firstExistingDir } = require('../static-serve') as {
  firstExistingDir(candidates: string[]): string
}

interface GameVariantSource {
  name?: unknown
  entry?: unknown
  icon?: unknown
}

interface GameManifest {
  id?: unknown
  name?: unknown
  description?: unknown
  category?: unknown
  icon?: unknown
  accent?: unknown
  entry?: unknown
  tags?: unknown
  variants?: unknown
  source?: unknown
  license?: unknown
  [key: string]: unknown
}

export interface GameVariant {
  name: string
  entry: string
  icon: string
  url: string
}

export interface GameEntry {
  id: string
  name: string
  description: string
  category: string
  icon: string
  accent: string
  tags: string[]
  entry: string
  url: string
  variants: GameVariant[]
  source: string
  license: string
}

export interface GameCatalogOptions {
  root?: string
  dir?: string
  label?: string
}

interface GameListOptions {
  refresh?: boolean
  sync?: boolean
}

export interface GameCatalog {
  readonly root: string
  list(options: GameListOptions & { sync: true }): GameEntry[]
  list(options?: GameListOptions): Promise<GameEntry[]>
  get(id: unknown): GameEntry | null
  getAsync(id: unknown): Promise<GameEntry | null>
  prewarm(): void
  invalidate(): void
}

function asManifest(value: unknown): GameManifest | null {
  return value !== null && typeof value === 'object' ? value as GameManifest : null
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** hira-game:// 协议名。改这里即改全局（协议注册、URL 生成同源）。 */
export const GAME_SCHEME = 'hira-game'

/**
 * 定位 out/external/games。
 * 本文件既可能被打包进 out/main/index.js（__dirname = out/main），
 * 也可能作为独立文件落在 out/main/external-games/（copy 插件会原样拷贝），两种都探测。
 * @param {string} [dir] 用于测试注入
 */
export function resolveGamesRoot (dir?: string): string {
  const base = dir || __dirname
  return firstExistingDir([
    path.join(base, '..', 'external', 'games'),
    path.join(base, '..', '..', 'external', 'games')
  ])
}

/**
 * 把一个 game.json 规范化成对外 DTO。缺 name 视为无效。
 */
export function normalizeGame (meta: unknown, dirName: string): GameEntry | null {
  const manifest = asManifest(meta)
  if (!manifest) return null
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  if (!name) return null

  const id = String(manifest.id || dirName).trim().toLowerCase()
  if (!id) return null

  const entry = typeof manifest.entry === 'string' && manifest.entry ? manifest.entry : 'index.html'
  const url = `${GAME_SCHEME}://${id}/${entry.replace(/^\/+/, '')}`

  const variants: GameVariant[] = Array.isArray(manifest.variants)
    ? (manifest.variants as GameVariantSource[])
      .filter((variant): variant is GameVariantSource & { entry: string } =>
        !!variant && typeof variant.entry === 'string' && variant.entry.length > 0)
      .map((variant) => ({
        name: String(variant.name || variant.entry),
        entry: variant.entry,
        icon: typeof variant.icon === 'string' ? variant.icon : '',
        url: `${GAME_SCHEME}://${id}/${variant.entry.replace(/^\/+/, '')}`
      }))
    : []

  return {
    id,
    name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    category: typeof manifest.category === 'string' && manifest.category ? manifest.category : '其他',
    icon: typeof manifest.icon === 'string' && manifest.icon ? manifest.icon : '🎮',
    accent: typeof manifest.accent === 'string' ? manifest.accent : '',
    tags: Array.isArray(manifest.tags) ? manifest.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    entry,
    url,
    variants,
    source: typeof manifest.source === 'string' ? manifest.source : '',
    license: typeof manifest.license === 'string' ? manifest.license : ''
  }
}

export function createGameCatalog (opts: GameCatalogOptions = {}): GameCatalog {
  const root = opts.root || resolveGamesRoot(opts.dir)
  const label = opts.label || 'external-games'
  let cache: GameEntry[] | null = null
  let inflight: Promise<GameEntry[]> | null = null

  /**
   * 异步扫描（走 fsp 线程池，不阻塞主进程）+ 写入缓存。
   * 多个并发请求复用同一 inflight，避免重复扫盘。
   */
  async function scanAsync (): Promise<GameEntry[]> {
    if (cache) return cache
    if (!inflight) {
      inflight = (async () => {
        const games: GameEntry[] = []
        let entries: fs.Dirent[] = []
        try {
          entries = await fsp.readdir(root, { withFileTypes: true })
        } catch (e) {
          console.warn(`[${label}] games root unreadable:`, root, errorMessage(e))
          return games
        }

        for (const e of entries) {
          if (!e.isDirectory()) continue
          if (e.name.startsWith('_') || e.name.startsWith('.')) continue
          const metaPath = path.join(root, e.name, 'game.json')
          try {
            const raw = await fsp.readFile(metaPath, 'utf8')
            const meta = JSON.parse(raw)
            const game = normalizeGame(meta, e.name)
            if (game) games.push(game)
            else console.warn(`[${label}] invalid game.json (needs "name"):`, metaPath)
          } catch (err) {
            if (errorCode(err) !== 'ENOENT') {
              console.warn(`[${label}] bad game.json:`, metaPath, errorMessage(err))
            }
          }
        }

        games.sort(sortGames)
        cache = games
        return games
      })()
    }
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function list(options: GameListOptions & { sync: true }): GameEntry[]
  function list(options?: GameListOptions): Promise<GameEntry[]>
  function list (options: GameListOptions = {}): GameEntry[] | Promise<GameEntry[]> {
    // sync 参数仅用于需要同步读当前缓存的极少数场景（默认禁用）
    if (options.sync) {
      if (options.refresh) cache = null
      return cache || []
    }
    if (options.refresh) cache = null
    return scanAsync()
  }

  return {
    root,
    /**
     * 异步取列表：读缓存或在后台扫描；`list()` 不再同步扫盘。
     * 同步语义（立即返回已缓存列表）默认关闭，避免交互热路上卡主进程。
     * @param {{ refresh?: boolean, sync?: boolean }} [o]
     * @returns {Promise<object[]>|object[]}
     */
    list,
    /** 同步取单个游戏（协议 404 校验用，走缓存；缓存未就绪则返回 null）。 */
    get (id) {
      const key = String(id || '').toLowerCase()
      return (cache || []).find((g) => g.id === key) || null
    },
    /** 异步取单个游戏；缓存未就绪时等待扫描完成后查找。 */
    async getAsync (id) {
      const key = String(id || '').toLowerCase()
      const all = await scanAsync()
      return all.find((g) => g.id === key) || null
    },
    /** 预热：在应用就绪后空闲时异步扫描，供首次打开游戏页前填好缓存。 */
    prewarm () {
      scanAsync().catch(() => {})
    },
    /** 清缓存（开发期热更新目录用） */
    invalidate () { cache = null }
  }
}

/** 游戏列表排序：同名/同分类按中文拼音排，不同分类按分类排。 */
function sortGames (a: GameEntry, b: GameEntry): number {
  return a.category === b.category
    ? a.name.localeCompare(b.name, 'zh-Hans-CN')
    : a.category.localeCompare(b.category, 'zh-Hans-CN')
}

