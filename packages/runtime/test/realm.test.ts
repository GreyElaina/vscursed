import type { PluginDescriptor } from '@vscursed/api'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'
import type { FileWatcher, PluginSource, SettingsSource } from '../src/kernel/host.ts'
import { startRealm, type RealmHandle } from '../src/kernel/realm.ts'

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
    current: () => value,
    onDidChange(listener: () => void) {
      listeners.add(listener)
      return { dispose: () => void listeners.delete(listener) }
    },
  }
}

const descriptor: PluginDescriptor = {
  id: 'test.clock',
  location: '/extensions/clock',
  manifest: { renderer: './dist/renderer.js' },
  development: true,
}

/** A plugin module whose lifecycle is recorded in `events`. */
function clockModule(events: string[], version: string, options: { failTeardown?: boolean } = {}) {
  return {
    name: 'clock',
    Config: z.object({ label: z.string().default('clock') }),
    apply(ctx: any, config: { label: string }) {
      events.push(`${version} apply ${config.label}`)
      ctx.effect(() => () => {
        events.push(`${version} dispose ${config.label}`)
        if (options.failTeardown) throw new Error('left something behind')
      })
    },
  }
}

describe('startRealm', () => {
  let handle: RealmHandle | undefined
  afterEach(() => handle?.dispose())

  function start(modules: Record<string, unknown>, onUncleanUnload?: (id: string, reason: string) => void) {
    const plugins = source<readonly PluginDescriptor[]>([descriptor])
    const settings = source<Readonly<Record<string, unknown>>>({ 'test.clock': { label: 'first' } })
    const watches = new Map<string, () => void>()
    const watcher: FileWatcher = {
      watch(path, onChange) {
        watches.set(path, onChange)
        return { dispose: () => void watches.delete(path) }
      },
    }
    const logs: string[] = []
    handle = startRealm({
      realm: 'renderer',
      instantiationService: { invokeFunction: (fn: any) => fn({ get: () => undefined }) } as never,
      services: { service: id => id },
      transport: { call: async () => undefined, listen: () => () => ({ dispose() {} }) },
      modules: {
        toUrl: path => `memory:${path}`,
        async import(url) {
          if (!(url in modules)) throw new Error(`no module at ${url}`)
          return modules[url]
        },
      },
      plugins: plugins as PluginSource,
      settings: settings as SettingsSource,
      watcher,
      log: (level, message) => logs.push(`${level} ${message}`),
      onUncleanUnload,
    })
    return { plugins, settings, watches, logs, handle }
  }

  const url = 'memory:/extensions/clock/dist/renderer.js'

  it('loads enabled plugins with their settings and follows setting changes', async () => {
    const events: string[] = []
    const { settings, handle } = start({ [url]: clockModule(events, 'v0') })
    await handle.ready
    expect(events).toEqual(['v0 apply first'])

    settings.set({ 'test.clock': { label: 'second' } })
    await vi.waitFor(() => expect(events).toEqual(['v0 apply first', 'v0 dispose first', 'v0 apply second']))
  })

  it('keeps the running config when a setting fails validation', async () => {
    const events: string[] = []
    const { settings, logs, handle } = start({ [url]: clockModule(events, 'v0') })
    await handle.ready
    settings.set({ 'test.clock': { label: 42 } })
    await vi.waitFor(() =>
      expect(logs.some(line => line.startsWith('error') && line.includes('invalid config'))).toBe(true),
    )
    expect(events).toEqual(['v0 apply first'])
  })

  it('replaces the module of a development plugin and keeps its config', async () => {
    const events: string[] = []
    const modules: Record<string, unknown> = { [url]: clockModule(events, 'v0') }
    const { watches, handle } = start(modules)
    await handle.ready
    modules[`${url}?revision=1`] = clockModule(events, 'v1')
    watches.get('/extensions/clock/dist/renderer.js')!()
    await vi.waitFor(() => expect(events).toEqual(['v0 apply first', 'v0 dispose first', 'v1 apply first']))
  })

  it('reports Config schemas and unloads disabled plugins', async () => {
    const events: string[] = []
    const { plugins, handle } = start({ [url]: clockModule(events, 'v0') })
    await handle.ready
    expect(handle.modules.schemas()['test.clock']).toMatchObject({
      type: 'object',
      properties: { label: { type: 'string' } },
    })
    plugins.set([])
    await vi.waitFor(() => expect(events).toEqual(['v0 apply first', 'v0 dispose first']))
    expect(handle.modules.schemas()).toEqual({})
  })

  it('reports a plugin whose teardown failed', async () => {
    const events: string[] = []
    const unclean = vi.fn()
    const { plugins, handle } = start({ [url]: clockModule(events, 'v0', { failTeardown: true }) }, unclean)
    await handle.ready
    plugins.set([])
    await vi.waitFor(() =>
      expect(unclean).toHaveBeenCalledWith('test.clock', expect.stringContaining('left something behind')),
    )
  })
})
