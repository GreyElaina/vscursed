import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { hmrSocketEnv, isRealm, type PluginBuild } from '@vscursed/api'
import { Emitter } from 'vscode-internal/vs/base/common/event.js'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import type { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import type { BuildNotification } from './channel.ts'

/** Receives successful Vite+ build notifications from plugin workspaces. */
export class BuildNotifications extends Disposable {
  private readonly changes = this._register(new Emitter<BuildNotification>())
  readonly onDidBuild = this.changes.event
  private revision = 0
  private readonly socketPath = process.env[hmrSocketEnv]
  private readonly server = this.socketPath
    ? createServer(socket => {
        socket.setEncoding('utf8')
        let payload = ''
        socket.on('data', chunk => (payload += chunk))
        socket.on('end', () => {
          const build = JSON.parse(payload) as Partial<PluginBuild>
          if (typeof build.id !== 'string' || !build.id || build.id.length > 512 || !isRealm(build.realm)) {
            throw new Error('invalid VSCursed build notification')
          }
          this.changes.fire({ id: build.id, realm: build.realm, revision: ++this.revision })
        })
      })
    : undefined

  constructor(logService: ILogService) {
    super()
    if (!this.server || !this.socketPath) return
    if (process.platform !== 'win32') rmSync(this.socketPath, { force: true })
    this.server.on('error', error => logService.error('VSCursed build notification server failed', error))
    this.server.listen(this.socketPath)
  }

  override dispose() {
    this.server?.close()
    if (this.socketPath && process.platform !== 'win32') rmSync(this.socketPath, { force: true })
    super.dispose()
  }
}
