import type { PluginDescriptor } from '@vscursed/api'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import type { PluginSource } from '../kernel/host.ts'

/**
 * The plugin set of an application-wide realm: every plugin that at least one connected window
 * enables. A window's demand ends when its connection does.
 */
export class WindowDemand implements PluginSource {
  private readonly windows = new Map<string, readonly PluginDescriptor[]>()
  private readonly changes = new Emitter<void>()
  readonly onDidChange = this.changes.event

  set(client: string, plugins: readonly PluginDescriptor[]) {
    this.windows.set(client, plugins)
    this.changes.fire()
  }

  delete(client: string) {
    if (this.windows.delete(client)) this.changes.fire()
  }

  current() {
    const union = new Map<string, PluginDescriptor>()
    for (const plugins of this.windows.values()) {
      for (const plugin of plugins) union.set(plugin.id, plugin)
    }
    return [...union.values()]
  }
}
