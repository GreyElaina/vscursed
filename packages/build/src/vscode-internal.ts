import { sharedModulesKey } from '@vscursed/api'
import type { Plugin } from 'rolldown'
import { readModuleValues, sourceFile } from './vscode-source.ts'

const prefix = 'vscode-internal/'
const virtualPrefix = '\0vscode-internal:'

function specifierOf(id: string) {
  if (!id.startsWith(prefix)) return
  const specifier = id.slice(prefix.length)
  if (!specifier.startsWith('vs/') || specifier.split('/').includes('..'))
    throw new Error(`invalid VS Code module ${id}`)
  return specifier.endsWith('.js') ? specifier : `${specifier}.js`
}

/**
 * For code that VSCodium itself loads (the realm runtime): `vscode-internal/vs/...` becomes a relative
 * import of the real module, so the runtime shares VS Code's module instances and VS Code's own
 * bundler resolves them in production builds. `base` is the output directory relative to `src/vs`.
 */
export function vscodeInternalModules(base: string): Plugin {
  const up = base
    .split('/')
    .filter(Boolean)
    .map(() => '..')
    .join('/')
  return {
    name: 'vscursed:vscode-internal-modules',
    resolveId(id) {
      const specifier = specifierOf(id)
      return specifier ? { id: `${up}/${specifier.slice('vs/'.length)}`, external: true } : null
    },
  }
}

/**
 * For plugin bundles, which live outside VSCodium: a `vscode-internal/vs/...` import provides only
 * what can cross that boundary without copying VS Code code. Service identifiers resolve to the
 * identifiers registered in the realm, so `ctx.vscode.get()` returns the running service; enums are
 * copied as values. Any other value import fails the build with a missing-export error; types remain
 * available from the VS Code sources.
 */
export function vscodeInternalBoundary(): Plugin {
  return {
    name: 'vscursed:vscode-internal-boundary',
    resolveId(id) {
      const specifier = specifierOf(id)
      return specifier ? virtualPrefix + specifier : null
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return null
      const file = sourceFile(id.slice(virtualPrefix.length))
      this.addWatchFile(file)
      const { services, enums } = readModuleValues(file)
      // Pure calls: identifiers the plugin does not import are neither kept nor looked up.
      const lines = [`const registry = globalThis[Symbol.for(${JSON.stringify(sharedModulesKey.description)})].vscode`]
      for (const [name, serviceId] of services)
        lines.push(`export const ${name} = /* @__PURE__ */ registry.service(${JSON.stringify(serviceId)})`)
      for (const [name, members] of enums)
        lines.push(`export const ${name} = /* @__PURE__ */ Object.freeze(${JSON.stringify(members)})`)
      return { code: lines.join('\n'), moduleSideEffects: false }
    },
  }
}
