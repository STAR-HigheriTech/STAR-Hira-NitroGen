import { TOTP_ALGORITHMS, TOTP_DIGITS } from '@hira-ng/shared-types/src/totp.mjs'
import type {
  ClockCalibration,
  TotpAlgorithm,
  TotpMetadata,
  TotpType
} from './types'

export const MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000
export const EMPTY_CLOCK: Readonly<ClockCalibration> = Object.freeze({
  offsetMs: 0,
  measuredAt: 0,
  source: null
})

const algorithms = new Set<TotpAlgorithm>(TOTP_ALGORITHMS as TotpAlgorithm[])
const digitOptions = new Set<6 | 8>(TOTP_DIGITS as Array<6 | 8>)
const types = new Set<TotpType>(['TOTP', 'HOTP'])

export function normalizeSecret(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase()
}

export function normalizeMetadata(input: unknown): TotpMetadata {
  const source = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {}
  const algorithm = String(source.algorithm || '').toUpperCase() as TotpAlgorithm
  const type = String(source.type || '').toUpperCase() as TotpType
  const digits = Number(source.digits) as 6 | 8
  const period = Number(source.period)
  const counter = Number(source.counter)
  return {
    issuer: String(source.issuer ?? '').trim(),
    account: String(source.account ?? '').trim(),
    algorithm: algorithms.has(algorithm) ? algorithm : 'SHA1',
    digits: digitOptions.has(digits) ? digits : 6,
    period: Number.isFinite(period) && period > 0 ? Math.floor(period) : 30,
    type: types.has(type) ? type : 'TOTP',
    counter: Number.isFinite(counter) && counter > 0 ? Math.floor(counter) : 0
  }
}

export function normalizeClock(input: unknown): ClockCalibration | null {
  const source = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {}
  const offsetMs = Number(source.offsetMs)
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > MAX_CLOCK_OFFSET_MS) return null
  const measuredAt = Number(source.measuredAt)
  return {
    offsetMs: Math.round(offsetMs),
    measuredAt: Number.isFinite(measuredAt) && measuredAt > 0 ? Math.round(measuredAt) : 0,
    source: source.source ? String(source.source) : null
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
