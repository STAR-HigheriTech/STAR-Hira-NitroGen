import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { shell } from 'electron'
import {
  DOWNLOAD_RULES_SETTING_KEY,
  parseDownloadRules,
  resolveDownloadRule,
  type DownloadRuleAction
} from '@hira-ng/shared-types/src/download-rules.mjs'

interface SettingsPort {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

interface DownloadOrganizerOptions {
  emit?(route: string, payload: Record<string, unknown>): void
  runAction?(action: DownloadRuleAction, input: { url: string; filename: string; filePath: string }): unknown
  slots?: { multi(id: string, payload: unknown): unknown[] } | null
}

const VERIFY_INDEX_KEY = 'download.verification_index'

function createDownloadOrganizer(settings: SettingsPort, options: DownloadOrganizerOptions = {}) {
  function resolveSavePath(input: {
    url: string
    filename: string
    mimeType?: string
    directory: string
  }): { directory: string; filename: string } {
    const match = resolveDownloadRule(
      parseDownloadRules(settings.get(DOWNLOAD_RULES_SETTING_KEY)),
      input
    )
    if (!match) return { directory: input.directory, filename: input.filename }
    return {
      directory: path.join(input.directory, match.folder),
      filename: match.filename
    }
  }

  function readIndex(): Array<{ id: string; path: string; hash: string; at: number }> {
    try {
      const parsed = JSON.parse(String(settings.get(VERIFY_INDEX_KEY) || '[]'))
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.hash && item.path).slice(0, 500) : []
    } catch {
      return []
    }
  }

  async function verifyCompleted(input: {
    id: string
    filePath: string
    url?: string
    filename?: string
  }): Promise<{ sha256: string; duplicateOf?: string } | null> {
    const target = String(input.filePath || '')
    if (!target || !fs.existsSync(target)) return null
    const hash = await new Promise<string>((resolve, reject) => {
      const digest = crypto.createHash('sha256')
      const stream = fs.createReadStream(target)
      stream.on('data', (chunk) => digest.update(chunk))
      stream.on('end', () => resolve(digest.digest('hex')))
      stream.on('error', reject)
    }).catch(() => '')
    if (!hash) return null
    const index = readIndex()
    const duplicate = index.find((item) => item.hash === hash && item.path !== target && fs.existsSync(item.path))
    const next = [
      { id: input.id, path: target, hash, at: Date.now() },
      ...index.filter((item) => item.path !== target && item.id !== input.id)
    ].slice(0, 500)
    settings.set(VERIFY_INDEX_KEY, JSON.stringify(next))
    const result = { sha256: hash, ...(duplicate ? { duplicateOf: duplicate.path } : {}) }
    try { options.emit?.('download:verified', { id: input.id, ...result }) } catch {}
    const match = resolveDownloadRule(
      parseDownloadRules(settings.get(DOWNLOAD_RULES_SETTING_KEY)),
      {
        url: String(input.url || ''),
        filename: String(input.filename || path.basename(target))
      }
    )
    for (const action of match?.actions || []) {
      try {
        if (action === 'open-file') await shell.openPath(target)
        else if (action === 'show-in-folder') shell.showItemInFolder(target)
        else {
          const download = {
            url: String(input.url || ''),
            filename: String(input.filename || path.basename(target)),
            filePath: target
          }
          const handled = await options.runAction?.(action, download)
          if (!handled) {
            const provider = (options.slots?.multi('download.rule-action', { action, download }) || [])
              .find((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).id || '') === action) as Record<string, unknown> | undefined
            if (typeof provider?.run === 'function') await provider.run(download)
          }
        }
      } catch (error) {
        console.warn('[download-organizer] post action failed:', action, error)
      }
    }
    return result
  }

  return { resolveSavePath, verifyCompleted }
}

export { createDownloadOrganizer }
