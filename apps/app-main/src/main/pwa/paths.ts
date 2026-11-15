/**
 * PWA 资产路径 —— **全项目唯一拼接点**。
 *
 * 为什么必须只有一处：
 *  · 协议处理器（hira-pwa://）按 profileId 找目录；
 *  · 安装管线写图标；
 *  · 更新 / 卸载删目录；
 *  · 窗口按 appId 取图标。
 * 四处各自 `path.join(userData, 'profiles', ...)` 必然漂移（本项目的既有教训）。
 *
 * 因此这里**不自己猜 userData**：由 main.js 把已有的 `resolveProfileDir` 注入进来，
 * 与 profile 目录的唯一口径（main.js#resolveProfileDir）保持同源。
 */

import fs from 'node:fs'
import path from 'node:path'

export interface PwaPathsOptions { resolveProfileDir(profileId: string): string }

export interface ResolvedPwaIcon { file: string; full: string }

export interface PwaPaths {
  root(profileId: string): string
  assetDir(profileId: string, appId: string): string
  stagingDir(profileId: string, appId: string, nonce: string | number): string
  backupDir(profileId: string, appId: string, nonce: string | number): string
  assetPath(profileId: string, appId: string, file: unknown): string
  manifestPath(profileId: string, appId: string): string
  iconUrl(profileId: string, appId: string, file?: string): string
  resolveIconAsset(profileId: string, appId: string, order?: readonly string[]): ResolvedPwaIcon | null
  assertAppId: typeof assertAppId
  APP_ID_RE: RegExp
  SERVABLE_FILES: readonly string[]
  FILE_MIME: Readonly<Record<string, string>>
  WINDOW_ICON_ORDER: readonly string[]
  UI_ICON_ORDER: readonly string[]
}

/** appId 形态由 domain-pwa#makeAppId 决定（pwa- + sha256 前 16 位）。 */
export const APP_ID_RE = /^pwa-[a-f0-9]{16}$/

/** 允许通过 hira-pwa:// 读取的文件（白名单，杜绝任意文件读）。 */
export const SERVABLE_FILES: readonly string[] = Object.freeze([
  'icon-512.png',
  'icon-192.png',
  'icon-32.png',
  'icon.ico',
  // SVG 图标（favicon 常见形态）：installIconAssets 走 SVG 分支时只产出它
  'icon.svg'
])

export const FILE_MIME: Readonly<Record<string, string>> = Object.freeze({
  'icon-512.png': 'image/png',
  'icon-192.png': 'image/png',
  'icon-32.png': 'image/png',
  'icon.ico': 'image/x-icon',
  'icon.svg': 'image/svg+xml'
})

/**
 * 窗口图标（任务栏 / Alt-Tab / 标题栏）候选顺序。
 * `.ico` 优先 —— Windows 任务栏与开始菜单对多尺寸 ico 的呈现最稳；
 * 其余按清晰度降序，`icon.svg` 兜底（SVG 分支只产出它）。
 */
export const WINDOW_ICON_ORDER: readonly string[] = Object.freeze(['icon.ico', 'icon-512.png', 'icon-32.png', 'icon.svg'])

/**
 * 渲染层 `<img>` 的候选顺序：浏览器可渲染的位图优先，
 * 小尺寸 png 在 16~20px 下比 512 更锐利，所以放在 512 之前。
 */
export const UI_ICON_ORDER: readonly string[] = Object.freeze(['icon-32.png', 'icon-192.png', 'icon-512.png', 'icon.svg', 'icon.ico'])

export function assertAppId(appId: unknown): string {
  const value = String(appId == null ? '' : appId)
  if (!APP_ID_RE.test(value)) throw new Error(`非法 appId: ${value}`)
  return value
}

/**
 * @param {{ resolveProfileDir: (profileId: string) => string }} ports
 */
export function createPwaPaths({ resolveProfileDir }: PwaPathsOptions): PwaPaths {
  if (typeof resolveProfileDir !== 'function') {
    throw new TypeError('createPwaPaths 需要注入 resolveProfileDir（profile 目录的唯一口径）')
  }

  /** `<profileDir>/pwa` */
  function root(profileId: string): string {
    return path.join(resolveProfileDir(profileId), 'pwa')
  }

  /** `<profileDir>/pwa/<appId>` */
  function assetDir(profileId: string, appId: string): string {
    return path.join(root(profileId), assertAppId(appId))
  }

  /** 安装时的临时目录（写完整后再整体替换，失败不污染旧版本）。 */
  function stagingDir(profileId: string, appId: string, nonce: string | number): string {
    return path.join(root(profileId), `${assertAppId(appId)}.tmp-${nonce}`)
  }

  function backupDir(profileId: string, appId: string, nonce: string | number): string {
    return path.join(root(profileId), `${assertAppId(appId)}.old-${nonce}`)
  }

  /** 资产文件绝对路径（文件名必须在白名单内，且结果必须仍在 app 目录下）。 */
  function assetPath(profileId: string, appId: string, file: unknown): string {
    const name = String(file == null ? '' : file)
    if (!SERVABLE_FILES.includes(name)) throw new Error(`非法资产文件名: ${name}`)
    const dir = assetDir(profileId, appId)
    const full = path.resolve(dir, name)
    if (full !== path.join(dir, name)) throw new Error('资产路径越界')
    return full
  }

  /** manifest 快照（更新 diff 的唯一依据，不对外提供）。 */
  function manifestPath(profileId: string, appId: string): string {
    return path.join(assetDir(profileId, appId), 'manifest.json')
  }

  /**
   * 下发给渲染层的图标地址。**绝不传绝对路径。**
   * `p` 必须显式携带：协议请求没有 sender 上下文，解析不到 profile。
   */
  function iconUrl(profileId: string, appId: string, file = 'icon-512.png'): string {
    const name = SERVABLE_FILES.includes(file) ? file : 'icon-512.png'
    return `hira-pwa://${assertAppId(appId)}/${name}?p=${encodeURIComponent(String(profileId || 'default'))}`
  }

  /**
   * 按候选顺序找**第一个真实存在**的图标资产。
   *
   * 为什么不能直接信 DB 里的 `iconPath`：那里存的是**相对文件名**（如 `icon-512.png`），
   * 直接 `fs.existsSync(相对名)` 会相对当前工作目录 → 永远落空（任务栏没图标的老 bug）。
   * 唯一正确口径就是这里的绝对路径。
   *
   * @param {string} profileId
   * @param {string} appId
   * @param {readonly string[]} [order]
   * @returns {{ file: string, full: string } | null}
   */
  function resolveIconAsset(profileId: string, appId: string, order?: readonly string[]): ResolvedPwaIcon | null {
    const files = Array.isArray(order) && order.length ? order : UI_ICON_ORDER
    for (const file of files) {
      try {
        const full = assetPath(profileId, appId, file)
        if (fs.existsSync(full)) return { file, full }
      } catch (_) {}
    }
    return null
  }

  return {
    root,
    assetDir,
    stagingDir,
    backupDir,
    assetPath,
    manifestPath,
    iconUrl,
    resolveIconAsset,
    assertAppId,
    APP_ID_RE,
    SERVABLE_FILES,
    FILE_MIME,
    WINDOW_ICON_ORDER,
    UI_ICON_ORDER
  }
}

