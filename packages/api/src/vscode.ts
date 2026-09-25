import { Context, Service } from 'cordis'
import type {
  IInstantiationService,
  ServiceIdentifier,
} from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import type { Realm } from './realm.ts'

declare module 'cordis' {
  interface Context {
    vscode: VSCode
  }
}

export interface VSCodeConfig {
  realm: Realm
  instantiationService: IInstantiationService
}

/**
 * The realm's VS Code dependency injection container. Service identifiers come from
 * `vscode-internal/...` imports, which resolve to the identifiers VS Code itself registered, so the
 * returned objects are the running services, not copies.
 */
export class VSCode extends Service {
  readonly realm: Realm
  private readonly instantiationService: IInstantiationService

  constructor(ctx: Context, config: VSCodeConfig) {
    super(ctx, 'vscode')
    this.realm = config.realm
    this.instantiationService = config.instantiationService
  }

  get<T>(id: ServiceIdentifier<T>): T {
    return this.instantiationService.invokeFunction(accessor => accessor.get(id))
  }

  /**
   * Creates an object through VS Code's container, so that constructor parameters decorated with service
   * identifiers are injected. A disposable result is disposed together with the calling fiber.
   */
  createInstance<T extends object>(ctor: new (...args: any[]) => T, ...args: unknown[]): T {
    const instance = this.instantiationService.createInstance(ctor as never, ...(args as [])) as T
    const dispose = (instance as { dispose?: unknown }).dispose
    if (typeof dispose === 'function') this.ctx.effect(() => () => dispose.call(instance), 'vscode.createInstance()')
    return instance
  }
}
