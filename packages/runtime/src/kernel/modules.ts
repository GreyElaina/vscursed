import { Loader } from '@cordisjs/plugin-loader'
import type { PluginDescriptor, Realm } from '@vscursed/api'
import { configJsonSchema, type JsonSchema } from './schema.ts'

export interface ModuleHost {
  /** Maps an absolute file path to the URL that this realm's `import()` accepts. */
  toUrl(path: string): string
  import(url: string): Promise<unknown>
}

interface ModuleRecord {
  path: string
  revision: number
  schema?: JsonSchema | null
}

export type SchemaListener = (id: string, schema: JsonSchema | null) => void

function joinPath(root: string, relative: string) {
  return `${root.replace(/[\\/]+$/, '')}/${relative.replace(/^\.\//, '')}`
}

/**
 * Where plugin code comes from in one realm. Each plugin has one module file; replacing the code bumps
 * its revision, and the revision becomes part of the URL so that the ES module cache yields a fresh
 * instance. The Loader imports through here, and the Config found in each import becomes the plugin's
 * settings schema.
 */
export class PluginModules {
  private readonly records = new Map<string, ModuleRecord>()
  private readonly schemaListeners = new Set<SchemaListener>()

  constructor(
    private readonly realm: Realm,
    private readonly host: ModuleHost,
  ) {}

  /** Takes the current plugin set and returns the ids whose module file moved, such as after an update. */
  update(descriptors: readonly PluginDescriptor[]): string[] {
    const moved: string[] = []
    const seen = new Set<string>()
    for (const descriptor of descriptors) {
      const entry = descriptor.manifest[this.realm]
      if (!entry) continue
      seen.add(descriptor.id)
      const path = joinPath(descriptor.location, entry)
      const record = this.records.get(descriptor.id)
      if (!record) {
        this.records.set(descriptor.id, { path, revision: 0 })
      } else if (record.path !== path) {
        record.path = path
        record.revision++
        moved.push(descriptor.id)
      }
    }
    for (const id of this.records.keys()) {
      if (seen.has(id)) continue
      const schema = this.records.get(id)!.schema
      this.records.delete(id)
      if (schema !== undefined) this.emitSchema(id, null)
    }
    return moved
  }

  path(id: string) {
    return this.records.get(id)?.path
  }

  /** Marks the plugin's code as replaced; the next import evaluates the file again. */
  invalidate(id: string) {
    const record = this.records.get(id)
    if (record) record.revision++
  }

  async import(id: string): Promise<unknown> {
    const record = this.records.get(id)
    if (!record) throw new Error(`no ${this.realm} module is known for plugin ${id}`)
    const url = this.host.toUrl(record.path)
    const exports = await this.host.import(record.revision ? `${url}?revision=${record.revision}` : url)
    this.setSchema(id, configJsonSchema(Loader.prototype.unwrapExports(exports)?.Config) ?? null)
    return exports
  }

  schemas(): Record<string, JsonSchema | null> {
    const result: Record<string, JsonSchema | null> = {}
    for (const [id, record] of this.records) {
      if (record.schema !== undefined) result[id] = record.schema
    }
    return result
  }

  onDidChangeSchema(listener: SchemaListener) {
    this.schemaListeners.add(listener)
    return { dispose: () => void this.schemaListeners.delete(listener) }
  }

  private setSchema(id: string, schema: JsonSchema | null) {
    const record = this.records.get(id)
    const previous = record?.schema
    if (record) record.schema = schema
    if (JSON.stringify(previous ?? null) === JSON.stringify(schema)) return
    this.emitSchema(id, schema)
  }

  private emitSchema(id: string, schema: JsonSchema | null) {
    for (const listener of this.schemaListeners) listener(id, schema)
  }
}
