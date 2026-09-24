import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const workspaceRoot = resolve(import.meta.dirname, '../..')
export const vscodiumRoot = join(workspaceRoot, 'upstream/vscodium')
export const vscodeRoot = join(vscodiumRoot, 'vscode')
export const patchesRoot = join(workspaceRoot, 'upstream/patches')

/** Tag on the VSCodium-prepared tree; VSCursed patches are working-tree changes on top of it. */
export const baseTag = 'vscursed/base'

export interface RunOptions extends SpawnOptions {
  /** Resolve with stdout instead of inheriting it. */
  capture?: boolean
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const { capture, ...spawnOptions } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      ...spawnOptions,
    })
    let stdout = ''
    child.stdout?.setEncoding('utf8').on('data', chunk => (stdout += chunk))
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

export function git(args: string[], options: RunOptions = {}) {
  return run('git', args, { cwd: vscodeRoot, ...options })
}

/** Environment of VSCodium's `dev/build.sh`, which its preparation scripts expect. */
export function vscodiumEnv(): NodeJS.ProcessEnv {
  const arches: Record<string, string> = {
    arm64: 'arm64',
    x64: 'x64',
    ppc64: 'ppc64le',
    riscv64: 'riscv64',
    loong64: 'loong64',
    s390x: 's390x',
  }
  const osNames: Record<string, string> = { darwin: 'osx', win32: 'windows' }
  return {
    ...process.env,
    APP_NAME: 'VSCodium',
    ASSETS_REPOSITORY: 'VSCodium/vscodium',
    BINARY_NAME: 'codium',
    CI_BUILD: 'no',
    GH_REPO_PATH: 'VSCodium/vscodium',
    ORG_NAME: 'VSCodium',
    SHOULD_BUILD: 'yes',
    SKIP_ASSETS: 'yes',
    VSCODE_LATEST: 'no',
    VSCODE_QUALITY: 'stable',
    VSCODE_SKIP_NODE_VERSION_CHECK: 'yes',
    OS_NAME: osNames[platform()] ?? 'linux',
    VSCODE_ARCH: arches[arch()] ?? 'x64',
  }
}

export async function listPatches() {
  if (!existsSync(patchesRoot)) return []
  return (await readdir(patchesRoot))
    .filter(name => name.endsWith('.patch'))
    .sort()
    .map(name => join(patchesRoot, name))
}

/** Paths touched by a patch file, as recorded in its `diff --git` headers. */
export async function patchedPaths(file: string) {
  const content = await readFile(file, 'utf8')
  return [...content.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]!)
}

/** Heap limit handed to VS Code's gulp tasks through VSCodium's `MAX_OLD_SPACE_SIZE`. */
const heapMegabytes = process.env.VSCURSED_MAX_OLD_SPACE_SIZE ?? '4096'
/** Memory ceiling of the systemd scope that runs heavy upstream steps, when systemd is available. */
const scopeMemory = process.env.VSCURSED_SCOPE_MEMORY ?? '6G'

export function npm(args: string[], options: RunOptions = {}) {
  return limited('npm', args, { cwd: vscodeRoot, ...options })
}

/** Runs a memory-heavy command inside a memory-limited systemd scope when one can be created. */
export async function limited(
  command: string,
  args: string[],
  { memory = scopeMemory, ...options }: RunOptions & { memory?: string },
) {
  const scoped = process.platform === 'linux' && existsSync('/usr/bin/systemd-run')
  if (!scoped) return run(command, args, options)
  return run(
    'systemd-run',
    ['--user', '--scope', '--quiet', '-p', `MemoryMax=${memory}`, '-p', 'MemorySwapMax=0', command, ...args],
    options,
  )
}

export async function hasBase() {
  if (!existsSync(join(vscodeRoot, '.git'))) return false
  const tags = await git(['tag', '--list', baseTag], { capture: true })
  return tags.trim() === baseTag
}

export async function prepareVSCodium() {
  await run('git', ['submodule', 'update', '--init', 'upstream/vscodium'], { cwd: workspaceRoot })
  if (await hasBase()) return
  // A partial checkout from an interrupted run cannot be resumed by `get_repo.sh`.
  await rm(vscodeRoot, { recursive: true, force: true })
  const env = { ...vscodiumEnv(), MAX_OLD_SPACE_SIZE: heapMegabytes }
  await limited('bash', ['-c', 'set -e; . get_repo.sh; . version.sh; . prepare_vscode.sh'], { cwd: vscodiumRoot, env })
  const identity = ['-c', 'user.name=VSCursed', '-c', 'user.email=vscursed@localhost']
  await git(['add', '-A'])
  await git([...identity, 'commit', '-q', '--no-verify', '-m', 'VSCodium prepared tree'])
  await git(['tag', baseTag])
}

/** Writes the tree object that a temporary index describes after `fill` populated it. */
async function writeTree(fill: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'vscursed-index-'))
  try {
    const index = join(dir, 'index')
    // Starting from the real index keeps its stat cache, so unchanged files are not re-hashed.
    await copyFile(join(vscodeRoot, '.git/index'), index)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    await fill(env)
    return (await git(['write-tree'], { env, capture: true })).trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function worktreeTree() {
  return writeTree(env => git(['add', '-A'], { env }).then(() => {}))
}

async function patchedTree() {
  const patches = await listPatches()
  return writeTree(async env => {
    await git(['read-tree', baseTag], { env })
    for (const patch of patches) await git(['apply', '--cached', '--whitespace=nowarn', patch], { env })
  })
}

/** Resets the tree to the prepared base plus `upstream/patches`; returns whether anything changed. */
export async function applyPatches(force: boolean) {
  if (!(await hasBase())) throw new Error('The VSCodium tree is not prepared; run `pnpm upstream prepare` first.')
  const [current, expected, base] = await Promise.all([
    worktreeTree(),
    patchedTree(),
    git(['rev-parse', `${baseTag}^{tree}`], { capture: true }).then(out => out.trim()),
  ])
  if (current === expected) {
    console.log('upstream: patches are already applied')
    return false
  }
  if (current !== base && !force) {
    throw new Error(
      'The VSCodium tree has changes that differ from upstream/patches. Export them with `pnpm upstream diff`, or discard them with `pnpm upstream apply --force`.',
    )
  }
  await git(['reset', '-q', '--hard', baseTag])
  // Ignored files (dependencies, build output, the VSCursed runtime bundle) survive the clean.
  await git(['clean', '-fdq'])
  for (const patch of await listPatches()) {
    console.log(`upstream: applying ${basename(patch)}`)
    await git(['apply', '--whitespace=nowarn', patch])
  }
  return true
}
