import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import { IExtHostExtensionService } from 'vscode-internal/vs/workbench/api/common/extHostExtensionService.js'

export { Config } from './shared.ts'

export const name = 'sample-realms'
export const inject = ['bridge', 'vscode']

export function apply(ctx: Context) {
  const extensions = ctx.vscode.get(IExtHostExtensionService)
  ctx.bridge.provide('sample.extensionHost', {
    async describe() {
      const registry = await extensions.getExtensionRegistry()
      const count = registry.getAllExtensionDescriptions().length
      return { realm: 'extensionHost', pid: process.pid, detail: `Node ${process.versions.node}, ${count} extensions` }
    },
  })
}
