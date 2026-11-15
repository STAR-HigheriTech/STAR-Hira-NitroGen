export type LooseRecord = Record<string, unknown>

export function isRecord(value: unknown): value is LooseRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function recordOf(value: unknown): LooseRecord {
  return isRecord(value) ? value : {}
}

export const asRecord = recordOf

export function arrayOf<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

export function stringOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value)
}

export function numberOf(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return isRecord(error) && error.message != null ? String(error.message) : String(error)
}
