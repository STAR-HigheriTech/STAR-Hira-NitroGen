import type { UnknownRecord } from './types'

export interface ServiceExecutionContext extends UnknownRecord {
  context?: UnknownRecord
}

export interface ServicePluginContext<Services extends UnknownRecord = UnknownRecord> extends UnknownRecord {
  getDomainServices?(): Services | null | undefined
  domainServices?: Services | null
}

export type ServiceInvoker<
  Service = unknown,
  Input = unknown,
  Context extends ServicePluginContext<UnknownRecord> = ServicePluginContext<UnknownRecord>
> = (service: Service, input: Input, context: Context) => unknown

export interface ServicePluginOptions<
  Service = unknown,
  Inputs extends Record<string, unknown> = Record<string, unknown>,
  Context extends ServicePluginContext<UnknownRecord> = ServicePluginContext<UnknownRecord>
> {
  domain: string
  serviceName: string
  capabilities: { [K in keyof Inputs]: ServiceInvoker<Service, Inputs[K], Context> }
}

export interface RegisteredServiceProvider {
  id: string
  capability: string
  metadata: { domain: string; plugin: string }
  around(input: unknown, execution?: ServiceExecutionContext): unknown
}

export interface ServicePlugin {
  install(ctx: ServicePluginContext): void
  registerProviders(ctx: ServicePluginContext): RegisteredServiceProvider[]
  registerExtensionPoints(ctx: ServicePluginContext): Array<{ name: string; service: unknown }>
  enable(): void
  disable(): void
  uninstall(): void
}

const isRecord = (value: unknown): value is UnknownRecord => !!value && typeof value === 'object' && !Array.isArray(value)
const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  isRecord(value) && typeof value.then === 'function'

/** Declarative factory for domain-service plugins with lazy service resolution. */
export function createServicePlugin<
  Service = unknown,
  Inputs extends Record<string, unknown> = Record<string, unknown>,
  Context extends ServicePluginContext<UnknownRecord> = ServicePluginContext<UnknownRecord>
>({ domain, serviceName, capabilities }: ServicePluginOptions<Service, Inputs, Context>): ServicePlugin {
  if (!domain || typeof domain !== 'string') throw new TypeError('createServicePlugin: domain is required')
  if (!serviceName || typeof serviceName !== 'string') throw new TypeError('createServicePlugin: serviceName is required')
  if (!capabilities || typeof capabilities !== 'object') throw new TypeError('createServicePlugin: capabilities is required')
  const pluginId = `${domain}-service`
  const entries = Object.entries(capabilities)
  if (!entries.length) throw new TypeError('createServicePlugin: capabilities must not be empty')

  const resolveService = (ctx: ServicePluginContext): unknown => {
    const services = typeof ctx.getDomainServices === 'function' ? ctx.getDomainServices() : ctx.domainServices
    const service = services?.[serviceName]
    if (!service) throw new Error(`${serviceName} is required by plugin ${pluginId}`)
    return service
  }

  return {
    install(ctx) {
      resolveService(ctx)
    },

    registerProviders(ctx) {
      return entries.map(([capability, invoke]) => ({
        id: `${domain}.service.${capability.slice(domain.length + 1)}`,
        capability,
        metadata: { domain, plugin: pluginId },
        around(input: unknown, execution?: ServiceExecutionContext) {
          const runtimeContext: ServicePluginContext = isRecord(execution?.context)
            ? { ...ctx, ...execution.context }
            : { ...ctx }

          const mark = (error: unknown): unknown => {
            if (isRecord(error) && !error.hiraDomainServiceError) error.hiraDomainServiceError = true
            return error
          }

          try {
            const output = invoke(resolveService(ctx), input, runtimeContext)
            if (isPromiseLike(output)) return output.catch((error: unknown) => { throw mark(error) })
            return output
          } catch (error) {
            throw mark(error)
          }
        }
      }))
    },

    registerExtensionPoints(ctx) {
      return [{ name: `${domain}.service`, service: resolveService(ctx) }]
    },

    enable() {},
    disable() {},
    uninstall() {}
  }
}
