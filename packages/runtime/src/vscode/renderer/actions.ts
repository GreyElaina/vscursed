import { realms } from '@vscursed/api'
import { localize2 } from 'vscode-internal/vs/nls.js'
import { Action2, MenuId, registerAction2 } from 'vscode-internal/vs/platform/actions/common/actions.js'
import { ContextKeyExpr } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import type { ServicesAccessor } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { IQuickInputService, type IQuickPickItem } from 'vscode-internal/vs/platform/quickinput/common/quickInput.js'
import { IVSCursedService, vscursedCategory, vscursedExtensionsContext, vscursedRealmContexts } from './service.ts'

/**
 * The VSCursed group of an extension's context menu in the Extensions view. The view passes the
 * extension id only to top-level items; items of a submenu run without it.
 */
const extensionMenuGroup = '9_vscursed'
const isVSCursedExtension = ContextKeyExpr.in('extension', vscursedExtensionsContext.key)

/** Extension identifier of a command argument; the Extensions view passes the id as a string. */
function extensionIdOf(value: unknown) {
  return typeof value === 'string' ? value.toLowerCase() : undefined
}

interface PluginPick extends IQuickPickItem {
  id: string
}

registerAction2(
  class ReloadPlugin extends Action2 {
    constructor() {
      super({
        id: 'vscursed.reloadPlugin',
        title: localize2('vscursed.reloadPlugin', 'Reload Plugin'),
        category: vscursedCategory,
        f1: true,
        menu: { id: MenuId.ExtensionContext, when: isVSCursedExtension, group: extensionMenuGroup, order: 0 },
      })
    }

    async run(accessor: ServicesAccessor, requested?: unknown) {
      const vscursed = accessor.get(IVSCursedService)
      const quickInputService = accessor.get(IQuickInputService)
      let id = extensionIdOf(requested)
      if (!id) {
        const picks = vscursed.plugins.map(plugin => ({
          id: plugin.id,
          label: plugin.displayName ?? plugin.id,
          description: plugin.id,
        }))
        id = (await quickInputService.pick<PluginPick>(picks, { placeHolder: 'Select a VSCursed plugin to reload' }))
          ?.id
      }
      if (id) await vscursed.reloadManifest(id)
    }
  },
)

for (const realm of realms) {
  registerAction2(
    class ReloadRealm extends Action2 {
      constructor() {
        super({
          id: `vscursed.reloadRealm.${realm}`,
          title: `Reload Plugin in ${realm}`,
          menu: {
            id: MenuId.ExtensionContext,
            when: ContextKeyExpr.in('extension', vscursedRealmContexts[realm].key),
            group: extensionMenuGroup,
            order: 1,
          },
        })
      }

      async run(accessor: ServicesAccessor, requested?: unknown) {
        const id = extensionIdOf(requested)
        if (!id) throw new Error('Reload Realm requires an extension identifier')
        await accessor.get(IVSCursedService).reloadRealm(id, realm)
      }
    },
  )
}
