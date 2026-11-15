import type { UnknownRecord } from './types'

export const HOOKS = Object.freeze(['before', 'validate', 'around', 'after'] as const)
export const LIFECYCLE_PHASES = Object.freeze(['install', 'enable', 'disable', 'uninstall', 'dispose'] as const)

export type ProviderHookName = (typeof HOOKS)[number]
export type ProviderLifecyclePhase = (typeof LIFECYCLE_PHASES)[number]
export type ProviderContext = UnknownRecord
export interface ProviderExecution extends UnknownRecord {
  providerId: string
  capability: string
  input: unknown
  context: ProviderContext
  state: UnknownRecord
}
export type ProviderTerminal = (nextValue?: unknown) => unknown | Promise<unknown>
export type ProviderHook = (value: unknown, execution: ProviderExecution) => unknown
export type AroundProviderHook = (value: unknown, execution: ProviderExecution, terminal: ProviderTerminal) => unknown
export type ProviderLifecycleHook = (context: ProviderContext, execution: Omit<ProviderExecution, 'input' | 'state'> & { permissions: string[] }) => unknown

export interface ProviderHooksInput extends UnknownRecord {
  before?: ProviderHook
  validate?: ProviderHook
  around?: AroundProviderHook
  after?: ProviderHook
}

export interface ProviderInput extends UnknownRecord {
  id?: unknown
  name?: unknown
  capability?: unknown
  pluginId?: unknown
  priority?: unknown
  hooks?: ProviderHooksInput
  lifecycle?: Partial<Record<ProviderLifecyclePhase, ProviderLifecycleHook>>
  metadata?: UnknownRecord
  permissions?: unknown
  requiredPermissions?: unknown
  isDefault?: unknown
  default?: unknown
  allowOverride?: unknown
  enabled?: unknown
}

export interface ProviderRecord {
  id: string
  capability: string
  pluginId: string | null
  priority: number
  hooks: Partial<Record<ProviderHookName, ProviderHook | AroundProviderHook>>
  lifecycle: Partial<Record<ProviderLifecyclePhase, ProviderLifecycleHook>>
  metadata: UnknownRecord
  permissions: string[]
  isDefault: boolean
  allowOverride: boolean
  enabled: boolean
}

export interface ProviderDescription {
  id: string
  capability: string
  pluginId: string | null
  priority: number
  hooks: ProviderHookName[]
  lifecycle: ProviderLifecyclePhase[]
  metadata: UnknownRecord
  permissions: string[]
  isDefault: boolean
  allowOverride: boolean
  enabled: boolean
}

export interface ProviderRegistryOptions {
  defaultTimeoutMs?: number
  onError?: (error: unknown, execution: unknown) => void | Promise<void>
  authorize?: (permission: string, execution: ProviderExecution) => boolean | Promise<boolean>
}

export interface ServiceRegistrationOptions {
  override?: boolean
  pluginId?: string
  permissions?: unknown
  requiredPermissions?: unknown
}

interface ServiceEntry {
  service: unknown
  pluginId: string | null
  permissions: string[]
}

const isRecord = (value: unknown): value is UnknownRecord => !!value && typeof value === 'object' && !Array.isArray(value)

function normalizeId(value: unknown, label: string): string {
  const id = String(value || '').trim()
  if (!id) throw new TypeError(`${label} is required`)
  return id
}

function normalizePermissions(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : []
  return Array.from(new Set(raw.map((permission) => normalizeId(permission, 'permission'))))
}

