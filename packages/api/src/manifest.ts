import { z } from 'zod/mini'
import { realms } from './realm.ts'

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

export type PluginManifestResult =
  | { success: true; data: PluginManifest | undefined }
  | { success: false; error: ManifestError }

/** Validates the `vscursed` field without throwing, for status-reporting boundaries. */
export function parsePluginManifest(packageJson: object): PluginManifestResult {
  const field = 'vscursed' in packageJson ? packageJson.vscursed : undefined
  if (field === undefined) return { success: true, data: undefined }
  const result = PluginManifest.safeParse(field)
  if (!result.success) return { success: false, error: new ManifestError(z.prettifyError(result.error)) }
  return { success: true, data: result.data }
}

/**
 * Reads the `vscursed` field of an extension manifest. Returns `undefined` for an extension without
 * Cordis plugins and throws a {@link ManifestError} for a malformed field.
 */
export function readPluginManifest(packageJson: object): PluginManifest | undefined {
  const result = parsePluginManifest(packageJson)
  if (!result.success) throw result.error
  return result.data
}
