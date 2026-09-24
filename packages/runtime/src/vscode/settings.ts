import type { IConfigurationService } from 'vscode-internal/vs/platform/configuration/common/configuration.js'
import type { SettingsSource } from '../kernel/host.ts'

/** The setting whose entries configure plugins, keyed by extension id. */
export const pluginsSetting = 'vscursed.plugins'

export function asSettings(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function configurationSettings(configurationService: IConfigurationService): SettingsSource {
  let current = asSettings(configurationService.getValue(pluginsSetting))
  let serialized = JSON.stringify(current)
  return {
    current: () => current,
    onDidChange: listener =>
      configurationService.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration(pluginsSetting)) return
        const next = asSettings(configurationService.getValue(pluginsSetting))
        const nextSerialized = JSON.stringify(next)
        if (nextSerialized === serialized) return
        current = next
        serialized = nextSerialized
        listener()
      }),
  }
}
