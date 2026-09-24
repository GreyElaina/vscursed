import { Context, Service } from 'cordis'
import type { Realm } from './realm.ts'

declare module 'cordis' {
  interface Context {
    bridge: Bridge
  }
}

export interface Disposable {
  dispose(): void
}

/** VS Code's event shape: subscribing returns a disposable. */
export type Event<T> = (listener: (event: T) => unknown) => Disposable

/**
 * Cross-realm channels, keyed by channel name. Plugins declare the channels they provide:
 *
 * ```ts
 * declare module '@vscursed/api' {
 *   interface Channels {
 *     'sample.clock': ChannelSpec<'sharedProcess', { now(): number; onTick: Event<number> }>
 *   }
 * }
 * ```
 *
 * Members named `on[A-Z]...` are events, all other members are methods. Arguments, results and event
 * payloads cross process boundaries and must be structured-clone/JSON compatible.
 */
export interface Channels {}

export interface ChannelSpec<R extends Realm = Realm, T extends object = object> {
  realm: R
  api: T
}

export type ChannelName = keyof Channels & string
export type ChannelRealm<K extends ChannelName> = Channels[K] extends ChannelSpec<infer R> ? R : never
export type ChannelApi<K extends ChannelName> = Channels[K] extends ChannelSpec<Realm, infer T> ? T : never

/** The consumer's view of a channel: methods become asynchronous, events stay events. */
export type Remote<T> = {
  [K in keyof T]: K extends `on${string}`
    ? T[K] extends Event<infer E>
      ? Event<E>
      : never
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never
}

/** Carries channel traffic to other realms; supplied by the realm runtime. */
export interface BridgeTransport {
  call(realm: Realm, channel: string, method: string, args: unknown[]): Promise<unknown>
  listen(realm: Realm, channel: string, event: string): Event<unknown>
}

export interface BridgeConfig {
  realm: Realm
  transport: BridgeTransport
}

const isEventName = (name: string) => /^on[A-Z]/.test(name)

export class BridgeError extends Error {
  override name = 'BridgeError'
}

/** Provides channels from this realm and connects to channels of other realms. */
export class Bridge extends Service {
  readonly realm: Realm
  private readonly transport: BridgeTransport
  private readonly providers = new Map<string, object>()
  /** Subscriptions that remote realms hold on local providers, ended when the provider goes away. */
  private readonly subscriptions = new Map<string, Set<Disposable>>()

  constructor(ctx: Context, config: BridgeConfig) {
    super(ctx, 'bridge')
    this.realm = config.realm
    this.transport = config.transport
  }

  provide<K extends ChannelName>(name: K, api: ChannelApi<K>): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.providers.has(name)) throw new BridgeError(`channel ${name} is already provided in ${this.realm}`)
      this.providers.set(name, api)
      return () => {
        this.providers.delete(name)
        for (const subscription of this.subscriptions.get(name) ?? []) subscription.dispose()
        this.subscriptions.delete(name)
      }
    }, `bridge.provide(${name})`)
  }

  /**
   * Returns the channel's remote view. Calls fail while the channel is not provided; event
   * subscriptions are effects of the calling fiber.
   */
  connect<K extends ChannelName>(realm: ChannelRealm<K>, name: K): Remote<ChannelApi<K>> {
    const ctx = this.ctx
    return new Proxy(Object.create(null), {
      get: (_, member) => {
        if (typeof member !== 'string') return
        if (isEventName(member)) {
          return (listener: (event: unknown) => unknown): Disposable => {
            const dispose = ctx.effect(() => {
              const subscription = this.listen(realm, name, member)(listener)
              return () => subscription.dispose()
            }, `bridge.connect(${name}).${member}`)
            return { dispose: () => void dispose() }
          }
        }
        return (...args: unknown[]) => this.call(realm, name, member, args)
      },
    })
  }

  call(realm: Realm, channel: string, method: string, args: unknown[]): Promise<unknown> {
    if (realm !== this.realm) return this.transport.call(realm, channel, method, args)
    return this.invoke(channel, method, args)
  }

  listen(realm: Realm, channel: string, event: string): Event<unknown> {
    if (realm !== this.realm) return this.transport.listen(realm, channel, event)
    return listener => this.subscribe(channel, event, listener)
  }

  /** Serves a call addressed to this realm. */
  async invoke(channel: string, method: string, args: unknown[]): Promise<unknown> {
    const api = this.providers.get(channel)
    const member = api && !isEventName(method) ? Reflect.get(api, method) : undefined
    if (typeof member !== 'function') throw new BridgeError(`${this.realm} provides no method ${channel}.${method}`)
    return await Reflect.apply(member, api, args)
  }

  /** Serves a subscription addressed to this realm. */
  subscribe(channel: string, event: string, listener: (event: unknown) => unknown): Disposable {
    const api = this.providers.get(channel)
    const source = api && isEventName(event) ? Reflect.get(api, event) : undefined
    if (typeof source !== 'function') throw new BridgeError(`${this.realm} provides no event ${channel}.${event}`)
    const inner: Disposable = Reflect.apply(source, api, [listener])
    let set = this.subscriptions.get(channel)
    if (!set) this.subscriptions.set(channel, (set = new Set()))
    const subscriptions = set
    const subscription = {
      dispose: () => {
        if (!subscriptions.delete(subscription)) return
        inner.dispose()
      },
    }
    subscriptions.add(subscription)
    return subscription
  }
}
