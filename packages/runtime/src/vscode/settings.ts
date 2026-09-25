import type { IConfigurationService } from 'vscode-internal/vs/platform/configuration/common/configuration.js'
import type { SettingsSource } from '../kernel/host.ts'

/** The setting whose entries configure plugins, keyed by extension id. */
export const pluginsSetting = 'vscursed.plugins'

export function asSettings(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** VS Code filters changes by key; the Loader restarts only entries whose config differs. */
export function configurationSettings(configurationService: IConfigurationService): SettingsSource {
  return {
    current: () => asSettings(configurationService.getValue(pluginsSetting)),
    onDidChange: listener =>
      configurationService.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(pluginsSetting)) listener()
      }),
  }
}
