/**
 * extension 域 · 服务侧接线桥单测（零 Electron / 零依赖）。
 *
 * 覆盖真实服务关键路径的纯规则接线：
 *   - 清单加载前置校验 validateManifestForLoad（installFromPath/Crx 落点）
 *   - 权限组装 buildExtensionMeta（collectPermissions + sortPermissions + translatePermissionName）
 *   - 注入匹配 matchesScriptTarget（contentScriptTargets + matchHostPattern）
 *   - 列表 key/展示（idOf / extensionLabel / normalizedVersion）
 */
import { describe, it, expect } from 'vitest'
import {
  validateManifestForLoad,
  buildExtensionMeta,
  matchesScriptTarget
} from './extensionWire'

const MV3_MANIFEST = {
  id: 'my-ext',
  name: '  My Extension  ',
  version: '1.2.3',
  manifest_version: 3,
  permissions: ['zzz-unknown', 'storage', 'tabs', 'tabs'],
  host_permissions: ['https://example.com/*'],
  content_scripts: [
    { matches: ['https://example.com/*', 'https://*.example.org/*'] },
    { matches: ['https://other.net/foo/*'] }
  ]
}

describe('validateManifestForLoad（清单加载前置校验）', () => {
  it('合法 MV3 清单通过并返回版本号', () => {
    expect(validateManifestForLoad(MV3_MANIFEST)).toEqual({ ok: true, manifestVersion: 3 })
  })

  it('MV2 同样通过', () => {
    expect(validateManifestForLoad({ name: 'x', manifest_version: 2 })).toEqual({ ok: true, manifestVersion: 2 })
  })

  it('缺 name / 非法 manifest_version / 非对象 → 拒绝并标注', () => {
    expect(validateManifestForLoad({ manifest_version: 3 })).toEqual({ ok: false, reason: 'invalid-manifest' })
    expect(validateManifestForLoad({ name: 'x', manifest_version: 1 })).toEqual({ ok: false, reason: 'invalid-manifest' })
    expect(validateManifestForLoad(null)).toEqual({ ok: false, reason: 'invalid-manifest' })
  })

  it('非法版本号 → 拒绝；二段/一段版本兼容 Chrome 写法', () => {
    expect(validateManifestForLoad({ name: 'x', manifest_version: 3, version: 'abc' })).toEqual({ ok: false, reason: 'invalid-version' })
    expect(validateManifestForLoad({ name: 'x', manifest_version: 3, version: '1.2.3.4' })).toEqual({ ok: false, reason: 'invalid-version' })
    expect(validateManifestForLoad({ name: 'x', manifest_version: 3, version: '1.0' })).toEqual({ ok: true, manifestVersion: 3 })
    expect(validateManifestForLoad({ name: 'x', manifest_version: 3, version: '2' })).toEqual({ ok: true, manifestVersion: 3 })
  })
})

