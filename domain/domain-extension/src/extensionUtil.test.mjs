import { describe, it, expect } from 'vitest';
import {
  idOf,
  validateVersionString,
  normalizedVersion,
  isValidManifest,
  manifestVersion,
  collectPermissions,
  translatePermissionName,
  translatePermissionNames,
  matchHostPattern,
  sortPermissions,
  contentScriptTargets,
  extensionLabel,
  isManifestV3,
  messageKeyOf,
  localeChainOf,
  localizedManifestText,
  UI_LOCALE_PREFERENCE,
  formatBytes,
} from './extensionUtil';

describe('idOf', () => {
  it('优先返回 manifest.id', () => {
    expect(idOf({ id: 'abc', name: 'x' })).toBe('abc');
  });

  it('无 id 时从 Host permission 派生稳定伪 id', () => {
    const a = idOf({ host_permissions: ['https://a.example.com/*'], name: 'x' });
    const b = idOf({ host_permissions: ['https://a.example.com/*'], name: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it('无 id 无 host_permissions 时从 name 派生', () => {
    const a = idOf({ name: 'hello world' });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it('边界：空对象 / 非对象 / 无任何可派生源均返回空串', () => {
    expect(idOf({})).toBe('');
    expect(idOf(null)).toBe('');
    expect(idOf('x')).toBe('');
  });
});

describe('validateVersionString', () => {
  it('典型三段合法返回 true', () => {
    expect(validateVersionString('1.2.3')).toBe(true);
    expect(validateVersionString('0.0.0')).toBe(true);
  });

  it('非法返回 false', () => {
    expect(validateVersionString('1.2')).toBe(false); // 缺一段
    expect(validateVersionString('1.2.3.4')).toBe(false); // 多一段
    expect(validateVersionString('abc')).toBe(false); // 非数字
    expect(validateVersionString('1.2.x')).toBe(false);
    expect(validateVersionString(1)).toBe(false);
    expect(validateVersionString('')).toBe(false);
  });
});

describe('normalizedVersion', () => {
  it('三段原样返回', () => {
    expect(normalizedVersion('1.2.3')).toBe('1.2.3');
  });

  it('补齐二段', () => {
    expect(normalizedVersion('1.2')).toBe('1.2.0');
  });

  it('补齐一段', () => {
    expect(normalizedVersion('1')).toBe('1.0.0');
  });

  it('边界：非法返回空串', () => {
    expect(normalizedVersion('1.2.3.4')).toBe('');
    expect(normalizedVersion('abc')).toBe('');
    expect(normalizedVersion('')).toBe('');
    expect(normalizedVersion(null)).toBe('');
  });
});

describe('isValidManifest / manifestVersion', () => {
  const v2 = { manifest_version: 2, name: 'n' };
  const v3 = { manifest_version: 3, name: 'n' };

  it('manifest_version 2|3 且含 name 为合法清单', () => {
    expect(isValidManifest(v2)).toBe(true);
    expect(isValidManifest(v3)).toBe(true);
  });

  it('边界：空对象 / 缺 name / 非法 manifest_version', () => {
    expect(isValidManifest({})).toBe(false);
    expect(isValidManifest(null)).toBe(false);
    expect(isValidManifest({ manifest_version: 3 })).toBe(false);
    expect(isValidManifest({ manifest_version: 1, name: 'n' })).toBe(false);
  });

  it('manifestVersion 返回数字，非法返回 0', () => {
    expect(manifestVersion(v3)).toBe(3);
    expect(manifestVersion(v2)).toBe(2);
    expect(manifestVersion({})).toBe(0);
    expect(manifestVersion({ manifest_version: 5 })).toBe(0);
  });
});

describe('collectPermissions', () => {
  it('汇合三个字段并去重（保序）', () => {
    const m = {
      permissions: ['storage', 'tabs', 'storage'],
      optional_permissions: ['notifications'],
      host_permissions: ['https://*/*'],
    };
    expect(collectPermissions(m)).toEqual(['storage', 'tabs', 'notifications', 'https://*/*']);
  });

  it('边界：空 manifest / 缺数组字段返回空数组', () => {
    expect(collectPermissions({})).toEqual([]);
    expect(collectPermissions(null)).toEqual([]);
    expect(collectPermissions({ permissions: 'storage' })).toEqual([]);
  });
});

describe('translatePermissionName', () => {
  it('典型权限名翻译成中文', () => {
    expect(translatePermissionName('storage')).toBe('存储');
    expect(translatePermissionName('geolocation')).toBe('地理位置');
    expect(translatePermissionName('notifications')).toBe('通知');
    expect(translatePermissionName('tabs')).toBe('标签页');
    expect(translatePermissionName('downloads')).toBe('下载');
  });

  it('大小写不敏感', () => {
    expect(translatePermissionName('STORAGE')).toBe('存储');
    expect(translatePermissionName('Notifications')).toBe('通知');
  });

  it('未知权限回退 fallback', () => {
    expect(translatePermissionName('frobnicate', { fallback: '未知' })).toBe('未知');
  });

  it('站点通配权限翻译成「读取数据」的中文表述（域名留在括号里）', () => {
    expect(translatePermissionName('<all_urls>')).toBe('读取你在所有网站上的数据');
    expect(translatePermissionName('https://*.example.com/*')).toBe(
      '读取你在指定网站上的数据（https://*.example.com/*）'
    );
  });

  it('边界：未收录权限不裸露代码名当主语；空值回退 fallback', () => {
    expect(translatePermissionName('frobnicate')).toBe('其它权限（frobnicate）');
    expect(translatePermissionName('frobnicate', { fallback: '未知' })).toBe('未知');
    expect(translatePermissionName('')).toBe('');
    expect(translatePermissionName('', { fallback: 'fb' })).toBe('fb');
  });
});

describe('translatePermissionNames', () => {
  it('批量翻译并按中文名去重，保持首次出现顺序', () => {
    expect(translatePermissionNames(['storage', 'tabs', 'storage', 'webRequestBlocking'])).toEqual([
      '存储',
      '标签页',
      '拦截网络请求'
    ]);
    expect(translatePermissionNames([])).toEqual([]);
    expect(translatePermissionNames(null)).toEqual([]);
  });
});

describe('matchHostPattern', () => {
  it('<all_urls> 匹配 http/https', () => {
    expect(matchHostPattern('<all_urls>', 'https://example.com/x')).toBe(true);
    expect(matchHostPattern('<all_urls>', 'http://a.com/')).toBe(true);
    expect(matchHostPattern('<all_urls>', 'file:///x')).toBe(false);
  });

  it('*://host/* 匹配任意协议 host', () => {
    expect(matchHostPattern('*://example.com/*', 'https://example.com/a')).toBe(true);
    expect(matchHostPattern('*://example.com/*', 'http://example.com/b')).toBe(true);
  });

  it('主机通配 *.example.com', () => {
    expect(matchHostPattern('https://*.example.com/*', 'https://sub.example.com/x')).toBe(true);
    expect(matchHostPattern('https://*.example.com/*', 'https://haha.example.com/x')).toBe(true);
    expect(matchHostPattern('https://*.example.com/*', 'https://other.org/x')).toBe(false);
    // 通配仅限子域，裸域也匹配
    expect(matchHostPattern('https://*.example.com/*', 'https://example.com/x')).toBe(true);
  });

  it('路径通配', () => {
    expect(matchHostPattern('https://example.com/foo/*', 'https://example.com/foo/bar')).toBe(true);
    expect(matchHostPattern('https://example.com/*', 'https://example.com/anything')).toBe(true);
    expect(matchHostPattern('https://example.com/foo/bar', 'https://example.com/foo/bar')).toBe(true);
    expect(matchHostPattern('https://example.com/foo/bar', 'https://example.com/foo/baz')).toBe(false);
  });

  it('边界：空串 / 类型错误返回 false', () => {
    expect(matchHostPattern('', 'https://x.com/')).toBe(false);
    expect(matchHostPattern('https://x.com/*', '')).toBe(false);
    expect(matchHostPattern(null, 'https://x.com/')).toBe(false);
  });
});

describe('sortPermissions', () => {
  it('按 order 优先级排序，未知排最后', () => {
    expect(sortPermissions(['tabs', 'storage', 'zzz'], ['storage', 'tabs'])).toEqual([
      'storage',
      'tabs',
      'zzz',
    ]);
  });

  it('空 order 保持原相对顺序', () => {
    expect(sortPermissions(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('边界：非数组返回空数组', () => {
    expect(sortPermissions(null, [])).toEqual([]);
  });
});

describe('contentScriptTargets', () => {
  it('展开所有 matches 去重', () => {
    const m = {
      content_scripts: [
        { matches: ['https://a.com/*'] },
        { matches: ['https://b.com/*', 'https://a.com/*'] },
      ],
    };
    expect(contentScriptTargets(m)).toEqual(['https://a.com/*', 'https://b.com/*']);
  });

  it('过滤无效（空缺 / 非字符串）', () => {
    const m = {
      content_scripts: [
        { matches: ['', 'https://c.com/*'] },
        {},
        'nonsense',
      ],
    };
    expect(contentScriptTargets(m)).toEqual(['https://c.com/*']);
  });

  it('边界：空 manifest / 无 content_scripts 返回空数组', () => {
    expect(contentScriptTargets({})).toEqual([]);
    expect(contentScriptTargets(null)).toEqual([]);
  });
});

describe('extensionLabel', () => {
  it('取 name 去空白', () => {
    expect(extensionLabel({ name: '  My Ext  ' })).toBe('My Ext');
  });

  it('无 name 用 fallback', () => {
    expect(extensionLabel({}, '  Fallback  ')).toBe('Fallback');
    expect(extensionLabel(null, 'f')).toBe('f');
  });

  it('边界：均无返回空串', () => {
    expect(extensionLabel({})).toBe('');
  });
});

describe('isManifestV3', () => {
  it('manifest_version===3 返回 true', () => {
    expect(isManifestV3({ manifest_version: 3 })).toBe(true);
  });

  it('其余返回 false', () => {
    expect(isManifestV3({ manifest_version: 2 })).toBe(false);
    expect(isManifestV3({})).toBe(false);
    expect(isManifestV3(null)).toBe(false);
  });
});

describe('messageKeyOf', () => {
  it('整串 __MSG_xxx__ 取出消息名', () => {
    expect(messageKeyOf('__MSG_extName__')).toBe('extName');
    expect(messageKeyOf('__MSG_app_description__')).toBe('app_description');
  });

  it('不是占位写法返回空串（含「串内嵌占位」—— 与 RT 一致只认整串）', () => {
    expect(messageKeyOf('我的扩展')).toBe('');
    expect(messageKeyOf('__MSG_extName__ - 副标题')).toBe('');
    expect(messageKeyOf('')).toBe('');
    expect(messageKeyOf(null)).toBe('');
    expect(messageKeyOf({ message: 'x' })).toBe('');
  });
});

describe('localeChainOf', () => {
  it('默认中文优先，再接 default_locale', () => {
    expect(localeChainOf('en')).toEqual(['zh_CN', 'zh', 'zh_TW', 'en']);
    expect(UI_LOCALE_PREFERENCE).toEqual(['zh_CN', 'zh', 'zh_TW']);
  });

  it('去重且保持顺序（default_locale 已在链上就不重复追加）', () => {
    expect(localeChainOf('zh_CN')).toEqual(['zh_CN', 'zh', 'zh_TW']);
  });

  it('无 default_locale 时只剩界面语言优先级；可自定义优先级', () => {
    expect(localeChainOf(undefined)).toEqual(['zh_CN', 'zh', 'zh_TW']);
    expect(localeChainOf('ja', ['ja_JP'])).toEqual(['ja_JP', 'ja']);
  });

  it('边界：非法项被过滤，空串不进入链', () => {
    expect(localeChainOf('   ')).toEqual(['zh_CN', 'zh', 'zh_TW']);
    expect(localeChainOf('en', [null, '', '  '])).toEqual(['en']);
  });
});

describe('localizedManifestText', () => {
  const messages = {
    zh_CN: { extName: { message: '我的扩展' }, onlyZh: { message: '简体专属' } },
    zh: { extName: { message: '我的扩展（通用）' } },
    default_en: { extName: { message: 'My Extension' } },
  };

  it('命中当前语言（简体优先）', () => {
    expect(localizedManifestText('__MSG_extName__', messages, localeChainOf('default_en')))
      .toBe('我的扩展');
  });

  it('区域 → 语言逐级回退：简体没有该 key 时落到 zh', () => {
    expect(localizedManifestText('__MSG_onlyZh__', messages, ['zh_CN', 'zh'])).toBe('简体专属');
    expect(localizedManifestText('__MSG_extName__', { zh: messages.zh, default_en: messages.default_en }, ['zh_CN', 'zh', 'default_en']))
      .toBe('我的扩展（通用）');
  });

  it('语言没有时回退 default_locale', () => {
    expect(localizedManifestText('__MSG_extName__', { default_en: messages.default_en }, ['zh_CN', 'zh', 'default_en']))
      .toBe('My Extension');
  });

  it('全都没命中 / 没有消息表 → 原样退回清单原文', () => {
    expect(localizedManifestText('__MSG_missing__', messages, ['zh_CN', 'zh'])).toBe('__MSG_missing__');
    expect(localizedManifestText('__MSG_extName__', null, ['zh_CN'])).toBe('__MSG_extName__');
    expect(localizedManifestText('__MSG_extName__', {}, ['zh_CN'])).toBe('__MSG_extName__');
  });

  it('非占位原文 / 空值 / 坏消息条目都安全退化，不抛错', () => {
    expect(localizedManifestText('我的扩展', messages, ['zh_CN'])).toBe('我的扩展');
    expect(localizedManifestText(undefined, messages, ['zh_CN'])).toBe('');
    expect(localizedManifestText('__MSG_extName__', { zh_CN: { extName: { message: '' } } }, ['zh_CN']))
      .toBe('__MSG_extName__');
    expect(localizedManifestText('__MSG_extName__', { zh_CN: { extName: null } }, ['zh_CN']))
      .toBe('__MSG_extName__');
    // 回退链缺失：拿不到 locale 列表时也退化到原文
    expect(localizedManifestText('__MSG_extName__', messages, null)).toBe('__MSG_extName__');
  });
});

describe('formatBytes', () => {
  it('二进制换算并保留一位小数（整数不带 .0）', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(Math.round(1.2 * 1024 * 1024))).toBe('1.2 MB');
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
  });

  it('边界：非法输入返回空串（调用方据此不显示「大小」这一行）', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes('1024')).toBe('');
  });
});
