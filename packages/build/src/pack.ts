import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readPluginManifest, type Realm } from '@vscursed/api'
import type { UserConfig } from 'vite-plus/pack'
import { reportBuild } from './hmr.ts'
import { sharedModules } from './shared.ts'
import { vscodeInternalBoundary } from './vscode-internal.ts'

/** The source of a manifest's `./dist/<name>.js` output: `./src/<name>.ts` or `./src/<name>/index.ts`. */
function sourceOf(root: string, output: string) {
  const name = basename(output, '.js')
  for (const candidate of [`src/${name}.ts`, `src/${name}/index.ts`]) {
    if (existsSync(join(root, candidate))) return candidate
  }
  throw new Error(`no source for ${output}: expected src/${name}.ts or src/${name}/index.ts`)
}

/**
 * The `pack` configuration of a plugin extension: one self-contained ES module per realm listed in
 * the `vscursed` field of its `package.json`, linked against the realm's shared modules.
 */
export function pluginPack(root = process.cwd()): UserConfig[] {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (typeof packageJson.publisher !== 'string' || typeof packageJson.name !== 'string') {
    throw new Error('a VSCursed plugin requires string "publisher" and "name" fields')
  }
  const manifest = readPluginManifest(packageJson)
  if (!manifest) throw new Error(`${packageJson.name} has no "vscursed" field`)
  const id = `${packageJson.publisher}.${packageJson.name}`.toLowerCase()
  return (Object.entries(manifest) as [Realm, string][]).map(([realm, output]) => ({
    name: `${packageJson.name} (${realm})`,
    cwd: root,
    entry: { [basename(output, '.js')]: sourceOf(root, output) },
    outDir: dirname(output),
    format: 'esm',
    platform: realm === 'renderer' ? 'browser' : 'node',
    target: 'es2024',
    sourcemap: true,
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    plugins: [sharedModules(), vscodeInternalBoundary()],
    onSuccess: () => reportBuild(id, realm),
    // One file per realm: its URL carries the revision that hot replacement bumps.
    outputOptions: { codeSplitting: false },
  }))
}
