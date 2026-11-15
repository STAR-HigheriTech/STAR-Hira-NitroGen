import { execFile } from 'node:child_process'
import fs from 'node:fs'
import {
  parsePwaIntegrations,
  type PwaFileHandler,
  type PwaProtocolHandler
} from '@hira-ng/domain-pwa'
import { APP_NAME } from '@hira-ng/shared-types/src/associations.mjs'
import { buildPwaArgs } from '../app/pwa-args'
import { toAumid } from './identity'

interface PwaIntegrationRecord {
  id: string
  name?: string
  shortName?: string | null
  startUrl: string
  manifestJson?: string | null
}

interface SystemIntegrationPolicy {
  enabled: boolean
  reason?: string
}

interface PwaIntegrationsOptions {
  getProfileId(): string
  resolveIconPath?(appId: string, profileId: string): string | null
  getSystemIntegrationPolicy?(): SystemIntegrationPolicy
  executablePath?: string
}

interface SyncResult {
  ok: boolean
  supported: boolean
  files: number
  protocols: number
  error?: string
}

const PWA_DISPLAY_NAME = `${APP_NAME} PWA`
const LEGACY_PWA_DISPLAY_NAME = 'HiraNG PWA'

function safeSegment(value: unknown): string {
  return String(value || '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'app'
}

function runReg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (error) => resolve(!error))
  })
}

function add(key: string, name: string, value: string): Promise<boolean> {
  const args = ['add', `HKCU\\${key}`]
  if (name) args.push('/v', name)
  else args.push('/ve')
  args.push('/t', 'REG_SZ', '/d', value, '/f')
  return runReg(args)
}

function delValue(key: string, name: string): Promise<boolean> {
  const args = ['delete', `HKCU\\${key}`]
  if (name) args.push('/v', name)
  else args.push('/ve')
  args.push('/f')
  return runReg(args)
}

function delKey(key: string): Promise<boolean> {
  return runReg(['delete', `HKCU\\${key}`, '/f'])
}

function commandLine(exe: string, appId: string, profileId: string, payload: 'file' | 'url'): string {
  const args = buildPwaArgs({ appId, profileId, isPackaged: true })
  return `"${exe}" ${args.join(' ')} --pwa-${payload}="%1"`
}

/**
 * PWA 的文件 / 协议关联。
 *
 * 只写 HKCU 的“默认应用能力”和 OpenWithProgids，不篡改 UserChoice。
 * 开发态整体关闭；System Integration 的判定由组合根注入，不在这里偷看 app.isPackaged。
 */
