import { Context } from 'cordis'
import { describe, expect, it } from 'vite-plus/test'
import { Bridge, type BridgeTransport, type Event } from '../src/bridge.ts'

declare module '../src/bridge.ts' {
  interface Channels {
    'test.counter': ChannelSpec<'renderer', { add(a: number, b: number): number; onCount: Event<number> }>
    'test.remote': ChannelSpec<'main', { ping(): string }>
  }
}

function counter() {
  const listeners = new Set<(value: number) => unknown>()
  return {
    listeners,
    api: {
      add: (a: number, b: number) => a + b,
      onCount: (listener: (value: number) => unknown) => {
        listeners.add(listener)
        return { dispose: () => void listeners.delete(listener) }
      },
    },
  }
}

describe('Bridge', () => {
  const transport: BridgeTransport = {
    call: async (realm, channel, method, args) => `${realm}:${channel}.${method}(${args.join()})`,
    listen: () => () => ({ dispose() {} }),
  }

  it('serves local channels and ties subscriptions to both sides', async () => {
    const root = new Context()
    await root.plugin(Bridge, { realm: 'renderer', transport })
    const source = counter()
    const provider = root.plugin({
      inject: ['bridge'],
      apply: (ctx: Context) => void ctx.bridge.provide('test.counter', source.api),
    })
    await provider

    const received: number[] = []
    let remote!: ReturnType<Bridge['connect']>
    const consumer = root.plugin({
      inject: ['bridge'],
      apply(ctx: Context) {
        const channel = ctx.bridge.connect('renderer', 'test.counter')
        remote = channel as never
        channel.onCount(value => received.push(value))
      },
    })
    await consumer
    await expect((remote as any).add(2, 3)).resolves.toBe(5)
    for (const listener of source.listeners) listener(1)
    expect(received).toEqual([1])

    await consumer.dispose()
    expect(source.listeners.size).toBe(0)
  })

  it('ends remote subscriptions when the provider goes away', async () => {
    const root = new Context()
    await root.plugin(Bridge, { realm: 'renderer', transport })
    const bridge = root.get('bridge')!
    const source = counter()
    const provider = root.plugin({
      inject: ['bridge'],
      apply: (ctx: Context) => void ctx.bridge.provide('test.counter', source.api),
    })
    await provider
    bridge.subscribe('test.counter', 'onCount', () => {})
    expect(source.listeners.size).toBe(1)
    await provider.dispose()
    expect(source.listeners.size).toBe(0)
    await expect(bridge.invoke('test.counter', 'add', [1, 2])).rejects.toThrow(/provides no method/)
  })

  it('sends other realms through the transport', async () => {
    const root = new Context()
    await root.plugin(Bridge, { realm: 'renderer', transport })
    const result = await root.get('bridge')!.connect('main', 'test.remote').ping()
    expect(result).toBe('main:test.remote.ping()')
  })
})
