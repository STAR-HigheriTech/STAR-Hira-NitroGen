/**
 * 内置 section 注册入口。
 *
 * 未来插件追加站点信息块时，**不需要改这里**：在自己的模块里
 * `registerSection(...)` 即可（注册表按 order 自动排序）。
 * 本文件只负责把浏览器自带的信息块装进注册表。
 */

import { registerSection } from './registry.js'
import { identitySection } from './identity.js'
import { certificateSection } from './certificate.js'
import { permissionsSection } from './permissions.js'
import { siteDataSection } from './site-data.js'
import { blockingSection } from './blocking.js'
import { footerSection } from './footer.js'

let registered = false

/** 幂等：重复调用不会产生重复 section（注册表同 id 原位替换）。 */
export function registerBuiltinSections() {
  if (registered) return
  registered = true
  registerSection(identitySection)
  registerSection(certificateSection)
  registerSection(permissionsSection)
  registerSection(siteDataSection)
  registerSection(blockingSection)
  registerSection(footerSection)
}