describe('buildExtensionMeta（权限组装 + 展示信息）', () => {
  it('id/name/version 走 idOf/extensionLabel/normalizedVersion，列表 key 与展示', () => {
    const meta = buildExtensionMeta({ manifest: MV3_MANIFEST, id: 'runtime-id', name: 'Runtime Name' })
    // 运行时 id 是 chrome-extension:// 地址 / ECE 查找 / 安装记录 key 的唯一真源，
    // 必须优先于清单里的 id（Chrome 清单本身没有 id 字段）。
    expect(meta.id).toBe('runtime-id')
    expect(meta.name).toBe('My Extension')               // manifest.name 去空白
    expect(meta.version).toBe('1.2.3')
  })

  it('无 manifest.id 时从派生 id 落位（name/host 派生稳定伪 id）', () => {
    const manifest = { ...MV3_MANIFEST, id: undefined }
    const meta = buildExtensionMeta({ manifest })
    expect(meta.id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('权限去重、按优先级排序、翻译成中文标签', () => {
    const meta = buildExtensionMeta({ manifest: MV3_MANIFEST })
    // 'tabs' 在 order 中靠前，'zzz-unknown' 未知排最后
    expect(meta.permissionNames[0]).toBe('storage')
    expect(meta.permissionNames).toContain('tabs')
    expect(meta.permissionNames[meta.permissionNames.length - 1]).toBe('zzz-unknown')
    // 标签：storage→存储 / tabs→标签页；未收录权限加兜底前缀，不裸露代码名当主语
    expect(meta.permissions).toContain('存储')
    expect(meta.permissions).toContain('标签页')
    expect(meta.permissions).toContain('其它权限（zzz-unknown）')
  })

  it('归一化清单派生 isV3 / manifestVersion / contentScripts', () => {
    const meta = buildExtensionMeta({ manifest: MV3_MANIFEST })
    expect(meta.isValid).toBe(true)
    expect(meta.isV3).toBe(true)
    expect(meta.manifestVersion).toBe(3)
    expect(meta.contentScripts).toEqual(['https://example.com/*', 'https://*.example.org/*', 'https://other.net/foo/*'])
  })

  it('缺 manifest 时返回全空安全值（不抛错）', () => {
    const meta = buildExtensionMeta({ id: 'x' })
    expect(meta.id).toBe('x')
    expect(meta.permissionNames).toEqual([])
    expect(meta.permissions).toEqual([])
    expect(meta.contentScripts).toEqual([])
    expect(meta.isValid).toBe(false)
    expect(meta.isV3).toBe(false)
  })

  it('来源与商店地址：本地扩展没有可打开的商店页时不编造 URL', () => {
    // 样例清单既无 homepage_url 也无 update_url（本地加载的未打包扩展）
    const meta = buildExtensionMeta({ manifest: MV3_MANIFEST })
    expect(meta.source).toBe('local')
    expect(meta.storeUrl).toBe('')
  })

  it('来源与商店地址：带 update_url 视为商店扩展，回落商店详情路由', () => {
    const meta = buildExtensionMeta({
      manifest: { ...MV3_MANIFEST, update_url: 'https://clients2.google.com/service/update2/crx' }
    })
    expect(meta.source).toBe('store')
    expect(meta.storeUrl).toBe('https://chrome.google.com/webstore/detail/my-ext')
  })

  it('来源与商店地址：清单自带 homepage_url 时优先用它', () => {
    const meta = buildExtensionMeta({ manifest: { ...MV3_MANIFEST, homepage_url: 'https://example.com/ext' } })
    expect(meta.storeUrl).toBe('https://example.com/ext')
  })

  it('本地化名称 / 描述：用 _locales 展开值覆盖清单原文（中文优先）', () => {
    const manifest = {
      ...MV3_MANIFEST,
      name: '__MSG_extName__',
      description: '__MSG_extDesc__',
      default_locale: 'en'
    }
    // locales 由 infra 读盘得到（域层只做纯展开），链是「中文优先 → default_locale」
    const meta = buildExtensionMeta({ manifest }, {
      locales: {
        zh_CN: { extName: { message: '我的扩展' }, extDesc: { message: '中文描述' } },
        en: { extName: { message: 'My Extension' }, extDesc: { message: 'English description' } }
      }
    })
    expect(meta.name).toBe('我的扩展')
    expect(meta.description).toBe('中文描述')
  })

  it('本地化回退：中文缺失 → default_locale → 清单原文', () => {
    const manifest = { ...MV3_MANIFEST, name: '__MSG_extName__', default_locale: 'en' }
    expect(buildExtensionMeta({ manifest }, {
      locales: { en: { extName: { message: 'English Name' } } }
    }).name).toBe('English Name')
    expect(buildExtensionMeta({ manifest }, { locales: {} }).name).toBe('__MSG_extName__')
  })

  it('不传 locales（例如端口缺失）时行为与改造前一致', () => {
    const meta = buildExtensionMeta({ manifest: MV3_MANIFEST })
    expect(meta.name).toBe('My Extension')
    expect(meta.description).toBe('')
  })
})

describe('matchesScriptTarget（注入匹配）', () => {
  it('命中 content_scripts 的 matches 返回 true', () => {
    expect(matchesScriptTarget(MV3_MANIFEST, 'https://example.com/page')).toBe(true)
    expect(matchesScriptTarget(MV3_MANIFEST, 'https://sub.example.org/x')).toBe(true)
    expect(matchesScriptTarget(MV3_MANIFEST, 'https://other.net/foo/bar')).toBe(true)
  })

  it('未命中 / 无 content_scripts / 非法输入返回 false', () => {
    expect(matchesScriptTarget(MV3_MANIFEST, 'https://unrelated.org/')).toBe(false)
    expect(matchesScriptTarget({}, 'https://x.com/')).toBe(false)
    expect(matchesScriptTarget(null, 'https://x.com/')).toBe(false)
  })
})
