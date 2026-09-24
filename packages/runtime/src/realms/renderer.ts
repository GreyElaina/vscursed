import type { PluginDescriptor, Realm } from '@vscursed/api'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import type { IChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import { CommandsRegistry, ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { IConfigurationService } from 'vscode-internal/vs/platform/configuration/common/configuration.js'
import { IFileService } from 'vscode-internal/vs/platform/files/common/files.js'
import { IInstantiationService } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { IMainProcessService } from 'vscode-internal/vs/platform/ipc/common/mainProcessService.js'
import { ISharedProcessService } from 'vscode-internal/vs/platform/ipc/electron-browser/services.js'
import { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import { INotificationService, Severity } from 'vscode-internal/vs/platform/notification/common/notification.js'
import { registerWorkbenchContribution2, WorkbenchPhase } from 'vscode-internal/vs/workbench/common/contributions.js'
import { IWorkbenchExtensionManagementService } from 'vscode-internal/vs/workbench/services/extensionManagement/common/extensionManagement.js'
import { IExtensionService } from 'vscode-internal/vs/workbench/services/extensions/common/extensions.js'
import { IHostService } from 'vscode-internal/vs/workbench/services/host/browser/host.js'
import { ILifecycleService } from 'vscode-internal/vs/workbench/services/lifecycle/common/lifecycle.js'
import type { PluginSource } from '../kernel/host.ts'
import { startRealm } from '../kernel/realm.ts'
import type { JsonSchema } from '../kernel/schema.ts'
import { channelName, channelTransport, RealmServer, type UncleanUnload } from '../vscode/channel.ts'
import {
  channelOverCommands,
  extensionHostReadyCommand,
  serveOverCommands,
  type CommandLink,
} from '../vscode/commands.ts'
import { describePlugins } from '../vscode/extensions.ts'
import { logTo } from '../vscode/log.ts'
import { fileServiceWatcher, rendererModuleHost } from '../vscode/renderer/files.ts'
import { InstallProbe } from '../vscode/renderer/probe.ts'
import { SettingsSchema } from '../vscode/renderer/settings-schema.ts'
import { services } from '../vscode/services.ts'
import { configurationSettings } from '../vscode/settings.ts'

/**
 * The window's realm and its hub: it follows the window's extension enablement, reports the enabled
 * plugins to the application-wide realms, routes bridge traffic between them and the extension host,
 * and registers the plugins' settings schema.
 */
class VSCursedContribution extends Disposable {
  static readonly ID = 'workbench.contrib.vscursed'

  constructor(
    @IInstantiationService instantiationService: IInstantiationService,
    @IExtensionService extensionService: IExtensionService,
    @ICommandService commandService: ICommandService,
    @IMainProcessService mainProcessService: IMainProcessService,
    @ISharedProcessService sharedProcessService: ISharedProcessService,
    @IConfigurationService configurationService: IConfigurationService,
    @IFileService fileService: IFileService,
    @INotificationService notificationService: INotificationService,
    @IHostService hostService: IHostService,
    @IWorkbenchExtensionManagementService extensionManagementService: IWorkbenchExtensionManagementService,
    @ILifecycleService lifecycleService: ILifecycleService,
    @ILogService logService: ILogService,
  ) {
    super()
    const log = logTo(logService)

    const link: CommandLink = {
      register: (id, handler) =>
        CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...args)),
      execute: (id, ...args) => commandService.executeCommand(id, ...args),
    }
    const extensionHost = this._register(channelOverCommands('renderer', link, false))
    this._register(CommandsRegistry.registerCommand(extensionHostReadyCommand, () => extensionHost.ready()))
    this._register(extensionService.onWillStop(() => extensionHost.reset()))
    const channels: Partial<Record<Realm, IChannel>> = {
      main: mainProcessService.getChannel(channelName),
      sharedProcess: sharedProcessService.getChannel(channelName),
      extensionHost,
    }
    const route = (realm: Realm) => channels[realm]

    const schema = this._register(new SettingsSchema())
    let descriptors: PluginDescriptor[] = []
    const pluginChanges = this._register(new Emitter<void>())
    const plugins: PluginSource = { current: () => descriptors, onDidChange: listener => pluginChanges.event(listener) }
    const readPlugins = () => {
      descriptors = describePlugins(extensionService.extensions, message => log('warn', message))
      schema.setPlugins(descriptors)
      for (const realm of ['main', 'sharedProcess'] as const) {
        channels[realm]!.call('demand', descriptors).catch(error =>
          log('error', `cannot reach the ${realm} realm: ${error}`),
        )
      }
      pluginChanges.fire()
    }
    void extensionService.whenInstalledExtensionsRegistered().then(() => {
      this._register(extensionService.onDidChangeExtensions(readPlugins))
      readPlugins()
    })

    const handle = startRealm({
      realm: 'renderer',
      instantiationService,
      services,
      transport: channelTransport('renderer', route),
      modules: rendererModuleHost,
      plugins,
      settings: configurationSettings(configurationService),
      watcher: fileServiceWatcher(fileService),
      log,
      onUncleanUnload: (id, reason) =>
        notificationService.prompt(
          Severity.Warning,
          `VSCursed could not fully unload ${id} (${reason}). Reload the window to remove what it left behind.`,
          [{ label: 'Reload Window', run: () => hostService.reload() }],
        ),
    })

    this._register(handle.modules.onDidChangeSchema(() => schema.report('renderer', handle.modules.schemas())))
    for (const realm of ['main', 'sharedProcess', 'extensionHost'] as const) {
      const report = (schemas: Record<string, JsonSchema | null>) => schema.report(realm, schemas)
      this._register(channels[realm]!.listen<Record<string, JsonSchema | null>>('schemas')(report))
      channels[realm]!.call<Record<string, JsonSchema | null>>('schemas').then(report, error =>
        log('warn', `no schemas from the ${realm} realm: ${error}`),
      )
    }

    // The extension host's teardown failed: only a restart of that process removes what it left behind.
    this._register(
      extensionHost.listen<UncleanUnload>('unclean')(({ id, reason }) =>
        notificationService.prompt(
          Severity.Warning,
          `VSCursed could not fully unload ${id} from the extension host (${reason}).`,
          [
            {
              label: 'Restart Extension Host',
              run: async () => {
                if (await extensionService.stopExtensionHosts(`Unloading ${id}`))
                  await extensionService.startExtensionHosts()
              },
            },
          ],
        ),
      ),
    )

    this._register(serveOverCommands('renderer', new RealmServer({ realm: 'renderer', handle, route }), link))
    this._register(new InstallProbe(extensionManagementService, fileService, notificationService, logService))
    this._register(
      lifecycleService.onWillShutdown(event =>
        event.join(handle.dispose(), { id: 'join.vscursed', label: 'Unloading VSCursed plugins' }),
      ),
    )
  }
}

registerWorkbenchContribution2(VSCursedContribution.ID, VSCursedContribution, WorkbenchPhase.BlockRestore)
