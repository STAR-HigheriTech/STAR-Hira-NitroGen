import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createL10n } = require('../dist/index.cjs')

describe('infra-l10n', () => {
  it('loads locales and translates', () => {
    const l10n = createL10n({ locale: 'zh-CN', fallbackLocale: 'en' })
    expect(l10n.t('common.ok')).toBe('确定')
    expect(l10n.t('missing.key')).toBe('missing.key')
  })
})

