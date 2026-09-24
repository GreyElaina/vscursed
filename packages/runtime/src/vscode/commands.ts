import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { DisposableStore, toDisposable, type IDisposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import type { IChannel, IServerChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'

/** The two command operations each side of the renderer ↔ extension host link has. */
export interface CommandLink {
  register(id: string, handler: (...args: any[]) => unknown): IDisposable
  execute(id: string, ...args: unknown[]): Promise<unknown>
}

export type LinkSide = 'renderer' | 'extensionHost'

const command = (side: LinkSide, name: string) => `_vscursed.${side}.${name}`
const other = (side: LinkSide): LinkSide => (side === 'renderer' ? 'extensionHost' : 'renderer')

/**
 * Serves `server` to the other side of the link through internal commands, the one channel VS Code
 * already keeps between a window and its extension host.
 */
export function serveOverCommands(side: LinkSide, server: IServerChannel<string>, link: CommandLink): IDisposable {
  const store = new DisposableStore()
  const subscriptions = new Map<number, IDisposable>()
  store.add(link.register(command(side, 'call'), (name: string, arg: unknown) => server.call(other(side), name, arg)))
  store.add(
    link.register(command(side, 'listen'), (id: number, event: string, arg: unknown) => {
      subscriptions.get(id)?.dispose()
      subscriptions.set(
        id,
        server.listen(other(side), event, arg)(data => void link.execute(command(other(side), 'fire'), id, data)),
      )
    }),
  )
  store.add(
    link.register(command(side, 'unlisten'), (id: number) => {
      subscriptions.get(id)?.dispose()
      subscriptions.delete(id)
    }),
  )
  store.add(
    toDisposable(() => {
      for (const subscription of subscriptions.values()) subscription.dispose()
      subscriptions.clear()
    }),
  )
  return store
}

export interface CommandChannel extends IChannel, IDisposable {
  /** The other side (re)started serving: pending calls proceed and events resubscribe. */
  ready(): void
  /** The other side stopped; calls wait for the next {@link ready}. */
  reset(): void
}

/**
 * The client half: an `IChannel` whose requests are commands of the other side. Calls wait until the
 * other side is ready; events are resubscribed after it restarts.
 */
export function channelOverCommands(side: LinkSide, link: CommandLink, initiallyReady: boolean): CommandChannel {
  const remote = other(side)
  const listeners = new Map<number, { emitter: Emitter<unknown>; event: string; arg: unknown }>()
  let ready = Promise.withResolvers<void>()
  let isReady = initiallyReady
  if (isReady) ready.resolve()
  let counter = 0
  const fire = link.register(command(side, 'fire'), (id: number, data: unknown) =>
    listeners.get(id)?.emitter.fire(data),
  )
  const subscribe = (id: number) => {
    const listener = listeners.get(id)
    if (listener) void link.execute(command(remote, 'listen'), id, listener.event, listener.arg)
  }

  return {
    async call<T>(name: string, arg?: unknown): Promise<T> {
      await ready.promise
      return (await link.execute(command(remote, 'call'), name, arg)) as T
    },
    listen<T>(event: string, arg?: unknown) {
      const id = ++counter
      const emitter = new Emitter<unknown>({
        onWillAddFirstListener: () => {
          listeners.set(id, { emitter, event, arg })
          // Subscribing before the other side is ready is covered by the resubscription in `ready()`.
          if (isReady) subscribe(id)
        },
        onDidRemoveLastListener: () => {
          listeners.delete(id)
          if (isReady) void link.execute(command(remote, 'unlisten'), id)
        },
      })
      return emitter.event as Emitter<T>['event']
    },
    ready() {
      if (isReady) return
      isReady = true
      ready.resolve()
      for (const id of listeners.keys()) subscribe(id)
    },
    reset() {
      if (!isReady) return
      isReady = false
      ready = Promise.withResolvers<void>()
    },
    dispose() {
      isReady = false
      fire.dispose()
      for (const { emitter } of listeners.values()) emitter.dispose()
      listeners.clear()
    },
  }
}

/** Command by which the extension host announces that it serves the link. */
export const extensionHostReadyCommand = command('renderer', 'extensionHostReady')
