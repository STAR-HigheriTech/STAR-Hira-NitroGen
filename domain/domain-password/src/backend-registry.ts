import type { PasswordBackend, RegisterBackendOptions } from './types'

export class PasswordBackendRegistry {
  private readonly backends = new Map<string, PasswordBackend>()
  private activeName: string

  constructor(
    private readonly fallbackName = 'builtin',
    initialActiveName = fallbackName
  ) {
    this.activeName = initialActiveName || fallbackName
  }

  register(backend: PasswordBackend, options: RegisterBackendOptions = {}): boolean {
    const name = String(backend?.name || '').trim()
    if (!name) return false
    if (this.backends.has(name) && !options.replace) return false
    this.backends.set(name, backend)
    if (!this.backends.has(this.activeName)) this.activeName = this.fallbackName
    return true
  }

  unregister(name: string): boolean {
    if (!name || name === this.fallbackName || !this.backends.has(name)) return false
    this.backends.delete(name)
    if (!this.backends.has(this.activeName)) this.activeName = this.fallbackName
    return true
  }

  has(name: string): boolean {
    return this.backends.has(name)
  }

  get(name: string): PasswordBackend | undefined {
    return this.backends.get(name)
  }

  list(): PasswordBackend[] {
    return Array.from(this.backends.values())
  }

  setActive(name: string): boolean {
    if (!this.backends.has(name)) return false
    this.activeName = name
    return true
  }

  activeNameValue(): string {
    return this.activeName
  }

  active(): PasswordBackend | undefined {
    return this.backends.get(this.activeName) || this.backends.get(this.fallbackName)
  }

  fallbackForActive(): PasswordBackend | null {
    const backend = this.active()
    if (backend?.canWrite === false) return this.backends.get(this.fallbackName) || null
    return null
  }

  fallback(): PasswordBackend | undefined {
    return this.backends.get(this.fallbackName)
  }
}
