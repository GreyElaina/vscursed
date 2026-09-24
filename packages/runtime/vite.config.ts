import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { vscodeInternalModules, vscodeSource } from '@vscursed/build'
import { defineConfig } from 'vite-plus'
import type { UserConfig } from 'vite-plus/pack'

/** Where the bundles live, relative to `src/vs` of the VSCodium tree. */
const base = 'vscursed/runtime'
const outDir = join(vscodeSource, 'vs', base)
/** The development build of VSCodium runs from `out/`, which its transpiler fills from `src/`. */
const developmentDir = join(vscodeSource, '../out/vs', base)

const realms = {
  renderer: 'src/realms/renderer.ts',
  main: 'src/realms/main.ts',
  sharedProcess: 'src/realms/shared-process.ts',
  extensionHost: 'src/realms/extension-host.ts',
}

const nodeShim = join(import.meta.dirname, 'src/shims/node.ts')

function bundle(realm: keyof typeof realms, entry: string): UserConfig {
  const renderer = realm === 'renderer'
  return {
    name: realm,
    entry: { [realm]: entry },
    outDir,
    format: 'esm',
    platform: renderer ? 'browser' : 'node',
    target: 'es2024',
    sourcemap: true,
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    plugins: [vscodeInternalModules(base)],
    ...(renderer && {
      alias: Object.fromEntries(
        ['node:module', 'node:fs', 'node:fs/promises', 'node:path', 'node:url'].map(id => [id, nodeShim]),
      ),
      // The Loader reads these at construction; the sandboxed renderer has no `process`.
      define: { 'process.env.CORDIS_SHARED': 'undefined', 'process.versions.node': '"0.0.0"' },
    }),
    outputOptions: { codeSplitting: false },
    async onSuccess() {
      for (const file of [`${realm}.js`, `${realm}.js.map`]) await cp(join(outDir, file), join(developmentDir, file))
    },
  }
}

export default defineConfig({
  pack: Object.entries(realms).map(([realm, entry]) => bundle(realm as keyof typeof realms, entry)),
})
