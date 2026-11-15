export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'
export type TotpType = 'TOTP' | 'HOTP'
export type TotpChangeReason = 'import' | 'update' | 'remove' | 'clock'

export interface TotpMetadata {
  issuer: string
  account: string
  algorithm: TotpAlgorithm
  digits: 6 | 8
  period: number
  type: TotpType
  counter: number
}

export interface TotpEntry extends TotpMetadata {
  id: string
  createdAt: number
  updatedAt: number
}

export interface TotpRow extends TotpMetadata {
  id: string
  profileId: string
  secretCipher: string
  createdAt: number
  updatedAt: number
}

export interface TotpChange {
  reason: TotpChangeReason
  id: string | null
}

export interface ClockCalibration {
  offsetMs: number
  measuredAt: number
  source: string | null
}

export interface ClockMeasurement extends Partial<ClockCalibration> {
  rttMs?: number
}

export interface TotpCode {
  id: string
  code: string
  type: TotpType
  remaining: number | null
  period: number | null
}

export interface TotpCodeSnapshot {
  codes: TotpCode[]
  now: number
  unavailable: string[]
  clock: ClockCalibration
}

export interface TotpAddInput extends Partial<Omit<TotpMetadata, 'algorithm' | 'digits' | 'type'>> {
  algorithm?: string
  digits?: number
  type?: string
  secret?: string
}

export interface TotpUpdateInput extends TotpAddInput {}

export interface TotpCodeInput {
  id?: string
}

export interface TotpImportInput {
  uris?: readonly string[]
}

export interface TotpImportSkip {
  index: number
  reason: string
}

export interface TotpCryptoProvider {
  name?: string
  reason?: string
  isAvailable?: () => boolean
  encrypt: (plain: string) => string | null
  decrypt: (cipher: string) => string | null
}

export interface TotpServiceOptions {
  crypto?: TotpCryptoProvider
  getProfileId?: () => string
  kvDb?: unknown
  measureTime?: () => Promise<ClockMeasurement>
}

export type TotpSuccess<T> = { ok: true } & T
export type TotpFailure = { ok: false; reason: string }
export type TotpAddResult = TotpSuccess<{ entry: TotpEntry }> | TotpFailure
export type TotpUpdateResult = TotpSuccess<{ entry: TotpEntry }> | TotpFailure
export type TotpRemoveResult = { ok: true } | TotpFailure
export type TotpExportResult = TotpSuccess<{ uri: string }> | TotpFailure
export type TotpImportResult = TotpSuccess<{
  added: TotpEntry[]
  skipped: TotpImportSkip[]
}>
export type TotpCalibrationResult = TotpSuccess<{
  reset?: boolean
  offsetMs: number
  measuredAt: number
  source: string | null
  rttMs?: number | null
}> | TotpFailure

export type TotpChangeListener = (change: TotpChange) => void

export interface TotpService {
  list(): TotpEntry[]
  code(input?: TotpCodeInput): TotpCodeSnapshot
  calibrate(input?: { reset?: boolean }): Promise<TotpCalibrationResult>
  add(input: TotpAddInput): TotpAddResult
  importUris(input?: TotpImportInput): TotpImportResult
  update(id: string, patch?: TotpUpdateInput): TotpUpdateResult
  remove(id: string): TotpRemoveResult
  exportUri(id: string): TotpExportResult
  subscribe(listener: TotpChangeListener): () => void
  isEncryptionAvailable(): boolean
}

export interface TotpRepository {
  list(profileId: string): TotpRow[]
  find(profileId: string, id: string): TotpRow | null
  insert(row: TotpRow): void
  update(profileId: string, id: string, values: Partial<TotpRow>): void
  remove(profileId: string, id: string): void
}

export interface ParsedOtpUri {
  metadata: TotpMetadata
  secret: string
}

export interface OtpEngine {
  isEncryptionAvailable(): boolean
  encryptionFailureReason(): string
  encrypt(secret: string): string | null
  decrypt(cipher: string | null | undefined): string | null
  validate(metadata: TotpMetadata, secret: string): boolean
  generate(row: TotpMetadata, secret: string, timestamp: number): Omit<TotpCode, 'id'>
  exportUri(metadata: TotpMetadata, secret: string): string
  parseUri(uri: string): ParsedOtpUri
}

export interface ClockStore {
  snapshot(): ClockCalibration
  save(value: unknown): ClockCalibration
}
