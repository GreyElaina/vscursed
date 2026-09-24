import { Loader } from '@cordisjs/plugin-loader'
import type { Context } from 'cordis'
import type { PluginModules } from './modules.ts'

export interface PluginLoaderConfig {
  modules: PluginModules
}

/**
 * Cordis's Loader with plugin code supplied by {@link PluginModules}. Entry names are plugin ids; the
 * Loader keeps owning entry creation, config updates, removal and fiber lifecycle.
 */
export class PluginLoader extends Loader {
  private readonly modules: PluginModules

  constructor(ctx: Context, config: PluginLoaderConfig) {
    super(ctx, {})
    this.modules = config.modules
    // The Loader's own apply/reload/unload log lines, one per entry change.
    this.enableLogs = true
  }

  override import(name: string) {
    return this.modules.import(name)
  }
}
