/**
 * Daily development: builds the realm runtime, keeps rebuilding it on change, and launches the
 * prepared VSCodium with a profile under `.vscursed/`. A rebuilt runtime takes effect after reloading
 * the window (renderer) or restarting (other realms). Plugin workspaces and their build processes are
 * managed separately through VSCodium's Extensions UI.
 *
 *   pnpm dev [-- <VSCodium arguments>]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { hmrSocketEnv } from '@vscursed/api'
import { applyPatches, limited, npm, vscodeRoot, workspaceRoot } from './lib/upstream.ts'

const profile = join(workspaceRoot, '.vscursed')
const hmrSocket = process.platform === 'win32' ? `\\\\.\\pipe\\vscursed-${process.pid}` : join(profile, 'hmr.sock')
mkdirSync(profile, { recursive: true })
/** Memory ceiling of the VSCodium process tree. */
const electronMemory = process.env.VSCURSED_ELECTRON_MEMORY ?? '4G'

if (!existsSync(join(vscodeRoot, 'out/main.js'))) {
  console.error('vscursed: the VSCodium tree is not prepared; run `pnpm upstream prepare` once.')
  process.exit(1)
}
if (await applyPatches(false)) await npm(['run', 'transpile-client'])

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

const watchers = [watch(join(workspaceRoot, 'packages/runtime'), 4)]
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
      ...sandboxArguments(),
      ...process.argv.slice(2).filter(arg => arg !== '--'),
    ],
    { cwd: vscodeRoot, env: { ...process.env, [hmrSocketEnv]: hmrSocket }, memory: electronMemory },
  )
} finally {
  stop()
}
