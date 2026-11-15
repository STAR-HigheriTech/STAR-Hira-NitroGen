/**
 * association-discovery.ts —— Windows 浏览器 peers 的动态关联面。
 *
 * 静态清单只描述 STAR Hira NitroGen 自己确定支持的核心类型；本模块负责把本机其他浏览器
 * 在 `StartMenuInternet\<Browser>\Capabilities` 中声明的新协议 / 新扩展名并集进来。
 * 纯解析、无 Electron / registry 依赖，运行期与生成脚本可使用同一套规则。
 */

import type { AssociationContribution } from './associations.js'

export interface AssociationSurface {
  files: Set<string>
  protocols: Set<string>
}

/** 永远不进入浏览器文档候选的类别。 */
export const UNSAFE_ASSOCIATION_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.msi', '.scr', '.cpl', '.dll', '.sys'
])

export function createAssociationSurface(): AssociationSurface {
  return { files: new Set(), protocols: new Set() }
}

/**
 * 解析 `reg query ...\StartMenuInternet /s` 的文本。
 *
 * 不扫描全 HKCR：只有浏览器明确放进 Capabilities 的项才属于“浏览器关联面”。
 * 未知项会保留，因此 peers 新增 scheme / 文档格式时不需要升级 STAR Hira NitroGen 白名单。
 */
export function parseBrowserAssociationSurface(
  output: string,
  surface: AssociationSurface = createAssociationSurface(),
  excludedApp = 'STAR Hira NitroGen'
): AssociationSurface {
  let section: 'file' | 'url' | null = null
  let sourceApp = ''

  for (const line of String(output || '').split(/\r?\n/)) {
    const keyMatch = /^\s*(HKEY_[A-Z_]+\\[^\r\n]+)$/i.exec(line)
    if (keyMatch) {
      const parts = String(keyMatch[1] || '').split('\\')
      const browserAt = parts.findIndex((part, index) => (
        part.toLowerCase() === 'startmenuinternet' && index === 3
      ))
      const capabilitiesAt = parts.findIndex((part) => part.toLowerCase() === 'capabilities')
      sourceApp = browserAt >= 0 ? String(parts[browserAt + 1] || '') : ''
      const tail = capabilitiesAt >= 0 ? parts[capabilitiesAt + 1]?.toLowerCase() || '' : ''
      section = tail === 'fileassociations' ? 'file' : tail === 'urlassociations' ? 'url' : null
      continue
    }
    if (!section || !sourceApp || sourceApp.toLowerCase() === excludedApp.toLowerCase()) continue
    const valueMatch = /^\s+(.+?)\s+REG_[A-Z_]+\s*/i.exec(line)
    if (!valueMatch) continue
    const name = String(valueMatch[1] || '').trim().toLowerCase()
    if (!name) continue
    if (section === 'file') {
      const ext = name.startsWith('.') ? name : `.${name}`
      if (
        /^\.[a-z0-9][a-z0-9._+-]*$/i.test(ext) &&
        !UNSAFE_ASSOCIATION_EXTENSIONS.has(ext)
      ) {
        surface.files.add(ext)
      }
    } else if (/^[a-z][a-z0-9+.-]*$/.test(name)) {
      surface.protocols.add(name)
    }
  }

  return surface
}

/**
 * peers 只提供候选资格：除 http/https 外，未知协议不参与默认浏览器状态，
 * 因而不可能因为某个第三方应用声明了一个奇怪 scheme 就替用户改默认。
 */
export function associationContributionFromSurface(
  surface: AssociationSurface,
  id = 'windows-browser-peers'
): AssociationContribution {
  return {
    id,
    files: Array.from(surface.files).sort().map((ext) => ({ ext, tier: 'document' })),
    protocols: Array.from(surface.protocols).sort().map((scheme) => ({
      scheme,
      defaultBrowser: scheme === 'http' || scheme === 'https'
    }))
  }
}
