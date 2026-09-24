import type { PluginDescriptor } from '@vscursed/api'
import type { start as Start } from 'vscode-internal/vs/vscursed/runtime/extensionHost.js'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import { IExtHostCommands } from 'vscode-internal/vs/workbench/api/common/extHostCommands.js'
import { IExtHostConfiguration } from 'vscode-internal/vs/workbench/api/common/extHostConfiguration.js'
import { IExtHostExtensionService } from 'vscode-internal/vs/workbench/api/common/extHostExtensionService.js'
import { sameRealmPlugins } from '../kernel/descriptors.ts'
import type { PluginSource, SettingsSource } from '../kernel/host.ts'
import { startRealm } from '../kernel/realm.ts'
import { channelTransport, RealmServer, type UncleanUnload } from '../vscode/channel.ts'
import {
  channelOverCommands,
  extensionHostReadyCommand,
  serveOverCommands,
  type CommandLink,
} from '../vscode/commands.ts'
import { describePlugins } from '../vscode/extensions.ts'
import { logTo } from '../vscode/log.ts'
import { nodeModuleHost } from '../vscode/node.ts'
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
  const plugins: PluginSource = { current: () => descriptors, onDidChange: listener => pluginChanges.event(listener) }
  void extensionService.getExtensionRegistry().then(registry => {
    const read = () => {
      const next = describePlugins(registry.getAllExtensionDescriptions(), message => log('warn', message))
      const changed = !sameRealmPlugins(descriptors, next, 'extensionHost')
      descriptors = next
      if (changed) pluginChanges.fire()
    }
    registry.onDidChange(read)
    read()
  })

  let values: Readonly<Record<string, unknown>> = {}
  let serializedValues = JSON.stringify(values)
  const settingChanges = new Emitter<void>()
  const settings: SettingsSource = { current: () => values, onDidChange: listener => settingChanges.event(listener) }
  void configuration.getConfigProvider().then(provider => {
    const read = () => {
      const next = asSettings(provider.getConfiguration().get(pluginsSetting))
      const serialized = JSON.stringify(next)
      if (serialized === serializedValues) return
      values = next
      serializedValues = serialized
      settingChanges.fire()
    }
    provider.onDidChangeConfiguration(event => event.affectsConfiguration(pluginsSetting) && read())
    read()
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
  serveOverCommands(
    'extensionHost',
    new RealmServer({ realm: 'extensionHost', handle, onUncleanUnload: unclean.event }),
    link,
  )
  void link.execute(extensionHostReadyCommand)
  extensionService.joinTermination(() => handle.dispose())
}
