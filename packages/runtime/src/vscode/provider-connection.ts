import { ProviderBuilt, ProviderHello, type ProviderRegistration } from '@vscursed/api'
import { createMessageConnection, createServerPipeTransport, type MessageConnection } from 'vscode-jsonrpc/node'
import type { ProviderEvent, ProviderStatus } from './development.ts'

/**
 * The Target extension host's end of the provider pipe. The provider's hello decides the manifest; the
 * connection is `connected` once every realm of that manifest has been built, and reports each later
 * rebuild as a `built` event.
 */
export class ProviderConnection {
  status: ProviderStatus = { connection: 'connecting', built: [] }
  private readonly connection: MessageConnection
  private stopped = false

  constructor(
    private readonly registration: ProviderRegistration,
    private readonly listener: (event: ProviderEvent) => void,
  ) {
    const [reader, writer] = createServerPipeTransport(registration.endpoint)
    this.connection = createMessageConnection(reader, writer)
    this.connection.onNotification('vscursed/hello', value => this.hello(value))
    this.connection.onNotification('vscursed/built', value => this.built(value))
    this.connection.onError(([error]) => this.fail(error.message))
    this.connection.onClose(() => {
      if (this.stopped || this.status.connection === 'failed') return
      this.publish({ ...this.status, connection: 'disconnected' })
    })
    this.connection.listen()
  }

  private hello(value: unknown) {
    const result = ProviderHello.safeParse(value)
    if (!result.success) return this.fail(`invalid hello: ${result.error.message}`)
    const { extensionId, workspace, manifest } = result.data
    const expected = this.registration
    if (extensionId !== expected.extensionId || workspace !== expected.workspace) {
      return this.fail(
        `provider serves ${extensionId} from ${workspace}, not ${expected.extensionId} from ${expected.workspace}`,
      )
    }
    this.publish({ connection: 'connecting', manifest, built: [] })
  }

  private built(value: unknown) {
    if (this.status.connection === 'failed') return
    const result = ProviderBuilt.safeParse(value)
    if (!result.success) return this.fail(`invalid build: ${result.error.message}`)
    const { realm } = result.data
    const { manifest, built } = this.status
    if (!manifest) return this.fail('provider sent a build before its hello')
    if (!manifest[realm]) return this.fail(`provider built the undeclared ${realm} realm`)
    if (this.status.connection === 'connected') return this.listener({ type: 'built', realm })
    if (built.includes(realm)) return
    const next = [...built, realm]
    const complete = Object.keys(manifest).every(declared => next.includes(declared as typeof realm))
    this.publish({ ...this.status, connection: complete ? 'connected' : 'connecting', built: next })
  }

  private fail(error: string) {
    this.publish({ ...this.status, connection: 'failed', error })
    this.connection.dispose()
  }

  private publish(status: ProviderStatus) {
    this.status = status
    this.listener({ type: 'status', status })
  }

  dispose() {
    this.stopped = true
    this.connection.dispose()
  }
}
