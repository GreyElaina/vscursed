import type { PluginDescriptor, PluginManifest, Realm } from '@vscursed/api'
import type { IChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import { localize2 } from 'vscode-internal/vs/nls.js'
import { RawContextKey } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import { createDecorator } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import type { ILogger } from 'vscode-internal/vs/platform/log/common/log.js'

/** A realm that the window reaches over a channel. */
export type RemoteRealm = Exclude<Realm, 'renderer'>

/**
 * The window's VSCursed realm and its hub: it follows the window's extension enablement, reports the
 * enabled plugins to the application-wide realms, routes bridge traffic between them and the extension
 * host, and registers the plugins' settings schema.
 */
export interface IVSCursedService {
  readonly _serviceBrand: undefined
  /** The renderer's source in the VSCursed output channel. */
  readonly logger: ILogger
  /** The plugins enabled in this window, with manifests applied through {@link applyManifest}. */
  readonly plugins: readonly PluginDescriptor[]
  /** The `vscursed` channel of another realm. */
  channel(realm: RemoteRealm): IChannel
  /** Reads the plugin's manifest from its `package.json` and reloads every realm it touches. */
  reloadManifest(id: string): Promise<void>
  /** Makes `manifest` the plugin's manifest and reloads every realm it touches. */
  applyManifest(id: string, manifest: PluginManifest): Promise<void>
  /** Loads the plugin's module in one realm again. */
  reloadRealm(id: string, realm: Realm): Promise<void>
}

export const IVSCursedService = createDecorator<IVSCursedService>('vscursedService')

export const vscursedCategory = localize2('vscursed', 'VSCursed')

/** Ids of the enabled VSCursed extensions, for `extension in vscursed.extensions` clauses. */
export const vscursedExtensionsContext = new RawContextKey<Record<string, boolean>>('vscursed.extensions', {})

/** Ids of the enabled VSCursed extensions that have a module in each realm. */
export const vscursedRealmContexts: Record<Realm, RawContextKey<Record<string, boolean>>> = {
  renderer: new RawContextKey('vscursed.rendererExtensions', {}),
  main: new RawContextKey('vscursed.mainExtensions', {}),
  sharedProcess: new RawContextKey('vscursed.sharedProcessExtensions', {}),
  extensionHost: new RawContextKey('vscursed.extensionHostExtensions', {}),
}

/** Whether this window is a Development Host that runs one extension from its provider workspace. */
export const isDevelopmentTargetContext = new RawContextKey<boolean>('vscursed.developmentTarget', false)
