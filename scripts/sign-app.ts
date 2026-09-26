import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceRoot } from './lib/upstream.ts'

if (process.platform !== 'darwin') throw new Error('VSCursed.app can only be signed on macOS')
if (process.arch !== 'arm64' && process.arch !== 'x64') {
  throw new Error(`unsupported macOS architecture: ${process.arch}`)
}

const app = join(workspaceRoot, 'upstream/vscodium', `VSCode-darwin-${process.arch}`, 'VSCursed.app')
if (!existsSync(app)) throw new Error(`VSCursed.app does not exist: ${app}`)

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

await run('codesign', ['--force', '--deep', '--sign', '-', app])
await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
console.log(`vscursed: signed ${app}`)
