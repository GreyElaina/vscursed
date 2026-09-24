import type { PluginDescriptor, Realm } from '@vscursed/api'
import type { IJSONSchema } from 'vscode-internal/vs/base/common/jsonSchema.js'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import {
  Extensions,
  type IConfigurationNode,
  type IConfigurationRegistry,
} from 'vscode-internal/vs/platform/configuration/common/configurationRegistry.js'
import { Registry } from 'vscode-internal/vs/platform/registry/common/platform.js'
import { mergeRealmSchemas, type JsonSchema, type RealmSchemas } from '../../kernel/schema.ts'
import { pluginsSetting } from '../settings.ts'

/**
 * Registers `vscursed.plugins` with one property per enabled plugin, whose schema is the plugin's
 * `Config` as reported by every realm it has a module in. settings.json completion and validation
 * follow each update, including schemas that change when a plugin is replaced during development.
 */
export class SettingsSchema extends Disposable {
  private readonly registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration)
  private readonly schemas = new Map<string, RealmSchemas>()
  private plugins: readonly PluginDescriptor[] = []
  private node: IConfigurationNode | undefined
  private rendered = ''

  constructor() {
    super()
    this.render()
    this._register({ dispose: () => this.node && this.registry.deregisterConfigurations([this.node]) })
  }

  setPlugins(plugins: readonly PluginDescriptor[]) {
    this.plugins = plugins
    this.render()
  }

  /** Replaces what one realm reported: a map from plugin id to its schema, `null` for no `Config`. */
  report(realm: Realm, schemas: Readonly<Record<string, JsonSchema | null>>) {
    const changed = new Set<string>()
    for (const [id, realms] of this.schemas) {
      if (!(id in schemas) && realm in realms) {
        delete realms[realm]
        changed.add(id)
      }
      if (!Object.keys(realms).length) this.schemas.delete(id)
    }
    for (const [id, schema] of Object.entries(schemas)) {
      const realms = this.schemas.get(id) ?? {}
      if (realm in realms && (realms[realm] === schema || JSON.stringify(realms[realm]) === JSON.stringify(schema)))
        continue
      realms[realm] = schema
      this.schemas.set(id, realms)
      changed.add(id)
    }
    if (this.plugins.some(plugin => changed.has(plugin.id))) this.render()
  }

  private render() {
    const properties: Record<string, IJSONSchema> = {}
    for (const plugin of this.plugins) {
      const title = plugin.displayName ?? plugin.id
      properties[plugin.id] = {
        // Standard JSON Schema output (draft-07), which VS Code's settings schema understands.
        ...(mergeRealmSchemas(this.schemas.get(plugin.id) ?? {}) as IJSONSchema),
        markdownDescription: plugin.description ? `**${title}**: ${plugin.description}` : `**${title}**`,
      }
    }
    const node: IConfigurationNode = {
      id: 'vscursed',
      title: 'VSCursed',
      type: 'object',
      properties: {
        [pluginsSetting]: {
          type: 'object',
          default: {},
          markdownDescription:
            'Configuration of the Cordis plugins carried by enabled extensions, keyed by extension id. ' +
            "Each entry is validated by the plugin's `Config`.",
          properties,
        },
      },
    }
    const rendered = JSON.stringify(node)
    if (rendered === this.rendered) return
    this.registry.updateConfigurations({ add: [node], remove: this.node ? [this.node] : [] })
    this.node = node
    this.rendered = rendered
  }
}
