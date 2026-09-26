/**
 * Maintains the stable VSCodium working directory at `upstream/vscodium/vscode`.
 *
 *   prepare         one-time: VSCodium source + dependencies, VSCursed patches, client, built-in extensions, Electron
 *   apply [--force] reset the tree to the prepared base and re-apply `upstream/patches`, then transpile
 *   diff [--new NN-name]  export working-tree changes back into `upstream/patches`
 *   watch           VS Code's own incremental client transpiler, for editing patched sources
 *   check           type-check the patched sources with VS Code's compiler and options
 *   package         VSCodium's production packaging of the patched tree
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  applyPatches,
  baseTag,
  git,
  limited,
  listPatches,
  npm,
  patchedPaths,
  patchesRoot,
  prepareVSCodium,
  vscodeRoot,
  vscodiumEnv,
  workspaceRoot,
} from './lib/upstream.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { force: { type: 'boolean', default: false }, new: { type: 'string' } },
})

async function diff(newPatch: string | undefined) {
  const workRoot = join(workspaceRoot, '.vscursed')
  await mkdir(workRoot, { recursive: true })
  const dir = await mkdtemp(join(workRoot, 'index-'))
  try {
    const index = join(dir, 'index')
    await copyFile(join(vscodeRoot, '.git/index'), index)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    await git(['add', '-A'], { env })
    const changed = (await git(['diff', '--cached', '--name-only', baseTag], { env, capture: true }))
      .split('\n')
      .filter(Boolean)
    const owners = new Map<string, string>()
    for (const patch of await listPatches()) {
      for (const path of await patchedPaths(patch)) owners.set(path, patch)
    }
    const unowned = changed.filter(path => !owners.has(path))
    if (unowned.length && !newPatch) {
      throw new Error(
        `These changed paths belong to no patch; pass --new NN-name to collect them:\n  ${unowned.join('\n  ')}`,
      )
    }
    const groups = new Map<string, string[]>()
    for (const path of changed) {
      const patch = owners.get(path) ?? join(patchesRoot, `${newPatch}.patch`)
      groups.set(patch, [...(groups.get(patch) ?? []), path])
    }
    for (const patch of new Set([...owners.values(), ...groups.keys()])) {
      const paths = groups.get(patch)
      if (!paths) {
        await rm(patch)
        console.log(`upstream: removed ${basename(patch)} (no remaining changes)`)
        continue
      }
      const content = await git(['diff', '--cached', '--binary', '--no-color', baseTag, '--', ...paths], {
        env,
        capture: true,
      })
      await writeFile(patch, content)
      console.log(`upstream: wrote ${basename(patch)} (${paths.length} files)`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** VS Code's own development steps; each one is a no-op or incremental when already done. */
async function buildDevelopmentTree() {
  // The icon font is copied from node_modules into src/ first, so that the transpiler copies it on to out/.
  await npm(['run', 'gulp', '--', 'copy-codicons'])
  await npm(['run', 'transpile-client'])
  await npm(['run', 'gulp', '--', 'compile-extensions', 'compile-extension-media'])
  // Downloads Electron and the marketplace built-in extensions; `out/` already exists, so it compiles nothing.
  await limited('node', ['build/lib/preLaunch.ts'], { cwd: vscodeRoot })
}

/**
 * Type-checks the TypeScript files that the patches touch, under VS Code's own `src/tsconfig.json`.
 * The program reaches only what those files import; a whole-tree check does not fit in memory here.
 * Composition entry points (`*.main.ts`) import the entire workbench and are left out: their patches
 * import a runtime bundle, whose declaration file is checked instead.
 */
async function check() {
  const src = join(vscodeRoot, 'src')
  const files = new Set<string>()
  for (const patch of await listPatches()) {
    for (const path of await patchedPaths(patch)) {
      if (path.endsWith('.ts') && !path.endsWith('.main.ts')) files.add(join(vscodeRoot, path))
    }
  }
  files.add(join(vscodeRoot, 'node_modules/@webgpu/types/dist/index.d.ts'))
  const workRoot = join(workspaceRoot, '.vscursed')
  await mkdir(workRoot, { recursive: true })
  const dir = await mkdtemp(join(workRoot, 'check-'))
  try {
    const config = join(dir, 'tsconfig.json')
    await writeFile(
      config,
      JSON.stringify({
        extends: join(src, 'tsconfig.json'),
        compilerOptions: {
          noEmit: true,
          rootDir: src,
          typeRoots: [join(vscodeRoot, 'node_modules/@types')],
          types: ['semver', 'trusted-types', 'wicg-file-system-access', 'winreg'],
        },
        include: [
          join(src, 'typings'),
          join(src, 'vscode-dts'),
          join(src, 'vs/workbench/contrib/debug/common/debugProtocol.d.ts'),
        ],
        files: [...files],
      }),
    )
    await limited(
      'node',
      [
        `--max-old-space-size=${process.env.VSCURSED_MAX_OLD_SPACE_SIZE ?? '4096'}`,
        'node_modules/typescript/bin/tsc6',
        '-p',
        config,
      ],
      { cwd: vscodeRoot },
    )
    console.log(`upstream: ${files.size - 1} patched files type-check`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

switch (positionals[0]) {
  case 'prepare':
    await prepareVSCodium()
    await applyPatches(values.force)
    await buildDevelopmentTree()
    break
  case 'apply':
    if (await applyPatches(values.force)) await npm(['run', 'transpile-client'])
    break
  case 'diff':
    await diff(values.new)
    break
  case 'check':
    await check()
    break
  case 'watch':
    await npm(['run', 'watch-client-transpile'])
    break
  case 'package': {
    const env = { ...vscodiumEnv(), VSCODE_PUBLISH_COUNTER: '1' }
    const target = `vscode-${env.OS_NAME === 'osx' ? 'darwin' : env.OS_NAME === 'windows' ? 'win32' : 'linux'}-${env.VSCODE_ARCH}-min-packing`
    const gulp = (task: string) =>
      limited(
        'node',
        [
          '--experimental-strip-types',
          `--max-old-space-size=${process.env.VSCURSED_MAX_OLD_SPACE_SIZE ?? '8192'}`,
          'node_modules/gulp/bin/gulp.js',
          task,
        ],
        { cwd: vscodeRoot, env },
      )
    await gulp('vscode-min-prepack')
    await gulp(target)
    break
  }
  default:
    console.error('usage: pnpm upstream <prepare|apply [--force]|diff [--new NN-name]|check|watch|package>')
    process.exitCode = 1
}
