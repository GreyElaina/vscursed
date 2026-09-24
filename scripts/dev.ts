/**
 * Daily development: builds the realm runtime and every plugin, keeps rebuilding them on change, and
 * launches the prepared VSCodium with the plugins as development extensions and a profile under
 * `.vscursed/`. A rebuilt plugin is hot-replaced in every realm; a rebuilt runtime takes effect after
 * reloading the window (renderer) or restarting (other realms).
 *
 *   pnpm dev [-- <VSCodium arguments>]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readPluginManifest } from '@vscursed/api'
import { applyPatches, limited, npm, vscodeRoot, workspaceRoot } from './lib/upstream.ts'

const profile = join(workspaceRoot, '.vscursed')
/** Memory ceiling of the VSCodium process tree. */
const electronMemory = process.env.VSCURSED_ELECTRON_MEMORY ?? '4G'

if (!existsSync(join(vscodeRoot, 'out/main.js'))) {
  console.error('vscursed: the VSCodium tree is not prepared; run `pnpm upstream prepare` once.')
  process.exit(1)
}
if (await applyPatches(false)) await npm(['run', 'transpile-client'])

const pluginsRoot = join(workspaceRoot, 'plugins')
const plugins = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && existsSync(join(pluginsRoot, entry.name, 'package.json')))
  .map(entry => join(pluginsRoot, entry.name))

/** Starts `vp pack --watch` and resolves once each of its `configs` builds has completed once. */
function watch(dir: string, configs: number) {
  const label = relative(workspaceRoot, dir)
  // Its own process group, so that stopping it also stops what `vp` starts.
  const child = spawn(join(workspaceRoot, 'node_modules/.bin/vp'), ['pack', '--watch'], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let completed = 0
  const ready = new Promise<void>((resolve, reject) => {
    child.once('exit', code => reject(new Error(`${label}: vp pack exited with code ${code}`)))
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          console.log(`[${label}] ${line}`)
          if (/Build complete|Rebuilt in/.test(line) && ++completed === configs) resolve()
        }
      })
    }
  })
  return { child, ready }
}

const watchers = [
  watch(join(workspaceRoot, 'packages/runtime'), 4),
  ...plugins.map(dir => {
    const manifest = readPluginManifest(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
    return watch(dir, Object.keys(manifest ?? {}).length)
  }),
]
const stop = () => {
  for (const { child } of watchers) {
    if (child.exitCode === null && child.pid) process.kill(-child.pid)
  }
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
await Promise.all(watchers.map(({ ready }) => ready))

/**
 * Chromium needs either a root-owned setuid `chrome-sandbox` or unprivileged user namespaces. A
 * downloaded development Electron has neither where AppArmor restricts namespaces.
 */
function sandboxArguments() {
  if (process.platform !== 'linux') return []
  const helper = join(vscodeRoot, '.build/electron/chrome-sandbox')
  const { uid, mode } = statSync(helper)
  if (uid === 0 && mode & 0o4000) return []
  const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
  if (!existsSync(restriction) || readFileSync(restriction, 'utf8').trim() !== '1') return []
  console.warn(
    `vscursed: Chromium cannot sandbox this Electron, launching with --no-sandbox. To sandbox it: sudo chown root:root ${helper} && sudo chmod 4755 ${helper}`,
  )
  return ['--no-sandbox']
}

try {
  await limited(
    join(vscodeRoot, 'scripts/code.sh'),
    [
      `--user-data-dir=${join(profile, 'user-data')}`,
      `--extensions-dir=${join(profile, 'extensions')}`,
      ...plugins.map(dir => `--extensionDevelopmentPath=${dir}`),
      ...sandboxArguments(),
      ...process.argv.slice(2).filter(arg => arg !== '--'),
    ],
    { cwd: vscodeRoot, memory: electronMemory },
  )
} finally {
  stop()
}
