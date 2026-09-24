import { readPluginManifest, realms, type PluginDescriptor, type PluginManifest, type Realm } from '@vscursed/api'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import { joinPath } from 'vscode-internal/vs/base/common/resources.js'
import { URI } from 'vscode-internal/vs/base/common/uri.js'
import type { IChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import { MenuId, MenuRegistry } from 'vscode-internal/vs/platform/actions/common/actions.js'
import { CommandsRegistry, ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { IConfigurationService } from 'vscode-internal/vs/platform/configuration/common/configuration.js'
import {
  ContextKeyExpr,
  type IContextKey,
  IContextKeyService,
  RawContextKey,
} from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import { IFileService } from 'vscode-internal/vs/platform/files/common/files.js'
import { IInstantiationService } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { IMainProcessService } from 'vscode-internal/vs/platform/ipc/common/mainProcessService.js'
import { ISharedProcessService } from 'vscode-internal/vs/platform/ipc/electron-browser/services.js'
import { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import { INotificationService, Severity } from 'vscode-internal/vs/platform/notification/common/notification.js'
import { IQuickInputService, type IQuickPickItem } from 'vscode-internal/vs/platform/quickinput/common/quickInput.js'
import { registerWorkbenchContribution2, WorkbenchPhase } from 'vscode-internal/vs/workbench/common/contributions.js'
import { IWorkbenchEnvironmentService } from 'vscode-internal/vs/workbench/services/environment/common/environmentService.js'
import { IWorkbenchExtensionManagementService } from 'vscode-internal/vs/workbench/services/extensionManagement/common/extensionManagement.js'
import { IExtensionService } from 'vscode-internal/vs/workbench/services/extensions/common/extensions.js'
import { IHostService } from 'vscode-internal/vs/workbench/services/host/browser/host.js'
import { ILifecycleService } from 'vscode-internal/vs/workbench/services/lifecycle/common/lifecycle.js'
import { samePluginDescriptors, sameRealmPlugins } from '../kernel/descriptors.ts'
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
import { targetRegistration } from '../vscode/development.ts'
import { describePlugins } from '../vscode/extensions.ts'
import { logTo } from '../vscode/log.ts'
import { rendererModuleHost } from '../vscode/renderer/files.ts'
import { DevelopmentDebugger } from '../vscode/renderer/debugger.ts'
import { contributeExtensionsList } from '../vscode/renderer/extensions-list.ts'
import { InstallProbe } from '../vscode/renderer/probe.ts'
import { SettingsSchema } from '../vscode/renderer/settings-schema.ts'
import { DevelopmentTarget } from '../vscode/renderer/target.ts'
import { services } from '../vscode/services.ts'
import { configurationSettings } from '../vscode/settings.ts'

const vscursedExtensionsContext = new RawContextKey<Record<string, boolean>>('vscursed.extensions', {})
const vscursedRealmContexts: Record<Realm, RawContextKey<Record<string, boolean>>> = {
  renderer: new RawContextKey('vscursed.rendererExtensions', {}),
  main: new RawContextKey('vscursed.mainExtensions', {}),
  sharedProcess: new RawContextKey('vscursed.sharedProcessExtensions', {}),
  extensionHost: new RawContextKey('vscursed.extensionHostExtensions', {}),
}
const vscursedExtensionMenu = new MenuId('vscursed.extension')

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
    @IContextKeyService contextKeyService: IContextKeyService,
    @IMainProcessService mainProcessService: IMainProcessService,
    @ISharedProcessService sharedProcessService: ISharedProcessService,
    @IConfigurationService configurationService: IConfigurationService,
    @IFileService fileService: IFileService,
    @IQuickInputService quickInputService: IQuickInputService,
    @INotificationService notificationService: INotificationService,
    @IHostService hostService: IHostService,
    @IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
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
    const vscursedExtensions = vscursedExtensionsContext.bindTo(contextKeyService)
    const vscursedRealms = Object.fromEntries(
      realms.map(realm => [realm, vscursedRealmContexts[realm].bindTo(contextKeyService)]),
    ) as Record<Realm, IContextKey<Record<string, boolean>>>
    let registryDescriptors: PluginDescriptor[] = []
    let descriptors: PluginDescriptor[] = []
    const demands: Partial<Record<'main' | 'sharedProcess', PluginDescriptor[]>> = {}
    const overrides = new Map<string, PluginDescriptor>()
    const pluginChanges = this._register(new Emitter<void>())
    const plugins: PluginSource = { current: () => descriptors, onDidChange: listener => pluginChanges.event(listener) }
    const currentDescriptors = () => registryDescriptors.map(descriptor => overrides.get(descriptor.id) ?? descriptor)
    const updateExtensionContexts = () => {
      vscursedExtensions.set(Object.fromEntries(descriptors.map(descriptor => [descriptor.id, true])))
      for (const realm of realms) {
        vscursedRealms[realm].set(
          Object.fromEntries(
            descriptors.filter(descriptor => descriptor.manifest[realm]).map(descriptor => [descriptor.id, true]),
          ),
        )
      }
    }
    const publishPlugins = () => {
      const next = currentDescriptors()
      if (samePluginDescriptors(descriptors, next)) return
      const rendererChanged = !sameRealmPlugins(descriptors, next, 'renderer')
      descriptors = next
      updateExtensionContexts()
      schema.setPlugins(descriptors)
      for (const realm of ['main', 'sharedProcess'] as const) {
        if (samePluginDescriptors(demands[realm] ?? [], descriptors, realm)) continue
        demands[realm] = descriptors
        channels[realm]!.call('demand', descriptors).catch(error =>
          log('error', `cannot reach the ${realm} realm: ${error}`),
        )
      }
      if (rendererChanged) pluginChanges.fire()
    }
    const readPlugins = () => {
      registryDescriptors = describePlugins(extensionService.extensions, message => log('warn', message))
      const locations = new Map(registryDescriptors.map(descriptor => [descriptor.id, descriptor.location]))
      for (const [id, descriptor] of overrides) {
        if (locations.get(id) !== descriptor.location) overrides.delete(id)
      }
      publishPlugins()
    }
    const registered = extensionService.whenInstalledExtensionsRegistered().then(() => {
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
      log,
      contribute: contributeExtensionsList,
      onUncleanUnload: (id, reason) =>
        notificationService.prompt(
          Severity.Warning,
          `VSCursed could not fully unload ${id} (${reason}). Reload the window to remove what it left behind.`,
          [{ label: 'Reload Window', run: () => hostService.reload() }],
        ),
    })

    const reloadRealm = async (descriptor: PluginDescriptor, realm: Realm) => {
      if (realm === 'renderer') return handle.reload(descriptor)
      await channels[realm]!.call('reload', descriptor)
    }
    const reloadPluginRealm = async (id: string, realm: Realm) => {
      const descriptor = descriptors.find(descriptor => descriptor.id === id)
      if (!descriptor) throw new Error(`VSCursed plugin ${id} is not enabled in this window`)
      await reloadRealm(descriptor, realm)
    }
    const applyManifest = async (id: string, manifest: PluginManifest, details: Partial<PluginDescriptor> = {}) => {
      const installed = registryDescriptors.find(descriptor => descriptor.id === id)
      const current = descriptors.find(descriptor => descriptor.id === id)
      if (!installed || !current) throw new Error(`VSCursed plugin ${id} is not enabled in this window`)
      const descriptor: PluginDescriptor = { ...installed, ...details, manifest }
      overrides.set(id, descriptor)
      const affected = realms.filter(realm => current.manifest[realm] || manifest[realm])
      await Promise.all(affected.map(realm => reloadRealm(descriptor, realm)))
      descriptors = currentDescriptors()
      updateExtensionContexts()
      schema.setPlugins(descriptors)
      for (const realm of ['main', 'sharedProcess'] as const) {
        if (affected.includes(realm)) demands[realm] = descriptors
      }
    }
    const reloadManifest = async (id: string) => {
      const current = registryDescriptors.find(descriptor => descriptor.id === id)
      if (!current) throw new Error(`VSCursed plugin ${id} is not enabled in this window`)
      const packageJson = JSON.parse(
        (await fileService.readFile(joinPath(URI.file(current.location), 'package.json'))).value.toString(),
      )
      const manifest = readPluginManifest(packageJson)
      if (!manifest) throw new Error(`${id} has no "vscursed" field`)
      await applyManifest(id, manifest, { displayName: packageJson.displayName, description: packageJson.description })
    }

    interface PluginPick extends IQuickPickItem {
      id: string
    }
    const reloadCommand = 'vscursed.reloadPlugin'
    this._register(
      CommandsRegistry.registerCommand(reloadCommand, async (_accessor, requested?: unknown) => {
        let id = typeof requested === 'string' ? requested.toLowerCase() : undefined
        if (!id) {
          const selected = await quickInputService.pick<PluginPick>(
            registryDescriptors.map(descriptor => ({
              id: descriptor.id,
              label: descriptor.displayName ?? descriptor.id,
              description: descriptor.id,
            })),
            { placeHolder: 'Select a VSCursed plugin to reload' },
          )
          id = selected?.id
        }
        if (id) await reloadManifest(id)
      }),
    )
    this._register(
      MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
        command: { id: reloadCommand, title: 'Reload Plugin', category: 'VSCursed' },
      }),
    )
    this._register(
      MenuRegistry.appendMenuItem(vscursedExtensionMenu, {
        command: { id: reloadCommand, title: 'Reload Manifest' },
        when: ContextKeyExpr.in('extension', vscursedExtensionsContext.key),
        group: '1_manifest',
      }),
    )

    this._register(
      MenuRegistry.appendMenuItem(MenuId.ExtensionContext, {
        submenu: vscursedExtensionMenu,
        title: 'VSCursed',
        when: ContextKeyExpr.in('extension', vscursedExtensionsContext.key),
        group: '4_configure',
      }),
    )
    for (const realm of realms) {
      const reloadRealmCommand = `vscursed.reloadRealm.${realm}`
      this._register(
        CommandsRegistry.registerCommand(reloadRealmCommand, async (_accessor, requested?: unknown) => {
          const id = typeof requested === 'string' ? requested.toLowerCase() : undefined
          if (!id) throw new Error('Reload Realm requires an extension identifier')
          await reloadPluginRealm(id, realm)
        }),
      )
      this._register(
        MenuRegistry.appendMenuItem(vscursedExtensionMenu, {
          command: { id: reloadRealmCommand, title: `Reload ${realm}` },
          when: ContextKeyExpr.in('extension', vscursedRealmContexts[realm].key),
          group: '2_realms',
        }),
      )
    }

    // A Target window runs one extension from its provider workspace; every other window can debug Targets.
    const registration = targetRegistration(environmentService.debugExtensionHost.env)
    if (registration) {
      this._register(
        instantiationService.createInstance(DevelopmentTarget, registration, extensionHost, {
          applyManifest: async (id, manifest) => {
            await registered
            await applyManifest(id, manifest)
          },
          reloadRealm: reloadPluginRealm,
        }),
      )
    } else {
      this._register(
        instantiationService.createInstance(DevelopmentDebugger, {
          main: channels.main!,
          sharedProcess: channels.sharedProcess!,
        }),
      )
    }

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
