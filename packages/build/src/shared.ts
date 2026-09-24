import { sharedModulesKey, sharedSpecifiers, type SharedSpecifier } from '@vscursed/api'
import type { Plugin } from 'rolldown'

const virtualPrefix = '\0vscursed-shared:'
const identifier = /^[A-Za-z_$][\w$]*$/

/**
 * Links a plugin bundle against the realm's shared modules instead of bundling copies: the realm's
 * Cordis owns fiber and service identity, and `@vscursed/api` carries the realm's service classes.
 * Export names are taken from the same package versions that the runtime bundles.
 */
export function sharedModules(): Plugin {
  return {
    name: 'vscursed:shared-modules',
    resolveId(id) {
      return (sharedSpecifiers as readonly string[]).includes(id) ? virtualPrefix + id : null
    },
    async load(id) {
      if (!id.startsWith(virtualPrefix)) return null
      const specifier = id.slice(virtualPrefix.length) as SharedSpecifier
      const names = Object.keys(await import(specifier))
      const lines = [
        `const shared = globalThis[Symbol.for(${JSON.stringify(sharedModulesKey.description)})].modules[${JSON.stringify(specifier)}]`,
      ]
      for (const name of names) {
        if (name === 'default') lines.push('export default shared.default')
        else if (identifier.test(name)) lines.push(`export const ${name} = shared.${name}`)
      }
      return { code: lines.join('\n'), moduleSideEffects: false }
    },
  }
}
