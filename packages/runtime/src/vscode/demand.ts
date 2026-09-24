import type { PluginDescriptor, Realm } from '@vscursed/api'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { samePluginDescriptors, sameRealmPlugins } from '../kernel/descriptors.ts'
import type { PluginSource } from '../kernel/host.ts'

/**
 * The plugin set of an application-wide realm: every plugin that at least one connected window
 * enables. A window's demand ends when its connection does.
 */
export class WindowDemand implements PluginSource {
  private readonly windows = new Map<string, readonly PluginDescriptor[]>()
  private readonly changes = new Emitter<void>()
  private plugins: readonly PluginDescriptor[] = []

  constructor(private readonly realm: Realm) {}

  set(client: string, plugins: readonly PluginDescriptor[]) {
    if (samePluginDescriptors(this.windows.get(client) ?? [], plugins, this.realm)) return
    this.windows.set(client, plugins)
    if (this.update()) this.changes.fire()
  }

  delete(client: string) {
    if (!this.windows.delete(client)) return
    if (this.update()) this.changes.fire()
  }

  current() {
    return this.plugins
  }

  private update() {
    const union = new Map<string, PluginDescriptor>()
    for (const plugins of this.windows.values()) {
      for (const plugin of plugins) union.set(plugin.id, plugin)
    }
    const plugins = [...union.values()]
    const changed = !sameRealmPlugins(this.plugins, plugins, this.realm)
    this.plugins = plugins
    return changed
  }

  onDidChange(listener: () => void) {
    return this.changes.event(listener)
  }
}
