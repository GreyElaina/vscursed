import type { PluginManifest, ProviderRegistration, Realm } from '@vscursed/api'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import type { IChannel } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import { IHostService } from 'vscode-internal/vs/workbench/services/host/browser/host.js'
import type { ProviderEvent, ProviderStatus } from '../development.ts'
import { setDevelopmentState } from './extension-feature.ts'

/** What the Target drives in the window's plugin state. */
export interface TargetPlugins {
  /** Makes `manifest` the extension's manifest and reloads every realm it touches. */
  applyManifest(id: string, manifest: PluginManifest): Promise<void>
  reloadRealm(id: string, realm: Realm): Promise<void>
}

/**
 * The Target side of development: this window runs the extension from its provider workspace. Once the
 * provider has built every realm of its manifest, that manifest is applied; later builds reload their realm.
 * The window closes when the provider goes away, which also ends the Debugger's session.
 */
export class DevelopmentTarget extends Disposable {
  private status: ProviderStatus = { connection: 'connecting', built: [] }
  private reloadErrors: Partial<Record<Realm, string>> = {}
  private events = Promise.resolve()
  private closing = false

  constructor(
    private readonly registration: ProviderRegistration,
    extensionHost: IChannel,
    private readonly plugins: TargetPlugins,
    @IHostService private readonly hostService: IHostService,
    @ILogService private readonly logService: ILogService,
  ) {
    super()
    this.publish()
    this._register(
      extensionHost.listen<ProviderEvent>('provider')(event => {
        this.events = this.events
          .then(() => this.handle(event))
          .catch(error => this.logService.error(`[VSCursed] ${registration.extensionId}: ${error}`))
      }),
    )
  }

  private async handle(event: ProviderEvent) {
    const { extensionId } = this.registration
    if (event.type === 'built') {
      await this.reload([event.realm], () => this.plugins.reloadRealm(extensionId, event.realm))
      return
    }
    this.status = event.status
    this.publish()
    const { connection, manifest } = event.status
    if (connection === 'connected' && manifest) {
      await this.reload(Object.keys(manifest) as Realm[], () => this.plugins.applyManifest(extensionId, manifest))
    } else if (connection === 'disconnected' && !this.closing) {
      this.closing = true
      await this.hostService.close()
    }
  }

  private async reload(realms: Realm[], reload: () => Promise<void>) {
    try {
      await reload()
      for (const realm of realms) delete this.reloadErrors[realm]
    } catch (error) {
      for (const realm of realms)
        this.reloadErrors[realm] = `Reload failed: ${error instanceof Error ? error.message : error}`
    }
    this.publish()
  }

  private publish() {
    setDevelopmentState(this.registration.extensionId, {
      role: 'target',
      status: this.status,
      reloadErrors: { ...this.reloadErrors },
    })
  }
}
