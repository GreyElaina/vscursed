import { realpathSync } from 'node:fs'
import {
  createClientPipeTransport,
  createMessageConnection,
  generateRandomPipeName,
  type MessageConnection,
} from 'vscode-jsonrpc/node'
import {
  providerProtocol,
  type PluginManifest,
  type ProviderBuilt,
  type ProviderHello,
  type Realm,
} from '@vscursed/api'

/**
 * The Vite+ side of a development session: it listens on a private pipe, tells the connected Target
 * which manifest it builds, and reports each successful realm build.
 */
export class DevelopmentProvider {
  readonly importUri: string
  private hello: ProviderHello
  private readonly builtRealms = new Set<Realm>()
  private connection: MessageConnection | undefined

  constructor(extensionId: string, workspace: string, manifest: PluginManifest, endpoint = generateRandomPipeName()) {
    this.hello = { protocol: providerProtocol, extensionId, workspace, manifest }
    const uri = new URL('vscodium://vscursed/provider/import')
    uri.searchParams.set('extensionId', extensionId)
    // VS Code's URI parser decodes the complete query before the handler parses its fields.
    uri.searchParams.set('workspace', encodeURIComponent(workspace))
    uri.searchParams.set('endpoint', encodeURIComponent(endpoint))
    this.importUri = uri.toString()
    void this.accept(endpoint)
  }

  private async accept(endpoint: string) {
    const transport = await createClientPipeTransport(endpoint)
    console.log(`VSCursed provider: ${this.importUri}`)
    const [reader, writer] = await transport.onConnected()
    const connection = createMessageConnection(reader, writer)
    this.connection = connection
    connection.onClose(() => {
      if (this.connection !== connection) return
      this.connection = undefined
      void this.accept(endpoint)
    })
    connection.listen()
    await this.greet(connection)
  }

  private async greet(connection: MessageConnection) {
    await connection.sendNotification('vscursed/hello', this.hello)
    for (const realm of this.builtRealms)
      await connection.sendNotification('vscursed/built', { realm } satisfies ProviderBuilt)
  }

  /** Vite+ re-evaluated the config: a changed manifest restarts the Target's view of the builds. */
  update(manifest: PluginManifest) {
    if (JSON.stringify(manifest) === JSON.stringify(this.hello.manifest)) return
    this.hello = { ...this.hello, manifest }
    this.builtRealms.clear()
    if (this.connection) void this.greet(this.connection)
  }

  async built(realm: Realm) {
    this.builtRealms.add(realm)
    await this.connection?.sendNotification('vscursed/built', { realm } satisfies ProviderBuilt)
  }
}

const providers = new Map<string, DevelopmentProvider>()

/** The provider of a plugin workspace under `vp pack --watch`, shared by the realm configs of one process. */
export function developmentProvider(extensionId: string, root: string, manifest: PluginManifest) {
  if (!process.argv.includes('--watch')) return
  const workspace = realpathSync(root)
  const provider = providers.get(workspace)
  if (provider) {
    provider.update(manifest)
    return provider
  }
  const created = new DevelopmentProvider(extensionId, workspace, manifest)
  providers.set(workspace, created)
  return created
}