function createPwaIntegrations(options: PwaIntegrationsOptions) {
  const { getProfileId, resolveIconPath, getSystemIntegrationPolicy, executablePath } = options
  const platformSupported = process.platform === 'win32'
  const executable = String(executablePath || '')
  const policy = typeof getSystemIntegrationPolicy === 'function'
    ? getSystemIntegrationPolicy()
    : { enabled: true }
  const supported = platformSupported && policy.enabled === true && !!executable && fs.existsSync(executable)

  async function sync(record: PwaIntegrationRecord): Promise<SyncResult> {
    if (!platformSupported) return { ok: true, supported: false, files: 0, protocols: 0 }
    if (!supported) return { ok: true, supported: false, files: 0, protocols: 0 }

    let parsed: { files: PwaFileHandler[]; protocols: PwaProtocolHandler[] }
    try {
      const manifest = record.manifestJson ? JSON.parse(record.manifestJson) : null
      parsed = parsePwaIntegrations(manifest, record.startUrl)
    } catch (error) {
      return { ok: false, supported: true, files: 0, protocols: 0, error: error instanceof Error ? error.message : String(error) }
    }
    if (!parsed.files.length && !parsed.protocols.length) {
      return { ok: true, supported: true, files: 0, protocols: 0 }
    }

    const appId = safeSegment(record.id)
    const profileId = String(getProfileId() || 'default')
    const appName = String(record.shortName || record.name || appId)
    const appAumid = toAumid(record.id)
    const icon = resolveIconPath?.(record.id, profileId) || ''
    const root = `Software\\HiraNG\\PWA\\${appId}`
    const cap = `${root}\\Capabilities`
    const fileProgId = `HiraNG.PWA.${appId}.File`
    const urlProgId = `HiraNG.PWA.${appId}.URL`
    const fileKey = `Software\\Classes\\${fileProgId}`
    const urlKey = `Software\\Classes\\${urlProgId}`
    const iconValue = icon ? `"${icon}",0` : `"${executable}",0`
    let ok = true

    const defineProgId = async (key: string, label: string, payload: 'file' | 'url'): Promise<void> => {
      ok = await add(key, '', label) && ok
      ok = await add(`${key}\\Application`, 'AppUserModelId', appAumid) && ok
      ok = await add(`${key}\\Application`, 'ApplicationName', appName) && ok
      ok = await add(`${key}\\Application`, 'ApplicationIcon', iconValue) && ok
      ok = await add(`${key}\\DefaultIcon`, '', iconValue) && ok
      ok = await add(`${key}\\shell\\open\\command`, '', commandLine(executable, record.id, profileId, payload)) && ok
    }

    await defineProgId(fileKey, appName, 'file')
    await defineProgId(urlKey, `${appName} 链接`, 'url')
    ok = await add(urlKey, 'FriendlyTypeName', `${appName} 链接`) && ok
    ok = await add(urlKey, 'URL Protocol', '') && ok

    ok = await add(cap, 'ApplicationName', appName) && ok
    ok = await add(cap, 'ApplicationIcon', iconValue) && ok
    ok = await add(cap, 'ApplicationDescription', `${appName} · ${PWA_DISPLAY_NAME}`) && ok
    ok = await add('Software\\RegisteredApplications', `${PWA_DISPLAY_NAME} ${appName}`, cap) && ok

    for (const handler of parsed.files) {
      for (const ext of handler.extensions) {
        ok = await add(`${cap}\\FileAssociations`, ext, fileProgId) && ok
        ok = await add(`Software\\Classes\\${ext}\\OpenWithProgids`, fileProgId, '') && ok
      }
    }

    for (const handler of parsed.protocols) {
      // URLAssociations 才能让协议出现在 Windows“默认应用”里。旧实现把它
      // 写进 OpenWithProgids（那是文件扩展名的结构），这里顺手清掉历史误写。
      await delValue(`Software\\Classes\\${handler.protocol}\\OpenWithProgids`, urlProgId)
      ok = await add(`${cap}\\URLAssociations`, handler.protocol, urlProgId) && ok
    }

    return {
      ok,
      supported: true,
      files: parsed.files.reduce((sum, handler) => sum + handler.extensions.length, 0),
      protocols: parsed.protocols.length
    }
  }

  async function remove(record: PwaIntegrationRecord): Promise<void> {
    if (!platformSupported) return
    let parsed: { files: PwaFileHandler[]; protocols: PwaProtocolHandler[] }
    try {
      const manifest = record.manifestJson ? JSON.parse(record.manifestJson) : null
      parsed = parsePwaIntegrations(manifest, record.startUrl)
    } catch {
      return
    }
    const appId = safeSegment(record.id)
    const appName = String(record.shortName || record.name || appId)
    const fileProgId = `HiraNG.PWA.${appId}.File`
    const urlProgId = `HiraNG.PWA.${appId}.URL`
    await delValue('Software\\RegisteredApplications', `${PWA_DISPLAY_NAME} ${appName}`)
    await delValue('Software\\RegisteredApplications', `${LEGACY_PWA_DISPLAY_NAME} ${appName}`)
    for (const handler of parsed.files) {
      for (const ext of handler.extensions) await delValue(`Software\\Classes\\${ext}\\OpenWithProgids`, fileProgId)
    }
    for (const handler of parsed.protocols) {
      await delValue(`Software\\Classes\\${handler.protocol}\\OpenWithProgids`, urlProgId)
    }
    await delKey(`Software\\Classes\\${fileProgId}`)
    await delKey(`Software\\Classes\\${urlProgId}`)
    await delKey(`Software\\HiraNG\\PWA\\${appId}`)
  }

  return { sync, remove, supported }
}

export { createPwaIntegrations }
