import type { EntryOptions } from '@cordisjs/plugin-loader'
import type { Disposable, PluginDescriptor, Realm } from '@vscursed/api'
import { Logger, type Context, type Exporter, type Fiber } from 'cordis'
import type { PluginLoader } from './loader.ts'
import type { PluginModules } from './modules.ts'

/** The plugins that are enabled for this realm, following VS Code's extension enablement. */
export interface PluginSource {
  current(): readonly PluginDescriptor[]
  onDidChange(listener: () => void): Disposable
}

/** The `vscursed.plugins` setting as this realm's configuration service sees it. */
export interface SettingsSource {
  current(): Readonly<Record<string, unknown>>
  onDidChange(listener: () => void): Disposable
}

export interface FileWatcher {
  watch(path: string, onChange: () => void): Disposable
}

export interface PluginHostOptions {
  realm: Realm
  loader: PluginLoader
  modules: PluginModules
  plugins: PluginSource
  settings: SettingsSource
  /** Watches development plugins for hot replacement; absent in realms that cannot watch files. */
  watcher?: FileWatcher
  /**
   * A removed plugin's teardown logged an error or did not finish; whatever it installed may still be
   * in place, and only restarting the process is certain to remove it.
   */
  onUncleanUnload?(id: string, reason: string): void
}

/** Quiet period after a file change, so that a bundler finishing its writes produces one replacement. */
const replaceDelay = 150
/** How long a removed plugin may take to tear down before it counts as unclean. */
const teardownTimeout = 5000

function* ancestors(fiber: Fiber) {
  while (true) {
    yield fiber
    const parent = fiber.parent.fiber
    if (parent === fiber) return
    fiber = parent
  }
}

async function settle(fiber: Fiber, timeout: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>(resolve => (timer = setTimeout(resolve, timeout, false)))
  const settled = (async () => {
    while (fiber.inertia) await fiber.inertia
    return true
  })()
  try {
    return await Promise.race([settled, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Keeps the Loader's root group equal to the enabled plugins and their settings, and replaces a
 * plugin's code when its module changes. Every change runs through one queue, so a reconciliation never
 * overlaps a code replacement.
 */
export class PluginHost {
  private queue = Promise.resolve()
  private dirty = false
  private disposed = false
  private readonly watches = new Map<string, { path: string; watch: Disposable }>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Errors logged inside the fibers of plugins that are being removed. */
  private readonly teardowns = new Map<Fiber, string[]>()

  constructor(
    private readonly ctx: Context,
    private readonly options: PluginHostOptions,
  ) {
    ctx.effect(() => {
      const subscriptions = [
        options.plugins.onDidChange(() => this.schedule()),
        options.settings.onDidChange(() => this.schedule()),
      ]
      return () => {
        this.disposed = true
        for (const subscription of subscriptions) subscription.dispose()
        for (const { watch } of this.watches.values()) watch.dispose()
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.watches.clear()
        return this.queue
      }
    }, 'plugins.host')
    const exporter: Exporter = {
      levels: { default: 0 },
      export: message => {
        const origin = message.fiber?.deref()
        if (!origin) return
        for (const fiber of ancestors(origin)) {
          const errors = this.teardowns.get(fiber)
          if (errors) return void errors.push(Logger.format(exporter, message))
        }
      },
    }
    ctx.logger.exporter(exporter)
  }

  /** Reconciles with the current sources; calls made while one is queued share it. */
  schedule(): Promise<void> {
    if (this.dirty) return this.queue
    this.dirty = true
    return this.enqueue(() => {
      this.dirty = false
      return this.reconcile()
    })
  }

  /** Re-imports a plugin's module and rebuilds its fiber with the same entry and config. */
  replace(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.options.modules.invalidate(id)
      await this.rebuild(id)
    })
  }

  private enqueue(task: () => Promise<void>) {
    const run = this.queue.then(() => (this.disposed ? undefined : task()))
    this.queue = run.catch(error => this.ctx.logger('plugins').error(error))
    return this.queue
  }

  private async reconcile() {
    const { realm, loader, modules, plugins, settings } = this.options
    const descriptors = plugins.current().filter(descriptor => descriptor.manifest[realm])
    const moved = modules.update(descriptors)
    const values = settings.current()
    const entries: EntryOptions[] = descriptors.map(descriptor => ({
      id: descriptor.id,
      name: descriptor.id,
      config: values[descriptor.id] ?? {},
    }))
    const wanted = new Set(entries.map(entry => entry.id))
    const removed: [string, Fiber][] = []
    for (const [id, entry] of Object.entries(loader.store)) {
      const fiber = entry.fiber?.ctx.fiber
      if (wanted.has(id) || !fiber) continue
      removed.push([id, fiber])
      this.teardowns.set(fiber, [])
    }
    await loader.root.update(entries)
    // The Loader restarts an entry for a config change but not for a new module file.
    for (const id of moved) await this.rebuild(id)
    this.syncWatches(descriptors)
    await Promise.all(removed.map(([id, fiber]) => this.checkTeardown(id, fiber)))
  }

  private async checkTeardown(id: string, fiber: Fiber) {
    const settled = await settle(fiber, teardownTimeout)
    const errors = this.teardowns.get(fiber) ?? []
    this.teardowns.delete(fiber)
    const reason = !settled
      ? `its teardown did not finish within ${teardownTimeout / 1000}s`
      : errors[0]?.split('\n')[0]
    if (reason === undefined) return
    this.ctx.logger('plugins').warn('%C was not unloaded cleanly: %s', id, reason)
    this.options.onUncleanUnload?.(id, reason)
  }

  /**
   * Deleting the plugin from the registry (not disposing its fiber) tells the Loader that the entry is
   * being replaced rather than disabled; the entry then imports the module again on refresh.
   */
  private async rebuild(id: string) {
    const entry = this.options.loader.store[id]
    if (!entry) return
    const fiber = entry.fiber
    if (fiber?.runtime) this.ctx.registry.delete(fiber.runtime.callback)
    while (fiber?.inertia) await fiber.inertia
    entry.fiber = undefined
    await entry.refresh()
  }

  private syncWatches(descriptors: readonly PluginDescriptor[]) {
    const { watcher, modules } = this.options
    if (!watcher) return
    const wanted = new Map<string, string>()
    for (const descriptor of descriptors) {
      const path = descriptor.development ? modules.path(descriptor.id) : undefined
      if (path) wanted.set(descriptor.id, path)
    }
    for (const [id, current] of this.watches) {
      if (wanted.get(id) === current.path) continue
      current.watch.dispose()
      this.watches.delete(id)
    }
    for (const [id, path] of wanted) {
      if (this.watches.has(id)) continue
      const watch = watcher.watch(path, () => {
        clearTimeout(this.timers.get(id))
        this.timers.set(
          id,
          setTimeout(() => {
            this.timers.delete(id)
            this.ctx.logger('plugins').info('replacing %C after a change to %s', id, path)
            void this.replace(id)
          }, replaceDelay),
        )
      })
      this.watches.set(id, { path, watch })
    }
  }
}
