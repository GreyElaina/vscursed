import type { PluginDescriptor } from '@vscursed/api'
import type { start as Start } from 'vscode-internal/vs/vscursed/runtime/extensionHost.js'
import { Emitter, type Event } from 'vscode-internal/vs/base/common/event.js'
import { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import { IExtHostCommands } from 'vscode-internal/vs/workbench/api/common/extHostCommands.js'
import { IExtHostConfiguration } from 'vscode-internal/vs/workbench/api/common/extHostConfiguration.js'
import { IExtHostExtensionService } from 'vscode-internal/vs/workbench/api/common/extHostExtensionService.js'
import type { PluginSource, SettingsSource } from '../kernel/host.ts'
import { startRealm } from '../kernel/realm.ts'
import { channelTransport, RealmServer, type UncleanUnload } from '../vscode/channel.ts'
import {
  channelOverCommands,
  extensionHostReadyCommand,
  serveOverCommands,
  type CommandLink,
} from '../vscode/commands.ts'
import { targetRegistration, type ProviderEvent } from '../vscode/development.ts'
import { describePlugins } from '../vscode/extensions.ts'
import { logTo } from '../vscode/log.ts'
import { nodeModuleHost } from '../vscode/node.ts'
import { ProviderConnection } from '../vscode/provider-connection.ts'
import { services } from '../vscode/services.ts'
import { asSettings, pluginsSetting } from '../vscode/settings.ts'

export const start: typeof Start = instantiationService => {
  const [commands, extensionService, configuration, logService] = instantiationService.invokeFunction(accessor => [
    accessor.get(IExtHostCommands),
    accessor.get(IExtHostExtensionService),
    accessor.get(IExtHostConfiguration),
    accessor.get(ILogService),
  ])
  const log = logTo(logService)

  // The extensions of this host, as the window assigned them; empty until the registry is ready.
  let descriptors: PluginDescriptor[] = []
  const pluginChanges = new Emitter<void>()
  const plugins: PluginSource = { current: () => descriptors, onDidChange: pluginChanges.event }
  void extensionService.getExtensionRegistry().then(registry => {
    const read = () => {
      descriptors = describePlugins(registry.getAllExtensionDescriptions(), message => log('warn', message))
      pluginChanges.fire()
    }
    registry.onDidChange(read)
    read()
  })

  // Empty until the configuration provider is ready.
  let readSettings = (): Readonly<Record<string, unknown>> => ({})
  const settingChanges = new Emitter<void>()
  const settings: SettingsSource = { current: () => readSettings(), onDidChange: settingChanges.event }
  void configuration.getConfigProvider().then(provider => {
    readSettings = () => asSettings(provider.getConfiguration().get(pluginsSetting))
    provider.onDidChangeConfiguration(event => event.affectsConfiguration(pluginsSetting) && settingChanges.fire())
    settingChanges.fire()
  })

  const link: CommandLink = {
    register: (id, handler) => commands.registerCommand(true, id, (...args: any[]): any => handler(...args)),
    execute: (id, ...args) => commands.executeCommand(id, ...args),
  }
  const renderer = channelOverCommands('extensionHost', link, true)
  const unclean = new Emitter<UncleanUnload>()
  const handle = startRealm({
    realm: 'extensionHost',
    instantiationService,
    services,
    transport: channelTransport('extensionHost', () => renderer),
    modules: nodeModuleHost,
    plugins,
    settings,
    log,
    onUncleanUnload: (id, reason) => unclean.fire({ id, reason }),
  })

  // In a Target window, the Debugger passed the provider registration through the extension environment.
  const registration = targetRegistration(process.env)
  const providerEvents = new Emitter<ProviderEvent>()
  const provider = registration && new ProviderConnection(registration, event => providerEvents.fire(event))
  // A subscriber first receives the current status, so the window never misses the connection's progress.
  const onDidProvider: Event<ProviderEvent> | undefined =
    provider &&
    ((listener, thisArgs, disposables) => {
      const subscription = providerEvents.event(listener, thisArgs, disposables)
      listener.call(thisArgs, { type: 'status', status: provider.status })
      return subscription
    })
  serveOverCommands(
    'extensionHost',
    new RealmServer({ realm: 'extensionHost', handle, onDidProvider, onUncleanUnload: unclean.event }),
    link,
  )
  void link.execute(extensionHostReadyCommand)
  extensionService.joinTermination(async () => {
    provider?.dispose()
    await handle.dispose()
  })
}
