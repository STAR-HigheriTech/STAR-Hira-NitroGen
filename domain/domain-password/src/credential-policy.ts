import { buildUpsertKey, canonicalDomain } from './password-utils'
import type { PasswordSuggestion, SavedCredential } from './types'

export function mergeSuggestionRows(
  primary: readonly PasswordSuggestion[] | null | undefined,
  extra: readonly PasswordSuggestion[] | null | undefined
): PasswordSuggestion[] {
  const seen = new Set<string>()
  const rows: PasswordSuggestion[] = []
  for (const row of [...(primary || []), ...(extra || [])]) {
    if (!row) continue
    const key = `${String(row.username ?? '')}\u0000${String(row.password ?? '')}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  return rows
}

export function mergeCredentialRows(
  primary: readonly SavedCredential[] | null | undefined,
  extra: readonly SavedCredential[] | null | undefined
): SavedCredential[] {
  const seen = new Set<string>()
  const rows: SavedCredential[] = []
  for (const row of [...(primary || []), ...(extra || [])]) {
    if (!row) continue
    const domain = canonicalDomain(row.domain) || row.domain
    const key = buildUpsertKey(domain, row.username)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ ...row, domain })
  }
  return rows
}
