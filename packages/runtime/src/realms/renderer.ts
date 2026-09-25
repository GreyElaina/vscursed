import { readPluginManifest, realms, type PluginDescriptor, type PluginManifest, type Realm } from '@vscursed/api'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import { joinPath } from 'vscode-internal/vs/base/common/resources.js'
import { URI } from 'vscode-internal/vs/base/common/uri.js'
import type { IChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import { CommandsRegistry, ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { IConfigurationService } from 'vscode-internal/vs/platform/configuration/common/configuration.js'
import { type IContextKey, IContextKeyService } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import { IFileService } from 'vscode-internal/vs/platform/files/common/files.js'
import { InstantiationType, registerSingleton } from 'vscode-internal/vs/platform/instantiation/common/extensions.js'
import { IInstantiationService } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { IMainProcessService } from 'vscode-internal/vs/platform/ipc/common/mainProcessService.js'
import { ISharedProcessService } from 'vscode-internal/vs/platform/ipc/electron-browser/services.js'
import { type ILogger, ILoggerService } from 'vscode-internal/vs/platform/log/common/log.js'
import { INotificationService, Severity } from 'vscode-internal/vs/platform/notification/common/notification.js'
import { registerWorkbenchContribution2, WorkbenchPhase } from 'vscode-internal/vs/workbench/common/contributions.js'
import { IWorkbenchEnvironmentService } from 'vscode-internal/vs/workbench/services/environment/common/environmentService.js'
import { IExtensionService } from 'vscode-internal/vs/workbench/services/extensions/common/extensions.js'
import { IHostService } from 'vscode-internal/vs/workbench/services/host/browser/host.js'
import { ILifecycleService } from 'vscode-internal/vs/workbench/services/lifecycle/common/lifecycle.js'
import type { PluginSource } from '../kernel/host.ts'
import { startRealm, type LogLevel, type RealmHandle } from '../kernel/realm.ts'
import type { JsonSchema } from '../kernel/schema.ts'
import { channelName, channelTransport, RealmServer, type UncleanUnload } from '../vscode/channel.ts'
import {
  channelOverCommands,
  extensionHostReadyCommand,
  serveOverCommands,
  type CommandLink,
} from '../vscode/commands.ts'
import { targetRegistration } from '../vscode/development.ts'
import { describePlugins } from '../vscode/extensions.ts'
import { createRealmLogger, logTo } from '../vscode/log.ts'
import '../vscode/renderer/actions.ts'
import { IDevelopmentDebugger } from '../vscode/renderer/debugger.ts'
import { extensionsListIndicator } from '../vscode/renderer/extensions-list.ts'
import { rendererModuleHost } from '../vscode/renderer/files.ts'
import { InstallProbe } from '../vscode/renderer/probe.ts'
import {
  isDevelopmentTargetContext,
  IVSCursedService,
  vscursedExtensionsContext,
  vscursedRealmContexts,
  type RemoteRealm,
} from '../vscode/renderer/service.ts'
import { SettingsSchema } from '../vscode/renderer/settings-schema.ts'
import { DevelopmentTarget } from '../vscode/renderer/target.ts'
import { services } from '../vscode/services.ts'
import { configurationSettings } from '../vscode/settings.ts'

class VSCursedService extends Disposable implements IVSCursedService {
  declare readonly _serviceBrand: undefined
  readonly logger: ILogger
  /** The enabled plugins as the extension service reports them. */
  private installed: PluginDescriptor[] = []
  /** Manifests applied on top of the installed ones, until the extension moves. */
  private readonly overrides = new Map<string, PluginDescriptor>()
  plugins: PluginDescriptor[] = []
  private readonly pluginChanges = this._register(new Emitter<void>())
  private readonly log: (level: LogLevel, message: string) => void
  private readonly channels: Record<RemoteRealm, IChannel>
  private readonly schema = this._register(new SettingsSchema())
  private readonly extensionContext: IContextKey<Record<string, boolean>>
  private readonly realmContexts: Record<Realm, IContextKey<Record<string, boolean>>>
  private readonly handle: RealmHandle
  private readonly registered: Promise<void>

  constructor(
    @IInstantiationService instantiationService: IInstantiationService,
    @IExtensionService private readonly extensionService: IExtensionService,
    @ICommandService commandService: ICommandService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IMainProcessService mainProcessService: IMainProcessService,
    @ISharedProcessService sharedProcessService: ISharedProcessService,
    @IConfigurationService configurationService: IConfigurationService,
    @IFileService private readonly fileService: IFileService,
    @INotificationService private readonly notificationService: INotificationService,
    @IHostService hostService: IHostService,
    @ILifecycleService lifecycleService: ILifecycleService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this.logger = createRealmLogger(loggerService, 'renderer')
    this.log = logTo(this.logger)

    // The extension host is reached through internal commands, the one link VS Code keeps to it.
    const link: CommandLink = {
      register: (id, handler) =>
        CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...args)),
      execute: (id, ...args) => commandService.executeCommand(id, ...args),
    }
    const extensionHost = this._register(channelOverCommands('renderer', link, false))
    this._register(CommandsRegistry.registerCommand(extensionHostReadyCommand, () => extensionHost.ready()))
    this._register(extensionService.onWillStop(() => extensionHost.reset()))
    this.channels = {
      main: mainProcessService.getChannel(channelName),
      sharedProcess: sharedProcessService.getChannel(channelName),
      extensionHost,
    }
    const route = (realm: Realm) => (realm === 'renderer' ? undefined : this.channels[realm])

    this.extensionContext = vscursedExtensionsContext.bindTo(contextKeyService)
    this.realmContexts = Object.fromEntries(
      realms.map(realm => [realm, vscursedRealmContexts[realm].bindTo(contextKeyService)]),
    ) as Record<Realm, IContextKey<Record<string, boolean>>>

    const plugins: PluginSource = { current: () => this.plugins, onDidChange: this.pluginChanges.event }
    this.handle = startRealm({
      realm: 'renderer',
      instantiationService,
      services,
      transport: channelTransport('renderer', route),
      modules: rendererModuleHost,
      plugins,
      settings: configurationSettings(configurationService),
      log: this.log,
      onUncleanUnload: (id, reason) =>
        notificationService.prompt(
          Severity.Warning,
          `VSCursed could not fully unload ${id} (${reason}). Reload the window to remove what it left behind.`,
          [{ label: 'Reload Window', run: () => hostService.reload() }],
        ),
    })
    this.handle.ctx.plugin(extensionsListIndicator)
    this.registered = extensionService.whenInstalledExtensionsRegistered().then(() => {
      this._register(extensionService.onDidChangeExtensions(() => this.readPlugins()))
      this.readPlugins()
    })

    this.collectSchemas()
    this.promptUncleanExtensionHost()
    this._register(
      serveOverCommands('renderer', new RealmServer({ realm: 'renderer', handle: this.handle, route }), link),
    )
    this._register(
      lifecycleService.onWillShutdown(event =>
        event.join(this.handle.dispose(), { id: 'join.vscursed', label: 'Unloading VSCursed plugins' }),
      ),
    )
  }

  channel(realm: RemoteRealm) {
    return this.channels[realm]
  }

  async reloadRealm(id: string, realm: Realm) {
    await this.reloadDescriptor(this.enabled(id), realm)
  }

  async applyManifest(id: string, manifest: PluginManifest) {
    await this.registered
    await this.replaceManifest(id, manifest)
  }

  async reloadManifest(id: string) {
    await this.registered
    const { location } = this.enabled(id)
    const packageJson = JSON.parse(
      (await this.fileService.readFile(joinPath(URI.file(location), 'package.json'))).value.toString(),
    )
    const manifest = readPluginManifest(packageJson)
    if (!manifest) throw new Error(`${id} has no "vscursed" field`)
    await this.replaceManifest(id, manifest, {
      displayName: packageJson.displayName,
      description: packageJson.description,
    })
  }

  private enabled(id: string) {
    const descriptor = this.plugins.find(descriptor => descriptor.id === id)
    if (!descriptor) throw new Error(`VSCursed plugin ${id} is not enabled in this window`)
    return descriptor
  }

  private async reloadDescriptor(descriptor: PluginDescriptor, realm: Realm) {
    if (realm === 'renderer') return this.handle.reload(descriptor)
    await this.channels[realm].call('reload', descriptor)
  }

  private async replaceManifest(id: string, manifest: PluginManifest, details: Partial<PluginDescriptor> = {}) {
    const current = this.enabled(id)
    const installed = this.installed.find(descriptor => descriptor.id === id)!
    const descriptor: PluginDescriptor = { ...installed, ...details, manifest }
    this.overrides.set(id, descriptor)
    const affected = realms.filter(realm => current.manifest[realm] || manifest[realm])
    await Promise.all(affected.map(realm => this.reloadDescriptor(descriptor, realm)))
    // The reloads already applied the manifest; publishing only records it.
    this.publishPlugins()
  }

  private readPlugins() {
    this.installed = describePlugins(this.extensionService.extensions, message => this.log('warn', message))
    const locations = new Map(this.installed.map(descriptor => [descriptor.id, descriptor.location]))
    for (const [id, descriptor] of this.overrides) {
      if (locations.get(id) !== descriptor.location) this.overrides.delete(id)
    }
    this.publishPlugins()
  }

  /** Every realm's Loader leaves unchanged entries alone, so the whole set is published on each change. */
  private publishPlugins() {
    const plugins = this.installed.map(descriptor => this.overrides.get(descriptor.id) ?? descriptor)
    this.plugins = plugins
    this.extensionContext.set(Object.fromEntries(plugins.map(plugin => [plugin.id, true])))
    for (const realm of realms) {
      this.realmContexts[realm].set(
        Object.fromEntries(plugins.filter(plugin => plugin.manifest[realm]).map(plugin => [plugin.id, true])),
      )
    }
    this.schema.setPlugins(plugins)
    for (const realm of ['main', 'sharedProcess'] as const) {
      this.channels[realm]
        .call('demand', plugins)
        .catch(error => this.log('error', `cannot reach the ${realm} realm: ${error}`))
    }
    this.pluginChanges.fire()
  }

  /** Every realm reports the JSON Schemas of its plugins' `Config`s for `vscursed.plugins`. */
  private collectSchemas() {
    const { modules } = this.handle
    this._register(modules.onDidChangeSchema(() => this.schema.report('renderer', modules.schemas())))
    for (const realm of ['main', 'sharedProcess', 'extensionHost'] as const) {
      const report = (schemas: Record<string, JsonSchema | null>) => this.schema.report(realm, schemas)
      this._register(this.channels[realm].listen<Record<string, JsonSchema | null>>('schemas')(report))
      this.channels[realm]
        .call<Record<string, JsonSchema | null>>('schemas')
        .then(report, error => this.log('warn', `no schemas from the ${realm} realm: ${error}`))
    }
  }

  /** The extension host's teardown failed: only a restart of that process removes what it left behind. */
  private promptUncleanExtensionHost() {
    this._register(
      this.channels.extensionHost.listen<UncleanUnload>('unclean')(({ id, reason }) =>
        this.notificationService.prompt(
          Severity.Warning,
          `VSCursed could not fully unload ${id} from the extension host (${reason}).`,
          [
            {
              label: 'Restart Extension Host',
              run: async () => {
                if (await this.extensionService.stopExtensionHosts(`Unloading ${id}`))
                  await this.extensionService.startExtensionHosts()
              },
            },
          ],
        ),
      ),
    )
  }
}

registerSingleton(IVSCursedService, VSCursedService, InstantiationType.Eager)

/**
 * Starts the window's realm and its development role: a Target window runs one extension from its
 * provider workspace, every other window can start Targets.
 */
class VSCursedStartup extends Disposable {
  static readonly ID = 'workbench.contrib.vscursed'

  constructor(
    // Depending on the service starts the realm.
    @IVSCursedService _vscursed: IVSCursedService,
    @IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super()
    const registration = targetRegistration(environmentService.debugExtensionHost.env)
    if (registration) {
      isDevelopmentTargetContext.bindTo(contextKeyService).set(true)
      this._register(instantiationService.createInstance(DevelopmentTarget, registration))
    } else {
      instantiationService.invokeFunction(accessor => accessor.get(IDevelopmentDebugger))
    }
    this._register(instantiationService.createInstance(InstallProbe))
  }
}

registerWorkbenchContribution2(VSCursedStartup.ID, VSCursedStartup, WorkbenchPhase.BlockRestore)
