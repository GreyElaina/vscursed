import type { ProviderRegistration, Realm } from '@vscursed/api'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import { IHostService } from 'vscode-internal/vs/workbench/services/host/browser/host.js'
import type { ProviderEvent, ProviderStatus } from '../development.ts'
import { setDevelopmentState } from './extension-feature.ts'
import { IVSCursedService } from './service.ts'

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
    @IVSCursedService private readonly vscursed: IVSCursedService,
    @IHostService private readonly hostService: IHostService,
  ) {
    super()
    this.publish()
    this._register(
      vscursed.channel('extensionHost').listen<ProviderEvent>('provider')(event => {
        this.events = this.events
          .then(() => this.handle(event))
          .catch(error => vscursed.logger.error(`${registration.extensionId}: ${error}`))
      }),
    )
  }

  private async handle(event: ProviderEvent) {
    const { extensionId } = this.registration
    if (event.type === 'built') {
      await this.reload([event.realm], () => this.vscursed.reloadRealm(extensionId, event.realm))
      return
    }
    this.status = event.status
    this.publish()
    const { connection, manifest } = event.status
    if (connection === 'connected' && manifest) {
      await this.reload(Object.keys(manifest) as Realm[], () => this.vscursed.applyManifest(extensionId, manifest))
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
