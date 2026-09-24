import { parsePluginManifest, type Realm } from '@vscursed/api'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { MarkdownString } from 'vscode-internal/vs/base/common/htmlContent.js'
import { DisposableStore } from 'vscode-internal/vs/base/common/lifecycle.js'
import { Codicon } from 'vscode-internal/vs/base/common/codicons.js'
import type { IExtensionManifest } from 'vscode-internal/vs/platform/extensions/common/extensions.js'
import { SyncDescriptor } from 'vscode-internal/vs/platform/instantiation/common/descriptors.js'
import { Registry } from 'vscode-internal/vs/platform/registry/common/platform.js'
import {
  Extensions,
  type IExtensionFeatureMarkdownAndTableRenderer,
  type IExtensionFeaturesRegistry,
  type IRenderedData,
  type ITableData,
} from 'vscode-internal/vs/workbench/services/extensionManagement/common/extensionFeatures.js'
import type { ProviderStatus } from '../development.ts'

/** What this window knows about an extension's development session. */
export type DevelopmentState =
  | { role: 'debugger' }
  | { role: 'target'; status: ProviderStatus; reloadErrors: Partial<Record<Realm, string>> }

const states = new Map<string, DevelopmentState>()
const changes = new Emitter<string>()

function extensionId(manifest: IExtensionManifest) {
  return `${manifest.publisher}.${manifest.name}`.toLowerCase()
}

function renderData(manifest: IExtensionManifest): Array<MarkdownString | ITableData> {
  const result = parsePluginManifest(manifest)
  if (!result.success || !result.data) return []
  const state = states.get(extensionId(manifest))
  const message = new MarkdownString()
  if (state?.role === 'debugger') {
    message.appendText('VSCursed capability is enabled in a running Development Host.')
  } else if (!state) {
    message.appendText('VSCursed capability is enabled. No Vite+ provider is connected.')
  } else {
    const { connection, error } = state.status
    message.appendText(`VSCursed capability is enabled. Vite+ provider is ${connection}${error ? `: ${error}` : '.'}`)
  }
  const rows = (Object.entries(result.data) as [Realm, string][]).map(([realm, module]) => {
    const build =
      state?.role === 'target'
        ? (state.reloadErrors[realm] ?? (state.status.built.includes(realm) ? 'Built' : '—'))
        : '—'
    return [realm, module, build]
  })
  return [message, { headers: ['Realm', 'Module', 'Development build'], rows }]
}

class VSCursedFeatureRenderer implements IExtensionFeatureMarkdownAndTableRenderer {
  readonly type = 'markdown+table' as const

  shouldRender(manifest: IExtensionManifest) {
    const result = parsePluginManifest(manifest)
    return result.success && result.data !== undefined
  }

  render(manifest: IExtensionManifest): IRenderedData<Array<MarkdownString | ITableData>> {
    const id = extensionId(manifest)
    const disposables = new DisposableStore()
    const update = disposables.add(new Emitter<Array<MarkdownString | ITableData>>())
    disposables.add(changes.event(changed => changed === id && update.fire(renderData(manifest))))
    return {
      data: renderData(manifest),
      onDidChange: update.event,
      dispose: () => disposables.dispose(),
    }
  }

  dispose() {}
}

Registry.as<IExtensionFeaturesRegistry>(Extensions.ExtensionFeaturesRegistry).registerExtensionFeature({
  id: 'vscursed',
  label: 'VSCursed',
  description: 'Cordis plugins loaded into VSCursed runtime realms.',
  icon: Codicon.debugAlt,
  access: { canToggle: false },
  renderer: new SyncDescriptor(VSCursedFeatureRenderer),
})

/** Replaces the development state shown on an extension's VSCursed feature page. */
export function setDevelopmentState(id: string, state: DevelopmentState | undefined) {
  if (state) states.set(id, state)
  else states.delete(id)
  changes.fire(id)
}
