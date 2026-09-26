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
import { localize2 } from 'vscode-internal/vs/nls.js'
import { Action2, MenuId, registerAction2 } from 'vscode-internal/vs/platform/actions/common/actions.js'
import { ContextKeyExpr } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import { IDialogService } from 'vscode-internal/vs/platform/dialogs/common/dialogs.js'
import { SyncDescriptor } from 'vscode-internal/vs/platform/instantiation/common/descriptors.js'
import { InstantiationType, registerSingleton } from 'vscode-internal/vs/platform/instantiation/common/extensions.js'
import {
  createDecorator,
  IInstantiationService,
  type ServicesAccessor,
} from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { INotificationService } from 'vscode-internal/vs/platform/notification/common/notification.js'
import { IQuickInputService, type IQuickPickItem } from 'vscode-internal/vs/platform/quickinput/common/quickInput.js'
import { Registry } from 'vscode-internal/vs/platform/registry/common/platform.js'
import { IStorageService, StorageScope, StorageTarget } from 'vscode-internal/vs/platform/storage/common/storage.js'
import { IURLService, type IOpenURLOptions, type IURLHandler } from 'vscode-internal/vs/platform/url/common/url.js'
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
import { IWorkbenchEnvironmentService } from 'vscode-internal/vs/workbench/services/environment/common/environmentService.js'
import { IWorkbenchExtensionManagementService } from 'vscode-internal/vs/workbench/services/extensionManagement/common/extensionManagement.js'
import type { DebugEndpoint } from '../debug.ts'
import { developmentEnv, targetRegistration } from '../development.ts'
import { setDevelopmentState } from './extension-feature.ts'
import { isDevelopmentTargetContext, IVSCursedService, vscursedCategory } from './service.ts'

const authorizationStorageKey = 'vscursed.development.providers'
const targetsViewId = 'vscursed.development.targets'

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
export interface IDevelopmentDebugger {
  readonly _serviceBrand: undefined
  /** The provider workspaces this profile trusts, one per extension. */
  readonly authorizations: readonly ProviderAuthorization[]
  /** Imports a `vscursed://vscursed/provider/import` URI; returns whether it was one. */
  handleURL(uri: URI): Promise<boolean>
  /** Stops the extension's Target and forgets its provider workspace. */
  disconnect(extensionId: string): Promise<void>
}

export const IDevelopmentDebugger = createDecorator<IDevelopmentDebugger>('vscursedDevelopmentDebugger')

class DevelopmentDebugger extends Disposable implements IDevelopmentDebugger, IURLHandler {
  declare readonly _serviceBrand: undefined
  authorizations: ProviderAuthorization[]
  private readonly sessions = new Map<string, TargetSession>()
  private readonly tree: TreeView

  constructor(
    @IVSCursedService private readonly vscursed: IVSCursedService,
    @IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IStorageService private readonly storageService: IStorageService,
    @IDialogService private readonly dialogService: IDialogService,
    @INotificationService private readonly notificationService: INotificationService,
    @IWorkbenchExtensionManagementService
    private readonly extensionManagementService: IWorkbenchExtensionManagementService,
    @IDebugService private readonly debugService: IDebugService,
    @IURLService urlService: IURLService,
  ) {
    super()
    if (targetRegistration(environmentService.debugExtensionHost.env)) {
      throw new Error('A VSCursed Development Host cannot start Development Hosts itself')
    }
    const stored = storageService.get(authorizationStorageKey, StorageScope.PROFILE, '[]')
    this.authorizations = ProviderAuthorizations.parse(JSON.parse(stored))
    if (JSON.stringify(this.authorizations) !== stored) this.persistAuthorizations()
    this._register(urlService.registerHandler(this))
    this.tree = this.registerView(instantiationService)
  }

  async handleURL(uri: URI, _options?: IOpenURLOptions) {
    if (uri.scheme !== 'vscursed' || uri.authority !== 'vscursed' || uri.path !== '/provider/import') return false
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
          await this.vscursed.channel(realm).call('debugRelease', extensionId)
        }
      }
    }
    try {
      for (const realm of ['main', 'sharedProcess'] as const) {
        if (!manifest[realm]) continue
        const endpoint = await this.vscursed.channel(realm).call<DebugEndpoint>('debugAcquire', extensionId)
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
          await this.vscursed.channel(realm).call('debugRelease', extensionId)
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

  async disconnect(extensionId: string) {
    await this.sessions.get(extensionId)?.stop()
    this.authorizations = this.authorizations.filter(current => current.extensionId !== extensionId)
    this.persistAuthorizations()
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

registerSingleton(IDevelopmentDebugger, DevelopmentDebugger, InstantiationType.Eager)

const notInTarget = isDevelopmentTargetContext.negate()

registerAction2(
  class ImportProvider extends Action2 {
    constructor() {
      super({
        id: 'vscursed.importProvider',
        title: localize2('vscursed.importProvider', 'Import Vite+ Provider'),
        category: vscursedCategory,
        icon: Codicon.add,
        f1: true,
        precondition: notInTarget,
        menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', targetsViewId), group: 'navigation' },
      })
    }

    async run(accessor: ServicesAccessor, value?: unknown) {
      const debuggerService = accessor.get(IDevelopmentDebugger)
      const quickInputService = accessor.get(IQuickInputService)
      const input =
        typeof value === 'string'
          ? value
          : await quickInputService.input({
              prompt: 'Paste the vscursed://vscursed provider URI printed by Vite+',
              placeHolder: 'vscursed://vscursed/provider/import?...',
            })
      if (input) await debuggerService.handleURL(URI.parse(input))
    }
  },
)

registerAction2(
  class DisconnectProvider extends Action2 {
    constructor() {
      super({
        id: 'vscursed.disconnectProvider',
        title: localize2('vscursed.disconnectProvider', 'Disconnect Vite+ Provider'),
        category: vscursedCategory,
        icon: Codicon.debugDisconnect,
        f1: true,
        precondition: notInTarget,
        menu: {
          id: MenuId.ViewItemContext,
          when: ContextKeyExpr.and(
            ContextKeyExpr.equals('view', targetsViewId),
            ContextKeyExpr.equals('viewItem', 'vscursed-target'),
          ),
          group: 'inline',
        },
      })
    }

    async run(accessor: ServicesAccessor, requested?: unknown) {
      const debuggerService = accessor.get(IDevelopmentDebugger)
      const quickInputService = accessor.get(IQuickInputService)
      // The Targets view passes its item handle, which is the extension id.
      let extensionId =
        typeof requested === 'string'
          ? requested
          : (requested as Partial<TreeViewItemHandleArg> | undefined)?.$treeItemHandle
      if (!extensionId) {
        const selected = await quickInputService.pick<AuthorizationPick>(
          debuggerService.authorizations.map(authorization => ({
            extensionId: authorization.extensionId,
            label: authorization.extensionId,
            description: authorization.workspace,
          })),
          { placeHolder: 'Select a Vite+ provider to disconnect' },
        )
        extensionId = selected?.extensionId
      }
      if (extensionId) await debuggerService.disconnect(extensionId)
    }
  },
)
