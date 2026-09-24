import { BridgeError, type BridgeTransport, type PluginBuild, type PluginDescriptor, type Realm } from '@vscursed/api'
import { Emitter, type Event } from 'vscode-internal/vs/base/common/event.js'
import type { IChannel, IServerChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import type { RealmHandle } from '../kernel/realm.ts'
import type { JsonSchema } from '../kernel/schema.ts'

/** Name of the IPC channel that every realm serves. */
export const channelName = 'vscursed'

export interface CallRequest {
  realm: Realm
  channel: string
  method: string
  args: unknown[]
}

export interface ListenRequest {
  realm: Realm
  channel: string
  event: string
}

export interface UncleanUnload {
  id: string
  reason: string
}

export interface BuildNotification extends PluginBuild {
  revision: number
}

export interface ReloadRequest {
  descriptor: PluginDescriptor
  revision?: number
}

/**
 * Commands and events of the `vscursed` channel:
 *
 * - `demand(plugins)`: a window reports the plugins it enables (main and shared process only).
 * - `reload(plugin)`: reconciles a freshly read plugin manifest and reloads its code.
 * - `schemas()` / event `schemas`: the JSON Schemas of this realm's plugin `Config`s.
 * - event `build`: Vite+ completed a plugin build (main process only).
 * - `call(CallRequest)` / event `event(ListenRequest)`: bridge traffic, served here or routed on.
 * - event `unclean`: a plugin whose teardown failed, so its process should restart.
 */
export interface RealmServerOptions {
  realm: Realm
  handle: RealmHandle
  demand?(client: string, plugins: PluginDescriptor[]): void
  /** Channels of other realms, for a realm that routes bridge traffic (the renderer). */
  route?(realm: Realm): IChannel | undefined
  onDidBuild?: Event<BuildNotification>
  onUncleanUnload?: Event<UncleanUnload>
}

export class RealmServer implements IServerChannel<string> {
  constructor(private readonly options: RealmServerOptions) {}

  async call(client: string, command: string, arg?: any): Promise<any> {
    const { realm, handle } = this.options
    switch (command) {
      case 'demand':
        if (!this.options.demand) throw new BridgeError(`${realm} does not take plugin demands`)
        return this.options.demand(client, arg as PluginDescriptor[])
      case 'schemas':
        await handle.ready
        return handle.modules.schemas()
      case 'reload':
        return handle.reload((arg as ReloadRequest).descriptor, (arg as ReloadRequest).revision)
      case 'call': {
        const request = arg as CallRequest
        if (request.realm === realm) return (await handle.bridge).invoke(request.channel, request.method, request.args)
        return this.forward(request.realm).call('call', request)
      }
    }
    throw new Error(`unknown command ${command}`)
  }

  listen(_client: string, event: string, arg?: any): Event<any> {
    const { realm, handle } = this.options
    switch (event) {
      case 'schemas': {
        let subscription: { dispose(): void } | undefined
        const emitter: Emitter<Record<string, JsonSchema | null>> = new Emitter({
          onWillAddFirstListener: () => {
            subscription = handle.modules.onDidChangeSchema(() => emitter.fire(handle.modules.schemas()))
          },
          onDidRemoveLastListener: () => subscription?.dispose(),
        })
        return emitter.event
      }
      case 'unclean':
        return this.options.onUncleanUnload ?? (() => ({ dispose() {} }))
      case 'build':
        return this.options.onDidBuild ?? (() => ({ dispose() {} }))
      case 'event': {
        const request = arg as ListenRequest
        if (request.realm !== realm) return this.forward(request.realm).listen('event', request)
        let subscription: Promise<{ dispose(): void } | undefined> | undefined
        const emitter = new Emitter<unknown>({
          onWillAddFirstListener: () => {
            subscription = handle.bridge
              .then(bridge => bridge.subscribe(request.channel, request.event, value => emitter.fire(value)))
              .catch(error => void handle.ctx.logger('bridge').warn(error))
          },
          onDidRemoveLastListener: () => void subscription?.then(inner => inner?.dispose()),
        })
        return emitter.event
      }
    }
    throw new Error(`unknown event ${event}`)
  }

  private forward(realm: Realm) {
    const channel = this.options.route?.(realm)
    if (!channel) throw new BridgeError(`${this.options.realm} cannot reach the ${realm} realm`)
    return channel
  }
}

/** Sends bridge traffic for other realms through the channel that leads to each of them. */
export function channelTransport(self: Realm, route: (realm: Realm) => IChannel | undefined): BridgeTransport {
  const channel = (realm: Realm) => {
    const target = route(realm)
    if (!target) throw new BridgeError(`${self} cannot reach the ${realm} realm`)
    return target
  }
  return {
    call: (realm, name, method, args) =>
      channel(realm).call('call', { realm, channel: name, method, args } satisfies CallRequest),
    listen: (realm, name, event) =>
      channel(realm).listen('event', { realm, channel: name, event } satisfies ListenRequest),
  }
}
