import type { StandardJSONSchemaV1 } from '@standard-schema/spec'
import type { Realm } from '@vscursed/api'

export type JsonSchema = Record<string, unknown>

/**
 * Converts a plugin's exported `Config` into the JSON Schema of its accepted input, through the Standard
 * JSON Schema interface that the schema library implements. Returns `undefined` when the plugin has no
 * `Config` or its library does not implement the interface.
 */
export function configJsonSchema(config: unknown): JsonSchema | undefined {
  const converter = (config as Partial<StandardJSONSchemaV1> | undefined)?.['~standard']?.jsonSchema
  if (!converter) return
  const { $schema: _, ...schema } = converter.input({ target: 'draft-07' })
  return schema
}

/** The schemas one plugin reported from each realm it has a module in. */
export type RealmSchemas = Partial<Record<Realm, JsonSchema | null>>

function isObjectSchema(schema: JsonSchema) {
  return schema.type === 'object' && !('anyOf' in schema) && !('oneOf' in schema) && !('allOf' in schema)
}

/**
 * One `vscursed.plugins` entry configures every realm of a plugin, and each realm's `Config` reads the
 * keys it needs. Object schemas are therefore merged key by key; anything else must satisfy all realms.
 */
export function mergeRealmSchemas(schemas: RealmSchemas): JsonSchema {
  const known = Object.values(schemas).filter((schema): schema is JsonSchema => !!schema)
  if (known.length === 0) return { type: 'object' }
  if (known.length === 1) return known[0]!
  if (!known.every(isObjectSchema)) return { allOf: known }
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const schema of known) {
    for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) {
      properties[key] = key in properties ? { allOf: [properties[key], value] } : value
    }
    for (const key of (schema.required ?? []) as string[]) required.add(key)
  }
  return { type: 'object', properties, ...(required.size ? { required: [...required] } : {}) }
}
