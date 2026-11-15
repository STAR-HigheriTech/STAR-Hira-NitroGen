/**
 * Small, dependency-free primitives shared by static internal pages.
 */
export function requiredElement<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document
): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`Page element ${selector} is unavailable`)
  return element as unknown as T
}

export function requiredById<T extends HTMLElement = HTMLElement>(id: string): T {
  return requiredElement<T>(`#${id}`)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value)
}

export function errorMessage(error: unknown, fallback = '未知错误'): string {
  if (error instanceof Error && error.message) return error.message
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message
  const text = String(error ?? '').trim()
  return text || fallback
}

export function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
