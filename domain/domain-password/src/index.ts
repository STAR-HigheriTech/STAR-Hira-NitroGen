export { PasswordBackendRegistry } from './backend-registry'
export { createBuiltinBackend, createKeychainBackend } from './builtin-backend'
export {
  BITWARDEN_DOWNLOAD_LINKS,
  BITWARDEN_INSTALL_MODE,
  createBitwardenBackend,
  parseItems,
  sanitizeDomain
} from './backends/bitwarden-backend'
export {
  ONEPASSWORD_DOWNLOAD_LINKS,
  ONEPASSWORD_MIN_VERSION,
  ONEPASSWORD_SESSION_TTL_MS,
  compareVersion,
  createOnePasswordBackend,
  matchItemIds,
  normalizeHost,
  parseItemCredentials
} from './backends/onepassword-backend'
export { mergeCredentialRows, mergeSuggestionRows } from './credential-policy'
export {
  DELIMITERS,
  HEADER_ALIASES,
  classifyHeader,
  detectDelimiter,
  normalizeHeader,
  parseCredentialCsv,
  parseCsv
} from './credential-csv'
export {
  createDrizzleNeverSaveRepository,
  createDrizzlePasswordRepository
} from './drizzle-password-repository'
export { createNeverSavePolicy } from './never-save-policy'
export { createPasswordService } from './password-service'
export {
  COMMON_PASSWORDS,
  buildUpsertKey,
  canonicalDomain,
  domainLevelDomains,
  domainOf,
  filterMatchingCredentials,
  hasClass,
  isWeakPassword,
  maskPassword,
  matchesNeverSave,
  mergeSuggestions,
  normalizeUsername,
  passwordIssues,
  passwordStrength,
  sortCredentialsByRecency
} from './password-utils'
export type * from './types'
