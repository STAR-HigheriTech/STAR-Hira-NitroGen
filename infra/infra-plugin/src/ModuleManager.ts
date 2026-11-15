import type { IHiraModule, ModuleConfig, ModuleContext, ModuleServices } from './types'

/** Dependency-aware lifecycle manager for harness modules. */
export class ModuleManager {
  private readonly modules = new Map<string, IHiraModule>()
  private readonly installed = new Set<string>()
  private readonly started = new Set<string>()
  private readonly context: ModuleContext

  constructor() {
    this.context = {
      services: {},
      config: {},
      getModule: (id) => this.modules.get(id)
    }
  }

  setServices(services: ModuleServices): void {
    this.context.services = { ...this.context.services, ...services }
  }

  setConfig(config: ModuleConfig): void {
    this.context.config = { ...this.context.config, ...config }
  }

  register(mod: IHiraModule): void {
    if (!mod?.id) throw new Error('[plugin] module must have an id')
    if (this.modules.has(mod.id)) throw new Error(`[plugin] module "${mod.id}" already registered`)
    this.modules.set(mod.id, mod)
  }

  resolveOrder(): IHiraModule[] {
    const order: IHiraModule[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const visit = (mod: IHiraModule): void => {
      if (visited.has(mod.id)) return
      if (visiting.has(mod.id)) throw new Error(`[plugin] circular dependency detected at "${mod.id}"`)
      visiting.add(mod.id)

      for (const dependencyId of mod.dependsOn ?? []) {
        const dependency = this.modules.get(dependencyId)
        if (!dependency) {
          throw new Error(
            `[plugin] module "${mod.id}" depends on "${dependencyId}" which is not registered. ` +
            `Install "${dependencyId}" first (CONTRACT-07).`
          )
        }
        visit(dependency)
      }

      visiting.delete(mod.id)
      visited.add(mod.id)
      order.push(mod)
    }

    for (const mod of this.modules.values()) visit(mod)
    return order
  }

  async installAll(): Promise<void> {
    for (const mod of this.resolveOrder()) {
      if (this.installed.has(mod.id)) continue
      await mod.install?.(this.context)
      this.installed.add(mod.id)
    }
  }

  async startAll(): Promise<void> {
    for (const mod of this.resolveOrder()) {
      if (this.started.has(mod.id)) continue
      if (!this.installed.has(mod.id)) throw new Error(`[plugin] module "${mod.id}" not installed before start`)
      await mod.start?.(this.context)
      this.started.add(mod.id)
    }
  }

  async stopAll(): Promise<void> {
    const errors: unknown[] = []
    for (const mod of this.resolveOrder().reverse()) {
      if (!this.started.has(mod.id)) continue
      try {
        await mod.stop?.(this.context)
      } catch (error) {
        errors.push(error)
      } finally {
        this.started.delete(mod.id)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `[plugin] ${errors.length} module(s) failed to stop`)
    }
  }

  async uninstallAll(): Promise<void> {
    const errors: unknown[] = []
    for (const mod of this.resolveOrder().reverse()) {
      if (!this.installed.has(mod.id)) continue
      try {
        await mod.uninstall?.(this.context)
      } catch (error) {
        errors.push(error)
      } finally {
        this.installed.delete(mod.id)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `[plugin] ${errors.length} module(s) failed to uninstall`)
    }
  }

  getModule(id: string): IHiraModule | undefined {
    return this.modules.get(id)
  }
}
