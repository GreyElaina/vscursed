import { isRealm, realms, type Realm } from './realm.ts'

/**
 * The `vscursed` field of an extension's `package.json`: one ES module per realm, relative to the
 * extension root. Each module's default export (or the module itself) is a Cordis plugin.
 */
export type PluginManifest = Partial<Record<Realm, string>>

/** An enabled extension that carries a Cordis plugin, as seen by one realm. */
export interface PluginDescriptor {
  /** Extension identifier in lower case, also the Loader entry id and the `vscursed.plugins` key. */
  id: string
  /** Absolute file-system path of the extension root. */
  location: string
  manifest: PluginManifest
  /** Loaded through `--extensionDevelopmentPath`: its modules are watched for hot replacement. */
  development: boolean
  displayName?: string
  description?: string
}

export class ManifestError extends Error {
  override name = 'ManifestError'
}

/**
 * Reads the `vscursed` field of an extension manifest. Returns `undefined` for an extension without
 * Cordis plugins and throws a {@link ManifestError} for a malformed field.
 */
export function readPluginManifest(packageJson: { vscursed?: unknown }): PluginManifest | undefined {
  const field = packageJson.vscursed
  if (field === undefined) return
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw new ManifestError('"vscursed" must be an object mapping realms to module paths')
  }
  const manifest: PluginManifest = {}
  for (const [key, value] of Object.entries(field)) {
    if (!isRealm(key)) throw new ManifestError(`"vscursed.${key}" is not a realm; expected one of ${realms.join(', ')}`)
    if (
      typeof value !== 'string' ||
      !value.endsWith('.js') ||
      value.startsWith('/') ||
      value.split(/[\\/]/).includes('..')
    ) {
      throw new ManifestError(`"vscursed.${key}" must be a relative path to a .js module inside the extension`)
    }
    manifest[key] = value
  }
  if (!Object.keys(manifest).length) throw new ManifestError('"vscursed" declares no realm module')
  return manifest
}
