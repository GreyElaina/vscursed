import * as api from '@vscursed/api'
import {
  Bridge,
  Interceptor,
  sharedModulesKey,
  VSCode,
  type BridgeTransport,
  type Realm,
  type ServiceRegistry,
  type SharedModules,
} from '@vscursed/api'
import * as cordis from 'cordis'
import { Context, Logger, type Exporter } from 'cordis'
import type { IInstantiationService } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { PluginHost, type FileWatcher, type PluginSource, type SettingsSource } from './host.ts'
import { PluginLoader } from './loader.ts'
import { PluginModules, type ModuleHost } from './modules.ts'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface RealmOptions {
  realm: Realm
  instantiationService: IInstantiationService
  services: ServiceRegistry
  transport: BridgeTransport
  modules: ModuleHost
  plugins: PluginSource
  settings: SettingsSource
  watcher?: FileWatcher
  log(level: LogLevel, message: string): void
  /** A removed plugin was not torn down cleanly; see `PluginHostOptions.onUncleanUnload`. */
  onUncleanUnload?(id: string, reason: string): void
}

export interface RealmHandle {
  readonly ctx: Context
  readonly modules: PluginModules
  /** The realm's bridge, for serving calls that other realms address to it. */
  readonly bridge: Promise<Bridge>
  /** Resolves once the first reconciliation has loaded the enabled plugins. */
  readonly ready: Promise<void>
  dispose(): Promise<void>
}

function exportLogs(ctx: Context, log: RealmOptions['log']) {
  const exporter: Exporter = {
    colors: false,
    levels: { default: 3 },
    export: message => log(message.type, `${message.name}: ${Logger.format(exporter, message)}`),
  }
  ctx.logger.exporter(exporter)
}

/**
 * Builds one realm: the shared module table that plugin bundles link against, the VSCursed services,
 * the Loader and the plugin host. Everything hangs off a single kernel fiber, so disposing the realm
 * unloads every plugin through Cordis.
 */
export function startRealm(options: RealmOptions): RealmHandle {
  const shared: SharedModules = { modules: { cordis, '@vscursed/api': api }, vscode: options.services }
  Reflect.set(globalThis, sharedModulesKey, shared)

  const root = new Context()
  exportLogs(root, options.log)
  const modules = new PluginModules(options.realm, options.modules)
  const bridge = Promise.withResolvers<Bridge>()
  const ready = Promise.withResolvers<void>()

  const kernel = root.plugin({
    name: 'vscursed',
    async apply(ctx: Context) {
      await Promise.all([
        ctx.plugin(VSCode, { realm: options.realm, instantiationService: options.instantiationService }),
        ctx.plugin(Interceptor),
        ctx.plugin(Bridge, { realm: options.realm, transport: options.transport }),
        ctx.plugin(PluginLoader, { modules }),
      ])
      bridge.resolve(ctx.get('bridge')!)
      const loader = ctx.get('loader') as PluginLoader
      const host = new PluginHost(ctx, { ...options, loader, modules })
      void host
        .schedule()
        .then(() => loader.await())
        .finally(ready.resolve)
    },
  })

  return {
    ctx: root,
    modules,
    bridge: bridge.promise,
    ready: ready.promise,
    async dispose() {
      await kernel.dispose()
      Reflect.deleteProperty(globalThis, sharedModulesKey)
    },
  }
}
