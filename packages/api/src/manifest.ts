import { z } from 'zod/mini'
import { realms, type Realm } from './realm.ts'

const modulePath = z
  .string()
  .check(
    z.refine(
      value => value.endsWith('.js') && !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
      'must be a relative path to a .js module inside the extension',
    ),
  )

/**
 * The `vscursed` field of an extension's `package.json`: one ES module per realm, relative to the
 * extension root. Each module's default export (or the module itself) is a Cordis plugin.
 */
export const PluginManifest = z
  .partialRecord(z.enum(realms), modulePath)
  .check(z.refine(manifest => Object.keys(manifest).length > 0, 'must declare at least one realm module'))

export type PluginManifest = z.infer<typeof PluginManifest>

/** Socket inherited by Vite+ watch processes for reporting successful plugin builds. */
export const hmrSocketEnv = 'VSCURSED_HMR_SOCKET'

/** A realm bundle that Vite+ has successfully rebuilt. */
export interface PluginBuild {
  id: string
  realm: Realm
}

/** An enabled extension that carries a Cordis plugin, as seen by one realm. */
export interface PluginDescriptor {
  /** Extension identifier in lower case, also the Loader entry id and the `vscursed.plugins` key. */
  id: string
  /** Absolute file-system path of the extension root. */
  location: string
  manifest: PluginManifest
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
  const result = PluginManifest.safeParse(field)
  if (!result.success) throw new ManifestError(z.prettifyError(result.error))
  return result.data
}
