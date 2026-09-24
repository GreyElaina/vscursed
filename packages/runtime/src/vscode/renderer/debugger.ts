import {
  ProviderAuthorization,
  ProviderAuthorizations,
  ProviderRegistration,
  readPluginManifest,
  type PluginManifest,
} from '@vscursed/api'
import { Codicon } from 'vscode-internal/vs/base/common/codicons.js'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import { URI } from 'vscode-internal/vs/base/common/uri.js'
import type { IChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import { localize2 } from 'vscode-internal/vs/nls.js'
import { MenuId, MenuRegistry } from 'vscode-internal/vs/platform/actions/common/actions.js'
import { CommandsRegistry } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { ContextKeyExpr } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import { IDialogService } from 'vscode-internal/vs/platform/dialogs/common/dialogs.js'
import { SyncDescriptor } from 'vscode-internal/vs/platform/instantiation/common/descriptors.js'
import { IInstantiationService } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { INotificationService } from 'vscode-internal/vs/platform/notification/common/notification.js'
import { IQuickInputService, type IQuickPickItem } from 'vscode-internal/vs/platform/quickinput/common/quickInput.js'
import { Registry } from 'vscode-internal/vs/platform/registry/common/platform.js'
import { IStorageService, StorageScope, StorageTarget } from 'vscode-internal/vs/platform/storage/common/storage.js'
import { IURLService, type IOpenURLOptions } from 'vscode-internal/vs/platform/url/common/url.js'
import { TreeView, TreeViewPane } from 'vscode-internal/vs/workbench/browser/parts/views/treeView.js'
import {
  Extensions,
  type ITreeItem,
  type ITreeViewDataProvider,
  type ITreeViewDescriptor,
  type IViewContainersRegistry,
  type IViewsRegistry,
  type TreeViewItemHandleArg,
  TreeItemCollapsibleState,
} from 'vscode-internal/vs/workbench/common/views.js'
import {
  IDebugService,
  type IConfig,
  type IDebugSession,
  type IDebugSessionOptions,
} from 'vscode-internal/vs/workbench/contrib/debug/common/debug.js'
import { VIEWLET_ID } from 'vscode-internal/vs/workbench/contrib/extensions/common/extensions.js'
import { IWorkbenchExtensionManagementService } from 'vscode-internal/vs/workbench/services/extensionManagement/common/extensionManagement.js'
import type { DebugEndpoint } from '../debug.ts'
import { developmentEnv } from '../development.ts'
import { setDevelopmentState } from './extension-feature.ts'

const authorizationStorageKey = 'vscursed.development.providers'
const targetsViewId = 'vscursed.development.targets'
const importCommand = 'vscursed.importProvider'
const disconnectCommand = 'vscursed.disconnectProvider'

/** `extensionHost` launch configuration of js-debug, which opens the Target window. */
interface TargetLaunchConfig extends IConfig {
  args: string[]
  env: Record<string, string>
  outFiles: string[]
  resolveSourceMapLocations: string[]
  debugWebviews: boolean
  debugWebWorkerHost: boolean
  rendererDebugOptions: { webRoot: string; outFiles: string[]; resolveSourceMapLocations: string[] }
}

/** Node `attach` configuration of js-debug, for the Target's plugin in an application-wide realm. */
interface RealmAttachConfig extends IConfig {
  address: string
  port: number
  sourceMaps: boolean
  resolveSourceMapLocations: string[]
  cwd: string
  outFiles: string[]
  eagerSources: boolean
}

/** A running Target: its debug session tree, which ends together. */
interface TargetSession {
  registration: ProviderRegistration
  stop(): Promise<void>
}

interface AuthorizationPick extends IQuickPickItem {
  extensionId: string
}

class TargetTree implements ITreeViewDataProvider {
  constructor(private readonly sessions: ReadonlyMap<string, TargetSession>) {}

  async getChildren(element?: ITreeItem): Promise<ITreeItem[]> {
    if (element) return []
    return [...this.sessions.values()].map(({ registration }) => ({
      handle: registration.extensionId,
      label: { label: registration.extensionId },
      description: registration.workspace,
      tooltip: registration.endpoint,
      themeIcon: Codicon.vmConnect,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: 'vscursed-target',
    }))
  }
}

/**
 * The Debugger side of development: it trusts provider workspaces per profile, turns a provider's import
 * URI into a Target window under js-debug, and attaches to the application-wide realms the plugin uses.
 * The provider registration reaches the Target through the launch configuration's environment.
 */
export class DevelopmentDebugger extends Disposable {
  private authorizations: ProviderAuthorization[]
  private readonly sessions = new Map<string, TargetSession>()
  private readonly tree: TreeView

  constructor(
    private readonly channels: Record<'main' | 'sharedProcess', IChannel>,
    @IInstantiationService instantiationService: IInstantiationService,
    @IStorageService private readonly storageService: IStorageService,
    @IQuickInputService private readonly quickInputService: IQuickInputService,
    @IDialogService private readonly dialogService: IDialogService,
    @INotificationService private readonly notificationService: INotificationService,
    @IWorkbenchExtensionManagementService
    private readonly extensionManagementService: IWorkbenchExtensionManagementService,
    @IDebugService private readonly debugService: IDebugService,
    @IURLService urlService: IURLService,
  ) {
    super()
    const stored = storageService.get(authorizationStorageKey, StorageScope.PROFILE, '[]')
    this.authorizations = ProviderAuthorizations.parse(JSON.parse(stored))
    if (JSON.stringify(this.authorizations) !== stored) this.persistAuthorizations()
    this._register(urlService.registerHandler(this))
    this.registerCommands()
    this.tree = this.registerView(instantiationService)
  }

  async handleURL(uri: URI, _options?: IOpenURLOptions) {
    if (uri.scheme !== 'vscodium' || uri.authority !== 'vscursed' || uri.path !== '/provider/import') return false
    const params = new URLSearchParams(uri.query)
    await this.import(
      ProviderRegistration.parse({
        extensionId: params.get('extensionId')?.toLowerCase(),
        workspace: params.get('workspace'),
        endpoint: params.get('endpoint'),
      }),
    )
    return true
  }

  private async import(registration: ProviderRegistration) {
    const { extensionId, workspace } = registration
    const manifest = await this.readManifest(registration)
    if (!this.authorizations.some(current => current.extensionId === extensionId && current.workspace === workspace)) {
      const confirmation = await this.dialogService.confirm({
        type: 'info',
        message: `Connect ${extensionId} to this VSCursed profile?`,
        detail: workspace,
        primaryButton: 'Connect',
      })
      if (!confirmation.confirmed) return
      this.authorizations = [
        ...this.authorizations.filter(current => current.extensionId !== extensionId),
        ProviderAuthorization.parse(registration),
      ]
      this.persistAuthorizations()
    }
    await this.sessions.get(extensionId)?.stop()
    this.notificationService.info(`Starting the VSCursed Development Host for ${extensionId}.`)
    this.sessions.set(extensionId, await this.launch(registration, manifest))
    setDevelopmentState(extensionId, { role: 'debugger' })
    void this.tree.refresh()
  }

  private async readManifest({ extensionId, workspace }: ProviderRegistration) {
    const resources = await this.extensionManagementService.getExtensions([URI.file(workspace)])
    const resource = resources.find(extension => extension.identifier.id.toLowerCase() === extensionId)
    if (!resource) throw new Error(`${workspace} does not provide ${extensionId}`)
    const manifest = readPluginManifest(resource.manifest)
    if (!manifest) throw new Error(`${extensionId} has no "vscursed" field`)
    return manifest
  }

  private async launch(registration: ProviderRegistration, manifest: PluginManifest): Promise<TargetSession> {
    const { extensionId, workspace } = registration
    const name = `VSCursed: ${extensionId}`
    const outFiles = [`${workspace}/dist/**/*.js`]
    const resolveSourceMapLocations = [`${workspace}/**`]
    const config: TargetLaunchConfig = {
      type: 'extensionHost',
      request: 'launch',
      name,
      args: [`--extensionDevelopmentPath=${workspace}`, `--folder-uri=${URI.file(workspace).toString()}`],
      env: { [developmentEnv]: JSON.stringify(registration) },
      outFiles,
      resolveSourceMapLocations,
      debugWebviews: !!manifest.renderer,
      debugWebWorkerHost: !!manifest.renderer,
      rendererDebugOptions: { webRoot: workspace, outFiles, resolveSourceMapLocations },
    }
    const root = await this.startDebugSession(config)

    const children: { realm: 'main' | 'sharedProcess'; session: IDebugSession }[] = []
    const stopChildren = async () => {
      for (const { realm, session } of children.splice(0).reverse()) {
        try {
          await this.stopDebugSession(session)
        } finally {
          await this.channels[realm].call('debugRelease', extensionId)
        }
      }
    }
    try {
      for (const realm of ['main', 'sharedProcess'] as const) {
        if (!manifest[realm]) continue
        const endpoint = await this.channels[realm].call<DebugEndpoint>('debugAcquire', extensionId)
        try {
          const config: RealmAttachConfig = {
            type: 'node',
            request: 'attach',
            name: `${name} / ${realm}`,
            address: endpoint.host,
            port: endpoint.port,
            sourceMaps: true,
            resolveSourceMapLocations,
            cwd: workspace,
            outFiles,
            eagerSources: true,
          }
          children.push({
            realm,
            session: await this.startDebugSession(config, { parentSession: root, compact: true }),
          })
        } catch (error) {
          await this.channels[realm].call('debugRelease', extensionId)
          throw error
        }
      }
    } catch (error) {
      await stopChildren()
      await this.stopDebugSession(root)
      throw error
    }

    // Closing the Target window ends the root session; ending any session of the tree ends the Target.
    const tracked = new Set([root, ...children.map(child => child.session)])
    let stopping: Promise<void> | undefined
    const session: TargetSession = {
      registration,
      stop: () =>
        (stopping ??= (async () => {
          ended.dispose()
          if (this.sessions.get(extensionId) === session) {
            this.sessions.delete(extensionId)
            setDevelopmentState(extensionId, undefined)
            void this.tree.refresh()
          }
          await stopChildren()
          await this.stopDebugSession(root)
        })()),
    }
    const ended = this.debugService.onDidEndSession(event => {
      if (event.restart || !tracked.has(event.session)) return
      session.stop().catch(error => this.notificationService.error(error))
    })
    return session
  }

  private async startDebugSession(config: IConfig, options?: IDebugSessionOptions) {
    const pending = Promise.withResolvers<IDebugSession>()
    const listener = this.debugService.onWillNewSession(session => {
      if (session.configuration.name === config.name) pending.resolve(session)
    })
    this.debugService.startDebugging(undefined, config, options).then(started => {
      if (!started) pending.reject(new Error(`cannot start debug session ${config.name}`))
    }, pending.reject)
    try {
      return await pending.promise
    } finally {
      listener.dispose()
    }
  }

  private async stopDebugSession(session: IDebugSession) {
    if (!this.debugService.getModel().getSessions(true).includes(session)) return
    const stopped = Promise.withResolvers<void>()
    const listener = this.debugService.onDidEndSession(event => {
      if (event.session === session) stopped.resolve()
    })
    this.debugService.stopSession(session, true).catch(stopped.reject)
    try {
      await stopped.promise
    } finally {
      listener.dispose()
    }
  }

  private registerCommands() {
    this._register(
      CommandsRegistry.registerCommand(importCommand, async (_accessor, value?: unknown) => {
        const input =
          typeof value === 'string'
            ? value
            : await this.quickInputService.input({
                prompt: 'Paste the vscodium://vscursed provider URI printed by Vite+',
                placeHolder: 'vscodium://vscursed/provider/import?...',
              })
        if (input) await this.handleURL(URI.parse(input))
      }),
    )
    this._register(
      CommandsRegistry.registerCommand(disconnectCommand, async (_accessor, requested?: unknown) => {
        let extensionId =
          typeof requested === 'string'
            ? requested
            : (requested as Partial<TreeViewItemHandleArg> | undefined)?.$treeItemHandle
        if (!extensionId) {
          const selected = await this.quickInputService.pick<AuthorizationPick>(
            this.authorizations.map(authorization => ({
              extensionId: authorization.extensionId,
              label: authorization.extensionId,
              description: authorization.workspace,
            })),
            { placeHolder: 'Select a Vite+ provider to disconnect' },
          )
          extensionId = selected?.extensionId
        }
        if (!extensionId) return
        await this.sessions.get(extensionId)?.stop()
        this.authorizations = this.authorizations.filter(current => current.extensionId !== extensionId)
        this.persistAuthorizations()
      }),
    )
    for (const item of [
      {
        id: MenuId.CommandPalette,
        command: { id: importCommand, title: 'Import Vite+ Provider', category: 'VSCursed' },
      },
      {
        id: MenuId.CommandPalette,
        command: { id: disconnectCommand, title: 'Disconnect Vite+ Provider', category: 'VSCursed' },
      },
      {
        id: MenuId.ViewTitle,
        command: { id: importCommand, title: 'Import Vite+ Provider', icon: Codicon.add },
        when: ContextKeyExpr.equals('view', targetsViewId),
        group: 'navigation',
      },
      {
        id: MenuId.ViewItemContext,
        command: { id: disconnectCommand, title: 'Disconnect Provider', icon: Codicon.debugDisconnect },
        when: ContextKeyExpr.and(
          ContextKeyExpr.equals('view', targetsViewId),
          ContextKeyExpr.equals('viewItem', 'vscursed-target'),
        ),
        group: 'inline',
      },
    ]) {
      const { id, ...menuItem } = item
      this._register(MenuRegistry.appendMenuItem(id, menuItem))
    }
  }

  private registerView(instantiationService: IInstantiationService) {
    const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).get(VIEWLET_ID)
    if (!container) throw new Error('Extensions View Container is not registered')
    const title = localize2('vscursed.targets', 'VSCursed Development Hosts')
    const tree = this._register(instantiationService.createInstance(TreeView, targetsViewId, title.value))
    tree.showRefreshAction = true
    tree.dataProvider = new TargetTree(this.sessions)
    const descriptor: ITreeViewDescriptor = {
      id: targetsViewId,
      name: title,
      ctorDescriptor: new SyncDescriptor(TreeViewPane),
      canToggleVisibility: true,
      canMoveView: true,
      treeView: tree,
      collapsed: true,
    }
    Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([descriptor], container)
    return tree
  }

  private persistAuthorizations() {
    this.storageService.store(
      authorizationStorageKey,
      JSON.stringify(this.authorizations),
      StorageScope.PROFILE,
      StorageTarget.MACHINE,
    )
  }
}
