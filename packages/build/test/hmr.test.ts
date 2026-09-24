import { mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { hmrSocketEnv } from '@vscursed/api'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { reportBuild } from '../src/hmr.ts'

describe('Vite+ build notification', () => {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\vscursed-test-${process.pid}`
      : join(process.cwd(), '.vscursed', `hmr-test-${process.pid}.sock`)
  const previousSocket = process.env[hmrSocketEnv]
  let server: Server | undefined

  afterEach(async () => {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
    if (process.platform !== 'win32') rmSync(socketPath, { force: true })
    if (previousSocket === undefined) delete process.env[hmrSocketEnv]
    else process.env[hmrSocketEnv] = previousSocket
  })

  it('sends the plugin id and realm after a successful build', async () => {
    if (process.platform !== 'win32') {
      mkdirSync(join(process.cwd(), '.vscursed'), { recursive: true })
      rmSync(socketPath, { force: true })
    }
    process.env[hmrSocketEnv] = socketPath
    const received = Promise.withResolvers<string>()
    server = createServer(socket => {
      socket.setEncoding('utf8')
      let payload = ''
      socket.on('data', chunk => (payload += chunk))
      socket.once('end', () => received.resolve(payload))
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(socketPath, resolve)
    })

    await reportBuild('vscursed.sample-realms', 'renderer')
    expect(JSON.parse(await received.promise)).toEqual({ id: 'vscursed.sample-realms', realm: 'renderer' })
  })
})
