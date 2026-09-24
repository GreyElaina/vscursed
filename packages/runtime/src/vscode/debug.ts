import inspector from 'node:inspector'

export interface DebugEndpoint {
  host: string
  port: number
}

/**
 * Leases on the Node inspector of one VSCursed realm process, held by Debugger windows for their
 * Targets. An inspector this class opened closes with the last lease; one opened by `--inspect` stays.
 */
export class NodeDebugEndpoints {
  /** Extension identifiers leased by each window. */
  private readonly leases = new Map<string, Set<string>>()
  private owned = false

  acquire(client: string, extensionId: string): DebugEndpoint {
    if (!inspector.url()) {
      inspector.open(0, '127.0.0.1')
      this.owned = true
    }
    const leases = this.leases.get(client) ?? new Set<string>()
    leases.add(extensionId)
    this.leases.set(client, leases)
    const endpoint = new URL(inspector.url()!)
    return { host: endpoint.hostname, port: Number(endpoint.port) }
  }

  release(client: string, extensionId: string) {
    const leases = this.leases.get(client)
    leases?.delete(extensionId)
    if (!leases?.size) this.releaseClient(client)
  }

  /** A window went away with whatever it leased. */
  releaseClient(client: string) {
    this.leases.delete(client)
    if (this.leases.size || !this.owned) return
    inspector.close()
    this.owned = false
  }

  dispose() {
    this.leases.clear()
    if (this.owned) inspector.close()
    this.owned = false
  }
}