export function normalizeProvider(input: ProviderInput): ProviderRecord {
  if (!input || typeof input !== 'object') throw new TypeError('provider must be an object')
  const id = normalizeId(input.id, 'provider.id')
  const capability = normalizeId(input.capability || input.name, `provider ${id} capability`)
  const hooks = isRecord(input.hooks) ? input.hooks : input
  const normalizedHooks: Partial<Record<ProviderHookName, ProviderHook | AroundProviderHook>> = {}
  for (const hook of HOOKS) {
    const candidate = hooks[hook]
    if (candidate !== undefined && typeof candidate !== 'function') {
      throw new TypeError(`provider ${id} ${hook} hook must be a function`)
    }
    if (typeof candidate === 'function') normalizedHooks[hook] = candidate as ProviderHook | AroundProviderHook
  }
  if (!normalizedHooks.around) throw new TypeError(`provider ${id} around hook is required`)

  const lifecycleInput = isRecord(input.lifecycle) ? input.lifecycle : {}
  const lifecycle: Partial<Record<ProviderLifecyclePhase, ProviderLifecycleHook>> = {}
  for (const phase of LIFECYCLE_PHASES) {
    const candidate = lifecycleInput[phase]
    if (candidate !== undefined && typeof candidate !== 'function') {
      throw new TypeError(`provider ${id} ${phase} lifecycle must be a function`)
    }
    if (typeof candidate === 'function') lifecycle[phase] = candidate as ProviderLifecycleHook
  }

  return {
    id,
    capability,
    pluginId: input.pluginId ? String(input.pluginId) : null,
    priority: typeof input.priority === 'number' && Number.isFinite(input.priority) ? input.priority : 0,
    hooks: normalizedHooks,
    lifecycle,
    metadata: isRecord(input.metadata) ? { ...input.metadata } : {},
    permissions: normalizePermissions(input.permissions || input.requiredPermissions),
    isDefault: input.isDefault === true || input.default === true,
    allowOverride: input.allowOverride === true,
    enabled: input.enabled !== false
  }
}

