import { readPluginManifest, type PluginDescriptor } from '@vscursed/api'
import { Schemas } from 'vscode-internal/vs/base/common/network.js'
import {
  ExtensionIdentifier,
  type IExtensionDescription,
} from 'vscode-internal/vs/platform/extensions/common/extensions.js'

/**
 * The Cordis plugin that an extension carries, or `undefined` for an ordinary extension. Only local
 * extensions are considered: every realm loads plugin modules from the local file system.
 */
export function describePlugin(extension: IExtensionDescription): PluginDescriptor | undefined {
  if (extension.extensionLocation.scheme !== Schemas.file) return
  const manifest = readPluginManifest(extension as { vscursed?: unknown })
  if (!manifest) return
  return {
    id: ExtensionIdentifier.toKey(extension.identifier),
    location: extension.extensionLocation.fsPath,
    manifest,
    development: extension.isUnderDevelopment,
    displayName: extension.displayName,
    description: extension.description,
  }
}

/** Descriptors of the given extensions; a malformed `vscursed` field is reported and skips its extension. */
export function describePlugins(extensions: readonly IExtensionDescription[], warn: (message: string) => void) {
  const plugins: PluginDescriptor[] = []
  for (const extension of extensions) {
    try {
      const plugin = describePlugin(extension)
      if (plugin) plugins.push(plugin)
    } catch (error) {
      warn(`${extension.identifier.value}: ${(error as Error).message}`)
    }
  }
  return plugins
}
