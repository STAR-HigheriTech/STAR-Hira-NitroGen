import { buildUpsertKey, domainOf } from './password-utils'
import type { PasswordImportSourceRow } from './types'

export const DELIMITERS = [',', ';', '\t'] as const

export const HEADER_ALIASES = Object.freeze({
  url: ['url', 'website', 'weburl', 'hostname', 'domain', 'site', 'link', 'loginurl', 'loginuri', 'uri', 'origin'],
  username: ['username', 'user', 'userid', 'login', 'loginname', 'loginusername', 'email', 'emailaddress', 'account', 'accountname'],
  password: ['password', 'pass', 'passwd', 'pwd', 'loginpassword']
})

type CredentialField = keyof typeof HEADER_ALIASES
type HeaderMap = Record<CredentialField, number>

export interface ParsedCredentialCsv {
  rows: PasswordImportSourceRow[]
  skipped: number
}

export function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[\s_-]+/g, '')
    .trim()
}

export function detectDelimiter(text: unknown): string {
  const firstLine = String(text || '').split(/\r\n|\n|\r/, 1)[0] || ''
  const counts = new Map<string, number>(DELIMITERS.map((delimiter) => [delimiter, 0]))
  let inQuotes = false
  for (let index = 0; index < firstLine.length; index++) {
    const character = firstLine[index]
    if (character === '"') {
      if (inQuotes && firstLine[index + 1] === '"') {
        index++
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && counts.has(character)) counts.set(character, (counts.get(character) || 0) + 1)
  }
  let delimiter = ','
  let count = 0
  for (const candidate of DELIMITERS) {
    const nextCount = counts.get(candidate) || 0
    if (nextCount > count) {
      delimiter = candidate
      count = nextCount
    }
  }
  return delimiter
}

export function parseCsv(text: unknown, delimiter = ','): string[][] {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }

  while (index < source.length) {
    const character = source[index]
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index++
        continue
      }
      field += character
      index++
      continue
    }
    if (character === '"' && field === '') {
      inQuotes = true
      index++
      continue
    }
    if (character === delimiter) {
      endField()
      index++
      continue
    }
    if (character === '\r') {
      endRow()
      index += source[index + 1] === '\n' ? 2 : 1
      continue
    }
    if (character === '\n') {
      endRow()
      index++
      continue
    }
    field += character
    index++
  }

  if (field !== '' || row.length > 0) endRow()
  return rows
}

export function classifyHeader(headerRow: readonly string[]): HeaderMap | null {
  if (!Array.isArray(headerRow) || !headerRow.length) return null
  const map: HeaderMap = { url: -1, username: -1, password: -1 }
  for (let index = 0; index < headerRow.length; index++) {
    const key = normalizeHeader(headerRow[index])
    if (!key) continue
    for (const field of Object.keys(map) as CredentialField[]) {
      if (map[field] === -1 && HEADER_ALIASES[field].includes(key)) {
        map[field] = index
        break
      }
    }
  }
  return map.url === -1 || map.password === -1 ? null : map
}

export function parseCredentialCsv(text: unknown): ParsedCredentialCsv {
  const source = typeof text === 'string' ? text : ''
  const parsed = parseCsv(source, detectDelimiter(source))
    .filter((row) => row.some((cell) => cell.trim() !== ''))
  if (!parsed.length) return { rows: [], skipped: 0 }

  const headerMap = classifyHeader(parsed[0])
  const columns = headerMap || { url: 0, username: 1, password: 2 }
  const dataRows = headerMap ? parsed.slice(1) : parsed
  const picked = new Map<string, PasswordImportSourceRow>()
  let skipped = 0

  for (const row of dataRows) {
    const cell = (index: number, trim: boolean): string => {
      if (index < 0 || index >= row.length) return ''
      const value = String(row[index] ?? '')
      return trim ? value.trim() : value
    }
    const domain = domainOf(cell(columns.url, true))
    const username = cell(columns.username, true)
    const password = cell(columns.password, false)
    if (!domain || !username || !password) {
      skipped++
      continue
    }
    const key = buildUpsertKey(domain, username)
    if (picked.has(key)) skipped++
    picked.set(key, { domain, username, password })
  }

  return { rows: Array.from(picked.values()), skipped }
}