const sortProviders = (left: ProviderRecord, right: ProviderRecord): number =>
  right.priority - left.priority || left.id.localeCompare(right.id)

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRecord>()
  private readonly services = new Map<string, ServiceEntry>()
  private readonly overrides = new Map<string, string>()
  private readonly defaultTimeoutMs: number
  private readonly onError: ProviderRegistryOptions['onError'] | null
  private readonly authorize: ProviderRegistryOptions['authorize'] | null
  private blockedCapabilityResolver: ((capability: string) => boolean) | null = null

  constructor(options: ProviderRegistryOptions = {}) {
    this.defaultTimeoutMs = typeof options.defaultTimeoutMs === 'number' && Number.isFinite(options.defaultTimeoutMs) ? options.defaultTimeoutMs : 0
    this.onError = typeof options.onError === 'function' ? options.onError : null
    this.authorize = typeof options.authorize === 'function' ? options.authorize : null
  }

  setBlockedCapabilityResolver(resolver: ((capability: string) => boolean) | null): void {
    this.blockedCapabilityResolver = typeof resolver === 'function' ? resolver : null
  }

  isCapabilityBlocked(capability: string): boolean {
    if (!this.blockedCapabilityResolver) return false
    const key = String(capability || '')
    if (!key) return false
    try {
      return this.blockedCapabilityResolver(key) === true
    } catch {
      return false
    }
  }

  register(provider: ProviderInput): ProviderDescription {
    const normalized = normalizeProvider(provider)
    if (this.providers.has(normalized.id)) throw new Error(`Duplicate provider id: ${normalized.id}`)
    if (normalized.isDefault && this.findDefault(normalized.capability)) throw new Error(`Duplicate default provider capability: ${normalized.capability}`)
    this.providers.set(normalized.id, normalized)
    const description = this.describe(normalized.id)
    if (!description) throw new Error(`Failed to describe provider: ${normalized.id}`)
    return description
  }

  registerDefault(provider: ProviderInput): ProviderDescription {
    return this.register({ ...provider, isDefault: true })
  }

  registerOverride(provider: ProviderInput): ProviderDescription {
    const normalized = normalizeProvider(provider)
    const defaultProvider = this.findDefault(normalized.capability)
    if (!defaultProvider) throw new Error(`Missing default provider capability: ${normalized.capability}`)
    if (!defaultProvider.allowOverride) throw new Error(`Provider override is not allowed: ${normalized.capability}`)
    if (this.overrides.has(normalized.capability)) throw new Error(`Provider override already registered: ${normalized.capability}`)
    const overridePermission = `${normalized.capability}:provider:override`
    const permissions = normalized.permissions.includes(overridePermission) ? normalized.permissions : [...normalized.permissions, overridePermission]
    this.register({ ...provider, permissions, isDefault: false })
    this.overrides.set(normalized.capability, normalized.id)
    const description = this.describe(normalized.id)
    if (!description) throw new Error(`Failed to describe provider: ${normalized.id}`)
    return description
  }

  registerMany(providers: ProviderInput[] = []): ProviderDescription[] {
    for (const provider of providers) this.register(provider)
    return this.list()
  }

  unregister(providerId: string): boolean {
    const id = normalizeId(providerId, 'providerId')
    const provider = this.providers.get(id)
    if (!provider) return false
    this.providers.delete(id)
    if (this.overrides.get(provider.capability) === id) this.overrides.delete(provider.capability)
    return true
  }

  enable(providerId: string): boolean {
    const provider = this.providers.get(normalizeId(providerId, 'providerId'))
    if (!provider || provider.enabled) return false
    provider.enabled = true
    return true
  }

  disable(providerId: string): boolean {
    const provider = this.providers.get(normalizeId(providerId, 'providerId'))
    if (!provider || !provider.enabled) return false
    provider.enabled = false
    return true
  }

  clear(): void {
    this.providers.clear()
    this.overrides.clear()
  }

  get(providerId: string): ProviderRecord | null {
    return this.providers.get(normalizeId(providerId, 'providerId')) || null
  }

  list(): ProviderDescription[] {
    return Array.from(this.providers.values()).sort(sortProviders).map((provider) => {
      const description = this.describe(provider.id)
      if (!description) throw new Error(`Failed to describe provider: ${provider.id}`)
      return description
    })
  }

  describe(providerId: string): ProviderDescription | null {
    const provider = this.get(providerId)
    if (!provider) return null
    return {
      id: provider.id,
      capability: provider.capability,
      pluginId: provider.pluginId,
      priority: provider.priority,
      hooks: HOOKS.filter((hook) => typeof provider.hooks[hook] === 'function'),
      lifecycle: LIFECYCLE_PHASES.filter((phase) => typeof provider.lifecycle[phase] === 'function'),
      metadata: { ...provider.metadata },
      permissions: provider.permissions.slice(),
      isDefault: provider.isDefault,
      allowOverride: provider.allowOverride,
      enabled: provider.enabled
    }
  }

  getByCapability(capability: string): ProviderRecord[] {
    const key = normalizeId(capability, 'capability')
    const overrideId = this.overrides.get(key)
    return Array.from(this.providers.values())
      .filter((provider) => provider.capability === key && provider.enabled && (!overrideId || !provider.isDefault))
      .sort(sortProviders)
  }

  registerService(name: string, service: unknown, options: ServiceRegistrationOptions = {}): ReturnType<ProviderRegistry['describeService']> {
    const id = normalizeId(name, 'service name')
    if (!service) throw new TypeError(`service ${id} is required`)
    if (this.services.has(id) && options.override !== true) throw new Error(`Duplicate service: ${id}`)
    this.services.set(id, {
      service,
      pluginId: options.pluginId ? String(options.pluginId) : null,
      permissions: normalizePermissions(options.permissions || options.requiredPermissions)
    })
    return this.describeService(id)
  }

  unregisterService(name: string): boolean {
    return this.services.delete(normalizeId(name, 'service name'))
  }

  getService<T = unknown>(name: string, _context: ProviderContext = {}): T | null {
    const entry = this.services.get(normalizeId(name, 'service name'))
    return entry ? entry.service as T : null
  }

  describeService(name: string): { name: string; pluginId: string | null; permissions: string[] } | null {
    const id = normalizeId(name, 'service name')
    const entry = this.services.get(id)
    return entry ? { name: id, pluginId: entry.pluginId, permissions: entry.permissions.slice() } : null
  }

  listServices(): Array<NonNullable<ReturnType<ProviderRegistry['describeService']>>> {
    return Array.from(this.services.keys()).sort().flatMap((name) => {
      const description = this.describeService(name)
      return description ? [description] : []
    })
  }

  async runLifecycle(phase: string, providerId: string, context: ProviderContext = {}): Promise<unknown> {
    const lifecyclePhase = normalizeId(phase, 'lifecycle phase') as ProviderLifecyclePhase
    const provider = this.get(providerId)
    if (!provider) throw new Error(`Missing provider: ${providerId}`)
    const handler = provider.lifecycle[lifecyclePhase]
    if (!handler) return undefined
    try {
      return await this.withTimeout(Promise.resolve(handler(context, {
        providerId: provider.id,
        capability: provider.capability,
        context,
        permissions: provider.permissions.slice()
      })), this.defaultTimeoutMs)
    } catch (error) {
      if (this.onError) await this.onError(error, { providerId: provider.id, capability: provider.capability, phase: lifecyclePhase, context })
      throw error
    }
  }

  async runLifecycleForPlugin(phase: string, pluginId: string, context: ProviderContext = {}): Promise<void> {
    const id = normalizeId(pluginId, 'pluginId')
    const providers = Array.from(this.providers.values()).filter((provider) => provider.pluginId === id)
    for (const provider of providers) await this.runLifecycle(phase, provider.id, context)
  }

  async execute<TInput = unknown, TOutput = unknown>(providerId: string, input: TInput, context: ProviderContext = {}): Promise<TOutput> {
    const provider = this.get(providerId)
    if (!provider) throw new Error(`Missing provider: ${providerId}`)
    if (!provider.enabled) throw new Error(`Disabled provider: ${providerId}`)
    const execution: ProviderExecution = { providerId: provider.id, capability: provider.capability, input, context, state: {} }
    try {
      await this.assertPermissions(provider, execution)
      let value: unknown = input
      const before = provider.hooks.before as ProviderHook | undefined
      const validate = provider.hooks.validate as ProviderHook | undefined
      const around = provider.hooks.around as AroundProviderHook
      const after = provider.hooks.after as ProviderHook | undefined
      if (before) value = await before(value, execution)
      if (validate) {
        const result = await validate(value, execution)
        if (result === false) throw new Error(`Provider validation failed: ${provider.id}`)
        if (result !== true && result !== undefined) value = result
      }
      const terminal: ProviderTerminal = async (nextValue = value) => nextValue
      const result = await this.withTimeout(Promise.resolve(around(value, execution, terminal)), this.defaultTimeoutMs)
      return (after ? await after(result, execution) : result) as TOutput
    } catch (error) {
      if (this.onError) await this.onError(error, execution)
      throw error
    }
  }

  async executeCapability<TInput = unknown, TOutput = unknown>(capability: string, input: TInput, context: ProviderContext = {}): Promise<TOutput> {
    const providers = this.getByCapability(capability)
    if (!providers.length) throw new Error(`Missing provider capability: ${capability}`)
    const executions = providers.map((provider) => ({
      provider,
      execution: { providerId: provider.id, capability: provider.capability, input, context, state: {} } as ProviderExecution
    }))
    try {
      let value: unknown = input
      for (const item of executions) {
        await this.assertPermissions(item.provider, item.execution)
        const before = item.provider.hooks.before as ProviderHook | undefined
        const validate = item.provider.hooks.validate as ProviderHook | undefined
        if (before) value = await before(value, item.execution)
        if (validate) {
          const result = await validate(value, item.execution)
          if (result === false) throw new Error(`Provider validation failed: ${item.provider.id}`)
          if (result !== true && result !== undefined) value = result
        }
      }
      let next: ProviderTerminal = async (nextValue = value) => nextValue
      for (let index = executions.length - 1; index >= 0; index -= 1) {
        const { provider, execution } = executions[index]
        const current = next
        const around = provider.hooks.around as AroundProviderHook
        next = (nextValue = value) => around(nextValue, execution, current)
      }
      value = await this.withTimeout(Promise.resolve(next(value)), this.defaultTimeoutMs)
      for (let index = executions.length - 1; index >= 0; index -= 1) {
        const { provider, execution } = executions[index]
        const after = provider.hooks.after as ProviderHook | undefined
        if (after) value = await after(value, execution)
      }
      return value as TOutput
    } catch (error) {
      if (this.onError) await this.onError(error, { capability, input, context, providerIds: providers.map((provider) => provider.id) })
      throw error
    }
  }

  private async assertPermissions(provider: ProviderRecord, execution: ProviderExecution): Promise<void> {
    for (const permission of provider.permissions) {
      let allowed: boolean
      if (this.authorize) allowed = await this.authorize(permission, execution)
      else if (typeof execution.context.hasPermission === 'function') {
        allowed = Boolean(await (execution.context.hasPermission as (permission: string, execution: ProviderExecution) => unknown)(permission, execution))
      } else {
        const granted = execution.context.permissions
        allowed = Array.isArray(granted)
          ? granted.includes(permission)
          : granted instanceof Set
            ? granted.has(permission)
            : isRecord(granted) && Boolean(granted[permission])
      }
      if (!allowed) throw new Error(`Provider permission denied: ${permission}`)
    }
  }

  private findDefault(capability: string): ProviderRecord | null {
    return Array.from(this.providers.values()).find((provider) => provider.capability === capability && provider.isDefault) || null
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Provider execution timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }
}
