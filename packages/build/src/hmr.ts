import { connect } from 'node:net'
import { hmrSocketEnv, type PluginBuild, type Realm } from '@vscursed/api'

/** Reports a successful Vite+ plugin build to the development VSCodium process, when connected. */
export async function reportBuild(id: string, realm: Realm) {
  const socketPath = process.env[hmrSocketEnv]
  if (!socketPath) return
  await new Promise<void>((resolve, reject) => {
    const build: PluginBuild = { id, realm }
    const socket = connect(socketPath, () => socket.end(JSON.stringify(build)))
    socket.once('error', reject)
    socket.once('close', hadError => {
      if (!hadError) resolve()
    })
  })
}
